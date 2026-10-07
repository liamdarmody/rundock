'use strict';
// Attack tests: what a browser holds, and what can be done with anything it
// leaves lying around.
//
// The link the terminal prints is opened in a browser, so it ends up in the
// browser's history, and on some systems on a browser's command line. So the
// link never carries the launch key: it carries a one-time code that is good
// for one exchange, for a few minutes, and nothing else. The exchange gives
// the page a session token it keeps for its own address only (scheme, host
// and port) and sends as a header and in the WebSocket handshake, never in a
// cookie, because a browser sends a cookie to every server on localhost
// whatever its port. Images and PDFs, which a page cannot attach a header
// to, are let in by a separate cookie good for those files and nothing else.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');

const h = require('../../helpers/harness.js');
const auth = require('../../../lib/auth/index.js');

let printed = [];
let realLog;
before(async () => {
  realLog = console.log;
  console.log = (...args) => { printed.push(args.join(' ')); realLog(...args); };
  await h.boot();
  fs.writeFileSync(path.join(h.workspaceDir, 'picture.png'), 'png-bytes');
  fs.writeFileSync(path.join(h.workspaceDir, 'note.md'), 'note-body');
});
after(async () => { console.log = realLog; await h.shutdown(); });

function request({ method = 'GET', path: url, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.port, method, path: url, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
function upgrade({ headers = {}, protocols } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}`, protocols, { headers });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); });
    ws.on('error', () => resolve('error'));
  });
}
const codeOf = (link) => (/#c=([A-Za-z0-9_-]+)/.exec(link || '') || [])[1] || null;
const exchange = (code) => request({ method: 'POST', path: '/api/auth/session', headers: code ? { 'X-Rundock-Code': code } : {} });

describe('B1. the printed link carries a one-time code, never the launch key', () => {
  test('the link names a code, and the code is not the key', () => {
    const link = auth.signInLink(h.port);
    assert.match(link, /^http:\/\/localhost:\d+\/#c=[A-Za-z0-9_-]{20,}$/);
    assert.ok(!link.includes(auth.launchKey()), 'the launch key is not in the link');
  });

  test('the launch key is never accepted by the exchange', async () => {
    const res = await request({ method: 'POST', path: '/api/auth/session', headers: { 'X-Rundock-Key': auth.launchKey(), 'X-Rundock-Code': auth.launchKey() } });
    assert.strictEqual(res.status, 401);
  });

  test('a code works once; a second use is refused, and using it prints no new link', async () => {
    const code = codeOf(auth.signInLink(h.port));
    printed = [];
    const first = await exchange(code);
    assert.strictEqual(first.status, 200);
    assert.ok(JSON.parse(first.text).token, 'the page is handed a session token');
    const again = await exchange(code);
    assert.strictEqual(again.status, 401, 'a code from a browser\'s history is dead');
    assert.deepStrictEqual(printed.map(codeOf).filter(Boolean), [], 'the next browser asks the terminal for its own');
  });

  test('a code is good for a few minutes only', async () => {
    const realNow = Date.now;
    const code = codeOf(auth.signInLink(h.port));
    try {
      Date.now = () => realNow() + auth.CODE_TTL_MS + 1000;
      assert.strictEqual((await exchange(code)).status, 401);
    } finally { Date.now = realNow; }
  });

  test('nothing a program sends makes a link appear, even once the last has expired', async () => {
    const realNow = Date.now;
    auth.signInLink(h.port);
    try {
      Date.now = () => realNow() + auth.CODE_TTL_MS + 120000;
      printed = [];
      for (let i = 0; i < 3; i++) await request({ path: '/api/auth/status' });
      await exchange('x'.repeat(43));
      assert.deepStrictEqual(printed.map(codeOf).filter(Boolean), []);
    } finally { Date.now = realNow; }
  });
});

describe('B2. the session token is never a cookie that drives the server', () => {
  let token;
  let mediaCookie;
  before(async () => {
    const res = await exchange(codeOf(auth.signInLink(h.port)));
    token = JSON.parse(res.text).token;
    const set = [].concat(res.headers['set-cookie'] || []);
    mediaCookie = set.map((c) => c.split(';')[0]).find((c) => c.startsWith('rundock_media_'));
  });

  test('the token is sent as a header, or in the WebSocket handshake, and opens everything', async () => {
    assert.strictEqual((await request({ path: '/api/agents', headers: { 'X-Rundock-Session': token } })).status, 200);
    assert.strictEqual(await upgrade({ protocols: ['rundock', `rundock.session.${token}`] }), 'open');
  });

  test('no cookie the exchange sets drives the server: not the socket, not an API route', async () => {
    assert.ok(mediaCookie, 'a cookie for pictures and PDFs is set');
    assert.ok(!mediaCookie.includes(token), 'and it is not the session token');
    assert.strictEqual((await request({ path: '/api/agents', headers: { Cookie: mediaCookie } })).status, 401);
    assert.strictEqual((await request({ path: '/api/file?path=note.md', headers: { Cookie: mediaCookie } })).status, 401);
    assert.notStrictEqual(await upgrade({ headers: { Cookie: mediaCookie } }), 'open');
    assert.notStrictEqual(await upgrade({ headers: { Cookie: `rundock_session_${h.port}=${token}` } }), 'open', 'the token as a cookie is refused too');
  });

  test('the handshake never chooses, so never echoes, the subprotocol carrying the token', async () => {
    const chosen = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}`, ['rundock', `rundock.session.${token}`]);
      ws.on('open', () => { const p = ws.protocol; ws.close(); resolve(p); });
      ws.on('error', () => resolve(null));
    });
    assert.strictEqual(chosen, 'rundock');
  });

  test('a picture let in by the media cookie is served only from where it really is, never through a link out', async () => {
    const os = require('node:os');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-media-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.png'), 'outside-bytes');
    fs.symlinkSync(path.join(outside, 'secret.png'), path.join(h.workspaceDir, 'linked-picture.png'));
    const res = await request({ path: '/workspace-file?path=linked-picture.png', headers: { Cookie: mediaCookie } });
    assert.notStrictEqual(res.status, 200);
    assert.ok(!res.text.includes('outside-bytes'));
    // The window's own read, with the session token, still follows the link.
    const own = await request({ path: '/workspace-file?path=linked-picture.png', headers: { 'X-Rundock-Session': token } });
    assert.strictEqual(own.status, 200);
  });

  test('the media cookie reads pictures and PDFs, and nothing else', async () => {
    const res = await request({ path: '/workspace-file?path=picture.png', headers: { Cookie: mediaCookie } });
    assert.strictEqual(res.status, 200);
  });

  test('a token is good only on the port it was issued for', async () => {
    const elsewhere = auth.authenticate({ headers: { 'x-rundock-session': token, host: `localhost:${h.port + 1}` }, url: '/api/agents', method: 'GET' }, h.port + 1);
    assert.strictEqual(elsewhere, false);
  });

  test('a token expires on the server', async () => {
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + (auth.SESSION_MAX_AGE_S + 60) * 1000;
      assert.strictEqual((await request({ path: '/api/agents', headers: { 'X-Rundock-Session': token } })).status, 401);
    } finally { Date.now = realNow; }
  });
});
