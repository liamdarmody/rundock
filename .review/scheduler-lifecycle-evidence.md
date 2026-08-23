# Evidence: the scheduler starts when a workspace does

Recorded here because a reviewer sees the change and nothing else. Every
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
switched away from. The wired clock then moves to 09:30 and a tick runs. Three
assertions, none of them about the scheduler's internals: the routine has no
run state, the stub was never spawned in that workspace (its own prompt log,
read from that directory), and no `routine-state.json` was written there.

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

> **AC-12:** Each proof fails when its own guard is removed.

Below, in full.

## Mutation results

Each mutation applied alone, `npm test` run in full (2361 tests), source
restored, next mutation applied. Failing counts are out of the whole suite, so
the blast radius is visible rather than asserted.

| # | Mutation | Failing | Tests that turned red |
|---|---|---|---|
| M1 | remove `stopScheduler()` from the workspace setter | 6 | *choosing a workspace twice leaves one ticker, not two*; *switching away re-arms the tick rather than leaving the old one running*; *a workspace that disappears takes its ticker with it*; *a routine mid-run when the workspace is switched is not re-fired by the new start*; *no product code arms or disarms the scheduler without being listed here*; *the function every workspace-setting path reaches runs the lifecycle* |
| M2 | remove `startScheduler()` from the workspace setter | 6 | *choosing a folder arms the tick, and the routine runs when its time comes*, plus the five above other than the vanished-workspace one |
| M3 | start before stop instead of after | 5 | *choosing a folder arms the tick...*; *choosing a workspace twice...*; *switching away re-arms...*; *a routine mid-run...*; *the function every workspace-setting path reaches runs the lifecycle* |
| M4 | start even when there is no workspace (`if (dir)` dropped) | 1 | *a workspace that disappears takes its ticker with it* |
| M5 | `schedulerRunning()` always returns true | 1 | *a first run has no workspace and nothing watching the clock* |
| M6 | remove the pre-existing `if (tickTimer) return` double-arm guard | 1 | *starting the scheduler twice leaves exactly one tick running* (`test/unit/scheduler-lib.test.js`, pre-existing) |
| M7 | let a workspace switch clear the in-flight hold | 1 | *the workspace switch does not release a run that is still going* (pre-existing) |
| M8 | drop the boot caller from `CALLERS` | 1 | *no product code arms or disarms the scheduler without being listed here* |
| M9 | point a `CALLERS` row at a test nobody wrote | 1 | *every caller names a test, and every named test exists* |
| M10 | the no-workspace boot seam ignores its option | 1 | *a first run has no workspace and nothing watching the clock* |
| M11 | a new handler sets the workspace root directly, bypassing the setter | 1 | *the workspace root cannot be written except through the function that runs the lifecycle* |
| M12 | a new handler reaches the setter and is not listed | 1 | *no product code sets a workspace without being listed here* |

M11 and M12 are AC-8 read literally: a path that sets a workspace and starts
nothing, added on purpose to check that it fails by name. Both do, and the
failure names the file and the function.

No mutation turned nothing red, and none turned the suite red: the largest
blast radius is six tests out of 2361, and every one of those six is about this
lifecycle.

### What the mutations exposed, reported rather than tidied away

**M1 initially missed the test written for it.** *a workspace that disappears
takes its ticker with it* passed with the stop removed. Each test in that file
has to arm the scheduler on real timers before enabling mock timers (see
below), and with the stop gone the start met that live handle, declined, and no
mocked interval was ever created, so counting zero tick bodies proved nothing.
The test was strengthened to assert `schedulerRunning()` is false after the
clear, and M1 was re-run: it now fails, and that is the M1 row above. The
weaker version is not in the diff.

**M6 does not turn the AC-3 test red, and that is correct.** With stop before
start, a second choose stops the ticker first, so `if (tickTimer) return` never
fires on that path. AC-3 is guarded here by the stop, which M1 turns red; the
pre-existing guard keeps its own pre-existing test.

**M7 does not turn the AC-11 test red.** With the hold cleared on switch, the
routine is still not re-fired, because `lastRun` was stamped when the run began
and suppression holds. The hold itself has its own pre-existing test, which M7
does turn red. The AC-11 test proves the criterion as written, that the new
start does not re-fire the run, and it is turned red by M1, M2 and M3.

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

```
git add -A && npm run precommit
```

PASS, six steps: `test:coverage`, `typecheck`, `lint:styles`, `check:refs`,
`mutate:guards`, `check:fixture`.

```
node scripts/red-first.js --base origin/main --tests "npm test"
```

PROVEN: the tests fail without the change and pass with it. That check carries
its own limit, which travels with this record: reverting proves the tests
notice the change, not that they assert the right thing.
