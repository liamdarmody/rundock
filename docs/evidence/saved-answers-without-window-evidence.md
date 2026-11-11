# The server applies a saved "Always allow" itself: the mutation rows, red-first and the hook's grades

**This file is a dated record of runs on one machine, not a source of truth.**
Every claim below is re-measured by the named tests on every run of the
suite, by the mutation harness whenever it runs, and by `scripts/red-first.js`
whenever it is run. If this file and those ever disagree, they are right.

Taken on 2026-11-11 on macOS (Darwin 25.4.0, arm64) with Node 24.12.0. The
last commit to change code is `629b6be5`; the commits after it add tests
only, up to `916e861d`, and the commit after that changes only this file. The
merge base with `origin/main` is `96ce74e1`. Each mutation command ran with
the Code-mode fixture folder set:
`RUNDOCK_TEST_OUTSIDE_TEMP_ROOT=<a folder outside every temp folder and git tree>`.

The first section records the change as it stands. The sections after it
record the change as it stood at `d644d28d` and `5ff93210`, before the
faults in the first section were fixed; their row numbers and counts are superseded by the
tables in the first section.

---

## Four faults, each fixed in its own commit

Four faults were found in the change as it stood at `189d9bd7`. Each is
fixed in its own commit, with a test that failed before it. The first two
were measured by `scripts/red-first.js` against the commit before each, the
third, which adds tests only, against `origin/main`, and the fourth, a
Playwright spec red-first cannot run here, by hand against `origin/main`.

### 1. A planted key was carried into a person's save or revoke (`4662bc1d`)

`addToolAllow`, `removeToolAllow` and `addBoundaryGrant` merged
`.rundock/permissions.json` as it stood on disk and recorded the result as
Rundock's own write. A key a script had added between two of the guard's
checks was written back with the person's next save or revoke, taken into the
guard's baseline at the next check, and answered from then on.

Every writer now builds on `answerFileToBuildOn` in
`lib/workspace/answer-file-guard.js`: with a turn watching, the guard's check
runs first and the write builds on the baseline; with a guard holding the
file and no turn watching, the disk is built on only if it is the baseline or
Rundock's own last write, and anything else is left out with a log line; with
no guard holding the file, the disk, which the first turn's guard takes as
its baseline in any case.

An idle guard (one that holds the file with no turn running) also builds on
the baseline rather than the disk. A script running between turns could
otherwise plant a key that the next save would carry in. The cost is that a
hand edit to the file made between turns is replaced by the next save or
revoke without a put-back card; it is named in the log.

Failing first, in `test/integration/saved-answers-without-window.test.js`:

- a key planted before the person saves another is never carried into the
  save: its command cards and times out;
- a key planted before the person revokes another is never carried into the
  revoke: its command cards and times out.

Both plant `Bash:node` mid-turn, then save `Bash:python3` (or revoke
`Bash:echo`) through the window's message, then send `node scripts/build.js`
(medium, under `Bash:node`) with no window. Before the fix both failed on the
first assertion after the save, "the planted key answered it". The doc-claims
pin drives the same through the router, and `ARCHITECTURE.md` says what a
writer builds on.

Red-first against `189d9bd7` (its parent): **proven**. With the change, 143 tests pass in
the two files run (`saved-answers-without-window.test.js`,
`doc-claims.test.js`); without it, 4 fail: the two above and two doc-claims
pins.

### 2. Saved answers came from the open workspace, not the request's (`629b6be5`)

A switch never ends a routine, so a run started in one workspace could ask
after another was opened, and was answered from the other's saved keys.

Each request is now bound to its own workspace (`requestWorkspace` in
`lib/http-router.js`): a routine run's is the folder it started in, which
`runById` now returns from the live run; a conversation's is the workspace
whose guard holds its turn (`workspaceOfTurn`); with neither known, no saved
answer applies. A card and its replay still name only the run, the routine
and the agent.

Failing first, in the new `test/integration/saved-answers-workspace.test.js`:
a routine started in one workspace and held, a switch to a second, a turn
guarded there and `Bash:python3` saved there, then the run let go: its
`python3 tools/report.py` must card and time out, and the run counts the
refused card. Before the fix the hook answered it allow. The inverse, a run
started in the open workspace, is answered from that workspace's key.
`permission-ownership.test.js` now expects the run's folder from `runById`,
and the doc-claims pin checks that another conversation's guarded turn does
not bind this one.

