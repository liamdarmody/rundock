'use strict';
// A FILE-TOOL WRITE INTO THE WORKSPACE'S OWN AGENTS OR SKILLS IS REFUSED BY THE
// HOOK, IN EVERY RUN.
//
// Agents and skills in a workspace are changed only by Doc (rundock-guide),
// whose save markers the server acts on. In a conversation Claude Code refuses
// a Write or Edit into the workspace's .claude/agents or .claude/skills itself,
// after this hook has allowed it. A routine runs Claude Code with
// --dangerously-skip-permissions, and there, measured, a file-tool write into
// the agents folder went ahead and changed an agent's instructions for its next
// run. So the hook refuses these writes itself: in Code mode and Notes mode, in
// a conversation and in a routine.
//
// The decision path is driven through the real hook as its own process, with
// the environment Rundock starts an agent with (getSpawnEnv in
// lib/runtime/claude.js), against a server that answers every card with an
// Allow. A deny here, with nothing asked of that server, is the hook refusing
// on its own. The check itself is driven in-process for the spellings, with
// the case-folding seam set both ways rather than left to whichever filesystem
// the suite runs on.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const hook = require('../../scripts/permission-hook.js');
const config = require('../../lib/config.js');
const claudeRt = require('../../lib/runtime/claude.js');
const auth = require('../../lib/auth/index.js');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
// What the refusal says first, in every run.
const REFUSED = /^Agents and skills in this workspace are changed only by Doc/;
const IN_WORKSPACE = /^In-workspace file access$/;
const SYMLINKS = { skip: process.platform === 'win32' && 'a directory link needs privileges on Windows' };

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'team-folders-')));
const home = path.join(root, 'home');
const wsCode = path.join(root, 'ws-code');
const wsNotes = path.join(root, 'ws-notes');
// A workspace with a .claude folder and neither agents/ nor skills/ in it, so
// a case variant of either cannot be resolved by the filesystem before the
// comparison sees it, on any host.
const wsBare = path.join(root, 'ws-bare');
// Each workspace reached through a link as well.
const linkOf = (ws) => `${ws}-link`;

function makeWorkspace(ws, mode) {
  fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.rundock', 'state.json'), `${JSON.stringify({ workspaceMode: mode })}\n`);
  fs.mkdirSync(path.join(ws, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.claude', 'agents', 'helper.md'), '---\nname: helper\ndescription: example helper\n---\nOriginal body.\n');
  fs.mkdirSync(path.join(ws, '.claude', 'skills', 'example'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.claude', 'skills', 'example', 'SKILL.md'), '---\nname: example\n---\nOriginal body.\n');
  fs.writeFileSync(path.join(ws, '.claude', 'settings.local.json'), '{}\n');
  fs.mkdirSync(path.join(ws, 'notes'), { recursive: true });
}
makeWorkspace(wsCode, 'code');
makeWorkspace(wsNotes, 'notes');
fs.mkdirSync(path.join(wsBare, '.claude'), { recursive: true });
fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
if (!SYMLINKS.skip) for (const ws of [wsCode, wsNotes]) fs.symlinkSync(ws, linkOf(ws), 'dir');

// A server standing in for Rundock: every card it is asked for is allowed, so
// a call that reached a card would be allowed, and every request is recorded.
const asked = [];
let server, port, prevRt;
before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.startsWith('/api/permission-request')) {
        try { asked.push(JSON.parse(body)); } catch (e) { asked.push(body); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ allow: true, card: true }));
        return;
      }
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  prevRt = claudeRt.wireClaudeRuntimeDeps({ getActualPort: () => port });
});
after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  if (prevRt) claudeRt.wireClaudeRuntimeDeps(prevRt);
  fs.rmSync(root, { recursive: true, force: true });
});

// The environment Rundock starts an agent with in `ws`: a conversation's,
// with its id and token, or a routine run's, with no conversation and the
// run's own token. The mode comes from the workspace's state, as it does in
// the app. The home folder is a fixture, never the account's own.
let runs = 0;
function envFor(ws, who) {
  const env = config.inWorkspace(ws, () => (who === 'routine'
    ? claudeRt.getSpawnEnv(null, auth.issueRunHookToken(`team-folders-run-${++runs}`))
    : claudeRt.getSpawnEnv('team-folders-conversation')));
  return { ...env, HOME: home, USERPROFILE: home, NODE_V8_COVERAGE: '' };
}

