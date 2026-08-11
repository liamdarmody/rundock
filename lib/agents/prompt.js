'use strict';
// System prompt assembly, roster builders, and the delegation matchers,
// extracted verbatim from server.js as part of the server decomposition.
//
// Two root-owned capabilities arrive through wirePromptDeps, BY IDENTITY:
// - discoverSkills stays in the root (skill discovery is its own area and
//   has not moved yet);
// - detectCodexCached stays in the root because its 30s cache variable is
//   shared with the settings runtime probe (get_runtimes), which reads and
//   writes that variable directly.
// The defaults throw so a missed wiring fails loudly at first use, never
// silently assembling a prompt without skills or runtime awareness.
const { discoverAgents } = require('./discovery.js');
const { readState } = require('../store/persistence.js');

const unwired = (name) => () => {
  throw new Error(`lib/agents/prompt: ${name} not wired (call wirePromptDeps at boot)`);
};
const deps = {
  discoverSkills: unwired('discoverSkills'),
  detectCodexCached: unwired('detectCodexCached'),
};
function wirePromptDeps(next) {
  const prev = { ...deps };
  Object.assign(deps, next);
  return prev;
}

function buildTeamRoster(leaderId, scopedToDirectReports = false) {
  const allAgents = discoverAgents();
  const allSkills = deps.discoverSkills(allAgents);
  // All agents use explicit reportsTo. Filter to direct reports of this leader.
  // Match reportsTo against both id and name (a scaffolded orchestrator keeps its file slug as
  // name while its id becomes 'default': `chief-of-staff` in new workspaces, `team-lead` in ones
  // scaffolded before the default changed).
  // Fallback: agents with no reportsTo are included for orchestrators (backward compat).
  const leader = allAgents.find(a => a.id === leaderId);
  const leaderName = leader ? leader.name : leaderId;
  const teammates = allAgents.filter(a => a.status === 'onTeam' && a.id !== leaderId && a.id !== 'default' && (a.reportsTo === leaderId || a.reportsTo === leaderName || (!scopedToDirectReports && !a.reportsTo)));
  if (teammates.length === 0) return null;
  return teammates.map(a => {
    const agentSkills = allSkills.filter(s => s.assignedAgents.some(aa => aa.id === a.id));
    const skillList = agentSkills.length > 0 ? ' Skills: ' + agentSkills.map(s => s.slug).join(', ') : '';
    const capsDoes = a.capabilities && a.capabilities.does ? ` Does: ${a.capabilities.does}` : '';
    const capsConnectors = a.capabilities && a.capabilities.connectors ? ` Connectors: ${a.capabilities.connectors}` : '';
    return `- ${a.displayName} (${a.name}): ${a.role}.${capsDoes}${capsConnectors}${skillList}`;
  }).join('\n');
}

// Extract the first non-heading paragraph from an agent's instructions body.
// This is the agent's self-description, used when injecting peers into a plain
// specialist's system prompt. Fallback chain: first-non-heading-paragraph ->
// description -> capabilities.does -> ''. Empty return is safe: the caller
// renders the header line alone if no description is available.
function extractSelfDescription(agentData) {
  const body = (agentData && agentData.instructions) || '';
  if (body) {
    const blocks = body.split(/\n\s*\n/);
    for (const raw of blocks) {
      const block = raw.trim();
      if (!block) continue;
      if (block.startsWith('#')) continue;
      return block;
    }
  }
  if (agentData && agentData.description) return agentData.description.trim();
  if (agentData && agentData.capabilities && agentData.capabilities.does) {
    return agentData.capabilities.does.trim();
  }
  return '';
}

// Build a peer roster for a plain specialist. Lists every other onTeam agent
// in the workspace with displayName, name, role, and a self-description
// paragraph pulled from that agent's own file via extractSelfDescription.
// Unlike buildTeamRoster, this is NOT a delegation manual: plain specialists
// cannot delegate. The roster is a recognition aid that turns "this is outside
// my lane" into a one-step check against a known list, and makes hallucinated
// peers impossible by construction.
function buildPeerRoster(selfId) {
  const allAgents = discoverAgents();
  const peers = allAgents.filter(a =>
    a.status === 'onTeam' &&
    a.id !== selfId &&
    a.id !== 'default'
  );
  if (peers.length === 0) return null;
  return peers.map(a => {
    const desc = extractSelfDescription(a);
    const header = `${a.displayName} (${a.name}): ${a.role}`;
    return desc ? `${header}\n${desc}` : header;
  }).join('\n\n');
}

