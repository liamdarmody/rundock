# What the reverting check left behind, measured before and after

`scripts/red-first.js` spawns its test command detached. Detached means the
command heads its own process group, which is what lets a whole subtree be
ended together; it also means the group survives this process unless something
ends it. Nothing did, on three of the four ways out.

**This file is a dated record of runs on two machines, not a source of truth.**
Every claim below is re-measured by a named test in
`test/unit/red-first-orphans.test.js` on every run, and those tests print the
process table they measured whether they pass or fail. If this file and the
suite ever disagree, the suite is right.

Reproduce all of it with:

    node --test test/unit/red-first-orphans.test.js

The 'Before' figures were taken on 2026-08-25 against `origin/main` at
`afb63ef`; the macOS 'After' transcript was retaken 2026-09-03 against the code
this document ships beside. The container runs used `node:22-bookworm`:

    docker run --rm -v "$PWD":/repo:ro -w /repo node:22-bookworm \
      node --test test/unit/red-first-orphans.test.js

---

## Why this project's own reverting check cannot prove any of it

Every criterion here is a PROHIBITION: no suite outlives the tool. The usual
proof in this repository is to take the source away and watch a test go red,
and that proof does not work on a prohibition. Removing the ending makes these
tests fail because a function they call has vanished, not because a suite
survived, and a test failing for a missing symbol would fail exactly as loudly
if the prohibition were perfectly kept.

The `before` run below shows that failure mode plainly: several of its lines are
red for a missing export rather than for a leak. **Those lines are not evidence
of anything** and are left in rather than trimmed, because a reader needs to see
the difference between a test that noticed a leak and a test that noticed a
missing function. Each criterion is proven further down instead, by a change
that keeps the mechanism and removes only the behaviour.

There is a second reason, particular to this file. The tool cannot be pointed at
its own branch to check this without doing the very thing being measured: a run
starts two more suites, which is what the branch exists to stop.

So the prohibitions are proven the other way round. **The forbidden act is
committed, one change at a time, and the run records which named test noticed.**

---

## The corpse that keeps a group answering yes

`kill(-pgid, 0)` asks whether a process group exists. It does not ask whether
anything in it is still running, and those are different questions: a process
that has exited keeps its entry, and its group with it, until its parent
collects it. On the signal and exit paths this tool's own direct child is
exactly that. It dies from the SIGTERM at once, and the event loop that would
collect it is blocked in the listener doing the waiting.

**This section previously claimed macOS filters exited members out of that
question, making the defect Linux-only. Measured, that is false.** On macOS,
`kill(-pgid, 0)` against a group whose only member is an exited entry throws
`EPERM`, not `ESRCH`, and the exists idiom reads `EPERM` as existing, which is
also the honest reading: `ps -g` still lists the member, in state `Z`. So both
platforms report such a group as existing, the corpse keeps the group looking
alive for the whole grace on either one, and the fix is the same everywhere:
ask about the members and their states, and judge a group whose remaining
members have all exited as gone. A note of caution for anyone repeating the
measurement: a probe that treats every throw from `kill(-pgid, 0)` as absence
will conclude the opposite, because the throw it sees is the `EPERM`.

The container figures below are historical, taken when this section was first
written; the table under them says which rows the current code can and cannot
reproduce, and why. Both historical runs are the same test against the same two
commits, in a Linux container:

| `scripts/red-first.js` | interrupt to exit | the tool's stderr |
|---|---|---|
| the first version of this change | **571 ms** | `WARNING: process group 187 survived being ended and may still be running` |
| the version that judged members on every poll | **27 ms** | empty |
| this version, measured on macOS 2026-09-03 | **235 ms** | empty |

The grace is 500 ms. The first row is that grace being spent in full on a corpse
and then reporting it as a survivor, on every Ctrl-C. Nothing had survived: init
collects the entry the moment the tool exits.

The first two rows were taken in a Linux container against earlier versions of
this change and are kept as history; the 27 ms figure is not reachable by the
code as it stands, and that is a cost this change accepts knowingly. The process
table is now read at most once per `TABLE_POLL_MS` (150 ms), so a group whose
only remaining member is a corpse is not judged gone for roughly that long, and
the interrupt path pays about a fifth of the grace where it used to pay a
fortieth. What was bought with it: the expensive table read cannot be made on
every turn of the loop, and the judgement of what members mean lives in exactly
one function. No container runtime was available on the measuring machine on
2026-09-03, so the Linux figure for the current code is owed by the next
container run rather than stated here.

The same mistake, one layer up, was in this file's own AC-8 check, where a
pattern kill passed because the process it had killed still answered
`kill(pid, 0)`. Both are fixed by asking the process table for a state instead,
which is why `running()` in the test file and `groupRunning()` in the tool now
share a rule: **an entry that has exited is gone.**

---

## Before: each exit driven against the tool as it was

Lines in the transcripts below are cut at 150 characters, because the stand-in
suites carry the path of their own pid file in argv and the tables are otherwise
unreadable. Nothing else in them is edited.

The stand-in suite is a shell that starts a background child, detaches that
child's stdio so the shell is not held open by it, writes its own process table
while both are alive, and exits. That is the shape of a package runner, and the
child of the child is what was being left behind. Note `PPID 1` and state `S` in
the after-tables: the leftovers had been reparented to init and were running.

