'use strict';
// The shell check grows with the length of the command, not with its square.
//
// Every word of a command is resolved against the folder it starts from, and
// working that folder out once per word re-read the whole command each time:
// a chain of 2,000 commands took about four times as long as one of 1,000.
// Agents write long commands (a loop unrolled, a script in a here-document),
// and the check runs before each one.
//
// A WALL-CLOCK BUDGET, so it is listed in docs/TEST-TIMING.md. The ratio is
// the claim: doubling the command should roughly double the time, and a
// quadratic cost quadruples it, so the bound of 3 sits between the two. Each
// size is timed three times and the best kept, so one slow moment on a busy
// machine is not read as growth. The ceilings are a backstop several times
// what the work takes on a laptop.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hook = require('../../scripts/permission-hook.js');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shell-timing-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const home = path.join(root, 'home');
const ws = path.join(home, 'Workspace');
fs.mkdirSync(path.join(ws, 'out'), { recursive: true });

const once = (command) => {
  const t0 = process.hrtime.bigint();
  hook.classifyShellAccess('Bash', { command }, ws, [], home, false, {});
  return Number(process.hrtime.bigint() - t0) / 1e6;
};
const best = command => Math.min(once(command), once(command), once(command));

// The ceiling is checked after ONE run of the larger size, before the ratio,
// so a check that has gone quadratic fails in seconds rather than after six
// slow runs.
function linear(small, large, label) {
  const first = once(large);
  assert.ok(first < 5000, `${label} took ${Math.round(first)} ms`);
  const two = Math.min(first, once(large), once(large));
  const one = best(small);
  assert.ok(two <= 3 * one + 50, `${label} took ${Math.round(two)} ms against ${Math.round(one)} ms for half as much`);
}

describe('the shell check grows linearly with the command', () => {
  test('a chain of commands after a cd', () => {
    const chain = n => 'mkdir -p out && cd out && ' + Array.from({ length: n }, (_, i) => `cat ../f${i}.txt`).join(' && ');
    linear(chain(1000), chain(2000), '2,000 commands');
  });

  test('a long here-document fed to a shell', () => {
    const doc = n => "mkdir -p out && cd out && bash <<'SH'\n" + Array.from({ length: n }, (_, i) => `echo line ${i}`).join('\n') + '\nSH';
    linear(doc(2000), doc(4000), '4,000 lines');
  });
});
