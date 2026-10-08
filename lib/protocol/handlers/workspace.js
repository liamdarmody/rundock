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
const os = require('os');
const path = require('path');
const { getWorkspace } = require('../../config.js');
const { discoverAgents, rosterMessage } = require('../../agents/discovery.js');
const { analyzeWorkspace } = require('../../workspace/analysis.js');
const { isEmptyWorkspace, scaffoldDefaults, scaffoldWorkspace, reconcileSandboxForMode, sandboxShapeFor, sandboxOwnership, sandboxSwitchFromState, recordFirstOpen } = require('../../workspace/scaffold.js');
const { readState, writeState } = require('../../store/persistence.js');
const { readToolAllows, addToolAllow, removeToolAllow } = require('../../workspace/boundary.js');
const { readWorkingFolders, writeWorkingFolders, normalizeOne } = require('../../workspace/working-folders.js');
const { loadRoutineState } = require('../../scheduler.js');
const { normalizeWorkspaceMode } = require('../../workspace/mode.js');
const { sandboxStatus, setSandboxSwitch, pinSandboxSwitch, reviewSandboxImport, importSandboxRules } = require('../../workspace/sandbox-status.js');
const { readable } = require('../../../public/readable-error.js');

// WHETHER THE MODE SWITCH CAN ACTUALLY MOVE THIS WORKSPACE'S SANDBOX.
//
// Travels beside workspaceMode everywhere the mode does, because the settings
// pane states what the mode MEANS, and in a workspace whose sandbox block
// someone else wrote, the mode means less than the pane says. Rundock never
// rewrites a block it did not author, which is right, and until now it said
// nothing about having declined: Code mode's own description promises the
// operating-system write block is off, and a hand-authored block kept it on.
// The only way to discover that was to read the JSON.
//
// Reported after a headless render failed in a workspace sitting in Code mode.
// False, unfalsifiable from the UI, and it cost two evenings.
//
// NO GUARD HERE, because sandboxOwnership answers rather than throws: a missing
// file, an unreadable one, a path that is not a string at all, each comes back
// as "managed, nothing present", which is the quiet answer and the right one,
// since the next workspace open writes Rundock's own block anyway. A try/catch
// around a call that cannot throw is worse than none: it cannot be exercised,
// so it cannot be trusted, and it describes a failure that does not exist.
function sandboxFieldsFor(dir) {
  const own = sandboxOwnership(dir);
  return { sandboxManaged: own.managed, sandboxEnabled: own.enabled };
}

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
    try { const st = readState(); wsData.workspaceMode = normalizeWorkspaceMode(st.workspaceMode); wsData.setupComplete = !!st.setupComplete; } catch (e) { /* default */ }
    Object.assign(wsData, sandboxFieldsFor(getWorkspace()));
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
    ws.send(JSON.stringify({ type: 'workspace_error', ...readable(e, { action: 'open this workspace', fallback: 'Could not open workspace: ' + e.message }) }));
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

  // A workspace Rundock has not opened before gets its mode detected and its
  // switch recorded BEFORE scaffolding: the reconcile inside scaffoldWorkspace
  // reads the switch back off disk, so it must already be there on the very
  // first open, or the block is written from the fallback and only catches up
  // on the NEXT open. A workspace already opened is left exactly as it is.
  const state = recordFirstOpen(dir);

  try { scaffoldWorkspace(dir); } catch (e) { console.warn('Scaffold warning:', e.message); }
  startup.mark('scaffold');
  console.log(`  Workspace changed to: ${getWorkspace()} (empty=${isEmpty})`);

  // Re-discover agents after scaffolding
  try { agentList = discoverAgents(); } catch (e) { console.warn('  Agent discovery failed:', e.message); }

  let analysis = null;
  try { analysis = analyzeWorkspace(dir, agentList); } catch (e) { console.warn('  Workspace analysis failed:', e.message); }
  startup.mark('analyze');
  ws.send(JSON.stringify({ type: 'workspace_set', path: getWorkspace(), analysis, isEmpty, workspaceMode: normalizeWorkspaceMode(state.workspaceMode), setupComplete: !!state.setupComplete, scaffoldError, ...sandboxFieldsFor(getWorkspace()) }));
  ws.send(JSON.stringify(rosterMessage(agentList)));
  ws.send(JSON.stringify(require('./held-routines.js').heldRoutinesMessage(getWorkspace())));
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
    (err, stdout, stderr) => {
      if (err) {
        // A CANCEL AND A BROKEN DIALOG ARE DIFFERENT EVENTS AND USED TO LOOK
        // THE SAME. Both answered a bare null, the client's folder_picked
        // case does nothing when the path is null, and so a dialog that
        // could not be raised at all left the button looking simply dead:
        // nothing opened and nothing was said. Found by driving the shipped
        // product in a browser against a server that could not reach the
        // window server.
        //
        // osascript says which it was. A cancel is error -128, the code the
        // dialog raises when the person dismisses it, and it needs no
        // message because they meant it. Anything else, and a timeout, is
        // the picker failing, which they cannot act on unless told.
        const detail = String(stderr || err.message || '').trim();
        if (!err.killed && /\(-128\)/.test(detail)) {
          ws.send(JSON.stringify({ type: 'folder_picked', path: null }));
          return;
        }
        const why = err.killed
          ? 'The folder chooser did not answer in time.'
          : 'The folder chooser could not be opened.';
        ws.send(JSON.stringify({
          type: 'workspace_error',
          message: `${why} You can still open a workspace from the list above, or create one.`,
        }));
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

      // Mode detected and the switch recorded BEFORE scaffolding, for the
      // reason the open path gives: the reconcile reads the switch off disk.
      const state = recordFirstOpen(dir);

      // New workspace is always empty: scaffold defaults
      let scaffoldError = null;
      const result = scaffoldDefaults(dir);
      if (!result.success) scaffoldError = result.error;

      try { scaffoldWorkspace(dir); } catch (e) { console.warn('Scaffold warning:', e.message); }
      console.log(`  Workspace created: ${getWorkspace()}`);

      const agentList = discoverAgents();
      const analysis = analyzeWorkspace(dir, agentList);

      ws.send(JSON.stringify({ type: 'workspace_set', path: getWorkspace(), analysis, isEmpty: true, workspaceMode: normalizeWorkspaceMode(state.workspaceMode), setupComplete: false, scaffoldError, ...sandboxFieldsFor(getWorkspace()) }));
      ws.send(JSON.stringify(rosterMessage(agentList)));
      ws.send(JSON.stringify({ type: 'file_tree', tree: ctx.workspace.fileTreeForSend() }));
    } catch (e) {
      ws.send(JSON.stringify({ type: 'workspace_error', ...readable(e, { action: 'create this workspace', fallback: 'Could not create workspace: ' + e.message }) }));
    }
  }
}

