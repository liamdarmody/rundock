'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Universal search engine (SR1).
//
// Lexical search over four corpora: workspace files (markdown content),
// conversations (Claude Code session transcripts), agents, and skills.
// Files and conversations are indexed in SQLite FTS5; agents and skills are
// tiny corpora filtered in memory at query time by the server (no index, no
// sync problem).
//
// Engine decision (SR1, 2026-07-12): the index runs on `node:sqlite`
// (DatabaseSync), NOT better-sqlite3 as the July spec drafted. Verified
// empirically: node:sqlite ships FTS5 (including the trigram tokenizer)
// unflagged on Node 22.16+ and on Electron 35's bundled Node, where server.js
// runs in-process (electron/main.js requires server.js directly, so a native
// module would have needed Electron's ABI). node:sqlite is compiled into Node
// itself with platform-uniform build flags, so Windows carries zero
// native-binary risk — this removes the spec's #1 risk (native prebuilds)
// wholesale, with the same synchronous API surface. Runtimes without
// node:sqlite (Node 20/21/early 22) degrade to the legacy grep path behind
// the capability probe below; search never hard-fails on a platform.
//
// The index is a DERIVED ARTIFACT at <workspace>/.rundock/search-index.db:
// deleting it loses nothing; it rebuilds from the source files. There are no
// schema migrations, ever — a schema version bump or a corrupt file deletes
// the db and rebuilds (spec "Never" boundary). No embeddings, no vectors, no
// user-facing configuration.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

// Bumping this rebuilds every index on next open. That is the whole migration
// story: rebuild, never migrate.
const SCHEMA_VERSION = 1;

const MAX_QUERY_LENGTH = 256;
const MAX_QUERY_TOKENS = 12;

// ── Capability probe ─────────────────────────────────────────────────────────

/**
 * Probe for a usable synchronous SQLite with FTS5.
 * Never throws. `disabled` forces unavailability (used by tests and the
 * RUNDOCK_SEARCH_DISABLE_SQLITE escape hatch so the grep fallback stays
 * exercised and reachable).
 */
function probeSqlite({ disabled } = {}) {
  if (disabled || process.env.RUNDOCK_SEARCH_DISABLE_SQLITE === '1') {
    return { available: false, reason: 'disabled' };
  }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (e) {
    return { available: false, reason: 'node:sqlite unavailable on this runtime (' + process.version + ')' };
  }
  if (!DatabaseSync) return { available: false, reason: 'node:sqlite present but DatabaseSync missing' };
  // FTS5 is a compile-time SQLite option; assert it really works rather than
  // assuming (spec risk 3).
  try {
    const db = new DatabaseSync(':memory:');
    db.exec("CREATE VIRTUAL TABLE __fts_probe USING fts5(x)");
    db.close();
  } catch (e) {
    return { available: false, reason: 'FTS5 unavailable: ' + (e && e.message ? e.message : String(e)) };
  }
  return { available: true, DatabaseSync };
}

// ── Query sanitizer ──────────────────────────────────────────────────────────

/**
 * Sanitize a raw user query into a safe FTS5 MATCH expression.
 * Strategy (Hermes approach, reimplemented): never pass user syntax through.
 * Split into bare tokens, drop everything FTS5 could interpret (operators,
 * quotes, parens, column filters, stars, carets), and emit each token as a
 * double-quoted string. Implicit AND between quoted terms. `prefix: true`
 * stars the final token for search-as-you-type.
 * Returns null when nothing searchable remains.
 */
function sanitizeFtsQuery(raw, { prefix = false } = {}) {
  if (typeof raw !== 'string') return null;
  let q = raw.slice(0, MAX_QUERY_LENGTH);
  // Split on anything that is not a letter, number, or mark. This strips all
  // FTS5 syntax characters in one move and handles unicode via the u flag.
  const tokens = q.split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean).slice(0, MAX_QUERY_TOKENS);
  if (tokens.length === 0) return null;
  const quoted = tokens.map(t => `"${t}"`);
  if (prefix) quoted[quoted.length - 1] += '*';
  return quoted.join(' ');
}

