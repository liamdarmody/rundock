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

## Project Structure

```
server.js          Node.js WebSocket server
public/
  index.html       Web UI
.env.example       Environment variables template
```
