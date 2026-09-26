'use strict';
// The Packages page as a place to manage what was installed. Server halves
// run against a temporary workspace through the real handlers; client halves
// render through the real settings view under jsdom; the client wiring is
// cut out of app.js and run, never matched.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const config = require('../../lib/config.js');
const handlers = require('../../lib/protocol/handlers/packages.js');
// A fixture snapshot stands for a fetched tag unless a test says otherwise.
// What a reference is on the remote is the real acquirer's to record, and
// that record is driven against a real repository in extension-install.
handlers.wireExtensionDeps({ pinKindOf: () => 'tag' });
const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
const { readExtensionRecords } = require('../../lib/packages/extension-record.js');
const { setExtensionEnabled, listReceipts, RECEIPTS_DIR } = require('../../lib/packages/extension-manage.js');
const installModel = require('../../public/packages-install-model.js');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');

// ---- The stylesheet block ----

const BLOCK_START = '/* ---- The Packages page: installed packages ---- */';
const BLOCK_END = '/* ---- end of the Packages page block ---- */';
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

// The block between its markers, asserted found and non-trivial, so a moved
// or deleted block fails by name rather than scanning an empty string.
function manageBlock() {
  const sheet = read('public', 'styles', 'views', 'settings.css');
  const start = sheet.indexOf(BLOCK_START);
  const end = sheet.indexOf(BLOCK_END);
  assert.ok(start !== -1 && end > start, 'settings.css no longer carries the Packages page block between its markers');
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
  test('no hex, rgba or hsla literal in the block; every colour-carrying declaration references a token; every tint is a color-mix over one', () => {
    assert.ok('.a { color: #E85A5A; }'.match(HEX) && '.a { background: rgba(0,0,0,0.1); }'.match(COLOUR_FUNC), 'a literal scan no longer matches its own specimen');
    assert.strictEqual('.a { content: "&#8593;"; }'.match(HEX), null, 'the hex scan reads a character reference as a colour');
    const block = manageBlock();
    assert.deepStrictEqual([...block.matchAll(HEX)].map((m) => m[0].trim()), []);
    assert.deepStrictEqual([...block.matchAll(COLOUR_FUNC)].map((m) => m[0]), []);
    const offenders = [];
    let declarations = 0;
    // White is the one literal a colour may be, and only as text: the label
    // on the solid danger chip, where it clears 5.01:1 on the fill and no
    // token names it (the test below holds that chip to its fill).
    let whiteText = 0;
    for (const [, prop, value] of block.matchAll(/([\w-]+)\s*:\s*([^;{}]+);/g)) {
      if (!COLOUR_PROPS.has(prop)) continue;
      declarations += 1;
      const v = value.trim();
      if (/^(none|transparent|inherit|currentColor|0)$/.test(v)) continue;
      if (prop === 'color' && v === 'white') { whiteText += 1; continue; }
      if (!/var\(--[\w-]+\)/.test(v)) offenders.push(`${prop}: ${v}`);
      if (/color-mix\(/.test(v) && !/color-mix\(in srgb, var\(--[\w-]+\) \d+%, transparent\)/.test(v)) offenders.push(`a tint not drawn over a token: ${prop}: ${v}`);
    }
    assert.ok(declarations >= 25, `only ${declarations} colour declarations found; the scan has gone blind`);
    assert.deepStrictEqual(offenders, []);
    assert.ok(whiteText <= 1, `${whiteText} white labels in the block; only the danger chip's may be white`);
  });

  test('the link button rests secondary, never takes the danger fill, and carries the focus ring; a card\'s words take the page\'s contrast tokens', () => {
    const block = manageBlock();
    assert.strictEqual(ruleIn(block, '.linkbtn').get('color'), 'var(--text-2)');
    assert.strictEqual(ruleIn(block, '.linkbtn.danger:hover').get('color'), 'var(--danger-text)');
    for (const m of block.matchAll(/\.linkbtn[^{]*\{([^}]*)\}/g)) assert.ok(!/background\s*:\s*var\(--danger\)/.test(m[1]), 'a link button never takes the danger fill');
    assert.ok(ruleIn(block, '.linkbtn:focus-visible').get('outline'), 'the link button carries the keyboard focus convention');
    assert.strictEqual(ruleIn(block, '.pkg-card-uninstall').get('color'), 'var(--settings-danger-text)', 'Uninstall rests in the danger text token, never the fill');
    assert.strictEqual(ruleIn(block, '.pkg-card-status.is-danger').get('color'), 'var(--settings-danger-text)');
    assert.strictEqual(ruleIn(block, '.pkg-card-status.is-update').get('color'), 'var(--settings-link-text)');
    assert.strictEqual(ruleIn(block, '.pkg-card-status').get('color'), 'var(--settings-quiet-text)');
    const repo = ruleIn(block, '.pkg-card-repo');
    assert.strictEqual(repo.get('overflow-wrap'), 'anywhere', 'a long repository wraps rather than being cut');
    assert.deepStrictEqual([ruleIn(block, '.pkg-card-chip').get('background'), ruleIn(block, '.pkg-card-chip').get('color')], ['var(--danger)', 'white']);
  });
});

// ---- The handlers, over a temporary workspace ----

function captureWs() {
  return { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } };
}

function counting() {
  const context = {
    workspace: { noteExtensionRecordsChanged() { context.calls += 1; } }, calls: 0,
    agents: { invalidateAgentCache() {}, flagRosterRefresh() {} },
  };
  return context;
}

