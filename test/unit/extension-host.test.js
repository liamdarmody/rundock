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
    readResource: opts.readResource,
    writeResource: opts.writeResource,
    readyTimeoutMs: opts.readyTimeoutMs || 5000,
  });
  const frame = handle.frame();
  if (frame && frame.contentWindow) {
    frame.contentWindow.postMessage = (msg) => sent.push(msg);
  }
  const source = frame ? frame.contentWindow : null;
  return { dom, pane, handle, frame, source, sent, degraded, opened };
}

describe('the contract document and the host agree on every message', () => {
  test('the table the document publishes is the table the host enforces, both ways', async () => {
    const { EXTENSION_MESSAGES, HOST_MESSAGES } = await host();
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'EXTENSION-HOST.md'), 'utf-8');
    const rows = [...doc.matchAll(/^\| `([a-z]+)` \| `\{ type/gm)].map((m) => m[1]).sort();
    assert.ok(rows.length >= 4, 'the parse found the document\'s message rows; an empty read is a broken instrument');
    assert.deepStrictEqual(Object.keys(EXTENSION_MESSAGES).sort(), rows,
      'a message in one table and not the other is a capability the contract does not govern: '
      + 'edit docs/EXTENSION-HOST.md and EXTENSION_MESSAGES together');
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
  test('an unknown type is refused with a reason', async () => {
    const { handle, source, sent } = await mounted();
    handle.dispatch({ source, data: { type: 'steal-the-socket' } });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].type, 'refused');
    assert.strictEqual(sent[0].of, 'steal-the-socket');
    assert.match(sent[0].reason, /contract names no message/);
  });

  test('a named type with the wrong field shape is refused naming the field', async () => {
    const { handle, source, sent } = await mounted();
    handle.dispatch({ source, data: { type: 'resize', height: 'very tall' } });
    assert.strictEqual(sent[0].type, 'refused');
    assert.match(sent[0].reason, /"height"/);
  });

  test('a message from a window that is not the live frame is ignored entirely', async () => {
    const { handle, sent } = await mounted();
    handle.dispatch({ source: {}, data: { type: 'ready' } });
    assert.strictEqual(sent.length, 0,
      'not even a refusal: replying to an unknown window would teach it the host is listening');
  });

  test('ready is answered with init, and the watchdog stands down', async () => {
    const { handle, source, sent } = await mounted({ readyTimeoutMs: 30 });
    handle.dispatch({ source, data: { type: 'ready' } });
    assert.deepStrictEqual(sent, [{ type: 'init' }]);
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(handle.alive(), true, 'a view that said ready is not torn down by the clock');
  });

  test('a declared resource reads and an undeclared one is refused', async () => {
    const reads = [];
    const { handle, source, sent } = await mounted({
      readResource: (id) => { reads.push(id); return Promise.resolve('the notes'); },
    });
    handle.dispatch({ source, data: { type: 'read', resource: 'notes' } });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepStrictEqual(reads, ['notes']);
    assert.deepStrictEqual(sent[0], { type: 'resource', resource: 'notes', content: 'the notes' });

    handle.dispatch({ source, data: { type: 'read', resource: 'the-whole-disk' } });
    assert.strictEqual(sent[1].type, 'refused');
    assert.match(sent[1].reason, /declares no resource/);
  });

  test('a write over the declared cap is refused naming the cap', async () => {
    const writes = [];
    const { handle, source, sent } = await mounted({
      writeResource: (id, content) => writes.push([id, content]),
    });
    handle.dispatch({ source, data: { type: 'write', resource: 'notes', content: 'x'.repeat(101) } });
    assert.strictEqual(sent[0].type, 'refused');
    assert.match(sent[0].reason, /capped at 100 bytes/);
    assert.deepStrictEqual(writes, [], 'nothing reached the writer');

    handle.dispatch({ source, data: { type: 'write', resource: 'notes', content: 'small' } });
    assert.deepStrictEqual(writes, [['notes', 'small']]);
  });

  test('open passes the target to the opener and navigates nothing itself', async () => {
    const { handle, source, opened } = await mounted();
    handle.dispatch({ source, data: { type: 'open', target: 'Projects/plan.md' } });
    assert.deepStrictEqual(opened, ['Projects/plan.md']);
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
});

describe('the mount survives update and uninstall mid-session', () => {
  test('a swap tears the old frame down and a late message from it is ignored', async () => {
    const first = await mounted();
    const oldSource = first.source;
    const oldSent = first.sent;
    const next = first.handle.swap({ entry: 'parent.postMessage({type:"ready"},"*");' });
    assert.ok(next, 'an update mounts the new payload');
    assert.strictEqual(first.pane.querySelectorAll('iframe').length, 1,
      'exactly one frame on the page: the old one left when the new one arrived');
    assert.notStrictEqual(next.frame(), first.frame);
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
});
