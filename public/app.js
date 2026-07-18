/**
 * Rundock Client Application
 *
 * Table of Contents:
 * ─────────────────────────────────────────────
 * 1. CONSTANTS & STATE ............... Global variables, icons, state objects
 * 2. HELPERS ......................... Agent helpers, formatting, escaping
 * 3. WEBSOCKET ....................... connect, setConn
 * 4. MESSAGE HANDLING ................ handle, handleAssistant, handleResult
 * 5. AGENT LIST & SIDEBAR ........... renderAgentList, renderConvoEmptyAgents, renderRoutinesSidebar
 * 6. ORG CHART ....................... renderOrgChart
 * 7. AGENT PROFILE .................. showProfile
 * 8. CONVERSATIONS .................. startConversation, openConversation, renderConvoList
 * 9. CHAT & MESSAGING ............... sendMessage, startProcessing, finishProcessing
 * 10. VIEWS & NAVIGATION ............ switchNav, showView, goHome, toggleTheme
 * 11. FILE TREE & EDITOR ............ renderFileTree, buildTree, loadFileContent
 * 12. MARKDOWN RENDERING ............ renderMarkdown, processCalloutsSrc
 * 13. SKILLS ........................ renderSkills, selectSkill
 * 14. SETTINGS ...................... showSettingsSection, renderSettingsSection
 * 15. WORKSPACE PICKER .............. handleWorkspaces, showWorkspacePicker
 * 16. EVENT LISTENERS & INIT ........ keydown, resize, connect()
 * ─────────────────────────────────────────────
 */

// ===== 1. CONSTANTS & STATE =====

const sunIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
const moonIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;

let ws=null, agents=[], conversations=[], activeConversation=null, currentView='home', currentFilePath=null, skills=[], skillsLoaded=false, currentWorkspacePath=null, workspaceAnalysis=null, workspaceIsEmpty=false, workspaceMode='knowledge', setupComplete=true, conversationsLoaded=false, activeSidebarPill='all', convoLists=[];
let runtimeStatus = null; // { defaultRuntime, claude: {installed, authenticated, version}, codex: {...} }
const agentLastActivity = {}; // { agentId: { time: Date, label: string } }
// Per-conversation state: { convoId: { isProcessing, currentStreamingMsg, latestText } }
const convoState = {};
let pendingActiveProcesses = null; // Deferred until conversations are loaded
// Tiptap editor for markdown files. Non-markdown files (.json, .yaml, .png,
// etc.) fall through to the legacy preview/edit pane unchanged.
let activeTiptapEditor = null;
let _tiptapEditorModule = null;
let _tiptapEditorModuleResolved = null;
let _tiptapSaveTimer = null;
function loadTiptapEditorModule() {
  if (!_tiptapEditorModule) _tiptapEditorModule = import('./editor/index.js');
  return _tiptapEditorModule;
}
function isMarkdownPath(path) {
  return typeof path === 'string' && /\.(md|mdx)$/i.test(path);
}
// File-type registry (FV2): non-markdown views live in public/viewers/.
// Loaded on demand, same pattern as the editor module above.
let _viewersModule = null, _viewersModuleResolved = null, activeFileViewer = null;
function loadViewersModule() {
  if (!_viewersModule) _viewersModule = import('./viewers/registry.js').then(m => { _viewersModuleResolved = m; return m; });
  return _viewersModule;
}
function destroyActiveFileViewer() {
  destroyActiveArtifactReview();
  if (activeFileViewer) { try { activeFileViewer.destroy(); } catch {} activeFileViewer = null; }
}
// Artifact review (FV2 phase 2): sidecar-backed comments on the HTML
// preview. Detached before its pane is cleared so the header pill and the
// frame listeners never leak.
let activeArtifactReview = null;
function destroyActiveArtifactReview() {
  if (activeArtifactReview) { try { activeArtifactReview.detach(); } catch {} activeArtifactReview = null; }
}
async function attachArtifactReviewForCurrentFile(paneEl) {
  const path = currentFilePath;
  const iframe = activeFileViewer && activeFileViewer.iframe;
  if (!iframe) return;
  const mod = await import('./viewers/artifact-review.js');
  const sidecarPath = mod.sidecarPathFor(path);
  let sidecarContent = null;
  let loadFailed = false;
  try {
    const res = await fetch('/api/file?path=' + encodeURIComponent(sidecarPath));
    if (res.ok) sidecarContent = await res.text();
    else if (res.status !== 404) loadFailed = true; // 404 = no reviews yet; anything else = a real read failure
  } catch { loadFailed = true; /* network failure: existing sidecar may be on disk */ }
  const wire = () => {
    if (currentFilePath !== path || !iframe.isConnected) return; // stale: file switched meanwhile
    destroyActiveArtifactReview();
    activeArtifactReview = mod.attachArtifactReview({
      iframe,
      paneElement: paneEl,
      path,
      sidecarContent,
      author: (workspaceAnalysis && workspaceAnalysis.userProfile && workspaceAnalysis.userProfile.fields && workspaceAnalysis.userProfile.fields.name)
        ? String(workspaceAnalysis.userProfile.fields.name).trim().toLowerCase()
        : 'me',
      agents: Array.isArray(agents) ? agents.map(a => ({ name: a.name, displayName: a.displayName })) : [],
      pillHostElement: document.getElementById('editor-header'),
      // Data-safety gate: never overwrite a sidecar we could not read
      // cleanly (a fetch/5xx failure) or one that parsed as corrupt: either
      // could destroy existing comments. Saving is disabled for this mount;
      // the artifact still renders and existing comments still show.
      allowSave: !loadFailed,
      onSaveSidecar: (content) => {
        fetch('/api/review-sidecar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: sidecarPath, content }),
        }).catch(() => { /* next mutation retries; comments also live in memory */ });
      },
    });
  };
  if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete' && iframe.contentDocument.body) wire();
  else iframe.addEventListener('load', wire, { once: true });
}
async function initTiptapEditor(path, content) {
  // Tear down any previous instance so a rapid file-switch leaves a clean
  // ProseMirror state and detached event listeners.
  const mod = await loadTiptapEditorModule();
  _tiptapEditorModuleResolved = mod;
  if (activeTiptapEditor) {
    try { mod.destroyEditor(activeTiptapEditor); } catch {}
    activeTiptapEditor = null;
  }
  const editorEl = document.getElementById('tiptap-editor');
  if (!editorEl) return;
  editorEl.innerHTML = '';
  const { editor } = mod.createEditor({
    element: editorEl,
    rawMarkdown: content || '',
    propertiesElement: document.getElementById('tiptap-properties'),
    toolbarElement: document.getElementById('tiptap-toolbar'),
    toolbarHostElement: document.getElementById('tiptap-editor-pane'),
    onUpdate: () => onTiptapEditorUpdate(),
    onWikilinkClick: (target) => openWikilink(target),
    // Frontmatter wikilinks that match no file render visibly dead.
    resolveWikilink: (target) => {
      if (!cachedFileTree) return true; // tree not loaded yet: never false-flag
      const base = String(target).split('#')[0].trim();
      return !!findFileInTree(cachedFileTree, base.endsWith('.md') ? base : base + '.md');
    },
    // Review identity: workspace profile name -> 'me' fallback; the agent
    // roster lets review attribution render known agents as agent chips.
    author: (workspaceAnalysis && workspaceAnalysis.userProfile && workspaceAnalysis.userProfile.fields && workspaceAnalysis.userProfile.fields.name)
      ? String(workspaceAnalysis.userProfile.fields.name).trim().toLowerCase()
      : 'me',
    agents: Array.isArray(agents) ? agents.map(a => ({ name: a.name, displayName: a.displayName })) : [],
    // The minimised review pill sits in the header row, next to the save
    // status, level with the filename.
    reviewPillHostElement: document.getElementById('editor-header'),
    // Cross-file navigation routes through the universal-search file-open
    // path; same-file locations stay local to the editor.
    onNavigate: (loc) => {
      if (loc && loc.path) { paletteOpenFile(loc.path); return true; }
      return false;
    },
  });
  activeTiptapEditor = editor;
  // Re-sync the find-bar count from plugin state whenever the document
  // changes. The plugin's apply() already recomputes matches on docChanged,
  // but app.js's mirror of the count is independent and otherwise stays
  // pinned to whatever the last manual search produced.
  editor.on('update', () => syncTiptapFindStateFromPlugin());
}
function onTiptapEditorUpdate() {
  if (!currentFilePath || !activeTiptapEditor) return;
  const statusEl = document.getElementById('editor-status');
  if (statusEl) {
    statusEl.textContent = 'Unsaved';
    statusEl.style.color = 'var(--attention)';
  }
  clearTimeout(_tiptapSaveTimer);
  _tiptapSaveTimer = setTimeout(() => saveTiptapFile(), 1500);
}
function saveTiptapFile() {
  if (!currentFilePath || !activeTiptapEditor || !_tiptapEditorModule) return;
  _tiptapEditorModule.then(mod => {
    const content = mod.getMarkdown(activeTiptapEditor);
    saveFileGuarded(currentFilePath, content);
  });
}

// ---- External-edit guard (FV2 phase 4) ----
// Rundock and Obsidian edit the same vault interchangeably, so auto-save
// must never silently overwrite an edit made outside Rundock. Baseline =
// the bytes we believe are on disk (set at load and after each save we
// made). Before every save, the current disk bytes are fetched and
// compared: an unexpected difference surfaces a reload-theirs / keep-mine
// choice instead of a write. Our own saves move the baseline, so
// Rundock-caused writes (including agent writes we then reload) never
// false-positive; a disk state identical to what we are writing is not a
// conflict either.
const diskBaselines = new Map();

async function saveFileGuarded(path, content) {
  let disk = null;
  try {
    const res = await fetch('/api/file?path=' + encodeURIComponent(path));
    if (res.ok) disk = (await res.text()).replace(/\r\n?/g, '\n');
  } catch { /* offline check: fall through and save as before */ }
  const baseline = diskBaselines.get(path);
  if (disk !== null && baseline !== undefined && disk !== baseline && disk !== content) {
    showExternalEditConflict(path, disk, content);
    return false;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'save_file', path, content }));
    diskBaselines.set(path, content);
  }
  const statusEl = document.getElementById('editor-status');
  if (statusEl) {
    statusEl.style.color = 'var(--success)';
    statusEl.textContent = 'Saved';
  }
  hideExternalEditConflict();
  return true;
}

function hideExternalEditConflict() {
  const banner = document.getElementById('external-edit-banner');
  if (banner) banner.remove();
}

function showExternalEditConflict(path, diskContent, myContent) {
  hideExternalEditConflict();
  const statusEl = document.getElementById('editor-status');
  if (statusEl) {
    statusEl.style.color = 'var(--attention)';
    statusEl.textContent = 'Changed outside Rundock';
  }
  const header = document.getElementById('editor-header');
  if (!header) return;
  const banner = document.createElement('div');
  banner.id = 'external-edit-banner';
  banner.innerHTML = `
    <span class="banner-text">This file changed outside Rundock while you were editing.</span>
    <button type="button" class="banner-btn" data-choice="theirs">Reload theirs</button>
    <button type="button" class="banner-btn primary" data-choice="mine">Keep mine</button>`;
  banner.addEventListener('click', (e) => {
    const btn = e.target.closest('.banner-btn');
    if (!btn || currentFilePath !== path) return;
    if (btn.dataset.choice === 'theirs') {
      hideExternalEditConflict();
      diskBaselines.set(path, diskContent);
      loadFileContent(path, diskContent);
      const s = document.getElementById('editor-status');
      if (s) { s.style.color = 'var(--success)'; s.textContent = 'Reloaded'; }
    } else {
      // Keep mine: an explicit human decision to overwrite.
      diskBaselines.set(path, diskContent); // guard passes because disk now matches
      saveFileGuarded(path, myContent);
    }
  });
  header.insertAdjacentElement('afterend', banner);
}
function destroyTiptapEditorIfActive() {
  // Capture the current instance and clear the global ref synchronously so a
  // subsequent initTiptapEditor sees a clean slate even if the module's
  // destroy promise has not yet resolved.
  const editor = activeTiptapEditor;
  activeTiptapEditor = null;
  if (editor && _tiptapEditorModule) {
    _tiptapEditorModule.then(mod => {
      try { mod.destroyEditor(editor); } catch {}
    });
  }
}
// Session continuity: the conversation that was last opened in this workspace.
// Seeded from the server-persisted value on workspace load, updated on every
// openConversation call. Used by pickDefaultConversation to land the user back
// where they were when they reopen Rundock or switch workspaces.
let lastActiveConversationId = null;
let _persistLastActiveTimer = null;
function persistLastActiveConversation(id) {
  lastActiveConversationId = id;
  // Debounce the server write so rapid switches between conversations collapse
  // into a single .rundock/state.json write.
  clearTimeout(_persistLastActiveTimer);
  _persistLastActiveTimer = setTimeout(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set_last_active_conversation', id }));
    }
  }, 500);
}
// Returns the conversation that should be loaded by default, or null when
// nothing is suitable and the caller should fall through to workspace routing
// (new conversation, team view, setup, etc.). Priority order:
//   1. Any processing (currently working) conversation
//   2. The last-opened conversation if it still exists and is not archived
//   3. The most recently active non-archived conversation (top of "All")
// Replaces the pre-0.8.10 "first pinned" default which became inconsistent with
// the recency-sorted sidebar after the pill-filter rework.
function pickDefaultConversation() {
  const processing = conversations.find(c => getConvoState(c.id).isProcessing);
  if (processing) return processing;
  if (lastActiveConversationId) {
    const last = conversations.find(c => c.id === lastActiveConversationId && c.status !== 'archived');
    if (last) return last;
  }
  const active = conversations.filter(c => c.status !== 'archived');
  if (!active.length) return null;
  return active.reduce((best, c) => {
    const bt = new Date(best.lastActiveAt || best.createdAt || 0).getTime();
    const ct = new Date(c.lastActiveAt || c.createdAt || 0).getTime();
    return ct > bt ? c : best;
  });
}
let orgZoomOffset = 0; // User zoom adjustment: +/- steps of 0.1 on top of auto-fit scale
const unreadConvos = new Set(); // convoIds with unread agent messages
const workingConvos = new Set(); // convoIds with agents actively processing

// ===== 2. HELPERS =====

function updateWorkingBadge() {
  const navBtn = document.querySelector('[data-nav="team"]');
  if (!navBtn) return;
  let badge = navBtn.querySelector('.nav-badge-working');
  const anyWorking = Object.values(convoState).some(s => s.isProcessing);
  if (anyWorking) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'nav-badge-working';
      navBtn.appendChild(badge);
    }
  } else {
    if (badge) badge.remove();
  }
}

function updateUnreadBadge() {
  const navBtn = document.querySelector('[data-nav="conversations"]');
  if (!navBtn) return;
  let badge = navBtn.querySelector('.nav-badge');
  if (unreadConvos.size > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'nav-badge';
      navBtn.appendChild(badge);
    }
  } else {
    if (badge) badge.remove();
  }
}

function esc(t){const d=document.createElement('div');d.textContent=t;return d.innerHTML;}
function escAttr(t){return t.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function stripMd(t){return t.replace(/\*\*(.*?)\*\*/g,'$1').replace(/\*(.*?)\*/g,'$1').replace(/~~(.*?)~~/g,'$1').replace(/`([^`]+)`/g,'$1').replace(/^#+\s/gm,'').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g,'$2').replace(/\[\[([^\]]+)\]\]/g,'$1').replace(/==(.*?)==/g,'$1');}
// Marker scanning/stripping logic lives in markers.js (unit-tested; loaded
// before this file). This alias keeps the historical call sites readable.
function stripRundockMarkers(t){return RundockMarkers.stripMarkers(t);}

function formatTimeAgo(input) {
  if (!input) return 'never';
  const d = input instanceof Date ? input : new Date(input);
  const diff = Math.floor((Date.now() - d) / 1000);
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  return `${Math.floor(diff/86400)}d ago`;
}

function formatScheduleShort(schedule) {
  if (!schedule) return '';
  const s = schedule.toLowerCase();
  const dailyMatch = s.match(/every day at (\d{2}):(\d{2})/);
  if (dailyMatch) {
    const h = parseInt(dailyMatch[1]);
    const m = dailyMatch[2];
    return `${h === 0 ? 12 : (h > 12 ? h - 12 : h)}:${m} ${h >= 12 ? 'PM' : 'AM'}`;
  }
  const weeklyMatch = s.match(/every (\w+) at (\d{2}):(\d{2})/);
  if (weeklyMatch) {
    const day = weeklyMatch[1].charAt(0).toUpperCase() + weeklyMatch[1].slice(1, 3);
    const h = parseInt(weeklyMatch[2]);
    const m = weeklyMatch[3];
    return `${day} ${h === 0 ? 12 : (h > 12 ? h - 12 : h)}:${m} ${h >= 12 ? 'PM' : 'AM'}`;
  }
  return schedule;
}

function getTeamAgents() { return agents.filter(a => a.status === 'onTeam' && a.type !== 'platform'); }
function getPlatformAgents() { return agents.filter(a => a.status === 'onTeam' && a.type === 'platform'); }
function getGuide() { return agents.find(a => a.type === 'platform'); }

// ===== 3. WEBSOCKET =====

function connect() {
  const p = location.protocol==='https:'?'wss:':'ws:';
  ws = new WebSocket(`${p}//${location.host}`);
  ws.onopen = () => { setConn('connected'); ws.send(JSON.stringify({type:'get_workspaces'})); };
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onclose = () => { setConn('disconnected'); setTimeout(connect, 2000); };
  ws.onerror = () => {}; // Prevent unhandled error; onclose fires next
}
function setConn(s) { const b=document.getElementById('connection-bar'); b.className=`connection-bar ${s}`; b.textContent=s==='connected'?'Connected':s==='disconnected'?'Disconnected. Reconnecting...':'Connecting...'; if(s==='connected')setTimeout(()=>b.style.display='none',2000); else b.style.display='block'; }

// ===== 4. MESSAGE HANDLING =====

function handle(d) {
  const convoId = d._conversationId;
  switch(d.type) {
    case 'workspaces': handleWorkspaces(d); break;
    case 'workspace_set': onWorkspaceReady(d.path, d.analysis, d.isEmpty, d.workspaceMode, d.scaffoldError, d.setupComplete); break;
    case 'folder_picked': if (d.path) selectWorkspace(d.path); break;
    case 'workspace_error': {
      const errEl = document.getElementById('workspace-error');
      if (errEl) { errEl.textContent = d.message; errEl.style.display = 'block'; }
      break;
    }
    case 'workspace_mode_changed':
      workspaceMode = d.mode;
      // Re-render settings if currently viewing workspace settings
      if (currentView === 'settings') renderSettingsSection('workspace');
      break;
    case 'needs_workspace': showView('workspace'); break;
    case 'agents': agents=d.agents; renderAgentList(); renderOrgChart(); renderRoutinesSidebar(); renderConvoList(); break;
    case 'skills': skills=d.skills; skillsLoaded=true; renderSkills(); if(palettePendingSkill){const s=palettePendingSkill;palettePendingSkill=null;selectSkill(s);} break;
    case 'conversations': handlePersistedConversations(d.conversations, d.lastActiveConversationId); break;
    case 'lists': {
      const prevIds = new Set(convoLists.map(l => l.id));
      convoLists = d.lists || [];
      // Create-and-add flow: a list created from a conversation's context menu
      // adds that conversation to it once the server confirms creation.
      if (pendingListAdd) {
        const created = convoLists.filter(l => !prevIds.has(l.id));
        if (created.length === 1) toggleConvoListMembership(pendingListAdd, created[0].id);
        pendingListAdd = null;
      }
      renderListPills();
      // If the active pill's list was deleted, fall back to All (via
      // setSidebarPill so the fixed pills' active classes update too).
      if (RundockConvoList.isListPill(activeSidebarPill) && !convoLists.some(l => 'list:' + l.id === activeSidebarPill)) setSidebarPill('all');
      else renderConvoList();
      break;
    }
    case 'system':
      // Decision logic for process lifecycle, session capture, cancellation
      // and delegation lives in RundockConversationState (conversation-state.js);
      // this branch builds the read-only ctx facts, applies the reduced state
      // and executes the returned effects against the DOM/WebSocket.
      // Track active process per conversation to ignore stale events
      if(d.subtype==='process_started' && convoId && d._processId) {
        const state = getConvoState(convoId);
        console.log(`[Process] convo=${convoId} process_started pid=${d._processId} prev=${state.activeProcessId} agent=${d._agent||'?'}`);
        const r = RundockConversationState.reduce(state, d, {});
        convoState[convoId] = r.state;
        executeEffects(convoId, r.effects);
      }
      // Capture session ID from init message and persist for resume after refresh
      if(d.subtype==='init' && d._sessionId && convoId) {
        const convo = conversations.find(c => c.id === convoId);
        const r = RundockConversationState.reduce(getConvoState(convoId), d, {
          convoExists: !!convo,
          convoAgentId: convo?.agentId,
          hasPrimarySession: !!convo?.sessionId,
          knownSessionIds: (convo?.sessionIds || []).map(s => s.sessionId),
        });
        convoState[convoId] = r.state;
        executeEffects(convoId, r.effects);
      }
      // Neutral notice: informational pill with NO side effects. Used for
      // Codex write-request outcomes. Distinct from 'info', which doubles
      // as the stale-session signal and clears the stored sessionId: that
      // side effect must never fire for a routine notice.
      if(d.subtype==='notice' && d.content && convoId) {
        const r = RundockConversationState.reduce(getConvoState(convoId), d, {});
        convoState[convoId] = r.state;
        executeEffects(convoId, r.effects);
      }
      // Stale session: server is retrying fresh, clear the old sessionId
      if(d.subtype==='info' && d.content && convoId) {
        const convo = conversations.find(c => c.id === convoId);
        const r = RundockConversationState.reduce(getConvoState(convoId), d, {
          hasPrimarySession: !!(convo && convo.sessionId),
        });
        convoState[convoId] = r.state;
        executeEffects(convoId, r.effects);
      }
      // Agent was cancelled by user
      if(d.subtype==='cancelled' && convoId) {
        // The server's cancel sweep has already answered every pending
        // permission request for this conversation, so any queued
        // background cards are stale and must never render.
        RundockPermissions.clearPendingPermissions(pendingPermissionsByConvo, convoId);
        const r = RundockConversationState.reduce(getConvoState(convoId), d, {});
        convoState[convoId] = r.state;
        executeEffects(convoId, r.effects);
      }
      // Only finish if this done event is from the currently active process
      if(d.subtype==='done' && convoId) {
        const state = getConvoState(convoId);
        const match = !d._processId || !state.activeProcessId || d._processId === state.activeProcessId;
        console.log(`[Done] convo=${convoId} pid=${d._processId} active=${state.activeProcessId} match=${match} isProcessing=${state.isProcessing}`);
        const r = RundockConversationState.reduce(state, d, {});
        convoState[convoId] = r.state;
        executeEffects(convoId, r.effects);
      }
      // Keepalive heartbeat from a silent Codex turn: the reducer bumps the
      // stream-activity clock (ctx.now keeps it pure) so the 90s watchdog
      // never declares a legitimately working turn dead. No render effect.
      if(d.subtype==='keepalive' && convoId) {
        const r = RundockConversationState.reduce(getConvoState(convoId), d, { now: Date.now() });
        convoState[convoId] = r.state;
        executeEffects(convoId, r.effects);
      }
      // Agent switch: delegation handoff or return
      if(d.subtype==='agent_switch' && convoId) {
        const toAgent = agents.find(a => a.id === d.toAgent);
        const fromAgent = agents.find(a => a.id === d.fromAgent);
        const convo = conversations.find(c => c.id === convoId);
        const r = RundockConversationState.reduce(getConvoState(convoId), d, {
          isActive: activeConversation?.id === convoId,
          convoAgentId: convo?.agentId,
          toAgentExists: !!toAgent,
          toAgentType: toAgent ? toAgent.type : null,
          fromAgentExists: !!fromAgent,
        });
        convoState[convoId] = r.state;
        executeEffects(convoId, r.effects);
      }
      if(d.subtype==='delegation_error' && convoId) {
        addSystemMsgToConvo(d.content || 'Delegation failed', convoId, true);
      }
      if(d.subtype==='auth_error' && convoId) {
        renderAuthErrorCard(convoId);
      }
      if(d.subtype==='codex_quota' && convoId) {
        renderCodexQuotaCard(convoId, d);
        finishProcessing(convoId);
      }
      if(d.subtype==='codex_guidance' && convoId) {
        renderCodexGuidanceCard(convoId, d);
        finishProcessing(convoId);
      }
      if(d.subtype==='codex_error' && convoId) {
        renderCodexErrorPill(convoId, d);
        finishProcessing(convoId);
      }
      break;
    case 'stream_event':
      if(convoId && !isStaleProcess(d, convoId)) handleStreamEvent(d, convoId);
      break;
    case 'assistant':
      if(convoId && !isStaleProcess(d, convoId)) handleAssistant(d, convoId);
      break;
    case 'result':
      if(convoId && !isStaleProcess(d, convoId)) handleResult(d, convoId);
      break;
    case 'file_tree': cachedFileTree = d.tree; renderFileTree(d.tree); break;
    case 'file_content': loadFileContent(d.path, d.content); break;
    case 'file_saved': document.getElementById('editor-status').textContent='Saved'; break;
    case 'path_created':
      // The tree was refreshed by the preceding file_tree push; open a new
      // note/board in the editor and reveal it. A new folder just appears.
      if (d.kind !== 'folder') { ws.send(JSON.stringify({ type: 'read_file', path: d.path })); }
      setTimeout(() => highlightFileInSidebar(d.path), 0);
      break;
    case 'create_error':
      alert('Could not create "' + d.path + '": ' + d.reason);
      break;
    case 'agent_saved':
      if (!d.updated) setupComplete = true;
      // Non-default runtimes are worth calling out on the confirmation pill.
      addSystemMsg('Agent "' + (d.agentId || '') + '" ' + (d.updated ? 'updated' : 'created') + (d.runtime === 'codex' ? ' · runs on Codex' : ''));
      break;
    case 'runtime_status':
      runtimeStatus = d;
      renderRuntimesCard();
      break;
    case 'agent_error':
      addSystemMsg(d.message || 'Agent operation failed');
      break;
    case 'agent_deleted':
      addSystemMsg('Agent "' + (d.agentId || '') + '" removed');
      break;
    case 'skill_saved':
      addSystemMsg('Skill "' + (d.skillId || '') + '" ' + (d.updated ? 'updated' : 'created'));
      break;
    case 'skill_error':
      addSystemMsg(d.message || 'Skill operation failed');
      break;
    case 'skill_deleted':
      addSystemMsg('Skill "' + (d.skillId || '') + '" removed');
      break;
    case 'active_processes':
      // Defer until workspace is ready and conversations are loaded
      pendingActiveProcesses = d.processes || [];
      break;
    case 'server_info':
      if (d.version) window._rundockVersion = d.version;
      break;
    case 'control_request': {
      const targetConvo = convoId || activeConversation?.id;
      if(targetConvo) handlePermissionRequest(d, targetConvo);
      break;
    }
    case 'permission_timeout': {
      const card = document.getElementById('perm-' + d.requestId);
      if (card) {
        card.innerHTML = `<div class="permission-resolved denied"><span>✕ Timed out</span></div>`;
      }
      pendingPermissions.delete(d.requestId);
      // Expired: a copy queued for a background conversation must never be
      // rendered (and answered) after the server has auto-denied it.
      RundockPermissions.removePendingPermission(pendingPermissionsByConvo, d.requestId);
      const t = document.getElementById('thinking-indicator');
      if (t) t.style.display = '';
      break;
    }
    case 'session_history':
      renderSessionHistory(d);
      break;
    case 'search_universal_results':
      handlePaletteResults(d);
      break;
    case 'error': if(!d.content?.includes('no stdin')) addSystemMsgToConvo(d.content, convoId); break;
  }
}
function getConvoState(convoId) {
  // Reducer-owned fields come from createState(); currentStreamingMsg is the
  // one DOM field that lives alongside them (the reducer tracks it only as
  // the boolean hasStreamingBubble and carries it through untouched).
  if(!convoState[convoId]) convoState[convoId] = Object.assign(RundockConversationState.createState(), { currentStreamingMsg: null });
  return convoState[convoId];
}

