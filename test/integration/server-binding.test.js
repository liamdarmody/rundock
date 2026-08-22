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
// The second test measures a control beside the subject: a wildcard-bound
// socket of its own, alive at the same moment, on the same address, which is
// exactly what the server used to be. A refusal from the server while the
// control accepts is caused by the binding and by nothing else here.
//
// WHY NOTHING IN THIS FILE SKIPS. An earlier version skipped when the machine
// had no network interface, or when the control could not be reached. Measured
// on that version: with the interface table returning only loopback entries the
// file reported pass 2, fail 0, skipped 1 and exit code 0, and no gate in this
// project counts skips. The condition is ordinary rather than exotic: wifi off,
// an unplugged cable, a loopback-only container, a host firewall, or simply a
// slow preflight against a two second timeout. What a skip deletes here is the
// only proof that the refusal comes from the binding rather than from the
// environment, so an environment that cannot carry the experiment is reported
// as a failure naming what could not be established. A red suite on a laptop
// with the wifi off is the intended cost.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const h = require('../helpers/harness.js');

// Generous, because a timed-out connection is now a failure rather than a
// skip: every one of these connects is to this machine.
const CONNECT_TIMEOUT_MS = 5000;
const BANNER_TIMEOUT_MS = 20000;

// Every address that means "this machine only", written out rather than read
// back from the server. Reading the expectation from the constant under test
// would agree just as happily with a wildcard. IPv6 loopback and the
// IPv4-mapped form are safe and belong here: what must fail is a wildcard.
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const SERVER = path.join(__dirname, '..', '..', 'server.js');

let booted;

before(async () => { booted = await h.boot(); });
after(async () => h.shutdown());

// This machine's own address on the local network: the address a neighbour
// would aim at.
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
    assert.ok(LOOPBACK_ADDRESSES.has(address.address),
      `the socket is bound to ${address.address}, which is not one of the addresses that mean this machine only `
      + `(${[...LOOPBACK_ADDRESSES].join(', ')}). A binding outside that set accepts connections from anyone who `
      + 'can route here, and behind it sit agent subprocesses, the workspace, and the permission bridge. Either '
      + 'loopback family passes: what fails is a wildcard.');
  });

  test('a connection from this machine\'s local-network address is refused', async () => {
    const address = booted.internal.server.address();
    assert.ok(address && typeof address === 'object',
      'the server is not listening, so a refused connection below would say nothing about a binding');
    assert.strictEqual(address.port, booted.port,
      'the port dialled below has to be the one the server is listening on right now, or a refusal is only '
      + 'evidence that some unrelated port is closed');

    const iface = localNetworkIPv4();
    assert.ok(iface,
      'this machine has no non-loopback IPv4 interface, so the experiment that proves the refusal comes from '
      + 'the binding cannot run here. This fails rather than skipping: a skip leaves the file green with its '
      + 'causal proof deleted, and nothing in this project counts skips.');

    // The control: a wildcard-bound socket of this test's own, which is
    // exactly what the server used to be, alive at the same moment and dialled
    // at the same address. If the control answers and the server does not, the
    // difference is the binding.
    const control = await listenOn('0.0.0.0');
    assert.ok(!control.error,
      `a control socket could not be bound to the wildcard address here (${control.error}), so there is no way `
      + 'to show that a wildcard binding would have been reachable. Reported as a failure rather than skipped.');

    try {
      const reachedControl = await attemptConnect(iface.address, control.port);
      assert.strictEqual(reachedControl, 'connected',
        `a wildcard-bound control socket on this machine could not be reached at ${iface.address} `
        + `(interface ${iface.name}, outcome "${reachedControl}"), so this environment cannot carry the `
        + 'experiment and a refusal from the server would prove nothing. Reported as a failure rather than '
        + 'skipped, because a green file with no causal proof in it is the worse outcome.');

      const outcome = await attemptConnect(iface.address, address.port);
      assert.strictEqual(outcome, 'ECONNREFUSED',
        `connecting to ${iface.address}:${address.port} on interface ${iface.name} gave "${outcome}", while the `
        + 'wildcard control on the same address was reachable at the same moment. A connection reaching the '
        + 'server on this machine\'s network address is the exposure this closes.');
    } finally {
      await new Promise((resolve) => control.probe.close(resolve));
    }
  });

  test('this machine still reaches the server over loopback, on HTTP and on the WebSocket', async () => {
    const res = await fetch(`http://127.0.0.1:${booted.port}/`);
    assert.strictEqual(res.status, 200,
      'loopback HTTP is the address the permission hook dials, and it is a separate process from this one');
    const client = await h.connect();
    assert.strictEqual(client.ws.readyState, 1,
      'the WebSocket drives the whole interface and connects over loopback');
    client.close();
  });

  test('the startup banner says who can reach the server, not only where it runs', async () => {
    // A user who had been opening Rundock from another device now gets a bare
    // connection refusal. The banner is the one line they actually read, and
    // it is where the refusal stops being a mystery.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-banner-home-'));
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: '0', HOME: home, RUNDOCK_ELECTRON: '1', WORKSPACE: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    try {
      // Wait for the END of the banner, not the first line of it. Resolving on
      // the "running at" line read whichever lines happened to share its chunk,
      // which passed or failed on stream timing rather than on content. This
      // child is started with no workspace precisely so the banner is short and
      // ends at a line that is always printed, whatever else is or is not there.
      const banner = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(
          `the server did not finish printing its startup banner within ${BANNER_TIMEOUT_MS}ms, so this test read `
          + `an incomplete banner rather than a complete one that said too little. Output so far:\n${out}`)), BANNER_TIMEOUT_MS);
        child.stdout.on('data', (chunk) => {
          out += chunk.toString();
          if (/Rundock running at http:\/\/localhost:\d+/.test(out) && /No workspace set/.test(out)) {
            clearTimeout(timer);
            resolve(out);
          }
        });
        child.once('error', (err) => { clearTimeout(timer); reject(err); });
      });
      assert.match(banner, /running at http:\/\/localhost:\d+/,
        'sanity: the line this test reads is the one the server prints at startup');
      assert.match(banner, /this machine only/i,
        'the banner names an address and stops there, so it reads as an invitation to anyone who can reach it. '
        + 'It has to say who can, because binding loopback is now what makes another device fail, and the user '
        + `who meets that failure has only this line to explain it. What it printed:\n${banner}`);
    } finally {
      child.kill('SIGTERM');
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
