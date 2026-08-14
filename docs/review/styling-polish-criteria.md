# Acceptance criteria: styling polish pass

**Honest note on freezing.** These were written immediately before the first
review round and after implementation, not before it. That is weaker than the
harness intends and it is recorded here rather than hidden: a criterion written
after the code can be shaped by the code. Later slices write them first.

- **AC-1:** Every declaration whose resolved value changes is either a
  deliberate visual change or a provable no-op, and no declaration changes that
  was not intended to.
- **AC-2:** No colour, radius or duration literal is introduced anywhere except
  `public/styles/tokens.css`.
- **AC-3:** Every reason in the drift allowlist matches what its literals
  actually are, including the corrected claim that `#1a1a1a` is deliberate dark
  text on a bright status fill rather than a theme bug.
- **AC-4:** Removing the eight `var(--danger, #fallback)` fallbacks cannot
  change what renders, because `--danger` is defined for every document that
  loads those rules.
- **AC-5:** Each `color-mix` tint resolves to the same colour as the `rgba()`
  literal it replaces, or differs only by the difference between the two reds
  being unified.
- **AC-6:** `--radius-xs: 3px` and `--radius-pill: 999px` are justified by
  values already in use, not invented to make a scale look complete.
- **AC-7:** No test was weakened, deleted, or made unable to fail.

## Out of scope

- The ten radius values that sit two or more pixels off the scale, including
  `.msg-bubble` at 16px. Those are design decisions and are going to the owner
  with screenshots rather than being decided here.
- Alpha tints of `--accent`, `--success`, `--working` and `--attention`, and
  the absence of a shadow elevation scale. Both are tracked in the drift
  allowlist with what they wait on.
- Anything in `public/vendor/`, which is third-party.

## Evidence expected

- **AC-1:** the resolved-value diff between `HEAD~1` and `HEAD`, which lists
  every changed declaration and nothing else.
- **AC-2:** `node test/tools/style-drift.js` exits zero, with a literal count
  that has gone down rather than up.
- **AC-3:** the allowlist reason read against the literals it covers.
- **AC-4:** the token's definition, and the fact that every rule carrying a
  fallback is loaded into a document where `:root` defines `--danger`.
- **AC-5:** the channel values of the reds either side of each substitution.
- **AC-6:** occurrence counts of `3px` and of the two pill spellings before the
  change.
- **AC-7:** the test count before and after, and the diff of anything under
  `test/`.
