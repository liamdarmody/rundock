'use strict';
// A low-risk read gets the same answer whether or not a Rundock window is open.
//
// In Notes mode every shell command reaches the server's permission route.
// The window answers a low-risk read with no card (decidePermission in
// public/permissions.js), and the server used to leave that to it: with no
// window connected (Rundock on a server, a closed tab, a script driving the
// server) the read was stored, broadcast to nobody and refused at the
// timeout. Now the server asks the window's own question of the window's own
// module and answers the read itself, with no card.
//
// Everything here drives the real server with no window connected unless a
// test connects one on purpose, as a routine on a server would run: requests
// as the permission hook sends them, the real hook as the runtime runs it, and
// real routine runs started the way the scheduler starts them. What must
// still card is held to the same standard: each class waits and times out, as
// it did before the server answered anything.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const h = require('../helpers/harness.js');
const { agentFile, makeTempDir } = require('../helpers/workspace.js');
const ROUTER = require('../../lib/http-router.js');
const P = require('../../public/permissions.js');
const auth = require('../../lib/auth/index.js');
const { keychainVerdict } = require('../../scripts/code-mode-verdict.js');
const { refusalNotice } = require('../../scripts/refusal-notice.js');
const PS = require('../fixtures/powershell-reads.js');
const BASH_TABLES = require('../fixtures/bash-reads.js');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const AGENT = 'runner';
const TIMEOUT_MS = 1500;
const READ_ONLY = { allow: true, reason: 'read-only' };
const TIMED_OUT = { allow: false, reason: 'timeout' };

let outside;
// What the router did, seen from outside it: every message it sent toward a
// window, every request it stored to wait on a card, and every log line.
const broadcasts = [];
const filed = [];
const logged = [];
const undo = [];

before(async () => {
  await h.boot({
    agents: { runner: agentFile({ name: AGENT, type: 'specialist', order: 1 }) },
    env: { RUNDOCK_PERMISSION_TIMEOUT_MS: String(TIMEOUT_MS) },
  });
  h.internal.stopScheduler();
  outside = makeTempDir('read-only-outside-');
  fs.writeFileSync(path.join(outside, 'notes.md'), '# notes\n');
  // The harness's home is a temp folder: the runtime's credential file there.
  fs.mkdirSync(path.join(os.homedir(), '.claude'), { recursive: true });
  fs.writeFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), '{}');
  fs.writeFileSync(path.join(h.workspaceDir, 'notes.md'), '# notes\n');

  const prev = ROUTER.wireHttpRouterDeps({});
  ROUTER.wireHttpRouterDeps({ safeSend: (text) => { try { broadcasts.push(JSON.parse(text)); } catch (e) { /* not JSON */ } return prev.safeSend(text); } });
  undo.push(() => ROUTER.wireHttpRouterDeps({ safeSend: prev.safeSend }));
  const pending = h.internal.pendingPermissionRequests;
  const set = pending.set;
  pending.set = function (id, entry) { filed.push({ id, tool: entry.toolName, input: entry.toolInput, convo: entry.conversationId, run: entry.run }); return set.call(this, id, entry); };
  undo.push(() => { delete pending.set; });
  const log = console.log;
  console.log = (...args) => { logged.push(args.map(String).join(' ')); log.apply(console, args); };
  undo.push(() => { console.log = log; });
});
after(async () => {
  for (const fn of undo.reverse()) fn();
  await h.shutdown();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A window a test opened is gone before the next test starts, whether or not
// that test passed.
async function noWindow() {
  assert.ok(await h.waitUntil(() => h.internal.wss.clients.size === 0, { timeout: 3000 }), 'no window is connected');
}

// A request to the permission route exactly as the hook makes it, with the
// token the hook is handed. Resolves the status and the parsed answer;
// `abort` drops the connection, as an asker that went away does.
function ask(body, { convo = null, headers, url = '/api/permission-request' } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  let req;
  const reply = new Promise((resolve) => {
    req = http.request({
      host: '127.0.0.1', port: h.port, method: 'POST', path: url,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...(headers || h.hookHeaders(convo)) },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, body: json }); });
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.end(text);
  });
  return { reply, abort: () => req.destroy() };
}
const bashInput = (command) => ({ tool: 'Bash', input: { command } });
const bash = (command, convo, extra = {}) => ({ tool_name: 'Bash', tool_input: { command }, conversation_id: convo || '', ...extra });

