'use strict';
// The Extensions settings page, rendered by the real view over the real manage
// model and pressed the way a person presses it. What it sends is the
// behaviour: only enablement, pause, resume and uninstall, and never anything
// to do with updates.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf-8');
const V = require('../../public/extensions-view-model.js');

const NOW = Date.now();
const ago = (d) => new Date(NOW - d * 86400000).toISOString();
const EXTENSIONS = [
  { id: 'investment-partner', version: '1.0.0', installedAt: ago(2), enabled: true, source: { url: 'https://github.com/someone/investment-partner' } },
  { id: 'reading-list', version: '0.4.2', installedAt: ago(42), enabled: true, source: { url: 'https://github.com/someone/reading-list' } },
  { id: 'broken-sync', version: '2.1.0', installedAt: ago(95), enabled: false },
  { id: 'csv-viewer', version: '1.4.0', installedAt: ago(4), broken: true, reason: 'entry missing', source: { url: 'https://github.com/someone/csv-viewer' } },
  { id: 'old-importer', version: '0.2.0', installedAt: ago(30), broken: true, reason: 'entry missing' },
];
const RECEIPTS = [{ file: 'r1.json', source: { id: 'https://github.com/someone/investment-partner' }, appliedAt: ago(2), items: [] }];
// The package cards the page read carries (package-state.js packageCards).
const PACKAGES = [{
  id: 'https://github.com/someone/investment-partner', name: 'investment-partner', title: 'Investment Partner', repo: 'someone/investment-partner',
  updatable: true, reference: 'v1.0.0', commit: null, extension: { name: 'investment-partner', version: '1.0.0', enabled: true },
  counts: { agent: 0, skill: 0, routine: 0, starter: 0, extension: 1 }, items: [],
}, {
  id: 'https://github.com/someone/csv-viewer', name: 'csv-viewer', title: 'Csv Viewer', repo: 'someone/csv-viewer',
  updatable: true, reference: 'v1.4.0', commit: null, extension: { name: 'csv-viewer', version: '1.4.0', enabled: true },
  counts: { agent: 0, skill: 0, routine: 0, starter: 0, extension: 1 }, items: [],
}];

function page({ extensions = EXTENSIONS, receipts = RECEIPTS, packages = PACKAGES, allOff = false } = {}) {
  const dom = new JSDOM(`<!doctype html><body><div class="settings-nav">${
    ['workspace', 'permissions', 'packages', 'extensions'].map((s) => `<div class="settings-nav-item" data-settings="${s}"></div>`).join('')
  }</div><div id="settings-content"></div></body>`, { runScripts: 'dangerously' });
  const w = dom.window;
  w.esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  w.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  for (const f of ['packages-decide.js', 'packages-install-model.js', 'packages-update-model.js', 'packages-manage-model.js', 'extensions-view-model.js']) w.eval(read('public', f));
  w.eval(read('public', 'views', 'settings.js'));
  w.sent = [];
  Object.assign(w, { currentView: 'settings', currentWorkspacePath: '/Users/someone/team', agents: [], skills: [], runtimeStatus: null,
    WebSocket: { OPEN: 1 }, ws: { readyState: 1, send: (m) => w.sent.push(JSON.parse(m)) } });
  w.showSettingsSection('extensions');
  // The page read, answered, and handed on the way app.js hands it.
  const reply = (msg) => { w.packagesReplyArrived(msg); w.extensionsRenderIfVisible(); };
  reply({ type: 'packages_page', extensions, receipts, packages, allOff });
  w.sent.length = 0;
  const doc = w.document;
  const content = () => doc.getElementById('settings-content');
  const row = (id) => content().querySelector(`.ext-page-row[data-extension="${id}"]`);
  return { w, doc, content, row, reply, sent: w.sent };
}

