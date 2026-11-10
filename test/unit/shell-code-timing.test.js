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
// the claim, measured across an EIGHTFOLD step: eight times the command should
// take about eight times as long, and a quadratic cost takes sixty-four, so the
// bound of 24 is three times linear growth and well under half of quadratic.
// A fourfold step, against a bound of 8, failed twice on a shared CI runner
// with nothing wrong, at 8.7 and 10.9 times the smaller size: there linear
// growth is 4 and quadratic only 16, too close to call when the files running
// beside this one keep the runner busy. A twofold step before it was closer
// still. Each size is run once to warm it up, then timed five times, the two
// sizes taking turns, and the best of each kept: one slow moment is not read
// as growth, and a busy stretch slows both sizes alike. The ceiling is a
// backstop many times what the work takes on a laptop.
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

const STEP = 8;
const BOUND = 24;
const RUNS = 5;

const once = (command) => {
  const t0 = process.hrtime.bigint();
  hook.classifyShellAccess('Bash', { command }, ws, [], home, false, {});
  return Number(process.hrtime.bigint() - t0) / 1e6;
};

// The ceiling is checked after ONE run of the larger size, before the ratio,
// so a check that has gone quadratic fails in seconds rather than after a
// dozen slow runs. That run is the larger size's warm-up.
function linear(small, large, label) {
  const first = once(large);
  assert.ok(first < 5000, `${label} took ${Math.round(first)} ms`);
  once(small);
  let big = Infinity;
  let eighth = Infinity;
  for (let i = 0; i < RUNS; i++) {
    big = Math.min(big, once(large));
    eighth = Math.min(eighth, once(small));
  }
  assert.ok(big <= BOUND * eighth + 50, `${label} took ${Math.round(big)} ms against ${Math.round(eighth)} ms for an eighth as much`);
}

describe('the shell check grows linearly with the command', () => {
  test('a chain of commands after a cd', () => {
    const chain = n => 'mkdir -p out && cd out && ' + Array.from({ length: n }, (_, i) => `cat ../f${i}.txt`).join(' && ');
    linear(chain(2000 / STEP), chain(2000), '2,000 commands');
  });

  test('a long here-document fed to a shell', () => {
    const doc = n => "mkdir -p out && cd out && bash <<'SH'\n" + Array.from({ length: n }, (_, i) => `echo line ${i}`).join('\n') + '\nSH';
    linear(doc(4000 / STEP), doc(4000), '4,000 lines');
  });
});
