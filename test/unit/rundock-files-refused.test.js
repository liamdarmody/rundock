'use strict';
// AN AGENT'S FILE-TOOL WRITE TO RUNDOCK'S OWN TWO FILES IS REFUSED BY THE HOOK,
// WITH NO CARD, IN EVERY RUN.
//
// .rundock/permissions.json and .rundock/state.json hold what the person
// decided for the workspace: the standing "Always allow" answers, the granted
// folders, the Working folders and the mode. Rundock writes them itself,
// in-process, and no agent needs to. A card for an agent's file-tool write to
// either one read like an ordinary file edit, and an Allow on it kept whatever
// the agent wrote, "allowedTools":["Bash"] included, as a standing permission.
// So the hook refuses a Write, Edit, MultiEdit or NotebookEdit of either file
// before any saved answer, folder grant, mode or card: in Code mode and Notes
// mode, in a conversation and in a routine. A shell command that writes either
// file keeps its card.
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
const boundary = require('../../lib/workspace/boundary.js');
const workingFolders = require('../../lib/workspace/working-folders.js');

const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const SYMLINKS = { skip: process.platform === 'win32' && 'a link needs privileges on Windows' };

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-files-')));
const home = path.join(root, 'home');
const wsCode = path.join(root, 'ws-code');
const wsNotes = path.join(root, 'ws-notes');
// A workspace holding no .rundock folder at all, so a case variant of either
// file cannot be resolved by the filesystem before the comparison sees it, on
// any host.
const wsBare = path.join(root, 'ws-bare');
// Each workspace reached through a link, and a twin of it whose .rundock folder
// holds no permissions.json yet.
const linkOf = (ws) => `${ws}-link`;
const freshOf = (ws) => `${ws}-fresh`;
// Another Rundock workspace beside these, whose answer files are its own.
const wsOther = path.join(root, 'ws-other');

const permissionsFile = (ws) => path.join(ws, '.rundock', 'permissions.json');
const stateFile = (ws) => path.join(ws, '.rundock', 'state.json');
const noteFile = (ws) => path.join(ws, 'notes', 'a.md');

