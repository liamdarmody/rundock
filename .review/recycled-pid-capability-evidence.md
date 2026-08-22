# Evidence: reading a process command line without spawning

Recorded here because a reviewer sees the change and nothing else, and the
measurement this change rests on **cannot be run on a developer machine**. The
non-spawning source exists only where a procfs does, so on macOS the tests that
prove it SKIP, and a reviewer reading a macOS gate record would see a skip and
no measurement anywhere. The run output below is from Linux, on both supported
Node lines, and every line of it is quoted verbatim.

The acceptance criteria this was judged against live outside this repository, so
each is quoted in full rather than cited by number.

Source of the Linux output: CI run **32604082263**, commit `1d2f1af`, jobs
`Test (Node 22)` and `Test (Node 24)`, both green. Reproducible from a clone on
any Linux host with `npm test`, or on one file with:

    node --test test/unit/pid-file.test.js

---

## The value is the command line, and it is measured, not asserted

> **AC-1:** Where a process's command line can be read without spawning a
> process, it is read that way.
>
> **AC-2:** The value obtained that way is the command line, not a thread name
> or an executable name.
>
> **AC-3:** AC-2 is established by running it and comparing against what the
> existing path returns for the same process, not by assertion.

The test `the non-spawning source gives the same command line as ps, not a
thread or executable name` reads BOTH sources for the same live child and
compares them with `strictEqual`. It prints both strings on every run, so this
is re-measured on every CI run rather than captured once here.

`Test (Node 24)`, verbatim:

    ✔ the non-spawning source gives the same command line as ps, not a thread or executable name (34.406849ms)
    ℹ platform=linux node=v24.19.0
    ℹ /proc/<pid>/cmdline  -> "/opt/hostedtoolcache/node/24.19.0/x64/bin/node -e setInterval(() => {}, 1e9) //"
    ℹ ps -p <pid> -o args= -> "/opt/hostedtoolcache/node/24.19.0/x64/bin/node -e setInterval(() => {}, 1e9) //"

`Test (Node 22)`, verbatim (TAP reporter, same test, same assertions):

    ok 2 - the non-spawning source gives the same command line as ps, not a thread or executable name
    # platform=linux node=v22.23.2
    # /proc/<pid>/cmdline  -> "/opt/hostedtoolcache/node/22.23.2/x64/bin/node -e setInterval(() => {}, 1e9) //"
    # ps -p <pid> -o args= -> "/opt/hostedtoolcache/node/22.23.2/x64/bin/node -e setInterval(() => {}, 1e9) //"

Both Node lines matter and are not redundant. The reason the guard reads a
command line rather than `comm` is that on Linux `comm` is the THREAD name, and
Node 24 renames its main thread to `MainThread` where Node 22 reports `node`.
The strings above are identical across the two, which is the property the guard
needs and the one `comm` does not have.

**What the strings show, beyond being equal.** Both carry `-e setInterval(() =>
{}, 1e9) //`, the argv this child was spawned with. No thread name and no
executable name can contain it, which is what makes AC-2 checkable rather than
a matter of trust: the test asserts the value contains `setInterval`.

**On the separator**, which is the part most easily got wrong: `/proc` hands
over argv NUL-separated with a trailing NUL, and `ps -o args=` prints the same
argv joined by single spaces. Joining on `' '` is what makes the two comparable,
and the equality above is the proof that it is the right join. The parsing is a
separate pure function so the same property is covered on machines with no
procfs: `argv separated by NULs becomes the space-joined command line`.

**AC-1 is pinned separately, because it is invisible in the value.** Where both
sources answer they answer identically, so a mutant that asked `ps` first passed
the entire suite on Linux. What separates the two is the spawn, so
`processCommand` takes its readers as parameters and `nothing is spawned when
the command line can be read without it` counts calls to the spawning one.

---

## Whether `ps` truncates a long command line

Raised in review: `ps` is described in places as fitting its output to the
terminal width, which would make the two sources agree for a short command line
and disagree for a long one. That matters here because a spawn in this codebase
carries an agent's whole system prompt in argv, so the real command lines are
thousands of characters long. A guard measured only against a short one would
look correct in every test and fail on the real thing.

Measured, at 16k characters, on both Linux Node lines, in the same run:

    ✔ the two sources still agree for a command line far longer than any terminal (21.472129ms)
    ℹ /proc/<pid>/cmdline  -> 16463 chars, ends "AAAAAAAA"
    ℹ ps -p <pid> -o args= -> 16463 chars, ends "AAAAAAAA"

No truncation, and the two agree. The test asserts both the length floor and the
equality, so a future `ps` that starts truncating fails here by name rather than
degrading the guard quietly.

Also measured on macOS, where `ps` is the ONLY source and therefore where
truncation would have bitten hardest. A deliberately absurd argv came back whole
through a pipe:

| argv length | `ps -p <pid> -o args=` returned | identical |
|---|---|---|
| 8,052 | 8,052 | yes |
| 60,052 | 60,052 | yes |
| 200,052 | 200,052 | yes |
| 400,052 | 400,052 | yes |

(darwin 25.4.0, `kern.argmax` 1048576, stdout a pipe, `COLUMNS` unset.) The
width-fitting behaviour applies to a terminal; this call gives `ps` a pipe, and
`execFileSync` never gives it anything else. **The finding is that the existing
spawning path was not truncating either**, so this is a question closed rather
than a defect found, on both platforms and at lengths far past anything the
product produces.

---

## The degraded case, and the test that reports it

> **AC-4:** The existing path remains for platforms with no such source.
>
> **AC-5:** When the command line cannot be read at all, the guard's behaviour
> is unchanged from today: it assumes the record is ours rather than discarding
> it.
>
> **AC-6:** That behaviour is documented where somebody relying on the guard
> would read it.

AC-4: `psCommand` is unchanged in behaviour and is reached whenever the
non-spawning source returns nothing, which is every call on macOS and Windows.
AC-5: `with no readable command line the record is assumed ours, never
discarded` passes an injected reader that returns null, so it holds on every
platform rather than only where a lookup is missing. AC-6: `ARCHITECTURE.md`,
the `child-pids.json` entry, which now states where the check works, where it
does not, and what happens where it does not.

> **AC-7:** The test passes where the capability is present.
>
> **AC-8:** Where the capability is absent the test skips rather than fails.
>
> **AC-9:** The skip names the missing capability.
>
> **AC-10:** The skip appears in the run output rather than passing silently.

AC-7 is the Linux output above: on a host with a procfs the tests RUN, and the
discrimination test that used to fail now passes:

    ✔ a pid running a DIFFERENT command is refused, so a recycled pid is not signalled (7.381906ms)

AC-8 to AC-10, verbatim from a macOS host under a sandbox that blocks spawning,
which is the environment this change exists for:

    ▶ child pid records
      ✔ a live process spawned as the recorded command is recognised (7.985708ms)
      ﹣ the non-spawning source gives the same command line as ps, not a thread or executable name (0.072292ms) # missing capability: the non-spawning source /proc/<pid>/cmdline is unreadable here, and the spawning source `ps -p <pid> -o args=` is unavailable here
      ﹣ the two sources still agree for a command line far longer than any terminal (0.067625ms) # missing capability: the non-spawning source /proc/<pid>/cmdline is unreadable here, and the spawning source `ps -p <pid> -o args=` is unavailable here
      ﹣ a pid running a DIFFERENT command is refused, so a recycled pid is not signalled (0.048542ms) # missing capability: no readable process command line on darwin: /proc/<pid>/cmdline is absent or unreadable, and `ps -p <pid> -o args=` could not be run (a command sandbox that blocks spawning produces exactly this)
      ✔ the match is made against the command line the reader returns (0.116208ms)
      ✔ with no readable command line the record is assumed ours, never discarded (0.064583ms)

The reason is in the run output, the summary counts `skipped 3`, and the exit
status is zero. Nothing passes silently and nothing fails for want of a tool.

---

## The guard still fails when it is broken

> **AC-11:** The test still fails when the recycling guard is genuinely broken,
> proven by breaking it.

Each mutation below was applied alone to `lib/runtime/claude.js`, the file's
tests were run, and the source restored. Every one turned a NAMED test red.

| What was broken | Test that turned red |
|---|---|
| An unverifiable record is discarded instead of kept | `with no readable command line the record is assumed ours, never discarded` |
| The comparison accepts every command line for every record | `the match is made against the command line the reader returns`, and `a pid running a DIFFERENT command is refused, so a recycled pid is not signalled` wherever a lookup exists |
| The capability report prefers the spawning source | `the capability report names the source that answered, or both that did not` |
| The capability report stops naming the source it is missing | same test |
| `processCommand` asks the spawning source first | `nothing is spawned when the command line can be read without it` |
| argv joined with nothing instead of a space | `argv separated by NULs becomes the space-joined command line` |
| The executable name returned instead of the command line | same test |
| An empty cmdline returned as an empty command line | same test |

Two of these were run on Linux as well, against the shape this change had
before the readers became parameters: joining argv with nothing, and returning
the executable name, each turned `the non-spawning source gives the same command
line as ps, not a thread or executable name` red on Node 22 and Node 24.

**One mutation that turned nothing red is recorded because it is a result.** An
empty-output guard on the `ps` path (`out || null`) survived every test on every
platform, in and out of the sandbox. A process that is not there makes `ps` exit
non-zero rather than print nothing, so the branch was unreachable. It was
removed rather than left behind a test that could not reach it.

To reproduce any row: apply the change described, run
`node --test test/unit/pid-file.test.js`, and revert.
