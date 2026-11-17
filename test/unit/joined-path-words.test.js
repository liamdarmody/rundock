'use strict';
// A PATH IS READ AS THE SHELL JOINS IT. The hook has always ended a shell word
// at every quote, while bash joins the pieces into one word:
//
//   cat ~/.claude/".credentials.json"       one file to bash, two pieces split
//   cat "$HOME/.claude"/.credentials.json   home, inside the quotes with more
//
// Read split, neither piece is a credential file, so the line was asked about
// as an ordinary crossing or not at all. Each word is now also read as bash
// forms it, and the crossings are the union of both readings. A word holding a
// variable or a substitution cannot be read until the line runs, so its
// literal end is matched against the credential files instead.
//
// Every case runs the real hook as its own process, the way the runtime does,
// against a stand-in server that records each card it is asked to show and
// refuses it. The home folder is a temporary one, never the real one. What
// main's hook sends for the same lines is pinned in
// joined-path-words-on-main.test.js, and the real server's side in
// test/integration/joined-path-words-card.test.js.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const PARSER = path.join(__dirname, '..', '..', 'scripts', 'code-mode-parse.js');
const hook = require(HOOK);

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'joined-path-words-')));
const home = path.join(root, 'home');
const ws = path.join(root, 'ws');
for (const d of [path.join(home, '.claude', 'projects'), path.join(home, '.codex'), path.join(ws, 'notes'), path.join(ws, 'sub')]) {
  fs.mkdirSync(d, { recursive: true });
}
// Every credential file the registry names, wherever it puts them, so a new
// entry is read here with no change to this file.
const REGISTRY = hook.secretsRegistry(home);
for (const f of REGISTRY) fs.writeFileSync(f, '{}');
const SETTINGS = path.join(home, '.claude', 'settings.json');
fs.writeFileSync(SETTINGS, '{}');
fs.writeFileSync(path.join(ws, 'notes.md'), '# notes\n');
const CREDENTIALS = path.join(home, '.claude', '.credentials.json');
const CODEX_AUTH = path.join(home, '.codex', 'auth.json');
const CLAUDE_JSON = path.join(home, '.claude.json');

const POSIX = process.platform === 'win32' ? 'the home folder and quotes are read the POSIX way here' : false;
const MODES = [['Notes mode', {}], ['Code mode', { RUNDOCK_CODE_MODE: '1' }]];

const asked = new Map();
let server;
let port;
let runs = 0;
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
  fs.rmSync(root, { recursive: true, force: true });
});

// The hook's whole answer, and every card it asked the stand-in for. `at` is
// the port it is told Rundock is on; `preload` is a file loaded ahead of it.
function ask(command, env = {}, { at, preload } = {}) {
  const session = `s${++runs}`;
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [...(preload ? ['--require', preload] : []), HOOK], {
      env: {
        ...process.env, HOME: home, USERPROFILE: home, NODE_V8_COVERAGE: '',
        RUNDOCK: '1', RUNDOCK_PORT: String(at === undefined ? port : at), RUNDOCK_WORKSPACE: ws,
        RUNDOCK_CONVO_ID: '', RUNDOCK_CODE_MODE: '', ...env,
      },
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.on('data', (c) => { err += c; });
    proc.on('close', (status) => {
      let answer = null;
      try { answer = JSON.parse(out); } catch (e) { /* asserted below */ }
      const o = (answer && answer.hookSpecificOutput) || {};
      resolve({ status, stderr: err, answer, decision: o.permissionDecision || null, cards: asked.get(session) || [] });
    });
    proc.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', cwd: ws, session_id: session, tool_name: 'Bash', tool_input: { command } }));
  });
}
const secretOf = (card, file) => (card && Array.isArray(card.crossings) ? card.crossings.find(c => c.path === file && c.secret === true) : undefined);
const anySecret = (cards) => cards.some(card => (card.crossings || []).some(c => c && c.secret));
// The card as the window draws it: everything but the command's own text, and
// the label scanned from that text, which is not drawn on a crossing's card.
const drawn = ({ tool_input: _input, advisory_outside_paths: _label, session_id: _session, ...card }) => card;

