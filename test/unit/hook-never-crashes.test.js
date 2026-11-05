'use strict';
// A permission hook that dies gives no answer, and the runtime carries on as
// though nothing had objected: every check in the hook is skipped for the whole
// command. So a word in a command must never be able to kill it, and whatever
// else goes wrong in it has to come out as a refusal.
//
// Each case runs the real hook as its own process, the way the runtime does.
// Port 1 refuses every connection, so a request that has to ask finds nobody to
// ask, which is what makes the fail-closed answers below observable.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync, spawn } = require('node:child_process');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-crash-')));
const ws = path.join(root, 'ws');
fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

// `raw` is sent as standard input exactly as given, for input the hook cannot
// read; `preload` may name more than one file.
function runHook(payload, { preload, env = {}, timeout = 30000, raw } = {}) {
  const args = [...[].concat(preload || []).flatMap((file) => ['--require', file]), HOOK];
  const r = spawnSync(process.execPath, args, {
    input: raw !== undefined ? raw : JSON.stringify({ hook_event_name: 'PreToolUse', cwd: ws, session_id: 's', ...payload }),
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      NODE_V8_COVERAGE: '',
      RUNDOCK: '1',
      RUNDOCK_PORT: '1',
      RUNDOCK_WORKSPACE: ws,
      RUNDOCK_CONVO_ID: '',
      RUNDOCK_CODE_MODE: '',
      // The Keychain's rules are the Mac's: this runs them on any host.
      RUNDOCK_TEST_SEAMS: '1',
      RUNDOCK_TEST_PLATFORM: 'darwin',
      ...env,
    },
  });
  // Two answers in one run do not parse as one, so `answer` is null for them.
  let answer = null;
  try { answer = JSON.parse(r.stdout); } catch (e) { /* asserted by the callers */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, answer };
}
// The same run with a server to talk to, which has to stay free to answer. A
// run still going after `timeout` is ended, and its status is then null.
function runHookAgainst(port, payload, env = {}, { preload, raw, timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    const args = [...[].concat(preload || []).flatMap((file) => ['--require', file]), HOOK];
    const proc = spawn(process.execPath, args, {
      env: { ...process.env, NODE_V8_COVERAGE: '', RUNDOCK: '1', RUNDOCK_PORT: String(port), RUNDOCK_WORKSPACE: ws, RUNDOCK_CONVO_ID: '', RUNDOCK_CODE_MODE: '', RUNDOCK_TEST_SEAMS: '1', RUNDOCK_TEST_PLATFORM: 'darwin', ...env },
    });
    const ending = setTimeout(() => proc.kill('SIGKILL'), timeout);
    let out = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.on('close', (status) => {
      clearTimeout(ending);
      let answer = null;
      try { answer = JSON.parse(out); } catch (e) { /* asserted by the callers */ }
      resolve({ status, stdout: out, answer });
    });
    proc.stdin.end(raw !== undefined ? raw : JSON.stringify({ hook_event_name: 'PreToolUse', cwd: ws, session_id: 's', ...payload }));
  });
}
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const decision = (r) => r.answer && r.answer.hookSpecificOutput && r.answer.hookSpecificOutput.permissionDecision;
const reasonOf = (r) => r.answer && r.answer.hookSpecificOutput && r.answer.hookSpecificOutput.permissionDecisionReason;

// A ROUTINE'S AGENT, which has nobody to ask, is started with no conversation
// at all (getSpawnEnv(null) in lib/runtime/claude.js takes the name out), and a
// conversation's with its id. However the hook fails, a routine is still told
// what to do next in the words every refusal tells it, and a conversation
// keeps its own. An undefined value is left out of the child's environment.
const { refusalNotice, UNATTENDED_NEXT } = require('../../scripts/refusal-notice.js');
const ROUTINE = { RUNDOCK_CONVO_ID: undefined };
const CONVERSATION = { RUNDOCK_CONVO_ID: 'c1' };
function assertRoutineWords(r) {
  assert.strictEqual(decision(r), 'deny', r.answer && JSON.stringify(r.answer));
  assert.ok(reasonOf(r).endsWith(` ${UNATTENDED_NEXT}`), `told what to do next: ${reasonOf(r)}`);
  assert.ok(!/ask the person/.test(reasonOf(r)), 'and never told to ask anyone');
}
function assertConversationWords(r) {
  assert.strictEqual(decision(r), 'deny', r.answer && JSON.stringify(r.answer));
  assert.ok(!reasonOf(r).includes(UNATTENDED_NEXT), `a conversation keeps its words: ${reasonOf(r)}`);
}

