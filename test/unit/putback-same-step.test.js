'use strict';
// THE AGENT IS TOLD IN THE SAME STEP AS THE COMMAND WHOSE CHANGE WAS PUT BACK.
//
// The line used to wait for the agent's NEXT tool call, and an agent that
// made none after its `node -e` write was never told, so it reported that the
// protection had not stopped it. Now a PostToolUse hook runs as each tool
// call finishes, asks the server to check the permission files for that
// conversation at once rather than at the next poll, and hands any resulting
// line back as additionalContext for that same step. The PreToolUse delivery
// stays as the fallback; either way a line is delivered once.
//
// Registered only where Rundock owns the settings file, like the working
// folders' additional directories: a settings file whose sandbox block a
// person wrote gets no new entry.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const config = require('../../lib/config.js');
const glue = require('../../lib/runtime/codex-glue.js');
const { handleHttpRequest } = require('../../lib/http-router.js');
const { acquireAnswerFileGuard } = require('../../lib/workspace/answer-file-guard.js');
const { watchClaudeTurns } = require('../../lib/runtime/claude-turn-guard.js');
const scaffold = require('../../lib/workspace/scaffold.js');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const LINE = 'Rundock put back your change to .rundock/permissions.json because it holds the person\'s permission answers. '
  + 'They are being asked whether to keep it; don\'t try the change another way.';

function runHook(env, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => resolve(out));
    child.stdin.end(JSON.stringify(input));
  });
}

describe('a change put back during a command is told to the agent in that same step', () => {
  let ws, server, port, prevWorkspace, prevDeps, proc, stop;
  beforeEach(async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'putback-same-step-'));
    fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.rundock', 'permissions.json'), '{"allowedTools":[]}\n');
    fs.writeFileSync(path.join(ws, '.rundock', 'state.json'), '{"workspaceMode":"code"}\n');
    prevWorkspace = config.getWorkspace();
    config.setWorkspace(ws);
    prevDeps = glue.wireCodexGlueDeps({ safeSend: () => {}, requestServerPermission: () => {} });
    server = http.createServer(handleHttpRequest);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
    // A running Claude turn, guarded with the poll pushed far out, so only the
    // check the finished tool call asks for can catch the change in time.
    proc = new EventEmitter();
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    stop = watchClaudeTurns(proc, {
      workspace: ws,
      onChange: (change) => glue.surfaceAnswerFileChange({ agentId: 'builder', processId: null }, 'convo-post', change, 'claude'),
      acquire: (w, onChange) => acquireAnswerFileGuard(w, onChange, { intervalMs: 60 * 60 * 1000 }),
    }).stop;
  });
  afterEach(async () => {
    stop();
    await new Promise((r) => server.close(r));
    glue.wireCodexGlueDeps(prevDeps);
    if (prevWorkspace) config.setWorkspace(prevWorkspace);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  const env = () => ({ ...process.env, RUNDOCK: '1', RUNDOCK_PORT: String(port), RUNDOCK_WORKSPACE: ws, RUNDOCK_CONVO_ID: 'convo-post', RUNDOCK_HOOK_TOKEN: require('../../lib/auth/index.js').issueHookToken('convo-post') });
  const post = (command) => runHook(env(), {
    session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: '', stderr: '' },
  });

  test('a node -e write, with no further tool call, is put back and told in the step that made it', async () => {
    // What the agent's command did.
    fs.writeFileSync(path.join(ws, '.rundock', 'permissions.json'), '{"allowedTools":["Bash"]}\n');
    const out = JSON.parse(await post(`node -e "require('fs').writeFileSync('.rundock/permissions.json','{}')"`));
    assert.deepStrictEqual(out, { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: LINE } });
    assert.strictEqual(fs.readFileSync(path.join(ws, '.rundock', 'permissions.json'), 'utf-8'), '{"allowedTools":[]}\n',
      'already put back when the step ends');
  });

  test('delivered once: neither the next finished step nor the next tool call repeats it', async () => {
    fs.writeFileSync(path.join(ws, '.rundock', 'permissions.json'), '{"allowedTools":["Bash"]}\n');
    await post('node -e 1');
    assert.strictEqual(await post('ls'), '{}');
    const pre = JSON.parse(await runHook({ ...env(), RUNDOCK_CODE_MODE: '1' }, {
      session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: ws,
    }));
    assert.strictEqual(pre.hookSpecificOutput.additionalContext, undefined);
  });

  test('nothing changed, nothing said', async () => {
    assert.strictEqual(await post('ls'), '{}');
  });

  test('with the server unreachable the step ends quietly', async () => {
    const out = await runHook({ ...env(), RUNDOCK_PORT: '1' }, { session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.strictEqual(out, '{}');
  });
});

