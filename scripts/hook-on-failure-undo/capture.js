#!/usr/bin/env node
'use strict';
// WHAT AN EARLIER RELEASE LEAVES IN A SETTINGS FILE THIS ONE WROTE, CAPTURED.
//
// Every PreToolUse entry Rundock writes now carries "onFailure": "block". A
// person who goes back to an earlier release and then forward again has had
// the workspace opened by both, and what the earlier release does with a field
// it never wrote is a fact about that release's code. So it is captured from
// that code: this script takes the v0.15.7 release's own files from its git
// tag, and runs its scaffold on a workspace this checkout's scaffold has just
// written, and on a new workspace. What the release leaves on disk is the
// record, captured-earlier-release.json, beside this script.
// test/unit/hook-on-failure.test.js reopens that record with this release.
//
// HOW IT RUNS. Everything happens inside one folder made new for the run,
// private to this user and outside the repository, which is removed
// afterwards. The release's files come out of `git archive` into it. Each
// scaffold runs in a node process of its own, with HOME and TMPDIR pointed at
// fresh folders inside the run's folder, so neither reads or writes anything
// of this machine's. Both run as they would on Linux (the platform seam
// scaffoldWorkspace takes), which writes no sandbox block: that block carries
// this machine's home and temporary folders, and the hook entries under test
// are written the same way on every platform that starts the hook with sh.
// The workspace's path is written as <workspace>, and a record that would
// still carry one of this machine's names is refused rather than written.
//
// RUN BY HAND, NEVER BY THE SUITE OR CI: it needs the repository's tags, which
// a shallow clone does not have, and git and tar on PATH. It is not a
// *.test.js file, so `npm test` does not collect it.
//
//   node scripts/hook-on-failure-undo/capture.js           capture, compare with the record
//   node scripts/hook-on-failure-undo/capture.js --write   capture, and write the record
//
// Exits 0 when the capture matches the record (or was written), 1 otherwise.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const RECORD = path.join(__dirname, 'captured-earlier-release.json');
const RELEASE = 'v0.15.7';
const PLATFORM = 'linux';
const WORKSPACE = '<workspace>';
// What the release's scaffold needs to run: its code (some of it under public/,
// shared with the browser), the files it copies into a workspace, and its
// package.json.
const RELEASE_PATHS = ['lib', 'scripts', 'scaffold', 'public', 'package.json'];

// Run one checkout's scaffold on the workspace, the way a workspace open does.
const OPEN = [
  "const scaffold = require(require('node:path').join(process.argv[1], 'lib', 'workspace', 'scaffold.js'));",
  'scaffold.wireScaffoldDeps({ invalidateAgentCache() {}, rebaselineAgentsWatcher() {} });',
  "scaffold.scaffoldWorkspace(process.argv[2], { platform: process.argv[3] });",
  "process.stdout.write(`\\nran ${require(require('node:path').join(process.argv[1], 'package.json')).version}\\n`);",
].join('\n');

function open(code, workspace, env) {
  const run = spawnSync(process.execPath, ['-e', OPEN, code, workspace, PLATFORM], { env, cwd: path.dirname(workspace), encoding: 'utf8' });
  // scaffoldWorkspace logs its own failure, as a warning, rather than throwing it.
  if (run.status !== 0 || /scaffold failed/.test(run.stderr)) throw new Error(`the scaffold in ${code} failed: ${run.stderr.trim()}`);
  return /\nran (\S+)\n$/.exec(run.stdout)[1];
}

function release(runRoot) {
  const dest = path.join(runRoot, RELEASE);
  const tar = path.join(runRoot, `${RELEASE}.tar`);
  fs.mkdirSync(dest);
  execFileSync('git', ['-C', ROOT, 'archive', '--format=tar', '-o', tar, RELEASE, ...RELEASE_PATHS]);
  execFileSync('tar', ['-xf', tar, '-C', dest]);
  fs.rmSync(tar);
  return dest;
}

