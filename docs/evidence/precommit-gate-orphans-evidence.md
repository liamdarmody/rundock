# The pre-commit gate's mutate:guards child, and how it outlived the gate

Every criterion behind `test/unit/precommit-gate-orphans.test.js` is a
prohibition: *no process outlives the gate, and no source file is left holding a
mutation*. The reverting check cannot prove a prohibition. Taking the fix away
makes these tests fail because the mechanism they call has vanished, not because
something survived, so a green result from reverting would say nothing.

A prohibition is proven the other way round: put the forbidden act back, run the
test, and read the failure. This file records those runs.

Nothing here modifies a working tree. Every command below reads or spawns; none
of them checks anything out, resets anything, or deletes anything you have not
committed.

## What was measured, before any test was written

Four separate defects, each measured on its own with a probe against the real
thing rather than deduced from the source.

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

There is a second reason the old shape could not have been fixed by adding
listeners alone: `execFileSync` blocks the main thread, and a JavaScript signal
listener cannot run while it does. A listener added around the old call would
have been queued until the step it was meant to interrupt had finished.

### 4. The restore each harness already has cannot run while the harness is working

This is the one the card did not anticipate, and it is why ending the process
group is necessary but not sufficient.

Each mutation harness registers `SIGINT`/`SIGTERM`/`SIGHUP` handlers through
`test/tools/mutation-run.js` that put its files back. Those handlers are
correct. They are also unreachable for the whole of a harness's runtime, because
a harness is a synchronous loop of `execFileSync` calls from top to bottom and
Node dispatches a JavaScript signal handler from the event loop, which does not
turn until that loop has finished.

Measured directly on `mutate-render-guards.js`, with SIGTERM sent to the harness
itself and nothing else:

```
marker armed at t=82ms; tree: "M public/markdown-render.js"
sending SIGTERM to the harness (pid 68453) at t=1636ms
t=3642ms  still armed; tree: "M public/markdown-render.js"
t=11782ms still armed; tree: "M public/markdown-render.js"
t=22006ms still armed; tree: "M public/markdown-render.js"
t=32228ms still armed; tree: "M public/markdown-render.js"
gave up after 30s
harness closed: code=null signal=SIGKILL at t=32295ms
```

Thirty seconds of a signal it is armed for, absorbed and never dispatched. The
harness died only to SIGKILL, with `public/markdown-render.js` still mutated and
`.mutation-run.json` still present.

So the gate puts the files back itself when the harness could not. It reads the
record the run writes while it holds files rewritten and restores those paths
**from the index**. That is safe for the one reason that makes it possible at
all: a mutation run refuses to start when a file it is about to rewrite has
unstaged changes, so at the moment the harness read its originals the working
tree and the index agreed on those paths. Restoring from the index puts back
exactly the bytes the harness read, and there is nothing unstaged on those paths
for it to discard. Restoring from `HEAD` would reach past staged work and throw
it away, which is a failure this repository has already paid for elsewhere.

## The tests, run against the gate with the defects put back

Restore them by taking `scripts/lib/process-group.js` back out of
`scripts/precommit-gate.js` and running each step with
`execFileSync('npm', step.args, ...)` again, then:

```
node --test test/unit/precommit-gate-orphans.test.js
```

Ten tests, ten failures, each for the reason it names:

| test | what it said without the fix |
|---|---|
| a step gets longer than the shared default | `a step's group is given undefinedms, which is not more than the 500ms default it is meant to override` |
| a run that finishes normally | `a normal run left 1 process(es) running: 2653` |
| a step that fails after starting something | `a failed step left 1 process(es) running: 2820` |
| a step that writes more than the capture buffer | `a step that merely wrote 1.4MB must not be reported as a failure` |
| SIGTERM to the gate alone | `SIGTERM left 2 process(es) running: 3094, 3093` |
| SIGINT to the gate alone | `SIGINT left 2 process(es) running: 3250, 3249` |
| SIGHUP to the gate alone | `SIGHUP left 2 process(es) running: 3404, 3403` |
| a step that ignores SIGTERM | `a step ignoring SIGTERM outlived the gate: 3559, 3558` |
| a harness that can dispatch the signal | `the gate exited leaving a source file holding a mutation` |
| a harness that never yields | `the gate exited leaving a source file holding a mutation` |

The last two rows are the ones the card was written for, and the assertion order
in both is deliberate. Checking the surviving process first would report the
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

## The same ten tests with the fix in place

