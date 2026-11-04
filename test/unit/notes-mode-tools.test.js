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

// THE INSTALLED CLI'S OWN TOOLS, MEASURED, NOT THE LIST'S IDEA OF THEM.
//
// test/fixtures/claude-cli-notes-mode.json records the tool list Claude Code
// reported in a run's init event, with no settings, plugins or MCP servers
// loaded, once with no --disallowed-tools and once with the Notes list. The
// record names the version and the method; test/tools/claude-cli-notes-mode-probe.js
// makes it. Every tool in it is sorted below into the ones that write a file's
// contents and the ones that do not, so a tool a newer CLI adds fails here
// until somebody says which it is.
const RECORD = require('../fixtures/claude-cli-notes-mode.json');
const { FILE_TOOLS } = require('../../lib/runtime/session-transcript.js');
const inventory = name => RECORD.cases.find(c => c.name === name).observed.tools;
const OFFERED = inventory('tool inventory, no list');
const OFFERED_IN_NOTES = inventory('tool inventory, Notes list');
// The tools that do not write a file's contents. Bash is a shell, not a file
// tool: its renames and deletes are held by Claude Code's own check, which the
// record also measures, and pinned in the scheduler and stub tests.
const NOT_FILE_WRITERS = [
  'Task', 'Bash', 'CronCreate', 'CronDelete', 'CronList', 'EnterWorktree', 'ExitWorktree', 'ListAgents',
  'Monitor', 'Read', 'ReportFindings', 'ScheduleWakeup', 'SendMessage', 'Skill', 'TaskStop', 'ToolSearch',
  'WebFetch', 'WebSearch', 'Workflow',
];

describe('the tools the installed Claude Code offers', () => {
  test('were measured on a named version, by a stated method', () => {
    assert.match(RECORD.claudeCode, /^\d+\.\d+\.\d+$/);
    assert.match(RECORD.method, /init event/);
    assert.match(RECORD.method, /--setting-sources ""/);
    assert.match(RECORD.method, /--strict-mcp-config/);
    assert.ok(Array.isArray(OFFERED) && OFFERED.length > 0, 'the record holds a tool list');
  });

  test('are each either a file-writing tool or one that writes no file contents', () => {
    const writers = OFFERED.filter(t => Object.prototype.hasOwnProperty.call(FILE_TOOLS, t));
    assert.deepStrictEqual([...writers].sort(), ['Edit', 'NotebookEdit', 'Write']);
    assert.deepStrictEqual(OFFERED.filter(t => !writers.includes(t)).sort(), [...NOT_FILE_WRITERS].sort(),
      'a tool the CLI offers is in neither group: say whether it writes a file and hold it to the list if it does');
  });

  test('every file-writing tool among them is held by the Notes list', () => {
    const list = entries(mode.NOTES_DISALLOWED_TOOLS);
    for (const tool of OFFERED.filter(t => Object.prototype.hasOwnProperty.call(FILE_TOOLS, t))) {
      // Write, Edit and NotebookEdit are the CLI's; MultiEdit is the reader's
      // and not offered, so it never reaches this loop.
      // An Edit(path) rule holds Write and Edit alike, so both are held when the
      // Edit half names every blocked extension; NotebookEdit is named bare.
      const byEditHalf = ['Write', 'Edit'].includes(tool)
        && JSON.stringify(half(mode.NOTES_DISALLOWED_TOOLS, 'Edit')) === JSON.stringify([...mode.NOTES_BLOCKED_EXTENSIONS]);
      assert.ok(list.includes(tool) || byEditHalf, `${tool} is held by the Notes list`);
    }
    // Held, as measured: under the list the CLI refused a Write and an Edit of
    // an executable file, in a routine's spawn shape and in a conversation's,
    // and no longer offered NotebookEdit at all.
    const refusedIn = (name, tool) => {
      const c = RECORD.cases.find(k => k.name === name);
      return c.steps.some((s, i) => s.tool === tool && c.observed.results[i].refused);
    };
    assert.ok(refusedIn('Notes list, file writes', 'Write'));
    assert.ok(refusedIn('Notes list, edits', 'Edit'));
    assert.ok(refusedIn('a conversation, Notes list, file writes, the hook answering allow', 'Write'));
    assert.ok(!OFFERED_IN_NOTES.includes('NotebookEdit'), 'NotebookEdit is not offered under the Notes list');
    assert.deepStrictEqual(OFFERED.filter(t => !OFFERED_IN_NOTES.includes(t)), ['NotebookEdit'], 'and nothing else is taken away');
  });

  test('include every tool the Notes list names, and the list names no other', () => {
    const named = new Set(entries(mode.NOTES_DISALLOWED_TOOLS).map(e => /^([A-Za-z]+)/.exec(e)[1]));
    for (const tool of named) assert.ok(OFFERED.includes(tool), `${tool} is a tool the CLI offers`);
    assert.ok(!OFFERED.includes('MultiEdit'), 'MultiEdit is not offered, which is why the list does not name it');
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
