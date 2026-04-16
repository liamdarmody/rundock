/**
 * Rundock Server
 *
 * 1. Discovers agents from .claude/agents/ (including default from CLAUDE.md)
 * 2. Parses capabilities and routines from agent frontmatter
 * 3. Bridges browser <-> Claude Code via WebSocket + stream-json
 * 4. Runs a lightweight scheduler for routines
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const readline = require('readline');
const PKG_VERSION = require('./package.json').version;

const PORT = process.env.PORT || 3000;
let ACTUAL_PORT = PORT; // Updated after server.listen() with the real listening port
let WORKSPACE = process.env.WORKSPACE || null;

// Shared constants to avoid repetition across process spawn sites
const DISALLOWED_TOOLS_KNOWLEDGE = 'Write(*.js),Write(*.jsx),Write(*.ts),Write(*.tsx),Write(*.py),Write(*.sh),Write(*.bash),Write(*.rb),Write(*.pl),Write(*.exe),Write(*.dll),Write(*.so),Edit(*.js),Edit(*.jsx),Edit(*.ts),Edit(*.tsx),Edit(*.py),Edit(*.sh),Edit(*.bash),Edit(*.rb),Edit(*.pl),Edit(*.exe)';
// Backward compat: DISALLOWED_TOOLS used by existing code paths
const DISALLOWED_TOOLS = DISALLOWED_TOOLS_KNOWLEDGE;
const ALLOWED_TOOLS_INTERACTIVE = 'Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,ToolSearch,Agent,Skill,mcp__*';
const ALLOWED_TOOLS_LEGACY = 'Bash,WebFetch,WebSearch,mcp__*';

// Returns the disallowed-tools string based on workspace mode.
// Code mode: no file type restrictions (empty string).
// Knowledge mode: block executable file writes.
function getDisallowedTools() {
  try {
    const state = readState();
    if (state.workspaceMode === 'code') return '';
  } catch (e) { /* default to knowledge mode restrictions */ }
  return DISALLOWED_TOOLS_KNOWLEDGE;
}

// Returns the permission mode. Always acceptEdits; code mode auto-approval
// is handled by the permission hook via RUNDOCK_CODE_MODE env var.
function getPermissionMode() {
  return 'acceptEdits';
}

// Returns startup args that configure workspace context without using --bare.
// Previously used --bare for faster startup, but --bare skips keychain/OAuth reads
// which causes "Not logged in" errors for users who authenticate via `claude login`.
// We now pass context flags explicitly without --bare so auth works normally.
function getBareArgs() {
  if (!WORKSPACE) return [];
  const args = [];
  // Ensure CLAUDE.md discovery for the workspace
  args.push('--add-dir', WORKSPACE);
  // Load hooks (permission system) from settings.local.json
  const settingsPath = path.join(WORKSPACE, '.claude', 'settings.local.json');
  if (fs.existsSync(settingsPath)) {
    args.push('--settings', settingsPath);
  }
  // Load MCP server access from .mcp.json
  const mcpPath = path.join(WORKSPACE, '.mcp.json');
  if (fs.existsSync(mcpPath)) {
    args.push('--mcp-config', mcpPath);
  }
  return args;
}

// Returns spawn env with workspace mode flag for the permission hook.
function getSpawnEnv(convoId) {
  const env = { ...process.env, TERM: 'dumb', RUNDOCK: '1', RUNDOCK_PORT: String(ACTUAL_PORT) };
  if (convoId) env.RUNDOCK_CONVO_ID = convoId;
  try {
    const state = readState();
    if (state.workspaceMode === 'code') env.RUNDOCK_CODE_MODE = '1';
  } catch (e) { /* default knowledge mode */ }
  return env;
}

// Pending permission requests from PreToolUse hooks (keyed by requestId).
// Each entry holds the HTTP response object so we can resolve it when the user decides.
const pendingPermissionRequests = new Map();

// Recent workspaces (persisted to disk)
// In Electron, __dirname is inside the read-only asar. Use home directory instead.
const RECENT_FILE = process.env.RUNDOCK_ELECTRON
  ? path.join(require('os').homedir(), '.rundock-recent-workspaces.json')
  : path.join(__dirname, '.recent-workspaces.json');
function loadRecentWorkspaces() {
  let recent;
  try { recent = JSON.parse(fs.readFileSync(RECENT_FILE, 'utf-8')); } catch (e) { return []; }
  const valid = recent.filter(r => r.path && fs.existsSync(r.path));
  if (valid.length < recent.length) {
    try { fs.writeFileSync(RECENT_FILE, JSON.stringify(valid, null, 2)); } catch (e) {}
  }
  return valid;
}
function saveRecentWorkspace(dir) {
  const recent = loadRecentWorkspaces().filter(r => r.path !== dir);
  recent.unshift({ path: dir, name: path.basename(dir), lastOpened: new Date().toISOString() });
  fs.writeFileSync(RECENT_FILE, JSON.stringify(recent.slice(0, 10), null, 2));
}

// Rundock session persistence (.rundock/ in workspace root)
function rundockDir() { return path.join(WORKSPACE, '.rundock'); }

function readConversations() {
  try {
    const file = path.join(rundockDir(), 'conversations.json');
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) { return []; }
}

function writeConversations(list) {
  const dir = rundockDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'conversations.json'), JSON.stringify(list, null, 2));
}

function readState() {
  try {
    const file = path.join(rundockDir(), 'state.json');
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) { return {}; }
}

function writeState(state) {
  const dir = rundockDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
}

// Search helper: extract a snippet around the query match
function extractSnippet(text, query, contextChars = 60) {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query);
  if (idx === -1) return text.substring(0, contextChars * 2);
  const start = Math.max(0, idx - contextChars);
  const end = Math.min(text.length, idx + query.length + contextChars);
  let snippet = text.substring(start, end).replace(/\n/g, ' ');
  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet += '...';
  return snippet;
}

// Session history: read Claude Code JSONL transcripts from disk
function getSessionJsonlPath(sessionId) {
  if (!WORKSPACE || !sessionId) return null;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const projectHash = WORKSPACE.replace(/\//g, '-');
  const jsonlPath = path.join(home, '.claude', 'projects', projectHash, sessionId + '.jsonl');
  if (fs.existsSync(jsonlPath)) return jsonlPath;
  // Fallback: scan project dirs for the session file
  const projectsDir = path.join(home, '.claude', 'projects');
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      const candidate = path.join(projectsDir, dir, sessionId + '.jsonl');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch (e) { /* projects dir doesn't exist */ }
  return null;
}

async function parseSessionHistory(sessionId, limit = 20, offset = 0) {
  const filePath = getSessionJsonlPath(sessionId);
  if (!filePath) return { messages: [], totalCount: 0, hasMore: false };

  const displayable = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    try {
      const obj = JSON.parse(line);
      // User text messages (not tool results)
      if (obj.type === 'user' && obj.message && typeof obj.message.content === 'string') {
        displayable.push({ role: 'user', content: obj.message.content });
        continue;
      }
      // Assistant messages with text content
      if (obj.message && obj.message.role === 'assistant' && Array.isArray(obj.message.content)) {
        const textParts = obj.message.content
          .filter(b => b.type === 'text' && b.text)
          .map(b => b.text);
        if (textParts.length > 0) {
          displayable.push({ role: 'assistant', content: textParts.join('\n\n') });
        }
      }
    } catch (e) { /* skip unparseable lines */ }
  }

  const totalCount = displayable.length;
  // Return the last `limit` messages, offset from the end
  const start = Math.max(0, totalCount - limit - offset);
  const end = Math.max(0, totalCount - offset);
  const messages = displayable.slice(start, end);
  const hasMore = start > 0;

  return { messages, totalCount, hasMore };
}

// Scan common locations for workspaces (directories with .claude/ or CLAUDE.md)
function discoverWorkspaces() {
  const candidates = [];
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const searchDirs = new Set([
    path.join(home, 'Documents'),
    path.join(home, 'Projects'),
    path.join(home, 'Desktop'),
    home
  ]);

  // Also scan subdirectories of Documents
  try {
    const docsDir = path.join(home, 'Documents');
    if (fs.existsSync(docsDir)) {
      for (const sub of fs.readdirSync(docsDir, { withFileTypes: true })) {
        if (sub.isDirectory() && !sub.name.startsWith('.')) {
          searchDirs.add(path.join(docsDir, sub.name));
        }
      }
    }
  } catch (e) {}

  for (const searchDir of [...searchDirs]) {
    try {
      if (!fs.existsSync(searchDir)) continue;
      const items = fs.readdirSync(searchDir, { withFileTypes: true });
      for (const item of items) {
        if (!item.isDirectory() || item.name.startsWith('.') || item.name === 'node_modules') continue;
        const fullPath = path.join(searchDir, item.name);
        const hasClaude = fs.existsSync(path.join(fullPath, '.claude')) || fs.existsSync(path.join(fullPath, 'CLAUDE.md'));
        if (hasClaude) {
          // Check if it has Rundock-ready agents
          const agentsDir = path.join(fullPath, '.claude', 'agents');
          let agentCount = 0;
          let hasRundockFrontmatter = false;
          try {
            const agentFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
            agentCount = agentFiles.length;
            for (const af of agentFiles) {
              const content = fs.readFileSync(path.join(agentsDir, af), 'utf-8');
              if (content.includes('type:') && content.includes('order:')) { hasRundockFrontmatter = true; break; }
            }
          } catch (e) {}
          candidates.push({ path: fullPath, name: item.name, agentCount, hasRundockFrontmatter });
        }
      }
    } catch (e) {}
  }
  return candidates;
}

// ===== ROUTINE STATE (in-memory) =====

const routineState = {}; // { routineKey: { lastRun, status, duration } }

// ===== AGENT HELPERS =====

function validateAgentSlug(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(name) && name.length <= 60 && !name.includes('..');
}

// ===== SYSTEM PROMPT BUILDER =====

// Flag all active orchestrator processes for roster refresh on next message.
// Called after agent/skill CRUD so the orchestrator respawns with an updated team roster.
// Uses chatProcesses (global Map declared later) via late binding.
function flagRosterRefresh() {
  if (typeof chatProcesses === 'undefined') return;
  const agentList = discoverAgents();
  for (const [convoId, entry] of chatProcesses) {
    if (entry.exited) continue;
    // Flag active delegate entries so server-side auto-return knows CRUD happened
    if (entry.delegation) {
      entry.crudHappened = true;
      // Flag the parked orchestrator for roster refresh on resume
      const orchEntry = entry.delegation.originalEntry;
      if (orchEntry) orchEntry.needsRosterRefresh = true;
      console.log(`[Roster] Flagged convo=${convoId} for roster refresh (delegate active)`);
    } else {
      // Non-delegate: check if this is an orchestrator that needs flagging
      const agentData = agentList.find(a => a.id === entry.agentId);
      if (agentData && agentData.type === 'orchestrator') {
        entry.needsRosterRefresh = true;
        console.log(`[Roster] Flagged convo=${convoId} for roster refresh`);
      }
    }
  }
}

function buildTeamRoster(leaderId, scopedToDirectReports = false) {
  const allAgents = discoverAgents();
  const allSkills = discoverSkills(allAgents);
  // All agents use explicit reportsTo. Filter to direct reports of this leader.
  // Match reportsTo against both id and name (the default agent has id='default' but name='team-lead').
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
// description -> capabilities.does -> ''. Empty return is safe — the caller
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
      (isOrchestrator && a.type === 'platform')
    )
  );
  if (directReports.length === 0) return null;

  // Check subagent_type field (most reliable)
  if (toolInput.subagent_type) {
    const match = directReports.find(dr =>
      dr.name === toolInput.subagent_type || dr.id === toolInput.subagent_type
    );
    if (match) return match;
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

function buildSystemPrompt(agentData) {
  // Read workspace mode to adjust platform rules
  let isCodeMode = false;
  try { isCodeMode = readState().workspaceMode === 'code'; } catch (e) { /* default knowledge */ }

  const baseRules = [
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
    'TIMEZONE:',
    `The user's local timezone is ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Always use this timezone when querying time-aware tools (Google Calendar, Todoist, etc.) and when displaying dates and times to the user.`,
  ].join('\n');

  const bashRules = [
    'For terminal commands (Bash), use them whenever they are the best way to accomplish the task. Do not avoid Bash to be cautious. The workspace has a permission system that lets the user approve or deny each command, so always attempt the command and let the user decide. If a command does not succeed, acknowledge it and offer an alternative if relevant. Do not speculate about why it did not succeed or describe general platform rules based on a single outcome.',
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
        '- Platform operations (creating or editing agents, skills, or workspace config) MUST be delegated to Doc by calling the Agent tool with subagent_type=rundock-guide. Do NOT route these to specialists — they cannot edit .claude/ files.',
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
      'You have a support team. You do substantive work yourself in your core domain. When a task matches a team member\'s speciality, you delegate. When you delegate, you are a router for that hop: invoke the Agent tool and let the team member take over. The full brief, context, and instructions go INSIDE the Agent tool call — not in a visible chat turn.',
      '',
      'RULES:',
      '- Delegate when a task matches a team member\'s speciality. Do it yourself only for tasks in YOUR core domain.',
      '- When you delegate, call the Agent tool in the same response. A brief one-sentence handoff is fine ("Handing to [name]."), but it must accompany the tool call, not replace it.',
      '- Do NOT narrate the delegation brief in visible chat. Do not describe what the team member will do, list the steps they will take, announce which files they will load, or refer to the user in third person. That belongs inside the Agent tool prompt.',
      '- Do NOT ask clarifying questions on the team member\'s behalf. Let them ask their own if needed.',
      '- Use your team member\'s actual name when handing off. Do not invent labels or role titles.',
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

  const sections = [baseRules];
  if (delegationSection) sections.push(delegationSection);
  if (scopeSection) sections.push(scopeSection);
  sections.push(bashRules);
  return sections.join('\n\n');
}

// ===== AGENT DISCOVERY =====

let _agentCache = null;
let _agentCacheTime = 0;
const AGENT_CACHE_TTL = 2000; // 2 seconds

function invalidateAgentCache() { _agentCache = null; _agentCacheTime = 0; }

function discoverAgents() {
  const now = Date.now();
  if (_agentCache && (now - _agentCacheTime) < AGENT_CACHE_TTL) return _agentCache;
  const agents = [];
  const agentsDir = path.join(WORKSPACE, '.claude', 'agents');
  const claudeMdPath = path.join(WORKSPACE, 'CLAUDE.md');
  const colours = ['#E87A5A', '#6B9EF0', '#6BC67E', '#E8A84C', '#A07AE8', '#E87AAC', '#5BCFC4', '#E8A07A'];
  const icons = ['★', '✎', '◎', '▦', '◇', '✦', '⬡', '△'];
  let colourIdx = 0;

  if (fs.existsSync(agentsDir)) {
    let files = [];
    try { files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md')); } catch (e) { console.warn('  Cannot read agents dir:', e.message); }

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(agentsDir, file), 'utf-8');
        const fmText = extractFrontmatterText(content);
        const meta = parseAgentFrontmatter(content);
        const id = file.replace('.md', '');
        const isDefault = meta.isDefault === 'true' || meta.isDefault === true || (meta.order && parseInt(meta.order) === 0);

        const fmName = meta.name || id;
        const displayName = meta.displayName || meta.name || titleCase(id);
        const role = meta.role || titleCase(id);
        const bodyMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)/);
        let instructions = bodyMatch ? bodyMatch[1].trim() : '';

        // If this is the default agent, merge instructions from CLAUDE.md
        if (isDefault && fs.existsSync(claudeMdPath)) {
          instructions = fs.readFileSync(claudeMdPath, 'utf-8').substring(0, 2000);
        }

        const caps = parseCapabilities(fmText);
        const routines = parseRoutines(fmText);
        const prompts = parsePrompts(fmText);
        const skills = parseSkills(fmText);

        const agentType = meta.type || null; // orchestrator, specialist, platform, or null
        const hasOrder = meta.order !== undefined && meta.order !== '';
        const orderNum = hasOrder ? parseFloat(meta.order) : null;

        // Three-state detection:
        // onTeam: has order (with or without type - backward compat)
        // available: has type but no order (marketplace install, not placed)
        // raw: no type AND no order (bare Claude Code agent, needs onboarding)
        let status = 'raw';
        if (hasOrder) status = 'onTeam';
        else if (agentType) status = 'available';

        agents.push({
          id: isDefault ? 'default' : id,
          name: fmName,
          displayName,
          role,
          description: meta.description || '',
          type: agentType,
          status,
          capabilities: caps,
          routines: routines,
          prompts: prompts.length > 0 ? prompts : null,
          skills: skills.length > 0 ? skills : null,
          model: meta.model || null,
          order: orderNum,
          reportsTo: meta.reportsTo || null,
          instructions: instructions.substring(0, 2000),
          isDefault,
          colour: meta.colour || colours[colourIdx % colours.length],
          icon: meta.icon || icons[colourIdx % icons.length],
          fileName: file
        });
        colourIdx++;
      } catch (e) {
        console.error(`Error reading agent ${file}:`, e.message);
      }
    }
  }

  // If no default agent was found in agent files, create one from CLAUDE.md
  if (!agents.find(a => a.isDefault)) {
    if (fs.existsSync(claudeMdPath)) {
      const content = fs.readFileSync(claudeMdPath, 'utf-8');
      const nameMatch = content.match(/^#\s+(.+)/m);
      const defaultName = nameMatch ? nameMatch[1].split(/\s*[-]/)[0].trim() : 'Assistant';
      agents.unshift({
        id: 'default',
        name: 'default',
        displayName: defaultName,
        role: 'Default Agent',
        description: '',
        capabilities: null,
        routines: [],
        prompts: null,
        model: null,
        order: 0,
        instructions: content.substring(0, 2000),
        isDefault: true,
        colour: '#E87A5A',
        icon: '★',
        fileName: null
      });
    }
  }

  // Sort: onTeam first (by order), then available, then raw
  agents.sort((a, b) => {
    const statusOrder = { onTeam: 0, available: 1, raw: 2 };
    const sa = statusOrder[a.status] ?? 2;
    const sb = statusOrder[b.status] ?? 2;
    if (sa !== sb) return sa - sb;
    // Within onTeam: orchestrator first, then by order
    if (a.type === 'orchestrator' && b.type !== 'orchestrator') return -1;
    if (b.type === 'orchestrator' && a.type !== 'orchestrator') return 1;
    if (a.type === 'platform' && b.type !== 'platform') return 1;
    if (b.type === 'platform' && a.type !== 'platform') return -1;
    return (a.order ?? 99) - (b.order ?? 99);
  });

  // Inject built-in Doc if no platform agent exists
  if (!agents.find(a => a.type === 'platform')) {
    agents.push({
      id: 'rundock-guide',
      name: 'rundock-guide',
      displayName: 'Doc',
      role: 'Platform Guide',
      description: 'Helps you set up and navigate your Rundock workspace',
      type: 'platform',
      status: 'onTeam',
      capabilities: null,
      routines: [],
      prompts: ['Help me set up this workspace', 'Create an agent for my team', 'What makes a workspace Rundock-ready?'],
      model: null,
      order: 99,
      instructions: '',
      isDefault: false,
      colour: '#6B8A9E',
      icon: '⬡',
      fileName: null
    });
  }

  // Attach routine state
  for (const agent of agents) {
    if (agent.routines) {
      for (const r of agent.routines) {
        const key = `${agent.id}:${r.name}`;
        r.state = routineState[key] || null;
      }
    }
  }

  _agentCache = agents;
  _agentCacheTime = Date.now();
  return agents;
}

