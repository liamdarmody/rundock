---
name: Agent Management
description: Create, edit, upgrade, delete, and audit agents
---

Manage agents in `.claude/agents/`. This skill covers the full lifecycle.

## Important: file access

Claude Code blocks Write and Edit tools for files inside `.claude/`. Do NOT use Write, Edit, or Bash to create, modify, or delete agent files. Instead, use RUNDOCK markers. The Rundock client detects these markers in your response and saves the files through the server.

## Create an agent

### 1. Gather details

Ask the user:
- What should this agent do? (responsibilities, domain)
- What should it be called? (suggest a slug name and display name)
- What type is it? (`orchestrator` or `specialist`)

If the user already provided enough detail, skip straight to drafting.

### 2. Choose identity

Suggest and confirm:
- **displayName:** Short, memorable, character-style. Good: "Dex", "Intel", "Kit". Bad: "Meetings Agent", "Project Tracker". The `role` field carries the functional title.
- **role:** 2-4 word title (e.g. "Meeting Intelligence", "Content Strategist")
- **icon:** Single unicode character. Must be visually distinct from existing agents.
- **colour:** Hex colour for avatar. Must be visually distinct from existing agents.
- **order:** 0 for orchestrator, sequential for specialists. Check existing agents to avoid collisions.
- **model:** `opus` for orchestrator, `sonnet` for most specialists

### 3. Write instructions

The instruction body must be specific and self-contained. Include:
- Identity statement: "You are [name], the [role] for this workspace."
- Explicit responsibilities, each referencing the skill slug it uses
- Key files and directories this agent works with
- How it relates to other agents: what it routes elsewhere, what it handles itself
- Communication style guidance
- Boundaries: what it does NOT handle, and which agent to route to instead

**Quality rules:**
- At least 200 words. Thin instructions produce generic behaviour.
- Do not defer to CLAUDE.md. Extract relevant context into the agent's own instructions.
- Every specialist needs a "What you don't handle" section.
- Orchestrator must include: "For Rundock platform operations (agent, skill, or workspace changes), delegate to Doc."
- No em dashes or en dashes. Use colons to separate labels from descriptions.
- UK spelling throughout.

**Skill assignment:** Before writing instructions, read `.claude/skills/` to find existing skills. Reference skill slugs in the instruction body. This is how Rundock connects skills to agents in the UI. Each skill should be assigned to exactly one agent.

### 4. Save the agent

Output the complete agent file wrapped in the marker:

<!-- RUNDOCK:SAVE_AGENT name={slug} -->
```
---
name: {slug}
displayName: {Human Name}
role: {Short Role Title}
type: {orchestrator|specialist}
order: {number}
icon: {unicode}
colour: {hex}
model: {opus|sonnet|haiku}
description: >
  {What the agent does}
prompts:
  - "{First starter prompt}"
  - "{Second starter prompt}"
---

{Agent instructions}
```
<!-- /RUNDOCK:SAVE_AGENT -->

After saving, tell the user the agent will appear on the org chart and suggest a first conversation prompt.

## Edit an agent

1. Read the current agent file from `.claude/agents/{slug}.md`
2. Make the requested changes
3. Output the complete updated file using the SAVE_AGENT marker (same format as create)
4. Confirm what changed

## Upgrade a raw agent

When a workspace has agent files created outside Rundock (missing `type`, `order`, `displayName`, `role`, `icon`, `colour`):

1. Read the existing agent file. Understand what it does from its instructions.
2. Propose Rundock frontmatter fields based on the instructions. Present as a compact proposal.
3. **Preserve the original instructions body exactly as-is.** Only modify frontmatter.
4. Output the complete file using the SAVE_AGENT marker.

For batch upgrades: read all agents first to understand the full team, assign types based on relationships, choose visually distinct icons and colours, output 2-3 per response.

**Rules for upgrades:**
- Never rewrite instructions. The user wrote them for a reason.
- Preserve all existing frontmatter fields.
- Ask before assigning type. The orchestrator/specialist distinction matters.

## Delete an agent

Output the delete marker:

<!-- RUNDOCK:DELETE_AGENT name={slug} -->

Confirm: "Agent `{slug}` has been removed. The org chart will update automatically."

If the deleted agent owned skills, suggest reassigning them.

## Audit agents

Review all agents for quality and consistency.

### Per-agent checks
- [ ] All frontmatter fields present (name, description, displayName, role, type, order, icon, colour, model, prompts)
- [ ] Identity statement in instructions
- [ ] Specific responsibilities with skill slug references
- [ ] Routing boundaries for specialists
- [ ] Workspace-specific file paths (not placeholders)
- [ ] At least 200 words of instructions
- [ ] No em dashes or en dashes
- [ ] UK spelling

### Team-wide checks
- [ ] Exactly one orchestrator
- [ ] No duplicate order numbers
- [ ] All icons visually distinct
- [ ] All colours visually distinct
- [ ] Orchestrator delegates Rundock operations to Doc
- [ ] Specialists route out-of-scope requests correctly

### Report and fix

Present findings as **Issues** (must fix), **Warnings** (should fix), **Good** (working well).

Offer to fix each issue. Output corrected agent files using the SAVE_AGENT marker, one at a time, confirming each before moving to the next.

## Team restructuring

When the user wants to reorganise (split an agent, merge agents, reassign skills):

1. Read all agents and all skills to understand the current state
2. Propose the restructuring plan: which agents change, which skills move, what's created or deleted
3. Confirm the plan before executing
4. Execute changes one agent at a time using SAVE_AGENT and DELETE_AGENT markers
5. After restructuring, run the audit checks to verify consistency
