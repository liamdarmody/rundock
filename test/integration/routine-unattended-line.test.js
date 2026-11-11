'use strict';
// Every routine is told, before it starts, that nobody is watching.
//
// A routine's output goes nowhere and no reply can reach it. Until a step was
// refused, nothing said so: the refusal line (scripts/refusal-notice.js) told
// a routine to carry on only after the refusal, and a run that had already
// asked a question in its final message, or stopped to wait for an answer,
// read as finished with nothing saved. So every routine run, on either
// runtime, carries one fixed line in its session-level instructions: the
// system prompt on Claude Code, the thread's developer instructions on Codex.
// It never goes in the turn input, because the routine prompt is the plan an
// approval was given for, and changing that would lapse every approval.
//
// A conversation has somebody to ask, so it never gets the line.
//
// A Claude Code routine is also told to change workspace files with its file
// tools rather than the shell. In Notes mode a shell command that changes
// files asks for approval, nobody can give it, and the refusal says not to try
// another way, so a run that moved or copied a file with the shell stopped
// with nothing saved. A Codex routine is not told so: its thread never asks
// for approval and its tools have other names, so the sentence would be false.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');
const scheduler = require('../../lib/scheduler.js');
const { NOTES_DISALLOWED_TOOLS } = require('../../lib/workspace/mode.js');
const {
  UNATTENDED_RUN, UNATTENDED_RUN_CODEX, UNATTENDED_NEXT, FAILED_LINE, refusalNotice, unansweredNotice,
} = require('../../scripts/refusal-notice.js');
const { UNATTENDED_NEXT_UNLOADED } = require('../../scripts/permission-hook.js');

// The sentence a Claude Code routine is told about changing files, word for
// word as it was approved. Written out here, never read from the module, so a
// rewording fails rather than follows.
const FILE_TOOLS = 'To create, change or copy a file in the workspace, use your file tools (Write and Edit) rather than the shell: a shell command that changes files can need an approval that nobody here can give.';
// What sits either side of it.
const SAVE_THE_WORK = 'Save the work in the workspace as you go.';
const RUN_STATUS_CLOSE = 'End your final message with the line RUN STATUS: succeeded';

// What a Codex routine is told, byte for byte as it was before the sentence
// above existed. Nothing about file tools is true on its thread.
const CODEX_LINE = 'Nobody is watching this run, so nobody can answer a question or approve a step. Do not ask, and do not wait for a reply: work from what you have, and if a step is refused, carry on with the rest of the job without it. Save the work in the workspace as you go. End your final message with the line RUN STATUS: succeeded, or, if you could not finish, make its last line: RUN STATUS: failed: <one-line reason>';

// What a refused step is told, and the failure line, as they were before.
// Telling a routine up front which tools to use changes none of them.
const FAILED_LINE_TEXT = 'RUN STATUS: failed: <one-line reason>';
const NEXT_TEXT = 'This run has nobody to ask, so carry on with the rest of the job without that step. If you cannot finish without it, make the last line of your final message: RUN STATUS: failed: <one-line reason>';
const DELIBERATE = 'The refusal is deliberate: do not retry it or try another way.';

let client;

before(async () => {
  await h.boot({
    agents: {
      lead: agentFile({
        name: 'lead', description: 'Runs the team', type: 'orchestrator', order: 0,
      }),
      writer: agentFile({
        name: 'writer', description: 'Writes things', type: 'specialist', order: 1, reportsTo: 'lead',
        routines: [{ name: 'sweep', schedule: 'every day at 07:00', prompt: 'writer sweep', enabled: true }],
      }),
      helper: agentFile({
        name: 'helper', description: 'Helps on Codex', type: 'specialist', order: 2, reportsTo: 'lead', runtime: 'codex',
        routines: [{ name: 'check', schedule: 'every day at 07:00', prompt: 'helper check', enabled: true }],
      }),
    },
  });
  h.writeScenario([{ match: {}, turn: [{ text: 'done.' }] }]);
  h.writeCodexScenario([]);
  h.internal.stopScheduler();
  client = await h.connect();
});

after(async () => h.shutdown());

function settle(key) {
  return h.waitUntil(() => !scheduler.runningRuns().some(r => r.key === key), 20000);
}

// The value a flag was given in a child's argument list, or null.
const flagValue = (argv, flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);

async function setMode(mode) {
  const since = client.messages.length;
  client.send({ type: 'set_workspace_mode', mode });
  await client.waitFor(m => m.type === 'workspace_mode_changed' && m.mode === mode, { since, label: `mode ${mode}` });
  assert.strictEqual(h.internal.readState().workspaceMode, mode);
}

