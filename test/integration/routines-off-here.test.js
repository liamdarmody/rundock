'use strict';
// Routines turned off on this computer, for one workspace, driven tick by tick
// on the real server.
//
// The switch changes through the server's one route, from a window, and the
// scheduler reads the record on every tick: so while it is off no daily,
// weekly or monthly routine fires, nothing that passes is recorded as missed
// or owed, and the scheduler's suppression file is not written for those
// slots. Run now still works and says it was manual. Turning it back on is
// turning a routine on: a daily or weekly slot still inside its day runs
// shortly after, and a monthly slot that passed while off is not run.
//
// Setup is the scheduler-monthly template: stop the boot-armed tick, mock
// setInterval, start, and move the scheduler's own clock between ticks. Every
// instant is a fixed local time under an explicit zone.
process.env.TZ = 'Europe/London';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile, makeWorkspace } = require('../helpers/workspace.js');
const { seenHere } = require('../helpers/approvals.js');

const scheduler = require('../../lib/scheduler.js');
const config = require('../../lib/config.js');
const routinesHere = require('../../lib/agents/routines-here.js');
const { invalidateAgentCache, discoverAgents } = require('../../lib/agents/discovery.js');

// One routine per agent, each on its own shape. 1 October 2026 is a
// Thursday, so the weekly routine's day is the 15th's weekday too.
const ROUTINES = {
  daily: { name: 'report', prompt: 'daily report body', schedule: 'every day at 07:00' },
  weekly: { name: 'report', prompt: 'weekly report body', schedule: 'every thursday at 07:00' },
  monthly: { name: 'report', prompt: 'monthly report body', schedule: 'on day 15 of every month at 09:00' },
};
const SLUGS = Object.keys(ROUTINES);
const KEYS = Object.fromEntries(SLUGS.map(slug => [slug, `${slug}:report`]));

const at = (month, day, hour = 0, minute = 0) => new Date(2026, month - 1, day, hour, minute, 0);

const clock = { at: at(10, 1) };
let prevDeps = null;
let previousName = null;

function fileFor(slug, fields = {}) {
  const r = ROUTINES[slug];
  return agentFile({
    name: slug, type: 'specialist', order: SLUGS.indexOf(slug) + 1,
    routines: [{ name: r.name, schedule: r.schedule, prompt: r.prompt, enabled: true, ...fields }],
  });
}

before(async () => {
  await h.boot({ agents: Object.fromEntries(SLUGS.map(slug => [slug, fileFor(slug)])) });
  h.writeScenario(SLUGS.map(slug => ({
    match: { agent: slug, promptIncludes: ROUTINES[slug].prompt }, turn: [{ text: `${slug} ran` }],
  })));
  prevDeps = scheduler.wireSchedulerDeps({ now: () => clock.at });
  // A made-up computer name: nothing here names the machine it runs on.
  previousName = routinesHere.wireHostname(() => 'quartz-desk');
});

after(async () => {
  if (prevDeps) scheduler.wireSchedulerDeps(prevDeps);
  if (previousName) routinesHere.wireHostname(previousName);
  await h.shutdown();
});

const stateFile = () => path.join(h.workspaceDir, '.rundock', 'routine-state.json');

// Everything the scheduler remembers, on disk and in memory, dropped so each
// test starts from a machine that has never seen these routines, with
// routines on.
function resetTimeline() {
  h.internal.stopScheduler();
  if (config.getWorkspace() !== h.workspaceDir) h.internal.setWorkspace(h.workspaceDir);
  h.internal.stopScheduler();
  routinesHere.setOffHere(h.workspaceDir, false);
  for (const slug of SLUGS) {
    fs.writeFileSync(path.join(h.workspaceDir, '.claude', 'agents', `${slug}.md`), fileFor(slug));
  }
  invalidateAgentCache();
  for (const key of Object.values(KEYS)) delete h.internal.routineState[key];
  h.internal.routineSlots.observedAt = null;
  for (const k of Object.keys(h.internal.routineSlots.routines)) delete h.internal.routineSlots.routines[k];
  for (const file of ['routine-state.json', 'routine-slots.json']) {
    fs.rmSync(path.join(h.workspaceDir, '.rundock', file), { force: true });
  }
  fs.rmSync(path.join(h.workspaceDir, '.rundock', 'runs'), { recursive: true, force: true });
  h.clearPrompts();
}

const runs = (slug) => h.promptsFor(slug).filter(p => p.includes(ROUTINES[slug].prompt)).length;
const entry = (slug) => h.internal.routineSlots.routines[KEYS[slug]];
const missed = (slug) => (entry(slug) ? entry(slug).missed.map(m => m.slot) : []);
const recordsFor = (slug) => scheduler.readRunRecords().filter(r => r.agent === slug);
const stateKeysOnDisk = () => {
  if (!fs.existsSync(stateFile())) return [];
  return Object.keys(JSON.parse(fs.readFileSync(stateFile(), 'utf-8'))).filter(k => Object.values(KEYS).includes(k));
};

