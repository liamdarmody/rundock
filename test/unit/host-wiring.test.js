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

  test('a reply carrying no roster array is nothing to reconcile: the registry stands and the live mount is not touched', async () => {
    const { w, api, reconciled } = clientWindow();
    await dispatched(w, api, { type: 'extensions', extensions: ROSTER_A });
    const before = w.rundockRendererRegistry;
    await api.extensionRosterArrived(undefined);
    await api.extensionRosterArrived({ extensions: ROSTER_B });
    assert.strictEqual(w.rundockRendererRegistry, before, 'the registry was not replaced');
    assert.strictEqual(w.rundockRendererRegistry.rendererFor('a.csv').registered, true, 'the old claim still answers');
    assert.strictEqual(reconciled.length, 1, 'no reconcile ran against a roster that was not there');
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
    // requestPins and workingFoldersWorkspaceChanged arrived with the merge up
    // from main and are called in the same batch this test is about. They are
    // stubbed for the same reason as the rest: the batch's CONTENT is what is
    // asserted, so a sibling call that is not this change's concern only has to
    // not throw. workingFoldersWorkspaceChanged is the exact shape of the two
    // *WorkspaceChanged stubs already in this list.
    for (const name of ['setServingWorkspace', 'setWorkspaceChrome', 'packagesWorkspaceChanged',
      'connectorsWorkspaceChanged', 'renderListPills', 'updateUnreadBadge', 'updateWorkingBadge',
      'resetSidebarForWorkspace', 'requestPins', 'workingFoldersWorkspaceChanged']) {
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

function seamScope({ registry, fetcher, hostLoader, pane, openWikilink, currentPath = 'data/sales.csv', content = 'a,b\n1,2\n', refusalFor, fileSaves, viewStateFetcher, socket }) {
  const pieces = [
    'openThroughRendererSeam(viewers, path, content, surface)', 'fetchExtensionUi(extensionId, rendererId)',
    'loadExtensionHost()', 'claimEditorPane()', 'releaseExtensionMount()', 'reconcileExtensionMount(roster)',
    'redrawPlainSurface(path, content, reason)', 'plainSurfaceFor(viewers, path, content)', 'mountedExtension()',
    // The reconcile asks the file again before it keeps a mount, so the
    // question is cut from source with it.
    'recheckExtensionClaim()',
    // releaseExtensionMount takes regions down with the mount, so its
    // dependency is cut from source alongside it. Stubbing it would keep this
    // suite green while the real pair drifted, which is exactly what cutting
    // from source exists to stop.
    'releaseRegions()',
    // The named-sources half of the seam and its release.
    'requestSources(path)', 'noteSourceBaselines(list)', 'endSourcesWatch()',
    // The view state half: the read at mount, the debounced write, the
    // server's answers, and the transport.
    'fetchViewState(extension, path)', 'scheduleViewState(extension, path, state)', 'viewStateReplyArrived(d)',
    'requestViewState(extension, path)',
  ].map((sig) => cutFiles(new RegExp(`function ${sig.replace(/[()]/g, '\\$&')} \\{[\\s\\S]*?\\n\\}`), sig));
  const surfaced = [];
  const noted = [];
  const paneStub = pane || { classList: { remove() {}, add() {} }, className: '', textContent: '' };
  const windowStub = {
    rundockRendererRegistry: registry,
    rundockExtensionUiFetcher: fetcher,
    rundockExtensionHostLoader: hostLoader,
    // The server's answer for the opened file: cleared, unless a test says
    // otherwise. See extension-file.js.
    rundockExtensionRefusalFor: refusalFor || (() => null),
    rundockViewStateFetcher: viewStateFetcher,
  };
  const state = { currentFilePath: currentPath, rawFileContent: content, ws: socket || { send() {}, readyState: 1 } };
  const api = new Function(
    'window', 'document', 'state', 'noteRendererFailure', 'openWikilink',
    'destroyActiveFileViewer', 'destroyTiptapEditorIfActive', 'clearTimeout', 'fileSaves',
    'loadViewersModule', 'FILE_SURFACES', 'openBinaryOrUnsupportedFile', 'surfaced', 'saveFileGuarded',
    `let activeExtensionMount = null; let placedRegions = []; let activeExtensionMountInfo = null; let extensionSeamToken = 0;
     let sourcesWatchId = null; let sourcesWaiter = null; let sourcesSeq = 0; const sourceBaselines = new Map(); const SOURCES_TIMEOUT_MS = 50;
     const ws = state.ws; const WebSocket = { OPEN: 1 };
     let viewStateSeq = 0; const viewStateWaiters = new Map(); const VIEW_STATE_TIMEOUT_MS = 50;
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
       viewStateReply: viewStateReplyArrived,
       requestViewState,
     };`,
  )(
    windowStub,
    { getElementById: (id) => (pane && id === 'editor-content' ? pane : paneStub) },
    state,
    (reason) => noted.push(reason),
    openWikilink || (() => {}),
    () => {}, () => {}, () => {}, fileSaves || { schedule() {}, flush() {}, cancel() {}, pendingPath: () => null },
    () => Promise.resolve({ classify: () => 'unsupported' }),
    {},
    (viewers, p) => surfaced.push(p),
    surfaced,
    // The guarded save, as far as the wire: what it would send.
    (p) => state.ws.send(JSON.stringify({ type: 'save_file', path: p })),
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

  test('the seam asks the registry with the content in hand, so a marked-subset claim can be decided', () => {
    // The registry cannot inspect what nobody passes. The seam already holds
    // the opened file's text, and a unit test pins that the claim decision is made
    // with it: reverting this call to a path-only lookup must turn this red.
    const asked = [];
    const { api, surfaced } = seamScope({
      registry: { rendererFor: (...args) => { asked.push(args); return { registered: false, reason: 'nothing claims it' }; } },
    });
    api.open();
    assert.deepStrictEqual(asked, [['data/sales.csv', 'a,b\n1,2\n']],
      'one question, carrying the path and the content the caller already has');
    assert.deepStrictEqual(surfaced, ['data/sales.csv']);
  });

  test('through the real registry, a marker mounts the marked file and leaves the unmarked note on the plain surface', async () => {
    // Proven by rendering both: one roster, one registry, two files.
    const mod = await import('../../public/renderer-registry.js');
    const registry = mod.createRendererRegistry();
    registry.registerFromRoster([
      { id: 'standup', enabled: true, version: '1.0.0', renderers: [{ id: 'view', target: '.md', declares: 'standup-plugin' }] },
    ]);
    const mounts = [];
    const host = () => Promise.resolve({ mountExtension: (opts) => { mounts.push(opts); return { teardown() {} }; } });
    const marked = seamScope({
      registry, hostLoader: host,
      fetcher: () => Promise.resolve({ entry: 'draw();', styles: [] }),
      currentPath: 'notes/monday.md', content: '---\nstandup-plugin: daily\n---\n\n# Monday\n',
    });
    marked.api.open();
    await sleep(20);
    assert.strictEqual(mounts.length, 1, 'the marked file is the extension\'s');
    assert.deepStrictEqual(marked.surfaced, [], 'and never falls through to the plain surface');
    const plain = seamScope({
      registry, hostLoader: host,
      fetcher: () => Promise.resolve({ entry: 'draw();', styles: [] }),
      currentPath: 'notes/plain.md', content: '# Just a note\n',
    });
    plain.api.open();
    await sleep(20);
    assert.strictEqual(mounts.length, 1, 'the unmarked note never reached the host');
    assert.deepStrictEqual(plain.surfaced, ['notes/plain.md'], 'it opened in the ordinary editor');
    assert.deepStrictEqual(plain.noted, [], 'and not as a failure: an unclaimed file is the ordinary case');
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
    // The unbinding is counted, not inferred: the number of message
    // listeners bound on the window goes to one with the mount and back to
    // none with the release, so a release that left the mediator bound
    // fails here rather than hiding behind the alive guard.
    let bound = 0;
    const realAdd = dom.window.addEventListener.bind(dom.window);
    const realRemove = dom.window.removeEventListener.bind(dom.window);
    dom.window.addEventListener = (type, fn, ...rest) => { if (type === 'message') bound += 1; realAdd(type, fn, ...rest); };
    dom.window.removeEventListener = (type, fn, ...rest) => { if (type === 'message') bound -= 1; realRemove(type, fn, ...rest); };
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
    assert.ok(pane.classList.contains('extension-pane'), 'the pane an extension holds is full bleed');
    assert.strictEqual(bound, 1, 'the mount bound exactly one message listener');
    const oldSource = frame.contentWindow;
    const sent = [];
    frame.contentWindow.postMessage = (m) => sent.push(m);
    // closeOpenFile is what onWorkspaceReady calls on a different workspace,
    // and releaseExtensionMount is the one line in it that owns the mount.
    assert.match(FILES_SRC,
      // stopRegionServices sits between these two now: closeOpenFile is the
      // workspace-switch path, and a region service holds a frame running code
      // installed in the workspace being left.
      /releaseExtensionMount\(\);\n(?:\s*\/\/[^\n]*\n)*\s*stopRegionServices\(\);\n\s*currentFilePath = null;/,
      'closeOpenFile releases the mount');
    api.release();
    assert.ok(!pane.classList.contains('extension-pane'), 'the pane gets its padding back with the view gone');
    assert.strictEqual(bound, 0, 'the release unbound it');
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

  test('a swap whose re-mount died is not adopted: nothing is recorded as mounted, and the degrade already drew the plain surface', async () => {
    const log = [];
    const { api, surfaced, noted } = seamScope({
      registry: CLAIM,
      fetcher: () => Promise.resolve({ entry: 'v2();', styles: [] }),
    });
    const dead = stubHandle(log);
    // The host's swap re-mounts; when that fails synchronously the host has
    // already degraded (nulling the mount and drawing the plain surface) and
    // hands back an inert handle. The reconcile must not put it back.
    dead.swap = (payload) => {
      log.push(`swap:first:${payload.entry}`);
      api.setMount(null, null);
      surfaced.push('data/sales.csv');
      noted.push('the frame could not be built');
      return { label: 'inert', alive: () => false, teardown() { log.push('teardown:inert'); }, swap: () => null };
    };
    api.setMount(dead, mountedInfo);
    const verdict = api.reconcile([{ id: 'csv-echo', version: '2.0.0', enabled: true }]);
    assert.strictEqual(verdict.action, 'swapping');
    await sleep(20);
    assert.deepStrictEqual(log, ['swap:first:v2();']);
    assert.strictEqual(api.mount(), null, 'a dead handle is not adopted as the live mount');
    assert.strictEqual(api.mounted(), null, 'nothing is recorded as mounted over the plain surface');
    assert.deepStrictEqual(surfaced, ['data/sales.csv']);
    assert.deepStrictEqual(noted, ['the frame could not be built']);
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

  test('the same version at a new commit is swapped too: a package update need not bump the number', async () => {
    const log = [];
    const { api } = seamScope({ registry: CLAIM, fetcher: () => Promise.resolve({ entry: 'v2();', styles: [] }) });
    api.setMount(stubHandle(log), { ...mountedInfo, version: '1.0.0@aaaa' });
    assert.strictEqual(api.reconcile([{ id: 'csv-echo', version: '1.0.0', build: '1.0.0@aaaa', enabled: true }]).action, 'kept');
    const verdict = api.reconcile([{ id: 'csv-echo', version: '1.0.0', build: '1.0.0@bbbb', enabled: true }]);
    assert.deepStrictEqual(verdict, { action: 'swapping', from: '1.0.0@aaaa', to: '1.0.0@bbbb' });
    await sleep(20);
    assert.deepStrictEqual(log, ['swap:first:v2();']);
  });

  test('an edit waiting to be saved in the view lands before the view is swapped', async () => {
    const log = [];
    const fileSaves = { schedule() {}, cancel() {}, pendingPath: () => 'data/sales.csv', flush() { log.push('flush'); } };
    const { api } = seamScope({
      registry: CLAIM, fileSaves,
      fetcher: () => { log.push('fetch'); return Promise.resolve({ entry: 'v2();', styles: [] }); },
    });
    api.setMount(stubHandle(log), mountedInfo);
    api.reconcile([{ id: 'csv-echo', version: '2.0.0', enabled: true }]);
    await sleep(20);
    assert.deepStrictEqual(log, ['flush', 'fetch', 'swap:first:v2();']);
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

  test('a file whose text no longer claims the mounted extension: released onto the plain surface, naming why', async () => {
    const log = [];
    const asked = [];
    const registry = {
      rendererFor: (...args) => { asked.push(args); return { registered: false, reason: 'this file carries no such marker' }; },
      versionOf: () => '1.0.0',
    };
    const { api, surfaced, noted } = seamScope({ registry, content: '---\ntitle: x\n---\n' });
    api.setMount(stubHandle(log), mountedInfo);
    const verdict = api.reconcile([{ id: 'csv-echo', version: '1.0.0', enabled: true }]);
    assert.deepStrictEqual(asked, [['data/sales.csv', '---\ntitle: x\n---\n']], 'the registry is asked with the open file\'s current text');
    assert.strictEqual(verdict.action, 'released', 'an unchanged version is not enough to keep a mount the file no longer claims');
    assert.match(verdict.reason, /no longer claims the extension "csv-echo": this file carries no such marker/);
    assert.deepStrictEqual(log, ['teardown:first']);
    assert.strictEqual(api.mount(), null);
    assert.strictEqual(api.mounted(), null);
    await sleep(20);
    assert.deepStrictEqual(surfaced, ['data/sales.csv']);
    assert.deepStrictEqual(noted, [verdict.reason]);
  });

  test('a file now claimed by a different extension: the mount is released and the seam opens the file afresh', async () => {
    const log = [];
    const mounts = [];
    const registry = { rendererFor: () => ({ registered: true, extension: 'charts', renderer: 'plot' }), versionOf: () => '3.0.0' };
    const { api, surfaced } = seamScope({
      registry,
      fetcher: () => Promise.resolve({ entry: 'plot();', styles: [] }),
      hostLoader: () => Promise.resolve({ mountExtension: (opts) => { mounts.push(opts); return { teardown() {}, alive: () => true }; } }),
    });
    api.setMount(stubHandle(log), mountedInfo);
    const verdict = api.reconcile([{ id: 'csv-echo', version: '1.0.0' }, { id: 'charts', version: '3.0.0' }]);
    assert.deepStrictEqual(verdict, { action: 'reclaimed', by: 'charts' });
    assert.deepStrictEqual(log, ['teardown:first']);
    await sleep(30);
    assert.strictEqual(mounts.length, 1, 'the claiming extension is mounted through the seam');
    assert.strictEqual(api.mounted().extension, 'charts');
    assert.deepStrictEqual(surfaced, []);
  });

  test('a write to the open file that lands asks the claim again; a write to any other file does not', () => {
    const found = APP_SRC.match(/(case 'file_saved':[\s\S]*?break;)/);
    assert.ok(found, 'app.js no longer answers file_saved');
    const dom = new JSDOM('<!doctype html><html><body><span id="editor-status"></span></body></html>', { runScripts: 'outside-only' });
    const w = dom.window;
    const asked = [];
    w.recheckExtensionClaim = () => { asked.push(w.currentFilePath); return { action: 'kept' }; };
    w.currentFilePath = 'notes/Standup.md';
    w.eval(`window.__handle = function (d) { switch (d.type) { ${found[1]} } };`);
    w.__handle({ type: 'file_saved', path: 'notes/Standup.md' });
    assert.strictEqual(w.document.getElementById('editor-status').textContent, 'Saved');
    assert.deepStrictEqual(asked, ['notes/Standup.md'], 'the open file\'s landed write re-asks its claim');
    w.__handle({ type: 'file_saved', path: 'notes/Other.md' });
    assert.deepStrictEqual(asked, ['notes/Standup.md'], 'a write to another file leaves the mount alone');
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
      // openWikilink calls this to light the rail for the entry it came in
      // through. It arrived with the merge up from main and has to be cut in
      // beside the opener: without it the opener throws before it resolves
      // anything, and the route reads as sending nothing rather than as
      // resolving to the wrong path.
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
    // A click inside the view, the only thing open is honoured after: the
    // browser's activation, focus on this frame, and no click on the page
    // itself recently enough to be the one the browser is reporting.
    Object.defineProperty(dom.window.navigator, 'userActivation', { value: { isActive: true }, configurable: true });
    frame.tabIndex = 0;
    frame.focus();
    dom.window.rundockLastHostGesture = 0;
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

describe('the roster names the exact build an extension runs', () => {
  const registryModule = require('../../lib/packages/extension-registry.js');
  test('a record carrying a commit is listed with its version and commit as one build', () => {
    const fsn = require('node:fs');
    const pathn = require('node:path');
    const os = require('node:os');
    const root = fsn.mkdtempSync(pathn.join(os.tmpdir(), 'build-roster-'));
    fsn.mkdirSync(pathn.join(root, '.rundock', 'extensions', 'csv-echo', 'view'), { recursive: true });
    fsn.writeFileSync(pathn.join(root, '.rundock', 'extensions', 'csv-echo', 'view', 'index.html'), 'x');
    const record = (commit) => ({ name: 'csv-echo', version: '1.0.0', entry: 'view/index.html', match: '*.csv', root: '.rundock/extensions/csv-echo', source: { url: 'https://github.com/a/b', reference: 'v1.0.0', ...(commit ? { commit } : {}) } });
    const write = (r) => fsn.writeFileSync(pathn.join(root, '.rundock', 'extensions.json'), JSON.stringify({ schema: 'rundock.extensions/v1', extensions: [r] }));
    write(record('c'.repeat(40)));
    assert.strictEqual(registryModule.listExtensions(root)[0].build, `1.0.0@${'c'.repeat(40)}`);
    write(record(null));
    assert.ok(!('build' in registryModule.listExtensions(root)[0]), 'a record without a commit keeps the shape it had');
  });
});

test('the registry records the build a view was mounted from, falling back to the version', async () => {
  const mod = await import('../../public/renderer-registry.js');
  const registry = mod.createRendererRegistry();
  registry.registerFromRoster([
    { id: 'built', enabled: true, version: '1.0.0', build: '1.0.0@abc', renderers: [] },
    { id: 'plain', enabled: true, version: '2.0.0', renderers: [] },
  ]);
  assert.strictEqual(registry.versionOf('built'), '1.0.0@abc');
  assert.strictEqual(registry.versionOf('plain'), '2.0.0');
});

// ===== VIEW STATE AT THE SEAM =====

describe('view state: read at mount, written through the shared debounce, never named by the frame', () => {
  const { create } = require('../../public/save-scheduler.js');
  // The real scheduler on a clock the test turns by hand.
  function clock() {
    const timers = [];
    const saves = create({ setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: (t) => { timers[t - 1] = null; } });
    return { saves, fire: () => { const live = timers.filter(Boolean); timers.length = 0; live.forEach((fn) => fn()); } };
  }
  function socket() {
    const sent = [];
    return { sent, readyState: 1, send: (m) => sent.push(JSON.parse(m)) };
  }
  const host = (mounts) => () => Promise.resolve({ mountExtension: (opts) => { mounts.push(opts); return { teardown() {}, alive: () => true, refuseState: (r) => mounts.refused.push(r) }; } });
  function scope(extra = {}) {
    const mounts = [];
    mounts.refused = [];
    const asked = [];
    const { saves, fire } = clock();
    const ws = socket();
    const s = seamScope({
      registry: CLAIM, fetcher: () => Promise.resolve({ entry: 'draw();', styles: [] }), hostLoader: host(mounts),
      viewStateFetcher: (extension, p) => { asked.push([extension, p]); return Promise.resolve({ 'rui.table.t': { a: 120 } }); },
      fileSaves: saves, socket: ws, ...extra,
    });
    return { ...s, mounts, asked, saves, fire, ws };
  }

  test('the mount is handed the state read for the claiming extension and the opened note', async () => {
    const { api, mounts, asked } = scope();
    api.open();
    await sleep(20);
    assert.deepStrictEqual(asked, [['csv-echo', 'data/sales.csv']]);
    assert.deepStrictEqual(mounts[0].state, { 'rui.table.t': { a: 120 } });
  });

  test('with no way to read state, the view still mounts, with none', async () => {
    const { api, mounts } = scope({ viewStateFetcher: undefined });
    api.open();
    await sleep(20);
    assert.strictEqual(mounts.length, 1);
    assert.strictEqual(mounts[0].state, null);
  });

  test('a burst of states writes once, the last, named by the mount and never by the view', async () => {
    const { api, mounts, ws, fire } = scope();
    api.open();
    await sleep(20);
    for (let i = 0; i < 50; i += 1) mounts[0].onState({ n: i });
    assert.deepStrictEqual(ws.sent, [], 'nothing before the pause');
    fire();
    assert.deepStrictEqual(ws.sent, [{ type: 'set_view_state', extension: 'csv-echo', path: 'data/sales.csv', state: { n: 49 } }]);
  });

  test('a view state and a change to the note never drop each other in the one debounce', async () => {
    const { api, mounts, ws, saves, fire } = scope();
    api.open();
    await sleep(20);
    mounts[0].onState({ n: 1 });
    mounts[0].onChange('a,b\n3,4\n');
    assert.deepStrictEqual(ws.sent.map((m) => m.type), ['set_view_state'], 'the state was written before the note\'s save replaced it');
    mounts[0].onState({ n: 2 });
    assert.deepStrictEqual(ws.sent.map((m) => m.type), ['set_view_state', 'save_file'], 'and the note\'s pending save before the next state');
    fire();
    assert.deepStrictEqual(ws.sent.map((m) => m.type), ['set_view_state', 'save_file', 'set_view_state']);
  });

  test('a pending state is written when the debounce is flushed, as opening another file does', async () => {
    const { api, mounts, ws, saves } = scope();
    api.open();
    await sleep(20);
    mounts[0].onState({ n: 1 });
    saves.flush();
    assert.deepStrictEqual(ws.sent, [{ type: 'set_view_state', extension: 'csv-echo', path: 'data/sales.csv', state: { n: 1 } }]);
  });

  test('a superseded mount writes nothing', async () => {
    const { api, mounts, ws, fire } = scope();
    api.open();
    await sleep(20);
    api.release();
    mounts[0].onState({ n: 1 });
    fire();
    assert.deepStrictEqual(ws.sent, []);
  });

  test('a refusal from the server reaches the live view only when it names that view\'s extension and note', async () => {
    const { api, mounts } = scope();
    api.open();
    await sleep(20);
    api.setMount(api.mount(), api.mounted());
    const reason = "this extension's view state is over its limit";
    api.viewStateReply({ type: 'view_state_refused', extension: 'risk-board', path: 'data/sales.csv', reason });
    api.viewStateReply({ type: 'view_state_refused', extension: 'csv-echo', path: 'other.csv', reason });
    assert.deepStrictEqual(mounts.refused, []);
    api.viewStateReply({ type: 'view_state_refused', extension: 'csv-echo', path: 'data/sales.csv', reason });
    assert.deepStrictEqual(mounts.refused, [reason]);
  });

  test('the transport asks by extension and note, answers the matching reply, and null for anything else', async () => {
    const ws = socket();
    const { api } = seamScope({ registry: CLAIM, socket: ws });
    const first = api.requestViewState('csv-echo', 'data/sales.csv');
    const [asked] = ws.sent;
    assert.deepStrictEqual({ ...asked, requestId: typeof asked.requestId }, { type: 'get_view_state', extension: 'csv-echo', path: 'data/sales.csv', requestId: 'string' });
    api.viewStateReply({ type: 'view_state', requestId: 'another', state: { wrong: 1 } });
    api.viewStateReply({ type: 'view_state', requestId: asked.requestId, state: { k: 1 } });
    assert.deepStrictEqual(await first, { k: 1 });
    const second = api.requestViewState('csv-echo', 'data/sales.csv');
    api.viewStateReply({ type: 'view_state', requestId: ws.sent[1].requestId, state: [1] });
    assert.strictEqual(await second, null, 'an answer that is not an object is no state');
    assert.strictEqual(await api.requestViewState('csv-echo', 'data/sales.csv'), null, 'no answer in time is no state');
  });
});
