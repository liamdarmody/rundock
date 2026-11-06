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
// folders `which` lives in. `deps` stands in more of the lookup's own, such as
// its clock. Restored afterwards.
async function on(m, { today = [], shell = m.shell.file, env = {}, platform, deps = {} } = {}, fn) {
  const names = ['PATH', 'HOME', 'SHELL', ...Object.keys(env)];
  const before = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  const set = (n, v) => { if (v === undefined || v === null) delete process.env[n]; else process.env[n] = v; };
  set('PATH', [...today, '/usr/bin', '/bin'].join(':'));
  set('HOME', m.home);
  set('SHELL', shell);
  for (const [n, v] of Object.entries(env)) set(n, v);
  const prev = lookup().wireLookupDeps({ installFolders: () => Object.values(m.folders), ...(platform ? { platform: () => platform } : {}), ...deps });
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

  test('a shell that answers with a PATH holding no claude ends in no copy, though one is on the PATH Rundock has', async () => {
    // Today's lookup stands in only when the shell cannot answer. An answer
    // that names no copy is an answer.
    const m = machine();
    const elsewhere = makeClaude(m.dir('only-on-the-app-path'), CURRENT);
    const warn = quietWarn();
    try {
      await on(m, { today: [elsewhere.dir] }, () => {
        assert.strictEqual(lookup().lookupClaude().bin, null);
      });
      assert.strictEqual(m.shell.runs().length, 1, 'the shell answered');
      assert.deepStrictEqual(warn.lookupLines(), [], 'so nothing failed, and nothing is logged');
      assert.deepStrictEqual(elsewhere.runs(), []);
    } finally { warn.restore(); }
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
        assert.strictEqual(run.env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin', 'with the system default PATH, as nothing recorded the one Rundock started with');
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

  // What the lookup may take beyond the shell's own five seconds, for the
  // stall to be noticed and the killed shell reaped: scheduling, not work.
  const ALLOWANCE_MS = 300;
  test(`a stalled shell and today's lookup share one five-second budget: the lookup resolves within it and ${ALLOWANCE_MS}ms, finds the copy, and logs once`, async (t) => {
    const s = failing({ fail: 'stall' });
    // A `which` that never answers, first on the PATH Rundock has: today's
    // lookup must not need a process, or the stall would cost its time too.
    const tools = s.m.dir('slow-tools');
    const ran = path.join(tools, 'ran');
    fs.mkdirSync(tools);
    fs.writeFileSync(path.join(tools, 'which'), `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(ran)}, 'which\\n');\nsetTimeout(() => {}, 8000);\n`);
    fs.chmodSync(path.join(tools, 'which'), 0o755);
    const warn = quietWarn();
    try {
      await on(s.m, { today: [tools, s.today.dir] }, () => {
        const started = process.hrtime.bigint();
        const found = lookup().lookupClaude();
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        t.diagnostic(`the lookup took ${ms.toFixed(1)}ms`);
        assert.ok(ms <= lookup().LOGIN_SHELL_TIMEOUT_MS + ALLOWANCE_MS, `the lookup took ${Math.round(ms)}ms`);
        assert.strictEqual(found.bin, s.today.bin, 'today\'s lookup found the copy');
      });
      assert.strictEqual(warn.lookupLines().length, 1, `logged once: ${JSON.stringify(warn.said)}`);
      assert.strictEqual(fs.existsSync(ran), false, 'and no `which` was run');
    } finally { warn.restore(); }
  });

  test(`when no folder on the PATH holds a copy, \`which\` is asked only with what is left of the budget: after a stalled shell, nothing, and the lookup still ends within it and ${ALLOWANCE_MS}ms`, async (t) => {
    const s = failing({ fail: 'stall' });
    const tools = s.m.dir('slow-tools');
    const ran = path.join(tools, 'ran');
    fs.mkdirSync(tools);
    fs.writeFileSync(path.join(tools, 'which'), `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(ran)}, 'which\\n');\nsetTimeout(() => {}, 8000);\n`);
    fs.chmodSync(path.join(tools, 'which'), 0o755);
    const warn = quietWarn();
    try {
      await on(s.m, { today: [tools] }, () => {
        const started = process.hrtime.bigint();
        const found = lookup().lookupClaude();
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        t.diagnostic(`the lookup took ${ms.toFixed(1)}ms`);
        assert.ok(ms <= lookup().LOGIN_SHELL_TIMEOUT_MS + ALLOWANCE_MS, `the lookup took ${Math.round(ms)}ms`);
        assert.strictEqual(found.bin, null, 'no copy');
      });
      assert.strictEqual(warn.lookupLines().length, 1, `logged once: ${JSON.stringify(warn.said)}`);
    } finally { warn.restore(); }
  });
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

// ── One lookup, and no version read through a shell ──

// Every source file the app runs: the server, lib and the desktop app.
function appSources() {
  const out = ['server.js'];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const next = path.join(rel, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(next); } else if (/\.(c|m)?js$/.test(entry.name)) out.push(next);
    }
  };
  walk('lib');
  walk('electron');
  return out.map((rel) => rel.split(path.sep).join('/'));
}
// A lookup of `claude` written as a command line.
const LOOKUP_COMMAND = /\b(?:which|where\.exe)\s+claude\b/g;
// A shell call whose command line, as written, asks for `--version`, and a
// command line built from a path with `--version` after it.
const SHELL_CALL = /\bexec(?:Sync)?\(\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
const BUILT_VERSION_LINE = /\$\{[^}]*\}["']?\s+--version\b/g;
function versionThroughAShell(text) {
  const hits = [];
  for (const m of text.matchAll(SHELL_CALL)) if (m[1].includes('--version')) hits.push(m[0]);
  for (const m of text.matchAll(BUILT_VERSION_LINE)) hits.push(m[0]);
  return hits;
}
// What the scan finds in one file: `claude` named to a lookup, and a
// `--version` command line handed to a shell. The lookup module is read like
// every other file, except that its own two lookups, today's on macOS and
// Linux and the Windows one, may name `claude`, each once, in the function
// that is for it.
const OWN_LOOKUPS = { file: 'lib/runtime/claude-lookup.js', fns: ['todaysLookup', 'whereClaude'] };
function scanned(file, text) {
  let rest = text;
  if (file === OWN_LOOKUPS.file) {
    for (const fn of OWN_LOOKUPS.fns) {
      const own = body(text, fn);
      assert.strictEqual([...own.matchAll(LOOKUP_COMMAND)].length, 1, `${fn} is a lookup`);
      rest = rest.replace(own, '');
    }
  }
  return [
    ...[...rest.matchAll(LOOKUP_COMMAND)].map((m) => `${file}: ${m[0]}`),
    ...versionThroughAShell(text).map((hit) => `${file}: ${hit}`),
  ];
}
// The body of a top-level function, from its declaration to its closing brace.
function body(text, name) {
  const at = text.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} is declared`);
  const end = text.indexOf('\n}\n', at);
  assert.ok(end > at, `${name} ends`);
  return text.slice(at, end + 2);
}

describe('one module finds claude, and nothing reads its version through a shell', () => {
  test('the scans see what they look for: the old lookups and probes are found, and a version read with arguments is not', () => {
    // As they were written before the one lookup.
    const before = [
      "    const lookupCmd = isWindows ? 'where.exe claude' : 'which claude';",
      "      execSync(isWindows ? 'where.exe claude' : 'which claude', { timeout: 5000, encoding: 'utf-8', stdio: codexRuntime.PROBE_STDIO });",
    ];
    for (const line of before) assert.strictEqual([...line.matchAll(LOOKUP_COMMAND)].length, 2, line);
    assert.strictEqual(versionThroughAShell('    claudeFoundVersion = String(execSync(`"${bin}" --version`, { timeout: 10000 }));').length, 2);
    assert.strictEqual(versionThroughAShell('        const out = execSync(`"${resolveClaudeBin()}" --version`, { timeout: 5000 });').length, 2);
    assert.strictEqual(versionThroughAShell("execSync('claude --version')").length, 1);
    assert.strictEqual(versionThroughAShell('const cmd = `${bin} --version`;').length, 1);
    // Reading a version with arguments, and telling a person what to run, are not shell strings.
    assert.deepStrictEqual(versionThroughAShell("execFileSync(bin, ['--version'], { timeout })"), []);
    assert.deepStrictEqual(versionThroughAShell('userMessage = `Couldn\'t start Claude Code: ${err.message}. Run \\`claude --version\\` to check your install.`;'), []);
  });

  test('no file but the lookup runs `which claude` or `where.exe claude`, or builds a `--version` command line', () => {
    const files = appSources();
    assert.ok(files.length >= 40, `the walk read only ${files.length} files: it has gone blind`);
    for (const must of ['server.js', 'electron/main.js', 'lib/runtime/claude.js', 'lib/runtime/claude-lookup.js']) assert.ok(files.includes(must), `${must} is scanned`);
    const found = files.flatMap((file) => scanned(file, src(file)));
    assert.deepStrictEqual(found, [], 'claude is looked for only by lib/runtime/claude-lookup.js, and its version read only with arguments');
  });

  test('the scan reads the lookup module too: a probe through a shell planted there is found, and so is a lookup outside its own two', () => {
    const file = 'lib/runtime/claude-lookup.js';
    const text = src(file);
    const plant = (from, to) => { assert.ok(text.includes(from), `the specimen's anchor is there: ${from}`); return text.replace(from, to); };
    const probe = plant('readClaudeVersion(bin, VERSION_PROBE_TIMEOUT_MS, platform);\n  if (said', 'String(execSync(`"${bin}" --version`, { timeout: VERSION_PROBE_TIMEOUT_MS }));\n  if (said');
    assert.ok(scanned(file, probe).length > 0, 'a --version command line in the lookup module is found');
    const stray = plant('function installedClaude(', "const stray = () => execSync('which claude');\nfunction installedClaude(");
    assert.ok(scanned(file, stray).length > 0, 'a lookup outside todaysLookup and whereClaude is found');
  });

  test('every spawn, the Settings probe and the desktop app\'s check get their copy from the lookup', () => {
    assert.match(body(src('lib/runtime/claude.js'), 'resolveClaudeBin'), /return lookupClaude\(\{ versionPlatform: deps\.platform\(\) \}\)\.bin \|\| 'claude';/);
    const probe = body(src('server.js'), 'getRuntimeStatus');
    assert.ok(probe.includes('claudeLookup.lookupClaude({ retryMissing: true })'), 'the Settings probe asks the lookup');
    assert.ok(probe.includes('claudeLookup.readClaudeVersion(bin)'), 'and reads the version with no shell');
    const main = src('electron/main.js');
    const find = body(main, 'findClaude');
    assert.ok(find.includes("require('../lib/runtime/claude-lookup.js').installedClaude()"), 'findClaude asks the lookup');
    assert.doesNotMatch(find, /\bexec(?:Sync|FileSync)?\(|\bspawn(?:Sync)?\(/, 'and runs nothing of its own');
    assert.ok(body(main, 'ensurePath').includes("require('../lib/runtime/claude-lookup.js').addInstallFolders()"), 'the folders the app adds are the lookup\'s, and it keeps the PATH from before them');
  });
});

