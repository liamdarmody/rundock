'use strict';
// THE OLDEST CLAUDE CODE RUNDOCK STARTS, AND WHAT HAPPENS BELOW IT.
//
// Claude Code 2.0.0 to 2.0.58 declare `--agents <json>` and no `--agent`, so a
// chat started on one of them ended in its parser's own words, `error: unknown
// option '--agent' (Did you mean --agents?)` (#401). spawnClaude reads the
// version of the copy it found before it starts anything, and below the floor
// starts nothing and hands the caller's error callback an error that says so.
//
// Every case runs a stub written to a temp folder: it prints the version a
// test chose and logs every way it was run, so a version probe can be told
// from a chat it was handed. Its folder is first on PATH and nothing else that
// could hold a `claude` is on it, so no real Claude Code ever runs here.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeTempDir, cleanup } = require('../helpers/workspace.js');

after(cleanup);

const ROOT = path.join(__dirname, '..', '..');
const LIB_KEY = require.resolve('../../lib/runtime/claude.js');
// Required where used, so a test about spawnClaude reports on spawnClaude
// even where this module does not exist.
const floorLib = () => require('../../lib/runtime/claude-floor.js');
const config = require('../../lib/config.js');

// A private copy of the runtime per test, so a remembered verdict or a
// resolved path never carries from one test into the next.
function freshClaudeRuntime() {
  const cached = require.cache[LIB_KEY];
  delete require.cache[LIB_KEY];
  const mod = require(LIB_KEY);
  delete require.cache[LIB_KEY];
  if (cached) require.cache[LIB_KEY] = cached;
  return mod;
}

// The stub. What it answers to --version is read from `said` beside it each
// time it runs, so a test can update the copy in place: STALL never answers,
// CRASH exits 3 having printed nothing. Each run is logged with its
// arguments, its working folder, a variable from the environment it was
// given, whether its stdin was closed (the null device) or a pipe, and what
// each of its three standard streams is.
function stubSource() {
  return `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
let stdin = 'unknown';
try { stdin = fs.fstatSync(0).isCharacterDevice() ? 'closed' : 'open'; } catch (e) { stdin = 'closed'; }
const kind = (fd) => { try { const s = fs.fstatSync(fd); return s.isCharacterDevice() ? 'null' : (s.isFIFO() || s.isSocket()) ? 'pipe' : 'other'; } catch (e) { return 'none'; } };
fs.appendFileSync(path.join(__dirname, 'runs.jsonl'), JSON.stringify({ args, cwd: process.cwd(), marker: process.env.FLOOR_TEST_MARKER || null, stdin, fds: [0, 1, 2].map(kind) }) + '\\n');
if (args[0] === '--version') {
  const said = fs.readFileSync(path.join(__dirname, 'said'), 'utf8');
  if (said === 'STALL') setTimeout(() => {}, 20000);
  else if (said === 'CRASH') process.exit(3);
  else { process.stdout.write(said + '\\n'); process.exit(0); }
} else {
  setTimeout(() => process.exit(0), 50);
}
`;
}

// The stub, written into `dir`, which is made if it is not there.
function stubAt(dir, said) {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, stubSource());
  fs.chmodSync(bin, 0o755);
  fs.writeFileSync(path.join(dir, 'said'), said);
  return { dir, bin, say: (next) => fs.writeFileSync(path.join(dir, 'said'), next) };
}

// `folder`, when given, is the name of the folder the stub sits in, inside a
// fresh temp folder: a name a shell would read as more than a name.
function makeStub(said, folder) {
  const dir = makeTempDir('claude-floor-stub-');
  return stubAt(folder ? path.join(dir, folder) : dir, said);
}

