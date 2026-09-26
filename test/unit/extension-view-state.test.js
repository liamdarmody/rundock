'use strict';
// Extension view state, the host's half: one frame-to-host message,
// `setState { state }`, and one field on `init`. The host names nothing on
// disk: it hands the seam the state alone, and the seam adds the extension
// and the note from its mount. Every shape and cap is checked here before
// anything leaves the page, and again by the server.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

let hostModule = null;
async function host() {
  if (!hostModule) hostModule = await import('../../public/extension-host.js');
  return hostModule;
}

const PAYLOAD = { entry: 'parent.postMessage({type:"ready"},"*");', styles: [] };

// A mount with the frame's postMessage captured and every state the host
// hands the seam recorded. `wire` dispatches a genuine message event from the
// frame's window, so the real listener carries it.
async function mounted(opts = {}) {
  const { mountExtension } = await host();
  const dom = new JSDOM('<!doctype html><html><body><div id="pane"></div></body></html>', { runScripts: 'outside-only' });
  dom.window.RundockNamedSources = require('../../public/named-sources-model.js');
  const sent = [];
  const states = [];
  const degraded = [];
  const handle = mountExtension({
    paneElement: dom.window.document.getElementById('pane'),
    payload: opts.payload || PAYLOAD,
    path: 'Dash.md',
    content: '# D\n',
    onDegrade: (reason) => degraded.push(reason),
    onState: (...args) => states.push(args),
    ...(opts.embedded ? { embedded: true } : {}),
    ...('state' in opts ? { state: opts.state } : {}),
  });
  const frame = handle.frame();
  frame.contentWindow.postMessage = (msg) => sent.push(msg);
  const source = frame.contentWindow;
  function wire(data, from) {
    const ev = new dom.window.Event('message');
    ev.data = data;
    Object.defineProperty(ev, 'source', { value: from === undefined ? source : from });
    dom.window.dispatchEvent(ev);
  }
  wire({ type: 'ready' });
  const init = sent.shift();
  return { dom, handle, frame, sent, states, degraded, wire, init };
}

describe('the wire', () => {
  test('setState carries exactly one field, the state, and init carries it back', async () => {
    const { EXTENSION_MESSAGES, HOST_MESSAGE_FIELDS } = await host();
    assert.deepStrictEqual(Object.keys(EXTENSION_MESSAGES.setState), ['state']);
    assert.ok(HOST_MESSAGE_FIELDS.init.includes('state'));
  });

  test('fields naming another extension, note or file are never read: the seam is handed the state and nothing else', async () => {
    const { states, sent, wire } = await mounted();
    wire({ type: 'setState', state: { 'rui.table.positions': { account: 180 } }, extension: 'risk-board', path: 'Other.md', file: '../../x.json' });
    assert.deepStrictEqual(states, [[{ 'rui.table.positions': { account: 180 } }]]);
    assert.deepStrictEqual(sent, [], 'an accepted write says nothing');
  });

  test('init carries the state handed to the mount, or null', async () => {
    assert.strictEqual((await mounted()).init.state, null);
    assert.strictEqual((await mounted({ state: null })).init.state, null);
    assert.deepStrictEqual((await mounted({ state: { tab: 'b' } })).init.state, { tab: 'b' });
  });

  test('a stored state that fails any check is never handed to a view', async () => {
    const deep = JSON.parse('{"a":'.repeat(16) + '{}' + '}'.repeat(16));
    for (const bad of [{ d: new Date(0) }, { s: 'x'.repeat(70000) }, deep, [1], 'x', 3]) {
      assert.strictEqual((await mounted({ state: bad })).init.state, null, JSON.stringify(bad).slice(0, 30));
    }
  });

  test('a state that is not an object is refused by the table with its shape named', async () => {
    const { states, sent, wire } = await mounted();
    for (const state of [undefined, null, 'x', 3, [1]]) wire({ type: 'setState', state });
    assert.strictEqual(states.length, 0);
    assert.strictEqual(sent.length, 5);
    for (const m of sent) assert.strictEqual(m.of, 'setState');
  });
});

