#!/usr/bin/env node
'use strict';
// Break each rule a conversation with a dead stored session depends on, in
// turn, and report which tests notice.
//
// Claude Code removes old session files. A conversation that stores one of
// those ids could not get past it: a delegation resumed it, was refused, took
// the refusal for an ordinary exit and left the id for the next delegation to
// resume. The recovery is a chain of small rules (recognize the refusal,
// forget the id everywhere it is kept, start the turn again fresh, say so in
// words), and every one of them can be deleted with the conversation still
// looking alive in most tests. That is why each is broken on purpose here and
// a test must go red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-stale-session-guards.js            # report
//   node test/tools/mutate-stale-session-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws. The harness
// is the same shape as its siblings, deliberately a separate copy: pulling
// them together means editing instruments already in the gate.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const {
  beginMutationRun, targetsFromRows, rowsForShard, exitCodeFor, NO_VERDICT,
  runSuite, didNotFinishWhy, suiteOutput,
} = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

const STALE = 'test/integration/stale-session.test.js';
// The engine: where a refusal is recognized, forgotten, and started again.
const ENGINE = { src: path.join(ROOT, 'lib', 'delegation', 'engine.js'), suite: STALE };
// The chat path's own retry, in the composition root.
const SERVER = { src: path.join(ROOT, 'server.js'), suite: STALE };
// What the store accepts back from a window, and what its load keeps.
const SAVE = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'conversations.js'), suite: STALE };
const CLEANUP = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'conversations.js'), suite: 'test/integration/conversation-metadata.test.js' };
// The rules both sides share about a record's sessions.
const CLIENT = { src: path.join(ROOT, 'public', 'conversation-state.js'), suite: 'test/unit/conversation-state.test.js' };
// The engine's stream handling, driven directly where no server run can show it.
const ENGINE_UNIT = { src: path.join(ROOT, 'lib', 'delegation', 'engine.js'), suite: 'test/unit/stream-handlers.test.js' };
// Recognizing the refusal at all, and what is kept for a turn starting again.
const RULES = { src: path.join(ROOT, 'lib', 'runtime', 'missing-session.js'), suite: 'test/unit/missing-session.test.js' };
// How a handback prompt is headed for an orchestrator starting fresh.
const CATCHUP = { src: path.join(ROOT, 'lib', 'delegation', 'catch-up.js'), suite: STALE };
// A write to a process that has stopped (a refused resume among them): where
// each child's stdin is given its handler, the handler itself, and the
// inventory that holds every write to those start paths.
const STOPPED = 'test/integration/stopped-child-write.test.js';
const SPAWN_STDIN = { src: path.join(ROOT, 'lib', 'runtime', 'claude.js'), suite: STOPPED };
const SERVER_STOPPED = { src: path.join(ROOT, 'server.js'), suite: STOPPED };
const CODEX_STDIN = { src: path.join(ROOT, 'codex-appserver.js'), suite: 'test/unit/codex-appserver-stdin.test.js' };
const STDIN_UNIT = { src: path.join(ROOT, 'lib', 'runtime', 'child-stdin.js'), suite: 'test/unit/child-stdin.test.js' };
const STDIN_INVENTORY = { src: path.join(ROOT, 'test', 'unit', 'child-stdin-inventory.test.js'), suite: 'test/unit/child-stdin-inventory.test.js' };
// A catch-up held for the next message, kept with the conversation through a
// reap or a restart, and given once.
const HELD = 'test/integration/held-catch-up.test.js';
const ENGINE_HELD = { src: ENGINE.src, suite: HELD };
const SERVER_HELD = { src: SERVER.src, suite: HELD };
const SAVE_HELD = { src: SAVE.src, suite: HELD };
const RULES_HELD = { src: RULES.src, suite: HELD };
// What Rundock did with a reply's agent and skill markers, kept with the
// conversation and told to its next turn once (lib/agents/team-notes.js).
const TEAM_NOTES = 'test/integration/team-notes.test.js';
const TEAM_NOTES_UNIT = 'test/unit/team-notes.test.js';
const NOTES = { src: path.join(ROOT, 'lib', 'agents', 'team-notes.js'), suite: TEAM_NOTES_UNIT };
const ENGINE_NOTES = { src: ENGINE.src, suite: TEAM_NOTES };
const CATCHUP_NOTES = { src: CATCHUP.src, suite: TEAM_NOTES };
const SERVER_NOTES = { src: SERVER.src, suite: TEAM_NOTES };
const LINES_NOTES = { src: path.join(ROOT, 'lib', 'delegation', 'rundock-lines.js'), suite: TEAM_NOTES_UNIT };
const CATCHUP_NOTES_UNIT = { src: CATCHUP.src, suite: TEAM_NOTES_UNIT };
// A card for each agent or skill change Doc makes while another agent brought
// it in, written only on an Allow given on that card (lib/agents/team-markers.js).
const CARDS = 'test/integration/team-handoff-cards.test.js';
const TEAM_MARKERS_SRC = path.join(ROOT, 'lib', 'agents', 'team-markers.js');
const MARKERS_CARDS = { src: TEAM_MARKERS_SRC, suite: CARDS };
const MARKERS_TURN = { src: TEAM_MARKERS_SRC, suite: 'test/unit/team-markers-turn.test.js' };
const ENGINE_CARDS = { src: ENGINE.src, suite: CARDS };
const GRADING_CARDS = { src: path.join(ROOT, 'public', 'permissions.js'), suite: 'test/unit/team-change-card.test.js' };

// ONE NAMED TEST, FOR A ROW WHOSE SUITE STARTS A SERVER. The whole
// stale-session suite takes some twenty seconds unbroken, and a broken guard
// leaves many of its tests waiting out their timeouts, so a row that ran all
// of it cost up to four minutes and the harness over half an hour: past a CI
// job's limit, with not one row reported. Such a row names the test that
// proves it (`suite#test name`), where it can one that fails on an assertion
// rather than by waiting out a timeout, and only that test runs. A name that
// matches nothing runs nothing, which turns nothing red and is reported as a
// failure.
const named = new Map();
function only(target, testName) {
  const suite = `${target.suite}#${testName}`;
  const key = `${target.src}\n${suite}`;
  if (!named.has(key)) named.set(key, { src: target.src, suite });
  return named.get(key);
}

