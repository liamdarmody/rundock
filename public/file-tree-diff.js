'use strict';
// File tree diff: two tree snapshots in, an ordered list of operations out.
//
// The sidebar used to rebuild its entire DOM on every push from the server.
// This is the pure half of replacing that: no DOM, no globals, so it runs in
// Node under the unit suite. The DOM patcher is the only part that needs a
// browser, and its whole job is to execute the list this produces.
//
// NODE SHAPE, as the server sends it:
//   folder: { type: 'folder', name, path, children: [] }
//   file:   { type: 'file',   name, path, kind }
//
// ORDERING. The server sorts every level the same way: folders before files,
// then by name. That order is total and derived only from the data, so two
// snapshots agree on the relative order of any nodes they share. Surviving
// nodes therefore never need to be reordered among themselves, and the diff
// needs no move operation within a container.
//
// OPERATION SEMANTICS, per container, applied in the order given:
//   remove  drop the node at `path`
//   insert  place `node` at `index`
//   update  a file's `kind` changed, which is only its icon
// Removals for a container are emitted before its insertions, and insertions
// in ascending `index`. That ordering is what makes `index` mean "the index in
// the finished list": once the removals are done, the container holds exactly
// the surviving nodes in their final relative order, so inserting each new
// node at its final index in ascending order puts every one in the right
// place. Read `applyOps` below for the executable version of this paragraph.
//
// A folder arrives from `insert` with its children attached, so creating a
// populated folder is one operation rather than one per descendant. That is
// what keeps the cost proportional to the change rather than to the tree.
//
// RENAMES ARE NOT DETECTED, DELIBERATELY. A rename reaches this function as a
// removal and an insertion, because the server sends no identity for a node
// beyond its path, and a path IS its name. Nothing here can tell "renamed a.md
// to b.md" apart from "deleted a.md and created b.md": both are one node out
// and one node in. Guessing would mean carrying a row's selection onto what
// might be a different file, and the selected row is the one the user has open
// in the editor. A renamed row is therefore replaced rather than relabelled,
// which costs it its selection and costs a renamed folder its expanded state.
// Both are already lost today, when the whole tree is destroyed on every push,
// so this is not a regression; it is a known limit with a cheap fix available
// later if the server ever sends a stable id.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockFileTreeDiff = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  function indexByPath(nodes) {
    const m = new Map();
    for (const n of nodes || []) m.set(n.path, n);
    return m;
  }

  // A path can change what it IS: delete a file called `notes` and create a
  // folder with that name, and the path is unchanged while everything else
  // about it is different. Treated as a replacement, never as an update.
  function replaces(prev, next) {
    return prev.type !== next.type;
  }

  function diffContainer(parent, oldNodes, newNodes, ops) {
    const oldByPath = indexByPath(oldNodes);
    const newByPath = indexByPath(newNodes);

    for (const prev of oldNodes || []) {
      const next = newByPath.get(prev.path);
      if (!next || replaces(prev, next)) ops.push({ op: 'remove', parent, path: prev.path });
    }

    // Descendants are walked only after this whole container is settled, so
    // the operation list stays grouped by container and every index above is
    // read against a list nothing deeper has touched yet.
    const descend = [];
    (newNodes || []).forEach((next, index) => {
      const prev = oldByPath.get(next.path);
      if (!prev || replaces(prev, next)) {
        ops.push({ op: 'insert', parent, path: next.path, index, node: next });
        return;
      }
      if (next.type === 'file' && prev.kind !== next.kind) {
        ops.push({ op: 'update', parent, path: next.path, kind: next.kind });
      }
      if (next.type === 'folder') descend.push([next.path, prev.children, next.children]);
    });

    for (const [path, prevChildren, nextChildren] of descend) {
      diffContainer(path, prevChildren, nextChildren, ops);
    }
  }

  /** Ordered operations turning `oldNodes` into `newNodes`. Empty when equal. */
  function diffTree(oldNodes, newNodes) {
    const ops = [];
    diffContainer('', oldNodes || [], newNodes || [], ops);
    return ops;
  }

  function clone(nodes) {
    return (nodes || []).map(n => (
      n.type === 'folder' ? Object.assign({}, n, { children: clone(n.children) }) : Object.assign({}, n)
    ));
  }

  function containerFor(rootNodes, parentPath) {
    if (!parentPath) return rootNodes;
    const stack = rootNodes.slice();
    while (stack.length) {
      const n = stack.pop();
      if (n.type !== 'folder') continue;
      if (n.path === parentPath) return n.children;
      for (const c of n.children) stack.push(c);
    }
    return null;
  }

  /**
   * Apply operations to tree data, returning a new tree. This is the reference
   * implementation of the semantics the DOM patcher has to match, and it is
   * what lets the unit suite prove a list is sufficient to turn one tree into
   * another without a browser in sight.
   *
   * It throws rather than skipping when an operation does not fit the tree it
   * is given. A patcher that silently ignored a bad operation would leave the
   * sidebar disagreeing with the disk, which is the failure this whole change
   * exists to prevent.
   */
  function applyOps(nodes, ops) {
    const out = clone(nodes);
    for (const op of ops) {
      const list = containerFor(out, op.parent);
      if (!list) throw new Error(`no container "${op.parent}" for ${op.op} ${op.path}`);
      if (op.op === 'remove') {
        const i = list.findIndex(n => n.path === op.path);
        if (i === -1) throw new Error(`remove: ${op.path} is not in "${op.parent}"`);
        list.splice(i, 1);
      } else if (op.op === 'insert') {
        if (op.index < 0 || op.index > list.length) {
          throw new Error(`insert: index ${op.index} out of range in "${op.parent}"`);
        }
        list.splice(op.index, 0, clone([op.node])[0]);
      } else if (op.op === 'update') {
        const n = list.find(x => x.path === op.path);
        if (!n) throw new Error(`update: ${op.path} is not in "${op.parent}"`);
        n.kind = op.kind;
      } else {
        throw new Error(`unknown operation "${op.op}"`);
      }
    }
    return out;
  }

  return { diffTree, applyOps };
}));
