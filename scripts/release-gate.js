#!/usr/bin/env node
'use strict';

/**
 * Release gate: one command validates the release candidate against HEAD.
 *
 * Why: 0.11.6 took six cuts because candidate testing happened AFTER tagging.
 * The gate inverts the train. It runs the full gauntlet (suite with coverage,
 * e2e, smoke stub + live, hygiene, packaging, changelog readiness, version
 * sanity) and, only if everything passes on a clean tree, writes
 * `.release-gate.json` recording the SHA it passed on, the wall clock, and
 * per-step timings. `scripts/release.js` refuses to tag unless that record
 * exists for the exact current HEAD with live smoke included.
 *
 * The release commit that follows (version bump + changelog promotion) is the
 * only thing allowed on top of a gated SHA, by construction: release.js
 * checks the gate BEFORE creating it, and that commit touches only
 * package.json and CHANGELOG.md.
 *
 * Usage:
 *   npm run release:gate              # full gauntlet including live smoke
 *   npm run release:gate -- --no-live # development of the gate itself only;
 *                                     # release.js refuses a no-live record
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GATE_FILE_NAME = '.release-gate.json';

// ---------------------------------------------------------------------------
// Preconditions (pure, unit-tested)
// ---------------------------------------------------------------------------

// package.json must be valid semver AND match the latest tag: a version that
// is already ahead of the tags means a half-done bump is sitting in the tree.
function versionSanity(pkgVersion, latestTag) {
  if (!/^\d+\.\d+\.\d+$/.test(pkgVersion || '')) {
    throw new Error(`package.json version "${pkgVersion}" is not plain semver MAJOR.MINOR.PATCH.`);
  }
  const tagVersion = String(latestTag || '').replace(/^v/, '').trim();
  if (pkgVersion !== tagVersion) {
    throw new Error(
      `package.json version ${pkgVersion} does not match the latest tag ${latestTag}. ` +
      `The bump belongs to scripts/release.js; a mismatch means a half-done release is in the tree.`
    );
  }
}

// CHANGELOG.md must carry a real `## Unreleased` section: present, named, and
// with content beyond the name line. A release with no notes is not a release.
function changelogReady(changelogText) {
  const lines = String(changelogText).split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^## Unreleased\s*$/.test(lines[i])) { start = i; break; }
  }
  if (start === -1) {
    throw new Error('CHANGELOG.md has no "## Unreleased" section. Add release notes before gating.');
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { end = i; break; }
  }
  const body = lines.slice(start + 1, end).join('\n');
  if (!/^\s*\*\*Name:\*\*\s*.+$/m.test(body)) {
    throw new Error('The Unreleased section has no "**Name:**" line. Every release is named.');
  }
  const withoutName = body.replace(/^\s*\*\*Name:\*\*\s*.+$/m, '').trim();
  if (!withoutName) {
    throw new Error('The Unreleased section is empty beyond its name. Release notes are content, not a heading.');
  }
}

// ---------------------------------------------------------------------------
// The gauntlet
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
    { name: 'hygiene', cmd: ['npm', ['run', 'check:refs']] },
    // Fails fast if the installed runtime has moved past the committed
    // stream capture, or the stub has drifted from it: no candidate gets
    // validated against a stale model of the stream.
    { name: 'stream truth', cmd: ['npm', ['run', 'stream:truth']] },
    { name: 'suite+coverage', cmd: ['npm', ['run', 'test:coverage']] },
    { name: 'e2e', cmd: ['npm', ['run', 'test:e2e']] },
    { name: 'smoke (stub)', cmd: ['npm', ['run', 'smoke']] },
  ];
  if (live) {
    steps.push({ name: 'smoke (live)', cmd: ['npm', ['run', 'smoke', '--', '--live']] });
  }
  // Unsigned unpacked build + real boot check: exercises electron-builder
  // config, the afterPack require-guard, and the packaged binary actually
  // starting. Signing stays the publish jobs' concern (and local codesign
  // fails on xattr detritus anyway; proven 2026-08-11).
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

async function runGate({ root = ROOT, live = true, exec = defaultExec, log = console.log } = {}) {
  const startedAt = Date.now();
  const finish = (ok, error) => {
    if (!ok) log(`[gate] FAIL: ${error}`);
    return { ok, error };
  };

  // A gate pass must describe a reproducible SHA: refuse dirty trees.
  let sha;
  try {
    const dirty = String(exec('git', ['status', '--porcelain'])).trim();
    if (dirty) {
      return finish(false, `working tree is not clean; a gate pass must describe a committed SHA:\n${dirty}`);
    }
    sha = String(exec('git', ['rev-parse', 'HEAD'])).trim();
  } catch (err) {
    return finish(false, `git preflight failed: ${err.message}`);
  }

  // Preconditions before any expensive step.
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const latestTag = String(exec('git', ['describe', '--tags', '--abbrev=0'])).trim();
    versionSanity(pkg.version, latestTag);
    changelogReady(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'));
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
    sha,
    live,
    passedAt: new Date().toISOString(),
    wallClockSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
    steps: timings,
  };
  fs.writeFileSync(path.join(root, GATE_FILE_NAME), JSON.stringify(record, null, 2) + '\n');
  log(`[gate] PASS on ${sha.slice(0, 9)} in ${record.wallClockSeconds}s${live ? '' : ' (NO LIVE SMOKE: release will refuse this record)'}`);
  return { ok: true, record };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (require.main === module) {
  const live = !process.argv.includes('--no-live');
  runGate({ live }).then(result => {
    process.exit(result.ok ? 0 : 1);
  });
}

module.exports = { GATE_FILE_NAME, versionSanity, changelogReady, buildSteps, readGateRecord, runGate };
