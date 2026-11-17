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
//
// Everything else keeps its answer, a write to a credential file included. Those
// cases, the credential reads that were
// already refused for another reason, and the card a credential read draws when
// the server answers are compared field by field with what main's hook returned
// before this change, which also records where it started:
// test/fixtures/credential-read-on-main.json, recorded by running this file
// against the hook as it was in v0.15.8:
//
//   git show v0.15.8:scripts/permission-hook.js > scripts/.main-hook.js
//   RUNDOCK_RECORD_HOOK="$PWD/scripts/.main-hook.js" node --test test/unit/credential-read-unanswered.test.js
//
// Paths under the temporary folder are written as `<root>`, and each card
// request's session id, which differs per run, is left out.
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

const RECORD = process.env.RUNDOCK_RECORD_HOOK || '';
const HOOK = RECORD || path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'credential-read-on-main.json');

const UNREACHABLE = 'Rundock server unreachable.';
const UNPARSED = 'Rundock hook: could not parse server response.';
const CREDENTIAL = 'This reads or changes a sign-in credential, and it is never done without asking, so it was refused rather than approved on your behalf.';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'credential-read-unanswered-')));
const home = path.join(root, 'profile');
const ws = path.join(root, 'ws');
for (const d of [path.join(home, '.claude', 'agents'), path.join(home, '.codex'), path.join(ws, '.rundock'), path.join(root, 'elsewhere')]) fs.mkdirSync(d, { recursive: true });
const REGISTRY = secretsRegistry(home);
for (const f of [...REGISTRY, path.join(home, '.claude', 'settings.json'), path.join(home, '.claude', 'agents', 'helper.md'), path.join(ws, 'notes.md'), path.join(root, 'elsewhere', 'notes.md'), path.join(home, 'notes.md')]) fs.writeFileSync(f, '{}\n');
// A workspace can be the home folder itself, which then holds every credential
// file the registry names, or a runtime home, which holds some of them. Their
// cases carry these after the mode in their names.
const AT_HOME = ', workspace at home';
const IN_RUNTIME_HOME = ', workspace in a runtime home';
const WORKSPACES = [['', ws], [AT_HOME, home], [IN_RUNTIME_HOME, path.join(home, '.claude')]];
for (const [, w] of WORKSPACES) fs.mkdirSync(path.join(w, '.rundock'), { recursive: true });

// The shell commands are POSIX spellings, and the recorded answers name POSIX paths.
const POSIX = process.platform === 'win32' ? 'the shell commands and recorded paths here are POSIX' : false;
const MODES = [['Notes mode', 'notes'], ['Code mode', 'code']];
const live = v => JSON.parse(JSON.stringify(v).split('<root>').join(root));
const normal = v => JSON.parse(JSON.stringify(v).split(root).join('<root>'));
const named = ([tool, input]) => `${tool} ${JSON.stringify(normal(input))}`;
const keyOf = (label, state, [tool, input]) => `${label} | ${state} | ${tool} | ${JSON.stringify(normal(input))}`;
const said = got => (got.answer && got.answer.hookSpecificOutput) || {};

// Each credential file, read every way an agent reads one.
const fileReads = f => [['Read', { file_path: f }], ['Grep', { pattern: 'token', path: f }], ['Glob', { pattern: '*', path: f }]];
const shellReads = (f, w = ws) => [['Bash', { command: `cat ${f}` }], ['Bash', { command: `head ${f}` }], ['Bash', { command: `cp ${f} ${path.join(w, 'copy.json')}` }]];
const everyRead = (f, w = ws) => [...fileReads(f), ...(POSIX ? [] : shellReads(f, w))];
const cardReads = f => [['Read', { file_path: f }], ['Bash', { command: `cat ${f}` }]];
const credentialIn = ([, input]) => input.file_path || input.path || input.command.split(' ')[1];

