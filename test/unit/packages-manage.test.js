'use strict';
// The Packages page as a place to manage what was installed: the nav entry
// that reaches it, the handlers that write enablement and answer the page,
// the rows the real settings view draws for every state, the receipts of
// what a package added, and the stylesheet block that draws all of it from
// tokens alone.
//
// Server halves run against a temporary workspace through the real
// handlers; client halves render through the real settings view under jsdom
// with the model modules loaded the way the page loads them; the client
// wiring is cut out of app.js and run, never matched.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');

// ---------------------------------------------------------------------------
// The stylesheet block: every colour a token, tints through color-mix over a
// token, the hover tint and the keyboard ring on different properties.
// ---------------------------------------------------------------------------

const SHEET = 'public/styles/views/settings.css';
const BLOCK_START = '/* ---- The Packages page: managed extensions and receipts ---- */';
const BLOCK_END = '/* ---- end of the Packages page block ---- */';

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

// The block between its two markers, comments blanked. Asserted found and
// non-trivial, so a moved or deleted block fails here by name rather than
// scanning an empty string that carries no literal.
function manageBlock() {
  const sheet = read(SHEET);
  const start = sheet.indexOf(BLOCK_START);
  const end = sheet.indexOf(BLOCK_END);
  assert.ok(start !== -1 && end > start, `${SHEET} no longer carries the Packages page block between its markers`);
  const block = stripComments(sheet.slice(start + BLOCK_START.length, end));
  assert.ok(block.split('{').length > 20, 'the block has fewer rules than the page needs; an empty read here is a broken instrument');
  return block;
}

// One rule's declarations by exact selector, as a property-to-value map.
function ruleIn(block, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(block);
  assert.ok(m, `the block carries no rule for ${selector}`);
  return new Map(m[1].split(';').map((d) => d.trim()).filter(Boolean)
    .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]));
}

