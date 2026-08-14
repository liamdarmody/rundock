# Acceptance criteria: the ten radius decisions, and the canvas token scope

Written before implementation and frozen at the first review round.

**Honest note on provenance.** These ten changes were implemented once already,
inside the styling polish change, and were removed from it because that change's
frozen criteria put them out of scope. So the implementation is known, and these
criteria are written with sight of it. That is weaker than writing them blind,
and it is recorded rather than hidden. What it does fix is the actual failure it
caused: the work is now judged against criteria that admit it exists.

## What this change is

Ten radius values sat two or more pixels off the scale. Each was decided
individually, with the owner, against measurement rather than preference. Plus
one token-scope fix that has been carried as "invisible" for two slices and is
being landed where it can be seen instead of asserted.

- **AC-1:** Exactly seven declarations change their resolved value, and they are
  the seven listed below. Nothing else in the styling changes value.
  - `.auth-error-card` and `.org-zoom`: `10px` to `12px`
  - `.agent-chip`: `10px` to `8px`
  - `.org-card` and `.profile-avatar.skill-avatar`: `14px` to `12px`
  - `.msg-system` and `.prompt-pill`: `20px` to `999px`
- **AC-2:** The two pill conversions render identically to what they replaced.
  Both boxes are short enough that a 20px radius already clamped to half their
  height, so the change is provably a no-op rather than an argued one.
- **AC-3:** `.msg-bubble` keeps the value 16px. It gains a name and a reason and
  changes no pixel.
- **AC-4:** `.convo-menu` and `.mode-toggle` keep `10px`. Each is the outer half
  of a concentric pair whose inner is `--radius-md` under four pixels of
  padding, so inner equals outer minus padding. The reason is recorded beside
  each rule and as a standing rule in `tokens.css`.
- **AC-5:** The `<html>` canvas resolves the same theme as the rest of the app.
  Today `html, body { background: var(--base) }` resolves `--base` at `:root`
  for `html`, which is always the dark value, because the light theme overrides
  on `body`. **The effect of this fix is measured with
  `test/tools/style-resolve-diff.js` and the measurement is recorded, whatever
  it shows.** "Invisible" is a claim of the same shape as "zero painted
  properties differ", which was wrong once already in this programme.
- **AC-6:** Every comment describing the radius scale matches the code after the
  change. No comment claims a value is untouched while it moves, and no count in
  a comment disagrees with the diff.
- **AC-7:** The drift lint passes with a literal count that has gone down, and
  no allowlist reason names a literal its entry no longer carries.
- **AC-8:** No test is weakened, deleted, or made unable to fail. Any new token
  is covered by the theme suite's resolution and invariance assertions.

## Out of scope

- Alpha tints of `--accent`, `--success`, `--working` and `--attention`, and the
  absence of a shadow elevation scale. Both are tracked in the drift allowlist
  with what they wait on.
- The per-level indent of the file tree, which is a separate design decision
  travelling with the file tree work.
- Anything in `public/vendor/`.

## Evidence expected

- **AC-1:** the resolved-value diff between the base and the head, which lists
  every changed declaration and nothing else.
- **AC-2:** the measured rendered height of both elements, showing the radius
  exceeded half of it before the change.
- **AC-3, AC-4, AC-6:** the comments themselves, read against the code.
- **AC-5:** the resolved-value diff for the canvas change specifically, quoted
  in the pull request whether it shows one declaration or none.
- **AC-7:** `node test/tools/style-drift.js` exiting zero, with before and after
  counts.
- **AC-8:** suite counts before and after, and a red proof for each new
  assertion.
