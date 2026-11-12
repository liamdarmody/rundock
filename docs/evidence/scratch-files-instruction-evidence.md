# Agents are told the full path of the workspace scratch folder: red on main and five deliberate breaks

**This file is a dated record of runs on one machine, not a source of truth.**
Every claim below is re-measured by the named tests on every run of the
suite. If this file and those tests ever disagree, the tests are right.

Taken on 2026-11-12 on macOS (Darwin 25.4.0, arm64) with Node 24.12.0, at
`7ecfefb9`, the last commit to change code or tests; the commit after it adds
only this file. The merge base is `bd0bd815`.

---

## What changed

The SCRATCH FILES paragraph of `buildSystemPrompt` (`lib/agents/prompt.js`)
used to tell every agent to use `$TMPDIR`, saying Rundock points it at a
scratch folder inside the workspace. It now reads, with `<workspace>` standing
for the open workspace's root:

> For a working file you write and read back yourself, use the folder `<workspace>/.rundock/scratch/`. It is inside this workspace, so reading a file back from there needs no approval. Do not use $TMPDIR, TEMP, TMP or /tmp for scratch: Rundock can't tell where a variable points when a command runs, and a shell command that reads a folder outside the workspace can raise an approval card every time, because no standing folder grant covers it. Clean up when you are finished.

The folder is `scratchDir()` from `lib/runtime/claude.js` with a trailing
separator: the same helper the spawn environment uses when it points `TMPDIR`,
`TEMP` and `TMP` at the folder, so the folder named and the folder created
cannot disagree. With no workspace open, `scratchDir()` returns null and the
paragraph names `.rundock/scratch/` in this workspace instead of building a
path from an empty root. The paragraph is the same in Notes mode and Code
mode, and a Codex thread receives it in its first turn.

Nothing that decides a permission is touched: `scripts/permission-hook.js`,
`scripts/code-mode-verdict.js`, `public/permissions.js`,
`public/read-only-shell.js`, `lib/http-router.js` and the spawn environment
in `lib/runtime/claude.js` are as on `main`.

---

## Red on main

    node scripts/red-first.js --tests "node --test --require ./test/helpers/account-home-refused.js \
      test/unit/scratch-files-instruction.test.js test/unit/agent-scratch-rule.test.js \
      test/unit/boundary.test.js test/unit/doc-claims.test.js"

The branch adds `test/unit/scratch-files-instruction.test.js` and changes the
text assertions in `test/unit/agent-scratch-rule.test.js`; the other two files
are run because they pin the scratch folder and the prompt's claims.

At `7ecfefb9`, measured against `origin/main`: PROVEN. With the change, 211
tests pass. With the source put back as on `main` (1 source file) and the
tests kept (2 test files), 12 of them fail:

- it names the folder the spawn points TMPDIR at, rather than the variable
- and says plainly not to use the variables or a literal temp path
- and says why, because "it needs approval" invites working around it
- notes mode: the full path, why it needs no approval, and why not the variables or /tmp
- code mode: the full path, why it needs no approval, and why not the variables or /tmp
- the folder named is the one the spawn environment creates and points TMPDIR at
- it says the same thing in both modes, and claims no approval for a write
- with no workspace open, no path is built from an empty root
- the named folder: the command runs, crosses no boundary, and the file reads as inside
- in Notes mode the paragraph is true as well: reading back needs no approval, and a change asks
- notes mode: the first turn carries the paragraph, and the folder is inside what Codex may write
- code mode: the first turn carries the paragraph, and the folder is inside what Codex may write

Two tests pass on both sides, as they should, because they pin what does not
change: "it runs because of the scratch folder: the same file elsewhere in the
workspace asks" and "through "$TMPDIR" the same command still always asks, for
unknown targets". The new test file was written before the change and run
against `main`'s source first, with the same split.

---

## Five deliberate breaks

Each was made on a copy of the file outside the working tree, copied in at
`7ecfefb9`, run with

    node --test --require ./test/helpers/account-home-refused.js \
      test/unit/scratch-files-instruction.test.js test/unit/agent-scratch-rule.test.js \
      test/unit/boundary.test.js test/unit/doc-claims.test.js

and then put back with `git checkout`. With nothing broken, all 211 pass.

**1. The paragraph put back to the `$TMPDIR` wording.** In
`lib/agents/prompt.js`, the paragraph line replaced with `main`'s, everything
else kept. 12 of 211 fail, the same 12 as on `main`.

**2. The paragraph naming a folder outside the workspace.** In
`lib/agents/prompt.js`, `const scratch = require('os').tmpdir();` in place of
`scratchDir()`. 8 of 211 fail:

- it names the folder the spawn points TMPDIR at, rather than the variable
- notes mode: the full path, why it needs no approval, and why not the variables or /tmp
- code mode: the full path, why it needs no approval, and why not the variables or /tmp
- the folder named is the one the spawn environment creates and points TMPDIR at
- with no workspace open, no path is built from an empty root
- in Notes mode the paragraph is true as well: reading back needs no approval, and a change asks
- notes mode: the first turn carries the paragraph, and the folder is inside what Codex may write
- code mode: the first turn carries the paragraph, and the folder is inside what Codex may write

"the named folder: the command runs, crosses no boundary, and the file reads as
inside" passes under this break, and that is correct rather than a gap: in
Code mode the system temp folder is a development path, where reads, writes
and deletes raise no card, so grading the command in Code mode cannot tell the
two folders apart. The prompt-text tests, the Notes-mode check and the Codex
check are what catch it.

**3. The path built from an empty workspace root.** In
`lib/agents/prompt.js`, the folder built as
`path.join(String(getWorkspace() || ''), path.sep, '.rundock', 'scratch')`,
which names `/.rundock/scratch/` when no workspace is open. 2 of 211 fail:

- it names the folder the spawn points TMPDIR at, rather than the variable
- with no workspace open, no path is built from an empty root

**4. The Codex path dropping the paragraph.** In `lib/runtime/codex-glue.js`,
the first-turn prompt built from
`buildSystemPrompt(agentData).replace(/SCRATCH FILES:\n.*\n/, '')`. 2 of 211
fail:

- notes mode: the first turn carries the paragraph, and the folder is inside what Codex may write
- code mode: the first turn carries the paragraph, and the folder is inside what Codex may write

**5. The paragraph claiming a write there needs no approval.** In
`lib/agents/prompt.js`, "Writing a file there needs no approval either." added
after the sentence about reading back. That is false in Notes mode, where a
shell command that changes files asks. 1 of 211 fails: it says the same thing
in both modes, and claims no approval for a write.

After the last break was put back, the same command passed 211 of 211.