// The real hook, as its own process, from the workspace folder, the way the
// runtime starts it. A hook still running after HOOK_ANSWER_MS is ended, and
// its answer is then whatever it printed, which is nothing.
const HOOK_ANSWER_MS = 15000;
function runHook(env, request, { preload } = {}) {
  return new Promise((resolve) => {
    const cwd = env.RUNDOCK_WORKSPACE;
    const args = [...(preload ? ['--require', preload] : []), HOOK];
    const child = spawn(process.execPath, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const unanswered = setTimeout(() => child.kill('SIGKILL'), HOOK_ANSWER_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (status) => {
      clearTimeout(unanswered);
      let answer = null;
      try { answer = JSON.parse(out); } catch (e) { /* asserted by the callers */ }
      const own = answer && answer.hookSpecificOutput;
      resolve({ status, out, err, decision: own ? own.permissionDecision : null, reason: own ? (own.permissionDecisionReason || '') : '' });
    });
    child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd, ...request }));
  });
}

// A file-tool call naming `target` in the field its tool uses, or in `field`.
function edit(tool, target, field) {
  const key = field || (tool === 'NotebookEdit' ? 'notebook_path' : 'file_path');
  const rest = {
    Write: { content: 'Rewritten body.\n' },
    Edit: { old_string: 'Original body.', new_string: 'Rewritten body.' },
    MultiEdit: { edits: [{ old_string: 'Original body.', new_string: 'Rewritten body.' }] },
    NotebookEdit: { new_source: 'Rewritten body.', cell_type: 'markdown', edit_mode: 'replace' },
  }[tool];
  return { tool_name: tool, tool_input: { [key]: target, ...rest } };
}
const agentFile = (ws) => path.join(ws, '.claude', 'agents', 'helper.md');
const skillFile = (ws) => path.join(ws, '.claude', 'skills', 'example', 'SKILL.md');

// Code mode and Notes mode, each in a conversation and in a routine run.
const RUNS = [
  ['Code mode, a conversation', wsCode, 'conversation'],
  ['Notes mode, a conversation', wsNotes, 'conversation'],
  ['Code mode, a routine run', wsCode, 'routine'],
  ['Notes mode, a routine run', wsNotes, 'routine'],
];

async function assertRefused(env, request, what) {
  asked.length = 0;
  const r = await runHook(env, request);
  assert.strictEqual(r.status, 0, `${what}: the hook answered (${r.err})`);
  assert.strictEqual(r.decision, 'deny', `${what}: ${r.out}`);
  assert.match(r.reason, REFUSED, `${what}: refused as an agents-and-skills write`);
  assert.strictEqual(asked.length, 0, `${what}: refused by the hook, with no card`);
}

describe('a Write, Edit, MultiEdit or NotebookEdit into the workspace\'s agents or skills is refused, not carded', () => {
  for (const [label, ws, who] of RUNS) {
    test(`each file tool is refused in ${label}`, async () => {
      const env = envFor(ws, who);
      assert.strictEqual(env.RUNDOCK_CODE_MODE === '1', ws === wsCode, 'sanity: the mode is the workspace\'s');
      assert.strictEqual(!env.RUNDOCK_CONVO_ID, who === 'routine', 'sanity: a routine has no conversation');
      for (const tool of EDIT_TOOLS) {
        for (const target of [agentFile(ws), skillFile(ws)]) {
          await assertRefused(env, edit(tool, target), `${tool} ${path.relative(ws, target)}`);
        }
      }
    });
  }
});

// Every other way to spell a target in those folders, each reaching the same
// comparison the runtime home's agents and skills refusal uses.
const sep = path.sep;
function spellings(ws) {
  const link = linkOf(ws);
  return [
    ['a relative path from the workspace', ws, edit('Write', `.${sep}${path.join('.claude', 'agents', 'x.md')}`)],
    ['a relative path through notes/..', ws, edit('Write', ['notes', '..', '.claude', 'agents', 'x.md'].join(sep))],
    ['an absolute path through notes/..', ws, edit('Edit', [ws, 'notes', '..', '.claude', 'agents', 'helper.md'].join(sep))],
    ['a skill whose folder does not exist yet', ws, edit('Write', path.join(ws, '.claude', 'skills', 'new-skill', 'SKILL.md'))],
    ['the target in notebook_path', ws, edit('NotebookEdit', path.join(ws, '.claude', 'skills', 'example', 'notes.ipynb'))],
    ['a Write naming notebook_path', ws, edit('Write', agentFile(ws), 'notebook_path')],
    ['a Write naming path', ws, edit('Write', agentFile(ws), 'path')],
    ['an Edit naming path', ws, edit('Edit', skillFile(ws), 'path')],
    ['the agents folder itself', ws, edit('Write', path.join(ws, '.claude', 'agents'))],
    ['the skills folder itself', ws, edit('Write', path.join(ws, '.claude', 'skills'))],
    ...(SYMLINKS.skip ? [] : [
      ['the workspace opened through a link, the target spelled through it', link, edit('Write', path.join(link, '.claude', 'agents', 'x.md'))],
      ['the workspace opened through a link, the target spelled by its real path', link, edit('Write', agentFile(ws))],
      ['the workspace opened by its real path, the target spelled through a link', ws, edit('Edit', path.join(link, '.claude', 'skills', 'example', 'SKILL.md'))],
    ]),
  ];
}

