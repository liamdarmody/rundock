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

## 2. Choose visual identity

Suggest and confirm:
- **Icon:** A single unicode character that represents the agent's role
- **Colour:** A hex colour for the avatar background
- **Order:** Position on the org chart (0 for orchestrator, sequential for specialists)

## 3. Write the agent file

Create `.claude/agents/{name}.md` with:

```yaml
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

## 4. Write clear instructions

The body of the agent file should include:
- The agent's identity and role
- What tasks it handles
- How it should communicate
- Any tools, skills, or files it should reference
- Boundaries: what it should NOT do

## 5. Verify

After creating the agent:
- Confirm the file is saved to `.claude/agents/`
- Check that frontmatter parses correctly
- Remind the user to refresh Rundock to see the new agent on the org chart
