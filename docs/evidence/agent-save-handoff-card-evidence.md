# A change Doc makes while another agent brought it in is asked about on a card: red first and deliberate breaks

**This file is a dated record of runs on one machine, not a source of truth.**
Every claim below is re-measured by the named tests on every run of the
suite. If this file and those tests ever disagree, the tests are right.

Taken on 2026-11-13 on macOS with Node 24.12.0 and Playwright 1.61.1. The
branch starts from `59072687`. Its commits:

- `66909a56`: the first tests only, against the code as it was at `59072687`
  (`test/integration/team-handoff-cards.test.js`).
- `93b08552`: the card on the server. In a hand-off, `applyTeamMarkers`
  (`lib/agents/team-markers.js`) raises a card for each change through
  `requestServerPermission` and writes only on an Allow given on that card,
  the bytes the card showed (`agentFileToWrite` in
  `lib/protocol/handlers/team.js`); Doc's hand-back waits for the cards
  (`afterTeamCards`, `lib/delegation/engine.js`); a cancel during the wait
  refuses them (`lib/protocol/handlers/process-control.js`); an open card is
  held on the conversation's record and becomes a refused outcome after a
  restart (`lib/agents/team-notes.js`, `server.js`,
  `lib/protocol/handlers/conversations.js`).
- `0be6316d`: the window grades the four card names high and shows the
  whole file, open (`public/permissions.js`, `public/views/chat.js`,
  `public/styles/views/chat.css`). **The final code commit.** The commits
  after it change tests, docs and this file only.
- `4e187905`: what the card shows, what is written, the hand-back wait, the
  control failing, the restart, the five sequences, and the browser test.
- The commit that adds this file: `ARCHITECTURE.md`.

## The defect

Doc takes a delegating agent's go-ahead as the person's consent, and any
agent can bring Doc in with a brief it wrote. So an agent steered by text it
had read could have Doc create, replace or delete an agent or skill file,
files every later run follows, with no person involved: the change was
written at the end of Doc's turn like any other. When the person talks to Doc
directly that is what they asked for; when another agent brought Doc in,
nobody had.

## Red first

Each run below is of the named file against the code before the change it
tests, and each failure is the behaviour being closed, not a broken test.

**`test/integration/team-handoff-cards.test.js` at `66909a56` (code as at
`59072687`): 8 tests, 2 passed, 6 failed.** Each failure was the missing card:
"N card(s) raised (got 0)". The two that passed, "a conversation started with
Doc" and "a conversation the person switched to Doc", hold behaviour that was
already true: the person talking to Doc writes with no card.

**`test/unit/team-change-card.test.js` against the window code at
`59072687`: 6 tests, all failed.** The four names were not graded high, a
standing allow for the name answered the card, and the card had none of the
copy or the file.

**The tests added in `4e187905`, run with `server.js`, `lib/` and `public/`
checked out from `59072687`,** then checked out from `HEAD` again:

- `test/integration/team-handoff-cards.test.js`: 24 tests, 3 passed, 21
  failed. Of the 16 added, 15 failed: each at "N card(s) raised (got 0)",
  except "the control failing: the permission request throws", which timed
  out waiting for the line saying Rundock could not show the card. The one
  that passed, "a change that cannot be made raises no card", holds behaviour
  that was already true: Doc's own file, a platform agent and a name no file
  can have were already refused.
- `test/integration/team-handoff-card-restart.test.js`: 1 test, failed
  waiting for the card: the first server wrote the agent and handed back
  "Saved (new)".
- `test/unit/team-markers-turn.test.js`: 11 tests, 10 passed, 1 failed. "An
  entry started for another agent asks, though the reply, a marker's
  attributes and the brief all say the person is present" saw no card. The
  other new one, "an entry nobody brought in writes with no card", holds
  behaviour that was already true.

**Not run red first.** `test/e2e/team-handoff-card.spec.js`: Chromium cannot
start in the sandbox these runs were taken in, so the browser test was not
run here, red or green. CI runs it.

## Deliberate breaks

Each break was applied to the committed code at `4e187905`, the named files
were run, and the file was checked out from `HEAD` again. A copy of each file
was kept outside the repository while it was broken. "Cards" is
`test/integration/team-handoff-cards.test.js`.

