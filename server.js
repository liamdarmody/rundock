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
const codexRuntime = require('./codex.js');
const PKG_VERSION = require('./package.json').version;
const searchLib = require('./search.js');

const PORT = process.env.PORT || 3000;
let ACTUAL_PORT = PORT; // Updated after server.listen() with the real listening port
let WORKSPACE = process.env.WORKSPACE || null;

// Workspace boundary check. A bare `startsWith(resolve(WORKSPACE))`
// lets a SIBLING directory sharing the name prefix pass (e.g. `<ws>-backup`
// starts with `<ws>`), leaking reads and writes outside the workspace. Compare
// against the root plus a trailing path separator; allow the root itself.
function isInsideWorkspace(targetPath) {
  if (!WORKSPACE || targetPath == null) return false;
  const root = path.resolve(WORKSPACE);
  const resolved = path.resolve(targetPath);
  return resolved === root || resolved.startsWith(root + path.sep);
}

// ── Codex write-request validation (Windows write markers) ──────────────────
// Validates a WRITE_FILE request BEFORE any permission card is shown: a card
// is never raised for something Rundock would refuse to do. Workspace-bound
// by construction, managed directories excluded, knowledge-mode file types
// enforced (defence in depth: the same policy the prompts state).
const CODEX_WRITE_ALLOWED_EXT = new Set(['.md', '.markdown', '.yaml', '.yml', '.json', '.txt', '.csv']);
const CODEX_WRITE_MAX_BYTES = 1024 * 1024;
function validateWriteRequest(workspaceDir, relPath, content, isCodeMode) {
  if (!workspaceDir) return { ok: false, reason: 'no workspace selected' };
  const p = String(relPath || '').trim();
  if (!p) return { ok: false, reason: 'empty path' };
  if (path.isAbsolute(p) || p.split(/[\\/]/).includes('..')) {
    return { ok: false, reason: 'path escapes the workspace' };
  }
  const root = path.resolve(workspaceDir);
  const fullPath = path.resolve(root, p);
  if (!(fullPath.startsWith(root + path.sep))) {
    return { ok: false, reason: 'path escapes the workspace' };
  }
  // Case-insensitive: Windows filesystems are, so ".Claude/" must not slip
  // past a case-sensitive name check.
  const top = path.relative(root, fullPath).split(path.sep)[0].toLowerCase();
  if (top === '.claude' || top === '.rundock') {
    return { ok: false, reason: 'managed directory' };
  }
  if (Buffer.byteLength(String(content == null ? '' : content), 'utf-8') > CODEX_WRITE_MAX_BYTES) {
    return { ok: false, reason: 'content exceeds the 1 MB write limit' };
  }
  if (!isCodeMode && !CODEX_WRITE_ALLOWED_EXT.has(path.extname(fullPath).toLowerCase())) {
    return { ok: false, reason: 'file type not supported in this workspace' };
  }
  return { ok: true, fullPath };
}

// Shared constants to avoid repetition across process spawn sites
const DISALLOWED_TOOLS_KNOWLEDGE = 'Write(*.js),Write(*.jsx),Write(*.ts),Write(*.tsx),Write(*.py),Write(*.sh),Write(*.bash),Write(*.rb),Write(*.pl),Write(*.exe),Write(*.dll),Write(*.so),Edit(*.js),Edit(*.jsx),Edit(*.ts),Edit(*.tsx),Edit(*.py),Edit(*.sh),Edit(*.bash),Edit(*.rb),Edit(*.pl),Edit(*.exe)';
// Backward compat: DISALLOWED_TOOLS used by existing code paths
const DISALLOWED_TOOLS = DISALLOWED_TOOLS_KNOWLEDGE;
// Base allow-lists. MCP tools are intentionally NOT pre-approved here. All MCP
// tools (workspace .mcp.json, user-global, and Claude.ai connectors) are routed
// through the permission hook instead, which auto-approves MCP reads and cards
// MCP writes in knowledge mode (code mode auto-approves everything). Keeping MCP
// out of --allowed-tools also avoids the Claude Code v2.1.166 `mcp__*` wildcard
// rejection entirely, since there is no MCP allow rule for it to reject.
const ALLOWED_TOOLS_INTERACTIVE_BASE = 'Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,ToolSearch,Agent,Skill';
const ALLOWED_TOOLS_LEGACY_BASE = 'Bash,WebFetch,WebSearch';

// Default model for any agent that does not declare one in its frontmatter, and
// for the synthesised orchestrator and Doc. Sonnet is the balanced choice and is
// available on every paid plan; complex agents opt up to a stronger model via `model: opus`
// in their frontmatter, quick agents opt down to `model: haiku`. Always passing
// an explicit --model (see modelArgs + spawnClaude) keeps model selection
// predictable instead of inheriting whatever Claude Code resolves from the user's
// environment (e.g. a Pro subscription resolving the invalid model name "pro").
const DEFAULT_MODEL = 'sonnet';
function modelArgs(agent) {
  return ['--model', (agent && agent.model) || DEFAULT_MODEL];
}

// Reads MCP server names from a workspace's .mcp.json. Returns [] on any problem
// (no dir, missing file, parse error, no mcpServers block). Used by workspace analysis.
function readMcpServerNames(dir) {
  if (!dir) return [];
  try {
    const mcpJsonPath = path.join(dir, '.mcp.json');
    if (!fs.existsSync(mcpJsonPath)) return [];
    const mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
    if (mcpConfig && mcpConfig.mcpServers) return Object.keys(mcpConfig.mcpServers);
  } catch (e) { /* fall through to [] */ }
  return [];
}

// Per-spawn allow-list builders. MCP scopes are deliberately excluded (see above);
// MCP approval is handled by the permission hook.
function getAllowedToolsInteractive() {
  return ALLOWED_TOOLS_INTERACTIVE_BASE;
}
function getAllowedToolsLegacy() {
  return ALLOWED_TOOLS_LEGACY_BASE;
}

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
  // Never let spawned agent processes inherit the test runner's coverage
  // collection: a child killed mid-turn (e.g. a superseded Codex exec)
  // leaves truncated coverage JSON that corrupts the runner's merge and
  // intermittently fails npm run test:coverage.
  delete env.NODE_V8_COVERAGE;
  // In the packaged app there is no system `node`, so the PreToolUse permission
  // hook is run with Rundock's bundled runtime (process.execPath) behaving as
  // Node via ELECTRON_RUN_AS_NODE. The hook is a child of the spawned claude
  // process and inherits this env. Without it, on a machine with no Node the
  // hook can't run at all and the permission system silently does nothing.
  if (process.env.RUNDOCK_ELECTRON) env.ELECTRON_RUN_AS_NODE = '1';
  try {
    const state = readState();
    if (state.workspaceMode === 'code') env.RUNDOCK_CODE_MODE = '1';
  } catch (e) { /* default knowledge mode */ }
  return env;
}

// Pending permission requests from PreToolUse hooks (keyed by requestId).
// Each entry holds the HTTP response object so we can resolve it when the user decides.
const pendingPermissionRequests = new Map();

// Permission request timeout before auto-deny. 120s in production; the env
// override exists solely so the test suite can exercise the timeout path
// deterministically without waiting two minutes. Default is unchanged.
const PERMISSION_TIMEOUT_MS = parseInt(process.env.RUNDOCK_PERMISSION_TIMEOUT_MS, 10) || 120000;

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
  return valid.map(r => ({ ...r, name: path.basename(r.path) }));
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
    const list = JSON.parse(fs.readFileSync(file, 'utf-8'));
    // One-time migration: status: 'done' -> status: 'archived'. The UI renamed
    // Done to Archive; the data model follows so the rest of the code can
    // assume 'archived' without a backwards-compat fallback. Idempotent:
    // already-migrated workspaces hit no writes and no log lines.
    let migrated = 0;
    for (const c of list) {
      if (c.status === 'done') {
        c.status = 'archived';
        migrated++;
      }
    }
    if (migrated > 0) {
      try {
        // Snapshot the pre-migration file once before the first write so a
        // manual recovery path exists if anything later goes wrong. Skips on
        // every subsequent migration attempt since the backup is preserved.
        const backupPath = file + '.pre-archive-backup';
        if (!fs.existsSync(backupPath)) {
          fs.copyFileSync(file, backupPath);
        }
        writeConversations(list);
        console.log(`[migrate] conversations.json: ${migrated} done -> archived`);
      } catch (err) {
        // Migration is safe to retry: the in-memory list is already migrated
        // for this session, and the next workspace open will attempt the
        // write again. Do not throw; the rest of read should still return.
        console.error('[migrate] persist failed:', err && err.message ? err.message : err);
      }
    }
    return list;
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

// Strip RUNDOCK markers from text (server-side mirror of client stripRundockMarkers).
// Used to sanitize specialist output before injecting into orchestrator prompts.
function stripRundockMarkers(t) {
  return t
    .replace(/<!-- RUNDOCK:DELEGATE agent=[\w-]+ -->\n?[\s\S]*/g, '')
    .replace(/<!-- RUNDOCK:RETURN -->/g, '')
    .replace(/<!-- RUNDOCK:COMPLETE -->/g, '')
    .replace(/<!-- RUNDOCK:(?:SAVE|CREATE)_AGENT name=[\w-]+ -->[\s\S]*?<!-- \/RUNDOCK:(?:SAVE|CREATE)_AGENT -->/g, '')
    .replace(/<!-- RUNDOCK:SAVE_SKILL name=[\w-]+ -->[\s\S]*?<!-- \/RUNDOCK:SAVE_SKILL -->/g, '')
    .replace(/<!-- RUNDOCK:DELETE_(?:SKILL|AGENT) name=[\w-]+ -->/g, '');
}

// Check whether a silent-park response is effectively empty (sentinel, near-empty, or no-op).
// Returns true if the response should be treated as empty and not appended to transcript.
function isSilentParkResponse(text) {
  if (!text) return true;
  // Strip the <silent> sentinel
  let cleaned = text.replace(/<silent>/gi, '').trim();
  // Strip RUNDOCK markers that might wrap the sentinel
  cleaned = stripRundockMarkers(cleaned).trim();
  // Treat as empty if under 10 non-whitespace chars or matches known no-op patterns
  const nonWs = cleaned.replace(/\s/g, '');
  if (nonWs.length < 10) return true;
  const noOpPatterns = ['No response requested.', 'OK', 'Understood.', 'Acknowledged.'];
  if (noOpPatterns.includes(cleaned)) return true;
  return false;
}

// Prepare specialist output for injection into orchestrator handback prompt.
// Strips markers, trims whitespace, and caps length to avoid blowing context.
const SPECIALIST_OUTPUT_MAX_CHARS = 12000;
function sanitizeSpecialistOutput(text) {
  if (!text) return '';
  let cleaned = stripRundockMarkers(text).trim();
  if (cleaned.length > SPECIALIST_OUTPUT_MAX_CHARS) {
    cleaned = cleaned.substring(0, SPECIALIST_OUTPUT_MAX_CHARS) + '\n\n[... output truncated for brevity ...]';
  }
  return cleaned;
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
        displayable.push({ role: 'user', content: obj.message.content, timestamp: obj.timestamp || null });
        continue;
      }
      // Assistant messages with text content. Filter out whitespace-only text
      // blocks (per-block, so a mix of empty + real blocks keeps the real
      // content and drops the rest). Whitespace-only joined output would
      // otherwise pollute the jsonlPool and falsely match real transcript
      // content in get_session_history.
      if (obj.message && obj.message.role === 'assistant' && Array.isArray(obj.message.content)) {
        const textParts = obj.message.content
          .filter(b => b.type === 'text' && b.text && b.text.trim())
          .map(b => b.text);
        if (textParts.length > 0) {
          displayable.push({ role: 'assistant', content: textParts.join('\n\n'), timestamp: obj.timestamp || null });
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

// Count user/assistant text turns in a single Claude Code session JSONL.
// Sync read to keep the get_conversations enrichment loop simple. Mirrors the
// inclusion filter in parseSessionHistory (a turn counts iff it produces a
// rendered chat bubble), and additionally skips internal injection messages
// (transcript handoffs, system markers, delegation briefs) and resume ghosts.
// Returns 0 on any I/O or parse failure so a single bad file doesn't poison
// the conversation total.
function countSessionMessagesSync(sessionId) {
  const filePath = getSessionJsonlPath(sessionId);
  if (!filePath) return 0;
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (e) { return 0; }
  let count = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (e) { continue; }
    // User text turns: tool_result entries have array content and are excluded
    // by the typeof === 'string' guard.
    if (obj.type === 'user' && obj.message && typeof obj.message.content === 'string') {
      const text = obj.message.content;
      // Skip Rundock-injected priming messages — these aren't user-visible bubbles.
      if (text.startsWith('CONVERSATION SO FAR:') ||
          text.startsWith('[SYSTEM:') ||
          text.startsWith('[DELEGATION BRIEF]')) continue;
      count++;
      continue;
    }
    // Assistant turns: count iff at least one text block has non-empty text.
    // Pure tool_use turns and pure thinking turns produce no chat bubble.
    if (obj.message && obj.message.role === 'assistant' && Array.isArray(obj.message.content)) {
      const textParts = obj.message.content
        .filter(b => b.type === 'text' && b.text && b.text.trim())
        .map(b => b.text);
      if (textParts.length === 0) continue;
      // Skip resume ghosts: empty placeholder bubbles emitted on session resume.
      if (textParts.join('\n\n').trim() === 'No response requested.') continue;
      count++;
    }
  }
  return count;
}

// Sum displayable turns across every Claude Code session a Rundock conversation
// touches (orchestrator + each delegated specialist's session). Falls back to
// the legacy single sessionId for conversations created before sessionIds[]
// tracking landed.
function countConversationMessages(convo) {
  const ids = new Set();
  if (Array.isArray(convo.sessionIds)) {
    for (const s of convo.sessionIds) {
      if (s && s.sessionId) ids.add(s.sessionId);
    }
  }
  if (ids.size === 0 && convo.sessionId) ids.add(convo.sessionId);
  let total = 0;
  for (const sid of ids) total += countSessionMessagesSync(sid);
  return total;
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
              const content = readNormalisedFile(path.join(agentsDir, af));
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

// ===== ROUTINE STATE =====
// In-memory view of routine run state, persisted to .rundock/routine-state.json
// so a server restart cannot re-fire a routine that already ran in its window
// (the desktop quit-and-reopen pattern). The file is workspace-scoped like the
// other .rundock stores; loadRoutineState() runs at startup and on every
// workspace switch.

const routineState = {}; // { routineKey: { lastRun, status, duration } }

function loadRoutineState() {
  for (const key of Object.keys(routineState)) delete routineState[key];
  try {
    const file = path.join(rundockDir(), 'routine-state.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    for (const [key, state] of Object.entries(saved)) {
      if (!state || typeof state.lastRun !== 'string') continue;
      // A run that was 'running' when the server died never finished; surface
      // that honestly. lastRun stays, so the run still suppresses a re-fire
      // (the work was started; firing it again is the bug this file prevents).
      if (state.status === 'running') state.status = 'interrupted';
      routineState[key] = state;
    }
  } catch (e) { /* missing or unreadable file: start empty */ }
}

function saveRoutineState() {
  const dir = rundockDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'routine-state.json'), JSON.stringify(routineState, null, 2));
}

