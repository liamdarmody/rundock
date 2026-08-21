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
const { resolvePermissionConvoId } = require('./permission-routing.js');
const { resolveMarkers } = require('./lib/delegation/markers.js');
const { createHandbackBuilder } = require('./lib/delegation/handback.js');
const { createDelegationRecord, attachDelegationRecord } = require('./lib/delegation/state.js');
const config = require('./lib/config.js');
const agentsDiscovery = require('./lib/agents/discovery.js');
const {
  discoverAgents, readNormalisedFile, extractFrontmatterText, titleCase,
  parseAgentFrontmatter, parseCapabilities, parseRoutines, parsePrompts, parseSkills,
  AGENT_CACHE_TTL,
} = agentsDiscovery;
const agentsPrompt = require('./lib/agents/prompt.js');
const {
  buildTeamRoster, buildPeerRoster, findDirectReportMatch,
  findOffRosterWorkspaceMatch, extractSelfDescription, buildSystemPrompt,
} = agentsPrompt;
const workspaceBoundary = require('./lib/workspace/boundary.js');
const { readBoundaryGrants, addBoundaryGrant, boundaryGrantCovers } = workspaceBoundary;
const workspaceAnalysis = require('./lib/workspace/analysis.js');
const { analyzeWorkspace, readMcpServerNames } = workspaceAnalysis;
const workspaceScaffold = require('./lib/workspace/scaffold.js');
const {
  muteHooks, isEmptyWorkspace, detectWorkspaceMode, scaffoldDefaults, scaffoldWorkspace,
} = workspaceScaffold;
const {
  rundockDir, readConversations, writeConversations,
  readLists, writeLists, deleteListEverywhere,
  readState, writeState,
} = require('./lib/store/persistence.js');
const {
  convoTranscripts, transcriptDir,
  loadTranscript, saveTranscript, buildToolSummary,
} = require('./lib/store/transcripts.js');
const signals = require('./lib/signals.js');
const { recordEvent, bumpSkillUsage, normalizeDocsGapTopic } = signals;

const PORT = process.env.PORT || 3000;
let ACTUAL_PORT = PORT; // Updated after server.listen() with the real listening port
// WORKSPACE mirrors lib/config's workspace root during the decomposition:
// this file's remaining read sites use the local variable, while extracted
// lib/ modules read config.getWorkspace() at use time. EVERY assignment must
// go through setWorkspaceRoot so the two can never drift.
let WORKSPACE = config.getWorkspace();
function setWorkspaceRoot(dir) {
  WORKSPACE = dir;
  config.setWorkspace(dir);
  // Clear stale scratch whenever a workspace becomes ACTIVE, not only when one
  // is preset at boot. A workspace chosen or switched in the interface arrives
  // here and never touches the boot path, so scratch in it would otherwise
  // accumulate with nothing ever clearing it. Housekeeping must never be able
  // to break a switch, hence the guard.
  try { pruneScratch(); } catch (e) { /* not worth failing a switch over */ }
}

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

// Is a workspace-relative path safe for the Files sidebar to create? Rejects
// any path with a dot-leading component: a leading-dot basename is filtered
// out of the file tree (so the new file would be invisible), and '.'/'..'
// segments are traversal. Independent of isInsideWorkspace so a '..' that
// happens to resolve back inside the workspace is still refused.
function isSafeCreatePath(rel) {
  if (typeof rel !== 'string' || !rel) return false;
  const segments = rel.split('/').filter(Boolean);
  if (!segments.length) return false;
  return !segments.some((seg) => seg.startsWith('.'));
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

// DEFAULT_MODEL lives in lib/config.js (shared with lib/agents and
// lib/runtime/claude.js, where modelArgs and spawnClaude apply it); the
// root re-reads it only for the _internal export.
const { DEFAULT_MODEL } = config;

// readMcpServerNames lives in lib/workspace/analysis.js (used only by the
// workspace analysis).

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

// getBareArgs and getSpawnEnv live in lib/runtime/claude.js (spawn
// plumbing); the workspace root and listening port are read at use time.
// Pending permission requests from PreToolUse hooks (keyed by requestId).
// Each entry holds the HTTP response object so we can resolve it when the user decides.
const pendingPermissionRequests = new Map();

// Workspace boundary grants live in lib/workspace/boundary.js (resolved
// from getWorkspace() at use time; the card handler and the permission
// bridge below call in).
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

// Session persistence (.rundock/ conversations, lists, state) lives in
// lib/store/persistence.js.

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
    .replace(/<!-- RUNDOCK:DOCS_GAP[^>]*-->/g, '')
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

// Handback payload building lives in lib/delegation/handback.js; the factory
// receives transcript access and marker stripping so the module stays free
// of workspace globals. Function declarations hoist, so binding here at the
// top of the file is safe even though loadTranscript is defined further down.
const { buildHandbackPayload, transcriptTurnsSince } = createHandbackBuilder({
  loadTranscript: (convoId) => loadTranscript(convoId),
  stripMarkers: (text) => stripRundockMarkers(text),
  maxChars: SPECIALIST_OUTPUT_MAX_CHARS,
});

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
// Message counts per session, keyed on the file's mtime and size.
//
// The conversation list enriches EVERY conversation on EVERY load, and it
// reloads on workspace open and on every client reconnect, including whenever
// a laptop wakes. Re-reading and re-parsing every session file each time makes
// the cost scale with conversations HELD rather than conversations CHANGED,
// which on a long-lived workspace is the difference between instant and a
// visible freeze. Same shape as the file-tree cache: a cheap stat decides
// whether the expensive read is needed at all.
const _sessionCountMemo = new Map(); // sessionId -> { mtimeMs, size, count }

function countSessionMessagesSync(sessionId) {
  // The cached resolver, unlike the raw lookup, remembers a MISS. That matters
  // because the expected location is derived from the workspace path: move or
  // merge a workspace and every session misses, and each miss otherwise lists
  // the projects directory and stats every entry, once per conversation, on
  // every load.
  const filePath = resolveSessionPathCached(sessionId);
  if (!filePath) return 0;
  let st;
  try { st = fs.statSync(filePath); } catch (e) { return 0; }
  const memo = _sessionCountMemo.get(sessionId);
  if (memo && memo.mtimeMs === st.mtimeMs && memo.size === st.size) return memo.count;
  const count = readSessionMessageCount(filePath);
  _sessionCountMemo.set(sessionId, { mtimeMs: st.mtimeMs, size: st.size, count });
  return count;
}

function readSessionMessageCount(filePath) {
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
      // Skip Rundock-injected priming messages: these aren't user-visible bubbles.
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

// ===== ROUTINE STATE + SCHEDULER =====
// Routine state, its persistence, and the scheduler (startScheduler,
// getNextRun, executeRoutine) live in lib/scheduler.js. routineState comes
// back BY IDENTITY for the test re-exports below.
const schedulerLib = require('./lib/scheduler.js');
const {
  routineState, loadRoutineState, saveRoutineState, recordRoutineRun,
  startScheduler, stopScheduler, getNextRun, executeRoutine,
} = schedulerLib;
// Hand lib/agents its root-owned dependencies (see the module headers).
// (routineState needs no wiring: discovery requires lib/scheduler.js
// directly and reads the module-owned state at use time.)
agentsPrompt.wirePromptDeps({ discoverSkills, detectCodexCached });
workspaceAnalysis.wireAnalysisDeps({ parseSkillFile });
workspaceScaffold.wireScaffoldDeps({ invalidateAgentCache, rebaselineAgentsWatcher });
// ===== SPAWN PLUMBING (lib/runtime/claude.js) =====
// modelArgs/getBareArgs/getSpawnEnv, the child-pid registry, resolveClaudeBin,
// killProcessTree, and spawnClaude. Only the listening port is wired in:
// everything else the module needs is lib-owned or read at use time.
const claudeRuntime = require('./lib/runtime/claude.js');
const {
  modelArgs, getBareArgs, getSpawnEnv,
  resolveClaudeBin, killProcessTree, spawnClaude,
  registerChildPid, unregisterChildPid, pruneScratch,
  loadPidFile, savePidFile, pidOf, pidRecordAlive, processCommand,
} = claudeRuntime;
claudeRuntime.wireClaudeRuntimeDeps({ getActualPort: () => ACTUAL_PORT });
const codexGlue = require('./lib/runtime/codex-glue.js');
const {
  shutdownCodexAppServer,
  readAgentInstructions, wireCodexDelegate, startCodexTurn,
} = codexGlue;
codexGlue.wireCodexGlueDeps({
  // Live state BY IDENTITY: the accessors return the root's own maps,
  // so the glue mutates the very entries tests and handlers observe.
  chatProcesses: () => chatProcesses,
  recentSpawnErrors: () => recentSpawnErrors,
  safeSend, appendTranscript, endConvoTransition,
  registerChildPid, unregisterChildPid, killProcessTree,
  requestServerPermission,
  getActualPort: () => ACTUAL_PORT,
  getPermissionTimeoutMs: () => PERMISSION_TIMEOUT_MS,
});

schedulerLib.wireSchedulerDeps({
  // The client set is read through an accessor: wss is created later at
  // boot. The spawn plumbing is a direct lib require inside the scheduler.
  getWssClients: () => wss.clients,
});
const httpRouter = require('./lib/http-router.js');
httpRouter.wireHttpRouterDeps({
  // Live state BY IDENTITY: the accessors return the root's own maps.
  chatProcesses: () => chatProcesses,
  pendingPermissionRequests: () => pendingPermissionRequests,
  isInsideWorkspace, safeSend, getFileTreeCached,
  getPermissionTimeoutMs: () => PERMISSION_TIMEOUT_MS,
});

// ===== AGENT HELPERS =====

function validateAgentSlug(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(name) && name.length <= 60 && !name.includes('..');
}

// ===== SYSTEM PROMPT BUILDER =====

// Flag all active orchestrator processes for roster refresh on next message.
// Called after agent/skill CRUD so the orchestrator respawns with an updated team roster.
// Uses chatProcesses (global Map declared later) via late binding.
// Watch .claude/agents so EXTERNAL edits (an editor, git, a sync client)
// reach live processes the same way in-app CRUD does. Without this, a hand
// edit updates discovery (2s cache TTL: chart, sidebar, matcher) but a
// long-lived agent process keeps its stale prompt roster until it happens to
// respawn.
//
// A self-owned POLLER, not fs.watch: event-based watching is exactly the
// seam where the live-refresh data-loss bug lived (0.11.5: fs.watchFile's
// async baseline could swallow a change forever) and fs.watch delivery
// differs across platforms and Node versions (its event form failed on CI
// Node 22 while passing on 24). A 2s signature poll over a directory of a
// dozen small files is deterministic everywhere and matches the agent
// cache's own TTL. In-app CRUD still flags directly; the poller firing
// behind it is idempotent.
const AGENTS_WATCH_POLL_MS = 2000;
let _agentsWatchTimer = null;
let _agentsDirSig = null;
function agentsDirSignature(dir) {
  try {
    let sig = '';
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith('.md')) continue;
      try { sig += f + ':' + fs.statSync(path.join(dir, f)).mtimeMs + ';'; } catch (e) { /* file vanished mid-scan */ }
    }
    return sig;
  } catch (e) {
    return null; // directory missing: a later appearance counts as a change
  }
}
// Setup is complete the moment a real (non-platform) agent is on the team,
// HOWEVER its file arrived: the save_agent marker path, an agent using the
// Write tool, or a user dropping a file in place. This used to live only in
// the save_agent handler, so a team created any other way left the workspace
// "setup pending" forever, with the client offering "Set up your team" to a
// user who already had one.
function maybeCompleteSetup(agentList) {
  try {
    const state = readState();
    if (state.setupComplete) return;
    if ((agentList || []).some(a => a.status === 'onTeam' && a.type !== 'platform')) {
      writeState({ ...state, setupComplete: true, setupCompletedAt: new Date().toISOString(), version: 1 });
      console.log('[Setup] Marked complete');
    }
  } catch (e) { /* state write is best-effort; the next convergence retries */ }
}

