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

let ws=null, agents=[], conversations=[], activeConversation=null, currentView='home', currentFilePath=null, skills=[], skillsLoaded=false, currentWorkspacePath=null, workspaceAnalysis=null, workspaceIsEmpty=false, workspaceMode='knowledge', setupComplete=true, conversationsLoaded=false, activeSidebarPill='all';
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
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'save_file', path: currentFilePath, content }));
    }
    const statusEl = document.getElementById('editor-status');
    if (statusEl) {
      statusEl.style.color = 'var(--success)';
      statusEl.textContent = 'Saved';
    }
  });
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
function stripRundockMarkers(t){return t.replace(/<!-- RUNDOCK:RETURN -->/g,'').replace(/<!-- RUNDOCK:(?:SAVE|CREATE)_AGENT name=[\w-]+ -->[\s\S]*?<!-- \/RUNDOCK:(?:SAVE|CREATE)_AGENT -->/g,'').replace(/<!-- RUNDOCK:SAVE_SKILL name=[\w-]+ -->[\s\S]*?<!-- \/RUNDOCK:SAVE_SKILL -->/g,'').replace(/<!-- RUNDOCK:DELETE_(?:SKILL|AGENT) name=[\w-]+ -->/g,'');}

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
    case 'system':
      // Track active process per conversation to ignore stale events
      if(d.subtype==='process_started' && convoId && d._processId) {
        const state = getConvoState(convoId);
        console.log(`[Process] convo=${convoId} process_started pid=${d._processId} prev=${state.activeProcessId} agent=${d._agent||'?'}`);
        state.activeProcessId = d._processId;
        // Remove stale permission cards from the previous process
        document.querySelectorAll('.msg-permission').forEach(el => el.remove());
        // Silent-park turn: suppress all UI (no thinking indicator, no resume badge)
        state.silentTurn = d.silent === true;
        // Auto-continue: orchestrator picking up after specialist return
        if(d.autoContinue && !state.silentTurn) { startProcessing(convoId); }
      }
      // Capture session ID from init message and persist for resume after refresh
      if(d.subtype==='init' && d._sessionId && convoId) {
        const convo = conversations.find(c => c.id === convoId);
        if(convo) {
          const agentId = d._agent || convo.agentId;
          const isOrchestrator = agentId === convo.agentId;
          // Only set the primary sessionId for the orchestrator (used for --resume on reload).
          // Delegate sessions are tracked in sessionIds but don't replace the primary.
          if (isOrchestrator || !convo.sessionId) {
            convo.sessionId = d._sessionId;
          }
          // Track all sessionIds for history loading across delegation chain
          if (!convo.sessionIds) convo.sessionIds = [];
          if (!convo.sessionIds.find(s => s.sessionId === d._sessionId)) {
            convo.sessionIds.push({ sessionId: d._sessionId, agentId });
          }
          persistConversation(convo);
        }
      }
      // Stale session: server is retrying fresh, clear the old sessionId
      if(d.subtype==='info' && d.content && convoId) {
        const convo = conversations.find(c => c.id === convoId);
        if(convo && convo.sessionId) {
          convo.sessionId = null;
          persistConversation(convo);
        }
        addSystemMsgToConvo(d.content, convoId, false);
      }
      // Agent was cancelled by user
      if(d.subtype==='cancelled' && convoId) {
        const state = getConvoState(convoId);
        // Add a cancelled badge to the current streaming message if there is one
        const streamEl = state.currentStreamingMsg;
        if (streamEl) {
          const badge = document.createElement('span');
          badge.className = 'cancelled-badge';
          badge.textContent = 'Cancelled';
          const bubble = streamEl.querySelector('.msg-bubble');
          if (bubble) bubble.appendChild(badge);
          const actSummary = buildActivitySummary(d._toolCalls || [], d._turnStartTime || null);
          if (actSummary) streamEl.appendChild(actSummary);
        }
        addSystemMsgToConvo('Agent stopped by user.', convoId, false);
      }
      // Only finish if this done event is from the currently active process
      if(d.subtype==='done' && convoId) {
        const state = getConvoState(convoId);
        const match = !d._processId || !state.activeProcessId || d._processId === state.activeProcessId;
        console.log(`[Done] convo=${convoId} pid=${d._processId} active=${state.activeProcessId} match=${match} isProcessing=${state.isProcessing}`);
        if(match) {
          finishProcessing(convoId);
        } else {
          console.warn(`[Done] SKIPPED finishProcessing: process ID mismatch`);
        }
      }
      // Agent switch: delegation handoff or return
      if(d.subtype==='agent_switch' && convoId) {
        const toAgent = agents.find(a => a.id === d.toAgent);
        const fromAgent = agents.find(a => a.id === d.fromAgent);
        const state = getConvoState(convoId);
        // Capture the agent we're switching away from so we can clear its
        // working indicator. Without this, the outgoing agent stays pinned
        // to "working" in the sidebar row and org chart dot forever.
        const outgoingAgentId = state.activeAgentId || conversations.find(c=>c.id===convoId)?.agentId;
        state.delegationActive = !!toAgent && toAgent.type !== 'orchestrator';
        state.activeAgentId = d.toAgent;
        // Clear the outgoing agent's working indicator, but only if it isn't
        // still legitimately working on another conversation. Also stamp
        // last-activity so the sidebar row shows a timestamp instead of blank.
        if (outgoingAgentId && outgoingAgentId !== d.toAgent && !getWorkingAgentIds().has(outgoingAgentId)) {
          const convo = conversations.find(c => c.id === convoId);
          agentLastActivity[outgoingAgentId] = { time: new Date(), label: convo?.title || '' };
          const outRow = document.querySelector(`[data-status="${outgoingAgentId}"]`);
          if (outRow) { outRow.textContent = formatTimeAgo(new Date()); outRow.classList.remove('working'); }
          const outDot = document.querySelector(`[data-org-status="${outgoingAgentId}"]`);
          if (outDot) outDot.classList.remove('working');
        }
        // Finalize any in-progress orchestrator text before resetting streaming state.
        // Without this, the orchestrator's handoff message (e.g. "I'll delegate this to Dev")
        // is orphaned when currentStreamingMsg is nulled and the specialist's stream overwrites it.
        if (state.streamingRawText) {
          let handoffText = state.streamingRawText;
          // Strip RUNDOCK markers (DELEGATE, SAVE_AGENT, etc.) from the finalized text
          handoffText = handoffText.replace(/<!-- RUNDOCK:DELEGATE agent=[\w-]+ -->\n?[\s\S]*/g, '').trim();
          handoffText = stripRundockMarkers(handoffText).trim();
          if (handoffText) {
            const convo = conversations.find(c => c.id === convoId);
            const orchestratorAgentId = outgoingAgentId || convo?.agentId;
            if (convo) {
              convo.messages.push({ role: 'agent', content: handoffText, agentId: orchestratorAgentId, timestamp: new Date().toISOString() });
            }
            // If the streaming bubble exists in the DOM, promote it to a permanent node
            // by clearing the streaming-text class and re-rendering with final content
            if (state.currentStreamingMsg && activeConversation?.id === convoId) {
              const streamEl = state.currentStreamingMsg.querySelector('.streaming-text');
              if (streamEl) {
                streamEl.classList.remove('streaming-text');
                streamEl.innerHTML = formatMd(handoffText);
              }
            }
          }
        }
        // Reset streaming state so the new agent gets a fresh bubble
        state.currentStreamingMsg = null;
        state.streamingRawText = '';
        state.latestText = '';
        state.latestAgentId = null;
        renderConvoList();
        // Determine if this is a return (back to orchestrator or back to parent)
        // vs a forward delegation (orchestrator->specialist or specialist->sub-specialist)
        const isReturn = toAgent?.type === 'orchestrator';
        if(activeConversation?.id === convoId) {
          if(toAgent && fromAgent) {
            const m = document.getElementById('messages');
            m.appendChild(buildDelegationDivider(toAgent, isReturn));
            scrollBottom();
            // Persist divider as explicit marker so it survives navigate-away/back
            const convo = conversations.find(c => c.id === convoId);
            if (convo) {
              convo.messages.push({ role: 'divider', agentId: d.toAgent, fromAgentId: d.fromAgent, isReturn });
            }
          }
          // Update chat header
          if(toAgent) {
            const headerLabel = document.getElementById('chat-agent-label');
            const headerAvatar = document.getElementById('chat-agent-avatar');
            if(headerLabel) headerLabel.textContent = toAgent.displayName;
            if(headerAvatar) { headerAvatar.style.background = toAgent.colour; headerAvatar.textContent = toAgent.icon; }
            document.getElementById('msg-input').placeholder = 'Message ' + toAgent.displayName + '...';
          }
        }
        // Show delegate as working AFTER the divider is rendered
        if (!isReturn && state.delegationActive) {
          startProcessing(convoId);
        }
      }
      if(d.subtype==='delegation_error' && convoId) {
        addSystemMsgToConvo(d.content || 'Delegation failed', convoId, true);
      }
      if(d.subtype==='auth_error' && convoId) {
        renderAuthErrorCard(convoId);
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
    case 'agent_saved':
      if (!d.updated) setupComplete = true;
      addSystemMsg('Agent "' + (d.agentId || '') + '" ' + (d.updated ? 'updated' : 'created'));
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
  if(!convoState[convoId]) convoState[convoId] = { isProcessing: false, currentStreamingMsg: null, latestText: '', streamingRawText: '', latestAgentId: null, activeProcessId: null };
  return convoState[convoId];
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
  if(!d._processId) return false;
  const state = getConvoState(convoId);
  const stale = state.activeProcessId && d._processId !== state.activeProcessId;
  if(stale) console.warn(`[Stale] convo=${convoId} dropped ${d.type} from pid=${d._processId} (active=${state.activeProcessId})`);
  return stale;
}