function recordRoutineRun(key, state) {
  routineState[key] = state;
  try {
    saveRoutineState();
  } catch (e) {
    // Persistence is protection for the NEXT process; this one already has
    // the in-memory state. An unwritable .rundock must not kill the scheduler.
    console.error('[Scheduler] Failed to persist routine state:', e && e.message ? e.message : e);
  }
}

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
// Explicit path ONLY (decision, Liam 2026-07-13): prompt-text mentions of
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
    (isOrchestrator && match.type === 'platform');
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
    'You are inside Rundock, a visual interface for AI agent teams (docs.rundock.ai). Rundock runs agents on the Claude Code and Codex runtimes. Answer "what is Rundock" questions directly using that description, even if Rundock is outside your usual domain. Every agent should know this. For deeper meta questions (creator, licence, features, feedback), route the user to Doc or point at the docs.',
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

  // Runtime awareness for platform agents (Doc): only when Codex is actually
  // available. Doc creates agents on the default runtime without ceremony,
  // offers the alternative once per plan, and never recommends a runtime that
  // is not present on this machine. When Codex is absent this section is
  // omitted entirely, so Doc never mentions it.
  let runtimeSection = '';
  if (agentData && agentData.type === 'platform') {
    const cx = detectCodexCached();
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

// Codex detection with a short cache: buildSystemPrompt runs on every spawn
// and detection shells out (which + --version). 30 seconds is fresh enough
// for install/login state.
let _codexDetectCache = null;
let _codexDetectTime = 0;
function detectCodexCached() {
  const now = Date.now();
  if (_codexDetectCache && (now - _codexDetectTime) < 30000) return _codexDetectCache;
  try {
    _codexDetectCache = codexRuntime.detectCodex();
  } catch (e) {
    _codexDetectCache = { installed: false, authenticated: false, version: null };
  }
  _codexDetectTime = now;
  return _codexDetectCache;
}

// ===== AGENT DISCOVERY =====

let _agentCache = null;
let _agentCacheTime = 0;
const AGENT_CACHE_TTL = 2000; // 2 seconds

function invalidateAgentCache() { _agentCache = null; _agentCacheTime = 0; _skillCache = null; _skillCacheTime = 0; invalidateFileListCache(); }

// Skill + file-list caches for the search hot path (SR1). discoverSkills
// re-reads every SKILL.md and agent body per call, and the palette queries
// per debounced keystroke; both caches share the agent cache's TTL scale and
// are cleared by invalidateAgentCache (already called on every agent/skill
// mutation and workspace switch) plus save_file for the file list.
let _skillCache = null, _skillCacheTime = 0;
let _fileListCache = null, _fileListCacheTime = 0;

function invalidateFileListCache() { _fileListCache = null; _fileListCacheTime = 0; }

function discoverSkillsCached(agents) {
  const now = Date.now();
  if (_skillCache && (now - _skillCacheTime) < AGENT_CACHE_TTL) return _skillCache;
  _skillCache = discoverSkills(agents);
  _skillCacheTime = now;
  return _skillCache;
}

function flatFileListCached() {
  const now = Date.now();
  if (_fileListCache && (now - _fileListCacheTime) < AGENT_CACHE_TTL) return _fileListCache;
  _fileListCache = flattenFileTree(getFileTree(WORKSPACE));
  _fileListCacheTime = now;
  return _fileListCache;
}

function discoverAgents() {
  // No workspace selected yet: nothing to discover. Guards path.join(null,…),
  // which otherwise throws and crashes GET /api/agents before a workspace is
  // picked (latent crash otherwise).
  if (!WORKSPACE) return [];
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
        const content = readNormalisedFile(path.join(agentsDir, file));
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
          instructions = readNormalisedFile(claudeMdPath).substring(0, 2000);
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
          // Runtime is a strict two-value field: unknown values fall back to
          // claude so a frontmatter typo can never strand an agent. Codex
          // agents get no default model injected: the Codex CLI applies its
          // own default, and Rundock only passes --model when the agent file
          // sets one explicitly.
          // Case-insensitive: `runtime: Codex` must not silently run on
          // Claude (a silent runtime override, the same class of problem the
          // off-roster delegation guard exists for). Anything that is not
          // codex (any case) is claude, the default.
          // Orchestrators and platform agents ALWAYS run on Claude Code,
          // whatever their frontmatter says: delegation works through the
          // Agent tool in Claude Code's stream, which Codex exec does not
          // have, so a Codex orchestrator would be told to route with a tool
          // that does not exist for it. The docs state the rule; this line
          // makes it true. (Revisit with the app-server protocol work.)
          runtime: (meta.type === 'orchestrator' || meta.type === 'platform') ? 'claude'
            : (String(meta.runtime || '').toLowerCase() === 'codex' ? 'codex' : 'claude'),
          model: ((meta.type !== 'orchestrator' && meta.type !== 'platform') && String(meta.runtime || '').toLowerCase() === 'codex') ? (meta.model || null) : (meta.model || DEFAULT_MODEL),
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
      const content = readNormalisedFile(claudeMdPath);
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
        runtime: 'claude',
        model: DEFAULT_MODEL,
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

  // Inject built-in Doc if no platform agent exists AND no rundock-guide
  // file was discovered. The id check is defence in depth: if a
  // rundock-guide.md exists on disk but its frontmatter failed to parse
  // (so type is null instead of 'platform'), the file-parsed agent is
  // already in the array under id 'rundock-guide', and pushing the
  // built-in fallback alongside it would produce two entries with the
  // same id and break lookups. Better to surface a degraded-but-singular
  // Doc than a phantom duplicate.
  if (!agents.find(a => a.type === 'platform') && !agents.find(a => a.id === 'rundock-guide')) {
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
      runtime: 'claude',
      model: DEFAULT_MODEL,
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

/**
 * Read a file as UTF-8 with line endings normalised to LF.
 * Some platforms (notably Windows with default Git config) check files out
 * with CRLF line endings. Several parsers in this codebase use \n-only
 * regexes; normalising at the read boundary keeps those parsers correct
 * without needing every regex to be CRLF-aware.
 */
function readNormalisedFile(filePath) {
  return fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
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
  }, checkInterval).unref(); // see heartbeat unref note: listener keeps process alive in production
}

function getNextRun(schedule, lastRunISO) {
  if (!schedule) return null;
  const now = new Date();
  const s = schedule.toLowerCase();

  // Parse "every day at HH:MM"
  const dailyMatch = s.match(/every day at (\d{2}):(\d{2})/);
  if (dailyMatch) {
    // Don't re-run if already ran today. This suppression (fed by the
    // persisted routine state) is the ONLY thing standing between a due
    // routine and a duplicate fire, which is why it is checked first.
    if (lastRunISO) {
      const lastRun = new Date(lastRunISO);
      if (lastRun.toDateString() === now.toDateString() && lastRun.getHours() >= parseInt(dailyMatch[1])) return null;
    }
    const target = new Date(now);
    target.setHours(parseInt(dailyMatch[1]), parseInt(dailyMatch[2]), 0, 0);
    // A target already past today stays TODAY: the scheduler's `now >= nextRun`
    // check fires it on the next tick (same-day catch-up). The previous code
    // rolled it to tomorrow, which meant the fire condition was only
    // satisfiable in the single millisecond HH:MM:00.000 - routines whose
    // tick did not land exactly on that instant never fired at all.
    return target;
  }

  // Parse "every [weekday] at HH:MM"
  const weeklyMatch = s.match(/every (\w+) at (\d{2}):(\d{2})/);
  if (weeklyMatch) {
    const days = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    const targetDay = days[weeklyMatch[1]];
    if (targetDay === undefined) return null;
    // Suppression first, same reasoning as the daily branch.
    if (lastRunISO) {
      const lastRun = new Date(lastRunISO);
      const daysSinceLastRun = (now - lastRun) / (1000 * 60 * 60 * 24);
      if (daysSinceLastRun < 1 && lastRun.getDay() === targetDay) return null;
    }
    const target = new Date(now);
    target.setHours(parseInt(weeklyMatch[2]), parseInt(weeklyMatch[3]), 0, 0);
    const daysUntil = (targetDay - now.getDay() + 7) % 7;
    target.setDate(target.getDate() + daysUntil);
    // On the target weekday a past-due target stays TODAY so the scheduler
    // fires it (same-day catch-up); the suppression above prevents re-fires.
    // See the daily branch for why the old roll-forward meant never firing.
    return target;
  }

  return null;
}

function executeRoutine(agent, routine, key) {
  const startTime = Date.now();
  // Persisted immediately: if the server dies mid-run, the restarted process
  // still knows the run started and will not fire it again in the same window.
  recordRoutineRun(key, { lastRun: new Date().toISOString(), status: 'running', duration: null });

  // Notify connected clients
  broadcastRoutineUpdate();

  let proc;
  if (agent.runtime === 'codex') {
    // Codex agents run their routines on Codex: exec mode is naturally
    // one-shot, the routine prompt travels over stdin with the agent's
    // instructions, and Codex's own sandbox applies (no bypass flags exist
    // on this path). The agent's plan choice is honoured even for
    // unattended work.
    // stdout/stderr are ignored: nothing consumes them on the routine path,
    // and a chatty run would otherwise fill the pipe buffer and deadlock.
    proc = spawnCodex(codexRuntime.buildCodexArgs({ model: agent.model || undefined }), {
      cwd: WORKSPACE,
      env: getSpawnEnv(null),
      stdio: ['pipe', 'ignore', 'ignore']
    });
    proc.stdin.on('error', () => { /* EPIPE on early exit */ });
    proc.stdin.write([readAgentInstructions(agent), buildSystemPrompt(agent), routine.prompt].filter(Boolean).join('\n\n'));
    proc.stdin.end();
  } else {
  // Routines run unattended (no user to approve), so bypass permissions.
  const args = [...getBareArgs(), ...modelArgs(agent), '--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  if (agent.id !== 'default') args.push('--agent', agent.id);
  args.push(routine.prompt);

  proc = spawnClaude(args, {
    cwd: WORKSPACE,
    env: getSpawnEnv(null),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  }

  proc.on('close', (code) => {
    const duration = Math.round((Date.now() - startTime) / 1000);
    recordRoutineRun(key, {
      lastRun: new Date().toISOString(),
      status: code === 0 ? 'completed' : 'failed',
      duration
    });
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
          const content = readNormalisedFile(defPath);
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

  const configuredServers = readMcpServerNames(dir);
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

// ===== EMPTY WORKSPACE DETECTION =====

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

// ===== CODE SIGNAL AUTO-DETECTION =====

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

// ===== DEFAULT WORKSPACE SCAFFOLDING =====

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

function scaffoldWorkspace(dir, opts = {}) {
  // opts.platform: test seam for the platform-specific hook wiring below
  // (same injection pattern as resolveCodexBin in codex.js).
  const platform = opts.platform || process.platform;
  // Never create the workspace directory as a side effect. If it was
  // deleted or renamed externally, bail so callers can handle the miss.
  if (!fs.existsSync(dir)) return;
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
    // Claude Code launches the PreToolUse hook as a child process. Packaged
    // users have no system `node`, so the hook must run via Rundock's own runtime
    // (process.execPath: the Electron binary, run as Node via ELECTRON_RUN_AS_NODE;
    // or plain node when run from source). Relying on ELECTRON_RUN_AS_NODE being
    // INHERITED through Claude's hook spawn proved unreliable on Windows (the flag
    // didn't reach the hook, so Rundock.exe launched the app instead of running as
    // Node, and the hook never executed). So we write a tiny launcher that sets the
    // flag explicitly, then execs the runtime against the hook script. The launcher
    // lives in the gitignored .rundock/ dir (always writable, unlike the read-only
    // app bundle on macOS). Named permission-hook.* so the stale-entry cleanup
    // below still recognises it.
    const rundockDir = path.join(dir, '.rundock');
    let expectedHookCommand;
    let expectedHookShell; // set on Windows only; POSIX entries carry no shell field
    try {
      fs.mkdirSync(rundockDir, { recursive: true });
      if (platform === 'win32') {
        const launcher = path.join(rundockDir, 'permission-hook.cmd');
        fs.writeFileSync(launcher,
          `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${hookScript}" %*\r\n`);
        // Claude Code runs hooks under Git Bash on Windows when Git is
        // installed; PowerShell is only the fallback (docs: hooks shell
        // defaults to bash, or powershell when Git Bash is absent). Both
        // shell-agnostic command forms fail under Git Bash, verified live:
        // `& "launcher"` is a bash syntax error (fail-closed), and
        // `cmd /c "launcher"` gets its /c switch rewritten to a drive path
        // by MSYS argument conversion, so cmd starts an interactive session
        // instead of running the launcher (fail-open). The documented fix
        // is the hooks `shell` field: pin the entry to PowerShell and use
        // the call-operator form PowerShell requires to execute a quoted
        // path. Machines without Git Bash already default to PowerShell,
        // so behaviour converges. The stale-entry cleanup below migrates
        // both earlier forms automatically.
        expectedHookCommand = `& "${launcher}"`;
        expectedHookShell = 'powershell';
      } else {
        const launcher = path.join(rundockDir, 'permission-hook.sh');
        fs.writeFileSync(launcher,
          `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${hookScript}" "$@"\n`);
        fs.chmodSync(launcher, 0o755);
        expectedHookCommand = `sh "${launcher}"`;
      }
    } catch (e) {
      // Fallback: direct invocation (relies on inherited ELECTRON_RUN_AS_NODE).
      expectedHookCommand = `"${process.execPath}" "${hookScript}"`;
    }
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
        ...(expectedHookShell ? { shell: expectedHookShell } : {}),
        timeout: 300
      }]
    });

    // Drop any existing permission-hook entries whose command OR shell does
    // NOT match the current expected form. This forces rewrite of stale
    // entries left behind by earlier versions: paths inside the read-only
    // asar archive, the unpinned `& "..."` form (bash syntax error), and
    // the `cmd /c "..."` form (MSYS-mangled under Git Bash).
    const hookUpToDate = (h) => h.command === expectedHookCommand &&
      (expectedHookShell ? h.shell === expectedHookShell : h.shell === undefined);
    const beforeStale = settingsLocal.hooks.PreToolUse.length;
    settingsLocal.hooks.PreToolUse = settingsLocal.hooks.PreToolUse.filter(e => {
      const hooks = e.hooks || [];
      const hasStaleHook = hooks.some(h =>
        h.command && h.command.includes('permission-hook') && !hookUpToDate(h)
      );
      return !hasStaleHook;
    });
    let dirty = settingsLocal.hooks.PreToolUse.length < beforeStale;

    const hasMatcher = (matcher) => settingsLocal.hooks.PreToolUse.some(e =>
      e.matcher === matcher && (e.hooks || []).some(hookUpToDate)
    );

    if (!hasMatcher('Bash')) {
      settingsLocal.hooks.PreToolUse.push(hookEntry('Bash'));
      dirty = true;
    }
    // On Windows (and wherever CLAUDE_CODE_USE_POWERSHELL_TOOL is on) Claude Code
    // runs shell commands through the PowerShell tool, not Bash. Without this
    // matcher those commands bypass the permission system entirely.
    if (!hasMatcher('PowerShell')) {
      settingsLocal.hooks.PreToolUse.push(hookEntry('PowerShell'));
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
  if (req.url === '/' || req.url === '/index.html' || req.url.startsWith('/?') || req.url.startsWith('/index.html?')) {
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
  } else if (req.url.startsWith('/workspace-file?path=')) {
    // Binary transport for the file-type registry's image and PDF viewers.
    // Allowlist-only; bytes are served raw (the WS read_file path utf-8
    // normalises and would corrupt them). Boundary guard mirrors /api/file.
    const filePath = decodeURIComponent(req.url.split('path=')[1]);
    const fullPath = path.resolve(WORKSPACE, filePath);
    const mime = BINARY_FILE_TYPES[path.extname(fullPath).toLowerCase()];
    if (mime && isInsideWorkspace(fullPath) && fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      res.writeHead(200, {
        'Content-Type': mime,
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end(fs.readFileSync(fullPath));
    } else {
      res.writeHead(404);
      res.end('File not found');
    }
  } else if (req.url.startsWith('/api/file?path=')) {
    const filePath = decodeURIComponent(req.url.split('path=')[1]);
    const fullPath = path.resolve(WORKSPACE, filePath);
    if (isInsideWorkspace(fullPath) && fs.existsSync(fullPath)) {
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
          }, PERMISSION_TIMEOUT_MS)
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

  } else if (/^\/[\w-]+\.m?js$/.test(req.url)) {
    // Top-level client modules under public/ (code-language.js, markers.js,
    // and future extracted modules). The pattern allows no slashes and no
    // dots outside the extension, so traversal cannot be expressed; the
    // realpath prefix check guards anything that somehow gets past it.
    // Regression note: code-language.js shipped in 0.10.0 with a script tag
    // but no route, so browsers 404ed it and a defensive fallback in app.js
    // silently masked the loss. The index-html-to-route test pins every
    // script tag to a live route now.
    const publicRoot = path.resolve(__dirname, 'public');
    const filePath = path.resolve(publicRoot, req.url.slice(1));
    if (filePath.startsWith(publicRoot + path.sep) && fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      res.end(fs.readFileSync(filePath));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  } else if (/^\/(editor|vendor)\/[\w./-]+\.(m?js|css)$/.test(req.url)) {
    // Static JS/MJS/CSS files for the Tiptap editor module, its vendor bundle,
    // and vendored assets (e.g. highlight.js). Path is constrained to /editor/...
    // and /vendor/... under public/, with only .js/.mjs/.css extensions and only
    // word chars + dot/slash/hyphen in the path. The realpath check below blocks
    // any directory traversal that somehow gets past the regex.
    const publicRoot = path.resolve(__dirname, 'public');
    const filePath = path.resolve(publicRoot, req.url.slice(1));
    if (filePath.startsWith(publicRoot + path.sep) && fs.existsSync(filePath)) {
      const contentType = filePath.endsWith('.css') ? 'text/css' : 'application/javascript';
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      res.end(fs.readFileSync(filePath));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
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

// Best-effort recovery of a corrupt (e.g. truncated) transcript JSON array.
// A transcript file is normally overwritten wholesale on the next append, so a
// mid-write truncation that JSON.parse rejects must NOT be masked as an empty
// array: doing so lets the next append clobber the file and silently wipe all
// prior history. This salvages as much history as possible instead.
// Attempt 1 balances any string/brackets left open by the truncation; attempt
// 2 keeps only the complete leading objects. Returns [] only if nothing at all
// can be recovered.
function recoverTranscriptData(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  const stack = [];
  let inString = false, escaped = false, lastCompleteObjEnd = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      stack.pop();
      // A complete top-level object just closed (only the outer array remains).
      if (ch === '}' && stack.length === 1 && stack[0] === '[') lastCompleteObjEnd = i;
    }
  }
  let patched = raw;
  if (inString) patched += '"';
  for (let i = stack.length - 1; i >= 0; i--) patched += stack[i] === '{' ? '}' : ']';
  try {
    const data = JSON.parse(patched);
    if (Array.isArray(data)) return data;
  } catch { /* fall through to complete-object salvage */ }
  if (lastCompleteObjEnd >= 0) {
    try {
      const data = JSON.parse(raw.slice(0, lastCompleteObjEnd + 1) + ']');
      if (Array.isArray(data)) return data;
    } catch { /* nothing recoverable */ }
  }
  return [];
}

function loadTranscript(convoId) {
  if (convoTranscripts.has(convoId)) return convoTranscripts.get(convoId);
  const file = path.join(transcriptDir(), `${convoId}.json`);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (e) {
    // File absent (or otherwise unreadable): legitimately empty history.
    const empty = [];
    convoTranscripts.set(convoId, empty);
    return empty;
  }
  try {
    const data = JSON.parse(raw);
    convoTranscripts.set(convoId, data);
    return data;
  } catch (e) {
    // File exists but is corrupt. Salvage rather than mask as empty, so the
    // next append does not overwrite recoverable history.
    const recovered = recoverTranscriptData(raw);
    convoTranscripts.set(convoId, recovered);
    return recovered;
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

function appendTranscript(convoId, role, agentId, text, type) {
  // Load from disk if not in memory (e.g. after server restart)
  if (!convoTranscripts.has(convoId)) {
    const existing = loadTranscript(convoId);
    convoTranscripts.set(convoId, existing);
  }
  const transcript = convoTranscripts.get(convoId);
  // Soft cap at 1000 entries to prevent unbounded growth. Previously 100,
  // which was too aggressive: heavy daily-driver conversations exceeded it
  // routinely and lost middle history. 1000 covers all real-world
  // conversations with comfortable headroom; per-conversation transcript
  // file stays under ~1.4 MB at the cap, and per-message save cost stays
  // under ~20 ms. The cap is still here so the file does not grow
  // unbounded indefinitely; raising further (or removing) would shift the
  // save-cost cliff onto users with very long conversations.
  if (transcript.length >= 1000) transcript.splice(1, 1);
  // A "plain" agent message is a real chat turn; typed entries (e.g.
  // 'routing') are bookkeeping rows that carry no new session content.
  const isPlainAgentMessage = role === 'agent' && !type;
  const entry = { role, agent: agentId, text: text || '', timestamp: new Date().toISOString() };
  if (type) entry.type = type;
  transcript.push(entry);
  // Persist to disk
  saveTranscript(convoId);
  // Live search-index reconcile at end of an agent turn: by this point the
  // Claude Code session jsonl has the turn's content, so the delta read makes
  // the new messages findable immediately. Fire-and-forget; failures are
  // caught inside and reconcile-on-search covers any gap.
  if (isPlainAgentMessage) noteSearchConversationActivity(convoId);
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
    // No live clients: buffer for delivery on next connect. Ring buffer that
    // keeps the NEWEST 500: dropping the oldest on overflow preserves terminal
    // done/result signals, which are the first casualties of a keep-oldest cap
    // when >500 messages buffer during a disconnect.
    disconnectBuffer.push(payload);
    if (disconnectBuffer.length > 500) disconnectBuffer.shift();
  }
}

// Heartbeat: detect silently dead connections every 15s
// unref(): the interval must not hold the event loop open on its own. In
// production the listening server keeps the process alive and the interval
// still fires; when server.js is required as a module (Electron, tests)
// the loop can drain naturally. Behaviour is otherwise unchanged.
const HEARTBEAT_INTERVAL = 15000;
setInterval(() => {
  for (const client of connectedClients) {
    if (client._alive === false) {
      console.log('[WS] Heartbeat timeout, terminating stale connection');
      client.terminate();
      continue; // reap this dead client but keep servicing the rest
    }
    client._alive = false;
    client.ping();
  }
}, HEARTBEAT_INTERVAL).unref();

// Detects the Claude Code auth-session-expired error. When a user's `claude`
// login expires, the spawned process returns a 401 authentication error.
// Rundock can't keep that session alive, but it can recognise the signature and
// guide the user to reconnect instead of surfacing a raw 401 blob.
const AUTH_ERROR_RE = /authentication_error|invalid authentication credentials|failed to authenticate|oauth token (?:has )?expired|please run [`'"]?(?:\/|claude )?login/i;
function isAuthError(text) {
  return typeof text === 'string' && AUTH_ERROR_RE.test(text);
}

// Detects an invalid or unknown model error (e.g. a typo in an agent's `model`
// field). Rare now that Rundock always passes an explicit valid --model, but it
// surfaces a clear message instead of a cryptic one if it ever happens.
const MODEL_ERROR_RE = /issue with the selected model|invalid model|unknown model|model[^a-z]*(?:not found|not available|not recognised|not recognized|is not valid|does not exist)/i;
function isModelError(text) {
  return typeof text === 'string' && MODEL_ERROR_RE.test(text);
}

// Emits the structured auth-error message the client renders as a recovery card.
// Fires at most once per process so chunked stderr can't spam the chat.
function sendAuthError(entry, convoId) {
  if (entry.authErrorSent) return;
  entry.authErrorSent = true;
  _claudeAuthEvidence = false; // runtime status: sign-in is demonstrably broken
  safeSend(JSON.stringify({
    type: 'system', subtype: 'auth_error',
    _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId
  }));
}

// Surfaces a clear, one-time message when the selected model is invalid.
function sendModelError(entry, convoId) {
  if (entry.modelErrorSent) return;
  entry.modelErrorSent = true;
  safeSend(JSON.stringify({
    type: 'error',
    content: "The model set for this agent isn't valid. Open the agent's profile and set its model to opus, sonnet, or haiku. Rundock uses sonnet by default when no model is set.",
    _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId
  }));
}

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
      if (entry.exited) break; // per-line guard: stop once a mid-chunk kill sets exited
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
                  // Save orchestrator's response to transcript before killing the process.
                  // The result event won't fire after SIGKILL so we must persist here.
                  // With prose: append the prose (with tools prefix) as a regular agent
                  // entry so it renders in the chat and survives navigate-away/back.
                  // Without prose: still append a routing-typed entry so the orchestrator's
                  // turn is recorded in the transcript (otherwise the turn is invisible
                  // on rehydrate). The renderer skips routing entries from chat bubbles.
                  if (entry.responseText) {
                    const toolSummary = buildToolSummary(entry.toolCalls);
                    const textWithTools = toolSummary ? toolSummary + '\n' + entry.responseText : entry.responseText;
                    appendTranscript(convoId, 'agent', entry.agentId, textWithTools);
                  } else {
                    const toolSummary = buildToolSummary(entry.toolCalls);
                    appendTranscript(convoId, 'agent', entry.agentId, toolSummary, 'routing');
                  }
                  try { entry.process.kill('SIGKILL'); } catch (e) {}
                  entry.exited = true;
                  // Order matters: handleDelegation sends agent_switch synchronously,
                  // which the client uses to promote the orchestrator's streaming
                  // bubble (state.currentStreamingMsg) into a permanent message.
                  // If 'done' fires first, finishProcessing nulls currentStreamingMsg
                  // and the handoff text is orphaned. Send 'done' AFTER handleDelegation
                  // so agent_switch (and the specialist's process_started, also sent
                  // inside handleDelegation) reach the client first. By then
                  // activeProcessId points at the specialist, so the orchestrator's
                  // 'done' fails the process-id match in finishProcessing — exactly
                  // what we want: the orchestrator's working indicator clears via
                  // agent_switch, not via 'done'.
                  handleDelegation({
                    type: 'delegate', conversationId: convoId,
                    targetAgent: target.name,
                    context: toolInput.prompt || toolInput.description || 'Handle this request.',
                    _intercepted: true, _parentSessionId: entry.sessionId, _parentAgentId: entry.agentId
                  }, chatProcesses);
                  safeSend(JSON.stringify({ type: 'system', subtype: 'done', code: 0, _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId }));
                } else {
                  // Impersonation guard: an explicit subagent_type naming a
                  // workspace agent OUTSIDE this caller's direct reports must
                  // not fall through, or Claude Code spawns a generic subagent
                  // wearing that agent's name (for runtime: codex agents this
                  // silently bypasses the user's runtime choice). Soft block:
                  // kill the turn and resume the caller with a corrective
                  // message so it recovers in-conversation.
                  // KNOWN LIMITATION: without a captured sessionId the caller cannot be resumed, so the block does not fire and the call falls through (pre-fix behavior). In practice init always precedes tool_use, so sessionId is present. Narrow.
                  const offRoster = findOffRosterWorkspaceMatch(entry.agentId, toolInput);
                  if (offRoster && entry.sessionId) {
                    console.log(`[AgentIntercept] convo=${convoId} agent=${entry.agentId} blocking off-roster Agent tool target: ${offRoster.name}`);
                    intercepted = true;
                    if (entry.responseText) {
                      const toolSummary = buildToolSummary(entry.toolCalls);
                      const textWithTools = toolSummary ? toolSummary + '\n' + entry.responseText : entry.responseText;
                      appendTranscript(convoId, 'agent', entry.agentId, textWithTools);
                    } else {
                      appendTranscript(convoId, 'agent', entry.agentId, buildToolSummary(entry.toolCalls), 'routing');
                    }
                    try { entry.process.kill('SIGKILL'); } catch (e) {}
                    entry.exited = true;
                    const offName = offRoster.displayName || offRoster.name;
                    safeSend(JSON.stringify({ type: 'system', subtype: 'info', content: `Blocked a handoff to ${offName}: not one of this agent's direct reports.`, _conversationId: convoId }));
                    const blockedEntry = spawnResumedProcess(convoId, entry.agentId, entry.sessionId, chatProcesses, {});
                    blockedEntry.idle = false;
                    safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: blockedEntry.processId, _agent: entry.agentId, autoContinue: true }));
                    const runtimeNote = offRoster.runtime === 'codex' ? ` ${offName} runs on a different runtime (Codex), which only their own leader can start.` : '';
                    const blockPrompt = `[SYSTEM: delegation-blocked] Your Agent tool call named "${offName}" (${offRoster.name}), a workspace agent who is not one of your direct reports, so it was NOT run. No subagent may act as ${offName}.${runtimeNote} Do not retry the same call. If the task needs ${offName}, tell the user this needs routing through ${offName}'s leader and hand back. Otherwise continue without them.`;
                    blockedEntry.process.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: blockPrompt } }) + '\n');
                  }
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
          if (/^(Read|Edit|Write|Glob|Grep|Bash|PowerShell|WebFetch|WebSearch)$/.test(toolName)) {
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

        // Accumulate response text. The partial-message delta stream is the
        // authoritative source for the turn's text (a marker streamed in
        // an earlier block must survive, so we never overwrite). The consolidated
        // `assistant` message is only a fallback for a turn that produced NO
        // deltas. Appending its blocks when deltas already ran double-counts a
        // multi-text-block message: the delta stream concatenates the blocks
        // ("AB") while the assistant message keeps them separate, and the old
        // per-block endsWith check then appended A then B -> "ABAB". Reset
        // per turn in the result handler below.
        if (parsed.type === 'stream_event' && parsed.event?.type === 'content_block_delta' && parsed.event?.delta?.type === 'text_delta' && parsed.event.delta.text) {
          entry.responseText += parsed.event.delta.text;
          entry.sawTextDelta = true;
        } else if (parsed.type === 'assistant' && parsed.message?.content && !entry.sawTextDelta) {
          for (const block of parsed.message.content) {
            if (block.type === 'text' && block.text) {
              entry.responseText += block.text;
            }
          }
        }

        // Result handling
        if (parsed.type === 'result') {
          entry.resultSent = true;
          // Surface a recovery card when the turn failed on an expired auth session.
          if (parsed.is_error && isAuthError(JSON.stringify(parsed))) {
            sendAuthError(entry, convoId);
          } else if (parsed.is_error && isModelError(JSON.stringify(parsed))) {
            sendModelError(entry, convoId);
          } else if (!parsed.is_error) {
            // A successful turn is proof of a working sign-in (runtime status).
            _claudeAuthEvidence = true;
          }
          // Attach server-tracked tool calls for activity summary
          parsed._toolCalls = entry.toolCalls || [];
          parsed._turnStartTime = entry.turnStartTime || null;
          safeSend(JSON.stringify(parsed));
          safeSend(JSON.stringify({ type: 'system', subtype: 'done', code: 0, _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId }));
          if (onResult) onResult(entry, parsed);
          entry.sawTextDelta = false; // turn boundary: next turn re-decides delta vs assistant
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
    // Expired Claude Code session: show the recovery card, not the raw 401 blob.
    // Reset the buffer after a match so the accumulated signature does not
    // short-circuit every later, unrelated stderr chunk. The card stays
    // single via the authErrorSent/modelErrorSent guards.
    // KNOWN LIMITATION: later stderr chunks after the recovery card can still forward. Cosmetic.
    if (isAuthError(stderrBuf.value)) { sendAuthError(entry, convoId); stderrBuf.value = ''; return; }
    if (isModelError(stderrBuf.value)) { sendModelError(entry, convoId); stderrBuf.value = ''; return; }
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
  const args = [...getBareArgs(), ...modelArgs(orchestrator), '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--permission-mode', permMode,
    '--allowed-tools', getAllowedToolsInteractive(),
    ...(disallowed ? ['--disallowed-tools', disallowed] : []),
    '--append-system-prompt', systemPrompt,
    '--agent', orchestrator.name];

  console.log(`[ScopeReturn] convo=${convoId} from=${specialistEntry.agentId} to=${orchestrator.id} proc=${processId}`);

  const proc = spawnClaude(args, {
    cwd: WORKSPACE,
    env: getSpawnEnv(convoId),
    stdio: ['pipe', 'pipe', 'pipe']
  }, (err) => handleChatSpawnError(err, convoId));

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
    _conversationId: convoId, _processId: processId, _agent: orchestrator.id, autoContinue: true,
    ...(wasPipelineComplete ? { silent: true } : {}) }));

  // Circuit breaker: check consecutive auto-resume count before sending prompt.
  // COMPLETE paths are low-risk (orchestrator goes silent) but still count.
  const resumeCount = incrementAutoResume(convoId);
  if (resumeCount >= MAX_CONSECUTIVE_AGENT_RESUMES) {
    console.log(`[CircuitBreaker] convo=${convoId} ${resumeCount} consecutive agent resumes in handleScopeReturn, pausing orchestrator`);
    resetAutoResume(convoId);
    orchEntry.idle = true;
    safeSend(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: `[Auto-paused: ${resumeCount} consecutive agent handoffs without user input. Last specialist: ${specialistEntry.agentId}. Please review the output above and send your next message to continue.]` }, _agent: orchestrator.id, _conversationId: convoId }));
  } else {
    // Build context for orchestrator. Both shapes inject the specialist's final output
    // so the orchestrator has visibility into what was delivered. Without this, the
    // orchestrator's JSONL only contains its own pre-delegation state and it has to
    // guess or re-read files to know what the specialist did.
    const specialistOutput = sanitizeSpecialistOutput(specialistEntry.finalResponseText || specialistEntry.responseText);
    const outputBlock = specialistOutput
      ? `\n\n--- ${specialistEntry.agentId} ---\n${specialistOutput}\n---`
      : '';
    let prompt;
    if (wasPipelineComplete) {
      prompt = `[SYSTEM: pipeline-complete] ${specialistEntry.agentId} has finished the delegated work. Here is their final message to the conversation:${outputBlock}\n\nYour output for this turn MUST be exactly the literal string <silent> and nothing else. Do not narrate, summarise, or quote the specialist's output. Do not invoke any tools. Do not emit any other text. Just output <silent> and stop.`;
    } else {
      const pendingRequest = specialistEntry.lastUserMessage || '';
      prompt = `[SYSTEM: routing-request] ${specialistEntry.agentId} returned because the request was outside their scope. Here is what they said:${outputBlock}\n\nThe user's latest request was: "${pendingRequest}". Respond with full awareness of what ${specialistEntry.agentId} delivered. Do not re-delegate work already done. Route to the right specialist using the Agent tool.`;
    }

    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
  }

  wireProcessHandlers(orchEntry, convoId, null, {
    enableInterception: true,
    onResult: (e) => {
      // Filter silent-park responses: strip sentinel and suppress near-empty/no-op output
      if (e.responseText && !isSilentParkResponse(e.responseText)) {
        const toolSummary = buildToolSummary(e.toolCalls);
        const textWithTools = toolSummary ? toolSummary + '\n' + e.responseText : e.responseText;
        appendTranscript(convoId, 'agent', e.agentId, textWithTools);
      }
      e.responseText = '';
      e.idle = true;
    }
  });

  proc.on('close', (orchCode) => {
    if (orchEntry.spawnFailed) return; // error handler already surfaced
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

// Respawn an orchestrator/parent with --resume as an idle, live process wired
// with the standard scope-return handlers. Used to keep a live process around
// after the loop guard blocks an immediate re-delegation: interception
// already SIGKILLed the orchestrator, so without this the turn is dropped and
// no process remains for the user to continue. The process idles waiting for
// the user's next stdin message (no prompt is written here).
function spawnResumedProcess(convoId, agentId, sessionId, processes, opts = {}) {
  const agentList = discoverAgents();
  const agentData = agentList.find(a => a.id === agentId || a.name === agentId);
  const systemPrompt = agentData ? buildSystemPrompt(agentData) : '';
  const disallowed = getDisallowedTools();
  const permMode = getPermissionMode();
  const args = [...getBareArgs(), ...modelArgs(agentData), '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--permission-mode', permMode,
    '--allowed-tools', getAllowedToolsInteractive(),
    ...(disallowed ? ['--disallowed-tools', disallowed] : [])];
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  if (agentData?.name) args.push('--agent', agentData.name);
  if (sessionId) args.push('--resume', sessionId);

  const processId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const proc = spawnClaude(args, { cwd: WORKSPACE, env: getSpawnEnv(convoId), stdio: ['pipe', 'pipe', 'pipe'] }, (err) => handleChatSpawnError(err, convoId));
  const entry = {
    process: proc, buffer: '', processId, agentId,
    responseText: '', exited: false, resultSent: false,
    pendingAgentTool: null, toolCalls: [], turnStartTime: Date.now(),
    idle: true, scopeReturnSource: opts.scopeReturnSource || null,
    handbackAt: Date.now(), // stale end_delegation guard
  };
  processes.set(convoId, entry);

  wireProcessHandlers(entry, convoId, null, {
    enableInterception: true,
    onResult: (e) => {
      const hasOutOfScope = /<!-- RUNDOCK:RETURN -->/.test(e.responseText);
      const hasComplete = /<!-- RUNDOCK:COMPLETE -->/.test(e.responseText);
      // KNOWN LIMITATION: a respawned orchestrator that emits its own RETURN/COMPLETE marker here is self-treated as a scope-return. Low/narrow.
      if ((hasOutOfScope || hasComplete) && !e.delegation) {
        e.scopeReturn = true;
        e.scopeReturnMode = hasComplete ? 'complete' : 'return';
        e.pendingKill = true;
        // No-op if a user follow-up cleared pendingKill inside the window.
        setTimeout(() => { if (!e.exited && e.pendingKill) { try { e.process.kill(); } catch (err) {} } }, 500);
      }
      if (e.responseText && !isSilentParkResponse(e.responseText)) {
        const toolSummary = buildToolSummary(e.toolCalls);
        const textWithTools = toolSummary ? toolSummary + '\n' + e.responseText : e.responseText;
        appendTranscript(convoId, 'agent', e.agentId, textWithTools);
      }
      e.finalResponseText = e.responseText;
      e.responseText = '';
      e.idle = true;
    }
  });
  proc.on('close', (rCode) => {
    if (entry.spawnFailed) return;
    entry.exited = true;
    const cur = processes.get(convoId);
    if (entry.scopeReturn && cur === entry) {
      handleScopeReturn(entry, convoId, entry.scopeReturnMode === 'complete');
      return;
    }
    if (cur === entry) processes.delete(convoId);
    safeSend(JSON.stringify({ type: 'system', subtype: 'done', code: rCode, _agent: entry.agentId, _conversationId: convoId, _processId: processId }));
  });
  return entry;
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
    const displayName = targetAgent.displayName || targetAgent.name;
    const orchestratorAgentId = isIntercepted ? (msg._parentAgentId || existing.agentId) : existing.agentId;
    // On an intercepted re-target the orchestrator was already SIGKILLed,
    // so blocking here would drop the turn and leave no live process. Respawn
    // the orchestrator idle (via --resume) so the user can continue; otherwise
    // just clear the flag on the still-live process.
    if (existing.exited && isIntercepted && msg._parentSessionId) {
      spawnResumedProcess(convoId, orchestratorAgentId, msg._parentSessionId, processes, { scopeReturnSource: null });
    } else {
      // KNOWN LIMITATION: when _parentSessionId is missing on an intercepted, already-killed orchestrator, it is not respawned (degrades to clearing the flag on a dead process). Narrow.
      existing.scopeReturnSource = null;
    }
    safeSend(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: `${displayName} has already completed this task. Send your next message to continue.` },
      _agent: orchestratorAgentId, _conversationId: convoId
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
  // Codex delegates are transactional: exec mode runs one process per turn,
  // so a delegated task is briefed, completed in one response, and control
  // returns to the parent with the output injected (the shared close handler
  // below). Direct conversations with Codex agents remain conversational via
  // thread resume; only the delegated flow is single-shot.
  const isCodexDelegate = targetAgent.runtime === 'codex';

  // Platform delegates (Doc): transactional, auto-return after task completion
  // Specialists with direct reports: multi-step pipeline, return when the pipeline is complete
  // Plain specialists: conversational, user controls when to return
  const targetHasDirectReports = !!buildTeamRoster(targetAgent.id, true);
  let delegationContext;
  if (isCodexDelegate) {
    // Transactional, and honest about the runtime's shape: a Codex exec
    // process cannot stay in the conversation to wait for a user reply, so
    // it must never promise to. Clarifications go through the handback.
    delegationContext = 'DELEGATION CONTEXT:\nYou have been delegated a task by another agent. Complete the task fully in this single response; you cannot wait for follow-up messages in this session. Prefer sensible defaults over asking questions. When the task is done, post your final summary and output <!-- RUNDOCK:COMPLETE --> at the very end of the response. If you genuinely cannot proceed without an answer from the user, state the question clearly in your response and still output <!-- RUNDOCK:COMPLETE -->; the reply will reach you when the task is re-delegated. Only use <!-- RUNDOCK:RETURN --> if the request is genuinely outside your scope and you cannot help.';
  } else if (isPlatformDelegate) {
    delegationContext = 'DELEGATION CONTEXT:\nYou have been delegated a task by another agent. Complete the task in a single response if possible. When the task is done (agent created, skill saved, file written, question answered, etc.), output <!-- RUNDOCK:COMPLETE --> at the very end of that same response. Do not wait for follow-up questions. Do not ask if there is anything else. Just complete the task, confirm what you did, and return immediately. If you genuinely need clarification before you can proceed, ask, but prefer using sensible defaults over asking.\n\nException: if you have proposed a plan and are waiting for the user to confirm before you execute (e.g. you asked them to say "go ahead"), do NOT emit COMPLETE. Stay in the conversation and wait for their response. Only emit COMPLETE once the task is genuinely finished: you executed the work, or you answered the question fully with no pending user decision.\n\nOnly use <!-- RUNDOCK:RETURN --> if the request is genuinely outside your scope and you cannot help. This is rare.';
  } else if (targetHasDirectReports) {
    delegationContext = 'DELEGATION CONTEXT:\nYou have been brought into this conversation by the orchestrator to run a task in your domain. You lead a support team and may delegate parts of the work to them. Do the real work, write the deliverables, and report the outcome.\n\nYou MUST hand control back using one of two markers, on its own line, as the very last thing in your response (after any final summary):\n\n- <!-- RUNDOCK:RETURN --> when the user asks for something outside your domain of expertise. Tell them briefly that this falls outside what you handle and you are handing them back so the right person can pick it up. Do NOT name other specialists or suggest who should handle it. Then emit the marker.\n\n- <!-- RUNDOCK:COMPLETE --> when the orchestrator\'s original delegated pipeline is finished end-to-end. All deliverables are written to their final locations and the workflow has reached its final status (for example content moved to Ready for Review, spec written and linked, final audit posted). Post your final summary first, then emit the marker.\n\nDo NOT emit either marker when you are pausing at a decision point to let the user choose between options, presenting drafts, hooks, options, or recommendations for user review, asking the user to confirm something before continuing, or waiting at a human gate midway through a multi-phase pipeline. Those are pauses, not completions. Stay in the conversation as the active agent and wait for the user\'s next message. You will pick up where you left off when they respond.\n\nReturning on completion is how control flows back up the chain. If you silently stop, the user\'s next message will be routed to the wrong agent.';
  } else {
    delegationContext = 'DELEGATION CONTEXT:\nYou have been brought into this conversation by the orchestrator to handle a specific request. Help the user with their request. Have a natural conversation. Stay in the conversation and keep helping with follow-up questions in your domain.\n\nIMPORTANT: Do NOT return after completing a single task. The user may have more questions for you. Wait for their next message.\n\nOnly return to the orchestrator (output <!-- RUNDOCK:RETURN --> at the very end of your response) when:\n- The user asks for something outside your area of expertise. Tell them briefly that this falls outside what you handle and you are handing them back so the right person can pick it up. Do NOT name other specialists or suggest who should handle it. That is the orchestrator\'s job. Then output the RETURN marker.\n\nDo not attempt tasks you are not designed for. Hand back promptly so the orchestrator can route correctly.';
  }

  const systemPrompt = buildSystemPrompt(targetAgent);
  const fullPrompt = systemPrompt + '\n\n' + delegationContext;

  // Look up prior session for this target agent in this conversation.
  // If found, resume instead of cold-spawning so the delegate retains its
  // internal context (tool results, reasoning, working state) from earlier turns.
  // Platform delegates are excluded: they are transactional one-shot processes.
  let priorSessionId = null;
  if (!isPlatformDelegate) {
    try {
      const convos = readConversations();
      const convo = convos.find(c => c.id === convoId);
      if (convo && convo.sessionIds) {
        const match = convo.sessionIds.filter(s => s.agentId === targetAgent.id).pop();
        if (match) priorSessionId = match.sessionId;
      }
    } catch (e) { /* cold spawn on failure */ }
  }

  const delegateDisallowed = getDisallowedTools();
  const delegatePermMode = getPermissionMode();
  const delegateArgs = [...getBareArgs(), ...modelArgs(targetAgent), '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--permission-mode', delegatePermMode,
    '--allowed-tools', getAllowedToolsInteractive(),
    ...(delegateDisallowed ? ['--disallowed-tools', delegateDisallowed] : []),
    '--append-system-prompt', fullPrompt,
    ...(priorSessionId ? ['--resume', priorSessionId] : []),
    '--agent', targetAgent.name];

  console.log(`[Delegate] convo=${convoId} from=${originalAgentId} to=${targetAgent.id} proc=${delegateProcessId} runtime=${targetAgent.runtime}${priorSessionId ? ` resume=${priorSessionId}` : ''}`);

  // Normalised for the codex path: argv and prompt must agree on whether
  // this is a resume (see startCodexTurn for the identity-loss hazard).
  const codexResumeId = isCodexDelegate && codexRuntime.isValidThreadId(priorSessionId) ? priorSessionId : null;
  const delegateProc = isCodexDelegate
    ? spawnCodex(codexRuntime.buildCodexArgs({ resumeThreadId: codexResumeId, model: targetAgent.model || undefined }), {
        cwd: WORKSPACE,
        env: getSpawnEnv(convoId),
        stdio: ['pipe', 'pipe', 'pipe']
      }, (err) => handleCodexSpawnError(err, convoId))
    : spawnClaude(delegateArgs, {
        cwd: WORKSPACE,
        env: getSpawnEnv(convoId),
        stdio: ['pipe', 'pipe', 'pipe']
      }, (err) => handleChatSpawnError(err, convoId));

  const delegateEntry = {
    process: delegateProc, runtime: targetAgent.runtime, buffer: '', processId: delegateProcessId,
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

  // Send context as first message:
  // - Resumed delegate: brief only (session has prior context on disk)
  // - Intercepted cold spawn: brief only (orchestrator's brief is sufficient)
  // - Non-intercepted cold spawn: full transcript as safety net
  const needsTranscript = !priorSessionId && !isIntercepted;
  const transcript = needsTranscript ? formatTranscript(convoId) : null;
  const contextWithHistory = transcript
    ? `CONVERSATION SO FAR:\n${transcript}\n\nYOUR TASK:\n${msg.context}`
    : `[DELEGATION BRIEF]\n${msg.context}`;

  if (isCodexDelegate) {
    // Codex takes the whole prompt over stdin: identity + platform rules +
    // delegation contract on a cold spawn (Codex has no --agent or
    // --append-system-prompt equivalent); contract + brief on a resumed
    // thread (instructions are already in the thread). Delegated turns get
    // the same Windows write-marker fallback as direct chats: instruction
    // on cold spawns, marker handling flagged on the entry either way.
    delegateEntry.writeMarkersEnabled = codexWriteMarkersEnabled();
    const codexPrompt = codexResumeId
      ? `${delegationContext}\n\n${contextWithHistory}`
      : [readAgentInstructions(targetAgent), fullPrompt, buildWindowsWriteNote(delegateEntry.writeMarkersEnabled), contextWithHistory].filter(Boolean).join('\n\n');
    startCodexKeepalive(delegateEntry, convoId);
    wireCodexDelegate(delegateEntry, convoId, codexPrompt);
  } else {
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
        e.pendingKill = true; // a user follow-up in this window cancels the auto-return
        setTimeout(() => {
          if (!e.exited && e.pendingKill) { // no-op if the follow-up cleared pendingKill
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
  }

  delegateProc.on('close', (code) => {
    if (delegateEntry.spawnFailed) return; // error handler already surfaced
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
        orchestratorEntry.handbackAt = Date.now(); // stale end_delegation guard
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
      const resumeArgs = [...getBareArgs(), ...modelArgs(parentAgentData), '--output-format', 'stream-json', '--input-format', 'stream-json',
        '--verbose', '--include-partial-messages', '--permission-mode', resumePermMode,
        '--allowed-tools', getAllowedToolsInteractive(),
        ...(resumeDisallowed ? ['--disallowed-tools', resumeDisallowed] : [])];
      if (parentSystemPrompt) resumeArgs.push('--append-system-prompt', parentSystemPrompt);
      if (parentAgentData?.name) resumeArgs.push('--agent', parentAgentData.name);
      if (parentSessionId) resumeArgs.push('--resume', parentSessionId);

      const resumeProcessId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const resumeProc = spawnClaude(resumeArgs, {
        cwd: WORKSPACE,
        env: getSpawnEnv(convoId),
        stdio: ['pipe', 'pipe', 'pipe']
      }, (err) => handleChatSpawnError(err, convoId));

      const resumeEntry = {
        process: resumeProc, buffer: '', processId: resumeProcessId,
        agentId: parentAgentId, responseText: '', exited: false, resultSent: false,
        pendingAgentTool: null,
        toolCalls: [], turnStartTime: Date.now(),
        // Tag with returning specialist so handleDelegation's scopeReturnSource
        // guard blocks immediate re-delegation to the same agent. Only set for
        // out-of-scope returns; pipeline-complete should allow re-delegation.
        scopeReturnSource: isOutOfScope ? delegateEntry.agentId : null,
        handbackAt: Date.now() // stale end_delegation guard
      };
      processes.set(convoId, resumeEntry);

      // Auto-prompt only on out-of-scope: parent is resumed with a routing request so
      // it can delegate the pending user message to a different specialist. For
      // pipeline-complete and no-marker exits, the parent restarts silently and waits
      // for the user's next message. In the single-level case (delegate was direct
      // from the orchestrator, so the parent IS the orchestrator), this is all that's
      // needed. In deeper chains, the pipeline-complete marker would have fired the
      // skip-level orchestratorEntry branch above and never reached this code path.
      // Inject specialist output into the handback prompt so the parent has
      // visibility into what was delivered. The parent's --resume session only
      // contains its own pre-delegation state; the specialist's work is invisible
      // without this injection.
      const delegateOutput = sanitizeSpecialistOutput(delegateEntry.finalResponseText || delegateEntry.responseText);
      const delegateOutputBlock = delegateOutput
        ? `\n\n--- ${delegateEntry.agentId} ---\n${delegateOutput}\n---`
        : '';

      if (isOutOfScope) {
        const resumeCount = incrementAutoResume(convoId);
        if (resumeCount >= MAX_CONSECUTIVE_AGENT_RESUMES) {
          console.log(`[CircuitBreaker] convo=${convoId} ${resumeCount} consecutive agent resumes on parked-parent RETURN path, pausing`);
          resetAutoResume(convoId);
          resumeEntry.idle = true;
          safeSend(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: `[Auto-paused: ${resumeCount} consecutive agent handoffs without user input. Last specialist: ${delegateEntry.agentId}. Please review the output above and send your next message to continue.]` }, _agent: delegateEntry.delegation.originalAgentId, _conversationId: convoId }));
        } else {
          safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: resumeProcessId, _agent: parentAgentId, autoContinue: true }));

          const resumePrompt = `[SYSTEM: ${delegateEntry.agentId} returned because the request was outside their scope. Here is what they said:${delegateOutputBlock}\n\nThe user's latest request was: "${delegateEntry.lastUserMessage || 'continue'}". Respond with full awareness of what ${delegateEntry.agentId} delivered. Do not re-delegate work already done. Route to the right specialist using the Agent tool.]`;
          resumeProc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: resumePrompt } }) + '\n');
        }
      } else if (isPipelineComplete) {
        // Park silently but inject specialist output so the next user message
        // resumes with real context about what was delivered.
        safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: resumeProcessId, _agent: parentAgentId, autoContinue: true, silent: true }));
        const completePrompt = `[SYSTEM: pipeline-complete] ${delegateEntry.agentId} has finished the delegated work. Here is their final message to the conversation:${delegateOutputBlock}\n\nYour output for this turn MUST be exactly the literal string <silent> and nothing else. Do not narrate, summarise, or quote the specialist's output. Do not invoke any tools. Do not emit any other text. Just output <silent> and stop.`;
        resumeProc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: completePrompt } }) + '\n');
        resumeEntry.idle = true;
        console.log(`[AgentIntercept] convo=${convoId} delegate emitted COMPLETE, parent ${parentAgentId} parked with specialist output`);
      } else {
        // Normal exit (no marker). Inject specialist output for context, then park.
        safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: resumeProcessId, _agent: parentAgentId, autoContinue: true, silent: true }));
        const normalPrompt = `[SYSTEM: pipeline-complete] ${delegateEntry.agentId} completed their work. Here is their final message to the conversation:${delegateOutputBlock}\n\nYour output for this turn MUST be exactly the literal string <silent> and nothing else. Do not narrate, summarise, or quote the specialist's output. Do not invoke any tools. Do not emit any other text. Just output <silent> and stop.`;
        resumeProc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: normalPrompt } }) + '\n');
        resumeEntry.idle = true;
        console.log(`[AgentIntercept] convo=${convoId} delegate completed normally, parent ${parentAgentId} parked with specialist output`);
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
            e.pendingKill = true; // a user follow-up in this window cancels the auto-return
            setTimeout(() => {
              if (!e.exited && e.pendingKill) { // no-op if the follow-up cleared pendingKill
                try { e.process.kill(); } catch (err) {}
              }
            }, 500);
          }
          // Filter silent-park responses: strip sentinel and suppress near-empty/no-op output
          if (e.responseText && !isSilentParkResponse(e.responseText)) {
            const toolSummary = buildToolSummary(e.toolCalls);
            const textWithTools = toolSummary ? toolSummary + '\n' + e.responseText : e.responseText;
            appendTranscript(convoId, 'agent', e.agentId, textWithTools);
          }
          // Mirror the delegate (~2673) and direct-start (~3134) paths:
          // preserve the final text so a later handleScopeReturn injects the real
          // specialist output into the orchestrator prompt, not an empty block.
          e.finalResponseText = e.responseText;
          e.responseText = '';
          e.idle = true;
        }
      });
      resumeProc.on('close', (rCode) => {
        if (resumeEntry.spawnFailed) return; // error handler already surfaced
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
      orig.handbackAt = Date.now(); // stale end_delegation guard
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
    active.push({ conversationId: convoId, processId: entry.processId, agentId: entry.agentId, idle: !!entry.idle, responseText: entry.responseText || '', delegation: entry.delegation ? { originalAgentId: entry.delegation.originalAgentId } : null });
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

        // Track user messages in conversation transcript. Skip on a resume-
        // failure retry (_resumeRetry): the message was already appended on the
        // first pass, and the retry re-emits the same message into this handler
        // (which would otherwise double-append).
        if (!msg._resumeRetry) {
          appendTranscript(convoId, 'user', 'user', msg.content);
        }

        // ── RUNTIME ROUTING ────────────────────────────────────────────
        // Codex agents run one process per turn (exec mode) instead of a
        // long-lived stdin conversation. Route them before the interactive
        // path; agents without runtime: codex are entirely unaffected.
        {
          const requestedAgent = msg.agent || 'default';
          const agentList = discoverAgents();
          const routedAgent = agentList.find(a => a.id === requestedAgent)
            || agentList.find(a => a.fileName && a.fileName.replace('.md', '') === requestedAgent);
          if (routedAgent && routedAgent.runtime === 'codex') {
            startCodexTurn(convoId, msg, routedAgent);
            return;
          }
        }

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

          // KNOWN LIMITATION: kill-already-fired race. A follow-up arriving in the SIGTERM-to-close gap passes this gate (no !existing.process.killed check) and writes to a dying process; on non-delegate paths the handback is dropped and the message lost. Clean fix is a state-machine change (queue the follow-up until close/handback completes, then re-route), not a point-fix.
          if (existing && !existing.exited && existing.process.stdin && existing.process.stdin.writable) {
            const processId = existing.processId;
            console.log(`[Chat] convo=${convoId} proc=${processId} FOLLOW-UP (interactive stdin)`);
            // A user follow-up that lands inside a pending 500ms auto-return kill
            // window CANCELS the auto-return and is served by the still-live
            // process. Clearing pendingKill makes the scheduled kill timer
            // a no-op; clearing the scope-return/marker flags stops the eventual
            // close handler from acting on a handoff the user has superseded.
            // Previously the write path excluded a pendingKill process, so the
            // follow-up fell through to spawn-fresh, which killed the live process
            // and deleted the map entry BEFORE its close handler ran, dropping the
            // handback and leaking the parked parent.
            existing.pendingKill = false;
            existing.scopeReturn = false;
            existing.scopeReturnMode = null;
            existing.returnMarkerSeen = null;
            // Clear the superseded turn's captured output too. onResult
            // stashes the marker-bearing text in finalResponseText and resets
            // responseText. If the live process later dies abnormally BEFORE its
            // next result, the delegate close handler's fallback marker-scan reads
            // finalResponseText (it wins the `|| responseText` because responseText
            // was reset) and fires a SPURIOUS handback for a follow-up the user
            // expected the live process to answer. Nothing depends on the old value
            // surviving a cancel: the handback is cancelled (no output to inject),
            // and the next turn's onResult sets it fresh.
            existing.finalResponseText = '';
            existing.sawTextDelta = false; // reset per-turn text-source flag (defensive)
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

            const args = [...getBareArgs(), ...modelArgs(agentData), '--output-format', 'stream-json', '--input-format', 'stream-json',
              '--verbose', '--include-partial-messages', '--permission-mode', chatPermMode,
              '--allowed-tools', getAllowedToolsInteractive(),
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

            console.log(`[Chat] convo=${convoId} proc=${processId} agent=${msg.agent} sessionId=${msg.sessionId||'new'} mode=interactive model=${args[args.indexOf('--model')+1]||'(default)'} args=${args.filter(a=>a.startsWith('--')).join(' ')}`);

            const proc = spawnClaude(args, {
              cwd: WORKSPACE,
              env: getSpawnEnv(convoId),
              stdio: ['pipe', 'pipe', 'pipe']
            }, (err) => handleChatSpawnError(err, convoId));

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
                  // COMPLETE takes priority when both markers are present, matching
                  // every other path (delegate/resumed-parent). Previously inverted
                  // to 'return' on both-markers here.
                  e.scopeReturnMode = hasComplete ? 'complete' : 'return';
                  console.log(`[ScopeReturn] convo=${convoId} agent=${e.agentId} ${e.scopeReturnMode} marker on non-delegated process`);
                  e.pendingKill = true; // a user follow-up in this window cancels the auto-return
                  setTimeout(() => {
                    if (!e.exited && e.pendingKill) { // no-op if the follow-up cleared pendingKill
                      try { e.process.kill(); } catch (err) {}
                    }
                  }, 500);
                }
                // Preserve the specialist output for handleScopeReturn:
                // mirror the delegate path so a direct RETURN injects the real
                // output into the orchestrator prompt, not an empty block.
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

            proc.on('close', (code) => {
              if (entry.spawnFailed) return; // error handler already surfaced
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

              // Detect stale session and retry fresh. Exclude cancelled turns:
              // cancel sends SIGTERM (code===null !== 0) and a cancelled resumed
              // conversation whose stderr mentions session/resume/not found would
              // otherwise replay the original prompt.
              const isResumeFailure = msg.sessionId && !msg._resumeRetry && !entry.cancelled && code !== 0 &&
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

          // Look up agent data first so modelArgs/--agent resolve. Previously
          // referenced below before it was block-scoped, throwing a
          // ReferenceError on every legacy message (gated behind
          // RUNDOCK_LEGACY_SPAWN=1).
          const legacyAgentList = discoverAgents();
          const legacyRequestedAgent = msg.agent || 'default';
          const agentData = legacyAgentList.find(a => a.id === legacyRequestedAgent)
            || legacyAgentList.find(a => a.fileName && a.fileName.replace('.md', '') === legacyRequestedAgent);

          const legacyDisallowed = getDisallowedTools();
          const legacyPermMode = getPermissionMode();
          const args = [...getBareArgs(), ...modelArgs(agentData), '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
            '--verbose', '--include-partial-messages', '--permission-mode', legacyPermMode,
            '--allowed-tools', getAllowedToolsLegacy(),
            ...(legacyDisallowed ? ['--disallowed-tools', legacyDisallowed] : []),
            '--append-system-prompt', 'FORMATTING RULES (mandatory, apply to all output):\n- NEVER use em dashes (—) or en dashes (–) anywhere. This includes lists, headers, separators, and inline text. Wrong: "AI — your assistant". Right: "AI: your assistant". Use colons, full stops, commas, or restructure instead.\n- Use UK spelling throughout.\n\nPLATFORM RULES:\nRundock is a knowledge management platform. You can create and edit markdown, YAML, JSON, and text files. Executable code files (.js, .ts, .py, .sh, etc.) are outside the supported file types. Destructive commands (rm, sudo, chmod) are not supported. If a user asks you to do something outside these capabilities, explain that Rundock is designed for knowledge work and suggest an alternative approach using supported file types.'];

          if (msg.sessionId) {
            args.push('--resume', msg.sessionId);
          }

          if (!msg.sessionId) {
            if (agentData && agentData.fileName) {
              args.push('--agent', agentData.name);
            }
          }

          console.log(`[Chat] convo=${convoId} proc=${processId} agent=${msg.agent} sessionId=${msg.sessionId||'new'} mode=legacy model=${args[args.indexOf('--model')+1]||'(default)'} args=${args.filter(a=>a.startsWith('--')).join(' ')}`);

          const proc = spawnClaude(args, {
            cwd: WORKSPACE,
            env: getSpawnEnv(convoId),
            stdio: ['pipe', 'pipe', 'pipe']
          }, (err) => handleChatSpawnError(err, convoId));

          const entry = { process: proc, buffer: '', processId, agentId: msg.agent || 'default', responseText: '', exited: false, resultSent: false, lastUserMessage: msg.content, toolCalls: [], turnStartTime: Date.now() };
          processes.set(convoId, entry);

          safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: processId, _agent: entry.agentId }));

          proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: msg.content } }) + '\n');

          // Legacy mode: no interception, no transcript, no idle tracking
          const legacyStderrRef = wireProcessHandlers(entry, convoId, ws, {
            enableInterception: false
          });

          proc.on('close', (code) => {
            if (entry.spawnFailed) return; // error handler already surfaced
            entry.exited = true;
            const current = processes.get(convoId);
            if (current && current.processId !== processId) return;

            const isResumeFailure = msg.sessionId && !msg._resumeRetry && !entry.cancelled && code !== 0 &&
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
          if (pending.res) {
            // Hook-originated request: answer the held HTTP response.
            pending.res.writeHead(200, { 'Content-Type': 'application/json' });
            pending.res.end(JSON.stringify({ allow: msg.allow }));
          } else if (pending.onDecision) {
            // Server-originated request (e.g. Codex write markers): callback.
            try { pending.onDecision(msg.allow === true, 'user'); } catch (e) { console.error('[Permission] onDecision threw:', e); }
          }
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
                if (pending.res) {
                  pending.res.writeHead(200, { 'Content-Type': 'application/json' });
                  pending.res.end(JSON.stringify({ allow: false, reason: 'cancelled' }));
                } else if (pending.onDecision) {
                  pending.onDecision(false, 'cancelled');
                }
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

          // If this is a delegate, also kill every parked ANCESTOR. Walk the
          // full parent chain rather than only orchestratorEntry, which is null
          // for non-intercepted nested WS-delegate chains and would otherwise
          // leak the grandparent orchestrator as a live process.
          if (entry.delegation) {
            const killParked = (e) => {
              if (!e || e.exited) return;
              e.exited = true;
              e.cancelled = true;
              try { e.process.kill('SIGTERM'); } catch (err) {}
              setTimeout(() => { try { e.process.kill('SIGKILL'); } catch (err) {} }, 2000);
              console.log(`[Cancel] convo=${convoId} also killed parked ancestor agent=${e.agentId}`);
            };
            const seen = new Set([entry]);
            let d = entry.delegation;
            let depth = 0;
            while (d && depth++ < 50) {
              if (d.orchestratorEntry && !seen.has(d.orchestratorEntry)) {
                seen.add(d.orchestratorEntry);
                killParked(d.orchestratorEntry);
              }
              const parent = d.originalEntry;
              if (!parent || seen.has(parent)) break;
              seen.add(parent);
              killParked(parent);
              d = parent.delegation;
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
        // Clear stale workspace pointer if the directory no longer exists
        if (WORKSPACE && !fs.existsSync(WORKSPACE)) {
          console.log(`[Workspace] Current workspace no longer exists: ${WORKSPACE}`);
          WORKSPACE = null;
        }
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
          // A workspace switch (including re-selecting the same one) is the
          // retry trigger for a failed search-engine open, and must not
          // serve the previous workspace's cached file/skill lists.
          searchEngineFailedWorkspace = null;
          invalidateAgentCache();
          loadRoutineState();
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
          // Warm the search index off the open path (reconcile-on-open);
          // ensureSearchEngine also self-heals lazily on first search.
          setImmediate(() => { try { ensureSearchEngine(); } catch (e) { console.warn('[Search] warm-up failed:', e.message); } });
        } else {
          ws.send(JSON.stringify({ type: 'workspace_error', message: 'Directory not found' }));
        }
      }

      if (msg.type === 'pick_folder') {
        // Async execFile (not the blocking sync variant) so the native folder
        // dialog does not stall the event loop for up to 60s, freezing all
        // streams, heartbeats and permission long-polls. The args array
        // also avoids shell parsing.
        const { execFile } = require('child_process');
        // KNOWN LIMITATION: concurrent pick_folder requests spawn overlapping osascript dialogs (not serialized). Cosmetic.
        execFile('osascript',
          ['-e', 'POSIX path of (choose folder with prompt "Choose a workspace folder")'],
          { encoding: 'utf-8', timeout: 60000 },
          (err, stdout) => {
            if (err) {
              // User cancelled or osascript failed
              ws.send(JSON.stringify({ type: 'folder_picked', path: null }));
              return;
            }
            const result = (stdout || '').trim();
            if (result) {
              // Remove trailing slash if present
              const dir = result.endsWith('/') ? result.slice(0, -1) : result;
              ws.send(JSON.stringify({ type: 'folder_picked', path: dir }));
            } else {
              ws.send(JSON.stringify({ type: 'folder_picked', path: null }));
            }
          });
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
            loadRoutineState();
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
      if (msg.type === 'get_runtime_status') {
        ws.send(JSON.stringify({ type: 'runtime_status', ...getRuntimeStatus() }));
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
        let convosChanged = cleaned.length < convos.length;
        // Reconcile activeAgentId on load. A pointer to a delegatee is stale
        // ONLY when there is no live process: the orchestrator resumes after a
        // delegate returns or the conversation goes idle. Skip any conversation
        // with a live process, whose activeAgentId (a live delegate) is
        // legitimate and must not be clobbered mid-delegation.
        for (const c of cleaned) {
          if (c.activeAgentId && c.activeAgentId !== c.agentId && !chatProcesses.has(c.id)) {
            c.activeAgentId = c.agentId;
            convosChanged = true;
          }
        }
        // Persist at most once per load, and only when something changed
        // (previously wrote unconditionally, up to twice per load).
        if (convosChanged) writeConversations(cleaned);
        // Strip markdown formatting for plain-text previews (mirrors frontend stripMd)
        function stripMdServer(t) {
          return t
            .replace(/\*\*(.*?)\*\*/g, '$1')       // bold
            .replace(/\*(.*?)\*/g, '$1')            // italic *
            .replace(/_(.*?)_/g, '$1')              // italic _
            .replace(/~~(.*?)~~/g, '$1')            // strikethrough
            .replace(/`([^`]+)`/g, '$1')            // inline code
            .replace(/^#+\s*/gm, '')                // headings
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
            .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2') // wikilinks with alias
            .replace(/\[\[([^\]]+)\]\]/g, '$1')     // wikilinks
            .replace(/==(.*?)==/g, '$1')             // highlights
            .replace(/^[\s]*[-*+]\s/gm, '');         // list markers
        }
        // Enrich each conversation for sidebar/profile display. Two passes:
        //   1. messageCount: sum of user/assistant chat-bubble turns across
        //      every Claude Code session JSONL the conversation touches. This
        //      is the canonical source — Rundock's own transcript only covers
        //      messages emitted after appendTranscript started running and is
        //      partial or missing for older conversations.
        //   2. lastAgentId / lastMessagePreview: still sourced from the
        //      transcript, which is the only place the orchestrator/specialist
        //      attribution is recorded for the last visible turn.
        for (const c of cleaned) {
          try { c.messageCount = countConversationMessages(c); }
          catch (e) { c.messageCount = 0; }
          try {
            const transcript = loadTranscript(c.id);
            if (!transcript || !transcript.length) continue;
            for (let i = transcript.length - 1; i >= 0; i--) {
              const entry = transcript[i];
              if (entry.role === 'agent' && entry.text) {
                c.lastAgentId = entry.agent || null;
                c.lastMessagePreview = stripMdServer(
                  entry.text
                    .replace(/<!-- RUNDOCK:(?:SAVE|CREATE)_AGENT name=[\w-]+ -->[\s\S]*?<!-- \/RUNDOCK:(?:SAVE|CREATE)_AGENT -->/g, '')
                    .replace(/<!-- RUNDOCK:SAVE_SKILL name=[\w-]+ -->[\s\S]*?<!-- \/RUNDOCK:SAVE_SKILL -->/g, '')
                    .replace(/<!--[\s\S]*?-->/g, '')
                    .replace(/\n/g, ' ')
                    .replace(/^(\s*\[[^\]]+\]\s*)+/, '')
                ).trim().substring(0, 80);
                break;
              }
            }
          } catch (e) { /* preview enrichment is best-effort */ }
        }
        const lastActiveConversationId = readState().lastActiveConversationId || null;
        ws.send(JSON.stringify({ type: 'conversations', conversations: cleaned, lastActiveConversationId }));
      }

      if (msg.type === 'set_last_active_conversation') {
        if (!WORKSPACE) return;
        const state = readState();
        if (msg.id) state.lastActiveConversationId = msg.id;
        else delete state.lastActiveConversationId;
        writeState(state);
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
          // KNOWN LIMITATION: follow-up racing explicit end_delegation. This kills immediately and uncancellably while setting scopeReturn; a follow-up landing in the kill-to-close gap clears scopeReturn (follow-up clear block) and drops the committed handback. Needs the same queue-and-re-route state machine as the kill-already-fired race above.
          try { current.process.kill(); } catch (e) {}
          // The close handler will restore the original process
        } else if (current && !current.delegation && !current.exited && !current.scopeReturn) {
          // Specialist started directly (no delegation) emitted RETURN
          // Server-side onResult should have caught this, but handle as fallback.
          // Stale-message guard, two signals:
          // 1. An entry restored/respawned by a delegate close handler within
          //    the last 15s (handbackAt): a fast-exiting delegate (e.g. Codex)
          //    can be handed back server-side before the client's marker scan
          //    round-trips, so the late end_delegation refers to a handback
          //    that already happened, for ANY parent type. Killing the
          //    restored parent would drop its session.
          // 2. An orchestrator or platform agent never emits RETURN, so the
          //    fallback can never be legitimate for one.
          const recentlyHandedBack = current.handbackAt && (Date.now() - current.handbackAt) < 15000;
          const agentList = discoverAgents();
          const currentAgent = agentList.find(a => a.id === current.agentId || a.name === current.agentId);
          if (recentlyHandedBack || (currentAgent && (currentAgent.type === 'orchestrator' || currentAgent.type === 'platform'))) {
            console.log(`[ScopeReturn] convo=${convoId} ignoring stale end_delegation for ${current.agentId} (${recentlyHandedBack ? 'recent handback' : currentAgent.type})`);
          } else {
            console.log(`[ScopeReturn] convo=${convoId} end_delegation fallback for non-delegated specialist`);
            current.scopeReturn = true;
            try { current.process.kill(); } catch (e) {}
            // The close handler will call handleScopeReturn
          }
        }
      }

      if (msg.type === 'delete_conversation') {
        if (!WORKSPACE || !msg.id) return;
        const convos = readConversations().filter(c => c.id !== msg.id);
        writeConversations(convos);
        // Drop the conversation's rows from the search index (spec: a
        // deleted conversation no longer appears in results).
        if (ensureSearchEngine()) {
          try { searchEngine.removeConversation(msg.id); } catch (e) { /* rebuild covers it */ }
        }
        ws.send(JSON.stringify({ type: 'conversation_deleted', id: msg.id }));
      }

      if (msg.type === 'read_file') {
        const fullPath = path.resolve(WORKSPACE, msg.path);
        if (isInsideWorkspace(fullPath) && fs.existsSync(fullPath)) {
          ws.send(JSON.stringify({ type: 'file_content', path: msg.path, content: readNormalisedFile(fullPath) }));
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
          if (!isInsideWorkspace(filePath)) {
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
                  // No type or order: add both after description, else as the
                  // first keys inside the frontmatter block. The previous
                  // `^(---\s*$)/m` matched the OPENING fence and prepended the
                  // keys BEFORE it, corrupting the frontmatter so the declared
                  // name/role parsed as body. Anchor to the opening fence
                  // line and insert AFTER it instead.
                  if (saved.match(/^description:\s/m)) {
                    saved = saved.replace(/^(description:\s.*)/m, `$1\ntype: specialist\norder: ${maxOrder + 1}`);
                  } else {
                    // KNOWN LIMITATION: this anchor skips if a BOM or leading whitespace precedes the opening fence. Low bite.
                    saved = saved.replace(/^(---[ \t]*\r?\n)/, `$1type: specialist\norder: ${maxOrder + 1}\n`);
                  }
                } else if (hasType && !hasOrder) {
                  // Has type but no order: add order after type
                  saved = saved.replace(/^(type:\s.*)/m, `$1\norder: ${maxOrder + 1}`);
                }
                fs.writeFileSync(filePath, saved, 'utf-8');
              }
            }
            console.log(`[Agent] ${existed ? 'Updated' : 'Created'}: ${name}`);
            // Tag the confirmation with the agent's runtime so the client can
            // suffix the created pill for non-default runtimes.
            const savedRuntime = String(parseAgentFrontmatter(msg.content).runtime || '').toLowerCase() === 'codex' ? 'codex' : 'claude';
            ws.send(JSON.stringify({ type: 'agent_saved', agentId: name, updated: existed, runtime: savedRuntime }));
            // Invalidate BEFORE discovering so the broadcast reflects the new
            // file. A warm (<2s) cache otherwise omits the just-saved agent
            // from this first roster broadcast.
            invalidateAgentCache();
            const updatedAgents = discoverAgents();
            ws.send(JSON.stringify({ type: 'agents', agents: updatedAgents }));
            ws.send(JSON.stringify({ type: 'skills', skills: discoverSkills(updatedAgents) }));
            flagRosterRefresh();
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
          if (isInsideWorkspace(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`[Agent] Deleted: ${msg.agentId}`);
            ws.send(JSON.stringify({ type: 'agent_deleted', agentId: msg.agentId }));
            invalidateAgentCache(); // before discovery so the broadcast omits the deleted agent
            const updatedAgents = discoverAgents();
            ws.send(JSON.stringify({ type: 'agents', agents: updatedAgents }));
            ws.send(JSON.stringify({ type: 'skills', skills: discoverSkills(updatedAgents) }));
            flagRosterRefresh();
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
          if (!isInsideWorkspace(skillDir)) {
            ws.send(JSON.stringify({ type: 'skill_error', message: 'Invalid path.' }));
          } else {
            if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
            const filePath = path.join(skillDir, 'SKILL.md');
            const existed = fs.existsSync(filePath);
            fs.writeFileSync(filePath, msg.content, 'utf-8');
            console.log(`[Skill] ${existed ? 'Updated' : 'Created'}: ${name}`);
            ws.send(JSON.stringify({ type: 'skill_saved', skillId: name, updated: existed }));
            invalidateAgentCache(); // before discovery so the skills broadcast is fresh
            const updatedAgents = discoverAgents();
            ws.send(JSON.stringify({ type: 'skills', skills: discoverSkills(updatedAgents) }));
            flagRosterRefresh();
          }
        }
      }

      if (msg.type === 'delete_skill') {
        const name = msg.name;
        if (!validateAgentSlug(name)) {
          ws.send(JSON.stringify({ type: 'skill_error', message: 'Invalid skill name.' }));
        } else {
          const skillDir = path.join(WORKSPACE, '.claude', 'skills', name);
          if (!isInsideWorkspace(skillDir) || !fs.existsSync(skillDir)) {
            ws.send(JSON.stringify({ type: 'skill_error', message: `Skill "${name}" not found.` }));
          } else {
            fs.rmSync(skillDir, { recursive: true });
            console.log(`[Skill] Deleted: ${name}`);
            ws.send(JSON.stringify({ type: 'skill_deleted', skillId: name }));
            invalidateAgentCache(); // before discovery so the skills broadcast is fresh
            const updatedAgents = discoverAgents();
            ws.send(JSON.stringify({ type: 'skills', skills: discoverSkills(updatedAgents) }));
            flagRosterRefresh();
          }
        }
      }

      // ── CONVERSATION SEARCH: search titles and transcript content ──
      if (msg.type === 'search_conversations') {
        // Conversation-only search. No in-repo client sends this as of SR1
        // (the palette's search_universal replaced the sidebar search field);
        // retained deliberately as a stable WS surface for stale cached
        // clients and a possible sidebar-search reinstatement, and kept
        // honest by the integration suite. Results carry the conversation
        // entry plus matchType/snippet, extended with sessionId/seq anchors
        // on content hits. Grep fallback covers runtimes without node:sqlite.
        (async () => {
          const query = (msg.query || '').toLowerCase().trim();
          if (!WORKSPACE || !query) {
            ws.send(JSON.stringify({ type: 'search_results', results: [], query: msg.query }));
            return;
          }
          const convos = readConversations();
          // Phase 1: title matches (instant)
          const titleMatches = convos.filter(c => (c.title || '').toLowerCase().includes(query)).map(c => ({ ...c, matchType: 'title' }));
          // Phase 2: content matches (FTS index, or the legacy jsonl grep)
          let contentResults = [];
          if (ensureSearchEngine()) {
            try {
              reconcileSearchBeforeQuery();
              const byId = new Map(convos.map(c => [c.id, c]));
              // prefix keeps mid-word typing states matching, on par with
              // the old substring grep ("discoun" must find "discount").
              contentResults = searchEngine.searchMessages(msg.query, { limit: 50, prefix: true })
                .filter(h => byId.has(h.conversationId))
                .map(h => ({
                  ...byId.get(h.conversationId), matchType: 'content', snippet: h.snippet,
                  sessionId: h.sessionId, seq: h.seq, matchCount: h.matchCount,
                }));
            } catch (e) {
              console.warn('[Search] FTS query failed, using grep fallback:', e.message);
              contentResults = await grepSearchTranscripts(msg.query, convos);
            }
          } else {
            contentResults = await grepSearchTranscripts(msg.query, convos);
          }
          // Merge: title matches first, then content-only matches (no duplicates)
          const titleIds = new Set(titleMatches.map(c => c.id));
          const merged = [...titleMatches, ...contentResults.filter(c => !titleIds.has(c.id))];
          ws.send(JSON.stringify({ type: 'search_results', results: merged.slice(0, 50), query: msg.query }));
        })().catch(err => {
          console.warn('[Search] Error:', err.message);
          ws.send(JSON.stringify({ type: 'search_results', results: [], query: msg.query }));
        });
      }

      if (msg.type === 'search_universal') {
        // Cmd+K universal palette (SR1): one query across files,
        // conversations, agents, and skills, grouped by type.
        runUniversalSearch(msg).then(({ groups, recent }) => {
          ws.send(JSON.stringify({ type: 'search_universal_results', query: (msg.query || '').trim(), reqId: msg.reqId, groups, recent }));
        }).catch(err => {
          // Defensive backstop: each corpus inside runUniversalSearch catches
          // its own failures (degrading to partial results), so a rejection
          // here is unexpected. `error: true` lets the client distinguish a
          // genuine failure from a query with no hits.
          console.warn('[Search] universal error:', err && err.message ? err.message : err);
          ws.send(JSON.stringify({
            type: 'search_universal_results', query: (msg.query || '').trim(), reqId: msg.reqId,
            groups: { files: [], conversations: [], agents: [], skills: [] }, recent: false, error: true,
          }));
        });
      }

      if (msg.type === 'get_session_history') {
        const { sessionId, sessionIds, conversationId, limit, offset } = msg;

        // Multi-session merge: load JSONL content from all sessions, then use the
        // conversation transcript as the ordering and attribution authority.
        // The transcript records the correct interleaved order from live use;
        // JSONL sessions group messages per-process and can reorder across agents.
        if (sessionIds && sessionIds.length > 0) {
          Promise.all(sessionIds.map(async (s) => {
            const result = await parseSessionHistory(s.sessionId, 999, 0).catch(() => ({ messages: [] }));
            return result.messages;
          })).then(allSessions => {
            const transcript = loadTranscript(conversationId);

            // Build a pool of JSONL messages for content lookup
            const stripToolSummaries = (s) => (s || '').replace(/^(\[.*?\]\s*)+/s, '').trim();
            const jsonlPool = [];
            for (const sessionMsgs of allSessions) {
              for (const m of sessionMsgs) {
                // Skip whitespace-only content. Without this filter, an entry
                // whose content is just a space character falsely matches any
                // cleanPrefix that contains a space (i.e. virtually all of
                // them), so real transcript text gets replaced by empty
                // bubbles. Whitespace entries are artifacts of tool-heavy
                // assistant turns where parseSessionHistory joined empty
                // `text` blocks into a single whitespace string.
                if (!m.content || !m.content.trim()) continue;
                // Skip internal delegation messages
                if (m.role === 'user' && (
                  m.content.startsWith('CONVERSATION SO FAR:') ||
                  m.content.startsWith('[SYSTEM:') ||
                  m.content.startsWith('[DELEGATION BRIEF]')
                )) continue;
                // Skip ghost bubbles: empty resume artifacts from orchestrator
                if (m.role === 'assistant' && m.content.trim() === 'No response requested.') continue;
                jsonlPool.push({ ...m, _used: false });
              }
            }

            // If we have a transcript, use it as the ordering authority
            const merged = [];
            if (transcript && transcript.length > 0) {
              const seenUserMsgs = new Set();
              for (const t of transcript) {
                const role = t.role === 'user' ? 'user' : 'assistant';
                const tText = t.text || '';

                // Routing entries: orchestrator turn that was an immediate Agent-tool
                // call with no prose. Pass through with type so the client preserves
                // the agent change for divider rendering but skips the chat bubble.
                if (t.type === 'routing') {
                  merged.push({ role: 'assistant', content: tText, agentId: t.agent || null, type: 'routing', timestamp: t.timestamp || null });
                  continue;
                }

                if (role === 'user') {
                  const key = tText.substring(0, 200);
                  if (seenUserMsgs.has(key)) continue;
                  seenUserMsgs.add(key);
                  // Find matching JSONL entry for full content
                  const match = jsonlPool.find(m => !m._used && m.role === 'user' &&
                    m.content && m.content.substring(0, 200) === key);
                  if (match) {
                    match._used = true;
                    merged.push({ role: 'user', content: match.content, agentId: null, timestamp: match.timestamp || t.timestamp || null });
                  } else if (tText) {
                    merged.push({ role: 'user', content: tText, agentId: null, timestamp: t.timestamp || null });
                  }
                } else {
                  // Agent message: match by content prefix (transcript stores ~200 chars)
                  const cleanPrefix = stripToolSummaries(tText).substring(0, 100);
                  if (!cleanPrefix) continue;
                  const match = jsonlPool.find(m => !m._used && m.role === 'assistant' &&
                    m.content && m.content.trim() && (
                      m.content.substring(0, 100).includes(cleanPrefix.substring(0, 60)) ||
                      cleanPrefix.includes(m.content.substring(0, 60))
                    ));
                  if (match) {
                    match._used = true;
                    merged.push({ role: 'assistant', content: match.content, agentId: t.agent || null, timestamp: match.timestamp || t.timestamp || null });
                  } else {
                    // No JSONL match: use transcript text (may be truncated but better than dropping)
                    const cleanText = stripToolSummaries(tText);
                    if (cleanText) {
                      merged.push({ role: 'assistant', content: cleanText, agentId: t.agent || null, timestamp: t.timestamp || null });
                    }
                  }
                }
              }
            } else {
              // No transcript: fall back to JSONL pool in order, deduplicated
              const seenUserMsgs = new Set();
              for (const m of jsonlPool) {
                if (m.role === 'user') {
                  const key = m.content.substring(0, 200);
                  if (seenUserMsgs.has(key)) continue;
                  seenUserMsgs.add(key);
                }
                merged.push({ role: m.role, content: m.content, agentId: m.role === 'user' ? null : null, timestamp: m.timestamp || null });
              }
            }

            const total = merged.length;
            const lim = limit || 200;
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
        if (isInsideWorkspace(fullPath)) {
          fs.writeFileSync(fullPath, msg.content, 'utf-8');
          // Keep the search index and the title-layer file list fresh on the
          // save hot path; guarded so an index failure can never affect the
          // save itself.
          invalidateFileListCache();
          if (ensureSearchEngine()) {
            try { searchEngine.noteFileSaved(WORKSPACE, msg.path); } catch (e) { /* reconcile catches up */ }
          }
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
        const content = readNormalisedFile(defPath);
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
        const instructions = bodyMatch ? bodyMatch[1].trim() : content.trim();

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

// File types the client can open: text rides the WS read_file path; html/svg
// render sandboxed via srcdoc; images and PDFs ride /workspace-file. Code and
// config files stay hidden from the tree, as before.
const VIEWABLE_FILE_RE = /\.(md|txt|json|html?|svg|png|jpe?g|gif|webp|pdf)$/i;

// The /workspace-file allowlist: binary types only. Everything else either
// rides the WS text path or is not served at all; this endpoint must never
// become a generic file server for the workspace.
const BINARY_FILE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

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
      } else if (VIEWABLE_FILE_RE.test(item.name)) {
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

// Track recent spawn errors per conversation for dedupe within a 30-second window.
// Without this, a fully broken install could spam system/info messages on every retry.
const recentSpawnErrors = new Map(); // convoId -> { code, ts }

// Surface a spawn-error to the chat with code-specific copy, dedupe consecutive
// identical errors per conversation, and mark the corresponding chatProcesses
// entry so the close handler can skip its user-facing emissions.
function handleChatSpawnError(err, convoId) {
  try {
    const entry = chatProcesses.get(convoId);

    // Mark spawn failure so the close handler (if it ever fires) can short-circuit.
    if (entry) entry.spawnFailed = true;

    // Skip user-facing surfacing on cancelled processes.
    if (entry && entry.cancelled) return;

    // Dedupe consecutive identical errors per conversation within 30 seconds.
    // The dedupe applies to the user-facing pill only; the 'done' signal at
    // the bottom of this handler must always fire so the client clears its
    // thinking indicator on every spawn attempt.
    const key = String(convoId || '');
    const last = recentSpawnErrors.get(key);
    const now = Date.now();
    const isDupe = last && last.code === err.code && (now - last.ts) < 30000;

    if (isDupe) {
      console.error(`[SpawnError] convo=${convoId} code=${err.code} (deduped within 30s)`);
    } else {
      recentSpawnErrors.set(key, { code: err.code, ts: now });

      // Distinct copy per error code.
      let userMessage;
      if (err.code === 'ENOENT') {
        userMessage = 'Claude Code not found on PATH. Run `claude --version` to check your install.';
      } else if (err.code === 'EACCES') {
        userMessage = "Couldn't start Claude Code: permission denied. Check your install.";
      } else {
        userMessage = `Couldn't start Claude Code: ${err.message}. Run \`claude --version\` to check your install.`;
      }

      safeSend(JSON.stringify({
        type: 'system',
        subtype: 'info',
        content: userMessage,
        _conversationId: convoId,
      }));
    }

    // Send done so the client unblocks. The close handler is gated by
    // spawnFailed and won't emit its own 'done', so without this the
    // conversation would spin in the thinking state forever after a
    // spawn failure.
    safeSend(JSON.stringify({
      type: 'system', subtype: 'done', code: null,
      _conversationId: convoId,
      _processId: entry ? entry.processId : undefined,
      _agent: entry ? entry.agentId : undefined,
    }));

    // If a DELEGATE failed to spawn, restore its parked parent instead of
    // leaking it. The parent process is still alive but was swapped out
    // of the map when the delegate took over; the delegate close handler bails
    // on spawnFailed, so without this the parent is orphaned and delegation is
    // permanently broken for the conversation. Put the parent back (idle).
    if (entry && entry.delegation && entry.delegation.originalEntry
        && !entry.delegation.originalEntry.exited) {
      const parent = entry.delegation.originalEntry;
      parent.idle = true;
      parent.delegation = null;
      chatProcesses.set(convoId, parent);
      safeSend(JSON.stringify({
        type: 'system', subtype: 'agent_switch', _conversationId: convoId,
        fromAgent: entry.agentId, toAgent: parent.agentId,
      }));
      console.log(`[SpawnError] convo=${convoId} delegate spawn failed, restored parked parent ${parent.agentId}`);
      return;
    }

    if (convoId && entry) chatProcesses.delete(convoId);

    console.error(`[SpawnError] convo=${convoId} code=${err.code || ''} msg=${err.message}`);
  } catch (e) {
    // A fault in this handler must not tear down the WebSocket.
    console.error('[SpawnError] handler fault:', e);
  }
}

