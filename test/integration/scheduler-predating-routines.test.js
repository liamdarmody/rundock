'use strict';
// The day Rundock first runs over a workspace whose routines predate it.
//
// THE SHAPE THIS FILE IS BUILT AROUND. Somebody has five routines in agent
// frontmatter, driven by real cron, on a machine where this product has never
// run: no run records, no routine-state.json, no routine-slots.json, and no
// `enabled` key on any of the five, because nothing had ever offered them one.
// All five use schedules the parser accepts. The upgrade that makes the
// scheduler work is the moment all five become live, alongside the cron jobs
// already doing the work, and the morning briefing goes out twice.
//
// WHY THIS IS A SEPARATE FILE FROM scheduler-gating. That file asks whether one
// field refuses one routine, with the field written into the fixture. This asks
// what an UPGRADE does to a workspace nobody has touched: several routines at
// once, none of them carrying the field, arriving at a scheduler that now
// works. The first question is about a gate and the second is about a
// migration meeting a gate, and only the second can catch a fix that flips the
// value the migration fills in while leaving the reader where it was.
//
// EVERY TEST HERE FIRES A CONTROL BESIDE ITS SILENCE. "Nothing ran" is the
// absence of something, and absence is satisfied by a scheduler that was never
// going to run anything. The control declares `enabled: true` in its own
// frontmatter, so it is the one routine here whose file was written after this
// product could run one.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');

const scheduler = require('../../lib/scheduler.js');
const { invalidateAgentCache } = require('../../lib/agents/discovery.js');

// Wednesday 2026-07-01, late enough that every routine below is due. A single
// instant for all five is the point: the upgrade does not arrive one routine at
// a time.
const LATE = new Date(2026, 6, 1, 23, 30, 0);
// A second evening, for the test that needs a tick of its own after a file has
// been written under the running server.
const NEXT_LATE = new Date(2026, 6, 2, 23, 30, 0);

// The five, exactly as an author would have written them before this release:
// a name, a schedule, a prompt, and nothing else.
const PREDATING = [
  ['briefer', 'morning-briefing', 'every day at 07:00'],
  ['sweeper', 'nightly-sweep', 'every day at 22:00'],
  ['filer', 'inbox-file', 'every day at 12:00'],
  ['reviewer', 'weekly-review', 'every wednesday at 16:00'],
  ['poster', 'digest-post', 'every day at 18:00'],
];
const KEYS = PREDATING.map(([agent, name]) => `${agent}:${name}`);
const CONTROL = 'worker:ordinary-check';

function predatingAgents() {
  const out = {};
  PREDATING.forEach(([agent, name, schedule], i) => {
    out[agent] = agentFile({
      name: agent, type: 'specialist', order: i + 1,
      routines: [{ name, schedule, prompt: `${name} body` }],
    });
  });
  // The control, and the only routine in this workspace whose file says
  // whether it may run.
  out.worker = agentFile({
    name: 'worker', type: 'specialist', order: 9,
    routines: [{ name: 'ordinary-check', schedule: 'every day at 08:00', prompt: 'ordinary body', enabled: true }],
  });
  return out;
}

const clock = { at: LATE };
let prevDeps = null;

before(async () => {
  await h.boot({ agents: predatingAgents() });
  prevDeps = scheduler.wireSchedulerDeps({ now: () => clock.at });
});

after(async () => {
  if (prevDeps) scheduler.wireSchedulerDeps(prevDeps);
  await h.shutdown();
});

// One tick of the real scheduler with the console captured, exactly as
// scheduler-gating drives it: the server armed a tick at boot, so the real one
// is stopped before the mocked one this drives is armed.
function driveTick(t, ticks = 1) {
  const logs = [];
  const realLog = console.log;
  const realError = console.error;
  h.internal.stopScheduler();
  t.mock.timers.enable({ apis: ['setInterval'] });
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));
  try {
    h.internal.startScheduler();
    for (let i = 0; i < ticks; i++) t.mock.timers.tick(60_000);
  } finally {
    console.log = realLog;
    console.error = realError;
    h.internal.stopScheduler();
    t.mock.timers.reset();
  }
  return logs;
}

function armControl() {
  h.writeScenario([
    { match: { agent: 'worker', promptIncludes: 'ordinary body' }, turn: [{ text: 'routine ran' }] },
  ]);
  delete h.internal.routineState[CONTROL];
}

// The proof the tick just driven was live, taken from the line that tick wrote
// rather than from stored state an earlier drive could have left.
function assertControlFiredOnThisTick(logs) {
  assert.ok(logs.some(l => l.includes('Running routine') && l.includes('ordinary-check')),
    'the tick just driven announced the control as running, so that tick was live');
  const state = h.internal.routineState[CONTROL];
  assert.ok(state, 'the control ran');
  assert.strictEqual(state.lastRun, clock.at.toISOString(),
    'and its run belongs to this drive rather than to an earlier one');
}