// One card, naming the file as a secret, with no folder offered to remember.
async function assertTagged(command, file, env) {
  const via = await ask(command, env);
  assert.strictEqual(via.decision, 'deny', `${command}: the stand-in refused the card, so it was asked`);
  assert.strictEqual(via.cards.length, 1, `${command}: one card was asked for`);
  const crossing = secretOf(via.cards[0], file);
  assert.ok(crossing, `${command}: the card names ${file} as a secret: ${JSON.stringify(via.cards[0].crossings)}`);
  assert.strictEqual(via.cards[0].grant_dir, null, `${command}: no folder is offered to remember`);
  assert.strictEqual(via.cards[0].grantable, false);
  return crossing;
}
// And the very crossing the plain spelling of the same read raises.
const plain = new Map();
async function assertSecretCard(command, file, direct, env) {
  const crossing = await assertTagged(command, file, env);
  const key = `${direct} ${JSON.stringify(env)}`;
  if (!plain.has(key)) plain.set(key, ask(direct, env));
  const expected = secretOf((await plain.get(key)).cards[0], file);
  assert.ok(expected, `sanity: ${direct} asks about ${file} as a secret`);
  assert.deepStrictEqual(crossing, expected, `${command}: the same crossing ${direct} raises`);
}

// Every way of writing `rel`, a path below home, that bash reads as that path:
// each component quoted whole with either quote, each split in two by an
// empty pair of either quote, each with one character escaped, and home in
// double quotes alone and together with the next component.
function spellings(rel) {
  const parts = rel.split('/');
  const with_ = (i, piece) => parts.map((p, j) => (j === i ? piece : p)).join('/');
  const out = [];
  parts.forEach((p, i) => {
    const mid = Math.ceil(p.length / 2);
    for (const q of ['"', "'"]) out.push(`~/${with_(i, q + p + q)}`, `~/${with_(i, p.slice(0, mid) + q + q + p.slice(mid))}`);
    out.push(`~/${with_(i, `${p.slice(0, mid)}\\${p.slice(mid)}`)}`);
  });
  const tail = parts.length > 1 ? `/${parts.slice(1).join('/')}` : '';
  out.push(`"$HOME"/${rel}`, `"\${HOME}"/${rel}`, `"$HOME/${parts[0]}"${tail}`, `"\${HOME}/${parts[0]}"${tail}`);
  return out;
}
const below = (file) => path.relative(home, file).split(path.sep).join('/');

describe('the spellings measured on main, read as bash joins them', { skip: POSIX, concurrency: 8 }, () => {
  const READS = [
    ['cat "$HOME"/.claude/.credentials.json', CREDENTIALS],
    ['cat "$HOME/.claude"/.credentials.json', CREDENTIALS],
    ['cat "${HOME}/.claude"/.credentials.json', CREDENTIALS],
    ['cat ~/.claude/".credentials.json"', CREDENTIALS],
    ["cat ~/.claude/'.credentials'.json", CREDENTIALS],
    ['cat ~/.claude/.cred""entials.json', CREDENTIALS],
    ['cat "$HOME/.codex"/auth.json', CODEX_AUTH],
    ['cat ~/.codex/"auth.json"', CODEX_AUTH],
  ];
  for (const [label, env] of MODES) {
    for (const [command, file] of READS) {
      test(`${label}: ${command} asks as a secret, as the plain spelling does`, async () => {
        await assertSecretCard(command, file, `cat ~/${below(file)}`, env);
      });
    }
    // A write asks with the card the plain spelling raises.
    for (const [command, direct] of [
      ['echo x >> ~/.claude/"settings.json"', 'echo x >> ~/.claude/settings.json'],
      ["echo x >> ~/.claude/'settings'.json", 'echo x >> ~/.claude/settings.json'],
      ['echo x > ~/.claude/".credentials.json"', 'echo x > ~/.claude/.credentials.json'],
    ]) {
      test(`${label}: ${command} asks with the card ${direct} raises`, async () => {
        const [via, base] = await Promise.all([ask(command, env), ask(direct, env)]);
        assert.strictEqual(base.cards.length, 1, `sanity: ${direct} asks`);
        assert.strictEqual(via.decision, 'deny', `${command}: asked and refused`);
        assert.strictEqual(via.cards.length, 1, `${command}: one card`);
        assert.ok(via.cards[0].crossings.length > 0 && via.cards[0].crossings.every(c => c.write === true), `${command}: a write crossing`);
        assert.deepStrictEqual(drawn(via.cards[0]), drawn(base.cards[0]), `${command}: the card ${direct} raises`);
      });
    }
  }
});

