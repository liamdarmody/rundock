# Codex CLI app-server protocol research (R10 Phase 0)

**Researched:** 2026-07-17
**CLI tested:** `codex-cli 0.144.3` (arm64 Mach-O at `/Users/liamdarmody/.local/bin/codex`)
**Method:** live protocol probes over stdio (handshake, thread/list, thread/start, thread/resume of an exec-created thread, one tiny turn round-trip, error probes) plus the CLI's own generated protocol schema (`codex app-server generate-json-schema` and `generate-ts`), the openai/codex repo README (`codex-rs/app-server/README.md`), and the official docs (developers.openai.com/codex/app-server, which now 308-redirects to learn.chatgpt.com/docs/app-server).

Generated schema artefacts staged at `/tmp/codex-appserver-research/json-schema/` (per-message JSON Schemas, plus full bundles `codex_app_server_protocol.schemas.json` and `codex_app_server_protocol.v2.schemas.json`) and `/tmp/codex-appserver-research/ts-bindings/` (89 TypeScript files, `ClientRequest.ts` is the full method-to-params map). Probe scripts: `probe.py`, `probe_turn.py`, `probe_list.py` in the same directory.

---

## 1. Invocation and transport

**Subcommand:** `codex app-server` (marked `[experimental]` in help text). No further flags needed for stdio.

**Transports** (via `--listen <URL>`):
- `stdio://` (default; `--stdio` is an alias)
- `unix://PATH` (websocket over unix socket via HTTP Upgrade)
- `ws://IP:PORT` (README: "experimental and unsupported. Do not rely on it for production workloads."; non-loopback requires `--ws-auth capability-token|signed-bearer-token` plus token flags)
- `off`

**Framing: newline-delimited JSON (JSONL). One JSON-RPC 2.0 message per line. No Content-Length / LSP framing.** Verified live.