// Resolve the Claude binary path lazily and cache it. Independent of
// Electron's findClaude so Path B users (running `node server.js` directly
// without Electron) get correct .cmd resolution on Windows too. On lookup
// failure, returns the literal 'claude' so spawn's 'error' event surfaces the
// real ENOENT rather than masking it. The absolute path lets Node execute
// .cmd files on Windows without `shell: true`, which would expose args
// (containing user and system prompts) to command-injection risk.
let _resolvedClaudeBin = null;
function resolveClaudeBin() {
  if (_resolvedClaudeBin) return _resolvedClaudeBin;
  const isWindows = process.platform === 'win32';
  try {
    const { execSync } = require('child_process');
    const lookupCmd = isWindows ? 'where.exe claude' : 'which claude';
    const output = execSync(lookupCmd, { timeout: 5000, encoding: 'utf-8' }).trim();
    if (!output) return (_resolvedClaudeBin = 'claude');
    if (isWindows) {
      const candidates = output.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const exe = candidates.find(c => c.toLowerCase().endsWith('.exe'));
      const cmd = candidates.find(c => c.toLowerCase().endsWith('.cmd'));
      _resolvedClaudeBin = exe || cmd || candidates[0] || 'claude';
    } else {
      _resolvedClaudeBin = output;
    }
    return _resolvedClaudeBin;
  } catch {
    return (_resolvedClaudeBin = 'claude');
  }
}

