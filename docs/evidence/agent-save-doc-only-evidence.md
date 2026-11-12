# Only Doc's replies can save or delete agents and skills, decided on the server: red first and deliberate breaks

**This file is a dated record of runs on one machine, not a source of truth.**
Every claim below is re-measured by the named tests on every run of the
suite. If this file and those tests ever disagree, the tests are right.

Taken on 2026-11-12 on macOS with Node 24.12.0 and Playwright 1.61.1. The
branch starts from `3445b46d`. Its commits:

- `3bb41a2e`: the first tests only, against the code as it was at
  `3445b46d` (`test/integration/team-markers.test.js`, the platform delegate
  test in `test/integration/delegation.test.js`, and the save marker fixtures
  in `test/fixtures/stream-json.js`).
- `d014e078`: the server acts on agent and skill markers at the end of each
  turn, only from Doc (`lib/agents/team-markers.js`, wired from
  `lib/delegation/engine.js` and `server.js`); a direct chat records the agent
  discovery resolved; the page stops sending these changes.
- `cd53d080`: the six socket messages are refused; tests that used them are
  reworked.
- `298a713f`: Codex turns go through the same decision; the tests for the
  remaining routes.
- `9310d8cc`: the prompt, Doc's own file and `ARCHITECTURE.md`. **The final
  code commit.** The commits after it change tests and add this file only.
- `c38750e8`: the browser test runs the marked saves with Doc and adds a
  refusal case.

## The defect

Agents ask for an agent or skill file to be saved or deleted with a marker in
a reply (`SAVE_AGENT`, `CREATE_AGENT`, `DELETE_AGENT`, `SAVE_SKILL`,
`DELETE_SKILL`). The page scanned every finished reply in every conversation
and sent the server one message per marker, and the server's handlers never
asked who had written it. So any agent's reply could save or delete agents
and skills, with no card, including a reply steered by text the agent had
read. Every open window also acted on the same marker, and with no window
open the marker was acted on late or not at all.

## Red first

Each run below is of the named file against the code before the change it
tests, and each failure is the behavior being closed, not a broken test.

**`test/integration/team-markers.test.js` at `3bb41a2e` (code as at
`3445b46d`): 8 tests, 0 passed, 8 failed.**