**Wire quirk (verified):** the server omits the `"jsonrpc":"2.0"` field on everything it sends. Responses look like `{"id":1,"result":{...}}`, notifications like `{"method":"...","params":{...}}`. The repo README confirms this is by design ("the `jsonrpc":"2.0"` header is omitted on the wire"). The server accepts client messages with or without the field. Do not write a strict JSON-RPC parser that requires `jsonrpc`.

**Related subcommands:**
- `codex app-server daemon start|stop|restart|version|bootstrap` manages a long-lived shared daemon (`daemon version` prints local CLI and running server versions as JSON, useful for version checks).
- `codex app-server proxy` bridges stdio to a running daemon's control socket.
- `codex remote-control start|stop|pair` runs the daemon with remote control enabled (this is what the mobile/remote clients use).
- `codex app-server generate-ts --out DIR` / `generate-json-schema --out DIR` emit the protocol types **for the installed version** (add `--experimental` to include gated methods). This is the canonical version-pinning artefact.

Server-level config overrides: `-c key=value` (same as every codex subcommand), `--strict-config` to hard-fail on unknown config keys.

**Overload behaviour (repo README):** when overloaded the server rejects requests with error code `-32001`, message "Server overloaded; retry later." Clients should back off with jitter.

---

## 2. Handshake / initialization

Exactly one `initialize` request must be sent before anything else; the server rejects other requests until it completes. Then send the `initialized` **notification**.

Request (verified):
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "clientInfo": {"name": "rundock", "title": "Rundock", "version": "0.0.1"},
  "capabilities": {
    "experimentalApi": false,
    "optOutNotificationMethods": null,
    "requestAttestation": false
  }
}}
```
`clientInfo.name` and `.version` are required; `title` optional. Capabilities (all optional):
- `experimentalApi` (bool, default false): opt into experimental methods/fields. Server rejects experimental methods without it.
- `optOutNotificationMethods` (string[]): exact notification method names to suppress on this connection (e.g. `"thread/started"`). Useful to silence noise like `account/rateLimits/updated`.
- `requestAttestation`, `mcpServerOpenaiFormElicitation`: niche, ignore.

Response (verbatim from live probe):
```json
{"id":1,"result":{
  "userAgent":"rundock-probe/0.144.3 (Mac OS 26.4.1; arm64) Apple_Terminal/470 (rundock-probe; 0.0.1)",
  "codexHome":"/Users/liamdarmody/.codex",
  "platformFamily":"unix",
  "platformOs":"macos"
}}
```

Then:
```json
{"jsonrpc":"2.0","method":"initialized"}
```

**There is no numeric protocol version negotiation.** The only version signal is the CLI version embedded in `userAgent` (the `0.144.3` after your client name) and `Thread.cliVersion` on thread objects. Capabilities gate experimental surface; the stable surface simply changes between CLI releases. See section 10.

After `initialized`, the server pushes a `remoteControl/status/changed` notification unprompted; expect and ignore unknown notifications generally.

---

## 3. Thread lifecycle

Model: **Thread** (conversation) contains **Turns** (one user input to agent completion) which contain **Items** (messages, command executions, file changes, reasoning, tool calls).

### Create: `thread/start`
Params (all optional): `cwd`, `model`, `modelProvider`, `approvalPolicy`, `sandbox` (`"read-only" | "workspace-write" | "danger-full-access"`), `approvalsReviewer` (`"user" | "auto_review"`), `baseInstructions`, `developerInstructions`, `config` (arbitrary config.toml override map), `ephemeral` (bool, thread not persisted to disk), `personality`, `serviceTier`.

Verified round-trip:
```json
{"jsonrpc":"2.0","id":3,"method":"thread/start","params":{"cwd":"/tmp/x","approvalPolicy":"on-request","sandbox":"workspace-write"}}
```
Response contains the effective settings and the thread object:
```json
{"id":3,"result":{
  "thread":{"id":"019f6d31-12cf-7fe3-b5e3-5bb0382e64cb","sessionId":"019f6d31-...","status":{"type":"idle"},
            "path":"/Users/liamdarmody/.codex/sessions/2026/07/17/rollout-2026-07-17T00-09-20-019f6d31-....jsonl",
            "cwd":"/tmp/x","cliVersion":"0.144.3","source":"vscode","turns":[], "...":"..."},
  "model":"gpt-5.6-sol","modelProvider":"openai","cwd":"/tmp/x",
  "runtimeWorkspaceRoots":["/tmp/x"],
  "approvalPolicy":"on-request","approvalsReviewer":"user",
  "sandbox":{"type":"workspaceWrite","writableRoots":[],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false},
  "reasoningEffort":null}}
```
A `thread/started` notification also fires. Thread ids are UUIDv7.

### Resume: `thread/resume`
Params: `threadId` (required) plus the same optional overrides as `thread/start` (model, cwd, sandbox, approvalPolicy, config, ...).

**Interop with `codex exec` thread ids: VERIFIED YES.** Both write rollout files to `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` and share the state db. A thread id taken from a `codex exec --json` run four days earlier resumed cleanly in a freshly spawned app-server process, returning the full `Thread` with `turns[]` populated (including prior token usage via a `thread/tokenUsage/updated` notification). Your stored `codex exec` thread ids carry over unchanged.

**Resume survives server restarts: VERIFIED.** Persistence is on disk (rollout JSONL plus sqlite state db under `CODEX_HOME`), not in server memory. Kill the process, start a new one, `thread/resume` works.

`Thread.turns` is only populated on `thread/resume`, `thread/rollback`, `thread/fork`, and `thread/read` (with `includeTurns: true`) responses; everywhere else it is `[]`.

### Send a turn: `turn/start`
```json
{"jsonrpc":"2.0","id":4,"method":"turn/start","params":{
  "threadId":"019f6d32-...","input":[{"type":"text","text":"Reply with exactly one word: pong"}]}}
```
`input` is an array of `UserInput` variants: `{type:"text", text}` | `{type:"image", url}` | `{type:"localImage", path}` | `{type:"skill", name, path}` | `{type:"mention", name, path}`. Per-turn optional overrides: `model`, `cwd`, `effort` (reasoning effort), `summary` (reasoning summary: `auto|concise|detailed|none`), `approvalPolicy`, `sandboxPolicy` (full object form, see section 8), `outputSchema` (structured output), `clientUserMessageId`.

Immediate response: `{"id":4,"result":{"turn":{"id":"<uuidv7>","items":[],"itemsView":"notLoaded","status":"inProgress",...}}}`. Everything else streams as notifications (section 4).

### Interrupt: `turn/interrupt`
Params `{threadId, turnId}` (turnId comes from the `turn/start` response or `turn/started` notification). Response is `{}`; the turn then completes with `status:"interrupted"` in `turn/completed`. There is also `turn/steer` `{threadId, turnId?, input}` to append input to the active turn without interrupting; if the turn cannot accept it you get the `activeTurnNotSteerable` error.

### Housekeeping
`thread/read {threadId, includeTurns}`, `thread/list`, `thread/fork`, `thread/archive` / `thread/unarchive`, `thread/delete`, `thread/name/set`, `thread/compact/start`, `thread/rollback`, `thread/unsubscribe` (per-connection unsubscribe; docs: after all connections unsubscribe, a 30-minute inactivity grace period runs before the thread unloads).

**`thread/list` gotcha (verified):** with default params it did NOT return `codex exec`-created threads; it returned only app-server-created ones. Pass `sourceKinds` explicitly: enum values are `"cli","vscode","exec","appServer","subAgent","subAgentReview","subAgentCompact","subAgentThreadSpawn","subAgentOther","unknown"`. `{"limit":3,"sourceKinds":["exec"]}` returned the exec threads. Note app-server-created threads are recorded with `source:"vscode"` in 0.144.3 (historical artefact). `thread/resume` by id works regardless of source.

---

## 4. Streaming notifications during a turn

Verbatim sequence from the live tiny turn (one text prompt, no tools):

```
turn/start response          {"id":3,"result":{"turn":{"id":"<turnId>","status":"inProgress",...}}}
thread/status/changed        {"threadId":T,"status":{"type":"active","activeFlags":[]}}
turn/started                 {"threadId":T,"turn":{"id":U,"status":"inProgress","startedAt":1784243453,...}}
item/started                 {"item":{"type":"userMessage","id":"019f...","content":[{"type":"text","text":"...","text_elements":[]}]},"threadId":T,"turnId":U,"startedAtMs":1784243455011}
item/completed               (same userMessage item, "completedAtMs":...)
item/started                 {"item":{"type":"agentMessage","id":"msg_0714...","text":"","phase":"final_answer","memoryCitation":null},"threadId":T,"turnId":U,"startedAtMs":...}
item/agentMessage/delta      {"threadId":T,"turnId":U,"itemId":"msg_0714...","delta":"pong"}
item/completed               {"item":{"type":"agentMessage","id":"msg_0714...","text":"pong","phase":"final_answer",...},"threadId":T,"turnId":U,"completedAtMs":...}
thread/tokenUsage/updated    {"threadId":T,"turnId":U,"tokenUsage":{"total":{"totalTokens":13192,"inputTokens":13187,"cachedInputTokens":9984,"outputTokens":5,"reasoningOutputTokens":0},"last":{...same...},"modelContextWindow":258400}}
account/rateLimits/updated   {"rateLimits":{"limitId":"codex","primary":{"usedPercent":0,"windowDurationMins":10080,"resetsAt":...},"credits":{...},"planType":"plus",...}}
thread/status/changed        {"threadId":T,"status":{"type":"idle"}}
turn/completed               {"threadId":T,"turn":{"id":U,"items":[],"itemsView":"notLoaded","status":"completed","error":null,"startedAt":1784243453,"completedAt":1784243457,"durationMs":3581}}
```

**Agent message text deltas, exact shape:**
- Method: `item/agentMessage/delta`
- Params: `{threadId: string, turnId: string, itemId: string, delta: string}` (all required)
- The full accumulated text also arrives in the `item/completed` payload (`item.text`), so you can either accumulate deltas or take the completed item as authoritative.
- `agentMessage.phase` can distinguish streamed phases (observed `"final_answer"`; schema also allows other phases such as commentary/planning output).

Other item/turn notifications (from `ServerNotification` schema, all carry `threadId`/`turnId`/`itemId` where relevant):
- `item/started`, `item/completed`, `item/updated` does not exist; updates are per-type deltas
- `item/reasoning/textDelta` `{contentIndex, delta, itemId, threadId, turnId}` (raw CoT text, only some models)
- `item/reasoning/summaryTextDelta` `{summaryIndex, delta, itemId, threadId, turnId}` and `item/reasoning/summaryPartAdded`
- `item/commandExecution/outputDelta` `{delta, itemId, threadId, turnId}` (aggregated stdout/stderr chunks; delta is a string)
- `item/fileChange/outputDelta`, `item/fileChange/patchUpdated`
- `item/plan/delta`, `turn/plan/updated`, `turn/diff/updated` (unified diff of the turn so far)
- `item/mcpToolCall/progress`
- `error` (turn error, see section 7), `warning`, `deprecationNotice`, `configWarning`
- `thread/compacted`, `model/rerouted` (server switched model, e.g. fallback), `serverRequest/resolved` (a pending approval was resolved elsewhere, e.g. another client)

`ThreadItem.type` variants in 0.144.3: `userMessage, agentMessage, plan, reasoning, commandExecution, fileChange, mcpToolCall, dynamicToolCall, collabAgentToolCall, subAgentActivity, webSearch, imageView, sleep, imageGeneration, enteredReviewMode, exitedReviewMode, contextCompaction, hookPrompt`.

`commandExecution` item fields: `{id, command, cwd, commandActions, aggregatedOutput, exitCode, durationMs, processId, source, status, type}`. `fileChange` item: `{id, changes, status, type}`.

---

## 5. Approvals

Approval requests are **server-to-client JSON-RPC requests** (they carry an `id`; the client MUST send back a response with that id; the turn blocks until then).

### `item/commandExecution/requestApproval`
Params:
```
threadId*: string        turnId*: string        itemId*: string
approvalId: string|null  command: string|null   commandActions: array|null
cwd: string|null         reason: string|null    environmentId: string|null
networkApprovalContext: object|null             proposedExecpolicyAmendment: string[]|null
proposedNetworkPolicyAmendments: array|null     startedAtMs*: int
```
Client response:
```json
{"id":<server request id>,"result":{"decision":"accept"}}
```
`decision` is one of:
- `"accept"`: approve this once
- `"acceptForSession"`: approve and cache for the session (no more prompts for matching commands)
- `{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["...tokens..."]}}`: approve and persist an execpolicy rule
- `{"applyNetworkPolicyAmendment":{"network_policy_amendment":{...}}}`: persist a network allow/deny rule for a host
- `"decline"`: deny; the agent continues the turn and works around it
- `"cancel"`: deny AND immediately interrupt the turn

### `item/fileChange/requestApproval`
Params: `{threadId*, turnId*, itemId*, grantRoot: string|null, reason: string|null, startedAtMs*}`. The actual patch content lives on the corresponding `fileChange` item (`changes`) from `item/started`. Response: `{"decision":"accept"|"acceptForSession"|"decline"|"cancel"}`.

### Other server-to-client requests
`item/permissions/requestApproval` (agent asks to widen its permission profile; respond with granted profile + scope), `item/tool/requestUserInput`, `item/tool/call` (dynamic client-implemented tools), `mcpServer/elicitation/request`, and legacy v1 leftovers `applyPatchApproval` / `execCommandApproval` (not used by the v2 thread/turn flow; do not implement unless supporting ancient servers). If another connected client resolves a pending request, you get a `serverRequest/resolved` notification and should dismiss your prompt.

### Approval policies (`AskForApproval`)
Protocol enum in 0.144.3: `"untrusted" | "on-request" | "never"`, plus an object form `{"granular":{...}}` for per-category control (`mcp_elicitations`, `rules`, `sandbox_approval`, `request_permissions`, `skill_approval`). **Note: `on-failure` is NOT in the v2 protocol enum** (it still exists in older CLI/config surfaces; do not send it over app-server).
- `untrusted`: only known-safe commands run without asking
- `on-request`: model escalates when it needs something outside the sandbox (recommended default)
- `never`: never ask; sandbox-blocked actions just fail (what `codex exec` uses)

### Sandbox interaction (macOS Seatbelt)
With `sandbox: "workspace-write"` and `approvalPolicy: "on-request"`: writes inside cwd plus `writableRoots` (and `/tmp` unless `excludeSlashTmp`) execute silently inside Seatbelt; you only see `item/started`/`outputDelta`/`item/completed` for the command or fileChange item. Approval requests only arrive for escalations: commands that need to run outside the sandbox, network access when `networkAccess:false`, or writes outside writable roots. The `reason` field explains why. With `approvalPolicy:"never"` such actions fail instead (surfacing as failed items with `sandboxError`-ish output). `danger-full-access` disables sandboxing entirely (never send from the runtime).

`approvalsReviewer` (thread/turn param): `"user"` (default; requests come to your client) or `"auto_review"` (a subagent risk-reviews and decides; requests may never reach you).

---

## 6. Turn completion and usage metadata

Completion signal: `turn/completed` notification `{threadId, turn}` where `turn.status` is `"completed" | "interrupted" | "failed"` (`TurnStatus` also has `inProgress`). `turn.error` is populated only when failed (see section 7). `startedAt`/`completedAt` are unix seconds; `durationMs` provided. `turn.items` in the notification is empty with `itemsView:"notLoaded"`; item data comes from the item notifications during the turn.

Token usage does NOT ride on `turn/completed`. It arrives via `thread/tokenUsage/updated` `{threadId, turnId, tokenUsage}`:
```json
"tokenUsage": {
  "total": {"totalTokens":13192,"inputTokens":13187,"cachedInputTokens":9984,"outputTokens":5,"reasoningOutputTokens":0},
  "last":  {... same shape, most recent model call ...},
  "modelContextWindow": 258400
}
```
`total` accumulates across the whole thread (verified: resuming an old thread replays its running total). `account/rateLimits/updated` follows each turn with plan-level quota (`usedPercent`, window, `planType`, credits). On-demand: `account/rateLimits/read`, `account/usage/read`.

---

## 7. Errors

**Request-level** (JSON-RPC error responses, `jsonrpc` field omitted):
- Unknown method: `{"error":{"code":-32600,"message":"Invalid request: unknown variant \`no/such/method\`, expected one of \`initialize\`, ..."}}` (verified; the message enumerates every method the binary supports, a handy runtime capability probe)
- Bad thread id on `thread/read`: `{"error":{"code":-32600,"message":"thread not loaded: <id>"},"id":6}` (verified)
- Overload: code `-32001`, "Server overloaded; retry later."

**Turn-level failures** stream as the `error` notification, then `turn/completed` with `status:"failed"` and `turn.error` set:
```json
{"method":"error","params":{"threadId":T,"turnId":U,"willRetry":false,
  "error":{"message":"...","additionalDetails":null,"codexErrorInfo":"usageLimitExceeded"}}}
```
Heed `willRetry`: when true the server is retrying internally; do not fail the turn yet.

`codexErrorInfo` (`CodexErrorInfo`) variants in 0.144.3:
- strings: `contextWindowExceeded, sessionBudgetExceeded, usageLimitExceeded, serverOverloaded, cyberPolicy, internalServerError, unauthorized, badRequest, threadRollbackFailed, sandboxError, other`
- objects: `{httpConnectionFailed:{httpStatusCode}}`, `{responseStreamConnectionFailed:{httpStatusCode}}`, `{responseStreamDisconnected:{...}}`, `{responseTooManyFailedAttempts:{...}}`, `{activeTurnNotSteerable:{...}}`

Mapping to your three cases:
- **Signed out / auth failure:** `codexErrorInfo:"unauthorized"` on the turn. Check proactively before turns with `account/read` (params `{}`) which returns `{"account":{"type":"chatgpt","planType":"plus","email":...}|{"type":"apiKey"}|null,"requiresOpenaiAuth":bool}`; `account: null` with `requiresOpenaiAuth: true` means signed out. (Legacy `getAuthStatus` also still exists.) Login flow: `account/login/start`, completion via `account/login/completed` notification. Auth state presence check: `~/.codex/auth.json` exists on this machine.
- **Model not available:** `turn/start` with a bogus model either fails the request or fails the turn with `badRequest`; also watch `model/rerouted` notifications (server silently rerouting to another model) and validate upfront with `model/list` (returns available models).
- **Quota exhaustion:** `usageLimitExceeded` (plan limit) or `sessionBudgetExceeded`; `account/rateLimits/updated` gives you `usedPercent` continuously so you can warn before hitting it.

---

## 8. Configuration

Precedence: per-turn overrides > per-thread settings > `-c` CLI overrides at server start > `$CODEX_HOME/config.toml` defaults.

- **Per-thread** (`thread/start` / `thread/resume` params): `model`, `modelProvider`, `cwd`, `sandbox` (string mode: `read-only|workspace-write|danger-full-access`), `approvalPolicy`, `baseInstructions`, `developerInstructions`, `config` (raw config.toml key map, e.g. `{"model_reasoning_effort":"low"}`), `ephemeral`.
- **Per-turn** (`turn/start` params): `model`, `cwd`, `effort`, `summary`, `approvalPolicy`, `outputSchema`, and `sandboxPolicy` in full object form:
  ```json
  {"type":"workspaceWrite","writableRoots":["/abs/path"],"networkAccess":false,"excludeSlashTmp":false,"excludeTmpdirEnvVar":false}
  ```
  (other variants: `{"type":"readOnly","networkAccess":bool}`, `{"type":"dangerFullAccess"}`, `{"type":"externalSandbox",...}`)
- **Server start:** `-c key=value` repeated; `--enable/--disable FEATURE` for feature flags.
- **Config API:** `config/read`, `config/value/write`, `config/batchWrite`, `configRequirements/read`, `config/mcpServer/reload`.

**Environment:** `CODEX_HOME` relocates `~/.codex` (auth.json, config.toml, sessions/, sqlite state). Set it per supervised server if you want isolated auth/history; leave it for shared history with the user's CLI. The initialize response echoes the resolved `codexHome`. cwd of the app-server process does not matter; always pass absolute `cwd` per thread (it defaults to the server process cwd otherwise).

---

## 9. Multi-thread / concurrency

**One app-server process serves many threads concurrently. This is the intended model** (it is what the VS Code extension does). Evidence:
- Every notification and request carries `threadId` (and `turnId`) for demultiplexing.
- `thread/loaded/list` lists threads currently loaded in the process.
- Docs: multiple clients can attach to one server (ws/unix transports); thread subscriptions are per connection; `thread/unsubscribe` plus a 30-minute inactivity grace period unloads a thread.
- The daemon (`codex app-server daemon`) exists precisely to share one server across clients.

Constraints:
- **One active turn per thread.** Starting/steering while the active turn cannot accept input yields the `activeTurnNotSteerable` error. Queue user inputs client-side, or use `turn/steer` to inject into the running turn.
- Turns on different threads run concurrently and interleave their notifications on the same stdio stream; route strictly by `threadId`.
- Server-to-client approval requests can be in flight for several threads at once; correlate by JSON-RPC `id` and read `threadId` from params.

For stdio integration, spawn ONE `codex app-server` process per runtime host and multiplex all conversations over it. One-process-per-conversation also works (heavier: each process starts MCP servers etc. per thread; observed `mcpServer/startupStatus/updated` startup churn per loaded thread).

---

## 10. Version pinning and compatibility

Detection at runtime:
1. `codex --version` -> `codex-cli 0.144.3` (cheap, before spawn)
2. `initialize` response `userAgent` embeds the server version: `"<clientName>/0.144.3 (...)"` (authoritative for the running process)
3. `codex app-server daemon version` prints local CLI and running daemon versions as JSON
4. `Thread.cliVersion` records the version that created each thread

There is no semver-negotiated protocol version. The subcommand is flagged `[experimental]` and method surface drifts between releases. Concretely observed drift within 0.144.3 itself: the runtime accepts methods absent from the stable generated schema (`thread/settings/update`, `thread/search`, `thread/turns/list`, `thread/items/list`, `thread/increment_elicitation`, `memory/reset`, `thread/backgroundTerminals/*`, `thread/realtime/*`, `process/spawn`, ...), gated behind `capabilities.experimentalApi`. Historic drift: the v1 API (`newConversation` / `sendUserMessage` / `codex/event`) is gone entirely; only `applyPatchApproval`, `execCommandApproval`, `getAuthStatus`, `getConversationSummary`, `gitDiffToRemote`, `fuzzyFileSearch` survive as legacy methods. Deprecations are announced via the `deprecationNotice` notification.

Sane compatibility check for the runtime:
1. On boot, run `codex --version`; refuse (or warn) outside a tested range, e.g. `>=0.144 <0.146`.
2. Send `initialize`; parse the version out of `userAgent` and cross-check.
3. Optionally probe capabilities cheaply: send a deliberately unknown method and parse the `-32600` error message, which enumerates every supported method; assert the ones you depend on (`thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`, `item/agentMessage/delta` handling is notification-side so cannot be probed this way).
4. In CI, regenerate `codex app-server generate-json-schema --out ...` against the pinned CLI and diff against the vendored copy; fail the build on breaking changes.
5. Never set `capabilities.experimentalApi: true` in production; stay on the stable surface.
6. Treat unknown notifications and unknown fields as ignorable (the server adds fields without notice); parse leniently.

---

## Integration design implications (replacing per-turn `codex exec --json`)

### Process supervision
- Spawn one long-lived `codex app-server` (stdio) per runtime host; restart-on-exit with backoff. State is on disk, so a crash loses only in-flight turns: on restart, `initialize` + `initialized`, then `thread/resume` each active conversation by stored id and re-issue nothing (the interrupted turn is simply gone; surface it as an error to the user).
- Readiness = `initialize` response received. Liveness = any cheap request (`thread/loaded/list` or `account/read`).
- Writer discipline: stdin writes must be line-atomic (serialise via a single writer). Reader: split on newlines, `JSON.parse` per line, tolerate the missing `jsonrpc` field.
- Backpressure: handle `-32001` with jittered retry.
- Shutdown: `turn/interrupt` in-flight turns, then SIGTERM; the server exits cleanly on stdin EOF.

### Mapping to normalised events `{type:'session'|'text'|'done'|'error'}`
- `session`: emit after `thread/start` / `thread/resume` response, carrying `result.thread.id` (equivalent of the session id you currently scrape from `codex exec --json`; ids are the same UUIDv7 namespace and interoperate both ways).
- `text`: `item/agentMessage/delta` params `.delta` (filter/duplicate-guard by `itemId`; you now get true incremental streaming, which `exec` never gave you). Decide policy for `item/reasoning/summaryTextDelta` (nice progress UX) and `item/commandExecution/outputDelta` (tool output): either map to a richer event type later or drop.
- `done`: `turn/completed` with `turn.status`. Attach usage from the preceding `thread/tokenUsage/updated` (`tokenUsage.last` = this turn's model calls: `inputTokens`, `cachedInputTokens`, `outputTokens`, `reasoningOutputTokens`; `total` = thread lifetime). Treat `status:"interrupted"` as done-with-flag, `status:"failed"` as `error`.
- `error`: JSON-RPC error responses on your own requests, plus the `error` notification (respect `willRetry:true` = not terminal), plus `turn/completed` with `turn.error`. Normalise on `codexErrorInfo`: `unauthorized` -> signed-out, `usageLimitExceeded`/`sessionBudgetExceeded` -> quota, `contextWindowExceeded` -> context, else generic with `message`.

### New obligation: approval plumbing
Unlike `codex exec` (which runs `approvalPolicy:"never"`), on-request mode makes the server send you blocking JSON-RPC requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`). You MUST respond or the turn hangs forever. Implement a timeout default (respond `"decline"` or `"cancel"` after N minutes) even if the UI is absent. If you want exec-equivalent behaviour initially, start threads with `approvalPolicy:"never"` and no approval UI, then layer approvals in.

### Gotchas
- `thread/list` hides exec-sourced threads by default; pass `sourceKinds:["exec","cli","vscode","appServer"]`. Resume-by-id is unaffected.
- Responses omit `"jsonrpc":"2.0"`; strict parsers break.
- `turn/completed` carries no token counts; usage is a separate notification that arrives BEFORE `turn/completed`. Buffer it per `turnId`.
- Expect unsolicited notifications immediately after handshake (`remoteControl/status/changed`, `account/rateLimits/updated`, `mcpServer/startupStatus/updated` per loaded thread). Ignore unknown methods.
- One active turn per thread; queue inputs or use `turn/steer`.
- `codex app-server` is officially experimental and the CLI moves fast (protocol churn observed across 0.1xx releases: full v1 to v2 method rename). Pin the CLI binary version in your deployment, vendor the generated JSON schema for that version, and diff-check on every CLI upgrade (`codex app-server generate-json-schema`).
- The official `@openai/codex-sdk` (repo `sdk/typescript`) wraps CLI JSONL spawning with `startThread()` / `resumeThread(threadId)` / `runStreamed()`; it validates that thread ids and event vocabulary (`item.completed`, `turn.completed`) match what app-server exposes, and is a reasonable reference implementation, but it hides approval handling, so a direct app-server client is the right call for this rebuild.
- Default model on this machine resolved to `gpt-5.6-sol` from user config; always set `model` explicitly per thread if the runtime needs determinism.

### Sources
- Installed CLI: `codex-cli 0.144.3`, probes run 2026-07-17 (scripts in `/tmp/codex-appserver-research/`)
- Generated protocol schema and TS bindings: `codex app-server generate-json-schema|generate-ts` output in `/tmp/codex-appserver-research/json-schema/` and `/tmp/codex-appserver-research/ts-bindings/` (see `ClientRequest.ts` for the full method map)
- openai/codex repo: `codex-rs/app-server/README.md` (https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- Official docs: https://developers.openai.com/codex/app-server (308 redirect to https://learn.chatgpt.com/docs/app-server)
- TypeScript SDK: https://github.com/openai/codex/blob/main/sdk/typescript/README.md
