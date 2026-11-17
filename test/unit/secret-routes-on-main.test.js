'use strict';
// EACH ROUTE TO A SECRET THAT main LEFT WITH NO SECRET CARD NOW CARDS AS ONE.
// Four routes reached a file the secrets registry names, or a copy of one,
// with no secret card:
//
//   1. a workspace at home: a Read of `~/.claude.json`, or `cat .claude.json`;
//   2. a link in the workspace that leads to a registry file, bare
//      (`cat link.json`), nested (`cat sub/link.json`) or a linked folder
//      (`cat dotclaude/.credentials.json`);
//   3. a copy in Claude Code's backups folder (`cat ~/.claude/backups/<copy>`);
//   4. a runtime home moved by CLAUDE_CONFIG_DIR or CODEX_HOME: a read of the
//      account or credential file in the variable's folder.
//
// Each case runs through the real hook as its own process, in Notes and in
// Code mode, against a stand-in server that records each card it is asked to
// show and refuses it. main's answer is test/fixtures/secret-routes-on-main.json,
// recorded by running this file against main's hook:
//
//   git show origin/main:scripts/permission-hook.js > scripts/.main-hook.js
//   RUNDOCK_RECORD_HOOK="$PWD/scripts/.main-hook.js" node --test test/unit/secret-routes-on-main.test.js
//
// The test holds two things for each case: main's recorded answer has no
// secret card (the route is reproduced), and this hook cards the same case as
// a secret, with no folder offered to remember. Two cases did not reproduce:
// main already resolved a link spelled with a separator, so `cat sub/link.json`
// and `cat dotclaude/.credentials.json` were secret cards there too. They are
// kept, recorded, under a heading of their own, so the claim is checked rather
// than said. From a workspace at home, main asks about `.claude.json` with the
// card for a credential file the workspace holds, which names no crossing and
// so no secret: that is the answer recorded for route 1. Paths under the temporary
// folder are written as `<root>`, and each request's session id, which differs
// per run, is left out. The home folder is a temporary one, never the real one.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const RECORD = process.env.RUNDOCK_RECORD_HOOK || '';
const BRANCH_HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const HOOK = RECORD || BRANCH_HOOK;
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'secret-routes-on-main.json');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'secret-routes-on-main-')));
const home = path.join(root, 'home');
const ws = path.join(root, 'ws');
const COPY = '.claude.json.backup.1700000000000';
// The registry's files at home, a copy in the backups folder, and an ordinary
// file, so a workspace at home has something that is not a secret too.
for (const d of [path.join(home, '.claude', 'backups'), path.join(home, '.codex'), path.join(ws, 'sub')]) fs.mkdirSync(d, { recursive: true });
for (const f of ['.claude.json', '.claude/.credentials.json', `.claude/backups/${COPY}`, '.codex/auth.json', 'notes.md']) fs.writeFileSync(path.join(home, f), '{}');
// A workspace elsewhere whose links lead to the registry.
fs.symlinkSync(path.join(home, '.claude.json'), path.join(ws, 'link.json'));
fs.symlinkSync(path.join(home, '.claude.json'), path.join(ws, 'sub', 'link.json'));
fs.symlinkSync(path.join(home, '.claude'), path.join(ws, 'dotclaude'));
// The folders the variables name, outside home and the workspace, with the
// files each runtime keeps there.
const movedClaude = path.join(root, 'moved-claude');
const movedCodex = path.join(root, 'moved-codex');
for (const d of [movedClaude, movedCodex]) fs.mkdirSync(d);
for (const f of [path.join(movedClaude, '.claude.json'), path.join(movedClaude, '.credentials.json'), path.join(movedCodex, 'auth.json')]) fs.writeFileSync(f, '{}');

const POSIX = process.platform === 'win32' ? 'the home folder and links are read the POSIX way here' : false;
const MODES = [['Notes mode', {}], ['Code mode', { RUNDOCK_CODE_MODE: '1' }]];
const CLAUDE_MOVED = { CLAUDE_CONFIG_DIR: '<root>/moved-claude' };
const CODEX_MOVED = { CODEX_HOME: '<root>/moved-codex' };
// [route, tool, input, workspace, variables, the file the card names]
const ROUTES = [
  ['a workspace at home', 'Read', { file_path: '<root>/home/.claude.json' }, 'home', {}, '<root>/home/.claude.json'],
  ['a workspace at home', 'Bash', { command: 'cat .claude.json' }, 'home', {}, '<root>/home/.claude.json'],
  ['a workspace link to a registry file', 'Bash', { command: 'cat link.json' }, 'ws', {}, '<root>/home/.claude.json'],
  ['a copy in the backups folder', 'Bash', { command: `cat ~/.claude/backups/${COPY}` }, 'ws', {}, `<root>/home/.claude/backups/${COPY}`],
  ...[
    ['<root>/moved-claude/.claude.json', CLAUDE_MOVED],
    ['<root>/moved-claude/.credentials.json', CLAUDE_MOVED],
    ['<root>/moved-codex/auth.json', CODEX_MOVED],
  ].flatMap(([file, vars]) => [
    ['a runtime home moved by its variable', 'Read', { file_path: file }, 'ws', vars, file],
    ['a runtime home moved by its variable', 'Bash', { command: `cat ${file}` }, 'ws', vars, file],
  ]),
];
// The cases main already carded as a secret.
const ALREADY_SECRET = [
  ['a nested workspace link to a registry file', 'Bash', { command: 'cat sub/link.json' }, 'ws', {}, '<root>/home/.claude.json'],
  ['a workspace folder that links to a runtime home', 'Bash', { command: 'cat dotclaude/.credentials.json' }, 'ws', {}, '<root>/home/.claude/.credentials.json'],
];
const keyOf = (label, [, tool, input, place, vars]) => `${label} | ${tool} | ${JSON.stringify(input)} | ${place} | ${JSON.stringify(vars)}`;
const live = v => JSON.parse(JSON.stringify(v).split('<root>').join(root));
const normal = v => JSON.parse(JSON.stringify(v).split(root).join('<root>'));

