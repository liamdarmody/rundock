'use strict';
// A REQUEST THE PERMISSION HOOK CANNOT NAME, OR WHOSE INPUT IT CANNOT READ.
//
// Every check in the hook keys on the tool name, and the file, shell and
// connector checks read the tool's input as well. A request with no usable
// name, or a file, shell or connector tool whose input is not an object,
// matched none of them, so nothing marked it as one to refuse: with Rundock
// unreachable it was allowed as ordinary access, in Code mode it was allowed
// at once, and with Rundock reachable a card was raised for a request that
// named no tool. Inside Rundock each is now refused before Rundock is asked,
// in the words of any request the hook could not check.
//
// Each case runs the real hook as its own process, the way the runtime does.
// Port 1 refuses every connection, so a request that has to ask finds nobody
// to ask, which is when an ordinary request is allowed.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { refusalNotice, UNATTENDED_NEXT } = require('../../scripts/refusal-notice.js');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-unnamed-')));
const ws = path.join(root, 'ws');
fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

// A request as the runtime sends one, with `fields` in it.
const request = (fields) => JSON.stringify({ hook_event_name: 'PreToolUse', cwd: ws, session_id: 's', ...fields });

// Runs the hook on `raw`, sent as standard input exactly as given. A run still
// going after `timeout` is ended, and its status is then null. `gone` closes
// standard output before the hook writes, as a runtime that has stopped
// listening does, so the run is its exit status and its standard error.
function runHook(raw, { port = 1, env = {}, preload, timeout = 30000, gone = false } = {}) {
  return new Promise((resolve) => {
    const args = [...[].concat(preload || []).flatMap((file) => ['--require', file]), HOOK];
    const proc = spawn(process.execPath, args, {
      env: { ...process.env, NODE_V8_COVERAGE: '', RUNDOCK: '1', RUNDOCK_PORT: String(port), RUNDOCK_WORKSPACE: ws, RUNDOCK_CONVO_ID: '', RUNDOCK_CODE_MODE: '', RUNDOCK_TEST_SEAMS: '1', RUNDOCK_TEST_PLATFORM: 'darwin', ...env },
    });
    const ending = setTimeout(() => proc.kill('SIGKILL'), timeout);
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.on('data', (c) => { err += c; });
    proc.on('close', (status) => {
      clearTimeout(ending);
      let answer = null;
      try { answer = JSON.parse(out); } catch (e) { /* asserted by the callers */ }
      resolve({ status, stdout: out, stderr: err, answer });
    });
    const send = () => proc.stdin.end(raw);
    if (gone) {
      proc.stdout.on('close', send);
      proc.stdout.destroy();
    } else send();
  });
}
const decision = (r) => r.answer && r.answer.hookSpecificOutput && r.answer.hookSpecificOutput.permissionDecision;
const reasonOf = (r) => r.answer && r.answer.hookSpecificOutput && r.answer.hookSpecificOutput.permissionDecisionReason;

// A Rundock to ask. The line it left for this conversation's agent is handed
// over once, to whichever answer asks for it first; every card is answered
// with `card`, or held unanswered when `card` is null. Every request is
// recorded by its path, so a test can say nothing was asked, and every card by
// what it carried.
const NOTE = 'A line Rundock left for this agent.';
function rundock({ card = { allow: true } } = {}) {
  return new Promise((resolve) => {
    const asked = [];
    const cards = [];
    const notes = [NOTE];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        asked.push(req.url.split('?')[0]);
        if (req.url.startsWith('/api/agent-notice')) { res.end(JSON.stringify({ text: notes.shift() || '' })); return; }
        try { cards.push(JSON.parse(body)); } catch (e) { cards.push(body); }
        if (card) res.end(JSON.stringify(card));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      asked,
      cards,
      close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
    }));
  });
}

// A ROUTINE'S AGENT is started with no conversation (an undefined value is
// left out of the child's environment), a conversation's with its id.
const ROUTINE = { RUNDOCK_CONVO_ID: undefined };
const CONVERSATION = { RUNDOCK_CONVO_ID: 'c1' };
const CODE_MODE = { RUNDOCK_CODE_MODE: '1' };
const OUTSIDE = { RUNDOCK: '' };

