'use strict';
// Desktop guards for the frames that run someone else's code.
//
// WHAT THEY STOP, MEASURED ON THE SHIPPED ELECTRON (42.9.3). An extension's
// frame can navigate itself to another origin carrying the file it was given,
// and it can open a WebRTC connection whose STUN traffic no
// Content-Security-Policy governs. Both delivered data to a listener in the
// confinement runs, and both stopped with the guards below while the app's
// own requests still succeeded (docs/evidence/extension-confinement-evidence.md).
//
// WHICH FRAMES, AND WHY THE KEY IS THE ORIGIN. Only frames whose origin is
// opaque (for a navigation, the origin of the document that started it; see
// shouldBlockNavigation): an extension view and a region renderer are sandboxed with
// `allow-scripts` and nothing else, which gives them the origin "null". The
// app's own page, the HTML file preview (`allow-same-origin`, no scripts) and
// the PDF viewer (same origin) all carry the app's origin and are untouched.
// A guard keyed on "any sub-frame" was tried first in the spike and would
// have broken PDF viewing and links inside an HTML preview. Keying on the
// frame, never on the URL, is also what keeps the app's own traffic out of
// reach: nothing here reads a destination to decide.
//
// WEBRTC IS OFF FOR THE WHOLE WINDOW, and that is the one exception to "only
// extension frames". Electron sets the policy per webContents, not per frame.
// Rundock uses no WebRTC anywhere, so the whole-window setting costs nothing,
// and the day that changes this line is where it has to be revisited.

// A document that is still the frame's own: the srcdoc it was built with,
// or the empty document every frame starts as. Anything else is the frame
// becoming a different page.
function isOwnDocument(url) {
  const u = String(url || '');
  return u === 'about:srcdoc' || u === 'about:blank' || u.startsWith('about:srcdoc#') || u.startsWith('about:blank#');
}

// A frame running third-party code: a sub-frame, with an opaque origin.
// `frame.origin` is Electron's WebFrameMain property; an opaque origin
// serialises as the string "null".
function isExtensionFrame(frame) {
  return !!(frame && frame.parent && frame.origin === 'null');
}

// A NAVIGATION IS JUDGED BY WHO STARTED IT, not by the frame's origin, and
// the difference was measured on 42.9.3. When a `srcdoc` frame is about to
// navigate, Electron reports the FRAME's origin as "null" whether it is an
// extension (opaque) or the HTML file preview (`allow-same-origin`), so a
// frame-origin key blocked the preview's links too. The navigation's
// initiator is the document that asked for it: "null" for an extension's own
// document, the app's origin for the preview. A hostile frame cannot make it
// anything else, because everything it can start is itself opaque.
function shouldBlockNavigation(frame, url, initiatorOrigin) {
  return !!(frame && frame.parent) && initiatorOrigin === 'null' && !isOwnDocument(url);
}

// A request made from an extension frame. The frame's own policy already
// refuses loads, so under normal operation nothing reaches here; this is the
// layer that holds if a future frame policy is ever written wider.
function shouldCancelRequest(details) {
  if (!details || details.resourceType === 'mainFrame') return false;
  const url = String(details.url || '');
  if (url.startsWith('data:') || url.startsWith('blob:') || isOwnDocument(url)) return false;
  return isExtensionFrame(details.frame);
}

// Install everything on one window. Returns what was installed, so the
// caller and a test can see it rather than trust it.
// `onBlocked` is told when a frame was stopped from leaving, so the page can
// end the view and say why: the navigation never happens, so the frame never
// loads a second document and the host would otherwise never learn of it.
function installExtensionFrameGuards(webContents, { log = () => {}, onBlocked = () => {} } = {}) {
  webContents.on('will-frame-navigate', (event) => {
    const initiator = event.initiator && event.initiator.origin;
    if (shouldBlockNavigation(event.frame, event.url, initiator)) {
      event.preventDefault();
      log(`blocked an extension frame navigating to ${String(event.url).slice(0, 80)}`);
      try { onBlocked(); } catch (e) { /* telling the page is courtesy; the block already held */ }
    }
  });
  webContents.session.webRequest.onBeforeRequest((details, callback) => {
    if (shouldCancelRequest(details)) {
      log(`cancelled a request from an extension frame to ${String(details.url).slice(0, 80)}`);
      callback({ cancel: true });
      return;
    }
    callback({});
  });
  webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  return ['will-frame-navigate', 'webRequest.onBeforeRequest', 'webrtc:disable_non_proxied_udp'];
}

module.exports = {
  isOwnDocument, isExtensionFrame, shouldBlockNavigation, shouldCancelRequest,
  installExtensionFrameGuards,
};