const asked = new Map();
let server;
let port;
let runs = 0;
const recorded = {};
before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (!req.url.startsWith('/api/permission-request')) { res.statusCode = 404; res.end(); return; }
      const request = JSON.parse(body);
      if (!asked.has(request.session_id)) asked.set(request.session_id, []);
      asked.get(request.session_id).push(request);
      res.end(JSON.stringify({ allow: false }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (RECORD) fs.writeFileSync(FIXTURE, JSON.stringify(Object.fromEntries(Object.keys(recorded).sort().map(k => [k, recorded[k]])), null, 1) + '\n');
  fs.rmSync(root, { recursive: true, force: true });
});

// The hook's whole answer, and every card it asked the stand-in for, with the
// temporary folder written as `<root>`. The runtime-home variables are left
// unset unless a case sets them, whatever the shell running the tests has.
function run(hook, tool, input, workspace, env) {
  const session = `s${++runs}`;
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [hook], {
      env: {
        ...process.env, HOME: home, USERPROFILE: home, NODE_V8_COVERAGE: '',
        RUNDOCK: '1', RUNDOCK_PORT: String(port), RUNDOCK_WORKSPACE: workspace, RUNDOCK_CONVO_ID: '', RUNDOCK_CODE_MODE: '',
        CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, ...env,
      },
    });
    let out = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.on('close', () => {
      let answer = null;
      try { answer = JSON.parse(out); } catch (e) { /* asserted below */ }
      const cards = (asked.get(session) || []).map(({ session_id: _drop, ...rest }) => rest);
      resolve(normal({ answer, cards }));
    });
    proc.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', cwd: workspace, session_id: session, tool_name: tool, tool_input: input }));
  });
}
const anySecret = (cards) => cards.some(card => (card.crossings || []).some(c => c && c.secret));
const namesSecret = (card, file) => (card.crossings || []).some(c => c.secret === true && c.path === file);
// One card, naming the file as a secret, with no folder offered to remember.
function assertSecretCard(got, tool, file) {
  const o = (got.answer && got.answer.hookSpecificOutput) || {};
  assert.strictEqual(o.permissionDecision, 'deny', 'carded, and refused by the stand-in');
  assert.strictEqual(got.cards.length, 1, 'one card');
  const [card] = got.cards;
  assert.ok(namesSecret(card, file), `the card names ${file} as a secret: ${JSON.stringify(card.crossings)}`);
  assert.strictEqual(card.boundary, true, 'a boundary card, which no standing grant answers for a secret');
  assert.strictEqual(card.grant_dir, null, 'no folder is offered to remember');
  if (tool === 'Bash') assert.strictEqual(card.grantable, false, 'a command card');
}
const titleOf = (label, [name, tool, input, , vars]) => `${label}: ${name}${Object.keys(vars).length ? `, ${Object.keys(vars)[0]} set` : ''}: ${tool} ${JSON.stringify(input)}`;
const placeOf = (place) => (place === 'home' ? home : ws);

describe('each route main answered with no secret card now cards as a secret, with no folder to remember', { skip: POSIX, concurrency: 8 }, () => {
  const onMain = RECORD ? {} : JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  for (const [label, modeEnv] of MODES) {
    for (const route of ROUTES) {
      const [, tool, input, place, vars, file] = route;
      test(titleOf(label, route), async () => {
        const env = { ...modeEnv, ...live(vars) };
        if (RECORD) { recorded[keyOf(label, route)] = await run(HOOK, tool, live(input), placeOf(place), env); return; }
        const main = onMain[keyOf(label, route)];
        assert.ok(main, 'measured on main');
        assert.ok(main.answer, 'main\'s hook answered');
        assert.ok(!anySecret(main.cards), `main sent no secret card: ${JSON.stringify(main)}`);
        assertSecretCard(await run(BRANCH_HOOK, tool, live(input), placeOf(place), env), tool, file);
      });
    }
  }
});

describe('a link spelled with a separator was already a secret card on main, and still is', { skip: POSIX, concurrency: 8 }, () => {
  const onMain = RECORD ? {} : JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  for (const [label, modeEnv] of MODES) {
    for (const route of ALREADY_SECRET) {
      const [, tool, input, place, vars, file] = route;
      test(titleOf(label, route), async () => {
        const env = { ...modeEnv, ...live(vars) };
        if (RECORD) { recorded[keyOf(label, route)] = await run(HOOK, tool, live(input), placeOf(place), env); return; }
        const main = onMain[keyOf(label, route)];
        assert.ok(main, 'measured on main');
        assert.ok(main.cards.length === 1 && namesSecret(main.cards[0], file), `main named ${file} as a secret: ${JSON.stringify(main)}`);
        assertSecretCard(await run(BRANCH_HOOK, tool, live(input), placeOf(place), env), tool, file);
      });
    }
  }
});
