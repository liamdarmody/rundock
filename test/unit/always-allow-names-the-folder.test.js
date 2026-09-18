'use strict';
// "ALWAYS ALLOW THIS FOLDER" NAMES THE FOLDER, where naming it means something.
//
// Reported from the field, three observations that were all one bug: a person
// approved `Test1` with the button, the very next command raised a card for a
// path inside it, and the folder was nowhere to be found in Settings.
//
// The cause was two stores with different reach behind one label. A boundary
// grant is consulted at decision time, so it is instant, but it is never
// consulted for a shell command: a folder grant says an agent may touch a
// folder, approving a command says that command may run, and the second cannot
// be inferred from the first. A working folder is handed to the runtime at
// spawn, so it covers the shell too, and it is the list Settings shows and the
// card's own hint points at.
//
// The button now writes both. Driven through the real handler rather than a
// stand-in, because "what the button does" is exactly what is in doubt.
const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { setWorkspace, getWorkspace } = require('../../lib/config.js');
const control = require('../../lib/protocol/handlers/process-control.js');
const boundary = require('../../lib/workspace/boundary.js');
const wf = require('../../lib/workspace/working-folders.js');

const made = [];
const savedWorkspace = getWorkspace();
after(() => {
  setWorkspace(savedWorkspace || null);
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
});

function freshWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'always-allow-'));
  fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  made.push(ws);
  setWorkspace(ws);
  return ws;
}

function approveFolder(dir, sent) {
  const ctx = {
    pendingPermissions: new Map([['r1', { res: null, onDecision: () => {}, toolName: 'Read' }]]),
    processes: new Map(),
    broadcast: (m) => sent.push(JSON.parse(m)),
  };
  control.handlePermissionResponse(ctx, null, {
    requestId: 'r1', allow: true, grantDir: dir, conversationId: 'c1',
  });
}

describe('approving a folder puts it where a person can see it', () => {
  let target;
  beforeEach(() => {
    freshWorkspace();
    target = fs.mkdtempSync(path.join(os.tmpdir(), 'granted-target-'));
    made.push(target);
  });

  test('it lands in Working folders, which is where the card told them to look', () => {
    const sent = [];
    approveFolder(target, sent);
    assert.ok(wf.readWorkingFolders().includes(target),
      'the folder a person approved is the folder Settings shows them');
  });

  test('and still lands in the grant store, so file access is covered right away', () => {
    // The instant half. A working folder reaches the runtime at the next spawn,
    // so dropping the grant would trade one gap for another.
    approveFolder(target, []);
    assert.ok(boundary.boundaryGrantCovers(path.join(target, 'a.md')),
      'file access inside the approved folder is covered without waiting for a respawn');
  });

  test('the shell stops asking about it, which the grant alone never did', () => {
    // The whole point. Working folders are handed to the hook as extra dirs, so
    // a command touching the folder is not a crossing at all.
    approveFolder(target, []);
    const hook = require('../../scripts/permission-hook.js');
    const dirs = wf.effectiveWorkingFolders();
    assert.strictEqual(
      hook.classifyShellAccess('Bash', { command: `ls -la ${target}/Daily Notes` }, getWorkspace(), dirs),
      null,
      'this is the card that kept appearing after the folder had been approved');
  });

  test('the open Settings pane is told, without a reload', () => {
    const sent = [];
    approveFolder(target, sent);
    const msg = sent.find(m => m.type === 'working_folders');
    assert.ok(msg, 'a person watching Settings sees the row appear');
    assert.ok(msg.folders.some(f => f.path === target), 'and it is the folder they approved');
  });

  test('approving the same folder twice does not grow the list', () => {
    approveFolder(target, []);
    approveFolder(target, []);
    const count = wf.readWorkingFolders().filter(d => d === target).length;
    assert.strictEqual(count, 1, 'approving a folder again is ordinary, and must not duplicate the row');
  });

  test('a denial names nothing', () => {
    const ctx = {
      pendingPermissions: new Map([['r2', { res: null, onDecision: () => {}, toolName: 'Read' }]]),
      processes: new Map(), broadcast: () => {},
    };
    control.handlePermissionResponse(ctx, null, { requestId: 'r2', allow: false, grantDir: target, conversationId: 'c1' });
    assert.ok(!wf.readWorkingFolders().includes(target),
      'saying no to a folder must never be the way it gets named');
  });
});

