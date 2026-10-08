#!/usr/bin/env node
'use strict';

/**
 * Release gate: what CI cannot do, on the exact tree being released.
 *
 * Why it exists: 0.11.6 took six cuts because candidate testing happened
 * AFTER tagging. The gate inverts the train: the candidate is proven first, and
 * `scripts/release.js` refuses to tag a tree the gate has not passed.
 *
 * WHAT COMES FROM CI. The suite on Node 22 and 24, coverage with its floors,
 * the browser suite, typecheck and hygiene are required checks in
 * `.github/workflows/ci.yml`. The gate does not run them again: it asks GitHub
 * for CI's results on the exact tree it gates and refuses, naming the check,
 * unless each passed there (see scripts/release-ci.js). Re-running them here
 * took most of the gate's time and failed on a loaded laptop for reasons
 * unrelated to the change.
 *
 * WHAT RUNS HERE is what CI cannot: the runtime truth captures (they need the
 * real CLI and a sign-in), the Electron steps (CI runs no Electron), the
 * case-insensitive disk and volume checks (macOS disks), smoke and personas
 * against the stub and the live runtime, the release walk (a real browser and
 * GitHub), and the packaged build's boot.
 *
 * THE RECORD NAMES A TREE. `.release-gate.json` records the tree the gate
 * passed on, so a merge that makes a new commit with the same content needs no
 * second gate, and `release -- tag` accepts the record exactly when the merged
 * commit's tree is that tree.
 *
 * THE CANDIDATE CARRIES ITS OWN VERSION. package.json is exactly one release
 * past the latest tag (the next patch, minor or major) and CHANGELOG.md's top
 * heading names that version. A recut (delete the unpublished draft and tag,
 * fix, re-tag) needs nothing special: once the tag is deleted the candidate is
 * one step past the tag before it again.
 *
 * Usage:
 *   npm run release:gate              # the gate a release needs
 *   npm run release:gate -- --no-live # development of the gate only: no live
 *                                     # smoke, and release.js refuses the record
 *   npm run release:gate -- --no-ci   # development of the gate only: CI is not
 *                                     # asked, and release.js refuses the record
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const { ciVerdict } = require('./release-ci.js');

const ROOT = path.join(__dirname, '..');
const GATE_FILE_NAME = '.release-gate.json';

// ---------------------------------------------------------------------------
// Preconditions (pure, unit-tested)
// ---------------------------------------------------------------------------

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

// The versions one release past `latestTag`: the next patch, minor and major.
function nextVersions(latestTag) {
  const m = SEMVER.exec(String(latestTag || '').replace(/^v/, '').trim());
  if (!m) throw new Error(`The latest tag "${latestTag}" is not vMAJOR.MINOR.PATCH.`);
  const [maj, min, pat] = m.slice(1).map(Number);
  return [`${maj}.${min}.${pat + 1}`, `${maj}.${min + 1}.0`, `${maj + 1}.0.0`];
}

// The candidate carries its own bump: package.json is one release past the
// latest tag, and the changelog's top heading names it, with notes under it.
function candidateVersion(pkgVersion, latestTag, changelogText) {
  if (!SEMVER.test(pkgVersion || '')) {
    throw new Error(`package.json version "${pkgVersion}" is not plain semver MAJOR.MINOR.PATCH.`);
  }
  const allowed = nextVersions(latestTag);
  if (!allowed.includes(pkgVersion)) {
    const tagged = String(latestTag).replace(/^v/, '').trim();
    throw new Error(
      `package.json is ${pkgVersion} but the latest tag is ${latestTag}: a release candidate carries the next version, ` +
      `one of ${allowed.join(', ')}. Run "npm run release -- bump <version>" and commit it with the candidate.` +
      (pkgVersion === tagged ? ` If this is a recut of an unpublished ${latestTag}, delete that tag here too ("git tag -d ${latestTag}").` : '')
    );
  }
  const lines = String(changelogText).split('\n');
  const top = lines.findIndex((l) => l.startsWith('## '));
  if (top === -1 || !lines[top].startsWith(`## ${pkgVersion}:`)) {
    throw new Error(
      `CHANGELOG.md's top heading is "${top === -1 ? 'none' : lines[top]}", not "## ${pkgVersion}: <Name> (<date>)". ` +
      `Promote the notes with "npm run release -- bump ${pkgVersion}".`
    );
  }
  let end = lines.length;
  for (let i = top + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { end = i; break; }
  }
  if (!lines.slice(top + 1, end).join('\n').trim()) {
    throw new Error(`The ${pkgVersion} section of CHANGELOG.md is empty. Release notes are content, not a heading.`);
  }
}

// ---------------------------------------------------------------------------
// The smoke ports
// ---------------------------------------------------------------------------

// The ports the smoke and persona steps bind, read the way those scripts read
// them (scripts/smoke/run.mjs, scripts/smoke/personas.mjs: three servers).
function smokePorts(env = process.env) {
  const smoke = Number(env.SMOKE_PORT || 3641);
  const personas = Number(env.SMOKE_PORT || 3651);
  return [...new Set([smoke, personas, personas + 1, personas + 2])];
}

// Resolves true when nothing can be bound on 127.0.0.1:port, which is where
// the server under test listens.
function portBusy(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => server.close(() => resolve(false)));
    server.listen(port, '127.0.0.1');
  });
}

// "pid 123 (node)" for each process listening on `port`, from lsof.
function portHolders(port, exec) {
  let out = '';
  try {
    out = String(exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']));
  } catch {
    return [];
  }
  const holders = [];
  let pid = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = line.slice(1);
    else if (line.startsWith('c') && pid) holders.push(`pid ${pid} (${line.slice(1)})`);
  }
  return holders;
}

// Before any step: a port the smoke steps need that is already held fails the
// gate now, naming who holds it, instead of as EADDRINUSE minutes later.
async function requireSmokePortsFree({ ports = smokePorts(), busy = portBusy, exec } = {}) {
  const held = [];
  for (const port of ports) {
    if (await busy(port)) {
      const who = portHolders(port, exec);
      held.push(`${port} is held by ${who.length ? who.join(', ') : 'a process lsof cannot name (another user?)'}`);
    }
  }
  if (held.length) {
    throw new Error(
      `The smoke steps need ports that are already in use:\n  ${held.join('\n  ')}\n` +
      '  Stop those processes (or set SMOKE_PORT to a free range) and run the gate again.'
    );
  }
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

function defaultExec(cmd, args = []) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function buildSteps(live) {
  const steps = [
    // Fails fast if the installed runtime has moved past the committed
    // stream capture, or the stub has drifted from it: no candidate gets
    // validated against a stale model of the stream. Needs the real CLI.
    { name: 'stream truth', cmd: ['npm', ['run', 'stream:truth']] },
    { name: 'transcript truth', cmd: ['npm', ['run', 'transcript:truth']] },
    // Extension confinement in the shipped Electron with the desktop app's
    // real guards: the proof behind the desktop trust card's network
    // sentence. Here because CI runs no Electron; the Chromium half of the
    // proof is in CI's E2E job.
    { name: 'confinement (electron)', cmd: ['npm', ['run', 'test:confinement:electron']] },
    // The Permissions row reads the same in the desktop app and the browser
    // for one workspace: the shipped desktop app launched through its own
    // entrypoint (electron/main.js, its preload, handlers and server), beside
    // the browser-mode server in Chromium.
    { name: 'settings parity (electron and browser)', cmd: ['npm', ['run', 'test:settings:electron']] },
    // The profile that run starts on, proven on the same shipped entrypoint:
    // an absolute RUNDOCK_USER_DATA_DIR is the exact profile the app uses,
    // lock and storage included, and a relative one stops the app before a
    // window, the server or any profile state.
    { name: 'desktop profile override (electron)', cmd: ['npm', ['run', 'test:user-data:electron']] },
    // On a real case-insensitive disk: a note's case variant is refused
    // as the note itself. Once where the default disk is, once on an APFS
    // volume made for it; fails, never skips, where neither can run.
    { name: 'named sources (case-insensitive disk)', cmd: ['npm', ['run', 'test:case-identity:disk']] },
    { name: 'named sources (case-insensitive volume)', cmd: ['npm', ['run', 'test:case-identity:volume']] },
    { name: 'smoke (stub)', cmd: ['npm', ['run', 'smoke']] },
    // User-shaped journeys with disk-verified evals: the onboarding road a
    // new user actually walks, and the structured vault that must never be
    // scaffolded over. Persona failures block the cut like any other step.
    { name: 'personas (stub)', cmd: ['npm', ['run', 'smoke:personas']] },
    // The release walk: the product used from source in a real browser, with
    // the two example packages installed from their GitHub tags. A step here
    // so it fails a release when it rots instead of being skipped quietly,
    // which is how four of its steps stayed red across two releases.
    { name: 'release walk', cmd: ['npm', ['run', 'walk']] },
  ];
  if (live) {
    steps.push({ name: 'smoke (live)', cmd: ['npm', ['run', 'smoke', '--', '--live']] });
    steps.push({ name: 'personas (live)', cmd: ['npm', ['run', 'smoke:personas', '--', '--live']] });
  }
  // Unsigned unpacked build + real boot check: exercises electron-builder
  // config, the afterPack require-guard, and the packaged binary actually
  // starting. Signing stays the publish jobs' concern.
  steps.push({ name: 'packaging (unpacked+boot)', cmd: ['node', ['scripts/smoke-packaged.mjs']] });
  return steps;
}

function readGateRecord(root = ROOT) {
  const file = path.join(root, GATE_FILE_NAME);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function runGate({
  root = ROOT, live = true, ci = true, exec = defaultExec, gh, busy, ports, log = console.log,
} = {}) {
  const startedAt = Date.now();
  const finish = (ok, error) => {
    if (!ok) log(`[gate] FAIL: ${error}`);
    return { ok, error };
  };

  // A gate pass must describe a reproducible tree: refuse dirty trees.
  let sha;
  let tree;
  try {
    const dirty = String(exec('git', ['status', '--porcelain'])).trim();
    if (dirty) {
      return finish(false, `working tree is not clean; a gate pass must describe a committed tree:\n${dirty}`);
    }
    sha = String(exec('git', ['rev-parse', 'HEAD'])).trim();
    tree = String(exec('git', ['rev-parse', 'HEAD^{tree}'])).trim();
  } catch (err) {
    return finish(false, `git preflight failed: ${err.message}`);
  }

  // Preconditions before any expensive step.
  let version;
  try {
    version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const latestTag = String(exec('git', ['describe', '--tags', '--abbrev=0'])).trim();
    candidateVersion(version, latestTag, fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'));
  } catch (err) {
    return finish(false, err.message);
  }

  let ciRecord = { skipped: true };
  if (ci) {
    log(`[gate] reading CI's results for tree ${tree.slice(0, 12)}...`);
    const isAncestor = (a, b) => {
      try { exec('git', ['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; }
    };
    const verdict = ciVerdict({ tree, isAncestor, ...(gh ? { gh } : {}) });
    if (!verdict.ok) return finish(false, verdict.error);
    ciRecord = { checks: verdict.checks };
    log(`[gate] CI passed ${Object.keys(verdict.checks).join(', ')} on this tree`);
  } else {
    log('[gate] NOT reading CI (--no-ci): release will refuse this record');
  }

  try {
    await requireSmokePortsFree({ exec, ...(busy ? { busy } : {}), ...(ports ? { ports } : {}) });
  } catch (err) {
    return finish(false, err.message);
  }

  const steps = buildSteps(live);
  const timings = [];
  for (const step of steps) {
    const stepStart = Date.now();
    log(`[gate] ${step.name}...`);
    try {
      exec(step.cmd[0], step.cmd[1]);
    } catch (err) {
      // execFileSync attaches the captured stdout; surface its tail so a
      // failing step diagnoses itself instead of saying "Command failed".
      const tail = err.stdout ? `\n--- last output ---\n${String(err.stdout).split('\n').slice(-25).join('\n')}` : '';
      return finish(false, `step "${step.name}" failed: ${err.message}${tail}`);
    }
    const seconds = Math.round((Date.now() - stepStart) / 100) / 10;
    timings.push({ name: step.name, seconds });
    log(`[gate] ${step.name} passed (${seconds}s)`);
  }

  const record = {
    tree,
    sha,
    version,
    live,
    ci: ciRecord,
    passedAt: new Date().toISOString(),
    wallClockSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
    steps: timings,
  };
  fs.writeFileSync(path.join(root, GATE_FILE_NAME), JSON.stringify(record, null, 2) + '\n');
  const caveats = [!live && 'NO LIVE SMOKE', !ci && 'CI NOT READ'].filter(Boolean);
  log(`[gate] PASS on tree ${tree.slice(0, 12)} (${version}) in ${record.wallClockSeconds}s` +
    (caveats.length ? ` (${caveats.join(', ')}: release will refuse this record)` : ''));
  return { ok: true, record };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (require.main === module) {
  // Sandboxed, the gate's Electron, browser and live steps fail an hour in and
  // look like product failures. Refuse in the first second instead.
  require('./lib/sandbox.js').refuseIfSandboxed('The release gate', 'npm run release:gate');
  const live = !process.argv.includes('--no-live');
  const ci = !process.argv.includes('--no-ci');
  runGate({ live, ci }).then(result => {
    process.exit(result.ok ? 0 : 1);
  });
}

module.exports = {
  GATE_FILE_NAME, nextVersions, candidateVersion, smokePorts, portHolders, requireSmokePortsFree,
  buildSteps, readGateRecord, runGate,
};
