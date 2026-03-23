# Changelog

All notable changes to the Rundock project.

---

## 2026-03-23 — Skills view, design refinements

### Features
- **Skills view:** New lightning bolt nav icon. Sidebar lists all skills grouped by Assigned (on an agent) and Unassigned. Main panel shows accordion list with expand-to-reveal detail.
- **Dynamic skill discovery:** Server scans `System/Playbooks/` for `PLAYBOOK.md` and `.claude/skills/` for `SKILL.md`. No hardcoded skill names. Works with any workspace.
- **Agent-to-skill mapping:** Matches skills to agents by searching each agent's body text for the exact skill slug. Handles multi-agent assignments (e.g. a skill used by both Scout and Penn shows both coloured dots).
- **Skill source navigation:** Click the source name in a skill's expanded detail to open the skill file in the editor (preview mode). Back button returns to Skills view.
- **Three-state agent model:** Agents are classified as onTeam (has order), available (has type, no order), or raw (no type, no order). Sort order: orchestrator first, then specialists by order, then platform agents.
- **Filled nav icons:** Team, Conversations, Skills, and Files icons swap between outline and filled variants on active state.

### Design
- **Colour token refinements:** Surface #212121, elevated #272727, card #333333, border #3D3D3D. Warmer, more depth between layers.
- **Sidebar shadow:** Replaced hard border-right with soft `box-shadow` for depth. Added z-index layering (nav > sidebar > main).
- **View transitions:** Fade-in animation on view switches.
- **Org chart cards:** Transparent border by default, accent glow + shadow on hover instead of border highlight. Removed redundant title label.
- **Agent list density:** Sidebar items use 10px vertical padding and 13px font, matching across Team and Skills views.
- **Conversation item spacing:** 12px padding, 3px gap for better readability.
- **Skill row hover:** Uses rgba overlay instead of hardcoded hex. Works correctly in both dark and light mode.
- **Expanded skill detail:** Preview description hides when row is expanded to avoid duplication. Full description shown below the metadata grid.

### Fixes
- **Skills back button resets nav state:** Returns to Team view with correct nav highlight, sidebar, and main panel.
- **Sidebar skill selection collapses others:** Only one skill expanded at a time when navigating via sidebar.
- **State reset on re-entry:** Navigating away from Skills and back clears expanded rows and sidebar highlights.
- **Editor back button context-aware:** Returns to Skills view when opened from a skill source link, home when opened from Files.

### Architecture
- **`discoverSkills()` in server.js:** Scans multiple source directories, parses frontmatter, maps to agents via body text slug matching. Returns skills with id, name, description, slug, source path, file path, assigned agents, and status.
- **`get_skills` WebSocket message:** Lazy-loaded on first Skills nav click. Client caches result.

---

## 2026-03-21 — Multi-agent sessions, routines, markdown rendering

### Features
- **Session continuity:** Each conversation is a persistent Claude Code session. First message creates a session, subsequent messages resume it via `--resume <session-id>`. Full conversation context preserved.
- **Concurrent conversations:** Multiple conversations can have active Claude Code processes simultaneously. Per-conversation state tracking (isProcessing, streaming, latest text). Switching conversations restores the correct UI state.
- **Agent identity via `--agent` flag:** Server passes `--agent <Name>` using the frontmatter name field for every conversation. Each agent responds with its own identity. No server-side identity injection.
- **Routines display:** Parsed from agent frontmatter. Shown on agent profiles (name, schedule, last run status) and team sidebar (compact list with next run time). Lightweight server-side scheduler checks every 60 seconds.
- **Markdown rendering with marked.js:** Replaced hand-rolled regex parser with the `marked` library. Tables, nested lists, code blocks, GFM task lists all render correctly.
- **Obsidian markdown extensions:** Wikilinks (click to navigate), callouts (styled cards), highlights, strikethrough, tags (styled pills), comments (hidden in preview).
- **File preview/edit modes:** Preview (read-only, rendered markdown, frontmatter hidden) and Edit (raw source, editable, auto-save). Prevents formatting destruction from contenteditable HTML.
- **Wikilink navigation:** Click any `[[wikilink]]` to open the linked file. Searches cached file tree recursively, handles full paths and partial matches.
- **Conversation naming:** Auto-named from first message. Editable title in chat header. Active/Done status toggle.
- **Agent profiles:** Capabilities (does/reads/writes/connectors), model with human label, routines, collapsible instructions. No technical tool names.
- **Thinking indicator with tool status:** Bouncing dots stay visible until final response. Status line updates as tools are used ("Reading files...", "Checking todoist..."). No intermediate message bubbles.
- **Auto-expanding textarea:** Message input grows with content, up to 200px max.
- **Dark/light mode toggle:** In nav rail, smooth transition.

### Fixes
- **Concurrent input:** Sending a message in one conversation no longer blocks input in other conversations. Per-conversation disabled state.
- **File tree scrolling:** Long folder contents are scrollable in the sidebar.
- **Cache headers:** Server sends no-cache headers on index.html to prevent stale CSS/JS.
- **Textarea colour:** Text input uses theme-aware colour variable instead of browser default black.
- **Permission mode:** All Claude Code processes run with `--permission-mode bypassPermissions` for full read/write access within the workspace.

### Architecture
- **Agent discovery:** Reads all `.claude/agents/*.md` files. Parses YAML frontmatter for name, role, description, capabilities, routines, model, order. Sorts by order field. Default agent detected by `order: 0`.
- **Server passes `--agent <Name>` always:** Even for the default agent. Uses frontmatter `name` field (not filename). Claude Code resolves agents by name.
- **Session management:** Server maintains `Map<conversationId, process>`. Each conversation has its own Claude Code process. Session IDs captured from init messages and stored on conversation objects.
- **Routine scheduler:** Reads routines from agent frontmatter. Parses "every day at HH:MM" and "every [weekday] at HH:MM" schedules. Checks every 60 seconds. Executes by spawning Claude Code with the routine's prompt. Run state tracked in memory.

### Dependencies
- Added `marked` (v17) for markdown rendering

---

## 2026-03-21 — Initial lean MVP

### Features
- **WebSocket bridge:** Node.js server spawns Claude Code with `--output-format stream-json` and bridges to browser via WebSocket.
- **Three-column layout:** Nav rail, sidebar (team/conversations/files), main panel (org chart/chat/editor/profile).
- **Dynamic agent discovery:** Loads agents from `.claude/agents/` directory. Shows on org chart and sidebar.
- **Real-time chat:** Send messages, receive streamed responses, timestamps, thinking indicator.
- **File browsing and editing:** Reads workspace directory tree, opens files, auto-save with 1.5s debounce.
- **Agent profiles:** Name, role, description, tools, model, instructions.
- **Org chart:** Responsive scaling, connector lines, click to view profile.
- **Conversation list:** Multiple conversations, preview text, agent avatars.

### Architecture
- Single `server.js` (Node.js) + single `public/index.html`
- Claude Code integration via `--print --output-format stream-json --verbose`
- File operations via `fs.readFileSync` / `fs.writeFileSync` directly on workspace directory
- Same code runs on localhost and in production containers
