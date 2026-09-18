'use strict';
// NO TEST MAY POST A PERMISSION REQUEST TO A LIVE RUNDOCK.
//
// `scripts/permission-hook.js` reads `process.env.RUNDOCK_PORT || 3000`. A test
// that arms the real hook (RUNDOCK=1) without pinning that port sends its
// fabricated request to whatever is serving 3000, which in development is the
// author's own Rundock.
//
// This is not hypothetical and it is not cosmetic. Reported from the field: a
// permission storm arrived in a live conversation with no agent behind it,
// eleven cards naming temp directories carrying the test suite's own fixture
// prefixes, every one of them asking the reader to approve a change to a
// permissions file in a directory they had never heard of. The cause was
// `npm test` running in another terminal. The cards carry no conversation id,
// so they land in whatever conversation happens to be open.
//
// The damage is to the only thing a permission card has, which is that it means
// something. A person taught to dismiss a stream of cards they cannot account
// for is a person who will dismiss the one that matters.
//
// A COMMENT WOULD NOT HAVE HELD THIS. The three sites that caused it each
// looked locally reasonable, and the one integration test that got it right was
// no help to the unit tests that did not. So it is checked mechanically, on the
// text, the way this repository checks its other cross-file agreements.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TEST_ROOT = path.join(__dirname, '..');

function everyTestFile(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) everyTestFile(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// The env object a spawn is given, as source text: from `env` up to the closing
// brace of that object literal. Crude on purpose. It only has to be right about
// whether two names appear together in one object, and being crude keeps it
// from quietly stopping working when the surrounding code is reformatted.
const ENV_OBJECT = /env\s*:?\s*=?\s*\{[^{}]*\}/g;

test('a test that arms the real permission hook always pins the port', () => {
  const offenders = [];
  let armed = 0;
  for (const file of everyTestFile(TEST_ROOT)) {
    if (file === __filename) continue;
    const src = fs.readFileSync(file, 'utf-8');
    for (const m of src.match(ENV_OBJECT) || []) {
      // Armed: this env turns the hook from a pass-through into a poster.
      if (!/\bRUNDOCK\s*:\s*['"]1['"]/.test(m)) continue;
      armed++;
      if (/RUNDOCK_PORT/.test(m)) continue;
      const line = src.slice(0, src.indexOf(m)).split('\n').length;
      offenders.push(`${path.relative(TEST_ROOT, file)}:${line}`);
    }
  }
  // THE FLOOR IS WHAT MAKES THIS GUARD REAL, and without it this is the exact
  // shape of guard it exists to prevent: an extraction that stops matching
  // reports no offenders and passes forever, protecting nothing. The armed
  // sites are known to exist (three in workspace-boundary, one in the boundary
  // integration test), so finding none means the pattern broke, not that the
  // repository got safer.
  assert.ok(armed >= 4,
    `the scan found only ${armed} armed env objects, so ENV_OBJECT has stopped matching. `
    + 'A zero-offender result from a broken pattern is not a pass.');
  assert.deepStrictEqual(offenders, [],
    'these arm the real hook with RUNDOCK=1 but let RUNDOCK_PORT default to 3000, '
    + 'so they POST a permission card to whatever Rundock is running on this machine. '
    + 'Pin RUNDOCK_PORT to a port nothing listens on.');
});

test('the hook still defaults to 3000, which is why the rule above exists', () => {
  // If this default ever moves, the rule is still right but its reasoning is
  // stale, and a stale reason is how a guard gets deleted by someone tidying up.
  const src = fs.readFileSync(path.join(TEST_ROOT, '..', 'scripts', 'permission-hook.js'), 'utf-8');
  assert.match(src, /process\.env\.RUNDOCK_PORT\s*\|\|\s*3000/,
    'the production default is what makes an unpinned test dangerous');
});
