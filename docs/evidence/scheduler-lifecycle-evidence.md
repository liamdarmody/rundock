# The scheduler starts when a workspace does

Recorded here so that anyone reading the change can check its claims without
being in the room. Every
measurement below is reproducible from a clone with the command shown beside
it, and nothing here asks for a number on trust.

The acceptance criteria this was judged against live outside this repository,
so each is quoted in full rather than cited by number.

## The defect, verified before the change

Verified by reading the source rather than by taking the report on trust:

```
git grep -n 'startScheduler\|stopScheduler' -- ':!test' ':!node_modules'
```

At `b602f5a` that answered:

- `startScheduler()`: one call in the product, `server.js`, inside
  `startServer`'s `if (WORKSPACE)` block. Every other hit is the declaration in
  `lib/scheduler.js`, the destructuring import, the `_internal` re-export, or a
  comment.
- `stopScheduler()`: no call in the product at all. Declaration, import and
  re-export only.

Choosing a workspace at runtime goes through
`lib/protocol/handlers/workspace.js`. Both paths that land on a workspace,
`openWorkspace` and `handleCreateWorkspace`, call `loadRoutineState()` and
neither starts the scheduler. So the sequence install, open, choose a folder
leaves nothing watching the clock until a restart, which is the ordinary first
run rather than an edge.

The eight suites that already tested this scheduler all arm the tick by calling
`startScheduler` themselves, which is why none of them noticed:

```
grep -rl 'startScheduler(' test/ | wc -l
```

## The change

The lifecycle belongs to `setWorkspaceRoot` in `server.js`, the one function
that writes the workspace root. Every way of arriving at a workspace already
reaches it, and `test/unit/config.test.js` has pinned that since before this
card. So no path has to remember to start a scheduler, and the next path added
gets one without being told.

Not the roster and not the file watcher, deliberately: both fire often and for
reasons unrelated to a workspace being chosen, and a scheduler armed from a
path like that is how two tickers happen.

`schedulerRunning()` in `lib/scheduler.js` reports whether a tick is armed,
read from the interval handle the tick depends on rather than from a flag kept
beside it. It exists because the only previous way to ask was to call the
starter and see what happened.

## The record

> **AC-1:** Choosing a workspace at runtime starts the scheduler.
>
> **AC-2:** AC-1 is proven through the real workspace-set path rather than by
> calling the starter.

`test/integration/scheduler-workspace-lifecycle.test.js`, test *choosing a
folder arms the tick, and the routine runs when its time comes*.

The server boots with no workspace (`h.boot({ workspace: false })`), which is
the state a first run starts in. The test then sends
`{type:'set_workspace', path}` over a real WebSocket: the exact message
`public/app.js` sends when someone picks a folder. Nothing in that file calls
`startScheduler` or `stopScheduler`, and a check enforces it (below).

The result is read through the tick's own behaviour: an hour before its time
the routine has not run, and after the wired clock passes 09:00 it fires, is
stamped with the wired clock, and completes.

> **AC-3:** Starting when a scheduler is already running does not leave two
> tickers.

Same file, test *choosing a workspace twice leaves one ticker, not two*. Clock
reads per tick are counted and calibrated against a single choose, so the
number does not depend on how many reads one pass happens to make. The second
choose costs exactly one pass, not two.

> **AC-4:** Switching away from a workspace stops the scheduler that was
> running for it.

Two tests, because there are two shapes of switching away.

*switching away re-arms the tick rather than leaving the old one running*: the
old ticker is thirty seconds from firing when the switch happens. If it
survived, the next thirty seconds would fire it. It does not, and thirty
seconds after that the new one does, which is what proves a ticker exists at
all.

*a workspace that disappears takes its ticker with it*: the case with nowhere
to land, where the stop is the only thing doing the work. The pointer is
cleared by the real `get_workspaces` handler over the real socket, and after it
`schedulerRunning()` is false.

The pointer is put there by the product's own workspace setter rather than by
choosing over the wire, and that is forced rather than chosen: opening a folder
writes to its `.rundock`, and those writes recreate the directory faster than a
test can delete it, so a workspace opened over the wire never reads as
vanished. `test/integration/workspace-picker.test.js` sets the pointer the same
way for the same reason. The clearing, which is what the test is about, still
goes through the real handler.

> **AC-5:** After a switch, the previous workspace's routines do not fire.
>
> **AC-6:** AC-5 is proven by advancing the clock past a due slot of the old
> workspace and asserting nothing started.