// A package leaves through its card: the plan names what goes, and the
// confirm carries the plan's key.
function uninstallPackage(context, sock, name) {
  const source = `https://github.com/example/${name}`;
  const asked = captureWs();
  handlers.handlePlanPackageUninstall(context, asked, { type: 'plan_package_uninstall', source });
  handlers.handleConfirmPackageUninstall(context, sock, { type: 'confirm_package_uninstall', source, key: asked.sent[0].key });
}

function write(root, rel, content) {
  const absolute = path.join(root, rel);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

// The store as the install flow writes it: a record per name, each with its
// shipped manifest and entry, so the roster reads them as working.
function record(name, extra = {}) {
  return {
    name, version: '1.0.0', entry: 'index.js', match: `*.${name.slice(0, 3)}`,
    source: { url: `https://github.com/example/${name}`, reference: 'v1.0.0' },
    installedAt: '2026-08-25T10:00:00.000Z', root: `.rundock/extensions/${name}`, ...extra,
  };
}

function seedStore(root, records) {
  write(root, '.rundock/extensions.json', JSON.stringify({ schema: 'rundock.extensions/v1', extensions: records }, null, 2) + '\n');
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

// A snapshot of one version of the fixture extension, for the acquirer stub.
function snapshotOf(name, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manage-snap-'));
  write(dir, 'rundock.json', JSON.stringify({ name, version, extension: { entry: 'index.js', match: '*.csv' } }));
  write(dir, 'index.js', 'draw();');
  return dir;
}

describe('one read path answers the list and the host', () => {
  test('the page and the roster carry the same entries, with the record\'s source and install date on both; an uninstalled package\'s extension leaves both, and the uninstall reply carries the fresh roster', () => {
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
      assert.deepStrictEqual([page.sent[0].extensions[0].source, page.sent[0].extensions[0].installedAt, page.sent[0].receipts],
        [{ url: 'https://github.com/example/csv-echo', reference: 'v1.0.0' }, '2026-08-25T10:00:00.000Z', []]);
      const sock = captureWs();
      uninstallPackage(counting(), sock, 'csv-echo');
      assert.strictEqual(sock.sent[0].type, 'package_uninstall_result');
      assert.deepStrictEqual(sock.sent[0].extensions.map((e) => e.id), ['kanban']);
      const after = captureWs();
      handlers.handleListExtensions({}, after, { type: 'list_extensions' });
      assert.deepStrictEqual([after.sent[0].extensions.map((e) => e.id), readExtensionRecords(root).map((r) => r.name)], [['kanban'], ['kanban']]);
    });
  });

  test('an unreadable records file, or no workspace, answers the page as a named error, never as an empty page', () => {
    withWorkspace((root) => {
      write(root, '.rundock/extensions.json', '{ not json');
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
      assert.deepStrictEqual(sock.sent, [{ type: 'packages_page_error', reason: 'No workspace is open.' }]);
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
      assert.deepStrictEqual([reply.type, reply.operation, reply.name, reply.enabled], ['extension_state', 'set-enabled', 'csv-echo', false]);
      assert.deepStrictEqual(reply.extensions.map((e) => [e.id, e.enabled]), [['csv-echo', false], ['kanban', true]]);
      assert.deepStrictEqual(readExtensionRecords(root).find((r) => r.name === 'kanban'), before, 'the other record is as it was');
      assert.deepStrictEqual(fs.readdirSync(path.join(root, '.rundock')).sort(), ['extensions', 'extensions.json'], 'no second store appeared beside the records');
      assert.strictEqual(fs.existsSync(path.join(root, '.rundock', 'plugin-state.json')), false, 'and no state file under a retired layout');
      context.workspace.noteExtensionRecordsChanged = () => { context.calls += 1; };
      handlers.handleSetExtensionEnabled(context, sock, { type: 'set_extension_enabled', name: 'csv-echo', enabled: true });
      assert.strictEqual(readExtensionRecords(root).find((r) => r.name === 'csv-echo').enabled, true);
      assert.strictEqual(sock.sent[1].extensions[0].enabled, true);
    });
  });

  test('an unknown name, a flag that is not a boolean, and an unreadable store each refuse by name and write nothing; an uninstall that refuses names the package too', () => {
    withWorkspace((root) => {
      seedStore(root, [record('csv-echo')]);
      const raw = fs.readFileSync(path.join(root, '.rundock/extensions.json'), 'utf8');
      const sock = captureWs();
      const context = counting();
      handlers.handleSetExtensionEnabled(context, sock, { type: 'set_extension_enabled', name: 'ghost', enabled: false });
      handlers.handleSetExtensionEnabled(context, sock, { type: 'set_extension_enabled', name: 'csv-echo', enabled: 'no' });
      handlers.handlePlanPackageUninstall(context, sock, { type: 'plan_package_uninstall', source: 'https://github.com/example/ghost' });
      assert.deepStrictEqual(sock.sent.map((m) => [m.type, m.operation, m.name || m.id, m.code]), [
        ['package_install_error', 'set-enabled', 'ghost', 'not-installed'], ['package_install_error', 'set-enabled', 'csv-echo', 'invalid-state'],
        ['package_install_error', 'package-uninstall-plan', 'https://github.com/example/ghost', 'not-installed'],
      ]);
      assert.strictEqual(context.calls, 0, 'a refusal writes nothing, so the tree is told nothing');
      assert.strictEqual(fs.readFileSync(path.join(root, '.rundock/extensions.json'), 'utf8'), raw);
      assert.throws(() => setExtensionEnabled(root, 'csv-echo', undefined), (e) => e.code === 'invalid-state');
      write(root, '.rundock/extensions.json', '{ not json');
      handlers.handleSetExtensionEnabled(context, sock, { type: 'set_extension_enabled', name: 'csv-echo', enabled: false });
      assert.match(sock.sent[3].message, /unreadable/);
    });
  });
});

