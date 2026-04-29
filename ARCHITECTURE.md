# Rundock architecture

Rundock is a local Node.js server that exposes a vanilla-JS browser client over WebSocket and orchestrates Claude Code subprocesses to do the actual AI work. There is no cloud component, no database, and no build step. The whole stack runs on your machine and reaches Anthropic only through Claude Code, which you authenticate yourself.

This document describes the process model, the workspace directory layout, and the codebase, in enough detail that a contributor can navigate the source after reading once. Implementation detail is left to the code; this document covers shape, boundaries, and where to look.

## The process model

Rundock has three classes of process at runtime.

```
+---------------------+        WebSocket         +---------------------+
|                     |  <-------------------->  |                     |
|   Browser client    |                          |   Node.js server    |
|   (public/app.js)   |   HTTP for assets and    |   (server.js)       |
|                     |   permission decisions   |                     |
+---------------------+                          +----------+----------+
                                                            |
                                                            | spawn / stream-json
                                                            v
                                              +-----------------------------+
                                              |   Claude Code subprocesses  |
                                              |   (one per active agent)    |
                                              +-----------------------------+
```

### The browser client

The browser is the visual interface. It renders the org chart, the conversation panel, the sidebar of past conversations, the file browser, the settings drawer, and the permission cards that pop up when an agent wants to run a tool. It holds no authoritative state. Reload it and the server still owns every conversation, every transcript, every running subprocess.

The client opens a single WebSocket to the server on load and uses HTTP for static assets and a small number of synchronous endpoints (workspace picker, permission decisions, agent listing). All ongoing conversation traffic flows over the WebSocket.

### The Node.js server

`server.js` is the single server entry point. It does seven things, in roughly this order of importance.

1. **Discovers agents and skills** by reading the workspace directory (`.claude/agents/`, `.claude/skills/`, `System/Playbooks/`). See `discoverAgents` and `discoverSkills`.
2. **Spawns and manages Claude Code subprocesses.** Each active conversation has at most one running Claude Code child process at a time. The server tracks them in a `processes` map keyed by conversation ID.
3. **Bridges browser and Claude Code** by translating WebSocket messages from the client into stdin writes on the right subprocess, and by parsing the subprocess's stream-json stdout back into client-facing events.
4. **Intercepts delegation** so that when an orchestrator emits an Agent tool call, the server kills the orchestrator process, spawns the specialist with the right context, and streams the specialist's output to the client under the specialist's identity. See the next section.
5. **Persists conversation state** to `.rundock/` in the workspace (conversations index, transcripts, child PIDs, settings).
6. **Runs a lightweight scheduler** for routines defined in agent frontmatter. Every minute, it checks each agent's routines and invokes any whose schedule has come due.
7. **Mediates tool permissions.** Claude Code's PreToolUse hook calls back to the server over HTTP for any tool call that needs approval; the server forwards the request to the browser as a permission card and returns the user's decision to Claude Code.

The server uses Node's native `http` module and the `ws` library for WebSocket. The runtime dependency surface is intentionally small: two production dependencies (`ws` and `marked`).

### Claude Code subprocesses

Every conversation that is actively producing tokens has a Claude Code child process attached to it. Rundock spawns the process with `claude` configured to read from the workspace directory, with the workspace's `.mcp.json` for MCP servers, with the workspace's `.claude/settings.local.json` for hooks, and with the agent's name passed so Claude Code loads the right system prompt from `.claude/agents/<slug>.md`.

The subprocess speaks **stream-json** on stdout: a sequence of newline-delimited JSON events (assistant tokens, tool calls, tool results, system events). The server reads this stream line by line and forwards relevant events to the browser as WebSocket messages.

The subprocess's working directory is the workspace. Its file access, tool availability, and permissions are governed by Claude Code itself, not by Rundock. Rundock can only configure the spawn arguments and intercept the streamed output.

### Conversations: resume vs spawn fresh

Each Rundock conversation has its own Claude Code session ID. When a user opens a past conversation and sends a new message, the server spawns Claude Code with `--resume <sessionId>` so the model picks up the existing transcript from Claude Code's JSONL file. When a user starts a new conversation, the server spawns a fresh Claude Code subprocess and records the new session ID for next time.