Same file, test *the previous workspace routine does not fire when its slot
passes*. A workspace with a routine due at 09:00 is chosen at 08:00 and
switched away from. The wired clock then moves to 09:30 and ticks run.

**The three absences this criterion asks for do not, on their own, prove
anything about the stop, and the first version of this test asserted only
them.** The tick reads the workspace root at use time, through
`discoverAgents`, so a ticker that survived the switch would discover the
roster of the workspace just ENTERED. It could never fire a routine belonging
to the one that was left, whether it was stopped, left running, or never armed
at all. An absence guaranteed by the scheduler's use-time read is not evidence
about the lifecycle. Round 1 of review rejected it on exactly that, and it was
right to.

So the absences stay, because they are what the criterion asks for in so many
words, and the observation that DOES differ is made beside them: whether the
ticker armed for the workspace that was left is still there afterwards, read
through the tick's phase rather than through anything it spawned.

- The premise is asserted rather than assumed: after choosing the workspace, a
  tick pass runs, so the ticker under test exists and is the mocked one.
- It is then left thirty seconds from its next minute, and the switch happens.
- Those thirty seconds run no pass, which is what a stopped ticker looks like
  and a surviving one does not.
- The thirty after them run one, which is what proves a ticker exists to have
  been counted at all.
- Then the three absences: no run state for the routine, nothing spawned in the
  left workspace (its own prompt log, read from that directory), no
  `routine-state.json` written there.

M17 is the mutation that fires the surviving-ticker assertion specifically: the
stop forgets the handle without clearing the interval, so the pre-switch ticker
lives on. It fails with `1 !== 0` on the line that says *it is gone, not merely
looking elsewhere*.

Both workspaces are built by the test.

> **AC-7:** Every caller of the starter and the stopper is enumerated in a
> check that reads the source.
>
> **AC-8:** A path that sets a workspace without starting the scheduler fails
> that check by name.
>
> **AC-9:** The enumeration names any deliberate exclusion with its reason.

`test/unit/scheduler-lifecycle-doors.test.js`. It extends the instrument
already in `test/unit/routine-editor-doors.test.js` and
`test/unit/routines-view-doors.test.js` rather than inventing a third: an
enumeration, a check that reads the source and fails when the two disagree, and
a reverse check so a row cannot name a test nobody wrote.

What it covers:

- **`CALLERS`**: every call to `startScheduler` or `stopScheduler` in the
  product, keyed by file and enclosing function, each row naming its surface
  and the test that drives it. Three rows: the stop and the start in
  `setWorkspaceRoot`, and the start in `startServer` for a workspace preset in
  the environment, which never passes through the setter. The scan walks every
  `.js` file outside `test/`, `node_modules` and build output, strips comments
  so prose cannot read as a call, and tells a declaration from a call.
- **`WORKSPACE_SETTERS`**: every product path that sets the workspace root, six
  rows across `server.js` and `lib/protocol/handlers/workspace.js`.
- Two checks make listing enough rather than a matter of memory: nothing may
  write the workspace root except `setWorkspaceRoot` (so no path can set a
  workspace and bypass the lifecycle), and `setWorkspaceRoot` must contain both
  lifecycle calls with the stop before the start.
- A check that the lifecycle proofs never arm the tick themselves, since
  calling the starter is the habit that let this ship.

`NOT_ENUMERATED` carries the exclusions with reasons: the declarations in
`lib/scheduler.js`, the whole of `test/` including the eight suites that arm
the tick themselves, and the import and re-export lines that name the functions
without calling them.

> **AC-10:** Nothing this card adds writes to the value double-fire suppression
> reads.

Test *choosing a workspace does not write the value suppression reads*. A
workspace is prepared with a `routine-state.json` recording a run at 09:05, and
opened with the clock at 09:30. `lastRun` is unchanged after the open, the tick
it armed does not re-fire the routine, nothing is spawned, and the file is
byte-identical to what was written.

> **AC-11:** A routine that was mid-run when a workspace is switched is not
> re-fired by the new start.

Test *a routine mid-run when the workspace is switched is not re-fired by the
new start*. The routine fires, the stub holds it open, the routine is asserted
`running`, the workspace is switched away and back, and a further tick starts
nothing: the prompt log still holds one entry after real elapsed time in which
a second spawn would have appeared.

### The ordering the lifecycle depends on