// EVERY FAILURE IN THIS FILE IS FORCED FROM OUTSIDE THE HOOK, by a file the
// test loads ahead of it with `--require` on the command line it starts the
// hook with. The hook itself has no switch for any of them, so nothing in a
// tool call's input, which reaches the hook only as the request on standard
// input, can set one off.
const preloadFile = (name, body) => {
  const file = path.join(root, `${name}.js`);
  fs.writeFileSync(file, body);
  return file;
};
const throwsOnRequest = preloadFile('throws-on-request', `
  require('http').request = () => { throw new Error('forced failure'); };
`);
const throwsOnLoad = preloadFile('throws-on-load', `
  const Module = require('module');
  const load = Module._load;
  Module._load = function (request, ...rest) {
    if (String(request).endsWith('refusal-notice.js')) throw new Error('forced failure');
    return load.call(this, request, ...rest);
  };
`);
// The hook's own wait for a card is five minutes; this shortens it for one run,
// so the code that answers is still the hook's own timeout branch.
const shortWait = preloadFile('short-wait', `
  const http = require('http');
  const request = http.request;
  http.request = function (options, ...rest) {
    return request.call(this, typeof options === 'object' ? { ...options, timeout: 300 } : options, ...rest);
  };
`);

// Every one of these holds a bracket with a range that runs backwards, which
// the shell reads as an empty range and a regular expression refuses to compile.
const BACKWARDS_RANGES = [
  `python3 -c "print(['my-app'])"`,
  'git commit -m "[z-a] fix"',
  `curl 'http://example.com/?q=[z-a]'`,
  `sed -i '' 's/[x-a]//' note.md`,
];

describe('a word in a command cannot kill the hook', () => {
  for (const command of BACKWARDS_RANGES) {
    test(`it answers for: ${command}`, () => {
      const r = runHook(bash(command));
      assert.strictEqual(r.status, 0, r.stderr);
      // Answered the ordinary way, with nobody to ask: a refusal here would be
      // the catch-all below standing in for a check that fell over.
      assert.strictEqual(decision(r), 'allow', r.answer && JSON.stringify(r.answer));
    });
  }

  // The reason it matters: the crash took the rest of the line with it.
  for (const [what, guarded] of [
    ['a Keychain read', 'security dump-keychain'],
    ['a change to .mcp.json', 'echo x > .mcp.json'],
    ['a removal Notes mode never does unasked', 'rm -rf sub'],
  ]) {
    test(`${what} is still refused with one on the same line`, () => {
      assert.strictEqual(decision(runHook(bash(guarded))), 'deny', 'the check itself has to refuse first');
      const chained = runHook(bash(`${guarded}; ${BACKWARDS_RANGES[0]}`));
      assert.strictEqual(chained.status, 0, chained.stderr);
      assert.strictEqual(decision(chained), 'deny');
    });
  }

  // The range is empty, the rest of the class is not: `.m[z-ac]p.json` is a real
  // way to spell `.mcp.json`, so a class that will not compile cannot be read as
  // matching nothing, and the refusal has to say why it is one.
  test('a glob with a backwards range still reaches the file it can name', () => {
    const r = runHook(bash('echo x > .m[z-ac]p.json'));
    assert.strictEqual(decision(r), 'deny');
    assert.match(r.answer.hookSpecificOutput.permissionDecisionReason, /decides what runs/);
  });

  test('and only that file', () => {
    assert.strictEqual(decision(runHook(bash('echo x > .q[z-ac]p.json'))), 'allow');
  });

  // The class ends where the shell says it does, and `[:alpha:]` is a class of
  // its own that a regular expression would read as a list of letters.
  //
  // Commands run under bash or zsh, and the two part ways on a class holding a
  // `[`: zsh reads `[.` and `[=` as plain members and a lone `[!]` as any one
  // character, so each of these names a protected file in at least one of them.
  for (const word of [
    '.m[[:alpha:]]p.json', '.m[z-a[:alpha:]]p.json', '.m[!]x]p.json', '.m[[.c.]]p.json', '.m[[=c=]]p.json',
    '.m[[.c.]p.json', '.m[[=c=]p.json', '.m[!]p.json', '.m[^[==]p.json', '.m[[=c]p[.=]json',
    '.rundock/permis[!]ions.json', '.rundock/st[[.a.]te.json',
  ]) {
    test(`${word} reaches the file it can name`, () => {
      assert.strictEqual(decision(runHook(bash(`echo x > ${word}`))), 'deny');
    });
  }

  test('a class with a bracket in it does not reach what it cannot name', () => {
    assert.strictEqual(decision(runHook(bash('echo x > .q[[:alpha:]]p.json'))), 'allow');
  });

  // Each star can match nothing, so a regular expression tries every way of
  // sharing a name between them, and a hook out of time gives no answer either.
  test('a word made of stars cannot stall the hook', () => {
    const r = runHook(bash(`security dump-keychain; rm .rundock/${'*'.repeat(40)}z`), { timeout: 10000 });
    assert.strictEqual(r.status, 0, 'the hook ran out of time');
    assert.strictEqual(decision(r), 'deny');
  });

  test('the same word in a routine is refused in the routine\'s words, and in a conversation in its own', () => {
    const command = bash(`security dump-keychain; rm .rundock/${'*'.repeat(40)}z`);
    const routine = runHook(command, { timeout: 10000, env: ROUTINE });
    assert.strictEqual(routine.status, 0, 'the hook ran out of time');
    assertRoutineWords(routine);
    const conversation = runHook(command, { timeout: 10000, env: CONVERSATION });
    assert.strictEqual(conversation.status, 0, 'the hook ran out of time');
    assertConversationWords(conversation);
  });
});