function extractFrontmatterText(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : '';
}

function titleCase(str) {
  return str.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function parseAgentFrontmatter(content) {
  const fmText = extractFrontmatterText(content);
  if (!fmText) return {};

  const meta = {};
  const lines = fmText.split('\n');
  let currentKey = null;
  let currentValue = '';

  for (const line of lines) {
    // Skip nested blocks (capabilities, routines, prompts) - parsed separately
    if (line.match(/^(capabilities|routines|prompts):$/)) {
      if (currentKey) { meta[currentKey] = currentValue.trim(); }
      currentKey = null; continue;
    }
    if (line.match(/^\s+-?\s*\w+:/) && line.startsWith('  ')) { continue; }

    const keyMatch = line.match(/^(\w+):\s*(.*)/);
    if (keyMatch) {
      if (currentKey) meta[currentKey] = currentValue.trim();
      currentKey = keyMatch[1];
      currentValue = keyMatch[2];
    } else if (currentKey && line.startsWith('  ')) {
      currentValue += ' ' + line.trim();
    }
  }
  if (currentKey) meta[currentKey] = currentValue.trim();

  if (meta.description) meta.description = meta.description.replace(/^>\s*/, '').trim();
  // Strip surrounding quotes from values (YAML-style "value" or 'value')
  for (const key of Object.keys(meta)) {
    if (typeof meta[key] === 'string') {
      meta[key] = meta[key].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    }
  }
  return meta;
}

function parseCapabilities(fmText) {
  const match = fmText.match(/capabilities:\n((?:  \w+:.*\n?)+)/);
  if (!match) return null;
  const caps = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^\s+(\w+):\s*(.*)/);
    if (kv) caps[kv[1]] = kv[2].trim();
  }
  return Object.keys(caps).length > 0 ? caps : null;
}

function parseRoutines(fmText) {
  const routines = [];
  const match = fmText.match(/routines:\n((?:  - [\s\S]*?)(?=\n\w|\n$|$))/);
  if (!match) return routines;

  // Split into individual routine blocks by "  - name:"
  const blocks = match[1].split(/(?=  - name:)/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const routine = {};
    for (const line of block.split('\n')) {
      const kv = line.match(/^\s+-?\s*(\w+):\s*(.*)/);
      if (kv) routine[kv[1]] = kv[2].trim();
    }
    if (routine.name) routines.push(routine);
  }
  return routines;
}

function parsePrompts(fmText) {
  const match = fmText.match(/prompts:\n((?:  - [^\n]*(?:\n|$))+)/);
  if (!match) return [];
  const prompts = [];
  for (const line of match[1].split('\n')) {
    if (!line.trim()) continue;
    const item = line.match(/^\s+-\s*"?(.*?)"?\s*$/);
    if (item && item[1].trim()) prompts.push(item[1].trim());
  }
  return prompts;
}

function parseSkills(fmText) {
  const match = fmText.match(/skills:\n((?:  - [^\n]*(?:\n|$))+)/);
  if (!match) return [];
  const skills = [];
  for (const line of match[1].split('\n')) {
    if (!line.trim()) continue;
    const item = line.match(/^\s+-\s*"?(.*?)"?\s*$/);
    if (item && item[1].trim()) skills.push(item[1].trim());
  }
  return skills;
}

// ===== SCHEDULER =====

function startScheduler() {
  const checkInterval = 60 * 1000; // Check every 60 seconds

  setInterval(() => {
    const agents = discoverAgents();
    const now = new Date();

    for (const agent of agents) {
      if (!agent.routines) continue;
      for (const routine of agent.routines) {
        const key = `${agent.id}:${routine.name}`;
        const nextRun = getNextRun(routine.schedule, routineState[key]?.lastRun);
        if (nextRun && now >= nextRun) {
          console.log(`[Scheduler] Running routine: ${routine.name} (${agent.name})`);
          executeRoutine(agent, routine, key);
        }
      }
    }
  }, checkInterval);
}

function getNextRun(schedule, lastRunISO) {
  if (!schedule) return null;
  const now = new Date();
  const s = schedule.toLowerCase();

  // Parse "every day at HH:MM"
  const dailyMatch = s.match(/every day at (\d{2}):(\d{2})/);
  if (dailyMatch) {
    const target = new Date(now);
    target.setHours(parseInt(dailyMatch[1]), parseInt(dailyMatch[2]), 0, 0);
    // If already past today, next is tomorrow
    if (now > target) target.setDate(target.getDate() + 1);
    // Don't re-run if already ran today
    if (lastRunISO) {
      const lastRun = new Date(lastRunISO);
      if (lastRun.toDateString() === now.toDateString() && lastRun.getHours() >= parseInt(dailyMatch[1])) return null;
    }
    return target;
  }

  // Parse "every [weekday] at HH:MM"
  const weeklyMatch = s.match(/every (\w+) at (\d{2}):(\d{2})/);
  if (weeklyMatch) {
    const days = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    const targetDay = days[weeklyMatch[1]];
    if (targetDay === undefined) return null;
    const target = new Date(now);
    target.setHours(parseInt(weeklyMatch[2]), parseInt(weeklyMatch[3]), 0, 0);
    const daysUntil = (targetDay - now.getDay() + 7) % 7;
    if (daysUntil === 0 && now > target) target.setDate(target.getDate() + 7);
    else target.setDate(target.getDate() + daysUntil);
    // Don't re-run if already ran this week
    if (lastRunISO) {
      const lastRun = new Date(lastRunISO);
      const daysSinceLastRun = (now - lastRun) / (1000 * 60 * 60 * 24);
      if (daysSinceLastRun < 1 && lastRun.getDay() === targetDay) return null;
    }
    return target;
  }

  return null;
}

