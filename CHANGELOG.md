# Changelog

All notable changes to Rundock are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

> Versions prior to 0.7.1 used minor bumps for all changes. From 0.7.1 onward, minor = new capabilities, patch = refinements and fixes.

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
