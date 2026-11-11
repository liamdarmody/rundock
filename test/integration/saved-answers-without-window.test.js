'use strict';
// A saved "Always allow" holds whether or not a Rundock window is open.
//
// When a person presses "Always allow" on a card, the answer is stored in the
// workspace's `.rundock/permissions.json`. Only the window used to apply it:
// with no window connected, a routine ignored an answer the person had
// already given, waited on a card nobody could see, and was refused at the
// timeout. Now the server applies it itself, through the same decision the
// window makes, and only as Rundock wrote it: it runs the answer-file guard's
// check first and reads the guard's baseline, never the file as it stands.
//
// Everything here drives the real server with no window connected unless a
// test connects one on purpose: requests as the permission hook sends them,
// the real hook as the runtime runs it, and real routine runs started the way
// the scheduler starts them. A conversation's request is asked while a turn is
// held on the answer-file guard, as one always is when the hook asks, with a
// check interval longer than any test, so only the checks a test can name
// ever run.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { agentFile, makeTempDir } = require('../helpers/workspace.js');
const route = require('../helpers/permission-route.js');
const P = require('../../public/permissions.js');
const guard = require('../../lib/workspace/answer-file-guard.js');
const config = require('../../lib/config.js');
const { addToolAllow, removeToolAllow, readToolAllows, toolAllowsIn } = require('../../lib/workspace/boundary.js');
const { keychainVerdict } = require('../../scripts/code-mode-verdict.js');
const { refusalNotice } = require('../../scripts/refusal-notice.js');
const PS = require('../fixtures/powershell-reads.js');
const BASH_TABLES = require('../fixtures/bash-reads.js');

const AGENT = 'runner';
const TIMEOUT_MS = 1500;
const HOUR = 60 * 60 * 1000;
const ALWAYS = { allow: true, reason: 'always-allowed' };
const TIMED_OUT = { allow: false, reason: 'timeout' };
const KEYCHAIN_ENV = { RUNDOCK_TEST_SEAMS: '1', RUNDOCK_TEST_PLATFORM: 'darwin' };

let outside;
const recorder = route.routerRecorder();
const { broadcasts, filed, logged } = recorder;

