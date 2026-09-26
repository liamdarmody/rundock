'use strict';
// The release walk's runner, held to its three rules against a stand-in step
// list: an unmet precondition fails the step by name with its reason and
// fails every dependent for that reason; nothing is PASS without an
// assertion having run; a throw is a FAIL carrying the message. Plus the
// wiring the runbook relies on: one npm script, a report naming the commit,
// the tags and every step's verdict, screenshot and reason.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runWalk, buildReport, renderReport, writeReport } = require('../../scripts/walk/runner.js');

const ROOT = path.join(__dirname, '..', '..');
const passing = (id, needs = []) => ({ id, name: `step ${id}`, needs, run: async (ctx, check) => check(true, 'fine') });

test('an unmet precondition fails the step by name and reason, and every dependent fails for that reason', async () => {
  const steps = [
    passing('boot'),
    { id: 'install', name: 'install', needs: ['boot'], precondition: async () => 'the link field is absent from the page', run: async (c, check) => check(true, 'x') },
    passing('team', ['install']),
    passing('skills', ['team']),
    passing('unrelated', ['boot']),
  ];
  const out = await runWalk(steps, {});
  const by = Object.fromEntries(out.results.map((r) => [r.id, r]));
  assert.equal(by.boot.verdict, 'PASS');
  assert.equal(by.install.verdict, 'FAIL');
  assert.match(by.install.reason, /precondition: the link field is absent from the page/);
  assert.equal(by.team.verdict, 'FAIL');
  assert.match(by.team.reason, /precondition: step install failed \(precondition: the link field is absent/);
  assert.equal(by.skills.verdict, 'FAIL');
  assert.match(by.skills.reason, /step team failed/);
  assert.equal(by.unrelated.verdict, 'PASS', 'a step that depends only on a passing step still runs');
  assert.equal(out.ok, false);
  assert.equal(out.exitCode, 1);
});

test('a step that names a step which never ran is a failed precondition, not a pass', async () => {
  const out = await runWalk([passing('later', ['earlier'])], {});
  assert.equal(out.results[0].verdict, 'FAIL');
  assert.match(out.results[0].reason, /step earlier did not run/);
});

test('no path marks a step PASS without its assertion having run', async () => {
  let ran = false;
  const steps = [
    { id: 'silent', name: 'returns without asserting', run: async () => { ran = true; } },
    { id: 'early', name: 'throws before asserting', run: async () => { throw new Error('the server never answered'); } },
    { id: 'false', name: 'asserts something false', run: async (c, check) => check(1 === 2, 'the row is missing') },
    { id: 'late', name: 'asserts then throws', run: async (c, check) => { check(true, 'ok'); throw new Error('page closed'); } },
    passing('true'),
  ];
  const out = await runWalk(steps, {});
  const by = Object.fromEntries(out.results.map((r) => [r.id, r]));
  assert.equal(ran, true);
  assert.equal(by.silent.verdict, 'FAIL');
  assert.equal(by.silent.reason, 'no assertion ran');
  assert.equal(by.early.verdict, 'FAIL');
  assert.equal(by.early.reason, 'threw: the server never answered');
  assert.equal(by.false.verdict, 'FAIL');
  assert.equal(by.false.reason, 'assertion failed: the row is missing');
  assert.equal(by.late.verdict, 'FAIL');
  assert.equal(by.late.reason, 'threw: page closed');
  assert.equal(by.true.verdict, 'PASS');
  assert.equal(out.failed.length, 4);
});

test('every step gets a screenshot through the hook, PASS or FAIL, and the exit code is zero only when all pass', async () => {
  const shots = [];
  const screenshot = async (name) => { shots.push(name); return `.walk/${name}.png`; };
  const out = await runWalk([passing('a'), { id: 'b', name: 'b', run: async () => {} }], {}, { screenshot });
  assert.deepEqual(shots, ['01-a', '02-b']);
  assert.equal(out.results[0].screenshot, '.walk/01-a.png');
  assert.equal(out.results[1].screenshot, '.walk/02-b.png');
  const clean = await runWalk([passing('a'), passing('b', ['a'])], {}, { screenshot });
  assert.equal(clean.exitCode, 0);
  assert.equal(clean.ok, true);
  const broken = await runWalk([passing('a')], {}, { screenshot: async () => { throw new Error('no page'); } });
  assert.equal(broken.results[0].verdict, 'PASS', 'a screenshot failure is noted, never a verdict');
  assert.equal(broken.results[0].screenshotError, 'no page');
});

test('the report names the server commit, the tags installed, and each step with verdict, screenshot and reason', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-report-'));
  const out = await runWalk([passing('boot'), { id: 'x', name: 'x', needs: ['boot'], run: async () => {} }], {}, { screenshot: async (n) => `${n}.png` });
  const report = buildReport({
    serverCommit: 'abc1234', dirty: false, tags: { 'liamdarmody/lean-agent-team': 'v1.0.0', 'liamdarmody/rundock-csv-extension': 'v1.0.1' },
    startedAt: 't0', finishedAt: 't1', results: out.results,
  });
  const file = writeReport(fs, dir, report);
  const back = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(back.serverCommit, 'abc1234');
  assert.deepEqual(back.tags, report.tags);
  assert.equal(back.ok, false);
  assert.deepEqual(back.steps.map((s) => [s.id, s.verdict, s.screenshot, s.reason]),
    [['boot', 'PASS', '01-boot.png', null], ['x', 'FAIL', '02-x.png', 'no assertion ran']]);
  const md = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
  assert.equal(md, renderReport(report));
  assert.match(md, /abc1234/);
  assert.match(md, /lean-agent-team at v1\.0\.0/);
  assert.match(md, /\| x x \| FAIL \| 02-x\.png \| no assertion ran \|/);
});

test('one command runs the walk, and its output directory is ignored by git', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.walk, 'node scripts/walk/run.js');
  const ignored = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n');
  assert.ok(ignored.includes('.walk/'), '.walk/ is the report directory and must be ignored');
});
