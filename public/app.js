/**
 * Rundock Client Application
 *
 * Table of Contents:
 * ─────────────────────────────────────────────
 * 1. CONSTANTS & STATE ............... Global variables, icons, state objects
 * 2. HELPERS ......................... Agent helpers, formatting, escaping
 * 3. WEBSOCKET ....................... connect, setConn
 * 4. MESSAGE HANDLING ................ handle, handleAssistant, handleResult
 * 5. AGENT LIST & SIDEBAR ........... moved to views/team.js
 * 6. ORG CHART ....................... moved to views/team.js (resize listener stays)
 * 7. AGENT PROFILE .................. moved to views/profile.js
 * 8. CONVERSATIONS .................. moved to views/conversations.js (pendingListAdd stays)
 * 9. CHAT & MESSAGING ............... moved to views/chat.js (agent tick, permission stores stay)
 * 10. VIEWS & NAVIGATION ............ switchNav, showView, goHome, toggleTheme
 * 11. FILE TREE & EDITOR ............ moved to views/files.js (tree cache, icon tables, menu listeners stay)
 * 12. MARKDOWN RENDERING ............ moved to markdown-render.js (the wiring,
 *                                     the theme swap and the aliases stay)
 * 13. SKILLS ........................ moved to views/skills.js
 * 14. SETTINGS ...................... moved to views/settings.js
 * 15. WORKSPACE PICKER .............. handleWorkspaces, showWorkspacePicker
 * 16. EVENT LISTENERS & INIT ........ keydown, resize, connect()
 * 17. IN-VIEW FIND BAR .............. moved to views/find.js (findState, initFindBar() call stay)
 * 18. UNIVERSAL SEARCH PALETTE ...... moved to views/palette.js (open/sel flags, group limit stay)
 * ─────────────────────────────────────────────
 */

// ===== 1. CONSTANTS & STATE =====

// Durable key-value persistence. In the desktop app the page's origin is
// http://localhost:<port> with an OS-assigned port, so localStorage is
// scoped to an origin that changes every launch and silently loses
// everything. There, durable state lives in the main process (a file under
// userData): preload exposes a synchronous snapshot, taken before this
// script runs, so boot-time reads like the theme apply without a flash, and
// writes go through IPC. In a plain browser localStorage behaves normally
// and is used as before. Same semantics either way: string in, string out,
// null when absent, and a write that cannot persist never throws.
const persist = (() => {
  const api = typeof window !== 'undefined' && window.electronAPI && window.electronAPI.storage;
  if (api && api.snapshot) {
    return {
      get(key) { return Object.prototype.hasOwnProperty.call(api.snapshot, key) ? api.snapshot[key] : null; },
      set(key, value) {
        api.snapshot[key] = String(value);
        try { api.set(key, String(value)); } catch (e) { /* best-effort */ }
      },
    };
  }
  return {
    get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
    set(key, value) { try { localStorage.setItem(key, String(value)); } catch (e) { /* private mode */ } },
  };
})();

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
// The server's OS, learned from the server_info handshake. Gates OS-specific
// affordances (e.g. Reveal in Finder) so a dead row never shows off macOS.
let serverPlatform = null;
// File-type registry: non-markdown views live in public/viewers/.
// Loaded on demand, same pattern as the editor module above.
let _viewersModule = null, _viewersModuleResolved = null, activeFileViewer = null;
// The file-surface lifecycle that uses these caches (the module loaders,
// Tiptap init/teardown, viewers and artifact-review mounts, the external-edit
// guard, and closeOpenFile) lives in views/files.js; the declarations above
// stay here as shared state for the find bar, the init listeners, and the WS
// dispatch.
// True when the open file has unsaved user edits. This, not a comparison of
// re-serialized content, decides whether a live external change reloads
// seamlessly or prompts a conflict: the rich editor's markdown serializer is
// not byte-idempotent (e.g. it normalises emphasis and list markers), so a
// clean, unedited file would otherwise look "dirty" and false-conflict. Set on
// edit in each surface, cleared on load and on our own save.
let editorDirty = false;

