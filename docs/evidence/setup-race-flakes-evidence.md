# Two setup-races-the-measurement flakes: measurements

Everything below was run on branch `fix/setup-race-flakes` against `origin/main` at
`ea14682`, on Node v24.12.0, macOS.

**Round 1** review (`91b534570b67` / diff `9c7a457bdb4c`) rejected on AC-3, AC-4 and
AC-5 for having no file in the diff, and separately flagged that the idle-reap test
wrote production's own fields without checking production still sets them. Both were
addressed and are recorded below.

**Round 2** review (diff `90a08dd640d7`) rejected again, on six blocking findings, and
was right on all six:

1. The AC-3 discharge (then: 30 solo-under-load runs) was measured in a different
   contention mode from the one the criterion names and the one the recorded failure
   actually occurred in (full-suite parallelism via `npm test`). Fixed below: AC-3 is
   now discharged on full-suite runs, with the solo runs kept as supporting data only.
2. A real defect inside the SIGINT test's own fix: `writeFileSync` creates a file at
   `open()` before the pid is written, so a poll on mere existence could fire on an
   empty marker under load, and the exit handler's `Number('')` (`0`) made
   `process.kill(0, 0)` always succeed, masking the real check behind a misleading
   `pid 0` failure. This is a plausible cause of the one uncaptured full-suite failure
   from round 1's evidence. Fixed: see "The marker race" below.
3. AC-5 break 2 was proven against an uncommitted copy of the idle-reap test's body,
   not the committed file. Fixed: re-run against the committed file directly, recorded
   below with the hang it still produces and how that was handled.
4. AC-4's proof was two `node -e` primitives under a hand-written sandbox profile, not
   the committed test, and that profile would also have denied the test's own fixture
   creation. Addressed below by stating plainly what could and could not be shown.

**Round 3** review (diff `3279b9153796`) rejected on three findings and was right on
all three:

1. AC-5 break 2's committed-file run went red in 155ms, which is shorter than
   `REAP_MS` (300ms) and cannot include the timed-out wait the behavioural assertion
   requires, so it was a precondition failure, not the behavioural assertion. Cause,
   as diagnosed by the reviewer and confirmed: disabling the sweep also breaks the
   sibling test `an ordinary turn in the same run is still reaped`, which never calls
   `h.reapConvo`, leaving a fifth live entry that the target test's own
   four-live-processes precondition then failed against. Fixed below by isolating the
   target test with `test.only` before re-running the break.
2. The evidence claimed the 155ms run reached the behavioural assertion; corrected.
3. The claim that no sandbox profile could grant the fixture directory's creation
   while denying the pre-fix marker was wrong: `fs.mkdtempSync` appends exactly six
   alphanumeric characters, and a grant shaped for that (once a `sandbox-exec` tool
   quirk was found and worked around) discriminates the two. Fixed below: AC-4 now
   has a positive, discriminating proof against the committed test, not a stated
   absence.

This file now carries all three rounds' measurements rather than only the latest, so
a reader can see what changed and why.

## AC-5: both behaviours broken in turn, and the test that went red

### The marker race, found by round 2 review, fixed before re-running break 1

Round 2 found a real defect inside round 1's own fix, not in the evidence: the
trapping child wrote its pid with a plain `writeFileSync(marker, String(pid))`, which
creates the file at `open()` before the pid bytes land. Under load the child can be
descheduled between those two syscalls, so a poll on `fs.existsSync(marker)` could
observe the marker before its content was written, send SIGINT into that window, and
have the exit handler read an empty file. `Number('')` is `0`, and
`process.kill(0, 0)` signals the test's own process group rather than a real pid and
always succeeds, so the liveness loop never went false and the test failed with a
misleading `pid 0` message, a scheduling-speed dependence of exactly the class this
card exists to remove, and a real candidate for the one uncaptured full-suite failure
in round 1's evidence.

