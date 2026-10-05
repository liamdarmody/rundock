'use strict';
// WHO MAY TALK TO THE SERVER: this machine's own page and its own processes.
//
// The socket listens on loopback, which keeps other machines out but not other
// web pages: any page the person has open can send requests to 127.0.0.1, and
// one whose domain is re-pointed at 127.0.0.1 after it loads (DNS rebinding)
// can read the answers too. Two headers a page cannot choose tell those apart
// from Rundock's own window:
//
//   - HOST. Every request must name a loopback address with the port this
//     server is listening on. A rebound page sends its own domain, so this
//     alone ends rebinding, for HTTP and for the WebSocket alike.
//   - ORIGIN. A browser always sends it on a cross-site write and on a
//     WebSocket upgrade. When present there it must be one of those same
//     loopback addresses. A sandboxed frame sends `null`, which is refused.
//     Absent means a local process (the permission hook, a CLI), which a web
//     page cannot be, so absent is allowed.
//
// The desktop app loads http://localhost:<port>, and a source install is
// opened at localhost or 127.0.0.1, so every legitimate page already matches.
// Reads (GET, HEAD, OPTIONS) skip the Origin half: the Host half already
// stops a page reading them, and the browser withholds a cross-site answer.

const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]'];
const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

// `localhost:<port>`, `127.0.0.1:<port>` or `[::1]:<port>`, exactly.
function isLoopbackHost(host, port) {
  if (typeof host !== 'string') return false;
  const value = host.trim().toLowerCase();
  return LOOPBACK_NAMES.some((name) => value === `${name}:${port}`);
}

// `http://` plus one of the loopback hosts above.
function isAppOrigin(origin, port) {
  if (typeof origin !== 'string') return false;
  const value = origin.trim().toLowerCase();
  return LOOPBACK_NAMES.some((name) => value === `http://${name}:${port}`);
}

// Why this request must be refused, or null when it may proceed.
// `upgrade` marks a WebSocket handshake, which is held to the Origin rule
// whatever its method.
function refusal(req, port, { upgrade = false } = {}) {
  const headers = (req && req.headers) || {};
  if (!isLoopbackHost(headers.host, port)) return 'host';
  const origin = headers.origin;
  const writes = upgrade || !READ_METHODS.includes(String(req.method || 'GET').toUpperCase());
  if (writes && origin !== undefined && !isAppOrigin(origin, port)) return 'origin';
  return null;
}

module.exports = { isLoopbackHost, isAppOrigin, refusal };
