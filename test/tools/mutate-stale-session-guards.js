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
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const {
  beginMutationRun, targetsFromRows, rowsForShard, exitCodeFor, NO_VERDICT,
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
// Recognizing the refusal at all, and what is kept for a turn starting again.
const RULES = { src: path.join(ROOT, 'lib', 'runtime', 'missing-session.js'), suite: 'test/unit/missing-session.test.js' };
// How a handback prompt is headed for an orchestrator starting fresh.
const CATCHUP = { src: path.join(ROOT, 'lib', 'delegation', 'catch-up.js'), suite: STALE };

const MUTATIONS = [
  // ===== THE REFUSAL IS RECOGNIZED, AND NEVER SHOWN RAW =====
  [ENGINE, 'a refused resume is recognized from what the process was started with',
    '    const expired = refusedResume(entry.process, stderrBuf.value);',
    '    const expired = null;'],
  [ENGINE, 'the raw refusal never reaches the window',
    '      forgetExpiredSession(convoId, expired);\n      return;\n    }',
    '      forgetExpiredSession(convoId, expired);\n    }'],
  [ENGINE, 'a refusal is matched on everything the process wrote, not one chunk',
    '    const expired = refusedResume(entry.process, stderrBuf.value);',
    '    const expired = refusedResume(entry.process, text);'],
  [ENGINE, 'stderr that could still be a refusal is held back',
    '    if (mayBeRefusal(stderrBuf.value)) { held += text; return; }\n',
    ''],
  [ENGINE, 'what was held back is shown with what follows it',
    '    const shown = held + text;',
    '    const shown = text;'],
  [ENGINE, 'what was held back is shown once',
    "    const shown = held + text;\n    held = '';\n",
    '    const shown = held + text;\n'],
  [ENGINE, 'a refused process is forgotten once, however many pieces follow',
    '    if (refused) return;\n',
    ''],
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
  [ENGINE, 'the stored conversation forgets the refused session',
    '  if (found && forgetSession(found.convo, sessionId)) {',
    '  if (false) {'],
  [ENGINE, 'every open window is told to forget it',
    "  safeSend(JSON.stringify({ type: 'system', subtype: 'session_expired', sessionId, _conversationId: convoId }));\n",
    ''],
  [ENGINE, 'the store remembers the id is gone',
    '  noteExpired(sessionId);\n',
    ''],
  [RULES, 'a noted id is remembered',
    '  if (sessionId) expired.add(sessionId);',
    ''],
  [SAVE, 'a save cannot put a refused id back as the primary',
    'sessionId: isExpired(msg.conversation.sessionId) ? null : (msg.conversation.sessionId || null),',
    'sessionId: msg.conversation.sessionId || null,'],
  [SAVE, 'a save cannot put a refused id back in the chain',
    'sessionIds: (msg.conversation.sessionIds || []).filter(s => !(s && isExpired(s.sessionId))),',
    'sessionIds: msg.conversation.sessionIds || [],'],
  [CLEANUP, 'a conversation with a transcript is kept when no session id is left',
    'c.sessionId || hasTranscript(c) || new Date',
    'c.sessionId || new Date'],

  // ===== THE TURN STARTS AGAIN, FRESH, ONCE =====
  [ENGINE, 'a refused delegation starts again fresh',
    '    if (mayStartFresh(delegateEntry)) {',
    '    if (false) {'],
  [ENGINE, 'a fresh delegate is briefed as an arrival',
    '        arriving: true,\n      }), delegateWire, handleDelegateClose);',
    '        arriving: false,\n      }), delegateWire, handleDelegateClose);'],
  [ENGINE, 'a refused handback starts the orchestrator again fresh',
    '    if (mayStartFresh(orchEntry)) {',
    '    if (false) {'],
  [ENGINE, 'the fresh orchestrator is handed the handback',
    '      startWithoutSession(orchEntry, convoId, args, orchFreshPrompt, orchWire, onOrchClose);',
    '      startWithoutSession(orchEntry, convoId, args, null, orchWire, onOrchClose);'],
  [ENGINE, 'a fresh orchestrator\'s handback is headed as an arrival',
    '        mode, arriving: true, specialistId: specialistEntry.agentId, outputBlock,',
    '        mode, arriving: false, specialistId: specialistEntry.agentId, outputBlock,'],
  [ENGINE, 'a fresh orchestrator is given the whole conversation, its own turns included',
    'orchMissed: deltaSince(loadTranscript(convoId) || [], orchestrator.id, undefined, [specialistEntry.agentId], agentDisplayNames(), true),',
    'orchMissed: deltaSince(loadTranscript(convoId) || [], orchestrator.id, undefined, [specialistEntry.agentId], agentDisplayNames(), false),'],
  [CATCHUP, 'a handback prompt honors the arrival heading it is asked for',
    '  const catchUp = catchUpPrefix(orchMissed, arriving);',
    '  const catchUp = catchUpPrefix(orchMissed);'],

  // ===== WHAT THE PERSON SENT WHILE IT WAS STARTING GOES WITH IT =====
  [SERVER, 'a message sent into a process still starting is kept',
    '            noteUnstartedWrite(existing, msg.content);\n',
    ''],
  [ENGINE, 'a turn started again is given what was kept, after its prompt',
    "  for (const carried of takeUnstartedWrites(entry)) {\n    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: carried } }) + '\\n');\n  }\n",
    ''],
  [SERVER, 'the chat path\'s retry sends what was kept after the first message',
    "                for (const carried of takeUnstartedWrites(entry)) {\n                  liveWs.emit('message', JSON.stringify({ ...freshMsg, content: carried }));\n                }\n",
    ''],
  [RULES, 'nothing is kept once the session has started',
    '  if (!entry || entry.sessionId) return;',
    '  if (!entry) return;'],
  [RULES, 'what is kept is handed over once',
    '  if (entry) entry.unstartedWrites = [];\n',
    ''],
  [ENGINE, 'starting again drops the resume and keeps everything else',
    '  const proc = spawnClaude(withoutResume(args), {',
    '  const proc = spawnClaude(args, {'],
  [RULES, 'dropping the resume drops its id with it',
    '  return at < 0 ? args.slice() : [...args.slice(0, at), ...args.slice(at + 2)];',
    '  return args.slice();'],
  [ENGINE, 'only a refused entry starts again',
    '  return Boolean(entry.missingSession) && !entry.missingSessionRecovered && !entry.cancelled;',
    '  return !entry.missingSessionRecovered && !entry.cancelled;'],
  [ENGINE, 'an entry starts again at most once',
    '  return Boolean(entry.missingSession) && !entry.missingSessionRecovered && !entry.cancelled;',
    '  return Boolean(entry.missingSession) && !entry.cancelled;'],
  [ENGINE, 'a turn the person stopped is never started again',
    '  return Boolean(entry.missingSession) && !entry.missingSessionRecovered && !entry.cancelled;',
    '  return Boolean(entry.missingSession) && !entry.missingSessionRecovered;'],

  // ===== WHAT THE PERSON IS TOLD =====
  [ENGINE, 'the fresh start names the session the window must forget',
    '    expiredSessionId: entry.missingSession, _conversationId: convoId, _processId: entry.processId }));',
    '    _conversationId: convoId, _processId: entry.processId }));'],
  [ENGINE, 'the fresh start names the agent, by the name the team uses',
    "  safeSend(JSON.stringify({ type: 'system', subtype: 'info', content: startingFresh(name),",
    "  safeSend(JSON.stringify({ type: 'system', subtype: 'info', content: startingFresh(entry.agentId),"],
  [RULES, 'the fresh start says whose earlier context is gone',
    "  return `${name}'s previous session expired. Starting fresh.`;",
    "  return 'Previous session expired. Starting fresh.';"],
  [ENGINE, 'a refusal nobody started again says what happened and what to do',
    '    if (entry.missingSession && !entry.missingSessionRecovered && !entry.cancelled) {',
    '    if (false) {'],
  [ENGINE, 'a refusal that was started again is not also called a failure',
    '    if (entry.missingSession && !entry.missingSessionRecovered && !entry.cancelled) {',
    '    if (entry.missingSession && !entry.cancelled) {'],
  [ENGINE, 'a stopped turn is not called a failure either',
    '    if (entry.missingSession && !entry.missingSessionRecovered && !entry.cancelled) {',
    '    if (entry.missingSession && !entry.missingSessionRecovered) {'],
  [SERVER, 'the chat path names the session Claude Code refused',
    'content: startingFresh(freshName),\n                  ...(entry.missingSession ? { expiredSessionId: entry.missingSession } : {}),',
    'content: startingFresh(freshName),'],
  [SERVER, 'the legacy chat path names it too',
    'content: startingFresh(freshName),\n                ...(entry.missingSession ? { expiredSessionId: entry.missingSession } : {}),',
    'content: startingFresh(freshName),'],
  [SERVER, 'the chat path names the agent starting fresh',
    "                const freshName = (agentData && (agentData.displayName || agentData.name)) || msg.agent;",
    "                const freshName = msg.agent;"],
  [SERVER, 'the chat path\'s own retry counts as starting again',
    '\n                entry.missingSessionRecovered = true; // started again below',
    ''],
  [SERVER, 'the legacy chat path\'s retry counts as starting again',
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
];

const REPORTER = ['--test-reporter', 'spec'];

function redTests(suite) {
  let out = '';
  let failed = false;
  try {
    out = execFileSync('node', ['--test', ...REPORTER, suite],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
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

function run() {
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
      const red = redTests(target.suite);
      results.push(red && red.unparsable
        ? { label, applied: true, unparsable: true, red: [] }
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
  for (const { label, applied, red, ambiguous, unparsable } of results) {
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
  const results = run();
  const failed = report(results, process.argv.includes('--markdown'));
  if (failed) {
    console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded,`
      + ' and a mutation that could break more than one place proves nothing about either.');
    process.exit(exitCodeFor(failed, results));
  }
}

module.exports = { MUTATIONS, run };
