'use strict';
// FOUR ROUTES TO A SECRET NOW CARD AS ONE, AND WHAT main SHOWED FOR EACH IS
// CHECKED. Each route reaches a file the secrets registry names, or a copy of
// one:
//
//   1. a workspace at home: a Read of `~/.claude.json`, or `cat .claude.json`;
//   2. a link in the workspace that leads to a registry file, bare
//      (`cat link.json`), nested (`cat sub/link.json`) or a linked folder
//      (`cat dotclaude/.credentials.json`);
//   3. a copy in Claude Code's backups folder (`cat ~/.claude/backups/<copy>`);
//   4. a runtime home moved by CLAUDE_CONFIG_DIR or CODEX_HOME: a read of the
//      account or credential file in the variable's folder.
//
// Routes 1 and 3 are claimed to have shown no card at all on main, and routes
// 2 and 4 no secret card. Each row carries its claim, and the claim picks the
// check made against main's answer.
//
// Each case runs through the real hook as its own process, in Notes and in
// Code mode, against a stand-in server that records each card it is asked to
// show and refuses it. main's answer is test/fixtures/secret-routes-on-main.json,
// recorded by running this file against main's hook:
//
//   git show origin/main:scripts/permission-hook.js > scripts/.main-hook.js
//   RUNDOCK_RECORD_HOOK="$PWD/scripts/.main-hook.js" node --test test/unit/secret-routes-on-main.test.js
//
// Every case is held to this hook carding it as a secret, with no folder
// offered to remember. What main showed sorts the cases into three groups,
// each checked against the recording rather than said:
//
//   - Reproduced: the bare link and each moved runtime home, in both modes,
//     where main showed no secret card; and the backups copy in Code mode,
//     where main showed no card.
//   - Not reproduced, because main already asked with one card that named no
//     secret: route 1 in both modes, where main showed its card for a
//     credential file the workspace holds, and route 3 in Notes mode, where
//     main showed its card for a path outside the workspace. This hook cards
//     them as a secret because it must card a registry file wherever the
//     workspace sits, and the backups folder on every read, not because main
//     showed no card.
//   - Not reproduced, because main already resolved a link spelled with a
//     separator: `cat sub/link.json` and `cat dotclaude/.credentials.json`
//     were secret cards there too.
//
// Paths under the temporary folder are written as `<root>`, and each request's
// session id, which differs per run, is left out. The home folder is a
// temporary one, never the real one.
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
const MODE_ENV = Object.fromEntries(MODES);
const BOTH = MODES.map(([label]) => label);
// Each row in each of the modes named, as [mode, row].
const inModes = (labels, rows) => labels.flatMap(label => rows.map(row => [label, row]));
const CLAUDE_MOVED = { CLAUDE_CONFIG_DIR: '<root>/moved-claude' };
const CODEX_MOVED = { CODEX_HOME: '<root>/moved-codex' };
// What a route is claimed to have shown on main: no card at all, or a card
// that named no secret.
const NO_CARD = 'no card';
const NO_SECRET_CARD = 'no secret card';
// [route, tool, input, workspace, variables, the file the card names, the claim about main]
// The cases main answered as the claim says.
const REPRODUCED = [
  ...inModes(BOTH, [
    ['a workspace link to a registry file', 'Bash', { command: 'cat link.json' }, 'ws', {}, '<root>/home/.claude.json', NO_SECRET_CARD],
    ...[
      ['<root>/moved-claude/.claude.json', CLAUDE_MOVED],
      ['<root>/moved-claude/.credentials.json', CLAUDE_MOVED],
      ['<root>/moved-codex/auth.json', CODEX_MOVED],
    ].flatMap(([file, vars]) => [
      ['a runtime home moved by its variable', 'Read', { file_path: file }, 'ws', vars, file, NO_SECRET_CARD],
      ['a runtime home moved by its variable', 'Bash', { command: `cat ${file}` }, 'ws', vars, file, NO_SECRET_CARD],
    ]),
  ]),
  ...inModes(['Code mode'], [
    ['a copy in the backups folder', 'Bash', { command: `cat ~/.claude/backups/${COPY}` }, 'ws', {}, `<root>/home/.claude/backups/${COPY}`, NO_CARD],
  ]),
];
// The cases where main already asked, with one card that named no secret, so
// the claim did not hold there.
const ASKED_ON_MAIN = [
  ...inModes(BOTH, [
    ['a workspace at home', 'Read', { file_path: '<root>/home/.claude.json' }, 'home', {}, '<root>/home/.claude.json', NO_CARD],
    ['a workspace at home', 'Bash', { command: 'cat .claude.json' }, 'home', {}, '<root>/home/.claude.json', NO_CARD],
  ]),
  ...inModes(['Notes mode'], [
    ['a copy in the backups folder', 'Bash', { command: `cat ~/.claude/backups/${COPY}` }, 'ws', {}, `<root>/home/.claude/backups/${COPY}`, NO_CARD],
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
// Holds a claim about main against main's recorded answer, and throws when
// main's answer does not match it.
const CLAIMS = {
  [NO_CARD]: (main) => assert.strictEqual(main.cards.length, 0, `main sent no card: ${JSON.stringify(main)}`),
  [NO_SECRET_CARD]: (main) => assert.ok(!anySecret(main.cards), `main sent no secret card: ${JSON.stringify(main)}`),
};
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

describe('each route main answered with no card, or with no secret card, now cards as a secret, with no folder to remember', { skip: POSIX, concurrency: 8 }, () => {
  const onMain = RECORD ? {} : JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  for (const [label, route] of REPRODUCED) {
    const [, tool, input, place, vars, file, claim] = route;
    test(titleOf(label, route), async () => {
      const env = { ...MODE_ENV[label], ...live(vars) };
      if (RECORD) { recorded[keyOf(label, route)] = await run(HOOK, tool, live(input), placeOf(place), env); return; }
      const main = onMain[keyOf(label, route)];
      assert.ok(main, 'measured on main');
      assert.ok(main.answer, 'main\'s hook answered');
      assert.ok(CLAIMS[claim], `the row names a claim about main: ${claim}`);
      CLAIMS[claim](main);
      assertSecretCard(await run(BRANCH_HOOK, tool, live(input), placeOf(place), env), tool, file);
    });
  }
});

describe('a case main already asked about, with one card that named no secret, now cards as a secret, with no folder to remember', { skip: POSIX, concurrency: 8 }, () => {
  const onMain = RECORD ? {} : JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  for (const [label, route] of ASKED_ON_MAIN) {
    const [, tool, input, place, vars, file, claim] = route;
    test(titleOf(label, route), async () => {
      const env = { ...MODE_ENV[label], ...live(vars) };
      if (RECORD) { recorded[keyOf(label, route)] = await run(HOOK, tool, live(input), placeOf(place), env); return; }
      const main = onMain[keyOf(label, route)];
      assert.ok(main, 'measured on main');
      assert.ok(main.answer, 'main\'s hook answered');
      assert.strictEqual(main.cards.length, 1, `main sent one card: ${JSON.stringify(main)}`);
      assert.ok(!anySecret(main.cards), `main's card named no secret: ${JSON.stringify(main)}`);
      assert.ok(CLAIMS[claim], `the row names a claim about main: ${claim}`);
      assert.throws(() => CLAIMS[claim](main), assert.AssertionError, `main did not show ${claim}, so the case did not reproduce`);
      assertSecretCard(await run(BRANCH_HOOK, tool, live(input), placeOf(place), env), tool, file);
    });
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
