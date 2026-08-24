# Test fixture cleanup: measurements

Everything below was measured on this branch against `origin/main` at `6e2d505`,
on Node v24.12.0. The branch started from `b602f5a` and was rebased when
`origin/main` moved; every number here is from after the rebase. Every count was taken with `TMPDIR` pointed at a fresh empty
directory, so it is a count of what the run itself created and not of whatever
else the machine was holding.

## The cause, verified rather than assumed

The card recorded the cause as "`makeWorkspace` registers every fixture for a
`cleanup()` that nothing calls". That is close but not what the code does, and
the difference changes the fix.

`cleanup()` **was** called. Twenty test files wired it, mostly as
`after(cleanup)`, which is why a search for `cleanup()` finds only two.

| Files that build fixtures via the helper | 79 |
|---|---|
| Wire `after(cleanup)` or call it directly | 20 |
| Wire nothing | 59 |

The 59 include every file in `test/integration/`, which reaches the helper
through `test/helpers/harness.js` and is the heaviest fixture builder in the
suite.

So the defect is not a missing call site. It is that **tidying was opt-in**,
which makes the default a leak: every new test file leaks until somebody
remembers a line, and a file that forgot looks exactly like a file that did not
need to. Twenty files remembered and 59 did not, which is roughly what an
opt-in control achieves over time.

That is why the fix moves ownership into the helper instead of adding 59 more
call sites. Adding the call sites would leave the next test file leaking.

## Before and after, full suite

```
TMPDIR=<empty dir> npm test
```

| | `origin/main` (6e2d505) | this branch |
|---|---|---|
| `rundock-test-*` directories left | **160** | **0** |
| Disk left behind by them | **103 MB** | **0** |
| Out-of-space errors in the run | 0 | 0 |

A correction to the card while recording this. `mutate:guards` does not run the
whole suite once per guard: each harness runs ONE named suite file per guard.
So a gate run creates hundreds of directories rather than tens of thousands,
and the 10,087 and 20,708 are the accumulation of many runs across a day rather
than of one. That does not change the fix or its urgency, only the arithmetic:
nothing was ever removing any of them, so every run of anything added to the
pile permanently.

## Residue that this branch does NOT fix, and its number

A run on this branch still leaves **7 entries, 5.7 MB**, one of which is Node's
own `node-compile-cache`. None of the other six come from the fixture helper. They come
from test files that call `fs.mkdtempSync(os.tmpdir(), ...)` directly and never
remove the result:

- `test/integration/boundary-permissions.test.js` (`boundary-grant-`, `boundary-cmd-`)
- `test/unit/file-kind.test.js` (`rundock-filekind-`, three per run)
- `test/integration/external-tree-changes.test.js` (`rundock-open-`)

There are **50 direct `mkdtempSync` call sites across about 30 test files**,
using about 30 different prefixes. Most of them do clean up; these do not.

This is left on its own card deliberately. Routing 50 call sites through the
helper is a 30-file migration, which is a refactor rather than this fix, and
mixing it in would make the diff for a p1 unblocker several times larger than
the fix it carries. Fixing only the four that happen to leak today would
re-create the exact defect this branch removes: a per-site convention that the
next author has to remember. The number is recorded here so the follow-up card
starts with a measurement rather than a guess. At 6 per suite run it is about
1,200 directories and 1.1 GB across a full `mutate:guards` gate: worth a card,
not worth blocking this one.

## Red first

`node scripts/red-first.js --base origin/main --tests "npm test"` was run on the
committed tree. Its verdict, verbatim:

```
NOT-DISCRIMINATING: the tests pass with the source reverted, so they do not
discriminate this change and would have gone green against the defect they
were written for
```

with `sourceFiles: 1`, `testFiles: 6`, `testsPassedWithChange: 2373`,
`testsFailedWithoutChange: 0`.

**Read that number before that sentence.** One source file. The tool reverts
only what it classifies as source, and `isTest()` classifies anything under a
`test/` path segment as a test. Every code file in this change is test
infrastructure, so the one file left over is
`.review/fixture-cleanup-evidence.md`, this document. The experiment it
actually ran was whether deleting a markdown file breaks the suite. It does
not, and the verdict is a true statement about that experiment and a false one
about this change.