// The server's own writers (the boot/switch scaffold sync of managed files)
// call this after finishing, so the poller never mistakes a boot write for an
// external edit. Without it, the arm-then-scaffold order at every workspace
// entry point produced one guaranteed tick ~2s in that flagged every live
// orchestrator for roster refresh; whichever conversation's follow-up landed
// next was killed-and-respawned instead of reused (the CI spawn-count flake
// on main, 2026-08-11).
function rebaselineAgentsWatcher() {
  if (!WORKSPACE) return;
  _agentsDirSig = agentsDirSignature(path.join(WORKSPACE, '.claude', 'agents'));
}

function armAgentsDirWatcher() {
  if (_agentsWatchTimer) { clearInterval(_agentsWatchTimer); _agentsWatchTimer = null; }
  if (!WORKSPACE) return;
  const dir = path.join(WORKSPACE, '.claude', 'agents');
  _agentsDirSig = agentsDirSignature(dir);
  _agentsWatchTimer = setInterval(() => {
    const sig = agentsDirSignature(dir);
    if (sig === _agentsDirSig) return;
    _agentsDirSig = sig;
    invalidateAgentCache();
    flagRosterRefresh();
    maybeCompleteSetup(discoverAgents());
    console.log('[Roster] agents directory changed on disk; live orchestrators flagged');
  }, AGENTS_WATCH_POLL_MS);
  if (_agentsWatchTimer.unref) _agentsWatchTimer.unref();
}

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

// Roster builders, the delegation matchers, and system prompt assembly live
// in lib/agents/prompt.js. detectCodexCached stays below: its cache variable
// is shared with the settings runtime probe, which reads and writes it
// directly.
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

// Agent discovery (roster cache, frontmatter parsing) lives in
// lib/agents/discovery.js. The cascade below clears its agent cache plus
// the root-owned caches keyed off the same mutations; every agent/skill
// mutation and workspace switch calls it.
function invalidateAgentCache() { agentsDiscovery.invalidateAgentCache(); _skillCache = null; _skillCacheTime = 0; invalidateFileListCache(); invalidateFileTreeCache(); }

// Skill + file-list caches for the search hot path. discoverSkills
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

/**
 * Present a file result: its name, and the kind its icon needs.
 *
 * Applied to every file hit whichever layer produced it, so the name layer and
 * the content layer cannot drift apart. They already had drifted: the same
 * extension-stripping was written out longhand in three places.
 *
 * Deliberately done here at assembly time rather than in the search index. The
 * indexed title is what FTS matches on, and rewriting it would change what
 * queries hit, force every existing index to be migrated, and gain nothing:
 * the name layer already matches on the full file name including the
 * extension, over every file in the tree rather than only the indexed ones.
 * So this is a presentation change, and it stays one.
 */
function decorateFileHits(hits) {
  let kinds = null;
  return (hits || []).map((hit) => {
    let kind = hit.kind;
    if (!kind) {
      if (!kinds) kinds = new Map(flatFileListCached().map(f => [f.path, f.kind]));
      kind = kinds.get(hit.path);
    }
    return { ...hit, title: searchLib.displayTitle(hit.path), kind: kind || 'file' };
  });
}

function flatFileListCached() {
  const now = Date.now();
  if (_fileListCache && (now - _fileListCacheTime) < AGENT_CACHE_TTL) return _fileListCache;
  _fileListCache = flattenFileTree(getFileTreeCached());
  _fileListCacheTime = now;
  return _fileListCache;
}

// discoverAgents and readNormalisedFile live in lib/agents/discovery.js.
// Live external refresh: watch the file a client currently has open and push
// its new content when it changes on disk (Obsidian, an agent, another window).
// We poll the file's stats on our own timer rather than using fs.watch or
// fs.watchFile. fs.watch misses changes under load and varies by platform.
// fs.watchFile seeds its stat baseline ASYNCHRONOUSLY, which loses any change
// landing between the file_content send and that seed: the baseline absorbs
// the post-change stats and the watcher stays silent forever (reproduced
// under full CPU load, 2026-08-11; it was the CI flake of 2026-08-06). Our
// timer seeds the baseline synchronously in the same tick as the read, so by
// the time a client can react to file_content the watch is already armed
// against the content it was sent. Polling naturally handles atomic saves
// (write-temp-then-rename); identical content is never re-sent, so Rundock's
// own saves do not echo into a needless refresh. One watch per connection;
// it is replaced when the client opens another file and cleared on
// disconnect. Up-to-interval latency is an acceptable trade for reliability
// on an external-edit refresh.
const OPEN_FILE_POLL_MS = 700;

function closeOpenFileWatcher(ws) {
  if (ws._openFileWatch) {
    clearInterval(ws._openFileWatch.timer);
    ws._openFileWatch = null;
  }
}

function watchOpenFile(ws, relPath, fullPath) {
  closeOpenFileWatcher(ws);
  let lastPushed = null;
  let lastStat = null; // { mtimeMs, size } of the content last examined
  try {
    lastPushed = readNormalisedFile(fullPath);
    const st = fs.statSync(fullPath);
    lastStat = { mtimeMs: st.mtimeMs, size: st.size };
  } catch (e) { /* unreadable now; still watch, the first tick re-examines */ }
  const tick = () => {
    if (ws.readyState !== 1) return;
    let st;
    try { st = fs.statSync(fullPath); } catch (e) { return; } // deletion: leave the open view intact
    if (lastStat && st.mtimeMs === lastStat.mtimeMs && st.size === lastStat.size) return;
    let content;
    try { content = readNormalisedFile(fullPath); } catch (e) { return; } // mid-write: lastStat untouched, next tick retries
    lastStat = { mtimeMs: st.mtimeMs, size: st.size };
    if (content === lastPushed) return; // no real change (or our own save)
    lastPushed = content;
    ws.send(JSON.stringify({ type: 'file_changed', path: relPath, content }));
  };
  const timer = setInterval(tick, OPEN_FILE_POLL_MS);
  if (timer.unref) timer.unref(); // never hold shutdown open for a view refresh
  ws._openFileWatch = { timer };
}

// Frontmatter parsers (extractFrontmatterText, parseAgentFrontmatter,
// parseCapabilities, parseRoutines, parsePrompts, parseSkills) and titleCase
// live in lib/agents/discovery.js.