const HEX = /(^|[^&\w])#[0-9a-fA-F]{3,8}\b/g;
const COLOUR_FUNC = /\b(rgba?|hsla?)\(/g;
const COLOUR_PROPS = new Set(['color', 'background', 'background-color', 'border-color', 'border', 'border-top', 'box-shadow', 'outline']);

describe('the Packages page stylesheet block draws only from tokens', () => {
  test('the literal scans bite on specimens before the block is trusted', () => {
    assert.ok('.a { color: #E85A5A; }'.match(HEX), 'the hex scan no longer matches its own specimen');
    assert.ok('.a { background: rgba(0,0,0,0.1); }'.match(COLOUR_FUNC), 'the colour-function scan no longer matches its own specimen');
    assert.strictEqual('.a { content: "&#8593;"; }'.match(HEX), null, 'the hex scan reads a character reference as a colour');
  });

  test('no hex and no rgba or hsla literal anywhere in the block', () => {
    const block = manageBlock();
    assert.deepStrictEqual([...block.matchAll(HEX)].map((m) => m[0].trim()), [], 'a hex literal in the block; use a token');
    assert.deepStrictEqual([...block.matchAll(COLOUR_FUNC)].map((m) => m[0]), [], 'an rgba or hsla literal in the block; tint through color-mix over a token');
  });

  test('every colour-carrying declaration references a token, and every tint is a color-mix over one', () => {
    const block = manageBlock();
    const offenders = [];
    let declarations = 0;
    for (const m of block.matchAll(/([\w-]+)\s*:\s*([^;{}]+);/g)) {
      const [, prop, value] = m;
      if (!COLOUR_PROPS.has(prop)) continue;
      declarations += 1;
      const v = value.trim();
      const inert = /^(none|transparent|inherit|currentColor|0)$/.test(v);
      if (inert) continue;
      if (!/var\(--[\w-]+\)/.test(v)) offenders.push(`${prop}: ${v}`);
      if (/color-mix\(/.test(v) && !/color-mix\(in srgb, var\(--[\w-]+\) \d+%, transparent\)/.test(v)) {
        offenders.push(`a tint not drawn over a token: ${prop}: ${v}`);
      }
    }
    assert.ok(declarations >= 25, `only ${declarations} colour declarations found; the scan has gone blind`);
    assert.deepStrictEqual(offenders, []);
  });

  test('the hover tint and the keyboard ring sit on different properties, so both render together', () => {
    const block = manageBlock();
    const hover = ruleIn(block, '.ext-row:hover');
    assert.strictEqual(hover.get('background'), 'var(--elevated)', 'hover is the elevated tint');
    assert.ok(!hover.has('box-shadow') && !hover.has('outline'), 'hover draws no ring, so it cannot cancel the keyboard one');
    const ring = ruleIn(block, '.ext-row:focus-within');
    assert.match(ring.get('box-shadow') || '', /inset[^;]*var\(--accent\)|var\(--accent\)[^;]*inset/, 'the keyboard ring is an inset accent outline');
    assert.ok(!ring.has('background'), 'the ring rule leaves the background to the hover rule');
  });

  test('the quiet link button rests in the secondary text colour and turns danger text on hover; the fill is never resting', () => {
    const block = manageBlock();
    assert.strictEqual(ruleIn(block, '.linkbtn').get('color'), 'var(--text-2)');
    assert.strictEqual(ruleIn(block, '.linkbtn.danger:hover').get('color'), 'var(--danger-text)');
    assert.strictEqual(ruleIn(block, '.linkbtn.quiet:hover').get('color'), 'var(--accent)');
    for (const m of block.matchAll(/\.linkbtn[^{]*\{([^}]*)\}/g)) {
      assert.ok(!/background\s*:\s*var\(--danger\)/.test(m[1]), 'a link button never takes the danger fill; that is the confirmation button alone');
    }
    assert.ok(ruleIn(block, '.linkbtn:focus-visible').get('outline'), 'the link button carries the keyboard focus convention');
  });

  test('the repository segment wraps and is never clipped with an ellipsis', () => {
    const block = manageBlock();
    const src = ruleIn(block, '.ext-row .meta .src');
    assert.strictEqual(src.get('white-space'), 'normal');
    assert.strictEqual(src.get('overflow-wrap'), 'anywhere');
    assert.ok(!src.has('text-overflow') && !src.has('overflow'), 'provenance is never truncated');
  });

  test('each state chip takes its named tone token, and the danger chips take the text token, never the fill', () => {
    const block = manageBlock();
    const tones = {
      '.ext-chip.enabled': 'var(--success)',
      '.ext-chip.disabled': 'var(--idle)',
      '.ext-chip.update': 'var(--attention)',
      '.ext-chip.working': 'var(--working)',
      '.ext-chip.bad': 'var(--danger-text)',
    };
    for (const [selector, token] of Object.entries(tones)) {
      assert.strictEqual(ruleIn(block, selector).get('color'), token, `${selector} is drawn in ${token}`);
    }
    assert.match(ruleIn(block, '.ext-row .problem').get('color'), /var\(--danger-text\)/);
    assert.match(ruleIn(block, '.ext-row .row-note.danger').get('color'), /var\(--danger-text\)/);
  });
});

// ---------------------------------------------------------------------------
// The handlers, over a temporary workspace: one read path answers the list
// and the host, enablement is a field on the record, receipts are read and
// never written.
// ---------------------------------------------------------------------------

const os = require('node:os');
const config = require('../../lib/config.js');
const handlers = require('../../lib/protocol/handlers/packages.js');
const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
const { readExtensionRecords } = require('../../lib/packages/extension-record.js');
const { setExtensionEnabled, listReceipts, RECEIPTS_DIR } = require('../../lib/packages/extension-manage.js');

function captureWs() {
  return { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } };
}

function counting() {
  const context = { workspace: { noteExtensionRecordsChanged() { context.calls += 1; } }, calls: 0 };
  return context;
}

function write(root, rel, content) {
  const absolute = path.join(root, rel);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

// The store as the install flow writes it: two records, one directory each
// with its shipped manifest and entry, so the roster reads both as working.
function record(name, extra = {}) {
  return {
    name, version: '1.0.0', entry: 'index.js', match: `*.${name.slice(0, 3)}`,
    source: { url: `https://github.com/example/${name}`, reference: 'v1.0.0' },
    installedAt: '2026-08-25T10:00:00.000Z', root: `.claude/rundock/extensions/${name}`, ...extra,
  };
}

function seedStore(root, records) {
  write(root, '.claude/rundock/extensions.json', JSON.stringify({ schema: 'rundock.extensions/v1', extensions: records }, null, 2) + '\n');
  for (const r of records) {
    write(root, `${r.root}/rundock.json`, JSON.stringify({ name: r.name, version: r.version, extension: { entry: r.entry, match: r.match } }));
    write(root, `${r.root}/index.js`, 'draw();');
  }
}

function withWorkspace(fn) {
  const previous = config.getWorkspace();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manage-ws-'));
  config.setWorkspace(root);
  try { return fn(root); } finally {
    config.setWorkspace(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('one read path answers the list and the host', () => {
  test('the page and the roster carry the same entries, and a record\'s source and install date ride on both', () => {
    withWorkspace((root) => {
      seedStore(root, [record('csv-echo'), record('kanban')]);
      const table = buildDispatch();
      const page = captureWs();
      const roster = captureWs();
      table.get_packages_page({}, page, { type: 'get_packages_page' });
      table.list_extensions({}, roster, { type: 'list_extensions' });
      assert.strictEqual(page.sent[0].type, 'packages_page');
      assert.deepStrictEqual(page.sent[0].extensions, roster.sent[0].extensions, 'the two surfaces are one read');
      assert.deepStrictEqual(page.sent[0].extensions.map((e) => [e.name, e.version, e.enabled]), [['csv-echo', '1.0.0', true], ['kanban', '1.0.0', true]]);
      assert.deepStrictEqual(page.sent[0].extensions[0].source, { url: 'https://github.com/example/csv-echo', reference: 'v1.0.0' });
      assert.strictEqual(page.sent[0].extensions[0].installedAt, '2026-08-25T10:00:00.000Z');
      assert.deepStrictEqual(page.sent[0].receipts, []);
    });
  });

  test('an uninstalled extension leaves both surfaces, and the uninstall reply carries the fresh roster', () => {
    withWorkspace((root) => {
      seedStore(root, [record('csv-echo'), record('kanban')]);
      const sock = captureWs();
      handlers.handleUninstallExtension(counting(), sock, { type: 'uninstall_extension', name: 'csv-echo' });
      assert.strictEqual(sock.sent[0].type, 'extension_uninstalled');
      assert.deepStrictEqual(sock.sent[0].extensions.map((e) => e.id), ['kanban']);
      assert.match(sock.sent[0].untouched, /ordinary workspace files/);
      const roster = captureWs();
      handlers.handleListExtensions({}, roster, { type: 'list_extensions' });
      assert.deepStrictEqual(roster.sent[0].extensions.map((e) => e.id), ['kanban']);
      assert.deepStrictEqual(readExtensionRecords(root).map((r) => r.name), ['kanban']);
    });
  });

  test('an unreadable records file answers the page as a named error, never as an empty page', () => {
    withWorkspace((root) => {
      write(root, '.claude/rundock/extensions.json', '{ not json');
      const sock = captureWs();
      handlers.handleGetPackagesPage({}, sock, { type: 'get_packages_page' });
      assert.strictEqual(sock.sent[0].type, 'packages_page_error');
      assert.match(sock.sent[0].reason, /unreadable/);
    });
    const previous = config.getWorkspace();
    config.setWorkspace(null);
    try {
      const sock = captureWs();
      handlers.handleGetPackagesPage({}, sock, { type: 'get_packages_page' });
      assert.deepStrictEqual(sock.sent, [{ type: 'packages_page_error', reason: 'no workspace is open' }]);
    } finally { config.setWorkspace(previous); }
  });
});

describe('enablement is written on the record, and nowhere else', () => {
  test('disable writes enabled: false on that record only, tells the tree after the write and before the reply, and replies with the fresh roster', () => {
    withWorkspace((root) => {
      seedStore(root, [record('csv-echo'), record('kanban')]);
      const before = readExtensionRecords(root).find((r) => r.name === 'kanban');
      const sock = captureWs();
      const context = counting();
      context.workspace.noteExtensionRecordsChanged = () => {
        context.calls += 1;
        assert.strictEqual(readExtensionRecords(root).find((r) => r.name === 'csv-echo').enabled, false, 'told after the record is on disk');
        assert.strictEqual(sock.sent.length, 0, 'told before the reply goes out');
      };
      handlers.handleSetExtensionEnabled(context, sock, { type: 'set_extension_enabled', name: 'csv-echo', enabled: false });
      assert.strictEqual(context.calls, 1);
      const [reply] = sock.sent;
      assert.strictEqual(reply.type, 'extension_state');
      assert.strictEqual(reply.operation, 'set-enabled');
      assert.deepStrictEqual([reply.name, reply.enabled], ['csv-echo', false]);
      assert.deepStrictEqual(reply.extensions.map((e) => [e.id, e.enabled]), [['csv-echo', false], ['kanban', true]]);
      const records = readExtensionRecords(root);
      assert.strictEqual(records.find((r) => r.name === 'csv-echo').enabled, false);
      assert.deepStrictEqual(records.find((r) => r.name === 'kanban'), before, 'the other record is as it was');
      const files = fs.readdirSync(path.join(root, '.claude', 'rundock')).sort();
      assert.deepStrictEqual(files, ['extensions', 'extensions.json'], 'no second store appeared beside the records');
      assert.strictEqual(fs.existsSync(path.join(root, '.rundock')), false, 'and no state file under a retired layout');

      context.workspace.noteExtensionRecordsChanged = () => { context.calls += 1; };
      handlers.handleSetExtensionEnabled(context, sock, { type: 'set_extension_enabled', name: 'csv-echo', enabled: true });
      assert.strictEqual(readExtensionRecords(root).find((r) => r.name === 'csv-echo').enabled, true);
      assert.strictEqual(sock.sent[1].extensions[0].enabled, true);
    });
  });

  test('an unknown name, a flag that is not a boolean, and an unreadable store each refuse by name and write nothing', () => {
    withWorkspace((root) => {
      seedStore(root, [record('csv-echo')]);
      const raw = fs.readFileSync(path.join(root, '.claude/rundock/extensions.json'), 'utf8');
      const sock = captureWs();
      const context = counting();
      handlers.handleSetExtensionEnabled(context, sock, { type: 'set_extension_enabled', name: 'ghost', enabled: false });
      handlers.handleSetExtensionEnabled(context, sock, { type: 'set_extension_enabled', name: 'csv-echo', enabled: 'no' });
      assert.deepStrictEqual(sock.sent.map((m) => [m.type, m.operation, m.name, m.code]),
        [['package_install_error', 'set-enabled', 'ghost', 'not-installed'], ['package_install_error', 'set-enabled', 'csv-echo', 'invalid-state']]);
      assert.strictEqual(context.calls, 0, 'a refusal writes nothing, so the tree is told nothing');
      assert.strictEqual(fs.readFileSync(path.join(root, '.claude/rundock/extensions.json'), 'utf8'), raw);
      assert.throws(() => setExtensionEnabled(root, 'csv-echo', undefined), (e) => e.code === 'invalid-state');
      write(root, '.claude/rundock/extensions.json', '{ not json');
      handlers.handleSetExtensionEnabled(context, sock, { type: 'set_extension_enabled', name: 'csv-echo', enabled: false });
      assert.match(sock.sent[2].message, /unreadable/);
    });
  });

  test('a check for update and an uninstall that refuse name the extension, so the page lands the refusal on its row', () => {
    withWorkspace((root) => {
      seedStore(root, [record('csv-echo')]);
      const sock = captureWs();
      handlers.handleCheckExtensionUpdate(counting(), sock, { type: 'check_extension_update', name: 'ghost' });
      handlers.handleUninstallExtension(counting(), sock, { type: 'uninstall_extension', name: 'ghost' });
      assert.deepStrictEqual(sock.sent.map((m) => [m.type, m.operation, m.name]),
        [['package_install_error', 'update-check', 'ghost'], ['package_install_error', 'uninstall', 'ghost']]);
    });
  });
});

describe('receipts are read from the directory and never written', () => {
  function receiptFile(root, n, extra = {}) {
    const day = String(10 + n).padStart(2, '0');
    write(root, `${RECEIPTS_DIR}/2026-08-${day}-run${n}.json`, JSON.stringify({
      schema: 'rundock.package-import-receipt/v1',
      source: { id: `https://github.com/someone/pack-${n}`, reference: 'v1.0.0' },
      appliedAt: `2026-08-${day}T09:00:00.000Z`,
      items: [{ id: 'agent:scribe', kind: 'agent', destination: '.claude/agents/scribe.md', decision: 'add', outcome: 'written' }],
      ...extra,
    }, null, 2));
  }

  test('six seeded receipts come back newest first with their items; one deleted between reads is gone and nothing else moves', () => {
    withWorkspace((root) => {
      for (const n of [1, 2, 3, 4, 5, 6]) receiptFile(root, n);
      write(root, `${RECEIPTS_DIR}/broken.json`, '{ not json');
      write(root, `${RECEIPTS_DIR}/notes.txt`, 'not a receipt');
      const first = listReceipts(root);
      assert.deepStrictEqual(first.map((r) => r.file), ['2026-08-16-run6.json', '2026-08-15-run5.json', '2026-08-14-run4.json', '2026-08-13-run3.json', '2026-08-12-run2.json', '2026-08-11-run1.json']);
      assert.deepStrictEqual(first[0].items, [{ id: 'agent:scribe', kind: 'agent', destination: '.claude/agents/scribe.md', outcome: 'written' }]);
      assert.deepStrictEqual(first[0].source, { id: 'https://github.com/someone/pack-6', reference: 'v1.0.0' });
      const listing = () => fs.readdirSync(path.join(root, ...RECEIPTS_DIR.split('/'))).sort();
      const before = listing();
      fs.unlinkSync(path.join(root, RECEIPTS_DIR, '2026-08-15-run5.json'));
      const page = captureWs();
      handlers.handleGetPackagesPage({}, page, { type: 'get_packages_page' });
      assert.deepStrictEqual(page.sent[0].receipts.map((r) => r.file), ['2026-08-16-run6.json', '2026-08-14-run4.json', '2026-08-13-run3.json', '2026-08-12-run2.json', '2026-08-11-run1.json']);
      assert.deepStrictEqual(listing(), before.filter((f) => f !== '2026-08-15-run5.json'), 'the deleted receipt was not recreated, and nothing else was written');
      assert.strictEqual(fs.existsSync(path.join(root, '.claude', 'rundock', 'extensions.json')), false, 'reading receipts touches no other state');
    });
  });

  test('no receipts directory is an empty history', () => {
    withWorkspace((root) => { assert.deepStrictEqual(listReceipts(root), []); });
  });
});
