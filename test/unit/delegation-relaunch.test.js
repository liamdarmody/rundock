'use strict';
// A delegation in flight survives the app quitting.
//
// REPORTED BY A DAILY USER. Leave Rundock while an agent is working, relaunch,
// open the active thread, and it has gone back to the orchestrator, which then
// asks the specialist for work it already delivered.
//
// THE UNSOUND INFERENCE. On every conversation load, a delegated conversation's
// activeAgentId is reset to the orchestrator whenever no live process is found,
// and the reset is written to disk. That is correct after a page RELOAD, where
// the delegate process is parked and reported idle. It is wrong after a
// RELAUNCH: the process map lives in memory and dies with the server, so
// absence carries no information at all, and every in-flight delegation is
// recorded as finished.
//
// The distinction the code cannot currently draw is between "no process because
// the delegate handed back" and "no process because the app quit". Only the
// first is a finished delegation, and only an OBSERVED handback says so.
//
// These drive the handler rather than reading its source. An earlier test in
// regression.test.js pins the source text of the reset instead, which is why it
// could not notice that the rule it pins is wrong after a restart.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const config = require(path.join(ROOT, 'lib', 'config.js'));
const { handleGetConversations } = require(path.join(ROOT, 'lib', 'protocol', 'handlers', 'conversations.js'));

function captureWs() {
  const sent = [];
  return { sent, send: (m) => sent.push(JSON.parse(m)), readyState: 1 };
}

/** A workspace holding one conversation, written the way the product writes it. */
function workspaceWith(convo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaunch-'));
  fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.rundock', 'conversations.json'),
    JSON.stringify([convo], null, 2));
  return dir;
}

function load(dir, processes = new Map()) {
  const original = config.getWorkspace();
  config.setWorkspace(dir);
  try {
    const ws = captureWs();
    handleGetConversations({ processes }, ws, { type: 'get_conversations' });
    const stored = JSON.parse(fs.readFileSync(path.join(dir, '.rundock', 'conversations.json'), 'utf8'));
    return { sent: ws.sent, stored };
  } finally {
    config.setWorkspace(original);
  }
}

const IN_FLIGHT = {
  id: 'c1',
  agentId: 'chief-of-staff',
  activeAgentId: 'lead-developer',
  sessionId: 's1',
  createdAt: new Date().toISOString(),
  lastActiveAt: new Date().toISOString(),
};

describe('a delegation in flight survives the app quitting', () => {
  test('after a restart, a delegated conversation still points at the specialist', () => {
    // No live process, because the process map died with the server. That is
    // the whole shape of the bug: absence of a process after a relaunch says
    // nothing about whether the delegate finished.
    const dir = workspaceWith({ ...IN_FLIGHT });
    const { stored } = load(dir);
    assert.strictEqual(stored[0].activeAgentId, 'lead-developer',
      'the pointer to the specialist survives a restart, because no handback was ever observed');
  });

  test('and that load writes no change to the stored conversation', () => {
    // The reset is not merely displayed, it is PERSISTED, which is what makes
    // the damage outlive the load that caused it.
    const dir = workspaceWith({ ...IN_FLIGHT });
    const before = fs.readFileSync(path.join(dir, '.rundock', 'conversations.json'), 'utf8');
    load(dir);
    const after = fs.readFileSync(path.join(dir, '.rundock', 'conversations.json'), 'utf8');
    assert.strictEqual(after, before, 'a load that changes nothing must write nothing');
  });

  test('a delegation whose handback was observed does reset to the orchestrator', () => {
    // The other direction, and the reason this cannot simply delete the reset.
    // A delegate that handed back really is finished, and the conversation
    // really should return to the orchestrator.
    const dir = workspaceWith({ ...IN_FLIGHT, delegationReturned: true });
    const { stored } = load(dir);
    assert.strictEqual(stored[0].activeAgentId, 'chief-of-staff',
      'an observed handback still returns the conversation to the orchestrator');
  });

  test('a live process still holds its pointer, which is the reload case', () => {
    // Unchanged behaviour, kept honest: with the delegate parked and reported
    // idle, the pointer was already left alone and must stay that way.
    const dir = workspaceWith({ ...IN_FLIGHT });
    const { stored } = load(dir, new Map([['c1', { pid: 1 }]]));
    assert.strictEqual(stored[0].activeAgentId, 'lead-developer',
      'a live process keeps its delegate pointer');
  });

  test('a conversation that was never delegated is untouched', () => {
    const dir = workspaceWith({ ...IN_FLIGHT, activeAgentId: 'chief-of-staff' });
    const { stored } = load(dir);
    assert.strictEqual(stored[0].activeAgentId, 'chief-of-staff');
  });
});