function executeRoutine(agent, routine, key) {
  const startTime = Date.now();
  routineState[key] = { lastRun: new Date().toISOString(), status: 'running', duration: null };

  // Notify connected clients
  broadcastRoutineUpdate();

  // Routines run unattended (no user to approve), so bypass permissions.
  const args = [...getBareArgs(), '--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  if (agent.id !== 'default') args.push('--agent', agent.id);
  args.push(routine.prompt);

  const proc = spawnClaude(args, {
    cwd: WORKSPACE,
    env: getSpawnEnv(null),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  proc.on('close', (code) => {
    const duration = Math.round((Date.now() - startTime) / 1000);
    routineState[key] = {
      lastRun: new Date().toISOString(),
      status: code === 0 ? 'completed' : 'failed',
      duration
    };
    console.log(`[Scheduler] Routine "${routine.name}" ${code === 0 ? 'completed' : 'failed'} (${duration}s)`);
    broadcastRoutineUpdate();
  });
}

function broadcastRoutineUpdate() {
  const agents = discoverAgents();
  const msg = JSON.stringify({ type: 'agents', agents });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

// ===== WORKSPACE ANALYSIS (Seven Signals) =====

const SKILL_CLUSTERS = [
  { label: 'Meetings & People', pattern: /meeting|prep|process|granola|attendee|agenda|people|person|contact/i },
  { label: 'Career & Growth', pattern: /career|coach|resume|identity|evidence|promotion|mentor|feedback/i },
  { label: 'Content & Writing', pattern: /content|write|draft|publish|post|blog|newsletter|hook|audit|voice/i },
  { label: 'Research & Analysis', pattern: /research|search|scrape|fetch|crawl|analy|competitor|trend|digest/i },
  { label: 'Code Review', pattern: /code.?review|pr-review|pull.?request|diff|merge|refactor/i },
  { label: 'Build & Deploy', pattern: /lint|ci[-\s]|deploy|compile|bundle|release|docker|\.test|unit.?test|e2e/i },
  { label: 'Project Management', pattern: /project|health|brief|product|roadmap|sprint|backlog|kanban/i },
  { label: 'Planning & Review', pattern: /daily|weekly|quarter|plan|review|goal|priority|standup|retro/i },
  { label: 'System & Setup', pattern: /setup|install|config(?!ure)|dex-update|system-update|reset|health-check|getting-started|migrate/i },
];

function analyzeWorkspace(dir, existingAgents) {
  const analysis = { identity: {}, skills: {}, integrations: {}, structure: {}, userProfile: {}, hooks: {}, agents: {} };

  // --- Signal 1: Identity ---
  const sources = [];
  try {
    const readmePath = path.join(dir, 'README.md');
    if (fs.existsSync(readmePath)) {
      const text = fs.readFileSync(readmePath, 'utf-8');
      const h1 = text.match(/^#\s+(.+)/m);
      const firstPara = text.match(/^#[^\n]+\n+([^\n#]+)/m);
      sources.push({ file: 'README.md', heading: h1 ? h1[1].trim() : null, summary: firstPara ? firstPara[1].trim() : null });
    }
  } catch (e) {}
  try {
    const claudePath = path.join(dir, 'CLAUDE.md');
    if (fs.existsSync(claudePath)) {
      const text = fs.readFileSync(claudePath, 'utf-8');
      const h1 = text.match(/^#\s+(.+)/m);
      const youAre = text.match(/You are (\w+)[,.]?\s*([^.]*)\./);
      sources.push({ file: 'CLAUDE.md', heading: h1 ? h1[1].trim() : null, identity: youAre ? `You are ${youAre[1]}, ${youAre[2]}.` : null });
    }
  } catch (e) {}
  try {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.name || pkg.description) {
        sources.push({ file: 'package.json', name: pkg.name || null, description: pkg.description || null });
      }
    }
  } catch (e) {}

  // Resolve identity: README > CLAUDE.md > package.json
  let suggestedName = null, suggestedTagline = null, suggestedRole = null;
  const readme = sources.find(s => s.file === 'README.md');
  const claude = sources.find(s => s.file === 'CLAUDE.md');
  const pkg = sources.find(s => s.file === 'package.json');
  if (readme?.heading) {
    // Extract name and tagline from heading like "Dex by Dave — Your AI Chief of Staff"
    const parts = readme.heading.split(/[—–:|]+/).map(s => s.trim());
    suggestedName = parts[0]?.split(/\s+/)[0]; // First word of first part
    suggestedTagline = parts[1] || readme.summary;
    suggestedRole = parts[1] || null;
  }
  if (!suggestedName && claude?.identity) {
    const nameMatch = claude.identity.match(/You are (\w+)/);
    if (nameMatch) suggestedName = nameMatch[1];
  }
  if (!suggestedName && pkg?.name) {
    suggestedName = pkg.name.split('-')[0];
    suggestedName = suggestedName.charAt(0).toUpperCase() + suggestedName.slice(1);
  }
  analysis.identity = { sources, suggestedName, suggestedTagline, suggestedRole };

  // --- Signal 2: Skills with Pre-Grouping ---
  const skillSources = [
    { dir: path.join(dir, 'System', 'Playbooks'), defFile: 'PLAYBOOK.md' },
    { dir: path.join(dir, '.claude', 'skills'), defFile: 'SKILL.md' },
  ];
  const allSkills = [];
  for (const src of skillSources) {
    if (!fs.existsSync(src.dir)) continue;
    try {
      // Skip _prefixed (inactive) and anthropic-* (Claude Code built-in document skills)
      const dirs = fs.readdirSync(src.dir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('anthropic-'));
      for (const d of dirs) {
        const defPath = path.join(src.dir, d.name, src.defFile);
        if (!fs.existsSync(defPath)) continue;
        try {
          const content = fs.readFileSync(defPath, 'utf-8');
          const parsed = parseSkillFile(content, d.name);
          allSkills.push({ id: d.name, name: parsed.displayName, description: parsed.description });
        } catch (e) {}
      }
    } catch (e) {}
  }

  // Group skills by keyword clusters
  const groups = [];
  const grouped = new Set();
  for (const cluster of SKILL_CLUSTERS) {
    const matching = allSkills.filter(s => {
      if (grouped.has(s.id)) return false;
      const text = `${s.id} ${s.name} ${s.description}`.toLowerCase();
      const matches = text.match(cluster.pattern);
      return matches;
    });
    if (matching.length > 0) {
      // Calculate confidence based on match quality
      const slugs = matching.map(s => s.id);
      const highConfidence = matching.filter(s => {
        const text = `${s.id} ${s.name} ${s.description}`.toLowerCase();
        const allMatches = text.match(new RegExp(cluster.pattern.source, 'gi'));
        return allMatches && allMatches.length >= 2;
      });
      groups.push({
        label: cluster.label,
        slugs,
        confidence: highConfidence.length >= matching.length / 2 ? 'high' : 'medium'
      });
      slugs.forEach(s => grouped.add(s));
    }
  }
  // Ungrouped skills
  const ungrouped = allSkills.filter(s => !grouped.has(s.id)).map(s => s.id);
  if (ungrouped.length > 0) {
    groups.push({ label: 'Uncategorised', slugs: ungrouped, confidence: 'low' });
  }
  analysis.skills = { total: allSkills.length, groups, ungrouped, list: allSkills };

  // --- Signal 3: Integrations and MCP Servers ---
  const mcpReferences = [];
  const mentionedTools = [];
  const knownTools = ['Granola', 'ScreenPipe', 'Notion', 'Todoist', 'Slack', 'Linear', 'Jira', 'GitHub', 'Obsidian', 'Raycast', 'AuthoredUp', 'Readwise'];
  try {
    const claudePath = path.join(dir, 'CLAUDE.md');
    if (fs.existsSync(claudePath)) {
      const text = fs.readFileSync(claudePath, 'utf-8');
      const lines = text.split('\n');
      // Extract named MCP servers: match "from X MCP" or "X MCP tools/server" patterns
      // These are the reliable indicators of actual named MCP servers
      const mcpNamePattern = /(?:from|via|using|call|check)\s+(?:the\s+)?(\w[\w\s]*?)\s+MCP\b/gi;
      let mcpMatch;
      while ((mcpMatch = mcpNamePattern.exec(text)) !== null) {
        const rawName = mcpMatch[1].trim();
        // Skip if the "name" is a common verb/article that leaked through
        if (rawName.length < 2 || /^(the|a|an|to|is|it|or|if|my)$/i.test(rawName)) continue;
        const name = rawName + ' MCP';
        if (!mcpReferences.find(m => m.name === name)) {
          mcpReferences.push({ name, context: mcpMatch[0].trim(), source: 'CLAUDE.md' });
        }
      }
      for (const tool of knownTools) {
        if (text.includes(tool) && !mentionedTools.includes(tool)) {
          mentionedTools.push(tool);
        }
      }
    }
  } catch (e) {}

  let configuredServers = [];
  try {
    const mcpJsonPath = path.join(dir, '.mcp.json');
    if (fs.existsSync(mcpJsonPath)) {
      const mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
      if (mcpConfig.mcpServers) {
        configuredServers = Object.keys(mcpConfig.mcpServers);
      }
    }
  } catch (e) {}
  analysis.integrations = { mcpReferences, configuredServers, mentionedTools };

  // --- Signal 4: Folder Structure with Pattern Detection ---
  let topLevelDirs = [];
  try {
    topLevelDirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map(d => d.name);
  } catch (e) {}

  let pattern = 'unknown';
  const hasNumbered = topLevelDirs.some(d => /^\d{2}[-_]/.test(d));
  // PARA requires all four core folders: Projects, Areas, Resources, Archive
  const paraCoreNames = ['project', 'area', 'resource', 'archive'];
  const hasPara = paraCoreNames.every(p => topLevelDirs.some(d => d.toLowerCase().includes(p)));
  const hasDev = ['src', 'lib', 'test', 'tests'].filter(d => topLevelDirs.includes(d)).length >= 2;
  const hasFunctional = ['clients', 'marketing', 'finance', 'sales', 'engineering', 'hr'].filter(d =>
    topLevelDirs.some(td => td.toLowerCase() === d)
  ).length >= 2;

  if (hasNumbered && hasPara) pattern = 'para-numbered';
  else if (hasPara) pattern = 'para';
  else if (hasDev) pattern = 'dev-project';
  else if (hasFunctional) pattern = 'functional';
  else if (topLevelDirs.length <= 3) pattern = 'minimal';

  // Key path detection
  const keyPaths = {};
  const allDirs = [...topLevelDirs];
  // Also scan second-level dirs for key paths
  for (const td of topLevelDirs) {
    try {
      const subs = fs.readdirSync(path.join(dir, td), { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => `${td}/${d.name}`);
      allDirs.push(...subs);
    } catch (e) {}
  }
  for (const d of allDirs) {
    const lower = d.toLowerCase();
    if (!keyPaths.inbox && (lower.includes('inbox') || lower.includes('capture'))) keyPaths.inbox = d + '/';
    if (!keyPaths.projects && lower.includes('project')) keyPaths.projects = d + '/';
    if (!keyPaths.tasks && lower.includes('task')) keyPaths.tasks = d + '/';
    if (!keyPaths.people && lower.includes('people')) keyPaths.people = d + '/';
    if (!keyPaths.areas && lower.match(/area/)) keyPaths.areas = d + '/';
    if (!keyPaths.archive && lower.includes('archive')) keyPaths.archive = d + '/';
    if (!keyPaths.system && (lower === 'system' || lower === 'config')) keyPaths.system = d + '/';
  }
  analysis.structure = {
    topLevelDirs,
    pattern,
    keyPaths,
    hasClaudeDir: fs.existsSync(path.join(dir, '.claude')),
    hasAgentsDir: fs.existsSync(path.join(dir, '.claude', 'agents')),
    hasSkillsDir: fs.existsSync(path.join(dir, '.claude', 'skills'))
  };

  // --- Signal 5: User Profile and Configuration ---
  const profilePaths = ['user-profile.yaml', 'profile.yaml', 'config.yaml', 'System/user-profile.yaml', 'System/config.yaml'];
  let userProfile = { exists: false, file: null, populated: false, fields: {} };
  for (const p of profilePaths) {
    try {
      const fullPath = path.join(dir, p);
      if (fs.existsSync(fullPath)) {
        const text = fs.readFileSync(fullPath, 'utf-8');
        const fields = {};
        for (const field of ['name', 'role', 'roleGroup', 'company', 'email']) {
          const match = text.match(new RegExp(`^${field}:\\s*(.+)`, 'm'));
          fields[field] = match ? match[1].trim().replace(/^['"]|['"]$/g, '') : '';
        }
        const populated = Object.values(fields).some(v => v && v.length > 0);
        userProfile = { exists: true, file: p, populated, fields };
        break;
      }
    } catch (e) {}
  }

  // Check for pillars/goals config
  let systemConfig = { pillars: { exists: false }, templates: [] };
  try {
    const pillarPaths = ['pillars.yaml', 'System/pillars.yaml'];
    for (const p of pillarPaths) {
      if (fs.existsSync(path.join(dir, p))) {
        const text = fs.readFileSync(path.join(dir, p), 'utf-8');
        const populated = text.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('---')).length > 3;
        systemConfig.pillars = { exists: true, populated, file: p };
        break;
      }
    }
    // Look for template files
    const sysDir = path.join(dir, 'System');
    if (fs.existsSync(sysDir)) {
      const sysFiles = fs.readdirSync(sysDir);
      systemConfig.templates = sysFiles.filter(f => /template|example/i.test(f));
    }
  } catch (e) {}
  analysis.userProfile = userProfile;
  analysis.systemConfig = systemConfig;

  // --- Signal 6: Hooks and Automation ---
  const hooksResult = { present: [], soundHooks: [], contextHooks: [], automationHooks: [] };
  try {
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (settings.hooks) {
        for (const [event, entries] of Object.entries(settings.hooks)) {
          hooksResult.present.push(event);
          for (const entry of (Array.isArray(entries) ? entries : [])) {
            const hooks = entry.hooks || [entry];
            for (const hook of hooks) {
              if (!hook.command) continue;
              const cmd = hook.command;
              if (/afplay|aplay|paplay|powershell.*audio/i.test(cmd)) {
                const alreadyMuted = cmd.includes('$RUNDOCK');
                hooksResult.soundHooks.push({ event, command: cmd, muted: alreadyMuted });
              } else if (/inject|context/i.test(cmd)) {
                const nameMatch = cmd.match(/\/([\w-]+)\.\w+$/);
                hooksResult.contextHooks.push({ event, matcher: entry.matcher || null, name: nameMatch ? nameMatch[1] : cmd.substring(0, 60) });
              } else if (/session|\.sh|\.py|\.js/i.test(cmd)) {
                hooksResult.automationHooks.push({ event, command: cmd.substring(0, 80) });
              }
            }
          }
        }
      }
    }
  } catch (e) {}
  analysis.hooks = hooksResult;

  // --- Signal 7: Existing Agents ---
  const agentList = existingAgents || discoverAgents();
  const nonPlatform = agentList.filter(a => a.type !== 'platform');
  analysis.agents = {
    total: agentList.length,
    onTeam: nonPlatform.filter(a => a.status === 'onTeam').length,
    available: nonPlatform.filter(a => a.status === 'available').length,
    raw: nonPlatform.filter(a => a.status === 'raw').length,
    hasOrchestrator: agentList.some(a => a.type === 'orchestrator'),
    list: agentList.map(a => ({
      name: a.id, displayName: a.displayName, role: a.role, type: a.type,
      order: a.order, status: a.status
    }))
  };

  return analysis;
}

// Mute sound hooks for Rundock (idempotent: skips already-muted hooks)
function muteHooks(dir) {
  const settingsPath = path.join(dir, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) return;
  try {
    const text = fs.readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(text);
    if (!settings.hooks) return;
    let mutedCount = 0;
    const soundPattern = /afplay|aplay|paplay|powershell.*audio/i;

    for (const [event, entries] of Object.entries(settings.hooks)) {
      for (const entry of (Array.isArray(entries) ? entries : [])) {
        const hooks = entry.hooks || [entry];
        for (const hook of hooks) {
          if (!hook.command || !soundPattern.test(hook.command)) continue;
          if (hook.command.includes('$RUNDOCK')) continue; // Already muted
          hook.command = `[ -z "$RUNDOCK" ] && ${hook.command} || true`;
          mutedCount++;
        }
      }
    }
    if (mutedCount > 0) {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log(`  [Scaffold] Muted ${mutedCount} sound hook(s) for Rundock`);
    }
  } catch (e) {
    console.warn(`  Warning: could not mute hooks: ${e.message}`);
  }
}

// ===== EMPTY WORKSPACE DETECTION (C1) =====

// Returns true if the workspace has no user-created content: no agents (besides
// Rundock-managed ones), no CLAUDE.md, no skills. The .claude/ directory and
// .rundock/ directory are ignored since scaffoldWorkspace() creates those.
function isEmptyWorkspace(dir, agentList) {
  // Check for CLAUDE.md
  if (fs.existsSync(path.join(dir, 'CLAUDE.md'))) return false;

  // Check for user-created agents (exclude platform agents injected by Rundock)
  const userAgents = (agentList || []).filter(a =>
    a.type !== 'platform' && a.id !== 'rundock-guide'
  );
  if (userAgents.length > 0) return false;

  // Check for skills (either location)
  const skillDirs = [
    path.join(dir, '.claude', 'skills'),
    path.join(dir, 'System', 'Playbooks'),
  ];
  for (const sd of skillDirs) {
    try {
      if (fs.existsSync(sd)) {
        const entries = fs.readdirSync(sd, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith('rundock-'));
        if (entries.length > 0) return false;
      }
    } catch (e) { /* ignore */ }
  }

  return true;
}

// ===== CODE SIGNAL AUTO-DETECTION (C2) =====

// File extensions and config files that indicate a code project.
const CODE_SIGNALS = [
  // Extensions (checked against top-level files and one level deep)
  '.js', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.rb', '.java',
  '.c', '.cpp', '.h', '.cs', '.swift', '.kt',
];
const CODE_CONFIG_FILES = [
  'package.json', 'requirements.txt', 'Cargo.toml', 'go.mod',
  'Makefile', 'CMakeLists.txt', 'pyproject.toml', 'Gemfile',
  'pom.xml', 'build.gradle', 'tsconfig.json', '.eslintrc.json',
  'setup.py', 'setup.cfg', 'composer.json',
];

// Scans workspace for code files. Returns 'code' or 'knowledge'.
function detectWorkspaceMode(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      if (entry.isFile()) {
        // Check config files
        if (CODE_CONFIG_FILES.includes(entry.name)) return 'code';
        // Check extensions
        const ext = path.extname(entry.name).toLowerCase();
        if (CODE_SIGNALS.includes(ext)) return 'code';
      }

      // Scan one level deep for code files
      if (entry.isDirectory()) {
        try {
          const subEntries = fs.readdirSync(path.join(dir, entry.name));
          for (const sub of subEntries) {
            if (CODE_CONFIG_FILES.includes(sub)) return 'code';
            const ext = path.extname(sub).toLowerCase();
            if (CODE_SIGNALS.includes(ext)) return 'code';
          }
        } catch (e) { /* skip unreadable dirs */ }
      }
    }
  } catch (e) {
    console.warn('  Code signal detection failed:', e.message);
  }
  return 'knowledge';
}

// ===== DEFAULT WORKSPACE SCAFFOLDING (C3) =====

// Creates default folders, CLAUDE.md, and orchestrator agent for new/empty workspaces.
// Returns { success: true } or { success: false, error: string }.
function scaffoldDefaults(dir) {
  const folderName = path.basename(dir);
  const mode = detectWorkspaceMode(dir);
  const isCode = mode === 'code';

  try {
    if (!isCode) {
      // Knowledge workspace: create default folders
      const folders = ['0 Inbox', '1 Notes', '2 Projects', '3 Resources', '4 Archive'];
      for (const folder of folders) {
        fs.mkdirSync(path.join(dir, folder), { recursive: true });
      }

      // Create CLAUDE.md with folder structure
      const claudeMd = `# ${folderName}

## Workspace structure

- **0 Inbox/**: Put things here when you don't know where they go
- **1 Notes/**: Meeting notes, ideas, quick captures
- **2 Projects/**: Things you're actively working on
- **3 Resources/**: Reference material you want to keep
- **4 Archive/**: Finished work
`;
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), claudeMd);
    } else {
      // Code workspace: create minimal CLAUDE.md only, no folders
      const claudeMd = `# ${folderName}\n`;
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), claudeMd);
    }

    // Mark setup as incomplete so onboarding flows through Doc
    const state = readState();
    state.setupComplete = false;
    writeState(state);

    console.log(`  [Scaffold] Created default workspace (${mode}): CLAUDE.md${isCode ? '' : ' + folders'} (setup pending)`);
    return { success: true };
  } catch (e) {
    console.error(`  [Scaffold] Default workspace creation failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// ===== WORKSPACE SCAFFOLD =====

// Rundock-owned files: synced from scaffold/ on every workspace open.
// Only rundock-* prefixed files are managed. User files are never touched.
const RUNDOCK_MANAGED_FILES = [
  { source: 'rundock-guide.md',            target: '.claude/agents/rundock-guide.md' },
  { source: 'rundock-workspace.md',  target: '.claude/skills/rundock-workspace/SKILL.md' },
  { source: 'rundock-agents.md',    target: '.claude/skills/rundock-agents/SKILL.md' },
  { source: 'rundock-skills.md',    target: '.claude/skills/rundock-skills/SKILL.md' },
];

function scaffoldWorkspace(dir) {
  try {
    fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });

    // Sync Rundock-owned agents and skills from scaffold sources
    for (const entry of RUNDOCK_MANAGED_FILES) {
      const sourceContent = fs.readFileSync(path.join(__dirname, 'scaffold', entry.source), 'utf-8');
      const targetPath = path.join(dir, entry.target);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });

      let action = null;
      if (!fs.existsSync(targetPath)) {
        action = 'Created';
      } else {
        const deployed = fs.readFileSync(targetPath, 'utf-8');
        if (deployed !== sourceContent) action = 'Updated';
      }

      if (action) {
        fs.writeFileSync(targetPath, sourceContent, 'utf-8');
        console.log(`  [Scaffold] ${action}: ${entry.target}`);
      }
    }

    // Create .rundock/ directory for session persistence
    const rundockPath = path.join(dir, '.rundock');
    fs.mkdirSync(rundockPath, { recursive: true });

    // Ensure .rundock/ is gitignored (contains session IDs and timestamps)
    const gitignorePath = path.join(dir, '.gitignore');
    try {
      const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
      if (!existing.includes('.rundock')) {
        const line = (existing && !existing.endsWith('\n') ? '\n' : '') + '.rundock/\n';
        fs.appendFileSync(gitignorePath, line);
        console.log(`  Scaffolded: .rundock/ added to .gitignore`);
      }
    } catch (e) {
      console.warn(`  Warning: could not update .gitignore: ${e.message}`);
    }

    // Auto-mute sound hooks for Rundock
    muteHooks(dir);

    // Configure PreToolUse permission hooks in .claude/settings.local.json.
    // This makes Claude Code call our hook script before executing tools,
    // which bridges to the Rundock browser UI for user approval.
    // Separate matchers for Bash commands and MCP tools (mcp__*).
    // In Electron, __dirname is inside the read-only asar. The scripts/
    // directory is marked asarUnpack in package.json, so it exists on disk
    // at app.asar.unpacked/scripts/ and must be referenced from there.
    const hookScript = process.env.RUNDOCK_ELECTRON
      ? path.join(__dirname.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked'), 'scripts', 'permission-hook.js')
      : path.join(__dirname, 'scripts', 'permission-hook.js');
    const expectedHookCommand = `node "${hookScript}"`;
    const settingsLocalPath = path.join(dir, '.claude', 'settings.local.json');
    let settingsLocal = {};
    if (fs.existsSync(settingsLocalPath)) {
      try { settingsLocal = JSON.parse(fs.readFileSync(settingsLocalPath, 'utf-8')); } catch (e) { /* start fresh */ }
    }
    if (!settingsLocal.hooks) settingsLocal.hooks = {};
    if (!settingsLocal.hooks.PreToolUse) settingsLocal.hooks.PreToolUse = [];

    const hookEntry = (matcher) => ({
      matcher,
      hooks: [{
        type: 'command',
        command: expectedHookCommand,
        timeout: 300
      }]
    });

    // Drop any existing permission-hook entries whose command does NOT match
    // the current expected path. This forces rewrite of stale entries left
    // behind by earlier versions where the hook path pointed at a location
    // that no longer exists (e.g. inside the read-only asar archive).
    const beforeStale = settingsLocal.hooks.PreToolUse.length;
    settingsLocal.hooks.PreToolUse = settingsLocal.hooks.PreToolUse.filter(e => {
      const hooks = e.hooks || [];
      const hasStaleHook = hooks.some(h =>
        h.command && h.command.includes('permission-hook') && h.command !== expectedHookCommand
      );
      return !hasStaleHook;
    });
    let dirty = settingsLocal.hooks.PreToolUse.length < beforeStale;

    const hasMatcher = (matcher) => settingsLocal.hooks.PreToolUse.some(e =>
      e.matcher === matcher && (e.hooks || []).some(h => h.command === expectedHookCommand)
    );

    if (!hasMatcher('Bash')) {
      settingsLocal.hooks.PreToolUse.push(hookEntry('Bash'));
      dirty = true;
    }
    if (!hasMatcher('mcp__.*')) {
      settingsLocal.hooks.PreToolUse.push(hookEntry('mcp__.*'));
      dirty = true;
    }
    // Clean up Write/Edit hook entries if they exist from a previous version
    const before = settingsLocal.hooks.PreToolUse.length;
    settingsLocal.hooks.PreToolUse = settingsLocal.hooks.PreToolUse.filter(e =>
      !(e.matcher === 'Write' || e.matcher === 'Edit')
    );
    if (settingsLocal.hooks.PreToolUse.length < before) dirty = true;
    if (dirty) {
      fs.writeFileSync(settingsLocalPath, JSON.stringify(settingsLocal, null, 2));
      console.log('  [Scaffold] Configured permission hooks in .claude/settings.local.json');
    }
  } catch (e) {
    console.warn(`  Warning: scaffold failed for ${dir}: ${e.message}`);
  }
}

// ===== HTTP SERVER =====

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  } else if (req.url === '/favicon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'favicon.svg')));
  } else if (req.url === '/marked.min.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(fs.readFileSync(path.join(__dirname, 'node_modules', 'marked', 'lib', 'marked.umd.js')));
  } else if (req.url === '/app.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'app.js')));
  } else if (req.url === '/api/agents') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(discoverAgents()));
  } else if (req.url === '/api/files') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getFileTree(WORKSPACE)));
  } else if (req.url.startsWith('/api/file?path=')) {
    const filePath = decodeURIComponent(req.url.split('path=')[1]);
    const fullPath = path.resolve(WORKSPACE, filePath);
    if (fullPath.startsWith(path.resolve(WORKSPACE)) && fs.existsSync(fullPath)) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(fs.readFileSync(fullPath, 'utf-8'));
    } else {
      res.writeHead(404);
      res.end('File not found');
    }

  // Permission hook endpoint: receives tool requests from the PreToolUse hook script,
  // forwards them to the browser as permission cards, and holds the connection open
  // until the user clicks Allow or Deny (or the 120s timeout fires).
  } else if (req.method === 'POST' && req.url === '/api/permission-request') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const requestId = 'perm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const convoId = data.conversation_id || '';

        // Store the pending HTTP response (resolved when user decides)
        pendingPermissionRequests.set(requestId, {
          res,
          conversationId: convoId,
          toolName: data.tool_name,
          toolInput: data.tool_input,
          timer: setTimeout(() => {
            const pending = pendingPermissionRequests.get(requestId);
            if (pending) {
              pendingPermissionRequests.delete(requestId);
              console.log(`[Permission] Auto-denied (timeout): ${data.tool_name} convo=${convoId} requestId=${requestId}`);
              // Send denied indicator to browser
              safeSend(JSON.stringify({
                type: 'permission_timeout',
                requestId,
                _conversationId: convoId
              }));
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ allow: false, reason: 'timeout' }));
            }
          }, 120000)
        });

        // Forward to browser as a control_request (existing permission card UI handles this)
        safeSend(JSON.stringify({
          type: 'control_request',
          request_id: requestId,
          request: {
            subtype: 'can_use_tool',
            tool_name: data.tool_name,
            input: data.tool_input || {}
          },
          _conversationId: convoId
        }));

        console.log(`[Permission] Hook request: ${data.tool_name} convo=${convoId} requestId=${requestId}`);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });

  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ===== WEBSOCKET SERVER =====

const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin, req }) => {
    // Allow connections from the same host (localhost or configured host)
    if (!origin) return true; // Non-browser clients (e.g. CLI tools)
    // Check against both the configured PORT and the actual listening port
    const actualPort = server.address()?.port || PORT;
    const allowed = [
      `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`,
      `http://localhost:${actualPort}`, `http://127.0.0.1:${actualPort}`,
    ];
    return allowed.includes(origin);
  }
});

// Module-level process tracking: survives WebSocket reconnects
const chatProcesses = new Map(); // conversationId -> { process, buffer, processId, agentId, responseText }
const convoTranscripts = new Map(); // conversationId -> [{ role: 'user'|'agent', agent: string, text: string }]

// Circuit breaker: consecutive agent auto-resume events with no user message.
// Prevents infinite delegation loops (e.g. orchestrator -> specialist -> orchestrator -> specialist ...).
const MAX_CONSECUTIVE_AGENT_RESUMES = 3;
const agentAutoResumeCount = new Map(); // conversationId -> number

function incrementAutoResume(convoId) {
  const count = (agentAutoResumeCount.get(convoId) || 0) + 1;
  agentAutoResumeCount.set(convoId, count);
  return count;
}

function resetAutoResume(convoId) {
  agentAutoResumeCount.set(convoId, 0);
}
const connectedClients = new Set(); // All active WebSocket connections
const disconnectBuffer = []; // Messages queued while no clients are connected

// Conversation transcript helpers
function transcriptDir() { return path.join(rundockDir(), 'transcripts'); }

function loadTranscript(convoId) {
  if (convoTranscripts.has(convoId)) return convoTranscripts.get(convoId);
  try {
    const file = path.join(transcriptDir(), `${convoId}.json`);
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    convoTranscripts.set(convoId, data);
    return data;
  } catch (e) {
    const empty = [];
    convoTranscripts.set(convoId, empty);
    return empty;
  }
}

