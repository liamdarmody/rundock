'use strict';
// A COMMAND OUTSIDE THE SANDBOX, APPROVED ON ITS CARD, RUNS ONCE, AND A
// REFUSAL AFTER AN APPROVAL IS SAID.
//
// Claude Code puts a Bash or PowerShell call with
// `dangerouslyDisableSandbox: true` that the PreToolUse answer allowed to the
// PermissionRequest hooks, and runs it only on an allow. The stub models that
// check (test/helpers/stub-claude/claude, askPermissionRequest) against the
// settings the workspace was scaffolded with, so a call here goes through the
// router, the real hook and the stub as it would through the CLI. Where a case
// cannot come from an agent, because every call outside the sandbox raises a
// card of its own, the real hook is run by hand with a conversation's
// environment, as anything in the conversation could run it.
//
// The notice is driven through the stream reader the server wires to every
// Claude Code process, fed the lines the CLI gives.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const h = require('../helpers/harness.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');
const { startRoutine, finished } = require('../helpers/permission-route.js');
const fx = require('../fixtures/stream-json.js');
const ROUTER = require('../../lib/http-router.js');
const { createState, reduce } = require('../../public/conversation-state.js');

// Required with a guard, so a missing module fails an assertion rather than
// the whole file.
let grantsModule = null;
try { grantsModule = require('../../lib/runtime/sandbox-grants.js'); } catch (e) { grantsModule = null; }
function grants() {
  assert.ok(grantsModule, 'lib/runtime/sandbox-grants.js exists');
  assert.ok(grantsModule.seams && typeof grantsModule.seams.now === 'function', 'it exports its clock');
  return grantsModule;
}
function routeExists() {
  assert.strictEqual(ROUTER.isOpenRoute({ method: 'POST', url: '/api/sandbox-grant' }), true, 'the spend route is open to the hook');
}

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const AGENT = 'default';
const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
const NOTICE = 'Claude Code refused to run a command outside the sandbox, even though you approved its card. Nothing ran. You can run it yourself in a terminal.';
const outside = (command = 'echo hello', tool = 'Bash') => ({ tool, input: { command, dangerouslyDisableSandbox: true } });

let client;
before(async () => {
  await h.boot({
    agents: { ...standardTeam(), 'example-lead': agentFile({ name: 'example-lead', displayName: 'Ash', type: 'specialist', order: 0 }) },
  });
  h.internal.stopScheduler();
  client = await h.connect();
});
const opened = new Set();
const open = (convo) => { opened.add(convo); return convo; };
let realNow = null;
afterEach(() => {
  if (realNow) { grantsModule.seams.now = realNow; realNow = null; }
  for (const convo of opened) h.reapConvo(convo);
  opened.clear();
});
after(async () => {
  for (const m of client.messages.filter((x) => x.type === 'control_request')) {
    client.send({ type: 'permission_response', requestId: m.request_id, conversationId: m._conversationId || '', allow: false, card: true });
  }
  await h.delay(200);
  for (const { pid } of h.readInvocations()) {
    try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already ended */ }
  }
  await h.shutdown();
});

// The server's clock for grants, fixed at `at` until the test ends.
function clockAt(at) {
  const g = grants();
  if (!realNow) realNow = g.seams.now;
  g.seams.now = () => at;
}

// The real hook, run by hand for `event` about `call` in `convo`, with the
// environment Rundock gives `agent` there. Gives what it wrote.
function runHook(event, convo, call, { agent = AGENT } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [HOOK], {
      cwd: h.workspaceDir,
      env: {
        ...process.env, RUNDOCK: '1', RUNDOCK_PORT: String(h.port), RUNDOCK_WORKSPACE: h.workspaceDir,
        RUNDOCK_CODE_MODE: '', RUNDOCK_CONVO_ID: convo, RUNDOCK_HOOK_TOKEN: h.hookToken(convo, agent),
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('error', reject);
    proc.on('close', () => resolve(out));
    proc.stdin.end(JSON.stringify({
      session_id: `s-${convo}`, transcript_path: '', cwd: h.workspaceDir, permission_mode: 'default',
      hook_event_name: event, tool_name: call.tool, tool_input: call.input,
    }));
  });
}
const askedByHand = (convo, call, options) => runHook('PermissionRequest', convo, call, options);