Fixed by writing the pid to a temporary name and renaming it into place (atomic on the
same filesystem, so the marker's existence now implies complete content), and by
having the exit handler refuse a non-positive-integer pid with its own message rather
than pass it to `process.kill`. Both break-1 and break-2 below were re-run after this
fix; break 1's line numbers moved as a result.

### Break 1: `scripts/red-first.js`, the child is never ended

`endChild()` (line 256) normally sends SIGTERM then SIGKILL to the trapping
child's process group on interrupt. Changed to an immediate `return`:

```
  const endChild = () => {
    // AC-5 PROOF (setup-race-flakes, round 3): deliberately disabled, must not be committed.
    return;
  };
```

Ran `node --test test/unit/red-first.test.js --test-name-pattern="traps SIGINT"`
(post marker-race-fix). Result: **29 pass, 1 fail.** The one that turned red:

```
✖ a test command that traps SIGINT does not hold the tree hostage (3429.924458ms)
  AssertionError [ERR_ASSERTION]: the trapping child (pid 69486) must be ended, not left running

  true !== false

      at ChildProcess.<anonymous> (test/unit/red-first.test.js:874:20)
```

A real pid (`69486`), not `0`: the marker-race fix did its job even under this same
deliberately-broken run. That is the pid-liveness assertion this test exists for, not
a precondition. Reverted with `git checkout -- scripts/red-first.js`; `git status
--porcelain` showed the file clean. Re-ran the same command: **30 pass, 0 fail**,
including this test at 424ms.

### Break 2: `server.js`, the sweep never retires anything

`reapIdleAgents()` (line 2509) normally checks `entry.idle` and `now - entry.idleSince
< IDLE_REAP_MS` for every tracked process. Changed to an unconditional no-op:

```
function reapIdleAgents(now = Date.now()) {
  // AC-5 PROOF (setup-race-flakes, round 3): deliberately disabled, must not be committed.
  return 0;
  let reaped = 0, processes = 0;
  ...
```

**Round 2 correctly rejected the first version of this proof** (an uncommitted
throwaway copy) **and round 3 correctly rejected the second** (the committed file's
own `✖` line, but at 155ms, too fast to be the behavioural assertion: `REAP_MS` is
300ms and reaching `liveEntries().length < CONVOS` after a broken sweep requires four
completed turns plus `h.waitUntil` timing out, on the order of eight seconds, as the
passing run and the throwaway copy both show). The reviewer's diagnosis was specific
and checkable: the disabled sweep also breaks the sibling test `an ordinary turn in
the same run is still reaped, so the guard is not blanket`, which never calls
`h.reapConvo` on its own conversation, so a fifth live entry was present when the
target test's `assert.strictEqual(liveEntries().length, CONVOS, ...)` precondition
ran, and it read 5 instead of the expected 4 setup-side, not the sweep's own count.
That is a setup-step red, exactly the failure class this card exists to remove,
appearing inside the card's own proof.

Fixed by isolating the target test with `test.only`, applied directly to the
committed file (uncommitted; reverted immediately after the run, alongside the
`server.js` break):

```
test.only('an idle process is reaped instead of living for the whole session', async () => {
```

```
node --test --test-only test/integration/process-lifecycle.test.js
```

With no sibling test running, no un-reaped sibling process inflates the count. Result,
the committed file's own inline failure block, quoted verbatim and in full, with a
duration this time consistent with `h.waitUntil` actually timing out:

```
✖ an idle process is reaped instead of living for the whole session (8158.940791ms)

✖ failing tests:

test at test/integration/process-lifecycle.test.js:95:8
✖ an idle process is reaped instead of living for the whole session (8158.940791ms)
  AssertionError [ERR_ASSERTION]: idle agent processes must not accumulate one per conversation for the life of the session. After 4 completed turns and 1200ms idle, 4 were still alive (agents: chief-of-staff, chief-of-staff, chief-of-staff, chief-of-staff).
      at TestContext.<anonymous> (test/integration/process-lifecycle.test.js:158:12)
```

8158ms, not 155ms: this is the behavioural assertion (`liveEntries().length < CONVOS`
never became true), reached only after every precondition this round added, including
the fixed one, passed first. Isolating the test also happened to avoid the
`h.shutdown()` hang entirely: with only one test's processes ever left untracked
instead of six, shutdown completed normally and the run produced its full end-of-run
recap rather than hanging after the summary line.

Reverted both the `.only` marker and `server.js` with `git checkout -- server.js
test/integration/process-lifecycle.test.js`; `git status --porcelain` showed the tree
clean. Re-ran `node --test test/integration/process-lifecycle.test.js` (the committed
file, unrestricted, no `.only`): **6 pass, 0 fail**, no hang, including the target
test at ~1000ms.

## AC-4: the committed test, discriminated by a real sandbox

**Round 2 correctly rejected round 1's proof** (two `node -e` one-liners under a
hand-written profile, not the committed test) **and round 3 correctly rejected round
2's conclusion that no discriminating profile exists.** That conclusion rested on a
regex, `(allow file-write* (regex #"/red-first-[^/]+/.+$"))`, chosen too loosely: it
required a path segment after the `red-first-` prefix, which also excludes the bare
mkdtemp directory's own creation, so it looked as if directory-creation and
marker-creation could not be told apart. The reviewer's fix was to use the fact that
`fs.mkdtempSync` appends exactly six alphanumeric characters, narrow enough to admit
the fixture directory while excluding a differently-shaped marker name. Tried, and it
works, after finding and working around one tool quirk along the way:

