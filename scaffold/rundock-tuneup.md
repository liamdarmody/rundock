---
name: Instruction Tuneup
description: Audit the team's instructions against current model guidance and propose updates, item by item, with the user approving every change.
---

Keep a team's instructions current with the model generation it runs on. Prompts and skills written for earlier models are often too prescriptive for current ones and can actively degrade output quality; the guidance changes with each model generation, and a workspace with no currency mechanism silently rots on every release. This skill is the currency mechanism.

## When to use

- The user asks to tune up, modernise, or health-check the team's instructions ("tune up my team", "are my agents up to date?").
- After a model-generation change: when the criteria version below is newer than the last tuneup this workspace has seen (look for a previous tuneup report in the workspace, or ask; when unsure, mention it once and move on, never nag).
- Not for structural problems (broken reportsTo, missing frontmatter: that is `rundock-agents` and `rundock-skills` audit territory) and not for behavioural issues like misroutes.

## Scope, stated plainly

- Version 1 audits **Claude agents only**. Say so in the report. Codex agents are listed as "not audited (Codex criteria not yet shipped)".
- Audit the user's agent files (`.claude/agents/`), skills (`.claude/skills/`), and `CLAUDE.md`.
- **Rundock-owned files are the exception:** anything the scaffold manages (the `rundock-*` agent and skills) is reported as "update Rundock to refresh this file", never proposed as a local edit. The next release would overwrite it.

## The flow

1. Read every agent file, every SKILL.md, and CLAUDE.md.
2. Match each file against the criteria catalogue below.
3. Produce findings, one per match: **file, line, the quoted text, verdict, rationale, confidence (high or medium)**.
4. A clean result is a real result. Report "clean against criteria version {version}" and stop; do not invent findings to seem useful.
5. Present findings in chat, grouped by verdict. Ask for approval **per item, or per named group** ("apply all DELETEs", "let's review the REWRITEs one by one"). Never modify anything without that explicit approval.
6. Apply approved changes: agents and skills through the `RUNDOCK:SAVE_AGENT` and `RUNDOCK:SAVE_SKILL` markers (never the Write or Edit tool in `.claude/`), CLAUDE.md with the Write tool.
7. End by naming the criteria version the workspace is now current with.

## Verdicts

- **DELETE:** the passage matches a dated pattern and removing it is safe. Quote exactly what goes.
- **REWRITE:** the intent is worth keeping, the form is dated. Show before and after.
- **FLAG:** looks like a match but context matters, or confidence is medium. Explain what would decide it.
- **When uncertain, the verdict is FLAG, never DELETE.** Overzealous deletion is the failure mode that loses the user's trust in one run.

## Criteria

**Criteria version: 2026-08. Target model generation: Claude Fable 5 (Claude Code runtime).** Updated criteria ship with Rundock releases, the same channel as this skill.

Dated patterns to find:

1. **Forced self-verification.** Instructions demanding the agent re-check, re-verify, or double-check its own output as a mandatory step. Current models over-verify when ordered to; verification belongs in deterministic gates (scripts, linters), not repeated LLM passes. Verdict: REWRITE to a deterministic check where one exists, DELETE otherwise.
2. **Severity filters in review contexts.** Rules like "only report critical issues" in review or audit skills. They suppress genuine findings. Verdict: REWRITE so everything is reported and ranked instead of filtered.
3. **Aggressive triggering language.** ALWAYS/NEVER/MANDATORY stacked as emphasis rather than as a real invariant. Current models follow calm instructions; shouting costs compliance elsewhere. Verdict: REWRITE to plain statements, keep the true invariants.
4. **Reasoning-echo and think-step scaffolds.** "Think step by step", "show your reasoning", "explain your thought process before answering" as blanket rules. Current models reason internally; forced echoes bloat output and can conflict with the runtime's own reasoning handling. Verdict: DELETE, unless the user genuinely wants visible working for that task.
5. **Forced interim summaries.** "Summarise progress after each step" style rules that made older models coherent and make current ones repetitive. Verdict: DELETE.
6. **API and model fossils.** References to retired model names, old API parameters, or capabilities framed as missing that now exist. Verdict: REWRITE to current names or DELETE.
7. **Don't-overthink rules.** "Keep it simple, don't overanalyse" instructions added to curb older models' rambling; on current models they suppress legitimate depth. Verdict: FLAG (sometimes the user really does want brevity).
8. **Anti-laziness padding.** "Do not be lazy", "write the full code, no placeholders", "do not truncate". Current models do not need the goad, and the padding dilutes real instructions. Verdict: DELETE.

**The keep-list. Never propose removing:**

- Context about the business, the user, or the domain (that is the workspace's value)
- Rubrics and quality bars that define what good looks like
- Exact steps for fragile operations (deployment sequences, data-safety rules, marker formats)
- Truth and grounding rules ("never fabricate", "cite the file")
- Human gates ("ask before sending", "propose then approve")
- Loop bounds and budgets ("at most three attempts")

These look like candidates to an over-eager audit and are load-bearing. When a passage mixes a dated pattern with keep-list material, the verdict is REWRITE preserving the keep-list half, or FLAG.

## Report format

```
Tuneup report: criteria 2026-08 (Claude Fable 5)
Scope: 6 Claude agents, 14 skills, CLAUDE.md. 2 Codex agents not audited (Codex criteria not yet shipped).

DELETE (3)
1. content-lead.md:41 "Think step by step before every reply." Reasoning-echo scaffold; current models reason internally. Confidence: high.
...

REWRITE (1)
...

FLAG (2)
...

Clean files: 11 of 21.
Apply all DELETEs, review REWRITEs one by one, or pick items by number.
```
