'use strict';
// A routine runs as the agent it belongs to.
//
// Claude Code loads an agent's file, and applies that file's `tools:` line,
// only when it is started with --agent and the agent's frontmatter name. A
// conversation has always done that, guarded on the agent having a file. A
// routine did something else: it passed the roster id, and skipped the flag
// when the id was 'default'.
//
// 'default' does not mean "no agent file". discoverAgents gives that id to
// whichever agent the workspace marks as its default, which is normally the
// orchestrator, whose file is real. So an orchestrator's routines ran as a
// plain session: no instructions from its file, and a `tools:` line that
// limited its conversations and did nothing at all to its routines. Nothing
// reported it, because a plain session is a working session.
//
// The two questions are separate, which is what the old condition blurred. Is
// there a file to load? `fileName`. What does Claude Code call it? `name`.
// Every assertion here reads a real child's argument list, because the flag is
// the whole of what decides this.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');
const scheduler = require('../../lib/scheduler.js');
const { invalidateAgentCache } = require('../../lib/agents/discovery.js');

const LEAD = 'team-lead';      // order 0, so its roster id is 'default'
const WRITER = 'writer';       // file name and frontmatter name agree
const KEEPER = 'note-keeper';  // lives in a file with another name

function dayAt(day, hour, minute) { return new Date(2026, 6, day, hour, minute, 0); }

const clock = { at: dayAt(1, 7, 30) };
let prevDeps = null;
let client;

const agentFlag = (argv) => (argv.includes('--agent') ? argv[argv.indexOf('--agent') + 1] : null);

before(async () => {
  await h.boot({
    agents: {
      [LEAD]: agentFile({
        name: LEAD, type: 'orchestrator', order: 0,
        routines: [{ name: 'brief', schedule: 'every day at 07:00', prompt: 'lead brief', enabled: true }],
      }),
      [WRITER]: agentFile({
        name: WRITER, type: 'specialist', order: 1, reportsTo: LEAD,
        routines: [{ name: 'sweep', schedule: 'every day at 07:00', prompt: 'writer sweep', enabled: true }],
      }),
      'keeper-file': agentFile({
        name: KEEPER, type: 'specialist', order: 2, reportsTo: LEAD,
        routines: [{ name: 'tidy', schedule: 'every day at 07:00', prompt: 'keeper tidy', enabled: true }],
      }),
    },
  });
  h.writeScenario([{ match: {}, turn: [{ text: 'done.' }] }]);
  prevDeps = scheduler.wireSchedulerDeps({ now: () => clock.at });
  h.internal.stopScheduler();
  client = await h.connect();
});

after(async () => {
  if (prevDeps) scheduler.wireSchedulerDeps(prevDeps);
  await h.shutdown();
});

// The child the routine with this prompt started. The prompt is the last
// argument, so a spawn is identified by what it was asked to do rather than by
// a flag this file is asserting about.
async function spawnFor(prompt, previous = 0) {
  const matching = () => h.readInvocations().filter(i => Array.isArray(i.argv) && i.argv[i.argv.length - 1] === prompt);
  assert.ok(await h.waitUntil(() => matching().length > previous, 10000), `a child was started for "${prompt}"`);
  return matching()[previous];
}

function settle(key) {
  return h.waitUntil(() => !scheduler.runningRuns().some(r => r.key === key), 10000);
}

test('the agent that orchestrates keeps the id default, which is what made this easy to get wrong', () => {
  const lead = h.internal.discoverAgents().find(a => a.name === LEAD);
  assert.strictEqual(lead.id, 'default');
  assert.ok(lead.fileName, 'and it has a real file');
});

test('a scheduled run of the orchestrator starts as the orchestrator', async (t) => {
  h.clearInvocations();
  clock.at = dayAt(1, 7, 30);
  t.mock.timers.enable({ apis: ['setInterval'] });
  try {
    h.internal.startScheduler();
    t.mock.timers.tick(60_000);
  } finally {
    h.internal.stopScheduler();
    t.mock.timers.reset();
  }
  const spawn = await spawnFor('lead brief');
  assert.strictEqual(agentFlag(spawn.argv), LEAD, 'the name Claude Code knows it by, never the roster id');
  assert.ok(!spawn.argv.includes('default'), 'the roster id means nothing to Claude Code');
  await settle('default:brief');
});

test('a pressed run does the same, and so does pressing it again', async () => {
  h.clearInvocations();
  for (const previous of [0, 1]) {
    client.send({ type: 'run_routine_now', agentId: 'default', name: 'brief', occurrence: 0 });
    const spawn = await spawnFor('lead brief', previous);
    assert.strictEqual(agentFlag(spawn.argv), LEAD);
    await settle('default:brief');
  }
});

test('a specialist whose file is named after it is unchanged', async () => {
  h.clearInvocations();
  client.send({ type: 'run_routine_now', agentId: WRITER, name: 'sweep', occurrence: 0 });
  assert.strictEqual(agentFlag((await spawnFor('writer sweep')).argv), WRITER);
  await settle(`${WRITER}:sweep`);
});

test('a specialist in a differently named file is started by its name, not by its file', async () => {
  h.clearInvocations();
  client.send({ type: 'run_routine_now', agentId: 'keeper-file', name: 'tidy', occurrence: 0 });
  assert.strictEqual(agentFlag((await spawnFor('keeper tidy')).argv), KEEPER);
  await settle('keeper-file:tidy');
});

test('a routine and a conversation name the same agent the same way', async () => {
  for (const [rosterId, routine, prompt] of [['default', 'brief', 'lead brief'], ['keeper-file', 'tidy', 'keeper tidy']]) {
    h.clearInvocations();
    const convoId = h.freshConvoId('flag');
    client.send({ type: 'chat', conversationId: convoId, agent: rosterId, content: 'hello' });
    await client.waitForEvent('system', 'done', convoId);
    const conversation = h.readInvocations().find(i => !i.print);
    client.send({ type: 'run_routine_now', agentId: rosterId, name: routine, occurrence: 0 });
    const run = await spawnFor(prompt);
    assert.strictEqual(agentFlag(run.argv), agentFlag(conversation.argv), `${rosterId} is one agent on both paths`);
    await settle(`${rosterId}:${routine}`);
    h.reapConvo(convoId);
  }
});

// LAST, because it takes the team's files away. The fallback is what a
// workspace with a CLAUDE.md and no agents gets, and there is no file for
// Claude Code to find under that name. Its roster entry declares no routines
// today, so nothing can reach this through the tick; it is asserted on the
// spawn itself so that stays true if that ever changes.
test('the fallback agent, which has no file, passes no flag at all', async () => {
  const dir = path.join(h.workspaceDir, '.claude', 'agents');
  for (const file of fs.readdirSync(dir)) fs.rmSync(path.join(dir, file));
  invalidateAgentCache();

  const fallback = h.internal.discoverAgents().find(a => a.isDefault);
  assert.strictEqual(fallback.id, 'default');
  assert.strictEqual(fallback.name, 'default', 'the same id and, this time, the same name');
  assert.strictEqual(fallback.fileName, null);

  h.clearInvocations();
  h.internal.executeRoutine(fallback, { name: 'bare', schedule: 'every day at 07:00', prompt: 'bare run' }, 'default:bare');
  const spawn = await spawnFor('bare run');
  assert.strictEqual(agentFlag(spawn.argv), null);
  await settle('default:bare');
});