describe('every spelling of a target in those folders is refused', () => {
  test('each spelling is refused by the check, in-process', () => {
    for (const ws of [wsCode, wsNotes]) {
      for (const [what, opened, request] of spellings(ws)) {
        for (const foldsCase of [true, false]) {
          assert.strictEqual(hook.isWorkspaceTeamFolderEdit(request.tool_name, request.tool_input, opened, foldsCase), true,
            `${what} (${path.basename(ws)}, foldsCase ${foldsCase})`);
        }
      }
    }
  });

  // THE FOLDING SEAM, BOTH WAYS. On a filesystem that folds case `Agents/` is
  // the agents folder, whether or not it exists yet; on one that does not, it
  // is a different folder, which the runtime never reads as the agents folder.
  test('a case variant is refused exactly where the host folds case, driven both ways through the seam', () => {
    const rows = [
      [wsBare, path.join(wsBare, '.claude', 'Agents', 'x.md'), true, true],
      [wsBare, path.join(wsBare, '.claude', 'SKILLS', 'new-skill', 'SKILL.md'), true, true],
      [wsCode, path.join(wsCode, '.claude', 'Agents', 'helper.md'), true, true],
      [wsBare, path.join(wsBare, '.claude', 'Agents', 'x.md'), false, false],
      [wsBare, path.join(wsBare, '.claude', 'SKILLS', 'new-skill', 'SKILL.md'), false, false],
    ];
    for (const [ws, target, foldsCase, refused] of rows) {
      assert.strictEqual(hook.isWorkspaceTeamFolderEdit('Write', { file_path: target }, ws, foldsCase), refused,
        `${path.relative(ws, target)}, foldsCase ${foldsCase}`);
    }
  });

  for (const [label, ws, who] of RUNS) {
    test(`each spelling is refused through the hook in ${label}`, async () => {
      for (const [what, opened, request] of spellings(ws)) {
        await assertRefused(envFor(opened, who), request, what);
      }
    });
  }
});

// What each of these was answered before this refusal existed, and still is.
function today(ws) {
  const writeTo = (...parts) => edit('Write', path.join(ws, ...parts));
  return [
    ['a Read of an agent file', { tool_name: 'Read', tool_input: { file_path: agentFile(ws) } }, 'allow', IN_WORKSPACE],
    ['a Glob of the agents folder', { tool_name: 'Glob', tool_input: { pattern: '*.md', path: path.join(ws, '.claude', 'agents') } }, 'allow', IN_WORKSPACE],
    ['a Grep of the skills folder', { tool_name: 'Grep', tool_input: { pattern: 'name', path: path.join(ws, '.claude', 'skills') } }, 'allow', IN_WORKSPACE],
    ['a Write to .claude/commands', writeTo('.claude', 'commands', 'x.md'), 'allow', IN_WORKSPACE],
    ['a Write to notes/agents', writeTo('notes', 'agents', 'x.md'), 'allow', IN_WORKSPACE],
    ['a Write to .claude/agents-old', writeTo('.claude', 'agents-old', 'x.md'), 'allow', IN_WORKSPACE],
    ['a Write to .claude/skillset', writeTo('.claude', 'skillset', 'x.md'), 'allow', IN_WORKSPACE],
    ['a Write to the runtime home\'s agents', edit('Write', path.join(home, '.claude', 'agents', 'x.md')), 'deny', /never the global ~\/\.claude copies/],
    ['an Edit of the runtime home\'s skills', edit('Edit', path.join(home, '.claude', 'skills', 'x', 'SKILL.md')), 'deny', /never the global ~\/\.claude copies/],
    ['a Write to the settings file the runtime starts with', writeTo('.claude', 'settings.local.json'), 'deny', /settings file the runtime was started with/],
    ['a Write to the runtime home\'s settings', edit('Write', path.join(home, '.claude', 'settings.json')), 'deny', /protects its own configuration folder/],
  ];
}