```
▶ no suite outlives the tool
  ✖ AC-1, AC-4, AC-7: a normal exit leaves no suite running, including the runner's own child (859.462291ms)
  ℹ with the suite live, written by the runner itself:
PID  PPID  PGID STAT COMMAND
 7683  7621  7683 Ss   /bin/sh -c sleep 600480 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-normal […]
 7685  7683  7683 S    sleep 600480
  PID  PPID  PGID STAT COMMAND
 7746  7621  7746 Ss   /bin/sh -c sleep 600480 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-normal […]
 7758  7746  7746 S    sleep 600480
  ℹ once the tool had exited:
7685=running 7683=gone 7758=running 7746=gone
PID  PPID  PGID STAT COMMAND
 7685     1  7683 S    sleep 600480
 7758     1  7746 S    sleep 600480
  ✖ AC-1: a suite that ignores SIGTERM is ended anyway, which is what the escalation is for (767.5565ms)
  ℹ with the stubborn suite live:
PID  PPID  PGID STAT COMMAND
 8084  8016  8084 Ss   /bin/sh -c trap '' TERM; sleep 600480 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first- […]
 8085  8084  8084 S    sleep 600480
  PID  PPID  PGID STAT COMMAND
 8144  8016  8144 Ss   /bin/sh -c trap '' TERM; sleep 600480 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first- […]
 8156  8144  8144 S    sleep 600480
  ℹ once the tool had exited:
8085=running 8084=gone 8156=running 8144=gone
PID  PPID  PGID STAT COMMAND
 8085     1  8084 S    sleep 600480
 8156     1  8144 S    sleep 600480
  ✖ AC-2: an error raised while a suite is in flight leaves no suite running (478.990417ms)
  ℹ once the error had taken the process down:
8435=running 8434=running
PID  PPID  PGID STAT COMMAND
 8434     1  8434 Ss   /bin/sh -c sleep 600480 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-inflig […]
 8435  8434  8434 S    sleep 600480
  ✖ AC-2: an error out of the run itself also leaves no suite running (799.046291ms)
  ℹ with the suite live, written by the runner itself:
PID  PPID  PGID STAT COMMAND
 8676  8616  8676 Ss   /bin/sh -c sleep 600480 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-error- […]
 8677  8676  8676 S    sleep 600480
  ℹ once the tool had exited:
8677=running 8676=gone
PID  PPID  PGID STAT COMMAND
 8677     1  8676 S    sleep 600480
  ✖ AC-3: a signal during the FIRST run leaves no suite running (705.931417ms)
  ℹ with the first run in flight:
8931=running 8930=running
PID  PPID  PGID STAT COMMAND
 8930  8916  8930 Ss   /bin/sh -c sleep 600480 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-signal […]
 8931  8930  8930 S    sleep 600480
  ℹ the tool exited with code null signal SIGTERM after 4ms
  ℹ its stderr was: (empty)
  ℹ once the tool had exited:
8931=running 8930=running
PID  PPID  PGID STAT COMMAND
 8930     1  8930 Ss   /bin/sh -c sleep 600480 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-signal […]
 8931  8930  8930 S    sleep 600480
  ✖ AC-1: an exit taken while a suite is running leaves nothing behind either (647.51075ms)
  ℹ once the exit had been taken:
9032=running 9031=running
PID  PPID  PGID STAT COMMAND
 9031     1  9031 Ss   /bin/sh -c sleep 600480 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-inflig […]
 9032  9031  9031 S    sleep 600480
✖ no suite outlives the tool (4259.993333ms)
▶ telling a process that has exited from one that is still running
  ✖ a group whose remaining members have all exited is judged gone (1.611542ms)
  ✖ a group that no longer exists is gone without consulting the process table (10.300708ms)
✖ telling a process that has exited from one that is still running (12.359708ms)
▶ starting on top of a run that is still going
  ✖ AC-5, AC-6: a second start is refused, and the refusal names the run it found (471.16375ms)
  ✖ AC-5: a run that has not spawned its suite yet is live too (424.704333ms)
✖ starting on top of a run that is still going (896.124666ms)
▶ a suite the tool could not end
  ✖ AC-5: the run record is kept naming it, so the next start has something to refuse on (458.873667ms)
  ℹ stderr: 
✖ a suite the tool could not end (459.014625ms)
▶ two starts at once against one repository
  ✖ AC-5: exactly one runs and the other is refused, however close together they are (6488.314ms)
  ℹ first said:  [red-first] restoring the source, keeping the tests
  ℹ second said: [red-first] NOT-DISCRIMINATING: the tests pass with the source reverted, so they do not discriminate this change and would have gone  […]
✖ two starts at once against one repository (6488.564459ms)
▶ cleanup reaches what this tool started, and stops there
  ✖ AC-8: a suite this tool did not start is left alone, and is still working afterwards (543.768541ms)
  ℹ foreign suite before: 9876=running
PID  PPID  PGID STAT COMMAND
 9876  7459  9876 Ss   sh -c n=0; while :; do n=$((n+1)); echo $n > /var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-beat-7459-17876 […]
✖ cleanup reaches what this tool started, and stops there (544.032875ms)
ℹ tests 13
ℹ suites 6
ℹ pass 0
ℹ fail 13
```

## After, on macOS

Taken 2026-09-03 against the code this document ships beside: 20 tests across
11 suites, including the retirement-contention and refused-record cases added
since the earlier capture.

