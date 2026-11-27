'use strict';
// A COMMAND OUTSIDE THE SANDBOX, APPROVED ON ITS CARD, RUNS ONCE, AND A
// REFUSAL AFTER AN APPROVAL IS SAID.
//
// Claude Code puts a Bash or PowerShell call with
// `dangerouslyDisableSandbox: true` that the PreToolUse answer allowed to the
// PermissionRequest hooks, and runs it only on an allow. The stub models that
// check (test/helpers/stub-claude/claude, askPermissionRequest) against the
// settings the workspace was scaffolded with, so a call here goes through the
// router, the real hook and the stub as it would through the CLI. A call the
// check allows runs for real in the workspace, and each test's command adds a
// line to a file named for that test, so the lines count its runs. Where a
// case cannot come from an agent's own card, because every call outside the
// sandbox raises a card of its own, the card is answered by hand with a
// conversation's environment, and the call is put to the stub's check with no
// card (`noCard`), in the conversation and as the agent the case names.
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
// The id Rundock gives example-lead, the team's first agent (order 0), so a
// card answered by hand is filed for the agent the conversation runs.
const AGENT = 'default';
const ALLOW = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
const NOTICE = 'Claude Code refused to run a command outside the sandbox, even though you approved its card. Nothing ran. You can run it yourself in a terminal.';
const outside = (command = 'echo hello', tool = 'Bash') => ({ tool, input: { command, dangerouslyDisableSandbox: true } });