**The quirk:** macOS `sandbox-exec`'s `regex` predicate does not support the `{n}`
interval-quantifier syntax (confirmed by bisection: `red-first-[A-Za-z0-9]{6}` denies
everything, `red-first-[A-Za-z0-9]{6}` with the braces escaped as `\{6\}` also denies
everything, but `red-first-......` (six literal dots) and `red-first-[A-Za-z0-9]`
repeated six times both work). The working pattern spells the character class out six
times rather than using a count.

**The profile:**

```
(version 1)
(allow default)
(deny file-write* (with no-log))
(allow file-write* (regex #"/red-first-[A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9](/.*)?$"))
(allow file-write* (subpath "<HOME>/.npm"))
(allow file-write* (subpath "/dev"))
```

`/dev` is granted because `git init`, used by the test's own `repo()` fixture, opens
`/dev/null`; without it every fixture-building test fails on that, not on anything
this card is about.

**Validated against three direct cases first**, each a small `node -e` under the
profile: `fs.mkdtempSync(path.join(os.tmpdir(), 'red-first-'))`, the bare fixture
directory, **succeeded**. `fs.writeFileSync(path.join(os.tmpdir(),
'red-first-trap-' + pid + '.txt'), ...)`, the pre-fix marker shape, **denied**
(`EPERM`). A write to `<fixture>/.git/trap-marker`, the fixed marker's shape,
**succeeded**. The three-way distinction the criterion asks for exists.

**Then the committed test itself, discriminated, not a primitive.** The pre-fix
version of `test/unit/red-first.test.js` (`git show origin/main:test/unit/red-first.test.js`),
copied to `test/unit/red-first-prefix-throwaway.test.js` (uncommitted, deleted after
the run) so its relative `require`s resolved, with `test.only` added to the target
test to isolate it from siblings that write outside the fixture under a different
naming scheme (see below):

```
sandbox-exec -f ac4-final.sb node --test --test-only test/unit/red-first-prefix-throwaway.test.js
```

```
✖ a test command that traps SIGINT does not hold the tree hostage (654.807958ms)
  AssertionError [ERR_ASSERTION]: the trapping child really did start and ignore the signal
  false !== true
```

The marker never appeared: the trapping child's `writeFileSync` into `os.tmpdir()`
was denied by the sandbox, so the child never wrote it, and this is the pre-fix red.
The committed test, same isolation, same profile:

```
sandbox-exec -f ac4-final.sb node --test --test-name-pattern="traps SIGINT" test/unit/red-first.test.js
```