// MODE DECIDES HOW AGENTS WORK, AND NOTHING ABOUT THE SANDBOX.
//
// Mode governs three things: the file-type restriction, command
// auto-approval, and the agent's platform rules. It used to rewrite the macOS
// write block as well, which is how choosing Code also turned off "Keep agents
// inside this workspace". That is its own switch now (set_workspace_sandbox),
// so this never reads or writes `.claude/settings.local.json`.
//
// ONE THING IT MUST DO FOR THE SWITCH. A workspace that predates the switch has
// none stored, and its value is read from the mode. Changing the mode would
// therefore move it on the next open, so the first change pins the value the
// OLD mode implied, in the same write as the new mode.
//
// `platform` stays in the signature so every caller and test keeps one shape
// for the three workspace writers; this one no longer branches on it.
function handleSetWorkspaceMode(ctx, ws, msg, platform = process.platform) {
  // `knowledge` is still accepted, from a browser tab left open across an
  // update, and stored as `notes` like everything else this build writes.
  if (msg.mode !== 'code' && msg.mode !== 'notes' && msg.mode !== 'knowledge') {
    ws.send(JSON.stringify({ type: 'workspace_error', message: 'Invalid workspace mode' }));
    return;
  }
  const mode = normalizeWorkspaceMode(msg.mode);
  try {
    const state = readState();
    const current = sandboxSwitchFromState(state);
    if (!current.stored) state.sandboxSwitch = current.on ? 'on' : 'off';
    state.workspaceMode = mode;
    writeState(state);
    console.log(`  Workspace mode changed to: ${mode}`);
    ws.send(JSON.stringify({ type: 'workspace_mode_changed', mode }));
  } catch (e) {
    ws.send(JSON.stringify({ type: 'workspace_error', message: 'Could not update workspace mode: ' + e.message }));
  }
}

