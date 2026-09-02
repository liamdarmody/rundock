'use strict';
// The routine scheduler: the 60-second tick (startScheduler), the schedule
// grammar (getNextRun: exactly two shapes, daily and weekly), routine
// execution on both runtimes (executeRoutine), and the persisted routine
// state that stops a restart re-firing a run that already happened
// (routineState + loadRoutineState/saveRoutineState/recordRoutineRun).
//
// routineState is module-owned and exported BY IDENTITY: the scheduler
// mutates it in place and never reassigns, so the root's test re-exports
// and lib/agents/discovery.js (which stamps run state onto rosters) all
// observe the same live object. The workspace root is read at USE time via
// lib/config.js (through rundockDir() for persistence and getWorkspace()
// for routine cwd), so a workspace switch immediately redirects where
// state persists and where routines run.
//
// Beside it sit two stores that are NOT it and must never be read by the
// suppression: the slot records (routineSlots, a slot that passed while nobody
// was watching) and the run records (.rundock/runs/, one file per run, the only
// history this file keeps). Each block says why it is separate where it is
// defined.
//
// The spawn plumbing (spawnClaude/getBareArgs/modelArgs/getSpawnEnv) is a
// direct lib require since its own extraction. The one root-owned
// capability left arrives through wireSchedulerDeps: the WebSocket client
// set as an accessor (the wss is created later at boot). Unwired deps
// throw at first use.
//
// The current time arrives through the SAME wiring, as deps.now(), and it
// is the one dep with a working default rather than a throwing one: nothing
// at boot should have to supply a clock for the scheduler to keep time. It
// shares wireSchedulerDeps because that function already returns the
// previous set for restoration, which is exactly what a test needs, and a
// second wiring shape for one function would be a second thing to learn.
// Every reading of "what time is it now" goes through it; new Date(x) with
// an argument is a conversion rather than a clock read and stays direct.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { getWorkspace } = require('./config.js');
const { rundockDir } = require('./store/persistence.js');
const { recordEvent } = require('./signals.js');
const { buildSystemPrompt } = require('./agents/prompt.js');
const { getCodexAppServer, waitForCodexReady, readAgentInstructions } = require('./runtime/codex-glue.js');
const { discoverAgents } = require('./agents/discovery.js');
const { isRunOnSupported, hasRunnablePrompt } = require('./agents/routines.js');
const { spawnClaude, getBareArgs, modelArgs, getSpawnEnv, killProcessTree } = require('./runtime/claude.js');
const { readSessionTranscript } = require('./runtime/session-transcript.js');

const unwired = (name) => () => {
  throw new Error(`lib/scheduler: ${name} not wired (call wireSchedulerDeps at boot)`);
};
const deps = {
  getWssClients: unwired('getWssClients'),  // () => wss.clients (created at boot)
  now: () => new Date(),                    // the clock seam; defaulted, never unwired
};
function wireSchedulerDeps(next) {
  const prev = { ...deps };
  Object.assign(deps, next);
  return prev;
}

// ===== ROUTINE STATE =====
// In-memory view of routine run state, persisted to .rundock/routine-state.json
// so a server restart cannot re-fire a routine that already ran in its window
// (the desktop quit-and-reopen pattern). The file is workspace-scoped like the
// other .rundock stores; loadRoutineState() runs at startup and on every
// workspace switch.

// `error` is written by one path only, recordFailedStart, and carries the
// reason a start that never became a subprocess gave. Every reader here keeps
// whatever it finds rather than whitelisting fields, which is what lets the
// reason survive the restart it will be read after.
const routineState = {}; // { routineKey: { lastRun, status, duration, error? } }

function loadRoutineState() {
  for (const key of Object.keys(routineState)) delete routineState[key];
  // The runs being dropped here belong to the workspace being left, and so do
  // the announcements. This is the workspace-switch path.
  announcedRefusals.clear();
  // Slot records sit on THIS side of the line, with the run state rather than
  // with the in-flight set. Two reasons, and the second is the stronger. Keys
  // are workspace-local and collide freely, so carrying one workspace's gaps
  // into another files them under a routine that never had them. And while
  // the other workspace was open nobody was watching this one, which is
  // exactly the condition a gap record describes, so its last observation
  // belongs to the workspace and travels with it.
  //
  // Called from here rather than beside each of loadRoutineState's three call
  // sites: one place to remember is one place to forget, and the two stores
  // have the same lifetime for the same reason.
  loadRoutineSlots();
  try {
    const file = path.join(rundockDir(), 'routine-state.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    for (const [key, state] of Object.entries(saved)) {
      if (!state || typeof state.lastRun !== 'string') continue;
      // A run that was 'running' when the server died never finished; surface
      // that honestly. lastRun stays, so the run still suppresses a re-fire
      // (the work was started; firing it again is the bug this file prevents).
      //
      // UNLESS A RUN OF THIS PROCESS ANSWERS FOR IT. This load is also the
      // workspace-switch path, and a switch happens while runs started here
      // are still going. beginRun persists 'running' before the spawn, so on
      // disk a live run is indistinguishable from a dead process's leftovers,
      // and rewriting it reported a run that was still going as cut short:
      // over the socket, to the routines panel and to the agent profile, for
      // the whole length of that run.
      //
      // The in-flight set is the one thing here that can tell the two apart,
      // it is keyed the same way this state is, and it survives this load, for
      // the reason recorded where it is defined. That is the same evidence, in
      // the same load, that an open run record is kept on. It carries that
      // set's limits with it, including the workspace-local key collision
      // named there: a leftover in the new workspace sharing a name with a run
      // still going in the old one is held at 'running' until that run ends.
      // What the collision cannot reach is the field below.
      //
      // NOTHING HERE READS OR WRITES lastRun, which is the only input to
      // double-fire suppression. A live run's stamp is the one its own start
      // wrote and a leftover's is the one on disk, either way untouched by
      // this line.
      if (state.status === 'running' && !inFlight.has(key)) state.status = 'interrupted';
      routineState[key] = state;
    }
  } catch (e) { /* missing or unreadable file: start empty */ }
  // The run records the dead process left open, closed on the same evidence
  // the status rewrite above acts on. Called here rather than folded into that
  // loop because it is a different store: the loop repairs routineState, this
  // repairs the per-run history, they live in separate files, and their keys
  // do not line up (one record per RUN, one state per ROUTINE). Nothing it
  // does is read back into the state.
  closeAbandonedRunRecords();
}

function saveRoutineState() {
  const dir = rundockDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'routine-state.json'), JSON.stringify(routineState, null, 2));
}

// ===== SLOTS THAT PASSED UNSERVED =====
// A record that a scheduled slot went by while nobody was watching. NOT a run
// state: no run happened, so it does not belong in a vocabulary beside
// 'failed', and it must not sit in routineState either.
//
// WHY IT CANNOT LIVE IN routineState. That object is simultaneously the
// display record and the ONLY input to double-fire suppression, read as
// getNextRun(schedule, routineState[key]?.lastRun). Writing a gap into it
// stamps lastRun with the moment the gap was noticed, the daily suppression
// fires on that instant, and the routine loses the catch-up run it was still
// owed today. Not-silently-skipped and not-double-run are the same field
// there, and no naming decision fixes that. So the records live here, in
// their own object and their own file, and nothing in this block is ever
// read by the suppression.
//
// WHAT MAKES DETECTION POSSIBLE. Two things this file never used to keep:
// `due`, the instant each routine is next scheduled for, which used to be a
// local recomputed every tick and thrown away; and `observedAt`, the last
// instant the scheduler was awake and looking. A slot is missed when it lies
// between the last observation and now, and its own period has closed. That
// is a comparison of two persisted instants, not an inference from how late
// an interval arrived: there is no monotonic clock here, the tick is unrefed
// and measurably jittery, and lateness cannot tell a sleeping machine from a
// starved event loop.
//
// THE PERIOD IS UNCHANGED. A slot still catches up within its own calendar
// day (its own weekday, for a weekly routine), or it is recorded and never
// run. Five closed days leave five records and zero catch-up runs.
//
// WHAT A RECORD IS, EXACTLY, because the near-miss is the useful part. A
// record is a slot whose whole period went by with the scheduler not watching.
// A slot that passed while the scheduler was AWAKE and was not served leaves
// nothing, even once its period closes: the machine was on and said so at the
// time, in the refusal log and in the routine's own state, and the gap this
// card exists to close is the one with no trace at all. Deciding otherwise
// would also mean asking whether the routine ran in that period, which is the
// suppression's question and the one thing this block must not read.
//
// So refused routines DO accrue records, but only for periods that passed
// entirely unobserved: a paused routine on a machine that stays on accrues
// nothing. That is a decision rather than an oversight, and both sides of the
// boundary are pinned by one test. Whether a paused routine should SHOW its
// gaps is the routines view's ruling and is carded there.
//
// Exported by identity and mutated in place, like routineState, so every
// holder sees the same live object.
const routineSlots = { observedAt: null, routines: {} }; // { key: { due, schedule, missed: [{ slot }] } }

// How far back one wake will walk. A month closed is thirty steps; this is
// for a `due` absurdly far in the past, which a restored backup or a clock
// set years wrong can produce and where enumerating every day since would be
// neither quick nor useful. It is a guard, not a retention policy: what is
// recorded is kept.
const MAX_SLOTS_PER_WAKE = 500;

let slotWriteFailed = false;

function loadRoutineSlots() {
  routineSlots.observedAt = null;
  for (const key of Object.keys(routineSlots.routines)) delete routineSlots.routines[key];
  // The write complaint is throttled per outage, and an outage belongs to the
  // workspace it happened in. Carrying the flag across would let the first
  // unwritable workspace silence every one after it for the life of the
  // process, which is the opposite of saying something once.
  slotWriteFailed = false;
  try {
    const file = path.join(rundockDir(), 'routine-slots.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (typeof saved.observedAt === 'string') routineSlots.observedAt = saved.observedAt;
    for (const [key, entry] of Object.entries(saved.routines || {})) {
      // A key with no due instant has nothing to walk from, so it would
      // report every slot since the epoch. Dropped, like a run state with no
      // lastRun.
      if (!entry || typeof entry.due !== 'string') continue;
      const missed = Array.isArray(entry.missed) ? entry.missed.filter(m => m && typeof m.slot === 'string') : [];
      // An anchor whose schedule is missing or not a string cannot be checked
      // against anything, and null matches no shape, so the first wake resyncs
      // and records nothing rather than walking under a schedule it cannot
      // vouch for. Same guard as the due instant above, on the other field the
      // walk depends on, and reachable the same way: a hand edit, a truncated
      // write, a file from a build that stored less.
      const shape = typeof entry.schedule === 'string' ? entry.schedule : null;
      routineSlots.routines[key] = { due: entry.due, schedule: shape, missed };
    }
  } catch (e) { /* missing or unreadable file: start empty */ }
}

function saveRoutineSlots() {
  const dir = rundockDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'routine-slots.json'), JSON.stringify(routineSlots, null, 2));
}