// saveFileGuarded, the external-edit conflict UI, currentLiveContent,
// handleExternalFileChange, destroyTiptapEditorIfActive, and closeOpenFile
// live in views/files.js.

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
// Unread-signal bookkeeping by reason (message vs pending permission) lives in
// unread-state.js (unit-tested), so a permission card timing out clears its own
// contribution without wiping a co-occurring unread message.
const unread = RundockUnread.createUnreadState();
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
  if (unread.size() > 0) {
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
    case 'workspace_set':
      // Start the clock on the renderer's share of opening a workspace. The
      // server times its own phases; without this the client is the one part
      // of a slow startup nobody can see.
      workspaceOpenStartedAt = Date.now();
      onWorkspaceReady(d.path, d.analysis, d.isEmpty, d.workspaceMode, d.scaffoldError, d.setupComplete);
      break;
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
    case 'agents': agents=d.agents; renderAgentList(); renderOrgChart(); renderRoutinesSidebar(); renderRoutines(); renderConvoList(); break;
    // renderRoutines as well as renderSkills: the routines empty state asks
    // whether the workspace has a skill, so the reply that answers that
    // question is the reply that has to redraw it. Without this the list sits
    // on its waiting line until the next roster broadcast.
    case 'skills': skills=d.skills; skillsLoaded=true; renderSkills(); renderRoutines(); routineEditorSkillsArrived(d.skills); if(palettePendingSkill){const s=palettePendingSkill;palettePendingSkill=null;selectSkill(s);} break;
    case 'conversations':
      handlePersistedConversations(d.conversations, d.lastActiveConversationId);
      // Conversations are the last of the four payloads the client requests on
      // open, so by here the workspace is on screen. Report once per open.
      if (workspaceOpenStartedAt) {
        const renderMs = Date.now() - workspaceOpenStartedAt;
        workspaceOpenStartedAt = null;
        try { ws.send(JSON.stringify({ type: 'client_render_time', ms: renderMs })); } catch (e) {}
      }
      break;
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
    case 'file_tree': {
      // Handed over unconditionally. The tree reconciles against what is
      // already drawn, so an unchanged push produces no operations and touches
      // no DOM. The comparison that used to guard this call was standing in
      // for that, back when rendering meant destroying the tree and rebuilding
      // it, and it only ever hid the cheap case.
      cachedFileTree = d.tree;
      renderFileTree(d.tree);
      break;
    }
    case 'file_content': loadFileContent(d.path, d.content); break;
    case 'file_changed': handleExternalFileChange(d.path, d.content); break;
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
    // A routine write is the one save in this client the user waits on: the
    // editor stays on screen until the server answers, so a refusal has
    // somewhere to land. Both replies go to the editor AND to the message
    // area, the way agent and skill replies do, because the editor may already
    // have been left by hand.
    case 'routine_saved':
      addSystemMsg('Routine "' + (d.name || '') + '" added to ' + (d.agentId || '') );
      routineEditorSaved();
      break;
    case 'routine_error':
      addSystemMsg(d.message || 'Routine could not be saved');
      routineEditorFailed(d.message);
      break;
    case 'routine_action_error':
      // The routines list asked, so the routines list is told. Deliberately
      // NOT routine_error: that one belongs to the save flow, and sending a
      // refused delete down it would call the editor's save-failure callback
      // outside any save and put the only reply in the conversation view.
      routinesActionFailed(d);
      break;
    case 'routine_deleted':
      routinesActionCleared();
      addSystemMsg('Routine "' + (d.name || '') + '" deleted');
      break;
    case 'routine_paused':
      routinesActionCleared();
      // No message of its own. The roster broadcast that follows redraws the
      // row, which says Paused or names the next run, and that is the change
      // the reader asked for. A line in the conversation as well would be a
      // second answer to a question the list already answers.
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
      if (d.platform) serverPlatform = d.platform;
      break;
    case 'control_request': {
      const targetConvo = convoId || activeConversation?.id;
      if(targetConvo) handlePermissionRequest(d, targetConvo);
      break;
    }
    case 'permission_timeout': {
      resolvePermissionCard(d.requestId, false, '✕ Timed out', false);
      pendingPermissions.delete(d.requestId);
      // Expired: a copy queued for a background conversation must never be
      // rendered (and answered) after the server has auto-denied it.
      const timedOutConvo = RundockPermissions.removePendingPermission(pendingPermissionsByConvo, d.requestId);
      // L4: a timed-out background card must clear its own contribution to the
      // unread badge. Only once the conversation has no other pending card, and
      // only the permission reason so a co-occurring unread message survives.
      if (timedOutConvo
          && RundockPermissions.pendingPermissionsFor(pendingPermissionsByConvo, timedOutConvo).length === 0) {
        unread.resolvePermission(timedOutConvo);
        updateUnreadBadge();
        renderConvoList();
      }
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
    el.innerHTML = RundockChatMarkup.agentStreamingMessageHtml(a, '', RundockChatMarkup.msgTimeHtml(new Date()));
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
      el.innerHTML = RundockChatMarkup.thinkingIndicatorHtml(a);
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
    // Markers stripped first or a Doc turn's preview reads "<!-- RUNDOCK:SA...".
    convo.lastMessagePreview = stripMd(stripRundockMarkers(ef.text || '')).trim().substring(0, 80);
  },
  'mark-unread': (convoId) => {
    unread.markMessage(convoId);
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
// Moved to public/views/team.js (Foundations view module):
// getWorkingAgentIds, renderAgentList, renderConvoEmptyAgents,
// renderRoutinesSidebar, addToTeam. All resolve via the module's window
// republication.

// ===== 6. ORG CHART =====
// Moved to public/views/team.js alongside the agent list: ORG_PRESETS,
// orgCardHtml, renderOrgChart, orgZoom. The debounced resize listener
// below stays here: it is top-level window wiring (the same call the
// workspace picker's delegated listeners made), and orgZoomOffset stays
// in section 1 because this listener resets it.

// Debounced resize: reset zoom and re-render
let _orgResizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(_orgResizeTimer);
  _orgResizeTimer = setTimeout(() => { orgZoomOffset = 0; renderOrgChart(); }, 150);
});