- Doc saves, creates and deletes, each exactly once, with no window open
  (brought in by an orchestrator's Agent call, and in a direct chat): failed,
  "the files changed at the turn's end, with no window open". Nothing on the
  server acted on Doc's markers.
- Every other agent is refused (a specialist, the orchestrator, the default
  agent): each failed, timed out waiting for the refusal line. No refusal
  existed.
- A direct chat naming `rundock-guide` that resolves to the default agent:
  failed, "the process is announced as the agent discovery resolved". The
  entry recorded the name the window sent.
- A reply that claims to be Doc, and Doc's markers for its own file or a
  platform agent: each failed, timed out waiting for the refusal line.

**`test/integration/delegation.test.js`, "platform delegate auto-returns on a
CRUD marker even without COMPLETE, and its marker writes the file once", at
`3bb41a2e`:** failed, `ENOENT` reading the skill file. The test used to check
only the auto-return, and the fixture's marker had no line break after the
opening comment, so the marker scan never saw a save at all.

**The socket test ("each of the six, from the window's own authenticated
socket, is refused with an error and writes nothing") at `d014e078`:** failed,
"save_agent was answered with agent_saved". The companion test, "a socket
with no key never opens", passed: the connection is already refused.

**`test/integration/team-markers-edges.test.js` at `cd53d080`: 16 tests, 14
passed, 2 failed.** The two Codex tests (a direct chat, and a delegate) failed,
timed out waiting for the refusal line: Codex turns did not reach the
decision.

**`test/unit/discovery.test.js`, run with the new tests against the
`lib/agents/prompt.js` of `298a713f`: 2 failed.** "Only Doc is told the agent
and skill marker rule" failed at "and that only its own are acted on"; the
reworded pin in "agents are told to attempt file operations" failed at "the
attempt-first rule defers to it".

**`test/e2e/agent-file-without-marker.spec.js` at `c38750e8`, with
`server.js`, `lib/`, `public/` and `scaffold/` checked out from `3445b46d`:
10 tests, 6 passed, 4 failed.** The three marked saves with Doc failed, "the
page asked the server to write or delete a file" (the page sent `save_agent`
or `save_skill`). The new case, another agent's `SAVE_AGENT` marker, failed:
no refusal line on the page. The six cases without a marker passed, as they
did before. The code was then checked out from `HEAD` again.

**Not run red first.** The tests below were written after the server code
existed, or cover behavior that was already true, so each passed on its first
run: another agent whose file declares `type: platform`; a routine run by Doc;
an orchestrator's turn intercepted by its own Agent call; Doc's turn blocked
for an off-roster Agent call; Doc's turn that dies before its result; the
decision failing at the scan, the author lookup or the write; two windows; the
retry, inverse, undo and next-step sequences; and every test in
`test/unit/team-markers-turn.test.js`. The cancelled turn there passes because
the engine already drops a process's output once its entry has exited, which
the cancel handler sets. Each of these that guards a deliberate break below
was seen failing under that break instead.

## Deliberate breaks

Each break was applied to the committed code at `9310d8cc` (unchanged at
`c38750e8`), the named file was run, and the code was put back. A copy of each
file was kept outside the repository while it was broken.

| Break | File | Run | Failed | Caught by |
|---|---|---|---|---|
| The author check removed | `lib/agents/team-markers.js` | `test/integration/team-markers.test.js` | 5 of 10 | the three "writing each of the five markers" cases (specialist, orchestrator, default agent), the resolved id, and the reply claiming to be Doc |
| The author taken from the reply text or a marker attribute | `lib/agents/team-markers.js` | `test/integration/team-markers.test.js` | 1 of 10 | "a reply that claims to be Doc, from a process that is not Doc, is refused" |
| The author taken from the conversation's current process | `lib/agents/team-markers.js` | `test/unit/team-markers-turn.test.js` | 2 of 6 | "Doc's turn is Doc's even when the conversation's current process is another agent", "another agent's turn is refused even when the conversation's current process is Doc" |
| A socket `save_agent` handled again | `lib/protocol/handlers/index.js` | `test/integration/team-markers.test.js`, `test/unit/protocol-handlers-lib.test.js` | 3 of 79 | "each of the six, from the window's own authenticated socket, is refused", "the six agent and skill changes, legacy aliases included, map to the one refusal by identity", "the refusal writes nothing, answers on the conversation it came from, and says only Doc changes the team" |
| The platform-identity refusal removed | `lib/agents/team-markers.js` | `test/integration/team-markers.test.js` | 1 of 10 | "Doc's own markers cannot write Doc's file or any platform agent" |
| An author lookup failure treated as allowed | `lib/agents/team-markers.js` | `test/integration/team-markers-edges.test.js` | 2 of 16 | "the author lookup finds nobody", "the author lookup throws" |
| A scan failure treated as allowed | `lib/agents/team-markers.js` | `test/integration/team-markers-edges.test.js` | 1 of 16 | "the scan throws" |
| The scan run once per open window instead of once per turn | `lib/agents/team-markers.js` | `test/integration/team-markers-edges.test.js` | 1 of 16 | "two windows: Doc's marker writes once, and each window is told once" |
| The server scan reading the result envelope instead of the streamed text | `lib/delegation/engine.js` | `test/unit/team-markers-turn.test.js` | 1 of 6 | "the text read is what the process streamed, not the result envelope's copy" |
| The refusal broadcast removed | `lib/agents/team-markers.js` | `test/integration/team-markers.test.js` | 6 of 10 | the three "writing each of the five markers" cases, the resolved id, the reply claiming to be Doc, and Doc's own file or a platform agent |
| The prompt giving the marker rule to every agent | `lib/agents/prompt.js` | `test/unit/discovery.test.js` | 1 of 71 | "only Doc is told the agent and skill marker rule; everyone else is told to go through Doc" |

The first run of the two lookup and scan breaks also failed later cases in the
same file, because a failing case left its file behind. The fail-closed tests
were changed to clean up however they end, and those two breaks were run again
for the rows above.

## Tests reworked

Tests that saved or deleted an agent or skill through the six socket messages
now make the change as Doc's reply does (`h.asDoc` in
`test/helpers/harness.js`, which calls `applyTeamMarkers` with Doc's entry),
or call the handler in-process:

- `test/integration/http-api.test.js`: the agent and skill CRUD block. Names a
  marker cannot carry (`../evil`, `../../etc`) became names it can that the
  slug rule refuses (`Evil_Agent`, `Etc_Skill`); deleting `rundock-guide` is
  now refused as Doc's own file.
- `test/integration/smoke-plan.test.js`: T2 and T3.
- `test/integration/ws-handler-edges.test.js`: the typed save and the skill
  refusals (`Bad Name!` became `Bad_Name`).
- `test/integration/delegation.test.js`: the roster refresh test.
- `test/integration/runtime-status.test.js`, `test/integration/search.test.js`,
  `test/integration/delegation-chain-edges.test.js`: one save each.
- `test/unit/approve-once.test.js`: calls `handleSaveAgent` directly.
- `test/unit/protocol-handlers-lib.test.js`: the alias identity test now pins
  all six to the refusal; the boundary-guard test calls the handlers directly.
- `test/unit/agent-file-without-marker.test.js`: the pins now hold that the
  page sends no agent or skill change at all (three sends in `handleResult`;
  the send table holds the two connector changes only).
- `test/unit/discovery.test.js`: the attempt-first pin follows the reworded
  sentence.
- `test/fixtures/stream-json.js`: the save marker fixtures put the body on its
  own lines, as the marker scan reads them.

## Tests run at the head

Each file run on its own with `node --test`, all passing:
`test/integration/team-markers.test.js` (10), `team-markers-edges.test.js`
(16), `delegation.test.js` (25), `delegation-chain-edges.test.js` (8),
`http-api.test.js` (44), `runtime-status.test.js` (5), `search.test.js` (24),
`smoke-plan.test.js` (12), `team-membership.test.js` (5),
`ws-handler-edges.test.js` (11), `legacy-mode.test.js` (5),
`codex-chat.test.js` (18), `codex-delegation.test.js` (5),
`codex-delegate-edges.test.js` (5), `codex-cancel-followup.test.js` (6);
`test/unit/team-markers-turn.test.js` (9), `agent-file-without-marker.test.js`
(19), `agents-lib.test.js` (8), `approve-once.test.js` (36),
`conversation-state.test.js` (71), `delegation-markers.test.js` (6),
`delegation-engine-lib.test.js` (6), `discovery.test.js` (71),
`doc-claims.test.js` (115), `engine-live-delivery.test.js` (9),
`codex-glue-lib.test.js` (5), `handback-intent.test.js` (45),
`marker-pill-routing.test.js` (13), `markers.test.js` (18),
`notes-mode-label.test.js` (5), `package-import-protocol.test.js` (38),
`precommit-gate.test.js` (47), `protocol-handlers-lib.test.js` (69),
`regression.test.js` (24), `scaffold-integrity.test.js` (9),
`scheduler-lib.test.js` (76), `scratch-files-instruction.test.js` (9),
`sdlc-gate-hardening.test.js` (87), `workspace-mode-values.test.js` (13).

`npx playwright test test/e2e/agent-file-without-marker.spec.js
test/e2e/history-marker-strip.spec.js test/e2e/connector-cards.spec.js` at
`c38750e8`: 13 passed.
