# Two setup-races-the-measurement flakes: measurements

Everything below was run on this branch (`fix/setup-race-flakes`, tree `c39b74ad326b`
at commit time) against `origin/main` at `ea14682`, on Node v24.12.0, macOS. Round 1
review (`91b534570b67` / diff `9c7a457bdb4c`) rejected on AC-3, AC-4 and AC-5 for
having no file in the diff, and separately flagged that the idle-reap test wrote
production's own fields without checking production still sets them. Both are
addressed below and in the diff itself; this file is the record the criteria ask for.

## AC-5: both behaviours broken in turn, and the test that went red

### Break 1: `scripts/red-first.js`, the child is never ended

`endChild()` (line 256) normally sends SIGTERM then SIGKILL to the trapping
child's process group on interrupt. Changed to an immediate `return`:

```
  const endChild = () => {
    // AC-5 PROOF (setup-race-flakes): deliberately disabled, must not be committed.
    return;
  };
```

Ran `node --test test/unit/red-first.test.js --test-name-pattern="traps SIGINT"`.
Result: **29 pass, 1 fail.** The one that turned red:

```
✖ a test command that traps SIGINT does not hold the tree hostage (3707.775417ms)
  AssertionError [ERR_ASSERTION]: the trapping child (pid 64687) must be ended, not left running

  true !== false

      at ChildProcess.<anonymous> (test/unit/red-first.test.js:866:20)
```

That is the pid-liveness assertion this test exists for, not a precondition. Reverted
with `git checkout -- scripts/red-first.js`; `git status --porcelain` showed the file
clean. Re-ran the same command: **30 pass, 0 fail**, including this test at 658ms.

### Break 2: `server.js`, the sweep never retires anything

`reapIdleAgents()` (line 2509) normally checks `entry.idle` and `now - entry.idleSince
< IDLE_REAP_MS` for every tracked process. Changed to an unconditional no-op:

```
function reapIdleAgents(now = Date.now()) {
  // AC-5 PROOF (setup-race-flakes): deliberately disabled, must not be committed.
  return 0;
  let reaped = 0, processes = 0;
  ...
```

Running the full `test/integration/process-lifecycle.test.js` with the sweep disabled
hangs after the suite's own summary line, in `h.shutdown()`'s `server.close()`, a
pre-existing harness behaviour when every one of the file's six tests is left with far
more untracked live processes than usual, unrelated to this change (this file's tests
already ran clean, 6/6, both before this break and after the revert below). To get a
clean read of just the target test, it was run in an isolated throwaway harness file
(own `before`/`after`, not committed, deleted after use) that reproduces exactly the
target test's body against the same `test/helpers/harness.js`. Result: **0 pass, 1
fail**:

```
✖ an idle process is reaped instead of living for the whole session (8226.331291ms)
  AssertionError [ERR_ASSERTION]: idle agent processes must not accumulate one per
  conversation for the life of the session. After 4 completed turns and 1200ms idle,
  4 were still alive (agents: chief-of-staff, chief-of-staff, chief-of-staff,
  chief-of-staff).
```

That is the behavioural assertion (the sweep never dropped below 4), reached only
after this branch's own new preconditions, the wait for `entry.idle === true` and
the assertions on `idle`/`idleSince`, passed first. The precondition machinery this
round added does not mask the break; the break still reaches the real assertion.

Reverted with `git checkout -- server.js`; `git status --porcelain` showed the file
clean. Re-ran `node --test test/integration/process-lifecycle.test.js`: **6 pass, 0
fail**, including this test at ~1000ms.

## AC-4: the SIGINT test under the command sandbox

Every run in this file, including the ones above, was executed through this session's
normal command sandbox with no override (`dangerouslyDisableSandbox` was not used for
any test invocation). `node --test test/unit/red-first.test.js --test-name-pattern="traps
SIGINT"` under that sandbox: **30 pass, 0 fail**, the target test at 658ms.