// Spawn a Claude Code process with PID tracking for crash cleanup.
// Drop-in replacement for spawn('claude', ...) that registers/unregisters PIDs.
function spawnClaude(args, options, onError) {
  // Safety net: never spawn Claude Code without an explicit --model. Call sites
  // pass the agent's model (see modelArgs); this guards any path that doesn't,
  // so the model can never silently fall back to the user's environment.
  if (!args.includes('--model')) args = ['--model', DEFAULT_MODEL, ...args];
  const proc = spawn(resolveClaudeBin(), args, options);
  if (proc.pid) {
    registerChildPid(proc.pid);
    proc.on('close', () => unregisterChildPid(proc.pid));
  }
  // Always attach a baseline 'error' listener so an unhandled error event
  // cannot propagate out of the WebSocket message handler and tear down the
  // connection. Caller-provided onError does the user-facing surfacing; this
  // wrapper guarantees the listener exists and that the callback runs inside
  // try/catch.
  proc.on('error', (err) => {
    try {
      console.error(`[spawnClaude] spawn error code=${err.code || ''} msg=${err.message}`);
      if (typeof onError === 'function') onError(err);
    } catch (e) {
      console.error('[spawnClaude] onError handler threw:', e);
    }
  });
  return proc;
}

// ===== CODEX RUNTIME =====
// Agents with `runtime: codex` in their frontmatter run on the OpenAI Codex
// CLI (the user's ChatGPT plan) instead of Claude Code. Codex conversations
// run one sandboxed `codex exec --json` process per turn and resume the
// thread on follow-ups; the thread id rides the same client rails as Claude
// session ids, so the rest of the product treats both runtimes identically.
// All Codex-specific parsing/argv/detection logic lives in codex.js.