// ── Fuzzy title matcher ──────────────────────────────────────────────────────

/**
 * Fzf-style subsequence scorer for the title/name layer (file names,
 * conversation titles, agent/skill names — all small in-memory corpora).
 * Content-level search stays lexical in FTS5; fuzziness applies to titles
 * only (scope addendum 2026-07-12).
 *
 * Returns a numeric score (higher = better) or null when `needle` is not an
 * in-order subsequence of `haystack`. Scoring favours: consecutive runs,
 * word-boundary starts, early matches, and shorter haystacks.
 */
function fuzzyScore(needle, haystack) {
  if (!needle || !haystack) return null;
  const n = String(needle).toLowerCase();
  const h = String(haystack).toLowerCase();
  if (n.length > h.length) return null;

  // Exact substring: strong score, earlier + tighter is better.
  // Acronym pass: needle matching the word initials ("cs" → "Conversation
  // Search") outranks any mid-word substring hit. Checked before the
  // substring branch so multi-word-initial intent wins.
  const initials = h.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(w => w[0]).join('');
  if (n.length >= 2 && initials.includes(n)) {
    return 140 + n.length * 4 - Math.min(initials.indexOf(n), 10);
  }

  const sub = h.indexOf(n);
  if (sub !== -1) {
    let score = 100 + n.length * 4;
    if (sub === 0 || /[^\p{L}\p{N}]/u.test(h[sub - 1])) score += 30; // boundary start
    score -= Math.min(sub, 20); // earlier is better
    score -= Math.min(h.length - n.length, 20) * 0.5; // tighter is better
    return score;
  }

  // Subsequence walk with consecutive-run and boundary bonuses.
  let score = 0, hi = 0, prevMatch = -2, matched = 0;
  for (let ni = 0; ni < n.length; ni++) {
    const ch = n[ni];
    let found = -1;
    while (hi < h.length) {
      if (h[hi] === ch) { found = hi; hi++; break; }
      hi++;
    }
    if (found === -1) return null;
    matched++;
    let charScore = 1;
    if (found === prevMatch + 1) charScore += 4; // consecutive
    if (found === 0 || /[^\p{L}\p{N}]/u.test(h[found - 1])) charScore += 6; // word boundary
    charScore -= Math.min(found, 30) * 0.05; // early bias
    score += charScore;
    prevMatch = found;
  }
  if (matched !== n.length) return null;
  score -= Math.min(h.length - n.length, 40) * 0.2; // shorter haystack bias
  return score;
}

// ── Highlight markers ────────────────────────────────────────────────────────
// snippet() output uses control characters as highlight delimiters so the
// client can HTML-escape the snippet FIRST and then swap markers for <mark>
// tags. Real markup here would either get escaped away or force the client
// to trust server strings as HTML.
const HIGHLIGHT_OPEN = '\u0001';
const HIGHLIGHT_CLOSE = '\u0002';

// ── Frontmatter tags ─────────────────────────────────────────────────────────

/**
 * Extract tags from YAML frontmatter. Handles the three shapes Obsidian-style
 * vaults actually use: `tags: [a, b]`, `tags: a, b`, and a `- item` list.
 * Deliberately not a YAML parser: tags are the only key we read.
 */