// Written on every tick, because a stale observed time is worse than none: it
// would report as missed the very slots the scheduler watched and served.
// Said once per outage rather than once a minute, since the tick meets an
// unwritable .rundock sixty times an hour and a routine's own failures are
// what a log line should be for.
function persistRoutineSlots() {
  try {
    saveRoutineSlots();
    slotWriteFailed = false;
  } catch (e) {
    if (!slotWriteFailed) {
      slotWriteFailed = true;
      console.error('[Scheduler] Failed to persist routine slots:', e && e.message ? e.message : e);
    }
  }
}

/**
 * Record the scheduled slots that passed for `key` while nobody was watching,
 * and leave `due` pointing at the instant it is next due.
 *
 * `observedBefore` is the last observation from BEFORE this tick, so a slot
 * later than it is one no tick ever saw. A slot still inside the period `now`
 * falls in is not recorded: it is still catchable, and the tick that follows
 * this one is what catches it up.
 */
function recordPassedSlots(key, parsed, observedBefore, now, inService) {
  const current = slotFor(parsed, now);
  const shape = scheduleShape(parsed);
  const entry = routineSlots.routines[key];
  if (!entry) {
    // First sight. There is no observation to be absent from, so this routine
    // has no history and inventing one would report every slot since whenever
    // its schedule string was written. A routine added while the machine slept
    // lands here, and so does one RENAMED while it slept, because a rename is
    // a new key. Neither wakes up already late.
    routineSlots.routines[key] = { due: current.toISOString(), schedule: shape, missed: [] };
    return;
  }
  // A routine edited while the machine was closed. The anchor was computed
  // under the old schedule and the walk would step using the new one, so every
  // slot it named would be an hour, or a weekday, the routine was never due
  // at. There is no honest way to reconstruct what was owed under a schedule
  // that no longer exists, so the anchor resyncs and this wake records
  // nothing, which is what a routine the scheduler cannot vouch for is owed.
  //
  // History already written is KEPT. Those slots did pass, under the schedule
  // in force when they did, and a later edit is not a reason to lose them.
  if (entry.schedule !== shape) {
    entry.schedule = shape;
    entry.due = current.toISOString();
    return;
  }
  // A routine nobody has turned on did not MISS anything, and the same two
  // lines say so: resync the anchor, record nothing.
  //
  // A slot record is read on the row as "Missed: Rundock was closed at ...".
  // For a routine that has never been in service that names a cause which did
  // not apply, and the row withholds the line while the routine is off. That
  // withholding is worthless if the records survive: a routine held back for a
  // week would accumulate a week of them, and pressing Turn on would surface
  // the lot at exactly the moment the person acted.
  //
  // ONLY `enabled`, DELIBERATELY NOT EVERY REFUSAL. A paused routine WAS in
  // service and its owner suspended it; that it keeps accruing records is a
  // decision this project already took and pins in scheduler-lib.test.js. A
  // routine with no `enabled` key was never in service at all.
  //
  // THE ANCHOR STILL MOVES, which is why this is not a skipped call at the
  // tick. Freezing it would leave every slot since the last observation
  // waiting, and the first tick after somebody turned the routine on would
  // enumerate the lot and report as missed the very days it was waiting.
  if (!inService) {
    entry.due = current.toISOString();
    return;
  }
  if (observedBefore) {
    // WHICH END OF THE WALK THE BOUND CUTS. Walking forward from the anchor
    // and stopping at a cap keeps the OLDEST slots, so a `due` left years
    // behind by a restored backup or a wrong clock would fill the file with
    // slots from years ago and none from the week before the wake, which is
    // the only part anyone would look at. So the bound moves the START.
    let slot = new Date(entry.due);
    const earliest = stepSlots(parsed, current, -MAX_SLOTS_PER_WAKE);
    if (slot < earliest) {
      console.warn(`[Scheduler] ${key}: due instant ${entry.due} is too far behind to enumerate; keeping the most recent`);
      slot = earliest;
    }
    while (slot <= now && slot.toDateString() !== now.toDateString()) {
      if (slot > observedBefore) entry.missed.push({ slot: slot.toISOString() });
      slot = stepSlots(parsed, slot, 1);
    }
  }
  entry.due = current.toISOString();
}

// ===== WHAT A LIST OF ROUTINES SHOWS =====
// Read-only derivations for the routines view, which is the FIRST consumer the
// slot records have ever had. Everything below reads; nothing below writes.
//
// WHY THAT SENTENCE IS THE WHOLE POINT OF THIS BLOCK. `routineState.lastRun`
// is the only input to double-fire suppression, and the slot store holds when
// a routine was due. The separation held partly because nothing read the slot
// store at all. A display that took `due` and handed it back to the
// suppression would type-check, would read as a tidy simplification, and would
// break catch-up: today's slot arrives at the suppression as "already ran
// today" and the run the routine is still owed never happens. So the traffic
// here is one way, out of both stores and into a row, and it is pinned by
// test/unit/routines-next-run.test.js rather than by this paragraph.

/**
 * When `key` runs next: ONE path, used by every row whatever its last outcome
 * was.
 *
 * THE ANCHOR IS THE SLOT OF THE PERIOD `now` FALLS IN, and it is computed here
 * rather than read out of the slot store's persisted `due`. That is the whole
 * correctness of this function, so it comes before anything else.
 *
 * WHY NOT THE STORED ANCHOR. `due` is written by the tick and by nothing else.
 * A machine closed for days reopens holding an anchor days old; the client
 * asks for the roster the moment it connects; the first tick is up to sixty
 * seconds later and does not rebroadcast. A row built on the stored anchor
 * therefore renders a next run in the PAST, a weekday that has already gone,
 * in precisely the situation this row exists to describe: the machine was
 * closed, and it has just been reopened. The anchor has to mean "now" rather
 * than "whenever this machine was last awake".
 *
 * IT IS THE SAME RULE, EVALUATED NOW. slotFor is the function the slot store
 * itself anchors with, so this is not a second idea of when a routine is due;
 * it is that idea, asked at the moment the row is drawn. And the rule it
 * carries is the one a missed row depends on: a slot that has already gone by
 * today stays on TODAY rather than rolling to tomorrow, because the tick's
 * `now >= nextRun` check is what fires a same-day catch-up. That is why a
 * missed row pairs with a next run today and never tomorrow, and why the value
 * is derived rather than chosen.
 *
 * The slot store is still this view's, and only this view's, for the slots
 * that passed unserved. Nothing computed here is ever handed back to the
 * suppression.
 *
 * It steps forward only over a period the last run already served, which is a
 * question about the run state and is asked of it HERE, in the read direction
 * and only that way. The walk is bounded because a run stamped years in the
 * future, which a wrong clock or a restored backup produces, would otherwise
 * cost thousands of steps to draw one line of a list.
 */
function nextRunFor(key, schedule) {
  const parsed = parseSchedule(schedule);
  if (!parsed) return null;
  let slot = slotFor(parsed, deps.now());
  const stamped = routineState[key] && routineState[key].lastRun;
  const lastRun = stamped ? new Date(stamped) : null;
  const served = lastRun && !isNaN(lastRun.getTime()) ? lastRun : null;
  for (let step = 0; served && served >= slot && step < MAX_SLOTS_PER_WAKE; step++) {
    slot = stepSlots(parsed, slot, 1);
  }
  return slot;
}

/**
 * WHEN THE LAST RUN BEGAN, which is not what `lastRun` holds.
 *
 * THIS DISTINCTION IS THE WHOLE POINT OF THE FUNCTION, so it is stated before
 * anything else. `routineState.lastRun` is written by two paths at two
 * different moments. beginRun stamps it with the START, before the spawn, so
 * that a process which dies mid-run cannot re-fire the routine. recordOutcome
 * then overwrites it with the COMPLETION, alongside `duration` in whole
 * seconds. So for every run that finished, `lastRun` is the moment the work
 * ENDED.
 *
 * A row that measured lateness against that would be measuring how long the
 * run took as much as how late it was, and an agent run routinely takes more
 * than a few minutes. A routine that fired exactly on its slot and worked for
 * eleven minutes would read as caught up, which inverts the ruling in the
 * commonest case: almost every ordinary row would wear the quieter tone, and
 * an interface that dresses normal operation as something to look at is
 * exactly what the three-tone ruling exists to prevent.
 *
 * So the start is recovered by taking the duration back off the end. Whole
 * seconds make it exact to within half of one, which is nothing against a
 * boundary measured in minutes.
 *
 * A duration that is not a number means the stamp is ALREADY the start, and
 * that holds for every writer: beginRun writes null while a run is going,
 * loadRoutineState rewrites only the status when it finds one interrupted, and
 * recordFailedStart writes zero because a start that threw did no work. Each
 * one leaves `lastRun` naming the moment the run began.
 */
function lastRunStartedAt(key) {
  const state = routineState[key];
  if (!state || !state.lastRun) return null;
  const ended = new Date(state.lastRun);
  if (isNaN(ended.getTime())) return null;
  const seconds = state.duration;
  if (typeof seconds !== 'number' || !isFinite(seconds)) return ended;
  return new Date(ended.getTime() - seconds * 1000);
}

/**
 * The facts a routine row needs that neither the agent file nor the run state
 * carries on its own, as ISO instants.
 *
 * `lastStart` is when the last run BEGAN (see above). `lastSlot` is the slot
 * that run served, which is what lets a row tell a punctual run from one that
 * caught up late, and it is computed FROM THE START rather than from the end:
 * a run that began at 23:58 and finished after midnight served the slot on the
 * day it started, not the one on the day it stopped. `missedSlot` is the most
 * recent slot recorded as passed unserved, which is what lets a row say the
 * machine was closed. Which of them is the LAST thing that happened is decided
 * by the view, because that is a question about words rather than about time.
 *
 * `missedSlot` IS THE ONE FACT HERE THAT A TICK HAS TO HAVE WRITTEN, and it is
 * worth naming what that costs. Between a wake and the first tick, the most
 * recent recorded miss is whatever the previous session left, so a row can
 * name a real miss from an earlier day rather than the one that happened last
 * night, and it corrects itself on the next tick. That is stale rather than
 * wrong: the slot it names did pass unserved. The next-run value is the one
 * that could be wrong rather than merely old, which is why that is the one
 * computed from the clock instead.
 */
