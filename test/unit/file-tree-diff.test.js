'use strict';
// The file tree diff, proved by construction rather than by example.
//
// Hand-picked cases test the cases someone thought of. The property test below
// generates trees and mutates them, then asserts the operation list actually
// turns one into the other. It is the only honest way to claim "no stale node,
// no duplicate, no wrong ordering" across arbitrary sequences, because the
// interesting failures are orderings nobody would think to write down.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { diffTree, applyOps } = require('../../public/file-tree-diff.js');

// ── A filesystem model, and the server's tree built from it ────────────────
// Entries are flat: { path, isDir, kind }. Mutations are easy to express on a
// flat list and impossible to express wrongly, and the tree is derived with
// the same sort rule the server uses, so a generated tree is always a shape
// the server could really have sent.
const cmp = (a, b) => (
  a.isDir && !b.isDir ? -1
    : !a.isDir && b.isDir ? 1
      : a.name.localeCompare(b.name)
);

function buildTree(entries) {
  // An entry whose parent folder is missing would simply never be visited,
  // so the tree would come out short and every assertion downstream would be
  // measuring the wrong tree while passing. Refuse instead.
  const dirs = new Set(['', ...entries.filter(e => e.isDir).map(e => e.path)]);
  for (const e of entries) {
    const i = e.path.lastIndexOf('/');
    const parent = i === -1 ? '' : e.path.slice(0, i);
    if (!dirs.has(parent)) throw new Error(`no folder "${parent}" to hold "${e.path}"`);
  }

  const byParent = new Map();
  for (const e of entries) {
    const i = e.path.lastIndexOf('/');
    const parent = i === -1 ? '' : e.path.slice(0, i);
    const name = i === -1 ? e.path : e.path.slice(i + 1);
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push({ ...e, name });
  }
  const build = (parent) => (byParent.get(parent) || []).slice().sort(cmp).map(k => (
    k.isDir
      ? { type: 'folder', name: k.name, path: k.path, children: build(k.path) }
      : { type: 'file', name: k.name, path: k.path, kind: k.kind }
  ));
  return build('');
}

// Seeded, so a failure reproduces exactly instead of vanishing on the rerun.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS = ['note', 'board', 'image'];

function randomEntries(rnd, { dirs = 6, files = 14 } = {}) {
  const entries = [];
  const dirPaths = [''];
  for (let i = 0; i < dirs; i++) {
    const parent = dirPaths[Math.floor(rnd() * dirPaths.length)];
    const name = 'd' + i;
    const p = parent ? `${parent}/${name}` : name;
    entries.push({ path: p, isDir: true });
    dirPaths.push(p);
  }
  for (let i = 0; i < files; i++) {
    const parent = dirPaths[Math.floor(rnd() * dirPaths.length)];
    const name = 'f' + i + '.md';
    entries.push({
      path: parent ? `${parent}/${name}` : name,
      isDir: false,
      kind: KINDS[Math.floor(rnd() * KINDS.length)],
    });
  }
  return entries;
}

const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
const dirsOf = (entries) => ['', ...entries.filter(e => e.isDir).map(e => e.path)];
const under = (path, prefix) => path === prefix || path.startsWith(prefix + '/');

