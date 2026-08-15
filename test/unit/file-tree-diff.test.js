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

const { buildTree, mulberry32, randomEntries, mutate, sequence } = require('../helpers/tree-fixtures.js');

describe('file tree diff', () => {
  test('an unchanged tree produces no operations at all', () => {
    // This is what lets the skip-if-unchanged guard be deleted: the
    // common case costs nothing without a special case for it.
    const tree = buildTree(randomEntries(mulberry32(1)));
    assert.deepStrictEqual(diffTree(tree, tree), []);
    assert.deepStrictEqual(diffTree(tree, buildTree(randomEntries(mulberry32(1)))), []);
    assert.deepStrictEqual(diffTree([], []), []);
  });

  test('one new file in a large tree costs one operation', () => {
    // The cost is proportional to the change, not to the tree. Stated as an
    // operation count because a timing assertion would be a flake waiting to
    // happen.
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
    // The reason this module is pure. 300 seeds, each applying up to
    // four structural changes, asserting the operation list turns the old tree
    // into the new one byte for byte.
    let totalOps = 0;
    let mutatedRounds = 0;
    let typeReplacements = 0;   // a path that stayed put and changed what it is

    for (let seed = 1; seed <= 300; seed++) {
      // Through the shared entry point, so the browser suite can run these
      // very sequences through the DOM patcher and the two implementations
      // are compared on identical input rather than on similar-looking input.
      const { before, after, changed } = sequence(seed);

      const ops = diffTree(before, after);
      totalOps += ops.length;

      const removed = new Set(ops.filter(o => o.op === 'remove').map(o => o.path));
      typeReplacements += ops.filter(o => o.op === 'insert' && removed.has(o.path)).length;

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

      if (changed) mutatedRounds++;
    }

    // Guard the guard. If the generator produced nothing but no-ops, every
    // assertion above would pass while proving nothing at all.
    assert.ok(mutatedRounds > 250, `only ${mutatedRounds} of 300 rounds changed anything`);
    assert.ok(totalOps > 300, `only ${totalOps} operations across 300 rounds`);
    // The replace-on-type-change branch has to be among what was generated,
    // not merely available to be generated. Without this, dropping that
    // mutation from the shared generator would leave the branch untested and
    // every assertion here would still pass.
    assert.ok(typeReplacements > 5, `type replacements never generated (${typeReplacements})`);
  });
});
