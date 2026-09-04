'use strict';
// The extension host, held to its own written contract.
//
// The contract document is the authority and this file is what stops it
// being prose: the message table the host enforces is compared against the
// table the document publishes, both ways, so neither can grow or shrink
// alone. Every capability the document names has a test here that proves the
// enforcement rather than the intention, which is the difference between a
// sandbox and a sign that says sandbox.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');

let hostModule = null;
async function host() {
  if (!hostModule) hostModule = await import('../../public/extension-host.js');
  return hostModule;
}

function shell() {
  const dom = new JSDOM('<!doctype html><html><body><div id="pane"></div></body></html>', {
    runScripts: 'outside-only',
  });
  return { dom, doc: dom.window.document, pane: dom.window.document.getElementById('pane') };
}

const PAYLOAD = {
  entry: 'parent.postMessage({type:"ready"},"*");',
  styles: ['body { color: red; }'],
  resources: [{ id: 'notes', maximumBytes: 100 }],
};

// Mount with the frame's postMessage captured, so what the host says back to
// the extension is read off the wire rather than inferred.
async function mounted(opts = {}) {
  const { mountExtension } = await host();
  const { dom, pane } = shell();
  const sent = [];
  const degraded = [];
  const opened = [];
  const handle = mountExtension({
    paneElement: pane,
    payload: opts.payload || PAYLOAD,
    onOpen: (t) => opened.push(t),
    onDegrade: (reason) => degraded.push(reason),
    readyTimeoutMs: opts.readyTimeoutMs || 5000,
  });
  const frame = handle.frame();
  if (frame && frame.contentWindow) {
    frame.contentWindow.postMessage = (msg) => sent.push(msg);
  }
  const source = frame ? frame.contentWindow : null;
  // A genuine `message` event dispatched on the mounting window, so the real
  // addEventListener path is what carries it rather than a call into
  // handle.dispatch. This is the wire the criteria ask the refusal to be
  // proven on.
  function wire(data, from) {
    const ev = new dom.window.Event('message');
    ev.data = data;
    Object.defineProperty(ev, 'source', { value: from === undefined ? source : from });
    dom.window.dispatchEvent(ev);
  }
  return { dom, pane, handle, frame, source, sent, degraded, opened, wire };
}

describe('the contract document and the host agree on every message', () => {
  test('the table the document publishes is the table the host enforces, both ways', async () => {
    const { EXTENSION_MESSAGES, HOST_MESSAGES } = await host();
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'EXTENSION-HOST.md'), 'utf-8');
    // Each message row: the type, and the Shape cell it publishes.
    const rows = [...doc.matchAll(/^\| `([a-z]+)` \| `(\{ type[^`]*)`/gm)]
      .map((m) => ({ type: m[1], shape: m[2] }));
    const types = rows.map((r) => r.type).sort();
    assert.ok(rows.length >= 4, 'the parse found the document\'s message rows; an empty read is a broken instrument');
    assert.deepStrictEqual(Object.keys(EXTENSION_MESSAGES).sort(), types,
      'a message in one table and not the other is a capability the contract does not govern: '
      + 'edit docs/EXTENSION-HOST.md and EXTENSION_MESSAGES together');
    // Every field the document's Shape cell names for a type is a field the
    // host checks for that type, so the Shape column cannot promise a field
    // the mediator does not enforce.
    for (const { type, shape } of rows) {
      const declaredFields = [...shape.matchAll(/,\s*([a-z]+):/g)].map((m) => m[1]);
      for (const field of declaredFields) {
        assert.ok(Object.prototype.hasOwnProperty.call(EXTENSION_MESSAGES[type], field),
          `the document's shape for "${type}" names field "${field}" that the host does not check`);
      }
    }
    for (const hostType of HOST_MESSAGES) {
      assert.ok(doc.includes(`\`${hostType}\``),
        `the document never mentions the host-to-extension message "${hostType}"`);
    }
  });
});

describe('the frame is opaque-origin, and only that', () => {
  test('the sandbox grants scripts and nothing else, and the document carries the no-network policy', async () => {
    const { frame } = await mounted();
    assert.strictEqual(frame.getAttribute('sandbox'), 'allow-scripts',
      'allow-scripts alone is the whole posture: adding allow-same-origin would hand the frame the app\'s origin');
    assert.match(frame.srcdoc, /default-src 'none'/,
      'the frame document polices its own network to nothing');
    assert.match(frame.srcdoc, /window\.onerror/,
      'the bootstrap forwards uncaught failures, because an opaque frame cannot be observed from outside');
  });
});

