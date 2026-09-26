'use strict';
// EVERY REASON A PERSON READS IN SETTINGS IS A SENTENCE. It starts with a
// capital letter and ends with a full stop, whether it is an extension that
// could not load, a claim Rundock refused, or an error a write came back with.
//
// Fixed where the words are written (the roster the server builds, and the
// renderer registry both sides share), and held on display for anything that
// arrives some other way.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf-8');
const { listExtensions } = require('../../lib/packages/extension-registry.js');

const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const SENTENCE = /^[A-Z][\s\S]*[.!?…]$/;
// The first character of each reason literal inside a slice of source.
function reasonOpenings(src) {
  return [...src.matchAll(/reason:\s*(['`])((?:\\[\s\S]|(?!\1)[\s\S])*)\1/g)].map((m) => m[2]);
}

describe('the words, where they are written', () => {
  test('the scan reads a lowercase reason as one', () => {
    assert.deepStrictEqual(reasonOpenings("x = { reason: 'lower case' }; y = { reason: `Upper ${a}.` }; z = { reason: 'It\\'s whole.' };").map((r) => SENTENCE.test(r)), [false, true, true]);
  });

  test('every reason the roster gives an extension that could not load, or a claim it refused', () => {
    const src = read('lib', 'packages', 'extension-registry.js');
    const roster = src.slice(src.indexOf('function listExtensions('), src.indexOf('function uiPayload('));
    const found = reasonOpenings(roster);
    assert.ok(found.length >= 5, 'the roster\'s reasons were read');
    assert.deepStrictEqual(found.filter((r) => !SENTENCE.test(r)), []);
  });

  test('every refusal the shared renderer registry records', () => {
    const src = read('public', 'renderer-registry.js');
    const found = [...src.matchAll(/refusals\.push\(\{[\s\S]*?\}\)/g)].flatMap((m) => reasonOpenings(m[0]));
    assert.ok(found.length >= 5, 'the registry\'s refusals were read');
    assert.deepStrictEqual(found.filter((r) => !SENTENCE.test(r)), []);
  });
});

describe('what the Extensions page shows', () => {
  function workspaceWithBrokenRecords() {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'reasons-'));
    made.push(ws);
    fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.rundock', 'extensions.json'), JSON.stringify({
      schema: 'rundock.extensions/v1',
      extensions: [
        { name: 'no-claim', version: '1.0.0', source: { url: 'https://github.com/o/no-claim', reference: 'v1' }, installedAt: '2026-09-01T00:00:00Z', root: '.rundock/extensions/no-claim' },
        { name: 'Not A Slug', version: '1.0.0', source: { url: 'https://github.com/o/x', reference: 'v1' }, installedAt: '2026-09-01T00:00:00Z', root: '.rundock/extensions/x' },
      ],
    }));
    return ws;
  }

  test('the roster\'s own reasons, and a lowercase error from elsewhere, all read as sentences', () => {
    const roster = listExtensions(workspaceWithBrokenRecords());
    assert.ok(roster.every((e) => e.broken && SENTENCE.test(e.reason)), 'the real roster writes sentences');
    const withRefusal = [...roster, { id: 'claimer', enabled: true, refusals: [{ match: '*.md', reason: 'the marker is taken' }] }];

    const dom = new JSDOM(`<!doctype html><body><div class="settings-nav"><div class="settings-nav-item" data-settings="extensions"></div></div><div id="settings-content"></div></body>`, { runScripts: 'dangerously' });
    const w = dom.window;
    w.esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    w.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    for (const f of ['packages-decide.js', 'packages-install-model.js', 'packages-manage-model.js', 'extensions-view-model.js']) w.eval(read('public', f));
    w.eval(read('public', 'views', 'settings.js'));
    Object.assign(w, { currentView: 'settings', WebSocket: { OPEN: 1 }, ws: { readyState: 1, send() {} } });
    w.showSettingsSection('extensions');
    w.packagesReplyArrived({ type: 'packages_page', extensions: withRefusal, receipts: [] });
    // An action's error, arriving as an error's own lowercase text.
    w.packagesReplyArrived({ type: 'package_install_error', operation: 'set-enabled', name: 'claimer', message: 'extension records unreadable: not a recognised records file' });
    w.extensionsRenderIfVisible();
    const lines = [...w.document.querySelectorAll('.ext-page-line, .ext-page-empty.is-danger, .ext-page-notice')].map((n) => n.textContent.trim());
    assert.ok(lines.length >= 3, 'the reasons were rendered');
    assert.deepStrictEqual(lines.filter((l) => !SENTENCE.test(l)), []);

    // A page that could not be read at all.
    w.packagesReplyArrived({ type: 'packages_page_error', reason: 'no workspace is open' });
    w.extensionsRenderIfVisible();
    assert.strictEqual(w.document.querySelector('.ext-page-empty.is-danger').textContent, 'No workspace is open.');
  });
});

