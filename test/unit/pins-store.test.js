'use strict';
// Where pins live, and how the protocol reaches them.
//
// PER MACHINE, PER USER, NOT IN THE WORKSPACE. A shared or synced workspace
// does not share one person's pins, so the list lives beside the
// recent-workspaces file in the home directory, keyed by workspace, and the
// store writes nothing under the workspace root. That is the claim the first
// test makes byte for byte: HOME pointed at a temporary directory, a file
// pinned, and the workspace tree identical before and after while the home
// file carries the pin.
//
// THE KEY IS THE REALPATH OF THE WORKSPACE ROOT. The store module's header
// records the rule and its consequences; the moved-path test here asserts the
// outcome that rule dictates: a workspace opened at a new path starts with no
// pins, and the entry for the path that no longer exists is pruned on load,
// as loadRecentWorkspaces prunes.
//
// THE HANDLERS ARE TESTED HERE TOO, against a real temporary workspace and
// the real store, because the wire is the only way a pin is ever written: a
// pin_file whose path resolves outside the workspace is refused with no write.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const store = require(path.join(ROOT, 'lib', 'store', 'pins.js'));
const config = require(path.join(ROOT, 'lib', 'config.js'));
const { buildDispatch } = require(path.join(ROOT, 'lib', 'protocol', 'handlers', 'index.js'));

let home;
let originalHome;
const scratch = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function makeWorkspace(files) {
  const dir = tempDir('pins-ws-');
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

// Every path under a directory with the bytes it holds, so two snapshots can
// be compared for equality rather than for "roughly the same".
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, entry.name);
      const rel = path.relative(dir, full);
      if (entry.isDirectory()) { out[rel + '/'] = null; walk(full); }
      else out[rel] = fs.readFileSync(full).toString('base64');
    }
  };
  walk(dir);
  return out;
}

function pinsOf(ws) { return JSON.parse(fs.readFileSync(path.join(ws, '.rundock', 'pins.json'), 'utf-8')); }

