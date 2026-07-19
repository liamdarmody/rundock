#!/usr/bin/env node
'use strict';
// Guard against internal-reference leaks in the public repository.
//
// Rundock is developed from a private workspace that tracks work with run
// codenames, review-round and priority labels, and vault paths. None of that
// belongs in the public source: comments, tests, and docs should read as plain
// descriptive language to any external contributor browsing the repo.
//
// This scans every tracked text file (minus generated/vendored artifacts) for
// those patterns and exits non-zero on a hit, so CI blocks the leak before it
// merges. To run locally: `npm run check:refs`.
//
// If a match is a genuine false positive, prefer rewording the line. As a last
// resort, add an inline `internal-refs-allow` marker on the same line.

const { execSync } = require('node:child_process');
const fs = require('node:fs');

// Paths never scanned: generated bundles, dependency locks, coverage, build
// output, and this checker itself (its pattern list would self-match).
const SKIP = [
  /^public\/vendor\//,
  /^node_modules\//,
  /(^|\/)package-lock\.json$/,
  /(^|\/)coverage\.lcov$/,
  /^dist\//,
  /\.min\.(js|css)$/,
  /^scripts\/check-internal-refs\.js$/,
];

// Each rule: a label and a regex that identifies an internal reference. Keep
// these precise so ordinary code never trips them.
const RULES = [
  { label: 'priority/process label (e.g. P0-1)', re: /\bP[0-9]-[0-9]\b/ },
  { label: 'review-round label (e.g. Review R1)', re: /\bReview R[0-9]\b/i },
  { label: 'review-round + priority label (e.g. R2 P3-1)', re: /\bR[0-9] P[0-9](-[0-9])?\b/ },
  { label: 'review-round label (e.g. round-2 regressions)', re: /\bround-?[0-9] regress/i },
  { label: 'internal plan/run codename (e.g. HARDEN1, KAN2)', re: /\b(HARDEN[0-9]*|KAN[0-9])\b/ },
  { label: 'vault / private workspace path', re: /02_Areas|01_Projects|Liam-Agent-Workspace|Obsidian Vaults?/ },
  { label: 'internal process phrase', re: /adversarial (sweep|review round)|handoff file per run|completion report per run/i },
  { label: 'owner-attributed decision note', re: /\(Liam[ ,]|Liam 20[0-9]{2}|decision,? Liam/ },
];

function trackedFiles() {
  const out = execSync('git ls-files', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').filter(Boolean).filter((f) => !SKIP.some((re) => re.test(f)));
}

function isProbablyBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

const findings = [];
for (const file of trackedFiles()) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { continue; }
  if (isProbablyBinary(buf)) continue;
  const lines = buf.toString('utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.includes('internal-refs-allow')) return;
    for (const rule of RULES) {
      const m = line.match(rule.re);
      if (m) findings.push({ file, line: i + 1, label: rule.label, match: m[0], text: line.trim().slice(0, 120) });
    }
  });
}

if (findings.length === 0) {
  console.log('check-internal-refs: clean (no internal references found).');
  process.exit(0);
}

console.error(`check-internal-refs: found ${findings.length} internal reference(s) that must not ship in the public repo.\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  [${f.label}]  matched "${f.match}"`);
  console.error(`    ${f.text}`);
}
console.error('\nReword these in plain descriptive language, then re-run: npm run check:refs');
process.exit(1);
