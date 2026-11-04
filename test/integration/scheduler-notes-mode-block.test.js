'use strict';
// A ROUTINE IS HELD TO THE NOTES-MODE BLOCK ON WRITING EXECUTABLE FILES, as a
// conversation is.
//
// Notes mode keeps an agent from writing files that run as code, and Claude
// Code enforces it through the --disallowed-tools list the spawn carries. A
// routine runs with --dangerously-skip-permissions, which the list still binds,
// so a routine spawned without the list could write what no conversation in the
// same workspace can.
//
// THE DISK IS THE EVIDENCE, AND THE RUN'S OWN TRANSCRIPT SAYS WHY. The stub
// really writes, renames and deletes, puts each shell command to Rundock's real
// permission hook first, and refuses exactly what Claude Code refuses for the
// list it was handed, in the CLI's own words. That model is held to a
// measurement of the installed CLI (test/fixtures/claude-cli-notes-mode.json,
// by test/unit/stub-claude-matches-cli.test.js). So each assertion below is
// about what is in the workspace after the run and what each call was told,
// and every run that is refused something also does something it is allowed
// to, so a refusal cannot be mistaken for a run that never reached its work.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');

const scheduler = require('../../lib/scheduler.js');
const { NOTES_DISALLOWED_TOOLS } = require('../../lib/workspace/mode.js');
const { findTranscript } = require('../../lib/runtime/session-transcript.js');

// What Claude Code said back when it refused, as measured.
const RECORD = require('../fixtures/claude-cli-notes-mode.json');
function measured(caseName, command) {
  const c = RECORD.cases.find(k => k.name === caseName);
  return c.observed.results[c.steps.findIndex(s => (s.command || s.file) === command)].message;
}
const REFUSED_WRITE = measured('Notes list, file writes', 'tool.py');
const refusedShell = command => measured('Notes list, shell renames and deletes', 'rm tool.py').replace('rm tool.py', command);

const AGENT = 'content-lead';
let client;
let seq = 0;

before(async () => {
  await h.boot();
  client = await h.connect();
});
after(async () => h.shutdown());

async function setMode(mode) {
  const since = client.messages.length;
  client.send({ type: 'set_workspace_mode', mode });
  await client.waitFor(m => m.type === 'workspace_mode_changed' && m.mode === mode, { since, label: `mode ${mode}` });
  assert.strictEqual(h.internal.readState().workspaceMode, mode);
}

// Each test works in a folder of its own inside the workspace, so one test's
// files can never answer another's assertions.
function folder(name) {
  const dir = path.join(h.workspaceDir, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return {
    rel: (f) => `${name}/${f}`,
    has: (f) => fs.existsSync(path.join(dir, f)),
    read: (f) => fs.readFileSync(path.join(dir, f), 'utf8'),
    seed: (f) => fs.writeFileSync(path.join(dir, f), 'here before the run\n'),
  };
}

// Answers every permission card that matches, from now on, with Allow, as a
// person approving each one would, through the same message the window sends.
function approveCards(match) {
  let next = client.messages.length;
  let stopped = false;
  const answered = [];
  const loop = (async () => {
    while (!stopped) {
      for (; next < client.messages.length; next++) {
        const m = client.messages[next];
        if (m.type !== 'control_request' || !match(m)) continue;
        client.send({ type: 'permission_response', requestId: m.request_id, conversationId: m._conversationId, allow: true, card: true });
        answered.push(m);
      }
      await h.delay(20);
    }
  })();
  return { answered, stop: async () => { stopped = true; await loop; } };
}

// Each tool call a run made and what it was told, from the session transcript
// the run keeps, in the order it made them.
function callsOf(sessionId) {
  const file = findTranscript(sessionId);
  assert.ok(file, `the run ${sessionId} kept a transcript`);
  const asked = [];
  const told = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const entry = JSON.parse(line);
    for (const b of (entry.message && Array.isArray(entry.message.content)) ? entry.message.content : []) {
      if (b.type === 'tool_use') asked.push(b);
      if (b.type === 'tool_result') told.set(b.tool_use_id, b);
    }
  }
  return asked.map((b) => {
    const r = told.get(b.id);
    const target = b.input.command || path.basename(b.input.file_path || b.input.notebook_path || '');
    return { tool: b.name, target, content: b.input.content, answered: !!r, refused: !!(r && r.is_error), message: r && r.is_error ? r.content : null };
  });
}