describe('where it lives and what it shows', () => {
  test('its own section, opened straight to the list with the lead and no link field', () => {
    const { content } = page();
    assert.strictEqual(content().querySelector('.settings-section-title').textContent, 'Extensions');
    assert.strictEqual(content().querySelector('.settings-lead').textContent, 'Extensions add features to Rundock. Manage the ones you\'ve installed here.');
    assert.strictEqual(content().querySelector('input:not([role="switch"])'), null, 'no install field here');
  });

  test('opening it reads the page', () => {
    const { w } = page();
    w.sent.length = 0;
    w.showSettingsSection('extensions');
    assert.deepStrictEqual(w.sent, [{ type: 'get_packages_page' }]);
  });

  test('the list comes first and the pause below it', () => {
    const { content } = page();
    const list = content().querySelector('#extensions-list');
    const pause = content().querySelector('.ext-pause');
    assert.ok(list.compareDocumentPosition(pause) & 4, 'the pause follows the list');
    assert.strictEqual(pause.querySelector('p').textContent, 'Having trouble? Pause all extensions to check whether one is causing it. Nothing is removed.');
    assert.strictEqual(pause.querySelector('button').textContent, 'Pause all extensions');
  });

  test('each row: name, version, when it was added, and one control column holding only the switch: removal is the package\'s', () => {
    const { row } = page();
    const r = row('investment-partner');
    assert.strictEqual(r.querySelector('.ext-page-name').textContent, 'investment-partner');
    assert.strictEqual(r.querySelector('.ext-page-ver').textContent, 'v1.0.0');
    assert.strictEqual(r.querySelector('.ext-page-added').textContent, 'Added 2 days ago');
    const column = r.querySelector('.ext-page-controls');
    assert.deepStrictEqual([...column.children].map((c) => c.className), ['row-onoff']);
    const sw = column.querySelector('[role="switch"]');
    assert.deepStrictEqual([sw.getAttribute('aria-label'), sw.checked, column.querySelector('.onoff-label').textContent], ['investment-partner', true, 'On']);
    assert.strictEqual(row('broken-sync').querySelector('.onoff-label').textContent, 'Off');
  });

  test('a row that could not load, from a known package: the chip, the sentence on the left with "its package" as the link, and an empty control column', () => {
    const { row, doc } = page();
    const r = row('csv-viewer');
    assert.strictEqual(r.querySelector('.ext-page-chip').textContent, 'Couldn\'t load');
    assert.strictEqual(r.querySelector('[role="switch"]'), null, 'no switch');
    const column = r.querySelector('.ext-page-controls');
    assert.strictEqual(column.children.length, 0, 'nothing in the control column');
    assert.strictEqual(column.textContent.trim(), '');
    const line = r.querySelector('.ext-page-id .ext-page-failed');
    assert.strictEqual(line.textContent, 'Rundock couldn\'t load this extension. Uninstall it from its package.');
    const links = [...line.querySelectorAll('button, a')];
    assert.strictEqual(links.length, 1, 'one link, in the sentence');
    assert.strictEqual(links[0].textContent, 'its package');
    assert.ok(links[0].classList.contains('ext-page-to-package'));
    links[0].click();
    assert.strictEqual(doc.querySelector('.settings-nav-item.active').dataset.settings, 'packages');
    assert.strictEqual(doc.activeElement.dataset.package, 'https://github.com/someone/csv-viewer', 'its package card opens with focus');
  });

  test('"its package" keeps focus on the package card across the redraws the page read and the update check cause', () => {
    const { row, doc, w } = page();
    row('csv-viewer').querySelector('.ext-page-to-package').click();
    const id = 'https://github.com/someone/csv-viewer';
    assert.strictEqual(doc.activeElement.dataset.package, id);
    // Opening Packages reads the page again and checks every package for
    // updates; each answer redraws the section.
    w.packagesReplyArrived({ type: 'packages_page', extensions: EXTENSIONS, receipts: RECEIPTS, packages: PACKAGES, allOff: false });
    assert.strictEqual(doc.activeElement.dataset && doc.activeElement.dataset.package, id, 'focus survives the page read');
    w.packagesReplyArrived({ type: 'package_update_status', id, outcome: 'current', current: 'v1.4.0', newer: [] });
    w.packagesReplyArrived({ type: 'package_update_checked' });
    assert.strictEqual(doc.activeElement.dataset && doc.activeElement.dataset.package, id, 'focus survives the update check');
  });

  test('a row that could not load, from a package that is not known: plain words, and no link or control anywhere in the row', () => {
    const { row } = page();
    const r = row('old-importer');
    assert.strictEqual(r.querySelector('.ext-page-chip').textContent, 'Couldn\'t load');
    assert.strictEqual(r.querySelector('.ext-page-id .ext-page-failed').textContent,
      'Rundock couldn\'t load this extension. Rundock can\'t tell which package installed it.');
    assert.strictEqual(r.querySelector('button, a, input, [role="switch"], [onclick], .ext-page-to-package'), null, 'nothing to press');
    const column = r.querySelector('.ext-page-controls');
    assert.strictEqual(column.children.length, 0);
    assert.strictEqual(column.textContent.trim(), '');
  });

  test('no row is dimmed, in any state', () => {
    for (const allOff of [false, true]) {
      const { content } = page({ allOff });
      for (const r of content().querySelectorAll('.ext-page-row')) {
        assert.ok(!r.classList.contains('dimmed'));
        assert.strictEqual(r.getAttribute('style'), null);
      }
    }
  });
});