describe('everything beside those two folders keeps today\'s answer', () => {
  test('none of them is refused by the check, in-process', () => {
    for (const ws of [wsCode, wsNotes]) {
      for (const [what, request] of today(ws)) {
        for (const foldsCase of [true, false]) {
          assert.strictEqual(hook.isWorkspaceTeamFolderEdit(request.tool_name, request.tool_input, ws, foldsCase), false,
            `${what} (${path.basename(ws)}, foldsCase ${foldsCase})`);
        }
      }
    }
  });

  for (const [label, ws, who] of RUNS) {
    test(`each keeps today's answer through the hook in ${label}`, async () => {
      const env = envFor(ws, who);
      for (const [what, request, decision, reason] of today(ws)) {
        asked.length = 0;
        const r = await runHook(env, request);
        assert.strictEqual(r.decision, decision, `${what}: ${r.out}`);
        assert.match(r.reason, reason, `${what}: answered as before`);
        assert.strictEqual(asked.length, 0, `${what}: no card, as before`);
      }
    });
  }
});

describe('the real hook process, in a routine run\'s environment', () => {
  test('a routine run\'s Write of an agent file is denied', async () => {
    const token = auth.issueRunHookToken('team-folders-routine');
    const env = { ...config.inWorkspace(wsNotes, () => claudeRt.getSpawnEnv(null, token)), HOME: home, USERPROFILE: home };
    assert.strictEqual(env.RUNDOCK_CONVO_ID, undefined, 'a routine is started with no conversation');
    assert.strictEqual(env.RUNDOCK_HOOK_TOKEN, token, 'and with its run\'s own token');
    asked.length = 0;
    const r = await runHook(env, edit('Write', agentFile(wsNotes)));
    assert.strictEqual(r.status, 0, r.err);
    assert.strictEqual(r.decision, 'deny', r.out);
    assert.match(r.reason, REFUSED);
    assert.strictEqual(asked.length, 0, 'refused by the hook, with no card');
  });
});