```
✔ a test command that traps SIGINT does not hold the tree hostage (840.13075ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

**Pre-fix red, post-fix green, identical sandbox, identical command shape, the
committed file both times.** That is AC-4 discharged: the fix changes this test's own
pass/fail outcome under a real sandbox that denies the old marker location.

**Also run: the whole committed file, unrestricted, under the same profile**, as a
sanity check beyond the one target test: **29 pass, 1 fail** (of 30). The one failure,
`NODE_TEST_CONTEXT is stripped, because it makes a nested runner exit 0`, is a
different, pre-existing test that writes its own probe file directly at
`os.tmpdir()/red-first-env-<pid>.txt`, a name this sandbox's grant does not cover
(nor was it meant to: it is shaped for the mkdtemp fixture, not for that test's own
unrelated naming). Out of scope for this card, per the frozen criteria ("Out of
scope: ... Any other test"), and left as-is; noted here rather than silently excluded
from the count.

The code comment in `test/unit/red-first.test.js` explaining the marker's location
now states this finding in its own words rather than deferring to this file, and no
longer claims the discriminating sandbox is unconstructible, which round 3 correctly
identified as false.

## AC-3: repeated runs under load

**Round 2 correctly declined to treat a solo-under-load discharge as satisfying this
criterion.** AC-3 names full-suite parallelism, and the only recorded failure of the
SIGINT test happened in exactly that mode (Run A, iteration 4, below); the 30-run
discharge offered in round 1's evidence ran the test file alone under external load, a
different contention profile that does not include the sibling test files' own side
effects sharing the runner (this diff's own comment on `waitForCondition` notes that
`test/helpers/workspace.js` sweeps the temp root at require time, a side effect only
present when other test files requiring the harness are also loaded in the same
process, which solo mode does not reproduce). A result that failed once in the named
mode and was re-measured only in a different mode does not prove the named-mode claim.
That solo evidence (Runs C and D below) is kept as supporting data, explicitly marked
as not the discharge.

### The full-suite record (the mode AC-3 names)

**Run A: full suite, 5 iterations**, `npm test` (`node --test "test/**/*.test.js"`,
2428 tests across the whole repo, real cross-file parallelism), taken before the
marker-race fix:

| Iteration | `a test command that traps SIGINT does not hold the tree hostage` | `an idle process is reaped instead of living for the whole session` | suite pass/fail |
|---|---|---|---|
| 1 | pass | pass | 2420/0 |
| 2 | pass | pass | 2420/0 |
| 3 | pass | pass | 2420/0 |
| 4 | **fail** | pass | 2419/1 |
| 5 | pass | pass | 2420/0 |

**Run B: full suite, 8 further iterations**, same command, run afterward, also before
the marker-race fix:

| Iteration | SIGINT test | idle-reap test | suite pass/fail |
|---|---|---|---|
| 1 | pass | pass | 2420/0 |
| 2 | pass | pass | 2420/0 |
| 3 | pass | pass | 2420/0 |
| 4 | pass | pass | 2420/0 |
| 5 | pass | pass | 2420/0 |
| 6 | pass | pass | 2418/2 |
| 7 | pass | pass | 2419/1 |
| 8 | pass | pass | 2417/3 |

The unrelated failures in iterations 6-8 of Run B were, by name: `a decoded quote in
an ordinary destination cannot open an attribute`, `an ordinary link resolves to the
destination the document names`, `a skill name carrying markup renders as text`, `a
refusal with no words of its own still says something useful`, `no call that draws
this list exists that this file does not name`, `the roster arriving from the server
draws the list`, none of them either of this card's two tests, all consistent with
other suites flaking under the same concurrent load rather than with this change.

The one SIGINT failure across Runs A and B (Run A, iteration 4) is reported rather
than dropped. Its full output was not captured, a gap this round's script fixed by
saving every iteration's complete log. Kept here rather than superseded: **this is the
uncaptured failure the marker-race fix targets**, and its absence from the fresh runs
below is evidence for, not proof of, that fix addressing it.

**Run E: full suite, 15 further iterations, complete output captured for every
iteration, taken AFTER the marker-race fix** (round 3, this diff). Command, log
location, and per-iteration result all machine-generated from
`.rundock/ac3-fullsuite-r3/progress.log` (gitignored scratch inside the worktree, not
committed) rather than transcribed by hand:

```
=== iteration 1 / 15 ===   SIGINT=PASS  idle-reap=PASS  | tests 2428 pass 2420 fail 0
=== iteration 2 / 15 ===   SIGINT=PASS  idle-reap=PASS  | tests 2428 pass 2420 fail 0
=== iteration 3 / 15 ===   SIGINT=PASS  idle-reap=PASS  | tests 2428 pass 2420 fail 0
=== iteration 4 / 15 ===   SIGINT=PASS  idle-reap=PASS  | tests 2428 pass 2420 fail 0
=== iteration 5 / 15 ===   SIGINT=PASS  idle-reap=PASS  | tests 2428 pass 2420 fail 0
=== iteration 6 / 15 ===   SIGINT=PASS  idle-reap=PASS  | tests 2428 pass 2420 fail 0
=== iteration 7 / 15 ===   SIGINT=PASS  idle-reap=PASS  | tests 2428 pass 2420 fail 0
=== iteration 8 / 15 ===   SIGINT=PASS  idle-reap=PASS  | tests 2428 pass 2420 fail 0
=== iteration 9 / 15 ===   SIGINT=PASS  idle-reap=PASS  | tests 2428 pass 2420 fail 0
=== iteration 10 / 15 ===  SIGINT=PASS  idle-reap=PASS  | tests 2428 pass 2420 fail 0
=== iteration 11 / 15 ===  SIGINT=PASS  idle-reap=PASS  | tests 2428 pass 2420 fail 0
=== iteration 12 / 15 ===  SIGINT=PASS  idle-reap=PASS  | tests 2428 pass 2420 fail 0
=== iteration 13 / 15 ===  SIGINT=PASS  idle-reap=PASS  | tests 2428 pass 2420 fail 0
=== iteration 14 / 15 ===  SIGINT=PASS  idle-reap=PASS  | tests 2428 pass 2420 fail 0
=== iteration 15 / 15 ===  SIGINT=PASS  idle-reap=PASS  | tests 2428 pass 2419 fail 1
TALLY: SIGINT pass=15 fail=0 | idle-reap pass=15 fail=0 (of 15)
```

Iteration 15's one unrelated failure was `agent CRUD while an orchestrator is live
flags it; the next message respawns it instead of reusing stdin`
(`test/integration/delegation.test.js:752`), not either of this card's two tests,
again consistent with other suites flaking under load rather than with this change.

**AC-3 discharges on the full-suite record, Runs A, B and E combined: 28 full-suite
iterations of the named mode, 27 pass, 1 fail.** The one failure (Run A, iteration 4)
predates the marker-race fix and was never reproduced afterward, including across all
15 of Run E's iterations, each with full output saved specifically so a recurrence
could be read rather than merely counted. This is stated as the discharge basis
precisely because the mode matches what the criterion names, not because the count is
larger than round 1's.

### Supporting data only, not the discharge (kept from round 1)

**Run C: targeted, 10 iterations**, `node --test test/unit/red-first.test.js
test/integration/process-lifecycle.test.js` (just the two files, run back to back, a
narrower mode than full-suite parallelism): 10/10 pass for both named tests, no
unrelated failures (36/36 each run).

**Run D: the SIGINT test alone, 30 iterations, full output captured for every run,
under deliberately generated load** (also a narrower mode: the file alone under
`--test-name-pattern`, not inside the runner's own full-suite parallel batch). Three
concurrent loops of the full suite (`npm test`, restarted back to back) ran for the
whole window, 57 full-suite passes completed across them by the time the 30
iterations finished. Command for each iteration:

```
node --test test/unit/red-first.test.js --test-name-pattern="traps SIGINT"
```

Each run's complete output was written to its own file (not committed; scratch).
Elapsed time per run ranged 540ms to 3090ms, well above the 250-350ms typical of an
unloaded run, evidence the load was real rather than nominal. **30 pass, 0 fail.**
Consistent with, but not a substitute for, the full-suite record above.

## Red first

`node scripts/red-first.js --base origin/main --tests "npm test"` on the committed
tree returns `NOT-DISCRIMINATING`, with `sourceFiles: 1`, `testFiles: 2`,
`testsPassedWithChange: 2420`, `testsFailedWithoutChange: 0`.

Same shape as the fixture-cleanup investigation's own red-first section, and the
same reason: `isTest()` classifies anything under a `test/` path segment as a test, so
the one file the tool reverted is this evidence document, not code. Deleting a
markdown file does not break the suite, so the tests pass exactly the same reverted as
they do with the change, and NOT-DISCRIMINATING is the true, if misleading-sounding,
verdict for that experiment. It says nothing about the two test files, which is where
the actual behaviour change and the AC-5 breaks above live. Recorded here rather than
worked around, per the original instruction to report a verdict the tool cannot earn
plainly rather than route past it.

## Command reference

```
npm test                                                                              # Run A, B, E (full suite)
node --test test/unit/red-first.test.js test/integration/process-lifecycle.test.js    # Run C
node --test test/unit/red-first.test.js --test-name-pattern="traps SIGINT"            # Run D, AC-5 break 1
node --test --test-only test/integration/process-lifecycle.test.js                    # AC-5 break 2 (committed file, target test isolated with .only, uncommitted, reverted after)
node --test test/integration/process-lifecycle.test.js                               # AC-5 break 2 revert check
sandbox-exec -f <profile> node --test --test-only <pre-fix copy>.test.js             # AC-4 pre-fix red
sandbox-exec -f <profile> node --test --test-name-pattern="traps SIGINT" test/unit/red-first.test.js   # AC-4 committed green
sandbox-exec -f <profile> node --test test/unit/red-first.test.js                    # AC-4 whole-file sanity check
```