// Resolve the codex binary lazily and cache it, mirroring resolveClaudeBin.
let _resolvedCodexBin = null;
function resolveCodexBinCached() {
  if (!_resolvedCodexBin) _resolvedCodexBin = codexRuntime.resolveCodexBin();
  return _resolvedCodexBin;
}

// Claude sign-in state, from evidence the server already has rather than a
// live probe (a probe costs a real model call and 15 seconds; a settings
// render must never do that). null = no evidence yet, and the UI claims
// nothing. Set true by any successful turn, false by the auth-error
// classifier. Self-correcting in both directions.
let _claudeAuthEvidence = null;

// Runtime status for the settings surface: which runtimes exist on this
// machine, whether they are signed in, and which one is the workspace
// default. The default is Claude in this version: Doc and delegation run on
// it, so a workspace cannot exist without it.
let _claudeProbeCache = null;
let _claudeProbeTime = 0;
function getRuntimeStatus() {
  const { execSync } = require('child_process');
  const isWindows = process.platform === 'win32';
  // The install/version probe shells out (claude --version can take seconds)
  // and this runs on the WebSocket handler path, so cache it. 60s keeps a
  // fresh install visible quickly without blocking every settings open.
  // A cached "not installed" is never trusted: the user may have just
  // installed, and that is exactly when they will open settings to check.
  let claudeInstalled, claudeVersion;
  if (_claudeProbeCache && _claudeProbeCache.installed && (Date.now() - _claudeProbeTime) < 60000) {
    ({ installed: claudeInstalled, version: claudeVersion } = _claudeProbeCache);
  } else {
    claudeInstalled = true;
    try {
      execSync(isWindows ? 'where.exe claude' : 'which claude', { timeout: 5000, encoding: 'utf-8' });
    } catch (e) { claudeInstalled = false; }
    claudeVersion = null;
    if (claudeInstalled) {
      try {
        const out = execSync(`"${resolveClaudeBin()}" --version`, { timeout: 5000, encoding: 'utf-8' });
        const m = String(out).match(/(\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.]+)?)/);
        claudeVersion = m ? m[1] : null;
      } catch (e) { /* installed but --version failed */ }
    }
    _claudeProbeCache = { installed: claudeInstalled, version: claudeVersion };
    _claudeProbeTime = Date.now();
  }
  // Fresh Codex detection (the user may have just installed or signed in),
  // and refresh the prompt-side cache while we have the answer.
  let codexStatus;
  try { codexStatus = codexRuntime.detectCodex(); }
  catch (e) { codexStatus = { installed: false, authenticated: false, version: null }; }
  _codexDetectCache = codexStatus;
  _codexDetectTime = Date.now();
  return {
    defaultRuntime: 'claude',
    claude: { installed: claudeInstalled, authenticated: claudeInstalled ? _claudeAuthEvidence : false, version: claudeVersion },
    codex: codexStatus,
  };
}