// ===== 7. AGENT PROFILE =====
// Moved to public/views/profile.js (Foundations view module). showProfile
// resolves via the module's window republication.

// ===== 8. CONVERSATIONS =====
// View functions live in views/conversations.js (RundockConversationsView,
// republished on window for the inline handlers, the generated row handlers,
// the WS dispatch, routing, and the search palette). No conversation state
// moved: conversations, activeConversation, convoState, the unread and
// working sets, and the list caches all live in section 1 and are written by
// the WS dispatch and the workspace lifecycle. pendingListAdd stays here for
// the same reason: the moved menu writes it, but the WS lists handler reads
// and clears it.

// When a list is created from a conversation's menu, add that conversation to
// it as soon as the server confirms the list exists.
let pendingListAdd = null;

// ===== 9. CHAT & MESSAGING =====
// View functions live in views/chat.js (RundockChatView, republished on window
// for the inline handlers, the WS dispatch and its effect executors, the
// conversations view, and the composer listener). The session-history and
// permission-card subsections moved with it: they are the same surface. What
// stays below is top-level wiring and the state the dispatch owns.

// Tick agent timestamps every 60 seconds without re-rendering
setInterval(() => {
  for (const [agentId, activity] of Object.entries(agentLastActivity)) {
    const el = document.querySelector(`[data-status="${agentId}"]`);
    if (el && !el.classList.contains('working')) {
      el.textContent = formatTimeAgo(activity.time);
    }
  }
}, 60000);

// ===== PERMISSION UI =====
// The cards, the risk aliases, and the respond path live in views/chat.js.
// These two stores stay: the WS dispatch deletes from pendingPermissions when
// a request times out, and reads pendingPermissionsByConvo for the timeout and
// cancel sweeps, so both have retained readers outside the view.

