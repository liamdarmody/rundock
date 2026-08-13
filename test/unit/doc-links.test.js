'use strict';
// Every relative markdown link in the repo's documentation resolves.
//
// Four links in docs/ pointed at ARCHITECTURE.md and CONTRIBUTING.md as if
// they sat in the same directory; both are at the repo root, so all four
// 404'd on GitHub. They had been broken long enough that nobody noticed,
// which is the argument for checking it here rather than by eye.
//
// This is the cheapest half of keeping docs honest. It catches a link that
// stops resolving; it cannot catch prose that stops being true. The pattern
// worth copying for the second half is docs/RUNTIME-ADAPTER.md, whose claims
// are pinned by test/unit/runtime-adapter.test.js reading its needles, and
// which is the one documentation file in this repo that has not drifted.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SKIP = new Set(['node_modules', '.git', 'test-results', 'dist', 'coverage']);

function markdownFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(p, out);
    else if (entry.name.endsWith('.md')) out.push(p);
  }
  return out;
}

test('every relative markdown link in the docs resolves to a file', () => {
  const files = markdownFiles(ROOT).filter(f => !f.includes(`${path.sep}test${path.sep}fixtures${path.sep}`));
  assert.ok(files.length >= 5, `sanity: found ${files.length} markdown files`);

  const broken = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, i) => {
      // [text](target.md) and [text](dir/target.md#anchor). Absolute URLs and
      // pure anchors are somebody else's problem.
      for (const m of line.matchAll(/\[[^\]]*\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
        const target = m[1];
        if (/^[a-z]+:\/\//i.test(target)) continue;
        const resolved = path.resolve(path.dirname(file), target);
        if (!fs.existsSync(resolved)) {
          broken.push(`${path.relative(ROOT, file)}:${i + 1} -> ${target}`);
        }
      }
    });
  }
  assert.deepStrictEqual(broken, [], 'broken relative links in documentation');
});