describe('the handback signal is written where the handback is seen', () => {
  const { markDelegationReturned } = require(path.join(ROOT, 'lib', 'delegation', 'engine.js'));

  test('an observed handback is recorded on disk, so it outlives the process that saw it', () => {
    // AND THIS IS THE HALF THAT MAKES THE RESET REAL. The loader now resets only
    // on this flag, so a flag nothing writes would disable the reset entirely
    // and leave every finished delegation pointing at its specialist forever.
    const dir = workspaceWith({ ...IN_FLIGHT });
    const original = config.getWorkspace();
    config.setWorkspace(dir);
    try {
      markDelegationReturned('c1');
      const stored = JSON.parse(fs.readFileSync(path.join(dir, '.rundock', 'conversations.json'), 'utf8'));
      assert.strictEqual(stored[0].delegationReturned, true,
        'the handback is on disk, readable by a server that did not observe it');
    } finally {
      config.setWorkspace(original);
    }
  });

  test('marking twice writes once, so an idle load rewrites nothing', () => {
    const dir = workspaceWith({ ...IN_FLIGHT });
    const file = path.join(dir, '.rundock', 'conversations.json');
    const original = config.getWorkspace();
    config.setWorkspace(dir);
    try {
      markDelegationReturned('c1');
      const after = fs.readFileSync(file, 'utf8');
      markDelegationReturned('c1');
      assert.strictEqual(fs.readFileSync(file, 'utf8'), after, 'the second mark wrote nothing');
    } finally {
      config.setWorkspace(original);
    }
  });

  test('a conversation that is not there is not an error the handback dies on', () => {
    const dir = workspaceWith({ ...IN_FLIGHT });
    const original = config.getWorkspace();
    config.setWorkspace(dir);
    try {
      assert.doesNotThrow(() => markDelegationReturned('no-such-conversation'));
    } finally {
      config.setWorkspace(original);
    }
  });
});

describe('a handback that cannot be recorded does not take the handback down with it', () => {
  const { markDelegationReturned } = require(path.join(ROOT, 'lib', 'delegation', 'engine.js'));

  test('an unwritable store is warned about, not thrown out of', () => {
    // The caller is mid-handback: the specialist has returned and the
    // orchestrator is being resumed. Failing to record that is worth saying out
    // loud, and worth nothing else. Throwing here would abandon the return
    // itself, which is a worse outcome than the stale-pointer bug this flag
    // exists to fix.
    const dir = workspaceWith({ ...IN_FLIGHT });
    const file = path.join(dir, '.rundock', 'conversations.json');
    const original = config.getWorkspace();
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (m) => warnings.push(String(m));
    config.setWorkspace(dir);
    try {
      fs.chmodSync(file, 0o444);
      assert.doesNotThrow(() => markDelegationReturned('c1'),
        'the handback survives a store it cannot write');
      assert.ok(warnings.some((w) => /could not record the handback/.test(w)),
        `and says so rather than failing silently (got ${JSON.stringify(warnings)})`);
    } finally {
      console.warn = realWarn;
      config.setWorkspace(original);
      try { fs.chmodSync(file, 0o644); } catch { /* going anyway */ }
    }
  });
});
