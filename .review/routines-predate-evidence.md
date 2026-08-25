# Evidence: routines that predate the scheduler, and schedules it cannot read

Recorded here because a reviewer sees the change and the criteria and nothing
else. Every block below is captured output from a run on this branch, not a
description of one, and each names where the same claim is asserted by a test
so nothing here has to be taken on trust.

Measured on Node v24.12.0, against `origin/main` at `06f66a7`.

## The two defects, in one sentence each

**A routine that already existed started itself.** A block with no `enabled`
key read as enabled, so the first time Rundock ran over a workspace whose
routines were written by hand, all of them went live at once, next to the cron
jobs already doing the work.

**A routine that could never run looked ordinary.** `parseSchedule` accepts two
shapes and returns null for everything else, at which point the tick skips the
routine with no error, no warning and no log line. A cron-scheduled routine sat
in the Routines list looking exactly like a routine.

## AC-1 and AC-6: the upgrade drive, and the assertion that nothing fired

Five routines in agent frontmatter, each carrying a name, a schedule and a
prompt and nothing else, on a workspace with no run records and no stored
state. One control declares `enabled: true`. A real tick, past every one of
their times.

The control firing on the same tick is what makes the silence mean the gate
rather than a scheduler that was never going to run anything.

```
=== TICK 1: the upgrade, five routines that predate the scheduler ===
  [Scheduler] Not running routine: morning-briefing (briefer): enabled is false
  [Scheduler] Not running routine: nightly-sweep (sweeper): enabled is false
  [Scheduler] Not running routine: inbox-file (filer): enabled is false
  [Scheduler] Not running routine: weekly-review (reviewer): enabled is false
  [Scheduler] Not running routine: digest-post (poster): enabled is false
  [Scheduler] Running routine: ordinary-check (worker)
  [Scheduler] Routine "ordinary-check" completed (0s)
```

Asserted in `test/integration/scheduler-predating-routines.test.js`, in
"upgrading a workspace of routines that predate the scheduler starts none of
them". That test also asserts, before it drives anything, that none of the five
already carries a stored run: a routine suppressed by its own history would
give the same silence and prove nothing.

## AC-3: both frontmatter values, before and after

Three routines: one that says `enabled: true`, one that says `enabled: false`,
one that says nothing. Absent and false are the same to the scheduler and
different to the user, so the value somebody typed survives in both directions.

```
--- BEFORE (frontmatter routines block, as written) ---
routines:
  - name: wanted
    schedule: every day at 08:00
    prompt: p
    enabled: true
  - name: refused
    schedule: every day at 09:00
    prompt: p
    enabled: false
  - name: silent
    schedule: every day at 10:00
    prompt: p

--- AFTER the first read (same block on disk) ---
routines:
  - name: wanted
    schedule: every day at 08:00
    prompt: p
    enabled: true
    runOn: local
    paused: false
    planHash: c3f88dc0d0aa839c20055c16e2226daa829f691820abcab4dd7f003821e83a64
  - name: refused
    schedule: every day at 09:00
    prompt: p
    enabled: false
    runOn: local
    paused: false
    planHash: c3f88dc0d0aa839c20055c16e2226daa829f691820abcab4dd7f003821e83a64
  - name: silent
    schedule: every day at 10:00
    prompt: p
    runOn: local
    enabled: false
    paused: false
    planHash: c3f88dc0d0aa839c20055c16e2226daa829f691820abcab4dd7f003821e83a64

--- what the reader returns ---
wanted    enabled=true
refused   enabled=false
silent    enabled=false
```

`wanted` keeps the true it was written with. `refused` keeps its false. Only
`silent`, which never carried the key, is filled in. Asserted in
`test/unit/routine-model.test.js`, in "an enabled already in the file is
preserved at the value it was written as", which checks both the reader's
answer and the bytes on disk.

## AC-4: the unwritable-workspace run, with its result

The criterion that cannot be discharged by reading the migration, because the
hole it covers is the path where the migration does not persist. The agent file
is written and made read-only **before anything discovers it**, so its first
read is also the read that cannot record what it found.

```
=== TICK 2: the same, on a workspace that cannot be written to ===
  [migrate] routine persist failed: EACCES: permission denied, open '/tmp/claude-501/rundock-test-p5821-xTINtl/ws-ZAYocK/.claude/agents/frozen.md'
  [Scheduler] Running routine: ordinary-check (worker)
  [Scheduler] Not running routine: frozen-check (frozen): enabled is false

  file unchanged on disk after the run: true
```

Three things in that block together are the criterion: the migrating write
genuinely failed, the file is unchanged on disk, and the routine did not run
anyway. A fix applied only to the migration's fill value would leave this run
firing, because the value it writes never reaches the disk and the reader
answers instead.

