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

This file now carries both rounds' measurements rather than only the latest, so a
reader can see what changed and why.

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

**Round 2 correctly rejected the first version of this proof**, taken from an
uncommitted throwaway harness file said to reproduce the committed test's body: a
stand-in a reviewer cannot check against the real file. Re-run directly against the
committed file:

```
node --test test/integration/process-lifecycle.test.js --test-name-pattern="idle process is reaped"
```

`--test-name-pattern` does not skip non-matching tests in this Node version (all six
of the file's tests still ran; confirmed by the full output). The committed file's own
line for the target test, verbatim:

```
✖ an idle process is reaped instead of living for the whole session (155.635625ms)
```

followed by the describe block's own summary:

```
✖ idle agent processes (27508.783917ms)
```

Both carry the `✖`, taken from the real, committed file, not a copy. The process then
hung after printing `Client disconnected`, in `h.shutdown()`'s `server.close()`, the
same pre-existing harness behaviour recorded in round 1 for this exact scenario (every
tracked process left untracked at once, disabled sweep). It never reached the final
`ℹ tests/pass/fail` block or the "failing tests:" recap that carries the full
assertion text, so the exact `AssertionError` message quoted in round 1's evidence
(`idle agent processes must not accumulate...`) comes from the throwaway copy, kept
below as supporting material only, not as the proof. Terminated with
`kill -9 <worker pid> <runner pid>`; the redirected run recorded this as `EXIT:137`.

**Round 1's throwaway-copy run, kept as supporting material, not the proof:**

```
✖ an idle process is reaped instead of living for the whole session (8226.331291ms)
  AssertionError [ERR_ASSERTION]: idle agent processes must not accumulate one per
  conversation for the life of the session. After 4 completed turns and 1200ms idle,
  4 were still alive (agents: chief-of-staff, chief-of-staff, chief-of-staff,
  chief-of-staff).
```

That is the behavioural assertion (the sweep never dropped below 4), reached only
after this branch's own new preconditions, the wait for `entry.idle === true` and
the assertions on `idle`/`idleSince`, passed first, in both the committed run and the
copy. The precondition machinery this round added does not mask the break in either.

Reverted with `git checkout -- server.js`; `git status --porcelain` showed the file
clean. Re-ran `node --test test/integration/process-lifecycle.test.js` (the committed
file, unrestricted): **6 pass, 0 fail**, no hang, including the target test at
~1000ms.

## AC-4: unproven here, stated plainly rather than reasoned around

**Round 2 correctly rejected round 1's AC-4 proof.** It ran two `node -e` one-liners
under a hand-written `sandbox-exec` profile, not the committed test, and that profile
denied writes to the temp root outright, which would also have denied the committed
test's own fixture creation: `repo()` calls `fs.mkdtempSync(path.join(os.tmpdir(),
'red-first-'))`, itself a write to the temp root (a new directory entry needs write
permission on its parent), so the committed test cannot run under the sandbox that
proof modelled at all. The round 1 write-primitives are kept below as an illustration
of the underlying mechanism, relabelled as exactly that, not as proof of the committed
test's behaviour.

**What round 3 tried, to show the committed test itself failing pre-fix and passing
post-fix under one sandbox that denies the old marker location while permitting
fixture creation:** a regex-based grant, `(allow file-write* (regex
#"/red-first-[^/]+/.+$"))`, intended to permit writes *inside* an already-created
`red-first-XXXXXX` fixture directory while denying writes directly at the temp root.
This does not work, for a reason specific to this test's own history rather than a
general limitation: `repo()`'s fixture directories and the pre-fix marker file share
the same `red-first-` name prefix (`red-first-XXXXXX` for the directory,
`red-first-trap-<pid>.txt` for the old marker), both as bare entries directly under
the temp root. A path-pattern sandbox rule cannot distinguish "grant directory
creation for this mkdtemp prefix" from "grant file creation for this marker name"
when both are siblings under the same parent matching the same prefix; a regex loose
enough to allow the fixture directory to be created is loose enough to also have
allowed the old marker, and a regex tight enough to exclude the old marker (requiring
a path segment after the prefix) also excludes the bare directory-creation step
itself. No sandbox profile reachable in this environment grants "create
`red-first-XXXXXX`" while denying "create `red-first-trap-<pid>.txt`", because to the
sandbox both are the same operation (`file-write-create` on a new sibling path under
a denied parent) with no property other than the exact string that separates them.

**So: AC-4's discriminating claim, that the fix changes the SIGINT test's own
pass/fail outcome under a real sandbox, is unproven in this environment.** What was
observed instead is the non-discriminating pass recorded at the top of this section
in round 1 and reconfirmed after the marker-race fix:

```
node --test test/unit/red-first.test.js --test-name-pattern="traps SIGINT"
```

under this session's own command sandbox (no override; `dangerouslyDisableSandbox`
was not used for any run in this file), which grants `$TMPDIR` and so does not
distinguish the old marker location from the new one: **30 pass, 0 fail**, the target
test at 424ms (post marker-race-fix; see the command reference for the full-file run
this number is drawn from).

The code comment in `test/unit/red-first.test.js` explaining the marker's location no
longer claims an observed sandbox failure for the old path; it states the grant this
location is designed to satisfy and points here for what was and was not shown.

**Illustration only, not proof of the committed test, kept from round 1:** the same
`sandbox-exec` grant Rundock's own workspace scaffolding declares
(`lib/workspace/scaffold.js`'s `sandboxSettings()`: `allowWrite: [dir, ~/.npm]`) run
against two `node -e` write primitives, not the test:

```
(version 1)
(allow default)
(deny file-write* (with no-log))
(allow file-write* (subpath "<realpath of a fixture dir>"))
(allow file-write* (subpath "<HOME>/.npm"))
```

```
$ sandbox-exec -f rundock-workspace.sb node -e "require('fs').writeFileSync(path.join(FIXDIR,'.trap-marker'), 'ok')"
WRITE-INSIDE-DIR: succeeded

$ sandbox-exec -f rundock-workspace.sb node -e "require('fs').writeFileSync(os.tmpdir()+'/outside-marker.txt', 'ok')"
Error: EPERM: operation not permitted, open '/var/folders/.../T/outside-marker.txt'
```

This shows the mechanism the fix relies on (a grant naming one directory permits
writes inside it and denies writes to its parent) can exist. It does not show that the
committed test can be run under such a grant, which round 3's attempt above found it
cannot, at least not by a profile constructed from this test's own fixture-naming
scheme.

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

Same shape as `.review/fixture-cleanup-evidence.md`'s own red-first section, and the
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
node --test test/unit/red-first.test.js --test-name-pattern="traps SIGINT"            # Run D, AC-4, AC-5 break 1
node --test test/integration/process-lifecycle.test.js --test-name-pattern="idle process is reaped"   # AC-5 break 2 (committed file; pattern does not narrow which tests run in this Node version)
node --test test/integration/process-lifecycle.test.js                               # AC-5 break 2 revert check
```