Not one of the twelve criteria, and found in review of round 2. The root
changes before the lifecycle runs, so a tick armed before `loadRoutineState()`
is armed into a window where `getWorkspace()` names the workspace being entered
while `routineState` and the slot records still describe the one being left. A
tick landing there judges the new roster against the old workspace's `lastRun`,
and for any key the two workspaces share, which is every key when an agent and
a routine keep their names, it suppresses a run that was due.

No caller yields between the two today, so no tick can land there today. That is
an argument that ages badly, and it is the fourth time in this release that two
stores have disagreed about the same question with nothing making them agree.
So `setWorkspaceRoot` loads the state and then arms, and the window does not
exist to be argued about. The open paths load again afterwards, deliberately:
`healWorkspaceIfMoved` runs between, and what it repairs belongs in the state a
tick reads. The load in the setter is the floor rather than the last word.

Proven by `the state a tick will read is loaded before the tick is armed`. Two
workspaces declare the same agent and the same routine, so they share a routine
key; the one being left has a run recorded at 09:05 and the one being entered
has never run it. The observation is taken at the ARMING rather than through a
tick, because the window is inside one synchronous call: nothing yields, so no
tick can be driven into it, and a test that advanced the clock would pass under
either ordering and prove nothing. What differs between the orderings is the
state that exists when the interval is created, so the test stands in front of
`setInterval` and copies `routineState` at that instant. The scheduler's is the
only sixty-second interval armed on that path.

M18 arms before loading and turns that test red, and only that test.

> **AC-12:** Each proof fails when its own guard is removed.

Below, in full.

## The boot proof, and why it is booted the way it is

`test/integration/scheduler-boot-lifecycle.test.js` is the test the `CALLERS`
row for the boot caller names. It has to reach `startServer` with nothing
already armed, which the obvious harness boot does not do: pointing the server
at the fixture through `internal.setWorkspace` goes through `setWorkspaceRoot`,
which now arms the tick, so `startServer` would meet a live handle, decline,
and the test would stay green with the boot call deleted. Round 1 of review
caught that; the first version of this test proved nothing.

The harness gained a `presetWorkspace` option, documented beside the `workspace`
one. It puts the fixture path in `process.env.WORKSPACE` after the fixture
exists and before `server.js` is required, which is the only window in which
that variable does anything: `lib/config` reads it once, at require time. The
setter is never called. `boot()` also records `schedulerRunning()` between the
require and the listen, a window no test can otherwise reach because `boot()`
owns both halves.

The test then asserts all three: the root came from the environment, nothing had
armed a tick before the server listened, and a tick is armed after. M14 removes
`startScheduler()` from `startServer` and turns it red.

## Mutation results

Each mutation applied alone, `npm test` run in full (2361 tests), source
restored, next mutation applied. Failing counts are out of the whole suite, so
the blast radius is visible rather than asserted.

| # | Mutation | Failing | Tests that turned red |
|---|---|---|---|
| M1 | remove `stopScheduler()` from the workspace setter | 8 | *choosing a workspace twice leaves one ticker, not two*; *switching away re-arms the tick rather than leaving the old one running*; *the previous workspace routine does not fire when its slot passes*; *a workspace that disappears takes its ticker with it*; *the state a tick will read is loaded before the tick is armed*; *a routine mid-run when the workspace is switched is not re-fired by the new start*; *no product code arms or disarms the scheduler without being listed here*; *the function every workspace-setting path reaches runs the lifecycle* |
| M2 | remove `startScheduler()` from the workspace setter | 9 | the eight above, plus *choosing a folder arms the tick, and the routine runs when its time comes* |
| M3 | start before stop instead of after | 7 | as M2, without *no product code arms or disarms...* (both calls are still present, so only the order check fails) |
| M4 | start even when there is no workspace (`if (dir)` dropped) | 1 | *a workspace that disappears takes its ticker with it* |
| M5 | `schedulerRunning()` always returns true | 3 | *a first run has no workspace and nothing watching the clock*; *a workspace that disappears takes its ticker with it*; *booting with a workspace already set arms the tick...* |
| M6 | remove the pre-existing `if (tickTimer) return` double-arm guard | 1 | *starting the scheduler twice leaves exactly one tick running* (pre-existing) |
| M7 | let a workspace switch clear the in-flight hold | 1 | *the workspace switch does not release a run that is still going* (pre-existing) |
| M8 | drop the boot caller from `CALLERS` | 1 | *no product code arms or disarms the scheduler without being listed here* |
| M9 | point a `CALLERS` row at a test nobody wrote | 1 | *every caller names a test, and every named test exists* |
| M10 | the no-workspace boot seam ignores its option | 2 | *a first run has no workspace and nothing watching the clock*; *booting with a workspace already set arms the tick...* |
| M11 | a new handler sets the workspace root directly, bypassing the setter | 1 | *the workspace root cannot be written except through the function that runs the lifecycle* |
| M12 | a new handler reaches the setter and is not listed | 1 | *no product code sets a workspace without being listed here* |
| M13 | the open re-stamps the value suppression reads | 6 | *choosing a workspace does not write the value suppression reads*, plus five pre-existing suppression tests |
| M14 | remove `startScheduler()` from the boot path | 2 | *booting with a workspace already set arms the tick...*; *no product code arms or disarms the scheduler without being listed here* |
| M15 | an exclusion in the enumeration loses its reason | 2 | *a call left out of the enumeration says why* (plus one unrelated flake, below) |
| M16 | a lifecycle proof arms the tick itself | 1 | *the lifecycle proofs never arm the tick themselves* |
| M17 | the stop forgets the handle without clearing the interval | 6 | *choosing a workspace twice...*; *switching away re-arms...*; *the previous workspace routine does not fire when its slot passes*; *a workspace that disappears...*; plus two pre-existing scheduler tests |
| M18 | arm the tick before the state it will read is loaded | 1 | *the state a tick will read is loaded before the tick is armed* |

