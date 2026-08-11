'use strict';
// One team-membership rule: the org chart, the prompt roster, and the
// delegation matcher must agree about who is on the orchestrator's team.
//
// Live incident (2026-08-12, synthetic user testing with a real model): a
// hand-authored specialist with no reportsTo was shown under the orchestrator
// on the org chart AND listed in the orchestrator's prompt roster ("Only
// delegate to agents in YOUR TEAM below"), but findDirectReportMatch had no
// fallback for it, so the delegation the system prompt instructed was refused
// and the off-roster guard then BLOCKED it with a corrective message. The
// user was told to route through "Kit's leader": a leader that does not
// exist. One missing frontmatter line produced a dead end, with the chart
// visually promising the opposite.
//
// The workspace here mirrors the incident exactly: an order-0 orchestrator
// (which therefore becomes agent id `default`) and a specialist with no
// reportsTo line.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');

const ROO = `---
name: roo
displayName: Roo
role: Chief of Staff
type: orchestrator
order: 0
model: sonnet
---
You are Roo, the orchestrator.
`;
const KIT = `---
name: kit
displayName: Kit
role: Customer Support
type: specialist
order: 2
model: sonnet
---
You are Kit, customer support. No reportsTo line, exactly like a hand-authored file.
`;

let client;
before(async () => {
  await h.boot({ agents: { roo: ROO, kit: KIT } });
  client = await h.connect();
});
after(async () => h.shutdown());

describe('one team-membership rule', () => {
  test('roster, matcher, and off-roster guard agree: a reportsTo-less onTeam specialist belongs to the orchestrator', () => {
    const srv = h.internal;
    const roster = srv.buildTeamRoster('default');
    assert.ok(roster && roster.includes('Kit'), 'prompt roster lists the specialist (backward-compat fallback)');
    const match = srv.findDirectReportMatch('default', { subagent_type: 'kit' });
    assert.ok(match && match.name === 'kit', 'the matcher must agree with the roster it instructed');
    const off = srv.findOffRosterWorkspaceMatch('default', { subagent_type: 'kit' });
    assert.strictEqual(off, null, 'the off-roster guard must not block an agent the roster offered');
  });

  test('the orchestrator can actually delegate to a reportsTo-less specialist (the observed dead end, replayed)', async () => {
    const convoId = h.freshConvoId('membership');
    h.clearInvocations();
    h.writeScenario([
      { match: { agent: 'roo', promptIncludes: 'route this to kit please' },
        realStream: true,
        turn: [
          { text: 'Handing to Kit.' },
          { agentTool: { subagent_type: 'kit', prompt: 'membership brief for kit' } },
        ] },
      { match: { agent: 'kit', promptIncludes: 'membership brief for kit' },
        turn: [{ text: 'Kit here, handling the refund question.' }] },
    ]);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'default', content: 'route this to kit please' });
    try {
      await client.waitFor(m => m.type === 'system' && m.subtype === 'agent_switch'
        && m._conversationId === convoId && m.toAgent === 'kit',
        { since, label: 'delegation to the reportsTo-less specialist fires' });
      const { msg } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId
        && m._agent === 'kit', { since, label: 'Kit result' });
      assert.ok(msg.result.includes('Kit here'), 'Kit actually ran');
      const blocked = client.messages.slice(since).find(m => m.subtype === 'info' && /Blocked a handoff/.test(m.content || ''));
      assert.strictEqual(blocked, undefined, 'no block message: the guard and the roster agree');
    } finally {
      h.reapConvo(convoId);
    }
  });

  test('an external edit to .claude/agents flags live orchestrators for roster refresh', async () => {
    // Today only in-app CRUD calls flagRosterRefresh, so a hand edit outside
    // Rundock leaves a long-lived process on a stale prompt roster. The
    // agents directory is now watched; this pins it.
    const convoId = h.freshConvoId('watcher');
    h.writeScenario([
      { match: { agent: 'roo', promptIncludes: 'idle turn please' },
        turn: [{ text: 'Idling.' }] },
    ]);
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'default', content: 'idle turn please' });
    await client.waitFor(m => m.type === 'result' && m._conversationId === convoId, { since, label: 'idle turn result' });
    const entry = h.internal.chatProcesses.get(convoId);
    assert.ok(entry && !entry.needsRosterRefresh, 'no refresh flag before the edit');

    // The external edit: a new agent file written straight to disk.
    fs.writeFileSync(path.join(h.workspaceDir, '.claude', 'agents', 'newbie.md'),
      '---\nname: newbie\ndisplayName: Newbie\nrole: New Agent\ntype: specialist\norder: 5\nreportsTo: roo\n---\nYou are Newbie.\n');

    const flagged = await h.waitUntil(() => entry.needsRosterRefresh === true, { timeout: 5000 });
    h.reapConvo(convoId);
    assert.ok(flagged, 'live orchestrator flagged for roster refresh after an external edit to .claude/agents');
  });
});

describe('setup completes when the team exists, however the files arrived', () => {
  // The setupComplete flip lived only in the save_agent WS handler (the
  // marker path). A Doc that creates the team with the Write tool, or a user
  // who drops agent files in place, got a working team while the workspace
  // stayed "setup pending" forever: the client kept offering "Set up your
  // team" and onboarding routing never exited setup mode. Found by the live
  // New User persona (a creation turn saying "Writing a file...") plus code
  // reading, 2026-08-11.
  const statePath = () => path.join(h.workspaceDir, '.rundock', 'state.json');
  const readSetup = () => {
    try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')).setupComplete; }
    catch { return undefined; }
  };
  const seedPending = () => {
    const state = (() => { try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return {}; } })();
    fs.writeFileSync(statePath(), JSON.stringify({ ...state, setupComplete: false }));
  };

  test('an agent file written straight to disk flips setup within one watcher poll', async () => {
    seedPending();
    fs.writeFileSync(path.join(h.workspaceDir, '.claude', 'agents', 'dropped-in.md'),
      '---\nname: dropped-in\ndisplayName: Dropped In\nrole: Hand-authored\ntype: specialist\norder: 6\nreportsTo: roo\n---\nYou are Dropped In.\n');
    const flipped = await h.waitUntil(() => readSetup() === true, { timeout: 6000 });
    assert.ok(flipped, 'setupComplete flips when the on-disk team gains a non-platform agent');
  });

  test('a platform-only roster never flips setup', () => {
    seedPending();
    const flip = h.internal.maybeCompleteSetup;
    assert.strictEqual(typeof flip, 'function', 'the flip is one extracted helper');
    flip([
      { id: 'rundock-guide', status: 'onTeam', type: 'platform' },
      { id: 'other-platform', status: 'onTeam', type: 'platform' },
    ]);
    assert.strictEqual(readSetup(), false, 'platform agents alone are not a team');
    flip([
      { id: 'rundock-guide', status: 'onTeam', type: 'platform' },
      { id: 'cos', status: 'onTeam', type: 'orchestrator' },
    ]);
    assert.strictEqual(readSetup(), true, 'a real team member flips it');
  });
});
