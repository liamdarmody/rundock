'use strict';
// AGENTS ARE TOLD TO PUT SCRATCH FILES IN THE WORKSPACE'S OWN SCRATCH FOLDER,
// BY ITS FULL PATH, AND FOLLOWING THAT RAISES NO CARD.
//
// The SCRATCH FILES paragraph used to say: use the path in $TMPDIR, because
// Rundock points it at a scratch folder inside the workspace. Two things made
// that untrue in use. The runtime's sandbox gives each sandboxed command a
// TMPDIR of its own, under /tmp, so the value in the spawn environment never
// reaches the command. And where it does, the Code-mode check grades a delete
// through a variable as always asking, because it cannot know what the
// variable will hold when the command runs. That grading is right and stays.
// So an agent that did as it was told raised a card for its own temp file.
//
// The tests take the folder from the prompt an agent actually receives and
// drive the real permission modules with it, so the words and the behavior
// cannot drift apart. What a Codex thread receives is tested through the real
// server and the stub Codex, in test/integration/codex-scratch-files.test.js.
require('../helpers/made-up-home.js');
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { _internal: srv } = require('../../server.js');
const { buildSystemPrompt } = require('../../lib/agents/prompt.js');
const config = require('../../lib/config.js');
const claudeRuntime = require('../../lib/runtime/claude.js');
const { classifyFileAccess, classifyShellAccess } = require('../../scripts/permission-hook.js');
const { codeModeVerdict } = require('../../scripts/code-mode-verdict.js');
const RP = require('../../public/permissions.js');
const { makeWorkspace, cleanup } = require('../helpers/workspace.js');

after(cleanup);

const AGENT = { id: 'scout', name: 'scout', displayName: 'Scout', instructions: 'You are Scout.' };
const MODES = ['notes', 'code'];

// The lines between the SCRATCH FILES heading and the next blank line.
function scratchParagraph(prompt) {
  const lines = prompt.split('\n');
  const at = lines.indexOf('SCRATCH FILES:');
  assert.ok(at >= 0, 'the prompt has a SCRATCH FILES section');
  const end = lines.indexOf('', at);
  return lines.slice(at + 1, end).join('\n');
}

// The folder the paragraph tells an agent to use, as it is written there.
function namedFolder(paragraph) {
  const m = /use the folder `([^`]+)`/.exec(paragraph);
  assert.ok(m, `the paragraph names a folder:\n${paragraph}`);
  return m[1];
}

function workspaceIn(mode) {
  const ws = makeWorkspace({});
  srv.setWorkspace(ws);
  srv.writeState({ workspaceMode: mode });
  return ws;
}

// The workspace root joined with .rundock/scratch/, in this platform's spelling.
const scratchOf = (ws) => path.join(ws, '.rundock', 'scratch') + path.sep;

describe('the paragraph names the workspace scratch folder, in both modes', () => {
  for (const mode of MODES) {
    test(`${mode} mode: the full path, why it needs no approval, and why not the variables or /tmp`, () => {
      const ws = workspaceIn(mode);
      const paragraph = scratchParagraph(buildSystemPrompt(AGENT));
      assert.ok(!paragraph.includes('\n'), 'one paragraph, on one line');
      assert.strictEqual(namedFolder(paragraph), scratchOf(ws), 'the full path, so a command can use it as written');
      assert.match(paragraph, /It is inside this workspace, so reading a file back from there needs no approval\./);
      assert.match(paragraph, /Do not use \$TMPDIR, TEMP, TMP or \/tmp for scratch/);
      assert.match(paragraph, /Rundock can't tell where a variable points when a command runs/);
      assert.match(paragraph, /a folder outside the workspace/);
      assert.match(paragraph, /no standing folder grant covers it/);
      assert.doesNotMatch(paragraph, /use the path in \$TMPDIR/, 'the variable is no longer the instruction');
      assert.doesNotMatch(paragraph, /Rundock points/, 'nor the claim that Rundock points it inside the workspace');
    });
  }

  test('the folder named is the one the spawn environment creates and points TMPDIR at', () => {
    workspaceIn('notes');
    const named = namedFolder(scratchParagraph(buildSystemPrompt(AGENT)));
    const env = claudeRuntime.getSpawnEnv(null);
    assert.strictEqual(named, env.TMPDIR + path.sep);
    assert.ok(fs.existsSync(env.TMPDIR), 'and it exists, so the first write lands');
  });

  test('it says the same thing in both modes, and claims no approval for a write', () => {
    // True in both modes means nothing that holds in only one: in Notes mode a
    // shell command that changes files asks, so the paragraph claims approval
    // is not needed for reading back, and for nothing else.
    const said = {};
    for (const mode of MODES) {
      const ws = workspaceIn(mode);
      said[mode] = scratchParagraph(buildSystemPrompt(AGENT)).split(ws).join('<workspace>');
    }
    assert.strictEqual(said.code, said.notes);
    for (const sentence of said.notes.split(/(?<=\.) /)) {
      if (!/no approval|without approval|never asks/i.test(sentence)) continue;
      assert.match(sentence, /reading/, sentence);
      assert.doesNotMatch(sentence, /\bwrit/i, sentence);
    }
  });

  test('with no workspace open, no path is built from an empty root', () => {
    const open = config.getWorkspace();
    try {
      config.setWorkspace(null);
      const paragraph = scratchParagraph(buildSystemPrompt(null));
      assert.doesNotMatch(paragraph, /null|undefined/);
      assert.doesNotMatch(paragraph, /(^|[\s`'"])[\\/]\.rundock/, 'no folder at the root of the disk');
      assert.match(paragraph, /`\.rundock\/scratch\/` in this workspace/);
    } finally {
      config.setWorkspace(open);
    }
  });
});