// The file-tools sentence sits straight after the line about saving the
// work and straight before the RUN STATUS close, once.
function assertFileToolsPlaced(line) {
  assert.ok(line.includes(FILE_TOOLS), 'the file-tools sentence, word for word');
  assert.strictEqual(line.split(FILE_TOOLS).length, 2, 'once');
  assert.ok(line.includes(`${SAVE_THE_WORK} ${FILE_TOOLS} ${RUN_STATUS_CLOSE}`),
    'straight after saving the work, and before the RUN STATUS close');
}

test('the line says what a refused step is also told, and contradicts none of it', () => {
  assert.ok(UNATTENDED_NEXT.endsWith(FAILED_LINE), 'the line a refused step is given ends on the failure line the record reads');
  assert.strictEqual(UNATTENDED_NEXT_UNLOADED, UNATTENDED_NEXT, 'and so does the hook\'s copy of it');
  for (const [runtime, line] of [['Claude Code', UNATTENDED_RUN], ['Codex', UNATTENDED_RUN_CODEX]]) {
    assert.ok(line.endsWith(FAILED_LINE), `${runtime}: it ends on the same failure line`);
    assert.match(line, /carry on with the rest of the job without it/, `${runtime}: a refused step is carried on without, as the refusal says`);
    assert.match(line, /Do not ask/);
    assert.match(line, /Save the work/);
    assert.match(line, /RUN STATUS: succeeded/);
    assert.doesNotMatch(line, /stop and ask|ask the person|wait for (their|an) answer/i,
      `${runtime}: nothing in it tells a run to wait for somebody`);
    assert.doesNotMatch(line, /\n/, `${runtime}: one line`);
  }
});

test('a Claude Code routine is told to change files with its file tools; a Codex routine is told what it always was', () => {
  assertFileToolsPlaced(UNATTENDED_RUN);
  assert.strictEqual(UNATTENDED_RUN.replace(` ${FILE_TOOLS}`, ''), UNATTENDED_RUN_CODEX,
    'apart from that sentence, the two lines say the same thing in the same words');
  assert.strictEqual(UNATTENDED_RUN_CODEX, CODEX_LINE, 'the Codex line is byte for byte what it was');
  assert.doesNotMatch(UNATTENDED_RUN_CODEX, /file tools|Write and Edit|rather than the shell/,
    'and says nothing about tools Codex does not have');
});

test('what a refused step is told, and the failure line, are unchanged', () => {
  assert.strictEqual(FAILED_LINE, FAILED_LINE_TEXT);
  assert.strictEqual(UNATTENDED_NEXT, NEXT_TEXT);
  assert.strictEqual(UNATTENDED_NEXT_UNLOADED, NEXT_TEXT);
  const told = {
    denied: 'The person refused this command.',
    timeout: 'No one answered the request for this command in time, so it was refused.',
    sandbox: 'The workspace\'s sandbox settings blocked this command.',
  };
  for (const [kind, what] of Object.entries(told)) {
    assert.strictEqual(refusalNotice(kind, 'Bash'), `${what} ${DELIBERATE} Stop and ask the person what to do.`, `${kind}, a conversation`);
    assert.strictEqual(refusalNotice(kind, 'Bash', { unattended: true }), `${what} ${DELIBERATE} ${NEXT_TEXT}`, `${kind}, a routine`);
    assert.strictEqual(refusalNotice(kind, 'Bash', { unattended: 'yes' }), `${what} ${DELIBERATE} Stop and ask the person what to do.`,
      `${kind}, a stray value keeps a conversation's words`);
  }
  assert.strictEqual(refusalNotice('denied', 'Write', { unattended: true }), `The person refused this Write call. ${DELIBERATE} ${NEXT_TEXT}`);
  assert.strictEqual(refusalNotice('denied', 'PowerShell'), `The person refused this command. ${DELIBERATE} Stop and ask the person what to do.`);
  assert.strictEqual(refusalNotice('timeout', 'not a name!'), `No one answered the request for this action in time, so it was refused. ${DELIBERATE} Stop and ask the person what to do.`);
  assert.strictEqual(refusalNotice('allowed', 'Bash'), null, 'anything else is no refusal');
  const reason = 'Rundock could not check this request, so it was refused rather than approved on your behalf.';
  assert.strictEqual(unansweredNotice(reason), reason);
  assert.strictEqual(unansweredNotice(reason, { unattended: true }), `${reason} ${NEXT_TEXT}`);
  assert.strictEqual(unansweredNotice(reason, { unattended: 1 }), reason);
});

