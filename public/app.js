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
 * 13. SKILLS ........................ renderSkills, selectSkill, filterSkills
 * 14. SETTINGS ...................... showSettingsSection, renderSettingsSection
 * 15. WORKSPACE PICKER .............. handleWorkspaces, showWorkspacePicker
 * 16. EVENT LISTENERS & INIT ........ keydown, resize, connect()
 * ─────────────────────────────────────────────
 */

// ===== 1. CONSTANTS & STATE =====

const sunIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
const moonIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;

let ws=null, agents=[], conversations=[], activeConversation=null, currentView='home', currentFilePath=null, skills=[], skillsLoaded=false, currentWorkspacePath=null, workspaceAnalysis=null, workspaceIsEmpty=false, workspaceMode='knowledge', setupComplete=true;
const agentLastActivity = {}; // { agentId: { time: Date, label: string } }
// Per-conversation state: { convoId: { isProcessing, currentStreamingMsg, latestText } }
const convoState = {};
let pendingActiveProcesses = null; // Deferred until conversations are loaded
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
    case 'skills': skills=d.skills; skillsLoaded=true; renderSkills(); break;
    case 'conversations': handlePersistedConversations(d.conversations); break;
    case 'system':
      // Track active process per conversation to ignore stale events
      if(d.subtype==='process_started' && convoId && d._processId) {
        const state = getConvoState(convoId);
        console.log(`[Process] convo=${convoId} process_started pid=${d._processId} prev=${state.activeProcessId} agent=${d._agent||'?'}`);
        state.activeProcessId = d._processId;
        // Remove stale permission cards from the previous process
        document.querySelectorAll('.msg-permission').forEach(el => el.remove());
        // Auto-continue: orchestrator picking up after specialist return
        if(d.autoContinue) startProcessing(convoId);
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
        // Always reset streaming state on agent switch so the new agent gets a fresh bubble
        state.currentStreamingMsg = null;
        state.streamingRawText = '';
        state.latestText = '';
        state.latestAgentId = null;
        renderConvoList();
        // Determine if this is a return (back to orchestrator or back to parent)
        // vs a forward delegation (orchestrator->specialist or specialist->sub-specialist)
        const isReturn = toAgent?.type === 'orchestrator';
        if(activeConversation?.id === convoId) {
          const m = document.getElementById('messages');
          const divider = document.createElement('div');
          divider.className = 'msg-delegation';
          if(toAgent && fromAgent) {
            divider.innerHTML = `<div class="delegation-line"></div><div class="delegation-badge" style="color:${toAgent.colour}"><span class="avatar xs" style="background:${toAgent.colour}">${toAgent.icon}</span>${isReturn ? toAgent.displayName + ' resumed' : toAgent.displayName + ' joined'}</div><div class="delegation-line"></div>`;
          }
          m.appendChild(divider);
          scrollBottom();
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
    case 'search_results':
      handleSearchResults(d);
      break;
    case 'error': if(!d.content?.includes('no stdin')) addSystemMsgToConvo(d.content, convoId); break;
  }
}
function getConvoState(convoId) {
  if(!convoState[convoId]) convoState[convoId] = { isProcessing: false, currentStreamingMsg: null, latestText: '', streamingRawText: '', latestAgentId: null, activeProcessId: null };
  return convoState[convoId];
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

    if(isActive) {
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

    if(isActive) {
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
    // Code fences between markers are optional: model may output with or without them.
    const agentMarkerPattern = /<!-- RUNDOCK:(?:SAVE|CREATE)_AGENT name=([\w-]+) -->\n(?:```[^\n]*\n)?([\s\S]*?)(?:```\n)?<!-- \/RUNDOCK:(?:SAVE|CREATE)_AGENT -->/g;
    let match;
    while((match = agentMarkerPattern.exec(textToScan)) !== null) {
      ws.send(JSON.stringify({ type: 'save_agent', name: match[1], content: match[2].trim() }));
      filesCreated++;
      console.log('[Agent] Marker save:', match[1]);
    }

    // SAVE_SKILL markers (code fences optional)
    const skillMarkerPattern = /<!-- RUNDOCK:SAVE_SKILL name=([\w-]+) -->\n(?:```[^\n]*\n)?([\s\S]*?)(?:```\n)?<!-- \/RUNDOCK:SAVE_SKILL -->/g;
    while((match = skillMarkerPattern.exec(textToScan)) !== null) {
      ws.send(JSON.stringify({ type: 'save_skill', name: match[1], content: match[2].trim() }));
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
  responseText = responseText.replace(/<!-- RUNDOCK:RETURN -->/g, '').trim();
  responseText = responseText.replace(/<!-- RUNDOCK:(?:SAVE|CREATE)_AGENT name=[\w-]+ -->\n?(?:```[^\n]*\n)?[\s\S]*?(?:```\n)?<!-- \/RUNDOCK:(?:SAVE|CREATE)_AGENT -->/g, '').trim();
  responseText = responseText.replace(/<!-- RUNDOCK:SAVE_SKILL name=[\w-]+ -->\n?(?:```[^\n]*\n)?[\s\S]*?(?:```\n)?<!-- \/RUNDOCK:SAVE_SKILL -->/g, '').trim();
  responseText = responseText.replace(/<!-- RUNDOCK:DELETE_(?:SKILL|AGENT) name=[\w-]+ -->/g, '').trim();

  if(responseText && convo) {
    convo.messages.push({role:'agent', content: responseText, agentId});
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
  state.currentStreamingMsg=null; state.streamingRawText=''; state.latestText=''; state.latestAgentId=null;
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
  const existing=conversations.filter(c=>c.agentId===agentId);
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
  // Existing conversations
  if(existing.length) {
    h+=`<div class="profile-existing"><div class="profile-section-label">Existing conversations</div>`;
    for(const c of existing) {
      h+=`<div class="profile-existing-item" onclick="openConversation('${c.id}')"><span class="profile-existing-title">${esc(c.title)}</span><span class="profile-existing-meta">${c.messages.length} msg</span></div>`;
    }
    h+=`</div>`;
  }
  // Capabilities card
  if(a.capabilities) {
    const c = a.capabilities;
    h+=`<div class="profile-card">`;
    if(c.does) h+=`<div class="profile-card-section"><div class="profile-section-label">What ${a.displayName} does</div><div class="profile-card-text">${esc(c.does)}</div></div>`;
    if(c.reads) h+=`<div class="profile-card-section"><div class="profile-section-label">Reads from</div>${c.reads.split(',').map(r=>`<div class="profile-card-item">${r.trim()}</div>`).join('')}</div>`;
    if(c.writes) h+=`<div class="profile-card-section"><div class="profile-section-label">Writes to</div><div class="profile-card-text">${esc(c.writes)}</div></div>`;
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
function handlePersistedConversations(persisted) {
  if (!persisted || !Array.isArray(persisted)) return;
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
      status: entry.status || 'done',
      sessionId: entry.sessionId || null,
      sessionIds: entry.sessionIds || [],
      pinned: entry.pinned || false,
      pinnedAt: entry.pinnedAt || null,
      createdAt: entry.createdAt,
      lastActiveAt: entry.lastActiveAt,
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

  // Auto-navigate: processing > pinned > path detection > new conversation
  const processing = conversations.find(c => getConvoState(c.id).isProcessing);
  if (processing) {
    openConversation(processing.id);
    switchNav('conversations');
  } else {
    const pinned = conversations.filter(c => c.pinned && c.status !== 'done');
    if (pinned.length) {
      openConversation(pinned[0].id);
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
  statusEl.textContent=convo.status==='done'?'Done':'Active';
  statusEl.className=`chat-convo-status ${convo.status==='done'?'done-convo':'active-convo'}`;
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
    const pinned = conversations.filter(c => c.pinned && c.status !== 'done');
    if (pinned.length) { openConversation(pinned[0].id); } else { newConversation(); }
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'delete_conversation', id }));
  }
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
  activeConversation.status = activeConversation.status==='done'?'active':'done';
  const statusEl=document.getElementById('chat-convo-status');
  statusEl.textContent=activeConversation.status==='done'?'Done':'Active';
  statusEl.className=`chat-convo-status ${activeConversation.status==='done'?'done-convo':'active-convo'}`;
  persistConversation(activeConversation);
  renderConvoList();
}
function renderConvoList() {
  // When search is active, show flat filtered results
  if (convoSearchResults !== null) {
    renderSearchResults();
    return;
  }
  // Current session conversations + pinned persisted conversations
  const current = conversations.filter(c => c.status !== 'done' && (!c.persisted || c.pinned));
  // Sort: pinned first (most recently active), then unpinned in existing order
  current.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    if (a.pinned && b.pinned) {
      const aTime = a.lastActiveAt || a.pinnedAt || a.createdAt || '';
      const bTime = b.lastActiveAt || b.pinnedAt || b.createdAt || '';
      return bTime.localeCompare(aTime); // most recent first
    }
    return 0; // preserve existing order for unpinned
  });
  // Previous sessions (persisted from disk, not pinned)
  const previous = conversations.filter(c => c.persisted && !c.pinned && c.status !== 'done');
  const done = conversations.filter(c => c.status === 'done');
  let h = '';
  if (!current.length && !previous.length && !done.length) {
    h = `<div style="padding:12px 16px">
      <div style="color:var(--text-2);font-size:var(--caption);line-height:1.6">No conversations yet</div>
    </div>`;
  }
  if (current.length) {
    for (const c of current) {
      const lastMsg = c.messages.filter(m => m.role === 'agent').pop();
      const preview = lastMsg ? stripMd(lastMsg.content).substring(0, 60) + '...' : 'No messages yet';
      const cState = convoState[c.id];
      const activeId = cState?.activeAgentId;
      const displayAgent = (activeId && agents.find(a => a.id === activeId)) || c.agent;
      const working = workingConvos.has(c.id);
      const unread = !working && unreadConvos.has(c.id);
      const indicator = working ? '<span class="convo-working"></span>' : unread ? '<span class="convo-unread"></span>' : '';
      const pinIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="${c.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 11V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v7"/><path d="M5 17h14"/><path d="M7 11l-2 6h14l-2-6"/></svg>`;
      const pinIndicator = c.pinned ? `<svg class="convo-pin-indicator" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 11V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v7"/><path d="M5 17h14"/><path d="M7 11l-2 6h14l-2-6"/></svg>` : '';
      h += `<div class="convo-item ${activeConversation?.id === c.id ? 'active' : ''} ${c.pinned ? 'pinned-convo' : ''}" onclick="openConversation('${c.id}')">
        <button class="convo-pin" onclick="togglePin('${c.id}', event)" title="${c.pinned ? 'Unpin conversation' : 'Pin conversation'}">${pinIcon}</button>
        <div class="convo-title-row"><span class="convo-title">${esc(c.title)}</span>${pinIndicator}</div>
        <span class="convo-preview">${esc(preview)}</span>
        <div class="convo-meta"><div class="avatar xs" style="background:${displayAgent.colour}">${displayAgent.icon}</div><span>${displayAgent.displayName}</span>${indicator}</div>
      </div>`;
    }
  }
  if (previous.length) {
    const prevEl = document.getElementById('prev-convos');
    const prevOpen = prevEl ? !prevEl.classList.contains('hidden') : false;
    h += `<div style="padding:12px 8px 6px"><span class="sidebar-label" style="cursor:pointer" onclick="document.getElementById('prev-convos').classList.toggle('hidden')">Previous (${previous.length}) &#x25BE;</span></div>`;
    h += `<div id="prev-convos" class="${prevOpen ? '' : 'hidden'}">`;
    for (const c of previous) {
      const agentGone = !agents.find(a => a.id === c.agentId);
      const opacity = agentGone ? 'opacity:0.5' : 'opacity:0.8';
      const suffix = agentGone ? ' (agent removed)' : '';
      const pState = convoState[c.id];
      const pActiveId = pState?.activeAgentId;
      const pDisplayAgent = (pActiveId && agents.find(a => a.id === pActiveId)) || c.agent;
      const pWorking = workingConvos.has(c.id);
      const pUnread = !pWorking && unreadConvos.has(c.id);
      const pIndicator = pWorking ? '<span class="convo-working"></span>' : pUnread ? '<span class="convo-unread"></span>' : '';
      h += `<div class="convo-item ${activeConversation?.id === c.id ? 'active' : ''}" onclick="openConversation('${c.id}')" style="${opacity}">
        <button class="convo-delete" onclick="deleteConversation('${c.id}', event)" title="Delete conversation"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
        <span class="convo-title">${esc(c.title)}${suffix}</span>
        <div class="convo-meta"><div class="avatar xs" style="background:${pDisplayAgent.colour}">${pDisplayAgent.icon}</div><span>${pDisplayAgent.displayName}</span>${pIndicator}</div>
      </div>`;
    }
    h += `</div>`;
  }
  if (done.length) {
    const doneEl = document.getElementById('done-convos');
    const doneOpen = doneEl ? !doneEl.classList.contains('hidden') : false;
    h += `<div style="padding:12px 8px 6px"><span class="sidebar-label" style="cursor:pointer" onclick="document.getElementById('done-convos').classList.toggle('hidden')">Done (${done.length}) &#x25BE;</span></div>`;
    h += `<div id="done-convos" class="${doneOpen ? '' : 'hidden'}">`;
    for (const c of done) {
      const lastMsg = c.messages.filter(m => m.role === 'agent').pop();
      const preview = lastMsg ? stripMd(lastMsg.content).substring(0, 50) + '...' : '';
      const dState = convoState[c.id];
      const dActiveId = dState?.activeAgentId;
      const dDisplayAgent = (dActiveId && agents.find(a => a.id === dActiveId)) || c.agent;
      const dWorking = workingConvos.has(c.id);
      const dUnread = !dWorking && unreadConvos.has(c.id);
      const dIndicator = dWorking ? '<span class="convo-working"></span>' : dUnread ? '<span class="convo-unread"></span>' : '';
      h += `<div class="convo-item ${activeConversation?.id === c.id ? 'active' : ''}" onclick="openConversation('${c.id}')" style="opacity:0.7">
        <button class="convo-delete" onclick="deleteConversation('${c.id}', event)" title="Delete conversation"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
        <span class="convo-title">${esc(c.title)}</span>
        <span class="convo-preview">${esc(preview)}</span>
        <div class="convo-meta"><div class="avatar xs" style="background:${dDisplayAgent.colour}">${dDisplayAgent.icon}</div><span>${dDisplayAgent.displayName}</span>${dIndicator}</div>
      </div>`;
    }
    h += `</div>`;
  }
  document.getElementById('convo-list').innerHTML = h;
}

// ===== CONVERSATION SEARCH =====
let convoSearchQuery = '';
let convoSearchResults = null; // null = no search active, [] = search with no results
let convoSearchTimer = null;

function filterConversations(query) {
  const q = query.trim();
  const clearBtn = document.getElementById('convo-search-clear');
  if (clearBtn) clearBtn.classList.toggle('hidden', !q);

  if (!q) {
    convoSearchQuery = '';
    convoSearchResults = null;
    renderConvoList();
    return;
  }

  convoSearchQuery = q;

  // Phase 1: instant title filter (client-side)
  const lower = q.toLowerCase();
  const titleMatches = conversations.filter(c => (c.title || '').toLowerCase().includes(lower));
  convoSearchResults = titleMatches.map(c => ({ id: c.id, matchType: 'title' }));
  renderConvoList();

  // Phase 2: debounced content search (server-side, 300ms)
  clearTimeout(convoSearchTimer);
  if (q.length >= 3) {
    convoSearchTimer = setTimeout(() => {
      ws.send(JSON.stringify({ type: 'search_conversations', query: q }));
    }, 300);
  }
}

function clearConvoSearch() {
  const input = document.getElementById('convo-search');
  if (input) input.value = '';
  filterConversations('');
}

function handleSearchResults(d) {
  // Only apply if the query still matches what we searched for
  if (d.query?.toLowerCase().trim() !== convoSearchQuery.toLowerCase().trim()) return;
  // Merge server results with existing title matches
  const existingIds = new Set((convoSearchResults || []).map(r => r.id));
  const newResults = (d.results || []).filter(r => !existingIds.has(r.id));
  convoSearchResults = [...(convoSearchResults || []), ...newResults.map(r => ({ id: r.id, matchType: r.matchType, snippet: r.snippet }))];
  renderConvoList();
}

function renderSearchResults() {
  const matchIds = new Set(convoSearchResults.map(r => r.id));
  const snippetMap = new Map(convoSearchResults.filter(r => r.snippet).map(r => [r.id, r.snippet]));
  const matched = conversations.filter(c => matchIds.has(c.id));
  let h = '';
  if (!matched.length) {
    h = `<div style="padding:12px 16px">
      <div style="color:var(--text-2);font-size:var(--caption);line-height:1.6">No matches</div>
    </div>`;
  }
  for (const c of matched) {
    const snippet = snippetMap.get(c.id);
    const preview = snippet ? esc(snippet) : (c.messages?.length ? esc(stripMd(c.messages.filter(m => m.role === 'agent').pop()?.content || '').substring(0, 60)) : '');
    const displayAgent = c.agent || { colour: 'var(--text-2)', icon: '?', displayName: 'Unknown' };
    const opacity = c.persisted ? 'opacity:0.8;' : '';
    const sWorking = workingConvos.has(c.id);
    const sUnread = !sWorking && unreadConvos.has(c.id);
    const sIndicator = sWorking ? '<span class="convo-working"></span>' : sUnread ? '<span class="convo-unread"></span>' : '';
    h += `<div class="convo-item ${activeConversation?.id === c.id ? 'active' : ''}" onclick="openConversation('${c.id}')" style="${opacity}">
      <span class="convo-title">${esc(c.title)}</span>
      ${preview ? `<span class="convo-preview">${preview}</span>` : ''}
      <div class="convo-meta"><div class="avatar xs" style="background:${displayAgent.colour}">${displayAgent.icon}</div><span>${displayAgent.displayName}</span>${sIndicator}</div>
    </div>`;
  }
  document.getElementById('convo-list').innerHTML = h;
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

function openConversation(id) {
  if (activeConversation && activeConversation.id !== id) discardIfEmpty();
  const c=conversations.find(x=>x.id===id); if(!c) return;
  activeConversation=c;
  unreadConvos.delete(id);
  updateUnreadBadge();
  if(c.status==='done') { c.status='active'; }
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
      limit: 50
    }));
    // Clear persisted flag: this conversation is now active in current session
    c.persisted = false;
    c.status = 'active';
    persistConversation(c);
    renderConvoList();
  } else {
    const historyCount = c._historyCount || 0;
    for(let i=0; i<c.messages.length; i++) {
      const m = c.messages[i];
      if(m.role==='user') addUserMsg(m.content,false);
      else if(m.role==='agent') addAgentMsg(m.content,m.agentId,false);
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
  convo.messages.push({ role: 'user', content: text });
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

  // Restore thinking indicators for conversations that are still processing
  for (const proc of active) {
    const convo = conversations.find(c => c.id === proc.conversationId);
    const state = getConvoState(proc.conversationId);
    if (!state.isProcessing && convo) {
      state.activeProcessId = proc.processId;
      // Restore active agent and delegation state from server
      if (proc.agentId) {
        state.activeAgentId = proc.agentId;
        state.delegationActive = !!proc.delegation;
      }
      // Restore any response text accumulated on the server while we were disconnected
      if (proc.responseText) {
        state.streamingRawText = proc.responseText;
      }
      // startProcessing sets isProcessing, updates sidebar, org chart dots, and nav badge
      startProcessing(proc.conversationId);
    }
  }

  // Finish any conversations that the client thought were processing but the server has no process for
  for (const [convoId, state] of Object.entries(convoState)) {
    if (state.isProcessing && !activeConvoIds.has(convoId)) {
      // If we have accumulated response text, save it as a message before clearing
      const convo = conversations.find(c => c.id === convoId);
      if (state.streamingRawText && convo) {
        convo.messages.push({ role: 'agent', content: state.streamingRawText, agentId: convo.agentId });
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
function addAgentMsg(text,agentId,anim=true) {
  const a=agents.find(x=>x.id===agentId)||activeConversation?.agent||agents[0],m=document.getElementById('messages'),d=document.createElement('div');
  d.className='msg msg-agent'; if(!anim)d.style.animation='none';
  d.innerHTML=`<div class="msg-sender" style="color:${a?.colour||'var(--accent)'}"><div class="avatar xs" style="background:${a?.colour||'var(--accent)'}">${a?.icon||'?'}</div> ${a?.displayName||'Agent'}<span class="msg-time">${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span></div><div class="msg-bubble">${formatMd(text)}</div>`;
  m.appendChild(d); scrollBottom(); return d;
}
function addUserMsg(text,anim=true) { const m=document.getElementById('messages'),d=document.createElement('div'); d.className='msg msg-user'; if(!anim)d.style.animation='none'; d.innerHTML=`<div class="msg-bubble">${esc(text)}</div>`; m.appendChild(d); scrollBottom(true); }
function addSystemMsg(text) { const m=document.getElementById('messages'),d=document.createElement('div'); d.className='msg-system'; d.textContent=text; m.appendChild(d); scrollBottom(); }
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
        const divider = document.createElement('div');
        divider.className = 'msg-delegation history-msg';
        divider.style.animation = 'none';
        divider.innerHTML = `<div class="delegation-line"></div><div class="delegation-badge" style="color:${msgAgent?.colour||'var(--accent)'}"><span class="avatar xs" style="background:${msgAgent?.colour||'var(--accent)'}">${msgAgent?.icon||'?'}</span>${msgAgent?.displayName||'Agent'} joined</div><div class="delegation-line"></div>`;
        frag.appendChild(divider);
      }
      lastAgentId = msg.agentId || lastAgentId;
      div.className = 'msg msg-agent history-msg';
      div.innerHTML = `<div class="msg-sender" style="color:${msgAgent?.colour||'var(--accent)'}"><div class="avatar xs" style="background:${msgAgent?.colour||'var(--accent)'}">${msgAgent?.icon||'?'}</div> ${msgAgent?.displayName||'Agent'}</div><div class="msg-bubble">${formatMd(msg.content)}</div>`;
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

  // Store history messages in convo so they persist when navigating away and back
  const historyMsgs = d.messages.filter(m => !m.content || !m.content.includes('[WORKSPACE_ANALYSIS]')).map(m => ({
    role: m.role === 'user' ? 'user' : 'agent',
    content: m.content,
    agentId: m.agentId || convo.agentId,
    isHistory: true
  }));
  // Prepend to existing messages (load-more adds older messages before existing ones)
  convo.messages = [...historyMsgs, ...convo.messages];
  convo._historyCount = (convo._historyCount || 0) + historyMsgs.length;

  // Update activeAgentId to the last responding agent from history
  // This fixes sidebar/title showing wrong agent after restart
  const lastAssistantMsg = [...d.messages].reverse().find(m => m.role === 'assistant' && m.agentId);
  if (lastAssistantMsg) {
    const state = getConvoState(convo.id);
    state.activeAgentId = lastAssistantMsg.agentId;
    // Update header and sidebar to reflect the correct agent
    if (activeConversation?.id === convo.id) {
      const agent = agents.find(a => a.id === lastAssistantMsg.agentId) || convo.agent;
      document.getElementById('chat-agent-label').textContent = agent.displayName;
      document.getElementById('chat-agent-avatar').style.background = agent.colour;
      document.getElementById('chat-agent-avatar').textContent = agent.icon;
      document.getElementById('msg-input').placeholder = `Message ${agent.displayName}...`;
    }
    renderConvoList();
  }
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
    summary = `Use ${parts[1] || 'connector'}`;
    detail = parts[2] || '';
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
  document.querySelectorAll('.nav-item[data-nav]').forEach(n=>n.classList.remove('active'));
  document.querySelector(`[data-nav="${nav}"]`)?.classList.add('active');
  ['team','conversations','skills','files','settings'].forEach(s=>document.getElementById(`sidebar-${s}`).classList.add('hidden'));
  document.getElementById(`sidebar-${nav}`).classList.remove('hidden');
  // Clear search when navigating away
  if(nav !== 'conversations') clearConvoSearch();
  if(nav !== 'files') clearFileSearch();
  if(nav !== 'skills') clearSkillSearch();
  if(nav==='settings') { showView('settings'); showSettingsSection('workspace'); }
  else if(nav==='files') { editorReturnView = 'editor'; if(currentFilePath && document.querySelector('.file-item.active')) { showView('editor'); } else { currentFilePath = null; document.getElementById('editor-header').classList.add('hidden'); document.getElementById('editor-content').classList.add('hidden'); document.getElementById('editor-textarea').classList.add('hidden'); document.getElementById('editor-empty').classList.remove('hidden'); showView('editor'); } }
  else if(nav==='skills') { showView('skills'); if(!skillsLoaded) { ws.send(JSON.stringify({type:'get_skills'})); } else if(skills.length && !currentSkillId) { selectSkill(skills[0].id); } clearSkillSearch(); }
  else if(nav==='conversations') { if(activeConversation) { showView('chat'); if(unreadConvos.delete(activeConversation.id)) { updateUnreadBadge(); renderConvoList(); } } else { const pinned = conversations.filter(c => c.pinned && c.status !== 'done'); if(pinned.length) { openConversation(pinned[0].id); } else { newConversation(); } } }
  else if(nav==='team') { showView('home'); renderOrgChart(); }
}
function showView(v) { currentView=v; ['workspace','home','profile','chat','convo-empty','editor','skills','settings'].forEach(id=>{const e=document.getElementById(`view-${id}`);if(e){e.classList.add('hidden');e.style.display='none';e.classList.remove('main-view-transition');}}); const e=document.getElementById(`view-${v}`); if(e){e.classList.remove('hidden');e.style.display='flex';e.classList.add('main-view-transition');}  }
function goHome() { discardIfEmpty(); activeConversation=null; switchNav('conversations'); }

// Theme
function toggleTheme() { document.body.classList.toggle('light'); const isLight=document.body.classList.contains('light'); document.getElementById('theme-toggle').innerHTML=isLight?moonIcon:sunIcon; try{localStorage.setItem('rundock-theme',isLight?'light':'dark');}catch(e){} }
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

// ===== FILE SEARCH =====
let fileSearchQuery = '';

function filterFiles(query) {
  const q = query.trim();
  const clearBtn = document.getElementById('file-search-clear');
  if (clearBtn) clearBtn.classList.toggle('hidden', !q);
  fileSearchQuery = q;
  if (!cachedFileTree) return;
  if (!q) { renderFileTree(cachedFileTree); return; }
  const lower = q.toLowerCase();
  const matches = flattenTree(cachedFileTree).filter(f => f.name.toLowerCase().includes(lower));
  const container = document.getElementById('file-tree');
  container.innerHTML = '';
  if (!matches.length) {
    container.innerHTML = '<div style="padding:12px 16px;color:var(--text-2);font-size:var(--caption)">No matches</div>';
    return;
  }
  for (const item of matches) {
    const fi = document.createElement('div'); fi.className = 'file-item';
    const dir = item.path.includes('/') ? item.path.substring(0, item.path.lastIndexOf('/')) + '/' : '';
    fi.innerHTML = `<svg class="file-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><div><div>${esc(item.name)}</div>${dir ? `<div style="font-size:11px;color:var(--text-2);margin-top:1px">${esc(dir)}</div>` : ''}</div>`;
    fi.dataset.path = item.path;
    fi.onclick = () => { document.querySelectorAll('.file-item').forEach(x => x.classList.remove('active')); fi.classList.add('active'); editorReturnView = 'editor'; fileHistory = []; ws.send(JSON.stringify({ type: 'read_file', path: item.path })); showView('editor'); };
    container.appendChild(fi);
  }
}

function flattenTree(items, result) {
  result = result || [];
  for (const item of items) {
    if (item.type === 'folder') { flattenTree(item.children || [], result); }
    else { result.push(item); }
  }
  return result;
}

function clearFileSearch() {
  const input = document.getElementById('file-search');
  if (input) input.value = '';
  filterFiles('');
}

// Editor
let editorMode='preview', rawFileContent='', fileFrontmatter='', fileBody='';

function loadFileContent(path, content) {
  currentFilePath = path;
  rawFileContent = content;
  document.getElementById('editor-filename').textContent = path;
  document.getElementById('editor-status').textContent = '';
  document.getElementById('editor-header').classList.remove('hidden');
  document.getElementById('editor-empty').classList.add('hidden');
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
  document.getElementById('editor-header').classList.add('hidden');
  document.getElementById('editor-content').classList.add('hidden');
  document.getElementById('editor-textarea').classList.add('hidden');
  document.getElementById('editor-empty').classList.remove('hidden');
  document.querySelectorAll('.file-item').forEach(x => x.classList.remove('active'));
}

// ===== 12. MARKDOWN RENDERING =====

// Configure marked
marked.setOptions({ gfm: true, breaks: true });

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

  // Select first skill by default if none selected or current no longer exists
  if (!currentSkillId || !skills.find(s => s.id === currentSkillId)) {
    if (skills.length) selectSkill(skills[0].id);
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

function filterSkills(query) {
  const clearBtn = document.getElementById('skill-search-clear');
  const filtered = query
    ? skills.filter(s => s.name.toLowerCase().includes(query.toLowerCase()))
    : skills;
  clearBtn.classList.toggle('hidden', !query);
  renderSkillsSidebar(filtered);
}

function clearSkillSearch() {
  const input = document.getElementById('skill-search');
  if (!input) return;
  input.value = '';
  filterSkills('');
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

connect();
