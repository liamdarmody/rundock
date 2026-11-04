'use strict';
// THE STUB HOLDS A RUN TO ITS --disallowed-tools LIST THE WAY CLAUDE CODE DOES.
//
// The integration suites prove the Notes-mode block on the stub binary, so the
// stub has to refuse exactly what the real CLI refuses and nothing it allows.
// Every case below is a result measured against a real Claude Code run in a
// routine's spawn shape (--print --dangerously-skip-permissions, a fixed
// --session-id) driven by a stand-in for the API, and the stub is held to the
// same answer:
//
//   - the tool flags are variadic, so a list placed just before the prompt
//     takes the prompt as one more tool, and the run fails for want of input;
//   - a path rule matches only under Edit(...), and covers every tool that
//     writes a file; a Write(path) rule matches nothing;
//   - a bare tool name turns that tool off;
//   - a shell `rm` or `mv` naming a path an Edit(path) rule covers is refused,
//     whatever the permission hook answered.
//
// The measurement itself is committed, as test/fixtures/claude-cli-notes-mode.json
// (made by test/tools/claude-cli-notes-mode-probe.js), and
// test/unit/stub-claude-matches-cli.test.js holds the stub to it case by case.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { makeTempDir, cleanup } = require('../helpers/workspace.js');

after(cleanup);

const STUB = path.join(__dirname, '..', 'helpers', 'stub-claude', 'claude');
const HOME = makeTempDir('rundock-stub-home-');
// A list in the shape Rundock writes: both halves, and a bare tool. Written
// out here rather than read from the product, because this file is about the
// stub's model of the CLI and holds whatever list it is given.
const LIST = 'Write(*.py),Write(*.sh),Edit(*.py),Edit(*.sh),NotebookEdit';

// One routine-shaped run of the stub in a fresh folder. `seed` files exist
// before it starts; `rule` is its one scenario rule.
function run({ list, rule = {}, seed = [], order = 'before-print' }) {
  const dir = makeTempDir('rundock-stub-rules-');
  for (const f of seed) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), 'here before the run\n');
  }
  fs.writeFileSync(path.join(dir, 'stub-scenario.json'), JSON.stringify({ rules: [{ match: {}, turn: [{ text: 'done' }], ...rule }] }));
  const flag = list == null ? [] : ['--disallowed-tools', list];
  const tail = ['--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--session-id', crypto.randomUUID()];
  const argv = order === 'before-print'
    ? [...flag, '--print', ...tail, 'do the work']
    : ['--print', ...tail, ...flag, 'do the work'];
  const r = spawnSync(process.execPath, [STUB, ...argv], { cwd: dir, env: { ...process.env, HOME }, encoding: 'utf8', timeout: 15000 });
  return { dir, status: r.status, stderr: r.stderr, has: (f) => fs.existsSync(path.join(dir, f)) };
}

describe('the tool flags take every argument up to the next flag', () => {
  test('a list placed just before the prompt takes the prompt, and the run fails for want of input', () => {
    const r = run({ list: 'Edit(*.py)', order: 'before-prompt' });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /Input must be provided either through stdin or as a prompt argument when using --print/);
  });

  test('a list placed before --print leaves the prompt as the input', () => {
    const r = run({ list: 'Edit(*.py)', rule: { writes: [{ file: 'note.md' }] } });
    assert.strictEqual(r.status, 0);
    assert.ok(r.has('note.md'), 'the run did its work');
  });
});

describe('file writes', () => {
  test('a Write(path) rule matches nothing', () => {
    assert.ok(run({ list: 'Write(*.py)', rule: { writes: [{ file: 'tool.py' }] } }).has('tool.py'));
  });

  test('an Edit(path) rule refuses a Write, at any depth', () => {
    const r = run({ list: 'Edit(*.py)', rule: { writes: [{ file: 'tool.py' }, { file: 'sub/tool.py' }, { file: 'note.md' }] } });
    assert.ok(r.has('note.md'), 'the same run wrote its note, so it did reach its writes');
    assert.ok(!r.has('tool.py'), 'tool.py was refused');
    assert.ok(!r.has('sub/tool.py'), 'sub/tool.py was refused');
  });

  test('an Edit(path) rule refuses an Edit of a file that is already there', () => {
    const r = run({ list: 'Edit(*.py)', seed: ['tool.py'], rule: { writes: [{ tool: 'Edit', file: 'tool.py' }, { file: 'note.md' }] } });
    assert.ok(r.has('note.md'), 'the same run wrote its note');
    assert.strictEqual(fs.readFileSync(path.join(r.dir, 'tool.py'), 'utf8'), 'here before the run\n');
  });

  test('a bare NotebookEdit turns the tool off', () => {
    const r = run({ list: 'NotebookEdit', rule: { writes: [{ tool: 'NotebookEdit', file: 'nb.ipynb' }, { file: 'note.md' }] } });
    assert.ok(r.has('note.md'), 'the same run wrote its note');
    assert.ok(!r.has('nb.ipynb'), 'the notebook was refused');
  });

  test('with no list, every write happens', () => {
    const r = run({ list: null, rule: { writes: [{ file: 'tool.py' }, { file: 'lib.dll' }] } });
    assert.ok(r.has('tool.py') && r.has('lib.dll'));
  });

  test('a rule shape the stub does not model stops the run rather than matching nothing', () => {
    const r = run({ list: 'Edit(src/**)', rule: { writes: [{ file: 'note.md' }] } });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /not modelled/);
  });
});

describe('a shell rename or delete', () => {
  test('of a covered file is refused, either way round', () => {
    const r = run({
      list: LIST,
      seed: ['tool.py', 'other.py', 'note.md', 'gone.md'],
      rule: { shell: ['rm tool.py', 'mv other.py other.py.md', 'mv note.md note.md.py', 'rm gone.md'] },
    });
    // The same run's delete of a note went ahead, so the refusals below are
    // refusals, not a run that never reached its commands.
    assert.ok(!r.has('gone.md'), 'the run did reach its commands');
    assert.ok(r.has('tool.py'), 'rm tool.py was refused');
    assert.ok(r.has('other.py') && !r.has('other.py.md'), 'renaming other.py away was refused');
    assert.ok(r.has('note.md') && !r.has('note.md.py'), 'renaming note.md to an executable name was refused');
  });

  test('of an ordinary note goes ahead', () => {
    const r = run({ list: LIST, seed: ['old.md', 'gone.md'], rule: { shell: ['mv old.md new.md', 'rm gone.md'] } });
    assert.ok(!r.has('old.md') && r.has('new.md'), 'the note was renamed');
    assert.ok(!r.has('gone.md'), 'the note was deleted');
  });

  test('with no list, goes ahead for any file', () => {
    const r = run({ list: null, seed: ['tool.py'], rule: { shell: ['rm tool.py'] } });
    assert.ok(!r.has('tool.py'));
  });
});
