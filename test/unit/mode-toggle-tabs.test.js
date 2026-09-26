'use strict';
// Settings' mode toggle is a WAI-ARIA tablist, the same pattern as Rundock
// UI's tabs: rendered by the real settings view and driven with real keys.
const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><body><div id="settings-content"></div></body>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.esc = (t) => { const d = document.createElement('div'); d.textContent = t == null ? '' : String(t); return d.innerHTML; };
global.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
global.WebSocket = { OPEN: 1 };
global.workspaceMode = 'knowledge';
global.sandboxManaged = true;
// Only the mode requests: rendering the pane also asks for its lists.
const sent = [];
global.ws = { readyState: 1, send: (s) => { const m = JSON.parse(s); if (m.type === 'set_workspace_mode') sent.push(m); } };

const settings = require('../../public/views/settings.js');
global.modeToggleKeydown = settings.modeToggleKeydown;

function render(mode) {
  global.workspaceMode = mode;
  settings.renderSettingsSection('permissions');
  const list = document.querySelector('.mode-toggle');
  // Inline handlers do not run in jsdom's default mode, so the one the
  // markup names is wired the way the browser would call it.
  assert.match(list.getAttribute('onkeydown'), /^modeToggleKeydown\(event\)$/);
  list.addEventListener('keydown', (event) => settings.modeToggleKeydown(event));
  return { list, tabs: [...list.querySelectorAll('[role=tab]')] };
}
const key = (target, k) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const state = (tabs) => tabs.map((t) => `${t.getAttribute('aria-selected')}/${t.tabIndex}`);

describe('the mode toggle', () => {
  before(() => { sent.length = 0; });

  test('is a named tablist whose selected mode is the one tab stop', () => {
    const { list, tabs } = render('knowledge');
    assert.strictEqual(list.getAttribute('role'), 'tablist');
    assert.strictEqual(list.getAttribute('aria-label'), 'What are you working on?');
    assert.deepStrictEqual(tabs.map((t) => t.dataset.mode), ['notes', 'code']);
    assert.deepStrictEqual(state(tabs), ['true/0', 'false/-1']);
    assert.deepStrictEqual(state(render('code').tabs), ['false/-1', 'true/0']);
  });

  test('ArrowRight selects the next mode, asks the server, and keeps focus through the re-render', () => {
    sent.length = 0;
    const { tabs } = render('knowledge');
    tabs[0].focus();
    key(tabs[0], 'ArrowRight');
    assert.deepStrictEqual(state(tabs), ['false/-1', 'true/0']);
    assert.strictEqual(document.activeElement, tabs[1]);
    assert.deepStrictEqual(sent, [{ type: 'set_workspace_mode', mode: 'code' }]);
    // The server answers by re-rendering the pane; focus lands on the tab
    // the key chose, not on the body.
    const again = render('code');
    assert.strictEqual(document.activeElement, again.tabs[1]);
  });

  test('ArrowLeft wraps, and Home and End jump to the ends', () => {
    sent.length = 0;
    const { tabs } = render('knowledge');
    tabs[0].focus();
    key(tabs[0], 'ArrowLeft');
    assert.strictEqual(document.activeElement, tabs[1], 'wraps from the first to the last');
    key(tabs[1], 'Home');
    assert.strictEqual(document.activeElement, tabs[0]);
    key(tabs[0], 'End');
    assert.strictEqual(document.activeElement, tabs[1]);
    assert.deepStrictEqual(sent.map((m) => m.mode), ['code', 'notes', 'code']);
  });

  test('other keys do nothing', () => {
    sent.length = 0;
    const { tabs } = render('knowledge');
    tabs[0].focus();
    key(tabs[0], 'ArrowDown');
    assert.deepStrictEqual(state(tabs), ['true/0', 'false/-1']);
    assert.deepStrictEqual(sent, []);
  });
});
