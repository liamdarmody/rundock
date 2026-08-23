# Reading a process command line: what was measured, and how to measure it again

The recycling guard needs a process's command line. There are two ways to get
one and they do not behave identically, so the differences are recorded here
with the measurements that established them.

**This file is a dated record of one run, not a source of truth.** Every claim
below is re-measured by a named test on every run, and those tests print their
values whether they pass or fail. If this file and the suite ever disagree, the
suite is right. It exists because the non-spawning source only works where a
procfs does, so on macOS the tests that exercise it skip, and somebody reading a
diff or a local test run there would otherwise see a skip and no measurement
anywhere.

Linux figures below: run `32630589200`, commit `337e95d`, jobs `Test (Node 22)`
and `Test (Node 24)`, both green. The default-binding rows in the last table were
measured on runs `32630171282`, `32630173480` and `32631467930`. Reproduce on any Linux host with:

    node --test test/unit/pid-file.test.js

---

## The two sources

`/proc/<pid>/cmdline` spawns nothing. `ps -p <pid> -o args=` spawns a process,
which a sandbox that blocks spawning will refuse, and that is when the guard
has to fall back on assuming a record is ours. `commandLineCapability()` says
which of the two answers on the machine it is called on.

## For printable argv the two agree exactly

Test: `for printable argv the non-spawning source gives the same command line as
ps, not a thread or executable name`. It reads both sources for the same live
child and compares with `strictEqual`.

    Node 24
    ℹ platform=linux node=v24.19.0
    ℹ /proc/<pid>/cmdline  -> "/opt/hostedtoolcache/node/24.19.0/x64/bin/node -e setInterval(() => {}, 1e9) //"
    ℹ ps -p <pid> -o args= -> "/opt/hostedtoolcache/node/24.19.0/x64/bin/node -e setInterval(() => {}, 1e9) //"

    Node 22
    # platform=linux node=v22.23.2
    # /proc/<pid>/cmdline  -> "/opt/hostedtoolcache/node/22.23.2/x64/bin/node -e setInterval(() => {}, 1e9) //"
    # ps -p <pid> -o args= -> "/opt/hostedtoolcache/node/22.23.2/x64/bin/node -e setInterval(() => {}, 1e9) //"

Both Node lines are measured because the reason the guard reads a command line
rather than `comm` is a difference between them: `comm` is the thread name, and
Node 24 renames its main thread to `MainThread` where Node 22 reports `node`.
The command lines above are identical across the two.

What the strings also show is that the value is a command line and not a name.
Both carry the argv the child was spawned with, which no thread name and no
executable name can contain; the test asserts that rather than leaving it to the
reader.

`/proc` gives argv NUL-separated, `ps` gives it space-joined, so joining on a
single space is what makes them comparable. That join is covered separately, on
every machine, by `argv separated by NULs becomes the space-joined command line`.

## For argv with control characters they do NOT agree

`ps` renders a command line for a human and escapes what a human could not read.
This is not a corner case here: a spawn in this codebase carries an agent's
system prompt in argv, and prompts contain newlines, so real command lines are
the disagreeing case.

Test: `the non-spawning source returns argv as spawned, control characters and
all`, which asserts the faithfulness and prints the rest.

    ℹ argv as spawned      -> "…/node -e setInterval(() => {}, 1e9) //ONE\nTWO\tTHREE "
    ℹ /proc/<pid>/cmdline  -> "…/node -e setInterval(() => {}, 1e9) //ONE\nTWO\tTHREE "
    ℹ ps -p <pid> -o args= -> "…/node -e setInterval(() => {}, 1e9) //ONE TWO?THREE"
    ℹ proc===ps false, proc===argv true, ps===argv false

On Linux a newline becomes a space and a tab becomes `?`. On macOS the same argv
comes back with `\012` and `\011`. The trailing space is gone either way,
removed by the `.trim()` on the spawning path. The non-spawning source returns
the bytes as spawned on both.

**That the difference does not reach the decision is a separate statement, and
has its own test.** What is compared is the recorded basename, which sits in
argv[0] ahead of anything a prompt could contain, so the escaping happens past
the part that is matched: `a child spawned with control characters in argv is
still recognised` proves it, and runs on macOS too, where the escaping is most
aggressive.

## Neither source truncates a long command line

`ps` fits its output to the terminal width, which would have meant the two
sources agreeing for a short command line and disagreeing for a real one. It
does not apply here: these calls give `ps` a pipe, never a terminal.

Measured at 16k characters on Linux, both Node lines, both sources:

    ℹ /proc/<pid>/cmdline  -> 16463 chars, ends "AAAAAAAA"
    ℹ ps -p <pid> -o args= -> 16463 chars, ends "AAAAAAAA"

Measured by hand on macOS, where the spawning source is the only one, with
`kern.argmax` 1048576 and stdout a pipe:

