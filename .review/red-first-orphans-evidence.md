# What the reverting check left behind, measured before and after

`scripts/red-first.js` spawns its test command detached. Detached means the
command heads its own process group, which is what lets a whole subtree be
ended together, and it also means the group outlives this process unless
something ends it. Nothing did, on three of the four ways out.

**This file is a dated record of runs on one machine, not a source of truth.**
Every claim below is re-measured by a named test in
`test/unit/red-first-orphans.test.js` on every run, and those tests print the
process table they measured whether they pass or fail. If this file and the
suite ever disagree, the suite is right.

Reproduce all of it with:

    node --test test/unit/red-first-orphans.test.js

Figures below were taken on macOS on 2026-08-25, against `origin/main` at
`afb63ef`.

---

## Why this project's own reverting check cannot prove any of it

Every criterion here is a PROHIBITION: no suite outlives the tool. The usual
proof in this repository is to take the source away and watch a test go red,
and that proof does not work on a prohibition. Removing the ending makes these
tests fail because a function they call has vanished, not because a suite
survived, and a test failing for a missing symbol would fail exactly as loudly
if the prohibition were perfectly kept.

Two of the tests below show that failure mode plainly. In the `before` run,
`AC-5, AC-6` and `AC-5: a run that has not spawned its suite yet` die with
`runRecordPath is not a function`. **Those two lines are not evidence of
anything** and are left in rather than trimmed, because a reader needs to see
the difference between a test that noticed a leak and a test that noticed a
missing export. The refusal criteria are proven further down instead, by
changes that keep the mechanism and remove only the behaviour.

There is a second reason, particular to this file. The tool cannot be pointed at
its own branch to check this without doing the very thing being measured: a run
starts two more suites, which is what the branch exists to stop.

So the prohibitions are proven the other way round. **The forbidden act is
committed, one change at a time, and the run records which named test noticed.**

---

## Before: each exit driven against the tool as it was

The stand-in suite is a shell that starts a background child, detaches that
child's stdio so the shell is not held open by it, and exits. That is the shape
of a package runner, and the child of the child is what was being left behind.
Note `PPID 1` in the tables: the leftovers had been reparented to init, which is
what an orphan looks like.

```
▶ no suite outlives the tool
  ✖ AC-1, AC-4, AC-7: a normal exit leaves no suite running, including the runner's own child (5375.369375ms)
  ℹ immediately after the tool exited:
98441=alive 98440=gone 98455=alive 98454=gone
PID  PPID  PGID COMMAND
98441     1 98440 sleep 600674
98455     1 98454 sleep 600674
  ℹ after settling:
98441=alive 98440=gone 98455=alive 98454=gone
PID  PPID  PGID COMMAND
98441     1 98440 sleep 600674
98455     1 98454 sleep 600674
  ✖ AC-2: an error exit leaves no suite running (5353.364ms)
  ℹ immediately after the tool exited:
98547=alive 98546=gone
PID  PPID  PGID COMMAND
98547     1 98546 sleep 600674
  ℹ after settling:
98547=alive 98546=gone
PID  PPID  PGID COMMAND
98547     1 98546 sleep 600674
  ✖ AC-3: a signal during the FIRST run leaves no suite running (5365.254ms)
  ℹ with the first run in flight:
98641=alive 98640=alive
PID  PPID  PGID COMMAND
98640 98627 98640 /bin/sh -c sleep 600674 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-signal-98380-1787669091406.pids"; echo $$ >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-signal-98380-1787669091406.pids"; sleep 30
98641 98640 98640 sleep 600674
  ℹ the tool exited with code null signal SIGTERM
  ℹ after the tool exited:
98641=alive 98640=alive
PID  PPID  PGID COMMAND
98640     1 98640 /bin/sh -c sleep 600674 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-signal-98380-1787669091406.pids"; echo $$ >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-signal-98380-1787669091406.pids"; sleep 30
98641 98640 98640 sleep 600674
  ✖ AC-1: an exit taken while a suite is running leaves nothing behind either (5347.10525ms)
  ℹ immediately after the exit:
98717=alive 98716=alive
PID  PPID  PGID COMMAND
98716     1 98716 /bin/sh -c sleep 600674 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-inflight-98380-1787669096739.pids"; echo $$ >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-inflight-98380-1787669096739.pids"; sleep 30
98717 98716 98716 sleep 600674
  ℹ after settling:
98717=alive 98716=alive
PID  PPID  PGID COMMAND
98716     1 98716 /bin/sh -c sleep 600674 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-inflight-98380-1787669096739.pids"; echo $$ >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-inflight-98380-1787669096739.pids"; sleep 30
98717 98716 98716 sleep 600674
✖ no suite outlives the tool (21442.560875ms)
▶ starting on top of a run that is still going
  ✖ AC-5, AC-6: a second start is refused, and the refusal names the run it found (237.476875ms)
  ✖ AC-5: a run that has not spawned its suite yet is live too (147.695791ms)
✖ starting on top of a run that is still going (385.364792ms)
▶ cleanup reaches what this tool started, and stops there
  ✖ AC-8: a suite this tool did not start is left alone, and is still working afterwards (5353.160084ms)
  ℹ foreign suite before: 98896=alive
PID  PPID  PGID COMMAND
98896 98380 98896 sh -c n=0; while :; do n=$((n+1)); echo $n > /var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-beat-98380-1787669102472; sleep 0.2; done # sleep 600674 counted 1
✖ cleanup reaches what this tool started, and stops there (5354.562834ms)
ℹ tests 7
ℹ suites 3
ℹ pass 0
ℹ fail 7
```

