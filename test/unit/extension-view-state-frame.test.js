'use strict';
// Extension view state, the frame's half: `Rundock.viewState`, installed by the host's bootstrap before
// Rundock UI and the entry, holding the state the host inlined, frozen, and
// talking only to its own parent. These tests run the document the host
// actually builds for a mount.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

let hostModule = null;
async function host() {
  if (!hostModule) hostModule = await import('../../public/extension-host.js');
  return hostModule;
}

// Mount through the real host, then run the frame document it built, with
// the frame's posts to its parent recorded. `entry` is the view's code.
async function frameFor(entry, opts = {}) {
  const { mountExtension } = await host();
  const page = new JSDOM(`<!doctype html><html><body class="${opts.bodyClass || ''}"><div id="pane"></div></body></html>`, { runScripts: 'outside-only' });
  const handle = mountExtension({
    paneElement: page.window.document.getElementById('pane'),
    payload: { entry, styles: [] },
    path: 'Dash.md', content: '# D\n',
    onDegrade: () => {}, onState: () => {},
    ...('state' in opts ? { state: opts.state } : {}),
  });
  return { page, handle, run: (srcdoc) => run(srcdoc || handle.frame().srcdoc) };
}
function run(srcdoc) {
  const posted = [];
  const frame = new JSDOM(srcdoc, {
    runScripts: 'dangerously',
    // A top-level document is its own parent, so its posts are the frame's
    // posts to the host.
    beforeParse(w) { w.postMessage = (message, origin) => posted.push({ message: JSON.parse(JSON.stringify(message)), origin }); },
  });
  return { w: frame.window, posted: posted.filter((p) => p.message && p.message.type === 'setState') };
}

describe('get works from the entry\'s first line', () => {
  test('the state the host holds is there before the entry\'s first statement, and Rundock UI beside it', async () => {
    const { run: go } = await frameFor('window.__first = Rundock.viewState.get("tab"); window.__ui = typeof Rundock.ui.table;', { state: { tab: 'b' } });
    const { w, posted } = go();
    assert.strictEqual(w.__first, 'b');
    assert.strictEqual(w.__ui, 'function');
    assert.deepStrictEqual(posted, [], 'reading sends nothing');
  });

  test('with no state, every key reads undefined, including one Object.prototype carries', async () => {
    const { run: go } = await frameFor('window.__r = [Rundock.viewState.get("tab"), Rundock.viewState.get("constructor"), Rundock.viewState.get("toString")];');
    assert.deepStrictEqual([...go().w.__r], [undefined, undefined, undefined]);
  });

  test('a region renderer and the gallery get no view state, and the same three scripts as before', async () => {
    const { buildRegionSrcdoc } = await host();
    const page = new JSDOM('<!doctype html><html><body></body></html>');
    const { w } = run(buildRegionSrcdoc({ entry: 'window.__vs = typeof Rundock.viewState;', styles: [] }, page.window.document));
    assert.strictEqual(w.__vs, 'undefined');
    assert.strictEqual(w.document.querySelectorAll('script').length, 3);
  });
});

describe('set is local at once and asks the host to keep the whole state', () => {
  test('each set posts the whole state to the parent; undefined removes an entry', async () => {
    const { run: go } = await frameFor(`
      Rundock.viewState.set("rui.table.positions", { account: 180 });
      Rundock.viewState.set("tab", "c");
      Rundock.viewState.set("tab", undefined);
      window.__after = [Rundock.viewState.get("rui.table.positions"), Rundock.viewState.get("tab")];`, { state: { tab: 'b' } });
    const { w, posted } = go();
    assert.deepStrictEqual(posted.map((p) => p.message), [
      { type: 'setState', state: { tab: 'b', 'rui.table.positions': { account: 180 } } },
      { type: 'setState', state: { tab: 'c', 'rui.table.positions': { account: 180 } } },
      { type: 'setState', state: { 'rui.table.positions': { account: 180 } } },
    ]);
    assert.deepStrictEqual(posted.map((p) => p.origin), ['*', '*', '*']);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(w.__after)), [{ account: 180 }, null]);
  });

  test('a key named like a prototype member is an ordinary entry', async () => {
    const { run: go } = await frameFor('Rundock.viewState.set("__proto__", 1); window.__r = [Rundock.viewState.get("__proto__"), Object.getPrototypeOf({})];');
    const { w, posted } = go();
    assert.strictEqual(w.__r[0], 1);
    assert.strictEqual(posted.length, 1);
    assert.ok(Object.prototype.hasOwnProperty.call(posted[0].message.state, '__proto__'));
  });
});

