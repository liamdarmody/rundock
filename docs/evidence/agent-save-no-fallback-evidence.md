# A reply that shows an agent file without a save marker saves nothing: search, red first and deliberate breaks

**This file is a dated record of runs on one machine, not a source of truth.**
Every claim below is re-measured by the named tests on every run of the
suite. If this file and those tests ever disagree, the tests are right.

Taken on 2026-11-12 on macOS with Node 24.12.0 and Playwright 1.61.1. The
branch starts from `origin/main` at `bd0bd815`. Its commits:

- `8603aafc`: the tests only (`test/unit/agent-file-without-marker.test.js`,
  `test/e2e/agent-file-without-marker.spec.js`), against the code as it is on
  `origin/main`.
- `ef070e0b`: the change, and **the final code commit**. It removes the
  fallback block from `handleResult` in `public/app.js`, removes
  `extractFrontmatterAgents` and its export from `public/markers.js`, rewrites
  the header contract there so it describes no fallback, and removes the two
  tests that pinned the fallback (the "no-marker fallback" section of
  `test/unit/markers.test.js`, and "the frontmatter fallback sends the id
  too" in `test/unit/marker-pill-routing.test.js`). The commits after it
  correct one comment in the new unit test and add this file. No code
  changes after it.

## The defect

When the marker scan in a finished reply found no save or delete, the client
looked for anything shaped like an agent file (a fenced block or bare
frontmatter with a `name:` line and `type: orchestrator` or `type:
specialist`) and sent `save_agent` for each. The server's save replaces any
file of that name and keeps no copy. So a reply that showed an agent file for
the person to approve wrote it at the preview, before the yes, and an
existing agent of that name was overwritten by its own preview.

## No built-in flow relied on the fallback

Searched at `origin/main` (`bd0bd815`), over `scaffold/`, `lib/`, `public/`,
`scripts/smoke/` and `test/e2e/fixture.js`.

**Every place an agent file's `type:` line appears as text:**

```
git grep -n -c -E "type: ?(orchestrator|specialist)" origin/main -- scaffold lib public scripts/smoke test/e2e/fixture.js
```

```
lib/packages/import-apply.js:1
lib/protocol/handlers/team.js:2
scaffold/rundock-guide.md:3
scripts/smoke/personas.mjs:1
scripts/smoke/run.mjs:4
test/e2e/fixture.js:2
```

File by file:

- `lib/packages/import-apply.js:298`: the server rewrites an imported agent's
  `type:` line while it writes the file itself. No reply text is involved.
- `lib/protocol/handlers/team.js:135` and `:138`: the save handler adds
  `type: specialist` to a saved agent that has none. This is the handler, not
  a flow that shows a file.
- `scaffold/rundock-guide.md:126`: inside the template Doc is told to emit,
  which is wrapped in `<!-- RUNDOCK:SAVE_AGENT name={slug} -->` and its
  closing marker (lines 119 to 138). `:245` is the frontmatter field
  reference (`type: orchestrator | specialist | platform`), which describes
  the fields and is never meant to be saved; the old fallback's pattern did
  not match that line either. `:301` is prose. Line 151 of the same file
  already tells Doc that frontmatter without the marker creates no agent.
- `scripts/smoke/personas.mjs:187`: a stub turn whose agent file is inside a
  SAVE_AGENT marker.
- `scripts/smoke/run.mjs:48`, `:50`, `:52`: the smoke workspace's seed agents,
  written to disk with `fs.writeFileSync`, never shown in a reply. `:79`: a
  stub turn whose agent file is inside a SAVE_AGENT marker.
- `test/e2e/fixture.js:241` and `:246`: the seeded agents, written to disk
  with `fs.writeFileSync`. The seeded conversation that saves an agent
  (`:463`) uses a SAVE_AGENT marker.

**Every place a save marker is used or named:**

```
git grep -n -c -E "RUNDOCK:(SAVE|CREATE)_AGENT" origin/main -- scaffold lib public scripts/smoke test/e2e/fixture.js
```

```
lib/agents/routines.js:1
lib/protocol/handlers/team.js:1
public/agent-colour.js:1
public/app.js:1
public/views/conversations.js:1
public/views/routines-panel.js:1
scaffold/rundock-agents.md:2
scaffold/rundock-guide.md:5
scaffold/rundock-skills.md:2
scaffold/rundock-tuneup.md:1
scripts/smoke/personas.mjs:1
scripts/smoke/run.mjs:1
test/e2e/fixture.js:1
```

Doc's instructions (`scaffold/rundock-*.md`) create, edit and fix agents only
through the marker. `public/views/conversations.js:300` is the reminder the
client adds to Doc's team-setup prompt: "you MUST use
`<!-- RUNDOCK:SAVE_AGENT name={slug} -->` markers. Without them, agents are
not created." The `lib/` and other `public/` hits are comments naming the
marker path.

**Every caller of the fallback:**

```
git grep -n -c "extractFrontmatterAgents" origin/main -- .
```

```
public/app.js:1
public/markers.js:2
test/unit/marker-pill-routing.test.js:1
test/unit/markers.test.js:8
```

The one caller was the fallback block in `handleResult`; the rest are its
definition, its export and its own tests. At `ef070e0b` the only hits are in
`test/unit/agent-file-without-marker.test.js`, which asserts the name is gone.

Result: nothing in these folders shows an agent file without a marker and
expects it saved.

## Red first against `origin/main`

Run at `8603aafc`, whose code is `origin/main`'s.

**`node --test test/unit/agent-file-without-marker.test.js`: 16 tests, 11 fail, 5 pass.**

Failing, every one on a `save_agent` the fallback sent or on the fallback's
presence in the source:

- a markdown fence, type specialist
- a markdown fence, type orchestrator
- a bare fence, type specialist
- a bare fence, type orchestrator
- unfenced frontmatter, one block
- unfenced frontmatter, several blocks in one reply
- a fenced and an unfenced file in the same reply
- the fallback extractor is gone from the module and from every client file
- the module header no longer describes a fallback
- handleResult sends exactly these five messages, and the saves only from scanMarkers actions (a sixth send: the fallback's `save_agent`)
- no client file builds a file-writing message outside the send table (`app.js:save_agent` found twice)

Passing, as they should on both sides of the change: the five marked-save
tests (SAVE_AGENT, SAVE_AGENT with a fenced body, CREATE_AGENT, SAVE_SKILL,
and a marked save beside a previewed file).

**`npx playwright test test/e2e/agent-file-without-marker.spec.js`: 9 tests, 7 fail, 2 pass.**

Failing, each on the files in the workspace before anything on the page:

- a reply showing an agent file in a markdown fence and type specialist, named as an existing agent, with no marker, saves nothing ("the existing agent file changed")
- the same in a bare fence and type specialist ("the existing agent file changed")
- the same in a markdown fence and type orchestrator, under a new name ("a file was added to or removed from .claude/agents/": `example-lead.md` appeared)
- the same in a bare fence and type orchestrator, named as an existing agent ("the existing agent file changed")
- a reply showing one unfenced agent file, with no marker, saves nothing ("the existing agent file changed")
- a reply showing several unfenced agent files, with no marker, saves nothing ("the existing agent file changed")
- a previewed agent file is written only when the next reply carries it in a SAVE_AGENT marker, once ("the preview wrote the agent file before the yes")

Passing on both sides: "a CREATE_AGENT marker still saves, once" and "a
SAVE_SKILL marker still writes the skill file, once".

## Green at `ef070e0b`

| File | Tests | Pass |
| --- | --- | --- |
| `test/unit/agent-file-without-marker.test.js` | 16 | 16 |
| `test/unit/markers.test.js` | 18 | 18 |
| `test/unit/marker-pill-routing.test.js` | 13 | 13 |
| `test/unit/conversation-state.test.js` | 71 | 71 |
| `test/unit/doc-claims.test.js` | 115 | 115 |
| `test/unit/delegation-markers.test.js` | 6 | 6 |
| `test/unit/delegation-dispatch.test.js` | 5 | 5 |
| `test/unit/handback-intent.test.js` | 45 | 45 |
| `test/unit/live-handoff-render.test.js` | 15 | 15 |
| `test/unit/replay-no-dividers.test.js` | 13 | 13 |
| `test/unit/regression.test.js` | 24 | 24 |
| `test/unit/innerhtml-payloads.test.js` | 17 | 17 |
| `test/unit/text-helpers.test.js` | 35 | 35 |
| `test/unit/signals.test.js` | 8 | 8 |
| `test/unit/coverage-instruments.test.js` | 10 | 10 |
| `test/unit/sdlc-gate-hardening.test.js` | 87 | 87 |
| `test/integration/delegate-context-cap.test.js` | 5 | 5 |
| `test/integration/smoke-plan.test.js` | 12 | 12 |
| `test/integration/transcript-only-conversation.test.js` | 4 | 4 |

`test/unit/markers.test.js` had 23 tests before; the 5 removed are the
fallback's own. Every `scanMarkers` and stripper test in it is unchanged.
`test/unit/marker-pill-routing.test.js` had 14; the 1 removed is the
fallback's.

Playwright, in one run: `test/e2e/agent-file-without-marker.spec.js` (9),
`test/e2e/history-marker-strip.spec.js` (1) and
`test/e2e/connector-cards.spec.js` (2), 12 passed. In a second run the new
spec was followed by `org-chart.spec.js`, `profile-instructions.spec.js` and
`always-allow-without-window.spec.js`, 13 passed, so the agent and skill
files the spec creates are gone before the next spec reads the roster.

## Deliberate breaks

Each break was applied to the committed `ef070e0b` tree from a copy kept
outside the repository, run, and then the file was put back to its committed
version, with nothing else uncommitted in the tree.
Unit means `test/unit/agent-file-without-marker.test.js`,
`test/unit/markers.test.js` and `test/unit/marker-pill-routing.test.js` run
together (47 tests). Browser means
`test/e2e/agent-file-without-marker.spec.js` (9 tests).

**1. The fallback block put back in `handleResult`,** both halves (fenced,
then unfenced), with its extraction written inline so the name
`extractFrontmatterAgents` appears nowhere.

- Unit: 9 of 47 fail. The seven no-marker tests ("a markdown fence, type
  specialist", "a markdown fence, type orchestrator", "a bare fence, type
  specialist", "a bare fence, type orchestrator", "unfenced frontmatter, one
  block", "unfenced frontmatter, several blocks in one reply", "a fenced and
  an unfenced file in the same reply"), "handleResult sends exactly these
  five messages, and the saves only from scanMarkers actions", and "no client
  file builds a file-writing message outside the send table".
- Browser: 7 of 9 fail, the same seven as red first above.

**2. Only the unfenced half of the fallback put back** (the split on
`---\nname:` lines).

- Unit: the same 9 of 47 fail. The unfenced half alone also saves a fenced
  file, because the split finds the frontmatter inside the fence, so the
  fenced tests fail as well as the unfenced ones.
- Browser: the same 7 of 9 fail.

**3. The marker loop in `handleResult` removed.**

- Unit: 7 of 47 fail: "a SAVE_AGENT marker", "a SAVE_AGENT marker whose body
  is fenced saves the file without the fence", "a CREATE_AGENT marker", "a
  SAVE_SKILL marker", "a marked save beside a previewed file saves only the
  marked one", "handleResult sends exactly these five messages, and the saves
  only from scanMarkers actions", and, in `marker-pill-routing.test.js`,
  "marker actions carry the conversation that produced them".
- Browser: 3 of 9 fail: "a previewed agent file is written only when the next
  reply carries it in a SAVE_AGENT marker, once" (`example-new.md` not
  written), "a CREATE_AGENT marker still saves, once" (`example-made.md` not
  written), "a SAVE_SKILL marker still writes the skill file, once"
  (`example-skill/SKILL.md` not written).

**4. A save sent twice for one marker** (the send line in the marker loop
duplicated).

- Unit: 6 of 47 fail: the five marked-save tests and "handleResult sends
  exactly these five messages, and the saves only from scanMarkers actions".
- Browser: 3 of 9 fail: the same three as break 3, each on "exactly one save,
  carrying the marker content" (two identical `save_agent` or `save_skill`
  messages sent).

**5. `extractFrontmatterAgents` put back in `public/markers.js` and exported,
with nothing calling it.**

- Unit: 1 of 47 fails: "the fallback extractor is gone from the module and
  from every client file".
- Browser: not run. Nothing calls it, so nothing reaches the page.

**6. A second route outside `handleResult`:** a function in
`public/views/chat.js` that finds an agent file in message text and sends
`save_agent` for it. `handleResult` is unchanged.

- Unit: 1 of 47 fails: "no client file builds a file-writing message outside
  the send table" (`views/chat.js:save_agent`).
- Browser: not run. Nothing calls the function, so nothing reaches the page;
  the unit pin is the check for a route that is added before it is wired.

**7. The unfenced fallback put back under the legacy message name
`create_agent`,** which the server maps to the same save handler.

- Unit: the same 9 of 47 as break 1 fail.
- Browser: the same 7 of 9 as break 1 fail.

## How the source pins read the code

`test/unit/agent-file-without-marker.test.js` cuts `handleResult` out of
`public/app.js` by its declaration and the first closing brace at the start
of a line, refuses if either end or the marker scan inside it is missing, and
runs it with a recording socket, the real `public/markers.js` and stubs for
the render half. Every run asserts nothing was logged through `console.error`
and the render half was reached, so a harness missing a global fails rather
than reading as "nothing was sent". Its pins read the source with `indexOf`
and `split` and assert exact lists and counts: the five sends in
`handleResult`, five `.send(` calls under any name, the send table read once
inside the loop over `scan.actions`, and every file-writing message type
(the legacy `create_agent` and `update_agent` included) built only in that
table, across every client script outside `public/vendor/`.
What they cannot see is a message type assembled at runtime from pieces.
