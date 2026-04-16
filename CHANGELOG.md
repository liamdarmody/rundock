# Changelog

All notable changes to Rundock are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

> Versions prior to 0.7.1 used minor bumps for all changes. From 0.7.1 onward, minor = new capabilities, patch = refinements and fixes.

## Unreleased

**Name:** TBD

### Fixed

- **Delegation context no longer forces COMPLETE after a proposal waiting for user confirmation:** The platform delegate delegation context told specialists to "complete the task in a single response if possible" and emit COMPLETE immediately. This conflicted with Doc's scaffold instruction to propose before executing: Doc would propose a plan, emit COMPLETE (killing the delegation), and when the user said "go ahead" a fresh delegation started with no memory of the proposal. The delegation context now includes an exception: if the specialist proposed a plan and is waiting for user confirmation, it stays in the conversation without emitting COMPLETE until the task is genuinely finished.

- **Page refresh no longer re-invokes orchestrator on completed conversations:** When a specialist emitted COMPLETE on the parked-parent delegation path, the resumed orchestrator process was parked correctly (no auto-prompt sent) but was not marked as idle. On browser refresh, `handleActiveProcesses` found this non-idle process and called `startProcessing`, which re-invoked the orchestrator on a conversation that had already completed. The parked-parent COMPLETE and no-marker branches now set `idle = true` on the resume entry, so `handleActiveProcesses` skips them on reconnect.

### Added

- **Skills frontmatter field for explicit skill-to-agent assignment:** Agent files now support a `skills:` frontmatter field listing skill slugs that the agent owns. The skill discovery logic checks this field first and falls back to the existing body-text scan for agents without it. This gives workspace authors explicit control over skill assignment without needing to mention the slug in the agent's body text. Both methods can coexist: frontmatter matches take priority, body-text matches fill in the rest, and duplicates are suppressed.

### Fixed

- **Agent identity included in process_started events:** All `process_started` events now include the `_agent` field with the agent slug. Previously the frontend logged `agent=?` because the payload was missing this field. No frontend changes needed; the existing `d._agent` read now resolves correctly.