// Execute the declarative effects returned by RundockConversationState.reduce.
// Each executor is the thin DOM/WebSocket glue for one decision the reducer
// made; no decision logic lives here beyond guards on live DOM state that the
// reducer cannot see (e.g. cross-conversation working indicators).
const EFFECT_EXECUTORS = {
  'drop-stale': (convoId, ef) => {
    if (ef.reason === 'stale-done') {
      console.log(`[Done] SKIPPED finishProcessing: process ID mismatch`);
    } else {
      console.warn(`[Stale] convo=${convoId} dropped ${ef.messageType} from pid=${ef.processId} (active=${ef.activeProcessId})`);
    }
  },
  'remove-permission-cards': () => {
    // Remove stale permission cards from the previous process
    document.querySelectorAll('.msg-permission').forEach(el => el.remove());
  },
  'start-processing': (convoId) => startProcessing(convoId),
  'finish-processing': (convoId) => finishProcessing(convoId),
  'set-session': (convoId, ef) => {
    const convo = conversations.find(c => c.id === convoId);
    if (!convo) return;
    if (ef.setPrimary) convo.sessionId = ef.sessionId;
    if (!convo.sessionIds) convo.sessionIds = [];
    if (ef.addToChain) convo.sessionIds.push({ sessionId: ef.sessionId, agentId: ef.agentId });
    persistConversation(convo);
  },
  'clear-session': (convoId) => {
    const convo = conversations.find(c => c.id === convoId);
    if (!convo) return;
    convo.sessionId = null;
    persistConversation(convo);
  },
  'notice': (convoId, ef) => addSystemMsgToConvo(ef.content, convoId, false),
  'add-cancelled-badge': (convoId, ef) => {
    // Add a cancelled badge to the current streaming message if there is one
    const streamEl = getConvoState(convoId).currentStreamingMsg;
    if (!streamEl) return;
    const badge = document.createElement('span');
    badge.className = 'cancelled-badge';
    badge.textContent = 'Cancelled';
    const bubble = streamEl.querySelector('.msg-bubble');
    if (bubble) bubble.appendChild(badge);
    const actSummary = buildActivitySummary(ef.toolCalls, ef.turnStartTime);
    if (actSummary) streamEl.appendChild(actSummary);
  },
  'clear-outgoing-working': (convoId, ef) => {
    // Clear the outgoing agent's working indicator, but only if it isn't
    // still legitimately working on another conversation. Also stamp
    // last-activity so the sidebar row shows a timestamp instead of blank.
    const outgoingAgentId = ef.outgoingAgentId;
    if (getWorkingAgentIds().has(outgoingAgentId)) return;
    const convo = conversations.find(c => c.id === convoId);
    agentLastActivity[outgoingAgentId] = { time: new Date(), label: convo?.title || '' };
    const outRow = document.querySelector(`[data-status="${outgoingAgentId}"]`);
    if (outRow) { outRow.textContent = formatTimeAgo(new Date()); outRow.classList.remove('working'); }
    const outDot = document.querySelector(`[data-org-status="${outgoingAgentId}"]`);
    if (outDot) outDot.classList.remove('working');
  },
  'promote-handoff-message': (convoId, ef) => {
    // Persist the orchestrator's handoff text and, if the streaming bubble
    // exists in the DOM, promote it to a permanent node by clearing the
    // streaming-text class and re-rendering with final content.
    const convo = conversations.find(c => c.id === convoId);
    const agentId = ef.agentId || convo?.agentId;
    if (convo) {
      convo.messages.push({ role: 'agent', content: ef.text, agentId, timestamp: new Date().toISOString() });
    }
    const state = getConvoState(convoId);
    if (state.currentStreamingMsg && activeConversation?.id === convoId) {
      const streamEl = state.currentStreamingMsg.querySelector('.streaming-text');
      if (streamEl) {
        streamEl.classList.remove('streaming-text');
        streamEl.innerHTML = formatMd(ef.text);
      }
    }
  },
  'clear-streaming-bubble': (convoId) => {
    getConvoState(convoId).currentStreamingMsg = null;
  },
  'render-convo-list': () => renderConvoList(),
  'show-delegation-divider': (convoId, ef) => {
    const toAgent = agents.find(a => a.id === ef.toAgentId);
    const m = document.getElementById('messages');
    m.appendChild(buildDelegationDivider(toAgent, ef.isReturn));
    scrollBottom();
    // Persist divider as explicit marker so it survives navigate-away/back
    const convo = conversations.find(c => c.id === convoId);
    if (convo) {
      convo.messages.push({ role: 'divider', agentId: ef.toAgentId, fromAgentId: ef.fromAgentId, isReturn: ef.isReturn });
    }
  },
  'update-chat-header': (convoId, ef) => {
    const toAgent = agents.find(a => a.id === ef.toAgentId);
    if (!toAgent) return;
    const headerLabel = document.getElementById('chat-agent-label');
    const headerAvatar = document.getElementById('chat-agent-avatar');
    if (headerLabel) headerLabel.textContent = toAgent.displayName;
    if (headerAvatar) { headerAvatar.style.background = toAgent.colour; headerAvatar.textContent = toAgent.icon; }
    document.getElementById('msg-input').placeholder = 'Message ' + toAgent.displayName + '...';
  },
  'start-streaming-bubble': (convoId, ef) => {
    const state = getConvoState(convoId);
    if (state.currentStreamingMsg) return;
    // Remove thinking indicator, replace with streaming bubble
    const t = document.getElementById('thinking-indicator'); if (t) t.remove();
    const a = agents.find(x => x.id === ef.agentId) || activeConversation?.agent || agents[0];
    const m = document.getElementById('messages'), el = document.createElement('div');
    el.className = 'msg msg-agent';
    el.innerHTML = `<div class="msg-sender" style="color:${a?.colour||'var(--accent)'}"><div class="avatar xs" style="background:${a?.colour||'var(--accent)'}">${a?.icon||'?'}</div> ${a?.displayName||'Agent'}<span class="msg-time">${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span></div><div class="msg-bubble"><span class="streaming-text"></span></div>`;
    m.appendChild(el);
    state.currentStreamingMsg = el;
  },
  'render-stream-text': (convoId, ef) => {
    const state = getConvoState(convoId);
    const streamEl = state.currentStreamingMsg ? state.currentStreamingMsg.querySelector('.streaming-text') : null;
    if (streamEl) streamEl.innerHTML = formatMd(ef.text);
    scrollBottom();
  },
  'ensure-tool-status': (convoId, ef) => {
    let status = document.getElementById('thinking-status');
    if (!status) {
      // Thinking indicator was removed when streaming started; re-add it below the streaming message
      const a = agents.find(x => x.id === ef.agentId) || activeConversation?.agent || agents[0];
      const m = document.getElementById('messages'), el = document.createElement('div');
      el.className = 'msg msg-agent'; el.id = 'thinking-indicator';
      el.innerHTML = `<div class="msg-sender" style="color:${a?.colour||'var(--accent)'}"><div class="avatar xs" style="background:${a?.colour||'var(--accent)'}">${a?.icon||'?'}</div> ${a?.displayName||'Agent'}</div><div class="msg-bubble thinking-bubble"><div class="thinking-pulse" style="background:${a?.colour||'var(--accent)'}"></div><div><div class="thinking-label">Thinking</div><div class="thinking-status" id="thinking-status"></div></div></div>`;
      m.appendChild(el);
      scrollBottom();
      status = el.querySelector('#thinking-status');
    }
    if (status) status.textContent = formatToolName(ef.toolName);
  },
  'update-tool-status': (convoId, ef) => {
    const status = document.getElementById('thinking-status');
    if (status) status.textContent = formatToolName(ef.toolName);
    scrollBottom();
  },
  'schedule-file-refresh': () => {
    // Refresh file tree when file-writing tools are used (with delay for disk flush)
    setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'get_files' }));
    }, 1000);
  },
  'suppress-silent-park': (convoId) => {
    // Silent-park turn: remove any streaming bubble from the DOM, skip render
    const state = getConvoState(convoId);
    if (state.currentStreamingMsg) state.currentStreamingMsg.remove();
    state.currentStreamingMsg = null;
  },
  'finalize-agent-message': (convoId, ef) => {
    const convo = conversations.find(c => c.id === convoId);
    if (!convo) return;
    convo.messages.push({ role: 'agent', content: ef.text, agentId: ef.agentId, timestamp: new Date().toISOString() });
    convo.lastAgentId = ef.agentId;
    convo.lastMessagePreview = stripMd(ef.text).substring(0, 80);
  },
  'mark-unread': (convoId) => {
    unreadConvos.add(convoId);
    updateUnreadBadge();
  },
  'remove-thinking-indicator': () => {
    const t = document.getElementById('thinking-indicator'); if (t) t.remove();
  },
  'finalize-stream-bubble': (convoId, ef) => {
    // Text was already streamed in real-time. Do a final re-render with complete markdown.
    const state = getConvoState(convoId);
    if (!state.currentStreamingMsg) return;
    const streamEl = state.currentStreamingMsg.querySelector('.streaming-text');
    if (streamEl && ef.text) streamEl.innerHTML = formatMd(ef.text);
    const actSummary = buildActivitySummary(ef.toolCalls, ef.turnStartTime);
    if (actSummary) state.currentStreamingMsg.appendChild(actSummary);
  },
  'append-final-message': (convoId, ef) => {
    // No streaming happened (e.g. very short response). Render now.
    const msgEl = addAgentMsg(ef.text, ef.agentId);
    const actSummary = buildActivitySummary(ef.toolCalls, ef.turnStartTime);
    if (actSummary && msgEl) msgEl.appendChild(actSummary);
  },
};

function executeEffects(convoId, effects) {
  for (const ef of effects) {
    const run = EFFECT_EXECUTORS[ef.type];
    if (run) run(convoId, ef);
    else console.warn('[Effects] Unknown effect type:', ef.type);
  }
}
// Flush a deferred "resumed" badge into the message stream.
// Build a delegation divider element. Used by live agent_switch, in-memory replay, and history replay.
function buildDelegationDivider(agentData, isReturn, opts = {}) {
  const divider = document.createElement('div');
  divider.className = 'msg-delegation' + (opts.historyClass ? ' history-msg' : '');
  if (opts.noAnimation) divider.style.animation = 'none';
  const label = isReturn ? 'resumed' : 'joined';
  const colour = agentData?.colour || 'var(--accent)';
  const icon = agentData?.icon || '?';
  const name = agentData?.displayName || 'Agent';
  divider.innerHTML = `<div class="delegation-line"></div><div class="delegation-badge" style="color:${colour}"><span class="avatar xs" style="background:${colour}">${icon}</span>${name} ${label}</div><div class="delegation-line"></div>`;
  return divider;
}

function isStaleProcess(d, convoId) {
  // The activeProcessId acceptance rule lives in the reducer module; this
  // wrapper adds the diagnostic log and keeps the pre-handler gate in place
  // so stale messages are dropped BEFORE any glue side effects run.
  const state = getConvoState(convoId);
  const stale = RundockConversationState.isStale(state, d);
  if(stale) console.warn(`[Stale] convo=${convoId} dropped ${d.type} from pid=${d._processId} (active=${state.activeProcessId})`);
  return stale;
}

function handleStreamEvent(d, convoId) {
  if(!d.event) return;
  const state = getConvoState(convoId);
  state.lastStreamActivity = Date.now(); // wall clock stays in glue; the reducer is pure
  const r = RundockConversationState.reduce(state, d, { isActive: activeConversation?.id === convoId });
  convoState[convoId] = r.state;
  executeEffects(convoId, r.effects);
}

function handleAssistant(d, convoId) {
  if(!d.message?.content) return;
  const state = getConvoState(convoId);
  state.lastStreamActivity = Date.now();
  const r = RundockConversationState.reduce(state, d, { isActive: activeConversation?.id === convoId });
  convoState[convoId] = r.state;
  executeEffects(convoId, r.effects);
}

function handleResult(d, convoId) {
  const state = getConvoState(convoId);
  const isActive = activeConversation?.id === convoId;
  const convo = conversations.find(c => c.id === convoId);
  let delegationTriggered = false;
  let reduced = null;

  try {
  // Detect agent and skill definitions in responses and route to server.
  // SAVE markers (upsert): RUNDOCK:SAVE_AGENT, RUNDOCK:SAVE_SKILL
  // Legacy CREATE markers also supported for backward compatibility.
  // Prefer streamingRawText: it contains the raw text with HTML comment markers intact.
  // d.result from stream-json is often empty or may strip HTML comments.
  const textToScan = state.streamingRawText || d.result || state.latestText || '';
  if(textToScan && ws) {
    let filesCreated = 0;

    // Marker scanning is pure logic in markers.js (unit-tested); this block
    // owns the WebSocket sends. Action order preserves the historical send
    // order: agent saves, skill saves, skill deletes, agent deletes.
    const scan = RundockMarkers.scanMarkers(textToScan);
    const MARKER_SENDS = {
      save_agent:   a => ({ type: 'save_agent', name: a.name, content: a.content }),
      save_skill:   a => ({ type: 'save_skill', name: a.name, content: a.content }),
      delete_skill: a => ({ type: 'delete_skill', name: a.name }),
      delete_agent: a => ({ type: 'delete_agent', agentId: a.name }),
    };
    for (const action of scan.actions) {
      ws.send(JSON.stringify(MARKER_SENDS[action.kind](action)));
      filesCreated++;
      console.log('[Marker]', action.kind + ':', action.name);
    }

    // DELEGATE marker: orchestrator hands off to another agent
    if (scan.delegation) {
      const { targetAgent, context } = scan.delegation;
      console.log('[Delegate] Detected:', targetAgent, 'context:', context.substring(0, 100));
      ws.send(JSON.stringify({ type: 'delegate', conversationId: convoId, targetAgent, context }));
      delegationTriggered = true;
    }

    // RETURN marker: delegate signals task complete, return to orchestrator
    if (scan.hasReturn) {
      console.log('[Delegate] Return detected');
      ws.send(JSON.stringify({ type: 'end_delegation', conversationId: convoId }));
    }

    // Fallback: raw YAML frontmatter agent definitions without the marker
    // wrapper. Only when the marker scan produced no save/delete actions.
    if(filesCreated === 0) {
      for (const fm of RundockMarkers.extractFrontmatterAgents(textToScan)) {
        ws.send(JSON.stringify({ type: 'save_agent', name: fm.name, content: fm.content }));
        filesCreated++;
        console.log('[Agent] Fallback extraction:', fm.name);
      }
    }

    if(filesCreated > 0) {
      console.log('[Rundock] Saved', filesCreated, 'file(s)');
      setTimeout(() => {
        if(ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'get_agents' }));
          ws.send(JSON.stringify({ type: 'get_skills' }));
        }
      }, 500);
    }
  }

  // Everything from here (silent-park heuristic, message finalisation,
  // render decisions, processing finish) is decided by the reducer; the
  // effects are executed against the DOM below. The marker scan above stays
  // in the glue because it owns the WebSocket sends.
  reduced = RundockConversationState.reduce(state, d, {
    isActive,
    viewingChat: isActive && currentView === 'chat',
    convoExists: !!convo,
    convoInWorkspace: conversations.some(c => c.id === convoId),
    delegationTriggered,
  });
  convoState[convoId] = reduced.state;
  executeEffects(convoId, reduced.effects.filter(ef => ef.type !== 'finish-processing' && ef.type !== 'render-convo-list'));

  } catch(err) {
    console.error('[handleResult] Error:', err);
  }
  // The tail runs even when the render half threw, matching the old
  // handler's post-catch lines: reset the streaming bubble, finish
  // processing (unless a delegation is starting) and re-render the list.
  getConvoState(convoId).currentStreamingMsg = null;
  if (reduced) {
    executeEffects(convoId, reduced.effects.filter(ef => ef.type === 'finish-processing' || ef.type === 'render-convo-list'));
  } else {
    // reduce itself failed: fall back to the old unconditional reset
    const st = getConvoState(convoId);
    st.streamingRawText=''; st.latestText=''; st.latestAgentId=null; st.silentTurn=false; st.hasStreamingBubble=false;
    if (!delegationTriggered) finishProcessing(convoId);
    renderConvoList();
  }
}

function addSystemMsgToConvo(text, convoId, isError = true) {
  if(!convoId || activeConversation?.id === convoId) addSystemMsg((isError ? 'Error: ' : '') + text);
}

// ===== 5. AGENT LIST & SIDEBAR =====

function getWorkingAgentIds() {
  const working = new Set();
  for (const [convoId, state] of Object.entries(convoState||{})) {
    if (state.isProcessing) {
      const activeId = state.activeAgentId || conversations.find(c=>c.id===convoId)?.agentId;
      if (activeId) working.add(activeId);
    }
  }
  return working;
}
function renderAgentList() {
  const onTeam = getTeamAgents();
  const platform = getPlatformAgents();
  const available = agents.filter(a => a.status === 'available' || a.status === 'raw');
  const workingIds = getWorkingAgentIds();

  let h = '';
  // On team agents (or empty state)
  if (onTeam.length) {
    for (const a of onTeam) {
      const isWorking = workingIds.has(a.id);
      const last = agentLastActivity[a.id];
      const statusText = isWorking ? 'working' : (last ? formatTimeAgo(last.time) : 'idle');
      const workingClass = isWorking ? ' working' : '';
      h += `<div class="agent-status-item" onclick="showProfile('${a.id}')" data-agent="${a.id}">
        <div class="avatar sm" style="background:${a.colour}">${a.icon}</div>
        <span class="agent-status-name">${a.displayName}</span>
        <span class="agent-status-state${workingClass}" data-status="${a.id}">${statusText}</span>
      </div>`;
    }
  } else if (platform.length) {
    const guide = platform[0];
    h += `<div class="sidebar-empty-state">
      <div class="sidebar-empty-text">No team agents yet. Doc can explore this workspace and create a team for you.</div>
      <button class="empty-cta" style="width:100%" onclick="startSetupConversation()">Set up your team</button>
    </div>`;
  }
  // Platform agents
  if (platform.length) {
    h += `<div class="sidebar-section-divider"><span class="sidebar-label">Rundock Agents</span></div>`;
    for (const a of platform) {
      const isWorking = workingIds.has(a.id);
      const last = agentLastActivity[a.id];
      const statusText = isWorking ? 'working' : (last ? formatTimeAgo(last.time) : 'idle');
      const workingClass = isWorking ? ' working' : '';
      h += `<div class="agent-status-item" onclick="showProfile('${a.id}')" data-agent="${a.id}">
        <div class="avatar sm" style="background:${a.colour}">${a.icon}</div>
        <span class="agent-status-name">${a.displayName}</span>
        <span class="agent-status-state${workingClass}" data-status="${a.id}">${statusText}</span>
      </div>`;
    }
  }
  // Available agents
  if (available.length) {
    h += `<div class="sidebar-section-divider" style="cursor:pointer" onclick="document.getElementById('available-agents').classList.toggle('hidden')"><span class="sidebar-label">Available (${available.length}) &#x25BE;</span></div>`;
    h += `<div id="available-agents" class="hidden" style="padding:4px 0">`;
    for (const a of available) {
      const isRaw = a.status === 'raw';
      h += `<div class="agent-status-item" style="${isRaw ? 'opacity:0.6;' : ''}cursor:pointer" onclick="showProfile('${a.id}')">
        <div class="avatar sm" style="background:${a.colour}">${a.icon}</div>
        <div style="flex:1;min-width:0">
          <span class="agent-status-name">${a.displayName}</span>
          <span class="agent-status-desc">${a.description ? a.description.substring(0, 50) : (isRaw ? 'Needs setup' : 'Ready to add')}</span>
        </div>
        ${isRaw
          ? `<button class="agent-action-btn onboard" onclick="event.stopPropagation(); startConversation(getGuide()?.id || 'default')">Setup</button>`
          : `<button class="agent-action-btn add" onclick="event.stopPropagation(); addToTeam('${a.id}')">Add to team</button>`
        }
      </div>`;
    }
    h += `</div>`;
  }
  document.getElementById('agent-list').innerHTML = h;
  // Hide "Your Team" header when only platform agents exist
  const teamHeader = document.getElementById('sidebar-team-header');
  if (teamHeader) teamHeader.style.display = onTeam.length ? '' : 'none';
  renderOrgChart();
  renderConvoEmptyAgents();
}

function renderConvoEmptyAgents() {
  const labelEl = document.getElementById('convo-empty-label');
  const contentEl = document.getElementById('convo-empty-content');
  if (!contentEl) return;

  const teamAgents = getTeamAgents();
  const platformAgents = getPlatformAgents();

  if (teamAgents.length) {
    // Populated workspace: show agent cards
    if (labelEl) { labelEl.textContent = 'Start a conversation'; labelEl.className = 'empty-subtitle'; }

    const agentCard = a =>
      `<div onclick="startConversation('${a.id}')" class="convo-agent-card">
        <div class="avatar" style="background:${a.colour}">${a.icon}</div>
        <span class="convo-agent-card-name">${a.displayName}</span>
        <span class="convo-agent-card-role">${a.role}</span>
      </div>`;

    let h = `<div class="convo-agent-grid">${teamAgents.map(agentCard).join('')}</div>`;
    if (platformAgents.length) {
      h += `<div class="convo-agent-divider"></div>`;
      h += `<div class="convo-agent-grid">${platformAgents.map(agentCard).join('')}</div>`;
    }
    contentEl.className = 'convo-agent-layout';
    contentEl.innerHTML = h;
  } else {
    // Empty workspace: show Doc CTA
    if (labelEl) { labelEl.textContent = 'No team agents yet'; labelEl.className = 'empty-title'; }
    const guide = platformAgents[0];
    contentEl.className = '';
    contentEl.innerHTML = guide
      ? `<div class="sidebar-empty-text" style="text-align:center;max-width:280px;margin:0 auto 8px">Doc can explore this workspace and set up your agent team.</div><button class="empty-cta" style="margin-top:4px" onclick="startSetupConversation()">Set up your team</button>`
      : '';
  }
}

function renderRoutinesSidebar() {
  const container = document.getElementById('sidebar-routines');
  if (!container) return;
  const allRoutines = [];
  for (const a of agents) {
    if (a.routines) {
      for (const r of a.routines) {
        allRoutines.push({ ...r, agentName: a.displayName, agentColour: a.colour, agentIcon: a.icon });
      }
    }
  }
  if (allRoutines.length === 0) { container.innerHTML = ''; return; }

  let h = '<div class="sidebar-section-divider" style="margin:12px 16px 0;padding-top:16px"><span class="sidebar-label">Routines</span></div>';
  h += '<div style="padding:8px 8px 16px">';
  for (const r of allRoutines) {
    const statusText = r.state?.status === 'running'
      ? '<span style="color:var(--working)">Running...</span>'
      : `<span style="color:var(--text-2)">${formatScheduleShort(r.schedule)}</span>`;
    h += `<div class="routine-item">
      <div class="avatar xxs" style="background:${r.agentColour}">${r.agentIcon}</div>
      <span class="routine-name">${esc(r.name)}</span>
      ${statusText}
    </div>`;
  }
  h += '</div>';
  container.innerHTML = h;
}

function addToTeam(agentId) {
  if (ws) ws.send(JSON.stringify({ type: 'add_to_team', agentId }));
}

// ===== 6. ORG CHART =====

// Card dimension presets at 1:1 scale (before scaling)
const ORG_PRESETS = {
  leader:  { w: 280, h: 108, padV: 30, padH: 44, gap: 16, avatar: 64, icon: 28, name: 28, role: 15 },
  normal:  { w: 220, h: 86,  padV: 16, padH: 20, gap: 12, avatar: 40, icon: 18, name: 15, role: 13 },
  compact: { w: 170, h: 67,  padV: 10, padH: 14, gap: 10, avatar: 28, icon: 12, name: 14, role: 12 },
};

// Render a single org card with all dimensions scaled by factor `s`
function orgCardHtml(agent, preset, s, posStyle) {
  const r = (v) => Math.round(v * s);
  const p = ORG_PRESETS[preset];
  const br = Math.round(14 * s);
  const isWorking = getWorkingAgentIds().has(agent.id);
  const dotSize = Math.max(6, r(10));
  const dotClass = isWorking ? 'org-status-dot working' : 'org-status-dot';
  let h = `<div class="org-card ${preset === 'normal' ? '' : preset}" style="${posStyle}width:${r(p.w)}px;height:${r(p.h)}px;padding:${r(p.padV)}px ${r(p.padH)}px;gap:${r(p.gap)}px;border-radius:${br}px" onclick="showProfile('${agent.id}')">`;
  h += `<div class="avatar" style="background:${agent.colour};width:${r(p.avatar)}px;height:${r(p.avatar)}px;font-size:${r(p.icon)}px;flex-shrink:0">${agent.icon}</div>`;
  h += `<div><div class="org-card-name" style="font-size:${r(p.name)}px">${agent.displayName}</div>`;
  h += `<div class="org-card-role" style="font-size:${r(p.role)}px">${agent.role || ''}</div></div>`;
  h += `<span class="${dotClass}" data-org-status="${agent.id}" style="width:${dotSize}px;height:${dotSize}px"></span>`;
  h += `</div>`;
  return h;
}