const MUTATIONS = [
  // ===== THE REFUSAL IS RECOGNIZED, AND NEVER SHOWN RAW =====
  [only(ENGINE, 'the legacy spawn names the expired session too'), 'a refused resume is recognized from what the process was started with',
    '    const expired = refusedResume(entry.process, stderrBuf.value);',
    '    const expired = null;'],
  [only(ENGINE, 'the legacy spawn names the expired session too'), 'the raw refusal never reaches the window',
    '      putBack(convoId, entry.process);\n      return;\n    }',
    '      putBack(convoId, entry.process);\n    }'],
  [only(ENGINE, 'is still recognized, nothing of it is shown, and it is forgotten once'), 'a refusal is matched on everything the process wrote, not one chunk',
    '    const expired = refusedResume(entry.process, stderrBuf.value);',
    '    const expired = refusedResume(entry.process, text);'],
  [only(ENGINE, 'is still recognized, nothing of it is shown, and it is forgotten once'), 'stderr that could still be a refusal is held back',
    '    if (mayBeRefusal(stderrBuf.value)) { held += text; return; }\n',
    ''],
  [only(ENGINE, 'stderr that only began like a refusal is shown whole, once it is clearly something else'), 'what was held back is shown with what follows it',
    '    const shown = held + text;',
    '    const shown = text;'],
  [only(ENGINE, 'stderr that only began like a refusal is shown whole, once it is clearly something else'), 'what was held back is shown once',
    "    const shown = held + text;\n    held = '';\n",
    '    const shown = held + text;\n'],
  [only(ENGINE, 'is still recognized, nothing of it is shown, and it is forgotten once'), 'a refused process is forgotten once, however many pieces follow',
    '    if (refused) return;\n',
    ''],
  [RULES, 'stderr is judged a possible refusal on the line still being written',
    "  const so = all.slice(all.lastIndexOf('\\n') + 1).trimStart();",
    '  const so = all.trimStart();'],
  [only(ENGINE, 'stderr held back and never finished is still shown when the stream ends'), 'stderr held back and never finished is shown when the stream ends',
    "  entry.process.stderr.on('end', () => {\n    if (refused || !held) return;",
    "  entry.process.stderr.on('end', () => {\n    return;"],
  [only(ENGINE, 'is still recognized, nothing of it is shown, and it is forgotten once'), 'the opening of a refusal that was held is never shown',
    "  entry.process.stderr.on('end', () => {\n    if (refused || !held) return;",
    "  entry.process.stderr.on('end', () => {\n    if (!held) return;"],
  [RULES, 'only an opening of the refusal is held, and never nothing',
    '  return so.length > 0 && REFUSAL.startsWith(so);',
    '  return REFUSAL.startsWith(so);'],
  [RULES, 'only Claude Code\'s own refusal counts as one',
    "  if (!String(text || '').includes(REFUSAL)) return null;\n",
    ''],
  [RULES, 'a resume with no id names nothing',
    '  return at >= 0 && args[at + 1] ? args[at + 1] : null;',
    '  return at >= 0 ? args[at + 1] : null;'],

  // ===== THE DEAD ID IS FORGOTTEN EVERYWHERE IT IS KEPT =====
  [only(ENGINE, 'the legacy spawn names the expired session too'), 'the stored conversation forgets the refused session',
    '  if (found && forgetSession(found.convo, sessionId)) {',
    '  if (false) {'],
  [only(ENGINE, 'a warning on an earlier line does not let the first piece of a refusal show'), 'every open window is told to forget it',
    "  safeSend(JSON.stringify({ type: 'system', subtype: 'session_expired', sessionId, _conversationId: convoId }));\n",
    ''],
  [only(ENGINE, 'once recovered, a session that reappears is not taken back: a stale save cannot restore it'), 'the store remembers the id is gone',
    '  noteExpired(sessionId);\n',
    ''],
  [RULES, 'a noted id is remembered',
    '  if (sessionId) expired.add(sessionId);',
    ''],
  [only(SAVE, 'once recovered, a session that reappears is not taken back: a stale save cannot restore it'), 'a save cannot put a refused id back as the primary',
    'sessionId: isExpired(msg.conversation.sessionId) ? null : (msg.conversation.sessionId || null),',
    'sessionId: msg.conversation.sessionId || null,'],
  [only(SAVE, 'once recovered, a session that reappears is not taken back: a stale save cannot restore it'), 'a save cannot put a refused id back in the chain',
    'sessionIds: (msg.conversation.sessionIds || []).filter(s => !(s && isExpired(s.sessionId))),',
    'sessionIds: msg.conversation.sessionIds || [],'],
  [CLEANUP, 'a conversation with a transcript is kept when no session id is left',
    'c.sessionId || hasTranscript(c) || new Date',
    'c.sessionId || new Date'],

  // ===== THE TURN STARTS AGAIN, FRESH, ONCE =====
  [only(ENGINE, 'once recovered, a session that reappears is not taken back: a stale save cannot restore it'), 'a refused delegation starts again fresh',
    '    if (mayStartFresh(delegateEntry)) {',
    '    if (false) {'],
  [only(ENGINE, 'starts that agent fresh, briefed as an arrival, says so in plain words, and forgets the dead id'), 'a fresh delegate is briefed as an arrival',
    '    arriving: true,\n  });\n\n  delegateWire = {',
    '    arriving: false,\n  });\n\n  delegateWire = {'],
  [only(ENGINE, 'follows the brief into the fresh delegate, in order, each once'), 'a fresh delegate\'s brief holds the conversation as it stood when the delegation began',
    '      startWithoutSession(delegateEntry, convoId, delegateArgs, freshDelegateContext, delegateWire, handleDelegateClose);',
    "      startWithoutSession(delegateEntry, convoId, delegateArgs, buildDelegateContext({ missed: deltaSince(loadTranscript(convoId) || [], targetAgent.id, undefined, [], agentDisplayNames(), true), brief: msg.context, arriving: true }), delegateWire, handleDelegateClose);"],
  [only(ENGINE, 'the orchestrator starts fresh with the handback, so the request is routed instead of lost'), 'a refused handback starts the orchestrator again fresh',
    '    if (mayStartFresh(orchEntry)) {',
    '    if (false) {'],
  [only(ENGINE, 'in continue mode too, the fresh orchestrator is told the request it never saw'), 'the fresh orchestrator is handed the handback',
    '      startWithoutSession(orchEntry, convoId, args, orchFreshPrompt, orchWire, onOrchClose, orchFreshCatchUp);',
    '      startWithoutSession(orchEntry, convoId, args, null, orchWire, onOrchClose, orchFreshCatchUp);'],
  [only(ENGINE, 'a follow-up held back during the handoff reaches the fresh orchestrator, not the refused one'), 'a fresh orchestrator with no prompt of its own is given the catch-up',
    '      startWithoutSession(orchEntry, convoId, args, orchFreshPrompt, orchWire, onOrchClose, orchFreshCatchUp);',
    '      startWithoutSession(orchEntry, convoId, args, orchFreshPrompt, orchWire, onOrchClose);'],
  [only(ENGINE, 'the orchestrator starts fresh with the handback, so the request is routed instead of lost'), 'a fresh orchestrator\'s handback is headed as an arrival',
    '        mode, arriving: true, specialistId: specialistEntry.agentId, outputBlock,',
    '        mode, arriving: false, specialistId: specialistEntry.agentId, outputBlock,'],
  [only(ENGINE, 'in continue mode too, the fresh orchestrator is told the request it never saw'), 'a fresh orchestrator is given the whole conversation, its own turns included',
    '  const freshMissed = deltaSince(loadTranscript(convoId) || [], orchestrator.id, undefined, [specialistEntry.agentId], agentDisplayNames(), true);',
    '  const freshMissed = deltaSince(loadTranscript(convoId) || [], orchestrator.id, undefined, [specialistEntry.agentId], agentDisplayNames(), false);'],
  [only(CATCHUP, 'a handback paused by the circuit breaker gives the next message the catch-up instead'), 'the catch-up for a handback with no prompt is the conversation as an arrival',
    '  return `${catchUpPrefix(orchMissed, true)}${handback}`;',
    '  return `${catchUpPrefix(orchMissed, false)}${handback}`;'],
  [only(CATCHUP, 'a handback paused by the circuit breaker gives the next message the catch-up instead'), 'and what the specialist handed back',
    '  return `${catchUpPrefix(orchMissed, true)}${handback}`;',
    '  return catchUpPrefix(orchMissed, true);'],
  [RULES, 'a held catch-up is given once',
    "  if (entry) entry.freshCatchUp = '';\n",
    ''],
  [RULES, 'a catch-up is held for the next message',
    '  if (entry && prefix) entry.freshCatchUp = prefix;',
    ''],
  [only(ENGINE_HELD, 'reaches the next message once after the idle reaper ends the fresh start'), 'a held catch-up is stored with the conversation',
    '  storeHeldCatchUp(convoId, entry);\n  wireProcessHandlers(entry, convoId, null, wireOptions);',
    '  wireProcessHandlers(entry, convoId, null, wireOptions);'],
  [only(SAVE_HELD, 'reaches the next message once after the idle reaper ends the fresh start'), 'a save from the window keeps the stored catch-up',
    '  if (stored && stored.freshCatchUp !== undefined) entry.freshCatchUp = stored.freshCatchUp;\n',
    ''],
  [only(SERVER_HELD, 'reaches the next message once after a restart'), 'a new process gives the stored catch-up to its first message',
    '            const heldCatchUp = takeStoredCatchUp(convoId, entry.agentId);',
    "            const heldCatchUp = '';"],
  [only(RULES_HELD, 'reaches the next message once after the idle reaper ends the fresh start'), 'a stored catch-up is removed once a new process is given it',
    "  storeCatchUp(convoId, null);\n  return readable ? held.text : '';",
    "  return readable ? held.text : '';"],
  [only(RULES_HELD, 'given by the live process, it is not given again after a reap or a restart'), 'a stored catch-up is removed once the live process gives it',
    '  if (prefix && entry.catchUpStoredIn) storeCatchUp(entry.catchUpStoredIn, null);\n',
    ''],
  [only(SERVER_HELD, 'a stored catch-up the resume it was given to never read goes to the fresh start, once'), 'a catch-up given to a refused resume goes to the fresh start',
    '                entry.freshCatchUp = heldCatchUp;\n',
    ''],
  [only(SAVE_HELD, 'the conversation list a window is sent leaves it out, and the store keeps it'), 'the conversation list leaves the stored catch-up out',
    '    delete c.freshCatchUp;\n',
    ''],
  [only(SERVER_HELD, 'gives a stored catch-up to its first message, once'), 'the legacy chat path gives the stored catch-up to its first message',
    '          const legacyCatchUp = takeStoredCatchUp(convoId, entry.agentId);',
    "          const legacyCatchUp = '';"],
  [only(SERVER_HELD, 'hands a stored catch-up on from a refused resume to the fresh start, once'), 'the legacy chat path hands a refused resume\'s catch-up to the fresh start',
    '              entry.freshCatchUp = legacyCatchUp; // never read: it goes to the fresh start\n',
    ''],
  [only(ENGINE_HELD, 'with no session to resume, takes the stored catch-up in front of the handback, and it is not given again'), 'a handback start settles a stored catch-up',
    '  const storedCatchUp = takeStoredCatchUp(convoId, orchestrator.id);',
    "  const storedCatchUp = '';"],
  [only(ENGINE_HELD, 'with no session to resume, takes the stored catch-up in front of the handback, and it is not given again'), 'a handback start with no session gives the catch-up with the handback',
    '      const prompt = coldCatchUp + buildScopeReturnPrompt({',
    '      const prompt = buildScopeReturnPrompt({'],
  [only(ENGINE_HELD, 'resuming a session, spends the stored catch-up without repeating it'), 'a resumed handback start only spends the catch-up',
    "  const coldCatchUp = orchestratorSession ? '' : storedCatchUp;",
    '  const coldCatchUp = storedCatchUp;'],
  [only(ENGINE_HELD, 'paused again by the circuit breaker, holds what it took for the message that drives it'), 'a paused handback start holds what it took for the next message',
    '    holdFreshCatchUp(orchEntry, coldCatchUp);\n',
    ''],
  [only(CATCHUP, 'in continue mode too, the fresh orchestrator is told the request it never saw'), 'a handback prompt honors the arrival heading it is asked for',
    '  const catchUp = catchUpPrefix(orchMissed, arriving);',
    '  const catchUp = catchUpPrefix(orchMissed);'],

  // ===== WHAT THE PERSON SENT WHILE IT WAS STARTING GOES WITH IT =====
  [only(SERVER, 'a message sent while the refused orchestrator is still starting follows the handback into the fresh one'), 'a message sent into a process still starting is kept',
    '            noteUnstartedWrite(existing, followUp);\n',
    ''],
  [only(ENGINE, 'a message sent while the refused orchestrator is still starting follows the handback into the fresh one'), 'a turn started again is given what was kept, after its prompt',
    "  for (const kept of takeUnstartedWrites(entry)) {\n    const carried = withFreshCatchUp(entry, kept);\n    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: carried } }) + '\\n');\n  }\n",
    ''],
  [only(ENGINE, 'a follow-up held back during the handoff reaches the fresh orchestrator, not the refused one'), 'the first message carried over is given the catch-up',
    '    const carried = withFreshCatchUp(entry, kept);',
    '    const carried = kept;'],
  [only(ENGINE, 'a handback paused by the circuit breaker gives the next message the catch-up instead'), 'a turn with no prompt of its own holds the catch-up for its first message',
    '  else holdFreshCatchUp(entry, freshCatchUp);\n',
    ''],
  [only(SERVER, 'a second message sent while the refused resume is still starting is answered after the first'), 'the chat path\'s retry sends what was kept after the first message',
    "                for (const carried of takeUnstartedWrites(entry)) {\n                  liveWs.emit('message', JSON.stringify({ ...freshMsg, content: carried }));\n                }\n",
    ''],
  [only(SERVER, 'a resume that failed for another reason before its session started hands on what was kept'), 'the chat path hands on what was kept after any failure before the init',
    '                for (const carried of takeUnstartedWrites(entry)) {\n                  liveWs',
    '                for (const carried of (entry.missingSession ? takeUnstartedWrites(entry) : [])) {\n                  liveWs'],
  [only(SERVER, 'a handback paused by the circuit breaker gives the next message the catch-up instead'), 'a message sent to a fresh start with no prompt carries the catch-up',
    '            const followUp = withFreshCatchUp(existing, msg.content);',
    '            const followUp = msg.content;'],
  [RULES, 'nothing is kept once a turn has answered',
    '  if (!entry || entry.answered) return;',
    '  if (!entry) return;'],
  [RULES, 'what is kept is handed over once',
    '  if (entry) entry.unstartedWrites = [];\n',
    ''],
  [only(ENGINE, 'once recovered, a session that reappears is not taken back: a stale save cannot restore it'), 'starting again drops the resume and keeps everything else',
    '  const proc = spawnClaude(withoutResume(args), {',
    '  const proc = spawnClaude(args, {'],
  [RULES, 'dropping the resume drops its id with it',
    '  return at < 0 ? args.slice() : [...args.slice(0, at), ...args.slice(at + 2)];',
    '  return args.slice();'],
  [only(ENGINE, 'a stored session Claude Code still has is resumed as it always was, and nothing is forgotten'), 'only a refused entry starts again',
    '  return Boolean(entry.missingSession) && !entry.missingSessionRecovered && !entry.cancelled;',
    '  return !entry.missingSessionRecovered && !entry.cancelled;'],
  [only(ENGINE, 'a fresh start that also fails leaves the next delegation starting cold, not resuming the dead id'), 'an entry starts again at most once',
    '  return Boolean(entry.missingSession) && !entry.missingSessionRecovered && !entry.cancelled;',
    '  return Boolean(entry.missingSession) && !entry.cancelled;'],
  [only(ENGINE, 'a handback the person stopped does not start the orchestrator again either'), 'a turn the person stopped is never started again',
    '  return Boolean(entry.missingSession) && !entry.missingSessionRecovered && !entry.cancelled;',
    '  return Boolean(entry.missingSession) && !entry.missingSessionRecovered;'],

  // ===== WHAT THE PERSON IS TOLD =====
  [only(ENGINE, 'starts that agent fresh, briefed as an arrival, says so in plain words, and forgets the dead id'), 'the fresh start names the session the window must forget',
    '    expiredSessionId: entry.missingSession, _conversationId: convoId, _processId: entry.processId }));',
    '    _conversationId: convoId, _processId: entry.processId }));'],
  [only(ENGINE, 'starts that agent fresh, briefed as an arrival, says so in plain words, and forgets the dead id'), 'the fresh start names the agent, by the name the team uses',
    "  safeSend(JSON.stringify({ type: 'system', subtype: 'info', content: startingFresh(name),",
    "  safeSend(JSON.stringify({ type: 'system', subtype: 'info', content: startingFresh(entry.agentId),"],
  [RULES, 'the fresh start says whose earlier context is gone',
    "  return `${name || 'The agent'}'s previous session expired. Starting fresh.`;",
    "  return 'Previous session expired. Starting fresh.';"],
  [RULES, 'an agent with no name to give is "The agent" when it starts fresh',
    "  return `${name || 'The agent'}'s previous session expired. Starting fresh.`;",
    "  return `${name}'s previous session expired. Starting fresh.`;"],
  [RULES, 'an agent with no name to give is "The agent" when it cannot start again',
    "  return `${name || 'The agent'}'s earlier session is no longer available, so it couldn't be picked up `",
    "  return `${name}'s earlier session is no longer available, so it couldn't be picked up `"],
  [only(ENGINE, 'is "The agent" when its resume cannot be started again, never its id'), 'copy is given a name the team uses, never a raw id',
    '  return (agent && agent.displayName) || null;',
    '  return (agent && agent.displayName) || agentId;'],
  [only(ENGINE, 'says what happened and what to do, in plain words, and still forgets the id'), 'a refusal nobody started again says what happened and what to do',
    '    if (entry.missingSession && !entry.missingSessionRecovered && !entry.cancelled) {',
    '    if (false) {'],
  [only(ENGINE, 'the legacy spawn names the expired session too'), 'a refusal that was started again is not also called a failure',
    '    if (entry.missingSession && !entry.missingSessionRecovered && !entry.cancelled) {',
    '    if (entry.missingSession && !entry.cancelled) {'],
  [only(ENGINE, 'is not started again, and nothing claims it was or was not'), 'a stopped turn is not called a failure either',
    '    if (entry.missingSession && !entry.missingSessionRecovered && !entry.cancelled) {',
    '    if (entry.missingSession && !entry.missingSessionRecovered) {'],
  [only(SERVER, 'forgets exactly that session: the orchestrator\'s live primary survives, and the window says why'), 'the chat path names the session Claude Code refused',
    'content: startingFresh(freshName),\n                  ...(entry.missingSession ? { expiredSessionId: entry.missingSession } : {}),',
    'content: startingFresh(freshName),'],
  [only(SERVER, 'the legacy spawn names the expired session too'), 'the legacy chat path names it too',
    'content: startingFresh(freshName),\n                ...(entry.missingSession ? { expiredSessionId: entry.missingSession } : {}),',
    'content: startingFresh(freshName),'],
  [only(SERVER, 'is "The agent" when its turn starts fresh, never its id'), 'the chat path names the agent starting fresh',
    "                const freshName = (agentData && agentData.displayName) || null;",
    "                const freshName = msg.agent;"],
  [only(SERVER, 'a reap after answering re-sends nothing'), 'only a process that never started its session is retried as a failed resume',
    'code !== 0 && (!entry.sessionId || entry.missingSession) &&\n                (stderrRef',
    'code !== 0 &&\n                (stderrRef'],
  [only(SERVER, 'the legacy spawn does not replay a turn that answered and then failed'), 'the legacy path retries only a process that never started its session',
    'code !== 0 && (!entry.sessionId || entry.missingSession) &&\n              (legacyStderrRef',
    'code !== 0 &&\n              (legacyStderrRef'],
  [only(SERVER, 'a refusal that comes after an init is still started again fresh'), 'a refusal after an init is still retried',
    '(!entry.sessionId || entry.missingSession) &&\n                (stderrRef',
    '!entry.sessionId &&\n                (stderrRef'],
  [only(SERVER, 'the legacy spawn starts a refusal that came after an init again fresh too'), 'the legacy path retries a refusal after an init too',
    '(!entry.sessionId || entry.missingSession) &&\n              (legacyStderrRef',
    '!entry.sessionId &&\n              (legacyStderrRef'],
  [ENGINE_UNIT, 'the kept list is cleared on the first result',
    '          noteAnswered(entry);\n',
    ''],
  [only(SERVER, 'forgets exactly that session: the orchestrator\'s live primary survives, and the window says why'), 'the chat path\'s own retry counts as starting again',
    '\n                entry.missingSessionRecovered = true; // started again below',
    ''],
  [only(SERVER, 'the legacy spawn names the expired session too'), 'the legacy chat path\'s retry counts as starting again',
    '\n              entry.missingSessionRecovered = true; // started again below',
    ''],

  // ===== THE WINDOW FORGETS EXACTLY THAT SESSION, AND RESUMES ONLY ITS OWN =====
  [CLIENT, 'info naming the expired session forgets that one, not the primary',
    '    if (message.expiredSessionId) {',
    '    if (false) {'],
  [CLIENT, 'info that names no session forgets nothing',
    '  function reduceInfo(state, message) {\n    if (!message.content) return none(state);\n    const effects = [];',
    "  function reduceInfo(state, message) {\n    if (!message.content) return none(state);\n    const effects = [{ type: 'clear-session' }];"],
  [CLIENT, 'session_expired forgets the session it names',
    "    return { state, effects: [{ type: 'forget-session', sessionId: message.sessionId }] };",
    '    return none(state);'],
  [CLIENT, 'session_expired reaches its reducer',
    "      case 'session_expired': return reduceSessionExpired(state, message);\n",
    ''],
  [CLIENT, 'a forgotten primary is cleared',
    '    if (convo.sessionId === sessionId) {',
    '    if (false) {'],
  [CLIENT, 'a forgotten session leaves the chain',
    '      const kept = convo.sessionIds.filter(s => !(s && s.sessionId === sessionId));',
    '      const kept = convo.sessionIds.slice();'],
  [CLIENT, 'the conversation\'s own agent resumes the primary',
    '    if (agentId === convo.agentId) return convo.sessionId || null;\n',
    ''],
  [CLIENT, 'another agent never resumes a session that is not its own',
    '    return chain.length ? null : (convo.sessionId || null);',
    '    return convo.sessionId || null;'],
  [CLIENT, 'a record from before the chain still resumes its primary',
    '    return chain.length ? null : (convo.sessionId || null);',
    '    return null;'],

  // ===== A WRITE TO A PROCESS THAT HAS STOPPED NEVER ENDS THE SERVER =====
  // The stdin of each child is given its error handler where the child
  // starts. Without it a write in the gap between the process stopping and
  // the server hearing so is an uncaught exception, which ends the server.
  [only(SPAWN_STDIN, 'is logged in one line naming the process, the server stays up, and the close ends the turn once'),
    'every Claude process has its stdin handler from the start (a follow-up to a stopped process)',
    "  guardChildStdin(proc, () => `claude (agent ${agentId}, conversation ${convoId || 'none'})`);\n",
    ''],
  [only(SPAWN_STDIN, 'the failed write is logged once, the delegate starts fresh once, and the orchestrator hears of it once and carries on'),
    'every Claude process has its stdin handler from the start (a brief to a refused delegate)',
    "  guardChildStdin(proc, () => `claude (agent ${agentId}, conversation ${convoId || 'none'})`);\n",
    ''],
  [only({ src: SPAWN_STDIN.src, suite: STALE }, 'is logged in one line, the server stays up, and the fresh delegate answers it'),
    'every Claude process has its stdin handler from the start (a follow-up to a refused delegate that has just stopped)',
    "  guardChildStdin(proc, () => `claude (agent ${agentId}, conversation ${convoId || 'none'})`);\n",
    ''],
  [CODEX_STDIN, 'the handler is on both start paths, not one: the Codex app-server has it too',
    "    guardChildStdin(proc, 'codex app-server', { log: this._log === NO_LOG ? undefined : (line) => this._log(line) });\n",
    ''],
  [CODEX_STDIN, 'a Codex client given no log of its own still logs a failed write, on stderr',
    'this._log === NO_LOG ? undefined : (line) => this._log(line)',
    '(line) => this._log(line)'],
  [only({ src: CODEX_STDIN.src, suite: 'test/unit/doc-claims.test.js' }, 'and each logs a failed write in one line, naming the process and the error, with no log of its own'),
    'the page\'s claim of one line per failed write holds for the Codex start path with no log of its own',
    'this._log === NO_LOG ? undefined : (line) => this._log(line)',
    '(line) => this._log(line)'],
  [STDIN_UNIT, 'the handler listens for the stream\'s error, so a failed write throws nothing',
    "  stdin.on('error', (err) => {\n    if (err && typeof err === 'object' && logged.has(err)) return;\n    report(err);\n  });\n",
    ''],
  [STDIN_UNIT, 'each failed write is logged, a retry once more, not only the first',
    '      if (err) report(err);\n',
    ''],
  [STDIN_UNIT, 'a log that throws is swallowed, so the handler failing never ends the server either',
    '    } catch (e) { /* the log failing must not end the server either */ }',
    '    } finally { /* nothing caught */ }'],
  [STDIN_UNIT, 'a stdin is given its handler once, so a failed write is logged once',
    '  if (stdin[GUARDED]) return true;\n',
    ''],
  [only(SERVER_STOPPED, 'is logged in one line naming the process, the server stays up, and the close ends the turn once'),
    'a follow-up starts its turn with no result, so the close of a process that stopped before answering ends it',
    '            existing.resultSent = false;\n',
    ''],
  [STDIN_INVENTORY, 'the inventory names every write: the app-server\'s left out',
    "  { at: 'codex-appserver.js | _writeLine | proc.stdin.write', from: APP_SERVER, what: 'every request and notification to the Codex app-server' },\n",
    ''],
  [STDIN_INVENTORY, 'the inventory names every write: a delegate\'s brief left out',
    "  { at: 'lib/delegation/engine.js | handleDelegation | delegateProc.stdin.write', from: STARTED_HERE, what: 'the brief to the agent delegated to' },\n",
    ''],
  // The scan that finds the writes reads the source as code: a // inside a
  // string is not a comment, a block comment runs to its */, and code inside
  // a template's ${} is code.
  [STDIN_INVENTORY, 'the scan reads a string as a string, so a URL in one hides no write after it',
    "    } else if (c === \"'\" || c === '\"') {\n",
    '    } else if (false) {\n'],
  [STDIN_INVENTORY, 'the scan reads a block comment to its end, across lines',
    "      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) blankBoth(i++);\n",
    "      while (i < n && text[i] !== '\\n' && !(text[i] === '*' && text[i + 1] === '/')) blankBoth(i++);\n"],
  [STDIN_INVENTORY, 'the scan reads code inside a template\'s placeholder as code',
    "      if (c === '$' && text[i + 1] === '{') { i += 2; placeholders.push(depth); depth++; last = '{'; return; }\n",
    ''],
  // Two writes to a refused delegate both fail, and its close still ends
  // what it was doing once: the delegation ends once, and the orchestrator
  // hears once. This row ends the delegation twice: the refused process's
  // close starts the delegate fresh and then ends the delegation as well.
  [only({ src: ENGINE.src, suite: STOPPED }, 'the retry: a second write to the same refused delegate is logged once more and ends nothing a second time'),
    'a refused delegate\'s close starts it again fresh and ends nothing else, so the delegation ends once',
    '      startWithoutSession(delegateEntry, convoId, delegateArgs, freshDelegateContext, delegateWire, handleDelegateClose);\n      return;\n',
    '      startWithoutSession(delegateEntry, convoId, delegateArgs, freshDelegateContext, delegateWire, handleDelegateClose);\n'],
  [only({ src: STDIN_UNIT.src, suite: STOPPED }, 'the retry: a second write to the same refused delegate is logged once more and ends nothing a second time'),
    'a failed write after the first is only logged: one that ended the delegation again would end it twice',
    '      if (err) report(err);\n',
    "      if (err) { report(err); if (stdin.rundockFailedBefore) proc.emit('close', 1, null); stdin.rundockFailedBefore = true; }\n"],

  // ===== THE NEXT TURN IS TOLD WHAT RUNDOCK DID WITH THE MARKERS, ONCE =====
  [NOTES, 'the team note is told on every later turn, not once',
    "  try { persist(convoId, null); } catch (e) { log(convoId, 'could not remove the outcomes told from the record', e); return input; }\n  waiting.delete(convoId);\n",
    ''],
  [NOTES, 'the team note is dropped',
    '    told = seams.deliver(input, seams.build(list));',
    '    told = input;'],
  [only(ENGINE_NOTES, 'instruction-shaped text in a marker\'s body or attributes gives a note of fixed fields only, byte for byte'), 'the team note is built from the reply\'s text, not from the outcomes',
    '          keepOutcomes(convoId, teamOutcomes);',
    "          keepOutcomes(convoId, teamOutcomes.map((o) => ({ ...o, outcome: 'error', message: entry.responseText })));"],
  [only(CATCHUP_NOTES, 'Doc\'s save was refused and another failed: the orchestrator is told so, never that it was saved, and the conversation keeps both lines'), 'the hand-back tells the orchestrator a refused change was saved',
    "    if (o.outcome === 'saved' || o.outcome === 'updated') return",
    "    if (o.outcome === 'saved' || o.outcome === 'updated' || o.outcome === 'refused') return"],
  [only(SERVER_NOTES, 'stored once with two windows open, after the reply that asked, and given back by the history'), 'the team line is stored once for every open window',
    'teamNotes.wireTeamNotes({ appendTranscript: (...args) => appendTranscript(...args) });',
    'teamNotes.wireTeamNotes({ appendTranscript: (...args) => { for (const client of connectedClients) appendTranscript(...args); } });'],
  [LINES_NOTES, 'the team note\'s heading is left out of Rundock\'s own headings',
    '  ...Object.values(CATCH_UP_HEADINGS),\n',
    '  ...Object.values(CATCH_UP_HEADINGS).filter((heading) => heading !== CATCH_UP_HEADINGS.outcomes),\n'],

  // ===== IN A HAND-OFF, EACH CHANGE DOC MAKES IS WRITTEN ONLY ON AN ALLOW GIVEN ON ITS CARD =====
  [MARKERS_TURN, 'whether Doc was brought in is read from the reply, not the process entry',
    "  try { by = entry.delegation ? String(entry.delegation.originalAgentId || '') : null; } catch (e) { by = ''; }",
    "  try { by = /brought me in|delegated by/i.test(text) ? 'chief-of-staff' : null; } catch (e) { by = ''; }"],
  [only(MARKERS_CARDS, 'An allow that did not come from a card writes nothing'), 'a change is written on an allow that did not come from its card',
    'allow === true && how && how.card === true ?',
    'allow === true ?'],
  [only(MARKERS_CARDS, 'No answer before the timeout, with every window closed: nothing is written, and the outcome is refused, saying nobody answered'), 'a change is written when its card times out',
    'allow === true && how && how.card === true ?',
    "(allow === true && how && how.card === true) || reason === 'timeout' ?"],
  [only(MARKERS_CARDS, 'Doc brought in by an orchestrator\'s Agent call: one card per change, five in one reply, and nothing written while they wait'), 'only the first change in a reply raises a card, and the rest are written',
    '      if (by !== null) {',
    '      if (by !== null && action === actions[0]) {'],
  [GRADING_CARDS, 'the four names of Doc\'s hand-off changes are not graded high',
    "    if (isTeamCard(toolName)) return 'high';\n",
    ''],
  [only(ENGINE_CARDS, 'Doc is not ended while its card waits; once allowed, the orchestrator is told it was saved, and the conversation keeps the line'), 'Doc\'s hand-back fires before its cards are answered',
    '        afterTeamCards(e, () => { if (e.pendingKill && !e.exited) scheduleScopeReturnKill(e, convoId); });',
    '        scheduleScopeReturnKill(e, convoId);'],
  [only(MARKERS_CARDS, 'a new agent is written with the order its card showed, though another agent joined the team while the card waited'), 'an allowed change is written from the marker, not from what its card showed',
    '  const result = write({ ...action, content }, conversationId);',
    '  const result = write(action, conversationId);'],
  [MARKERS_TURN, 'a card is raised when the person is talking to Doc directly',
    "  try { by = entry.delegation ? String(entry.delegation.originalAgentId || '') : null; } catch (e) { by = ''; }",
    "  try { by = String((entry.delegation && entry.delegation.originalAgentId) || ''); } catch (e) { by = ''; }"],
  [CATCHUP_NOTES_UNIT, 'a card that wrote nothing is told with its outcome\'s message, not Rundock\'s sentence for its code',
    "      const card = o.author === DOC_ID && isCardEnd(o.reason) ? `${CARD_ENDS[o.reason](change[1])}, so nothing was ${change[2]}.` : '';",
    "      const card = o.author === DOC_ID && isCardEnd(o.reason) ? flat(o.message) : '';"],
  [CATCHUP_NOTES_UNIT, 'a code the server never sets is given a card\'s sentence',
    "      const card = o.author === DOC_ID && isCardEnd(o.reason) ? `${CARD_ENDS[o.reason](change[1])}, so nothing was ${change[2]}.` : '';",
    "      const card = o.author === DOC_ID && o.reason ? `${(CARD_ENDS[o.reason] || CARD_ENDS.unanswered)(change[1])}, so nothing was ${change[2]}.` : '';"],
];

