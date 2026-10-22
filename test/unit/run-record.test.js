'use strict';
// The record a long run keeps in the checkout while it runs.
//
// A record left behind by a run that has gone reads as a run still going the
// moment its pid is reused, and the check made before a change is reported
// done then points at an unrelated process. So the record goes on every way
// out a process can see: an ordinary exit and the three signals that ask it
// to stop.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { recordRun, readRuns, RUN_DIR } = require('../../scripts/lib/run-record.js');
const { makeTempDir } = require('../helpers/workspace.js');

const MODULE = path.join(__dirname, '..', '..', 'scripts', 'lib', 'run-record.js');

function waitFor(predicate, ms = 10000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = () => (predicate() || Date.now() > deadline ? resolve(predicate()) : setTimeout(tick, 25));
    tick();
  });
}

function scratch(t) {
  const root = makeTempDir('run-record-');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } });
  return root;
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(`${signal} removes the record, and the run still dies of ${signal}`, async (t) => {
    const root = scratch(t);
    const kid = spawn(process.execPath, ['-e', `require(${JSON.stringify(MODULE)}).recordRun(${JSON.stringify(root)}, 'a long run');
      process.stdout.write('ready\\n'); setTimeout(() => {}, 60000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
    t.after(() => { try { kid.kill('SIGKILL'); } catch { /* gone */ } });
    const exited = new Promise((resolve) => kid.on('exit', (code, sig) => resolve({ code, sig })));
    let out = '';
    kid.stdout.on('data', (b) => { out += b; });
    assert.ok(await waitFor(() => out.includes('ready')), 'the run started');
    assert.strictEqual(readRuns(root).length, 1, 'and recorded itself');
    kid.kill(signal);
    const how = await Promise.race([exited, new Promise((r) => setTimeout(() => r({ timedOut: true }), 10000))]);
    assert.strictEqual(how.sig, signal, `it died of ${signal}, so whatever drove it sees why`);
    assert.deepStrictEqual(fs.readdirSync(path.join(root, RUN_DIR)), [], 'and its record is gone');
  });
}

test('an ordinary exit removes the record', (t) => {
  const root = scratch(t);
  const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(MODULE)}).recordRun(${JSON.stringify(root)}, 'a short run');`]);
  assert.strictEqual(r.status, 0);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, RUN_DIR)), []);
});

test('a record whose process has gone is read as not alive, and swept by the next run', (t) => {
  const root = scratch(t);
  const gone = spawnSync(process.execPath, ['-e', '']).pid;
  fs.mkdirSync(path.join(root, RUN_DIR));
  fs.writeFileSync(path.join(root, RUN_DIR, `${gone}.json`), JSON.stringify({ pid: gone, what: 'a killed run' }));
  assert.strictEqual(readRuns(root)[0].alive, false);
  const run = recordRun(root, 'this run');
  t.after(() => run.release());
  assert.deepStrictEqual(readRuns(root).map((r) => r.what), ['this run']);
});

test('a record can name the process group a run started, and is alive while that group is', (t) => {
  // A run killed outright can leave its suite running in a group of its own;
  // the record says so, so a check reads the run as still going.
  const root = scratch(t);
  const run = recordRun(root, 'a run with a suite');
  t.after(() => run.release());
  const suite = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-suite.pid, 'SIGKILL'); } catch { /* gone */ } });
  run.update({ group: suite.pid });
  const gone = spawnSync(process.execPath, ['-e', '']).pid;
  const file = path.join(root, RUN_DIR, `${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), pid: gone }));
  const [record] = readRuns(root);
  assert.strictEqual(record.group, suite.pid);
  assert.strictEqual(record.alive, true, 'its pid is gone, but its group is not');
});

test('a kept record outlives the run that kept it', (t) => {
  const root = scratch(t);
  const r = spawnSync(process.execPath, ['-e', `const run = require(${JSON.stringify(MODULE)}).recordRun(${JSON.stringify(root)}, 'a run that left a survivor'); run.keep();`]);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.readdirSync(path.join(root, RUN_DIR)).length, 1);
});