// Pending permission callbacks (avoids inline onclick injection)
const pendingPermissions = new Map();
// Permission requests for conversations that are not on screen, awaiting
// render when their conversation opens: convoId -> Map(requestId -> the raw
// control_request payload). Entries leave on answer (respondPermission),
// server timeout (permission_timeout), or cancel (the server's cancel sweep
// already answered them). The store's decisions are pure functions in
// permissions.js (unit-tested); this map is the app's single instance.
const pendingPermissionsByConvo = new Map();

// Scroll follow state. scrollBottom lives in views/chat.js; the flag stays
// here because the DOMContentLoaded listener below is its other writer.
let userScrolledUp = false;

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
  let width = applySidebarWidth(Number(persist.get(SIDEBAR_WIDTH_KEY)) || 280);
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
      persist.set(SIDEBAR_WIDTH_KEY, String(width));
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
// Sections whose sidebar belongs to another one. Routines sits beside the
// team and the locked mock draws it with the team panel for a reason worth
// keeping: a routine belongs to an agent, and the panel that lists your agents
// is the one that answers "whose?". Its own Routines section already lives
// inside that panel.
const SIDEBAR_FOR = { routines: 'team' };

function setNavState(nav) {
  document.querySelectorAll('.nav-item[data-nav]').forEach(n=>n.classList.remove('active'));
  document.querySelector(`[data-nav="${nav}"]`)?.classList.add('active');
  ['team','conversations','skills','files','settings'].forEach(s=>document.getElementById(`sidebar-${s}`).classList.add('hidden'));
  document.getElementById(`sidebar-${SIDEBAR_FOR[nav] || nav}`).classList.remove('hidden');
  // The New conversation footer lives at sidebar level (so the update strip
  // can sit above it without ever moving it), which makes its visibility
  // this function's job rather than the panel's.
  document.getElementById('convo-footer')?.classList.toggle('hidden', nav !== 'conversations');
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
  // THE OPENER DRAWS, ALWAYS, rather than only on the paths somebody
  // remembered. Arriving here used to draw nothing at all when the list had
  // arrived and was empty, which was invisible only because the Skills entry
  // was withdrawn on exactly that workspace. A permanent entry opens onto
  // whatever is here, so what is here cannot depend on how you arrived.
  // renderSkills also picks the first skill when none is selected, which is
  // why that branch is gone from here rather than restated: one rule, one
  // place.
  else if(nav==='skills') { showView('skills'); renderSkills(); if(!skillsLoaded) { ws.send(JSON.stringify({type:'get_skills'})); } }
  else if(nav==='conversations') { if(activeConversation) { showView('chat'); if(unread.clearConvo(activeConversation.id)) { updateUnreadBadge(); renderConvoList(); } } else { const target = pickDefaultConversation(); if(target) { openConversation(target.id); } else { newConversation(); } } }
  else if(nav==='team') { showView('home'); renderOrgChart(); }
  else if(nav==='routines') { showView('routines'); renderRoutines(); }
}
function showView(v) { currentView=v; ['workspace','home','profile','chat','convo-empty','editor','skills','settings','routine-editor','routines'].forEach(id=>{const e=document.getElementById(`view-${id}`);if(e){e.classList.add('hidden');e.style.display='none';e.classList.remove('main-view-transition');}}); const e=document.getElementById(`view-${v}`); if(e){e.classList.remove('hidden');e.style.display='flex';e.classList.add('main-view-transition');}  }
function goHome() { discardIfEmpty(); activeConversation=null; switchNav('conversations'); }