function renderOrgChart() {
  const orchestrator = agents.find(a => a.status === 'onTeam' && a.type === 'orchestrator');
  const specialists = agents.filter(a => a.status === 'onTeam' && a.type === 'specialist');
  const platformAgents = getPlatformAgents();
  const untyped = agents.filter(a => a.status === 'onTeam' && !a.type);
  const leader = orchestrator || agents.find(a => a.isDefault && a.type) || null;
  const team = specialists.length ? specialists : untyped.filter(a => a !== leader);
  const hasTeam = leader || team.length;

  const chart = document.getElementById('org-chart');
  if (!chart) return;

  // Defer rendering until chart has layout dimensions (e.g. view not yet visible).
  // goHome() calls renderOrgChart() again when the view becomes active.
  if (hasTeam && chart.clientWidth === 0) return;

  // Scale factor: set by tree layout when hasTeam, used by platform section too
  let s = 1;
  let h = '<div class="org-tree">';

  if (hasTeam) {
    // Build tree data: each agent has a parent (reportsTo field, or defaults to orchestrator)
    const allTeam = [];
    if (leader) allTeam.push({ ...leader, _orgParent: null });
    team.forEach(a => {
      const parentId = a.reportsTo || (leader ? leader.id : null);
      allTeam.push({ ...a, _orgParent: parentId });
    });

    // Build d3 hierarchy
    // nodeMap is keyed by both id and name so reportsTo can match either
    const rootData = { id: '__root__', children: [] };
    const nodeMap = new Map();
    allTeam.forEach(a => {
      const node = { ...a, children: [] };
      nodeMap.set(a.id, node);
      if (a.name && a.name !== a.id) nodeMap.set(a.name, node);
    });
    allTeam.forEach(a => {
      if (a._orgParent && nodeMap.has(a._orgParent)) {
        nodeMap.get(a._orgParent).children.push(nodeMap.get(a.id));
      } else {
        // No parent, OR a reportsTo that doesn't resolve to a team member
        // (a typo, or reporting to a platform agent like Doc): attach at
        // the root. An on-team agent must always be visible in the chart;
        // silently dropping it made the chart lay out an empty tree at a
        // degenerate zoom when such an agent was the whole team.
        rootData.children.push(nodeMap.get(a.id));
      }
    });

    const treeRoot = rootData.children.length === 1 ? rootData.children[0] : rootData;
    const isCompact = team.length > 10;
    const preset = isCompact ? 'compact' : 'normal';
    const P = ORG_PRESETS;

    // d3 layout at full scale (1:1 spacing)
    const nodeW = isCompact ? 220 : 280;
    const nodeH = isCompact ? 160 : 190;
    const hierarchy = d3.hierarchy(treeRoot);
    d3.tree().nodeSize([nodeW, nodeH])(hierarchy);

    const cardW = (n) => Math.min(n.data.type === 'orchestrator' ? P.leader.w : P[preset].w, 320);
    const cardH = (n) => n.data.type === 'orchestrator' ? P.leader.h : P[preset].h;

    // Get bounds of d3 node centres
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    hierarchy.each(n => {
      if (n.data.id === '__root__') return;
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    });

    // Full-scale tree dimensions (centre-to-edge + padding)
    const pad = 20;
    const halfMaxCard = Math.max(P.leader.w, P[preset].w) / 2;
    const fullW = (maxX - minX) + halfMaxCard * 2 + pad * 2;
    const fullH = (maxY - minY) + P.leader.h + P[preset].h + pad * 2;

    // Compute scale: auto-fit viewport, then apply user zoom offset
    const chartW = chart.clientWidth - 64;
    const chartH = chart.clientHeight - 64;
    const fitScale = Math.min(chartW / fullW, chartH / fullH, 1);
    s = Math.max(0.15, Math.min(2, fitScale + orgZoomOffset));

    // Scaled coordinate helpers
    const r = (v) => Math.round(v * s);
    const sx = (x) => Math.round((x - minX + halfMaxCard + pad) * s);
    const sy = (y) => Math.round((y - minY + pad) * s);
    const totalW = r(fullW);
    const totalH = r(fullH);

    h += `<div class="org-layout" style="width:${totalW}px;height:${totalH}px">`;
    h += `<svg class="org-connectors" width="${totalW}" height="${totalH}"><g>`;

    // Build parent-children groups for connectors
    const parentGroups = new Map();
    hierarchy.each(n => {
      if (n.data.id === '__root__' || !n.parent || n.parent.data.id === '__root__') return;
      const pid = n.parent.data.id;
      if (!parentGroups.has(pid)) parentGroups.set(pid, { parent: n.parent, children: [] });
      parentGroups.get(pid).children.push(n);
    });
    hierarchy.each(n => {
      if (n.parent && n.parent.data.id !== '__root__') return;
      if (!n.children || n.data.id === '__root__') return;
      const pid = n.data.id;
      if (!parentGroups.has(pid)) parentGroups.set(pid, { parent: n, children: [] });
      n.children.forEach(c => {
        if (c.data.id !== '__root__') parentGroups.get(pid).children.push(c);
      });
    });

    parentGroups.forEach(({ parent: p, children: kids }) => {
      if (kids.length === 0) return;
      const px = sx(p.x);
      const srcBottom = sy(p.y) + r(cardH(p));
      const ty = sy(kids[0].y);
      const midY = srcBottom + Math.round((ty - srcBottom) / 2);

      h += `<path d="M${px},${srcBottom} L${px},${midY}"/>`;
      const childXs = kids.map(c => sx(c.x));
      if (kids.length > 1) {
        h += `<path d="M${Math.min(...childXs)},${midY} L${Math.max(...childXs)},${midY}"/>`;
      }
      kids.forEach(c => {
        h += `<path d="M${sx(c.x)},${midY} L${sx(c.x)},${sy(c.y)}"/>`;
      });
    });

    h += '</g></svg>';

    // Place cards at computed positions
    hierarchy.each(n => {
      if (n.data.id === '__root__') return;
      const isLeader = n.data.type === 'orchestrator';
      const p = isLeader ? 'leader' : preset;
      h += orgCardHtml(n.data, p, s, `left:${sx(n.x)}px;top:${sy(n.y)}px;`);
    });

    h += '</div>'; // close .org-layout

    // Set scroll/centering after DOM update
    requestAnimationFrame(() => {
      const overflowX = fullW * s > chartW;
      const overflowY = fullH * s > chartH;
      chart.style.overflowX = overflowX ? 'auto' : 'hidden';
      chart.style.overflowY = overflowY ? 'auto' : 'hidden';
      chart.style.justifyContent = overflowY ? 'flex-start' : 'center';
      chart.style.alignItems = overflowX ? 'flex-start' : 'center';
      if (overflowX) chart.scrollLeft = Math.max(0, (totalW - chart.clientWidth) / 2);
      if (overflowY) chart.scrollTop = Math.max(0, (totalH - chart.clientHeight) / 2);
    });

  } else {
    const guide = platformAgents[0];
    const a = workspaceAnalysis;
    const hasContext = a && (a.identity.sources.length > 0 || a.skills.total > 0);

    if (hasContext && a) {
      h += '<div class="org-empty-state">';
      // Identity: show workspace name from analysis, fall back to folder name
      const identityName = a.identity.suggestedName || currentWorkspacePath?.split('/').pop() || 'Your Workspace';
      const tagline = a.identity.suggestedTagline || a.identity.suggestedRole || 'Ready to set up your team';
      h += `<div class="empty-title" style="font-size:var(--heading)">${esc(identityName)}</div>`;
      h += `<div style="color:var(--text-2);font-size:var(--body);margin-bottom:12px">${esc(tagline)}</div>`;
      // Stats line
      const stats = [];
      if (a.skills.total > 0) stats.push(`${a.skills.total} skill${a.skills.total !== 1 ? 's' : ''}`);
      if (a.structure.pattern !== 'unknown') {
        const acronyms = new Set(['para']);
        const patternLabel = a.structure.pattern.split('-').map(w => acronyms.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        stats.push(patternLabel);
      }
      const integrationCount = a.integrations.mcpReferences.length + a.integrations.configuredServers.length + a.integrations.mentionedTools.length;
      if (integrationCount > 0) stats.push(`${integrationCount} integration${integrationCount !== 1 ? 's' : ''}`);
      if (stats.length) h += `<div style="color:var(--text-2);font-size:var(--caption);margin-bottom:16px">${stats.join(' &middot; ')}</div>`;
      if (guide) {
        h += `<button class="empty-cta" style="margin-top:12px" onclick="startSetupConversation()">Set up your team</button>`;
      }
      h += '</div>';
    } else {
      h += '<div class="org-empty-state">';
      h += '<div class="empty-title">Welcome to Rundock</div>';
      h += '<div class="sidebar-empty-text" style="text-align:center;max-width:320px">Fresh workspace. Doc can help you set up your agent team from scratch.</div>';
      if (guide) {
        h += `<button class="empty-cta" style="margin-top:4px" onclick="startSetupConversation()">Set up your team</button>`;
      }
      h += '</div>';
    }
    chart.style.overflow = 'hidden';
    chart.style.justifyContent = 'center';
    chart.style.alignItems = 'center';
  }

  // Platform section: scaled to match specialist cards
  if (platformAgents.length) {
    const r = (v) => Math.round(v * s);
    h += `<div class="org-platform-section" style="margin-top:${r(hasTeam ? 24 : 32)}px">`;
    h += `<div class="org-platform-divider" style="max-width:${r(200)}px;margin-bottom:${r(24)}px"></div>`;
    h += `<div class="org-platform-label" style="font-size:${r(12)}px;margin-bottom:${r(16)}px">Rundock Agents</div>`;
    h += `<div style="display:flex;justify-content:center;gap:${r(12)}px">`;
    for (const a of platformAgents) {
      h += orgCardHtml(a, 'normal', s, '');
    }
    h += '</div></div>';
  }

  h += '</div>'; // close .org-tree

  // Zoom controls (only when there's a team to zoom)
  if (hasTeam) {
    h += '<div class="org-zoom">';
    h += '<button onclick="orgZoom(1)" title="Zoom in">+</button>';
    h += '<div class="org-zoom-divider"></div>';
    h += '<button onclick="orgZoom(-1)" title="Zoom out">&minus;</button>';
    h += '</div>';
  }

  chart.innerHTML = h;
}

function orgZoom(dir) {
  orgZoomOffset += dir * 0.1;
  renderOrgChart();
}

// Debounced resize: reset zoom and re-render
let _orgResizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(_orgResizeTimer);
  _orgResizeTimer = setTimeout(() => { orgZoomOffset = 0; renderOrgChart(); }, 150);
});

// ===== 7. AGENT PROFILE =====

function showProfile(agentId) {
  const a=agents.find(x=>x.id===agentId); if(!a) return;
  // Agent profiles belong to the Team section (the profile's back link goes
  // there); sync the rail and sidebar for callers arriving from elsewhere,
  // e.g. the search palette or a skill page's agent chips.
  setNavState('team');
  const existing=conversations.filter(c=>c.agentId===agentId||(c.sessionIds||[]).some(s=>s.agentId===agentId));
  let h=`<a class="profile-back" onclick="switchNav('team')">&#8592; Back</a>
    <div class="profile-header">
      <div class="profile-avatar" style="background:${a.colour}">${a.icon}</div>
      <div>
        <div class="profile-name">${a.displayName}</div>
        ${a.role?`<div style="font-size:var(--body);color:var(--text-2)">${a.role}</div>`:''}
      </div>
    </div>`;
  if(a.description) h+=`<p class="profile-desc" style="margin-bottom:24px">${esc(a.description)}</p>`;
  if(a.status === 'raw') {
    h+=`<div class="profile-cta"><button class="profile-cta-btn" onclick="startConversation(getGuide()?.id || 'default')">Setup with Doc</button></div>`;
  } else if(a.status === 'available') {
    h+=`<div class="profile-cta"><button class="profile-cta-btn" onclick="addToTeam('${a.id}')">Add to team</button></div>`;
  } else {
    h+=`<div class="profile-cta"><button class="profile-cta-btn" onclick="startConversation('${a.id}')">New conversation</button></div>`;
  }
  // Capabilities card
  if(a.capabilities) {
    const c = a.capabilities;
    h+=`<div class="profile-card">`;
    // Split on commas that are NOT inside parentheses, so phrase/parenthetical
    // entries (e.g. "Reddit (r/ClaudeAI, r/LocalLLaMA)") stay on one line.
    const splitCaps = s => s.split(/,(?![^(]*\))/).map(x => x.trim()).filter(Boolean);
    if(c.does) h+=`<div class="profile-card-section"><div class="profile-section-label">What ${esc((a.displayName||'').trim())} does</div><div class="profile-card-text">${esc(c.does)}</div></div>`;
    if(c.reads) h+=`<div class="profile-card-section"><div class="profile-section-label">Reads from</div>${splitCaps(c.reads).map(r=>`<div class="profile-card-item">${esc(r)}</div>`).join('')}</div>`;
    if(c.writes) h+=`<div class="profile-card-section"><div class="profile-section-label">Writes to</div>${splitCaps(c.writes).map(w=>`<div class="profile-card-item">${esc(w)}</div>`).join('')}</div>`;
    h+=`</div>`;
  }
  // Skills card
  const agentSkills = skills.filter(s => s.assignedAgents.some(aa => aa.id === a.id));
  if(agentSkills.length) {
    h+=`<div class="profile-card"><div class="profile-card-section"><div class="profile-section-label">Skills</div>`;
    for(const s of agentSkills) {
      h+=`<div class="profile-card-item" style="display:flex;flex-direction:column;gap:2px;cursor:pointer" onclick="switchNav('skills');selectSkill('${s.id}')">
        <span style="font-weight:600">${esc(s.name)}</span>
        ${s.description ? `<span style="font-size:var(--caption);color:var(--text-2)">${esc(s.description)}</span>` : ''}
      </div>`;
    }
    h+=`</div></div>`;
  }
  // Routines + Configuration card. Always rendered: the Runtime row appears
  // for every agent, so the card always has content.
  const hasRoutines = a.routines && a.routines.length;
  const hasConnectors = a.capabilities?.connectors;
  {
    h+=`<div class="profile-card">`;
    if(hasRoutines) {
      h+=`<div class="profile-card-section"><div class="profile-section-label">Routines</div>`;
      for(const r of a.routines) {
        const stateText = r.state ? (r.state.status === 'running' ? '<span style="color:var(--working)">Running now</span>' : `Last run: ${formatTimeAgo(r.state.lastRun)} (${r.state.status})`) : '<span style="color:var(--text-2)">Not yet run</span>';
        h+=`<div class="profile-card-item" style="display:flex;flex-direction:column;gap:3px">
          <span style="font-weight:600">${esc(r.name)}</span>
          <span style="font-size:var(--caption);color:var(--text-2)">${esc(r.schedule)}</span>
          <span style="font-size:var(--caption)">${stateText}</span>
        </div>`;
      }
      h+=`</div>`;
    }
    if(hasConnectors) {
      h+=`<div class="profile-card-section"><div class="profile-section-label">Connectors</div>${a.capabilities.connectors.split(',').map(cn=>`<div class="profile-card-item" style="display:flex;align-items:center;justify-content:space-between">${cn.trim()}<span style="color:var(--success);font-size:var(--caption)">Connected</span></div>`).join('')}</div>`;
    }
    const modelLabels = {opus:'Opus (most capable)',sonnet:'Sonnet (fast, efficient)',haiku:'Haiku (lightweight)'};
    if(a.model) h+=`<div class="profile-card-section"><div class="profile-section-label">Model</div><div class="profile-card-item">${modelLabels[a.model]||a.model}</div></div>`;
    // Runtime is stated for every agent, not just Codex ones, so it reads as
    // a fact about the agent rather than a special mark.
    h+=`<div class="profile-card-section"><div class="profile-section-label">Runtime</div><div class="profile-card-item">${a.runtime === 'codex' ? 'Codex' : 'Claude Code'}</div></div>`;
    if(a.runtime === 'codex') h+=`<div class="profile-card-section"><div class="profile-section-label">Permissions</div><div class="profile-card-text">${esc(a.displayName)} runs on Codex and uses Codex's built-in sandbox. Claude agents use Rundock's permission prompts.</div></div>`;
    h+=`</div>`;
  }
  // Instructions card (collapsible)
  if(a.instructions) h+=`<div class="profile-card" style="cursor:pointer" onclick="document.getElementById('agent-instructions').classList.toggle('hidden')">
    <div class="profile-card-section"><div class="profile-section-label">Instructions ▾</div>
    <div id="agent-instructions" class="hidden"><div style="font-size:var(--caption);line-height:1.6;white-space:pre-wrap;max-height:400px;overflow-y:auto;color:var(--text-2);padding-top:8px">${esc(a.instructions)}</div></div>
    </div></div>`;
  // Existing conversations (rendered last so the page reads as a profile first,
  // conversation index second; preserves the hide-when-empty guard).
  if(existing.length) {
    h+=`<div class="profile-existing"><div class="profile-section-label">Existing conversations</div>`;
    for(const c of existing) {
      const n = c.messageCount ?? c.messages.length;
      h+=`<div class="profile-existing-item" onclick="openConversation('${c.id}')"><span class="profile-existing-title">${esc(c.title)}</span><span class="profile-existing-meta">${n} message${n === 1 ? '' : 's'}</span></div>`;
    }
    h+=`</div>`;
  }
  document.getElementById('profile-content').innerHTML=h;
  showView('profile');
  // Highlight in sidebar
  document.querySelectorAll('.agent-status-item').forEach(el=>el.classList.remove('active'));
  document.querySelector(`[data-agent="${agentId}"]`)?.classList.add('active');
}

// ===== 8. CONVERSATIONS =====

// Persist conversation metadata to server (never message content)
function persistConversation(convo) {
  if (!ws || !convo) return;
  const state = convoState[convo.id];
  ws.send(JSON.stringify({
    type: 'save_conversation',
    conversation: {
      id: convo.id,
      agentId: convo.agentId,
      activeAgentId: state?.activeAgentId || null,
      sessionId: convo.sessionId || null,
      sessionIds: convo.sessionIds || [],
      title: convo.title,
      status: convo.status,
      pinned: convo.pinned || false,
      pinnedAt: convo.pinnedAt || null,
      listIds: convo.listIds || [],
      createdAt: convo.createdAt || new Date().toISOString()
    }
  }));
}

// Merge persisted conversations with in-memory list on workspace load
function handlePersistedConversations(persisted, persistedLastActiveId) {
  if (!persisted || !Array.isArray(persisted)) return;
  conversationsLoaded = true;
  // Seed the in-memory cache before we run the priority chain so the
  // last-opened lookup in pickDefaultConversation has a value to find.
  if (persistedLastActiveId !== undefined) lastActiveConversationId = persistedLastActiveId;
  for (const entry of persisted) {
    // Skip if already in memory (from current session)
    if (conversations.find(c => c.id === entry.id)) continue;
    // Resolve agent object (may have been deleted)
    const agent = agents.find(a => a.id === entry.agentId);
    const convo = {
      id: entry.id,
      agentId: entry.agentId,
      agent: agent || { id: entry.agentId, displayName: entry.agentId, colour: 'var(--text-3)', icon: '?', prompts: [] },
      title: entry.title || 'Untitled',
      messages: [],  // No message content persisted; resume via sessionId
      status: entry.status || 'archived',
      sessionId: entry.sessionId || null,
      sessionIds: entry.sessionIds || [],
      pinned: entry.pinned || false,
      pinnedAt: entry.pinnedAt || null,
      listIds: entry.listIds || [],
      createdAt: entry.createdAt,
      lastActiveAt: entry.lastActiveAt,
      lastAgentId: entry.lastAgentId || null,
      lastMessagePreview: entry.lastMessagePreview || null,
      messageCount: entry.messageCount,  // Server-enriched count; client falls back to messages.length when undefined
      persisted: true  // Flag: this was loaded from disk, has no in-memory messages
    };
    conversations.push(convo);
    // Restore active agent from server-enriched data (transcript-based)
    if (entry.activeAgentId) {
      const state = getConvoState(convo.id);
      state.activeAgentId = entry.activeAgentId;
      if (entry.activeAgentId !== entry.agentId) state.delegationActive = true;
    }
  }
  renderConvoList();

  // Now that conversations are loaded, reconcile any active processes from a reconnect.
  // Always run this, even if active_processes was empty or never received, to clean stale state.
  handleActiveProcesses(pendingActiveProcesses || []);
  pendingActiveProcesses = null;

  // Auto-navigate: processing > last-opened > most-recently-active > workspace routing
  const target = pickDefaultConversation();
  if (target) {
    openConversation(target.id);
    switchNav('conversations');
  } else if (!activeConversation) {
    // Workspace routing: setup incomplete → has agents → has context → fallback
    const teamAgents = getTeamAgents();
    const a = workspaceAnalysis;
    const hasContext = a && (a.identity.sources.length > 0 || a.skills.total > 0);

    if (teamAgents.length > 0) {
      // Path A: configured workspace with agents, go straight to conversations
      newConversation();
    } else if (hasContext) {
      // Path B: existing workspace with files/agents/skills but not yet Rundock-configured
      switchNav('team');
    } else if (!setupComplete) {
      // Path C: empty/new workspace, start Doc conversation directly
      startSetupConversation();
    } else {
      newConversation();
    }
  }

  // Request buffered messages now that conversations and state are ready
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'flush_buffer' }));
  }
}

function createConversation(agentId, title) {
  const agent = agents.find(a => a.id === agentId) || agents[0];
  const convo = { id: Date.now().toString(), agentId: agent.id, agent, title: title || `Chat with ${agent.displayName}`, messages: [], status: 'active', createdAt: new Date().toISOString() };
  conversations.unshift(convo);
  activeConversation = convo;
  // Don't persist yet: conversation is saved on first message send (lazy creation)
  renderConvoList();
  setupChat(convo);
  document.getElementById('messages').innerHTML = '';
  switchNav('conversations');
  showView('chat');
  return convo;
}

// One-time disclosure when the user starts their first conversation with a
// Codex agent: the permission model differs from Claude agents and that is
// stated plainly at the moment it matters. Shown once per agent, ever
// (persisted on render, not on dismiss, so ignoring it doesn't nag later).
function maybeShowCodexFirstRun(agent) {
  if (!agent || agent.runtime !== 'codex') return;
  const key = 'rundock:codexFirstRun:' + agent.id;
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
  } catch (e) { return; }
  const m = document.getElementById('messages');
  if (!m) return;
  const el = document.createElement('div');
  el.className = 'codex-firstrun-card';
  el.innerHTML =
    `<div class="codex-firstrun-title">Running on Codex</div>` +
    `<div>${esc(agent.displayName)} runs on Codex and uses Codex's built-in sandbox, so you will not see Rundock's permission prompts in this conversation. Files outside this workspace stay protected by the sandbox.</div>` +
    `<button class="codex-firstrun-dismiss" onclick="this.closest('.codex-firstrun-card').remove()">Got it</button>`;
  m.appendChild(el);
}

function startConversation(agentId) {
  // Same principle as openConversation: starting a conversation navigates
  // to the Conversations section regardless of origin (agent profile, org
  // chart, empty states).
  setNavState('conversations');
  const convo = createConversation(agentId);
  const agent = convo.agent;

  if (agent.prompts && agent.prompts.length) {
    // Standard prompt pills for non-Path-C conversations
    let h=`<div id="chat-prompts" class="chat-prompts">`;
    h+=`<div class="chat-prompts-avatar avatar" style="background:${agent.colour};width:56px;height:56px;font-size:24px">${agent.icon}</div>`;
    h+=`<div class="chat-prompts-title">How can I help?</div>`;
    h+=`<div class="chat-prompts-list">`;
    for(const p of agent.prompts) {
      h+=`<button class="prompt-pill" data-prompt="${escAttr(p)}">${esc(p)}</button>`;
    }
    h+=`</div></div>`;
    document.getElementById('messages').innerHTML=h;
  }

  // After any placeholder content: the one-time Codex disclosure card.
  maybeShowCodexFirstRun(agent);
}

// Start a Doc conversation with workspace analysis pre-loaded
function startSetupConversation() {
  const guide = agents.find(a => a.type === 'platform');
  if (!guide || !workspaceAnalysis) { startConversation(guide?.id || 'default'); return; }
  const a = workspaceAnalysis;

  // Build the analysis block
  let block = '[WORKSPACE_ANALYSIS]\n';
  // Identity
  const readme = a.identity.sources.find(s => s.file === 'README.md');
  const claude = a.identity.sources.find(s => s.file === 'CLAUDE.md');
  if (readme) block += `Identity: ${a.identity.suggestedName || 'Unknown'} -- "${a.identity.suggestedTagline || a.identity.suggestedRole || ''}" (README.md)\n`;
  if (claude?.identity) block += `Technical identity: "${claude.identity}" (CLAUDE.md)\n`;
  // Skills
  if (a.skills.total > 0) {
    block += `Skills: ${a.skills.total} found, grouped as:\n`;
    for (const g of a.skills.groups) {
      const note = g.label === 'System & Setup' ? ' (assign to orchestrator or exclude)' : '';
      block += `  - ${g.label}: ${g.slugs.join(', ')}${note}\n`;
    }
  } else {
    block += 'Skills: none found\n';
  }
  // Integrations (deduplicated, case-insensitive)
  const seen = new Set();
  const allIntegrations = [
    ...a.integrations.mcpReferences.map(m => m.name),
    ...a.integrations.configuredServers,
    ...a.integrations.mentionedTools
  ].filter(name => {
    const key = name.toLowerCase().replace(/\s+mcp$/i, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (allIntegrations.length) block += `Integrations: ${allIntegrations.join(', ')}\n`;
  // Structure
  if (a.structure.pattern !== 'unknown') {
    block += `Structure: ${a.structure.pattern} (${a.structure.topLevelDirs.join(', ')})\n`;
    const paths = Object.entries(a.structure.keyPaths).map(([k,v]) => `${k}=${v}`);
    if (paths.length) block += `Key paths: ${paths.join(', ')}\n`;
  }
  // User profile
  if (a.userProfile.exists) {
    block += a.userProfile.populated
      ? `User profile: ${a.userProfile.fields.name || 'unknown'}, ${a.userProfile.fields.role || 'unknown role'}\n`
      : 'User profile: exists but not populated\n';
  }
  // Hooks
  if (a.hooks.contextHooks.length) block += `Hooks: context injection (${a.hooks.contextHooks.map(h => h.name).join(', ')})\n`;
  if (a.hooks.soundHooks.length) block += `Sound hooks: ${a.hooks.soundHooks.length} (auto-muted for Rundock)\n`;
  // Agents
  const nonPlatform = a.agents.list.filter(ag => ag.type !== 'platform');
  if (nonPlatform.length) {
    block += `Existing agents: ${nonPlatform.map(ag => `${ag.displayName} (${ag.status})`).join(', ')}\n`;
  } else {
    block += 'Existing agents: none (Doc only)\n';
  }
  if (!setupComplete) {
    block += 'New workspace: true (scaffolded defaults, user has not seen folder structure yet)\n';
  }
  block += `Workspace mode: ${workspaceMode}\n`;
  block += '[/WORKSPACE_ANALYSIS]\n\n';
  const markerReminder = ' CRITICAL: when creating agents, you MUST use <!-- RUNDOCK:SAVE_AGENT name={slug} --> markers. Without them, agents are not created.';
  if (!setupComplete && workspaceMode === 'code') {
    block += 'This is a new CODE workspace. Start with Beat 0: ask the user their name and what they will use the workspace for. After they respond, skip Beat 1 (the scaffolded folders are generic defaults, not relevant for a code project) and go straight to Beat 2 (team proposal). Propose dev-oriented agents suited to the codebase.' + markerReminder;
  } else if (!setupComplete) {
    block += 'This is a new workspace. Start with Beat 0: ask the user their name and what they will use the workspace for. After they respond, continue to Beat 1 (folder orientation), then Beat 2 (team proposal). Do NOT skip any beats.' + markerReminder;
  } else {
    block += 'Propose an agent team for this workspace. Do NOT create agents yet. Show me the team plan first, then I will confirm.' + markerReminder;
  }

  // Start conversation with custom title (isSetup prevents title override on first user message)
  const convo = createConversation(guide.id, `${a.identity.suggestedName || 'Workspace'} Team Setup`);
  convo.isSetup = true;

  // Show a system-level status line (not a user or agent message)
  const summaryParts = [];
  if (a.identity.suggestedName) summaryParts.push(a.identity.suggestedName + (a.identity.suggestedTagline ? ': ' + a.identity.suggestedTagline : ''));
  if (a.skills.total > 0) summaryParts.push(`${a.skills.total} skills in ${a.skills.groups.length} groups`);
  const integrationCount = a.integrations.mcpReferences.length + a.integrations.configuredServers.length + a.integrations.mentionedTools.length;
  if (integrationCount > 0) summaryParts.push(`${integrationCount} integrations`);
  addSystemMsg(summaryParts.length ? 'Analysing workspace: ' + summaryParts.join(' · ') : 'Setting up your agent team...');
  // Store as 'system' role so it won't replay as a user bubble if conversation re-renders
  convo.messages.push({ role: 'system', content: block });

  // Send the full analysis to Doc (but don't display it)
  startProcessing(convo.id);
  const chatMsg = { type: 'chat', content: block, agent: convo.agentId, conversationId: convo.id };
  if (convo.sessionId) chatMsg.sessionId = convo.sessionId;
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(chatMsg));
  persistConversation(convo);
}

function sendPrompt(text) {
  const el=document.getElementById('chat-prompts'); if(el) el.remove();
  document.getElementById('msg-input').value=text;
  sendMessage();
}
function newConversation() {
  const guide = getGuide();
  const orchestrator = agents.find(a => a.status === 'onTeam' && a.type === 'orchestrator');
  const teamAgents = getTeamAgents();
  // Empty workspace (only Doc): start with guide
  if (!teamAgents.length && guide) { startConversation(guide.id); return; }
  // Orchestrator exists: start with orchestrator
  if (orchestrator) {
    startConversation(orchestrator.id);
    return;
  }
  // Team agents, no orchestrator: show agent picker
  showView('convo-empty');
}
function setupChat(convo) {
  const state = getConvoState(convo.id);
  const activeId = state?.activeAgentId;
  const agent = (activeId && agents.find(a => a.id === activeId)) || convo.agent;
  document.getElementById('chat-title-input').value=convo.title;
  document.getElementById('chat-agent-label').textContent=agent.displayName;
  document.getElementById('chat-agent-avatar').style.background=agent.colour;
  document.getElementById('chat-agent-avatar').textContent=agent.icon;
  const msgInput = document.getElementById('msg-input');
  msgInput.placeholder=`Message ${agent.displayName}...`;
  msgInput.style.height = 'auto';
  msgInput.style.height = '44px';
  const statusEl=document.getElementById('chat-convo-status');
  const isArchivedSet = convo.status === 'archived';
  statusEl.querySelector('.state-label').textContent = isArchivedSet ? 'Archived' : 'Active';
  statusEl.querySelector('.action-label').textContent = isArchivedSet ? '↺ Unarchive' : '→ Archive';
  statusEl.className = `chat-convo-status ${isArchivedSet ? 'archived-convo' : 'active-convo'}`;
  // Set input state based on this conversation's processing state
  msgInput.disabled = state.isProcessing;
  const sendBtn = document.getElementById('send-btn');
  if (state.isProcessing) {
    sendBtn.disabled = false;
    sendBtn.classList.add('cancel');
    sendBtn.classList.remove('active');
    sendBtn.onclick = cancelProcessing;
    sendBtn.title = 'Stop agent';
    sendBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
  } else {
    sendBtn.disabled = false;
    sendBtn.classList.remove('cancel');
    sendBtn.onclick = sendMessage;
    sendBtn.title = 'Send message';
    sendBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
    msgInput.focus();
  }
}
function renameConversation(newTitle) {
  if(activeConversation && newTitle.trim()) {
    activeConversation.title=newTitle.trim();
    persistConversation(activeConversation);
    renderConvoList();
  }
}
function deleteConversation(id, evt) {
  evt.stopPropagation(); // Don't open the conversation
  conversations = conversations.filter(c => c.id !== id);
  delete convoState[id];
  unreadConvos.delete(id);
  workingConvos.delete(id);
  updateUnreadBadge();
  if (activeConversation?.id === id) {
    activeConversation = null;
    const target = pickDefaultConversation();
    if (target) { openConversation(target.id); } else { newConversation(); }
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'delete_conversation', id }));
  }
  renderConvoList();
}
// Archive a conversation from the sidebar. The action is the primary triage
// affordance for persisted (not-yet-archived, not-pinned) conversations: it
// moves the row out of the main list into the Archived section, where the
// soft-delete affordance lives. Mirrors the lifecycle Active -> Archived ->
// Delete.
function archiveConversation(id, evt) {
  evt.stopPropagation(); // Don't open the conversation
  const convo = conversations.find(c => c.id === id);
  if (!convo || convo.status === 'archived') return;
  convo.status = 'archived';
  convo.lastActiveAt = new Date().toISOString();
  persistConversation(convo);
  renderConvoList();
}