describe('every registry entry, in every spelling generated from its path', { skip: POSIX, concurrency: 8 }, () => {
  test('the registry names files below home, each with its spellings', () => {
    assert.ok(REGISTRY.length >= 5, `the registry: ${REGISTRY}`);
    for (const file of REGISTRY) {
      assert.ok(!below(file).startsWith('..'), `${file} is below home`);
      assert.ok(spellings(below(file)).length >= 9, `${file} has its spellings`);
    }
  });
  for (const [label, env] of MODES) {
    for (const file of REGISTRY) {
      const rel = below(file);
      for (const spelled of spellings(rel)) {
        test(`${label}: cat ${spelled} asks as a secret`, async () => {
          await assertSecretCard(`cat ${spelled}`, file, `cat ~/${rel}`, env);
        });
      }
    }
    // The settings file is free to read, and a write to it asks.
    for (const spelled of spellings(below(SETTINGS))) {
      test(`${label}: echo x >> ${spelled} asks with the card the plain write raises`, async () => {
        const [via, base] = await Promise.all([ask(`echo x >> ${spelled}`, env), ask('echo x >> ~/.claude/settings.json', env)]);
        const crossing = via.cards[0] && via.cards[0].crossings.find(c => c.path === SETTINGS);
        assert.ok(crossing, `${spelled}: the card names the settings file: ${JSON.stringify(via.cards)}`);
        assert.deepStrictEqual(crossing, base.cards[0].crossings.find(c => c.path === SETTINGS), `${spelled}: the crossing the plain write raises`);
        assert.strictEqual(via.cards[0].grant_dir, base.cards[0].grant_dir);
        assert.strictEqual(via.cards[0].grantable, base.cards[0].grantable);
      });
    }
  }
});

describe('a word holding a variable or a substitution, matched on its literal end', { skip: POSIX, concurrency: 8 }, () => {
  const TAGGED = [
    // The entry's path below home, after the variable.
    ['H=~; cat $H/.claude/.credentials.json', CREDENTIALS],
    ['cat $(echo ~)/.claude/.credentials.json', CREDENTIALS],
    ['cat `echo ~`/.claude/.credentials.json', CREDENTIALS],
    ['cat "${H}"/.codex/auth.json', CODEX_AUTH],
    ['cat $H/.claude.json', CLAUDE_JSON],
    // The entry's file name straight after the variable.
    ['H=~/.claude; cat $H/.credentials.json', CREDENTIALS],
    ['H=~/.codex; cat "$H/auth.json"', CODEX_AUTH],
    // Any variable at all: an extra card in a rare case, the accepted cost.
    ['cat $DIR/auth.json', CODEX_AUTH],
  ];
  const UNTAGGED = ['H=~; cat $H/notes.md', 'H=~; cat $H/sub/.credentials.json', 'cat $H/x.claude.json', 'cat $DIR/sub/auth.json'];
  for (const [label, env] of MODES) {
    for (const [command, file] of TAGGED) {
      test(`${label}: ${command} asks as a secret`, async () => {
        await assertTagged(command, file, env);
      });
    }
    for (const command of UNTAGGED) {
      test(`${label}: ${command} is not tagged secret`, async () => {
        const r = await ask(command, env);
        assert.ok(r.answer, 'the hook answered');
        assert.ok(!anySecret(r.cards), `${command}: no secret crossing: ${JSON.stringify(r.cards)}`);
      });
    }
  }
});

describe('each way past the joined reading', { skip: POSIX, concurrency: 8 }, () => {
  const ROUTES = [
    ['the whole path quoted', 'cat "$HOME/.claude/.credentials.json"'],
    ['one component quoted', 'cat ~/".claude"/.credentials.json'],
    ['a name split across quotes', "cat ~/.claude/.cred''entials.json"],
    ['home in double quotes with what follows', 'cat "$HOME/.claude"/.credentials.json'],
    ['an escaped character, read as before', 'cat ~/\\.claude/.credentials.json'],
    ['a cd into the folder, read as before', 'cd ~/.claude && cat .credentials.json'],
    ['a quoted cd into the folder', 'cd ~/".claude" && cat .credentials.json'],
    ['a cd into home in double quotes', 'cd "$HOME/.claude" && cat .credentials.json'],
    ['home held in a variable', 'H=~/.claude; cat $H/.credentials.json'],
    ['home built by a substitution', 'cat $(echo ~)/.claude/.credentials.json'],
  ];
  for (const [label, env] of MODES) {
    for (const [route, command] of ROUTES) {
      test(`${label}: ${route}: ${command} asks as a secret`, async () => {
        await assertTagged(command, CREDENTIALS, env);
      });
    }
  }
});

