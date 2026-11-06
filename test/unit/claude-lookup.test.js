'use strict';
// RUNDOCK STARTS THE CLAUDE CODE THE PERSON'S LOGIN SHELL FINDS.
//
// The desktop app never gets the PATH the person's shell builds, so it put
// four install folders ahead of the PATH it had and took the first `claude`
// along that. An old copy in one of them beat the current copy the person's
// terminal starts, and every chat failed (#401). The lookup now asks the
// person's login shell for its PATH, takes the first copy along it, then
// along those folders, that is not known to be below the version floor, and
// falls back to the old lookup whenever the shell cannot answer.
//
// Every case runs stub shells and stub copies in a temp folder (see
// test/helpers/login-shell.js). Each case has a home folder of its own, and
// the install folders the desktop app adds are stood in by folders inside it,
// so no real Claude Code, and no real shell, is ever run here.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { makeTempDir, cleanup } = require('../helpers/workspace.js');
const { makeLoginShell, makeClaude, CURRENT, OLD } = require('../helpers/login-shell.js');

after(cleanup);

const ROOT = path.join(__dirname, '..', '..');
const LIB_KEY = require.resolve('../../lib/runtime/claude.js');
const lookup = () => require('../../lib/runtime/claude-lookup.js');
const config = require('../../lib/config.js');
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const POSIX = process.platform === 'win32' ? 'the stubs are POSIX scripts and the login shell is a POSIX idea' : false;
const FIXED_COMMAND = "printf '%s%s\\n' _RUNDOCK_LOGIN_PATH _BEGIN_; printenv PATH; printf '%s%s\\n' _RUNDOCK_LOGIN_PATH _END_";
const CHAT_ARGS = ['--output-format', 'stream-json', '--verbose', '--agent', 'writer'];
const frozen = (version, bin) => `Rundock found Claude Code ${version} at ${bin}. Rundock needs 2.0.59 or later. `
  + 'Update that copy with `claude update`, or remove it, then send your message again.';

// A private copy of the spawn runtime per test, so a remembered verdict never
// carries from one test into the next. The lookup keeps its answer per PATH,
// SHELL and HOME, and each case has a home of its own.
function freshClaudeRuntime() {
  const cached = require.cache[LIB_KEY];
  delete require.cache[LIB_KEY];
  const mod = require(LIB_KEY);
  delete require.cache[LIB_KEY];
  if (cached) require.cache[LIB_KEY] = cached;
  return mod;
}

// A machine: a home folder, the four install folders the desktop app adds
// (two in the home, two standing in for the system ones), and a login shell
// whose startup files build `loginPath`.
function machine(plan = {}, shellName = 'zsh') {
  const root = makeTempDir('login-lookup-');
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const folders = {
    local: path.join(home, '.local', 'bin'), claude: path.join(home, '.claude', 'bin'),
    usrLocal: path.join(root, 'usr-local-bin'), homebrew: path.join(root, 'opt-homebrew-bin'),
  };
  const shell = makeLoginShell(root, { loginPath: '/usr/bin:/bin', ...plan }, shellName);
  return { root, home, folders, shell, dir: (name) => path.join(root, name) };
}
const loginPath = (...dirs) => [...dirs, '/usr/bin', '/bin'].join(':');

// Runs `fn` on the machine: HOME is its home, SHELL its stub shell (or
// `shell`), and the PATH Rundock was started with is `today` plus the system
// folders `which` lives in. Restored afterwards.
async function on(m, { today = [], shell = m.shell.file, env = {}, platform } = {}, fn) {
  const names = ['PATH', 'HOME', 'SHELL', ...Object.keys(env)];
  const before = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  const set = (n, v) => { if (v === undefined || v === null) delete process.env[n]; else process.env[n] = v; };
  set('PATH', [...today, '/usr/bin', '/bin'].join(':'));
  set('HOME', m.home);
  set('SHELL', shell);
  for (const [n, v] of Object.entries(env)) set(n, v);
  const prev = lookup().wireLookupDeps({ installFolders: () => Object.values(m.folders), ...(platform ? { platform: () => platform } : {}) });
  lookup().forget();
  try { return await fn(); } finally {
    lookup().wireLookupDeps(prev);
    lookup().forget();
    for (const n of names) set(n, before[n]);
  }
}

