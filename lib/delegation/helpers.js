'use strict';
// Helpers: the Agent calls a lead starts beside itself rather than handing over.
//
// A lead's Agent calls in one message are decided together. One teammate call
// is a handoff, as it has always been: the teammate takes over. Anything else
// is a batch of helpers, and each helper call is checked here before it
// starts. A call that may not start is named back to the lead with its own
// reason, so the lead can do that part itself or say why it wasn't done.

const { discoverAgents } = require('../agents/discovery.js');
const { findDirectReportMatch, findOffRosterWorkspaceMatch } = require('../agents/prompt.js');
const { readConversations, writeConversations } = require('../store/persistence.js');

// Claude Code's own helper types, spelled exactly as Claude Code spells them.
// An untyped call is a general helper too.
const BUILTIN_TYPES = ['general-purpose', 'Explore', 'Plan', 'web-fetch'];
const TASK_MAX = 80;

const NOTICES = {
  fromHelper: "Helpers can't start helpers. Do this part yourself, and say in your report what you would have handed on.",
  fork: "Each helper starts from its brief, so a copy of this conversation can't be started. Write a brief for this part, or do it yourself.",
  statusline: "statusline-setup changes the person's Claude Code settings, so it can't run here. Do this part yourself.",
  unmatched: "This call couldn't be matched to the lead's message, so it didn't start. Do this part yourself.",
  denied: 'The person chose not to start these teammates. Ask them how they want to go on.',
  cap: 'At most five helpers run at once. Wait for these to report back, then start the rest.',
};

const nameOf = (agent) => agent.displayName || agent.name;
const refused = (notice) => ({ kind: 'refused', notice });

// The short task a helper is shown with: the call's description on one line,
// cut at a word to at most TASK_MAX characters including the closing mark.
// An empty description gives the brief's first non-empty line instead.
function helperTask(description, prompt) {
  const squash = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  let text = squash(description);
  if (!text) text = squash(String(prompt == null ? '' : prompt).split(/\r?\n/).find((line) => line.trim()) || '');
  if (text.length <= TASK_MAX) return text;
  const cut = text.lastIndexOf(' ', TASK_MAX - 1);
  return `${text.slice(0, cut > 0 ? cut : TASK_MAX - 1)}…`;
}

// Who leads an agent outside the caller's team: its own leader, or else the
// workspace's orchestrator, which leads every agent that names no leader.
function leaderOf(agent, agents) {
  const named = agent.reportsTo && agents.find((a) => a.id === agent.reportsTo || a.name === agent.reportsTo);
  if (named) return named;
  const orchestrator = agents.find((a) => a.status === 'onTeam' && a.type === 'orchestrator');
  return orchestrator && orchestrator.id !== agent.id ? orchestrator : null;
}

// One helper call, checked in a fixed order; the first check that applies
// gives the answer. `fromHelper` is a call a helper made, and `stopped` holds
// the ids of teammates the person stopped. Returns { kind: 'refused', notice },
// { kind: 'teammate', type, agent, name } or { kind: 'builtin', type }.
function classifyCall(leadId, input, { fromHelper = false, stopped = null } = {}) {
  const call = input || {};
  const type = call.subagent_type ? String(call.subagent_type) : null;
  const general = !type || type === 'general-purpose';
  const agents = discoverAgents();
  const lead = agents.find((a) => a.id === leadId) || { id: leadId, name: leadId };
  if (fromHelper) return refused(NOTICES.fromHelper);
  if (type === 'fork') return refused(NOTICES.fork);
  const wanted = type && type.toLowerCase();
  if (wanted && [lead.name, lead.id, lead.displayName].some((n) => n && String(n).toLowerCase() === wanted)) {
    const n = nameOf(lead);
    return refused(`${n} can't be ${n}'s own helper. Do this part yourself.`);
  }
  // A general call names a teammate only through its description; its brief
  // may mention anyone.
  const teammate = general
    ? findDirectReportMatch(leadId, { description: call.description || '' })
    : findDirectReportMatch(leadId, { subagent_type: type });
  if (teammate && stopped && stopped.has(teammate.id)) {
    const n = nameOf(teammate);
    return refused(`The person stopped ${n}. Don't restart ${n}; say plainly that ${n}'s part wasn't done.`);
  }
  if (type === 'statusline-setup') return refused(NOTICES.statusline);
  if (teammate && (general || type !== teammate.name)) {
    const words = `To start ${nameOf(teammate)}, set the agent to ${teammate.name}.`;
    return refused(general ? `${words} A general helper can't work as ${nameOf(teammate)}.` : words);
  }
  const outside = type && findOffRosterWorkspaceMatch(leadId, { subagent_type: type });
  if (outside) {
    const n = nameOf(outside);
    const leader = leaderOf(outside, agents);
    if (!leader) return refused(`${n} isn't on your team, so you can't start ${n}. Do this part yourself.`);
    const l = nameOf(leader);
    return refused(`${n} works for ${l}, so only ${l} can start ${n}. Do this part yourself, or say that this part needs ${l}.`);
  }
  if (teammate && teammate.runtime === 'codex') {
    const n = nameOf(teammate);
    // Alone, a call naming it is still a handoff (placeCalls).
    return { ...refused(`${n} runs on another runtime, so ${n} can't work as a helper. Hand over to ${n} once your helpers finish, or do this part yourself.`), handoff: true };
  }
  if (teammate) return { kind: 'teammate', type, agent: teammate.id, name: nameOf(teammate) };
  if (!type || BUILTIN_TYPES.includes(type)) return { kind: 'builtin', type };
  return refused(`${type} isn't on this workspace's team. Do this part yourself.`);
}