const REPORTER = ['--test-reporter', 'spec'];

// The exact name, as a pattern node --test can match and nothing else can.
const exactly = (name) => `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;

async function redTests(suite) {
  let out = '';
  let failed = false;
  const [file, testName] = String(suite).split('#');
  // NODE_TEST_CONTEXT must not reach the run: a nested node --test that
  // inherits it reports its failures in a form this cannot read and still
  // exits 0, so a red run would read as green.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    // Bounded twice over: each test by node's own timeout, and the whole
    // suite by the runner's limit, so a broken guard that leaves a run
    // waiting costs minutes and reports, rather than holding the harness for
    // hours.
    out = await runSuite('node', ['--test', '--test-timeout=120000', ...REPORTER, ...(testName ? ['--test-name-pattern', exactly(testName)] : []), file],
      { cwd: ROOT, env });
  } catch (e) {
    if (e.didNotFinish) return { didNotFinish: e.didNotFinish };
    failed = true;
    out = (e.stdout || '') + (e.stderr || '');
  }
  const marker = out.indexOf('failing tests:');
  if (marker === -1) {
    if (!failed) return [];
    // A suite that failed with output this could not read has produced no
    // verdict: not red, not green, nothing. Refused as a named row rather
    // than thrown, so the report says which mutation was in flight instead
    // of a stack trace that names nothing.
    return { unparsable: true };
  }
  const names = [];
  for (const line of out.slice(marker).split('\n')) {
    const m = /^✖ (.+?) \(\d/.exec(line.trim());
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

// THE HARNESS'S OWN RUN IS CHECKED BEFORE ANY ROW IS READ. Every row is read
// through the one invocation above, so a fault in it, an option this node
// refuses or output that no longer parses, would misreport every row at once.
// Before anything is mutated, that same invocation is made on a fixture of two
// tests, one that passes and one that fails. It must read the passing one as
// green and the failing one as red, by name, or the run is refused with no
// verdict. Returns what it read wrong, or null.
const FIXTURE_GREEN = 'passes with nothing broken';
const FIXTURE_RED = 'fails when broken';
async function invocationProblem(runTests = redTests) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-session-harness-'));
  const file = path.join(dir, 'invocation.test.js');
  try {
    fs.writeFileSync(file, "'use strict';\nconst { test } = require('node:test');\n"
      + `test(${JSON.stringify(FIXTURE_GREEN)}, () => {});\n`
      + `test(${JSON.stringify(FIXTURE_RED)}, () => { throw new Error('broken'); });\n`);
    const green = await runTests(`${file}#${FIXTURE_GREEN}`);
    if (!Array.isArray(green) || green.length !== 0) {
      return `a run of a passing test read as ${JSON.stringify(green)}, not green`;
    }
    const red = await runTests(`${file}#${FIXTURE_RED}`);
    if (!Array.isArray(red) || red.length !== 1 || red[0] !== FIXTURE_RED) {
      return `a run of a failing test read as ${JSON.stringify(red)}, not that test red`;
    }
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function run() {
  const targets = targetsFromRows(MUTATIONS);
  const session = beginMutationRun({ files: [...new Set(targets.map((target) => target.src))] });
  const originals = new Map();
  for (const target of targets) originals.set(target, session.original(target.src));
  const results = [];
  try {
    for (const [target, label, guard, without] of rowsForShard(MUTATIONS)) {
      const original = originals.get(target);
      const matches = original.split(guard).length - 1;
      if (matches === 0) {
        results.push({ label, applied: false, red: [] });
        continue;
      }
      // A GUARD THAT MATCHES MORE THAN ONCE IS REFUSED RATHER THAN TAKING THE
      // FIRST: String.replace takes the first occurrence, so a search text
      // that also appears somewhere else quietly breaks the wrong code and
      // reports on whatever that turns red.
      if (matches > 1) {
        results.push({ label, applied: false, ambiguous: matches, red: [] });
        continue;
      }
      fs.writeFileSync(target.src, original.replace(guard, without));
      const red = await redTests(target.suite);
      if (red && red.didNotFinish) results.push({ label, applied: true, didNotFinish: red.didNotFinish, output: suiteOutput(), red: [] });
      else results.push(red && red.unparsable
        ? { label, applied: true, unparsable: true, output: suiteOutput(), red: [] }
        : { label, applied: true, red });
      fs.writeFileSync(target.src, original);
    }
  } finally {
    session.finish();
  }
  return results;
}

