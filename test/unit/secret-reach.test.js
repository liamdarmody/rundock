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
// is, which never equals the name it expands to.
//
// Each spelling below has to answer exactly as the direct one does.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const hook = require('../../scripts/permission-hook.js');

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
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

const classify = (command, opts = {}) => hook.classifyShellAccess('Bash', { command }, ws, [], home, undefined, opts);
const secretsIn = (access) => (access ? access.crossings.filter(c => c && c.secret).map(c => c.path) : []);
const MODES = [['Notes mode', {}], ['Code mode', { codeMode: true }]];

describe('a credential file named relative to a cd asks as the direct spelling does', () => {
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
    ['pushd ~/.claude && cat .credentials.json', CREDENTIALS, 'cat ~/.claude/.credentials.json'],
    ['(cd ~/.claude && cat .credentials.json)', CREDENTIALS, 'cat ~/.claude/.credentials.json'],
    [`bash -c 'cd ~/.claude && cat .credentials.json'`, CREDENTIALS, 'cat ~/.claude/.credentials.json'],
    ['cd ~/.claude && cp .credentials.json /tmp/x', CREDENTIALS, 'cp ~/.claude/.credentials.json /tmp/x'],
  ];
  for (const [label, opts] of MODES) {
    for (const [command, secret, direct] of cases) {
      test(`${label}: ${JSON.stringify(command)}`, () => {
        assert.ok(secretsIn(classify(direct, opts)).includes(secret), 'sanity: the direct spelling asks as a secret');
        assert.ok(secretsIn(classify(command, opts)).includes(secret), `${command} has to ask about ${secret} as a secret`);
      });
    }
  }
});

describe('a glob that can expand to a credential file asks about the file it reaches', () => {
  const cases = [
    ['cat ~/.claude/.cred*', CREDENTIALS],
    ['cat ~/.claude/.[c]redentials.json', CREDENTIALS],
    ['cat ~/.claude/.c*.json', CREDENTIALS],
    ['cat ~/.codex/auth*', CODEX_AUTH],
    ['cat ~/.codex/*', CODEX_AUTH],
    ['cat ~/.claude.j*', CLAUDE_JSON],
    ['cat ~/.c*/.credentials.json', CREDENTIALS],
    ['cd ~/.claude && cat .cred*', CREDENTIALS],
    // A star does not match a leading dot by the shell's default, but the
    // runtime's shell starts from a snapshot of the person's own settings,
    // which can turn on dotglob or globdots. For a credential file, which
    // has nothing beneath the card, the wider reading is the safe one.
    ['cat ~/.claude/*', CREDENTIALS],
  ];
  for (const [label, opts] of MODES) {
    for (const [command, secret] of cases) {
      test(`${label}: ${command}`, () => {
        assert.ok(secretsIn(classify(command, opts)).includes(secret), `${command} has to ask about ${secret} as a secret`);
      });
    }
  }
});

describe('nothing else gains a card', () => {
  for (const [label, opts] of MODES) {
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
      test(`${label}: ${command}`, () => {
        assert.deepStrictEqual(secretsIn(classify(command, opts)), [], `${command} reaches no credential file`);
      });
    }
  }
});

describe('the card a relative spelling raises is the card the direct one raises', () => {
  // Same tags, same offer: a secret card refuses a folder grant and an
  // always-allow, and that has to hold for the spelling that reached it.
  const strip = (access) => access && { ...access, crossings: access.crossings.map(c => ({ ...c })) };
  for (const [label, opts] of MODES) {
    test(`${label}: cd then a bare name`, () => {
      const viaCd = strip(classify('cd ~/.claude && cat .credentials.json', opts));
      const direct = strip(classify('cat ~/.claude/.credentials.json', opts));
      const secretOf = (a) => a.crossings.find(c => c.path === CREDENTIALS);
      assert.deepStrictEqual(secretOf(viaCd), secretOf(direct));
      assert.strictEqual(viaCd.grantable, direct.grantable);
      assert.strictEqual(viaCd.grantable, false, 'a secret is never answered by a stored grant');
    });
  }
});