function saveTranscript(convoId) {
  if (!WORKSPACE) return;
  const transcript = convoTranscripts.get(convoId);
  if (!transcript) return;
  const dir = transcriptDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${convoId}.json`), JSON.stringify(transcript, null, 2));
}

function buildToolSummary(toolCalls) {
  if (!toolCalls || toolCalls.length === 0) return '';
  const seen = new Set();
  const parts = [];
  for (const tc of toolCalls) {
    const key = tc.arg ? `${tc.tool}: ${tc.arg}` : tc.tool;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(tc.arg ? `[${tc.tool} ${tc.arg}]` : `[${tc.tool}]`);
    if (parts.length >= 10) break;
  }
  return parts.join(' ');
}

function appendTranscript(convoId, role, agentId, text) {
  // Load from disk if not in memory (e.g. after server restart)
  if (!convoTranscripts.has(convoId)) {
    const existing = loadTranscript(convoId);
    convoTranscripts.set(convoId, existing);
  }
  const transcript = convoTranscripts.get(convoId);
  // Soft cap at 100 entries to prevent unbounded growth
  if (transcript.length >= 100) transcript.splice(1, 1);
  transcript.push({ role, agent: agentId, text: text || '' });
  // Persist to disk
  saveTranscript(convoId);
}

function formatTranscript(convoId, { excludeAgent } = {}) {
  // Load from disk if not in memory
  const transcript = loadTranscript(convoId);
  if (!transcript || transcript.length === 0) return null;
  const allAgents = discoverAgents(); // Call once, not per entry
  // When excludeAgent is set, filter out that agent's own previous responses
  // so they don't re-process old requests when re-delegated
  const filtered = excludeAgent
    ? transcript.filter(t => t.role === 'user' || t.agent !== excludeAgent)
    : transcript;
  if (filtered.length === 0) return null;
  return filtered.map(t => {
    if (t.role === 'user') return `USER: ${t.text}`;
    const agent = allAgents.find(a => a.id === t.agent || a.name === t.agent);
    const name = agent?.displayName || t.agent;
    return `${name.toUpperCase()}: ${t.text}`;
  }).join('\n\n');
}

function safeSend(data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  let sent = false;
  for (const client of connectedClients) {
    if (client.readyState === 1) {
      client.send(payload);
      sent = true;
    }
  }
  if (!sent) {
    // No live clients: buffer for delivery on next connect
    if (disconnectBuffer.length < 500) disconnectBuffer.push(payload);
  }
}

// Heartbeat: detect silently dead connections every 15s
const HEARTBEAT_INTERVAL = 15000;
setInterval(() => {
  for (const client of connectedClients) {
    if (client._alive === false) {
      console.log('[WS] Heartbeat timeout, terminating stale connection');
      client.terminate();
      return;
    }
    client._alive = false;
    client.ping();
  }
}, HEARTBEAT_INTERVAL);

/**
 * Shared stdout/stderr handler for all Claude Code processes.
 * Consolidates JSONL parsing, metadata enrichment, session capture,
 * Agent tool interception, response text accumulation, and result handling.
 *
 * @param {object} entry - Process entry (must have: process, buffer, processId, agentId, responseText, exited, pendingAgentTool)
 * @param {string} convoId - Conversation ID
 * @param {object} ws - WebSocket connection (unused, kept for signature compatibility)
 * @param {object} options
 * @param {boolean} options.enableInterception - Whether to intercept Agent tool calls targeting direct reports
 * @param {function} options.onResult - Callback(entry, parsed) when a 'result' message is received
 * @returns {{ value: string }} - Mutable stderr buffer reference
 */
function wireProcessHandlers(entry, convoId, ws, options = {}) {
  const { enableInterception = false, onResult } = options;

  entry.process.stdout.on('data', (chunk) => {
    if (entry.exited) return; // P0: guard against data after SIGKILL
    entry.buffer += chunk.toString();
    const lines = entry.buffer.split('\n');
    entry.buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        parsed._agent = entry.agentId;
        parsed._conversationId = convoId;
        parsed._processId = entry.processId;

        // Capture session ID from init message
        if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
          entry.sessionId = parsed.session_id;
          parsed._sessionId = parsed.session_id;
        }

        // ── Agent tool interception ──
        if (enableInterception) {
          const evt = parsed.type === 'stream_event' ? parsed.event : null;
          if (evt) {
            if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use' && evt.content_block?.name === 'Agent') {
              entry.pendingAgentTool = { blockIndex: evt.index, inputJson: '' };
            }
            if (entry.pendingAgentTool && evt.type === 'content_block_delta' && evt.index === entry.pendingAgentTool.blockIndex && evt.delta?.type === 'input_json_delta') {
              entry.pendingAgentTool.inputJson += evt.delta.partial_json;
            }
            if (entry.pendingAgentTool && evt.type === 'content_block_stop' && evt.index === entry.pendingAgentTool.blockIndex) {
              let intercepted = false;
              try {
                const toolInput = JSON.parse(entry.pendingAgentTool.inputJson);
                const target = findDirectReportMatch(entry.agentId, toolInput);
                if (target) {
                  console.log(`[AgentIntercept] convo=${convoId} agent=${entry.agentId} intercepting Agent tool call targeting: ${target.name}`);
                  intercepted = true;
                  // Save orchestrator's response to transcript before killing the process
                  // (the result event won't fire after SIGKILL, so we must persist here)
                  if (entry.responseText) {
                    const toolSummary = buildToolSummary(entry.toolCalls);
                    const textWithTools = toolSummary ? toolSummary + '\n' + entry.responseText : entry.responseText;
                    appendTranscript(convoId, 'agent', entry.agentId, textWithTools);
                  }
                  try { entry.process.kill('SIGKILL'); } catch (e) {}
                  entry.exited = true;
                  // Emit done for the orchestrator so the frontend clears its working indicator
                  // before the specialist's process_started creates a new one.
                  safeSend(JSON.stringify({ type: 'system', subtype: 'done', code: 0, _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId }));
                  handleDelegation({
                    type: 'delegate', conversationId: convoId,
                    targetAgent: target.name,
                    context: toolInput.prompt || toolInput.description || 'Handle this request.',
                    _intercepted: true, _parentSessionId: entry.sessionId, _parentAgentId: entry.agentId
                  }, chatProcesses);
                }
              } catch (e) {
                console.log(`[AgentIntercept] convo=${convoId} failed to parse Agent tool input: ${e.message}`);
              }
              entry.pendingAgentTool = null;
              if (intercepted) continue;
            }
          }
        }

        // Track tool calls for activity summary and transcript
        if (parsed.type === 'stream_event' && parsed.event?.type === 'content_block_start' && parsed.event?.content_block?.type === 'tool_use') {
          const toolName = parsed.event.content_block.name;
          entry.toolCalls.push({ tool: toolName, time: Date.now(), arg: null });
          // Track input JSON for known tools to extract first argument
          if (/^(Read|Edit|Write|Glob|Grep|Bash|WebFetch|WebSearch)$/.test(toolName)) {
            entry._pendingToolArg = { blockIndex: parsed.event.index, inputJson: '' };
          }
        }
        if (entry._pendingToolArg && parsed.type === 'stream_event' && parsed.event?.type === 'content_block_delta' && parsed.event?.index === entry._pendingToolArg.blockIndex && parsed.event?.delta?.type === 'input_json_delta') {
          entry._pendingToolArg.inputJson += parsed.event.delta.partial_json;
        }
        if (entry._pendingToolArg && parsed.type === 'stream_event' && parsed.event?.type === 'content_block_stop' && parsed.event?.index === entry._pendingToolArg.blockIndex) {
          try {
            const input = JSON.parse(entry._pendingToolArg.inputJson);
            const last = entry.toolCalls[entry.toolCalls.length - 1];
            if (last) {
              last.arg = input.file_path || input.path || input.pattern || input.query || input.url
                || (input.command ? input.command.substring(0, 60) : null);
            }
          } catch (e) {}
          entry._pendingToolArg = null;
        }

        // Accumulate response text
        if (parsed.type === 'stream_event' && parsed.event?.type === 'content_block_delta' && parsed.event?.delta?.type === 'text_delta' && parsed.event.delta.text) {
          entry.responseText += parsed.event.delta.text;
        } else if (parsed.type === 'assistant' && parsed.message?.content) {
          for (const block of parsed.message.content) {
            if (block.type === 'text' && block.text) entry.responseText = block.text;
          }
        }

        // Result handling
        if (parsed.type === 'result') {
          entry.resultSent = true;
          // Attach server-tracked tool calls for activity summary
          parsed._toolCalls = entry.toolCalls || [];
          parsed._turnStartTime = entry.turnStartTime || null;
          safeSend(JSON.stringify(parsed));
          safeSend(JSON.stringify({ type: 'system', subtype: 'done', code: 0, _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId }));
          if (onResult) onResult(entry, parsed);
        } else {
          safeSend(JSON.stringify(parsed));
        }
      } catch (e) {
        safeSend(JSON.stringify({ type: 'raw', content: line, _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId }));
      }
    }
  });

  const stderrBuf = { value: '' };
  entry.process.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrBuf.value += text;
    if (text.includes('no stdin data') || text.includes('proceeding without')) return;
    safeSend(JSON.stringify({ type: 'error', content: text, _conversationId: convoId, _processId: entry.processId }));
  });

  return stderrBuf;
}

// ── SCOPE RETURN: specialist hands off to orchestrator ──
// Called when a specialist emits a handoff marker (<!-- RUNDOCK:RETURN --> for out-of-scope,
// <!-- RUNDOCK:COMPLETE --> for pipeline-complete). Two flavours:
//   - Out-of-scope return (default): the specialist is handing back mid-task because the user
//     asked for something outside its domain. We tag the new orchestrator entry with
//     scopeReturnSource so the immediate-reuse guard in handleDelegation blocks the orchestrator
//     from routing the very next user message straight back to the same specialist.
//   - Pipeline-complete return (wasPipelineComplete=true): the specialist finished its delegated
//     work cleanly and is handing back control with nothing outstanding. In that case the user's
//     next message is a fresh request and the orchestrator must be free to route it anywhere,
//     including back to the same specialist. Do not tag scopeReturnSource.
function handleScopeReturn(specialistEntry, convoId, wasPipelineComplete = false) {
  const agentList = discoverAgents();
  const orchestrator = agentList.find(a => a.type === 'orchestrator');

  if (!orchestrator || !orchestrator.fileName) {
    console.warn(`[ScopeReturn] convo=${convoId} no orchestrator found, cannot route`);
    chatProcesses.delete(convoId);
    safeSend(JSON.stringify({ type: 'system', subtype: 'done', code: 0,
      _agent: specialistEntry.agentId, _conversationId: convoId,
      _processId: specialistEntry.processId }));
    return;
  }

  const processId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const systemPrompt = buildSystemPrompt(orchestrator);

  const disallowed = getDisallowedTools();
  const permMode = getPermissionMode();
  const args = [...getBareArgs(), '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--permission-mode', permMode,
    '--allowed-tools', ALLOWED_TOOLS_INTERACTIVE,
    ...(disallowed ? ['--disallowed-tools', disallowed] : []),
    '--append-system-prompt', systemPrompt,
    '--agent', orchestrator.name];

  console.log(`[ScopeReturn] convo=${convoId} from=${specialistEntry.agentId} to=${orchestrator.id} proc=${processId}`);

  const proc = spawnClaude(args, {
    cwd: WORKSPACE,
    env: getSpawnEnv(convoId),
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const orchEntry = {
    process: proc, buffer: '', processId, agentId: orchestrator.id,
    responseText: '', exited: false, resultSent: false,
    lastUserMessage: specialistEntry.lastUserMessage,
    pendingAgentTool: null,
    toolCalls: [], turnStartTime: Date.now(),
    scopeReturnSource: wasPipelineComplete ? null : specialistEntry.agentId
  };
  chatProcesses.set(convoId, orchEntry);

  // Notify client of agent switch
  safeSend(JSON.stringify({
    type: 'system', subtype: 'agent_switch', _conversationId: convoId,
    _processId: processId,
    fromAgent: specialistEntry.agentId, toAgent: orchestrator.id
  }));
  safeSend(JSON.stringify({ type: 'system', subtype: 'process_started',
    _conversationId: convoId, _processId: processId, _agent: orchestrator.id, autoContinue: true }));

  // Circuit breaker: check consecutive auto-resume count before sending prompt.
  // COMPLETE paths are low-risk (orchestrator goes silent) but still count.
  const resumeCount = incrementAutoResume(convoId);
  if (resumeCount >= MAX_CONSECUTIVE_AGENT_RESUMES) {
    console.log(`[CircuitBreaker] convo=${convoId} ${resumeCount} consecutive agent resumes in handleScopeReturn, pausing orchestrator`);
    resetAutoResume(convoId);
    orchEntry.idle = true;
    safeSend(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: `[Auto-paused: ${resumeCount} consecutive agent handoffs without user input. Last specialist: ${specialistEntry.agentId}. Please review the output above and send your next message to continue.]` }, _agent: orchestrator.id, _conversationId: convoId }));
  } else {
    // Build context for orchestrator. Two shapes:
    //  - Pipeline complete: the specialist finished the delegated work. There is no pending
    //    request and no routing to do. The orchestrator must return to standby silently so the
    //    frontend shows it as active for the user's next message.
    //  - Out of scope: the specialist could not handle the request and handed control back.
    //    The orchestrator must route the original message to the correct specialist.
    let prompt;
    if (wasPipelineComplete) {
      prompt = `[SYSTEM: pipeline-complete] ${specialistEntry.agentId} has finished the delegated work. Their output is already in the conversation history and any files they wrote. Control is back with you as the orchestrator. Do not re-delegate. Do not invoke any tools. Do not narrate. Do not write any text to the user in this turn. Exit this turn silently and wait for the user's next message.`;
    } else {
      const pendingRequest = specialistEntry.lastUserMessage || '';
      prompt = `[SYSTEM: routing-request] A specialist (${specialistEntry.agentId}) has finished and control is back with you. The user's pending request is: "${pendingRequest}". Delegate to the right specialist now using the Agent tool. Do not write any text to the user in this turn. Just invoke the Agent tool with the brief.`;
    }

    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
  }

  wireProcessHandlers(orchEntry, convoId, null, {
    enableInterception: true,
    onResult: (e) => {
      if (e.responseText) {
            const toolSummary = buildToolSummary(e.toolCalls);
            const textWithTools = toolSummary ? toolSummary + '\n' + e.responseText : e.responseText;
            appendTranscript(convoId, 'agent', e.agentId, textWithTools);
          }
      e.responseText = '';
      e.idle = true;
    }
  });

  proc.on('close', (orchCode) => {
    orchEntry.exited = true;
    const current = chatProcesses.get(convoId);
    if (current === orchEntry) chatProcesses.delete(convoId);
    if (!orchEntry.resultSent) {
      safeSend(JSON.stringify({ type: 'system', subtype: 'done', code: orchCode,
        _agent: orchEntry.agentId, _conversationId: convoId, _processId: processId }));
    }
  });

  // Send done for the specialist that triggered the scope return
  safeSend(JSON.stringify({ type: 'system', subtype: 'done', code: 0,
    _agent: specialistEntry.agentId, _conversationId: convoId,
    _processId: specialistEntry.processId }));
}

