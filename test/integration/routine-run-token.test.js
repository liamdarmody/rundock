'use strict';
// Integration: a routine run's cards are its own, by the hook token it was
// started with, end to end.
//
// Each run is driven for real: the scheduler starts the stub runtime with the
// environment a routine is given, and the stub runs Rundock's real permission
// hook as its own process, carrying the run's token, against the real server.
// Nothing in the request decides which run a card belongs to: a call naming
// another live run's session, a Task subagent's call, and a call from a
// `claude` started in the run's own shell (with a session of its own, or none)
// are each the run's, and counted on it. A token whose run has ended is
// refused as unknown, and changes no count, even on a request that began while
// the run was going and held its body back until after. A card still open
// when its run ends answers its asker, and never writes to the closed record.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const h = require('../helpers/harness.js');
const ROUTER = require('../../lib/http-router.js');
const schedulerLib = require('../../lib/scheduler.js');
const { handlePermissionResponse } = require('../../lib/protocol/handlers/process-control.js');
const { agentFile, makeTempDir } = require('../helpers/workspace.js');
const { refusalNotice } = require('../../scripts/refusal-notice.js');

const KEEPER = 'keeper';
const LEDGER = 'ledger';
let client, outside;

before(async () => {
  await h.boot({
    agents: {
      keeper: agentFile({ name: KEEPER, type: 'specialist', order: 1 }),
      ledger: agentFile({ name: LEDGER, type: 'specialist', order: 2 }),
    },
  });
  h.internal.stopScheduler();
  outside = makeTempDir('run-token-outside-');
  fs.writeFileSync(path.join(outside, 'notes.md'), '# notes\n');
  client = await h.connect();
});
after(async () => h.shutdown());

// A read outside the workspace, which always raises a card. `extra` sets
// fields of the hook's payload; one set to null is left out.
const readOutside = (extra) => ({ tool: 'Bash', input: { command: `cat ${path.join(outside, 'notes.md')}` }, ...(extra ? { extra } : {}) });
const runsDir = () => path.join(h.workspaceDir, '.rundock', 'runs');
const records = () => (fs.existsSync(runsDir()) ? fs.readdirSync(runsDir()) : [])
  .filter((n) => n.endsWith('.json'))
  .map((name) => JSON.parse(fs.readFileSync(path.join(runsDir(), name), 'utf-8')));
const recordOf = (name) => records().find((r) => r.routine === name);
// The stub's own invocation for a run, found by the session the run passed it.
const tokenOf = (record) => {
  const inv = h.readInvocations().find((i) => i.argv.includes(record.sessionId));
  return inv && inv.env.RUNDOCK_HOOK_TOKEN;
};
const UNATTENDED_DENIED = refusalNotice('denied', 'Bash', { unattended: true });
const LATE = { tool_name: 'Bash', tool_input: { command: 'sh late.sh' } };
const permissionRequest = (token, body = LATE) => fetch(`http://127.0.0.1:${h.port}/api/permission-request`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rundock-Hook-Token': token }, body: JSON.stringify(body),
});
const answer = (card, allow) => client.send({ type: 'permission_response', requestId: card.request_id, conversationId: '', allow, card: true });
const recordById = (id) => records().find((r) => r.id === id);
const recordFile = (id) => fs.readdirSync(runsDir()).map((n) => path.join(runsDir(), n)).find((p) => p.endsWith('.json') && JSON.parse(fs.readFileSync(p, 'utf-8')).id === id);

// A request sent with a run's token whose body is held back: its headers and
// the start of its body go at once, the rest when `finish` is called. Resolves
// once the route has looked the token up, so the run was going when it began.
async function held(token, body = LATE) {
  const text = JSON.stringify(body);
  let looked = false;
  const prev = ROUTER.wireHttpRouterDeps({});
  ROUTER.wireHttpRouterDeps({ routineRun: (id) => { looked = true; return prev.routineRun(id); } });
  try {
    const req = http.request({
      host: '127.0.0.1', port: h.port, path: '/api/permission-request', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'X-Rundock-Hook-Token': token },
    });
    const answered = new Promise((resolve) => {
      req.on('response', (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) })); });
      req.on('error', (e) => resolve({ error: e.code }));
    });
    req.write(text.slice(0, 10));
    if (!await h.waitUntil(() => looked)) req.destroy();
    assert.ok(looked, 'the route looked the token up while the run was going');
    return { answered, finish: () => req.end(text.slice(10)), abort: () => req.destroy() };
  } finally { ROUTER.wireHttpRouterDeps({ routineRun: prev.routineRun }); }
}