Asserted in `test/integration/scheduler-predating-routines.test.js`, in "a
routine in a workspace that cannot be written to does not fire either", which
asserts the write failed before it asserts the routine did not run: a migration
that quietly succeeded would make that test a duplicate of the one above
wearing a different name.

**Driven twice, at two different calls.** Making one FILE read-only lets the
migration take its backup copy and fails on the final write. A read-only
DIRECTORY, which is what a read-only checkout actually is, fails one call
earlier, at the copy. Both land in the same catch and both leave the reader's
answer to do the work, but that was a claim about the migration's control flow
rather than something anything drove, so the second drive exists and asserts
the backup never appeared.

## The rendered rows, side by side

Five routines in one workspace, through real discovery to the real view. None
has ever run and none is failing, so the only thing separating these rows is
what stops each one running. Printed as the page carries them.

```
ROW: Every day at 7:00am, run: Not due yet
  next run        : "Next run: today, 7:00am, London time"
  schedule fault  : (none)
  offer           : (none)
  Turn on control : absent

ROW: Every day at 7:00am, run: Held back
  next run        : (none)
  schedule fault  : (none)
  offer           : "Not running. Turn it on and Rundock will start running it on this schedule. If today's time has already gone, it runs shortly after you turn it on."
  Turn on control : present

ROW: Cron briefing
  next run        : (none)
  schedule fault  : "Rundock cannot read this schedule, so this routine will not run. Change it to say every day at 07:00, or a weekday, like every Monday at 07:00."
  offer           : (none)
  Turn on control : absent

ROW: Cron and held back
  next run        : (none)
  schedule fault  : "Rundock cannot read this schedule, so this routine will not run. Change it to say every day at 07:00, or a weekday, like every Monday at 07:00."
  offer           : (none)
  Turn on control : absent

ROW: Every day at 7:00am, run: Paused and held back
  next run        : "Paused"
  schedule fault  : (none)
  offer           : (none)
  Turn on control : absent
```

**Each row says exactly one thing about whether it will run.** That is the rule
the rows are built to, and it is not free: a row is assembled from lines decided
independently, so any two of them can disagree.

- **Not due yet** promises a run and denies nothing.
- **Held back** denies one and offers to change that, and says when the first
  run would land, because a slot that has already gone today is caught up
  within the minute rather than waiting for tomorrow.
- **Cron briefing** and **Cron and held back** both name the fault that has to
  be fixed first and offer nothing, because turning either on would start
  nothing while the schedule cannot be read.
- **Paused and held back** says Paused and offers nothing, for the same reason.

The three rows that offer nothing are the rule working. The offer is made only
where turning it on is the ONLY thing between the routine and running, which is
the scheduler's own refusal order asked on the row's side.

Asserted in `test/unit/routines-end-to-end.test.js`, which drives frontmatter to
rendered row, and swept exhaustively in `test/unit/routines-model.test.js`: every
combination of seven row states is built and rendered, and any row carrying both
a line that promises a run and one that denies it fails, as does any row
explaining an absence by a cause that did not apply.

## Reproducing these

```
npm install
node --test test/integration/scheduler-predating-routines.test.js
node --test test/unit/routines-end-to-end.test.js
node --test test/unit/routine-model.test.js
node --test test/unit/routines-model.test.js
```

## The rule the rows are held to, and how far it was checked

A row can carry a line that PROMISES the routine will run (a next run, or the
offer) and a line that DENIES it (Paused, or the unreadable-schedule fault).
Every pair of those was checked rather than the one that was found:

- a next run and an unreadable schedule cannot co-occur: the model returns no
  next run for a schedule the scheduler could not parse, pinned by supplying an
  instant alongside an unreadable schedule so the guard is the thing tested
- a next run and the offer cannot co-occur: the model returns no next run for a
  routine that is not enabled
- a next run and Paused are the same field and mutually exclusive by
  construction
- the offer and any of Paused, an unreadable schedule, or a run target this
  release cannot run: the offer is now withheld on all three
- a run status and an unreadable schedule cannot co-occur, because a schedule
  that does not parse yields no run facts at all to report

A run status is deliberately neither kind of line: it reports the past, and the
row pairs it with the next run on purpose. What it can get wrong is its own
cause, which is the second rule: the missed line says Rundock was closed, and on
a routine nobody ever turned on that is untrue.

Both rules are swept over every combination of seven row states rather than the
pairs anyone thought to write down.

## What is deliberately not here

Accepting cron syntax. The row says what to change; teaching the parser cron is
a separate piece of work and stays there. Nothing in this change translates a
cron schedule at migration time either, which is why a cron-scheduled routine
survives an upgrade exactly as it was written.
