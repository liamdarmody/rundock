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
const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
const { readExtensionRecords } = require('../../lib/packages/extension-record.js');
const { setExtensionEnabled, listReceipts, RECEIPTS_DIR } = require('../../lib/packages/extension-manage.js');
const installModel = require('../../public/packages-install-model.js');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');

// ---- The stylesheet block ----

const BLOCK_START = '/* ---- The Packages page: managed extensions and receipts ---- */';
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
    for (const [, prop, value] of block.matchAll(/([\w-]+)\s*:\s*([^;{}]+);/g)) {
      if (!COLOUR_PROPS.has(prop)) continue;
      declarations += 1;
      const v = value.trim();
      if (/^(none|transparent|inherit|currentColor|0)$/.test(v)) continue;
      if (!/var\(--[\w-]+\)/.test(v)) offenders.push(`${prop}: ${v}`);
      if (/color-mix\(/.test(v) && !/color-mix\(in srgb, var\(--[\w-]+\) \d+%, transparent\)/.test(v)) offenders.push(`a tint not drawn over a token: ${prop}: ${v}`);
    }
    assert.ok(declarations >= 25, `only ${declarations} colour declarations found; the scan has gone blind`);
    assert.deepStrictEqual(offenders, []);
  });

  test('the hover tint and the keyboard ring sit on different properties; the link button rests secondary and turns danger text on hover, never the fill; the repository segment wraps unclipped', () => {
    const block = manageBlock();
    const hover = ruleIn(block, '.ext-row:hover');
    assert.strictEqual(hover.get('background'), 'var(--elevated)');
    assert.ok(!hover.has('box-shadow') && !hover.has('outline'), 'hover draws no ring, so it cannot cancel the keyboard one');
    const ring = ruleIn(block, '.ext-row:focus-within');
    assert.match(ring.get('box-shadow') || '', /inset[^;]*var\(--accent\)/, 'the keyboard ring is an inset accent outline');
    assert.ok(!ring.has('background'), 'the ring rule leaves the background to the hover rule');
    assert.strictEqual(ruleIn(block, '.linkbtn').get('color'), 'var(--text-2)');
    assert.strictEqual(ruleIn(block, '.linkbtn.danger:hover').get('color'), 'var(--danger-text)');
    assert.strictEqual(ruleIn(block, '.linkbtn.quiet:hover').get('color'), 'var(--accent)');
    for (const m of block.matchAll(/\.linkbtn[^{]*\{([^}]*)\}/g)) assert.ok(!/background\s*:\s*var\(--danger\)/.test(m[1]), 'a link button never takes the danger fill');
    assert.ok(ruleIn(block, '.linkbtn:focus-visible').get('outline'), 'the link button carries the keyboard focus convention');
    const src = ruleIn(block, '.ext-row .meta .src');
    assert.deepStrictEqual([src.get('white-space'), src.get('overflow-wrap'), src.has('text-overflow') || src.has('overflow')], ['normal', 'anywhere', false]);
  });

  test('each state chip takes its named tone token, and every danger word takes the text token, never the fill', () => {
    const block = manageBlock();
    const tones = { '.ext-chip.enabled': 'var(--success)', '.ext-chip.disabled': 'var(--idle)', '.ext-chip.update': 'var(--attention)', '.ext-chip.working': 'var(--working)', '.ext-chip.bad': 'var(--danger-text)' };
    for (const [selector, token] of Object.entries(tones)) assert.strictEqual(ruleIn(block, selector).get('color'), token, `${selector} is drawn in ${token}`);
    assert.strictEqual(ruleIn(block, '.ext-row .problem').get('color'), 'var(--danger-text)');
    assert.strictEqual(ruleIn(block, '.ext-row .row-note.danger').get('color'), 'var(--danger-text)');
  });
});

// ---- The handlers, over a temporary workspace ----

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

// The store as the install flow writes it: a record per name, each with its
// shipped manifest and entry, so the roster reads them as working.
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

// A snapshot of one version of the fixture extension, for the acquirer stub.
function snapshotOf(name, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manage-snap-'));
  write(dir, 'rundock.json', JSON.stringify({ name, version, extension: { entry: 'index.js', match: '*.csv' } }));
  write(dir, 'index.js', 'draw();');
  return dir;
}