function handleStreamEvent(d, convoId) {
  const evt = d.event; if(!evt) return;
  const state = getConvoState(convoId);
  state.lastStreamActivity = Date.now();
  const isActive = activeConversation?.id === convoId;

  // Text streaming: always accumulate raw text, only render DOM when active
  if(evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
    let text = evt.delta.text;
    // Insert newline between tool-use progress updates so they don't run together
    if(state.afterToolUse && state.streamingRawText && state.streamingRawText.length > 0) {
      text = '\n\n' + text;
    }
    state.afterToolUse = false;

    state.streamingRawText += text;

    if(isActive && !state.silentTurn) {
      // Create streaming message bubble if it doesn't exist yet
      if(!state.currentStreamingMsg) {
        // Remove thinking indicator, replace with streaming bubble
        const t = document.getElementById('thinking-indicator'); if(t) t.remove();
        const agentId = d._agent || state.activeAgentId || state.latestAgentId;
        const a = agents.find(x => x.id === agentId) || activeConversation?.agent || agents[0];
        const m = document.getElementById('messages'), el = document.createElement('div');
        el.className = 'msg msg-agent';
        el.innerHTML = `<div class="msg-sender" style="color:${a?.colour||'var(--accent)'}"><div class="avatar xs" style="background:${a?.colour||'var(--accent)'}">${a?.icon||'?'}</div> ${a?.displayName||'Agent'}<span class="msg-time">${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span></div><div class="msg-bubble"><span class="streaming-text"></span></div>`;
        m.appendChild(el);
        state.currentStreamingMsg = el;
      }

      const streamEl = state.currentStreamingMsg.querySelector('.streaming-text');
      if(streamEl) {
        // Strip RUNDOCK markers during streaming so marker content never leaks to the user
        let displayText = state.streamingRawText;
        // Complete marker blocks (opening + content + closing)
        displayText = displayText.replace(/<!--\s*RUNDOCK:[A-Z_]+ [^>]*-->\n?[\s\S]*?<!--\s*\/RUNDOCK:[A-Z_]+ -->/g, '');
        // Standalone markers (DELETE, RETURN)
        displayText = displayText.replace(/<!--\s*RUNDOCK:(?:DELETE_\w+ name=[\w-]+|RETURN)\s*-->/g, '');
        // Partial/incomplete marker still streaming (no closing tag yet)
        displayText = displayText.replace(/<!--\s*RUNDOCK:[\s\S]*$/g, '');
        streamEl.innerHTML = formatMd(displayText);
      }
      scrollBottom();
    }
  }

  // Tool use: update thinking indicator when active
  if(evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
    state.afterToolUse = true;
    const toolName = evt.content_block.name || '';

    if(isActive && !state.silentTurn) {
      let status = document.getElementById('thinking-status');
      if(!status) {
        // Thinking indicator was removed when streaming started; re-add it below the streaming message
        const agentId = d._agent || state.activeAgentId || state.latestAgentId;
        const a = agents.find(x => x.id === agentId) || activeConversation?.agent || agents[0];
        const m = document.getElementById('messages'), el = document.createElement('div');
        el.className = 'msg msg-agent'; el.id = 'thinking-indicator';
        el.innerHTML = `<div class="msg-sender" style="color:${a?.colour||'var(--accent)'}"><div class="avatar xs" style="background:${a?.colour||'var(--accent)'}">${a?.icon||'?'}</div> ${a?.displayName||'Agent'}</div><div class="msg-bubble thinking-bubble"><div class="thinking-pulse" style="background:${a?.colour||'var(--accent)'}"></div><div><div class="thinking-label">Thinking</div><div class="thinking-status" id="thinking-status"></div></div></div>`;
        m.appendChild(el);
        scrollBottom();
        status = el.querySelector('#thinking-status');
      }
      if(status) status.textContent = formatToolName(toolName);
    }
    // Refresh file tree when file-writing tools are used (with delay for disk flush)
    if(/^(Write|Edit|Bash|NotebookEdit)/.test(toolName)) {
      setTimeout(() => {
        if(ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'get_files' }));
      }, 1000);
    }
  }
}