describe('the mediator refuses what the contract does not name, on the wire', () => {
  test('an unknown type is refused with a reason, through the real event listener', async () => {
    const { wire, sent } = await mounted();
    wire({ type: 'steal-the-socket' });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].type, 'refused');
    assert.strictEqual(sent[0].of, 'steal-the-socket');
    assert.match(sent[0].reason, /contract names no message/);
  });

  test('a read or write is now an unnamed type, refused by the closed table', async () => {
    const { wire, sent } = await mounted();
    wire({ type: 'read', resource: 'notes' });
    wire({ type: 'write', resource: 'notes', content: 'x' });
    assert.strictEqual(sent.length, 2);
    assert.ok(sent.every((m) => m.type === 'refused'),
      'resource messages are absent from the contract, so the mediator refuses them like any other unnamed type');
  });

  test('a named type with the wrong field shape is refused naming the field', async () => {
    const { wire, sent } = await mounted();
    wire({ type: 'resize', height: 'very tall' });
    assert.strictEqual(sent[0].type, 'refused');
    assert.match(sent[0].reason, /"height"/);
  });

  test('every named field is enforced: a wrong-shaped open target is refused', async () => {
    const { wire, sent } = await mounted();
    wire({ type: 'open', target: '' });
    assert.strictEqual(sent[0].type, 'refused');
    assert.match(sent[0].reason, /"target"/);
  });

  test('a message from a window that is not the live frame is ignored entirely', async () => {
    const { wire, sent } = await mounted();
    wire({ type: 'ready' }, {});
    assert.strictEqual(sent.length, 0,
      'not even a refusal: replying to an unknown window would teach it the host is listening');
  });

  test('ready is answered with init over the wire, and the watchdog stands down', async () => {
    const { wire, handle, sent } = await mounted({ readyTimeoutMs: 30 });
    wire({ type: 'ready' });
    assert.deepStrictEqual(sent, [{ type: 'init' }]);
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(handle.alive(), true, 'a view that said ready is not torn down by the clock');
  });

  test('resize is clamped to the published bounds, never trusted raw', async () => {
    const mod = await host();
    const { wire, frame } = await mounted();
    wire({ type: 'resize', height: 1 });
    assert.strictEqual(frame.style.height, `${mod.MIN_FRAME_HEIGHT}px`,
      'a height below the floor is raised to it');
    wire({ type: 'resize', height: 10000000 });
    assert.strictEqual(frame.style.height, `${mod.MAX_FRAME_HEIGHT}px`,
      'a height above the ceiling is lowered to it');
  });

  test('open passes the target to the opener and navigates nothing itself', async () => {
    const { wire, opened } = await mounted();
    wire({ type: 'open', target: 'Projects/plan.md' });
    assert.deepStrictEqual(opened, ['Projects/plan.md']);
  });

  test('after teardown the real listener is gone from the window, not merely inert', async () => {
    // Count the window's message listeners directly, so this proves the
    // removeEventListener ran rather than proving the alive guard also
    // blocks a late message (which it does, but that is a second belt): a
    // teardown that left the listener bound would leak one per mount.
    const { mountExtension } = await host();
    const { dom, pane } = shell();
    let bound = 0;
    const realAdd = dom.window.addEventListener.bind(dom.window);
    const realRemove = dom.window.removeEventListener.bind(dom.window);
    dom.window.addEventListener = (type, fn) => { if (type === 'message') bound += 1; realAdd(type, fn); };
    dom.window.removeEventListener = (type, fn) => { if (type === 'message') bound -= 1; realRemove(type, fn); };
    const handle = mountExtension({ paneElement: pane, payload: PAYLOAD, onDegrade() {} });
    assert.strictEqual(bound, 1, 'the mount bound exactly one message listener');
    handle.teardown();
    assert.strictEqual(bound, 0, 'and teardown unbound it, so nothing is left listening on the window');
  });
});

describe('a misbehaving view degrades to the plain rendering, named', () => {
  test('a view that never says ready is torn down with the timeout named', async () => {
    const { handle, pane, degraded } = await mounted({ readyTimeoutMs: 15 });
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(degraded.length, 1);
    assert.match(degraded[0], /did not start within 15ms/);
    assert.strictEqual(pane.querySelector('iframe'), null, 'the hung frame left the page');
    assert.strictEqual(handle.alive(), false);
  });

  test('a reported error tears the frame down with the message named', async () => {
    const { handle, source, pane, degraded } = await mounted();
    handle.dispatch({ source, data: { type: 'error', message: 'exploded on line 3' } });
    assert.strictEqual(degraded.length, 1);
    assert.match(degraded[0], /exploded on line 3/);
    assert.strictEqual(pane.querySelector('iframe'), null);
  });

  test('a mount that cannot be built degrades instead of throwing', async () => {
    const { mountExtension } = await host();
    const { doc } = shell();
    const degraded = [];
    const brokenPane = doc.createElement('div');
    brokenPane.appendChild = () => { throw new Error('no room'); };
    const handle = mountExtension({
      paneElement: brokenPane, payload: PAYLOAD,
      onDegrade: (reason) => degraded.push(reason),
    });
    assert.strictEqual(degraded.length, 1);
    assert.match(degraded[0], /could not be mounted/);
    assert.strictEqual(handle.alive(), false);
  });

  test('a host with nowhere to fall back to is refused at the door', async () => {
    const { mountExtension } = await host();
    const { pane } = shell();
    assert.throws(() => mountExtension({ paneElement: pane, payload: PAYLOAD }),
      /requires onDegrade/);
  });

  test('the failure handle is the same shape as a live one, so a caller need not know which it holds', async () => {
    const { mountExtension } = await host();
    const { doc } = shell();
    const brokenPane = doc.createElement('div');
    brokenPane.appendChild = () => { throw new Error('no room'); };
    const handle = mountExtension({ paneElement: brokenPane, payload: PAYLOAD, onDegrade() {} });
    assert.strictEqual(typeof handle.frame, 'function', 'frame is an accessor on both paths');
    assert.strictEqual(handle.frame(), null, 'and answers null after a failed mount');
    assert.strictEqual(handle.swap(null), null, 'swap answers null the way the live handle does');
    assert.doesNotThrow(() => { handle.teardown(); handle.dispatch({}); });
  });
});

