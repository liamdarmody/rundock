#!/usr/bin/env node
'use strict';
// Per-functional-area line coverage, with committed floors. The suite's
// enforcement instrument for the decomposition programme.
//
// node --experimental-test-coverage reports a single file-level % per file,
// which is misleading for a monolith: server.js mixes the high-risk
// delegation engine with static-file serving and Electron shell glue that
// the suite deliberately does NOT exercise. This tool reads the lcov report
// (DA:<line>,<hits> records) and computes covered/total executable lines for
// the functional ranges that matter, so coverage is reported HONESTLY per
// area instead of as one vanity number.
//
// Three properties make it an instrument rather than a report:
//   1. Area definitions carry their FILE, so an area keeps its number when
//      its code moves to lib/ during decomposition.
//   2. An anchor that fails to resolve is a HARD FAILURE. A moved function
//      whose area definition was not updated must stop the build, not print
//      a warning that scrolls past.
//   3. Committed floors (coverage-floors.json) are enforced: any area or
//      file measuring below its floor (beyond a small timing tolerance)
//      exits non-zero. Floors ratchet up, never down.
//
// Usage:
//   node test/tools/coverage-areas.js [coverage.lcov]                # report + enforce
//   node test/tools/coverage-areas.js [coverage.lcov] --write-floors # ratchet floors up

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const FLOORS_PATH = path.join(__dirname, 'coverage-floors.json');

// Coverage measurements jitter slightly on timing-dependent paths
// (scheduler ticks, reaper sweeps). The tolerance absorbs that noise; a
// deleted test drops an area far past it.
const FLOOR_TOLERANCE = 0.25;