The layout was not bent to fix this. Moving `temp-root.js` somewhere
`isTest()` calls source would have produced a `proven` verdict that meant
nothing: reverting it would delete a module the fixture helper requires, every
fixture-building test would die of module-not-found, and the tool would report
discrimination it had never observed. `red-first.js` documents that as the one
error direction it must never take, so a false `proven` was refused and a
misleading `not-discriminating` was accepted instead, with the real proof taken
by hand below.

Worth a card of its own: the tool cannot express a test-infrastructure change,
and its verdict for one reads as an accusation. Either it should classify test
infrastructure separately from tests, or it should return `not-provable` when
the only source file it can revert has no executable content.

### The red run, taken by hand

Tree: this branch's tests and `test/helpers/temp-root.js` present,
`test/helpers/workspace.js` exactly as it is on `origin/main`. That isolates the
behavioural fix and leaves no module missing, so nothing goes red for a reason
other than the leak.

```
node --test --test-reporter=spec test/unit/fixture-hygiene.test.js
ℹ tests 16
ℹ pass 6
ℹ fail 10
```

Red, and each for its own reason. No run in this file reported `ENOSPC` or
`no space left on device`:

| Test | Why it was red |
|---|---|
| a run leaves no fixture directory behind, counted before and after | before 0, after 8 |
| a fixture is removed by the process that created it, on ordinary exit | 1 left |
| a run that throws still removes its fixtures | 1 left |
| a run interrupted by SIGTERM removes its fixtures before it goes | 1 left |
| a run interrupted by SIGINT removes its fixtures before it goes | 1 left |
| SIGKILL leaves one root behind, and the next run is what removes it | the next run swept nothing |
| repeated kills do not accumulate | reached 2 after the second kill |
| mutate-render-guards.js refuses to run on a temp root full of fixtures | did not refuse; killed at the 30s ceiling |
| mutate-routine-editor-guards.js refuses to run on a temp root full of fixtures | same |
| mutate-routines-guards.js refuses to run on a temp root full of fixtures | same |

The 6 that passed are the unit tests of `temp-root.js` itself, which is new
code, so there was nothing for them to discriminate.

With the fix in place the same file is 16 pass, 0 fail.

## Interruption modes

| Mode | Covered | By what |
|---|---|---|
| Suite runs to completion | yes | `process.on('exit')` removes the process root |
| A test throws, suite fails | yes | same |
| `process.exit()` | yes | same |
| Ctrl-C (SIGINT) | yes | handler removes, then re-raises |
| `kill` (SIGTERM), CI cancel | yes | same |
| Terminal closed (SIGHUP) | yes | same |
| `kill -9` (SIGKILL) | **no, and it cannot be** | no handler runs; the root survives |
| Power loss, kernel panic, OOM kill | **no, same reason** | no handler runs |
| Accumulation across any of the above | yes | the next run sweeps roots whose owning pid is dead |

The uncovered modes are uncoverable from inside the dying process, which is why
the fix does not rely on a `finally`. What it relies on instead is that the
directory name carries the pid that owns it, so a later run can tell a root
whose owner is still working from one whose owner is gone. A killed run leaves
exactly one root, and the next run removes it: the failure is bounded at one
rather than growing.

Known limit of the pid check: if a leftover root's pid has since been reused by
an unrelated process, the sweep treats it as live and keeps it for that run. It
is removed the next time the pid is free. This trades a delayed cleanup for
never removing a directory that is in use, which is the safe direction.

Roots in the old naming (`rundock-test-<random>`, carrying no pid) cannot be
asked about liveness, so they are swept on age instead, after one hour. That is
what clears the tens of thousands already on disk without disturbing a pre-fix
suite running concurrently in another checkout.

## Mutation harness preflight

Included here rather than deferred, because the harnesses are what turned a
disk problem into wrong measurements, and this card exists because those
measurements could not be trusted.