describe('off is enforced where the bytes are served, and every window is told', () => {
  const { uiPayload, listExtensions } = require('../../lib/packages/extension-registry.js');
  const { setExtensionsAllOff } = require('../../lib/packages/extension-manage.js');
  const others = () => { const b = captureWs(); const c = captureWs(); return [b, c]; };

  test('a disabled extension\'s entry is refused when asked for directly, and so is every one while the switch is on', () => {
    withWorkspace((root) => {
      seedStore(root, [record('csv-echo'), record('kanban', { enabled: false })]);
      assert.strictEqual(uiPayload(root, 'csv-echo', 'view').ok, true);
      const disabled = uiPayload(root, 'kanban', 'view');
      assert.strictEqual(disabled.ok, false);
      assert.match(disabled.reason, /disabled/);
      setExtensionsAllOff(root, true);
      const off = uiPayload(root, 'csv-echo', 'view');
      assert.strictEqual(off.ok, false, 'the switch refuses an extension whose own setting is on');
      assert.match(off.reason, /every extension is switched off/);
    });
  });

  test('the switch changes no extension\'s own setting, and turning it back restores each exactly', () => {
    withWorkspace((root) => {
      seedStore(root, [record('csv-echo'), record('kanban', { enabled: false })]);
      const own = () => readExtensionRecords(root).map((r) => [r.name, r.enabled]);
      const before = own();
      setExtensionsAllOff(root, true);
      assert.deepStrictEqual(own(), before, 'no record was touched');
      assert.deepStrictEqual(listExtensions(root).map((e) => [e.id, e.enabled, e.allOff, e.ownEnabled]),
        [['csv-echo', false, true, true], ['kanban', false, true, false]]);
      // A writer that knows nothing about the switch cannot turn it off.
      setExtensionEnabled(root, 'kanban', false);
      assert.strictEqual(listExtensions(root)[0].allOff, true, 'a per-extension write keeps the switch');
      setExtensionsAllOff(root, false);
      assert.deepStrictEqual(listExtensions(root).map((e) => [e.id, e.enabled]), [['csv-echo', true], ['kanban', false]]);
      assert.ok(!('allOff' in listExtensions(root)[0]), 'and the roster is back to its ordinary shape');
    });
  });

  // Pausing is for when something is wrong, so a record the page shows as one
  // that could not load (here, one naming no source) must not refuse it. The
  // switch acts on no record: each is written back exactly as it was.
  test('the switch pauses and resumes beside a record that names no source, and leaves that record as it was', () => {
    withWorkspace((root) => {
      seedStore(root, [record('csv-echo')]);
      const orphan = { name: 'orphan', version: '1.0.0', installedAt: '2026-08-25T10:00:00.000Z', root: '.rundock/extensions/orphan' };
      const store = path.join(root, '.rundock/extensions.json');
      const file = JSON.parse(fs.readFileSync(store, 'utf8'));
      fs.writeFileSync(store, JSON.stringify({ ...file, extensions: [...file.extensions, orphan] }, null, 2) + '\n');
      const asker = captureWs();
      handlers.handleSetExtensionsAllOff({ ...counting(), clients: new Set([asker]) }, asker, { type: 'set_extensions_all_off', off: true });
      assert.deepStrictEqual([asker.sent.at(-1).type, asker.sent.at(-1).operation, asker.sent.at(-1).allOff], ['extension_state', 'set-all-off', true]);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(store, 'utf8')).extensions.find((e) => e.name === 'orphan'), orphan);
      handlers.handleSetExtensionsAllOff({ ...counting(), clients: new Set([asker]) }, asker, { type: 'set_extensions_all_off', off: false });
      assert.deepStrictEqual([asker.sent.at(-1).type, asker.sent.at(-1).allOff], ['extension_state', false]);
    });
  });

  test('enabling, disabling, the switch and uninstalling each send the fresh roster to every other window', () => {
    withWorkspace((root) => {
      seedStore(root, [record('csv-echo'), record('kanban')]);
      const asker = captureWs();
      const [b, c] = others();
      const context = { ...counting(), clients: new Set([asker, b, c]) };
      handlers.handleSetExtensionEnabled(context, asker, { type: 'set_extension_enabled', name: 'csv-echo', enabled: false });
      for (const w of [b, c]) {
        assert.strictEqual(w.sent.at(-1).type, 'extensions', 'the other window is told');
        assert.strictEqual(w.sent.at(-1).extensions.find((e) => e.id === 'csv-echo').enabled, false);
      }
      assert.ok(!asker.sent.some((m) => m.type === 'extensions'), 'the asker has its own reply and is not told twice');
      handlers.handleSetExtensionsAllOff(context, asker, { type: 'set_extensions_all_off', off: true });
      assert.strictEqual(asker.sent.at(-1).allOff, true);
      assert.strictEqual(b.sent.at(-1).allOff, true);
      assert.ok(b.sent.at(-1).extensions.every((e) => e.enabled === false));
      uninstallPackage(context, asker, 'kanban');
      assert.deepStrictEqual(c.sent.at(-1).extensions.map((e) => e.id), ['csv-echo']);
    });
  });
});