// What any request the hook could not check is refused with.
const COULD_NOT_CHECK = 'Rundock could not check this request, so it was refused rather than approved on your behalf.';
const couldNotCheck = (unattended) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: unattended ? `${COULD_NOT_CHECK} ${UNATTENDED_NEXT}` : COULD_NOT_CHECK,
  },
});

// A request with no tool name the hook can read: the four the change was
// asked for exactly as written, then the same as the runtime would send them,
// beside the input of a command.
const NAMELESS = [
  ['{}', '{}'],
  ['{"tool_name": 7}', '{"tool_name": 7}'],
  ['{"tool_name": ""}', '{"tool_name": ""}'],
  ['{"tool_name": "  "}', '{"tool_name": "  "}'],
  ['a request with no tool name', request({ tool_input: { command: 'ls' } })],
  ['a request whose tool name is null', request({ tool_name: null, tool_input: { command: 'ls' } })],
  ['a request whose tool name is a list', request({ tool_name: ['Bash'], tool_input: { command: 'ls' } })],
  ['a request whose tool name is only a tab and a new line', request({ tool_name: '\t\n', tool_input: { command: 'ls' } })],
];
// A tool whose checks read its input, with input that is missing or is not an
// object: each shell tool, file tools that write, read and search, and
// connector actions that ask and that are read with no card.
const NO_INPUT = [
  ['Bash with no input', request({ tool_name: 'Bash' })],
  ['Bash whose input is the command as a string', request({ tool_name: 'Bash', tool_input: 'rm -rf ~/notes' })],
  ['PowerShell whose input is null', request({ tool_name: 'PowerShell', tool_input: null })],
  ['Write with no input', request({ tool_name: 'Write' })],
  ['Edit whose input is a list', request({ tool_name: 'Edit', tool_input: [path.join(ws, 'note.md')] })],
  ['Read whose input is a string', request({ tool_name: 'Read', tool_input: '/etc/hosts' })],
  ['Glob with no input', request({ tool_name: 'Glob' })],
  ['a connector action with no input', request({ tool_name: 'mcp__example__update_thing' })],
  ['a connector read whose input is a number', request({ tool_name: 'mcp__example__list_things', tool_input: 7 })],
];
// A tool whose checks read no input, given none: judged as it always was.
const NO_INPUT_READ = [
  ['WebFetch with no input', request({ tool_name: 'WebFetch' }), 'WebFetch'],
  ['TodoWrite whose input is a string', request({ tool_name: 'TodoWrite', tool_input: 'x' }), 'TodoWrite'],
];
// Well-formed requests, and the answer each gets with nobody to ask.
const ORDINARY = request({ tool_name: 'Bash', tool_input: { command: 'ls' } });
const WELL_FORMED = [
  ['an ordinary command', ORDINARY, 'allow', 'Rundock server unreachable.'],
  ['a file inside the workspace', request({ tool_name: 'Read', tool_input: { file_path: path.join(ws, 'note.md') } }), 'allow', 'In-workspace file access'],
  ['a connector read', request({ tool_name: 'mcp__example__list_things', tool_input: {} }), 'allow', 'Auto-approved: MCP read'],
  ['a Keychain read', request({ tool_name: 'Bash', tool_input: { command: 'security dump-keychain' } }), 'deny', /Keychain/],
  ['a connector send', request({ tool_name: 'mcp__example__send_message', tool_input: {} }), 'deny', /sends, replies, forwards/],
];

