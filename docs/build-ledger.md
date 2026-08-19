# Build ledger

The checkpoint log for the Routines and Agent Computer build. Every card appends
here: before any context compaction, at session end or handoff, and at card
completion. A session resuming a card reads that card's most recent entry first.

## How to read an entry

| Field | Meaning |
|---|---|
| Card | The card id and title |
| Slice | Where the work stands inside the card |
| Next | The next concrete step, written so a cold reader can act on it |
| Invariants | The rules in play that the next step must not break |
| Surprises | What the code turned out to be, where it differed from the plan |

Entries are append-only. A later entry corrects an earlier one by saying so; the
earlier text stays, because the record of a wrong belief is worth keeping.

## Card ids

Release 0 hardening cards carry `R0-` ids assigned in pull order. Release 1 and 2
cards carry the ids from the card plan.

| Id | Card |
|---|---|
| R0-01 | Body content renders above the properties panel after review comments are added |
| R0-02 | Long URLs in review comment replies overflow the card |
| R0-03 | Markdown characters are escaped when a review suggestion is accepted |
| R0-04 | Tab indentation for list items is lost when the note contains callouts |

---

## 2026-08-19: build opens

**Card:** none yet. **Slice:** ledger initialised.

**Next:** pull R0-01 into its own worktree, reproduce the defect, and name the
root cause with file and line before writing any fix. That naming is the card's
first acceptance criterion, not a courtesy.

**Invariants in play at the start of the build:**

- One card, one session, one worktree. At most three cards in flight at once.
- No card is approved by the party that built it. Review runs on a different
  model, against the frozen criteria.
- The earlier research spike is reference only. Its concepts are re-implemented
  under a card with tests; no file is copied across.
- The locked mocks are acceptance criteria for visual work, checked against the
  file rather than from memory.
- Editor changes hold the byte-for-byte round-trip guarantee.

**Surprises:** two, both recorded now so no later session rediscovers them.

1. The scheduler's home changed after the architecture spec was written. The
   architecture spec places it in the Electron main process; the card plan
   amends it to the shared Node server layer so that behaviour is identical for
   the desktop app and for running from source. The card plan is the later
   document and the one the build executes, so the shared server layer is the
   binding placement. The consequence is a five-cell verification matrix rather
   than a single-platform check.
2. The four hardening cards are not the only entries tagged for this release on
   the board. The release tag appears throughout, including on shipped work. The
   four that gate the build are the ones sitting in the Ready column.
