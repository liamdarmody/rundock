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

module.exports = {
  SCHEMA_VERSION,
  probeSqlite,
  sanitizeFtsQuery,
  fuzzyScore,
};
