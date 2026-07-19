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

  test('a file that grows past the size cap drops out of the index', () => {
    // Previously the oversized branch skipped the row but
    // left the stale content searchable forever.
    idx = freshIndex();
    const full = write('grows.md', 'small quoll content', 1_700_000_000);
    idx.reconcileFiles(workspace);
    assert.strictEqual(idx.searchFiles('quoll').length, 1);
    fs.writeFileSync(full, 'quoll '.padEnd(2 * 1024 * 1024 + 10, 'x'));
    fs.utimesSync(full, 1_700_000_100, 1_700_000_100);
    idx.reconcileFiles(workspace);
    assert.strictEqual(idx.searchFiles('quoll').length, 0, 'stale row for oversized file must be removed');
  });

  test('frontmatter VALUES are indexed; keys and raw YAML are not (snippets stay clean)', () => {
    // Frontmatter values are searchable now that properties are first-class
    // editable. Values match; key names and raw `key:` syntax do not; snippets
    // never leak the YAML block.
    idx = freshIndex();
    write('fm.md', '---\nauthor: quibblefish\nstatus: draft\ntags: [pricing]\n---\nThe body discusses margins.\n');
    idx.reconcileFiles(workspace);
    // A value match surfaces the file...
    assert.strictEqual(idx.searchFiles('quibblefish').length, 1, 'frontmatter value is searchable');
    assert.strictEqual(idx.searchFiles('draft').length, 1, 'scalar value is searchable');
    // ...but a bare key name is not content (author/status appear only as keys)
    assert.strictEqual(idx.searchFiles('author').length, 0, 'key name must not match');
    assert.strictEqual(idx.searchFiles('status').length, 0, 'key name must not match');
    // Tags still match via their own column and body content matches
    assert.strictEqual(idx.searchFiles('pricing').length, 1);
    const hit = idx.searchFiles('margins')[0];
    assert.ok(!hit.snippet.includes('author:'), 'snippet must not leak frontmatter keys');
    assert.ok(!hit.snippet.includes('---'), 'snippet must not leak the YAML fence');
  });

  test('created-date range filters apply only where birthtime is real', () => {
    // birthtime is not settable via utimes, so the stat object is synthesised
    // and fed straight to the indexer (the same shape statSync produces).
    idx = freshIndex();
    const paths = [
      ['early.md', 1_600_000_000_000],
      ['late.md', 1_700_000_000_000],
      ['nobirth.md', 0], // filesystems without birthtime report 0
    ];
    for (const [rel, birthtimeMs] of paths) {
      write(rel, `shared token ibex in ${rel}`);
      idx._indexFile(workspace, rel, { mtimeMs: 1_700_000_000_000, size: 40, birthtimeMs });
    }
    assert.strictEqual(idx.searchFiles('ibex').length, 3);
    const recent = idx.searchFiles('ibex', { createdFrom: 1_650_000_000_000 });
    assert.deepStrictEqual(recent.map(h => h.path), ['late.md'], 'createdFrom filters, and null birthtime is excluded');
    const older = idx.searchFiles('ibex', { createdTo: 1_650_000_000_000 });
    assert.deepStrictEqual(older.map(h => h.path), ['early.md']);
  });

  test('frontmatter tags: bare comma list (no brackets) parses too', () => {
    idx = freshIndex();
    write('bare.md', '---\ntags: strategy, hiring\n---\nBody here.\n');
    idx.reconcileFiles(workspace);
    const hit = idx.searchFiles('body', { tags: ['hiring'] });
    assert.deepStrictEqual(hit.map(h => h.path), ['bare.md']);
    assert.deepStrictEqual(hit[0].tags.sort(), ['hiring', 'strategy']);
  });

  test('noteFileSaved skips non-indexed extensions and oversized files', () => {
    idx = freshIndex();
    write('data.json', '{"k": "quagga"}');
    assert.strictEqual(idx.noteFileSaved(workspace, 'data.json'), false, 'json is not content-indexed');
    const big = write('big.md', 'quagga '.padEnd(2 * 1024 * 1024 + 10, 'x'));
    assert.strictEqual(idx.noteFileSaved(workspace, 'big.md'), false, 'oversized files are skipped');
    assert.strictEqual(idx.searchFiles('quagga').length, 0);
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

describe('HTML/SVG artifact content indexing', () => {
  test('an unclosed script or style body is not indexed', () => {
    // A browser treats an unclosed <script>/<style> as consuming the rest of
    // the document as raw text (invisible), so text AFTER the opener is not
    // content; text BEFORE it still renders and indexes.
    idx = freshIndex();
    write('unclosed.html', '<html><body>Alpha visibleword<script>const secretvar = 42;</body></html>');
    write('unclosed2.html', '<html><body>Beta visibleword<style>.x{color:tomatored}</body></html>');
    idx.reconcileFiles(workspace);
    assert.strictEqual(idx.searchFiles('visibleword').length, 2, 'text before the unclosed element still indexes');
    assert.strictEqual(idx.searchFiles('secretvar').length, 0, 'unclosed script body must not leak');
    assert.strictEqual(idx.searchFiles('tomatored').length, 0, 'unclosed style body must not leak');
  });

  test('a > inside a quoted attribute does not leak markup', () => {
    idx = freshIndex();
    write('attr.html', '<html><body><img alt="a>bLeaked" data-x="c>dLeaked" src=x>Real caption words</body></html>');
    idx.reconcileFiles(workspace);
    assert.strictEqual(idx.searchFiles('caption').length, 1, 'visible text indexes');
    assert.strictEqual(idx.searchFiles('bLeaked').length, 0, 'attribute value past a > must not leak');
    assert.strictEqual(idx.searchFiles('dLeaked').length, 0);
  });

  test('HTML visible text is indexed; markup, classes, and attributes are not', () => {
    idx = freshIndex();
    write('report.html', '<!doctype html><html><head><title>Q3 numbers</title></head>'
      + '<body><div class="chartwrapper" data-region="emea"><p>Revenue climbed sharply.</p></div></body></html>');
    idx.reconcileFiles(workspace);
    assert.strictEqual(idx.searchFiles('revenue').length, 1, 'body text is searchable');
    assert.strictEqual(idx.searchFiles('sharply').length, 1);
    // Tag names, class names, and attribute values must never become tokens.
    assert.strictEqual(idx.searchFiles('chartwrapper').length, 0, 'class name must not leak');
    assert.strictEqual(idx.searchFiles('emea').length, 0, 'attribute value must not leak');
    assert.strictEqual(idx.searchFiles('doctype').length, 0, 'markup keyword must not leak');
  });

  test('script and style contents are dropped, not indexed', () => {
    idx = freshIndex();
    write('app.html', '<html><head><style>.x{color:tomatored}</style>'
      + '<script>const secretvar = 42;</script></head><body>Visible heading text</body></html>');
    idx.reconcileFiles(workspace);
    assert.strictEqual(idx.searchFiles('visible').length, 1);
    assert.strictEqual(idx.searchFiles('secretvar').length, 0, 'script contents must not be indexed');
    assert.strictEqual(idx.searchFiles('tomatored').length, 0, 'style contents must not be indexed');
  });

  test('HTML snippets carry no angle-bracket markup', () => {
    idx = freshIndex();
    write('doc.html', '<html><body><h1>Findable heading</h1><p>Some findable paragraph body.</p></body></html>');
    idx.reconcileFiles(workspace);
    const hit = idx.searchFiles('findable')[0];
    assert.ok(hit, 'the HTML file is a hit');
    assert.ok(!hit.snippet.includes('<'), 'snippet must not contain markup open brackets');
    assert.ok(!hit.snippet.includes('>'), 'snippet must not contain markup close brackets');
  });

  test('HTML entities are decoded before indexing', () => {
    idx = freshIndex();
    write('ent.html', '<html><body><p>Ben &amp; Jerry&#39;s caf&#233; menu</p></body></html>');
    idx.reconcileFiles(workspace);
    assert.strictEqual(idx.searchFiles('café').length, 1, 'numeric entity decodes to café');
  });

  test('SVG text content is indexed', () => {
    idx = freshIndex();
    write('diagram.svg', '<svg xmlns="http://www.w3.org/2000/svg"><text x="10" y="20">Milestone label</text>'
      + '<path d="M0 0 L10 10"/></svg>');
    idx.reconcileFiles(workspace);
    assert.strictEqual(idx.searchFiles('milestone').length, 1, 'SVG <text> content is searchable');
    assert.strictEqual(idx.searchFiles('path').length, 0, 'SVG element/attribute names must not leak');
  });

  test('HTML files carrying frontmatter index both values and stripped body', () => {
    idx = freshIndex();
    write('fronted.html', '---\nowner: octothorpe\n---\n<html><body><p>Rendered narwhal content</p></body></html>');
    idx.reconcileFiles(workspace);
    assert.strictEqual(idx.searchFiles('narwhal').length, 1, 'body still indexes after frontmatter strip');
    assert.strictEqual(idx.searchFiles('octothorpe').length, 1, 'frontmatter value indexes for HTML too');
  });
});