// ── DELEGATION HANDLER (standalone, no WebSocket dependency) ──
function handleDelegation(msg, processes) {
  const convoId = msg.conversationId;
  const existing = processes.get(convoId);
  const isIntercepted = !!msg._intercepted;

  // For intercepted Agent tool calls, the parent is already killed
  if (!isIntercepted && (!existing || existing.exited)) {
    safeSend(JSON.stringify({ type: 'system', subtype: 'delegation_error', content: 'No active process to delegate from', _conversationId: convoId }));
    return;
  }

  const agentList = discoverAgents();
  const targetAgent = agentList.find(a => a.id === msg.targetAgent || a.name === msg.targetAgent)
    || agentList.find(a => a.displayName && a.displayName.toLowerCase() === String(msg.targetAgent).toLowerCase());
  if (!targetAgent || !targetAgent.fileName) {
    safeSend(JSON.stringify({ type: 'system', subtype: 'delegation_error', content: `Agent "${msg.targetAgent}" not found`, _conversationId: convoId }));
    return;
  }

  // Prevent duplicate delegation: if the target agent is already the active process (e.g. Agent tool
  // interception already spawned the delegate, then the DELEGATE marker triggers a second attempt)
  const currentEntry = processes.get(convoId);
  if (currentEntry && currentEntry.agentId === (targetAgent.id || targetAgent.name) && !currentEntry.exited) {
    console.log(`[Delegate] convo=${convoId} skipping duplicate delegation to ${targetAgent.id || targetAgent.name} (already active)`);
    return;
  }

  // Prevent immediate re-delegation to the specialist that just scope-returned
  if (existing && existing.scopeReturnSource === targetAgent.id) {
    console.log(`[ScopeReturn] convo=${convoId} preventing loop: ${targetAgent.id} just scope-returned`);
    existing.scopeReturnSource = null;
    const displayName = targetAgent.displayName || targetAgent.name;
    safeSend(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: `${displayName} has already completed this task. Send your next message to continue.` },
      _agent: existing.agentId, _conversationId: convoId
    }));
    return;
  }

  // Park the original process (or reference the killed one for intercepted calls)
  const originalAgentId = isIntercepted ? msg._parentAgentId : existing.agentId;
  const originalProcessId = isIntercepted ? (existing?.processId || 'intercepted') : existing.processId;
  if (!isIntercepted) existing.idle = true;

  // Spawn delegate process
  const delegateProcessId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const isPlatformDelegate = targetAgent.type === 'platform';

  // Platform delegates (Doc): transactional, auto-return after task completion
  // Specialists with direct reports: multi-step pipeline, return when the pipeline is complete
  // Plain specialists: conversational, user controls when to return
  const targetHasDirectReports = !!buildTeamRoster(targetAgent.id, true);
  let delegationContext;
  if (isPlatformDelegate) {
    delegationContext = 'DELEGATION CONTEXT:\nYou have been delegated a task by another agent. Complete the task in a single response if possible. When the task is done (agent created, skill saved, file written, question answered, etc.), output <!-- RUNDOCK:COMPLETE --> at the very end of that same response. Do not wait for follow-up questions. Do not ask if there is anything else. Just complete the task, confirm what you did, and return immediately. If you genuinely need clarification before you can proceed, ask, but prefer using sensible defaults over asking.\n\nException: if you have proposed a plan and are waiting for the user to confirm before you execute (e.g. you asked them to say "go ahead"), do NOT emit COMPLETE. Stay in the conversation and wait for their response. Only emit COMPLETE once the task is genuinely finished: you executed the work, or you answered the question fully with no pending user decision.\n\nOnly use <!-- RUNDOCK:RETURN --> if the request is genuinely outside your scope and you cannot help. This is rare.';
  } else if (targetHasDirectReports) {
    delegationContext = 'DELEGATION CONTEXT:\nYou have been brought into this conversation by the orchestrator to run a task in your domain. You lead a support team and may delegate parts of the work to them. Do the real work, write the deliverables, and report the outcome.\n\nYou MUST hand control back using one of two markers, on its own line, as the very last thing in your response (after any final summary):\n\n- <!-- RUNDOCK:RETURN --> when the user asks for something outside your domain of expertise. Tell them briefly that this falls outside what you handle and you are handing them back so the right person can pick it up. Do NOT name other specialists or suggest who should handle it. Then emit the marker.\n\n- <!-- RUNDOCK:COMPLETE --> when the orchestrator\'s original delegated pipeline is finished end-to-end. All deliverables are written to their final locations and the workflow has reached its final status (for example content moved to Ready for Review, spec written and linked, final audit posted). Post your final summary first, then emit the marker.\n\nDo NOT emit either marker when you are pausing at a decision point to let the user choose between options, presenting drafts, hooks, options, or recommendations for user review, asking the user to confirm something before continuing, or waiting at a human gate midway through a multi-phase pipeline. Those are pauses, not completions. Stay in the conversation as the active agent and wait for the user\'s next message. You will pick up where you left off when they respond.\n\nReturning on completion is how control flows back up the chain. If you silently stop, the user\'s next message will be routed to the wrong agent.';
  } else {
    delegationContext = 'DELEGATION CONTEXT:\nYou have been brought into this conversation by the orchestrator to handle a specific request. Help the user with their request. Have a natural conversation. Stay in the conversation and keep helping with follow-up questions in your domain.\n\nIMPORTANT: Do NOT return after completing a single task. The user may have more questions for you. Wait for their next message.\n\nOnly return to the orchestrator (output <!-- RUNDOCK:RETURN --> at the very end of your response) when:\n- The user asks for something outside your area of expertise. Tell them briefly that this falls outside what you handle and you are handing them back so the right person can pick it up. Do NOT name other specialists or suggest who should handle it. That is the orchestrator\'s job. Then output the RETURN marker.\n\nDo not attempt tasks you are not designed for. Hand back promptly so the orchestrator can route correctly.';
  }

  const systemPrompt = buildSystemPrompt(targetAgent);
  const fullPrompt = systemPrompt + '\n\n' + delegationContext;

  const delegateDisallowed = getDisallowedTools();
  const delegatePermMode = getPermissionMode();
  const delegateArgs = [...getBareArgs(), '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--permission-mode', delegatePermMode,
    '--allowed-tools', ALLOWED_TOOLS_INTERACTIVE,
    ...(delegateDisallowed ? ['--disallowed-tools', delegateDisallowed] : []),
    '--append-system-prompt', fullPrompt,
    '--agent', targetAgent.name];

  console.log(`[Delegate] convo=${convoId} from=${originalAgentId} to=${targetAgent.id} proc=${delegateProcessId}`);

  const delegateProc = spawnClaude(delegateArgs, {
    cwd: WORKSPACE,
    env: getSpawnEnv(convoId),
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const delegateEntry = {
    process: delegateProc, buffer: '', processId: delegateProcessId,
    agentId: targetAgent.id, responseText: '', exited: false, resultSent: false, idle: false,
    isPlatformDelegate, lastUserMessage: msg.context, receivedFollowUp: false,
    isIntercepted,
    pendingAgentTool: null,
    toolCalls: [], turnStartTime: Date.now(),
    delegation: {
      originalAgentId, originalProcessId,
      originalProcess: isIntercepted ? null : existing.process,
      originalEntry: isIntercepted ? null : existing,
      parentSessionId: isIntercepted ? msg._parentSessionId : null,
      // For sub-delegates (e.g. sub-agent spawned via lead interception): track the orchestrator
      // so out-of-scope returns can skip the mid-level parent and go straight back.
      orchestratorEntry: isIntercepted && existing?.delegation?.originalEntry
        ? existing.delegation.originalEntry : null,
      orchestratorAgentId: isIntercepted && existing?.delegation?.originalAgentId
        ? existing.delegation.originalAgentId : null
    }
  };
  processes.set(convoId, delegateEntry);

  // Notify client of agent switch
  safeSend(JSON.stringify({
    type: 'system', subtype: 'agent_switch', _conversationId: convoId, _processId: delegateProcessId,
    fromAgent: originalAgentId, toAgent: targetAgent.id
  }));
  safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: delegateProcessId, _agent: targetAgent.id }));

  // Send context as first message. Tier 2 for intercepted delegations (orchestrator's
  // brief is sufficient, no transcript). Tier 3 for non-intercepted delegations
  // (preserve full transcript as a safety net).
  const transcript = isIntercepted ? null : formatTranscript(convoId);
  const contextWithHistory = transcript
    ? `CONVERSATION SO FAR:\n${transcript}\n\nYOUR TASK:\n${msg.context}`
    : `[DELEGATION BRIEF]\n${msg.context}`;
  delegateProc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: contextWithHistory } }) + '\n');

  wireProcessHandlers(delegateEntry, convoId, null, {
    enableInterception: true,
    onResult: (e) => {
      const hasOutOfScope = /<!-- RUNDOCK:RETURN -->/.test(e.responseText);
      const hasComplete = /<!-- RUNDOCK:COMPLETE -->/.test(e.responseText);
      const hasCrudMarker = /<!-- RUNDOCK:(?:SAVE|CREATE)_AGENT|<!-- RUNDOCK:DELETE_AGENT|<!-- RUNDOCK:SAVE_SKILL|<!-- RUNDOCK:DELETE_SKILL/.test(e.responseText);
      const hasHandoff = hasOutOfScope || hasComplete;
      const shouldAutoReturn = e.isPlatformDelegate
        ? (hasHandoff || hasCrudMarker)
        : hasHandoff;

      // COMPLETE takes priority when both markers are present.
      if (hasComplete) {
        e.returnMarkerSeen = 'complete';
        if (hasOutOfScope) {
          console.log(`[Delegate] convo=${convoId} agent=${e.agentId} both RETURN and COMPLETE markers detected, treating as COMPLETE (pipeline done)`);
        } else {
          console.log(`[Delegate] convo=${convoId} agent=${e.agentId} COMPLETE marker detected (pipeline done)`);
        }
      } else if (hasOutOfScope) {
        // Platform delegates are transactional: they do the task and return.
        // If a platform delegate emits RETURN but actually did the work (no
        // out-of-scope language in the response), treat it as COMPLETE.
        // This is a server-side safety net for models that ignore the
        // COMPLETE instruction in the delegation context.
        const outOfScopePhrases = /outside (my|what I|this agent's) scope|I can('|no)t help with th|falls outside what I handle|not (something|a task) I (can |)handle|genuinely outside my/i;
        if (e.isPlatformDelegate && !outOfScopePhrases.test(e.responseText)) {
          e.returnMarkerSeen = 'complete';
          console.log(`[Delegate] convo=${convoId} agent=${e.agentId} platform delegate RETURN overridden to COMPLETE (no out-of-scope language detected)`);
        } else {
          e.returnMarkerSeen = 'return';
          console.log(`[Delegate] convo=${convoId} agent=${e.agentId} RETURN marker detected (out-of-scope)`);
        }
      }

      if (shouldAutoReturn) {
        console.log(`[Delegate] Server-side auto-return convo=${convoId} (outOfScope=${hasOutOfScope}, complete=${hasComplete}, crud=${hasCrudMarker})`);
        setTimeout(() => {
          if (!e.exited) {
            try { e.process.kill(); } catch (err) {}
          }
        }, 500);
      }

      e.finalResponseText = e.responseText;
      if (e.responseText) {
            const toolSummary = buildToolSummary(e.toolCalls);
            const textWithTools = toolSummary ? toolSummary + '\n' + e.responseText : e.responseText;
            appendTranscript(convoId, 'agent', e.agentId, textWithTools);
          }
      e.responseText = '';
      e.idle = true;
    }
  });

  delegateProc.on('close', (code) => {
    delegateEntry.exited = true;
    const current = processes.get(convoId);
    if (current !== delegateEntry) return;

    // If cancelled by user, skip all parent restoration logic
    if (delegateEntry.cancelled) {
      console.log(`[Delegate] convo=${convoId} delegate was cancelled, skipping parent restoration`);
      processes.delete(convoId);
      return;
    }

    // Flush remaining buffer
    if (delegateEntry.buffer.trim()) {
      try {
        const parsed = JSON.parse(delegateEntry.buffer);
        parsed._agent = delegateEntry.agentId;
        parsed._conversationId = convoId;
        parsed._processId = delegateProcessId;
        safeSend(JSON.stringify(parsed));
      } catch (e) {}
    }

    // Restore original process
    const orig = delegateEntry.delegation.originalEntry;
    if (delegateEntry.isIntercepted) {
      // Two distinct handoff markers: RETURN means the user asked for something outside
      // the specialist's domain (route to another specialist); COMPLETE means the delegated
      // pipeline finished end-to-end (orchestrator resumes silently).
      let returnMarkerSeen = delegateEntry.returnMarkerSeen || null;
      if (!returnMarkerSeen) {
        const tail = delegateEntry.finalResponseText || delegateEntry.responseText || '';
        const tailHasComplete = /<!-- RUNDOCK:COMPLETE -->/.test(tail);
        const tailHasReturn = /<!-- RUNDOCK:RETURN -->/.test(tail);
        // COMPLETE takes priority (same logic as onResult handler)
        if (tailHasComplete) returnMarkerSeen = 'complete';
        else if (tailHasReturn) returnMarkerSeen = 'return';
      }
      const hasHandoffMarker = !!returnMarkerSeen;
      const isOutOfScope = returnMarkerSeen === 'return';
      const isPipelineComplete = returnMarkerSeen === 'complete';
      const orchestratorEntry = delegateEntry.delegation.orchestratorEntry;
      const orchestratorAgentId = delegateEntry.delegation.orchestratorAgentId;

      console.log(`[AgentIntercept] convo=${convoId} close handler: isIntercepted=${delegateEntry.isIntercepted} marker=${returnMarkerSeen || 'none'} hasOrchestratorEntry=${!!orchestratorEntry} orchestratorExited=${orchestratorEntry?.exited}`);

      if (hasHandoffMarker && orchestratorEntry && !orchestratorEntry.exited) {
        // Skip mid-level parent, return directly to orchestrator
        console.log(`[AgentIntercept] convo=${convoId} sub-delegate handed back (${returnMarkerSeen}), skipping ${delegateEntry.delegation.originalAgentId}, restoring orchestrator ${orchestratorAgentId}`);

        orchestratorEntry.idle = true;
        orchestratorEntry.delegation = null;
        processes.set(convoId, orchestratorEntry);

        safeSend(JSON.stringify({
          type: 'system', subtype: 'agent_switch', _conversationId: convoId,
          fromAgent: delegateEntry.agentId, toAgent: orchestratorAgentId
        }));

        // COMPLETE gate: when the specialist finished the delegated pipeline,
        // do NOT auto-resume the orchestrator. Leave it idle so the user sees
        // the specialist's output and decides what to do next.
        if (isPipelineComplete) {
          console.log(`[AgentIntercept] convo=${convoId} COMPLETE gate: specialist ${delegateEntry.agentId} finished, orchestrator ${orchestratorAgentId} stays idle`);
        } else if (orchestratorEntry.process.stdin && orchestratorEntry.process.stdin.writable && !orchestratorEntry.process.killed) {
          // RETURN path: auto-continue to route the pending request to another specialist
          const resumeCount = incrementAutoResume(convoId);
          if (resumeCount >= MAX_CONSECUTIVE_AGENT_RESUMES) {
            console.log(`[CircuitBreaker] convo=${convoId} ${resumeCount} consecutive agent resumes, pausing orchestrator`);
            resetAutoResume(convoId);
            safeSend(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: `[Auto-paused: ${resumeCount} consecutive agent handoffs without user input. Agents involved: ${delegateEntry.agentId} → ${orchestratorAgentId}. Please review the output above and send your next message to continue.]` }, _agent: orchestratorAgentId, _conversationId: convoId }));
          } else {
            const pendingRequest = delegateEntry.lastUserMessage || '';
            setTimeout(() => {
              if (!orchestratorEntry.exited) {
                console.log(`[AgentIntercept] convo=${convoId} auto-continuing orchestrator after skip-level ${returnMarkerSeen} (resume ${resumeCount}/${MAX_CONSECUTIVE_AGENT_RESUMES})`);
                orchestratorEntry.responseText = '';
                orchestratorEntry.idle = false;
                safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: orchestratorEntry.processId, _agent: orchestratorAgentId, autoContinue: true }));
                const prompt = pendingRequest
                  ? `[SYSTEM: A specialist just returned because the user asked for something outside their scope. The user's pending request is: "${pendingRequest}"\n\nRoute this request now. Delegate to the right specialist if one fits, or handle it yourself. Do not summarise what the previous specialist did. Do not ask the user to repeat themselves. Respond to their request.]`
                  : '[SYSTEM: A specialist just returned. Ask the user what they need next.]';
                try {
                  orchestratorEntry.process.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
                } catch (err) {
                  console.warn(`[AgentIntercept] convo=${convoId} failed to write to orchestrator stdin: ${err.message}`);
                }
              }
            }, 300);
          }
        }

        safeSend(JSON.stringify({ type: 'system', subtype: 'done', code, _agent: delegateEntry.agentId, _conversationId: convoId, _processId: delegateProcessId }));
        return;
      }

      // Intercepted return: restart mid-level parent with --resume
      const parentAgentId = delegateEntry.delegation.originalAgentId;
      const parentSessionId = delegateEntry.delegation.parentSessionId;
      console.log(`[AgentIntercept] convo=${convoId} delegate done, restarting parent ${parentAgentId} (session=${parentSessionId}) marker=${returnMarkerSeen || 'none'}`);

      safeSend(JSON.stringify({
        type: 'system', subtype: 'agent_switch', _conversationId: convoId,
        fromAgent: delegateEntry.agentId, toAgent: parentAgentId
      }));

      const parentAgentList = discoverAgents();
      const parentAgentData = parentAgentList.find(a => a.id === parentAgentId || a.name === parentAgentId);
      const parentSystemPrompt = parentAgentData ? buildSystemPrompt(parentAgentData) : '';

      const resumeDisallowed = getDisallowedTools();
      const resumePermMode = getPermissionMode();
      const resumeArgs = [...getBareArgs(), '--output-format', 'stream-json', '--input-format', 'stream-json',
        '--verbose', '--include-partial-messages', '--permission-mode', resumePermMode,
        '--allowed-tools', ALLOWED_TOOLS_INTERACTIVE,
        ...(resumeDisallowed ? ['--disallowed-tools', resumeDisallowed] : [])];
      if (parentSystemPrompt) resumeArgs.push('--append-system-prompt', parentSystemPrompt);
      if (parentAgentData?.name) resumeArgs.push('--agent', parentAgentData.name);
      if (parentSessionId) resumeArgs.push('--resume', parentSessionId);

      const resumeProcessId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const resumeProc = spawnClaude(resumeArgs, {
        cwd: WORKSPACE,
        env: getSpawnEnv(convoId),
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const resumeEntry = {
        process: resumeProc, buffer: '', processId: resumeProcessId,
        agentId: parentAgentId, responseText: '', exited: false, resultSent: false,
        pendingAgentTool: null,
        toolCalls: [], turnStartTime: Date.now(),
        // Tag with returning specialist so handleDelegation's scopeReturnSource
        // guard blocks immediate re-delegation to the same agent. Only set for
        // out-of-scope returns; pipeline-complete should allow re-delegation.
        scopeReturnSource: isOutOfScope ? delegateEntry.agentId : null
      };
      processes.set(convoId, resumeEntry);

      // Auto-prompt only on out-of-scope: parent is resumed with a routing request so
      // it can delegate the pending user message to a different specialist. For
      // pipeline-complete and no-marker exits, the parent restarts silently and waits
      // for the user's next message. In the single-level case (delegate was direct
      // from the orchestrator, so the parent IS the orchestrator), this is all that's
      // needed. In deeper chains, the pipeline-complete marker would have fired the
      // skip-level orchestratorEntry branch above and never reached this code path.
      if (isOutOfScope) {
        const resumeCount = incrementAutoResume(convoId);
        if (resumeCount >= MAX_CONSECUTIVE_AGENT_RESUMES) {
          console.log(`[CircuitBreaker] convo=${convoId} ${resumeCount} consecutive agent resumes on parked-parent RETURN path, pausing`);
          resetAutoResume(convoId);
          resumeEntry.idle = true;
          safeSend(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: `[Auto-paused: ${resumeCount} consecutive agent handoffs without user input. Last specialist: ${delegateEntry.agentId}. Please review the output above and send your next message to continue.]` }, _agent: delegateEntry.delegation.originalAgentId, _conversationId: convoId }));
        } else {
          safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: resumeProcessId, _agent: parentAgentId, autoContinue: true }));

          // Tier 1: routing prompt only. The parent is being resumed via --resume,
          // which restores session context from disk. No transcript needed.
          const resumePrompt = `[SYSTEM: Your team member returned because the user asked for something outside their scope. The user's latest request was: "${delegateEntry.lastUserMessage || 'continue'}"\n\nRoute this request to the right specialist. Do not ask the user to repeat themselves.]`;
          resumeProc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: resumePrompt } }) + '\n');
        }
      } else if (isPipelineComplete) {
        resumeEntry.idle = true;
        console.log(`[AgentIntercept] convo=${convoId} delegate emitted COMPLETE, parent ${parentAgentId} parked silently`);
      } else {
        resumeEntry.idle = true;
        console.log(`[AgentIntercept] convo=${convoId} delegate completed normally, parent ${parentAgentId} parked (no auto-prompt)`);
      }

      wireProcessHandlers(resumeEntry, convoId, null, {
        enableInterception: true,
        onResult: (e) => {
          // Detect both handoff markers on a parked-and-resumed parent. scopeReturnMode
          // records which one fired so the close handler can route correctly: 'return'
          // means route the pending request to a different specialist, 'complete' means
          // the delegated pipeline is finished and the orchestrator should resume silently.
          const hasOutOfScope = /<!-- RUNDOCK:RETURN -->/.test(e.responseText);
          const hasComplete = /<!-- RUNDOCK:COMPLETE -->/.test(e.responseText);
          if ((hasOutOfScope || hasComplete) && !e.delegation) {
            e.scopeReturn = true;
            // COMPLETE takes priority when both markers are present
            e.scopeReturnMode = hasComplete ? 'complete' : 'return';
            console.log(`[ScopeReturn] convo=${convoId} agent=${e.agentId} ${e.scopeReturnMode} marker on resumed parent`);
            setTimeout(() => {
              if (!e.exited) {
                try { e.process.kill(); } catch (err) {}
              }
            }, 500);
          }
          if (e.responseText) {
            const toolSummary = buildToolSummary(e.toolCalls);
            const textWithTools = toolSummary ? toolSummary + '\n' + e.responseText : e.responseText;
            appendTranscript(convoId, 'agent', e.agentId, textWithTools);
          }
          e.responseText = '';
          e.idle = true;
        }
      });
      resumeProc.on('close', (rCode) => {
        resumeEntry.exited = true;
        const cur = processes.get(convoId);

        // If the resumed parent itself emitted a handoff marker, route through
        // handleScopeReturn. The mode selects the downstream prompt: 'return' produces
        // a routing-request prompt to the orchestrator, 'complete' produces the
        // silent-exit prompt that prevents re-delegation and narration.
        if (resumeEntry.scopeReturn && cur === resumeEntry) {
          const wasComplete = resumeEntry.scopeReturnMode === 'complete';
          console.log(`[ScopeReturn] convo=${convoId} resumed parent ${resumeEntry.agentId} exited with ${resumeEntry.scopeReturnMode} marker, spawning orchestrator (pipelineComplete=${wasComplete})`);
          handleScopeReturn(resumeEntry, convoId, wasComplete);
          return;
        }

        if (cur === resumeEntry) processes.delete(convoId);
        safeSend(JSON.stringify({ type: 'system', subtype: 'done', code: rCode, _agent: resumeEntry.agentId, _conversationId: convoId, _processId: resumeProcessId }));
      });

    } else if (orig && !orig.exited) {
      orig.idle = true;
      orig.delegation = null;
      processes.set(convoId, orig);
      console.log(`[Delegate] convo=${convoId} delegate exited, restored ${delegateEntry.delegation.originalAgentId}`);
      safeSend(JSON.stringify({
        type: 'system', subtype: 'agent_switch', _conversationId: convoId,
        fromAgent: delegateEntry.agentId, toAgent: delegateEntry.delegation.originalAgentId
      }));

      if (!delegateEntry.isPlatformDelegate && delegateEntry.receivedFollowUp && orig.process.stdin && orig.process.stdin.writable) {
        const resumeCount = incrementAutoResume(convoId);
        if (resumeCount >= MAX_CONSECUTIVE_AGENT_RESUMES) {
          console.log(`[CircuitBreaker] convo=${convoId} ${resumeCount} consecutive agent resumes on delegate return path, pausing`);
          resetAutoResume(convoId);
          orig.idle = true;
          safeSend(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: `[Auto-paused: ${resumeCount} consecutive agent handoffs without user input. Last specialist: ${delegateEntry.agentId}. Please review the output above and send your next message to continue.]` }, _agent: orig.agentId, _conversationId: convoId }));
        } else {
          const pendingRequest = delegateEntry.lastUserMessage || '';
          setTimeout(() => {
            if (!orig.exited) {
              console.log(`[Delegate] convo=${convoId} auto-continuing orchestrator after specialist return (resume ${resumeCount}/${MAX_CONSECUTIVE_AGENT_RESUMES})`);
              orig.responseText = '';
              orig.idle = false;
              safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: orig.processId, _agent: orig.agentId, autoContinue: true }));
              const prompt = pendingRequest
                ? `[SYSTEM: The specialist just returned because the user asked for something outside their scope. The user's pending request is: "${pendingRequest}"\n\nRoute this request now. Delegate to the right specialist if one fits, or handle it yourself. Do not summarise what the previous specialist did. Do not ask the user to repeat themselves. Respond to their request.]`
                : '[SYSTEM: The specialist just returned. The user indicated they were done with that specialist. Ask the user what they need next.]';
              try {
                orig.process.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
              } catch (err) {
                console.warn(`[Delegate] convo=${convoId} failed to write to orchestrator stdin: ${err.message}`);
              }
            }
          }, 300);
        }
      }
    } else {
      processes.delete(convoId);
      console.log(`[Delegate] convo=${convoId} delegate exited, original process gone`);
    }
    safeSend(JSON.stringify({ type: 'system', subtype: 'done', code, _agent: delegateEntry.agentId, _conversationId: convoId, _processId: delegateProcessId }));
  });
}