function routineDisplayFacts(key, schedule) {
  const parsed = parseSchedule(schedule);
  // WHETHER THIS GRAMMAR COULD READ THE SCHEDULE, reported rather than left to
  // be inferred. A null next run means several different things: the routine
  // already ran this period, it is paused, or the schedule is one nothing here
  // understands. Only the last of those is permanent, and only the last is
  // something the person who wrote the file can fix, so the list is told which
  // it is instead of guessing from an absent instant.
  //
  // THE ANSWER IS THIS MODULE'S TO GIVE. The grammar lives here, and a client
  // that judged readability for itself would be a second copy of it, free to
  // disagree with the tick about which routines can ever run.
  if (!parsed) {
    return { nextRun: null, lastStart: null, lastSlot: null, missedSlot: null, scheduleReadable: false };
  }
  const started = lastRunStartedAt(key);
  const entry = routineSlots.routines[key];
  const missed = entry && entry.missed.length ? entry.missed[entry.missed.length - 1].slot : null;
  const next = nextRunFor(key, schedule);
  return {
    nextRun: next ? next.toISOString() : null,
    lastStart: started ? started.toISOString() : null,
    lastSlot: started ? slotFor(parsed, started).toISOString() : null,
    missedSlot: missed,
    scheduleReadable: true,
  };
}

function recordRoutineRun(key, state) {
  routineState[key] = state;
  try {
    saveRoutineState();
  } catch (e) {
    // Persistence is protection for the NEXT process; this one already has
    // the in-memory state. An unwritable .rundock must not kill the scheduler.
    console.error('[Scheduler] Failed to persist routine state:', e && e.message ? e.message : e);
  }
}

// ===== RUN RECORDS =====
// One file per run under .rundock/runs/, opened when a run starts and closed
// once when it ends. A HISTORY, which nothing in this file had: routineState
// holds one slot per routine and every run overwrites its predecessor, so
// nothing could say what happened yesterday, how often a routine has failed,
// or how long it usually takes.
//
// WHY A SEPARATE STORE RATHER THAN MORE FIELDS ON routineState. The same
// reason the slot records are separate, and here it is sharper still.
// routineState is the ONLY input to double-fire suppression, read as
// getNextRun(schedule, routineState[key]?.lastRun). Nothing in this block is
// ever read by that, and nothing in this block writes to routineState: the two
// stores meet only in beginRun, where each is told the same thing separately.
//
// ITS OWN VOCABULARY, deliberately. A record is 'running', 'succeeded',
// 'failed', 'interrupted' or 'cancelled'.
//
// The first three are written by the two writers here, at the start and at the
// ending. THE FOURTH IS WRITTEN IN EXACTLY ONE PLACE, closeAbandonedRunRecords,
// for a record a dead process left open and that no ending will ever reach.
// The word is borrowed from the routine state on purpose, so that the two
// stores describe such a run in one vocabulary rather than in two a reader has
// to reconcile. Nothing else writes it, and no run that is still going ever
// carries it. Anything rendering these records has to expect it.
//
// The routine state's 'completed' stays exactly as it is, because renaming it
// would rewrite a file on every user's disk with no migration path, and these
// are separate stores by design.
//
// 'cancelled' IS THE FIFTH, AND ADDING IT WAS A DECISION RATHER THAN A
// CONSEQUENCE, because this vocabulary deliberately excludes states the
// product cannot produce and until now this was one of them. What changed is
// that a run can be reached from outside it and stopped, so the state now
// describes something that happens; leaving it out would have meant recording
// a run somebody stopped as one that failed, which is a different fact about a
// different run and the one thing a reader most needs told apart. It is
// written in one place, by the ending of a run that was stopped, and it
// carries a real endedAt and durationMs because that ending was witnessed,
// unlike 'interrupted'.
//
// THE ROUTINE STATE TAKES THE SAME WORD, which is what was settled for
// 'interrupted' and is settled here for the same reason: two stores describing one
// run in one vocabulary rather than in two a reader has to reconcile. It is
// an addition there and not a rename, so no file on any disk changes meaning.
// The consequence, named rather than left to be met: a surface with no words
// for it yet falls back to whatever it says for a status it does not
// recognise. The run screen has such a fallback and its own tests for it. The
// routines list, which is the surface that renders outcomes, has not been
// driven with this word by anything here, so what it shows for one is not
// established: giving both surfaces their own words is theirs to do rather
// than this file's.
//
// 'queued' is still not written here, because nothing in the product can
// produce one: a routine is started the moment it is found due.
//
// THE VOCABULARY IS DECLARED AS WELL AS DESCRIBED. The function below is the
// machine-readable copy of the two paragraphs above, and it exists for one
// reader: the walk that proves the routines list has words for every status
// this file can record. A writer that gains a sixth word updates this
// declaration, which sits inside the same comment block that reasons about
// the vocabulary, and the walk then fails until the list learns the word.
//
function statusesTheSchedulerRecords() {
  return ['running', 'succeeded', 'failed', 'interrupted', 'cancelled', 'completed'];
}

// WHAT A RECORD DOES NOT CARRY, and it is not an omission. The events a run
// emitted have their own work: a routine's output is discarded at the spawn
// (see the comment there, which says what has to be true before anything reads
// it). A record says only what this file can vouch for at the moment it
// writes.
//
// THE IDENTITY IS THE RUN'S OWN, not the routine key. `agentId:routineName` is
// neither unique nor stable: two routines may share a name under one agent,
// which the data model allows and a test pins, and a rename produces a
// different key. A record named by the key would collide between namesakes and
// be orphaned by a rename, so each run takes a uuid at the moment it starts and
// the file is named for it. The agent and the routine are recorded as what the
// run BELONGED to rather than as its identity.

// WHICH SIDE OF THE WORKSPACE-SWITCH RESET THIS STORE SITS ON, decided here
// rather than left to be inferred.
//
// The run state and the slot records are dropped by loadRoutineState because
// they describe the workspace being left. The in-flight set deliberately is
// NOT, because the child process of a run in flight is not dropped by a
// switch: it is still running, and it still holds the only thing that will
// ever release it.
//
// Run records follow the in-flight set, for that same reason rather than by
// analogy. A record is opened by a run that is still going and closed by that
// run, and its handle is registered by id in liveRuns for as long as the run
// lasts, which is a map a switch deliberately does not clear, for the reason
// recorded there. The only question a switch actually poses is where the
// ENDING lands, and it lands beside its own beginning. The directory
// is resolved once, when the run starts, and held. Resolving it again at the
// end would send the ending to whichever workspace happened to be open by then,
// leaving the workspace that did the work with a record stuck at 'running'
// forever and the other one holding an ending for a run it never saw.
//
// So this is the one place in this file where the workspace root is not read at
// use time. The reader below IS read at use time, because reading is a question
// about the workspace open now.
function runsDir() { return path.join(rundockDir(), 'runs'); }

// Whole-file and synchronous, like every other store here, but many small
// files written once each rather than one file rewritten on the tick. The
// opening and the closing write the SAME path, so a run leaves one record
// rather than two.
//
// CANNOT THROW, which is a requirement rather than a courtesy, and the closing
// is where it matters most: that one runs inside executeRoutine's catch, whose
// whole job is to release the routine and rethrow the start's own error
// unchanged. A throw raised there would replace the reason a start failed with
// the reason a file could not be written, while handling a failure.
//
// Said every time rather than once per outage, unlike the slot writes: those
// meet an unwritable .rundock sixty times an hour, and a run is a rare event
// whose failure is worth a line.
function writeRunRecord(dir, record) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record, null, 2));
  } catch (e) {
    console.error('[Scheduler] Failed to write run record:', e && e.message ? e.message : e);
  }
}

// ===== RUNS THIS PROCESS HAS OPEN =====
// Every run this process started and has not yet ended, by run id, each one
// the handle that names where its record lives and holds the thing that can
// stop it.
//
// TWO QUESTIONS, ONE STORE, and it used to be two. One question is whether a
// record found open on disk belongs to a run going here or to one a dead
// process abandoned, which is what the startup close reads. The other is how
// to reach a run that is still going in order to stop it. Those are different
// questions with the same answer, membership was identical by construction,
// and two stores filled and emptied on adjacent lines are two stores for a
// later entry point to join only one of.
//
// KEYED BY THE RUN'S OWN ID, for the reason the record store states at length:
// `agentId:routineName` is neither unique nor stable, so it cannot name one
// run. The single-flight hold is keyed that way because it asks about a
// ROUTINE. This asks about a RUN, and the id it answers to is the one the
// record is filed under, so a caller holding a record can reach the run it
// describes and needs nothing else.
//
// NOT RESET BY loadRoutineState, and in-process only: it follows the in-flight
// set on both counts, for the reason recorded there. What is specific here is
// the cost of getting it wrong in each direction. Cleared on a switch, the
// very next one would close the record of a run whose child is alive, and
// would leave that run unreachable for the rest of its life.
const liveRuns = new Map();

/**
 * The runs going right now, as facts rather than handles.
 *
 * The stopper does not leave this file. A caller gets what it needs to name a
 * run to a user and to ask for it to be stopped, and asking is the only way to
 * stop one, so there is no second route to a child process that skips the
 * bookkeeping the stop does.
 */
//
// Nothing in the server calls this or the stopper below yet. Both are exported
// now for the same reason the record reader is: the point of the map is that a
// run can be reached, and a way in that nothing can call is a way in nothing
// can check. What a person presses to stop a run is the run screen's own work.
function runningRuns() {
  return [...liveRuns.values()].map(run => ({
    id: run.id,
    key: run.key,
    agent: run.agent,
    routine: run.routine,
    startedAt: run.startedAt,
  }));
}

/**
 * Stop the run with this id, and say whether there was one.
 *
 * FALSE RATHER THAN A THROW for a run nothing answers to, because a run that
 * has already ended is the ordinary case rather than a fault: a stop is a
 * request from outside and it arrives whenever it likes, including a moment
 * after the run finished on its own. Nothing is signalled and nothing already
 * recorded is rewritten, which matters most in exactly that case, where the id
 * belonged to a process that really existed.
 *
 * THE INTENT IS RECORDED BEFORE THE SIGNAL, and that ordering is the whole of
 * what makes the record honest. The ending is written by whichever handler the
 * run ends in, not here, so the flag has to be on the run before the thing
 * that ends it is asked to end.
 *
 * THE HOLD IS RELEASED BY THE ENDING, not here. Releasing it at the moment of
 * the request would free the routine to start again while the child it was
 * asked to stop was still winding down, which is the fault single-flight
 * exists to prevent, arrived at through the feature meant to help. A child
 * that ignores the signal holds its routine exactly as long as one that hangs
 * of its own accord, which is a hang rather than a new failure.
 */
function cancelRun(runId) {
  const run = liveRuns.get(runId);
  if (!run) return false;
  // Before a stopper is armed there is nothing to deliver a stop TO: the only
  // party that could act is the scheduler itself, so the request is
  // remembered and honoured by construction, at the arm and at the pre-turn
  // checkpoints, which is what makes answering true here honest.
  if (!run.stop) {
    run.cancelRequested = true;
    return true;
  }
  return stopLiveRun(run);
}

