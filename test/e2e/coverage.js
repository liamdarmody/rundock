'use strict';
// Browser-side coverage plumbing (SR1 client test coverage, stage 1).
//
// Chromium's V8 coverage is collected per page via a Playwright auto-fixture
// (see search.spec.js), accumulated as raw entries in test-results/, and
// converted here (global teardown) to an lcov report so public/app.js gets a
// measured, tracked coverage number alongside the Node suite's report for
// server.js and search.js. v8-to-istanbul does the range->line conversion;
// the lcov records are emitted directly to avoid a chain of istanbul
// reporting dependencies.
const fs = require('node:fs');
const path = require('node:path');

const RAW_DIR = path.join(__dirname, '..', '..', 'test-results');
const RAW_FILE = path.join(RAW_DIR, 'v8-coverage.jsonl');
const LCOV_OUT = path.join(RAW_DIR, 'coverage-client.lcov');

function appendRawCoverage(entries) {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  for (const entry of entries) {
    fs.appendFileSync(RAW_FILE, JSON.stringify(entry) + '\n');
  }
}

async function writeLcov() {
  if (!fs.existsSync(RAW_FILE)) return null;
  const v8toIstanbul = require('v8-to-istanbul');
  const lines = fs.readFileSync(RAW_FILE, 'utf-8').split('\n').filter(Boolean);
  // Merge every collected pass over app.js into one range set: counts are
  // summed by v8-to-istanbul, which is what line-hit reporting needs.
  const functions = [];
  for (const line of lines) {
    const entry = JSON.parse(line);
    functions.push(...entry.functions);
  }
  if (!functions.length) return null;

  const appJsPath = path.join(__dirname, '..', '..', 'public', 'app.js');
  const source = fs.readFileSync(appJsPath, 'utf-8');
  const converter = v8toIstanbul(appJsPath, 0, { source });
  await converter.load();
  converter.applyCoverage(functions);
  const istanbul = converter.toIstanbul();
  const fileCov = istanbul[appJsPath];

  // Line hits from the statement map.
  const lineHits = new Map();
  for (const [id, loc] of Object.entries(fileCov.statementMap)) {
    const hit = fileCov.s[id] || 0;
    const ln = loc.start.line;
    lineHits.set(ln, Math.max(lineHits.get(ln) || 0, hit));
  }
  const sorted = [...lineHits.entries()].sort((a, b) => a[0] - b[0]);
  const covered = sorted.filter(([, h]) => h > 0).length;
  const lcov = [
    'TN:',
    `SF:${appJsPath}`,
    ...sorted.map(([ln, h]) => `DA:${ln},${h}`),
    `LF:${sorted.length}`,
    `LH:${covered}`,
    'end_of_record',
    '',
  ].join('\n');
  fs.writeFileSync(LCOV_OUT, lcov);
  const pct = sorted.length ? (100 * covered / sorted.length) : 0;
  return { covered, total: sorted.length, pct, out: LCOV_OUT };
}

module.exports = { appendRawCoverage, writeLcov, RAW_FILE };
