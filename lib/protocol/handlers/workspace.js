'use strict';
// WS handlers: workspace lifecycle (list/pick/set/create, mode, render
// telemetry). Extracted verbatim from server.js. Each handler receives
// (ctx, ws, msg): ctx is the dispatch context composed in the composition
// root (member list frozen by the decomposition spec), ws the requesting
// socket, msg the parsed message. Root-owned capabilities (workspace root
// mirror, cache cascade, process cleanup, search engine, startup telemetry)
// come through ctx; lib modules are required directly; the workspace root is
// read at USE time via lib/config.js so a switch redirects the next call.
const fs = require('fs');
const path = require('path');
const { getWorkspace } = require('../../config.js');
const { discoverAgents, rosterMessage } = require('../../agents/discovery.js');
const { analyzeWorkspace } = require('../../workspace/analysis.js');
const { isEmptyWorkspace, detectWorkspaceMode, scaffoldDefaults, scaffoldWorkspace, sandboxOptedOut, setSandboxOptOut } = require('../../workspace/scaffold.js');
const { readState, writeState } = require('../../store/persistence.js');
const { loadRoutineState } = require('../../scheduler.js');

function handleGetWorkspaces(ctx, ws, msg) {
  // Clear stale workspace pointer if the directory no longer exists
  if (getWorkspace() && !fs.existsSync(getWorkspace())) {
    console.log(`[Workspace] Current workspace no longer exists: ${getWorkspace()}`);
    ctx.workspace.setWorkspaceRoot(null);
  }
  const wsData = {
    type: 'workspaces',
    current: getWorkspace(),
    recent: ctx.workspace.loadRecentWorkspaces(),
    discovered: ctx.workspace.discoverWorkspaces()
  };
  if (getWorkspace()) {
    try { wsData.analysis = analyzeWorkspace(getWorkspace(), discoverAgents()); } catch (e) { console.warn('  Workspace analysis failed:', e.message); }
    try { const st = readState(); wsData.workspaceMode = st.workspaceMode || 'knowledge'; wsData.setupComplete = !!st.setupComplete; } catch (e) { /* default */ }
  }
  ws.send(JSON.stringify(wsData));
}

// Reported by the client once it has finished rendering a freshly opened
// workspace. A summary showing every server phase fast and the client slow
// redirects an investigation in one line.
function handleClientRenderTime(ctx, ws, msg) {
  const ms = Number(msg.ms);
  if (Number.isFinite(ms) && ms >= 0) ctx.signals.reportStartup(`client render ${Math.round(ms)}ms`);
}

function handleListWorkspaces(ctx, ws, msg) {
  ws.send(JSON.stringify({
    type: 'workspaces',
    recent: ctx.workspace.loadRecentWorkspaces(),
    discovered: ctx.workspace.discoverWorkspaces()
  }));
}

function handleSetWorkspace(ctx, ws, msg) {
  const dir = msg.path;
  if (!(dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory())) {
    ws.send(JSON.stringify({ type: 'workspace_error', message: 'Directory not found' }));
    return;
  }
  // Pre-flight: a .rundock that is not a directory breaks every prepare
  // step below. Refuse BEFORE touching any state, naming the culprit.
  const rundockEntry = path.join(dir, '.rundock');
  if (fs.existsSync(rundockEntry) && !fs.statSync(rundockEntry).isDirectory()) {
    ws.send(JSON.stringify({ type: 'workspace_error',
      message: `Could not open workspace: ${rundockEntry} is a file, but Rundock needs .rundock to be a directory. Remove or rename it and try again.` }));
    return;
  }
  // Belt and braces for any OTHER throw in the open path: the switch used
  // to die into the message-loop catch AFTER the root had changed, leaving
  // the server half-switched and the client with no reply at all. Roll the
  // root back and answer; never silence.
  const previousRoot = getWorkspace();
  try {
    openWorkspace(ctx, ws, dir);
  } catch (e) {
    try {
      ctx.workspace.setWorkspaceRoot(previousRoot);
      ctx.agents.invalidateAgentCache();
      ctx.store.clearSearchFailure();
      // Last, so a throw here cannot skip the rollback steps above: the whole
      // block shares one catch, and this is the newest and least proven step.
      //
      // The open path baselines the tree watcher against the NEW directory
      // before anything that can throw, so a failed switch would otherwise
      // leave both the tree cache and the poller's signature describing a
      // workspace the server is no longer in. Re-arming clears the cache as
      // part of arming, so this one call restores both.
      ctx.workspace.armFileTreeWatcher();
    } catch (rollbackErr) { console.warn('  Workspace rollback failed:', rollbackErr.message); }
    ws.send(JSON.stringify({ type: 'workspace_error', message: 'Could not open workspace: ' + e.message }));
  }
}

