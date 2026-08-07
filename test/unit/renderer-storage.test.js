// Tests for renderer persistence (electron/renderer-storage.js).
//
// The desktop app loads http://localhost:<port> with an OS-assigned port, so
// the web origin changes every launch and anything the renderer keeps in
// localStorage silently vanishes between sessions. Durable state therefore
// lives in a JSON file under userData, which no port ever touches.
//
// The test that matters here is survival across launches: a value written by
// one load must be read back by a completely fresh load. The server port is
// nowhere in this module's API, which is the point: persistence cannot
// depend on a number that changes every launch.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadRendererStorage, setRendererStorageKey } = require('../../electron/renderer-storage.js');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-storage-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a value survives to the next launch', () => {
  test('written by one load, read by a fresh one', () => {
    setRendererStorageKey(dir, 'rundock-theme', 'light');
    // A fresh load stands in for the next app launch: nothing carried over
    // in memory, only what the file holds.
    const next = loadRendererStorage(dir);
    assert.strictEqual(next['rundock-theme'], 'light');
  });

  test('multiple keys accumulate rather than replace', () => {
    setRendererStorageKey(dir, 'a', '1');
    setRendererStorageKey(dir, 'b', '2');
    assert.deepStrictEqual(loadRendererStorage(dir), { a: '1', b: '2' });
  });

  test('writing a key again overwrites it', () => {
    setRendererStorageKey(dir, 'a', '1');
    setRendererStorageKey(dir, 'a', '2');
    assert.strictEqual(loadRendererStorage(dir).a, '2');
  });

  test('values are stored as strings, mirroring localStorage', () => {
    setRendererStorageKey(dir, 'n', 280);
    assert.strictEqual(loadRendererStorage(dir).n, '280');
  });
});

describe('storage loss never breaks boot', () => {
  test('no file yet means empty storage', () => {
    assert.deepStrictEqual(loadRendererStorage(dir), {});
  });

  test('a corrupt file means empty storage, not a throw', () => {
    fs.writeFileSync(path.join(dir, 'renderer-storage.json'), '{not json');
    assert.deepStrictEqual(loadRendererStorage(dir), {});
  });

  test('a file holding a non-object means empty storage', () => {
    fs.writeFileSync(path.join(dir, 'renderer-storage.json'), '"just a string"');
    assert.deepStrictEqual(loadRendererStorage(dir), {});
  });

  test('non-string stored values are dropped on load', () => {
    fs.writeFileSync(path.join(dir, 'renderer-storage.json'), JSON.stringify({ ok: 'yes', bad: { nested: true } }));
    assert.deepStrictEqual(loadRendererStorage(dir), { ok: 'yes' });
  });

  test('writing into a directory that does not exist yet creates it', () => {
    const deeper = path.join(dir, 'not', 'yet', 'here');
    setRendererStorageKey(deeper, 'k', 'v');
    assert.strictEqual(loadRendererStorage(deeper).k, 'v');
  });
});