// The real hook binary, spawned as the runtime spawns it, for a conversation.
function runHook(toolName, toolInput, { convo, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [HOOK], {
      cwd: h.workspaceDir,
      env: {
        ...process.env, RUNDOCK: '1', RUNDOCK_PORT: String(h.port), RUNDOCK_WORKSPACE: h.workspaceDir,
        RUNDOCK_CODE_MODE: '', RUNDOCK_CONVO_ID: convo, RUNDOCK_HOOK_TOKEN: h.hookToken(convo), ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('close', () => { try { resolve(JSON.parse(out).hookSpecificOutput || {}); } catch (e) { reject(new Error(`hook output unparseable: ${out}`)); } });
    proc.stdin.end(JSON.stringify({ tool_name: toolName, tool_input: toolInput, session_id: `s-${convo}`, cwd: h.workspaceDir }));
  });
}

const commandOf = (input) => (input && typeof input === 'object' ? input.command : undefined);
const cardsFor = (command) => broadcasts.filter((m) => m.type === 'control_request' && commandOf(m.request && m.request.input) === command);
const filedFor = (command) => filed.filter((f) => commandOf(f.input) === command);
const timedOut = (requestId) => broadcasts.some((m) => m.type === 'permission_timeout' && m.requestId === requestId);

function events() {
  const dir = path.join(h.workspaceDir, '.rundock', 'state');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => /^events-.*\.jsonl$/.test(n))
    .flatMap((n) => fs.readFileSync(path.join(dir, n), 'utf-8').split('\n').filter(Boolean))
    .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}
const readOnlyEvents = (conv) => events().filter((e) => e.e === 'permission' && e.conv === conv && e.d && e.d.reason === 'read-only');
// A routine's request has no conversation, so its events carry none.
const routineReadOnlyEvents = () => readOnlyEvents(undefined);

// ROUTINE RUNS, started the way the scheduler starts every run.
const runsDir = () => path.join(h.workspaceDir, '.rundock', 'runs');
const records = () => (fs.existsSync(runsDir()) ? fs.readdirSync(runsDir()) : [])
  .filter((n) => n.endsWith('.json'))
  .map((n) => JSON.parse(fs.readFileSync(path.join(runsDir(), n), 'utf-8')));
let seq = 0;
function startRoutine(rule) {
  const name = `read-routine-${++seq}`;
  const prompt = `routine body number ${seq}`;
  const key = `${AGENT}:${name}`;
  h.writeScenario([{ match: { agent: AGENT, promptIncludes: prompt }, turn: [{ text: 'done' }], ...rule }]);
  const agent = h.internal.discoverAgents().find((a) => a.id === AGENT);
  assert.ok(agent, 'the fixture agent is there');
  h.internal.executeRoutine(agent, { name, schedule: 'every day at 09:00', prompt }, key);
  return { name, key, record: () => records().find((r) => r.routine === name) };
}
async function finished(run, timeout = 15000) {
  assert.ok(await h.waitUntil(() => { const r = run.record(); return r && r.status !== 'running'; }, { timeout }), `${run.name} finished`);
  return run.record();
}
const answersOf = (record) => h.readHookAnswers().filter((a) => a.sessionId === record.sessionId).map((a) => a.answer && a.answer.hookSpecificOutput);
const linesFor = (routine) => logged.filter((l) => l.includes('Read-only, answered without a card') && l.includes(`routine "${routine}"`));

// The two reads the routine comparison saw refused for no reason but the
// missing window.
const REPORTED_READS = ['ls -la && ls -R context briefings prompts 2>/dev/null', 'ls context reviews 2>&1; head -5 context/company.md 2>&1'];

// ---------------------------------------------------------------------------
// A low-risk read is answered by the server with no window connected
// ---------------------------------------------------------------------------