// The successful open path, extracted so handleSetWorkspace can guard and
// roll it back as one unit.
function openWorkspace(ctx, ws, dir) {
  // Kill all running processes when switching workspace
  const startup = ctx.signals.phaseTimer();
  ctx.runtime.killAllChildren();
  ctx.workspace.setWorkspaceRoot(dir);
  ctx.agents.armAgentsDirWatcher();
  ctx.workspace.armFileTreeWatcher();
  // Before anything reads state that may have come from another path.
  ctx.workspace.healWorkspaceIfMoved(dir);
  // A workspace switch (including re-selecting the same one) is the
  // retry trigger for a failed search-engine open, and must not
  // serve the previous workspace's cached file/skill lists.
  ctx.store.clearSearchFailure();
  ctx.agents.invalidateAgentCache();
  loadRoutineState();
  ctx.workspace.saveRecentWorkspace(dir);
  // Clean up orphaned processes from previous sessions in this workspace
  ctx.runtime.cleanOrphanedProcesses();
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
    ctx.agents.invalidateAgentCache();
  }

  try { scaffoldWorkspace(dir); } catch (e) { console.warn('Scaffold warning:', e.message); }
  startup.mark('scaffold');
  console.log(`  Workspace changed to: ${getWorkspace()} (empty=${isEmpty})`);

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
  ws.send(JSON.stringify({ type: 'workspace_set', path: getWorkspace(), analysis, isEmpty, workspaceMode: state.workspaceMode, setupComplete: !!state.setupComplete, scaffoldError }));
  ws.send(JSON.stringify(rosterMessage(agentList)));
  try { ws.send(JSON.stringify({ type: 'file_tree', tree: ctx.workspace.fileTreeForSend() })); } catch (e) { console.warn('  File tree failed:', e.message); }
  startup.mark('tree');
  ctx.signals.reportStartup(`workspace open: ${startup.summary()}`);
  // Warm the search index off the open path (reconcile-on-open);
  // ensureSearchEngine also self-heals lazily on first search.
  setImmediate(() => { try { ctx.store.ensureSearchEngine(); } catch (e) { console.warn('[Search] warm-up failed:', e.message); } });
}

function handlePickFolder(ctx, ws, msg) {
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

function handleCreateWorkspace(ctx, ws, msg) {
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
      ctx.runtime.killAllChildren();
      ctx.workspace.setWorkspaceRoot(dir);
      ctx.agents.armAgentsDirWatcher();
      ctx.workspace.armFileTreeWatcher();
      loadRoutineState();
      ctx.workspace.saveRecentWorkspace(dir);

      // New workspace is always empty: scaffold defaults
      let scaffoldError = null;
      const result = scaffoldDefaults(dir);
      if (!result.success) scaffoldError = result.error;

      try { scaffoldWorkspace(dir); } catch (e) { console.warn('Scaffold warning:', e.message); }
      console.log(`  Workspace created: ${getWorkspace()}`);

      const agentList = discoverAgents();
      const analysis = analyzeWorkspace(dir, agentList);

      // Auto-detect and store workspace mode
      const state = readState();
      state.workspaceMode = detectWorkspaceMode(dir);
      writeState(state);

      ws.send(JSON.stringify({ type: 'workspace_set', path: getWorkspace(), analysis, isEmpty: true, workspaceMode: state.workspaceMode, setupComplete: false, scaffoldError }));
      ws.send(JSON.stringify(rosterMessage(agentList)));
      ws.send(JSON.stringify({ type: 'file_tree', tree: ctx.workspace.fileTreeForSend() }));
    } catch (e) {
      ws.send(JSON.stringify({ type: 'workspace_error', message: 'Could not create workspace: ' + e.message }));
    }
  }
}

function handleSetWorkspaceMode(ctx, ws, msg) {
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

// The operating-system write block's per-workspace switch. Thin on purpose:
// the decision, the state write and the settings.local.json reconcile all
// live in lib/workspace/scaffold.js beside the block they govern; this pair
// only carries the messages.
// The platform arrives as a defaulted parameter, the same seam
// sandboxSettings itself has, so both arms of every branch are drivable on
// any test host: the dispatch path exercises the host's own arm, and a
// direct call with the other platform exercises the other, which is what
// keeps this file fully covered on macOS and on the Linux runners alike.
function handleGetSandboxMode(ctx, ws, msg, platform = process.platform) {
  const dir = getWorkspace();
  const available = platform === 'darwin' && !!dir;
  ws.send(JSON.stringify({
    type: 'sandbox_mode',
    available,
    optedOut: available ? sandboxOptedOut(dir) : false,
  }));
}

function handleSetSandboxMode(ctx, ws, msg, platform = process.platform) {
  const dir = getWorkspace();
  if (!dir || platform !== 'darwin') {
    ws.send(JSON.stringify({ type: 'workspace_error', message: 'The command sandbox is only configurable on macOS with a workspace open' }));
    return;
  }
  try {
    const { optedOut } = setSandboxOptOut(dir, msg.enabled === false, platform);
    ws.send(JSON.stringify({ type: 'sandbox_mode', available: true, optedOut }));
  } catch (e) {
    ws.send(JSON.stringify({ type: 'workspace_error', message: 'Could not update the sandbox setting: ' + e.message }));
  }
}

module.exports = { handleGetWorkspaces, handleClientRenderTime, handleListWorkspaces, handleSetWorkspace, handlePickFolder, handleCreateWorkspace, handleSetWorkspaceMode, handleGetSandboxMode, handleSetSandboxMode };
