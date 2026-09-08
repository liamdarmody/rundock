'use strict';
// The extension host, wired into the client.
//
// The host, the registry and the file view's seam shipped as modules with
// three joins deliberately left open: nothing hydrated the registry, nothing
// registered a transport, and nothing tore a mount down when the workspace
// or the roster changed. This file drives the joins the way they run in the
// product: the wiring is cut out of app.js and files.js and run in a window
// with a stub socket, so the code under test is the code that ships, and a
// renamed or deleted piece fails here by name rather than testing nothing.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const APP_SRC = read('public', 'app.js');
const FILES_SRC = read('public', 'views', 'files.js');

/**
 * A named piece of source, cut out so it can be RUN rather than matched. The
 * extraction asserts the piece EXISTS, so a renamed or deleted one fails
 * here instead of yielding an empty body that passes every assertion about
 * what it did not do.
 */
function appPiece(src, pattern, label) {
  const found = src.match(pattern);
  assert.ok(found && found[1] && found[1].trim(), `the client no longer carries ${label}`);
  return found[1];
}

const fn = (name) => new RegExp(`(function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\})`);
const arm = (type) => new RegExp(`(case '${type}': [\\s\\S]*? break;)`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Route a message through the cut dispatch, then wait for the registry
// global to move: the arm returns nothing, as the real switch returns
// nothing, so the settling is observed rather than awaited.
async function dispatched(w, api, message) {
  const before = w.rundockRendererRegistry;
  api.handle(message);
  for (let i = 0; i < 100 && w.rundockRendererRegistry === before; i += 1) await sleep(5);
  assert.notStrictEqual(w.rundockRendererRegistry, before, `${message.type} installed a registry`);
}

// ===== THE CLIENT WIRING, CUT OUT AND RUN =====

// Every piece is evaluated in ONE call, because a const declared by one
// indirect eval is invisible to the next; the pieces then hand themselves
// back on the window.
const WIRING_FUNCTIONS = [
  'loadRendererRegistryModule', 'installRendererRegistry', 'extensionRosterArrived',
  'extensionRosterFailed', 'extensionUiKey', 'requestExtensionUi',
  'extensionUiReplyArrived', 'extensionFetchesConnectionLost',
];
const WIRING_ARMS = ['extensions', 'extensions_error', 'extension_ui', 'extension_ui_error'];

function clientWindow({ registryLoader } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously' });
  const w = dom.window;
  const sent = [];
  const reconciled = [];
  w.ws = { send: (m) => sent.push(JSON.parse(m)) };
  w.reconcileExtensionMount = (roster) => { reconciled.push(roster); return { action: 'none' }; };
  w.rundockRendererRegistryLoader = registryLoader || (() => import('../../public/renderer-registry.js'));
  const pieces = [
    appPiece(APP_SRC, /(const EXTENSION_UI_TIMEOUT_MS = \d+;)/, 'the exported fetch timeout'),
    appPiece(APP_SRC, /(let extensionRosterSeq = 0;)/, 'the roster sequence'),
    appPiece(APP_SRC, /(const extensionUiWaiters = new Map\(\);)/, 'the fetch waiters'),
    ...WIRING_FUNCTIONS.map((name) => appPiece(APP_SRC, fn(name), name)),
    appPiece(APP_SRC, /(window\.rundockExtensionUiFetcher = requestExtensionUi;)/, 'the fetcher global assignment'),
    // The dispatch arms, wrapped back into a switch so a message is routed
    // exactly as handle() routes it.
    `function handle(d) { switch (d.type) { ${WIRING_ARMS.map((t) => appPiece(APP_SRC, arm(t), `the ${t} dispatch arm`)).join('\n')} } }`,
    `window.__wiring = { ${WIRING_FUNCTIONS.join(', ')}, handle, EXTENSION_UI_TIMEOUT_MS };`,
  ];
  w.eval(pieces.join('\n'));
  return { w, sent, reconciled, api: w.__wiring };
}

const ROSTER_A = [{ id: 'csv-echo', version: '1.0.0', enabled: true, renderers: [{ id: 'view', target: '.csv' }] }];
const ROSTER_B = [{ id: 'charts', version: '2.0.0', enabled: true, renderers: [{ id: 'view', target: '.chart' }] }];

describe('a roster reply hydrates the registry global', () => {
  test('the roster is registered through the registry module\'s own constructor and assigned to the global', async () => {
    const { w, api, reconciled } = clientWindow();
    await dispatched(w, api, { type: 'extensions', extensions: ROSTER_A });
    const registry = w.rundockRendererRegistry;
    assert.ok(registry && typeof registry.rendererFor === 'function', 'the global holds a registry');
    assert.deepStrictEqual(registry.rendererFor('data/sales.csv'),
      { registered: true, extension: 'csv-echo', renderer: 'view' },
      'a file whose extension the roster claims answers registered from the global');
    assert.strictEqual(registry.rendererFor('notes.md').registered, false);
    assert.deepStrictEqual(reconciled, [ROSTER_A], 'every roster arrival reconciles the live mount');
  });

  test('the next workspace\'s roster replaces the registry rather than merging into it', async () => {
    const { w, api } = clientWindow();
    await dispatched(w, api, { type: 'extensions', extensions: ROSTER_A });
    await dispatched(w, api, { type: 'extensions', extensions: ROSTER_B });
    assert.strictEqual(w.rundockRendererRegistry.rendererFor('a.csv').registered, false,
      'a target claimed only in the old workspace is gone');
    assert.strictEqual(w.rundockRendererRegistry.rendererFor('a.chart').registered, true);
  });

  test('a later roster wins even when the earlier one\'s registry module resolves last', async () => {
    // The registry module loads asynchronously, so two rosters in flight can
    // resolve out of order. The sequence guard makes the LAST arrival the
    // one that answers, whatever order the promises settle in.
    let calls = 0;
    const slowThenFast = () => {
      calls += 1;
      const delay = calls === 1 ? 40 : 0;
      return sleep(delay).then(() => import('../../public/renderer-registry.js'));
    };
    const { w, api } = clientWindow({ registryLoader: slowThenFast });
    api.handle({ type: 'extensions', extensions: ROSTER_A });
    api.handle({ type: 'extensions', extensions: ROSTER_B });
    await sleep(120);
    assert.strictEqual(calls, 2, 'both rosters loaded the module');
    assert.strictEqual(w.rundockRendererRegistry.rendererFor('a.chart').registered, true, 'the later roster answers');
    assert.strictEqual(w.rundockRendererRegistry.rendererFor('a.csv').registered, false,
      'the earlier roster, resolving last, did not overwrite it');
  });

  test('a roster error installs an empty registry carrying the reason, never the previous registry', async () => {
    const { w, api, reconciled } = clientWindow();
    await dispatched(w, api, { type: 'extensions', extensions: ROSTER_A });
    await dispatched(w, api, { type: 'extensions_error', reason: 'extension records unreadable: bad json' });
    const registry = w.rundockRendererRegistry;
    const answer = registry.rendererFor('a.csv');
    assert.strictEqual(answer.registered, false, 'the old workspace\'s claim is gone');
    assert.match(answer.reason, /records unreadable/, 'the answer carries the server\'s reason');
    assert.strictEqual(registry.unavailable(), 'extension records unreadable: bad json');
    assert.deepStrictEqual(registry.targets(), []);
    assert.strictEqual(reconciled.length, 1,
      'an unreadable roster says nothing about the mounted extension, so it is not reconciled against nothing');
  });
});

describe('the roster is requested with the rest of the workspace', () => {
  // onWorkspaceReady, cut out and run with every collaborator stubbed, so
  // the batch it sends is read off the stub socket rather than inferred
  // from the source.
  function openWorkspace({ current, next }) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously' });
    const w = dom.window;
    const sent = [];
    const calls = [];
    w.ws = { send: (m) => sent.push(JSON.parse(m).type) };
    for (const name of ['setServingWorkspace', 'setWorkspaceChrome', 'packagesWorkspaceChanged',
      'connectorsWorkspaceChanged', 'renderListPills', 'updateUnreadBadge', 'updateWorkingBadge',
      'resetSidebarForWorkspace', 'requestPins']) {
      w[name] = () => calls.push(name);
    }
    w.closeOpenFile = () => calls.push('closeOpenFile');
    w.unread = { clearAll() {} };
    w.workingConvos = { clear() {} };
    w.convoState = {};
    w.currentWorkspacePath = current;
    w.currentView = 'files';
    w.eval(appPiece(APP_SRC, fn('onWorkspaceReady'), 'onWorkspaceReady'));
    w.onWorkspaceReady(next, null, false, 'knowledge', null, true);
    return { sent, calls };
  }

  test('opening a workspace asks for the roster in the same batch as agents and files', () => {
    const { sent } = openWorkspace({ current: null, next: '/ws/a' });
    assert.ok(sent.includes('get_agents') && sent.includes('get_files'), 'the batch the criteria name');
    assert.ok(sent.includes('list_extensions'), 'the roster request rides the same batch');
    assert.strictEqual(sent.filter((t) => t === 'list_extensions').length, 1, 'asked once per open');
  });

  test('a different workspace closes the open file before anything of the new one draws; the same workspace keeps it', () => {
    const switched = openWorkspace({ current: '/ws/a', next: '/ws/b' });
    assert.ok(switched.calls.includes('closeOpenFile'),
      'closeOpenFile runs on a workspace change, and it is what releases the live mount');
    assert.ok(switched.calls.indexOf('closeOpenFile') < switched.calls.indexOf('resetSidebarForWorkspace'),
      'the file is closed before the shell is redrawn for the new workspace');
    const same = openWorkspace({ current: '/ws/a', next: '/ws/a' });
    assert.ok(!same.calls.includes('closeOpenFile'), 'a reconnect to the same workspace keeps the reader\'s place');
  });
});

