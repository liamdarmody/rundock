# The server applies a saved "Always allow" itself: the mutation rows, red-first and the hook's grades

**This file is a dated record of runs on one machine, not a source of truth.**
Every claim below is re-measured by the named tests on every run of the
suite, by the mutation harness whenever it runs, and by `scripts/red-first.js`
whenever it is run. If this file and those ever disagree, they are right.

Taken on 2026-11-11 on macOS (Darwin 25.4.0, arm64) with Node 24.12.0, at
`d644d28d`, the last commit to change code or tests; the commit after it adds
only this file. The merge base with `origin/main` is `3017ad72`. Each mutation
command ran with the Code-mode fixture folder set:
`RUNDOCK_TEST_OUTSIDE_TEMP_ROOT=<a folder outside every temp folder and git tree>`.

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

## Red-first

    node scripts/red-first.js --repo <worktree> --tests "node --test --test-timeout=120000 <files>"

Run against `origin/main` at `3017ad72`, over the test files this change adds
or changes that run as tests:

- `test/integration/read-only-without-window.test.js`
- `test/integration/saved-answers-without-window.test.js`
- `test/unit/doc-claims.test.js`

The change also adds `test/helpers/permission-route.js` and changes the stub
`test/helpers/stub-claude/claude`. Both are kept in place with the tests when
the source is put back, and neither is a test file `node --test` can run: the
stub is the runtime binary the suites spawn.

Outcome: **proven**. With the change, all 169 tests pass. With the 7 changed
source files put back to `origin/main` and the tests kept, 19 fail, all in
`saved-answers-without-window.test.js` and the two doc-claims pins on the
server's answers. None fails in `read-only-without-window.test.js`, whose
behavior this change keeps: run on the old router, it passes.

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
