'use strict';
// A CREDENTIAL FILE IS ASKED ABOUT HOWEVER IT IS SPELLED. The secrets tier
// cards on any access to the runtime's credential files, and the sandbox
// beneath it refuses writes only, so for a read the card is the whole guard.
// It was reached with no card at all by two spellings an agent writes
// naturally:
//
//   cd ~/.claude && cat .credentials.json    the name is relative to the cd
//   cat ~/.claude/.cred*                      the name is a glob
//
// The first was judged from the workspace root, because a `cd` that leaves
// the workspace is not trusted as a base, and the `cd` itself reports nothing
// when it lands somewhere free to read. The second was compared as the text it
// is, which never equals the name it expands to. And a credential file that is
// a link, or sits in a folder that is one, was judged where the link leads,
// which is not where the registry names it.
//
// Every case runs the real hook as its own process, the way the runtime does,
// against a stand-in server that records each card it is asked to show and
// refuses it. The home folder is a temporary one, never the real one.
// The card's own offers, and what a stored answer covers, are in
// test/integration/secret-reach-card.test.js, which needs the real server.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'secret-reach-')));
const home = path.join(root, 'home');
const ws = path.join(root, 'ws');
for (const d of [path.join(home, '.claude', 'projects'), path.join(home, '.codex'), path.join(ws, 'sub'), path.join(ws, '.claude')]) {
  fs.mkdirSync(d, { recursive: true });
}
const CREDENTIALS = path.join(home, '.claude', '.credentials.json');
const CONFIG = path.join(home, '.claude', '.config.json');
const CODEX_AUTH = path.join(home, '.codex', 'auth.json');
const CLAUDE_JSON = path.join(home, '.claude.json');
for (const f of [CREDENTIALS, CONFIG, CODEX_AUTH, CLAUDE_JSON]) fs.writeFileSync(f, '{}');

// THE SAME CREDENTIAL REACHED THROUGH A LINK. In `dirLinked` the runtime's
// folder is a link into a dotfiles folder in the same home, the usual way
// people share settings between machines. In `fileLinked` the file itself is a
// link, to a place outside home that Code mode would otherwise treat as a
// scratch folder.
const dirLinked = path.join(root, 'dir-linked');
fs.mkdirSync(path.join(dirLinked, 'dotfiles', 'claude'), { recursive: true });
fs.writeFileSync(path.join(dirLinked, 'dotfiles', 'claude', '.credentials.json'), '{}');
fs.symlinkSync(path.join(dirLinked, 'dotfiles', 'claude'), path.join(dirLinked, '.claude'));
const fileLinked = path.join(root, 'file-linked');
fs.mkdirSync(path.join(fileLinked, '.claude'), { recursive: true });
fs.mkdirSync(path.join(root, 'store'));
fs.writeFileSync(path.join(root, 'store', 'credentials.json'), '{}');
fs.symlinkSync(path.join(root, 'store', 'credentials.json'), path.join(fileLinked, '.claude', '.credentials.json'));

const POSIX = process.platform === 'win32' ? 'the home folder and links are read the POSIX way here' : false;
const MODES = [['Notes mode', {}], ['Code mode', { RUNDOCK_CODE_MODE: '1' }]];

// One stand-in for the whole file. Each run carries its own session id, so
// runs can overlap and each still reads back only its own cards.
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

// The hook's whole answer, and every card it asked the stand-in for.
function ask(command, env = {}, { homeDir = home, at, tool = 'Bash', input } = {}) {
  const session = `s${++runs}`;
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [HOOK], {
      env: {
        ...process.env, HOME: homeDir, USERPROFILE: homeDir, NODE_V8_COVERAGE: '',
        RUNDOCK: '1', RUNDOCK_PORT: String(at === undefined ? port : at), RUNDOCK_WORKSPACE: ws,
        RUNDOCK_CONVO_ID: '', RUNDOCK_CODE_MODE: '', ...env,
      },
    });
    let out = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.on('close', () => {
      let answer = null;
      try { answer = JSON.parse(out); } catch (e) { /* asserted below */ }
      const o = (answer && answer.hookSpecificOutput) || {};
      resolve({ answer, decision: o.permissionDecision || null, reason: o.permissionDecisionReason || null, cards: asked.get(session) || [] });
    });
    proc.stdin.end(JSON.stringify({
      hook_event_name: 'PreToolUse', cwd: ws, session_id: session, tool_name: tool, tool_input: input || { command },
    }));
  });
}
const secretOf = (card, file) => (card && Array.isArray(card.crossings) ? card.crossings.find(c => c.path === file && c.secret === true) : undefined);
const anySecret = (cards) => cards.some(card => (card.crossings || []).some(c => c && c.secret));