// One routine run, started the way the scheduler starts every run, waited
// out, and handed back with the argument list it was spawned with, what each
// of its tool calls was told, and the cards approved for it (`approve`).
async function runRoutine(rule = {}, { approve = false } = {}) {
  const n = ++seq;
  const prompt = `routine work number ${n}`;
  const name = `notes-block-${n}`;
  const key = `${AGENT}:${name}`;
  h.clearInvocations();
  h.clearPrompts();
  h.writeScenario([{ match: { agent: AGENT, promptIncludes: prompt }, turn: [{ text: 'done' }], ...rule }]);
  const agent = h.internal.discoverAgents().find(a => a.id === AGENT);
  assert.ok(agent, 'fixture agent present');
  const cards = approve ? approveCards(m => !!m._run && m._run.routine === name) : null;
  h.internal.executeRoutine(agent, { name, schedule: 'every day at 09:00', prompt }, key);
  try {
    assert.ok(await h.waitUntil(() => {
      const s = h.internal.routineState[key];
      return s && s.status !== 'running';
    }), 'the run finished');
  } finally {
    if (cards) await cards.stop();
  }
  const spawns = h.readInvocations().filter(i => i.print);
  assert.strictEqual(spawns.length, 1, 'exactly one routine spawn');
  const argv = spawns[0].argv;
  const sessionId = argv[argv.indexOf('--session-id') + 1];
  return {
    argv, prompt, sessionId, status: h.internal.routineState[key].status,
    calls: callsOf(sessionId), approved: cards ? cards.answered.map(m => m.request.input.command) : [],
  };
}

function listOf(argv) {
  const i = argv.indexOf('--disallowed-tools');
  return i === -1 ? null : argv[i + 1];
}

