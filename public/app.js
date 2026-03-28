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
 * 10. VIEWS & NAVIGATION ............ switchNav, showView, goHome, goBack, toggleTheme
 * 11. FILE TREE & EDITOR ............ renderFileTree, buildTree, loadFileContent
 * 12. MARKDOWN RENDERING ............ renderMarkdown, processCalloutsSrc
 * 13. SKILLS ........................ renderSkills, renderSkillRow, selectSkill
 * 14. SETTINGS ...................... showSettingsSection, renderSettingsSection
 * 15. WORKSPACE PICKER .............. handleWorkspaces, showWorkspacePicker
 * 16. EVENT LISTENERS & INIT ........ keydown, resize, connect()
 * ─────────────────────────────────────────────
 */

// ===== 1. CONSTANTS & STATE =====

const sunIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
const moonIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;

let ws=null, agents=[], conversations=[], activeConversation=null, currentView='home', currentFilePath=null, skills=[], skillsLoaded=false, currentWorkspacePath=null, workspaceAnalysis=null;
const agentLastActivity = {}; // { agentId: { time: Date, label: string } }
// Per-conversation state: { convoId: { isProcessing, currentStreamingMsg, latestText } }
const convoState = {};
let pendingActiveProcesses = null; // Deferred until conversations are loaded