// Functional areas: [file, label, startRe, endRe]. Located by ANCHOR
// PATTERNS rather than line numbers, so edits cannot silently shift an area
// onto unrelated code. Each area runs from the line matching `start` to the
// line BEFORE the one matching `end`. When decomposition moves an area to
// lib/, the SAME slice PR updates its file here, and the area keeps its
// floor.
const AREA_DEFS = [
  ['server.js', 'Delegation / orchestration engine', /^function wireProcessHandlers\(/, /^wss\.on\('connection'/],
  ['server.js', '  - wireProcessHandlers (stream-json + interception)', /^function wireProcessHandlers\(/, /^function handleScopeReturn/],
  ['server.js', '  - handleScopeReturn', /^function handleScopeReturn/, /^function handleDelegation/],
  ['server.js', '  - handleDelegation', /^function handleDelegation/, /^wss\.on\('connection'/],
  // Slice 6 migration: the scheduler moved to lib/scheduler.js and keeps
  // its floor under the same label. The area now genuinely contains the
  // routine-state persistence (loadRoutineState/saveRoutineState/
  // recordRoutineRun), which in the root sat outside every area span and
  // was only floored via the file overall.
  ['lib/scheduler.js', 'Scheduler (getNextRun + startScheduler + executeRoutine)', /^const unwired/, /^module\.exports/],
  // Slice 2 migrations: discovery + frontmatter parsing and the system
  // prompt / roster builders moved to lib/agents/ and keep their floors
  // under the same labels. The prompt area now genuinely contains the
  // roster builders (in the root they sat above the area's start anchor).
  // The interim root area covers what the move left behind (the codex
  // probe cache shared with the settings runtime probe, the skill and
  // file-list caches, and the open-file watch) until their own slices.
  ['lib/agents/discovery.js', 'Agent discovery + frontmatter parsing', /^let _agentCache/, /^module\.exports/],
  ['server.js', 'Skill discovery', /^function discoverSkills\(/, /^function getFileTree\(/],
  ['lib/agents/prompt.js', 'System prompt + roster builders', /^const unwired/, /^module\.exports/],
  // Slice 6 retarget: the area's old end anchor (the SCHEDULER banner)
  // moved to lib/scheduler.js; the area now runs to the HTTP server, with
  // only pointer comments in between.
  ['server.js', 'Codex probe + root caches + open-file watch (remainder)', /^let _codexDetectCache/, /^const server = http\.createServer/],
  // Slice 3 migrations: analysis and scaffolding moved to lib/workspace/
  // and keep their floors under the same labels. Boundary grants get their
  // own NEW area: in the root they sat outside every area span and were
  // only floored via the file overall.
  ['lib/workspace/analysis.js', 'Workspace analysis (Seven Signals)', /^const unwired/, /^module\.exports/],
  ['lib/workspace/scaffold.js', 'Workspace mode detection + scaffolding', /^const ROOT_DIR/, /^module\.exports/],
  ['lib/workspace/boundary.js', 'Workspace boundary grants', /^function boundaryPermissionsPath\(/, /^module\.exports/],
  // Slice 1 migrations: these two areas moved to lib/store/ and keep their
  // floors under the same labels; the interim root area covers what the move
  // left behind (signal layer + the appendTranscript/formatTranscript
  // composition) until the signals slice gives it a permanent home.
  ['lib/store/transcripts.js', 'Transcripts + persistence helpers', /^function transcriptDir\(/, /^module\.exports/],
  ['lib/store/persistence.js', 'Conversation / state persistence', /^function rundockDir\(/, /^module\.exports/],
  ['lib/signals.js', 'Signal layer (events, retention, skill usage, docs-gap)', /^const EVENTS_RETENTION_MONTHS/, /^module\.exports/],
  ['server.js', 'Transcript composition (root remainder)', /^function appendTranscript\(/, /^function safeSend\(/],
  // Slice 7 migration: the request router moved to lib/http-router.js and
  // keeps its floor under the same label (the area also gains the
  // BINARY_FILE_TYPES map, whose single user is the router's binary
  // transport). The root remainder area covers what deliberately stayed:
  // the HTTP server itself, the WebSocket server bootstrap, and the
  // connection state that lived below the router.
  ['lib/http-router.js', 'HTTP request router (incl. permission bridge)', /^const unwired/, /^module\.exports/],
  ['server.js', 'HTTP server + WS bootstrap (root remainder)', /^const server = http\.createServer/, /^function appendTranscript\(/],
  ['server.js', 'WebSocket message handlers', /^wss\.on\('connection'/, /^function discoverSkills\(/],
  // Slice 5 migration: the Codex glue (app-server lifecycle, turns,
  // delegate wiring) moved to lib/runtime/codex-glue.js. The root
  // remainder area covers what deliberately stayed: getRuntimeStatus with
  // its probe caches (settings machinery that sat mid-span) and
  // requestServerPermission (the generic bridge, injected into the glue).
  // The spawn-plumbing end anchor retargets to the remainder banner (its
  // old end, the CODEX RUNTIME banner, moved with the glue).
  ['server.js', 'Spawn plumbing (spawnClaude, resolveClaudeBin, errors)', /^function resolveClaudeBin\(/, /^\/\/ ===== RUNTIME STATUS =====/],
  ['server.js', 'Runtime status + server permission bridge (root remainder)', /^\/\/ ===== RUNTIME STATUS =====/, /^\/\/ Graceful shutdown/],
  ['lib/runtime/codex-glue.js', 'Codex glue (app-server lifecycle, turns, delegate wiring)', /^let _resolvedCodexBin/, /^module\.exports/],
];

// Whole files reported (and floored) as OVERALL lines.
const OVERALL_FILES = [
  'server.js', 'codex.js', 'codex-appserver.js', 'search.js',
  'lib/delegation/markers.js', 'lib/delegation/handback.js', 'lib/delegation/state.js',
  'lib/config.js', 'lib/store/persistence.js', 'lib/store/transcripts.js',
  'lib/agents/discovery.js', 'lib/agents/prompt.js',
  'lib/workspace/boundary.js', 'lib/workspace/analysis.js', 'lib/workspace/scaffold.js',
  'lib/signals.js', 'lib/runtime/codex-glue.js', 'lib/scheduler.js',
  'lib/http-router.js',
];

// ---------------------------------------------------------------------------
// Resolution and measurement (pure; injected reader for tests)
// ---------------------------------------------------------------------------

function defaultReadFile(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf-8');
}

// Resolve [file, label, startRe, endRe] definitions to [file, label, start,
// end] line ranges. Unresolvable anchors THROW: the caller decides exit.
function resolveAreas(defs = AREA_DEFS, readFile = defaultReadFile) {
  const fileLines = new Map();
  const linesOf = (file) => {
    if (!fileLines.has(file)) fileLines.set(file, readFile(file).split('\n'));
    return fileLines.get(file);
  };
  const areas = [];
  for (const [file, label, startRe, endRe] of defs) {
    const lines = linesOf(file);
    const findLine = (re) => {
      for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
      return null;
    };
    const start = findLine(startRe);
    const end = findLine(endRe);
    if (start == null || end == null || end <= start) {
      throw new Error(
        `coverage-areas: could not resolve area "${label}" in ${file} ` +
        `(start=${start}, end=${end}). If this code moved, update the area's ` +
        `file/anchors in AREA_DEFS in the SAME PR as the move.`
      );
    }
    areas.push([file, label, start, end - 1]);
  }
  return areas;
}

function parseLcov(lcovText, wantedFile) {
  const records = lcovText.split('end_of_record');
  for (const rec of records) {
    const sfMatch = rec.match(/SF:(.*)/);
    if (!sfMatch) continue;
    // Accept a bare basename ('server.js') or a repo-relative path
    // ('lib/delegation/markers.js'): basename-only matching cannot address a
    // file inside a subdirectory, and two files sharing a basename would
    // collide.
    const sf = sfMatch[1].trim();
    if (sf !== wantedFile && path.basename(sf) !== wantedFile) continue;
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

// ---------------------------------------------------------------------------
// Floors (pure)
// ---------------------------------------------------------------------------

// measured/floors: { label -> pct }. Returns human-readable violations.
function checkFloors(measured, floors) {
  const violations = [];
  for (const [key, floor] of Object.entries(floors)) {
    const current = measured[key];
    if (current == null) {
      violations.push(`"${key}" has a floor (${floor}) but was not measured. An area cannot disappear to silence its floor; update AREA_DEFS and floors deliberately, in the same PR.`);
      continue;
    }
    if (current + FLOOR_TOLERANCE < floor) {
      violations.push(`"${key}" measured ${current}%, below its floor of ${floor}%. Coverage floors never ratchet down; add tests to restore it.`);
    }
  }
  return violations;
}

// Ratchet: an existing floor never lowers; fresh areas enter at measurement.
function mergeFloors(existing, fresh) {
  const merged = { ...fresh };
  for (const [key, oldFloor] of Object.entries(existing)) {
    if (merged[key] != null && merged[key] < oldFloor) merged[key] = oldFloor;
    if (merged[key] == null) merged[key] = oldFloor;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function pctNum(c, t) { return t === 0 ? 0 : Math.round((c / t) * 1000) / 10; }
function pctStr(c, t) { return t === 0 ? 'n/a' : pctNum(c, t).toFixed(1) + '%'; }

function main() {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const writeFloors = process.argv.includes('--write-floors');
  const lcovPath = args[0] || 'coverage.lcov';

  if (!fs.existsSync(lcovPath)) {
    console.error(`coverage-areas: ${lcovPath} not found. Run npm run test:coverage.`);
    process.exit(1);
  }
  const lcovText = fs.readFileSync(lcovPath, 'utf-8');

  let areas;
  try {
    areas = resolveAreas();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const measured = {};

  console.log('\n===== coverage by file and functional area =====\n');
  for (const file of OVERALL_FILES) {
    const hits = parseLcov(lcovText, file);
    if (!hits) {
      console.error(`coverage-areas: no ${file} record in ${lcovPath}. Is it in test:coverage's include list?`);
      process.exit(1);
    }
    let t = 0, c = 0;
    for (const [, count] of hits) { t++; if (count > 0) c++; }
    measured[`OVERALL ${file}`] = pctNum(c, t);
    console.log(`OVERALL ${file}: ${pctStr(c, t)}  (${c}/${t} executable lines)`);
  }

  console.log('');
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
  console.log(pad('Area', 58) + pad('Lines', 12) + pad('Covered', 10) + 'Coverage');
  console.log('-'.repeat(90));
  for (const [file, label, start, end] of areas) {
    const hits = parseLcov(lcovText, file);
    if (!hits) {
      console.error(`coverage-areas: no ${file} record in ${lcovPath} (needed by area "${label}")`);
      process.exit(1);
    }
    const { total, covered } = areaCoverage(hits, start, end);
    measured[label.trim()] = pctNum(covered, total);
    console.log(pad(label, 58) + pad(`${start}-${end}`, 12) + pad(`${covered}/${total}`, 10) + pctStr(covered, total));
  }
  console.log('');

  if (writeFloors) {
    let existing = {};
    if (fs.existsSync(FLOORS_PATH)) {
      existing = JSON.parse(fs.readFileSync(FLOORS_PATH, 'utf-8')).floors || {};
    }
    const merged = mergeFloors(existing, measured);
    let commit = 'unknown';
    try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf-8' }).trim(); } catch { /* fine */ }
    fs.writeFileSync(FLOORS_PATH, JSON.stringify({
      generatedAt: new Date().toISOString(),
      commit,
      tolerance: FLOOR_TOLERANCE,
      floors: merged,
    }, null, 2) + '\n');
    console.log(`coverage-areas: floors written to ${path.relative(ROOT, FLOORS_PATH)} (ratcheted: never lower than before)`);
    return;
  }

  if (!fs.existsSync(FLOORS_PATH)) {
    console.error('coverage-areas: no coverage-floors.json. Generate with: npm run test:coverage -- (then) node test/tools/coverage-areas.js coverage.lcov --write-floors');
    process.exit(1);
  }
  const floors = JSON.parse(fs.readFileSync(FLOORS_PATH, 'utf-8')).floors;
  const violations = checkFloors(measured, floors);
  if (violations.length) {
    console.error('coverage-areas: FLOOR VIOLATIONS:');
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(`coverage-areas: all ${Object.keys(floors).length} floors hold (tolerance ${FLOOR_TOLERANCE})`);
}

if (require.main === module) main();

module.exports = { AREA_DEFS, OVERALL_FILES, FLOOR_TOLERANCE, resolveAreas, parseLcov, areaCoverage, checkFloors, mergeFloors };
