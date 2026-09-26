'use strict';
// Rundock UI reaches every extension frame, and reaching it changes nothing
// else about the frame.
//
// The host builds one document for a mounted view and a region renderer
// alike (buildSrcdoc). These tests read that document and then run it, so
// what is proved is what a frame actually gets: the library defined before
// the extension's own code runs, its stylesheet between the floor and the
// extension's styles, the theme class on body, and the sandbox, the policy
// and the message wire exactly as they were.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const TOKENS_CSS = fs.readFileSync(path.join(ROOT, 'public', 'styles', 'tokens.css'), 'utf-8');
const BASE_CSS = fs.readFileSync(path.join(ROOT, 'public', 'styles', 'extension-base.css'), 'utf-8');
const UI_CSS = fs.readFileSync(path.join(ROOT, 'public', 'styles', 'rundock-ui.css'), 'utf-8');

let hostModule = null;
async function host() {
  if (!hostModule) hostModule = await import('../../public/extension-host.js');
  return hostModule;
}

// A page shaped like index.html's head: tokens, the floor linked as a
// readable but inert sheet, and Rundock UI's sheet.
function page(bodyClass = '') {
  const dom = new JSDOM(`<!doctype html><html><head>
    <style>${TOKENS_CSS}</style>
    <style data-extension-base>${BASE_CSS}</style>
    <style data-rundock-ui>${UI_CSS}</style>
  </head><body class="${bodyClass}"><div id="pane"></div></body></html>`, { runScripts: 'outside-only' });
  return { dom, doc: dom.window.document, pane: dom.window.document.getElementById('pane') };
}

const PAYLOAD = {
  entry: 'window.__sawUi = typeof Rundock === "object" && typeof Rundock.ui.button === "function" ? Rundock.ui.version : "missing";',
  styles: ['.mine { color: red; }'],
};

