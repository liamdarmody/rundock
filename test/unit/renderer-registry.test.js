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
  function seamScope({ registry, fetcher, hostLoader, currentPath = 'a.chart' }) {
    const seam = cut(/function openThroughRendererSeam\(viewers, path, content, surface\) \{[\s\S]*?\n\}/, 'openThroughRendererSeam');
    const fetcherFn = cut(/function fetchExtensionUi\(extensionId, rendererId\) \{[\s\S]*?\n\}/, 'fetchExtensionUi');
    const loaderFn = cut(/function loadExtensionHost\(\) \{[\s\S]*?\n\}/, 'loadExtensionHost');
    const claimFn = cut(/function claimEditorPane\(\) \{[\s\S]*?\n\}/, 'claimEditorPane');
    const releaseFn = cut(/function releaseExtensionMount\(\) \{[\s\S]*?\n\}/, 'releaseExtensionMount');
    const surfaced = [];
    const noted = [];
    const paneStub = { classList: { remove() {}, add() {} }, className: '', textContent: '' };
    const windowStub = {
      rundockRendererRegistry: registry,
      rundockExtensionUiFetcher: fetcher,
      rundockExtensionHostLoader: hostLoader,
    };
    const api = new Function(
      'window', 'document', 'currentFilePath', 'noteRendererFailure',
      'openWikilink', 'destroyActiveFileViewer', 'destroyTiptapEditorIfActive', 'clearTimeout', '_tiptapSaveTimer',
      `let activeExtensionMount = null; let extensionSeamToken = 0;
       ${claimFn}; ${loaderFn}; ${fetcherFn}; ${releaseFn}; ${seam};
       return {
         open: (surface) => openThroughRendererSeam({}, currentFilePath, 'content', surface),
         release: releaseExtensionMount,
         mount: () => activeExtensionMount,
         setMount: (h) => { activeExtensionMount = h; },
       };`,
    )(
      windowStub,
      { getElementById: () => paneStub },
      currentPath,
      (reason) => noted.push(reason),
      () => {},
      () => {}, () => {}, () => {}, null,
    );
    return { api, surfaced, noted, surface: (v, p) => surfaced.push(p) };
  }

  function driveSeam(opts) {
    const scope = seamScope(opts);
    scope.api.open(scope.surface);
    return { surfaced: scope.surfaced, noted: scope.noted };
  }

  const CLAIMING_REGISTRY = { rendererFor: () => ({ registered: true, extension: 'charts', renderer: 'chart' }) };

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
    assert.match(FILES_SRC, /releaseExtensionMount\(\);\n\s*\/\/ A markdown file whose frontmatter/,
      'loadFileContent releases the mount before the board-or-seam decision, so the board branch is covered too');
    assert.match(FILES_SRC, /releaseExtensionMount\(\);\n\s*currentFilePath = null;/,
      'closeOpenFile releases the mount on a workspace switch');
  });

  test('the dispatch routes every open through the seam', () => {
    assert.match(FILES_SRC, /openThroughRendererSeam\(viewers, path, content, surface\);/,
      'the seam is what the file dispatch calls, so no open can bypass the registry question');
  });
});