// Spawn a Codex process with the same PID tracking and error guarantees as
// spawnClaude. Note: no default model is injected; Codex applies its own
// default unless the agent's frontmatter set one (already in args).
function spawnCodex(args, options, onError) {
  const proc = spawn(resolveCodexBinCached(), args, options);
  if (proc.pid) {
    registerChildPid(proc.pid);
    proc.on('close', () => unregisterChildPid(proc.pid));
  }
  proc.on('error', (err) => {
    try {
      console.error(`[spawnCodex] spawn error code=${err.code || ''} msg=${err.message}`);
      if (typeof onError === 'function') onError(err);
    } catch (e) {
      console.error('[spawnCodex] onError handler threw:', e);
    }
  });
  return proc;
}

// Surface a Codex failure once per process, classified: plan-limit exhaustion
// becomes a structured quota message (the client renders a recovery card, the
// same pattern as the Claude auth-error card); everything else becomes a
// structured error message with the CLI's verbatim text attached. The failure
// is also persisted to the transcript, so a user who wasn't looking at the
// conversation still finds out what happened when they open it.
function sendCodexError(entry, convoId, message) {
  if (entry.errorSent) return;
  entry.errorSent = true;
  const classified = codexRuntime.classifyCodexError(message);
  // Actionable failures (signed out, unavailable model) become guidance cards
  // with a concrete fix; quota keeps its dedicated card; everything else
  // surfaces verbatim as a classified error pill.
  let subtype, friendly, guidance = null;
  if (classified.kind === 'quota') {
    subtype = 'codex_quota';
    friendly = 'This turn stopped: the ChatGPT plan limit was reached. It can be retried once the limit resets.';
  } else if (classified.kind === 'auth') {
    subtype = 'codex_guidance';
    guidance = {
      title: 'Codex is not signed in',
      body: 'This agent runs on Codex, but the Codex CLI is not signed in on this machine. Run codex login in a terminal, then resend your message.',
    };
    friendly = 'This turn stopped: Codex is not signed in on this machine. Run codex login in a terminal, then resend the message.';
  } else if (classified.kind === 'model') {
    subtype = 'codex_guidance';
    const modelBit = classified.model ? `the model '${classified.model}'` : 'a model';
    guidance = {
      title: 'Model not available on this account',
      body: `This agent is configured with ${modelBit}, which this Codex account does not offer. Edit the agent and remove the model field to use the account default, or pick a model your plan includes.`,
    };
    friendly = `This turn stopped: ${modelBit} is not available on this Codex account. Remove the agent's model field to use the account default, or pick an available model.`;
  } else {
    subtype = 'codex_error';
    friendly = 'This turn stopped: the runtime hit a problem.';
  }
  try {
    appendTranscript(convoId, 'agent', entry.agentId, `${friendly}\nCodex: ${message}`);
  } catch (e) { /* transcript persistence is best-effort */ }
  safeSend(JSON.stringify({
    type: 'system', subtype, detail: message, ...(guidance || {}),
    _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId,
  }));
}

// Spawn-failure copy for Codex processes. The generic Claude spawn-error
// handler tells users to check their Claude Code install, which is the wrong
// guidance for a Codex agent. Marks the entry so close handlers stay silent.
function handleCodexSpawnError(err, convoId) {
  const entry = chatProcesses.get(convoId);
  if (entry) entry.spawnFailed = true;
  // Same 30s per-conversation dedupe as the Claude spawn-error handler, so
  // retries against a missing binary do not stack pills. Keys are prefixed
  // to keep the two runtimes' dedupe windows independent.
  const dedupeKey = `codex:${convoId || ''}`;
  const last = recentSpawnErrors.get(dedupeKey);
  const now = Date.now();
  if (last && last.code === err.code && (now - last.ts) < 30000) {
    console.error(`[SpawnError] convo=${convoId} codex code=${err.code} (deduped within 30s)`);
    safeSend(JSON.stringify({
      type: 'system', subtype: 'done', code: -1,
      _agent: entry ? entry.agentId : undefined, _conversationId: convoId,
      _processId: entry ? entry.processId : undefined,
    }));
    return;
  }
  recentSpawnErrors.set(dedupeKey, { code: err.code, ts: now });
  let userMessage;
  if (err.code === 'ENOENT') {
    userMessage = 'The Codex CLI was not found on this machine. Install the official Codex CLI, then sign in: npm install -g @openai/codex then codex login';
  } else if (err.code === 'EACCES') {
    userMessage = "Couldn't start Codex: permission denied. Check your Codex CLI install.";
  } else {
    userMessage = `Couldn't start Codex: ${err.message}. Run codex --version to check your install.`;
  }
  safeSend(JSON.stringify({
    type: 'system', subtype: 'info', content: userMessage, _conversationId: convoId,
  }));
  safeSend(JSON.stringify({
    type: 'system', subtype: 'done', code: -1,
    _agent: entry ? entry.agentId : undefined, _conversationId: convoId,
    _processId: entry ? entry.processId : undefined,
  }));
}

// Codex emits nothing between accepting the prompt and the final message, so
// the client's stream-inactivity watchdog (90s) would otherwise conclude the
// turn is dead mid-task. A periodic keepalive keeps the working state honest
// while the process lives. Interval is overridable for tests.
const CODEX_KEEPALIVE_MS = parseInt(process.env.RUNDOCK_CODEX_KEEPALIVE_MS || '', 10) || 25000;
function startCodexKeepalive(entry, convoId) {
  const timer = setInterval(() => {
    if (entry.exited || entry.resultSent || entry.spawnFailed) { clearInterval(timer); return; }
    safeSend(JSON.stringify({
      type: 'system', subtype: 'keepalive',
      _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId,
    }));
  }, CODEX_KEEPALIVE_MS);
  entry.process.on('close', () => clearInterval(timer));
}