// The scheduler (startScheduler, getNextRun, executeRoutine, the routine
// broadcast) lives in lib/scheduler.js.

// Workspace analysis (Seven Signals, SKILL_CLUSTERS) lives in
// lib/workspace/analysis.js.
// Mode detection and scaffolding (muteHooks, isEmptyWorkspace,
// detectWorkspaceMode, scaffoldDefaults, scaffoldWorkspace) live in
// lib/workspace/scaffold.js.

// ===== HTTP SERVER =====

const server = http.createServer(httpRouter.handleHttpRequest);

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

// Transcript primitives (convoTranscripts cache, load/save/salvage,
// buildToolSummary) live in lib/store/transcripts.js. appendTranscript
// below composes them with the signal layer and the search reconcile.

// The signal layer (recordEvent, retention, the skill-usage sidecar,
// docs-gap topic normalization) lives in lib/signals.js. appendTranscript
// below is its main capture site.

function appendTranscript(convoId, role, agentId, text, type, meta) {
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
  // Signal layer: every agent turn converges here for BOTH runtimes with its
  // final text in hand, which makes this the one capture site for the turn
  // event. Callers with a process entry in scope pass it as `meta` so the
  // event can carry tool and skill STRUCTURE (counts and slugs, never
  // arguments); callers without one still produce a valid skinny event.
  if (role === 'agent') {
    const resolved = resolveMarkers(text || '');
    const markers = [];
    if (resolved.hasReturn) markers.push('return');
    if (resolved.hasComplete) markers.push('complete');
    const toolCalls = (meta && meta.toolCalls) || [];
    recordEvent('turn', {
      conv: convoId, agent: agentId,
      runtime: (meta && meta.runtime) || 'claude',
      d: {
        tools: toolCalls.length,
        skills: toolCalls.filter(t => t.tool === 'Skill' && t.arg).map(t => t.arg),
        markers,
        routing: type === 'routing',
      },
    });
    for (const m of (text || '').matchAll(/<!-- RUNDOCK:DOCS_GAP topic="([^"]*)" -->/g)) {
      recordEvent('docs_gap', { conv: convoId, agent: agentId, d: { topic: normalizeDocsGapTopic(m[1]) } });
    }
  }
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

// ── KILL-WINDOW STATE MACHINE (queued-message buffer) ─────────────────────
// A conversation whose process is being replaced moves through explicit
// transition states so a user message can never be written to a dying stdin
// and silently lost. Beyond the implicit idle/processing states (no record
// in this map: normal chat handling), the smallest set covering the real
// windows is:
//
//   killing    a scope-return or end_delegation kill has FIRED (signal sent)
//              but the process's close event has not yet run
//   restoring  the delegate close handler is restoring/respawning the parent
//
// A `chat` message arriving during either state is BUFFERED and replayed
// through the normal message handler once the replacement process is ready.
// Previously such a message passed the follow-up stdin gate (the dying
// process still looked live), cancelled the committed handback, and was
// written to a stdin that was about to close: the worst chat failure mode.
//
// The Codex runtime needs no buffer for its own supersede path: a new
// message there is captured by the superseding turn's closure and only sent
// to the shared app-server after the bounded _turnEnd wait, so it never
// touches a dying process (see startCodexTurn). Codex DELEGATES restore
// through the shared delegate close handler, so this buffer covers them.
const convoTransitions = new Map(); // convoId -> { state, owner, queued, failsafe }

// Test-only seam: widens the restoring window so the race is
// deterministically testable (see test/integration/kill-window.test.js).
// Default 0: production restoration stays synchronous.
const RESTORE_DELAY_MS = parseInt(process.env.RUNDOCK_TEST_RESTORE_DELAY_MS || '0', 10) || 0;

// `owner` is the dying entry whose replacement the window waits for; ends
// from an unrelated flow (a stale close handler racing a newer transition)
// are ignored so they cannot flush a window they do not own.
function beginConvoTransition(convoId, state, owner) {
  const existing = convoTransitions.get(convoId);
  if (existing) {
    // Same flow moving killing -> restoring keeps its queue.
    existing.state = state;
    existing.owner = owner;
    return existing;
  }
  const t = { state, owner, queued: [] };
  // Failsafe: a transition must never outlive its restoration. If an exotic
  // path replaces the dying entry before its close handler runs, nothing
  // would end the window and every later message would buffer forever; this
  // timer force-flushes instead. 10s is far beyond any real kill-to-close gap.
  t.failsafe = setTimeout(() => {
    console.warn(`[KillWindow] convo=${convoId} transition failsafe fired (${t.state}), flushing ${t.queued.length} buffered message(s)`);
    endConvoTransition(convoId, t.owner);
  }, 10000);
  if (t.failsafe.unref) t.failsafe.unref();
  convoTransitions.set(convoId, t);
  return t;
}

// Buffer a chat message when its conversation is mid-transition. Returns
// true when buffered (the caller must not process the message further).
function bufferChatIfTransitioning(convoId, msg) {
  const t = convoTransitions.get(convoId);
  if (!t) return false;
  t.queued.push(msg);
  console.log(`[KillWindow] convo=${convoId} buffered chat during ${t.state} (${t.queued.length} queued)`);
  return true;
}

// True when a chat message arrived during this conversation's current
// transition window. The restoration paths use it to skip their auto-continue
// routing prompts: the user's newer message supersedes the handoff, mirroring
// the live-window rule where a follow-up cancels the auto-return.
function convoHasBufferedChat(convoId) {
  const t = convoTransitions.get(convoId);
  return !!(t && t.queued.length);
}

// The ONE buffered-follow-up gate, used by every restoration path. When a
// chat message was buffered during the kill/restore window, the auto-continue
// prompt is skipped: the entry parks idle and the replayed message drives it
// instead. Without this gate the replayed message queues BEHIND the routing
// prompt and dies unread in stdin when that prompt re-delegates. Four
// hand-copied variants of this check once existed; a restoration path added
// without the gate silently drops a user's message, which is why it now has
// a single implementation to reach for.
function bufferedFollowUpTakesOver(convoId, entry, skippedWhat) {
  if (!convoHasBufferedChat(convoId)) return false;
  if (entry) { entry.idle = true; entry.idleSince = Date.now(); }
  console.log(`[KillWindow] convo=${convoId} skipping ${skippedWhat}, buffered follow-up takes over`);
  return true;
}

// End the transition and replay buffered messages through the normal chat
// handler, in arrival order. The map entry is deleted BEFORE replaying so
// the replayed message flows through the full handler (transcript append,
// runtime routing, follow-up gate) against the freshly restored process.
function endConvoTransition(convoId, owner) {
  const t = convoTransitions.get(convoId);
  if (!t) return;
  if (owner && t.owner && owner !== t.owner) return; // not this flow's window
  clearTimeout(t.failsafe);
  convoTransitions.delete(convoId);
  if (!t.queued.length) return;
  const liveWs = [...connectedClients].find(c => c.readyState === 1) || [...connectedClients][0];
  if (!liveWs) {
    console.warn(`[KillWindow] convo=${convoId} no client to replay ${t.queued.length} buffered message(s)`);
    return;
  }
  for (const queued of t.queued) {
    console.log(`[KillWindow] convo=${convoId} replaying buffered chat`);
    liveWs.emit('message', JSON.stringify(queued));
  }
}

// Arm the 500ms scope-return auto-kill for an entry that emitted a handoff
// marker. A user follow-up inside the window cancels it by clearing
// pendingKill (the follow-up stdin path). Once the kill actually FIRES the
// conversation enters the killing state, so any later message is buffered
// (see convoTransitions) instead of being written to the dying stdin.
function scheduleScopeReturnKill(e, convoId) {
  e.pendingKill = true;
  setTimeout(() => {
    if (!e.exited && e.pendingKill) { // no-op if a follow-up cleared pendingKill
      // Only open the window if this entry still executes the conversation;
      // a parked/replaced entry's kill must not buffer the successor's chat.
      if (chatProcesses.get(convoId) === e) beginConvoTransition(convoId, 'killing', e);
      try { killProcessTree(e.process); } catch (err) {}
    }
  }, 500);
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
  recordEvent('runtime_error', { conv: convoId, agent: entry.agentId, runtime: entry.runtime || 'claude', d: { class: 'auth' } });
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
  recordEvent('runtime_error', { conv: convoId, agent: entry.agentId, runtime: entry.runtime || 'claude', d: { class: 'model' } });
  safeSend(JSON.stringify({
    type: 'error',
    content: "The model set for this agent isn't valid. Open the agent's profile and set its model to opus, sonnet, or haiku. Rundock uses sonnet by default when no model is set.",
    _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId
  }));
}


// The engine reports positive auth evidence through this setter so the
// mutable runtime-status flag stays root-owned (sendAuthError, which clears
// it, also stays in the root and is injected).
function noteClaudeAuthEvidence() { _claudeAuthEvidence = true; }

