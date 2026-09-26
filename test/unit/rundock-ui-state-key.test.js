'use strict';
// Rundock UI's table keeps its widths in the view's own state: with `resizable: true` and
// `stateKey`, the table reads `rui.table.<stateKey>` from Rundock.viewState
// when it is created and writes it on each resize and reset. With no
// stateKey it never touches Rundock.viewState, and where Rundock.viewState is
// absent a stateKey changes nothing. The library runs from its source text,
// as a frame gets it, beside a stand-in for the bootstrap's Rundock.viewState.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

async function fresh({ viewState } = {}) {
  const { rundockUiScript } = await import('../../public/rundock-ui-frame.js');
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  // What the host's bootstrap leaves before the library runs: a namespace
  // holding a frozen viewState.
  if (viewState) Object.defineProperty(win, 'Rundock', { value: { viewState: Object.freeze(viewState) }, enumerable: true });
  win.eval(rundockUiScript());
  const root = win.document.getElementById('root');
  const mount = (node) => { root.appendChild(node); return node; };
  const key = (target, k, extra = {}) => target.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
  return { win, ui: win.Rundock.ui, mount, key };
}

// A stand-in for Rundock.viewState that records every call.
function store(initial = {}) {
  const kept = JSON.parse(JSON.stringify(initial));
  const calls = [];
  return {
    calls, kept,
    get: (k) => { calls.push(['get', k]); return kept[k]; },
    set: (k, v) => { calls.push(['set', k, v === undefined ? undefined : JSON.parse(JSON.stringify(v))]); if (v === undefined) delete kept[k]; else kept[k] = v; },
  };
}
const COLUMNS = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }];
const ROWS = [{ a: 1, b: 2 }];

describe('stateKey is a key', () => {
  test('a stateKey that would not make a valid key is refused by name; 54 characters is the most', async () => {
    const { ui } = await fresh({ viewState: store() });
    for (const bad of ['', 'a b', 'a/b', 'k'.repeat(55), 7, {}]) {
      assert.throws(() => ui.table({ resizable: true, stateKey: bad, columns: COLUMNS, rows: ROWS }), /Rundock\.ui\.table: stateKey must be/);
    }
    ui.table({ resizable: true, stateKey: 'k'.repeat(54), columns: COLUMNS, rows: ROWS });
    ui.table({ resizable: true, stateKey: 'positions.v2:x-y_z', columns: COLUMNS, rows: ROWS });
  });
});

describe('widths are kept under rui.table.<stateKey>', () => {
  test('a kept width is where the column starts, and each key step writes the whole map', async () => {
    const s = store({ 'rui.table.positions': { a: 200 } });
    const { ui, mount, key } = await fresh({ viewState: s });
    const heard = [];
    const t = mount(ui.table({ resizable: true, stateKey: 'positions', columns: COLUMNS, rows: ROWS, onResize: (c) => heard.push({ ...c }) }));
    assert.deepStrictEqual(s.calls, [['get', 'rui.table.positions']], 'read once, when the table is created');
    const [ha, hb] = t.querySelectorAll('.rui-col-resize');
    key(ha, 'ArrowRight');
    assert.deepStrictEqual(heard, [{ key: 'a', width: 208 }], 'the kept width, plus one step');
    key(hb, 'ArrowRight');
    assert.deepStrictEqual(s.calls.slice(1), [
      ['set', 'rui.table.positions', { a: 208 }],
      ['set', 'rui.table.positions', { a: 208, b: heard[1].width }],
    ]);
  });

  test('a reset removes the column\'s entry, and the last reset removes the key', async () => {
    const s = store({ 'rui.table.positions': { a: 200, b: 150 } });
    const { ui, mount, key } = await fresh({ viewState: s });
    const t = mount(ui.table({ resizable: true, stateKey: 'positions', columns: COLUMNS, rows: ROWS }));
    const [ha, hb] = t.querySelectorAll('.rui-col-resize');
    key(ha, 'Enter');
    key(hb, 'Enter');
    assert.deepStrictEqual(s.calls.slice(1), [
      ['set', 'rui.table.positions', { b: 150 }],
      ['set', 'rui.table.positions', undefined],
    ]);
  });

  test('another table\'s entry, and anything the view keeps itself, are left as they were', async () => {
    const s = store({ 'rui.table.other': { a: 99 }, tab: 'b' });
    const { ui, mount, key } = await fresh({ viewState: s });
    const t = mount(ui.table({ resizable: true, stateKey: 'positions', columns: COLUMNS, rows: ROWS }));
    key(t.querySelector('.rui-col-resize'), 'ArrowRight');
    assert.deepStrictEqual(s.kept['rui.table.other'], { a: 99 });
    assert.strictEqual(s.kept.tab, 'b');
    assert.deepStrictEqual(s.calls.filter((c) => c[0] === 'set').map((c) => c[1]), ['rui.table.positions']);
  });
});