// ===== 2. HELPERS =====

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
    case 'workspace_set': onWorkspaceReady(d.path, d.analysis); break;
    case 'workspace_error': {
      const errEl = document.getElementById('workspace-error');
      if (errEl) { errEl.textContent = d.message; errEl.style.display = 'block'; }
      break;
    }
    case 'needs_workspace': showView('workspace'); break;
    case 'agents': agents=d.agents; renderAgentList(); renderOrgChart(); renderRoutinesSidebar(); renderConvoList(); break;
    case 'skills': skills=d.skills; skillsLoaded=true; renderSkills(); break;
    case 'conversations': handlePersistedConversations(d.conversations); break;
    case 'system':
      // Track active process per conversation to ignore stale events
      if(d.subtype==='process_started' && convoId && d._processId) {
        const state = getConvoState(convoId);
        state.activeProcessId = d._processId;
        // Remove stale permission cards from the previous process
        document.querySelectorAll('.msg-permission').forEach(el => el.remove());
      }
      // Capture session ID from init message and persist for resume after refresh
      if(d.subtype==='init' && d._sessionId && convoId) {
        const convo = conversations.find(c => c.id === convoId);
        if(convo && !convo.sessionId) {
          convo.sessionId = d._sessionId;
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
      // Only finish if this done event is from the currently active process
      if(d.subtype==='done' && convoId) {
        const state = getConvoState(convoId);
        if(!d._processId || !state.activeProcessId || d._processId === state.activeProcessId) {
          finishProcessing(convoId);
        }
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
      addSystemMsg('Agent "' + (d.agentId || '') + '" created');
      break;
    case 'agent_error':
      addSystemMsg(d.message || 'Agent operation failed');
      break;
    case 'agent_deleted':
      addSystemMsg('Agent "' + (d.agentId || '') + '" removed');
      break;
    case 'active_processes':
      // Defer until workspace is ready and conversations are loaded
      pendingActiveProcesses = d.processes || [];
      break;
    case 'control_request':
      if(convoId) handlePermissionRequest(d, convoId);
      break;
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
    case 'error': if(!d.content?.includes('no stdin')) addSystemMsgToConvo(d.content, convoId); break;
  }
}
function getConvoState(convoId) {
  if(!convoState[convoId]) convoState[convoId] = { isProcessing: false, currentStreamingMsg: null, latestText: '', latestAgentId: null, activeProcessId: null };
  return convoState[convoId];
}
function isStaleProcess(d, convoId) {
  if(!d._processId) return false;
  const state = getConvoState(convoId);
  return state.activeProcessId && d._processId !== state.activeProcessId;
}

function handleStreamEvent(d, convoId) {
  const evt = d.event; if(!evt) return;
  const state = getConvoState(convoId);
  const isActive = activeConversation?.id === convoId;
  if(!isActive) return;

  // Text streaming: render deltas in real-time
  if(evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
    const text = evt.delta.text;

    // Create streaming message bubble if it doesn't exist yet
    if(!state.currentStreamingMsg) {
      // Remove thinking indicator, replace with streaming bubble
      const t = document.getElementById('thinking-indicator'); if(t) t.remove();
      const agentId = d._agent || state.latestAgentId;
      const a = agents.find(x => x.id === agentId) || activeConversation?.agent || agents[0];
      const m = document.getElementById('messages'), el = document.createElement('div');
      el.className = 'msg msg-agent';
      el.innerHTML = `<div class="msg-sender" style="color:${a?.colour||'var(--accent)'}"><div class="avatar xs" style="background:${a?.colour||'var(--accent)'}">${a?.icon||'?'}</div> ${a?.displayName||'Agent'}<span class="msg-time">${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span></div><div class="msg-bubble"><span class="streaming-text"></span></div>`;
      m.appendChild(el);
      state.currentStreamingMsg = el;
      state.streamingRawText = '';
    }

    state.streamingRawText += text;
    const streamEl = state.currentStreamingMsg.querySelector('.streaming-text');
    if(streamEl) streamEl.innerHTML = formatMd(state.streamingRawText);
    scrollBottom();
  }

  // Tool use: show thinking indicator with tool name (even if streaming already started)
  if(evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
    const toolName = evt.content_block.name || '';
    let status = document.getElementById('thinking-status');
    if(!status) {
      // Thinking indicator was removed when streaming started; re-add it below the streaming message
      const agentId = d._agent || state.latestAgentId;
      const a = agents.find(x => x.id === agentId) || activeConversation?.agent || agents[0];
      const m = document.getElementById('messages'), el = document.createElement('div');
      el.className = 'msg msg-agent'; el.id = 'thinking-indicator';
      el.innerHTML = `<div class="msg-sender" style="color:${a?.colour||'var(--accent)'}"><div class="avatar xs" style="background:${a?.colour||'var(--accent)'}">${a?.icon||'?'}</div> ${a?.displayName||'Agent'}</div><div class="msg-bubble thinking-bubble"><div class="thinking-pulse" style="background:${a?.colour||'var(--accent)'}"></div><div><div class="thinking-label">Thinking</div><div class="thinking-status" id="thinking-status"></div></div></div>`;
      m.appendChild(el);
      scrollBottom();
      status = el.querySelector('#thinking-status');
    }
    if(status) status.textContent = formatToolName(toolName);
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
  const agentId = d._agent || state.latestAgentId;

  try {
  // Detect agent definitions in the response and route to server for creation.
  // Primary: RUNDOCK:CREATE_AGENT markers. Fallback: raw YAML frontmatter blocks.
  const textToScan = d.result || state.streamingRawText || state.latestText || '';
  if(textToScan && ws) {
    let agentsCreated = 0;

    // Primary: explicit markers
    const markerPattern = /<!-- RUNDOCK:CREATE_AGENT name=([\w-]+) -->\n```[^\n]*\n([\s\S]*?)```\n<!-- \/RUNDOCK:CREATE_AGENT -->/g;
    let match;
    while((match = markerPattern.exec(textToScan)) !== null) {
      ws.send(JSON.stringify({ type: 'create_agent', name: match[1], content: match[2].trim() }));
      agentsCreated++;
    }

    // Fallback: detect raw YAML frontmatter blocks with agent fields (name + type)
    // This handles cases where the LLM outputs agent files without the marker wrapper
    if(agentsCreated === 0) {
      const fmPattern = /```[^\n]*\n(---\n[\s\S]*?\n---[\s\S]*?)```/g;
      let fmMatch;
      while((fmMatch = fmPattern.exec(textToScan)) !== null) {
        const block = fmMatch[1].trim();
        const nameMatch = block.match(/^name:\s*(.+)$/m);
        const typeMatch = block.match(/^type:\s*(orchestrator|specialist)$/m);
        if(nameMatch && typeMatch) {
          const slug = nameMatch[1].trim();
          ws.send(JSON.stringify({ type: 'create_agent', name: slug, content: block }));
          agentsCreated++;
          console.log('[Agent] Fallback extraction:', slug);
        }
      }
      // Also try without code fences (raw frontmatter separated by ---)
      if(agentsCreated === 0) {
        const rawBlocks = textToScan.split(/\n(?=---\nname:\s)/).filter(b => b.trim().startsWith('---'));
        for(const block of rawBlocks) {
          const nameMatch = block.match(/^name:\s*(.+)$/m);
          const typeMatch = block.match(/^type:\s*(orchestrator|specialist)$/m);
          if(nameMatch && typeMatch) {
            const slug = nameMatch[1].trim();
            // Extract just the frontmatter + body (stop at the next --- block or end)
            const content = block.trim();
            ws.send(JSON.stringify({ type: 'create_agent', name: slug, content }));
            agentsCreated++;
            console.log('[Agent] Raw frontmatter extraction:', slug);
          }
        }
      }
    }

    if(agentsCreated > 0) {
      console.log('[Agent] Created', agentsCreated, 'agents');
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
  const responseText = d.result || state.streamingRawText || state.latestText || '';

  if(responseText && convo) {
    convo.messages.push({role:'agent', content: responseText, agentId});
  }

  if(isActive) {
    const t=document.getElementById('thinking-indicator'); if(t) t.remove();
    if(state.currentStreamingMsg) {
      // Text was already streamed in real-time. Do a final re-render with complete markdown.
      const streamEl = state.currentStreamingMsg.querySelector('.streaming-text');
      if(streamEl && responseText) streamEl.innerHTML = formatMd(responseText);
    } else if(responseText) {
      // No streaming happened (e.g. very short response). Render now.
      addAgentMsg(responseText, agentId);
    }
  }

  } catch(err) {
    console.error('[handleResult] Error:', err);
  }
  state.currentStreamingMsg=null; state.streamingRawText=''; state.latestText=''; state.latestAgentId=null;
  finishProcessing(convoId);
  renderConvoList();
}

function addSystemMsgToConvo(text, convoId, isError = true) {
  if(!convoId || activeConversation?.id === convoId) addSystemMsg((isError ? 'Error: ' : '') + text);
}

// ===== 5. AGENT LIST & SIDEBAR =====

function renderAgentList() {
  const onTeam = getTeamAgents();
  const platform = getPlatformAgents();
  const available = agents.filter(a => a.status === 'available' || a.status === 'raw');

  let h = '';
  // On team agents (or empty state)
  if (onTeam.length) {
    for (const a of onTeam) {
      const last = agentLastActivity[a.id];
      const statusText = last ? formatTimeAgo(last.time) : 'idle';
      h += `<div class="agent-status-item" onclick="showProfile('${a.id}')" data-agent="${a.id}">
        <div class="avatar sm" style="background:${a.colour}">${a.icon}</div>
        <span class="agent-status-name">${a.displayName}</span>
        <span class="agent-status-state" data-status="${a.id}">${statusText}</span>
      </div>`;
    }
  } else if (platform.length) {
    const guide = platform[0];
    h += `<div class="sidebar-empty-state">
      <div class="sidebar-empty-text">No team agents yet. Doc can explore this workspace and create a team for you.</div>
      <button class="empty-cta" style="width:100%" onclick="startConversation('${guide.id}')">Talk to Doc</button>
    </div>`;
  }
  // Platform agents
  if (platform.length) {
    h += `<div class="sidebar-section-divider"><span class="sidebar-label">Rundock Agents</span></div>`;
    for (const a of platform) {
      const last = agentLastActivity[a.id];
      const statusText = last ? formatTimeAgo(last.time) : 'idle';
      h += `<div class="agent-status-item" onclick="showProfile('${a.id}')" data-agent="${a.id}">
        <div class="avatar sm" style="background:${a.colour}">${a.icon}</div>
        <span class="agent-status-name">${a.displayName}</span>
        <span class="agent-status-state" data-status="${a.id}">${statusText}</span>
      </div>`;
    }
  }
  // Available agents
  if (available.length) {
    h += `<div class="sidebar-section-divider" style="cursor:pointer" onclick="document.getElementById('available-agents').classList.toggle('hidden')"><span class="sidebar-label">Available (${available.length}) &#x25BE;</span></div>`;
    h += `<div id="available-agents" class="hidden" style="padding:4px 0">`;
    for (const a of available) {
      const isRaw = a.status === 'raw';
      h += `<div class="agent-status-item" style="${isRaw ? 'opacity:0.6' : ''}">
        <div class="avatar sm" style="background:${a.colour}">${a.icon}</div>
        <div style="flex:1;min-width:0">
          <span class="agent-status-name">${a.displayName}</span>
          <span class="agent-status-desc">${a.description ? a.description.substring(0, 50) : (isRaw ? 'Needs setup' : 'Ready to place')}</span>
        </div>
        ${isRaw
          ? `<button class="agent-action-btn onboard" onclick="event.stopPropagation(); startConversation(getGuide()?.id || 'default')">Onboard</button>`
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
      ? `<div class="sidebar-empty-text" style="text-align:center;max-width:280px;margin:0 auto 8px">Doc can explore this workspace and set up your agent team.</div><button class="empty-cta" style="margin-top:4px" onclick="startConversation('${guide.id}')">Talk to Doc to get started</button>`
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

function renderOrgChart() {
  const orchestrator = agents.find(a => a.status === 'onTeam' && a.type === 'orchestrator');
  const specialists = agents.filter(a => a.status === 'onTeam' && a.type === 'specialist');
  const platformAgents = getPlatformAgents();
  // Fallback for agents without type field (backward compat)
  const untyped = agents.filter(a => a.status === 'onTeam' && !a.type);
  // Only consider non-platform, Rundock-configured agents for the org tree.
  // The synthetic default agent (from CLAUDE.md, no type field) doesn't count as a team.
  const leader = orchestrator || agents.find(a => a.isDefault && a.type) || null;
  const team = specialists.length ? specialists : untyped.filter(a => a !== leader);
  const hasTeam = leader || team.length;

  let h = '<div class="org-tree">';

  if (hasTeam) {
    // Orchestrator
    if (leader) {
      h += `<div class="org-leader"><div class="org-card" onclick="showProfile('${leader.id}')"><div class="avatar" style="background:${leader.colour}">${leader.icon}</div><div><div class="org-card-name">${leader.displayName}</div><div class="org-card-role">${leader.role || ''}</div></div></div></div>`;
    }

    // Specialists
    if (team.length) {
      const midIndex = Math.floor(team.length / 2);
      const hasTrunkBranch = team.length % 2 === 1;
      h += `<div class="org-trunk${hasTrunkBranch ? ' trunk-hidden' : ''}"></div><div class="org-branches">`;
      team.forEach((a, i) => {
        const isTrunk = hasTrunkBranch && (i === midIndex);
        h += `<div class="org-branch${isTrunk ? ' trunk-branch' : ''}"><div class="org-branch-stem"></div><div class="org-card" onclick="showProfile('${a.id}')"><div class="avatar" style="background:${a.colour}">${a.icon}</div><div><div class="org-card-name">${a.displayName}</div><div class="org-card-role">${a.role || ''}</div></div></div></div>`;
      });
      h += '</div>';
    }
  } else {
    const guide = platformAgents[0];
    const a = workspaceAnalysis;
    const hasContext = a && (a.identity.sources.length > 0 || a.skills.total > 0);

    if (hasContext && a) {
      // Path B: Has context, no team. Show analysis card.
      h += '<div class="org-empty-state">';
      // Identity card
      const name = a.identity.suggestedName || 'Your Workspace';
      const tagline = a.identity.suggestedTagline || a.identity.suggestedRole || '';
      h += `<div class="empty-title">${esc(name)}${tagline ? ': ' + esc(tagline) : ''}</div>`;
      // Stats line
      const stats = [];
      if (a.skills.total > 0) stats.push(`${a.skills.total} skills`);
      if (a.structure.pattern !== 'unknown') {
        const acronyms = new Set(['para']);
        const patternLabel = a.structure.pattern.split('-').map(w => acronyms.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        stats.push(patternLabel + ' structure');
      }
      const integrationCount = a.integrations.mcpReferences.length + a.integrations.configuredServers.length + a.integrations.mentionedTools.length;
      if (integrationCount > 0) stats.push(`${integrationCount} integrations`);
      if (stats.length) h += `<div style="color:var(--text-2);font-size:var(--caption);margin-bottom:16px">${stats.join(' &middot; ')}</div>`;
      // Action card
      h += '<div style="color:var(--text-2);font-size:var(--body);max-width:320px;text-align:center;line-height:1.6">Doc can create your agent team based on what\'s here. Skills will be automatically grouped and assigned.</div>';
      if (guide) {
        h += `<button class="empty-cta" style="margin-top:12px" onclick="startSetupConversation()">Set up your team</button>`;
      }
      h += '</div>';
    } else {
      // Path C: Empty or raw workspace.
      h += '<div class="org-empty-state">';
      h += '<div class="empty-title">Welcome to Rundock</div>';
      h += '<div class="sidebar-empty-text" style="text-align:center;max-width:320px">Fresh workspace. Doc can help you set up your agent team from scratch.</div>';
      if (guide) {
        h += `<button class="empty-cta" style="margin-top:4px" onclick="startConversation('${guide.id}')">Talk to Doc to get started</button>`;
      }
      h += '</div>';
    }
  }

  // Platform section (inside .org-tree so it scales together)
  if (platformAgents.length) {
    h += `<div class="org-platform-section" style="margin-top:${hasTeam ? '56' : '32'}px">`;
    h += '<div class="org-platform-divider"></div>';
    h += '<div class="org-platform-label">Rundock Agents</div>';
    h += '<div style="display:flex;justify-content:center;gap:12px">';
    for (const a of platformAgents) {
      h += `<div class="org-card org-card-sm" onclick="showProfile('${a.id}')"><div class="avatar" style="background:${a.colour}">${a.icon}</div><div><div class="org-card-name">${a.displayName}</div><div class="org-card-role">${a.role || ''}</div></div></div>`;
    }
    h += '</div></div>';
  }

  h += '</div>'; // close .org-tree

  document.getElementById('org-chart').innerHTML = h;
  requestAnimationFrame(scaleOrgTree);
}

function scaleOrgTree() {
  const chart = document.getElementById('org-chart');
  const tree = chart?.querySelector('.org-tree');
  if (!tree) return;
  tree.style.transform = 'none';
  const chartW = chart.clientWidth - 96; // padding + breathing room
  const treeW = tree.scrollWidth;
  if (treeW > chartW && chartW > 0) {
    const s = Math.max(0.55, chartW / treeW);
    tree.style.transform = `scale(${s})`;
  }
}
window.addEventListener('resize', scaleOrgTree);

// ===== 7. AGENT PROFILE =====

function showProfile(agentId) {
  const a=agents.find(x=>x.id===agentId); if(!a) return;
  const existing=conversations.filter(c=>c.agentId===agentId);
  let h=`<a class="profile-back" onclick="goHome()">&#8592; Team</a>
    <div class="profile-header">
      <div class="profile-avatar" style="background:${a.colour}">${a.icon}</div>
      <div>
        <div class="profile-name">${a.displayName}</div>
        ${a.role?`<div style="font-size:var(--body);color:var(--text-2)">${a.role}</div>`:''}
      </div>
    </div>`;
  if(a.description) h+=`<p class="profile-desc" style="margin-bottom:24px">${esc(a.description)}</p>`;
  h+=`<div class="profile-cta"><button class="profile-cta-btn" onclick="startConversation('${a.id}')">New conversation</button></div>`;
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
  ws.send(JSON.stringify({
    type: 'save_conversation',
    conversation: {
      id: convo.id,
      agentId: convo.agentId,
      sessionId: convo.sessionId || null,
      title: convo.title,
      status: convo.status,
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
    conversations.push({
      id: entry.id,
      agentId: entry.agentId,
      agent: agent || { id: entry.agentId, displayName: entry.agentId, colour: 'var(--text-3)', icon: '?', prompts: [] },
      title: entry.title || 'Untitled',
      messages: [],  // No message content persisted; resume via sessionId
      status: entry.status || 'done',
      sessionId: entry.sessionId || null,
      createdAt: entry.createdAt,
      lastActiveAt: entry.lastActiveAt,
      persisted: true  // Flag: this was loaded from disk, has no in-memory messages
    });
  }
  renderConvoList();

  // Now that conversations are loaded, reconcile any active processes from a reconnect.
  // Always run this, even if active_processes was empty or never received, to clean stale state.
  handleActiveProcesses(pendingActiveProcesses || []);
  pendingActiveProcesses = null;

  // Auto-navigate to the conversation that's still processing
  const processing = conversations.find(c => getConvoState(c.id).isProcessing);
  if (processing) {
    openConversation(processing.id);
    switchNav('conversations');
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
  // Show prompt pills if agent has prompts
  if(agent.prompts && agent.prompts.length) {
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

// Path B: Start a Doc conversation with workspace analysis pre-loaded
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
  block += '[/WORKSPACE_ANALYSIS]\n\n';
  block += 'Propose an agent team for this workspace. Do NOT create agents yet. Show me the team plan first, then I will confirm.';

  // Start conversation with custom title
  const convo = createConversation(guide.id, `${a.identity.suggestedName || 'Workspace'} Team Setup`);

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
  if (orchestrator) { startConversation(orchestrator.id); return; }
  // Team agents, no orchestrator: show agent picker
  showView('convo-empty');
}
function setupChat(convo) {
  const agent = convo.agent;
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
  const state = getConvoState(convo.id);
  msgInput.disabled = state.isProcessing;
  document.getElementById('send-btn').disabled = state.isProcessing;
  if(!state.isProcessing) msgInput.focus();
}
function renameConversation(newTitle) {
  if(activeConversation && newTitle.trim()) {
    activeConversation.title=newTitle.trim();
    persistConversation(activeConversation);
    renderConvoList();
  }
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
  // Current session conversations (have in-memory messages)
  const current = conversations.filter(c => c.status !== 'done' && !c.persisted);
  // Previous sessions (persisted from disk, no in-memory messages)
  const previous = conversations.filter(c => c.persisted && c.status !== 'done');
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
      h += `<div class="convo-item ${activeConversation?.id === c.id ? 'active' : ''}" onclick="openConversation('${c.id}')">
        <span class="convo-title">${esc(c.title)}</span>
        <span class="convo-preview">${esc(preview)}</span>
        <div class="convo-meta"><div class="avatar xs" style="background:${c.agent.colour}">${c.agent.icon}</div><span>${c.agent.displayName}</span></div>
      </div>`;
    }
  }
  if (previous.length) {
    h += `<div style="padding:12px 8px 6px"><span class="sidebar-label" style="cursor:pointer" onclick="document.getElementById('prev-convos').classList.toggle('hidden')">Previous (${previous.length}) &#x25BE;</span></div>`;
    h += `<div id="prev-convos" class="hidden">`;
    for (const c of previous) {
      const agentGone = !agents.find(a => a.id === c.agentId);
      const opacity = agentGone ? 'opacity:0.5' : 'opacity:0.8';
      const suffix = agentGone ? ' (agent removed)' : '';
      h += `<div class="convo-item ${activeConversation?.id === c.id ? 'active' : ''}" onclick="openConversation('${c.id}')" style="${opacity}">
        <span class="convo-title">${esc(c.title)}${suffix}</span>
        <div class="convo-meta"><div class="avatar xs" style="background:${c.agent.colour}">${c.agent.icon}</div><span>${c.agent.displayName}</span></div>
      </div>`;
    }
    h += `</div>`;
  }
  if (done.length) {
    h += `<div style="padding:12px 8px 6px"><span class="sidebar-label" style="cursor:pointer" onclick="document.getElementById('done-convos').classList.toggle('hidden')">Done (${done.length}) &#x25BE;</span></div>`;
    h += `<div id="done-convos" class="hidden">`;
    for (const c of done) {
      const lastMsg = c.messages.filter(m => m.role === 'agent').pop();
      const preview = lastMsg ? stripMd(lastMsg.content).substring(0, 50) + '...' : '';
      h += `<div class="convo-item ${activeConversation?.id === c.id ? 'active' : ''}" onclick="openConversation('${c.id}')" style="opacity:0.7">
        <span class="convo-title">${esc(c.title)}</span>
        <span class="convo-preview">${esc(preview)}</span>
        <div class="convo-meta"><div class="avatar xs" style="background:${c.agent.colour}">${c.agent.icon}</div><span>${c.agent.displayName}</span></div>
      </div>`;
    }
    h += `</div>`;
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
  if(c.status==='done') { c.status='active'; }
  setupChat(c);
  const el=document.getElementById('messages'); el.innerHTML='';
  if(c.persisted && c.messages.length===0 && c.sessionId) {
    // Persisted conversation from a previous session: load history from JSONL transcript
    el.innerHTML=`<div id="history-loading" style="text-align:center;padding:24px 0;color:var(--text-3);font-size:var(--caption)">Loading conversation history...</div>`;
    ws.send(JSON.stringify({
      type: 'get_session_history',
      sessionId: c.sessionId,
      conversationId: c.id,
      limit: 20
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
    document.getElementById('chat-status').textContent='· working...'; document.getElementById('chat-status').classList.add('working');
    document.getElementById('send-btn').disabled=true; document.getElementById('msg-input').disabled=true;
    const a=c.agent;
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
  showView('chat'); scrollBottom(); renderConvoList();
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
  const chatMsg = { type: 'chat', content: text, agent: convo.agentId, conversationId: convo.id };
  if (convo.sessionId) chatMsg.sessionId = convo.sessionId;
  ws.send(JSON.stringify(chatMsg));
  persistConversation(convo);
}

function sendMessage() {
  const input=document.getElementById('msg-input'),text=input.value.trim();
  if(!activeConversation||!ws) return;
  const state = getConvoState(activeConversation.id);
  if(!text||state.isProcessing) return;
  const promptsEl=document.getElementById('chat-prompts'); if(promptsEl) promptsEl.remove();
  if(activeConversation.messages.filter(m=>m.role==='user').length===0) { activeConversation.title=text.substring(0,50)+(text.length>50?'...':''); document.getElementById('chat-title-input').value=activeConversation.title; renderConvoList(); }
  input.value=''; input.style.height='44px'; document.getElementById('send-btn').classList.remove('active');
  dispatchMessage(activeConversation, text);
}
function startProcessing(convoId) {
  const state = getConvoState(convoId);
  state.isProcessing=true; state.latestText=''; state.latestAgentId=null;
  const isActive = activeConversation?.id === convoId;
  const convo = conversations.find(c=>c.id===convoId);
  if(isActive) {
    document.getElementById('chat-status').textContent='· working...'; document.getElementById('chat-status').classList.add('working');
    document.getElementById('send-btn').disabled=true;
    document.getElementById('msg-input').disabled=true;
    const a=convo?.agent||agents[0];
    const m=document.getElementById('messages'),d=document.createElement('div'); d.className='msg msg-agent'; d.id='thinking-indicator';
    d.innerHTML=`<div class="msg-sender" style="color:${a?.colour||'var(--accent)'}"><div class="avatar xs" style="background:${a?.colour||'var(--accent)'}">${a?.icon||'?'}</div> ${a?.displayName||'Agent'}</div><div class="msg-bubble thinking-bubble"><div class="thinking-pulse" style="background:${a?.colour||'var(--accent)'}"></div><div><div class="thinking-label">Thinking</div><div class="thinking-status" id="thinking-status"></div></div></div>`;
    m.appendChild(d); scrollBottom();
  }
  if(convo) { const s=document.querySelector(`[data-status="${convo.agentId}"]`); if(s){s.textContent='working';s.classList.add('working');} }
}
function finishProcessing(convoId) {
  const state = getConvoState(convoId);
  state.isProcessing=false; state.currentStreamingMsg=null;
  const isActive = activeConversation?.id === convoId;
  const convo = conversations.find(c=>c.id===convoId);

  if(isActive) {
    const tt=document.getElementById('thinking-indicator'); if(tt) tt.remove();
    document.getElementById('chat-status').textContent=''; document.getElementById('chat-status').classList.remove('working');
    document.getElementById('send-btn').disabled=false;
    document.getElementById('msg-input').disabled=false;
    document.getElementById('msg-input').focus();
  }
  if(convo) {
    agentLastActivity[convo.agentId] = { time: new Date(), label: convo.title };
    const s=document.querySelector(`[data-status="${convo.agentId}"]`);
    if(s){s.textContent=formatTimeAgo(new Date());s.classList.remove('working');}
  }
  // Refresh file tree after a short delay to let file writes flush to disk
  setTimeout(() => {
    if(ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'get_files' }));
    }
  }, 500);
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
      state.isProcessing = true;
      // Restore any response text accumulated on the server while we were disconnected
      if (proc.responseText) {
        state.streamingRawText = proc.responseText;
      }
      // If this conversation is already visible, show the thinking indicator immediately.
      // Otherwise, openConversation will pick up state.isProcessing when the user navigates to it.
      if (activeConversation?.id === proc.conversationId) {
        startProcessing(proc.conversationId);
      }
      console.log(`[Reconnect] Restored processing for convo=${proc.conversationId}`);
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
function addUserMsg(text,anim=true) { const m=document.getElementById('messages'),d=document.createElement('div'); d.className='msg msg-user'; if(!anim)d.style.animation='none'; d.innerHTML=`<div class="msg-bubble">${esc(text)}</div>`; m.appendChild(d); scrollBottom(); }
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
      ws.send(JSON.stringify({
        type: 'get_session_history',
        sessionId: convo.sessionId,
        conversationId: convo.id,
        limit: 20,
        offset: currentOffset
      }));
    };
    frag.appendChild(loadMore);
  }

  // Render each historical message
  const agent = convo.agent;
  for (const msg of d.messages) {
    const div = document.createElement('div');
    div.style.animation = 'none';
    if (msg.role === 'user') {
      div.className = 'msg msg-user history-msg';
      div.innerHTML = `<div class="msg-bubble">${esc(msg.content)}</div>`;
    } else {
      div.className = 'msg msg-agent history-msg';
      div.innerHTML = `<div class="msg-sender" style="color:${agent?.colour||'var(--accent)'}"><div class="avatar xs" style="background:${agent?.colour||'var(--accent)'}">${agent?.icon||'?'}</div> ${agent?.displayName||'Agent'}</div><div class="msg-bubble">${formatMd(msg.content)}</div>`;
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
  const historyMsgs = d.messages.map(m => ({
    role: m.role === 'user' ? 'user' : 'agent',
    content: m.content,
    agentId: convo.agentId,
    isHistory: true
  }));
  // Prepend to existing messages (load-more adds older messages before existing ones)
  convo.messages = [...historyMsgs, ...convo.messages];
  convo._historyCount = (convo._historyCount || 0) + historyMsgs.length;
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
    summary = BASH_DESCRIPTIONS[bin] || `Run ${bin}`;
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
      <code class="permission-detail">${esc(detail)}</code>
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
      <span>${label}</span> ${esc(summary)}${detail ? ': ' + esc(detail) : ''}
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
function scrollBottom() { const m=document.getElementById('messages'); if(m) m.scrollTop=m.scrollHeight; }

// ===== 10. VIEWS & NAVIGATION =====

function switchNav(nav) {
  document.querySelectorAll('.nav-item[data-nav]').forEach(n=>n.classList.remove('active'));
  document.querySelector(`[data-nav="${nav}"]`)?.classList.add('active');
  ['team','conversations','skills','files','settings'].forEach(s=>document.getElementById(`sidebar-${s}`).classList.add('hidden'));
  document.getElementById(`sidebar-${nav}`).classList.remove('hidden');
  if(nav==='settings') { showView('settings'); showSettingsSection('workspace'); }
  else if(nav==='files') showView('editor');
  else if(nav==='skills') { showView('skills'); if(!skillsLoaded) { ws.send(JSON.stringify({type:'get_skills'})); } document.querySelectorAll('.skill-sidebar-item').forEach(el=>el.classList.remove('active')); document.querySelectorAll('.skill-row.expanded').forEach(r=>r.classList.remove('expanded')); }
  else if(nav==='conversations') { if(activeConversation) showView('chat'); else newConversation(); }
  else showView('home');
}
function showView(v) { currentView=v; ['workspace','home','profile','chat','convo-empty','editor','skills','settings'].forEach(id=>{const e=document.getElementById(`view-${id}`);if(e){e.classList.add('hidden');e.style.display='none';e.classList.remove('main-view-transition');}}); const e=document.getElementById(`view-${v}`); if(e){e.classList.remove('hidden');e.style.display='flex';e.classList.add('main-view-transition');}  }
function goHome() { discardIfEmpty(); activeConversation=null; showView('home'); switchNav('team'); document.querySelectorAll('.agent-status-item').forEach(el=>el.classList.remove('active')); }
function goBack() { if(activeConversation) showProfile(activeConversation.agentId); else goHome(); }

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
      fi.onclick=()=>{document.querySelectorAll('.file-item').forEach(x=>x.classList.remove('active'));fi.classList.add('active');editorReturnView='home';ws.send(JSON.stringify({type:'read_file',path:item.path}));showView('editor');};
      container.appendChild(fi);
    }
  }
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
  const el = document.getElementById('editor-content');
  document.getElementById('toggle-preview').classList.toggle('active', editorMode === 'preview');
  document.getElementById('toggle-edit').classList.toggle('active', editorMode === 'edit');

  if (editorMode === 'preview') {
    el.className = 'editor-content formatted';
    el.contentEditable = 'false';
    el.innerHTML = formatMdFull(fileBody);
  } else {
    el.className = 'editor-content source';
    el.contentEditable = 'true';
    el.textContent = rawFileContent;
    el.focus();
  }
}

function setEditorMode(mode) {
  if (mode === 'preview' && editorMode === 'edit') {
    // Switching from edit to preview: capture changes first
    rawFileContent = document.getElementById('editor-content').textContent;
    const fmMatch = rawFileContent.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (fmMatch) { fileFrontmatter = '---\n' + fmMatch[1] + '\n---\n'; fileBody = fmMatch[2]; }
    else { fileFrontmatter = ''; fileBody = rawFileContent; }
  }
  editorMode = mode;
  renderEditorContent();
}

function getFileContentForSave() {
  if (editorMode === 'edit') {
    rawFileContent = document.getElementById('editor-content').textContent;
  }
  return rawFileContent;
}

// Wikilink navigation
function openWikilink(name) {
  const baseName = name.split('#')[0].trim();
  const searchName = baseName.endsWith('.md') ? baseName : baseName + '.md';

  // Search the cached file tree data (not the DOM)
  if (cachedFileTree) {
    const match = findFileInTree(cachedFileTree, searchName);
    if (match) {
      switchNav('files');
      ws.send(JSON.stringify({ type: 'read_file', path: match }));
      showView('editor');
      return;
    }
  }

  // If not found in cache, ask the server directly
  if (ws) {
    ws.send(JSON.stringify({ type: 'read_file', path: searchName }));
    switchNav('files');
    showView('editor');
  }
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

let editorReturnView = 'home';

function openSkillFile(filePath) {
  editorReturnView = 'skills';
  ws.send(JSON.stringify({ type: 'read_file', path: filePath }));
  showView('editor');
}

function editorGoBack() {
  showView(editorReturnView);
  editorReturnView = 'home';
}

// ===== 12. MARKDOWN RENDERING =====

// Configure marked
marked.setOptions({ gfm: true, breaks: false });

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

function renderSkills() {
  const assigned = skills.filter(s => s.status === 'assigned');
  const unassigned = skills.filter(s => s.status === 'unassigned');

  // Sidebar
  const sidebar = document.getElementById('skills-sidebar-list');
  let sidebarHtml = '';

  if (!assigned.length && !unassigned.length) {
    sidebarHtml = `<div style="padding:12px 16px">
      <div style="color:var(--text-2);font-size:var(--caption);line-height:1.6">No skills yet</div>
    </div>`;
  }
  if (assigned.length) {
    sidebarHtml += `<div style="padding:4px 8px 4px"><span class="sidebar-label">Assigned</span></div>`;
    for (const s of assigned) {
      const dots = s.assignedAgents.map(a => `<span class="skill-dot" style="background:${a.colour}" title="${a.name}"></span>`).join('');
      sidebarHtml += `<div class="skill-sidebar-item" onclick="selectSkill('${s.id}')" data-skill="${s.id}">
        <span class="skill-sidebar-name">${esc(s.name)}</span>
        <span class="skill-dots">${dots}</span>
      </div>`;
    }
  }

  if (unassigned.length) {
    sidebarHtml += `<div style="padding:12px 8px 4px"><span class="sidebar-label">Unassigned</span></div>`;
    for (const s of unassigned) {
      sidebarHtml += `<div class="skill-sidebar-item" onclick="selectSkill('${s.id}')" data-skill="${s.id}">
        <span class="skill-sidebar-name">${esc(s.name)}</span>
      </div>`;
    }
  }

  sidebar.innerHTML = sidebarHtml;

  // Main panel
  const main = document.getElementById('skills-main-list');
  let mainHtml = '';

  if (assigned.length) {
    mainHtml += `<div style="margin-bottom:24px">
      <div class="section-label" style="margin-bottom:10px;padding-left:4px">Assigned</div>
      <div class="skills-list-main">`;
    for (const s of assigned) {
      mainHtml += renderSkillRow(s);
    }
    mainHtml += `</div></div>`;
  }

  if (unassigned.length) {
    mainHtml += `<div style="margin-bottom:24px">
      <div class="section-label" style="margin-bottom:10px;padding-left:4px">Unassigned</div>
      <div class="skills-list-main">`;
    for (const s of unassigned) {
      mainHtml += renderSkillRow(s);
    }
    mainHtml += `</div></div>`;
  }

  if (!skills.length) {
    const guide = getGuide();
    mainHtml = `<div class="org-empty-state" style="padding:48px 24px;text-align:center">
      <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" class="empty-icon"><polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
      <div class="empty-title">No skills yet</div>
      ${guide ? `<button class="empty-cta" style="margin-top:8px" onclick="startConversation('${guide.id}')">Talk to Doc</button>` : ''}
    </div>`;
  }

  main.innerHTML = mainHtml;
  // When empty, make the scroll wrapper a flex container so the empty state centers
  const wrapper = document.getElementById('skills-scroll-wrapper');
  if (wrapper) {
    if (!skills.length) {
      wrapper.style.display = 'flex';
      wrapper.style.alignItems = 'center';
      wrapper.style.justifyContent = 'center';
      main.style.maxWidth = '';
    } else {
      wrapper.style.display = '';
      wrapper.style.alignItems = '';
      wrapper.style.justifyContent = '';
      main.style.maxWidth = '720px';
    }
  }
}

function renderSkillRow(s) {
  const dots = s.assignedAgents.map(a => `<span class="skill-dot" style="background:${a.colour}" title="${a.name}"></span>`).join('');

  // Build detail grid rows dynamically
  let gridRows = '';
  if (s.assignedAgents.length) {
    const agentList = s.assignedAgents.map(a => `<span style="display:flex;align-items:center;gap:6px"><span class="skill-dot" style="background:${a.colour}"></span> ${esc(a.name)}</span>`).join('');
    gridRows += `<span class="skill-detail-label">Used by</span><span class="skill-detail-value">${agentList}</span>`;
  }
  gridRows += `<span class="skill-detail-label">Source</span><span class="skill-detail-value"><a onclick="event.stopPropagation();openSkillFile('${s.filePath}')" style="font-family:'SF Mono','Fira Code',monospace;font-size:var(--label);color:var(--accent);cursor:pointer;text-decoration:none">${esc(s.slug)}</a></span>`;

  return `<div class="skill-row" data-skill-row="${s.id}" onclick="toggleSkillRow(this)">
    <div class="skill-row-header">
      <div class="skill-row-left">
        <svg class="skill-row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><polyline points="6 9 12 15 18 9"/></svg>
        <span class="skill-row-name">${esc(s.name)}</span>
        <span class="skill-dots">${dots}</span>
      </div>
      <span class="skill-row-desc">${esc(s.description)}</span>
    </div>
    <div class="skill-row-detail">
      <div class="skill-detail-grid">${gridRows}</div>
      ${s.description ? `<div style="margin-top:10px;font-size:var(--caption);line-height:1.6;color:var(--text-2)">${esc(s.description)}</div>` : ''}
    </div>
  </div>`;
}

function toggleSkillRow(el) {
  el.classList.toggle('expanded');
}

function selectSkill(id) {
  // Ensure skills view is visible
  showView('skills');

  // Highlight in sidebar
  document.querySelectorAll('.skill-sidebar-item').forEach(el => el.classList.remove('active'));
  document.querySelector(`.skill-sidebar-item[data-skill="${id}"]`)?.classList.add('active');

  // Expand selected and scroll to it (leave others open)
  const row = document.querySelector(`.skill-row[data-skill-row="${id}"]`);
  if (row) {
    row.classList.add('expanded');
    setTimeout(() => row.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  }
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
          <span class="settings-value" style="font-family:inherit">0.1.0</span>
        </div>
        <div class="settings-row">
          <span class="settings-label">Feedback</span>
          <a href="https://github.com/liamdarmody/rundock/issues" target="_blank" rel="noopener" style="font-size:var(--caption);color:var(--accent);text-decoration:underline;text-underline-offset:2px">Report an issue</a>
        </div>
      </div>`;
  }
}

function changeWorkspace() {
  ws.send(JSON.stringify({ type: 'list_workspaces' }));
}

// ===== 15. WORKSPACE PICKER =====

function handleWorkspaces(d) {
  if (d.current) {
    // Server already has a workspace set (env var or previous selection)
    onWorkspaceReady(d.current, d.analysis);
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
  document.getElementById('create-workspace-btn').style.display = 'none';
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

function onWorkspaceReady(dir, analysis) {
  const isSameWorkspace = (currentWorkspacePath === dir);
  currentWorkspacePath = dir;
  workspaceAnalysis = analysis || null;
  // Show nav and sidebar
  document.querySelector('.nav-rail').style.display = '';
  document.querySelector('.sidebar').style.display = '';
  // Load workspace data
  ws.send(JSON.stringify({ type: 'get_agents' }));
  ws.send(JSON.stringify({ type: 'get_files' }));
  ws.send(JSON.stringify({ type: 'get_skills' }));
  ws.send(JSON.stringify({ type: 'get_conversations' }));
  skillsLoaded = false;

  if (isSameWorkspace && currentView !== 'workspace') {
    // Reconnect to same workspace: keep in-memory conversations and active view intact.
    // Processing state will be reconciled by the active_processes message from the server.
    return;
  }

  // Different workspace: reset everything
  conversations = [];
  activeConversation = null;
  showView('home');
  switchNav('team');
}

// ===== 16. EVENT LISTENERS & INIT =====

// Editor save
let saveTimer=null;
document.addEventListener('input',e=>{if(e.target.id==='editor-content'&&currentFilePath&&editorMode==='edit'){document.getElementById('editor-status').textContent='Unsaved';document.getElementById('editor-status').style.color='var(--attention)';clearTimeout(saveTimer);saveTimer=setTimeout(()=>{ws.send(JSON.stringify({type:'save_file',path:currentFilePath,content:getFileContentForSave()}));document.getElementById('editor-status').style.color='var(--success)';document.getElementById('editor-status').textContent='Saved';},1500);}});
const msgInput = document.getElementById('msg-input');
msgInput.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}});
msgInput.addEventListener('input',()=>{
  msgInput.style.height='auto'; msgInput.style.height=Math.min(msgInput.scrollHeight, 200)+'px';
  const btn=document.getElementById('send-btn');
  if(msgInput.value.trim()) btn.classList.add('active'); else btn.classList.remove('active');
});

// Enter creates workspace
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && currentView === 'workspace' && document.activeElement?.id === 'create-workspace-name') {
    createWorkspace();
  }
});

connect();
