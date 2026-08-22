#!/usr/bin/env node
'use strict';
// Reproduce test/fixtures/markdown-benign-before.html from the OLD renderer.
//
// WHY. That fixture is the only record of what "ordinary markdown renders as it
// always did" means, and the structural comparison in
// test/unit/markdown-render.test.js is taken against it. Committed as bytes it
// is a claim about code that no longer exists in the tree, which a reviewer
// would have to take on trust. This regenerates it from the pre-change
// public/app.js read out of git history, so the claim is checkable:
//
//   node test/tools/regenerate-benign-before.js --check
//
// exits non-zero if the committed fixture is not what that code produces.
// Without --check it writes the file.
//
// HOW. The renderer lived in a numbered section of public/app.js and could not
// be required: the file touches `document` at top level. The section is cut out
// by its banner comments and evaluated as a function body with the handful of
// names it referenced passed in, which is the smallest environment that runs
// the original code unmodified. `esc` is supplied as the same three-character
// escape the DOM round-trip it used produces.
//
// WHERE IT RUNS. The pre-commit gate and the CI job that checks out full
// history, and NOT the unit suite. CI checks out at depth 1 by default, so the
// base commit is absent from the clone and a test calling this could only fail
// there or be skipped into meaninglessness. It was in the suite for one push,
// which is how that was found.
//
// The base revision is the commit this work branched from. Pass another as
// --base <rev> if the fixture ever needs regenerating against a different one.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'markdown-benign-before.html');
const SOURCE = path.join(ROOT, 'test', 'fixtures', 'markdown-benign.md');
const DEFAULT_BASE = '1441068';

function oldRenderer(base) {
  let app;
  try {
    app = execFileSync('git', ['-C', ROOT, 'show', `${base}:public/app.js`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    throw new Error(
      `cannot read public/app.js at ${base}. This needs the repository's history, `
      + 'and a shallow clone does not have it: a depth-1 checkout contains only the '
      + 'tip commit. Fetch full history (actions/checkout with fetch-depth: 0) and run again.');
  }
  const lines = app.split('\n');
  const start = lines.findIndex((l) => l.includes('===== 12. MARKDOWN RENDERING'));
  const end = lines.findIndex((l) => l.includes('===== 13. SKILLS'));
  if (start === -1 || end === -1) {
    throw new Error(`could not find the markdown section in public/app.js at ${base}`);
  }
  const section = lines.slice(start, end).join('\n');

  // marked as the browser gets it: the UMD file the router serves, evaluated
  // with no module/exports/define in scope. Requiring it returns an empty
  // object, which would silently render nothing.
  const globalObj = {};
  const markedSrc = fs.readFileSync(path.join(ROOT, 'node_modules', 'marked', 'lib', 'marked.umd.js'), 'utf8');
  new Function('globalThis', 'self', 'module', 'exports', 'define', markedSrc)
    .call(globalObj, globalObj, globalObj, undefined, undefined, undefined);

  const hljs = require(path.join(ROOT, 'public', 'vendor', 'highlight', 'highlight.min.js'));
  const resolveCodeLanguage = require(path.join(ROOT, 'public', 'code-language.js'));
  const emptyOrderedListText = require(path.join(ROOT, 'public', 'empty-list.js'));
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const documentStub = {
    body: { classList: { contains: () => false } },
    getElementById: () => null,
  };

  const factory = new Function('marked', 'hljs', 'window', 'esc', 'document',
    'emptyOrderedListText', 'resolveCodeLanguage',
    `${section}\nreturn { formatMdFull };`);
  return factory(globalObj.marked, hljs, { resolveCodeLanguage, hljs }, esc, documentStub,
    emptyOrderedListText, resolveCodeLanguage);
}

function main(argv) {
  const baseIndex = argv.indexOf('--base');
  const base = baseIndex === -1 ? DEFAULT_BASE : argv[baseIndex + 1];
  const produced = oldRenderer(base).formatMdFull(fs.readFileSync(SOURCE, 'utf8'));

  if (!argv.includes('--check')) {
    fs.writeFileSync(FIXTURE, produced);
    console.log(`wrote ${path.relative(ROOT, FIXTURE)} from public/app.js at ${base}`);
    return 0;
  }
  const committed = fs.readFileSync(FIXTURE, 'utf8');
  if (committed === produced) {
    console.log(`markdown-benign-before.html matches public/app.js at ${base}`);
    return 0;
  }
  console.error(`markdown-benign-before.html does NOT match public/app.js at ${base}.`);
  console.error('The fixture is the only record of the previous rendering, so a mismatch means');
  console.error('either it was edited or the base is wrong. It is not to be regenerated to agree.');
  return 1;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    // The one expected failure is a shallow clone, and a stack trace buries the
    // one sentence that says so.
    console.error(e.message);
    process.exit(1);
  }
}
module.exports = { oldRenderer };