function makeWorkspace(ws, mode) {
  fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
  fs.writeFileSync(stateFile(ws), `${JSON.stringify({ workspaceMode: mode })}\n`);
  fs.writeFileSync(permissionsFile(ws), '{"allowedDirs":[],"allowedTools":[]}\n');
  fs.writeFileSync(path.join(ws, '.rundock', 'mcp-secrets.json'), '{}\n');
  fs.writeFileSync(path.join(ws, '.rundock', 'permission-hook.sh'), '#!/bin/sh\nexec node hook.js "$@"\n');
  fs.writeFileSync(path.join(ws, '.mcp.json'), '{}\n');
  fs.mkdirSync(path.join(ws, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.claude', 'settings.json'), '{}\n');
  fs.writeFileSync(path.join(ws, '.claude', 'settings.local.json'), '{}\n');
  fs.writeFileSync(path.join(ws, '.claude', 'agents', 'example-agent.md'), '---\nname: example-agent\n---\nOriginal body.\n');
  fs.mkdirSync(path.join(ws, 'notes'), { recursive: true });
  fs.writeFileSync(noteFile(ws), 'Original body.\n');
}
for (const [ws, mode] of [[wsCode, 'code'], [wsNotes, 'notes']]) {
  makeWorkspace(ws, mode);
  fs.mkdirSync(path.join(freshOf(ws), '.rundock'), { recursive: true });
  fs.writeFileSync(stateFile(freshOf(ws)), `${JSON.stringify({ workspaceMode: mode })}\n`);
  if (!SYMLINKS.skip) {
    fs.symlinkSync(ws, linkOf(ws), 'dir');
    fs.symlinkSync(permissionsFile(ws), path.join(ws, 'notes', 'p.json'), 'file');
    fs.symlinkSync(path.join(ws, '.rundock'), path.join(ws, 'notes', 'r'), 'dir');
  }
}
makeWorkspace(wsOther, 'notes');
fs.mkdirSync(wsBare, { recursive: true });
fs.mkdirSync(home, { recursive: true });

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

// A file-tool call naming `target` in the field its tool uses, or in `field`.
function edit(tool, target, field) {
  const key = field || (tool === 'NotebookEdit' ? 'notebook_path' : 'file_path');
  const rest = {
    Write: { content: '{"allowedTools":["Bash"]}\n' },
    Edit: { old_string: '"allowedTools":[]', new_string: '"allowedTools":["Bash"]' },
    MultiEdit: { edits: [{ old_string: '"allowedTools":[]', new_string: '"allowedTools":["Bash"]' }] },
    NotebookEdit: { new_source: '{"allowedTools":["Bash"]}', cell_type: 'code', edit_mode: 'replace' },
  }[tool];
  return { tool_name: tool, tool_input: { [key]: target, ...rest } };
}
const also = (request, extra) => ({ ...request, tool_input: { ...request.tool_input, ...extra } });

// The check, asked in-process. Every test reaches it through here, so a hook
// without it fails on this assertion rather than on a missing function.
function check(request, ws, foldsCase) {
  assert.strictEqual(typeof hook.isRundockAnswerFileEdit, 'function', 'the hook exports isRundockAnswerFileEdit');
  return hook.isRundockAnswerFileEdit(request.tool_name, request.tool_input, ws, foldsCase);
}

// Every way to spell either file, from the workspace `ws` is opened as.
const sep = path.sep;
function spellings(ws) {
  const link = linkOf(ws);
  const fresh = freshOf(ws);
  return [
    ['an absolute path to permissions.json', ws, edit('Write', permissionsFile(ws))],
    ['an absolute path to state.json', ws, edit('Write', stateFile(ws))],
    ['a relative path to permissions.json', ws, edit('Write', path.join('.rundock', 'permissions.json'))],
    ['a relative path to state.json', ws, edit('Edit', path.join('.rundock', 'state.json'))],
    ['./.rundock/permissions.json', ws, edit('Write', `.${sep}${path.join('.rundock', 'permissions.json')}`)],
    ['.rundock/../.rundock/state.json', ws, edit('Write', ['.rundock', '..', '.rundock', 'state.json'].join(sep))],
    ['notes/../.rundock/permissions.json, relative', ws, edit('Edit', ['notes', '..', '.rundock', 'permissions.json'].join(sep))],
    ['notes/../.rundock/permissions.json, absolute', ws, edit('Write', [ws, 'notes', '..', '.rundock', 'permissions.json'].join(sep))],
    ['a permissions.json that does not exist yet', fresh, edit('Write', permissionsFile(fresh))],
    ['a Write naming permissions.json in notebook_path', ws, edit('Write', permissionsFile(ws), 'notebook_path')],
    ['a Write naming state.json in path', ws, edit('Write', stateFile(ws), 'path')],
    ['an Edit naming state.json in notebook_path', ws, edit('Edit', stateFile(ws), 'notebook_path')],
    ['an Edit naming permissions.json in path', ws, edit('Edit', permissionsFile(ws), 'path')],
    ...(SYMLINKS.skip ? [] : [
      ['the workspace opened through a link, the target spelled through it', link, edit('Write', permissionsFile(link))],
      ['the workspace opened through a link, the target spelled by its real path', link, edit('Write', stateFile(ws))],
      ['the workspace opened by its real path, the target spelled through a link', ws, edit('Edit', permissionsFile(link))],
      ['a link inside the workspace to permissions.json', ws, edit('Write', path.join(ws, 'notes', 'p.json'))],
      ['a link inside the workspace to the .rundock folder', ws, edit('Write', path.join(ws, 'notes', 'r', 'state.json'))],
    ]),
  ];
}

// A CALL WHOSE PATH FIELDS DISAGREE. The runtime writes the field its tool
// names, and the boundary classifier reads that same field, so a check that
// read only the first field present could look at an ordinary note while the
// tool wrote one of these files. Every string path field is checked, so either
// file is refused whichever field names it and whatever the others say.
function conflicting(ws) {
  const note = noteFile(ws);
  return [
    ['a NotebookEdit naming a note in file_path and permissions.json in notebook_path', also(edit('NotebookEdit', permissionsFile(ws)), { file_path: note })],
    ['a NotebookEdit naming a note in notebook_path and state.json in path', also(edit('NotebookEdit', note), { path: stateFile(ws) })],
    ['a NotebookEdit naming permissions.json in file_path and a note in notebook_path', also(edit('NotebookEdit', note), { file_path: permissionsFile(ws) })],
    ['a NotebookEdit naming state.json in file_path and a number in notebook_path', also(edit('NotebookEdit', 7), { file_path: stateFile(ws) })],
    ['a Write naming a note in file_path and permissions.json in notebook_path', also(edit('Write', note), { notebook_path: permissionsFile(ws) })],
    ['a Write naming a note in file_path and state.json in path', also(edit('Write', note), { path: stateFile(ws) })],
    ['a Write naming permissions.json in file_path and a number in path', also(edit('Write', permissionsFile(ws)), { path: 7 })],
    ['an Edit naming a note in file_path and permissions.json in path', also(edit('Edit', note), { path: permissionsFile(ws) })],
    ['an Edit naming state.json in file_path and a note in notebook_path', also(edit('Edit', stateFile(ws)), { notebook_path: note })],
    ['a MultiEdit naming a note in file_path and state.json in path', also(edit('MultiEdit', note), { path: stateFile(ws) })],
    ['a MultiEdit naming permissions.json in file_path and a number in notebook_path', also(edit('MultiEdit', permissionsFile(ws)), { notebook_path: 7 })],
  ];
}

// The names beside the boundary: not these two files, so not this refusal.
function beside(ws) {
  const writeTo = (...parts) => edit('Write', path.join(ws, ...parts));
  return [
    ['.rundock/permissions.json.bak', writeTo('.rundock', 'permissions.json.bak')],
    ['.rundock/state.json.tmp', writeTo('.rundock', 'state.json.tmp')],
    ['.rundock/permissions', writeTo('.rundock', 'permissions')],
    ['notes/.rundock/permissions.json', writeTo('notes', '.rundock', 'permissions.json')],
    ["another workspace's .rundock/permissions.json", edit('Write', permissionsFile(wsOther))],
  ];
}

// The rest of the workspace's answer files, and the reads of these two.
function others(ws) {
  return [
    ['a Read of permissions.json', { tool_name: 'Read', tool_input: { file_path: permissionsFile(ws) } }],
    ['a Read of state.json', { tool_name: 'Read', tool_input: { file_path: stateFile(ws) } }],
    ['a Glob of the .rundock folder', { tool_name: 'Glob', tool_input: { pattern: '*.json', path: path.join(ws, '.rundock') } }],
    ['a Grep of state.json', { tool_name: 'Grep', tool_input: { pattern: 'workspaceMode', path: stateFile(ws) } }],
    ['a Write to .mcp.json', edit('Write', path.join(ws, '.mcp.json'))],
    ['a Write to .claude/settings.json', edit('Write', path.join(ws, '.claude', 'settings.json'))],
    ['a Write to .rundock/mcp-secrets.json', edit('Write', path.join(ws, '.rundock', 'mcp-secrets.json'))],
    ['a Write to .claude/settings.local.json', edit('Write', path.join(ws, '.claude', 'settings.local.json'))],
    ['a Write to the launcher', edit('Write', path.join(ws, '.rundock', 'permission-hook.sh'))],
    ['a Write to an agent file', edit('Write', path.join(ws, '.claude', 'agents', 'example-agent.md'))],
    ['a Write to notes/a.md', edit('Write', noteFile(ws))],
  ];
}

describe('the check, in-process', () => {
  test('each file tool on each of the two files is matched', () => {
    for (const ws of [wsCode, wsNotes]) {
      for (const tool of EDIT_TOOLS) {
        for (const target of [permissionsFile(ws), stateFile(ws)]) {
          for (const foldsCase of [true, false]) {
            assert.strictEqual(check(edit(tool, target), ws, foldsCase), true,
              `${tool} ${path.relative(ws, target)} (${path.basename(ws)}, foldsCase ${foldsCase})`);
          }
        }
      }
    }
  });

  test('every spelling of either file is matched', () => {
    for (const ws of [wsCode, wsNotes]) {
      for (const [what, opened, request] of spellings(ws)) {
        for (const foldsCase of [true, false]) {
          assert.strictEqual(check(request, opened, foldsCase), true, `${what} (${path.basename(ws)}, foldsCase ${foldsCase})`);
        }
      }
    }
  });

  test('either file named in any path field is matched, whatever the other fields say', () => {
    for (const ws of [wsCode, wsNotes]) {
      for (const [what, request] of conflicting(ws)) {
        for (const foldsCase of [true, false]) {
          assert.strictEqual(check(request, ws, foldsCase), true, `${what} (${path.basename(ws)}, foldsCase ${foldsCase})`);
        }
      }
    }
  });

  // THE FOLDING SEAM, BOTH WAYS. On a filesystem that folds case,
  // `.rundock/PERMISSIONS.json` is the permissions file, whether or not it
  // exists yet; on one that does not, it is a different file Rundock never
  // reads. The bare workspace holds neither file, so the filesystem cannot
  // correct the case before the comparison sees it.
  test('a case variant is matched exactly where case folds, driven both ways through the seam', () => {
    const rows = [
      [path.join(wsBare, '.rundock', 'PERMISSIONS.json'), true, true],
      [path.join(wsBare, '.RUNDOCK', 'state.json'), true, true],
      [path.join(wsBare, '.rundock', 'PERMISSIONS.json'), false, false],
      [path.join(wsBare, '.RUNDOCK', 'state.json'), false, false],
      [path.join(wsBare, '.rundock', 'permissions.json'), true, true],
      [path.join(wsBare, '.rundock', 'state.json'), false, true],
    ];
    for (const [target, foldsCase, matched] of rows) {
      assert.strictEqual(check(edit('Write', target), wsBare, foldsCase), matched, `${path.relative(wsBare, target)}, foldsCase ${foldsCase}`);
    }
    assert.strictEqual(typeof hook.hostFoldsCase, 'function', 'the hook exports hostFoldsCase');
    assert.strictEqual(check(edit('Write', path.join(wsBare, '.rundock', 'PERMISSIONS.json')), wsBare), hook.hostFoldsCase(),
      'with no seam given, the host decides');
  });

  test('the names beside the two files, and every other file, are not matched', async (t) => {
    for (const ws of [wsCode, wsNotes]) {
      for (const [what, request] of [...beside(ws), ...others(ws)]) {
        await t.test(`${what} (${path.basename(ws)})`, () => {
          for (const foldsCase of [true, false]) {
            assert.strictEqual(check(request, ws, foldsCase), false, `${what} (${path.basename(ws)}, foldsCase ${foldsCase})`);
          }
        });
      }
    }
  });

  test('a call with no string path, or no input, is not matched', () => {
    for (const input of [undefined, null, {}, { file_path: '' }, { file_path: 7 }, { content: 'x' }]) {
      assert.strictEqual(check({ tool_name: 'Write', tool_input: input }, wsCode), false, JSON.stringify(input));
    }
  });

  test('the check reaches its seam once for each string target it compares', () => {
    assert.strictEqual(typeof (hook.rundockAnswerFileSeam && hook.rundockAnswerFileSeam.beforeChecking), 'function', 'the seam is a module attribute');
    const seen = [];
    const was = hook.rundockAnswerFileSeam.beforeChecking;
    hook.rundockAnswerFileSeam.beforeChecking = (target) => { seen.push(target); };
    try {
      check({ tool_name: 'Read', tool_input: { file_path: permissionsFile(wsNotes) } }, wsNotes);
      check({ tool_name: 'Write', tool_input: {} }, wsNotes);
      check({ tool_name: 'Write', tool_input: { file_path: noteFile(wsNotes), notebook_path: 7, path: stateFile(wsNotes) } }, wsNotes);
    } finally {
      hook.rundockAnswerFileSeam.beforeChecking = was;
    }
    assert.deepStrictEqual(seen, [noteFile(wsNotes), stateFile(wsNotes)]);
  });
});

// THROUGH THE REAL HOOK.

// The environment Rundock starts an agent with in `ws`: a conversation's,
// with its id and token, or a routine run's, with no conversation and the
// run's own token. The mode comes from the workspace's state, as it does in
// the app. The home folder is a fixture, never the account's own.
let runs = 0;
function envFor(ws, who) {
  const env = config.inWorkspace(ws, () => (who === 'routine'
    ? claudeRt.getSpawnEnv(null, auth.issueRunHookToken(`rundock-files-run-${++runs}`))
    : claudeRt.getSpawnEnv('rundock-files-conversation', 'default')));
  return { ...env, HOME: home, USERPROFILE: home, NODE_V8_COVERAGE: '' };
}
const whoFor = (env) => (env.RUNDOCK_CONVO_ID ? 'conversation' : 'routine');

// The real hook, as its own process, from the workspace folder, the way the
// runtime starts it. A hook still running after HOOK_ANSWER_MS is ended, and
// its answer is then whatever it printed, which is nothing. `stdin` replaces
// the request the hook is handed, for input it cannot read.
const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const HOOK_ANSWER_MS = 15000;
function runHook(env, request, { preload, stdin } = {}) {
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
    child.stdin.end(stdin !== undefined ? stdin : JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd, ...request }));
  });
}