describe('a low-risk read is answered by the server, with no window', () => {
  test('a conversation\'s read is answered at once: no card, nothing stored to wait, nothing for a timeout to deny', async () => {
    await noWindow();
    const convo = 'ro-conversation';
    for (const command of REPORTED_READS) {
      const { reply } = ask(bash(command, convo), { convo });
      const r = await reply;
      assert.strictEqual(r.status, 200, command);
      assert.deepStrictEqual(r.body, READ_ONLY, `the server answers it: ${command}`);
      assert.deepStrictEqual(cardsFor(command), [], `no card was broadcast: ${command}`);
      assert.deepStrictEqual(filedFor(command), [], `it never waited on a card: ${command}`);
    }
    // And through the real hook, as the runtime runs it.
    const out = await runHook('Bash', { command: 'head -5 notes.md' }, { convo });
    assert.strictEqual(out.permissionDecision, 'allow', JSON.stringify(out));
    assert.deepStrictEqual(filedFor('head -5 notes.md'), []);
    // Nothing is left for a timer: past the timeout, no read was denied.
    await h.delay(TIMEOUT_MS + 300);
    assert.ok(!broadcasts.some((m) => m.type === 'permission_timeout' && m._conversationId === convo), 'no timeout fired for any of them');
  });

  test('a routine run\'s reads are answered at once, through the real hook, and its record counts none of them', async () => {
    await noWindow();
    // Tests in this file run one after another, so every routine event
    // recorded from here to the end of the run is this run's.
    const before = routineReadOnlyEvents().length;
    const run = startRoutine({ hooks: REPORTED_READS.map((command) => ({ tool: 'Bash', input: { command } })) });
    const record = await finished(run);
    assert.strictEqual(record.status, 'succeeded', JSON.stringify(record));
    const answers = answersOf(record);
    assert.strictEqual(answers.length, REPORTED_READS.length, 'every read was put to the hook');
    for (const a of answers) assert.strictEqual(a && a.permissionDecision, 'allow', JSON.stringify(a));
    for (const command of REPORTED_READS) {
      assert.deepStrictEqual(cardsFor(command).filter((m) => m._run && m._run.id === record.id), [], `no card: ${command}`);
      assert.deepStrictEqual(filedFor(command).filter((f) => f.run && f.run.id === record.id), [], `never waited: ${command}`);
    }
    assert.strictEqual(record.refusedCards, undefined, 'the run\'s record counts no refused card');
    assert.strictEqual(linesFor(run.name).length, REPORTED_READS.length, 'the server log names the routine for each read it answered');
    assert.ok(linesFor(run.name).every((l) => l.includes(`run=${record.id}`)), 'and the run');
    // One permission event for each read the run made, an allow for the
    // read-only reason, and no more once the run has ended.
    assert.ok(await h.waitUntil(() => routineReadOnlyEvents().length - before >= REPORTED_READS.length, { timeout: 3000 }), 'the events are written');
    await h.delay(200);
    const recorded = routineReadOnlyEvents().slice(before);
    assert.strictEqual(recorded.length, REPORTED_READS.length, `one event for each read: ${JSON.stringify(recorded)}`);
    for (const e of recorded) assert.deepStrictEqual(e.d, { tool: 'Bash', decision: 'allow', reason: 'read-only' });
  });
});

// ---------------------------------------------------------------------------
// Everything that cards still cards with no window
// ---------------------------------------------------------------------------