describe('a reply cut short is not an answer', () => {
  // Headers, then nothing: no `end`, no error, and the process simply runs out
  // of things to wait for, with nothing said.
  const cutsOff = (url) => new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      if (!req.url.startsWith(url)) { res.end('{}'); return; }
      res.writeHead(200, { 'Content-Length': '100' });
      res.flushHeaders();
      res.write('{');
      setImmediate(() => req.socket.destroy());
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
  const close = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });

  for (const [what, payload] of [
    ['a Keychain read', bash('security dump-keychain')],
    ['a connector send', { tool_name: 'mcp__example__send_message', tool_input: {} }],
    ['a change to .mcp.json', bash('echo x > .mcp.json')],
  ]) {
    test(`${what} is refused when the card's reply never finishes`, async () => {
      const server = await cutsOff('/api/permission-request');
      try {
        const r = await runHookAgainst(server.address().port, payload);
        assert.strictEqual(r.status, 0);
        assert.strictEqual(decision(r), 'deny');
      } finally { await close(server); }
    });
  }

  test('a routine whose card reply never finishes is refused in the routine\'s words, a conversation in its own', async () => {
    const server = await cutsOff('/api/permission-request');
    try {
      const port = server.address().port;
      const routine = await runHookAgainst(port, bash('security dump-keychain'), ROUTINE);
      assert.strictEqual(routine.status, 0);
      assertRoutineWords(routine);
      const conversation = await runHookAgainst(port, bash('security dump-keychain'), CONVERSATION);
      assert.strictEqual(conversation.status, 0);
      assertConversationWords(conversation);
    } finally { await close(server); }
  });

  // A card nobody answers and a server that never replies: the hook's own
  // wait runs out (shortened for this run by the short-wait preload).
  test('a routine whose card is never answered at all is refused, in the routine\'s words, when the hook stops waiting', async () => {
    const held = [];
    const server = await new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        req.resume();
        if (!req.url.startsWith('/api/permission-request')) { res.end('{}'); return; }
        held.push(res);
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const run = (env) => new Promise((resolve) => {
      const proc = spawn(process.execPath, ['--require', shortWait, HOOK], {
        env: { ...process.env, NODE_V8_COVERAGE: '', RUNDOCK: '1', RUNDOCK_PORT: String(server.address().port), RUNDOCK_WORKSPACE: ws, RUNDOCK_CODE_MODE: '', RUNDOCK_TEST_SEAMS: '1', RUNDOCK_TEST_PLATFORM: 'darwin', ...env },
      });
      let out = '';
      proc.stdout.on('data', (c) => { out += c; });
      proc.on('close', (status) => {
        let answer = null;
        try { answer = JSON.parse(out); } catch (e) { /* asserted below */ }
        resolve({ status, answer });
      });
      proc.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', cwd: ws, session_id: 's', ...bash('security dump-keychain') }));
    });
    try {
      const routine = await run(ROUTINE);
      assert.strictEqual(routine.status, 0);
      assert.strictEqual(held.length, 1, 'the card reached the server and was held there');
      assert.strictEqual(decision(routine), 'deny');
      assert.strictEqual(reasonOf(routine), refusalNotice('timeout', 'Bash', { unattended: true }));
      const conversation = await run(CONVERSATION);
      assert.strictEqual(decision(conversation), 'deny');
      assert.strictEqual(reasonOf(conversation), refusalNotice('timeout', 'Bash'));
    } finally { await close(server); }
  });

  test('the same when the notice ahead of it never finishes', async () => {
    const server = await cutsOff('/api/agent-notice');
    try {
      const r = await runHookAgainst(server.address().port, bash('security dump-keychain'), { RUNDOCK_CONVO_ID: 'c1' });
      assert.strictEqual(decision(r), 'deny');
    } finally { await close(server); }
  });

  // The notice is only ever a line for the agent: losing it changes no answer.
  test('a notice cut short does not refuse an ordinary call', async () => {
    const server = await cutsOff('/api/agent-notice');
    try {
      const r = await runHookAgainst(server.address().port,
        { tool_name: 'Read', tool_input: { file_path: path.join(ws, 'note.md') } }, { RUNDOCK_CONVO_ID: 'c1' });
      assert.strictEqual(decision(r), 'allow');
    } finally { await close(server); }
  });

  test('a finished tool still decides nothing', async () => {
    const server = await cutsOff('/api/agent-notice');
    try {
      const r = await runHookAgainst(server.address().port,
        { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo x' }, tool_response: {} }, { RUNDOCK_CONVO_ID: 'c1' });
      assert.deepStrictEqual(r.answer, {});
    } finally { await close(server); }
  });
});