// A lead's Agent calls in one message, decided together. `calls` are
// { id, input } in message order. Every call is checked first. One call that
// names one of the lead's own teammates exactly, by agent name, and is not
// sent to the background stays a handoff, so everything that path does is
// unchanged; that includes a teammate on another runtime. Anything else is a
// batch of helpers, each call with its own verdict, so a lone call that names
// a teammate any other way, or names the lead itself, a stopped teammate or
// an agent off the team, is refused through the hook with its reason.
function placeCalls(leadId, calls, { stopped = null, busy = false } = {}) {
  const placed = calls.map(({ id, input }) => ({ id, input, verdict: classifyCall(leadId, input, { stopped }) }));
  const lone = placed.length === 1 ? placed[0] : null;
  if (lone && !busy && (lone.input || {}).run_in_background !== true
    && (lone.verdict.kind === 'teammate' || lone.verdict.handoff === true)) return { kind: 'handoff' };
  return { kind: 'helpers', calls: placed };
}

// The card is raised through the server's own permission request, wired in
// at boot (server.js).
const deps = { requestServerPermission: null };
function wireHelpersDeps(next) {
  const prev = { ...deps };
  Object.assign(deps, next);
  return prev;
}

// Per conversation: the lead's latest message with Agent calls, the call ids
// of earlier ones, the ids already answered, hook requests that arrived
// before the message ended, and the teammates the person stopped.
const conversations = new Map();
const stateOf = (convoId) => conversations.get(convoId);
function stateFor(convoId) {
  let state = conversations.get(convoId);
  if (!state) {
    state = { latest: null, earlier: new Set(), answered: new Set(), waiting: [], stopped: new Set() };
    conversations.set(convoId, state);
  }
  return state;
}

// Called by the engine when a lead's message with Agent calls ends. Returns
// the placement; the engine runs today's handoff only for kind 'handoff'.
function placeMessage(convoId, entry, calls) {
  const state = stateFor(convoId);
  const placement = {
    ...placeCalls(entry.agentId, calls, { stopped: state.stopped, busy: helpersBusy(convoId) }),
    lead: entry.agentId, ids: calls.map((c) => c.id), leadProcess: entry.process || null,
  };
  if (state.latest) for (const id of state.latest.ids) state.earlier.add(id);
  state.latest = placement;
  state.waiting = state.waiting.filter((w) => {
    if (w.askedBy !== placement.lead || !placement.ids.includes(w.id)) return true;
    w.found(placement);
    return false;
  });
  return placement;
}

// The leads the person has said yes to in this conversation, kept on its
// record so a reopened conversation does not ask again. Written only here.
function allowedLeads(convoId) {
  const record = readConversations().find((c) => c && c.id === convoId);
  return record && Array.isArray(record.helpersAllowed) ? record.helpersAllowed : [];
}
function allowLead(convoId, leadId) {
  const convos = readConversations();
  let record = convos.find((c) => c && c.id === convoId);
  if (!record) { record = { id: convoId }; convos.unshift(record); }
  const list = Array.isArray(record.helpersAllowed) ? record.helpersAllowed : [];
  if (list.includes(leadId)) return;
  record.helpersAllowed = [...list, leadId];
  writeConversations(convos);
}

