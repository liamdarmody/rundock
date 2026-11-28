'use strict';
// THE PERMISSION HOOK AND A LEAD'S AGENT CALLS.
//
// A lead's Agent call reaches Rundock through the hook like any other tool
// call, and Rundock decides whether that helper starts. The hook passes on the
// ids that let Rundock match the request to the lead's message (and tell a
// helper's own calls from the lead's), never lets an Agent call through when
// Rundock can't be asked, never approves one by itself in Code mode, and hands
// the agent Rundock's own words when a call is refused.
//
// Each case runs the real hook as its own process, the way the runtime does,
// against a small server standing in for Rundock. Port 1 refuses every
// connection, so a request finds nobody to ask.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { refusalNotice, approvalNotice } = require('../../scripts/refusal-notice.js');
const scaffold = require('../../lib/workspace/scaffold.js');
const { makeTempDir, cleanup } = require('../helpers/workspace.js');
after(cleanup);

const HELPERS = path.join(__dirname, '..', '..', 'lib', 'delegation', 'helpers.js');
function helpers() {
  assert.ok(fs.existsSync(HELPERS), 'lib/delegation/helpers.js exists');
  return require(HELPERS);
}

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'subagent-hook-payload.json');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-agent-')));
const ws = path.join(root, 'ws');
const elsewhere = path.join(root, 'elsewhere');
fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
fs.mkdirSync(elsewhere, { recursive: true });
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

const CONVERSATION = { RUNDOCK_CONVO_ID: 'c1' };

function runHook(request, { port = 1, env = {} } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [HOOK], {
      env: { ...process.env, NODE_V8_COVERAGE: '', RUNDOCK: '1', RUNDOCK_PORT: String(port), RUNDOCK_WORKSPACE: ws, RUNDOCK_CONVO_ID: '', RUNDOCK_CODE_MODE: '', RUNDOCK_TEST_SEAMS: '1', RUNDOCK_TEST_PLATFORM: 'darwin', ...CONVERSATION, ...env },
    });
    const ending = setTimeout(() => proc.kill('SIGKILL'), 30000);
    let out = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.on('close', (status) => {
      clearTimeout(ending);
      let answer = null;
      try { answer = JSON.parse(out); } catch (e) { /* asserted by the callers */ }
      resolve({ status, answer });
    });
    proc.stdin.end(typeof request === 'string' ? request : JSON.stringify(request));
  });
}
const output = (r) => (r.answer && r.answer.hookSpecificOutput) || {};

// A Rundock to ask: every permission request is recorded by what it carried
// and answered with `reply` (a string is sent as it is).
function rundock(reply) {
  return new Promise((resolve) => {
    const asked = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url.startsWith('/api/agent-notice')) { res.end(JSON.stringify({ text: '' })); return; }
        try { asked.push(JSON.parse(body)); } catch (e) { asked.push(body); }
        res.end(typeof reply === 'string' ? reply : JSON.stringify(reply));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      asked,
      close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
    }));
  });
}

// A lead's Agent call, as the runtime sends it.
const AGENT_CALL = {
  session_id: 's', hook_event_name: 'PreToolUse', cwd: ws, tool_name: 'Agent',
  tool_input: { subagent_type: 'ash', description: 'Draft the summary', prompt: 'Draft it.' },
  tool_use_id: 'toolu_lead_1',
};

// The two payloads the runtime was measured sending, with the read pointed
// outside the workspace so the hook asks Rundock about it.
function measured() {
  const text = fs.readFileSync(FIXTURE, 'utf8')
    .split('<workspace>/notes.md').join(path.join(elsewhere, 'notes.md'))
    .split('<workspace>').join(ws);
  return JSON.parse(text);
}