beforeEach(() => {
  originalHome = process.env.HOME;
  home = tempDir('pins-home-');
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = originalHome;
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the store writes inside .rundock/ and nothing else in the workspace', () => {
  test('a pin lands in .rundock/pins.json and no other file in the workspace changes', () => {
    // PN-2 said the store writes nothing under the workspace root at all,
    // because the file lived in the home directory. It lives in the workspace
    // now, so the claim it can still make is the one that matters to a reader:
    // pinning touches `.rundock/`, which is gitignored, and touches nothing
    // they wrote.
    const ws = makeWorkspace({ 'Roadmap.md': '# r', 'notes/backlog.md': '# b' });
    const before = snapshot(ws);
    store.pinFile(ws, 'Roadmap.md');
    const after = snapshot(ws);
    for (const [rel, bytes] of Object.entries(before)) {
      assert.deepStrictEqual(after[rel], bytes, `${rel} changed`);
    }
    const added = Object.keys(after).filter((k) => !(k in before));
    assert.deepStrictEqual(added.sort(), ['.rundock/', path.join('.rundock', 'pins.json')].sort());
    assert.strictEqual(store.pinsFile(ws), path.join(ws, '.rundock', 'pins.json'));
    assert.deepStrictEqual(pinsOf(ws), ['Roadmap.md']);
  });

  test('the list is bare and workspace-relative, with no key wrapping it', () => {
    // The file describes one workspace because it lives inside it, so there is
    // nothing left for a key to disambiguate.
    const ws = makeWorkspace({ 'Roadmap.md': '# r', 'notes/backlog.md': '# b' });
    store.pinFile(ws, 'Roadmap.md');
    store.pinFile(ws, 'notes/backlog.md');
    assert.deepStrictEqual(pinsOf(ws), ['Roadmap.md', 'notes/backlog.md']);
  });

  test('pin order is the order they were pinned, unpin keeps the rest, and pinning twice is a no-op', () => {
    const ws = makeWorkspace({ 'a.md': 'a', 'b.md': 'b', 'c.md': 'c' });
    store.pinFile(ws, 'a.md');
    store.pinFile(ws, 'b.md');
    store.pinFile(ws, 'c.md');
    assert.deepStrictEqual(store.loadPins(ws), ['a.md', 'b.md', 'c.md']);
    assert.deepStrictEqual(store.pinFile(ws, 'a.md'), ['a.md', 'b.md', 'c.md'], 'pinning twice moves nothing');
    assert.deepStrictEqual(store.unpinFile(ws, 'b.md'), ['a.md', 'c.md'], 'the rest keep their order');
  });

  test('a workspace with no pins reads as an empty list, with no file and no throw', () => {
    const ws = makeWorkspace({ 'a.md': 'a' });
    assert.deepStrictEqual(store.loadPins(ws), []);
    assert.strictEqual(fs.existsSync(store.pinsFile(ws)), false, 'a read never creates the file');
  });

  test('a corrupt or hand-edited file reads as empty rather than throwing', () => {
    const ws = makeWorkspace({ 'a.md': 'a' });
    fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
    for (const junk of ['not json', '{"a":1}', 'null', '3']) {
      fs.writeFileSync(store.pinsFile(ws), junk);
      assert.deepStrictEqual(store.loadPins(ws), [], `${junk} should read as empty`);
    }
    fs.writeFileSync(store.pinsFile(ws), JSON.stringify(['a.md', 3, '', 'a.md']));
    assert.deepStrictEqual(store.loadPins(ws), ['a.md'], 'junk entries are dropped, order kept');
  });

  test('unpinning the last pin leaves an empty list rather than deleting the file', () => {
    // An empty file and a missing file read the same to the view, but on disk
    // they are different claims: "you unpinned everything" against "this
    // workspace has never been pinned in". Keeping the file keeps the first.
    const ws = makeWorkspace({ 'a.md': 'a' });
    store.pinFile(ws, 'a.md');
    store.unpinFile(ws, 'a.md');
    assert.strictEqual(fs.existsSync(store.pinsFile(ws)), true);
    assert.deepStrictEqual(pinsOf(ws), []);
  });

  test('two workspaces keep their own lists, because each file lives in its own workspace', () => {
    const a = makeWorkspace({ 'a.md': 'a' });
    const b = makeWorkspace({ 'b.md': 'b' });
    store.pinFile(a, 'a.md');
    assert.deepStrictEqual(store.loadPins(b), [], 'one workspace never sees another\'s pins');
    store.pinFile(b, 'b.md');
    assert.deepStrictEqual(store.loadPins(a), ['a.md']);
    assert.deepStrictEqual(store.loadPins(b), ['b.md']);
  });

  test('a workspace copied to a new path brings its pins with it', () => {
    // THE CASE THE HOME-DIRECTORY STORE COULD NOT SERVE, and the reason this
    // moved. Keyed by the realpath of the root, the same workspace reached at
    // a second path was a different key and started empty, which is what
    // happens to one person opening one synced workspace from two machines.
    const a = makeWorkspace({ 'a.md': 'a' });
    store.pinFile(a, 'a.md');
    const b = tempDir('pins-moved-');
    fs.cpSync(a, b, { recursive: true });
    assert.deepStrictEqual(store.loadPins(b), ['a.md']);
  });
});