describe('the transport sends get_extension_ui and forwards the reply as is', () => {
  test('the global is the fetcher, and a success reply resolves with the entry intact', async () => {
    const { w, api, sent } = clientWindow();
    assert.strictEqual(w.rundockExtensionUiFetcher, api.requestExtensionUi, 'the seam\'s global is the transport');
    const pending = w.rundockExtensionUiFetcher('csv-echo', 'view');
    assert.deepStrictEqual(sent, [{ type: 'get_extension_ui', extensionId: 'csv-echo', rendererId: 'view' }]);
    const reply = { type: 'extension_ui', extensionId: 'csv-echo', rendererId: 'view', entry: 'draw();', styles: [], resources: [] };
    api.handle(reply);
    assert.deepStrictEqual(await pending, reply, 'the server message is forwarded verbatim; the seam decides from the entry');
  });

  test('an error reply resolves with an object carrying the server\'s reason', async () => {
    const { w, api } = clientWindow();
    const pending = w.rundockExtensionUiFetcher('csv-echo', 'view');
    api.handle({ type: 'extension_ui_error', extensionId: 'csv-echo', rendererId: 'view', reason: 'the renderer entry could not be read' });
    const got = await pending;
    assert.strictEqual(got.reason, 'the renderer entry could not be read');
    assert.strictEqual(typeof got.entry, 'undefined', 'no entry, so the seam degrades with the reason beside the plain rendering');
  });

  test('two fetches in flight each resolve with the reply naming their own ids, in either order', async () => {
    const { w, api } = clientWindow();
    const a = w.rundockExtensionUiFetcher('csv-echo', 'view');
    const b = w.rundockExtensionUiFetcher('charts', 'view');
    const c = w.rundockExtensionUiFetcher('csv-echo', 'other');
    api.handle({ type: 'extension_ui', extensionId: 'csv-echo', rendererId: 'other', entry: 'C' });
    api.handle({ type: 'extension_ui', extensionId: 'charts', rendererId: 'view', entry: 'B' });
    api.handle({ type: 'extension_ui', extensionId: 'csv-echo', rendererId: 'view', entry: 'A' });
    assert.strictEqual((await a).entry, 'A');
    assert.strictEqual((await b).entry, 'B');
    assert.strictEqual((await c).entry, 'C', 'correlated by extension id plus renderer id, never one alone');
  });

  test('a reply that never arrives resolves with a reason once the exported timeout elapses', async () => {
    const { w, api } = clientWindow();
    assert.ok(Number.isInteger(api.EXTENSION_UI_TIMEOUT_MS) && api.EXTENSION_UI_TIMEOUT_MS > 0);
    const pending = api.requestExtensionUi('csv-echo', 'view', 20);
    const outcome = await Promise.race([pending, sleep(300).then(() => 'never')]);
    assert.notStrictEqual(outcome, 'never', 'the fetch settles by the clock, so the plain surface appears instead of a blank pane');
    assert.match(outcome.reason, /20ms/, 'the reason names the wait');
    assert.strictEqual(typeof outcome.entry, 'undefined');
    // A reply arriving after the clock finds no waiter and changes nothing.
    assert.doesNotThrow(() => api.handle({ type: 'extension_ui', extensionId: 'csv-echo', rendererId: 'view', entry: 'late' }));
    assert.ok(w.rundockExtensionUiFetcher, 'the transport is still registered');
  });

  test('a closed socket settles every fetch in flight with a reason', async () => {
    const { w, api } = clientWindow();
    const a = w.rundockExtensionUiFetcher('csv-echo', 'view');
    const b = w.rundockExtensionUiFetcher('charts', 'view');
    api.extensionFetchesConnectionLost();
    for (const p of [a, b]) {
      const got = await Promise.race([p, sleep(300).then(() => 'never')]);
      assert.match(got.reason, /connection/, 'the reason names the closed connection');
    }
    assert.match(APP_SRC, /ws\.onclose = \(\) => \{[^\n]*extensionFetchesConnectionLost\(\);/,
      'the socket\'s own close handler is what settles them');
  });

  test('a socket that cannot send settles the fetch at once rather than waiting out the clock', async () => {
    const { w, api } = clientWindow();
    w.ws = { send() { throw new Error('socket is not open'); } };
    const got = await Promise.race([api.requestExtensionUi('csv-echo', 'view'), sleep(300).then(() => 'never')]);
    assert.match(got.reason, /socket is not open/);
  });
});

// ===== THE LIVE MOUNT UNDER A WORKSPACE CHANGE AND A ROSTER CHANGE =====

// The seam and its reconcile, cut from the shipped file view and run in a
// scope with the collaborators stubbed, so the mount lifecycle under test is
// the one that runs in the product.
function cutFiles(re, name) {
  const m = FILES_SRC.match(re);
  assert.ok(m, `files.js no longer carries ${name}`);
  return m[0];
}

function seamScope({ registry, fetcher, hostLoader, pane, openWikilink, currentPath = 'data/sales.csv', content = 'a,b\n1,2\n' }) {
  const pieces = [
    'openThroughRendererSeam(viewers, path, content, surface)', 'fetchExtensionUi(extensionId, rendererId)',
    'loadExtensionHost()', 'claimEditorPane()', 'releaseExtensionMount()', 'reconcileExtensionMount(roster)',
    'redrawPlainSurface(path, content, reason)', 'mountedExtension()',
  ].map((sig) => cutFiles(new RegExp(`function ${sig.replace(/[()]/g, '\\$&')} \\{[\\s\\S]*?\\n\\}`), sig));
  const surfaced = [];
  const noted = [];
  const paneStub = pane || { classList: { remove() {}, add() {} }, className: '', textContent: '' };
  const windowStub = {
    rundockRendererRegistry: registry,
    rundockExtensionUiFetcher: fetcher,
    rundockExtensionHostLoader: hostLoader,
  };
  const state = { currentFilePath: currentPath, rawFileContent: content };
  const api = new Function(
    'window', 'document', 'state', 'noteRendererFailure', 'openWikilink',
    'destroyActiveFileViewer', 'destroyTiptapEditorIfActive', 'clearTimeout', '_tiptapSaveTimer',
    'loadViewersModule', 'FILE_SURFACES', 'openBinaryOrUnsupportedFile', 'surfaced',
    `let activeExtensionMount = null; let activeExtensionMountInfo = null; let extensionSeamToken = 0;
     let currentFilePath = state.currentFilePath; let rawFileContent = state.rawFileContent;
     ${pieces.join(';\n')};
     return {
       open: () => openThroughRendererSeam({}, currentFilePath, rawFileContent, (v, p) => surfaced.push(p)),
       release: releaseExtensionMount,
       reconcile: reconcileExtensionMount,
       mounted: mountedExtension,
       mount: () => activeExtensionMount,
       setMount: (h, info) => { activeExtensionMount = h; activeExtensionMountInfo = info; },
       token: () => extensionSeamToken,
     };`,
  )(
    windowStub,
    { getElementById: (id) => (pane && id === 'editor-content' ? pane : paneStub) },
    state,
    (reason) => noted.push(reason),
    openWikilink || (() => {}),
    () => {}, () => {}, () => {}, null,
    () => Promise.resolve({ classify: () => 'unsupported' }),
    {},
    (viewers, p) => surfaced.push(p),
    surfaced,
  );
  return { api, surfaced, noted };
}

const CLAIM = { rendererFor: () => ({ registered: true, extension: 'csv-echo', renderer: 'view' }), versionOf: () => '1.0.0' };

// A stub mount handle that records what the reconcile does to it.
function stubHandle(log, label = 'first') {
  const h = {
    label,
    teardown() { log.push(`teardown:${label}`); },
    swap(payload) { log.push(`swap:${label}:${payload.entry}`); return stubHandle(log, 'swapped'); },
    alive: () => true,
  };
  return h;
}

describe('the seam hands the host the opened file, and records what it mounted', () => {
  test('the mount receives path and content, and the mounted identity carries the roster version', async () => {
    const mounts = [];
    const { api, surfaced, noted } = seamScope({
      registry: CLAIM,
      fetcher: () => Promise.resolve({ entry: 'draw();', styles: [] }),
      hostLoader: () => Promise.resolve({ mountExtension: (opts) => { mounts.push(opts); return { teardown() {} }; } }),
    });
    api.open();
    await sleep(20);
    assert.strictEqual(mounts.length, 1);
    assert.strictEqual(mounts[0].path, 'data/sales.csv', 'the host is told which file, so init can name it');
    assert.strictEqual(mounts[0].content, 'a,b\n1,2\n', 'and its text, so init can carry it');
    assert.deepStrictEqual(api.mounted(), { extension: 'csv-echo', renderer: 'view', version: '1.0.0', path: 'data/sales.csv' });
    assert.deepStrictEqual(surfaced, []);
    assert.deepStrictEqual(noted, []);
  });

  test('the over-cap degrade happens whichever caller mounts: the seam lands on the plain surface with the cap named', async () => {
    const hostModule = await import('../../public/extension-host.js');
    const dom = new JSDOM('<!doctype html><html><body><div id="editor-content"></div></body></html>');
    const pane = dom.window.document.getElementById('editor-content');
    const { api, surfaced, noted } = seamScope({
      registry: CLAIM,
      fetcher: () => Promise.resolve({ entry: 'draw();', styles: [] }),
      hostLoader: () => Promise.resolve(hostModule),
      pane,
      content: 'x'.repeat(hostModule.MAX_INIT_CONTENT_CHARS + 1),
    });
    api.open();
    await sleep(30);
    assert.strictEqual(pane.querySelector('iframe'), null, 'no frame was appended');
    assert.deepStrictEqual(surfaced, ['data/sales.csv']);
    assert.strictEqual(noted.length, 1);
    assert.match(noted[0], new RegExp(String(hostModule.MAX_INIT_CONTENT_CHARS)));
    assert.strictEqual(api.mounted(), null, 'nothing is recorded as mounted');
  });
});

describe('a workspace change tears the live mount down', () => {
  test('releasing the mount removes the frame, unbinds the mediator, and a late message from the old frame is ignored', async () => {
    const hostModule = await import('../../public/extension-host.js');
    const dom = new JSDOM('<!doctype html><html><body><div id="editor-content"></div></body></html>', { runScripts: 'outside-only' });
    const pane = dom.window.document.getElementById('editor-content');
    const { api } = seamScope({
      registry: CLAIM,
      fetcher: () => Promise.resolve({ entry: 'parent.postMessage({type:"ready"},"*");', styles: [] }),
      hostLoader: () => Promise.resolve(hostModule),
      pane,
    });
    api.open();
    await sleep(30);
    const frame = pane.querySelector('iframe.extension-frame');
    assert.ok(frame, 'a frame is live in the pane');
    const oldSource = frame.contentWindow;
    const sent = [];
    frame.contentWindow.postMessage = (m) => sent.push(m);
    const listenersBefore = dom.window.__listeners;
    void listenersBefore;
    // closeOpenFile is what onWorkspaceReady calls on a different workspace,
    // and releaseExtensionMount is the one line in it that owns the mount.
    assert.match(FILES_SRC, /releaseExtensionMount\(\);\n\s*currentFilePath = null;/, 'closeOpenFile releases the mount');
    api.release();
    assert.strictEqual(pane.querySelector('iframe'), null, 'the frame left the document');
    assert.strictEqual(api.mount(), null);
    assert.strictEqual(api.mounted(), null, 'nothing is recorded as mounted');
    const ev = new dom.window.Event('message');
    ev.data = { type: 'ready' };
    Object.defineProperty(ev, 'source', { value: oldSource });
    dom.window.dispatchEvent(ev);
    assert.deepStrictEqual(sent, [], 'the old frame\'s ready found no listener: not even an init');
  });
});

describe('one entry point reconciles a roster with the live mount', () => {
  const mountedInfo = { extension: 'csv-echo', renderer: 'view', version: '1.0.0', path: 'data/sales.csv' };

  test('nothing mounted is nothing to do', () => {
    const { api } = seamScope({ registry: CLAIM });
    assert.deepStrictEqual(api.reconcile([{ id: 'csv-echo', version: '1.0.0' }]), { action: 'none' });
  });

  test('absent from the roster: torn down, plain surface drawn under a stated reason', async () => {
    const log = [];
    const { api, surfaced, noted } = seamScope({ registry: CLAIM });
    api.setMount(stubHandle(log), mountedInfo);
    const verdict = api.reconcile([{ id: 'charts', version: '9.9.9' }]);
    assert.strictEqual(verdict.action, 'torn-down');
    assert.match(verdict.reason, /no longer installed/);
    assert.deepStrictEqual(log, ['teardown:first']);
    assert.strictEqual(api.mount(), null);
    await sleep(20);
    assert.deepStrictEqual(surfaced, ['data/sales.csv'], 'the reader keeps their file on the plain surface');
    assert.deepStrictEqual(noted, [verdict.reason]);
  });

  test('present but disabled: torn down the same way, with the reason saying disabled', async () => {
    const log = [];
    const { api, surfaced, noted } = seamScope({ registry: CLAIM });
    api.setMount(stubHandle(log), mountedInfo);
    const verdict = api.reconcile([{ id: 'csv-echo', version: '1.0.0', enabled: false }]);
    assert.strictEqual(verdict.action, 'torn-down');
    assert.match(verdict.reason, /disabled/);
    assert.deepStrictEqual(log, ['teardown:first']);
    await sleep(20);
    assert.deepStrictEqual(surfaced, ['data/sales.csv']);
    assert.deepStrictEqual(noted, [verdict.reason]);
  });

  test('present with a different version: swapped with a freshly fetched payload', async () => {
    const log = [];
    const fetched = [];
    const { api, surfaced, noted } = seamScope({
      registry: CLAIM,
      fetcher: (e, r) => { fetched.push([e, r]); return Promise.resolve({ entry: 'v2();', styles: [] }); },
    });
    api.setMount(stubHandle(log), mountedInfo);
    const verdict = api.reconcile([{ id: 'csv-echo', version: '2.0.0', enabled: true }]);
    assert.deepStrictEqual(verdict, { action: 'swapping', from: '1.0.0', to: '2.0.0' });
    await sleep(20);
    assert.deepStrictEqual(fetched, [['csv-echo', 'view']], 'the payload is fetched fresh, never reused');
    assert.deepStrictEqual(log, ['swap:first:v2();']);
    assert.strictEqual(api.mount().label, 'swapped', 'the handle the swap returned is the live mount now');
    assert.strictEqual(api.mounted().version, '2.0.0', 'the recorded version moves with the swap');
    assert.deepStrictEqual(surfaced, []);
    assert.deepStrictEqual(noted, []);
  });

  test('a new version whose payload cannot be fetched degrades to the plain surface with the reason', async () => {
    const log = [];
    const { api, surfaced, noted } = seamScope({
      registry: CLAIM,
      fetcher: () => Promise.resolve({ reason: 'the renderer entry could not be read' }),
    });
    api.setMount(stubHandle(log), mountedInfo);
    api.reconcile([{ id: 'csv-echo', version: '2.0.0' }]);
    await sleep(20);
    assert.deepStrictEqual(log, ['teardown:first'], 'torn down rather than swapped onto nothing');
    assert.deepStrictEqual(surfaced, ['data/sales.csv']);
    assert.deepStrictEqual(noted, ['the renderer entry could not be read']);
  });

  test('present and unchanged: left alone', async () => {
    const log = [];
    const { api, surfaced, noted } = seamScope({ registry: CLAIM, fetcher: () => { throw new Error('must not fetch'); } });
    const handle = stubHandle(log);
    api.setMount(handle, mountedInfo);
    assert.deepStrictEqual(api.reconcile([{ id: 'csv-echo', version: '1.0.0', enabled: true }]), { action: 'kept' });
    await sleep(10);
    assert.deepStrictEqual(log, []);
    assert.strictEqual(api.mount(), handle);
    assert.deepStrictEqual(surfaced, []);
    assert.deepStrictEqual(noted, []);
  });

  test('a file opened while the swap payload is in flight wins: the late swap is abandoned', async () => {
    const log = [];
    let release;
    const { api, surfaced } = seamScope({
      registry: CLAIM,
      fetcher: () => new Promise((r) => { release = () => r({ entry: 'v2();', styles: [] }); }),
    });
    api.setMount(stubHandle(log), mountedInfo);
    api.reconcile([{ id: 'csv-echo', version: '2.0.0' }]);
    api.release();
    release();
    await sleep(20);
    assert.deepStrictEqual(log, ['teardown:first'], 'no swap ran against a mount that was released meanwhile');
    assert.strictEqual(api.mount(), null);
    assert.deepStrictEqual(surfaced, []);
  });

  test('the entry point is published for the manage surface, and every roster arrival calls it', () => {
    assert.match(FILES_SRC, /\n\s*reconcileExtensionMount,|\breconcileExtensionMount\s*[,}]/, 'files.js exports it, so it is a window global');
    assert.match(APP_SRC, /if \(registry\) reconcileExtensionMount\(roster\);/, 'the roster arrival in app.js calls it once the registry stands');
  });
});

