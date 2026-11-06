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
// given, and whether its stdin was closed (the null device) or a pipe.
function stubSource() {
  return `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
let stdin = 'unknown';
try { stdin = fs.fstatSync(0).isCharacterDevice() ? 'closed' : 'open'; } catch (e) { stdin = 'closed'; }
fs.appendFileSync(path.join(__dirname, 'runs.jsonl'), JSON.stringify({ args, cwd: process.cwd(), marker: process.env.FLOOR_TEST_MARKER || null, stdin }) + '\\n');
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

function makeStub(said) {
  const dir = makeTempDir('claude-floor-stub-');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, stubSource());
  fs.chmodSync(bin, 0o755);
  fs.writeFileSync(path.join(dir, 'said'), said);
  return { dir, bin, say: (next) => fs.writeFileSync(path.join(dir, 'said'), next) };
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

// A workspace for the pid file, and the guard hand-off recorded.
function wired(rt) {
  const ws = makeTempDir('claude-floor-ws-');
  const previousWs = config.getWorkspace();
  config.setWorkspace(ws);
  const guarded = [];
  const prev = rt.wireClaudeRuntimeDeps({ onClaudeSpawn: (proc, info) => guarded.push(info) });
  return { ws, guarded, restore: () => { rt.wireClaudeRuntimeDeps(prev); config.setWorkspace(previousWs); } };
}

const CHAT_ARGS = ['--output-format', 'stream-json', '--verbose', '--agent', 'writer'];

// Start one spawn and settle on how it ended: the error the callback was
// handed, or the close of a process that started.
function spawnAndSettle(rt, args, options) {
  return new Promise((resolve) => {
    let error = null;
    const proc = rt.spawnClaude(args, options, (err) => { error = err; });
    const timer = setTimeout(() => resolve({ proc, error, closed: false }), 10000);
    proc.on('close', () => { clearTimeout(timer); resolve({ proc, error, closed: true }); });
  });
}

const frozen = (version, bin) => `Rundock found Claude Code ${version} at ${bin}. Rundock needs 2.0.59 or later. `
  + 'Update that copy with `claude update`, or remove it, then send your message again.';

const POSIX = process.platform === 'win32' ? 'the stub is a POSIX script found with which' : false;

// ── The flag table and the floor ──

describe('the flag table and the floor', () => {
  test('every flag the spawn paths pass to Claude Code has a row in the flag table', () => {
    const { FLAG_SINCE } = floorLib();
    const found = new Set();
    for (const file of ['server.js', 'lib/runtime/claude.js', 'lib/delegation/engine.js', 'lib/scheduler.js']) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const m of src.matchAll(/'(--[a-z][a-z-]*)'/g)) found.add(m[1]);
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

// ── spawnClaude at or above the floor ──

describe('at or above the floor the spawn is exactly as before', { skip: POSIX }, () => {
  for (const said of ['2.0.59', '2.0.59 (Claude Code)', '2.0.100 (Claude Code)', '2.10.0-beta.1', '2.1.318 (Claude Code)']) {
    test(`${said}: started with the same arguments, options and pid tracking`, async () => {
      const stub = makeStub(said);
      const rt = freshClaudeRuntime();
      const w = wired(rt);
      try {
        const cwd = makeTempDir('claude-floor-cwd-');
        const env = { ...process.env, FLOOR_TEST_MARKER: 'given-env', RUNDOCK_CONVO_ID: 'convo-floor' };
        let tracked = null;
        const { proc, error, closed } = await withPath([stub.dir], () => {
          const p = spawnAndSettle(rt, [...CHAT_ARGS, rt.INHERIT_MARKER], { cwd, env: { ...env, PATH: process.env.PATH }, stdio: 'ignore' });
          tracked = rt.loadPidFile();
          return p;
        });
        assert.strictEqual(error, null);
        assert.strictEqual(closed, true);
        assert.ok(proc.pid > 0, 'a real process');
        assert.deepStrictEqual(tracked.map((r) => [r.pid, r.cmd]), [[proc.pid, 'claude']], 'its pid recorded as it started');
        assert.deepStrictEqual(rt.loadPidFile(), [], 'and forgotten when it closed');
        const chats = chatsOf(stub);
        assert.strictEqual(chats.length, 1);
        assert.deepStrictEqual(chats[0].args, CHAT_ARGS, 'the arguments as given, the internal marker taken out');
        assert.strictEqual(chats[0].cwd, fs.realpathSync(cwd));
        assert.strictEqual(chats[0].marker, 'given-env', 'the environment it was given');
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

  test('the probe is bounded by its timeout', () => {
    const stub = makeStub('STALL');
    const rt = freshClaudeRuntime();
    const started = Date.now();
    assert.strictEqual(rt.readClaudeVersion(stub.bin, 500), null, 'a stalled probe reads as nothing');
    assert.ok(Date.now() - started < 4000, `it gave up at its timeout (${Date.now() - started}ms)`);
    assert.strictEqual(rt.VERSION_PROBE_TIMEOUT_MS, 5000);
  });
});

// ── An unknown version ──

describe('when no version can be read, the spawn goes ahead as before, logged once', { skip: POSIX }, () => {
  function quietWarn() {
    const said = [];
    const real = console.warn;
    console.warn = (...args) => { said.push(args.join(' ')); };
    return { said, restore: () => { console.warn = real; } };
  }

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