// Code mode already refused some credential reads with nobody to ask, as a
// crossing it asks about every time: a file directly in the home folder, which
// is a hidden place there, and a copy, which writes. Those keep main's words
// (the table further down), so Code mode's wording cases are the reads of the
// files under a runtime home.
const underRuntimeHome = f => runtimeHomes(home).some(h => f.startsWith(h.root + path.sep));
const WORDED = {
  notes: REGISTRY.flatMap(f => everyRead(f)),
  code: REGISTRY.filter(underRuntimeHome).flatMap(f => [...fileReads(f), ...(POSIX ? [] : shellReads(f).slice(0, 2))]),
};

const KEYCHAIN = { RUNDOCK_TEST_SEAMS: '1', RUNDOCK_TEST_PLATFORM: 'darwin' };
const KEYCHAIN_LINE = 'security find-generic-password -w -s example-service';
// [what, tool, input, env]: every other access, the same in both modes.
const UNCHANGED = [
  ['an ordinary read outside the workspace', 'Read', { file_path: '<root>/elsewhere/notes.md' }],
  ['an ordinary read outside the workspace', 'Bash', { command: 'cat <root>/elsewhere/notes.md' }],
  ['a free read in the runtime home', 'Read', { file_path: '<root>/profile/.claude/settings.json' }],
  ['a free read in the runtime home', 'Bash', { command: 'cat ~/.claude/settings.json' }],
  ['a read of a persistence surface', 'Read', { file_path: '<root>/profile/.claude/agents/helper.md' }],
  ['a read of a persistence surface', 'Bash', { command: 'cat ~/.claude/agents/helper.md' }],
  ['a read inside the workspace', 'Read', { file_path: '<root>/ws/notes.md' }],
  ['a read inside the workspace', 'Bash', { command: 'cat notes.md' }],
  ['a Keychain line', 'Bash', { command: KEYCHAIN_LINE }, KEYCHAIN],
  ['an answer-file write', 'Write', { file_path: '<root>/ws/.rundock/permissions.json', content: '{}' }],
  ['an answer-file write', 'Bash', { command: 'echo {} > .rundock/permissions.json' }],
  ['a connector send', 'mcp__example_mail__send_message', { text: 'hello' }],
];
// [what, tool, input]: ordinary work in a workspace at the home folder, which
// keeps main's answer whether Rundock can be asked or not.
const UNCHANGED_AT_HOME = [
  ['an ordinary file in the home folder', 'Read', { file_path: '<root>/profile/notes.md' }],
  ['an ordinary file in the home folder', 'Bash', { command: 'cat notes.md' }],
  ['a listing of the home folder', 'Glob', { pattern: '*', path: '<root>/profile' }],
  ['a listing of the home folder', 'Bash', { command: 'ls' }],
  ['a write in the home folder', 'Write', { file_path: '<root>/profile/notes.md', content: 'x' }],
  ['a write in the home folder', 'Bash', { command: 'echo x > notes.md' }],
];
// Each credential file, written every way an agent writes one: replaced,
// copied onto, emptied, removed, touched or given a mode. Only a read is
// refused for reaching a credential: a write keeps the answer main gives it.
const writes = f => [
  ['Write', { file_path: f, content: '{}' }], ['Edit', { file_path: f, old_string: '{', new_string: '[' }],
  ['Bash', { command: `echo {} > ${f}` }], ['Bash', { command: `cp notes.md ${f}` }],
  ['Bash', { command: `truncate -s 0 ${f}` }], ['Bash', { command: `rm ${f}` }],
  ['Bash', { command: `touch ${f}` }], ['Bash', { command: `chmod 600 ${f}` }],
];
// A folder that holds credential files, copied into, both ways of naming it.
const FOLDER_WRITES = [['Bash', { command: 'cp -r y ~/.claude' }], ['Bash', { command: 'cp -r -t ~/.codex y' }]];
// Each credential file read by a command that is neither a plain read nor a
// copy: a script handed it, an archive, a move into the workspace, and a read
// whose output goes back onto the file. Each reads what the file holds.
const otherReads = (f, w = ws) => [
  ['Bash', { command: `node read.js ${f}` }], ['Bash', { command: `tar -cf ${path.join(w, 'out.tar')} ${f}` }],
  ['Bash', { command: `mv ${f} ${path.join(w, 'moved.json')}` }], ['Bash', { command: `cat ${f} >> ${f}` }],
];
// A folder of credential files copied out, then a folder copied into it.
const copiedOutThenIn = w => [['Bash', { command: `cp -r ~/.codex ${path.join(w, 'stolen')} && cp -r ${path.join(w, 'y')} ~/.codex` }]];
// [mode, what, tool, input, env]: credential reads already refused with nobody
// to ask, for a reason that comes first, keep that reason's words.
const ALREADY_REFUSED = [
  ['Code mode', 'a credential file directly in the home folder', 'Read', { file_path: '<root>/profile/.claude.json' }],
  ['Code mode', 'a credential file directly in the home folder', 'Bash', { command: 'cat ~/.claude.json.backup' }],
  ['Code mode', 'a copy of a credential file', 'Bash', { command: 'cp ~/.codex/auth.json ./copy.json' }],
  ...MODES.map(([label]) => [label, 'a copy of a credential file onto an answer file', 'Bash', { command: 'cp ~/.claude/.credentials.json .rundock/permissions.json' }]),
  ...MODES.map(([label]) => [label, 'a credential read beside a Keychain line', 'Bash', { command: `cat ~/.claude/.config.json && ${KEYCHAIN_LINE}` }, KEYCHAIN]),
  ['Notes mode', 'a delete of a credential file', 'Bash', { command: 'rm ~/.claude/.credentials.json' }],
];

