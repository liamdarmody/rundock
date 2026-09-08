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

function shell(bodyClass = '') {
  const dom = new JSDOM(`<!doctype html><html><body class="${bodyClass}"><div id="pane"></div></body></html>`, {
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
  const { dom, pane } = shell(opts.bodyClass);
  const sent = [];
  const degraded = [];
  const opened = [];
  const handle = mountExtension({
    paneElement: pane,
    payload: opts.payload || PAYLOAD,
    path: opts.path === undefined ? 'notes/q3.chart' : opts.path,
    content: opts.content === undefined ? 'a,b\n1,2\n' : opts.content,
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

// The document's message rows, one list per table. A table starts at its
// header row; the first is what an extension may say to the host, the second
// what the host says to an extension. Each row: the type and the Shape cell.
function documentTables() {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'EXTENSION-HOST.md'), 'utf-8');
  const tables = [];
  for (const line of doc.split('\n')) {
    if (/^\| Type \|/.test(line)) { tables.push([]); continue; }
    const m = /^\| `([a-z]+)` \| `(\{ type[^`]*)`/.exec(line);
    if (m && tables.length) tables[tables.length - 1].push({ type: m[1], shape: m[2] });
  }
  return { doc, tables };
}

function fieldsOf(shape) {
  return [...shape.matchAll(/,\s*([a-z]+):/g)].map((m) => m[1]).sort();
}

describe('the contract document and the host agree on every message', () => {
  test('the table the document publishes is the table the host enforces, both ways', async () => {
    const { EXTENSION_MESSAGES } = await host();
    const { tables } = documentTables();
    assert.ok(tables.length >= 2 && tables[0].length >= 4,
      'the parse found the document\'s message tables; an empty read is a broken instrument');
    const rows = tables[0];
    const types = rows.map((r) => r.type).sort();
    assert.deepStrictEqual(Object.keys(EXTENSION_MESSAGES).sort(), types,
      'a message in one table and not the other is a capability the contract does not govern: '
      + 'edit docs/EXTENSION-HOST.md and EXTENSION_MESSAGES together');
    // Every field the document's Shape cell names for a type is a field the
    // host checks for that type, so the Shape column cannot promise a field
    // the mediator does not enforce.
    for (const { type, shape } of rows) {
      for (const field of fieldsOf(shape)) {
        assert.ok(Object.prototype.hasOwnProperty.call(EXTENSION_MESSAGES[type], field),
          `the document's shape for "${type}" names field "${field}" that the host does not check`);
      }
    }
  });

  test('the host-to-extension table matches what the host posts, type for type and field for field', async () => {
    const { HOST_MESSAGES, HOST_MESSAGE_FIELDS } = await host();
    const { tables } = documentTables();
    const rows = tables[1] || [];
    assert.deepStrictEqual(rows.map((r) => r.type).sort(), [...HOST_MESSAGES].sort(),
      'a host message in one table and not the other: edit docs/EXTENSION-HOST.md and HOST_MESSAGES together');
    assert.deepStrictEqual(Object.keys(HOST_MESSAGE_FIELDS).sort(), [...HOST_MESSAGES].sort(),
      'every host message declares the fields it carries');
    for (const { type, shape } of rows) {
      assert.deepStrictEqual(fieldsOf(shape), [...HOST_MESSAGE_FIELDS[type]].sort(),
        `the document's shape for "${type}" and the fields the host posts must be the same set`);
    }
  });

  test('the cap the document states for init is the cap the host enforces', async () => {
    const { MAX_INIT_CONTENT_CHARS } = await host();
    const { doc } = documentTables();
    const m = /`MAX_INIT_CONTENT_CHARS` \((\d+) characters\)/.exec(doc);
    assert.ok(m, 'the document states the init content cap by its constant name and value');
    assert.strictEqual(Number(m[1]), MAX_INIT_CONTENT_CHARS,
      'the document cannot promise a different limit than the host enforces');
    assert.ok(Number.isInteger(MAX_INIT_CONTENT_CHARS) && MAX_INIT_CONTENT_CHARS > 0);
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

  test('an entry containing a closing script tag cannot escape its own element', async () => {
    const { frame } = await mounted({
      payload: { entry: 'a();</script><script>steal()', styles: ['x{}</style><style>y{}'] },
    });
    // The raw closing sequence must not survive into the composed document,
    // or the view's script ends early and it never says ready.
    assert.ok(!frame.srcdoc.includes('</script><script>steal()'),
      'the entry could close its own script element and inject a second one');
    assert.ok(!frame.srcdoc.includes('</style><style>y{}'),
      'the stylesheet could close its own style element');
    assert.ok(frame.srcdoc.includes('steal()') && frame.srcdoc.includes('y{}'),
      'the whole payload is still present, escaped rather than dropped');
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

  test('ready is answered with init over the wire carrying the opened file, and the watchdog stands down', async () => {
    const { wire, handle, sent } = await mounted({ readyTimeoutMs: 30, path: 'data/sales.csv', content: 'a,b\n1,2\n' });
    wire({ type: 'ready' });
    assert.deepStrictEqual(sent, [{ type: 'init', path: 'data/sales.csv', content: 'a,b\n1,2\n', theme: 'dark' }],
      'the frame receives the file it was mounted for, path and text, once, after ready');
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(handle.alive(), true, 'a view that said ready is not torn down by the clock');
  });

  test('init carries the theme the page shows at mount time, read from the body class the toggle sets', async () => {
    const light = await mounted({ bodyClass: 'light' });
    light.wire({ type: 'ready' });
    assert.strictEqual(light.sent[0].theme, 'light');
    const dark = await mounted({ bodyClass: '' });
    dark.wire({ type: 'ready' });
    assert.strictEqual(dark.sent[0].theme, 'dark');
  });

  test('text over the exported cap degrades before any frame is appended, with the cap named', async () => {
    const { MAX_INIT_CONTENT_CHARS } = await host();
    const over = 'x'.repeat(MAX_INIT_CONTENT_CHARS + 1);
    const { pane, handle, degraded } = await mounted({ content: over });
    assert.strictEqual(pane.querySelector('iframe'), null, 'no frame was ever appended');
    assert.strictEqual(handle.alive(), false);
    assert.strictEqual(degraded.length, 1);
    assert.match(degraded[0], new RegExp(String(MAX_INIT_CONTENT_CHARS)), 'the reason names the cap');
    const atCap = await mounted({ content: 'x'.repeat(MAX_INIT_CONTENT_CHARS) });
    assert.ok(atCap.pane.querySelector('iframe'), 'text at the cap mounts');
    assert.deepStrictEqual(atCap.degraded, []);
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

describe('the server reads the install store and guards every payload path', () => {
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

  // The install store: the records file the install flow writes, and the
  // extension's files under the Rundock-owned root, with the rundock.json
  // the extension ships declaring its entry and match rule.
  const RECORDS = '.claude/rundock/extensions.json';
  const record = (extra = {}) => ({
    name: 'charts', version: '1.0.0', entry: 'ui/index.js', match: '*.chart',
    source: { url: 'https://github.com/example/charts', reference: 'v1.0.0' },
    installedAt: '2026-09-07T00:00:00.000Z', root: '.claude/rundock/extensions/charts', ...extra,
  });
  const records = (...list) => JSON.stringify({ schema: 'rundock.extensions/v1', extensions: list });
  const manifest = (name, extension) => JSON.stringify({ name, version: '1.0.0', extension });

  test('installed extensions list with their renderer, and a record with no valid name says so', () => {
    const dir = workspace({
      [RECORDS]: records(record(), { name: 'Not A Slug', version: '1', source: { url: 'u', reference: 'r' } }),
      '.claude/rundock/extensions/charts/rundock.json': manifest('charts', { entry: 'ui/index.js', match: '*.chart' }),
      '.claude/rundock/extensions/charts/ui/index.js': 'draw();',
    });
    try {
      const listed = registry.listExtensions(dir);
      assert.strictEqual(listed.length, 2, 'every record is reported, the broken one included');
      const charts = listed.find((e) => e.id === 'charts');
      assert.deepStrictEqual(charts, {
        id: 'charts', name: 'charts', version: '1.0.0', enabled: true,
        renderers: [{ id: 'view', target: '.chart' }], refusals: [], resources: [],
      });
      const broken = listed.find((e) => e.id !== 'charts');
      assert.strictEqual(broken.broken, true);
      assert.strictEqual(broken.enabled, false, 'a broken record is never enabled');
      assert.deepStrictEqual(broken.renderers, []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a payload reads its entry from inside the extension directory, with no styles to carry', () => {
    const dir = workspace({
      [RECORDS]: records(record()),
      '.claude/rundock/extensions/charts/rundock.json': manifest('charts', { entry: 'ui/index.js', match: '*.chart' }),
      '.claude/rundock/extensions/charts/ui/index.js': 'draw();',
    });
    try {
      const p = registry.uiPayload(dir, 'charts', 'view');
      assert.strictEqual(p.ok, true);
      assert.strictEqual(p.entry, 'draw();');
      assert.deepStrictEqual(p.styles, []);
      assert.deepStrictEqual(p.resources, []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('an entry that resolves outside the extension directory is refused, spelled any way', () => {
    for (const spelling of ['../../../secret.js', 'ui/../../../secret.js', '/etc/passwd']) {
      const dir = workspace({
        [RECORDS]: records(record({ name: 'thief', entry: spelling, root: '.claude/rundock/extensions/thief' })),
        '.claude/rundock/extensions/thief/rundock.json': manifest('thief', { entry: spelling, match: '*.x' }),
        'secret.js': 'the workspace\'s own file',
      });
      try {
        const p = registry.uiPayload(dir, 'thief', 'view');
        assert.strictEqual(p.ok, false, `${spelling}: refused`);
        assert.match(p.reason, /inside the extension's own directory/);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  });

  test('an entry reached through a symlink out of the directory is refused too', () => {
    const dir = workspace({
      [RECORDS]: records(record({ entry: 'ui/link.js' })),
      '.claude/rundock/extensions/charts/rundock.json': manifest('charts', { entry: 'ui/link.js', match: '*.chart' }),
      'secret.js': 'the workspace\'s own file',
    });
    try {
      fs.mkdirSync(path.join(dir, '.claude', 'rundock', 'extensions', 'charts', 'ui'), { recursive: true });
      fs.symlinkSync(path.join(dir, 'secret.js'), path.join(dir, '.claude', 'rundock', 'extensions', 'charts', 'ui', 'link.js'));
      const p = registry.uiPayload(dir, 'charts', 'view');
      assert.strictEqual(p.ok, false);
      assert.match(p.reason, /inside the extension's own directory/,
        'canonicalised on both sides, so a symlink spelling cannot walk out');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('an extension id that is not an installed name is refused before any read', () => {
    const dir = workspace({
      [RECORDS]: records(record()),
      '.claude/rundock/extensions/charts/ui/index.js': 'draw();',
    });
    try {
      for (const bad of ['../charts', 'charts/../charts', '', '.', '..', 'Charts', 'a b']) {
        const p = registry.uiPayload(dir, bad, 'view');
        assert.strictEqual(p.ok, false, `${JSON.stringify(bad)} refused`);
        assert.match(p.reason, /not an installed extension name/);
      }
      assert.strictEqual(registry.uiPayload(dir, 'charts', 'other').ok, false, 'the one renderer id is the only one served');
      assert.strictEqual(registry.uiPayload(dir, 'nobody', 'view').ok, false, 'a name with no record is refused');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a name the roster reports is a name a mount can be served for', () => {
    // The roster and the payload read one store through one name rule, so an
    // id the roster lists as renderable is an id uiPayload serves.
    const dir = workspace({
      [RECORDS]: records(record({ name: 'my-ext', root: '.claude/rundock/extensions/my-ext' })),
      '.claude/rundock/extensions/my-ext/rundock.json': manifest('my-ext', { entry: 'ui/index.js', match: '*.chart' }),
      '.claude/rundock/extensions/my-ext/ui/index.js': 'draw();',
    });
    try {
      const listed = registry.listExtensions(dir).filter((e) => e.renderers.length);
      assert.deepStrictEqual(listed.map((e) => e.id), ['my-ext'], 'the roster lists it');
      const p = registry.uiPayload(dir, 'my-ext', listed[0].renderers[0].id);
      assert.strictEqual(p.ok, true, 'and the mount serves it: the two agree on what an installed id is');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a workspace with no records file has no extensions, and no records directory is the same', () => {
    const dir = workspace({ 'notes.md': 'nothing installed' });
    try {
      assert.deepStrictEqual(registry.listExtensions(dir), []);
      assert.strictEqual(registry.uiPayload(dir, 'charts', 'view').ok, false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