async function save(agentId, name, prompt) {
  client.send({ type: 'save_routine', agentId, routine: { name, schedule: 'every day at 07:00', prompt, runOn: 'local' } });
  await client.waitFor((m) => m.type === 'routine_saved' && m.name === name, { label: `${name} saved` });
}
function press(agentId, name) {
  client.send({ type: 'run_routine_now', agentId, name, occurrence: 0 });
}
const closed = (name) => h.waitUntil(() => { const r = recordOf(name); return r && r.status !== 'running'; }, { timeout: 15000 });

test('a card raised with one run\'s token, naming another live run\'s session, is the first run\'s and names its routine and agent', async () => {
  // Run B is going, held open by a card of its own until run A's card is filed.
  const holds = { match: { agent: LEDGER, promptIncludes: 'b holds' }, hooks: [readOutside()], turn: [{ text: 'B done.' }] };
  h.writeScenario([holds]);
  await save(LEDGER, 'token-b', 'b holds');
  let since = client.messages.length;
  press(LEDGER, 'token-b');
  const { msg: hold } = await client.waitFor((m) => m.type === 'control_request' && m._run, { since, label: 'run B\'s own card, which holds it open' });
  const b = recordById(hold._run.id);

  // Run A asks, its hook naming run B's session in the request. Every request
  // the route receives is kept as it arrived, token and body.
  const received = [];
  const keep = (req) => {
    if (req.url !== '/api/permission-request') return;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { try { received.push({ token: req.headers['x-rundock-hook-token'], body: JSON.parse(body) }); } catch (e) { /* not JSON */ } });
  };
  h.internal.server.on('request', keep);
  let card;
  try {
    h.writeScenario([holds, { match: { agent: KEEPER, promptIncludes: 'a asks' }, hooks: [readOutside({ session_id: b.sessionId })], turn: [{ text: 'A done.' }] }]);
    await save(KEEPER, 'token-a', 'a asks');
    since = client.messages.length;
    press(KEEPER, 'token-a');
    ({ msg: card } = await client.waitFor((m) => m.type === 'control_request' && m.request_id !== hold.request_id, { since, label: 'run A\'s card' }));
  } finally { h.internal.server.off('request', keep); }
  const a = recordOf('token-a');

  // At the moment run A's card is filed, both runs are going, and the request
  // it came from named run B's own session.
  const going = schedulerLib.runningRuns().map((r) => r.id);
  assert.ok(going.includes(a.id) && going.includes(b.id), 'both runs are going');
  assert.strictEqual(recordById(b.id).status, 'running');
  const asked = received.filter((x) => x.token === tokenOf(a));
  assert.deepStrictEqual(asked.map((x) => x.body.session_id), [b.sessionId], 'run A\'s request named run B\'s own session');
  assert.notStrictEqual(a.sessionId, b.sessionId);
  assert.deepStrictEqual(card._run, { id: a.id, routine: 'token-a', agent: KEEPER }, 'yet the card is run A\'s, naming run A\'s routine and agent');
  assert.strictEqual(card._conversationId, '');

  // Run B is let go only now, its own card approved, and run A's card refused.
  answer(hold, true);
  answer(card, false);
  assert.ok(await h.waitUntil(() => h.readHookAnswers().some((x) => x.agent === KEEPER && x.sentSession === b.sessionId)), 'run A\'s hook was answered');
  const told = h.readHookAnswers().find((x) => x.agent === KEEPER && x.sentSession === b.sessionId);
  assert.strictEqual(told.answer.hookSpecificOutput.permissionDecisionReason, UNATTENDED_DENIED);
  assert.ok(await closed('token-a') && await closed('token-b'), 'both runs end');
  assert.strictEqual(recordOf('token-a').refusedCards, 1, 'the refusal is counted on run A');
  assert.strictEqual('refusedCards' in recordOf('token-b'), false, 'and run B, whose session it named, counts none');

  const [tokenA, tokenB] = [tokenOf(a), tokenOf(b)];
  assert.ok(tokenA && tokenB && tokenA !== tokenB, 'each run was started with a token of its own');
});

