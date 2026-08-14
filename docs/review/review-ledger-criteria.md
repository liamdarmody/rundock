# Acceptance criteria: one review ledger per change

Written before implementation and frozen at the first review round.

## Why

A ledger records the rounds for one frozen criteria file. It was configured per
repository, so the next change with its own criteria inherited the previous
change's rounds. The harness then saw a criteria hash it had not judged, escalated
without reviewing anything, and quoted a round number carried over from work it
never saw.

That is the freeze control working exactly as designed. The configuration was
wrong, not the control. It happened twice on one change: the second time because
this fix was pulled out of an unrelated pull request for being out of scope,
which reinstated the bug it fixes.

## Criteria

- **AC-1:** A ledger path ending in `/` is treated as a directory, and the
  ledger is named after the criteria file.
- **AC-2:** A second change with different criteria starts its own series at
  round one rather than continuing the first change's count.
- **AC-3:** The directory itself is never opened or appended to as a file.
- **AC-4:** Existing behaviour is unchanged when the path names a file, so a
  project configured the old way keeps working.
- **AC-5:** AC-1 to AC-3 are covered by the skill's acceptance suite and fail
  when the handling is reverted.
- **AC-6:** Every per-change ledger is tracked in git. Round directories stay
  untracked: they carry reviewer prose, which trips the repository's hygiene
  check.

## Out of scope

- What the reviewer judges, and how rounds are capped.
- The styling changes this was extracted from.

## Evidence expected

- **AC-1 to AC-3, AC-5:** the skill's acceptance suite, with a red proof from
  reverting the handling.
- **AC-4:** the file-path branch still exercised by the rest of the suite.
- **AC-6:** `git check-ignore` for a ledger and for a round directory.

## A note on the data in this change

`radius-decisions-criteria.jsonl` carries a `reconstructed` field on both rows.
The original file was lost to mishandled git operations while extracting this
fix, and the rows were rebuilt from the surviving round reports. Verdicts,
hashes and blocking counts are recovered; original timestamps are not.

It is included, marked, rather than restarted clean. These ledgers are being
used to judge whether independent review earns its place in the process, so a
gap that hides two spent rounds would corrupt the thing they exist to measure.
A repaired dataset that admits the repair is usable. A silently repaired one is
worse than a missing one.