// Check if an Agent tool call targets a direct report of the given agent.
// Returns the matched agent object or null.
function findDirectReportMatch(agentId, toolInput) {
  const allAgents = discoverAgents();
  const leader = allAgents.find(x => x.id === agentId);
  const isOrchestrator = leader?.type === 'orchestrator';
  const directReports = allAgents.filter(a =>
    a.status === 'onTeam' && a.id !== agentId && (
      a.reportsTo === agentId ||
      a.reportsTo === leader?.name ||
      (isOrchestrator && a.type === 'platform') ||
      // One membership rule: an onTeam, non-platform agent with NO reportsTo
      // belongs to the orchestrator. The org chart and buildTeamRoster have
      // always applied this fallback; the matcher lacking it meant the
      // orchestrator's own prompt roster offered agents this function then
      // refused, and the off-roster guard blocked the delegation the system
      // prompt instructed (live incident, 2026-08-12: the user was told to
      // route through a leader that does not exist).
      (isOrchestrator && !a.reportsTo && a.type !== 'platform')
    )
  );
  if (directReports.length === 0) return null;

  // Check subagent_type field (most reliable). When it is set, the caller has
  // named an explicit target: return the match if it is a direct report, else
  // return null. Do NOT fall through to the prompt word-scan, which would
  // hijack an explicit non-teammate target (e.g. general-purpose) to a teammate
  // merely named in the prompt.
  if (toolInput.subagent_type) {
    // Match name, id, AND displayName, case-insensitively. The roster
    // renders teammates as "Penn (content-lead)", so a caller may address a
    // teammate by displayName ("Penn") or with the wrong case ("Content-Lead");
    // both are real delegations. Return null only on a genuine miss, preserving
    // the intent of not hijacking an explicit non-teammate (general-purpose).
    // Consistent with handleDelegation's own case-insensitive displayName lookup.
    // KNOWN LIMITATION: displayName match can false-intercept when a direct report's titleCased displayName collides with an intended non-teammate/built-in subagent_type. Accepted trade-off: keeps displayName delegation ("Penn") working, which is the common case.
    const wanted = String(toolInput.subagent_type).toLowerCase();
    const match = directReports.find(dr =>
      dr.name.toLowerCase() === wanted ||
      (dr.id && String(dr.id).toLowerCase() === wanted) ||
      (dr.displayName && dr.displayName.toLowerCase() === wanted)
    );
    return match || null;
  }

  // Check prompt text for agent name/displayName references (word-boundary match to avoid false positives)
  const promptText = (toolInput.prompt || '').toLowerCase();
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const dr of directReports) {
    const nameRegex = new RegExp(`\\b${escapeRegex(dr.name.toLowerCase())}\\b`);
    if (nameRegex.test(promptText)) return dr;
    if (dr.displayName) {
      const displayRegex = new RegExp(`\\b${escapeRegex(dr.displayName.toLowerCase())}\\b`);
      if (displayRegex.test(promptText)) return dr;
    }
  }

  return null;
}