describe('one read path answers the list and the host', () => {
  test('the page and the roster carry the same entries, with the record\'s source and install date on both; an uninstalled extension leaves both, and the uninstall reply carries the fresh roster', () => {
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
      handlers.handleUninstallExtension(counting(), sock, { type: 'uninstall_extension', name: 'csv-echo' });
      assert.strictEqual(sock.sent[0].type, 'extension_uninstalled');
      assert.deepStrictEqual(sock.sent[0].extensions.map((e) => e.id), ['kanban']);
      assert.match(sock.sent[0].untouched, /ordinary workspace files/);
      const after = captureWs();
      handlers.handleListExtensions({}, after, { type: 'list_extensions' });
      assert.deepStrictEqual([after.sent[0].extensions.map((e) => e.id), readExtensionRecords(root).map((r) => r.name)], [['kanban'], ['kanban']]);
    });
  });

  test('an unreadable records file, or no workspace, answers the page as a named error, never as an empty page', () => {
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
      assert.deepStrictEqual([reply.type, reply.operation, reply.name, reply.enabled], ['extension_state', 'set-enabled', 'csv-echo', false]);
      assert.deepStrictEqual(reply.extensions.map((e) => [e.id, e.enabled]), [['csv-echo', false], ['kanban', true]]);
      assert.deepStrictEqual(readExtensionRecords(root).find((r) => r.name === 'kanban'), before, 'the other record is as it was');
      assert.deepStrictEqual(fs.readdirSync(path.join(root, '.claude', 'rundock')).sort(), ['extensions', 'extensions.json'], 'no second store appeared beside the records');
      assert.strictEqual(fs.existsSync(path.join(root, '.rundock')), false, 'and no state file under a retired layout');
      context.workspace.noteExtensionRecordsChanged = () => { context.calls += 1; };
      handlers.handleSetExtensionEnabled(context, sock, { type: 'set_extension_enabled', name: 'csv-echo', enabled: true });
      assert.strictEqual(readExtensionRecords(root).find((r) => r.name === 'csv-echo').enabled, true);
      assert.strictEqual(sock.sent[1].extensions[0].enabled, true);
    });
  });

  test('an unknown name, a flag that is not a boolean, and an unreadable store each refuse by name and write nothing; a check or uninstall that refuses names the extension too', () => {
    withWorkspace((root) => {
      seedStore(root, [record('csv-echo')]);
      const raw = fs.readFileSync(path.join(root, '.claude/rundock/extensions.json'), 'utf8');
      const sock = captureWs();
      const context = counting();
      handlers.handleSetExtensionEnabled(context, sock, { type: 'set_extension_enabled', name: 'ghost', enabled: false });
      handlers.handleSetExtensionEnabled(context, sock, { type: 'set_extension_enabled', name: 'csv-echo', enabled: 'no' });
      handlers.handleCheckExtensionUpdate(context, sock, { type: 'check_extension_update', name: 'ghost' });
      handlers.handleUninstallExtension(context, sock, { type: 'uninstall_extension', name: 'ghost' });
      assert.deepStrictEqual(sock.sent.map((m) => [m.type, m.operation, m.name, m.code]), [
        ['package_install_error', 'set-enabled', 'ghost', 'not-installed'], ['package_install_error', 'set-enabled', 'csv-echo', 'invalid-state'],
        ['package_install_error', 'update-check', 'ghost', null], ['package_install_error', 'uninstall', 'ghost', 'not-installed'],
      ]);
      assert.strictEqual(context.calls, 0, 'a refusal writes nothing, so the tree is told nothing');
      assert.strictEqual(fs.readFileSync(path.join(root, '.claude/rundock/extensions.json'), 'utf8'), raw);
      assert.throws(() => setExtensionEnabled(root, 'csv-echo', undefined), (e) => e.code === 'invalid-state');
      write(root, '.claude/rundock/extensions.json', '{ not json');
      handlers.handleSetExtensionEnabled(context, sock, { type: 'set_extension_enabled', name: 'csv-echo', enabled: false });
      assert.match(sock.sent[4].message, /unreadable/);
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
      assert.strictEqual(fs.existsSync(path.join(root, '.claude', 'rundock', 'extensions.json')), false, 'reading receipts touches no other state');
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
    row: (name) => content().querySelector(`.ext-row[data-extension="${name}"]`),
    chip: (name) => { const c = content().querySelector(`.ext-row[data-extension="${name}"] .ext-chip`); return [c.textContent, c.className.replace('ext-chip ', ''), c.dataset.tone]; },
    // Open the section the way the nav item does, and answer its read.
    open() { view.showSettingsSection('packages'); return answer(handlers.handleGetPackagesPage); },
    act(action, name) { view.packagesExtensionAction(action, name); return sent[sent.length - 1]; },
    release() { for (const g of ['document', 'window', 'currentView', 'currentWorkspacePath', 'ws', 'WebSocket', 'esc', 'escAttr']) delete global[g]; },
  };
}

const REVIEW_SENTENCE = /Rundock does not review packages/;

describe('the page states that Rundock does not review packages, in every state of the section', () => {
  test('empty: both headings stand with empty copy beneath each and the sentence sits with the field; populated: every row states its facts with the repository in the wrapping segment, and the sentence stays', () => {
    withWorkspace((root) => {
      const s = shell();
      try {
        s.open();
        assert.deepStrictEqual([...s.content().querySelectorAll('.settings-section-label')].map((el) => el.textContent), ['Installed extensions', 'Recently added']);
        assert.strictEqual(s.content().querySelectorAll('.ext-empty').length, 2);
        assert.match(s.content().querySelector('.packages-field-hint').textContent, REVIEW_SENTENCE, 'the statement is read where the link is pasted');
        const long = 'wellington-park-investment-strategy-group/investment-hub-dashboard-and-portfolio-tools';
        seedStore(root, [record('csv-echo', { source: { url: `https://github.com/${long}`, reference: 'v1.0.0' } })]);
        s.open();
        const row = s.row('csv-echo');
        assert.ok(row, 'one row per record');
        assert.deepStrictEqual([row.querySelector('.name').textContent, row.querySelector('.ver').textContent, row.querySelector('.meta .src').textContent.replace(/\s·$/, '')], ['csv-echo', 'v1.0.0', long]);
        assert.match(row.querySelector('.meta').textContent, /pinned v1\.0\.0.*installed 25 Aug/);
        assert.match(s.text(), REVIEW_SENTENCE);
      } finally { s.release(); }
    });
  });
});

describe('every list state renders through the real view with its chip class and tone', () => {
  test('enabled, disabled, update available, current, failed update, updating, installing, install failed and broken', () => {
    withWorkspace((root) => {
      seedStore(root, [record('csv-echo'), record('kanban')]);
      write(root, '.claude/rundock/extensions.json', JSON.stringify({ schema: 'rundock.extensions/v1', extensions: [record('csv-echo'), record('kanban'), record('broken-one', { entry: null, match: null })] }));
      const s = shell();
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => snapshotOf('csv-echo', '2.0.0'), listRefs: () => ['v0.9.0', 'v1.0.0', 'v2.0.0'] });
      try {
        s.open();
        assert.deepStrictEqual(s.chip('csv-echo'), ['Enabled', 'enabled', 'success']);
        assert.deepStrictEqual(s.chip('broken-one'), ['Broken', 'bad', 'danger']);
        assert.match(s.row('broken-one').querySelector('.problem').textContent, /declares an entry/);

        assert.deepStrictEqual(s.act('disable', 'kanban'), { type: 'set_extension_enabled', name: 'kanban', enabled: false });
        s.answer(handlers.handleSetExtensionEnabled);
        assert.deepStrictEqual(s.chip('kanban'), ['Disabled', 'disabled', 'idle']);
        assert.ok(s.row('kanban').classList.contains('dimmed'), 'the disabled row is dimmed');
        assert.strictEqual(readExtensionRecords(root).find((r) => r.name === 'kanban').enabled, false);

        assert.deepStrictEqual(s.act('check', 'csv-echo'), { type: 'check_extension_update', name: 'csv-echo' });
        assert.match(s.row('csv-echo').querySelector('.actions').textContent, /Checking…/);
        s.answer(handlers.handleCheckExtensionUpdate);
        assert.deepStrictEqual(s.chip('csv-echo'), ['Update available', 'update', 'attention']);
        assert.strictEqual(s.row('csv-echo').querySelector('.row-note'), null, 'nothing beneath the chip, and no re-trust chip');
        assert.strictEqual(s.row('csv-echo').querySelector('.actions .linkbtn.accent').textContent, 'Update to v2.0.0');

        handlers.wireExtensionDeps({ listRefs: () => ['v1.0.0'] });
        s.act('enable', 'kanban');
        s.answer(handlers.handleSetExtensionEnabled);
        s.act('check', 'kanban');
        s.answer(handlers.handleCheckExtensionUpdate);
        assert.deepStrictEqual(s.chip('kanban'), ['Enabled', 'enabled', 'success']);
        assert.strictEqual(s.row('kanban').querySelector('.row-note').textContent, 'Up to date at v1.0.0.');

        // A failed update keeps the Enabled chip with the failure beneath.
        handlers.wireExtensionDeps({ acquire: () => { throw Object.assign(new Error('could not verify the tag'), { code: 'acquire-failed' }); } });
        assert.deepStrictEqual(s.act('update', 'csv-echo'), { type: 'plan_extension_update', name: 'csv-echo', reference: 'v2.0.0' });
        assert.deepStrictEqual(s.chip('csv-echo'), ['Updating', 'working', 'working']);
        assert.strictEqual(s.row('csv-echo').querySelector('.ver').textContent, 'v1.0.0 → v2.0.0');
        s.answer(handlers.handlePlanExtensionUpdate);
        assert.deepStrictEqual(s.chip('csv-echo'), ['Enabled', 'enabled', 'success'], 'the extension still runs, so its chip says so');
        const note = s.row('csv-echo').querySelector('.row-note');
        assert.strictEqual(note.dataset.tone, 'danger');
        assert.match(note.textContent, /Update to v2\.0\.0 failed: .*could not verify the tag.*Still running 1\.0\.0/);
        assert.strictEqual(s.content().querySelectorAll('.ext-chip.bad').length, 1, 'only the broken record wears a danger chip');
        s.view.packagesCancel();

        // A fresh install: the working chip while it runs, the danger chip
        // with the failure line when it did not.
        handlers.wireExtensionDeps({ acquire: () => snapshotOf('fresh-one', '0.1.0') });
        s.content().querySelector('#packages-source-link').value = 'someone/fresh-one';
        s.content().querySelector('#packages-source-ref').value = 'v0.1.0';
        s.view.packagesSubmit();
        s.answer(handlers.handlePlanPackageInstall);
        s.view.packagesConfirm();
        assert.deepStrictEqual(s.chip('fresh-one'), ['Installing', 'working', 'working']);
        assert.strictEqual(s.row('fresh-one').querySelector('.actions').children.length, 0, 'a transient row has no actions of its own');
        s.view.packagesReplyArrived({ type: 'package_install_error', operation: 'install', token: s.sent[s.sent.length - 1].token, message: 'the entry could not be read' });
        assert.deepStrictEqual(s.chip('fresh-one'), ['Install failed', 'bad', 'danger']);
        assert.match(s.row('fresh-one').querySelector('.problem').textContent, /the entry could not be read\. Nothing was enabled\./);
      } finally {
        handlers.wireExtensionDeps(previousDeps);
        s.release();
      }
    });
  });
});