// Code mode and Notes mode, each in a conversation and in a routine run.
const RUNS = [
  ['Code mode, a conversation', wsCode, 'conversation'],
  ['Notes mode, a conversation', wsNotes, 'conversation'],
  ['Code mode, a routine run', wsCode, 'routine'],
  ['Notes mode, a routine run', wsNotes, 'routine'],
];

// WHAT THE AGENT IS TOLD, word for word. It says what these files are and that
// the refusal is deliberate, and sends the change to the person, who makes it
// in Rundock. A routine, which has nobody to ask, is told to say so in its
// final message, in the words every refusal gives a routine. UK spelling,
// because a person may read it (CONTRIBUTING.md).
const OPENS = "This is one of Rundock's own files: it holds this workspace's settings and the person's permission answers, which an agent never changes, so this write was refused. The refusal is deliberate: do not retry it or try another way.";
const SAID = {
  conversation: `${OPENS} Tell the person what you wanted to change, so they can make it in Rundock.`,
  routine: `${OPENS} Say in your final message what you wanted to change. ${hook.UNATTENDED_NEXT_UNLOADED}`,
};
const US_SPELLINGS = /iz(?:e|es|ed|ing|ation)\b|yz(?:e|es|ed|ing)\b|\b(?:color|behavior|favor|honor|center|catalog|canceled|traveled|license)\b/i;
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
const OWN_FILE = /one of Rundock's own files/;
const IN_WORKSPACE = /^In-workspace file access$/;
const COULD_NOT_CHECK = 'Rundock could not check this request, so it was refused rather than approved on your behalf.';
const UNANSWERED_ANSWER_FILE = 'This file records your own permission answers or decides what runs, and it is never changed without asking, so it was refused rather than approved on your behalf.';
// A port nothing listens on, so the server cannot be asked.
const CLOSED_PORT = '1';

