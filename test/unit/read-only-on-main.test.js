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
// is the command, whether main read it, and main's risk. A command longer
// than a kibibyte is stored in pieces, and test/helpers/read-only-on-main.js
// reads each one back to the command before it is graded here.
const { test } = require('node:test');
const assert = require('node:assert');

const S = require('../../public/read-only-shell.js');
const P = require('../../public/permissions.js');
const { decodeCommand, recordedLines, LONGEST_AS_WRITTEN } = require('../helpers/read-only-on-main.js');
const RECORDED = require('../fixtures/read-only-on-main.json');
const LINES = recordedLines(RECORDED);

const risk = (command) => P.classifyRisk('Bash', { command });
const show = (cmd) => JSON.stringify(cmd.length > 100 ? cmd.slice(0, 100) + '...' : cmd);

test('the recording names its base and holds lines main reads and lines it does not', () => {
  assert.match(RECORDED.recordedFrom, /^[0-9a-f]{40}$/);
  assert.ok(LINES.length > 1000, `the recording holds ${LINES.length} lines`);
  RECORDED.lines.forEach(([stored], i) => {
    const cmd = LINES[i][0];
    assert.strictEqual(typeof cmd, 'string');
    if (typeof stored === 'string') assert.ok(cmd.length <= LONGEST_AS_WRITTEN, `a line this long is stored in pieces: ${show(cmd)}`);
    else assert.ok(cmd.length > LONGEST_AS_WRITTEN, `only a long line is stored in pieces: ${show(cmd)}`);
  });
  for (const [cmd, reads, r] of LINES) {
    assert.strictEqual(typeof reads, 'boolean');
    assert.ok(['low', 'medium', 'high'].includes(r), `a risk: ${show(cmd)}`);
  }
  assert.strictEqual(new Set(LINES.map(([cmd]) => cmd)).size, LINES.length, 'each line is recorded once');
  assert.ok(LINES.some(l => l[1]) && LINES.some(l => !l[1]), 'both kinds of line are recorded');
  assert.ok(LINES.some(([cmd]) => cmd.length > 64 * 1024), 'the longest tests of the length limit are recorded too');
});

test('a command stored in pieces reads back as each text repeated its times, in order', () => {
  assert.strictEqual(decodeCommand({ pieces: [['file notes.md ', 1], ['x', 5]] }), 'file notes.md xxxxx');
  assert.strictEqual(decodeCommand({ pieces: [['rg', 1], [' x', 3], [' .', 1]] }), 'rg x x x .');
  assert.strictEqual(decodeCommand('tree -L 2'), 'tree -L 2', 'a command stored as text is that text');
  for (const damaged of [{ pieces: [] }, { pieces: [['x', 0]] }, { pieces: [['x', 1.5]] }, { pieces: [['', 3]] }, { pieces: [['x']] }, { pieces: 'x' }, null, 7]) {
    assert.throws(() => decodeCommand(damaged), /neither a string nor pieces|not \[text, times\]/, `a damaged entry is refused: ${JSON.stringify(damaged)}`);
  }
});

test('every line main does not read is still not a read, and still asks', () => {
  const loosened = LINES.filter(([cmd, reads]) => !reads && (S.isReadOnlyShellCommand(cmd) !== false || risk(cmd) === 'low'));
  assert.deepStrictEqual(loosened.map(([cmd]) => show(cmd)), [], 'no line main asks about reads now');
});

test('every line main grades high is still high, so it never offers Always allow', () => {
  const lowered = LINES.filter(([cmd, , r]) => r === 'high' && risk(cmd) !== 'high');
  assert.deepStrictEqual(lowered.map(([cmd]) => show(cmd)), []);
});

test('the lines the shell\'s reading alone would read are in the recording, and main asks about each', () => {
  const recorded = new Map(LINES.map(([cmd, reads]) => [cmd, reads]));
  for (const cmd of ["find . -name 'a -delete'", 'rg "x --pre" .', "find . -na'me' x", 'grep "a\\"; rm x" f']) {
    assert.strictEqual(recorded.get(cmd), false, `recorded as not a read on main: ${show(cmd)}`);
  }
});
