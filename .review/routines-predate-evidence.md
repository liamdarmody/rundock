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

## AC-8 and AC-9: the rendered output for both rows, side by side

Three routines in one workspace, through real discovery to the real view. All
three are unpaused and none has ever run. Printed as the page carries them.

```
ROW: Every day at 7:00am, run: Not due yet
  rendered text : ★Every day at 7:00am, run: Not due yetPiper·Runs on this computer·Next run: today, 7:00am, London time
  .next-run     : "Next run: today, 7:00am, London time"
  .schedule-problem : (none)
  .rr-offer-text    : (none)

ROW: Every day at 7:00am, run: Held back
  rendered text : ★Every day at 7:00am, run: Held backPiper·Runs on this computerNot running. Turn it on and Rundock will start running it on this schedule.Turn on
  .next-run     : (none)
  .schedule-problem : (none)
  .rr-offer-text    : "Not running. Turn it on and Rundock will start running it on this schedule."

ROW: Cron briefing
  rendered text : ★Cron briefingPiper·Runs on this computerRundock cannot read this schedule, so this routine will not run. Change it to say every day at 07:00, or a weekday, like every Monday at 07:00.
  .next-run     : (none)
  .schedule-problem : "Rundock cannot read this schedule, so this routine will not run. Change it to say every day at 07:00, or a weekday, like every Monday at 07:00."
  .rr-offer-text    : (none)

```

The three rows are told apart by their words, not only by a class:

- **Not due yet** carries a next run and no complaint.
- **Held back** carries the offer, and no next run, because a routine that will
  not run must not advertise when it will.
- **Cron briefing** says the schedule cannot be read and names both shapes that
  work, and carries no next run either.

Asserted in `test/unit/routines-end-to-end.test.js`, in "the unreadable row is
distinguishable from one that is simply not due yet" and "a cron schedule
reaches the row saying it will not run, and what to change". Both drive
frontmatter to rendered row, which is the only place the claim can be proven:
the judgement is the scheduler's grammar, the fact travels on the roster, and
the words are the model's, so a test at any one of those three would pass while
the row still drew as ordinary.

## Reproducing these

```
npm install
node --test test/integration/scheduler-predating-routines.test.js
node --test test/unit/routines-end-to-end.test.js
node --test test/unit/routine-model.test.js
```

## What is deliberately not here

Accepting cron syntax. The row says what to change; teaching the parser cron is
a separate piece of work and stays there. Nothing in this change translates a
cron schedule at migration time either, which is why a cron-scheduled routine
survives an upgrade exactly as it was written.
