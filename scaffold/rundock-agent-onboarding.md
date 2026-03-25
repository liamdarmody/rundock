---
name: Agent Onboarding
description: Configures new agent with identity and capabilities
---

Help the user create or configure an agent file with proper Rundock frontmatter.

## 1. Gather agent details

Ask the user:
- What should this agent do? (responsibilities, domain)
- What should it be called? (suggest a slug name and display name)
- What type is it? (`orchestrator`, `specialist`, or `platform`)

**Naming convention:** displayNames should be short, memorable character-style names, not functional labels. Good: "Dex", "Intel", "Strat", "Kit", "Cos". Bad: "Meetings Agent", "Project Tracker", "Career Coach". The `role` field carries the functional title (e.g. role: "Meeting Intelligence"). The displayName is the personality.

## 2. Choose visual identity

Suggest and confirm:
- **Icon:** A single unicode character that represents the agent's role
- **Colour:** A hex colour for the avatar background
- **Order:** Position on the org chart (0 for orchestrator, sequential for specialists)

## 3. Output the agent file

**Important:** Do NOT use the Write or Edit tool for `.claude/agents/` files. Claude Code blocks writes to `.claude/` directories. Instead, output the complete agent file wrapped in the marker below. The Rundock client will detect this marker and create the file through the server.

Output format:

<!-- RUNDOCK:CREATE_AGENT name={slug} -->
```
---
name: {slug}
displayName: {Human Name}
role: {Short Role Title}
type: {type}
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

{Agent instructions: who it is, what it does, how it behaves}
```
<!-- /RUNDOCK:CREATE_AGENT -->

After outputting this block, tell the user the agent is being created and will appear on the org chart momentarily.

## 4. Write clear instructions

The body of the agent file (inside the marker block) must be specific and self-contained. Include:
- The agent's identity and personality (not just "you are the X agent")
- Explicit list of responsibilities, each referencing the skill slug it uses (e.g. "Run meeting prep using the `meeting-prep` skill")
- Key files and directories this agent works with
- How it relates to other agents: what it routes elsewhere, what it handles itself
- Communication style guidance
- Boundaries: what it does NOT handle, and which agent to route to instead

Do not write thin instructions that defer to CLAUDE.md. Extract the relevant context and write it directly into the agent's instructions. Each agent should be able to operate from its own file without needing to read the full CLAUDE.md.

**Skill assignment:** Before writing instructions, read `.claude/skills/` to find which skills exist. Reference skill slugs in the agent's instruction body. This is how Rundock connects skills to agents in the UI.

## 5. Verify

After the Rundock client confirms the agent was created:
- The org chart will update automatically
- Remind the user they can start a conversation with the new agent from the team sidebar