describe('plain JSON only, and the caps, before anything leaves the page', () => {
  class Box { constructor() { this.v = 1; } }
  const cyclic = { a: {} };
  cyclic.a.back = cyclic;
  const holey = [1, , 2]; // eslint-disable-line no-sparse-arrays
  const named = [1, 2];
  named.extra = 3;
  const cases = [
    [{ settings: { since: new Date(0) } }, 'the view state is not plain JSON: a Date at settings.since'],
    [{ m: new Map() }, 'the view state is not plain JSON: a Map at m'],
    [{ s: new Set() }, 'the view state is not plain JSON: a Set at s'],
    [{ t: new Uint8Array(2) }, 'the view state is not plain JSON: a Uint8Array at t'],
    [{ r: /x/ }, 'the view state is not plain JSON: a RegExp at r'],
    [{ b: new Blob(['x']) }, 'the view state is not plain JSON: a Blob at b'],
    [{ a: [1, undefined] }, 'the view state is not plain JSON: undefined at a.1'],
    [{ a: holey }, 'the view state is not plain JSON: undefined at a.1'],
    [{ a: named }, 'the view state is not plain JSON: an array with named entries at a'],
    [{ n: NaN }, 'the view state is not plain JSON: a number that is not finite at n'],
    [{ n: Infinity }, 'the view state is not plain JSON: a number that is not finite at n'],
    [{ b: new Box() }, 'the view state is not plain JSON: an object that is not plain at b'],
    [cyclic, 'the view state is not plain JSON: a cycle at a.back'],
    [{ big: 10n }, 'the view state is not plain JSON: a bigint at big'],
    [new Date(0), 'the view state is not plain JSON: a Date'],
  ];
  for (const [state, reason] of cases) {
    test(reason, async () => {
      const { states, sent, wire } = await mounted();
      wire({ type: 'setState', state });
      assert.deepStrictEqual(sent, [{ type: 'refused', of: 'setState', reason }]);
      assert.deepStrictEqual(states, [], 'nothing reached the seam');
    });
  }

  test('16 levels deep is handed on; 17 is refused', async () => {
    const nest = (n) => { let v = {}; for (let i = 1; i < n; i += 1) v = { v }; return v; };
    const { states, sent, wire } = await mounted();
    wire({ type: 'setState', state: nest(16) });
    wire({ type: 'setState', state: nest(17) });
    assert.strictEqual(states.length, 1);
    assert.deepStrictEqual(sent, [{ type: 'refused', of: 'setState', reason: `the view state is not plain JSON: more than 16 levels deep at ${Array(16).fill('v').join('.')}` }]);
  });

  test('64 KB of serialised state, counted in UTF-8 bytes, is handed on; one byte more is refused', async () => {
    const { VIEW_STATE_MAX_BYTES } = await host();
    assert.strictEqual(VIEW_STATE_MAX_BYTES, 65536);
    const sized = (bytes) => ({ s: 'x'.repeat(bytes - Buffer.byteLength('{"s":""}')) });
    const { states, sent, wire } = await mounted();
    wire({ type: 'setState', state: sized(65536) });
    wire({ type: 'setState', state: sized(65537) });
    wire({ type: 'setState', state: { s: '€'.repeat(21845) } }); // 65,543 bytes, 21,853 characters
    assert.strictEqual(states.length, 1);
    assert.deepStrictEqual(sent.map((m) => m.reason), ['the view state is larger than 64 KB', 'the view state is larger than 64 KB']);
  });
});

describe('who may write', () => {
  test('an embedded view reads its state and every setState from it is refused, named', async () => {
    const { init, states, sent, wire } = await mounted({ embedded: true, state: { tab: 'b' } });
    assert.deepStrictEqual(init.state, { tab: 'b' });
    wire({ type: 'setState', state: { tab: 'c' } });
    assert.deepStrictEqual(states, []);
    assert.deepStrictEqual(sent, [{ type: 'refused', of: 'setState', reason: 'an embedded view cannot keep view state; open this file to change it' }]);
  });

  test('a torn-down mount hands on nothing, and a message from another window is ignored', async () => {
    const { handle, states, sent, wire, dom } = await mounted();
    wire({ type: 'setState', state: { k: 1 } }, dom.window);
    const frame = handle.frame();
    handle.teardown();
    wire({ type: 'setState', state: { k: 2 } }, frame.contentWindow);
    assert.deepStrictEqual(states, []);
    assert.deepStrictEqual(sent, []);
  });
});

describe('a refusal from the server reaches the view', () => {
  test('refuseState posts refused of setState to the live view, and nothing once it is gone', async () => {
    const { handle, sent } = await mounted();
    handle.refuseState("this extension's view state is over its limit");
    assert.deepStrictEqual(sent, [{ type: 'refused', of: 'setState', reason: "this extension's view state is over its limit" }]);
    handle.teardown();
    handle.refuseState('again');
    assert.strictEqual(sent.length, 1);
  });

  test('a reason that is not a string is not passed on', async () => {
    const { handle, sent } = await mounted();
    handle.refuseState({ toString: () => 'x' });
    assert.deepStrictEqual(sent, []);
  });
});