describe('a Notes-mode routine', () => {
  test('is spawned with the Notes list, ahead of --print', async () => {
    const { argv } = await runRoutine();
    const i = argv.indexOf('--disallowed-tools');
    assert.notStrictEqual(i, -1, 'the routine carries --disallowed-tools');
    assert.strictEqual(argv[i + 1], NOTES_DISALLOWED_TOOLS);
    assert.ok(argv[i + 1].length > 0, 'and the list is not empty');
    // The flag takes every argument up to the next flag. Ahead of --print it
    // stops there; anywhere after, the next argument that is not a flag is the
    // prompt, and the run is left with nothing to do.
    assert.ok(i < argv.indexOf('--print'), 'the list comes before --print');
    assert.strictEqual(argv.lastIndexOf('--disallowed-tools'), i, 'and appears once');
  });

  test('still gets its prompt: the last argument, read by the run, and the run completes', async () => {
    const { argv, prompt, status } = await runRoutine();
    assert.strictEqual(argv[argv.length - 1], prompt, 'the prompt is the last argument');
    assert.deepStrictEqual(h.promptsFor(AGENT), [prompt], 'the run read the prompt as its input');
    assert.strictEqual(status, 'completed');
  });

  test('is refused a file-tool write of an executable file', async () => {
    const w = folder('refused-writes');
    await runRoutine({
      writes: [
        { file: w.rel('tool.py') },
        { file: w.rel('build.sh') },
        { file: w.rel('lib.dll') },
        { file: w.rel('lib.so') },
        { tool: 'NotebookEdit', file: w.rel('analysis.ipynb') },
        { file: w.rel('summary.md') },
      ],
    });
    assert.ok(w.has('summary.md'), 'the run wrote its note, so it did reach its writes');
    for (const f of ['tool.py', 'build.sh', 'lib.dll', 'lib.so', 'analysis.ipynb']) {
      assert.ok(!w.has(f), `${f} was refused`);
    }
  });

  test('still writes and edits ordinary notes', async () => {
    const w = folder('ordinary-notes');
    w.seed('existing.md');
    await runRoutine({
      writes: [
        { file: w.rel('new.md') },
        { file: w.rel('list.txt') },
        { file: w.rel('data.json') },
        { tool: 'Edit', file: w.rel('existing.md') },
      ],
    });
    for (const f of ['new.md', 'list.txt', 'data.json']) assert.ok(w.has(f), `${f} was written`);
    assert.notStrictEqual(w.read('existing.md'), 'here before the run\n', 'the existing note was edited');
  });

  test('is refused a retried write, in the same run and in the next one', async () => {
    const w = folder('retried-write');
    const first = await runRoutine({ writes: [{ file: w.rel('tool.py') }, { file: w.rel('tool.py') }, { file: w.rel('first.md') }] });
    // Both attempts reached the file tool, and each was told it was refused.
    const attempts = first.calls.filter(c => c.target === 'tool.py');
    assert.strictEqual(attempts.length, 2, 'the first run asked to write tool.py twice');
    for (const [i, a] of attempts.entries()) {
      assert.deepStrictEqual([a.tool, a.answered, a.refused, a.message], ['Write', true, true, REFUSED_WRITE], `attempt ${i + 1} was refused`);
    }
    assert.ok(first.calls.some(c => c.target === 'first.md' && c.answered && !c.refused), 'and the run went on to its note');
    assert.ok(w.has('first.md') && !w.has('tool.py'), 'nothing reached the disk');

    const second = await runRoutine({ writes: [{ file: w.rel('tool.py') }, { file: w.rel('second.md') }] });
    assert.notStrictEqual(second.sessionId, first.sessionId, 'the next run is a separate spawn, with its own session');
    const again = second.calls.filter(c => c.target === 'tool.py');
    assert.strictEqual(again.length, 1);
    assert.deepStrictEqual([again[0].refused, again[0].message], [true, REFUSED_WRITE], 'the next run was refused on its own account');
    assert.ok(w.has('second.md') && !w.has('tool.py'));
    // On every spawn, not only the first.
    assert.strictEqual(listOf(first.argv), NOTES_DISALLOWED_TOOLS);
    assert.strictEqual(listOf(second.argv), NOTES_DISALLOWED_TOOLS);
  });

  test('can save the same work, unchanged, as a note once the executable write is refused', async () => {
    const w = folder('next-step');
    const work = 'Quarterly figures\nRevenue: 12\nCosts: 7\n';
    const run = await runRoutine({ writes: [{ file: w.rel('report.py'), content: work }, { file: w.rel('report.md'), content: work }] });
    const [py, md] = ['report.py', 'report.md'].map(f => run.calls.find(c => c.target === f));
    assert.strictEqual(py.content, work, 'the refused write carried the work');
    assert.deepStrictEqual([py.refused, py.message], [true, REFUSED_WRITE], 'and was refused');
    assert.ok(!w.has('report.py'));
    assert.strictEqual(md.content, work, 'the note carried the same work');
    assert.strictEqual(md.refused, false);
    assert.strictEqual(w.read('report.md'), work, 'and the note on disk holds exactly those bytes');
  });

  test('is refused a rename or delete of an executable file even with its card approved, and not of a note', async () => {
    // Claude Code holds a shell `rm` or `mv` to the same Edit(path) rules, so
    // with the list on the spawn these are refused by the CLI itself, after the
    // permission hook has asked and been answered Allow. A rename or delete of
    // an ordinary note goes ahead once its card is approved.
    const w = folder('rename-delete');
    for (const f of ['tool.py', 'other.sh', 'note.md', 'old.md', 'gone.md']) w.seed(f);
    const commands = {
      deletePy: `rm ${w.rel('tool.py')}`,
      renameSh: `mv ${w.rel('other.sh')} ${w.rel('other.md')}`,
      renameToPy: `mv ${w.rel('note.md')} ${w.rel('note.py')}`,
      renameNote: `mv ${w.rel('old.md')} ${w.rel('new.md')}`,
      deleteNote: `rm ${w.rel('gone.md')}`,
    };
    const run = await runRoutine({ shell: Object.values(commands) }, { approve: true });
    // The deletes are the commands Rundock cards, and each card was approved.
    assert.ok(run.approved.includes(commands.deletePy), 'deleting tool.py raised a card, and it was approved');
    assert.ok(run.approved.includes(commands.deleteNote), 'deleting gone.md raised a card, and it was approved');
    const told = command => run.calls.find(c => c.tool === 'Bash' && c.target === command);
    for (const key of ['deletePy', 'renameSh', 'renameToPy']) {
      assert.deepStrictEqual([told(commands[key]).refused, told(commands[key]).message], [true, refusedShell(commands[key])], `${commands[key]} was refused by Claude Code`);
    }
    for (const key of ['renameNote', 'deleteNote']) assert.strictEqual(told(commands[key]).refused, false, `${commands[key]} went ahead`);
    assert.ok(w.has('tool.py'), 'deleting tool.py was refused');
    assert.ok(w.has('other.sh') && !w.has('other.md'), 'renaming other.sh away was refused');
    assert.ok(w.has('note.md') && !w.has('note.py'), 'renaming a note to an executable name was refused');
    assert.ok(!w.has('old.md') && w.has('new.md'), 'renaming a note went ahead');
    assert.ok(!w.has('gone.md'), 'deleting a note went ahead');
  });
});

