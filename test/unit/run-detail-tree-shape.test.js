'use strict';
// The run screen's link check, against the tree the server really builds.
//
// WHY A SEPARATE FILE. The matcher (treePathFor in public/run-detail-model.js)
// is tested against a hand-written tree, and it links a name only for a node
// with type 'file' and the exact root-relative path, recursing only through
// nodes with type 'folder' and a children array. Those words and that path
// form are the server's, so this test builds a workspace on disk, asks the
// server's own walk for its tree, and holds the matcher to it. It loads the
// server, which the model's own tests do not need to.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { _internal } = require('../../server.js');
const model = require('../../public/run-detail-model.js');

function nodesOf(tree) {
  return tree.flatMap(node => [node, ...(Array.isArray(node.children) ? nodesOf(node.children) : [])]);
}

test('the server\'s tree is the shape the run screen\'s matcher walks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-tree-shape-'));
  try {
    const write = (rel, body = '# note\n') => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    };
    write('top.md');
    write('Run output/opened-from-run.md');
    write('notes/deep/plan.md');
    write('.run-scratch/hidden.md');
    write('scripts/job.py', 'print(1)\n');

    const tree = _internal.getFileTree(dir);
    const nodes = nodesOf(tree);
    assert.ok(nodes.length > 0, 'the walk listed something');
    for (const node of nodes) {
      assert.ok(node.type === 'file' || node.type === 'folder', `${node.path} is a file or a folder, by those words`);
      if (node.type === 'folder') assert.ok(Array.isArray(node.children), `the folder ${node.path} carries its children`);
      assert.ok(!path.isAbsolute(node.path) && !node.path.includes('\\'), `${node.path} is root-relative, with forward slashes`);
    }
    assert.ok(nodes.some(n => n.type === 'folder' && n.path === 'notes/deep'),
      'a nested folder is named by its whole relative path');

    const linked = (rel) => model.treePathFor(path.join(dir, ...rel.split('/')), dir, tree);
    assert.strictEqual(linked('top.md'), 'top.md', 'a file at the root links');
    assert.strictEqual(linked('Run output/opened-from-run.md'), 'Run output/opened-from-run.md',
      'a file inside a folder links to the tree\'s own path');
    assert.strictEqual(linked('notes/deep/plan.md'), 'notes/deep/plan.md', 'and so does one two folders down');
    assert.strictEqual(linked('.run-scratch/hidden.md'), null, 'a file in a dot folder the tree leaves out stays plain');
    assert.strictEqual(linked('scripts/job.py'), null, 'and so does a code file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
