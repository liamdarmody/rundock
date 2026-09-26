'use strict';
// The renderer registry, and the file view's seam over it.
//
// The registry's one promise: a target is either registered, with everything
// a mount needs, or unregistered with a reason. The seam's one promise: an
// unregistered or failing renderer lands on the plain surface with the
// failure named, never on a broken frame. Both are driven here, the seam by
// cutting its own function out of the file view so the code that runs in the
// product is the code under test.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

let mod = null;
async function registryModule() {
  if (!mod) mod = await import('../../public/renderer-registry.js');
  return mod;
}

const ROSTER = [
  { id: 'charts', enabled: true, renderers: [{ id: 'chart', target: '.chart' }] },
  { id: 'tables', enabled: true, renderers: [{ id: 'table', target: '.chart' }, { id: 'grid', target: '.grid' }] },
  { id: 'sleeping', enabled: false, renderers: [{ id: 'z', target: '.zzz' }] },
  { id: 'sloppy', enabled: true, renderers: [{ id: 'bad', target: 'no-dot' }] },
];

describe('the registry answers registered or why not, never a third thing', () => {
  test('a claimed target carries the extension and renderer a mount needs', async () => {
    const { createRendererRegistry } = await registryModule();
    const r = createRendererRegistry();
    r.registerFromRoster(ROSTER);
    assert.deepStrictEqual(r.rendererFor('notes/q3.chart'),
      { registered: true, extension: 'charts', renderer: 'chart' });
  });

  test('an unregistered target says why, for every way of being unregistered', async () => {
    const { createRendererRegistry } = await registryModule();
    const r = createRendererRegistry();
    r.registerFromRoster(ROSTER);
    assert.match(r.rendererFor('notes/plain.md').reason, /no installed extension renders "\.md"/);
    assert.match(r.rendererFor('no-extension').reason, /no extension for a renderer to claim/);
    assert.match(r.rendererFor('notes/off.zzz').reason, /no installed extension renders/,
      'a disabled extension\'s claims never register');
  });

  test('the first claim wins and the shadowed one is recorded with its reason', async () => {
    const { createRendererRegistry } = await registryModule();
    const r = createRendererRegistry();
    r.registerFromRoster(ROSTER);
    assert.strictEqual(r.rendererFor('a.chart').extension, 'charts',
      'roster order decides, because it is stable and visible');
    const refused = r.refusals().find((x) => x.extension === 'tables' && x.target === '.chart');
    assert.ok(refused, 'the losing claim is kept, so a silent renderer is explicable');
    assert.match(refused.reason, /already rendered by charts/);
  });

  test('a target outside the grammar is refused with the grammar named', async () => {
    const { createRendererRegistry } = await registryModule();
    const r = createRendererRegistry();
    r.registerFromRoster(ROSTER);
    const refused = r.refusals().find((x) => x.extension === 'sloppy');
    assert.match(refused.reason, /not a file extension of the form/);
    assert.deepStrictEqual(r.targets(), ['.chart', '.grid'],
      'what registered is exactly the valid, enabled, unshadowed claims');
  });

  test('a multi-segment target is refused, because the lookup could never match it', async () => {
    const { createRendererRegistry } = await registryModule();
    const r = createRendererRegistry();
    r.registerFromRoster([{ id: 'z', enabled: true, renderers: [{ id: 'g', target: '.tar.gz' }] }]);
    assert.deepStrictEqual(r.targets(), [],
      'a target the last-dot lookup cannot reach never enters the registry');
    assert.strictEqual(r.refusals().length, 1, 'and it is recorded, not silently dropped');
    assert.strictEqual(r.rendererFor('archive.tar.gz').registered, false,
      'the accepted grammar and the lookup agree: nothing claims it');
  });
});

