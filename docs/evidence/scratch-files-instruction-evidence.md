# Agents are told the full path of the workspace scratch folder: red on main and eight deliberate breaks

**This file is a dated record of runs on one machine, not a source of truth.**
Every claim below is re-measured by the named tests on every run of the
suite. If this file and those tests ever disagree, the tests are right.

Taken on 2026-11-12 on macOS (Darwin 25.4.0, arm64) with Node 24.12.0. The
merge base is `bd0bd815`. The sections up to and including the five breaks
were taken at `7ecfefb9`. The last section, on the Codex thread, was taken at
`40545abe`, apart from its closing part on the scratch folder, which was taken
at `e559ee33`, the last commit to change code or tests; the commit after it
changes only this file. `40545abe` replaced the in-process Codex test, so the
two tests named "notes mode: the first turn carries the paragraph, and the
folder is inside what Codex may write" and its code mode twin in the earlier
sections no longer exist: the integration test in the last section takes
their place.

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

---

## A Codex thread, through the real server and the stub Codex

Taken at `40545abe`. The test is
`test/integration/codex-scratch-files.test.js`. It boots the real server
against a fixture workspace that has a Codex agent, with the stub `codex`
binary from `test/helpers/stub-codex/` on the path. It sets Notes mode and
then Code mode with `set_workspace_mode` over the WebSocket, and in each sends
one message to the Codex agent and then one to a Claude Code agent. It reads
back the requests the stub received from the real app-server client over the
JSON-RPC transport on stdio, from the log the stub appends to in the fixture
workspace. The stub and the harness were not changed: the stub already logs
every request it receives with its params.

**What it proves, from what the stub received.**

- The first `turn/start` on a new thread carries the SCRATCH FILES
  paragraph, byte for byte the paragraph the stub `claude` received in
  `--append-system-prompt` for a Claude Code agent in the same workspace and
  mode.
- The folder the paragraph names is the workspace root joined with
  `.rundock/scratch`, with a trailing separator.
- `thread/start` is, in full, `cwd` set to the workspace root, `sandbox`
  `workspace-write`, `approvalPolicy` `on-request` and `approvalsReviewer`
  `user`: no writable roots, no `config` override, no profile.
- The turn runs on that thread and sends only `threadId` and `input`: no
  per-turn `cwd` or `sandboxPolicy`, either of which would take precedence
  over the thread's own. So the folder named is inside the cwd of a
  `workspace-write` thread.

**What it cannot prove.** Whether Codex's sandbox lets a command write, read
and delete a file in that folder without an approval request. That
enforcement is Codex's own code, and the real binary needs a signed-in
account, so it cannot run in this suite. The stub answers only what a test
scripts it to answer, so making it perform the write would test the stub,
not Codex.

**What that half rests on.** The sandbox options Rundock sends, listed above,
and what Codex does with them, as recorded in
`docs/protocol/codex-app-server/RESEARCH.md`: section 3, where a
`thread/start` with this `cwd` and `sandbox` is answered with a
`workspaceWrite` sandbox and the cwd as the workspace root; section 5,
"Sandbox interaction", where under `workspace-write` with `on-request` a
write inside the cwd or a writable root runs with no approval request and
only an escalation, such as a write outside them, asks; and section 8, where
per-turn settings take precedence over the thread's, which is why the test
pins that the turn sends none. Section 5 describes the macOS sandbox
(Seatbelt). `docs/RUNTIME-ADAPTER.md`, section 3 "Approvals", records the same
from a measurement against codex-cli 0.156.1 with the thread options above:
a write inside the workspace never escalates, a delete inside the workspace
runs without escalating, and reads never escalate. The comment at the top of
`lib/workspace/answer-file-guard.js` names files under `.rundock/` among the
writes measured, by file edit and by shell redirect. On Windows without the
native sandbox configured, the same section says every action escalates, so
there a scratch write arrives as an approval request for Rundock to grade.

**Red on main.**

    node scripts/red-first.js --tests "node --test --require ./test/helpers/account-home-refused.js \
      test/integration/codex-scratch-files.test.js test/unit/scratch-files-instruction.test.js \
      test/unit/agent-scratch-rule.test.js test/unit/doc-claims.test.js"

At `40545abe`, measured against `origin/main`: PROVEN. With the change, 131
tests pass. With the source put back as on `main` (2 files:
`lib/agents/prompt.js`, and this file, which no test reads) and the tests
kept (3 test files), 12 of them fail: both tests in the new file, "notes
mode: the first turn carries the paragraph naming the scratch folder, and the
thread may write there" and its code mode twin, and the ten tests of
`test/unit/scratch-files-instruction.test.js` and
`test/unit/agent-scratch-rule.test.js` that failed on `main` in the section
above. The new tests fail on "the paragraph names a folder": `main`'s
paragraph says to use the path in `$TMPDIR`. The byte-for-byte comparison
alone passes on `main`, since both runtimes get the same old paragraph; the
folder is what fails.