describe('Update enters the trust step; declining leaves the record, the files and the flag alone', () => {
  test('the plan reply is the same trust card, with the replaced version named, and declining changes nothing on disk', () => {
    withWorkspace((root) => {
      seedStore(root, [record('csv-echo')]);
      const onDisk = () => [fs.readFileSync(path.join(root, '.claude/rundock/extensions.json'), 'utf8'), fs.readdirSync(path.join(root, '.claude/rundock/extensions/csv-echo')).sort().join(',')];
      const before = onDisk();
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => snapshotOf('csv-echo', '2.0.0'), listRefs: () => ['v1.0.0', 'v2.0.0'] });
      const s = shell();
      try {
        s.open();
        s.act('check', 'csv-echo');
        s.answer(handlers.handleCheckExtensionUpdate);
        s.act('update', 'csv-echo');
        const [plan] = s.answer(handlers.handlePlanExtensionUpdate);
        assert.strictEqual(plan.type, 'extension_install_plan');
        const card = s.content().querySelector('.extension-trust-card');
        assert.ok(card, 'the update confirms through the trust card an install shows');
        assert.match(card.textContent, /Install csv-echo 2\.0\.0\?[\s\S]*From https:\/\/github\.com\/example\/csv-echo, pinned to v2\.0\.0[\s\S]*This replaces the installed 1\.0\.0 \(pinned at v1\.0\.0\)/);
        s.view.packagesDecline();
        assert.deepStrictEqual(s.sent[s.sent.length - 1], { type: 'decline_package_install', token: plan.token });
        s.answer(handlers.handleDeclinePackageInstall);
        assert.deepStrictEqual(onDisk(), before, 'declining left the record, the files and the flag as they were');
        assert.strictEqual(s.content().querySelector('.extension-trust-card'), null);
        assert.strictEqual(s.chip('csv-echo')[0], 'Update available', 'the offer stands; nothing was installed');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
        s.release();
      }
    });
  });
});

