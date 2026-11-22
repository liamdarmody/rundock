'use strict';
// Takes the TAP the prove workflow's classifier is tested on.
//
// Each capture runs one test from a fixture in this directory the way the
// workflow runs a blocker test: `node --test` with the TAP reporter, the
// preloads `npm test` uses, and the test's name escaped and anchored as the
// name pattern. The TAP is read from the run's standard output through a
// pipe, as the workflow reads it, and kept with every absolute path to the
// repository (plain or as a file URL) made relative to it. A capture that
// still holds a home directory is refused rather than written.
//
// The workflow pins Node to one exact version, and the reporter's output can
// change between versions, so captures are taken only on that version.
//
//   node test/fixtures/prove/capture.js
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..', '..');
const OUT = path.join(__dirname, 'tap');
const HERE = path.relative(ROOT, __dirname).split(path.sep).join('/');

// The Node the workflow's jobs run, and so the only one captures come from.
const NODE_VERSION = 'v24.12.0';

// The same flags the workflow's `run the test` step passes.
const FLAGS = '--test --test-reporter=tap --require ./test/helpers/account-home-refused.js --require ./test/helpers/stall-guard.js';
const escape = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every spelling of the repository's own path, longest first, so a file URL
// is rewritten before the plain path inside it.
function relative(text) {
  const roots = [...new Set([path.resolve(ROOT), fs.realpathSync(ROOT)])];
  const spellings = roots.flatMap((r) => [pathToFileURL(r).href + '/', r + path.sep, pathToFileURL(r).href, r]);
  let out = text;
  for (const s of spellings.sort((a, b) => b.length - a.length)) out = out.split(s).join(s.endsWith('/') ? '' : '.');
  return out;
}

function run(file, name) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const args = [...FLAGS.split(' '), '--test-name-pattern', `^${escape(name)}$`, `${HERE}/${file}`];
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status, tap: relative(result.stdout) };
}

function write(slug, tap) {
  for (const home of [['', 'Users', ''].join('/'), ['', 'home', ''].join('/')]) {
    if (tap.includes(home)) throw new Error(`${slug}: the capture still holds ${home}, so it is not written`);
  }
  fs.writeFileSync(path.join(OUT, `${slug}.tap`), tap);
  process.stdout.write(`captured ${slug}\n`);
}

const CASES = [
  ['assertion-failure', 'cases.js', 'an assertion fails'],
  ['subtest-assertion-failure', 'cases.js', 'a subtest assertion fails'],
  ['load-error', 'load-error.js', 'an assertion fails'],
  ['non-assertion-error', 'cases.js', 'a non-assertion error is thrown'],
  ['pass', 'cases.js', 'the test passes'],
  ['awkward-name', 'cases.js', 'a name with # and \\ in it passes'],
  ['timeout', 'cases.js', 'the test times out'],
  ['missing-module', 'cases.js', 'a module is missing'],
  ['skipped', 'cases.js', 'the test is skipped'],
  ['todo', 'cases.js', 'the test is todo'],
  ['none-selected', 'cases.js', 'no test has this name'],
  ['two-selected', 'cases.js', 'two tests share this name'],
  ['nested-by-full-name', 'cases.js', 'a suite holds a nested test'],
  ['blocker-top', 'blocker-top.js', 'blocker'],
  ['blocker-nested', 'blocker-nested.js', 'blocker'],
];

function main() {
  if (process.version !== NODE_VERSION) {
    throw new Error(`captures are taken on Node ${NODE_VERSION}, the version the workflow runs, not on ${process.version}`);
  }
  fs.mkdirSync(OUT, { recursive: true });
  for (const [slug, file, name] of CASES) write(slug, run(file, name).tap);

  // A test that passes on one run and fails on two: run it until both kinds
  // have been seen, then keep one pass and two failures.
  const passes = [];
  const failures = [];
  for (let n = 0; n < 60 && (passes.length < 1 || failures.length < 2); n++) {
    const r = run('varies.js', 'the result varies between runs');
    (r.status === 0 ? passes : failures).push(r.tap);
  }
  if (passes.length < 1 || failures.length < 2) throw new Error('the varying test never gave one pass and two failures');
  write('mixed-1', passes[0]);
  write('mixed-2', failures[0]);
  write('mixed-3', failures[1]);
}

if (require.main === module) main();

module.exports = { CASES, FLAGS, NODE_VERSION, relative };