// ===== DELEGATION ENGINE (lib/delegation/engine.js) =====
// The delegation / scope-return engine (wireProcessHandlers,
// handleScopeReturn, handleDelegation, handleEndDelegation) moved to
// lib/delegation/engine.js in slice 10. It is composed here, once, with the
// root-owned capabilities it needs: live process state by identity, the
// kill-window transition machine (which STAYS in this file: the engine calls
// in, nothing moves out), the transcript composition, the auto-resume
// budget, permission config, and the error family. Lib modules it uses are
// required directly by the engine; the workspace path is read at use time
// via lib/config.js.
const delegationEngineLib = require('./lib/delegation/engine.js');
const delegationEngine = delegationEngineLib.createDelegationEngine({
  processes: chatProcesses,
  safeSend,
  appendTranscript,
  formatTranscript,
  buildHandbackPayload,
  beginConvoTransition,
  endConvoTransition,
  scheduleScopeReturnKill,
  bufferedFollowUpTakesOver,
  incrementAutoResume,
  resetAutoResume,
  MAX_CONSECUTIVE_AGENT_RESUMES,
  getAllowedToolsInteractive,
  getDisallowedTools,
  getPermissionMode,
  handleChatSpawnError,
  isAuthError,
  isModelError,
  sendAuthError,
  sendModelError,
  isSilentParkResponse,
  noteClaudeAuthEvidence,
  RESTORE_DELAY_MS,
  stopEntryProcess,
});
const { wireProcessHandlers, handleScopeReturn, handleDelegation, handleEndDelegation } = delegationEngine;


// ===== WS DISPATCH (lib/protocol/handlers/) =====
// Every WS message type except the four root shims (chat, delegate,
// end_delegation, flush_buffer) is handled in lib/protocol/handlers/ and
// selected from this table. The context object's member list is frozen by
// the decomposition spec: handlers reach root-owned capabilities through it
// (and lib modules by direct require); they never require the root.
const protocolHandlers = require('./lib/protocol/handlers/index.js');
const wsDispatch = protocolHandlers.buildDispatch();
const wsHandlerContext = {
  processes: chatProcesses,                       // identity: live process map
  clients: connectedClients,                      // identity: connected socket set
  pendingPermissions: pendingPermissionRequests,  // identity: pending permission map
  // Kill-window machine: stays in the root, injected as a capability
  // (unused by the slice-9 handlers; the delegation glue consumes it).
  transitions: { bufferChatIfTransitioning, beginConvoTransition, endConvoTransition, scheduleScopeReturnKill },
  // Conversation/search query surface: the engine and its caches are root-owned.
  store: {
    countConversationMessages, parseSessionHistory,
    ensureSearchEngine, getSearchEngine: () => searchEngine,
    clearSearchFailure: () => { searchEngineFailedWorkspace = null; },
    reconcileSearchBeforeQuery, grepSearchTranscripts, runUniversalSearch,
  },
  // Roster/team capabilities: the cache cascade and skill discovery are root-owned.
  agents: { discoverSkills, invalidateAgentCache, flagRosterRefresh, maybeCompleteSetup, validateAgentSlug, armAgentsDirWatcher },
  // Workspace lifecycle, boundary guards, and file caches.
  workspace: {
    setWorkspaceRoot, healWorkspaceIfMoved, saveRecentWorkspace, loadRecentWorkspaces,
    discoverWorkspaces, isInsideWorkspace, isSafeCreatePath, getFileTreeCached,
    invalidateFileListCache, invalidateFileTreeCache, watchOpenFile,
    fileTreeForSend, broadcastFileTree, armFileTreeWatcher,
  },
  runtime: { getRuntimeStatus, killAllChildren, cleanOrphanedProcesses },
  signals: { reportStartup, phaseTimer },         // startup telemetry (recordEvent is lib-owned)
  broadcast: safeSend,
  config,                                         // lib/config module: getWorkspace at use time
};

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
  ws.send(JSON.stringify({ type: 'server_info', version: PKG_VERSION, platform: process.platform }));

  // Re-send pending permission requests so permission cards reappear after reconnect
  for (const [requestId, pending] of pendingPermissionRequests) {
    ws.send(JSON.stringify({
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'can_use_tool',
        tool_name: pending.toolName,
        input: pending.toolInput || {},
        ...(pending.boundary ? { boundary: true, resolved_path: pending.resolvedPath, grant_dir: pending.grantDir } : {})
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

        // KILL-WINDOW GUARD: if this conversation is mid-transition (a
        // handoff kill has fired, or a delegate's parent restoration is in
        // flight), the current process is dying and must not receive this
        // message. Buffer it; it replays through this handler once the
        // replacement process is ready. See convoTransitions.
        if (bufferChatIfTransitioning(convoId, msg)) return;

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
            stopEntryProcess(existing);
            processes.delete(convoId);
            existing = null; // Force fall-through to spawn path
          }

          // Kill-window safety: a follow-up arriving BEFORE a scheduled
          // auto-return kill fires passes this gate and cancels the kill
          // (pendingKill cleared below) so the still-live process serves it.
          // One arriving AFTER the kill fires never reaches this gate: the
          // conversation is in the killing/restoring transition and the
          // message was buffered above (see convoTransitions), so nothing is
          // ever written into the signal-to-close gap of a dying process.
          if (existing && !existing.exited && existing.process && existing.process.stdin && existing.process.stdin.writable) {
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
            existing.idle = false; existing.idleSince = null;
            existing.toolCalls = [];
            existing.turnStartTime = Date.now();
            existing.lastUserMessage = msg.content;
            existing.scopeReturnSource = null; // User sent new message, allow re-delegation
            resetAutoResume(convoId); // User spoke, reset circuit breaker
            if (existing.delegation) { existing.receivedFollowUp = true; }
            existing.process.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: msg.content } }) + '\n');
          } else {
            // No live process: spawn a new one (first message or after disconnect)
            // Stop any stale entry first (runtime-aware: a leftover Codex
            // entry interrupts its turn rather than killing anything).
            if (existing) {
              stopEntryProcess(existing);
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
              pendingAgentTools: null,  // [{ blockIndex, inputJson, complete }]
              toolCalls: [], turnStartTime: Date.now()
            };
            // A directly-started specialist can hand back too
            // (handleScopeReturn), and must hand back all of its turns, not
            // the last one, so it carries a delegation record.
            attachDelegationRecord(entry, createDelegationRecord());
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
                const markers = resolveMarkers(e.responseText);
                if (markers.mode && !e.delegation) {
                  e.scopeReturn = true;
                  // mode already applies COMPLETE-beats-RETURN precedence. This
                  // is the site that once shipped with the precedence inverted,
                  // which is why the rule now has exactly one implementation.
                  e.scopeReturnMode = markers.mode;
                  console.log(`[ScopeReturn] convo=${convoId} agent=${e.agentId} ${e.scopeReturnMode} marker on non-delegated process`);
                  // Follow-up in-window cancels the auto-return; post-kill messages buffer.
                  scheduleScopeReturnKill(e, convoId);
                }
                // Preserve the specialist output for handleScopeReturn:
                // mirror the delegate path so a direct RETURN injects the real
                // output into the orchestrator prompt, not an empty block.
                e.finalResponseText = e.responseText;
                if (e.responseText) {
            const toolSummary = buildToolSummary(e.toolCalls);
            const textWithTools = toolSummary ? toolSummary + '\n' + e.responseText : e.responseText;
            appendTranscript(convoId, 'agent', e.agentId, textWithTools, undefined, e);
            if (e.deliveredTurns) e.deliveredTurns.push(e.responseText);
          }
                e.responseText = '';
                e.idle = true; e.idleSince = Date.now();
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
              endConvoTransition(convoId, entry); // replay buffered messages into a fresh spawn
            });
          }

        // ── LEGACY MODE (--print, one process per message) ────────────
        } else {
          const processId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

          // Kill existing process for this conversation only
          if (processes.has(convoId)) {
            stopEntryProcess(processes.get(convoId));
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
            '--append-system-prompt', 'FORMATTING RULES (mandatory, apply to all output):\n- NEVER use em dashes (—) or en dashes (–) anywhere. This includes lists, headers, separators, and inline text. Wrong: "AI — your assistant". Right: "AI: your assistant". Use colons, full stops, commas, or restructure instead.\n- Use UK spelling throughout.\n\nPLATFORM RULES:\nRundock is a knowledge management platform. You can create and edit markdown, YAML, JSON, and text files. Executable code files (.js, .ts, .py, .sh, etc.) are outside the supported file types. Destructive commands (rm, sudo, chmod) are not supported. If a user asks you to do something outside these capabilities, explain that Rundock is designed for knowledge work and suggest an alternative approach using supported file types.']; // internal-refs-allow

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

      // ── DELEGATION: orchestrator hands off to another agent in the same conversation ──
      if (msg.type === 'delegate') {
        handleDelegation(msg, processes);
      }


      // End delegation: kill the delegate, restore the original. The body
      // moved to lib/delegation/engine.js with the engine in slice 10.
      if (msg.type === 'end_delegation') {
        handleEndDelegation(msg, processes);
      }

      // Every other message type dispatches to lib/protocol/handlers/ (see
      // the WS DISPATCH block above). The four handlers above this line stay
      // in the root deliberately: chat is the kill-window chat shim (the
      // pinned follow-up write-condition block), delegate/end_delegation are
      // delegation glue and move with the engine, and flush_buffer drains
      // safeSend's own reconnect buffer.
      const dispatchHandler = wsDispatch[msg.type];
      if (dispatchHandler) dispatchHandler(wsHandlerContext, ws, msg);
    } catch (e) {
      console.error('Error handling message:', e);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    connectedClients.delete(ws);
    closeOpenFileWatcher(ws); // stop watching this client's open file
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
      // Normalised, like every other read in discovery. A raw read here meant
      // the newline-only frontmatter pattern below missed on a CRLF checkout,
      // so the body came back empty and this whole pass silently matched
      // nothing on Windows while explicit assignments carried on working.
      const content = readNormalisedFile(path.join(agentsDir, agent.fileName));
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
// BINARY_FILE_TYPES (the viewer mime allowlist) lives in lib/http-router.js.

// Classify a file for its tree icon: a .md whose frontmatter carries the
// kanban-plugin key is a board, other .md are notes, and the rest by extension.
// The frontmatter read is a small head slice; failures fall back to 'note'.
// Read at most maxBytes from the head of a file without loading the whole
// thing. getFileTree calls this for every markdown file on every refresh, so
// it must not scale with file size.
function readFileHead(fullPath, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(fullPath, 'r');
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf-8', 0, bytesRead);
  } catch (e) {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} }
  }
}