describe('receipts are read from the directory and never written', () => {
  test('six seeded receipts come back newest first with their items; one deleted between reads is gone and nothing else moves; no directory is an empty history', () => {
    withWorkspace((root) => {
      assert.deepStrictEqual(listReceipts(root), []);
      for (const n of [1, 2, 3, 4, 5, 6]) {
        write(root, `${RECEIPTS_DIR}/2026-08-1${n}-run${n}.json`, JSON.stringify({
          schema: 'rundock.package-import-receipt/v1', source: { id: `https://github.com/someone/pack-${n}`, reference: 'v1.0.0' }, appliedAt: `2026-08-1${n}T09:00:00.000Z`,
          items: [{ id: 'agent:scribe', kind: 'agent', destination: '.claude/agents/scribe.md', decision: 'add', outcome: 'written' }],
        }));
      }
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
      assert.strictEqual(fs.existsSync(path.join(root, '.rundock', 'extensions.json')), false, 'reading receipts touches no other state');
    });
  });

  test('routines recorded on a receipt item survive the read, sanitized to their disclosed fields; a receipt without them keeps its shape', () => {
    withWorkspace((root) => {
      write(root, `${RECEIPTS_DIR}/2026-08-11-run1.json`, JSON.stringify({
        schema: 'rundock.package-import-receipt/v1', source: { id: 'https://github.com/someone/pack', reference: 'v1.0.0' }, appliedAt: '2026-08-11T09:00:00.000Z',
        items: [
          { id: 'agent:bea', kind: 'agent', destination: '.claude/agents/bea.md', decision: 'add', outcome: 'written',
            routines: [{ name: "Tidy yesterday's notes", schedule: 'every day at 08:00', enabled: true, prompt: 'never shown' }] },
          { id: 'skill:writer', kind: 'skill', destination: '.claude/skills/writer', decision: 'add', outcome: 'written' },
        ],
      }));
      const [receipt] = listReceipts(root);
      assert.deepStrictEqual(receipt.items[0].routines,
        [{ name: "Tidy yesterday's notes", schedule: 'every day at 08:00', enabled: true }],
        'the reader carries the routine through with exactly the fields the row discloses');
      assert.ok(!('routines' in receipt.items[1]), 'an item that recorded none keeps the shape every existing receipt has');
    });
  });
});

// ---- The view, through the real settings module under jsdom ----

global.RundockPackagesInstallModel = installModel;

function shell() {
  const dom = new JSDOM('<div id="settings-content"></div><div class="settings-nav-item" data-settings="workspace"></div><div class="settings-nav-item" data-settings="packages"></div>');
  global.document = dom.window.document;
  global.window = dom.window;
  global.currentView = 'settings';
  global.currentWorkspacePath = config.getWorkspace();
  const sent = [];
  global.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  global.WebSocket = { OPEN: 1 };
  global.esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  global.escAttr = (t) => global.esc(t).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const view = require('../../public/views/settings.js');
  view.packagesWorkspaceChanged();
  const content = () => dom.window.document.getElementById('settings-content');
  const answer = (handler, context = counting()) => {
    const sock = captureWs();
    handler(context, sock, sent[sent.length - 1]);
    for (const m of sock.sent) view.packagesReplyArrived(m);
    return sock.sent;
  };
  return {
    view, sent, content, answer,
    text: () => content().textContent.replace(/\s+/g, ' '),
    card: (id) => content().querySelector(`.pkg-card-row[data-package="${id}"]`),
    // Open the section the way the nav item does, and answer its read.
    open() { view.showSettingsSection('packages'); return answer(handlers.handleGetPackagesPage); },
    release() { for (const g of ['document', 'window', 'currentView', 'currentWorkspacePath', 'ws', 'WebSocket', 'esc', 'escAttr']) delete global[g]; },
  };
}

const REVIEW_SENTENCE = /Rundock doesn't review packages/;

describe('the page states that Rundock doesn\'t review packages, in every state of the section', () => {
  test('empty: the installed heading stands with its empty sentence, and the review statement sits with the field; populated: each package is a card with its source and release, and the statement stays', () => {
    withWorkspace((root) => {
      const s = shell();
      try {
        s.open();
        assert.deepStrictEqual([...s.content().querySelectorAll('.settings-section-label')].map((el) => el.textContent), ['Add a package', 'Installed packages']);
        assert.strictEqual(s.content().querySelector('.pkg-empty').textContent, 'No packages installed yet. Paste a package link above to get started.');
        assert.match(s.content().querySelector('.packages-field-hint').textContent, REVIEW_SENTENCE, 'the statement is read where the link is pasted');
        const long = 'wellington-park-investment-strategy-group/investment-hub-dashboard-and-portfolio-tools';
        seedStore(root, [record('csv-echo', { source: { url: `https://github.com/${long}`, reference: 'v1.0.0' } })]);
        s.open();
        const card = s.card(`https://github.com/${long}`);
        assert.ok(card, 'an extension no receipt names is a package of its own');
        assert.deepStrictEqual([card.querySelector('.pkg-card-name').textContent, card.querySelector('.pkg-card-ver').textContent, card.querySelector('.pkg-card-repo a').getAttribute('href')],
          ['Csv Echo', 'v1.0.0', `https://github.com/${long}`]);
        assert.match(s.text(), REVIEW_SENTENCE);
      } finally { s.release(); }
    });
  });


});





// ---- The client wiring, cut out of app.js and run ----

const APP_SRC = read('public', 'app.js');