Resume works because Claude Code persists every session as a JSONL transcript in the user's home directory (see The .rundock workspace directory, below). Rundock does not store conversation message content itself; it stores enough metadata to find and resume each session.

### Delegation: how the orchestrator hands off to a specialist

The delegation handoff works in five steps:

1. The orchestrator's Claude Code subprocess emits an Agent tool call event in its stream-json output, with the target specialist's slug as the argument.
2. The server detects the Agent tool call and treats it as a handoff signal. It kills the orchestrator's subprocess with `SIGKILL` so no further output reaches the client under the orchestrator's identity.
3. The server emits a `system: agent_switch` event to the client. The browser updates the conversation header and sidebar to show the specialist as the active agent.
4. The server spawns a new Claude Code subprocess with the specialist's slug. It passes a context block containing the conversation transcript so the specialist sees what happened before they were called.
5. The specialist's stream-json output flows back through the same bridge as the orchestrator's. The specialist signals completion with a `RUNDOCK:COMPLETE` or `RUNDOCK:RETURN` marker in its final response. On COMPLETE the work is done; on RETURN the server spawns the orchestrator again so it can pick up where it left off or hand off elsewhere.

This interception model is what makes "delegation that happens in front of you" visible. The agent name in the conversation header changes mid-stream, the sidebar updates, and the user sees specialists arrive without lifting a finger.

## The .rundock workspace directory

When Rundock first opens a workspace, it creates a `.rundock/` directory at the workspace root. This holds Rundock's own session state. It is added to `.gitignore` automatically on creation.

Contents:

| File or directory | Purpose |
|---|---|
| `state.json` | Workspace-level settings: setup completion flag, workspace mode (Knowledge or Code), version. |
| `conversations.json` | Index of every Rundock conversation: ID, title, owning agent, last Claude Code session ID, timestamps. |
| `transcripts/<convoId>.json` | Lightweight conversation transcript for fast UI replay (role, agent, text). Capped to keep file size reasonable. |
| `child-pids.json` | Running Claude Code subprocess PIDs, used to clean up zombie processes on server restart. |

What does **not** live in `.rundock/`:

- **Full message content.** The complete model output, tool calls, and tool results live in Claude Code's own JSONL transcripts at `~/.claude/projects/<projectHash>/<sessionId>.jsonl`. Rundock keeps a slimmer copy in `transcripts/` for UI replay, but the source of truth for the actual conversation is Claude Code's JSONL.
- **Theme and UI preferences.** These live in browser local storage. They do not sync between machines.
- **Agent and skill files.** These live in the workspace under `.claude/agents/` and `.claude/skills/`. Rundock reads them; it does not store them in `.rundock/`.

This split matters because it means Rundock's persistence layer is small and easy to reason about. The expensive thing (every token of every conversation) is owned by Claude Code, which Rundock does not need to replicate or back up.

## File system layout per workspace

A workspace is any directory that contains, or is intended to contain, Claude Code agents. Rundock looks for these specific things:

| Path | Required | Purpose |
|---|---|---|
| `CLAUDE.md` | Recommended | Workspace-level rules and context. Loaded by Claude Code with every spawn. Used to derive the default agent identity if no agent files exist. |
| `.claude/agents/*.md` | Yes for a Rundock-ready workspace | Agent files. One file per agent. See AGENTS.md for the frontmatter reference. |
| `.claude/skills/<slug>/SKILL.md` | Optional | Skills the agents can use. Rundock matches them to agents either by explicit `skills:` frontmatter or by body-text mention of the slug. |
| `System/Playbooks/<slug>/PLAYBOOK.md` | Optional | Alternative skill location, scanned alongside `.claude/skills/`. Used by Personal OS-style workspaces that pre-date the standard skill location. |
| `.claude/settings.local.json` | Optional | Hooks and per-workspace Claude Code settings. Forwarded to spawned subprocesses. |
| `.mcp.json` | Optional | MCP server configuration. Forwarded to spawned subprocesses. |
| `.rundock/` | Created on first run | Rundock's own session state. See above. Auto-added to `.gitignore`. |

A workspace can also contain any other user files at the root or in subfolders. Rundock does not require a particular folder layout outside of the paths above. The browser's file panel reads from the workspace root and respects `.gitignore`.

## The codebase at a glance

Three source files, two production dependencies, no bundler.