// KEEP AGENTS INSIDE THIS WORKSPACE. Every reply is the row's whole status,
// read back from disk after the write, so the row always shows what is in
// force rather than what was asked for. A refusal or a failure rides on the
// same reply as `error`, rendered beside the switch: the workspace error box is
// hidden whenever Settings is on screen, which is where the switch lives.
function sendSandboxStatus(ws, platform, error) {
  const dir = getWorkspace();
  const status = dir ? sandboxStatus(dir, platform) : { type: 'sandbox_status', platform, available: false, present: false, managed: true, on: false, blockOn: false, setBy: null, enabledElsewhere: [], stored: false, notice: null };
  ws.send(JSON.stringify(error ? { ...status, error } : status));
}
function handleGetSandboxStatus(ctx, ws, msg, platform = process.platform) {
  sendSandboxStatus(ws, platform);
}
function handleSetWorkspaceSandbox(ctx, ws, msg, platform = process.platform) {
  const dir = getWorkspace();
  let error;
  try {
    if (!dir) throw new Error('open a workspace first.');
    setSandboxSwitch(dir, msg.on, platform);
    console.log(`  Keep agents inside this workspace: ${msg.on ? 'on' : 'off'}`);
  } catch (e) { error = 'Could not change this setting: ' + e.message; }
  sendSandboxStatus(ws, platform, error);
}
function handleDismissSandboxNotice(ctx, ws, msg, platform = process.platform) {
  let error;
  try { if (getWorkspace()) pinSandboxSwitch(getWorkspace()); } catch (e) { error = 'Could not save that: ' + e.message; }
  sendSandboxStatus(ws, platform, error);
}

// "Bring your custom rules into Rundock": the review writes nothing and rides
// on the status reply; the import is refused unless the file is still the one
// the person reviewed, and then tells every window the new folder list.
function handleReviewSandboxImport(ctx, ws, msg, platform = process.platform) {
  const dir = getWorkspace();
  try {
    if (!dir) throw new Error('open a workspace first.');
    const review = reviewSandboxImport(dir, platform);
    ws.send(JSON.stringify({ ...sandboxStatus(dir, platform), review }));
  } catch (e) { sendSandboxStatus(ws, platform, 'Could not review your rules: ' + e.message); }
}
function handleImportSandboxRules(ctx, ws, msg, platform = process.platform) {
  const dir = getWorkspace();
  try {
    if (!dir) throw new Error('open a workspace first.');
    importSandboxRules(dir, msg.digest, platform);
  } catch (e) {
    sendSandboxStatus(ws, platform, 'Could not bring your rules in: ' + e.message);
    return;
  }
  console.log('  Custom sandbox rules brought into Rundock');
  sendSandboxStatus(ws, platform);
  const list = JSON.stringify({ type: 'working_folders', folders: readWorkingFolders().map(d => ({ path: d, missing: !fs.existsSync(d) })), rejected: [], home: os.homedir() });
  ws.send(list);
  if (ctx && typeof ctx.broadcast === 'function') ctx.broadcast(list);
}