// AND IT TAKES EFFECT ON THE VERY NEXT COMMAND, not the next agent.
//
// The reported sequence, exactly: approve the folder, then watch the next
// command in the SAME turn raise a card for a path inside it. The approval was
// stored correctly; the running agent had been handed its folder list at spawn
// and had no way to hear about the change. From the reader's side the button
// did nothing, and a button that appears to do nothing is worse than no button.
//
// Driven through the real hook PROCESS with the born-with environment of an
// agent that started before the approval, because that gap is the whole bug and
// a helper called in-process would not have it.
describe('an approved folder is in effect for the agent already running', () => {
  const { spawnSync } = require('node:child_process');
  const HOOK = require.resolve('../../scripts/permission-hook.js');

  function hookSees(ws, command, bornWith) {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: 's' }),
      env: {
        ...process.env, RUNDOCK: '1', RUNDOCK_WORKSPACE: ws, RUNDOCK_PORT: '1',
        RUNDOCK_CODE_MODE: '1',
        RUNDOCK_EXTRA_DIRS: bornWith.join(path.delimiter),
      },
      encoding: 'utf-8', timeout: 10000,
    });
    return r.stdout || '';
  }
  // CODE MODE IS THE MODE THAT CAN TELL THESE APART. In Knowledge mode every
  // shell command goes for a card whatever it touches, so "a card was raised"
  // says nothing about the boundary. In Code mode a command that crosses is the
  // only kind that asks, so auto-approval is exactly the signal "this reached
  // nothing outside". An earlier draft of this test asserted on Knowledge mode
  // and was measuring the mode, not the folder list.
  const WENT_TO_A_CARD = (out) => !/Auto-approved: workspace is in Code mode/.test(out);

  test('the next command after the approval is not asked about again', () => {
    const ws = freshWorkspace();
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'granted-live-'));
    made.push(target);
    const bornWith = [];

    const before = hookSees(ws, `ls -la "${target}/Daily Notes"`, bornWith);
    assert.ok(WENT_TO_A_CARD(before), 'sanity: before the approval this is a crossing, or the test proves nothing');

    approveFolder(target, []);

    const after = hookSees(ws, `ls -la "${target}/Daily Notes"`, bornWith);
    assert.ok(!WENT_TO_A_CARD(after),
      'this is the reported bug: the same command, in the same turn, asked again after being approved');
  });

  test('a folder removed since the agent started is still honoured for it', () => {
    // The other direction, and the reason the born-with list is unioned rather
    // than replaced. lib/runtime/claude.js promises an agent keeps the boundary
    // it was born with so a list edited mid-command cannot forbid what a
    // command is already doing. Widening now, narrowing at the next spawn.
    const ws = freshWorkspace();
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'born-with-'));
    made.push(target);
    const out = hookSees(ws, `ls -la "${target}"`, [target]);
    assert.ok(!WENT_TO_A_CARD(out),
      'the folder is in no file, but this agent was born with it and keeps it');
  });

  test('an unreadable state file leaves the born-with list standing', () => {
    // The safe direction: it can only ask more often, never less.
    const ws = freshWorkspace();
    fs.writeFileSync(path.join(ws, '.rundock', 'state.json'), '{ this is not json');
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'torn-state-'));
    made.push(target);
    assert.ok(!WENT_TO_A_CARD(hookSees(ws, `ls -la "${target}"`, [target])),
      'a torn file must not silently drop the folders an agent was born with');
    assert.ok(WENT_TO_A_CARD(hookSees(ws, 'ls -la /etc', [])),
      'and it must not become a reason to stop asking about anything else');
  });
});

// THE APPROVAL SURVIVES A FAILURE TO UPDATE THE SANDBOX.
//
// Naming a folder does two things: it stores the list, and it rewrites the OS
// sandbox block so the operating system hears about it too. The second can fail
// on its own (an unwritable settings file, a torn one), and when it does, the
// list is already stored and already in effect for the next spawn.
//
// Throwing here would discard an approval the person just gave because a
// settings file could not be written, which costs them more than the delay it
// saves. The same judgement the Settings pane already makes for the same write.
describe('the sandbox write can fail without losing the approval', () => {
  test('the folder is still named, and the failure is warned rather than raised', () => {
    const ws = freshWorkspace();
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-fail-'));
    made.push(target);

    // Make the reconcile fail the way a real one does: the settings file it
    // must rewrite is a directory, so writing it throws.
    const claudeDir = path.join(ws, '.claude');
    fs.rmSync(claudeDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(claudeDir, 'settings.local.json'), { recursive: true });

    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    try {
      approveFolder(target, []);
    } finally { console.warn = realWarn; }

    assert.ok(wf.readWorkingFolders().includes(target),
      'the approval is kept: the list is what the next spawn reads, and it was written');
    assert.ok(warnings.some(w => /sandbox was not updated|not added to Working folders/i.test(w)),
      'and the failure is said out loud rather than swallowed');
  });
});