const asked = new Map();
let recording;
let garbled;
let closed;
let runs = 0;
const recorded = {};
const onMain = RECORD ? {} : JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

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
  recording = await listen((body, res) => {
    const request = JSON.parse(body);
    if (!asked.has(request.session_id)) asked.set(request.session_id, []);
    asked.get(request.session_id).push(request);
    res.end(JSON.stringify({ allow: false }));
  });
  garbled = await listen((body, res) => res.end('this is not a reply'));
  closed = await closedPort();
});
after(async () => {
  for (const s of [recording, garbled]) if (s) await new Promise(r => s.close(r));
  if (RECORD) fs.writeFileSync(FIXTURE, JSON.stringify(Object.fromEntries(Object.keys(recorded).sort().map(k => [k, recorded[k]])), null, 1) + '\n');
  fs.rmSync(root, { recursive: true, force: true });
});
const portOf = s => s.address().port;

// The real hook, given one tool call, as the runtime spawns it. A routine has
// no conversation id; a conversation has one.
function run(tool, input, { port, mode, convo = '', env = {}, session = `s${++runs}`, workspace = ws }) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [HOOK], {
      cwd: workspace,
      env: {
        ...process.env, HOME: home, USERPROFILE: home, NODE_V8_COVERAGE: '',
        RUNDOCK: '1', RUNDOCK_PORT: String(port), RUNDOCK_WORKSPACE: workspace, RUNDOCK_CONVO_ID: convo,
        RUNDOCK_CODE_MODE: mode === 'code' ? '1' : '', RUNDOCK_EXTRA_DIRS: '', RUNDOCK_HOOK_TOKEN: '',
        RUNDOCK_TEST_SEAMS: '', RUNDOCK_TEST_PLATFORM: '', ...env,
      },
    });
    let out = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.on('close', () => {
      let answer = null;
      try { answer = JSON.parse(out); } catch (e) { /* asserted by the caller */ }
      const cards = (asked.get(session) || []).map(({ session_id: _drop, ...rest }) => rest);
      resolve(normal({ answer, cards }));
    });
    proc.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', cwd: workspace, session_id: session, tool_name: tool, tool_input: input }));
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
async function assertRefused(cases, mode, workspace = ws) {
  assert.ok(cases.length > 0, 'the registry names credential files');
  const got = await each(cases, ([tool, input]) => run(tool, input, { port: closed, mode, workspace }));
  const notRefused = cases.map((c, i) => [c, said(got[i])])
    .filter(([, o]) => o.permissionDecision !== 'deny' || !o.permissionDecisionReason.startsWith(`${UNREACHABLE} `))
    .map(([c, o]) => `${named(c)}: ${o.permissionDecision}: ${o.permissionDecisionReason}`);
  assert.deepStrictEqual(notRefused, []);
}

