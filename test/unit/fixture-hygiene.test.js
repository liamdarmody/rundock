'use strict';
// The suite must not leave its fixtures on the disk.
//
// WHY THIS FILE EXISTS
//
// A suite run used to leave 160 directories and 103 MB under the system temp
// root, and nothing ever removed them, so every run of anything added to the
// pile permanently. A day of builds reached 10,087 directories by one
// measurement and 20,708 four hours later. The disk hit 100 percent twice.
//
// The expensive part was not the disk. Two mutation runs reported 293 and 32
// tests red that were out-of-space rather than guards nobody was watching, so
// the instrument that exists to say whether a guard is real reported numbers
// that looked exactly like work to do. That is why this is a test and not a
// note: a leak nobody counts comes back the first time somebody adds a test
// file, and the file that reintroduces it will look like every other one.
//
// HOW THESE STAY MACHINE-INDEPENDENT
//
// Nothing here reads or writes the real system temp root. Every case gets its
// own directory and passes it to the child as TMPDIR, which is what
// `os.tmpdir()` reads, so counting is a count of what this test caused and
// nothing else. Ages are injected rather than slept for.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { countRoots, listRoots, sweepStale, preflight, PREFIX } = require('../helpers/temp-root.js');

const REPO = path.join(__dirname, '..', '..');
const HELPER = path.join(REPO, 'test', 'helpers', 'workspace.js');