// Deliver the completed Codex turn: persist the transcript, send the result
// (with normalised token usage: subscription usage, never dollar costs) and
// the done signal.
// Whether Codex spawns on this machine need the write-marker fallback:
// Windows without a declared native sandbox (the CLI silently downgrades
// workspace-write to read-only there). Checked per spawn so a config edit
// takes effect on the next turn. Shared by direct chats and delegated turns.
function codexWriteMarkersEnabled() {
  const codexPlatform = process.env.RUNDOCK_TEST_PLATFORM || process.platform;
  return codexPlatform === 'win32' && !codexRuntime.hasWindowsSandboxConfig();
}

// The write-marker instruction for Codex prompts on Windows machines without
// the native sandbox. Empty string when the fallback is not needed, so call
// sites can join it unconditionally.
function buildWindowsWriteNote(enabled) {
  if (!enabled) return '';
  return [
    'WINDOWS FILE WRITES:',
    'On this machine your sandbox is read-only: shell commands that write files will be rejected. To create or update a file, output a block in EXACTLY this format as part of your response:',
    '<!-- RUNDOCK:WRITE_FILE path="relative/path/inside/workspace.md" -->',
    '<the complete file content>',
    '<!-- /RUNDOCK:WRITE_FILE -->',
    'Rules: relative paths inside the workspace only; the content replaces the whole file; one block per file, multiple blocks allowed. The user approves each write AFTER your turn ends, so describe writes as requested, never as completed. Never claim a file was created. Do not attempt writes via shell commands.',
  ].join('\n');
}

// Strip write markers from a finished Codex turn's text. Returns the display
// text plus the parsed requests for the caller to dispatch AFTER sending its
// result/handback (cards follow the message they belong to). Inert unless
// the entry was spawned with the marker instruction.
function extractCodexWriteRequests(entry, text) {
  if (!entry.writeMarkersEnabled || !text || !text.includes('RUNDOCK:WRITE_FILE')) {
    return { text, requests: [] };
  }
  const parsed = codexRuntime.parseWriteMarkers(text);
  return { text: parsed.cleanText, requests: parsed.requests };
}

// Raise a permission card for a server-originated request (no hook HTTP
// response to hold: the decision arrives via onDecision(allow, reason)).
// Same card UI, same timeout, same cancel sweep as hook-originated requests.
function requestServerPermission({ convoId, toolName, toolInput, onDecision }) {
  const requestId = 'perm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  pendingPermissionRequests.set(requestId, {
    onDecision,
    conversationId: convoId,
    toolName,
    toolInput,
    timer: setTimeout(() => {
      const pending = pendingPermissionRequests.get(requestId);
      if (pending) {
        pendingPermissionRequests.delete(requestId);
        console.log(`[Permission] Auto-denied (timeout): ${toolName} convo=${convoId} requestId=${requestId}`);
        safeSend(JSON.stringify({ type: 'permission_timeout', requestId, _conversationId: convoId }));
        try { pending.onDecision(false, 'timeout'); } catch (e) {}
      }
    }, PERMISSION_TIMEOUT_MS),
  });
  safeSend(JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'can_use_tool', tool_name: toolName, input: toolInput || {} },
    _conversationId: convoId,
  }));
  console.log(`[Permission] Server request: ${toolName} convo=${convoId} requestId=${requestId}`);
}

// One WRITE_FILE request from a Windows Codex turn: validate, card, write.
// Invalid requests are refused WITHOUT a card (a card is never raised for
// something Rundock would not do); the refusal is recorded so the user and
// the resumed thread can see what happened.
function handleCodexWriteRequest(entry, convoId, req) {
  let isCodeMode = false;
  try { isCodeMode = readState().workspaceMode === 'code'; } catch (e) {}
  const v = validateWriteRequest(WORKSPACE, req.path, req.content, isCodeMode);
  if (!v.ok) {
    console.log(`[CodexWrite] convo=${convoId} refused without card: ${req.path} (${v.reason})`);
    appendTranscript(convoId, 'agent', entry.agentId, `Write of ${req.path} refused: ${v.reason}.`);
    safeSend(JSON.stringify({ type: 'system', subtype: 'notice', content: `Refused a file write from ${entry.agentId}: ${req.path} (${v.reason}).`, _conversationId: convoId }));
    return;
  }
  requestServerPermission({
    convoId,
    toolName: 'WriteFile',
    toolInput: { path: req.path, content: req.content, agent: entry.agentId },
    onDecision: (allow, reason) => {
      if (!allow) {
        console.log(`[CodexWrite] convo=${convoId} not approved (${reason}): ${req.path}`);
        appendTranscript(convoId, 'agent', entry.agentId, `Write of ${req.path} not approved.`);
        safeSend(JSON.stringify({ type: 'system', subtype: 'notice', content: `Write of ${req.path} was not approved.`, _conversationId: convoId }));
        return;
      }
      try {
        fs.mkdirSync(path.dirname(v.fullPath), { recursive: true });
        // Defence in depth against symlink traversal: the validated path is
        // lexical; re-verify the REAL parent directory sits inside the
        // workspace before writing, so a symlinked folder inside the
        // workspace cannot redirect the write outside it.
        const realParent = fs.realpathSync(path.dirname(v.fullPath));
        const realRoot = fs.realpathSync(path.resolve(WORKSPACE));
        if (!(realParent === realRoot || realParent.startsWith(realRoot + path.sep))) {
          throw new Error('resolved target escapes the workspace');
        }
        fs.writeFileSync(v.fullPath, req.content, 'utf-8');
        invalidateFileListCache();
        if (ensureSearchEngine()) {
          try { searchEngine.noteFileSaved(WORKSPACE, req.path); } catch (e) { /* reconcile catches up */ }
        }
        appendTranscript(convoId, 'agent', entry.agentId, `Created ${req.path} (approved).`);
        safeSend(JSON.stringify({ type: 'system', subtype: 'notice', content: `Created [[${req.path}]] (approved write from ${entry.agentId}).`, _conversationId: convoId }));
        safeSend(JSON.stringify({ type: 'file_saved', path: req.path }));
        console.log(`[CodexWrite] convo=${convoId} wrote ${req.path} (${Buffer.byteLength(req.content, 'utf-8')} bytes)`);
      } catch (e) {
        console.error(`[CodexWrite] convo=${convoId} write failed: ${e.message}`);
        appendTranscript(convoId, 'agent', entry.agentId, `Write of ${req.path} failed: ${e.message}`);
        safeSend(JSON.stringify({ type: 'system', subtype: 'notice', content: `Write of ${req.path} failed: ${e.message}`, _conversationId: convoId }));
      }
    },
  });
}

function finishCodexTurn(entry, convoId) {
  if (entry.resultSent) return;
  entry.resultSent = true;
  let text = entry.responseText || '';
  // Windows write markers: strip from the displayed/persisted text, then
  // dispatch each request through validation + permission card AFTER the
  // result, so the conversation shows the agent's message first and the
  // cards follow. Only turns that were given the marker instruction are
  // honoured (entry.writeMarkersEnabled).
  const extracted = extractCodexWriteRequests(entry, text);
  text = extracted.text;
  const writeRequests = extracted.requests;
  if (text) appendTranscript(convoId, 'agent', entry.agentId, text);
  safeSend(JSON.stringify({
    type: 'result', result: text, is_error: false, usage: entry.usage,
    _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId,
    _turnStartTime: entry.turnStartTime,
  }));
  entry.doneSent = true;
  safeSend(JSON.stringify({
    type: 'system', subtype: 'done', code: 0,
    _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId,
  }));
  for (const req of writeRequests) handleCodexWriteRequest(entry, convoId, req);
}

// Handle one parsed line of Codex output for a running turn.
function handleCodexEvent(entry, convoId, line) {
  const ev = codexRuntime.parseCodexLine(line);
  if (!ev) {
    if (line.trim()) console.log(`[Codex] convo=${convoId} skipped line: ${line.slice(0, 200)}`);
    return;
  }
  switch (ev.type) {
    case 'session':
      entry.sessionId = ev.threadId;
      // Same message shape the Claude init envelope produces: the client
      // stores the id and sends it back as msg.sessionId on the next turn.
      safeSend(JSON.stringify({
        type: 'system', subtype: 'init', _sessionId: ev.threadId,
        _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId,
      }));
      break;
    case 'text':
      entry.responseText = entry.responseText ? entry.responseText + '\n' + ev.text : ev.text;
      break;
    case 'done':
      entry.usage = ev.usage;
      finishCodexTurn(entry, convoId);
      break;
    case 'error':
      sendCodexError(entry, convoId, ev.message);
      break;
  }
}

// Read an agent's full instruction body from its file. Claude Code loads
// agent files natively via --agent, but Codex has no equivalent, so the
// instructions must travel inside the first-turn prompt. Falls back to the
// (truncated) discovery snapshot if the file cannot be read.
function readAgentInstructions(agentData) {
  try {
    if (agentData.fileName && WORKSPACE) {
      const content = readNormalisedFile(path.join(WORKSPACE, '.claude', 'agents', agentData.fileName));
      const bodyMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)/);
      if (bodyMatch && bodyMatch[1].trim()) return bodyMatch[1].trim();
    }
  } catch (e) { /* fall through to snapshot */ }
  return agentData.instructions || '';
}

// Wire a Codex delegate process. The prompt goes in whole over stdin; output
// events deliver the specialist's result and record any handoff marker on the
// SAME entry fields Claude delegates use (returnMarkerSeen,
// finalResponseText), so the shared delegate close handler in
// handleDelegation performs restoration identically for both runtimes.
// This function sends the result message; the close handler owns
// agent_switch/done and parent restoration.
function wireCodexDelegate(entry, convoId, prompt) {
  const proc = entry.process;
  proc.stdin.on('error', () => { /* EPIPE on early exit: close handler reports */ });
  proc.stdin.write(prompt);
  proc.stdin.end();

  let stdoutBuf = '';
  const handleLine = (line) => {
    const ev = codexRuntime.parseCodexLine(line);
    if (!ev) {
      if (line.trim()) console.log(`[Codex] convo=${convoId} delegate skipped line: ${line.slice(0, 200)}`);
      return;
    }
    if (ev.type === 'session') {
      entry.sessionId = ev.threadId;
      safeSend(JSON.stringify({
        type: 'system', subtype: 'init', _sessionId: ev.threadId,
        _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId,
      }));
    } else if (ev.type === 'text') {
      entry.responseText = entry.responseText ? entry.responseText + '\n' + ev.text : ev.text;
    } else if (ev.type === 'done') {
      // Marker scan, COMPLETE priority: same contract as the Claude
      // delegate onResult handler.
      const hasComplete = /<!-- RUNDOCK:COMPLETE -->/.test(entry.responseText);
      const hasReturn = /<!-- RUNDOCK:RETURN -->/.test(entry.responseText);
      if (hasComplete) entry.returnMarkerSeen = 'complete';
      else if (hasReturn) entry.returnMarkerSeen = 'return';
      // Windows write markers: strip before the transcript, the result, and
      // the handback injection (finalResponseText), so the orchestrator and
      // the user both see the plain-language line, never raw marker soup.
      // Cards dispatch after the result so they follow their message.
      const extracted = extractCodexWriteRequests(entry, entry.responseText);
      const displayText = extracted.text;
      if (displayText) appendTranscript(convoId, 'agent', entry.agentId, displayText);
      safeSend(JSON.stringify({
        type: 'result', result: displayText, is_error: false, usage: ev.usage,
        _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId,
        _turnStartTime: entry.turnStartTime,
      }));
      entry.resultSent = true;
      entry.finalResponseText = displayText;
      entry.responseText = '';
      entry.idle = true;
      for (const req of extracted.requests) handleCodexWriteRequest(entry, convoId, req);
    } else if (ev.type === 'error') {
      sendCodexError(entry, convoId, ev.message);
    }
  };

  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      handleLine(line);
    }
  });

  let stderrBuf = '';
  proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });
  proc.on('close', () => {
    if (entry.spawnFailed) return; // spawn-error handler already surfaced
    if (stdoutBuf.trim()) handleLine(stdoutBuf); // unterminated last line
    if (!entry.resultSent && !entry.errorSent && !entry.cancelled) {
      sendCodexError(entry, convoId, stderrBuf.trim() || 'Codex exited unexpectedly');
    }
  });
}

// Run one Codex conversation turn. Each turn is its own process: fresh turns
// carry the agent's instructions and the platform rules followed by the user
// message; resumed turns send only the new message (instructions are never
// re-injected, keeping resumed turns cheap).
function startCodexTurn(convoId, msg, agentData) {
  // A new user message supersedes a still-running turn: kill it and continue
  // on the same thread. Mirrors the Claude path's stale-entry handling.
  const existing = chatProcesses.get(convoId);
  if (existing && !existing.exited) {
    existing.superseded = true;
    try { existing.process.kill(); } catch (e) { /* already dead */ }
    chatProcesses.delete(convoId);
  }

  // Normalise once: an invalid session id (hostile client, corrupted
  // persistence) must produce a FULL fresh turn, instructions included. If
  // only argv dropped the id, the prompt would still be built resume-shaped
  // and the agent would run without its identity.
  const resumeThreadId = codexRuntime.isValidThreadId(msg.sessionId) ? msg.sessionId : null;
  const args = codexRuntime.buildCodexArgs({ resumeThreadId, model: agentData.model || undefined });
  const processId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  console.log(`[Codex] convo=${convoId} proc=${processId} agent=${agentData.id} ${resumeThreadId ? `resume=${resumeThreadId}` : 'new thread'} model=${agentData.model || '(codex default)'}`);

  const proc = spawnCodex(args, {
    cwd: WORKSPACE,
    env: getSpawnEnv(convoId),
    stdio: ['pipe', 'pipe', 'pipe'],
  }, (err) => handleCodexSpawnError(err, convoId));

  // Windows write markers: see codexWriteMarkersEnabled() for the policy.
  const writeMarkersEnabled = codexWriteMarkersEnabled();

  const entry = {
    process: proc, runtime: 'codex', processId, agentId: agentData.id,
    responseText: '', exited: false, resultSent: false, errorSent: false,
    doneSent: false, superseded: false, usage: null, writeMarkersEnabled,
    sessionId: resumeThreadId, lastUserMessage: msg.content,
    toolCalls: [], turnStartTime: Date.now(),
  };
  chatProcesses.set(convoId, entry);
  startCodexKeepalive(entry, convoId);

  safeSend(JSON.stringify({
    type: 'system', subtype: 'process_started',
    _agent: agentData.id, _conversationId: convoId, _processId: processId,
  }));

  const windowsWriteNote = buildWindowsWriteNote(writeMarkersEnabled);

  // Prompt over stdin, never argv. First turns carry identity (the agent
  // file body) plus the platform rules; Claude gets these via --agent and
  // --append-system-prompt, which Codex does not support.
  const prompt = resumeThreadId
    ? msg.content
    : [readAgentInstructions(agentData), buildSystemPrompt(agentData), windowsWriteNote, msg.content].filter(Boolean).join('\n\n');
  proc.stdin.on('error', () => { /* EPIPE on early exit: close handler reports */ });
  proc.stdin.write(prompt);
  proc.stdin.end();

  let stdoutBuf = '';
  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString();
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      handleCodexEvent(entry, convoId, line);
    }
  });

  let stderrBuf = '';
  proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

  proc.on('close', (code) => {
    entry.exited = true;
    const current = chatProcesses.get(convoId);
    if (current === entry) chatProcesses.delete(convoId);
    if (entry.superseded) return;   // a newer turn took over; stay silent
    if (entry.spawnFailed) return;  // spawn-error handler already surfaced + done
    if (entry.cancelled) return;    // user stopped the agent; stop handler already surfaced + done
    if (stdoutBuf.trim()) handleCodexEvent(entry, convoId, stdoutBuf); // unterminated last line
    if (!entry.resultSent && !entry.errorSent) {
      sendCodexError(entry, convoId, stderrBuf.trim() || `Codex exited unexpectedly (code ${code})`);
    }
    if (!entry.doneSent) {
      entry.doneSent = true;
      safeSend(JSON.stringify({
        type: 'system', subtype: 'done', code,
        _agent: entry.agentId, _conversationId: convoId, _processId: processId,
      }));
    }
  });
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

// ===== UNIVERSAL SEARCH (SR1) =====
// FTS5 engine over files + conversations when node:sqlite is available;
// grep fallback otherwise. The engine is lazily (re)opened per workspace so
// every entry point — WS handlers, hooks, tests driving _internal — heals
// itself after a workspace switch.

let searchEngine = null;            // SearchIndex instance or null (fallback active)
let searchEngineWorkspace = null;   // workspace the engine was opened for
let searchEngineFailedWorkspace = null; // workspace whose engine open failed (backoff)
let searchProbe = null;             // cached capability probe
let searchFilesReconciledAt = 0;    // TTL gate for the files walk (not per-keystroke)
const SEARCH_FILES_RECONCILE_TTL_MS = 2000;
// Session-id -> {path|null, ts} memo. Missing session files (Claude Code
// prunes transcripts) would otherwise trigger a full ~/.claude/projects
// directory scan per session per keystroke. Negative entries expire so a
// session whose jsonl appears moments later becomes visible.
const _sessionPathMemo = new Map();
const SESSION_PATH_NEGATIVE_TTL_MS = 30000;

function ensureSearchEngine() {
  if (!WORKSPACE) {
    if (searchEngine) { try { searchEngine.close(); } catch (e) {} }
    searchEngine = null;
    searchEngineWorkspace = null;
    return null;
  }
  if (searchEngine && searchEngineWorkspace === WORKSPACE) return searchEngine;
  // Persistent open failures (unwritable .rundock, full disk) must not
  // re-attempt the open + full reconcile on every keystroke; retry only
  // after a workspace switch.
  if (searchEngineFailedWorkspace === WORKSPACE) return null;
  if (searchEngine) { try { searchEngine.close(); } catch (e) {} searchEngine = null; }
  searchEngineWorkspace = WORKSPACE;
  _sessionPathMemo.clear();
  if (!searchProbe) {
    searchProbe = searchLib.probeSqlite();
    if (!searchProbe.available) {
      console.log(`[Search] FTS index unavailable (${searchProbe.reason}); grep fallback active`);
    }
  }
  if (!searchProbe.available) return null;
  try {
    searchEngine = searchLib.createSearchIndex({
      dbPath: path.join(rundockDir(), 'search-index.db'),
      DatabaseSync: searchProbe.DatabaseSync,
    });
    searchEngine.open();
    // Initial reconcile (the spec's reconcile-on-open): synchronous, with a
    // progress line. Deleting the db and reopening the workspace is the
    // supported rebuild path and lands here too.
    const f = searchEngine.reconcileFiles(WORKSPACE);
    const validIds = readConversations().map(c => c.id);
    const m = searchEngine.reconcileConversations(conversationSessionsForSearch(), { validConversationIds: validIds });
    // Sweep rows for conversations deleted while the engine was closed or
    // unavailable (they would otherwise burn over-fetch slots forever).
    try { searchEngine.removeOrphanedConversations(validIds); } catch (e) {}
    searchFilesReconciledAt = Date.now();
    console.log(`[Search] index ready: ${f.scanned} files scanned (${f.updated} indexed), ${m.indexed} new messages`);
  } catch (e) {
    console.warn('[Search] engine init failed; grep fallback active:', e && e.message ? e.message : e);
    try { if (searchEngine) searchEngine.close(); } catch (e2) {}
    searchEngine = null;
    searchEngineFailedWorkspace = WORKSPACE;
  }
  return searchEngine;
}

