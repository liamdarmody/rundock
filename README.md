# Rundock

A browser-based OS for AI agent teams. Built for knowledge work, powered by Claude Code.

**Already using Claude Code?** Rundock surfaces what the terminal hides: which agents you have, which skills they use, and what's happening across your conversations. Same `.claude/` directory, same agent files, new visibility.

Rundock gives knowledge workers a visual way to build and manage AI agent teams: an org chart, conversations, skill management, and file browsing. For product managers, researchers, strategists, consultants, writers, analysts, and operations leads.

**Rundock is not designed for coding or building apps.** It's built around markdown files and knowledge workspaces. If you're looking for AI-assisted development, use Claude Code directly in your terminal or IDE.

![Rundock org chart showing an AI agent team](docs/rundock-agent-team-org-chart.png)

## Prerequisites

- **Claude Code** installed and authenticated ([code.claude.com](https://code.claude.com))
- **Node.js** 20+ ([nodejs.org](https://nodejs.org))

## Quick start

```bash
git clone https://github.com/liamdarmody/rundock.git
cd rundock
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

You'll see a workspace picker. Choose a folder that contains (or will contain) your knowledge base and agents. If you already have a `.claude/agents/` directory, Rundock will discover it automatically.

To open a specific workspace directly:

```bash
WORKSPACE=/path/to/your/folder npm start
```

## Your team at a glance

**Team:** See your agents on an org chart. Click any agent to view their profile with role, capabilities, skills, and routines.

**Conversations:** Chat with any agent through the browser. Run multiple conversations in parallel, each with its own agent and session context.

**Skills:** See which agents use which skills at a glance. In Claude Code, skill-to-agent assignments are invisible. Rundock surfaces the full map.

**Files:** Your agents read and write files in your workspace. Browse, preview, and edit those same files with full markdown rendering.

## Setting up your workspace

**Already have Claude Code agents?** Rundock discovers them from `.claude/agents/`. They'll appear on the org chart. Add a few optional frontmatter fields to customise how they display.

**Starting fresh?** Create a new workspace from the picker, or open any folder. Rundock includes a built-in guide called Doc who will walk you through creating your first agent and setting up your workspace.

### Agent frontmatter

Rundock reads standard Claude Code agent frontmatter and adds optional fields for the visual layer:

```yaml
---
# Standard Claude Code fields
name: project-manager
description: >
  Tracks projects, surfaces blockers, and keeps work on schedule.
model: sonnet

# Rundock extension fields (all optional)
displayName: Marshall
role: Project Manager
type: specialist
order: 1
icon: ◎
colour: #6B9EF0
prompts:
  - "What needs my attention today?"
  - "Help me plan next week"
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
| `prompts` | List of starter prompts shown as pills when starting a new conversation |

## Your data never leaves your computer

```
Browser (WebSocket) <-> Node.js server <-> Claude Code CLI
```

- **server.js:** Discovers agents, skills, and files. Spawns Claude Code processes for conversations. Manages sessions.
- **public/index.html:** Single-page app with nav rail, sidebar, and main panel.
- **Claude Code:** Runs as child processes with `--output-format stream-json`. Each conversation gets its own process with session persistence via `--resume`.

Everything runs on your machine. No data is sent anywhere other than Anthropic's API (through Claude Code). Same workspace files are accessible to Rundock, Claude Code, Obsidian, VS Code, or any other tool simultaneously.

## Security and privacy

**Rundock runs entirely on your machine.** There is no cloud service, no account to create, no database, and no telemetry. Here's what that means in practice.

**Your data stays local.** Rundock is a local Node.js server that talks to Claude Code on your computer. The only external connection is from Claude Code to Anthropic's API, which is how Claude processes your messages. Rundock itself makes zero outbound network calls.

**Your API key is managed by Claude Code, not Rundock.** When you install Claude Code and sign in, it stores your authentication locally on your machine. Rundock never sees, stores, or transmits your API key. If you've already authenticated with Claude Code in your terminal, Rundock uses that same session.

**Agents can read and write files in your workspace.** Rundock runs Claude Code with permissions that allow agents to read files, write files, and run commands within your workspace folder without asking for confirmation each time. This is what makes the conversational experience smooth (an agent can create an agent file, update a document, or set up a folder structure when you ask it to). Agents do not have access to files outside your workspace.

**The codebase is small and auditable.** Rundock is roughly 800 lines of server code and 1,200 lines of client code. There are two dependencies (a markdown renderer and a WebSocket library). You can read the entire codebase in an afternoon.

**Nothing is stored in the cloud.** Conversations are held in browser memory and reset on page refresh. Your workspace files are plain files on disk. Theme preference is saved in your browser's local storage. A list of recently opened workspaces is saved to a local file in the Rundock install directory. That's it.

For technical users: the full source is in `server.js` (Node.js HTTP + WebSocket server, agent/skill discovery, Claude Code process management) and `public/app.js` (single-page client application). No build step, no bundler, no minification.

## Common issues

**"Command not found: claude"**

Claude Code isn't installed or isn't in your PATH. Install it from [code.claude.com](https://code.claude.com) and verify `claude --version` works in your terminal.

**No agents on the org chart**

Your workspace doesn't have `.claude/agents/` or the agent files are missing Rundock frontmatter. Add `type` and `order` fields to place agents on the org chart.

**Agent shows as a title-cased slug instead of a name**

Add `displayName: Your Name` to the agent's frontmatter. Without it, Rundock title-cases the `name` field (e.g. `project-manager` becomes "Project Manager").

**Skills list is empty**

Rundock looks for skills in `.claude/skills/` (SKILL.md files). Skills are also discovered from `System/Playbooks/` (PLAYBOOK.md files) if that directory exists in your workspace.

**Conversations disappear on refresh**

Conversations are stored in browser memory for now. They reset on page refresh. Session persistence is on the roadmap.

## Licence

PolyForm Perimeter 1.0.0. Use Rundock for any purpose, including commercial. The one restriction: you cannot use this code to build a product that competes with Rundock. See [LICENSE](LICENSE) for the full terms.

## Feedback

Early access. If you find bugs or have ideas, open an issue at [github.com/liamdarmody/rundock/issues](https://github.com/liamdarmody/rundock/issues).
