'use strict';
// Reconnecting Claude Code from the chat, through the real server and its auth.
//
// Two routes: one opens a console running `claude` on this machine, the other
// asks whether Claude Code is connected again. Opening a window on someone's
// machine is a privileged act and the check costs a turn, so both are closed:
// only Rundock's own window reaches them, with its key on the desktop or a
// browser's session token from source. Never an agent, which has no key, and
// never the permission hook's token, which an agent's own process tree holds.
//
// Each refusal has a twin made as the window that succeeds, so a refusal can
// never pass because the route was simply missing. No real window is opened:
// the opener is swapped for one that records being called. The check runs the
// stub `claude`, which a test signs out with STUB_CLAUDE_SIGNED_OUT.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const h = require('../helpers/harness.js');
const auth = require('../../lib/auth/index.js');
const router = require('../../lib/http-router.js');

let opened = 0;
let checked = 0;
let prevDeps = null;

before(async () => {
  await h.boot();
  // Wired by server.js at boot; wrapped here, by identity, so a test can see
  // whether a refused request reached either one. The check still runs the
  // real code against the stub.
  const realCheck = router.wireHttpRouterDeps({}).checkClaudeConnection;
  prevDeps = router.wireHttpRouterDeps({
    openClaudeConsole: async () => { opened++; return { ok: true }; },
    checkClaudeConnection: () => { checked++; return realCheck(); },
  });
});
after(async () => {
  if (prevDeps) router.wireHttpRouterDeps(prevDeps);
  delete process.env.STUB_CLAUDE_SIGNED_OUT;
  delete process.env.STUB_CLAUDE_CHECK_FAILS;
  await h.shutdown();
});
beforeEach(() => { opened = 0; checked = 0; });

function post(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.port, method: 'POST', path: url, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

const ROUTES = [['/api/claude/reconnect', () => opened], ['/api/claude/connection', () => checked]];

describe('only Rundock\'s own window reaches the reconnect routes', () => {
  for (const [route, calls] of ROUTES) {
    test(`${route}: no credentials at all is refused, and nothing runs`, async () => {
      const res = await post(route);
      assert.strictEqual(res.status, 401);
      assert.strictEqual(calls(), 0);
    });

    test(`${route}: the permission hook's token is refused, for a conversation and for a routine run`, async () => {
      for (const headers of [h.hookHeaders('convo-reconnect'), h.hookHeaders(null)]) {
        const res = await post(route, headers);
        assert.strictEqual(res.status, 401, `refused with ${Object.keys(headers)[0]}`);
      }
      assert.strictEqual(calls(), 0, 'an agent cannot open a window or spend a turn through this route');
    });

    test(`${route}: the window's key is let in`, async () => {
      const res = await post(route, h.authHeaders());
      assert.strictEqual(res.status, 200, res.text);
      assert.strictEqual(calls(), 1);
    });

    test(`${route}: a browser's session token from the printed link is let in`, async () => {
      const { token } = auth.exchangeCode(auth.codeOf(auth.signInLink(h.port)), h.port);
      const res = await post(route, { [auth.SESSION_HEADER]: token });
      assert.strictEqual(res.status, 200, res.text);
      assert.strictEqual(calls(), 1);
    });
  }
});

describe('what the routes answer', () => {
  test('opening the console answers what the opener said', async () => {
    const res = await post('/api/claude/reconnect', h.authHeaders());
    assert.deepStrictEqual(JSON.parse(res.text), { ok: true });
  });

  test('the check says connected, and the runtime status agrees', async () => {
    delete process.env.STUB_CLAUDE_SIGNED_OUT;
    const res = await post('/api/claude/connection', h.authHeaders());
    assert.deepStrictEqual(JSON.parse(res.text), { connected: true, known: true });
    const status = await runtimeStatus();
    assert.strictEqual(status.claude.authenticated, true);
  });

  test('the check says not connected while Claude Code is still signed out, and the runtime status agrees', async () => {
    process.env.STUB_CLAUDE_SIGNED_OUT = '1';
    try {
      const res = await post('/api/claude/connection', h.authHeaders());
      assert.deepStrictEqual(JSON.parse(res.text), { connected: false, known: true });
      const status = await runtimeStatus();
      assert.strictEqual(status.claude.authenticated, false);
    } finally {
      delete process.env.STUB_CLAUDE_SIGNED_OUT;
    }
  });

  test('a check that fails for another reason says it could not tell, and leaves the runtime status as it was', async () => {
    // Connected first, so a failure that wrongly signed Claude Code out would
    // show as a change.
    delete process.env.STUB_CLAUDE_SIGNED_OUT;
    await post('/api/claude/connection', h.authHeaders());
    assert.strictEqual((await runtimeStatus()).claude.authenticated, true);
    process.env.STUB_CLAUDE_CHECK_FAILS = '1';
    try {
      const res = await post('/api/claude/connection', h.authHeaders());
      assert.deepStrictEqual(JSON.parse(res.text), { connected: false, known: false });
      assert.strictEqual((await runtimeStatus()).claude.authenticated, true, 'a dropped connection is not a sign-out');
    } finally {
      delete process.env.STUB_CLAUDE_CHECK_FAILS;
    }
  });
});

async function runtimeStatus() {
  const client = await h.connect();
  const since = client.messages.length;
  client.send({ type: 'get_runtime_status' });
  const { msg } = await client.waitFor((m) => m.type === 'runtime_status', { since, label: 'runtime_status' });
  client.close();
  return msg;
}