// Theme. One function applies it everywhere it shows (body class, toggle
// icon, code highlighting, Windows caption colours); which theme applies is
// decided by chooseTheme (public/theme-choice.js): an explicit choice wins
// forever, and until one exists the app follows the OS setting, live.
function applyTheme(isLight) {
  document.body.classList.toggle('light', isLight);
  const t = document.getElementById('theme-toggle');
  if (t) t.innerHTML = isLight ? moonIcon : sunIcon;
  if (typeof applyHljsTheme === 'function') applyHljsTheme(isLight);
  syncTitleBarOverlay(isLight);
}
function toggleTheme() {
  const isLight = !document.body.classList.contains('light');
  applyTheme(isLight);
  // The toggle is the user choosing. From here on the OS setting no longer
  // moves the theme (the media listener below checks storage before acting).
  persist.set('rundock-theme', isLight ? 'light' : 'dark');
}
// Apply the right theme on load, and follow OS changes only while no
// explicit choice exists.
{
  const osLight = window.matchMedia('(prefers-color-scheme: light)');
  const choice = chooseTheme({ stored: persist.get('rundock-theme'), osPrefersLight: osLight.matches });
  applyTheme(choice.light);
  if (choice.followOs) {
    osLight.addEventListener('change', (e) => {
      const again = chooseTheme({ stored: persist.get('rundock-theme'), osPrefersLight: e.matches });
      if (again.followOs) applyTheme(again.light);
    });
  }
}

// The Windows caption buttons are drawn by the OS from colours we pass, so
// they keep the old ones until re-sent. Every theme change flows through
// applyTheme above, which calls this, so boot, toggle, and OS-follow all
// keep the buttons in step. A no-op off Windows and in a browser.
function syncTitleBarOverlay(isLight) {
  try { window.electronAPI?.setTitleBarOverlay?.(!!isLight); } catch (e) {}
}

// ===== 11. FILE TREE & EDITOR =====
// View functions live in views/files.js (RundockFilesView, republished on
// window for the inline handlers, the delegated wikilink listener registered
// at the foot of this file, and the cross-section callers). What stays below is shared state and top-level
// wiring: the WS dispatch writes the tree cache, switchNav and the palette
// write editorReturnView/fileHistory, the find bar and the init listeners
// read editorMode and the editor surfaces' state. TREE_ICONS and
// CREATABLE_TYPES stay because their declarations read FilesMenuModel at
// load time, which the module's side-effect-free factory cannot do; moved
// functions read them at call time through the global lexical environment.
// The two document-level menu-close listeners stay as top-level wiring
// (registering inside the UMD factory would break clean Node require).

// Set when a workspace opens, cleared once the client has rendered it.
let workspaceOpenStartedAt = null;
let cachedFileTree = null;

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
// ---- Files-sidebar creation menu ("+" header button and row context menu) ----
// Creatable types and path helpers live in files-menu-model.js (unit-tested);
// this is the DOM menu that consumes them.
const CREATABLE_TYPES = FilesMenuModel.CREATABLE_TYPES;
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

// Editor
let editorMode='preview', rawFileContent='', fileFrontmatter='', fileBody='';

let editorReturnView = 'editor';
let fileHistory = [];

// ===== 12. MARKDOWN RENDERING =====

// The renderer itself lives in markdown-render.js so it can be driven directly
// under node --test; this file only wires it to the browser's globals and owns
// the DOM-side behaviour of the markup it emits.
const RundockRenderer = RundockMarkdown.createMarkdownRenderer({
  marked,
  hljs: window.hljs,
  resolveCodeLanguage: window.resolveCodeLanguage,
  emptyOrderedListText: window.emptyOrderedListText,
});

// Swap the highlight.js theme stylesheet to match the app theme.
function applyHljsTheme(isLight) {
  const dark = document.getElementById('hljs-dark');
  const light = document.getElementById('hljs-light');
  if (dark) dark.disabled = !!isLight;
  if (light) light.disabled = !isLight;
}
applyHljsTheme(document.body.classList.contains('light'));

function renderMarkdown(text, options = {}) { return RundockRenderer.renderMarkdown(text, options); }

// Alias for backward compatibility
function formatMd(text) { return renderMarkdown(text); }
function formatMdFull(text) { return renderMarkdown(text, { callouts: true }); }

// ===== 13. SKILLS =====
// View functions live in views/skills.js (RundockSkillsView, republished on
// window for the generated onclick handlers and cross-view callers).
// currentSkillId stays here: routing reads it (switchNav) and the workspace
// lifecycle resets it (onWorkspaceReady), so it is shared state, not
// view-local.

let currentSkillId = null;

// ===== 14. SETTINGS =====
// View functions live in views/settings.js (RundockSettingsView, republished
// on window for the inline handlers, the WS dispatch, and routing). No
// section-local state existed; the view reads shared app.js state at call
// time.

