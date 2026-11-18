# Every agent is told a routine is made with Add routine: red on main and seven deliberate breaks

**This file is a dated record of runs on one machine, not a source of truth.**
Every claim below is re-measured by the named tests on every run of the
suite. If this file and those tests ever disagree, the tests are right.

Taken on 2026-11-18 on macOS (Darwin 25.4.0, arm64) with Node 24.12.0. The
merge base is `a711c77a`. The branch has three commits: the prompt rule with
its tests, then the guide with its tests, then this file. The final code
commit is the second, `1f478f0a`, "Lead Doc's guide on routines with the Add
routine form"; the commit after it changes only this file. Every run below was taken
on the tree that commit records, before it was committed.

---

## What changed

`buildSystemPrompt` (`lib/agents/prompt.js`) gains a ROUTINES entry directly
after the FILES IN .claude/ DIRECTORY entry, built as its own `routinesRule`
next to `teamFilesRule` rather than inside it. Every agent, Doc included,
reads the same first sentence:

> A routine is made by the person with Add routine, under Routines in the rail or on the agent's page while it has no routines: the form schedules one of that agent's skills, writes the routine into the agent file, and the routine is approved when it is saved.

Every agent but Doc (the orchestrator, a lead, a specialist and the default
agent) then reads:

> When someone wants a routine, point them to Add routine; do not write a `routines:` block, give one to paste, or send them to Doc for it. A routine that runs no skill is the one case the form cannot make: that one is an agent-file change and goes to Doc like any other.

Doc reads instead:

> When someone wants a routine, point them to Add routine rather than writing a `routines:` block. Write one yourself only for a routine that runs no skill, which the form cannot make, and tell them it will wait in Routines until they approve it.

Doc's shipped guide (`scaffold/rundock-guide.md`) gains a Routines section
under the frontmatter field reference. It leads with Add routine, says a
routine made there is approved when it is saved and runs its skill with the
prompt `Run the <skill> skill.`, so a skill meant to run as a routine should
treat that wording as its routine trigger, and says a block written by hand
waits in Routines until the person approves it. The frontmatter example is
now shaped like a routine the form makes (a `skill`, the prompt the form
derives, `enabled: true`), and the `routines` row of the field table points
to the section.

Only text changed. Who may change agent and skill files is as on `main`:
`teamFilesRule` is byte for byte the same, and
`public/routine-editor-model.js`, `lib/agents/team-markers.js`,
`lib/protocol/handlers/team.js`, `lib/protocol/handlers/held-routines.js` and
`lib/agents/approval-store.js` are not in the diff. The approach was settled
before implementation.

---

## Red on main

Both test files were run with the two source files put back as on
`origin/main` and the new tests kept:

    node --test test/unit/discovery.test.js
    node --test test/unit/doc-claims.test.js

`test/unit/discovery.test.js`: 75 tests, 3 fail on `main`, 75 pass with the
change.

- buildSystemPrompt: every agent, Doc included, is told a routine is made with Add routine and approved when it is saved
- buildSystemPrompt: every agent but Doc points the person to Add routine, and sends only a routine that runs no skill to Doc
- buildSystemPrompt: Doc points to Add routine first, writes a block only for a routine that runs no skill, and says it waits for approval

The fourth new test, "buildSystemPrompt: the team-files rule is left exactly
as it was, for Doc and for everyone else", passes on both sides, as it
should: it pins the team-files line for Doc, the orchestrator and everyone
else to the SHA-256 of the line on `main`, so it guards what must not change.

`test/unit/doc-claims.test.js`: 150 tests, 5 fail on `main`, 150 pass with
the change. All five are in the new describe, "rundock-guide.md: a routine is
made with Add routine, and a block written by hand waits for approval":

- the routines coverage leads with Add routine, under Routines in the rail and on the agent's page
- a routine made there is approved when it is saved, and runs its skill with the prompt the form writes
- a block written by hand is only for a routine that runs no skill, needs enabled: true, and waits in Routines until approved
- the example is shaped like a routine the form makes, and the field table points to the Routines section
- the section Doc reads and repeats is in UK spelling, with no em or en dashes

Every test that existed before this branch passes unchanged in both files.

---

## Seven deliberate breaks

Each break was made in a copy of the repository outside the working tree,
then both files above were run in that copy, and the copy was restored
before the next break. With nothing broken, all 75 and all 150 pass.