/** One random structural change, returning a new flat entry list. */
function mutate(rnd, entries, seq) {
  const files = entries.filter(e => !e.isDir);
  const choice = Math.floor(rnd() * 6);

  if (choice === 0) {                                    // create a file
    const parent = pick(rnd, dirsOf(entries));
    const name = `new${seq}.md`;
    return entries.concat([{
      path: parent ? `${parent}/${name}` : name, isDir: false, kind: pick(rnd, KINDS),
    }]);
  }
  if (choice === 1) {                                    // create a folder
    const parent = pick(rnd, dirsOf(entries));
    const name = `nd${seq}`;
    return entries.concat([{ path: parent ? `${parent}/${name}` : name, isDir: true }]);
  }
  if (choice === 2 && entries.length) {                  // delete, with descendants
    const victim = pick(rnd, entries);
    return entries.filter(e => !under(e.path, victim.path));
  }
  if (choice === 3 && entries.length) {                  // rename, rewriting descendants
    const victim = pick(rnd, entries);
    const i = victim.path.lastIndexOf('/');
    const parent = i === -1 ? '' : victim.path.slice(0, i);
    const renamed = parent ? `${parent}/r${seq}` : `r${seq}`;
    return entries.map(e => (
      under(e.path, victim.path)
        ? { ...e, path: renamed + e.path.slice(victim.path.length) }
        : e
    ));
  }
  if (choice === 4 && files.length) {                    // move a file
    const victim = pick(rnd, files);
    const name = victim.path.split('/').pop();
    const target = pick(rnd, dirsOf(entries).filter(d => !under(victim.path, d) || d === ''));
    const moved = target ? `${target}/${name}` : name;
    if (entries.some(e => e.path === moved)) return entries;
    return entries.map(e => (e === victim ? { ...e, path: moved } : e));
  }
  if (files.length) {                                    // a note becomes a board
    const victim = pick(rnd, files);
    return entries.map(e => (
      e === victim ? { ...e, kind: KINDS[(KINDS.indexOf(e.kind) + 1) % KINDS.length] } : e
    ));
  }
  return entries;
}