describe('the PostToolUse hook is registered only where Rundock owns the settings file', () => {
  let dir, prevDeps;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'putback-scaffold-'));
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
    prevDeps = scaffold.wireScaffoldDeps({ invalidateAgentCache() {}, rebaselineAgentsWatcher() {} });
  });
  afterEach(() => { scaffold.wireScaffoldDeps(prevDeps); fs.rmSync(dir, { recursive: true, force: true }); });
  const settings = () => JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf-8'));
  const permissionHook = (e) => (e.hooks || []).some((h) => h.command && h.command.includes('permission-hook'));

  test('Rundock\'s own settings get one PostToolUse entry for the tools that can write, beside the unchanged PreToolUse ones', () => {
    scaffold.scaffoldWorkspace(dir, { platform: 'darwin' });
    const s = settings();
    const post = (s.hooks.PostToolUse || []).filter(permissionHook);
    assert.strictEqual(post.length, 1);
    assert.strictEqual(post[0].matcher, 'Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|mcp__.*');
    assert.deepStrictEqual(s.hooks.PreToolUse.map((e) => e.matcher), ['Bash', 'Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep', 'PowerShell', 'mcp__.*']);
    assert.strictEqual(post[0].hooks[0].command, s.hooks.PreToolUse[0].hooks[0].command, 'the same script');
  });

  test('an open again changes nothing, and a stale entry is replaced rather than joined', () => {
    scaffold.scaffoldWorkspace(dir, { platform: 'darwin' });
    const f = path.join(dir, '.claude', 'settings.local.json');
    const first = fs.readFileSync(f, 'utf-8');
    scaffold.scaffoldWorkspace(dir, { platform: 'darwin' });
    assert.strictEqual(fs.readFileSync(f, 'utf-8'), first, 'idempotent');
    const s = settings();
    s.hooks.PostToolUse[0].hooks[0].command = '"/old/place/permission-hook.js"';
    fs.writeFileSync(f, JSON.stringify(s, null, 2));
    scaffold.scaffoldWorkspace(dir, { platform: 'darwin' });
    const post = settings().hooks.PostToolUse.filter(permissionHook);
    assert.strictEqual(post.length, 1);
    assert.notStrictEqual(post[0].hooks[0].command, '"/old/place/permission-hook.js"');
  });

  test('a person\'s own hooks on either event are left alone', () => {
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({
      hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'prettier --write' }] }] },
    }, null, 2));
    scaffold.scaffoldWorkspace(dir, { platform: 'darwin' });
    const post = settings().hooks.PostToolUse;
    assert.ok(post.some((e) => e.hooks[0].command === 'prettier --write'), 'theirs stays');
    assert.strictEqual(post.filter(permissionHook).length, 1, 'and ours is added beside it');
  });

  test('a settings file whose sandbox block a person wrote gets no PostToolUse entry', () => {
    const theirs = { sandbox: { enabled: true, filesystem: { allowWrite: ['/a'] } } };
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify(theirs, null, 2));
    scaffold.scaffoldWorkspace(dir, { platform: 'darwin' });
    const s = settings();
    assert.strictEqual((s.hooks.PostToolUse || []).filter(permissionHook).length, 0);
    assert.ok(s.hooks.PreToolUse.length >= 1, 'the permission hook itself is still wired, as before');
  });
});