/** What the row is told: the routine as the roster carries it. */
function row(slug) {
  invalidateAgentCache();
  return discoverAgents().find(a => a.id === slug).routines[0];
}

/** One tick at `when`, and wait for any run it started to reach its outcome. */
async function tickAt(t, when) {
  clock.at = when;
  t.mock.timers.tick(60_000);
  await h.waitUntil(() => scheduler.runningRuns().length === 0
    && Object.values(KEYS).every(k => !h.internal.routineState[k] || h.internal.routineState[k].status !== 'running'));
}

async function withTicks(t, fn) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  try {
    h.internal.startScheduler();
    await fn();
  } finally {
    h.internal.stopScheduler();
    t.mock.timers.reset();
  }
}

/** Press the switch from a window, and wait for the answer every window gets. */
async function setFrom(client, on) {
  const since = client.messages.length;
  client.send({ type: 'set_routines_here', on, workspace: config.getWorkspace() });
  const { msg } = await client.waitFor(m => m.type === 'agents' && m.routinesHere && m.routinesHere.off === !on,
    { since, label: `the roster saying routines are ${on ? 'on' : 'off'} here` });
  return msg;
}

// Every file in a folder, with its bytes.
function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = path.join(rel, e.name);
      if (e.isDirectory()) walk(child);
      else out[child] = fs.readFileSync(path.join(dir, child)).toString('base64');
    }
  };
  walk('');
  return out;
}

// ===== WHILE OFF =====

test('while off, no daily, weekly or monthly routine fires, and nothing is missed, owed or suppressed', async (t) => {
  resetTimeline();
  const client = await h.connect();
  await withTicks(t, async () => {
    await tickAt(t, at(10, 5, 6));

    // Turned off from a window. The workspace is byte for byte as it was.
    const before = snapshot(h.workspaceDir);
    const roster = await setFrom(client, false);
    assert.deepStrictEqual(roster.routinesHere, { off: true, computer: 'quartz-desk' });
    assert.deepStrictEqual(snapshot(h.workspaceDir), before, 'turning routines off wrote into the workspace');

    // Daily and weekly due on the 8th (a Thursday), the monthly on the 15th
    // (a Thursday too), and every tick between.
    for (const when of [at(10, 6, 7), at(10, 8, 7), at(10, 8, 12), at(10, 14, 23, 59),
      at(10, 15, 7), at(10, 15, 9), at(10, 15, 9, 1), at(10, 31, 23, 59)]) {
      await tickAt(t, when);
    }
    for (const slug of SLUGS) {
      assert.strictEqual(runs(slug), 0, `the ${slug} routine fired while routines were off here`);
      assert.deepStrictEqual(missed(slug), [], `the ${slug} routine's slots were recorded as missed`);
      assert.strictEqual(recordsFor(slug).length, 0, `the ${slug} routine has a run record`);
      assert.strictEqual(h.internal.routineState[KEYS[slug]], undefined, `the ${slug} routine's suppression was written`);
      assert.strictEqual(row(slug).missedSlot, null, `the ${slug} row says Missed`);
    }
    assert.deepStrictEqual(stateKeysOnDisk(), [], 'the suppression file names a slot that passed while off');
  });
});

test('the switch takes effect at the next tick, with no restart', async (t) => {
  resetTimeline();
  const client = await h.connect();
  await withTicks(t, async () => {
    await tickAt(t, at(10, 6, 6));
    await setFrom(client, false);
    // The tick that was armed before the switch moved is the one that obeys it.
    await tickAt(t, at(10, 6, 7));
    assert.strictEqual(runs('daily'), 0);
    await setFrom(client, true);
    await tickAt(t, at(10, 6, 7, 1));
    assert.strictEqual(runs('daily'), 1, 'turned back on, the same tick loop ran it');
  });
});

// ===== RUN NOW =====

test('Run now still works while off, and its record says it was pressed', async (t) => {
  resetTimeline();
  const client = await h.connect();
  await withTicks(t, async () => {
    await tickAt(t, at(10, 5, 6));
    await setFrom(client, false);
    clock.at = at(10, 5, 14);
    const since = client.messages.length;
    client.send({ type: 'run_routine_now', agentId: 'daily', name: 'report', occurrence: 0 });
    await client.waitFor(m => m.type === 'routine_run_started', { since, label: 'routine_run_started' });
    await h.waitUntil(() => scheduler.runningRuns().length === 0 && recordsFor('daily').some(r => r.status !== 'running'));
    assert.strictEqual(runs('daily'), 1, 'the press ran it on this computer');
    const [record] = recordsFor('daily');
    assert.strictEqual(record.trigger, 'manual');
    assert.strictEqual(h.internal.routineState[KEYS.daily], undefined, 'and moved no schedule');
  });
});