// Ask a run to stop, and never let that ask reach the caller as a throw.
//
// CANNOT THROW, for the reason every writer in this file cannot: the two
// stoppers reach a live process and a live socket, either can fail for reasons
// that have nothing to do with the run, and a stop that threw would report as
// a failure of the request while the run went on going. The codex stopper is
// asynchronous, so its rejection is caught in the same breath: an unhandled
// one takes the process down.
//
// SENT ONCE, BUT ONLY COUNTED AS SENT IF IT WENT. The once-only guard exists
// because signalling a tree twice is a second SIGTERM to process ids that may
// by then belong to somebody else, and that hazard is created by a signal that
// LEFT. An attempt that threw, or a request the far end refused, created no
// such hazard and stopped nothing, so the run stays stoppable and the next
// request tries again. Marking it sent on a failed attempt left the run going
// with nothing able to reach it and every later request answering yes, which
// is the shape this whole block exists to remove.
//
// An asynchronous stop counts as sent from the moment it is DISPATCHED rather
// than from the moment it resolves, so two requests in the same breath cannot
// put two interrupts on the wire, and it is un-marked only if the request
// comes back refused. Un-marking a run that has since ended reaches nothing,
// because a run leaves the map the moment its ending removes it.
// How long the ordinary stop is given to work before a further request may
// send one that cannot be refused. The same wait the rest of the server leaves
// between asking a child to go and making it, so a person who stops a run twice
// meets one behaviour rather than two.
const FORCE_STOP_AFTER_MS = 2000;

function stopLiveRun(run) {
  // ASKED ALREADY. The only thing a further request can add is a stronger
  // signal, and the whole reason it has to be able to is below.
  if (run.stopSent) { forceStopLiveRun(run); return true; }
  if (!run.stop) return false;
  try {
    const asked = run.stop();
    run.stopSent = true;
    run.stopSentAt = deps.now().getTime();
    // CANCELLED MEANS A STOP WAS DELIVERED, not that one was wished for. Set
    // beside stopSent, on dispatch, and cleared with it if the far end
    // refuses, so a run whose stop never landed ends as whatever it really
    // was rather than as a stop the user was falsely told succeeded.
    run.cancelled = true;
    if (asked && typeof asked.catch === 'function') {
      asked.catch((e) => {
        console.error('[Scheduler] Failed to stop the run:', e && e.message ? e.message : e);
        run.stopSent = false;
        run.stopSentAt = null;
        run.cancelled = false;
      });
    }
    return true;
  } catch (e) {
    console.error('[Scheduler] Failed to stop the run:', e && e.message ? e.message : e);
    return false;
  }
}

/**
 * Send the signal a child cannot decline, when asking has not worked.
 *
 * WHY THIS EXISTS, AND IT IS THE WORST FAILURE THIS BLOCK COULD HAVE. The
 * ordinary stop asks: on a child it is a SIGTERM, which a process is entitled
 * to trap, to handle slowly, or to ignore entirely, and this codebase already
 * has children that trap their termination signal. The signaller sends the
 * signal it is given to the process group and does not escalate on its own, so
 * a child that ignores it goes on running, its ending never arrives, the
 * single-flight hold is never released, and the routine never runs again for
 * the life of the process. Meanwhile every further stop request answers yes and
 * sends nothing, so the interface says the run was stopped and it was not.
 *
 * A routine that was stopped and never runs again is worse than one that could
 * not be stopped at all, which is why asking twice has to be able to escalate.
 *
 * AFTER A BOUNDED WAIT, because the first signal deserves the chance to work.
 * A child given a termination signal usually needs a moment to unwind, and a
 * second request arriving inside that moment is somebody pressing twice rather
 * than evidence of anything. The wait is measured from when the ordinary stop
 * went out, on the same clock everything else here reads.
 *
 * ONCE, because a signal that cannot be declined does not need repeating, and a
 * process that has gone will not receive it anyway.
 *
 * NOT EVERY RUNTIME HAS ONE. The codex stop interrupts a turn on an app-server
 * shared with other runs and with the user's own conversations, and there is no
 * stronger lever that is still about this run: killing that process would stop
 * everything using it. So a codex run arms no forceStop, a repeated request
 * sends nothing further, and that limit is real rather than hidden.
 */
function forceStopLiveRun(run) {
  if (!run.forceStop || run.forceStopSent) return;
  if (run.stopSentAt == null) return;
  if (deps.now().getTime() - run.stopSentAt < FORCE_STOP_AFTER_MS) return;
  run.forceStopSent = true;
  try {
    run.forceStop();
  } catch (e) {
    console.error('[Scheduler] Failed to force the run to stop:', e && e.message ? e.message : e);
  }
}

/**
 * Hand a run the thing that can stop it, once the run has one.
 *
 * A run is reachable from the instant it starts, and for a moment after that
 * there is nothing to signal: the claude child is not spawned yet, and the
 * codex turn is several awaits away on an app-server that may still be
 * booting. A stop arriving in that window used to be the only kind that could
 * be recorded and then not happen. So the intent is remembered on the run, and
 * honoured here the moment there is something to honour it with.
 */
function armRunStopper(run, stop, forceStop) {
  run.stop = stop;
  run.forceStop = forceStop || null;
  if (run.cancelled || run.cancelRequested) stopLiveRun(run);
}

/**
 * Open a record for a run that is starting, and return the handle that closes
 * it. The handle is what knows the run's identity and where its record lives,
 * and it is registered in liveRuns by id so that a run can be reached from
 * outside while it lasts. The directory it carries is resolved once, here, so
 * the ending lands beside its own beginning whichever workspace is open by
 * then.
 *
 * Resolving the directory is the one fallible step, because there may be no
 * workspace root to resolve against. The caller runs this inside the guard
 * that releases the routine, for the reason recorded there.
 */
function beginRunRecord(agent, routine, key, startedAt) {
  const run = {
    id: randomUUID(),
    dir: runsDir(),
    agent: agent.id,
    routine: routine.name,
    // The routine this run belongs to, carried so a listed run can name it.
    // The ending releases the single-flight hold through the key its own
    // closure already holds, not through this one: this field exists for the
    // reader, which is runningRuns below.
    key,
    // Whether a stop has been asked for, the two things that can send one,
    // and how far the sending has got. These are separate fields because a
    // single one cannot hold them: `stop` null would mean both "nothing has
    // been armed yet" and "the signal has already left", which are opposite
    // instructions to anything deciding whether to send.
    //
    // `stop` is the ordinary stop and `forceStop` the one that cannot be
    // refused, where the runtime has such a thing. `stopSent` and
    // `forceStopSent` are the send-once guards, and `stopSentAt` is when the
    // ordinary one went out, which is what a later request measures its wait
    // against.
    //
    // Named here with every other field rather than added to the handle
    // afterwards, so a reader meets the object whole and no caller has to know
    // to finish building it.
    cancelled: false,
    stop: null,
    forceStop: null,
    stopSent: false,
    stopSentAt: null,
    forceStopSent: false,
    startedAt: startedAt.toISOString(),
    startedMs: startedAt.getTime(),
    // A SESSION OF ITS OWN, allocated here and recorded here, and that is the
    // whole of how a transcript is tied to a run. It is NOT the run's id: the
    // two are separate uuids and nothing may assume they match, which is why
    // the record carries the session explicitly and every reader takes it from
    // there. The claude spawn passes this value as --session-id and the agent
    // tool names the transcript for it, so the record is the only link between
    // a run and the file that says what it did. Nothing anywhere reaches for
    // the newest transcript: the wrong one would yield a plausible file list
    // belonging to another run, and nothing downstream could tell.
    //
    // Null on the codex runtime, which opens no session and leaves no
    // transcript. Recorded as a run with no session rather than as one whose
    // transcript went missing, because those are different facts.
    sessionId: agent.runtime === 'codex' ? null : randomUUID(),
  };
  writeRunRecord(run.dir, {
    id: run.id,
    agent: run.agent,
    routine: run.routine,
    sessionId: run.sessionId,
    status: 'running',
    startedAt: run.startedAt,
    endedAt: null,
    durationMs: null,
    error: null,
    // A run still going has not finished changing things, so its list is not
    // settled. Unknown with a reason, never an empty list, for the same reason
    // the ending is careful about it: nothing may read not-yet as nothing.
    files: null,
    filesStatus: 'unknown',
    filesReason: 'running',
  });
  // Registered AFTER the write, so the map never claims a run whose record was
  // never opened. Paired with the removal in endRunRecord, this is what tells
  // a record open in this process from one a dead process abandoned, and what
  // makes a run reachable for as long as it lasts.
  liveRuns.set(run.id, run);
  return run;
}

// The transcript read, made unable to throw.
//
// CANNOT THROW, and here that is the same requirement writeRunRecord carries,
// for a sharper reason. This runs inside the handler that ends a run, ahead of
// the release of the single-flight hold and the recording of the outcome, and
// on the failed-start path it runs inside the catch that keeps the whole tick
// alive. A throw raised here would leave the routine held with nothing left to
// release it, which is a routine that never runs again for the life of the
// process, and it would do it while handling somebody else's failure. This is
// the one statement of that rationale; endRunRecord's own comment points here
// rather than restating it.
//
// The reader already catches its own filesystem errors, so nothing known
// reaches this. That is a reason to expect it to hold rather than a reason to
// leave the frame unguarded: what is being defended is not a bug anybody has
// seen, it is the cost if one ever appears, and the cost is the worst failure
// this file has.
//
// Pinned by test/unit/scheduler-transcript-failure.test.js, which drives a
// reader that throws through a real run and asserts both halves: the record
// closes, and the routine is free to run again.
function observeRun(run) {
  try {
    return readSessionTranscript(run.sessionId);
  } catch (e) {
    console.error('[Scheduler] Failed to read the run transcript:', e && e.message ? e.message : e);
    // The reader's own four-field shape, activity included, so a caller
    // cannot meet a narrower object on the one path that is hardest to reach.
    return { status: 'unknown', reason: 'unreadable', files: null, activity: null };
  }
}

/**
 * Close a run's record. Rewrites the file the opening wrote, so a run has one
 * record whatever happened to it.
 *
 * THE SHAPE IS STATED IN FULL HERE AND IN THE OPENING, rather than shared
 * between them or spread from one into the other. Two reasons, and both are
 * about this file rather than about taste. It is the convention the run state
 * already follows, for the reason recorded at recordFailedStart: a record that
 * names every field it has is a record a reader can check against the writer
 * without following an indirection. And the risk duplication creates, the two
 * shapes drifting apart, is the thing the open record's own test pins: deleting
 * the owner from the opening alone turns it red, because the opening is
 * asserted in full and not only for the fields a closed record lacks.
 *
 * `err` is the reason a failure gave, when the failure gave one. Three endings
 * do: a start that threw, a child that never launched, and a codex turn that
 * could not start. Each is handed an object with a message, and that message is
 * the whole of what a maintainer has to go on, because in none of the three did
 * a child ever run.
 *
 * The ending that has no reason to give is a child that ran and exited
 * non-zero. An exit code is not a message, and whatever the child said it said
 * to a stream that goes nowhere, which is another card. `null` there is the
 * honest record rather than a gap.
 *
 * Milliseconds, and the field says so. The routine state's `duration` is whole
 * seconds and cannot be widened without changing a file on every user's disk;
 * this record is new, and a run that takes under a second is worth being able
 * to tell from one that took no time at all.
 */