function appPiece(pattern, label) {
  const found = APP_SRC.match(pattern);
  assert.ok(found && found[1] && found[1].trim(), `the client no longer carries ${label}`);
  return found[1];
}
const fn = (name) => new RegExp(`(function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\})`);
const arm = (type) => new RegExp(`(case '${type}': [\\s\\S]*? break;)`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('after a state, uninstall or page reply, the client hands the fresh roster to the host\'s reconcile entry point', () => {
  test('each roster-carrying reply reconciles with the roster it carries, in order, and reaches the page; a reply without a roster reaches the page alone', async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously' });
    const w = dom.window;
    const reconciled = [];
    const reached = [];
    w.reconcileExtensionMount = (roster) => { reconciled.push(roster); return { action: 'none' }; };
    w.packagesReplyArrived = (d) => reached.push(d.type);
    // The import arm also routes to the post-import refresh, which is not
    // this suite's subject: extension-install.test.js pins what it asks
    // for, so it is inert here.
    w.packagesImportLanded = () => {};
    w.rundockRendererRegistryLoader = () => import('../../public/renderer-registry.js');
    const arms = ['package_import_plan', 'packages_page', 'packages_page_error', 'package_update_result', 'package_uninstall_plan', 'package_uninstall_result'].map((t) => appPiece(arm(t), `the ${t} dispatch arm`)).join('\n');
    w.eval([
      appPiece(/(let extensionRosterSeq = 0;)/, 'the roster sequence'),
      ...['loadRendererRegistryModule', 'installRendererRegistry', 'extensionRosterArrived'].map((name) => appPiece(fn(name), name)),
      `window.__handle = function handle(d) { switch (d.type) { ${arms} } };`,
    ].join('\n'));
    const a = [{ id: 'csv-echo', version: '1.0.0', enabled: true, renderers: [{ id: 'view', target: '.csv' }] }];
    const b = [{ id: 'csv-echo', version: '1.0.0', enabled: false, renderers: [{ id: 'view', target: '.csv' }] }];
    const replies = [
      { type: 'packages_page', extensions: a, receipts: [] },
      { type: 'extension_state', operation: 'set-enabled', name: 'csv-echo', enabled: false, extensions: b },
      { type: 'package_uninstall_result', id: 'https://github.com/example/csv-echo', removed: [], kept: [], extensions: [] },
    ];
    for (const [i, reply] of replies.entries()) {
      w.__handle(reply);
      for (let n = 0; n < 100 && reconciled.length < i + 1; n += 1) await sleep(5);
    }
    assert.deepStrictEqual(reconciled, [a, b, []], 'the reconcile entry point received each fresh roster');
    assert.strictEqual(w.rundockRendererRegistry.rendererFor('a.csv').registered, false, 'the registry the seam reads was rebuilt from the last roster');
    w.__handle({ type: 'package_update_status', operation: 'package-update-check', id: 'https://github.com/example/csv-echo', outcome: 'up-to-date', newer: [], current: 'v1.0.0' });
    w.__handle({ type: 'packages_page_error', reason: 'x' });
    assert.deepStrictEqual(reached, ['packages_page', 'extension_state', 'package_uninstall_result', 'package_update_status', 'packages_page_error']);
    assert.strictEqual(reconciled.length, 3, 'a reply without a roster reconciles nothing');
    // A package update that moved an extension carries the roster, so an
    // open view of it is swapped from that reply.
    const c = [{ id: 'csv-echo', version: '2.0.0', build: '2.0.0@abc', enabled: true, renderers: [{ id: 'view', target: '.csv' }] }];
    w.__handle({ type: 'package_update_result', status: 'ready', id: 'https://github.com/example/csv-echo', writes: [], extensions: c });
    for (let n = 0; n < 100 && reconciled.length < 4; n += 1) await sleep(5);
    assert.deepStrictEqual(reconciled[3], c, 'the update result reconciled with the roster it carried');
    assert.strictEqual(reached[reached.length - 1], 'package_update_result');
    // The question before a package uninstall carries no roster: it reaches
    // the page and reconciles nothing (the result is in the replies above).
    w.__handle({ type: 'package_uninstall_plan', id: 'https://github.com/example/csv-echo', goes: [], stays: [], key: 'k' });
    assert.strictEqual(reached[reached.length - 1], 'package_uninstall_plan');
    await sleep(20);
    assert.strictEqual(reconciled.length, 4, 'the uninstall question reconciles nothing');
  });
});


describe('a record the real install wrote is what the page reads back', () => {
  test('the page handler reports the source and the install date the install transaction wrote, not a fixture\'s', () => {
    withWorkspace(() => {
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => snapshotOf('csv-echo', '1.0.0') });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(counting(), sock, { type: 'plan_package_install', url: 'example/csv-echo', reference: 'v1.0.0' });
        handlers.handleConfirmExtensionInstall(counting(), sock, { type: 'confirm_extension_install', token: sock.sent[0].token });
        const page = captureWs();
        handlers.handleGetPackagesPage(counting(), page, { type: 'get_packages_page' });
        const [entry] = page.sent[0].extensions;
        assert.deepStrictEqual(entry.source, { url: 'https://github.com/example/csv-echo', reference: 'v1.0.0' });
        assert.match(entry.installedAt, /^\d{4}-\d{2}-\d{2}T/, 'the install date the transaction wrote');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });
});

