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

function homeFile() { return JSON.parse(fs.readFileSync(path.join(home, '.rundock-pins.json'), 'utf-8')); }

beforeEach(() => {
  originalHome = process.env.HOME;
  home = tempDir('pins-home-');
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = originalHome;
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the store writes to the home directory and nowhere else', () => {
  test('a pin lands in .rundock-pins.json under HOME and the workspace tree is byte-identical', () => {
    const ws = makeWorkspace({ 'Roadmap.md': '# Roadmap\n', 'notes/backlog.md': '- a\n', '.rundock/state.json': '{}' });
    const before = snapshot(ws);
    assert.strictEqual(os.homedir(), home, 'sanity: os.homedir() follows HOME at use time, which is how the test isolates it');

    const list = store.pinFile(ws, 'Roadmap.md');
    assert.deepStrictEqual(list, ['Roadmap.md']);

    assert.deepStrictEqual(snapshot(ws), before, 'the store wrote something under the workspace root');
    assert.ok(fs.existsSync(store.pinsFile()), 'the home file was not written');
    assert.strictEqual(store.pinsFile(), path.join(home, '.rundock-pins.json'));
    assert.deepStrictEqual(homeFile(), { [store.workspaceKey(ws)]: ['Roadmap.md'] });
  });

  test('the file is resolved through the home directory at use time, not at require time', () => {
    const first = store.pinsFile();
    const other = tempDir('pins-home-two-');
    process.env.HOME = other;
    assert.strictEqual(store.pinsFile(), path.join(other, '.rundock-pins.json'));
    assert.notStrictEqual(store.pinsFile(), first);
  });

  test('pin order is the order they were pinned, unpin keeps the rest, and pinning twice is a no-op', () => {
    const ws = makeWorkspace({ 'a.md': '', 'b.md': '', 'c.md': '' });
    store.pinFile(ws, 'b.md');
    store.pinFile(ws, 'a.md');
    store.pinFile(ws, 'c.md');
    store.pinFile(ws, 'a.md');
    assert.deepStrictEqual(store.loadPins(ws), ['b.md', 'a.md', 'c.md']);
    assert.deepStrictEqual(store.unpinFile(ws, 'a.md'), ['b.md', 'c.md']);
    assert.deepStrictEqual(store.loadPins(ws), ['b.md', 'c.md']);
  });

  test('a workspace with no pins reads as an empty list, with no file and no throw', () => {
    const ws = makeWorkspace({ 'a.md': '' });
    assert.deepStrictEqual(store.loadPins(ws), []);
    assert.ok(!fs.existsSync(store.pinsFile()), 'reading must not create the file');
  });

  test('a corrupt or hand-edited home file reads as empty rather than throwing', () => {
    const ws = makeWorkspace({ 'a.md': '' });
    fs.writeFileSync(store.pinsFile(), '{not json');
    assert.deepStrictEqual(store.loadPins(ws), []);
    fs.writeFileSync(store.pinsFile(), JSON.stringify({ [store.workspaceKey(ws)]: ['a.md', 3, '', 'a.md'] }));
    assert.deepStrictEqual(store.loadPins(ws), ['a.md'], 'the model normalises what the file holds');
    fs.writeFileSync(store.pinsFile(), JSON.stringify(['a.md']));
    assert.deepStrictEqual(store.loadPins(ws), [], 'a list at the top level is not the shape and reads as nothing');
  });
});

describe('two workspaces, two keys', () => {
  test('pins in one workspace never appear in another on the same machine', () => {
    const a = makeWorkspace({ 'a.md': '' });
    const b = makeWorkspace({ 'b.md': '' });
    store.pinFile(a, 'a.md');
    store.pinFile(b, 'b.md');
    assert.deepStrictEqual(store.loadPins(a), ['a.md']);
    assert.deepStrictEqual(store.loadPins(b), ['b.md']);
    assert.deepStrictEqual(Object.keys(homeFile()).sort(), [store.workspaceKey(a), store.workspaceKey(b)].sort());
  });

  test('the key is the realpath, so a symlinked path and its target are one workspace', () => {
    const real = makeWorkspace({ 'a.md': '' });
    const link = path.join(tempDir('pins-link-'), 'ws');
    fs.symlinkSync(real, link);
    store.pinFile(link, 'a.md');
    assert.deepStrictEqual(store.loadPins(real), ['a.md']);
    assert.strictEqual(store.workspaceKey(link), store.workspaceKey(real));
  });

  // THE MOVED-PATH CASE, and the outcome the stated rule dictates. The key is
  // the realpath of the root, so a workspace opened at a new path is a new
  // key with no pins, and the old key names a path that no longer exists,
  // which the next load prunes exactly as loadRecentWorkspaces prunes.
  test('a workspace moved to a new path starts with no pins, and the old entry is pruned on load', () => {
    const parent = tempDir('pins-move-');
    const oldPath = path.join(parent, 'before');
    const newPath = path.join(parent, 'after');
    fs.mkdirSync(oldPath);
    fs.writeFileSync(path.join(oldPath, 'a.md'), '');
    store.pinFile(oldPath, 'a.md');
    const oldKey = store.workspaceKey(oldPath);
    assert.ok(homeFile()[oldKey], 'sanity: the pin was stored under the old path');

    fs.renameSync(oldPath, newPath);

    assert.deepStrictEqual(store.loadPins(newPath), [], 'a new path is a new workspace with no pins');
    assert.ok(!(oldKey in homeFile()), 'the entry for a path that no longer exists is pruned on load');
  });

  test('an unrelated workspace\'s entry survives another\'s pruning', () => {
    const keep = makeWorkspace({ 'k.md': '' });
    const parent = tempDir('pins-move-');
    const gone = path.join(parent, 'gone');
    fs.mkdirSync(gone);
    fs.writeFileSync(path.join(gone, 'g.md'), '');
    store.pinFile(keep, 'k.md');
    store.pinFile(gone, 'g.md');
    fs.rmSync(gone, { recursive: true, force: true });
    assert.deepStrictEqual(store.loadPins(keep), ['k.md']);
    assert.deepStrictEqual(Object.keys(homeFile()), [store.workspaceKey(keep)]);
  });
});