Red-first against `4662bc1d`: **proven**. With the change, 153 tests pass in
the four files run; without it, 4 fail: the switch test, the
`runById` shape, and two doc-claims pins.

### 3. No test ran the real hook in Code mode (`e19fe2b1`)

The new `test/integration/saved-answers-code-mode.test.js` runs
`scripts/permission-hook.js` in Code mode against the Code-mode fixture's
repository (origin's default branch `main`, current branch `feat/x`), with
the server open on that workspace, no window, and a turn guarded for the
conversation the hook's token names. `decidePermission` is wrapped so the
decision the router makes is recorded as it makes it.

- With `Bash:git-push:default-branch` saved, `git push origin main` is
  allowed at once; the recorded decision is the hook's verdict
  `asks-once` under that rule, the rule as the key, and
  `{ action: 'allow', reason: 'always-allowed' }`.
- With only `Bash:git` saved, the same push cards and times out; the
  recorded decision is `{ action: 'card' }` on the same verdict.

Red-first against `origin/main` (`96ce74e1`): **proven**. With the change, 2
pass; without it, both fail (on main the server makes no decision of its own,
so there is none to record).

### 4. No test pressed the real "Always allow" (`26012cec`)

The new Playwright spec `test/e2e/always-allow-without-window.spec.js` raises
a routine's medium card in the approvals dock, presses its own "Always allow"
button, closes the page, and only then lets the agent on to a second command
under the same key. The E2E setup could raise a routine's card, so no jsdom
fallback was needed.

Red-first cannot run a Playwright spec here, so the red run was made by hand:
the six source files the branch changes put back to `origin/main`
(`96ce74e1`), the spec kept, the spec run, the files restored from `HEAD`.

| Source | Result | Second command | Server log | Run |
|---|---|---|---|---|
| this branch | 1 passed (3.2s) | allow | "Always allowed, answered without a card" | completed in 1s |
| `origin/main` | 1 failed (10.2s) | deny | "Auto-denied (timeout)" | completed in 8s |

In both runs the log shows the window's allow for the first request, the
key saved, and the window disconnecting before the second request.

### A guard the binding left untested (`916e861d`)

With saved answers bound to the request's workspace, a conversation with no
guarded turn has no workspace at all, so the test that asked as a
conversation with no turn running failed closed before the guard's watch was
checked. Row 1151, which drops that check, turned nothing red in a run at
`26012cec`. A routine run's workspace comes from its record instead, so the
new test asks as a live run in this workspace with its own token: answered
while a turn is guarded there, carded and timed out once none is. Row 1151
was then run again on its own and caught.

### Mutation rows

All 21 rows on the server's answers in
`test/tools/mutate-workspace-boundary-guards.js`, with the row numbers at
`916e861d`. Six are new in this section (1155 to 1160). Four existing rows
quoted `savedAnswers()` and one quoted `boundaryPermissionsPath()`; they now
quote the code as it reads, and row 1153's mutant keeps the workspace so it
breaks only what it names.

The saved-answer rows, run at `916e861d`:

    node test/tools/mutate-workspace-boundary-guards.js --rows 1149:1161

| Row | Label | Suite | Tests red | Which |
|---|---|---|---|---|
| 1149 | Saved answer: the saved set is read without the guard's check | `saved-answers-without-window.test.js` | 10 | a conversation's medium command under a saved key is answered at once: no card, nothing stored to wait; a routine run's medium commands under a saved key are answered at once, through the real hook, and its record counts none of them; a key written straight to the file between two of the guard's checks is put back before the request is answered, and the request cards; a key written again just after the check, as a script rewriting the file in a loop would, is never applied; the guard's check throwing; the read throwing; a saved rule answers a push to the default branch with no window; a saved Bash:git never answers an Asks once; a file pattern that runs code waits for a card under a saved Bash:ls; rg --pre is answered under a saved Bash:rg, exactly as the window answers it; 2. the undo: once the person revokes the saved answer, the next matching request cards |
| 1150 | Saved answer: the saved set is read from the file as it stands after the check | `saved-answers-without-window.test.js` | 2 | a key written again just after the check, as a script rewriting the file in a loop would, is never applied; the read throwing |
| 1151 | Saved answer: saved answers apply on a workspace no turn's guard watches | `saved-answers-without-window.test.js` | 1 | a routine run in a workspace no turn's guard watches gets no saved answer, though its record names the workspace |
| 1152 | Saved answer: a saved answer is applied when the check or the read throws | `saved-answers-without-window.test.js` | 2 | the guard's check throwing; the read throwing |
| 1153 | Saved answer: a saved key answers a high-risk request | `saved-answers-without-window.test.js` | 4 | a high-risk command under a saved `Bash:python3` waits for a card and times out, as on main; a file pattern that runs code waits for a card under a saved Bash:ls; every row of the tables, with its own key saved: the server answers exactly what the window allows, and cards the rest; 1. the inverse action: in one routine run under a saved Bash:python3, a medium python3 command is answered and a high-risk one right after it waits and times out |
| 1154 | Saved answer: the verdict is dropped from the decision | `saved-answers-without-window.test.js` | 4 | a Notes-mode Keychain line under a saved `Bash:security` waits for a card and times out, as on main; a request carrying an Always-asks verdict cards under a saved key that answers its command; a saved rule answers a push to the default branch with no window; a saved Bash:git never answers an Asks once; an Always-asks verdict cards under every saved key |
| 1155 | Saved answer: a save or revoke merges the permissions file as it stands on disk | `saved-answers-without-window.test.js` | 2 | a key planted before the person saves another is never carried into the save: its command cards and times out; a key planted before the person revokes another is never carried into the revoke: its command cards and times out |
| 1156 | Saved answer: the workspace check is dropped, so the open workspace answers every request | `saved-answers-workspace.test.js` | 1 | a routine started in one workspace and still running after a switch is answered from its own saved answers, never the open one's: it cards and times out |
| 1157 | Saved answer: a live run does not name the folder it started in | `saved-answers-workspace.test.js` | 1 | the inverse: a routine started in the open workspace is answered from that workspace's saved answers, with no window |
| 1158 | Saved answer: a conversation is bound by any turn in the workspace, not its own | `doc-claims.test.js` | 1 | and the server does it: a router with no window applies a saved key while a turn is guarded, never a key planted before a save, and nothing once no turn is guarded |
| 1159 | Saved answer: a binary key answers an Asks-once | `saved-answers-code-mode.test.js` | 1 | with only the binary key Bash:git saved, the same push cards and times out: the key every git command shares never answers an Asks-once |
| 1160 | Saved answer: a save or revoke builds on the file without the guard's check first | `saved-answers-without-window.test.js` | 2 | a key planted before the person saves another is never carried into the save: its command cards and times out; a key planted before the person revokes another is never carried into the revoke: its command cards and times out |

The read-only rows, run at `26012cec` (neither their suite nor their target
changed after it):

    node test/tools/mutate-workspace-boundary-guards.js --rows 1140:1149

| Row | Label | Suite | Tests red | Which |
|---|---|---|---|---|
| 1140 | Read-only answer: a crossing out of the workspace is answered with no card | `read-only-without-window.test.js` | 3 | an uncovered crossing waits for a card and times out, as before; a secrets-tier path waits for a card and times out, as before; a request carrying `boundary` cards even when its command reads |
| 1141 | Read-only answer: an answer-file write is answered with no card | `read-only-without-window.test.js` | 1 | a request carrying `answer_file` cards even when its command reads |
| 1142 | Read-only answer: a shell startup file is answered with no card | `read-only-without-window.test.js` | 1 | a request carrying `startup_file` cards even when its command reads |
| 1143 | Read-only answer: a Keychain line or any other verdict is answered with no card | `read-only-without-window.test.js` | 1 | a request carrying `code_mode_verdict` cards even when its command reads |
| 1144 | Read-only answer: a medium command is answered as a read | `read-only-without-window.test.js` | 7 | a medium command waits for a card and times out, as before; a quoted option and a zsh glob qualifier's code wait for a card: the server follows the shared definition; every row of the tables: the server answers exactly what the window allows, and cards the rest; a hook token answers no card: not over a socket, wherever it is offered, and not over HTTP; 1. the inverse action: in one routine run, a read is answered at once and a medium command right after it waits and times out; 2. the undo: a person denies a card for a write, and the next plain read is answered at once; 4. the most common next step: a window that connects while a card waits is sent it, and the reads after are answered without reaching it |
| 1145 | Read-only answer: a request that cannot be graded is allowed | `read-only-without-window.test.js` | 5 | classifyRisk throwing; decidePermission throwing; the module failing to load; a conversation's read: the window allows it with no card; a routine run's read: the window allows it from the approvals dock's branch, with no card |
| 1146 | Read-only answer: a read with no token, or one Rundock never issued, is answered | `read-only-without-window.test.js` | 1 | a read whose token names nothing going is refused, and given no allow |
| 1147 | Read-only answer: a read whose token names no run going is answered | `read-only-without-window.test.js` | 1 | a read whose token names nothing going is refused, and given no allow |
| 1148 | Read-only answer: a read whose run ended before its body arrived is answered | `read-only-without-window.test.js` | 5 | a routine run's reads are answered at once, through the real hook, and its record counts none of them; a read whose routine run ended before its body arrived is refused as before, with no allow; the event log records the allow with its reason, and the server log has one line for it; 1. the inverse action: in one routine run, a read is answered at once and a medium command right after it waits and times out; 3. the retry: the same read sent twice is answered at once both times, and recorded twice |

Every row was caught. One other row in the harness runs a test file this
section changes, `test/integration/permission-ownership.test.js`: row 767,
"Request id: a hook request is named by the time and a predictable suffix",
run at `916e861d` and caught (1 red). Every row in every harness whose target
is one of the source files changed here was checked to find its guard text
exactly once at `916e861d` (271 rows).

### Red-first for the whole change

Run at `916e861d` against `origin/main` (`96ce74e1`), over every test file
the change adds or changes that runs as a test:

- `test/integration/permission-ownership.test.js`
- `test/integration/read-only-without-window.test.js`
- `test/integration/saved-answers-code-mode.test.js`
- `test/integration/saved-answers-without-window.test.js`
- `test/integration/saved-answers-workspace.test.js`
- `test/unit/doc-claims.test.js`

Outcome: **proven**. With the change, all 185 tests pass. With the changed
source files put back to `origin/main` and the tests kept, 27 fail, all in
the saved-answer suites, the run attribution test and the doc-claims pins.
None fails in `read-only-without-window.test.js`.

### Seen while fixing, left as they are

- Every `permission` event is written to the open workspace's log
  (`recordEvent` in `lib/signals.js`), so a routine's outcome after a switch
  lands in the other workspace's log. The switch test reads both.
- A folder grant (`crossingCovered`) and the window's own read of the saved
  keys (`sendToolAllows`, `get_tool_allows`) still read the file on disk.

---

## The mutation rows

Fifteen rows in `test/tools/mutate-workspace-boundary-guards.js`, each against
`lib/http-router.js`, run at `d644d28d` in two runs, one per suite:

    node test/tools/mutate-workspace-boundary-guards.js --rows 1149:1155
    node test/tools/mutate-workspace-boundary-guards.js --rows 1140:1149

Every row was caught: each turned at least one test in its suite red.

### New rows: the saved answers

Each runs `test/integration/saved-answers-without-window.test.js`.

| Row | Label | Tests red | Which |
|---|---|---|---|
| 1149 | Saved answer: the saved set is read without the guard's check | 13 | a conversation's medium command under a saved key is answered at once: no card, nothing stored to wait; a routine run's medium commands under a saved key are answered at once, through the real hook, and its record counts none of them; what cards ahead of a saved answer still cards with no window; a key written straight to the file between two of the guard's checks is put back before the request is answered, and the request cards; a key written again just after the check, as a script rewriting the file in a loop would, is never applied; the guard's check throwing; the read throwing; a saved rule answers a push to the default branch with no window; a saved Bash:git never answers an Asks once; a file pattern that runs code waits for a card under a saved Bash:ls; rg --pre is answered under a saved Bash:rg, exactly as the window answers it; every row of the tables, with its own key saved: the server answers exactly what the window allows, and cards the rest; the sequences 2 and 4 |
| 1150 | Saved answer: the saved set is read from the file as it stands after the check | 2 | a key written again just after the check, as a script rewriting the file in a loop would, is never applied; the read throwing |
| 1151 | Saved answer: saved answers apply on a workspace no turn's guard watches | 2 | with no turn's guard watching the workspace, no saved answer applies; rg --pre is answered under a saved Bash:rg, exactly as the window answers it |
| 1152 | Saved answer: a saved answer is applied when the check or the read throws | 2 | the guard's check throwing; the read throwing |
| 1153 | Saved answer: a saved key answers a high-risk request | 4 | a high-risk command under a saved `Bash:python3` waits for a card and times out, as on main; a file pattern that runs code waits for a card under a saved Bash:ls; every row of the tables, with its own key saved: the server answers exactly what the window allows, and cards the rest; the sequence 1 |
| 1154 | Saved answer: the verdict is dropped from the decision | 4 | a Notes-mode Keychain line under a saved `Bash:security` waits for a card and times out, as on main; a request carrying an Always-asks verdict cards under a saved key that answers its command; a saved rule answers a push to the default branch with no window; a saved Bash:git never answers an Asks once; an Always-asks verdict cards under every saved key |

Row 1149 turns more red than its label suggests because the guard's check is
also what takes Rundock's own write of a saved key into the baseline: skip it,
and a key the person saved through the window never reaches the set the server
reads either.

The new suite had no rows before this change, so these rows carry no cost by
label in `mutation-costs.json` and are planned at the harness's rate until CI
has timed them.

### Updated rows: the low-risk read

Each runs `test/integration/read-only-without-window.test.js`. These rows
existed before this change; they now break the code as it reads after it.

| Row | Label | Tests red | Which |
|---|---|---|---|
| 1140 | Read-only answer: a crossing out of the workspace is answered with no card | 3 | an uncovered crossing waits for a card and times out, as before; a secrets-tier path waits for a card and times out, as before; a request carrying `boundary` cards even when its command reads |
| 1141 | Read-only answer: an answer-file write is answered with no card | 1 | a request carrying `answer_file` cards even when its command reads |
| 1142 | Read-only answer: a shell startup file is answered with no card | 1 | a request carrying `startup_file` cards even when its command reads |
| 1143 | Read-only answer: a Keychain line or any other verdict is answered with no card | 1 | a request carrying `code_mode_verdict` cards even when its command reads |
| 1144 | Read-only answer: a medium command is answered as a read | 7 | a medium command waits for a card and times out, as before; a quoted option and a zsh glob qualifier's code wait for a card: the server follows the shared definition; every row of the tables: the server answers exactly what the window allows, and cards the rest; a hook token answers no card: not over a socket, wherever it is offered, and not over HTTP; the sequences 1, 2 and 4 |
| 1145 | Read-only answer: a request that cannot be graded is allowed | 5 | classifyRisk throwing; decidePermission throwing; the module failing to load; a conversation's read: the window allows it with no card; a routine run's read: the window allows it from the approvals dock's branch, with no card |
| 1146 | Read-only answer: a read with no token, or one Rundock never issued, is answered | 1 | a read whose token names nothing going is refused, and given no allow |
| 1147 | Read-only answer: a read whose token names no run going is answered | 1 | a read whose token names nothing going is refused, and given no allow |
| 1148 | Read-only answer: a read whose run ended before its body arrived is answered | 5 | a routine run's reads are answered at once, through the real hook, and its record counts none of them; a read whose routine run ended before its body arrived is refused as before, with no allow; the event log records the allow with its reason, and the server log has one line for it; the sequences 1 and 3 |

Row 1143 used to drop `code_mode_verdict` from the graded fields. The verdict
is no longer a graded field: it goes to `decidePermission` as the window
passes it. So the row now drops it from that call, which is what would answer
a Keychain line as a read.

The row numbers are those of the harness at `d644d28d`. Rows main adds to the
harness ahead of these move them.

### At the fix commit

`5ff93210` changes only `test/unit/doc-claims.test.js`, which none of the
fifteen rows above runs, so their results stand at `d644d28d`. Five rows
elsewhere in the harnesses do run that file, so each was run again on its own
at `5ff93210`, and each was caught:

| Harness | Row | Label | Tests red |
|---|---|---|---|
| `mutate-routines-guards.js` | 328 | the tick never reads a routine's declared zone | 1 |
| `mutate-routines-guards.js` | 329 | a row's next run never reads a routine's declared zone | 1 |
| `mutate-stale-session-guards.js` | 93 | the page's claim of one line per failed write holds for the Codex start path with no log of its own | 1 |
| `mutate-workspace-boundary-guards.js` | 958 | Unnamed request: the page says it is refused when it is not | 1 |
| `mutate-workspace-boundary-guards.js` | 1060 | On failure: the value the doc quotes is not the value written | 1 |

## Red-first

    node scripts/red-first.js --repo <worktree> --tests "node --test --test-timeout=120000 <files>"

Run against `origin/main` at `3017ad72`, first at `d644d28d` and again at
`5ff93210`, over the test files this change adds or changes that run as tests:

- `test/integration/read-only-without-window.test.js`
- `test/integration/saved-answers-without-window.test.js`
- `test/unit/doc-claims.test.js`

The change also adds `test/helpers/permission-route.js` and changes the stub
`test/helpers/stub-claude/claude`. Both are kept in place with the tests when
the source is put back, and neither is a test file `node --test` can run: the
stub is the runtime binary the suites spawn.

Outcome: **proven** at both commits, with the same counts. With the change, all
169 tests pass. With the changed source files put back to `origin/main` and the
tests kept (7 at `d644d28d`; 8 at `5ff93210`, this file among them), 19 fail,
all in `saved-answers-without-window.test.js` and the two doc-claims pins on
the server's answers. None fails in `read-only-without-window.test.js`, whose
behavior this change keeps: run on the old router, it passes.

## The doc-claims fix: a home of its own for the pin's guard

At `7144647e` the doc-claims file failed in CI under `npm test` and
`npm run test:coverage` though every test in it passed. The pin "and the
server does it: a router with no window applies a saved key while a turn is
guarded, and nothing once none is" holds a turn on the answer-file guard, and a
turn's guard watches the home folder's shell startup files and Rundock's record
beside them. The pin ran with the test process's own home, so it pointed the
guard at the account's startup files and at the record in the checkout. The
test preload `test/helpers/account-home-refused.js`, which every npm test
script loads, refused each of them, so none was watched, and set the exit code,
so the file failed. Run on its own without that preload, as it had been here,
the file passed.

`5ff93210` gives the guard a made-up home for that test only, as
`test/helpers/made-up-home.js` gives a whole file one: `HOME` in a temp
folder, `RUNDOCK_ELECTRON=1` so the record lies under it too, and no `ZDOTDIR`
or `XDG_CONFIG_HOME`, all four put back once the turn is released. Run at
`5ff93210` the way CI loads it:

    node --test --require ./test/helpers/account-home-refused.js test/unit/doc-claims.test.js

114 tests, 114 pass, no path refused, exit 0. The same command at `7144647e`
exited 1, naming the account's startup files.

## The hook's grades for the requests the suite sends

The suite sends requests through the real permission hook and also, where a
grade alone is the point, straight to the router. To check that the fields
those direct requests carry are the ones the hook really sends, the hook was
run at `d644d28d` (`scripts/permission-hook.js` is unchanged by this change)
against a server that records each request body:

| Request | What the hook sent besides the tool and its input |
|---|---|
| `python3 <outside>/notes.py` | `boundary: true`, `grantable: false`, its crossing |
| `python3 tools/report.py` | nothing graded |
| `echo x >> ~/.zshrc` | `startup_file`, `boundary: true`, a crossing with `answerFile: true` |
| `echo '{}' > .rundock/permissions.json` | `boundary: true`, a crossing with `answerFile: true` |
| Write to `.rundock/permissions.json` | `answer_file: true` |
| Write to a file in the workspace | not sent: the hook allows it itself |
| `security find-generic-password -w -s example-service` | `code_mode_verdict: { verdict: 'always-asks', reason: 'keychain' }` |
| `python3 tools/report.py && rm -rf build` | nothing graded: it is carded as high risk by `decidePermission` |

A Notes-mode Keychain line carries a verdict and no place grade, which is why
the verdict, not the graded fields, is what keeps it carding under a saved
`Bash:security`.