describe('an action the socket cannot carry', () => {
  test('sends nothing, leaves the history as it was with the notice, and the next action with the socket open sends and clears it', () => {
    withWorkspace((root) => {
      seedStore(root, [record('csv-echo'), record('kanban')]);
      const s = shell();
      try {
        s.open();
        // Opening Packages asked for a check; its answer frees the button.
        s.view.packagesReplyArrived({ type: 'package_update_checked', operation: 'package-update-check', count: 0 });
        const entries = () => [...s.content().querySelectorAll('.pkg-card-row')].map((r) => r.dataset.package);
        const before = entries();
        global.ws.readyState = 3;
        const sentBefore = s.sent.length;
        s.view.packagesCheckOne('https://github.com/example/kanban');
        assert.strictEqual(s.sent.length, sentBefore, 'nothing went out');
        assert.deepStrictEqual(entries(), before, 'the history stands');
        assert.match(s.text(), /Not connected/, 'the notice is rendered');
        assert.ok(!/Checking…/.test(s.text()), 'no in-flight marker stands for a send that did not happen');
        global.ws.readyState = 1;
        s.view.packagesCheckOne('https://github.com/example/kanban');
        assert.strictEqual(s.sent.length, sentBefore + 1, 'with the socket open the check sends');
      } finally { s.release(); }
    });
  });

});

// ---- The nav entry ----

describe('the Packages settings nav item', () => {
  test('carries no hiding style, sits between Connectors and Appearance with an svg glyph, and opens the section through showSettingsSection', () => {
    const nav = /<div class="settings-nav">([\s\S]*?)\n      <\/div>/.exec(read('public', 'index.html'));
    assert.ok(nav, 'index.html no longer carries the settings nav; an empty read here is a broken instrument');
    const items = [...nav[1].matchAll(/<div class="settings-nav-item(?: active)?" data-settings="([\w-]+)"([^>]*)>([\s\S]*?)<\/div>/g)]
      .map((m) => ({ section: m[1], attrs: m[2], body: m[3] }));
    // The claim this test makes is the POSITION, that Packages sits between
    // Connectors and Appearance, which is the approved page design's order:
    // the sections you configure first, then what you have brought in, then
    // preference and meta. The whole list stays frozen so that a reorder, or
    // a section that quietly disappears, still fails here.
    assert.deepStrictEqual(items.map((i) => i.section), ['workspace', 'permissions', 'connectors', 'packages', 'extensions', 'appearance', 'about']);
    const packagesItem = items[items.findIndex((i) => i.section === 'packages')];
    assert.ok(!/style=/.test(packagesItem.attrs), 'the entry carries no inline style');
    assert.match(packagesItem.body, /<svg [\s\S]*Packages/);
    for (const item of items) assert.match(item.attrs, /onclick="showSettingsSection\('[\w-]+'\)"/, `${item.section} uses the one section switch`);
  });
});