describe('with Rundock unreachable, every read of a credential file is refused', () => {
  for (const [label, mode] of MODES) {
    test(`${label}: Read, Grep and Glob of each credential file are refused`, () => assertRefused(REGISTRY.flatMap(fileReads), mode));
    test(`${label}: cat, head and a copy into the workspace of each credential file are refused`, { skip: POSIX }, () => assertRefused(REGISTRY.flatMap(f => shellReads(f)), mode));
    // A workspace that holds the file does not make reading it ordinary work.
    for (const [where, w] of WORKSPACES.slice(1)) {
      test(`${label}${where}: Read, Grep and Glob of each credential file are refused`, () => assertRefused(REGISTRY.flatMap(fileReads), mode, w));
      test(`${label}${where}: cat, head and a copy within the workspace of each credential file are refused`, { skip: POSIX }, () => assertRefused(REGISTRY.flatMap(f => shellReads(f, w)), mode, w));
    }
    // Writing somewhere on the line does not make what the line reads a write.
    for (const [where, w] of WORKSPACES) {
      test(`${label}${where}: a command reading each credential file some other way is refused`, { skip: POSIX }, () => assertRefused([...REGISTRY.flatMap(f => otherReads(f, w)), ...copiedOutThenIn(w)], mode, w));
    }
  }
});