// The folders this workspace names as its own, besides the workspace itself.
//
// ONE MESSAGE SETS THE WHOLE LIST, rather than an add and a remove of their
// own. Adding and removing are the same act from the store's point of view,
// the client already holds the list it is rendering, and a pair of narrower
// messages would have to agree with each other about normalisation. One
// message means one place where the stored list is decided.
//
// Nothing here decides what a named folder covers. It writes a list; the
// permission hook alone reads it and judges paths against it, and each agent
// receives the list current at the moment it is spawned.
// `platform` is the same defaulted seam handleSetWorkspaceMode takes, so the
// darwin arm is exercised on every host rather than only on a macOS runner.
function handleSetWorkingFolders(ctx, ws, msg, platform = process.platform) {
  if (!getWorkspace()) {
    ws.send(JSON.stringify({ type: 'workspace_error', message: 'Open a workspace before naming the folders its agents work in.' }));
    return;
  }
  const requested = Array.isArray(msg.folders) ? msg.folders : null;
  if (!requested) {
    ws.send(JSON.stringify({ type: 'workspace_error', message: 'Could not update the working folders: no list was sent.' }));
    return;
  }
  // REPORT WHAT WAS DROPPED, rather than answering with a shorter list and
  // leaving the reader to notice. A path that cannot be stored is refused for
  // a reason (it is relative, it is the filesystem root, its own name carries
  // the list separator), and a row vanishing with no explanation is how a
  // person stops trusting a setting.
  const rejected = requested.filter(r => normalizeOne(r) === null);
  try {
    const folders = writeWorkingFolders(requested);
    // THE HOOK IS TOLD AT EVERY SPAWN; THE OPERATING SYSTEM IS TOLD ONCE, IN A
    // FILE. Without this line a folder named here reached the permission hook
    // and nothing else, so the setting worked for file tools and not for the
    // shell: the same split between the two instruments that this whole change
    // exists to close, reopened in a new place by the timing alone.
    //
    // Written AFTER the store, because the block is regenerated from the stored
    // list rather than from `requested`, and the normalisation that decides
    // what is actually stored lives in writeWorkingFolders.
    //
    // A failure here is warned rather than raised, and the stored list stands.
    // The folders are already in effect for every agent spawned from now on,
    // scaffoldWorkspace reconciles the block again on the next workspace open,
    // and discarding a list a person just chose because a settings file could
    // not be written would cost more than the delay it saves.
    try {
      const dir = getWorkspace();
      // sandboxShapeFor, not a second spelling of the same rule: whether a
      // workspace's block is on is defined once, beside the block, and read
      // from that workspace's own state file rather than the current one's.
      if (dir) reconcileSandboxForMode(dir, sandboxShapeFor(dir), platform);
    } catch (e) {
      console.warn(`  Working folders saved, but the sandbox was not updated: ${e.message}`);
    }
    const existing = folders.map(dir => ({ path: dir, missing: !fs.existsSync(dir) }));
    console.log(`  Working folders: ${folders.length} named`);
    ws.send(JSON.stringify({ type: 'working_folders', folders: existing, rejected, home: os.homedir() }));
  } catch (e) {
    ws.send(JSON.stringify({ type: 'workspace_error', ...readable(e, { action: 'save the working folders', fallback: 'Could not save the working folders: ' + e.message }) }));
  }
}

