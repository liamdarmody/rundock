'use strict';
// What review artefacts this repository keeps, and what it refuses to keep.
//
// Rundock is public. Some changes here are checked by a review harness that is
// not part of this project and is not needed to build, test or release it. Two
// rules follow, and both are easy to undo by accident:
//
//   1. The verdict ledgers stay. They are hashes, counts, model names and
//      finding fingerprints, with no prose, and each row carries the hash of
//      the criteria it was judged against, so a verdict stays verifiable even
//      though those criteria are not here.
//   2. Nothing else does. Configuration for software that is absent, and
//      documents recording a standard applied to one past change, are not
//      actionable by anyone reading this repository and would need maintaining
//      for no reader.
//
// The second rule has no natural enforcement: a file added under a plausible
// name simply sits there. Hence this.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

function tracked() {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf-8' })
    .split('\n').filter(Boolean);
}

function isIgnored(rel) {
  try {
    execFileSync('git', ['check-ignore', '-q', rel], { cwd: ROOT });
    return true;
  } catch { return false; }
}

describe('review artefacts', () => {
  test('every verdict ledger is tracked', () => {
    const ledgers = tracked().filter(f => /^\.independent-review\/.*\.jsonl$/.test(f));
    assert.ok(ledgers.length > 0, 'at least one ledger must be tracked');
    for (const f of ledgers) {
      assert.strictEqual(isIgnored(f), false, `${f} is tracked but also matched by an ignore rule`);
    }
  });

  test('a ledger added later would also be tracked, not ignored', () => {
    // The rule is a wildcard, so this asserts the RULE rather than the files
    // that happen to exist today.
    assert.strictEqual(isIgnored('.independent-review/some-future-change.jsonl'), false);
  });

  test('written findings are not tracked', () => {
    // Round directories hold the reviewer's prose. It is not source, it does
    // not survive review, and it would have to satisfy a hygiene check that
    // has no business policing a reviewer's writing.
    assert.strictEqual(isIgnored('.independent-review/round-1/report.md'), true);
    const prose = tracked().filter(f => /^\.independent-review\/.*\.(md|txt)$/.test(f));
    assert.deepStrictEqual(prose, [], 'no prose from a review round may be tracked');
  });

  test('no configuration for absent tooling is tracked', () => {
    // A config file for software that is not in this repository cannot be
    // acted on by anyone reading it, and a reviewer holding only a diff cannot
    // verify a value in it. Both were true when one was here.
    const configs = tracked().filter(f => /(^|\/)independent-review\.config\.json$/.test(f));
    assert.deepStrictEqual(configs, [], 'the review harness is not part of this project');
  });

  test('no private review standard is tracked', () => {
    // Acceptance criteria record a standard applied to one past change. They
    // are engineering evidence, and they belong with the harness rather than
    // in a public repository where nobody can act on them.
    const criteria = tracked().filter(f => /criteria.*\.md$/i.test(f) || /^docs\/review\//.test(f));
    assert.deepStrictEqual(criteria, []);
  });
});