wss.on('connection', (ws) => {
  console.log('Client connected');
  connectedClients.add(ws);
  ws._alive = true;
  ws.on('pong', () => { ws._alive = true; });

  // Tell this client about any active processes so it can restore thinking indicators.
  // Always send this message, even when empty, so the client can reconcile stale state.
  const active = [];
  for (const [convoId, entry] of chatProcesses) {
    if (entry.idle) continue; // Don't report idle processes as active
    active.push({ conversationId: convoId, processId: entry.processId, agentId: entry.agentId, responseText: entry.responseText || '', delegation: entry.delegation ? { originalAgentId: entry.delegation.originalAgentId } : null });
  }
  ws.send(JSON.stringify({ type: 'active_processes', processes: active }));
  ws.send(JSON.stringify({ type: 'server_info', version: PKG_VERSION }));

  // Re-send pending permission requests so permission cards reappear after reconnect
  for (const [requestId, pending] of pendingPermissionRequests) {
    ws.send(JSON.stringify({
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'can_use_tool',
        tool_name: pending.toolName,
        input: pending.toolInput || {}
      },
      _conversationId: pending.conversationId
    }));
  }

  // Alias for handlers that still reference local `processes`
  const processes = chatProcesses;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'chat') {
        const convoId = msg.conversationId || 'default';
        const useLegacy = process.env.RUNDOCK_LEGACY_SPAWN === '1';

        // Track user messages in conversation transcript
        appendTranscript(convoId, 'user', 'user', msg.content);

        // ── INTERACTIVE MODE (Deliverable A) ──────────────────────────
        // Process stays alive between messages. Follow-ups push to stdin.
        // --print is NOT used; Claude Code runs in interactive stream-json mode.
        if (!useLegacy) {

          // If a live process exists for this conversation, push the follow-up to its stdin
          let existing = processes.get(convoId);

          // If the orchestrator's team roster is stale (agent/skill CRUD happened),
          // kill the process so it respawns with a fresh system prompt via --resume.
          if (existing && !existing.exited && existing.needsRosterRefresh) {
            console.log(`[Roster] convo=${convoId} killing stale orchestrator for roster refresh`);
            try { existing.process.kill(); } catch (e) {}
            processes.delete(convoId);
            existing = null; // Force fall-through to spawn path
          }

          if (existing && !existing.exited && existing.process.stdin && existing.process.stdin.writable) {
            const processId = existing.processId;
            console.log(`[Chat] convo=${convoId} proc=${processId} FOLLOW-UP (interactive stdin)`);
            safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: processId, _agent: existing.agentId }));
            existing.responseText = '';
            existing.idle = false;
            existing.toolCalls = [];
            existing.turnStartTime = Date.now();
            existing.lastUserMessage = msg.content;
            existing.scopeReturnSource = null; // User sent new message, allow re-delegation
            resetAutoResume(convoId); // User spoke, reset circuit breaker
            if (existing.delegation) { existing.receivedFollowUp = true; }
            existing.process.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: msg.content } }) + '\n');
          } else {
            // No live process: spawn a new one (first message or after disconnect)
            // Kill stale entry if present
            if (existing) {
              try { existing.process.kill(); } catch (e) { /* already dead */ }
              processes.delete(convoId);
            }

            const processId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

            // Interactive chat: bidirectional stream-json, no --print.
            // Permission flow: PreToolUse hooks (configured in workspace .claude/settings.local.json)
            // catch Bash commands and MCP tools, POST to /api/permission-request, Rundock shows a
            // permission card in the browser, user clicks Allow/Deny, hook returns the decision to
            // Claude Code. Read-only and knowledge-work tools are in allowed-tools (auto-approved, no card).

            // Look up agent data first so we can build a dynamic system prompt
            const agentList = discoverAgents();
            const requestedAgent = msg.agent || 'default';
            const agentData = agentList.find(a => a.id === requestedAgent)
              || agentList.find(a => a.fileName && a.fileName.replace('.md', '') === requestedAgent);

            const systemPrompt = buildSystemPrompt(agentData);
            const chatDisallowed = getDisallowedTools();
            const chatPermMode = getPermissionMode();

            const args = [...getBareArgs(), '--output-format', 'stream-json', '--input-format', 'stream-json',
              '--verbose', '--include-partial-messages', '--permission-mode', chatPermMode,
              '--allowed-tools', ALLOWED_TOOLS_INTERACTIVE,
              ...(chatDisallowed ? ['--disallowed-tools', chatDisallowed] : []),
              '--append-system-prompt', systemPrompt];

            // Resume existing session if we have a session ID
            if (msg.sessionId) {
              args.push('--resume', msg.sessionId);
            }

            // Pass --agent with the slug name (first message only, not on resume)
            if (!msg.sessionId && agentData && agentData.fileName) {
              args.push('--agent', agentData.name);
            }

            console.log(`[Chat] convo=${convoId} proc=${processId} agent=${msg.agent} sessionId=${msg.sessionId||'new'} mode=interactive args=${args.filter(a=>a.startsWith('--')).join(' ')}`);

            const proc = spawnClaude(args, {
              cwd: WORKSPACE,
              env: getSpawnEnv(convoId),
              stdio: ['pipe', 'pipe', 'pipe']
            });

            const entry = {
              process: proc, buffer: '', processId, agentId: msg.agent || 'default',
              responseText: '', exited: false, resultSent: false,
              lastUserMessage: msg.content,
              // Agent tool interception state
              pendingAgentTool: null,  // { blockIndex, inputJson: '' }
              toolCalls: [], turnStartTime: Date.now()
            };
            processes.set(convoId, entry);

            safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: processId, _agent: entry.agentId }));

            // Send the first message via stdin
            proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: msg.content } }) + '\n');

            const stderrRef = wireProcessHandlers(entry, convoId, ws, {
              enableInterception: true,
              onResult: (e) => {
                // Detect scope return on a directly-started specialist. Either marker
                // triggers a handoff to the orchestrator; scopeReturnMode selects the
                // downstream behaviour (routing request vs silent exit).
                const hasOutOfScope = /<!-- RUNDOCK:RETURN -->/.test(e.responseText);
                const hasComplete = /<!-- RUNDOCK:COMPLETE -->/.test(e.responseText);
                if ((hasOutOfScope || hasComplete) && !e.delegation) {
                  e.scopeReturn = true;
                  e.scopeReturnMode = hasOutOfScope ? 'return' : 'complete';
                  console.log(`[ScopeReturn] convo=${convoId} agent=${e.agentId} ${e.scopeReturnMode} marker on non-delegated process`);
                  setTimeout(() => {
                    if (!e.exited) {
                      try { e.process.kill(); } catch (err) {}
                    }
                  }, 500);
                }
                if (e.responseText) {
            const toolSummary = buildToolSummary(e.toolCalls);
            const textWithTools = toolSummary ? toolSummary + '\n' + e.responseText : e.responseText;
            appendTranscript(convoId, 'agent', e.agentId, textWithTools);
          }
                e.responseText = '';
                e.idle = true;
              }
            });

            proc.on('close', (code) => {
              entry.exited = true;
              const current = processes.get(convoId);
              if (current && current.processId !== processId) return;

              // Scope return: specialist wants to hand off to orchestrator.
              // Pass wasPipelineComplete=true only when the specialist explicitly
              // signalled pipeline completion; out-of-scope returns get the routing prompt.
              if (entry.scopeReturn) {
                const wasComplete = entry.scopeReturnMode === 'complete';
                console.log(`[ScopeReturn] convo=${convoId} specialist ${entry.agentId} exited (${entry.scopeReturnMode}), spawning orchestrator (pipelineComplete=${wasComplete})`);
                handleScopeReturn(entry, convoId, wasComplete);
                return;
              }

              // Detect stale session and retry fresh
              const isResumeFailure = msg.sessionId && !msg._resumeRetry && code !== 0 &&
                (stderrRef.value.includes('session') || stderrRef.value.includes('resume') || stderrRef.value.includes('not found'));
              if (isResumeFailure) {
                console.log(`[Chat] Resume failed for session ${msg.sessionId}, retrying fresh`);
                processes.delete(convoId);
                safeSend(JSON.stringify({ type: 'system', subtype: 'info', content: 'Previous session expired. Starting fresh.', _conversationId: convoId, _processId: processId }));
                const freshMsg = { ...msg, sessionId: null, _resumeRetry: true };
                const liveWs = [...connectedClients].find(c => c.readyState === 1) || ws;
                liveWs.emit('message', JSON.stringify(freshMsg));
                return;
              }

              // Flush remaining buffer
              if (entry.buffer.trim()) {
                try {
                  const parsed = JSON.parse(entry.buffer);
                  parsed._agent = entry.agentId;
                  parsed._conversationId = convoId;
                  parsed._processId = processId;
                  safeSend(JSON.stringify(parsed));
                } catch (e) {
                  safeSend(JSON.stringify({ type: 'raw', content: entry.buffer, _conversationId: convoId, _processId: processId }));
                }
              }

              // Process exited in interactive mode. Send done so client unblocks (unless result or cancel already sent it).
              console.log(`[Chat] convo=${convoId} proc=${processId} process exited code=${code} (interactive) cancelled=${!!entry.cancelled}`);
              if (!entry.resultSent && !entry.cancelled) {
                safeSend(JSON.stringify({ type: 'system', subtype: 'done', code, _agent: entry.agentId, _conversationId: convoId, _processId: processId }));
              }
              processes.delete(convoId);
            });
          }

        // ── LEGACY MODE (--print, one process per message) ────────────
        } else {
          const processId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

          // Kill existing process for this conversation only
          if (processes.has(convoId)) {
            processes.get(convoId).process.kill();
            processes.delete(convoId);
          }

          const legacyDisallowed = getDisallowedTools();
          const legacyPermMode = getPermissionMode();
          const args = [...getBareArgs(), '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
            '--verbose', '--include-partial-messages', '--permission-mode', legacyPermMode,
            '--allowed-tools', ALLOWED_TOOLS_LEGACY,
            ...(legacyDisallowed ? ['--disallowed-tools', legacyDisallowed] : []),
            '--append-system-prompt', 'FORMATTING RULES (mandatory, apply to all output):\n- NEVER use em dashes (—) or en dashes (–) anywhere. This includes lists, headers, separators, and inline text. Wrong: "AI — your assistant". Right: "AI: your assistant". Use colons, full stops, commas, or restructure instead.\n- Use UK spelling throughout.\n\nPLATFORM RULES:\nRundock is a knowledge management platform. You can create and edit markdown, YAML, JSON, and text files. Executable code files (.js, .ts, .py, .sh, etc.) are outside the supported file types. Destructive commands (rm, sudo, chmod) are not supported. If a user asks you to do something outside these capabilities, explain that Rundock is designed for knowledge work and suggest an alternative approach using supported file types.'];

          if (msg.sessionId) {
            args.push('--resume', msg.sessionId);
          }

          if (!msg.sessionId) {
            const agentList = discoverAgents();
            const requestedAgent = msg.agent || 'default';
            const agentData = agentList.find(a => a.id === requestedAgent)
              || agentList.find(a => a.fileName && a.fileName.replace('.md', '') === requestedAgent);
            if (agentData && agentData.fileName) {
              args.push('--agent', agentData.name);
            }
          }

          console.log(`[Chat] convo=${convoId} proc=${processId} agent=${msg.agent} sessionId=${msg.sessionId||'new'} mode=legacy args=${args.filter(a=>a.startsWith('--')).join(' ')}`);

          const proc = spawnClaude(args, {
            cwd: WORKSPACE,
            env: getSpawnEnv(convoId),
            stdio: ['pipe', 'pipe', 'pipe']
          });

          const entry = { process: proc, buffer: '', processId, agentId: msg.agent || 'default', responseText: '', exited: false, resultSent: false, lastUserMessage: msg.content, toolCalls: [], turnStartTime: Date.now() };
          processes.set(convoId, entry);

          safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: processId, _agent: entry.agentId }));

          proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: msg.content } }) + '\n');

          // Legacy mode: no interception, no transcript, no idle tracking
          const legacyStderrRef = wireProcessHandlers(entry, convoId, ws, {
            enableInterception: false
          });

          proc.on('close', (code) => {
            entry.exited = true;
            const current = processes.get(convoId);
            if (current && current.processId !== processId) return;

            const isResumeFailure = msg.sessionId && !msg._resumeRetry && code !== 0 &&
              (legacyStderrRef.value.includes('session') || legacyStderrRef.value.includes('resume') || legacyStderrRef.value.includes('not found'));
            if (isResumeFailure) {
              console.log(`[Chat] Resume failed for session ${msg.sessionId}, retrying fresh`);
              processes.delete(convoId);
              safeSend(JSON.stringify({ type: 'system', subtype: 'info', content: 'Previous session expired. Starting fresh.', _conversationId: convoId, _processId: processId }));
              const freshMsg = { ...msg, sessionId: null, _resumeRetry: true };
              const liveWs = [...connectedClients].find(c => c.readyState === 1) || ws;
              liveWs.emit('message', JSON.stringify(freshMsg));
              return;
            }

            if (entry.buffer.trim()) {
              try {
                const parsed = JSON.parse(entry.buffer);
                parsed._agent = entry.agentId;
                parsed._conversationId = convoId;
                parsed._processId = processId;
                safeSend(JSON.stringify(parsed));
              } catch (e) {
                safeSend(JSON.stringify({ type: 'raw', content: entry.buffer, _conversationId: convoId, _processId: processId }));
              }
            }
            if (!entry.resultSent && !entry.cancelled) {
              safeSend(JSON.stringify({ type: 'system', subtype: 'done', code, _agent: entry.agentId, _conversationId: convoId, _processId: processId }));
            }
            processes.delete(convoId);
          });
        }
      }

      // Permission response: user approved/denied a tool in the browser UI.
      // Resolves the pending HTTP long-poll from the PreToolUse hook script.
      if (msg.type === 'permission_response') {
        const pending = pendingPermissionRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingPermissionRequests.delete(msg.requestId);
          pending.res.writeHead(200, { 'Content-Type': 'application/json' });
          pending.res.end(JSON.stringify({ allow: msg.allow }));
          console.log(`[Permission] convo=${msg.conversationId} requestId=${msg.requestId} decision=${msg.allow ? 'allow' : 'deny'}`);
        } else {
          console.warn(`[Permission] No pending request for requestId=${msg.requestId} (expired or already resolved)`);
        }
      }

      // ── CANCEL: User interrupts a running agent ────────────
      if (msg.type === 'cancel') {
        const convoId = msg.conversationId;
        const entry = chatProcesses.get(convoId);
        if (!entry || entry.exited) {
          console.log(`[Cancel] convo=${convoId} no active process to cancel`);
        } else if (entry.idle) {
          console.log(`[Cancel] convo=${convoId} process is idle, nothing to cancel`);
        } else {
          console.log(`[Cancel] convo=${convoId} proc=${entry.processId} agent=${entry.agentId} killing`);

          // Auto-deny any pending permission requests for this conversation
          for (const [reqId, pending] of pendingPermissionRequests) {
            if (pending.conversationId === convoId) {
              clearTimeout(pending.timer);
              pendingPermissionRequests.delete(reqId);
              try {
                pending.res.writeHead(200, { 'Content-Type': 'application/json' });
                pending.res.end(JSON.stringify({ allow: false, reason: 'cancelled' }));
              } catch (e) {}
            }
          }

          // Mark as cancelled so delegation close handlers skip parent restoration
          entry.cancelled = true;
          entry.exited = true;

          // Send cancelled event before kill so client gets it before the done event
          safeSend(JSON.stringify({
            type: 'system', subtype: 'cancelled',
            _conversationId: convoId, _processId: entry.processId, _agent: entry.agentId,
            _toolCalls: entry.toolCalls || [], _turnStartTime: entry.turnStartTime || null
          }));

          // Kill the active process
          try { entry.process.kill('SIGTERM'); } catch (e) {}
          // Safety net: SIGKILL after 2 seconds
          setTimeout(() => {
            try { entry.process.kill('SIGKILL'); } catch (e) {}
          }, 2000);

          // If this is a delegate, also kill the parked parent(s)
          if (entry.delegation) {
            const orig = entry.delegation.originalEntry;
            if (orig && !orig.exited) {
              orig.exited = true;
              orig.cancelled = true;
              try { orig.process.kill('SIGTERM'); } catch (e) {}
              setTimeout(() => { try { orig.process.kill('SIGKILL'); } catch (e) {} }, 2000);
              console.log(`[Cancel] convo=${convoId} also killed parked parent agent=${orig.agentId}`);
            }
            // Also kill the orchestrator if it was a multi-level delegation
            const orch = entry.delegation.orchestratorEntry;
            if (orch && orch !== orig && !orch.exited) {
              orch.exited = true;
              orch.cancelled = true;
              try { orch.process.kill('SIGTERM'); } catch (e) {}
              setTimeout(() => { try { orch.process.kill('SIGKILL'); } catch (e) {} }, 2000);
              console.log(`[Cancel] convo=${convoId} also killed parked orchestrator`);
            }
          }

          // Clean up from the map immediately (close handler will also try but we guard with exited flag)
          chatProcesses.delete(convoId);

          // Send done so client unblocks
          safeSend(JSON.stringify({
            type: 'system', subtype: 'done', code: null,
            _conversationId: convoId, _processId: entry.processId, _agent: entry.agentId
          }));
        }
      }

      if (msg.type === 'get_workspaces') {
        const wsData = {
          type: 'workspaces',
          current: WORKSPACE,
          recent: loadRecentWorkspaces(),
          discovered: discoverWorkspaces()
        };
        if (WORKSPACE) {
          try { wsData.analysis = analyzeWorkspace(WORKSPACE, discoverAgents()); } catch (e) { console.warn('  Workspace analysis failed:', e.message); }
          try { const st = readState(); wsData.workspaceMode = st.workspaceMode || 'knowledge'; wsData.setupComplete = !!st.setupComplete; } catch (e) { /* default */ }
        }
        ws.send(JSON.stringify(wsData));
      }

      if (msg.type === 'list_workspaces') {
        ws.send(JSON.stringify({
          type: 'workspaces',
          recent: loadRecentWorkspaces(),
          discovered: discoverWorkspaces()
        }));
      }

      if (msg.type === 'set_workspace') {
        const dir = msg.path;
        if (dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
          // Kill all running processes when switching workspace
          killAllChildren();
          WORKSPACE = dir;
          saveRecentWorkspace(dir);
          // Clean up orphaned processes from previous sessions in this workspace
          cleanOrphanedProcesses();

          // Detect empty workspace before scaffolding (scaffoldWorkspace adds Doc/skills)
          let agentList = [];
          try { agentList = discoverAgents(); } catch (e) { console.warn('  Agent discovery failed:', e.message); }
          const isEmpty = isEmptyWorkspace(dir, agentList);

          // Empty workspace: scaffold default folders and CLAUDE.md
          let scaffoldError = null;
          if (isEmpty) {
            const result = scaffoldDefaults(dir);
            if (!result.success) scaffoldError = result.error;
            invalidateAgentCache();
          }

          try { scaffoldWorkspace(dir); } catch (e) { console.warn('Scaffold warning:', e.message); }
          console.log(`  Workspace changed to: ${WORKSPACE} (empty=${isEmpty})`);

          // Re-discover agents after scaffolding
          try { agentList = discoverAgents(); } catch (e) { console.warn('  Agent discovery failed:', e.message); }

          // Auto-detect and store workspace mode
          const state = readState();
          if (!state.workspaceMode) {
            state.workspaceMode = detectWorkspaceMode(dir);
            writeState(state);
            console.log(`  Workspace mode auto-detected: ${state.workspaceMode}`);
          }

          let analysis = null;
          try { analysis = analyzeWorkspace(dir, agentList); } catch (e) { console.warn('  Workspace analysis failed:', e.message); }
          ws.send(JSON.stringify({ type: 'workspace_set', path: WORKSPACE, analysis, isEmpty, workspaceMode: state.workspaceMode, setupComplete: !!state.setupComplete, scaffoldError }));
          ws.send(JSON.stringify({ type: 'agents', agents: agentList }));
          try { ws.send(JSON.stringify({ type: 'file_tree', tree: getFileTree(WORKSPACE) })); } catch (e) { console.warn('  File tree failed:', e.message); }
        } else {
          ws.send(JSON.stringify({ type: 'workspace_error', message: 'Directory not found' }));
        }
      }

      if (msg.type === 'pick_folder') {
        try {
          const { execSync } = require('child_process');
          const result = execSync(
            `osascript -e 'POSIX path of (choose folder with prompt "Choose a workspace folder")'`,
            { encoding: 'utf-8', timeout: 60000 }
          ).trim();
          if (result) {
            // Remove trailing slash if present
            const dir = result.endsWith('/') ? result.slice(0, -1) : result;
            ws.send(JSON.stringify({ type: 'folder_picked', path: dir }));
          } else {
            ws.send(JSON.stringify({ type: 'folder_picked', path: null }));
          }
        } catch (e) {
          // User cancelled or osascript failed
          ws.send(JSON.stringify({ type: 'folder_picked', path: null }));
        }
      }

      if (msg.type === 'create_workspace') {
        const rawName = (msg.name || '').replace(/[\/\\:*?"<>|]/g, '').trim();
        if (!rawName) {
          ws.send(JSON.stringify({ type: 'workspace_error', message: 'Please enter a workspace name' }));
        } else {
          const home = process.env.HOME || process.env.USERPROFILE || '';
          const dir = path.join(home, 'Documents', 'Rundock', rawName);
          try {
            fs.mkdirSync(dir, { recursive: true });
            fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
            // Kill all running processes when creating/switching workspace
            killAllChildren();
            WORKSPACE = dir;
            saveRecentWorkspace(dir);

            // New workspace is always empty: scaffold defaults
            let scaffoldError = null;
            const result = scaffoldDefaults(dir);
            if (!result.success) scaffoldError = result.error;

            try { scaffoldWorkspace(dir); } catch (e) { console.warn('Scaffold warning:', e.message); }
            console.log(`  Workspace created: ${WORKSPACE}`);

            const agentList = discoverAgents();
            const analysis = analyzeWorkspace(dir, agentList);

            // Auto-detect and store workspace mode
            const state = readState();
            state.workspaceMode = detectWorkspaceMode(dir);
            writeState(state);

            ws.send(JSON.stringify({ type: 'workspace_set', path: WORKSPACE, analysis, isEmpty: true, workspaceMode: state.workspaceMode, setupComplete: false, scaffoldError }));
            ws.send(JSON.stringify({ type: 'agents', agents: agentList }));
            ws.send(JSON.stringify({ type: 'file_tree', tree: getFileTree(WORKSPACE) }));
          } catch (e) {
            ws.send(JSON.stringify({ type: 'workspace_error', message: 'Could not create workspace: ' + e.message }));
          }
        }
      }

      if (msg.type === 'get_agents') {
        if (!WORKSPACE) { ws.send(JSON.stringify({ type: 'needs_workspace' })); return; }
        let agentList = [];
        try { agentList = discoverAgents(); } catch (e) { console.warn('  Agent discovery failed:', e.message); }
        ws.send(JSON.stringify({ type: 'agents', agents: agentList }));
      }
      if (msg.type === 'get_files') {
        if (!WORKSPACE) return;
        try { ws.send(JSON.stringify({ type: 'file_tree', tree: getFileTree(WORKSPACE) })); } catch (e) { console.warn('  File tree failed:', e.message); }
      }
      if (msg.type === 'get_skills') {
        let skillList = [];
        try { skillList = discoverSkills(); } catch (e) { console.warn('  Skill discovery failed:', e.message); }
        ws.send(JSON.stringify({ type: 'skills', skills: skillList }));
      }

      // ===== WORKSPACE MODE =====

      if (msg.type === 'set_workspace_mode') {
        const mode = msg.mode;
        if (mode !== 'code' && mode !== 'knowledge') {
          ws.send(JSON.stringify({ type: 'workspace_error', message: 'Invalid workspace mode' }));
        } else {
          try {
            const state = readState();
            state.workspaceMode = mode;
            writeState(state);
            console.log(`  Workspace mode changed to: ${mode}`);
            ws.send(JSON.stringify({ type: 'workspace_mode_changed', mode }));
          } catch (e) {
            ws.send(JSON.stringify({ type: 'workspace_error', message: 'Could not update workspace mode: ' + e.message }));
          }
        }
      }

      // ===== SESSION PERSISTENCE =====

      if (msg.type === 'get_conversations') {
        if (!WORKSPACE) return;
        // Clean up empty conversations (no sessionId means no message was ever sent)
        // Only remove if older than 5 minutes to avoid race with sessionId assignment
        const convos = readConversations();
        const fiveMinAgo = Date.now() - 5 * 60 * 1000;
        const cleaned = convos.filter(c => c.sessionId || new Date(c.lastActiveAt || c.createdAt).getTime() > fiveMinAgo);
        if (cleaned.length < convos.length) writeConversations(cleaned);
        // Enrich activeAgentId from transcript so sidebar shows correct agent on load
        for (const c of cleaned) {
          const transcript = loadTranscript(c.id);
          if (transcript && transcript.length > 0) {
            const lastAssistant = [...transcript].reverse().find(t => t.role !== 'user' && t.agent);
            if (lastAssistant) c.activeAgentId = lastAssistant.agent;
          } else if (c.activeAgentId && c.activeAgentId !== c.agentId) {
            // No transcript: stale activeAgentId from a delegation that ended.
            // Fall back to base agent (orchestrator) since they resume after delegates return.
            c.activeAgentId = c.agentId;
          }
        }
        ws.send(JSON.stringify({ type: 'conversations', conversations: cleaned }));
      }

      // Client requests buffered messages after it has loaded conversations and state.
      // Skip stream_event and assistant messages since responseText snapshot covers them.
      if (msg.type === 'flush_buffer') {
        if (disconnectBuffer.length) {
          console.log(`[WS] Flushing ${disconnectBuffer.length} buffered messages (filtering stream events)`);
          while (disconnectBuffer.length) {
            const m = disconnectBuffer.shift();
            try {
              const parsed = JSON.parse(m);
              if (parsed.type === 'stream_event' || parsed.type === 'assistant') continue;
            } catch (e) {}
            if (ws.readyState === 1) ws.send(m);
          }
        }
      }

      if (msg.type === 'save_conversation') {
        if (!WORKSPACE || !msg.conversation || !msg.conversation.id) return;
        const convos = readConversations();
        const idx = convos.findIndex(c => c.id === msg.conversation.id);
        // Only persist metadata, never message content
        const entry = {
          id: msg.conversation.id,
          agentId: msg.conversation.agentId,
          activeAgentId: msg.conversation.activeAgentId || null,
          sessionId: msg.conversation.sessionId || null,
          sessionIds: msg.conversation.sessionIds || [],
          title: msg.conversation.title,
          status: msg.conversation.status || 'active',
          pinned: msg.conversation.pinned || false,
          pinnedAt: msg.conversation.pinnedAt || null,
          createdAt: msg.conversation.createdAt || new Date().toISOString(),
          lastActiveAt: new Date().toISOString()
        };
        if (idx >= 0) { convos[idx] = entry; } else { convos.unshift(entry); }
        // Cap at 100 conversations
        writeConversations(convos.slice(0, 100));
      }

      // ── DELEGATION: orchestrator hands off to another agent in the same conversation ──
      if (msg.type === 'delegate') {
        handleDelegation(msg, processes);
      }


      // End delegation: kill delegate, restore original
      if (msg.type === 'end_delegation') {
        const convoId = msg.conversationId;
        const current = processes.get(convoId);
        if (current && current.delegation && !current.exited) {
          console.log(`[Delegate] convo=${convoId} ending delegation, killing delegate`);
          try { current.process.kill(); } catch (e) {}
          // The close handler will restore the original process
        } else if (current && !current.delegation && !current.exited && !current.scopeReturn) {
          // Specialist started directly (no delegation) emitted RETURN
          // Server-side onResult should have caught this, but handle as fallback
          console.log(`[ScopeReturn] convo=${convoId} end_delegation fallback for non-delegated specialist`);
          current.scopeReturn = true;
          try { current.process.kill(); } catch (e) {}
          // The close handler will call handleScopeReturn
        }
      }

      if (msg.type === 'delete_conversation') {
        if (!WORKSPACE || !msg.id) return;
        const convos = readConversations().filter(c => c.id !== msg.id);
        writeConversations(convos);
        ws.send(JSON.stringify({ type: 'conversation_deleted', id: msg.id }));
      }

      if (msg.type === 'read_file') {
        const fullPath = path.resolve(WORKSPACE, msg.path);
        if (fullPath.startsWith(path.resolve(WORKSPACE)) && fs.existsSync(fullPath)) {
          ws.send(JSON.stringify({ type: 'file_content', path: msg.path, content: fs.readFileSync(fullPath, 'utf-8') }));
        }
      }

      if (msg.type === 'add_to_team') {
        // Assign the next order number to an available agent
        const agentList = discoverAgents();
        const target = agentList.find(a => a.id === msg.agentId);
        if (target && target.fileName) {
          const maxOrder = Math.max(0, ...agentList.filter(a => a.order !== null).map(a => a.order));
          const nextOrder = maxOrder + 1;
          const filePath = path.join(WORKSPACE, '.claude', 'agents', target.fileName);
          let content = fs.readFileSync(filePath, 'utf-8');
          // Add or update order field in frontmatter
          if (content.match(/^order:\s/m)) {
            content = content.replace(/^order:\s.*/m, `order: ${nextOrder}`);
          } else {
            // Add order after the type field, or after description
            content = content.replace(/^(type:\s.*)/m, `$1\norder: ${nextOrder}`);
            if (!content.match(/^order:/m)) {
              content = content.replace(/^(description:[\s\S]*?)(\n\w)/m, `$1\norder: ${nextOrder}$2`);
            }
          }
          fs.writeFileSync(filePath, content, 'utf-8');
          // Send updated agent list
          ws.send(JSON.stringify({ type: 'agents', agents: discoverAgents() }));
        }
      }

      // ===== AGENT & SKILL CRUD (server-side, bypasses Claude Code's .claude/ protection) =====
      // Agents: .claude/agents/{name}.md
      // Skills: .claude/skills/{name}/SKILL.md
      // Both use the same pattern: SAVE (upsert) and DELETE via WebSocket messages,
      // triggered by RUNDOCK:SAVE_AGENT / RUNDOCK:SAVE_SKILL markers in agent responses.

      // save_agent: upsert (create or update). Also handles legacy 'create_agent' and 'update_agent'.
      if (msg.type === 'save_agent' || msg.type === 'create_agent' || msg.type === 'update_agent') {
        const name = msg.name || msg.agentId;
        if (!validateAgentSlug(name)) {
          ws.send(JSON.stringify({ type: 'agent_error', message: 'Invalid agent name. Use lowercase letters, numbers, and hyphens only.' }));
        } else {
          const agentsDir = path.join(WORKSPACE, '.claude', 'agents');
          if (!fs.existsSync(agentsDir)) fs.mkdirSync(agentsDir, { recursive: true });
          const filePath = path.join(agentsDir, name + '.md');
          if (!filePath.startsWith(path.resolve(WORKSPACE))) {
            ws.send(JSON.stringify({ type: 'agent_error', message: 'Invalid path.' }));
          } else {
            const existed = fs.existsSync(filePath);
            fs.writeFileSync(filePath, msg.content, 'utf-8');
            // For new agents: auto-assign type and order so they go straight to team
            if (!existed) {
              let saved = fs.readFileSync(filePath, 'utf-8');
              const hasType = saved.match(/^type:\s/m);
              const hasOrder = saved.match(/^order:\s/m);
              if (!hasType || !hasOrder) {
                const currentAgents = discoverAgents();
                const maxOrder = Math.max(0, ...currentAgents.filter(a => a.order !== null).map(a => a.order));
                if (!hasType && !hasOrder) {
                  // No type or order: add both after description (or before closing ---)
                  if (saved.match(/^description:\s/m)) {
                    saved = saved.replace(/^(description:\s.*)/m, `$1\ntype: specialist\norder: ${maxOrder + 1}`);
                  } else {
                    saved = saved.replace(/^(---\s*$)/m, `type: specialist\norder: ${maxOrder + 1}\n$1`);
                  }
                } else if (hasType && !hasOrder) {
                  // Has type but no order: add order after type
                  saved = saved.replace(/^(type:\s.*)/m, `$1\norder: ${maxOrder + 1}`);
                }
                fs.writeFileSync(filePath, saved, 'utf-8');
              }
            }
            console.log(`[Agent] ${existed ? 'Updated' : 'Created'}: ${name}`);
            ws.send(JSON.stringify({ type: 'agent_saved', agentId: name, updated: existed }));
            const updatedAgents = discoverAgents();
            ws.send(JSON.stringify({ type: 'agents', agents: updatedAgents }));
            ws.send(JSON.stringify({ type: 'skills', skills: discoverSkills(updatedAgents) }));
            flagRosterRefresh(); invalidateAgentCache();
            if (!existed) {
              const state = readState();
              if (!state.setupComplete && updatedAgents.some(a => a.status === 'onTeam' && a.type !== 'platform')) {
                writeState({ ...state, setupComplete: true, setupCompletedAt: new Date().toISOString(), version: 1 });
                console.log(`[Setup] Marked complete`);
              }
            }
          }
        }
      }

      if (msg.type === 'delete_agent') {
        const agentList = discoverAgents();
        const target = agentList.find(a => a.id === msg.agentId);
        if (!target || !target.fileName) {
          ws.send(JSON.stringify({ type: 'agent_error', message: `Agent "${msg.agentId}" not found.` }));
        } else if (target.type === 'platform') {
          ws.send(JSON.stringify({ type: 'agent_error', message: 'Cannot delete platform agents.' }));
        } else {
          const filePath = path.join(WORKSPACE, '.claude', 'agents', target.fileName);
          if (filePath.startsWith(path.resolve(WORKSPACE))) {
            fs.unlinkSync(filePath);
            console.log(`[Agent] Deleted: ${msg.agentId}`);
            ws.send(JSON.stringify({ type: 'agent_deleted', agentId: msg.agentId }));
            const updatedAgents = discoverAgents();
            ws.send(JSON.stringify({ type: 'agents', agents: updatedAgents }));
            ws.send(JSON.stringify({ type: 'skills', skills: discoverSkills(updatedAgents) }));
            flagRosterRefresh(); invalidateAgentCache();
          }
        }
      }

      // save_skill: upsert (create or update) a skill's SKILL.md file.
      if (msg.type === 'save_skill') {
        const name = msg.name;
        if (!validateAgentSlug(name)) {
          ws.send(JSON.stringify({ type: 'skill_error', message: 'Invalid skill name. Use lowercase letters, numbers, and hyphens only.' }));
        } else {
          const skillDir = path.join(WORKSPACE, '.claude', 'skills', name);
          if (!skillDir.startsWith(path.resolve(WORKSPACE))) {
            ws.send(JSON.stringify({ type: 'skill_error', message: 'Invalid path.' }));
          } else {
            if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
            const filePath = path.join(skillDir, 'SKILL.md');
            const existed = fs.existsSync(filePath);
            fs.writeFileSync(filePath, msg.content, 'utf-8');
            console.log(`[Skill] ${existed ? 'Updated' : 'Created'}: ${name}`);
            ws.send(JSON.stringify({ type: 'skill_saved', skillId: name, updated: existed }));
            const updatedAgents = discoverAgents();
            ws.send(JSON.stringify({ type: 'skills', skills: discoverSkills(updatedAgents) }));
            flagRosterRefresh(); invalidateAgentCache();
          }
        }
      }

      if (msg.type === 'delete_skill') {
        const name = msg.name;
        if (!validateAgentSlug(name)) {
          ws.send(JSON.stringify({ type: 'skill_error', message: 'Invalid skill name.' }));
        } else {
          const skillDir = path.join(WORKSPACE, '.claude', 'skills', name);
          if (!skillDir.startsWith(path.resolve(WORKSPACE)) || !fs.existsSync(skillDir)) {
            ws.send(JSON.stringify({ type: 'skill_error', message: `Skill "${name}" not found.` }));
          } else {
            fs.rmSync(skillDir, { recursive: true });
            console.log(`[Skill] Deleted: ${name}`);
            ws.send(JSON.stringify({ type: 'skill_deleted', skillId: name }));
            const updatedAgents = discoverAgents();
            ws.send(JSON.stringify({ type: 'skills', skills: discoverSkills(updatedAgents) }));
            flagRosterRefresh(); invalidateAgentCache();
          }
        }
      }

      // ── CONVERSATION SEARCH: search titles and transcript content ──
      if (msg.type === 'search_conversations') {
        (async () => {
          const query = (msg.query || '').toLowerCase().trim();
          if (!WORKSPACE || !query) {
            ws.send(JSON.stringify({ type: 'search_results', results: [], query: msg.query }));
            return;
          }
          const convos = readConversations();
          // Phase 1: title matches (instant)
          const titleMatches = convos.filter(c => (c.title || '').toLowerCase().includes(query)).map(c => ({ ...c, matchType: 'title' }));
          // Phase 2: content matches (scan JSONL transcripts)
          const contentSearchPromises = convos.filter(c => c.sessionId).map(async (c) => {
            const filePath = getSessionJsonlPath(c.sessionId);
            if (!filePath) return null;
            try {
              const rl = readline.createInterface({
                input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
                crlfDelay: Infinity
              });
              for await (const line of rl) {
                try {
                  const obj = JSON.parse(line);
                  // Check user messages
                  if (obj.type === 'user' && obj.message && typeof obj.message.content === 'string') {
                    if (obj.message.content.toLowerCase().includes(query)) {
                      rl.close();
                      return { ...c, matchType: 'content', snippet: extractSnippet(obj.message.content, query) };
                    }
                  }
                  // Check assistant text blocks
                  if (obj.message && obj.message.role === 'assistant' && Array.isArray(obj.message.content)) {
                    for (const block of obj.message.content) {
                      if (block.type === 'text' && block.text && block.text.toLowerCase().includes(query)) {
                        rl.close();
                        return { ...c, matchType: 'content', snippet: extractSnippet(block.text, query) };
                      }
                    }
                  }
                } catch (e) { /* skip */ }
              }
            } catch (e) { /* file read error */ }
            return null;
          });
          const contentResults = (await Promise.all(contentSearchPromises)).filter(Boolean);
          // Merge: title matches first, then content-only matches (no duplicates)
          const titleIds = new Set(titleMatches.map(c => c.id));
          const merged = [...titleMatches, ...contentResults.filter(c => !titleIds.has(c.id))];
          ws.send(JSON.stringify({ type: 'search_results', results: merged.slice(0, 50), query: msg.query }));
        })().catch(err => {
          console.warn('[Search] Error:', err.message);
          ws.send(JSON.stringify({ type: 'search_results', results: [], query: msg.query }));
        });
      }

      if (msg.type === 'get_session_history') {
        const { sessionId, sessionIds, conversationId, limit, offset } = msg;

        // Multi-session merge: load from all sessions in the delegation chain.
        // Use the conversation transcript as the primary source for agent attribution,
        // since JSONL sessions can contain messages from multiple agents after restarts.
        if (sessionIds && sessionIds.length > 0) {
          Promise.all(sessionIds.map(async (s) => {
            const result = await parseSessionHistory(s.sessionId, 999, 0).catch(() => ({ messages: [] }));
            return result.messages.map(m => ({ ...m, _sessionAgentId: s.agentId || null }));
          })).then(allSessions => {
            // Load transcript for accurate agent attribution
            const transcript = loadTranscript(conversationId);
            const transcriptAgents = []; // Build ordered list of { role, agentId, contentPrefix }
            if (transcript && transcript.length > 0) {
              for (const t of transcript) {
                transcriptAgents.push({
                  role: t.role === 'user' ? 'user' : 'assistant',
                  agentId: t.agent,
                  contentPrefix: (t.text || '').substring(0, 200)
                });
              }
            }

            // Merge all sessions in order, deduplicating user messages
            const merged = [];
            const seenUserMsgs = new Set();
            let transcriptIdx = 0;
            for (const sessionMsgs of allSessions) {
              for (const m of sessionMsgs) {
                if (m.role === 'user') {
                  const key = m.content.substring(0, 200);
                  if (seenUserMsgs.has(key)) continue;
                  if (m.content.startsWith('CONVERSATION SO FAR:') || m.content.startsWith('[SYSTEM:') || m.content.startsWith('[DELEGATION BRIEF]')) continue;
                  seenUserMsgs.add(key);
                }
                // Match against transcript for correct agent attribution
                let agentId = m._sessionAgentId;
                if (m.role === 'assistant' && transcriptAgents.length > 0) {
                  // Find the next transcript entry that matches this message's role and content
                  for (let ti = transcriptIdx; ti < transcriptAgents.length; ti++) {
                    const te = transcriptAgents[ti];
                    if (te.role === 'assistant' && m.content && te.contentPrefix.length > 10 && m.content.substring(0, 200).includes(te.contentPrefix.substring(0, 100))) {
                      agentId = te.agentId;
                      transcriptIdx = ti + 1;
                      break;
                    }
                  }
                }
                delete m._sessionAgentId;
                m.agentId = m.role === 'user' ? null : agentId;
                merged.push(m);
              }
            }
            // Reconcile with transcript: fill in messages missing from JSONL
            // (e.g. orchestrator responses lost when process was SIGKILL'd during Agent tool interception)
            if (transcript && transcript.length > 0) {
              // Helper: strip leading tool summary brackets like [Read ...] [Edit ...] for matching
              const stripToolSummaries = (s) => (s || '').replace(/^(\[.*?\]\s*)+/s, '').trim();

              // Build a set of merged assistant content prefixes for quick lookup
              const mergedAssistantPrefixes = new Set();
              for (const m of merged) {
                if (m.role === 'assistant' && m.content) {
                  mergedAssistantPrefixes.add(m.content.substring(0, 120));
                }
              }

              // Check if transcript has assistant messages not in the JSONL merge
              const missingFromMerge = [];
              for (const t of transcript) {
                if (t.role !== 'agent' || !t.text) continue;
                const cleanText = stripToolSummaries(t.text);
                if (!cleanText) continue;
                // Check if this transcript message exists in merged
                const found = mergedAssistantPrefixes.has(cleanText.substring(0, 120)) ||
                  [...mergedAssistantPrefixes].some(p => p.includes(cleanText.substring(0, 80)) || cleanText.substring(0, 80).includes(p.substring(0, 80)));
                if (!found) {
                  missingFromMerge.push({
                    role: 'assistant',
                    content: cleanText,
                    agentId: t.agent || null,
                    _transcriptIdx: transcript.indexOf(t)
                  });
                }
              }

              // Insert missing messages at the right position using transcript ordering
              if (missingFromMerge.length > 0) {
                // Map merged messages to their transcript positions
                const result = [];
                let mergedIdx = 0;
                for (const t of transcript) {
                  const tRole = t.role === 'user' ? 'user' : 'assistant';
                  // Check if this is a missing message we need to inject
                  const missing = missingFromMerge.find(m => m._transcriptIdx === transcript.indexOf(t));
                  if (missing) {
                    result.push({ role: missing.role, content: missing.content, agentId: missing.agentId });
                    continue;
                  }
                  // Otherwise advance through merged to find the matching entry
                  if (mergedIdx < merged.length && merged[mergedIdx].role === tRole) {
                    result.push(merged[mergedIdx]);
                    mergedIdx++;
                  }
                }
                // Append any remaining merged entries
                while (mergedIdx < merged.length) {
                  result.push(merged[mergedIdx++]);
                }
                merged.length = 0;
                merged.push(...result);
              }
            }

            const total = merged.length;
            const lim = limit || 50;
            const off = offset || 0;
            const start = Math.max(0, total - lim - off);
            const end = Math.max(0, total - off);
            ws.send(JSON.stringify({
              type: 'session_history',
              conversationId,
              messages: merged.slice(start, end),
              totalCount: total,
              hasMore: start > 0
            }));
          }).catch(err => {
            console.warn('[Session history] Multi-session merge error:', err.message);
            ws.send(JSON.stringify({ type: 'session_history', conversationId, messages: [], totalCount: 0, hasMore: false }));
          });
        } else {
          // Fallback: single session (backward compatible)
          parseSessionHistory(sessionId, limit || 20, offset || 0).then(result => {
            ws.send(JSON.stringify({
              type: 'session_history',
              conversationId,
              messages: result.messages,
              totalCount: result.totalCount,
              hasMore: result.hasMore
            }));
          }).catch(err => {
            console.warn('[Session history] Parse error:', err.message);
            ws.send(JSON.stringify({ type: 'session_history', conversationId, messages: [], totalCount: 0, hasMore: false }));
          });
        }
      }

      if (msg.type === 'save_file') {
        const fullPath = path.resolve(WORKSPACE, msg.path);
        if (fullPath.startsWith(path.resolve(WORKSPACE))) {
          fs.writeFileSync(fullPath, msg.content, 'utf-8');
          ws.send(JSON.stringify({ type: 'file_saved', path: msg.path }));
        }
      }
    } catch (e) {
      console.error('Error handling message:', e);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    connectedClients.delete(ws);
    // Don't kill processes: they survive reconnects.
    // If no clients remain, safeSend will buffer output until the next connection.
  });
});