| argv length | `ps -p <pid> -o args=` returned | identical |
|---|---|---|
| 8,052 | 8,052 | yes |
| 60,052 | 60,052 | yes |
| 200,052 | 200,052 | yes |
| 400,052 | 400,052 | yes |

That hand measurement is no longer the only support for it. `the spawning source
does not truncate a long command line` asks the same question of that source
alone, so it runs on macOS as well as Linux and fails if a future release starts
fitting output to a width.

The bound on all of this: the kernels these ran on, not every kernel. The tests
re-measure wherever they run, so a platform that behaves differently fails by
name rather than degrading the guard quietly.

## Nothing spawns where it does not have to

Which source is asked first cannot be seen in the returned value, because where
both answer they answer identically. A version that asked `ps` first passed the
entire suite on Linux. What separates them is the spawn, so that is what is
observed:

- `nothing is spawned when the command line can be read without it` passes two
  readers in and counts calls on them, covering the choice itself.
- `the DEFAULT reader is the non-spawning one, with nothing injected` names no
  reader at all. It replaces the spawning primitive underneath, which is
  resolved at call time, and asserts a command line came back without it being
  reached. This is the one that covers the shipped wiring; the first covers a
  model of it, and stays green if the defaults are swapped.

The capability report has the same shape and needed the same treatment. Its two
sources are named POSITIONALLY, so swapping its defaults makes it report the
free source while probing the spawning one, and every skip reason and diagnostic
in the suite would then name the wrong thing. Asserting the reported name does
not catch that, because a swap leaves the name where it was. `the DEFAULT
capability report names the source that actually answered` injects nothing and
makes the spawning primitive fail underneath, so on a machine where the free
source works the two become distinguishable by what they answered rather than by
where they sit.

## What happens where no source answers

The record is assumed to be ours rather than discarded. A recycled pid can be
signalled there, which is chosen: an untracked child leaks forever, where a
redundant signal costs one `SIGTERM` to a process that is probably ours.
`ARCHITECTURE.md` states this where somebody relying on the guard would read it,
and `with no readable command line the record is assumed ours, never discarded`
holds it in place on every platform by passing in a reader that answers nothing.

The tests that need a real source skip rather than fail, and the skip names the
source that is missing, in the words the capability report itself uses. From a
macOS host under a sandbox that blocks spawning:

    ﹣ for printable argv the non-spawning source gives the same command line as ps, not a thread or executable name # missing capability: /proc/<pid>/cmdline and ps -p <pid> -o args= unreadable here
    ﹣ the spawning source does not truncate a long command line # missing capability: ps -p <pid> -o args= unreadable here
    ﹣ a pid running a DIFFERENT command is refused, so a recycled pid is not signalled # missing capability: no readable process command line on darwin: /proc/<pid>/cmdline and ps -p <pid> -o args= are both unavailable (a command sandbox that blocks spawning produces exactly this)

The reason is in the run output, the summary counts the skips, and the exit
status is zero.

## Breaking it on purpose

Each change below was applied alone, the file's tests were run, and the source
restored. Every one turned a named test red. To repeat any row, make the change,
run `node --test test/unit/pid-file.test.js`, and revert.

| Change made | Test that turned red |
|---|---|
| An unverifiable record is discarded instead of kept | `with no readable command line the record is assumed ours, never discarded` |
| The comparison accepts every command line for every record | `the match is made against the command line the reader returns`, and `a pid running a DIFFERENT command is refused, so a recycled pid is not signalled` wherever a source answers |
| The capability report prefers the spawning source | `the capability report names the source that answered, or both that did not` |
| The capability report stops naming a source it is missing | same test |
| `processCommand` asks the spawning source first, via injected readers | `nothing is spawned when the command line can be read without it` |
| `processCommand`'s DEFAULT readers swapped, nothing injected | `the DEFAULT reader is the non-spawning one, with nothing injected` (Linux, both Node lines) |
| `processCommand`'s first default bound to the spawning source | same test (Linux, both Node lines) |
| The capability report's DEFAULT readers swapped, nothing injected | `the DEFAULT capability report names the source that actually answered` (Linux, both Node lines) |
| argv joined with nothing instead of a space | `argv separated by NULs becomes the space-joined command line` |
| The executable name returned instead of the command line | same test |
| An empty cmdline returned as an empty command line | same test |

The last two rows were also run on Linux against an earlier shape of this
change, where each turned the printable-argv comparison red on Node 22 and 24.

The three default-binding rows are the ones worth keeping in mind. Each turned
exactly ONE test red while the whole rest of the suite stayed green, including,
in every case, the test that injects readers to cover the same property. That is
why injecting readers is not enough on its own: it supplies the very positions
the defect is in.

**One change that turned nothing red is recorded because it is a result.** An
empty-output guard on the spawning path (`out || null`) survived every test on
every platform. A process that is not there makes `ps` exit non-zero rather than
print nothing, so the branch was unreachable. It was removed rather than left
behind a test that could not reach it.