// One card for a batch that starts teammates, from a lead the person has not
// said yes to yet. Every request of the batch waits on the same answer.
function batchAnswer(convoId, placement) {
  if (placement.answer) return placement.answer;
  const teammates = placement.calls.filter((c) => c.verdict.kind === 'teammate');
  if (!teammates.length || allowedLeads(convoId).includes(placement.lead)) {
    placement.answer = Promise.resolve({ allow: true });
    return placement.answer;
  }
  placement.answer = new Promise((resolve) => {
    deps.requestServerPermission({
      convoId, agentId: placement.lead, toolName: 'Agent', toolInput: {},
      grading: { helpers: teammates.map((c) => ({ agent: c.verdict.agent, task: helperTask(c.input.description, c.input.prompt) })) },
      onDecision: (allow, reason, extra) => {
        if (allow) {
          try { allowLead(convoId, placement.lead); } catch (e) { console.warn(`[Helpers] Could not keep the yes for ${placement.lead}: ${e.message}`); }
          resolve(extra && extra.card ? { allow: true, card: true } : { allow: true });
        } else if (reason === 'user') resolve({ allow: false, notice: NOTICES.denied });
        else resolve({ allow: false, reason: reason || 'denied' });
      },
    });
  });
  return placement.answer;
}

// A handoff's own call never starts: the lead is ended and the teammate takes
// over, so its request is answered once the lead's process has gone.
function whenEnded(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) { resolve(); return; }
    proc.once('exit', () => resolve());
    proc.once('close', () => resolve());
  });
}

// A hook request for an Agent call: matched by its tool_use_id to the lead's
// current or just-ended message in this conversation, then answered by that
// message's placement. `askedBy` is the agent the hook's token was issued to.
async function answerAgentRequest({ convoId, askedBy, data }) {
  if (typeof data.agent_id === 'string') return { allow: false, notice: NOTICES.fromHelper };
  const unmatched = { allow: false, notice: NOTICES.unmatched };
  const id = typeof data.tool_use_id === 'string' && data.tool_use_id ? data.tool_use_id : null;
  if (!id || !convoId || !askedBy) return unmatched;
  const state = stateFor(convoId);
  if (state.answered.has(id) || state.earlier.has(id)) return unmatched;
  const latest = state.latest;
  const placement = latest && latest.lead === askedBy && latest.ids.includes(id)
    ? latest
    : await new Promise((resolve) => {
      const waiter = { id, askedBy, found: (p) => { clearTimeout(waiter.timer); resolve(p); } };
      waiter.timer = setTimeout(() => {
        state.waiting = state.waiting.filter((w) => w !== waiter);
        resolve(null);
      }, module.exports.MATCH_WAIT_MS);
      state.waiting.push(waiter);
    });
  if (!placement || state.answered.has(id)) return unmatched;
  state.answered.add(id);
  if (placement.kind === 'handoff') return whenEnded(placement.leadProcess).then(() => ({ allow: false }));
  const verdict = placement.calls.find((c) => c.id === id).verdict;
  if (verdict.kind === 'refused') return { allow: false, notice: verdict.notice };
  return batchAnswer(convoId, placement).then((answer) => (answer.allow ? admit(convoId, placement, id, answer) : answer));
}

// Called by the engine when a lead begins a new message, with or without
// Agent calls. Its message before is over: a request for one of that
// message's calls is refused as unmatched from now on. A request still
// waiting for its own message to end keeps waiting.
function messageBegun(convoId, leadId) {
  const state = conversations.get(convoId);
  if (!state || !state.latest || state.latest.lead !== leadId) return;
  for (const id of state.latest.ids) state.earlier.add(id);
  state.latest = null;
}

// RUNNING HELPERS. Per conversation, one row for each helper its lead has
// started in the open request: { toolUseId, agent, kind, task, state, step }.
// The count is the rows whose state is 'running': calls answered allow, which
// count from their answer, and helpers Claude Code reports started, until a
// final state. The page is sent the rows on every change (helpers_changed),
// through the server's own sender, wired in at boot (server.js).
const FINAL = { completed: 'completed', killed: 'killed', failed: 'failed', stopped: 'killed' };
const TASK_LINES = ['task_started', 'task_progress', 'task_updated', 'task_notification'];
const runs = new Map();
function runFor(convoId) {
  let run = runs.get(convoId);
  if (!run) {
    run = { lead: null, proc: null, rows: new Map(), tasks: new Map(), held: [], capRefused: false, after: [] };
    runs.set(convoId, run);
  }
  return run;
}

function runningCount(convoId) {
  const run = runs.get(convoId);
  let n = 0;
  if (run) for (const row of run.rows.values()) if (row.state === 'running') n += 1;
  return n;
}