| Break | File | Run | Failed | Caught by |
|---|---|---|---|---|
| Whether it is a hand-off read from the reply, a marker's attribute or the brief, as well as the entry | `lib/agents/team-markers.js` | Cards, `team-markers-turn.test.js` | 1 of 24, 1 of 11 | "a brief and a reply that say the person agreed, and a marker carrying an attribute that says so, still raise a card"; "an entry started for another agent asks, though the reply, a marker's attributes and the brief all say the person is present" |
| A write on any allow, without checking that it came from a card | `lib/agents/team-markers.js` | Cards | 1 of 24 | "An allow that did not come from a card writes nothing" |
| A write on a timeout | `lib/agents/team-markers.js` | Cards | 2 of 24 | "No answer before the timeout, with every window closed"; "the control failing: the window drops while the card is open" |
| A card for the first change in a reply only, the rest written as before | `lib/agents/team-markers.js` | Cards | 11 of 24 | both "one card per change" tests (five in one reply, and a `DELEGATE` marker), "Allow on each card", "the kind, the action decided from the disk...", "a file that appeared, or went...", the cancel during the wait, the timeout, "a decision given twice", the dropped window, an allow from no card, the most common next step |
| The four names not graded high | `public/permissions.js` | `team-change-card.test.js` | 2 of 6 | "each of the four is graded high, as a connector change is"; "Allow and Deny only, and no saved answer stands in for the person" |
| The hand-back fired before the cards are answered | `lib/delegation/engine.js` | Cards | 3 of 24 | "Doc is not ended while its card waits"; the timeout; the dropped window |
| What is written taken from Doc's latest proposal for that name, not what this card showed | `lib/agents/team-markers.js` | Cards | 1 of 24 | "every change, every time: after the person replies to Doc during the hand-off, its next reply's change raises its own card, and cannot change what the first card writes" |
| The card raised in a conversation with Doc directly | `lib/agents/team-markers.js` | Cards, `team-markers-turn.test.js` | 3 of 24, 5 of 11 | "a conversation started with Doc", "a conversation the person switched to Doc", the undo; "an entry nobody brought in writes with no card", and four existing tests of Doc's own turn |
| The card raised, but the change written before it is answered | `lib/agents/team-markers.js` | Cards | 19 of 24 | every test that raises a card, among them "nothing written while they wait", Deny, the timeout and the five sequences |
| A carded change's outcome never kept for the next turn | `lib/agents/team-markers.js` | Cards | 10 of 24 | "Allow on each card", Deny, the timeout, the cancel during the wait, "Doc is not ended while its card waits", "every change, every time", "a decision given twice", the dropped window, the retry, the most common next step |
| What is written worked out again by the handler at write time, not what was shown | `lib/agents/team-markers.js` | Cards | 1 of 24 | "a new agent is written with the order its card showed, though another agent joined the team while the card waited" |

## Existing code and tests changed

- `lib/protocol/handlers/team.js`: the type and order a new agent is given
  moved out of `handleSaveAgent` into `onTheTeam`, unchanged, so the card can
  show the bytes the save will write (`agentFileToWrite`). Saved again those
  bytes come back unchanged.
- `lib/delegation/engine.js`: Doc's hand-back is scheduled through
  `afterTeamCards`, which runs it at once when no card is open, so a
  hand-off with no change keeps its timing.
- `lib/protocol/handlers/process-control.js`: a cancel while Doc is idle but
  its hand-back waits on cards now reaches the existing sweep that ends a
  conversation's cards, instead of returning early.
- `lib/protocol/handlers/conversations.js`: the record's `teamCards` is kept
  when a window saves the conversation and never sent to a window.
- `test/integration/team-markers.test.js`: "Doc brought in by an
  orchestrator's Agent call" wrote with no person involved, the defect this
  closes. It now asserts that nothing is written while no window is open,
  that the next window is shown the five cards, and that Allow on each
  writes each once.
- `test/integration/team-markers-edges.test.js`, `delegation.test.js`,
  `smoke-plan.test.js` and `team-notes.test.js`: each test where Doc is
  brought in for a change now answers its card with Allow, and then asserts
  what it did before.
- `test/unit/sdlc-gate-hardening.test.js`: the restart test is registered as
  an extraction (the sign-in link out of each server's startup output), the
  same way as the other restart tests.
- No mutation harness row searches a line this branch changed, so none was
  updated.

## Tests run at the head

Each file run on its own with `node --test`, all passing:
`test/integration/team-handoff-cards.test.js` (24),
`team-handoff-card-restart.test.js` (1), `team-markers.test.js` (10),
`team-markers-edges.test.js` (23), `delegation.test.js` (25),
`smoke-plan.test.js` (12), `team-notes.test.js` (18),
`team-notes-restart.test.js` (1), `held-catch-up-restart.test.js` (1),
`connector-asks.test.js` (5), `delegate-close-edges.test.js` (2),
`ws-handler-edges.test.js` (11), `chat-basic.test.js` (11),
`conversation-metadata.test.js` (9), `codex-cancel-followup.test.js` (6),
`delegation-chain-edges.test.js` (8), `http-api.test.js` (44);
`test/unit/team-markers-turn.test.js` (11), `team-notes.test.js` (19),
`team-change-card.test.js` (6), `connector-change-card.test.js` (10),
`delegation-engine-lib.test.js` (6), `regression.test.js` (24),
`protocol-handlers-lib.test.js` (69), `approve-once.test.js` (36),
`doc-claims.test.js` (115), `allowed-change-stands.test.js` (15),
`approval-notice.test.js` (12), `unattended-refusal.test.js` (23),
`marker-pill-routing.test.js` (13), `connector-card.test.js` (74),
`connector-grading.test.js` (49), `permissions.test.js` (176),
`permission-card-contrast.test.js` (68),
`permission-card-duplicates.test.js` (3), `permission-card-order.test.js` (7),
`permission-ownership.test.js` (10), `innerhtml-payloads.test.js` (17),
`boundary-card.test.js` (38), `code-mode-card.test.js` (45),
`putback-card.test.js` (12), `sdlc-gate-hardening.test.js` (87).

`test/e2e/team-handoff-card.spec.js` was not run here: Chromium cannot start
in this sandbox.
