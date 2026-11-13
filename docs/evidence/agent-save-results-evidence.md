# The next turn is told what Rundock did with an agent's save, delete or refusal: red first and deliberate breaks

**This file is a dated record of runs on one machine, not a source of truth.**
Every claim below is re-measured by the named tests on every run of the
suite. If this file and those tests ever disagree, the tests are right.

Taken on 2026-11-13 on macOS with Node 24.12.0 and Playwright 1.61.1. The
branch starts from `d9add8d5`. Its commits:

- `b6464311`: the first tests only, against the code as it was at `d9add8d5`
  (`test/integration/team-notes.test.js`, `test/unit/team-notes.test.js`).
- `f4a11ff5`: the outcomes kept for the next turn and the note's wording
  (`lib/agents/team-notes.js`, `teamOutcomeNote` and its heading in
  `lib/delegation/catch-up.js`); the conversation record carries them and a
  window never receives them; another agent's catch-up leaves the stored line
  out.
- `174724f1`: a Claude Code agent's next turn is told (the stdin wrapper set
  at spawn in `server.js`, the engine keeping each turn's outcomes, and a
  refused resume putting them back).
- `2092941d`: a Codex agent's next turn is told (`lib/runtime/codex-glue.js`).
- `41ac96de`: the line a person reads is stored once in the conversation's
  history and kept with its own conversation on the page. **The final code
  commit.** The commits after it change tests, docs and this file only.
- `3b18aaff`: the restart, injection and fail-closed tests.
- The commit that adds this file: the browser test and `ARCHITECTURE.md`.

## The defect

An agent never learned whether its save worked. Rundock decides an agent's
`SAVE_AGENT`, `CREATE_AGENT`, `DELETE_AGENT`, `SAVE_SKILL` and `DELETE_SKILL`
markers at the end of the turn that wrote them, after the reply has finished,
so the agent that asked could not see the outcome, and its next turn was
given no word of it either. A specialist whose save was refused could go on
as if it had worked. When the orchestrator brought Doc in to make a change,
Doc's hand-back told the orchestrator what Doc said, never what Rundock did,
so a refused or failed change could be reported as done. And the line a
person reads ("Agent "x" created") was drawn only in a window that had that
conversation on screen at the time: with another conversation open it was
dropped, and after a reload it was gone.

## Red first

Each run below is of the named file against the code before the change it
tests, and each failure is the behavior being closed, not a broken test.

**`test/unit/team-notes.test.js` at `b6464311` (code as at `d9add8d5`): 19
tests, all failed** at the require: `lib/agents/team-notes.js` did not exist.
The file is unchanged since.