function togglePin(id, evt) {
  evt.stopPropagation();
  const convo = conversations.find(c => c.id === id);
  if (!convo) return;
  convo.pinned = !convo.pinned;
  convo.pinnedAt = convo.pinned ? new Date().toISOString() : null;
  persistConversation(convo);
  renderConvoList();
}
function toggleConvoStatus() {
  if(!activeConversation) return;
  activeConversation.status = activeConversation.status === 'archived' ? 'active' : 'archived';
  const isArchivedToggled = activeConversation.status === 'archived';
  const statusEl = document.getElementById('chat-convo-status');
  statusEl.querySelector('.state-label').textContent = isArchivedToggled ? 'Archived' : 'Active';
  statusEl.querySelector('.action-label').textContent = isArchivedToggled ? '↺ Unarchive' : '→ Archive';
  statusEl.className = `chat-convo-status ${isArchivedToggled ? 'archived-convo' : 'active-convo'}`;
  persistConversation(activeConversation);
  renderConvoList();
}
// WhatsApp-style recency label. Same calendar day → HH:MM (24h). Yesterday →
// "Yesterday". 2-6 days ago → day name. 7+ days → DD/MM/YYYY. Returns "" for
// missing/invalid timestamps so the caller renders an empty label without a
// conditional.
function formatRecency(iso) {
  if (!iso) return '';
  const ts = new Date(iso);
  if (Number.isNaN(ts.getTime())) return '';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tsDay = new Date(ts.getFullYear(), ts.getMonth(), ts.getDate());
  const diff = Math.round((today - tsDay) / 86400000);
  if (diff === 0) {
    const hh = String(ts.getHours()).padStart(2, '0');
    const mm = String(ts.getMinutes()).padStart(2, '0');
    return hh + ':' + mm;
  }
  if (diff === 1) return 'Yesterday';
  if (diff < 7) {
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    return days[ts.getDay()];
  }
  const d = String(ts.getDate()).padStart(2, '0');
  const m = String(ts.getMonth() + 1).padStart(2, '0');
  return d + '/' + m + '/' + ts.getFullYear();
}

// Left-border colour class for a convo row.
function convoBorderClass(c) {
  // Left border carries the unread/working signal only. Pinned-ness is
  // conveyed by list position + the title-row pin glyph (WhatsApp model), so
  // a pinned+unread conversation no longer has to pick one colour.
  if (workingConvos.has(c.id) || unreadConvos.has(c.id)) return 'b-unread';
  return '';
}

// Switch the active sidebar pill filter and re-render. Reset to 'all' on
// workspace switch via onWorkspaceReady. Pills are 'all', 'unread', or
// 'list:<id>' (user-created lists render as pills after Unread).
function setSidebarPill(pill) {
  activeSidebarPill = pill;
  ['all','unread'].forEach(p => {
    document.getElementById('pill-' + p)?.classList.toggle('active', p === pill);
  });
  document.querySelectorAll('#sidebar-pills .pill-list').forEach(el => {
    el.classList.toggle('active', el.dataset.pill === pill);
  });
  renderConvoList();
}

// Render the user-created list pills after the fixed All | Unread pair.
// Right-click a list pill to delete the list (conversations are never
// deleted with it; they just leave the grouping).
function renderListPills() {
  const wrap = document.getElementById('sidebar-pills');
  if (!wrap) return;
  wrap.querySelectorAll('.pill-list').forEach(el => el.remove());
  for (const l of convoLists) {
    const btn = document.createElement('button');
    btn.className = 'pill pill-list' + ('list:' + l.id === activeSidebarPill ? ' active' : '');
    btn.dataset.pill = 'list:' + l.id;
    btn.textContent = l.name;
    btn.onclick = () => setSidebarPill('list:' + l.id);
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openConvoMenu(e, [{ label: `Delete list "${l.name}"`, action: () => ws.send(JSON.stringify({ type: 'delete_list', id: l.id })) }], btn);
    });
    wrap.appendChild(btn);
  }
}

// Minimal shared context menu (positioned card, closes on any click or Esc).
// Items: [{ label, action, checked? }] plus an optional inline input row via
// { input: true, placeholder, onSubmit }. Positioning: at the pointer for
// row context menus, or anchored below an element (dropdown-style) when
// anchorEl is passed, so the menu never covers its own trigger.
function openConvoMenu(evt, items, anchorEl) {
  closeConvoMenu();
  const menu = document.createElement('div');
  menu.id = 'convo-context-menu';
  menu.className = 'convo-menu';
  menu.style.visibility = 'hidden';
  for (const item of items) {
    if (item.input) {
      // Small-input composer pattern (the review-input grammar): submit via
      // Enter or the in-field circular button, which activates with content.
      const row = document.createElement('div');
      row.className = 'convo-menu-input';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = item.placeholder || '';
      input.maxLength = 60;
      const send = document.createElement('button');
      send.className = 'convo-menu-send';
      send.disabled = true;
      send.title = 'Create';
      send.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';
      const submit = () => { if (input.value.trim()) { item.onSubmit(input.value.trim()); closeConvoMenu(); } };
      input.oninput = () => {
        const hasText = !!input.value.trim();
        send.disabled = !hasText;
        send.classList.toggle('active', hasText);
      };
      input.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') submit();
        if (e.key === 'Escape') closeConvoMenu();
      };
      input.onclick = (e) => e.stopPropagation();
      send.onclick = (e) => { e.stopPropagation(); submit(); };
      row.appendChild(input);
      row.appendChild(send);
      menu.appendChild(row);
    } else {
      const row = document.createElement('button');
      row.className = 'convo-menu-item';
      row.innerHTML = `<span class="convo-menu-check">${item.checked ? '✓' : ''}</span>${esc(item.label)}`;
      row.onclick = (e) => { e.stopPropagation(); item.action(); closeConvoMenu(); };
      menu.appendChild(row);
    }
  }
  document.body.appendChild(menu);
  // Position (clamped to the viewport), then reveal: anchored menus sit
  // below their trigger's left edge with a 4px gap; pointer menus open at
  // the cursor.
  const r = menu.getBoundingClientRect();
  let x, y;
  if (anchorEl) {
    const a = anchorEl.getBoundingClientRect();
    x = a.left;
    y = a.bottom + 4;
    if (y + r.height > window.innerHeight - 8) y = Math.max(8, a.top - r.height - 4); // flip above if no room
  } else {
    x = evt.clientX;
    y = evt.clientY;
  }
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  menu.style.visibility = '';
  menu.querySelector('input')?.focus();
  setTimeout(() => {
    document.addEventListener('click', closeConvoMenu, { once: true });
    document.addEventListener('keydown', convoMenuEsc);
  }, 0);
}
function convoMenuEsc(e) { if (e.key === 'Escape') closeConvoMenu(); }
function closeConvoMenu() {
  document.getElementById('convo-context-menu')?.remove();
  document.removeEventListener('keydown', convoMenuEsc);
}

// Right-click menu on a conversation row: toggle membership per list plus
// create-and-add via the inline input. Membership is many-to-many.
function openConvoListMenu(evt, convoId) {
  evt.preventDefault();
  evt.stopPropagation();
  const convo = conversations.find(c => c.id === convoId);
  if (!convo) return;
  const items = convoLists.map(l => ({
    label: l.name,
    checked: Array.isArray(convo.listIds) && convo.listIds.includes(l.id),
    action: () => toggleConvoListMembership(convoId, l.id),
  }));
  items.push({ input: true, placeholder: 'New list…', onSubmit: (name) => {
    pendingListAdd = convoId;
    ws.send(JSON.stringify({ type: 'create_list', name }));
  }});
  openConvoMenu(evt, items);
}

// When a list is created from a conversation's menu, add that conversation to
// it as soon as the server confirms the list exists.
let pendingListAdd = null;

function toggleConvoListMembership(convoId, listId) {
  const convo = conversations.find(c => c.id === convoId);
  if (!convo) return;
  if (!Array.isArray(convo.listIds)) convo.listIds = [];
  convo.listIds = convo.listIds.includes(listId)
    ? convo.listIds.filter(id => id !== listId)
    : [...convo.listIds, listId];
  persistConversation(convo);
  renderConvoList();
}

function renderConvoList() {
  // WhatsApp-model list (SR1 UI alignment): pinned conversations always group
  // at the top, then everything else; BOTH groups sort by lastActiveAt desc.
  // Pinned-ness is conveyed by position plus the title-row pin glyph; the
  // left-border channel is reserved for the unread/working signal (green).
  // Pills are All | Unread only: pinning is a layout concern, not a filter,
  // so the old Pinned pill is gone.
  // Ordering/filtering rules live in conversation-list.js (unit-tested;
  // loaded before this file).
  const { main, archived } = RundockConvoList.partitionConversations(conversations, {
    pill: activeSidebarPill,
    unreadIds: unreadConvos,
  });

  let h = '';
  if (conversationsLoaded && !main.length && activeSidebarPill === 'unread') {
    // The Unread pill is always visible (no pop-in layout jump, no
    // stranded-filter fallback); an empty filter shows a calm caught-up
    // state instead of hiding the pill.
    h = `<div style="padding:24px 16px;text-align:center;color:var(--text-2);font-size:var(--caption);line-height:1.6">You're all caught up<br><span style="opacity:0.7">No unread conversations.</span></div>`;
  } else if (conversationsLoaded && !main.length && !archived.length) {
    h = `<div style="padding:12px 16px">
      <div style="color:var(--text-2);font-size:var(--caption);line-height:1.6">No conversations yet</div>
    </div>`;
  }
  // Flat main list. Items show the pin button (current variant) when active-
  // session or pinned, or the delete button (previous variant) when persisted-
  // from-disk and not pinned. Pinned-and-persisted items keep the pin button
  // so users can still unpin them.
  for (const c of main) {
    h += renderConvoItem(c, RundockConvoList.itemVariant(c));
  }
  // Archived section preserved from 0.8.9: collapsible at the bottom, with an
  // unread dot on the header when any archived conversation has unread
  // messages.
  if (archived.length) {
    const archivedEl = document.getElementById('archived-convos');
    const archivedOpen = archivedEl ? !archivedEl.classList.contains('hidden') : false;
    const archivedHasUnread = archived.some(c => unreadConvos.has(c.id));
    const unreadDot = archivedHasUnread ? '<span class="sidebar-label-unread" title="Unread in Archive"></span>' : '';
    h += `<div class="sidebar-section-divider" style="cursor:pointer" onclick="document.getElementById('archived-convos').classList.toggle('hidden')"><span class="sidebar-label">Archived (${archived.length})${unreadDot} &#x25BE;</span></div>`;
    h += `<div id="archived-convos" class="${archivedOpen ? '' : 'hidden'}">`;
    for (const c of archived) h += renderConvoItem(c, 'done');
    h += `</div>`;
  }
  document.getElementById('convo-list').innerHTML = h;
}

