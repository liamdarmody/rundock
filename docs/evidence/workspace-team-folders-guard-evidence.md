# A file tool's write into the workspace's agents and skills is refused: red first, the mutation run and the hand breakages

**This file is a dated record of runs on one machine, not a source of truth.**
Every claim below is re-measured by the named tests on every run of the
suite, and by the mutation harness whenever it runs. If this file and those
ever disagree, they are right.

Taken on 2026-11-13 on macOS (Darwin 25.4.0, arm64) with Node 24.12.0. The
base is `a97a96f8`. The last commit to change code is `5a608875`; the commit
after it adds only the mutation rows and this file. The two Code-mode suites
below (`test/unit/code-mode-boundary.test.js` and
`test/unit/what-runs-files.test.js`) ran with the Code-mode fixture folder
set: `RUNDOCK_TEST_OUTSIDE_TEMP_ROOT=<a folder outside every temp folder and git tree>`.

---

## What was closed

The permission hook allowed a Write, Edit, MultiEdit or NotebookEdit into the
workspace's `.claude/agents/` and `.claude/skills/` as in-workspace access. In
a conversation Claude Code refuses those writes itself; a routine runs it with
`--dangerously-skip-permissions`, and there a file-tool write into the agents
folder went ahead. `isWorkspaceTeamFolderEdit` in `scripts/permission-hook.js`
now refuses them before any card, saved answer, folder grant or mode, in Code
and Notes mode, in a conversation and in a routine.

---

## Red first

Every run below is `node --test <file>` from the worktree.

**`test/unit/workspace-team-folders.test.js`, as first committed (`a1ae43b1`),
against the code at `a97a96f8`:** 16 tests, 12 failed, 4 passed. The four that
passed are the tables of today's answers through the hook (one per mode and
run), which are meant to pass before and after. The 12 that failed:

- each file tool is refused, in Code mode and Notes mode, in a conversation
  and in a routine run (4);
- each spelling is refused by the check, in-process, and a case variant is
  refused exactly where the host folds case (2: the check did not exist);
- each spelling is refused through the hook, per mode and run (4);
- none of today's answers is refused by the check, in-process (1: the check
  did not exist);
- a routine run's Write of an agent file is denied, through the real hook
  process (1).

Each through-the-hook failure read `allow` with the reason
`In-workspace file access`.

**The sequence and wording tests, added to the same file, against the code at
`a1ae43b1`:** the file then held 34 tests, 30 failed and 4 passed (the same
four). The 18 new tests all failed: the inverse action (4), the undo (4), the
retry under saved answers and folder grants (4), the hand-over to Doc (2) and
the words of the refusal (4). The hand-over test was strengthened after this
run, to compare the Agent call's answer before and after the refusal; that
form was seen red under mutation row 1 and hand breakages 7 and 9, below.

**The existing tests changed to expect the refusal, and the doc pins,** each
run against the hook and `ARCHITECTURE.md` as committed at `a1ae43b1`, with the
test changes in place:

| File | Test | Result |
|---|---|---|
| `test/unit/doc-claims.test.js` | the workspace's agents and skills are refused to file tools, as the page and the hook say (3 tests) | 3 failed |
| `test/unit/code-mode-boundary.test.js` | this workspace's own agents are refused to a file tool, with no card | failed |
| `test/integration/boundary-permissions.test.js` | the copy-in path; a workspace opened under the runtime home is still a workspace | 2 failed |
| `test/unit/what-runs-files.test.js` | a write to each is ordinary work (Notes mode, Code mode) | 2 failed |

The `what-runs-files` run was made at `6bacb4d5` with the refusal's call site
replaced by `if (false) {`, rather than at `a1ae43b1`; for this test the two
answer the same.

**The fail-closed tests, against the code at `6bacb4d5`:** 5 tests, 5 failed.
The seam did not exist yet, so the in-process test failed on "the seam is a
module attribute", and each of the four through-the-hook tests read `allow`
for a Write to `notes/a.md` with the check forced to throw.

---

## The mutation run

    node test/tools/mutate-workspace-boundary-guards.js --rows 1162:1168

At `5a608875`, with the six rows this change adds, each applied alone with
`test/unit/workspace-team-folders.test.js` run against it. Each turned tests
red.

| Row | Tests red | Among them |
|---|---|---|
| the workspace check is removed | 31 | each file tool is refused, in every mode and run |
| case folding is dropped | 1 | a case variant is refused exactly where the host folds case, driven both ways through the seam |
| a prefix match also catches agents-old | 5 | none of them is refused by the check, in-process; each keeps today's answer through the hook (4) |
| a relative target is resolved against the home folder | 5 | each spelling is refused by the check, in-process; each spelling is refused through the hook (4) |
| NotebookEdit is left out | 9 | each file tool is refused (4); each spelling is refused, in-process and through the hook (5) |
| the check failing is treated as allow | 4 | a forced failure refuses, in every mode and run |

`test/unit/mutation-scope.test.js` passed afterwards (61 tests).

---

## The hand breakages

Each was applied to `scripts/permission-hook.js` at `5a608875`,
`test/unit/workspace-team-folders.test.js` run against it, and the file put
back with `git checkout`.

