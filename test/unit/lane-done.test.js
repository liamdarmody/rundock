'use strict';
// The last check before a change is reported done.
//
// Each condition here is one a person once checked by hand and did not: a
// mutation run still writing mutants while the work was committed, files left
// unstaged or untracked, a commit made without the gate, and the leak scan.
// Every failure is one line saying what to do, so each case asserts the line
// names the thing at stake and nothing passes silently.
//
// NOTHING HERE TOUCHES THIS CHECKOUT. Each case builds a throwaway repository
// with an origin, so a case that fails half way cannot leave this one dirty.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { laneDone } = require('../../scripts/lane-done.js');
const { buildRecord, writeTreeRecord } = require('../../scripts/precommit-gate.js');
const { runRecordPath } = require('../../scripts/red-first.js');
const { makeTempDir } = require('../helpers/workspace.js');

const REPO = path.join(__dirname, '..', '..');
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@users.noreply.github.com',
};
const clean = { ok: true };

/**
 * A branch two commits past origin/main, each commit gated, nothing running
 * and nothing uncommitted: the state lane-done passes.
 */
function finished(t) {
  const dir = makeTempDir('lane-done-');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });
  const root = path.join(dir, 'work');
  const bare = path.join(dir, 'origin.git');
  const git = (...args) => execFileSync('git', args, { cwd: root, env: GIT_ENV, encoding: 'utf8' }).trim();
  fs.mkdirSync(root);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env: GIT_ENV });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, '.gitignore'),
    '.precommit-gate/\n.precommit-gate.json\n.mutation-runs/\n.tool-runs/\n');
  fs.writeFileSync(path.join(root, 'a.js'), 'module.exports = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Base');
  git('remote', 'add', 'origin', bare);
  git('push', '-q', 'origin', 'main');
  git('switch', '-q', '-c', 'feature');
  const gate = () => writeTreeRecord(buildRecord({
    tree: git('rev-parse', 'HEAD^{tree}'), branch: 'feature', at: 'now', timings: [{ step: 'preflight', ms: 1 }],
  }), path.join(root, '.precommit-gate'));
  for (const n of [2, 3]) {
    fs.writeFileSync(path.join(root, 'a.js'), `module.exports = ${n};\n`);
    git('add', '-A');
    git('commit', '-q', '-m', `Change ${n}`);
    gate();
  }
  return { root, git, check: (leakScan = () => clean) => laneDone({ root, leakScan }) };
}

