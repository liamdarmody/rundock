'use strict';
// The runner takes an exempt command's working directory, environment and
// output files from a file, so the command itself stays bare. It runs only
// what the sandbox exclusions already leave outside, and refuses at once when
// it is itself sandboxed.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { plan, execute, exemptPattern, Refusal } = require('../../scripts/exempt-run.js');

const RUNNER = path.join(__dirname, '..', '..', 'scripts', 'exempt-run.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exempt-run-'));
const write = (name, value) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
};
const NODE = [`${process.execPath} *`];
const outside = { env: {} };

describe('what it will run', () => {
  test('a command an exclusion matches whole', () => {
    assert.strictEqual(exemptPattern(['gh', 'pr', 'list'], ['gh *']), 'gh *');
  });

  test('a script an exclusion names without arguments, with arguments', () => {
    assert.strictEqual(exemptPattern(['node', '/s/test-a/run.js', 'a b'], ['node /s/test-*/*.js']), 'node /s/test-*/*.js');
  });

  test('nothing an exclusion does not name', () => {
    assert.strictEqual(exemptPattern(['rm', '-rf', '/s'], ['gh *', 'node /s/test-*/*.js']), null);
    const spec = write('rm.json', { cwd: dir, argv: ['rm', '-rf', dir] });
    assert.throws(() => plan(spec, { ...outside, patterns: ['gh *'] }), (e) => e instanceof Refusal && /matches no sandbox exclusion/.test(e.message));
  });
});

describe('the arguments file', () => {
  test('carries cwd, env and the output file, and the exit code comes back', () => {
    const out = path.join(dir, 'out.txt');
    const spec = write('ok.json', {
      cwd: dir,
      argv: [process.execPath, '-e', 'console.log(process.cwd() + " " + process.env.LANE_PORT); process.exit(3)'],
      env: { LANE_PORT: '4100' },
      stdout: out,
    });
    const p = plan(spec, { ...outside, patterns: NODE });
    assert.strictEqual(execute(p), 3);
    assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), `${fs.realpathSync(dir)} 4100`);
  });

  test('refuses an unknown key, a relative cwd and an empty argv', () => {
    for (const [name, spec, re] of [
      ['k.json', { argv: ['x'], shell: true }, /Unknown key "shell"/],
      ['c.json', { argv: ['x'], cwd: 'rel' }, /"cwd" must be an absolute path/],
      ['a.json', { argv: [] }, /"argv" must be a non-empty list/],
    ]) {
      assert.throws(() => plan(write(name, spec), { ...outside, patterns: NODE }), re);
    }
  });

  test('refuses a variable that changes what a program loads', () => {
    const spec = write('env.json', { cwd: dir, argv: [process.execPath, '-v'], env: { NODE_OPTIONS: '--require /x.js' } });
    assert.throws(() => plan(spec, { ...outside, patterns: NODE }), /changes what a program loads/);
  });

  test('refuses an output file outside the working directory and the file\'s own folder', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'exempt-run-elsewhere-'));
    const lane = fs.mkdtempSync(path.join(os.tmpdir(), 'exempt-run-lane-'));
    const spec = write('o.json', { cwd: lane, argv: [process.execPath, '-v'], stdout: path.join(elsewhere, 'x.txt') });
    assert.throws(() => plan(spec, { ...outside, patterns: NODE }), /must be inside the working directory or beside the arguments file/);
  });
});

describe('inside the sandbox', () => {
  test('refuses at once and names the exclusion to add', () => {
    const spec = write('s.json', { argv: [process.execPath, '-v'] });
    assert.throws(() => plan(spec, { env: { SANDBOX_RUNTIME: '1' }, patterns: NODE }),
      (e) => e instanceof Refusal && /itself running inside the agent sandbox/.test(e.message) && /exempt-run\.js \*/.test(e.message));
  });

  test('as a process: exit 2 with the reason, never the command\'s own failure', () => {
    const spec = write('p.json', { argv: [process.execPath, '-v'] });
    const r = spawnSync(process.execPath, [RUNNER, spec], { encoding: 'utf8', env: { ...process.env, SANDBOX_RUNTIME: '1' } });
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /^exempt-run: The runner is itself running inside the agent sandbox/);
  });
});

test('as a process outside the sandbox, the exclusions come from the configured settings', () => {
  const settings = write('settings.json', { sandbox: { excludedCommands: NODE } });
  const out = path.join(dir, 'proc.txt');
  const spec = write('proc.json', { cwd: dir, argv: [process.execPath, '-e', 'console.log("ran")'], stdout: out });
  const env = { ...process.env, RUNDOCK_SANDBOX_SETTINGS: settings };
  delete env.SANDBOX_RUNTIME;
  const r = spawnSync(process.execPath, [RUNNER, spec], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'ran');
});