// A region extension is a whole extension, not a broken one. It draws
// a fenced language and owns no file type, and three separate places assumed
// a file claim before this: the manifest's required match rule, the roster's
// completeness check, and the match-to-target mapping. Each would have shown
// mermaid on the manage page as broken for no reason a reader could act on.
describe('an extension that claims a fenced language and no file is complete', () => {
  const { RECORDS_SCHEMA } = require('../../lib/packages/extension-record.js');
  const registry = require('../../lib/packages/extension-registry.js');
  const fs = require('node:fs');
  const path = require('node:path');
  const { makeTempDir } = require('../helpers/workspace.js');

  function workspaceWith(record) {
    const ws = makeTempDir('draws-ws-');
    fs.mkdirSync(path.join(ws, '.rundock/extensions', record.name, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.rundock/extensions', record.name, 'ui/index.js'), '// entry');
    fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.rundock/extensions.json'),
      JSON.stringify({ schema: RECORDS_SCHEMA, extensions: [record] }));
    return ws;
  }
  const base = {
    name: 'mermaid', version: '1.0.0', entry: 'ui/index.js',
    root: '.rundock/extensions/mermaid',
    source: { url: 'https://github.com/x/y', reference: 'v1.0.0' },
    installedAt: '2026-09-22T00:00:00.000Z',
  };

  test('it is enabled and whole, with no renderer and no refusal', () => {
    const [entry] = registry.listExtensions(workspaceWith({ ...base, draws: 'mermaid' }));
    assert.strictEqual(entry.broken, undefined, `a region extension is not broken: ${entry.reason || ''}`);
    assert.strictEqual(entry.enabled, true);
    assert.deepStrictEqual(entry.renderers, [], 'it claims no file, so it registers no renderer');
    assert.deepStrictEqual(entry.refusals, [],
      'and claiming no file is not a refusal: a rule that is absent was never rejected');
    assert.strictEqual(entry.draws, 'mermaid', 'and the roster says what it draws');
  });

  test('an extension claiming neither a file nor a language is still broken', () => {
    const [entry] = registry.listExtensions(workspaceWith({ ...base }));
    assert.strictEqual(entry.broken, true);
    assert.match(entry.reason, /something to claim/,
      'because an extension that claims nothing is one nobody can explain');
  });

  test('its entry is served when no renderer is named, and a renderer it lacks is still refused', () => {
    const ws = workspaceWith({ ...base, draws: 'mermaid' });
    const served = registry.uiPayload(ws, 'mermaid', null);
    assert.strictEqual(served.ok, true,
      'asking without a renderer id is how a region extension asks, and it must be answered');
    assert.strictEqual(typeof served.entry, 'string');
    assert.strictEqual(registry.uiPayload(ws, 'mermaid', 'view').ok, false,
      'naming a renderer it does not have is still wrong');
  });

  test('a file-claiming extension must still name its renderer', () => {
    const ws = workspaceWith({ ...base, name: 'csv', match: '*.csv', root: '.rundock/extensions/csv' });
    assert.strictEqual(registry.uiPayload(ws, 'csv', 'view').ok, true,
      'the id a file-claiming extension actually declares, read from the registry rather than guessed');
    const unnamed = registry.uiPayload(ws, 'csv', null);
    assert.strictEqual(unnamed.ok, false,
      'permission to omit a renderer belongs to extensions that have none, not to every caller');
    assert.match(unnamed.reason, /renderer must be named/);
  });

  test('a file-claiming extension is unchanged by any of this', () => {
    const [entry] = registry.listExtensions(workspaceWith({ ...base, name: 'csv', match: '*.csv',
      root: '.rundock/extensions/csv' }));
    assert.strictEqual(entry.broken, undefined);
    assert.deepStrictEqual(entry.renderers.map((r) => r.target), ['.csv']);
    assert.strictEqual(entry.draws, undefined, 'and carries no drawn language it never claimed');
  });
});

// ---- Updates on the Packages page, through the real view ----
describe('a package updates, and uninstalls, from its card, through the real view', () => {
  const URL_ = 'https://github.com/example/csv-echo';
  const PLAN = {
    type: 'package_update_plan', operation: 'package-update-plan', token: 'pkg-9', id: URL_, from: 'v1.0.0', to: 'v1.1.0',
    extension: { manifest: { name: 'csv-echo', version: '1.1.0' }, facts: {}, added: { writes: false, sources: false, asks: [] } },
    approval: { items: [] },
    groups: {
      'author-changed': [{ id: 'agent:scout', kind: 'agent', slug: 'scout', destination: '.claude/agents/scout.md', saveAuthor: false }],
      'both-changed': [{ id: 'skill:notes', kind: 'skill', slug: 'notes', destination: '.claude/skills/notes', saveAuthor: true, saved: '.rundock/package-updates/example-csv-echo/v1.1.0/.claude/skills/notes' }],
    },
    routines: {},
  };

  function opened(root) {
    seedStore(root, [record('csv-echo')]);
    const s = shell();
    s.open();
    s.view.packagesReplyArrived({ type: 'package_update_status', operation: 'package-update-check', id: URL_, outcome: 'newer-available', current: 'v1.0.0', newer: ['v1.1.0'], moved: null });
    s.view.packagesReplyArrived({ type: 'package_update_checked', operation: 'package-update-check', count: 1 });
    return s;
  }
  const entry = (s) => s.content().querySelector(`.pkg-card-row[data-package="${URL_}"]`);
  // Press a control the way the page does: its onclick names an exported
  // function of the view, called with the arguments it spells.
  function press(s, button) {
    const m = /^(\w+)\((.*)\)$/.exec(button.getAttribute('onclick'));
    assert.ok(m && typeof s.view[m[1]] === 'function', `the control calls an exported function (${button.getAttribute('onclick')})`);
    const args = m[2] ? m[2].split(',').map((a) => a.trim().replace(/^'|'$/g, '')) : [];
    s.view[m[1]](...args);
  }

  test('opening Packages checks every package once, and a newer release offers the update on its card', () => {
    withWorkspace((root) => {
      const s = opened(root);
      try {
        assert.deepStrictEqual(s.sent.filter((m) => m.type === 'check_package_update'), [{ type: 'check_package_update' }]);
        assert.strictEqual(entry(s).querySelector('.pkg-card-status.is-update').textContent, 'Update available: v1.1.0');
        press(s, entry(s).querySelector('[data-action="update"]'));
        assert.deepStrictEqual(s.sent[s.sent.length - 1], { type: 'plan_package_update', source: URL_, reference: 'v1.1.0' });
      } finally { s.release(); }
    });
  });

  test('the review opens inside the card, grouped, and confirm sends only its token; the summary offers the prompt', () => {
    withWorkspace((root) => {
      const s = opened(root);
      try {
        s.view.packagesReviewUpdate(URL_);
        s.view.packagesReplyArrived(PLAN);
        const review = entry(s).querySelector('#packages-update-review');
        assert.strictEqual(review.querySelector('.pkg-review-title').textContent, 'Update Csv Echo to v1.1.0?');
        assert.deepStrictEqual([...review.querySelectorAll('.pkg-review-group-label')].map((el) => el.textContent),
          ['Changed by the author', 'You and the author both changed these']);
        press(s, [...review.querySelectorAll('button')].find((b) => b.textContent === 'Update Csv Echo'));
        assert.deepStrictEqual(s.sent[s.sent.length - 1], { type: 'confirm_package_update', token: 'pkg-9', requestId: 'update-pkg-9' });
        s.view.packagesReplyArrived({ type: 'package_update_result', operation: 'package-update', id: URL_, to: 'v1.1.0', status: 'ready', writes: [], groups: PLAN.groups });
        const done = s.content().querySelector('#packages-update-done');
        assert.ok(done, 'the summary is on screen');
        assert.match(done.querySelector('.pkg-review-prompt').textContent, /\.claude\/skills\/notes and \.rundock\/package-updates\/example-csv-echo\/v1\.1\.0\/\.claude\/skills\/notes/);
        assert.deepStrictEqual(s.sent[s.sent.length - 1], { type: 'get_packages_page' }, 'and the page is read again');
      } finally { s.release(); }
    });
  });

  test('Uninstall asks first, lists what goes and what stays, and removes only on the named confirm', () => {
    withWorkspace((root) => {
      const s = opened(root);
      try {
        press(s, entry(s).querySelector('[data-action="uninstall"]'));
        assert.deepStrictEqual(s.sent[s.sent.length - 1], { type: 'plan_package_uninstall', source: URL_ });
        s.answer(handlers.handlePlanPackageUninstall);
        const confirm = entry(s).querySelector('#packages-uninstall-confirm');
        assert.strictEqual(confirm.querySelector('.pkg-review-title').textContent, 'Uninstall Csv Echo?');
        assert.deepStrictEqual([...confirm.querySelectorAll('.pkg-review-item')].map((el) => el.textContent), ['Csv Echo (extension)']);
        assert.ok(fs.existsSync(path.join(root, '.rundock', 'extensions', 'csv-echo')), 'nothing is removed by asking');
        press(s, [...confirm.querySelectorAll('button')].find((b) => b.textContent === 'Uninstall Csv Echo'));
        const context = { ...counting(), agents: { invalidateAgentCache() {}, flagRosterRefresh() {} } };
        s.answer(handlers.handleConfirmPackageUninstall, context);
        assert.ok(!fs.existsSync(path.join(root, '.rundock', 'extensions', 'csv-echo')));
        assert.match(s.text(), /Csv Echo is uninstalled\./);
        s.answer(handlers.handleGetPackagesPage);
        assert.strictEqual(entry(s), null, 'the package leaves the list');
      } finally { s.release(); }
    });
  });

  test('cancel releases what the review fetched', () => {
    withWorkspace((root) => {
      const s = opened(root);
      try {
        s.view.packagesReviewUpdate(URL_);
        s.view.packagesReplyArrived(PLAN);
        s.view.packagesCancelUpdate();
        assert.deepStrictEqual(s.sent[s.sent.length - 1], { type: 'decline_package_install', token: 'pkg-9' });
        assert.strictEqual(s.content().querySelector('#packages-update-review'), null);
      } finally { s.release(); }
    });
  });

  test('the saved folder\'s size is shown, and Clear asks first', () => {
    withWorkspace((root) => {
      write(root, '.rundock/package-updates/example-csv-echo/v1.1.0/x.md', 'x'.repeat(2048));
      const s = opened(root);
      try {
        const row = () => s.content().querySelector('#packages-updates-folder');
        assert.match(row().textContent, /Saved during updates: 1 file, 2 KB/);
        const before = s.sent.length;
        press(s, row().querySelector('button'));
        assert.strictEqual(s.sent.length, before, 'the first press only asks');
        assert.match(row().textContent, /Clear every saved author version and backup\?/);
        press(s, [...row().querySelectorAll('button')].find((b) => b.textContent === 'Clear'));
        assert.deepStrictEqual(s.sent[s.sent.length - 1], { type: 'clear_package_updates' });
        s.answer(handlers.handleClearPackageUpdates);
        assert.strictEqual(row(), null, 'an empty folder is not mentioned');
        assert.strictEqual(fs.existsSync(path.join(root, '.rundock', 'package-updates')), false);
      } finally { s.release(); }
    });
  });
});

describe('a card links each item still in the workspace, and marks the rest, through the real view', () => {
  test('a gone item is plain text marked removed, one no longer in the package is marked, and only items in the workspace link', () => {
    withWorkspace((root) => {
      const URL_ = 'https://github.com/example/team';
      const D = (c) => `sha256:${c.repeat(64)}`;
      const item = (id, kind, destination, fingerprint) => ({ id, kind, destination, decision: 'add', outcome: 'written', fingerprint, authored: kind === 'agent' ? fingerprint : undefined });
      write(root, `${RECEIPTS_DIR}/2026-09-01-run1.json`, JSON.stringify({
        schema: 'rundock.package-import-receipt/v1', source: { id: URL_, reference: 'v1.0.0' }, appliedAt: '2026-09-01T09:00:00.000Z',
        items: [
          item('agent:scout', 'agent', '.claude/agents/scout.md', D('a')),
          item('agent:writer', 'agent', '.claude/agents/writer.md', D('b')),
          item('skill:rebalance', 'skill', '.claude/skills/rebalance', D('c')),
        ],
      }));
      // v1.1.0 no longer carries the rebalance skill; the person keeps it.
      write(root, `${RECEIPTS_DIR}/2026-09-02-run2.json`, JSON.stringify({
        schema: 'rundock.package-import-receipt/v1', source: { id: URL_, reference: 'v1.1.0' }, appliedAt: '2026-09-02T09:00:00.000Z',
        items: [item('agent:scout', 'agent', '.claude/agents/scout.md', D('a')), item('agent:writer', 'agent', '.claude/agents/writer.md', D('b'))],
      }));
      write(root, '.claude/agents/scout.md', '---\nname: scout\n---\n\nScout.\n');
      write(root, '.claude/skills/rebalance/SKILL.md', 'Rebalance.');
      // The writer was removed by the person: no file.
      const s = shell();
      try {
        s.open();
        const list = s.card(URL_).querySelector('.pkg-card-items');
        assert.ok(list, 'the card lists its items');
        const links = [...list.querySelectorAll('button')];
        assert.deepStrictEqual(links.map((b) => b.textContent), ['scoutagent', 'rebalanceskill, no longer in the package'],
          'only the items still in the workspace are links');
        const gone = [...list.querySelectorAll('.pkg-card-gone')];
        assert.deepStrictEqual(gone.map((el) => el.textContent), ['writeragent, removed']);
        assert.strictEqual(gone[0].tagName, 'SPAN', 'the removed item is text');
        assert.strictEqual(gone[0].querySelector('button, a, [onclick], [tabindex]'), null, 'with nothing in it to press');
        assert.strictEqual(gone[0].getAttribute('onclick'), null);
      } finally { s.release(); }
    });
  });
});