function settleControl() {
  return h.waitUntil(() => {
    const s = h.internal.routineState[CONTROL];
    return s && s.status !== 'running';
  });
}

// AC-6. The upgrade, driven end to end: five routines that predate the
// scheduler, a real tick past every one of their times, and nothing started.
test('upgrading a workspace of routines that predate the scheduler starts none of them', async (t) => {
  clock.at = LATE;
  armControl();

  // The state this workspace is actually in on the day of the upgrade,
  // asserted rather than assumed. A stored run for any of the five would
  // suppress it on its own and this test would pass without the gate.
  for (const key of KEYS) {
    assert.strictEqual(h.internal.routineState[key], undefined,
      `${key} already carries a run, so its silence would prove nothing`);
  }

  const logs = driveTick(t);

  for (const [agent, name] of PREDATING) {
    const key = `${agent}:${name}`;
    assert.strictEqual(h.internal.routineState[key], undefined,
      `${key} ran on the upgrade, next to the cron job still doing the same work`);
    assert.ok(!logs.some(l => l.includes('Running routine') && l.includes(name)),
      `${key} was announced as running`);
    // Named by the field that refused it, so "it did not run" is an answer
    // rather than a support question.
    assert.ok(logs.some(l => l.includes(name) && l.includes('enabled is false')),
      `${key} was refused without saying which field decided`);
  }
  assertControlFiredOnThisTick(logs);

  await settleControl();
});

// AC-1, from the other side: the upgrade is a pause, not a deletion. Turning
// one on is all it takes, and nothing else about the routine had to change.
test('a routine that predates the scheduler runs once somebody turns it on', async (t) => {
  clock.at = NEXT_LATE;
  armControl();
  h.writeScenario([
    { match: { agent: 'worker', promptIncludes: 'ordinary body' }, turn: [{ text: 'routine ran' }] },
    { match: { agent: 'filer', promptIncludes: 'inbox-file body' }, turn: [{ text: 'routine ran' }] },
  ]);

  // PRESSED, NOT WRITTEN BY HAND. Rewriting the agent file here would prove
  // the scheduler reads the field and nothing about the act a person performs.
  // The handler is unit tested and the tick is driven here, but neither covers
  // the two agreeing: the message goes through the server, the file is
  // rewritten by the handler that owns that write, and the tick then reads
  // whatever it left behind.
  const client = await h.connect();
  client.send({
    type: 'set_routine_enabled', agentId: 'filer', name: 'inbox-file',
    occurrence: 0, enabled: true,
  });
  await client.waitFor(m => m.type === 'routine_enabled', { label: 'the routine being turned on' });
  invalidateAgentCache();

  driveTick(t);

  await h.waitUntil(() => {
    const s = h.internal.routineState['filer:inbox-file'];
    return s && s.status !== 'running';
  });
  assert.strictEqual(h.internal.routineState['filer:inbox-file'].status, 'completed',
    'the routine the upgrade held back ran as soon as its file said it may');

  await settleControl();
  client.ws.close();
});

// AC-4. THE CRITERION THIS FILE EXISTS FOR.
//
// The migration returns migrated content whether or not its write lands, by
// deliberate design, so that a workspace nobody can write to still runs. This
// covers that path: the routine is refused on a workspace where nothing about
// the decision could be recorded.
//
// WHAT IT DOES NOT PROVE, said here so nothing leans on it. Discovery parses
// whatever the migration returns, landed or not, so this drive cannot tell a
// fix made in the reader from one made in the migration. The reader's own
// default is pinned by the direct normalizeRoutine assertions in
// test/unit/routine-model.test.js.
//
// So this is driven against a file that genuinely cannot be written, and both
// halves are asserted: the routine did not fire, AND the write really did fail,
// because a test where the migration quietly succeeded is a test of the
// ordinary path wearing this one's name.
//
// The file is written and made read-only BEFORE anything discovers it, which is
// why this agent arrives under the running server rather than in the boot
// fixture: a file the boot already migrated would be read back carrying the key
// and would prove nothing about a workspace that cannot record one.
test('a routine in a workspace that cannot be written to does not fire either', async (t) => {
  clock.at = NEXT_LATE;
  armControl();
  const file = path.join(h.workspaceDir, '.claude', 'agents', 'frozen.md');
  const content = agentFile({
    name: 'frozen', type: 'specialist', order: 10,
    routines: [{ name: 'frozen-check', schedule: 'every day at 06:00', prompt: 'frozen body' }],
  });
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o444);
  invalidateAgentCache();

  let logs;
  try {
    logs = driveTick(t);
  } finally {
    fs.chmodSync(file, 0o644);
  }

  // The precondition. If this file had been rewritten, the run below would be
  // the migrated path and this test would be a duplicate of the one above.
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), content,
    'the file was rewritten, so this was not an unwritable workspace');
  assert.ok(logs.some(l => l.includes('[migrate]') && /persist failed/.test(l)),
    `the migrating write did not fail, so nothing here was proven. Saw: ${JSON.stringify(logs.filter(l => l.includes('migrate')))}`);

  assert.strictEqual(h.internal.routineState['frozen:frozen-check'], undefined,
    'a routine nobody can record a decision about fired anyway');
  assert.ok(!logs.some(l => l.includes('Running routine') && l.includes('frozen-check')),
    'the routine in the unwritable workspace was announced as running');
  assert.ok(logs.some(l => l.includes('frozen-check') && l.includes('enabled is false')),
    'the refusal did not name the field that decided');
  assertControlFiredOnThisTick(logs);

  await settleControl();
});