function fileKind(fullPath, name) {
  if (/\.mdx?$/i.test(name)) {
    // Only the frontmatter head is needed to spot a board; a bounded read
    // keeps this O(1) regardless of note size.
    const head = readFileHead(fullPath, 1024);
    const m = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (m && /(^|\r?\n)\s*kanban-plugin\s*:/.test(m[1])) return 'board';
    return 'note';
  }
  if (/\.(html?|svg)$/i.test(name)) return 'artifact';
  if (/\.pdf$/i.test(name)) return 'pdf';
  if (/\.(png|jpe?g|gif|webp)$/i.test(name)) return 'image';
  return 'file';
}

// Kind, but only opening files whose identity has changed. Classifying a
// markdown file reads its frontmatter head, which OPENS it, and on a
// cloud-synced vault (iCloud, OneDrive, Dropbox online-only files) an open
// can force the provider to download content. A stat reads metadata only and
// materialises nothing, so it is the cheap question ("same file as last
// time?") that decides whether the expensive one ("what is in it?") is asked
// at all. A rebuild over an unchanged vault opens zero files.
//
// Entries for deleted files linger until the process restarts; at three
// small numbers per path that is noise, and pruning would cost a pass over
// the map on every walk to save it.
const _fileKindCache = new Map(); // absolute path -> { mtimeMs, size, kind }

function fileKindCached(fullPath, name) {
  // Only markdown classification reads content; everything else is decided
  // by extension alone, with no I/O to save.
  if (!/\.mdx?$/i.test(name)) return fileKind(fullPath, name);
  let st;
  try { st = fs.statSync(fullPath); } catch (e) { return fileKind(fullPath, name); }
  const hit = _fileKindCache.get(fullPath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.kind;
  const kind = fileKind(fullPath, name);
  _fileKindCache.set(fullPath, { mtimeMs: st.mtimeMs, size: st.size, kind });
  return kind;
}

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
        entries.push({ type: 'file', name: item.name, path: relativePath, kind: fileKindCached(path.join(dir, item.name), item.name) });
      }
    }
  } catch (e) {}
  return entries;
}

// ── File tree cache ────────────────────────────────────────────────────────
// getFileTree walks the workspace synchronously and reads the first kilobyte
// of every markdown file to classify it. The client asks for the tree far more
// often than "on open": after every file-writing tool call and after every
// agent turn. In the packaged app the server shares a thread with the window,
// so an uncached walk surfaces as the whole UI freezing on a large vault.
//
// Freshness is a directory-only stat pass. Creating, deleting or renaming
// anything bumps the mtime of the directory containing it, so directory mtimes
// are exactly the signal for "the shape of the tree changed". Editing a file's
// CONTENTS does not touch them, and that is the common case during agent work,
// so it becomes a pure cache hit with no directory reads at all.
//
// Known limit: fileKind classifies a note as a board by reading its
// frontmatter, so adding kanban-plugin frontmatter changes a node's kind
// without changing any directory mtime. Saves made through Rundock invalidate
// explicitly, which covers the path a user actually takes to do that.
let _treeCache = null; // { tree, dirs: Map<absolutePath, mtimeMs> }

function invalidateFileTreeCache() { _treeCache = null; }

// Directory list is derived from the tree we just built rather than by walking
// again: the folder nodes are already there, so this costs one stat per
// directory and zero directory reads.
function treeDirMtimes(nodes, out = new Map()) {
  for (const n of nodes) {
    if (n.type !== 'folder') continue;
    const abs = path.join(WORKSPACE, n.path);
    try { out.set(abs, fs.statSync(abs).mtimeMs); } catch (e) { /* raced away */ }
    treeDirMtimes(n.children || [], out);
  }
  return out;
}

function treeCacheIsFresh() {
  if (!_treeCache || !WORKSPACE) return false;
  for (const [dir, mtimeMs] of _treeCache.dirs) {
    let st;
    try { st = fs.statSync(dir); } catch (e) { return false; } // deleted or renamed
    if (st.mtimeMs !== mtimeMs) return false;
  }
  return true;
}

function getFileTreeCached() {
  if (!WORKSPACE) return [];
  if (treeCacheIsFresh()) return _treeCache.tree;
  const tree = getFileTree(WORKSPACE);
  const dirs = treeDirMtimes(tree);
  // The root is not a node in its own tree, but a file created directly in it
  // bumps only the root's mtime, so it has to be tracked explicitly.
  try { dirs.set(WORKSPACE, fs.statSync(WORKSPACE).mtimeMs); } catch (e) {}
  _treeCache = { tree, dirs };
  return tree;
}

// ── External-change poll ───────────────────────────────────────────────────
// Nothing else watches the filesystem on the tree's behalf. The client asks
// for the tree in exactly three places and all three mean "Rundock did
// something": workspace open, after a file-writing tool call, and after an
// agent turn. So a file written by anything else (a CLI agent session, an
// editor, git, a sync client) never reached the sidebar until a restart,
// while search saw it within seconds through its own TTL-gated reconcile.
//
// A self-owned POLLER, not fs.watch, for the reasons already written up at
// the agents-directory watcher: event-based watching is where the 0.11.5
// live-refresh data-loss bug lived, and fs.watch delivery differs across
// platforms and Node versions. Detection is the tree cache's own freshness
// pass, which is a directory-only stat walk, so a quiet workspace costs one
// stat per directory and reads none of them.
//
// TWO GUARDS, because a push that fights the reconcile diff would undo the
// no-flicker work that card bought.
//
// The first is identity, and it must NOT be a freshness check. _treeCache is
// shared by every caller of getFileTreeCached, not only by the poll and the
// handlers: the search file list and the grep file list both rebuild it on
// their own expiry. So a search running between an external write and the
// next tick rebuilds the cache to match the already-changed disk and marks it
// fresh, without touching _lastSentTreeSig. A tick guarded on freshness then
// returns before it ever compares signatures, and that external change is
// never pushed at all: the sidebar stays stale until some unrelated change
// happens to occur. An earlier revision of this poll had exactly that bug,
// defended with a cost argument that assumed the poll and the handlers were
// the only writers of the cache. They are not.
//
// Comparing the tree OBJECT instead is both correct and cheap. A fresh cache
// hands back the same array every time, so an idle tick matches on identity
// and returns without serialising anything. A cache rebuilt by anyone at all
// hands back a new array, which fails identity and falls through to the
// signature comparison, where a genuine change is caught and a rebuild that
// changed nothing costs one serialisation and is dropped.
//
// The second is the signature, and it is the one that is easy to get wrong.
// Cache invalidation is NOT evidence of an external change: every in-app save
// and create calls invalidateFileTreeCache(), which makes treeCacheIsFresh()
// false on the very next tick. Keying the push off freshness alone therefore
// duplicates every tree the handlers already sent, and re-walks after every
// content save. Comparing against the last tree actually SENT distinguishes
// the two: the handlers record theirs through fileTreeForSend, so work that
// went out through a handler is already accounted for by the time the poll
// looks. Tree nodes carry only type, name, path and kind, never mtime or
// size, so a content edit cannot move the signature on its own.
//
// One consequence worth naming: changing a note's frontmatter to a board DOES
// move the signature, so the poll happens to close the fileKind gap recorded
// against the cache above. That is a side effect of comparing trees rather
// than an intended feature, and nothing should depend on it.
const TREE_WATCH_POLL_MS = parseInt(process.env.RUNDOCK_TREE_POLL_MS || '', 10) || 2000;
let _treeWatchTimer = null;
let _lastSentTreeSig = null;
// The exact array last compared. Identity only: never read for its contents.
let _lastSeenTree = null;