describe('what the Packages page shows', () => {
  const A = 'https://github.com/o/alpha';
  const card = (id, name, extra = {}) => ({
    id, name, title: name[0].toUpperCase() + name.slice(1), repo: id.replace('https://github.com/', ''),
    updatable: true, reference: 'v1.0.0', commit: null, extension: null,
    counts: { agent: 1, skill: 0, routine: 0, starter: 0, extension: 0 },
    items: [{ id: `agent:${name}`, kind: 'agent', label: name, state: 'as-installed', open: 'agent', target: name }], ...extra,
  });
  const PACKAGES = [
    card(A, 'alpha'),
    card('https://github.com/o/beta', 'beta'),
    card('https://github.com/o/gamma', 'gamma', { reference: '0123456789abcdef0123456789abcdef01234567' }),
    card('folder:delta', 'delta', { updatable: false, reference: null }),
    card('https://github.com/o/eps', 'eps', { extension: { name: 'eps', version: '1.0.0', enabled: true } }),
    card('https://github.com/o/zeta', 'zeta'),
  ];
  const ROSTER = [{ id: 'eps', broken: true, reason: 'The entry is missing.' }];

  function packagesWindow() {
    const dom = new JSDOM(`<!doctype html><body><div class="settings-nav"><div class="settings-nav-item" data-settings="packages"></div></div><div id="settings-content"></div></body>`, { runScripts: 'dangerously' });
    const w = dom.window;
    w.esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    w.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    for (const f of ['packages-decide.js', 'packages-install-model.js', 'packages-manage-model.js', 'packages-update-model.js', 'extensions-view-model.js']) w.eval(read('public', f));
    w.eval(read('public', 'views', 'settings.js'));
    Object.assign(w, { currentView: 'settings', WebSocket: { OPEN: 1 }, ws: { readyState: 1, send() {} } });
    w.showSettingsSection('packages');
    return w;
  }
  const text = (w, selector) => [...w.document.querySelectorAll(selector)].map((n) => n.textContent.trim()).filter(Boolean);

  test('every status, error, notice and refusal on a card reads as a sentence; the two short labels are exactly labels', () => {
    const w = packagesWindow();
    w.packagesReplyArrived({ type: 'packages_page', extensions: ROSTER, receipts: [], packages: PACKAGES });
    w.packagesReplyArrived({ type: 'package_update_status', id: A, outcome: 'newer-available', current: 'v1.0.0', newer: ['v1.1.0'] });
    w.packagesReplyArrived({ type: 'package_update_status', id: 'https://github.com/o/beta', outcome: 'up-to-date', current: 'v1.0.0', newer: [], moved: { tag: 'v1.0.0' } });
    // Errors arriving as an error's own lowercase text.
    w.packagesReplyArrived({ type: 'package_install_error', operation: 'package-update-check', id: 'https://github.com/o/zeta', message: 'the remote could not be reached' });
    w.packagesAskUninstall('https://github.com/o/gamma');
    w.packagesReplyArrived({ type: 'package_install_error', operation: 'package-uninstall', id: 'https://github.com/o/gamma', message: 'wait for scout\'s Morning briefing run to finish, then uninstall' });
    w.renderSettingsSection('packages');
    const statuses = text(w, '.pkg-card-status');
    assert.strictEqual(statuses.length, 6, 'every card carries a status');
    // Exempt by decision: "Up to date" and "Update available: vX" are status
    // labels, like the chip beside a name, so they take no full stop. Only
    // these two exact forms are exempt; anything added to them is a reason.
    const LABEL = /^(Up to date|Update available: v\d+\.\d+\.\d+)$/;
    assert.deepStrictEqual(statuses.filter((t) => !LABEL.test(t) && !SENTENCE.test(t)), []);
    assert.ok(statuses.includes('Update available: v1.1.0'));
    assert.ok(statuses.some((t) => /^Up to date\. The author moved v1\.0\.0/.test(t)), 'a label followed by a reason takes its full stop');

    // A plan with nothing left to remove, a result notice, and a lost connection.
    w.packagesAskUninstall(A);
    w.packagesReplyArrived({ type: 'package_uninstall_plan', id: A, title: 'Alpha', goes: [], stays: [{ id: 'agent:alpha', kind: 'agent', label: 'alpha', why: 'edited' }], key: 'k' });
    w.renderSettingsSection('packages');
    const notes = text(w, '#packages-uninstall-confirm .pkg-review-note, #packages-uninstall-confirm .pkg-review-title');
    assert.ok(notes.length >= 2);
    assert.deepStrictEqual(notes.filter((t) => !SENTENCE.test(t) && !/\?$/.test(t)), []);
    // A display name may start lowercase; the notice built on it still starts a sentence.
    w.packagesReplyArrived({ type: 'package_uninstall_result', id: 'https://github.com/o/beta', title: 'beta tools', removed: [], kept: [{ label: 'beta' }] });
    w.ws = { readyState: 3, send() {} };
    w.packagesCardAction('check', A);
    w.renderSettingsSection('packages');
    const notices = text(w, '.ext-notice');
    assert.ok(notices.length >= 1);
    assert.deepStrictEqual(notices.filter((t) => !SENTENCE.test(t)), []);
  });

  test('a page that could not be read says so in a sentence', () => {
    const w = packagesWindow();
    w.packagesReplyArrived({ type: 'packages_page_error', reason: 'no workspace is open' });
    w.renderSettingsSection('packages');
    assert.strictEqual(w.document.querySelector('.pkg-empty.is-danger').textContent, 'No workspace is open.');
  });
});

describe('what the Permissions pane shows', () => {
  test('every refusal the switch and the rules review can come back with starts a sentence', () => {
    const src = read('lib', 'protocol', 'handlers', 'workspace.js');
    const prefixes = [...src.matchAll(/'(Could not [^']*): '/g)].map((m) => m[1]);
    assert.ok(prefixes.length >= 3, 'the error prefixes were read');
    assert.deepStrictEqual(prefixes.filter((p) => !/^[A-Z]/.test(p)), []);
  });
});
