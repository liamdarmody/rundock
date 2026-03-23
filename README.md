# Rundock

A visual interface for managing AI agent teams powered by Claude Code.

Rundock gives you an org chart, conversations, skill management, and file browsing for your Claude Code agents. It makes AI agent teams accessible without the terminal.

## Prerequisites

- **Claude Code** installed and authenticated ([code.claude.com](https://code.claude.com))
- **Node.js** 18+ ([nodejs.org](https://nodejs.org))

## Quick start

```bash
git clone https://github.com/liamdarmody/rundock.git
cd rundock
npm install
node server.js
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

You'll see a workspace picker. Choose a folder that contains (or will contain) your Claude Code agents. If you already have a `.claude/agents/` directory, Rundock will discover it automatically.

To open a specific workspace directly:

```bash
WORKSPACE=/path/to/your/folder node server.js
```

## What you'll see

**Team:** An org chart showing your agents. Click any agent to see their profile with role, capabilities, skills, and routines.

**Conversations:** Chat with any agent through the browser. Messages go to Claude Code under the hood. Each conversation maintains its own session with context preserved across messages.

**Skills:** Browse the skills in your workspace. See which agents use which skills. Click through to read the source files.

**Files:** Browse and edit workspace files with markdown preview and syntax highlighting.

## Setting up your workspace

**Already have Claude Code agents?** Rundock discovers them from `.claude/agents/`. They'll appear on the org chart. Add a few optional frontmatter fields to customise how they display.

**Starting fresh?** Open any folder. You can set up agents and workspace rules from there.

### Agent frontmatter

Rundock reads standard Claude Code agent frontmatter and adds optional fields for the visual layer:

```yaml
---
# Standard Claude Code fields
name: content-creator
description: >
  Full content pipeline from idea to publish-ready post.
model: opus

# Rundock extension fields (all optional)
displayName: Penn
role: Content Creator
type: specialist
order: 3
icon: ✎
colour: #6BC67E
---
```

| Field | Purpose |
|---|---|
| `displayName` | Human-friendly name for the UI. Falls back to title-cased `name` if not set |
| `role` | Short title on org chart (2-4 words) |
| `type` | `orchestrator`, `specialist`, or `platform`. Determines org chart position |
| `order` | Position on org chart. Orchestrator is 0, specialists numbered after |
| `icon` | Single unicode character for the avatar circle |
| `colour` | Hex colour for the avatar background |

## How it works

```
Browser (WebSocket) <-> Node.js server <-> Claude Code CLI
```

- **server.js:** Discovers agents, skills, and files. Spawns Claude Code processes for conversations. Manages sessions.
- **public/index.html:** Single-page app with nav rail, sidebar, and main panel.
- **Claude Code:** Runs as child processes with `--output-format stream-json`. Each conversation gets its own process with session persistence via `--resume`.

Everything runs on your machine. No data is sent anywhere other than Anthropic's API (through Claude Code). Same workspace files are accessible to Rundock, Claude Code, Obsidian, VS Code, or any other tool simultaneously.

## Common issues

**"Command not found: claude"**

Claude Code isn't installed or isn't in your PATH. Install it from [code.claude.com](https://code.claude.com) and verify `claude --version` works in your terminal.

**No agents on the org chart**

Your workspace doesn't have `.claude/agents/` or the agent files are missing Rundock frontmatter (`type` and `order` fields). Add these fields to place agents on the org chart.

**Agent shows as "Content Creator" instead of a name**

Add `displayName: Penn` to the agent's frontmatter. Without it, Rundock title-cases the `name` field.

**Skills list is empty**

Rundock looks for skills in `System/Playbooks/` (PLAYBOOK.md files) and `.claude/skills/` (SKILL.md files).

**Conversations disappear on refresh**

Conversations are stored in browser memory for this MVP. They reset on page refresh. Session persistence is planned.

## Feedback

This is an early MVP. If you find bugs or have ideas, open an issue at [github.com/liamdarmody/rundock/issues](https://github.com/liamdarmody/rundock/issues).