function handleAssistant(d, convoId) {
  const msg=d.message; if(!msg?.content) return;
  const state = getConvoState(convoId);
  state.lastStreamActivity = Date.now();
  const isActive = activeConversation?.id === convoId;

  for(const block of msg.content) {
    if(block.type==='text' && block.text) {
      state.latestText = block.text;
      state.latestAgentId = d._agent;
    } else if(block.type==='tool_use') {
      if(isActive) {
        const status = document.getElementById('thinking-status');
        if(status) status.textContent = formatToolName(block.name);
        scrollBottom();
      }
    }
  }
}

function handleResult(d, convoId) {
  const state = getConvoState(convoId);
  const isActive = activeConversation?.id === convoId;
  const convo = conversations.find(c => c.id === convoId);
  const agentId = d._agent || state.activeAgentId || state.latestAgentId;
  let delegationTriggered = false;

  try {
  // Detect agent and skill definitions in responses and route to server.
  // SAVE markers (upsert): RUNDOCK:SAVE_AGENT, RUNDOCK:SAVE_SKILL
  // Legacy CREATE markers also supported for backward compatibility.
  // Prefer streamingRawText: it contains the raw text with HTML comment markers intact.
  // d.result from stream-json is often empty or may strip HTML comments.
  const textToScan = state.streamingRawText || d.result || state.latestText || '';
  if(textToScan && ws) {
    let filesCreated = 0;

    // SAVE_AGENT and CREATE_AGENT markers (both route to save_agent for upsert)
    // Content is extracted between HTML comment markers. Code fences inside
    // are cosmetic (formatting in Claude's output) and stripped if present,
    // but NOT used as parsing delimiters. This prevents truncation when the
    // agent body contains inner code fences (e.g. frontmatter templates).
    const agentMarkerPattern = /<!-- RUNDOCK:(?:SAVE|CREATE)_AGENT name=([\w-]+) -->\n([\s\S]*?)<!-- \/RUNDOCK:(?:SAVE|CREATE)_AGENT -->/g;
    let match;
    while((match = agentMarkerPattern.exec(textToScan)) !== null) {
      const content = match[2].replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, '').trim();
      ws.send(JSON.stringify({ type: 'save_agent', name: match[1], content }));
      filesCreated++;
      console.log('[Agent] Marker save:', match[1]);
    }

    // SAVE_SKILL markers (same fence-stripping approach)
    const skillMarkerPattern = /<!-- RUNDOCK:SAVE_SKILL name=([\w-]+) -->\n([\s\S]*?)<!-- \/RUNDOCK:SAVE_SKILL -->/g;
    while((match = skillMarkerPattern.exec(textToScan)) !== null) {
      const content = match[2].replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, '').trim();
      ws.send(JSON.stringify({ type: 'save_skill', name: match[1], content }));
      filesCreated++;
      console.log('[Skill] Marker save:', match[1]);
    }

    // DELETE markers (no content, just the name)
    const deleteSkillPattern = /<!-- RUNDOCK:DELETE_SKILL name=([\w-]+) -->/g;
    while((match = deleteSkillPattern.exec(textToScan)) !== null) {
      ws.send(JSON.stringify({ type: 'delete_skill', name: match[1] }));
      filesCreated++;
      console.log('[Skill] Marker delete:', match[1]);
    }
    const deleteAgentPattern = /<!-- RUNDOCK:DELETE_AGENT name=([\w-]+) -->/g;
    while((match = deleteAgentPattern.exec(textToScan)) !== null) {
      ws.send(JSON.stringify({ type: 'delete_agent', agentId: match[1] }));
      filesCreated++;
      console.log('[Agent] Marker delete:', match[1]);
    }

    // DELEGATE marker: orchestrator hands off to another agent
    const delegatePattern = /<!-- RUNDOCK:DELEGATE agent=([\w-]+) -->\n?([\s\S]*?)<!-- \/RUNDOCK:DELEGATE -->/;
    const delegateMatch = textToScan.match(delegatePattern);
    if (delegateMatch) {
      const targetAgent = delegateMatch[1];
      const context = delegateMatch[2].trim();
      console.log('[Delegate] Detected:', targetAgent, 'context:', context.substring(0, 100));
      ws.send(JSON.stringify({ type: 'delegate', conversationId: convoId, targetAgent, context }));
      delegationTriggered = true;
    }

    // RETURN marker: delegate signals task complete, return to orchestrator
    if (/<!-- RUNDOCK:RETURN -->/.test(textToScan)) {
      console.log('[Delegate] Return detected');
      ws.send(JSON.stringify({ type: 'end_delegation', conversationId: convoId }));
    }

    // Fallback: detect raw YAML frontmatter blocks with agent fields (name + type)
    // This handles cases where the LLM outputs agent files without the marker wrapper
    if(filesCreated === 0) {
      const fmPattern = /```[^\n]*\n(---\n[\s\S]*?\n---[\s\S]*?)```/g;
      let fmMatch;
      while((fmMatch = fmPattern.exec(textToScan)) !== null) {
        const block = fmMatch[1].trim();
        const nameMatch = block.match(/^name:\s*(.+)$/m);
        const typeMatch = block.match(/^type:\s*(orchestrator|specialist)$/m);
        if(nameMatch && typeMatch) {
          const slug = nameMatch[1].trim();
          ws.send(JSON.stringify({ type: 'save_agent', name: slug, content: block }));
          filesCreated++;
          console.log('[Agent] Fallback extraction:', slug);
        }
      }
      // Also try without code fences (raw frontmatter separated by ---)
      if(filesCreated === 0) {
        const rawBlocks = textToScan.split(/\n(?=---\nname:\s)/).filter(b => b.trim().startsWith('---'));
        for(const block of rawBlocks) {
          const nameMatch = block.match(/^name:\s*(.+)$/m);
          const typeMatch = block.match(/^type:\s*(orchestrator|specialist)$/m);
          if(nameMatch && typeMatch) {
            const slug = nameMatch[1].trim();
            const content = block.trim();
            ws.send(JSON.stringify({ type: 'save_agent', name: slug, content }));
            filesCreated++;
            console.log('[Agent] Raw frontmatter extraction:', slug);
          }
        }
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

  // In stream-json mode, the response text arrives via stream_event deltas
  // and is rendered in real-time. The 'result' message is a completion signal.
  // Use streamed text if result field is empty (which it usually is in stream-json).
  let responseText = state.streamingRawText || d.result || state.latestText || '';
  // Strip RUNDOCK markers from displayed text
  // DELEGATE: strip the marker block AND any text after it (orchestrator should stop after delegating)
  responseText = responseText.replace(/<!-- RUNDOCK:DELEGATE agent=[\w-]+ -->\n?[\s\S]*/g, '').trim();
  responseText = stripRundockMarkers(responseText).trim();

  // Strip silent-park sentinel and drop if response is a no-op
  const silentStripped = responseText.replace(/<silent>/gi, '').trim();
  const isNoOp = silentStripped.length < 10 || /^(No response requested\.|\.|OK|ok|Understood\.|Acknowledged\.)$/i.test(silentStripped);
  if (isNoOp && responseText) {
    // Silent-park turn: remove any streaming bubble and deferred resume badge from the DOM, reset state, skip render
    if (state.currentStreamingMsg) {
      state.currentStreamingMsg.remove();
    }
    state.currentStreamingMsg = null; state.streamingRawText = ''; state.latestText = ''; state.latestAgentId = null; state.silentTurn = false;
    if (!delegationTriggered) finishProcessing(convoId);
    renderConvoList();
    return;
  }
  responseText = silentStripped;

  if(responseText && convo) {
    convo.messages.push({role:'agent', content: responseText, agentId, timestamp: new Date().toISOString()});
    convo.lastAgentId = agentId;
    convo.lastMessagePreview = stripMd(responseText).substring(0, 80);
    const viewingChat = isActive && currentView === 'chat';
    const convoInWorkspace = conversations.some(c => c.id === convoId);
    if (convoInWorkspace && !viewingChat) {
      unreadConvos.add(convoId);
      updateUnreadBadge();
    }
  }

  if(isActive) {
    const t=document.getElementById('thinking-indicator'); if(t) t.remove();
    if(state.currentStreamingMsg) {
      // Text was already streamed in real-time. Do a final re-render with complete markdown.
      const streamEl = state.currentStreamingMsg.querySelector('.streaming-text');
      if(streamEl && responseText) streamEl.innerHTML = formatMd(responseText);
      const actSummary = buildActivitySummary(d._toolCalls || [], d._turnStartTime || null);
      if(actSummary) state.currentStreamingMsg.appendChild(actSummary);
    } else if(responseText) {
      // No streaming happened (e.g. very short response). Render now.
      const msgEl = addAgentMsg(responseText, agentId);
      const actSummary = buildActivitySummary(d._toolCalls || [], d._turnStartTime || null);
      if(actSummary && msgEl) msgEl.appendChild(actSummary);
    }
  }

  } catch(err) {
    console.error('[handleResult] Error:', err);
  }
  state.currentStreamingMsg=null; state.streamingRawText=''; state.latestText=''; state.latestAgentId=null; state.silentTurn=false;
  // Don't finish processing when the orchestrator just delegated: the delegate is about to start
  if (!delegationTriggered) finishProcessing(convoId);
  renderConvoList();
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
      } else if (!a._orgParent) {
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
  // Routines + Configuration card
  const hasRoutines = a.routines && a.routines.length;
  const hasConnectors = a.capabilities?.connectors;
  if(hasRoutines || hasConnectors || a.model) {
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

function startConversation(agentId) {
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
// workspace switch via onWorkspaceReady.
function setSidebarPill(pill) {
  activeSidebarPill = pill;
  ['all','unread'].forEach(p => {
    document.getElementById('pill-' + p)?.classList.toggle('active', p === pill);
  });
  renderConvoList();
}

function renderConvoList() {
  // WhatsApp-model list (SR1 UI alignment): pinned conversations always group
  // at the top, then everything else; BOTH groups sort by lastActiveAt desc.
  // Pinned-ness is conveyed by position plus the title-row pin glyph; the
  // left-border channel is reserved for the unread/working signal (green).
  // Pills are All | Unread only: pinning is a layout concern, not a filter,
  // so the old Pinned pill is gone.
  const sortKeyTime = c => c.lastActiveAt || c.pinnedAt || c.createdAt || '';
  const compareTimeDesc = (a, b) => sortKeyTime(b).localeCompare(sortKeyTime(a));
  const pinnedFirst = (a, b) => ((b.pinned === true) - (a.pinned === true)) || compareTimeDesc(a, b);

  let main = conversations.filter(c => c.status !== 'archived');
  if (activeSidebarPill === 'unread') main = main.filter(c => unreadConvos.has(c.id));
  main.sort(pinnedFirst);

  const archived = conversations
    .filter(c => c.status === 'archived')
    .sort(compareTimeDesc);

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
    const variant = (c.persisted && !c.pinned) ? 'previous' : 'current';
    h += renderConvoItem(c, variant);
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

  return `<div class="${classes.join(' ')}" ${styleAttr} onclick="openConversation('${c.id}')">
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
  // Safety net: if no streaming activity for 90s, auto-finish to prevent stuck UI
  if(state.processingTimeout) clearInterval(state.processingTimeout);
  state.processingTimeout = setInterval(() => {
    if(!state.isProcessing) { clearInterval(state.processingTimeout); state.processingTimeout=null; return; }
    const idle = Date.now() - (state.lastStreamActivity || 0);
    if(idle > 90000) {
      console.warn(`[Timeout] convo=${convoId} no streaming activity for ${Math.round(idle/1000)}s, auto-finishing`);
      clearInterval(state.processingTimeout); state.processingTimeout=null;
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
  state.isProcessing=false; state.currentStreamingMsg=null;
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

const BASH_DESCRIPTIONS = {
  ls: 'List directory contents', cat: 'Read file contents', head: 'Read start of file',
  tail: 'Read end of file', grep: 'Search file contents', rg: 'Search file contents',
  find: 'Find files', echo: 'Print text', pwd: 'Show current directory',
  mkdir: 'Create directory', cp: 'Copy files', mv: 'Move or rename files',
  rm: 'Delete files', npm: 'Run npm', node: 'Run JavaScript', python: 'Run Python',
  python3: 'Run Python', pip: 'Install Python packages', git: 'Run git command',
  curl: 'Make HTTP request', wget: 'Download file', chmod: 'Change permissions',
  sudo: 'Run as superuser'
};

function bashBin(cmd) { return cmd.split(/\s+/)[0].replace(/^.*\//, ''); }

// Classify risk level of a tool request
function classifyRisk(toolName, input) {
  if (toolName === 'Bash') {
    const cmd = (input.command || '').trim();
    const highRisk = /^(rm|sudo|chmod|chown|kill|mkfs|dd|curl\s.*\|\s*sh|wget\s.*\|\s*sh)/.test(cmd)
      || /--force|--hard|-rf\b/.test(cmd)
      || /git\s+(push|reset|clean|checkout\s+\.)/.test(cmd);
    if (highRisk) return 'high';
    const lowRisk = /^(ls|cat|head|tail|echo|pwd|whoami|which|grep|rg|find|wc|sort|uniq|diff|file|stat|date|env|printenv|node\s+-e|python3?\s+-c)/.test(cmd);
    if (lowRisk) return 'low';
    return 'medium';
  }
  if (toolName === 'PowerShell') {
    // Windows shell tool. Same input shape as Bash (a `command` field).
    // Destructive checks run first so a read that also deletes can't be low.
    const cmd = (input.command || '').trim();
    const highRisk = /(^|[;&|]\s*)(Remove-Item|ri|rm|del|erase|rmdir|rd|Stop-Process|spps|kill|Stop-Service|Format-Volume|Clear-Content|Clear-Item|Set-ExecutionPolicy|Uninstall-[A-Za-z]+)\b/i.test(cmd)
      || /-Force\b/i.test(cmd)
      || /\b(iex|Invoke-Expression)\b/i.test(cmd)
      || /\b(irm|Invoke-RestMethod|iwr|Invoke-WebRequest|curl|wget)\b[\s\S]*\|\s*(iex|Invoke-Expression)/i.test(cmd);
    if (highRisk) return 'high';
    const lowRisk = /^(Get-[A-Za-z]+|ls|dir|gci|gc|cat|type|pwd|gl|echo|Write-Output|Write-Host|Select-Object|Where-Object|Measure-Object|Test-Path|Resolve-Path|Split-Path|Format-Table|Format-List|Sort-Object)\b/i.test(cmd);
    if (lowRisk) return 'low';
    return 'medium';
  }
  if (toolName.startsWith('mcp__')) {
    // MCP reads auto-approve in the permission hook, so by the time a request
    // reaches the card it's a write or destructive action. Flag destructive ones
    // as high (no "Always allow"); other writes are medium.
    const action = toolName.split('__').slice(2).join('_').toLowerCase();
    if (/(^|[_\-])(delete|remove|destroy|drop|cancel|abort|archive|trash|purge|clear|uninstall)([_\-]|$)/.test(action)) return 'high';
    return 'medium';
  }
  return 'medium';
}

// Build human-readable summary and context for a tool request
function describeToolRequest(toolName, input) {
  let summary = '';
  let context = '';
  let detail = '';

  if (toolName === 'Bash') {
    const cmd = (input.command || '').trim();
    detail = cmd;
    const bin = bashBin(cmd);
    summary = input.description || BASH_DESCRIPTIONS[bin] || `Run ${bin}`;
    if (bin === 'rm') context = 'This will permanently delete files';
    else if (bin === 'sudo') context = 'This runs with elevated privileges';
    else if (/git\s+push/.test(cmd)) context = 'This will push changes to a remote repository';
    else if (/git\s+reset\s+--hard/.test(cmd)) context = 'This will discard uncommitted changes';
    else if (bin === 'npm' && /install/.test(cmd)) context = 'This will install packages and modify node_modules';
  } else if (toolName === 'PowerShell') {
    const cmd = (input.command || '').trim();
    detail = cmd;
    summary = input.description || 'Run PowerShell command';
    if (/(^|[;&|]\s*)(Remove-Item|ri|rm|del|erase|rmdir|rd)\b/i.test(cmd)) context = 'This will delete files';
    else if (/-Force\b/i.test(cmd)) context = 'This uses -Force and may overwrite or delete without confirmation';
    else if (/\b(iex|Invoke-Expression)\b/i.test(cmd)) context = 'This executes a downloaded or dynamic script';
  } else if (toolName === 'Write') {
    summary = 'Create a file';
    detail = input.file_path || '';
  } else if (toolName === 'Edit') {
    summary = 'Edit a file';
    detail = input.file_path || '';
  } else if (toolName === 'Read') {
    summary = 'Read a file';
    detail = input.file_path || '';
  } else if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    const server = (parts[1] || 'connector').replace(/^claude_ai_/, '').replace(/_/g, ' ').trim();
    const action = parts.slice(2).join('_').replace(/^api[_\-\s]+/i, '').replace(/[_\-]+/g, ' ').trim();
    summary = action ? `${server}: ${action}` : `Use ${server}`;
    detail = toolName;
  } else {
    summary = `Use ${toolName}`;
    detail = JSON.stringify(input).substring(0, 200);
  }
  return { summary, context, detail };
}

// Key for always-allow matching
function toolAllowKey(toolName, input) {
  if (toolName === 'Bash') {
    return 'Bash:' + bashBin((input.command || '').trim());
  }
  if (toolName === 'PowerShell') {
    const verb = ((input.command || '').trim().match(/^[A-Za-z][\w-]*/) || ['PowerShell'])[0];
    return 'PowerShell:' + verb;
  }
  return toolName;
}

function handlePermissionRequest(d, convoId) {
  const isActive = activeConversation?.id === convoId;
  if (!isActive) return;

  const req = d.request || {};
  const requestId = d.request_id || '';
  const toolName = req.tool_name || 'Unknown';
  const input = req.input || {};
  const risk = classifyRisk(toolName, input);
  const { summary, context, detail } = describeToolRequest(toolName, input);
  const key = toolAllowKey(toolName, input);

  // Auto-allow if user previously chose "Always allow" for this pattern
  if (alwaysAllowedTools.has(key)) {
    if (ws) {
      ws.send(JSON.stringify({ type: 'permission_response', requestId, conversationId: convoId, allow: true }));
    }
    return;
  }

  // Auto-allow low-risk (read-only) commands: no permission card, activity summary provides visibility
  if (risk === 'low') {
    if (ws) {
      ws.send(JSON.stringify({ type: 'permission_response', requestId, conversationId: convoId, allow: true }));
    }
    return;
  }

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
        ${risk !== 'high' ? `<button class="btn-perm btn-always" data-perm-id="${esc(requestId)}" data-perm-action="always">Always allow</button>` : ''}
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

function respondPermission(requestId, allow, always) {
  const pending = pendingPermissions.get(requestId);
  if (!pending || !ws) return;
  pendingPermissions.delete(requestId);

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
});

// ===== 10. VIEWS & NAVIGATION =====

function switchNav(nav) {
  // Find bar is a per-view affordance: close on any nav change so highlights
  // and search state don't survive into a context where they no longer make
  // sense or reference DOM that's about to be replaced.
  closeFindBar();
  document.querySelectorAll('.nav-item[data-nav]').forEach(n=>n.classList.remove('active'));
  document.querySelector(`[data-nav="${nav}"]`)?.classList.add('active');
  ['team','conversations','skills','files','settings'].forEach(s=>document.getElementById(`sidebar-${s}`).classList.add('hidden'));
  document.getElementById(`sidebar-${nav}`).classList.remove('hidden');
  if(nav==='settings') { showView('settings'); showSettingsSection('workspace'); }
  else if(nav==='files') { editorReturnView = 'editor'; if(currentFilePath && document.querySelector('.file-item.active')) { showView('editor'); } else { currentFilePath = null; destroyTiptapEditorIfActive(); document.getElementById('editor-header').classList.add('hidden'); document.getElementById('editor-content').classList.add('hidden'); document.getElementById('editor-textarea').classList.add('hidden'); document.getElementById('tiptap-editor-pane').classList.add('hidden'); document.getElementById('editor-empty').classList.remove('hidden'); showView('editor'); } }
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
function buildTree(items,container) {
  for(const item of items) {
    if(item.type==='folder') {
      const f=document.createElement('div'); f.className='folder-item'; f.innerHTML=`<span class="folder-icon">&#x25B6;</span> ${esc(item.name)}`;
      f.onclick=()=>{const ch=f.nextElementSibling,ic=f.querySelector('.folder-icon');ch.classList.toggle('collapsed');ic.innerHTML=ch.classList.contains('collapsed')?'&#x25B6;':'&#x25BC;';};
      container.appendChild(f);
      const ch=document.createElement('div'); ch.className='file-children collapsed'; buildTree(item.children,ch); container.appendChild(ch);
    } else {
      const fi=document.createElement('div'); fi.className='file-item';
      fi.innerHTML=`<svg class="file-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> ${esc(item.name)}`;
      fi.dataset.path = item.path;
      fi.onclick=()=>{document.querySelectorAll('.file-item').forEach(x=>x.classList.remove('active'));fi.classList.add('active');editorReturnView='editor';fileHistory=[];ws.send(JSON.stringify({type:'read_file',path:item.path}));showView('editor');};
      container.appendChild(fi);
    }
  }
}

// Editor
let editorMode='preview', rawFileContent='', fileFrontmatter='', fileBody='';

function loadFileContent(path, content) {
  // Close any active find before swapping the editor content.
  if (currentFilePath !== path) closeFindBar();
  currentFilePath = path;
  rawFileContent = content;
  document.getElementById('editor-filename').textContent = path;
  document.getElementById('editor-status').textContent = '';
  document.getElementById('editor-header').classList.remove('hidden');
  document.getElementById('editor-empty').classList.add('hidden');

  // Markdown files open in the Tiptap surface; the legacy DOM and
  // Preview/Edit toggle are hidden and the Tiptap pane is shown and seeded.
  if (isMarkdownPath(path)) {
    document.getElementById('editor-content').classList.add('hidden');
    document.getElementById('editor-textarea').classList.add('hidden');
    document.getElementById('toggle-preview').classList.add('hidden');
    document.getElementById('toggle-edit').classList.add('hidden');
    document.getElementById('tiptap-editor-pane').classList.remove('hidden');
    fileFrontmatter = '';
    fileBody = content;
    initTiptapEditor(path, content);
    return;
  }

  // Legacy preview/edit path (non-markdown files, or Tiptap flag off).
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

function renderEditorContent() {
  const previewEl = document.getElementById('editor-content');
  const textareaEl = document.getElementById('editor-textarea');
  document.getElementById('toggle-preview').classList.toggle('active', editorMode === 'preview');
  document.getElementById('toggle-edit').classList.toggle('active', editorMode === 'edit');

  if (editorMode === 'preview') {
    textareaEl.classList.add('hidden');
    previewEl.classList.remove('hidden');
    previewEl.className = 'editor-content formatted';
    previewEl.innerHTML = formatMdFull(fileBody);
  } else {
    previewEl.classList.add('hidden');
    textareaEl.classList.remove('hidden');
    textareaEl.className = 'editor-content source';
    textareaEl.value = rawFileContent;
    textareaEl.focus();
  }
}

function setEditorMode(mode) {
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
  const searchName = baseName.endsWith('.md') ? baseName : baseName + '.md';
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
  document.querySelectorAll('.file-item').forEach(fi => {
    if (fi.dataset.path === filePath) {
      fi.classList.add('active');
    }
  });
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
    return;
  }
  // Otherwise stay in files view: clear file content, show empty state
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
        if (lang && window.hljs && hljs.getLanguage(lang)) {
          highlighted = hljs.highlight(text, { language: lang }).value;
          displayLang = hljs.getLanguage(lang).name || lang;
        } else if (!lang && window.hljs && text.length <= HLJS_AUTODETECT_MAX) {
          const result = hljs.highlightAuto(text);
          highlighted = result.value;
          displayLang = result.language ? (hljs.getLanguage(result.language)?.name || result.language) : '';
        } else {
          highlighted = escapeHtml(text);
          displayLang = lang || '';
        }
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
      <button class="settings-btn" onclick="changeWorkspace()">Change workspace</button>`;
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
document.addEventListener('input',e=>{if((e.target.id==='editor-content'||e.target.id==='editor-textarea')&&currentFilePath&&editorMode==='edit'){document.getElementById('editor-status').textContent='Unsaved';document.getElementById('editor-status').style.color='var(--attention)';clearTimeout(saveTimer);saveTimer=setTimeout(()=>{ws.send(JSON.stringify({type:'save_file',path:currentFilePath,content:getFileContentForSave()}));document.getElementById('editor-status').style.color='var(--success)';document.getElementById('editor-status').textContent='Saved';},1500);}});
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
  backend: null,        // 'conversation' | 'tiptap' | 'legacy-preview' | null
  inputTimer: null,
};

function isFindHotkey(e) {
  return (e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'f' || e.key === 'F');
}

function detectFindBackend() {
  // Return the active view's search backend, or null if find shouldn't
  // activate (e.g. workspace picker, settings, no file open).
  if (currentView === 'chat' && activeConversation) return 'conversation';
  if (currentView === 'editor' && activeTiptapEditor) return 'tiptap';
  if (currentView === 'editor' && currentFilePath) return 'legacy-preview';
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
  if (findState.backend === 'conversation' || findState.backend === 'legacy-preview') {
    // DOM backends: unwrap every <mark.find-match>, restoring original text
    // nodes. Coalesce adjacent text nodes via normalize() so subsequent
    // searches see a clean tree.
    const marks = document.querySelectorAll('mark.find-match');
    const parents = new Set();
    marks.forEach(mark => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parents.add(parent);
    });
    parents.forEach(p => p.normalize());
  } else if (findState.backend === 'tiptap') {
    // Tiptap backend: clear the find plugin's state, which empties the
    // decoration set. Document content is never touched.
    if (_tiptapEditorModuleResolved && activeTiptapEditor) {
      _tiptapEditorModuleResolved.clearFind(activeTiptapEditor);
    }
  }
  findState.matches = [];
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
  } else if (findState.backend === 'tiptap') {
    if (_tiptapEditorModuleResolved && activeTiptapEditor) {
      _tiptapEditorModuleResolved.setFindQuery(activeTiptapEditor, query);
      const tipState = _tiptapEditorModuleResolved.getFindState(activeTiptapEditor);
      // Populate findState.matches with placeholders so the count UI and the
      // navigation arithmetic both work without reaching back into the
      // plugin every time. The real match positions live in the plugin.
      findState.matches = tipState.matches.map(() => ({ tiptap: true }));
      findState.currentIndex = tipState.currentIndex;
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

function setCurrentFindMatch(idx) {
  findState.currentIndex = idx;
  if (findState.backend === 'tiptap') {
    if (_tiptapEditorModuleResolved && activeTiptapEditor) {
      // Plugin dispatches the index change, recomputes decorations, scrolls.
      _tiptapEditorModuleResolved.setFindIndex(activeTiptapEditor, idx);
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

const PALETTE_GROUP_ORDER = ['files', 'conversations', 'agents', 'skills'];
const PALETTE_GROUP_LABELS = { files: 'Files', conversations: 'Conversations', agents: 'Agents', skills: 'Skills' };
// Per-group result cap. Must match the `limit` sent in runPaletteSearch: the
// group-count labels use it to show "8+" instead of implying a full group is
// the exact total.
const PALETTE_GROUP_LIMIT = 8;
const IS_MAC = /Mac/i.test(navigator.platform);
let paletteReturnFocus = null; // element to restore focus to on close

// The nav rail tooltip teaches the shortcut with the right modifier per
// platform (the Windows and Linux builds have no Cmd key).
document.getElementById('nav-search-btn')?.setAttribute('data-tooltip', IS_MAC ? 'Search ⌘K' : 'Search Ctrl+K');

function openPalette() {
  if (currentView === 'workspace' || !currentWorkspacePath) return; // no workspace yet
  const overlay = document.getElementById('palette-overlay');
  if (!overlay) return;
  paletteOpen = true;
  paletteReturnFocus = document.activeElement;
  overlay.classList.remove('hidden');
  const input = document.getElementById('palette-input');
  input.value = paletteQuery = '';
  schedulePaletteSearch(0); // empty query -> recent items
  input.focus();
}

function closePalette() {
  paletteOpen = false;
  clearTimeout(paletteTimer);
  document.getElementById('palette-overlay')?.classList.add('hidden');
  // Return focus to where the user was (keyboard flow continuity); fall
  // back silently when the element is gone or was never focusable.
  if (paletteReturnFocus && document.contains(paletteReturnFocus)) {
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
  if (d.reqId !== paletteReqId) return;
  paletteLoading = false;
  paletteReply = d;
  paletteSel = 0;
  renderPalette();
}

// Escape then swap the server's control-char highlight markers for <mark>.
// Order matters: HTML is escaped FIRST, so the only markup in the string is
// the <mark> pair we introduce ourselves.
function paletteHl(s) {
  return esc(s || '').replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>');
}

function paletteSnippetPlain(s) {
  return (s || '').replace(/[\u0001\u0002]/g, '');
}

const PALETTE_ICONS = {
  file: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  skill: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
};

function renderPalette() {
  const container = document.getElementById('palette-results');
  if (!container || !paletteReply) return;
  const groups = paletteReply.groups || {};
  paletteFlat = [];
  let h = '';
  for (const key of PALETTE_GROUP_ORDER) {
    if (paletteScope !== 'all' && paletteScope !== key) continue;
    const items = groups[key] || [];
    if (!items.length) continue;
    const label = paletteReply.recent ? `Recent ${PALETTE_GROUP_LABELS[key].toLowerCase()}` : PALETTE_GROUP_LABELS[key];
    // A full group means the server hit its per-group cap: the real total may
    // be higher, so the count is shown as a floor rather than an exact figure.
    const countLabel = items.length >= PALETTE_GROUP_LIMIT ? `${PALETTE_GROUP_LIMIT}+` : items.length;
    h += `<div class="palette-group-label" role="presentation">${label}<span class="palette-group-count">${countLabel}</span></div>`;
    for (const item of items) {
      const idx = paletteFlat.length;
      paletteFlat.push(item);
      h += paletteItemHtml(item, idx);
    }
  }
  if (!paletteFlat.length) {
    const q = paletteQuery.trim();
    if (paletteReply.error) {
      // A genuine server failure must not masquerade as "no matches".
      h = `<div class="palette-empty">Search hit a problem<div class="palette-empty-sub">Try again; if it persists, check the server log.</div></div>`;
    } else {
      h = q
        ? `<div class="palette-empty">No matches for &ldquo;${esc(q)}&rdquo;<div class="palette-empty-sub">Search covers file contents and names, conversation messages and titles, and agent and skill names.</div></div>`
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
  return `<div class="palette-item" id="palette-item-${idx}" role="option" aria-selected="false" data-idx="${idx}" onclick="openPaletteResult(${idx})" onmousemove="hoverPaletteItem(${idx})">
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
  paletteSel = (paletteSel + delta + paletteFlat.length) % paletteFlat.length;
  updatePaletteSelection();
}

function openPaletteResult(idx) {
  const item = paletteFlat[idx];
  if (!item) return;
  closePalette();
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
      fragment: (item.snippet.match(/\u0001([^\u0002]+)\u0002/) || [])[1] || '',
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

function normAnchorText(t) {
  return (t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function tryMessageAnchor(convoId) {
  if (!pendingMessageAnchor || pendingMessageAnchor.convoId !== convoId) return;
  const anchor = pendingMessageAnchor;
  pendingMessageAnchor = null;
  // Let the DOM paint before measuring.
  setTimeout(() => {
    const bubbles = document.querySelectorAll('#messages .msg .msg-bubble');
    const needles = [normAnchorText(anchor.text), normAnchorText(anchor.fragment)].filter(n => n.length >= 3);
    let target = null;
    for (const needle of needles) {
      for (const b of bubbles) {
        if (normAnchorText(b.textContent).includes(needle)) { target = b.closest('.msg'); break; }
      }
      if (target) break;
    }
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