describe('a request with no usable tool name is refused inside Rundock', () => {
  test('a request with no usable tool name, with nobody to ask, is refused in Notes mode and Code mode, a routine and a conversation each in their own words', async () => {
    for (const [what, raw] of NAMELESS) {
      for (const [kind, env, unattended] of [['a routine', ROUTINE, true], ['a conversation', CONVERSATION, false], ['Code mode', { ...ROUTINE, ...CODE_MODE }, true]]) {
        const r = await runHook(raw, { env });
        assert.strictEqual(r.status, 0, `${what}, ${kind}: ${r.stderr}`);
        assert.deepStrictEqual(r.answer, couldNotCheck(unattended), `${what}, ${kind}: ${r.stdout}`);
      }
    }
  });

  test('a request with no usable tool name is refused before Rundock is asked: no card, and the line left for the agent stays', async () => {
    for (const [what, raw] of NAMELESS) {
      const server = await rundock({ card: { allow: true } });
      try {
        const r = await runHook(raw, { port: server.port, env: CONVERSATION });
        assert.strictEqual(r.status, 0, `${what}: ${r.stderr}`);
        assert.deepStrictEqual(r.answer, couldNotCheck(false), `${what}: ${r.stdout}`);
        assert.deepStrictEqual(server.asked, [], `${what}: nothing was asked of Rundock`);
      } finally { await server.close(); }
    }
  });
});

describe('a request whose input the hook cannot read is refused inside Rundock', () => {
  test('a file, shell or connector tool whose input is missing or not an object, with nobody to ask, is refused in Notes mode and Code mode, a routine and a conversation each in their own words', async () => {
    for (const [what, raw] of NO_INPUT) {
      for (const [kind, env, unattended] of [['a routine', ROUTINE, true], ['a conversation', CONVERSATION, false], ['Code mode', { ...ROUTINE, ...CODE_MODE }, true]]) {
        const r = await runHook(raw, { env });
        assert.strictEqual(r.status, 0, `${what}, ${kind}: ${r.stderr}`);
        assert.deepStrictEqual(r.answer, couldNotCheck(unattended), `${what}, ${kind}: ${r.stdout}`);
      }
    }
  });

  test('a file, shell or connector tool whose input is missing or not an object is refused before Rundock is asked', async () => {
    for (const [what, raw] of NO_INPUT) {
      const server = await rundock({ card: { allow: true } });
      try {
        const r = await runHook(raw, { port: server.port, env: CONVERSATION });
        assert.strictEqual(r.status, 0, `${what}: ${r.stderr}`);
        assert.deepStrictEqual(r.answer, couldNotCheck(false), `${what}: ${r.stdout}`);
        assert.deepStrictEqual(server.asked, [], `${what}: nothing was asked of Rundock`);
      } finally { await server.close(); }
    }
  });

  test('a tool whose checks read no input is judged as before: allowed with nobody to ask, and carded when Rundock can be asked', async () => {
    for (const [what, raw, name] of NO_INPUT_READ) {
      const alone = await runHook(raw);
      assert.strictEqual(decision(alone), 'allow', `${what}: ${alone.stdout}`);
      assert.strictEqual(reasonOf(alone), 'Rundock server unreachable.', what);
      const server = await rundock({ card: { allow: false } });
      try {
        const r = await runHook(raw, { port: server.port });
        assert.strictEqual(decision(r), 'deny', `${what}: ${r.stdout}`);
        assert.strictEqual(reasonOf(r), refusalNotice('denied', name, { unattended: true }), what);
        assert.deepStrictEqual(server.asked, ['/api/permission-request'], what);
        assert.strictEqual(server.cards[0].tool_name, name, `${what}: the card names the tool`);
      } finally { await server.close(); }
    }
  });
});

