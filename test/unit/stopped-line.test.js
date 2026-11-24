'use strict';
// The words of the line a person reads when a delegate stops before finishing,
// and the one reason it names. The server decides that the delegate failed and
// sends this text; these tests pin the text itself, so every reason, every
// missing name and every name with a newline in it reads as it should.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const { cleanName, stopReason, stoppedLineText } = require(path.join(ROOT, 'lib', 'delegation', 'stopped-line.js'));

describe('stopReason names exactly one reason, in order', () => {
  test('a Codex delegate is named first, whatever else is true', () => {
    assert.strictEqual(stopReason({ codex: true, lastTurnOutcome: 'error', code: 1, signal: 'SIGKILL' }), 'Codex reported an error');
    assert.strictEqual(stopReason({ codex: true, lastTurnOutcome: null, code: -1, signal: null }), 'Codex reported an error');
  });

  test('an error result ranks above a signal and a code', () => {
    assert.strictEqual(stopReason({ codex: false, lastTurnOutcome: 'error', code: 1, signal: null }), 'Claude Code reported an error');
    assert.strictEqual(stopReason({ codex: false, lastTurnOutcome: 'error', code: null, signal: 'SIGKILL' }), 'Claude Code reported an error');
  });

  test('a signal ranks above a code', () => {
    assert.strictEqual(stopReason({ codex: false, lastTurnOutcome: null, code: null, signal: 'SIGKILL' }), 'stopped by the system');
    assert.strictEqual(stopReason({ codex: false, lastTurnOutcome: null, code: 1, signal: 'SIGTERM' }), 'stopped by the system');
  });

  test('an integer code is named as it is, zero included', () => {
    assert.strictEqual(stopReason({ codex: false, lastTurnOutcome: null, code: 1, signal: null }), 'exit code 1');
    assert.strictEqual(stopReason({ codex: false, lastTurnOutcome: null, code: 0, signal: null }), 'exit code 0');
  });

  test('a null code with no signal is stopped by the system', () => {
    assert.strictEqual(stopReason({ codex: false, lastTurnOutcome: null, code: null, signal: null }), 'stopped by the system');
    assert.strictEqual(stopReason({}), 'stopped by the system');
  });
});

describe('stoppedLineText', () => {
  test('names the delegate, the reason and the parent', () => {
    assert.strictEqual(stoppedLineText({ delegateName: 'Wren', parentName: 'Cos', reason: 'exit code 1' }),
      "Wren stopped before finishing\nWren's session ended before a final answer (exit code 1). Cos has the conversation again. Anything Wren changed before stopping is still in your workspace.");
  });

  test('with no name for the delegate, it says the agent', () => {
    assert.strictEqual(stoppedLineText({ delegateName: null, parentName: 'Cos', reason: 'exit code 1' }),
      "The agent stopped before finishing\nThe agent's session ended before a final answer (exit code 1). Cos has the conversation again. Anything the agent changed before stopping is still in your workspace.");
  });

  test('with no name for the parent, or no parent, the sentence about who has it is left out', () => {
    const expected = "Wren stopped before finishing\nWren's session ended before a final answer (stopped by the system). Anything Wren changed before stopping is still in your workspace.";
    assert.strictEqual(stoppedLineText({ delegateName: 'Wren', parentName: null, reason: 'stopped by the system' }), expected);
    assert.strictEqual(stoppedLineText({ delegateName: 'Wren', parentName: '   ', reason: 'stopped by the system' }), expected);
  });

  test('a name holding a newline or runs of spaces cannot add a line', () => {
    const text = stoppedLineText({ delegateName: '  Wren\n\nEvil  ', parentName: 'Cos\tLead', reason: 'exit code 1' });
    assert.strictEqual(text.split('\n').length, 2, 'title and body only');
    assert.ok(text.startsWith('Wren Evil stopped before finishing\n'), text);
    assert.ok(text.includes('Cos Lead has the conversation again.'), text);
  });

  test('a detail goes on its own line after the body, and an empty one adds nothing', () => {
    const base = stoppedLineText({ delegateName: 'Wren', parentName: 'Cos', reason: 'Codex reported an error' });
    assert.strictEqual(stoppedLineText({ delegateName: 'Wren', parentName: 'Cos', reason: 'Codex reported an error', detail: 'rate limited' }),
      `${base}\nrate limited`);
    assert.strictEqual(stoppedLineText({ delegateName: 'Wren', parentName: 'Cos', reason: 'Codex reported an error', detail: '  ' }), base);
  });

  test('cleanName collapses whitespace and gives null for nothing', () => {
    assert.strictEqual(cleanName(' A \n B '), 'A B');
    assert.strictEqual(cleanName(''), null);
    assert.strictEqual(cleanName(undefined), null);
    assert.strictEqual(cleanName(42), null);
  });
});