function report(results, markdown) {
  let failed = 0;
  const lines = [];
  for (const { label, applied, red, ambiguous, unparsable, didNotFinish } of results) {
    if (didNotFinish) {
      failed++;
      const why = didNotFinishWhy(didNotFinish);
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  ${why.toUpperCase()}`);
      continue;
    }
    if (unparsable) {
      failed++;
      const why = 'no verdict: the suite failed but its output could not be parsed, so nothing '
        + 'about this mutation is known; fix the reporter parsing rather than trusting a rerun';
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  ${why.toUpperCase()}`);
      continue;
    }
    if (ambiguous) {
      failed++;
      const why = `the guard text matches ${ambiguous} places, so it would break whichever came first`;
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  AMBIGUOUS: ${why}`);
      continue;
    }
    if (!applied) {
      failed++;
      lines.push(markdown
        ? `| ${label} | **the guard text was not found, so nothing was mutated** | |`
        : `${label}\n  THE GUARD TEXT WAS NOT FOUND, so nothing was mutated`);
      continue;
    }
    if (red.length === 0) {
      failed++;
      lines.push(markdown ? `| ${label} | **nothing turned red** | |` : `${label}\n  NOTHING TURNED RED`);
      continue;
    }
    lines.push(markdown
      ? `| ${label} | ${red.length} | ${red.map((n) => `\`${n}\``).join('<br>')} |`
      : `${label}\n  ${red.length} red\n${red.map((n) => `    - ${n}`).join('\n')}`);
  }
  if (markdown) {
    console.log('| Guard broken | Tests red | Which |');
    console.log('|---|---|---|');
    for (const line of lines) console.log(line);
  } else {
    for (const line of lines) console.log(`\n${line}`);
  }
  return failed;
}

// REFUSE TO START ON A MACHINE THAT WOULD MISREPORT. See
// mutate-routines-guards.js for the two runs that taught this: a full temp
// root surfaces as tests going red, and red tests are exactly what this
// instrument reports as a guard nobody was watching.
function requireSaneTempRoot() {
  const verdict = preflight(os.tmpdir());
  if (verdict.ok) return;
  console.error(verdict.message);
  process.exit(NO_VERDICT);
}

if (require.main === module) {
  requireSaneTempRoot();
  if (process.argv.includes('--preflight-only')) process.exit(0);
  invocationProblem().then((problem) => {
    if (problem) {
      console.error(`Refusing to start a mutation run: the run every row is read through misreads a result: ${problem}.`);
      process.exit(NO_VERDICT);
    }
    return run();
  }).then((results) => {
    const failed = report(results, process.argv.includes('--markdown'));
    if (failed) {
      console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded,`
        + ' and a mutation that could break more than one place proves nothing about either.');
      process.exit(exitCodeFor(failed, results));
    }
  });
}

module.exports = { MUTATIONS, run, redTests, invocationProblem };