describe('outside Rundock, and after a tool has run, nothing changes', () => {
  test('outside Rundock each passes through, and nothing is asked', async () => {
    const server = await rundock();
    try {
      for (const [what, raw] of [...NAMELESS, ...NO_INPUT]) {
        const r = await runHook(raw, { port: server.port, env: { ...CONVERSATION, ...OUTSIDE } });
        assert.strictEqual(r.status, 0, `${what}: ${r.stderr}`);
        assert.deepStrictEqual(r.answer, {}, `${what}: ${r.stdout}`);
      }
      assert.deepStrictEqual(server.asked, []);
    } finally { await server.close(); }
  });

  // A finished tool has nothing left to refuse: the server is asked whether it
  // put a change back, and the line it left for the agent is handed over.
  test('a finished or failed tool with no tool name, or no input, is answered as it always was', async () => {
    for (const [what, fields] of [
      ['a finished tool with no tool name', { hook_event_name: 'PostToolUse', tool_response: { stderr: '' } }],
      ['a finished tool whose tool name is empty', { hook_event_name: 'PostToolUse', tool_name: '', tool_response: {} }],
      ['a failed tool with no tool name', { hook_event_name: 'PostToolUseFailure', error: 'x' }],
      ['a finished command with no input', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: {} }],
    ]) {
      const raw = JSON.stringify({ cwd: ws, session_id: 's', ...fields });
      const server = await rundock();
      try {
        const r = await runHook(raw, { port: server.port, env: CONVERSATION });
        assert.strictEqual(r.status, 0, `${what}: ${r.stderr}`);
        assert.deepStrictEqual(r.answer, { hookSpecificOutput: { hookEventName: fields.hook_event_name, additionalContext: NOTE } }, `${what}: ${r.stdout}`);
        assert.deepStrictEqual(server.asked, ['/api/agent-notice'], what);
      } finally { await server.close(); }
      const alone = await runHook(raw, { env: CONVERSATION });
      assert.strictEqual(alone.status, 0, `${what}: ${alone.stderr}`);
      assert.deepStrictEqual(alone.answer, {}, `${what}, with nobody to ask: ${alone.stdout}`);
    }
  });
});

describe('the five sequences', () => {
  // 1. THE INVERSE ACTION: a request the hook can name and read is judged
  // exactly as before, with Rundock reachable and unreachable.
  test('a well-formed request is judged as before, with nobody to ask and with Rundock to ask', async () => {
    for (const [what, raw, said, why] of WELL_FORMED) {
      const r = await runHook(raw);
      assert.strictEqual(r.status, 0, `${what}: ${r.stderr}`);
      assert.strictEqual(decision(r), said, `${what}: ${r.stdout}`);
      if (typeof why === 'string') assert.strictEqual(reasonOf(r), why, what);
      else assert.match(reasonOf(r), why, what);
    }
    const server = await rundock({ card: { allow: false } });
    try {
      const r = await runHook(ORDINARY, { port: server.port });
      assert.strictEqual(decision(r), 'deny', r.stdout);
      assert.strictEqual(reasonOf(r), refusalNotice('denied', 'Bash', { unattended: true }));
      assert.deepStrictEqual(server.asked, ['/api/permission-request']);
      assert.strictEqual(server.cards[0].tool_name, 'Bash');
      assert.deepStrictEqual(server.cards[0].tool_input, { command: 'ls' });
    } finally { await server.close(); }
  });

  // 2. THE UNDO: Rundock coming back changes nothing about the answer.
  test('a request refused while Rundock is unreachable is still refused, without asking it, once Rundock is back', async () => {
    for (const [, raw] of [NAMELESS[0], NO_INPUT[0]]) {
      const before = await runHook(raw, { env: CONVERSATION });
      assert.deepStrictEqual(before.answer, couldNotCheck(false), before.stdout);
      const server = await rundock();
      try {
        const back = await runHook(raw, { port: server.port, env: CONVERSATION });
        assert.strictEqual(back.stdout, before.stdout, 'the same answer, word for word');
        assert.deepStrictEqual(server.asked, [], 'and Rundock was not asked');
      } finally { await server.close(); }
    }
  });

  // 3. THE RETRY: the same request is refused again, in the same words.
  test('the same request sent twice is refused twice, in the same words, and raises no card either time', async () => {
    for (const [what, raw] of [NAMELESS[0], NO_INPUT[0]]) {
      for (const env of [ROUTINE, CONVERSATION]) {
        const server = await rundock();
        try {
          const first = await runHook(raw, { port: server.port, env });
          const again = await runHook(raw, { port: server.port, env });
          assert.strictEqual(decision(first), 'deny', `${what}: ${first.stdout}`);
          assert.strictEqual(again.status, 0, again.stderr);
          assert.strictEqual(again.stdout, first.stdout, what);
          assert.deepStrictEqual(server.asked, [], `${what}: no card, either time`);
        } finally { await server.close(); }
      }
    }
  });

  // 4. THE MOST COMMON NEXT STEP: the agent's next request, in the same
  // session, is judged as it would have been. Nothing carries over.
  test('after a refused request, the next well-formed one in the same session is judged as usual, and gets the line left for the agent', async () => {
    for (const [what, raw] of [NAMELESS[0], NO_INPUT[0]]) {
      const server = await rundock({ card: { allow: true } });
      try {
        const refused = await runHook(raw, { port: server.port, env: CONVERSATION });
        assert.deepStrictEqual(refused.answer, couldNotCheck(false), `${what}: ${refused.stdout}`);
        const next = await runHook(ORDINARY, { port: server.port, env: CONVERSATION });
        assert.strictEqual(next.status, 0, next.stderr);
        assert.deepStrictEqual(next.answer, { hookSpecificOutput: {
          hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Approved in Rundock', additionalContext: NOTE,
        } }, `${what}: ${next.stdout}`);
        assert.deepStrictEqual(server.asked, ['/api/agent-notice', '/api/permission-request'], what);
      } finally { await server.close(); }
    }
  });
});