describe('a marker claims a subset of a container, never the whole of it', () => {
  // The marked-subset grammar, mirrored from kanban: a file whose
  // frontmatter carries the declared key belongs to the extension, and a
  // file without it stays an ordinary note. These tests drive the registry
  // with content in hand, because a claim on part of a container type can
  // only be decided by looking at the file.
  const MARKED = '---\nstandup-plugin: daily\n---\n\n# Monday\n';
  const PLAIN = '# Just a note\n\nProse that mentions standup-plugin is not a marker.\n';

  test('a declares claim fires on a marked file and leaves an unmarked one alone, with the marker named', async () => {
    const { createRendererRegistry } = await registryModule();
    const r = createRendererRegistry();
    r.registerFromRoster([
      { id: 'standup', enabled: true, renderers: [{ id: 'view', target: '.md', declares: 'standup-plugin' }] },
    ]);
    assert.deepStrictEqual(r.rendererFor('notes/monday.md', MARKED),
      { registered: true, extension: 'standup', renderer: 'view', marker: 'standup-plugin' },
      'the marker is present, so the extension owns this file, and the claim says it was by marker');
    const miss = r.rendererFor('notes/plain.md', PLAIN);
    assert.strictEqual(miss.registered, false, 'an unmarked note is never claimed');
    assert.match(miss.reason, /standup-plugin/,
      'the answer names the marker, so a person can see what would have matched');
  });

  test('only a real frontmatter key is a marker: body text and unclosed frontmatter claim nothing', async () => {
    const { createRendererRegistry } = await registryModule();
    const r = createRendererRegistry();
    r.registerFromRoster([
      { id: 'standup', enabled: true, renderers: [{ id: 'view', target: '.md', declares: 'standup-plugin' }] },
    ]);
    assert.strictEqual(r.rendererFor('a.md', 'standup-plugin: yes\n').registered, false,
      'a key-shaped line outside frontmatter is body text');
    assert.strictEqual(r.rendererFor('a.md', '---\nstandup-plugin: yes\n').registered, false,
      'frontmatter that never closes is not frontmatter, exactly as kanban reads it');
    assert.strictEqual(r.rendererFor('a.md', '# Note\n\nstandup-plugin: yes\n').registered, false,
      'the key later in the body is prose');
    assert.strictEqual(r.rendererFor('a.md', '---\ntitle: x\n---\n\nstandup-plugin: yes\n').registered, false,
      'a key-shaped line after real frontmatter is body text too: only the closed block is scanned');
  });

  test('a marker claim beats a bare claim on the same target, whichever registered first', async () => {
    const { createRendererRegistry } = await registryModule();
    const rosterA = [
      { id: 'all-data', enabled: true, renderers: [{ id: 'view', target: '.data' }] },
      { id: 'charts', enabled: true, renderers: [{ id: 'view', target: '.data', declares: 'chart-plugin' }] },
    ];
    for (const roster of [rosterA, [...rosterA].reverse()]) {
      const r = createRendererRegistry();
      r.registerFromRoster(roster);
      assert.strictEqual(r.rendererFor('q.data', '---\nchart-plugin: bar\n---\n').extension, 'charts',
        'the marked file goes to the marker claim, because it is more specific');
      assert.strictEqual(r.rendererFor('q.data', 'plain bytes').extension, 'all-data',
        'the unmarked file still goes to the bare claim');
      assert.deepStrictEqual(r.refusals(), [],
        'a marker claim and a bare claim on one target are different claims, not a collision');
    }
  });

  test('core beats an extension on the same marker: kanban-plugin cannot be taken from the board view', async () => {
    const mod = await registryModule();
    const r = mod.createRendererRegistry();
    r.registerFromRoster([
      { id: 'board-thief', enabled: true, renderers: [{ id: 'view', target: '.md', declares: 'kanban-plugin' }] },
    ]);
    const board = '---\n\nkanban-plugin: board\n\n---\n\n## To Do\n';
    assert.strictEqual(r.rendererFor('plan.md', board).registered, false,
      'a board file is never handed to the extension');
    const refused = r.refusals().find((x) => x.extension === 'board-thief');
    assert.ok(refused, 'the claim was refused at registration, enforced rather than emergent');
    assert.match(refused.reason, /kanban-plugin/, 'the refusal names the marker');
    assert.match(refused.reason, /Rundock/, 'and says the marker is core\'s, not merely taken');
  });

  test('the client and the server spell the same core markers, so the refusal and the roster agree', async () => {
    const mod = await registryModule();
    const server = require('../../lib/packages/extension-registry.js');
    assert.deepStrictEqual(mod.CORE_MARKERS, server.CORE_MARKERS,
      'two copies exist because the registry is browser-side, and this holds them identical');
  });

  test('two extensions declaring one marker: the first claim wins and the loser is recorded with the holder named', async () => {
    const { createRendererRegistry } = await registryModule();
    const r = createRendererRegistry();
    r.registerFromRoster([
      { id: 'first-standup', enabled: true, renderers: [{ id: 'view', target: '.md', declares: 'standup-plugin' }] },
      { id: 'second-standup', enabled: true, renderers: [{ id: 'view', target: '.md', declares: 'standup-plugin' }] },
    ]);
    assert.strictEqual(r.rendererFor('m.md', MARKED).extension, 'first-standup',
      'roster order decides, the discipline bare targets already run on');
    const refused = r.refusals().find((x) => x.extension === 'second-standup');
    assert.ok(refused, 'the losing claim is kept, so a silent renderer is explicable');
    assert.match(refused.reason, /already rendered by first-standup/);
  });

  test('a declared marker outside the key grammar is refused by name and never registers', async () => {
    const { createRendererRegistry } = await registryModule();
    const r = createRendererRegistry();
    r.registerFromRoster([
      { id: 'sloppy-marker', enabled: true, renderers: [{ id: 'view', target: '.md', declares: 'Not A Key!' }] },
    ]);
    const refused = r.refusals().find((x) => x.extension === 'sloppy-marker');
    assert.ok(refused, 'an unreadable marker is a recorded refusal, not a silent drop');
    assert.match(refused.reason, /frontmatter key/, 'the reason states the grammar');
    assert.strictEqual(r.rendererFor('a.md', '---\nNot A Key!: x\n---\n').registered, false);
  });

  test('a bare container claim still works exactly as before, content in hand or not', async () => {
    const { createRendererRegistry } = await registryModule();
    const r = createRendererRegistry();
    r.registerFromRoster([{ id: 'csv-echo', enabled: true, renderers: [{ id: 'view', target: '.csv' }] }]);
    assert.strictEqual(r.rendererFor('a.csv').extension, 'csv-echo', 'a path-only lookup keeps working');
    assert.strictEqual(r.rendererFor('a.csv', 'x,y\n1,2\n').extension, 'csv-echo',
      'and content riding along changes nothing for a whole-type claim');
  });

  test('marked-only claims without content in hand do not fire, and the answer says why', async () => {
    const { createRendererRegistry } = await registryModule();
    const r = createRendererRegistry();
    r.registerFromRoster([
      { id: 'standup', enabled: true, renderers: [{ id: 'view', target: '.md', declares: 'standup-plugin' }] },
    ]);
    const miss = r.rendererFor('notes/monday.md');
    assert.strictEqual(miss.registered, false,
      'a marker cannot be judged without the file, so nothing is claimed blind');
    assert.match(miss.reason, /standup-plugin/);
  });
});

