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

function runHook(payload, { preload, env = {}, timeout = 30000 } = {}) {
  const args = preload ? ['--require', preload, HOOK] : [HOOK];
  const r = spawnSync(process.execPath, args, {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: ws, session_id: 's', ...payload }),
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
  let answer = null;
  try { answer = JSON.parse(r.stdout); } catch (e) { /* asserted by the callers */ }
  return { status: r.status, stderr: r.stderr, answer };
}
// The same run with a server to talk to, which has to stay free to answer.
function runHookAgainst(port, payload, env = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [HOOK], {
      env: { ...process.env, NODE_V8_COVERAGE: '', RUNDOCK: '1', RUNDOCK_PORT: String(port), RUNDOCK_WORKSPACE: ws, RUNDOCK_CONVO_ID: '', RUNDOCK_CODE_MODE: '', RUNDOCK_TEST_SEAMS: '1', RUNDOCK_TEST_PLATFORM: 'darwin', ...env },
    });
    let out = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.on('close', (status) => {
      let answer = null;
      try { answer = JSON.parse(out); } catch (e) { /* asserted by the callers */ }
      resolve({ status, answer });
    });
    proc.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', cwd: ws, session_id: 's', ...payload }));
  });
}
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const decision = (r) => r.answer && r.answer.hookSpecificOutput && r.answer.hookSpecificOutput.permissionDecision;

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
  const preload = (name, body) => {
    const file = path.join(root, `${name}.js`);
    fs.writeFileSync(file, body);
    return file;
  };
  const throwsOnRequest = preload('throws-on-request', `
    require('http').request = () => { throw new Error('forced failure'); };
  `);
  const throwsOnLoad = preload('throws-on-load', `
    const Module = require('module');
    const load = Module._load;
    Module._load = function (request, ...rest) {
      if (String(request).endsWith('refusal-notice.js')) throw new Error('forced failure');
      return load.call(this, request, ...rest);
    };
  `);
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

  test('outside Rundock the hook decides nothing, and that holds when it cannot load', () => {
    const r = runHook(tool, { preload: throwsOnLoad, env: { RUNDOCK: '' } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(r.answer, {});
  });

  test('requiring the file adds no listener: only the hook process refuses', () => {
    const count = `process.listenerCount('uncaughtException') + process.listenerCount('beforeExit')`;
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