describe('a Notes-mode conversation', () => {
  test('is refused a rename or delete of an executable file when its card is approved, and renames or deletes a note', async () => {
    // The same check, reached the way a person reaches it: the agent asks, the
    // card is shown in the conversation, the person approves it, the hook
    // answers Allow, and Claude Code refuses all the same.
    const w = folder('conversation-rename-delete');
    for (const f of ['tool.py', 'other.sh', 'old.md', 'gone.md']) w.seed(f);
    const commands = [`rm ${w.rel('tool.py')}`, `mv ${w.rel('other.sh')} ${w.rel('other.md')}`, `mv ${w.rel('old.md')} ${w.rel('new.md')}`, `rm ${w.rel('gone.md')}`];
    const convoId = h.freshConvoId('notes-rename-delete');
    h.clearInvocations();
    h.writeScenario([{ match: { agent: 'lead-designer', promptIncludes: 'tidy the folder' }, shell: commands, turn: [{ text: 'tidied.' }] }]);
    const cards = approveCards(m => m._conversationId === convoId);
    try {
      client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 'tidy the folder' });
      await client.waitForEvent('system', 'done', convoId);
    } finally {
      await cards.stop();
      h.reapConvo(convoId);
    }
    assert.strictEqual(listOf(h.readInvocations()[0].argv), NOTES_DISALLOWED_TOOLS, 'the conversation carried the Notes list');
    const approved = cards.answered.map(m => m.request.input.command);
    assert.ok(approved.includes(commands[0]), 'deleting tool.py raised a card in the conversation, and it was approved');
    assert.ok(approved.includes(commands[3]), 'deleting gone.md raised a card, and it was approved');
    assert.ok(w.has('tool.py'), 'deleting tool.py was refused all the same');
    assert.ok(w.has('other.sh') && !w.has('other.md'), 'renaming other.sh away was refused');
    assert.ok(!w.has('old.md') && w.has('new.md'), 'renaming a note went ahead');
    assert.ok(!w.has('gone.md'), 'deleting a note went ahead');
  });
});

