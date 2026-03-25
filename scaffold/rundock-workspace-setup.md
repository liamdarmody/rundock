---
name: Workspace Setup
description: Configures new workspace with rules and structure
---

Help the user set up their Rundock workspace. Walk through the following:

## 1. Understand the workspace

**Read before asking.** Before asking the user anything:
- Read `CLAUDE.md` if it exists (this often contains a full description of the workspace purpose, rules, and structure)
- Run `ls` on the workspace root and key directories to understand the folder structure
- Check `.claude/settings.json` for existing tool permissions, hooks, and MCP servers
- Check `.claude/skills/` and any system/playbook directories for existing capabilities
- Summarise what you found. Propose a plan based on what the workspace already contains

Only ask questions about things the files don't answer:
- Who will use it (just the user, or a team)?
- Any tools or integrations not already visible in the config?

## 2. Create CLAUDE.md

Based on the conversation, create a `CLAUDE.md` file at the workspace root with:
- A clear heading with the workspace name
- What the workspace is for
- Key rules and conventions
- Any file structure or naming patterns
- Tool or integration notes

Keep it concise. CLAUDE.md should be a quick reference, not a manual.

## 3. Set up workspace structure

Ask what kind of work this workspace supports, then suggest the best-fit structure:

**PARA** (personal productivity, knowledge management):
- `0 Inbox/` - unsorted capture, the starting point
- `1 Projects/` - active work with a deadline or outcome
- `2 Areas/` - ongoing responsibilities (e.g. Marketing, Finance, Health)
- `3 Resources/` - reference material by theme
- `4 Archive/` - completed or inactive items

**Functional** (business or team workspaces):
- Organised by domain: `Clients/`, `Operations/`, `Finance/`, `Marketing/`, etc.
- Each folder maps to a responsibility area the team manages

**Minimal** (lightweight, low-maintenance):
- `Inbox/` - everything lands here
- `Working/` - active items
- `Reference/` - anything worth keeping

Let the user choose or adapt. Don't impose a structure they won't maintain.

## 4. Verify

After setup, confirm:
- `.claude/agents/` directory exists
- CLAUDE.md is written
- Any requested folders are created
- The workspace will be discoverable by Rundock