// AC-4 again, one call earlier. The test above makes one FILE read-only, so the
// migration's backup copy succeeds and the final write is what fails. A
// read-only DIRECTORY, which is what a read-only checkout actually is, fails at
// the backup copy instead. Both land in the same catch and both leave the
// reader's answer to do the work, but that equivalence is a claim about the
// migration's control flow rather than something anything here drove, and a
// claim like that is exactly what stops being true without a test noticing.
test('a workspace whose agents directory cannot be written to does not fire either', async (t) => {
  clock.at = NEXT_LATE;
  armControl();
  const dir = path.join(h.workspaceDir, '.claude', 'agents');
  const file = path.join(dir, 'sealed.md');
  const content = agentFile({
    name: 'sealed', type: 'specialist', order: 11,
    routines: [{ name: 'sealed-check', schedule: 'every day at 06:00', prompt: 'sealed body' }],
  });
  fs.writeFileSync(file, content);
  const mode = fs.statSync(dir).mode;
  fs.chmodSync(dir, 0o555);
  invalidateAgentCache();

  let logs;
  try {
    logs = driveTick(t);
  } finally {
    fs.chmodSync(dir, mode);
  }

  assert.strictEqual(fs.readFileSync(file, 'utf-8'), content,
    'the file was rewritten, so the directory was not actually sealed');
  // The proof that this drove the EARLIER call rather than repeating the test
  // above: with a sealed directory the snapshot cannot be created at all.
  assert.ok(!fs.existsSync(file + '.pre-routine-model-backup'),
    'the backup landed, so the failure was the write rather than the copy');
  assert.ok(logs.some(l => l.includes('[migrate]') && /persist failed/.test(l)),
    `the migrating write did not fail, so nothing here was proven. Saw: ${JSON.stringify(logs.filter(l => l.includes('migrate')))}`);

  assert.strictEqual(h.internal.routineState['sealed:sealed-check'], undefined,
    'a routine in a sealed workspace fired anyway');
  assert.ok(logs.some(l => l.includes('sealed-check') && l.includes('enabled is false')),
    'the refusal did not name the field that decided');
  assertControlFiredOnThisTick(logs);

  await settleControl();
});

// AC-2. THE OTHER SIDE OF THE SAME RULE, and the one a fix for AC-1 is most
// likely to break on its way past.
//
// The reader who has just been told their five old routines are held back must
// not find the same thing happening to the routine they make next. A routine
// created through the editor carries `enabled` explicitly from birth, so it is
// live the moment it is saved and there is no second act: no switch to find, no
// second visit to this list.
//
// DRIVEN THROUGH THE EDITOR'S OWN SAVE PATH AND THEN THROUGH A REAL TICK,
// rather than asserted off the writer. `appendRoutineBlock` writing the key is
// what makes this true, and a unit test of it says nothing about whether the
// scheduler then runs the thing: the two are separated by a file, a migration
// and a gate, which is exactly where a routine created live could stop being
// live without a single test noticing.
test('a routine created in the editor is live without a second act', async (t) => {
  clock.at = NEXT_LATE;
  armControl();
  const client = await h.connect();
  h.writeScenario([
    { match: { agent: 'worker', promptIncludes: 'ordinary body' }, turn: [{ text: 'routine ran' }] },
    { match: { agent: 'briefer', promptIncludes: 'brand new body' }, turn: [{ text: 'routine ran' }] },
  ]);

  client.send({
    type: 'save_routine',
    agentId: 'briefer',
    routine: {
      name: 'brand-new', schedule: 'every day at 05:00',
      prompt: 'brand new body', runOn: 'local',
    },
  });
  await client.waitFor(m => m.type === 'routine_saved', { label: 'the routine being saved' });

  // The file says so out loud, which is what makes it live rather than merely
  // untouched by the migration.
  const file = path.join(h.workspaceDir, '.claude', 'agents', 'briefer.md');
  assert.match(fs.readFileSync(file, 'utf-8'), /name: brand-new[\s\S]*?enabled: true/,
    'the editor wrote a routine without saying whether it may run');

  invalidateAgentCache();
  driveTick(t);

  await h.waitUntil(() => {
    const s = h.internal.routineState['briefer:brand-new'];
    return s && s.status !== 'running';
  });
  assert.strictEqual(h.internal.routineState['briefer:brand-new'].status, 'completed',
    'a routine made a moment ago did not run, so making one now needs a second act');

  await settleControl();
  client.ws.close();
});