Each of the three harnesses now calls `preflight(os.tmpdir())` before it starts.
It sweeps roots whose owner is gone first, so a machine dirtied by earlier runs
repairs itself and is not stopped for a condition that no longer holds. It
refuses, with exit code 2, only when more than 100 roots remain that it cannot
account for.

Observed refusal:

```
150 test fixture roots are still under <temp root> after sweeping 0, and the
sane ceiling is 100.
Refusing to start. This harness runs a suite once per guard, so on a
machine in this state it fills the disk and then reports the resulting write
failures as guards nobody was watching. Those numbers would be wrong in the
direction that looks like work to do.
Remove them, then re-run:  rm -rf <temp root>/rundock-test-*
```

## Mutation: every new guard, and the test that notices it

Each guard below was broken one at a time and `test/unit/fixture-hygiene.test.js`
was run against the break. A guard whose mutation turns nothing red is not
guarded, so the table is the check rather than the report of it.

| Guard broken | Tests red | Which |
|---|---|---|
| exit handler removes the process root | 3 | `a run leaves no fixture directory behind, counted before and after`<br>`a fixture is removed by the process that created it, on ordinary exit`<br>`a run that throws still removes its fixtures` |
| signal handlers remove the process root | 2 | `a run interrupted by SIGTERM removes its fixtures before it goes`<br>`a run interrupted by SIGINT removes its fixtures before it goes` |
| the next run sweeps roots whose owner is gone | 2 | `SIGKILL leaves one root behind, and the next run is what removes it`<br>`repeated kills do not accumulate` |
| fixtures are nested inside the process root | 7 | every case in `the suite owns the fixtures it creates` |
| a live owner keeps its root | 9 | `a root owned by a live process is never swept`<br>`a run leaves no fixture directory behind, counted before and after`<br>`it proceeds when the temp root is sane`<br>`it refuses when roots it cannot account for are still there`<br>plus all three harness refusal cases |
| a young un-owned root is left alone | 1 | `a root in the old un-owned shape is swept once it is older than the window` |
| the sweep only ever touches its own prefix | 1 | `directories that are not fixtures are never touched` |
| the preflight sweeps before it counts | 1 | `it sweeps first, so a machine dirtied by earlier runs repairs itself` |
| the preflight refuses above the ceiling | 4 | `it refuses when roots it cannot account for are still there`<br>plus all three harness refusal cases |
| the harness entry point calls the preflight | 1 | `mutate-render-guards.js refuses to run on a temp root full of fixtures` |

The last row is why the harness check is driven rather than grepped. The first
version of that test read the harness source for a `preflight(` call, and
deleting the call from the entry point left the word behind in the function the
entry point no longer reached, so it stayed green. The mutation above is the one
that caught it.

Disk during the mutation run: 61 GB free, and no run reported `ENOSPC` or
`no space left on device`. That check was applied to every measurement recorded
in this file, because a red test on a full disk is what this card is about.

## Why the harness test drives `--preflight-only`

The first driven version of that test started each harness for real on a
crowded temp root and killed it at a timeout if it did not refuse. That works,
and it has a cost that only shows up in the red state: a harness killed
part-way never reaches the `finally` that puts its source file back, so a red
run leaves the working tree mutated.

Measured rather than predicted. The reverted run above left three files
mutated (`public/markdown-render.js`, `public/views/routines.js`,
`public/views/routine-editor.js`), and because the suite was still running, two
markdown-render tests then failed for a reason that had nothing to do with
them. That is the same shape of confusion this card exists to remove: a real
failure wearing the costume of an unrelated one.

So each harness now takes `--preflight-only`, read immediately after the
preflight call and before any mutation. The test gets the real entry point in
the real order, a harness that has lost its check exits 0 and fails the test,
and nothing is ever mutated to prove it. Green runs take about 80ms per
harness instead of 30 seconds.

This is a mitigation inside this card's own test, not a fix for the general
case. A mutation harness interrupted by a signal still leaves its source
mutated, which is a live card of its own and is deliberately not addressed
here.