const bytesOf = (file) => (fs.existsSync(file) ? fs.readFileSync(file) : null);
const shell = (command) => ({ tool_name: 'Bash', tool_input: { command } });

// Refused as one of Rundock's own files, with no card, and each of `files`
// byte for byte as it was.
async function assertRefused(env, request, what, files = []) {
  const was = files.map(bytesOf);
  asked.length = 0;
  const r = await runHook(env, request);
  assert.strictEqual(r.status, 0, `${what}: the hook answered (${r.err})`);
  assert.strictEqual(r.decision, 'deny', `${what}: ${r.out}`);
  assert.strictEqual(r.reason, SAID[whoFor(env)], `${what}: refused as one of Rundock's own files`);
  assert.strictEqual(asked.length, 0, `${what}: refused by the hook, with no card`);
  files.forEach((file, i) => assert.deepStrictEqual(bytesOf(file), was[i], `${what}: ${path.basename(file)} is unchanged`));
  return r;
}

// The card a file tool's write to an answer file raises, and the one a shell
// command's raises.
const answerFileCard = (req) => Boolean(req && req.answer_file === true);
const answerFileCrossing = (req) => Boolean(req && req.boundary === true && Array.isArray(req.crossings) && req.crossings.some((c) => c && c.answerFile));

describe('a Write, Edit, MultiEdit or NotebookEdit of either file is refused through the hook, with no card', () => {
  for (const [label, ws, who] of RUNS) {
    test(`each file tool on each file is refused, and the file is unchanged, in ${label}`, async () => {
      const env = envFor(ws, who);
      assert.strictEqual(env.RUNDOCK_CODE_MODE === '1', ws === wsCode, 'sanity: the mode is the workspace\'s');
      assert.strictEqual(!env.RUNDOCK_CONVO_ID, who === 'routine', 'sanity: a routine has no conversation');
      for (const tool of EDIT_TOOLS) {
        for (const target of [permissionsFile(ws), stateFile(ws)]) {
          await assertRefused(env, edit(tool, target), `${tool} ${path.relative(ws, target)}`, [target]);
        }
      }
    });
  }

  for (const [label, ws, who] of RUNS) {
    test(`an Edit adding "allowedTools":["Bash"] to permissions.json is refused, and no tool is allowed by it, in ${label}`, async () => {
      const request = edit('Edit', permissionsFile(ws));
      assert.ok(fs.readFileSync(permissionsFile(ws), 'utf-8').includes(request.tool_input.old_string), 'sanity: the Edit would apply');
      await assertRefused(envFor(ws, who), request, 'the Edit', [permissionsFile(ws)]);
      assert.deepStrictEqual(config.inWorkspace(ws, () => boundary.readToolAllows()), [], 'no standing allow');
    });
  }
});

