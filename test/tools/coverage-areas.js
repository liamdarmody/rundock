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
const serverSrcPath = path.join(__dirname, '..', '..', 'server.js');

// Functional areas, located by ANCHOR PATTERNS rather than hardcoded line
// numbers, so edits elsewhere in server.js cannot silently shift an area onto
// unrelated code. Each area runs from the line matching `start` to the line
// BEFORE the one matching `end` (both regexes, matched against whole lines).
const AREA_DEFS = [
  ['Delegation / orchestration engine', /^function wireProcessHandlers\(/, /^wss\.on\('connection'/],
  ['  - wireProcessHandlers (stream-json + interception)', /^function wireProcessHandlers\(/, /^function handleScopeReturn/],
  ['  - handleScopeReturn', /^function handleScopeReturn/, /^function handleDelegation/],
  ['  - handleDelegation', /^function handleDelegation/, /^wss\.on\('connection'/],
  ['Scheduler (getNextRun + startScheduler + executeRoutine)', /^function startScheduler\(/, /^function analyzeWorkspace/],
  ['Agent discovery + frontmatter parsing', /^\/\/ ===== AGENT DISCOVERY =====/, /^function startScheduler\(/],
  ['Skill discovery', /^function discoverSkills\(/, /^function getFileTree\(/],
  ['System prompt + roster builders', /^function buildSystemPrompt\(/, /^\/\/ ===== AGENT DISCOVERY =====/],
  ['Workspace analysis (Seven Signals)', /^function analyzeWorkspace\(/, /^function muteHooks\(/],
  ['Workspace mode detection + scaffolding', /^function muteHooks\(/, /^const server = http\.createServer/],
  ['Transcripts + persistence helpers', /^function loadTranscript\(/, /^function safeSend\(/],
  ['Conversation / state persistence', /^function readConversations\(/, /^function readState\(/],
  ['HTTP request router (incl. permission bridge)', /^const server = http\.createServer/, /^function loadTranscript\(/],
  ['WebSocket message handlers', /^wss\.on\('connection'/, /^function discoverSkills\(/],
  ['Spawn plumbing (spawnClaude, resolveClaudeBin, errors)', /^function resolveClaudeBin\(/, /^\/\/ ===== CODEX RUNTIME =====/],
  ['Codex runtime (status, turns, delegate wiring)', /^\/\/ ===== CODEX RUNTIME =====/, /^\/\/ Graceful shutdown/],
];

// Resolve anchor patterns to line ranges against the current source.
function resolveAreas() {
  const lines = fs.readFileSync(serverSrcPath, 'utf-8').split('\n');
  const findLine = (re) => {
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
    return null;
  };
  const areas = [];
  for (const [label, startRe, endRe] of AREA_DEFS) {
    const start = findLine(startRe);
    const end = findLine(endRe);
    if (start == null || end == null || end <= start) {
      console.warn(`coverage-areas: could not resolve "${label}" (start=${start}, end=${end}); anchors need updating`);
      continue;
    }
    areas.push([label, start, end - 1]);
  }
  return areas;
}

function parseLcov(file, wantedFile) {
  const text = fs.readFileSync(file, 'utf-8');
  const records = text.split('end_of_record');
  for (const rec of records) {
    const sfMatch = rec.match(/SF:(.*)/);
    if (!sfMatch) continue;
    if (path.basename(sfMatch[1].trim()) !== wantedFile) continue;
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
  const hits = parseLcov(lcovPath, targetFile);
  if (!hits) {
    console.error(`coverage-areas: no ${targetFile} record in ${lcovPath}`);
    process.exit(1);
  }
  let fileTotal = 0, fileCovered = 0;
  for (const [, c] of hits) { fileTotal++; if (c > 0) fileCovered++; }

  console.log('\n===== server.js coverage by functional area =====\n');
  console.log(`OVERALL server.js: ${pct(fileCovered, fileTotal)}  (${fileCovered}/${fileTotal} executable lines)`);
  // Sibling modules included in coverage get their own overall line.
  for (const extra of ['codex.js']) {
    const extraHits = parseLcov(lcovPath, extra);
    if (extraHits) {
      let t = 0, c2 = 0;
      for (const [, c] of extraHits) { t++; if (c > 0) c2++; }
      console.log(`OVERALL ${extra}: ${pct(c2, t)}  (${c2}/${t} executable lines)`);
    }
  }
  console.log('');
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
  console.log(pad('Area', 58) + pad('Lines', 10) + pad('Covered', 10) + 'Coverage');
  console.log('-'.repeat(88));
  for (const [label, start, end] of resolveAreas()) {
    const { total, covered } = areaCoverage(hits, start, end);
    console.log(pad(label, 58) + pad(`${start}-${end}`, 10) + pad(`${covered}/${total}`, 10) + pct(covered, total));
  }
  console.log('');
}

main();