// A workspace for the pid file, and the answer-file guard hand-off recorded.
function wired(rt, extra = {}) {
  const ws = makeTempDir('login-lookup-ws-');
  const previousWs = config.getWorkspace();
  config.setWorkspace(ws);
  const prev = rt.wireClaudeRuntimeDeps({ onClaudeSpawn: () => {}, ...extra });
  return () => { rt.wireClaudeRuntimeDeps(prev); config.setWorkspace(previousWs); };
}

// What is logged, kept rather than printed.
function quietWarn() {
  const said = [];
  const real = console.warn;
  console.warn = (...args) => { said.push(args.join(' ')); };
  return { said, lookupLines: () => said.filter((l) => l.startsWith('[claude-lookup]')), restore: () => { console.warn = real; } };
}

// One spawn, settled on how it ended: the error the callback was handed, or
// the close of a process that started.
function spawnAndSettle(rt, args = CHAT_ARGS, options = { stdio: 'ignore' }) {
  return new Promise((resolve) => {
    let error = null;
    const proc = rt.spawnClaude(args, options, (err) => { error = err; });
    const timer = setTimeout(() => resolve({ proc, error, closed: false }), 15000);
    proc.on('close', () => { clearTimeout(timer); resolve({ proc, error, closed: true }); });
  });
}

// A runtime ready to spawn, with what it logs kept. `extra` is wired beside it.
function runtime(extra) {
  const rt = freshClaudeRuntime();
  const unwire = wired(rt, extra);
  const warn = quietWarn();
  return { rt, warn, done: () => { warn.restore(); unwire(); } };
}

// ── The #401 scenario ──

describe('an old copy in ~/.local/bin no longer beats the current copy the login shell finds (#401)', { skip: POSIX }, () => {
  test('every spawn starts the current copy, never the old one, and the app\'s check reports the current copy', async () => {
    const m = machine();
    const old = makeClaude(m.folders.local, OLD);
    const current = makeClaude(m.dir('npm-global-bin'), CURRENT);
    m.shell.plan({ loginPath: loginPath(current.dir) });
    const { rt, done } = runtime();
    try {
      // ensurePath puts ~/.local/bin first on the PATH the app has.
      await on(m, { today: [m.folders.local, current.dir] }, async () => {
        for (let i = 0; i < 2; i++) {
          const { error, closed } = await spawnAndSettle(rt);
          assert.strictEqual(error, null, `spawn ${i + 1} started`);
          assert.strictEqual(closed, true);
        }
        assert.strictEqual(rt.resolveClaudeBin(), current.bin);
        const found = lookup().installedClaude();
        assert.strictEqual(found && found.bin, current.bin, 'the app\'s check names the current copy');
        assert.strictEqual(found.version.trim(), CURRENT, 'with the version it found');
      });
      assert.strictEqual(current.chats().length, 2, 'both chats went to the current copy');
      assert.deepStrictEqual(old.runs(), [], 'the old copy was never run, not even for its version');
      assert.strictEqual(m.shell.runs().length, 1, 'the shell was asked once');
    } finally { done(); }
  });
});

// ── The order, and the floor skip ──