describe('everything graded, and everything not low risk, still cards with no window', { concurrency: true }, () => {
  // Each through the real hook, so each carries exactly what the hook sends
  // for it, and each read where a read is possible, so the card cannot be put
  // down to the command's own risk.
  const zshrc = '~/.zshrc';
  const CLASSES = [
    ['an uncovered crossing', () => bashInput(`cat ${path.join(outside, 'notes.md')}`), (req) => req.boundary === true && req.crossings.length === 1 && !req.crossings[0].secret, {}],
    // A file tool's write to an answer file, and a shell command's, which the
    // hook tags on its crossing instead.
    ['an answer-file write by a file tool', () => ({ tool: 'Write', input: { file_path: path.join(h.workspaceDir, '.rundock', 'permissions.json'), content: '{"allow":["Bash"]}' } }), (req) => req.answer_file === true, {}],
    ['an answer-file write by a shell command', () => bashInput('echo \'{"allow":["Bash"]}\' > .rundock/permissions.json'), (req) => req.boundary === true && req.crossings.some((c) => c.answerFile === true), {}],
    ['a shell startup file', () => bashInput(`echo x >> ${zshrc}`), (req) => req.startup_file === zshrc, {}],
    ['a Keychain line', () => bashInput('security find-generic-password -w -s example-service'), (req) => !!req.code_mode_verdict && req.code_mode_verdict.reason === 'keychain', { RUNDOCK_TEST_SEAMS: '1', RUNDOCK_TEST_PLATFORM: 'darwin' }],
    ['a secrets-tier path', () => bashInput(`cat ${path.join(os.homedir(), '.claude', '.credentials.json')}`), (req) => req.boundary === true && req.crossings.some((c) => c.secret === true), {}],
    ['a medium command', () => bashInput('npm run build'), (req) => !req.boundary && !req.answer_file && !req.startup_file && !req.code_mode_verdict, {}],
    ['a high command', () => bashInput('rm -rf build'), (req) => !req.boundary && !req.answer_file && !req.startup_file && !req.code_mode_verdict, {}],
  ];
  for (const [label, requestFor, graded, env] of CLASSES) {
    test(`${label} waits for a card and times out, as before`, async () => {
      await noWindow();
      const { tool, input } = requestFor();
      const convo = `ro-class-${label.replace(/\W+/g, '-')}`;
      const out = await runHook(tool, input, { convo, env });
      assert.strictEqual(out.permissionDecision, 'deny', `${label}: ${JSON.stringify(out)}`);
      assert.strictEqual(out.permissionDecisionReason, refusalNotice('timeout', tool, { unattended: false }), `${label}: refused as unanswered`);
      const cards = broadcasts.filter((m) => m.type === 'control_request' && m._conversationId === convo);
      assert.strictEqual(cards.length, 1, `${label}: one card was raised`);
      assert.ok(graded(cards[0].request), `${label}: graded as the hook grades it: ${JSON.stringify(cards[0].request)}`);
      assert.deepStrictEqual(filed.filter((f) => f.convo === convo).map((f) => f.id), [cards[0].request_id], `${label}: it waited on the card`);
      assert.ok(timedOut(cards[0].request_id), `${label}: and it timed out`);
      assert.ok(!readOnlyEvents(convo).length, `${label}: never recorded as a read`);
    });
  }

  // EACH GRADE ALONE KEEPS THE CARD, on a command the read-only definition
  // reads as a read. The hook's grade is the word on these, never the
  // command's: a definition that is wrong about a command must not spend a
  // card the hook asked for. Shaped as the hook shapes each field.
  const outsideFile = () => path.join(outside, 'notes.md');
  const GRADES = [
    ['boundary', () => `cat ${outsideFile()}`, () => ({ boundary: true, resolved_path: outsideFile(), grant_dir: outside, grantable: true, crossings: [{ path: outsideFile(), grantDir: outside }] })],
    ['answer_file', () => 'cat .rundock/permissions.json', () => ({ answer_file: true, resolved_path: path.join(h.workspaceDir, '.rundock', 'permissions.json'), grant_dir: null })],
    ['startup_file', () => 'head -5 notes.md', () => ({ startup_file: zshrc })],
    ['code_mode_verdict', () => 'tail notes.md', () => ({ code_mode_verdict: keychainVerdict({ toolName: 'Bash', command: 'security dump-keychain', cwd: h.workspaceDir, workspaceRoot: h.workspaceDir, extraDirs: [], keychainPlatform: 'darwin' }) })],
  ];
  for (const [field, commandFor, fields] of GRADES) {
    test(`a request carrying \`${field}\` cards even when its command reads`, async () => {
      await noWindow();
      const command = commandFor();
      const extra = fields();
      assert.ok(extra[field] !== undefined, `the ${field} grade is set`);
      assert.strictEqual(P.classifyRisk('Bash', { command }), 'low', `the command alone would be answered: ${command}`);
      const convo = `ro-grade-${field}`;
      const r = await ask(bash(command, convo, extra), { convo }).reply;
      assert.deepStrictEqual(r.body, TIMED_OUT, `${field}: waited and timed out`);
      assert.strictEqual(filedFor(command).filter((f) => f.convo === convo).length, 1, `${field}: it waited on a card`);
      assert.ok(cardsFor(command).some((m) => m._conversationId === convo), `${field}: a card was raised`);
    });
  }
});