```
node --test test/unit/precommit-gate-orphans.test.js

  ✔ a step gets longer than the shared default, because its group may hold a file mutated (2ms)
  ✔ a run that finishes normally leaves nothing the step started running (2118ms)
  ✔ a step that fails after starting something still leaves nothing running (1601ms)
  ✔ a step that writes more than the capture buffer is not failed for it, and orphans nothing (1426ms)
  ✔ SIGTERM to the gate alone leaves no part of the step running (1182ms)
  ✔ SIGINT to the gate alone leaves no part of the step running (1026ms)
  ✔ SIGHUP to the gate alone leaves no part of the step running (1383ms)
  ✔ a step that ignores SIGTERM is ended anyway, which is what the escalation is for (6279ms)
  ✔ a harness that can dispatch the signal restores its own file, and the gate waits for it (1308ms)
  ✔ a harness that never yields, which is every real one, is put back by the gate (6267ms)
  pass 10  fail 0
```

Every survivor assertion is made with **no settling window**, at the moment the
gate is gone. A gate that signalled its group and walked away without waiting
would fail here; a window would have forgiven it.

Two tests take about six seconds, and in both cases that is the assertion rather
than a delay in front of it. The stubborn step traps SIGTERM, so the only thing
that can end it is the escalation to SIGKILL after the grace. The non-yielding
harness cannot dispatch the signal at all, so the grace has to elapse before the
gate can know its own recovery is needed.

## Against the real gate and the real mutate:guards step

The tests above drive a stand-in step. The criterion asks for a genuine slow
run, so this is the real `npm run precommit` on this checkout, interrupted while
the real harness chain was mid-mutation. SIGTERM was sent to the gate's own pid
alone, not to a process group: a group-directed interrupt from a terminal would
have reached the harness anyway, and the case that cost four attempts to land a
two-line change is a supervisor that ends the one process it started.

With the group ending in place but before the gate could restore anything:

```
[precommit] mutate:guards...
harness in flight: {"pid":68040,"tool":"mutate-render-guards.js",
                    "files":["public/markdown-render.js"]}
guard processes live:
  68025 68025 Ss   npm run mutate:guards
  68039 68025 S    sh -c node test/tools/mutate-render-guards.js --markdown && ...
  68040 68025 S    node test/tools/mutate-render-guards.js --markdown

sending SIGTERM to the gate alone (pid 43992)

gate exited: code=130
guard processes still live: []
marker still present: true
tree after: "M public/markdown-render.js"
```

The whole subtree was ended, and the file was still mutated. That run is the
measurement that turned defect 4 from a theory into a finding: ending the group
is not the whole fix.

With the recovery in place, the same interruption:

```
[precommit] mutate:guards...
harness in flight: {"pid":99565,"tool":"mutate-render-guards.js",
                    "files":["public/markdown-render.js"]}
guard processes live:
  99552 99552 Ss   npm run mutate:guards
  99564 99552 S    sh -c node test/tools/mutate-render-guards.js --markdown && ...
  99565 99552 S    node test/tools/mutate-render-guards.js --markdown

sending SIGTERM to the gate alone (pid 74302)

gate exited: code=130
guard processes still live: []
marker still present: false
tree after: (only the two files this change is editing; markdown-render.js is absent)
```

Process group gone, record cleared, source file back.

A run left to finish naturally is the other half of the criterion, and it is
covered by every full `npm run precommit` on this branch: each one ended with
`PASS`, a clean `git status`, and no `.mutation-run.json`.

## The two grace periods, and why they are not the same number

`scripts/lib/process-group.js` gives a group half a second to end on its own.
The gate overrides that to five.

The reverting check can afford the short one, and its own comment says why:
nothing it spawns has a restore step to skip. The gate's group is a mutation
harness with a real source file rewritten on disk. Where that harness *can*
dispatch the signal it restores the file itself, which is the better outcome and
the one the grace exists to allow; SIGKILLing the group immediately would
satisfy every process assertion in the test file and leave the tree mutated.

The override is pinned by a test rather than left as a constant somebody can
tidy, because losing it breaks nothing that any other test can see.

## What is still not covered

SIGKILL of the gate itself, which the kernel delivers to nothing. A subtree
abandoned that way outlives the gate no matter what the gate is written to do,
and the file it was holding stays mutated. What catches it is the record a
mutation run writes while it holds files rewritten: the next run reads that
record, finds the pid gone, refuses to start, and names the files that may still
be holding a mutation. See `test/tools/mutation-run.js`.

The gate deliberately does not repair that case. A record whose pid is already
dead when the gate reads it belongs to some earlier run that nobody watched end,
and it is doing its job by being there; quietly fixing it would remove the only
trace of it. The gate acts only on a record that named a live pid a moment
before it ended the group, which is a run it is itself responsible for.

That same refusal is also the most likely explanation for one thing in the
report this work started from: a gate that reported a result quickly while a
`mutate-*-guards.js` process was live. A harness abandoned by an earlier attempt
keeps its marker; the next attempt's first harness reads it, refuses, and the
chain stops at once. The live process seen alongside that fast failure belonged
to the previous run, not the one that had just reported. Removing the orphan
removes the cause of that too.
