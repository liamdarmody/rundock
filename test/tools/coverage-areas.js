#!/usr/bin/env node
'use strict';
// Per-functional-area line coverage for server.js.
//
// node --experimental-test-coverage reports a single file-level % for
// server.js, which is misleading: the file is a 4,200-line monolith mixing
// the high-risk delegation engine with static-file serving and Electron shell
// glue that the suite deliberately does NOT exercise. This tool reads the lcov
// report (DA:<line>,<hits> records) and computes covered/total executable
// lines for the functional ranges that matter, so coverage can be reported
// HONESTLY per area instead of as one vanity number.
//
// Usage: node test/tools/coverage-areas.js [coverage.lcov]

const fs = require('fs');
const path = require('path');

const lcovPath = process.argv[2] || 'coverage.lcov';
const targetFile = 'server.js';

// Functional areas, by server.js line range (inclusive). Ranges trace the
// current server.js; they are documentation of intent, not load-bearing.
const AREAS = [
  ['Delegation / orchestration engine', 2035, 2788],
  ['  - wireProcessHandlers (stream-json + interception)', 2035, 2189],
  ['  - handleScopeReturn', 2202, 2312],
  ['  - handleDelegation', 2315, 2788],
  ['Scheduler (getNextRun + startScheduler + executeRoutine)', 992, 1084],
  ['Permission bridge (/api/permission-request + responses)', 1766, 1815],
  ['Agent / skill discovery + frontmatter parsing', 715, 988],
  ['Skill discovery', 3875, 3993],
  ['System prompt + roster builders', 449, 705],
  ['Workspace analysis (Seven Signals)', 1108, 1396],
  ['Workspace mode detection + scaffolding', 1434, 1724],
  ['Transcripts + persistence helpers', 1875, 1952],
  ['Conversation / state persistence', 152, 206],
  ['HTTP request router', 1733, 1837],
  ['WebSocket message handlers', 2795, 3862],
  ['Spawn plumbing (spawnClaude, resolveClaudeBin, errors)', 4088, 4213],
];

function parseLcov(file) {
  const text = fs.readFileSync(file, 'utf-8');
  const records = text.split('end_of_record');
  for (const rec of records) {
    const sfMatch = rec.match(/SF:(.*)/);
    if (!sfMatch) continue;
    if (path.basename(sfMatch[1].trim()) !== targetFile) continue;
    const hits = new Map(); // line -> count
    for (const m of rec.matchAll(/^DA:(\d+),(\d+)/gm)) {
      hits.set(parseInt(m[1], 10), parseInt(m[2], 10));
    }
    return hits;
  }
  return null;
}

function areaCoverage(hits, start, end) {
  let total = 0, covered = 0;
  for (let ln = start; ln <= end; ln++) {
    if (!hits.has(ln)) continue; // non-executable line (no DA record)
    total++;
    if (hits.get(ln) > 0) covered++;
  }
  return { total, covered };
}

function pct(c, t) { return t === 0 ? 'n/a' : ((c / t) * 100).toFixed(1) + '%'; }

function main() {
  if (!fs.existsSync(lcovPath)) {
    console.error(`coverage-areas: ${lcovPath} not found. Run npm run test:coverage.`);
    process.exit(1);
  }
  const hits = parseLcov(lcovPath);
  if (!hits) {
    console.error(`coverage-areas: no ${targetFile} record in ${lcovPath}`);
    process.exit(1);
  }
  let fileTotal = 0, fileCovered = 0;
  for (const [, c] of hits) { fileTotal++; if (c > 0) fileCovered++; }

  console.log('\n===== server.js coverage by functional area =====\n');
  console.log(`OVERALL server.js: ${pct(fileCovered, fileTotal)}  (${fileCovered}/${fileTotal} executable lines)\n`);
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
  console.log(pad('Area', 58) + pad('Lines', 10) + pad('Covered', 10) + 'Coverage');
  console.log('-'.repeat(88));
  for (const [label, start, end] of AREAS) {
    const { total, covered } = areaCoverage(hits, start, end);
    console.log(pad(label, 58) + pad(`${start}-${end}`, 10) + pad(`${covered}/${total}`, 10) + pct(covered, total));
  }
  console.log('');
}

main();
