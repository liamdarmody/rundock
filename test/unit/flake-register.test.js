'use strict';
// The flake register, docs/FLAKES.md, and the retries it allows.
//
// A retry hides a timing regression as readily as it hides a slow runner, so
// the browser suite has no global retry. One is allowed only for a test the
// register names, one test at a time, and the register is where the count of
// strikes lives: a test that flakes twice is fixed or quarantined.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const REGISTER = path.join(ROOT, 'docs', 'FLAKES.md');
const STATUSES = ['retry once', 'open', 'fixed', 'quarantined'];

function rows() {
  const text = fs.readFileSync(REGISTER, 'utf8');
  return text.split('\n')
    .filter((l) => /^\| `test\//.test(l))
    .map((l) => {
      const cells = l.split('|').slice(1, -1).map((c) => c.trim());
      const m = /^`([^`]+)` "([^"]+)"$/.exec(cells[0]);
      return { cells, file: m && m[1], title: m && m[2], date: cells[1], cause: cells[2], status: cells[3] };
    });
}

/**
 * Why the retry for `title` in `src` is not where the register promises, or
 * null: one retry, configured inside a top-level describe that holds that
 * test and no other, so the retry reaches nothing else.
 */
function retryProblem(src, title) {
  const at = src.indexOf(`'${title}'`);
  if (at === -1) return 'no test has that title';
  const open = src.lastIndexOf('\ntest.describe(', at);
  if (open === -1) return 'the test is not inside a describe';
  const close = src.indexOf('\n});', open + 1);
  if (close === -1 || close < at) return 'the test is not inside the describe before it';
  const block = src.slice(open, close);
  if (!block.includes('test.describe.configure({ retries: 1 })')) return 'the describe that holds it configures no single retry';
  const tests = block.match(/\n\s+test(?:\.fixme|\.skip|\.only)?\(\s*'/g) || [];
  if (tests.length !== 1) return `the describe that holds it holds ${tests.length} tests`;
  return null;
}

test('the retry check finds a retry on the wrong describe, and a describe holding more than the one test', () => {
  const describe = (name, body) => `\ntest.describe('${name}', () => {\n${body}});\n`;
  const retry = '  test.describe.configure({ retries: 1 });\n';
  const one = (title) => `  test('${title}', async () => {\n    run();\n  });\n`;
  assert.strictEqual(retryProblem(describe('d', retry + one('mine')), 'mine'), null, 'the shape the register promises');
  assert.match(retryProblem(describe('other', retry + one('theirs')) + describe('d', one('mine')), 'mine'),
    /configures no single retry/, 'a retry on the describe before it is not its retry');
  assert.match(retryProblem(describe('d', retry + one('mine') + one('another')), 'mine'), /holds 2 tests/);
  assert.match(retryProblem(`\ntest('mine', () => {});\n`, 'mine'), /not inside a describe/);
  assert.match(retryProblem(describe('d', retry + one('mine')), 'gone'), /no test has that title/);
});

test('the register states the two-strike rule at its top', () => {
  const head = fs.readFileSync(REGISTER, 'utf8').split('\n').slice(0, 12).join('\n');
  assert.match(head, /flakes twice is fixed or quarantined/);
});

test('every row names an existing test, a date, a cause and a known status', () => {
  const all = rows();
  assert.ok(all.length >= 1, 'sanity: the register has rows');
  for (const r of all) {
    assert.strictEqual(r.cells.length, 4, `four cells: ${r.cells[0]}`);
    assert.ok(r.file && r.title, `the first cell is \`file\` "title": ${r.cells[0]}`);
    const src = fs.readFileSync(path.join(ROOT, r.file), 'utf8');
    assert.ok(src.includes(`'${r.title}'`), `${r.file} has a test titled "${r.title}"`);
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}(, \d{4}-\d{2}-\d{2})*$/, `dated: ${r.title}`);
    assert.ok(r.cause.length > 20, `a cause a reader can check: ${r.title}`);
    assert.ok(STATUSES.some((s) => r.status.startsWith(s)), `a known status: ${r.status}`);
  }
});

test('the browser suite has no global retry', () => {
  const config = fs.readFileSync(path.join(ROOT, 'playwright.config.js'), 'utf8');
  assert.doesNotMatch(config, /^\s*retries\s*:/m, 'a global retry would hide every timing regression');
});

test('a retry is given only to a test the register names, inside its own describe', () => {
  const allowed = rows().filter((r) => r.status.startsWith('retry once'));
  assert.ok(allowed.length >= 1, 'sanity: the seeded test has its retry');
  const e2e = path.join(ROOT, 'test', 'e2e');
  for (const name of fs.readdirSync(e2e).filter((n) => n.endsWith('.spec.js'))) {
    const src = fs.readFileSync(path.join(e2e, name), 'utf8');
    const retries = [...src.matchAll(/^(\s*)test\.describe\.configure\(\{[^}]*retries:\s*(\d+)/gm)];
    const mine = allowed.filter((r) => r.file === `test/e2e/${name}`);
    if (!retries.length) {
      assert.strictEqual(mine.length, 0, `${name}: the register allows a retry the spec does not take`);
      continue;
    }
    assert.ok(mine.length, `${name} retries a test the register does not name`);
    for (const [, indent, count] of retries) {
      assert.ok(indent.length > 0, `${name}: a retry configured at the top of the file reaches every test in it`);
      assert.strictEqual(count, '1', `${name}: one retry, not ${count}`);
    }
    assert.ok(/(?:^|\n)\s*test\(\s*'/.test(src), 'sanity: tests were found');
    for (const r of mine) assert.strictEqual(retryProblem(src, r.title), null, `${name}: "${r.title}"`);
  }
});