// ===== 15. WORKSPACE PICKER =====

function handleWorkspaces(d) {
  if (d.current) {
    // Server already has a workspace set (env var or previous selection).
    // This path never sends set_workspace, so start the render clock here or
    // the client's share of startup goes unmeasured for these instances.
    workspaceOpenStartedAt = Date.now();
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
  // The top bar itself stays: it carries the window's only drag region once
  // the OS title bar is removed. Only search hides, since there is nothing to
  // search yet. Help deliberately remains, because this is the screen where a
  // new user is most likely to want it.
  const tbs = document.getElementById('tb-search');
  if (tbs) tbs.style.display = 'none';
  document.querySelector('.app')?.classList.add('no-workspace');
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
  const tbsOn = document.getElementById('tb-search');
  if (tbsOn) tbsOn.style.display = '';
  document.querySelector('.app')?.classList.remove('no-workspace');
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
  // Close any open file so the previous workspace's note/board/artifact does
  // not leak into this one (the keep-your-place behaviour is intentional across
  // view switches within a workspace, but not across workspace switches).
  closeOpenFile();
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
  unread.clearAll();
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
document.addEventListener('input',e=>{if((e.target.id==='editor-content'||e.target.id==='editor-textarea')&&currentFilePath&&editorMode==='edit'){editorDirty=true;document.getElementById('editor-status').textContent='Unsaved';document.getElementById('editor-status').style.color='var(--attention)';clearTimeout(saveTimer);saveTimer=setTimeout(()=>{saveFileGuarded(currentFilePath,getFileContentForSave());},1500);}});
const msgInput = document.getElementById('msg-input');
msgInput.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!e.shiftKey){
    // While the agent is responding, Enter inserts a newline (draft mode). To
    // send, stop the agent first; then Enter sends as usual.
    if(activeConversation && getConvoState(activeConversation.id).isProcessing) return;
    e.preventDefault();
    sendMessage();
  }
});
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
// The find bar itself moved to views/find.js. What stays here, and why:
//   findState       views/files.js reads it on an editor mode change, to close
//                   the bar when the search backend would otherwise change
//                   underneath it
//   initFindBar()   the call below is top-level wiring, not view code; the
//                   function it calls now lives in the module and is reached
//                   through the root republication, same as every other
//                   cross-module call in this file
const findState = {
  open: false,
  query: '',
  matches: [],          // <mark> elements for DOM backends
  currentIndex: 0,
  backend: null,        // 'conversation' | 'tiptap' | 'legacy-preview' | 'artifact' | 'textarea' | null
  inputTimer: null,
  _propCount: 0,        // tiptap backend: leading matches that are properties-panel DOM marks
};

initFindBar();

// Rendered wikilinks used to carry their own onclick. One delegated listener
// replaces every one of them, so the target is never written into the page as
// code. Registered once, here, because the markup it serves is rewritten with
// innerHTML on every streaming frame in chat and on every file preview.
RundockMarkdown.attachWikilinkHandler(document, (target) => openWikilink(target));

// Same move for the copy button on a rendered code block: the renderer wrote
// an onclick, and now one listener serves every block it will ever render.
RundockMarkdown.attachCodeCopyHandler(document);

// ===== 18. UNIVERSAL SEARCH PALETTE (Cmd+K / Ctrl+K) =====
// The palette itself moved to views/palette.js. What stays here, and why:
//   paletteOpen           the find bar's Escape handler defers to it, and the
//                         keydown wiring at the foot of this file reads it
//   paletteSel            the palette input's Enter handler reads it
//   palettePendingSkill   the WS `skills` handler replays a pending selection
//   pendingMessageAnchor  openConversation clears it (views/conversations.js)
//   PALETTE_GROUP_LIMIT   reads RundockPalette at load; evaluating it inside
//                         the view factory would throw under a Node require
//   IS_MAC                the top bar's shortcut hint below reads it
// The window chrome insets and the update strip that follow are separate
// concerns that happened to sit inside this section; with the palette body
// gone, each banner now owns the block beneath it.

