'use strict';
// THE DESKTOP WINDOW'S KEY, held by this process and never by the page.
//
// The server refuses every request that does not come from Rundock's own
// window (lib/auth). On the desktop the window proves it with the launch key,
// which this main process reads from the in-process server and adds as a
// header to every request the window makes to that server: the page itself,
// its scripts, fetches, images, PDFs and the WebSocket upgrade. The page's own
// code never sees it, so nothing it runs, and nothing an extension frame
// runs, can hand it on.
//
// ONLY THE APP'S OWN ORIGIN, AND NEVER AN EXTENSION FRAME. The header is added
// to requests for this server's loopback addresses alone, so the key never
// leaves for anywhere else, and never to a request an extension frame makes
// (electron/extension-frame-guards.js cancels those too; this holds if that
// ever changes).
//
// NO DEBUGGING DOOR. A process started with a debugging switch could be
// driven by whatever connects to that port, and could read the key. Shipped
// builds turn the Node switches off at build time (package.json
// build.electronFuses); this refuses Chromium's remote-debugging switch, and
// the inspect switches, at launch as well.

const { isExtensionFrame } = require('./extension-frame-guards');

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

// The URL patterns the header is added for: this server, every loopback name,
// HTTP and WebSocket.
function keyedUrlPatterns(port) {
  const out = [];
  for (const host of LOOPBACK) {
    out.push(`http://${host}:${port}/*`, `ws://${host}:${port}/*`);
  }
  return out;
}

// Whether a request should carry the key: to this server, from the window's
// own page (never an extension frame).
function shouldAddKey(details, port) {
  if (!details) return false;
  let url;
  try { url = new URL(String(details.url)); } catch (e) { return false; }
  if (url.protocol !== 'http:' && url.protocol !== 'ws:') return false;
  if (!LOOPBACK.includes(url.hostname) && !LOOPBACK.includes(`[${url.hostname}]`)) return false;
  if (String(url.port) !== String(port)) return false;
  // A request that names its origin must name the app's own. Anything else,
  // a worker started by an opaque document included, is not the window.
  const headers = details.requestHeaders || {};
  const origin = Object.keys(headers).find((k) => k.toLowerCase() === 'origin');
  if (origin !== undefined && !LOOPBACK.some((h) => String(headers[origin]).toLowerCase() === `http://${h}:${port}`)) return false;
  return !isExtensionFrame(details.frame);
}

function installWindowKey(session, { port, key, header }) {
  session.webRequest.onBeforeSendHeaders({ urls: keyedUrlPatterns(port) }, (details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    if (shouldAddKey(details, port)) requestHeaders[header] = key;
    callback({ requestHeaders });
  });
}

// The switches that would open a debugging port on this process.
const DEBUG_SWITCHES = ['--remote-debugging-port', '--remote-debugging-pipe', '--inspect', '--inspect-brk', '--inspect-port', '--debug', '--debug-brk'];

function debugSwitchIn(argv) {
  for (const arg of argv || []) {
    const name = String(arg).split('=')[0];
    if (DEBUG_SWITCHES.includes(name)) return name;
  }
  return null;
}

module.exports = { keyedUrlPatterns, shouldAddKey, installWindowKey, debugSwitchIn, DEBUG_SWITCHES };
