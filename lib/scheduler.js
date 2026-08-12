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
const fs = require('fs');
const path = require('path');
const { getWorkspace } = require('./config.js');
const { rundockDir } = require('./store/persistence.js');
const { recordEvent } = require('./signals.js');
const { buildSystemPrompt } = require('./agents/prompt.js');
const { getCodexAppServer, waitForCodexReady, readAgentInstructions } = require('./runtime/codex-glue.js');
const { discoverAgents } = require('./agents/discovery.js');
const { spawnClaude, getBareArgs, modelArgs, getSpawnEnv } = require('./runtime/claude.js');

const unwired = (name) => () => {
  throw new Error(`lib/scheduler: ${name} not wired (call wireSchedulerDeps at boot)`);
};
const deps = {
  getWssClients: unwired('getWssClients'),  // () => wss.clients (created at boot)
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

function startScheduler() {
  const checkInterval = 60 * 1000; // Check every 60 seconds

  setInterval(() => {
    const agents = discoverAgents();
    const now = new Date();

    for (const agent of agents) {
      if (!agent.routines) continue;
      for (const routine of agent.routines) {
        const key = `${agent.id}:${routine.name}`;
        const nextRun = getNextRun(routine.schedule, routineState[key]?.lastRun);
        if (nextRun && now >= nextRun) {
          console.log(`[Scheduler] Running routine: ${routine.name} (${agent.name})`);
          executeRoutine(agent, routine, key);
        }
      }
    }
  }, checkInterval).unref(); // see heartbeat unref note: listener keeps process alive in production
}

function getNextRun(schedule, lastRunISO) {
  if (!schedule) return null;
  const now = new Date();
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

function executeRoutine(agent, routine, key) {
  const startTime = Date.now();
  // Persisted immediately: if the server dies mid-run, the restarted process
  // still knows the run started and will not fire it again in the same window.
  recordRoutineRun(key, { lastRun: new Date().toISOString(), status: 'running', duration: null });

  // Notify connected clients
  broadcastRoutineUpdate();

  const recordOutcome = (ok) => {
    const duration = Math.round((Date.now() - startTime) / 1000);
    recordRoutineRun(key, {
      lastRun: new Date().toISOString(),
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
        sub.on('event', (ev) => { if (ev.type === 'done') resolve(ev.status); });
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
  startScheduler, getNextRun, executeRoutine,
};
