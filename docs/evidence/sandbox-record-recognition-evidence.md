# The sandbox block is recognised whichever way of running Rundock wrote it: red on main, and the settings parity run

**This file is a dated record of runs on one machine, not a source of truth.**
Every claim below is re-measured by the named tests on every run of the
suite. If this file and those tests ever disagree, the tests are right.

Taken on 2026-11-13 on macOS (Darwin 25.4.0, arm64) with Node 24.12.0. The
merge base is `c6e74ed2`. Every run below was taken at `1cf03b34`, the last
commit to change code or tests; the commit after it adds only this file.

---

## What changed

`isRundockSandbox` (`lib/workspace/scaffold.js`) decides whether a sandbox
block in `.claude/settings.local.json` is Rundock's by rebuilding it for the
block's own claimed workspace and home and comparing. Since the shell startup
file guard, the rebuilt deny list names Rundock's record of the startup files
at `exposureRecordPath()`, which is `<home>/.rundock-startup-file-exposure.json`
in the desktop app and `<checkout>/.startup-file-exposure.json` from source. A
block written by the other way of running differed in that one entry and read
as a person's edit. `recordAsWritten` now carries the block's own entry into
the rebuilt block, at the same position, when it is joined the way either
writes it.

## On main, before the change

A scratch script built the block with `sandboxSettings` with and without
`RUNDOCK_ELECTRON` set, and asked `isRundockSandbox` with and without it:

| Written by | Read by a source run | Read by the app |
|---|---|---|
| a source run | true | false |
| the app | false | true |

## Red first

`node scripts/red-first.js --tests "node --test test/unit/sandbox-settings.test.js"`,
against `origin/main` (`c6e74ed2`):

- Outcome: proven. The tests fail without the change and pass with it.
- With the change: 45 passed.
- Without the change (the source restored, the tests kept): 15 failed.

The 15 tests that failed without the change, in the two groups the record
also lists as failing with them ("the record of the startup files, in either
spelling" and "the record of the startup files, through the reconcile"):

- the app recognises a block a source run wrote, on and off
- the inverse action: a source run recognises a block the app wrote, on and off
- a block another checkout wrote is recognised, by a source run and by the app
- another deny entry changed is still a person's edit
- the record entry moved to another position is a person's edit
- a relative record entry is a person's edit
- the app's record name in a folder other than the block's home is a person's edit
- a record entry with any other file name is a person's edit
- a record entry not spelled the way a path is joined is a person's edit
- a record entry that is not a string is a person's edit, and nothing throws
- an earlier deny list that carries the record is recognised in either spelling too
- the next write uses this run's record path, and this run then recognises the block byte for byte
- the undo: a block a source run wrote, rewritten by the app, then read by a source run again, is recognised at each step
- the retry: recognising the same block twice gives the same answer and changes nothing
- the most common next step: switching Notes and Code after recognition writes the right shape and keeps the switch Rundock's

The refusal tests fail without the change on their first assertion, which
checks that the unchanged block from the other way of running is recognised
before changing one thing in it. The two tests that pass on both sides do so
by design: the earlier shapes without the record are recognised exactly as
before, and a deny list that is not an array, holds `null` or holds a very
long string is recognised by neither.

Reverting proves the tests notice this change. It cannot prove they assert
the right thing: a test can discriminate a fix and still measure a proxy.

## The settings parity run

`npm run test:settings:electron`, outside the sandbox, Electron 42.9.3 and
Chromium 149.0.7827.55. It builds each block in the test process, from
source, and reads the Permissions row in the desktop app and in a browser:

| Case | Match |
|---|---|
| Rundock's block on | true |
| Rundock's block off | true |
| off, with the project's settings turning it on | true |

`"failures": []`, `"pass": true`. Before the change the same command failed all
three cases: the app showed the switch as locked, set up outside Rundock.

## The mutation rows

Twelve rows in `test/tools/mutate-workspace-boundary-guards.js` break the new
check one part at a time: each spelling refused, each refusal loosened, a path
not joined as Rundock joins one, the guard on a deny list that is not an array,
the latitude for an earlier list, and recognition changing the block it reads.
Run with `--rows` over those twelve, each turned at least one test red.
