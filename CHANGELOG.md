# Changelog

All notable changes to the Rundock project.

---

## 2026-03-24: Doc foundation, prompts, workspace scaffold

### Features
- **Doc agent scaffold:** New workspaces automatically get a `rundock-guide.md` agent file, plus `rundock-workspace-setup` and `rundock-agent-onboarding` skills written to `.claude/skills/`. Existing workspaces with a platform agent are untouched.
- **Prompt pills:** Agents can define `prompts` in frontmatter. Starting a conversation shows clickable starter prompts centred in the chat area. Pills disappear on first message.
- **New conversation routing:** "+ New conversation" auto-starts with the orchestrator (if present), Doc (empty workspace), or shows the agent picker (team agents, no orchestrator).
- **Skills on agent profiles:** Agent profile cards now show assigned skills with click-through to the Skills tab.
- **Doc communication style:** Doc's agent file includes tone, formatting rules, and banned AI patterns to prevent generic responses.
- **Workspace structure guidance:** Workspace Setup skill suggests PARA, Functional, or Minimal folder structures for knowledge workers.

### Fixes
- **Avatar visibility:** All avatar circles now have a subtle inset shadow border, preventing colour-on-background blending in either theme.
- **Doc colour:** Changed from grey (#9A9590) to steel blue (#6B8A9E) for clear visual distinction.
- **Frontmatter quote stripping:** Parser now strips surrounding quotes from YAML values, fixing broken CSS when users write `colour: "#hex"`.
- **Attribute escaping:** Added `escAttr()` for prompt pill data attributes. Handles `"`, `'`, `<`, `>`, `&`.
- **parsePrompts regex:** Fixed to handle prompts as the last frontmatter block (no trailing newline).
- **Workspace picker flash:** Nav rail and sidebar hidden by default in HTML, shown only after workspace loads.
- **README cleanup:** Updated example agent to Marshall (Project Manager). Updated Node version to 20+. Switched to `npm start`.

### Architecture
- **Scaffold system:** `scaffoldWorkspace()` function reads templates from `scaffold/` directory. Called on workspace create, set, and server startup. Additive only: checks for existing files before writing. Wrapped in try/catch so failures don't block workspace loading.
- **`rundock-` namespace:** All Rundock-shipped agent files and skill directories use a `rundock-` prefix to avoid colliding with user-created files.
- **`parsePrompts()` function:** Extracts `prompts:` list from agent frontmatter, returns string array.

---

## 0.1.0: Initial release

### Features
- **Agent team management:** Visual org chart showing agents discovered from `.claude/agents/`. Agents support `type` (orchestrator, specialist, platform), `order`, `displayName`, `icon`, and `colour` frontmatter fields.
- **Conversations:** Chat with any agent through the browser. Messages bridge to Claude Code via WebSocket. Session persistence across messages via `--resume`. Concurrent conversations with independent state.
- **Skills:** Browse skills from `.claude/skills/` and `System/Playbooks/`. Dynamic agent-to-skill mapping via body text slug matching. Click through to source files.
- **File browsing and editing:** Workspace file tree with markdown preview (including Obsidian extensions: wikilinks, callouts, highlights, tags) and raw edit mode with auto-save.
- **Agent profiles:** Capabilities, routines with schedule and run status, model info, assigned skills, collapsible instructions.
- **Routines:** Parsed from agent frontmatter. Server-side scheduler checks every 60 seconds. Supports daily and weekly schedules.
- **Built-in Doc agent:** Platform guide injected at runtime for workspaces without a platform agent. Provides onboarding assistance.
- **Workspace picker:** Discovers workspaces from common locations. Create new workspaces from the UI. Recent workspaces remembered across sessions.
- **Settings:** Workspace info, theme toggle (dark/light with localStorage persistence), version and feedback link.
- **Empty state onboarding:** All tabs show contextual empty states with CTAs to get started.
- **Dark and light themes:** Toggle in nav rail. Preference persisted.
- **Three-state agent model:** onTeam (has order), available (has type, no order), raw (no type or order).

### Architecture
- Single `server.js` (Node.js) + `public/app.js` + `public/index.html`
- Claude Code integration via `--print --output-format stream-json --verbose`
- WebSocket bridge between browser and Claude Code CLI processes
- Session management via `Map<conversationId, process>` with `--resume` for continuity
- Markdown rendering via `marked` library with Obsidian extension post-processing

### Dependencies
- `marked` (v17) for markdown rendering
- `ws` (v8) for WebSocket server