// Per-item render helper for the conversation sidebar. Variants:
//   'current'  -> Active-session item, plus any pinned item (live or persisted).
//                 Pin button, working-aware agent attribution.
//   'previous' -> Non-pinned persisted-from-disk item. Delete button, opacity
//                 dimming if the agent has since been removed.
//   'done'     -> Done section. Delete button, fixed 0.7 opacity.
//
// Left-border colour state lives on the row via convoBorderClass(c): green
// for working or unread, none otherwise. Pinned-ness is conveyed by list
// position and the title-row pin glyph, not the border.
function renderConvoItem(c, variant) {
  const isActive = activeConversation?.id === c.id;
  const cState = convoState[c.id];
  const activeId = cState?.activeAgentId;
  const lastSpeaker = c.lastAgentId && agents.find(a => a.id === c.lastAgentId);
  const working = workingConvos.has(c.id);
  const liveStyle = (variant === 'current');

  // Display agent: live variants use the working-aware fallback chain; the
  // others use the persisted shape (last speaker, then active, then convo agent).
  const displayAgent = liveStyle
    ? ((working && activeId && agents.find(a => a.id === activeId))
       || lastSpeaker
       || (activeId && agents.find(a => a.id === activeId))
       || c.agent)
    : (lastSpeaker || (activeId && agents.find(a => a.id === activeId)) || c.agent);

  // Preview text. Lengths and sources match the previous per-section render.
  let preview;
  if (variant === 'previous') {
    preview = c.lastMessagePreview || '';
  } else if (variant === 'done') {
    const lastMsg = c.messages.filter(m => m.role === 'agent').pop();
    preview = lastMsg ? stripMd(lastMsg.content).substring(0, 50) + '...' : (c.lastMessagePreview || '');
  } else {
    const lastMsg = c.messages.filter(m => m.role === 'agent').pop();
    preview = lastMsg ? stripMd(lastMsg.content).substring(0, 60) + '...' : (c.lastMessagePreview || 'No messages yet');
  }

  // Only the working dot renders inline now. Unread state is conveyed by the
  // green left border via convoBorderClass; a separate unread dot would
  // duplicate that signal.
  const indicator = working ? '<span class="convo-working"></span>' : '';
  // Recency label, right-aligned in the meta row. Omitted while the agent is
  // working: the pulsing dot already communicates "right now" and a time value
  // would be ambiguous.
  const timeStr = working ? '' : `<span class="convo-time">${formatRecency(c.lastActiveAt)}</span>`;

  const classes = ['convo-item'];
  if (isActive) classes.push('active');
  const bc = convoBorderClass(c);
  if (bc) classes.push(bc);

  const inline = [];
  if (variant === 'previous') {
    const agentGone = !agents.find(a => a.id === c.agentId);
    inline.push(agentGone ? 'opacity: 0.5' : 'opacity: 0.8');
  } else if (variant === 'done') {
    inline.push('opacity: 0.7');
  }
  const styleAttr = inline.length ? `style="${inline.join('; ')}"` : '';

  const agentGone = variant === 'previous' && !agents.find(a => a.id === c.agentId);
  const titleSuffix = agentGone ? ' (agent removed)' : '';
  const pinIndicatorSvg = c.pinned
    ? `<svg class="convo-pin-indicator" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 11V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v7"/><path d="M5 17h14"/><path d="M7 11l-2 6h14l-2-6"/></svg>`
    : '';
  const titleSection = liveStyle
    ? `<div class="convo-title-row"><span class="convo-title">${esc(c.title)}</span>${pinIndicatorSvg}</div>`
    : `<span class="convo-title">${esc(c.title)}${titleSuffix}</span>`;

  // Action button per variant. Tooltips use data-tooltip (not title) so the
  // custom CSS tooltip layer can surface them on immediate hover; native title
  // tooltips were behind two compounding fade-in delays and easy to miss.
  // Tooltip copy drops the "conversation" noun since the user is already in
  // the Conversations sidebar.
  //   'current'  -> pin / unpin (live items, plus pinned-and-persisted)
  //   'previous' -> archive (persisted, not yet archived; the triage action)
  //   'done'     -> delete (persisted and already archived; the soft delete)
  let leftButton;
  if (liveStyle) {
    const pinIconSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="${c.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 11V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v7"/><path d="M5 17h14"/><path d="M7 11l-2 6h14l-2-6"/></svg>`;
    leftButton = `<button class="convo-pin" onclick="togglePin('${c.id}', event)" data-tooltip="${c.pinned ? 'Unpin' : 'Pin'}">${pinIconSvg}</button>`;
  } else if (variant === 'previous') {
    const checkSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    leftButton = `<button class="convo-archive" onclick="archiveConversation('${c.id}', event)" data-tooltip="Archive">${checkSvg}</button>`;
  } else {
    const deleteSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
    leftButton = `<button class="convo-delete" onclick="deleteConversation('${c.id}', event)" data-tooltip="Delete">${deleteSvg}</button>`;
  }

  return `<div class="${classes.join(' ')}" ${styleAttr} onclick="openConversation('${c.id}')" oncontextmenu="openConvoListMenu(event, '${c.id}')">
    ${leftButton}
    ${titleSection}
    ${preview ? `<span class="convo-preview">${esc(preview)}</span>` : ''}
    <div class="convo-meta"><div class="avatar xs" style="background:${displayAgent.colour}">${displayAgent.icon}</div><span>${displayAgent.displayName}</span>${timeStr}${indicator}</div>
  </div>`;
}

// Discard current conversation if no real messages were sent (lazy creation cleanup)
function discardIfEmpty() {
  if (!activeConversation) return;
  const hasUserMsg = activeConversation.messages.some(m => m.role === 'user');
  if (!hasUserMsg && !activeConversation.persisted) {
    conversations = conversations.filter(c => c.id !== activeConversation.id);
    activeConversation = null;
    renderConvoList();
  }
}

function openConversation(id, withAnchor) {
  // Opening a conversation IS a navigation to the Conversations section,
  // wherever it started (sidebar click, search palette, an agent profile's
  // conversation list); the rail and sidebar must follow.
  setNavState('conversations');
  // A stale search anchor must never fire on a later manual open (it would
  // scroll to and flash an old hit days later).
  if (!withAnchor) pendingMessageAnchor = null;
  // Close any active find before swapping the DOM out from under it.
  if (activeConversation && activeConversation.id !== id) closeFindBar();
  if (activeConversation && activeConversation.id !== id) discardIfEmpty();
  const c=conversations.find(x=>x.id===id); if(!c) return;
  activeConversation=c;
  persistLastActiveConversation(id);
  unreadConvos.delete(id);
  updateUnreadBadge();
  // Done status is the user's explicit "I'm finished with this thread" state;
  // opening a Done conversation to read past context should not silently
  // override that. Status flips back to active only on deliberate signals:
  // sending a new message (handled in sendMessage) or clicking the Active/Done
  // badge in the chat header (handled in toggleConvoStatus).
  setupChat(c);
  const el=document.getElementById('messages'); el.innerHTML='';
  if(c.persisted && c.messages.length===0 && (c.sessionId || (c.sessionIds && c.sessionIds.length))) {
    // Persisted conversation from a previous session: load history from JSONL transcript(s)
    el.innerHTML=`<div id="history-loading" style="text-align:center;padding:24px 0;color:var(--text-3);font-size:var(--caption)">Loading conversation history...</div>`;
    // Send all sessionIds so server can merge history across delegation chain
    const sessionIds = (c.sessionIds && c.sessionIds.length) ? c.sessionIds : (c.sessionId ? [{ sessionId: c.sessionId, agentId: c.agentId }] : []);
    ws.send(JSON.stringify({
      type: 'get_session_history',
      sessionId: c.sessionId,
      sessionIds: sessionIds,
      conversationId: c.id,
      // Anchored opens (search-result clicks) load the full history so the
      // matched message is present even when it's deep in the conversation.
      limit: withAnchor ? 999 : 200
    }));
    // Mark as no longer purely persisted: messages are now in memory for this
    // session. Status is NOT touched here: opening an archived conversation to
    // read past context should not silently un-archive it. Status flips back
    // to active only on deliberate signals (sendMessage handles
    // reactivate-on-send; toggleConvoStatus handles the badge click).
    c.persisted = false;
    renderConvoList();
  } else {
    const historyCount = c._historyCount || 0;
    let replayLastAgentId = null;
    for(let i=0; i<c.messages.length; i++) {
      const m = c.messages[i];
      if(m.role==='user') addUserMsg(m.content,false);
      else if(m.role==='divider') {
        const msgAgent = agents.find(a => a.id === m.agentId);
        if (msgAgent) el.appendChild(buildDelegationDivider(msgAgent, m.isReturn));
        replayLastAgentId = m.agentId;
      }
      else if(m.role==='agent') {
        replayLastAgentId = m.agentId || replayLastAgentId;
        addAgentMsg(m.content,m.agentId,false,m.timestamp || null);
      }
      if(m.isHistory) {
        const last = el.lastElementChild;
        if(last) last.classList.add('history-msg');
      }
      if(historyCount > 0 && i === historyCount - 1) {
        el.appendChild(createHistoryDivider());
      }
    }
  }
  // Restore processing state if this conversation is still working
  const state = getConvoState(id);
  if(state.isProcessing) {
    document.getElementById('chat-status').textContent='working...'; document.getElementById('chat-status').classList.add('working');
    const sb = document.getElementById('send-btn');
    sb.disabled = false; sb.classList.add('cancel'); sb.classList.remove('active');
    sb.onclick = cancelProcessing; sb.title = 'Stop agent';
    sb.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
    document.getElementById('msg-input').disabled=true;
    const a=agents.find(x => x.id === state.activeAgentId) || c.agent;
    const m2=document.getElementById('messages');
    // Render any response text accumulated on the server before we reconnected
    if(state.streamingRawText) {
      const el = document.createElement('div');
      el.className = 'msg msg-agent';
      el.innerHTML = `<div class="msg-sender" style="color:${a?.colour||'var(--accent)'}"><div class="avatar xs" style="background:${a?.colour||'var(--accent)'}">${a?.icon||'?'}</div> ${a?.displayName||'Agent'}<span class="msg-time">${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span></div><div class="msg-bubble"><span class="streaming-text">${formatMd(state.streamingRawText)}</span></div>`;
      m2.appendChild(el);
      state.currentStreamingMsg = el;
      state.hasStreamingBubble = true; // keep the reducer's bubble flag in sync with this out-of-band creation
    }
    // Show thinking indicator only if no text has been streamed yet.
    // If we have snapshot text, the stream is active and the bubble is unnecessary.
    if(!state.streamingRawText) {
      const d=document.createElement('div'); d.className='msg msg-agent'; d.id='thinking-indicator';
      d.innerHTML=`<div class="msg-sender" style="color:${a?.colour||'var(--accent)'}"><div class="avatar xs" style="background:${a?.colour||'var(--accent)'}">${a?.icon||'?'}</div> ${a?.displayName||'Agent'}</div><div class="msg-bubble thinking-bubble"><div class="thinking-pulse" style="background:${a?.colour||'var(--accent)'}"></div><div><div class="thinking-label">Thinking</div><div class="thinking-status" id="thinking-status"></div></div></div>`;
      m2.appendChild(d);
    }
  } else {
    document.getElementById('chat-status').textContent=''; document.getElementById('chat-status').classList.remove('working');
    document.getElementById('send-btn').disabled=false;
    document.getElementById('msg-input').disabled=false;
    document.getElementById('msg-input').focus();
  }
  // Approval cards that arrived while this conversation was in the
  // background render now, at the bottom of the thread, still answerable
  // until the server's permission timeout expires them. (Session-history
  // loads prepend above existing content, so these cards keep their place.)
  renderPendingPermissionCards(id);
  showView('chat'); scrollBottom(true); renderConvoList();
}

// ===== 9. CHAT & MESSAGING =====

// Core send helper: pushes a message to server, updates UI, persists metadata
function dispatchMessage(convo, text) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  addUserMsg(text);
  convo.messages.push({ role: 'user', content: text, timestamp: new Date().toISOString() });
  // Promote from "Previous" to current session when user sends a message
  if (convo.persisted) {
    convo.persisted = false;
    convo.status = 'active';
    renderConvoList();
  }
  startProcessing(convo.id);

  let content = text;

  // Use the last-active agent (e.g. a delegate) if available, otherwise the conversation's base agent.
  // Also resolve the correct session ID for that agent so --resume loads the right context.
  const state = getConvoState(convo.id);
  const resumeAgent = state.activeAgentId || convo.agentId;
  const resumeSessionId = (resumeAgent !== convo.agentId && convo.sessionIds)
    ? (convo.sessionIds.filter(s => s.agentId === resumeAgent).pop()?.sessionId || convo.sessionId)
    : convo.sessionId;
  const chatMsg = { type: 'chat', content, agent: resumeAgent, conversationId: convo.id };
  if (resumeSessionId) chatMsg.sessionId = resumeSessionId;
  ws.send(JSON.stringify(chatMsg));
  persistConversation(convo);
}

function sendMessage() {
  const input=document.getElementById('msg-input'),text=input.value.trim();
  if(!activeConversation||!ws) return;
  const state = getConvoState(activeConversation.id);
  if(!text||state.isProcessing) return;
  // If the user is continuing a conversation that was marked Done, treat the
  // new message as an implicit reactivation: flip the status back to active so
  // the conversation moves out of the Done section, the badge updates in the
  // chat header, and persistConversation downstream writes the change to disk.
  if (activeConversation.status === 'archived') {
    activeConversation.status = 'active';
    const statusEl = document.getElementById('chat-convo-status');
    if (statusEl) {
      const stateLabel = statusEl.querySelector('.state-label');
      const actionLabel = statusEl.querySelector('.action-label');
      if (stateLabel) stateLabel.textContent = 'Active';
      if (actionLabel) actionLabel.textContent = '→ Archive';
      statusEl.className = 'chat-convo-status active-convo';
    }
  }
  // Bump lastActiveAt locally so the next renderConvoList sort reflects this
  // activity immediately. Without this, the sidebar sort relies on a value
  // that only refreshes when get_conversations re-fetches (workspace open or
  // reload), so a freshly-active conversation stays at its old position in
  // Pinned or in its tier within Active. The server still stamps its own
  // value on save_conversation; the local bump just keeps the client in sync.
  activeConversation.lastActiveAt = new Date().toISOString();
  const promptsEl=document.getElementById('chat-prompts'); if(promptsEl) promptsEl.remove();
  if(activeConversation.messages.filter(m=>m.role==='user').length===0 && !activeConversation.isSetup) { activeConversation.title=text.substring(0,50)+(text.length>50?'...':''); document.getElementById('chat-title-input').value=activeConversation.title; renderConvoList(); }
  input.value=''; input.style.height='44px'; document.getElementById('send-btn').classList.remove('active');
  dispatchMessage(activeConversation, text);
}
function startProcessing(convoId) {
  const state = getConvoState(convoId);
  state.isProcessing=true; state.latestText=''; state.latestAgentId=null;
  state.lastStreamActivity = Date.now();
  // Safety net: if no streaming activity for 90s, auto-finish to prevent stuck UI.
  // The decision (watchdogVerdict) lives in conversation-state.js where it is
  // unit-tested; each tick re-reads the LIVE state via getConvoState. Never
  // decide on the `state` object captured above: reduce() returns fresh state
  // objects and the glue reassigns convoState[convoId], so a captured
  // reference is orphaned after the first reduced message, its
  // lastStreamActivity freezes, and every turn longer than 90s would be
  // auto-finished mid-stream. Pinned by test/unit/regression.test.js.
  if(state.processingTimeout) clearInterval(state.processingTimeout);
  state.processingTimeout = setInterval(() => {
    const live = getConvoState(convoId);
    const verdict = RundockConversationState.watchdogVerdict(live, Date.now());
    if(verdict.action === 'stop') { clearInterval(live.processingTimeout); live.processingTimeout=null; return; }
    if(verdict.action === 'finish') {
      console.warn(`[Timeout] convo=${convoId} no streaming activity for ${Math.round(verdict.idleMs/1000)}s, auto-finishing`);
      clearInterval(live.processingTimeout); live.processingTimeout=null;
      finishProcessing(convoId);
    }
  }, 10000);
  workingConvos.add(convoId);
  userScrolledUp = false; // Reset: follow the new response from the start
  renderConvoList();
  const isActive = activeConversation?.id === convoId;
  const convo = conversations.find(c=>c.id===convoId);
  if(isActive) {
    document.getElementById('chat-status').textContent='working...'; document.getElementById('chat-status').classList.add('working');
    const sendBtn = document.getElementById('send-btn');
    sendBtn.disabled = false;
    sendBtn.classList.add('cancel');
    sendBtn.classList.remove('active');
    sendBtn.onclick = cancelProcessing;
    sendBtn.title = 'Stop agent';
    sendBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
    document.getElementById('msg-input').disabled=true;
    // Use the active delegate agent during delegation, otherwise the conversation agent
    const activeId = state.activeAgentId || convo?.agentId;
    const a = (activeId && agents.find(x => x.id === activeId)) || convo?.agent || agents[0];
    const m=document.getElementById('messages'),d=document.createElement('div'); d.className='msg msg-agent'; d.id='thinking-indicator';
    d.innerHTML=`<div class="msg-sender" style="color:${a?.colour||'var(--accent)'}"><div class="avatar xs" style="background:${a?.colour||'var(--accent)'}">${a?.icon||'?'}</div> ${a?.displayName||'Agent'}</div><div class="msg-bubble thinking-bubble"><div class="thinking-pulse" style="background:${a?.colour||'var(--accent)'}"></div><div><div class="thinking-label">Thinking</div><div class="thinking-status" id="thinking-status"></div></div></div>`;
    m.appendChild(d); scrollBottom();
  }
  // Show working status on the active agent (delegate or conversation agent)
  const statusAgentId = state.activeAgentId || convo?.agentId;
  if(statusAgentId) {
    const s=document.querySelector(`[data-status="${statusAgentId}"]`); if(s){s.textContent='working';s.classList.add('working');}
    const od=document.querySelector(`[data-org-status="${statusAgentId}"]`); if(od) od.classList.add('working');
  }
  updateWorkingBadge();
}
function finishProcessing(convoId) {
  const state = getConvoState(convoId);
  state.isProcessing=false; state.currentStreamingMsg=null; state.hasStreamingBubble=false;
  if(state.processingTimeout) { clearInterval(state.processingTimeout); state.processingTimeout=null; }
  workingConvos.delete(convoId);
  // If user isn't viewing this conversation, mark as unread
  const viewingChat = activeConversation?.id === convoId && currentView === 'chat';
  const convoInWorkspace = conversations.some(c => c.id === convoId);
  if (convoInWorkspace && !viewingChat) {
    unreadConvos.add(convoId);
    updateUnreadBadge();
  }
  renderConvoList();
  const isActive = activeConversation?.id === convoId;
  const convo = conversations.find(c=>c.id===convoId);
  // Bump lastActiveAt locally + persist on agent finish so the conversation
  // sorts to the top of its tier (or top of Pinned, if pinned) in the sidebar
  // immediately. The server stamps its own value on save; the local update
  // keeps the next render current without waiting for a get_conversations
  // round-trip.
  if (convo) {
    convo.lastActiveAt = new Date().toISOString();
    persistConversation(convo);
  }

  if(isActive) {
    const tt=document.getElementById('thinking-indicator'); if(tt) tt.remove();
    document.getElementById('chat-status').textContent=''; document.getElementById('chat-status').classList.remove('working');
    const sendBtn = document.getElementById('send-btn');
    sendBtn.disabled = false;
    sendBtn.classList.remove('cancel');
    sendBtn.onclick = sendMessage;
    sendBtn.title = 'Send message';
    sendBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
    sendBtn.style.opacity = '';
    document.getElementById('msg-input').disabled=false;
    document.getElementById('msg-input').focus();
  }
  if(convo) {
    // Clear working status on the active agent (delegate or conversation agent)
    const statusAgentId = state.activeAgentId || convo.agentId;
    agentLastActivity[statusAgentId] = { time: new Date(), label: convo.title };
    const s=document.querySelector(`[data-status="${statusAgentId}"]`);
    if(s){s.textContent=formatTimeAgo(new Date());s.classList.remove('working');}
    const od=document.querySelector(`[data-org-status="${statusAgentId}"]`); if(od) od.classList.remove('working');
  }
  updateWorkingBadge();
  // Refresh file tree after a short delay to let file writes flush to disk
  setTimeout(() => {
    if(ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'get_files' }));
    }
  }, 500);
}

function cancelProcessing() {
  if (!activeConversation || !ws || ws.readyState !== WebSocket.OPEN) return;
  const state = getConvoState(activeConversation.id);
  if (!state.isProcessing) return;
  ws.send(JSON.stringify({ type: 'cancel', conversationId: activeConversation.id }));
  // Immediate visual feedback while waiting for server confirmation
  const statusEl = document.getElementById('thinking-status');
  if (statusEl) statusEl.textContent = 'Cancelling...';
  const sendBtn = document.getElementById('send-btn');
  sendBtn.disabled = true;
  sendBtn.style.opacity = '0.5';
}

// Restore processing state after WebSocket reconnect.
// Server sends active_processes with all running Claude processes.
function handleActiveProcesses(active) {
  const activeConvoIds = new Set(active.map(p => p.conversationId));

  // Restore state for conversations with live processes on the server.
  // Non-idle: actively generating output — restore thinking indicator.
  // Idle: specialist waiting for input — record agent identity so
  // header/placeholder reflect the correct recipient, but no indicator.
  for (const proc of active) {
    const convo = conversations.find(c => c.id === proc.conversationId);
    const state = getConvoState(proc.conversationId);
    if (!convo) continue;
    state.activeProcessId = proc.processId;
    if (proc.agentId) {
      state.activeAgentId = proc.agentId;
      state.delegationActive = !!proc.delegation;
    }
    if (proc.idle) continue; // No thinking indicator for idle processes
    if (!state.isProcessing) {
      if (proc.responseText) {
        state.streamingRawText = proc.responseText;
      }
      startProcessing(proc.conversationId);
    }
  }

  // Finish any conversations that the client thought were processing but the server has no process for
  for (const [convoId, state] of Object.entries(convoState)) {
    if (state.isProcessing && !activeConvoIds.has(convoId)) {
      // If we have accumulated response text, save it as a message before clearing
      const convo = conversations.find(c => c.id === convoId);
      if (state.streamingRawText && convo) {
        convo.messages.push({ role: 'agent', content: state.streamingRawText, agentId: convo.agentId, timestamp: new Date().toISOString() });
        // If this conversation is visible, render the text (without thinking bubble)
        if (activeConversation?.id === convoId) {
          const existingStream = state.currentStreamingMsg;
          if (existingStream) {
            const streamEl = existingStream.querySelector('.streaming-text');
            if (streamEl) streamEl.innerHTML = formatMd(state.streamingRawText);
          } else {
            addAgentMsg(state.streamingRawText, convo.agentId, false);
          }
        }
      }
      state.streamingRawText = '';
      finishProcessing(convoId);
      console.log(`[Reconnect] Cleared stale processing for convo=${convoId}`);
    }
  }
}

// Tick agent timestamps every 60 seconds without re-rendering
setInterval(() => {
  for (const [agentId, activity] of Object.entries(agentLastActivity)) {
    const el = document.querySelector(`[data-status="${agentId}"]`);
    if (el && !el.classList.contains('working')) {
      el.textContent = formatTimeAgo(activity.time);
    }
  }
}, 60000);

// UI helpers
function addAgentMsg(text,agentId,anim=true,timestamp=null) {
  const a=agents.find(x=>x.id===agentId)||activeConversation?.agent||agents[0],m=document.getElementById('messages'),d=document.createElement('div');
  d.className='msg msg-agent'; if(!anim)d.style.animation='none';
  const t = timestamp ? new Date(timestamp) : new Date();
  const timeStr = isNaN(t.getTime()) ? '' : t.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  const timeSpan = timeStr ? `<span class="msg-time">${timeStr}</span>` : '';
  d.innerHTML=`<div class="msg-sender" style="color:${a?.colour||'var(--accent)'}"><div class="avatar xs" style="background:${a?.colour||'var(--accent)'}">${a?.icon||'?'}</div> ${a?.displayName||'Agent'}${timeSpan}</div><div class="msg-bubble">${formatMd(text)}</div>`;
  m.appendChild(d); scrollBottom(); return d;
}
function addUserMsg(text,anim=true) { const m=document.getElementById('messages'),d=document.createElement('div'); d.className='msg msg-user'; if(!anim)d.style.animation='none'; d.innerHTML=`<div class="msg-bubble">${esc(text)}</div>`; m.appendChild(d); scrollBottom(true); }
function addSystemMsg(text) { const m=document.getElementById('messages'),d=document.createElement('div'); d.className='msg-system'; d.textContent=text; m.appendChild(d); scrollBottom(); }

// Recovery card shown when the Claude Code sign-in expires (401). Replaces the
// raw error blob with a clear explanation and the steps to reconnect.
function renderAuthErrorCard(convoId) {
  if (convoId && activeConversation?.id !== convoId) return;
  const m = document.getElementById('messages');
  if (!m) return;
  const d = document.createElement('div');
  d.className = 'auth-error-card';
  d.innerHTML =
    `<div class="auth-error-title">Claude Code sign-in expired</div>` +
    `<div class="auth-error-body">Rundock lost its connection to Claude Code because your sign-in expired. This is a Claude Code session, not a Rundock fault, and your conversations are safe. To reconnect:</div>` +
    `<ol class="auth-error-steps">` +
      `<li>Open a terminal.</li>` +
      `<li>Run <code>claude</code> <button class="auth-error-copy" onclick="copyAuthCmd(this)" title="Copy command">copy</button></li>` +
      `<li>If it shows you are already logged in, log out and log back in.</li>` +
    `</ol>` +
    `<div class="auth-error-foot">Then resend your message. <a href="https://docs.rundock.ai/troubleshooting/authentication" target="_blank" rel="noopener">Full steps and details &#x2192;</a></div>`;
  m.appendChild(d);
  scrollBottom();
}
function copyAuthCmd(btn) {
  const done = () => { const t = btn.textContent; btn.textContent = 'copied'; setTimeout(() => { btn.textContent = t; }, 2000); };
  if (navigator.clipboard?.writeText) { navigator.clipboard.writeText('claude').then(done).catch(() => {}); }
}

function agentDisplayName(agentId) {
  const a = agents.find(x => x.id === agentId);
  return (a && a.displayName) || agentId || 'This agent';
}

// Plan-limit card for Codex agents. Same visual pattern as the Claude
// auth-error card: a limit is expected and self-resolving, so it gets a calm
// explanation with the CLI's own words attached, never a raw error.
function renderCodexQuotaCard(convoId, d) {
  if (convoId && activeConversation?.id !== convoId) return;
  const m = document.getElementById('messages');
  if (!m) return;
  const name = esc(agentDisplayName(d._agent));
  const el = document.createElement('div');
  el.className = 'auth-error-card';
  el.innerHTML =
    `<div class="auth-error-title">ChatGPT plan limit reached</div>` +
    `<div class="auth-error-body">${name} has used this plan's Codex allowance for now. This is a plan limit, not a fault, and your conversation is safe. ${name} can pick this up once the limit resets; your Claude agents are unaffected.</div>` +
    (d.detail ? `<div class="codex-error-detail">Codex: ${esc(d.detail)}</div>` : '') +
    `<div class="auth-error-foot">Then resend your message. <a href="https://docs.rundock.ai/concepts/runtimes" target="_blank" rel="noopener">About runtimes and limits &#x2192;</a></div>`;
  m.appendChild(el);
  scrollBottom();
}

// Guidance card for actionable Codex failures (signed out, unavailable
// model). Same visual grammar as the quota card: what happened, the concrete
// fix, the CLI's own words attached for the curious.
function renderCodexGuidanceCard(convoId, d) {
  if (convoId && activeConversation?.id !== convoId) return;
  const m = document.getElementById('messages');
  if (!m) return;
  const el = document.createElement('div');
  el.className = 'auth-error-card';
  el.innerHTML =
    `<div class="auth-error-title">${esc(d.title || 'Codex needs attention')}</div>` +
    `<div class="auth-error-body">${esc(d.body || '')}</div>` +
    (d.detail ? `<div class="codex-error-detail">Codex: ${esc(d.detail)}</div>` : '') +
    `<div class="auth-error-foot">Then resend your message. <a href="https://docs.rundock.ai/concepts/runtimes" target="_blank" rel="noopener">About runtimes &#x2192;</a></div>`;
  m.appendChild(el);
  scrollBottom();
}

// Classified Codex failure: a friendly pill with the CLI's verbatim text.
// No "Error:" prefix; the sentence explains what happened in plain words.
function renderCodexErrorPill(convoId, d) {
  if (convoId && activeConversation?.id !== convoId) return;
  const name = agentDisplayName(d._agent);
  addSystemMsg(`${name}'s runtime hit a problem and this turn stopped.` + (d.detail ? ` Codex: ${d.detail}` : ''));
}
function addToolMsg(name) { const m=document.getElementById('messages'),d=document.createElement('div'); d.className='msg-tool'; d.innerHTML=`<span style="color:var(--working)">&#x2192;</span> Using ${esc(name)}`; m.appendChild(d); scrollBottom(); return d; }
// ===== SESSION HISTORY =====

function createHistoryDivider() {
  const divider = document.createElement('div');
  divider.id = 'history-divider';
  divider.style.cssText = 'display:flex;align-items:center;gap:8px;padding:16px 0;color:var(--text-3);font-size:var(--caption)';
  divider.innerHTML = `<div style="flex:1;height:1px;background:var(--border)"></div><span>Previous session</span><div style="flex:1;height:1px;background:var(--border)"></div>`;
  return divider;
}

function renderSessionHistory(d) {
  const convo = conversations.find(c => c.id === d.conversationId);
  if (!convo) return;
  const el = document.getElementById('messages');
  if (!el) return;

  // Remove the loading indicator
  const loader = document.getElementById('history-loading');
  if (loader) loader.remove();

  // If the user already sent a new (non-history) message while history was loading, skip rendering
  if (convo.messages.some(m => !m.isHistory)) return;

  // Build history messages
  const frag = document.createDocumentFragment();

  // "Load earlier messages" button if there's more history
  if (d.hasMore) {
    const loadMore = document.createElement('div');
    loadMore.className = 'history-load-more';
    loadMore.id = 'history-load-more';
    const alreadyLoaded = (convo._historyCount || 0) + d.messages.length;
    loadMore.textContent = `Load earlier messages (${d.totalCount - alreadyLoaded} more)`;
    loadMore.style.cssText = 'text-align:center;padding:12px 0;font-size:var(--caption);color:var(--accent);cursor:pointer;';
    loadMore.dataset.offset = d.messages.length;
    loadMore.onclick = () => {
      const currentOffset = parseInt(loadMore.dataset.offset);
      loadMore.textContent = 'Loading...';
      loadMore.dataset.offset = currentOffset + 20;
      const loadSessionIds = (convo.sessionIds && convo.sessionIds.length) ? convo.sessionIds : (convo.sessionId ? [{ sessionId: convo.sessionId, agentId: convo.agentId }] : []);
      ws.send(JSON.stringify({
        type: 'get_session_history',
        sessionId: convo.sessionId,
        sessionIds: loadSessionIds,
        conversationId: convo.id,
        limit: 20,
        offset: currentOffset
      }));
    };
    frag.appendChild(loadMore);
  }

  // Render each historical message with per-message agent attribution
  const defaultAgent = convo.agent;
  let lastAgentId = null;
  for (const msg of d.messages) {
    // Skip hidden system messages (workspace analysis blocks, setup instructions)
    if (msg.content && msg.content.includes('[WORKSPACE_ANALYSIS]')) continue;
    // Routing entries: orchestrator immediate-routing turns (no prose). Don't
    // render a chat bubble — the agent-change divider on the next message
    // carries the visible handoff. Update lastAgentId so the divider triggers.
    if (msg.type === 'routing') {
      lastAgentId = msg.agentId || lastAgentId;
      continue;
    }
    const div = document.createElement('div');
    div.style.animation = 'none';
    if (msg.role === 'user') {
      div.className = 'msg msg-user history-msg';
      div.innerHTML = `<div class="msg-bubble">${esc(msg.content)}</div>`;
    } else {
      // Use per-message agentId if available (from multi-session merge), fall back to default
      const msgAgent = msg.agentId ? (agents.find(a => a.id === msg.agentId) || defaultAgent) : defaultAgent;
      // Add delegation divider if agent changed
      if (msg.agentId && msg.agentId !== lastAgentId && lastAgentId !== null) {
        const isReturn = msgAgent?.type === 'orchestrator';
        frag.appendChild(buildDelegationDivider(msgAgent, isReturn, { historyClass: true, noAnimation: true }));
      }
      lastAgentId = msg.agentId || lastAgentId;
      div.className = 'msg msg-agent history-msg';
      const ht = msg.timestamp ? new Date(msg.timestamp) : null;
      const htStr = ht && !isNaN(ht.getTime()) ? ht.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : '';
      const htSpan = htStr ? `<span class="msg-time">${htStr}</span>` : '';
      div.innerHTML = `<div class="msg-sender" style="color:${msgAgent?.colour||'var(--accent)'}"><div class="avatar xs" style="background:${msgAgent?.colour||'var(--accent)'}">${msgAgent?.icon||'?'}</div> ${msgAgent?.displayName||'Agent'}${htSpan}</div><div class="msg-bubble">${formatMd(msg.content)}</div>`;
    }
    frag.appendChild(div);
  }

  // Insert before any existing content (in case of load-more)
  const existingDivider = document.getElementById('history-divider');
  const isLoadMore = !!existingDivider;
  if (isLoadMore) {
    // Load more: capture scroll position, prepend, then restore
    const loadMoreBtn = document.getElementById('history-load-more');
    const scrollAnchor = loadMoreBtn ? loadMoreBtn.nextElementSibling : el.firstChild;
    const anchorTop = scrollAnchor ? scrollAnchor.getBoundingClientRect().top : 0;
    if (loadMoreBtn) loadMoreBtn.remove();
    el.insertBefore(frag, el.firstChild);
    // Restore scroll so the anchor stays in the same viewport position
    if (scrollAnchor) {
      const newAnchorTop = scrollAnchor.getBoundingClientRect().top;
      el.scrollTop += (newAnchorTop - anchorTop);
    }
  } else {
    // First load: add the divider after history messages
    const divider = createHistoryDivider();
    frag.appendChild(divider);
    el.insertBefore(frag, el.firstChild);
    // Scroll to the divider so the user sees the boundary
    divider.scrollIntoView({ behavior: 'auto', block: 'end' });
  }

  // Store history messages in convo so they persist when navigating away and back.
  // Routing entries keep their dedicated role so sidebar preview filters them out
  // and the replay loop skips them (auto-divider on the following agent triggers).
  const historyMsgs = d.messages.filter(m => !m.content || !m.content.includes('[WORKSPACE_ANALYSIS]')).map(m => ({
    role: m.type === 'routing' ? 'routing' : (m.role === 'user' ? 'user' : 'agent'),
    content: m.role !== 'user' ? stripRundockMarkers(m.content || '').trim() : m.content,
    agentId: m.agentId || convo.agentId,
    timestamp: m.timestamp || null,
    isHistory: true
  }));
  // Prepend to existing messages (load-more adds older messages before existing ones)
  convo.messages = [...historyMsgs, ...convo.messages];
  convo._historyCount = (convo._historyCount || 0) + historyMsgs.length;

  // Set activeAgentId to the conversation's orchestrator on history load,
  // but only if no live process exists (active or idle). If a specialist has
  // a live process, handleActiveProcesses already set the correct activeAgentId
  // and activeProcessId; overriding it here would desync the header/placeholder
  // from actual message routing.
  const state = getConvoState(convo.id);
  if (!state.activeProcessId) {
    state.activeAgentId = convo.agentId;
  }
  if (activeConversation?.id === convo.id) {
    const displayId = state.activeAgentId || convo.agentId;
    const agent = agents.find(a => a.id === displayId) || convo.agent;
    if (agent) {
      document.getElementById('chat-agent-label').textContent = agent.displayName;
      document.getElementById('chat-agent-avatar').style.background = agent.colour;
      document.getElementById('chat-agent-avatar').textContent = agent.icon;
      document.getElementById('msg-input').placeholder = `Message ${agent.displayName}...`;
    }
    renderConvoList();
  }

  // Universal search: if this history load was triggered by a search-result
  // click, scroll to (and flash) the matched message now that it's rendered.
  tryMessageAnchor(d.conversationId);
}

// ===== PERMISSION UI =====

// Session-level "always allow" patterns
const alwaysAllowedTools = new Set();
// Pending permission callbacks (avoids inline onclick injection)
const pendingPermissions = new Map();
// Permission requests for conversations that are not on screen, awaiting
// render when their conversation opens: convoId -> Map(requestId -> the raw
// control_request payload). Entries leave on answer (respondPermission),
// server timeout (permission_timeout), or cancel (the server's cancel sweep
// already answered them). The store's decisions are pure functions in
// permissions.js (unit-tested); this map is the app's single instance.
const pendingPermissionsByConvo = new Map();

// Permission/trust decision logic lives in permissions.js (unit-tested;
// loaded before this file). The aliases keep historical call sites readable;
// describeToolRequest injects the app's agent-name resolver for WriteFile
// card copy.
function classifyRisk(toolName, input) { return RundockPermissions.classifyRisk(toolName, input); }
function describeToolRequest(toolName, input) {
  return RundockPermissions.describeToolRequest(toolName, input, { agentDisplayName });
}
function toolAllowKey(toolName, input) { return RundockPermissions.toolAllowKey(toolName, input); }

function handlePermissionRequest(d, convoId) {
  const req = d.request || {};
  const requestId = d.request_id || '';
  const toolName = req.tool_name || 'Unknown';
  const input = req.input || {};
  const risk = classifyRisk(toolName, input);
  const key = toolAllowKey(toolName, input);

  // The auto-allow decision path is a named, unit-tested function in
  // permissions.js: standing "Always allow" grants and the low-risk
  // (read-only) auto-approve policy skip the card; everything else asks.
  // Auto-allows answer regardless of which conversation is on screen (a
  // standing grant is session-wide); card-worthy requests render only in
  // the active conversation and QUEUE for background ones, where they used
  // to be silently dropped and auto-denied at the server timeout.
  const decision = RundockPermissions.decidePermission(risk, key, alwaysAllowedTools);
  const isActive = activeConversation?.id === convoId;
  const route = RundockPermissions.routePermissionRequest(decision, isActive);
  if (route === 'respond-allow') {
    if (ws) {
      ws.send(JSON.stringify({ type: 'permission_response', requestId, conversationId: convoId, allow: true }));
    }
    return;
  }
  if (route === 'queue') {
    // Keep the request for renderPendingPermissionCards (fires when the
    // conversation opens) and surface the unread signal so the user knows
    // something in that conversation needs their attention.
    RundockPermissions.queuePendingPermission(pendingPermissionsByConvo, convoId, requestId, d);
    unreadConvos.add(convoId);
    updateUnreadBadge();
    renderConvoList();
    return;
  }
  renderPermissionCard(d, convoId);
}

// Render one approval card into the active conversation's message list.
// Extracted verbatim from handlePermissionRequest so queued background
// requests render through the exact same path when their conversation opens.
function renderPermissionCard(d, convoId) {
  const req = d.request || {};
  const requestId = d.request_id || '';
  const toolName = req.tool_name || 'Unknown';
  const input = req.input || {};
  const risk = classifyRisk(toolName, input);
  const { summary, context, detail } = describeToolRequest(toolName, input);
  const key = toolAllowKey(toolName, input);

  // Store callback data for safe event handling (no inline onclick injection).
  // toolInput is echoed back in control_response (required by Claude Code).
  pendingPermissions.set(requestId, { convoId, key, toolInput: input });

  const icons = {
    low: '<svg class="permission-icon" width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/><path d="M6 8l1.5 1.5L10.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    medium: '<svg class="permission-icon" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1L1 4.5V8c0 3.5 3 6.5 7 7.5 4-1 7-4 7-7.5V4.5L8 1z" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M6 8l1.5 1.5L10.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    high: '<svg class="permission-icon" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1L1 4.5V8c0 3.5 3 6.5 7 7.5 4-1 7-4 7-7.5V4.5L8 1z" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M8 5v3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="10.75" r="0.75" fill="currentColor"/></svg>'
  };

  const m = document.getElementById('messages');
  const card = document.createElement('div');
  card.className = 'msg msg-permission';
  card.id = 'perm-' + requestId;
  card.innerHTML = `
    <div class="permission-card risk-${risk}">
      <div class="permission-header">
        ${icons[risk]}
        <span class="permission-summary">${esc(summary)}</span>
      </div>
      ${context ? `<div class="permission-context">${esc(context)}</div>` : ''}
      ${(toolName === 'Bash' && input.description && detail.length > 60)
        ? `<details class="permission-detail-collapse"><summary>Show command</summary><code class="permission-detail">${esc(detail)}</code></details>`
        : `<code class="permission-detail">${esc(detail)}</code>`}
      <div class="permission-actions">
        <button class="btn-perm btn-allow" data-perm-id="${esc(requestId)}" data-perm-action="allow">Allow</button>
        ${RundockPermissions.offersAlwaysAllow(risk) ? `<button class="btn-perm btn-always" data-perm-id="${esc(requestId)}" data-perm-action="always">Always allow</button>` : ''}
        <button class="btn-perm btn-deny" data-perm-id="${esc(requestId)}" data-perm-action="deny">Deny</button>
      </div>
    </div>
  `;

  // Attach event listeners safely (no inline onclick)
  card.querySelectorAll('[data-perm-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.permAction;
      const id = btn.dataset.permId;
      respondPermission(id, action === 'deny' ? false : true, action === 'always');
    });
  });

  // Pause the thinking indicator while waiting for user decision
  const t = document.getElementById('thinking-indicator');
  if (t) t.style.display = 'none';

  m.appendChild(card);
  scrollBottom();
}

// Append cards for any approval requests that arrived while this
// conversation was in the background. Idempotent: a card already in the DOM
// is skipped, and entries stay queued until answered or timed out, so
// switching away and back re-renders them. Called when a conversation
// becomes the active view (openConversation).
function renderPendingPermissionCards(convoId) {
  if (activeConversation?.id !== convoId) return;
  if (!document.getElementById('messages')) return;
  for (const d of RundockPermissions.pendingPermissionsFor(pendingPermissionsByConvo, convoId)) {
    if (document.getElementById('perm-' + (d.request_id || ''))) continue;
    renderPermissionCard(d, convoId);
  }
}

function respondPermission(requestId, allow, always) {
  const pending = pendingPermissions.get(requestId);
  if (!pending || !ws) return;
  pendingPermissions.delete(requestId);
  // Answered: the queued copy (if this card was rendered from the
  // background store) must never render again.
  RundockPermissions.removePendingPermission(pendingPermissionsByConvo, requestId);

  ws.send(JSON.stringify({
    type: 'permission_response',
    requestId: requestId,
    conversationId: pending.convoId,
    allow: allow,
    toolInput: pending.toolInput || {}
  }));

  // Store always-allow pattern if requested
  if (allow && always) {
    alwaysAllowedTools.add(pending.key);
  }

  // Replace the card with a resolved indicator
  const card = document.getElementById('perm-' + requestId);
  if (card) {
    const summary = card.querySelector('.permission-summary')?.textContent || '';
    const detail = card.querySelector('.permission-detail')?.textContent || '';
    const label = allow ? (always ? '✓ Always' : '✓') : '✕';
    card.innerHTML = `<div class="permission-resolved ${allow ? 'allowed' : 'denied'}">
      <span>${label}</span> ${esc(summary)}
    </div>`;
  }

  // Resume thinking indicator
  const t = document.getElementById('thinking-indicator');
  if (t) t.style.display = '';
}

function formatToolName(name) {
  const labels = {
    'Read': 'Reading files...', 'Glob': 'Searching files...', 'Grep': 'Searching content...',
    'Bash': 'Running a command...', 'Write': 'Writing a file...', 'Edit': 'Editing a file...',
    'WebSearch': 'Searching the web...', 'WebFetch': 'Fetching a page...',
    'Agent': 'Delegating to a specialist...', 'Skill': 'Running a skill...',
    'TodoWrite': 'Updating tasks...', 'NotebookEdit': 'Editing notebook...',
    'ListMcpResourcesTool': 'Checking connectors...', 'ReadMcpResourceTool': 'Reading from connector...',
    'ToolSearch': 'Looking up tools...'
  };
  // Check for MCP tools (mcp__service__tool format)
  if(name.startsWith('mcp__')) {
    const parts = name.split('__');
    const service = parts[1] || '';
    return `Checking ${service}...`;
  }
  return labels[name] || `Working...`;
}
function formatToolShort(name) {
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    return parts[1] || 'MCP';
  }
  return name;
}

function buildActivitySummary(toolCalls, turnStartTime) {
  if (!toolCalls || toolCalls.length === 0 || !turnStartTime) return null;
  const totalMs = Date.now() - turnStartTime;
  const totalSec = Math.round(totalMs / 1000);
  const durationLabel = totalSec < 1 ? '<1s' : totalSec >= 60 ? Math.floor(totalSec / 60) + 'm' + (totalSec % 60 ? ' ' + (totalSec % 60) + 's' : '') : totalSec + 's';

  const details = document.createElement('details');
  details.className = 'activity-summary';

  const summary = document.createElement('summary');
  summary.textContent = `${toolCalls.length} step${toolCalls.length === 1 ? '' : 's'} \u00b7 ${durationLabel}`;
  details.appendChild(summary);

  const list = document.createElement('div');
  list.className = 'activity-list';
  for (const tc of toolCalls) {
    const elapsedSec = (tc.time - turnStartTime) / 1000;
    const elapsedLabel = elapsedSec >= 60 ? Math.floor(elapsedSec / 60) + 'm' + (Math.round(elapsedSec % 60) ? ' ' + Math.round(elapsedSec % 60) + 's' : '') : elapsedSec.toFixed(1) + 's';
    const row = document.createElement('div');
    row.className = 'activity-row';
    row.innerHTML = `<span class="activity-time">${elapsedLabel}</span><span class="activity-tool">${esc(formatToolShort(tc.tool))}</span>`;
    list.appendChild(row);
  }
  details.appendChild(list);
  return details;
}

let userScrolledUp = false;
function scrollBottom(force) {
  const m=document.getElementById('messages'); if(!m) return;
  if (force) { userScrolledUp = false; m.scrollTop=m.scrollHeight; return; }
  if (!userScrolledUp) m.scrollTop=m.scrollHeight;
}
// Detect when user scrolls away from the bottom during streaming
document.addEventListener('DOMContentLoaded', () => {
  const m = document.getElementById('messages');
  if (m) m.addEventListener('scroll', () => {
    const atBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 80;
    userScrolledUp = !atBottom;
  });
  initSidebarResize();
});

// Sidebar width: drag-adjustable via a handle on the inner edge, clamped,
// persisted locally as a UI preference. One width shared by every sidebar
// view (team, conversations, skills, files). Same interaction grammar as
// the file editor's review panel resize.
const SIDEBAR_WIDTH_KEY = 'rundock.sidebarWidth';
const SIDEBAR_MIN_W = 200;
const SIDEBAR_MAX_W = 480;
function initSidebarResize() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;
  const applySidebarWidth = (w) => {
    const clamped = Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, w || 280));
    document.documentElement.style.setProperty('--sidebar-width', `${clamped}px`);
    return clamped;
  };
  let width = applySidebarWidth(Number(localStorage.getItem(SIDEBAR_WIDTH_KEY)) || 280);
  const handle = document.createElement('div');
  handle.className = 'sidebar-resize-handle';
  handle.title = 'Drag to resize';
  // Hover intent: the affordance line appears only after 300ms of genuine
  // hover, so cursor transits between sidebar and content never flash it.
  let hoverTimer = null;
  handle.addEventListener('mouseenter', () => {
    hoverTimer = setTimeout(() => handle.classList.add('edge-hover'), 300);
  });
  handle.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimer);
    handle.classList.remove('edge-hover');
  });
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handle.classList.add('dragging');
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev) => { width = applySidebarWidth(startW + (ev.clientX - startX)); };
    const onUp = () => {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width)); } catch (e2) { /* private mode */ }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  sidebar.appendChild(handle);
}

// ===== 10. VIEWS & NAVIGATION =====