describe('every spelling of either file is refused through the hook', () => {
  for (const [label, ws, who] of RUNS) {
    test(`each spelling is refused in ${label}`, async (t) => {
      const files = [permissionsFile(ws), stateFile(ws), permissionsFile(freshOf(ws))];
      for (const [what, opened, request] of spellings(ws)) {
        await t.test(what, () => assertRefused(envFor(opened, who), request, what, files));
      }
      assert.strictEqual(fs.existsSync(permissionsFile(freshOf(ws))), false, 'the permissions.json that did not exist still does not');
    });
  }

  for (const [label, ws, who] of RUNS) {
    test(`either file named in any path field is refused, whatever the other fields say, in ${label}`, async (t) => {
      const env = envFor(ws, who);
      for (const [what, request] of conflicting(ws)) {
        await t.test(what, () => assertRefused(env, request, what, [permissionsFile(ws), stateFile(ws)]));
      }
    });
  }

  // Through the hook the host decides, as it does in the app: where case
  // folds, `.rundock/PERMISSIONS.json` is the permissions file. The host's
  // answer is read from the hook once it is known to export it, so a hook
  // without it fails on that assertion rather than on a missing function.
  for (const [label, ws, who] of RUNS) {
    test(`a case variant is refused exactly where the host folds case, in ${label}`, async () => {
      assert.strictEqual(typeof hook.hostFoldsCase, 'function', 'the hook exports hostFoldsCase');
      const folds = hook.hostFoldsCase();
      const env = envFor(ws, who);
      for (const target of [path.join(ws, '.rundock', 'PERMISSIONS.json'), path.join(ws, '.RUNDOCK', 'state.json')]) {
        asked.length = 0;
        const r = await runHook(env, edit('Write', target));
        assert.strictEqual(r.status, 0, r.err);
        assert.strictEqual(r.reason === SAID[who], folds, `${path.relative(ws, target)}: refused as one of Rundock's own files exactly where case folds (${r.reason})`);
        if (folds) assert.strictEqual(asked.length, 0, 'with no card');
      }
    });
  }

  for (const [label, ws, who] of RUNS) {
    test(`the names beside the two files are not this refusal, in ${label}`, async (t) => {
      const env = envFor(ws, who);
      for (const [what, request] of beside(ws)) {
        await t.test(what, async () => {
          asked.length = 0;
          const r = await runHook(env, request);
          assert.strictEqual(r.status, 0, r.err);
          assert.ok(r.decision, `${what}: answered (${r.out})`);
          assert.doesNotMatch(r.reason, OWN_FILE, `${what}: not refused as one of Rundock's own files`);
        });
      }
      asked.length = 0;
      await runHook(env, edit('Write', permissionsFile(wsOther)));
      assert.strictEqual(asked.length, 1, "another workspace's permissions.json is still carded");
      assert.ok(answerFileCrossing(asked[0]), "as that workspace's answer file");
    });
  }
});