| File | Approximate size | What it owns |
|---|---|---|
| `server.js` | ~3,800 lines | HTTP and WebSocket server. Agent and skill discovery. Frontmatter parsing. Subprocess spawn and stdin/stdout bridging. Delegation interception. Conversation persistence. Routine scheduler. Permission mediation. |
| `public/app.js` | ~3,100 lines | Single-page client. WebSocket client. Conversation rendering. Streaming token display. Org chart. Sidebar. File browser. Settings drawer. Permission card UI. Markdown editor (Tiptap-based) for inline editing. |
| `public/index.html` | ~660 lines | Layout, CSS, and markup. Nav rail, sidebar, main panel. No external stylesheet. |

**Production dependencies:** `ws` for WebSocket, `marked` for markdown rendering in conversation messages. Nothing else.

**Build artefacts:** none. `npm start` runs `node server.js` directly. There is no transpilation, no bundling, no minification step. If you change a file in `public/`, reload the browser. If you change `server.js`, restart the server.

**Where things are:**

- Agent discovery: `discoverAgents` in `server.js`. Reads `.claude/agents/*.md`, parses frontmatter, classifies each agent as `onTeam` (has `order`), `available` (has `type` but no order), or `raw` (neither, a bare Claude Code agent).
- Frontmatter parsing: `parseAgentFrontmatter`, `parseCapabilities`, `parseRoutines`, `parsePrompts`, `parseSkills` in `server.js`. Hand-rolled YAML subset, intentionally lenient.
- Skill discovery: `discoverSkills` in `server.js`. Scans both `.claude/skills/` and `System/Playbooks/`. Matches skills to agents via the explicit `skills:` array first, then falls back to body-text scanning for the slug.
- Subprocess spawn: `spawn` calls in `server.js` configured with `getBareArgs()` for workspace context flags and `getSpawnEnv()` for environment variables (workspace mode, conversation ID).
- Delegation interception: search `server.js` for `agent_switch` and `delegateProcess`. The interception happens inside the stream-json line handler.
- Markdown editor in the client: search `public/app.js` for the Tiptap initialisation. Used for inline editing of agent files, skill files, and other markdown.

## Delegation interception, briefly

Mechanically, the orchestrator-to-specialist handoff is a kill-and-respawn:

1. Orchestrator subprocess emits an Agent tool call.
2. Server detects it, kills the orchestrator process with `SIGKILL`, persists the orchestrator's last response to the transcript before the kill takes effect.
3. Server emits an `agent_switch` event over the WebSocket. The client redraws under the specialist.
4. Server spawns the specialist subprocess with the conversation history attached as the initial context.
5. Specialist runs to completion, emits `RUNDOCK:COMPLETE` or `RUNDOCK:RETURN`. On RETURN, the server spawns the orchestrator again so the conversation can continue.

The key design choice is that delegation looks like a real handoff to the user, not like a function call. The specialist runs in its own subprocess with its own system prompt and its own slice of context. The orchestrator does not stay alive while the specialist is working.

## What Rundock does NOT do

- **No backend service.** Rundock runs entirely on your machine. There is nothing to deploy and no account to create.
- **No database.** Persistence is JSON files in `.rundock/` and Claude Code's own JSONL transcripts. No SQLite, no Postgres, no key-value store.
- **No telemetry.** Rundock does not phone home, does not log usage to a remote service, does not collect crash reports. The two-dependency footprint makes this easy to verify.
- **No outbound network calls from Rundock itself.** The only external connection is from Claude Code (a separate tool you installed and authenticated yourself) to Anthropic's API. Rundock does not make HTTP requests to Anthropic, does not handle API keys, and does not see your Claude credentials.
- **No agent-format reinvention.** Agent files use Claude Code's standard format with optional Rundock extension fields. An agent file written for Rundock works in plain Claude Code; an agent file written for Claude Code works in Rundock with reduced UI affordances. See AGENTS.md.

## Pointers

- [CONTRIBUTING.md](CONTRIBUTING.md): dev environment setup, code conventions, changelog standards, pull request guidelines.
- [CHANGELOG.md](CHANGELOG.md): release history.
- [AGENTS.md](AGENTS.md): the agent file format reference. Frontmatter fields, the markdown body, workspace modes, and a complete example.
- [LICENSE](LICENSE): PolyForm Perimeter 1.0.0.