let paletteOpen = false;
let paletteSel = 0;
let palettePendingSkill = null;
var pendingMessageAnchor = null; // {convoId, text, fragment}: var: openConversation clears it and runs before this section during load-order-sensitive paths

// Group order/labels/limit live in palette-model.js (unit-tested).
const PALETTE_GROUP_LIMIT = RundockPalette.GROUP_LIMIT;
const IS_MAC = /Mac/i.test(navigator.platform);

// ── Window chrome insets ─────────────────────────────────────────────────────
//
// macOS puts its window controls top-left, Windows top-right. Rather than two
// layouts, the top bar reserves an inset on each side and these two variables
// carry the entire difference. The DECISION lives in chrome-insets.js (pure,
// unit-tested across the platform matrix); this is only the plumbing that
// feeds it real values and writes the result to CSS.
//
// In a browser both stay 0, which is also the Linux case, so nothing here
// needs a browser-versus-Electron branch.
function applyChromeInsets() {
  if (typeof computeChromeInsets !== 'function') return;
  const overlay = navigator.windowControlsOverlay;
  const insets = computeChromeInsets({
    platform: window.electronAPI?.platform ?? null,
    viewportWidth: window.innerWidth,
    fullScreen: document.body.classList.contains('is-fullscreen'),
    // getTitlebarAreaRect is only meaningful once the overlay is enabled and
    // laid out; computeChromeInsets treats a non-visible overlay as zero.
    overlay: overlay ? { visible: overlay.visible, rect: overlay.getTitlebarAreaRect?.() } : null,
  });
  const root = document.documentElement.style;
  root.setProperty('--chrome-inset-left', insets.left + 'px');
  root.setProperty('--chrome-inset-right', insets.right + 'px');
}

// The caption width is NOT a constant: it changes with DPI scaling and again
// when the window maximises. geometrychange is how Windows tells us, and
// hardcoding 138 instead is the classic bug this avoids.
navigator.windowControlsOverlay?.addEventListener?.('geometrychange', applyChromeInsets);
window.addEventListener('resize', applyChromeInsets);

// macOS hides the traffic lights in fullscreen; keeping the inset would leave
// a permanent empty gap at the top-left.
window.electronAPI?.onFullScreenChange?.((isFullScreen) => {
  document.body.classList.toggle('is-fullscreen', !!isFullScreen);
  applyChromeInsets();
});

applyChromeInsets();

// ===== UPDATE STRIP =====
// The sidebar's update surface. The main process decides what the user
// should know (its decision object arrives on the update channel); the pure
// view module decides how the strip presents it; this code only draws.
// "Later" defers the ready row to a quiet chip for this session; it never
// dismisses, because the pending update stays pending regardless, and the
// next launch re-offers the prompt.
let _updateUi = null;
let _updateDeferred = false;

// Radial progress ring, 18px. r=7 so the circumference is 43.98; the arc is
// drawn from 12 o'clock via the -90 degree rotation. A null percent renders
// the indeterminate spinner (a fixed arc the CSS rotates).
function updateRingSvg(percent) {
  const base = '<circle cx="9" cy="9" r="7" fill="none" stroke="var(--border)" stroke-width="2"/>';
  if (percent === null) {
    return `<span class="u-ring indet"><svg width="18" height="18" viewBox="0 0 18 18">${base}<circle cx="9" cy="9" r="7" fill="none" stroke="var(--working)" stroke-width="2" stroke-linecap="round" stroke-dasharray="11 33"/></svg></span>`;
  }
  const C = 43.98;
  const off = (C * (1 - Math.max(0, Math.min(100, percent)) / 100)).toFixed(2);
  return `<span class="u-ring"><svg width="18" height="18" viewBox="0 0 18 18">${base}<circle cx="9" cy="9" r="7" fill="none" stroke="var(--working)" stroke-width="2" stroke-linecap="round" stroke-dasharray="43.98" stroke-dashoffset="${off}" transform="rotate(-90 9 9)"/></svg></span>`;
}