**1. The routines rule removed for every agent but Doc.** The ROUTINES entry
was kept for Doc only. Red: "every agent, Doc included, is told a routine is
made with Add routine and approved when it is saved" and "every agent but Doc
points the person to Add routine, and sends only a routine that runs no skill
to Doc".

**2. "and the routine is approved when it is saved" removed.** Red: "every
agent, Doc included, is told a routine is made with Add routine and approved
when it is saved".

**3. The guide's form paragraph removed.** The first paragraph of the
Routines section was deleted. Red: "the routines coverage leads with Add
routine, under Routines in the rail and on the agent's page" and "a routine
made there is approved when it is saved, and runs its skill with the prompt
the form writes".

**4. Doc given the wording the other agents get.** Red: "Doc points to Add
routine first, writes a block only for a routine that runs no skill, and says
it waits for approval".

**5. The other agents given Doc's wording.** Red: "every agent but Doc points
the person to Add routine, and sends only a routine that runs no skill to
Doc".

**6. The rule dropped for the orchestrator only.** Red: "every agent, Doc
included, is told a routine is made with Add routine and approved when it is
saved" and "every agent but Doc points the person to Add routine, and sends
only a routine that runs no skill to Doc".

**7. One word changed inside `teamFilesRule`** ("refuses" to "rejects" in the
line every agent but Doc reads). Red: "the team-files
rule is left exactly as it was, for Doc and for everyone else". No test that
existed before this branch notices this break.

---

## What the wording claims, and the tests that show it is true

**The form's prompt is `Run the <slug> skill.`** `test/unit/routine-editor-doors.test.js`,
"a routine can be made from the profile door without calling anything",
pins the derived prompt (`Run the ops-summary skill.`). The new guide test "a
routine made there is approved when it is saved, and runs its skill with the
prompt the form writes" compares the guide's quoted prompt with what
`routineDraft` returns, so the guide cannot drift from the form.

**A routine saved through the form is approved when it is saved.**
`test/unit/run-now.test.js`, "a routine written through the editor's save
road is approved from birth, on the roster the tick reads", drives the real
`save_routine` dispatch. `test/unit/approve-once.test.js`, "a newly created
routine is born approved: making it is the consent", shows the same at the
file level, and that an edit to the plan still asks. In
`test/unit/routines-end-to-end.test.js`, the test under "a monthly routine
made in the editor" ("saved, it reads as its sentence and next run, runs once
at its slot, and then reads as ran with next month next") shows it runs at
its slot.

**A routine saved any other way is held until the person approves it.** In
`test/unit/approve-once.test.js`:

- "a whole agent file written with a key-less routine block lands pending, and does not run unattended" (the SAVE_AGENT road Doc uses)
- "stampPendingApprovals marks new routine blocks and leaves standing ones alone"
- "a key-less block beside an approved sibling is pending, not grandfathered" (a block typed into the file)
- "a single routine whose approval record is stripped after the feature ran is refused, not re-approved"
- "an unapproved routine is refused with its own word, and approval here clears it"

`test/unit/routine-first-approval.test.js`, "a routine never approved is
waiting for its first run, with Review and resume", shows where it waits.

**Where "waits until the person approves it" does not hold.** A block a
person types straight into an agent file carries no approval key, and
`migrateAgentRoutines` (`lib/agents/routines.js`) stamps it pending when the
approval feature has already run in the workspace, when another block in the
same file carries an approval key, or when this install has not opened the
workspace before. In one case it is approved as it stands: the one-time
upgrade of a workspace this install opened before approvals existed, before
the feature has run there, in a file with no approval key yet.
`test/unit/approve-once.test.js`, "migration approves every pre-existing
routine as it stands, switched on or not", pins that. A block Doc writes
goes through SAVE_AGENT, which stamps it pending in every case, so what Doc
is told to say is true for every block Doc writes.

---

## Bounds left alone

No test bounds the prompt's size. The tests that pin the order of the
prompt's entries, `test/unit/agents-lib.test.js` and
`test/unit/scratch-files-instruction.test.js`, pass unchanged, as do
`test/unit/workspace-mode-values.test.js`,
`test/unit/scaffold-integrity.test.js`, `test/unit/workspace-modes.test.js`,
`test/unit/routine-editor-doors.test.js` and
`test/unit/routine-editor-model.test.js`. Each audience reads at most three
sentences of the rule, which the first new discovery test checks.