function runsOf(stub) {
  const file = path.join(stub.dir, 'runs.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
const probesOf = (stub) => runsOf(stub).filter((r) => r.args[0] === '--version');
const chatsOf = (stub) => runsOf(stub).filter((r) => r.args[0] !== '--version');

// PATH holds the given folders and the system folders `which` lives in,
// nothing else. The stubs name node by its full path, so node's own folder,
// which can also hold a globally installed claude, is never on it.
function withPath(dirs, fn) {
  const before = process.env.PATH;
  process.env.PATH = [...dirs, '/usr/bin', '/bin'].join(path.delimiter);
  const restore = () => { process.env.PATH = before; };
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

// A workspace for the pid file, and the guard hand-off recorded. `extra` is
// wired beside it: `platform`, to stand in another platform for the floor.
function wired(rt, extra = {}) {
  const ws = makeTempDir('claude-floor-ws-');
  const previousWs = config.getWorkspace();
  config.setWorkspace(ws);
  const guarded = [];
  const prev = rt.wireClaudeRuntimeDeps({ onClaudeSpawn: (proc, info) => guarded.push(info), ...extra });
  return { ws, guarded, restore: () => { rt.wireClaudeRuntimeDeps(prev); config.setWorkspace(previousWs); } };
}

// What spawnClaude logs, kept rather than printed.
function quietWarn() {
  const said = [];
  const real = console.warn;
  console.warn = (...args) => { said.push(args.join(' ')); };
  return { said, restore: () => { console.warn = real; } };
}

const CHAT_ARGS = ['--output-format', 'stream-json', '--verbose', '--agent', 'writer'];

// Start one spawn and settle on how it ended: the error the callback was
// handed, or the close of a process that started. The process is on the
// returned promise too, for a look at it while it runs.
function spawnAndSettle(rt, args, options) {
  let proc = null;
  const settled = new Promise((resolve) => {
    let error = null;
    proc = rt.spawnClaude(args, options, (err) => { error = err; });
    const timer = setTimeout(() => resolve({ proc, error, closed: false }), 10000);
    proc.on('close', () => { clearTimeout(timer); resolve({ proc, error, closed: true }); });
  });
  settled.proc = proc;
  return settled;
}

// Whether a process group with this id exists: one a detached child leads.
// Signal 0 tests for it and delivers nothing.
function leadsGroup(pid) {
  try { process.kill(-pid, 0); return true; } catch (e) { return e.code === 'ESRCH' ? false : `unknown (${e.code})`; }
}

const frozen = (version, bin) => `Rundock found Claude Code ${version} at ${bin}. Rundock needs 2.0.59 or later. `
  + 'It looks for Claude Code in ~/.local/bin, ~/.claude/bin, /usr/local/bin and /opt/homebrew/bin, in that order. '
  + 'Update that copy, or install a current one in a folder that comes before it. '
  + 'The native installer puts it in ~/.local/bin. Then send your message again.';

const POSIX = process.platform === 'win32' ? 'the stub is a POSIX script found with which' : false;

// ── The flag table and the floor ──

// Every quoted flag literal in a source: two dashes, then letters, digits and
// hyphens, in single, double or back quotes.
const flagsIn = (src) => [...src.matchAll(/(['"`])(--[A-Za-z0-9][A-Za-z0-9-]*)\1/g)].map((m) => m[2]);

describe('the flag table and the floor', () => {
  test('every flag the spawn paths pass to Claude Code has a row in the flag table', () => {
    const { FLAG_SINCE } = floorLib();
    // The pattern reads a flag with a digit in it, in any quotes, and nothing
    // that only starts like one.
    assert.deepStrictEqual(flagsIn("f('--a2b', \"--c3\", `--d-4`, '--E5', '--', '- -x', '--x y')"), ['--a2b', '--c3', '--d-4', '--E5'],
      'the pattern reads every quoted flag literal');
    const found = new Set();
    for (const file of ['server.js', 'lib/runtime/claude.js', 'lib/delegation/engine.js', 'lib/scheduler.js']) {
      for (const flag of flagsIn(fs.readFileSync(path.join(ROOT, file), 'utf8'))) found.add(flag);
    }
    // The read is held to what it must find, so a pattern that stops matching
    // fails here rather than passing on an empty inventory.
    assert.ok(found.size >= 15, `the inventory read no flags: the pattern has gone blind (found ${found.size})`);
    for (const flag of ['--agent', '--resume', '--session-id', '--add-dir', '--dangerously-skip-permissions']) {
      assert.ok(found.has(flag), `the inventory reads ${flag}`);
    }
    const missing = [...found].filter((flag) => !Object.prototype.hasOwnProperty.call(FLAG_SINCE, flag));
    assert.deepStrictEqual(missing, [], 'each flag passed to Claude Code needs a row, with its first release or null');
  });

  test('the floor is 2.0.59 today, the first release with --agent', () => {
    const { FLAG_SINCE, FLOOR } = floorLib();
    assert.strictEqual(FLAG_SINCE['--agent'], '2.0.59');
    assert.strictEqual(FLOOR, '2.0.59');
  });

  test('the floor is the highest recorded row, compared as numbers, and an unrecorded row sets nothing', () => {
    const { floorOf } = floorLib();
    assert.strictEqual(floorOf({ '--a': '2.9.0', '--b': null, '--c': '2.10.0', '--d': '1.99.99' }), '2.10.0');
    assert.strictEqual(floorOf({ '--a': '2.0.59', '--b': '2.0.100' }), '2.0.100');
    assert.strictEqual(floorOf({ '--a': null }), '0.0.0', 'a table with nothing recorded starts every version');
  });
});

describe('versions are compared as numbers, part by part', () => {
  test('a suffix is read past, and each part compares as a number', () => {
    const { versionIn, meetsFloor } = floorLib();
    const cases = [
      ['2.0.58', false], ['2.0.58 (Claude Code)', false], ['1.0.128', false], ['0.0.0-stub', false],
      ['2.0.59', true], ['2.0.59 (Claude Code)', true], ['2.0.59-beta.1', true],
      ['2.0.100', true], ['2.0.100 (Claude Code)', true], ['2.1.0', true], ['2.10.0', true], ['3.0.0', true],
    ];
    for (const [said, meets] of cases) assert.strictEqual(meetsFloor(versionIn(said)), meets, `${said} ${meets ? 'meets' : 'is below'} the floor`);
    assert.strictEqual(versionIn('2.0.100 (Claude Code)\n'), '2.0.100');
    assert.strictEqual(versionIn('2.10.0-beta.1'), '2.10.0');
  });

  test('2.10.0 is newer than 2.9.0, and 2.0.100 than 2.0.59', () => {
    const { compareVersions } = floorLib();
    assert.strictEqual(compareVersions('2.10.0', '2.9.0'), 1);
    assert.strictEqual(compareVersions('2.9.0', '2.10.0'), -1);
    assert.strictEqual(compareVersions('2.0.100', '2.0.59'), 1);
    assert.strictEqual(compareVersions('2.0.59', '2.0.59'), 0);
  });

  test('output with no version in it gives no verdict at all', () => {
    const { versionIn, meetsFloor } = floorLib();
    for (const said of [null, undefined, '', 'Claude Code', 'command not found', '2.0', 'v2']) {
      assert.strictEqual(versionIn(said), null, `nothing read from ${JSON.stringify(said)}`);
      assert.strictEqual(meetsFloor(versionIn(said)), null);
    }
  });

  test('only the Claude Code version line counts, never another number in the output', () => {
    const { versionIn } = floorLib();
    // A line before the version line, with a number of its own, is read past.
    assert.strictEqual(versionIn('Warning: helper 2.1.318\n2.0.58 (Claude Code)\n'), '2.0.58');
    assert.strictEqual(versionIn('Warning: helper 2.1.318\r\n2.0.58 (Claude Code)\r\n'), '2.0.58');
    assert.strictEqual(versionIn('Update available: 2.1.318\n2.0.58\n'), '2.0.58', 'a line that is only a version is the version');
    assert.strictEqual(versionIn('note 1.0.0\n2.0.59 (Claude Code)\n3.0.0\n'), '2.0.59', 'the line naming Claude Code wins');
    // A number that is not on a version line is no version at all.
    for (const said of ['Warning: helper 2.0.58', 'claude 2.0.58 build', 'node v2.0.58', '2.0.58 (Something Else)', 'Error: 2.0.58 (Claude Code) is broken']) {
      assert.strictEqual(versionIn(said), null, `nothing read from ${JSON.stringify(said)}`);
    }
  });
});

// ── spawnClaude below the floor ──

describe('below the floor nothing is started', { skip: POSIX }, () => {
  test('a copy below the floor is never started: the callback gets CLAUDE_TOO_OLD with the version, the path and the floor', async () => {
    const stub = makeStub('2.0.58 (Claude Code)');
    const rt = freshClaudeRuntime();
    const w = wired(rt);
    try {
      const { proc, error, closed } = await withPath([stub.dir], () => spawnAndSettle(rt, CHAT_ARGS, { stdio: 'ignore' }));
      assert.ok(error, 'the error callback ran');
      assert.strictEqual(error.code, 'CLAUDE_TOO_OLD');
      assert.strictEqual(error.version, '2.0.58');
      assert.strictEqual(error.path, stub.bin);
      assert.strictEqual(error.floor, '2.0.59');
      assert.strictEqual(error.message, frozen('2.0.58', stub.bin));
      assert.strictEqual(closed, true, 'and it closes after the error, as a spawn that failed does');
      assert.strictEqual(proc.pid, undefined, 'no process');
      assert.deepStrictEqual(chatsOf(stub), [], 'the binary was asked its version and never handed the chat');
      assert.strictEqual(probesOf(stub).length, 1);
      assert.deepStrictEqual(w.guarded, [], 'nothing started, so nothing for the answer-file guard to watch');
      assert.deepStrictEqual(rt.loadPidFile(), [], 'and no pid recorded');
    } finally { w.restore(); }
  });

  test('what stands in for a refused copy has its stdin guarded: a write after its end is logged, never uncaught', async () => {
    // A caller writes the message to the process it was handed; a write that
    // lands after the stand-in's stdin has ended fails, and with no handler
    // that failure would end the server (lib/runtime/child-stdin.js).
    const { failureLog } = require('../../lib/runtime/child-stdin.js');
    const stub = makeStub('2.0.58 (Claude Code)');
    const rt = freshClaudeRuntime();
    const w = wired(rt);
    const lines = [];
    const realWrite = failureLog.write;
    failureLog.write = (line) => { lines.push(line); };
    const uncaught = [];
    const onUncaught = (err) => { uncaught.push(err); };
    process.on('uncaughtException', onUncaught);
    try {
      const { proc, error } = await withPath([stub.dir], () => spawnAndSettle(rt, CHAT_ARGS, { stdio: 'ignore' }));
      assert.strictEqual(error && error.code, 'CLAUDE_TOO_OLD');
      proc.stdin.end();
      proc.stdin.write('a message after the end\n');
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepStrictEqual(uncaught.map((err) => err.code), [], 'no uncaught error');
      const logged = lines.filter((line) => line.startsWith('[Stdin]'));
      assert.strictEqual(logged.length, 1, 'one [Stdin] line for the failed write');
      assert.match(logged[0], /claude \(not started: below the version floor\)/);
      assert.match(logged[0], /ERR_STREAM_WRITE_AFTER_END/);
    } finally {
      process.removeListener('uncaughtException', onUncaught);
      failureLog.write = realWrite;
      w.restore();
    }
  });

  test('sending again while the copy is still old reads it again and starts nothing again', async () => {
    const stub = makeStub('2.0.58 (Claude Code)');
    const rt = freshClaudeRuntime();
    const w = wired(rt);
    try {
      await withPath([stub.dir], async () => {
        const first = await spawnAndSettle(rt, CHAT_ARGS, { stdio: 'ignore' });
        const second = await spawnAndSettle(rt, CHAT_ARGS, { stdio: 'ignore' });
        assert.strictEqual(first.error && first.error.code, 'CLAUDE_TOO_OLD');
        assert.strictEqual(second.error && second.error.code, 'CLAUDE_TOO_OLD');
      });
      assert.strictEqual(probesOf(stub).length, 2, 'a failing verdict is never remembered');
      assert.deepStrictEqual(chatsOf(stub), []);
    } finally { w.restore(); }
  });

  test('updated in place, the copy starts on the next spawn, with no restart', async () => {
    const stub = makeStub('2.0.58 (Claude Code)');
    const rt = freshClaudeRuntime();
    const w = wired(rt);
    try {
      await withPath([stub.dir], async () => {
        const before = await spawnAndSettle(rt, CHAT_ARGS, { stdio: 'ignore' });
        assert.strictEqual(before.error && before.error.code, 'CLAUDE_TOO_OLD');
        stub.say('2.1.318 (Claude Code)');
        const after = await spawnAndSettle(rt, CHAT_ARGS, { stdio: 'ignore' });
        assert.strictEqual(after.error, null, 'the updated copy starts');
      });
      assert.strictEqual(chatsOf(stub).length, 1, 'and it was handed the chat');
      assert.deepStrictEqual(chatsOf(stub)[0].args, CHAT_ARGS);
    } finally { w.restore(); }
  });

  test('a copy whose version line says 2.0.58 is refused as 2.0.58, whatever number another line holds', async () => {
    const stub = makeStub('Warning: helper 2.1.318\n2.0.58 (Claude Code)');
    const rt = freshClaudeRuntime();
    const w = wired(rt);
    try {
      const { error } = await withPath([stub.dir], () => spawnAndSettle(rt, CHAT_ARGS, { stdio: 'ignore' }));
      assert.strictEqual(error && error.code, 'CLAUDE_TOO_OLD');
      assert.strictEqual(error.version, '2.0.58');
      assert.deepStrictEqual(chatsOf(stub), []);
    } finally { w.restore(); }
  });

  test('removed, so that a current copy later on PATH is found, the next spawn finds and starts that one', async () => {
    const old = makeStub('2.0.58 (Claude Code)');
    const current = makeStub('2.1.318 (Claude Code)');
    const rt = freshClaudeRuntime();
    const w = wired(rt);
    try {
      await withPath([old.dir, current.dir], async () => {
        const before = await spawnAndSettle(rt, CHAT_ARGS, { stdio: 'ignore' });
        assert.strictEqual(before.error && before.error.path, old.bin, 'the old copy is found first, and refused');
        fs.rmSync(old.bin);
        const after = await spawnAndSettle(rt, CHAT_ARGS, { stdio: 'ignore' });
        assert.strictEqual(after.error, null, 'the path is found again, and the current copy starts');
      });
      assert.deepStrictEqual(chatsOf(old), []);
      assert.strictEqual(chatsOf(current).length, 1);
    } finally { w.restore(); }
  });
});

// ── Where Rundock looks for Claude Code ──

// The one list of folders the desktop app puts on PATH before it looks for
// `claude`. Required where used, as the floor module is.
const foldersLib = () => require('../../lib/runtime/claude-folders.js');

describe('where Rundock looks for Claude Code', () => {
  test('the list is the one the desktop app has always put on PATH, on each platform, with the native installer\'s folder first', () => {
    const { claudeFolders, nativeInstallerFolder } = foldersLib();
    assert.deepStrictEqual(claudeFolders({ platform: 'darwin', home: '/Users/someone', env: {} }),
      ['/Users/someone/.local/bin', '/Users/someone/.claude/bin', '/usr/local/bin', '/opt/homebrew/bin']);
    assert.deepStrictEqual(claudeFolders({ platform: 'linux', home: '/home/someone', env: {} }),
      ['/home/someone/.local/bin', '/home/someone/.claude/bin', '/usr/local/bin', '/opt/homebrew/bin']);
    const env = { LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local', APPDATA: 'C:\\Users\\someone\\AppData\\Roaming' };
    assert.deepStrictEqual(claudeFolders({ platform: 'win32', home: 'C:\\Users\\someone', env }),
      ['C:\\Users\\someone\\.local\\bin', 'C:\\Users\\someone\\AppData\\Local\\Microsoft\\WinGet\\Links', 'C:\\Users\\someone\\AppData\\Roaming\\npm']);
    assert.deepStrictEqual(claudeFolders({ platform: 'win32', home: 'C:\\Users\\someone', env: {} }), ['C:\\Users\\someone\\.local\\bin'],
      'a folder whose variable is unset is left out, as before');
    for (const [platform, home] of [['darwin', '/Users/someone'], ['linux', '/home/someone'], ['win32', 'C:\\Users\\someone']]) {
      assert.strictEqual(claudeFolders({ platform, home, env })[0], nativeInstallerFolder(home, platform),
        `on ${platform} the native installer's folder is searched first, so a copy it puts there is found ahead of the rest`);
    }
  });

  test('PATH gets each folder it lacks at its front, in order, and one it holds keeps its place', () => {
    const { withClaudeFolders } = foldersLib();
    const folders = ['/h/.local/bin', '/h/.claude/bin', '/usr/local/bin', '/opt/homebrew/bin'];
    assert.strictEqual(withClaudeFolders('/usr/bin:/bin', folders, ':'), '/h/.local/bin:/h/.claude/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin');
    assert.strictEqual(withClaudeFolders('/usr/bin:/usr/local/bin:/bin', folders, ':'), '/h/.local/bin:/h/.claude/bin:/opt/homebrew/bin:/usr/bin:/usr/local/bin:/bin');
    assert.strictEqual(withClaudeFolders(folders.join(':'), folders, ':'), folders.join(':'), 'nothing missing, nothing changed');
    assert.strictEqual(withClaudeFolders('C:\\Windows', ['C:\\h\\.local\\bin'], ';'), 'C:\\h\\.local\\bin;C:\\Windows');
  });
});

// ── What the notice tells a person to do ──

// Removing the copy found is not a way forward on its own: the current copy
// can sit outside every folder Rundock searches (an npm install under a Node
// version manager, as in #401), and with the old one gone Rundock finds no
// copy at all. So the notice names the folders Rundock searches and
// leads to a current copy in one of them.

// A folder as a person reads it in the notice: one inside the home folder
// starts at `~`.
const asShown = (dir) => (dir.startsWith(os.homedir() + path.sep) ? `~${dir.slice(os.homedir().length)}` : dir);
// The folders the notice says Rundock looks in, as it lists them.
function namedIn(said) {
  const m = /It looks for Claude Code in (.+?), in that order\. /.exec(said);
  return m ? m[1].split(/, | and /) : null;
}
// Any word that would send a person to take a copy away.
const REMOVAL = /\b(remov|delet|uninstall|rm\b|trash)/i;
// The PATH a packaged app starts with on macOS, before Rundock adds to it.
const LAUNCHD_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);

describe('what the too-old notice tells a person to do', () => {
  test('the folders it names are the list the lookup puts on PATH, in the order they are searched', () => {
    const { tooOldError } = floorLib();
    const { claudeFolders } = foldersLib();
    const said = tooOldError('2.0.58', '/usr/local/bin/claude').message;
    const folders = claudeFolders();
    assert.ok(folders.length >= 3, `the list holds the folders (${folders.length})`);
    assert.deepStrictEqual(namedIn(said), folders.map(asShown), 'every folder in the list, in its order, and no other');
    if (process.platform !== 'win32') {
      assert.strictEqual(said, frozen('2.0.58', '/usr/local/bin/claude'));
    }
  });

  test('neither the desktop app nor the notice spells a folder itself, and the desktop app only calls the shared step', () => {
    // What proves the step puts the list on PATH is the test below that runs
    // it; this holds the two readers to that one list.
    const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
    const start = main.indexOf('function ensurePath()');
    assert.ok(start >= 0, 'electron/main.js still has ensurePath');
    const ensurePath = main.slice(start, main.indexOf('\n}\n', start) + 2);
    assert.strictEqual(ensurePath, "function ensurePath() {\n  require('../lib/runtime/claude-folders.js').ensureClaudeFolders(process.env);\n}");
    const floorSource = fs.readFileSync(path.join(ROOT, 'lib', 'runtime', 'claude-floor.js'), 'utf8');
    assert.ok(floorSource.includes("require('./claude-folders.js')"), 'the notice reads the same list');
    for (const [file, source] of [['ensurePath in electron/main.js', ensurePath], ['lib/runtime/claude-floor.js', floorSource]]) {
      for (const spelled of ["'.local'", "'.claude'", "'bin'", '/usr/local/bin', '/opt/homebrew/bin', 'WinGet', 'APPDATA']) {
        assert.ok(!source.includes(spelled), `${file} spells ${spelled} itself, a copy of the list that can drift from it`);
      }
    }
  });

  test('it offers two ways forward: update that copy, or install a current one in a folder searched before it, which the native installer does', () => {
    const { tooOldError } = floorLib();
    const { nativeInstallerFolder } = foldersLib();
    const said = tooOldError('2.0.58', '/opt/homebrew/bin/claude').message;
    assert.ok(said.includes('Update that copy, or install a current one in a folder that comes before it. '), said);
    const native = asShown(nativeInstallerFolder(os.homedir()));
    assert.strictEqual(native, path.join('~', '.local', 'bin'));
    assert.ok(said.includes(`The native installer puts it in ${native}. `), 'the native installer, and the folder it puts claude in');
    assert.ok(said.endsWith(' Then send your message again.'));
  });

  test('it never sends a person to remove the copy it found', () => {
    const { tooOldError } = floorLib();
    for (const bin of ['/usr/local/bin/claude', '/opt/homebrew/bin/claude', path.join(os.homedir(), '.claude', 'bin', 'claude')]) {
      assert.doesNotMatch(tooOldError('2.0.58', bin).message, REMOVAL);
    }
  });

  test('it is the whole notice as plain text: one paragraph, no markup, under 400 characters', () => {
    const { tooOldError } = floorLib();
    for (const bin of ['/usr/local/bin/claude', '/opt/homebrew/bin/claude', '/Users/someone/.claude/bin/claude',
      '/Users/someone/.nvm/versions/node/v20.11.1/bin/claude', 'C:\\Users\\someone\\AppData\\Roaming\\npm\\claude.cmd']) {
      const said = tooOldError('2.0.58', bin).message;
      assert.ok(said.length < 400, `${said.length} characters with the copy at ${bin}`);
      assert.doesNotMatch(said.replace(bin, ''), /[`*_#<>[\]]|\r|\n/, 'no markup and no line break');
    }
  });

  test('with no home folder to read the list from, it still names the copy, its version and the floor, and never throws', () => {
    const { tooOldError } = floorLib();
    const realHomedir = os.homedir;
    os.homedir = () => { throw Object.assign(new Error('no home directory'), { code: 'ENOENT' }); };
    let error = null;
    try {
      assert.doesNotThrow(() => { error = tooOldError('2.0.58', '/usr/local/bin/claude'); });
    } finally { os.homedir = realHomedir; }
    assert.strictEqual(error.message, 'Rundock found Claude Code 2.0.58 at /usr/local/bin/claude. Rundock needs 2.0.59 or later. '
      + 'Update that copy, then send your message again.');
    assert.deepStrictEqual([error.code, error.version, error.path, error.floor], ['CLAUDE_TOO_OLD', '2.0.58', '/usr/local/bin/claude', '2.0.59']);
    assert.doesNotMatch(error.message, REMOVAL);
  });

  test('the app puts the list on PATH, so following the native installer starts the current copy ahead of the old one', { skip: POSIX }, async () => {
    const { claudeFolders, ensureClaudeFolders } = foldersLib();
    const home = makeTempDir('claude-floor-home-');
    const env = { PATH: LAUNCHD_PATH };
    ensureClaudeFolders(env, { home });
    const folders = claudeFolders({ home });
    assert.deepStrictEqual(env.PATH.split(path.delimiter), [...folders, ...LAUNCHD_PATH.split(path.delimiter)],
      'the list first, in its order, then the PATH the app started with');
    assert.deepStrictEqual(folders.slice(0, 2), [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'bin')]);
    // Nothing is found in the system folders here: a stub sits in a folder
    // ahead of them at every spawn below.
    const old = stubAt(folders[1], '2.0.58 (Claude Code)');
    const rt = freshClaudeRuntime();
    const w = wired(rt);
    const before = process.env.PATH;
    process.env.PATH = env.PATH;
    try {
      const refused = await spawnAndSettle(rt, CHAT_ARGS, { stdio: 'ignore' });
      assert.strictEqual(refused.error && refused.error.path, old.bin, 'the old copy is found, and refused');
      const current = stubAt(folders[0], '2.1.318 (Claude Code)');
      const after = await spawnAndSettle(rt, CHAT_ARGS, { stdio: 'ignore' });
      assert.strictEqual(after.error, null, 'the current copy starts');
      assert.strictEqual(rt.resolveClaudeBin(), current.bin, 'found in the native installer\'s folder');
      assert.strictEqual(chatsOf(current).length, 1, 'and is handed the chat');
      assert.ok(fs.existsSync(old.bin), 'with the old copy still in place');
      assert.deepStrictEqual(chatsOf(old), [], 'which is never handed one');
    } finally {
      process.env.PATH = before;
      w.restore();
    }
  });
});

// ── spawnClaude at or above the floor ──

// A private runtime whose spawn is watched: claude.js takes `spawn` from
// child_process as it loads, so the copy loaded here calls through the
// recorder, and every other copy keeps the real one.
function watchedRuntime() {
  const cp = require('node:child_process');
  const real = cp.spawn;
  const calls = [];
  cp.spawn = function recordedSpawn(file, args, options) {
    calls.push({ file, args, options });
    return real.apply(this, arguments);
  };
  try { return { rt: freshClaudeRuntime(), calls }; } finally { cp.spawn = real; }
}

describe('at or above the floor the spawn is exactly as before', { skip: POSIX }, () => {
  for (const said of ['2.0.59', '2.0.59 (Claude Code)', '2.0.100 (Claude Code)', '2.10.0-beta.1', '2.1.318 (Claude Code)']) {
    test(`${said}: started with the same arguments, options and pid tracking`, async () => {
      const stub = makeStub(said);
      const { rt, calls } = watchedRuntime();
      const w = wired(rt);
      try {
        const cwd = makeTempDir('claude-floor-cwd-');
        const env = { ...process.env, FLOOR_TEST_MARKER: 'given-env', RUNDOCK_CONVO_ID: 'convo-floor' };
        let tracked = null;
        let given = null;
        let leads = null;
        const { proc, error, closed } = await withPath([stub.dir], () => {
          given = { cwd, env: { ...env, PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'ignore'] };
          const p = spawnAndSettle(rt, [...CHAT_ARGS, rt.INHERIT_MARKER], given);
          tracked = rt.loadPidFile();
          leads = leadsGroup(p.proc.pid);
          return p;
        });
        assert.strictEqual(error, null);
        assert.strictEqual(closed, true);
        assert.ok(proc.pid > 0, 'a real process');
        // The spawn contract, as spawnClaude has always kept it: the
        // caller's options as given, with detached added on POSIX.
        assert.deepStrictEqual(calls.map((c) => [c.file, c.args, c.options]),
          [[stub.bin, CHAT_ARGS, { ...given, detached: process.platform !== 'win32' }]], 'one spawn, with the options the caller gave');
        assert.strictEqual(calls[0].options.env, given.env, 'the very environment the caller built');
        assert.strictEqual(calls[0].options.stdio, given.stdio, 'and the very stdio it asked for');
        assert.deepStrictEqual(tracked.map((r) => [r.pid, r.cmd]), [[proc.pid, 'claude']], 'its pid recorded as it started');
        assert.deepStrictEqual(rt.loadPidFile(), [], 'and forgotten when it closed');
        const chats = chatsOf(stub);
        assert.strictEqual(chats.length, 1);
        assert.deepStrictEqual(chats[0].args, CHAT_ARGS, 'the arguments as given, the internal marker taken out');
        assert.strictEqual(chats[0].cwd, fs.realpathSync(cwd));
        assert.strictEqual(chats[0].marker, 'given-env', 'the environment it was given');
        assert.deepStrictEqual(chats[0].fds, ['pipe', 'pipe', 'null'], 'the child has the stdio it was asked for');
        assert.strictEqual(leads, true, 'and, detached, leads a process group of its own');
        assert.deepStrictEqual(w.guarded, [{ convoId: 'convo-floor', agentId: 'writer' }], 'handed to the answer-file guard');
      } finally { w.restore(); }
    });
  }
});

// ── The probe ──

describe('the version probe', { skip: POSIX }, () => {
  test('a copy that passes is read once per path, however many spawns follow', async () => {
    const stub = makeStub('2.1.318 (Claude Code)');
    const rt = freshClaudeRuntime();
    const w = wired(rt);
    try {
      await withPath([stub.dir], async () => {
        for (let i = 0; i < 3; i++) assert.strictEqual((await spawnAndSettle(rt, CHAT_ARGS, { stdio: 'ignore' })).error, null);
      });
      assert.strictEqual(probesOf(stub).length, 1, 'one probe');
      assert.strictEqual(chatsOf(stub).length, 3, 'three chats');
    } finally { w.restore(); }
  });

  test('the probe runs with stdin closed', async () => {
    const stub = makeStub('2.1.318 (Claude Code)');
    const rt = freshClaudeRuntime();
    const w = wired(rt);
    try {
      await withPath([stub.dir], () => spawnAndSettle(rt, CHAT_ARGS, { stdio: ['pipe', 'ignore', 'ignore'] }));
      assert.deepStrictEqual(probesOf(stub).map((r) => r.stdin), ['closed'], 'the probe gets the null device');
      assert.deepStrictEqual(chatsOf(stub).map((r) => r.stdin), ['open'], 'while the chat keeps the stdin its caller asked for');
    } finally { w.restore(); }
  });

  // The probe runs the binary itself, never a command line a shell reads, so
  // the path it was found at is a path whatever characters it holds.
  test('a copy in a folder whose name holds a double quote gets the verdict any other copy gets', async () => {
    const stub = makeStub('2.0.58 (Claude Code)', 'with"quote');
    const rt = freshClaudeRuntime();
    const w = wired(rt);
    try {
      const { error } = await withPath([stub.dir], () => spawnAndSettle(rt, CHAT_ARGS, { stdio: 'ignore' }));
      assert.strictEqual(error && error.code, 'CLAUDE_TOO_OLD', 'refused, as at an ordinary path');
      assert.strictEqual(error.path, stub.bin);
      assert.strictEqual(error.message, frozen('2.0.58', stub.bin));
      assert.strictEqual(probesOf(stub).length, 1, 'the probe ran this copy');
      assert.deepStrictEqual(chatsOf(stub), []);
    } finally { w.restore(); }
  });

  test('a copy in a folder whose name holds $(...) is probed as a path: nothing in the name is run', async () => {
    const marker = path.join(makeTempDir('claude-floor-marker-'), 'ran-in-a-shell');
    const stub = makeStub('2.0.58 (Claude Code)', 'q$(touch $FLOOR_SHELL_MARKER)');
    const rt = freshClaudeRuntime();
    const w = wired(rt);
    process.env.FLOOR_SHELL_MARKER = marker;
    try {
      const { error } = await withPath([stub.dir], () => spawnAndSettle(rt, CHAT_ARGS, { stdio: 'ignore' }));
      assert.strictEqual(fs.existsSync(marker), false, 'no shell ran the command in the folder name');
      assert.strictEqual(error && error.code, 'CLAUDE_TOO_OLD', 'refused, as at an ordinary path');
      assert.strictEqual(error.path, stub.bin);
      assert.strictEqual(probesOf(stub).length, 1, 'the probe ran this copy');
      assert.deepStrictEqual(chatsOf(stub), []);
    } finally { delete process.env.FLOOR_SHELL_MARKER; w.restore(); }
  });

  test('on Windows a .cmd or .bat with no package beside it is never run, and its version is unknown', () => {
    // Node runs a .cmd or .bat only through a shell. The probe passes
    // `win32` in place of the platform it is on; the files are the POSIX
    // stub under those names, so a run would show in its log.
    const { versionIn } = floorLib();
    const stub = makeStub('2.0.58 (Claude Code)');
    const rt = freshClaudeRuntime();
    const named = ['claude.cmd', 'CLAUDE.BAT', 'claude.Cmd'].map((name) => {
      const bin = path.join(stub.dir, name);
      fs.copyFileSync(stub.bin, bin);
      fs.chmodSync(bin, 0o755);
      return bin;
    });
    for (const bin of named) assert.strictEqual(rt.readClaudeVersion(bin, 5000, 'win32'), null, `${path.basename(bin)} reads as unknown`);
    assert.deepStrictEqual(probesOf(stub), [], 'and none of them was run');
    // The same file on another platform is run and read: the platform is
    // what holds it back, not the file.
    assert.strictEqual(versionIn(rt.readClaudeVersion(named[0], 5000, 'linux')), '2.0.58');
    assert.strictEqual(probesOf(stub).length, 1);
    // A Windows executable is run for its version as on any platform, with no
    // shell, its timeout and stdin closed.
    const exe = path.join(stub.dir, 'claude.exe');
    fs.copyFileSync(stub.bin, exe);
    fs.chmodSync(exe, 0o755);
    assert.strictEqual(versionIn(rt.readClaudeVersion(exe, 5000, 'win32')), '2.0.58', 'claude.exe is read');
    assert.deepStrictEqual(probesOf(stub).map((r) => r.stdin), ['closed', 'closed']);
  });

  test('the probe is bounded by its timeout', () => {
    const stub = makeStub('STALL');
    const rt = freshClaudeRuntime();
    const started = Date.now();
    assert.strictEqual(rt.readClaudeVersion(stub.bin, 500), null, 'a stalled probe reads as nothing');
    assert.ok(Date.now() - started < 4000, `it gave up at its timeout (${Date.now() - started}ms)`);
    assert.strictEqual(rt.VERSION_PROBE_TIMEOUT_MS, 5000);
  });
});

// ── A Windows npm launcher ──

// A folder laid out as npm lays out a global install on Windows
// (`%APPDATA%\npm`): the launcher on PATH, and the package it starts beside
// it in node_modules. The launcher is the stub under a Windows name, so a run
// of it shows in its log, and it answers --version with `said`, never with
// the package's version, so a version read from the package is told from one
// read by running it. `pkg` is the package.json text, or null for none.
// `where.exe` finds the launcher on Windows; here a `which` that names it,
// first on PATH, stands in.
function npmGlobal(pkg, { said = '2.1.318 (Claude Code)', name = 'claude.cmd' } = {}) {
  const stub = makeStub(said);
  const bin = path.join(stub.dir, name);
  fs.renameSync(stub.bin, bin);
  if (pkg !== null) {
    const pkgDir = path.join(stub.dir, 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), pkg);
  }
  const finder = makeTempDir('claude-floor-which-');
  fs.writeFileSync(path.join(finder, 'which'), `#!/bin/sh\nprintf '%s\\n' '${bin}'\n`);
  fs.chmodSync(path.join(finder, 'which'), 0o755);
  return { ...stub, bin, finder };
}
const packageJson = (version) => JSON.stringify({ name: '@anthropic-ai/claude-code', version });

describe('a Windows npm launcher is never run: its version is read from the package beside it', { skip: POSIX }, () => {
  test('a claude.cmd whose package says 2.0.58 is refused with the frozen message, and the launcher is never run', async () => {
    const npm = npmGlobal(packageJson('2.0.58'));
    const rt = freshClaudeRuntime();
    const w = wired(rt, { platform: () => 'win32' });
    try {
      const { error } = await withPath([npm.finder], () => spawnAndSettle(rt, CHAT_ARGS, { stdio: 'ignore' }));
      assert.strictEqual(error && error.code, 'CLAUDE_TOO_OLD');
      assert.strictEqual(error.version, '2.0.58');
      assert.strictEqual(error.path, npm.bin);
      assert.strictEqual(error.message, frozen('2.0.58', npm.bin));
      assert.deepStrictEqual(runsOf(npm), [], 'the launcher was never run, for its version or for the chat');
    } finally { w.restore(); }
  });

  test('a claude.cmd whose package says 2.0.59 passes and starts, never run for its version', async () => {
    const npm = npmGlobal(packageJson('2.0.59'));
    const rt = freshClaudeRuntime();
    const w = wired(rt, { platform: () => 'win32' });
    const warn = quietWarn();
    try {
      await withPath([npm.finder], async () => {
        for (let i = 0; i < 2; i++) assert.strictEqual((await spawnAndSettle(rt, CHAT_ARGS, { stdio: 'ignore' })).error, null);
      });
      assert.deepStrictEqual(probesOf(npm), [], 'never run for its version');
      assert.strictEqual(chatsOf(npm).length, 2, 'and started for both chats');
      assert.deepStrictEqual(warn.said.filter((line) => line.includes(npm.bin)), [], 'its version was read, so nothing is logged');
    } finally { warn.restore(); w.restore(); }
  });

  for (const [beside, pkg] of [
    ['no package.json', null],
    ['a package.json that does not parse', '{ "name": "@anthropic-ai/claude-code", "version": "2.0.58", '],
    ['a package.json with no version', JSON.stringify({ name: '@anthropic-ai/claude-code' })],
  ]) {
    test(`a claude.cmd with ${beside} beside it is an unknown version: it starts, logged once, never run for its version`, async () => {
      const npm = npmGlobal(pkg);
      const rt = freshClaudeRuntime();
      const w = wired(rt, { platform: () => 'win32' });
      const warn = quietWarn();
      try {
        await withPath([npm.finder], async () => {
          for (let i = 0; i < 2; i++) assert.strictEqual((await spawnAndSettle(rt, CHAT_ARGS, { stdio: 'ignore' })).error, null);
        });
        assert.deepStrictEqual(probesOf(npm), [], 'never run for its version');
        assert.strictEqual(chatsOf(npm).length, 2, 'both spawns started');
        assert.strictEqual(warn.said.filter((line) => line.includes(npm.bin)).length, 1, 'logged once');
      } finally { warn.restore(); w.restore(); }
    });
  }

  test('.cmd, .BAT and .Cmd are read the same way, by the same rules, and none is run', () => {
    const { versionIn, meetsFloor } = floorLib();
    const rt = freshClaudeRuntime();
    for (const name of ['claude.cmd', 'CLAUDE.BAT', 'claude.Cmd', 'claude.bat']) {
      const npm = npmGlobal(packageJson('2.0.58'), { name });
      assert.strictEqual(versionIn(rt.readClaudeVersion(npm.bin, 5000, 'win32')), '2.0.58', `${name} reads its package's version`);
      assert.deepStrictEqual(runsOf(npm), [], `${name} was never run`);
    }
    const beta = npmGlobal(packageJson('2.10.0-beta.1'));
    assert.strictEqual(meetsFloor(versionIn(rt.readClaudeVersion(beta.bin, 5000, 'win32'))), true, 'a suffix is read past, and parts compare as numbers');
  });

  test('on linux the same layout is probed by running the binary, as before', async () => {
    const npm = npmGlobal(packageJson('2.0.58'));
    const rt = freshClaudeRuntime();
    const w = wired(rt, { platform: () => 'linux' });
    try {
      const { error } = await withPath([npm.finder], () => spawnAndSettle(rt, CHAT_ARGS, { stdio: 'ignore' }));
      assert.strictEqual(error, null, 'the 2.1.318 it prints passes: the package beside it is not read');
      assert.strictEqual(probesOf(npm).length, 1, 'it was run for its version');
      assert.strictEqual(chatsOf(npm).length, 1);
    } finally { w.restore(); }
    assert.strictEqual(rt.readClaudeVersion(npm.bin, 5000, 'linux').trim(), '2.1.318 (Claude Code)');
  });
});

// ── An unknown version ──

describe('when no version can be read, the spawn goes ahead as before, logged once', { skip: POSIX }, () => {
  for (const [name, said] of [
    ['crashes', 'CRASH'],
    ['prints something unreadable', 'Claude Code, version unknown'],
    ['prints an unrelated 2.0.58 and no Claude Code version', 'Warning: helper 2.0.58'],
  ]) {
    test(`a probe that ${name} lets the spawn go ahead, logged once`, async () => {
      const stub = makeStub(said);
      const rt = freshClaudeRuntime();
      const w = wired(rt);
      const warn = quietWarn();
      try {
        await withPath([stub.dir], async () => {
          for (let i = 0; i < 2; i++) assert.strictEqual((await spawnAndSettle(rt, CHAT_ARGS, { stdio: 'ignore' })).error, null);
        });
        assert.strictEqual(chatsOf(stub).length, 2, 'both spawns started');
        assert.strictEqual(probesOf(stub).length, 1, 'and the version was asked for once');
        assert.strictEqual(warn.said.filter((line) => line.includes(stub.bin)).length, 1, 'logged once');
      } finally { warn.restore(); w.restore(); }
    });
  }

  test('a probe that stalls lets the spawn go ahead, and the spawn waits no longer than the timeout', async () => {
    const stub = makeStub('STALL');
    const rt = freshClaudeRuntime();
    const w = wired(rt);
    const warn = quietWarn();
    try {
      const started = Date.now();
      let waited = null;
      const { error } = await withPath([stub.dir], () => {
        const p = spawnAndSettle(rt, CHAT_ARGS, { stdio: 'ignore' });
        waited = Date.now() - started;
        return p;
      });
      assert.strictEqual(error, null);
      assert.ok(waited < rt.VERSION_PROBE_TIMEOUT_MS + 3000, `the spawn waited ${waited}ms`);
      assert.strictEqual(chatsOf(stub).length, 1, 'and started');
      assert.strictEqual(warn.said.filter((line) => line.includes(stub.bin)).length, 1, 'logged once');
    } finally { warn.restore(); w.restore(); }
  });

  test('a copy that cannot be run is an unknown version, and the spawn still fails with EACCES', async () => {
    const stub = makeStub('2.1.318 (Claude Code)');
    const rt = freshClaudeRuntime();
    const w = wired(rt);
    const warn = quietWarn();
    try {
      const { error } = await withPath([stub.dir], () => {
        assert.strictEqual(rt.resolveClaudeBin(), stub.bin, 'found while it could still be run');
        fs.chmodSync(stub.bin, 0o644);
        return spawnAndSettle(rt, CHAT_ARGS, { stdio: 'ignore' });
      });
      assert.ok(error, 'the callback ran');
      assert.strictEqual(error.code, 'EACCES', 'the error a copy that cannot be run has always given');
      assert.deepStrictEqual(runsOf(stub), [], 'neither the probe nor the chat could run it');
      assert.strictEqual(warn.said.filter((line) => line.includes(stub.bin)).length, 1, 'the unknown version logged once');
    } finally { warn.restore(); w.restore(); }
  });

  test('a missing binary still fails as a missing binary', async () => {
    const empty = makeTempDir('claude-floor-empty-');
    const rt = freshClaudeRuntime();
    const w = wired(rt);
    const warn = quietWarn();
    const before = process.env.PATH;
    process.env.PATH = empty;
    try {
      const { error } = await spawnAndSettle(rt, CHAT_ARGS, { env: { ...process.env }, stdio: 'ignore' });
      assert.ok(error, 'the callback ran');
      assert.strictEqual(error.code, 'ENOENT', 'the error a missing binary has always given');
    } finally { process.env.PATH = before; warn.restore(); w.restore(); }
  });
});