// What each of these was answered before this refusal existed, and still is:
// the reads of these two files, the rest of the workspace's answer files and
// the refusals beside this one, a shell command writing either file, and an
// ordinary note.
function unchanged(ws) {
  const writeTo = (...parts) => edit('Write', path.join(ws, ...parts));
  const allowed = { decision: 'allow', reason: IN_WORKSPACE, card: null };
  const carded = { decision: 'allow', card: answerFileCard };
  const crossing = { decision: 'allow', card: answerFileCrossing };
  const refused = (reason) => ({ decision: 'deny', reason, card: null });
  return [
    ['a Read of permissions.json', { tool_name: 'Read', tool_input: { file_path: permissionsFile(ws) } }, allowed],
    ['a Read of state.json', { tool_name: 'Read', tool_input: { file_path: stateFile(ws) } }, allowed],
    ['a Glob of the .rundock folder', { tool_name: 'Glob', tool_input: { pattern: '*.json', path: path.join(ws, '.rundock') } }, allowed],
    ['a Grep of state.json', { tool_name: 'Grep', tool_input: { pattern: 'workspaceMode', path: stateFile(ws) } }, allowed],
    ['a Write to .mcp.json', writeTo('.mcp.json'), carded],
    ['a Write to .claude/settings.json', writeTo('.claude', 'settings.json'), carded],
    ['a Write to .rundock/mcp-secrets.json', writeTo('.rundock', 'mcp-secrets.json'), carded],
    ['a Write to .claude/settings.local.json', writeTo('.claude', 'settings.local.json'), refused(/settings file the runtime was started with/)],
    ['a Write to the launcher', writeTo('.rundock', 'permission-hook.sh'), refused(/starts its permission checks/)],
    ['a Write to an agent file', writeTo('.claude', 'agents', 'example-agent.md'), refused(/^Agents and skills in this workspace are changed only by Doc/)],
    ['a shell command writing permissions.json', shell('echo {} > .rundock/permissions.json'), crossing],
    ['a shell command writing state.json', shell('echo {} > .rundock/state.json'), crossing],
    ['a Write to notes/a.md', writeTo('notes', 'a.md'), allowed],
  ];
}

describe('everything beside a file tool\'s write to the two files keeps today\'s answer', () => {
  for (const [label, ws, who] of RUNS) {
    test(`each keeps today's answer through the hook in ${label}`, async (t) => {
      const env = envFor(ws, who);
      for (const [what, request, expected] of unchanged(ws)) {
        await t.test(what, async () => {
          asked.length = 0;
          const r = await runHook(env, request);
          assert.strictEqual(r.status, 0, r.err);
          assert.strictEqual(r.decision, expected.decision, `${what}: ${r.out}`);
          if (expected.reason) assert.match(r.reason, expected.reason, `${what}: answered as before`);
          assert.doesNotMatch(r.reason, OWN_FILE, `${what}: not refused as one of Rundock's own files`);
          if (expected.card) {
            assert.strictEqual(asked.length, 1, `${what}: a card, as before`);
            assert.ok(expected.card(asked[0]), `${what}: the same card as before (${JSON.stringify(asked[0])})`);
          } else {
            assert.strictEqual(asked.length, 0, `${what}: no card, as before`);
          }
        });
      }
    });
  }
});

describe('what the refusal tells the agent', () => {
  for (const [label, ws, who] of RUNS) {
    test(`the words, in ${label}`, async () => {
      const r = await runHook(envFor(ws, who), edit('Write', permissionsFile(ws)));
      assert.strictEqual(r.decision, 'deny', r.out);
      assert.strictEqual(r.reason, SAID[who], 'word for word');
    });
  }

  test('neither string uses a US spelling, says the write was outside the workspace, or holds a dash', () => {
    for (const [who, said] of Object.entries(SAID)) {
      assert.doesNotMatch(said, US_SPELLINGS, `${who}: UK spelling`);
      assert.doesNotMatch(said, /outside/i, `${who}: the write was inside the workspace, and is never said to be outside it`);
      assert.doesNotMatch(said, DASHES, `${who}: no em or en dash`);
    }
    assert.strictEqual(typeof hook.UNATTENDED_NEXT_UNLOADED, 'string', 'the words every refusal gives a routine are exported');
    assert.ok(SAID.routine.endsWith(hook.UNATTENDED_NEXT_UNLOADED), 'a routine ends on the words every refusal gives a routine');
  });
});

