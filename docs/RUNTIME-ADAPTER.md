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

- Claude Code: the PreToolUse permission hook (all platforms).
- Codex: OS sandbox (Seatbelt/Landlock, or the Windows sandbox when
  configured) + protocol approval requests for escalations; on Windows
  without the sandbox, everything escalates.

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
