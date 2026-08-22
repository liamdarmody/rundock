'use strict';
// Integration: the socket the whole product sits behind must answer this
// machine only.
//
// server.js called listen with a port and no host, so Node bound every
// interface. What is behind that socket is not a static file server: it spawns
// agent subprocesses, reads and writes the workspace the user chose, carries
// the permission bridge, and holds the WebSocket that drives the interface.
// Anything that can reach the port can reach all of that, and on a shared
// network that is anybody sitting near you.
//
// WHAT THIS ASSERTS, AND WHY IT IS SHAPED THIS WAY. "The server started" and
// "the request worked" are both true whatever the socket bound to, so neither
// can catch this coming back. The first test reads the address the listening
// socket actually holds. The second connects to this machine's own address on
// the local network, which is as close as a test running on one machine can
// get to the machine next door, and requires that connection to be refused.
//
// The second test proves this environment can make that connection at all
// before it concludes anything from a failed one. Without the preflight, a
// sandbox that blocks local network traffic produces a refusal that looks
// exactly like the fix working, and the test reports green over a socket open
// to the whole network.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');

const h = require('../helpers/harness.js');

const CONNECT_TIMEOUT_MS = 2000;

let booted;

before(async () => { booted = await h.boot(); });
after(async () => h.shutdown());

// This machine's own address on the local network: the address a neighbour
// would aim at. Skipped rather than faked when the machine has none.
function localNetworkIPv4() {
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return { name, address: a.address };
    }
  }
  return null;
}

// Resolves to 'connected', or the code of whatever stopped the connection.
// Never rejects: the outcome is the measurement.
function attemptConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const settle = (outcome) => { socket.destroy(); resolve(outcome); };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once('connect', () => settle('connected'));
    socket.once('timeout', () => settle('ETIMEDOUT'));
    socket.once('error', (err) => settle(err.code || err.message));
  });
}

function listenOn(host) {
  return new Promise((resolve) => {
    const probe = net.createServer((s) => s.end());
    probe.once('error', (err) => resolve({ error: err.code || err.message }));
    probe.listen(0, host, () => resolve({ probe, port: probe.address().port }));
  });
}

describe('server binding', () => {
  test('the listening socket holds a loopback address, not every interface', () => {
    const address = booted.internal.server.address();
    assert.ok(address && typeof address === 'object',
      'the server is not listening, so nothing here examined a binding at all');
    assert.strictEqual(address.port, booted.port,
      'the socket read here has to be the one startServer reported, or this asserts about some other server');
    assert.strictEqual(address.address, '127.0.0.1',
      `the server is bound to ${address.address}, which accepts connections from anyone who can route to `
      + 'this machine. Behind it sit agent subprocesses, the workspace, and the permission bridge.');
  });

  test('a connection from this machine\'s local-network address is refused', async (t) => {
    const iface = localNetworkIPv4();
    if (!iface) {
      return t.skip('this machine has no non-loopback IPv4 interface, so there is no local-network address to aim at');
    }

    // Preflight: can this environment connect to that address at all? A
    // refusal below means nothing unless a connection there can succeed.
    const probe = await listenOn(iface.address);
    if (probe.error) {
      return t.skip(`cannot bind ${iface.address} here (${probe.error}), so the preflight cannot establish reachability`);
    }
    const preflight = await attemptConnect(iface.address, probe.port);
    await new Promise((resolve) => probe.probe.close(resolve));
    if (preflight !== 'connected') {
      return t.skip(`this environment cannot connect to ${iface.address} at all (${preflight}), `
        + 'so a refused connection would prove nothing about the binding');
    }

    const outcome = await attemptConnect(iface.address, booted.port);
    assert.strictEqual(outcome, 'ECONNREFUSED',
      `connecting to ${iface.address}:${booted.port} on interface ${iface.name} gave "${outcome}". `
      + 'A connection reaching the server on this machine\'s network address is the exposure this card closes; '
      + `the preflight already proved connections to ${iface.address} succeed here.`);
  });

  test('this machine still reaches the server over loopback, on HTTP and on the WebSocket', async () => {
    const res = await fetch(`http://127.0.0.1:${booted.port}/`);
    assert.strictEqual(res.status, 200,
      'loopback HTTP is the address the permission hook dials, and it is a separate process from this one');
    const client = await h.connect();
    assert.strictEqual(client.ws.readyState, 1, 'the WebSocket drives the whole interface and connects over loopback');
    client.close();
  });
});