// 5. THE CONTROL FAILING. Every failure here is forced from outside the hook,
// by a file the test loads ahead of it with `--require`, never by a switch in
// the hook.
const preloadFile = (name, body) => {
  const file = path.join(root, `${name}.js`);
  fs.writeFileSync(file, body);
  return file;
};
// The first read of the request's tool name throws, and every read after it
// gives the name back, so a check that carried on past its own failure would
// go on to judge the request, and allow an ordinary one with nobody to ask.
const nameReadThrowsOnce = preloadFile('name-read-throws-once', `
  const parse = JSON.parse;
  let thrown = false;
  JSON.parse = function (...args) {
    const value = parse.apply(this, args);
    if (!thrown && value && typeof value === 'object' && !Array.isArray(value) && 'hook_event_name' in value && 'tool_name' in value) {
      const name = value.tool_name;
      Object.defineProperty(value, 'tool_name', { configurable: true, enumerable: true, get() {
        if (!thrown) { thrown = true; throw new Error('forced failure in the name check'); }
        return name;
      } });
    }
    return value;
  };
`);

describe('the check failing fails closed', () => {
  test('a check that throws refuses the request inside Rundock, a routine and a conversation each in their own words, and passes it through outside', async () => {
    for (const [what, raw] of [['an ordinary command', ORDINARY], ['an empty tool name', request({ tool_name: '', tool_input: { command: 'ls' } })]]) {
      for (const [env, unattended] of [[ROUTINE, true], [CONVERSATION, false]]) {
        const r = await runHook(raw, { preload: nameReadThrowsOnce, env });
        assert.strictEqual(r.status, 0, `${what}: ${r.stderr}`);
        assert.deepStrictEqual(r.answer, couldNotCheck(unattended), `${what}: ${r.stdout}`);
      }
      const outside = await runHook(raw, { preload: nameReadThrowsOnce, env: OUTSIDE });
      assert.strictEqual(outside.status, 0, outside.stderr);
      assert.deepStrictEqual(outside.answer, {}, `${what}, outside Rundock: ${outside.stdout}`);
    }
  });

  test('a Rundock that never answers does not hold the request: it is refused at once, and nothing is asked', async () => {
    const server = await rundock({ card: null });
    try {
      for (const [what, raw] of [NAMELESS[0], NO_INPUT[0]]) {
        const r = await runHook(raw, { port: server.port, env: CONVERSATION, timeout: 10000 });
        assert.strictEqual(r.status, 0, `${what}: the hook was left waiting on Rundock`);
        assert.deepStrictEqual(r.answer, couldNotCheck(false), `${what}: ${r.stdout}`);
      }
      assert.deepStrictEqual(server.asked, []);
    } finally { await server.close(); }
  });

  test('the request cut off is refused, and a refusal that cannot be written ends in the runtime\'s block with its reason', async () => {
    for (const [, raw] of [NAMELESS[4], NO_INPUT[0]]) {
      const cut = await runHook(raw.slice(0, -1), { env: CONVERSATION });
      assert.deepStrictEqual(cut.answer, couldNotCheck(false), cut.stdout);
      const gone = await runHook(raw, { env: CONVERSATION, gone: true });
      assert.strictEqual(gone.status, 2, gone.stderr);
      assert.strictEqual(gone.stderr.trim(), COULD_NOT_CHECK);
    }
  });
});
