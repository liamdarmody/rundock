'use strict';
// The notes the editor's [[ suggestions offer, and the target each one is
// inserted with. The target must open the very note that was chosen, under
// the same resolver a click on the link uses, including when two notes share
// a name in different folders. Every name here is made up.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  wikilinkCandidates, wikilinkTargetFor, findFileInTree, wikilinkSearchName,
} = require('../../public/views/files.js');

// A tree in the server's shape, built from a list of file paths.
function treeOf(paths) {
  const root = [];
  for (const p of paths) {
    const parts = p.split('/');
    let list = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const folderPath = parts.slice(0, i + 1).join('/');
      let folder = list.find((x) => x.type === 'folder' && x.path === folderPath);
      if (!folder) { folder = { type: 'folder', name: parts[i], path: folderPath, children: [] }; list.push(folder); }
      list = folder.children;
    }
    list.push({ type: 'file', name: parts[parts.length - 1], path: p });
  }
  return root;
}

// What a click on [[target]] in the note at fromPath opens.
const opens = (tree, target, fromPath) => findFileInTree(tree, wikilinkSearchName(target), fromPath);

describe('the target a chosen note is inserted with', () => {
  const tree = treeOf(['example/alpha/Roadmap.md', 'example/beta/Roadmap.md', 'example/alpha/Plan.md', 'example/beta/Plan.md']);

  test('two notes with the same name each open themselves, chosen from the first folder', () => {
    const from = 'example/alpha/Plan.md';
    const near = wikilinkTargetFor(tree, 'example/alpha/Roadmap.md', from);
    const far = wikilinkTargetFor(tree, 'example/beta/Roadmap.md', from);
    assert.strictEqual(near, 'Roadmap', 'the nearer note keeps the bare name');
    assert.strictEqual(far, 'example/beta/Roadmap');
    assert.strictEqual(opens(tree, near, from), 'example/alpha/Roadmap.md');
    assert.strictEqual(opens(tree, far, from), 'example/beta/Roadmap.md');
  });

  test('two notes with the same name each open themselves, chosen from the second folder', () => {
    const from = 'example/beta/Plan.md';
    const near = wikilinkTargetFor(tree, 'example/beta/Roadmap.md', from);
    const far = wikilinkTargetFor(tree, 'example/alpha/Roadmap.md', from);
    assert.strictEqual(near, 'Roadmap');
    assert.strictEqual(far, 'example/alpha/Roadmap');
    assert.strictEqual(opens(tree, near, from), 'example/beta/Roadmap.md');
    assert.strictEqual(opens(tree, far, from), 'example/alpha/Roadmap.md');
  });

  test('a note whose bare name names another file keeps its .md', () => {
    const t = treeOf(['chart.png', 'chart.png.md']);
    assert.strictEqual(wikilinkTargetFor(t, 'chart.png.md', null), 'chart.png.md');
    assert.strictEqual(opens(t, 'chart.png.md', null), 'chart.png.md');
  });

  test('every candidate target opens its own note', () => {
    const t = treeOf(['Roadmap.md', 'example/alpha/Roadmap.md', 'example/beta/Roadmap.md', 'example/Notes.MD', 'Idea (draft).md']);
    for (const from of [null, 'example/alpha/Plan.md', 'example/beta/x/Plan.md']) {
      const list = wikilinkCandidates(t, from);
      assert.ok(list.length >= 4, `only ${list.length} offered from ${from}`);
      for (const c of list) assert.strictEqual(opens(t, c.target, from), c.path, `${c.target} from ${from}`);
    }
  });

  test('a note no link from here can reach is left out rather than offered with a target that opens another', () => {
    // A root-level note has no folder to qualify it with, so from a folder
    // holding a note of the same name every spelling resolves to the nearer one.
    const t = treeOf(['Roadmap.md', 'example/alpha/Roadmap.md']);
    assert.strictEqual(wikilinkTargetFor(t, 'Roadmap.md', 'example/alpha/Plan.md'), null);
    assert.deepStrictEqual(wikilinkCandidates(t, 'example/alpha/Plan.md').map((c) => c.path), ['example/alpha/Roadmap.md']);
    assert.strictEqual(wikilinkCandidates(t, null).length, 2);
  });
});

describe('which notes are offered', () => {
  test('notes only, named without their extension, with their path', () => {
    const t = treeOf(['example/Roadmap.md', 'example/chart.png', 'example/data.json', 'example/Notes.MD']);
    assert.deepStrictEqual(wikilinkCandidates(t, null), [
      { path: 'example/Roadmap.md', name: 'Roadmap', target: 'Roadmap' },
      { path: 'example/Notes.MD', name: 'Notes', target: 'Notes' },
    ]);
  });

  test('nothing the Files tree hides is offered', () => {
    const t = treeOf(['.hidden/Secret.md', 'example/.Draft.md', 'node_modules/pkg/README.md', 'example/Roadmap.md']);
    assert.deepStrictEqual(wikilinkCandidates(t, null).map((c) => c.path), ['example/Roadmap.md']);
  });

  test('a name a link cannot carry intact is never offered', () => {
    const unusable = ['a]]b.md', 'a[b.md', 'a|b.md', 'a#b.md', 'a^b.md', 'a\nb.md', 'a\u0007b.md', ' Lead.md'];
    const t = treeOf([...unusable, 'Roadmap.md']);
    assert.deepStrictEqual(wikilinkCandidates(t, null).map((c) => c.path), ['Roadmap.md']);
  });

  test('a name ending in a space is offered with its .md kept, the one spelling a link does not trim', () => {
    const t = treeOf(['Trail .md']);
    assert.deepStrictEqual(wikilinkCandidates(t, null), [{ path: 'Trail .md', name: 'Trail ', target: 'Trail .md' }]);
    assert.strictEqual(opens(t, 'Trail .md', null), 'Trail .md');
  });

  test('a name with markup in it is offered as plain text', () => {
    const t = treeOf(['example/<img src=x onerror=alert(1)>.md']);
    assert.deepStrictEqual(wikilinkCandidates(t, null), [{
      path: 'example/<img src=x onerror=alert(1)>.md', name: '<img src=x onerror=alert(1)>', target: '<img src=x onerror=alert(1)>',
    }]);
  });

  test('no tree, or a malformed one, offers nothing and throws nothing', () => {
    assert.deepStrictEqual(wikilinkCandidates(null, null), []);
    assert.deepStrictEqual(wikilinkCandidates(undefined, 'x.md'), []);
    assert.deepStrictEqual(wikilinkCandidates([null, { type: 'folder', name: 'a', path: 'a' }, { type: 'file' }], null), []);
  });
});
