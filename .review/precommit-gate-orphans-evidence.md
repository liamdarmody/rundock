# The pre-commit gate's mutate:guards child, and how it outlived the gate

Every criterion behind `test/unit/precommit-gate-orphans.test.js` is a
prohibition: *no process outlives the gate*. The reverting check cannot prove a
prohibition. Taking the fix away makes these tests fail because the mechanism
they call has vanished, not because something survived, so a green result from
reverting would say nothing.

A prohibition is proven the other way round: put the forbidden act back, run the
test, and read the failure. This file records those runs.

Nothing here modifies a working tree. Every command below reads or spawns; none
of them checks anything out, resets anything, or deletes anything you have not
committed.

## What was measured, before any test was written

Three separate defects, each measured on its own with a probe rather than
deduced from the source.

### 1. `execFileSync` returns without waiting for anything but the direct child

A parent that runs `sh -c 'sleep 400 & echo $!; echo $$; echo small; exit 0'`
through `execFileSync` returned in **6 ms**, with the background child still on
the machine:

```
returned ok in 6 ms, out: "small\n"
12479 12469 S    sleep 400      <- the step's own child, still running
12478 gone                      <- the shell, exited
```

No signal, no timeout, no interruption. The step ran to completion, returned
zero, and its subtree carried on while the caller went back to work. In the gate
the caller's next act is to print `PASS` and write a record vouching for the
tree.

### 2. The one kill the gate asked for reached only part of the tree

`execFileSync` stops capturing at one megabyte per stream and, on overflow,
SIGTERMs the **direct child** and raises `ENOBUFS`. The same probe with a step
that writes 3 MB:

```
threw after 46 ms: code= ENOBUFS status= null signal= SIGTERM
12426 12416 S    sleep 400      <- still running
12425 gone                      <- the shell it was started from
```

The direct child of the gate is `npm`. The shell chain beneath it and whichever
`node test/tools/mutate-*-guards.js` is currently rewriting a source file are
not it, so they were untouched while the gate printed `FAILED` for a step that
had done nothing wrong.

How close the real steps run to that cap, measured on this checkout:

| step | bytes on a fully green run | share of the 1 MB cap |
|---|---|---|
| `test:coverage` | 574,755 | 55% |
| `mutate:guards` | 50,425 | 5% |
| every other step | under 200 | negligible |

`mutate:guards` has room. `test:coverage` does not: it is at 55% before a single
failure has printed a diff or a stack trace, and a failing run is the run
somebody is actually reading. The failure report it produces on overflow is 25
lines of whatever the step happened to be writing at the megabyte mark, which is
how a step gets reported as broken with nothing to act on.

### 3. Nothing was ever signalled

The gate installed no listener for `SIGINT`, `SIGTERM` or `SIGHUP` and held no
child handle to signal with. A signal delivered to the gate alone therefore took
Node's default handling: the gate ended without unwinding and its subtree was
abandoned.

This is the layer above the per-script restore. Each mutation harness already
restores the file it broke when **that harness** receives a signal, and that
handler is correct. It had no way to fire, because nothing sent the harness
anything.

There is a second reason the old shape could not be fixed by adding listeners
alone: `execFileSync` blocks the main thread, and a JavaScript signal listener
cannot run while it does. A listener added around the old call would have been
queued until the step it was meant to interrupt had finished.

## The tests, run against the gate with the fix put back

Restore the defect by taking `scripts/lib/process-group.js` back out of
`scripts/precommit-gate.js` and running each step with
`execFileSync('npm', step.args, ...)` again, then:

```
node --test test/unit/precommit-gate-orphans.test.js
```

Nine tests, nine failures, each for the reason it names:

| test | what it said without the fix |
|---|---|
| a step gets longer than the shared default | `a step's group is given undefinedms, which is not more than the 500ms default it is meant to override` |
| a run that finishes normally | `a normal run left 1 process(es) running: 91001` |
| a step that fails after starting something | `a failed step left 1 process(es) running: 91170` |
| a step that writes more than the capture buffer | `a step that merely wrote 1.4MB must not be reported as a failure` |
| SIGTERM to the gate alone | `SIGTERM left 2 process(es) running: 91464, 91449` |
| SIGINT to the gate alone | `SIGINT left 2 process(es) running: 91625, 91624` |
| SIGHUP to the gate alone | `SIGHUP left 2 process(es) running: 91779, 91778` |
| a step that ignores SIGTERM | `a step ignoring SIGTERM outlived the gate: 91933, 91932` |
| a gate cut short mid-mutation | `the gate exited leaving a source file holding a mutation` |

The last row is the one the card was written for, and the assertion order in
that test is deliberate. Checking the surviving process first would report the
cause; checking the file first reports the cost, which is a source file nobody
edited quietly saying something other than what its author wrote.

The fourth row is worth reading in full, because it is the failure report the
old shape produced for a step that had merely talked too much:

```
[precommit] test:coverage... ok
[precommit] typecheck... ok
[precommit] lint:styles... ok
[precommit] check:refs... ok
[precommit] mutate:guards... FAILED
fatal: ref refs/remotes/origin/HEAD is not a symbolic ref
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx...
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx...
```

## The same nine tests with the fix in place

```
node --test test/unit/precommit-gate-orphans.test.js

  ✔ a step gets longer than the shared default, because its group may hold a file mutated (0.277ms)
  ✔ a run that finishes normally leaves nothing the step started running (1489ms)
  ✔ a step that fails after starting something still leaves nothing running (936ms)
  ✔ a step that writes more than the capture buffer is not failed for it, and orphans nothing (1118ms)
  ✔ SIGTERM to the gate alone leaves no part of the step running (850ms)
  ✔ SIGINT to the gate alone leaves no part of the step running (946ms)
  ✔ SIGHUP to the gate alone leaves no part of the step running (963ms)
  ✔ a step that ignores SIGTERM is ended anyway, which is what the escalation is for (5978ms)
  ✔ the harness restores the file and clears its record, because the gate signals it (967ms)
  pass 9  fail 0
```

Every survivor assertion is made with **no settling window**, at the moment the
gate is gone. A gate that signalled its group and walked away without waiting
would fail here; a window would have forgiven it.

The stubborn case takes six seconds because that is the assertion rather than a
delay in front of it: the step traps SIGTERM, so the only thing that can end it
is the escalation to SIGKILL after the grace.

## The two numbers, and why they are not the same number

`scripts/lib/process-group.js` gives a group half a second to end on its own.
The gate overrides that to five.

The reverting check can afford the short one, and its own comment says why:
nothing it spawns has a restore step to skip. The gate's group is a mutation
harness with a real source file rewritten on disk, which puts the file back from
its SIGTERM handler, and that handler cannot run until the suite the harness is
blocked on has itself gone. SIGKILLing the group before then would satisfy every
process assertion in the file and leave the tree mutated, which is the outcome
the card exists to prevent.

The override is pinned by a test rather than left as a constant somebody can
tidy, because losing it breaks nothing that any other test can see.

## What is still not covered

SIGKILL of the gate itself, which the kernel delivers to nothing. A subtree
abandoned that way outlives the gate no matter what the gate is written to do.
What catches it is the record a mutation run writes while it holds files
mutated: the next run reads that record, finds the pid gone, refuses to start,
and names the files that may still be holding a mutation. See
`test/tools/mutation-run.js`.

That refusal is also the most likely explanation for one thing in the report
this work started from: a gate that reported a result quickly while a
`mutate-*-guards.js` process was live. A harness abandoned by an earlier attempt
keeps its marker; the next attempt's first harness reads it, refuses, and the
chain stops at once. The live process seen alongside that fast failure belonged
to the previous run, not the one that had just reported. Removing the orphan
removes the cause of that too.