// ===== BACK ON =====

test('turned back on, a daily and a weekly slot still inside its day run shortly after, and a monthly one does not', async (t) => {
  resetTimeline();
  const client = await h.connect();
  await withTicks(t, async () => {
    await tickAt(t, at(10, 5, 6));
    await setFrom(client, false);
    for (const when of [at(10, 8, 7), at(10, 12, 7), at(10, 15, 7), at(10, 15, 9), at(10, 15, 10)]) {
      await tickAt(t, when);
    }
    for (const slug of SLUGS) assert.strictEqual(runs(slug), 0, `sanity: the ${slug} routine ran while off`);

    // On at half past ten on the 15th, a Thursday: today's 07:00 daily and
    // weekly slots are still inside their day; the monthly's 09:00 slot passed
    // while off.
    await setFrom(client, true);
    await tickAt(t, at(10, 15, 10, 31));
    assert.strictEqual(runs('daily'), 1, 'the daily routine did not run shortly after');
    assert.strictEqual(runs('weekly'), 1, 'the weekly routine did not run shortly after');
    assert.strictEqual(runs('monthly'), 0, 'the monthly slot that passed while off was run');
    for (const slug of SLUGS) {
      assert.deepStrictEqual(missed(slug), [], `the ${slug} routine shows a slot that passed while off as missed`);
      assert.strictEqual(row(slug).missedSlot, null, `the ${slug} row says Missed`);
    }

    // Open every day to the end of the month, so nothing is missed for being
    // closed: the monthly slot that passed while off stays unrun.
    for (let day = 16; day <= 31; day++) await tickAt(t, at(10, day, 12));
    assert.strictEqual(runs('monthly'), 0, 'the monthly routine carried its slot across the off period');
    assert.deepStrictEqual(missed('monthly'), [], 'the month ended with its off-period slot recorded as missed');

    await tickAt(t, at(11, 15, 9));
    assert.strictEqual(runs('monthly'), 1, "next month's slot runs as it always would");
  });
});

// ===== ANOTHER WORKSPACE, AND BACK =====

test('off in one workspace leaves another on this computer running, and is still off on the way back', async (t) => {
  resetTimeline();
  const other = makeWorkspace({
    agents: { courier: agentFile({ name: 'courier', type: 'specialist', order: 1,
      routines: [{ name: 'report', schedule: 'every day at 07:00', prompt: 'courier report body', enabled: true }] }) },
  });
  fs.writeFileSync(path.join(other, 'stub-scenario.json'), JSON.stringify({
    rules: [{ match: { agent: 'courier', promptIncludes: 'courier report body' }, turn: [{ text: 'courier ran' }] }],
  }));
  seenHere(other);
  const otherRuns = () => h.readAppendedLog(path.join(other, 'stub-prompts.jsonl'))
    .filter(p => p.agent === 'courier' && p.prompt.includes('courier report body')).length;
  const client = await h.connect();
  await withTicks(t, async () => {
    await tickAt(t, at(10, 5, 6));
    await setFrom(client, false);

    h.internal.setWorkspace(other);
    assert.strictEqual(routinesHere.offHere(other), false, 'the other workspace was turned off too');
    await tickAt(t, at(10, 5, 7, 30));
    assert.strictEqual(otherRuns(), 1, 'the other workspace\'s routine did not run');

    h.internal.setWorkspace(h.workspaceDir);
    assert.strictEqual(routinesHere.offHere(h.workspaceDir), true, 'the first workspace came back on');
    await tickAt(t, at(10, 6, 7, 30));
    assert.strictEqual(runs('daily'), 0, 'the first workspace ran a routine on the way back');
    assert.strictEqual(routinesHere.offHere(other), false);
  });
});

// ===== TWO WINDOWS =====

test('two windows see the same state, and both move when either presses', async () => {
  resetTimeline();
  const first = await h.connect();
  const second = await h.connect();
  const sinceSecond = second.messages.length;
  await setFrom(first, false);
  const { msg } = await second.waitFor(m => m.type === 'agents' && m.routinesHere && m.routinesHere.off === true,
    { since: sinceSecond, label: 'the second window told routines are off' });
  assert.strictEqual(msg.workspace, h.workspaceDir);

  const sinceFirst = first.messages.length;
  await setFrom(second, true);
  await first.waitFor(m => m.type === 'agents' && m.routinesHere && m.routinesHere.off === false,
    { since: sinceFirst, label: 'the first window told routines are on' });

  // A window left on another workspace's list cannot change the one open.
  const before = first.messages.length;
  first.send({ type: 'set_routines_here', on: false, workspace: makeWorkspace({}) });
  const refused = await first.waitFor(m => m.type === 'routines_here_failed', { since: before, label: 'the refusal' });
  assert.strictEqual(refused.msg.on, false);
  assert.strictEqual(routinesHere.offHere(h.workspaceDir), false, 'a stale window turned routines off');
});