// Sync the nav rail's active icon and the visible sidebar panel to a section.
// This is deliberately separate from switchNav: destination functions
// (openConversation, showProfile) call it so they stay consistent no matter
// where navigation started (nav rail click, search palette, profile links,
// workspace routing). Before this existed, callers had to remember to pair
// switchNav with their navigation and several forgot, leaving the rail
// highlighting one section while the main pane showed another.
function setNavState(nav) {
  document.querySelectorAll('.nav-item[data-nav]').forEach(n=>n.classList.remove('active'));
  document.querySelector(`[data-nav="${nav}"]`)?.classList.add('active');
  ['team','conversations','skills','files','settings'].forEach(s=>document.getElementById(`sidebar-${s}`).classList.add('hidden'));
  document.getElementById(`sidebar-${nav}`).classList.remove('hidden');
}

function switchNav(nav) {
  // Find bar is a per-view affordance: close on any nav change so highlights
  // and search state don't survive into a context where they no longer make
  // sense or reference DOM that's about to be replaced.
  closeFindBar();
  setNavState(nav);
  if(nav==='settings') { showView('settings'); showSettingsSection('workspace'); }
  else if(nav==='files') {
    editorReturnView = 'editor';
    if (currentFilePath) {
      // A file is open: keep it open across the view switch (its editor/viewer
      // is still mounted, just hidden) and re-reveal it in the tree.
      showView('editor');
      highlightFileInSidebar(currentFilePath);
      updateEditorBackButton();
    } else {
      // Nothing open: show the empty state.
      destroyTiptapEditorIfActive();
      document.getElementById('editor-header').classList.add('hidden');
      document.getElementById('editor-content').classList.add('hidden');
      document.getElementById('editor-textarea').classList.add('hidden');
      document.getElementById('tiptap-editor-pane').classList.add('hidden');
      document.getElementById('editor-empty').classList.remove('hidden');
      showView('editor');
    }
  }
  else if(nav==='skills') { showView('skills'); if(!skillsLoaded) { ws.send(JSON.stringify({type:'get_skills'})); } else if(skills.length && !currentSkillId) { selectSkill(skills[0].id); } }
  else if(nav==='conversations') { if(activeConversation) { showView('chat'); if(unreadConvos.delete(activeConversation.id)) { updateUnreadBadge(); renderConvoList(); } } else { const target = pickDefaultConversation(); if(target) { openConversation(target.id); } else { newConversation(); } } }
  else if(nav==='team') { showView('home'); renderOrgChart(); }
}
function showView(v) { currentView=v; ['workspace','home','profile','chat','convo-empty','editor','skills','settings'].forEach(id=>{const e=document.getElementById(`view-${id}`);if(e){e.classList.add('hidden');e.style.display='none';e.classList.remove('main-view-transition');}}); const e=document.getElementById(`view-${v}`); if(e){e.classList.remove('hidden');e.style.display='flex';e.classList.add('main-view-transition');}  }
function goHome() { discardIfEmpty(); activeConversation=null; switchNav('conversations'); }

// Theme
function toggleTheme() { document.body.classList.toggle('light'); const isLight=document.body.classList.contains('light'); document.getElementById('theme-toggle').innerHTML=isLight?moonIcon:sunIcon; if(typeof applyHljsTheme==='function')applyHljsTheme(isLight); try{localStorage.setItem('rundock-theme',isLight?'light':'dark');}catch(e){} }
// Restore saved theme on load
try{if(localStorage.getItem('rundock-theme')==='light'){document.body.classList.add('light');document.getElementById('theme-toggle').innerHTML=moonIcon;}}catch(e){}

// ===== 11. FILE TREE & EDITOR =====

let cachedFileTree = null;

function renderFileTree(tree) {
  const c=document.getElementById('file-tree');
  const editorEmpty=document.getElementById('editor-empty');
  c.innerHTML='';
  if(!tree||!tree.length) {
    c.innerHTML=`<div style="padding:12px 16px"><div style="color:var(--text-2);font-size:var(--caption);line-height:1.6">No files yet</div></div>`;
    const guide = getGuide();
    if(editorEmpty) editorEmpty.innerHTML=`
      <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" class="empty-icon"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <div class="empty-title">No files yet</div>
      ${guide ? `<button class="empty-cta" style="margin-top:8px" onclick="startConversation('${guide.id}')">Talk to Doc</button>` : ''}`;
    return;
  }
  if(editorEmpty) editorEmpty.innerHTML=`
    <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" class="empty-icon"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
    <span style="color:var(--text-2);font-size:var(--body)">Select a file from the sidebar</span>`;
  buildTree(tree,c);
}
// Tree icons keyed by the server-provided file kind, matching the creation
// menu's entity icons (a board file shows the kanban icon, a note the note
// icon), so the tree and the "+" menu speak the same visual language.
const TREE_ICONS = {
  folder:     '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  folderOpen: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  note:  FilesMenuModel.ICONS.note,
  board: FilesMenuModel.ICONS.board,
  artifact: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 13-2 2 2 2"/><path d="m14 13 2 2-2 2"/>',
  pdf:   '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 12h4"/><path d="M10 16h2"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
  file:  '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
};
function treeIconSvg(inner) {
  return '<svg class="file-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
}
function buildTree(items,container) {
  for(const item of items) {
    if(item.type==='folder') {
      const f=document.createElement('div'); f.className='folder-item'; f.innerHTML=`${treeIconSvg(TREE_ICONS.folder)} ${esc(item.name)}`;
      f.onclick=()=>{const ch=f.nextElementSibling,svg=f.querySelector('svg.file-item-icon');const collapsed=ch.classList.toggle('collapsed');if(svg)svg.innerHTML=collapsed?TREE_ICONS.folder:TREE_ICONS.folderOpen;};
      f.oncontextmenu=(e)=>{e.preventDefault();openRowContextMenu(e,item.path,'folder');};
      container.appendChild(f);
      const ch=document.createElement('div'); ch.className='file-children collapsed'; buildTree(item.children,ch); container.appendChild(ch);
    } else {
      const fi=document.createElement('div'); fi.className='file-item';
      fi.innerHTML=`${treeIconSvg(TREE_ICONS[item.kind]||TREE_ICONS.file)} ${esc(item.name)}`;
      fi.dataset.path = item.path;
      fi.onclick=()=>{document.querySelectorAll('.file-item').forEach(x=>x.classList.remove('active'));fi.classList.add('active');editorReturnView='editor';fileHistory=[];ws.send(JSON.stringify({type:'read_file',path:item.path}));showView('editor');};
      fi.oncontextmenu=(e)=>{e.preventDefault();openRowContextMenu(e,item.path,'file');};
      container.appendChild(fi);
    }
  }
}

// ---- Files-sidebar creation menu ("+" header button and row context menu) ----
// Creatable types and path helpers live in files-menu-model.js (unit-tested);
// this is the DOM menu that consumes them.
const CREATABLE_TYPES = FilesMenuModel.CREATABLE_TYPES;
function contentForKind(kind) {
  return kind === 'board' && window.Kanban ? window.Kanban.newBoardContent() : '';
}
function menuIconSvg(inner) {
  return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" '
    + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
}

let _filesMenu = null;
function closeFilesMenu() {
  if (_filesMenu) { _filesMenu.remove(); _filesMenu = null; }
}
// Any floating menu (files or the board's lane menu) closes when this fires, so
// opening one always dismisses the others and only one is ever open.
document.addEventListener('rundock:closemenus', closeFilesMenu);
// Outside-click close in the CAPTURE phase, so a board control's
// stopPropagation (e.g. the column collapse chevron) cannot stop it. A click
// INSIDE an open menu lets that item's handler act (it closes itself); a click
// on a menu TRIGGER lets the trigger toggle itself; anything else closes.
document.addEventListener('click', (e) => {
  if (!document.querySelector('.files-menu, .board-lane-popup')) return;
  if (e.target.closest && e.target.closest('.files-menu, .board-lane-popup, #files-add-btn, .board-lane-menu-btn')) return;
  document.dispatchEvent(new CustomEvent('rundock:closemenus'));
}, true);

// A small floating menu at (x, y) built from [label, fn, icon, danger] rows
// (falsy row = a divider). Returns the menu element.
function buildFloatingMenu(x, y, rows) {
  document.dispatchEvent(new CustomEvent('rundock:closemenus')); // dismiss any other open menu first
  const menu = document.createElement('div');
  menu.className = 'files-menu';
  for (const row of rows) {
    if (!row) { const d = document.createElement('div'); d.className = 'files-menu-divider'; menu.appendChild(d); continue; }
    const [label, fn, icon, danger] = row;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'files-menu-item' + (danger ? ' danger' : '');
    btn.innerHTML = (icon ? menuIconSvg(icon) : '') + '<span>' + esc(label) + '</span>';
    btn.addEventListener('click', (e) => { e.stopPropagation(); closeFilesMenu(); fn(); });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
  _filesMenu = menu;
  return menu;
}

// Replace the menu's contents with an inline name input (the standing small-
// input composer grammar): Enter creates, Escape cancels.
function promptCreate(menu, type, folder) {
  menu.innerHTML = '';
  const field = document.createElement('div');
  field.className = 'files-menu-field';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = type.kind === 'folder' ? 'Folder name' : type.label.replace('New ', '') + ' name';
  field.appendChild(input);
  menu.appendChild(field);
  input.focus();
  const submit = () => {
    const rel = FilesMenuModel.creatablePath(folder, input.value, type.ext);
    if (!rel) { closeFilesMenu(); return; }
    ws.send(JSON.stringify({ type: 'create_path', kind: type.kind, path: rel, content: contentForKind(type.kind) }));
    closeFilesMenu();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFilesMenu(); }
  });
  // Keep the menu open while the field is focused.
}

// A creation row: opens an inline name field (keeping the chosen type's icon).
function creationRow(t, x, y, folder) {
  return [t.label, () => {
    const m = buildFloatingMenu(x, y, [[t.label, () => {}, t.icon]]);
    promptCreate(m, t, folder);
  }, t.icon];
}

// The "+" header menu: creation rows only, creating at workspace root. The
// button toggles: clicking it while the menu is open closes it (the button's
// own click fires before the outside-click handler, so without this it would
// close and immediately reopen).
function openCreateMenu(anchor, folder) {
  if (_filesMenu) { closeFilesMenu(); return; }
  const r = anchor.getBoundingClientRect();
  buildFloatingMenu(r.left, r.bottom + 4, CREATABLE_TYPES.map((t) => creationRow(t, r.left, r.bottom + 4, folder)));
}

// Right-click on a row: the same creation rows (creating IN the folder, or the
// file's parent), plus clipboard and reveal actions.
function openRowContextMenu(e, targetPath, targetKind) {
  const folder = FilesMenuModel.parentFolder(targetPath, targetKind === 'folder');
  const rows = CREATABLE_TYPES.map((t) => creationRow(t, e.clientX, e.clientY, folder));
  rows.push(null);
  rows.push(['Copy workspace path', () => { try { navigator.clipboard.writeText(targetPath); } catch (err) {} }, FilesMenuModel.ICONS.copy]);
  rows.push(['Copy wikilink', () => { try { navigator.clipboard.writeText(FilesMenuModel.wikilinkFor(targetPath)); } catch (err) {} }, FilesMenuModel.ICONS.link]);
  rows.push(['Reveal in Finder', () => ws.send(JSON.stringify({ type: 'reveal_in_finder', path: targetPath })), FilesMenuModel.ICONS.reveal]);
  buildFloatingMenu(e.clientX, e.clientY, rows);
}

// Editor
let editorMode='preview', rawFileContent='', fileFrontmatter='', fileBody='';

function loadFileContent(path, content) {
  // Close any active find before swapping the editor content.
  if (currentFilePath !== path) closeFindBar();
  flushBoardSave(); // never drop a board's last edit when switching files
  destroyActiveFileViewer();
  hideExternalEditConflict();
  currentFilePath = path;
  rawFileContent = content;
  // What we believe is on disk: the external-edit guard compares against
  // this before every save.
  diskBaselines.set(path, content);
  document.getElementById('editor-filename').textContent = path;
  document.getElementById('editor-status').textContent = '';
  document.getElementById('editor-header').classList.remove('hidden');
  document.getElementById('editor-empty').classList.add('hidden');
  updateEditorBackButton();

  // The file-type registry decides the surface for EVERY path (the FV2
  // swap: the old per-type if-chain is gone). markdown -> Tiptap editor,
  // text -> legacy preview/edit pane, artifact -> sandboxed preview with
  // the legacy code view, image/pdf -> read-only viewers over the binary
  // endpoint, anything else -> the cannot-preview state. A new file type
  // lands as one registry entry + one surface function, no dispatch edits.
  loadViewersModule().then((viewers) => {
    if (currentFilePath !== path) return; // stale: another file opened while the module loaded
    // A markdown file whose frontmatter carries the kanban-plugin key opens as
    // a board (detection is content-based, so it cannot ride the path-keyed
    // classify table); everything else dispatches by file kind.
    if (viewers.classify(path) === 'markdown' && window.Kanban && window.Kanban.isBoardFile(content)) {
      openBoardFile(path, content);
      return;
    }
    const surface = FILE_SURFACES[viewers.classify(path)] || openBinaryOrUnsupportedFile;
    surface(viewers, path, content);
  });
}

// Board view: a writable registry view. Mounts the board into the editor pane
// and wires its edits to the same guarded autosave the editor uses. Unlike the
// read-only viewers, its getContentForSave is non-null (unless the board holds
// content the grammar would drop, in which case saving is refused).
let boardSaveTimer = null;
let boardPendingSave = null; // { path, md } — the latest debounced board write
// Flush a pending board save immediately. Called before opening any file so a
// board's last edit is never dropped when switching away inside the debounce
// window (the pending save carries its own path, so it writes the right file).
function flushBoardSave() {
  if (boardSaveTimer) { clearTimeout(boardSaveTimer); boardSaveTimer = null; }
  if (boardPendingSave) {
    const p = boardPendingSave;
    boardPendingSave = null;
    saveFileGuarded(p.path, p.md);
  }
}
function openBoardFile(path, content) {
  destroyTiptapEditorIfActive();
  document.getElementById('tiptap-editor-pane').classList.add('hidden');
  document.getElementById('toggle-preview').classList.add('hidden');
  document.getElementById('toggle-edit').classList.add('hidden');
  document.getElementById('editor-textarea').classList.add('hidden');
  const pane = document.getElementById('editor-content');
  pane.classList.remove('hidden');
  pane.className = 'editor-content';
  import('./viewers/board-view.js').then((mod) => {
    if (currentFilePath !== path) return; // stale
    activeFileViewer = mod.mountBoardView({ paneElement: pane, path, content, onWikilink: (target) => openWikilink(target) }, window.Kanban);
    if (typeof activeFileViewer.setOnChange === 'function' && typeof activeFileViewer.getContentForSave === 'function') {
      activeFileViewer.setOnChange(() => {
        const md = activeFileViewer.getContentForSave();
        if (md == null) return; // save refused (droppable content)
        const status = document.getElementById('editor-status');
        if (status) { status.textContent = 'Unsaved'; status.style.color = 'var(--attention)'; }
        boardPendingSave = { path, md };
        clearTimeout(boardSaveTimer);
        boardSaveTimer = setTimeout(flushBoardSave, 500);
      });
    }
  });
}

const FILE_SURFACES = {
  markdown: openMarkdownFile,
  text: openLegacyTextFile,
  artifact: openLegacyTextFile, // preview mode mounts the sandboxed iframe from renderEditorContent
  image: openBinaryOrUnsupportedFile,
  pdf: openBinaryOrUnsupportedFile,
  unsupported: openBinaryOrUnsupportedFile,
};

// Markdown: the Tiptap surface; the legacy DOM and Preview/Edit toggle are
// hidden and the Tiptap pane is shown and seeded.
function openMarkdownFile(viewers, path, content) {
  document.getElementById('editor-content').classList.add('hidden');
  document.getElementById('editor-textarea').classList.add('hidden');
  document.getElementById('toggle-preview').classList.add('hidden');
  document.getElementById('toggle-edit').classList.add('hidden');
  document.getElementById('tiptap-editor-pane').classList.remove('hidden');
  fileFrontmatter = '';
  fileBody = content;
  initTiptapEditor(path, content);
}

// Text keeps the legacy preview/edit chrome; artifacts share it so the Code
// toggle (raw source, still editable and saveable) keeps working, with
// preview mode mounting the sandboxed iframe from renderEditorContent.
function openLegacyTextFile(viewers, path, content) {
  destroyTiptapEditorIfActive();
  document.getElementById('tiptap-editor-pane').classList.add('hidden');
  document.getElementById('toggle-preview').classList.remove('hidden');
  document.getElementById('toggle-edit').classList.remove('hidden');
  document.getElementById('editor-content').classList.remove('hidden');

  // Split frontmatter from body
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (fmMatch) {
    fileFrontmatter = '---\n' + fmMatch[1] + '\n---\n';
    fileBody = fmMatch[2];
  } else {
    fileFrontmatter = '';
    fileBody = content;
  }

  // Always open in preview mode
  editorMode = 'preview';
  renderEditorContent();
}

// Read-only viewers own the pane: no Preview/Code toggle, and no save path
// (their bytes ride /workspace-file; the WS text content for a binary file
// is utf-8-mangled and must never be written back).
function openBinaryOrUnsupportedFile(viewers, path) {
  destroyTiptapEditorIfActive();
  document.getElementById('tiptap-editor-pane').classList.add('hidden');
  document.getElementById('toggle-preview').classList.add('hidden');
  document.getElementById('toggle-edit').classList.add('hidden');
  document.getElementById('editor-textarea').classList.add('hidden');
  const pane = document.getElementById('editor-content');
  pane.classList.remove('hidden');
  pane.className = 'editor-content';
  activeFileViewer = viewers.mountViewer(viewers.classify(path), { paneElement: pane, path });
}

function renderEditorContent() {
  const previewEl = document.getElementById('editor-content');
  const textareaEl = document.getElementById('editor-textarea');
  document.getElementById('toggle-preview').classList.toggle('active', editorMode === 'preview');
  document.getElementById('toggle-edit').classList.toggle('active', editorMode === 'edit');

  if (editorMode === 'preview') {
    textareaEl.classList.add('hidden');
    previewEl.classList.remove('hidden');
    destroyActiveFileViewer();
    // Artifact files (html/svg) preview as their real rendered DOM in a
    // sandboxed iframe instead of a markdown-ish approximation.
    if (_viewersModuleResolved && _viewersModuleResolved.classify(currentFilePath) === 'artifact') {
      previewEl.className = 'editor-content';
      activeFileViewer = _viewersModuleResolved.mountArtifactPreview({ paneElement: previewEl, content: rawFileContent });
      attachArtifactReviewForCurrentFile(previewEl);
      return;
    }
    previewEl.className = 'editor-content formatted';
    previewEl.innerHTML = formatMdFull(fileBody);
  } else {
    destroyActiveFileViewer();
    previewEl.classList.add('hidden');
    textareaEl.classList.remove('hidden');
    textareaEl.className = 'editor-content source';
    textareaEl.value = rawFileContent;
    textareaEl.focus();
  }
}

function setEditorMode(mode) {
  if (mode !== editorMode && findState.open) closeFindBar(); // find backend differs per mode
  if (mode === 'preview' && editorMode === 'edit') {
    // Switching from edit to preview: capture changes first
    rawFileContent = document.getElementById('editor-textarea').value;
    const fmMatch = rawFileContent.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (fmMatch) { fileFrontmatter = '---\n' + fmMatch[1] + '\n---\n'; fileBody = fmMatch[2]; }
    else { fileFrontmatter = ''; fileBody = rawFileContent; }
  }
  editorMode = mode;
  renderEditorContent();
}

function getFileContentForSave() {
  if (editorMode === 'edit') {
    rawFileContent = document.getElementById('editor-textarea').value;
  }
  return rawFileContent;
}

// Wikilink navigation
function openWikilink(name) {
  const baseName = name.split('#')[0].trim();
  // Agents reference their outputs by wikilink: [[chart.png]] or
  // [[report.pdf]] must open the real file through the registry, not chase
  // a phantom chart.png.md. Only extensionless targets get the .md default.
  const hasViewableExt = /\.(md|mdx|txt|json|html?|svg|png|jpe?g|gif|webp|pdf)$/i.test(baseName);
  const searchName = hasViewableExt ? baseName : baseName + '.md';
  editorReturnView = 'editor';

  // Push current file onto history so back button returns to it
  if (currentFilePath) fileHistory.push(currentFilePath);
  if (fileHistory.length > 20) fileHistory.shift();

  // Search the cached file tree data (not the DOM)
  if (cachedFileTree) {
    const match = findFileInTree(cachedFileTree, searchName);
    if (match) {
      switchNav('files');
      ws.send(JSON.stringify({ type: 'read_file', path: match }));
      showView('editor');
      highlightFileInSidebar(match);
      return;
    }
  }

  // If not found in cache, ask the server directly
  if (ws) {
    ws.send(JSON.stringify({ type: 'read_file', path: searchName }));
    switchNav('files');
    showView('editor');
    highlightFileInSidebar(searchName);
  }
}

function highlightFileInSidebar(filePath) {
  document.querySelectorAll('.file-item').forEach(x => x.classList.remove('active'));
  const target = Array.from(document.querySelectorAll('.file-item')).find(fi => fi.dataset.path === filePath);
  if (!target) return;
  target.classList.add('active');
  // Reveal it: expand every collapsed ancestor folder so the highlighted file
  // is actually visible, then scroll it into view within the sidebar.
  let node = target.parentElement;
  while (node && node !== document.body) {
    if (node.classList && node.classList.contains('file-children') && node.classList.contains('collapsed')) {
      node.classList.remove('collapsed');
      const folder = node.previousElementSibling;
      const ic = folder && folder.classList.contains('folder-item') ? folder.querySelector('.folder-icon') : null;
      if (ic) ic.innerHTML = '&#x25BC;';
    }
    node = node.parentElement;
  }
  if (target.scrollIntoView) target.scrollIntoView({ block: 'nearest' });
}

function findFileInTree(items, searchName) {
  // Normalise search: could be "filename.md" or "path/to/filename.md"
  const searchLower = searchName.toLowerCase();
  const searchBase = searchName.split('/').pop().toLowerCase();

  for (const item of items) {
    if (item.type === 'file') {
      const itemPath = item.path.toLowerCase();
      const itemName = item.name.toLowerCase();
      // Exact path match
      if (itemPath === searchLower) return item.path;
      // Exact name match
      if (itemName === searchBase) return item.path;
      // Name without .md match
      if (itemName === searchBase.replace('.md', '') + '.md') return item.path;
    } else if (item.type === 'folder' && item.children) {
      const found = findFileInTree(item.children, searchName);
      if (found) return found;
    }
  }
  return null;
}

let editorReturnView = 'editor';
let fileHistory = [];

// The editor back control is only useful when "back" leads somewhere: to the
// view a file was opened from (Skills, Agents) or to the previous file in a
// wikilink chain. Opened straight from the file tree with no history, "back"
// would only blank the pane, which reads as losing your place, so it is hidden.
function updateEditorBackButton() {
  const btn = document.getElementById('editor-back');
  if (!btn) return;
  const useful = editorReturnView !== 'editor' || fileHistory.length > 0;
  btn.style.display = useful ? '' : 'none';
}

function openSkillFile(filePath) {
  editorReturnView = 'skills';
  fileHistory = [];
  ws.send(JSON.stringify({ type: 'read_file', path: filePath }));
  showView('editor');
}

function editorGoBack() {
  // If opened from another view (e.g. skills), return there
  if (editorReturnView !== 'editor') {
    showView(editorReturnView);
    editorReturnView = 'editor';
    fileHistory = [];
    return;
  }
  // If there's a previous file in history, go back to it
  if (fileHistory.length) {
    const prev = fileHistory.pop();
    ws.send(JSON.stringify({ type: 'read_file', path: prev }));
    highlightFileInSidebar(prev);
    updateEditorBackButton();
    return;
  }
  // No useful back target: this branch is now unreachable from the UI (the
  // control hides itself in that state), but keep the safe fallback.
  currentFilePath = null;
  destroyTiptapEditorIfActive();
  document.getElementById('editor-header').classList.add('hidden');
  document.getElementById('editor-content').classList.add('hidden');
  document.getElementById('editor-textarea').classList.add('hidden');
  document.getElementById('tiptap-editor-pane').classList.add('hidden');
  document.getElementById('editor-empty').classList.remove('hidden');
  document.querySelectorAll('.file-item').forEach(x => x.classList.remove('active'));
}

// ===== 12. MARKDOWN RENDERING =====

// Configure marked
marked.setOptions({ gfm: true, breaks: true });

// Syntax-highlight fenced code blocks (highlight.js, vendored locally) and wrap
// them with a header bar showing the language label and a copy button.
// Originating contributions: copy button (#6/#7) and syntax highlighting (#10/#11)
// by @dougseven; isolated and hardened here (escaped language label, clipboard
// fallback, auto-detect size cap).
const HLJS_AUTODETECT_MAX = 20000; // skip highlightAuto on very large blocks (perf)
marked.use({
  renderer: {
    code({ text, lang }) {
      let highlighted = '';
      let displayLang = '';
      const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      try {
        // Decision logic lives in code-language.js (pure, unit-tested):
        // explicit hints win, plaintext hints are first-class, unlabelled
        // blocks auto-detect over a curated subset with a relevance gate so
        // prose is never mislabelled as code (the VB.NET bug).
        const resolved = window.resolveCodeLanguage
          ? resolveCodeLanguage(lang, text, window.hljs, HLJS_AUTODETECT_MAX)
          : { html: escapeHtml(text), label: lang || '' };
        highlighted = resolved.html;
        displayLang = resolved.label;
      } catch (e) {
        highlighted = escapeHtml(text);
        displayLang = lang || '';
      }
      const langLabel = displayLang ? `<span class="code-lang">${esc(displayLang)}</span>` : '<span></span>';
      return (
        `<div class="code-block-wrapper">` +
        `<div class="code-block-header">${langLabel}` +
        `<button class="copy-code-btn" onclick="copyCode(this)" title="Copy code">${COPY_ICON}</button>` +
        `</div><pre><code class="hljs">${highlighted}</code></pre></div>`
      );
    }
  }
});

const COPY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

function copyCode(btn) {
  const codeEl = btn.closest('.code-block-wrapper')?.querySelector('code');
  if (!codeEl) return;
  const text = codeEl.textContent;
  const done = () => {
    btn.innerHTML = CHECK_ICON;
    btn.classList.add('copied');
    setTimeout(() => { btn.innerHTML = COPY_ICON; btn.classList.remove('copied'); }, 2000);
  };
  // navigator.clipboard is unavailable in non-secure contexts (e.g. VPS over http).
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => {});
  } else {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      done();
    } catch (e) { /* copy unavailable: no-op */ }
  }
}

// Swap the highlight.js theme stylesheet to match the app theme.
function applyHljsTheme(isLight) {
  const dark = document.getElementById('hljs-dark');
  const light = document.getElementById('hljs-light');
  if (dark) dark.disabled = !!isLight;
  if (light) light.disabled = !isLight;
}
applyHljsTheme(document.body.classList.contains('light'));

function renderMarkdown(text, options = {}) {
  let src = text;


  // Pre-processing: Obsidian-specific syntax (before marked processes it)

  // Obsidian comments: %%text%% - hide completely
  src = src.replace(/%%[\s\S]*?%%/g, '');

  // Wikilinks: [[file|display]] and [[file]]
  src = src.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '<a class="wikilink" onclick="openWikilink(\'$1\')">$2</a>');
  src = src.replace(/\[\[([^\]]+)\]\]/g, '<a class="wikilink" onclick="openWikilink(\'$1\')">$1</a>');

  // Highlights: ==text==
  src = src.replace(/==(.*?)==/g, '<mark>$1</mark>');

  // Tags: #tag (but not inside code blocks or headings)
  src = src.replace(/(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)/g, ' <span class="md-tag">#$1</span>');

  // Callouts: process before marked
  if (options.callouts !== false) {
    src = processCalloutsSrc(src);
  }

  // Render with marked
  let html = marked.parse(src);

  // Post-processing: clean up marked output for our styling

  // Convert relative file links to in-app wikilinks
  // Matches href values that end in .md, .yaml, .yml, .json, .txt and don't start with http/mailto/obsidian
  html = html.replace(/<a href="(?!https?:\/\/|mailto:|obsidian:\/\/)([^"]*\.(?:md|yaml|yml|json|txt))"([^>]*)>(.*?)<\/a>/g,
    (match, href, attrs, text) => `<a class="wikilink" onclick="openWikilink('${href.replace(/'/g, "\\'")}')">${text}</a>`);

  // Checkboxes: add accent colour
  html = html.replace(/<input.*?checked.*?disabled.*?>/g, '<input type="checkbox" checked disabled style="margin-right:8px;accent-color:var(--accent)">');
  html = html.replace(/<input.*?disabled.*?type="checkbox".*?>/g, '<input type="checkbox" disabled style="margin-right:8px">');

  return html;
}