test('a run\'s token, once its record has closed, is refused as unknown and files nothing', async () => {
  h.writeScenario([{ match: { agent: KEEPER, promptIncludes: 'ends after one refusal' }, hooks: [readOutside()], turn: [{ text: 'Done.' }] }]);
  await save(KEEPER, 'token-ended', 'ends after one refusal');
  const pressed = client.messages.length;
  press(KEEPER, 'token-ended');
  const { msg: first } = await client.waitFor((m) => m.type === 'control_request' && m._run, { since: pressed, label: 'the run\'s card' });
  client.send({ type: 'permission_response', requestId: first.request_id, conversationId: '', allow: false, card: true });
  assert.ok(await closed('token-ended'), 'the run ends');
  const ended = recordOf('token-ended');
  assert.strictEqual(ended.refusedCards, 1);
  const token = tokenOf(ended);
  assert.ok(token, 'the run was started with a token');

  const since = client.messages.length;
  const res = await fetch(`http://127.0.0.1:${h.port}/api/permission-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Rundock-Hook-Token': token },
    body: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'sh late.sh' }, session_id: ended.sessionId, conversation_id: '' }),
  });
  assert.strictEqual(res.status, 401, 'refused as a token Rundock never issued is');
  await h.delay(200);
  assert.deepStrictEqual(client.messages.slice(since).filter((m) => m.type === 'control_request'), [], 'no card');
  assert.deepStrictEqual(recordOf('token-ended'), ended, 'and the record is as it closed, its count untouched');
});

// MEASURED, NOT ASSUMED. test/tools/claude-cli-run-token-probe.js ran the
// real CLI as a routine run that started a subagent and a `claude -p` from its
// shell, and recorded which token and which session each hook request carried
// (test/fixtures/claude-cli-run-token.json). The stub stands in for both by
// running the hook in its own environment, so it is made to send the sessions
// the record says each sends, and what it sent is held to the record after
// the run: a stub that drifts from the CLI, or a CLI release that stops
// passing the token on, fails here.
const MEASURED = require('../fixtures/claude-cli-run-token.json');
const measured = (from) => MEASURED.cases.flatMap((c) => c.observed.requests).filter((r) => r.from === from)
  .map(({ token, session }) => ({ token, session }));
const sessionSent = (session) => (session === 'the run\'s' ? {} : session === 'another' ? { session_id: 'nested-claude-session' } : { session_id: null });

test('the record tells a request that carried the run\'s token from one that carried none, measured with the real CLI', () => {
  assert.ok(MEASURED.claudeCode, 'it names the Claude Code it was measured with');
  for (const c of MEASURED.cases) assert.strictEqual(c.observed.exitCode, 0, `${c.name}: the CLI ran to the end`);
  assert.deepStrictEqual(measured('the subagent').map((r) => r.token), ['the run\'s'], 'a subagent\'s request carried the run\'s token');
  assert.deepStrictEqual(measured('the nested claude').map((r) => r.token), ['the run\'s'], 'so did a nested claude\'s');
  const control = MEASURED.cases.find((c) => !c.token).observed.requests;
  assert.deepStrictEqual(control.map((r) => r.token), ['none'], 'and a run started with none sent none');
});

test('a Task subagent\'s call and a nested claude\'s, carrying the run\'s token, are the run\'s cards, whatever session they name', async () => {
  // The measured subagent call: agent_id and agent_type, and the session the
  // record says. A `claude` started from the run's shell names the session
  // the record says it does, and a call may name none.
  const { agent_id: subagent, agent_type: type } = require('../fixtures/subagent-hook-payload.json').subagent;
  const [sub] = measured('the subagent');
  const [nested] = measured('the nested claude');
  h.writeScenario([{
    match: { agent: KEEPER, promptIncludes: 'work started inside' },
    hooks: [readOutside({ agent_id: subagent, agent_type: type, ...sessionSent(sub.session) }), readOutside(sessionSent(nested.session)), readOutside({ session_id: null })],
    turn: [{ text: 'Did the rest.' }],
  }]);
  await save(KEEPER, 'token-inside', 'work started inside');
  let seen = client.messages.length;
  press(KEEPER, 'token-inside');
  const cards = [];
  for (let i = 0; i < 3; i++) {
    const { msg: card, index } = await client.waitFor((m) => m.type === 'control_request' && m._run, { since: seen, label: `card ${i + 1}` });
    seen = index + 1;
    cards.push(card);
    client.send({ type: 'permission_response', requestId: card.request_id, conversationId: '', allow: false, card: true });
  }
  assert.ok(await closed('token-inside'), 'the run ends');
  const run = recordOf('token-inside');
  for (const card of cards) assert.deepStrictEqual(card._run, { id: run.id, routine: 'token-inside', agent: KEEPER });
  assert.strictEqual(run.refusedCards, 3, 'each refusal counted once, on the run');

  const told = h.readHookAnswers().filter((x) => x.agent === KEEPER && x.sessionId === run.sessionId);
  assert.deepStrictEqual(told.map((x) => [x.subagent, x.sentSession]), [[subagent, run.sessionId], [null, 'nested-claude-session'], [null, null]],
    'the hook really sent a subagent\'s call, another session, and none');
  for (const x of told) assert.strictEqual(x.answer.hookSpecificOutput.permissionDecisionReason, UNATTENDED_DENIED);
  // What the stub sent, in the record's words: a card filed on the run is a
  // request that carried the run's token.
  const sent = told.slice(0, 2).map((x, i) => ({
    token: cards[i]._run.id === run.id && tokenOf(run) ? 'the run\'s' : 'none',
    session: !x.sentSession ? 'none' : x.sentSession === run.sessionId ? 'the run\'s' : 'another',
  }));
  assert.deepStrictEqual(sent, [sub, nested], 'the stub sent what the real CLI was measured sending');
});

test('a request held back through the end of its run is refused when it finishes during the routine\'s next run, and counts on neither', async () => {
  h.writeScenario([{ match: { agent: KEEPER, promptIncludes: 'runs twice' }, hooks: [readOutside()], turn: [{ text: 'Done.' }] }]);
  await save(KEEPER, 'token-again', 'runs twice');
  let since = client.messages.length;
  press(KEEPER, 'token-again');
  const { msg: first } = await client.waitFor((m) => m.type === 'control_request' && m._run, { since, label: 'the first run\'s card' });
  const firstRun = recordById(first._run.id);
  const request = await held(tokenOf(firstRun));
  answer(first, true);
  assert.ok(await h.waitUntil(() => recordById(firstRun.id).status !== 'running', { timeout: 15000 }), 'the first run ends');

  since = client.messages.length;
  press(KEEPER, 'token-again');
  const { msg: second, index } = await client.waitFor((m) => m.type === 'control_request' && m._run && m._run.id !== firstRun.id, { since, label: 'the next run\'s card' });
  assert.strictEqual(recordById(second._run.id).status, 'running', 'the same routine is going again');

  request.finish();
  // Whichever comes first: the answer, a card the held request filed, or
  // three seconds of neither. A stray card is refused at once and a request
  // left unanswered is dropped, so none is left waiting.
  const stray = h.waitUntil(() => client.messages.slice(index + 1).some((m) => m.type === 'control_request'), { timeout: 3000 });
  const out = await Promise.race([request.answered, stray.then(() => null)]);
  const filed = client.messages.slice(index + 1).filter((m) => m.type === 'control_request');
  for (const card of filed) answer(card, false);
  assert.deepStrictEqual(filed, [], 'the held request files no card, on the run it began in or the one going now');
  if (!out) request.abort();
  assert.strictEqual((out || await request.answered).status, 401, 'refused as an unknown token is');

  answer(second, true);
  assert.ok(await h.waitUntil(() => recordById(second._run.id).status !== 'running', { timeout: 15000 }), 'the next run ends');
  for (const id of [firstRun.id, second._run.id]) assert.strictEqual('refusedCards' in recordById(id), false, 'and neither run counts a refusal');
});

// THE RUN ENDS WHILE ONE OF ITS CARDS IS OPEN: here a request sent with the
// run's token, whose asker outlives the run. The card is refused as the
// record closes, its asker told no, every window told it has ended, and it is
// counted with the run. Nothing after the close changes any of that.
const pendingNow = () => h.internal.pendingPermissionRequests;
// Start the routine and wait for its own card, which holds the run open.
async function startHeld(agent, name) {
  const since = client.messages.length;
  press(agent, name);
  const { msg: own, index } = await client.waitFor((m) => m.type === 'control_request' && m._run && m._run.routine === name, { since, label: `${name}'s own card` });
  return { own, index, run: recordById(own._run.id), token: tokenOf(recordById(own._run.id)) };
}
// A card asked with the run's token, its timer set to `timeoutMs`: the first
// card raised after message `since`.
async function openCard(token, since, timeoutMs) {
  const prev = timeoutMs ? ROUTER.wireHttpRouterDeps({ getPermissionTimeoutMs: () => timeoutMs }) : null;
  try {
    const asked = permissionRequest(token);
    const { msg: card, index } = await client.waitFor((m) => m.type === 'control_request', { since, label: 'the open card' });
    return { asked, card, index, filedAt: Date.now() };
  } finally { if (prev) ROUTER.wireHttpRouterDeps({ getPermissionTimeoutMs: prev.getPermissionTimeoutMs }); }
}
const closedRun = (id) => h.waitUntil(() => recordById(id).status !== 'running', { timeout: 15000 });

test('a card still open when its run ends is refused and counted with the run, and nothing after the close changes that', async () => {
  h.writeScenario([{ match: { agent: KEEPER, promptIncludes: 'ends with a card open' }, hooks: [readOutside()], turn: [{ text: 'Done.' }] }]);
  await save(KEEPER, 'token-open', 'ends with a card open');
  const { own, index, run, token } = await startHeld(KEEPER, 'token-open');
  const open = await openCard(token, index + 1, 3000);

  // The run's own card approved, which is never counted, and the run ends
  // with the other still open.
  const since = client.messages.length;
  answer(own, true);
  assert.deepStrictEqual(await (await open.asked).json(), { allow: false, reason: 'run-ended' }, 'the open card\'s asker is told no as the run ends');
  assert.ok(await closedRun(run.id), 'the run ends');
  const file = recordFile(run.id);
  const closedAs = fs.readFileSync(file, 'utf-8');
  assert.strictEqual(JSON.parse(closedAs).status, 'succeeded');
  assert.strictEqual(JSON.parse(closedAs).refusedCards, 1, 'the open card is counted with the run, and the approved one is not');
  assert.ok(client.messages.slice(since).some((m) => m.type === 'permission_ended' && m.requestId === open.card.request_id && m.reason === 'ended'), 'and every window is told the card has ended');
  assert.strictEqual(pendingNow().has(open.card.request_id), false, 'nothing is left waiting on it');

  // UNDO: a person answers the settled card after the close, both ways, and
  // its own timer runs out. None of it does anything.
  const after = client.messages.length;
  answer(open.card, true);
  answer(open.card, false);
  await h.delay(Math.max(0, open.filedAt + 3000 + 300 - Date.now()));
  const aboutCards = (m) => m.type === 'control_request' || m.type.startsWith('permission');
  assert.deepStrictEqual(client.messages.slice(after).filter(aboutCards).map((m) => [m.type, m.requestId, m.reason]),
    [['permission_ended', open.card.request_id, 'not-pending'], ['permission_ended', open.card.request_id, 'not-pending']],
    'each late answer is told it is too late, and no window hears of the card again');
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), closedAs, 'the record is as it closed, the card counted once');

  // RETRY: the same asker asks again after the close.
  const again = client.messages.length;
  assert.strictEqual((await permissionRequest(token)).status, 401, 'refused as an unknown token is');
  await h.delay(200);
  assert.deepStrictEqual(client.messages.slice(again).filter((m) => m.type === 'control_request'), [], 'with no card');
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), closedAs, 'and no count');

  // THE NEXT RUN of the same routine starts with no count, and the settled
  // card is neither on it nor waiting in a window that opens now.
  const next = await startHeld(KEEPER, 'token-open');
  assert.notStrictEqual(next.run.id, run.id);
  assert.notStrictEqual(next.own.request_id, open.card.request_id);
  assert.strictEqual('refusedCards' in next.run, false, 'the next run starts with no count');
  const fresh = await h.connect();
  try {
    const { msg: waiting } = await fresh.waitFor((m) => m.type === 'pending_permissions', { label: 'what a new window is told is waiting' });
    assert.ok(waiting.requestIds.includes(next.own.request_id));
    assert.strictEqual(waiting.requestIds.includes(open.card.request_id), false, 'the settled card is not waiting');
  } finally { fresh.close(); }
  answer(next.own, true);
  assert.ok(await closedRun(next.run.id), 'the next run ends');
  assert.strictEqual('refusedCards' in recordById(next.run.id), false, 'having closed with no open card, it has no count');
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), closedAs, 'and the earlier run is untouched');
});