describe('a reply that does not parse refuses every credential read', () => {
  for (const [label, mode] of MODES) for (const [where, workspace] of WORKSPACES) {
    test(`${label}${where}: refused in the same words as an unreachable server, but the first sentence`, async () => {
      const cases = REGISTRY.flatMap(f => everyRead(f, workspace));
      const unreachable = await each(cases, ([tool, input]) => run(tool, input, { port: closed, mode, workspace }));
      const unparsed = await each(cases, ([tool, input]) => run(tool, input, { port: portOf(garbled), mode, workspace }));
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

// WHERE THIS STARTED, by name: main's answer to each read of each credential
// file with nobody to ask, recorded from main's hook. [file under the home
// folder, Notes mode, Code mode], where 'allowed' is every read allowed,
// 'asks' every read refused as a place Code mode asks about every time (a file
// directly in the home folder is a hidden place there), and 'copy' every read
// allowed but the copy into the workspace, refused that way as a write.
const ON_MAIN = [
  ['.claude/.credentials.json', 'allowed', 'copy'],
  ['.claude/.config.json', 'allowed', 'copy'],
  ['.codex/auth.json', 'allowed', 'copy'],
  ['.claude.json', 'allowed', 'asks'],
  ['.claude.json.backup', 'allowed', 'asks'],
];
const ASKS_EVERY_TIME = 'This reaches a place Rundock asks about every time, and it is never done without asking, so it was refused rather than approved on your behalf.';
const answered = (decision, reason) => ({ answer: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }, cards: [] });
describe('on main, with nobody to ask, a credential read was allowed unless Code mode asked about it every time', { skip: POSIX }, () => {
  test('the table names every file the registry names', () => {
    assert.deepStrictEqual(ON_MAIN.map(([f]) => path.join(home, f)).sort(), [...REGISTRY].sort());
  });
  for (const [label, mode] of MODES) {
    test(`${label}: main's answer to each read of each credential file, by name`, async () => {
      const cases = ON_MAIN.flatMap(([f, notes, code]) => everyRead(path.join(home, f)).map(c => [c, mode === 'notes' ? notes : code]));
      if (RECORD) {
        const got = await each(cases, ([[tool, input]]) => run(tool, input, { port: closed, mode }));
        cases.forEach(([c], i) => { recorded[keyOf(label, 'unreachable', c)] = got[i]; });
        return;
      }
      const refused = answered('deny', unansweredNotice(`${UNREACHABLE} ${ASKS_EVERY_TIME}`, { unattended: true }));
      for (const [c, onFile] of cases) {
        const asks = onFile === 'asks' || (onFile === 'copy' && c[1].command && c[1].command.startsWith('cp '));
        assert.deepStrictEqual(onMain[keyOf(label, 'unreachable', c)], asks ? refused : answered('allow', UNREACHABLE), named(c));
      }
    });
    // With the workspace at the home folder, every credential file is inside it,
    // and main allowed every read of each, reachable or not.
    test(`${label}${AT_HOME}: main allowed each read of each credential file, reachable or not`, async () => {
      const states = [['unreachable', closed, REGISTRY.flatMap(f => everyRead(f, home))], ['reachable', () => portOf(recording), REGISTRY.flatMap(cardReads)]];
      for (const [state, port, cases] of states) {
        if (RECORD) {
          const got = await each(cases, ([tool, input]) => run(tool, input, { port: typeof port === 'function' ? port() : port, mode, workspace: home }));
          cases.forEach((c, i) => { recorded[keyOf(`${label}${AT_HOME}`, state, c)] = got[i]; });
          continue;
        }
        for (const c of cases) {
          const got = onMain[keyOf(`${label}${AT_HOME}`, state, c)];
          assert.ok(got, `${named(c)}: measured on main`);
          // In Notes mode the server decides a shell command itself, and this one
          // carries no crossing for it to card; the real server allows a cat.
          if (mode === 'notes' && state === 'reachable' && c[0] === 'Bash') {
            assert.ok(got.cards.length === 1 && !got.cards[0].boundary && !got.cards[0].crossings, `${named(c)}: an ordinary request with no crossing`);
            continue;
          }
          assert.strictEqual(said(got).permissionDecision, 'allow', `${named(c)}: ${state}`);
          assert.deepStrictEqual(got.cards, [], `${named(c)}: no card`);
        }
      }
    });
  }
});

describe('with Rundock unreachable, every other access keeps the answer main gives', { skip: POSIX, concurrency: 8 }, () => {
  for (const [label, mode] of MODES) {
    for (const [what, tool, input, env] of UNCHANGED) {
      test(`${label}: ${what} (${tool})`, async () => {
        const got = await run(tool, live(input), { port: closed, mode, env });
        const key = keyOf(label, 'unreachable', [tool, input]);
        if (RECORD) { recorded[key] = got; return; }
        assert.ok(onMain[key], 'measured on main');
        assert.deepStrictEqual(got, onMain[key], 'the whole answer, field by field, as main gives it');
      });
    }
    for (const [what, tool, input] of UNCHANGED_AT_HOME) {
      test(`${label}${AT_HOME}: ${what} (${tool}), whether Rundock can be asked or not`, async () => {
        for (const [state, port] of [['unreachable', closed], ['reachable', portOf(recording)]]) {
          const got = await run(tool, live(input), { port, mode, workspace: home });
          const key = keyOf(`${label}${AT_HOME}`, state, [tool, input]);
          if (RECORD) { recorded[key] = got; continue; }
          assert.ok(onMain[key], `measured on main, ${state}`);
          assert.deepStrictEqual(got, onMain[key], `the whole answer, field by field, as main gives it, ${state}`);
        }
      });
    }
    for (const [where, workspace] of WORKSPACES.slice(0, 2)) {
      test(`${label}${where}: a write to each credential file, or into a folder of them, keeps main's answer`, async () => {
        const cases = [...REGISTRY.flatMap(writes), ...FOLDER_WRITES].map(c => [c[0], normal(c[1])]);
        const got = await each(cases, ([tool, input]) => run(tool, live(input), { port: closed, mode, workspace }));
        cases.forEach((c, i) => {
          const key = keyOf(`${label}${where}`, 'unreachable', c);
          if (RECORD) { recorded[key] = got[i]; return; }
          assert.ok(onMain[key], `${named(c)}: measured on main`);
          assert.deepStrictEqual(got[i], onMain[key], `${named(c)}: the whole answer, field by field, as main gives it`);
        });
      });
    }
  }
});

describe('a credential read already refused for another reason keeps that reason', { skip: POSIX, concurrency: 8 }, () => {
  for (const [label, what, tool, input, env] of ALREADY_REFUSED) {
    test(`${label}: ${what} (${tool})`, async () => {
      const got = await run(tool, live(input), { port: closed, mode: label === 'Code mode' ? 'code' : 'notes', env });
      const key = keyOf(label, 'unreachable', [tool, input]);
      if (RECORD) { recorded[key] = got; return; }
      assert.ok(onMain[key], 'measured on main');
      assert.strictEqual(said(onMain[key]).permissionDecision, 'deny', 'refused on main');
      assert.deepStrictEqual(got, onMain[key], 'the whole answer, field by field, as main gives it');
    });
  }
});

describe('with Rundock reachable, a credential read draws the card main draws', { skip: POSIX }, () => {
  for (const [label, mode] of MODES) {
    test(`${label}: Read and cat of each credential file send main's secret card request`, async () => {
      const cases = REGISTRY.flatMap(cardReads);
      const got = await each(cases, ([tool, input]) => run(tool, input, { port: portOf(recording), mode }));
      cases.forEach((c, i) => {
        const key = keyOf(label, 'reachable', c);
        if (RECORD) { recorded[key] = got[i]; return; }
        assert.ok(onMain[key], `${named(c)}: measured on main`);
        assert.ok(got[i].cards.length === 1 && got[i].cards[0].crossings.some(x => x.secret), `${named(c)}: one secret card`);
        assert.deepStrictEqual(got[i], onMain[key], `${named(c)}: the answer and the card request, as main sends them`);
      });
    });
  }
  // A credential file inside the workspace draws a card of its own, which says
  // where the file is rather than calling it a crossing, and offers no grant.
  for (const [label, mode] of MODES) {
    test(`${label}${AT_HOME}: each read of each credential file asks, and Rundock's answer stands`, async () => {
      const cases = REGISTRY.flatMap(cardReads);
      const got = await each(cases, ([tool, input]) => run(tool, input, { port: portOf(recording), mode, workspace: home }));
      cases.forEach(([tool, input], i) => {
        const c = [tool, input];
        assert.strictEqual(got[i].cards.length, 1, `${named(c)}: one card`);
        const { credential, resolved_path, grant_dir, boundary, crossings } = got[i].cards[0];
        assert.deepStrictEqual({ credential, resolved_path, grant_dir, boundary, crossings }, { credential: true, resolved_path: normal(credentialIn(c)), grant_dir: null, boundary: undefined, crossings: undefined }, named(c));
        assert.strictEqual(said(got[i]).permissionDecision, 'deny', `${named(c)}: the refusal Rundock sent`);
      });
    });
  }
});

describe('once Rundock is back, a credential read refused while it was unreachable draws its card', { skip: POSIX || (RECORD ? 'recording' : false) }, () => {
  for (const [label, mode] of MODES) {
    test(`${label}: nothing remembers the refusal`, async () => {
      const cases = REGISTRY.flatMap(cardReads);
      const got = await each(cases, async ([tool, input], i) => {
        const session = `again-${mode}-${i}`;
        const refused = await run(tool, input, { port: closed, mode, session });
        return { refused, again: await run(tool, input, { port: portOf(recording), mode, session }) };
      });
      cases.forEach((c, i) => {
        assert.strictEqual(said(got[i].refused).permissionDecision, 'deny', `${named(c)}: refused while unreachable`);
        assert.deepStrictEqual(got[i].again, onMain[keyOf(label, 'reachable', c)], `${named(c)}: the same card as ever, once it is back`);
      });
    });
    test(`${label}${AT_HOME}: nothing remembers the refusal`, async () => {
      const cases = REGISTRY.flatMap(cardReads);
      const got = await each(cases, async ([tool, input], i) => {
        const session = `again-home-${mode}-${i}`;
        const refused = await run(tool, input, { port: closed, mode, session, workspace: home });
        const again = await run(tool, input, { port: portOf(recording), mode, session, workspace: home });
        return { refused, again, first: await run(tool, input, { port: portOf(recording), mode, workspace: home }) };
      });
      cases.forEach((c, i) => {
        assert.strictEqual(said(got[i].refused).permissionDecision, 'deny', `${named(c)}: refused while unreachable`);
        assert.ok(got[i].again.cards.length === 1 && got[i].again.cards[0].credential === true, `${named(c)}: a card once it is back`);
        assert.deepStrictEqual(got[i].again, got[i].first, `${named(c)}: the same card a first read draws`);
      });
    });
  }
});