describe('file tree diff', () => {
  test('an unchanged tree produces no operations at all', () => {
    // AC-6. This is what lets the skip-if-unchanged guard be deleted: the
    // common case costs nothing without a special case for it.
    const tree = buildTree(randomEntries(mulberry32(1)));
    assert.deepStrictEqual(diffTree(tree, tree), []);
    assert.deepStrictEqual(diffTree(tree, buildTree(randomEntries(mulberry32(1)))), []);
    assert.deepStrictEqual(diffTree([], []), []);
  });

  test('one new file in a large tree costs one operation', () => {
    // AC-8: proportional to the change, not the tree. Stated as an operation
    // count because a timing assertion would be a flake waiting to happen.
    const entries = randomEntries(mulberry32(7), { dirs: 40, files: 400 });
    const before = buildTree(entries);
    const home = entries.find(e => e.isDir).path;   // a real folder, wherever it landed
    const after = buildTree(entries.concat([{ path: `${home}/brand-new.md`, isDir: false, kind: 'note' }]));

    const ops = diffTree(before, after);
    assert.strictEqual(ops.length, 1);
    assert.strictEqual(ops[0].op, 'insert');
    assert.strictEqual(ops[0].parent, home);
    assert.deepStrictEqual(applyOps(before, ops), after);
  });

  test('a populated new folder arrives as a single insert', () => {
    const before = buildTree([{ path: 'keep.md', isDir: false, kind: 'note' }]);
    const after = buildTree([
      { path: 'keep.md', isDir: false, kind: 'note' },
      { path: 'fresh', isDir: true },
      { path: 'fresh/a.md', isDir: false, kind: 'note' },
      { path: 'fresh/b.md', isDir: false, kind: 'board' },
    ]);

    const ops = diffTree(before, after);
    assert.strictEqual(ops.length, 1);
    assert.strictEqual(ops[0].node.children.length, 2);
    assert.deepStrictEqual(applyOps(before, ops), after);
  });

  test('a file changing kind is an update, not a replacement', () => {
    // The node must survive, because a note becoming a board is only an icon.
    const before = buildTree([{ path: 'a/n.md', isDir: false, kind: 'note' }, { path: 'a', isDir: true }]);
    const after = buildTree([{ path: 'a/n.md', isDir: false, kind: 'board' }, { path: 'a', isDir: true }]);

    assert.deepStrictEqual(diffTree(before, after), [
      { op: 'update', parent: 'a', path: 'a/n.md', kind: 'board' },
    ]);
  });

  test('a path that changes type is replaced rather than updated', () => {
    const before = buildTree([{ path: 'notes', isDir: false, kind: 'note' }]);
    const after = buildTree([{ path: 'notes', isDir: true }]);

    const ops = diffTree(before, after);
    assert.deepStrictEqual(ops.map(o => o.op), ['remove', 'insert']);
    assert.deepStrictEqual(applyOps(before, ops), after);
  });

  test('insertions land in the right place among survivors', () => {
    const keep = [{ path: 'b.md', isDir: false, kind: 'note' }, { path: 'd.md', isDir: false, kind: 'note' }];
    const before = buildTree(keep);
    const after = buildTree(keep.concat([
      { path: 'a.md', isDir: false, kind: 'note' },
      { path: 'c.md', isDir: false, kind: 'note' },
      { path: 'e.md', isDir: false, kind: 'note' },
    ]));

    const ops = diffTree(before, after);
    assert.deepStrictEqual(ops.map(o => o.index), [0, 2, 4]);
    assert.deepStrictEqual(applyOps(before, ops), after);
  });

  test('folders stay before files when both are inserted at once', () => {
    const before = buildTree([{ path: 'z.md', isDir: false, kind: 'note' }]);
    const after = buildTree([
      { path: 'z.md', isDir: false, kind: 'note' },
      { path: 'a.md', isDir: false, kind: 'note' },
      { path: 'folder', isDir: true },
    ]);
    assert.deepStrictEqual(applyOps(before, diffTree(before, after)), after);
  });

  test('applying a list to the wrong tree throws rather than drifting', () => {
    // A patcher that shrugged off an impossible operation would leave the
    // sidebar disagreeing with the disk, silently.
    const t = buildTree([{ path: 'a.md', isDir: false, kind: 'note' }]);
    assert.throws(() => applyOps(t, [{ op: 'remove', parent: '', path: 'ghost.md' }]), /not in/);
    assert.throws(() => applyOps(t, [{ op: 'update', parent: '', path: 'ghost.md', kind: 'note' }]), /not in/);
    assert.throws(() => applyOps(t, [{ op: 'insert', parent: 'nope', path: 'x', index: 0, node: {} }]), /no container/);
    assert.throws(() => applyOps(t, [{ op: 'wat', parent: '', path: 'a.md' }]), /unknown operation/);
    // An index past the end means the ordering contract was broken upstream.
    // Asserted because a guard nothing ever fires is indistinguishable from a
    // guard that cannot fire.
    assert.throws(() => applyOps(t, [{ op: 'insert', parent: '', path: 'x', index: 9, node: {} }]), /out of range/);
    assert.throws(() => applyOps(t, [{ op: 'insert', parent: '', path: 'x', index: -1, node: {} }]), /out of range/);
  });

  test('generated sequences of changes always reconcile exactly', () => {
    // AC-2, and the reason this module is pure. 300 seeds, each applying up to
    // four structural changes, asserting the operation list turns the old tree
    // into the new one byte for byte.
    let totalOps = 0;
    let mutatedRounds = 0;

    for (let seed = 1; seed <= 300; seed++) {
      const rnd = mulberry32(seed);
      let entries = randomEntries(rnd);
      const before = buildTree(entries);

      const changes = 1 + Math.floor(rnd() * 4);
      for (let c = 0; c < changes; c++) entries = mutate(rnd, entries, `${seed}_${c}`);
      const after = buildTree(entries);

      const ops = diffTree(before, after);
      totalOps += ops.length;

      let applied;
      try {
        applied = applyOps(before, ops);
      } catch (e) {
        assert.fail(`seed ${seed}: ${e.message}`);
      }
      assert.deepStrictEqual(applied, after, `seed ${seed} did not reconcile`);

      // Round-tripping back is the same problem in reverse, and it catches
      // asymmetries that only show up when a change is undone.
      assert.deepStrictEqual(applyOps(after, diffTree(after, before)), before, `seed ${seed} reverse`);

      if (JSON.stringify(before) !== JSON.stringify(after)) mutatedRounds++;
    }

    // Guard the guard. If the generator produced nothing but no-ops, every
    // assertion above would pass while proving nothing at all.
    assert.ok(mutatedRounds > 250, `only ${mutatedRounds} of 300 rounds changed anything`);
    assert.ok(totalOps > 300, `only ${totalOps} operations across 300 rounds`);
  });
});
