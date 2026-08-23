# Evidence: a run cut off by a restart stops claiming it is running

Recorded here because a reviewer sees the change and nothing else. Every
measurement below is reproducible from a clone with the command shown beside
it, and nothing here asks for a number on trust.

The acceptance criteria this was judged against live outside this repository,
so each is quoted in full rather than cited by number. A reader with only this
checkout can still see what was asked and check whether it was done.

All tests named below are in `test/unit/scheduler-lib.test.js`, in the section
headed `A RUN CUT OFF BY A RESTART`, unless stated otherwise.

## The defect, verified before the change

`beginRunRecord` opens a record with `files: null`, `filesStatus: 'unknown'`,
`filesReason: 'running'`. Only `endRunRecord` replaces it, and that runs from a
live handler. `loadRoutineState` rewrites a routine still marked `running` to
`interrupted` at startup and did not touch run records, so after a restart
mid-run the two stores disagreed permanently.

What was wrong was narrow, and the change is careful not to widen it. `unknown`
was the honest answer for the file list and still is. The REASON was untrue: a
run that will never run again is not running.

## The record

> **AC-1:** A run record left open by a restart does not report `running`
> afterwards.

`a run cut off by a restart stops claiming it is running, and agrees with the
routine state`. The test starts a real run through `executeRoutine` with a
child that never ends, abandons the scheduler instance that started it, and
opens the workspace again in a second private instance. It asserts
`notStrictEqual(record.status, 'running')` before asserting what the status now
is, so a change to the chosen word does not quietly satisfy the criterion.

> **AC-2:** Where the transcript survives, the record reports the files the run
> changed.

`where the transcript survives the restart, the record reports what the run
changed`. The transcript is written under the session id the run really
allocated, read back off the open record rather than made up, because the run
id and the session id are separate uuids. The assertion is on a NON-EMPTY list
whose one path could only have come from the transcript the test wrote.

> **AC-3:** Where it does not, the record names which reason applies.

`a run cut off by a restart names the reason its changes cannot be
established`. With no transcript on disk the record reports `filesStatus:
'unknown'` and `filesReason: 'no-transcript'`, which replaces the untrue
`'running'`.

> **AC-4:** An empty list is never written in place of an unknown one.

`a restart never turns an unknown file list into an empty one`. It asserts both
`files === null` and `!Array.isArray(files)`, because the two failure shapes are
different: a null erased to `[]` and a null replaced by `[]` read identically to
a single assertion.

That test opens by asserting `status === 'interrupted'`. An OPEN record already
carries `files: null`, so without that line the test passes against a build in
which the closing does not exist at all. It was written without it, seen to pass
before the change, and corrected before the change was written.

## The two stores

> **AC-5:** The run record and the routine state agree about whether that run is
> still going.

Asserted in the AC-1 test, in three steps rather than one: the record says
`interrupted`, the routine state says `interrupted`, and the two are then
asserted equal to each other. The word is the routine state's own, which is what
lets them agree in one vocabulary rather than in two that a reader has to
reconcile.

`interrupted` rather than `failed`, deliberately. A record left open says the
ending never ran. It does not say the run failed, and the work may have finished
a moment before the machine went down.

> **AC-6:** AC-5 is proven by a test that restarts across a live run, rather than
> by inspection.

Both halves hold, and neither reaches the closer.

The run is LIVE at the moment of the restart. The fake spawn hands back an
`EventEmitter` that is never made to emit `close`, so no ending ever runs and
the record is open for the same reason a real one would be.

The restart is a SECOND PRIVATE MODULE INSTANCE. Which runs a process has open
is module state, so a fresh instance starts without it exactly as a new process
does.

The startup is the REAL PATH. The test drives `handleSetWorkspace` from
`lib/protocol/handlers/workspace.js`, closed over the scheduler under test, and
asserts the `workspace_set` message so a run into the rollback cannot pass for a
successful open. `loadRoutineState` is one of the things that path calls, and it
is the same call the boot makes at `server.js`. `endRunRecord` is never called
by any test in this section.

## What must not move

> **AC-7:** Nothing this card adds writes to the value double-fire suppression
> reads.

`closing a restart-orphaned record writes nothing to the value double-fire
suppression reads`. Three assertions, strongest first:

- The whole `routineState` entry is compared with `deepStrictEqual` against what
  was on disk plus only the status rewrite that already existed, so a new field
  fails as loudly as a changed one.
- `lastRun` is asserted byte for byte.
- `getNextRun` still returns today's slot, which is the BEHAVIOUR that would be
  lost: the fixture is a run cut off yesterday and a restart this morning after
  today's slot passed, so the routine is still owed a catch-up run. Stamping the
  moment the orphan was noticed into `lastRun` suppresses it.