// THE CONTROL FAILING: telling the windows throws, and one card's answer to
// its hook cannot be written. The record still closes, with its outcome and
// both cards counted, the hook that could not be answered is never let
// through, and the server goes on answering.
test('a card that cannot be settled cleanly as its run ends is still counted, and its hook is never let through', async () => {
  h.writeScenario([{ match: { agent: KEEPER, promptIncludes: 'ends with settling broken' }, hooks: [readOutside()], turn: [{ text: 'Done.' }] }]);
  await save(KEEPER, 'token-broken', 'ends with settling broken');
  const { own, index, run, token } = await startHeld(KEEPER, 'token-broken');
  const told = await openCard(token, index + 1);
  const unwritable = await openCard(token, told.index + 1);
  let letThrough = false;
  unwritable.asked.then((res) => res.json()).then((body) => { letThrough = body.allow === true; }, () => {});
  const stuck = pendingNow().get(unwritable.card.request_id).res;
  stuck.writeHead = () => { throw new Error('the answer to the hook could not be written'); };
  // The unanswered asker is let go at the end, whatever happens, so a
  // failure here cannot leave a request open on the server.
  try {
    const prev = ROUTER.wireHttpRouterDeps({ safeSend: () => { throw new Error('the windows could not be told'); } });
    try {
      answer(own, true);
      assert.ok(await closedRun(run.id), 'the run ends');
    } finally { ROUTER.wireHttpRouterDeps({ safeSend: prev.safeSend }); }
    const closedAs = recordById(run.id);
    assert.strictEqual(closedAs.status, 'succeeded', 'the record closes with its outcome');
    assert.strictEqual(closedAs.refusedCards, 2, 'and both cards counted');
    assert.deepStrictEqual(await (await told.asked).json(), { allow: false, reason: 'run-ended' });
    await h.delay(300);
    assert.strictEqual(letThrough, false, 'the hook that could not be answered is never let through');
    assert.strictEqual(pendingNow().has(unwritable.card.request_id), false);
    assert.strictEqual((await permissionRequest('not-a-token')).status, 401, 'and the server goes on answering');
  } finally { stuck.destroy(); }
});