// The card the hook raises for `call` in `convo`, answered `allow` as the
// window answers it.
async function cardAnswered(convo, call, allow, { agent = AGENT } = {}) {
  const since = client.messages.length;
  const pending = runHook('PreToolUse', convo, call, { agent });
  const { msg: card } = await client.waitFor((m) => m.type === 'control_request' && m._conversationId === convo, { since, label: `the card in ${convo}` });
  client.send({ type: 'permission_response', requestId: card.request_id, conversationId: convo, allow, card: true });
  const said = JSON.parse(await pending).hookSpecificOutput || {};
  assert.strictEqual(said.permissionDecision, allow ? 'allow' : 'deny', 'the card was answered');
}
const approve = (convo, call, options) => cardAnswered(convo, call, true, options);

// Claude Code's check of each call outside the sandbox in `convo`, as the stub
// logged it.
const checksIn = (convo) => h.readHookAnswers().filter((a) => a.event === 'PermissionRequest' && a.convo === convo);

// One turn of the agent making `calls`, each card answered by `allows` in
// turn, run to its end.
let turnSeq = 0;
async function agentTurn(convo, calls, allows = calls.map(() => true)) {
  const prompt = `outside the sandbox, turn ${++turnSeq}`;
  h.writeScenario([{ match: { agent: 'example-lead', promptIncludes: prompt }, hooks: calls, turn: [{ text: 'Done.' }] }]);
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convo, agent: 'example-lead', content: prompt });
  const answered = new Set();
  for (const allow of allows) {
    const { msg: card } = await client.waitFor((m) => m.type === 'control_request' && m._conversationId === convo && !answered.has(m.request_id), { since, label: `card ${answered.size + 1} in ${convo}` });
    answered.add(card.request_id);
    client.send({ type: 'permission_response', requestId: card.request_id, conversationId: convo, allow, card: true });
  }
  await client.waitForEvent('system', 'done', convo, { since, timeout: 20000 });
  return client.messages.slice(since).filter((m) => m._conversationId === convo);
}
const refusalsIn = (frames) => frames.filter((m) => m.type === 'system' && m.subtype === 'permission_denied');
const noticesIn = (frames) => frames.filter((m) => m.type === 'system' && m.subtype === 'notice' && m.content === NOTICE);

// ---------------------------------------------------------------------------
// Through the agent
// ---------------------------------------------------------------------------

test('a command outside the sandbox approved on its card runs, once, and nothing is said', async () => {
  routeExists();
  const convo = open(h.freshConvoId('override-runs'));
  const frames = await agentTurn(convo, [outside()]);
  const checks = checksIn(convo);
  assert.strictEqual(checks.length, 1, 'Claude Code checked the call once');
  assert.deepStrictEqual(checks[0].answers, [JSON.parse(ALLOW)], 'and the hook allowed it');
  assert.strictEqual(checks[0].outcome, 'ran');
  assert.deepStrictEqual(refusalsIn(frames), [], 'nothing was refused');
  assert.deepStrictEqual(noticesIn(frames), [], 'and no notice for a command that ran');
});

test('the same command again after it ran, without its own approval, gets no decision', async () => {
  routeExists();
  const convo = open(h.freshConvoId('override-again'));
  await agentTurn(convo, [outside()]);
  assert.strictEqual(checksIn(convo)[0].outcome, 'ran', 'the approved call ran');
  assert.strictEqual(await askedByHand(convo, outside()), '{}');
});

test('two identical calls, each approved on its own card, each run once', async () => {
  routeExists();
  const convo = open(h.freshConvoId('override-two'));
  await agentTurn(convo, [outside(), outside()]);
  assert.deepStrictEqual(checksIn(convo).map((c) => c.outcome), ['ran', 'ran']);
  assert.strictEqual(await askedByHand(convo, outside()), '{}', 'and a third is not');
});

test('the next call outside the sandbox needs its own card: denied, it is refused before Claude Code asks', async () => {
  routeExists();
  const convo = open(h.freshConvoId('override-next'));
  await agentTurn(convo, [outside(), outside()], [true, false]);
  assert.deepStrictEqual(checksIn(convo).map((c) => c.outcome), ['ran'], 'only the approved one reached the check');
});