// One secret card, naming the file as a secret, exactly as the direct spelling
// of the same command names it, with no folder offered to remember.
async function assertSecretCard(command, file, direct, env, opts) {
  const via = await ask(command, env, opts);
  assert.strictEqual(via.decision, 'deny', `${command}: the stand-in refused the card, so it was asked`);
  assert.strictEqual(via.cards.length, 1, `${command}: one card was asked for`);
  const crossing = secretOf(via.cards[0], file);
  assert.ok(crossing, `${command}: the card names ${file} as a secret`);
  assert.strictEqual(via.cards[0].grant_dir, null, `${command}: no folder is offered to remember`);
  assert.strictEqual(via.cards[0].grantable, false);
  if (direct) {
    const plain = await ask(direct, env, opts);
    assert.ok(secretOf(plain.cards[0], file), `sanity: ${direct} asks about ${file} as a secret`);
    assert.deepStrictEqual(crossing, secretOf(plain.cards[0], file), `${command}: the same crossing ${direct} raises`);
  }
}

// MEASURED ON main, through this same hook and stand-in, for every command
// below that has to keep its answer. Notes mode asks about every shell command,
// and the stand-in refuses; Code mode runs them with no card. Neither is a
// secret card.
const ON_MAIN = { 'Notes mode': { decision: 'deny', cards: 1 }, 'Code mode': { decision: 'allow', cards: 0 } };
async function assertAsOnMain(label, command, env) {
  const r = await ask(command, env);
  assert.strictEqual(r.decision, ON_MAIN[label].decision, `${command}: answered as on main`);
  assert.strictEqual(r.cards.length, ON_MAIN[label].cards, `${command}: as many cards as on main`);
  assert.ok(!anySecret(r.cards), `${command}: no secret card`);
}

describe('a credential file named relative to a cd asks as the direct spelling does', { skip: POSIX, concurrency: 8 }, () => {
  const cases = [
    ['cd ~/.claude && cat .credentials.json', CREDENTIALS, 'cat ~/.claude/.credentials.json'],
    ['cd ~/.claude; cat .credentials.json', CREDENTIALS, 'cat ~/.claude/.credentials.json'],
    ['cd ~/.claude\ncat .credentials.json', CREDENTIALS, 'cat ~/.claude/.credentials.json'],
    ['cd ~/.claude && cat ./.credentials.json', CREDENTIALS, 'cat ~/.claude/.credentials.json'],
    ['cd ~/.claude && cat .config.json', CONFIG, 'cat ~/.claude/.config.json'],
    ['cd $HOME/.claude && cat .credentials.json', CREDENTIALS, 'cat ~/.claude/.credentials.json'],
    ['cd ~/.codex && cat auth.json', CODEX_AUTH, 'cat ~/.codex/auth.json'],
    ['cd ~ && cat .claude.json', CLAUDE_JSON, 'cat ~/.claude.json'],
    // A `cd` with nothing after it goes home.
    ['cd && cat .claude.json', CLAUDE_JSON, 'cat ~/.claude.json'],
    ['pushd ~/.claude && cat .credentials.json', CREDENTIALS, 'pushd ~/.claude && cat ~/.claude/.credentials.json'],
    ['(cd ~/.claude && cat .credentials.json)', CREDENTIALS, '(cat ~/.claude/.credentials.json)'],
    [`bash -c 'cd ~/.claude && cat .credentials.json'`, CREDENTIALS, `bash -c 'cat ~/.claude/.credentials.json'`],
    // A copy, and a write.
    ['cd ~/.claude && cp .credentials.json /tmp/x', CREDENTIALS, 'cp ~/.claude/.credentials.json /tmp/x'],
    ['cd ~/.claude && echo x > .credentials.json', CREDENTIALS, 'echo x > ~/.claude/.credentials.json'],
  ];
  for (const [label, env] of MODES) {
    for (const [command, file, direct] of cases) {
      test(`${label}: ${JSON.stringify(command)}`, () => assertSecretCard(command, file, direct, env));
    }
  }
});