- **SAVE_AGENT and SAVE_SKILL marker parser no longer truncates at inner code fences:** The marker extraction regex used optional code fence groups as parsing boundaries. When an agent body contained inner triple-backtick lines (e.g. Doc's scaffold with frontmatter templates), the lazy capture stopped at the first inner fence and silently dropped everything after it. The parser now extracts content purely between the HTML comment markers and strips leading/trailing code fences as a post-processing step. Fences are cosmetic formatting, not structural delimiters.

- **No spurious "resumed" badge when orchestrator is parked after COMPLETE:** When a specialist emitted COMPLETE, the server correctly parked the orchestrator silently, but the frontend rendered an "[Agent] resumed" badge on the `agent_switch` event before the server parked it. The badge is now deferred until the orchestrator actually produces output (a text chunk or `autoContinue` process start). If the orchestrator is parked without producing output, the badge is discarded on the `done` event and never appears.

- **Platform delegates default to COMPLETE regardless of marker emitted:** The platform delegate delegation context was telling Doc to emit `RUNDOCK:RETURN` on completion, contradicting the scaffold instruction to use `RUNDOCK:COMPLETE`. Fixed the delegation context to use COMPLETE. Added a server-side safety net: when a platform delegate emits RETURN but the response contains no out-of-scope language ("outside my scope", "I can't help with this", etc.), the server overrides it to COMPLETE. This makes the COMPLETE path reliable without depending on model compliance.

- **COMPLETE marker takes priority over RETURN when both are present:** Platform delegates (Doc) sometimes emit both `RUNDOCK:RETURN` and `RUNDOCK:COMPLETE` in the same response. Previously the server checked RETURN first, so these responses were treated as out-of-scope returns, triggering unnecessary orchestrator auto-resumes. COMPLETE now takes priority at all three detection points (onResult handler, close handler fallback, and resumed parent scope-return detection). If the agent did the work and emitted COMPLETE, the response is always treated as pipeline-complete regardless of a stray RETURN marker.

- **COMPLETE-path auto-resume gate:** When a specialist emitted a COMPLETE marker on the sub-delegate handoff path, the orchestrator was auto-resumed with a "stay silent" prompt that it routinely ignored, causing it to silently re-delegate or narrate. The orchestrator is now left idle after COMPLETE, returning control to the user without any hidden prompt.

- **Orchestrator scaffold: roster constraint and no parallel claims:** The orchestrator prompt now instructs the orchestrator to only delegate to agents listed in its roster, preventing hallucinated agent names (e.g. referencing "Explorer" when no such agent exists). The prompt also states that delegation is sequential (one specialist at a time) and the orchestrator must not claim it is running tasks in parallel, since the architecture does not support parallel agent delegation.

- **Doc scaffold: propose before executing, COMPLETE marker, SAVE_SKILL enforcement:** Doc now waits for explicit execution signals ("create it", "go ahead") before emitting markers that create or delete workspace objects. Previously Doc would execute immediately on any request, including requests for recommendations. Doc now emits COMPLETE (not RETURN) when finishing delegated work, preventing unnecessary orchestrator auto-resumes. SAVE_SKILL emission is now explicitly required when creating skills through any flow.

- **Delegation loop circuit breaker:** Two-layer defense against infinite delegation loops. First, the parked-parent resume path now sets `scopeReturnSource` on the resumed orchestrator entry, so the existing same-specialist re-delegation guard catches immediate loops (orchestrator delegates to A, A returns, orchestrator tries to delegate to A again: blocked). Previously this guard only worked for the `handleScopeReturn` path, leaving the parked-parent path unprotected. Second, a per-conversation counter tracks consecutive auto-resume events with no intervening user message. After 3 consecutive auto-resumes (configurable via `MAX_CONSECUTIVE_AGENT_RESUMES`), the system auto-pauses and presents a summary to the user. This catches multi-agent loops that the same-specialist guard cannot (e.g. A returns, routes to B, B returns, routes to A). The counter resets on each user message. The scaffold orchestrator prompt now instructs the orchestrator not to re-delegate to a specialist that just returned, and the guard message uses the agent's display name instead of a raw slug.

- **`rundock-guide` no longer applies the onboarding default orchestrator slug to specialists created in existing workspaces:** The platform guide agent was carrying a hardcoded onboarding default in a general quality-rules section, which caused new specialists created in an existing workspace to be written with a `reportsTo` value that did not match that workspace's actual orchestrator slug. The specialist then failed to appear on the org chart because the parent reference did not resolve. The default is now explicitly gated to onboarding mode, and a new existing-workspace section tells the guide to read the runtime `YOUR TEAM` roster for the actual orchestrator slug before emitting `reportsTo`, then verify the write by reading the file back. New specialists created in existing workspaces now land on the org chart with a valid parent reference.

---

## 0.8.4: Structural Teammate Awareness (2026-04-14)

Specialists now recognise when a request belongs to someone else on the team and hand it back cleanly. When you talk to a specialist directly about work outside their domain, they no longer attempt the work themselves or refer to a teammate that does not exist in your workspace. The handback routes your original request to the right specialist without you having to repeat yourself.

### Added

- **Specialists know who their teammates are:** Before 0.8.4 a specialist only knew its own role. Asked to do work outside its scope, it would either attempt the task anyway or confidently mention handing it to a peer whether or not that peer was actually in the workspace. Specialists now receive a list of every other agent in the current workspace as part of their instructions at spawn time, with a rich description of what each one does pulled from that agent's own file. The list reflects the live state of `.claude/agents/`: adding, removing, or renaming an agent updates every other specialist's view automatically on the next turn. A specialist can only reference teammates that actually exist.

### Fixed

- **Direct handback to the orchestrator routes without repeating yourself:** When you talk to a specialist directly and ask for something outside its scope, the specialist now emits a return marker, the orchestrator joins the same conversation, and your original request is routed to the right specialist automatically. You do not need to re-explain what you wanted. This path was wired into the server during 0.8.3 without explicit coverage; 0.8.4 verifies it end-to-end and makes it reliable by structural means rather than through prompt-level instructions alone.

---

## 0.8.3: Permission Hook Repair and Delegation Hygiene (2026-04-14)

Packaged builds now ship with a working permission hook, so tool auto-approval actually works in installed copies of Rundock. Existing installs auto-heal their workspace settings on first launch. Plus a substantial round of delegation fixes: specialists no longer narrate handoff briefs in chat, multi-step specialist pipelines return control to the orchestrator cleanly, and the UI clears stale working and unread indicators when you switch workspaces.

### Fixed

- **Permission hook is now bundled into packaged builds:** Every installed copy of Rundock since the hook architecture shipped was missing `scripts/permission-hook.js` entirely. Claude Code tried to execute a non-existent script as its pre-tool-use hook, so every tool call appeared to time out and auto-approval was silently broken in both Code mode and Knowledge mode. The script is now included in the `.app` bundle and extracted to a location where it can actually run. Existing installs are also repaired automatically: when you open a workspace in 0.8.3, Rundock detects a stale hook entry in your workspace settings and rewrites it to the correct path. No manual action required.

- **Specialists no longer narrate delegation briefs to the user:** When a specialist with direct reports handed a task to a sub-agent, it was writing the full brief into chat first: a paragraph referring to the user in the third person, followed by the actual Agent tool call. Specialists now treat each delegation as a routing decision: at most a one-sentence handoff in chat, with the full brief passed inside the tool call itself.

- **Multi-step specialist work returns control to the orchestrator:** When the orchestrator delegated a multi-step task to a specialist that then delegated to a sub-agent and resumed after it finished, the conversation could get stuck attributing subsequent user messages to the wrong agent. The sub-agent would appear to stay active in the UI and receive messages intended for the orchestrator. Specialists now signal pipeline completion explicitly, and the server routes control back through the same machinery used for out-of-scope returns, so the UI and message routing stay in sync.

- **Silent resume after a specialist finishes:** When a specialist completed a delegated pipeline, the orchestrator used to spin up a fresh process and re-read the original user message, which caused it to run the same specialist again or narrate invented "next steps". On pipeline completion the orchestrator now resumes silently with no tool calls and no new chat output, simply waiting for the next user message.

- **Pipeline completion and out-of-scope returns are now distinct:** Specialists were using a single marker for two different situations, "user asked for something outside my domain" and "the delegated work is done". The latter clause fired at every human-review gate, so specialists would hand back control mid-pipeline whenever they presented options or drafts for approval. These are now two separate markers with explicit instructions about when each applies, so review gates no longer trigger a premature hand-back.

- **Re-delegation after a clean pipeline completion:** After a specialist cleanly finished its work, the orchestrator could be blocked from routing the user's next message back to the same specialist by a guard that only applies to out-of-scope returns. Completion returns now leave that guard unset, so any next message is free to route anywhere.

- **No stray "routing" text when control returns to the orchestrator:** On some scope returns, the orchestrator emitted placeholder filler into the transcript ("No response requested.") before invoking its next tool call. The routing prompt now explicitly forbids any user-facing text on that turn, so the transition is clean.

- **Delegation briefs no longer replay as user messages on session resume:** Briefs written straight to a specialist's input were being stored in the session history as plain user messages. On resume, the rehydrate step was replaying them as if the user had typed the brief. Briefs are now tagged so the rehydrate filter drops them.

- **Working indicator clears on the outgoing agent during handoffs:** When a conversation handed off from one agent to another, the outgoing agent's sidebar row and org chart dot stayed pinned to the "working" state until the next full re-render. On return handoffs this could persist indefinitely. The agent switch now explicitly clears the working state on the outgoing agent, while leaving it alone if that agent is still processing another conversation.

- **Chat header clears on workspace switch:** The conversation header status element is a single DOM node. Switching workspaces while a reply was in flight left stale "working..." text in the header on the new workspace. The header now resets alongside the rest of the workspace state.

- **Nav rail indicators no longer carry over between workspaces:** The orange unread dot on Conversations and the working dot on Team were tracked in client-side state that persisted across workspace switches. Opening a different workspace could show an unread dot on a freshly created workspace before any conversation existed, and opening the current workspace's conversation would not clear it because the stale indicator belonged to a conversation from the previous workspace. Workspace switching now resets the indicator state and reconciles the nav rail badges so each workspace starts from a clean slate.

- **Late responses no longer dirty unread state on the wrong workspace:** If a response completed after you had already navigated to a different workspace, the unread mark could land on an unrelated conversation in the newly loaded workspace. Unread marks are now gated on the conversation still belonging to the currently loaded workspace, so late arrivals from a workspace you have left are dropped.

---

## 0.8.2: Faster Scope Return (2026-04-13)

Scope return after long specialist sessions is now near-instant. Plus a fix to the "Check for Updates" menu action so it actually confirms the result.

### Fixed

- **Scope return is now near-instant after long specialist sessions:** When a specialist handed scope back to the orchestrator for re-routing, the full conversation transcript was being prepended to the orchestrator's next prompt. On long or code-heavy sessions this bloated the context and made the LLM call slow. The transcript is no longer prepended on handoff; the orchestrator only needs the pending request to choose the next specialist. When the orchestrator delegates mid-conversation to another specialist, that specialist now receives the task brief rather than the full transcript. Delegations that start fresh are unchanged and still receive the full conversation history.

- **"Check for Updates" now confirms the result:** Clicking "Check for Updates" from the menu used to silently poll the update feed, making it impossible to tell whether the check had actually run. The menu action now shows a clear dialog in all cases: up to date, update available (downloading in background), or error. The silent startup check is unchanged and still runs quietly.

---

## 0.8.1: Reliable Delegation (2026-04-11)

Orchestrators now produce a real handoff to the platform agent when you ask for workspace, agent, or skill operations. Plus a handful of UX fixes across the message composer, external links, and the Skills detail page.

### Fixed

- **Orchestrators hand off to the platform agent for real:** Asking an orchestrator to create an agent, edit a skill, or change workspace config used to produce a convincing-looking narration ("Handing to Doc, he'll ask you three things...") without the platform agent ever actually joining the conversation. The orchestrator was describing the handoff instead of invoking it. The platform agent now appears as a full first-class participant with its own message bubble, asks its own questions, and stays in the conversation until the task is done.
- **Skill and agent instructions render on the detail page:** Skills and agents created by the platform agent sometimes showed up in the sidebar list but opened to an empty detail page. The file reader expected a trailing newline after the closing frontmatter separator, which isn't always written. The reader is now tolerant of missing newlines and CRLF line endings, so affected files render correctly on next load.
- **Mouse scroll in the message composer:** Pasting a long message into the composer used to cap the textarea's height but leave the hidden overflow unreachable by mouse or trackpad. Only the keyboard caret could move through it. The composer now accepts wheel and trackpad scroll, with the scrollbar itself hidden to keep the input area visually clean.
- **External links open in the default browser:** Clicking an external link inside the Rundock window now launches the link in your default browser instead of navigating the main window away from Rundock or spawning a second Electron window.

---

## 0.8.0: Onboarding and Stability (2026-04-09)

Rundock now adapts its first-run experience to the workspace it opens, distinguishes between knowledge and code workspaces, and delegates between agents reliably. Distributed as a signed and notarised .dmg.

### Added

- **Conversational onboarding:** New empty workspaces open straight into a conversation with Doc. No intermediary screens. Doc proposes an agent team, creates agents and skills, and configures the workspace through conversation.
- **Workspace mode detection:** Rundock detects whether a workspace is for knowledge work or code and adjusts permissions accordingly. Knowledge mode auto-approves file edits. Code mode auto-approves read-only commands. Toggle available in settings.
- **Smart default view:** Configured workspaces land on Conversations view. Workspaces with files but no agents land on Team view with detected context. Empty workspaces go straight into Doc onboarding.
- **Skills UI redesign:** Replaced the flat skills panel with a sidebar list and detail page pattern. Shows skill instructions, assigned agent, and role context.
- **Workspace audit:** Validates that skills have instructions, agents have assigned skills, and file references resolve correctly. Surfaces issues in the Team view so users can fix gaps before they cause routing failures.
- **Signed .dmg installer:** Download, drag to Applications, and open. No Gatekeeper warnings, no terminal, no manual setup. macOS recognises Rundock as trusted software from a verified developer.

### Changed

- **Agent tool delegation:** Replaced marker-based delegation with Agent tool interception. The server intercepts Agent tool calls mid-stream and routes to the correct specialist. More reliable, and agent files stay Rundock-agnostic.
- **Delegate context:** Delegates now receive the full system prompt instead of a hardcoded subset. Eliminates token duplication and ensures delegates get their complete role and scope instructions.
- **Tool action summaries:** Conversation history now includes a summary of tool calls (files read, edited, commands run). The next agent in the chain sees what was done, not just what was said.
- **Delegation history persistence:** Orchestrator responses are preserved during agent handoffs. Conversation history loads correctly on page refresh regardless of how many handoffs occurred.

### Fixed

- **Orphaned process cleanup:** Claude Code processes are cleaned up on crash or restart instead of accumulating.
- **Permission restoration on reconnect:** Pending permission prompts and active agent state restore correctly after WebSocket reconnection.
- **MCP tool permissions:** Added PreToolUse hook for MCP tools so they go through the permission card UI.
- **Faster subprocess startup:** Agent processes start faster by skipping unnecessary shell profile loading.

---

## 0.7.3: Desktop App (2026-04-03)

Rundock is now available as a native macOS desktop app. Download the .dmg, drag to Applications, and open. No terminal, no git clone, no npm install.

### Added

- **Desktop app:** Electron wrapper with embedded local server. Launches on a dynamic port with no terminal setup required.
- **First-run wizard:** Checks for Claude Code installation and authentication on first launch. Guides users through setup before opening the main window.
- **Tray icon:** Menu bar icon for quick access. Close the window and reopen from the tray.
- **Auto-update scaffolding:** Update checks via GitHub Releases. Gracefully disabled when running unsigned builds.
- **No lock-in section:** Added to README and website. Agents and skills are standard Claude Code files, fully portable without Rundock.
- **Download button:** Rundock.ai hero and getting started section updated with desktop app as the primary install path.

### Fixed

- **PATH detection in packaged app:** Electron apps don't inherit the user's shell PATH. Added common install locations (~/.local/bin, /opt/homebrew/bin) so Claude Code is found.
- **Recent workspaces in packaged app:** File was being written to the read-only asar archive. Redirected to home directory when running in Electron.
- **Agent naming convention:** Scaffolding now enforces that slug, filename, and role all refer to the same thing. Shipped to all users via managed scaffold sync.

---

## 0.7.2: Pinned Conversations and Scope Return (2026-03-31)

Pinned conversations persist across refresh and sort to top of the active list. Specialists can now hand work back to the orchestrator when asked to do something outside their domain.

### Added

- **Pinned conversations:** Pin conversations to keep them across refresh. Pinned conversations sort to the top of the active list by most recent activity. Unpin to return to default behaviour.
- **File wikilink navigation:** Clicking a wikilink opens the file in the in-app viewer with a back history stack. Agents are instructed to use wikilink syntax for file references. Markdown relative file links are intercepted as in-app wikilinks.
- **Specialist scope return:** When a specialist (started directly, not via delegation) recognises work is outside their domain, they emit a RETURN marker. The platform kills the specialist process, spawns the orchestrator, passes the conversation transcript and pending request, and the orchestrator routes to the correct specialist. Includes loop prevention to stop the orchestrator delegating back to the agent that just returned.
- **Platform timezone:** Every agent's system prompt now includes the server's IANA timezone (auto-detected via `Intl.DateTimeFormat`). Applies to all workspaces and all MCP tools (Google Calendar, Todoist, etc.).
- **Scope boundary prompt:** All non-orchestrator agents receive instructions to return when asked to do work outside their domain. Applies regardless of how the conversation started.

### Changed

- **Default landing view:** Nav rail reordered with Conversations first. Opening a workspace lands on conversations instead of the team view.
- **Delete active conversation:** Deleting the active conversation opens the next pinned conversation or starts a new one, instead of showing an empty home view.
- **Activity summary duration format:** Durations above 60 seconds display as Xm Ys (e.g. "2m 15s") instead of raw seconds. Zero seconds omitted (e.g. "3m" not "3m 0s").
- **Tool call reset between turns:** Server resets tool call tracking on each follow-up message so activity summaries only show the current turn's tools.
- **Working status on reconnect:** All active processes now trigger working indicators (sidebar, org chart, nav badge) on WebSocket reconnect, not just the visible conversation.
- **Unread clears on nav:** Navigating to the conversations view clears the unread dot for the active conversation without requiring a click.

### Fixed

- **Profile back button:** Returns to team view correctly instead of navigating to a stale home state.
- **Workspace loading resilience:** Permission errors in agent, skill, or file discovery no longer silently break the workspace loading flow.
- **Conversation delete confirmation:** Removed the native browser `confirm()` dialog. Trash icon now deletes immediately (soft delete, session files preserved on disk).

---

## 0.7.1: Activity Summary (2026-03-31)

Diagnostics, permission refinements, and versioning convention. Agent responses now show what tools were used and how long the turn took. Read-only Bash commands skip the permission card. Resolved permission cards are cleaner.

### Added

- **Activity summary:** Collapsed summary below each agent response showing tool count and wall clock duration (process start to response delivery). Expands to show individual tool calls with timestamps relative to turn start. Tracked server-side for reliability across delegation chains and WebSocket reconnections.
- **Low-risk auto-approve:** Read-only Bash commands (grep, find, ls, cat, head, tail, etc.) auto-approve without showing a permission card. Activity summary provides visibility. Medium and high-risk commands still require approval.

### Changed

- **Resolved permission cards:** Stripped to a single-line confirmation (e.g. "✓ Run npm install"). No "Show command" toggle on resolved cards. Pending cards still show the collapsible command detail.

---

## 0.7.0: Multi-Level Teams (2026-03-30)

Multi-level delegation, agent interruption, conversation transcripts, and a suite of reliability fixes. Specialists can now lead their own sub-teams, users can cancel running agents, and sidebar conversations show the correct active agent on page load.

### Added

- **Multi-level delegation:** Specialists with direct reports can delegate to their own sub-teams. The orchestrator delegates to a lead, the lead delegates to a support agent, and out-of-scope returns skip back to the orchestrator. Uses the `reportsTo` frontmatter field to define the chain.
- **Agent interrupt/cancel:** A stop button replaces the send button while an agent is working. Click to cancel the running process immediately. Cleans up pending permission requests, parked parent processes, and delegate chains. Partial response text is preserved with a "Cancelled" badge.
- **Conversation transcripts:** Server-side transcript system tracks all messages across the delegation chain. Used for context passing between agents, sidebar attribution, and conversation search. Capped at 20 entries with original request preserved.
- **Sidebar agent attribution:** Previous conversations show the last active agent (not the orchestrator) in the sidebar immediately on page load, before clicking. Uses transcript enrichment on the server.
- **Conversation delete:** Hover trash icon on Previous and Done conversations. Soft delete removes from the conversation list; session files stay on disk.
- **Collapsible permission commands:** Long Bash commands in permission cards collapse behind a "Show command" toggle on the approval prompt.
- **Capabilities in team roster:** Agent `capabilities.does` and `capabilities.connectors` are now surfaced in the orchestrator's dynamic team roster, improving routing accuracy.
- **Unread message indicators:** Amber dot on the Conversations nav icon and accent dot on conversation preview cards when an agent responds in a non-visible conversation. Clears when the conversation is opened.
- **Agent working status dot:** Green pulsing dot on org chart cards when an agent is actively processing. Hidden when idle.
- **Working status nav badge:** Green pulsing dot on Team nav icon when any agent is processing.

### Changed

- **Delegation extraction:** The delegation handler is now a standalone function (`handleDelegation`) instead of a closure inside the WebSocket message handler. Eliminates stale WebSocket reference bugs on reconnect.
- **Agent name matching:** Agent interception uses word-boundary regex matching to prevent false positives (e.g. short agent names matching inside longer words).
- **Agent discovery caching:** `discoverAgents()` cached with a 2-second TTL to avoid redundant filesystem scans during delegation flows.
- **Orchestrator delegation prompt:** Strengthened to prevent orchestrators from answering questions that belong to specialists. Router-first behaviour enforced.
- **Specialist delegation prompt:** Specialists with direct reports receive scoped delegation instructions with mandatory delegation triggers and honest naming rules.
- **Session history limit:** Increased from 20 to 50 messages per load.
- **Transcript context on delegation:** Delegates receive the full conversation transcript (excluding their own prior messages) for continuity.

### Fixed

- **Double done event:** `wireProcessHandlers` sent done on result, then the close handler sent done again. Added `resultSent` flag with guards on interactive, legacy, and delegate close handlers.
- **Accordion state lost on re-render:** Previous and Done sections collapsed when the sidebar re-rendered. Now preserves open/close state across renders.
- **Delete re-adding conversations:** Server was sending the full conversation list on delete, which `handlePersistedConversations` re-added. Changed to a targeted `conversation_deleted` acknowledgement.
- **Transcript preserves original request:** Transcript rotation keeps the first entry (the user's original request) so delegates always have full context.
- **Attribution matching tightened:** Content prefix storage increased from 100 to 200 characters with a minimum length guard to reduce false matches.
- **Empty transcript caching:** Failed transcript loads are cached to avoid repeated disk reads.
- **Streaming text after tool use:** Text deltas following a tool call now insert a paragraph break so they don't run into the previous content.
- **Org chart reportsTo resolution:** Node map now indexes by both id and name slug so `reportsTo` matches work regardless of which is used.
- **Background stream capture:** Stream events now accumulate text for all conversations, not just the active one. Previously, switching away from a conversation while an agent was responding would lose the entire response.
- **Agent working status colour:** Working indicators (sidebar text, chat header) use green instead of blue for clearer active/idle distinction.

---

## 0.6.0: Delegation and Search (2026-03-29)

Agent delegation, skill lifecycle, a scalable org chart, and sidebar search. Orchestrators can now route work to specialists mid-conversation, Doc can create and edit skills directly, and conversations and files are searchable from the sidebar.

### Added

- **Specialist delegation:** Orchestrators hand off conversations to specialist agents when a request matches their domain. The specialist stays active for follow-up questions. When the user asks something outside the specialist's scope, it hands back to the orchestrator, which automatically routes the request to the correct agent. No repeated questions, no dead air.
- **Platform delegation:** Orchestrators delegate platform operations (creating, editing, deleting agents and skills) to Doc. Platform delegates are transactional: complete the task and return. Specialist delegates are conversational: stay until the user moves on.
- **Skill lifecycle markers:** Doc can now create, edit, and delete skills via `RUNDOCK:SAVE_SKILL` and `RUNDOCK:DELETE_SKILL` markers, bypassing Claude Code's `.claude/` write restriction. Same marker pattern used for agents.
- **Dynamic team roster:** The orchestrator's system prompt includes a live roster of all agents and their skills. When agents or skills change mid-session, the orchestrator respawns with an updated roster.
- **Sidebar delegation preview:** The conversation list shows the currently active agent's name and icon during delegation, not the original orchestrator.
- **Org chart zoom:** +/- controls in the bottom-right corner. Zoom in enables scroll with auto-centering on the orchestrator. Window resize resets to auto-fit.
- **Org chart d3-hierarchy layout:** Replaced CSS flexbox layout with d3-hierarchy tree positioning. Supports any team size and multi-level hierarchies via the `reportsTo` frontmatter field.
- **Conversation search:** Search bar in the conversations sidebar. Matches conversation titles instantly, then searches transcript content for deeper matches. Results show a snippet with context around the match.
- **File search:** Search bar in the files sidebar. Type a filename and matching files appear as a flat list with their directory path for quick navigation.

### Changed

- **Org chart rendering:** All card dimensions, font sizes, padding, and connector positions are now computed in JavaScript at the target scale before rendering HTML. No CSS transforms. Eliminates phantom scroll space, misaligned connectors, and centering issues from the previous approach.
- **Permission mode:** Changed from `default` to `acceptEdits`. Write and Edit operations on knowledge files (markdown, YAML, JSON) no longer require manual approval. Executable file restrictions remain hard-blocked via disallowed-tools.
- **Agent marker renamed:** `RUNDOCK:CREATE_AGENT` renamed to `RUNDOCK:SAVE_AGENT` for consistency. Works for both creating new agents and updating existing ones.
- **Scaffold consolidated:** `rundock-agent-onboarding.md` and `rundock-workspace-setup.md` removed. Their capabilities are now built into `rundock-guide.md` with dedicated skill files (`rundock-workspace`, `rundock-agents`, `rundock-skills`).

### Fixed

- **Skill files couldn't be saved:** Doc couldn't write to `.claude/skills/` because Claude Code blocks Write/Edit operations on the `.claude/` directory. Fixed by adding server-side marker handling for skill files, matching the existing pattern for agent files.
- **Stale scaffold hooks:** Previous versions installed PreToolUse hooks for Write and Edit in `.claude/settings.local.json`. These are now cleaned up automatically on workspace connect.
- **Specialists naming other specialists:** A specialist would reference another specialist by name instead of handing back to the orchestrator for routing. Delegation context now instructs specialists not to name other agents.
- **Orchestrator not responding after specialist return:** Fixed with auto-continue: the server sends the user's pending request to the orchestrator when a specialist hands back.
- **Org chart breaking at scale:** Cards overlapping, connector lines misaligned, content clipped on smaller screens. Replaced entirely with d3-hierarchy coordinate layout and SVG connectors.

---

## 0.5.0: Session History (2026-03-28)

Session history on resume, idle process handling, and conversation cleanup. Previous conversations now load their full message history from Claude Code's transcripts.

### Added

- **Session history on resume:** Opening a previous conversation loads the message history from Claude Code's JSONL transcript files on disk. Messages render with faded styling and a "Previous session" divider separating history from new messages.
- **Paginated history loading:** Long conversations show a "Load earlier messages" button that loads older messages in batches of 20, with scroll position preserved.
- **Lazy conversation creation:** New conversations are only persisted to disk when the first message is sent. Navigating away from an empty conversation silently discards it.
- **Empty conversation cleanup:** On workspace load, persisted conversations with no session ID (and older than 5 minutes) are automatically removed.

### Fixed

- **Stale process thinking mode:** Idle Claude Code processes (waiting for input between turns) were reported as "active" on page reload, causing conversations to get stuck in thinking mode with a disabled input field. Processes now track idle state and are excluded from the active process list when not mid-response.

---

## 0.4.0: Permissions (2026-03-27)

Interactive mode and browser-based permission cards. Conversations now use a persistent process, and terminal commands require user approval through an in-conversation permission UI.

### Added

- **Permission cards:** When an agent needs to run a terminal command, a permission card appears in the conversation showing the command, risk level, and Allow/Deny/Always Allow buttons. Powered by Claude Code's PreToolUse hook system bridged to the browser via HTTP long-poll.
- **Permission timeout:** Cards auto-deny after 120 seconds if the user doesn't respond. Claude is told the request timed out (not denied) so it retries on the next ask.
- **Always Allow:** Session-scoped pattern matching. Click "Always Allow" on a command type and subsequent matching commands auto-approve without showing a card. Resets on page refresh.
- **Risk classification:** Commands are classified as low (ls, cat, grep), medium (npm, git), or high risk (rm, sudo, chmod). High-risk cards omit the "Always Allow" option.

### Changed

- **Interactive mode (Deliverable A):** Claude Code processes now stay alive between messages. Follow-up messages push to stdin instead of spawning new processes. Faster response times and proper conversation continuity.
- **Permission model:** Bash commands are no longer silently blocked by `--disallowed-tools`. They go through the permission card UI so the user decides. Executable file restrictions (Write/Edit on .js, .py, .sh, etc.) remain hard-blocked.
- **Allowed tools:** Write and Edit added to allowed-tools for knowledge files. Disallowed-tools still blocks executable file extensions.
- **System prompt:** Updated to encourage agents to use Bash when appropriate and let the user decide via permission cards, rather than self-censoring.
- **Legacy rollback:** Set `RUNDOCK_LEGACY_SPAWN=1` to revert to the previous one-process-per-message model.

### Technical

- `scripts/permission-hook.js`: PreToolUse hook script that bridges Claude Code to Rundock's browser UI via `POST /api/permission-request`.
- `POST /api/permission-request`: HTTP endpoint that holds the connection open until the user clicks Allow/Deny or the 120s timeout fires.
- Workspace scaffold writes `.claude/settings.local.json` with hook configuration on first open.
- Spawn env passes `RUNDOCK_PORT` and `RUNDOCK_CONVO_ID` to child processes for hook routing.

---

## 0.3.0: Resilience (2026-03-25)

Reconnect recovery, safety guardrails, and agent quality enforcement. Rundock now handles disconnects gracefully, restricts what agents can do, and ensures consistent output formatting across all workspaces.

### Added

- **WebSocket reconnect recovery:** Close the tab mid-conversation and reopen. Response text is preserved, streaming resumes, and the thinking indicator restores correctly.
- **Session persistence:** Conversations survive page reloads. Metadata (title, agent, session ID) stored in `.rundock/` per workspace. Previous sessions appear in a collapsible sidebar section and resume on click.
- **Workspace analysis:** Seven-signal scan (identity, skills, integrations, folder structure, user profile, hooks, existing agents) runs before onboarding. Doc receives structured data instead of guessing.
- **Agent creation via markers:** Agents are created through `RUNDOCK:CREATE_AGENT` markers in chat responses. Supports detection of raw YAML frontmatter as fallback. Org chart and skills update automatically.
- **Agent deletion:** Remove agents from the profile card. Confirmation required. File deleted from `.claude/agents/`.
- **Permission UX:** Risk-tiered permission cards (low/medium/high) with allow, always-allow, and deny actions. Designed and styled. Now fully functional in 0.4.0 via PreToolUse hooks.
- **File type restrictions:** Agents cannot write executable code (.js, .ts, .py, .sh, etc.) or run destructive commands (rm, sudo, chmod). Rundock is designed for knowledge work.
- **System prompt injection:** All agents receive formatting rules (no em dashes, UK spelling) and platform context via `--append-system-prompt`.
- **File tree auto-refresh:** File tree updates automatically when agents create or modify files, both mid-response and on completion.
- **Managed scaffold sync:** Rundock-owned files (Doc agent, platform skills) sync from `scaffold/` on every workspace open. User files are never touched.
- **Hook muting:** Sound hooks in workspace settings are automatically wrapped with a `$RUNDOCK` guard so they only fire in terminal, not in the browser.
- **Nav tooltips:** Delayed, styled tooltips on nav rail icons replace browser-native title attributes.

### Changed

- **Orchestrator identity:** The `--agent` flag is now correctly passed for orchestrator agents. Previously, the ID remapping to 'default' caused the orchestrator to lose its identity.
- **Doc rewrite:** Complete overhaul of the platform guide. Two-beat onboarding flow (propose team, then create agents). Quality rules for agent creation: no skill overlap, character-style names, rich instructions, formatting enforcement.
- **Org chart responsive scaling:** Cards scale down on smaller screens via CSS transform. Breathing room added to prevent edge clipping.
- **Routine permissions:** Changed from `bypassPermissions` to `dangerously-skip-permissions` flag for unattended routine execution.
- **Disconnect buffer:** Messages sent while no client is connected are buffered and delivered on reconnect. Stream events are filtered (covered by response text snapshot); result and system messages are preserved.

### Fixed

- **Org chart connector line:** Vertical trunk line between orchestrator and specialists now renders correctly. Handles odd and even specialist counts.
- **Thinking bubble mid-response:** Thinking indicator reappears when an agent makes tool calls partway through a response, instead of disappearing permanently.
- **Thinking bubble on reconnect:** No longer shows a stuck thinking indicator when the process has already completed while disconnected.
- **Workspace picker dismissal:** Selecting the current workspace no longer keeps the picker visible.
- **Stuck input after response:** `finishProcessing` now always runs even if response handling throws an error. The message input can no longer get permanently locked.
- **Previous conversation promotion:** Resuming a conversation from a previous session moves it out of the "Previous" section immediately.
- **Em dash enforcement:** Agent source files cleaned of em dashes. System prompt rule strengthened with explicit wrong/right examples. Doc's quality rules now require clean formatting in generated agent files.

---

## 0.2.0: Doc (2026-03-24)

The platform guide, starter prompts, and workspace scaffolding. Doc helps users set up workspaces and create agent teams.

### Added

- **Doc agent:** New workspaces automatically get a platform guide agent with workspace setup and agent onboarding skills.
- **Starter prompts:** Agents can define `prompts` in frontmatter. Clickable prompt pills appear when starting a conversation.
- **Conversation routing:** New conversations auto-start with the orchestrator, Doc (empty workspace), or show an agent picker.
- **Skills on profiles:** Agent profile cards show assigned skills with navigation to the Skills tab.
- **Workspace structure guidance:** Workspace Setup skill suggests PARA, Functional, or Minimal folder structures.

### Fixed

- **Avatar visibility:** Inset shadow border prevents colour-on-background blending in both themes.
- **Frontmatter parsing:** Quote stripping for YAML values, prompt extraction from final frontmatter block.
- **Workspace picker flash:** Nav rail hidden until workspace loads.

---

## 0.1.0: First light

The foundation. Agent teams, conversations, skills, and file browsing in the browser.

### Added

- **Agent team management:** Visual org chart from `.claude/agents/`. Supports orchestrator, specialist, and platform agent types with custom icons, colours, and ordering.
- **Conversations:** Chat with any agent via WebSocket bridge to Claude Code. Session continuity via `--resume`. Independent concurrent conversations.
- **Skills browser:** Discovers skills from `.claude/skills/` and `System/Playbooks/`. Dynamic agent-to-skill mapping via body text matching.
- **File browser:** Workspace file tree with markdown preview (wikilinks, callouts, highlights, tags) and raw edit mode with auto-save.
- **Agent profiles:** Capabilities, routines with schedules, model info, assigned skills, collapsible instructions.
- **Routines:** Server-side scheduler for daily and weekly agent tasks parsed from frontmatter.
- **Workspace picker:** Auto-discovers workspaces from common locations. Create new workspaces from the UI. Remembers recent selections.
- **Dark and light themes:** Toggle in nav rail with localStorage persistence.
- **Empty state onboarding:** Contextual empty states with calls to action across all tabs.
