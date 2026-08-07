// Tests for the local update-feed harness (scripts/update-harness/serve.mjs).
//
// The harness is the thing that makes an updater fix verifiable at all, so it
// needs to be trustworthy itself. If it silently 404s a manifest or serves the
// wrong bytes, every conclusion drawn from it is wrong, and the whole point of
// the harness was to stop guessing.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// serve.mjs is ESM; this suite is CommonJS. Dynamic import bridges them.
let serve;
before(async () => {
  serve = await import('../../scripts/update-harness/serve.mjs');
});

describe('resolveInside', () => {
  const root = '/feed';

  test('resolves a plain file inside the feed', () => {
    assert.strictEqual(serve.resolveInside(root, '/latest-mac.yml'), '/feed/latest-mac.yml');
  });

  test('ignores a query string', () => {
    assert.strictEqual(serve.resolveInside(root, '/latest.yml?nocache=1'), '/feed/latest.yml');
  });

  test('decodes percent-encoding, since artefact names carry spaces', () => {
    assert.strictEqual(serve.resolveInside(root, '/Rundock%200.11.5.zip'), '/feed/Rundock 0.11.5.zip');
  });

  test('refuses a traversal escape', () => {
    assert.strictEqual(serve.resolveInside(root, '/../etc/passwd'), null);
  });

  test('refuses an encoded traversal escape', () => {
    assert.strictEqual(serve.resolveInside(root, '/%2e%2e/%2e%2e/etc/passwd'), null);
  });

  test('refuses a sibling directory that merely shares a prefix', () => {
    // /feed-secret starts with /feed as a string but is not inside it. A
    // startsWith check without the separator would wrongly allow this.
    assert.strictEqual(serve.resolveInside('/feed', '/../feed-secret/key'), null);
  });

  test('allows the root itself rather than treating it as an escape', () => {
    // normalize() keeps the trailing slash here, which is fine: the guard only
    // has to decide "inside or outside". Whether a directory is servable is
    // the server's job (it is not: see the 404 test below), not this one's.
    const got = serve.resolveInside(root, '/');
    assert.notStrictEqual(got, null, 'the feed root is inside the feed');
    assert.match(got, /^\/feed\/?$/);
  });
});

describe('createFeedServer', () => {
  let dir;
  let server;
  let base;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-feed-'));
    fs.writeFileSync(path.join(dir, 'latest-mac.yml'), 'version: 0.11.5-test.2\n');
    fs.writeFileSync(path.join(dir, 'Rundock-0.11.5-test.2-mac.zip'), Buffer.alloc(2048, 7));
    server = serve.createFeedServer(dir);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('serves the manifest as yaml, not octet-stream', async () => {
    const res = await fetch(`${base}/latest-mac.yml`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'text/yaml');
    assert.match(await res.text(), /version: 0\.11\.5-test\.2/);
  });

  test('serves an artefact byte-exact with a correct length', async () => {
    const res = await fetch(`${base}/Rundock-0.11.5-test.2-mac.zip`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-length'), '2048');
    const body = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(body.length, 2048);
    assert.ok(body.every((b) => b === 7), 'bytes should survive the round trip unchanged');
  });

  test('advertises range support, which electron-updater uses to resume', async () => {
    const res = await fetch(`${base}/latest-mac.yml`);
    assert.strictEqual(res.headers.get('accept-ranges'), 'bytes');
  });

  test('404s a missing file rather than hanging or 500ing', async () => {
    const res = await fetch(`${base}/nope.yml`);
    assert.strictEqual(res.status, 404);
  });

  test('403s an attempt to escape the feed directory', async () => {
    // fetch() normalises ../ in the URL, so drive the raw request directly to
    // prove the server guard works rather than the client's tidying.
    const raw = await new Promise((resolve) => {
      const http = require('node:http');
      const req = http.request(
        { host: '127.0.0.1', port: server.address().port, path: '/../../etc/passwd' },
        (res) => { res.resume(); resolve(res.statusCode); },
      );
      req.end();
    });
    assert.strictEqual(raw, 403);
  });
});

describe('createFeedServer: a directory is not an artefact', () => {
  let dir, server, base;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-feed-dir-'));
    fs.mkdirSync(path.join(dir, 'nested'));
    server = serve.createFeedServer(dir);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('404s the feed root instead of trying to stream a directory', async () => {
    const res = await fetch(`${base}/`);
    assert.strictEqual(res.status, 404);
  });

  test('404s a subdirectory too', async () => {
    const res = await fetch(`${base}/nested`);
    assert.strictEqual(res.status, 404);
  });
});