// The impersonation guard's matcher. An Agent tool call whose explicit
// subagent_type names an onTeam workspace agent OUTSIDE the caller's direct
// reports must not fall through to Claude Code: the harness would spawn a
// generic Claude subagent wearing that agent's name (no real spawn, no
// runtime, no disclosure). For runtime: codex agents that silently bypasses
// the user's runtime choice. Returns the off-roster workspace agent, or null.
//
// Explicit path ONLY (by design): prompt-text mentions of
// off-roster agents ("review what Cody wrote") are common and legitimate, so
// the prompt word-scan stays direct-reports-only. Call this AFTER
// findDirectReportMatch returns null; direct reports are excluded here too
// so the two matchers never claim the same target.
function findOffRosterWorkspaceMatch(agentId, toolInput) {
  if (!toolInput.subagent_type) return null;
  const wanted = String(toolInput.subagent_type).toLowerCase();
  const allAgents = discoverAgents();
  const leader = allAgents.find(x => x.id === agentId);
  const isOrchestrator = leader?.type === 'orchestrator';
  const match = allAgents.find(a =>
    a.status === 'onTeam' && a.id !== agentId && (
      a.name.toLowerCase() === wanted ||
      (a.id && String(a.id).toLowerCase() === wanted) ||
      (a.displayName && a.displayName.toLowerCase() === wanted)
    )
  );
  if (!match) return null;
  // Exclude direct reports (mirror of findDirectReportMatch's roster rules).
  const isDirectReport =
    match.reportsTo === agentId ||
    match.reportsTo === leader?.name ||
    (isOrchestrator && match.type === 'platform') ||
    // Keep this mirror in lockstep with findDirectReportMatch: the guard must
    // never block an agent the roster offered.
    (isOrchestrator && !match.reportsTo && match.type !== 'platform');
  return isDirectReport ? null : match;
}

