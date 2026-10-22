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

const best = (command) => {
  let ms = Infinity;
  for (let k = 0; k < 3; k++) {
    const t0 = process.hrtime.bigint();
    hook.classifyShellAccess('Bash', { command }, ws, [], home, false, {});
    ms = Math.min(ms, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return ms;
};

describe('the shell check grows linearly with the command', () => {
  test('a chain of commands after a cd', () => {
    const chain = n => 'mkdir -p out && cd out && ' + Array.from({ length: n }, (_, i) => `cat ../f${i}.txt`).join(' && ');
    const one = best(chain(1000));
    const two = best(chain(2000));
    assert.ok(two <= 3 * one + 50, `2,000 commands took ${Math.round(two)} ms against ${Math.round(one)} ms for 1,000`);
    assert.ok(two < 5000, `2,000 commands took ${Math.round(two)} ms`);
  });

  test('a long here-document fed to a shell', () => {
    const doc = n => "mkdir -p out && cd out && bash <<'SH'\n" + Array.from({ length: n }, (_, i) => `echo line ${i}`).join('\n') + '\nSH';
    const one = best(doc(2000));
    const two = best(doc(4000));
    assert.ok(two <= 3 * one + 50, `4,000 lines took ${Math.round(two)} ms against ${Math.round(one)} ms for 2,000`);
    assert.ok(two < 5000, `4,000 lines took ${Math.round(two)} ms`);
  });
});