describe('the hook passes on the ids Rundock matches a call by', () => {
  test('a subagent\'s call carries its tool_use_id, agent_id and agent_type; a lead\'s carries its tool_use_id', async () => {
    const fixture = measured();
    const server = await rundock({ allow: true });
    try {
      await runHook(fixture.parent, { port: server.port });
      await runHook(fixture.subagent, { port: server.port });
    } finally { await server.close(); }
    assert.strictEqual(server.asked.length, 2, 'both were asked about');
    const [parent, subagent] = server.asked;
    assert.strictEqual(parent.tool_use_id, fixture.parent.tool_use_id);
    assert.ok(!('agent_id' in parent) && !('agent_type' in parent), 'the lead\'s own call names no agent');
    assert.strictEqual(subagent.tool_use_id, fixture.subagent.tool_use_id);
    assert.strictEqual(subagent.agent_id, fixture.subagent.agent_id);
    assert.strictEqual(subagent.agent_type, fixture.subagent.agent_type);
  });

  test('a value that is not a string is left out', async () => {
    const server = await rundock({ allow: true });
    try {
      await runHook({ ...AGENT_CALL, tool_use_id: 7, agent_id: { id: 'x' }, agent_type: null }, { port: server.port });
      await runHook(AGENT_CALL, { port: server.port });
    } finally { await server.close(); }
    const [odd, plain] = server.asked;
    assert.ok(!('tool_use_id' in odd) && !('agent_id' in odd) && !('agent_type' in odd), JSON.stringify(odd));
    assert.strictEqual(plain.tool_use_id, 'toolu_lead_1', 'a string one is passed on');
  });
});

describe('an Agent call is never let through unchecked', () => {
  test('Rundock unreachable: refused, saying the helper did not start', async () => {
    const r = await runHook(AGENT_CALL);
    assert.strictEqual(output(r).permissionDecision, 'deny');
    assert.strictEqual(output(r).permissionDecisionReason,
      "Rundock server unreachable. Rundock couldn't check this helper, so it didn't start. Do this part yourself.");
  });

  test('a reply Rundock could not have sent: refused the same way', async () => {
    const server = await rundock('not json');
    let r;
    try { r = await runHook(AGENT_CALL, { port: server.port }); } finally { await server.close(); }
    assert.strictEqual(output(r).permissionDecision, 'deny');
    assert.strictEqual(output(r).permissionDecisionReason,
      "Rundock hook: could not parse server response. Rundock couldn't check this helper, so it didn't start. Do this part yourself.");
  });

  test('Code mode does not approve it: Rundock is asked, and its answer stands', async () => {
    const server = await rundock({ allow: false, notice: 'Not this one.' });
    let r;
    try { r = await runHook(AGENT_CALL, { port: server.port, env: { RUNDOCK_CODE_MODE: '1' } }); } finally { await server.close(); }
    assert.strictEqual(server.asked.length, 1, 'the request reached Rundock');
    assert.strictEqual(server.asked[0].tool_name, 'Agent');
    assert.strictEqual(output(r).permissionDecision, 'deny');
    assert.notStrictEqual(output(r).permissionDecisionReason, 'Auto-approved: workspace is in Code mode');
  });

  test('outside Rundock the hook stays out of the way; inside it, the same call is checked', async () => {
    const outside = await runHook(AGENT_CALL, { env: { RUNDOCK: '' } });
    assert.deepStrictEqual(outside.answer, {});
    const inside = await runHook(AGENT_CALL);
    assert.strictEqual(output(inside).permissionDecision, 'deny', 'with Rundock unreachable, refused');
  });
});