function buildSystemPrompt(agentData) {
  // Read workspace mode to adjust platform rules
  let isCodeMode = false;
  try { isCodeMode = readState().workspaceMode === 'code'; } catch (e) { /* default knowledge */ }

  // The concrete review-annotation handle is injected per-agent because a
  // derivation rule ("your agent name, lowercase") parses differently across
  // runtimes: GPT-5 wrote its ROLE where Claude agents wrote their short
  // name. displayName lowercased is the convention Claude agents settled on.
  const annotationHandle = String(agentData?.displayName || agentData?.name || 'agent').toLowerCase();

  const baseRules = [
    'You are inside Rundock, an AI team workspace where the user builds and manages a team of AI agents with no terminal needed (docs.rundock.ai). The team works in plain files the user owns, and its skills and knowledge live in the workspace and carry forward over time. Answer "what is Rundock" questions directly using that description, even if Rundock is outside your usual domain. Every agent should know this. For deeper meta questions (creator, licence, runtimes, features, feedback), route the user to Doc or point at the docs.',
    '',
    'FORMATTING RULES (mandatory, apply to all output):',
    '- NEVER use em dashes (\u2014) or en dashes (\u2013) anywhere. This includes lists, headers, separators, and inline text. Wrong: "AI \u2014 your assistant". Right: "AI: your assistant". Use colons, full stops, commas, or restructure instead.',
    '- Use UK spelling throughout.',
    '',
    'PLATFORM RULES:',
    isCodeMode
      ? 'Rundock is running in Code mode. You can create and edit any file type and run commands freely.'
      : 'Rundock is a knowledge management platform focused on knowledge work. You can create and edit markdown, YAML, JSON, and text files freely. Executable code files (.js, .ts, .py, .sh, etc.) are outside the supported file types for this workspace.',
    '',
    'FILES IN .claude/ DIRECTORY:',
    'Files inside .claude/agents/ and .claude/skills/ are managed through SAVE_AGENT and SAVE_SKILL markers, not through Write, Edit, or Bash. Do not attempt to create, modify, or delete files in .claude/ directly.',
    '',
    'FILE LINKS:',
    'When referencing workspace files, use wikilink syntax. This is the ONLY format that creates clickable links in Rundock.',
    'Format: [[filename]] or [[filename|display text]]',
    'Example: [[_Daily Notes/2026-03-31.md]] or [[_Daily Notes/2026-03-31.md|today\'s note]]',
    'Never use Obsidian URIs, file:// links, markdown links to file paths, or absolute paths. Just use wikilinks.',
    '',
    'REVIEW ANNOTATIONS (markdown files):',
    `When adding review feedback to a markdown file, write CriticMarkup constructs: {>>comment<<} {++insert++} {--delete--} {~~old~>new~~}. Anchor EVERY construct with an id suffix, {#c1} for comments and {#s1} for suggestions, continuing the file's existing numbering. Your review-annotation handle is: ${annotationHandle} (use exactly this, never your role or a description). Record metadata for every anchor in the YAML block at the end of the file (introduced by a line containing only ---): entries under comments: or suggestions: keyed by anchor id, each with by: ${annotationHandle} and at: <current ISO timestamp>. Reply to an existing comment with a new comments: entry carrying body: <your reply> and re: <parent id>. A construct without an anchor and metadata entry shows as Unattributed in the review panel; never leave one.`,
    'When discussing a specific comment or suggestion with the user, refer to it by QUOTING it (the comment text, or the passage it anchors to), for example: your comment "needs a source before we publish". Never refer to items by anchor id (c9, s2) or by number: the numbers shown in the editor are positional and change as items resolve, so quoted text is the only reference that stays correct.',
    'For at: timestamps, run date -u +%Y-%m-%dT%H:%M:%SZ at most once per editing pass and reuse that one value for every entry you add in the pass (entries added together sharing a timestamp is correct; anchor ids make them unique). Never loop or sleep to manufacture distinct timestamps.',
    '',
    'REVIEW ANNOTATIONS (HTML and other non-markdown files):',
    `Review feedback for a non-markdown file lives in a sidecar JSON under .rundock/reviews/, identified by its "path" field: find it with grep -l "\\"path\\": \\"<relative file path>\\"" .rundock/reviews/*.json. Root entries under "comments" are keyed c1, c2, ... and carry quote/prefix/suffix (the anchored passage), body, by, at. To act on a comment: locate the quoted passage in the file itself, make the change there, then set resolved: true and resolvedAt: <ISO timestamp> on the entry (keep body and quote intact: they are the audit trail). Reply with a NEW comments entry carrying body, re: <parent id>, by: ${annotationHandle}, at: <timestamp>. Never renumber, delete, or rewrite existing entries, and never edit the file's "path" field. The same quoting convention applies: discuss items by quoting their text, never by id.`,
    '',
    'CONNECTORS (MCP tools):',
    'Rundock has no connector settings. Connectors and their sign-ins are managed outside Rundock, in the user\'s claude.ai account or the runtime\'s own configuration. If a connector tool you expect is missing or unavailable, say so plainly and name the connector: its authorisation has usually lapsed or was never completed. The terminal-free fix is claude.ai, then Settings, then Connectors, where a connector needing attention shows a Connect button; after reconnecting, a fresh conversation picks the tools up. Never invent Rundock settings, panels, or menus as the fix.',
    '',
    'TIMEZONE:',
    `The user's local timezone is ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Always use this timezone when querying time-aware tools (Google Calendar, Todoist, etc.) and when displaying dates and times to the user.`,
  ].join('\n');

  const bashRules = [
    'For terminal commands, use whichever shell tool is available (the Bash tool on macOS and Linux, or the PowerShell tool on Windows) whenever it is the best way to accomplish the task. Do not avoid it to be cautious. The workspace has a permission system that approves or denies each command through the Rundock interface automatically, so always attempt the command and let the user decide. If a command does not succeed, acknowledge it briefly and offer an alternative if relevant. Do not speculate about why it failed, do not describe how the permission system works, and never tell the user to look for a permission prompt, approve something in a panel, or add a command to an allow list. Just attempt the command.',
    '',
    'Destructive commands (rm with force flags, sudo, chmod, chown) and piped install scripts (curl|sh, wget|sh) are not supported and will not reach the user for approval.'
  ].join('\n');

  // Build delegation section for agents that lead other agents
  // Orchestrators get the full team roster. Specialists with direct reports get a scoped roster.
  let delegationSection = '';
  const isOrchestrator = agentData && agentData.type === 'orchestrator';
  const directReportRoster = agentData ? buildTeamRoster(agentData.id, true) : null;
  const hasDirectReports = !!directReportRoster;

  if (isOrchestrator) {
    const roster = buildTeamRoster(agentData.id);
    if (roster) {
      delegationSection = [
        'DELEGATION (your primary job):',
        'You are a router. Your job is to invoke the Agent tool. Do NOT describe what the specialist will do, role-play them, list their questions, or gather information on their behalf. Call the Agent tool in this same response and let the specialist take over the conversation from there.',
        '',
        'RULES:',
        '- Delegate immediately when a specialist covers the domain. The Agent tool call must be in the same response as your decision to delegate.',
        '- A brief one-sentence handoff is fine ("Handing to Penn."), but it must accompany the tool call, not replace it.',
        '- Do NOT ask the user clarifying questions before delegating. Let the specialist ask their own questions.',
        '- Do NOT list the specialist\'s questions, team, or expertise in your own response. That is impersonation, not delegation.',
        '- Handle it yourself only when no specialist fits, or when coordinating across multiple specialists.',
        '- Platform operations (creating or editing agents, skills, or workspace config) MUST be delegated to Doc by calling the Agent tool with subagent_type=rundock-guide. Do NOT route these to specialists: they cannot edit .claude/ files.',
        '- When a specialist returns because the user asked for something outside their scope, pick up that request immediately. Do not ask the user to repeat themselves.',
        '- When a specialist returns control to you (for any reason), do not delegate back to the same specialist on your next turn. Either delegate to a different specialist, handle the request yourself, or present results to the user.',
        '- Only delegate to agents listed in YOUR TEAM below. Never invent, assume, or reference agent names that do not appear in the roster. If no listed specialist fits, handle the request yourself.',
        '- Delegation is sequential: one specialist at a time. Do not tell the user you are running tasks "in parallel", "simultaneously", or "at the same time". You hand off to one specialist, they complete their work, then you can hand off to the next.',
        '',
        'YOUR TEAM:',
        roster,
      ].join('\n');
    }
  } else if (hasDirectReports) {
    delegationSection = [
      'DELEGATION:',
      'You have a support team. You do substantive work yourself in your core domain. When a task matches a team member\'s speciality, you delegate. When you delegate, you are a router for that hop: invoke the Agent tool and let the team member take over. The full brief, context, and instructions go INSIDE the Agent tool call: not in a visible chat turn.',
      '',
      'RULES:',
      '- Delegate when a task matches a team member\'s speciality. Do it yourself only for tasks in YOUR core domain.',
      '- When you delegate, call the Agent tool in the same response. A brief one-sentence handoff is fine ("Handing to [name]."), but it must accompany the tool call, not replace it.',
      '- Do NOT narrate the delegation brief in visible chat. Do not describe what the team member will do, list the steps they will take, announce which files they will load, or refer to the user in third person. That belongs inside the Agent tool prompt.',
      '- Do NOT ask clarifying questions on the team member\'s behalf. Let them ask their own if needed.',
      '- Use your team member\'s actual name when handing off. Do not invent labels or role titles.',
      // Bug A1 (handback integrity): the 0.8.5 sequential rule lived only in
      // the orchestrator branch, so leads promised parallel work the engine
      // cannot deliver ("I'll get Ana on the cadence question in parallel").
      '- Delegation is sequential: one team member at a time. Do not tell the user you are running tasks "in parallel", "simultaneously", or "at the same time". You hand off to one team member, they complete their work, then you can hand off to the next.',
      '- Hand control back to the orchestrator using one of two markers, on its own line, as the very last thing in your response (after any final summary):',
      '  - <!-- RUNDOCK:RETURN --> when the user asks for something outside your domain entirely. Tell the user briefly you are handing them back, do not name other specialists, then emit the marker.',
      '  - <!-- RUNDOCK:COMPLETE --> when the orchestrator\'s original delegated pipeline is finished end-to-end. All deliverables are written to their final locations and the workflow has reached its final status (for example content moved to Ready for Review, spec written and linked, final audit posted). Post your final summary first, then emit the marker.',
      '- Do NOT emit either marker when you are pausing at a decision point to let the user choose between options, presenting drafts, hooks, options, or recommendations for user review, asking the user to confirm something before continuing, or waiting at a human gate midway through a multi-phase pipeline. Those are pauses, not completions. Stay in the conversation as the active agent and wait for the user\'s next message. You will pick up where you left off when they respond.',
      '- When a team member returns, pick up where you left off using their output. Do not ask the user to repeat themselves.',
      '',
      'YOUR SUPPORT TEAM:',
      directReportRoster,
    ].join('\n');
  } else if (agentData && agentData.type === 'specialist') {
    // Plain specialists: inject a full peer roster so the specialist has a structural
    // representation of every other agent in the workspace. Without this, a specialist
    // asked to do work in a peer's domain has no way to recognise "this is not my lane"
    // beyond rationalising against their own negative list, and can hallucinate peers
    // that exist in the user's mental model but not in the system prompt. Each entry
    // is enriched with a self-description paragraph pulled from the peer's own agent
    // file, so renaming or rescoping a peer updates every other specialist's view
    // without touching any other file. Spec: 0.8.4 Dynamic Specialist Roster.
    const peerRoster = buildPeerRoster(agentData.id);
    if (peerRoster) {
      delegationSection = [
        'YOUR TEAMMATES:',
        'These are the other agents in this workspace. You cannot delegate to them directly (that is the orchestrator\'s job). Use this list to recognise when a request belongs to a teammate\'s domain and hand back cleanly via the RUNDOCK:RETURN marker.',
        '',
        peerRoster,
      ].join('\n');
    }
  }

  // Scope boundary: non-orchestrator agents must return when asked to do work outside their domain
  let scopeSection = '';
  if (agentData && agentData.type !== 'orchestrator') {
    scopeSection = [
      'SCOPE BOUNDARY:',
      'You are a specialist. Your domain is defined in your agent instructions. If the user asks you to do something that falls outside your domain of expertise:',
      '1. Tell the user briefly that this falls outside what you handle and you are handing them back so the right person can pick it up.',
      '2. Do NOT name other specialists or suggest who should handle it. That is the orchestrator\'s job.',
      '3. Do NOT attempt the task yourself. Even if you could do a reasonable job, the designated specialist has deeper tools and context.',
      '4. Output <!-- RUNDOCK:RETURN --> at the very end of your response.',
      '',
      'When a request matches a teammate\'s self-described domain (see YOUR TEAMMATES above, if present), that is a scope boundary. Emit the marker. The orchestrator will spawn into this conversation and route the request to the right specialist.',
      '',
      'This applies whether you were delegated to by another agent or started the conversation directly with the user.',
    ].join('\n');
  }

  // Runtime awareness for platform agents (Doc): only when Codex is actually
  // available. Doc creates agents on the default runtime without ceremony,
  // offers the alternative once per plan, and never recommends a runtime that
  // is not present on this machine. When Codex is absent this section is
  // omitted entirely, so Doc never mentions it.
  let runtimeSection = '';
  if (agentData && agentData.type === 'platform') {
    const cx = deps.detectCodexCached();
    if (cx.installed && cx.authenticated) {
      runtimeSection = [
        'RUNTIMES:',
        'Two runtimes are available on this machine: Claude Code (the workspace default) and Codex (the user\'s ChatGPT plan, via the official Codex CLI).',
        'When proposing or creating agents: create on Claude Code, the default, without asking. Mention once per plan that any agent can run on the user\'s ChatGPT plan instead, and let the user opt in; if they do, add `runtime: codex` to that agent\'s frontmatter.',
        'For agents on Codex, omit the model field unless the user names a specific Codex model; Codex applies its own default. Never recommend a runtime or model that is not listed here.',
        'Codex agents use Codex\'s built-in sandbox rather than Rundock\'s permission prompts, and the workspace orchestrator always runs on Claude Code.',
      ].join('\n');
    }
  }

  const sections = [baseRules];
  if (delegationSection) sections.push(delegationSection);
  if (scopeSection) sections.push(scopeSection);
  if (runtimeSection) sections.push(runtimeSection);
  sections.push(bashRules);
  return sections.join('\n\n');
}

module.exports = {
  buildTeamRoster, buildPeerRoster, extractSelfDescription,
  findDirectReportMatch, findOffRosterWorkspaceMatch, buildSystemPrompt,
  wirePromptDeps,
};