describe('lane-done passes only on finished work', () => {
  test('a gated branch with nothing running and nothing uncommitted passes', (t) => {
    const r = finished(t).check();
    assert.deepStrictEqual(r.failures, []);
    assert.strictEqual(r.commits, 2, 'both commits since the merge base were checked');
  });

  test('a commit with no passing pre-commit record is named, with what to run', (t) => {
    const w = finished(t);
    fs.rmSync(path.join(w.root, '.precommit-gate', `${w.git('rev-parse', 'HEAD~1^{tree}')}.json`));
    const { failures } = w.check();
    assert.strictEqual(failures.length, 1, failures.join('\n'));
    assert.ok(failures[0].includes(w.git('rev-parse', '--short=8', 'HEAD~1')), failures[0]);
    assert.ok(!failures[0].includes(w.git('rev-parse', '--short=8', 'HEAD')), 'the gated commit is not named');
    assert.match(failures[0], /npm run precommit/);
  });

  test('uncommitted work fails, one line per kind, each naming its files', (t) => {
    const w = finished(t);
    fs.writeFileSync(path.join(w.root, 'staged.js'), '1;\n');
    w.git('add', 'staged.js');
    fs.appendFileSync(path.join(w.root, 'a.js'), '// edit\n');
    fs.writeFileSync(path.join(w.root, 'stray.txt'), 'x\n');
    const { failures } = w.check();
    assert.strictEqual(failures.length, 3, failures.join('\n'));
    assert.match(failures.find((l) => /^staged/.test(l)) || '', /staged\.js.*commit/);
    assert.match(failures.find((l) => /^unstaged/.test(l)) || '', /a\.js.*commit/);
    assert.match(failures.find((l) => /^untracked/.test(l)) || '', /stray\.txt.*\.gitignore/);
  });

  test('a long run still going in this checkout fails, whichever tool started it', (t) => {
    const w = finished(t);
    const write = (rel, record) => {
      fs.mkdirSync(path.dirname(path.join(w.root, rel)), { recursive: true });
      fs.writeFileSync(path.join(w.root, rel), JSON.stringify(record));
    };
    // This test's own process stands in for the run: it is certainly alive.
    write(`.tool-runs/${process.pid}.json`, { pid: process.pid, what: 'npm run mutate:guards' });
    write(`.mutation-runs/${process.pid}.json`, { pid: process.pid, tool: 'mutate-x-guards.js', files: ['a.js'] });
    const redFirst = runRecordPath(w.root);
    fs.writeFileSync(redFirst, JSON.stringify({ pid: process.pid, group: null, tests: 'npm test' }));
    t.after(() => fs.rmSync(redFirst, { force: true }));
    const { failures } = w.check();
    assert.strictEqual(failures.length, 3, failures.join('\n'));
    assert.match(failures[0], /mutate:guards.*still going.*wait for it/);
    assert.match(failures[1], /mutate-x-guards\.js.*still running/);
    assert.match(failures[2], /red-first.*still going/);
  });

  test('a red-first suite that outlived its tool still counts as running', (t) => {
    const w = finished(t);
    const { spawn } = require('node:child_process');
    const suite = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' });
    t.after(() => { try { process.kill(-suite.pid, 'SIGKILL'); } catch { /* gone */ } });
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    const redFirst = runRecordPath(w.root);
    fs.writeFileSync(redFirst, JSON.stringify({ pid: gone, group: suite.pid, tests: 'npm test' }));
    t.after(() => fs.rmSync(redFirst, { force: true }));
    const { failures } = w.check();
    assert.strictEqual(failures.length, 1, failures.join('\n'));
    assert.match(failures[0], /red-first.*still going/);
  });

  test('a red-first run recorded in the checkout is seen whatever the temp folder, by its suite\'s group too', (t) => {
    const w = finished(t);
    const { spawn } = require('node:child_process');
    const suite = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' });
    t.after(() => { try { process.kill(-suite.pid, 'SIGKILL'); } catch { /* gone */ } });
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    fs.mkdirSync(path.join(w.root, '.tool-runs'));
    fs.writeFileSync(path.join(w.root, '.tool-runs', `${gone}.json`),
      JSON.stringify({ pid: gone, group: suite.pid, what: 'npm run red-first' }));
    const { failures } = w.check();
    assert.strictEqual(failures.length, 1, failures.join('\n'));
    assert.match(failures[0], new RegExp(`red-first \\(pid ${gone}, process group ${suite.pid}\\) is still going`));
  });

  test('a mutation run that died is named with the files it may have left mutated', (t) => {
    const w = finished(t);
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    fs.mkdirSync(path.join(w.root, '.mutation-runs'));
    fs.writeFileSync(path.join(w.root, '.mutation-runs', `${gone}.json`),
      JSON.stringify({ pid: gone, tool: 'mutate-x-guards.js', files: ['a.js'] }));
    const { failures } = w.check();
    assert.strictEqual(failures.length, 1, failures.join('\n'));
    assert.match(failures[0], new RegExp(`pid ${gone}\\) never finished.*a\\.js.*git checkout -- a\\.js`));
  });

  test('a leak scan that is not clean fails, naming the range and the command that shows it', (t) => {
    const w = finished(t);
    let asked = null;
    const { failures } = w.check((root, range) => { asked = range; return { ok: false }; });
    assert.match(asked, /^[0-9a-f]{40}\.\.HEAD$/, 'the scan covers the merge base to HEAD');
    assert.strictEqual(failures.length, 1, failures.join('\n'));
    assert.ok(failures[0].includes(`node scripts/leak-scan.js --range ${asked}`), failures[0]);
  });

  test('without origin/main there is no base to measure from, and it says so', (t) => {
    const w = finished(t);
    w.git('remote', 'remove', 'origin');
    const { failures } = w.check();
    assert.strictEqual(failures.length, 1, failures.join('\n'));
    assert.match(failures[0], /origin\/main.*git fetch origin/);
  });
});

describe('the command', () => {
  test('exits 0 with one line on finished work, and 1 with one line per failure otherwise', (t) => {
    const w = finished(t);
    const run = () => spawnSync(process.execPath, [path.join(REPO, 'scripts', 'lane-done.js')],
      { cwd: w.root, env: { ...GIT_ENV, LANE_DONE_ROOT: w.root }, encoding: 'utf8' });
    const pass = run();
    assert.strictEqual(pass.status, 0, `${pass.stdout}${pass.stderr}`);
    assert.match(pass.stdout, /^lane-done: pass/m);
    fs.writeFileSync(path.join(w.root, 'stray.txt'), 'x\n');
    fs.appendFileSync(path.join(w.root, 'a.js'), '// edit\n');
    const fail = run();
    assert.strictEqual(fail.status, 1, `${fail.stdout}${fail.stderr}`);
    const lines = fail.stderr.split('\n').filter((l) => l.startsWith('lane-done: '));
    assert.strictEqual(lines.length, 2, fail.stderr);
  });

  test('is the npm script of that name', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.scripts['lane-done'], 'node scripts/lane-done.js');
  });
});
