# The failed-switch rollback, observed

What the harness reports when it takes the failed-switch rollback apart a step at a time. Recorded because a note saying the harness ran does not say what it found, and the guard it deletes is a whitespace-sensitive string in a file that a reader of the change alone never sees.

Reproduce with:

```
node test/tools/mutate-workspace-rollback-guards.js --markdown
```

Observed on the tree this file is committed in, against `lib/protocol/handlers/workspace.js`:

| Guard broken | Places found | Tests red | Which |
|---|---|---|---|
| the rollback re-arms the file-tree poll against the workspace that survived | 1 | 1 | `the workspace that survived is quiet, because the rollback re-baselined the poll` |
| the rollback puts the previous root back | 1 | 4 | `the failure is real, and the server says so and stays where it was`<br>`an external write to the restored workspace is still detected`<br>`the scheduler is running, and against the workspace that survived`<br>`a requested tree describes the workspace that survived` |
| a switch that could not complete says so | 1 | 1 | `the failure is real, and the server says so and stays where it was` |

## What the two columns are for

**Places found** is one for every guard. The harness refuses to mutate a search text that matches more than once, because replacing the first occurrence would break whichever code came first and prove nothing about either. One is what says the guard was addressed rather than approximated.

**Tests red** names the test that went red for each deletion. The first row is the one this file exists for: deleting the re-arm leaves the poll baselined against the workspace that failed to open, and the quiet test is what notices.

## What this record cannot do

It is a reading taken at one moment, and a file cannot keep itself true. What keeps it true is that the harness runs inside the commit gate on every change, so a guard that stops being addressed exactly once, or a deletion that stops turning anything red, fails the gate rather than quietly disagreeing with this page.

One step of the rollback is deliberately not mutated, and the harness records that as a named gap rather than a passing row. Every cache it clears is bounded by the same two second time to live, and the tree cache it also clears is cleared again by the arming call on the next line, so a test of it would be a race against a timer that passes whenever the machine runs slow.