before(async () => {
  await h.boot({
    agents: { runner: agentFile({ name: AGENT, type: 'specialist', order: 1 }) },
    env: { RUNDOCK_PERMISSION_TIMEOUT_MS: String(TIMEOUT_MS) },
  });
  h.internal.stopScheduler();
  outside = makeTempDir('saved-answers-outside-');
  fs.writeFileSync(path.join(outside, 'notes.py'), 'print(1)\n');
  fs.writeFileSync(path.join(h.workspaceDir, 'notes.md'), '# notes\n');
  recorder.install();
});
after(async () => {
  recorder.uninstall();
  await h.shutdown();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const { noWindow, ask, bash, bashInput, runHook, commandOf, events, finished, answersOf } = route;
const startRoutine = (rule) => route.startRoutine(AGENT, rule, 'saved-routine');

const workspace = () => config.getWorkspace();
const permissionsFile = () => path.join(workspace(), '.rundock', 'permissions.json');
const cardsFor = (command) => broadcasts.filter((m) => m.type === 'control_request' && commandOf(m.request && m.request.input) === command);
const filedFor = (command, convo) => filed.filter((f) => commandOf(f.input) === command && (convo === undefined || f.convo === convo));
const timedOut = (requestId) => broadcasts.some((m) => m.type === 'permission_timeout' && m.requestId === requestId);
const savedEvents = (conv) => events().filter((e) => e.e === 'permission' && e.conv === conv && e.d && e.d.reason === 'always-allowed');
// A routine's request has no conversation, so its events carry none.
const routineSavedEvents = () => savedEvents(undefined);
const linesFor = (match) => logged.filter((l) => l.includes('Always allowed, answered without a card') && l.includes(match));

// A TURN, HELD ON THE ANSWER-FILE GUARD as every agent's turn holds it, with a
// check interval longer than any test: the guard checks as the turn starts,
// and then only when the router, or the test through `check`, asks it to.
// Every change it puts back is kept on `changes`.
//
// HELD FOR THE CONVERSATION THAT ASKS, as every Claude turn is guarded with
// its conversation's id: the server applies a conversation's saved answers
// only from the workspace whose guard holds that conversation's turn. A
// list of ids holds one turn for each, for tests that ask from several.
async function holdTurn(convoIds = null) {
  assert.ok(await h.waitUntil(() => !guard.answerFilesWatched(workspace()), { timeout: 5000 }), 'no other turn is running');
  const changes = [];
  const turns = (Array.isArray(convoIds) ? convoIds : [convoIds])
    .map((convoId) => guard.acquireAnswerFileGuard(workspace(), (change) => changes.push(change), { intervalMs: HOUR, convoId }));
  assert.ok(guard.answerFilesWatched(workspace()), 'the guard watches the workspace');
  return { changes, check: () => turns[0].check(), release: () => { for (const t of turns) t.release(); } };
}

// A window with the launch key, as the card's "Always allow" and Settings
// send them: the key saved, or revoked, and the window closed again.
async function throughWindow(message, settled) {
  const window = await h.connect();
  try {
    const since = window.messages.length;
    window.send(message);
    await window.waitFor((m) => m.type === 'tool_allows' && settled(m.tools), { since, label: `the saved answers after ${message.type}` });
  } finally {
    window.close();
  }
  await noWindow();
}
const save = (key) => throughWindow({ type: 'add_tool_allow', key }, (tools) => tools.includes(key));
const revoke = (key) => throughWindow({ type: 'remove_tool_allow', key }, (tools) => !tools.includes(key));

// A request that waits on a card: stored, and sent toward a window nobody has
// open. Dropped once seen, as an asker that went away is, unless the test
// waits for its timeout.
async function waitsForCard(command, convo, extra = {}) {
  const asked = ask(bash(command, convo, extra), { convo });
  let answered = null;
  asked.reply.then((r) => { answered = r; });
  assert.ok(await h.waitUntil(() => answered || filedFor(command, convo).length > 0, { timeout: 5000, interval: 5 }), `${command}: answered or stored`);
  assert.strictEqual(answered, null, `not answered by the server: ${command} ${JSON.stringify(answered && answered.body)}`);
  asked.abort();
  await asked.reply;
}

// What the window decides for a request, with `saved` as its saved answers.
const windowSays = (tool, input, saved, verdict) => P.decidePermission(P.classifyRisk(tool, input),
  P.verdictAllowKey(verdict) || P.toolAllowKey(tool, input), new Set(saved), verdict);

// ---------------------------------------------------------------------------
// A saved answer is answered by the server, with no window
// ---------------------------------------------------------------------------

describe('a saved answer is answered by the server, with no window', () => {
  test('a conversation\'s medium command under a saved key is answered at once: no card, nothing stored to wait', async () => {
    await noWindow();
    const convo = 'saved-conversation';
    const turn = await holdTurn(convo);
    try {
      await save('Bash:python3');
      const command = 'python3 tools/report.py';
      assert.strictEqual(P.classifyRisk('Bash', { command }), 'medium', 'the command is not a read');
      const r = await ask(bash(command, convo), { convo }).reply;
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.body, ALWAYS, 'the server answers it from the saved answer');
      assert.deepStrictEqual(cardsFor(command), [], 'no card was broadcast');
      assert.deepStrictEqual(filedFor(command), [], 'it never waited on a card');
      // And through the real hook, as the runtime runs it.
      const out = await runHook('Bash', { command: 'python3 tools/summary.py' }, { convo });
      assert.strictEqual(out.permissionDecision, 'allow', JSON.stringify(out));
      assert.deepStrictEqual(filedFor('python3 tools/summary.py'), [], 'the hook\'s request never waited either');
      assert.ok(await h.waitUntil(() => savedEvents(convo).length === 2), `both recorded: ${savedEvents(convo).length}`);
      for (const e of savedEvents(convo)) assert.deepStrictEqual(e.d, { tool: 'Bash', decision: 'allow', reason: 'always-allowed' });
      assert.strictEqual(linesFor(`convo=${convo}`).length, 2, 'the server log has a line for each');
    } finally {
      turn.release();
      await revoke('Bash:python3');
    }
  });

  test('a routine run\'s medium commands under a saved key are answered at once, through the real hook, and its record counts none of them', async () => {
    await noWindow();
    await save('Bash:python3');
    try {
      const commands = ['python3 tools/report.py', 'python3 tools/summary.py --week'];
      const before = routineSavedEvents().length;
      const run = startRoutine({ hooks: commands.map((command) => ({ tool: 'Bash', input: { command } })) });
      const record = await finished(run);
      assert.strictEqual(record.status, 'succeeded', JSON.stringify(record));
      const answers = answersOf(record);
      assert.strictEqual(answers.length, commands.length, 'every command was put to the hook');
      for (const a of answers) assert.strictEqual(a && a.permissionDecision, 'allow', JSON.stringify(a));
      for (const command of commands) {
        assert.deepStrictEqual(cardsFor(command), [], `no card: ${command}`);
        assert.deepStrictEqual(filedFor(command), [], `never waited: ${command}`);
      }
      assert.strictEqual(record.refusedCards, undefined, 'the run\'s record counts no refused card');
      assert.strictEqual(linesFor(`routine "${run.name}" run=${record.id}`).length, commands.length, 'the server log names the routine and the run for each');
      assert.ok(await h.waitUntil(() => routineSavedEvents().length - before >= commands.length, { timeout: 3000 }), 'the events are written');
      await h.delay(200);
      const recorded = routineSavedEvents().slice(before);
      assert.strictEqual(recorded.length, commands.length, `one event for each: ${JSON.stringify(recorded)}`);
      for (const e of recorded) assert.deepStrictEqual(e.d, { tool: 'Bash', decision: 'allow', reason: 'always-allowed' });
    } finally {
      await revoke('Bash:python3');
    }
  });
});

// ---------------------------------------------------------------------------
// A saved key never answers what cards ahead of it
// ---------------------------------------------------------------------------

describe('what cards ahead of a saved answer still cards with no window', { concurrency: true }, () => {
  const KEYS = ['Bash:python3', 'Bash:echo', 'Write', 'Bash:security'];
  let turn;
  before(async () => {
    await noWindow();
    turn = await holdTurn(['saved-classes-plain', ...CLASSES.map(([label]) => convoOfClass(label)), ...GRADES.map(([label]) => convoOfGrade(label))]);
    for (const key of KEYS) await save(key);
    // Each key is live: it answers a plain command of its own at once.
    for (const command of ['python3 tools/report.py', 'echo hi > out.txt']) {
      const convo = 'saved-classes-plain';
      assert.deepStrictEqual((await ask(bash(command, convo), { convo }).reply).body, ALWAYS, `the saved key answers ${command}`);
    }
  });
  after(async () => {
    turn.release();
    for (const key of KEYS) await revoke(key);
  });

  // Each through the real hook, so each carries exactly what the hook sends
  // for it, under a saved key that matches it.
  const zshrc = '~/.zshrc';
  const convoOfClass = (label) => `saved-class-${label.replace(/\W+/g, '-')}`;
  const convoOfGrade = (label) => `saved-grade-${label.replace(/\W+/g, '-')}`;
  const CLASSES = [
    ['a high-risk command', 'Bash:python3', () => bashInput('python3 tools/report.py && rm -rf build'), (req) => !req.boundary && !req.answer_file && !req.startup_file && !req.code_mode_verdict, {}],
    ['an uncovered crossing', 'Bash:python3', () => bashInput(`python3 ${path.join(outside, 'notes.py')}`), (req) => req.boundary === true && req.crossings.length === 1, {}],
    ['an answer-file write by a file tool', 'Write', () => ({ tool: 'Write', input: { file_path: path.join(h.workspaceDir, '.rundock', 'permissions.json'), content: '{"allowedTools":["Bash:curl"]}' } }), (req) => req.answer_file === true, {}],
    ['an answer-file write by a shell command', 'Bash:echo', () => bashInput('echo \'{"allowedTools":["Bash:curl"]}\' > .rundock/permissions.json'), (req) => req.boundary === true && req.crossings.some((c) => c.answerFile === true), {}],
    ['a shell startup file', 'Bash:echo', () => bashInput(`echo x >> ${zshrc}`), (req) => req.startup_file === zshrc, {}],
    ['a Notes-mode Keychain line', 'Bash:security', () => bashInput('security find-generic-password -w -s example-service'), (req) => !!req.code_mode_verdict && req.code_mode_verdict.reason === 'keychain', KEYCHAIN_ENV],
  ];
  for (const [label, key, requestFor, graded, env] of CLASSES) {
    test(`${label} under a saved \`${key}\` waits for a card and times out, as on main`, async () => {
      const { tool, input } = requestFor();
      assert.strictEqual(P.toolAllowKey(tool, input), key, `${label}: the saved key matches it`);
      const convo = convoOfClass(label);
      const out = await runHook(tool, input, { convo, env });
      assert.strictEqual(out.permissionDecision, 'deny', `${label}: ${JSON.stringify(out)}`);
      assert.strictEqual(out.permissionDecisionReason, refusalNotice('timeout', tool, { unattended: false }), `${label}: refused as unanswered`);
      const cards = broadcasts.filter((m) => m.type === 'control_request' && m._conversationId === convo);
      assert.strictEqual(cards.length, 1, `${label}: one card was raised`);
      assert.ok(graded(cards[0].request), `${label}: graded as the hook grades it: ${JSON.stringify(cards[0].request)}`);
      assert.deepStrictEqual(filed.filter((f) => f.convo === convo).map((f) => f.id), [cards[0].request_id], `${label}: it waited on the card`);
      assert.ok(timedOut(cards[0].request_id), `${label}: and it timed out`);
      assert.deepStrictEqual(savedEvents(convo), [], `${label}: never recorded as allowed`);
    });
  }

  // EACH GRADE ALONE KEEPS THE CARD, on a command the saved key answers at
  // once without it. Shaped as the hook shapes each field.
  const command = 'python3 tools/report.py';
  const GRADES = [
    ['boundary', () => ({ boundary: true, resolved_path: path.join(outside, 'notes.py'), grant_dir: outside, grantable: true, crossings: [{ path: path.join(outside, 'notes.py'), grantDir: outside }] })],
    ['answer_file', () => ({ answer_file: true, resolved_path: permissionsFile(), grant_dir: null })],
    ['startup_file', () => ({ startup_file: zshrc })],
    ['an Always-asks verdict', () => ({ code_mode_verdict: keychainVerdict({ toolName: 'Bash', command: 'security dump-keychain', cwd: h.workspaceDir, workspaceRoot: h.workspaceDir, extraDirs: [], keychainPlatform: 'darwin' }) })],
  ];
  for (const [label, fields] of GRADES) {
    test(`a request carrying ${label} cards under a saved key that answers its command`, async () => {
      const convo = convoOfGrade(label);
      const extra = fields();
      const r = await ask(bash(command, convo, extra), { convo }).reply;
      assert.deepStrictEqual(r.body, TIMED_OUT, `${label}: waited and timed out`);
      assert.strictEqual(filedFor(command, convo).length, 1, `${label}: it waited on a card`);
      assert.strictEqual(cardsFor(command).filter((m) => m._conversationId === convo).length, 1, `${label}: a card was raised`);
    });
  }
});

// ---------------------------------------------------------------------------
// Only content Rundock wrote is applied
// ---------------------------------------------------------------------------

describe('only a saved answer Rundock wrote is applied', () => {
  // The file with `key` added, written straight to disk as a script would,
  // never through add_tool_allow.
  function plant(key) {
    const was = fs.readFileSync(permissionsFile());
    const data = JSON.parse(was.toString('utf-8'));
    fs.writeFileSync(permissionsFile(), JSON.stringify({ ...data, allowedTools: [...(data.allowedTools || []), key] }, null, 2));
    return was;
  }

  test('a key written straight to the file between two of the guard\'s checks is put back before the request is answered, and the request cards', async () => {
    await noWindow();
    const convo = 'saved-race';
    const turn = await holdTurn(convo);
    try {
      // The file exists, holding only what Rundock wrote.
      await save('Bash:python3');
      turn.check();
      assert.deepStrictEqual(turn.changes, [], 'nothing to put back yet');
      const was = plant('Bash:node');
      assert.ok(readToolAllows().includes('Bash:node'), 'the key is on disk, and no check has run since');
      const command = 'node tools/build.js';
      assert.strictEqual(P.classifyRisk('Bash', { command }), 'medium');
      await waitsForCard(command, convo);
      assert.ok(fs.readFileSync(permissionsFile()).equals(was), 'the router\'s own check put the file back before it answered');
      assert.ok(turn.changes.some((c) => c.relative === '.rundock/permissions.json' && !c.outsideTurn),
        'and handed the change to the turn, as every change it puts back is');
      assert.deepStrictEqual(savedEvents(convo), [], 'nothing was allowed');
    } finally {
      turn.release();
      await revoke('Bash:python3');
    }
  });

  test('a key written again just after the check, as a script rewriting the file in a loop would, is never applied', async () => {
    await noWindow();
    const convo = 'saved-rewrite';
    const turn = await holdTurn(convo);
    const check = guard.checkAnswerFilesNow;
    try {
      await save('Bash:python3');
      turn.check();
      const was = fs.readFileSync(permissionsFile());
      let rewrites = 0;
      // The script's write lands between the router's check and its read.
      guard.checkAnswerFilesNow = (...args) => { const found = check(...args); plant('Bash:node'); rewrites++; return found; };
      const command = 'node tools/build.js';
      await waitsForCard(command, convo);
      assert.ok(rewrites >= 1, 'the file was rewritten after the router\'s check');
      assert.ok(readToolAllows().includes('Bash:node'), 'and still holds the key as the request is carded');
      guard.checkAnswerFilesNow = check;
      // The saved answer Rundock wrote still answers, read the same way.
      assert.deepStrictEqual((await ask(bash('python3 tools/report.py', convo), { convo }).reply).body, ALWAYS);
      assert.ok(fs.readFileSync(permissionsFile()).equals(was), 'and the next check put the file back');
    } finally {
      guard.checkAnswerFilesNow = check;
      turn.release();
      await revoke('Bash:python3');
    }
  });

  // A PERSON'S SAVE OR REVOKE NEVER CARRIES A PLANTED KEY INTO THE FILE. Each
  // writer builds on what the guard has accepted: a writer that merged the
  // disk as it stands would write the planted key back as Rundock's own, the
  // guard would take it into its baseline at the next check, and the server
  // would answer it.
  const baselineKeys = () => toolAllowsIn(guard.answerFileBaseline(workspace(), permissionsFile()));
  const putBackPlant = (turn, key) => turn.changes.some((c) => c.relative === '.rundock/permissions.json' && !c.outsideTurn
    && typeof c.agentContent === 'string' && c.agentContent.includes(key));
  async function cardsAndTimesOut(command, convo, label) {
    assert.strictEqual(P.classifyRisk('Bash', { command }), 'medium', `${label}: a medium command`);
    assert.strictEqual(P.toolAllowKey('Bash', { command }), 'Bash:node', `${label}: under the planted key`);
    const r = await ask(bash(command, convo), { convo }).reply;
    assert.deepStrictEqual(r.body, TIMED_OUT, `${label}: the planted key answered it`);
    assert.strictEqual(filedFor(command, convo).length, 1, `${label}: it waited on a card`);
    assert.strictEqual(cardsFor(command).filter((m) => m._conversationId === convo).length, 1, `${label}: a card was raised`);
  }

  test('a key planted before the person saves another is never carried into the save: its command cards and times out', async () => {
    await noWindow();
    const convo = 'saved-launder-save';
    const turn = await holdTurn(convo);
    try {
      await save('Bash:echo');
      turn.check();
      plant('Bash:node');
      assert.ok(readToolAllows().includes('Bash:node'), 'the key is on disk, and no check has run since');
      // The person's unrelated save, through the window's add_tool_allow.
      await save('Bash:python3');
      await cardsAndTimesOut('node scripts/build.js', convo, 'after the save');
      assert.deepStrictEqual(savedEvents(convo), [], 'nothing was allowed');
      assert.ok(!readToolAllows().includes('Bash:node'), 'the save wrote the file without the planted key');
      assert.ok(readToolAllows().includes('Bash:python3') && readToolAllows().includes('Bash:echo'), 'and with every key Rundock wrote');
      turn.check();
      assert.ok(!baselineKeys().includes('Bash:node') && baselineKeys().includes('Bash:python3'), 'once checked, the baseline holds the save, not the plant');
      assert.ok(putBackPlant(turn, 'Bash:node'), 'the planted change was handed to the turn, as every change the guard puts back is');
      assert.deepStrictEqual((await ask(bash('python3 tools/report.py', convo), { convo }).reply).body, ALWAYS, 'the person\'s save answers');
    } finally {
      turn.release();
      await revoke('Bash:python3');
      await revoke('Bash:echo');
    }
  });

  test('a key planted before the person revokes another is never carried into the revoke: its command cards and times out', async () => {
    await noWindow();
    const convo = 'saved-launder-revoke';
    const turn = await holdTurn(convo);
    try {
      await save('Bash:python3');
      await save('Bash:echo');
      turn.check();
      plant('Bash:node');
      assert.ok(readToolAllows().includes('Bash:node'), 'the key is on disk, and no check has run since');
      // The person's unrelated revoke, through the window's remove_tool_allow.
      await revoke('Bash:echo');
      await cardsAndTimesOut('node scripts/build.js', convo, 'after the revoke');
      assert.deepStrictEqual(savedEvents(convo), [], 'nothing was allowed');
      assert.ok(!readToolAllows().includes('Bash:node'), 'the revoke wrote the file without the planted key');
      assert.deepStrictEqual(readToolAllows(), ['Bash:python3'], 'and with the key Rundock kept');
      turn.check();
      assert.deepStrictEqual(baselineKeys(), ['Bash:python3'], 'once checked, the baseline holds the revoke, not the plant');
      assert.ok(putBackPlant(turn, 'Bash:node'), 'the planted change was handed to the turn');
    } finally {
      turn.release();
      await revoke('Bash:python3');
    }
  });
});

// ---------------------------------------------------------------------------
// The fifth sequence, the control failing: the saved set fails closed
// ---------------------------------------------------------------------------

describe('5. the control failing: the saved set fails closed', () => {
  const command = 'python3 tools/report.py';

  test('with no turn\'s guard watching the workspace, no saved answer applies', async () => {
    await noWindow();
    const convo = 'saved-unwatched';
    await save('Bash:python3');
    try {
      const turn = await holdTurn(convo);
      try {
        assert.deepStrictEqual((await ask(bash(command, convo), { convo }).reply).body, ALWAYS, 'answered while a turn runs');
      } finally {
        turn.release();
      }
      assert.strictEqual(guard.answerFilesWatched(workspace()), false, 'no turn runs now');
      assert.ok(readToolAllows().includes('Bash:python3'), 'the answer is still saved');
      await waitsForCard(command, convo);
    } finally {
      await revoke('Bash:python3');
    }
  });

  // A routine run's workspace comes from its record, not from a guarded
  // turn, so the run path is where the guard's watch is checked on its own.
  // The run is a live one as the scheduler names it, in this workspace, with
  // its own token; the lookup is put back once the test ends.
  test('a routine run in a workspace no turn\'s guard watches gets no saved answer, though its record names the workspace', async () => {
    await noWindow();
    const auth = require('../../lib/auth/index.js');
    const ROUTER = require('../../lib/http-router.js');
    const runId = 'saved-unwatched-run';
    const live = { id: runId, routine: 'unwatched', agent: AGENT, workspace: workspace() };
    const prev = ROUTER.wireHttpRouterDeps({});
    ROUTER.wireHttpRouterDeps({ routineRun: (id) => (id === runId ? live : prev.routineRun(id)) });
    const headers = { [auth.HOOK_HEADER]: auth.issueRunHookToken(runId) };
    await save('Bash:python3');
    try {
      const turn = await holdTurn('saved-unwatched-other');
      try {
        assert.deepStrictEqual((await ask(bash(command), { headers }).reply).body, ALWAYS, 'answered while a turn runs in the run\'s workspace');
      } finally {
        turn.release();
      }
      assert.strictEqual(guard.answerFilesWatched(workspace()), false, 'no turn runs now');
      assert.ok(readToolAllows().includes('Bash:python3'), 'the answer is still saved');
      const r = await ask(bash(command), { headers }).reply;
      assert.deepStrictEqual(r.body, TIMED_OUT, 'the run\'s request waited on a card');
    } finally {
      ROUTER.wireHttpRouterDeps({ routineRun: prev.routineRun });
      await revoke('Bash:python3');
    }
  });

  // A request sent while `force` holds, then put back. The hook still gets
  // the card path's reply: stored, broadcast, timed out. Never an allow, and
  // never a dropped connection.
  async function forced(label, force) {
    await noWindow();
    const convo = `saved-forced-${label}`;
    const turn = await holdTurn(convo);
    try {
      await save('Bash:python3');
      const restore = force();
      let r;
      try {
        r = await ask(bash(command, convo), { convo }).reply;
      } finally { restore(); }
      assert.strictEqual(r.status, 200, `${label}: the hook got a reply: ${JSON.stringify(r)}`);
      assert.deepStrictEqual(r.body, TIMED_OUT, `${label}: the card path's reply`);
      const [card] = filedFor(command, convo);
      assert.ok(card, `${label}: it waited on a card`);
      assert.ok(timedOut(card.id), `${label}: which timed out`);
      assert.deepStrictEqual(savedEvents(convo), [], `${label}: never recorded as allowed`);
      // The control is back: the same request is answered again.
      assert.deepStrictEqual((await ask(bash(command, convo), { convo }).reply).body, ALWAYS, `${label}: answered again once restored`);
    } finally {
      turn.release();
      await revoke('Bash:python3');
    }
  }
  const replace = (name, fn) => () => { const was = guard[name]; guard[name] = fn; return () => { guard[name] = was; }; };

  test('the guard\'s check throwing', () => forced('check', replace('checkAnswerFilesNow', () => { throw new Error('forced: the check'); })));
  test('the read throwing', () => forced('read', replace('answerFileBaseline', () => { throw new Error('forced: the read'); })));
});

// ---------------------------------------------------------------------------
// Code mode's saved Asks-once answers apply only to their own rule
// ---------------------------------------------------------------------------

describe('a Code-mode verdict reaches the decision as the window passes it', () => {
  // Shaped as the hook sends each one.
  const PUSH_MAIN = { verdict: 'asks-once', rule: 'Bash:git-push:default-branch', branch: 'main' };
  const PUSH_TAGS = { verdict: 'asks-once', rule: 'Bash:git-push:tags' };
  const FORCE_MAIN = { verdict: 'always-asks', reason: 'force-push-default', branch: 'main' };
  const keychain = (command) => keychainVerdict({ toolName: 'Bash', command, cwd: h.workspaceDir, workspaceRoot: h.workspaceDir, extraDirs: [], keychainPlatform: 'darwin' });

  // The server's answer for each, beside the window's for the same input.
  async function serverAndWindow(convo, command, verdict, saved) {
    const input = { command };
    const said = windowSays('Bash', input, saved, verdict);
    const asked = ask(bash(command, convo, { code_mode_verdict: verdict }), { convo });
    let answered = null;
    asked.reply.then((r) => { answered = r; });
    assert.ok(await h.waitUntil(() => answered || filedFor(command, convo).length > 0, { timeout: 5000, interval: 5 }));
    const server = answered ? answered.body : 'card';
    if (!answered) { asked.abort(); await asked.reply; }
    return { server, window: said.action === 'allow' ? { allow: true, reason: said.reason } : 'card' };
  }

  test('a saved rule answers a push to the default branch with no window; a saved Bash:git never answers an Asks once', async () => {
    await noWindow();
    const turn = await holdTurn(['saved-code-rule', 'saved-code-tags', 'saved-code-binary']);
    try {
      await save('Bash:git-push:default-branch');
      assert.deepStrictEqual(await serverAndWindow('saved-code-rule', 'git push origin main', PUSH_MAIN, ['Bash:git-push:default-branch']),
        { server: ALWAYS, window: ALWAYS }, 'the push is answered by its own saved rule, as the window answers it');
      assert.deepStrictEqual(await serverAndWindow('saved-code-tags', 'git push --tags', PUSH_TAGS, ['Bash:git-push:default-branch']),
        { server: 'card', window: 'card' }, 'a saved rule answers its own rule only');
      await revoke('Bash:git-push:default-branch');
      await save('Bash:git');
      assert.ok(readToolAllows().includes('Bash:git') && !readToolAllows().includes('Bash:git-push:default-branch'));
      for (const [command, verdict] of [['git push origin main', PUSH_MAIN], ['git push --tags', PUSH_TAGS]]) {
        assert.deepStrictEqual(await serverAndWindow('saved-code-binary', command, verdict, ['Bash:git']),
          { server: 'card', window: 'card' }, `a saved binary key never answers an Asks once: ${command}`);
      }
    } finally {
      turn.release();
      await revoke('Bash:git');
    }
  });

  test('an Always-asks verdict cards under every saved key', async () => {
    await noWindow();
    const KEYS = ['Bash:git', 'Bash:git-push:default-branch', 'Bash:git-push:tags', 'Bash:security'];
    const turn = await holdTurn('saved-code-always');
    try {
      for (const key of KEYS) await save(key);
      for (const [command, verdict] of [['git push --force origin main', FORCE_MAIN], ['security find-generic-password -w -s example-service', keychain('security find-generic-password -w -s example-service')]]) {
        assert.strictEqual(verdict.verdict, 'always-asks');
        assert.deepStrictEqual(await serverAndWindow('saved-code-always', command, verdict, KEYS),
          { server: 'card', window: 'card' }, `cards under every saved key: ${command}`);
      }
    } finally {
      turn.release();
      for (const key of KEYS) await revoke(key);
    }
  });
});

// ---------------------------------------------------------------------------
// Two lines under a saved answer, with no window
// ---------------------------------------------------------------------------

describe('two lines under a saved answer get the window\'s answer', () => {
  test('a file pattern that runs code waits for a card under a saved Bash:ls', async () => {
    await noWindow();
    const convo = 'saved-zsh-pattern';
    const command = "ls 'a'*(e:'echo x':)";
    const turn = await holdTurn(convo);
    try {
      await save('Bash:ls');
      assert.strictEqual(P.toolAllowKey('Bash', { command }), 'Bash:ls', 'the saved key matches it');
      assert.strictEqual(windowSays('Bash', { command }, ['Bash:ls']).action, 'card', 'the window cards it');
      assert.deepStrictEqual((await ask(bash('ls *.md', convo), { convo }).reply).body, ALWAYS, 'the saved key answers a plain listing');
      const r = await ask(bash(command, convo), { convo }).reply;
      assert.deepStrictEqual(r.body, TIMED_OUT, 'the server waited for a card, and it timed out');
      assert.strictEqual(filedFor(command, convo).length, 1, 'it waited on a card');
      assert.strictEqual(cardsFor(command).filter((m) => m._conversationId === convo).length, 1, 'a card was raised');
    } finally {
      turn.release();
      await revoke('Bash:ls');
    }
  });

  // KEYS ARE COARSE. `rg '--pre'` runs a program on every file it searches,
  // so it is not a read and is graded medium, and a saved Bash:rg answers any
  // rg line that is not high risk: the window does exactly this when it is
  // open. How coarse keys are is a separate question; this pins that the
  // server gives the window's answer, no more and no less.
  test('rg --pre is answered under a saved Bash:rg, exactly as the window answers it', async () => {
    await noWindow();
    const convo = 'saved-rg-pre';
    const command = "rg '--pre' sh x .";
    const turn = await holdTurn(convo);
    try {
      await save('Bash:rg');
      assert.strictEqual(P.classifyRisk('Bash', { command }), 'medium', 'it is not a read');
      assert.deepStrictEqual(windowSays('Bash', { command }, ['Bash:rg']), { action: 'allow', reason: 'always-allowed' }, 'the window allows it under the saved key');
      assert.deepStrictEqual((await ask(bash(command, convo), { convo }).reply).body, ALWAYS, 'and so does the server, for the same reason');
    } finally {
      turn.release();
      await revoke('Bash:rg');
    }
    assert.strictEqual(windowSays('Bash', { command }, []).action, 'card', 'with nothing saved the window cards it');
    await waitsForCard(command, convo);
  });
});

// ---------------------------------------------------------------------------
// One decision, no copy
// ---------------------------------------------------------------------------

describe('the server and the window give the same answer under saved answers', () => {
  const commandsOf = (value) => {
    if (typeof value === 'string') return [value];
    if (typeof value === 'function') return commandsOf(value('notes'));
    if (!Array.isArray(value)) return [];
    const labelled = value.length > 0 && value.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string');
    return labelled ? value.flatMap(([, commands]) => commandsOf(commands)) : value.flatMap(commandsOf);
  };
  const OWN = ['python3 tools/report.py', 'python3 tools/report.py && rm -rf build', 'npm run build', 'echo hi > out.txt', 'ls; rm -rf x', "rg '--pre' sh x .", "ls 'a'*(e:'echo x':)"];
  const BASH = [...new Set([...Object.values(BASH_TABLES).flatMap(commandsOf), ...OWN])];
  const POWERSHELL = [...new Set(Object.values(PS).flatMap(commandsOf))];
  const ROWS = [
    ...BASH.map((command) => ['Bash', { command }]),
    ...POWERSHELL.map((command) => ['PowerShell', { command }]),
    ['mcp__example__create_folder', { name: 'x' }],
    ['mcp__example__send_email', { to: 'someone' }],
  ];

  test('every row of the tables, with its own key saved: the server answers exactly what the window allows, and cards the rest', async () => {
    await noWindow();
    // Every row's key saved, through Rundock's own writer, as add_tool_allow saves it.
    const keys = [...new Set(ROWS.map(([tool, input]) => P.toolAllowKey(tool, input)))];
    const convo = 'saved-table';
    const turn = await holdTurn(convo);
    try {
      for (const key of keys) addToolAllow(key);
      const saved = readToolAllows();
      const disagree = [];
      const count = { 'always-allowed': 0, 'low-risk': 0, card: 0 };
      for (const [tool, input] of ROWS) {
        const d = windowSays(tool, input, saved);
        const expected = d.action === 'allow' ? d.reason : 'card';
        count[expected]++;
        const mark = filed.length;
        const asked = ask({ tool_name: tool, tool_input: input, conversation_id: convo }, { convo });
        let answered = null;
        asked.reply.then((r) => { answered = r; });
        assert.ok(await h.waitUntil(() => answered || filed.slice(mark).some((f) => f.convo === convo), { timeout: 5000, interval: 2 }), `${tool}: ${JSON.stringify(input)}`);
        let got = 'card';
        if (answered) got = answered.body && answered.body.reason === 'read-only' ? 'low-risk' : (answered.body && answered.body.reason) || JSON.stringify(answered.body);
        else { asked.abort(); await asked.reply; }
        if (got !== expected) disagree.push(`${tool} ${JSON.stringify(input).slice(0, 120)}: window ${expected}, server ${got}`);
      }
      assert.deepStrictEqual(disagree, [], `${disagree.length} of ${ROWS.length} rows disagree`);
      assert.ok(count['always-allowed'] >= 40 && count.card >= 20 && count['low-risk'] === 0,
        `under a saved key, what the window allows it allows as saved, and the high-risk rows still card: ${JSON.stringify(count)}`);
    } finally {
      turn.release();
      for (const key of keys) removeToolAllow(key);
    }
  });
});

// ---------------------------------------------------------------------------
// The five sequences (the fifth, the control failing, is above)
// ---------------------------------------------------------------------------

describe('the five sequences', () => {
  test('1. the inverse action: in one routine run under a saved Bash:python3, a medium python3 command is answered and a high-risk one right after it waits and times out', async () => {
    await noWindow();
    await save('Bash:python3');
    try {
      const medium = 'python3 tools/report.py';
      const high = 'python3 tools/report.py && rm -rf build';
      assert.strictEqual(P.toolAllowKey('Bash', { command: high }), 'Bash:python3', 'the high-risk line has the saved key too');
      const before = routineSavedEvents().length;
      const run = startRoutine({ hooks: [{ tool: 'Bash', input: { command: medium } }, { tool: 'Bash', input: { command: high } }] });
      const record = await finished(run);
      const [first, second] = answersOf(record);
      assert.strictEqual(first && first.permissionDecision, 'allow', `the medium command: ${JSON.stringify(first)}`);
      assert.strictEqual(second && second.permissionDecision, 'deny', `the high-risk command: ${JSON.stringify(second)}`);
      assert.strictEqual(second.permissionDecisionReason, refusalNotice('timeout', 'Bash', { unattended: true }), 'refused as unanswered');
      assert.deepStrictEqual(filedFor(medium).filter((f) => f.run && f.run.id === record.id), [], 'the medium command never waited');
      const [card] = cardsFor(high).filter((m) => m._run && m._run.id === record.id);
      assert.ok(card, 'the high-risk command raised the run\'s card');
      assert.ok(timedOut(card.request_id), 'which timed out');
      assert.strictEqual(record.refusedCards, 1, 'the run counts the one refused card, not the allowed one');
      assert.ok(await h.waitUntil(() => routineSavedEvents().length - before >= 1, { timeout: 3000 }));
      await h.delay(200);
      assert.strictEqual(routineSavedEvents().length - before, 1, 'one allow recorded for the run');
    } finally {
      await revoke('Bash:python3');
    }
  });

  test('2. the undo: once the person revokes the saved answer, the next matching request cards', async () => {
    await noWindow();
    const convo = 'saved-undo';
    const command = 'python3 tools/report.py';
    const turn = await holdTurn(convo);
    try {
      await save('Bash:python3');
      assert.deepStrictEqual((await ask(bash(command, convo), { convo }).reply).body, ALWAYS, 'answered while saved');
      await revoke('Bash:python3');
      await waitsForCard(command, convo);
      assert.strictEqual(savedEvents(convo).length, 1, 'only the first was allowed');
    } finally {
      turn.release();
    }
  });

  test('3. the retry: the same request sent twice is answered at once both times, and recorded twice', async () => {
    await noWindow();
    const convo = 'saved-retry';
    const command = 'python3 tools/report.py --retry';
    const turn = await holdTurn(convo);
    try {
      await save('Bash:python3');
      for (let i = 0; i < 2; i++) {
        assert.deepStrictEqual((await ask(bash(command, convo), { convo }).reply).body, ALWAYS, `send ${i + 1}`);
      }
      assert.deepStrictEqual(filedFor(command), [], 'neither waited');
      assert.ok(await h.waitUntil(() => savedEvents(convo).length === 2), `recorded twice: ${savedEvents(convo).length}`);
      assert.strictEqual(linesFor(`convo=${convo}`).length, 2);
    } finally {
      turn.release();
      await revoke('Bash:python3');
    }
  });

  test('4. the most common next step: "Always allow" pressed on a routine\'s card, the window closed, and the routine\'s next matching request is answered by the server', async () => {
    await noWindow();
    const gate = path.join(makeTempDir('saved-answers-gate-'), 'go');
    const first = 'python3 tools/report.py';
    const next = 'python3 tools/summary.py';
    const window = await h.connect();
    let run;
    try {
      run = startRoutine({ hooks: [{ tool: 'Bash', input: { command: first } }, { tool: 'Bash', input: { command: next }, untilFile: gate }] });
      const { msg: card } = await window.waitFor((m) => m.type === 'control_request' && commandOf(m.request && m.request.input) === first, { label: 'the routine\'s card' });
      assert.ok(card._run && card._run.routine === run.name, 'the card is the run\'s');
      // What the window sends when "Always allow" is pressed on it.
      const key = P.toolAllowKey('Bash', card.request.input);
      assert.strictEqual(key, 'Bash:python3');
      const since = window.messages.length;
      window.send({ type: 'permission_response', requestId: card.request_id, conversationId: '', allow: true, card: true, toolInput: card.request.input });
      window.send({ type: 'add_tool_allow', key });
      await window.waitFor((m) => m.type === 'tool_allows' && m.tools.includes(key), { since, label: 'the answer saved' });
    } finally {
      window.close();
    }
    await noWindow();
    try {
      fs.writeFileSync(gate, '');
      const record = await finished(run);
      assert.strictEqual(record.status, 'succeeded', JSON.stringify(record));
      assert.deepStrictEqual(answersOf(record).map((a) => a && a.permissionDecision), ['allow', 'allow'], 'both were allowed');
      assert.deepStrictEqual(filedFor(next), [], 'the next request never waited on a card');
      assert.deepStrictEqual(cardsFor(next), [], 'and none was sent');
      assert.strictEqual(linesFor(`routine "${run.name}"`).length, 1, 'the server answered it from the saved answer');
      assert.strictEqual(record.refusedCards, undefined, 'the run counts no refused card');
    } finally {
      await revoke('Bash:python3');
    }
  });
});