// ===== THE FRAME'S STYLESHEET RULE =====

describe('the extension frame has a stylesheet rule that follows the theme', () => {
  const SHEET = path.join('public', 'styles', 'components', 'extension-frame.css');

  function frameRule() {
    const css = read(SHEET);
    const m = /\.extension-frame\s*\{([^}]*)\}/.exec(css);
    assert.ok(m, 'the sheet carries a .extension-frame rule');
    const declarations = {};
    for (const decl of m[1].split(';')) {
      const at = decl.indexOf(':');
      if (at < 0) continue;
      declarations[decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
    }
    return { css, declarations };
  }

  test('the frame fills the pane, block, borderless, no shorter than the host\'s minimum', async () => {
    const { MIN_FRAME_HEIGHT } = await import('../../public/extension-host.js');
    const { declarations } = frameRule();
    assert.strictEqual(declarations.display, 'block');
    assert.strictEqual(declarations.width, '100%');
    assert.ok(['0', 'none'].includes(declarations.border), `no border, got ${declarations.border}`);
    assert.strictEqual(declarations['min-height'], `${MIN_FRAME_HEIGHT}px`,
      'the stylesheet floor and the host\'s clamp floor are one number');
  });

  test('every color in the rule comes through a token, so both theme sets apply without a second rule', () => {
    const { css, declarations } = frameRule();
    const colorProps = Object.entries(declarations).filter(([k]) => /color|background/.test(k));
    assert.ok(colorProps.length >= 1, 'the rule paints at least one surface');
    for (const [k, v] of colorProps) assert.match(v, /^var\(--[a-z0-9-]+\)$/, `${k} is a token reference, got ${v}`);
    assert.strictEqual((css.match(/\.extension-frame/g) || []).length, 1, 'one rule, not one per theme');
    assert.ok(!/\.light|prefers-color-scheme/.test(css), 'no theme-specific selector: the tokens carry the theme');
  });

  test('the sheet is linked once from index.html, after the token sheet', () => {
    const html = read('public', 'index.html');
    const links = [...html.matchAll(/<link[^>]+href="(\/styles\/[^"]+\.css)"/g)].map((m) => m[1]);
    const at = links.indexOf('/styles/components/extension-frame.css');
    assert.ok(at > links.indexOf('/styles/tokens.css'), 'linked, and after tokens.css so var() resolves');
    assert.strictEqual(links.filter((l) => l === '/styles/components/extension-frame.css').length, 1);
  });
});

