'use strict';
// NOTHING THAT ASKED ON MAIN STOPS ASKING. The options of find, rg, tree and
// file are judged on the words the shell hands the program, which made a
// quoted writing option ask; this holds that reading to tightening only.
//
// test/fixtures/read-only-on-main.json holds main's verdict, at the merge base
// it names, on every shell command the read-only tests judge: the lines they
// write out, the forms they generate from the module's own lists, and the
// lines their hooks are handed. It is recorded by
// test/tools/record-read-only-on-main.js and written by nothing else; each row
// is the command, whether main read it, and main's risk.
const { test } = require('node:test');
const assert = require('node:assert');

const S = require('../../public/read-only-shell.js');
const P = require('../../public/permissions.js');
const RECORDED = require('../fixtures/read-only-on-main.json');

const risk = (command) => P.classifyRisk('Bash', { command });
const show = (cmd) => JSON.stringify(cmd.length > 100 ? cmd.slice(0, 100) + '...' : cmd);

test('the recording names its base and holds lines main reads and lines it does not', () => {
  assert.match(RECORDED.recordedFrom, /^[0-9a-f]{40}$/);
  assert.ok(RECORDED.lines.length > 1000, `the recording holds ${RECORDED.lines.length} lines`);
  for (const [cmd, reads, r] of RECORDED.lines) {
    assert.strictEqual(typeof cmd, 'string');
    assert.strictEqual(typeof reads, 'boolean');
    assert.ok(['low', 'medium', 'high'].includes(r), `a risk: ${show(cmd)}`);
  }
  assert.ok(RECORDED.lines.some(l => l[1]) && RECORDED.lines.some(l => !l[1]), 'both kinds of line are recorded');
});

test('every line main does not read is still not a read, and still asks', () => {
  const loosened = RECORDED.lines.filter(([cmd, reads]) => !reads && (S.isReadOnlyShellCommand(cmd) !== false || risk(cmd) === 'low'));
  assert.deepStrictEqual(loosened.map(([cmd]) => show(cmd)), [], 'no line main asks about reads now');
});

test('every line main grades high is still high, so it never offers Always allow', () => {
  const lowered = RECORDED.lines.filter(([cmd, , r]) => r === 'high' && risk(cmd) !== 'high');
  assert.deepStrictEqual(lowered.map(([cmd]) => show(cmd)), []);
});

test('the lines the shell\'s reading alone would read are in the recording, and main asks about each', () => {
  const recorded = new Map(RECORDED.lines.map(([cmd, reads]) => [cmd, reads]));
  for (const cmd of ["find . -name 'a -delete'", 'rg "x --pre" .', "find . -na'me' x", 'grep "a\\"; rm x" f']) {
    assert.strictEqual(recorded.get(cmd), false, `recorded as not a read on main: ${show(cmd)}`);
  }
});
