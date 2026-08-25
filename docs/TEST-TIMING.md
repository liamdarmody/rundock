# Test timing and flakiness

A test that passes alone and fails when the machine is busy is not a flaky
test. It is a test that asserts something about scheduling instead of
something about behaviour, and the load is what makes that visible.

This document is the inventory of every place in `test/` where an assertion
depends on timing or on how two things interleave, what each one is standing
in for, and what we decided to do about it. It exists so that the next person
who hits an intermittent failure can find out in one place whether it is
known, and so that a new one gets classified rather than re-run until green.

Read [The rule](#the-rule) before writing any new wait.

## Start here: a test just failed and passed on re-run

Look it up in [The inventory](#the-inventory). If it is listed as **accepted**,
the entry says what the failure means and what the real ceiling is. If it is
listed as **fixed**, a genuine failure is now a real finding and should not be
re-run away.

If it is not listed at all, it is a new instance of this class. Classify it
using the rule below, add it here, and fix or accept it in the same change.
Re-running until green and moving on is how this class grew in the first
place.

**Do not silence a flake by widening its assertion.** A test that no longer
fails under load and no longer fails when the behaviour breaks has been
deleted, not fixed. Every fix in this document was checked by breaking the
behaviour it guards and confirming the test still goes red.

## The rule

Almost every timing bug in this suite reduces to one question: **is the
assertion that a state is REACHED, or that a state is NEVER reached?**

**Reached: never sleep. Wait for the condition.** A fixed sleep before a
positive assertion is a bet that the machine is at least as fast as the author
guessed. It is the single largest source of load-sensitivity in this suite.
Use `h.waitUntil(predicate)`, `client.waitFor(pred)`, or `h.waitForPidExit(pid)`.
All three poll, all three are bounded, and all three fail with something
readable.

**Never reached: real elapsed time is the only proof.** You cannot poll for
the absence of an event. `h.delay(ms)` is correct here, and the constant should
be a stated multiple of the interval the behaviour runs on, not a round number
that felt long enough. A negative proved by too short a sleep passes
vacuously, which is worse than failing, so say what the sleep outlives.

**Better than either: remove the clock.** `t.mock.timers` advances a
production interval with no wall-clock cost and makes exact counts
deterministic. `test/unit/root-remainder-edges.test.js` drives a 10-second
production failsafe this way; `test/unit/scheduler-lib.test.js` and
`test/unit/scheduler-slots-dst.test.js` use it throughout. Where a duration
belongs to production code, prefer injecting it (`codex-appserver.test.js`
passes millisecond budgets in as options) over sleeping past it.

### Two failure shapes worth naming

**A count that races.** `assert.strictEqual(invs.length, 1)` reads a log
written by a child process, at an instant the test chose. It cannot see a
second entry that has not been written yet. A lower bound (`>= 1`) or a
barrier before the read (wait for a control event that must arrive after the
one in question) both fix it; the barrier is stronger.

**A measurement window with a poller in it.** Any counter armed for the
duration of a request counts whatever else the server does during that
request. Two things in this server run on fixed 2s intervals: the
agents-directory poller and the file-tree poller. On an idle machine the
window is under a millisecond and they never collide; under contention the
window stretches until one lands inside it. Attribute reads to the caller, or
exclude the paths the code under test provably never touches.

## The inventory

Every entry is `file:line`, the test, and what the constant stands in for.
Three classifications:

- **fixed**: was load-sensitive, now waits on a condition or attributes its
  measurement properly. A failure is a real finding.
- **accept**: timing-dependent by nature and correct as written. The reason is
  stated. Usually a negative proof, where elapsed time is the only evidence.
- **isolate**: correct in itself, but competes for the machine and should not
  run beside a full suite.

### Has actually failed

These are the documented instances. Evidence is in `.review/` and in commit
messages.

| Test | Evidence | Status |
|---|---|---|
| `test/integration/file-tree-cache.test.js` "an unchanged workspace is not re-walked", "editing file CONTENTS does not force a re-walk" | Counter included `.claude`, racing the 2s agents poller | **fixed** |
| `test/integration/search-warmup.test.js` all three tests | Blocked a card's gate five times; 6,000-file index against an 8s default | **fixed** |
| `test/unit/red-first.test.js` "an interrupt during the reverted run does not leave the tree reverted" | Signal fired after a guessed 150ms | **fixed** |
| `test/unit/red-first.test.js` "a test command that traps SIGINT does not hold the tree hostage" | Same shape at 300ms; recorded as a flake in `.review/scheduler-lifecycle-evidence.md` | **fixed** |
| `test/unit/red-first-orphans.test.js` "AC-5, AC-6: a second start is refused..." | Failed once on CI Node 24 under load; `sleep 25` is a budget for the test's own duration | **fixed** |
| Playwright browser suite | 2026-08-14, traced to contention | **isolate** (see below) |
| `test/integration/delegation.test.js` "agent CRUD while an orchestrator is live flags it..." | Spawn count 1, saw 2, twice during gate runs; `.review/scheduler-lifecycle-evidence.md` | **not fixed**, see below |
| `test/integration/process-lifecycle.test.js` | Failed once in setup; `.review/navigation-inventory-evidence.md` | **not fixed**, see below |

The server already carries one fix of this exact class: `rebaselineAgentsWatcher`
in `server.js` exists because the arm-then-scaffold order guaranteed a roster
refresh about 2s into every workspace entry, which surfaced as a CI spawn-count
flake on main (2026-08-11). The comment there is worth reading before touching
anything that involves the agents poller.

### Fixed in this pass

**`test/integration/file-tree-cache.test.js`** counted every `readdirSync`
under the workspace, `.claude` included, while the agents-directory poller
reads `.claude/agents` every 2s. Measured: over a 5-second window the counter
saw exactly two reads, both of `.claude/agents`, and zero belonging to the
tree. The real measurement window is under a millisecond on an idle machine,
which is why 65 runs under artificial CPU load did not reproduce it; under
real contention the window stretches until a 2s tick lands in it. The counter
now excludes dotfolders, which costs no coverage because `getFileTree` filters
`!item.name.startsWith('.')` before recursing and so cannot read one. The
sibling suite `test/integration/external-tree-changes.test.js` already counted
this way for the same reason.

Removing that noise then exposed a second defect underneath it, in the same
file's precondition `first.dirReads > 0`. The cache is WARM from the moment
`armFileTreeWatcher` arms it at boot, and the only reason the first request
walked at all was that scaffolding wrote into the workspace afterwards and
bumped the root mtime. That is boot ordering, not a property of the test, and
the old counter had been papering over it: a `.claude/agents` read landing in
the window made `dirReads` non-zero whatever the cache did. With the count
honest, a tree-poll tick warming the cache before the first request drops it to
zero and the precondition fails, which is what a full-suite run on this branch
did. Two changes make it deterministic: the external-change poll is pushed out
of reach for this file, since it is a competing writer to the cache under
measurement and has its own suite elsewhere, and the test now creates a file to
make the cache stale on purpose rather than inheriting staleness from the boot
sequence. Verified with 24 parallel runs under saturated CPU, all green, and
still red when the cache is disabled.

**`test/integration/search-warmup.test.js`** waits on `search_index ready`
with the harness default of 8000ms, after writing 6,000 markdown files and
indexing them, three times over. Measured idle: 1.5 to 2.2 seconds per test.
That is four-fold headroom on the heaviest fixture in the suite, on the
assumption that CI disks behave like a local SSD. The waits now carry an
explicit timeout that names the work it covers. This weakens nothing: a
warm-up that genuinely never completes still fails, just later.

**`test/unit/red-first.test.js`** fired SIGINT a fixed 150ms (and, in the
sibling test, 300ms) after the phrase `restoring the source` appeared on
stdout. The sleep is a guess at how far past that line the unlink is. Both now
wait for the state the interrupt is supposed to catch.

**`test/unit/red-first-orphans.test.js`** "AC-5, AC-6" held its first run open
with `sleep 25`, then asserted mid-flight that the run was still alive. 25
seconds is a budget for everything the test does in between, including a
synchronous `spawnSync` that runs git. On a slow runner the sleep ends first
and the assertion fails for a reason unrelated to what it tests. It now uses
`LONG`, the duration the rest of that file already uses for a suite that must
not end on its own.

### The remaining duration budgets in `red-first-orphans.test.js`

Four stand-in suites in that file still carry a foreground duration, and they
are not all the same shape. Listed because the fix above removed only the one
that had failed.

- **`sleep 30` at lines 303, 386 and 437** is the same budget as the one fixed,
  and only survives because those three tests do far less between starting the
  run and asserting on it: no nested `spawnSync`, no second tool invocation.
  Nothing makes 30 seconds correct, it is just further from the edge. If one of
  these fails on a loaded runner, it is this, and the fix is the one applied to
  AC-5, AC-6.
- **`sleep 3` at line 698** is a different case and must NOT be given `LONG`.
  Two starts race, one must be refused and the other must reach a conclusion,
  so the winner is required to FINISH inside the test. A duration nothing can
  outrun would hang the winner and turn `concluded.length === 1` red. The
  exposure is real and inverted: the refusal has to land inside those three
  seconds, and on a slow runner the winner can finish and give back its claim
  before the loser gets there, at which point the loser concludes instead of
  being refused. Fixing it needs a barrier the test can wait on, not a
  different constant.

### Accepted, with reason

A fixed sleep before a NEGATIVE assertion is correct: there is no condition to
poll for. These are listed so that a future reader does not "fix" them into
polls, which would make them prove nothing.

| Location | Sleep | Outlives |
|---|---|---|
| `test/integration/boundary-permissions.test.js:65,101,138,221,242` | 300 | "no permission card is coming" |
| `test/integration/codex-approvals.test.js:185,207` | 200, 300 | "no duplicate `done` envelope is coming" |
| `test/integration/codex-delegation.test.js:145,180` | 400 | "the stale `end_delegation` did not kill the restored parent" |
| `test/integration/codex-keepalive.test.js:80` | `KEEPALIVE_MS * 4` | "the heartbeat has stopped" |
| `test/integration/delegation.test.js:109` | 300 | "no second spawn for a duplicate delegation" |
| `test/integration/delegation.test.js:432` | 1200 | "the circuit breaker stopped a fourth hop" |
| `test/integration/external-tree-changes.test.js:241,263,293,317,380` | `POLL_MS * 6` | six poll intervals with no push |
| `test/integration/kill-window.test.js:226` | 800 | "no stray routing-prompt result" |
| `test/integration/process-lifecycle.test.js:70` | `REAP_MS * 5` | "the sweep did not take a conversation with a background task" |
| `test/integration/reaper-disabled.test.js:40` | `WOULD_HAVE_REAPED_MS * 6` | "no sweep is armed at all" |
| `test/integration/scheduler-workspace-lifecycle.test.js:498` | 500 | "the new start did not re-fire a mid-run routine" |
| `test/integration/smoke-plan.test.js:104` | 600 | "no auto-resume turn started" |
| `test/integration/watcher-baseline.test.js:55` | 4500 | two full watcher polls from boot |
| `test/integration/workspace-move.test.js:110,155` | 150, 200 | "orphan cleanup signalled nothing", "no rebuild started" |
| `test/integration/workspace-rollback-poll.test.js:149` | `POLL_MS * 6` | "the rollback re-baselined the poll, so nothing was pushed" |
| `test/integration/live-refresh.test.js:41,59` | `timeout: 1600` | a deliberate `waitFor` expiry inside `assert.rejects` |
| `test/unit/codex-appserver.test.js:817` | 150 | "no auto-restart fired" |
| `test/unit/scheduler-lib.test.js:648,1285,1294,1522` | `until(() => false, N)` | "no release / no death / nothing stronger sent" |
| `test/e2e/viewers.spec.js:482,539,569,915` | 200, 300, 900, 2000 | "no toolbar", "no spurious autosave", "the flag outlived the old 600ms clear", "no false conflict past the watcher poll" |
| `test/e2e/search.spec.js:93` | 600 | "the flash animation did not replay" |
| `test/unit/wait-for.test.js:73` | `>= 50` against a 60ms budget | "the helper did not short-circuit its deadline" |

`h.delay()`'s own doc comment in `test/helpers/harness.js` states this rule and
records the flake that produced it: `REAP_SWEEP_MS` is floored at 1000ms in
`server.js` regardless of `RUNDOCK_IDLE_REAP_MS`, so a test that sleeps a
multiple of the idle window is racing that floor rather than the behaviour.
That race failed CI on Node 24 while Node 22 passed the same commit.

Two accepted entries are weaker than they look and are recorded as such rather
than changed here:

- **`test/integration/process-lifecycle.test.js:169`** sleeps `REAP_MS * 3`
  (900ms) against that same 1000ms sweep floor, so the window can contain zero
  real sweeps and the negative can pass vacuously. It proves less than it
  appears to.
- **`test/integration/reaper-disabled.test.js:40`** compares against a notional
  interval: with the reaper disabled no sweep is armed at all, so the constant
  is measured against nothing.

### Timing-dependent but sound

These are load-sensitive in principle and correct in construction, because the
timing is a seam rather than a sleep. Listed so the inventory is complete.

- **Injected budgets.** `test/unit/codex-appserver.test.js` passes
  `requestTimeoutMs`, `overloadRetry`, `restartBackoff` and `shutdownGraceMs`
  in as options, so backoff and timeout paths run in milliseconds. Its
  `nextEvent` default of 15000 is deliberately generous and its comment records
  the observed flake it answers ("`done` after interrupt landing just beyond
  5s"). `test/integration/codex-cancel-followup.test.js` injects `FAILSAFE_MS`
  and `RETRY_MS` the same way.
- **Mocked clocks.** `test/unit/scheduler.test.js` pins `Date` for the whole
  file. `test/unit/scheduler-slots-dst.test.js` proves DST behaviour with zero
  elapsed time. `test/unit/root-remainder-edges.test.js` advances a 10s
  production failsafe virtually. `test/unit/routines-next-run.test.js` gets the
  same determinism by swapping `global.setInterval` by hand.
- **Injected clocks.** `test/unit/fixture-hygiene.test.js` proves stale-fixture
  sweeping by passing `now` forward, never by waiting.
- **Bounded polls.** `test/unit/signals.test.js` and `signals-lib.test.js`
  (2000/25), `test/unit/red-first-orphans.test.js`'s `until` (15000/50),
  `test/unit/codex-appserver.test.js`'s `waitForInvocation` (2000/10). All the
  right shape.
- **Long-lived children as negative devices.** `setInterval(() => {}, 1e9)` and
  `sleep ${LONG}` in `test/helpers/stub-claude/claude`,
  `test/unit/pid-file.test.js` and `test/unit/red-first-orphans.test.js` exist
  so that a process cannot end on its own, which is what makes "still running"
  attributable to a leak. `LONG` is deliberately non-round so a `ps` match
  cannot collide with an unrelated sleep.
- **Ordering assertions.** `test/integration/search-warmup.test.js`'s
  `answered < ready` is an ordering claim, not a speed claim, and holds
  regardless of machine speed once the wait itself is bounded properly.

### Exact counts that could race

Every one of these reads a count at an instant the test chose. Most are
preceded by a barrier that makes them sound; the ones without a barrier are
the exposure. None has been changed in this pass.

The best-constructed instance in the suite is
`test/integration/scheduler-single-flight.test.js:211`, which waits for a
*control* routine's spawn from the same tick to land in the child-written log
before reading the count. That guarantees the log is current. Copy that shape.

Counts with no barrier, ranked by exposure:

| Location | Count | Exposure |
|---|---|---|
| `test/integration/delegation.test.js:775` | `invs.length === 1` | The known flake. See below. |
| `test/integration/delegation.test.js:567,569` | `1`, `0` | Rests on a follow-up landing inside an unenforced 500ms production auto-return window. |
| `test/integration/codex-status-cache.test.js:68,75` | `3` | Valid only if the file runs inside an uninjected 60s production cache window. |
| `test/integration/codex-spawn-error.test.js:88` | `1` | Valid only if both spawn attempts fall inside an uninjected 30s dedupe window. |
| `test/integration/conversation-enrichment.test.js:172` | `0` file reads | A global `fs` monkey-patch armed for a window: the same shape as the file-tree-cache defect, and it does not exclude dotfolders either. Has not been observed to fail. |
| `test/integration/process-lifecycle.test.js:109` | `CONVOS` live entries | Races the reaper it is about to test. |
| `test/integration/codex-delegate-edges.test.js:89,111,130` | `1`, `0`, `1` | Read with no settling window; a second error in flight would be missed. |
| `test/integration/chat-basic.test.js:59,138` | `1` | Child-written log, so the count lags the server. |
| `test/e2e/file-tree-state.spec.js:66` | `toBeGreaterThan(before)` | A non-retrying count comparison, protected only by a 600ms sleep. |

### Wall-clock budgets

Three assertions in the suite gate on elapsed real time. All three are
**accept**, with the caveats stated.

- **`test/integration/workspace-rollback-poll.test.js:185`**:
  `Date.now() - wroteAt <= PUSH_WINDOW_MS` (480ms). The most exposed assertion
  in the directory: four poll intervals plus a tree walk plus a WebSocket
  round-trip, with a hard real-time ceiling. It is the only thing proving the
  server honours the configured 120ms interval rather than its 2s production
  default, so the ceiling is the point and cannot simply be raised. If this
  starts failing, it needs a different proof, not a bigger number.
- **`test/unit/search-perf.test.js:75,89`**: `avgMs < 100` and `ms < 50`.
  Budgets against observed times of 1 to 5ms, so 20x to 100x headroom. Note
  that line 89's budget is strictly weaker than the `sessionsRead === 0`
  assertion two lines above it, which proves the same property exactly. The
  build measurement at line 51 is logged and never asserted, so it will never
  catch a regression.
- **`test/integration/http-api.test.js:351`**:
  `Date.now() - t0 >= PERM_TIMEOUT - 50`. A lower bound proving the server did
  not short-circuit its own timeout. Correct shape; the `- 50` is a bare
  tolerance for timer coarseness.

### Isolate

**The Playwright browser suite** (`test/e2e/`) is the one part of this
repository that should not run concurrently with anything else on the machine.
It drives a real browser against a real server, and its waits are calibrated
against animation durations and save round-trips: `viewers.spec.js` alone
carries seven bare 300ms settles standing in for a `save_file` landing on
disk, with no acknowledgement to wait for. The 2026-08-14 failure was traced
to contention rather than to any assertion in it.

It is already separated by command (`npx playwright test`, not `npm test`), so
the isolation to preserve is operational: do not run it beside another card's
suite on the same machine. The `.tool.js` files in that directory are skipped
unless `RUN_TOOLS` is set and are instruments rather than tests, which is why
their three different constants for the same 0.2s transition (450, 500, 600)
are recorded here but not reconciled.

### Known, not fixed

**`test/integration/delegation.test.js:775`**, "agent CRUD while an
orchestrator is live flags it". Asserts a spawn count of one; observed two,
twice, during gate runs taken while a disk cleanup was running. The prior
investigation in `.review/scheduler-lifecycle-evidence.md` established
structurally that the scheduler cannot contribute an invocation in that file
(`standardTeam()` declares no routines) and empirically that ten full runs on a
quiet machine are green. The second invocation's origin is therefore still
open. Candidates worth checking first: a stub write from the previous spawn
landing after `clearInvocations()`, and the agents poller re-flagging the
conversation between the save and the follow-up. Not fixed here because
guessing at it would produce a change that cannot be shown to help.

**`test/integration/process-lifecycle.test.js:109`**, the precondition *every
completed conversation leaves a live process*. Recorded in
`.review/navigation-inventory-evidence.md` as failing once in its own setup
rather than in an assertion, and passing on re-run. It failed again during a
full-suite run on this branch, which finally gives it a captured message and a
mechanism.

The mechanism is the test racing the reaper it is about to test. The file sets
`RUNDOCK_IDLE_REAP_MS` to 300ms, then completes four turns in sequence and
asserts all four processes are still live. A conversation becomes reapable
300ms after it goes idle and the sweep runs about every second, so the moment
the four turns take longer than that between them, the earliest conversation is
already eligible and a sweep can take it before the count is read. On an idle
machine the four turns finish well inside the window; under contention they do
not.

Not fixed here because the honest fix needs a seam that does not exist.
`reapIdleAgents(now)` in `server.js` already accepts an injected clock, which
is exactly what a deterministic version of this test would drive: set an idle
window nothing can cross during setup, assert the four are live, then call the
sweep directly with time advanced. It is not on `module.exports._internal`, so
exposing it is a production change and a design decision rather than a test
repair, and it belongs to whoever picks this up rather than being smuggled in
here. Widening the precondition instead would delete the property it states.

## Adding a wait

Before you write one, check whether you need it at all. In order of
preference:

1. **Assert on a structural fact instead.**
   `test/unit/codex-runtime.test.js` pins a timing pathology (a probe hanging
   on an open stdin) by asserting the `stdio` argument shape. No clock.
2. **Mock or inject the clock.** `t.mock.timers`, or pass the duration in as
   an option.
3. **Wait for the condition.** `h.waitUntil`, `client.waitFor`,
   `h.waitForPidExit`, or Playwright's `expect.poll` and auto-retrying
   assertions.
4. **Sleep, only for a negative**, with a comment naming the interval it
   outlives and why that multiple.

If you add a wait that falls outside those four, add it to this document with
its classification in the same commit.