Seven of seven red. Two of them for the wrong reason, as set out above.

## After

```
▶ no suite outlives the tool
  ✔ AC-1, AC-4, AC-7: a normal exit leaves no suite running, including the runner's own child (504.6955ms)
  ℹ immediately after the tool exited:
92031=gone 92030=gone 92045=gone 92044=gone (no process table: ps is unavailable here)
  ℹ after settling:
92031=gone 92030=gone 92045=gone 92044=gone (no process table: ps is unavailable here)
  ✔ AC-2: an error exit leaves no suite running (557.494ms)
  ℹ immediately after the tool exited:
92132=gone 92131=gone (no process table: ps is unavailable here)
  ℹ after settling:
92132=gone 92131=gone (no process table: ps is unavailable here)
  ✔ AC-3: a signal during the FIRST run leaves no suite running (1659.407875ms)
  ℹ with the first run in flight:
92229=alive 92228=alive
PID  PPID  PGID COMMAND
92228 92215 92228 /bin/sh -c sleep 600244 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-signal-91968-1787668932885.pids"; echo $$ >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-signal-91968-1787668932885.pids"; sleep 30
92229 92228 92228 sleep 600244
  ℹ the tool exited with code 130 signal null
  ℹ after the tool exited:
92229=gone 92228=gone (no process table: ps is unavailable here)
  ✔ AC-1: an exit taken while a suite is running leaves nothing behind either (1053.746791ms)
  ℹ immediately after the exit:
92313=gone 92312=gone (no process table: ps is unavailable here)
  ℹ after settling:
92313=gone 92312=gone (no process table: ps is unavailable here)
✔ no suite outlives the tool (3776.40125ms)
▶ starting on top of a run that is still going
  ✔ AC-5, AC-6: a second start is refused, and the refusal names the run it found (929.386625ms)
  ℹ record: {"pid":92372,"group":92385,"tests":"sleep 600244 >/dev/null 2>&1 & echo $! >> \"/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-refuse-91968-1787668935577.pids\"; echo $$ >> \"/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-refuse-91968-1787668935577.pids\"; sleep 25","repo":"/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-rIsEoX","startedAt":"2026-08-25T14:42:15.664Z"}
  ℹ second start said: [red-first] REFUSED: a run of this tool is still live in this repository: process group 92385 running sleep 600244 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-refuse-91968-1787668935577.pids"; echo $$ >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-refuse-91968-1787668935577.pids"; sleep 25, started 2026-08-25T14:42:15.664Z by red first pid 92372. Starting now would add a second suite to this machine rather than replace the first. End that run, or delete /var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-run-35e4b9e8c19f33c6.json if it has already gone.
  ✔ AC-5: a run that has not spawned its suite yet is live too (213.880458ms)
  ℹ outcome: refused: a run of this tool is still live in this repository: red first pid 92453 running npm test, with no suite under it yet, started 2026-08-25T14:42:16.530Z by red first pid 92453. Starting now would add a second suite to this machine rather than replace the first. End that run, or delete /var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-run-e3529a94bd7ebf49.json if it has already gone.
✔ starting on top of a run that is still going (1143.4755ms)
▶ cleanup reaches what this tool started, and stops there
  ✔ AC-8: a suite this tool did not start is left alone, and is still working afterwards (892.710291ms)
  ℹ foreign suite before: 92505=alive
PID  PPID  PGID COMMAND
92505 91968 92505 sh -c n=0; while :; do n=$((n+1)); echo $n > /var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-beat-91968-1787668936749; sleep 0.2; done # sleep 600244 counted 1
  ℹ foreign suite after: 92505=alive
PID  PPID  PGID COMMAND
92505 91968 92505 sh -c n=0; while :; do n=$((n+1)); echo $n > /var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-beat-91968-1787668936749; sleep 0.2; done # sleep 600244 counted 3 then 4
✔ cleanup reaches what this tool started, and stops there (892.948875ms)
ℹ tests 7
ℹ suites 3
ℹ pass 7
ℹ fail 0
```

Note the durations. The whole file takes 27.2 seconds before and 5.9 seconds
after, because five of its tests each spend five seconds waiting for processes
that never go away.

---

## Breaking it on purpose

Each change below was applied ALONE to `scripts/red-first.js`, the file's tests
were run, and the source was restored. Restores were made by copying a backup
taken outside the repository, never by `git checkout`, because a checkout would
have erased uncommitted work and left a clean tree that proved nothing. Every
run's restore was verified by digest.