// The decided text carries the version inside a plain sentence; bolding just
// that phrase is presentation, so it happens here, after escaping.
function updateTextHtml(text, version) {
  const safe = esc(text || '');
  if (!version) return safe;
  const phrase = esc('Rundock ' + version);
  return safe.replace(phrase, `<b>${phrase}</b>`);
}

function renderUpdateStrip() {
  const el = document.getElementById('update-strip');
  if (!el || typeof updateStripView !== 'function') return;
  const view = updateStripView(_updateUi, _updateDeferred);
  if (!view.show) {
    el.style.display = 'none';
    el.className = 'u-strip';
    el.innerHTML = '';
    el.removeAttribute('tabindex');
    return;
  }
  el.style.display = '';
  if (view.mode === 'download') {
    const pctNum = view.indeterminate ? null : Math.round(view.percent);
    el.className = 'u-strip collapsed dl';
    // Focusable so keyboard users can expand the collapsed ring, matching
    // the pointer's hover.
    el.setAttribute('tabindex', '0');
    el.innerHTML = `
      <div class="u-collapsed-row">${updateRingSvg(pctNum)}${pctNum === null ? '' : `<span class="u-collapsed-pct">${pctNum}%</span>`}</div>
      <div class="u-row u-expanded-row">${updateRingSvg(pctNum)}<span class="u-text">${updateTextHtml(view.text, _updateUi && _updateUi.version)}</span>${pctNum === null ? '' : `<span class="u-pct">${pctNum}%</span>`}</div>`;
    return;
  }
  if (view.mode === 'chip') {
    el.className = 'u-strip collapsed';
    el.removeAttribute('tabindex');
    // The dot alone was reviewed as too cryptic: two quiet words state the
    // fact and keep the nudge alive without nagging.
    el.innerHTML = `<button class="u-collapsed-row" onclick="undeferUpdateStrip()" aria-label="An update is ready; show details"><span class="u-dot"></span><span class="u-collapsed-label">Update ready</span></button>`;
    return;
  }
  // ready (and stuck, which presents the same and cannot be deferred)
  el.className = 'u-strip expanded';
  el.removeAttribute('tabindex');
  const restartSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';
  el.innerHTML = `
    <div class="u-row"><span class="u-dot"></span><span class="u-text ready">${updateTextHtml(view.text, _updateUi && _updateUi.version)}</span></div>
    <div class="u-actions">
      <button class="u-restart-btn" onclick="updateRestartNow()">${restartSvg}Restart</button>
      ${_updateUi && _updateUi.kind === 'ready' ? '<button class="u-collapse-link" onclick="deferUpdateStrip()">Later</button>' : ''}
    </div>`;
}

function updateRestartNow() { try { window.electronAPI?.updateRestart?.(); } catch (e) { /* main handles logging */ } }
function deferUpdateStrip() { _updateDeferred = true; renderUpdateStrip(); }
function undeferUpdateStrip() { _updateDeferred = false; renderUpdateStrip(); }

window.electronAPI?.onUpdate?.((ui) => {
  _updateUi = ui;
  // A fresh download supersedes any earlier "Later": the deferral belonged
  // to the update it deferred.
  if (ui && ui.kind === 'progress') _updateDeferred = false;
  renderUpdateStrip();
});

// The top bar's search field teaches the shortcut with the right modifier per
// platform (the Windows and Linux builds have no Cmd key). It sits inline in
// the field rather than in a tooltip, so it does not have to be hovered to be
// discovered, which was the weakness of the rail icon it replaced.
{
  const kbd = document.getElementById('tb-search-kbd');
  if (kbd) kbd.textContent = IS_MAC ? '⌘K' : 'Ctrl K';
}

// Documentation was reachable only from three authentication error states and
// nowhere else in the interface.
//
// No IPC needed: main.js already installs a setWindowOpenHandler that hands
// any window.open to shell.openExternal and denies the popup, so this opens
// the default browser in Electron and a new tab in the browser build, from
// one line that knows about neither.
function openDocs() {
  window.open('https://docs.rundock.ai/', '_blank', 'noopener');
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