```
▶ no suite outlives the tool
  ✔ AC-1, AC-4, AC-7: a normal exit leaves no suite running, including the runner's own child (669.477875ms)
  ℹ with the suite live, written by the runner itself:
PID  PPID  PGID STAT COMMAND
66356 66323 66356 Ss   /bin/sh -c sleep 600476 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-normal-66278-1788430778578"; echo $$ >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-normal-66278-1788430778578"; ps -o pid,ppid,pgid,stat,command -p "$!,$$" >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-normal-before-66278-1788430778578" 2>&1; exit 0
66357 66356 66356 S    sleep 600476
  PID  PPID  PGID STAT COMMAND
66376 66323 66376 Ss   /bin/sh -c sleep 600476 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-normal-66278-1788430778578"; echo $$ >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-normal-66278-1788430778578"; ps -o pid,ppid,pgid,stat,command -p "$!,$$" >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-normal-before-66278-1788430778578" 2>&1; exit 0
66377 66376 66376 S    sleep 600476
  ℹ once the tool had exited:
66357=gone 66356=gone 66377=gone 66376=gone
(process table empty: none of these pids exist)
  ✔ AC-1: a suite that ignores SIGTERM is ended anyway, which is what the escalation is for (1768.723ms)
  ℹ with the stubborn suite live:
PID  PPID  PGID STAT COMMAND
66482 66449 66482 Ss   /bin/sh -c trap '' TERM; sleep 600476 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-stubborn-66278-1788430779212"; echo $$ >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-stubborn-66278-1788430779212"; ps -o pid,ppid,pgid,stat,command -p "$!,$$" >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-stubborn-before-66278-1788430779212" 2>&1; exit 0
66483 66482 66482 S    sleep 600476
  PID  PPID  PGID STAT COMMAND
66517 66449 66517 Ss   /bin/sh -c trap '' TERM; sleep 600476 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-stubborn-66278-1788430779212"; echo $$ >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-stubborn-66278-1788430779212"; ps -o pid,ppid,pgid,stat,command -p "$!,$$" >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-stubborn-before-66278-1788430779212" 2>&1; exit 0
66518 66517 66517 S    sleep 600476
  ℹ once the tool had exited:
66483=gone 66482=gone 66518=gone 66517=gone
(process table empty: none of these pids exist)
  ✔ AC-2: an error raised while a suite is in flight leaves no suite running (580.804292ms)
  ℹ once the error had taken the process down:
66640=gone 66639=gone
(process table empty: none of these pids exist)
  ✔ AC-2: an error out of the run itself also leaves no suite running (503.597959ms)
  ℹ with the suite live, written by the runner itself:
PID  PPID  PGID STAT COMMAND
66738 66704 66738 Ss   /bin/sh -c sleep 600476 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-error-66278-1788430781563"; echo $$ >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-error-66278-1788430781563"; ps -o pid,ppid,pgid,stat,command -p "$!,$$" >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-error-before-66278-1788430781563" 2>&1; rm -rf .git; exit 0
66739 66738 66738 S    sleep 600476
  ℹ once the tool had exited:
66739=gone 66738=gone
(process table empty: none of these pids exist)
  ✔ AC-3: a signal during the FIRST run leaves no suite running (675.542292ms)
  ℹ with the first run in flight:
66855=running 66854=running
PID  PPID  PGID STAT COMMAND
66854 66820 66854 Ss   /bin/sh -c sleep 600476 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-signal-66278-1788430782079"; echo $$ >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-signal-66278-1788430782079"; sleep 30
66855 66854 66854 S    sleep 600476
  ℹ the tool exited with code 130 signal null after 235ms
  ℹ its stderr was: (empty)
  ℹ once the tool had exited:
66855=gone 66854=gone
(process table empty: none of these pids exist)
  ✔ AC-1: an exit taken while a suite is running leaves nothing behind either (555.609667ms)
  ℹ once the exit had been taken:
66977=gone 66976=gone
(process table empty: none of these pids exist)
✔ no suite outlives the tool (4754.468958ms)
▶ telling a process that has exited from one that is still running
  ✔ a group whose remaining members have all exited is judged gone (0.902375ms)
  ✔ a group that no longer exists is gone without consulting the process table (4.279125ms)
✔ telling a process that has exited from one that is still running (5.350083ms)
▶ a refusal describes what it found, not what the record carries
  ✔ AC-6: a record naming a finished group reports the live run, not that group (165.859625ms)
  ℹ refusal: [red-first] REFUSED: a run of this tool is still live in this repository: red first pid 66278 running npm test, with no suite under it yet, started 2026-09-03T10:19:43.308Z by red first pid 66278. Starting now would add a second suite to this machine rather than replace the first. End that run, or delete /var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-run-935470869cf97447.json if it has already gone.
  ✔ AC-5: a record that cannot be read is refused and left alone, not cleared (1032.526709ms)
  ℹ refusal: [red-first] REFUSED: could not take the run record for this repository at /var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-run-3d3317379b6eef02.json: it could not be read, or another start held it each time this one tried. It is left where it is rather than deleted, because a record this run cannot understand may belong to a run that is still going. Inspect it, and remove it if nothing is running.
✔ a refusal describes what it found, not what the record carries (1198.573084ms)
▶ a machine that will not describe its own process table
  ✔ the group is still ended, and nothing is announced that cannot be known (842.058792ms)
  ℹ before: 67107=running 67106=running
PID  PPID  PGID STAT COMMAND
67106 66278 67106 Ss   sh -c sleep 600476 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-unknowable-66278-1788430784381"; echo $$ >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-unknowable-66278-1788430784381"; sleep 30
67107 67106 67106 S    sleep 600476
  ℹ endGroup said unknown; after: 67107=gone 67106=gone
PID  PPID  PGID STAT COMMAND
67106 66278 67106 Z    <defunct>
  ✔ AC-5: a suite it cannot describe is treated as live, so a start is refused (211.980833ms)
  ℹ with no ps on PATH: [red-first] REFUSED: a run of this tool is still live in this repository: process group 67195 running npm test, started 2026-09-03T10:19:45.389Z by red first pid 67205. Starting now would add a second suite to this machine rather than replace the first. End that run, or delete /var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-run-0a7874fd991c853f.json if it has already gone.
✔ a machine that will not describe its own process table (1054.223083ms)
▶ one checkout reached by two names
  ✔ AC-5: is one run record, so a second start through a symbolic link is refused (816.560125ms)
  ℹ start through the link said: [red-first] REFUSED: a run of this tool is still live in this repository: process group 67290 running sleep 600476 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-symlink-66278-1788430785809"; echo $$ >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-symlink-66278-1788430785809"; sleep 20, started 2026-09-03T10:19:45.844Z by red first pid 67257. Starting now would add a second suite to this machine rather than replace the first. End that run, or delete /var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-run-d30b761e358c2da2.json if it has already gone.
✔ one checkout reached by two names (816.66725ms)
▶ starting on top of a run that is still going
  ✔ AC-5, AC-6: a second start is refused, and the refusal names the run it found (611.545875ms)
  ℹ record: {"pid":67365,"group":67398,"tests":"sleep 600476 >/dev/null 2>&1 & echo $! >> \"/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-refuse-66278-1788430786379\"; echo $$ >> \"/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-refuse-66278-1788430786379\"; sleep 600476","repo":"/private/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-574Fue","startedAt":"2026-09-03T10:19:46.407Z"}
  ℹ second start said: [red-first] REFUSED: a run of this tool is still live in this repository: process group 67398 running sleep 600476 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-refuse-66278-1788430786379"; echo $$ >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-refuse-66278-1788430786379"; sleep 600476, started 2026-09-03T10:19:46.407Z by red first pid 67365. Starting now would add a second suite to this machine rather than replace the first. End that run, or delete /var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-run-6892c01ffa090482.json if it has already gone.
  ℹ the first run's stderr was: (empty)
  ✔ AC-5: a run that has not spawned its suite yet is live too (336.348875ms)
  ℹ the record the tool wrote: {"pid":66278,"group":null,"tests":"this command is never spawned","repo":"/private/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-dA30bl","startedAt":"2026-09-03T10:19:46.994Z"}
  ℹ second start said: [red-first] REFUSED: a run of this tool is still live in this repository: red first pid 66278 running this command is never spawned, with no suite under it yet, started 2026-09-03T10:19:46.994Z by red first pid 66278. Starting now would add a second suite to this machine rather than replace the first. End that run, or delete /var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-run-87f4c4db95753da6.json if it has already gone.
✔ starting on top of a run that is still going (948.024583ms)
▶ a suite the tool could not end
  ✔ AC-5: the run record is kept naming it, so the next start has something to refuse on (356.9305ms)
  ℹ stderr: [red-first] WARNING: process group 67616 survived being ended and is still running; nothing further here can reach it, and the run record has been left in place naming it so the next start refuses rather than adding a second suite
  ℹ record kept: {"pid":67583,"group":67616,"tests":"sleep 600476 >/dev/null 2>&1 & echo $! >> \"/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-survivor-66278-1788430787327\"; echo $$ >> \"/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-survivor-66278-1788430787327\"; exit 0","repo":"/private/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-Llp4r1","startedAt":"2026-09-03T10:19:47.356Z","survivedEnding":true}
  ℹ start against the abandoned suite said: [red-first] REFUSED: a run of this tool is still live in this repository: process group 67616 running sleep 600476 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-survivor-66278-1788430787327"; echo $$ >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-survivor-66278-1788430787327"; exit 0, started 2026-09-03T10:19:47.356Z by red first pid 67583. Starting now would add a second suite to this machine rather than replace the first. End that run, or delete /var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-run-dbf5b163478c9bbb.json if it has already gone.
✔ a suite the tool could not end (357.007125ms)
▶ a record left behind by a run that has ended
  ✔ AC-5: is cleared when its suite has gone, and refused while its suite is alive (6657.960041ms)
  ℹ with the suite still alive: [red-first] REFUSED: a run of this tool is still live in this repository: process group 67682 running npm test, started 2026-09-03T10:19:47.688Z by red first pid 67687. Starting now would add a second suite to this machine rather than replace the first. End that run, or delete /var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-run-2f8dd086f87e286b.json if it has already gone.
  ℹ record during the run: {"pid":67709,"group":null,"tests":"sleep 600476 >/dev/null 2>&1 & echo $! >> \"/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-stale-66278-1788430787681\"; echo $$ >> \"/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-stale-66278-1788430787681\"; sleep 3","repo":"/private/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-p3xcYS","startedAt":"2026-09-03T10:19:47.769Z"}
  ℹ start over a stale record said: [red-first] NOT-DISCRIMINATING: the tests pass with the source reverted, so they do not discriminate this change and would have gone green against the defect they were written for
✔ a record left behind by a run that has ended (6658.075042ms)
▶ two starts at once against one repository
  ✔ AC-5: exactly one runs and the other is refused, however close together they are (6548.788625ms)
  ℹ first said:  [red-first] REFUSED: a run of this tool is still live in this repository: red first pid 67831 running sleep 600476 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-raceB-66278-1788430794336"; echo $$ >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-raceB-66278-1788430794336"; sleep 3, with no suite under it yet, started 2026-09-03T10:19:54.367Z by red first pid 67831. Starting now would add a second suite to this machine rather than replace the first. End that run, or delete /var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-run-dc1357c27df55c4c.json if it has already gone.
  ℹ second said: [red-first] NOT-DISCRIMINATING: the tests pass with the source reverted, so they do not discriminate this change and would have gone green against the defect they were written for
✔ two starts at once against one repository (6548.927667ms)
▶ two starts against a repository whose record is stale
  ✔ AC-5: a stale record is retired by exactly one of two simultaneous starts (6533.282458ms)
  ℹ first said:  [red-first] REFUSED: a run of this tool is still live in this repository: red first pid 67959 running sleep 600476 >/dev/null 2>&1 & echo $! >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-staleRaceB-66278-1788430800883"; echo $$ >> "/var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-staleRaceB-66278-1788430800883"; sleep 3, with no suite under it yet, started 2026-09-03T10:20:00.924Z by red first pid 67959. Starting now would add a second suite to this machine rather than replace the first. End that run, or delete /var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-run-855e201cc6b72a44.json if it has already gone.
  ℹ second said: [red-first] NOT-DISCRIMINATING: the tests pass with the source reverted, so they do not discriminate this change and would have gone green against the defect they were written for
✔ two starts against a repository whose record is stale (6533.453833ms)
▶ cleanup reaches what this tool started, and stops there
  ✔ AC-8: a suite this tool did not start is left alone, and is still working afterwards (597.388333ms)
  ℹ foreign suite before: 68096=running
PID  PPID  PGID STAT COMMAND
68096 66278 68096 Ss   sh -c n=0; while :; do n=$((n+1)); echo $n > /var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-beat-66278-1788430807413; sleep 0.2; done # sleep 600476 counted 1
  ℹ foreign suite after: 68096=running
PID  PPID  PGID STAT COMMAND
68096 66278 68096 Ss   sh -c n=0; while :; do n=$((n+1)); echo $n > /var/folders/d2/8vgzjqz958j6bvckjtt726ww0000gn/T/red-first-orphans-beat-66278-1788430807413; sleep 0.2; done # sleep 600476 counted 2 then 3
✔ cleanup reaches what this tool started, and stops there (597.509625ms)
ℹ tests 20
ℹ suites 11
ℹ pass 20
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 29536.207125
```

