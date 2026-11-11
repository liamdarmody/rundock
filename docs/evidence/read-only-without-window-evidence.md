# The server answers a low-risk read itself: the mutation rows, red-first and the earlier definition

**This file is a dated record of runs on one machine, not a source of truth.**
Every claim below is re-measured by the named tests on every run of the
suite, by the mutation harness whenever it runs, and by `scripts/red-first.js`
whenever it is run. If this file and those ever disagree, they are right.

Taken on 2026-11-11 on macOS (Darwin 25.4.0, arm64) with Node 24.12.0, at
`ba555d8d`, the last commit to change code or tests; the commit after it adds
only this file. The merge base with `origin/main` is `bae4a2ef`. Each test and
mutation command ran with the Code-mode fixture folder set:
`RUNDOCK_TEST_OUTSIDE_TEMP_ROOT=<a folder outside every temp folder and git tree>`.

---

## The mutation rows

Nine rows in `test/tools/mutate-workspace-boundary-guards.js`, each against
`lib/http-router.js`, each run on its own at `ba555d8d`:

    node test/tools/mutate-workspace-boundary-guards.js --rows <n>:<n+1>

Every row runs `test/integration/read-only-without-window.test.js`, and every
row was caught: each turned at least one test in it red.

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

The row numbers are those of the harness at `ba555d8d`. Rows main adds to the
harness ahead of these move them.

## Red-first

    node scripts/red-first.js --repo <worktree> --tests "node --test --test-timeout=120000 <files>"

Run against `origin/main` at `bae4a2ef`, over every test file this change adds
or changes, leaving out the mutation harness and its cost table:

- `test/fixtures/bash-reads.js`
- `test/integration/attack/control-connection.test.js`
- `test/integration/http-api.test.js`
- `test/integration/local-origin.test.js`
- `test/integration/powershell-read-approvals.test.js`
- `test/integration/read-only-without-window.test.js`
- `test/integration/secret-reach-card.test.js`
- `test/integration/smoke-plan.test.js`
- `test/integration/zsh-pattern-saved-answer.test.js`
- `test/unit/answer-file-reads.test.js`
- `test/unit/answer-file-writes.test.js`
- `test/unit/doc-claims.test.js`
- `test/unit/permissions.test.js`
- `test/unit/sdlc-gate-hardening.test.js`
- `test/unit/workspace-boundary.test.js`

Outcome: **proven**. With the change, all 688 tests pass. With the 6 changed
source files put back to `origin/main` and the tests kept, 30 fail, among them
every test in `read-only-without-window.test.js` that expects the server to
answer a read, the doc-claims pin on the routines page, and "a plain listing
is answered by the server, with no card".

## The two lines the shared definition stopped reading

"a quoted option and a zsh glob qualifier's code wait for a card: the server
follows the shared definition" sends `rg '--pre' sh x .` and
`ls *(e:'echo x':)` with no window connected and holds each to a stored card
and a timeout, beside `rg sh x .` and `ls *.md`, which the server answers at
once.

To show the test fails on the definition this change was first written
against, it was run in an export of `ba555d8d` with `public/permissions.js`
and `public/read-only-shell.js` taken from `1485920c`, this branch before main
brought in the stricter definition (#432, #436, #438). Each line was run on
its own:

| Line | Graded at `1485920c` | Answer, at `ba555d8d` with that definition | Graded at `ba555d8d` |
|---|---|---|---|
| `rg '--pre' sh x .` | low | `{ allow: true, reason: 'read-only' }`, so the test fails | medium |
| `ls *(e:'echo x':)` | low | `{ allow: true, reason: 'read-only' }`, so the test fails | high |

At `ba555d8d` the test passes: both lines wait for a card and time out.

## The routines page's sentence on what still cards

The pin "the audit section, the routines page and the comments say it" in
`test/unit/doc-claims.test.js` holds the corrected sentences in
`docs/ROUTINES.md`: which crossings a standing folder grant answers with no
card, and what still raises a card. Run with the pin as at `ba555d8d`:

- against `docs/ROUTINES.md` at `54baeda3`, which still said anything the hook
  graded, a place outside the workspace first among them, raises a card, it
  fails with "the routines page says which crossings a standing folder grant
  answers with no card";
- against `docs/ROUTINES.md` at `ba555d8d`, it passes.

"and a standing folder grant answers only the crossings the routines page
says, with no card", beside it, checks that the tools the page names are the
hook's file tools, that a shell command's crossing is never grantable, and
that a router with a folder granted answers a file tool's crossing into it
with no card, while the same place reached by a shell command, and a place the
grant does not cover, wait for a card.