function helperRows(convoId) {
  const run = runs.get(convoId);
  return run ? [...run.rows.values()].map((row) => ({ ...row })) : [];
}

function changed(convoId) {
  const run = runs.get(convoId);
  if (!run || !module.exports.HELPERS_ENABLED || typeof deps.safeSend !== 'function') return;
  deps.safeSend(JSON.stringify({ type: 'helpers_changed', _conversationId: convoId, agentId: run.lead, helpers: helperRows(convoId) }));
}

function rowOf(toolUseId, verdict, input) {
  const call = input || {};
  const teammate = verdict.kind === 'teammate';
  return {
    toolUseId,
    agent: teammate ? verdict.agent : (verdict.type || call.subagent_type || 'general-purpose'),
    kind: teammate ? 'teammate' : 'builtin',
    task: helperTask(call.description, call.prompt),
    state: 'running',
    step: null,
  };
}

function leadOf(run, lead, proc) {
  run.lead = lead;
  run.proc = proc || null;
}

// A call answered allow is counted from its answer, before Claude Code
// reports it started. One that would make a sixth is held (capped below).
function admit(convoId, placement, id, answer) {
  const run = runFor(convoId);
  const call = placement.calls.find((c) => c.id === id);
  leadOf(run, placement.lead, placement.leadProcess);
  const full = runningCount(convoId) >= HELPER_CAP;
  run.rows.set(id, rowOf(id, call.verdict, call.input));
  if (!full) { changed(convoId); return answer; }
  return capped(convoId, run, id, answer);
}

// A helper's end, once, whichever line reports it first.
function finish(convoId, toolUseId, state) {
  const run = runs.get(convoId);
  const row = run && run.rows.get(toolUseId);
  if (!row || row.state !== 'running') return;
  row.state = state;
  startHeld(convoId, run);
  changed(convoId);
}

// A task_* line from the lead's stream. Returns true for one. A task is linked
// to its call by tool_use_id; a task_started whose call is not known is
// counted all the same. A background shell is not a helper.
function readTaskLine(convoId, entry, parsed) {
  if (!parsed || parsed.type !== 'system' || !TASK_LINES.includes(parsed.subtype)) return false;
  if (parsed.task_type === 'local_bash') return true;
  const run = runFor(convoId);
  const taskId = parsed.task_id == null ? null : String(parsed.task_id);
  const linked = taskId && run.tasks.get(taskId);
  const id = (typeof parsed.tool_use_id === 'string' && parsed.tool_use_id) || linked || (taskId && `task:${taskId}`);
  if (!id) return true;
  if (taskId && !linked) run.tasks.set(taskId, id);
  const row = run.rows.get(id);
  if (parsed.subtype === 'task_started') {
    if (row) return true;
    const input = { subagent_type: parsed.subagent_type, description: parsed.description };
    leadOf(run, entry.agentId, entry.process);
    run.rows.set(id, rowOf(id, classifyCall(entry.agentId, input), input));
    changed(convoId);
  } else if (parsed.subtype === 'task_progress') {
    if (!row || row.state !== 'running' || !parsed.last_tool_name) return true;
    row.step = String(parsed.last_tool_name);
    changed(convoId);
  } else {
    const status = parsed.status || (parsed.patch && parsed.patch.status);
    if (FINAL[status]) finish(convoId, id, FINAL[status]);
  }
  return true;
}

// Another runtime reports its helpers into the same count: noteStarted when
// one starts, noteEnded with 'completed', 'killed' or 'failed' when it ends.
function noteStarted(convoId, { lead, proc = null }, { toolUseId, agent, kind = 'builtin', task = '' }) {
  const run = runFor(convoId);
  if (run.rows.has(toolUseId)) return;
  leadOf(run, lead, proc);
  run.rows.set(toolUseId, { toolUseId, agent, kind, task: helperTask(task), state: 'running', step: null });
  changed(convoId);
}
function noteEnded(convoId, toolUseId, state) {
  finish(convoId, toolUseId, FINAL[state] || 'failed');
}

// THE CAP. At most HELPER_CAP helpers run at once in a conversation. A call
// that would make one more is held, its hook request left open, and held calls
// start in the order they arrived as slots free. One still held after
// HELPER_HOLD_MS is refused, and the open request remembers it: a lone
// teammate call later in the request is a helper, not a handoff. Each hold,
// start and refusal is recorded with its outcome and nothing else.
const HELPER_CAP = 5;
const signals = require('../signals.js');
function capEvent(convoId, run, outcome) {
  signals.recordEvent('helper_cap', { conv: convoId, agent: run.lead, d: { outcome } });
}

