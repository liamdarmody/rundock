'use strict';
// A CHILD A TEST STARTS IS KEPT OUT OF COVERAGE BY AN EMPTY VALUE, NEVER BY
// DELETING THE KEY.
//
// Under --experimental-test-coverage, every test file runs with
// NODE_V8_COVERAGE naming a folder, and Node copies that key into the
// environment of any child it spawns whose environment does not have the key
// of its own. So deleting the key from a child's environment does nothing:
// the key comes back and the child still writes coverage, which a child
// ended part way cuts short and the whole run's report then fails to merge.
// An empty value is a key of its own, so it is not copied over, and a child
// handed one writes no coverage at all.
//
// So no file under test/ deletes the key; each sets it to ''. The scan reads
// every file in the test tree. What it cannot see: a key left out by
// destructuring, or an environment built from nothing, which come back the
// same way.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const KEY = 'NODE_V8_' + 'COVERAGE';

// A deletion of the key, by the delete operator in dot or bracket form, or by
// Reflect.deleteProperty.
const DELETION = new RegExp(
  `\\bdelete\\s+[\\w$.\\[\\]'"\`\\s]*?(?:\\.\\s*${KEY}\\b|\\[\\s*['"\`]${KEY}['"\`]\\s*\\])`
  + `|\\bReflect\\.deleteProperty\\s*\\([^,)]*,\\s*['"\`]${KEY}['"\`]\\s*\\)`);
// The key given an empty value, in an object literal or by assignment.
const EMPTIED = new RegExp(`\\b${KEY}\\s*[:=]\\s*(?:''|""|\`\`)`);

function testTree(dir = 'test', out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') testTree(rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

// Every line in `files` the pattern matches, as `file:line: text`.
function linesMatching(files, pattern) {
  const found = [];
  for (const rel of files) {
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, i) => { if (pattern.exec(line)) found.push(`${rel}:${i + 1}: ${line.trim()}`); });
  }
  return found;
}

test('the scan finds a deletion of the key in every form it is written, and only a deletion', () => {
  const deletions = [
    `delete env.${KEY};`,
    `  delete e.${KEY};`,
    `delete process.env.${KEY};`,
    `delete env['${KEY}'];`,
    `delete env["${KEY}"];`,
    `delete options.env[\`${KEY}\`];`,
    `delete  env . ${KEY}`,
    `Reflect.deleteProperty(env, '${KEY}');`,
  ];
  for (const line of deletions) assert.ok(DELETION.exec(line), `a deletion the scan must see: ${line}`);
  const kept = [
    `env.${KEY} = '';`,
    `const env = { ...process.env, ${KEY}: '' };`,
    `delete env.RUNDOCK_CODE_MODE; env.${KEY} = '';`,
    `delete env.${KEY}_DIR;`,
    `// ${KEY} names a folder unless the key is already set`,
  ];
  for (const line of kept) assert.strictEqual(DELETION.exec(line), null, `not a deletion of the key: ${line}`);
  assert.ok(EMPTIED.exec(kept[0]) && EMPTIED.exec(kept[1]), 'both ways of emptying the key are seen');
});

test('no file under test/ deletes the key: each sets it to an empty value', () => {
  const files = testTree();
  // Floors, so a walk or a read that has gone blind fails here rather than
  // passing over nothing.
  assert.ok(files.length >= 500, `only ${files.length} files found under test/; the walk has gone blind`);
  assert.deepStrictEqual(linesMatching(files, DELETION), [],
    'deleting the key lets Node copy it back, so the child still writes coverage: set it to an empty value instead');
  const emptied = new Set(linesMatching(files, EMPTIED).map((l) => l.split(':')[0]));
  assert.ok(emptied.size >= 10, `only ${emptied.size} files set the key to an empty value; the scan has gone blind`);
});
