#!/usr/bin/env node
'use strict';
// The release gate's own case-insensitive disk steps, run on a committed tree and recorded.
//
// A note's case variant being refused as the note itself is proved on a
// real case-insensitive filesystem by two steps of scripts/release-gate.js:
// the default disk and an APFS volume made for the run. The full release gate
// also runs a live model smoke and packaging, which a review of this change
// does not need and a development tree should not spend. So this runs exactly
// those two steps, taken from the gate's own step list by name (never retyped
// here), on a clean committed tree, and writes what ran, on which commit and
// tree, with each step's outcome, to docs/evidence/trust-boundary/.
//
// It never writes .release-gate.json: a record of two steps is not a gate
// pass, and scripts/release.js must never read one as such.
//
//   node test/tools/record-case-identity-gate.js

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { buildSteps } = require('../../scripts/release-gate.js');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'evidence', 'trust-boundary', 'release-gate-case-identity.json');
const NAMES = ['named sources (case-insensitive disk)', 'named sources (case-insensitive volume)'];

const git = (args) => String(execFileSync('git', args, { cwd: ROOT })).trim();

function main() {
  const dirty = git(['status', '--porcelain']);
  if (dirty) {
    console.error(`record-case-identity-gate: the tree is not clean, so no commit describes it:\n${dirty}`);
    process.exit(1);
  }
  const steps = buildSteps(false).filter((s) => NAMES.includes(s.name));
  if (steps.length !== NAMES.length) {
    console.error(`record-case-identity-gate: the release gate no longer defines ${NAMES.join(' and ')}`);
    process.exit(1);
  }
  const record = {
    what: 'The case-insensitive disk steps of scripts/release-gate.js, run by their own definitions. Not a release gate pass.',
    commit: git(['rev-parse', 'HEAD']),
    tree: git(['rev-parse', 'HEAD^{tree}']),
    ranAt: new Date().toISOString(),
    platform: `${process.platform} ${process.arch}`,
    steps: [],
  };
  let ok = true;
  for (const step of steps) {
    const started = Date.now();
    let passed = true;
    let tail = '';
    try {
      const out = execFileSync(step.cmd[0], step.cmd[1], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      tail = out.split('\n').filter(Boolean).slice(-6).join('\n');
    } catch (e) {
      passed = false;
      ok = false;
      tail = String(e.stdout || e.message).split('\n').filter(Boolean).slice(-12).join('\n');
    }
    record.steps.push({ name: step.name, command: [step.cmd[0], ...step.cmd[1]].join(' '), passed, seconds: Math.round((Date.now() - started) / 100) / 10, output: tail });
    console.log(`[case-identity] ${step.name}: ${passed ? 'passed' : 'FAILED'}`);
  }
  record.passed = ok;
  fs.writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`[case-identity] recorded ${path.relative(ROOT, OUT)} for ${record.commit.slice(0, 9)}`);
  process.exit(ok ? 0 : 1);
}

main();