M11 and M12 are AC-8 read literally: a path that sets a workspace and starts
nothing, added on purpose to check that it fails by name. Both do, and the
failure names the file and the function.

No mutation turned nothing red, and none turned the suite red. The largest
blast radius is nine tests out of 2361.

## Every proof, and the mutation that names it

Round 1 of review found two proofs that no mutation named. The answer to that is
not to fix the two, it is to ask the question of all of them, so this table
covers every test in the three files this change adds. A proof with no mutation
naming it is a proof that cannot fail.

| Test | Turned red by |
|---|---|
| *a first run has no workspace and nothing watching the clock* | M5, M10 |
| *choosing a folder arms the tick, and the routine runs when its time comes* | M2, M3 |
| *choosing a workspace twice leaves one ticker, not two* | M1, M2, M3, M17 |
| *switching away re-arms the tick rather than leaving the old one running* | M1, M2, M3, M17 |
| *the previous workspace routine does not fire when its slot passes* | M1, M2, M3, M17 |
| *a workspace that disappears takes its ticker with it* | M1, M2, M3, M4, M5, M17 |
| *choosing a workspace does not write the value suppression reads* | M13 |
| *the state a tick will read is loaded before the tick is armed* | M1, M2, M18 |
| *a routine mid-run when the workspace is switched is not re-fired by the new start* | M1, M2, M3 |
| *booting with a workspace already set arms the tick, with nobody calling the starter* | M5, M10, M14 |
| *no product code arms or disarms the scheduler without being listed here* | M1, M2, M8, M14 |
| *every caller names a test, and every named test exists* | M9 |
| *a call left out of the enumeration says why* | M15 |
| *the lifecycle proofs never arm the tick themselves* | M16 |
| *no product code sets a workspace without being listed here* | M12 |
| *the workspace root cannot be written except through the function that runs the lifecycle* | M11 |
| *the function every workspace-setting path reaches runs the lifecycle* | M1, M2, M3 |

Every proof is named by at least one mutation. Four of these mutations, M13
through M16, exist only because this table was built: the proofs they name had
no mutation before it, and two of them, the AC-10 proof and the boot proof, were
passing regardless of the change.

M18 arrived the other way round, from review of round 2 rather than from the
table: the ordering it mutates was a defect first and a proof second. The rule
held anyway, because the proof written for it was required to have a mutation
that names it before it counted as a proof at all.

## What the mutations exposed, reported rather than tidied away

**Two proofs could not fail, and one of them I found and one review found.** M1
initially turned nothing red on *a workspace that disappears takes its ticker
with it*: with the stop gone the start met a live handle, declined, and no
mocked interval was ever created, so counting zero tick bodies proved nothing.
I strengthened that test and re-ran M1. I did not then ask the same question of
its siblings, and review found the AC-5/AC-6 proof failing in the same way for a
different reason. The table above is the answer to the class rather than to
either instance.

**M6 does not turn the AC-3 test red, and that is correct.** With stop before
start, a second choose stops the ticker first, so `if (tickTimer) return` never
fires on that path. AC-3 is guarded here by the stop, which M1 and M17 turn red;
the pre-existing guard keeps its own pre-existing test.