describe('Uninstall rests quiet, confirms in the row, and sends nothing before the confirmation', () => {
  test('the resting control is a danger link button; the filled button appears only inside the confirmation; the reply removes the row and renders its untouched sentence', () => {
    withWorkspace((root) => {
      seedStore(root, [record('csv-echo'), record('kanban')]);
      const s = shell();
      try {
        s.open();
        assert.strictEqual(s.row('csv-echo').querySelector('[data-action="uninstall"]').className, 'linkbtn danger');
        assert.strictEqual(s.content().querySelector('.settings-btn-danger'), null, 'no filled danger button at rest');
        const sentBefore = s.sent.length;
        s.act('uninstall', 'csv-echo');
        assert.strictEqual(s.sent.length, sentBefore, 'asking sends nothing');
        const filled = s.row('csv-echo').querySelector('.ext-confirm .settings-btn-danger');
        assert.strictEqual(filled.textContent, 'Uninstall csv-echo');
        assert.strictEqual(s.content().querySelectorAll('.settings-btn-danger').length, 1);
        s.view.packagesCancelUninstall();
        assert.strictEqual(s.row('csv-echo').querySelector('.ext-confirm'), null);
        assert.strictEqual(s.sent.length, sentBefore, 'the way back sends nothing');
        s.act('uninstall', 'csv-echo');
        s.view.packagesConfirmUninstall('csv-echo');
        assert.deepStrictEqual(s.sent[s.sent.length - 1], { type: 'uninstall_extension', name: 'csv-echo' });
        const [reply] = s.answer(handlers.handleUninstallExtension);
        assert.strictEqual(reply.type, 'extension_uninstalled');
        assert.deepStrictEqual([s.row('csv-echo'), !!s.row('kanban')], [null, true], 'the row is gone, the other stays');
        assert.strictEqual(s.content().querySelector('.ext-notice').textContent, reply.untouched, 'the reply\'s own sentence, beneath the list');
        assert.strictEqual(fs.existsSync(path.join(root, '.claude/rundock/extensions/csv-echo')), false);
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
    w.rundockRendererRegistryLoader = () => import('../../public/renderer-registry.js');
    const arms = ['package_import_plan', 'packages_page', 'packages_page_error'].map((t) => appPiece(arm(t), `the ${t} dispatch arm`)).join('\n');
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
      { type: 'extension_uninstalled', operation: 'uninstall', name: 'csv-echo', untouched: 'x', extensions: [] },
    ];
    for (const [i, reply] of replies.entries()) {
      w.__handle(reply);
      for (let n = 0; n < 100 && reconciled.length < i + 1; n += 1) await sleep(5);
    }
    assert.deepStrictEqual(reconciled, [a, b, []], 'the reconcile entry point received each fresh roster');
    assert.strictEqual(w.rundockRendererRegistry.rendererFor('a.csv').registered, false, 'the registry the seam reads was rebuilt from the last roster');
    w.__handle({ type: 'extension_update_status', operation: 'update-check', name: 'csv-echo', outcome: 'up-to-date', newer: [], current: 'v1.0.0' });
    w.__handle({ type: 'packages_page_error', reason: 'x' });
    assert.deepStrictEqual(reached, ['packages_page', 'extension_state', 'extension_uninstalled', 'extension_update_status', 'packages_page_error']);
    assert.strictEqual(reconciled.length, 3, 'a reply without a roster reconciles nothing');
  });
});

// ---- The nav entry ----

describe('the Packages settings nav item', () => {
  test('carries no hiding style, sits second after Workspace with an svg glyph, and opens the section through showSettingsSection', () => {
    const nav = /<div class="settings-nav">([\s\S]*?)\n      <\/div>/.exec(read('public', 'index.html'));
    assert.ok(nav, 'index.html no longer carries the settings nav; an empty read here is a broken instrument');
    const items = [...nav[1].matchAll(/<div class="settings-nav-item(?: active)?" data-settings="([\w-]+)"([^>]*)>([\s\S]*?)<\/div>/g)]
      .map((m) => ({ section: m[1], attrs: m[2], body: m[3] }));
    assert.deepStrictEqual(items.map((i) => i.section), ['workspace', 'packages', 'connectors', 'appearance', 'about']);
    assert.ok(!/style=/.test(items[1].attrs), 'the entry carries no inline style');
    assert.match(items[1].body, /<svg [\s\S]*Packages/);
    for (const item of items) assert.match(item.attrs, /onclick="showSettingsSection\('[\w-]+'\)"/, `${item.section} uses the one section switch`);
  });
});