function endRunRecord(run, ok, endedAt, err) {
  // WHAT THE RUN CHANGED, read once, here, from the transcript the run left
  // behind. Here rather than while it ran, because a file is only changed once
  // the write has come back, and only the ending knows there are no more.
  //
  // The reader cannot throw and must not, for the reason recorded at
  // observeRun. A transcript that is missing, unreadable or in a shape nothing
  // here understands costs the file list and nothing else.
  //
  // An unknown list is NULL rather than empty. The status says which of the
  // two happened, and no reader can turn "nobody could tell" into "it changed
  // nothing" by looking at a length.
  const observed = observeRun(run);
  writeRunRecord(run.dir, {
    id: run.id,
    agent: run.agent,
    routine: run.routine,
    sessionId: run.sessionId,
    // A run somebody stopped is not a run that failed, whichever way the
    // ending it was stopped through chose to report itself: a signalled child
    // closes with no exit code and an interrupted turn ends as one that did
    // not complete, and both arrive here as `ok` false.
    status: run.cancelled ? 'cancelled' : (ok ? 'succeeded' : 'failed'),
    startedAt: run.startedAt,
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - run.startedMs,
    error: err ? (err.message ? err.message : String(err)) : null,
    files: observed.files,
    filesStatus: observed.status,
    filesReason: observed.reason,
  });
  // THE ONE PLACE A RUN STOPS BEING OPEN, paired with the one place it starts.
  // Every ending comes through here, including a start that threw, so no
  // ending leaves a finished run listed as going or a dead handle for a later
  // stop to signal at a process id that has since been reused. It is also
  // hygiene: without it the map grows for the life of the process, one entry
  // per run, and the startup close would skip those records on their status
  // alone.
  liveRuns.delete(run.id);
}

/**
 * Close every run record left open by a process that is no longer here.
 *
 * WHY STARTUP IS WHERE THIS BELONGS. The closing write only ever runs from a
 * live handler, so a process that dies mid-run leaves its record open with
 * nobody left to finish it: `status: 'running'`, and a `filesReason` of
 * 'running' that is not true of a run which will never run again. The routine
 * state has always been corrected here, on exactly this evidence. The record
 * was not, so the two stores then disagreed, permanently, about whether that
 * run was still going, in the file the run-detail screen renders.
 *
 * THE TRANSCRIPT IS STILL ON DISK, and surviving a restart mid-run was one of
 * the three named reasons the transcript was chosen over the live stream. So
 * the answer is read the way the ending reads it, through observeRun, with the
 * session id the record itself carries rather than one derived from the run
 * id: the two are separate uuids and nothing may assume they match. Where the
 * transcript is gone, 'no-transcript' is the honest answer and already a
 * supported one.
 *
 * 'interrupted' RATHER THAN 'failed', and the word is the routine state's own,
 * which is what makes the two stores agree in one vocabulary. A record left
 * open says the ending never ran, which is not the same fact as the run having
 * failed: the work may well have finished a moment before the machine went
 * down. Naming an outcome nobody witnessed is the invention this store refuses
 * everywhere else.
 *
 * `endedAt` AND `durationMs` STAY NULL for that same reason. Nothing here
 * knows when the run stopped, and stamping the moment the orphan was noticed
 * would report a run that died three days ago as one that took three days.
 *
 * SPREAD RATHER THAN NAMED IN FULL, which is the one place in this block that
 * departs from the convention the two writers follow. Those two are ORIGINS:
 * they can name every field because they invent it. This is a rewrite of a
 * record some other process wrote, quite possibly a later version of this one,
 * and the reader beside it keeps whatever it finds for exactly that reason.
 * Naming the fields here would silently drop anything a newer writer added, at
 * startup, in the one scenario these records exist for.
 *
 * NOTHING HERE TOUCHES routineState. Its `lastRun` is the ONLY input to
 * double-fire suppression, and this runs inside the load that has both stores
 * in hand, which is one line away from reading a run record's instant into it
 * and costing the routine the catch-up run it is still owed. Pinned by a test
 * rather than left to this paragraph.
 *
 * CANNOT THROW, like the two writers around it, and one step further out than
 * either: this runs inside loadRoutineState, which runs at boot and on every
 * workspace switch. runsDir() is the fallible line, because there may be no
 * workspace root to resolve against. A throw raised here would take out the
 * rest of the load and leave the process with no routine state at all.
 */
function closeAbandonedRunRecords() {
  try {
    // Resolved ONCE. The reader below resolves it again from the same
    // workspace inside this one synchronous pass, so the records rewritten are
    // the records read.
    const dir = runsDir();
    for (const record of readRunRecords()) {
      // Already has an outcome. Rewriting one would replace a settled result,
      // and the file list that came with it, on every startup thereafter.
      if (record.status !== 'running') continue;
      // Open because it genuinely is still going, here, in this process.
      if (liveRuns.has(record.id)) continue;
      const observed = observeRun(record);
      writeRunRecord(dir, {
        ...record,
        status: 'interrupted',
        // An unknown list is NULL and not empty, carried through exactly as
        // the reader handed it over. A default of [] anywhere on this path
        // turns "nobody could tell" into "it changed nothing", permanently and
        // silently, which is the distinction the observation card exists for.
        files: observed.files,
        filesStatus: observed.status,
        filesReason: observed.reason,
      });
    }
  } catch (e) {
    console.error('[Scheduler] Failed to close abandoned run records:', e && e.message ? e.message : e);
  }
}

/**
 * Every run record in the workspace open now, in no promised order.
 *
 * Order is the caller's business, deliberately. A directory listing has an
 * order that belongs to the filesystem, so sorting here would be a promise
 * whose absence no test could reliably notice: whether an unsorted reader
 * happened to hand back the right sequence would depend on how a particular
 * filesystem lays out a particular set of random names. Every record carries
 * the instant its run started, which is what a caller that cares about order
 * should sort on.
 *
 * Keeps whatever it finds rather than whitelisting fields, exactly as the
 * routine-state reader does and for the same reason: a reader that names the
 * fields it expects silently discards anything a later writer adds, and the
 * only scenario these records exist for is the one where the write and the
 * read happen in different processes.
 *
 * Nothing in the server reads this yet. The run-detail screen is what it is
 * for, and it is exported now because a store whose write cannot be read back
 * is a store nothing can check.
 */
function readRunRecords() {
  const dir = runsDir();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return []; // no runs yet, or a workspace that cannot be read
  }
  const records = [];
  for (const name of names) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'));
      // A half-written file, or one somebody hand-edited into something else.
      // Skipped rather than fatal: one bad file must not hide the history.
      if (record && typeof record.id === 'string') records.push(record);
    } catch (e) { /* unreadable or unparseable: skip it */ }
  }
  return records;
}

/**
 * What a run is doing right now, or the reason nobody can say.
 *
 * POLLED, DELIBERATELY. Each call reads the record and then the transcript;
 * nothing registers for a filesystem event and nothing holds the file open.
 * That is the pattern this codebase already argues for twice over watching:
 * a poll owned by its caller stops when the caller stops, and a watcher on a
 * directory outside the workspace would outlive whatever asked for it.
 *
 * Reached through the RECORD rather than by assuming the run id is the
 * session id. The record is where the run states which session it opened, so
 * a runtime that later allocates its session differently changes one writer
 * and no reader.
 *
 * Nothing in the server calls this yet: the run-detail screen is what it is
 * for, and it is exported now because a reading nothing can perform is a
 * reading nothing can check.
 */
function readRunProgress(runId) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(path.join(runsDir(), `${runId}.json`), 'utf-8'));
  } catch (e) {
    return { status: 'unknown', reason: 'no-record', activity: null };
  }
  // ASKED ABOUT THE ACTIVITY, not about the file list, and the two do not
  // have the same answer. A run inside its first write has a transcript that
  // was read and understood and holds no settled changes at all, so its list
  // is unknown while what it is doing is perfectly legible. Reporting the
  // list's status here would say a run that is plainly working cannot be
  // seen.
  const observed = readSessionTranscript(record && record.sessionId);
  if (observed.activity) return { status: 'known', reason: null, activity: observed.activity };
  return { status: 'unknown', reason: observed.reason || 'no-activity', activity: null };
}

// ===== SCHEDULER =====

// The live tick handle, and the whole of the scheduler's lifecycle state.
// It used to be discarded, which cost two things: the tick could not be
// stopped, and a second start silently added a second tick rather than
// being recognised as a repeat.
let tickTimer = null;

// Which refusal each routine was last announced under, so a routine that is
// refused says so once rather than once a minute. A refusal deliberately does
// not record a run (that is what stops it being counted as one), so a refused
// routine stays due for the rest of its window and the tick meets it again on
// every pass. Forgotten as soon as a routine stops being refused, so pausing
// something a second time is announced a second time.
//
// Scoped to the life of the routine rather than the life of the process, which
// takes both of the resets below. Keys are `agentId:routineName`, which are
// workspace-local and collide freely between workspaces, so a key that outlived
// what it described would hand its silence to a different routine that happened
// to be named the same. A refusal silent on its first tick cannot be told apart
// from a routine that is simply not due, which is the whole point of saying
// anything.
const announcedRefusals = new Map();

// Routines whose run has started and has not yet reached an outcome.
//
// Keyed by the SAME `agentId:routineName` as the run state, which is what
// decides that two routines sharing a name under one agent are held together
// rather than separately. They already share one state slot, so a lock at a
// finer grain than the state it protects would let one namesake run while the
// other's hold still stood, and both would then write the same slot. There is
// also no finer identity to key on that survives a tick: the roster is re-read
// on every pass, so routine objects are fresh, and a routine's position in its
// agent's list moves whenever the file is edited.
//
// DELIBERATELY NOT RESET BY loadRoutineState, unlike every other keyed state
// in this file. A workspace switch drops the run state and the announcements
// because those describe the workspace being left, but the CHILD PROCESS of a
// run in flight is not dropped: it is still running, and it still holds the
// only thing that will ever release its key. Clearing the set would leave a
// release with nothing to release and a routine free to start again while its
// first run was still going, which is the whole fault this set exists for.
//
// The cost, named rather than hidden: keys are workspace-local and collide
// freely, so a routine in the NEW workspace sharing an agent id and name is
// held until the old workspace's child exits. That is a delayed run rather
// than a duplicated one, and it clears itself. The same collision already
// bleeds through the run state, where the old run's outcome lands in the new
// workspace's slot, and closing it properly is the cross-process locking card's
// work rather than this one's.
//
// This is in-process only. Two copies of Rundock over one workspace still tick
// independently, which wants a lock on disk and has its own card.
const inFlight = new Set();