**M7 does not turn the AC-11 test red.** With the hold cleared on switch the
routine is still not re-fired, because `lastRun` was stamped when the run began
and suppression holds. The hold has its own pre-existing test, which M7 turns
red. The AC-11 test proves the criterion as written, that the new start does not
re-fire the run, and M1, M2 and M3 turn it red.

**M13's blast radius is five pre-existing tests, and they are the right five.**
It re-stamps `lastRun` on load, so everything that depends on the suppression
value surviving a load fails with it. That is the property AC-10 is about.

**Two mutation runs had to be discarded and re-run.** M16 first reported 293
failures and M17 reported 32, all `ENOSPC`. The suite's `makeWorkspace` registers
each temp fixture for a `cleanup()` that nothing calls, so seventeen full-suite
runs left 20,708 fixture directories and filled the volume. The numbers in the
table are from re-runs on a clean disk, and every run is checked for `ENOSPC`
before its result is recorded. This is a pre-existing property of the suite
rather than anything this change introduced, and it is not fixed here.

**A gate run failed one unrelated test twice, and it is not this change.**
*agent CRUD while an orchestrator is live flags it...* in
`test/integration/delegation.test.js` asserts a spawn count of one and saw two,
during two gate runs taken while the disk cleanup above was still running. Two
things settle it. Structurally, that file boots `standardTeam()`, which declares
no routines at all, so the tick cannot spawn anything in it: `startScheduler`'s
loop skips an agent with no routines, and no scheduler behaviour can add an
invocation there. Empirically, five full coverage runs on `origin/main` and five
on this branch, taken once the machine was quiet, are all green. Recorded as a
load-sensitive pre-existing flake rather than fixed, because fixing it is not
this card.

**M15's run also failed one unrelated test, *zombie interrupt*.** It is a
process-timing test with no connection to an enumeration comment, it passes on
the unmutated tree, and it is recorded here as a flake rather than as a result.

## A node behaviour that shapes the test file

A `node:test` mock-timer handle created in one test and cleared inside a LATER
test's mock instance leaves that instance unable to fire anything at all. This
is node, not Rundock, and reproduces in a plain `node --test` file with no
Rundock in it:

```js
let stale = null;
for (const n of [1, 2, 3]) {
  test('mock ' + n, (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    let fired = 0;
    if (stale) clearInterval(stale);
    const h = setInterval(() => { fired++; }, 60000);
    t.mock.timers.tick(60000);
    console.log(n, 'fired:', fired);   // 1, then 0, then 0
    stale = h;
    t.mock.timers.reset();
  });
}
```

The scheduler holds exactly such a handle at the end of every test in the
lifecycle file, and the next workspace change clears it. Each test therefore
arms the scheduler on real timers first, through the same workspace-set path,
so the clear that happens under the mock is a clear of a real handle. Without
that, every test after the first would drive a tick that could never fire and
read the silence as the defect.

## Nothing here depends on the machine it runs on

The clock is wired through the scheduler's `deps.now` seam and never read from
the wall. The home directory is a temp dir the harness makes. Every workspace is
built by the test that uses it. The interval is driven by mock timers rather
than by elapsed time. The two instants are local-time constructions
(`new Date(2026, 6, 1, 8, 0, 0)`), so a schedule written in local time and a
clock read in local time agree in any zone. The one place real elapsed time is
used is where something must be shown NOT to happen, which cannot be done any
other way.

## Gate

Run in the order the gate documents, so that one record describes one tree:

```
git add -A && npm run precommit    # checks, and the record for the staged tree
git commit                         # same content, so the same tree hash
npm run red-first                  # folds the discrimination result into that record
```

`npm run precommit`: PASS, six steps: `test:coverage`, `typecheck`,
`lint:styles`, `check:refs`, `mutate:guards`, `check:fixture`.

`npm run red-first --base origin/main`: PROVEN, the tests fail without the
change and pass with it, and the result is in the below-the-line record for the
measured tree rather than only in this file.

Round 1 of review flagged that those two records disagreed, because red-first
had been run by hand against an earlier tree and the gate was then re-run for a
later one, which cleared the field. The order above is what stops that: the
gate record and this file now describe the same tree.

Red-first carries its own limit, which travels with this record: reverting
proves the tests notice the change, not that they assert the right thing. That
is the gap the mutation table and the per-proof audit above exist to close.