// THE RACE: a denial, and a timeout, landing inside the close itself, after
// the run's outcome is known and just before its open cards are settled. The
// timer is caught as it is set, so it can be made to fire at that moment.
// Either way the card is counted once.
const RACE_TIMEOUT_MS = 987654;
test('a denial or a timeout that lands as the run is closing is counted once', async () => {
  h.writeScenario([{ match: { agent: KEEPER, promptIncludes: 'ends as a card settles' }, hooks: [readOutside()], turn: [{ text: 'Done.' }] }]);
  await save(KEEPER, 'token-race', 'ends as a card settles');
  const prev = schedulerLib.wireSchedulerDeps({});
  const closing = async (land) => {
    const { own, index, run, token } = await startHeld(KEEPER, 'token-race');
    const open = await openCard(token, index + 1, RACE_TIMEOUT_MS);
    schedulerLib.wireSchedulerDeps({ settleRunCards: (id) => { if (id === run.id) land(open.card.request_id); return prev.settleRunCards(id); } });
    try {
      answer(own, true);
      assert.ok(await closedRun(run.id), 'the run ends');
    } finally { schedulerLib.wireSchedulerDeps({ settleRunCards: prev.settleRunCards }); }
    return { body: await (await open.asked).json(), record: recordById(run.id) };
  };

  const denied = await closing((requestId) => handlePermissionResponse({ pendingPermissions: pendingNow(), broadcast: () => {} }, { send() {} },
    { requestId, conversationId: '', allow: false, card: true }));
  assert.deepStrictEqual(denied.body, { allow: false }, 'the denial answered the asker');
  assert.strictEqual(denied.record.refusedCards, 1, 'and the card is counted once, not again as the run closed');

  const realSetTimeout = global.setTimeout;
  let timer = null;
  global.setTimeout = function (fn, ms, ...rest) {
    const t = realSetTimeout.call(this, fn, ms, ...rest);
    if (ms === RACE_TIMEOUT_MS) timer = { fn, t };
    return t;
  };
  let timedOut;
  try {
    timedOut = await closing(() => { clearTimeout(timer.t); timer.fn(); });
  } finally { global.setTimeout = realSetTimeout; }
  assert.deepStrictEqual(timedOut.body, { allow: false, reason: 'timeout' }, 'the timeout answered the asker');
  assert.strictEqual(timedOut.record.refusedCards, 1, 'and the card is counted once, not again as the run closed');
});
