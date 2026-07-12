'use strict';
// SR1 universal search: index lifecycle + files corpus.
// The db is a derived artifact: every test asserting rebuild behaviour
// deletes or corrupts it and expects identical results after reconcile.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { probeSqlite, createSearchIndex, SCHEMA_VERSION, HIGHLIGHT_OPEN, HIGHLIGHT_CLOSE } = require('../../search.js');

const probe = probeSqlite();
if (!probe.available) {
  // Grep-fallback runtimes cannot exercise the index; the capability gate
  // itself is covered in search-core.test.js.
  test('files corpus (skipped: no node:sqlite on this runtime)', { skip: true }, () => {});
  return;
}

let tmpRoot, workspace, dbPath, idx;

function write(rel, content, mtimeSec) {
  const full = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  if (mtimeSec) fs.utimesSync(full, mtimeSec, mtimeSec);
  return full;
}

function freshIndex() {
  const i = createSearchIndex({ dbPath, DatabaseSync: probe.DatabaseSync });
  i.open();
  return i;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-search-'));
  workspace = path.join(tmpRoot, 'ws');
  fs.mkdirSync(path.join(workspace, '.rundock'), { recursive: true });
  dbPath = path.join(workspace, '.rundock', 'search-index.db');
  idx = null;
});

afterEach(() => {
  try { if (idx) idx.close(); } catch (e) {}
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('index lifecycle', () => {
  test('open creates the db with the current schema version', () => {
    idx = freshIndex();
    assert.ok(fs.existsSync(dbPath));
    assert.strictEqual(idx.getSchemaVersion(), SCHEMA_VERSION);
  });

  test('a corrupt db file is deleted and rebuilt, never thrown on', () => {
    fs.writeFileSync(dbPath, 'this is not a sqlite database at all');
    idx = freshIndex();
    assert.strictEqual(idx.getSchemaVersion(), SCHEMA_VERSION);
    write('a.md', 'findable content here');
    idx.reconcileFiles(workspace);
    assert.strictEqual(idx.searchFiles('findable').length, 1);
  });

  test('a schema version mismatch rebuilds from scratch (no migrations, ever)', () => {
    idx = freshIndex();
    write('a.md', 'hello world');
    idx.reconcileFiles(workspace);
    idx.close();
    // Simulate an old index: rewrite the stored version.
    const db = new probe.DatabaseSync(dbPath);
    db.prepare("UPDATE meta SET value = '0' WHERE key = 'schema_version'").run();
    db.close();
    idx = freshIndex();
    assert.strictEqual(idx.getSchemaVersion(), SCHEMA_VERSION);
    // Rebuilt empty; reconcile restores content.
    assert.strictEqual(idx.searchFiles('hello').length, 0);
    idx.reconcileFiles(workspace);
    assert.strictEqual(idx.searchFiles('hello').length, 1);
  });
});

describe('files corpus', () => {
  test('indexes markdown content with ranked, snippeted, highlighted results', () => {
    idx = freshIndex();
    write('notes/pricing.md', '# Pricing\n\nWe discussed the enterprise pricing ladder at length.');
    write('notes/other.md', 'Nothing relevant in this file.');
    idx.reconcileFiles(workspace);
    const hits = idx.searchFiles('pricing');
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].path, 'notes/pricing.md');
    assert.ok(hits[0].snippet.includes(HIGHLIGHT_OPEN), 'snippet carries open highlight marker');
    assert.ok(hits[0].snippet.includes(HIGHLIGHT_CLOSE), 'snippet carries close highlight marker');
    assert.ok(typeof hits[0].score === 'number');
    assert.ok(hits[0].mtimeMs > 0);
  });

  test('filename/title matches rank above content-only matches', () => {
    idx = freshIndex();
    write('roadmap.md', 'A file about future plans.');
    write('misc.md', 'This mentions the roadmap in passing, roadmap roadmap.');
    idx.reconcileFiles(workspace);
    const hits = idx.searchFiles('roadmap');
    assert.strictEqual(hits.length, 2);
    assert.strictEqual(hits[0].path, 'roadmap.md', 'title match must outrank content match');
  });

  test('frontmatter tags are parsed, searchable, and filterable', () => {
    idx = freshIndex();
    write('tagged.md', '---\ntitle: Tagged\ntags: [strategy, pricing]\n---\nBody text here.\n');
    write('yaml-list.md', '---\ntags:\n  - strategy\n  - hiring\n---\nOther body.\n');
    write('untagged.md', 'strategy appears in the body only.\n');
    idx.reconcileFiles(workspace);
    // Tag term matches via FTS
    const byQuery = idx.searchFiles('strategy');
    assert.strictEqual(byQuery.length, 3);
    // Tag filter narrows to files actually carrying the tag
    const byTag = idx.searchFiles('strategy', { tags: ['strategy'] });
    assert.deepStrictEqual(byTag.map(h => h.path).sort(), ['tagged.md', 'yaml-list.md']);
    const pricingTag = idx.searchFiles('body', { tags: ['pricing'] });
    assert.deepStrictEqual(pricingTag.map(h => h.path), ['tagged.md']);
    assert.deepStrictEqual(byTag.find(h => h.path === 'tagged.md').tags.sort(), ['pricing', 'strategy']);
  });

  test('a changed file is reindexed; a deleted file disappears', () => {
    idx = freshIndex();
    const full = write('a.md', 'original zebra content', 1_700_000_000);
    idx.reconcileFiles(workspace);
    assert.strictEqual(idx.searchFiles('zebra').length, 1);
    fs.writeFileSync(full, 'replaced with giraffe content');
    fs.utimesSync(full, 1_700_000_100, 1_700_000_100);
    idx.reconcileFiles(workspace);
    assert.strictEqual(idx.searchFiles('zebra').length, 0, 'stale content must be gone');
    assert.strictEqual(idx.searchFiles('giraffe').length, 1);
    fs.rmSync(full);
    idx.reconcileFiles(workspace);
    assert.strictEqual(idx.searchFiles('giraffe').length, 0);
  });

  test('an unchanged file is not re-read on reconcile', () => {
    idx = freshIndex();
    write('a.md', 'stable content', 1_700_000_000);
    idx.reconcileFiles(workspace);
    const first = idx.stats().filesIndexed;
    const n = idx.reconcileFiles(workspace);
    assert.strictEqual(n.updated, 0);
    assert.strictEqual(idx.stats().filesIndexed, first);
  });

  test('skips dotdirs, node_modules, .rundock, and non-text formats', () => {
    idx = freshIndex();
    write('.hidden/secret.md', 'sneaky content');
    write('node_modules/pkg/readme.md', 'package content');
    write('.rundock/notes.md', 'internal content');
    write('data.json', '{"key": "jsonvalue content"}');
    write('visible.txt', 'plain text content is indexed');
    idx.reconcileFiles(workspace);
    assert.strictEqual(idx.searchFiles('sneaky').length, 0);
    assert.strictEqual(idx.searchFiles('package').length, 0);
    assert.strictEqual(idx.searchFiles('internal').length, 0);
    assert.strictEqual(idx.searchFiles('jsonvalue').length, 0);
    assert.strictEqual(idx.searchFiles('indexed').length, 1);
  });

  test('updated-at range filters apply where the metadata exists', () => {
    idx = freshIndex();
    write('old.md', 'shared token alpha', 1_600_000_000);
    write('new.md', 'shared token alpha', 1_700_000_000);
    idx.reconcileFiles(workspace);
    const all = idx.searchFiles('alpha');
    assert.strictEqual(all.length, 2);
    const recent = idx.searchFiles('alpha', { updatedFrom: 1_650_000_000_000 });
    assert.deepStrictEqual(recent.map(h => h.path), ['new.md']);
    const older = idx.searchFiles('alpha', { updatedTo: 1_650_000_000_000 });
    assert.deepStrictEqual(older.map(h => h.path), ['old.md']);
  });

  test('noteFileSaved indexes a single file immediately without a full walk', () => {
    idx = freshIndex();
    write('direct.md', 'quokka content');
    idx.noteFileSaved(workspace, 'direct.md');
    assert.strictEqual(idx.searchFiles('quokka').length, 1);
  });

  test('rebuild equivalence: delete the db, reconcile, identical result set', () => {
    idx = freshIndex();
    write('one.md', 'searchable emu content');
    write('two.md', '---\ntags: [birds]\n---\nmore emu discussion');
    idx.reconcileFiles(workspace);
    const before = idx.searchFiles('emu').map(h => ({ path: h.path, snippet: h.snippet, tags: h.tags }));
    idx.close();
    fs.rmSync(dbPath);
    idx = freshIndex();
    idx.reconcileFiles(workspace);
    const after = idx.searchFiles('emu').map(h => ({ path: h.path, snippet: h.snippet, tags: h.tags }));
    assert.deepStrictEqual(after, before);
  });

  test('nasty queries never throw', () => {
    idx = freshIndex();
    write('a.md', 'plain content');
    idx.reconcileFiles(workspace);
    const nasty = ['"unbalanced', 'a* OR b', '(paren', 'col:val', '-', '""', ' weird', '日本語*()'];
    for (const q of nasty) {
      assert.doesNotThrow(() => idx.searchFiles(q), `query ${JSON.stringify(q)} threw`);
    }
  });

  test('frontmatter is not indexed as content (snippets stay clean)', () => {
    idx = freshIndex();
    write('fm.md', '---\nauthor: quibblefish\ntags: [pricing]\n---\nThe body discusses margins.\n');
    idx.reconcileFiles(workspace);
    // Frontmatter-only words are not content matches...
    assert.strictEqual(idx.searchFiles('quibblefish').length, 0);
    // ...but tags still match (via the tags column) and body content matches
    assert.strictEqual(idx.searchFiles('pricing').length, 1);
    const hit = idx.searchFiles('margins')[0];
    assert.ok(!hit.snippet.includes('author:'), 'snippet must not leak frontmatter');
  });

  test('recentFiles lists most recently modified first', () => {
    idx = freshIndex();
    write('old.md', 'older note', 1_600_000_000);
    write('new.md', 'newer note', 1_700_000_000);
    idx.reconcileFiles(workspace);
    const recent = idx.recentFiles(5);
    assert.deepStrictEqual(recent.map(r => r.path), ['new.md', 'old.md']);
    assert.strictEqual(recent[0].matchType, 'recent');
  });

  test('unicode content is searchable', () => {
    idx = freshIndex();
    write('intl.md', 'Discussion about café strategy and 日本語 notes.');
    idx.reconcileFiles(workspace);
    assert.strictEqual(idx.searchFiles('café').length, 1);
    assert.strictEqual(idx.searchFiles('日本語').length, 1);
  });
});