The test opens by asserting the orphaned record really was closed by that load,
so it cannot pass against a load that did nothing.

Both instants are constructed in local time on both sides, because `getNextRun`
compares calendar days and hours in local time. A UTC literal mixed into that
comparison is a test whose answer depends on the timezone of the machine
running it.

Row M9 of the mutation table is that mistake, written into the source on
purpose. It turns exactly this test red.

> **AC-8:** A run that genuinely is still going is unaffected, so a record open
> in the current process keeps reporting `running`.

`a run that is still going in this process keeps reporting running`. This is not
a hypothetical: startup is also the workspace-switch path, and a switch happens
while runs are in flight. The test starts a run, reloads the state in the SAME
process, and asserts the record still reports `running`, with a null `endedAt`
and a `filesReason` of `running` that is true of it.

Which runs this process has open is tracked by RUN ID. The in-flight set is
keyed by `agentId:routineName` and cannot answer a question about one run. Like
that set, it is deliberately not cleared by the load, for the reason recorded at
both.

`a restart leaves a run that already reached an outcome exactly as it was` holds
the other side: a record that already has an outcome is compared field by field
across a restart, so the startup close cannot rewrite settled history, or the
file list that came with it, on every open thereafter.

## Proof

> **AC-9:** Each proof fails when its own guard is removed.

Every guard was removed or inverted in turn and the whole suite run against it.
Reproduce with `npm test` after making the edit in the first column.

| # | Mutation to `lib/scheduler.js` | Suite | Test that turned red |
|---|---|---|---|
| M1 | delete the `closeAbandonedRunRecords()` call in `loadRoutineState` | 5 fail | all four restart tests, plus the AC-7 test's setup assertion |
| M2 | drop `status: 'interrupted'`, keeping whatever status the record had | 3 fail | `a run cut off by a restart stops claiming it is running, and agrees with the routine state` |
| M3 | delete `if (record.status !== 'running') continue` | 1 fail | `a restart leaves a run that already reached an outcome exactly as it was` |
| M4 | delete `if (openRunRecords.has(record.id)) continue` | 1 fail | `a run that is still going in this process keeps reporting running` |
| M5 | delete `openRunRecords.add(run.id)` in `beginRunRecord` | 1 fail | `a run that is still going in this process keeps reporting running` |
| M6 | write `files: observed.files \|\| []` | 1 fail | `a restart never turns an unknown file list into an empty one` |
| M7 | write `filesReason: null` | 1 fail | `a run cut off by a restart names the reason its changes cannot be established` |
| M8 | delete `openRunRecords.delete(run.id)` in `endRunRecord` | **0 fail** | **nothing** |
| M9 | INJECTED DEFECT: stamp `deps.now()` into `routineState[key].lastRun` inside the close | 1 fail | `closing a restart-orphaned record writes nothing to the value double-fire suppression reads` |

**M8 is a null result and is reported as one.** Removing that line turns nothing
red, so it is not a guard and the comment beside it does not call it one. It is
set hygiene: the record it refers to now carries an outcome, so the startup
close would skip it on the status alone (M3's guard), and what the removal costs
is an entry per run retained for the life of the process. It was kept and
relabelled rather than deleted, and a reviewer should read it as a leak fix
rather than as a control anything rests on.

**M9 is not a guard either.** It is the mistake the card was warned about,
written in to check that the AC-7 test would catch it. It would type-check, it
reads as a tidy simplification, and one test fails on it.

## Red-first

`node scripts/red-first.js --base origin/main --tests "npm test"` reports
PROVEN: 2053 tests pass with the change, 6 fail without it.

`origin/main` rather than `main`, because a worktree's local `main` ref does not
move and reverting against it silently reverts another branch's files.

The check's own limitation travels with it and is not overstated here:
reverting proves the tests notice this change, not that they assert the right
thing. That is why the mutation table above exists, and why two of its rows
report an absence rather than a pass.

## The gate

`git add -A && npm run precommit`: PASS, all six steps, recorded in
`.precommit-gate.json`.

Coverage measured inside that gate, by `npm run test:coverage`:

- `lib/scheduler.js`: 99.9%, 1353 of 1355 executable lines
- Scheduler area floor (`getNextRun` + `startScheduler` + `executeRoutine`):
  99.8%, 1298 of 1300
- `coverage-areas: all 51 floors hold`

## Out of scope, and left alone

The run-detail surface, which renders these records. What `endRunRecord` writes
on the ordinary path. Cancellation. `observeRun` was read from, not changed.
