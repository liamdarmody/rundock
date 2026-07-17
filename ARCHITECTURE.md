# Rundock architecture

Rundock is a local Node.js server that exposes a vanilla-JS browser client over WebSocket and orchestrates runtime subprocesses (Claude Code by default; optionally the Codex CLI) to do the actual AI work. There is no cloud component, no server-side database, and no build step. The whole stack runs on your machine and reaches each provider only through its own CLI (Anthropic via Claude Code, OpenAI via Codex), which you authenticate yourself.

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
                                              |    runtime subprocesses     |
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

The server uses Node's native `http` module and the `ws` library for WebSocket. The runtime dependency surface is intentionally small: three production dependencies (`ws`, `marked`, and `electron-updater` for the packaged app's auto-update).

### Runtime subprocesses

Every conversation that is actively producing tokens has a runtime child process attached to it. For Claude Code agents (the default), Rundock spawns `claude` configured to read from the workspace directory, with the workspace's `.mcp.json` for MCP servers, with the workspace's `.claude/settings.local.json` for hooks, and with the agent's name passed so Claude Code loads the right system prompt from `.claude/agents/<slug>.md`.

Agents with `runtime: codex` run on the official Codex CLI instead, through ONE long-lived `codex app-server` process shared by the whole server (spawned lazily on the first Codex turn, supervised with restart-on-crash by `codex-appserver.js`). Each Codex conversation is a thread on that process and each message a streamed turn, with conversation continuity through thread resume and the agent's instructions carried in the first-turn prompt (Codex has no `--agent` equivalent). Codex agents use Codex's own sandbox (workspace-write, approvals on-request); sandbox escalations arrive as per-action approval requests that render as Rundock permission cards. The orchestrator always runs on Claude Code (delegation works through the Agent tool in Claude Code's stream, which Codex does not have). Environment detection and failure classification live in `codex.js`.

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
| `search-index.db` | SQLite FTS5 index behind universal search (plus its `-wal`/`-shm` journal files). A **derived artifact**: delete it and the next workspace open rebuilds it from the files and transcripts it indexes. Never a source of truth. See Universal search, below. |

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

A handful of source files, three production dependencies, no bundler.

| File | Approximate size | What it owns |
|---|---|---|
| `server.js` | ~5,100 lines | HTTP and WebSocket server. Agent and skill discovery. Frontmatter parsing. Subprocess spawn and stdin/stdout bridging. Delegation interception. Conversation persistence. Routine scheduler. Permission mediation. Universal search wiring (engine lifecycle, reconcile triggers, the `search_universal` and `search_conversations` handlers, grep fallback). |
| `search.js` | ~750 lines | The universal search engine: SQLite FTS5 index over workspace files and conversation transcripts, query sanitisation, fuzzy title scoring. Pure module: no WebSocket, no globals, fully unit-testable. See Universal search, below. |
| `codex.js` | ~200 lines | Codex runtime support: binary/auth/Windows-sandbox detection, thread-id hygiene, error classification, rollout-file resolution. Pure module, fully unit-testable. |
| `codex-appserver.js` | ~640 lines | The Codex app-server protocol client and supervisor: one long-lived `codex app-server` process serves every Codex conversation (JSON-RPC over stdio), with streamed turns, first-class approval requests, interrupt, crash restart, and pinned policy invariants. Pure module, fully unit-testable against the protocol stub. |
| `public/app.js` | ~4,400 lines | Single-page client. WebSocket client. Conversation rendering. Streaming token display. Org chart. Sidebar. File browser. Settings drawer. Permission card UI. Search palette (Cmd+K). |
| `public/editor/` | ~2,600 lines | The rich markdown editor (Tiptap-based): tables with byte-exact source preservation, CriticMarkup review annotations, the review panel, and the round-trip pipeline. |
| `public/index.html` | ~900 lines | Layout, CSS, and markup. Nav rail, sidebar, main panel, search palette. No external stylesheet. |

**Production dependencies:** `ws` for WebSocket, `marked` for markdown rendering in conversation messages, `electron-updater` for the packaged app. Nothing else.

**Build artefacts:** none. `npm start` runs `node server.js` directly. There is no transpilation, no bundling, no minification step. If you change a file in `public/`, reload the browser. If you change `server.js`, restart the server.

**Where things are:**

- Agent discovery: `discoverAgents` in `server.js`. Reads `.claude/agents/*.md`, parses frontmatter, classifies each agent as `onTeam` (has `order`), `available` (has `type` but no order), or `raw` (neither, a bare Claude Code agent).
- Frontmatter parsing: `parseAgentFrontmatter`, `parseCapabilities`, `parseRoutines`, `parsePrompts`, `parseSkills` in `server.js`. Hand-rolled YAML subset, intentionally lenient.
- Skill discovery: `discoverSkills` in `server.js`. Scans both `.claude/skills/` and `System/Playbooks/`. Matches skills to agents via the explicit `skills:` array first, then falls back to body-text scanning for the slug.
- Subprocess spawn: `spawn` calls in `server.js` configured with `getBareArgs()` for workspace context flags and `getSpawnEnv()` for environment variables (workspace mode, conversation ID).
- Delegation interception: search `server.js` for `agent_switch` and `delegateProcess`. The interception happens inside the stream-json line handler.
- Markdown editor in the client: search `public/app.js` for the Tiptap initialisation. Used for inline editing of agent files, skill files, and other markdown.
- Search engine: `search.js` (the whole file; its header comment records the design decisions). Server wiring: `ensureSearchEngine`, `reconcileSearchBeforeQuery`, `runUniversalSearch` in `server.js`. Client palette: search `public/app.js` for `openPalette`.

## Delegation interception, briefly

Mechanically, the orchestrator-to-specialist handoff is a kill-and-respawn:

1. Orchestrator subprocess emits an Agent tool call.
2. Server detects it, kills the orchestrator process with `SIGKILL`, persists the orchestrator's last response to the transcript before the kill takes effect.
3. Server emits an `agent_switch` event over the WebSocket. The client redraws under the specialist.
4. Server spawns the specialist subprocess with the conversation history attached as the initial context.
5. Specialist runs to completion, emits `RUNDOCK:COMPLETE` or `RUNDOCK:RETURN`. On RETURN, the server spawns the orchestrator again so the conversation can continue.

The key design choice is that delegation looks like a real handoff to the user, not like a function call. The specialist runs in its own subprocess with its own system prompt and its own slice of context. The orchestrator does not stay alive while the specialist is working.

## Universal search, briefly

Universal search (the Cmd+K palette) queries four corpora: workspace files, conversations, agents, and skills. Files and conversations are indexed in SQLite FTS5 (`search.js`, using Node's built-in `node:sqlite`: no native dependency); agents and skills are tiny corpora filtered in memory at query time, so they can never go stale.

The things worth knowing that no single file states:

- **The index is a derived artifact.** `.rundock/search-index.db` rebuilds from workspace files and Claude Code's JSONL transcripts. There are no schema migrations: a `SCHEMA_VERSION` bump or a corrupt file deletes the database and rebuilds. Deleting it by hand is always safe.
- **Four reconcile triggers** keep it fresh: workspace open (`ensureSearchEngine`, synchronous full pass), every search (`reconcileSearchBeforeQuery`: conversations always, files behind a 2-second TTL), the `save_file` handler (immediate single-file index), and the end of every agent turn (`appendTranscript` → `noteSearchConversationActivity`).
- **Claude Code's JSONL stays the source of truth for conversations.** The indexer reads deltas past a per-session byte offset (append-only files make this safe); each session's delta lands in one transaction so a crash can never leave duplicate rows.
- **Session ownership is mark-authoritative.** A session's `session_marks` row decides which conversation owns it; `conversations.json` order is not trusted (new entries are unshifted to the head, so order-derived ownership would flip).
- **The grep fallback.** On runtimes without `node:sqlite` (Node 20/21), a capability probe routes every query to a bounded grep path instead. Search degrades; it never hard-fails. `RUNDOCK_SEARCH_DISABLE_SQLITE=1` forces this path for testing.
- **Trust boundary:** user queries never reach FTS5 as syntax (the sanitiser emits only quoted terms), and snippets carry control-character highlight markers that the client swaps for `<mark>` only after HTML-escaping.

The engine is exercised by `test/unit/search-*.test.js` (including a 10k-message performance suite) and `test/integration/search*.test.js`.

## Auditing the trust claims

The licence invites you to fork Rundock and audit it. If you take that up, the claims on the trust page reduce to a small set of named places; this is the ten-minute guided path.

- **"Every risky action asks the human first."** The permission decision path spans three layers, and all three are inspectable: the PreToolUse hook script (`scripts/` — what Claude Code consults before any tool runs), the server bridge (`server.js`: `/api/permission-request` for hook-originated requests, `requestServerPermission` for server-originated ones, both with a hard timeout that fails closed), and the client decision module **`public/permissions.js`** — the risk classification, the low-risk read-only auto-approve policy, and the rule that high-risk requests never offer a standing "Always allow" all live there, unit-tested and findable by name.
- **"Codex agents are sandboxed, and where the sandbox cannot protect you, you approve each action."** The sandbox request and the never-bypassed flags are pinned in `test/integration/spawn-argv-freeze.test.js` (no full-access sandbox, approvals reviewer is always the user, no experimental API surface). Approval requests arrive over the app-server protocol and route through the same permission cards: `handleCodexApproval` in `server.js`, decisions mapped in one place. Platform status detection (installed / signed in / Windows sandbox) is presence-only evidence: `detectCodex` and `hasWindowsSandboxConfig` in `codex.js` never read credential files, only check they exist.
- **"Rundock itself makes no outbound network calls."** The dependency footprint is three production packages (`package.json`); the runtimes (Claude Code, Codex CLI) are separate tools you installed and authenticated yourself, spawned as subprocesses: `spawnClaude` and `getCodexAppServer` in `server.js` are the only spawn sites.
- **"Agents cannot impersonate teammates."** The off-roster delegation block lives in the delegation interception path (`server.js`, search for the blocked-handoff notice); the orchestrator-runtime enforcement is in agent discovery.

## What Rundock does NOT do

- **No backend service.** Rundock runs entirely on your machine. There is nothing to deploy and no account to create.
- **No database as a source of truth.** Persistence is JSON files in `.rundock/` and Claude Code's own JSONL transcripts. The one SQLite file (`search-index.db`, behind universal search) is a derived, disposable index rebuilt from those sources: nothing to migrate, nothing to back up, nothing lost if it is deleted. It uses Node's built-in `node:sqlite`, so it adds no dependency.
- **No telemetry.** Rundock does not phone home, does not log usage to a remote service, does not collect crash reports. The three-dependency footprint makes this easy to verify.
- **No outbound network calls from Rundock itself.** The only external connection is from Claude Code (a separate tool you installed and authenticated yourself) to Anthropic's API. Rundock does not make HTTP requests to Anthropic, does not handle API keys, and does not see your Claude credentials.
- **No agent-format reinvention.** Agent files use Claude Code's standard format with optional Rundock extension fields. An agent file written for Rundock works in plain Claude Code; an agent file written for Claude Code works in Rundock with reduced UI affordances. See AGENTS.md.

## Pointers

- [CONTRIBUTING.md](CONTRIBUTING.md): dev environment setup, code conventions, changelog standards, pull request guidelines.
- [CHANGELOG.md](CHANGELOG.md): release history.
- [AGENTS.md](docs/AGENTS.md): the agent file format reference. Frontmatter fields, the markdown body, workspace modes, and a complete example.
- [LICENSE](LICENSE): PolyForm Perimeter 1.0.0.