// The tree, plus a record that this is what clients have now been told. Every
// site that sends a file_tree must go through here or through
// broadcastFileTree, or the poll will send it again.
//
// Use this one only where the send genuinely concerns the requester alone.
// The record it writes is process-global, so a send that reaches ONE client
// while claiming the tree is delivered starves every other client of the
// poll's broadcast: see broadcastFileTree.
function fileTreeForSend() {
  const tree = getFileTreeCached();
  _lastSeenTree = tree;
  _lastSentTreeSig = JSON.stringify(tree);
  return tree;
}

// The tree, delivered to EVERY connected client, and recorded as delivered.
//
// The record that suppresses the poll is process-global, but a reply on one
// socket is not. So a per-connection reply that recorded the tree as sent
// would tell the poll to stay quiet about a change the other clients never
// received, and they would sit stale until some later change happened to
// occur. They made no request of their own, which is exactly the case the
// poll exists to serve.
//
// The file tree is shared state: one server, one workspace, one tree. Every
// client wants the same answer, so the send that records it as answered has
// to be the send that reaches all of them. A client that did not ask
// reconciles the push to zero operations and nothing moves on its screen.
function broadcastFileTree() {
  safeSend(JSON.stringify({ type: 'file_tree', tree: fileTreeForSend() }));
}

function armFileTreeWatcher() {
  if (_treeWatchTimer) { clearInterval(_treeWatchTimer); _treeWatchTimer = null; }
  if (!WORKSPACE) return;
  // Drop the cache before baselining, because every caller has just pointed
  // the server at a workspace and the cache still describes the previous one.
  // Freshness re-stats the ABSOLUTE directory paths it recorded and never
  // checks which workspace they belong to, so a previous workspace still
  // sitting untouched on disk reads as fresh: the baseline would be taken
  // from the wrong tree and the interval would go on stat-checking the wrong
  // directories, unable to see any change in the workspace it is supposed to
  // be watching. Arming is always a workspace boundary, so this is always the
  // right thing to do here, and it belongs here rather than at each call site
  // where the next one added would forget it.
  invalidateFileTreeCache();
  // Baseline against what is on disk right now, so entering a workspace is
  // never itself reported as an external change.
  _lastSeenTree = getFileTreeCached();
  _lastSentTreeSig = JSON.stringify(_lastSeenTree);
  _treeWatchTimer = setInterval(() => {
    if (!WORKSPACE) return;
    const tree = getFileTreeCached();
    if (tree === _lastSeenTree) return;
    _lastSeenTree = tree;
    const sig = JSON.stringify(tree);
    if (sig === _lastSentTreeSig) return;
    _lastSentTreeSig = sig;
    safeSend(JSON.stringify({ type: 'file_tree', tree }));
    console.log('[FileTree] workspace changed on disk; pushed a refreshed tree');
  }, TREE_WATCH_POLL_MS);
  // Never hold shutdown open for a sidebar refresh.
  if (_treeWatchTimer.unref) _treeWatchTimer.unref();
}

// ===== PROCESS CLEANUP (S4) =====

// The child-pid registry (pid file, recycling guard, register/unregister)
// lives in lib/runtime/claude.js with spawnClaude, its writer. The cleanup
// machinery below reads and prunes the same file through the lib module.

// Stop whatever executes a conversation entry. Claude entries own a child
// process and get the signal; Codex entries are process-less (their turns
// run on the SHARED app-server, which must never be killed for one
// conversation) and interrupt their own turn instead.
function stopEntryProcess(entry, signal) {
  if (!entry) return;
  if (entry.interrupt) { entry.interrupt(); return; }
  if (entry.process) {
    try { killProcessTree(entry.process, signal); } catch (e) { /* already dead */ }
  }
}

// Kill all tracked child processes (called on exit and workspace switch).
function killAllChildren() {
  for (const [, entry] of chatProcesses) {
    if (!entry.exited) stopEntryProcess(entry, 'SIGTERM');
  }
  chatProcesses.clear();
  // The shared Codex app-server goes down with the rest; the next Codex
  // turn recreates it lazily (against the new workspace after a switch).
  shutdownCodexAppServer();
  // Only forget the pids we can confirm are gone. Clearing the file
  // unconditionally meant any child that was slow to exit, or that ignored
  // SIGTERM, became untracked and could never be reaped on the next launch:
  // the comment claimed cleanup was handled, but nothing checked.
  savePidFile(loadPidFile().filter(rec => pidRecordAlive(rec)));
}

// Clean up orphaned processes from a previous crash (PIDs left in the file)
function cleanOrphanedProcesses() {
  const records = loadPidFile();
  if (records.length === 0) return;
  let cleaned = 0;
  const survivors = [];
  for (const rec of records) {
    const pid = pidOf(rec);
    if (!pidRecordAlive(rec)) continue; // gone, or the pid now belongs to something else
    killProcessTree(pid, 'SIGTERM');
    cleaned++;
    // Keep it until a later launch observes it gone: a process that ignores
    // SIGTERM must not be forgotten just because we signalled it once.
    if (pidRecordAlive(rec)) survivors.push(rec);
  }
  if (cleaned > 0) {
    console.log(`[Cleanup] Killed ${cleaned} orphaned process tree(s) from a previous session`);
  }
  savePidFile(survivors);
}

// Track recent spawn errors per conversation for dedupe within a 30-second window.
// Without this, a fully broken install could spam system/info messages on every retry.
const recentSpawnErrors = new Map(); // convoId -> { code, ts }

// Surface a spawn-error to the chat with code-specific copy, dedupe consecutive
// identical errors per conversation, and mark the corresponding chatProcesses
// entry so the close handler can skip its user-facing emissions.
function handleChatSpawnError(err, convoId) {
  recordEvent('delegation_error', { conv: convoId, d: { reason: 'spawn_failed' } });
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
      parent.idle = true; parent.idleSince = Date.now();
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

// resolveClaudeBin, killProcessTree, and spawnClaude live in
// lib/runtime/claude.js (spawn plumbing).

// ===== RUNTIME STATUS =====
// The Codex runtime glue (shared app-server lifecycle, turns, delegate
// wiring, approvals, keepalive, failure surfaces) lives in
// lib/runtime/codex-glue.js, wired at boot via wireCodexGlueDeps. What
// remains here is settings machinery (the runtime status probe below)
// and requestServerPermission, the generic server-originated permission
// bridge the glue borrows by injection.

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
      // Closed stdin (PROBE_STDIO): an open piped stdin can hang a Windows
      // version/which probe for its full timeout (Findings 4/5, verified
      // live for the codex probe; applied consistently to both runtimes).
      execSync(isWindows ? 'where.exe claude' : 'which claude', { timeout: 5000, encoding: 'utf-8', stdio: codexRuntime.PROBE_STDIO });
    } catch (e) { claudeInstalled = false; }
    claudeVersion = null;
    if (claudeInstalled) {
      try {
        const out = execSync(`"${resolveClaudeBin()}" --version`, { timeout: 5000, encoding: 'utf-8', stdio: codexRuntime.PROBE_STDIO });
        const m = String(out).match(/(\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.]+)?)/);
        claudeVersion = m ? m[1] : null;
      } catch (e) { /* installed but --version failed */ }
    }
    _claudeProbeCache = { installed: claudeInstalled, version: claudeVersion };
    _claudeProbeTime = Date.now();
  }
  // Codex detection, cached with the same policy as the claude probe above
  // (60s, and a cached "not installed" is never trusted: the user may have
  // just installed, and that is exactly when they open settings to check).
  // Finding 5 (Windows VM): detectCodex shells out twice (where + codex
  // --version) on this WebSocket handler path, and the version probe hung
  // ~5s per call against an open stdin; even with the closed-stdin fix the
  // repeat calls should never re-pay the shell-out. The prompt-side cache
  // (_codexDetectCache, also read by detectCodexCached) doubles as this
  // probe cache and is refreshed whenever a fresh detection runs.
  let codexStatus;
  if (_codexDetectCache && _codexDetectCache.installed && (Date.now() - _codexDetectTime) < 60000) {
    // Serve the expensive shell-out results (installed/version) from the
    // cache, but re-read the cheap presence fields (auth.json, Windows
    // sandbox config: a stat each) live, so a fresh `codex login` shows on
    // the very next settings open.
    codexStatus = { ..._codexDetectCache, ...codexRuntime.codexPresenceFields() };
    _codexDetectCache = codexStatus;
  } else {
    try { codexStatus = codexRuntime.detectCodex(); }
    catch (e) { codexStatus = { installed: false, authenticated: false, version: null }; }
    _codexDetectCache = codexStatus;
    _codexDetectTime = Date.now();
  }
  return {
    defaultRuntime: 'claude',
    claude: { installed: claudeInstalled, authenticated: claudeInstalled ? _claudeAuthEvidence : false, version: claudeVersion },
    codex: codexStatus,
  };
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
    if (!entry.exited && entry.process) {
      try { killProcessTree(entry.process, 'SIGKILL'); } catch (e) {}
    }
  }
  // The shared Codex app-server may still be draining its graceful
  // SIGTERM; it must not outlive the server process.
  const codexAppServerPid = codexGlue.getCodexAppServerPid();
  if (codexAppServerPid) {
    try { killProcessTree(codexAppServerPid, 'SIGKILL'); } catch (e) {}
  }
});

