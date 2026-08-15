'use strict';
// Generated file trees and structural mutations, shared by the two suites that
// test reconciliation.
//
// There are two implementations of the same operation semantics: the pure
// reference in public/file-tree-diff.js, and the DOM patcher in
// public/views/files.js that actually moves what the user sees. Testing them
// against sequences generated separately would prove each one self-consistent
// and say nothing about whether they agree. They share this generator so the
// browser suite can run the very sequences the unit suite runs, and the two
// can be compared on identical input.
//
// Trees are derived from a flat entry list: { path, isDir, kind }. Mutations
// are easy to express on a flat list and hard to express wrongly, and the tree
// is built with the same sort rule the server uses, so every generated tree is
// a shape the server could really have sent.

const KINDS = ['note', 'board', 'image'];

const cmp = (a, b) => (
  a.isDir && !b.isDir ? -1
    : !a.isDir && b.isDir ? 1
      : a.name.localeCompare(b.name)
);

function buildTree(entries) {
  // An entry whose parent folder is missing would never be visited, so the
  // tree would come out short and every assertion downstream would be
  // measuring the wrong tree while passing. Refuse instead.
  const dirs = new Set(['', ...entries.filter(e => e.isDir).map(e => e.path)]);
  for (const e of entries) {
    const i = e.path.lastIndexOf('/');
    if (!dirs.has(i === -1 ? '' : e.path.slice(0, i))) {
      throw new Error(`no folder to hold "${e.path}"`);
    }
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

/** Seeded, so a failure reproduces exactly instead of vanishing on the rerun. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomEntries(rnd, { dirs = 6, files = 14 } = {}) {
  const entries = [];
  const dirPaths = [''];
  for (let i = 0; i < dirs; i++) {
    const parent = dirPaths[Math.floor(rnd() * dirPaths.length)];
    const p = parent ? `${parent}/d${i}` : `d${i}`;
    entries.push({ path: p, isDir: true });
    dirPaths.push(p);
  }
  for (let i = 0; i < files; i++) {
    const parent = dirPaths[Math.floor(rnd() * dirPaths.length)];
    const name = `f${i}.md`;
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
const under = (p, prefix) => p === prefix || p.startsWith(prefix + '/');

/** One random structural change, returning a new flat entry list. */
function mutate(rnd, entries, seq) {
  const files = entries.filter(e => !e.isDir);
  const choice = Math.floor(rnd() * 7);

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
      under(e.path, victim.path) ? { ...e, path: renamed + e.path.slice(victim.path.length) } : e
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
  if (choice === 5 && entries.length) {
    // A path stays put and becomes a different KIND of thing: delete a note
    // called `archive` and make a folder with that name. The reconciler has a
    // branch for exactly this, replacing rather than updating, and without
    // this mutation no generated sequence ever reached it. It was covered by
    // one hand-written case that never touched the real renderer.
    const victim = pick(rnd, entries);
    if (victim.isDir) {
      // Becoming a file takes everything underneath it.
      return entries.filter(e => !under(e.path, victim.path))
        .concat([{ path: victim.path, isDir: false, kind: pick(rnd, KINDS) }]);
    }
    return entries.map(e => (e === victim ? { path: e.path, isDir: true } : e));
  }
  if (files.length) {                                    // a note becomes a board
    const victim = pick(rnd, files);
    return entries.map(e => (
      e === victim ? { ...e, kind: KINDS[(KINDS.indexOf(e.kind) + 1) % KINDS.length] } : e
    ));
  }
  return entries;
}

/**
 * A before and after tree for one seed, plus whether anything actually moved.
 * Both suites call this so they exercise identical sequences.
 */
function sequence(seed, changes) {
  const rnd = mulberry32(seed);
  let entries = randomEntries(rnd);
  const before = buildTree(entries);
  const n = changes || (1 + Math.floor(rnd() * 4));
  for (let c = 0; c < n; c++) entries = mutate(rnd, entries, `${seed}_${c}`);
  const after = buildTree(entries);
  return { before, after, changed: JSON.stringify(before) !== JSON.stringify(after) };
}

module.exports = { KINDS, buildTree, mulberry32, randomEntries, mutate, sequence };
