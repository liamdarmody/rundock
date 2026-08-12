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

// Default model for any agent that does not declare one in its frontmatter, and
// for the synthesised orchestrator and Doc. Sonnet is the balanced choice and is
// available on every paid plan; complex agents opt up to a stronger model via `model: opus`
// in their frontmatter, quick agents opt down to `model: haiku`. Always passing
// an explicit --model (see modelArgs + spawnClaude) keeps model selection
// predictable instead of inheriting whatever Claude Code resolves from the user's
// environment (e.g. a Pro subscription resolving the invalid model name "pro").
// The value itself lives in lib/config.js so lib/agents/discovery.js resolves
// the same default without reaching back into the root.
const { DEFAULT_MODEL } = config;
function modelArgs(agent) {
  return ['--model', (agent && agent.model) || DEFAULT_MODEL];
}

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
  const env = { ...process.env, TERM: 'dumb', RUNDOCK: '1', RUNDOCK_PORT: String(ACTUAL_PORT), RUNDOCK_WORKSPACE: WORKSPACE || '' };
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
  startScheduler, getNextRun, executeRoutine,
} = schedulerLib;
// Hand lib/agents its root-owned dependencies (see the module headers).
// (routineState needs no wiring: discovery requires lib/scheduler.js
// directly and reads the module-owned state at use time.)
agentsPrompt.wirePromptDeps({ discoverSkills, detectCodexCached });
workspaceAnalysis.wireAnalysisDeps({ parseSkillFile });
workspaceScaffold.wireScaffoldDeps({ invalidateAgentCache, rebaselineAgentsWatcher });
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
  // Root spawn plumbing until its own extraction slice; the client set is
  // read through an accessor because wss is created later at boot.
  spawnClaude, getBareArgs, modelArgs, getSpawnEnv,
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

