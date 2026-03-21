# Rundock

Your personal AI operating system. BYO AI. We provide the OS.

A web interface for Claude Code that gives non-technical users the same power developers get in the terminal. Manage your AI team, have multi-agent conversations, edit files, and buy agents and skills from a marketplace.

## Quick Start

```bash
npm install
WORKSPACE=/path/to/your/workspace npm start
```

Open `http://localhost:3000`.

## Requirements

- Node.js 20+
- Claude Code CLI installed and authenticated (`claude auth login`)

## How It Works

The server spawns Claude Code with `--output-format stream-json` and bridges it to the browser via WebSocket. Your Anthropic subscription (Pro/Max) handles all AI compute. Rundock provides the interface.

### Architecture

```
Browser (public/index.html)
    ↕ WebSocket
server.js (Node.js)
    ↕ spawns: claude --print --output-format stream-json --agent <name>
    ↕ fs.readFileSync / fs.writeFileSync
Workspace directory (local disk)
```

One Node.js process. No database. No containers. No auth. The same workspace files are accessible to Rundock, Claude Code, and any other tool (Obsidian, VS Code, etc.) simultaneously.

### Agent Discovery

Agents are loaded dynamically from `.claude/agents/` in the workspace. Each agent is a markdown file with YAML frontmatter:

```yaml
---
name: Ana
role: Content Analyst
description: Analyses content performance data...
tools: Read, Glob, Grep, Bash
model: sonnet
maxTurns: 15
---

# Instructions for this agent...
```

The default agent is defined by the workspace's `CLAUDE.md` file.

### File Operations

Files are read and written directly to the workspace filesystem. Auto-save with 1.5s debounce. Changes made in Rundock are immediately visible to Claude Code, Obsidian, or any other tool accessing the same directory.

### Production Path

This same server.js runs inside a per-user container (Fly.io Machine) in production. The code doesn't change. The only differences are: files live on a persistent volume instead of local disk, auth is handled via Claude Code's setup-token OAuth flow, and a backend routes traffic between users and their containers.

## Project Structure

```
server.js          Node.js WebSocket server + agent discovery
public/
  index.html       Web UI (three-column layout, org chart, chat, files)
.env.example       Environment variables template
```

## Features

- Dynamic agent discovery from workspace
- Multi-agent conversations (each agent gets its own Claude Code session)
- Org chart team view
- Agent profiles with description, tools, model, and instructions
- Real-time chat with thinking indicators and tool use display
- File tree browsing and editing with auto-save
- Conversation history (in-memory, per session)
- Dark/light mode
- Markdown rendering in chat messages