describe('Rundock\'s answer is handed to the agent', () => {
  test('a refusal with its own words is given those words exactly', async () => {
    const notice = "Wren can't be Wren's own helper. Do this part yourself.";
    const server = await rundock({ allow: false, notice });
    let r;
    try { r = await runHook(AGENT_CALL, { port: server.port }); } finally { await server.close(); }
    assert.strictEqual(output(r).permissionDecision, 'deny');
    assert.strictEqual(output(r).permissionDecisionReason, notice);
  });

  test('a refusal with no words of its own keeps today\'s', async () => {
    const server = await rundock({ allow: false });
    let r;
    try { r = await runHook(AGENT_CALL, { port: server.port }); } finally { await server.close(); }
    assert.strictEqual(output(r).permissionDecisionReason, refusalNotice('denied', 'Agent', { unattended: false }));
    assert.strictEqual(server.asked[0].tool_use_id, 'toolu_lead_1', 'and the request carried the call\'s id');
  });

  test('a card nobody answered keeps today\'s timeout words', async () => {
    // Passes before helpers existed, by design: it pins today's timeout
    // wording through the hook. Its sibling "a refusal with its own words is
    // given those words exactly" shares this setup and fails without helpers.
    const server = await rundock({ allow: false, reason: 'timeout' });
    let r;
    try { r = await runHook(AGENT_CALL, { port: server.port }); } finally { await server.close(); }
    assert.strictEqual(output(r).permissionDecision, 'deny');
    assert.strictEqual(output(r).permissionDecisionReason, refusalNotice('timeout', 'Agent', { unattended: false }));
  });

  test('an approval from the card is told to the agent', async () => {
    const server = await rundock({ allow: true, card: true });
    let r;
    try { r = await runHook(AGENT_CALL, { port: server.port }); } finally { await server.close(); }
    assert.strictEqual(output(r).permissionDecision, 'allow');
    assert.strictEqual(output(r).additionalContext, approvalNotice('Agent'));
    assert.strictEqual(server.asked[0].tool_use_id, 'toolu_lead_1', 'and the request carried the call\'s id');
  });
});

describe('the workspace settings send a lead\'s Agent calls to the hook while helpers are on', () => {
  const open = (dir) => {
    const prev = scaffold.wireScaffoldDeps({ invalidateAgentCache() {}, rebaselineAgentsWatcher() {} });
    try { scaffold.scaffoldWorkspace(dir, { platform: 'darwin' }); } finally { scaffold.wireScaffoldDeps(prev); }
    return JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8')).hooks.PreToolUse;
  };
  const workspace = () => {
    const dir = makeTempDir('hook-agent-matcher-');
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
    return dir;
  };
  const withHelpers = (on, fn) => {
    const mod = helpers();
    const was = mod.HELPERS_ENABLED;
    mod.HELPERS_ENABLED = on;
    try { return fn(); } finally { mod.HELPERS_ENABLED = was; }
  };

  test('on: an Agent entry with the same hook command, failing closed', () => {
    const pre = withHelpers(true, () => open(workspace()));
    const agent = pre.filter((e) => e.matcher === 'Agent');
    assert.strictEqual(agent.length, 1, 'one Agent entry');
    const bash = pre.find((e) => e.matcher === 'Bash');
    assert.deepStrictEqual(agent[0].hooks, bash.hooks, 'the same command, timeout and failure answer as the others');
    assert.strictEqual(agent[0].hooks[0].onFailure, scaffold.HOOK_ON_FAILURE);
    assert.strictEqual(agent[0].hooks[0].onFailure, 'block');
  });

  test('turned off again, the next open takes Rundock\'s Agent entry out and leaves a person\'s own', () => {
    const dir = workspace();
    const on = withHelpers(true, () => open(dir));
    assert.strictEqual(on.filter((e) => e.matcher === 'Agent').length, 1, 'written while on');
    const settingsFile = path.join(dir, '.claude', 'settings.local.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings.hooks.PreToolUse.push({ matcher: 'Agent', hooks: [{ type: 'command', command: 'their-own-check' }] });
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    const pre = withHelpers(false, () => open(dir));
    const agent = pre.filter((e) => e.matcher === 'Agent');
    assert.deepStrictEqual(agent, [{ matcher: 'Agent', hooks: [{ type: 'command', command: 'their-own-check' }] }]);
  });
});