describe('following the instruction raises no card in Code mode, and what it claims holds in Notes mode', () => {
  // One command that writes the scratch file, reads it back and deletes it:
  // the word count that raised a card when it went through $TMPDIR.
  const wordCount = (file) => `printf 'one two three' > '${file}' && wc -w < '${file}' && rm '${file}'`;
  const verdict = (ws, command) => codeModeVerdict({ toolName: 'Bash', command, cwd: ws, workspaceRoot: ws, extraDirs: [] });
  const followed = (mode) => {
    const ws = workspaceIn(mode);
    return { ws, file: path.join(namedFolder(scratchParagraph(buildSystemPrompt(AGENT))), 'wc.txt') };
  };

  test('the named folder: the command runs, crosses no boundary, and the file reads as inside', () => {
    const { ws, file } = followed('code');
    // Graded before it runs, when the file is not there yet, and again with it
    // there, as for a delete made a step after the write.
    assert.deepStrictEqual(verdict(ws, wordCount(file)), { verdict: 'runs' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'one two three');
    try {
      assert.deepStrictEqual(verdict(ws, wordCount(file)), { verdict: 'runs' });
      assert.strictEqual(classifyShellAccess('Bash', { command: wordCount(file) }, ws, [], undefined, undefined, { cwd: ws, codeMode: true }), null);
      assert.strictEqual(classifyFileAccess('Read', { file_path: file }, ws, [], undefined, undefined, undefined, { codeMode: true }).where, 'inside');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  // These two pin what does not change, so they pass before and after.
  test('it runs because of the scratch folder: the same file elsewhere in the workspace asks', () => {
    const ws = workspaceIn('code');
    const elsewhere = path.join(ws, 'notes', 'wc.txt');
    fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
    fs.writeFileSync(elsewhere, 'one two three');
    assert.strictEqual(verdict(ws, wordCount(elsewhere)).verdict, 'always-asks',
      'a delete of a file git cannot bring back asks, so the scratch folder is what lets the command run');
  });

  test('through "$TMPDIR" the same command still always asks, for unknown targets', () => {
    const ws = workspaceIn('code');
    const command = 'printf \'one two three\' > "$TMPDIR/wc.txt" && wc -w < "$TMPDIR/wc.txt" && rm "$TMPDIR/wc.txt"';
    assert.deepStrictEqual(verdict(ws, command), { verdict: 'always-asks', reason: 'unknown-targets' });
  });

  test('in Notes mode the paragraph is true as well: reading back needs no approval, and a change asks', () => {
    const { ws, file } = followed('notes');
    assert.strictEqual(classifyFileAccess('Read', { file_path: file }, ws, []).where, 'inside');
    // What Notes mode decides for a shell command with no saved answers.
    const decided = (command) => RP.decidePermission(RP.classifyRisk('Bash', { command }), RP.toolAllowKey('Bash', { command }), new Set(), null).action;
    const read = `cat '${file}'`;
    assert.strictEqual(classifyShellAccess('Bash', { command: read }, ws, [], undefined, undefined, { cwd: ws }), null);
    assert.strictEqual(decided(read), 'allow');
    assert.strictEqual(decided(wordCount(file)), 'card', 'which is why the paragraph does not say writing there needs no approval');
  });
});