// Why the routine's own fields refuse it, named after the FIELD that decided,
// or null if none of them do. "It did not run" without a field is a support
// question rather than an answer.
//
// The supported set is not repeated here: which run targets exist is the data
// model's to know, and a second list in the scheduler is a second list to
// forget to update. Nothing is normalised either, because normalizeRoutine has
// already defaulted and lowercased everything by the time a routine gets here.
//
// A ROUTINE WITH NOTHING TO SAY IS REFUSED BY THIS GATE RATHER THAN BY THE
// SPAWN, and the difference is the whole of that defect. Nothing on the run
// path throws for an absent prompt: it is pushed into the argument list, Node
// turns it into the four letters n-u-l-l on its way to the child, and the
// routine fires on schedule, records a completed run and shows an ordinary
// history while an agent works unattended on the word "null". Refusing it here
// puts it where a paused routine already is, which is a state the log line
// below, the row on the list and the offer on that row all already know how to
// describe.
//
// LAST OF THE FOUR, because the three above are things somebody chose and this
// is something they left out. A routine that is paused and promptless is
// reported as paused, which is the fact its owner acted on most recently.
function routineRefusal(routine) {
  if (routine.paused) return 'paused';
  if (!routine.enabled) return 'enabled';
  if (!isRunOnSupported(routine.runOn)) return 'runOn';
  if (!hasRunnablePrompt(routine)) return 'prompt';
  return null;
}

/**
 * What a routine gets when its own start throws.
 *
 * THE DECISION, because until this card nothing recorded a failed start at
 * all and the silence was the worst half of the defect. The routine is
 * recorded as a FAILED RUN, carrying the reason the failure itself gave.
 *
 * Why a failed run rather than a new kind of record. Its start has already
 * written one: beginRun persists `running` BEFORE the spawn, so that a
 * process which dies mid-run cannot re-fire the routine on restart. When the
 * spawn throws there is no child, so nothing will ever move that record off
 * `running`, and the next restart rewrites it to `interrupted`, which claims
 * a run began and was cut short. Both are untrue, and both are untrue on the
 * screen a user reads. `failed` is what happened, it is a status the routines
 * view already knows, and it needs no new vocabulary to say it.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH. `lastRun` is carried through from the
 * record the start wrote rather than restamped, so nothing added here reaches
 * the only field double-fire suppression reads. Every other field is stated
 * rather than spread across, matching recordOutcome: a spread would carry
 * nothing today, since this record names every field the other one has.
 * The consequence is the intended one: the routine stays suppressed for the
 * rest of its period exactly as a successful run would. A start that throws
 * on the routine's own contents throws again sixty seconds later, and a
 * minute-by-minute retry of a permanently malformed routine is a louder
 * failure than the silent one this card exists to end, not a quieter one. The
 * next period attempts it again, which is what makes the fault recoverable by
 * fixing the routine rather than by restarting the app.
 *
 * THE STAMP IS GUARANTEED RATHER THAN INHERITED, and the difference is the
 * whole decision above. Carrying `lastRun` through works only while beginRun's
 * write is the first thing that can survive to happen; put anything fallible
 * ahead of it and the record arrives with no `lastRun` at all, at which point
 * getNextRun reads the routine as still due and the once-per-period decision
 * becomes a once-per-minute retry, while loadRoutineState drops the entry on
 * restart because the field is not a string. The reason recorded here would
 * then not survive the restart it exists to be read after. So the tick's own
 * `now` is passed in as the floor. It is the instant the routine was judged
 * due, it was read successfully before any of this could fail, and converting
 * a Date already in hand adds no clock read to a tick pinned to exactly one.
 * A fallback that read the clock again would be worse than none: the one way
 * to reach it is a clock that threw.
 *
 * NOTHING IN HERE CAN THROW, and that is a requirement rather than an
 * observation: this runs inside the catch that keeps the pass alive, so a
 * throw raised here would escape exactly as the original one did. The console
 * call cannot throw, and recordRoutineRun already swallows the only failure it
 * has (an unwritable .rundock). So the client broadcast and the signals event
 * that the outcome path fires are deliberately absent. broadcastRoutineUpdate
 * reaches a dependency that throws when it is unwired, and a failed start is
 * not a run to be counted among the runs: in the events file it would be
 * indistinguishable from a real fast failure, since the status is the same
 * word and a duration of zero is legal for both.
 *
 * Both of those are ENFORCED rather than asked for, in
 * test/integration/scheduler-tick-isolation.test.js: 'a failed start tells the
 * clients nothing' counts the broadcasts on a pass, 'a failed start is not
 * counted among the runs' reads the events file with a real run beside it for
 * contrast, and 'a start that throws away from the spawn is isolated too'
 * drives the forbidden dependency so that adding the call fails while handling
 * a failure. A requirement stated here and pinned nowhere is a comment.
 */
function recordFailedStart(agent, routine, key, err, now) {
  const reason = err && err.message ? err.message : String(err);
  console.error(`[Scheduler] Routine "${routine.name}" (${agent.name}) failed to start: ${reason}`);
  const started = routineState[key];
  // A FLOOR, not a fallback, and the difference is the whole once-per-period
  // decision. Substituting only when the stamp is ABSENT covers a start that
  // died before writing anything, but not one that died leaving whatever the
  // last run wrote, which can be days old. A stamp from an earlier period does
  // not suppress, so the routine reads as due on the very next tick and is
  // retried every sixty seconds: the outcome this function exists to avoid,
  // arrived at through the branch meant to prevent it.
  //
  // Taking the later of the two makes the decision hold whatever the start
  // managed to write, rather than only for the arrangement of statements that
  // happens to be in beginRun today.
  const inherited = started && started.lastRun ? started.lastRun : null;
  const stamped = now.toISOString();
  recordRoutineRun(key, {
    lastRun: inherited && inherited > stamped ? inherited : stamped,
    status: 'failed',
    duration: 0,
    error: reason,
  });
}

function startScheduler() {
  // Already ticking: leave the running one alone. Replacing it instead would
  // make a stray second call reset the tick's phase, and would leave nothing
  // for a test to tell one tick from two.
  if (tickTimer) return;
  const checkInterval = 60 * 1000; // Check every 60 seconds

  tickTimer = setInterval(() => {
    const agents = discoverAgents();
    const now = deps.now();

    // The last observation, read BEFORE this tick overwrites it: a slot later
    // than this is one no tick has ever seen.
    const observedBefore = routineSlots.observedAt ? new Date(routineSlots.observedAt) : null;

    const onRoster = new Set();
    // Keys whose anchor this pass could vouch for. Narrower than onRoster on
    // purpose: a routine whose schedule no longer parses is still declared and
    // still refusable, but nothing can say when it was next due.
    const anchored = new Set();

    for (const agent of agents) {
      if (!agent.routines) continue;
      for (const routine of agent.routines) {
        const key = `${agent.id}:${routine.name}`;
        onRoster.add(key);
        const refusedBy = routineRefusal(routine);
        if (!refusedBy) announcedRefusals.delete(key);
        // Before due-ness is decided, and deliberately reading NOTHING that
        // due-ness depends on. A slot that has already gone is not a question
        // about whether this routine may fire now.
        const parsed = parseSchedule(routine.schedule);
        if (parsed) {
          // Whether the routine is in service at all is passed in. A routine
          // nobody has turned on is owed no record of what it did not do.
          recordPassedSlots(key, parsed, observedBefore, now, routine.enabled !== false);
          anchored.add(key);
        }
        const nextRun = getNextRun(routine.schedule, routineState[key]?.lastRun);
        if (nextRun && now >= nextRun) {
          // Refusal is checked AFTER due-ness so that a routine which is
          // simply not due stays silent, and so that what makes a routine due
          // is decided by exactly the code it was decided by before.
          if (refusedBy) {
            if (announcedRefusals.get(key) !== refusedBy) {
              announcedRefusals.set(key, refusedBy);
              console.log(`[Scheduler] Not running routine: ${routine.name} (${agent.name}): ${refusedBy} is ${String(routine[refusedBy])}`);
            }
            continue;
          }
          // ONE ROUTINE'S START IS ONE ROUTINE'S RISK. executeRoutine
          // rethrows a start that throws, having released its hold first, on
          // the stated grounds that what the caller does about a failed start
          // is not that function's business. This is the caller, and until
          // this catch existed nothing here was either: the throw left the
          // loop, left the interval callback and left the process, and there
          // is no uncaughtException handler anywhere in the server. So one
          // malformed routine ended the pass for every agent in the
          // workspace, took the bookkeeping below the loop down with it, and
          // did it again sixty seconds later, with nothing recorded and
          // nothing shown.
          //
          // Scoped to the START and to one routine. A run that fails AFTER it
          // has begun already has an outcome path, and widening this to cover
          // the rest of the pass would put a routine's fault and the tick's
          // own bookkeeping behind one guard, which is how the next failure
          // gets to be silent again.
          try {
            if (executeRoutine(agent, routine, key, now)) {
              console.log(`[Scheduler] Running routine: ${routine.name} (${agent.name})`);
            } else {
              // Said on every held tick rather than once, unlike a refusal. A
              // hold lasts exactly as long as one run, so the only way to hear
              // this twice is a run that has outlived its window, which is worth
              // saying every time it is true. A refusal can stay true for months.
              console.log(`[Scheduler] Not starting routine: ${routine.name} (${agent.name}): its previous run has not finished`);
            }
          } catch (err) {
            recordFailedStart(agent, routine, key, err, now);
          }
        }
      }
    }

    // A routine that is no longer declared cannot be refused, so its
    // announcement describes nothing. Keeping it means the next routine written
    // under that name inherits a silence it never earned, and a rename is
    // enough to produce one.
    for (const key of announcedRefusals.keys()) {
      if (!onRoster.has(key)) announcedRefusals.delete(key);
    }
    // Slot records are NOT pruned the same way, and the difference is the
    // point. An announcement is a silence, so one outliving what it described
    // hands that silence to the next routine written under the name. A gap
    // record is history, and the run state beside it keeps dead keys for the
    // same reason: a routine renamed and renamed back still happened.
    //
    // The ANCHOR does not survive, though, and that is the other half. A slot
    // cannot pass for a routine that does not exist, so the days after a
    // routine is deleted are days on which nothing was due; walking from the
    // old anchor when it returns would record every one of them. Marking the
    // anchor unknown is the same answer a changed schedule gets, deliberately
    // in the same shape: keep the history, resync on the first tick back.
    for (const [key, entry] of Object.entries(routineSlots.routines)) {
      if (!anchored.has(key)) entry.schedule = null;
    }
    routineSlots.observedAt = now.toISOString();
    persistRoutineSlots();
  }, checkInterval);
  tickTimer.unref(); // see heartbeat unref note: listener keeps process alive in production
}