// ---------------------------------------------------------------------------
// One decision, no copy
// ---------------------------------------------------------------------------

describe('the server and the window give the same answer', () => {
  // Every command in the shared read-only tables, each file read whole: a
  // table added to either, or a command added to one, is in this test with no
  // change here. A table of commands that name a place is a function of that
  // place, given a folder inside the workspace. A labelled table, each entry a
  // label and its command or commands, is read for its commands.
  const commandsOf = (value) => {
    if (typeof value === 'string') return [value];
    if (typeof value === 'function') return commandsOf(value('notes'));
    if (!Array.isArray(value)) return [];
    const labelled = value.length > 0 && value.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string');
    return labelled ? value.flatMap(([, commands]) => commandsOf(commands)) : value.flatMap(commandsOf);
  };
  // And the commands this file sends elsewhere, with a few of each kind no
  // table above holds.
  const OWN = [...REPORTED_READS, 'head -5 notes.md', 'wc -l notes.md', 'echo hi > out.txt', 'ls; rm -rf x', 'ls $(rm x)', 'ls `rm x`'];
  const BASH = [...Object.values(BASH_TABLES).flatMap(commandsOf), ...OWN];
  const POWERSHELL = Object.values(PS).flatMap(commandsOf);
  const ROWS = [
    ...[...new Set(BASH)].map((command) => ['Bash', { command }]),
    ...[...new Set(POWERSHELL)].map((command) => ['PowerShell', { command }]),
    ['Write', { file_path: 'notes.md', content: 'x' }],
    ['mcp__example__send_email', { to: 'someone' }],
  ];

  // What the window decides, with no saved answers.
  const windowSays = (tool, input) => {
    const d = P.decidePermission(P.classifyRisk(tool, input), P.toolAllowKey(tool, input), new Set());
    return d.action === 'allow' ? 'allow' : 'card';
  };
  // What the server does with the same request: answers it, or stores it to
  // wait on a card, which is then dropped as an asker that went away.
  async function serverSays(tool, input) {
    const mark = filed.length;
    const convo = 'ro-table';
    const { reply, abort } = ask({ tool_name: tool, tool_input: input, conversation_id: convo }, { convo });
    let answered = null;
    reply.then((r) => { answered = r; });
    assert.ok(await h.waitUntil(() => answered || filed.slice(mark).some((f) => f.convo === convo), { timeout: 5000, interval: 2 }), `${tool}: ${JSON.stringify(input)}`);
    if (answered) return answered.body && answered.body.allow === true && answered.body.reason === 'read-only' ? 'allow' : `answered ${JSON.stringify(answered.body)}`;
    abort();
    await reply;
    return 'card';
  }

  test('every row of the tables: the server answers exactly what the window allows, and cards the rest', async () => {
    await noWindow();
    const disagree = [];
    const count = { allow: 0, card: 0 };
    for (const [tool, input] of ROWS) {
      const expected = windowSays(tool, input);
      const got = await serverSays(tool, input);
      count[expected]++;
      if (got !== expected) disagree.push(`${tool} ${JSON.stringify(input).slice(0, 120)}: window ${expected}, server ${got}`);
    }
    assert.deepStrictEqual(disagree, [], `${disagree.length} of ${ROWS.length} rows disagree`);
    assert.ok(count.allow >= 20 && count.card >= 60, `the tables hold both kinds: ${JSON.stringify(count)}`);
  });
});

// ---------------------------------------------------------------------------
// The answer can't be spent elsewhere
// ---------------------------------------------------------------------------