test('a routine\'s identical call, its card approved, is refused with no decision', async () => {
  routeExists();
  const command = 'echo hello from a routine';
  const since = client.messages.length;
  const run = startRoutine('content-lead', { hooks: [outside(command)] }, 'override-routine');
  const { msg: card } = await client.waitFor((m) => m.type === 'control_request' && m.request && m.request.input && m.request.input.command === command, { since, label: 'the run\'s card', timeout: 15000 });
  client.send({ type: 'permission_response', requestId: card.request_id, conversationId: card._conversationId || '', allow: true, card: true });
  await finished(run);
  const checks = h.readHookAnswers().filter((a) => a.event === 'PermissionRequest' && a.command === command);
  assert.strictEqual(checks.length, 1, 'Claude Code checked the call');
  assert.deepStrictEqual(checks[0].answers, [{}], 'the hook was asked, and gave no decision');
  assert.strictEqual(checks[0].outcome, 'refused');
});

// ---------------------------------------------------------------------------
// An approved grant asked for by anything but the approved call
// ---------------------------------------------------------------------------

for (const [label, ask] of [
  ['from another conversation', (convo, call) => askedByHand(open(h.freshConvoId('override-other-convo')), call)],
  ['by another agent in the same conversation', (convo, call) => askedByHand(convo, call, { agent: 'example-other' })],
  ['with one character of the command changed', (convo) => askedByHand(convo, outside('echo hellO'))],
  ['without the flag', (convo) => askedByHand(convo, { tool: 'Bash', input: { command: 'echo hello' } })],
  ['by another tool', (convo) => askedByHand(convo, outside('echo hello', 'PowerShell'))],
]) {
  test(`an approved command asked for ${label} gets no decision, and the grant stays for the approved call`, async () => {
    routeExists();
    const convo = open(h.freshConvoId('override-asked'));
    await approve(convo, outside());
    assert.strictEqual(await ask(convo, outside()), '{}');
    assert.strictEqual(await askedByHand(convo, outside()), ALLOW, 'the approved call is still allowed');
  });
}

test('a grant asked for 59 seconds after its card is spent', async () => {
  const base = Date.now();
  clockAt(base);
  const convo = open(h.freshConvoId('override-59'));
  await approve(convo, outside());
  clockAt(base + 59000);
  assert.strictEqual(await askedByHand(convo, outside()), ALLOW);
});

test('a grant asked for 60 seconds after its card gets no decision, and is gone', async () => {
  const base = Date.now();
  clockAt(base);
  const convo = open(h.freshConvoId('override-60'));
  await approve(convo, outside());
  clockAt(base + 60000);
  assert.strictEqual(await askedByHand(convo, outside()), '{}');
  clockAt(base + 1000);
  assert.strictEqual(await askedByHand(convo, outside()), '{}', 'nothing is left to spend');
});

// ---------------------------------------------------------------------------
// The notice
// ---------------------------------------------------------------------------

test('with the PermissionRequest entry gone from the settings, an approved command is refused and the conversation says so', async () => {
  routeExists();
  const file = path.join(h.workspaceDir, '.claude', 'settings.local.json');
  const kept = fs.readFileSync(file, 'utf-8');
  const settings = JSON.parse(kept);
  assert.ok(settings.hooks && Array.isArray(settings.hooks.PermissionRequest), 'the workspace was given the entry');
  delete settings.hooks.PermissionRequest;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  let frames;
  try {
    frames = await agentTurn(open(h.freshConvoId('override-no-entry')), [outside()]);
  } finally { fs.writeFileSync(file, kept); }
  assert.strictEqual(refusalsIn(frames).length, 1, 'Claude Code\'s refusal is forwarded');
  assert.strictEqual(noticesIn(frames).length, 1, 'and said once');
});

// The stream reader for one Claude Code process of `agent` in `convo`, wired
// as the server wires every one. `feed` gives it lines; `frames` is what it
// sent for that conversation.
const sent = [];
const watcher = { readyState: 1, send: (payload) => sent.push(JSON.parse(payload)) };
function reader(convo, agent = AGENT) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; };
  proc.stdin = { writable: true, write: () => true };
  const entry = {
    process: proc, buffer: '', processId: `proc-${convo}`, agentId: agent, responseText: '', exited: false,
    resultSent: false, pendingAgentTool: null, toolCalls: [], turnStartTime: Date.now(),
  };
  h.internal.wireProcessHandlers(entry, convo, null, {});
  return {
    feed(lines) {
      h.internal.connectedClients.add(watcher);
      try { proc.stdout.emit('data', Buffer.from(fx.toLines(lines))); } finally { h.internal.connectedClients.delete(watcher); }
    },
    frames: () => sent.filter((m) => m._conversationId === convo),
  };
}
const call = (index, input = outside().input, tool = 'Bash') => fx.toolUseFlow(tool, input, index);
const refused = (index, tool = 'Bash') => fx.sandboxOverrideDenied(tool, index);