describe('keys are the view\'s own, checked in the frame', () => {
  test('an empty key, a 65-character key, a space, a slash or a non-string throws a TypeError and posts nothing', async () => {
    const bad = ['""', `"${'k'.repeat(65)}"`, '"a b"', '"a/b"', '7', 'undefined', '({})'];
    const { run: go } = await frameFor(`
      window.__thrown = [];
      for (const k of [${bad.join(',')}]) {
        for (const call of [() => Rundock.viewState.get(k), () => Rundock.viewState.set(k, 1)]) {
          try { call(); window.__thrown.push('none'); } catch (e) { window.__thrown.push(e instanceof TypeError ? 'TypeError' : e.name); }
        }
      }
      Rundock.viewState.set("${'k'.repeat(64)}", 1);
      Rundock.viewState.set("A.z_0:-", 1);`);
    const { w, posted } = go();
    assert.deepStrictEqual([...w.__thrown], Array(bad.length * 2).fill('TypeError'));
    assert.strictEqual(posted.length, 2, 'only the two valid keys were posted');
  });
});

describe('it cannot be replaced or extended from the entry', () => {
  test('assigning, redefining or extending fails, and the original keeps answering', async () => {
    const { run: go } = await frameFor(`
      'use strict';
      const original = Rundock.viewState;
      window.__tries = [
        () => { Rundock.viewState = { get: () => 'forged' }; },
        () => { Rundock.viewState.get = () => 'forged'; },
        () => { Rundock.viewState.extra = 1; },
        () => { Object.defineProperty(Rundock, 'viewState', { value: {} }); },
        () => { window.Rundock = { viewState: {} }; },
        () => { Object.defineProperty(window, 'Rundock', { value: {} }); },
      ].map((attempt) => { try { attempt(); return 'allowed'; } catch (e) { return 'refused'; } });
      window.__same = Rundock.viewState === original && Object.isFrozen(original) && Rundock.viewState.get("tab") === "b";`, { state: { tab: 'b' } });
    const { w } = go();
    assert.deepStrictEqual([...w.__tries], Array(6).fill('refused'));
    assert.strictEqual(w.__same, true);
  });
});

describe('what the host inlines', () => {
  test('text that would close the script, or a line separator, is inlined as data and read back exactly', async () => {
    const tricky = '</script><script>window.__pwned = 1</script>  <!--';
    const { run: go } = await frameFor('window.__v = Rundock.viewState.get("t");', { state: { t: tricky } });
    const { w } = go();
    assert.strictEqual(w.__v, tricky);
    assert.strictEqual(w.__pwned, undefined);
  });

  test('a rebuilt frame (a theme change) opens with the last state the host accepted, not a refused one', async () => {
    const { page, handle, run: go } = await frameFor('window.__v = Rundock.viewState.get("tab");', { state: { tab: 'b' } });
    const frame = handle.frame();
    frame.contentWindow.postMessage = () => {};
    const say = (data) => handle.dispatch({ source: handle.frame().contentWindow, data });
    say({ type: 'ready' });
    say({ type: 'setState', state: { tab: 'c' } });
    say({ type: 'setState', state: { tab: 'd', when: new Date(0) } });
    page.window.document.body.classList.add('light');
    await new Promise((r) => setTimeout(r, 0));
    assert.notStrictEqual(handle.frame(), frame, 'the frame was rebuilt');
    assert.strictEqual(go().w.__v, 'c');
  });
});
