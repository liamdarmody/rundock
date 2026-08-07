'use strict';
// Unit: every script under scripts/ must parse.
//
// This exists because a broken one shipped. A comment rewrite put an
// apostrophe inside a single-quoted string in the screenshot pipeline, which
// terminated the string and left the file unparseable. It merged: the full
// suite was green, CI was green, and review saw a documentation change.
//
// Nothing covered it because scripts/ is tooling rather than product. Tests do
// not import it, the app does not load it, and it only runs when someone runs
// it by hand, so the failure surfaced days later as a stack trace instead of
// at the point of change.
//
// A syntax check is the cheapest thing that would have caught it. It is not a
// substitute for exercising the pipeline, which needs a browser and minutes of
// wall clock; it is the floor beneath that: whatever else is untested, the
// files at least parse.
//
// Deliberately `node --check` in a child process rather than import(): several
// of these modules run work on import, so importing them here would launch
// browsers and servers inside the unit suite.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = path.join(ROOT, 'scripts');

function collect(dir, out = []) {
  // Deliberately NOT swallowing a read failure. Skipping an unreadable
  // directory would let the suite pass while checking less than it claims,
  // which is the single way this guard could report a false all-clear.
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (item.name === 'node_modules') continue;
      collect(full, out);
    } else if (/\.(mjs|cjs|js)$/.test(item.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('scripts parse', () => {
  const files = collect(SCRIPTS);

  test('there is something to check', () => {
    assert.ok(files.length > 0, `no scripts found under ${SCRIPTS}`);
  });

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    test(rel, () => {
      try {
        // --check parses without executing, which is the point: several of
        // these modules would launch browsers and servers on import.
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      } catch (e) {
        const detail = (e.stderr ? e.stderr.toString() : '') || e.message;
        assert.fail(`${rel} does not parse:\n${detail}`);
      }
    });
  }
});