// A socket made with no launch key: resolves whether it opened.
function socketWithout(messages, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}`, { headers });
    let opened = false;
    let status = null;
    const done = () => resolve({ opened, status });
    ws.on('open', () => { opened = true; for (const m of messages) ws.send(JSON.stringify(m)); setTimeout(() => { ws.close(); done(); }, 300); });
    ws.on('unexpected-response', (_req, res) => { status = res.statusCode; res.resume(); done(); });
    ws.on('error', () => { if (!opened) done(); });
  });
}

describe('a card is answered only by a window with the launch key', () => {
  test('a hook token answers no card: not over a socket, wherever it is offered, and not over HTTP', async () => {
    await noWindow();
    const convo = 'ro-spend';
    const token = h.hookToken(convo);
    const waiting = ask(bash('npm run spend', convo), { convo });
    assert.ok(await h.waitUntil(() => filedFor('npm run spend').length === 1), 'the card is waiting');
    const [{ id: requestId }] = filedFor('npm run spend');
    const answer = { type: 'permission_response', requestId, conversationId: convo, allow: true, card: true };

    for (const headers of [
      { [auth.HOOK_HEADER]: token },
      { [auth.SESSION_HEADER]: token },
      { 'Sec-WebSocket-Protocol': `${auth.WS_PROTOCOL}, ${auth.WS_SESSION_PREFIX}${token}` },
    ]) {
      const res = await socketWithout([answer], headers);
      assert.strictEqual(res.opened, false, `refused at the door: ${Object.keys(headers)[0]}`);
      assert.strictEqual(res.status, 401);
    }

    // POSTed to the hook's own route, the answer is a request of its own, with
    // no tool to grade, and answers nothing.
    const mark = filed.length;
    const posted = ask(answer, { convo });
    assert.ok(await h.waitUntil(() => filed.slice(mark).some((f) => f.convo === convo)), 'filed as a request of its own');
    assert.ok(!filed.slice(mark).some((f) => f.id === requestId));
    posted.abort();
    assert.ok(!(await posted.reply).body, 'and given no allow');
    // Every other route refuses a hook token outright.
    for (const url of ['/api/permission-response', '/api/permission', '/api/agent-notice?check=1', '/api/tool-allows']) {
      const r = await ask(answer, { convo, url }).reply;
      assert.strictEqual(r.status, 401, url);
    }

    assert.ok(h.internal.pendingPermissionRequests.has(requestId), 'the card still waits for a person');
    assert.deepStrictEqual((await waiting.reply).body, TIMED_OUT, 'and, with nobody to answer it, times out');
  });

  test('a read whose token names nothing going is refused, and given no allow', async () => {
    await noWindow();
    for (const headers of [{}, { [auth.HOOK_HEADER]: 'not-a-token-rundock-issued' }, h.hookHeaders(null)]) {
      const r = await ask(bash('ls -la'), { headers }).reply;
      assert.strictEqual(r.status, 401, JSON.stringify(Object.keys(headers)));
      assert.notStrictEqual(r.body && r.body.allow, true);
    }
  });

  test('a read whose routine run ended before its body arrived is refused as before, with no allow', async () => {
    await noWindow();
    const release = path.join(makeTempDir('read-only-release-'), 'go');
    const run = startRoutine({ untilFile: release });
    assert.ok(await h.waitUntil(() => { const r = run.record(); return r && h.readInvocations().some((i) => i.argv.includes(r.sessionId)); }), 'the run is going');
    const record = run.record();
    const token = h.readInvocations().find((i) => i.argv.includes(record.sessionId)).env.RUNDOCK_HOOK_TOKEN;
    assert.ok(token, 'the run was started with its own token');

    // The body is held back until the run has ended.
    const text = JSON.stringify(bash('ls -la'));
    let looked = false;
    const prev = ROUTER.wireHttpRouterDeps({});
    ROUTER.wireHttpRouterDeps({ routineRun: (id) => { looked = true; return prev.routineRun(id); } });
    let req;
    const reply = new Promise((resolve) => {
      req = http.request({
        host: '127.0.0.1', port: h.port, path: '/api/permission-request', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), [auth.HOOK_HEADER]: token },
      }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) })); });
      req.on('error', (e) => resolve({ error: e.code }));
    });
    try {
      req.write(text.slice(0, 10));
      assert.ok(await h.waitUntil(() => looked), 'the route looked the token up while the run was going');
    } finally { ROUTER.wireHttpRouterDeps({ routineRun: prev.routineRun }); }
    fs.writeFileSync(release, '');
    await finished(run);
    req.end(text.slice(10));
    const r = await reply;
    assert.strictEqual(r.status, 401, JSON.stringify(r));
    assert.notStrictEqual(r.body && r.body.allow, true, 'no allow');
    assert.strictEqual(linesFor(run.name).length, 0, 'and nothing was answered for the routine');
  });
});

// ---------------------------------------------------------------------------
// The allow is recorded and not counted
// ---------------------------------------------------------------------------

describe('the allow is recorded', () => {
  test('the event log records the allow with its reason, and the server log has one line for it', async () => {
    await noWindow();
    const convo = 'ro-recorded';
    const r = await ask(bash('wc -l notes.md', convo), { convo }).reply;
    assert.deepStrictEqual(r.body, READ_ONLY);
    assert.ok(await h.waitUntil(() => readOnlyEvents(convo).length === 1), 'recorded');
    assert.deepStrictEqual(readOnlyEvents(convo)[0].d, { tool: 'Bash', decision: 'allow', reason: 'read-only' });
    assert.strictEqual(logged.filter((l) => l.includes('Read-only, answered without a card') && l.includes(`convo=${convo}`)).length, 1);
  });
});

// ---------------------------------------------------------------------------
// The five sequences
// ---------------------------------------------------------------------------

describe('the five sequences', () => {
  test('1. the inverse action: in one routine run, a read is answered at once and a medium command right after it waits and times out', async () => {
    await noWindow();
    const read = 'ls context 2>/dev/null';
    const medium = 'npm run sequence-one';
    const run = startRoutine({ hooks: [{ tool: 'Bash', input: { command: read } }, { tool: 'Bash', input: { command: medium } }] });
    const record = await finished(run);
    const [first, second] = answersOf(record);
    assert.strictEqual(first && first.permissionDecision, 'allow', `the read: ${JSON.stringify(first)}`);
    assert.strictEqual(second && second.permissionDecision, 'deny', `the medium command: ${JSON.stringify(second)}`);
    assert.strictEqual(second.permissionDecisionReason, refusalNotice('timeout', 'Bash', { unattended: true }), 'refused as unanswered');
    assert.deepStrictEqual(filedFor(read).filter((f) => f.run && f.run.id === record.id), [], 'the read never waited');
    const [card] = cardsFor(medium);
    assert.ok(card && card._run && card._run.id === record.id, 'the medium command raised the run\'s card');
    assert.ok(timedOut(card.request_id), 'which timed out');
    assert.strictEqual(record.refusedCards, 1, 'the run counts the one refused card, not the read');
    assert.strictEqual(linesFor(run.name).length, 1, 'one line names the routine for the read it answered');
  });

  test('2. the undo: a person denies a card for a write, and the next plain read is answered at once', async () => {
    const convo = 'ro-undo';
    const write = 'echo draft > draft.md';
    const window = await h.connect();
    try {
      const since = window.messages.length;
      const asked = ask(bash(write, convo), { convo });
      const { msg: card } = await window.waitFor((m) => m.type === 'control_request' && commandOf(m.request.input) === write, { since, label: 'the write\'s card' });
      window.send({ type: 'permission_response', requestId: card.request_id, conversationId: convo, allow: false, card: true });
      assert.deepStrictEqual((await asked.reply).body, { allow: false }, 'the person denied it');

      const read = 'cat draft.md';
      const readSince = window.messages.length;
      assert.deepStrictEqual((await ask(bash(read, convo), { convo }).reply).body, READ_ONLY, 'the next read is answered by the server');
      await h.delay(200);
      assert.ok(!window.messages.slice(readSince).some((m) => m.type === 'control_request'), 'and never reached the window');
    } finally {
      window.close();
    }
    await noWindow();
    assert.deepStrictEqual((await ask(bash('cat draft.md', convo), { convo }).reply).body, READ_ONLY, 'with no window, the same');
    // Nothing carries over the other way either: the write asks again.
    const again = ask(bash(write, convo), { convo });
    assert.ok(await h.waitUntil(() => filedFor(write).length === 2), 'the write waits on a card again');
    again.abort();
    await again.reply;
  });

  test('3. the retry: the same read sent twice is answered at once both times, and recorded twice', async () => {
    await noWindow();
    const convo = 'ro-retry';
    const command = 'grep -r notes .';
    for (let i = 0; i < 2; i++) {
      assert.deepStrictEqual((await ask(bash(command, convo), { convo }).reply).body, READ_ONLY, `send ${i + 1}`);
    }
    assert.deepStrictEqual(filedFor(command), [], 'neither waited');
    assert.ok(await h.waitUntil(() => readOnlyEvents(convo).length === 2), `recorded twice: ${readOnlyEvents(convo).length}`);
    assert.strictEqual(logged.filter((l) => l.includes('Read-only, answered without a card') && l.includes(`convo=${convo}`)).length, 2);
  });

  test('4. the most common next step: a window that connects while a card waits is sent it, and the reads after are answered without reaching it', async () => {
    await noWindow();
    const convo = 'ro-next';
    const medium = 'npm run sequence-four';
    const asked = ask(bash(medium, convo), { convo });
    assert.ok(await h.waitUntil(() => filedFor(medium).length === 1), 'the card waits');
    const [{ id: requestId }] = filedFor(medium);
    const window = await h.connect();
    try {
      await window.waitFor((m) => m.type === 'control_request' && m.request_id === requestId, { label: 'the waiting card, replayed' });
      const { msg: snap } = await window.waitFor((m) => m.type === 'pending_permissions', { label: 'the pending snapshot' });
      assert.deepStrictEqual(snap.requestIds, [requestId], 'it is the one request waiting');
      const since = window.messages.length;
      for (const command of ['ls -la', 'head -5 notes.md']) {
        assert.deepStrictEqual((await ask(bash(command, convo), { convo }).reply).body, READ_ONLY, command);
        assert.deepStrictEqual(filedFor(command).filter((f) => f.convo === convo), [], `${command} never waited`);
      }
      await h.delay(200);
      assert.ok(!window.messages.slice(since).some((m) => m.type === 'control_request'), 'the reads never reached the window');
      window.send({ type: 'permission_response', requestId, conversationId: convo, allow: false, card: true });
      assert.deepStrictEqual((await asked.reply).body, { allow: false }, 'the window answers the card it was sent');
    } finally {
      window.close();
    }
    await noWindow();
  });
});

// ---------------------------------------------------------------------------
// The fifth sequence: the control failing
// ---------------------------------------------------------------------------

describe('the branch fails closed', () => {
  const permissionsKey = require.resolve('../../public/permissions.js');

  // A read sent while `force` holds, then put back. The hook still gets the
  // card path's reply: stored, broadcast, timed out. Never an allow, and
  // never a dropped connection.
  async function forced(label, force) {
    await noWindow();
    const convo = `ro-forced-${label}`;
    const command = `ls -la ${label}`;
    const restore = force();
    let r;
    try {
      r = await ask(bash(command, convo), { convo }).reply;
    } finally { restore(); }
    assert.strictEqual(r.status, 200, `${label}: the hook got a reply: ${JSON.stringify(r)}`);
    assert.deepStrictEqual(r.body, TIMED_OUT, `${label}: the card path's reply`);
    assert.strictEqual(filedFor(command).length, 1, `${label}: it waited on a card`);
    const [card] = cardsFor(command);
    assert.ok(card && timedOut(card.request_id), `${label}: a card was raised and timed out`);
    assert.deepStrictEqual(readOnlyEvents(convo), [], `${label}: never recorded as answered`);
    // The control is back: the same read is answered again.
    assert.deepStrictEqual((await ask(bash(command, convo), { convo }).reply).body, READ_ONLY, `${label}: answered again once restored`);
  }
  const replace = (name, fn) => () => { const was = P[name]; P[name] = fn; return () => { P[name] = was; }; };

  test('classifyRisk throwing', () => forced('classify', replace('classifyRisk', () => { throw new Error('forced: classifyRisk'); })));
  test('decidePermission throwing', () => forced('decide', replace('decidePermission', () => { throw new Error('forced: decidePermission'); })));
  test('the module failing to load', () => forced('load', () => {
    const was = require.cache[permissionsKey];
    const broken = { id: permissionsKey, filename: permissionsKey, loaded: true, children: [], paths: [] };
    Object.defineProperty(broken, 'exports', { get() { throw new Error('forced: the decision module failed to load'); } });
    require.cache[permissionsKey] = broken;
    assert.throws(() => require(permissionsKey), /failed to load/, 'the module cannot be loaded');
    return () => { require.cache[permissionsKey] = was; };
  }));
});
