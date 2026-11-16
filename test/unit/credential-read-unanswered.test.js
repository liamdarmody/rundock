'use strict';
// A SIGN-IN CREDENTIAL IS NEVER READ WHEN RUNDOCK CANNOT BE ASKED.
//
// The files the secrets registry names hold the runtimes' own sign-in. With the
// server reachable, a read of one draws the secret card. With no answer to be
// had (the server is unreachable, or its reply does not parse) a read used to
// be allowed in Notes mode, and in Code mode for the files under a runtime
// home, with nothing underneath to stop it: the sandbox denies writes to those
// files, not reads, and the file tools do not run in the sandbox. Every test
// here spawns the real hook the way the runtime does, with a made-up home
// folder and a port nothing listens on, and the credential cases iterate the
// registry, so an entry added later is covered without a new test.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { secretsRegistry, runtimeHomes } = require('../../scripts/permission-hook.js');
const { unansweredNotice, UNATTENDED_NEXT } = require('../../scripts/refusal-notice.js');
// A port nothing listens on: Rundock has quit, crashed or is restarting.
const { closedPort } = require('../helpers/code-mode-fixture.js');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');

const UNREACHABLE = 'Rundock server unreachable.';
const UNPARSED = 'Rundock hook: could not parse server response.';
const CREDENTIAL = 'This reads or changes a sign-in credential, and it is never done without asking, so it was refused rather than approved on your behalf.';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'credential-read-unanswered-')));
const home = path.join(root, 'home');
const ws = path.join(root, 'ws');
for (const d of [path.join(home, '.claude'), path.join(home, '.codex'), ws]) fs.mkdirSync(d, { recursive: true });
const REGISTRY = secretsRegistry(home);
for (const f of REGISTRY) fs.writeFileSync(f, '{}\n');

// The shell commands are POSIX spellings.
const POSIX = process.platform === 'win32' ? 'the shell commands here are POSIX' : false;
const MODES = [['Notes mode', 'notes'], ['Code mode', 'code']];
const normal = v => JSON.parse(JSON.stringify(v).split(root).join('<root>'));
const named = ([tool, input]) => `${tool} ${JSON.stringify(normal(input))}`;
const said = got => (got.answer && got.answer.hookSpecificOutput) || {};

// Each credential file, read every way an agent reads one.
const fileReads = f => [['Read', { file_path: f }], ['Grep', { pattern: 'token', path: f }], ['Glob', { pattern: '*', path: f }]];
const shellReads = f => [['Bash', { command: `cat ${f}` }], ['Bash', { command: `head ${f}` }], ['Bash', { command: `cp ${f} ${path.join(ws, 'copy.json')}` }]];
const everyRead = f => [...fileReads(f), ...(POSIX ? [] : shellReads(f))];

// Code mode already refused some credential reads with nobody to ask, as a
// crossing it asks about every time: a file directly in the home folder, which
// is a hidden place there, and a copy, which writes. Those keep their words,
// so Code mode's wording cases are the reads of the files under a runtime home.
const underRuntimeHome = f => runtimeHomes(home).some(h => f.startsWith(h.root + path.sep));
const WORDED = {
  notes: REGISTRY.flatMap(everyRead),
  code: REGISTRY.filter(underRuntimeHome).flatMap(f => [...fileReads(f), ...(POSIX ? [] : shellReads(f).slice(0, 2))]),
};

let garbled;
let closed;
let runs = 0;

// A server that answers card requests with `reply`, and nothing else.
function listen(reply) {
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (!req.url.startsWith('/api/permission-request')) { res.statusCode = 404; res.end(); return; }
      reply(body, res);
    });
  });
  return new Promise(r => s.listen(0, '127.0.0.1', () => r(s)));
}
before(async () => {
  garbled = await listen((body, res) => res.end('this is not a reply'));
  closed = await closedPort();
});
after(async () => {
  if (garbled) await new Promise(r => garbled.close(r));
  fs.rmSync(root, { recursive: true, force: true });
});
const portOf = s => s.address().port;

// The real hook, given one tool call, as the runtime spawns it. A routine has
// no conversation id; a conversation has one.
function run(tool, input, { port, mode, convo = '', session = `s${++runs}` }) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [HOOK], {
      cwd: ws,
      env: {
        ...process.env, HOME: home, USERPROFILE: home, NODE_V8_COVERAGE: '',
        RUNDOCK: '1', RUNDOCK_PORT: String(port), RUNDOCK_WORKSPACE: ws, RUNDOCK_CONVO_ID: convo,
        RUNDOCK_CODE_MODE: mode === 'code' ? '1' : '', RUNDOCK_EXTRA_DIRS: '', RUNDOCK_HOOK_TOKEN: '',
        RUNDOCK_TEST_SEAMS: '', RUNDOCK_TEST_PLATFORM: '',
      },
    });
    let out = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.on('close', () => {
      let answer = null;
      try { answer = JSON.parse(out); } catch (e) { /* asserted by the caller */ }
      resolve(normal({ answer }));
    });
    proc.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', cwd: ws, session_id: session, tool_name: tool, tool_input: input }));
  });
}

