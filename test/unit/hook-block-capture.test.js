'use strict';
// CLAUDE CODE BLOCKS A CALL WHOSE PERMISSION HOOK EXITS 2, MEASURED.
//
// When the permission hook cannot write its answer, it ends a call it decides
// with exit code 2 and its reason on standard error, which Claude Code's
// documentation says is a block for PreToolUse. That claim is about somebody
// else's software, so it is held to a measurement:
// scripts/hook-block-truth/captured-hook-block.json is what the real, installed
// Claude Code did, recorded by scripts/hook-block-truth/capture.js (run by
// hand: it needs a real install, and uses a stand-in for the messages API, so
// no account is used and no model is called). Each case asked for one Bash
// call that writes a sentinel file, through a PreToolUse hook registered the
// way Rundock registers its own.
//
// This half runs in CI, which has no Claude Code. It holds the record to what
// it claims, and runs today's hook the way the capture ran it, so a hook that
// stops ending this way fails here rather than leaving the record describing
// a hook that no longer exists.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { UNATTENDED_NEXT } = require('../../scripts/refusal-notice.js');

const DIR = path.join(__dirname, '..', '..', 'scripts', 'hook-block-truth');
const RECORD = JSON.parse(fs.readFileSync(path.join(DIR, 'captured-hook-block.json'), 'utf8'));
const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const READER_GONE = path.join(DIR, 'reader-gone.js');
// What the hook says, in a routine, about a request it could not check.
const COULD_NOT_CHECK = `Rundock could not check this request, so it was refused rather than approved on your behalf. ${UNATTENDED_NEXT}`;
const PLAIN_REASON = 'Blocked by a hook that exited 2.';

const byName = (name) => {
  const found = RECORD.cases.find((c) => c.name === name);
  assert.ok(found, `the record has the case "${name}"`);
  return found.observed;
};
const READ = byName("Rundock's permission hook, its standard output read");
const GONE = byName("Rundock's permission hook, the reader of its standard output gone");
const EXIT_2 = byName('a hook that exits 2 with a reason on standard error');
const SILENT = byName('a hook that exits 0 with nothing on standard output');

describe('what Claude Code did, as recorded', () => {
  test('the record names the Claude Code it was taken from and how it was taken', () => {
    assert.ok(/^\d+\.\d+\.\d+$/.test(String(RECORD.runtimeVersion)), RECORD.runtimeVersion);
    assert.ok(RECORD.method.includes('print mode'), RECORD.method);
    assert.ok(RECORD.method.includes('No account was used and no model was called'), RECORD.method);
  });

  test("Rundock's hook, with a card approved and its standard output read, lets the call run", () => {
    assert.deepStrictEqual(READ.rundockAsked, ['POST /api/permission-request']);
    assert.strictEqual(READ.toolResult.isError, false);
    assert.strictEqual(READ.sentinelExists, true);
  });

  test('the same hook and the same approved card, with the reader of its standard output gone, ends in exit 2, and the call never runs', () => {
    assert.deepStrictEqual(GONE.rundockAsked, ['POST /api/permission-request'], 'the card was asked and approved, so the answer was an allow');
    assert.strictEqual(GONE.hookExitCode, 2);
    assert.strictEqual(GONE.hookStderr.trim(), COULD_NOT_CHECK);
    assert.strictEqual(GONE.sentinelExists, false, 'the sentinel was never written');
    assert.strictEqual(GONE.toolResult.isError, true);
    assert.ok(GONE.toolResult.text.includes(GONE.hookStderr.trim()), `the model was told why: ${GONE.toolResult.text}`);
  });

  test('a plain hook that exits 2 blocks the call, with its standard error as the reason', () => {
    assert.strictEqual(EXIT_2.sentinelExists, false);
    assert.strictEqual(EXIT_2.toolResult.isError, true);
    assert.ok(EXIT_2.toolResult.text.includes(PLAIN_REASON), EXIT_2.toolResult.text);
  });

  test('a hook that exits 0 with nothing on standard output, which is how the permission hook used to end when its answer could not be written, lets the call run', () => {
    assert.strictEqual(SILENT.sentinelExists, true);
    assert.strictEqual(SILENT.toolResult.isError, false);
  });

  test('every run of Claude Code itself ended normally, so no case is a CLI that failed to start', () => {
    for (const c of RECORD.cases) assert.strictEqual(c.observed.cliExitCode, 0, c.name);
  });
});