describe('the frame document carries Rundock UI', () => {
  test('the library runs before the entry, so an extension can call it at once', async () => {
    const { buildRegionSrcdoc } = await host();
    const { doc } = page();
    const srcdoc = buildRegionSrcdoc(PAYLOAD, doc);
    // Run the frame's document for real. jsdom does not enforce the
    // frame's CSP, which is fine: what is measured here is order, and the
    // policy is asserted as text below.
    const frame = new JSDOM(srcdoc, { runScripts: 'dangerously' });
    assert.match(String(frame.window.__sawUi), /^\d+\.\d+$/, `the entry saw ${frame.window.__sawUi}`);
    const scripts = [...frame.window.document.querySelectorAll('script')].map((s) => s.textContent);
    assert.strictEqual(scripts.length, 3, 'bootstrap, library, entry: one more script than before and no other change');
    assert.match(scripts[0], /window\.onerror/);
    assert.match(scripts[1], /installRundockUi/);
    assert.strictEqual(scripts[2], PAYLOAD.entry);
  });

  test('the stylesheet sits after the floor and before the extension, so the extension can override it', async () => {
    const { buildRegionSrcdoc } = await host();
    const { doc } = page();
    const frame = new JSDOM(buildRegionSrcdoc(PAYLOAD, doc)).window.document;
    const styles = [...frame.querySelectorAll('style')].map((s) => s.textContent);
    assert.strictEqual(styles.length, 4, 'tokens, floor, Rundock UI, the extension');
    assert.match(styles[0], /^:root \{ --/);
    assert.match(styles[1], /html, body/);
    assert.match(styles[2], /\.rui-btn-primary/);
    assert.strictEqual(styles[3], PAYLOAD.styles[0]);
  });

  test('the frame body carries the light class in the light theme, and none in dark', async () => {
    const { buildRegionSrcdoc } = await host();
    const light = new JSDOM(buildRegionSrcdoc(PAYLOAD, page('light').doc)).window.document;
    assert.ok(light.body.classList.contains('light'));
    const dark = new JSDOM(buildRegionSrcdoc(PAYLOAD, page('').doc)).window.document;
    assert.strictEqual(dark.body.className, '');
  });

  test('a mounted view gets the same library as a region, and the same posture as before', async () => {
    const { mountExtension } = await host();
    const { pane } = page();
    const handle = mountExtension({ paneElement: pane, payload: PAYLOAD, onDegrade() {}, readyTimeoutMs: 60000 });
    const frame = handle.frame();
    assert.strictEqual(frame.getAttribute('sandbox'), 'allow-scripts', 'the sandbox is unchanged');
    assert.match(frame.srcdoc, /installRundockUi/);
    assert.match(frame.srcdoc, /<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;|<meta http-equiv="Content-Security-Policy" content="default-src 'none'/);
    handle.teardown();
  });

  test('an embedded view is built with Rundock UI, which runs before its entry', async () => {
    const { mountExtension } = await host();
    const { pane } = page('light');
    const handle = mountExtension({ paneElement: pane, payload: PAYLOAD, embedded: true, onDegrade() {}, readyTimeoutMs: 60000 });
    const frame = new JSDOM(handle.frame().srcdoc, { runScripts: 'dangerously' });
    assert.match(String(frame.window.__sawUi), /^\d+\.\d+$/, `the embedded entry saw ${frame.window.__sawUi}`);
    const styles = [...frame.window.document.querySelectorAll('style')].map((s) => s.textContent);
    assert.ok(styles.some((css) => /\.rui-btn-primary/.test(css)), 'the embedded frame carries the Rundock UI stylesheet');
    handle.teardown();
  });

  test('an embedded view is told so on its body, and a view opened on its own is not', async () => {
    const { mountExtension } = await host();
    for (const [embedded, bodyClass] of [[true, 'light rundock-embedded'], [false, 'light']]) {
      const { pane } = page('light');
      const handle = mountExtension({ paneElement: pane, payload: PAYLOAD, embedded, onDegrade() {}, readyTimeoutMs: 60000 });
      const body = new JSDOM(handle.frame().srcdoc).window.document.body;
      assert.strictEqual(body.className, bodyClass);
      handle.teardown();
    }
  });

  test('a failed install stops the frame\'s document, so the entry after it never runs, and still reports', async () => {
    const { rundockUiScript } = await import('../../public/rundock-ui-frame.js');
    const text = rundockUiScript();
    assert.match(text, /^try \{ \(function installRundockUi/);
    assert.match(text, /catch \(rundockUiFailure\) \{ window\.stop\(\); throw rundockUiFailure; \}$/);
  });

  test('once a frame has reported a failure, the host ignores everything it says after', async () => {
    const { mountExtension } = await host();
    const { pane } = page();
    const degraded = [];
    const opened = [];
    const saved = [];
    const handle = mountExtension({
      paneElement: pane, payload: { ...PAYLOAD, writes: true }, onDegrade: (r) => degraded.push(r), readyTimeoutMs: 60000,
      onOpen: (t) => opened.push(t), onSave: (c) => saved.push(c),
    });
    const source = handle.frame().contentWindow;
    const sent = [];
    source.postMessage = (m) => sent.push(m);
    handle.dispatch({ source, data: { type: 'error', message: 'Rundock UI failed to install' } });
    for (const data of [{ type: 'ready' }, { type: 'open', target: 'x.md' }, { type: 'save', content: 'x' }, { type: 'error', message: 'again' }, { type: 'resize', height: 99 }]) {
      handle.dispatch({ source, data });
    }
    assert.deepStrictEqual(degraded, ['the extension reported a failure: Rundock UI failed to install'], 'one failure, named once');
    assert.deepStrictEqual(sent, [], 'nothing, not even a refusal, goes back to the failed frame');
    assert.deepStrictEqual([opened, saved], [[], []]);
  });

  test('the frame policy is the same text with and without the library', async () => {
    const { buildRegionSrcdoc } = await host();
    const policy = (html) => /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)[1];
    const withUi = buildRegionSrcdoc(PAYLOAD, page().doc);
    const withoutDoc = buildRegionSrcdoc(PAYLOAD, null);
    assert.strictEqual(policy(withUi), policy(withoutDoc));
    assert.strictEqual(policy(withUi), "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;");
  });

  test('without a page to read, the library still travels and the stylesheet is simply absent', async () => {
    const { buildRegionSrcdoc } = await host();
    const frame = new JSDOM(buildRegionSrcdoc(PAYLOAD, null), { runScripts: 'dangerously' });
    assert.match(String(frame.window.__sawUi), /^\d+\.\d+$/);
    assert.strictEqual(frame.window.document.querySelectorAll('style').length, 1, 'only the extension\'s own style');
  });

  test('an entry that tries to close the library\'s script cannot', async () => {
    const { rundockUiScript } = await import('../../public/rundock-ui-frame.js');
    assert.ok(!rundockUiScript().includes('</script'), 'the library text never carries a closing tag');
  });
});

describe('the library and the server agree on the version', () => {
  test('Rundock.ui.version is the version the install checks against', async () => {
    const { RUNDOCK_UI_VERSION } = require('../../lib/packages/rundock-ui-version.js');
    const { rundockUiScript } = await import('../../public/rundock-ui-frame.js');
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    dom.window.eval(rundockUiScript());
    assert.strictEqual(dom.window.Rundock.ui.version, RUNDOCK_UI_VERSION);
  });
});