describe('the protocol reaches the store', () => {
  function captureWs() {
    const sent = [];
    return { sent, send: (m) => sent.push(JSON.parse(m)), readyState: 1 };
  }
  // The guard the root injects, in the shape the root writes it.
  function realGuard(dir) {
    return (p) => { const root = path.resolve(dir); const r = path.resolve(p); return r === root || r.startsWith(root + path.sep); };
  }

  let originalWorkspace;
  beforeEach(() => { originalWorkspace = config.getWorkspace(); });
  afterEach(() => { config.setWorkspace(originalWorkspace); });

  test('get_pins, pin_file and unpin_file each reply pins with the full list for the current workspace', () => {
    const ws = makeWorkspace({ 'a.md': '', 'notes/b.md': '' });
    config.setWorkspace(ws);
    const table = buildDispatch();
    const ctx = { workspace: { isInsideWorkspace: realGuard(ws) } };

    const w1 = captureWs();
    table.get_pins(ctx, w1, { type: 'get_pins' });
    assert.deepStrictEqual(w1.sent, [{ type: 'pins', pins: [] }]);

    const w2 = captureWs();
    table.pin_file(ctx, w2, { type: 'pin_file', path: 'notes/b.md' });
    table.pin_file(ctx, w2, { type: 'pin_file', path: 'a.md' });
    assert.deepStrictEqual(w2.sent, [
      { type: 'pins', pins: ['notes/b.md'] },
      { type: 'pins', pins: ['notes/b.md', 'a.md'] },
    ]);

    const w3 = captureWs();
    table.unpin_file(ctx, w3, { type: 'unpin_file', path: 'notes/b.md' });
    assert.deepStrictEqual(w3.sent, [{ type: 'pins', pins: ['a.md'] }]);
    assert.deepStrictEqual(store.loadPins(ws), ['a.md'], 'the reply is what the store holds');
  });

  test('a pin_file whose path resolves outside the workspace is refused with no write', () => {
    const ws = makeWorkspace({ 'a.md': '' });
    config.setWorkspace(ws);
    const table = buildDispatch();
    // The injected guard says no, in the shape every other handler test uses.
    const refusing = { workspace: { isInsideWorkspace: () => false } };
    const w1 = captureWs();
    table.pin_file(refusing, w1, { type: 'pin_file', path: 'a.md' });
    assert.deepStrictEqual(w1.sent, [{ type: 'pins', pins: [] }], 'the reply is the list as it was');
    assert.ok(!fs.existsSync(store.pinsFile(ws)), 'a refusal writes nothing, not even an empty file');

    // And the real guard refuses a traversal on its own.
    const w2 = captureWs();
    table.pin_file({ workspace: { isInsideWorkspace: realGuard(ws) } }, w2, { type: 'pin_file', path: '../outside.md' });
    assert.deepStrictEqual(w2.sent, [{ type: 'pins', pins: [] }]);
    assert.ok(!fs.existsSync(store.pinsFile(ws)));
  });

  test('a pin_file for a path that is not a file in the workspace is refused too', () => {
    const ws = makeWorkspace({ 'a.md': '', 'notes/b.md': '' });
    config.setWorkspace(ws);
    const table = buildDispatch();
    const ctx = { workspace: { isInsideWorkspace: realGuard(ws) } };
    const w = captureWs();
    table.pin_file(ctx, w, { type: 'pin_file', path: 'missing.md' });
    table.pin_file(ctx, w, { type: 'pin_file', path: 'notes' });
    table.pin_file(ctx, w, { type: 'pin_file', path: '' });
    assert.deepStrictEqual(w.sent, [
      { type: 'pins', pins: [] }, { type: 'pins', pins: [] }, { type: 'pins', pins: [] },
    ]);
    assert.ok(!fs.existsSync(store.pinsFile(ws)));
  });

  test('with no workspace set, every message answers an empty list and writes nothing', () => {
    config.setWorkspace(null);
    const table = buildDispatch();
    const ctx = { workspace: { isInsideWorkspace: () => true } };
    const w = captureWs();
    table.get_pins(ctx, w, { type: 'get_pins' });
    table.pin_file(ctx, w, { type: 'pin_file', path: 'a.md' });
    table.unpin_file(ctx, w, { type: 'unpin_file', path: 'a.md' });
    assert.deepStrictEqual(w.sent, [{ type: 'pins', pins: [] }, { type: 'pins', pins: [] }, { type: 'pins', pins: [] }]);
    // With no workspace there is no root to write under, so "writes nothing"
    // is now the absence of any .rundock/pins.json anywhere this test made,
    // rather than the absence of one known file in the home directory.
    for (const dir of scratch) {
      assert.ok(!fs.existsSync(path.join(dir, '.rundock', 'pins.json')), `${dir} was written to`);
    }
  });
});