describe('the five sequences', () => {
  for (const [label, opts] of MODES) {
    test(`${label}: the inverse, a write back by a relative name, asks as a secret`, () => {
      assert.ok(secretsIn(classify('cd ~/.claude && echo x > .credentials.json', opts)).includes(CREDENTIALS));
      assert.ok(secretsIn(classify('cd ~/.claude && cp /tmp/x .credentials.json', opts)).includes(CREDENTIALS));
    });

    test(`${label}: the undo, a cd back out, still asks where the hook cannot tell where the shell is`, () => {
      // `cd -` goes back to a folder this cannot know, and a second cd makes
      // the base uncertain, so the landing in the runtime's folder is tried.
      assert.ok(secretsIn(classify('cd ~/.claude && cd - && cat .credentials.json', opts)).includes(CREDENTIALS));
      assert.ok(secretsIn(classify('cd ~/.claude && cd /tmp && cat .credentials.json', opts)).includes(CREDENTIALS));
    });

    test(`${label}: the control failing, a cd it cannot follow, asks about a name the registry holds`, () => {
      for (const [command, secret] of [
        ['cd "$X" && cat .credentials.json', CREDENTIALS],
        ['cd $(dirname ~/.claude/x) && cat .credentials.json', CREDENTIALS],
        ['cd "$UNSET" && cat auth.json', CODEX_AUTH],
        ['cd `pwd` && cat .claude.json', CLAUDE_JSON],
      ]) {
        assert.ok(secretsIn(classify(command, opts)).includes(secret), `${command} has to ask about ${secret}`);
      }
      assert.deepStrictEqual(secretsIn(classify('cd "$X" && cat notes.md', opts)), [], 'only a name the registry holds');
    });
  }
});

// THROUGH THE REAL HOOK, as the runtime runs it, with a stand-in server that
// records every card it is asked to show and refuses each one.
function withServer(fn) {
  return async () => {
    const asked = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url.startsWith('/api/permission-request')) {
          asked.push(JSON.parse(body));
          res.end(JSON.stringify({ allow: false }));
        } else { res.statusCode = 404; res.end(); }
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try { await fn(server.address().port, asked); } finally { await new Promise(r => server.close(r)); }
  };
}
function runHook(port, command, env = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [HOOK], {
      env: { ...process.env, HOME: home, USERPROFILE: home, NODE_V8_COVERAGE: '', RUNDOCK: '1', RUNDOCK_PORT: String(port), RUNDOCK_WORKSPACE: ws, RUNDOCK_CONVO_ID: '', RUNDOCK_CODE_MODE: '', ...env },
    });
    let out = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.on('close', () => {
      let answer = null;
      try { answer = JSON.parse(out); } catch (e) { /* asserted by the callers */ }
      resolve(answer && answer.hookSpecificOutput ? answer.hookSpecificOutput.permissionDecision : null);
    });
    proc.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', cwd: ws, session_id: 's', tool_name: 'Bash', tool_input: { command } }));
  });
}
const secretCard = (req) => !!req && JSON.stringify(req).includes('"secret":true');
const POSIX = { skip: process.platform === 'win32' && 'the home folder is read from HOME here' };

describe('through the real hook', () => {
  for (const [label, env] of [['Notes mode', {}], ['Code mode', { RUNDOCK_CODE_MODE: '1' }]]) {
    for (const command of ['cd ~/.claude && cat .credentials.json', 'cd ~/.codex && cat auth.json', 'cat ~/.claude/.cred*', 'cd ~/.claude && echo x > .credentials.json']) {
      test(`${label}: ${command} raises a secret card`, POSIX, withServer(async (port, asked) => {
        assert.strictEqual(await runHook(port, command, env), 'deny', 'the stand-in refused the card');
        assert.strictEqual(asked.length, 1, 'a card was asked for');
        assert.ok(secretCard(asked[0]), 'and it is a secret card');
      }));
    }

    test(`${label}: the retry raises the same card again`, POSIX, withServer(async (port, asked) => {
      const command = 'cd ~/.claude && cat .credentials.json';
      assert.strictEqual(await runHook(port, command, env), 'deny');
      assert.strictEqual(await runHook(port, command, env), 'deny');
      assert.strictEqual(asked.length, 2);
      assert.ok(asked.every(secretCard));
    }));

    test(`${label}: with nobody to ask, a relative spelling gets the answer the direct one gets`, POSIX, async () => {
      // Port 1 refuses every connection.
      const direct = await runHook(1, 'cat ~/.claude/.credentials.json', env);
      assert.strictEqual(await runHook(1, 'cd ~/.claude && cat .credentials.json', env), direct);
      assert.strictEqual(await runHook(1, 'cat ~/.claude/.cred*', env), direct);
    });
  }

  test('Code mode: the most common next step, a free read in the same folder, raises no card', POSIX, withServer(async (port, asked) => {
    assert.strictEqual(await runHook(port, 'cd ~/.claude && ls', { RUNDOCK_CODE_MODE: '1' }), 'allow');
    assert.strictEqual(await runHook(port, 'cd ~/.claude && ls projects', { RUNDOCK_CODE_MODE: '1' }), 'allow');
    assert.strictEqual(asked.length, 0);
  }));
});