function processCalloutsSrc(src) {
  // Process Obsidian callouts in raw source before marked
  // Callout: > [!type] title followed by > content
  const lines = src.split('\n');
  const result = [];
  let i = 0;

  while (i < lines.length) {
    const calloutMatch = lines[i].match(/^>\s*\[!(\w+)\]([+-])?\s*(.*)/);
    if (calloutMatch) {
      const type = calloutMatch[1].toLowerCase();
      const title = calloutMatch[3] || type.charAt(0).toUpperCase() + type.slice(1);
      const contentLines = [];
      i++;

      // Collect callout content (lines starting with >)
      while (i < lines.length && (lines[i].startsWith('>') || lines[i].trim() === '')) {
        if (lines[i].trim() === '' && i + 1 < lines.length && !lines[i + 1].startsWith('>')) break;
        let line = lines[i].replace(/^>\s?/, '');
        contentLines.push(line);
        i++;
      }

      const content = renderMarkdown(contentLines.join('\n'), { callouts: true });
      result.push(`<div class="callout callout-${type}"><div class="callout-title">${title}</div><div class="callout-content">${content}</div></div>`);
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result.join('\n');
}

// Alias for backward compatibility
function formatMd(text) { return renderMarkdown(text); }
function formatMdFull(text) { return renderMarkdown(text, { callouts: true }); }

// ===== 13. SKILLS =====

let currentSkillId = null;

function renderSkills() {
  // Progressive disclosure: hide skills nav tab when 0 skills
  const skillsNav = document.querySelector('.nav-item[data-nav="skills"]');
  if (skillsNav) {
    if (skills.length === 0) { skillsNav.style.display = 'none'; return; }
    else { skillsNav.style.display = ''; }
  }

  renderSkillsSidebar(skills);

  // Only refresh the detail panel if the user is already on the skills view.
  // Without this guard, background saves (SAVE_SKILL markers) would yank
  // the user out of the conversation and into the skills detail page.
  if (currentView === 'skills') {
    if (currentSkillId && skills.find(s => s.id === currentSkillId)) {
      selectSkill(currentSkillId);
    } else if (skills.length) {
      selectSkill(skills[0].id);
    }
  }
}

function renderSkillsSidebar(list) {
  const sidebar = document.getElementById('skills-sidebar-list');
  sidebar.innerHTML = list.map(s => `
    <div class="skill-sidebar-item${s.id === currentSkillId ? ' active' : ''}" data-skill="${s.id}" onclick="selectSkill('${s.id}')">
      <span class="skill-sidebar-name">${esc(s.name)}</span>
    </div>
  `).join('');
}

function selectSkill(id) {
  const s = skills.find(x => x.id === id);
  if (!s) return;

  currentSkillId = id;
  showView('skills');

  // Sidebar highlight
  document.querySelectorAll('.skill-sidebar-item').forEach(el => el.classList.remove('active'));
  document.querySelector(`.skill-sidebar-item[data-skill="${id}"]`)?.classList.add('active');

  // Build detail HTML using profile-* classes (matches agent profile pattern)
  const boltSvg = '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" stroke="none"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>';

  let h = `
    <div class="profile-header">
      <div class="profile-avatar skill-avatar">${boltSvg}</div>
      <div>
        <div class="profile-name">${esc(s.name)}</div>
        <div style="font-size:var(--body);color:var(--text-2)">Skill</div>
      </div>
    </div>`;

  if (s.description) {
    h += `<p class="profile-desc" style="margin-bottom:24px">${esc(s.description)}</p>`;
  }

  // Used by card
  if (s.assignedAgents.length) {
    h += `<div class="profile-card"><div class="profile-card-section">
      <div class="profile-section-label">Used by</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;padding-top:4px">`;
    for (const a of s.assignedAgents) {
      h += `<div class="agent-chip" title="View ${esc(a.name)}'s profile" onclick="switchNav('team');showProfile('${esc(a.id)}')">
        <div class="avatar sm" style="background:${a.colour}">${a.icon}</div>
        <div>
          <div class="agent-chip-name">${esc(a.name)}</div>
          <div class="agent-chip-role">${esc(a.role || '')}</div>
        </div>
      </div>`;
    }
    h += `</div></div></div>`;
  } else {
    const guide = getGuide();
    h += `<div class="profile-card"><div class="profile-card-section">
      <div class="profile-section-label">Used by</div>
      <div class="profile-card-text" style="padding-top:4px">Available to all agents</div>
      <div style="margin-top:8px;font-size:var(--caption);color:var(--text-2);line-height:1.5">
        Want to assign this to a specific agent?
        ${guide ? `<span style="font-size:var(--caption);font-weight:500;color:var(--accent);cursor:pointer" onclick="startConversation('${guide.id}')" title="Open a conversation with Doc">Talk to Doc</span>.` : ''}
      </div>
    </div></div>`;
  }

  // Collapsible instructions card
  if (s.instructions) {
    const instructionsId = `skill-instructions-${s.id}`;
    h += `<div class="profile-card" style="cursor:pointer" onclick="document.getElementById('${instructionsId}').classList.toggle('hidden')">
      <div class="profile-card-section">
        <div class="profile-section-label">Instructions &#9662;</div>
        <div id="${instructionsId}" class="hidden">
          <div style="font-size:var(--caption);line-height:1.6;white-space:pre-wrap;max-height:400px;overflow-y:auto;color:var(--text-2);padding-top:8px">${esc(s.instructions)}</div>
        </div>
      </div>
    </div>`;
  }

  const detail = document.getElementById('skill-detail-content');
  detail.innerHTML = h;
  detail.scrollTop = 0;
}

// ===== 14. SETTINGS =====

function showSettingsSection(section) {
  document.querySelectorAll('.settings-nav-item').forEach(el => el.classList.remove('active'));
  document.querySelector(`.settings-nav-item[data-settings="${section}"]`)?.classList.add('active');
  renderSettingsSection(section);
}

function renderSettingsSection(section) {
  const el = document.getElementById('settings-content');
  if (section === 'workspace') {
    const agentCount = agents.filter(a => a.status === 'onTeam').length;
    const skillCount = skills.length;
    const isCode = workspaceMode === 'code';
    const modeDesc = isCode
      ? 'Agents can write any file type and run commands without approval.'
      : 'Agents work with documents only. Terminal commands need approval.';
    el.innerHTML = `<div class="settings-section-title">Workspace</div>
      <div class="settings-card">
        <div class="settings-row">
          <span class="settings-label">Path</span>
          <span class="settings-value" title="${esc(currentWorkspacePath || 'Not set')}">${esc(currentWorkspacePath || 'Not set')}</span>
        </div>
        <div class="settings-row">
          <span class="settings-label">Agents</span>
          <span class="settings-value">${agentCount}</span>
        </div>
        <div class="settings-row">
          <span class="settings-label">Skills</span>
          <span class="settings-value">${skillCount}</span>
        </div>
      </div>
      <div class="settings-card">
        <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:12px">
          <span class="settings-label">Mode</span>
          <div class="mode-toggle">
            <button class="mode-toggle-btn${isCode ? '' : ' active'}" data-mode="knowledge" onclick="setWorkspaceMode('knowledge')">Knowledge mode</button>
            <button class="mode-toggle-btn${isCode ? ' active' : ''}" data-mode="code" onclick="setWorkspaceMode('code')">Code mode</button>
          </div>
          <div class="mode-description" id="mode-description">${modeDesc}</div>
        </div>
      </div>
      <div class="settings-card" id="runtimes-card">${runtimesCardHtml()}</div>
      <button class="settings-btn" onclick="changeWorkspace()">Change workspace</button>`;
    // Refresh runtime state whenever the card becomes visible (the user may
    // have just installed or signed in to a CLI).
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'get_runtime_status' }));
  } else if (section === 'appearance') {
    const isLight = document.body.classList.contains('light');
    el.innerHTML = `<div class="settings-section-title">Appearance</div>
      <div class="settings-card">
        <div class="settings-row">
          <span class="settings-label">Theme</span>
          <button class="settings-btn" onclick="toggleTheme();renderSettingsSection('appearance')">${isLight ? 'Switch to Dark' : 'Switch to Light'}</button>
        </div>
      </div>`;
  } else if (section === 'about') {
    el.innerHTML = `<div class="settings-section-title">About</div>
      <div class="settings-card">
        <div class="settings-row">
          <span class="settings-label">Version</span>
          <span class="settings-value" style="font-family:inherit">${window._rundockVersion || 'unknown'}</span>
        </div>
        <div class="settings-row">
          <span class="settings-label">Feedback</span>
          <a href="https://github.com/liamdarmody/rundock/issues" target="_blank" rel="noopener" style="font-size:var(--caption);color:var(--accent);text-decoration:underline;text-underline-offset:2px">Report an issue</a>
        </div>
      </div>`;
  }
}

function setWorkspaceMode(mode) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'set_workspace_mode', mode }));
}

// ── Runtimes card (settings › workspace) ──
// One row per runtime with a unified status vocabulary. Status chips never
// claim which plan backs the credentials (detection is presence-only); plan
// language lives in the guidance copy. When Codex is absent, the guidance IS
// the hint, and it appears nowhere else in the product.
function runtimeRowHtml(label, st, isDefault) {
  // Each state carries a hover tooltip explaining the evidence behind it:
  // detection only checks what exists on disk (the CLI, its sign-in
  // credentials) and claims nothing it cannot see. "Installed" in grey is
  // deliberate: it means the CLI is present and sign-in state is unknown,
  // not that something is wrong.
  let dot, text, tip;
  if (!st || !st.installed) {
    dot = 'var(--idle)'; text = 'Not installed';
    tip = 'The CLI for this runtime was not found on this machine.';
  } else if (st.authenticated === false) {
    dot = 'var(--attention)'; text = 'Not signed in';
    tip = 'The CLI is installed, but no sign-in credentials were found on this machine. Run its login command to sign in.';
  } else if (st.authenticated === true) {
    dot = 'var(--success)'; text = 'Signed in' + (st.version ? ' · v' + esc(st.version) : '');
    tip = 'The CLI is installed and sign-in credentials were found on this machine. Rundock checks that credentials exist; it never reads them.';
  } else {
    dot = 'var(--idle)'; text = 'Installed' + (st.version ? ' · v' + esc(st.version) : ''); // auth unknown: claim nothing
    tip = 'The CLI is installed. Rundock cannot tell whether it is signed in, so it makes no claim either way. Agents on this runtime may still work.';
  }
  return `<div class="settings-row"><span class="settings-label">${label}</span>` +
    `<span class="runtime-chip" title="${esc(tip)}" style="cursor:help">${isDefault ? '<span class="runtime-default">Default</span>' : ''}` +
    `<span class="runtime-dot" style="background:${dot}"></span>${text}</span></div>`;
}

function runtimesCardHtml() {
  if (!runtimeStatus) {
    return `<div class="settings-row"><span class="settings-label">Runtimes</span><span class="settings-value" style="font-family:inherit">Checking...</span></div>`;
  }
  let h = runtimeRowHtml('Claude Code', runtimeStatus.claude, runtimeStatus.defaultRuntime === 'claude');
  h += runtimeRowHtml('Codex', runtimeStatus.codex, runtimeStatus.defaultRuntime === 'codex');
  const cx = runtimeStatus.codex || {};
  if (cx.installed && cx.authenticated === false) {
    h += `<div class="runtime-guidance">Run <code>codex login</code> once. Your ChatGPT plan covers your agents via the official Codex CLI (July 2026).</div>`;
  } else if (!cx.installed) {
    h += `<div class="runtime-guidance">Want agents on your ChatGPT plan? Install the official Codex CLI, then sign in: <code>npm install -g @openai/codex</code> then <code>codex login</code></div>`;
  }
  // windowsSandbox is only ever a boolean on Windows (null elsewhere), so
  // this guidance self-limits to Windows machines. Without the native
  // sandbox declared, Codex file writes arrive as approval cards; with it,
  // agents write directly inside the sandbox, as on macOS.
  if (cx.installed && cx.windowsSandbox === false) {
    h += `<div class="runtime-guidance">Codex agents currently request each file write for your approval. For direct sandboxed writes, add to your Codex config (<code>%USERPROFILE%\\.codex\\config.toml</code>):<br><code>[windows]</code><br><code>sandbox = "unelevated"</code></div>`;
  }
  return h;
}

function renderRuntimesCard() {
  const el = document.getElementById('runtimes-card');
  if (el) el.innerHTML = runtimesCardHtml();
}

function changeWorkspace() {
  ws.send(JSON.stringify({ type: 'list_workspaces' }));
}

// ===== 15. WORKSPACE PICKER =====

function handleWorkspaces(d) {
  if (d.current) {
    // Server already has a workspace set (env var or previous selection)
    onWorkspaceReady(d.current, d.analysis, d.isEmpty, d.workspaceMode, d.scaffoldError, d.setupComplete);
    return;
  }
  // No workspace set, show picker
  showWorkspacePicker(d.recent || [], d.discovered || []);
}

function showWorkspacePicker(recent, discovered) {
  // Hide nav and sidebar when picking workspace
  document.querySelector('.nav-rail').style.display = 'none';
  document.querySelector('.sidebar').style.display = 'none';
  showView('workspace');
  // Reset create form
  const createBtn = document.getElementById('create-workspace-btn');
  const createForm = document.getElementById('create-workspace-form');
  if (createBtn) createBtn.style.display = '';
  if (createForm) createForm.style.display = 'none';

  const recentEl = document.getElementById('workspace-recent');
  const discoveredEl = document.getElementById('workspace-discovered');

  const wsCard = (name, subtitle, path) =>
    `<div class="ws-pick-item ws-card" data-ws-path="${esc(path)}">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" style="color:var(--text-2);flex-shrink:0"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <div class="ws-card-body">
        <div class="ws-card-name">${esc(name)}</div>
        <div class="ws-card-subtitle">${subtitle}</div>
      </div>
    </div>`;

  if (recent.length) {
    recentEl.innerHTML = `<div class="section-label" style="margin-bottom:8px;text-align:left">Recent</div>` +
      recent.map(r => wsCard(r.name, esc(r.path), r.path)).join('');
  } else {
    recentEl.innerHTML = '';
  }

  if (discovered.length) {
    const recentPaths = new Set(recent.map(r => r.path));
    const newDiscovered = discovered.filter(d => !recentPaths.has(d.path));
    if (newDiscovered.length) {
      discoveredEl.innerHTML = `<div class="section-label" style="margin-bottom:8px;text-align:left">Discovered</div>` +
        newDiscovered.map(d => wsCard(d.name, `${d.agentCount} agent${d.agentCount !== 1 ? 's' : ''}${d.hasRundockFrontmatter ? '' : ' (needs setup)'}`, d.path)).join('');
    } else {
      discoveredEl.innerHTML = '';
    }
  } else {
    discoveredEl.innerHTML = '';
  }
}

function selectWorkspace(dir) {
  const errEl = document.getElementById('workspace-error');
  if (errEl) errEl.style.display = 'none';
  ws.send(JSON.stringify({ type: 'set_workspace', path: dir }));
}

// Delegated click handler for workspace picker items (avoids inline path escaping)
document.addEventListener('click', e => {
  const item = e.target.closest('.ws-pick-item');
  if (item && item.dataset.wsPath) selectWorkspace(item.dataset.wsPath);
});

// Delegated click handler for prompt pills
document.addEventListener('click', e => {
  const pill = e.target.closest('.prompt-pill');
  if (pill && pill.dataset.prompt) sendPrompt(pill.dataset.prompt);
});

function showCreateForm() {
  document.getElementById('ws-picker-buttons').style.display = 'none';
  document.getElementById('create-workspace-form').style.display = 'block';
  document.getElementById('create-workspace-name').focus();
}

function createWorkspace() {
  const input = document.getElementById('create-workspace-name');
  const name = input.value.trim();
  if (!name) return;
  const errEl = document.getElementById('workspace-error');
  if (errEl) errEl.style.display = 'none';
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (errEl) { errEl.textContent = 'Not connected. Reconnecting...'; errEl.style.display = 'block'; }
    return;
  }
  ws.send(JSON.stringify({ type: 'create_workspace', name }));
}

async function openFolder() {
  const errEl = document.getElementById('workspace-error');
  if (errEl) errEl.style.display = 'none';

  if (window.electronAPI && window.electronAPI.selectDirectory) {
    // Electron: native folder picker
    const dir = await window.electronAPI.selectDirectory();
    if (dir) selectWorkspace(dir);
  } else {
    // Browser: ask server to open native macOS folder picker
    ws.send(JSON.stringify({ type: 'pick_folder' }));
  }
}

function onWorkspaceReady(dir, analysis, isEmpty, mode, scaffoldError, isSetupComplete) {
  const isSameWorkspace = (currentWorkspacePath === dir);
  currentWorkspacePath = dir;
  workspaceAnalysis = analysis || null;
  workspaceIsEmpty = !!isEmpty;
  workspaceMode = mode || 'knowledge';
  setupComplete = isSetupComplete !== undefined ? !!isSetupComplete : true;

  // Handle scaffold error for new workspaces
  if (scaffoldError) {
    console.warn('[Workspace] Scaffold error:', scaffoldError);
  }
  // Show nav and sidebar
  document.querySelector('.nav-rail').style.display = '';
  document.querySelector('.sidebar').style.display = '';
  // Load workspace data
  ws.send(JSON.stringify({ type: 'get_agents' }));
  ws.send(JSON.stringify({ type: 'get_files' }));
  ws.send(JSON.stringify({ type: 'get_skills' }));
  ws.send(JSON.stringify({ type: 'get_conversations' }));
  ws.send(JSON.stringify({ type: 'get_lists' }));
  ws.send(JSON.stringify({ type: 'get_runtime_status' }));
  skillsLoaded = false;
  currentSkillId = null;

  if (isSameWorkspace && currentView !== 'workspace') {
    // Reconnect to same workspace: keep in-memory conversations and active view intact.
    // Processing state will be reconciled by the active_processes message from the server.
    return;
  }

  // Different workspace: reset everything
  conversations = [];
  conversationsLoaded = false;
  activeSidebarPill = 'all';
  convoLists = [];
  renderListPills();
  ['all','unread'].forEach(p => document.getElementById('pill-' + p)?.classList.toggle('active', p === 'all'));
  activeConversation = null;
  // Clear per-conversation client state that keys by convoId. Leftover entries
  // from the previous workspace can leak into nav rail indicators (unread dot,
  // working dot) even though the convoIds no longer exist in this workspace.
  unreadConvos.clear();
  workingConvos.clear();
  for (const key of Object.keys(convoState)) delete convoState[key];
  // Reconcile the nav rail badge DOM elements now that the Sets are empty.
  updateUnreadBadge();
  updateWorkingBadge();
  const cs = document.getElementById('chat-status');
  if (cs) { cs.textContent = ''; cs.classList.remove('working'); }
  // Activate conversations sidebar; handlePersistedConversations will
  // open a pinned conversation or newConversation() once data arrives.
  document.querySelectorAll('.nav-item[data-nav]').forEach(n=>n.classList.remove('active'));
  document.querySelector('[data-nav="conversations"]')?.classList.add('active');
  ['team','conversations','skills','files','settings'].forEach(s=>document.getElementById(`sidebar-${s}`).classList.add('hidden'));
  document.getElementById('sidebar-conversations').classList.remove('hidden');
  // Hide the workspace picker immediately, but do not show any view yet.
  // handlePersistedConversations will pick the right destination (chat for
  // an existing pinned/processing conversation, convo-empty for a populated
  // workspace with no conversations to resume, or the team sidebar for a
  // fresh workspace) once the get_conversations reply lands. Until then the
  // main panel stays blank: blank reads as "loading" rather than as
  // "you have nothing here", which is what showing convo-empty prematurely
  // signalled to users with established conversations.
  const workspaceView = document.getElementById('view-workspace');
  if (workspaceView) {
    workspaceView.classList.add('hidden');
    workspaceView.style.display = 'none';
    workspaceView.classList.remove('main-view-transition');
  }
  currentView = null;
}

// ===== 16. EVENT LISTENERS & INIT =====

// Editor save
let saveTimer=null;
document.addEventListener('input',e=>{if((e.target.id==='editor-content'||e.target.id==='editor-textarea')&&currentFilePath&&editorMode==='edit'){document.getElementById('editor-status').textContent='Unsaved';document.getElementById('editor-status').style.color='var(--attention)';clearTimeout(saveTimer);saveTimer=setTimeout(()=>{saveFileGuarded(currentFilePath,getFileContentForSave());},1500);}});
const msgInput = document.getElementById('msg-input');
msgInput.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}});
msgInput.addEventListener('input',()=>{
  msgInput.style.height='auto'; msgInput.style.height=Math.min(msgInput.scrollHeight, 200)+'px';
  const btn=document.getElementById('send-btn');
  if(!btn.classList.contains('cancel')) {
    if(msgInput.value.trim()) btn.classList.add('active'); else btn.classList.remove('active');
  }
});

// Enter submits workspace picker form
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && currentView === 'workspace' && document.activeElement?.id === 'create-workspace-name') {
    createWorkspace();
  }
});

// Cmd+S / Ctrl+S force-saves the active Tiptap editor, bypassing the
// debounce. Only fires when the Tiptap editor is the active surface.
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's' && activeTiptapEditor) {
    e.preventDefault();
    clearTimeout(_tiptapSaveTimer);
    saveTiptapFile();
  }
});

// ===== 17. IN-VIEW FIND BAR (Cmd+F / Ctrl+F) =====
//
// Single find-bar UI dispatched to one of three backends based on the active
// view:
//   - 'conversation'    : text-node walk + Range surroundContents on .msg-bubble
//   - 'tiptap'          : ProseMirror decoration plugin (Step 5, separate file)
//   - 'legacy-preview'  : same text-node walk as conversation, different root
//
// Find bar is mounted once in index.html (#find-bar) and shown/hidden via the
// .hidden class. State lives in findState below; backends share the
// navigation/scroll/clear interface and only differ in how matches are
// discovered and visually marked.

const findState = {
  open: false,
  query: '',
  matches: [],          // <mark> elements for DOM backends
  currentIndex: 0,
  backend: null,        // 'conversation' | 'tiptap' | 'legacy-preview' | 'artifact' | 'textarea' | null
  inputTimer: null,
  _propCount: 0,        // tiptap backend: leading matches that are properties-panel DOM marks
};

function isFindHotkey(e) {
  return (e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'f' || e.key === 'F');
}

function detectFindBackend() {
  // Return the active view's search backend, or null if find shouldn't
  // activate (e.g. workspace picker, settings, no file open).
  if (currentView === 'chat' && activeConversation) return 'conversation';
  if (currentView === 'editor' && activeTiptapEditor) return 'tiptap';
  if (currentView === 'editor' && currentFilePath) {
    // Artifact preview: the rendered HTML/SVG lives in the sandboxed iframe,
    // which the host DOM walker cannot reach. Only the artifact viewer sets
    // handle.iframe (the PDF viewer does not), so this gates on real preview.
    if (typeof editorMode !== 'undefined' && editorMode === 'preview'
        && activeFileViewer && activeFileViewer.iframe) return 'artifact';
    // Source-edit view (Code toggle) puts the raw source in the textarea.
    const ta = document.getElementById('editor-textarea');
    if (typeof editorMode !== 'undefined' && editorMode === 'edit'
        && ta && !ta.classList.contains('hidden')) return 'textarea';
    return 'legacy-preview';
  }
  return null;
}

function openFindBar() {
  const bar = document.getElementById('find-bar');
  const input = document.getElementById('find-input');
  if (!bar || !input) return;
  if (findState.open) {
    // Already open: re-focus and select so a second Cmd+F lets the user
    // refine their query (matches Chrome's behaviour).
    input.focus();
    input.select();
    return;
  }
  const backend = detectFindBackend();
  if (!backend) return;
  findState.open = true;
  findState.backend = backend;
  findState.matches = [];
  findState._propCount = 0;
  findState.currentIndex = 0;
  findState.query = '';
  bar.classList.remove('hidden');
  input.value = '';
  input.focus();
  updateFindCount();
  updateFindButtons();
}

function closeFindBar() {
  if (!findState.open) return;
  removeTextareaOverlay(); // tear down the source-view highlight layer, if any
  clearFindMatches();
  findState.open = false;
  findState.backend = null;
  findState.query = '';
  findState.matches = [];
  findState.currentIndex = 0;
  const bar = document.getElementById('find-bar');
  const count = document.getElementById('find-count');
  if (bar) bar.classList.add('hidden');
  if (count) {
    count.textContent = '';
    count.classList.remove('no-results');
  }
}

function clearFindMatches() {
  // Unwrap every <mark.find-match>, restoring original text nodes. Covers the
  // conversation and legacy-preview backends AND the properties-panel marks
  // that ride alongside the tiptap backend. Safe no-op when none exist.
  const marks = document.querySelectorAll('mark.find-match');
  if (marks.length) {
    const parents = new Set();
    marks.forEach(mark => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parents.add(parent);
    });
    parents.forEach(p => p.normalize());
  }
  if (findState.backend === 'tiptap') {
    // Tiptap backend: clear the find plugin's state, which empties the
    // decoration set. Document content is never touched.
    if (_tiptapEditorModuleResolved && activeTiptapEditor) {
      _tiptapEditorModuleResolved.clearFind(activeTiptapEditor);
    }
  } else if (findState.backend === 'artifact') {
    clearArtifactFind();
  }
  // (textarea backend leaves the browser selection in place; nothing to unwrap)
  findState.matches = [];
  findState._propCount = 0;
  findState.currentIndex = 0;
}

function runFindSearch(query) {
  clearFindMatches();
  findState.query = query || '';
  if (!findState.query) {
    updateFindCount();
    updateFindButtons();
    return;
  }
  if (findState.backend === 'conversation') {
    searchDomSubtree(document.getElementById('messages'), query, parent => {
      const bubble = parent.closest && parent.closest('.msg-bubble');
      if (!bubble) return false;
      // Bubbles inside system, tool, and delegation rows should not match.
      return !!bubble.closest('.msg-user, .msg-agent');
    });
  } else if (findState.backend === 'legacy-preview') {
    const root = document.getElementById('editor-content');
    if (root && !root.classList.contains('hidden')) {
      searchDomSubtree(root, query, () => true);
    }
  } else if (findState.backend === 'artifact') {
    runArtifactFind(query);
  } else if (findState.backend === 'textarea') {
    runTextareaFind(query);
  } else if (findState.backend === 'tiptap') {
    if (_tiptapEditorModuleResolved && activeTiptapEditor) {
      // The frontmatter properties panel lives OUTSIDE the ProseMirror doc,
      // so the find plugin cannot see it. Search it as DOM marks first, then
      // the body via the plugin, and present one unified ordered match list:
      // [properties marks..., body matches...].
      let propMarks = [];
      const propRoot = document.getElementById('tiptap-properties');
      if (propRoot && propRoot.classList.contains('visible')) {
        searchDomSubtree(propRoot, query, () => true); // pushes <mark> into findState.matches
        propMarks = findState.matches.slice();
      }
      _tiptapEditorModuleResolved.setFindQuery(activeTiptapEditor, query);
      const tipState = _tiptapEditorModuleResolved.getFindState(activeTiptapEditor);
      // Placeholders for body matches: the real positions live in the plugin.
      findState.matches = propMarks.concat(tipState.matches.map(() => ({ tiptap: true })));
      findState._propCount = propMarks.length;
      findState.currentIndex = 0;
    }
  }
  if (findState.matches.length) {
    setCurrentFindMatch(0);
  }
  updateFindCount();
  updateFindButtons();
}

// Walks all text nodes under root, applies the predicate to each text node's
// parent element to decide whether to search it, and wraps every match in a
// <mark class="find-match"> via the Range API. Matches accumulate into
// findState.matches in DOM order.
function searchDomSubtree(root, query, predicate) {
  if (!root || !query) return;
  const lowerQuery = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      // Don't re-wrap inside an existing match (defensive).
      if (parent.closest('mark.find-match')) return NodeFilter.FILTER_REJECT;
      return predicate(parent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const textNodes = [];
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);

  for (const textNode of textNodes) {
    const text = textNode.nodeValue;
    const lower = text.toLowerCase();
    const positions = [];
    let pos = 0;
    while (true) {
      const idx = lower.indexOf(lowerQuery, pos);
      if (idx === -1) break;
      positions.push({ start: idx, end: idx + lowerQuery.length });
      // Advance by query length; do not advance by 0 even on empty (guarded above).
      pos = idx + lowerQuery.length;
    }
    if (!positions.length) continue;
    // Wrap from right to left so earlier offsets stay valid against the
    // shrinking text node. Collect in left-to-right order for findState.matches.
    const nodeMarks = new Array(positions.length);
    for (let i = positions.length - 1; i >= 0; i--) {
      const { start, end } = positions[i];
      try {
        const range = document.createRange();
        range.setStart(textNode, start);
        range.setEnd(textNode, end);
        const mark = document.createElement('mark');
        mark.className = 'find-match';
        range.surroundContents(mark);
        nodeMarks[i] = mark;
      } catch (err) {
        // Range / surroundContents can fail if the node was mutated mid-walk.
        // Skip this position silently.
        nodeMarks[i] = null;
      }
    }
    for (const m of nodeMarks) if (m) findState.matches.push(m);
  }
}

