'use strict';
// The desktop guards' decisions, driven with frame shapes rather than a live
// Electron. At the unit level: the guards reach extension frames and
// nothing else. A guard widened to "every sub-frame" or "every request"
// fails here before any real-engine run, which is the point: the real-engine
// proof (the confinement run in the release gate) is slower and would find
// it later.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const guards = require('../../electron/extension-frame-guards.js');

const APP_ORIGIN = 'http://localhost:3000';
const appPage = { parent: null, origin: APP_ORIGIN };
// What each frame in the product looks like to Electron.
const extensionView = { parent: appPage, origin: 'null' };     // sandbox="allow-scripts"
const regionRenderer = { parent: appPage, origin: 'null' };    // sandbox="allow-scripts", headless
const htmlPreview = { parent: appPage, origin: APP_ORIGIN };   // sandbox="allow-same-origin", no scripts
const pdfViewer = { parent: appPage, origin: APP_ORIGIN };     // same-origin src

describe('navigation: extension frames may not become another page', () => {
  // Judged by the initiator's origin. Measured on 42.9.3: at navigation time
  // Electron reports every srcdoc frame's OWN origin as "null", preview
  // included, so the initiator is what tells them apart.
  test('an extension view or region renderer going anywhere else is blocked', () => {
    for (const frame of [extensionView, regionRenderer]) {
      assert.strictEqual(guards.shouldBlockNavigation(frame, 'https://attacker.example/?d=secret', 'null'), true);
      assert.strictEqual(guards.shouldBlockNavigation(frame, 'http://127.0.0.1:9/x', 'null'), true);
      assert.strictEqual(guards.shouldBlockNavigation(frame, 'file:///etc/passwd', 'null'), true);
      assert.strictEqual(guards.shouldBlockNavigation(frame, 'data:text/html,<script>x</script>', 'null'), true,
        'a data: page is a new document with no frame policy at all');
    }
  });

  test('the frame loading its own srcdoc, or starting blank, is not blocked', () => {
    for (const url of ['about:srcdoc', 'about:blank', 'about:srcdoc#top']) {
      assert.strictEqual(guards.shouldBlockNavigation(extensionView, url, 'null'), false, url);
    }
  });

  test('the app page, the HTML preview and the PDF viewer are never touched', () => {
    for (const frame of [appPage, htmlPreview, pdfViewer]) {
      assert.strictEqual(guards.shouldBlockNavigation(frame, 'https://example.org/', APP_ORIGIN), false,
        'keyed to opaque initiators: a guard on every sub-frame would break PDFs and preview links');
    }
    // The preview's own frame origin reads "null" at navigation time, which
    // is the measured trap; its initiator is the app's origin.
    assert.strictEqual(guards.shouldBlockNavigation({ parent: appPage, origin: 'null' }, 'https://example.org/', APP_ORIGIN), false);
  });
});

describe('requests: only extension frames are refused', () => {
  test('a request from an extension frame is cancelled', () => {
    assert.strictEqual(guards.shouldCancelRequest({ resourceType: 'xhr', url: 'https://attacker.example/', frame: extensionView }), true);
    assert.strictEqual(guards.shouldCancelRequest({ resourceType: 'subFrame', url: 'https://attacker.example/', frame: regionRenderer }), true);
  });

  test('inline data the frame policy allows is not cancelled', () => {
    assert.strictEqual(guards.shouldCancelRequest({ resourceType: 'image', url: 'data:image/png;base64,AA', frame: extensionView }), false);
  });

  test("the app's own traffic passes, whatever its destination", () => {
    assert.strictEqual(guards.shouldCancelRequest({ resourceType: 'mainFrame', url: `${APP_ORIGIN}/`, frame: appPage }), false);
    assert.strictEqual(guards.shouldCancelRequest({ resourceType: 'xhr', url: 'https://api.github.com/repos/x/releases', frame: appPage }), false,
      'the update check reaches its host');
    assert.strictEqual(guards.shouldCancelRequest({ resourceType: 'xhr', url: `${APP_ORIGIN}/api/file`, frame: pdfViewer }), false);
    assert.strictEqual(guards.shouldCancelRequest({ resourceType: 'image', url: 'https://example.org/a.png', frame: htmlPreview }), false);
    assert.strictEqual(guards.shouldCancelRequest({ resourceType: 'xhr', url: 'https://x/', frame: null }), false,
      'a request Electron cannot attribute to a frame is not assumed to be an extension');
  });
});

describe('installation', () => {
  test('all three guards are installed on the window, and WebRTC is turned off for it', () => {
    const on = [];
    let before = null;
    let policy = null;
    const webContents = {
      on: (name) => on.push(name),
      session: { webRequest: { onBeforeRequest: (fn) => { before = fn; } } },
      setWebRTCIPHandlingPolicy: (p) => { policy = p; },
    };
    const installed = guards.installExtensionFrameGuards(webContents);
    assert.deepStrictEqual(on, ['will-frame-navigate']);
    assert.strictEqual(typeof before, 'function');
    assert.strictEqual(policy, 'disable_non_proxied_udp');
    assert.strictEqual(installed.length, 3);
  });

  test('the navigation handler prevents only what the decision refuses', () => {
    let handler = null;
    const webContents = {
      on: (name, fn) => { if (name === 'will-frame-navigate') handler = fn; },
      session: { webRequest: { onBeforeRequest: () => {} } },
      setWebRTCIPHandlingPolicy: () => {},
    };
    guards.installExtensionFrameGuards(webContents);
    let prevented = 0;
    const opaque = { origin: 'null' };
    const app = { origin: APP_ORIGIN };
    handler({ frame: extensionView, initiator: opaque, url: 'https://attacker.example/', preventDefault: () => { prevented += 1; } });
    handler({ frame: htmlPreview, initiator: app, url: 'https://example.org/', preventDefault: () => { prevented += 1; } });
    handler({ frame: extensionView, initiator: app, url: 'about:srcdoc', preventDefault: () => { prevented += 1; } });
    assert.strictEqual(prevented, 1);
  });

  test('a blocked navigation tells the page, so the view can end and say why', () => {
    let handler = null;
    let told = 0;
    const webContents = {
      on: (name, fn) => { if (name === 'will-frame-navigate') handler = fn; },
      session: { webRequest: { onBeforeRequest: () => {} } },
      setWebRTCIPHandlingPolicy: () => {},
    };
    guards.installExtensionFrameGuards(webContents, { onBlocked: () => { told += 1; } });
    handler({ frame: extensionView, initiator: { origin: 'null' }, url: 'https://attacker.example/', preventDefault() {} });
    handler({ frame: htmlPreview, initiator: { origin: APP_ORIGIN }, url: 'https://example.org/', preventDefault() {} });
    assert.strictEqual(told, 1);
  });

  test('the request handler cancels an extension frame and lets the app through', () => {
    let handler = null;
    const webContents = {
      on: () => {},
      session: { webRequest: { onBeforeRequest: (fn) => { handler = fn; } } },
      setWebRTCIPHandlingPolicy: () => {},
    };
    guards.installExtensionFrameGuards(webContents);
    const answers = [];
    handler({ resourceType: 'xhr', url: 'https://attacker.example/', frame: extensionView }, (a) => answers.push(a));
    handler({ resourceType: 'xhr', url: `${APP_ORIGIN}/api/x`, frame: appPage }, (a) => answers.push(a));
    assert.deepStrictEqual(answers, [{ cancel: true }, {}]);
  });
});
