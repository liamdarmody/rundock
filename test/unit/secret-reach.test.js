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

// And one whose credential file links into a folder named as a working folder,
// which must not cover it.
const namedLinked = path.join(root, 'named-linked');
fs.mkdirSync(path.join(namedLinked, '.claude'), { recursive: true });
fs.mkdirSync(path.join(namedLinked, 'dotfiles'));
fs.writeFileSync(path.join(namedLinked, 'dotfiles', 'claude-credentials.json'), '{}');
fs.symlinkSync(path.join(namedLinked, 'dotfiles', 'claude-credentials.json'), path.join(namedLinked, '.claude', '.credentials.json'));
// A workspace that links to that credential file, and to an ordinary file in
// the same folder, by names the registry does not hold: `alpha.json` and
// `beta.md`. Nothing in either word names a secret, so only where the link
// leads can tell them apart.
const namedLinkWs = path.join(root, 'named-link-ws');
fs.mkdirSync(namedLinkWs);
fs.writeFileSync(path.join(namedLinked, 'dotfiles', 'example.md'), '');
fs.symlinkSync(path.join(namedLinked, '.claude', '.credentials.json'), path.join(namedLinkWs, 'alpha.json'));
fs.symlinkSync(path.join(namedLinked, 'dotfiles', 'example.md'), path.join(namedLinkWs, 'beta.md'));

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

