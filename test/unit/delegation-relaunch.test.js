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
  const { recordControlReturnedTo } = require(path.join(ROOT, 'lib', 'delegation', 'engine.js'));

  test('an observed handback is recorded on disk, so it outlives the process that saw it', () => {
    // AND THIS IS THE HALF THAT MAKES THE RESET REAL. The loader now resets only
    // on this flag, so a flag nothing writes would disable the reset entirely
    // and leave every finished delegation pointing at its specialist forever.
    const dir = workspaceWith({ ...IN_FLIGHT });
    const original = config.getWorkspace();
    config.setWorkspace(dir);
    try {
      recordControlReturnedTo('c1', 'chief-of-staff');
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
      recordControlReturnedTo('c1', 'chief-of-staff');
      const after = fs.readFileSync(file, 'utf8');
      recordControlReturnedTo('c1', 'chief-of-staff');
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
      assert.doesNotThrow(() => recordControlReturnedTo('no-such-conversation', 'chief-of-staff'));
    } finally {
      config.setWorkspace(original);
    }
  });
});

describe('a handback that cannot be recorded does not take the handback down with it', () => {
  const { recordControlReturnedTo } = require(path.join(ROOT, 'lib', 'delegation', 'engine.js'));

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
      assert.doesNotThrow(() => recordControlReturnedTo('c1', 'chief-of-staff'),
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

describe('the rule both sides apply, and the routing that depends on it', () => {
  const { restoredActiveAgentId } = require(path.join(ROOT, 'public', 'delegation-restore.js'));
  const { handleSaveConversation } = require(path.join(ROOT, 'lib', 'protocol', 'handlers', 'conversations.js'));

  test('a restored delegation routes the next message to the specialist', () => {
    // THE REPORTED BUG, AT THE POINT IT ACTUALLY BITES. dispatchMessage resolves
    // its target as `state.activeAgentId || convo.agentId`, and the runtime
    // state is seeded from this rule. An earlier version narrowed the reset and
    // seeded nothing, so the server preserved the specialist on disk while the
    // client still sent the next message to the orchestrator: the symptom
    // survived a fix that looked right.
    assert.strictEqual(
      restoredActiveAgentId({ agentId: 'chief-of-staff', activeAgentId: 'lead-developer' }),
      'lead-developer',
      'no observed handback: the next message goes to the specialist');
  });

  test('a delegation that handed back routes to the orchestrator', () => {
    assert.strictEqual(
      restoredActiveAgentId({ agentId: 'chief-of-staff', activeAgentId: 'lead-developer', delegationReturned: true }),
      'chief-of-staff',
      'an observed handback returns the conversation to its owner');
  });

  test('an undelegated conversation routes to its own agent', () => {
    assert.strictEqual(restoredActiveAgentId({ agentId: 'chief-of-staff' }), 'chief-of-staff');
    assert.strictEqual(restoredActiveAgentId({ agentId: 'chief-of-staff', activeAgentId: null }), 'chief-of-staff');
  });

  test('an ordinary save does not wipe the handback record', () => {
    // save_conversation rebuilds the record from a whitelist and replaces the
    // whole entry, and the client sends it after essentially every turn. Left
    // out of that whitelist, a rename or a finished turn would erase the one
    // signal saying a delegation ended, and the conversation would stay pointed
    // at a specialist that had already handed back.
    const dir = workspaceWith({ ...IN_FLIGHT, delegationReturned: true });
    const original = config.getWorkspace();
    config.setWorkspace(dir);
    try {
      handleSaveConversation({}, captureWs(), {
        type: 'save_conversation',
        conversation: { id: 'c1', agentId: 'chief-of-staff', activeAgentId: 'lead-developer', title: 'Renamed' },
      });
      const stored = JSON.parse(fs.readFileSync(path.join(dir, '.rundock', 'conversations.json'), 'utf8'));
      assert.strictEqual(stored[0].delegationReturned, true, 'the handback record survived an ordinary save');
      assert.strictEqual(stored[0].title, 'Renamed', 'and the save still did its job');
    } finally {
      config.setWorkspace(original);
    }
  });

  test('a client cannot assert a handback that never happened', () => {
    // The flag is server-owned. Only the engine observes a handback, so a
    // message claiming one is ignored rather than believed.
    const dir = workspaceWith({ ...IN_FLIGHT });
    const original = config.getWorkspace();
    config.setWorkspace(dir);
    try {
      handleSaveConversation({}, captureWs(), {
        type: 'save_conversation',
        conversation: { id: 'c1', agentId: 'chief-of-staff', activeAgentId: 'lead-developer', title: 'T', delegationReturned: true },
      });
      const stored = JSON.parse(fs.readFileSync(path.join(dir, '.rundock', 'conversations.json'), 'utf8'));
      assert.strictEqual(stored[0].delegationReturned, false,
        'a handback the engine never saw is not created by a client saying so');
    } finally {
      config.setWorkspace(original);
    }
  });
});

describe('every path that returns control to a parent records the handback', () => {
  // A SOURCE BINDING, AND DELIBERATELY SO. Driving the engine to a real handback
  // needs a live child process, a session, and an intercepted Agent tool call;
  // what has to be guaranteed is narrower than that and does not survive being
  // tested through all of it: wherever control goes back to a parent, the
  // handback is recorded.
  //
  // A unit test of the writer cannot see whether the engine calls it. This
  // invariant covers that gap in the cheap direction; the behavioural proof
  // that a real handback writes the record lives in
  // test/integration/delegation-handback-record.test.js. `agent_switch` carrying
  // a `toAgent` is the engine saying control moved back to a parent, and every
  // one of those must be accompanied by the record.
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'delegation', 'engine.js'), 'utf8');

  test('each restoration path marks the handback before announcing the switch', () => {
    // A switch back to a PARENT, not every switch. The engine announces the
    // same way when a delegation STARTS (toAgent: targetAgent.id), and marking
    // there would record a handback that has not happened. The parent-bound
    // ones name the parent they are returning to.
    const PARENT_BOUND = /toAgent: (orchestrator\.id|orchestratorAgentId|parentAgentId|delegateEntry\.delegation\.originalAgentId)/;
    const lines = src.split('\n');
    const handbacks = [];
    lines.forEach((line, i) => {
      if (!line.includes("subtype: 'agent_switch'")) return;
      // The toAgent sits on this line or the next few, depending on how the
      // object literal was wrapped.
      if (PARENT_BOUND.test(lines.slice(i, i + 4).join('\n'))) handbacks.push(i);
    });
    assert.ok(handbacks.length >= 3,
      `the engine still has its parent-bound switches (found ${handbacks.length})`);

    for (const at of handbacks) {
      // Within the enclosing region rather than a fixed few lines: one of these
      // marks at the top of its function and announces sixty lines later.
      //
      // The number is a proxy for "in the same function", and it has now twice
      // been the reason a comment was shortened rather than a defect found:
      // explaining WHY a branch exists pushes the announcement further from the
      // record, and the test cannot tell that from the record going missing.
      // Widened so the proxy stops taxing explanation. It still fails on what it
      // exists to catch, an announcement with no record anywhere near it, and a
      // record in a different function would be a hundred and twenty lines away
      // in every one of these cases.
      const before = lines.slice(Math.max(0, at - 120), at).join('\n');
      assert.match(before, /recordControlReturnedTo\(convoId/,
        `the handback announced at line ${at + 1} records nothing about where control went:\n`
        + `${lines[at].trim()}\n`
        + 'Every path returning control to a parent must record it, or a finished '
        + 'delegation is never reconciled and the conversation stays pointed at a '
        + 'specialist that has already handed back.');
    }
  });
});

describe('the record describes the delegation running now, not the conversation history', () => {
  const { recordControlReturnedTo } = require(path.join(ROOT, 'lib', 'delegation', 'engine.js'));

  test('a second delegation after a handback is not reconciled away', () => {
    // THE FLAG IS ABOUT THIS DELEGATION, NOT ABOUT EVER. Written true on a
    // handback and never cleared, it answers "has this conversation ever had
    // one", which is true forever after the first. Every later delegation would
    // then be reset on a relaunch: the reported bug, back again, for every
    // delegation after the first in a conversation's life.
    const dir = workspaceWith({ ...IN_FLIGHT });
    const original = config.getWorkspace();
    config.setWorkspace(dir);
    try {
      // First delegation hands back.
      recordControlReturnedTo('c1', 'chief-of-staff');
      // A second delegation starts. The engine clears the record as it spawns.
      recordControlReturnedTo('c1', 'lead-developer');
    } finally {
      config.setWorkspace(original);
    }
    // The app quits mid-second-delegation, and the conversation is loaded again.
    const { stored } = load(dir);
    assert.strictEqual(stored[0].activeAgentId, 'lead-developer',
      'the second delegation keeps its specialist, because it never handed back');
  });

  test('clearing a record that is already clear writes nothing', () => {
    const dir = workspaceWith({ ...IN_FLIGHT });
    const file = path.join(dir, '.rundock', 'conversations.json');
    const original = config.getWorkspace();
    config.setWorkspace(dir);
    try {
      const before = fs.readFileSync(file, 'utf8');
      recordControlReturnedTo('c1', 'lead-developer');
      assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'no write for no change');
    } finally {
      config.setWorkspace(original);
    }
  });

  test('every delegation start clears the record, so the engine cannot forget', () => {
    // The clear belongs beside the spawn, the same way the mark belongs beside
    // the handback. Bound here because driving a real spawn needs a live child
    // process, and what must hold is narrower than that.
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'delegation', 'engine.js'), 'utf8');
    const lines = src.split('\n');
    const starts = [];
    lines.forEach((line, i) => {
      if (line.includes("subtype: 'agent_switch'")
        && lines.slice(i, i + 4).join('\n').includes('toAgent: targetAgent.id')) starts.push(i);
    });
    assert.ok(starts.length >= 1, 'the engine still announces a delegation starting');
    for (const at of starts) {
      const before = lines.slice(Math.max(0, at - 25), at).join('\n');
      assert.match(before, /setDelegationReturned\(convoId, false\)/,
        `the delegation starting at line ${at + 1} does not clear the handback record, so a `
        + 'previous handback would be read as this one\'s');
    }
  });
});

