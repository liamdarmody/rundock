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
const { getWorkspace } = require('./config.js');
const { rundockDir } = require('./store/persistence.js');
const { recordEvent } = require('./signals.js');
const { buildSystemPrompt } = require('./agents/prompt.js');
const { getCodexAppServer, waitForCodexReady, readAgentInstructions } = require('./runtime/codex-glue.js');
const { discoverAgents } = require('./agents/discovery.js');
const { isRunOnSupported } = require('./agents/routines.js');
const { spawnClaude, getBareArgs, modelArgs, getSpawnEnv } = require('./runtime/claude.js');

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

const routineState = {}; // { routineKey: { lastRun, status, duration } }

function loadRoutineState() {
  for (const key of Object.keys(routineState)) delete routineState[key];
  // The runs being dropped here belong to the workspace being left, and so do
  // the announcements. This is the workspace-switch path.
  announcedRefusals.clear();
  try {
    const file = path.join(rundockDir(), 'routine-state.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    for (const [key, state] of Object.entries(saved)) {
      if (!state || typeof state.lastRun !== 'string') continue;
      // A run that was 'running' when the server died never finished; surface
      // that honestly. lastRun stays, so the run still suppresses a re-fire
      // (the work was started; firing it again is the bug this file prevents).
      if (state.status === 'running') state.status = 'interrupted';
      routineState[key] = state;
    }
  } catch (e) { /* missing or unreadable file: start empty */ }
}

function saveRoutineState() {
  const dir = rundockDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'routine-state.json'), JSON.stringify(routineState, null, 2));
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
function routineRefusal(routine) {
  if (routine.paused) return 'paused';
  if (!routine.enabled) return 'enabled';
  if (!isRunOnSupported(routine.runOn)) return 'runOn';
  return null;
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

    const onRoster = new Set();

    for (const agent of agents) {
      if (!agent.routines) continue;
      for (const routine of agent.routines) {
        const key = `${agent.id}:${routine.name}`;
        onRoster.add(key);
        const refusedBy = routineRefusal(routine);
        if (!refusedBy) announcedRefusals.delete(key);
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
          if (executeRoutine(agent, routine, key)) {
            console.log(`[Scheduler] Running routine: ${routine.name} (${agent.name})`);
          } else {
            // Said on every held tick rather than once, unlike a refusal. A
            // hold lasts exactly as long as one run, so the only way to hear
            // this twice is a run that has outlived its window, which is worth
            // saying every time it is true. A refusal can stay true for months.
            console.log(`[Scheduler] Not starting routine: ${routine.name} (${agent.name}): its previous run has not finished`);
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

function getNextRun(schedule, lastRunISO) {
  if (!schedule) return null;
  const now = deps.now();
  const s = schedule.toLowerCase();

  // Parse "every day at HH:MM"
  const dailyMatch = s.match(/every day at (\d{2}):(\d{2})/);
  if (dailyMatch) {
    // Don't re-run if already ran today. This suppression (fed by the
    // persisted routine state) is the ONLY thing standing between a due
    // routine and a duplicate fire, which is why it is checked first.
    if (lastRunISO) {
      const lastRun = new Date(lastRunISO);
      if (lastRun.toDateString() === now.toDateString() && lastRun.getHours() >= parseInt(dailyMatch[1])) return null;
    }
    const target = new Date(now);
    target.setHours(parseInt(dailyMatch[1]), parseInt(dailyMatch[2]), 0, 0);
    // A target already past today stays TODAY: the scheduler's `now >= nextRun`
    // check fires it on the next tick (same-day catch-up). The previous code
    // rolled it to tomorrow, which meant the fire condition was only
    // satisfiable in the single millisecond HH:MM:00.000 - routines whose
    // tick did not land exactly on that instant never fired at all.
    return target;
  }

  // Parse "every [weekday] at HH:MM"
  const weeklyMatch = s.match(/every (\w+) at (\d{2}):(\d{2})/);
  if (weeklyMatch) {
    const days = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    const targetDay = days[weeklyMatch[1]];
    if (targetDay === undefined) return null;
    // Suppression first, same reasoning as the daily branch.
    if (lastRunISO) {
      const lastRun = new Date(lastRunISO);
      const daysSinceLastRun = (now - lastRun) / (1000 * 60 * 60 * 24);
      if (daysSinceLastRun < 1 && lastRun.getDay() === targetDay) return null;
    }
    const target = new Date(now);
    target.setHours(parseInt(weeklyMatch[2]), parseInt(weeklyMatch[3]), 0, 0);
    const daysUntil = (targetDay - now.getDay() + 7) % 7;
    target.setDate(target.getDate() + daysUntil);
    // On the target weekday a past-due target stays TODAY so the scheduler
    // fires it (same-day catch-up); the suppression above prevents re-fires.
    // See the daily branch for why the old roll-forward meant never firing.
    return target;
  }

  return null;
}

/**
 * Start a run of `routine`, unless one is already in flight for it.
 *
 * The guard lives HERE rather than in the tick so that a second entry point (a
 * run-now button, say) cannot start a run the tick would have refused. The
 * return value is what the tick reads to say why nothing happened; it is not
 * an error, because a held routine is a normal state rather than a fault.
 */
function executeRoutine(agent, routine, key) {
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  try {
    beginRun(agent, routine, key);
  } catch (err) {
    // A start that throws leaves no child, so no close event and no outcome,
    // so nothing that will ever release. Held forever is how a guard turns
    // into a routine that never runs again, and it takes no bug in the guard
    // to get there. Rethrown once the routine is free: what the caller does
    // about a failed start is unchanged by this file.
    inFlight.delete(key);
    throw err;
  }
  return true;
}

function beginRun(agent, routine, key) {
  const startTime = deps.now().getTime();
  // Persisted immediately: if the server dies mid-run, the restarted process
  // still knows the run started and will not fire it again in the same window.
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
  let recorded = false;
  const recordOutcome = (ok) => {
    if (recorded) return;
    recorded = true;
    inFlight.delete(key);
    const duration = Math.round((deps.now().getTime() - startTime) / 1000);
    recordRoutineRun(key, {
      lastRun: deps.now().toISOString(),
      status: ok ? 'completed' : 'failed',
      duration
    });
    console.log(`[Scheduler] Routine "${routine.name}" ${ok ? 'completed' : 'failed'} (${duration}s)`);
    recordEvent('routine_run', { agent: agent.id, runtime: agent.runtime || 'claude', d: { routine: routine.name, status: ok ? 'completed' : 'failed', duration } });
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
      const { threadId } = await server.startThread({
        cwd: getWorkspace(),
        model: agent.model || undefined,
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
      });
      const sub = server.startTurn(threadId, routinePrompt);
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
      recordOutcome(false);
    });
    return;
  }

  // Routines run unattended (no user to approve), so bypass permissions.
  const args = [...getBareArgs(), ...modelArgs(agent), '--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  if (agent.id !== 'default') args.push('--agent', agent.id);
  args.push(routine.prompt);

  const proc = spawnClaude(args, {
    cwd: getWorkspace(),
    env: getSpawnEnv(null),
    stdio: ['ignore', 'pipe', 'pipe']
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
  proc.on('error', () => recordOutcome(false));
  proc.on('close', (code) => recordOutcome(code === 0));
}

function broadcastRoutineUpdate() {
  const agents = discoverAgents();
  const msg = JSON.stringify({ type: 'agents', agents });
  deps.getWssClients().forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

module.exports = {
  wireSchedulerDeps,
  routineState, loadRoutineState, saveRoutineState, recordRoutineRun,
  startScheduler, stopScheduler, getNextRun, executeRoutine,
};