describe('the package it came from', () => {
  test('named as a link where it is known, which opens Packages on that entry', () => {
    const { w, doc, row } = page();
    const link = row('investment-partner').querySelector('.ext-page-from button');
    assert.strictEqual(row('investment-partner').querySelector('.ext-page-from').textContent, 'From the Investment Partner package');
    link.click();
    assert.strictEqual(doc.querySelector('.settings-nav-item.active').dataset.settings, 'packages');
    assert.strictEqual(doc.activeElement.dataset.package, 'https://github.com/someone/investment-partner', 'the package card itself has focus');
    void w;
  });

  test('absent where it is not known, rather than a dead link', () => {
    assert.strictEqual(page().row('reading-list').querySelector('.ext-page-from'), null);
  });
});

describe('what it can send', () => {
  test('the switch asks, and does not move until the answer arrives', () => {
    const { row, sent } = page();
    const sw = row('investment-partner').querySelector('[role="switch"]');
    sw.click();
    assert.deepStrictEqual(sent, [{ type: 'set_extension_enabled', name: 'investment-partner', enabled: false }]);
  });

  test('no row sends an uninstall: the page offers none', () => {
    const { content, sent } = page();
    for (const button of content().querySelectorAll('.ext-page-row button')) {
      if (button.getAttribute('role') !== 'switch') button.click();
    }
    assert.ok(!sent.some((m) => /uninstall/.test(m.type)), 'removal happens only from a package card');
  });

  test('pause and resume go through the one stored switch, and a paused row keeps its own setting', () => {
    const { content, sent, reply } = page();
    content().querySelector('#ext-pause').click();
    assert.deepStrictEqual(sent, [{ type: 'set_extensions_all_off', off: true }]);
    reply({ type: 'extension_state', operation: 'set-all-off', allOff: true,
      extensions: EXTENSIONS.map((e) => (e.broken ? e : { ...e, enabled: false, allOff: true, ownEnabled: e.enabled })) });
    const banner = content().querySelector('.ext-paused-banner');
    assert.strictEqual(banner.querySelector('p').textContent, 'All extensions are paused. Each one goes back to its own setting when you resume.');
    const sw = content().querySelector('.ext-page-row[data-extension="investment-partner"] [role="switch"]');
    assert.deepStrictEqual([sw.getAttribute('aria-label'), sw.checked], ['investment-partner, paused', true]);
    sent.length = 0;
    banner.querySelector('button').click();
    assert.deepStrictEqual(sent, [{ type: 'set_extensions_all_off', off: false }]);
  });

  test('while paused, every switch is disabled in its own position and sends nothing; resumed, each is pressable again as it was', () => {
    const { content, sent, reply, w } = page();
    const switches = () => [...content().querySelectorAll('.ext-page-row [role="switch"]')]
      .map((sw) => [sw.closest('.ext-page-row').dataset.extension, sw.checked, sw.disabled]);
    const before = switches();
    assert.deepStrictEqual(before, [['investment-partner', true, false], ['reading-list', true, false], ['broken-sync', false, false]], 'running: none disabled');
    reply({ type: 'extension_state', operation: 'set-all-off', allOff: true,
      extensions: EXTENSIONS.map((e) => (e.broken ? e : { ...e, enabled: false, allOff: true, ownEnabled: e.enabled })) });
    assert.deepStrictEqual(switches(), [['investment-partner', true, true], ['reading-list', true, true], ['broken-sync', false, true]], 'paused: each keeps its own position, disabled');
    for (const r of content().querySelectorAll('.ext-page-row')) {
      const label = r.querySelector('.onoff-label');
      if (label) assert.match(label.textContent, /^(On|Off)$/);
    }
    sent.length = 0;
    for (const sw of content().querySelectorAll('.ext-page-row [role="switch"]')) sw.click();
    // The handler itself, reached without the browser's own refusal to click
    // a disabled control, still sends nothing.
    for (const sw of content().querySelectorAll('.ext-page-row [role="switch"]')) w.extensionsToggle(null, Number(sw.id.replace('ext-switch-', '')));
    assert.deepStrictEqual(sent, [], 'a paused switch sends nothing, pressed or called');
    reply({ type: 'extension_state', operation: 'set-all-off', allOff: false, extensions: EXTENSIONS });
    assert.deepStrictEqual(switches(), before, 'resumed: exactly what was there, pressable again');
  });

  test('every message the page can send is one it is allowed to, and none is about updates', () => {
    const types = new Set();
    for (const allOff of [false, true]) {
      const p = page({ allOff });
      const pressAll = () => {
        for (const el of [...p.content().querySelectorAll('button, [role="switch"]')]) {
          if (/Go to Packages|package$/.test(el.textContent) || el.closest('.ext-page-from')) continue;
          el.click();
        }
      };
      pressAll();
      p.reply({ type: 'packages_page', extensions: EXTENSIONS, receipts: RECEIPTS, packages: PACKAGES, allOff });
      pressAll();
      for (const m of p.sent) types.add(m.type);
      assert.doesNotMatch(p.content().textContent, /Check for update|Update to /);
    }
    assert.deepStrictEqual([...types].filter((t) => !V.SENDS.includes(t)), []);
    assert.ok(!types.has('check_extension_update') && !types.has('plan_extension_update'));
  });
});