// THE STEPS AROUND A REFUSAL: what an agent does just before it, just after
// it, and instead of it.
describe('the steps around a refusal', () => {
  for (const [label, ws, who] of RUNS) {
    test(`the inverse: a Read of either file is allowed, the Edit that follows it refused, and the other answer files still carded, in ${label}`, async () => {
      const env = envFor(ws, who);
      for (const target of [permissionsFile(ws), stateFile(ws)]) {
        asked.length = 0;
        const read = await runHook(env, { tool_name: 'Read', tool_input: { file_path: target } });
        assert.strictEqual(read.decision, 'allow', read.out);
        assert.match(read.reason, IN_WORKSPACE);
        assert.strictEqual(asked.length, 0, 'a read, with no card');
        await assertRefused(env, edit('Edit', target), `the Edit of ${path.basename(target)} after the Read`, [target]);
      }
      for (const rel of [['.mcp.json'], ['.claude', 'settings.json']]) {
        asked.length = 0;
        const r = await runHook(env, edit('Write', path.join(ws, ...rel)));
        assert.strictEqual(r.decision, 'allow', r.out);
        assert.strictEqual(asked.length, 1, `${rel.join('/')}: still carded`);
        assert.ok(answerFileCard(asked[0]), `${rel.join('/')}: as an answer file`);
      }
    });
  }

  // Nothing was written, so there is nothing for the agent to undo. The person
  // revokes an "Always allow" and changes a Working folder in Settings, and
  // Rundock writes both files itself, in-process, as before.
  for (const [label, mode, who] of [
    ['Code mode, a conversation', 'code', 'conversation'],
    ['Notes mode, a conversation', 'notes', 'conversation'],
    ['Code mode, a routine run', 'code', 'routine'],
    ['Notes mode, a routine run', 'notes', 'routine'],
  ]) {
    test(`the undo: Rundock still writes both files itself, and the next ordinary write keeps its answer, in ${label}`, async () => {
      const ws = path.join(root, `ws-undo-${mode}-${who}`);
      makeWorkspace(ws, mode);
      fs.writeFileSync(permissionsFile(ws), '{"allowedDirs":[],"allowedTools":["Read"]}\n');
      const elsewhere = path.join(root, `elsewhere-${mode}-${who}`);
      fs.mkdirSync(elsewhere, { recursive: true });
      await assertRefused(envFor(ws, who), edit('Write', permissionsFile(ws)), 'the Write', [permissionsFile(ws), stateFile(ws)]);
      const settled = config.inWorkspace(ws, () => {
        boundary.removeToolAllow('Read');
        workingFolders.writeWorkingFolders([elsewhere]);
        return { allows: boundary.readToolAllows(), folders: workingFolders.readWorkingFolders() };
      });
      assert.deepStrictEqual(settled.allows, [], 'the revoke is written by Rundock');
      assert.deepStrictEqual(settled.folders, [elsewhere], 'and so is the Working folder');
      asked.length = 0;
      const next = await runHook(envFor(ws, who), edit('Write', noteFile(ws)));
      assert.strictEqual(next.decision, 'allow', next.out);
      assert.match(next.reason, IN_WORKSPACE);
      assert.strictEqual(asked.length, 0, 'an ordinary write in the workspace, with no card');
    });
  }

  // A workspace whose answers would allow the write if anything asked them: a
  // saved "Always allow" for every file tool, folder grants covering the
  // .rundock folder and the workspace, and the .rundock folder named as a
  // Working folder. The server standing in for Rundock allows everything as
  // well. The refusal comes before all of them, so the same write is refused
  // however often it is sent.
  const granted = (mode, who) => {
    const ws = path.join(root, `ws-granted-${mode}-${who}`);
    makeWorkspace(ws, mode);
    const own = path.join(ws, '.rundock');
    fs.writeFileSync(permissionsFile(ws), `${JSON.stringify({ allowedDirs: [own, ws], allowedTools: EDIT_TOOLS })}\n`);
    fs.writeFileSync(stateFile(ws), `${JSON.stringify({ workspaceMode: mode, workingFolders: [own] })}\n`);
    return ws;
  };
  for (const [label, mode, who] of [
    ['Code mode, a conversation', 'code', 'conversation'],
    ['Notes mode, a conversation', 'notes', 'conversation'],
    ['Code mode, a routine run', 'code', 'routine'],
    ['Notes mode, a routine run', 'notes', 'routine'],
  ]) {
    test(`the retry: the same Write sent twice is refused twice, with a saved answer and a folder grant in place, and a shell command still carded, in ${label}`, async () => {
      const ws = granted(mode, who);
      const env = envFor(ws, who);
      assert.ok(env.RUNDOCK_EXTRA_DIRS.split(path.delimiter).includes(path.join(ws, '.rundock')),
        'sanity: the .rundock folder is named as a Working folder');
      for (const attempt of ['first', 'second']) {
        await assertRefused(env, edit('Write', permissionsFile(ws)), `the ${attempt} Write`, [permissionsFile(ws), stateFile(ws)]);
      }
      asked.length = 0;
      await runHook(env, shell('echo {} > .rundock/permissions.json'));
      assert.strictEqual(asked.length, 1, 'the same change through a shell command is carded');
      assert.ok(answerFileCrossing(asked[0]), 'as an answer-file write');
    });
  }

  for (const [label, ws, who] of RUNS) {
    test(`the most common next step: told what to do instead, the agent goes on with its work, in ${label}`, async () => {
      const env = envFor(ws, who);
      const r = await assertRefused(env, edit('Edit', permissionsFile(ws)), 'the Edit', [permissionsFile(ws)]);
      if (who === 'routine') {
        assert.ok(r.reason.endsWith(`Say in your final message what you wanted to change. ${hook.UNATTENDED_NEXT_UNLOADED}`), 'a routine says so in its final message, and carries on');
        assert.doesNotMatch(r.reason, /Tell the person/, 'a routine has nobody to tell');
      } else {
        assert.ok(r.reason.endsWith('Tell the person what you wanted to change, so they can make it in Rundock.'), 'a conversation tells the person');
      }
      asked.length = 0;
      const next = await runHook(env, edit('Write', noteFile(ws)));
      assert.strictEqual(next.decision, 'allow', next.out);
      assert.match(next.reason, IN_WORKSPACE);
      assert.strictEqual(asked.length, 0, 'the next ordinary write, with no card');
    });
  }
});