describe('the mount survives update and uninstall mid-session', () => {
  test('a swap tears the old frame down and a late message from it is ignored', async () => {
    const first = await mounted();
    const oldSource = first.source;
    const oldSent = first.sent;
    const next = first.handle.swap({ entry: 'parent.postMessage({type:"ready"},"*");', styles: ['body{color:blue}'] });
    assert.ok(next, 'an update mounts the new payload');
    assert.strictEqual(first.pane.querySelectorAll('iframe').length, 1,
      'exactly one frame on the page: the old one left when the new one arrived');
    assert.notStrictEqual(next.frame(), first.frame);
    assert.match(next.frame().srcdoc, /color:blue/,
      'the new frame carries the new payload, so an update is a real version swap and not the old frame renamed');
    next.dispatch({ source: oldSource, data: { type: 'ready' } });
    assert.strictEqual(oldSent.length, 0,
      'the old frame\'s window stopped being the live source at teardown, so its messages fall on nothing');
    next.teardown();
    assert.strictEqual(first.pane.querySelector('iframe'), null, 'an uninstall leaves no frame behind');
  });
});

describe('the server reads installations and guards every payload path', () => {
  function workspace(fixture) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-reg-'));
    for (const [rel, content] of Object.entries(fixture)) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    return dir;
  }
  const registry = require('../../lib/packages/extension-registry.js');

  const MANIFEST = JSON.stringify({
    schemaVersion: 1, id: 'charts', name: 'Charts', version: '1.0.0',
    renderers: [{ id: 'chart', target: '.chart', entry: 'ui/index.js', styles: ['ui/chart.css'] }],
    resources: [{ id: 'data', maximumBytes: 1024 }],
  });

  test('installed extensions list with renderers, and a broken manifest says so', () => {
    const dir = workspace({
      '.rundock/plugins/charts/manifest.json': MANIFEST,
      '.rundock/plugins/mangled/manifest.json': 'not json at all',
      '.rundock/plugin-state.json': JSON.stringify({ plugins: { charts: { enabled: true } } }),
    });
    try {
      const list = registry.listExtensions(dir);
      assert.strictEqual(list.length, 2);
      const charts = list.find((e) => e.id === 'charts');
      assert.deepStrictEqual(charts.renderers, [{ id: 'chart', target: '.chart' }]);
      const mangled = list.find((e) => e.id === 'mangled');
      assert.strictEqual(mangled.broken, true, 'an installation that stopped parsing is a fact, not a blank');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a payload reads its entry and styles from inside the extension directory', () => {
    const dir = workspace({
      '.rundock/plugins/charts/manifest.json': MANIFEST,
      '.rundock/plugins/charts/ui/index.js': 'draw();',
      '.rundock/plugins/charts/ui/chart.css': '.c{}',
    });
    try {
      const p = registry.uiPayload(dir, 'charts', 'chart');
      assert.strictEqual(p.ok, true);
      assert.strictEqual(p.entry, 'draw();');
      assert.deepStrictEqual(p.styles, ['.c{}']);
      assert.deepStrictEqual(p.resources, [{ id: 'data', maximumBytes: 1024 }]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('an entry that resolves outside the extension directory is refused, spelled any way', () => {
    const escaping = JSON.stringify({
      schemaVersion: 1, id: 'thief', renderers: [{ id: 'r', target: '.x', entry: '../../../secrets.txt' }],
    });
    const dir = workspace({
      '.rundock/plugins/thief/manifest.json': escaping,
      'secrets.txt': 'the workspace\'s own file',
    });
    try {
      const p = registry.uiPayload(dir, 'thief', 'r');
      assert.strictEqual(p.ok, false);
      assert.match(p.reason, /inside the extension's own directory/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('an extension id that is not an installed-directory name is refused before any read', () => {
    const p = registry.uiPayload('/nowhere', '../escape', 'r');
    assert.strictEqual(p.ok, false);
    assert.match(p.reason, /not an installed-directory name/);
  });

  test('a manifest whose renderers is not an array is refused, not raised on', () => {
    const dir = workspace({
      '.rundock/plugins/corrupt/manifest.json': JSON.stringify({
        schemaVersion: 1, id: 'corrupt', renderers: { chart: 'ui/index.js' },
      }),
    });
    try {
      const p = registry.uiPayload(dir, 'corrupt', 'chart');
      assert.strictEqual(p.ok, false);
      assert.match(p.reason, /no renderers array/,
        'a hostile or corrupt manifest cannot make the server raise');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