describe('the rest', () => {
  test('an update the state already knows of is a link to Packages, on the left, never a control', () => {
    const { w, row } = page();
    w.packagesReplyArrived({ type: 'package_update_status', id: 'https://github.com/someone/reading-list', outcome: 'newer-available', newer: ['v0.5.0'], current: 'v0.4.2' });
    w.extensionsRenderIfVisible();
    const link = row('reading-list').querySelector('.ext-page-id .ext-page-update button');
    assert.strictEqual(link.textContent, 'Update available in Packages');
    assert.strictEqual(row('reading-list').querySelector('.ext-page-controls .ext-page-update'), null);
  });

  test('empty: the sentence and Go to Packages', () => {
    const { content, doc } = page({ extensions: [] });
    const empty = content().querySelector('.ext-page-empty');
    assert.match(empty.textContent, /^No extensions installed\. Add a package that includes an extension to see it here\./);
    assert.strictEqual(content().querySelector('.ext-pause'), null, 'nothing to pause');
    empty.querySelector('button').click();
    assert.strictEqual(doc.querySelector('.settings-nav-item.active').dataset.settings, 'packages');
  });
});

describe('the sidebar item', () => {
  const INDEX = read('public', 'index.html');
  const items = [...INDEX.matchAll(/<div class="settings-nav-item(?: active)?" data-settings="([\w-]+)"([^>]*)>([\s\S]*?)<\/div>/g)]
    .map((m) => ({ section: m[1], attrs: m[2], body: m[3] }));

  test('directly below Packages, with the Lucide Puzzle glyph rather than the Packages cube', () => {
    assert.ok(items.length >= 6, 'the sidebar walk found its items');
    const order = items.map((i) => i.section);
    assert.strictEqual(order.indexOf('extensions'), order.indexOf('packages') + 1);
    const ext = items.find((i) => i.section === 'extensions');
    assert.match(ext.body, /<path d="M15\.39 4\.39a1 1 0 0 0 1\.68-\.474/, 'the Puzzle path');
    assert.match(ext.body, /Extensions\s*$/);
    assert.notStrictEqual(ext.body.match(/<svg[\s\S]*<\/svg>/)[0], items.find((i) => i.section === 'packages').body.match(/<svg[\s\S]*<\/svg>/)[0]);
  });

  test('reachable from the keyboard, and Enter opens it', () => {
    const ext = items.find((i) => i.section === 'extensions');
    assert.match(ext.attrs, /tabindex="0"/);
    assert.match(ext.attrs, /role="button"/);
    assert.match(ext.attrs, /onkeydown="if\(event\.key==='Enter'\|\|event\.key===' '\)\{event\.preventDefault\(\);showSettingsSection\('extensions'\)\}"/);
  });

  test('the model the page draws with is loaded, after the manage model it reads', () => {
    const at = (f) => INDEX.indexOf(`<script src="/${f}"></script>`);
    assert.ok(at('extensions-view-model.js') > at('packages-manage-model.js') && at('packages-manage-model.js') > 0);
    assert.ok(at('extensions-view-model.js') < INDEX.indexOf('<script src="/views/settings.js"></script>'));
  });

  test('every reply for the shared manage state reaches the page as well as Packages', () => {
    const APP = read('public', 'app.js');
    const set = /const EXTENSIONS_PAGE_REPLIES = new Set\(\[([^\]]*)\]\);/.exec(APP);
    assert.ok(set, 'app.js no longer names the replies that redraw the Extensions page');
    const types = [...set[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    for (const type of ['packages_page', 'packages_page_error', 'extension_state', 'package_uninstall_result', 'extension_install_result', 'extensions']) {
      assert.ok(types.includes(type), type);
    }
    assert.match(APP, /if \(EXTENSIONS_PAGE_REPLIES\.has\(d\.type\) && typeof extensionsRenderIfVisible === 'function'\) queueMicrotask\(extensionsRenderIfVisible\);\n  switch\(d\.type\) \{/,
      'the redraw is queued at the top of the one dispatch, after which each reply has been handled');
  });
});