**The deliberate break.** In `lib/runtime/codex-glue.js`, the first-turn
prompt built from `buildSystemPrompt(agentData).replace(/SCRATCH FILES:\n.*\n/, '')`,
on a copy made outside the working tree, copied in, run, and put back with
`git checkout`. Both tests in `test/integration/codex-scratch-files.test.js`
fail, on "the prompt has a SCRATCH FILES section". In the same state
`test/unit/scratch-files-instruction.test.js` (9),
`test/unit/agent-scratch-rule.test.js` (5) and `test/unit/doc-claims.test.js`
(115) all pass, so this test is the one that catches the Codex path dropping
the paragraph.

Red on main cannot show that the sandbox half bites, because the thread
options are the same on `main`. So one more break, made the same way: in
`lib/runtime/codex-glue.js`, the thread started with `sandbox: 'read-only'`.
Both tests fail, on "workspace-write, rooted at the workspace, with nothing
narrowing it".

After both breaks were put back, at `40545abe`:
`test/integration/codex-scratch-files.test.js` 2 of 2,
`test/unit/scratch-files-instruction.test.js` 9 of 9,
`test/unit/agent-scratch-rule.test.js` 5 of 5,
`test/integration/codex-chat.test.js` 18 of 18,
`test/integration/codex-sandbox-config.test.js` 2 of 2 and
`test/unit/doc-claims.test.js` 115 of 115 passed, each file run on its own.

**The folder exists for a Codex agent.** Taken at `e559ee33`. Until then
only the Claude Code spawn environment made `<workspace>/.rundock/scratch/`.
In a fixture where only a Codex agent had run, the folder did not exist
before or after the turn, so a Codex agent that wrote a scratch file there by
shell redirect, as the paragraph tells it to, would have got "No such file or
directory". `e559ee33` moves the folder creation, with its `.gitignore`
marker holding `*`, out of `getSpawnEnv` into `ensureScratchDir()` in
`lib/runtime/claude.js`, which returns the folder or null and never throws.
`getSpawnEnv` calls it and sets `TMPDIR`, `TEMP` and `TMP` as before, and
`openCodexThread` in `lib/runtime/codex-glue.js` calls it before the thread
is opened. There is no require cycle: `codex-glue.js` already loaded
`claude.js` through `lib/agents/prompt.js`, and nothing `claude.js` loads
reaches `codex-glue.js`.

The stub `codex` gained one scenario option, `observePaths`: with every
request it logs what each listed path held as the request arrived (null when
missing, "dir", or a file's text). The test is
`test/integration/codex-scratch-folder.test.js`. It sends messages only to a
Codex agent, never to a Claude Code agent, takes the folder away before each
mode, and asserts that when `thread/start` reached the stub the folder was
there and its `.gitignore` held `*` followed by a newline, in Notes mode and
Code mode, and that it is the folder the first turn names.

- Red with the source as at `4432aa2c`, the head before the change, and the
  new test and stub option in place: both tests fail, the folder and its
  marker both null when `thread/start` arrived.
- `scripts/red-first.js` at `e559ee33` with this test,
  `test/integration/codex-scratch-files.test.js`,
  `test/unit/scratch-files-instruction.test.js`,
  `test/unit/agent-scratch-rule.test.js`, `test/unit/boundary.test.js` and
  `test/unit/doc-claims.test.js`, against `origin/main`: PROVEN. 213 pass
  with the change. With the source put back as on `main` (4 files) and the
  tests kept (5 files, the stub among them), 14 fail: the 12 named above and
  the two new tests.
- The deliberate break: the `ensureScratchDir()` call taken out of
  `openCodexThread`, made the same way as the others. Both new tests fail on
  "the folder, ignoring itself, was there when the thread was asked for",
  while `test/integration/codex-scratch-files.test.js` (2),
  `test/unit/scratch-files-instruction.test.js` (9),
  `test/unit/agent-scratch-rule.test.js` (5) and `test/unit/boundary.test.js`
  (80) all pass.

After it was put back, at `e559ee33`, each file run on its own:
`test/integration/codex-scratch-folder.test.js` 2 of 2,
`test/integration/codex-scratch-files.test.js` 2 of 2,
`test/unit/scratch-files-instruction.test.js` 9 of 9,
`test/unit/agent-scratch-rule.test.js` 5 of 5, `test/unit/boundary.test.js`
80 of 80, `test/integration/codex-chat.test.js` 18 of 18 and
`test/unit/doc-claims.test.js` 115 of 115. Because the stub changed, every
other test file that drives the stub `codex`, `lib/runtime/codex-glue.js` or
the spawn environment was run as well, 59 files in all, each on its own, and
none failed. One of them, `test/unit/code-mode-replay.test.js`, skipped itself
(its fixture's `root.skip`) and ran no tests.

The spawn environment's code changed at `e559ee33`, where the section above
says it is as on `main`: the folder creation moved into `ensureScratchDir()`,
and what `getSpawnEnv` does is the same, including leaving `TMPDIR`, `TEMP`
and `TMP` at the platform default when the folder cannot be made.
