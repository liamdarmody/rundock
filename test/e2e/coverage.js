'use strict';
// Browser-side coverage plumbing (client test coverage, stages 1-2).
//
// Chromium's V8 coverage is collected per page via a Playwright auto-fixture
// (see search.spec.js), accumulated as raw entries in test-results/, and
// converted here (global teardown) to an lcov report so every client module
// gets a measured coverage number alongside the Node suite's report for
// server.js, search.js, and codex.js. v8-to-istanbul does the range->line
// conversion; the lcov records are emitted directly to avoid a chain of
// istanbul reporting dependencies.
//
// Stage-2 note: the extracted client modules (markers, permissions,
// conversation-list, palette-model) get their DEPTH coverage from the Node
// unit suite; this report shows what the browser golden paths execute. The
// ratchet rule (coverage never goes down) applies to the per-file numbers
// this prints.
const fs = require('node:fs');
const path = require('node:path');

const RAW_DIR = path.join(__dirname, '..', '..', 'test-results');
const RAW_FILE = path.join(RAW_DIR, 'v8-coverage.jsonl');
const LCOV_OUT = path.join(RAW_DIR, 'coverage-client.lcov');

// Every hand-written client script index.html loads (vendor bundles and the
// editor's vendored Tiptap build are third-party and excluded).
const CLIENT_FILES = [
  'app.js', 'markers.js', 'permissions.js', 'conversation-list.js',
  'palette-model.js', 'code-language.js',
];

function isClientEntry(url) {
  return CLIENT_FILES.some(f => (url || '').endsWith('/' + f));
}

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

  // Group collected passes by client file; counts are summed by
  // v8-to-istanbul, which is what line-hit reporting needs.
  const byFile = new Map();
  for (const line of lines) {
    const entry = JSON.parse(line);
    const file = CLIENT_FILES.find(f => (entry.url || '').endsWith('/' + f));
    if (!file) continue;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(...entry.functions);
  }
  if (!byFile.size) return null;

  const files = [];
  const lcovParts = [];
  for (const file of CLIENT_FILES) {
    const functions = byFile.get(file);
    if (!functions || !functions.length) continue;
    const filePath = path.join(__dirname, '..', '..', 'public', file);
    const source = fs.readFileSync(filePath, 'utf-8');
    const converter = v8toIstanbul(filePath, 0, { source });
    await converter.load();
    converter.applyCoverage(functions);
    const fileCov = converter.toIstanbul()[filePath];

    // Line hits from the statement map.
    const lineHits = new Map();
    for (const [id, loc] of Object.entries(fileCov.statementMap)) {
      const hit = fileCov.s[id] || 0;
      const ln = loc.start.line;
      lineHits.set(ln, Math.max(lineHits.get(ln) || 0, hit));
    }
    const sorted = [...lineHits.entries()].sort((a, b) => a[0] - b[0]);
    const covered = sorted.filter(([, h]) => h > 0).length;
    files.push({ file, covered, total: sorted.length, pct: sorted.length ? (100 * covered / sorted.length) : 0 });
    lcovParts.push([
      'TN:',
      `SF:${filePath}`,
      ...sorted.map(([ln, h]) => `DA:${ln},${h}`),
      `LF:${sorted.length}`,
      `LH:${covered}`,
      'end_of_record',
    ].join('\n'));
  }

  fs.writeFileSync(LCOV_OUT, lcovParts.join('\n') + '\n');
  const covered = files.reduce((s, f) => s + f.covered, 0);
  const total = files.reduce((s, f) => s + f.total, 0);
  return { files, covered, total, pct: total ? (100 * covered / total) : 0, out: LCOV_OUT };
}

module.exports = { appendRawCoverage, writeLcov, isClientEntry, RAW_FILE };
