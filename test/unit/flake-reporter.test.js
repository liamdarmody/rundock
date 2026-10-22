'use strict';
// A browser test that passed only on its retry is a flake, and the retry that
// let it pass leaves no trace otherwise: Playwright counts it "flaky" and
// exits 0, so no strike would ever reach docs/FLAKES.md. The reporter says so
// where it will be read: a GitHub warning in CI, a plain line locally.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const REPORTER = path.join(ROOT, 'test', 'e2e', 'flake-reporter.js');
const FlakeReporter = require(REPORTER);
const { makeTempDir } = require('../helpers/workspace.js');

const aTest = { title: 'a package is a card', location: { file: path.join(ROOT, 'test', 'e2e', 'x.spec.js'), line: 90 } };

function lines(env, result) {
  const out = [];
  new FlakeReporter({ configDir: ROOT, env, write: (l) => out.push(l) }).onTestEnd(aTest, result);
  return out;
}

test('a pass on a retry is a GitHub warning in CI, naming the test and the register', () => {
  const out = lines({ GITHUB_ACTIONS: 'true' }, { status: 'passed', retry: 1 });
  assert.strictEqual(out.length, 1, out.join('\n'));
  assert.match(out[0], /^::warning file=test\/e2e\/x\.spec\.js,line=90,title=Flaky test::/);
  assert.match(out[0], /"a package is a card" passed only on retry 1/);
  assert.match(out[0], /docs\/FLAKES\.md/);
});

test('locally it is one plain line', () => {
  const out = lines({}, { status: 'passed', retry: 1 });
  assert.strictEqual(out.length, 1);
  assert.match(out[0], /^\[flake\] test\/e2e\/x\.spec\.js:90 "a package is a card" passed only on retry 1: add a strike/);
});

test('a first-time pass, or a run that failed, says nothing', () => {
  assert.deepStrictEqual(lines({ GITHUB_ACTIONS: 'true' }, { status: 'passed', retry: 0 }), []);
  assert.deepStrictEqual(lines({ GITHUB_ACTIONS: 'true' }, { status: 'failed', retry: 1 }), []);
});

test('the browser suite reports with it, in CI and locally', () => {
  for (const CI of ['true', '']) {
    const env = { ...process.env, CI };
    const r = spawnSync(process.execPath, ['-e',
      `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(ROOT, 'playwright.config.js'))}).reporter))`],
    { cwd: ROOT, env, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const names = JSON.parse(r.stdout).map((entry) => entry[0]);
    assert.ok(names.includes('./test/e2e/flake-reporter.js'), `CI=${CI || 'unset'}: ${names.join(', ')}`);
  }
});

test('Playwright itself hands it a test that passed only on its retry', (t) => {
  // Driven through the real runner with a spec that needs no browser, so what
  // is proven is the API Playwright calls, not this file's idea of it.
  const dir = makeTempDir('flake-reporter-');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });
  const pw = require.resolve('@playwright/test');
  fs.writeFileSync(path.join(dir, 'flips.spec.js'), `const { test } = require(${JSON.stringify(pw)});
test('flips once', async ({}, testInfo) => { if (testInfo.retry === 0) throw new Error('first time'); });
test('steady', async () => {});
`);
  fs.writeFileSync(path.join(dir, 'pw.config.js'), `const { defineConfig } = require(${JSON.stringify(pw)});
module.exports = defineConfig({ testDir: __dirname, outputDir: require('node:path').join(__dirname, 'out'),
  retries: 1, reporter: [[${JSON.stringify(REPORTER)}]] });
`);
  const env = { ...process.env, GITHUB_ACTIONS: '' };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [path.join(path.dirname(pw), 'cli.js'), 'test', '--config', path.join(dir, 'pw.config.js')],
    { cwd: dir, env, encoding: 'utf8', timeout: 120000 });
  assert.strictEqual(r.status, 0, `a flaky pass still exits 0:\n${r.stdout}${r.stderr}`);
  const flakes = r.stdout.split('\n').filter((l) => l.startsWith('[flake] '));
  assert.strictEqual(flakes.length, 1, r.stdout);
  assert.match(flakes[0], /flips\.spec\.js:2 "flips once" passed only on retry 1/);
});