test('a refusal of an approved command is forwarded, then said once in the conversation', async () => {
  const convo = open(h.freshConvoId('notice-said'));
  await approve(convo, outside());
  const r = reader(convo);
  r.feed([...call(1), refused(1)]);
  const frames = r.frames();
  const at = frames.findIndex((m) => m.type === 'system' && m.subtype === 'permission_denied' && m.tool_use_id === 'toolu_1');
  assert.ok(at >= 0, 'the refusal is forwarded as it was');
  assert.deepStrictEqual(frames.slice(at + 1), [{ type: 'system', subtype: 'notice', content: NOTICE, _conversationId: convo }], 'and followed by the notice alone');
});

// Passes before this change as well, by design: the page has always drawn a
// notice as a pill and nothing else. Its twin, which shares this frame and
// fails before the change, is 'a refusal of an approved command is forwarded,
// then said once in the conversation'.
test('the page draws the notice as a pill and changes nothing else', () => {
  const state = createState();
  const r = reduce(state, { type: 'system', subtype: 'notice', content: NOTICE, _conversationId: 'example-convo' }, {});
  assert.strictEqual(r.state, state, 'the conversation\'s state is untouched');
  assert.deepStrictEqual(r.effects, [{ type: 'notice', content: NOTICE }]);
});

for (const [label, setUp] of [
  ['a refusal for another reason', async (convo, r) => {
    await approve(convo, outside());
    r.feed([...call(1), { ...refused(1), decision_reason_type: 'rule' }]);
  }],
  ['a call without the flag', async (convo, r) => {
    await approve(convo, outside());
    r.feed([...call(1, { command: 'echo hello' }), refused(1)]);
  }],
  ['a command whose card was denied', async (convo, r) => {
    await cardAnswered(convo, outside(), false);
    r.feed([...call(1), refused(1)]);
    await approve(convo, outside());
  }],
  ['another command', async (convo, r) => {
    await approve(convo, outside());
    r.feed([...call(1, outside('echo hellO').input), refused(1)]);
  }],
  ['the command approved in another conversation', async (convo, r) => {
    await approve(open(h.freshConvoId('notice-elsewhere')), outside());
    r.feed([...call(1), refused(1)]);
    await approve(convo, outside());
  }],
]) {
  test(`no notice for ${label}, while the approved command's refusal still gets one`, async () => {
    const convo = open(h.freshConvoId('notice-not'));
    const r = reader(convo);
    await setUp(convo, r);
    assert.deepStrictEqual(noticesIn(r.frames()), [], 'nothing is said');
    assert.ok(r.frames().some((m) => m.subtype === 'permission_denied'), 'the refusal is still forwarded');
    r.feed([...call(3), refused(3)]);
    assert.strictEqual(noticesIn(r.frames()).length, 1, 'the approved command\'s refusal is said');
  });
}

test('no second notice for the same id, while the first refusal gets one', async () => {
  const convo = open(h.freshConvoId('notice-twice'));
  await approve(convo, outside());
  const r = reader(convo);
  r.feed([...call(1), refused(1)]);
  assert.strictEqual(noticesIn(r.frames()).length, 1, 'the first refusal is said');
  r.feed([refused(1)]);
  assert.strictEqual(refusalsIn(r.frames()).length, 2, 'both refusals are forwarded');
  assert.strictEqual(noticesIn(r.frames()).length, 1, 'and the second is not said');
});

test('no notice for a refusal after the window, while one within it gets one', async () => {
  const base = Date.now();
  clockAt(base);
  const convo = open(h.freshConvoId('notice-window'));
  await approve(convo, outside());
  const r = reader(convo);
  r.feed([...call(1), ...call(2)]);
  clockAt(base + 59000);
  r.feed([refused(1)]);
  assert.strictEqual(noticesIn(r.frames()).length, 1, 'said within the window');
  clockAt(base + 60000);
  r.feed([refused(2)]);
  assert.strictEqual(noticesIn(r.frames()).length, 1, 'and not after it');
});