// ===== UNIVERSAL SEARCH =====
// FTS5 engine over files + conversations when node:sqlite is available;
// grep fallback otherwise. The engine is lazily (re)opened per workspace so
// every entry point: WS handlers, hooks, tests driving _internal: heals
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

// ── Incremental file-index warm-up ─────────────────────────────────────────
// Indexing the workspace files is the longest single piece of work the server
// does, and it scales with workspace size. The server shares a thread with the
// window in the packaged app, so running it to completion in one go paints the
// UI and then freezes it until indexing finishes: indistinguishable, from the
// user's side, from a crash. Restarting only starts the work again.
//
// Driving the pass a batch at a time, with a turn of the event loop between
// batches, keeps the socket serviced throughout. Search degrades to the
// existing grep fallback until the index is ready.
let _fileIndexRun = null;

/** Tell clients whether the index is building, so the UI can say so. */
function broadcastSearchIndexState(state, workspace, extra) {
  safeSend(JSON.stringify({ type: 'system', subtype: 'search_index', state, path: workspace, ...(extra || {}) }));
}

/** True while a warm-up pass is in flight. */
function fileIndexInProgress() { return !!_fileIndexRun; }

function cancelIncrementalFileIndex() {
  if (!_fileIndexRun) return;
  _fileIndexRun.cancelled = true;
  // .return() runs the generator's finally, which rolls back any open batch.
  try { _fileIndexRun.iter.return(); } catch (e) { /* already finished */ }
  _fileIndexRun = null;
}

function beginIncrementalFileIndex(newMessages) {
  cancelIncrementalFileIndex();
  const engine = searchEngine;
  const workspace = WORKSPACE;
  const startedAt = Date.now();
  const run = { iter: engine.reconcileFilesIncremental(workspace), cancelled: false };
  _fileIndexRun = run;
  broadcastSearchIndexState('indexing', workspace);

  const finish = (result) => {
    if (_fileIndexRun === run) _fileIndexRun = null;
    searchFilesReconciledAt = Date.now();
    const scanned = result ? result.scanned : 0;
    const updated = result ? result.updated : 0;
    console.log(`[Search] index ready: ${scanned} files scanned (${updated} indexed), ${newMessages || 0} new messages`);
    reportStartup(`search index ready in ${Date.now() - startedAt}ms | scanned ${scanned} | indexed ${updated}`);
    broadcastSearchIndexState('ready', workspace, { scanned, updated });
  };

  const step = () => {
    // A workspace switch replaces the engine underneath us. A stale run must
    // stop and release its transaction rather than write into a closed
    // database.
    if (run.cancelled || searchEngine !== engine || WORKSPACE !== workspace) {
      try { run.iter.return(); } catch (e) {}
      return;
    }
    let r;
    try { r = run.iter.next(); } catch (e) {
      console.warn('[Search] file index pass failed; progress kept:', e && e.message ? e.message : e);
      finish(null);
      return;
    }
    if (!r.done) { setImmediate(step); return; }
    finish(r.value);
  };
  setImmediate(step);
}

// ── Idle agent reaping ─────────────────────────────────────────────────────
// One agent process is kept per conversation touched, plus every parked
// ancestor in a delegation chain, and nothing used to release them: a process
// lived until it exited on its own, was cancelled, or the app quit. Each also
// holds its own set of tool servers, so memory grew with session length and
// conversation count until the machine started swapping. Observed on a user's
// machine as three agent trees alive for nearly eighteen hours, spawned within
// four minutes of launch and untouched since.
//
// Safe because it is not destructive: session ids are persisted per
// conversation and the client sends one back with its next message, so a
// reaped conversation resumes with its context intact.
// An hour rather than minutes. Both real reports of this problem were small
// numbers of processes held for enormous durations (three trees for nearly
// eighteen hours; one parked for fifteen), so duration is what needs bounding,
// and a twitchy timer buys nothing while risking work we cannot see. Set to 0
// to switch reaping off entirely.
const IDLE_REAP_RAW = process.env.RUNDOCK_IDLE_REAP_MS;
const IDLE_REAP_MS = (IDLE_REAP_RAW == null || IDLE_REAP_RAW === '')
  ? 60 * 60 * 1000
  : Number(IDLE_REAP_RAW);
// Sweep often enough to be responsive, rarely enough to be invisible. Bounded
// below so a small test interval cannot spin the loop.
const REAP_SWEEP_MS = Math.max(1000, Math.min(IDLE_REAP_MS || 0, 60 * 1000) || 60 * 1000);

/**
 * Did this conversation, or any agent parked behind it, launch a background
 * task? The flag says one was STARTED, not that it is still running: telling
 * those apart would mean inspecting processes, which has no portable form
 * across macOS, Windows and Linux. Erring towards holding one extra agent is
 * the right way to be wrong, since the alternative is killing work someone is
 * waiting on.
 */
function chainStartedBackgroundTask(entry) {
  let node = entry;
  const seen = new Set();
  while (node && !seen.has(node)) {
    if (node.startedBackgroundTask) return true;
    seen.add(node);
    const d = node.delegation;
    node = d ? (d.originalEntry || d.orchestratorEntry) : null;
  }
  return false;
}

/** Kill an entry and every ancestor parked behind it, tool servers included. */
function reapEntryChain(entry) {
  let node = entry;
  const seen = new Set();
  while (node && !seen.has(node)) {
    seen.add(node);
    if (!node.exited) stopEntryProcess(node, 'SIGTERM');
    node.exited = true;
    const d = node.delegation;
    node = d ? (d.originalEntry || d.orchestratorEntry) : null;
  }
  return seen.size;
}

function reapIdleAgents(now = Date.now()) {
  let reaped = 0, processes = 0;
  for (const [convoId, entry] of [...chatProcesses]) {
    if (!entry || entry.exited) continue;
    // Mid-turn: the user is waiting on an answer.
    if (!entry.idle) continue;
    // A handback is already scheduled or in flight; do not race it.
    if (entry.pendingKill || entry.scopeReturn) continue;
    // The process is being replaced right now (kill-window state machine).
    if (convoTransitions.has(convoId)) continue;
    // Work that outlives its turn and never reappears in the stream.
    if (chainStartedBackgroundTask(entry)) continue;
    const since = entry.idleSince || 0;
    if (!since || now - since < IDLE_REAP_MS) continue;

    processes += reapEntryChain(entry);
    chatProcesses.delete(convoId);
    reaped += 1;
  }
  if (reaped > 0) {
    console.log(`[Reap] released ${reaped} idle conversation(s), ${processes} process tree(s); they resume on next use`);
  }
  return reaped;
}

function startIdleReaper() {
  if (!(IDLE_REAP_MS > 0)) {
    console.log('[Reap] idle reaping disabled');
    return null;
  }
  const timer = setInterval(() => {
    try { reapIdleAgents(); } catch (e) { console.warn('[Reap] sweep failed:', e && e.message ? e.message : e); }
  }, REAP_SWEEP_MS);
  if (timer.unref) timer.unref();
  return timer;
}

// ── Startup timings ────────────────────────────────────────────────────────
// Diagnosing a single hang report meant five rounds of asking a user for
// process lists, memory figures and directory sizes, produced seven hypotheses
// of which six were refuted by measurement, and still did not find the cause,
// because nothing the app recorded said where its time had gone.
//
// Console output alone does not help: in the packaged app it goes nowhere a
// user can see, and asking someone to quit, open a terminal and reproduce the
// problem was tried three times and happened zero times. So this also lands in
// a small file we can simply ask for.
//
// SAFE TO HAND OVER UNREAD, BY CONSTRUCTION: phase names and numbers, nothing
// else. Never add a path, a filename, an agent name, or any content to these
// lines. A test asserts this and should be left to.
const STARTUP_LOG_MAX_LINES = 200;
const SLOW_PHASE_MS = 1000;