// ── The desktop app's check reads a version with no shell ──

// findClaude and ensurePath as the desktop app has them, run here with the
// lookup this file wires, so the desktop app's own code is what is checked.
function desktopCheck() {
  const main = src('electron/main.js');
  const find = body(main, 'findClaude');
  // Nothing is run before this holds: a check that runs a command line of its
  // own would run it on the machine running the suite.
  assert.doesNotMatch(find, /\bexec(?:Sync)?\(/, 'findClaude builds no command line');
  const code = `${body(main, 'ensurePath')}\nlet claudeFoundVersion = null;\n${find}\nreturn { findClaude, version: () => claudeFoundVersion };`;
  const desktopRequire = (id) => require(id.startsWith('.') ? path.join(ROOT, 'electron', id) : id);
  return new Function('require', 'path', 'process', code)(desktopRequire, path, process);
}

describe('the desktop app\'s check reports the copy the lookup chose, with the version it read', { skip: POSIX }, () => {
  test('a copy found in a folder holding $(...) is reported with its version, and nothing in the folder name runs', async () => {
    const m = machine();
    const marker = path.join(m.root, 'ran-in-a-shell');
    const old = makeClaude(m.folders.local, OLD);
    const current = makeClaude(m.dir('q$(touch $DESKTOP_CHECK_MARKER)'), CURRENT);
    m.shell.plan({ loginPath: loginPath(current.dir) });
    const warn = quietWarn();
    try {
      await on(m, { today: [old.dir, current.dir], env: { DESKTOP_CHECK_MARKER: marker } }, () => {
        const desktop = desktopCheck();
        assert.strictEqual(desktop.findClaude(), current.bin, 'the current copy, not the old one ensurePath puts first');
        assert.strictEqual(String(desktop.version()).trim(), CURRENT, 'with the version it said');
        assert.ok(process.env.PATH.split(':').includes(m.folders.homebrew), 'ensurePath still adds the install folders');
      });
      assert.strictEqual(fs.existsSync(marker), false, 'nothing in the folder name was run');
      assert.deepStrictEqual(current.probes().map((r) => r.args), [['--version']], 'asked once, with arguments');
      assert.deepStrictEqual(old.runs(), [], 'the old copy was never run');
    } finally { warn.restore(); }
  });

  test('the shell is given the PATH Rundock started with, not the one ensurePath put the install folders in front of', async () => {
    // Startup files that never touch PATH: the shell answers with the PATH it
    // was given. Given the desktop app's PATH, ~/.local/bin came first (#401).
    const m = machine({ loginPath: 'given' });
    const old = makeClaude(m.folders.local, OLD);
    const current = makeClaude(m.dir('npm-global-bin'), CURRENT);
    const warn = quietWarn();
    try {
      await on(m, { today: [current.dir] }, () => {
        const started = process.env.PATH;
        const desktop = desktopCheck();
        assert.strictEqual(desktop.findClaude(), current.bin);
        assert.strictEqual(process.env.PATH.split(':')[0], m.folders.local, 'ensurePath put ~/.local/bin first on the PATH the app has');
        const runs = m.shell.runs();
        assert.strictEqual(runs.length, 1);
        assert.strictEqual(runs[0].env.PATH, started, 'the shell was given the PATH from before ensurePath');
      });
      assert.deepStrictEqual(old.runs(), [], 'so ~/.local/bin did not come first, and the old copy there was never read');
      assert.deepStrictEqual(warn.lookupLines(), []);
    } finally { warn.restore(); }
  });

  test('with no PATH recorded from before ensurePath, the shell is given the system default', async () => {
    const m = machine({ loginPath: 'given' });
    const old = makeClaude(m.folders.local, OLD);
    const { rt, done } = runtime();
    try {
      await on(m, { today: [m.folders.local] }, () => {
        assert.strictEqual(rt.resolveClaudeBin(), old.bin, 'found after the login PATH, among the install folders');
        assert.strictEqual(m.shell.runs()[0].env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
      });
    } finally { done(); }
  });

  test('a PATH recorded empty is given to the shell as it was, and the system default only when none was recorded', async () => {
    const m = machine({ loginPath: 'given' });
    const warn = quietWarn();
    try {
      await on(m, {}, () => {
        lookup().addInstallFolders({ PATH: '' });
        lookup().lookupClaude();
      });
      assert.strictEqual(m.shell.runs()[0].env.PATH, '', 'the empty PATH Rundock was started with');
    } finally { warn.restore(); }
  });

  test('while nothing is found, looks within a minute ask the shell once, and a copy installed on the PATH it gave is found on the next look without asking again', async () => {
    // The setup wizard polls while the person installs. The clock is the
    // lookup's own, stood in: nothing here waits.
    const m = machine();
    const npm = m.dir('npm-global-bin');
    fs.mkdirSync(npm);
    m.shell.plan({ loginPath: loginPath(npm) });
    const start = 1000000;
    let now = start;
    await on(m, { deps: { now: () => now } }, () => {
      for (const s of [0, 15, 30, 45, 59]) {
        now = start + s * 1000;
        assert.strictEqual(lookup().installedClaude(), null, `nothing found at ${s}s`);
      }
      assert.strictEqual(m.shell.runs().length, 1, 'five looks within a minute asked the shell once');
      const current = makeClaude(npm, CURRENT);
      const found = lookup().installedClaude();
      assert.strictEqual(found && found.bin, current.bin, 'found on the next look, along the PATH the shell gave');
      assert.strictEqual(m.shell.runs().length, 1, 'with no new shell run');
    });
  });

  test('a minute after its answer, a look that still finds nothing asks the shell again, and a shell that cannot answer is asked and logged once a minute too', async () => {
    const m = machine();
    const npm = m.dir('npm-global-bin');
    fs.mkdirSync(npm);
    m.shell.plan({ loginPath: loginPath(npm) });
    const start = 1000000;
    let now = start;
    const warn = quietWarn();
    try {
      await on(m, { deps: { now: () => now } }, () => {
        assert.strictEqual(lookup().installedClaude(), null);
        now = start + 60 * 1000;
        assert.strictEqual(lookup().installedClaude(), null);
        assert.strictEqual(m.shell.runs().length, 2, 'asked again after a minute');
        m.shell.plan({ fail: 'crash' });
        now = start + 120 * 1000;
        for (let i = 0; i < 3; i++) { assert.strictEqual(lookup().installedClaude(), null); now += 10 * 1000; }
        assert.strictEqual(m.shell.runs().length, 3, 'the shell that could not answer was asked once');
        assert.strictEqual(warn.lookupLines().length, 1, 'and logged once');
      });
    } finally { warn.restore(); }
  });

  test('no copy, or one that cannot be run for its version, is not installed; a copy installed afterwards is found', async () => {
    const m = machine();
    m.shell.plan({ loginPath: loginPath(m.dir('later')) });
    const warn = quietWarn();
    try {
      await on(m, { today: [] }, () => {
        const desktop = desktopCheck();
        assert.strictEqual(desktop.findClaude(), null, 'nothing installed');
        const broken = makeClaude(m.dir('later'), 'CRASH');
        assert.strictEqual(desktop.findClaude(), null, 'a copy that cannot say its version is not taken as installed');
        broken.say(CURRENT);
        assert.strictEqual(desktop.findClaude(), broken.bin, 'once it answers, it is found, with no restart');
      });
    } finally { warn.restore(); }
  });
});

// ── Windows keeps where.exe, and the floor is applied across its answer ──

// ── The desktop app's sign-in check runs the copy chats start ──

// isClaudeAuthenticated as the desktop app has it, run here with the lookup
// this file wires.
function signInCheck() {
  const check = body(src('electron/main.js'), 'isClaudeAuthenticated');
  // Nothing is run before this holds: a check that hands a command line to a
  // shell would run it on the machine running the suite.
  assert.doesNotMatch(check, /\bexecSync\(|\bexec\(|shell:\s*true/, 'the sign-in check hands nothing to a shell');
  const desktopRequire = (id) => require(id.startsWith('.') ? path.join(ROOT, 'electron', id) : id);
  return new Function('require', 'process', `${check}\nreturn isClaudeAuthenticated;`)(desktopRequire, process);
}

describe('the desktop app\'s sign-in check runs the copy the lookup chose, with no shell', { skip: POSIX }, () => {
  test('it runs the copy chats start, with its arguments, and nothing in a folder name holding $(...) runs', async () => {
    const m = machine();
    const marker = path.join(m.root, 'ran-in-a-shell');
    const old = makeClaude(m.folders.local, OLD);
    const current = makeClaude(m.dir('q$(touch $SIGN_IN_MARKER)'), CURRENT);
    m.shell.plan({ loginPath: loginPath(current.dir) });
    const { rt, done } = runtime();
    try {
      await on(m, { today: [old.dir, current.dir], env: { SIGN_IN_MARKER: marker } }, () => {
        assert.strictEqual(desktopCheck().findClaude(), current.bin);
        assert.strictEqual(signInCheck()(), true, 'the copy said it is signed in');
        assert.strictEqual(rt.resolveClaudeBin(), current.bin, 'and it is the copy chats start');
      });
      assert.deepStrictEqual(current.chats().map((r) => r.args), [['--print', 'test', '--output-format', 'text']]);
      assert.deepStrictEqual(old.runs(), [], 'the old copy ensurePath put first never ran');
      assert.strictEqual(fs.existsSync(marker), false, 'nothing in the folder name ran');
    } finally { done(); }
  });

  test('with no copy found it says not signed in and runs nothing', async () => {
    const m = machine();
    await on(m, { today: [] }, () => {
      assert.strictEqual(desktopCheck().findClaude(), null);
      assert.strictEqual(signInCheck()(), false);
    });
  });
});

// Windows has no login shell to ask. Its copies are stood in by scripts named
// as Windows names them, an npm claude.cmd beside the package it starts, and
// `where.exe` by a script on the PATH printing them in its own order: the
// copies of claude when asked for claude, and `nodes` when asked for node.exe.
function windows(m, listed, nodes = []) {
  const where = m.dir('where-exe');
  fs.mkdirSync(where, { recursive: true });
  fs.writeFileSync(path.join(where, 'answer'), listed.map((c) => `${c.bin}\r\n`).join(''));
  fs.writeFileSync(path.join(where, 'answer-node'), nodes.map((n) => `${n}\r\n`).join(''));
  fs.writeFileSync(path.join(where, 'where.exe'), '#!/bin/sh\nif [ "$1" = node.exe ]; then exec cat "$(dirname "$0")/answer-node"; fi\ncat "$(dirname "$0")/answer"\n');
  fs.chmodSync(path.join(where, 'where.exe'), 0o755);
  return where;
}
// A node.exe that records the arguments it is started with, and answers as a
// signed-in Claude Code would (or not, once the folder holds `signed-out`).
function makeNode(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'node.exe');
  const log = path.join(dir, 'node-runs.jsonl');
  fs.writeFileSync(file, `#!${process.execPath}
const fs = require('fs');
const path = require('path');
fs.appendFileSync(path.join(__dirname, 'node-runs.jsonl'), JSON.stringify({ args: process.argv.slice(2) }) + '\\n');
setTimeout(() => process.exit(fs.existsSync(path.join(__dirname, 'signed-out')) ? 1 : 0), 50);
`);
  fs.chmodSync(file, 0o755);
  return { file, runs: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) };
}
// An npm install as npm lays it out on Windows (`%APPDATA%\\npm`): the
// claude.cmd launcher, a stub that records any run of it, and beside it the
// package it starts, whose package.json names its entry in `bin`. `node`
// puts a node.exe beside the launcher, as npm's own launcher prefers.
function npmLauncher(dir, version, { bin = { claude: 'cli.js' }, node = true } = {}) {
  const copy = makeClaude(dir, 'CRASH', 'claude.cmd');
  const pkg = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version, ...(bin === undefined ? {} : { bin }) }));
  fs.writeFileSync(path.join(pkg, 'cli.js'), '// the entry\n');
  copy.pkg = pkg;
  copy.entry = fs.realpathSync(path.join(pkg, 'cli.js'));
  copy.node = node ? makeNode(dir) : null;
  return copy;
}
const SIGN_IN_ARGS = ['--print', 'test', '--output-format', 'text'];

