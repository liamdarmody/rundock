---
name: Workspace Management
description: Set up, configure, and audit the Rundock workspace
---

Manage the Rundock workspace: initial setup, configuration updates, and health checks.

## Setup (new or existing workspace)

**Read before asking.** Before asking the user anything:
- Read `CLAUDE.md` if it exists
- Run `ls` on the workspace root and key directories
- Check `.claude/settings.json` for tool permissions, hooks, and MCP servers
- Check `.claude/skills/` and `.claude/agents/` for existing capabilities
- Summarise what you found. Propose a plan based on what already exists.

Only ask about things the files don't answer:
- Who will use it (just the user, or a team)?
- Any tools or integrations not already visible in the config?

### Create or update CLAUDE.md

Write a `CLAUDE.md` at the workspace root with:
- Clear heading with the workspace name
- What the workspace is for
- Key rules and conventions
- File structure and naming patterns
- Tool or integration notes

Keep it concise. CLAUDE.md should be a quick reference, not a manual.

### Set up folder structure

Suggest the best-fit structure based on the workspace purpose:

**PARA** (personal productivity, knowledge management):
- `0 Inbox/`, `1 Projects/`, `2 Areas/`, `3 Resources/`, `4 Archive/`

**Functional** (business or team workspaces):
- Organised by domain: `Clients/`, `Operations/`, `Finance/`, `Marketing/`, etc.

**Minimal** (lightweight, low-maintenance):
- `Inbox/`, `Working/`, `Reference/`

Let the user choose or adapt. Don't impose a structure they won't maintain.

## Audit (workspace health check)

Run this when the user asks "how's my workspace?" or "review my setup."

### Check workspace fundamentals
- [ ] CLAUDE.md exists and is current (not stale or generic)
- [ ] Folder structure matches the workspace's actual use
- [ ] `.claude/agents/` exists with at least one agent
- [ ] `.claude/settings.json` has appropriate permissions

### Check team coverage
- [ ] Every skill in `.claude/skills/` is assigned to at least one agent
- [ ] No orphan skills (skill exists but no agent references it)
- [ ] No phantom references (agent references a skill slug that doesn't exist)
- [ ] Skill assignment doesn't overlap (each skill owned by exactly one agent)

### Check overall health
- [ ] Exactly one orchestrator agent
- [ ] Orchestrator delegates Rundock operations to Doc
- [ ] All specialists have routing boundaries
- [ ] No raw/unupgraded agents in Available

### Report

Present findings as:
- **Issues (must fix):** Broken references, missing agents, structural problems
- **Warnings (should fix):** Stale CLAUDE.md, unassigned skills, thin coverage
- **Good:** What's working well

Offer to fix each issue. For agent or skill changes, use the appropriate Rundock markers.