// ── Standing tool allows ───────────────────────────────────────────────────
// The answers a person gave to "Always allow" on a permission card. They used
// to live in a Set in the browser tab, so a page reload silently withdrew every
// one of them and the card asked again. These read and write the workspace's
// own permissions file, which the sandbox denies agents writing to.
//
// Three messages rather than one, because listing, granting and revoking are
// different acts with different consequences and a single message would have to
// carry a verb. The reply shape is identical for all three, so the interface
// renders one thing however the list changed.
// Sent plainly, like every other message in this file. These are not
// conversation-scoped: a standing allow belongs to the workspace, so there is
// no conversation id to echo back.
function sendToolAllows(ws) {
  ws.send(JSON.stringify({ type: 'tool_allows', tools: readToolAllows() }));
}
function handleGetToolAllows(ctx, ws, msg) {
  if (!getWorkspace()) { ws.send(JSON.stringify({ type: 'tool_allows', tools: [] })); return; }
  sendToolAllows(ws);
}
// WHAT AN ALLOW KEY IS ALLOWED TO LOOK LIKE, checked here because this is
// where text from the wire first becomes something the workspace keeps.
//
// The client builds these (toolAllowKey in public/permissions.js): a tool name
// on its own, or `Bash:<binary>` / `PowerShell:<Verb>` where the binary has
// already had its directories stripped. Every one of those is a bare
// identifier. Nothing legitimate carries a quote, a bracket, whitespace or a
// control character, so refusing them costs nothing and means the stored set
// can never hold text that a renderer has to defend against. The renderer
// defends anyway; this is the other half of the same pair, because the client
// is not the only thing that can send this message.
//
// THE CODE-MODE RULE KEYS are the one exception to that shape: an Asks-once
// card is remembered under its rule (`Bash:git-push:default-branch`), which has
// two colons. Exactly the keys the verdict defines are accepted, read from its
// own list, so a key it cannot produce is still refused.
const ALLOW_KEY = /^[A-Za-z0-9][A-Za-z0-9_.+-]*(:[A-Za-z0-9][A-Za-z0-9_.+-]*)?$/;
const RULE_KEYS = new Set(Object.values(require('../../../scripts/code-mode-verdict.js').RULES));
function isAllowKey(key) {
  return typeof key === 'string' && key.length <= 128 && (ALLOW_KEY.test(key) || RULE_KEYS.has(key));
}
// A SAVE THAT DID NOT HAPPEN IS SAID SO, as its own message naming the key,
// because the card that asked has already closed: the interface drops the
// answer it was holding and tells the person, rather than quietly asking
// again next time with nothing to say why.
function refuseToolAllow(ws, key, message) {
  ws.send(JSON.stringify({ type: 'tool_allow_failed', key: typeof key === 'string' ? key : '', message }));
}
function handleAddToolAllow(ctx, ws, msg) {
  if (!getWorkspace()) {
    refuseToolAllow(ws, msg.key, 'Open a workspace before allowing a tool for it.');
    return;
  }
  if (typeof msg.key !== 'string' || !msg.key.trim()) {
    refuseToolAllow(ws, msg.key, 'Could not record that allow: no tool was named.');
    return;
  }
  if (!isAllowKey(msg.key.trim())) {
    refuseToolAllow(ws, msg.key, 'Could not record that allow: that is not a tool name.');
    return;
  }
  const stored = addToolAllow(msg.key);
  if (!stored.includes(msg.key.trim())) {
    refuseToolAllow(ws, msg.key, 'Could not record that allow: the workspace\'s permission file could not be written.');
    return;
  }
  sendToolAllows(ws);
}
function handleRemoveToolAllow(ctx, ws, msg) {
  if (!getWorkspace()) { ws.send(JSON.stringify({ type: 'tool_allows', tools: [] })); return; }
  // REVOKING IS ALWAYS PERMITTED, even for a key that is not there: the person
  // asked for it to be gone and it is gone. Refusing an unknown key would only
  // ever confuse someone clicking twice.
  removeToolAllow(typeof msg.key === 'string' ? msg.key : '');
  sendToolAllows(ws);
}

// The list as it stands, with each folder's existence resolved at read time.
// A folder that has gone is reported as missing rather than removed: the
// interface shows it as broken so a person can see what happened and decide,
// which a list that silently edited itself could never do.
//
// The home folder travels with the list so the interface can show `~/Projects`
// rather than a full path whose shared prefix is the least interesting part of
// every row, and can expand a typed `~` for its covered-by hint.
function handleGetWorkingFolders(ctx, ws, msg) {
  if (!getWorkspace()) {
    ws.send(JSON.stringify({ type: 'working_folders', folders: [], rejected: [], home: os.homedir() }));
    return;
  }
  const folders = readWorkingFolders().map(dir => ({ path: dir, missing: !fs.existsSync(dir) }));
  ws.send(JSON.stringify({ type: 'working_folders', folders, rejected: [], home: os.homedir() }));
}

module.exports = {
  handleGetSandboxStatus, handleSetWorkspaceSandbox, handleDismissSandboxNotice, handleReviewSandboxImport, handleImportSandboxRules,
  handleGetToolAllows, handleAddToolAllow, handleRemoveToolAllow, handleGetWorkspaces, handleClientRenderTime, handleListWorkspaces, handleSetWorkspace, handlePickFolder, handleCreateWorkspace, handleSetWorkspaceMode, handleSetWorkingFolders, handleGetWorkingFolders };