function parseFrontmatterTags(content) {
  if (typeof content !== 'string' || !content.startsWith('---')) return [];
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!fmMatch) return [];
  const fm = fmMatch[1];
  const lines = fm.split(/\r?\n/);
  const tags = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^tags\s*:\s*(.*)$/i);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline) {
      // Inline: `[a, b]` or `a, b` or a single tag
      const cleaned = inline.replace(/^\[|\]$/g, '');
      for (const t of cleaned.split(',')) {
        const tag = t.trim().replace(/^["']|["']$/g, '').replace(/^#/, '');
        if (tag) tags.push(tag.toLowerCase());
      }
    } else {
      // Block list: subsequent `- item` lines
      for (let j = i + 1; j < lines.length; j++) {
        const item = lines[j].match(/^\s*-\s+(.+)$/);
        if (!item) break;
        const tag = item[1].trim().replace(/^["']|["']$/g, '').replace(/^#/, '');
        if (tag) tags.push(tag.toLowerCase());
      }
    }
    break;
  }
  return [...new Set(tags)];
}

// ── File walking ─────────────────────────────────────────────────────────────

// Content-indexed extensions. json stays out: raw JSON is noise in a content
// index (its filenames still surface via the in-memory title layer upstream).
const INDEXED_EXTENSIONS = new Set(['.md', '.txt']);
const MAX_FILE_BYTES = 2 * 1024 * 1024; // ignore pathological files

function walkTextFiles(rootDir, prefix = '', out = []) {
  let items;
  try {
    items = fs.readdirSync(path.join(rootDir, prefix), { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const item of items) {
    // Mirrors getFileTree's visibility rules (dotfiles, node_modules) plus
    // .rundock, which never appears in the tree but lives at the root.
    if (item.name.startsWith('.') || item.name === 'node_modules') continue;
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) {
      walkTextFiles(rootDir, rel, out);
    } else if (INDEXED_EXTENSIONS.has(path.extname(item.name).toLowerCase())) {
      out.push(rel);
    }
  }
  return out;
}

// ── Search index ─────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL,
  mtime_ms REAL NOT NULL,
  size INTEGER NOT NULL,
  created_ms REAL
);
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  title, content, tags,
  content=files, content_rowid=id
);
CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
  INSERT INTO files_fts(rowid, title, content, tags)
  VALUES (new.id, new.title, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, title, content, tags)
  VALUES ('delete', old.id, old.title, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, title, content, tags)
  VALUES ('delete', old.id, old.title, old.content, old.tags);
  INSERT INTO files_fts(rowid, title, content, tags)
  VALUES (new.id, new.title, new.content, new.tags);
END;

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent_id TEXT,
  role TEXT NOT NULL,
  ts_ms REAL,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_convo ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, seq);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text,
  content=messages, content_rowid=id
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TABLE IF NOT EXISTS session_marks (
  session_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  seq_next INTEGER NOT NULL DEFAULT 0,
  mtime_ms REAL NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0
);
`;

// ── Claude Code jsonl extraction ─────────────────────────────────────────────

/**
 * Extract indexable messages from one parsed Claude Code jsonl line.
 * Mirrors parseSessionHistory's display semantics: user messages with string
 * content, and assistant text blocks (trim-filtered). Tool calls and tool
 * results are excluded in v1 — they are the main source of grep noise the
 * spec calls out.
 * Returns {role, text, tsMs} or null.
 */
function extractIndexableMessage(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const tsMs = obj.timestamp ? Date.parse(obj.timestamp) || null : null;
  if (obj.type === 'user' && obj.message && typeof obj.message.content === 'string') {
    const text = obj.message.content.trim();
    if (!text) return null;
    return { role: 'user', text, tsMs };
  }
  if (obj.message && obj.message.role === 'assistant' && Array.isArray(obj.message.content)) {
    const parts = obj.message.content
      .filter(b => b && b.type === 'text' && b.text && b.text.trim())
      .map(b => b.text);
    if (!parts.length) return null;
    return { role: 'agent', text: parts.join('\n\n'), tsMs };
  }
  return null;
}

class SearchIndex {
  constructor({ dbPath, DatabaseSync }) {
    if (!dbPath) throw new Error('dbPath required');
    if (!DatabaseSync) throw new Error('DatabaseSync required (pass probeSqlite().DatabaseSync)');
    this.dbPath = dbPath;
    this.DatabaseSync = DatabaseSync;
    this.db = null;
  }

  /**
   * Open (or create) the index. Corruption and schema-version mismatch both
   * take the same path: delete the file and start clean. The index is
   * derived; rebuild IS the migration story.
   */
  open() {
    try {
      this._openAt(this.dbPath);
      const stored = this.getSchemaVersion();
      if (stored !== SCHEMA_VERSION) {
        this.close();
        this._deleteDbFiles();
        this._openAt(this.dbPath);
        console.log(`[Search] index schema ${stored} != ${SCHEMA_VERSION}; rebuilt clean`);
      }
    } catch (e) {
      // Corrupt or unreadable: recreate from nothing.
      try { this.close(); } catch (e2) {}
      this._deleteDbFiles();
      this._openAt(this.dbPath);
      console.log(`[Search] index was unreadable (${e && e.message}); rebuilt clean`);
    }
    return this;
  }

  _openAt(p) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    this.db = new this.DatabaseSync(p);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA_SQL);
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (!row) {
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    }
    // A trivial FTS query doubles as a health check; throws on corruption.
    this.db.prepare("SELECT count(*) FROM files_fts WHERE files_fts MATCH '\"__probe__\"'").get();
  }

  _deleteDbFiles() {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(this.dbPath + suffix, { force: true }); } catch (e) {}
    }
  }

  close() {
    if (this.db) { try { this.db.close(); } catch (e) {} this.db = null; }
  }

  getSchemaVersion() {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    return row ? parseInt(row.value, 10) : null;
  }

  stats() {
    return {
      filesIndexed: this.db.prepare('SELECT count(*) AS n FROM files').get().n,
    };
  }

  // ── Files corpus ───────────────────────────────────────────────────────────

  /**
   * Bring the files table in line with the workspace: upsert files whose
   * mtime/size moved, remove rows whose file is gone. The files table itself
   * is the high-water store. Returns {updated, removed, scanned}.
   */
  reconcileFiles(rootDir) {
    const onDisk = walkTextFiles(rootDir);
    const known = new Map(
      this.db.prepare('SELECT path, mtime_ms, size FROM files').all().map(r => [r.path, r])
    );
    let updated = 0, removed = 0;
    for (const rel of onDisk) {
      let st;
      try { st = fs.statSync(path.join(rootDir, rel)); } catch (e) { continue; }
      const prev = known.get(rel);
      known.delete(rel);
      if (prev && prev.mtime_ms === st.mtimeMs && prev.size === st.size) continue;
      if (st.size > MAX_FILE_BYTES) {
        // A file that grew past the cap must not keep its stale row
        // searchable forever; drop it (no-op when it was never indexed).
        if (prev) { this.db.prepare('DELETE FROM files WHERE path = ?').run(rel); removed++; }
        continue;
      }
      this._indexFile(rootDir, rel, st);
      updated++;
    }
    // Anything left in `known` no longer exists on disk.
    const del = this.db.prepare('DELETE FROM files WHERE path = ?');
    for (const rel of known.keys()) { del.run(rel); removed++; }
    return { updated, removed, scanned: onDisk.length };
  }

  /** Index one file immediately (save_file hot path); no directory walk. */
  noteFileSaved(rootDir, relPath) {
    const ext = path.extname(relPath).toLowerCase();
    if (!INDEXED_EXTENSIONS.has(ext)) return false;
    let st;
    try { st = fs.statSync(path.join(rootDir, relPath)); } catch (e) { return false; }
    if (st.size > MAX_FILE_BYTES) return false;
    this._indexFile(rootDir, relPath, st);
    return true;
  }

  removeFile(relPath) {
    this.db.prepare('DELETE FROM files WHERE path = ?').run(relPath);
  }

  /** Most recently modified files (the palette's empty-query state). */
  recentFiles(limit = 8) {
    return this.db.prepare(`
      SELECT path, title, tags, mtime_ms, created_ms FROM files
      ORDER BY mtime_ms DESC LIMIT ?
    `).all(Math.min(limit, 50)).map(r => ({
      type: 'file', path: r.path, title: r.title, tags: JSON.parse(r.tags),
      mtimeMs: r.mtime_ms, createdMs: r.created_ms, matchType: 'recent',
    }));
  }

  _indexFile(rootDir, rel, st) {
    let content;
    try { content = fs.readFileSync(path.join(rootDir, rel), 'utf-8'); } catch (e) { return; }
    const title = path.basename(rel, path.extname(rel));
    const tags = parseFrontmatterTags(content);
    // Strip the frontmatter block from indexed content: tags live in their
    // own column, and raw YAML in snippets reads as noise in results.
    if (content.startsWith('---')) {
      content = content.replace(/^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/, '');
    }
    // birthtime is unreliable (0 or =ctime) on some filesystems; store null
    // rather than a wrong date so created-at filters only apply where real.
    const created = st.birthtimeMs && st.birthtimeMs > 0 ? st.birthtimeMs : null;
    this.db.prepare(`
      INSERT INTO files (path, title, tags, content, mtime_ms, size, created_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        title = excluded.title, tags = excluded.tags, content = excluded.content,
        mtime_ms = excluded.mtime_ms, size = excluded.size, created_ms = excluded.created_ms
    `).run(rel, title, JSON.stringify(tags), content, st.mtimeMs, st.size, created);
  }

  /**
   * Search file content. Title hits outrank content hits via bm25 column
   * weights; tags participate in matching at a middle weight. Filters apply
   * only where the metadata genuinely exists (created_ms may be null).
   */
  searchFiles(rawQuery, opts = {}) {
    const match = sanitizeFtsQuery(rawQuery, { prefix: opts.prefix });
    if (!match) return [];
    const limit = Math.min(opts.limit || 20, 100);
    const where = ['files_fts MATCH ?'];
    const params = [match];
    if (opts.updatedFrom) { where.push('f.mtime_ms >= ?'); params.push(opts.updatedFrom); }
    if (opts.updatedTo) { where.push('f.mtime_ms <= ?'); params.push(opts.updatedTo); }
    if (opts.createdFrom) { where.push('f.created_ms IS NOT NULL AND f.created_ms >= ?'); params.push(opts.createdFrom); }
    if (opts.createdTo) { where.push('f.created_ms IS NOT NULL AND f.created_ms <= ?'); params.push(opts.createdTo); }
    if (Array.isArray(opts.tags) && opts.tags.length) {
      for (const tag of opts.tags.slice(0, 8)) {
        where.push('EXISTS (SELECT 1 FROM json_each(f.tags) WHERE json_each.value = ?)');
        params.push(String(tag).toLowerCase());
      }
    }
    params.push(limit);
    const rows = this.db.prepare(`
      SELECT f.path, f.title, f.tags, f.mtime_ms, f.created_ms,
             bm25(files_fts, 10.0, 1.0, 4.0) AS rank,
             snippet(files_fts, 1, '${HIGHLIGHT_OPEN}', '${HIGHLIGHT_CLOSE}', '…', 12) AS snip
      FROM files_fts
      JOIN files f ON f.id = files_fts.rowid
      WHERE ${where.join(' AND ')}
      ORDER BY rank
      LIMIT ?
    `).all(...params);
    return rows.map(r => ({
      type: 'file',
      path: r.path,
      title: r.title,
      tags: JSON.parse(r.tags),
      snippet: r.snip,
      score: -r.rank, // bm25 is lower-is-better; expose higher-is-better
      mtimeMs: r.mtime_ms,
      createdMs: r.created_ms,
    }));
  }
}

// ── Conversations corpus (methods) ───────────────────────────────────────────

Object.assign(SearchIndex.prototype, {
  /**
   * Bring the message index in line with the given conversations' session
   * jsonl files. `convos` is [{conversationId, sessions: [{sessionId,
   * agentId, filePath}]}] — the server resolves paths (they live in
   * ~/.claude/projects, outside the workspace).
   *
   * High-water mark is a byte offset per session file. The jsonl is
   * append-only, so an unchanged (mtime, size) pair skips the file without
   * opening it; growth reads only the delta; shrinkage or replacement
   * (offset > size, or size < mark size) wipes that session's rows and
   * re-reads from zero. Only newline-terminated lines are consumed, so a
   * mid-write partial line is picked up by a later reconcile, never
   * half-indexed.
   */
  reconcileConversations(convos) {
    let indexed = 0, sessionsRead = 0;
    const getMark = this.db.prepare('SELECT byte_offset, seq_next, mtime_ms, size FROM session_marks WHERE session_id = ?');
    for (const c of convos || []) {
      if (!c || !c.conversationId || !Array.isArray(c.sessions)) continue;
      for (const s of c.sessions) {
        if (!s || !s.sessionId || !s.filePath) continue;
        let st;
        try { st = fs.statSync(s.filePath); } catch (e) { continue; }
        const mark = getMark.get(s.sessionId) || { byte_offset: 0, seq_next: 0, mtime_ms: 0, size: 0 };
        if (st.mtimeMs === mark.mtime_ms && st.size === mark.size) continue;
        let offset = mark.byte_offset;
        let seq = mark.seq_next;
        if (st.size < mark.byte_offset || st.size < mark.size) {
          // Shrunk or replaced: this is no longer the file we indexed.
          this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(s.sessionId);
          offset = 0;
          seq = 0;
        }
        const read = this._readSessionDelta(s.filePath, offset, st.size);
        sessionsRead++;
        // One transaction per session delta: the message inserts and the mark
        // upsert land together or not at all. Without this, a crash between
        // them leaves the mark behind the rows, and the next reconcile
        // re-reads from the old offset and duplicates every message — with
        // nothing ever cleaning it up (the schema version hasn't changed, so
        // no rebuild fires). A failed session rolls back and is skipped; the
        // next reconcile retries it from the same mark.
        let sessionIndexed = 0;
        this.db.exec('BEGIN');
        try {
          const insert = this.db.prepare(`
            INSERT INTO messages (conversation_id, session_id, agent_id, role, ts_ms, seq, text)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `);
          for (const line of read.lines) {
            let obj;
            try { obj = JSON.parse(line); } catch (e) { continue; }
            const m = extractIndexableMessage(obj);
            if (!m) continue;
            insert.run(c.conversationId, s.sessionId, s.agentId || null, m.role, m.tsMs, seq, m.text);
            seq++;
            sessionIndexed++;
          }
          this.db.prepare(`
            INSERT INTO session_marks (session_id, conversation_id, byte_offset, seq_next, mtime_ms, size)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              conversation_id = excluded.conversation_id, byte_offset = excluded.byte_offset,
              seq_next = excluded.seq_next, mtime_ms = excluded.mtime_ms, size = excluded.size
          `).run(s.sessionId, c.conversationId, read.nextOffset, seq, st.mtimeMs, st.size);
          this.db.exec('COMMIT');
          indexed += sessionIndexed;
        } catch (e) {
          try { this.db.exec('ROLLBACK'); } catch (e2) {}
          console.warn(`[Search] session ${s.sessionId} index failed (rolled back, will retry): ${e && e.message ? e.message : e}`);
        }
      }
    }
    return { indexed, sessionsRead };
  },

  /**
   * Read complete (newline-terminated) lines from byte `offset` to `end`.
   * Splits on raw 0x0A bytes BEFORE utf-8 decoding so a multibyte character
   * straddling the read boundary can never be corrupted.
   */
  _readSessionDelta(filePath, offset, end) {
    const want = end - offset;
    if (want <= 0) return { lines: [], nextOffset: offset };
    let fd;
    try { fd = fs.openSync(filePath, 'r'); } catch (e) { return { lines: [], nextOffset: offset }; }
    let buf;
    try {
      buf = Buffer.alloc(want);
      const got = fs.readSync(fd, buf, 0, want, offset);
      buf = buf.subarray(0, got);
    } finally {
      fs.closeSync(fd);
    }
    const lastNewline = buf.lastIndexOf(0x0A);
    if (lastNewline === -1) return { lines: [], nextOffset: offset };
    const complete = buf.subarray(0, lastNewline + 1);
    const lines = complete.toString('utf-8').split('\n').filter(Boolean);
    return { lines, nextOffset: offset + lastNewline + 1 };
  },

  removeConversation(convoId) {
    this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(convoId);
    this.db.prepare('DELETE FROM session_marks WHERE conversation_id = ?').run(convoId);
  },

  /**
   * Sweep rows whose conversation is no longer known (deleted while the
   * engine was unavailable, conversations.json edited externally, capped
   * out of the 100-entry list). Cheap; run on the full-reconcile path.
   */
  removeOrphanedConversations(validIds) {
    const ids = (validIds || []).slice(0, 500);
    const placeholders = ids.map(() => '?').join(',') || "''";
    this.db.prepare(`DELETE FROM messages WHERE conversation_id NOT IN (${placeholders})`).run(...ids);
    this.db.prepare(`DELETE FROM session_marks WHERE conversation_id NOT IN (${placeholders})`).run(...ids);
  },

  /**
   * Search message content. Each hit is a message with its conversation
   * context, a highlighted snippet, and one neighbouring message (the
   * previous message in the same session, or the next when the hit opens
   * the session) so results are recognizable. `collapse: true` (default)
   * keeps only the best-ranked hit per conversation with a matchCount —
   * the palette lists conversations, not raw messages.
   */
  searchMessages(rawQuery, opts = {}) {
    const match = sanitizeFtsQuery(rawQuery, { prefix: opts.prefix });
    if (!match) return [];
    const collapse = opts.collapse !== false;
    const limit = Math.min(opts.limit || 20, 100);
    // Over-fetch when collapsing so multiple hits in one conversation do not
    // starve the distinct-conversation list.
    const fetchLimit = collapse ? limit * 5 : limit;
    const where = ['messages_fts MATCH ?'];
    const params = [match];
    if (opts.agentId) { where.push('m.agent_id = ?'); params.push(opts.agentId); }
    if (opts.fromMs) { where.push('m.ts_ms IS NOT NULL AND m.ts_ms >= ?'); params.push(opts.fromMs); }
    if (opts.toMs) { where.push('m.ts_ms IS NOT NULL AND m.ts_ms <= ?'); params.push(opts.toMs); }
    params.push(fetchLimit);
    const rows = this.db.prepare(`
      SELECT m.id, m.conversation_id, m.session_id, m.agent_id, m.role, m.ts_ms, m.seq,
             bm25(messages_fts) AS rank,
             snippet(messages_fts, 0, '${HIGHLIGHT_OPEN}', '${HIGHLIGHT_CLOSE}', '…', 12) AS snip
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
      WHERE ${where.join(' AND ')}
      ORDER BY rank
      LIMIT ?
    `).all(...params);

    const neighbourStmt = this.db.prepare(`
      SELECT role, agent_id, text, ts_ms FROM messages
      WHERE session_id = ? AND seq = ?
    `);
    const toHit = (r) => {
      const prev = r.seq > 0 ? neighbourStmt.get(r.session_id, r.seq - 1) : undefined;
      const nb = prev || neighbourStmt.get(r.session_id, r.seq + 1);
      return {
        type: 'conversation',
        conversationId: r.conversation_id,
        sessionId: r.session_id,
        agentId: r.agent_id,
        role: r.role,
        seq: r.seq,
        tsMs: r.ts_ms,
        snippet: r.snip,
        score: -r.rank,
        neighbour: nb ? { role: nb.role, agentId: nb.agent_id, tsMs: nb.ts_ms, text: String(nb.text).slice(0, 300) } : null,
      };
    };

    if (!collapse) return rows.map(toHit);

    const byConvo = new Map();
    for (const r of rows) {
      const existing = byConvo.get(r.conversation_id);
      if (existing) { existing.matchCount++; continue; }
      const hit = toHit(r);
      hit.matchCount = 1;
      byConvo.set(r.conversation_id, hit);
    }
    return [...byConvo.values()].slice(0, limit);
  },
});

function createSearchIndex(opts) {
  return new SearchIndex(opts);
}

module.exports = {
  SCHEMA_VERSION,
  HIGHLIGHT_OPEN,
  HIGHLIGHT_CLOSE,
  probeSqlite,
  sanitizeFtsQuery,
  fuzzyScore,
  parseFrontmatterTags,
  walkTextFiles,
  createSearchIndex,
};
