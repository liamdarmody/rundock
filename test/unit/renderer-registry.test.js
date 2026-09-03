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
});

describe('the file view seam degrades, and never mounts blind', () => {
  const FILES_SRC = fs.readFileSync(path.join(ROOT, 'public', 'views', 'files.js'), 'utf-8');

  // The seam's own function, cut from the shipped file the way the doors
  // suites cut dispatch cases: the extraction refuses to match nothing, so a
  // renamed seam fails here instead of testing an empty string.
  function cutSeam() {
    const m = FILES_SRC.match(/function openThroughRendererSeam\(viewers, path, content, surface\) \{[\s\S]*?\n\}/);
    assert.ok(m, 'files.js no longer carries openThroughRendererSeam');
    return m[0];
  }

  // The transport fallback is cut beside the seam, so the no-transport
  // answer under test is the shipped one rather than a stand-in.
  function cutFetcher() {
    const m = FILES_SRC.match(/function fetchExtensionUi\(extensionId, rendererId\) \{[\s\S]*?\n\}/);
    assert.ok(m, 'files.js no longer carries fetchExtensionUi');
    return m[0];
  }

  function driveSeam({ registry, currentPath = 'a.chart' }) {
    const seam = cutSeam();
    const fetcher = cutFetcher();
    const surfaced = [];
    const noted = [];
    const windowStub = { rundockRendererRegistry: registry };
    const fn = new Function(
      'window', 'document', 'currentFilePath', 'noteRendererFailure',
      'openWikilink', 'activeExtensionMount',
      `${fetcher}; ${seam}; return openThroughRendererSeam;`,
    )(
      windowStub,
      { getElementById: () => ({ classList: { remove() {} }, textContent: '' }) },
      currentPath,
      (reason) => noted.push(reason),
      () => {},
      null,
    );
    fn({}, currentPath, 'content', (v, p) => surfaced.push(p));
    return { surfaced, noted };
  }

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

  test('a claimed target whose transport or mount fails degrades to the plain surface, named', async () => {
    const { surfaced, noted } = driveSeam({
      registry: { rendererFor: () => ({ registered: true, extension: 'charts', renderer: 'chart' }) },
      fetcher: undefined,
    });
    // The claim path is asynchronous; the degrade must arrive, not be hoped
    // for. Either the missing transport or the unloadable host module lands
    // it on the surface with a reason.
    await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual(surfaced, ['a.chart'],
      'a broken renderer never costs the reader their file');
    assert.strictEqual(noted.length, 1);
  });

  test('the dispatch routes every open through the seam', () => {
    assert.match(FILES_SRC, /openThroughRendererSeam\(viewers, path, content, surface\);/,
      'the seam is what the file dispatch calls, so no open can bypass the registry question');
  });
});