## After, in a Linux container

Taken against the pre-throttle version of this change (the 13-test suite of
its day). Kept as the record of the platform behaviour it demonstrates; the
current 20-test suite has no container run yet, for the reason given beside
the timing table above.

```
▶ no suite outlives the tool
  ✔ AC-1, AC-4, AC-7: a normal exit leaves no suite running, including the runner's own child (321.916292ms)
  ℹ with the suite live, written by the runner itself:
PID    PPID    PGID STAT COMMAND
     42      32      42 Ss   /bin/sh -c sleep 600013 >/dev/null 2>&1 & echo $! >> "/tmp/red-first-orphans-normal-13-1787674346395"; echo $$ >> "/tmp/r […]
     43      42      42 S    sleep 600013
    PID    PPID    PGID STAT COMMAND
     50      32      50 Ss   /bin/sh -c sleep 600013 >/dev/null 2>&1 & echo $! >> "/tmp/red-first-orphans-normal-13-1787674346395"; echo $$ >> "/tmp/r […]
     51      50      50 S    sleep 600013
  ℹ once the tool had exited:
43=gone 42=gone 51=gone 50=gone
PID    PPID    PGID STAT COMMAND
     43       1      42 Z    [sleep] <defunct>
     51       1      50 Z    [sleep] <defunct>
  ✔ AC-1: a suite that ignores SIGTERM is ended anyway, which is what the escalation is for (1409.124084ms)
  ℹ with the stubborn suite live:
PID    PPID    PGID STAT COMMAND
     86      76      86 Ss   /bin/sh -c trap '' TERM; sleep 600013 >/dev/null 2>&1 & echo $! >> "/tmp/red-first-orphans-stubborn-13-1787674346667"; ec […]
     87      86      86 S    sleep 600013
    PID    PPID    PGID STAT COMMAND
    103      76     103 Ss   /bin/sh -c trap '' TERM; sleep 600013 >/dev/null 2>&1 & echo $! >> "/tmp/red-first-orphans-stubborn-13-1787674346667"; ec […]
    104     103     103 S    sleep 600013
  ℹ once the tool had exited:
87=gone 86=gone 104=gone 103=gone
PID    PPID    PGID STAT COMMAND
     87       1      86 Z    [sleep] <defunct>
    104       1     103 Z    [sleep] <defunct>
  ✔ AC-2: an error raised while a suite is in flight leaves no suite running (217.856ms)
  ℹ once the error had taken the process down:
149=gone 148=gone
PID    PPID    PGID STAT COMMAND
    148       1     148 Zs   [sh] <defunct>
    149       1     148 Z    [sleep] <defunct>
  ✔ AC-2: an error out of the run itself also leaves no suite running (151.491542ms)
  ℹ with the suite live, written by the runner itself:
PID    PPID    PGID STAT COMMAND
    180     170     180 Ss   /bin/sh -c sleep 600013 >/dev/null 2>&1 & echo $! >> "/tmp/red-first-orphans-error-13-1787674348281"; echo $$ >> "/tmp/re […]
    181     180     180 S    sleep 600013
  ℹ once the tool had exited:
181=gone 180=gone
PID    PPID    PGID STAT COMMAND
    181       1     180 Z    [sleep] <defunct>
  ✔ AC-3: a signal during the FIRST run leaves no suite running (224.052459ms)
  ℹ with the first run in flight:
218=running 217=running
PID    PPID    PGID STAT COMMAND
    217     207     217 Ss   /bin/sh -c sleep 600013 >/dev/null 2>&1 & echo $! >> "/tmp/red-first-orphans-signal-13-1787674348441"; echo $$ >> "/tmp/r […]
    218     217     217 S    sleep 600013
  ℹ the tool exited with code 130 signal null after 27ms
  ℹ its stderr was: (empty)
  ℹ once the tool had exited:
218=gone 217=gone
PID    PPID    PGID STAT COMMAND
    217       1     217 Zs   [sh] <defunct>
  ✔ AC-1: an exit taken while a suite is running leaves nothing behind either (198.727625ms)
  ℹ once the exit had been taken:
254=gone 253=gone
PID    PPID    PGID STAT COMMAND
    253       1     253 Zs   [sh] <defunct>
    254       1     253 Z    [sleep] <defunct>
✔ no suite outlives the tool (2525.215793ms)
▶ telling a process that has exited from one that is still running
  ✔ a group whose remaining members have all exited is judged gone (2.5155ms)
  ✔ a group that no longer exists is gone without consulting the process table (9.242125ms)
✔ telling a process that has exited from one that is still running (12.3465ms)
▶ starting on top of a run that is still going
  ✔ AC-5, AC-6: a second start is refused, and the refusal names the run it found (248.055917ms)
  ℹ record: {"pid":278,"group":288,"tests":"sleep 600013 >/dev/null 2>&1 & echo $! >> \"/tmp/red-first-orphans-refuse-13-1787674348877\"; echo $$ >> \ […]
  ℹ second start said: [red-first] REFUSED: a run of this tool is still live in this repository: process group 288 running sleep 600013 >/dev/null 2>& […]
  ℹ the first run's stderr was: (empty)
  ✔ AC-5: a run that has not spawned its suite yet is live too (129.228ms)
  ℹ the record the tool wrote: {"pid":13,"group":null,"tests":"this command is never spawned","repo":"/tmp/red-first-orphans-veHjJt","startedAt":"2026 […]
  ℹ second start said: [red-first] REFUSED: a run of this tool is still live in this repository: red first pid 13 running this command is never spawne […]
✔ starting on top of a run that is still going (377.735458ms)
▶ a suite the tool could not end
  ✔ AC-5: the run record is kept naming it, so the next start has something to refuse on (147.594584ms)
  ℹ stderr: [red-first] WARNING: process group 356 survived being ended and is still running; nothing further here can reach it, and the run record ha […]
[red-first] WARNING: process group 361 survived being ended and is still running; nothing further here can reach it, and the run record has been left  […]
  ℹ record kept: {"pid":346,"group":356,"tests":"sleep 600013 >/dev/null 2>&1 & echo $! >> \"/tmp/red-first-orphans-survivor-13-1787674349253\"; echo  […]
✔ a suite the tool could not end (147.8185ms)
▶ two starts at once against one repository
  ✔ AC-5: exactly one runs and the other is refused, however close together they are (6246.855461ms)
  ℹ first said:  [red-first] NOT-DISCRIMINATING: the tests pass with the source reverted, so they do not discriminate this change and would have gone  […]
  ℹ second said: [red-first] REFUSED: a run of this tool is still live in this repository: red first pid 379 running sleep 600013 >/dev/null 2>&1 & ec […]
✔ two starts at once against one repository (6247.501545ms)
▶ cleanup reaches what this tool started, and stops there
  ✔ AC-8: a suite this tool did not start is left alone, and is still working afterwards (327.345292ms)
  ℹ foreign suite before: 429=running
PID    PPID    PGID STAT COMMAND
    429      13     429 Ss   sh -c n=0; while :; do n=$((n+1)); echo $n > /tmp/red-first-orphans-beat-13-1787674355653; sleep 0.2; done # sleep 600013 […]
  ℹ foreign suite after: 429=running
PID    PPID    PGID STAT COMMAND
    429      13     429 Ss   sh -c n=0; while :; do n=$((n+1)); echo $n > /tmp/red-first-orphans-beat-13-1787674355653; sleep 0.2; done # sleep 600013 […]
✔ cleanup reaches what this tool started, and stops there (327.780667ms)
ℹ tests 13
ℹ suites 6
ℹ pass 13
ℹ fail 0
```