// ----- artifact-frame backend: find inside the sandboxed HTML/SVG preview.
// The preview iframe carries sandbox="allow-same-origin"
// with NO allow-scripts, so the host can read its contentDocument (the same
// grant the review loop uses) but the artifact still cannot run code. Find
// walks that document and paints matches with the CSS Custom Highlight API:
// it never splits or wraps the content DOM (unlike <mark> highlighting), so it
// never collides with the review loop's <mark> wraps and needs no re-index.
// The only node added is one idempotent <style> in the frame head (the same
// technique the review loop uses for its mark styles). No sandbox change is
// made; the posture is identical to shipped code.
const artifactFind = { win: null, doc: null, ranges: [] };
const ARTIFACT_FIND_STYLE_ID = 'rundock-find-frame-style';

function frameTextIndex(root) {
  const doc = root.ownerDocument;
  // Skip text inside script/style/etc: it is not visible, so matching it would
  // inflate the count and scroll to a zero-rect target. (head is already out
  // of scope: the walk is body-rooted.)
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (parent && parent.closest('script, style, noscript, template')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let text = '';
  let n;
  while ((n = walker.nextNode())) { nodes.push({ node: n, start: text.length }); text += n.nodeValue; }
  return { text, nodes };
}

function frameRangeFor(doc, index, start, end) {
  const nodeAt = (offset, isEnd) => {
    // The end boundary belongs to the node containing offset-1 so a span
    // ending on a node border does not spill into the next node.
    const probe = isEnd ? offset - 1 : offset;
    let entry = index.nodes[0];
    for (const e of index.nodes) { if (e.start > probe) break; entry = e; }
    return { node: entry.node, offset: offset - entry.start };
  };
  const s = nodeAt(start, false);
  const e = nodeAt(end, true);
  const range = doc.createRange();
  range.setStart(s.node, s.offset);
  range.setEnd(e.node, e.offset);
  return range;
}

function ensureArtifactFindStyle(doc) {
  if (doc.getElementById(ARTIFACT_FIND_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = ARTIFACT_FIND_STYLE_ID;
  // Decoration only (no geometry), matching the review-mark discipline.
  style.textContent =
    '::highlight(rundock-find){background:rgba(232,168,76,0.30);}' +
    '::highlight(rundock-find-current){background:rgba(232,122,90,0.55);color:#000;}';
  doc.head.appendChild(style);
}

function runArtifactFind(query) {
  const iframe = activeFileViewer && activeFileViewer.iframe;
  const doc = iframe && iframe.contentDocument;
  artifactFind.win = doc && doc.defaultView;
  artifactFind.doc = doc;
  artifactFind.ranges = [];
  if (!doc || !doc.body || !query) return;
  ensureArtifactFindStyle(doc);
  const index = frameTextIndex(doc.body);
  const hay = index.text.toLowerCase();
  const needle = query.toLowerCase();
  let pos = 0;
  while (true) {
    const i = hay.indexOf(needle, pos);
    if (i === -1) break;
    try { artifactFind.ranges.push(frameRangeFor(doc, index, i, i + needle.length)); } catch (e) {}
    pos = i + needle.length;
  }
  findState.matches = artifactFind.ranges.map(() => ({ artifact: true }));
}

function paintArtifactHighlights(currentIdx) {
  const win = artifactFind.win;
  if (!win || !win.CSS || !win.CSS.highlights || typeof win.Highlight !== 'function') return;
  win.CSS.highlights.delete('rundock-find');
  win.CSS.highlights.delete('rundock-find-current');
  const rest = [];
  const cur = [];
  artifactFind.ranges.forEach((r, i) => { (i === currentIdx ? cur : rest).push(r); });
  if (rest.length) win.CSS.highlights.set('rundock-find', new win.Highlight(...rest));
  if (cur.length) win.CSS.highlights.set('rundock-find-current', new win.Highlight(...cur));
}

function clearArtifactFind() {
  const win = artifactFind.win;
  if (win && win.CSS && win.CSS.highlights) {
    win.CSS.highlights.delete('rundock-find');
    win.CSS.highlights.delete('rundock-find-current');
  }
  artifactFind.ranges = [];
}

function scrollArtifactMatch(idx) {
  const win = artifactFind.win;
  const range = artifactFind.ranges[idx];
  if (!win || !range) return;
  try {
    const rect = range.getBoundingClientRect();
    const target = rect.top + (win.scrollY || 0) - (win.innerHeight || 0) / 2;
    win.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  } catch (e) {}
}

// ----- textarea backend: find in the HTML/text source-edit view.
// A textarea cannot carry per-match marks, and Chromium does not paint an
// UNFOCUSED textarea's selection, so matches are painted by a highlight overlay
// laid behind the textarea: a div that mirrors the textarea's exact text layout
// and wraps each match in a <mark> whose background shows through the textarea's
// transparent background. The overlay's marks use the class find-hl (not
// find-match) so the generic find-clear pass never unwraps them.
const textareaFind = { el: null, positions: [], overlay: null, prevParentPos: undefined };

function runTextareaFind(query) {
  const ta = document.getElementById('editor-textarea');
  textareaFind.el = ta;
  textareaFind.positions = [];
  if (!ta || !query) { updateTextareaOverlay(0); return; }
  const hay = ta.value.toLowerCase();
  const needle = query.toLowerCase();
  let pos = 0;
  while (true) {
    const i = hay.indexOf(needle, pos);
    if (i === -1) break;
    textareaFind.positions.push({ start: i, end: i + needle.length });
    pos = i + needle.length;
  }
  findState.matches = textareaFind.positions.map(() => ({ textarea: true }));
  updateTextareaOverlay(0);
}

function escapeOverlay(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Lay (or reuse) a layout-mirroring overlay behind the textarea and render the
// matches into it, with the current match emphasised.
function updateTextareaOverlay(currentIdx) {
  const ta = textareaFind.el || document.getElementById('editor-textarea');
  if (!ta) return;
  if (!textareaFind.positions.length) { removeTextareaOverlay(); return; }
  let overlay = textareaFind.overlay;
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'textarea-find-overlay';
    ta.parentElement.insertBefore(overlay, ta); // behind the textarea in paint order
    textareaFind.overlay = overlay;
    textareaFind.prevParentPos = ta.parentElement.style.position;
    if (getComputedStyle(ta.parentElement).position === 'static') ta.parentElement.style.position = 'relative';
    ta.style.position = 'relative';
    ta.style.zIndex = '1';
    ta._overlaySync = () => { if (textareaFind.overlay) { textareaFind.overlay.scrollTop = ta.scrollTop; textareaFind.overlay.scrollLeft = ta.scrollLeft; } };
    ta.addEventListener('scroll', ta._overlaySync);
  }
  // Mirror every style that affects where each character lands, and the box.
  const cs = getComputedStyle(ta);
  // wordBreak/overflowWrap are left to the overlay's own CSS (anywhere) so a
  // long unbreakable line wraps like the textarea's soft wrap rather than
  // overflowing; everything else that moves a glyph is mirrored.
  const mirror = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing',
    'whiteSpace', 'tabSize', 'textAlign', 'textIndent',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing'];
  for (const p of mirror) overlay.style[p] = cs[p];
  overlay.style.top = ta.offsetTop + 'px';
  overlay.style.left = ta.offsetLeft + 'px';
  overlay.style.width = ta.offsetWidth + 'px';
  overlay.style.height = ta.offsetHeight + 'px';

  const text = ta.value;
  let html = '';
  let last = 0;
  textareaFind.positions.forEach((p, i) => {
    html += escapeOverlay(text.slice(last, p.start));
    html += `<mark class="find-hl${i === currentIdx ? ' current' : ''}">` + escapeOverlay(text.slice(p.start, p.end)) + '</mark>';
    last = p.end;
  });
  html += escapeOverlay(text.slice(last)) + '\n'; // trailing newline: match textarea's own extra line box
  overlay.innerHTML = html;
  overlay.scrollTop = ta.scrollTop;
  overlay.scrollLeft = ta.scrollLeft;
}

function removeTextareaOverlay() {
  const ta = textareaFind.el || document.getElementById('editor-textarea');
  if (ta) {
    if (ta._overlaySync) { ta.removeEventListener('scroll', ta._overlaySync); ta._overlaySync = null; }
    ta.style.position = '';
    ta.style.zIndex = '';
    if (ta.parentElement && textareaFind.prevParentPos !== undefined) ta.parentElement.style.position = textareaFind.prevParentPos;
  }
  textareaFind.prevParentPos = undefined;
  if (textareaFind.overlay) { textareaFind.overlay.remove(); textareaFind.overlay = null; }
}

function scrollTextareaMatch(idx) {
  const ta = textareaFind.el;
  const p = textareaFind.positions[idx];
  if (!ta || !p) return;
  const before = ta.value.slice(0, p.start);
  const line = before.split('\n').length - 1;
  const cs = getComputedStyle(ta);
  const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 14) * 1.5;
  ta.scrollTop = Math.max(0, line * lh - ta.clientHeight / 2);
  updateTextareaOverlay(idx); // re-emphasise the current match and re-sync scroll
}

function setCurrentFindMatch(idx) {
  findState.currentIndex = idx;
  if (findState.backend === 'artifact') {
    paintArtifactHighlights(idx);
    scrollArtifactMatch(idx);
    updateFindCount();
    return;
  }
  if (findState.backend === 'textarea') {
    scrollTextareaMatch(idx);
    updateFindCount();
    return;
  }
  if (findState.backend === 'tiptap') {
    const propCount = findState._propCount || 0;
    if (idx < propCount) {
      // A properties-panel match is current: clear the body's current mark
      // (the -1 sentinel keeps its other matches visible) and highlight the
      // DOM mark directly.
      if (_tiptapEditorModuleResolved && activeTiptapEditor) {
        _tiptapEditorModuleResolved.setFindIndex(activeTiptapEditor, -1);
      }
      for (let i = 0; i < propCount; i++) {
        const m = findState.matches[i];
        if (m && m.classList) m.classList.toggle('current', i === idx);
      }
      const target = findState.matches[idx];
      if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else {
      // A body match is current: clear any properties current class and let
      // the plugin dispatch the index change, recompute decorations, scroll.
      for (let i = 0; i < propCount; i++) {
        const m = findState.matches[i];
        if (m && m.classList) m.classList.remove('current');
      }
      if (_tiptapEditorModuleResolved && activeTiptapEditor) {
        _tiptapEditorModuleResolved.setFindIndex(activeTiptapEditor, idx - propCount);
      }
    }
  } else {
    for (let i = 0; i < findState.matches.length; i++) {
      const m = findState.matches[i];
      if (m && m.classList) m.classList.toggle('current', i === idx);
    }
    const target = findState.matches[idx];
    if (target && target.scrollIntoView) {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
  updateFindCount();
}

function gotoNextFindMatch() {
  if (!findState.matches.length) return;
  setCurrentFindMatch((findState.currentIndex + 1) % findState.matches.length);
}

function gotoPrevFindMatch() {
  if (!findState.matches.length) return;
  setCurrentFindMatch((findState.currentIndex - 1 + findState.matches.length) % findState.matches.length);
}

function updateFindCount() {
  const countEl = document.getElementById('find-count');
  if (!countEl) return;
  if (!findState.query) {
    countEl.textContent = '';
    countEl.classList.remove('no-results');
    return;
  }
  if (!findState.matches.length) {
    countEl.textContent = 'No matches';
    countEl.classList.add('no-results');
    return;
  }
  countEl.textContent = `${findState.currentIndex + 1} of ${findState.matches.length}`;
  countEl.classList.remove('no-results');
}

function updateFindButtons() {
  const has = findState.matches.length > 0;
  const prev = document.getElementById('find-prev');
  const next = document.getElementById('find-next');
  if (prev) prev.disabled = !has;
  if (next) next.disabled = !has;
}

// Called from the Tiptap editor's `update` event so the count display stays
// honest when the user types in the editor while the find bar is open. The
// plugin handles matches and decorations itself; this just mirrors the new
// count + current index into app-side state for the UI.
function syncTiptapFindStateFromPlugin() {
  if (findState.backend !== 'tiptap' || !findState.open) return;
  if (!_tiptapEditorModuleResolved || !activeTiptapEditor) return;
  // With frontmatter matches in play the two match sources must stay in sync;
  // re-running the search is simplest and correct (rare: editing the body
  // while find is open on a file whose frontmatter also matched).
  if (findState._propCount) { runFindSearch(findState.query); return; }
  const tipState = _tiptapEditorModuleResolved.getFindState(activeTiptapEditor);
  findState.matches = tipState.matches.map(() => ({ tiptap: true }));
  findState.currentIndex = tipState.currentIndex;
  updateFindCount();
  updateFindButtons();
}

function initFindBar() {
  // Global Cmd+F / Ctrl+F: only intercept if find has a backend in the
  // current view. In other views (workspace picker, settings, etc.) the
  // browser's native find runs as usual.
  document.addEventListener('keydown', (e) => {
    if (isFindHotkey(e)) {
      const backend = detectFindBackend();
      if (!backend) return;
      e.preventDefault();
      openFindBar();
      return;
    }
    if (e.key === 'Escape' && findState.open) {
      // The palette overlays the find bar; when both are open, Escape
      // closes the topmost surface only (the palette's own handler).
      if (typeof paletteOpen !== 'undefined' && paletteOpen) return;
      e.preventDefault();
      closeFindBar();
    }
  });
  const input = document.getElementById('find-input');
  if (input) {
    input.addEventListener('input', (e) => {
      clearTimeout(findState.inputTimer);
      const q = e.target.value;
      findState.inputTimer = setTimeout(() => runFindSearch(q), 100);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) gotoPrevFindMatch();
        else gotoNextFindMatch();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeFindBar();
      }
    });
  }
  const prev = document.getElementById('find-prev');
  const next = document.getElementById('find-next');
  const close = document.getElementById('find-close');
  if (prev) prev.addEventListener('click', () => { gotoPrevFindMatch(); document.getElementById('find-input')?.focus(); });
  if (next) next.addEventListener('click', () => { gotoNextFindMatch(); document.getElementById('find-input')?.focus(); });
  if (close) close.addEventListener('click', closeFindBar);
}

initFindBar();

// ===== 18. UNIVERSAL SEARCH PALETTE (Cmd+K / Ctrl+K) =====
//
// One keyboard-first surface over four corpora: files, conversations, agents,
// skills. The server answers `search_universal` with grouped results (title
// fuzzy layer + FTS content, or grep fallback). Navigation REUSES the
// existing routes: read_file + showView('editor') for files (same as the
// file tree), openConversation for conversations (extended with the message
// anchor), showProfile for agents, selectSkill for skills. The one new
// mechanic is the message anchor: opening a conversation scrolled to the
// matched message.

let paletteOpen = false;
let paletteScope = 'all';
let paletteQuery = '';
let paletteTimer = null;
let paletteReply = null;      // last server reply {groups, recent}
let paletteFlat = [];         // flat selectable items in display order
let paletteSel = 0;
let paletteLoading = false;
let palettePendingSkill = null;
let paletteReqId = 0;         // stale-reply guard (query text alone can't distinguish filter/fuzzy toggles)
var pendingMessageAnchor = null; // {convoId, text, fragment} — var: openConversation clears it and runs before this section during load-order-sensitive paths

// Group order/labels/limit live in palette-model.js (unit-tested).
const PALETTE_GROUP_LIMIT = RundockPalette.GROUP_LIMIT;
const IS_MAC = /Mac/i.test(navigator.platform);
let paletteReturnFocus = null; // element to restore focus to on close
let palettePrevNav = null;     // nav we came from, restored on cancel (destination wins on navigate)

// The nav rail tooltip teaches the shortcut with the right modifier per
// platform (the Windows and Linux builds have no Cmd key).
document.getElementById('nav-search-btn')?.setAttribute('data-tooltip', IS_MAC ? 'Search ⌘K' : 'Search Ctrl+K');

function openPalette() {
  if (currentView === 'workspace' || !currentWorkspacePath) return; // no workspace yet
  const overlay = document.getElementById('palette-overlay');
  if (!overlay) return;
  if (!paletteOpen) {
    // Search is now the active surface: light the search icon and clear the
    // origin view's highlight so it does not show through the overlay. Capture
    // the origin once (guard against a re-entrant open losing the return nav).
    const prevActive = document.querySelector('.nav-item[data-nav].active');
    palettePrevNav = prevActive ? prevActive.getAttribute('data-nav') : null;
    prevActive?.classList.remove('active');
    document.getElementById('nav-search-btn')?.classList.add('active');
  }
  paletteOpen = true;
  paletteReturnFocus = document.activeElement;
  overlay.classList.remove('hidden');
  const input = document.getElementById('palette-input');
  input.value = paletteQuery = '';
  schedulePaletteSearch(0); // empty query -> recent items
  input.focus();
}

function closePalette(opts = {}) {
  // restoreFocus defaults true: cancel closes (Escape, Cmd/Ctrl+K toggle)
  // return focus to where the user was, which keyboard flow continuity
  // requires. Selection closes pass false: after NAVIGATING somewhere,
  // handing focus back to a stale nav-rail button paints the browser's
  // keyboard focus ring on a view the user just left (a white border next
  // to the new view's active highlight).
  const restoreFocus = opts.restoreFocus !== false;
  paletteOpen = false;
  clearTimeout(paletteTimer);
  // Blur before hiding so focus never sits inside a hidden subtree
  // (browsers silently drop it to <body>; an explicit blur is deterministic).
  try { document.activeElement?.blur?.(); } catch (e) {}
  document.getElementById('palette-overlay')?.classList.add('hidden');
  // Clear the search icon regardless of how we close. On cancel (restoreFocus)
  // return the highlight to the origin view; on navigate the destination's own
  // routing sets the active nav, so leave it alone (destination wins).
  document.getElementById('nav-search-btn')?.classList.remove('active');
  if (restoreFocus && palettePrevNav) {
    document.querySelector(`.nav-item[data-nav="${palettePrevNav}"]`)?.classList.add('active');
  }
  palettePrevNav = null;
  if (restoreFocus && paletteReturnFocus && document.contains(paletteReturnFocus)) {
    try { paletteReturnFocus.focus(); } catch (e) {}
  }
  paletteReturnFocus = null;
}

function togglePalette() { paletteOpen ? closePalette() : openPalette(); }

function setPaletteScope(scope) {
  paletteScope = scope;
  paletteSel = 0; // the flat list is about to change shape
  document.querySelectorAll('.palette-scope').forEach(b => b.classList.toggle('active', b.dataset.scope === scope));
  renderPalette();
  document.getElementById('palette-input')?.focus();
}

function schedulePaletteSearch(delay = 220) {
  if (!paletteOpen) return;
  clearTimeout(paletteTimer);
  paletteTimer = setTimeout(runPaletteSearch, delay);
}

function runPaletteSearch() {
  if (!paletteOpen || !ws || ws.readyState !== 1) return;
  paletteQuery = document.getElementById('palette-input')?.value || '';
  paletteLoading = true;
  renderPaletteStatus();
  // Fuzzy matching is always on for the title/name layer (no toggle in V1);
  // content matching stays lexical FTS with type-ahead prefixing.
  ws.send(JSON.stringify({
    type: 'search_universal',
    query: paletteQuery,
    reqId: ++paletteReqId,
    prefix: true, // type-ahead: last token matches as a prefix
    limit: PALETTE_GROUP_LIMIT,
  }));
}

function handlePaletteResults(d) {
  if (!paletteOpen) return;
  // Stale replies are dropped by request id (query text alone can't
  // distinguish a fuzzy/filter toggle on the same query).
  if (RundockPalette.isStaleReply(d, paletteReqId)) return;
  paletteLoading = false;
  paletteReply = d;
  paletteSel = 0;
  renderPalette();
}

// Escape then swap the server's control-char highlight markers for <mark>.
// Order matters: HTML is escaped FIRST, so the only markup in the string is
// the <mark> pair we introduce ourselves.
function paletteHl(s) { return RundockPalette.highlightToMark(s, esc); }

function paletteSnippetPlain(s) { return RundockPalette.snippetPlain(s); }

const PALETTE_ICONS = {
  file: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  skill: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
};

function renderPalette() {
  const container = document.getElementById('palette-results');
  if (!container || !paletteReply) return;
  // Grouping, ordering, and count-floor rules live in palette-model.js.
  const flattened = RundockPalette.flattenReply(paletteReply, paletteScope);
  paletteFlat = flattened.flat;
  let h = '';
  for (const g of flattened.groups) {
    h += `<div class="palette-group-label" role="presentation">${g.label}<span class="palette-group-count">${g.countLabel}</span></div>`;
    g.items.forEach((item, i) => { h += paletteItemHtml(item, g.startIdx + i); });
  }
  if (!paletteFlat.length) {
    const state = RundockPalette.emptyState(paletteReply, paletteQuery);
    if (state === 'error') {
      // A genuine server failure must not masquerade as "no matches".
      h = `<div class="palette-empty">Search hit a problem<div class="palette-empty-sub">Try again; if it persists, check the server log.</div></div>`;
    } else {
      h = state === 'no-matches'
        ? `<div class="palette-empty">No matches for &ldquo;${esc(paletteQuery.trim())}&rdquo;<div class="palette-empty-sub">Search covers file contents and names, conversation messages and titles, and agent and skill names.</div></div>`
        : `<div class="palette-empty">Start typing to search your workspace<div class="palette-empty-sub">Files, conversations, agents, and skills.</div></div>`;
    }
  }
  container.innerHTML = h;
  updatePaletteSelection();
  renderPaletteStatus();
}

function paletteItemHtml(item, idx) {
  let icon = '', title = '', meta = '';
  if (item.type === 'file') {
    icon = `<div class="palette-item-icon">${PALETTE_ICONS.file}</div>`;
    title = esc(item.title || item.path);
    const dir = item.path && item.path.includes('/') ? item.path.substring(0, item.path.lastIndexOf('/')) + '/' : '';
    const tagStr = (item.tags && item.tags.length) ? ` &middot; #${item.tags.map(esc).join(' #')}` : '';
    meta = item.snippet ? paletteHl(item.snippet) : esc(dir) + tagStr;
  } else if (item.type === 'conversation') {
    const a = agents.find(x => x.id === item.agentId);
    icon = `<div class="avatar sm" style="background:${esc(a?.colour || 'var(--card)')};width:26px;height:26px;font-size:12px">${esc(a?.icon || '?')}</div>`;
    title = esc(item.title || 'Untitled conversation');
    meta = item.snippet ? paletteHl(item.snippet) : (a ? esc(a.displayName) : '');
    if (item.matchCount > 1) meta += ` <span style="opacity:0.7">&middot; ${parseInt(item.matchCount, 10) || 0} matches</span>`;
  } else if (item.type === 'agent') {
    icon = `<div class="avatar sm" style="background:${esc(item.colour || 'var(--card)')};width:26px;height:26px;font-size:12px">${esc(item.icon || '?')}</div>`;
    title = esc(item.name);
    meta = esc(item.role || '');
  } else if (item.type === 'skill') {
    icon = `<div class="palette-item-icon">${PALETTE_ICONS.skill}</div>`;
    title = esc(item.name);
    meta = esc((item.description || '').slice(0, 90));
  }
  return `<div class="palette-item" id="palette-item-${idx}" role="option" aria-selected="false" data-idx="${idx}" data-type="${item.type}" onclick="openPaletteResult(${idx})" onmousemove="hoverPaletteItem(${idx})">
    ${icon}
    <div class="palette-item-body">
      <div class="palette-item-title">${title}</div>
      ${meta ? `<div class="palette-item-meta">${meta}</div>` : ''}
    </div>
    <span class="palette-item-kbd">&#9166;</span>
  </div>`;
}

function renderPaletteStatus() {
  const el = document.getElementById('palette-status');
  if (!el) return;
  el.innerHTML = paletteLoading
    ? '<span><span class="spin">&#9696;</span> searching&hellip;</span>'
    : '<span>&#8593;&#8595; navigate</span><span>&#9166; open</span><span>esc close</span>';
}

function hoverPaletteItem(idx) {
  if (paletteSel === idx) return;
  paletteSel = idx;
  updatePaletteSelection(false);
}

function updatePaletteSelection(scroll = true) {
  document.querySelectorAll('.palette-item').forEach(el => {
    const selected = parseInt(el.dataset.idx) === paletteSel;
    el.classList.toggle('selected', selected);
    el.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (selected && scroll) el.scrollIntoView({ block: 'nearest' });
  });
  // Screen readers track the arrow-key selection through the combobox input.
  const input = document.getElementById('palette-input');
  if (input) {
    if (paletteFlat.length) input.setAttribute('aria-activedescendant', `palette-item-${paletteSel}`);
    else input.removeAttribute('aria-activedescendant');
  }
}

function movePaletteSelection(delta) {
  if (!paletteFlat.length) return;
  paletteSel = RundockPalette.moveSelection(paletteSel, delta, paletteFlat.length);
  updatePaletteSelection();
}

function openPaletteResult(idx) {
  const item = paletteFlat[idx];
  if (!item) return;
  closePalette({ restoreFocus: false }); // navigating away: no stale focus ring
  if (item.type === 'file') {
    paletteOpenFile(item.path);
  } else if (item.type === 'conversation') {
    paletteOpenConversation(item);
  } else if (item.type === 'agent') {
    showProfile(item.id);
  } else if (item.type === 'skill') {
    paletteOpenSkill(item.id);
  }
}

// File route: same mechanics as a file-tree click (read_file + editor view),
// plus nav state so the sidebar matches where the user landed.
function paletteOpenFile(filePath) {
  switchNav('files');
  document.querySelectorAll('.file-item').forEach(x => x.classList.toggle('active', x.dataset.path === filePath));
  editorReturnView = 'editor';
  fileHistory = [];
  ws.send(JSON.stringify({ type: 'read_file', path: filePath }));
  showView('editor');
}

// Conversation route: the existing openConversation, extended with the
// message anchor (the one genuinely new deep-link mechanic in SR1).
function paletteOpenConversation(item) {
  if (item.snippet) {
    pendingMessageAnchor = {
      convoId: item.id,
      text: paletteSnippetPlain(item.snippet).replace(/…/g, ' ').trim(),
      fragment: RundockPalette.snippetFragment(item.snippet),
    };
  } else {
    pendingMessageAnchor = null;
  }
  openConversation(item.id, !!pendingMessageAnchor);
  // Already-loaded conversations render synchronously: anchor now. History
  // loads anchor from renderSessionHistory when the fetch lands.
  if (!document.getElementById('history-loading')) tryMessageAnchor(item.id);
}

function paletteOpenSkill(skillId) {
  if (!skillsLoaded) palettePendingSkill = skillId;
  switchNav('skills');
  if (skillsLoaded) selectSkill(skillId);
}

// ── Message anchor ──────────────────────────────────────────────────────────
// Find the rendered message whose text contains the search snippet and
// scroll to it. Text-content matching (normalised) survives the markdown
// rendering that separates the jsonl source from the DOM.

function normAnchorText(t) { return RundockPalette.normAnchorText(t); }

function tryMessageAnchor(convoId) {
  if (!pendingMessageAnchor || pendingMessageAnchor.convoId !== convoId) return;
  const anchor = pendingMessageAnchor;
  pendingMessageAnchor = null;
  // Let the DOM paint before measuring.
  setTimeout(() => {
    const bubbles = document.querySelectorAll('#messages .msg .msg-bubble');
    const idx = RundockPalette.findAnchorIndex([...bubbles].map(b => b.textContent), anchor);
    const target = idx === -1 ? null : bubbles[idx].closest('.msg');
    if (!target) return; // message outside the loaded window: land at the conversation as usual
    target.scrollIntoView({ block: 'center', behavior: 'auto' });
    target.classList.remove('anchor-flash');
    void target.offsetWidth; // restart the animation if re-triggered
    target.classList.add('anchor-flash');
    // Remove the class once the flash has served its purpose. CSS animations
    // replay whenever the element cycles through display:none (navigating to
    // another view and back), so a lingering class re-flashes the message on
    // every return to the conversation. The timeout (animation is 1.6s) also
    // covers prefers-reduced-motion, where no animationend would ever fire
    // and the static fallback ring would otherwise persist indefinitely.
    setTimeout(() => target.classList.remove('anchor-flash'), 1700);
  }, 60);
}

// ── Keyboard wiring ─────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    togglePalette();
    return;
  }
  if (!paletteOpen) return;
  if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
  // Focus trap: while the palette is open, Tab cycles through its own
  // controls (input + scope chips) instead of escaping into the page
  // behind the overlay. Result rows stay arrow-key territory.
  if (e.key === 'Tab') {
    const focusables = [...document.querySelectorAll('#palette-overlay input, #palette-overlay button')]
      .filter(el => el.offsetParent !== null);
    if (!focusables.length) return;
    const idx = focusables.indexOf(document.activeElement);
    e.preventDefault();
    const next = e.shiftKey
      ? focusables[(idx - 1 + focusables.length) % focusables.length]
      : focusables[(idx + 1) % focusables.length];
    next.focus();
  }
});

document.getElementById('palette-input')?.addEventListener('input', () => schedulePaletteSearch());
document.getElementById('palette-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); movePaletteSelection(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); movePaletteSelection(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); openPaletteResult(paletteSel); }
});

connect();