/**
 * Shared stdout/stderr handler for all Claude Code processes.
 * Consolidates JSONL parsing, metadata enrichment, session capture,
 * Agent tool interception, response text accumulation, and result handling.
 *
 * @param {object} entry - Process entry (must have: process, buffer, processId, agentId, responseText, exited, pendingAgentTools)
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

        // ── Agent tool interception: collection ──
        // Blocks are only COLLECTED as they stream. The interception decision
        // waits for the end-of-message `assistant` envelope, because a turn
        // can emit several Agent calls: acting (and SIGKILLing) on the first
        // block's stop meant blocks 2..N were never even parsed, so the
        // engine silently discarded them with no log and no event. Deferring
        // to message end sees the whole turn. The cost is a few milliseconds
        // in which the runtime may begin its own generic subagent for the
        // call; killProcessTree takes that subagent down with its parent
        // before it can act, so nothing observable escapes.
        if (enableInterception) {
          const evt = parsed.type === 'stream_event' ? parsed.event : null;
          if (evt) {
            if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use' && evt.content_block?.name === 'Agent') {
              if (!entry.pendingAgentTools) entry.pendingAgentTools = [];
              entry.pendingAgentTools.push({ blockIndex: evt.index, inputJson: '', complete: false });
            }
            if (entry.pendingAgentTools && evt.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta') {
              const block = entry.pendingAgentTools.find(b => b.blockIndex === evt.index && !b.complete);
              if (block) block.inputJson += evt.delta.partial_json;
            }
            if (entry.pendingAgentTools && evt.type === 'content_block_stop') {
              const block = entry.pendingAgentTools.find(b => b.blockIndex === evt.index && !b.complete);
              if (block) block.complete = true;
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
          // Signal layer: Skill invocations get their own tracker (separate
          // from _pendingToolArg so the two can never interfere) because the
          // slug feeds the turn event and the usage sidecar. Claude runtime
          // only by nature: Codex agents receive skills in their instruction
          // body, so there is no tool call to observe there.
          if (toolName === 'Skill') {
            entry._pendingSkillArg = { blockIndex: parsed.event.index, inputJson: '' };
          }
        }
        if (entry._pendingSkillArg && parsed.type === 'stream_event' && parsed.event?.type === 'content_block_delta' && parsed.event?.index === entry._pendingSkillArg.blockIndex && parsed.event?.delta?.type === 'input_json_delta') {
          entry._pendingSkillArg.inputJson += parsed.event.delta.partial_json;
        }
        if (entry._pendingSkillArg && parsed.type === 'stream_event' && parsed.event?.type === 'content_block_stop' && parsed.event?.index === entry._pendingSkillArg.blockIndex) {
          try {
            const input = JSON.parse(entry._pendingSkillArg.inputJson);
            const slug = input.skill || input.name || null;
            if (slug) {
              const lastSkillCall = [...entry.toolCalls].reverse().find(t => t.tool === 'Skill' && !t.arg);
              if (lastSkillCall) lastSkillCall.arg = slug;
              bumpSkillUsage(slug);
            }
          } catch (e) { /* partial input: no slug, no count */ }
          entry._pendingSkillArg = null;
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
            // A backgrounded command outlives the turn that started it, and it
            // is the one kind of work that never appears in this stream again.
            // Remember it so the idle reaper leaves this conversation alone:
            // the turn ends, the entry looks idle, and killing it would take
            // the job with it while the user waits for exactly that result.
            if (input.run_in_background === true) entry.startedBackgroundTask = true;
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

        // ── Agent tool interception: decision ──
        // Runs at end of message with every Agent block of the turn
        // collected (see the collection block above), and AFTER text
        // accumulation so the transcript entry written below carries the
        // turn's full prose.
        //
        // The trigger is the message_stop stream event, with the result
        // envelope as a belt-and-braces fallback for any stream shape that
        // ends a turn without one. It is NEVER the consolidated `assistant`
        // envelope: the real interactive stream emits that envelope PER
        // BLOCK, mid-message, BEFORE the block's content_block_stop
        // (captured from a live CLI stream, v2.1.226, 2026-08-12). The
        // 0.11.6 regression anchored the decision there: on real streams it
        // fired while the Agent block was still incomplete, skipped it,
        // cleared the collection, and every real delegation fell through to
        // the runtime's native subagent, which then did teammate-shaped
        // work invisibly while the caller narrated an invented success. The
        // stub-shaped suite stayed green throughout because the stub only
        // emitted the envelope at end of message. The stub now emits the
        // real end-of-message events (message_delta + message_stop) and a
        // realStream rule mode pins the exact production shape.
        const messageEnded = (parsed.type === 'stream_event' && parsed.event?.type === 'message_stop')
          || parsed.type === 'result';
        if (enableInterception && messageEnded && entry.pendingAgentTools && entry.pendingAgentTools.length) {
          const agentCalls = [];
          for (const block of entry.pendingAgentTools) {
            if (!block.complete) continue; // never closed: stream ended mid-block
            try {
              agentCalls.push(JSON.parse(block.inputJson));
            } catch (e) {
              console.log(`[AgentIntercept] convo=${convoId} failed to parse Agent tool input: ${e.message}`);
              recordEvent('marker_error', { conv: convoId, agent: entry.agentId, d: { kind: 'agent_tool_input' } });
            }
          }
          entry.pendingAgentTools = null;

          // First call naming a direct report wins; delegation is sequential.
          // The REMAINING calls are recorded and named back to the caller on
          // handback so it can sequence them: an honest queue, never a
          // silent drop. Actual concurrent execution is a separate card.
          let target = null, targetInput = null;
          const deferredTargets = [];
          for (const input of agentCalls) {
            const match = findDirectReportMatch(entry.agentId, input);
            if (!target && match) {
              target = match; targetInput = input;
              continue;
            }
            // Every other call in the turn dies with the kill below, whether
            // it names a direct report or a built-in subagent type, so every
            // one of them is named back.
            deferredTargets.push(match ? match.name : (input.subagent_type || 'an unnamed target'));
          }

          if (target) {
            console.log(`[AgentIntercept] convo=${convoId} agent=${entry.agentId} intercepting Agent tool call targeting: ${target.name}${deferredTargets.length ? ` (deferring: ${deferredTargets.join(', ')})` : ''}`);
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
              appendTranscript(convoId, 'agent', entry.agentId, textWithTools, undefined, entry);
            } else {
              const toolSummary = buildToolSummary(entry.toolCalls);
              appendTranscript(convoId, 'agent', entry.agentId, toolSummary, 'routing', entry);
            }
            try { killProcessTree(entry.process, 'SIGKILL'); } catch (e) {}
            entry.exited = true;
            // Order matters: handleDelegation sends agent_switch synchronously,
            // which the client uses to promote the orchestrator's streaming
            // bubble (state.currentStreamingMsg) into a permanent message.
            // If 'done' fires first, finishProcessing nulls currentStreamingMsg
            // and the handoff text is orphaned. Send 'done' AFTER handleDelegation
            // so agent_switch (and the specialist's process_started, also sent
            // inside handleDelegation) reach the client first. By then
            // activeProcessId points at the specialist, so the orchestrator's
            // 'done' fails the process-id match in finishProcessing: exactly
            // what we want: the orchestrator's working indicator clears via
            // agent_switch, not via 'done'.
            handleDelegation({
              type: 'delegate', conversationId: convoId,
              targetAgent: target.name,
              context: targetInput.prompt || targetInput.description || 'Handle this request.',
              _intercepted: true, _parentSessionId: entry.sessionId, _parentAgentId: entry.agentId,
              _deferredTargets: deferredTargets.length ? deferredTargets : null
            }, chatProcesses);
            safeSend(JSON.stringify({ type: 'system', subtype: 'done', code: 0, _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId }));
            continue; // suppress this end-of-message envelope: agent_switch owns the client handoff
          }

          // Impersonation guard: an explicit subagent_type naming a
          // workspace agent OUTSIDE this caller's direct reports must
          // not fall through, or Claude Code spawns a generic subagent
          // wearing that agent's name (for runtime: codex agents this
          // silently bypasses the user's runtime choice). Soft block:
          // kill the turn and resume the caller with a corrective
          // message so it recovers in-conversation.
          // KNOWN LIMITATION: without a captured sessionId the caller cannot be resumed, so the block does not fire and the call falls through (pre-fix behavior). In practice init always precedes tool_use, so sessionId is present. Narrow.
          const offInput = entry.sessionId ? agentCalls.find(input => findOffRosterWorkspaceMatch(entry.agentId, input)) : null;
          const offRoster = offInput ? findOffRosterWorkspaceMatch(entry.agentId, offInput) : null;
          if (offRoster) {
            console.log(`[AgentIntercept] convo=${convoId} agent=${entry.agentId} blocking off-roster Agent tool target: ${offRoster.name}`);
            recordEvent('delegation_error', { conv: convoId, agent: entry.agentId, d: { reason: 'off_roster_blocked' } });
            if (entry.responseText) {
              const toolSummary = buildToolSummary(entry.toolCalls);
              const textWithTools = toolSummary ? toolSummary + '\n' + entry.responseText : entry.responseText;
              appendTranscript(convoId, 'agent', entry.agentId, textWithTools, undefined, entry);
            } else {
              appendTranscript(convoId, 'agent', entry.agentId, buildToolSummary(entry.toolCalls), 'routing', entry);
            }
            try { killProcessTree(entry.process, 'SIGKILL'); } catch (e) {}
            entry.exited = true;
            const offName = offRoster.displayName || offRoster.name;
            safeSend(JSON.stringify({ type: 'system', subtype: 'info', content: `Blocked a handoff to ${offName}: not one of this agent's direct reports.`, _conversationId: convoId }));
            const blockedEntry = spawnResumedProcess(convoId, entry.agentId, entry.sessionId, chatProcesses, {});
            blockedEntry.idle = false; blockedEntry.idleSince = null;
            safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: blockedEntry.processId, _agent: entry.agentId, autoContinue: true }));
            const runtimeNote = offRoster.runtime === 'codex' ? ` ${offName} runs on a different runtime (Codex), which only their own leader can start.` : '';
            const blockPrompt = `[SYSTEM: delegation-blocked] Your Agent tool call named "${offName}" (${offRoster.name}), a workspace agent who is not one of your direct reports, so it was NOT run. No subagent may act as ${offName}.${runtimeNote} Do not retry the same call. If the task needs ${offName}, tell the user this needs routing through ${offName}'s leader and hand back. Otherwise continue without them.`;
            blockedEntry.process.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: blockPrompt } }) + '\n');
            continue;
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
          entry.pendingAgentTools = null; // turn boundary: stale collected blocks never leak across turns
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
    // Close any kill-window transition (replays buffer into a fresh spawn).
    endConvoTransition(convoId, specialistEntry);
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

  recordEvent('handback', {
    conv: convoId, agent: specialistEntry.agentId, runtime: specialistEntry.runtime || 'claude',
    d: { kind: wasPipelineComplete ? 'complete' : 'return', to: orchestrator.id },
  });
  const orchEntry = {
    process: proc, buffer: '', processId, agentId: orchestrator.id,
    responseText: '', exited: false, resultSent: false,
    lastUserMessage: specialistEntry.lastUserMessage,
    pendingAgentTools: null,
    toolCalls: [], turnStartTime: Date.now()
  };
  attachDelegationRecord(orchEntry, createDelegationRecord({
    scopeReturnSource: wasPipelineComplete ? null : specialistEntry.agentId
  }));
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

  // A chat message buffered during the kill/restore window supersedes the
  // out-of-scope routing prompt: the user has spoken, so the fresh
  // orchestrator parks idle and the replay (endConvoTransition below)
  // drives it instead. Same rule as the three finishDelegateClose gates;
  // without it the replayed message queues BEHIND the routing prompt and
  // dies unread in stdin when that prompt re-delegates (interception
  // SIGKILLs the orchestrator). The pipeline-complete prompt is not gated:
  // it only parks the orchestrator silently, never re-delegates, so the
  // replay queues safely behind it (matching the delegate COMPLETE paths).
  if (!wasPipelineComplete && bufferedFollowUpTakesOver(convoId, orchEntry, 'scope-return routing prompt')) {
    // parked by the gate; the replayed message drives the orchestrator
  } else {
    // Circuit breaker: check consecutive auto-resume count before sending prompt.
    // COMPLETE paths are low-risk (orchestrator goes silent) but still count.
    const resumeCount = incrementAutoResume(convoId);
    if (resumeCount >= MAX_CONSECUTIVE_AGENT_RESUMES) {
      console.log(`[CircuitBreaker] convo=${convoId} ${resumeCount} consecutive agent resumes in handleScopeReturn, pausing orchestrator`);
          recordEvent('circuit_breaker', { conv: convoId, d: { count: resumeCount } });
      resetAutoResume(convoId);
      orchEntry.idle = true; orchEntry.idleSince = Date.now();
      safeSend(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: `[Auto-paused: ${resumeCount} consecutive agent handoffs without user input. Last specialist: ${specialistEntry.agentId}. Please review the output above and send your next message to continue.]` }, _agent: orchestrator.id, _conversationId: convoId }));
    } else {
      // Build context for orchestrator. Both shapes inject the specialist's final output
      // so the orchestrator has visibility into what was delivered. Without this, the
      // orchestrator's JSONL only contains its own pre-delegation state and it has to
      // guess or re-read files to know what the specialist did.
      const specialistOutput = buildHandbackPayload(specialistEntry, convoId);
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
  }

  wireProcessHandlers(orchEntry, convoId, null, {
    enableInterception: true,
    onResult: (e) => {
      // Filter silent-park responses: strip sentinel and suppress near-empty/no-op output
      if (e.responseText && !isSilentParkResponse(e.responseText)) {
        const toolSummary = buildToolSummary(e.toolCalls);
        const textWithTools = toolSummary ? toolSummary + '\n' + e.responseText : e.responseText;
        appendTranscript(convoId, 'agent', e.agentId, textWithTools, undefined, e);
      }
      e.responseText = '';
      e.idle = true; e.idleSince = Date.now();
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

  // The orchestrator is live: close any kill-window transition opened when
  // the specialist's auto-return kill fired, replaying buffered messages.
  endConvoTransition(convoId, specialistEntry);
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
    pendingAgentTools: null, toolCalls: [], turnStartTime: Date.now(),
    idle: true,
    handbackAt: Date.now(), // stale end_delegation guard
  };
  // A respawned agent can hand back via its scope-return close path, so it
  // carries a delegation record like a delegate does.
  attachDelegationRecord(entry, createDelegationRecord({
    scopeReturnSource: opts.scopeReturnSource || null
  }));
  processes.set(convoId, entry);

  wireProcessHandlers(entry, convoId, null, {
    enableInterception: true,
    onResult: (e) => {
      const { hasReturn: hasOutOfScope, hasComplete } = resolveMarkers(e.responseText);
      // KNOWN LIMITATION: a respawned orchestrator that emits its own RETURN/COMPLETE marker here is self-treated as a scope-return. Low/narrow.
      if ((hasOutOfScope || hasComplete) && !e.delegation) {
        e.scopeReturn = true;
        e.scopeReturnMode = hasComplete ? 'complete' : 'return';
        scheduleScopeReturnKill(e, convoId); // follow-up in-window cancels; post-kill messages buffer
      }
      if (e.responseText && !isSilentParkResponse(e.responseText)) {
        const toolSummary = buildToolSummary(e.toolCalls);
        const textWithTools = toolSummary ? toolSummary + '\n' + e.responseText : e.responseText;
        appendTranscript(convoId, 'agent', e.agentId, textWithTools, undefined, e);
        if (e.deliveredTurns) e.deliveredTurns.push(e.responseText);
      }
      e.finalResponseText = e.responseText;
      e.responseText = '';
      e.idle = true; e.idleSince = Date.now();
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
    if (cur === entry) {
      processes.delete(convoId);
      endConvoTransition(convoId, entry); // replay buffered messages into a fresh spawn
    }
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
    recordEvent('delegation_error', { conv: convoId, agent: existing.agentId, d: { reason: 'loop_guard' } });
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
  if (!isIntercepted) existing.idle = true; existing.idleSince = Date.now();

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
  recordEvent('delegation_start', { conv: convoId, agent: originalAgentId, runtime: targetAgent.runtime, d: { from: originalAgentId, to: targetAgent.id, intercepted: isIntercepted } });

  // Normalised for the codex path: thread resolution and prompt must agree
  // on whether this is a resume (see startCodexTurn for the identity-loss
  // hazard). Codex delegates have NO per-turn child process: their turn runs
  // on the shared app-server, so delegateProc stays null for them.
  const codexResumeId = isCodexDelegate && codexRuntime.isValidThreadId(priorSessionId) ? priorSessionId : null;
  const delegateProc = isCodexDelegate
    ? null
    : spawnClaude(delegateArgs, {
        cwd: WORKSPACE,
        env: getSpawnEnv(convoId),
        stdio: ['pipe', 'pipe', 'pipe']
      }, (err) => handleChatSpawnError(err, convoId));

  const delegateEntry = {
    process: delegateProc || undefined, runtime: targetAgent.runtime, buffer: '', processId: delegateProcessId,
    agentId: targetAgent.id, responseText: '', exited: false, resultSent: false, idle: false,
    isPlatformDelegate, lastUserMessage: msg.context, receivedFollowUp: false,
    isIntercepted,
    pendingAgentTools: null,
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
  // The delegation record owns the durable state: the accumulated turn log
  // for the handback, the timestamp bounding the transcript fallback, and
  // the Agent calls from the delegating turn that were not run (named back
  // to the caller so it can sequence them instead of believing they ran).
  attachDelegationRecord(delegateEntry, createDelegationRecord({
    deferredTargets: msg._deferredTargets || null
  }));
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
    // Codex takes the whole prompt in one turn: identity + platform rules +
    // delegation contract on a fresh thread (Codex has no --agent or
    // --append-system-prompt equivalent); contract + brief on a resumed
    // thread (instructions are already in the thread).
    // The fresh variant travels too: if the stored thread turns out to be
    // expired, wireCodexDelegate falls back to a fresh thread and must use
    // the full prompt.
    const codexFreshPrompt = [readAgentInstructions(targetAgent), fullPrompt, contextWithHistory].filter(Boolean).join('\n\n');
    const codexPrompt = codexResumeId
      ? `${delegationContext}\n\n${contextWithHistory}`
      : codexFreshPrompt;
    // With no per-turn process there is no 'close' event: the turn's done
    // event fires this hook instead, running the SAME restoration handler
    // Claude delegates attach to process close (defined below).
    delegateEntry.onTurnDone = (code) => handleDelegateClose(code);
    wireCodexDelegate(delegateEntry, convoId, codexPrompt, {
      resumeThreadId: codexResumeId,
      model: targetAgent.model || undefined,
      freshPrompt: codexFreshPrompt,
    });
  } else {
  delegateProc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: contextWithHistory } }) + '\n');

  wireProcessHandlers(delegateEntry, convoId, null, {
    enableInterception: true,
    onResult: (e) => {
      const { hasReturn: hasOutOfScope, hasComplete, hasCrudMarker } = resolveMarkers(e.responseText);
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
        // A user follow-up in this window cancels the auto-return; once the
        // kill fires, later messages buffer instead of hitting dying stdin.
        scheduleScopeReturnKill(e, convoId);
      }

      e.finalResponseText = e.responseText;
      if (e.responseText) {
            const toolSummary = buildToolSummary(e.toolCalls);
            const textWithTools = toolSummary ? toolSummary + '\n' + e.responseText : e.responseText;
            appendTranscript(convoId, 'agent', e.agentId, textWithTools, undefined, e);
            // Accumulate before the reset: the reset is correct for per-turn
            // streaming, but the handback must carry every turn.
            e.deliveredTurns.push(e.responseText);
          }
      e.responseText = '';
      e.idle = true; e.idleSince = Date.now();
    }
  });
  }

  // Shared close path for BOTH runtimes: Claude delegates attach it to the
  // child process's 'close'; Codex delegates fire it from their turn's done
  // event (entry.onTurnDone above). It owns agent_switch/done and parent
  // restoration.
  const handleDelegateClose = (code) => {
    if (delegateEntry.spawnFailed) return; // error handler already surfaced
    delegateEntry.exited = true;
    const current = processes.get(convoId);
    if (current !== delegateEntry) return;

    // The delegate is gone but its replacement (restored parent, respawned
    // orchestrator) is not ready yet: enter the restoring state so a chat
    // message arriving now is buffered rather than racing the restoration.
    // When an auto-return kill opened the window this moves killing ->
    // restoring on the same queue. endConvoTransition replays any buffered
    // messages against the restored process once restoration completes.
    beginConvoTransition(convoId, 'restoring', delegateEntry);
    const runRestore = () => {
      try { finishDelegateClose(code); }
      finally { endConvoTransition(convoId, delegateEntry); }
    };
    // RUNDOCK_TEST_RESTORE_DELAY_MS (test-only seam, default 0) widens this
    // window so the race is deterministically testable; in production the
    // restoration runs synchronously on the close event, exactly as before.
    if (RESTORE_DELAY_MS > 0) setTimeout(runRestore, RESTORE_DELAY_MS);
    else runRestore();
  };

  // Restoration body (behaviour unchanged apart from the buffered-follow-up
  // gates); separated from handleDelegateClose so the restoring window above
  // can wrap, and under test delay, it.
  const finishDelegateClose = (code) => {
    // A chat message buffered during the kill/restore window supersedes the
    // handoff's auto-continue: the user has spoken, so their replayed message
    // drives the restored parent instead of a routing prompt. Mirrors the
    // live-window rule where a follow-up cancels the auto-return.
    // Multi-target honesty: Agent calls from the delegating turn that were
    // not run are named back to the caller. The engine used to discard them
    // with no log and no event, so callers believed parallel work happened.
    // Worded to inform, not to command: two of the receiving prompts require
    // the parent to output <silent>, so the note must survive being read
    // without being acted on until the parent's next active turn.
    const deferred = delegateEntry.deferredTargets || [];
    const deferredNote = deferred.length
      ? `\n\nNOTE: the turn that delegated to ${delegateEntry.agentId} also invoked the Agent tool for: ${deferred.join(', ')}. Delegation is sequential, so ${deferred.length === 1 ? 'that call was' : 'those calls were'} NOT run. If that work is still needed, sequence it one target at a time on your next active turn.`
      : '';

    // If cancelled by user, skip all parent restoration logic
    if (delegateEntry.cancelled) {
      console.log(`[Delegate] convo=${convoId} delegate was cancelled, skipping parent restoration`);
      processes.delete(convoId);
      return;
    }

    // Signal layer: every delegate handback converges here for both runtimes
    // (Claude via process close, Codex via onTurnDone). kind 'none' is a
    // markerless exit; the tail scan mirrors the intercepted branch below
    // without changing its behavior.
    recordEvent('handback', {
      conv: convoId, agent: delegateEntry.agentId, runtime: delegateEntry.runtime || 'claude',
      d: {
        kind: delegateEntry.returnMarkerSeen
          || resolveMarkers(delegateEntry.finalResponseText || delegateEntry.responseText).mode
          || 'none',
        to: delegateEntry.delegation.originalAgentId,
      },
    });

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
        // Tail scan for a marker the onResult handler never saw (e.g. the
        // process died after streaming it). Same single resolver, same
        // COMPLETE-beats-RETURN precedence.
        returnMarkerSeen = resolveMarkers(delegateEntry.finalResponseText || delegateEntry.responseText).mode;
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

        orchestratorEntry.idle = true; orchestratorEntry.idleSince = Date.now();
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
        } else if (bufferedFollowUpTakesOver(convoId, orchestratorEntry, 'RETURN auto-continue')) {
          // orchestrator stays idle; the replayed message drives it
        } else if (orchestratorEntry.process && orchestratorEntry.process.stdin && orchestratorEntry.process.stdin.writable && !orchestratorEntry.process.killed) {
          // RETURN path: auto-continue to route the pending request to another specialist
          const resumeCount = incrementAutoResume(convoId);
          if (resumeCount >= MAX_CONSECUTIVE_AGENT_RESUMES) {
            console.log(`[CircuitBreaker] convo=${convoId} ${resumeCount} consecutive agent resumes, pausing orchestrator`);
          recordEvent('circuit_breaker', { conv: convoId, d: { count: resumeCount } });
            resetAutoResume(convoId);
            safeSend(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: `[Auto-paused: ${resumeCount} consecutive agent handoffs without user input. Agents involved: ${delegateEntry.agentId} → ${orchestratorAgentId}. Please review the output above and send your next message to continue.]` }, _agent: orchestratorAgentId, _conversationId: convoId }));
          } else {
            const pendingRequest = delegateEntry.lastUserMessage || '';
            setTimeout(() => {
              if (!orchestratorEntry.exited) {
                console.log(`[AgentIntercept] convo=${convoId} auto-continuing orchestrator after skip-level ${returnMarkerSeen} (resume ${resumeCount}/${MAX_CONSECUTIVE_AGENT_RESUMES})`);
                orchestratorEntry.responseText = '';
                orchestratorEntry.idle = false; orchestratorEntry.idleSince = null;
                safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: orchestratorEntry.processId, _agent: orchestratorAgentId, autoContinue: true }));
                const prompt = pendingRequest
                  ? `[SYSTEM: A specialist just returned because the user asked for something outside their scope. The user's pending request is: "${pendingRequest}"\n\nRoute this request now. Delegate to the right specialist if one fits, or handle it yourself. Do not summarise what the previous specialist did. Do not ask the user to repeat themselves. Respond to their request.${deferredNote}]`
                  : `[SYSTEM: A specialist just returned. Ask the user what they need next.${deferredNote}]`;
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
        pendingAgentTools: null,
        toolCalls: [], turnStartTime: Date.now(),
        handbackAt: Date.now() // stale end_delegation guard
      };
      // A restored parent can hand back onward via its scope-return close
      // path, so it carries a record. scopeReturnSource tags the returning
      // specialist so handleDelegation's guard blocks immediate re-delegation
      // to the same agent; only set for out-of-scope returns, because
      // pipeline-complete should allow re-delegation.
      attachDelegationRecord(resumeEntry, createDelegationRecord({
        scopeReturnSource: isOutOfScope ? delegateEntry.agentId : null
      }));
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
      const delegateOutput = buildHandbackPayload(delegateEntry, convoId);
      const delegateOutputBlock = delegateOutput
        ? `\n\n--- ${delegateEntry.agentId} ---\n${delegateOutput}\n---`
        : '';

      if (isOutOfScope && bufferedFollowUpTakesOver(convoId, resumeEntry, 'RETURN routing prompt')) {
        // parked by the gate; the replayed message drives the resumed parent
      } else if (isOutOfScope) {
        const resumeCount = incrementAutoResume(convoId);
        if (resumeCount >= MAX_CONSECUTIVE_AGENT_RESUMES) {
          console.log(`[CircuitBreaker] convo=${convoId} ${resumeCount} consecutive agent resumes on parked-parent RETURN path, pausing`);
          recordEvent('circuit_breaker', { conv: convoId, d: { count: resumeCount } });
          resetAutoResume(convoId);
          resumeEntry.idle = true; resumeEntry.idleSince = Date.now();
          safeSend(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: `[Auto-paused: ${resumeCount} consecutive agent handoffs without user input. Last specialist: ${delegateEntry.agentId}. Please review the output above and send your next message to continue.]` }, _agent: delegateEntry.delegation.originalAgentId, _conversationId: convoId }));
        } else {
          safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: resumeProcessId, _agent: parentAgentId, autoContinue: true }));

          const resumePrompt = `[SYSTEM: ${delegateEntry.agentId} returned because the request was outside their scope. Here is what they said:${delegateOutputBlock}\n\nThe user's latest request was: "${delegateEntry.lastUserMessage || 'continue'}". Respond with full awareness of what ${delegateEntry.agentId} delivered. Do not re-delegate work already done. Route to the right specialist using the Agent tool.${deferredNote}]`;
          resumeProc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: resumePrompt } }) + '\n');
        }
      } else if (isPipelineComplete) {
        // Park silently but inject specialist output so the next user message
        // resumes with real context about what was delivered.
        safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: resumeProcessId, _agent: parentAgentId, autoContinue: true, silent: true }));
        const completePrompt = `[SYSTEM: pipeline-complete] ${delegateEntry.agentId} has finished the delegated work. Here is their final message to the conversation:${delegateOutputBlock}${deferredNote}\n\nYour output for this turn MUST be exactly the literal string <silent> and nothing else. Do not narrate, summarise, or quote the specialist's output. Do not invoke any tools. Do not emit any other text. Just output <silent> and stop.`;
        resumeProc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: completePrompt } }) + '\n');
        resumeEntry.idle = true; resumeEntry.idleSince = Date.now();
        console.log(`[AgentIntercept] convo=${convoId} delegate emitted COMPLETE, parent ${parentAgentId} parked with specialist output`);
      } else {
        // Normal exit (no marker). Inject specialist output for context, then park.
        safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: resumeProcessId, _agent: parentAgentId, autoContinue: true, silent: true }));
        const normalPrompt = `[SYSTEM: pipeline-complete] ${delegateEntry.agentId} completed their work. Here is their final message to the conversation:${delegateOutputBlock}${deferredNote}\n\nYour output for this turn MUST be exactly the literal string <silent> and nothing else. Do not narrate, summarise, or quote the specialist's output. Do not invoke any tools. Do not emit any other text. Just output <silent> and stop.`;
        resumeProc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: normalPrompt } }) + '\n');
        resumeEntry.idle = true; resumeEntry.idleSince = Date.now();
        console.log(`[AgentIntercept] convo=${convoId} delegate completed normally, parent ${parentAgentId} parked with specialist output`);
      }

      wireProcessHandlers(resumeEntry, convoId, null, {
        enableInterception: true,
        onResult: (e) => {
          // Detect both handoff markers on a parked-and-resumed parent. scopeReturnMode
          // records which one fired so the close handler can route correctly: 'return'
          // means route the pending request to a different specialist, 'complete' means
          // the delegated pipeline is finished and the orchestrator should resume silently.
          const markers = resolveMarkers(e.responseText);
          if (markers.mode && !e.delegation) {
            e.scopeReturn = true;
            // mode already applies COMPLETE-beats-RETURN precedence
            e.scopeReturnMode = markers.mode;
            console.log(`[ScopeReturn] convo=${convoId} agent=${e.agentId} ${e.scopeReturnMode} marker on resumed parent`);
            // Follow-up in-window cancels the auto-return; post-kill messages buffer.
            scheduleScopeReturnKill(e, convoId);
          }
          // Filter silent-park responses: strip sentinel and suppress near-empty/no-op output
          if (e.responseText && !isSilentParkResponse(e.responseText)) {
            const toolSummary = buildToolSummary(e.toolCalls);
            const textWithTools = toolSummary ? toolSummary + '\n' + e.responseText : e.responseText;
            appendTranscript(convoId, 'agent', e.agentId, textWithTools, undefined, e);
            if (e.deliveredTurns) e.deliveredTurns.push(e.responseText);
          }
          // Mirror the delegate (~2673) and direct-start (~3134) paths:
          // preserve the final text so a later handleScopeReturn injects the real
          // specialist output into the orchestrator prompt, not an empty block.
          e.finalResponseText = e.responseText;
          e.responseText = '';
          e.idle = true; e.idleSince = Date.now();
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

        if (cur === resumeEntry) {
          processes.delete(convoId);
          endConvoTransition(convoId, resumeEntry); // replay buffered messages into a fresh spawn
        }
        safeSend(JSON.stringify({ type: 'system', subtype: 'done', code: rCode, _agent: resumeEntry.agentId, _conversationId: convoId, _processId: resumeProcessId }));
      });

    } else if (orig && !orig.exited) {
      orig.idle = true; orig.idleSince = Date.now();
      orig.delegation = null;
      orig.handbackAt = Date.now(); // stale end_delegation guard
      processes.set(convoId, orig);
      console.log(`[Delegate] convo=${convoId} delegate exited, restored ${delegateEntry.delegation.originalAgentId}`);
      safeSend(JSON.stringify({
        type: 'system', subtype: 'agent_switch', _conversationId: convoId,
        fromAgent: delegateEntry.agentId, toAgent: delegateEntry.delegation.originalAgentId
      }));

      // bufferedFollowUp gate: a message buffered during the window replays
      // to the restored parent directly, superseding the auto-continue.
      if (!delegateEntry.isPlatformDelegate && delegateEntry.receivedFollowUp && !bufferedFollowUpTakesOver(convoId, orig, 'specialist-return auto-continue') && orig.process && orig.process.stdin && orig.process.stdin.writable) {
        const resumeCount = incrementAutoResume(convoId);
        if (resumeCount >= MAX_CONSECUTIVE_AGENT_RESUMES) {
          console.log(`[CircuitBreaker] convo=${convoId} ${resumeCount} consecutive agent resumes on delegate return path, pausing`);
          recordEvent('circuit_breaker', { conv: convoId, d: { count: resumeCount } });
          resetAutoResume(convoId);
          orig.idle = true; orig.idleSince = Date.now();
          safeSend(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: `[Auto-paused: ${resumeCount} consecutive agent handoffs without user input. Last specialist: ${delegateEntry.agentId}. Please review the output above and send your next message to continue.]` }, _agent: orig.agentId, _conversationId: convoId }));
        } else {
          const pendingRequest = delegateEntry.lastUserMessage || '';
          setTimeout(() => {
            if (!orig.exited) {
              console.log(`[Delegate] convo=${convoId} auto-continuing orchestrator after specialist return (resume ${resumeCount}/${MAX_CONSECUTIVE_AGENT_RESUMES})`);
              orig.responseText = '';
              orig.idle = false; orig.idleSince = null;
              safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: orig.processId, _agent: orig.agentId, autoContinue: true }));
              const prompt = pendingRequest
                ? `[SYSTEM: The specialist just returned because the user asked for something outside their scope. The user's pending request is: "${pendingRequest}"\n\nRoute this request now. Delegate to the right specialist if one fits, or handle it yourself. Do not summarise what the previous specialist did. Do not ask the user to repeat themselves. Respond to their request.${deferredNote}]`
                : `[SYSTEM: The specialist just returned. The user indicated they were done with that specialist. Ask the user what they need next.${deferredNote}]`;
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
  };
  if (delegateProc) delegateProc.on('close', handleDelegateClose);
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

      // Permission response: user approved/denied a tool in the browser UI.
      // Resolves the pending HTTP long-poll from the PreToolUse hook script.
      if (msg.type === 'permission_response') {
        const pending = pendingPermissionRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingPermissionRequests.delete(msg.requestId);
          // "Always allow this folder": the user chose a standing grant along
          // with the approval. Folder-level, this workspace only.
          if (msg.allow === true && msg.grantDir) addBoundaryGrant(msg.grantDir);
          if (pending.res) {
            // Hook-originated request: answer the held HTTP response.
            pending.res.writeHead(200, { 'Content-Type': 'application/json' });
            pending.res.end(JSON.stringify({ allow: msg.allow }));
          } else if (pending.onDecision) {
            // Server-originated request (e.g. Codex write markers): callback.
            try { pending.onDecision(msg.allow === true, 'user'); } catch (e) { console.error('[Permission] onDecision threw:', e); }
          }
          console.log(`[Permission] convo=${msg.conversationId} requestId=${msg.requestId} decision=${msg.allow ? 'allow' : 'deny'}`);
          recordEvent('permission', { conv: msg.conversationId, d: { tool: pending.toolName, decision: msg.allow ? 'allow' : 'deny' } });
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

          // Stop the active work. Runtime-aware: Codex entries interrupt
          // their turn on the SHARED app-server (never kill it on a
          // conversation cancel); Claude entries kill their child process.
          if (entry.interrupt) {
            entry.interrupt();
          } else {
            try { killProcessTree(entry.process, 'SIGTERM'); } catch (e) {}
            // Safety net: SIGKILL after 2 seconds
            setTimeout(() => {
              try { killProcessTree(entry.process, 'SIGKILL'); } catch (e) {}
            }, 2000);
          }

          // If this is a delegate, also kill every parked ANCESTOR. Walk the
          // full parent chain rather than only orchestratorEntry, which is null
          // for non-intercepted nested WS-delegate chains and would otherwise
          // leak the grandparent orchestrator as a live process.
          if (entry.delegation) {
            const killParked = (e) => {
              if (!e || e.exited) return;
              e.exited = true;
              e.cancelled = true;
              if (e.interrupt) {
                e.interrupt();
              } else if (e.process) {
                try { killProcessTree(e.process, 'SIGTERM'); } catch (err) {}
                setTimeout(() => { try { killProcessTree(e.process, 'SIGKILL'); } catch (err) {} }, 2000);
              }
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
          setWorkspaceRoot(null);
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

      // Reported by the client once it has finished rendering a freshly opened
      // workspace. A summary showing every server phase fast and the client slow
      // redirects an investigation in one line.
      if (msg.type === 'client_render_time') {
        const ms = Number(msg.ms);
        if (Number.isFinite(ms) && ms >= 0) reportStartup(`client render ${Math.round(ms)}ms`);
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
          const startup = phaseTimer();
          killAllChildren();
          setWorkspaceRoot(dir);
          armAgentsDirWatcher();
          // Before anything reads state that may have come from another path.
          healWorkspaceIfMoved(dir);
          // A workspace switch (including re-selecting the same one) is the
          // retry trigger for a failed search-engine open, and must not
          // serve the previous workspace's cached file/skill lists.
          searchEngineFailedWorkspace = null;
          invalidateAgentCache();
          loadRoutineState();
          saveRecentWorkspace(dir);
          // Clean up orphaned processes from previous sessions in this workspace
          cleanOrphanedProcesses();
          startup.mark('prepare');

          // Detect empty workspace before scaffolding (scaffoldWorkspace adds Doc/skills)
          let agentList = [];
          try { agentList = discoverAgents(); } catch (e) { console.warn('  Agent discovery failed:', e.message); }
          startup.mark('agents');
          const isEmpty = isEmptyWorkspace(dir, agentList);

          // Empty workspace: scaffold default folders and CLAUDE.md
          let scaffoldError = null;
          if (isEmpty) {
            const result = scaffoldDefaults(dir);
            if (!result.success) scaffoldError = result.error;
            invalidateAgentCache();
          }

          try { scaffoldWorkspace(dir); } catch (e) { console.warn('Scaffold warning:', e.message); }
          startup.mark('scaffold');
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
          startup.mark('analyze');
          ws.send(JSON.stringify({ type: 'workspace_set', path: WORKSPACE, analysis, isEmpty, workspaceMode: state.workspaceMode, setupComplete: !!state.setupComplete, scaffoldError }));
          ws.send(JSON.stringify({ type: 'agents', agents: agentList }));
          try { ws.send(JSON.stringify({ type: 'file_tree', tree: getFileTreeCached() })); } catch (e) { console.warn('  File tree failed:', e.message); }
          startup.mark('tree');
          reportStartup(`workspace open: ${startup.summary()}`);
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
            setWorkspaceRoot(dir);
            armAgentsDirWatcher();
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
            ws.send(JSON.stringify({ type: 'file_tree', tree: getFileTreeCached() }));
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
        try { ws.send(JSON.stringify({ type: 'file_tree', tree: getFileTreeCached() })); } catch (e) { console.warn('  File tree failed:', e.message); }
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
        //      is the canonical source: Rundock's own transcript only covers
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
          listIds: Array.isArray(msg.conversation.listIds) ? msg.conversation.listIds.filter(x => typeof x === 'string') : [],
          createdAt: msg.conversation.createdAt || new Date().toISOString(),
          lastActiveAt: new Date().toISOString()
        };
        if (idx >= 0) { convos[idx] = entry; } else { convos.unshift(entry); }
        // Cap at 100 conversations
        writeConversations(convos.slice(0, 100));
      }

      // ── CONVERSATION LISTS: named many-to-many sidebar groupings ──
      if (msg.type === 'get_lists') {
        if (!WORKSPACE) return;
        ws.send(JSON.stringify({ type: 'lists', lists: readLists() }));
      }

      if (msg.type === 'create_list') {
        if (!WORKSPACE) return;
        const name = typeof msg.name === 'string' ? msg.name.trim().slice(0, 60) : '';
        if (!name) return;
        const lists = readLists();
        // Same name twice is a no-op rather than a duplicate pill.
        if (!lists.some(l => l.name.toLowerCase() === name.toLowerCase())) {
          lists.push({ id: 'list-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, createdAt: new Date().toISOString() });
          writeLists(lists);
        }
        ws.send(JSON.stringify({ type: 'lists', lists }));
      }

      if (msg.type === 'delete_list') {
        if (!WORKSPACE || typeof msg.id !== 'string') return;
        deleteListEverywhere(msg.id);
        ws.send(JSON.stringify({ type: 'lists', lists: readLists() }));
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
          // This kill is immediate and uncancellable, so open the killing
          // window first: a follow-up landing in the kill-to-close gap is
          // buffered (see convoTransitions) instead of clearing the committed
          // handback and vanishing into the dying delegate's stdin.
          beginConvoTransition(convoId, 'killing', current);
          stopEntryProcess(current);
          // The close path (process close for Claude, turn done for Codex)
          // will restore the original process
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
            // Immediate uncancellable kill: open the killing window so a
            // follow-up in the kill-to-close gap buffers instead of clearing
            // scopeReturn and dying with the process (see convoTransitions).
            beginConvoTransition(convoId, 'killing', current);
            stopEntryProcess(current);
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
          // Watch the now-open file so a change made outside Rundock (Obsidian,
          // an agent, another tool) pushes a live refresh to this client.
          watchOpenFile(ws, msg.path, fullPath);
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
          // Invalidate before rediscovering: the roster cache was populated
          // at the top of this handler, so without this the agents message
          // would answer with the recruit still order-less and the client
          // would not show the join until a later refresh.
          invalidateAgentCache();
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
            if (!existed) maybeCompleteSetup(updatedAgents);
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
        // Conversation-only search. No in-repo client sends this today
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
          // First pass: title matches (instant)
          const titleMatches = convos.filter(c => (c.title || '').toLowerCase().includes(query)).map(c => ({ ...c, matchType: 'title' }));
          // Second pass: content matches (FTS index, or the legacy jsonl grep)
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
        // Cmd+K universal palette: one query across files,
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
          invalidateFileListCache(); invalidateFileTreeCache();
          if (ensureSearchEngine()) {
            try { searchEngine.noteFileSaved(WORKSPACE, msg.path); } catch (e) { /* reconcile catches up */ }
          }
          ws.send(JSON.stringify({ type: 'file_saved', path: msg.path }));
        }
      }
      // Create a note, board, or folder from the Files sidebar. Files must not
      // clobber an existing path; folders are idempotent (mkdir -p). A fresh
      // file tree is pushed so the sidebar updates without a manual reload.
      if (msg.type === 'create_path') {
        const rel = String(msg.path || '').replace(/^\/+/, '');
        const full = path.resolve(WORKSPACE, rel);
        if (!rel || !isInsideWorkspace(full) || !isSafeCreatePath(rel)) {
          ws.send(JSON.stringify({ type: 'create_error', path: rel, reason: 'invalid path' }));
        } else if (msg.kind !== 'folder' && fs.existsSync(full)) {
          ws.send(JSON.stringify({ type: 'create_error', path: rel, reason: 'already exists' }));
        } else {
          try {
            if (msg.kind === 'folder') {
              fs.mkdirSync(full, { recursive: true });
            } else {
              fs.mkdirSync(path.dirname(full), { recursive: true });
              fs.writeFileSync(full, msg.content || '', 'utf-8');
              invalidateFileListCache(); invalidateFileTreeCache();
              if (ensureSearchEngine()) { try { searchEngine.noteFileSaved(WORKSPACE, rel); } catch (e) {} }
            }
            ws.send(JSON.stringify({ type: 'file_tree', tree: getFileTreeCached() }));
            ws.send(JSON.stringify({ type: 'path_created', path: rel, kind: msg.kind }));
          } catch (e) {
            ws.send(JSON.stringify({ type: 'create_error', path: rel, reason: String((e && e.message) || e) }));
          }
        }
      }
      // Reveal a workspace path in the OS file manager (macOS only; a no-op
      // elsewhere). Guarded to the workspace and a fixed command.
      if (msg.type === 'reveal_in_finder') {
        const full = path.resolve(WORKSPACE, String(msg.path || ''));
        if (isInsideWorkspace(full) && process.platform === 'darwin') {
          try { require('child_process').spawn('open', ['-R', full], { stdio: 'ignore' }); } catch (e) {}
        }
      }
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

// Pid records carry the command they were spawned as, so a pid the OS has
// since recycled onto an unrelated process is not signalled. The file used to
// hold bare integers with no way to tell the difference; those are still read
// for one upgrade, and simply lack the recycling guard.
function pidOf(rec) { return typeof rec === 'number' ? rec : (rec && rec.pid); }

// Read a process's command line.
//
// Deliberately `args=` and not `comm=`. On Linux `comm` is the THREAD name from
// /proc, not the executable: Node 24 renames its main thread to "MainThread",
// so every record would have been judged foreign and discarded, defeating the
// tracking this guard exists to protect. Node 22 on the same machine reports
// "node". The command line is stable across both, and across macOS, where
// `comm` gives a full path instead.
function processCommand(pid) {
  if (process.platform === 'win32') return null; // no cheap equivalent; skip the check
  try {
    const { execFileSync } = require('child_process');
    return execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (e) { return null; } // not running, or ps unavailable
}

/** Running AND still the process we spawned, rather than a recycled pid. */
function pidRecordAlive(rec) {
  const pid = pidOf(rec);
  if (!pid) return false;
  try { process.kill(pid, 0); } catch (e) { return false; }
  const expected = typeof rec === 'object' && rec ? rec.cmd : null;
  if (!expected) return true; // legacy record, or a platform without the check
  const actual = processCommand(pid);
  if (actual == null) return true; // cannot tell; assume ours rather than leak it
  return commandsMatch(actual, expected);
}

// Does this command line still look like the thing we spawned?
//
// Deliberately loose: the guard only has to tell "the process we started" from
// "something unrelated that inherited this id". Command-line formatting varies
// by platform and by runtime version, and a strict comparison has already
// broken once that way. Being too permissive means a redundant signal to a
// process that is probably ours; being too strict means untracked processes
// leaking forever, which is the failure this whole area exists to prevent.
function commandsMatch(actual, expected) {
  const e = path.basename(String(expected || '').trim());
  const a = String(actual || '').trim();
  if (!e || !a) return true;
  return a.includes(e);
}

function registerChildPid(pid, cmd) {
  const records = loadPidFile();
  if (records.some(r => pidOf(r) === pid)) return;
  records.push({ pid, at: Date.now(), cmd: cmd ? path.basename(cmd) : null });
  savePidFile(records);
}

function unregisterChildPid(pid) {
  savePidFile(loadPidFile().filter(r => pidOf(r) !== pid));
}

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
    // PROBE_STDIO closes stdin: on Windows a version/which probe against an
    // open piped stdin can hang for its full timeout (verified live for
    // codex, Findings 4/5); the claude probes take the same precaution.
    const output = execSync(lookupCmd, { timeout: 5000, encoding: 'utf-8', stdio: codexRuntime.PROBE_STDIO }).trim();
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
// Signal a spawned process AND everything it started.
//
// An agent CLI spawns its own children: an MCP server per configured entry,
// plus tool subprocesses. Those are grandchildren we hold no handle on and
// never record, so signalling one pid leaves them running and reparented,
// holding memory until the machine restarts.
//
// On POSIX the children are spawned detached, which puts each in its own
// process group whose id equals the leader's pid, so a negative pid signals
// the whole group. Windows has no process groups; taskkill /T walks the tree
// instead. Windows also has no real signal semantics (Node maps kill() onto
// TerminateProcess), so the graceful and forceful paths are the same there.
function killProcessTree(target, signal = 'SIGTERM') {
  const pid = typeof target === 'number' ? target : (target && target.pid);
  if (!pid) return;
  // Floor: kill at least the process itself, so no path here can end up doing
  // less than the single-pid kill this replaced.
  const killJustThis = () => {
    try {
      if (typeof target === 'number') process.kill(pid, signal);
      else target.kill(signal);
    } catch (e) { /* already dead */ }
  };

  if (process.platform === 'win32') {
    // Windows has no process groups; taskkill walks the tree instead. It is
    // spawned rather than awaited, so a missing binary arrives as an error
    // EVENT and never reaches a try/catch: without the listener below a
    // failure would kill nothing at all, which is worse than what this
    // replaced. Order matters, since killing the parent first would orphan
    // the children out of taskkill's reach.
    let killer = null;
    try {
      killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      killer.on('error', killJustThis);
    } catch (e) {
      killJustThis();
    }
    return;
  }

  // Negative pid = the whole process group. Fails with ESRCH if the group is
  // already gone, or EPERM if the child was never detached; fall back to the
  // single process so this is never worse than the old behaviour.
  try { process.kill(-pid, signal); return; } catch (e) {}
  killJustThis();
}

function spawnClaude(args, options, onError) {
  // Safety net: never spawn Claude Code without an explicit --model. Call sites
  // pass the agent's model (see modelArgs); this guards any path that doesn't,
  // so the model can never silently fall back to the user's environment.
  if (!args.includes('--model')) args = ['--model', DEFAULT_MODEL, ...args];
  // detached puts the child at the head of its own process group so its whole
  // subtree can be signalled together. Safe for terminal users: the server
  // installs its own SIGINT and SIGTERM handlers and kills children explicitly,
  // so Ctrl-C never depended on the terminal reaching them by group.
  const proc = spawn(resolveClaudeBin(), args, { ...options, detached: process.platform !== 'win32' });
  if (proc.pid) {
    registerChildPid(proc.pid, resolveClaudeBin());
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
  setWorkspace(dir) { setWorkspaceRoot(dir); invalidateAgentCache(); armAgentsDirWatcher(); },
  getWorkspace() { return WORKSPACE; },
  // scheduler
  getNextRun, executeRoutine, routineState, startScheduler,
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