describe('a Code-mode routine', () => {
  test('is spawned with no --disallowed-tools, exactly as before', async () => {
    await setMode('code');
    try {
      const w = folder('code-mode');
      w.seed('old.py');
      const { argv, prompt } = await runRoutine({ writes: [{ file: w.rel('tool.py') }], shell: [`rm ${w.rel('old.py')}`] }, { approve: true });
      assert.ok(!argv.includes('--disallowed-tools'), 'no list in Code mode');
      // Nothing new sits between the spawn plumbing and --print.
      const head = argv.slice(0, argv.indexOf('--print'));
      assert.deepStrictEqual(head.filter((a) => a.startsWith('--')), ['--add-dir', '--settings']);
      assert.strictEqual(argv[argv.length - 1], prompt);
      assert.ok(w.has('tool.py'), 'Code mode writes executable files');
      assert.ok(!w.has('old.py'), 'and deletes them');
    } finally {
      await setMode('notes');
    }
  });

  test('takes the mode the workspace has when each run starts', async () => {
    assert.strictEqual(listOf((await runRoutine()).argv), NOTES_DISALLOWED_TOOLS, 'a Notes run');
    await setMode('code');
    try {
      assert.strictEqual(listOf((await runRoutine()).argv), null, 'the next run, after switching to Code');
    } finally {
      await setMode('notes');
    }
    assert.strictEqual(listOf((await runRoutine()).argv), NOTES_DISALLOWED_TOOLS, 'and the one after switching back');
  });
});

describe('a routine whose workspace mode cannot be read', () => {
  // Each starts in Code mode, so a run that lands on the Notes list has been
  // moved there by the failure rather than by the workspace.
  test('gets the Notes list when the state file is unreadable', async () => {
    await setMode('code');
    const file = path.join(h.workspaceDir, '.rundock', 'state.json');
    const saved = fs.readFileSync(file, 'utf8');
    try {
      fs.writeFileSync(file, '{ this is not json');
      const w = folder('unreadable-state');
      const { argv } = await runRoutine({ writes: [{ file: w.rel('tool.py') }, { file: w.rel('note.md') }] });
      assert.strictEqual(listOf(argv), NOTES_DISALLOWED_TOOLS);
      assert.ok(w.has('note.md') && !w.has('tool.py'), 'and is held to it');
    } finally {
      fs.writeFileSync(file, saved);
      await setMode('notes');
    }
  });

  test('gets the Notes list when the reader throws', async () => {
    await setMode('code');
    const prev = scheduler.wireSchedulerDeps({ getDisallowedTools: () => { throw new Error('the mode could not be read'); } });
    try {
      assert.strictEqual(listOf((await runRoutine()).argv), NOTES_DISALLOWED_TOOLS);
    } finally {
      scheduler.wireSchedulerDeps(prev);
      await setMode('notes');
    }
  });

  test('gets the Notes list when the reader answers with something other than a list', async () => {
    await setMode('code');
    const prev = scheduler.wireSchedulerDeps({ getDisallowedTools: () => undefined });
    try {
      assert.strictEqual(listOf((await runRoutine()).argv), NOTES_DISALLOWED_TOOLS);
    } finally {
      scheduler.wireSchedulerDeps(prev);
      await setMode('notes');
    }
  });
});

describe('one list', () => {
  test('a routine and a conversation in Notes mode are handed the same value', async () => {
    const convoId = h.freshConvoId('notes-list');
    h.clearInvocations();
    h.writeScenario([{ match: { agent: 'lead-designer' }, turn: [{ text: 'answered.' }] }]);
    client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 'which list do I get' });
    await client.waitForEvent('system', 'done', convoId);
    const conversation = listOf(h.readInvocations()[0].argv);
    h.reapConvo(convoId);

    const routine = listOf((await runRoutine()).argv);
    assert.strictEqual(routine, conversation);
    assert.strictEqual(routine, NOTES_DISALLOWED_TOOLS);
    assert.strictEqual(h.internal.DISALLOWED_TOOLS_KNOWLEDGE, NOTES_DISALLOWED_TOOLS);
  });
});
