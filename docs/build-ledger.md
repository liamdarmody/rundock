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

---

## 2026-08-19: R0-01 diagnosis

**Card:** R0-01, body content renders above the properties panel after review
comments are added. **Slice:** root cause found and measured. No fix written yet.

**Root cause.** `.tiptap-editor-pane .properties` carries `overflow: hidden`
(`public/styles/views/editor.css:70`). Turning review mode on makes the pane a
grid (`public/editor/styles.js:147`), and `overflow: hidden` makes the panel a
scroll container, so in the block axis it contributes only its borders to the
size of its auto-sized grid row. The row collapses to 18px, being 2px of border
plus the panel's 16px margin, while the panel keeps its real 300px height. It
therefore overflows its own row and paints across the editor, which is correctly
placed in the row below. What a reader sees is the heading and the paragraphs
before the first thematic break sitting on top of the properties panel.

The thematic breaks are innocent. They only make the symptom look like a
segmentation defect, because the panel happens to be about as tall as the body
above the first break, so the overlap ends where that break begins. Both parse
steps were verified correct on a document of this shape before the layout was
examined.

**Measured, not reasoned.** With the real document open and one comment added,
the pane's resolved `grid-template-rows` read `18px 8241.78px 0px …`. Toggling
the panel's `overflow` between `hidden` and `clip` in the live page flipped row
one between 18px and 316px, repeatedly, in both directions. `overflow: clip`
clips exactly as before, corner radius intact, and does not make a scroll
container, so the row sizes from content again: the panel then measured
124-424 with the editor starting at 440, its 16px margin below, and zero
overlapping blocks.

**Why it needs a long document.** The row collapses only once the pane's content
overflows the pane's own scroll height. A short note lays out correctly, which is
why the first reproduction attempt on a synthetic three-section fixture came back
clean and looked like an absence of the defect rather than an absence of length.

**Next:** add the regression test at the shape named on the card (frontmatter,
several body thematic breaks, comment endmatter, long enough for the pane to
scroll), watch it fail, then change `overflow: hidden` to `overflow: clip` and
watch it pass. Then the round-trip assertion: adding a comment must not change
rendered order, and must leave every byte outside the endmatter block untouched.

**Invariants:** the byte-for-byte round-trip guarantee; token discipline and the
style drift lint; both themes; no build step.

**Surprises:** the card's own diagnosis order pointed at parse and segmentation
first, and both were sound. The cost of following it was small because the parse
check is quick; the lesson is that a symptom described in document terms was a
layout fault, and the geometry should have been measured first.