describe('a kept width is a saved width, never below the column\'s floor', () => {
  test('a kept width below minWidth opens at minWidth', async () => {
    const s = store({ 'rui.table.positions': { a: 50 } });
    const { ui, mount, key } = await fresh({ viewState: s });
    const heard = [];
    const t = mount(ui.table({ resizable: true, stateKey: 'positions', columns: [{ key: 'a', label: 'A', minWidth: 120 }, COLUMNS[1]], rows: ROWS, onResize: (c) => heard.push({ ...c }) }));
    key(t.querySelector('.rui-col-resize'), 'ArrowRight');
    assert.deepStrictEqual(heard, [{ key: 'a', width: 128 }]);
  });

  test('a kept width that is not a positive number, or for a column that does not resize, is not used', async () => {
    const without = await fresh({ viewState: store() });
    const plain = [];
    const t0 = without.mount(without.ui.table({ resizable: true, stateKey: 'positions', columns: COLUMNS, rows: ROWS, onResize: (c) => plain.push({ ...c }) }));
    without.key(t0.querySelector('.rui-col-resize'), 'ArrowRight');
    for (const bad of [-5, 0, '300', null, [300], { px: 300 }]) {
      const s = store({ 'rui.table.positions': { a: bad } });
      const { ui, mount, key } = await fresh({ viewState: s });
      const heard = [];
      const t = mount(ui.table({ resizable: true, stateKey: 'positions', columns: COLUMNS, rows: ROWS, onResize: (c) => heard.push({ ...c }) }));
      key(t.querySelector('.rui-col-resize'), 'ArrowRight');
      assert.deepStrictEqual(heard, plain, JSON.stringify(bad));
    }
    const s = store({ 'rui.table.positions': 'not a map' });
    const { ui } = await fresh({ viewState: s });
    ui.table({ resizable: true, stateKey: 'positions', columns: COLUMNS, rows: ROWS });
    const fixed = store({ 'rui.table.positions': { a: 300 } });
    const f = await fresh({ viewState: fixed });
    const heard = [];
    const t = f.mount(f.ui.table({ resizable: true, stateKey: 'positions', columns: [{ key: 'a', label: 'A', resizable: false }, COLUMNS[1]], rows: ROWS, onResize: (c) => heard.push({ ...c }) }));
    assert.strictEqual(t.querySelectorAll('.rui-col-resize').length, 1, 'only b resizes');
    f.key(t.querySelector('.rui-col-resize'), 'ArrowRight');
    assert.notStrictEqual(t.querySelector('colgroup').children[0].style.width, '300px', 'a column that does not resize is not fixed by a kept width');
  });
});

describe('without a stateKey, or without Rundock.viewState, nothing changes', () => {
  const drive = async (opts) => {
    const { ui, mount, key } = await fresh(opts.env);
    const heard = [];
    const t = mount(ui.table({ resizable: true, columns: COLUMNS, rows: ROWS, onResize: (c) => heard.push({ ...c }), ...opts.table }));
    const handle = t.querySelector('.rui-col-resize');
    key(handle, 'ArrowRight');
    key(handle, 'ArrowRight', { shiftKey: true });
    key(handle, 'Enter');
    return heard;
  };

  test('a table with no stateKey never reads or writes view state', async () => {
    const untouchable = { get() { throw new Error('read'); }, set() { throw new Error('written'); } };
    const heard = await drive({ env: { viewState: untouchable }, table: {} });
    assert.strictEqual(heard.length, 3);
  });

  test('where Rundock.viewState is absent, a stateKey behaves exactly as none', async () => {
    const withKey = await drive({ env: {}, table: { stateKey: 'positions' } });
    const withoutKey = await drive({ env: {}, table: {} });
    assert.deepStrictEqual(withKey, withoutKey);
  });
});