// Stop the tick. Safe on a scheduler that was never started: clearInterval on
// a null handle is already a no-op, so there is deliberately no guard here for
// that case. Clearing the handle is what lets a later start arm a fresh tick
// rather than being turned away by the guard above.
function stopScheduler() {
  clearInterval(tickTimer);
  tickTimer = null;
}

// Is a tick armed?
//
// Reads the interval handle the tick itself depends on, rather than a flag
// kept beside it: a second copy of this answer is a second copy to get wrong,
// and the one question worth asking of a lifecycle is whether the thing is
// actually running.
//
// It exists because the alternative was worse. For eight cards the only way to
// find out whether the scheduler was running was to call startScheduler and
// see what happened, and asking that way is what let the product ship with no
// caller on the path a user takes: a suite that arms the tick itself never
// notices that nobody else does. This lets a test ask without arming anything.
function schedulerRunning() {
  return tickTimer !== null;
}

const WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

// The schedule grammar, read once and shared by the two questions asked of it.
// getNextRun asks "may this routine fire", which needs the run guard; the slot
// arithmetic asks "when was this routine due", which must not have it. Both
// need the same two patterns, and a second copy of the regexes would be a
// second copy to forget.
//
// Everything else returns null, which is what makes an unrecognised schedule
// silently never fire. That is documented as a pitfall rather than fixed here.
function parseSchedule(schedule) {
  if (!schedule) return null;
  const s = schedule.toLowerCase();
  // Daily is matched FIRST, and the order carries weight: "every day at 05:00"
  // also satisfies the weekly pattern's \w+, with "day" as the weekday.
  const dailyMatch = s.match(/every day at (\d{2}):(\d{2})/);
  if (dailyMatch) return { kind: 'daily', hour: parseInt(dailyMatch[1]), minute: parseInt(dailyMatch[2]) };
  const weeklyMatch = s.match(/every (\w+) at (\d{2}):(\d{2})/);
  if (weeklyMatch) {
    const day = WEEKDAYS[weeklyMatch[1]];
    if (day === undefined) return null;
    return { kind: 'weekly', day, hour: parseInt(weeklyMatch[2]), minute: parseInt(weeklyMatch[3]) };
  }
  return null;
}

// The instant this routine is due in the period `now` falls in: today for a
// daily routine, and this week's weekday for a weekly one (which is today when
// today IS that weekday, and a date in the future otherwise).
//
// Takes the time rather than reading it, so it adds no clock read to a tick
// that is pinned to exactly one, and so the answer is a pure function of the
// schedule and the instant asked about.
//
// THE COPY ON THE FIRST LINE IS LOAD-BEARING, and it is the only thing keeping
// this off the double-fire guard. The tick reads the clock once and hands the
// SAME Date to this and, two lines later, to the `now >= nextRun` comparison
// that decides whether a routine fires. setHours mutates in place, so calling
// it on the argument would move the tick's own instant to the routine's
// scheduled time and every routine after it would be judged against a clock
// this one had reset. Copy first, mutate the copy.
function slotFor(parsed, now) {
  const target = new Date(now);
  target.setHours(parsed.hour, parsed.minute, 0, 0);
  if (parsed.kind === 'weekly') target.setDate(target.getDate() + ((parsed.day - now.getDay() + 7) % 7));
  return target;
}

// `periods` slots away from `slot`, forwards or backwards. Steps a CALENDAR
// day (or week) rather than twenty-four hours, because a schedule is a
// wall-clock time: on the day the clocks change, 23:00 is still 23:00.
function stepSlots(parsed, slot, periods) {
  const next = new Date(slot);
  next.setDate(next.getDate() + periods * (parsed.kind === 'weekly' ? 7 : 1));
  return next;
}

// The schedule fields the walk actually depends on, in a form that can be
// stored beside the anchor and compared on the next wake. Derived from the
// parse rather than from the raw string, so case and spacing do not read as
// an edit.
function scheduleShape(parsed) {
  return parsed.kind === 'weekly'
    ? `weekly:${parsed.day}:${parsed.hour}:${parsed.minute}`
    : `daily:${parsed.hour}:${parsed.minute}`;
}

function getNextRun(schedule, lastRunISO) {
  if (!schedule) return null;
  const now = deps.now();
  const parsed = parseSchedule(schedule);
  if (!parsed) return null;

  if (parsed.kind === 'daily') {
    // Don't re-run if already ran today. This suppression (fed by the
    // persisted routine state) is the ONLY thing standing between a due
    // routine and a duplicate fire, which is why it is checked first.
    if (lastRunISO) {
      const lastRun = new Date(lastRunISO);
      if (lastRun.toDateString() === now.toDateString() && lastRun.getHours() >= parsed.hour) return null;
    }
    // A target already past today stays TODAY: the scheduler's `now >= nextRun`
    // check fires it on the next tick (same-day catch-up). The previous code
    // rolled it to tomorrow, which meant the fire condition was only
    // satisfiable in the single millisecond HH:MM:00.000 - routines whose
    // tick did not land exactly on that instant never fired at all.
    return slotFor(parsed, now);
  }

  // Suppression first, same reasoning as the daily branch.
  if (lastRunISO) {
    const lastRun = new Date(lastRunISO);
    const daysSinceLastRun = (now - lastRun) / (1000 * 60 * 60 * 24);
    if (daysSinceLastRun < 1 && lastRun.getDay() === parsed.day) return null;
  }
  // On the target weekday a past-due target stays TODAY so the scheduler
  // fires it (same-day catch-up); the suppression above prevents re-fires.
  // See the daily branch for why the old roll-forward meant never firing.
  return slotFor(parsed, now);
}

/**
 * Start a run of `routine`, unless one is already in flight for it.
 *
 * The guard lives HERE rather than in the tick so that a second entry point (a
 * run-now button, say) cannot start a run the tick would have refused. The
 * return value is what the tick reads to say why nothing happened; it is not
 * an error, because a held routine is a normal state rather than a fault.
 */
/**
 * ...and `now` is the instant the caller judged this routine due.
 *
 * The tick reads the clock ONCE per pass and judges every routine against that
 * one reading, so it hands the same Date on rather than letting this function
 * take another. Three readings of a live clock describing one start is three
 * different answers to when the run began, and the failed-start path already
 * stamps with the tick's instant for exactly this reason: the two now agree.
 *
 * Optional, because a direct caller (a run-now button, a test) has no tick
 * instant to give. That caller's reading is taken below, inside the guard,
 * because reading the clock can throw.
 */
function executeRoutine(agent, routine, key, now) {
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  // The run's record is opened HERE rather than inside beginRun so that its
  // handle is in scope of the catch below. A start that throws is still a run
  // that began and did not finish, and a record left saying 'running' forever
  // would be the same silence in the new store that recordFailedStart removed
  // from the old one.
  //
  // It is also what keeps the tick's failure path out of this. recordFailedStart
  // runs inside the catch that keeps the whole pass alive, so a new fallible
  // call there is a new way for one routine to end everybody's tick; the record
  // is closed one frame below it instead, where the handle already is.
  //
  // INSIDE the same guard as the start, not ahead of it. Writing the record
  // cannot throw, but reaching for the workspace root to decide where it goes
  // can: there may not be one. Opened outside the try, that throw would leave
  // the routine added to the in-flight set with nothing left to release it,
  // which is held-for-the-life-of-the-process, the one fault this guard exists
  // to prevent. The failure path below has a floor of its own for the stamp, so
  // a start that dies before beginRun writes anything is still held to one
  // attempt per period.
  let run = null;
  try {
    const startedAt = now || deps.now();
    // Reachable from here, which is BEFORE the spawn and deliberately so: a
    // run is a run from the moment its record is opened, and the window
    // between that and a child existing is exactly where a stop used to be
    // impossible. The stopper is armed into it when there is one. Inside the
    // same guard as the start, so the release below covers it.
    run = beginRunRecord(agent, routine, key, startedAt);
    beginRun(agent, routine, key, run, startedAt);
  } catch (err) {
    // A start that throws leaves no child, so no close event and no outcome,
    // so nothing that will ever release. Held forever is how a guard turns
    // into a routine that never runs again, and it takes no bug in the guard
    // to get there. Rethrown once the routine is free: what the caller does
    // about a failed start is unchanged by this file.
    inFlight.delete(key);
    // A start that died before its record was opened has nothing to close.
    if (run) endRunRecord(run, false, deps.now(), err);
    throw err;
  }
  return true;
}