function capture() {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-undo-'));
  try {
    const workspace = path.join(runRoot, 'workspace');
    const fresh = path.join(runRoot, 'fresh');
    const home = path.join(runRoot, 'home');
    const tmp = path.join(runRoot, 'tmp');
    for (const d of [workspace, fresh, home, tmp]) fs.mkdirSync(d);
    const env = { PATH: process.env.PATH, HOME: home, TMPDIR: tmp, NODE_PATH: path.join(ROOT, 'node_modules') };
    const forms = [...new Set([workspace, fresh].flatMap((d) => [d, fs.realpathSync(d)]))].sort((a, b) => b.length - a.length);
    const settings = (dir) => fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8');
    const scrub = (text) => JSON.parse(forms.reduce((acc, f) => acc.split(f).join(WORKSPACE), text));
    const code = release(runRoot);
    open(ROOT, workspace, env);
    const before = settings(workspace);
    const ran = open(code, workspace, env);
    const after = settings(workspace);
    if (`v${ran}` !== RELEASE) throw new Error(`the archive ran ${ran}, not ${RELEASE}`);
    open(code, fresh, env);
    return { written: scrub(before), left: scrub(after), rewrote: after !== before, created: scrub(settings(fresh)) };
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
}

// Names of this machine that must never reach a committed file.
function leaks(text) {
  const names = [os.homedir(), os.tmpdir(), fs.realpathSync(os.tmpdir()), os.hostname(), os.userInfo().username, ROOT]
    .filter((n) => n && n.length > 2);
  const found = names.filter((n) => text.includes(n));
  for (const re of [/\/Users\//, /\/home\//, /\/private\//, /\/var\/folders\//, /\/tmp\//, /[A-Z]:\\/, /[\u2013\u2014]/]) {
    if (re.test(text)) found.push(String(re));
  }
  return found;
}

function main() {
  const write = process.argv.includes('--write');
  const { written, left, rewrote, created } = capture();
  const record = {
    about: `What the ${RELEASE} release leaves in .claude/settings.local.json when it opens a workspace a later release wrote, captured from that release's own code by scripts/hook-on-failure-undo/capture.js. test/unit/hook-on-failure.test.js reopens it with this release.`,
    release: RELEASE,
    regenerate: 'node scripts/hook-on-failure-undo/capture.js --write, in a clone that has the release tags',
    method: `This checkout's scaffold opened a new workspace and wrote the settings file ("written"). The ${RELEASE} release's files, taken from its git tag with git archive, then opened the same workspace with that release's own scaffold ("leftByRelease"), and opened a second, new workspace ("createdByRelease"). Each open ran in a node process of its own, as a workspace open runs it (scaffoldWorkspace), with the platform given as ${PLATFORM} and HOME and TMPDIR set to fresh, empty folders. The workspace's path is written as ${WORKSPACE}.`,
    platform: PLATFORM,
    releaseChangedTheFile: rewrote,
    written,
    leftByRelease: left,
    createdByRelease: created,
  };
  const body = `${JSON.stringify(record, null, 2)}\n`;
  const found = leaks(body);
  if (found.length) {
    process.stderr.write(`[undo] refusing: the record would carry ${found.join(', ')}\n`);
    process.exit(1);
  }
  if (write) {
    fs.writeFileSync(RECORD, body);
    process.stderr.write(`[undo] wrote ${path.relative(ROOT, RECORD)} from ${RELEASE}\n`);
    return;
  }
  process.stdout.write(body);
  const committed = fs.existsSync(RECORD) ? fs.readFileSync(RECORD, 'utf8') : null;
  const same = committed === body;
  process.stderr.write(same
    ? `[undo] ${RELEASE} matches the record\n`
    : `[undo] the capture differs from the record: run with --write and read the diff\n`);
  process.exit(same ? 0 : 1);
}

if (require.main === module) {
  try { main(); } catch (e) {
    process.stderr.write(`[undo] ${e.stack || e.message}\n`);
    process.exit(1);
  }
}
