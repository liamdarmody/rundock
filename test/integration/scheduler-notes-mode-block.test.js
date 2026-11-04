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
// THE DISK IS THE EVIDENCE. The stub really writes, renames and deletes, and
// refuses exactly what Claude Code refuses for the list it was handed (pinned
// against measured results in test/unit/stub-claude-tool-rules.test.js). So
// each assertion below is about what is in the workspace after the run, and
// every run that is refused something also does something it is allowed to, so
// a refusal cannot be mistaken for a run that never reached its work.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');

const scheduler = require('../../lib/scheduler.js');
const { NOTES_DISALLOWED_TOOLS } = require('../../lib/workspace/mode.js');

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

// One routine run, started the way the scheduler starts every run, waited
// out, and handed back with the argument list it was spawned with.
async function runRoutine(rule = {}) {
  const n = ++seq;
  const prompt = `routine work number ${n}`;
  const key = `${AGENT}:notes-block-${n}`;
  h.clearInvocations();
  h.clearPrompts();
  h.writeScenario([{ match: { agent: AGENT, promptIncludes: prompt }, turn: [{ text: 'done' }], ...rule }]);
  const agent = h.internal.discoverAgents().find(a => a.id === AGENT);
  assert.ok(agent, 'fixture agent present');
  h.internal.executeRoutine(agent, { name: `notes-block-${n}`, schedule: 'every day at 09:00', prompt }, key);
  assert.ok(await h.waitUntil(() => {
    const s = h.internal.routineState[key];
    return s && s.status !== 'running';
  }), 'the run finished');
  const spawns = h.readInvocations().filter(i => i.print);
  assert.strictEqual(spawns.length, 1, 'exactly one routine spawn');
  return { argv: spawns[0].argv, prompt, status: h.internal.routineState[key].status };
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
    assert.ok(w.has('first.md') && !w.has('tool.py'), 'both attempts in the first run were refused');
    const second = await runRoutine({ writes: [{ file: w.rel('tool.py') }, { file: w.rel('second.md') }] });
    assert.ok(w.has('second.md') && !w.has('tool.py'), 'the next run was refused too');
    // On every spawn, not only the first.
    assert.strictEqual(listOf(first.argv), NOTES_DISALLOWED_TOOLS);
    assert.strictEqual(listOf(second.argv), NOTES_DISALLOWED_TOOLS);
  });

  test('can save the same work as a note once the executable write is refused', async () => {
    const w = folder('next-step');
    await runRoutine({ writes: [{ file: w.rel('report.py') }, { file: w.rel('report.md') }] });
    assert.ok(!w.has('report.py'), 'the executable write was refused');
    assert.ok(w.has('report.md'), 'the same work saved as a note went ahead');
  });

  test('is refused a rename or delete of an executable file, and not of a note', async () => {
    // Claude Code holds a shell `rm` or `mv` to the same Edit(path) rules, so
    // with the list on the spawn these are refused by the CLI itself, even when
    // the permission hook allows them, exactly as a Notes-mode conversation's
    // already are. A rename or delete of an ordinary note is untouched.
    const w = folder('rename-delete');
    for (const f of ['tool.py', 'other.sh', 'note.md', 'old.md', 'gone.md']) w.seed(f);
    await runRoutine({
      shell: [
        `rm ${w.rel('tool.py')}`,
        `mv ${w.rel('other.sh')} ${w.rel('other.md')}`,
        `mv ${w.rel('note.md')} ${w.rel('note.py')}`,
        `mv ${w.rel('old.md')} ${w.rel('new.md')}`,
        `rm ${w.rel('gone.md')}`,
      ],
    });
    assert.ok(w.has('tool.py'), 'deleting tool.py was refused');
    assert.ok(w.has('other.sh') && !w.has('other.md'), 'renaming other.sh away was refused');
    assert.ok(w.has('note.md') && !w.has('note.py'), 'renaming a note to an executable name was refused');
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
      const { argv, prompt } = await runRoutine({ writes: [{ file: w.rel('tool.py') }], shell: [`rm ${w.rel('old.py')}`] });
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