describe('the file view seam degrades, and never mounts blind', () => {
  const FILES_SRC = fs.readFileSync(path.join(ROOT, 'public', 'views', 'files.js'), 'utf-8');

  // Three functions cut from the shipped file, so the code under test is the
  // code that runs in the product: the seam, its transport fallback, and its
  // host loader. Each extraction refuses to match nothing, so a rename fails
  // here rather than testing an empty string.
  function cut(re, name) {
    const m = FILES_SRC.match(re);
    assert.ok(m, `files.js no longer carries ${name}`);
    return m[0];
  }

  // Drive the seam with an injectable host loader and transport, so each path
  // is reachable and distinguishable rather than all collapsing into the
  // dynamic-import failure a Node test environment forces.
  // Build a live scope holding the real seam, its helpers, and the shared
  // release, with activeExtensionMount and extensionSeamToken as mutable
  // closure vars the cut functions assign, so a test can drive two opens and
  // read which mount survived. The four functions are cut from the shipped
  // source, so the code under test is the code that runs in the product.
  function seamScope({ registry, fetcher, hostLoader, currentPath = 'a.chart', refusalFor }) {
    const seam = cut(/function openThroughRendererSeam\(viewers, path, content, surface\) \{[\s\S]*?\n\}/, 'openThroughRendererSeam');
    const fetcherFn = cut(/function fetchExtensionUi\(extensionId, rendererId\) \{[\s\S]*?\n\}/, 'fetchExtensionUi');
    const loaderFn = cut(/function loadExtensionHost\(\) \{[\s\S]*?\n\}/, 'loadExtensionHost');
    const claimFn = cut(/function claimEditorPane\(\) \{[\s\S]*?\n\}/, 'claimEditorPane');
    const releaseFn = cut(/function releaseExtensionMount\(\) \{[\s\S]*?\n\}/, 'releaseExtensionMount');
    // releaseExtensionMount takes regions down with the mount, so the lift
    // carries that function too. Cut from source rather than stubbed: a stub
    // would keep this suite green while the real pair drifted apart, which is
    // the whole failure mode cutting from source exists to prevent.
    const releaseRegionsFn = cut(/function releaseRegions\(\) \{[\s\S]*?\n\}/, 'releaseRegions');
    // The named-sources half of the seam, cut from source for the same reason.
    // The view state read at mount, cut with it; with no fetcher on the
    // window stub it answers no state at once.
    const sourcesFns = ['requestSources(path)', 'noteSourceBaselines(list)', 'endSourcesWatch()', 'sourcesReplyArrived(d)', 'fetchViewState(extension, path)']
      .map((sig) => cut(new RegExp(`function ${sig.replace(/[()]/g, '\\$&')} \\{[\\s\\S]*?\\n\\}`), sig)).join(';\n');
    const surfaced = [];
    const noted = [];
    const paneStub = { classList: { remove() {}, add() {} }, className: '', textContent: '' };
    const windowStub = {
      rundockRendererRegistry: registry,
      rundockExtensionUiFetcher: fetcher,
      rundockExtensionHostLoader: hostLoader,
      // The server's answer for the opened file: cleared, unless a test says
      // otherwise. See extension-file.js.
      rundockExtensionRefusalFor: refusalFor || (() => null),
    };
    const api = new Function(
      'window', 'document', 'currentFilePath', 'noteRendererFailure',
      'openWikilink', 'destroyActiveFileViewer', 'destroyTiptapEditorIfActive', 'clearTimeout', 'fileSaves',
      `let activeExtensionMount = null; let extensionSeamToken = 0;
       let placedRegions = [];
       let sourcesWatchId = null; let sourcesWaiter = null; let sourcesSeq = 0; const sourceBaselines = new Map(); const SOURCES_TIMEOUT_MS = 50;
       // A socket that records what the page asks and, when a test supplies
       // one, answers get_sources the way the server's handler does.
       const ws = { readyState: 1, send(m) {
         const d = JSON.parse(m); (window.__sent || (window.__sent = [])).push(d);
         if (d.type === 'get_sources' && window.__sourcesReply) {
           setTimeout(() => sourcesReplyArrived({ type: 'sources_resolved', watchId: d.watchId, ...window.__sourcesReply(d) }), 0);
         }
       } };
       const WebSocket = { OPEN: 1 };
       ${claimFn}; ${loaderFn}; ${fetcherFn}; ${releaseRegionsFn}; ${sourcesFns}; ${releaseFn}; ${seam};
       return {
         open: (surface) => openThroughRendererSeam({}, currentFilePath, 'content', surface),
         release: releaseExtensionMount,
         mount: () => activeExtensionMount,
         setMount: (h) => { activeExtensionMount = h; },
         reply: (d) => sourcesReplyArrived(d),
         watchId: () => sourcesWatchId,
       };`,
    )(
      windowStub,
      { getElementById: () => paneStub },
      currentPath,
      (reason) => noted.push(reason),
      () => {},
      () => {}, () => {}, () => {}, { schedule() {}, flush() {}, cancel() {}, pendingPath: () => null },
    );
    return { api, surfaced, noted, surface: (v, p) => surfaced.push(p), windowStub };
  }

  function driveSeam(opts) {
    const scope = seamScope(opts);
    scope.api.open(scope.surface);
    return { surfaced: scope.surfaced, noted: scope.noted };
  }

  const CLAIMING_REGISTRY = { rendererFor: () => ({ registered: true, extension: 'charts', renderer: 'chart' }) };

  // A LINKED FILE IS NEVER MOUNTED. The server states, with every read,
  // whether an extension may be handed the file (extension-file.js); the seam
  // forwards that answer, and treats no answer as a refusal.
  test('a file the server refused lands on the plain surface with the rule named, and no host is loaded', async () => {
    let loaded = false;
    const { surfaced, noted } = driveSeam({
      registry: CLAIMING_REGISTRY,
      refusalFor: () => 'a linked file, or a file in a linked folder, is never handed to an extension',
      hostLoader: () => { loaded = true; return Promise.resolve({ mountExtension: () => { throw new Error('should not mount'); } }); },
      fetcher: () => { throw new Error('should not fetch a payload'); },
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(surfaced, ['a.chart']);
    assert.deepStrictEqual(noted, ['a linked file, or a file in a linked folder, is never handed to an extension']);
    assert.strictEqual(loaded, false, 'nothing was even loaded for it');
  });

  // NAMED SOURCES AT THE SEAM: a note's sources are asked for only
  // when the payload declares them AND the claim was by the note's marker,
  // and the page asks with the note's path alone.
  function sourcesScope({ marker, declares }) {
    const mounts = [];
    const scope = seamScope({
      currentPath: 'dash.md',
      registry: { rendererFor: () => ({ registered: true, extension: 'dash', renderer: 'view', ...(marker ? { marker: 'portfolio-dashboard' } : {}) }) },
      fetcher: () => ({ entry: 'x', sources: declares, writes: false }),
      hostLoader: () => Promise.resolve({ mountExtension: (o) => { mounts.push(o); return { alive: () => true, teardown() {}, updateSources(l) { mounts.push({ updated: l }); } }; } }),
    });
    scope.windowStub.__sourcesReply = () => ({ ok: true, path: 'dash.md', sources: [{ path: 'a.csv', content: 'A' }] });
    return { scope, mounts };
  }

  test('a declaring extension claiming the note by its marker is mounted with the resolved sources', async () => {
    const { scope, mounts } = sourcesScope({ marker: true, declares: true });
    scope.api.open(scope.surface);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepStrictEqual(mounts[0].sources, [{ path: 'a.csv', content: 'A' }]);
    const asked = scope.windowStub.__sent.filter((m) => m.type === 'get_sources');
    assert.deepStrictEqual(Object.keys(asked[0]).sort(), ['path', 'type', 'watchId'], 'the note\'s path and the mount\'s own id, nothing else');
  });

  test('a bare claim, or an extension that did not declare sources, asks for nothing and is handed none', async () => {
    for (const opts of [{ marker: false, declares: true }, { marker: true, declares: false }]) {
      const { scope, mounts } = sourcesScope(opts);
      scope.api.open(scope.surface);
      await new Promise((r) => setTimeout(r, 30));
      assert.deepStrictEqual(mounts[0].sources, [], JSON.stringify(opts));
      assert.deepStrictEqual((scope.windowStub.__sent || []).filter((m) => m.type === 'get_sources'), []);
    }
  });

  test('an open superseded before its payload arrives never asks for sources, so it cannot replace the live mount\'s watch', async () => {
    const payloads = [];
    const mounts = [];
    const scope = seamScope({
      currentPath: 'dash.md',
      registry: { rendererFor: () => ({ registered: true, extension: 'dash', renderer: 'view', marker: 'portfolio-dashboard' }) },
      fetcher: () => new Promise((resolve) => payloads.push(resolve)),
      hostLoader: () => Promise.resolve({ mountExtension: (o) => { mounts.push(o); return { alive: () => true, teardown() {}, updateSources() {} }; } }),
    });
    scope.windowStub.__sourcesReply = () => ({ ok: true, sources: [] });
    scope.api.open(scope.surface);
    scope.api.open(scope.surface);
    await new Promise((r) => setTimeout(r, 5));
    payloads[1]({ entry: 'x', sources: true });
    await new Promise((r) => setTimeout(r, 20));
    const live = scope.api.watchId();
    payloads[0]({ entry: 'x', sources: true });
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(scope.windowStub.__sent.filter((m) => m.type === 'get_sources').length, 1, 'only the live open asked');
    assert.strictEqual(scope.api.watchId(), live, 'the live mount\'s watch is untouched');
    assert.strictEqual(mounts.length, 1);
  });

  test('a file opened while the sources are in flight wins: the earlier open never mounts', async () => {
    const { scope, mounts } = sourcesScope({ marker: true, declares: true });
    scope.windowStub.__sourcesReply = null;
    scope.api.open(scope.surface);
    await new Promise((r) => setTimeout(r, 10));
    const pending = scope.windowStub.__sent.find((m) => m.type === 'get_sources');
    // The person opens another file, releasing this mount, before the answer.
    scope.api.release();
    scope.api.reply({ type: 'sources_resolved', watchId: pending.watchId, ok: true, sources: [{ path: 'a.csv', content: 'A' }] });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(mounts, [], 'the superseded open mounted nothing');
  });

  test('a change for this mount reaches it; one for a mount that has ended does not, and release unwatches', async () => {
    const { scope, mounts } = sourcesScope({ marker: true, declares: true });
    scope.api.open(scope.surface);
    await new Promise((r) => setTimeout(r, 30));
    const live = scope.api.watchId();
    scope.api.reply({ type: 'sources_changed', watchId: 'ended', ok: true, sources: [{ path: 'x', content: 'stale' }] });
    scope.api.reply({ type: 'sources_changed', watchId: live, ok: true, sources: [{ path: 'a.csv', content: 'B' }] });
    assert.deepStrictEqual(mounts.slice(1), [{ updated: [{ path: 'a.csv', content: 'B' }] }]);
    scope.api.release();
    assert.deepStrictEqual(scope.windowStub.__sent.filter((m) => m.type === 'unwatch_sources'), [{ type: 'unwatch_sources', watchId: live }]);
    scope.api.reply({ type: 'sources_changed', watchId: live, ok: true, sources: [] });
    assert.strictEqual(mounts.length, 2, 'nothing reaches a released mount');
  });

  test('an unregistered target lands on the plain surface at once', () => {
    const { surfaced, noted } = driveSeam({
      registry: { rendererFor: () => ({ registered: false, reason: 'nothing claims it' }) },
    });
    assert.deepStrictEqual(surfaced, ['a.chart']);
    assert.deepStrictEqual(noted, [], 'no failure to note: an unclaimed file is the ordinary case');
  });

  test('no registry at all is the same ordinary case', () => {
    const { surfaced } = driveSeam({ registry: undefined });
    assert.deepStrictEqual(surfaced, ['a.chart']);
  });

  test('a claimed target with no registered transport degrades, carrying the shipped reason', async () => {
    const { surfaced, noted } = driveSeam({
      registry: CLAIMING_REGISTRY,
      hostLoader: () => Promise.resolve({ mountExtension: () => { throw new Error('should not mount'); } }),
      fetcher: undefined,
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(surfaced, ['a.chart'], 'a broken renderer never costs the reader their file');
    assert.strictEqual(noted.length, 1);
    assert.match(noted[0], /no extension transport is registered yet/,
      'the note carries the shipped fallback reason, not a test-environment import error');
  });

  test('a claimed target with a working transport actually mounts through the host', async () => {
    const mounts = [];
    const { surfaced, noted } = driveSeam({
      registry: CLAIMING_REGISTRY,
      fetcher: () => Promise.resolve({ entry: 'draw();', styles: [] }),
      hostLoader: () => Promise.resolve({
        mountExtension: (opts) => { mounts.push(opts); return { teardown() {} }; },
      }),
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(mounts.length, 1, 'the host was asked to mount the fetched payload');
    assert.strictEqual(mounts[0].payload.entry, 'draw();');
    assert.deepStrictEqual(surfaced, [], 'a working mount does not fall through to the plain surface');
    assert.deepStrictEqual(noted, []);
  });

  test('a mount that then degrades calls the plain surface once, with the host reason verbatim', async () => {
    const { surfaced, noted } = driveSeam({
      registry: CLAIMING_REGISTRY,
      fetcher: () => Promise.resolve({ entry: 'draw();', styles: [] }),
      hostLoader: () => Promise.resolve({
        mountExtension: (opts) => { opts.onDegrade('the view exploded'); return { teardown() {} }; },
      }),
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(surfaced, ['a.chart'], 'the degrade returns the reader to the plain surface exactly once');
    assert.deepStrictEqual(noted, ['the view exploded'], 'the host reason is carried verbatim');
  });

  test('a reply carrying no entry degrades, whatever else it holds', async () => {
    const { surfaced, noted } = driveSeam({
      registry: CLAIMING_REGISTRY,
      fetcher: () => Promise.resolve({ reason: 'the renderer is broken' }),
      hostLoader: () => Promise.resolve({ mountExtension: () => { throw new Error('should not mount'); } }),
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(surfaced, ['a.chart']);
    assert.deepStrictEqual(noted, ['the renderer is broken']);
  });

  test('two opens of one path over a slow transport leave exactly one mount and no repaint', async () => {
    // The double-mount leak: currentFilePath cannot tell two opens of ONE
    // path apart, and the first has not mounted when the second starts, so
    // without a per-open token both resolve, both mount, the first frame and
    // listener leak, and the first's superseded degrade repaints over the
    // live second mount. The token must let exactly one win.
    const mounts = [];
    let hostLoads = 0;
    // Both opens run before either transport resolves; the loader counts
    // mounts and hands back tracked handles whose teardown is recorded.
    const scope2 = seamScope({
      registry: CLAIMING_REGISTRY,
      fetcher: () => new Promise((r) => setTimeout(() => r({ entry: 'draw();', styles: [] }), 5)),
      hostLoader: () => Promise.resolve({
        mountExtension: (opts) => {
          hostLoads += 1;
          const handle = { torn: false, opts, teardown() { this.torn = true; } };
          mounts.push(handle);
          return handle;
        },
      }),
    });
    scope2.api.open((v, p) => scope2.surfaced.push(p));
    scope2.api.open((v, p) => scope2.surfaced.push(p));
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(hostLoads, 1,
      'exactly one open mounted: the superseded one abandoned before mounting');
    assert.ok(scope2.api.mount(), 'a live mount is held');
    assert.strictEqual(scope2.api.mount(), mounts[0],
      'the one that mounted is the tracked handle, not overwritten and leaked');
    assert.deepStrictEqual(scope2.surfaced, [],
      'the superseded open did not repaint the plain surface over the live mount');
  });

  test('releaseExtensionMount tears down a live handle and clears it, so no mount survives a file or workspace switch', () => {
    const scope = seamScope({ registry: CLAIMING_REGISTRY });
    let torn = false;
    scope.api.setMount({ teardown() { torn = true; } });
    scope.api.release();
    assert.strictEqual(torn, true, 'the live mount was torn down');
    assert.strictEqual(scope.api.mount(), null, 'and the reference cleared, so a later release is handed no dead handle');
  });

  test('both file-open and file-close release the extension mount through the one helper', () => {
    // The two call sites the contract points to as the runtime story for a
    // mount surviving a file switch and a workspace switch. Pinned so removing
    // either call reddens: loadFileContent releases before the board-or-seam
    // decision, and closeOpenFile releases on a workspace switch.
    assert.match(FILES_SRC, /releaseExtensionMount\(\);\n\s*const surface = plainSurfaceFor\(viewers, path, content\);/,
      'loadFileContent releases the mount before the board-or-seam decision, so the board branch is covered too');
    // closeOpenFile now stops the region services between these two, because
    // it is the workspace-switch path and a service holds a frame running
    // code installed in the workspace being left. Named in the pattern rather
    // than skipped over with a wildcard, so a THIRD thing appearing here is a
    // deliberate edit to this line and not something that slid in unnoticed.
    assert.match(FILES_SRC, /releaseExtensionMount\(\);\n(?:\s*\/\/[^\n]*\n)*\s*stopRegionServices\(\);\n\s*currentFilePath = null;/,
      'closeOpenFile releases the mount on a workspace switch');
  });

  test('the dispatch routes every open through the seam', () => {
    assert.match(FILES_SRC, /openThroughRendererSeam\(viewers, path, content, surface\);/,
      'the seam is what the file dispatch calls, so no open can bypass the registry question');
  });
});

// Who draws a fenced language. A region claim is not a file claim and
// the two must not shadow each other, so this is a separate lookup with the
// same first-claim-wins rule and the same insistence that a loser can say why
// it is doing nothing.
describe('a region claim is answered separately from a file claim', () => {
  const build = async (extensions) => {
    const { createRendererRegistry } = await registryModule();
    const r = createRendererRegistry();
    r.registerFromRoster(extensions);
    return r;
  };

  test('an extension that draws a language is found by it, and one that draws nothing is not', async () => {
    const r = await build([
      { id: 'mermaid', draws: 'mermaid', renderers: [] },
      { id: 'csv', renderers: [{ id: 'main', target: '.csv' }] },
    ]);
    assert.strictEqual(r.drawerFor('mermaid'), 'mermaid');
    assert.strictEqual(r.drawerFor('csv'), null, 'a file claim is not a region claim');
    assert.strictEqual(r.drawerFor('dataview'), null, 'and an unclaimed language is an ordinary null');
    assert.deepStrictEqual(r.languages(), ['mermaid']);
  });

  test('the two kinds of claim do not shadow each other, in either direction', async () => {
    const r = await build([{ id: 'both', draws: 'mermaid', renderers: [{ id: 'main', target: '.mermaid' }] }]);
    assert.strictEqual(r.drawerFor('mermaid'), 'both', 'it draws the language');
    assert.strictEqual(r.rendererFor('a.mermaid').registered, true, 'and separately owns the file type');
  });

  test('two extensions drawing one language: first wins, and the loser is told why', async () => {
    const r = await build([
      { id: 'first', draws: 'mermaid', renderers: [] },
      { id: 'second', draws: 'mermaid', renderers: [] },
    ]);
    assert.strictEqual(r.drawerFor('mermaid'), 'first');
    const refused = r.refusals().filter((x) => x.extension === 'second');
    assert.strictEqual(refused.length, 1, 'the loser is recorded rather than dropped');
    assert.match(refused[0].reason, /already drawn by first/,
      'and the reason names who took it, so the manage row can explain the silence');
  });

  test('a drawn language outside the grammar is refused by name, never normalised', async () => {
    const r = await build([{ id: 'shouty', draws: 'Mermaid', renderers: [] }]);
    assert.strictEqual(r.drawerFor('mermaid'), null,
      'lowercasing it here would make the manifest and the fence disagree silently');
    assert.match(r.refusals()[0].reason, /lowercase letters/);
  });

  test('a disabled extension draws nothing', async () => {
    const r = await build([{ id: 'off', draws: 'mermaid', enabled: false, renderers: [] }]);
    assert.strictEqual(r.drawerFor('mermaid'), null);
  });
});

// A file in a hidden folder, or a hidden file, is never claimed: an
// extension that could be mounted on `.claude/agents/<slug>.md` and save it
// could rewrite what an agent does the next time it runs.
describe('a hidden path is never handed to an extension', () => {
  const HIDDEN = ['.claude/agents/cos.md', '.mcp.json', '.env', '.rundock/state.json', 'notes/.drafts/a.md'];
  const ORDINARY = ['notes/a.md', 'a/b.c.md', '../notes/a.md', 'notes/v1.2/a.md'];

  test('the rule reads every segment, not only the first', async () => {
    const { isHiddenPath } = await registryModule();
    for (const p of HIDDEN) assert.strictEqual(isHiddenPath(p), true, `${p} is hidden`);
    for (const p of ORDINARY) assert.strictEqual(isHiddenPath(p), false, `${p} is not hidden`);
  });

  test('an extension claiming *.md and *.json is not handed a hidden one, and is told why', async () => {
    const { createRendererRegistry, HIDDEN_PATH_REASON } = await registryModule();
    const r = createRendererRegistry();
    r.registerFromRoster([{ id: 'grabby', enabled: true, renderers: [
      { id: 'md', target: '.md' }, { id: 'json', target: '.json' }] }]);
    assert.strictEqual(r.rendererFor('notes/a.md').registered, true, 'an ordinary note is still claimed');
    for (const p of ['.claude/agents/cos.md', '.mcp.json', 'notes/.drafts/a.md']) {
      assert.deepStrictEqual(r.rendererFor(p, ''), { registered: false, reason: HIDDEN_PATH_REASON });
    }
  });

  test('a document in a hidden folder has no drawer, so its fenced blocks stay text', async () => {
    const { createRendererRegistry } = await registryModule();
    const r = createRendererRegistry();
    r.registerFromRoster([{ id: 'mermaid', enabled: true, renderers: [], draws: 'mermaid' }]);
    const drawer = r.drawerFor('mermaid');
    if (drawer === null) return; // this roster shape does not register a drawer here; covered by the region suite
    assert.strictEqual(r.drawerFor('mermaid', 'notes/a.md'), drawer);
    assert.strictEqual(r.drawerFor('mermaid', '.claude/agents/cos.md'), null);
  });
});