describe("today's hook ends the way the capture recorded", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-block-')));
  after(() => { fs.rmSync(root, { recursive: true, force: true }); });

  // The capture's stand-in for Rundock's server: every card approved.
  const approving = () => new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      req.resume();
      res.end(JSON.stringify(req.url.startsWith('/api/agent-notice') ? { text: '' } : { allow: true }));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  // The hook started as the capture started it, through reader-gone.js or
  // not, given the call the capture's stand-in asked for.
  const run = (port, readerGone) => new Promise((resolve) => {
    const args = readerGone ? [READER_GONE, process.execPath, HOOK] : [HOOK];
    const proc = spawn(process.execPath, args, {
      env: { ...process.env, NODE_V8_COVERAGE: '', NODE_OPTIONS: '', RUNDOCK: '1', RUNDOCK_PORT: String(port), RUNDOCK_WORKSPACE: root, RUNDOCK_CONVO_ID: '', RUNDOCK_CODE_MODE: '' },
    });
    const ending = setTimeout(() => proc.kill('SIGKILL'), 20000);
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.on('data', (c) => { err += c; });
    proc.on('close', (status) => { clearTimeout(ending); resolve({ status, stdout: out, stderr: err }); });
    proc.stdin.end(JSON.stringify({
      hook_event_name: 'PreToolUse', cwd: root, session_id: 's', tool_name: 'Bash',
      tool_input: { command: 'echo ran > sentinel.txt', description: 'write the sentinel' },
    }));
  });

  test('read as usual it allows the call; with the reader gone it exits 2, in the words the capture recorded reaching the model', async () => {
    const server = await approving();
    try {
      const port = server.address().port;
      const read = await run(port, false);
      assert.strictEqual(read.status, 0, read.stderr);
      assert.strictEqual(JSON.parse(read.stdout).hookSpecificOutput.permissionDecision, 'allow', read.stdout);
      const gone = await run(port, true);
      assert.strictEqual(gone.status, GONE.hookExitCode, gone.stderr);
      assert.strictEqual(gone.stdout, '');
      assert.strictEqual(gone.stderr, GONE.hookStderr);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("the capture's own folders", () => {
  // Loaded, not run: the capture runs only from its own command line.
  const { createRunRoot, caseFolders, removeRunRoot } = require('../../scripts/hook-block-truth/capture.js');
  const REPO = fs.realpathSync(path.join(__dirname, '..', '..'));
  // Whatever a failing run left is removed: a link as a link, a folder whole.
  const tidy = (p) => {
    let st = null;
    try { st = fs.lstatSync(p); } catch (e) { return; }
    if (st.isSymbolicLink()) fs.unlinkSync(p);
    else fs.rmSync(p, { recursive: true, force: true });
  };

  test('a run works in a folder made new for it, which only this user can open, outside the repository, and removes it at the end', (t) => {
    const run = createRunRoot();
    t.after(() => tidy(run));
    try {
      const real = fs.realpathSync(run);
      assert.ok(!real.startsWith(REPO + path.sep), `outside the repository: ${real}`);
      if (process.platform !== 'win32') assert.strictEqual(fs.statSync(run).mode & 0o777, 0o700);
      assert.deepStrictEqual(fs.readdirSync(run), []);
      const dirs = caseFolders(run, 0);
      for (const d of [dirs.workspace, dirs.aux, dirs.home, dirs.config, dirs.tmp]) {
        assert.ok(fs.realpathSync(d).startsWith(real + path.sep), d);
      }
      assert.throws(() => caseFolders(run, 0), { code: 'EEXIST' }, 'a case folder is made new, never cleared and used again');
    } finally {
      removeRunRoot(run);
    }
    assert.strictEqual(fs.existsSync(run), false);
  });

  // THE PLACE THE CAPTURE USED TO WORK, inside the repository, where anything
  // that can write there could leave a link to a folder elsewhere, which a
  // run then cleared and removed. A link is planted there, and at the run's
  // folder before it is removed, and what each leads to is left as it was.
  test("a link planted where the capture used to work, or in place of the run's folder, is never followed", (t) => {
    const old = path.join(REPO, '.rundock', 'scratch', 'hook-block-truth');
    let present = true;
    try { fs.lstatSync(old); } catch (e) { present = false; }
    assert.ok(!present, `${old} must not exist for this test to plant a link there`);
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-block-victim-'));
    const made = [];
    for (const d of [path.join(REPO, '.rundock'), path.join(REPO, '.rundock', 'scratch')]) {
      if (!fs.existsSync(d)) { fs.mkdirSync(d); made.unshift(d); }
    }
    t.after(() => {
      try { fs.unlinkSync(old); } catch (e) { /* not planted */ }
      for (const d of made) { try { fs.rmdirSync(d); } catch (e) { /* not empty: not ours alone */ } }
      fs.rmSync(victim, { recursive: true, force: true });
    });
    for (const d of ['case-0', 'case-1']) {
      fs.mkdirSync(path.join(victim, d));
      fs.writeFileSync(path.join(victim, d, 'keep.txt'), 'keep\n');
    }
    fs.writeFileSync(path.join(victim, 'keep.txt'), 'keep\n');
    const listing = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();
    const before = listing(victim);
    fs.symlinkSync(victim, old, 'dir');

    const run = createRunRoot();
    const moved = `${run}-moved`;
    t.after(() => { tidy(run); tidy(moved); });
    caseFolders(run, 0);
    caseFolders(run, 1);
    assert.deepStrictEqual(listing(victim), before, 'nothing was made or cleared through the link');
    // The run's folder swapped for a link to the same place before it is
    // removed: the link goes, and what it led to stays.
    fs.renameSync(run, moved);
    fs.symlinkSync(victim, run, 'dir');
    removeRunRoot(run);
    assert.strictEqual(fs.existsSync(run), false);
    assert.deepStrictEqual(listing(victim), before, 'nothing was removed through either link');
  });
});