To repeat any row, make the change, run `node --test
test/unit/red-first-orphans.test.js`, and put the file back. The rows list the
enclosing suite names alongside the tests, because a failing test fails its
suite; the named tests are the measurements.

One row needs a second edit to repeat it. `leftovers cleared by matching command
lines across the machine` pins `LONG` in the test file to a fixed `654321` and
matches on `sleep 654321`, so that a pattern kill made while reproducing this
can reach nothing but the processes the run itself started. That is the whole
reason the stand in suites sleep for an odd number of seconds.

| Change made | Tests that turned red |
|---|---|
| the whole of this change taken back out of the tool | `AC-1, AC-4, AC-7: a normal exit leaves no suite running, including the runner's own child`; `AC-1: an exit taken while a suite is running leaves nothing behind either`; `AC-2: an error exit leaves no suite running`; `AC-3: a signal during the FIRST run leaves no suite running`; `AC-5, AC-6: a second start is refused, and the refusal names the run it found`; `AC-5: a run that has not spawned its suite yet is live too`; `AC-8: a suite this tool did not start is left alone, and is still working afterwards`; `cleanup reaches what this tool started, and stops there`; `no suite outlives the tool`; `starting on top of a run that is still going` |
| the 'exit' backstop removed, leaving only the function's own finally | `AC-1: an exit taken while a suite is running leaves nothing behind either`; `no suite outlives the tool` |
| the signal listeners moved back to after the first run | `AC-3: a signal during the FIRST run leaves no suite running`; `AC-5, AC-6: a second start is refused, and the refusal names the run it found`; `no suite outlives the tool`; `starting on top of a run that is still going` |
| the direct child signalled instead of the whole group | `AC-1, AC-4, AC-7: a normal exit leaves no suite running, including the runner's own child`; `AC-1: an exit taken while a suite is running leaves nothing behind either`; `AC-2: an error exit leaves no suite running`; `AC-3: a signal during the FIRST run leaves no suite running`; `AC-8: a suite this tool did not start is left alone, and is still working afterwards`; `cleanup reaches what this tool started, and stops there`; `no suite outlives the tool` |
| leftovers cleared by matching command lines across the machine | `AC-8: a suite this tool did not start is left alone, and is still working afterwards`; `cleanup reaches what this tool started, and stops there` |
| the refusal removed, so a second start runs | `AC-5, AC-6: a second start is refused, and the refusal names the run it found`; `AC-5: a run that has not spawned its suite yet is live too`; `starting on top of a run that is still going` |
| the refusal keeps refusing but names nothing | `AC-5, AC-6: a second start is refused, and the refusal names the run it found`; `AC-5: a run that has not spawned its suite yet is live too`; `starting on top of a run that is still going` |
| the run record left behind after the run ends | `AC-1, AC-4, AC-7: a normal exit leaves no suite running, including the runner's own child`; `no suite outlives the tool` |
| a live run with no suite under it treated as gone | `AC-5: a run that has not spawned its suite yet is live too`; `starting on top of a run that is still going` |

The first row is the whole change removed. It is included for shape rather than
as proof, for the reason given above: two of the ten it turns red are red
because an export vanished.

**Two rows are worth reading twice, because each one caught a defect in a test
rather than in the source.** Both were silent on the first pass of this table,
and both were found by running the change rather than by reading it.

`leftovers cleared by matching command lines across the machine` turned nothing
red at first. The pattern kill had worked: the foreign suite was dead. The test
asked whether its pid could still be signalled, and the answer was yes, because
the dead process was the test's own child and had not been reaped, so it sat
there defunct with a pid that `kill(pid, 0)` still accepted. **A liveness answer
that a corpse satisfies is a proxy for the property, in the test for the one
criterion that exists to stop this fix becoming the next defect.** The foreign
suite now counts out loud into a file, and the test requires the count to advance
after the tool has been and gone. A corpse does not count.

`the run record left behind after the run ends` also turned nothing red at
first. The only test that looked at the record ended its run with a signal, and
the signal path cleared the record whatever the ordinary path did. A record left
behind after a normal exit names a pid that is gone, and the refusal at the top
of the tool would then refuse every later start in that repository until
somebody deleted the file by hand: the guard against piling on load becoming an
outage of its own. The normal-exit test now asserts the record has gone.

---

## What is not covered, stated because the refusal is built on it

**SIGKILL of the tool itself.** The kernel delivers it to nothing, so no
listener runs and a group started by a run ended that way outlives it. That is
the case the refusal exists for: the next start finds the record, sees the group
still alive, and says so rather than adding a second suite.

**A run in a different checkout.** The record is per repository, so a suite
running under another worktree is neither seen nor refused. That is deliberate.
Refusing across checkouts means reading and acting on processes this tool did
not start, which is the overreach the eighth criterion forbids.

**A recycled pid.** The refusal is a judgement about numbers, and a pid whose
owner has gone can in principle be reused. The error that produces is a refusal
that should not have happened, which costs a developer one message naming a file
to delete. The other error direction costs everyone on the machine another full
suite. The window is kept small by clearing the record on every exit the process
can see.