describe('Windows keeps where.exe and its order, and passes over a copy below the floor', { skip: POSIX }, () => {
  async function onWindows(m, listed, fn, { nodes = [], logged = [] } = {}) {
    const { rt, warn, done } = runtime({ platform: () => 'win32' });
    try {
      return await on(m, { today: [windows(m, listed, nodes)], platform: 'win32' }, () => fn(rt));
    } finally {
      done();
      assert.deepStrictEqual(m.shell.runs(), [], 'no login shell is asked on Windows');
      assert.strictEqual(warn.lookupLines().length, logged.length, `logged: ${JSON.stringify(warn.lookupLines())}`);
      logged.forEach((what, i) => assert.ok(warn.lookupLines()[i].includes(what), `the log names ${what}`));
    }
  }

  test('an npm install starts its package\'s entry with the node.exe beside its launcher: a chat and the sign-in check, each with its arguments and no shell', async () => {
    const m = machine();
    const npm = npmLauncher(m.dir('npm'), '2.1.318');
    await onWindows(m, [npm], async (rt) => {
      assert.strictEqual((await spawnAndSettle(rt)).error, null, 'the chat started');
      assert.strictEqual(signInCheck()(), true, 'the sign-in check says signed in');
    });
    assert.deepStrictEqual(npm.node.runs().map((r) => r.args), [[npm.entry, ...CHAT_ARGS], [npm.entry, ...SIGN_IN_ARGS]]);
    assert.deepStrictEqual(npm.runs(), [], 'the launcher itself never ran');
  });

  test('with no node.exe beside the launcher, the first node.exe where.exe lists starts the entry, by its full path', async () => {
    const m = machine();
    const npm = npmLauncher(m.dir('npm'), '2.1.318', { node: false });
    const node = makeNode(m.dir('nodejs'));
    const other = makeNode(m.dir('other-nodejs'));
    await onWindows(m, [npm], async (rt) => {
      assert.strictEqual((await spawnAndSettle(rt)).error, null);
    }, { nodes: [node.file, other.file] });
    assert.deepStrictEqual(node.runs().map((r) => r.args), [[npm.entry, ...CHAT_ARGS]]);
    assert.deepStrictEqual(other.runs(), []);
    assert.deepStrictEqual(npm.runs(), []);
  });

  test('an entry that is an .exe is started itself, and a copy where.exe lists as claude.exe still starts as before', async () => {
    const m = machine();
    const npm = npmLauncher(m.dir('npm'), '2.1.318', { bin: { claude: 'bin/claude.exe' } });
    const entry = makeClaude(path.join(npm.pkg, 'bin'), CURRENT, 'claude.exe');
    await onWindows(m, [npm], async (rt) => {
      assert.strictEqual((await spawnAndSettle(rt)).error, null);
    });
    assert.deepStrictEqual(entry.chats().map((r) => r.args), [CHAT_ARGS], 'the package\'s claude.exe started, with the arguments');
    assert.deepStrictEqual(npm.runs(), []);
    assert.deepStrictEqual(npm.node.runs(), [], 'no node.exe needed');
    const m2 = machine();
    const exe = makeClaude(m2.dir('exe'), CURRENT, 'claude.exe');
    await onWindows(m2, [exe], async (rt) => {
      assert.strictEqual((await spawnAndSettle(rt)).error, null);
    });
    assert.deepStrictEqual(exe.chats().map((r) => r.args), [CHAT_ARGS]);
  });

  for (const [how, layOut] of [
    ['by ..', (npm, m) => { fs.writeFileSync(m.dir('outside.js'), '// not the package\n'); return { claude: path.relative(npm.pkg, m.dir('outside.js')) }; }],
    ['by a link', (npm, m) => { fs.writeFileSync(m.dir('outside.js'), '// not the package\n'); fs.symlinkSync(m.dir('outside.js'), path.join(npm.pkg, 'linked.js')); return { claude: 'linked.js' }; }],
  ]) {
    test(`an entry outside the package folder, ${how}, is refused: the launcher starts as before, logged once`, async () => {
      const m = machine();
      const npm = npmLauncher(m.dir('npm'), '2.1.318');
      const bin = layOut(npm, m);
      const pkgJson = path.join(npm.pkg, 'package.json');
      fs.writeFileSync(pkgJson, JSON.stringify({ ...JSON.parse(fs.readFileSync(pkgJson, 'utf8')), bin }));
      await onWindows(m, [npm], async (rt) => {
        for (let i = 0; i < 2; i++) assert.strictEqual((await spawnAndSettle(rt)).error, null);
      }, { logged: [npm.pkg] });
      assert.strictEqual(npm.chats().length, 2, 'the launcher was started, as before');
      assert.deepStrictEqual(npm.node.runs(), [], 'and nothing outside the package was');
    });
  }

  test('with no package beside the launcher, the launcher starts as before, logged once', async () => {
    const m = machine();
    const npm = npmLauncher(m.dir('npm'), '2.1.318');
    fs.rmSync(path.join(m.dir('npm'), 'node_modules'), { recursive: true });
    await onWindows(m, [npm], async (rt) => {
      for (let i = 0; i < 2; i++) assert.strictEqual((await spawnAndSettle(rt)).error, null);
    }, { logged: [npm.pkg] });
    assert.strictEqual(npm.chats().length, 2);
    assert.deepStrictEqual(npm.node.runs(), []);
  });

  test('where.exe lists a plain copy, a .cmd and an .exe: the .exe is chosen, as before', async () => {
    const m = machine();
    const plain = makeClaude(m.dir('plain'), CURRENT);
    const cmd = npmLauncher(m.dir('npm'), '2.1.318');
    const exe = makeClaude(m.dir('exe'), CURRENT, 'claude.exe');
    await onWindows(m, [plain, cmd, exe], (rt) => assert.strictEqual(rt.resolveClaudeBin(), exe.bin));
  });

  test('where.exe lists a plain copy and a .cmd: the .cmd is chosen, as before', async () => {
    const m = machine();
    const plain = makeClaude(m.dir('plain'), CURRENT);
    const cmd = npmLauncher(m.dir('npm'), '2.1.318');
    await onWindows(m, [plain, cmd], (rt) => assert.strictEqual(rt.resolveClaudeBin(), cmd.bin));
    assert.deepStrictEqual(plain.runs(), [], 'the plain copy was not needed');
  });

  test('an old .exe and a current npm .cmd: the npm install starts, read from its package and never run for its version', async () => {
    const m = machine();
    const exe = makeClaude(m.dir('exe'), OLD, 'claude.exe');
    const cmd = npmLauncher(m.dir('npm'), '2.1.318');
    await onWindows(m, [exe, cmd], async (rt) => {
      assert.strictEqual(rt.resolveClaudeBin(), cmd.bin);
      assert.strictEqual((await spawnAndSettle(rt)).error, null);
    });
    assert.deepStrictEqual(cmd.runs(), [], 'the .cmd was never run, for its version or the chat');
    assert.deepStrictEqual(cmd.node.runs().map((r) => r.args), [[cmd.entry, ...CHAT_ARGS]], 'its package was started');
    assert.strictEqual(exe.probes().length, 1, 'the old .exe was read once');
    assert.deepStrictEqual(exe.chats(), [], 'and never started');
  });

  test('with the platform itself Windows, the lookup through cmd.exe passes an old .exe over for a current .cmd', () => {
    // As spawn-plumbing probes it: a fresh process, the platform patched after
    // the runtime loads, and where.exe answered by a `cmd.exe` on the PATH,
    // which node runs a command line through on Windows.
    const m = machine();
    const exe = makeClaude(m.dir('exe'), OLD, 'claude.exe');
    const cmd = npmLauncher(m.dir('npm'), '2.1.318');
    const where = windows(m, [exe, cmd]);
    fs.writeFileSync(path.join(where, 'cmd.exe'), '#!/bin/sh\ncat "$(dirname "$0")/answer"\n');
    fs.chmodSync(path.join(where, 'cmd.exe'), 0o755);
    const script = [
      `const rt = require(${JSON.stringify(LIB_KEY)});`,
      "Object.defineProperty(process, 'platform', { value: 'win32' });",
      "console.log('RESOLVED:' + rt.resolveClaudeBin());",
    ].join('\n');
    const env = { PATH: [where, '/usr/bin', '/bin'].join(':'), HOME: m.home };
    const res = require('node:child_process').spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 30000 });
    const line = String(res.stdout).split('\n').find((l) => l.startsWith('RESOLVED:'));
    assert.ok(line, `the probe printed a resolution (stderr: ${String(res.stderr).slice(0, 300)})`);
    assert.strictEqual(line.slice('RESOLVED:'.length), cmd.bin);
    assert.deepStrictEqual(cmd.runs(), [], 'the .cmd was read from its package, never run');
  });

  test('an old .exe and an old npm .cmd: the .exe is refused by name, and nothing starts', async () => {
    const m = machine();
    const exe = makeClaude(m.dir('exe'), OLD, 'claude.exe');
    const cmd = npmLauncher(m.dir('npm'), '2.0.58');
    await onWindows(m, [exe, cmd], async (rt) => {
      const { error } = await spawnAndSettle(rt);
      assert.strictEqual(error && error.message, frozen('2.0.58', exe.bin));
    });
    assert.deepStrictEqual(exe.chats(), []);
    assert.deepStrictEqual(cmd.runs(), [], 'the .cmd was read from its package, never run');
  });
});