| Breakage | Tests red | Caught by |
|---|---|---|
| the refusal applied only in a routine's environment | 16 | each file tool is refused, in a conversation (2); each spelling, through the hook, in a conversation (2); the inverse action, the undo, the retry, the hand-over, the words and a forced failure, in a conversation (12) |
| the reason says the write was outside the workspace | 4 | the words, in every mode and run: "the write was inside the workspace, and is never said to be outside it" |
| the refusal moved after the saved-answer check (applied only to what the server did not allow) | 31 | each file tool is refused; each spelling through the hook; the routine's real hook process; every sequence; the words; a forced failure |

---

## Fix round

Taken on 2026-11-13 on the same machine and Node. The base is `e5abc029`.
Two changes, each in its own commit, then the mutation row and this section.

### A target in any path field is refused (`99a93c16`)

**What was wrong.** `isWorkspaceTeamFolderEdit` checked only the first path
field present (`file_path`, then `notebook_path`, then `path`). The runtime
writes the field its tool names, and `classifyFileAccess` reads that same
field (`FILE_TOOL_PATH_FIELD`). A NotebookEdit naming `<ws>/notes/a.md` in
`file_path` and `<ws>/.claude/agents/helper.md` in `notebook_path` was checked
as the note, and the classifier then allowed the agent write as in-workspace
access. A Write, Edit or MultiEdit with an extra `notebook_path` or `path` in
the folders, and a NotebookEdit with a number in `file_path`, slipped past the
same way.

**The change.** The check now looks at every path field the input carries
that is a non-empty string, and refuses if any of them is inside the two
folders. The call site was already independent of `refusalTarget` and
`targetInsideWorkspace`, so nothing computed from another field can skip it.
The existing refusals of the runtime home's folders keep their own target
choice, unchanged.

**Red first.** The new tests in `test/unit/workspace-team-folders.test.js`
("a target in those folders is refused in any path field, whatever the other
fields say": one in-process table and one through the hook per mode and run),
run against the code at `e5abc029`: 5 tests, 5 failed. Each through-the-hook
failure read `allow` with the reason `In-workspace file access` for the first
row, the NotebookEdit naming a note in `file_path` and an agent in
`notebook_path`. Each of the nine rows, put to the check in-process at
`e5abc029` with the folding seam both ways, returned `false`. At `99a93c16`
the file held 44 tests, all passing.

### Read, Glob and Grep of both folders keep today's answer (`6d771c7c`)

The table of what keeps today's answer had a Read and a Glob of the agents
folder and a Grep of the skills folder only. It now has each of the three
read tools on each folder: a Read of a skill file, a Glob of the skills
folder and a Grep of the agents folder were added. The rows are run
in-process with the folding seam both ways and through the hook in Code and
Notes mode, in a conversation and in a routine run, each its own subtest.

**The new rows pass on the base**, since they hold today's answer: against
the hook at `e5abc029`, the two table tests and their subtests ran 89 tests,
all passing, the three new rows among them in all six places each.

**Each new row red under a break.** With the check extended to Read, Glob and
Grep (`if (!CLAUDE_EDIT_TOOLS.has(toolName) && !READ_FILE_TOOLS.has(toolName))`),
the same run had 89 tests, 41 failed: all six read rows, the three new ones
among them, each in-process in both workspaces and through the hook in all
four modes and runs (36), and the five table tests that hold them.

### The mutation run

At `6d771c7c`, with the row this round adds:

    node test/tools/mutate-workspace-boundary-guards.js --rows 1168:1169

| Row | Tests red | Among them |
|---|---|---|
| only the first path field present is checked | 5 | a target in those folders is refused in any path field: in-process, and through the hook in every mode and run (4) |

Four earlier rows search the lines this round changed (case folding, the
prefix match, the relative target, NotebookEdit left out). Each was moved to
the new lines, breaking the same rule there, and the six earlier rows were
run again at `6d771c7c`:

    node test/tools/mutate-workspace-boundary-guards.js --rows 1162:1168

| Row | Tests red | Among them |
|---|---|---|
| the workspace check is removed | 35 | each file tool is refused; each spelling and each disagreeing-fields row through the hook; every sequence; the words; a forced failure |
| case folding is dropped | 1 | a case variant is refused exactly where the host folds case, driven both ways through the seam |
| a prefix match also catches agents-old | 6 | the `.claude/agents-old` and `.claude/skillset` rows, in-process in both workspaces and through the hook |
| a relative target is resolved against the home folder | 5 | each spelling is refused, in-process and through the hook (4) |
| NotebookEdit is left out | 14 | each file tool is refused (4); each spelling (5); each disagreeing-fields row (5) |
| the check failing is treated as allow | 4 | a forced failure refuses, in every mode and run |

The three hand breakages above change the call site, its placement and the
reason; none touches the lines this round changed, so they were not run
again. `test/unit/mutation-scope.test.js` (61 tests) and
`test/unit/mutation-harness-targets.test.js` (14 tests) passed afterwards.

---

## The last code commit

`99a93c16`.