describe('nested delegation: coming back to a parent is not coming home', () => {
  const { recordControlReturnedTo } = require(path.join(ROOT, 'lib', 'delegation', 'engine.js'));
  const { restoredActiveAgentId } = require(path.join(ROOT, 'public', 'delegation-restore.js'));

  test('returning to a mid-level parent leaves the conversation delegated', () => {
    // Orchestrator delegates to a specialist that has its own reports, and that
    // specialist delegates again. When the sub-delegate returns, control goes
    // back to the MID-LEVEL parent and the orchestrator's own delegation is
    // still in flight. A bare "returned" boolean could not say that, and set
    // there it told the loader the conversation had come home when it had not.
    const dir = workspaceWith({ ...IN_FLIGHT, activeAgentId: 'content-lead' });
    const original = config.getWorkspace();
    config.setWorkspace(dir);
    try {
      recordControlReturnedTo('c1', 'content-lead');  // a delegate, not the base agent
    } finally {
      config.setWorkspace(original);
    }
    const { stored } = load(dir);
    // Absent, not written false: unreturned is the default and a writer that
    // rewrote the file to say so would churn the store on every nested return.
    assert.notStrictEqual(stored[0].delegationReturned, true,
      'control reached a delegate, so the conversation is still delegated');
    assert.strictEqual(stored[0].activeAgentId, 'content-lead',
      'and the pointer stays on the parent that now holds it');
  });

  test('returning to the base agent does bring the conversation home', () => {
    const dir = workspaceWith({ ...IN_FLIGHT });
    const original = config.getWorkspace();
    config.setWorkspace(dir);
    try {
      recordControlReturnedTo('c1', 'chief-of-staff');  // the conversation's own agent
    } finally {
      config.setWorkspace(original);
    }
    const { stored } = load(dir);
    assert.strictEqual(stored[0].delegationReturned, true);
    assert.strictEqual(stored[0].activeAgentId, 'chief-of-staff',
      'control reached the base agent, so the conversation is reconciled');
  });

  test('the rule reads that record the same way', () => {
    assert.strictEqual(
      restoredActiveAgentId({ agentId: 'chief-of-staff', activeAgentId: 'content-lead', delegationReturned: false }),
      'content-lead', 'still delegated: the next message goes to whoever holds it');
  });
});

