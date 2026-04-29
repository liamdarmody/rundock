# Rundock skills

A skill in Rundock is a reusable instruction document, written for the agent that will use it. A research workflow, a writing process, an audit checklist, a sales prep sequence: each one belongs in a skill file so the same instructions can attach to one or more agents without being duplicated in every agent's body.

Every Rundock skill file lives in one of two places:

```
<workspace>/.claude/skills/<slug>/SKILL.md
<workspace>/System/Playbooks/<slug>/PLAYBOOK.md
```

Both locations are scanned. Both use a folder named after the slug, with a single definition file inside. Flat files at `.claude/skills/<slug>.md` are not supported. The folder shape exists so a skill can keep references, sub-files, and assets next to its definition without polluting the skills root.

The folder name is the skill's slug. The slug is what an agent's `skills:` array references, what the body-text scanner looks for, and what Rundock uses to deduplicate between the two source locations. Use lowercase letters, numbers, and hyphens only. No spaces, no underscores in the slug.

## Frontmatter reference

Skill frontmatter is intentionally lean. Rundock's `parseSkillFile` reads two fields and stops. Every other YAML key in the frontmatter block is preserved on disk, but Rundock will not act on it. If a field below is marked Universal but Rundock-only is "no", that means Claude Code or another consumer may read it; Rundock does not.

Universal fields work with any tool that supports the Claude agent and skill format. Rundock-only fields are read by Rundock and silently ignored elsewhere.

| Field | Type | Scope | Required | Description | Example |
|---|---|---|---|---|---|
| `name` | string | Universal | Recommended | Display name for the skill, shown on the agent profile and in the skill list. If omitted or equal to the slug, Rundock title-cases the slug (with brand-word overrides like LinkedIn, Notion, MCP). Plain prose is fine, not just a slug-style identifier. | `name: Skill Discovery` |
| `description` | string | Universal | Recommended | One-paragraph description of what the skill does and when to use it. The orchestrator uses this to decide whether to route work to an agent that owns this skill, so write it as a routing signal, not a tagline. Folded YAML scalars (`>`) and indented multi-line forms are supported. | `description: Scan recent work surfaces for repeated manual patterns and propose new skills to build, ranked by leverage.` |
| `allowed-tools` | array | Universal (Claude Code) | No | Tools Claude Code is allowed to invoke while running this skill. Rundock does not read this field; Claude Code does, when the skill is loaded into a subprocess. Leaving it off lets the spawned agent inherit its workspace-mode tool defaults. | `allowed-tools: [Read, Write, Bash]` |
| `model` | string | Universal (Claude Code) | No | Model override for this skill. Same caveat as `allowed-tools`: Rundock does not read it, Claude Code may. In practice none of the live skills set this and behaviour follows the invoking agent's model. | `model: opus` |
| `displayName` | string | Rundock-only | No | Not parsed. Rundock derives display name from `name` and the slug. Listed here only to flag that the field is not honoured even though the convention exists for agents. | (do not use) |
| `icon` | string | Rundock-only | No | Not parsed. Skills inherit the icon of their assigned agents in the UI. | (do not use) |
| `colour` | string (hex) | Rundock-only | No | Not parsed. Skills inherit accent colours from their assigned agents. | (do not use) |

The minimal valid skill frontmatter is just `name` and `description`. Both can be omitted entirely (the slug becomes the display name and the description is empty), but a skill without a description is invisible to the orchestrator's routing decisions, so always write one.

## The body

The body is everything after the closing `---` of the frontmatter. It is the skill's instruction set, written for the agent that will run it. There is no implicit context injection at skill load: Rundock does not prepend or append anything. What you write is what the agent sees.

Write the body in the second person, addressing the agent. Match the voice of the calling agent: a research skill called by Penn reads in Penn's tone, a code review skill called by Dev reads in Dev's tone. Skills are leaf instructions, not standalone personalities, so do not introduce a new identity in the skill body.

Length discipline. Skills should be short and self-contained. The live skills in this workspace cluster around 100 to 200 lines of body text. If a skill is growing past 300 lines, it is doing too much. Split it into two skills, or move the bulk into reference files in a sibling folder and link to them from the body.

Reference files. A skill can keep supporting documents next to it: examples, templates, sub-routines, schemas. Put them in a `references/` folder under the skill, and link from the body with relative paths. Rundock does not parse these files; they are loaded by the agent only when the body text instructs it.

