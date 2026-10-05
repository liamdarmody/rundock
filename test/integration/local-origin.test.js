'use strict';
// Integration: only this machine's own pages and processes may talk to the
// server, judged by the Host and Origin headers.
//
// The socket is bound to loopback, but loopback is not the same as "this
// application". Any web page the person has open can send requests to
// 127.0.0.1, and a page whose domain is re-pointed at 127.0.0.1 after it loads
// (DNS rebinding) can also read the answers, because the browser treats the
// response as that page's own. The server tells those apart from its own page
// by two headers a page cannot forge:
//
//   - Host must name a loopback address and the port the server listens on.
//     A rebound page sends its own domain here, so this refuses it outright.
//   - Origin, when present on a request that changes something (any method but
//     GET, HEAD or OPTIONS) and on a WebSocket upgrade, must be one of those
//     same loopback addresses. A cross-site POST carries the foreign site's
//     origin (or `null` from a sandboxed frame) and is refused.
//
// The permission hook is a local process with no Origin at all, so it keeps
// working; the real hook script is spawned against this check by
// test/integration/boundary-permissions.test.js. The desktop app loads
// http://localhost:<port>, which is the first positive case below.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const WebSocket = require('ws');

const h = require('../helpers/harness.js');

let client;

before(async () => {
  await h.boot({ env: { RUNDOCK_PERMISSION_TIMEOUT_MS: '400' } });
  client = await h.connect();
});
after(async () => h.shutdown());

// A raw request with exactly the headers given (Host included): fetch will not
// send a Host of the caller's choosing. Bodies are never inspected beyond
// their length, because the machine route answers with the user's own config.
function request({ method = 'GET', path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.port, method, path, headers, setHost: !('Host' in headers) }, (res) => {
      let size = 0;
      res.on('data', (chunk) => { size += chunk.length; });
      res.on('end', () => resolve({ status: res.statusCode, size }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Open a WebSocket with the given headers; resolve 'open' or the refusal's
// HTTP status.
function upgrade(headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}`, { headers });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); });
    ws.on('error', () => resolve('error'));
  });
}

const loopbackHosts = () => [`localhost:${h.port}`, `127.0.0.1:${h.port}`, `[::1]:${h.port}`];
const appOrigins = () => [`http://localhost:${h.port}`, `http://127.0.0.1:${h.port}`, `http://[::1]:${h.port}`];

function cardBody(conversationId) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' }, conversation_id: conversationId });
}

function pendingFor(conversationId) {
  return [...h.internal.pendingPermissionRequests.values()].filter((p) => p.conversationId === conversationId);
}

describe('a foreign Host is refused', () => {
  test('a rebound page cannot read the machine connectors route', async () => {
    const res = await request({ path: '/api/connectors/machine', headers: { Host: `attacker.example:${h.port}` } });
    assert.strictEqual(res.status, 403);
  });

  test('a foreign Host with no port, or the right name on the wrong port, is refused', async () => {
    for (const Host of ['attacker.example', `localhost:${h.port + 1}`, 'localhost', `127.0.0.1.attacker.example:${h.port}`]) {
      const res = await request({ path: '/api/connectors/machine', headers: { Host } });
      assert.strictEqual(res.status, 403, `Host ${Host}`);
    }
  });

  test('the app page itself is refused to a foreign Host', async () => {
    const res = await request({ path: '/', headers: { Host: `attacker.example:${h.port}` } });
    assert.strictEqual(res.status, 403);
  });

  test('a WebSocket upgrade with a foreign Host is refused, with or without an Origin', async () => {
    assert.notStrictEqual(await upgrade({ Host: `attacker.example:${h.port}` }), 'open');
    assert.notStrictEqual(await upgrade({ Host: `attacker.example:${h.port}`, Origin: `http://attacker.example:${h.port}` }), 'open');
  });
});

describe('a foreign Origin cannot change anything', () => {
  test('a cross-site POST to the permission route raises no card', async () => {
    const res = await request({
      method: 'POST', path: '/api/permission-request',
      headers: { Origin: 'https://attacker.example', 'Content-Type': 'text/plain' },
      body: cardBody('convo-forged'),
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(pendingFor('convo-forged').length, 0, 'no card was filed');
  });

  test('a POST from a sandboxed frame (Origin: null) raises no card', async () => {
    const res = await request({
      method: 'POST', path: '/api/permission-request',
      headers: { Origin: 'null', 'Content-Type': 'text/plain' },
      body: cardBody('convo-null-origin'),
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(pendingFor('convo-null-origin').length, 0, 'no card was filed');
  });

  test('a foreign Origin is refused on the other write route too', async () => {
    const res = await request({
      method: 'POST', path: '/api/review-sidecar',
      headers: { Origin: 'https://attacker.example', 'Content-Type': 'text/plain' },
      body: JSON.stringify({ path: '.rundock/reviews/x.json', content: '{}' }),
    });
    assert.strictEqual(res.status, 403);
  });

  test('a WebSocket upgrade with a foreign or null Origin is refused', async () => {
    assert.notStrictEqual(await upgrade({ Origin: 'https://attacker.example' }), 'open');
    assert.notStrictEqual(await upgrade({ Origin: 'null' }), 'open');
  });
});

describe('the app, the desktop window and the hook keep working', () => {
  test('every loopback Host for this port reads the API', async () => {
    for (const Host of loopbackHosts()) {
      const res = await request({ path: '/api/agents', headers: { Host } });
      assert.strictEqual(res.status, 200, `Host ${Host}`);
    }
    const upper = await request({ path: '/api/agents', headers: { Host: `LOCALHOST:${h.port}` } });
    assert.strictEqual(upper.status, 200, 'host names are case-insensitive');
  });

  test('a POST from the desktop window\'s origin, and from the page on 127.0.0.1, raises the card', async () => {
    const pairs = [[`localhost:${h.port}`, `http://localhost:${h.port}`], [`127.0.0.1:${h.port}`, `http://127.0.0.1:${h.port}`]];
    for (const [Host, Origin] of pairs) {
      const convo = `convo-app-${Host.split(':')[0]}`;
      const since = client.messages.length;
      const pending = request({ method: 'POST', path: '/api/permission-request', headers: { Host, Origin, 'Content-Type': 'application/json' }, body: cardBody(convo) });
      const { msg: card } = await client.waitFor((m) => m.type === 'control_request' && m._conversationId === convo, { since, label: `card via ${Origin}` });
      client.send({ type: 'permission_response', requestId: card.request_id, allow: true, conversationId: convo });
      assert.strictEqual((await pending).status, 200);
    }
  });

  test('the hook\'s request, with no Origin, raises the card', async () => {
    const convo = 'convo-hook-no-origin';
    const since = client.messages.length;
    const pending = request({ method: 'POST', path: '/api/permission-request', headers: { 'Content-Type': 'application/json' }, body: cardBody(convo) });
    const { msg: card } = await client.waitFor((m) => m.type === 'control_request' && m._conversationId === convo, { since, label: 'hook card' });
    client.send({ type: 'permission_response', requestId: card.request_id, allow: false, conversationId: convo });
    assert.strictEqual((await pending).status, 200);
  });

  test('a WebSocket from each app origin, and from a local tool with no Origin, opens', async () => {
    for (const Origin of appOrigins()) {
      assert.strictEqual(await upgrade({ Origin }), 'open', `Origin ${Origin}`);
    }
    assert.strictEqual(await upgrade({ Host: `localhost:${h.port}`, Origin: `http://localhost:${h.port}` }), 'open', 'the desktop window');
    assert.strictEqual(await upgrade({}), 'open', 'no Origin');
  });
});