// A scratch temp root for one case, removed when the case ends.
function scratch(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fixture-hygiene-${label}-`));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });
  return dir;
}

// The child env for any run that must land its fixtures in `tmpRoot`.
//
// NODE_TEST_CONTEXT is deleted deliberately. A nested `node --test` that
// inherits it prints its failures and still exits 0, so a child suite that
// should be red comes back green, and every count below would be measured on a
// run that never really happened.
function childEnv(tmpRoot) {
  const env = { ...process.env, TMPDIR: tmpRoot, TEMP: tmpRoot, TMP: tmpRoot };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// A pid that is certainly not running.
//
// NOT a large literal like 999999. That is a guess about the machine: Linux
// allows pids up to 4194304, so the guess can name a live process on a busy
// host and the test would then assert the opposite of what it means. Spawning
// something and letting it exit is the only way to know.
function deadPid() {
  const kid = spawnSync(process.execPath, ['-e', '0']);
  assert.ok(kid.pid, 'could not start a throwaway process to retire');
  return kid.pid;
}

// A child that builds one fixture, prints where it went, then does as it is told.
function fixtureMaker(after) {
  return `const { makeWorkspace } = require(${JSON.stringify(HELPER)});\n`
    + 'process.stdout.write(makeWorkspace({ claudeMd: "# fixture\\n" }) + "\\n");\n'
    + after;
}

// Start a fixture-making child and resolve once it has told us where its
// fixture is, so a kill below lands after the directory exists rather than
// racing it.
function startMaker(tmpRoot, after) {
  return new Promise((resolve, reject) => {
    const kid = spawn(process.execPath, ['-e', fixtureMaker(after)],
      { cwd: REPO, env: childEnv(tmpRoot), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const exited = new Promise((done) => kid.on('close', (code, signal) => done({ code, signal })));
    kid.stderr.on('data', (b) => { err += b.toString(); });
    kid.stdout.on('data', (b) => {
      out += b.toString();
      const line = out.split('\n')[0];
      if (out.includes('\n')) resolve({ kid, fixture: line, exited, stderr: () => err });
    });
    kid.on('error', reject);
    kid.on('close', () => { if (!out.includes('\n')) reject(new Error(`child made no fixture: ${err}`)); });
  });
}

describe('the suite owns the fixtures it creates', () => {
  // THE COUNTING PROOF the card asks for.
  //
  // A SUBSET of the suite, and the reason it generalises is the mechanism
  // rather than the sample: removal is owned by the process that made the
  // root, so it does not depend on which file ran inside it. The three chosen
  // cover both halves of the old behaviour, which was opt-in per file: two
  // that never wired the opt-in and leaked, and one that did and did not.
  //
  // A subset is also the only option available. The full suite takes 39
  // seconds and this test runs inside it, so running it here would not
  // terminate.
  test('a run leaves no fixture directory behind, counted before and after', async (t) => {
    const tmpRoot = scratch(t, 'count');
    const files = [
      'test/integration/ws-handler-edges.test.js',   // leaked 5, never wired cleanup
      'test/integration/workspace-picker.test.js',   // leaked 3, never wired cleanup
      'test/unit/workspace-lib.test.js',             // wired after(cleanup), leaked 0
    ];

    const before = countRoots(tmpRoot);
    assert.equal(before, 0, 'the scratch temp root should start empty');

    const run = spawnSync(process.execPath, ['--test', ...files],
      { cwd: REPO, env: childEnv(tmpRoot), encoding: 'utf8', timeout: 120000 });

    // A run that failed for its own reasons cannot say anything about
    // cleanliness, and reporting its zero as proof would be the same mistake
    // this card is about.
    assert.equal(run.status, 0,
      `the child suite must pass before its leftovers mean anything:\n${run.stdout}\n${run.stderr}`);
    assert.ok(!/ENOSPC|no space left on device/i.test(`${run.stdout}${run.stderr}`),
      'the child suite hit an out-of-space error, so its result is not trustworthy');

    const after = countRoots(tmpRoot);
    const leftover = listRoots(tmpRoot).map((r) => r.name);
    assert.equal(after, 0,
      `before ${before}, after ${after}. Left behind: ${leftover.join(', ') || '(none)'}`);
  });

  test('a fixture is removed by the process that created it, on ordinary exit', async (t) => {
    const tmpRoot = scratch(t, 'exit');
    const { exited } = await startMaker(tmpRoot, '');
    await exited;
    assert.equal(countRoots(tmpRoot), 0, 'a clean exit should leave nothing');
  });

  test('a run that throws still removes its fixtures', async (t) => {
    const tmpRoot = scratch(t, 'throw');
    const { exited } = await startMaker(tmpRoot, 'throw new Error("the test blew up");\n');
    const { code } = await exited;
    assert.notEqual(code, 0, 'the child was supposed to die of its own error');
    assert.equal(countRoots(tmpRoot), 0, 'an uncaught throw should still leave nothing');
  });

  // THE INTERRUPTION THIS COVERS AT THE MOMENT IT HAPPENS.
  test('a run interrupted by SIGTERM removes its fixtures before it goes', async (t) => {
    const tmpRoot = scratch(t, 'sigterm');
    const { kid, exited } = await startMaker(tmpRoot, 'setInterval(() => {}, 1000);\n');
    assert.equal(countRoots(tmpRoot), 1, 'the child should have made exactly one root');
    kid.kill('SIGTERM');
    await exited;
    assert.equal(countRoots(tmpRoot), 0, 'SIGTERM should leave nothing');
  });

  test('a run interrupted by SIGINT removes its fixtures before it goes', async (t) => {
    const tmpRoot = scratch(t, 'sigint');
    const { kid, exited } = await startMaker(tmpRoot, 'setInterval(() => {}, 1000);\n');
    kid.kill('SIGINT');
    await exited;
    assert.equal(countRoots(tmpRoot), 0, 'SIGINT should leave nothing');
  });

  // THE INTERRUPTION NOTHING IN-PROCESS CAN COVER, stated as a test rather
  // than as a caveat in a comment, so the boundary is checked and not claimed.
  //
  // SIGKILL runs no handler, so the fixture survives the death by necessity.
  // What must not survive is ACCUMULATION: the next run finds a root whose
  // owning pid is gone and finishes the job. That is the whole reason the pid
  // is in the directory name.
  test('SIGKILL leaves one root behind, and the next run is what removes it', async (t) => {
    const tmpRoot = scratch(t, 'sigkill');
    const { kid, exited } = await startMaker(tmpRoot, 'setInterval(() => {}, 1000);\n');
    kid.kill('SIGKILL');
    const { signal } = await exited;
    assert.equal(signal, 'SIGKILL', 'the child was supposed to be killed outright');
    assert.equal(countRoots(tmpRoot), 1,
      'a killed process runs no handler, so its root survives: this is the mode that is not covered');

    // Any later run, even one that builds nothing, tidies it.
    const next = spawnSync(process.execPath,
      ['-e', `require(${JSON.stringify(HELPER)});`],
      { cwd: REPO, env: childEnv(tmpRoot), encoding: 'utf8' });
    assert.equal(next.status, 0, next.stderr);
    assert.equal(countRoots(tmpRoot), 0,
      'the next run should have swept the root whose owner is gone');
  });

  test('repeated kills do not accumulate', async (t) => {
    const tmpRoot = scratch(t, 'repeat');
    for (let i = 0; i < 3; i++) {
      const { kid, exited } = await startMaker(tmpRoot, 'setInterval(() => {}, 1000);\n');
      kid.kill('SIGKILL');
      await exited;
      assert.ok(countRoots(tmpRoot) <= 1,
        `after kill ${i + 1} the root count should never exceed one, got ${countRoots(tmpRoot)}`);
    }
  });
});

describe('sweeping leftovers from runs that never got to tidy up', () => {
  test('a root owned by a live process is never swept', (t) => {
    const tmpRoot = scratch(t, 'live');
    const mine = path.join(tmpRoot, `${PREFIX}p${process.pid}-alive`);
    const dead = path.join(tmpRoot, `${PREFIX}p${deadPid()}-gone`);
    fs.mkdirSync(mine);
    fs.mkdirSync(dead);

    const { removed, kept } = sweepStale(tmpRoot);
    assert.deepEqual(kept, [path.basename(mine)]);
    assert.deepEqual(removed, [path.basename(dead)]);
    assert.ok(fs.existsSync(mine), 'a live process must keep its own fixtures');
  });

  test('a root in the old un-owned shape is swept once it is older than the window', (t) => {
    const tmpRoot = scratch(t, 'legacy');
    const legacy = path.join(tmpRoot, `${PREFIX}AbCdEf`);
    fs.mkdirSync(legacy);
    const mtime = fs.statSync(legacy).mtimeMs;

    // Fresh: a pre-fix suite could still be running in another checkout.
    const fresh = sweepStale(tmpRoot, { now: mtime + 1000, legacyStaleAfterMs: 60000 });
    assert.deepEqual(fresh.removed, [], 'a young un-owned root is left alone');
    assert.ok(fs.existsSync(legacy));

    // Old: nothing is coming back for it.
    const old = sweepStale(tmpRoot, { now: mtime + 120000, legacyStaleAfterMs: 60000 });
    assert.deepEqual(old.removed, [path.basename(legacy)]);
    assert.ok(!fs.existsSync(legacy));
  });

  test('directories that are not fixtures are never touched', (t) => {
    const tmpRoot = scratch(t, 'bystanders');
    const bystander = path.join(tmpRoot, 'something-else-entirely');
    fs.mkdirSync(bystander);
    const { removed } = sweepStale(tmpRoot, { now: Date.now() + 1e9 });
    assert.deepEqual(removed, []);
    assert.ok(fs.existsSync(bystander), 'the sweep must only ever remove its own prefix');
  });
});

describe('a mutation harness refuses to start on a machine that would misreport', () => {
  test('it proceeds when the temp root is sane', (t) => {
    const tmpRoot = scratch(t, 'sane');
    fs.mkdirSync(path.join(tmpRoot, `${PREFIX}p${process.pid}-mine`));
    const verdict = preflight(tmpRoot, { limit: 100 });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.count, 1);
    assert.equal(verdict.message, null);
  });

  test('it sweeps first, so a machine dirtied by earlier runs repairs itself', (t) => {
    const tmpRoot = scratch(t, 'repairs');
    const gone = deadPid();
    for (let i = 0; i < 12; i++) fs.mkdirSync(path.join(tmpRoot, `${PREFIX}p${gone}-gone${i}`));
    const verdict = preflight(tmpRoot, { limit: 5 });
    assert.equal(verdict.swept, 12);
    assert.equal(verdict.count, 0);
    assert.equal(verdict.ok, true, 'roots whose owners are gone are not a reason to stop');
  });

  test('it refuses when roots it cannot account for are still there', (t) => {
    const tmpRoot = scratch(t, 'refuses');
    for (let i = 0; i < 7; i++) fs.mkdirSync(path.join(tmpRoot, `${PREFIX}p${process.pid}-live${i}`));
    const verdict = preflight(tmpRoot, { limit: 5 });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.count, 7);
    // The message has to be actionable on its own, because the person reading
    // it is looking at a stopped harness and nothing else.
    assert.match(verdict.message, /7/, 'the message names how many were found');
    assert.match(verdict.message, /5/, 'the message names the ceiling');
    assert.ok(verdict.message.includes(tmpRoot), 'the message names where to look');
    assert.match(verdict.message, /rm -rf/, 'the message says how to clear it');
  });

  // DRIVEN, NOT GREPPED. The first version of this read the harness sources
  // for a `preflight(` call. That version stayed green when the call was
  // deleted from the entry point, because the word survived in the function
  // the entry point no longer reached: a test asserting the shape of the fix
  // rather than the property it exists for. Each harness is started here for
  // real, on a temp root it must refuse.
  //
  // Named individually rather than globbed, so a harness added later fails
  // this by absence instead of being silently included and excused.
  for (const rel of [
    'test/tools/mutate-render-guards.js',
    'test/tools/mutate-routine-editor-guards.js',
    'test/tools/mutate-routines-guards.js',
  ]) {
    test(`${path.basename(rel)} refuses to run on a temp root full of fixtures`, (t) => {
      const tmpRoot = scratch(t, 'harness');
      // Owned by this process, so the harness's own sweep cannot clear them
      // and the refusal is the only way out.
      for (let i = 0; i <= 100; i++) {
        fs.mkdirSync(path.join(tmpRoot, `${PREFIX}p${process.pid}-crowd${i}`));
      }
      // --preflight-only, and the reason is worth stating. Without it the only
      // way to observe a MISSING preflight is to let the harness start
      // mutating and then kill it, which skips its restore and leaves a source
      // file mutated in the working tree on every red run. Measured: doing it
      // that way left three mutated files behind. The flag is read AFTER the
      // preflight call, so a harness that has lost its check exits 0 here and
      // this still goes red.
      const run = spawnSync(process.execPath, [rel, '--preflight-only'],
        { cwd: REPO, env: childEnv(tmpRoot), encoding: 'utf8', timeout: 30000 });
      assert.equal(run.status, 2,
        `${rel} should refuse with exit 2, got ${run.status}. Output:\n${run.stdout}\n${run.stderr}`);
      assert.match(run.stderr, /Refusing to start/, `${rel} refused without saying why`);
    });
  }
});