describe('the plain spelling, then the joined one', { skip: POSIX }, () => {
  for (const [label, env] of MODES) {
    test(`${label}: the joined spelling right after the plain one raises the same secret crossing`, async () => {
      const first = await ask('cat ~/.claude/.credentials.json', env);
      const second = await ask('cat ~/.claude/".credentials.json"', env);
      for (const r of [first, second]) {
        assert.strictEqual(r.decision, 'deny');
        assert.strictEqual(r.cards.length, 1);
      }
      assert.ok(secretOf(first.cards[0], CREDENTIALS), 'the plain spelling asks as a secret');
      assert.deepStrictEqual(secretOf(second.cards[0], CREDENTIALS), secretOf(first.cards[0], CREDENTIALS), 'and the joined one the same');
      assert.deepStrictEqual(drawn(second.cards[0]), drawn(first.cards[0]), 'the same card');
    });
  }
});

// THE READING FAILING. A line the joined reading cannot read is asked about,
// as a crossing with nothing named: never answered as though it named nothing.
// The lexer is made to throw by a file loaded ahead of the hook, which
// replaces the lexer's export once the hook is loaded: the joined reading
// calls the lexer through its module, so only that reading fails.
describe('the joined reading failing asks', { skip: POSIX, concurrency: 4 }, () => {
  const failing = path.join(root, 'lexer-fails.js');
  fs.writeFileSync(failing, [
    "const Module = require('module');",
    'const compile = Module.prototype._compile;',
    'Module.prototype._compile = function (content, filename) {',
    '  const out = compile.call(this, content, filename);',
    `  if (filename.endsWith(${JSON.stringify(path.join('scripts', 'permission-hook.js'))})) require(${JSON.stringify(PARSER)}).lexWords = () => { throw new Error('forced failure'); };`,
    '  return out;',
    '};',
    '',
  ].join('\n'));
  // Past the length the joined reading reads.
  const LONG = `cat notes.md ${'a'.repeat(300 * 1024)}.md`;
  const asksWithNothingNamed = (r, what) => {
    assert.strictEqual(r.status, 0, `${what}: the hook exited cleanly: ${r.stderr}`);
    assert.strictEqual(r.decision, 'deny', `${what}: asked, and refused by the stand-in`);
    assert.strictEqual(r.cards.length, 1, `${what}: one card`);
    assert.strictEqual(r.cards[0].boundary, true, `${what}: graded as a crossing, so the server cannot answer it as a read`);
    assert.deepStrictEqual(r.cards[0].crossings, [], `${what}: nothing named`);
    assert.strictEqual(r.cards[0].grant_dir, null, `${what}: no folder offered`);
    assert.strictEqual(r.cards[0].grantable, false);
  };
  for (const [label, env] of MODES) {
    test(`${label}: sanity, cat notes.md read normally asks about no crossing`, async () => {
      const r = await ask('cat notes.md', env);
      assert.ok(r.answer, 'answered');
      assert.ok(!r.cards.some(c => c.boundary), 'not graded as a crossing');
    });
    test(`${label}: the lexer throwing asks about cat notes.md`, async () => {
      asksWithNothingNamed(await ask('cat notes.md', env, { preload: failing }), 'the lexer throwing');
    });
    test(`${label}: a line past the reading's length asks`, async () => {
      asksWithNothingNamed(await ask(LONG, env), 'a line past the length');
    });
    // Nobody to ask: answered as any ordinary crossing is then, by the rule
    // the hook keeps for that (WHAT TO DO WHEN NOBODY CAN BE ASKED).
    test(`${label}: with Rundock not there to ask, the hook still answers, as for an ordinary crossing`, async () => {
      const ordinary = await ask('cat ~/elsewhere.md', env, { at: 1 });
      assert.match(String(ordinary.answer && ordinary.answer.hookSpecificOutput.permissionDecisionReason), /unreachable/, 'sanity: an ordinary crossing tried to ask');
      for (const [what, command, preload] of [['the lexer throwing', 'cat notes.md', failing], ['a line past the length', LONG, undefined]]) {
        const r = await ask(command, env, { at: 1, preload });
        assert.strictEqual(r.status, 0, `${what}: the hook exited cleanly: ${r.stderr}`);
        assert.deepStrictEqual(r.answer, ordinary.answer, `${what}: the answer an ordinary crossing gets`);
      }
    });
  }
});