describe('anything else that goes wrong in the hook is a refusal', () => {
  const tool = { tool_name: 'mcp__example__update_thing', tool_input: {} };

  test('a failure while judging a tool call refuses it, and says why', () => {
    const r = runHook(tool, { preload: throwsOnRequest });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(decision(r), 'deny');
    assert.match(r.answer.hookSpecificOutput.permissionDecisionReason, /refused/);
  });

  test('a hook that cannot even load refuses too', () => {
    const r = runHook(tool, { preload: throwsOnLoad });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(decision(r), 'deny');
  });

  test('a routine is refused in the routine\'s words when judging fails, a conversation in the words it had', () => {
    assertRoutineWords(runHook(tool, { preload: throwsOnRequest, env: ROUTINE }));
    const conversation = runHook(tool, { preload: throwsOnRequest, env: CONVERSATION });
    assertConversationWords(conversation);
    assert.strictEqual(reasonOf(conversation), 'Rundock could not check this request, so it was refused rather than approved on your behalf.');
  });

  test('and the same when the hook cannot even load', () => {
    assertRoutineWords(runHook(tool, { preload: throwsOnLoad, env: ROUTINE }));
    const conversation = runHook(tool, { preload: throwsOnLoad, env: CONVERSATION });
    assertConversationWords(conversation);
    assert.strictEqual(reasonOf(conversation), 'Rundock could not check this request, so it was refused rather than approved on your behalf.');
  });

  // The hook that cannot load cannot require the wording either, so it holds
  // its own copy; the two must never drift apart.
  test('the copy a hook that cannot load uses is the sentence every refusal uses', () => {
    assert.strictEqual(require(HOOK).UNATTENDED_NEXT_UNLOADED, UNATTENDED_NEXT);
  });

  test('outside Rundock the hook decides nothing, and that holds when it cannot load', () => {
    const r = runHook(tool, { preload: throwsOnLoad, env: { RUNDOCK: '' } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(r.answer, {});
  });

  test('requiring the file adds no listener: only the hook process refuses', () => {
    const count = `process.listenerCount('uncaughtException') + process.listenerCount('unhandledRejection') + process.listenerCount('beforeExit')`;
    const r = spawnSync(process.execPath, ['-e', `const before = ${count}; require(${JSON.stringify(HOOK)}); console.log(${count} - before);`],
      { encoding: 'utf8', env: { ...process.env, NODE_V8_COVERAGE: '' } });
    assert.strictEqual(r.stdout.trim(), '0', r.stderr);
  });

  test('a failure after a tool has finished decides nothing', () => {
    const r = runHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo x' }, tool_response: {} },
      { preload: throwsOnRequest, env: { RUNDOCK_CONVO_ID: 'c1' } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(r.answer, {});
  });
});

// ===== A REJECTION NOBODY HANDLES, AND INPUT THE HOOK CANNOT READ =====

// What any request the hook could not check is refused with, in a
// conversation; a routine's refusal goes on to say what to do next.
const COULD_NOT_CHECK = 'Rundock could not check this request, so it was refused rather than approved on your behalf.';
const couldNotCheck = (unattended) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: unattended ? `${COULD_NOT_CHECK} ${UNATTENDED_NEXT}` : COULD_NOT_CHECK,
  },
});
// A call the hook allows on its own when nobody can be asked (port 1 refuses
// every connection), and one it refuses on its own.
const ORDINARY = { tool_name: 'mcp__example__update_thing', tool_input: {} };
const GUARDED = bash('security dump-keychain');

