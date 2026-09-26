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

function shell(bodyClass = '', headCss = '') {
  const head = headCss ? `<head><style>${headCss}</style></head>` : '';
  const dom = new JSDOM(`<!doctype html><html>${head}<body class="${bodyClass}"><div id="pane"></div></body></html>`, {
    runScripts: 'outside-only',
  });
  // The grammar the real page loads as a classic script ahead of the host,
  // so the host's list rule on writes has what it reads. A page without it
  // refuses every write (see the test that removes it).
  dom.window.RundockNamedSources = require('../../public/named-sources-model.js');
  return { dom, doc: dom.window.document, pane: dom.window.document.getElementById('pane') };
}

// The app's real token stylesheet, loaded whole into the shell so the token
// tests read the values the product ships rather than a copy that could
// drift: what tokens.css declares is exactly what the host must hand a frame.
const TOKENS_CSS = fs.readFileSync(path.join(ROOT, 'public', 'styles', 'tokens.css'), 'utf-8');

const PAYLOAD = {
  entry: 'parent.postMessage({type:"ready"},"*");',
  styles: ['body { color: red; }'],
  resources: [{ id: 'notes', maximumBytes: 100 }],
};

// Mount with the frame's postMessage captured, so what the host says back to
// the extension is read off the wire rather than inferred.
async function mounted(opts = {}) {
  const { mountExtension } = await host();
  const { dom, pane } = shell(opts.bodyClass, opts.headCss);
  const sent = [];
  const degraded = [];
  const opened = [];
  const saved = [];
  const externals = [];
  // A real click inside the frame reaches the HOST's activation state (User
  // Activation v2). jsdom has no such API, so a test sets what the browser
  // would report. Absent, the host reads "no click", which is its safe default.
  let active = false;
  let focusedFrame = false;
  Object.defineProperty(dom.window.navigator, 'userActivation', {
    configurable: true, get: () => ({ isActive: active, hasBeenActive: active }),
  });
  // A click inside the frame both activates the page and moves focus to the
  // frame. `elsewhere` models the other case the host must refuse: a click on
  // the page (the file tree that opened this file) that activates it while
  // focus is somewhere other than the frame.
  let handleRef = null;
  Object.defineProperty(dom.window.document, 'activeElement', {
    configurable: true, get: () => (focusedFrame && handleRef ? handleRef.frame() : dom.window.document.body),
  });
  // The page's own gesture recorder (public/host-gestures.js), as loaded on
  // the real page: no page gesture yet. `elsewhere` is a click on the page,
  // which the recorder sees; a click in the frame is one it never sees.
  dom.window.rundockLastHostGesture = -Infinity;
  const setClickState = ({ active: a, focused, pageGestureAgoMs = null }) => {
    active = a;
    focusedFrame = focused;
    dom.window.rundockLastHostGesture = pageGestureAgoMs === null ? -Infinity : Date.now() - pageGestureAgoMs;
  };
  const activate = (on = true, { elsewhere = false, focusStolen = false } = {}) => {
    active = on;
    focusedFrame = on && (!elsewhere || focusStolen);
    if (elsewhere) dom.window.rundockLastHostGesture = Date.now();
  };
  const handle = mountExtension({
    paneElement: pane,
    payload: opts.payload || PAYLOAD,
    path: opts.path === undefined ? 'notes/q3.chart' : opts.path,
    content: opts.content === undefined ? 'a,b\n1,2\n' : opts.content,
    onOpen: (t) => opened.push(t),
    onSave: (c) => saved.push(c),
    ...(opts.onChange ? { onChange: opts.onChange } : {}),
    ...(opts.embedded ? { embedded: true } : {}),
    onOpenExternal: (u) => externals.push(u),
    onDegrade: (reason) => degraded.push(reason),
    readyTimeoutMs: opts.readyTimeoutMs || 5000,
    ...(opts.extra || {}),
  });
  handleRef = handle;
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
  return { dom, pane, handle, frame, source, sent, degraded, opened, saved, externals, activate, setClickState, wire };
}