That is a real pass, but on its own it is not decisive: this session's sandbox grant
happens to include `$TMPDIR`, so under it the OLD marker location (`os.tmpdir()`
directly) and the NEW one (inside the fixture repo, the child's own cwd) are both
writable, and the run cannot tell which one the fix actually depended on. The claim
AC-4 makes is about a stricter grant: the one Rundock's own workspace scaffolding
declares in `lib/workspace/scaffold.js`'s `sandboxSettings()`: `allowWrite: [dir,
~/.npm]`, no temp root at all. That grant was reproduced directly with macOS
`sandbox-exec`, against a real fixture directory built the same way `repo()` in the
test file builds one (`fs.mkdtempSync(path.join(os.tmpdir(), ...))`, real path
resolved because `sandbox-exec`'s `subpath` matches the kernel's post-symlink view,
not `/var/folders/...`):

```
(version 1)
(allow default)
(deny file-write* (with no-log))
(allow file-write* (subpath "<realpath of the fixture dir>"))
(allow file-write* (subpath "<HOME>/.npm"))
```

Write inside the granted fixture directory (mirrors the fix):

```
$ sandbox-exec -f rundock-workspace.sb node -e "require('fs').writeFileSync(path.join(FIXDIR,'.trap-marker'), 'ok'); console.log('WRITE-INSIDE-DIR: succeeded')"
WRITE-INSIDE-DIR: succeeded, marker at .../ac4-sandbox-check-EvQjYi/.trap-marker
```

Write to the system temp root, outside the granted directory (mirrors the marker
location before this fix):

```
$ sandbox-exec -f rundock-workspace.sb node -e "require('fs').writeFileSync(os.tmpdir()+'/outside-marker.txt', 'ok')"
Error: EPERM: operation not permitted, open '/var/folders/.../T/outside-marker.txt'
```

That is the exact distinction the fix depends on, demonstrated directly rather than
asserted in a comment: under a grant that does not include the temp root, a write to
the fixture's own directory succeeds and a write to `os.tmpdir()` is denied. AC-4's
"pass under the sandbox, or skip naming the missing capability" is satisfied by the
pass; there is no skip path because the relocated marker does not need one.

## AC-3: repeated runs under load

Three separate runs, all on this machine while at least one other builder's own
`node --test` processes were independently running and gating (confirmed by process
list; a stray worker from an earlier debugging session was found and killed before
these numbers were taken, so it would not be double-counted).

**Run A: full suite, 5 iterations**, `npm test` (`node --test "test/**/*.test.js"`,
2428 tests across the whole repo, real cross-file parallelism):

| Iteration | `a test command that traps SIGINT does not hold the tree hostage` | `an idle process is reaped instead of living for the whole session` | suite pass/fail |
|---|---|---|---|
| 1 | pass | pass | 2420/0 |
| 2 | pass | pass | 2420/0 |
| 3 | pass | pass | 2420/0 |
| 4 | **fail** | pass | 2419/1 |
| 5 | pass | pass | 2420/0 |

**Run B: full suite, 8 further iterations**, same command, run afterward:

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

**Run C: targeted, 10 iterations**, `node --test test/unit/red-first.test.js
test/integration/process-lifecycle.test.js` (just the two files, run back to back):
10/10 pass for both named tests, no unrelated failures (36/36 each run).

**Combined tally, both tests by name, across all three runs (23 iterations total):**

- `a test command that traps SIGINT does not hold the tree hostage`: **22 pass, 1
  fail**
- `an idle process is reaped instead of living for the whole session`: **23 pass, 0
  fail**

The one SIGINT failure (Run A, iteration 4) is reported rather than dropped. Its full
output was not captured. That run only recorded the pass/fail line and the suite
tally, a gap fixed for Run B and Run C by saving each iteration's complete log under
`ac3-runs/` and `ac3-targeted/` (not committed; scratch). Eighteen further runs of
that exact test afterward, split across Run B and Run C, all passed clean, which is
what independently contended load produces: occasional, not reproducible on demand,
and not concentrated on any one test. It is recorded here rather than quietly
excluded because AC-3 asks for a tally, not a cherry-picked one.

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
npm test                                                     # Run A, Run B (full suite)
node --test test/unit/red-first.test.js test/integration/process-lifecycle.test.js   # Run C
node --test test/unit/red-first.test.js --test-name-pattern="traps SIGINT"           # AC-4, AC-5 break 1
node --test test/integration/process-lifecycle.test.js                               # AC-5 break 2 revert check
```