// Session-file map for the indexer: [{conversationId, sessions:[{sessionId,
// agentId, filePath}]}]. Paths resolve into ~/.claude/projects (outside the
// workspace); the index itself stays inside .rundock/.
function resolveSessionPathCached(sessionId) {
  const now = Date.now();
  const memo = _sessionPathMemo.get(sessionId);
  if (memo) {
    if (memo.path) {
      // Cheap single stat validates a positive hit (files can be pruned).
      if (fs.existsSync(memo.path)) return memo.path;
    } else if (now - memo.ts < SESSION_PATH_NEGATIVE_TTL_MS) {
      return null;
    }
  }
  // Claude sessions live under ~/.claude/projects; Codex threads live under
  // ~/.codex/sessions as rollout files. Thread ids are uuid-shaped like
  // Claude session ids, so resolution simply tries both homes.
  const resolved = getSessionJsonlPath(sessionId) || codexRuntime.findCodexThreadFile(sessionId);
  _sessionPathMemo.set(sessionId, { path: resolved || null, ts: now });
  return resolved;
}

function conversationSessionsForSearch(onlyConvoId) {
  const out = [];
  // A session id belongs to exactly ONE conversation (the first that lists
  // it, in conversations.json order). Without this, two conversations
  // sharing a session flap the high-water mark's conversation_id and split
  // one session's messages across two conversation ids.
  const globallySeen = new Set();
  for (const c of readConversations()) {
    const sessions = [];
    const add = (sessionId, agentId) => {
      if (!sessionId || globallySeen.has(sessionId)) return;
      globallySeen.add(sessionId);
      if (onlyConvoId && c.id !== onlyConvoId) return; // still claim the id for ownership
      const filePath = resolveSessionPathCached(sessionId);
      if (filePath) sessions.push({ sessionId, agentId: agentId || c.agentId || null, filePath });
    };
    add(c.sessionId, c.agentId);
    for (const s of c.sessionIds || []) add(s && s.sessionId, s && s.agentId);
    if (sessions.length) out.push({ conversationId: c.id, sessions });
  }
  return out;
}

// Pre-query reconcile. Conversations reconcile on every search (byte-offset
// marks make unchanged files a stat-only skip, so this is ~ms and guarantees
// "findable without reopening the workspace"). The files walk is heavier and
// TTL-gated; our own saves stay fresh via the save_file hook.
function reconcileSearchBeforeQuery() {
  if (!searchEngine) return;
  try {
    const all = readConversations();
    searchEngine.reconcileConversations(conversationSessionsForSearch(), {
      validConversationIds: all.map(c => c.id),
    });
    const now = Date.now();
    if (now - searchFilesReconciledAt >= SEARCH_FILES_RECONCILE_TTL_MS) {
      searchFilesReconciledAt = now;
      searchEngine.reconcileFiles(WORKSPACE);
    }
  } catch (e) {
    console.warn('[Search] pre-query reconcile failed:', e && e.message ? e.message : e);
  }
}

// Live-path hook, called after an agent turn's transcript append. Guarded so
// an index failure can never affect message persistence (spec risk 2): the
// jsonl is written by Claude Code regardless, and the next reconcile-on-search
// or reconcile-on-open catches anything missed here.
function noteSearchConversationActivity(convoId) {
  if (!searchEngine || searchEngineWorkspace !== WORKSPACE) return;
  try {
    const all = readConversations();
    // This hook is the authoritative "the session jsonl exists now" signal:
    // a negative path memo seeded before Claude Code created the file (e.g.
    // by opening the palette during the first turn) must not blind the live
    // index until its TTL expires.
    const convo = all.find(c => c.id === convoId);
    if (convo) {
      if (convo.sessionId) _sessionPathMemo.delete(convo.sessionId);
      for (const s of convo.sessionIds || []) { if (s && s.sessionId) _sessionPathMemo.delete(s.sessionId); }
    }
    searchEngine.reconcileConversations(conversationSessionsForSearch(convoId), {
      validConversationIds: all.map(c => c.id),
    });
  } catch (e) {
    console.warn('[Search] live reconcile failed (will catch up on next search):', e && e.message ? e.message : e);
  }
}

// ── Title layer (in-memory, shared by engine and fallback modes) ────────────
// Fuzzy is subsequence scoring on names/titles only (fzf-style); content
// search stays lexical in FTS5. fuzzy=false narrows the title layer to
// substring matching.
function titleLayerMatches(query, items, titleOf, { fuzzy = true } = {}) {
  const out = [];
  const q = String(query).toLowerCase();
  for (const item of items) {
    const title = titleOf(item);
    if (!title) continue;
    let score;
    if (fuzzy) {
      score = searchLib.fuzzyScore(query, title);
    } else {
      const idx = String(title).toLowerCase().indexOf(q);
      score = idx === -1 ? null : 100 - Math.min(idx, 50);
    }
    if (score !== null && score !== undefined) out.push({ item, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function flattenFileTree(tree, out = []) {
  for (const entry of tree || []) {
    if (entry.type === 'folder') flattenFileTree(entry.children, out);
    else out.push({ path: entry.path, name: entry.name });
  }
  return out;
}

// ── Grep fallback (no node:sqlite on this runtime) ──────────────────────────
// Degraded but functional: bounded synchronous scan, first match per file.
const GREP_MAX_FILES = 500;
const GREP_MAX_FILE_BYTES = 1024 * 1024;

function grepSearchFiles(query, limit) {
  const q = query.toLowerCase();
  const results = [];
  const files = flattenFileTree(getFileTree(WORKSPACE)).slice(0, GREP_MAX_FILES);
  for (const f of files) {
    if (results.length >= limit) break;
    const ext = path.extname(f.name).toLowerCase();
    if (ext !== '.md' && ext !== '.txt') continue;
    try {
      const full = path.join(WORKSPACE, f.path);
      if (fs.statSync(full).size > GREP_MAX_FILE_BYTES) continue;
      const content = fs.readFileSync(full, 'utf-8');
      if (content.toLowerCase().includes(q)) {
        results.push({
          type: 'file', path: f.path, title: path.basename(f.name, ext),
          tags: [], snippet: extractSnippet(content, q), matchType: 'content', score: 0,
        });
      }
    } catch (e) { /* unreadable file: skip */ }
  }
  return results;
}

// Legacy jsonl grep for conversation content (the pre-index search path,
// preserved in behaviour as the capability-gated degradation).
async function grepSearchTranscripts(query, convos) {
  const q = query.toLowerCase();
  const promises = convos.filter(c => c.sessionId).map(async (c) => {
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
          if (obj.type === 'user' && obj.message && typeof obj.message.content === 'string') {
            if (obj.message.content.toLowerCase().includes(q)) {
              rl.close();
              return { ...c, matchType: 'content', snippet: extractSnippet(obj.message.content, q) };
            }
          }
          if (obj.message && obj.message.role === 'assistant' && Array.isArray(obj.message.content)) {
            for (const block of obj.message.content) {
              if (block.type === 'text' && block.text && block.text.toLowerCase().includes(q)) {
                rl.close();
                return { ...c, matchType: 'content', snippet: extractSnippet(block.text, q) };
              }
            }
          }
        } catch (e) { /* skip */ }
      }
    } catch (e) { /* file read error */ }
    return null;
  });
  return (await Promise.all(promises)).filter(Boolean);
}

// ── Universal query assembly ─────────────────────────────────────────────────

// Merge a group's title-layer hits with its content hits: title hits lead,
// content hits fill the remainder, and a content hit for an item already
// present as a title hit enriches it (snippet etc.) instead of duplicating.
// Shared by the files and conversations groups, which differ only in key
// and enrichment fields.
function mergeHits(titleHits, contentHits, keyOf, enrich, limit) {
  const byKey = new Map();
  const merged = [];
  for (const h of titleHits) { byKey.set(keyOf(h), h); merged.push(h); }
  for (const h of contentHits) {
    const existing = byKey.get(keyOf(h));
    if (existing) { if (!existing.snippet) enrich(existing, h); continue; }
    merged.push(h);
  }
  return merged.slice(0, limit);
}

async function runUniversalSearch(msg) {
  // Params with no V1 client sender (fuzzy, tags, agentId, and the date
  // ranges) are deliberate: server capability landed first, the palette
  // filter UI is deferred until demand shows (the V2 chip design lives in
  // the vault mock). The integration suite keeps them honest meanwhile.
  const rawQuery = (msg.query || '').trim();
  const fuzzy = msg.fuzzy !== false;
  const limit = Math.min(msg.limit || 8, 25);
  // Tag/date-filtered searches suppress the unfiltered title layers: filters
  // only exist on indexed metadata, and mixing unfiltered title hits back in
  // would un-filter the groups.
  const filtersActive = !!((msg.tags && msg.tags.length) || msg.updatedFromMs || msg.updatedToMs || msg.createdFromMs || msg.createdToMs);
  const groups = { files: [], conversations: [], agents: [], skills: [] };
  if (!WORKSPACE) return { groups, recent: false };

  ensureSearchEngine();
  const convos = readConversations();

  // Empty query: recent items, not nothing (Reflect-style empty state).
  if (!rawQuery) {
    const recentConvos = convos.filter(c => c.status !== 'archived')
      .sort((a, b) => new Date(b.lastActiveAt || b.createdAt || 0) - new Date(a.lastActiveAt || a.createdAt || 0))
      .slice(0, limit)
      .map(c => ({ type: 'conversation', id: c.id, title: c.title, agentId: c.agentId, matchType: 'recent', lastActiveAt: c.lastActiveAt }));
    let recentFiles = [];
    if (searchEngine) {
      reconcileSearchBeforeQuery();
      try { recentFiles = searchEngine.recentFiles(limit); } catch (e) { recentFiles = []; }
    } else {
      recentFiles = flatFileListCached().slice(0, limit)
        .map(f => ({ type: 'file', path: f.path, title: path.basename(f.name, path.extname(f.name)), matchType: 'recent', tags: [] }));
    }
    return { groups: { ...groups, conversations: recentConvos, files: recentFiles }, recent: true };
  }

  // ── Files: fuzzy title layer + FTS content (or bounded grep) ──
  const fileTitleHits = filtersActive ? [] : titleLayerMatches(rawQuery, flatFileListCached(), f => f.name, { fuzzy })
    .slice(0, limit)
    .map(({ item, score }) => ({
      type: 'file', path: item.path,
      title: path.basename(item.name, path.extname(item.name)),
      tags: [], matchType: 'title', score,
    }));
  let fileContentHits = [];
  if (searchEngine) {
    reconcileSearchBeforeQuery();
    try {
      fileContentHits = searchEngine.searchFiles(rawQuery, {
        limit, prefix: !!msg.prefix, tags: msg.tags,
        updatedFrom: msg.updatedFromMs, updatedTo: msg.updatedToMs,
        createdFrom: msg.createdFromMs, createdTo: msg.createdToMs,
      }).map(h => ({ ...h, matchType: 'content' }));
    } catch (e) {
      console.warn('[Search] file query failed:', e && e.message ? e.message : e);
    }
  } else {
    fileContentHits = grepSearchFiles(rawQuery, limit);
  }
  groups.files = mergeHits(fileTitleHits, fileContentHits, h => h.path,
    (t, h) => { t.snippet = h.snippet; t.tags = h.tags; }, limit);

  // ── Conversations: fuzzy title layer + FTS content (or legacy grep) ──
  const convoPool = msg.agentId
    ? convos.filter(c => c.agentId === msg.agentId || (c.sessionIds || []).some(s => s && s.agentId === msg.agentId))
    : convos;
  const convoTitleHits = filtersActive ? [] : titleLayerMatches(rawQuery, convoPool, c => c.title, { fuzzy })
    .slice(0, limit)
    .map(({ item, score }) => ({
      type: 'conversation', id: item.id, title: item.title, agentId: item.agentId,
      matchType: 'title', score, lastActiveAt: item.lastActiveAt,
    }));
  let convoContentHits = [];
  if (searchEngine) {
    try {
      const byId = new Map(convos.map(c => [c.id, c]));
      // Hit shape contract: the V1 client renders id/title/agentId/snippet/
      // matchCount and anchors by snippet text. sessionId + seq are shipped
      // as the exact-addressing contract for a future seq-based anchor; the
      // engine's other per-hit fields (neighbour, message role/agent, ts)
      // stay server-side until a UI renders them.
      convoContentHits = searchEngine.searchMessages(rawQuery, {
        limit, prefix: !!msg.prefix, agentId: msg.agentId,
        fromMs: msg.fromMs || msg.updatedFromMs, toMs: msg.toMs || msg.updatedToMs,
      }).filter(h => byId.has(h.conversationId)).map(h => {
        const c = byId.get(h.conversationId);
        return {
          type: 'conversation', id: c.id, title: c.title, agentId: c.agentId,
          matchType: 'content', snippet: h.snippet, sessionId: h.sessionId,
          seq: h.seq, matchCount: h.matchCount, score: h.score,
          lastActiveAt: c.lastActiveAt,
        };
      });
    } catch (e) {
      console.warn('[Search] conversation query failed:', e && e.message ? e.message : e);
    }
  } else {
    convoContentHits = (await grepSearchTranscripts(rawQuery, convoPool)).map(c => ({
      type: 'conversation', id: c.id, title: c.title, agentId: c.agentId,
      matchType: 'content', snippet: c.snippet, lastActiveAt: c.lastActiveAt, score: 0,
    })).slice(0, limit);
  }
  groups.conversations = mergeHits(convoTitleHits, convoContentHits, h => h.id,
    (t, h) => { t.snippet = h.snippet; t.sessionId = h.sessionId; t.seq = h.seq; }, limit);

  // ── Agents + skills: tiny corpora, in-memory only, name > description ──
  // (scope addendum: do NOT index these; a query-time filter is always fresh)
  if (!filtersActive) {
    let agents = [];
    try { agents = discoverAgents().filter(a => a.status === 'onTeam'); } catch (e) {}
    const agentNameHits = titleLayerMatches(rawQuery, agents, a => `${a.displayName} ${a.role || ''}`, { fuzzy });
    groups.agents = agentNameHits.slice(0, limit).map(({ item, score }) => ({
      type: 'agent', id: item.id, name: item.displayName, role: item.role || '',
      icon: item.icon, colour: item.colour, matchType: 'title', score,
    }));

    let skills = [];
    try { skills = discoverSkillsCached(agents); } catch (e) {}
    const q = rawQuery.toLowerCase();
    const skillHits = titleLayerMatches(rawQuery, skills, s => s.name, { fuzzy });
    const seenSkills = new Set(skillHits.map(h => h.item.id));
    groups.skills = skillHits.slice(0, limit).map(({ item, score }) => ({
      type: 'skill', id: item.id, name: item.name, description: item.description || '',
      matchType: 'title', score,
    }));
    if (groups.skills.length < limit) {
      for (const s of skills) {
        if (groups.skills.length >= limit) break;
        if (seenSkills.has(s.id)) continue;
        if ((s.description || '').toLowerCase().includes(q)) {
          groups.skills.push({ type: 'skill', id: s.id, name: s.name, description: s.description || '', matchType: 'content', score: 0 });
        }
      }
    }
  }

  return { groups, recent: false };
}

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
      if (WORKSPACE && !fs.existsSync(WORKSPACE)) {
        console.log(`  Workspace no longer exists: ${WORKSPACE}`);
        WORKSPACE = null;
      }
      if (WORKSPACE) {
        loadRoutineState();
        saveRecentWorkspace(WORKSPACE);
        try { scaffoldWorkspace(WORKSPACE); } catch (e) { console.warn('Scaffold warning:', e.message); }
        const agents = discoverAgents();
        const totalRoutines = agents.reduce((sum, a) => sum + (a.routines?.length || 0), 0);
        console.log(`  Workspace: ${WORKSPACE}`);
        console.log(`  Agents: ${agents.map(a => a.displayName).join(', ')}`);
        console.log(`  Routines: ${totalRoutines}`);
        startScheduler();
        // Warm the search index off the startup path (reconcile-on-open).
        setImmediate(() => { try { ensureSearchEngine(); } catch (e) { console.warn('[Search] warm-up failed:', e.message); } });
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

// ── TEST-ONLY EXPORTS ──
// Mechanical re-exports of existing internals so the test suite (test/) can
// exercise them directly. No logic lives here; nothing in the production code
// paths reads module.exports._internal. setWorkspace/getWorkspace exist so
// tests can point the module-level WORKSPACE at a temp fixture directory.
module.exports._internal = {
  // workspace pointer (test fixture wiring only)
  setWorkspace(dir) { WORKSPACE = dir; invalidateAgentCache(); },
  getWorkspace() { return WORKSPACE; },
  // scheduler
  getNextRun, executeRoutine, routineState,
  loadRoutineState, saveRoutineState, recordRoutineRun,
  // agent + skill discovery / parsing
  discoverAgents, invalidateAgentCache, discoverSkills, parseSkillFile,
  parseAgentFrontmatter, extractFrontmatterText, parseCapabilities,
  parseRoutines, parsePrompts, parseSkills, readNormalisedFile, titleCase,
  // markers + text helpers
  stripRundockMarkers, isSilentParkResponse, sanitizeSpecialistOutput,
  extractSnippet, buildToolSummary, isAuthError, isModelError, validateWriteRequest,
  // rosters + prompts
  findDirectReportMatch, findOffRosterWorkspaceMatch, buildTeamRoster, buildPeerRoster,
  extractSelfDescription, buildSystemPrompt,
  // workspace analysis / scaffolding
  detectWorkspaceMode, isEmptyWorkspace, analyzeWorkspace,
  scaffoldDefaults, scaffoldWorkspace, muteHooks, discoverWorkspaces,
  readMcpServerNames, getFileTree, validateAgentSlug, isInsideWorkspace,
  // persistence
  readConversations, writeConversations, readState, writeState,
  loadTranscript, saveTranscript, appendTranscript, formatTranscript,
  transcriptDir, countSessionMessagesSync, countConversationMessages,
  parseSessionHistory, getSessionJsonlPath,
  // spawn plumbing
  wireProcessHandlers, handleDelegation, handleScopeReturn,
  handleChatSpawnError, resolveClaudeBin, spawnClaude,
  getBareArgs, getSpawnEnv, getDisallowedTools, getPermissionMode,
  getAllowedToolsInteractive, getAllowedToolsLegacy, modelArgs,
  killAllChildren, cleanOrphanedProcesses, loadPidFile,
  // live state maps
  chatProcesses, convoTranscripts, pendingPermissionRequests,
  agentAutoResumeCount, disconnectBuffer, connectedClients,
  incrementAutoResume, resetAutoResume,
  // universal search (SR1)
  ensureSearchEngine, runUniversalSearch, conversationSessionsForSearch,
  titleLayerMatches, flattenFileTree, grepSearchFiles, grepSearchTranscripts,
  resolveSessionPathCached, _sessionPathMemo, noteSearchConversationActivity,
  getSearchEngine() { return searchEngine; },
  _searchTestHooks: {
    // Simulate a persistent engine-open failure for backoff tests.
    simulateOpenFailure() {
      if (searchEngine) { try { searchEngine.close(); } catch (e) {} }
      searchEngine = null;
      searchEngineFailedWorkspace = WORKSPACE;
    },
  },
  // server objects (integration test lifecycle)
  server, wss,
  // constants
  MAX_CONSECUTIVE_AGENT_RESUMES, DEFAULT_MODEL, PERMISSION_TIMEOUT_MS,
  DISALLOWED_TOOLS_KNOWLEDGE, SPECIALIST_OUTPUT_MAX_CHARS,
};