// The document's message rows, one list per table. A table starts at its
// header row; the first is what an extension may say to the host, the second
// what the host says to an extension. Each row: the type and the Shape cell.
function documentTables() {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'EXTENSION-HOST.md'), 'utf-8');
  const tables = [];
  for (const line of doc.split('\n')) {
    if (/^\| Type \|/.test(line)) { tables.push([]); continue; }
    // [A-Za-z], not [a-z]: the lowercase-only pattern could not see a
    // camelCase message such as openExternal, so one could have been added
    // to the host with no row in the document and this check would have
    // parsed straight past it.
    const m = /^\| `([A-Za-z]+)` \| `(\{ type[^`]*)`/.exec(line);
    if (m && tables.length) tables[tables.length - 1].push({ type: m[1], shape: m[2] });
  }
  return { doc, tables };
}

function fieldsOf(shape) {
  return [...shape.matchAll(/,\s*([A-Za-z]+):/g)].map((m) => m[1]).sort();
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
    assert.deepStrictEqual(sent, [{ type: 'init', path: 'data/sales.csv', content: 'a,b\n1,2\n', theme: 'dark', sources: [], state: null }],
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

  test('open after a click passes the target to the opener and navigates nothing itself', async () => {
    const { wire, opened, activate } = await mounted();
    activate();
    wire({ type: 'open', target: 'Projects/plan.md' });
    assert.deepStrictEqual(opened, ['Projects/plan.md']);
  });

  // Writing is the one thing an extension does that outlives
  // the session, so it is gated on a declaration the trust card showed, and
  // scoped by the shape of the message rather than by a check: `save` has no
  // path, so the host writes the file it mounted or nothing at all.
  test('a declaring extension hands back bytes, and the host is what writes them', async () => {
    const { wire, saved } = await mounted({ payload: { ...PAYLOAD, writes: true } });
    wire({ type: 'save', content: 'a,b\n9,9\n' });
    assert.deepStrictEqual(saved, ['a,b\n9,9\n'],
      'the content reaches the host, which owns the path and performs the write');
  });

  test('an extension that did not declare writes is refused, and told why', async () => {
    const { wire, sent, saved } = await mounted();
    wire({ type: 'save', content: 'anything at all' });
    assert.deepStrictEqual(saved, [], 'nothing reaches the writer');
    assert.strictEqual(sent[0].type, 'refused');
    assert.strictEqual(sent[0].of, 'save');
    assert.match(sent[0].reason, /did not declare writes/,
      'the reason names the manifest, so an author fixes a key rather than reading the host');
  });

  test('a payload that does not say cannot write: the safe reading of unknown is no', async () => {
    for (const writes of [undefined, null, false, 'true', 1]) {
      const { wire, saved } = await mounted({ payload: { ...PAYLOAD, writes } });
      wire({ type: 'save', content: 'x' });
      assert.deepStrictEqual(saved, [], `writes: ${JSON.stringify(writes)} is not a declaration`);
    }
  });

  // The mount contract's onChange, for an extension: `change` hands the
  // bytes to the caller's one debounce rather than writing at once, under
  // the same declaration `save` needs.
  test('change reaches the caller\'s debounce only for an extension that declared writes', async () => {
    const changed = [];
    const { wire, saved } = await mounted({ payload: { ...PAYLOAD, writes: true }, onChange: (c) => changed.push(c) });
    wire({ type: 'change', content: 'a,b\n3,4\n' });
    assert.deepStrictEqual(changed, ['a,b\n3,4\n'], 'handed to the caller, which decides when to write');
    assert.deepStrictEqual(saved, [], 'and not written at once');
    const refused = await mounted({ onChange: (c) => changed.push(c) });
    refused.wire({ type: 'change', content: 'x' });
    assert.strictEqual(changed.length, 1, 'an undeclared extension changes nothing');
    assert.strictEqual(refused.sent[0].of, 'change');
    assert.match(refused.sent[0].reason, /did not declare writes/);
  });

  // An embedded view is its own file and nothing else. It
  // cannot write, even where the manifest declared writes, and it cannot
  // reach another file, even after a click; the same extension opened on
  // its file directly can write.
  test('an embedded view refuses save, change and open, where the same extension opened directly may write', async () => {
    const changed = [];
    const embed = await mounted({ payload: { ...PAYLOAD, writes: true }, embedded: true, onChange: (c) => changed.push(c) });
    embed.activate();
    embed.wire({ type: 'save', content: 'x' });
    embed.wire({ type: 'change', content: 'y' });
    embed.wire({ type: 'open', target: 'secrets.md' });
    assert.deepStrictEqual([embed.saved, changed, embed.opened], [[], [], []], 'nothing written, nothing opened');
    assert.deepStrictEqual(embed.sent.map((m) => [m.type, m.of]), [['refused', 'save'], ['refused', 'change'], ['refused', 'open']]);
    assert.match(embed.sent[0].reason, /embedded view is read-only/);
    const direct = await mounted({ payload: { ...PAYLOAD, writes: true } });
    direct.wire({ type: 'save', content: 'z' });
    assert.deepStrictEqual(direct.saved, ['z']);
  });

  test('save names no path, so there is no path for an extension to get wrong', async () => {
    const { EXTENSION_MESSAGES } = await host();
    assert.deepStrictEqual(Object.keys(EXTENSION_MESSAGES.save), ['content'],
      'a path field here would be the whole of the scoping, and it is absent by design');
    const { wire, saved } = await mounted({ payload: { ...PAYLOAD, writes: true } });
    // Sent anyway, the way a hostile extension would: the extra field is not
    // in the table, so it is carried nowhere and changes nothing.
    wire({ type: 'save', content: 'bytes', path: '../../etc/passwd' });
    assert.deepStrictEqual(saved, ['bytes'],
      'the smuggled path is simply not part of the message the host reads');
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

describe('the frame receives the host\'s design tokens, as literal values, ahead of its own styles', () => {
  // A stylesheet written the way a third-party extension should write one:
  // every color and size a var() over Rundock's tokens, no literal palette
  // of its own. Modelled on the real csv extension, whose author hand-copied
  // Rundock's dark chrome tones because nothing else was possible; this
  // fixture is what that stylesheet becomes once tokens reach the frame.
  const TOKEN_STYLESHEET = [
    'html,body{margin:0;background:var(--surface);color:var(--text-1);font-size:var(--body)}',
    'caption,.note{color:var(--text-2)}',
    'th,td{border:1px solid var(--border)}',
    'th{background:var(--elevated)}',
    'tr.picked td{color:var(--accent)}',
    '.error{color:var(--danger-text)}',
    'table{border-radius:var(--radius-sm)}',
  ].join('');
  const TOKEN_PAYLOAD = {
    entry: 'parent.postMessage({type:"ready"},"*");',
    styles: [TOKEN_STYLESHEET],
  };

  // The token block the host composed into a srcdoc, as name-value pairs.
  function injectedTokens(srcdoc) {
    const m = /<style data-rundock-tokens>:root \{([^<]*)\}<\/style>/.exec(srcdoc);
    if (!m) return null;
    const out = {};
    for (const decl of m[1].split(';')) {
      const at = decl.indexOf(':');
      if (at > 0) out[decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
    }
    return out;
  }

  test('the token block carries the computed values of the page\'s custom properties, first in the document', async () => {
    const { frame } = await mounted({
      headCss: ':root{--accent:#123456;--radius-sm:4px} body.light{--accent:#654321}',
      payload: TOKEN_PAYLOAD,
    });
    const tokens = injectedTokens(frame.srcdoc);
    assert.ok(tokens, 'the srcdoc carries a :root block of the host\'s tokens');
    assert.strictEqual(tokens['--accent'], '#123456', 'the value is the computed one for the theme showing');
    assert.strictEqual(tokens['--radius-sm'], '4px', 'every custom property travels, not only colors');
    assert.ok(frame.srcdoc.indexOf(':root {') < frame.srcdoc.indexOf(TOKEN_STYLESHEET),
      'the tokens come first, so the extension\'s own styles can read them and override its own layout');
  });

  test('the names are derived from the loaded stylesheets, so a token added to tokens.css reaches frames with no list to update', async () => {
    const { frame } = await mounted({
      headCss: ':root{--accent:#123456;--brand-new-token:7px}',
      payload: TOKEN_PAYLOAD,
    });
    const tokens = injectedTokens(frame.srcdoc);
    assert.strictEqual(tokens['--brand-new-token'], '7px',
      'a name nothing in the host module spells still arrives, because the set is read off the stylesheet');
  });

  test('a token-written stylesheet has every var() it reads defined, in both themes, from the real tokens.css', async () => {
    const referenced = [...TOKEN_STYLESHEET.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]);
    assert.ok(referenced.length >= 8, 'the fixture reads a real spread of tokens');
    assert.ok(!/#[0-9a-fA-F]{3}|rgba?\(/.test(TOKEN_STYLESHEET),
      'the fixture carries no color literal of its own: the palette is entirely Rundock\'s');
    const dark = await mounted({ headCss: TOKENS_CSS, bodyClass: '', payload: TOKEN_PAYLOAD });
    const light = await mounted({ headCss: TOKENS_CSS, bodyClass: 'light', payload: TOKEN_PAYLOAD });
    const darkTokens = injectedTokens(dark.frame.srcdoc);
    const lightTokens = injectedTokens(light.frame.srcdoc);
    for (const name of referenced) {
      assert.ok(darkTokens[name], `${name} is defined in the dark frame`);
      assert.ok(lightTokens[name], `${name} is defined in the light frame`);
    }
    // The values are the theme's, read from the live computed style: the
    // spot checks are tokens.css's own values, so a palette change there
    // changes what this test reads on both sides of the comparison.
    assert.strictEqual(darkTokens['--surface'], '#212121');
    assert.strictEqual(lightTokens['--surface'], '#FAF8F5');
    assert.notStrictEqual(darkTokens['--danger-text'], lightTokens['--danger-text'],
      'a theme-aware token resolves to each theme\'s own value');
    assert.strictEqual(darkTokens['--accent'], lightTokens['--accent'],
      'a token the themes share resolves identically');
  });

  test('what is injected is a block of literal values, never a route to the host', async () => {
    const { frame, handle } = await mounted({ headCss: TOKENS_CSS, payload: TOKEN_PAYLOAD });
    assert.strictEqual(frame.getAttribute('sandbox'), 'allow-scripts',
      'the tokens change nothing about the posture: the origin stays opaque');
    const tokens = injectedTokens(frame.srcdoc);
    for (const [name, value] of Object.entries(tokens)) {
      assert.ok(!/url\(|javascript:|expression\(/i.test(value),
        `${name} is a literal value, carrying no reference anywhere`);
    }
    assert.doesNotThrow(() => handle.teardown());
  });

  test('a theme change while mounted rebuilds the frame with the new theme\'s values', async () => {
    const m = await mounted({ headCss: TOKENS_CSS, bodyClass: '', payload: TOKEN_PAYLOAD });
    m.wire({ type: 'ready' });
    assert.strictEqual(m.sent[0].theme, 'dark');
    assert.strictEqual(injectedTokens(m.frame.srcdoc)['--surface'], '#212121');
    const doc = m.dom.window.document;
    doc.body.classList.add('light');
    // MutationObserver delivers on the microtask queue; one macrotask is
    // strictly after it.
    await new Promise((r) => setTimeout(r, 0));
    const rebuilt = m.handle.frame();
    assert.ok(rebuilt, 'the mount is still alive');
    assert.notStrictEqual(rebuilt, m.frame, 'the frame was rebuilt, not left with the old palette');
    assert.strictEqual(injectedTokens(rebuilt.srcdoc)['--surface'], '#FAF8F5',
      'the rebuilt frame carries the light values');
    assert.strictEqual(rebuilt.getAttribute('sandbox'), 'allow-scripts', 'the posture survives the rebuild');
    assert.strictEqual(m.pane.querySelectorAll('iframe').length, 1, 'one frame, the old one left');
    // The rebuilt frame boots afresh and is answered with the theme now
    // showing, so the init the extension reads agrees with the palette it
    // was handed.
    const sent = [];
    rebuilt.contentWindow.postMessage = (msg) => sent.push(msg);
    m.handle.dispatch({ source: rebuilt.contentWindow, data: { type: 'ready' } });
    assert.strictEqual(sent[0].type, 'init');
    assert.strictEqual(sent[0].theme, 'light');
    m.handle.teardown();
  });

  test('a view whose ready names theme is sent the new theme and tokens, and its frame is kept', async () => {
    const m = await mounted({ headCss: TOKENS_CSS, bodyClass: '', payload: TOKEN_PAYLOAD });
    m.wire({ type: 'ready', handles: ['theme'] });
    assert.strictEqual(m.sent[0].type, 'init');
    m.dom.window.document.body.classList.add('light');
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(m.handle.frame(), m.frame, 'the same frame: nothing was rebuilt');
    assert.strictEqual(m.pane.querySelectorAll('iframe').length, 1);
    const theme = m.sent.filter((x) => x.type === 'theme');
    assert.strictEqual(theme.length, 1, 'one theme message for one flip');
    assert.deepStrictEqual(Object.keys(theme[0]).sort(), ['theme', 'tokens', 'type']);
    assert.strictEqual(theme[0].theme, 'light');
    assert.strictEqual(new Map(theme[0].tokens).get('--surface'), '#FAF8F5', 'the tokens are the light values, read now');
    // And back again, with the dark values.
    m.dom.window.document.body.classList.remove('light');
    await new Promise((r) => setTimeout(r, 0));
    const back = m.sent.filter((x) => x.type === 'theme');
    assert.strictEqual(back.length, 2);
    assert.strictEqual(back[1].theme, 'dark');
    assert.strictEqual(new Map(back[1].tokens).get('--surface'), '#212121');
    assert.strictEqual(m.handle.frame(), m.frame);
    m.handle.teardown();
  });

  test('a view that has not said ready is rebuilt on a theme change, not sent a message it never asked for', async () => {
    const m = await mounted({ headCss: TOKENS_CSS, bodyClass: '', payload: TOKEN_PAYLOAD });
    m.dom.window.document.body.classList.add('light');
    await new Promise((r) => setTimeout(r, 0));
    assert.notStrictEqual(m.handle.frame(), m.frame, 'rebuilt');
    assert.ok(!m.sent.some((x) => x.type === 'theme'));
    m.handle.teardown();
  });

  test('a ready whose handles is not a list of names is refused, and the view is then rebuilt on a flip', async () => {
    const m = await mounted({ headCss: TOKENS_CSS, bodyClass: '', payload: TOKEN_PAYLOAD });
    m.wire({ type: 'ready', handles: 'theme' });
    assert.deepStrictEqual(m.sent.map((x) => x.type), ['refused']);
    assert.strictEqual(m.sent[0].of, 'ready');
    m.dom.window.document.body.classList.add('light');
    await new Promise((r) => setTimeout(r, 0));
    assert.notStrictEqual(m.handle.frame(), m.frame, 'rebuilt, because it never said it handles theme');
    m.handle.teardown();
  });

  test('the frame applies a theme message from its parent, and only from its parent', async () => {
    const { buildRegionSrcdoc } = await host();
    const page = new JSDOM(`<!doctype html><html><head><style>${TOKENS_CSS}</style></head><body></body></html>`);
    const srcdoc = buildRegionSrcdoc({ entry: 'window.__seen=[];addEventListener("message",function(e){__seen.push(document.querySelector("style[data-rundock-tokens]").textContent)});' }, page.window.document);
    const frame = new JSDOM(srcdoc, { runScripts: 'dangerously' });
    const w = frame.window;
    const block = () => w.document.querySelector('style[data-rundock-tokens]').textContent;
    assert.match(block(), /--surface: #212121/);
    const deliver = (data, source) => { const ev = new w.MessageEvent('message', { data }); Object.defineProperty(ev, 'source', { value: source }); w.dispatchEvent(ev); };
    // A top-level jsdom window is its own parent, so a stranger stands in for
    // any window that is not the frame's parent.
    deliver({ type: 'theme', theme: 'light', tokens: [['--surface', '#FAF8F5']] }, { stranger: true });
    assert.match(block(), /--surface: #212121/, 'a theme message from anything but the parent changes nothing');
    assert.ok(!w.document.body.classList.contains('light'));
    deliver({ type: 'theme', theme: 'light', tokens: [['--surface', '#FAF8F5'], ['--bad', 7]] }, w.parent);
    assert.strictEqual(block(), ':root { --surface: #FAF8F5; }', 'rewritten from the pairs, a malformed pair dropped');
    assert.ok(w.document.body.classList.contains('light'));
    assert.strictEqual(w.__seen[w.__seen.length - 1], ':root { --surface: #FAF8F5; }', 'the entry sees the message after the frame applied it');
    deliver({ type: 'theme', theme: 'dark', tokens: [['--surface', '#212121']] }, w.parent);
    assert.ok(!w.document.body.classList.contains('light'));
  });

  test('a body class change that is not a theme change rebuilds nothing', async () => {
    const m = await mounted({ headCss: TOKENS_CSS, bodyClass: '', payload: TOKEN_PAYLOAD });
    const before = m.handle.frame();
    m.dom.window.document.body.classList.add('busy');
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(m.handle.frame(), before,
      'the observer compares the theme, not the class list, so unrelated churn leaves the frame alone');
    m.handle.teardown();
  });

  test('after teardown a theme change reaches no frame: the observer is disconnected with the listener', async () => {
    const m = await mounted({ headCss: TOKENS_CSS, bodyClass: '', payload: TOKEN_PAYLOAD });
    m.handle.teardown();
    m.dom.window.document.body.classList.add('light');
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(m.handle.frame(), null, 'nothing was rebuilt for a mount that is gone');
    assert.strictEqual(m.pane.querySelector('iframe'), null);
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
  const RECORDS = '.rundock/extensions.json';
  const record = (extra = {}) => ({
    name: 'charts', version: '1.0.0', entry: 'ui/index.js', match: '*.chart',
    source: { url: 'https://github.com/example/charts', reference: 'v1.0.0' },
    installedAt: '2026-09-07T00:00:00.000Z', root: '.rundock/extensions/charts', ...extra,
  });
  const records = (...list) => JSON.stringify({ schema: 'rundock.extensions/v1', extensions: list });
  const manifest = (name, extension) => JSON.stringify({ name, version: '1.0.0', extension });

  test('installed extensions list with their renderer, and a record with no valid name says so', () => {
    const dir = workspace({
      [RECORDS]: records(record(), { name: 'Not A Slug', version: '1', source: { url: 'u', reference: 'r' } }),
      '.rundock/extensions/charts/rundock.json': manifest('charts', { entry: 'ui/index.js', match: '*.chart' }),
      '.rundock/extensions/charts/ui/index.js': 'draw();',
    });
    try {
      const listed = registry.listExtensions(dir);
      assert.strictEqual(listed.length, 2, 'every record is reported, the broken one included');
      const charts = listed.find((e) => e.id === 'charts');
      assert.deepStrictEqual(charts, {
        id: 'charts', name: 'charts', version: '1.0.0', enabled: true,
        renderers: [{ id: 'view', target: '.chart' }], refusals: [], resources: [],
        source: { url: 'https://github.com/example/charts', reference: 'v1.0.0' },
        installedAt: '2026-09-07T00:00:00.000Z',
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
      '.rundock/extensions/charts/rundock.json': manifest('charts', { entry: 'ui/index.js', match: '*.chart' }),
      '.rundock/extensions/charts/ui/index.js': 'draw();',
    });
    try {
      const p = registry.uiPayload(dir, 'charts', 'view');
      assert.strictEqual(p.ok, true);
      assert.strictEqual(p.entry, 'draw();');
      assert.deepStrictEqual(p.styles, []);
      assert.deepStrictEqual(p.resources, []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a payload serves the stylesheets the manifest declares, read from inside the extension directory', () => {
    const dir = workspace({
      [RECORDS]: records(record()),
      '.rundock/extensions/charts/rundock.json': manifest('charts', {
        entry: 'ui/index.js', match: '*.chart', styles: ['ui/table.css', 'ui/print.css'],
      }),
      '.rundock/extensions/charts/ui/index.js': 'draw();',
      '.rundock/extensions/charts/ui/table.css': 'th{color:var(--accent)}',
      '.rundock/extensions/charts/ui/print.css': '.note{color:var(--text-2)}',
    });
    try {
      const p = registry.uiPayload(dir, 'charts', 'view');
      assert.strictEqual(p.ok, true);
      assert.deepStrictEqual(p.styles, ['th{color:var(--accent)}', '.note{color:var(--text-2)}'],
        'the declared stylesheets arrive as their bytes, in the order declared');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('the record\'s copy of the styles serves when the installed directory carries no manifest', () => {
    const dir = workspace({
      [RECORDS]: records(record({ styles: ['ui/table.css'] })),
      '.rundock/extensions/charts/ui/index.js': 'draw();',
      '.rundock/extensions/charts/ui/table.css': 'th{color:var(--accent)}',
    });
    try {
      const p = registry.uiPayload(dir, 'charts', 'view');
      assert.strictEqual(p.ok, true);
      assert.deepStrictEqual(p.styles, ['th{color:var(--accent)}'],
        'the record stands in for the manifest, exactly as it does for the entry');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a declared stylesheet that escapes the extension directory, or is not there, refuses the payload', () => {
    for (const spelling of ['../../../secret.css', 'ui/../../../secret.css', '/etc/passwd', 'ui/missing.css']) {
      const dir = workspace({
        [RECORDS]: records(record()),
        '.rundock/extensions/charts/rundock.json': manifest('charts', {
          entry: 'ui/index.js', match: '*.chart', styles: [spelling],
        }),
        '.rundock/extensions/charts/ui/index.js': 'draw();',
        'secret.css': 'the workspace\'s own file',
      });
      try {
        const p = registry.uiPayload(dir, 'charts', 'view');
        assert.strictEqual(p.ok, false, `${spelling}: refused`);
        assert.match(p.reason, /inside the extension's own directory/,
          'a bad stylesheet path is refused exactly as a bad entry is, never skipped');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  });

  test('a stylesheet reached through a symlink out of the directory is refused too', () => {
    const dir = workspace({
      [RECORDS]: records(record()),
      '.rundock/extensions/charts/rundock.json': manifest('charts', {
        entry: 'ui/index.js', match: '*.chart', styles: ['ui/link.css'],
      }),
      '.rundock/extensions/charts/ui/index.js': 'draw();',
      'secret.css': 'the workspace\'s own file',
    });
    try {
      fs.symlinkSync(path.join(dir, 'secret.css'), path.join(dir, '.rundock', 'extensions', 'charts', 'ui', 'link.css'));
      const p = registry.uiPayload(dir, 'charts', 'view');
      assert.strictEqual(p.ok, false);
      assert.match(p.reason, /inside the extension's own directory/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a styles declaration that is not a list of paths refuses the payload by name', () => {
    for (const bad of ['ui/table.css', { list: [] }, [5], [''], [null]]) {
      const dir = workspace({
        [RECORDS]: records(record()),
        '.rundock/extensions/charts/rundock.json': JSON.stringify({
          name: 'charts', version: '1.0.0',
          extension: { entry: 'ui/index.js', match: '*.chart', styles: bad },
        }),
        '.rundock/extensions/charts/ui/index.js': 'draw();',
      });
      try {
        const p = registry.uiPayload(dir, 'charts', 'view');
        assert.strictEqual(p.ok, false, `${JSON.stringify(bad)}: refused`);
        assert.match(p.reason, /styles/, 'the refusal names the declaration that is broken');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  });

  test('an entry that resolves outside the extension directory is refused, spelled any way', () => {
    for (const spelling of ['../../../secret.js', 'ui/../../../secret.js', '/etc/passwd']) {
      const dir = workspace({
        [RECORDS]: records(record({ name: 'thief', entry: spelling, root: '.rundock/extensions/thief' })),
        '.rundock/extensions/thief/rundock.json': manifest('thief', { entry: spelling, match: '*.x' }),
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
      '.rundock/extensions/charts/rundock.json': manifest('charts', { entry: 'ui/link.js', match: '*.chart' }),
      'secret.js': 'the workspace\'s own file',
    });
    try {
      fs.mkdirSync(path.join(dir, '.rundock', 'extensions', 'charts', 'ui'), { recursive: true });
      fs.symlinkSync(path.join(dir, 'secret.js'), path.join(dir, '.rundock', 'extensions', 'charts', 'ui', 'link.js'));
      const p = registry.uiPayload(dir, 'charts', 'view');
      assert.strictEqual(p.ok, false);
      assert.match(p.reason, /inside the extension's own directory/,
        'canonicalised on both sides, so a symlink spelling cannot walk out');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('an extension id that is not an installed name is refused before any read', () => {
    const dir = workspace({
      [RECORDS]: records(record()),
      '.rundock/extensions/charts/ui/index.js': 'draw();',
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
      [RECORDS]: records(record({ name: 'my-ext', root: '.rundock/extensions/my-ext' })),
      '.rundock/extensions/my-ext/rundock.json': manifest('my-ext', { entry: 'ui/index.js', match: '*.chart' }),
      '.rundock/extensions/my-ext/ui/index.js': 'draw();',
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

// The floor every extension frame stands on. An extension that writes plain
// HTML should look like Rundock without doing anything, because tokens alone
// make good theming an achievement: somebody has to read them and map them,
// and an author who does not think about it writes a white panel that lands
// in a dark document and reads as broken rather than as somebody else's
// styling.
describe('an extension frame is given a floor, not only tokens', () => {
  function srcdocWith(baseRules) {
    const dom = new JSDOM(`<!doctype html><html><head>
      <style>:root{--base:#1A1A1A;--text-1:#F0EDE8;--border:#3D3D3D}</style>
      <style data-extension-base>${baseRules}</style>
      </head><body></body></html>`, { runScripts: 'outside-only' });
    return dom;
  }

  test('the base rules are inlined into the frame, between the tokens and the extension', async () => {
    const { buildRegionSrcdoc } = await host();
    const dom = srcdocWith('table { border-collapse: collapse; }');
    const doc = dom.window.document;
    const srcdoc = buildRegionSrcdoc({ entry: 'void 0;', styles: ['p { color: red; }'] }, doc);
    const tokensAt = srcdoc.indexOf('--text-1');
    const baseAt = srcdoc.indexOf('border-collapse');
    const ownAt = srcdoc.indexOf('color: red');
    assert.ok(tokensAt !== -1, 'the tokens are there');
    assert.ok(baseAt !== -1, 'and so is the floor');
    assert.ok(ownAt !== -1, 'and the extension\'s own styles');
    assert.ok(tokensAt < baseAt,
      'tokens first, because the floor is written in them and cannot read what is not yet declared');
    assert.ok(baseAt < ownAt,
      'the extension last, so it can override any of the floor deliberately: a floor that won would be a cage');
  });

  test('a frame is still built when there is no floor to give it', async () => {
    const { buildRegionSrcdoc } = await host();
    const dom = new JSDOM('<!doctype html><html><head><style>:root{--base:#111}</style></head><body></body></html>',
      { runScripts: 'outside-only' });
    const srcdoc = buildRegionSrcdoc({ entry: 'void 0;', styles: [] }, dom.window.document);
    assert.match(srcdoc, /--base/, 'tokens still reach it');
    assert.match(srcdoc, /void 0;/, 'and so does the entry');
    // A missing floor is a worse-looking extension, never a broken one.
  });

  test('a closing tag inside the floor cannot end the style element early', async () => {
    const { buildRegionSrcdoc } = await host();
    const dom = srcdocWith('p::after { content: "</style>"; }');
    const srcdoc = buildRegionSrcdoc({ entry: 'void 0;', styles: [] }, dom.window.document);
    assert.ok(!/content: "<\/style>"/.test(srcdoc),
      'neutralised the same way every other inlined text is, or the frame loses everything after it');
  });
});

// Confinement at the unit level. These are the fast failures when a
// guard is removed; the proof that the guards hold in a real engine is the
// confinement e2e, because jsdom enforces neither sandbox flags nor policy.
describe('a view cannot leave, cannot choose its file, and cannot open the web unasked', () => {
  test('open with no click opens nothing and is refused, naming the click', async () => {
    const { wire, opened, sent } = await mounted();
    wire({ type: 'open', target: '.mcp.json' });
    assert.deepStrictEqual(opened, [], 'a script-sent open must not reach the opener');
    assert.strictEqual(sent[0].type, 'refused');
    assert.strictEqual(sent[0].of, 'open');
    assert.match(sent[0].reason, /click/);
  });

  test('a second ready ends the view, and no second init is sent', async () => {
    const { wire, sent, degraded, handle } = await mounted();
    const { LEFT_VIEW_REASON } = await host();
    wire({ type: 'ready' });
    wire({ type: 'ready' });
    assert.strictEqual(sent.filter((m) => m.type === 'init').length, 1,
      'the page that replaced a departed frame says ready too, and must not be handed the file again');
    assert.deepStrictEqual(degraded, [LEFT_VIEW_REASON]);
    assert.strictEqual(handle.alive(), false);
  });

  test('a second load on the frame ends the view', async () => {
    const { frame, degraded, dom } = await mounted();
    const { LEFT_VIEW_REASON } = await host();
    // jsdom does not navigate srcdoc frames, so the two loads a real engine
    // fires (the srcdoc, then whatever replaced it) are dispatched here.
    frame.dispatchEvent(new dom.window.Event('load'));
    assert.deepStrictEqual(degraded, [], 'the first load is the frame arriving, not leaving');
    frame.dispatchEvent(new dom.window.Event('load'));
    assert.deepStrictEqual(degraded, [LEFT_VIEW_REASON]);
  });

  test('a theme rebuild is a new frame, entitled to its own ready and init', async () => {
    const { dom, handle, degraded } = await mounted();
    const first = handle.frame();
    const firstSent = [];
    first.contentWindow.postMessage = (m) => firstSent.push(m);
    let ev = new dom.window.Event('message'); ev.data = { type: 'ready' };
    Object.defineProperty(ev, 'source', { value: first.contentWindow }); dom.window.dispatchEvent(ev);
    dom.window.document.body.classList.add('light');
    await new Promise((r) => setTimeout(r, 0));
    const second = handle.frame();
    assert.notStrictEqual(second, first, 'the theme flip built a new frame');
    const secondSent = [];
    second.contentWindow.postMessage = (m) => secondSent.push(m);
    ev = new dom.window.Event('message'); ev.data = { type: 'ready' };
    Object.defineProperty(ev, 'source', { value: second.contentWindow }); dom.window.dispatchEvent(ev);
    assert.strictEqual(secondSent.filter((m) => m.type === 'init').length, 1);
    assert.deepStrictEqual(degraded, [], 'a rebuild is not the view leaving');
  });

  // ONE ACTIVATION IS ONE REQUEST. The browser's record of a click lasts
  // about five seconds and posting a message does not use it up, so without
  // this a single click let a view open a burst of files or tabs. After the
  // first, the person is asked about the next, and the rest wait.
  test('one click honours one open: the next is put to the person, and the rest are refused as waiting', async () => {
    const { REQUEST_REASONS } = await host();
    const { wire, opened, sent, activate, pane } = await mounted();
    activate();
    for (let i = 0; i < 6; i++) wire({ type: 'open', target: `notes/n${i}.md` });
    assert.deepStrictEqual(opened, ['notes/n0.md']);
    assert.strictEqual(sent.length, 4, 'the second waits on the person and says nothing yet');
    assert.ok(sent.every((m) => m.type === 'refused' && m.of === 'open' && m.reason === REQUEST_REASONS.waiting));
    const bars = pane.querySelectorAll('[data-extension-request="confirm"]');
    assert.strictEqual(bars.length, 1, 'one bar, whatever the burst');
    assert.match(bars[0].textContent, /Open n1\.md\?/);
  });

  test('open and openExternal share the activation: one of them, once', async () => {
    const { REQUEST_REASONS } = await host();
    const { wire, opened, externals, sent, activate, pane } = await mounted();
    activate();
    wire({ type: 'openExternal', url: 'https://example.org/' });
    wire({ type: 'open', target: 'notes/a.md' });
    wire({ type: 'openExternal', url: 'https://example.org/again' });
    assert.deepStrictEqual(externals, ['https://example.org/']);
    assert.deepStrictEqual(opened, []);
    assert.match(pane.querySelector('[data-extension-request="confirm"]').textContent, /Open a\.md\?/);
    assert.deepStrictEqual(sent.map((m) => [m.of, m.reason]), [['openExternal', REQUEST_REASONS.waiting]]);
  });

  test('a refused request does not use the click up', async () => {
    const { wire, externals, activate } = await mounted();
    activate();
    wire({ type: 'openExternal', url: 'javascript:alert(1)' });
    wire({ type: 'openExternal', url: 'https://example.org/' });
    assert.deepStrictEqual(externals, ['https://example.org/']);
  });

  test('a spent activation stays spent until the browser reports it lapsed, and the next click is honoured', async () => {
    const { requestStanding, spendActivation, LAPSE_POLL_MS } = await host();
    const { dom, frame, activate } = await mounted();
    activate();
    assert.strictEqual(requestStanding(dom.window, frame), 'click');
    spendActivation(dom.window);
    assert.strictEqual(requestStanding(dom.window, frame, Date.now() + 60000), 'confirm',
      'no clock releases it: the same activation, still live, is spent however long it has been');
    activate(false);
    await new Promise((r) => setTimeout(r, LAPSE_POLL_MS * 3));
    activate();
    assert.strictEqual(requestStanding(dom.window, frame), 'click', 'after the lapse a new click is a new one');
  });

  test('openExternal after a click hands an http(s) address to the opener, normalised', async () => {
    const { wire, externals, activate } = await mounted();
    activate();
    wire({ type: 'openExternal', url: 'https://example.org/a b' });
    assert.deepStrictEqual(externals, ['https://example.org/a%20b']);
  });

  test('openExternal with no click, or with any other scheme, is refused and opens nothing', async () => {
    const { wire, externals, sent, activate } = await mounted();
    wire({ type: 'openExternal', url: 'https://example.org/' });
    activate();
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'rundock://x', 'not a url']) {
      wire({ type: 'openExternal', url });
    }
    assert.deepStrictEqual(externals, []);
    assert.strictEqual(sent.length, 5);
    assert.ok(sent.every((m) => m.type === 'refused' && m.of === 'openExternal'));
    assert.match(sent[0].reason, /click/);
    assert.match(sent[1].reason, /http or https/);
  });

  // Measured in a real engine: the click in the file tree that opened a file
  // leaves the page activated for seconds, long enough for the view it
  // mounted to boot and ask to open something else.
  test('a click elsewhere on the page does not count as a click in the view', async () => {
    const { wire, opened, externals, sent, activate } = await mounted();
    activate(true, { elsewhere: true });
    wire({ type: 'open', target: 'notes/private.md' });
    wire({ type: 'openExternal', url: 'https://example.org/' });
    assert.deepStrictEqual(opened, []);
    assert.deepStrictEqual(externals, []);
    assert.ok(sent.every((m) => m.type === 'refused' && /click/.test(m.reason)));
  });

  // Measured in a real engine: a sandboxed frame can move focus into itself
  // with no click, so focus on the frame cannot stand in for a click in it.
  test('a view that grabs focus after a click on the page still cannot use that click', async () => {
    const { wire, opened, activate } = await mounted();
    activate(true, { elsewhere: true, focusStolen: true });
    wire({ type: 'open', target: 'notes/private.md' });
    assert.deepStrictEqual(opened, []);
  });

  // Each of the gate's three conditions has a case where it ALONE refuses,
  // so removing any one of them is noticed rather than covered by another.
  test('a view that takes focus with no click at all cannot open', async () => {
    const { wire, opened, setClickState } = await mounted();
    setClickState({ active: false, focused: true });
    wire({ type: 'open', target: 'notes/next.md' });
    assert.deepStrictEqual(opened, []);
  });

  test('a click in some other frame does not count for this one', async () => {
    // Activation with no page gesture behind it came from a frame, but not
    // necessarily this one: focus says which.
    const { wire, opened, setClickState } = await mounted();
    setClickState({ active: true, focused: false });
    wire({ type: 'open', target: 'notes/next.md' });
    assert.deepStrictEqual(opened, []);
  });

  test('a page with no gesture recorder cannot tell where a click was, so it acts on none', async () => {
    const { dom, wire, opened, activate } = await mounted();
    activate();
    delete dom.window.rundockLastHostGesture;
    wire({ type: 'open', target: 'notes/next.md' });
    assert.deepStrictEqual(opened, []);
  });

  test('the host reads the click from its own window, never from the message', async () => {
    const { wire, opened } = await mounted();
    wire({ type: 'open', target: 'Projects/plan.md', userActivation: true, clicked: true });
    assert.deepStrictEqual(opened, [], 'nothing the frame says can stand in for a click the browser did not record');
  });
});


// ---- Named sources, host side ----
const SRC_PAYLOAD = { ...PAYLOAD, writes: true, sources: true };
const NOTE = '---\nportfolio-dashboard: true\nsources:\n  - a.csv\n  - b.csv\n---\n# Dash\n';
const HANDED = [{ path: 'a.csv', content: 'x,y\n', extra: 'never sent', real: '/abs/a.csv' }, { path: 'b.csv', refused: 'a linked file, or a file in a linked folder, is never handed to an extension' }];

describe('named sources in the host', () => {
  function srcMount(opts = {}) {
    const calls = { saved: [], changed: [] };
    return mounted({ path: 'dash.md', content: NOTE, payload: opts.payload || SRC_PAYLOAD, embedded: opts.embedded,
      extra: { sources: HANDED, onSaveSource: (p, c) => calls.saved.push([p, c]), onChangeSource: (p, c) => calls.changed.push([p, c]) } })
      .then((m) => ({ ...m, calls }));
  }

  test('init carries exactly each source\'s name and text, or name and reason, and nothing else', async () => {
    const { wire, sent } = await srcMount();
    wire({ type: 'ready' });
    assert.deepStrictEqual(sent[0].sources, [{ path: 'a.csv', content: 'x,y\n' }, { path: 'b.csv', refused: HANDED[1].refused }]);
  });

  test('an extension that did not declare sources is handed none, whatever the caller passes', async () => {
    const { wire, sent } = await srcMount({ payload: { ...PAYLOAD, writes: true } });
    wire({ type: 'ready' });
    assert.deepStrictEqual(sent[0].sources, []);
  });

  test('an embedded view is handed none and every source write from it is refused', async () => {
    const { wire, sent, calls } = await srcMount({ embedded: true });
    wire({ type: 'ready' });
    assert.deepStrictEqual(sent[0].sources, []);
    wire({ type: 'saveSource', source: 'a.csv', content: 'z' });
    wire({ type: 'changeSource', source: 'a.csv', content: 'z' });
    assert.deepStrictEqual(calls, { saved: [], changed: [] });
    assert.deepStrictEqual(sent.slice(1).map((m) => [m.of, m.reason]), [['saveSource', 'this view has no sources'], ['changeSource', 'this view has no sources']]);
  });

  test('saveSource and changeSource reach the writer only for a listed, handed source, and only with writes', async () => {
    const { wire, sent, calls } = await srcMount();
    wire({ type: 'saveSource', source: 'a.csv', content: '1,2\n' });
    wire({ type: 'changeSource', source: 'a.csv', content: '3,4\n' });
    for (const source of ['b.csv', 'c.csv', '.env', 'A.CSV', './a.csv']) wire({ type: 'saveSource', source, content: 'PWNED' });
    assert.deepStrictEqual(calls, { saved: [['a.csv', '1,2\n']], changed: [['a.csv', '3,4\n']] });
    assert.ok(sent.every((m) => m.type === 'refused' && m.reason === 'the note does not list that file as a source'));
    assert.strictEqual(sent.length, 5);
    const ro = await srcMount({ payload: { ...SRC_PAYLOAD, writes: false } });
    ro.wire({ type: 'saveSource', source: 'a.csv', content: 'z' });
    assert.deepStrictEqual(ro.calls.saved, []);
    assert.match(ro.sent[0].reason, /did not declare writes/);
  });

  test('no read, list or search message exists: each is refused as an unknown type', async () => {
    const { wire, sent } = await srcMount();
    for (const type of ['read', 'readSource', 'listSources', 'sources', 'search']) wire({ type, path: '.env' });
    assert.deepStrictEqual(sent.map((m) => m.of), ['read', 'readSource', 'listSources', 'sources', 'search']);
    assert.ok(sent.every((m) => m.type === 'refused'));
  });

  test('no write may change the sources list of the file it writes, declaring sources or not', async () => {
    for (const payload of [SRC_PAYLOAD, { ...PAYLOAD, writes: true }]) {
      const { wire, sent, saved } = await mounted({ path: 'dash.md', content: NOTE, payload });
      const widened = NOTE.replace('  - b.csv', '  - .env');
      wire({ type: 'save', content: widened });
      wire({ type: 'change', content: widened });
      assert.deepStrictEqual(saved, []);
      assert.deepStrictEqual(sent.map((m) => [m.of, m.reason]), [['save', 'a view cannot change which files a note lists as sources'], ['change', 'a view cannot change which files a note lists as sources']]);
      wire({ type: 'save', content: NOTE.replace('# Dash', '# Dash, edited') });
      assert.strictEqual(saved.length, 1, 'an edit that keeps the list is written');
    }
  });

  test('a source that is a note cannot have its list changed through saveSource', async () => {
    const note = '---\nsources:\n  - c.csv\n---\nsub\n';
    const calls = [];
    const { wire, sent } = await mounted({ path: 'dash.md', content: NOTE, payload: SRC_PAYLOAD,
      extra: { sources: [{ path: 'sub.md', content: note }], onSaveSource: (p, c) => calls.push(c) } });
    wire({ type: 'saveSource', source: 'sub.md', content: note.replace('c.csv', '.env') });
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(sent[0].reason, 'a view cannot change which files a note lists as sources');
  });

  test('with no grammar on the page to check against, every write is refused', async () => {
    const { dom, wire, sent, saved } = await mounted({ payload: { ...PAYLOAD, writes: true } });
    delete dom.window.RundockNamedSources;
    wire({ type: 'save', content: 'a,b\n' });
    assert.deepStrictEqual(saved, []);
    assert.match(sent[0].reason, /could not check this write/);
  });

  test('updateSources replaces the list, tells a frame that has had its init, and moves what may be written', async () => {
    const { handle, wire, sent, calls } = await srcMount();
    handle.updateSources([{ path: 'b.csv', content: 'fresh', real: '/abs' }]);
    assert.deepStrictEqual(sent, [], 'before init, init carries it');
    wire({ type: 'ready' });
    assert.deepStrictEqual(sent[0].sources, [{ path: 'b.csv', content: 'fresh' }]);
    handle.updateSources([{ path: 'a.csv', content: 'again' }]);
    assert.deepStrictEqual(sent[1], { type: 'sources', sources: [{ path: 'a.csv', content: 'again' }] });
    wire({ type: 'saveSource', source: 'b.csv', content: 'z' });
    assert.deepStrictEqual(calls.saved, [], 'b.csv is no longer on the list');
  });
});

// ---- Asking an agent, host side ----
describe('ask in the host', () => {
  const ASK_PAYLOAD = { ...PAYLOAD, asks: ['wren', 'ghost'] };
  async function askMount(opts = {}) {
    const asked = [];
    const m = await mounted({ payload: ASK_PAYLOAD, embedded: opts.embedded,
      extra: { onAsk: (agent, message) => { if (agent === 'ghost') return 'there is no agent called ghost on this team'; asked.push({ agent, message }); return null; } } });
    return { ...m, asked };
  }

  test('without a click an ask drafts nothing and is refused, naming the click', async () => {
    const { wire, sent, asked, activate } = await askMount();
    wire({ type: 'ask', agent: 'wren', message: 'hi' });
    activate(true, { elsewhere: true });
    wire({ type: 'ask', agent: 'wren', message: 'hi' });
    assert.deepStrictEqual(asked, []);
    assert.deepStrictEqual(sent.map((m) => m.reason), ['Rundock stopped this because it did not come from your click', 'Rundock stopped this because it did not come from your click']);
  });

  test('after a click one ask is honoured, cleaned, and nothing is posted back', async () => {
    const { wire, sent, asked, activate } = await askMount();
    activate();
    wire({ type: 'ask', agent: 'wren', message: 'Sum\u202eup\u200b the \u0007risk\tnow\n' });
    assert.deepStrictEqual(asked, [{ agent: 'wren', message: 'Sumup the risk\tnow\n' }]);
    assert.deepStrictEqual(sent, [], 'the host says nothing on success');
  });

  test('one click is one ask: a burst drafts one, the next is put to the person, the rest wait', async () => {
    const { REQUEST_REASONS } = await host();
    const { wire, sent, asked, activate, pane } = await askMount();
    activate();
    for (let i = 0; i < 6; i++) wire({ type: 'ask', agent: 'wren', message: `m${i}` });
    assert.deepStrictEqual(asked.map((a) => a.message), ['m0']);
    assert.strictEqual(sent.filter((m) => m.reason === REQUEST_REASONS.waiting).length, 4);
    assert.match(pane.querySelector('[data-extension-request="confirm"]').textContent,
      /Start a conversation with wren with a drafted message\?/);
  });

  test('a refused first ask still uses the click, so one click cannot probe several names', async () => {
    const { wire, sent, asked, activate, pane } = await askMount();
    activate();
    wire({ type: 'ask', agent: 'cos', message: 'hi' });
    wire({ type: 'ask', agent: 'wren', message: 'hi' });
    assert.deepStrictEqual(asked, []);
    assert.deepStrictEqual(sent.map((m) => m.reason), ['this extension did not declare that agent in its manifest']);
    assert.ok(pane.querySelector('[data-extension-request="confirm"]'), 'the second is the person\'s to answer, not the view\'s');
  });

  test('the person is never asked about an agent the manifest did not declare', async () => {
    const { wire, sent, asked, activate, pane } = await askMount();
    activate();
    wire({ type: 'ask', agent: 'wren', message: 'hi' });
    wire({ type: 'ask', agent: 'cos', message: 'hi' });
    assert.deepStrictEqual(asked.map((a) => a.agent), ['wren']);
    assert.deepStrictEqual(sent.map((m) => m.reason), ['this extension did not declare that agent in its manifest']);
    assert.strictEqual(pane.querySelector('[data-extension-request]'), null);
  });

  test('undeclared names, prototype names included, are refused; a declared one not on the team says so', async () => {
    for (const agent of ['cos', 'constructor', '__proto__', 'tostring', 'hasownproperty']) {
      const { wire, sent, asked, activate } = await askMount();
      activate();
      wire({ type: 'ask', agent, message: 'hi' });
      assert.deepStrictEqual(asked, [], agent);
      assert.strictEqual(sent[0].reason, 'this extension did not declare that agent in its manifest', agent);
    }
    const { wire, sent, asked, activate } = await askMount();
    activate();
    wire({ type: 'ask', agent: 'ghost', message: 'hi' });
    assert.deepStrictEqual(asked, []);
    assert.strictEqual(sent[0].reason, 'there is no agent called ghost on this team');
  });

  test('a malformed ask is refused by shape even after a click', async () => {
    for (const bad of [{ agent: ['wren'], message: 'hi' }, { agent: 'wren' }, { agent: 'wren', message: '' }, { agent: 'wren', message: 'x'.repeat(4001) }, { agent: 'Wren', message: 'hi' }]) {
      const { wire, sent, asked, activate } = await askMount();
      activate();
      wire({ type: 'ask', ...bad });
      assert.deepStrictEqual(asked, [], JSON.stringify(bad));
      assert.ok(sent[0].of === 'ask' && !/click/.test(sent[0].reason), JSON.stringify(bad));
    }
  });

  test('a malformed first ask still uses the click, so a valid one after it is not honoured', async () => {
    const { wire, sent, asked, activate, pane } = await askMount();
    activate();
    wire({ type: 'ask', agent: 'wren' });
    wire({ type: 'ask', agent: 'wren', message: 'the one that would have been honoured' });
    assert.deepStrictEqual(asked, []);
    assert.strictEqual(sent.length, 1, 'only the malformed ask is answered');
    assert.ok(pane.querySelector('[data-extension-request="confirm"]'), 'the valid one waits on the person');
  });

  test('a malformed ask with no click spends nothing, so the next real click is honoured', async () => {
    const { wire, asked, activate } = await askMount();
    wire({ type: 'ask', agent: 'wren' });
    activate();
    wire({ type: 'ask', agent: 'wren', message: 'ok' });
    assert.deepStrictEqual(asked, [{ agent: 'wren', message: 'ok' }]);
  });

  test('an embedded view cannot ask', async () => {
    const { wire, sent, asked, activate } = await askMount({ embedded: true });
    activate();
    wire({ type: 'ask', agent: 'wren', message: 'hi' });
    assert.deepStrictEqual(asked, []);
    assert.strictEqual(sent[0].reason, 'an embedded view cannot ask an agent; open this file to use it');
  });

  test('an ask and an open share one click', async () => {
    const { wire, asked, opened, activate } = await askMount();
    activate();
    wire({ type: 'open', target: 'n.md' });
    wire({ type: 'ask', agent: 'wren', message: 'hi' });
    assert.deepStrictEqual(opened, ['n.md']);
    assert.deepStrictEqual(asked, []);
  });

  test('cleanAskMessage removes each range and keeps tab and newline', async () => {
    const { cleanAskMessage } = await host();
    const removed = ['\u0000', '\u0008', '\u000b', '\u001f', '\u007f', '\u0085', '\u009f', '\u061c', '\u200b', '\u200e', '\u200f', '\u202a', '\u202e', '\u2060', '\u2066', '\u2069', '\ufeff'];
    for (const c of removed) assert.strictEqual(cleanAskMessage(`a${c}b`), 'ab', JSON.stringify(c));
    assert.strictEqual(cleanAskMessage('a\tb\nc'), 'a\tb\nc');
  });
});

// ONE ACTIVATION, ONE REQUEST, ACROSS EVERY FRAME. Two views in one window,
// the way the page holds them: the one a click opened, and the one it opened.
describe('one activation authorises one request across every frame, and the rest is put to the person', () => {
  async function page() {
    const host_ = await host();
    const { dom, pane } = shell();
    const win = dom.window;
    let active = false;
    let focused = null;
    Object.defineProperty(win.navigator, 'userActivation', { configurable: true, get: () => ({ isActive: active, hasBeenActive: active }) });
    Object.defineProperty(win.document, 'activeElement', { configurable: true, get: () => focused || win.document.body });
    win.rundockLastHostGesture = -Infinity;
    const done = { opened: [], externals: [], asked: [] };
    function mount(name) {
      const sent = [];
      const handle = host_.mountExtension({
        paneElement: pane, payload: { ...PAYLOAD, asks: ['wren'] }, path: `notes/${name}.md`, content: 'x',
        extensionName: 'csv-echo',
        agentName: (id) => (id === 'wren' ? 'Wren' : null),
        onOpen: (t) => done.opened.push(t),
        onOpenExternal: (u) => done.externals.push(u),
        onAsk: (agent, message) => { done.asked.push({ agent, message }); return null; },
        onDegrade: () => {},
      });
      const frame = handle.frame();
      frame.contentWindow.postMessage = (m) => sent.push(m);
      const wire = (data) => {
        const ev = new win.Event('message');
        ev.data = data;
        Object.defineProperty(ev, 'source', { value: frame.contentWindow });
        win.dispatchEvent(ev);
      };
      return { handle, frame, sent, wire };
    }
    return {
      host: host_, win, pane, done, mount,
      click: (view) => { active = true; focused = view.frame; },
      selfFocus: (view) => { focused = view ? view.frame : null; },
      lapse: async () => { active = false; await new Promise((r) => setTimeout(r, host_.LAPSE_POLL_MS * 3)); },
    };
  }

  test('a view opened by another view\'s click cannot use that click, whatever it sends, and the person is asked about the first', async () => {
    const p = await page();
    const a = p.mount('a');
    p.click(a);
    a.wire({ type: 'open', target: 'notes/b.md' });
    assert.deepStrictEqual(p.done.opened, ['notes/b.md'], 'the click in A is honoured');
    a.handle.teardown();
    const b = p.mount('b');
    p.selfFocus(b);
    b.wire({ type: 'open', target: 'notes/c.md' });
    b.wire({ type: 'openExternal', url: 'https://example.org/' });
    b.wire({ type: 'ask', agent: 'wren', message: 'hi' });
    assert.deepStrictEqual(p.done, { opened: ['notes/b.md'], externals: [], asked: [] }, 'nothing happens');
    const bars = p.pane.querySelectorAll('[data-extension-request]');
    assert.strictEqual(bars.length, 1);
    assert.strictEqual(bars[0].getAttribute('data-extension-request'), 'confirm');
    assert.strictEqual(bars[0].querySelector('.rui-alert-message').textContent, 'Open c.md?');
    assert.deepStrictEqual(b.sent.map((m) => m.reason), [p.host.REQUEST_REASONS.waiting, p.host.REQUEST_REASONS.waiting]);
  });

  test('a view mounted while any activation is live inherits it, even one nothing spent', async () => {
    const p = await page();
    const a = p.mount('a');
    p.click(a);
    const b = p.mount('b');
    p.selfFocus(b);
    assert.strictEqual(p.host.requestStanding(p.win, b.frame), 'confirm');
    assert.strictEqual(p.host.requestStanding(p.win, a.frame), 'refuse', 'and A, no longer focused, is not clicked either');
  });

  test('once the activation lapses, the new view\'s first click is its own', async () => {
    const p = await page();
    const a = p.mount('a');
    p.click(a);
    a.wire({ type: 'open', target: 'notes/b.md' });
    a.handle.teardown();
    const b = p.mount('b');
    await p.lapse();
    p.click(b);
    b.wire({ type: 'open', target: 'notes/c.md' });
    assert.deepStrictEqual(p.done.opened, ['notes/b.md', 'notes/c.md']);
    assert.deepStrictEqual(b.sent, []);
    assert.strictEqual(p.pane.querySelector('[data-extension-request]'), null);
  });

  test('the bar is the page\'s: above the frame, outside the frame\'s document, with no page global added', async () => {
    const p = await page();
    const a = p.mount('a');
    p.click(a);
    a.wire({ type: 'openExternal', url: 'https://example.org/one' });
    a.wire({ type: 'openExternal', url: 'https://example.org/two' });
    const bar = p.pane.querySelector('[data-extension-request="confirm"]');
    assert.strictEqual(bar.nextElementSibling, a.frame, 'directly above the frame');
    assert.strictEqual(bar.ownerDocument, p.win.document);
    assert.ok(bar.classList.contains('rui-alert') && bar.classList.contains('extension-request'));
    assert.strictEqual(bar.querySelector('.rui-alert-message').textContent, 'Open https://example.org/two in a new tab?');
    assert.deepStrictEqual([...bar.querySelectorAll('button')].map((b) => [b.textContent, b.className]),
      [['Open', 'rui-btn rui-btn-primary'], ['Dismiss', 'rui-btn rui-btn-secondary']]);
    assert.strictEqual(p.win.Rundock, undefined, 'Rundock UI was bound privately, not installed on the page');
  });

  test('only a trusted press on an armed bar acts: a scripted click, or one before it has been on screen long enough, does nothing', async () => {
    const p = await page();
    const a = p.mount('a');
    p.click(a);
    a.wire({ type: 'openExternal', url: 'https://example.org/one' });
    a.wire({ type: 'openExternal', url: 'https://example.org/two' });
    const bar = p.pane.querySelector('[data-extension-request="confirm"]');
    const [open, dismiss] = bar.querySelectorAll('button');
    assert.strictEqual(open.disabled, true, 'unarmed at first');
    await new Promise((r) => setTimeout(r, p.host.BAR_ARM_MS + 50));
    assert.strictEqual(open.disabled, false, 'armed after BAR_ARM_MS');
    open.click();
    dismiss.click();
    open.dispatchEvent(new p.win.MouseEvent('click', { bubbles: true }));
    assert.deepStrictEqual(p.done.externals, ['https://example.org/one'], 'no scripted event performs the request');
    assert.ok(p.pane.querySelector('[data-extension-request="confirm"]'), 'and none clears it');
  });

  test('a request with no click at all is refused, and the person is told what was stopped, in the same place', async () => {
    const p = await page();
    const a = p.mount('a');
    a.wire({ type: 'open', target: 'Investments/Investment Dashboard.md' });
    let line = p.pane.querySelector('[data-extension-request="refused"]');
    assert.strictEqual(line.querySelector('.rui-alert-message').textContent,
      'The csv-echo extension tried to open Investment Dashboard.md without you asking, so Rundock stopped it.');
    assert.strictEqual(line.nextElementSibling, a.frame);
    a.wire({ type: 'openExternal', url: 'https://example.org/' });
    a.wire({ type: 'ask', agent: 'wren', message: 'hi' });
    line = p.pane.querySelectorAll('[data-extension-request]');
    assert.strictEqual(line.length, 1, 'one line, the latest');
    assert.strictEqual(line[0].querySelector('.rui-alert-message').textContent,
      'The csv-echo extension tried to start a conversation with Wren without you asking, so Rundock stopped it.');
    assert.deepStrictEqual(a.sent.map((m) => m.of), ['open', 'openExternal', 'ask']);
  });

  test('a waiting request is never replaced by a refusal line, and leaving the view clears the bar', async () => {
    const p = await page();
    const a = p.mount('a');
    p.click(a);
    a.wire({ type: 'openExternal', url: 'https://example.org/one' });
    a.wire({ type: 'openExternal', url: 'https://example.org/two' });
    p.selfFocus(null);
    a.wire({ type: 'open', target: 'notes/x.md' });
    assert.strictEqual(p.pane.querySelectorAll('[data-extension-request]').length, 1);
    assert.ok(p.pane.querySelector('[data-extension-request="confirm"]'));
    a.handle.teardown();
    assert.strictEqual(p.pane.querySelector('[data-extension-request]'), null, 'navigation clears it');
  });

  test('a lapse seen when a request is read releases the marks at once, without waiting for the poll', async () => {
    const p = await page();
    const a = p.mount('a');
    p.click(a);
    p.host.spendActivation(p.win);
    const b = p.mount('b');
    p.selfFocus(b);
    assert.strictEqual(p.host.requestStanding(p.win, b.frame), 'confirm');
    // The browser reports the lapse; the very next read sees it.
    Object.defineProperty(p.win.navigator, 'userActivation', { configurable: true, get: () => ({ isActive: false, hasBeenActive: true }) });
    assert.strictEqual(p.host.requestStanding(p.win, b.frame), 'refuse');
    Object.defineProperty(p.win.navigator, 'userActivation', { configurable: true, get: () => ({ isActive: true, hasBeenActive: true }) });
    assert.strictEqual(p.host.requestStanding(p.win, b.frame), 'click', 'a new click in B, well inside the poll interval, is B\'s own');
  });

  test('the words name what the request names', async () => {
    const { confirmWords, refusalWords } = await host();
    assert.strictEqual(confirmWords('open', { target: 'Investment Dashboard.md' }), 'Open Investment Dashboard.md?');
    assert.strictEqual(confirmWords('openExternal', { url: 'https://example.org/' }), 'Open https://example.org/ in a new tab?');
    assert.strictEqual(confirmWords('ask', { agentName: 'Wren' }), 'Start a conversation with Wren with a drafted message?');
    assert.strictEqual(refusalWords('openExternal', { url: 'https://example.org/' }, 'csv-echo'),
      'The csv-echo extension tried to open https://example.org/ without you asking, so Rundock stopped it.');
    assert.strictEqual(refusalWords('open', { target: 'a.md' }, ''), 'This extension tried to open a.md without you asking, so Rundock stopped it.');
  });
});
