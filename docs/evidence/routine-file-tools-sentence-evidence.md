# A Claude Code routine is told to change files with its file tools: red on main and two deliberate breaks

**This file is a dated record of runs on one machine, not a source of truth.**
Every claim below is re-measured by the named tests on every run of the
suite. If this file and those tests ever disagree, the tests are right.

Taken on 2026-11-11 on macOS (Darwin 25.4.0, arm64) with Node 24.12.0, at
`c32ffffa`, the last commit to change code or tests; the commit after it adds
only this file. The merge base is `3017ad72`.

---

## What changed

The line every Claude Code routine is given before it starts
(`UNATTENDED_RUN` in `scripts/refusal-notice.js`, passed with
`--append-system-prompt`) gains one sentence, straight after "Save the work in
the workspace as you go." and before the closing `RUN STATUS` sentence:

> To create, change or copy a file in the workspace, use your file tools (Write and Edit) rather than the shell: a shell command that changes files can need an approval that nobody here can give.

A Codex routine's developer instructions (`UNATTENDED_RUN_CODEX`) are byte for
byte what `main` sends. Both lines are built from the same parts, stay one
line, and end on `FAILED_LINE`. `refusalNotice`, `unansweredNotice`,
`UNATTENDED_NEXT` and `FAILED_LINE` are unchanged, and a test pins their text.
No file that decides a permission is touched.

---

## Red on main

    node scripts/red-first.js --repo <worktree> --tests "node --test --test-timeout=120000 \
      test/integration/routine-unattended-line.test.js test/unit/doc-claims.test.js"

These are the two test files this branch changes against `origin/main`; it
adds none.

At `c32ffffa`, measured against `origin/main`: PROVEN. With the change, 120
tests pass. With the source put back as on `main` (3 source files) and the
tests kept, 6 of them fail:

- the line says what a refused step is also told, and contradicts none of it
- a Claude Code routine is told to change files with its file tools; a Codex routine is told what it always was
- a routine on Claude Code in Notes mode carries the line, file tools and all, in its system prompt, and its routine prompt is unchanged
- a routine on Claude Code in Code mode carries the line, file tools and all, in its system prompt, and its routine prompt is unchanged
- a routine on Codex carries the line in its thread's developer instructions, and its turn input is unchanged
- a Claude Code routine is told to use its file tools, and a Codex routine is not, as the page says

"what a refused step is told, and the failure line, are unchanged" passes on
both sides, as it should: it pins `main`'s text.

---

## Two deliberate breaks

Each was made by hand in the working tree at `c32ffffa`, run with

    node --test --test-timeout=120000 test/integration/routine-unattended-line.test.js test/unit/doc-claims.test.js

and then put back with `git checkout`. With nothing broken, all 120 pass.

**1. The sentence removed from the Claude Code line.** In
`scripts/refusal-notice.js`, `UNATTENDED_RUN` built as
`` `${RUN_OPENS} ${RUN_ENDS}` ``. 4 of 120 fail:

- a Claude Code routine is told to change files with its file tools; a Codex routine is told what it always was
- a routine on Claude Code in Notes mode carries the line, file tools and all, in its system prompt, and its routine prompt is unchanged
- a routine on Claude Code in Code mode carries the line, file tools and all, in its system prompt, and its routine prompt is unchanged
- a Claude Code routine is told to use its file tools, and a Codex routine is not, as the page says

**2. The sentence given to the Codex thread.** Made two ways, since either
would reach a Codex routine.

- In `lib/scheduler.js`, the Codex thread started with
  `developerInstructions: UNATTENDED_RUN`, the Claude Code line, as on `main`.
  1 of 120 fails: a routine on Codex carries the line in its thread's
  developer instructions, and its turn input is unchanged.
- In `scripts/refusal-notice.js`, `UNATTENDED_RUN_CODEX` built as
  `` `${RUN_OPENS} ${RUN_FILE_TOOLS} ${RUN_ENDS}` ``. 3 of 120 fail: a Claude
  Code routine is told to change files with its file tools; a Codex routine is
  told what it always was; a routine on Codex carries the line in its thread's
  developer instructions, and its turn input is unchanged; and a Claude Code
  routine is told to use its file tools, and a Codex routine is not, as the
  page says.
