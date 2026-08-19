'use strict';
// What review artefacts this repository keeps, and what it refuses to keep.
//
// Rundock is public. Some changes here are checked by a review harness that is
// not part of this project and is not needed to build, test or release it.
// NOTHING that harness produces is tracked here.
//
// This reverses an earlier rule, and the reason is worth keeping, because the
// earlier rule was stated confidently and was wrong in a way that reads as
// right. It kept the verdict ledgers on the grounds that each row carries the
// hash of the criteria it was judged against, "so a verdict stays verifiable
// even though those criteria are not here". Those two halves contradict each
// other. A hash is only verifiable against the document it hashes, and that
// document is not in this repository, so no reader with a clone can resolve a
// single row. What was kept was the FEELING of an audit trail.
//
// The test that replaces it is the same shape as the one it replaces: state
// the rule, not the files that happen to exist today.
//
// What a reader of this repository gets instead is the part they can actually
// use. Every pull request says what was judged, by which models, and what the
// verdict was, in prose, in the language of the change rather than the
// language of the board.
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
  test('nothing under the review directory is tracked', () => {
    const found = tracked().filter(f => f.startsWith('.independent-review/'));
    assert.deepStrictEqual(found, [], 'review output belongs with the criteria it cites, not here');
  });

  // Asserts the RULE rather than the files that exist today, so a later
  // artefact under a plausible name cannot arrive tracked. The three shapes
  // cover what the harness actually writes: a verdict ledger, a round's
  // findings, and whatever a future version names its output.
  test('a review artefact added later would be ignored, whatever it is called', () => {
    for (const rel of [
      '.independent-review/some-future-change.jsonl',
      '.independent-review/round-1/report.md',
      '.independent-review/anything-at-all',
    ]) {
      assert.strictEqual(isIgnored(rel), true, `${rel} must be ignored`);
    }
  });

  test('no configuration for absent tooling is tracked', () => {
    // A config file for software that is not in this repository cannot be
    // acted on by anyone reading it, and a reviewer holding only a diff cannot
    // verify a value in it. Both were true when one was here.
    //
    // Matched by SHAPE rather than by the one filename that was here before,
    // so review-harness.config.json or .independent-reviewrc are caught too.
    //
    // The limit, stated because an earlier comment claimed more than the
    // pattern delivers: it keys on the word "review" in the filename. A config
    // reintroduced as irconfig.json would NOT be caught. Widening it to every
    // config-shaped file at the repository root was rejected as worse, since it
    // would fail an ordinary application config for no reason a reader could
    // guess. This catches renaming, not deliberate disguise.
    const CONFIG_SHAPED = /(^|\/)\.?[\w.-]*review[\w.-]*\.(config\.)?(json|ya?ml|toml|rc)$|(^|\/)\.[\w-]*reviewrc$/i;
    const configs = tracked().filter(f => CONFIG_SHAPED.test(f));
    assert.deepStrictEqual(configs, [], 'the review harness is not part of this project');
  });

  test('no private review standard is tracked', () => {
    // Acceptance criteria record a standard applied to one past change. They
    // are engineering evidence, and they belong with the harness rather than
    // in a public repository where nobody can act on them.
    //
    // Matched by NAME, not by directory. An earlier version banned everything
    // under docs/review/, which would have failed a future contributor adding
    // a legitimate review-process guide there, for a reason neither this test's
    // name nor its comment mentions. A rule wider than its stated intent is a
    // trap for whoever trips it.
    const criteria = tracked().filter(f => /criteria.*\.md$/i.test(f));
    assert.deepStrictEqual(criteria, []);
  });

  // The build journal left for the same reason, and left a shaped hole: it is
  // the one artefact here that a future session is most likely to recreate,
  // because appending to it was a written ritual for a while. Ignoring the
  // directory does not stop a file arriving at docs/ under a new name, so the
  // rule is stated against the repository's own standard rather than against
  // one filename: a tracked file may not carry board card ids, which is
  // enforced by scripts/check-internal-refs.js and is what caught this one.
  test('the build journal has not come back', () => {
    const journals = tracked().filter(f => /build-ledger|build-journal/i.test(f));
    assert.deepStrictEqual(journals, [], 'the build journal is a working log, not reference material');
  });
});
