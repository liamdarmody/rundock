'use strict';
// Seam tests for lib/http-router.js. The routes' behaviour is pinned by the
// HTTP integration suite driving the wired module through a booted server;
// these tests pin the SEAMS themselves: unwired root deps refuse loudly,
// the wiring is restorable, ROOT_DIR reaches the real public/ assets from
// lib/ (the packaged-app path base), and file reads resolve the workspace
// at USE time so a switch redirects the very next request.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROUTER_KEY = require.resolve('../../lib/http-router.js');
const REPO_ROOT = path.join(__dirname, '..', '..');

// A private copy per test: wiring one test's fakes must never leak into
// another test (or into the shared instance other requires would see).
function freshRouter() {
  const cached = require.cache[ROUTER_KEY];
  delete require.cache[ROUTER_KEY];
  const mod = require(ROUTER_KEY);
  delete require.cache[ROUTER_KEY];
  if (cached) require.cache[ROUTER_KEY] = cached;
  return mod;
}

function fakeRes() {
  const calls = { writeHead: [], end: [] };
  return {
    calls,
    writeHead(code, headers) { calls.writeHead.push([code, headers]); },
    end(payload) { calls.end.push(payload); },
  };
}

test('unwired root deps throw the named wiring error at first use', () => {
  const router = freshRouter();
  assert.throws(
    () => router.handleHttpRequest({ url: '/api/files', method: 'GET' }, fakeRes()),
    /lib\/http-router: getFileTreeCached not wired \(call wireHttpRouterDeps at boot\)/,
  );
});

test('wireHttpRouterDeps returns the previous set, restorable by identity', () => {
  const router = freshRouter();
  const prev = router.wireHttpRouterDeps({ getFileTreeCached: () => [] });
  assert.strictEqual(typeof prev.getFileTreeCached, 'function');
  router.wireHttpRouterDeps(prev);
  assert.throws(
    () => router.handleHttpRequest({ url: '/api/files', method: 'GET' }, fakeRes()),
    /getFileTreeCached not wired/,
  );
});

test('ROOT_DIR reaches the repo public/ assets from lib/ with no deps involved', () => {
  const router = freshRouter();
  const res = fakeRes();
  router.handleHttpRequest({ url: '/favicon.svg', method: 'GET' }, res);
  assert.strictEqual(res.calls.writeHead[0][0], 200);
  assert.strictEqual(res.calls.writeHead[0][1]['Content-Type'], 'image/svg+xml');
  assert.deepStrictEqual(res.calls.end[0], fs.readFileSync(path.join(REPO_ROOT, 'public', 'favicon.svg')),
    'the bytes are the real public/favicon.svg, one hop up from lib/');
});

test('file reads resolve the workspace at USE time: a switch redirects the next request', () => {
  const router = freshRouter();
  const config = require('../../lib/config.js');
  const original = config.getWorkspace();
  const wsA = fs.mkdtempSync(path.join(os.tmpdir(), 'router-ws-a-'));
  const wsB = fs.mkdtempSync(path.join(os.tmpdir(), 'router-ws-b-'));
  try {
    fs.writeFileSync(path.join(wsA, 'note.md'), 'Body from workspace A.');
    fs.writeFileSync(path.join(wsB, 'note.md'), 'Body from workspace B.');
    router.wireHttpRouterDeps({ isInsideWorkspace: () => true });

    config.setWorkspace(wsA);
    const resA = fakeRes();
    router.handleHttpRequest({ url: '/api/file?path=note.md', method: 'GET' }, resA);
    assert.strictEqual(resA.calls.end[0], 'Body from workspace A.');

    config.setWorkspace(wsB);
    const resB = fakeRes();
    router.handleHttpRequest({ url: '/api/file?path=note.md', method: 'GET' }, resB);
    assert.strictEqual(resB.calls.end[0], 'Body from workspace B.',
      'the read followed the switch with no re-wiring');
  } finally {
    config.setWorkspace(original);
    fs.rmSync(wsA, { recursive: true, force: true });
    fs.rmSync(wsB, { recursive: true, force: true });
  }
});