let client;
before(async () => {
  await h.boot({
    agents: {
      ...standardTeam(),
      'example-lead': agentFile({ name: 'example-lead', displayName: 'Ash', type: 'specialist', order: 0 }),
      'example-other': agentFile({ name: 'example-other', displayName: 'Bea', type: 'specialist', order: 5 }),
    },
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

// A command that adds a line to a file in the workspace named for `name`
// each time it runs, under sh and cmd.exe alike, and the count of its runs.
function marker(name) {
  const file = `${name}.txt`;
  return {
    file,
    command: `echo ran>>${file}`,
    runs() {
      let text = '';
      try { text = fs.readFileSync(path.join(h.workspaceDir, file), 'utf-8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return text.split(/\r?\n/).filter((line) => line.trim()).length;
    },
  };
}
// The answers the hook gave each check of a command writing to `m`'s file,
// in order, wherever it was asked.
const checksFor = (m) => h.readHookAnswers()
  .filter((a) => a.event === 'PermissionRequest' && typeof a.command === 'string' && a.command.endsWith(`>>${m.file}`))
  .map((a) => a.answers);
// A call put to Claude Code's check with no card of its own.
const noCard = (call) => ({ ...call, noCard: true });

// One turn of `agent` making `calls`, each card they raise answered by
// `allows` in turn (a `noCard` call raises none), run to its end.
let turnSeq = 0;
async function agentTurn(convo, calls, allows = calls.filter((c) => !c.noCard).map(() => true), agent = 'example-lead') {
  const prompt = `outside the sandbox, turn ${++turnSeq}`;
  h.writeScenario([{ match: { agent, promptIncludes: prompt }, hooks: calls, turn: [{ text: 'Done.' }] }]);
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convo, agent, content: prompt });
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
// Claude Code refused `count` calls in `frames`, each with a permission_denied
// line for a call outside the sandbox, then an error result for that call.
function assertRefused(frames, count) {
  const denied = refusalsIn(frames);
  assert.strictEqual(denied.length, count, `Claude Code refused ${count} call(s)`);
  for (const d of denied) {
    assert.strictEqual(d.decision_reason_type, 'sandboxOverride', 'as a call outside the sandbox');
    const errorResult = (m) => m.type === 'user' && m.message && Array.isArray(m.message.content)
      && m.message.content.some((b) => b && b.type === 'tool_result' && b.tool_use_id === d.tool_use_id && b.is_error === true);
    assert.ok(frames.slice(frames.indexOf(d) + 1).some(errorResult), 'and then gave that call an error result');
  }
}

// ---------------------------------------------------------------------------
// Through the agent
// ---------------------------------------------------------------------------

test('a command outside the sandbox approved on its card runs, once, and nothing is said', async () => {
  routeExists();
  const convo = open(h.freshConvoId('override-runs'));
  const m = marker(convo);
  const frames = await agentTurn(convo, [outside(m.command)]);
  const checks = checksIn(convo);
  assert.strictEqual(checks.length, 1, 'Claude Code checked the call once');
  assert.deepStrictEqual(checks[0].answers, [ALLOW], 'and the hook allowed it');
  assert.strictEqual(m.runs(), 1, 'the command ran, once');
  assert.deepStrictEqual(refusalsIn(frames), [], 'nothing was refused');
  assert.deepStrictEqual(noticesIn(frames), [], 'and no notice for a command that ran');
});

test('the same command again after it ran, without its own approval, gets no decision and is refused', async () => {
  routeExists();
  const convo = open(h.freshConvoId('override-again'));
  const m = marker(convo);
  await agentTurn(convo, [outside(m.command)]);
  assert.strictEqual(m.runs(), 1, 'the approved call ran');
  const frames = await agentTurn(convo, [noCard(outside(m.command))], []);
  assert.deepStrictEqual(checksFor(m), [[ALLOW], [{}]], 'the hook gave the second call no decision');
  assertRefused(frames, 1);
  assert.strictEqual(m.runs(), 1, 'and it did not run');
});

test('two identical calls, each approved on its own card, each run once, and a third is refused', async () => {
  routeExists();
  const convo = open(h.freshConvoId('override-two'));
  const m = marker(convo);
  await agentTurn(convo, [outside(m.command), outside(m.command)]);
  assert.strictEqual(m.runs(), 2, 'each approved call ran once');
  const frames = await agentTurn(convo, [noCard(outside(m.command))], []);
  assert.deepStrictEqual(checksFor(m), [[ALLOW], [ALLOW], [{}]], 'the hook gave a third call no decision');
  assertRefused(frames, 1);
  assert.strictEqual(m.runs(), 2, 'and it did not run');
});

test('the next call outside the sandbox needs its own card: denied, it is refused before Claude Code asks', async () => {
  routeExists();
  const convo = open(h.freshConvoId('override-next'));
  const m = marker(convo);
  await agentTurn(convo, [outside(m.command), outside(m.command)], [true, false]);
  assert.deepStrictEqual(checksFor(m), [[ALLOW]], 'only the approved one reached the check');
  assert.strictEqual(m.runs(), 1, 'and only it ran');
});

test('a routine\'s identical call, its card approved, is refused with no decision', async () => {
  routeExists();
  const m = marker(h.freshConvoId('override-routine'));
  const command = m.command;
  const since = client.messages.length;
  const run = startRoutine('content-lead', { hooks: [outside(command)] }, 'override-routine');
  const { msg: card } = await client.waitFor((x) => x.type === 'control_request' && x.request && x.request.input && x.request.input.command === command, { since, label: 'the run\'s card', timeout: 15000 });
  client.send({ type: 'permission_response', requestId: card.request_id, conversationId: card._conversationId || '', allow: true, card: true });
  await finished(run);
  const checks = h.readHookAnswers().filter((a) => a.event === 'PermissionRequest' && a.command === command);
  assert.strictEqual(checks.length, 1, 'Claude Code checked the call');
  assert.deepStrictEqual(checks[0].answers, [{}], 'the hook was asked, and gave no decision');
  assert.strictEqual(checks[0].outcome, 'refused');
  assert.strictEqual(m.runs(), 0, 'and the command did not run');
});

// ---------------------------------------------------------------------------
// An approved grant asked for by anything but the approved call
// ---------------------------------------------------------------------------

// Each case's card is answered by hand, as the approved call's own, and its
// call is then put to Claude Code's check with no card of its own, in the
// conversation and as the agent the case names. The approved call follows
// through the same check. A case's command, if it ran, would add to the same
// file as the approved one.
for (const [label, misuse] of [
  ['from another conversation', (convo, m) => agentTurn(open(h.freshConvoId('override-other-convo')), [noCard(outside(m.command))], [])],
  ['by another agent in the same conversation', async (convo, m) => {
    const frames = await agentTurn(convo, [noCard(outside(m.command))], [], 'example-other');
    // The conversation's process is the other agent's until it ends.
    h.reapConvo(convo);
    return frames;
  }],
  ['with one character of the command changed', (convo, m) => agentTurn(convo, [noCard(outside(m.command.replace('ran', 'raN')))], [])],
  ['without the flag', (convo, m) => agentTurn(convo, [noCard({ tool: 'Bash', input: { command: m.command } })], [])],
  ['by another tool', (convo, m) => agentTurn(convo, [noCard(outside(m.command, 'PowerShell'))], [])],
]) {
  test(`an approved command asked for ${label} gets no decision and is refused, and the grant stays for the approved call`, async () => {
    routeExists();
    const convo = open(h.freshConvoId('override-asked'));
    const m = marker(convo);
    await approve(convo, outside(m.command));
    const frames = await misuse(convo, m);
    assert.deepStrictEqual(checksFor(m), [[{}]], 'the hook gave it no decision');
    assertRefused(frames, 1);
    assert.strictEqual(m.runs(), 0, 'and it did not run');
    await agentTurn(convo, [noCard(outside(m.command))], []);
    assert.deepStrictEqual(checksFor(m), [[{}], [ALLOW]], 'the approved call is still allowed');
    assert.strictEqual(m.runs(), 1, 'and runs, once');
  });
}

test('a grant asked for 59 seconds after its card is spent, and the command runs', async () => {
  const base = Date.now();
  clockAt(base);
  const convo = open(h.freshConvoId('override-59'));
  const m = marker(convo);
  await approve(convo, outside(m.command));
  clockAt(base + 59000);
  await agentTurn(convo, [noCard(outside(m.command))], []);
  assert.deepStrictEqual(checksFor(m), [[ALLOW]]);
  assert.strictEqual(m.runs(), 1, 'the command ran, once');
});

test('a grant asked for 60 seconds after its card gets no decision, and is gone', async () => {
  const base = Date.now();
  clockAt(base);
  const convo = open(h.freshConvoId('override-60'));
  const m = marker(convo);
  await approve(convo, outside(m.command));
  clockAt(base + 60000);
  assertRefused(await agentTurn(convo, [noCard(outside(m.command))], []), 1);
  clockAt(base + 1000);
  assertRefused(await agentTurn(convo, [noCard(outside(m.command))], []), 1);
  assert.deepStrictEqual(checksFor(m), [[{}], [{}]], 'no decision, and then nothing is left to spend');
  assert.strictEqual(m.runs(), 0, 'and the command never ran');
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
// sent for that conversation; `end` closes the process; `next` gives the
// same entry a new process, wired again, as a restart does.
const sent = [];
const watcher = { readyState: 1, send: (payload) => sent.push(JSON.parse(payload)) };
function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; };
  proc.stdin = { writable: true, write: () => true };
  return proc;
}
function reader(convo, agent = AGENT, entry = null) {
  const proc = fakeProcess();
  if (entry) entry.process = proc;
  else {
    entry = {
      process: proc, buffer: '', processId: `proc-${convo}`, agentId: agent, responseText: '', exited: false,
      resultSent: false, pendingAgentTool: null, toolCalls: [], turnStartTime: Date.now(),
    };
  }
  h.internal.wireProcessHandlers(entry, convo, null, {});
  return {
    entry,
    feed(lines) {
      h.internal.connectedClients.add(watcher);
      try { proc.stdout.emit('data', Buffer.from(fx.toLines(lines))); } finally { h.internal.connectedClients.delete(watcher); }
    },
    frames: () => sent.filter((m) => m._conversationId === convo),
    end() { proc.emit('exit', 0, null); proc.emit('close', 0, null); },
    next: () => reader(convo, agent, entry),
  };
}
// The ids of the shell calls the reader holds for `r`'s entry.
function keptIds(r) {
  assert.ok(r.entry._shellCalls instanceof Map, 'the reader keeps shell calls by id');
  return [...r.entry._shellCalls.keys()];
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

test('a refusal of an approved command is said however many shell calls streamed after it', async () => {
  const convo = open(h.freshConvoId('notice-many'));
  await approve(convo, outside());
  const r = reader(convo);
  const lines = [...call(1)];
  for (let i = 2; i <= 51; i++) lines.push(...call(i, outside(`echo hello ${i}`).input));
  r.feed(lines);
  r.feed([refused(1)]);
  assert.strictEqual(noticesIn(r.frames()).length, 1, 'the first call\'s refusal is said');
  r.end();
});

test('a refusal read after its call\'s error result is still said', async () => {
  const convo = open(h.freshConvoId('notice-after-result'));
  await approve(convo, outside());
  const r = reader(convo);
  r.feed([...call(1), fx.toolResult(1, 'Run outside of the sandbox', true), refused(1)]);
  assert.strictEqual(noticesIn(r.frames()).length, 1, 'the refusal is said');
  r.end();
});

test('a shell call is held until it ran, its refusal is read or its process ends, and no longer', () => {
  const convo = open(h.freshConvoId('notice-held'));
  const r = reader(convo);
  r.feed([...call(1), ...call(2), ...call(3), ...call(4, { command: 'echo hello' })]);
  assert.deepStrictEqual(keptIds(r), ['toolu_1', 'toolu_2', 'toolu_3', 'toolu_4'], 'each shell call is held by its id');
  r.feed([fx.toolResult(1, 'hello')]);
  assert.deepStrictEqual(keptIds(r), ['toolu_2', 'toolu_3', 'toolu_4'], 'a call that ran can no longer be refused');
  r.feed([refused(2)]);
  assert.deepStrictEqual(keptIds(r), ['toolu_3', 'toolu_4'], 'a call is refused once');
  r.feed([fx.toolResult(3, 'Run outside of the sandbox', true)]);
  assert.deepStrictEqual(keptIds(r), ['toolu_3', 'toolu_4'], 'an error result may still be followed by its refusal');
  r.end();
  assert.deepStrictEqual(keptIds(r), [], 'nothing is held once the process has ended');
});

test('a process that ends lets go of its own shell calls, and its successor\'s refusal is still said', async () => {
  const convo = open(h.freshConvoId('notice-successor'));
  await approve(convo, outside());
  const first = reader(convo);
  first.feed([...call(1, outside('echo hello 1').input)]);
  const second = first.next();
  second.feed([...call(2)]);
  first.end();
  assert.deepStrictEqual(keptIds(second), ['toolu_2'], 'only the ended process\'s call is let go');
  second.feed([refused(2)]);
  assert.strictEqual(noticesIn(second.frames()).length, 1, 'the successor\'s refusal is said');
  second.end();
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