// Every case, eight hooks at a time.
async function each(cases, fn) {
  const out = new Array(cases.length);
  let next = 0;
  const worker = async () => { while (next < cases.length) { const i = next++; out[i] = await fn(cases[i], i); } };
  await Promise.all(Array.from({ length: Math.min(8, cases.length) }, worker));
  return out;
}

// Every case refused with Rundock unreachable, listing each one that was not.
async function assertRefused(cases, mode) {
  assert.ok(cases.length > 0, 'the registry names credential files');
  const got = await each(cases, ([tool, input]) => run(tool, input, { port: closed, mode }));
  const notRefused = cases.map((c, i) => [c, said(got[i])])
    .filter(([, o]) => o.permissionDecision !== 'deny' || !o.permissionDecisionReason.startsWith(`${UNREACHABLE} `))
    .map(([c, o]) => `${named(c)}: ${o.permissionDecision}: ${o.permissionDecisionReason}`);
  assert.deepStrictEqual(notRefused, []);
}

describe('with Rundock unreachable, every read of a credential file is refused', () => {
  for (const [label, mode] of MODES) {
    test(`${label}: Read, Grep and Glob of each credential file are refused`, () => assertRefused(REGISTRY.flatMap(fileReads), mode));
    test(`${label}: cat, head and a copy into the workspace of each credential file are refused`, { skip: POSIX }, () => assertRefused(REGISTRY.flatMap(shellReads), mode));
  }
  // The tag does not tell a read from a write, so a write is refused too.
  test('Notes mode: a write to a credential file is refused too, in the same words', async () => {
    const cases = REGISTRY.flatMap(f => [
      ['Write', { file_path: f, content: '{}' }], ['Edit', { file_path: f, old_string: '{', new_string: '[' }],
      ...(POSIX ? [] : [['Bash', { command: `echo {} > ${f}` }]]),
    ]);
    const got = await each(cases, ([tool, input]) => run(tool, input, { port: closed, mode: 'notes' }));
    const expected = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: unansweredNotice(`${UNREACHABLE} ${CREDENTIAL}`, { unattended: true }) };
    cases.forEach((c, i) => assert.deepStrictEqual(said(got[i]), expected, named(c)));
  });
});

describe('a reply that does not parse refuses every credential read', () => {
  for (const [label, mode] of MODES) {
    test(`${label}: refused in the same words as an unreachable server, but the first sentence`, async () => {
      const cases = REGISTRY.flatMap(everyRead);
      const unreachable = await each(cases, ([tool, input]) => run(tool, input, { port: closed, mode }));
      const unparsed = await each(cases, ([tool, input]) => run(tool, input, { port: portOf(garbled), mode }));
      cases.forEach((c, i) => {
        const a = said(unreachable[i]);
        const b = said(unparsed[i]);
        assert.strictEqual(b.permissionDecision, 'deny', `${named(c)}: ${b.permissionDecisionReason}`);
        assert.ok(a.permissionDecisionReason.startsWith(`${UNREACHABLE} `), named(c));
        assert.deepStrictEqual(b, { ...a, permissionDecisionReason: UNPARSED + a.permissionDecisionReason.slice(UNREACHABLE.length) }, named(c));
      });
    });
  }
});

describe('the refusal says a sign-in credential is never touched without asking', () => {
  for (const [label, mode] of MODES) {
    for (const [who, convo, unattended, tail] of [
      ['in a routine', '', true, 'and tells the run to carry on without it'],
      ['in a conversation', 'c1', false, 'with no routine wording'],
    ]) {
      test(`${label}, ${who}: the refusal names the credential, ${tail}`, async () => {
        const cases = WORDED[mode];
        const got = await each(cases, ([tool, input]) => run(tool, input, { port: closed, mode, convo }));
        const reason = unansweredNotice(`${UNREACHABLE} ${CREDENTIAL}`, { unattended });
        assert.strictEqual(reason.endsWith(` ${UNATTENDED_NEXT}`), unattended, 'the routine wording, only in a routine');
        cases.forEach((c, i) => assert.deepStrictEqual(said(got[i]), { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason }, named(c)));
      });
    }
  }
});