function beginRun(agent, routine, key, run, startedAt) {
  const startTime = startedAt.getTime();
  // Persisted immediately: if the server dies mid-run, the restarted process
  // still knows the run started and will not fire it again in the same window.
  //
  // THIS READING IS DELIBERATELY ITS OWN, and it is the only one left that is.
  // The field is the sole input to double-fire suppression, and moving it to
  // the tick's instant would change what suppresses a routine, which is a
  // behaviour change rather than a tidy-up. It is also the read that
  // test/integration/scheduler-tick-isolation.test.js drives a throw at, to
  // prove the failed-start path stamps a floor when a start dies before
  // writing anything.
  recordRoutineRun(key, { lastRun: deps.now().toISOString(), status: 'running', duration: null });

  // Notify connected clients
  broadcastRoutineUpdate();

  // Both runtimes and both outcomes end here, so the release lives at this one
  // point rather than at each of the four call sites below. It goes first, so
  // that nothing between here and the end of the function can leave a routine
  // held after its run has finished.
  //
  // A run ends once. The flag is local to this run, so it says nothing about
  // any other, and it is what lets the claude path listen for both ends of its
  // child without recording a failure that reports twice as two failures.
  //
  // The optional `err` is the reason a failure gave, for the two endings that
  // are handed one: a child that never launched, and a codex turn that could
  // not start. It reaches the run record and nothing else. The routine state,
  // the signals event and the broadcast below are unchanged by it, and the
  // endings that have no reason to give pass nothing, so a child that ran and
  // exited non-zero still records none.
  let recorded = false;
  const recordOutcome = (ok, err) => {
    if (recorded) return;
    recorded = true;
    inFlight.delete(key);
    const duration = Math.round((deps.now().getTime() - startTime) / 1000);
    // Read from the run rather than passed in, because the ending that
    // arrives after a stop is an ordinary ending: a child closing, a turn
    // reaching its terminal event. Neither knows it was asked to stop, and
    // neither should have to.
    //
    // lastRun IS STAMPED EXACTLY AS ANY OTHER ENDING STAMPS IT, from the
    // clock, and that is the point rather than an incidental. It is the only
    // input to double-fire suppression, so a stop that left it alone would
    // fire the routine again on the very next tick and go on doing it for the
    // rest of the period, and one that reached for the run's own beginning or
    // for a slot instant would move the answer somewhere neither store means.
    // A stopped run costs the routine the rest of the period it already ran
    // in, and costs it nothing after that.
    recordRoutineRun(key, {
      lastRun: deps.now().toISOString(),
      status: run.cancelled ? 'cancelled' : (ok ? 'completed' : 'failed'),
      duration
    });
    // READ BACK RATHER THAN RECOMPUTED. The recorder assigns the state it is
    // given, so this is the word that was actually recorded, and the log line
    // and the event below cannot come to say something the record does not.
    const outcome = routineState[key].status;
    console.log(`[Scheduler] Routine "${routine.name}" ${outcome} (${duration}s)`);
    // Closed before the event and the broadcast, both of which can throw: a
    // record left open by something that happened after the run ended would be
    // read as a run still going, forever. The two calls below are otherwise
    // untouched by this card.
    endRunRecord(run, ok, deps.now(), err);
    recordEvent('routine_run', { agent: agent.id, runtime: agent.runtime || 'claude', d: { routine: routine.name, status: outcome, duration } });
    broadcastRoutineUpdate();
  };

  if (agent.runtime === 'codex') {
    // Codex agents run their routines on the shared Codex app-server: one
    // fresh thread per run, the routine prompt travelling with the agent's
    // instructions (Codex has no --agent equivalent). Routines run
    // unattended with nobody to approve escalations, so approvalPolicy is
    // an EXPLICIT 'never' (the client refuses to default to it):
    // sandbox-blocked actions fail instead of hanging on an approval,
    // matching the retired exec mode. The agent's plan choice is honoured
    // even for unattended work.
    const routinePrompt = [readAgentInstructions(agent), buildSystemPrompt(agent), routine.prompt].filter(Boolean).join('\n\n');
    (async () => {
      const server = await getCodexAppServer();
      await waitForCodexReady(server);
      // A cancel that arrived while the app server was still starting is
      // honoured by never starting the work: there is no turn to interrupt
      // yet, so the scheduler is the thing that stops, and the record reads
      // cancelled because the scheduler itself delivered the stop.
      if (run.cancelRequested || run.cancelled) { run.cancelled = true; return false; }
      const { threadId } = await server.startThread({
        cwd: getWorkspace(),
        model: agent.model || undefined,
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
      });
      // Checked again: starting the thread itself takes long enough for a
      // stop to arrive, and a turn is the thing that can write.
      if (run.cancelRequested || run.cancelled) { run.cancelled = true; return false; }
      const sub = server.startTurn(threadId, routinePrompt);
      // WHAT STOPPING A CODEX RUN MEANS. There is no child of this run's own
      // to signal: the work is a turn on the shared app-server, which other
      // runs and the user's own conversations are also using, so killing the
      // process would stop all of them. The client's interrupt stops this one
      // turn, and the turn then ends through the same terminal event every
      // other codex ending arrives by, which is what the promise below is
      // already waiting on.
      //
      // ARMING IT HERE IS SAFE EVEN THOUGH THE TURN IS NOT YET ACKNOWLEDGED,
      // and that was checked against the client rather than assumed. A stop
      // asked for before this line is honoured the moment this line runs, so
      // the interrupt can be dispatched in the same tick as the turn started,
      // before turn/start has come back. The client's interruptTurn is what
      // makes that safe: called without an explicit turn id it looks up the
      // thread's turn state, and where the turn id is not known yet it awaits
      // that turn's own started promise before sending, so an interrupt that
      // arrives early is held until the turn exists rather than refused for
      // naming no active turn. startTurn registers the state and that promise
      // synchronously, so there is no window between the two lines here where
      // the lookup finds nothing.
      armRunStopper(run, () => server.interruptTurn(threadId));
      const status = await new Promise((resolve) => {
        sub.on('event', (ev) => {
          if (ev.type === 'done') return resolve(ev.status);
          // A turn that ends any other way still ends. The client documents
          // done as terminal and exactly once and every path in it reaches
          // one today, but this promise is the only thing that will ever
          // release the routine, so a hold resting on that staying true is a
          // hold for the life of the process. Before single-flight the same
          // hang left stale running state and the next window fired anyway;
          // waiting on one event turned a self-healing failure into a
          // permanent one, which is why this reads both.
          //
          // A RETRYABLE ERROR IS NOT AN ENDING. The turn is still going, and
          // releasing here would let a second run start alongside the first,
          // which is the fault this whole file exists to prevent.
          if (ev.type === 'error' && !ev.willRetry) resolve('failed');
        });
      });
      return status === 'completed';
    })().then(recordOutcome, (err) => {
      console.error(`[Scheduler] Codex routine "${routine.name}" failed to run: ${err.message}`);
      // The same reason the line above prints. Printing it and then dropping it
      // left the record saying only that something failed, next to a log line
      // saying exactly what, which is the half a maintainer needs.
      recordOutcome(false, err);
    });
    return;
  }

  // Routines run unattended (no user to approve), so bypass permissions.
  const args = [...getBareArgs(), ...modelArgs(agent), '--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  // THE RUN NAMES ITS OWN SESSION, and this one flag is the whole of how
  // anything can find out what the run did afterwards. The agent tool writes
  // a transcript named for the session; a run that let the tool choose the
  // name would announce it on the output stream, which goes to the null
  // device and is never read. Guessing from what changed last is the failure
  // this avoids: it is silent, and the answer looks right.
  //
  // NOTHING ABOUT THE OUTPUT MOVES. The output format, the verbosity and the
  // three ignored descriptors below are exactly as they were: this adds an
  // identity to the invocation, not a way to listen to it.
  if (run.sessionId) args.push('--session-id', run.sessionId);
  if (agent.id !== 'default') args.push('--agent', agent.id);
  args.push(routine.prompt);

  // THE CHILD'S OUTPUT IS DISCARDED, AND THAT IS THE WHOLE OF WHAT THIS LINE
  // DECIDES. 'ignore' hands the child /dev/null, so it can print as much as it
  // likes and every write completes.
  //
  // It was ['ignore', 'pipe', 'pipe'] with nothing attached to either pipe.
  // Node's stdio streams start paused, so nothing drained the pipe and the
  // kernel buffer filled. From there the child cannot get its bytes out, and
  // what that looks like depends on the platform and on how the child writes:
  // a blocking descriptor stops inside the write call, while an asynchronous
  // one returns and queues the bytes in the child's own memory. Node makes
  // stdout and stderr blocking for pipes on Windows only, and leaves them
  // asynchronous on every POSIX platform including Linux (Node's own lib/net.js
  // guards it on isWindows, and its process I/O documentation states the same
  // split), and
  // a child that is not Node has its own answer again. LOOKED UP RATHER THAN
  // REASONED OUT, because this sentence has now been written wrongly twice by
  // people each reasoning from the machine in front of them.
  //
  // None of that changes the ending: the writes never complete and the child
  // never exits. What it changes is the conclusion you are allowed to draw
  // about sizes, which is that there is no safe volume, only a volume small
  // enough that the buffer happened to take it. 128 KB of output finished in
  // 26 ms here and 160 KB never finished at all.
  //
  // A child that never exits never closes, so no outcome was recorded, the
  // single-flight hold below was never released, and the guard refused that
  // routine on every later tick for the life of the process. Its record stayed
  // open and read as interrupted after a restart, reporting a run that was cut
  // short when what happened is that we stopped listening. Verbose output
  // passes 160 KB on the opening enumeration of the available tools alone,
  // before the model has said anything.
  //
  // IF YOU ARE HERE TO CAPTURE A ROUTINE'S OUTPUT, this is what has to be true
  // before you put 'pipe' back in either slot. BOTH slots: stderr is the same
  // hazard as stdout and it is the likelier edit, because the outcome handler
  // below observes that a non-zero exit says nothing about why, and capturing
  // stderr to answer that is one word here. An unread stderr pipe hangs a
  // routine exactly as an unread stdout pipe does.
  //
  // The reader is attached in the same statement that opens the pipe, never a
  // tick later, because the child can fill the buffer before your listener is
  // registered. It stays attached for the whole life of the child, including
  // on every path that ends the run early, and whatever it does with the bytes
  // it must always consume them: a filter that stops reading once it has what
  // it wants is the same deadlock wearing a different hat. If any of that is
  // more than you want to own, drain with resume() and read nothing, or leave
  // this line alone. An unread pipe is not output waiting to be collected
  // later; it is a routine that stops running.
  const proc = spawnClaude(args, {
    cwd: getWorkspace(),
    env: getSpawnEnv(null),
    stdio: ['ignore', 'ignore', 'ignore']
  });

  // Both ends of a child are outcomes, and the routine is released by whichever
  // arrives first.
  //
  // Listening to close alone would rest on close always following error. That
  // holds for a binary that is not there, and it is not established for the
  // failures a tick is most likely to meet: under file-descriptor exhaustion
  // the handle is torn down early, and whether it still closes is a question
  // about a Node version rather than about this file. A routine held on the
  // answer being yes would be held for the life of the process, because
  // nothing else would ever remove it. Listening to both removes the question.
  // The error event carries an Error and the close event carries a number, and
  // that difference is why only one of them passes a reason on. A child that
  // never launched is described entirely by the message it came with; a child
  // that ran and exited non-zero said whatever it said to a stream that goes
  // nowhere, and an exit code is not a message.
  // WHAT STOPPING A CLAUDE RUN MEANS, and it is the whole tree rather than the
  // one process. An agent CLI spawns its own children, an MCP server per
  // configured entry plus a subprocess per tool, and those are grandchildren
  // nothing here holds a handle on: signalling the leader alone leaves them
  // running and reparented, holding memory until the machine restarts. The
  // signaller walks the group for exactly that reason and is the same one the
  // rest of the server stops children with.
  //
  // Armed here rather than at the top of the function because this is where
  // there is something to signal. A stop that arrived before this line is
  // remembered on the run and honoured by this call.
  armRunStopper(run, () => killProcessTree(proc, 'SIGTERM'), () => killProcessTree(proc, 'SIGKILL'));

  proc.on('error', (err) => recordOutcome(false, err));
  proc.on('close', (code) => recordOutcome(code === 0));
}

function broadcastRoutineUpdate() {
  const agents = discoverAgents();
  // THE WORKSPACE THE ROSTER WAS READ FROM travels with it, because this is
  // the one roster message that reaches windows which did not ask for it. A
  // window opened on another workspace is handed these rows, and without the
  // workspace beside them it has no way to tell whether what it is drawing is
  // what the scheduler is serving.
  const msg = JSON.stringify({ type: 'agents', agents, workspace: getWorkspace() });
  deps.getWssClients().forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

module.exports = {
  wireSchedulerDeps,
  routineState, loadRoutineState, saveRoutineState, recordRoutineRun,
  routineSlots, loadRoutineSlots, saveRoutineSlots,
  nextRunFor, lastRunStartedAt, routineDisplayFacts,
  readRunRecords, readRunProgress,
  runningRuns, cancelRun, routineRefusal, statusesTheSchedulerRecords,
  startScheduler, stopScheduler, schedulerRunning, getNextRun, executeRoutine,
};