// ===== AN OPEN FROM THE FRAME RESOLVES LIKE A WIKILINK CLICK =====

describe('an open message from the frame takes the wikilink route', () => {
  // The resolver and the wikilink opener, cut from the file view and run
  // over a fixture tree with a stub socket, so the path each route sends
  // is read off the wire.
  function resolverScope(currentPath) {
    const pieces = [
      cutFiles(/const VIEWABLE_LINK_EXT_RE = [^\n]+\n/, 'VIEWABLE_LINK_EXT_RE'),
      cutFiles(/function wikilinkSearchName\(target\) \{[\s\S]*?\n\}/, 'wikilinkSearchName'),
      cutFiles(/function findFileInTree\(items, searchName, fromPath\) \{[\s\S]*?\n\}/, 'findFileInTree'),
      cutFiles(/function dirSegments\(p\) \{[\s\S]*?\n\}/, 'dirSegments'),
      cutFiles(/function commonPrefixLen\(a, b\) \{[\s\S]*?\n\}/, 'commonPrefixLen'),
      cutFiles(/function enteredFromFiles\(\) \{[\s\S]*?\n\}/, 'enteredFromFiles'),
      cutFiles(/function openWikilink\(name\) \{[\s\S]*?\n\}/, 'openWikilink'),
    ];
    const sent = [];
    const tree = [
      { type: 'folder', name: 'other', path: 'other', children: [
        { type: 'file', name: 'sibling-note.md', path: 'other/sibling-note.md' },
      ] },
      { type: 'folder', name: 'data', path: 'data', children: [
        { type: 'file', name: 'sales.csv', path: 'data/sales.csv' },
        { type: 'file', name: 'sibling-note.md', path: 'data/sibling-note.md' },
      ] },
    ];
    const open = new Function(
      'ws', 'cachedFileTree', 'currentFilePath', 'switchNav', 'showView', 'highlightFileInSidebar',
      `let editorReturnView = null; let fileHistory = [];
       ${pieces.join(';\n')};
       return openWikilink;`,
    )({ send: (m) => sent.push(JSON.parse(m)) }, tree, currentPath, () => {}, () => {}, () => {});
    return { open, sent };
  }

  test('both routes send read_file for the same path, resolved from the same current file', async () => {
    const hostModule = await import('../../public/extension-host.js');
    const dom = new JSDOM('<!doctype html><html><body><div id="editor-content"></div></body></html>', { runScripts: 'outside-only' });
    const pane = dom.window.document.getElementById('editor-content');
    const resolver = resolverScope('data/sales.csv');
    const { api } = seamScope({
      registry: CLAIM,
      fetcher: () => Promise.resolve({ entry: 'parent.postMessage({type:"ready"},"*");', styles: [] }),
      hostLoader: () => Promise.resolve(hostModule),
      pane,
      openWikilink: resolver.open,
    });
    api.open();
    await sleep(30);
    const frame = pane.querySelector('iframe.extension-frame');
    assert.ok(frame, 'the frame is live');
    // The frame asks for a sibling by bare name, through the closed table.
    const ev = new dom.window.Event('message');
    ev.data = { type: 'open', target: 'sibling-note' };
    Object.defineProperty(ev, 'source', { value: frame.contentWindow });
    dom.window.dispatchEvent(ev);
    const viaFrame = resolver.sent.splice(0);
    assert.deepStrictEqual(viaFrame, [{ type: 'read_file', path: 'data/sibling-note.md' }],
      'the frame\'s open resolved by proximity to the open file, not to the first match in tree order');
    // The same target clicked as a wikilink in the same file.
    resolver.open('sibling-note');
    const viaClick = resolver.sent.splice(0);
    assert.deepStrictEqual(viaClick, viaFrame, 'one resolver, one answer, whichever route asked');
  });
});
