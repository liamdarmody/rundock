# The runtime adapter contract

Rundock runs agents on two runtimes today: Claude Code and the Codex CLI
(over its app-server protocol). "Works with your Claude or ChatGPT
subscription" is an architectural property, not a hardcoded pair: this
document is the contract a third runtime would implement, derived from the
two real implementations. Nothing here is speculative; every obligation
below is something both existing runtimes already satisfy, and the shapes
are pinned by `test/unit/runtime-adapter.test.js`.

## What a runtime owes Rundock

A runtime integration owns five seams. Everything else (conversation
persistence, delegation orchestration, permission cards, transcripts,
search indexing) is runtime-agnostic and provided by the server.

### 1. Spawn / turn execution

Start a turn for an agent in a conversation. The server provides: the
workspace directory (always the cwd), the agent's instructions and platform
rules (injected on first turns when the runtime has no native agent-file
mechanism), the user message, and an optional model override from the
agent's frontmatter. Sandboxing must be requested at the strongest level
the runtime offers; bypass and full-access flags are never passed (pinned
by `test/integration/spawn-argv-freeze.test.js`).

- Claude Code: one subprocess per turn (`--print --output-format
  stream-json`), agent identity via `--agent`.
- Codex: one shared `codex app-server` process; `thread/start` or
  `thread/resume` + `turn/start`, identity in the first-turn prompt.

### 2. Event stream

The runtime's output is normalised into the small event vocabulary the
server already speaks. Whatever the wire format, a turn must produce:

| Event | Meaning | Client-visible result |
|---|---|---|
| session | the runtime's resumable thread/session id | `system/init` envelope; the client returns the id on the next turn |
| streamed text | incremental reply text | `stream_event` text deltas (live streaming) |
| final text | the authoritative full reply | `result` message + transcript |
| usage | token counts (subscription units, never dollars) | usage on the `result` |
| done | turn ended (completed / interrupted / failed) | `system/done` envelope, exactly once |
| error | classified failure (auth / quota / model / context / unknown) | guidance or error card with the exact fix |

### 3. Approvals

Where the runtime cannot protect the user with a sandbox, every side
effect (file write, shell command) must surface as a per-action approval
BEFORE it happens, routed through the server's permission-card bridge
(`requestServerPermission`), with deny/timeout failing closed. Where a real
sandbox holds, workspace-scoped actions may run silently and only
escalations surface. The human decides; the runtime never self-approves.

- Claude Code: the PreToolUse permission hook (all platforms). Named
  working folders are passed to it as `permissions.additionalDirectories` in
  the settings file it is launched with, never as `--add-dir` (which would
  also load skills, commands and subagents from them). Measured on Claude
  Code 2.1.283 on 2026-09-28: a `cd` into a working folder listed only there
  is still in effect on the next Bash call, with no reset, so the hook's
  input `cwd` follows the agent into it. A working folder can hold other
  Rundock workspaces (a parent of several is common), so another
  workspace's `.rundock/permissions.json` and `.rundock/state.json` are
  answer files wherever they sit, and its `.claude/agents/` and
  `.claude/skills/` always ask: Rundock spawns agents with `--agent`, and
  Claude Code acts on agent and skill frontmatter (`hooks`,
  `permissionMode`, `allowed-tools`, `mcpServers`) without a card. Another
  workspace's `CLAUDE.md`, `AGENTS.md` and `.claude/rules/` are ordinary
  instruction files: they carry no such keys. The current workspace's
  `.claude/settings.json` is an answer file too, since it can carry hooks
  and permission rules. The hook reads the command a tool call carries, not
  what a script does once it runs, so a write made inside `node -e` or a
  script never meets it; the workspace's own permission files are therefore
  also watched during every Claude turn, direct chats, delegates and
  routines alike (`lib/runtime/claude-turn-guard.js`): a change Rundock did
  not make is put back at once and offered on the answer-file card. The
  comparison is against a baseline kept for as long as Rundock runs, so a
  change made while no turn is running (a job an agent left behind, or an
  edit by hand) is put back, and asked about, when the next turn starts.
- Codex: OS sandbox (Seatbelt/Landlock, or the Windows sandbox when
  configured) + protocol approval requests for escalations; on Windows
  without the sandbox, everything escalates. Escalations are graded in
  process (`lib/runtime/codex-approval.js`) by the rules Claude Code agents
  meet: in Code mode a command the verdict says runs is answered `accept`
  with no card (never `acceptForSession`), and in both modes a file change
  inside the workspace or a working folder is accepted with no card. An
  escalation that touches the workspace's own permission files is always
  the answer-file card, and because such a write inside the workspace
  never escalates at all (measured, and no thread option stops it), those
  files are watched during every Codex turn, against the same baseline: a
  change Rundock did not make is put back at once and offered on the
  answer-file card (`lib/workspace/answer-file-guard.js`). A request to widen Codex's own
  permission profile (`item/permissions/requestApproval`) is always
  refused at once with an empty grant for the turn, and the conversation is
  told. Measured against codex-cli 0.156.1: under `on-request` Codex never
  sends it (it asks for an ordinary command approval instead), and the
  granular approval policy that would enable it is rejected unless the
  client opts into the experimental API, which Rundock never does. Working folders are deliberately not writable
  roots, so writes there keep escalating and keep being graded. Two gaps
  remain and are stated plainly: a delete inside the workspace itself runs
  inside Codex's sandbox without escalating, and reads anywhere never
  escalate, so a read of `~/.ssh` under Codex raises no card.

### 4. Status detection

Installed / signed in / version, from evidence only: binary resolution,
presence of credential files (never their contents), version probes.
Surfaces in Settings with the evidence model in tooltips. See
`detectCodex` in `codex.js` and the Claude probe in `getRuntimeStatus`.

### 5. Thread resume

Conversations outlive processes and server restarts. The runtime must
resume a thread from a stored id, with context intact, after both the
runtime process and Rundock itself have restarted. The id rides the same
client rails for every runtime (`system/init` out, `msg.sessionId` back).

## What a third runtime would add

One module (the `codex.js`/`codex-appserver.js` shape): detection,
spawn/turn execution, event normalisation, error classification. One
routing branch where the server picks a runtime by the agent's `runtime:`
frontmatter field. No client changes: the client speaks envelopes, not
runtimes. The orchestrator requires a runtime with a native agent-routing
tool (Claude Code today; enforced in discovery, documented as a capability
rather than a hardcode).