describe('a glob that can expand to a credential file asks about the file it reaches', { skip: POSIX, concurrency: 8 }, () => {
  const cases = [
    ['cat ~/.claude/.cred*', CREDENTIALS],
    ['cat ~/.claude/*', CREDENTIALS],
    ['cat ~/.codex/auth*', CODEX_AUTH],
    ['cat ~/.claude.j*', CLAUDE_JSON],
    ['cat ~/.claude/.[c]redentials.json', CREDENTIALS],
    ['cat ~/.claude/.c*.json', CREDENTIALS],
    ['cat ~/.codex/*', CODEX_AUTH],
    ['cat ~/.c*/.credentials.json', CREDENTIALS],
    ['cat ~/**/.credentials.json', CREDENTIALS],
    ['cd ~/.claude && cat .cred*', CREDENTIALS],
  ];
  // A star does not match a leading dot by the shell's default, but the
  // runtime's shell starts from a snapshot of the person's own settings, which
  // can turn on dotglob or globdots. For a credential file, which has nothing
  // beneath the card, the wider reading is the safe one: `~/.claude/*` asks.
  const direct = { [CREDENTIALS]: 'cat ~/.claude/.credentials.json', [CODEX_AUTH]: 'cat ~/.codex/auth.json', [CLAUDE_JSON]: 'cat ~/.claude.json' };
  for (const [label, env] of MODES) {
    for (const [command, file] of cases) {
      test(`${label}: ${command}`, () => assertSecretCard(command, file, direct[file], env));
    }
  }
});

describe('a credential file that is a link, or in a folder that is one, still asks', { skip: POSIX, concurrency: 8 }, () => {
  // Reported as the place the link leads, which is where the read lands, and
  // tagged secret because that place is the registry's file.
  const linkedCreds = fs.realpathSync(path.join(dirLinked, '.claude', '.credentials.json'));
  const fileCreds = path.join(root, 'store', 'credentials.json');
  for (const [label, env] of MODES) {
    for (const [homeDir, file, where] of [[dirLinked, linkedCreds, 'the folder is a link'], [fileLinked, fileCreds, 'the file is a link']]) {
      for (const command of ['cat ~/.claude/.credentials.json', 'cat ~/.claude/.cred*', 'cat ~/.claude/*', 'cd ~/.claude && cat .credentials.json']) {
        test(`${label}, ${where}: ${command}`, () => assertSecretCard(command, file, null, env, { homeDir }));
      }
      test(`${label}, ${where}: the Read tool`, async () => {
        const r = await ask(null, env, { homeDir, tool: 'Read', input: { file_path: path.join(homeDir, '.claude', '.credentials.json') } });
        assert.strictEqual(r.decision, 'deny');
        assert.strictEqual(r.cards.length, 1);
        assert.ok(secretOf(r.cards[0], file), 'the card names the file as a secret');
        assert.strictEqual(r.cards[0].grant_dir, null);
      });
    }
  }
});

describe('nothing else gains a card', { skip: POSIX, concurrency: 8 }, () => {
  for (const [label, env] of MODES) {
    for (const command of [
      'cat notes.md',
      'ls dist',
      'cat auth.json',
      'cat sub/auth.json',
      'cd sub && cat auth.json',
      'cd ~/.claude && ls projects',
      'cd ~/.claude && cat settings.json',
      'ls ~/.claude/projects/*',
      'cat ~/.codex/config.*',
      'cd /tmp && cat .credentials.json',
    ]) {
      test(`${label}: ${command}`, () => assertAsOnMain(label, command, env));
    }
  }
});