function capped(convoId, run, id, answer) {
  run.rows.get(id).state = 'waiting';
  capEvent(convoId, run, 'held');
  changed(convoId);
  return new Promise((resolve) => {
    const hold = { id, answer: resolve, allow: answer };
    hold.timer = setTimeout(() => {
      run.held = run.held.filter((h) => h !== hold);
      run.rows.delete(id);
      run.capRefused = true;
      capEvent(convoId, run, 'refused');
      changed(convoId);
      resolve({ allow: false, notice: NOTICES.cap });
    }, module.exports.HELPER_HOLD_MS);
    run.held.push(hold);
  });
}

function startHeld(convoId, run) {
  while (run.held.length && runningCount(convoId) < HELPER_CAP) {
    const hold = run.held.shift();
    clearTimeout(hold.timer);
    run.rows.get(hold.id).state = 'running';
    capEvent(convoId, run, 'started');
    hold.answer(hold.allow);
  }
}

// Placement rows 4 and 5: while any helper runs, or after a cap refusal in
// the open request, a lone teammate call is a helper.
function helpersBusy(convoId) {
  const run = runs.get(convoId);
  return !!run && (run.capRefused || runningCount(convoId) > 0);
}

// The lead's process has closed, for any reason: every held call is refused,
// its helpers ended with it, and the request is over. A close of any other
// process in the conversation leaves them be.
function leadClosed(convoId, proc) {
  const run = runs.get(convoId);
  if (!run || (proc && run.proc && run.proc !== proc)) return;
  for (const hold of run.held) { clearTimeout(hold.timer); hold.answer({ allow: false }); }
  run.held = [];
  for (const [id, row] of run.rows) {
    if (row.state === 'waiting') run.rows.delete(id);
    else if (row.state === 'running') row.state = 'killed';
  }
  changed(convoId);
  runs.delete(convoId);
}

// THE OPEN REQUEST. While a lead's helpers run, its result ends a turn but not
// the request: the caller holds the result's done and idle, and each step the
// result would have set off (a return, an auto-return, a kill) waits here. A
// helper's end wakes the lead for its next turn. The first result after the
// count reaches zero ends the request, and each held step then acts as it
// would have. A step that arrives after the last helper ends but before that
// result is held too, since the request is still open.
function helping(convoId) {
  return !!module.exports.HELPERS_ENABLED && runningCount(convoId) > 0;
}

// The lead's result: true when it ends only a turn, because helpers run.
function turnHeld(convoId) {
  if (!helping(convoId)) return false;
  runs.get(convoId).resultHeld = true;
  return true;
}

// Holds `act` until the request ends. False when nothing holds it, and the
// caller acts now as it always has.
function holdWhileHelping(convoId, act) {
  const run = module.exports.HELPERS_ENABLED && runs.get(convoId);
  if (!run || (!helping(convoId) && !run.resultHeld)) return false;
  run.after.push(act);
  return true;
}

// The lead's result with no helper running: the request is over.
function requestEnded(convoId) {
  const run = module.exports.HELPERS_ENABLED && runs.get(convoId);
  if (!run || helping(convoId)) return;
  runs.delete(convoId);
  for (const act of run.after) {
    try { act(); } catch (e) { console.error('[Helpers] a held step failed:', e && e.message); }
  }
}

// A row of active_processes: the lead's helpers, and busy while they run.
function activeRow(convoId, row) {
  if (!module.exports.HELPERS_ENABLED) return row;
  return { ...row, helpers: helperRows(convoId), idle: helping(convoId) ? false : row.idle };
}

module.exports = {
  // Off until helpers work end to end. Every reader reads it through this
  // module at use time, never copied to a local, so a test can turn it on
  // after the server has loaded. Nothing a caller sends or writes sets it.
  HELPERS_ENABLED: false,
  // How long a hook request waits for the lead's message to end, in
  // milliseconds. Read at use time, like the switch.
  MATCH_WAIT_MS: 2000,
  BUILTIN_TYPES, NOTICES,
  helperTask, classifyCall, placeCalls, placeMessage, answerAgentRequest, stateOf, wireHelpersDeps,
  messageBegun,
  runningCount, helperRows, readTaskLine, noteStarted, noteEnded,
  // How long a call held at the cap waits for a slot before it is refused,
  // in milliseconds. Read at use time, like the switch.
  HELPER_HOLD_MS: 100000,
  HELPER_CAP, leadClosed,
  helping, turnHeld, holdWhileHelping, requestEnded, activeRow,
};