// THE CONTROL FAILING. A check that throws must refuse, never allow: a throw
// caught here and read as "not one of these files" would send the very write
// it exists to stop on to a card, or in Code mode to an allow. The check calls
// rundockAnswerFileSeam.beforeChecking, a module attribute, which a preload in
// the hook's own process makes throw, the pattern of hook-never-crashes.test.js.
// The hook runs main() as it loads, but decides only once its input has been
// read, so the attribute is set before the check runs.
const FAILS = path.join(root, 'rundock-file-check-fails.js');
fs.writeFileSync(FAILS, `
  const Module = require('module');
  const compile = Module.prototype._compile;
  Module.prototype._compile = function (content, filename) {
    const done = compile.apply(this, arguments);
    if (filename === ${JSON.stringify(HOOK)} && this.exports && this.exports.rundockAnswerFileSeam) {
      this.exports.rundockAnswerFileSeam.beforeChecking = () => { throw new Error('forced failure'); };
    }
    return done;
  };
`);

describe('the control failing: the call is refused and the hook never crashes', () => {
  for (const [label, ws, who] of RUNS) {
    test(`the control failing: a forced failure of the check refuses as unchecked, with no card, in ${label}`, async () => {
      assert.strictEqual(typeof (hook.rundockAnswerFileSeam && hook.rundockAnswerFileSeam.beforeChecking), 'function',
        'the seam the preload makes throw is a module attribute');
      const env = envFor(ws, who);
      const said = who === 'routine' ? `${COULD_NOT_CHECK} ${hook.UNATTENDED_NEXT_UNLOADED}` : COULD_NOT_CHECK;
      for (const target of [permissionsFile(ws), stateFile(ws), noteFile(ws)]) {
        asked.length = 0;
        const r = await runHook(env, edit('Write', target), { preload: FAILS });
        assert.strictEqual(r.status, 0, `${path.relative(ws, target)}: the hook answered rather than crashing (${r.err})`);
        assert.strictEqual(r.decision, 'deny', `${path.relative(ws, target)}: ${r.out}`);
        assert.strictEqual(r.reason, said, `${path.relative(ws, target)}: refused as a request Rundock could not check`);
        assert.strictEqual(asked.length, 0, `${path.relative(ws, target)}: with no card`);
      }
      // A Read is not a file tool's write, so the check never reaches its seam.
      const read = await runHook(env, { tool_name: 'Read', tool_input: { file_path: permissionsFile(ws) } }, { preload: FAILS });
      assert.strictEqual(read.decision, 'allow', read.out);
      assert.match(read.reason, IN_WORKSPACE);
    });

    test(`the control failing: with no server to ask, a file tool's write still gets this refusal, in ${label}`, async () => {
      const env = { ...envFor(ws, who), RUNDOCK_PORT: CLOSED_PORT };
      for (const tool of ['Write', 'Edit']) {
        for (const target of [permissionsFile(ws), stateFile(ws)]) {
          await assertRefused(env, edit(tool, target), `${tool} ${path.relative(ws, target)}`, [target]);
        }
      }
      // A shell command writing either file gets the words it got before.
      for (const rel of ['permissions.json', 'state.json']) {
        const r = await runHook(env, shell(`echo {} > .rundock/${rel}`));
        assert.strictEqual(r.decision, 'deny', `${rel}: ${r.out}`);
        assert.ok(r.reason.includes(UNANSWERED_ANSWER_FILE), `${rel}: refused as an answer file nobody could be asked about (${r.reason})`);
      }
    });

    test(`the control failing: input the hook cannot read is refused before the check, in ${label}`, async () => {
      const env = envFor(ws, who);
      asked.length = 0;
      const r = await runHook(env, null, { stdin: '{"tool_name":"Write","tool_input":' });
      assert.strictEqual(r.status, 0, r.err);
      assert.strictEqual(r.decision, 'deny', r.out);
      assert.strictEqual(r.reason, who === 'routine' ? `${COULD_NOT_CHECK} ${hook.UNATTENDED_NEXT_UNLOADED}` : COULD_NOT_CHECK);
      assert.strictEqual(asked.length, 0, 'with no card');
    });
  }
});
