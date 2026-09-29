'use strict';
// A COMMAND THAT ONLY READS A PERMISSION FILE IS NOT A CHANGE TO IT.
//
// `tail`, `cat`, `od` and the like on `.rundock/permissions.json`,
// `.rundock/state.json` or `.claude/settings*.json` drew the answer-file card,
// worded as wanting to change what agents are allowed to do. The shell
// scanner decided "does this command only read" for the whole line, so one
// writing segment anywhere made every answer file it named a change. Now the
// segment that names the file decides, by the same read-only definition, and
// a redirect, `tee`, `sed -i`, `cp` or `mv` onto one of them still asks.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const fx = require('../helpers/code-mode-fixture.js');
const hook = require('../../scripts/permission-hook.js');

const root = fx.outsideTempRoot();
const SKIP = root.skip || false;
let world, capture, deadPort;
before(async () => {
  if (SKIP) return;
  world = fx.buildWorld(root.dir);
  fs.writeFileSync(path.join(world.ws, '.claude', 'settings.json'), '{}\n');
  capture = await fx.startCaptureServer();
  deadPort = await fx.closedPort();
});
after(async () => {
  if (capture) await capture.close();
  if (root.dir) fs.rmSync(root.dir, { recursive: true, force: true });
});

const READS = [
  'tail .rundock/permissions.json', 'tail -c 400 .rundock/permissions.json', 'cat .rundock/permissions.json', 'od -c .rundock/permissions.json',
  'head -5 .rundock/state.json', 'ls -l .rundock/permissions.json', 'wc -l .claude/settings.local.json', 'grep allow .rundock/permissions.json',
  'cat .claude/settings.json', 'hexdump -C .rundock/permissions.json', 'tail -c 200 .rundock/permissions.json; echo; od -c .rundock/state.json',
  'cat .rundock/permissions.json && echo done > build.log', 'tail .rundock/permissions.json | wc -l',
];
const WRITES = [
  'echo x > .rundock/permissions.json', 'echo x >> .rundock/state.json', 'cat x > .claude/settings.local.json', 'tee .rundock/permissions.json',
  'echo x | tee -a .rundock/state.json', 'sed -i s/a/b/ .rundock/permissions.json', 'cp x .rundock/permissions.json', 'mv x .claude/settings.json',
  'cat .rundock/permissions.json > copy.json', 'rm .rundock/permissions.json', 'cat .rundock/permissions.json; echo x > .rundock/permissions.json',
  'truncate -s 0 .rundock/state.json', 'ln -sf x .rundock/permissions.json',
];

const scan = (command) => hook.classifyShellAccess('Bash', { command }, world.ws, [world.projects], world.home, true, { cwd: world.ws, codeMode: true });
const answerFile = (a) => !!(a && hook.boundaryCrossingsFor(a).some(c => c && c.answerFile));
// The card is the answer-file card when the request says so, or any crossing does.
const answerFileCard = (p) => !!(p && (p.answer_file || (p.crossings || []).some(c => c && c.answerFile)));

describe('reading a permission file is not a change to it', { skip: SKIP }, () => {
  test('the read forms name no answer file', () => {
    for (const c of READS) assert.strictEqual(answerFile(scan(c)), false, c);
  });
  test('every write form still names it', () => {
    for (const c of WRITES) assert.strictEqual(answerFile(scan(c)), true, c);
  });

  test('through the real hook, in both modes: the reads raise no answer-file card, the writes do', async () => {
    for (const codeMode of [true, false]) {
      for (const command of READS) {
        const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command }, cwd: world.ws, codeMode });
        assert.ok(!answerFileCard(r.payload), `${codeMode ? 'Code' : 'Notes'}: ${command}`);
        if (codeMode) assert.strictEqual(r.cls, 'runs', `Code: ${command}`);
      }
      for (const command of WRITES) {
        const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command }, cwd: world.ws, codeMode });
        assert.ok(answerFileCard(r.payload), `${codeMode ? 'Code' : 'Notes'}: ${command}`);
      }
    }
  });
});