The after-tables read `(process table empty: none of these pids exist)`. That
wording is the correction of a false statement in the previous version of this
file, which said the table could not be captured. `ps -p` exits non-zero when
none of the listed pids exist, and that is a successful lookup finding nothing,
not `ps` failing to run; the helper now separates the two and reserves the
unavailable wording for a spawn failure.

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
reason the stand-in suites sleep for an odd number of seconds.

macOS:

| Change made | Tests that turned red |
|---|---|
| the whole of this change taken back out of the tool | the whole of `test/unit/red-first-orphans.test.js` red at module load: the exports vanish, so every suite fails before any test runs |
| the ending after each run removed | `AC-1, AC-4, AC-7: a normal exit leaves no suite running, including the runner's own child`; `AC-1: a suite that ignores SIGTERM is ended anyway, which is what the escalation is for`; `AC-2: an error out of the run itself also leaves no suite running`; `AC-5: exactly one runs and the other is refused, however close together they are`; `AC-5: the run record is kept naming it, so the next start has something to refuse on`; `AC-8: a suite this tool did not start is left alone, and is still working afterwards`; `a suite the tool could not end`; `cleanup reaches what this tool started, and stops there`; `no suite outlives the tool`; `two starts at once against one repository` |
| the 'exit' backstop removed | `AC-1: an exit taken while a suite is running leaves nothing behind either`; `AC-2: an error raised while a suite is in flight leaves no suite running`; `no suite outlives the tool` |
| the signal listeners moved back to after the first run | `AC-3: a signal during the FIRST run leaves no suite running`; `AC-5, AC-6: a second start is refused, and the refusal names the run it found`; `no suite outlives the tool`; `starting on top of a run that is still going` |
| the direct child signalled instead of the whole group | `AC-1, AC-4, AC-7: a normal exit leaves no suite running, including the runner's own child`; `AC-1: a suite that ignores SIGTERM is ended anyway, which is what the escalation is for`; `AC-1: an exit taken while a suite is running leaves nothing behind either`; `AC-2: an error out of the run itself also leaves no suite running`; `AC-2: an error raised while a suite is in flight leaves no suite running`; `AC-3: a signal during the FIRST run leaves no suite running`; `AC-5, AC-6: a second start is refused, and the refusal names the run it found`; `AC-5: exactly one runs and the other is refused, however close together they are`; `AC-5: is cleared when its suite has gone, and refused while its suite is alive`; `AC-8: a suite this tool did not start is left alone, and is still working afterwards`; `a machine that will not describe its own process table`; `a record left behind by a run that has ended`; `cleanup reaches what this tool started, and stops there`; `no suite outlives the tool`; `starting on top of a run that is still going`; `the group is still ended, and nothing is announced that cannot be known`; `two starts at once against one repository` |
| the escalation from SIGTERM to SIGKILL removed | `AC-1: a suite that ignores SIGTERM is ended anyway, which is what the escalation is for`; `no suite outlives the tool` |
| an exited member counted as a running one | `AC-1: an exit taken while a suite is running leaves nothing behind either`; `AC-2: an error raised while a suite is in flight leaves no suite running`; `AC-3: a signal during the FIRST run leaves no suite running`; `AC-5, AC-6: a second start is refused, and the refusal names the run it found`; `a group whose remaining members have all exited is judged gone`; `a machine that will not describe its own process table`; `no suite outlives the tool`; `starting on top of a run that is still going`; `telling a process that has exited from one that is still running`; `the group is still ended, and nothing is announced that cannot be known` |
| the process table read even when the group has gone | `a group that no longer exists is gone without consulting the process table`; `telling a process that has exited from one that is still running` |
| a machine that will not say treated as a survivor | `a machine that will not describe its own process table`; `the group is still ended, and nothing is announced that cannot be known` |
| leftovers cleared by matching command lines across the machine | `AC-8: a suite this tool did not start is left alone, and is still working afterwards`; `cleanup reaches what this tool started, and stops there` |
| the refusal removed, so a second start runs | `AC-5, AC-6: a second start is refused, and the refusal names the run it found`; `AC-5: a record that cannot be read is refused and left alone, not cleared`; `AC-5: a run that has not spawned its suite yet is live too`; `AC-5: a suite it cannot describe is treated as live, so a start is refused`; `AC-5: exactly one runs and the other is refused, however close together they are`; `AC-5: is cleared when its suite has gone, and refused while its suite is alive`; `AC-5: is one run record, so a second start through a symbolic link is refused`; `AC-5: the run record is kept naming it, so the next start has something to refuse on`; `AC-6: a record naming a finished group reports the live run, not that group`; `a machine that will not describe its own process table`; `a record left behind by a run that has ended`; `a refusal describes what it found, not what the record carries`; `a suite the tool could not end`; `one checkout reached by two names`; `starting on top of a run that is still going`; `two starts at once against one repository` |
| the refusal keeps refusing but names nothing | `AC-5, AC-6: a second start is refused, and the refusal names the run it found`; `AC-5: a run that has not spawned its suite yet is live too`; `AC-5: a suite it cannot describe is treated as live, so a start is refused`; `AC-5: is cleared when its suite has gone, and refused while its suite is alive`; `AC-5: the run record is kept naming it, so the next start has something to refuse on`; `AC-6: a record naming a finished group reports the live run, not that group`; `a machine that will not describe its own process table`; `a record left behind by a run that has ended`; `a refusal describes what it found, not what the record carries`; `a suite the tool could not end`; `starting on top of a run that is still going` |
| the refusal worded from the record rather than from what was found live | `AC-6: a record naming a finished group reports the live run, not that group`; `a refusal describes what it found, not what the record carries` |
| the run record left behind after the run ends | `AC-1, AC-4, AC-7: a normal exit leaves no suite running, including the runner's own child`; `AC-2: an error out of the run itself also leaves no suite running`; `AC-2: an error raised while a suite is in flight leaves no suite running`; `AC-5: a run that has not spawned its suite yet is live too`; `AC-5: exactly one runs and the other is refused, however close together they are`; `AC-5: is cleared when its suite has gone, and refused while its suite is alive`; `a record left behind by a run that has ended`; `no suite outlives the tool`; `starting on top of a run that is still going`; `two starts at once against one repository` |
| a live run with no suite under it treated as gone | `AC-5: a run that has not spawned its suite yet is live too`; `AC-5: exactly one runs and the other is refused, however close together they are`; `AC-6: a record naming a finished group reports the live run, not that group`; `a refusal describes what it found, not what the record carries`; `starting on top of a run that is still going`; `two starts at once against one repository` |
| a suite from a previous run treated as gone | `AC-5, AC-6: a second start is refused, and the refusal names the run it found`; `AC-5: a suite it cannot describe is treated as live, so a start is refused`; `AC-5: is cleared when its suite has gone, and refused while its suite is alive`; `AC-5: the run record is kept naming it, so the next start has something to refuse on`; `a machine that will not describe its own process table`; `a record left behind by a run that has ended`; `a suite the tool could not end`; `starting on top of a run that is still going` |
| a record whose run has ended refused instead of cleared | `AC-5, AC-6: a second start is refused, and the refusal names the run it found`; `AC-5: a suite it cannot describe is treated as live, so a start is refused`; `AC-5: is cleared when its suite has gone, and refused while its suite is alive`; `AC-5: the run record is kept naming it, so the next start has something to refuse on`; `a machine that will not describe its own process table`; `a record left behind by a run that has ended`; `a suite the tool could not end`; `starting on top of a run that is still going` |
| a record that cannot be read treated as stale and deleted | `AC-5: a record that cannot be read is refused and left alone, not cleared`; `a refusal describes what it found, not what the record carries` |
| the record given back even when a group survived ending | `AC-5: the run record is kept naming it, so the next start has something to refuse on`; `a suite the tool could not end` |
| a survivor does not stop the next spawn | `AC-5: the run record is kept naming it, so the next start has something to refuse on`; `a suite the tool could not end` |
| the claim written without an exclusive create | `AC-5, AC-6: a second start is refused, and the refusal names the run it found`; `AC-5: a record that cannot be read is refused and left alone, not cleared`; `AC-5: a run that has not spawned its suite yet is live too`; `AC-5: a suite it cannot describe is treated as live, so a start is refused`; `AC-5: exactly one runs and the other is refused, however close together they are`; `AC-5: is cleared when its suite has gone, and refused while its suite is alive`; `AC-5: is one run record, so a second start through a symbolic link is refused`; `AC-5: the run record is kept naming it, so the next start has something to refuse on`; `AC-6: a record naming a finished group reports the live run, not that group`; `a machine that will not describe its own process table`; `a record left behind by a run that has ended`; `a refusal describes what it found, not what the record carries`; `a suite the tool could not end`; `one checkout reached by two names`; `starting on top of a run that is still going`; `two starts at once against one repository` |
| the repository keyed by its uncanonical path | `AC-5: is one run record, so a second start through a symbolic link is refused`; `one checkout reached by two names` |