// ===== SKILL DISCOVERY =====

function discoverSkills(existingAgents) {
  const skills = [];
  const agents = existingAgents || discoverAgents();
  const agentsDir = path.join(WORKSPACE, '.claude', 'agents');

  // Read full body text of each on-team agent (after frontmatter, not CLAUDE.md)
  const agentBody = {};
  for (const agent of agents.filter(a => a.status === 'onTeam' && a.fileName)) {
    try {
      const content = fs.readFileSync(path.join(agentsDir, agent.fileName), 'utf-8');
      const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)/);
      agentBody[agent.id] = bodyMatch ? bodyMatch[1].toLowerCase() : '';
    } catch (e) { agentBody[agent.id] = ''; }
  }

  // Scan multiple skill locations
  const sources = [
    { dir: path.join(WORKSPACE, 'System', 'Playbooks'), defFile: 'PLAYBOOK.md', sourceLabel: 'System/Playbooks' },
    { dir: path.join(WORKSPACE, '.claude', 'skills'), defFile: 'SKILL.md', sourceLabel: '.claude/skills' },
  ];

  for (const source of sources) {
    if (!fs.existsSync(source.dir)) continue;
    const dirs = fs.readdirSync(source.dir, { withFileTypes: true }).filter(d => d.isDirectory());

    for (const dir of dirs) {
      const defPath = path.join(source.dir, dir.name, source.defFile);
      if (!fs.existsSync(defPath)) continue;

      try {
        const content = fs.readFileSync(defPath, 'utf-8');
        const parsed = parseSkillFile(content, dir.name);

        // Match skill to agents via two methods:
        // 1. Explicit: agent frontmatter has skills: array listing this slug
        // 2. Fallback: body-text scan for the slug as a distinct reference
        const slug = dir.name.toLowerCase();
        const slugPattern = new RegExp('(?<![\\w-])' + slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])', 'i');
        const assignedAgents = [];
        const assignedIds = new Set();

        // Pass 1: explicit frontmatter skills
        for (const agent of agents.filter(a => a.status === 'onTeam')) {
          if (agent.type === 'platform' && !slug.startsWith('rundock-')) continue;
          if (agent.type !== 'platform' && slug.startsWith('rundock-')) continue;
          if (agent.skills && agent.skills.some(s => s.toLowerCase() === slug)) {
            assignedAgents.push({ id: agent.id, name: agent.displayName, role: agent.role || '', colour: agent.colour, icon: agent.icon });
            assignedIds.add(agent.id);
          }
        }

        // Pass 2: body-text scan fallback (skip agents already matched)
        for (const agent of agents.filter(a => a.status === 'onTeam')) {
          if (assignedIds.has(agent.id)) continue;
          if (agent.type === 'platform' && !slug.startsWith('rundock-')) continue;
          if (agent.type !== 'platform' && slug.startsWith('rundock-')) continue;
          const body = agentBody[agent.id] || '';
          if (slugPattern.test(body)) {
            assignedAgents.push({ id: agent.id, name: agent.displayName, role: agent.role || '', colour: agent.colour, icon: agent.icon });
          }
        }

        // Extract body content (after frontmatter) for instructions display
        const bodyMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)/);
        const instructions = bodyMatch ? bodyMatch[1].trim() : '';

        skills.push({
          id: dir.name,
          name: parsed.displayName,
          description: parsed.description,
          slug: dir.name,
          source: source.sourceLabel,
          sourcePath: `${source.sourceLabel}/${dir.name}/`,
          filePath: `${source.sourceLabel}/${dir.name}/${source.defFile}`,
          assignedAgents,
          instructions,
          status: assignedAgents.length > 0 ? 'assigned' : 'unassigned'
        });
      } catch (e) {
        console.error(`Error reading skill ${dir.name}:`, e.message);
      }
    }
  }

  // Sort alphabetically
  skills.sort((a, b) => a.name.localeCompare(b.name));

  return skills;
}

