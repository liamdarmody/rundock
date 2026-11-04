'use strict';
// THE NOTES-MODE LIST, AS ONE VALUE.
//
// Notes mode keeps an agent from writing files that run as code. Claude Code
// enforces that through one --disallowed-tools value, built in one place, and
// it has two readers: every conversation spawn and every routine spawn. These
// tests pin the value itself, and the scheduler's reader before the server
// wires it.
//
// What the value has to contain is decided by how Claude Code reads its rules,
// which was measured rather than assumed: a path rule matches only under
// Edit(...), an Edit(path) rule covers every tool that writes a file, a
// Write(path) rule matches nothing, and a bare tool name turns that tool off.
// So the Edit half is the half that refuses, and it must name every extension
// the Write half names.
const { test, describe } = require('node:test');
const assert = require('node:assert');

// server.js is deliberately not loaded here: it wires the scheduler when it is
// required, and the last test below is about the scheduler before anything
// wires it. That a conversation and a routine are handed this same value is
// pinned on their real spawn arguments, in
// test/integration/scheduler-notes-mode-block.test.js.
const mode = require('../../lib/workspace/mode.js');

const RULE = /^(Write|Edit)\(\*\.([a-z]+)\)$/;

function entries(list) {
  return String(list).split(',');
}
function half(list, tool) {
  return entries(list).map(e => RULE.exec(e)).filter(m => m && m[1] === tool).map(m => m[2]);
}

describe('the Notes-mode list', () => {
  test('is not empty, and refuses through its Edit half', () => {
    const list = mode.NOTES_DISALLOWED_TOOLS;
    assert.strictEqual(typeof list, 'string');
    // An empty list in Notes mode would refuse nothing, and every test that
    // compared two readers of it would still agree. Stated outright so that
    // case fails here rather than passing everywhere.
    assert.ok(list.length > 0, 'the Notes list is empty');
    for (const ext of ['js', 'ts', 'py', 'sh', 'exe']) {
      assert.ok(entries(list).includes(`Edit(*.${ext})`), `Edit(*.${ext}) is on the list`);
    }
  });

  test('its Edit half names every extension its Write half names, in the same order', () => {
    const list = mode.NOTES_DISALLOWED_TOOLS;
    assert.deepStrictEqual(half(list, 'Edit'), half(list, 'Write'));
    assert.deepStrictEqual(half(list, 'Edit'), [...mode.NOTES_BLOCKED_EXTENSIONS]);
  });

  test('blocks shared libraries through the Edit half, not only the Write half', () => {
    // The Write half has always named .dll and .so. The Edit half did not, and
    // Claude Code never matches a Write(path) rule, so both were writable.
    for (const ext of ['dll', 'so']) {
      assert.ok(entries(mode.NOTES_DISALLOWED_TOOLS).includes(`Edit(*.${ext})`), `Edit(*.${ext}) is on the list`);
    }
  });

  test('turns NotebookEdit off outright, and names no tool Claude Code does not have', () => {
    const list = entries(mode.NOTES_DISALLOWED_TOOLS);
    assert.ok(list.includes('NotebookEdit'), 'NotebookEdit is turned off');
    assert.ok(!list.some(e => e.startsWith('MultiEdit')), 'MultiEdit is not a tool in the CLI, so it is not named');
    // Every entry is one of the three shapes, so nothing else slips in unread.
    for (const e of list) assert.ok(RULE.test(e) || e === 'NotebookEdit', `unexpected entry ${e}`);
  });
});

describe('the scheduler, before anything wires it', () => {
  // The server wires the scheduler's reader at boot. A routine that somehow
  // started before that, or in a process that never wires it, is held to the
  // restrictive mode rather than to none.
  test('reads the Notes list', () => {
    const scheduler = require('../../lib/scheduler.js');
    const defaults = scheduler.wireSchedulerDeps({});
    assert.strictEqual(typeof defaults.getDisallowedTools, 'function', 'the scheduler has a reader for the list');
    assert.strictEqual(defaults.getDisallowedTools(), mode.NOTES_DISALLOWED_TOOLS);
  });
});
