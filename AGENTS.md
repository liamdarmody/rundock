# Rundock agents

An agent in Rundock is a markdown file with YAML frontmatter. The frontmatter declares the agent's identity (name, role, position in the org chart, icon, colour). The body of the file is the system prompt that Claude Code loads when the agent is spawned.

Every Rundock agent file lives at:

```
<workspace>/.claude/agents/<slug>.md
```

The filename (without `.md`) becomes the agent's slug. The slug is what other agents reference in `reportsTo`, what the orchestrator uses when it delegates, and what Claude Code looks for when spawning the agent.

Rundock uses Claude Code's standard agent format. An agent written for plain Claude Code works in Rundock; an agent written for Rundock works in plain Claude Code. The Rundock-specific fields are additive and ignored by Claude Code. They control how the agent is rendered in the org chart, how it sorts among siblings, and how it relates to other agents in the team.

## Frontmatter reference

Every field below is parsed by `parseAgentFrontmatter` in `server.js`. The parser is intentionally lenient: it accepts standard YAML for the field types listed and silently ignores fields it does not recognise. Typos in field names will not raise an error, so check the table when in doubt.

Universal fields work with any tool that supports the Claude agent format. Rundock-only fields are read by Rundock and silently ignored elsewhere.

| Field | Type | Scope | Required | Purpose | Example |
|---|---|---|---|---|---|
| `name` | string | Universal | Yes | The agent's slug. Should match the filename without the `.md` extension. Used by Claude Code to resolve the agent and by Rundock for `reportsTo` references. | `name: chief-of-staff` |
| `description` | string | Universal | Yes | One-line description of what this agent does. Required by Claude Code; if absent, the agent is silently excluded from spawn. Rundock displays this in the agent list and on the profile. Multi-line YAML scalars (`>` and `|`) are supported. | `description: Routes work, manages priorities, daily briefings.` |
| `model` | string | Universal | No | The Claude model to use for this agent. Accepts `opus`, `sonnet`, `haiku`, or `inherit`. Falls through to Claude Code's default if omitted. | `model: opus` |
| `tools` | array of strings | Universal | No | Allowed tools for this agent. Read by Claude Code from the agent file when it spawns the subprocess; Rundock does not forward this field. Not surfaced in the Rundock UI. | `tools: [Read, Write, Bash]` |
| `displayName` | string | Rundock-only | No | Human-readable name shown in the org chart, sidebar, and conversation header. If omitted, Rundock title-cases the slug. Recommended: short, memorable, character-style names (Cos, Penn, Lea, Ted). Not functional labels. | `displayName: Cos` |
| `role` | string | Rundock-only | No | Short role title shown beneath the displayName on the org chart card. 2 to 4 words. If omitted, the title-cased slug is used. | `role: Chief of Staff` |
| `type` | enum | Rundock-only | No | One of `orchestrator`, `specialist`, or `platform`. Determines org chart position. There should be exactly one orchestrator per workspace. Platform agents (like Doc) appear below a divider in the team list and are managed by Rundock, not by the user. | `type: orchestrator` |
| `order` | number | Rundock-only | No | Numeric position on the org chart among siblings. Lower numbers appear first. The orchestrator should be `0`. Specialists are `1`, `2`, `3`, etc. Decimals (e.g. `1.1`, `1.2`) group sub-agents under a parent specialist. If omitted, the agent is treated as `available` (visible in the team list but not yet placed on the chart). | `order: 2` |
| `reportsTo` | string | Rundock-only | No, but recommended for every specialist | The slug of the agent this one reports to. Drives the org chart hierarchy and the delegation chain. For a flat team, every specialist sets this to the orchestrator's slug. For a multi-level team, sub-agents set this to the lead specialist's slug. | `reportsTo: chief-of-staff` |
| `icon` | string | Rundock-only | No | A single unicode character used as the agent's avatar. If omitted, Rundock assigns one from a default rotation. Pick something visually distinct from every other agent's icon at small sizes. Avoid characters that look similar (e.g. `◆` and `◈`). Doc reserves `⬡`. | `icon: ★` |
| `colour` | string (hex) | Rundock-only | No | Accent colour for the agent's org chart card and profile header. Hex value with leading `#`, quoted (the leading `#` is otherwise read by YAML as a comment). Hex only: named colours are not resolved. UK spelling: the field is `colour`, not `color`. If omitted, Rundock assigns one from a balanced palette in rotation. | `colour: "#E87A5A"` |
| `prompts` | array of strings | Rundock-only | No | Starter prompts shown in the conversation panel when a user opens this agent for the first time. 2 to 4 entries is typical. Each entry is one suggested user message. | See example below. |
| `skills` | array of strings | Rundock-only | No | Explicit list of skill slugs assigned to this agent. Block form only (`- slug` on indented lines). Inline flow-style arrays (`[a, b]`) parse as empty. Takes precedence over body-text scanning. If omitted, Rundock falls back to scanning the agent's instruction body for skill slug mentions. | See example below. |
| `capabilities` | object | Rundock-only | No | Human-readable description of what the agent can do, structured for the profile page. The convention is the four-key schema `does`, `reads`, `writes`, `connectors`. The parser accepts any string-valued keys, so additional keys (such as `web` and `code` used by Doc's scaffold) are tolerated, but the conventional set is what every working specialist uses. | See example below. |
| `routines` | array of objects | Rundock-only | No | Scheduled tasks this agent runs automatically. Each routine has `name`, `schedule`, `prompt`, and an optional `description`. The scheduler ticks every minute and runs any routine whose schedule has come due. See [ROUTINES.md](ROUTINES.md) for the full reference. | See example below. |
| `maxTurns` | number | Rundock-only | No | Conversation turn cap. Not in Claude Code's standard agent frontmatter and not forwarded by Rundock to the spawn; preserved in the file for tooling that reads it directly. | `maxTurns: 50` |
| `mcpServers` | array of strings | Rundock-only | No | MCP servers this agent can access. Not in Claude Code's standard agent frontmatter; MCP server selection is governed by the workspace's `.mcp.json` and `.claude/settings.local.json`. Rundock displays these on the profile under connectors when present. | `mcpServers: [notion-dewey]` |
| `disallowedTools` | array of strings | Rundock-only | No | Blocked tools for this agent. Not in Claude Code's standard agent frontmatter and not forwarded by Rundock to the spawn (Rundock derives its disallowed-tools list from workspace mode, not from agent frontmatter). | `disallowedTools: [WebFetch]` |

### The capabilities object

The capabilities block is shown on the agent's profile page. The parser accepts any string-valued keys, but the conventional structure is:

```yaml
capabilities:
  does: One-line summary of what the agent does.
  reads: The data sources it reads from.
  writes: What it produces and where.
  connectors: Named integrations the agent uses.
```

Each value is a string. The convention is plain prose, not bullet lists.

### The routines array

Each routine is a YAML object inside the `routines` array, with four fields: `name`, `schedule`, `prompt`, and an optional `description`.

```yaml
routines:
  - name: Morning briefing
    schedule: every day at 05:00
    prompt: Run the morning briefing
    description: Triage today's tasks, calendar, and content pipeline at 5am.
```

The `schedule` field accepts only specific human-readable forms (cron is not supported). Routines fire only while Rundock is running. See [ROUTINES.md](ROUTINES.md) for the schedule format, scheduler behaviour, where output goes, and common pitfalls.

### The skills array

Use the block form. Inline flow-style arrays do not parse and silently fall through to body-text scanning.

```yaml
skills:
  - linkedin-hook-generator
  - voice-editor
  - readwise-highlights
```

Each entry is a skill slug as it appears in `.claude/skills/<slug>/` or `System/Playbooks/<slug>/`. Slugs are case-insensitive on the match, but write them lowercase to match the directory names. See [SKILLS.md](SKILLS.md) for the full skill assignment model.

### The prompts array

Starter prompts shown in the conversation panel on first open. 2 to 4 entries is typical.

```yaml
prompts:
  - "Build the feature described in this spec..."
  - "Review this code before I merge it"
  - "Break this feature down into tasks"
  - "Write a spec for..."
```

Each entry is a complete sentence written as the user would phrase it, not as a command to the agent.

## The body

The markdown body, everything after the closing `---` of the frontmatter, is the agent's system prompt. Claude Code loads this verbatim when it spawns the agent.

Write the body in the second person, addressing the agent as "you". This is what Claude Code's spawn loader expects, and it is what every working agent in this workspace uses. Examples:

```markdown
You are Cos, Liam's AI Chief of Staff. An operator who protects Liam's
time, routes work to specialists, and keeps priorities visible.
```

What goes in the body:

- The agent's identity (name, role, who they work for).
- Scope: what the agent handles and what it does not.
- Delegation rules: which specialists it routes to and for what.
- Any voice or tone guidance specific to the agent.
- File path conventions, output formats, and skill usage instructions.
- The "when out of scope, route back" instruction (see Common pitfalls).

What does **not** need to go in the body:

Rundock injects several blocks of context at spawn time, so you should not duplicate them in the body. The injected context covers:

- **`YOUR TEAMMATES`:** the roster of other agents in this workspace, their slugs, and their roles. The agent uses this to address teammates by name without you hardcoding the team list.
- **Delegation mechanics:** how to emit the delegation marker (the agent does not need to know the marker syntax; Rundock injects it).
- **Scope boundary:** Rundock and Claude Code's joint guarantee about what the agent can and cannot touch.
- **Platform routing:** how to send work to Doc for workspace-level operations.

Focus the body on the agent's identity, voice, and unique instructions. Leave the team-shape and platform mechanics to Rundock.

## Workspace modes: Knowledge vs Code

Rundock has two workspace modes that change agent behaviour at the platform level. The mode is set per workspace, not per agent.

| Mode | What it changes |
|---|---|
| **Knowledge mode** (default) | Restricts file writes and edits for executable file types (`.js`, `.py`, `.sh`, etc) so agents cannot accidentally write or modify code in a knowledge-work workspace. Tool permission cards are shown for most operations. |
| **Code mode** | Removes the executable-file write restriction. Auto-approves common build and dev tools so agents can iterate on code without permission card interruptions. Used for software project workspaces. |

Mode is set in the workspace settings drawer in the browser, or by editing `.rundock/state.json` directly:

```json
{
  "workspaceMode": "code"
}
```

When a workspace is first opened, Rundock auto-detects the likely mode by looking at the file structure (presence of `package.json`, `pyproject.toml`, `Cargo.toml`, etc).

The mode affects every agent in the workspace, not just one. There is no per-agent override.

## Complete example

Here is `lead-developer.md`, the engineering lead in this workspace, with rich frontmatter and a full body. Every field has been verified against the live agent file.

```markdown
---
name: lead-developer
displayName: Dev
role: Lead Developer
type: specialist
order: 4
reportsTo: chief-of-staff
icon: ⌘
colour: "#2ECC71"
model: opus
description: >
  Lead Developer responsible for all software projects, Personal OS automations,
  and vault infrastructure tooling. Spec-first, incremental, quality-gated engineering.
prompts:
  - "Build the feature described in this spec..."
  - "Review this code before I merge it"
  - "Break this feature down into tasks"
  - "Write a spec for..."
---

# Dev: Lead Developer

You are Dev, Liam's Lead Developer. You own all engineering work: Rundock
application code, Personal OS automation scripts, and vault infrastructure
tooling.

You report to Cos (chief-of-staff). You do not handle content creation,
research, strategy, or product decisions. If a request falls outside
engineering, route it back to Cos.

## Your scope

(rest of body covers in-scope domains, working style, atomic commits,
project registry, and communication style)
```

Notes on this example:

- `name: lead-developer` matches the filename `lead-developer.md`.
- `order: 4` places Dev fourth on the chart, after the orchestrator (0) and three earlier specialists.
- `reportsTo: chief-of-staff` puts Dev on the orchestrator's direct line.
- `colour` uses the UK spelling. The hex value is quoted because YAML treats the leading `#` as a comment character if unquoted.
- `description` uses YAML's folded-scalar syntax (`>`) so the description can span lines while parsing as a single string.
- `prompts` are written as the user would phrase them, not as commands. Each one is a complete sentence the user can click to send.

## Skills

Skills are markdown files at `.claude/skills/<slug>/SKILL.md`. They are reusable instructions for specific tasks. An agent uses a skill in two ways:

1. **Explicit assignment** via the `skills:` frontmatter array. Each entry is a skill slug.
2. **Implicit assignment** via body-text scan. If the agent's body mentions a skill slug as a distinct token, Rundock treats the skill as available to that agent.

Explicit assignment via `skills:` takes precedence. If you list a skill in the array, Rundock does not also rely on the body-text scan for that skill.

A skill can be assigned to multiple agents. Skills are shown on each agent's profile, with the skill's display name and description.

For more on skill files, see [SKILLS.md](SKILLS.md) or look at any of the skills currently in `.claude/skills/` for working examples.

## Common pitfalls

A few specific things that go wrong silently, in roughly the order of frequency.

**Filename does not match `name`.** The filename (without `.md`) is the slug. The frontmatter's `name` should match. They control different things in Claude Code's spawn path, and a mismatch can cause the agent to be invisible to the orchestrator's delegation. Keep them the same.

**Two orchestrators in one workspace.** Only one agent should have `type: orchestrator`. Rundock will surface both, but the delegation chain assumes a single root. If two agents have `type: orchestrator`, the org chart and the routing logic will pick one arbitrarily.

**`reportsTo` points to a slug that does not exist.** The reference must resolve to another agent's slug in the same workspace. If the target does not exist, the specialist will be invisible on the org chart (or attached to the wrong parent). The Workspace audit catches this.

**Frontmatter validates loosely.** A typo in a field name (`displayname` instead of `displayName`, `colors` instead of `colour`) is silently ignored. The agent loads with whatever defaults Rundock assigns. If your agent looks generic in the org chart, check the field names against this reference.

**`order` collisions.** Two specialists with the same `order` value will appear in indeterminate sibling order. Pick a unique integer for each top-level specialist. Use decimals for sub-agents under a parent (`1.1`, `1.2`).

**Hex colour without quotes.** YAML treats a `#` at the start of a scalar as the start of a comment. Quote hex colours: `colour: "#E87A5A"`, not `colour: #E87A5A`.

**Body says "you must delegate using this exact marker".** Do not write delegation marker syntax into the agent's body. Rundock injects the delegation mechanics at spawn time. The body should describe **what** to delegate and **to whom**, never the marker format. Hardcoded markers in the body confuse the model and degrade delegation quality.

**No "out of scope" instruction.** Every specialist should include a short instruction on what to do when a request falls outside their domain: tell the user briefly, do not name other specialists, and emit `<!-- RUNDOCK:RETURN -->` at the end of the response. Without this, the specialist will try to handle out-of-scope work itself instead of routing it back. See any of the live specialists for the exact wording.

## Pointers

- [ARCHITECTURE.md](ARCHITECTURE.md): the process model, workspace directory, and codebase structure.
- [CONTRIBUTING.md](CONTRIBUTING.md): dev environment setup and code conventions.
- The agent files in `.claude/agents/`: the canonical reference for what works in practice.