Cross-skill references. Skills can mention other skills by slug to suggest follow-on work. The body of `spec-driven-dev` mentions `task-breakdown` and `incremental-impl`, for example. The orchestrator does not chain skills automatically; the agent decides whether to invoke a follow-on, based on the body's guidance.

Routing language. The first paragraph of the body should make the skill's trigger obvious. The orchestrator weighs the skill's `description` field against the user's request, but the agent itself reads the body and decides whether to enter the skill. Open with a clear "Use this skill when..." statement so the agent has unambiguous entry criteria.

Boundaries. Most skills should explicitly state what they do NOT do. A skill that proposes candidates but does not create files. A skill that drafts but does not publish. A skill that audits but does not fix. The boundary is what keeps a skill leaf-shaped: declare it.

## Skill discovery and assignment

Rundock matches skills to agents in two passes, in this order.

**Pass 1: explicit assignment via the agent's `skills:` array.** The agent's frontmatter declares which skills it owns. Each entry is a skill slug. When `discoverSkills` runs, it walks every agent's `skills:` array and registers explicit ownership for each named slug. This pass takes precedence: an agent matched in Pass 1 is not considered again in Pass 2 for the same skill.

**Pass 2: implicit assignment via body-text scan.** For every agent not matched in Pass 1, Rundock reads the agent's body (everything after the frontmatter, lower-cased) and tests whether the skill's slug appears as a distinct word-boundary token. The match uses a regex with negative lookbehind and lookahead so partial slugs do not match. Mentioning `task-breakdown` in prose attaches the skill; mentioning it as part of a larger token does not.

In the UI, an assigned skill displays a "Used by" row on its profile page listing every agent it is attached to, with each agent's display name, role, icon, and colour. Multiple agents on the same skill is normal: `git-workflow` is owned by Dev but other specialists may reference it.

Unassigned skills are still callable. If `discoverSkills` finds a skill that no agent owns by either pass, it is registered with `status: 'unassigned'`. The orchestrator can still route work to an unassigned skill if its `description` field matches the request strongly enough. The skill simply does not appear under any agent's profile until it is assigned.

Platform skills (slugs prefixed with `rundock-`) are gated to platform agents (currently only Doc). Non-platform agents will not see them in either pass. Non-platform skills are gated to non-platform agents and Doc will not see them. This split keeps Rundock's own management skills out of the user's specialists and keeps user skills out of Doc.

## Workspace mode

Skills inherit the workspace mode of the agent that invokes them. If the workspace is in Knowledge mode, write restrictions on executable file types apply to anything the skill instructs the agent to do. If the workspace is in Code mode, the standard Code-mode tool auto-approvals apply.

There is no per-skill mode override. A skill cannot relax workspace restrictions. If a skill needs to write code in a Knowledge-mode workspace, the user has to switch the workspace to Code mode before running it.