describe('the five sequences', { skip: POSIX, concurrency: 8 }, () => {
  for (const [label, env] of MODES) {
    test(`${label}: the inverse, a write back by a relative name, raises the same card`, async () => {
      await assertSecretCard('cd ~/.claude && echo x > .credentials.json', CREDENTIALS, 'echo x > ~/.claude/.credentials.json', env);
      await assertSecretCard('cd ~/.claude && cp /tmp/x .credentials.json', CREDENTIALS, 'cp /tmp/x ~/.claude/.credentials.json', env);
    });

    // A `cd` that leaves is followed wherever the shell is sure to be: only
    // `&&` stands between it and the word, so if it fails the word never runs.
    test(`${label}: the undo, a cd back out, is judged from where the shell really is`, async () => {
      await assertAsOnMain(label, 'cd ~/.claude && cd /tmp && cat .credentials.json', env);
      // `cd -` goes back to the folder before the last move.
      await assertAsOnMain(label, 'cd ~/.claude && cd - && cat .credentials.json', env);
      // And where it really is decides: from home, `.claude.json` is one.
      await assertSecretCard('cd ~/.claude && cd .. && cat .claude.json', CLAUDE_JSON, 'cat ~/.claude.json', env);
    });

    test(`${label}: the undo, where the hook cannot tell, still asks`, async () => {
      for (const command of [
        // The `cd` can fail (no permission, or a folder the sandbox will not
        // enter), and after `;` the shell carries on where it was.
        'cd ~/.claude; cd /tmp; cat .credentials.json',
        'cd ~/.claude && cd /no-such-folder; cat .credentials.json',
        // A `cd` in a pipeline runs in a shell of its own, and moves nothing.
        'cd ~/.claude && cd /tmp | cat && cat .credentials.json',
        // `popd`, and a `cd` this hook cannot see.
        'cd ~/.claude && pushd /tmp && popd && cat .credentials.json',
        'cd ~/.claude && eval "cd /tmp" && cat .credentials.json',
        // The folder before the first move is not known.
        'cd - && cat .credentials.json',
      ]) {
        await assertSecretCard(command, CREDENTIALS, null, env);
      }
    });

    test(`${label}: the retry, after a refusal, raises the same card again`, async () => {
      const command = 'cd ~/.claude && cat .credentials.json';
      const first = await ask(command, env);
      const second = await ask(command, env);
      assert.strictEqual(first.decision, 'deny');
      assert.strictEqual(second.decision, 'deny', 'refused again: the first refusal answered nothing for it');
      assert.strictEqual(second.cards.length, 1);
      const strip = (card) => { const c = { ...card }; delete c.session_id; return c; };
      assert.deepStrictEqual(strip(second.cards[0]), strip(first.cards[0]), 'the same card');
    });

    test(`${label}: the most common next step, a free read in the same folder, answers as on main`, async () => {
      // No card at all in Code mode; in Notes mode the one every shell command
      // gets, never a secret one. The allowed-then-free-read sequence, against
      // the real server, is in test/integration/secret-reach-card.test.js.
      await assertAsOnMain(label, 'cd ~/.claude && ls', env);
      await assertAsOnMain(label, 'cd ~/.claude && ls projects', env);
    });

    test(`${label}: the control failing, a cd it cannot follow, asks about a name the registry holds`, async () => {
      for (const [command, file] of [
        ['cd "$X" && cat .credentials.json', CREDENTIALS],
        ['cd $(dirname ~/.claude/x) && cat .credentials.json', CREDENTIALS],
        ['cd "$(echo ~/.claude)" && cat .credentials.json', CREDENTIALS],
        ['cd "$UNSET" && cat auth.json', CODEX_AUTH],
        ['cd `pwd` && cat .claude.json', CLAUDE_JSON],
        ['cd ~/.claude && cd "$X" && cat .credentials.json', CREDENTIALS],
      ]) {
        await assertSecretCard(command, file, null, env);
      }
      await assertAsOnMain(label, 'cd "$X" && cat notes.md', env);
    });
  }
});

// WITH NOBODY TO ASK, the spelling must not change the answer. Port 1 refuses
// every connection. On main the direct spelling reached for the server and was
// let through because it could not be reached, while in Code mode the relative
// and glob spellings were approved as ordinary Code-mode commands without ever
// asking: the same decision, for a different reason. The whole answer is
// compared, so that difference is caught. Whether the secrets tier should
// refuse when nobody can be asked is a separate change.
describe('with the server unreachable', { skip: POSIX, concurrency: 8 }, () => {
  for (const [label, env] of MODES) {
    test(`${label}: a relative or glob spelling gets the answer the direct one gets`, async () => {
      const direct = await ask('cat ~/.claude/.credentials.json', env, { at: 1 });
      assert.strictEqual(direct.decision, 'allow', 'sanity: the direct spelling is let through');
      assert.strictEqual(direct.reason, 'Rundock server unreachable.');
      for (const command of ['cd ~/.claude && cat .credentials.json', 'cat ~/.claude/.cred*', 'cat ~/.claude/*']) {
        const r = await ask(command, env, { at: 1 });
        assert.strictEqual(r.decision, 'allow', `${command}: allowed, as the direct spelling is`);
        assert.deepStrictEqual(r.answer, direct.answer, `${command}: the same answer, for the same reason`);
      }
    });
  }
});