function parseSkillFile(content, slug) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  let name = slug;
  let description = '';

  if (fmMatch) {
    const nameMatch = fmMatch[1].match(/^name:\s*(.+)/m);
    if (nameMatch) name = nameMatch[1].trim();

    // Handle multi-line description with > or plain multi-line
    const descMatch = fmMatch[1].match(/description:\s*>?\s*\n((?:\s+.+\n?)+)/);
    if (descMatch) {
      description = descMatch[1].replace(/\n\s*/g, ' ').trim();
    } else {
      const descSingle = fmMatch[1].match(/^description:\s*(.+)/m);
      if (descSingle) description = descSingle[1].trim();
    }
  }

  // Convert slug-style names to title case (preserve known brand casing)
  const brandWords = { linkedin: 'LinkedIn', reddit: 'Reddit', notion: 'Notion', readwise: 'Readwise', granola: 'Granola', api: 'API', oauth: 'OAuth', mcp: 'MCP' };
  const displayName = name === slug
    ? slug.split('-').map(w => brandWords[w.toLowerCase()] || (w.charAt(0).toUpperCase() + w.slice(1))).join(' ')
    : name;

  return { displayName, description };
}

// ===== FILE TREE =====

function getFileTree(dir, prefix = '') {
  const entries = [];
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true })
      .filter(item => !item.name.startsWith('.') && item.name !== 'node_modules')
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });
    for (const item of items) {
      const relativePath = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        entries.push({ type: 'folder', name: item.name, path: relativePath, children: getFileTree(path.join(dir, item.name), relativePath) });
      } else if (item.name.endsWith('.md') || item.name.endsWith('.txt') || item.name.endsWith('.json')) {
        entries.push({ type: 'file', name: item.name, path: relativePath });
      }
    }
  } catch (e) {}
  return entries;
}

// ===== PROCESS CLEANUP (S4) =====

// PID file: track all spawned Claude Code process PIDs so orphans can be cleaned up
// on restart if the parent crashes without running exit handlers.
function pidFilePath() {
  if (!WORKSPACE) return null;
  return path.join(rundockDir(), 'child-pids.json');
}

function loadPidFile() {
  const p = pidFilePath();
  if (!p) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return []; }
}

function savePidFile(pids) {
  const p = pidFilePath();
  if (!p) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(pids));
  } catch (e) {}
}

function registerChildPid(pid) {
  const pids = loadPidFile();
  if (!pids.includes(pid)) {
    pids.push(pid);
    savePidFile(pids);
  }
}

function unregisterChildPid(pid) {
  const pids = loadPidFile().filter(p => p !== pid);
  savePidFile(pids);
}

// Kill all tracked child processes (called on exit)
function killAllChildren() {
  for (const [, entry] of chatProcesses) {
    if (!entry.exited) {
      try { entry.process.kill('SIGTERM'); } catch (e) {}
    }
  }
  chatProcesses.clear();
  // Clear PID file since we handled cleanup
  savePidFile([]);
}

// Clean up orphaned processes from a previous crash (PIDs left in the file)
function cleanOrphanedProcesses() {
  const pids = loadPidFile();
  if (pids.length === 0) return;
  let cleaned = 0;
  for (const pid of pids) {
    try {
      // Check if process exists (signal 0 doesn't kill, just checks)
      process.kill(pid, 0);
      // Process exists: kill it
      process.kill(pid, 'SIGTERM');
      cleaned++;
    } catch (e) {
      // Process doesn't exist: already gone
    }
  }
  if (cleaned > 0) {
    console.log(`[Cleanup] Killed ${cleaned} orphaned Claude Code process(es) from previous session`);
  }
  savePidFile([]);
}

// Spawn a Claude Code process with PID tracking for crash cleanup.
// Drop-in replacement for spawn('claude', ...) that registers/unregisters PIDs.
function spawnClaude(args, options) {
  const proc = spawn('claude', args, options);
  if (proc.pid) {
    registerChildPid(proc.pid);
    proc.on('close', () => unregisterChildPid(proc.pid));
  }
  return proc;
}

// Graceful shutdown: kill children on exit signals.
// SIGTERM/SIGINT: graceful (SIGTERM to children, then exit).
// 'exit': last resort, use SIGKILL since we can't wait for graceful shutdown.
let _shuttingDown = false;
function gracefulShutdown() {
  if (_shuttingDown) return;
  _shuttingDown = true;
  killAllChildren();
  process.exit(0);
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
process.on('exit', () => {
  // 'exit' handler must be synchronous. Kill any stragglers with SIGKILL.
  for (const [, entry] of chatProcesses) {
    if (!entry.exited) {
      try { entry.process.kill('SIGKILL'); } catch (e) {}
    }
  }
});

// ===== START =====

function startServer(options = {}) {
  const port = options.port != null ? options.port : PORT;
  return new Promise((resolve) => {
    server.listen(port, () => {
      const actualPort = server.address().port;
      ACTUAL_PORT = actualPort;
      // Clean up orphaned processes from a previous crash
      if (WORKSPACE) cleanOrphanedProcesses();
      console.log(`\n  Rundock running at http://localhost:${actualPort}`);
      if (WORKSPACE) {
        saveRecentWorkspace(WORKSPACE);
        try { scaffoldWorkspace(WORKSPACE); } catch (e) { console.warn('Scaffold warning:', e.message); }
        const agents = discoverAgents();
        const totalRoutines = agents.reduce((sum, a) => sum + (a.routines?.length || 0), 0);
        console.log(`  Workspace: ${WORKSPACE}`);
        console.log(`  Agents: ${agents.map(a => a.displayName).join(', ')}`);
        console.log(`  Routines: ${totalRoutines}`);
        startScheduler();
      } else {
        console.log(`  No workspace set. Waiting for workspace selection.`);
      }
      console.log('');
      resolve(actualPort);
    });
  });
}

// Run directly via `node server.js` (git-clone path)
if (require.main === module) {
  startServer();
}

module.exports = { startServer };