// A rejection nobody handles, raised as the hook starts asking the server
// anything: the agent's notice in a conversation, the card in a routine.
const rejectsOnRequest = preloadFile('rejects-on-request', `
  const http = require('http');
  const request = http.request;
  http.request = function (...args) {
    Promise.reject(new Error('forced rejection'));
    return request.apply(this, args);
  };
`);
// The hook answers and asks to exit, and is held there for a moment in which a
// rejection, or an error, arrives. Nothing in the hook runs between an answer
// and its exit, so only a test can put anything in that moment.
const afterTheAnswer = (name, raise) => preloadFile(name, `
  const exit = process.exit;
  process.exit = function () {
    process.exit = exit;
    ${raise}
  };
`);
const rejectionAfterAnswer = afterTheAnswer('rejection-after-answer', `Promise.reject(new Error('forced rejection after the answer'));`);
const errorAfterAnswer = afterTheAnswer('error-after-answer', `process.nextTick(() => { throw new Error('forced error after the answer'); });`);
// Every mode NODE_OPTIONS can name for what the runtime does with a rejection.
const REJECTION_MODES = ['throw', 'strict', 'warn', 'warn-with-error-code', 'none'];
const rejections = (mode) => ({ NODE_OPTIONS: `--unhandled-rejections=${mode}` });

describe('a rejection nobody handles is a refusal, whatever the runtime is told to do with one', () => {
  // The runtime's default turns an unhandled rejection into an exception,
  // which the hook already refused. NODE_OPTIONS, inherited from wherever
  // Rundock was started, can tell it to warn instead, or to say nothing at
  // all, and the hook then carried on and allowed the call as though nothing
  // had gone wrong. In every mode a rejection after the answer adds nothing.
  for (const mode of REJECTION_MODES) {
    test(`under --unhandled-rejections=${mode}, a rejection before the answer refuses, and one after it adds nothing`, () => {
      const refused = runHook(ORDINARY, { preload: rejectsOnRequest, env: rejections(mode) });
      assert.strictEqual(refused.status, 0, refused.stderr);
      assert.deepStrictEqual(refused.answer, couldNotCheck(true), refused.stdout);
      const kept = runHook(GUARDED, { preload: rejectionAfterAnswer, env: rejections(mode) });
      assert.strictEqual(kept.status, 0, kept.stderr);
      assert.strictEqual(decision(kept), 'deny', `one answer, the hook's own: ${kept.stdout}`);
      assert.match(reasonOf(kept), /Keychain/);
    });
  }
});

describe('the hook gives one answer for each call', () => {
  test('an error arriving after the answer is written prints no second one, and a refusal stays a refusal', () => {
    const refused = runHook(GUARDED, { preload: errorAfterAnswer });
    assert.strictEqual(refused.status, 0, refused.stderr);
    assert.strictEqual(decision(refused), 'deny', `one answer, the hook's own: ${refused.stdout}`);
    assert.match(reasonOf(refused), /Keychain/);
    const allowed = runHook(ORDINARY, { preload: errorAfterAnswer });
    assert.strictEqual(allowed.status, 0, allowed.stderr);
    assert.strictEqual(decision(allowed), 'allow', `one answer, the hook's own: ${allowed.stdout}`);
  });
});
