# Changelog

All notable changes to Rundock are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

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