// The hook's whole answer, and every card it asked the stand-in for. The
// runtime-home variables are left unset unless a case sets them, whatever the
// shell running the tests has.
function ask(command, env = {}, { homeDir = home, at, tool = 'Bash', input, workspace = ws, cwd = workspace, preload } = {}) {
  const session = `s${++runs}`;
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [...(preload ? ['--require', preload] : []), HOOK], {
      env: {
        ...process.env, HOME: homeDir, USERPROFILE: homeDir, NODE_V8_COVERAGE: '',
        RUNDOCK: '1', RUNDOCK_PORT: String(at === undefined ? port : at), RUNDOCK_WORKSPACE: workspace,
        RUNDOCK_CONVO_ID: '', RUNDOCK_CODE_MODE: '', CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, ...env,
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
      hook_event_name: 'PreToolUse', cwd, session_id: session, tool_name: tool, tool_input: input || { command },
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
async function assertAsOnMain(label, command, env, opts) {
  const r = await ask(command, env, opts);
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
    // A cd into a folder an earlier command makes, which is not there yet when
    // the command is judged.
    ['cd ~/.claude && mkdir -p new && cd new && cat ../.credentials.json', CREDENTIALS, 'mkdir -p new && cat ~/.claude/.credentials.json'],
    // A cd that fails across `;` leaves the shell where it was.
    ['cd ~/.claude; cd ./nonexistent; cat .credentials.json', CREDENTIALS, 'cat ~/.claude/.credentials.json'],
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
    // A glob folder climbed back out of: the shell expands `*` to a folder
    // there, so `*/..` is the folder it started in.
    ['cd ~/.claude && cat */../.credentials.json', CREDENTIALS],
    ['cat ~/.claude/projects/*/../../.credentials.json', CREDENTIALS],
    ['cat ~/.c*/projects/../.credentials.json', CREDENTIALS],
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
      // `~/.c*` is matched against the folder as it sits in home, not where it
      // leads.
      for (const command of ['cat ~/.claude/.credentials.json', 'cat ~/.claude/.cred*', 'cat ~/.claude/*', 'cat ~/.c*/.credentials.json', 'cd ~/.claude && cat .credentials.json']) {
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

describe('a credential file that links into a named working folder is not covered by it', { skip: POSIX, concurrency: 8 }, () => {
  const file = path.join(namedLinked, 'dotfiles', 'claude-credentials.json');
  for (const [label, mode] of MODES) {
    const env = { ...mode, RUNDOCK_EXTRA_DIRS: path.join(namedLinked, 'dotfiles') };
    for (const command of ['cat ~/.claude/.credentials.json', 'cd ~/.claude && cat .credentials.json', 'cat ~/.claude/.cred*', 'cat ~/.c*/.credentials.json']) {
      test(`${label}: ${command}`, async () => {
        await assertSecretCard(command, file, null, env, { homeDir: namedLinked });
      });
    }
    for (const tool of ['Read', 'Write']) {
      test(`${label}: the ${tool} tool`, async () => {
        const input = { file_path: path.join(namedLinked, '.claude', '.credentials.json'), ...(tool === 'Write' ? { content: 'x' } : {}) };
        const r = await ask(null, env, { homeDir: namedLinked, tool, input });
        assert.strictEqual(r.decision, 'deny', 'carded, and refused by the stand-in');
        assert.strictEqual(r.cards.length, 1);
        assert.ok(secretOf(r.cards[0], file), 'the card names the file as a secret');
        assert.strictEqual(r.cards[0].boundary, true, 'a boundary card, which never offers a standing allow');
        assert.strictEqual(r.cards[0].grant_dir, null, 'no folder to remember');
      });
    }
    // The control: the same folder still covers an ordinary file in it.
    test(`${label}: an ordinary file in that folder stays covered`, async () => {
      const r = await ask(null, env, { homeDir: namedLinked, tool: 'Read', input: { file_path: path.join(namedLinked, 'dotfiles', 'notes.md') } });
      assert.strictEqual(r.decision, 'allow');
      assert.strictEqual(r.cards.length, 0);
    });
    // A workspace link to the credential file, by a name the registry does not
    // hold, leads into the named folder too. No word names a secret, so the
    // folder's own refusal to cover a secret is all that keeps it asking.
    test(`${label}: a workspace link to it, by another name, asks as the secret`, async () => {
      const opts = { homeDir: namedLinked, workspace: namedLinkWs };
      for (const command of ['cat alpha.json', 'cat ./alpha.json']) assertSecretCrossing(await ask(command, env, opts), file, command);
      // The control: a link to an ordinary file there is covered, as on main.
      for (const command of ['cat beta.md', 'cat ./beta.md']) await assertAsOnMain(label, command, env, opts);
    });
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
      // A cd run through `command` is followed like any other.
      await assertAsOnMain(label, 'cd ~/.claude && command cd /tmp && cat .credentials.json', env);
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
        // A folder change the move scan cannot see.
        `eval 'cd ~/.claude' && cat .credentials.json`,
        'eval cd ~/.claude && cat .credentials.json',
        // `command -v cd` names `cd` and moves nothing: the shell stays put.
        'cd ~/.claude && command -v cd && cat .credentials.json',
      ]) {
        await assertSecretCard(command, CREDENTIALS, null, env);
      }
    });

    // A `cd` the shell may skip, or one that moves only a shell of its own,
    // does not move the words after it, even when only `&&` stands between
    // them: after `||` it runs only when the command before it failed, and in
    // a subshell it moves that subshell alone. Taken as a move, either would
    // put the shell in /tmp, and the credential file it really reads would go
    // unasked. Joined by `;` or a pipe instead, the folder before it is kept
    // anyway, so only `&&` shows whether such a move is trusted.
    test(`${label}: a cd that may not last, after || or in a subshell, does not move where a name is read from`, async () => {
      for (const command of [
        'cd ~/.claude && true || cd /tmp && cat .credentials.json',
        'cd ~/.claude && (cd /tmp) && cat .credentials.json',
        'cd ~/.claude && (cd /tmp && true) && cat .credentials.json',
      ]) {
        await assertSecretCard(command, CREDENTIALS, null, env);
      }
    });

    test(`${label}: a cd run through command or builtin moves the shell as cd does`, async () => {
      await assertSecretCard('command cd ~/.claude && cat .credentials.json', CREDENTIALS, null, env);
      await assertSecretCard('builtin cd ~/.claude && cat .credentials.json', CREDENTIALS, null, env);
      await assertSecretCard('command cd ~/.codex && cat auth.json', CODEX_AUTH, null, env);
    });

    // The folder the runtime says the command starts in is where a bare name
    // is read from, until a `cd` the shell is sure to make moves it.
    test(`${label}: a command starting in the runtime folder`, async () => {
      const there = path.join(home, '.claude');
      const r = await ask('cat .credentials.json', env, { cwd: there });
      assert.strictEqual(r.cards.length, 1);
      assert.ok(secretOf(r.cards[0], CREDENTIALS), 'a bare name there is the credential file');
      const out = await ask('cd /tmp && cat .credentials.json', env, { cwd: there });
      assert.ok(!anySecret(out.cards), 'after a cd the shell is sure to make, the start folder is not tried');
      assert.strictEqual(out.decision, ON_MAIN[label].decision);
      assert.strictEqual(out.cards.length, ON_MAIN[label].cards);
      const unsure = await ask('cd /tmp; cat .credentials.json', env, { cwd: there });
      assert.ok(secretOf(unsure.cards[0], CREDENTIALS), 'but across `;` a failed cd leaves it there');
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
// compared, so that difference is caught. A credential read with nobody to
// ask is now refused (credential-read-unanswered.test.js), so every spelling
// is refused, in the direct spelling's words.
describe('with the server unreachable', { skip: POSIX, concurrency: 8 }, () => {
  for (const [label, env] of MODES) {
    test(`${label}: a relative or glob spelling gets the answer the direct one gets`, async () => {
      const direct = await ask('cat ~/.claude/.credentials.json', env, { at: 1 });
      assert.strictEqual(direct.decision, 'deny', 'sanity: the direct spelling is refused');
      assert.ok(direct.reason.startsWith('Rundock server unreachable. This reads a sign-in credential,'), direct.reason);
      for (const command of ['cd ~/.claude && cat .credentials.json', 'cat ~/.claude/.cred*', 'cat ~/.claude/*']) {
        const r = await ask(command, env, { at: 1 });
        assert.strictEqual(r.decision, 'deny', `${command}: refused, as the direct spelling is`);
        assert.deepStrictEqual(r.answer, direct.answer, `${command}: the same answer, for the same reason`);
      }
    });
  }
});

// WHERE THE WORKSPACE SITS, OR WHERE A LINK IN IT LEADS, NEVER HIDES A SECRET.
// A home of its own for these, so the cases above keep theirs: `atHome`, with
// everything the registry names in it (Claude Code's backups folder too), and
// `above`, the folder that holds it.
const above = path.join(root, 'above');
const atHome = path.join(above, 'home');
const COPY = '.claude.json.backup.1700000000000';
const AT = {
  credentials: path.join(atHome, '.claude', '.credentials.json'),
  config: path.join(atHome, '.claude', '.config.json'),
  codexAuth: path.join(atHome, '.codex', 'auth.json'),
  claudeJson: path.join(atHome, '.claude.json'),
  claudeJsonBackup: path.join(atHome, '.claude.json.backup'),
};
const BACKUPS = path.join(atHome, '.claude', 'backups');
const BACKUP_COPY = path.join(BACKUPS, COPY);
const ORDINARY = {
  notes: path.join(atHome, 'notes.md'),
  app: path.join(atHome, 'src', 'app.js'),
  project: path.join(atHome, '.claude', 'projects', 'p.jsonl'),
  todo: path.join(atHome, '.claude', 'todos', 't.json'),
};
for (const d of [BACKUPS, path.join(atHome, '.claude', 'projects'), path.join(atHome, '.claude', 'todos'), path.join(atHome, '.codex'), path.join(atHome, 'src')]) {
  fs.mkdirSync(d, { recursive: true });
}
for (const f of [...Object.values(AT), BACKUP_COPY, ...Object.values(ORDINARY)]) fs.writeFileSync(f, '{}');

// A workspace that links to the registry: `link.json` and `sub/link.json` lead
// to the account file and `dotclaude` to the runtime's folder, while
// `plain.md` and `away.md` lead to ordinary files, in the workspace and out of
// it. `gone.json` leads into the backups folder, to a copy not there yet, and
// `loop-a.json` round a loop.
const linkWs = path.join(root, 'link-ws');
fs.mkdirSync(path.join(linkWs, 'sub'), { recursive: true });
fs.writeFileSync(path.join(linkWs, 'notes.md'), '');
fs.symlinkSync(AT.claudeJson, path.join(linkWs, 'link.json'));
fs.symlinkSync(AT.claudeJson, path.join(linkWs, 'sub', 'link.json'));
fs.symlinkSync(path.join(atHome, '.claude'), path.join(linkWs, 'dotclaude'));
fs.symlinkSync(path.join(linkWs, 'notes.md'), path.join(linkWs, 'plain.md'));
fs.symlinkSync(ORDINARY.notes, path.join(linkWs, 'away.md'));
fs.symlinkSync(path.join(BACKUPS, '.claude.json.backup.1800000000000'), path.join(linkWs, 'gone.json'));
fs.symlinkSync(path.join(linkWs, 'loop-b.json'), path.join(linkWs, 'loop-a.json'));
fs.symlinkSync(path.join(linkWs, 'loop-a.json'), path.join(linkWs, 'loop-b.json'));

// A workspace that links to each registry file by a name the registry does not
// hold, so no word in `cat alpha.json` names a secret: only where it leads does.
const aliasWs = path.join(root, 'alias-ws');
const ALIASES = [['alpha.json', AT.credentials], ['beta.json', AT.config], ['gamma.json', AT.codexAuth], ['delta.json', AT.claudeJson], ['epsilon.json', AT.claudeJsonBackup]];
fs.mkdirSync(aliasWs);
for (const [link, file] of ALIASES) fs.symlinkSync(file, path.join(aliasWs, link));

// A home whose registry files are links that resolve to nothing: the account
// file round a loop, the credential file to a place that is not there.
const loopHome = path.join(root, 'loop-home');
fs.mkdirSync(path.join(loopHome, '.claude'), { recursive: true });
fs.symlinkSync(path.join(loopHome, '.claude.json.next'), path.join(loopHome, '.claude.json'));
fs.symlinkSync(path.join(loopHome, '.claude.json'), path.join(loopHome, '.claude.json.next'));
fs.symlinkSync(path.join(loopHome, 'nowhere', 'credentials'), path.join(loopHome, '.claude', '.credentials.json'));

// A runtime home moved by CLAUDE_CONFIG_DIR, outside the default homes and the
// workspace, with what Claude Code was seen to keep there and an ordinary file.
const moved = path.join(root, 'moved-claude');
const MOVED = {
  claudeJson: path.join(moved, '.claude.json'),
  copy: path.join(moved, 'backups', COPY),
  ordinary: path.join(moved, 'projects', 'p.jsonl'),
};
fs.mkdirSync(path.join(moved, 'backups'), { recursive: true });
fs.mkdirSync(path.join(moved, 'projects'), { recursive: true });
for (const f of Object.values(MOVED)) fs.writeFileSync(f, '{}');
const MOVE = { CLAUDE_CONFIG_DIR: moved };
// And a link to its account file, by another name, in the workspace above.
fs.symlinkSync(MOVED.claudeJson, path.join(aliasWs, 'zeta.json'));

// THE CREDENTIAL FILES OF A MOVED RUNTIME HOME, each in a folder of its own
// inside a folder that is also a workspace, beside an ordinary file: Codex's
// sign-in file where CODEX_HOME was seen to keep it, and Claude Code's
// credential file where CLAUDE_CONFIG_DIR puts it, by the default home's name.
const holder = path.join(root, 'holder-ws');
const RELOCATED = [
  { variable: 'CLAUDE_CONFIG_DIR', dir: path.join(holder, 'claude-home'), secret: '.credentials.json', ordinary: path.join('projects', 'p.jsonl') },
  { variable: 'CODEX_HOME', dir: path.join(holder, 'codex-home'), secret: 'auth.json', ordinary: path.join('log', 'codex-login.log') },
];
for (const r of RELOCATED) {
  fs.mkdirSync(path.join(r.dir, path.dirname(r.ordinary)), { recursive: true });
  for (const f of [r.secret, r.ordinary]) fs.writeFileSync(path.join(r.dir, f), '{}');
}
fs.writeFileSync(path.join(holder, 'notes.md'), '');
// And Claude Code's account file in its folder, for the case with both set.
fs.writeFileSync(path.join(RELOCATED[0].dir, '.claude.json'), '{}');

const AT_HOME = { homeDir: atHome, workspace: atHome };
const ELSEWHERE = { homeDir: atHome, workspace: ws };
const LINKED = { homeDir: atHome, workspace: linkWs };
const toolInput = (tool, file) => ({ file_path: file, ...(tool === 'Write' ? { content: 'x' } : {}), ...(tool === 'Edit' ? { old_string: '{', new_string: '[' } : {}) });

// A secret crossing on a card, at `file` or, for a folder, anywhere under it.
const secretUnder = (card, dir) => (card && Array.isArray(card.crossings)
  ? card.crossings.find(c => c.secret === true && (c.path === dir || c.path.startsWith(dir + path.sep))) : undefined);
function assertSecretCrossing(r, file, what, { folder = false } = {}) {
  assert.strictEqual(r.decision, 'deny', `${what}: carded, and refused by the stand-in`);
  assert.strictEqual(r.cards.length, 1, `${what}: one card`);
  const card = r.cards[0];
  assert.ok(folder ? secretUnder(card, file) : secretOf(card, file), `${what}: the card names ${path.relative(root, file)} as a secret: ${JSON.stringify(card.crossings)}`);
  assert.strictEqual(card.boundary, true, `${what}: a boundary card, which no standing grant answers for a secret`);
  assert.strictEqual(card.grant_dir, null, `${what}: no folder is offered to remember`);
  if (card.tool_name === 'Bash') assert.strictEqual(card.grantable, false, `${what}: a command card`);
}
// Free in both modes, as on main: no card at all.
function assertFree(r, what) {
  assert.strictEqual(r.decision, 'allow', `${what}: allowed`);
  assert.strictEqual(r.cards.length, 0, `${what}: no card`);
}
const fileTool = (tool, file, env, opts) => ask(null, env, { ...opts, tool, input: toolInput(tool, file) });

describe('a workspace at home, at a runtime home or above one does not hide a secret', { skip: POSIX, concurrency: 8 }, () => {
  const readSpellings = [
    ['a bare name', 'cat .claude.json', AT.claudeJson],
    ['a ./ name', 'cat ./.claude.json', AT.claudeJson],
    ['a ~ path', 'cat ~/.claude.json', AT.claudeJson],
    ['a $HOME path', 'cat $HOME/.claude.json', AT.claudeJson],
    ['the absolute path', `cat ${AT.claudeJson}`, AT.claudeJson],
    ['the account backup', 'cat .claude.json.backup', AT.claudeJsonBackup],
    ['the credential file', 'cat .claude/.credentials.json', AT.credentials],
    ['the config file', 'cat .claude/.config.json', AT.config],
    ['the Codex sign-in', 'cat .codex/auth.json', AT.codexAuth],
    ['a name after a cd', 'cd .claude && cat .credentials.json', AT.credentials],
    ['a glob', 'cat .claude/.cred*', AT.credentials],
    ['a backup copy', `cat .claude/backups/${COPY}`, BACKUP_COPY],
  ];
  const writeSpellings = [
    ['a redirect onto the account file', 'echo x > .claude.json', AT.claudeJson],
    ['a copy onto the account file', 'cp src/app.js .claude.json', AT.claudeJson],
    ['removing the account file', 'rm .claude.json', AT.claudeJson],
    ['a ./ name', 'truncate -s 0 ./.claude.json', AT.claudeJson],
    ['a change of mode', 'chmod 600 .claude.json', AT.claudeJson],
    ['touching the credential file', 'touch .claude/.credentials.json', AT.credentials],
    ['a name after a cd', 'cd .claude && echo x > .credentials.json', AT.credentials],
    ['the Codex sign-in', 'echo x > .codex/auth.json', AT.codexAuth],
    ['a backup copy', `echo x > .claude/backups/${COPY}`, BACKUP_COPY],
  ];
  for (const [label, env] of MODES) {
    for (const [name, command, file] of readSpellings) {
      test(`${label}, at home, a shell read by ${name}`, async () => assertSecretCrossing(await ask(command, env, AT_HOME), file, command));
    }
    test(`${label}, at home, a recursive read of the workspace`, async () => {
      for (const command of ['grep -r TODO .', 'tar czf - .']) assertSecretCrossing(await ask(command, env, AT_HOME), atHome, command, { folder: true });
    });
    test(`${label}, at home, the backups folder read whole or listed`, async () => {
      for (const command of ['grep -r TODO .claude/backups', 'ls .claude/backups']) assertSecretCrossing(await ask(command, env, AT_HOME), BACKUPS, command, { folder: true });
    });
    for (const [file, name] of [[AT.claudeJson, 'the account file'], [AT.credentials, 'the credential file'], [BACKUP_COPY, 'a backup copy']]) {
      test(`${label}, at home, the Read tool on ${name}`, async () => assertSecretCrossing(await fileTool('Read', file, env, AT_HOME), file, `Read ${name}`));
    }
    for (const tool of ['Write', 'Edit']) {
      for (const [file, name] of [[AT.claudeJson, 'the account file'], [AT.credentials, 'the credential file'], [AT.codexAuth, 'the Codex sign-in'], [BACKUP_COPY, 'a backup copy']]) {
        test(`${label}, at home, the ${tool} tool on ${name}`, async () => assertSecretCrossing(await fileTool(tool, file, env, AT_HOME), file, `${tool} ${name}`));
      }
    }
    // A shell write asks as the file tools' does, however it is spelled.
    for (const [name, command, file] of writeSpellings) {
      test(`${label}, at home, a shell write by ${name}`, async () => assertSecretCrossing(await ask(command, env, AT_HOME), file, command));
    }
    const atRuntime = { homeDir: atHome, workspace: path.join(atHome, '.claude') };
    test(`${label}, at the runtime's folder, a read of its secrets`, async () => {
      assertSecretCrossing(await ask('cat .credentials.json', env, atRuntime), AT.credentials, 'cat .credentials.json');
      assertSecretCrossing(await fileTool('Read', AT.config, env, atRuntime), AT.config, 'Read .config.json');
    });
    test(`${label}, at the runtime's folder, a backup copy read or the folder listed`, async () => {
      assertSecretCrossing(await ask(`cat backups/${COPY}`, env, atRuntime), BACKUP_COPY, 'cat a backup copy');
      assertSecretCrossing(await ask('ls backups', env, atRuntime), BACKUPS, 'ls backups', { folder: true });
      assertSecretCrossing(await fileTool('Read', BACKUP_COPY, env, atRuntime), BACKUP_COPY, 'Read a backup copy');
    });
    test(`${label}, at the runtime's folder, the Write tool on its secrets`, async () => {
      assertSecretCrossing(await fileTool('Write', AT.credentials, env, atRuntime), AT.credentials, 'Write .credentials.json');
      assertSecretCrossing(await fileTool('Write', BACKUP_COPY, env, atRuntime), BACKUP_COPY, 'Write a backup copy');
    });
    test(`${label}, at the runtime's folder, a shell write to its secrets`, async () => {
      assertSecretCrossing(await ask('echo x > .credentials.json', env, atRuntime), AT.credentials, 'echo x > .credentials.json');
      assertSecretCrossing(await ask(`cp ../notes.md backups/${COPY}`, env, atRuntime), BACKUP_COPY, 'cp onto a backup copy');
    });
    test(`${label}, at the Codex folder, its sign-in asks`, async () => {
      const there = { homeDir: atHome, workspace: path.join(atHome, '.codex') };
      assertSecretCrossing(await ask('cat auth.json', env, there), AT.codexAuth, 'cat auth.json');
      assertSecretCrossing(await fileTool('Read', AT.codexAuth, env, there), AT.codexAuth, 'Read auth.json');
    });
    const aboveHome = { homeDir: atHome, workspace: above };
    test(`${label}, above home, a read of its secrets`, async () => {
      assertSecretCrossing(await ask('cat home/.claude.json', env, aboveHome), AT.claudeJson, 'cat home/.claude.json');
      assertSecretCrossing(await fileTool('Read', AT.credentials, env, aboveHome), AT.credentials, 'Read the credential file');
    });
    test(`${label}, above home, a recursive read of the workspace`, async () => {
      assertSecretCrossing(await ask('grep -r TODO .', env, aboveHome), atHome, 'grep -r TODO .', { folder: true });
    });
    test(`${label}, above home, a backup copy read`, async () => {
      assertSecretCrossing(await ask(`cat home/.claude/backups/${COPY}`, env, aboveHome), BACKUP_COPY, 'cat a backup copy');
    });
    test(`${label}, above home, the Write tool on its secrets`, async () => {
      assertSecretCrossing(await fileTool('Write', AT.claudeJson, env, aboveHome), AT.claudeJson, 'Write the account file');
    });
    test(`${label}, above home, a shell write to its secrets`, async () => {
      assertSecretCrossing(await ask('echo x > home/.claude.json', env, aboveHome), AT.claudeJson, 'echo x > home/.claude.json');
    });
    // Everything else in such a workspace stays inside work.
    test(`${label}, at home, ordinary files stay inside work`, async () => {
      for (const file of [ORDINARY.notes, ORDINARY.app, ORDINARY.project, ORDINARY.todo]) {
        assertFree(await fileTool('Read', file, env, AT_HOME), `Read ${path.relative(atHome, file)}`);
      }
      assertFree(await fileTool('Write', ORDINARY.notes, env, AT_HOME), 'Write notes.md');
      for (const command of ['cat notes.md', 'cat src/app.js', 'cat .claude/projects/p.jsonl', 'cat ~/.claude/todos/t.json', 'grep -r TODO src', 'ls .claude/projects']) {
        await assertAsOnMain(label, command, env, AT_HOME);
      }
    });
    test(`${label}, at the runtime's folder and above home, ordinary files stay inside work`, async () => {
      const there = { homeDir: atHome, workspace: path.join(atHome, '.claude') };
      assertFree(await fileTool('Read', ORDINARY.project, env, there), 'Read projects/p.jsonl');
      await assertAsOnMain(label, 'cat projects/p.jsonl', env, there);
      const up = { homeDir: atHome, workspace: above };
      assertFree(await fileTool('Read', ORDINARY.app, env, up), 'Read home/src/app.js');
      await assertAsOnMain(label, 'cat home/notes.md', env, up);
    });
  }
});

describe('a workspace link that leads to a secret asks as the secret', { skip: POSIX, concurrency: 8 }, () => {
  const cases = [
    ['a bare link', 'cat link.json', AT.claudeJson],
    ['a ./ link', 'cat ./link.json', AT.claudeJson],
    ['a nested link', 'cat sub/link.json', AT.claudeJson],
    ['a nested ./ link', 'cat ./sub/link.json', AT.claudeJson],
    ['a link after a cd', 'cd sub && cat link.json', AT.claudeJson],
    ['the link by its absolute path', `cat ${path.join(linkWs, 'link.json')}`, AT.claudeJson],
    ['a copy of a link', 'cp link.json /tmp/x', AT.claudeJson],
    ['a linked folder', 'cat dotclaude/.credentials.json', AT.credentials],
    ['a ./ linked folder', 'cat ./dotclaude/.credentials.json', AT.credentials],
    ['a name after a cd into a linked folder', 'cd dotclaude && cat .credentials.json', AT.credentials],
    ['a backup copy through a linked folder', `cat dotclaude/backups/${COPY}`, BACKUP_COPY],
  ];
  for (const [label, env] of MODES) {
    for (const [name, command, file] of cases) {
      test(`${label}: ${name}`, async () => assertSecretCrossing(await ask(command, env, LINKED), file, command));
    }
    test(`${label}: a listing through a linked folder`, async () => {
      assertSecretCrossing(await ask('ls dotclaude/backups', env, LINKED), BACKUPS, 'ls dotclaude/backups', { folder: true });
    });
    test(`${label}: the file tools judge the link where it leads, as on main`, async () => {
      for (const tool of ['Read', 'Write']) {
        assertSecretCrossing(await fileTool(tool, path.join(linkWs, 'link.json'), env, LINKED), AT.claudeJson, `${tool} link.json`);
        assertSecretCrossing(await fileTool(tool, path.join(linkWs, 'dotclaude', '.credentials.json'), env, LINKED), AT.credentials, `${tool} dotclaude/.credentials.json`);
      }
    });
    test(`${label}: a link to an ordinary file stays inside work`, async () => {
      for (const command of ['cat plain.md', 'cat ./plain.md', 'cat away.md', 'cat notes.md', 'cat loop-a.json']) {
        await assertAsOnMain(label, command, env, LINKED);
      }
      assertFree(await fileTool('Read', path.join(linkWs, 'plain.md'), env, LINKED), 'Read plain.md');
    });
  }
});

describe('a working folder at home or a runtime home leaves its secrets asking', { skip: POSIX, concurrency: 8 }, () => {
  // The registry as it stands on main: these pin what already holds. The
  // backups folder, new to the registry, is asked for below them.
  const files = [AT.credentials, AT.config, AT.codexAuth, AT.claudeJson, AT.claudeJsonBackup];
  const NAMED = [['home', atHome], ['~/.claude', path.join(atHome, '.claude')], ['~/.codex', path.join(atHome, '.codex')]];
  for (const [label, mode] of MODES) {
    for (const [name, folder] of NAMED) {
      const env = { ...mode, RUNDOCK_EXTRA_DIRS: folder };
      test(`${label}, ${name} named: the Read tool`, async () => {
        for (const file of files) assertSecretCrossing(await fileTool('Read', file, env, ELSEWHERE), file, `Read ${path.relative(atHome, file)}`);
      });
      test(`${label}, ${name} named: a shell read`, async () => {
        for (const file of files) assertSecretCrossing(await ask(`cat ${file}`, env, ELSEWHERE), file, `cat ${path.relative(atHome, file)}`);
      });
      // Through a workspace link by another name, the word names no secret, so
      // only the named folder's refusal to cover a runtime home or a secret
      // keeps the read asking.
      test(`${label}, ${name} named: a shell read through a workspace link by another name`, async () => {
        for (const [link, file] of ALIASES) assertSecretCrossing(await ask(`cat ${link}`, env, { homeDir: atHome, workspace: aliasWs }), file, `cat ${link}`);
      });
    }
    test(`${label}, each folder named: a backup copy, by file tool and shell`, async () => {
      for (const [name, folder] of NAMED) {
        const env = { ...mode, RUNDOCK_EXTRA_DIRS: folder };
        assertSecretCrossing(await fileTool('Read', BACKUP_COPY, env, ELSEWHERE), BACKUP_COPY, `Read, ${name} named`);
        assertSecretCrossing(await ask(`cat ${BACKUP_COPY}`, env, ELSEWHERE), BACKUP_COPY, `cat, ${name} named`);
      }
    });
    test(`${label}: the named folder still covers an ordinary file`, async () => {
      assertFree(await fileTool('Read', ORDINARY.notes, { ...mode, RUNDOCK_EXTRA_DIRS: atHome }, ELSEWHERE), 'Read notes.md');
    });
  }
});

describe('the backups folder asks as a secret', { skip: POSIX, concurrency: 8 }, () => {
  const files = [
    ['the absolute path', `cat ${BACKUP_COPY}`],
    ['a ~ path', `cat ~/.claude/backups/${COPY}`],
    ['a $HOME path', `cat $HOME/.claude/backups/${COPY}`],
    ['a name after a cd into the runtime folder', `cd ~/.claude && cat backups/${COPY}`],
    ['another reader', `head -c 100 ~/.claude/backups/${COPY}`],
    ['a write', `echo x > ~/.claude/backups/${COPY}`],
  ];
  const folder = [
    ['a glob in it', 'cat ~/.claude/backups/*'],
    ['a glob to it', 'cat ~/.claude/b*/*'],
    ['a glob for the copies', 'cat ~/.claude/backups/.claude.json.backup.*'],
    ['a recursive read of it', 'grep -r token ~/.claude/backups'],
    ['a recursive read of the runtime folder', 'grep -r token ~/.claude'],
    ['an archive of it', 'tar czf - ~/.claude/backups'],
    ['a recursive copy of it', 'cp -r ~/.claude/backups /tmp/x'],
    ['a listing', 'ls ~/.claude/backups'],
    ['a long listing', 'ls -la ~/.claude/backups/'],
    ['a listing after a cd', 'cd ~/.claude && ls backups'],
    ['a name after a cd into it', `cd ~/.claude/backups && cat ${COPY}`],
    ['a find', 'find ~/.claude/backups'],
  ];
  for (const [label, env] of MODES) {
    for (const [name, command] of files) {
      test(`${label}: ${name}`, async () => assertSecretCrossing(await ask(command, env, ELSEWHERE), BACKUP_COPY, command));
    }
    for (const [name, command] of folder) {
      test(`${label}: ${name}`, async () => assertSecretCrossing(await ask(command, env, ELSEWHERE), BACKUPS, command, { folder: true }));
    }
    for (const tool of ['Read', 'Write', 'Edit']) {
      test(`${label}: the ${tool} tool`, async () => assertSecretCrossing(await fileTool(tool, BACKUP_COPY, env, ELSEWHERE), BACKUP_COPY, `${tool} a backup copy`));
    }
  }
});

describe('a runtime home moved by CLAUDE_CONFIG_DIR keeps its secrets', { skip: POSIX, concurrency: 8 }, () => {
  // The card with the session it was asked in taken out, to compare answers.
  const shape = (r) => ({ decision: r.decision, cards: r.cards.map(({ session_id, ...card }) => card) });
  for (const [label, mode] of MODES) {
    const env = { ...mode, ...MOVE };
    for (const [name, command, file] of [
      ['the account file', `cat ${MOVED.claudeJson}`, MOVED.claudeJson],
      ['the account file after a cd', `cd ${moved} && cat .claude.json`, MOVED.claudeJson],
      ['a backup copy', `cat ${MOVED.copy}`, MOVED.copy],
      ['a write to the account file', `echo x > ${MOVED.claudeJson}`, MOVED.claudeJson],
    ]) {
      test(`${label}: ${name}`, async () => assertSecretCrossing(await ask(command, env, ELSEWHERE), file, command));
    }
    test(`${label}: its backups folder, listed or read whole`, async () => {
      for (const command of [`ls ${moved}/backups`, `grep -r token ${moved}/backups`, `cat ${moved}/b*/*`]) {
        assertSecretCrossing(await ask(command, env, ELSEWHERE), path.join(moved, 'backups'), command, { folder: true });
      }
    });
    for (const tool of ['Read', 'Write', 'Edit']) {
      test(`${label}: the ${tool} tool`, async () => {
        assertSecretCrossing(await fileTool(tool, MOVED.claudeJson, env, ELSEWHERE), MOVED.claudeJson, `${tool} the account file`);
        assertSecretCrossing(await fileTool(tool, MOVED.copy, env, ELSEWHERE), MOVED.copy, `${tool} a backup copy`);
      });
    }
    // Named as a working folder, the moved home is not a runtime home to the
    // named folder's check, and its account file reached through a link by
    // another name names no secret in the word: only that check's refusal to
    // cover a secret keeps the read asking.
    test(`${label}: named as a working folder, its account file through a workspace link by another name`, async () => {
      const named = { ...env, RUNDOCK_EXTRA_DIRS: moved };
      assertSecretCrossing(await ask('cat zeta.json', named, { homeDir: atHome, workspace: aliasWs }), MOVED.claudeJson, 'cat zeta.json');
    });
    test(`${label}: the default homes keep theirs`, async () => {
      for (const file of [AT.credentials, AT.claudeJson, AT.codexAuth]) {
        assertSecretCrossing(await ask(`cat ${file}`, env, ELSEWHERE), file, `cat ${path.relative(atHome, file)}`);
        assertSecretCrossing(await fileTool('Read', file, env, ELSEWHERE), file, `Read ${path.relative(atHome, file)}`);
      }
    });
    test(`${label}: the default backups folder keeps its place`, async () => {
      assertSecretCrossing(await ask(`cat ${BACKUP_COPY}`, env, ELSEWHERE), BACKUP_COPY, 'cat a backup copy');
      assertSecretCrossing(await fileTool('Read', BACKUP_COPY, env, ELSEWHERE), BACKUP_COPY, 'Read a backup copy');
    });
    // Only adds: nothing in the variable's folder becomes free, and nothing
    // the registry does not name becomes a secret.
    test(`${label}: an ordinary file there is judged as it was without the variable`, async () => {
      for (const r of [[`cat ${MOVED.ordinary}`], [null, 'Read'], [null, 'Write']]) {
        const run = (e) => (r[0] ? ask(r[0], e, ELSEWHERE) : fileTool(r[1], MOVED.ordinary, e, ELSEWHERE));
        const without = await run(mode);
        const withIt = await run(env);
        assert.deepStrictEqual(shape(withIt), shape(without), `${r[0] || r[1]}: the same answer`);
        assert.ok(!anySecret(withIt.cards), `${r[0] || r[1]}: no secret`);
      }
    });
    test(`${label}: set to a folder that holds the workspace, the workspace stays as it was`, async () => {
      for (const e of [{ ...mode, CLAUDE_CONFIG_DIR: root }, { ...mode, CLAUDE_CONFIG_DIR: ws }]) {
        assertFree(await fileTool('Read', path.join(ws, 'notes.md'), e, ELSEWHERE), `Read notes.md, the variable at ${path.relative(root, e.CLAUDE_CONFIG_DIR) || 'the test root'}`);
        await assertAsOnMain(label, 'cat notes.md', e, ELSEWHERE);
      }
    });
  }
});

describe('a runtime home moved by CLAUDE_CONFIG_DIR or CODEX_HOME keeps its credential file', { skip: POSIX, concurrency: 8 }, () => {
  const shape = (r) => ({ decision: r.decision, cards: r.cards.map(({ session_id, ...card }) => card) });
  const HOLDING = { homeDir: atHome, workspace: holder };
  const PLACES = [['from a workspace elsewhere', ELSEWHERE], ['from a workspace holding the folder', HOLDING]];
  for (const [label, mode] of MODES) {
    for (const r of RELOCATED) {
      const env = { ...mode, [r.variable]: r.dir };
      const file = path.join(r.dir, r.secret);
      const ordinary = path.join(r.dir, r.ordinary);
      for (const [where, opts] of PLACES) {
        test(`${label}, ${r.variable} set, ${where}: its ${r.secret} asks as a secret, by Read, Write and cat`, async () => {
          for (const tool of ['Read', 'Write']) assertSecretCrossing(await fileTool(tool, file, env, opts), file, `${tool} ${r.secret}`);
          assertSecretCrossing(await ask(`cat ${file}`, env, opts), file, `cat ${r.secret}`);
          if (opts === HOLDING) assertSecretCrossing(await ask(`cat ${path.relative(holder, file)}`, env, opts), file, `cat ${path.relative(holder, file)}`);
        });
        test(`${label}, ${r.variable} set, ${where}: an ordinary file in the same folder is judged as it was without the variable`, async () => {
          for (const run of [(e) => ask(`cat ${ordinary}`, e, opts), (e) => fileTool('Read', ordinary, e, opts), (e) => fileTool('Write', ordinary, e, opts)]) {
            const withIt = await run(env);
            assert.deepStrictEqual(shape(withIt), shape(await run(mode)), `${r.ordinary}: the same answer`);
            assert.ok(!anySecret(withIt.cards), `${r.ordinary}: no secret`);
          }
        });
        test(`${label}, ${r.variable} unset, ${where}: its ${r.secret} is answered as the ordinary file beside it`, async () => {
          for (const [what, run] of [['cat', (f) => ask(`cat ${f}`, mode, opts)], ['Read', (f) => fileTool('Read', f, mode, opts)], ['Write', (f) => fileTool('Write', f, mode, opts)]]) {
            const secret = await run(file);
            const plain = await run(ordinary);
            assert.ok(!anySecret(secret.cards), `${what} ${r.secret}: no secret`);
            assert.strictEqual(secret.decision, plain.decision, `${what} ${r.secret}: the same decision as ${r.ordinary}`);
            assert.strictEqual(secret.cards.length, plain.cards.length, `${what} ${r.secret}: as many cards as ${r.ordinary}`);
          }
        });
      }
    }
    test(`${label}, both set: each folder's credential file asks, and so do Claude Code's account file and the default homes'`, async () => {
      const env = { ...mode, ...Object.fromEntries(RELOCATED.map(r => [r.variable, r.dir])) };
      for (const file of [...RELOCATED.map(r => path.join(r.dir, r.secret)), path.join(RELOCATED[0].dir, '.claude.json'), AT.credentials, AT.codexAuth]) {
        for (const [where, opts] of PLACES) {
          assertSecretCrossing(await fileTool('Read', file, env, opts), file, `Read ${path.relative(root, file)}, ${where}`);
          assertSecretCrossing(await ask(`cat ${file}`, env, opts), file, `cat ${path.relative(root, file)}, ${where}`);
        }
      }
    });
    test(`${label}: CODEX_HOME set to a folder that holds the workspace, the workspace stays as it was`, async () => {
      for (const e of [{ ...mode, CODEX_HOME: root }, { ...mode, CODEX_HOME: ws }]) {
        assertFree(await fileTool('Read', path.join(ws, 'notes.md'), e, ELSEWHERE), `Read notes.md, the variable at ${path.relative(root, e.CODEX_HOME) || 'the test root'}`);
        await assertAsOnMain(label, 'cat notes.md', e, ELSEWHERE);
      }
    });
  }
});

describe('the five sequences, for where a secret sits', { skip: POSIX, concurrency: 8 }, () => {
  for (const [label, env] of MODES) {
    test(`${label}: the inverse, ordinary files and the runtime's own folders stay free, and a backup write asks`, async () => {
      for (const file of [ORDINARY.notes, ORDINARY.app]) assertFree(await fileTool('Read', file, env, AT_HOME), `Read ${path.relative(atHome, file)} at home`);
      for (const file of [ORDINARY.project, ORDINARY.todo]) assertFree(await fileTool('Read', file, env, ELSEWHERE), `Read ${path.relative(atHome, file)}`);
      await assertAsOnMain(label, 'cat ~/.claude/projects/p.jsonl', env, ELSEWHERE);
      await assertAsOnMain(label, 'cat ~/.claude/todos/t.json', env, ELSEWHERE);
      assertSecretCrossing(await fileTool('Write', BACKUP_COPY, env, ELSEWHERE), BACKUP_COPY, 'Write a backup copy');
      assertSecretCrossing(await ask(`echo x > ~/.claude/backups/${COPY}`, env, ELSEWHERE), BACKUP_COPY, 'a shell write to a backup copy');
    });

    test(`${label}: the undo, the variable unset again, drops the moved folder at the next call`, async () => {
      assertSecretCrossing(await ask(`cat ${MOVED.claudeJson}`, { ...env, ...MOVE }, ELSEWHERE), MOVED.claudeJson, 'with the variable');
      const after = await ask(`cat ${MOVED.claudeJson}`, env, ELSEWHERE);
      assert.ok(!anySecret(after.cards), 'without it, the moved account file is an ordinary file outside');
      assert.strictEqual(after.decision, ON_MAIN[label].decision, 'which is answered as any file outside is');
      assert.strictEqual(after.cards.length, ON_MAIN[label].cards);
      for (const file of [AT.claudeJson, BACKUP_COPY]) assertSecretCrossing(await ask(`cat ${file}`, env, ELSEWHERE), file, `the default home unchanged: ${path.relative(atHome, file)}`);
    });

    test(`${label}: the retry, at home, the same file spelled another way asks the same`, async () => {
      const first = await ask('cat .claude.json', env, AT_HOME);
      assertSecretCrossing(first, AT.claudeJson, 'cat .claude.json');
      const key = (r) => ({ secret: !!secretOf(r.cards[0], AT.claudeJson), boundary: r.cards[0].boundary, grant_dir: r.cards[0].grant_dir });
      for (const command of [`cat ${AT.claudeJson}`, 'cat ~/.claude.json', 'cat $HOME/.claude.json', 'cat ./.claude.json']) {
        assert.deepStrictEqual(key(await ask(command, env, AT_HOME)), key(first), command);
      }
      assert.deepStrictEqual(key(await ask(null, env, { ...AT_HOME, tool: 'Read', input: { file_path: '.claude.json' } })), key(first), 'the Read tool with a relative path');
    });

    test(`${label}: the retry, through a link, the link name, its target and the linked folder ask the same`, async () => {
      const crossing = async (command, file) => secretOf((await ask(command, env, LINKED)).cards[0], file);
      const viaLink = await crossing('cat link.json', AT.claudeJson);
      assert.ok(viaLink, 'the link name asks');
      assert.deepStrictEqual(await crossing(`cat ${AT.claudeJson}`, AT.claudeJson), viaLink, 'the link target');
      assert.deepStrictEqual(await crossing('cat sub/link.json', AT.claudeJson), viaLink, 'the nested link');
      const viaFolder = await crossing('cat dotclaude/.credentials.json', AT.credentials);
      assert.ok(viaFolder, 'relative through the linked folder asks');
      assert.deepStrictEqual(await crossing('cat ~/.claude/.credentials.json', AT.credentials), viaFolder, 'the same file by its own path');
    });

    test(`${label}: the most common next step, at home, a search of the whole workspace asks and a search of a folder does not`, async () => {
      assertSecretCrossing(await ask('grep -r TODO .', env, AT_HOME), atHome, 'grep -r TODO .', { folder: true });
      await assertAsOnMain(label, 'grep -r TODO src', env, AT_HOME);
    });

    test(`${label}: the control failing, a link that resolves to nothing is judged by where it sits`, async () => {
      // The account file round a loop, the credential file leading nowhere.
      const away = { homeDir: loopHome, workspace: ws };
      assertSecretCrossing(await ask('cat ~/.claude.json', env, away), path.join(loopHome, '.claude.json'), 'a looping account file');
      assertSecretCrossing(await ask('cat ~/.claude/.credentials.json', env, away), path.join(loopHome, '.claude', '.credentials.json'), 'a dangling credential file');
      const there = { homeDir: loopHome, workspace: loopHome };
      assertSecretCrossing(await ask('cat .claude.json', env, there), path.join(loopHome, '.claude.json'), 'a looping account file, at home');
      assertSecretCrossing(await fileTool('Read', path.join(loopHome, '.claude.json'), env, there), path.join(loopHome, '.claude.json'), 'Read a looping account file, at home');
      assertSecretCrossing(await ask('cat .claude/.credentials.json', env, there), path.join(loopHome, '.claude', '.credentials.json'), 'a dangling credential file, at home');
      // A workspace link into the backups folder, to a copy not made yet.
      assertSecretCrossing(await ask('cat gone.json', env, LINKED), path.join(linkWs, 'gone.json'), 'a link to a copy not there yet');
    });
  }
});

// THE NEW CHECKS FAILING. Each preload makes one of them throw, from outside
// the hook, as test/unit/hook-never-crashes.test.js does: reading the moved
// home's variable, asking whether the backups folder is there, and reading a
// word's entry to see whether it is a link. A request the hook could not check
// is refused, never allowed.
describe('when the new checks fail, the request is refused', { skip: POSIX, concurrency: 8 }, () => {
  const preload = (name, body) => {
    const file = path.join(root, `${name}.js`);
    fs.writeFileSync(file, body);
    return file;
  };
  const variableThrows = preload('variable-throws', `
    const env = process.env;
    process.env = new Proxy(env, { get(t, k) { if (k === 'CLAUDE_CONFIG_DIR') throw new Error('forced failure'); return Reflect.get(t, k); } });
  `);
  const folderCheckThrows = preload('folder-check-throws', `
    const fs = require('fs');
    const path = require('path');
    const exists = fs.existsSync;
    fs.existsSync = function (p) { if (String(p).endsWith(path.sep + 'backups')) throw new Error('forced failure'); return exists.apply(this, arguments); };
  `);
  // A link's entry that cannot be read, for a reason other than there being no
  // link to read: the disk failing under it.
  const readlinkFails = preload('readlink-fails', `
    const fs = require('fs');
    const path = require('path');
    const readlink = fs.readlinkSync;
    fs.readlinkSync = function (p) {
      if (path.basename(String(p)) === 'link.json') { const e = new Error('forced failure'); e.code = 'EIO'; throw e; }
      return readlink.apply(this, arguments);
    };
  `);
  const refused = (r, what) => {
    assert.strictEqual(r.decision, 'deny', `${what}: refused`);
    assert.match(r.reason, /refused/, `${what}: as a request that could not be checked`);
    assert.strictEqual(r.cards.length, 0, `${what}: with no card`);
  };
  const codeMode = { RUNDOCK_CODE_MODE: '1' };
  test('reading the moved home\'s variable throws: a free read is refused', async () => {
    assertFree(await ask('cat notes.md', codeMode), 'sanity: allowed without the failure');
    refused(await ask('cat notes.md', codeMode, { preload: variableThrows }), 'cat notes.md');
    refused(await ask(null, codeMode, { preload: variableThrows, tool: 'Read', input: { file_path: path.join(ws, 'notes.md') } }), 'Read notes.md');
  });
  test('asking whether the backups folder is there throws: a free read is refused', async () => {
    assertFree(await ask('grep -r TODO .', codeMode), 'sanity: allowed without the failure');
    refused(await ask('grep -r TODO .', codeMode, { preload: folderCheckThrows }), 'grep -r TODO .');
  });
  for (const [label, mode] of MODES) {
    for (const [name, run] of [
      ['cat link.json', (opts) => ask('cat link.json', mode, { ...LINKED, ...opts })],
      ['cat sub/link.json', (opts) => ask('cat sub/link.json', mode, { ...LINKED, ...opts })],
      ['the Read tool on a workspace link', (opts) => fileTool('Read', path.join(linkWs, 'link.json'), mode, { ...LINKED, ...opts })],
    ]) {
      test(`${label}: reading a link's entry fails with an I/O error: ${name} is refused`, async () => {
        assertSecretCrossing(await run({}), AT.claudeJson, `sanity: ${name} asks as a secret without the failure`);
        refused(await run({ preload: readlinkFails }), name);
      });
    }
    // A word too long to be any file's name has no entry, so it is no link,
    // and a long commit message is answered as it always was.
    test(`${label}: a word too long to be a file's name is no link, so a long commit message is answered as on main`, async () => {
      await assertAsOnMain(label, `git commit -m "${'word '.repeat(80)}"`, mode);
    });
    // Nor can any file's name hold a NUL byte, so a word that does is no link.
    test(`${label}: a word holding a NUL byte names no file, so it is no link, and is answered as on main`, async () => {
      await assertAsOnMain(label, 'git commit -m "x\u0000y"', mode);
    });
  }
});