// THE STEPS AROUND A REFUSAL: what an agent does just before it, just after
// it, and instead of it.
describe('the steps around a refusal', () => {
  for (const [label, ws, who] of RUNS) {
    test(`the inverse action: a Read of an agent file is allowed, and the Edit that follows it refused, in ${label}`, async () => {
      const env = envFor(ws, who);
      asked.length = 0;
      const read = await runHook(env, { tool_name: 'Read', tool_input: { file_path: agentFile(ws) } });
      assert.strictEqual(read.decision, 'allow', read.out);
      assert.match(read.reason, IN_WORKSPACE);
      await assertRefused(env, edit('Edit', agentFile(ws)), 'the Edit after the Read');
    });

    test(`the undo: after the refused Edit, a Write to notes/a.md is allowed, in ${label}`, async () => {
      const env = envFor(ws, who);
      await assertRefused(env, edit('Edit', agentFile(ws)), 'the Edit');
      asked.length = 0;
      const next = await runHook(env, edit('Write', path.join(ws, 'notes', 'a.md')));
      assert.strictEqual(next.decision, 'allow', next.out);
      assert.match(next.reason, IN_WORKSPACE);
      assert.strictEqual(asked.length, 0, 'an ordinary write in the workspace, with no card');
    });
  }

  // A workspace whose answers would allow the write if anything asked them:
  // a saved "Always allow" for every file tool, folder grants covering the
  // two folders, and the agents folder named as a working folder. The server
  // standing in for Rundock allows everything as well. The refusal comes
  // before all of them, so the same write is refused however often it is sent.
  const granted = (mode) => {
    const ws = path.join(root, `ws-granted-${mode}`);
    makeWorkspace(ws, mode);
    const agents = path.join(ws, '.claude', 'agents');
    fs.writeFileSync(path.join(ws, '.rundock', 'permissions.json'), `${JSON.stringify({
      allowedDirs: [agents, path.join(ws, '.claude', 'skills'), path.join(ws, '.claude')],
      allowedTools: EDIT_TOOLS,
    })}\n`);
    fs.writeFileSync(path.join(ws, '.rundock', 'state.json'), `${JSON.stringify({ workspaceMode: mode, workingFolders: [agents] })}\n`);
    return ws;
  };
  for (const [label, mode, who] of [
    ['Code mode, a conversation', 'code', 'conversation'],
    ['Notes mode, a conversation', 'notes', 'conversation'],
    ['Code mode, a routine run', 'code', 'routine'],
    ['Notes mode, a routine run', 'notes', 'routine'],
  ]) {
    test(`the retry: the same refused Write sent twice is refused twice, with no saved answer or folder grant consulted, in ${label}`, async () => {
      const ws = granted(mode);
      const env = envFor(ws, who);
      assert.ok(env.RUNDOCK_EXTRA_DIRS.split(path.delimiter).includes(path.join(ws, '.claude', 'agents')),
        'sanity: the agents folder is named as a working folder');
      for (const attempt of ['first', 'second']) {
        await assertRefused(env, edit('Write', agentFile(ws)), `the ${attempt} Write`);
      }
    });
  }

  // Rundock's settings do not route the Agent tool through this hook at all
  // (the PreToolUse matchers name the file tools, the shell tools and
  // connector actions), so the hand-over never meets it in the app. Asked
  // here anyway, before and after the refusal, so the refusal is shown to
  // leave its answer exactly as it was: Code mode allows it with no card,
  // and Notes mode asks Rundock as for any other tool, whose answer here is
  // an Allow.
  const handOver = {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'rundock-guide', description: 'Update the helper agent', prompt: 'Change the helper agent\'s description to say it drafts replies.' },
  };
  for (const [label, ws, cards] of [['Code mode', wsCode, 0], ['Notes mode', wsNotes, 1]]) {
    test(`the most common next step: after the refusal, handing the change to Doc is allowed, in ${label}, a conversation`, async () => {
      const env = envFor(ws, 'conversation');
      asked.length = 0;
      const before = await runHook(env, handOver);
      assert.strictEqual(asked.length, cards, 'sanity: how this mode answers an Agent call');
      await assertRefused(env, edit('Write', agentFile(ws)), 'the Write');
      asked.length = 0;
      const after = await runHook(env, handOver);
      assert.strictEqual(after.decision, 'allow', after.out);
      assert.doesNotMatch(after.reason, REFUSED);
      assert.deepStrictEqual([after.decision, after.reason, asked.length], [before.decision, before.reason, cards],
        'answered as it was before the refusal');
    });
  }
});

// WHAT THE AGENT IS TOLD, word for word. It says who changes agents and
// skills here and what to do instead, and never that the write was outside
// the workspace, which it was not. A routine is told to say so in its final
// message, in the words every refusal gives a routine (scripts/refusal-notice.js).
// UK spelling, because a person may read it (CONTRIBUTING.md).
const { UNATTENDED_NEXT } = require('../../scripts/refusal-notice.js');
const OPENS = 'Agents and skills in this workspace are changed only by Doc (rundock-guide), Rundock\'s built-in agent, so this write into the workspace\'s .claude/agents or .claude/skills folder was refused. The refusal is deliberate: do not retry it or try another way.';
const SAID = {
  conversation: `${OPENS} Hand the change to Doc, or ask the person to make it.`,
  routine: `${OPENS} Say in your final message what you wanted to change. ${UNATTENDED_NEXT}`,
};
const US_SPELLINGS = /iz(?:e|es|ed|ing|ation)\b|yz(?:e|es|ed|ing)\b|\b(?:color|behavior|favor|honor|center|catalog|canceled|traveled|license)\b/i;

describe('what the refusal tells the agent', () => {
  for (const [label, ws, who] of RUNS) {
    test(`the words, in ${label}`, async () => {
      const r = await runHook(envFor(ws, who), edit('Write', agentFile(ws)));
      assert.strictEqual(r.decision, 'deny', r.out);
      assert.match(r.reason, /changed only by Doc/, 'who changes agents and skills here');
      if (who === 'routine') {
        assert.match(r.reason, /Say in your final message what you wanted to change/, 'what a routine does instead');
        assert.doesNotMatch(r.reason, /ask the person/, 'a routine has nobody to ask');
      } else {
        assert.match(r.reason, /Hand the change to Doc, or ask the person to make it/, 'what a conversation does instead');
      }
      assert.doesNotMatch(r.reason, /outside/i, 'the write was inside the workspace, and is never said to be outside it');
      assert.doesNotMatch(r.reason, US_SPELLINGS, 'UK spelling');
      assert.strictEqual(r.reason, SAID[who], 'word for word');
    });
  }
});