**`test/integration/team-notes.test.js` at `b6464311`: 12 tests, 1 passed, 11
failed.** Each failure was the missing note: the next prompt was the person's
message alone (for example, actual `'LIVE-TWO did it work?'`, expected the
heading, the refusal line, a blank line, then that message). The one that
passed, "a turn with no agent or skill markers adds nothing", holds behavior
that was already true. The sequence test "the most common next step" would
have failed first on a counting check (Doc's arriving catch-up also carries
the turn's token); `174724f1` narrows that check to the orchestrator's own
prompts, after which it fails on the missing note.

**The tests added later, run with `server.js`, `lib/` and `public/` checked
out from `d9add8d5`** (with `lib/agents/team-notes.js` left in place, which
nothing in that code requires), then checked out from `HEAD` again:

- `test/integration/team-notes.test.js`: 18 tests, 1 passed, 17 failed. The
  later ones failed as follows. A refused resume: "and it opens with the note
  (got "DEAD-TWO is it there?")". Two windows: the transcript held the
  person's message and the reply, with no line for the outcome. Injection:
  the next prompt was the message alone. The three fail-closed cases: "the
  failure was logged" (nothing was there to fail).
- `test/integration/team-notes-restart.test.js`: 1 test, failed reading the
  record's `teamOutcomes`, which the first server never wrote.
- `test/unit/team-line-view.test.js`: 5 tests, 1 passed, 4 failed. The line
  for another conversation was not kept with it; the line for the
  conversation on screen was not drawn again on coming back; the six team
  messages did not ask for their line to be kept; the history drew no stored
  line. The one that passed, a conversation whose history is not loaded yet
  keeps nothing, was already true.
- `test/e2e/team-line.spec.js`: 1 test, failed at "switching to the first
  conversation shows the line once": 0 found.

**Not run red first.** None. Every test above was run against the code
before its change; the three that passed hold behavior that was already true
and stay to keep it so.

## Deliberate breaks

Each break was applied to the committed code at `3b18aaff`, the named files
were run, and the file was checked out from `HEAD` again. A copy of each file
was kept outside the repository while it was broken.

| Break | File | Run | Failed | Caught by |
|---|---|---|---|---|
| The note given on every turn, never removed once told | `lib/agents/team-notes.js` | `team-notes.test.js` (integration, unit), `team-notes-restart.test.js` | 6 of 18, 4 of 19, 1 of 1 | "the one after carries nothing" (Claude Code and Codex), the refused resume, the undo, the retry, the most common next step; "carries the note in front of the message, once", "opens with the note, once"; the restart's "and once told it is removed from the record" |
| The note dropped | `lib/agents/team-notes.js` | `team-notes.test.js` (integration, unit) | 13 of 18, 7 of 19 | every case that expects a note |
| The note built from the reply's text | `lib/delegation/engine.js` | `team-notes.test.js` (integration) | 7 of 18 | the injection case, and every Claude Code refusal or failure pinned byte for byte |
| A refused change told as saved | `lib/delegation/catch-up.js` | `team-notes.test.js` (integration, unit) | 7 of 18, 8 of 19 | "Doc's save was refused and another failed: the orchestrator is told so, never that it was saved", the Codex refusal, the inverse action, the retry, the most common next step; the byte-for-byte unit pins |
| The stored line written once per open window | `server.js` | `team-notes.test.js` (integration) | 1 of 18 | "stored once with two windows open, after the reply that asked, and given back by the history" |
| The heading kept out of the list of Rundock's own lines | `lib/delegation/catch-up.js` | `team-notes.test.js` (unit) | 1 of 19 | "it is one of the catch-up headings, and a prompt that opens with the note is Rundock's" |
| The note put after the person's message | `lib/agents/team-notes.js` | `team-notes.test.js` (integration, unit) | 13 of 18, 7 of 19 | every case that pins the prompt byte for byte |
| The outcomes kept in memory only | `lib/agents/team-notes.js` | `team-notes-restart.test.js`, `team-notes.test.js` (unit) | 1 of 1, 1 of 19 | the restart test; "outcomes are written to the record, carried by a window's save, never sent to a window, and removed once told" |
| The line drawn in whichever conversation is on screen | `public/app.js` | `team-line-view.test.js`, `test/e2e/team-line.spec.js` | 1 of 5, 1 of 1 | "for another conversation: not drawn here"; the browser test's "the line is not drawn in the conversation on screen" |

## Existing code and tests changed

- `test/unit/child-stdin-inventory.test.js`: the list of what may replace a
  child's `stdin.write` now names the team note's wrapper beside the handler
  and the answer-file guard.
- `test/unit/sdlc-gate-hardening.test.js`: the restart test is registered as
  an extraction (the sign-in link out of each server's startup output), the
  same way as the held catch-up restart test.
- `lib/runtime/codex-glue.js`: `withAgentNotice` returns its input through
  the team note.
- `lib/delegation/engine.js`: a turn's markers are still decided before
  `onResult`; the outcomes are kept after it, so the stored line follows the
  reply. Doc's auto-return keeps its timing (the platform delegate test in
  `test/integration/delegation.test.js` passes unchanged).

## Tests run at the head

Each file run on its own with `node --test`, all passing:
`test/integration/team-notes.test.js` (18), `team-notes-restart.test.js` (1),
`team-markers.test.js` (10), `team-markers-edges.test.js` (16),
`delegation.test.js` (25), `delegation-chain-edges.test.js` (8),
`catch-up-delivery.test.js` (9), `held-catch-up.test.js` (13),
`held-catch-up-restart.test.js` (1), `session-history.test.js` (18),
`transcript-only-conversation.test.js` (4), `codex-chat.test.js` (18),
`codex-delegation.test.js` (5), `codex-approval-notice.test.js` (3),
`codex-approvals.test.js` (6), `codex-cancel-followup.test.js` (6),
`codex-delegate-edges.test.js` (5), `codex-session-recovery.test.js` (3),
`codex-stop-and-ask.test.js` (4); `test/unit/team-notes.test.js` (19),
`team-line-view.test.js` (5), `team-markers-turn.test.js` (9),
`child-stdin-inventory.test.js` (13), `handback-intent.test.js` (45),
`regression.test.js` (24), `room-context-delta.test.js` (72),
`session-history-merge.test.js` (15), `stream-handlers.test.js` (32),
`doc-claims.test.js` (115), `agent-file-without-marker.test.js` (19),
`marker-pill-routing.test.js` (13), `replay-no-dividers.test.js` (13),
`delegation-dispatch.test.js` (5), `client-namespace.test.js` (5),
`innerhtml-payloads.test.js` (17), `conversation-state.test.js` (71),
`sdlc-gate-hardening.test.js` (87), `codex-answer-file-guard.test.js` (23),
`codex-what-runs-guard.test.js` (18).

`npx playwright test test/e2e/team-line.spec.js
test/e2e/agent-file-without-marker.spec.js
test/e2e/history-marker-strip.spec.js`: 12 passed.