For the full Knowledge vs Code mode table, see [AGENTS.md](AGENTS.md#workspace-modes-knowledge-vs-code).

## Complete example

Here is `skill-discovery`, a skill currently in the workspace. Frontmatter is minimal (the parser-recognised set), the body is structured around six predictable sections (When to use, Inputs, Steps, Output format, Edge cases, Boundaries, Formatting rules), and every step is concrete enough that the agent can follow without asking clarifying questions.

```markdown
---
name: Skill Discovery
description: Scan recent work surfaces for repeated manual patterns and propose new skills or playbooks to build, ranked by leverage.
---

Scan Liam's work surfaces for repeated manual patterns and produce a ranked
list of candidate skills or playbooks to build. The skill is cadence-agnostic:
it accepts a scan window argument and runs on demand.

## When to use

Trigger on requests like "run skill discovery", "scan for skill candidates",
"what should I build next", "find repeated patterns I could automate", or
when invoked by a scheduled routine.

## Inputs

- **Scan window** (optional). Default: last 7 days. Accepts natural language
  ("last 14 days", "since 2026-04-01") or a day count.

## Steps

1. **Read the existing candidates file.** ...
2. **Scan eight surfaces.** ...
   (eight bulleted surfaces with read paths and signals)
3. **Apply detection rules.** ...
4. **Score each candidate.** ...
   (scoring rubric with primary-goal multiplier)
... (steps 5 through 14)

## Output format

(structured template with file header, run section, footer)

## Edge cases

- **No daily note for some days in window:** Skip silently.
- **Granola folder missing or empty:** Skip the Granola surfaces. Note in footer.
... (further specific cases)

## Boundaries

- This skill proposes candidates only. It does NOT create skills, agents,
  playbooks, or any system file.
- It does NOT auto-promote candidates to the backlog.
- It does NOT modify candidate statuses on subsequent runs.

## Formatting rules

UK spelling. No em or en dashes. Use wikilinks `[[...]]` for vault references.
```

Notes on this example:

- The frontmatter holds only `name` and `description`. Anything else would be ignored by Rundock's parser.
- The `description` opens with a verb in present tense and finishes with the trigger phrase. This is the field the orchestrator reads when deciding whether to route work to the agent that owns this skill.
- The body opens with one paragraph that re-states what the skill does in slightly more depth than the description, then jumps straight to "When to use". The agent reading this knows within ten seconds whether the request fits.
- Steps are numbered, imperative, and reference specific file paths. The agent does not have to infer where to read or write.
- Boundaries are explicit. Skill discovery proposes; it does not promote, build, or modify status. This is the discipline that keeps a skill leaf-shaped.
- Formatting rules at the bottom carry house style (UK spelling, no dashes) into every output the skill produces.

## Skills relationship to agents

Agents declare the skills they have via the `skills:` array in their frontmatter, OR Rundock auto-attaches based on body-text scanning. The explicit declaration takes precedence: a skill named in the array is registered to that agent in Pass 1, and the body-text scan does not run for that agent and skill combination. Body-text mentions only attach a skill when the agent did not declare it.

Use explicit assignment when the relationship is permanent and load-bearing (Dev owns `git-workflow`; Penn owns `linkedin-hook-generator`). Let body-text fallback handle weaker references where a skill is occasionally cited in an agent's body but not central to its identity.

For the agent frontmatter reference, including the `skills:` array format, see [AGENTS.md](AGENTS.md).

## Common pitfalls

A handful of specific things that go wrong silently with skill files.

**Frontmatter beyond `name` and `description` is ignored.** Setting `allowed-tools`, `model`, `displayName`, `icon`, or `colour` on a skill file does nothing in Rundock. The fields persist in the file but no Rundock surface reads them. If a skill needs to enforce tool restrictions, do it in the body text and rely on the agent's own permissions.

**Flat skill files are not discovered.** A file at `.claude/skills/my-skill.md` is invisible to Rundock. The discovery loop only walks subdirectories of `.claude/skills/` and `System/Playbooks/`, looking for `SKILL.md` and `PLAYBOOK.md` respectively. The skill must live at `.claude/skills/<slug>/SKILL.md` (or the Playbooks equivalent) to be picked up.

**Same slug in both source locations.** Rundock scans `System/Playbooks/` first, then `.claude/skills/`. If both sources contain a folder with the same slug, both are loaded as separate skill records, with the same id and slug but different `source` and `filePath` fields. The UI will show two skills with identical names. Pick one location and stick to it. The convention going forward is `.claude/skills/`; the Playbooks path exists for legacy Personal-OS-style workspaces.

**Frontmatter typos fail silently.** A misspelled `descripton` or `naem` is silently ignored. The skill loads with empty values for those fields and slugs back to title-cased defaults. If a skill looks generic or untriggerable in the org chart, check the field names against the table above.

**Inline `skills:` arrays on the agent side do not parse.** Rundock's `parseSkills` only matches the block form (`skills:` followed by indented `- slug` lines). The flow-style `skills: [a, b]` parses as an empty array. The skill will not attach explicitly and will fall through to body-text scan, where it may or may not match. Always use the block form on the agent side.

**Slug case sensitivity.** The skill slug is whatever the directory name is. Rundock lowercases slugs before matching (both in the explicit `skills:` array compare and in the body-text regex), so `Hook-Generator` in an agent's `skills:` would match a `hook-generator` directory. But case-mismatched slugs make the codebase harder to read. Keep all slugs lowercase end to end.

**Description is the routing signal.** The orchestrator reads the skill's `description` field, not its body, when deciding whether to route work to an agent that owns this skill. A skill with no description is invisible to routing. Even if the body is rich and the slug is intuitive, leaving `description` empty silently breaks orchestration for that skill.

## Pointers

- [AGENTS.md](AGENTS.md): the agent frontmatter reference, the `skills:` array format, and how agents are matched to skills.
- [ARCHITECTURE.md](ARCHITECTURE.md): where skill discovery sits in the server's startup and how the two source locations interact.
- The skill files in `.claude/skills/`: the canonical reference for what works in practice.