// In both modes: the sentence is about Notes mode's card, but a workspace can
// be switched between runs, and Code mode is told the same so a routine
// written in one mode behaves the same in the other.
for (const [mode, list] of [['notes', NOTES_DISALLOWED_TOOLS], ['code', null]]) {
  test(`a routine on Claude Code in ${mode === 'notes' ? 'Notes' : 'Code'} mode carries the line, file tools and all, in its system prompt, and its routine prompt is unchanged`, async () => {
    await setMode(mode);
    try {
      h.clearInvocations();
      client.send({ type: 'run_routine_now', agentId: 'writer', name: 'sweep', occurrence: 0 });
      assert.ok(await h.waitUntil(() => h.readInvocations().some(i => i.print), 10000), 'the routine started a child');
      const spawn = h.readInvocations().find(i => i.print);
      assert.strictEqual(flagValue(spawn.argv, '--disallowed-tools'), list, `the run took ${mode} mode`);
      const line = flagValue(spawn.argv, '--append-system-prompt');
      assert.strictEqual(line, UNATTENDED_RUN);
      assertFileToolsPlaced(line);
      assert.ok(line.endsWith(FAILED_LINE_TEXT), 'still ending on the failure line');
      assert.doesNotMatch(line, /\n/, 'still one line');
      assert.strictEqual(spawn.argv[spawn.argv.length - 1], 'writer sweep', 'the routine prompt is the plan that was approved, untouched');
      assert.strictEqual(spawn.argv.filter(a => a === '--append-system-prompt').length, 1);
      await settle('writer:sweep');
    } finally {
      await setMode('notes');
    }
  });
}

// The thread/start each Codex request in the stub's log asked for.
const codexThreadStarts = () => h.readInvocations()
  .filter(i => i.mode === 'app-server' && i.method === 'thread/start')
  .map(i => i.params || {});

test('a routine on Codex carries the line in its thread\'s developer instructions, and its turn input is unchanged', async () => {
  h.clearInvocations();
  client.send({ type: 'run_routine_now', agentId: 'helper', name: 'check', occurrence: 0 });
  assert.ok(await h.waitUntil(() => h.codexTurnPrompts().some(p => p.includes('helper check')), 20000), 'the routine started a turn');
  const [thread] = codexThreadStarts();
  assert.ok(thread, 'the routine started a thread');
  assert.strictEqual(thread.developerInstructions, UNATTENDED_RUN_CODEX, 'the line is in the session-level channel');
  assert.strictEqual(thread.developerInstructions, CODEX_LINE, 'byte for byte what a Codex routine was always told');
  assert.ok(!thread.developerInstructions.includes(FILE_TOOLS), 'without the file-tools sentence, which is false on Codex');
  assert.doesNotMatch(thread.developerInstructions, /file tools|Write and Edit/);
  const prompt = h.codexTurnPrompts().find(p => p.includes('helper check'));
  assert.ok(!prompt.includes('Nobody is watching'), 'and nowhere in the turn input');
  assert.ok(!prompt.includes(FILE_TOOLS), 'nor the file-tools sentence');
  assert.ok(prompt.endsWith('helper check'), 'whose routine prompt is last, as it was approved');
  await settle('helper:check');
});

test('a conversation has somebody to ask, on either runtime, and never gets the line', async () => {
  h.clearInvocations();
  const claudeConvo = h.freshConvoId('watched');
  client.send({ type: 'chat', conversationId: claudeConvo, agent: 'writer', content: 'hello writer' });
  await client.waitForEvent('system', 'done', claudeConvo);
  const conversation = h.readInvocations().find(i => !i.print && Array.isArray(i.argv));
  assert.ok(conversation, 'the conversation started a child');
  assert.ok(conversation.argv.includes('--append-system-prompt'), 'a conversation has a system prompt of its own');
  assert.ok(!conversation.argv.some(a => String(a).includes('Nobody is watching')), 'without the routine line in it');
  assert.ok(!conversation.argv.some(a => String(a).includes(FILE_TOOLS)), 'or the file-tools sentence');
  h.reapConvo(claudeConvo);

  const codexConvo = h.freshConvoId('watched-codex');
  client.send({ type: 'chat', conversationId: codexConvo, agent: 'helper', content: 'hello helper' });
  await client.waitForEvent('system', 'done', codexConvo);
  const turn = h.codexTurnPrompts().find(p => p.includes('hello helper'));
  assert.ok(turn, 'the Codex conversation started a turn');
  assert.ok(!turn.includes('Nobody is watching'), 'and its prompt carries no routine line');
  assert.ok(!turn.includes(FILE_TOOLS), 'or file-tools sentence');
  const threads = codexThreadStarts();
  assert.ok(threads.length, 'on a thread it started');
  assert.ok(threads.every(t => !String(t.developerInstructions || '').includes('Nobody is watching')),
    'whose developer instructions carry no routine line either');
  assert.ok(threads.every(t => !String(t.developerInstructions || '').includes(FILE_TOOLS)),
    'nor the file-tools sentence');
});