function appendStartupLog(line) {
  if (!WORKSPACE) return;
  try {
    const file = path.join(rundockDir(), 'startup.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean); } catch (e) {}
    lines.push(line);
    // A support artifact, not an audit trail.
    if (lines.length > STARTUP_LOG_MAX_LINES) lines = lines.slice(-STARTUP_LOG_MAX_LINES);
    fs.writeFileSync(file, lines.join('\n') + '\n');
  } catch (e) { /* diagnostics must never break startup */ }
}

function reportStartup(line) {
  const stamped = `[Startup] ${new Date().toISOString()} ${line}`;
  console.log(stamped);
  appendStartupLog(stamped);
}

/** Accumulate per-phase durations, flagging any that are unusually slow. */
function phaseTimer() {
  const started = Date.now();
  let last = started;
  const parts = [];
  return {
    mark(name) {
      const now = Date.now();
      parts.push({ name, ms: now - last });
      last = now;
    },
    summary() {
      const total = Date.now() - started;
      const rendered = parts.map(p => `${p.name} ${p.ms}ms`).join(' | ');
      const slow = parts.filter(p => p.ms >= SLOW_PHASE_MS).map(p => p.name);
      return `${rendered} | total ${total}ms${slow.length ? `  SLOW: ${slow.join(', ')}` : ''}`;
    },
  };
}

// ── Moved-workspace healing ────────────────────────────────────────────────
// Parts of .rundock silently assume the absolute path the workspace lived at
// when they were written. Move it, rename it, or copy it to another machine and
// they are all wrong, with nothing to notice or repair them.
//
// Users zip folders; that is what people do. Any rule we publish about what to
// migrate will be got wrong by someone doing the obvious thing, so the product
// copes instead.
//
// Conversations and transcripts are deliberately NOT touched: they are real
// content, they are self-contained, and they travel fine.
let _indexProvenanceUnknown = false;

// Below this share of indexed paths still existing, the index plainly belongs
// to a different layout. Generous on purpose: a normal workspace between two
// opens scores near 1.0, and a moved one scores near 0.
const STALE_INDEX_PRESENT_RATIO = 0.2;

function healWorkspaceIfMoved(dir) {
  const state = readState();
  const previous = state.workspacePath || null;
  const moved = !!previous && previous !== dir;

  if (moved) {
    console.log('[Workspace] state was written for a different path; clearing what assumed the old location');
    // The index stores RELATIVE paths, so after a move every one is wrong.
    // Reconciling would index every file AND delete every row: strictly more
    // work than rebuilding, and the index is an explicitly derived artifact.
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(path.join(rundockDir(), 'search-index.db' + suffix), { force: true }); } catch (e) {}
    }
    // Process ids belong to the machine that wrote them. On this one those
    // numbers may well belong to something else entirely.
    try { savePidFile([]); } catch (e) {}
  }

  if (previous !== dir) {
    try { writeState({ ...state, workspacePath: dir }); } catch (e) { /* best effort */ }
  }
  // No fingerprint means state predating this check, so we cannot tell whether
  // it moved. The index itself can answer that once it is open.
  _indexProvenanceUnknown = !previous;
  return { moved, hadFingerprint: !!previous };
}

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
  // Counts are keyed by session id, which is unique per workspace, but a switch
  // is the natural point to release them rather than grow forever.
  _sessionCountMemo.clear();
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
    // Fallback for state written before workspaces were fingerprinted: we have
    // no record of where it came from, so ask the index whether its contents
    // still describe this workspace. A moved or restructured one scores near
    // zero, and rebuilding beats reconciling every row.
    if (_indexProvenanceUnknown) {
      _indexProvenanceUnknown = false;
      let present = null;
      try { present = searchEngine.indexedPathsStillPresent(WORKSPACE); } catch (e) {}
      if (present !== null && present < STALE_INDEX_PRESENT_RATIO) {
        console.log(`[Search] index does not describe this workspace (${Math.round(present * 100)}% of indexed paths present); rebuilding`);
        searchEngine.rebuild();
      }
    }
    const validIds = readConversations().map(c => c.id);
    // Conversations first, inline: byte-offset marks make an unchanged session
    // a stat-only skip, so this stays in the milliseconds even on a long
    // history, and it is what makes recent chat findable straight away.
    const m = searchEngine.reconcileConversations(conversationSessionsForSearch(), { validConversationIds: validIds });
    // Sweep rows for conversations deleted while the engine was closed or
    // unavailable (they would otherwise burn over-fetch slots forever).
    try { searchEngine.removeOrphanedConversations(validIds); } catch (e) {}
    // Files are the heavy half and the only part that scales with workspace
    // size, so they run incrementally rather than blocking the window.
    beginIncrementalFileIndex(m.indexed);
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
    // Never start a blocking full pass while the incremental warm-up is still
    // running: it would duplicate the work the warm-up is already doing, and
    // block the very query it is meant to serve. The warm-up stamps
    // searchFilesReconciledAt when it lands.
    if (!fileIndexInProgress() && now - searchFilesReconciledAt >= SEARCH_FILES_RECONCILE_TTL_MS) {
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
    // `kind` is already computed for the tree icons; carrying it here is what
    // lets a search result show the same icon instead of one generic file glyph.
    else out.push({ path: entry.path, name: entry.name, kind: entry.kind });
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
  const files = flattenFileTree(getFileTreeCached()).slice(0, GREP_MAX_FILES);
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
        .map(f => ({ type: 'file', path: f.path, kind: f.kind, matchType: 'recent', tags: [] }));
    }
    recentFiles = decorateFileHits(recentFiles);
    return { groups: { ...groups, conversations: recentConvos, files: recentFiles }, recent: true };
  }

  // ── Files: fuzzy title layer + FTS content (or bounded grep) ──
  const fileTitleHits = filtersActive ? [] : titleLayerMatches(rawQuery, flatFileListCached(), f => f.name, { fuzzy })
    .slice(0, limit)
    .map(({ item, score }) => ({
      type: 'file', path: item.path, kind: item.kind,
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
  groups.files = decorateFileHits(mergeHits(fileTitleHits, fileContentHits, h => h.path,
    (t, h) => { t.snippet = h.snippet; t.tags = h.tags; }, limit));

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
  // (do NOT index these; a query-time filter is always fresh)
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
  armAgentsDirWatcher();
  armFileTreeWatcher();
  const port = options.port != null ? options.port : PORT;
  return new Promise((resolve) => {
    server.listen(port, () => {
      const actualPort = server.address().port;
      ACTUAL_PORT = actualPort;
      if (WORKSPACE) {
        const boot = phaseTimer();
        // Before cleanOrphanedProcesses, so pid records carried from another
        // machine are dropped rather than signalled.
        healWorkspaceIfMoved(WORKSPACE);
        boot.mark('heal');
        cleanOrphanedProcesses();
        boot.mark('orphans');
        // Scratch from earlier runs. Age-bounded rather than emptied outright,
        // so a second Rundock open on the same workspace cannot delete files
        // the first is still using.
        pruneScratch();
        boot.mark('scratch');
        reportStartup(`workspace preset from environment: ${boot.summary()}`);
      }
      // Release conversations nobody has touched for a while: each holds an
      // agent process and its tool servers, and they used to live for the
      // whole session.
      startIdleReaper();
      console.log(`\n  Rundock running at http://localhost:${actualPort}`);
      if (WORKSPACE && !fs.existsSync(WORKSPACE)) {
        console.log(`  Workspace no longer exists: ${WORKSPACE}`);
        setWorkspaceRoot(null);
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
  setWorkspace(dir) { setWorkspaceRoot(dir); invalidateAgentCache(); armAgentsDirWatcher(); armFileTreeWatcher(); },
  getWorkspace() { return WORKSPACE; },
  // file tree external-change poll
  armFileTreeWatcher, fileTreeForSend, broadcastFileTree,
  flatFileListCached, invalidateFileListCache,
  // scheduler
  getNextRun, executeRoutine, routineState, startScheduler, stopScheduler,
  loadRoutineState, saveRoutineState, recordRoutineRun,
  // agent + skill discovery / parsing
  discoverAgents, invalidateAgentCache, discoverSkills, parseSkillFile,
  parseAgentFrontmatter, extractFrontmatterText, parseCapabilities,
  parseRoutines, parsePrompts, parseSkills, readNormalisedFile, titleCase,
  // markers + text helpers
  stripRundockMarkers, isSilentParkResponse, sanitizeSpecialistOutput,
  buildHandbackPayload, transcriptTurnsSince,
  recordEvent, normalizeDocsGapTopic, bumpSkillUsage,
  boundaryGrantCovers, addBoundaryGrant, readBoundaryGrants,
  extractSnippet, buildToolSummary, isAuthError, isModelError,
  // rosters + prompts
  findDirectReportMatch, findOffRosterWorkspaceMatch, buildTeamRoster, buildPeerRoster,
  extractSelfDescription, buildSystemPrompt,
  // workspace analysis / scaffolding
  detectWorkspaceMode, isEmptyWorkspace, analyzeWorkspace,
  scaffoldDefaults, scaffoldWorkspace, muteHooks, discoverWorkspaces, maybeCompleteSetup,
  readMcpServerNames, getFileTree, fileKind, validateAgentSlug, isInsideWorkspace, isSafeCreatePath,
  // persistence
  readConversations, writeConversations, readState, writeState,
  readLists, writeLists, deleteListEverywhere,
  loadTranscript, saveTranscript, appendTranscript, formatTranscript,
  transcriptDir, countSessionMessagesSync, countConversationMessages,
  parseSessionHistory, getSessionJsonlPath,
  // spawn plumbing
  wireProcessHandlers, handleDelegation, handleScopeReturn,
  handleChatSpawnError, resolveClaudeBin, spawnClaude, killProcessTree,
  getBareArgs, getSpawnEnv, getDisallowedTools, getPermissionMode,
  getAllowedToolsInteractive, getAllowedToolsLegacy, modelArgs,
  killAllChildren, cleanOrphanedProcesses, loadPidFile, savePidFile, pidRecordAlive, processCommand,
  // live state maps
  chatProcesses, convoTranscripts, pendingPermissionRequests,
  agentAutoResumeCount, disconnectBuffer, connectedClients,
  convoTransitions,
  // WS dispatch seam (identity: tests pin the frozen context shape)
  wsHandlerContext, wsDispatch,
  incrementAutoResume, resetAutoResume,
  // universal search
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