describe('the candidates are read in order, and a copy below the floor is passed over', { skip: POSIX }, () => {
  test('an old copy first and a current one second on the login PATH starts the current one', async () => {
    const m = machine();
    const old = makeClaude(m.dir('old'), OLD);
    const current = makeClaude(m.dir('current'), CURRENT);
    m.shell.plan({ loginPath: loginPath(old.dir, current.dir) });
    const { rt, done } = runtime();
    try {
      const { error } = await on(m, { today: [old.dir] }, () => spawnAndSettle(rt));
      assert.strictEqual(error, null);
      assert.strictEqual(current.chats().length, 1, 'the current copy was handed the chat');
      assert.strictEqual(old.probes().length, 1, 'the old one was asked its version');
      assert.deepStrictEqual(old.chats(), [], 'and never handed the chat');
    } finally { done(); }
  });

  test('with only old copies, the first is refused with the floor\'s own message, and nothing starts', async () => {
    const m = machine();
    const first = makeClaude(m.dir('first'), OLD);
    const second = makeClaude(m.folders.local, '2.0.50 (Claude Code)');
    const elsewhere = makeClaude(m.dir('elsewhere'), CURRENT);
    m.shell.plan({ loginPath: loginPath(first.dir) });
    const { rt, done } = runtime();
    try {
      const { error, proc } = await on(m, { today: [elsewhere.dir] }, () => spawnAndSettle(rt));
      assert.strictEqual(error && error.code, 'CLAUDE_TOO_OLD');
      assert.strictEqual(error.message, frozen('2.0.58', first.bin), 'it names the first copy');
      assert.strictEqual(proc.pid, undefined);
      assert.strictEqual(first.probes().length, 1, 'the first was asked once: the floor does not ask again');
      assert.strictEqual(second.probes().length, 1, 'the install folder copy was read too');
      assert.deepStrictEqual([...first.chats(), ...second.chats(), ...elsewhere.runs()], [], 'nothing was started');
    } finally { done(); }
  });

  test('a copy whose version cannot be read, first on the login PATH, is the one used', async () => {
    const m = machine();
    const unknown = makeClaude(m.dir('unknown'), 'CRASH');
    const current = makeClaude(m.dir('current'), CURRENT);
    m.shell.plan({ loginPath: loginPath(unknown.dir, current.dir) });
    const { rt, warn, done } = runtime();
    try {
      const { error } = await on(m, { today: [current.dir] }, () => spawnAndSettle(rt));
      assert.strictEqual(error, null);
      assert.strictEqual(unknown.chats().length, 1, 'the unknown copy starts, as the floor lets it');
      assert.deepStrictEqual(current.runs(), [], 'the lookup stopped at it');
      assert.strictEqual(warn.said.filter((l) => l.includes(unknown.bin)).length, 1, 'its unknown version logged once');
    } finally { done(); }
  });

  test('the install folders come after the login PATH, and a current copy in one passes an old copy in another', async () => {
    const m = machine();
    const old = makeClaude(m.folders.local, OLD);
    const current = makeClaude(m.folders.claude, CURRENT);
    const { rt, done } = runtime();
    try {
      const { error } = await on(m, { today: [old.dir, current.dir] }, () => spawnAndSettle(rt));
      assert.strictEqual(error, null);
      assert.strictEqual(current.chats().length, 1);
      assert.deepStrictEqual(old.chats(), []);
    } finally { done(); }
  });

  test('a relative PATH entry is ignored', async () => {
    const m = machine();
    const relative = makeClaude(path.join(m.root, 'relbin'), CURRENT);
    const current = makeClaude(m.dir('current'), CURRENT);
    m.shell.plan({ loginPath: ['relbin', '', '.', current.dir].join(':') });
    const { rt, done } = runtime();
    const cwd = process.cwd();
    try {
      process.chdir(m.root);
      await on(m, { today: ['relbin', current.dir] }, async () => {
        assert.strictEqual(rt.resolveClaudeBin(), current.bin);
        assert.strictEqual((await spawnAndSettle(rt)).error, null);
      });
      assert.deepStrictEqual(relative.runs(), [], 'the copy a relative entry names was never run');
    } finally { process.chdir(cwd); done(); }
  });

  test('a claude that is not an executable file is skipped', async () => {
    const m = machine();
    const plain = makeClaude(m.dir('plain'), CURRENT);
    fs.chmodSync(plain.bin, 0o644);
    const folder = m.dir('folder');
    fs.mkdirSync(path.join(folder, 'claude'), { recursive: true });
    const current = makeClaude(m.dir('current'), CURRENT);
    m.shell.plan({ loginPath: loginPath(plain.dir, folder, current.dir) });
    const { rt, done } = runtime();
    try {
      await on(m, { today: [] }, async () => {
        assert.strictEqual(rt.resolveClaudeBin(), current.bin);
        assert.strictEqual((await spawnAndSettle(rt)).error, null);
      });
      assert.strictEqual(current.chats().length, 1);
    } finally { done(); }
  });

  test('a copy reached twice, by a repeated folder or a link to it, is read once', async () => {
    const m = machine();
    const old = makeClaude(m.dir('old'), OLD);
    const linked = m.dir('linked');
    fs.symlinkSync(old.dir, linked);
    const current = makeClaude(m.dir('current'), CURRENT);
    m.shell.plan({ loginPath: loginPath(old.dir, old.dir, linked, current.dir) });
    const { rt, done } = runtime();
    try {
      const { error } = await on(m, { today: [old.dir] }, () => spawnAndSettle(rt));
      assert.strictEqual(error, null);
      assert.strictEqual(old.probes().length, 1, 'the old copy was asked its version once');
      assert.strictEqual(current.chats().length, 1);
    } finally { done(); }
  });
});