The first row is the whole change removed. It is included for shape rather than
as proof, for the reason given above: several of the tests it turns red are red
because an export vanished. In this regeneration that shows as the whole test
file reported red at module load, which is the same artifact one level up.

The zombie rule is the one row whose consequence differs by platform, so it was
run again in the Linux container. There it also reddens every path that ends a
live suite, because the corpse keeps the group looking alive for the whole grace
and the ending then announces a survivor that is not one:

| Change made | Tests that turned red, in a Linux container |
|---|---|
| an exited member counted as a running one | `AC-1, AC-4, AC-7: a normal exit leaves no suite running, including the runner's own child`; `AC-1: a suite that ignores SIGTERM is ended anyway, which is what the escalation is for`; `AC-1: an exit taken while a suite is running leaves nothing behind either`; `AC-2: an error out of the run itself also leaves no suite running`; `AC-2: an error raised while a suite is in flight leaves no suite running`; `AC-3: a signal during the FIRST run leaves no suite running`; `AC-5, AC-6: a second start is refused, and the refusal names the run it found`; `AC-5: exactly one runs and the other is refused, however close together they are`; `AC-8: a suite this tool did not start is left alone, and is still working afterwards`; `a group whose remaining members have all exited is judged gone`; `cleanup reaches what this tool started, and stops there`; `no suite outlives the tool`; `starting on top of a run that is still going`; `telling a process that has exited from one that is still running`; `two starts at once against one repository` |

**Three rows caught a defect in a test rather than in the source.** All three
were silent until the change was actually run, and none of them could have been
found by reading the diff.

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
outage of its own. Every exit test now asserts the record has gone.

`the escalation from SIGTERM to SIGKILL removed` turned nothing red either,
because every stand-in suite in the file died on the first signal. A child that
ignores SIGTERM is the only case where the escalation is what keeps a suite from
outliving the tool, and the criterion it answers to is unconditional. There is
now a stand-in that sets TERM to ignored before starting its background child,
which inherits the ignored disposition across exec.

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

**The alarm, where the process table cannot be read.** Telling a corpse from a
survivor needs `ps`, and a sandbox that blocks spawning leaves the tool unable
to tell. It stays quiet there rather than warning, because the alternative is an
alarm that fires on every ordinary interrupt on Linux, and one that cries wolf
is one nobody reads. The cost is that a genuine survivor is not announced on
such a machine either. Everything else, including the ending itself, works
unchanged.

**A recycled pid.** The refusal is a judgement about numbers, and a pid whose
owner has gone can in principle be reused. The error that produces is a refusal
that should not have happened, which costs a developer one message naming a file
to delete. The other error direction costs everyone on the machine another full
suite.
