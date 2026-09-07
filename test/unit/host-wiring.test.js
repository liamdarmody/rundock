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
      'resetSidebarForWorkspace']) {
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