// ── How the shell is run ──

describe('the login shell is run as decided', { skip: POSIX }, () => {
  test('with arguments and no outer shell: the fixed command, stdin closed, its own home, and only the listed environment', async () => {
    const m = machine();
    // A shell whose own path a shell would read as more than a path.
    const marker = path.join(m.root, 'ran-in-a-shell');
    const odd = path.join(m.root, 'a "quoted" $(touch $LOOKUP_SHELL_MARKER) dir');
    fs.mkdirSync(odd);
    const shell = path.join(odd, 'zsh');
    fs.copyFileSync(m.shell.file, shell);
    fs.chmodSync(shell, 0o755);
    fs.copyFileSync(path.join(m.shell.dir, 'plan.json'), path.join(odd, 'plan.json'));
    const current = makeClaude(m.dir('current'), CURRENT);
    const plan = JSON.parse(fs.readFileSync(path.join(odd, 'plan.json'), 'utf8'));
    fs.writeFileSync(path.join(odd, 'plan.json'), JSON.stringify({ ...plan, loginPath: loginPath(current.dir) }));
    const { rt, warn, done } = runtime();
    try {
      await on(m, {
        today: [], shell,
        env: { LOOKUP_SHELL_MARKER: marker, RUNDOCK_CONVO_ID: 'not-for-the-shell', RUNDOCK: '1', RUNDOCK_PORT: '9', LC_ALL: 'C', LANG: 'en_US.UTF-8', TMPDIR: m.root, USER: 'someone', LOGNAME: 'someone' },
      }, () => {
        assert.strictEqual(rt.resolveClaudeBin(), current.bin);
        const runs = fs.readFileSync(path.join(odd, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        assert.strictEqual(runs.length, 1, 'the shell ran once');
        const [run] = runs;
        assert.deepStrictEqual(run.args, ['-l', '-i', '-c', FIXED_COMMAND], 'as an interactive login shell, given the fixed command as one argument');
        assert.strictEqual(lookup().LOGIN_SHELL_COMMAND, FIXED_COMMAND);
        assert.strictEqual(run.stdin, 'closed');
        assert.strictEqual(fs.realpathSync(run.cwd), fs.realpathSync(m.home), 'from the home folder');
        assert.deepStrictEqual(Object.keys(run.env).filter((n) => !n.startsWith('__CF')).sort(),
          ['HOME', 'LANG', 'LC_ALL', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'USER'], 'only the environment a shell needs, none of Rundock\'s');
        assert.strictEqual(run.env.PATH, process.env.PATH, 'with the PATH Rundock has');
        assert.strictEqual(run.env.HOME, m.home);
        assert.strictEqual(run.env.SHELL, shell);
        assert.strictEqual(fs.existsSync(marker), false, 'nothing in the shell\'s own path was run');
      });
      assert.deepStrictEqual(warn.lookupLines(), [], 'it answered, so nothing was logged');
      assert.strictEqual(lookup().LOGIN_SHELL_TIMEOUT_MS, 5000, 'bounded by five seconds');
    } finally { done(); }
  });

  test('what the startup files print around the markers is ignored', async () => {
    const m = machine();
    const decoy = makeClaude(m.dir('decoy'), CURRENT);
    const current = makeClaude(m.dir('current'), CURRENT);
    m.shell.plan({
      loginPath: loginPath(current.dir),
      before: `Last login: today\n${decoy.dir}:/usr/bin\n_RUNDOCK_LOGIN_PATH\nPATH=${decoy.dir}\n`,
      after: `${decoy.dir}\n_RUNDOCK_LOGIN_PATH_END_\nlogout\n`,
    });
    const { rt, warn, done } = runtime();
    try {
      await on(m, { today: [] }, () => assert.strictEqual(rt.resolveClaudeBin(), current.bin));
      assert.deepStrictEqual(decoy.runs(), [], 'nothing printed outside the markers was taken as a folder');
      assert.deepStrictEqual(warn.lookupLines(), []);
    } finally { done(); }
  });

  test('a fish shell is asked the same way, and its answer is read colon-separated', async () => {
    const m = machine({}, 'fish');
    const old = makeClaude(m.dir('old'), OLD);
    const current = makeClaude(m.dir('current'), CURRENT);
    m.shell.plan({ loginPath: loginPath(old.dir, current.dir), style: 'fish' });
    const { rt, warn, done } = runtime();
    try {
      await on(m, { today: [old.dir] }, () => assert.strictEqual(rt.resolveClaudeBin(), current.bin));
      assert.deepStrictEqual(m.shell.runs().map((r) => r.args), [['-l', '-i', '-c', FIXED_COMMAND]]);
      assert.deepStrictEqual(warn.lookupLines(), [], 'fish ran the command: nothing fell back');
    } finally { done(); }
  });

  test('a folder on the login PATH holding a quote, a space or $(...) is used as a path', async () => {
    const m = machine();
    const marker = path.join(m.root, 'ran-in-a-shell');
    const current = makeClaude(m.dir('it\'s a "folder" $(touch $LOOKUP_PATH_MARKER)'), CURRENT);
    m.shell.plan({ loginPath: loginPath(current.dir) });
    const { rt, done } = runtime();
    try {
      await on(m, { today: [], env: { LOOKUP_PATH_MARKER: marker } }, async () => {
        assert.strictEqual(rt.resolveClaudeBin(), current.bin);
        assert.strictEqual((await spawnAndSettle(rt)).error, null);
      });
      assert.strictEqual(current.probes().length, 1);
      assert.strictEqual(current.chats().length, 1);
      assert.strictEqual(fs.existsSync(marker), false, 'nothing in the folder name was run');
    } finally { done(); }
  });
});

// ── A lookup that fails falls back to today's ──

describe('a login shell that cannot answer leaves today\'s lookup in place, logged once', { skip: POSIX }, () => {
  // Today's lookup finds `today`; the login PATH, wherever it is printed at
  // all, would name another copy, so the answer says which lookup ran.
  function failing(plan, shell) {
    const m = machine(plan);
    const today = makeClaude(m.dir('today'), CURRENT);
    const login = makeClaude(m.dir('login'), CURRENT);
    m.shell.plan({ loginPath: loginPath(login.dir), ...plan });
    return { m, today, login, shell: shell ? shell(m) : m.shell.file };
  }
  const cases = [
    ['SHELL is not set', {}, () => null],
    ['SHELL is not an absolute path', {}, () => 'zsh'],
    ['SHELL is not an executable file', {}, (m) => { fs.chmodSync(m.shell.file, 0o644); return m.shell.file; }],
    ['the shell cannot be started', {}, (m) => { const f = path.join(m.root, 'broken-shell'); fs.writeFileSync(f, '#!/no/such/interpreter\n'); fs.chmodSync(f, 0o755); return f; }],
    ['the shell exits non-zero after a whole answer', { fail: 'nonzero' }],
    ['the shell prints no marked answer at all', { fail: 'silent', before: 'nothing to see\n' }],
  ];
  for (const [what, plan, shell] of cases) {
    test(`${what}: today's lookup, logged once`, async () => {
      const s = failing(plan, shell);
      const { rt, warn, done } = runtime();
      try {
        await on(s.m, { today: [s.today.dir], shell: s.shell }, () => {
          assert.strictEqual(rt.resolveClaudeBin(), s.today.bin);
          assert.strictEqual(rt.resolveClaudeBin(), s.today.bin, 'and kept');
        });
        assert.strictEqual(warn.lookupLines().length, 1, `logged once: ${JSON.stringify(warn.said)}`);
        assert.deepStrictEqual(s.login.runs(), [], 'the copy on the login PATH was never considered');
      } finally { done(); }
    });
  }
});

// ── The five sequences ──

describe('the sequences', { skip: POSIX }, () => {
  test('1, the inverse: with no old copy anywhere, the copy found is the one today\'s lookup finds, and the spawn is as before', async () => {
    const m = machine();
    const current = makeClaude(m.dir('current'), CURRENT);
    m.shell.plan({ loginPath: loginPath(current.dir) });
    const cp = require('node:child_process');
    const real = cp.spawn;
    const calls = [];
    cp.spawn = function recorded(file, args, options) { calls.push({ file, args, options }); return real.apply(this, arguments); };
    let rt;
    try { rt = freshClaudeRuntime(); } finally { cp.spawn = real; }
    const unwire = wired(rt);
    const warn = quietWarn();
    try {
      const given = { cwd: m.root, stdio: ['pipe', 'pipe', 'ignore'] };
      await on(m, { today: [current.dir] }, async () => {
        const today = execSync('which claude', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        assert.strictEqual(rt.resolveClaudeBin(), today, 'the copy today\'s lookup finds');
        assert.strictEqual((await spawnAndSettle(rt, CHAT_ARGS, given)).error, null);
      });
      assert.deepStrictEqual(calls.map((c) => [c.file, c.args, c.options]), [[current.bin, CHAT_ARGS, { ...given, detached: true }]],
        'one spawn, with the arguments and options the caller gave');
      assert.strictEqual(m.shell.runs().length, 1, 'the shell was asked');
      assert.deepStrictEqual(warn.lookupLines(), []);
    } finally { warn.restore(); unwire(); }
  });

  test('2, the undo: with the current copy removed the old one is refused by name, and put back it starts, with no restart', async () => {
    const m = machine();
    const old = makeClaude(m.folders.local, OLD);
    let current = makeClaude(m.dir('current'), CURRENT);
    m.shell.plan({ loginPath: loginPath(current.dir) });
    const { rt, done } = runtime();
    try {
      await on(m, { today: [old.dir, current.dir] }, async () => {
        assert.strictEqual((await spawnAndSettle(rt)).error, null, 'the current copy starts');
        fs.rmSync(current.bin);
        const refused = await spawnAndSettle(rt);
        assert.strictEqual(refused.error && refused.error.message, frozen('2.0.58', old.bin), 'the old copy, named');
        current = makeClaude(current.dir, CURRENT);
        assert.strictEqual((await spawnAndSettle(rt)).error, null, 'put back, it starts');
      });
      assert.strictEqual(current.chats().length, 2);
      assert.deepStrictEqual(old.chats(), []);
      assert.strictEqual(m.shell.runs().length, 3, 'the shell was asked at the start, after the copy went, and after the refusal');
    } finally { done(); }
  });

  test('3, the retry: while every copy is old each message is refused again and starts nothing, and the shell runs once per refused lookup, never per spawn', async () => {
    const m = machine();
    const first = makeClaude(m.dir('first'), OLD);
    const second = makeClaude(m.dir('second'), OLD);
    m.shell.plan({ loginPath: loginPath(first.dir, second.dir) });
    const { rt, done } = runtime();
    try {
      await on(m, { today: [] }, async () => {
        for (let i = 0; i < 2; i++) {
          const { error } = await spawnAndSettle(rt);
          assert.strictEqual(error && error.message, frozen('2.0.58', first.bin), `message ${i + 1} refused again`);
        }
        assert.strictEqual(m.shell.runs().length, 2, 'asked again for each refused lookup');
        first.say(CURRENT);
        for (let i = 0; i < 3; i++) assert.strictEqual((await spawnAndSettle(rt)).error, null);
      });
      assert.deepStrictEqual(second.chats(), []);
      assert.strictEqual(first.chats().length, 3);
      assert.strictEqual(m.shell.runs().length, 3, 'once more for the copy that passed, and never per spawn');
    } finally { done(); }
  });

  test('4, the next step: `claude update` on the copy the shell finds, and the same message starts it', async () => {
    const m = machine();
    const other = makeClaude(m.folders.local, '2.0.50 (Claude Code)');
    const shells = makeClaude(m.dir('shells'), OLD);
    m.shell.plan({ loginPath: loginPath(shells.dir) });
    const { rt, done } = runtime();
    const resumed = [...CHAT_ARGS, '--resume', '7d1f0a52-4c1e-4b8e-9a51-1d2f3e4a5b6c'];
    try {
      await on(m, { today: [other.dir, shells.dir] }, async () => {
        const refused = await spawnAndSettle(rt, resumed);
        assert.strictEqual(refused.error && refused.error.message, frozen('2.0.58', shells.bin), 'the copy the shell finds is the one named');
        shells.say(CURRENT);
        assert.strictEqual((await spawnAndSettle(rt, resumed)).error, null);
      });
      assert.deepStrictEqual(shells.chats().map((r) => r.args), [resumed], 'the same message, and the conversation carries on');
      assert.deepStrictEqual(other.chats(), []);
    } finally { done(); }
  });

  for (const [what, plan] of [
    ['crashes', { fail: 'crash', before: 'loading plugins\n' }],
    ['stalls past its timeout', { fail: 'stall' }],
    ['prints the first marker and is cut off', { fail: 'cut' }],
  ]) {
    test(`5, the control failing: a shell that ${what} falls back within the timeout, logged once, and chat still starts`, async () => {
      const m = machine();
      const today = makeClaude(m.dir('today'), CURRENT);
      const login = makeClaude(m.dir('login'), CURRENT);
      m.shell.plan({ loginPath: loginPath(login.dir), ...plan });
      const { rt, warn, done } = runtime();
      try {
        const started = Date.now();
        const { error } = await on(m, { today: [today.dir] }, () => spawnAndSettle(rt));
        assert.strictEqual(error, null, 'chat starts');
        assert.ok(Date.now() - started < 5000 + 4000, `within the timeout (${Date.now() - started}ms)`);
        assert.strictEqual(today.chats().length, 1, 'on the copy today\'s lookup finds');
        assert.deepStrictEqual(login.runs(), []);
        assert.strictEqual(warn.lookupLines().length, 1, 'logged once');
      } finally { done(); }
    });
  }
});
