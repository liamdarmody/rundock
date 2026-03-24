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
 * 6. ORG CHART ....................... renderOrgChart, drawAndScaleOrgChart
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

let ws=null, agents=[], conversations=[], activeConversation=null, currentView='home', currentFilePath=null, skills=[], skillsLoaded=false, currentWorkspacePath=null;
const agentLastActivity = {}; // { agentId: { time: Date, label: string } }
// Per-conversation state: { convoId: { isProcessing, currentStreamingMsg, latestText } }
const convoState = {};

// ===== 2. HELPERS =====

function esc(t){const d=document.createElement('div');d.textContent=t;return d.innerHTML;}
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
    return `${h > 12 ? h - 12 : h}:${m} ${h >= 12 ? 'PM' : 'AM'}`;
  }
  const weeklyMatch = s.match(/every (\w+) at (\d{2}):(\d{2})/);
  if (weeklyMatch) {
    const day = weeklyMatch[1].charAt(0).toUpperCase() + weeklyMatch[1].slice(1, 3);
    const h = parseInt(weeklyMatch[2]);
    const m = weeklyMatch[3];
    return `${day} ${h > 12 ? h - 12 : h}:${m} ${h >= 12 ? 'PM' : 'AM'}`;
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
  ws.onclose = () => { setConn('disconnected'); setTimeout(connect,3000); };
}
function setConn(s) { const b=document.getElementById('connection-bar'); b.className=`connection-bar ${s}`; b.textContent=s==='connected'?'Connected':s==='disconnected'?'Disconnected. Reconnecting...':'Connecting...'; if(s==='connected')setTimeout(()=>b.style.display='none',2000); else b.style.display='block'; }

// ===== 4. MESSAGE HANDLING =====

function handle(d) {
  const convoId = d._conversationId;

  switch(d.type) {
    case 'workspaces': handleWorkspaces(d); break;
    case 'workspace_set': onWorkspaceReady(d.path); break;
    case 'workspace_error': {
      const errEl = document.getElementById('workspace-error');
      if (errEl) { errEl.textContent = d.message; errEl.style.display = 'block'; }
      break;
    }
    case 'needs_workspace': showView('workspace'); break;
    case 'agents': agents=d.agents; renderAgentList(); renderOrgChart(); renderRoutinesSidebar(); renderConvoList(); break;
    case 'skills': skills=d.skills; skillsLoaded=true; renderSkills(); break;
    case 'system':
      // Capture session ID from init message
      if(d.subtype==='init' && d._sessionId && convoId) {
        const convo = conversations.find(c => c.id === convoId);
        if(convo && !convo.sessionId) convo.sessionId = d._sessionId;
      }
      if(d.subtype==='done' && convoId) finishProcessing(convoId);
      break;
    case 'assistant':
      if(convoId) handleAssistant(d, convoId);
      break;
    case 'result':
      if(convoId) handleResult(d, convoId);
      break;
    case 'file_tree': cachedFileTree = d.tree; renderFileTree(d.tree); break;
    case 'file_content': loadFileContent(d.path, d.content); break;
    case 'file_saved': document.getElementById('editor-status').textContent='Saved'; break;
    case 'error': if(!d.content?.includes('no stdin')) addSystemMsgToConvo(d.content, convoId); break;
  }
}
function getConvoState(convoId) {
  if(!convoState[convoId]) convoState[convoId] = { isProcessing: false, currentStreamingMsg: null, latestText: '', latestAgentId: null };
  return convoState[convoId];
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

  if(d.result && convo) {
    convo.messages.push({role:'agent', content:d.result, agentId});
  }

  if(isActive) {
    const t=document.getElementById('thinking-indicator'); if(t) t.remove();
    if(d.result) addAgentMsg(d.result, agentId);
  }

  state.currentStreamingMsg=null; state.latestText=''; state.latestAgentId=null;
  finishProcessing(convoId);
  renderConvoList();
}

function addSystemMsgToConvo(text, convoId) {
  if(!convoId || activeConversation?.id === convoId) addSystemMsg('Error: ' + text);
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
      <div class="sidebar-empty-text">No agents yet</div>
      <button class="empty-cta" style="width:100%" onclick="startConversation('${guide.id}')">Talk to the Guide</button>
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
    if (labelEl) { labelEl.textContent = 'Start a conversation'; labelEl.style.fontSize = 'var(--body)'; labelEl.style.fontWeight = '400'; labelEl.style.color = 'var(--text-2)'; }

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
    contentEl.style.display = 'flex';
    contentEl.style.flexDirection = 'column';
    contentEl.style.alignItems = 'center';
    contentEl.style.gap = '0';
    contentEl.innerHTML = h;
  } else {
    // Empty workspace: show Guide CTA
    if (labelEl) { labelEl.textContent = 'No conversations yet'; labelEl.style.fontSize = 'var(--title)'; labelEl.style.fontWeight = '700'; labelEl.style.color = 'var(--text-1)'; }
    const guide = platformAgents[0];
    contentEl.style.display = '';
    contentEl.style.flexDirection = '';
    contentEl.style.alignItems = '';
    contentEl.style.gap = '';
    contentEl.innerHTML = guide ? `<button class="empty-cta" style="margin-top:4px" onclick="startConversation('${guide.id}')">Talk to the Guide</button>` : '';
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
  // Only consider non-platform agents for the org tree
  const leader = orchestrator || agents.find(a => a.isDefault) || null;
  const team = specialists.length ? specialists : untyped.filter(a => a !== leader);
  const hasTeam = leader || team.length;

  let h = '<div class="org-tree">';

  if (hasTeam) {
    // Orchestrator
    if (leader) {
      h += `<div class="org-leader"><div class="org-card" onclick="showProfile('${leader.id}')"><div class="avatar" style="background:${leader.colour};width:44px;height:44px;font-size:18px">${leader.icon}</div><div><div class="org-card-name" style="font-size:var(--title)">${leader.displayName}</div><div class="org-card-role">${leader.role || ''}</div></div></div></div>`;
    }

    // Specialists
    if (team.length) {
      const midIndex = Math.floor(team.length / 2);
      h += '<div class="org-trunk"></div><div class="org-branches">';
      team.forEach((a, i) => {
        const isTrunk = (team.length % 2 === 1) && (i === midIndex);
        h += `<div class="org-branch${isTrunk ? ' trunk-branch' : ''}"><div class="org-branch-stem"></div><div class="org-card" onclick="showProfile('${a.id}')"><div class="avatar" style="background:${a.colour}">${a.icon}</div><div><div class="org-card-name">${a.displayName}</div><div class="org-card-role">${a.role || ''}</div></div></div></div>`;
      });
      h += '</div>';
    }
  } else {
    // Empty workspace: show welcome message
    const guide = platformAgents[0];
    h += '<div class="org-empty-state">';
    h += '<div class="empty-title">Welcome to Rundock</div>';
    if (guide) {
      h += `<button class="empty-cta" style="margin-top:8px" onclick="startConversation('${guide.id}')">Talk to the Guide</button>`;
    }
    h += '</div>';
  }

  // Platform section (inside .org-tree so it scales together)
  if (platformAgents.length) {
    h += `<div class="org-platform-section" style="margin-top:${hasTeam ? '48' : '32'}px">`;
    h += '<div class="org-platform-divider"></div>';
    h += '<div class="org-platform-label">Rundock Agents</div>';
    h += '<div style="display:flex;justify-content:center;gap:12px">';
    for (const a of platformAgents) {
      h += `<div class="org-card org-card-sm" onclick="showProfile('${a.id}')"><div class="avatar xxs" style="background:${a.colour}">${a.icon}</div><div><div class="org-card-name" style="font-size:var(--caption);font-weight:600">${a.displayName}</div><div class="org-card-role" style="font-size:var(--label)">${a.role || ''}</div></div></div>`;
    }
    h += '</div></div>';
  }

  h += '</div>'; // close .org-tree

  document.getElementById('org-chart').innerHTML = h;
  setTimeout(() => { drawAndScaleOrgChart(); }, 50);
}
function drawAndScaleOrgChart() {
  const container = document.getElementById('org-chart');
  const tree = container?.querySelector('.org-tree');
  if (!container || !tree) return;

  // Step 1: Reset scale so we measure at natural size
  tree.style.transform = 'scale(1)';
  tree.style.transformOrigin = 'center top';

  // Step 2: Measure natural dimensions
  const containerW = container.clientWidth - 64;
  const containerH = container.clientHeight - 80;
  const treeW = tree.offsetWidth;
  const treeH = tree.offsetHeight;

  if (treeW === 0 || treeH === 0) return;

  // Step 3: Calculate scale, min 1.0, max 1.2
  const scaleX = (containerW * 0.8) / treeW;
  const scaleY = (containerH * 0.8) / treeH;
  const scale = Math.max(1.0, Math.min(scaleX, scaleY, 1.2));

  // Step 4: Apply scale
  tree.style.transform = `scale(${scale})`;
}

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

function startConversation(agentId) {
  const agent=agents.find(a=>a.id===agentId)||agents[0];
  const convo={id:Date.now().toString(),agentId:agent.id,agent,title:`Chat with ${agent.displayName}`,messages:[],status:'active'};
  conversations.unshift(convo); activeConversation=convo;
  renderConvoList(); setupChat(convo);
  document.getElementById('messages').innerHTML='';
  showView('chat');
}
function newConversation() { const d=agents.find(a=>a.isDefault)||agents[0]; if(d) startConversation(d.id); }
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
    renderConvoList();
  }
}
function toggleConvoStatus() {
  if(!activeConversation) return;
  activeConversation.status = activeConversation.status==='done'?'active':'done';
  const statusEl=document.getElementById('chat-convo-status');
  statusEl.textContent=activeConversation.status==='done'?'Done':'Active';
  statusEl.className=`chat-convo-status ${activeConversation.status==='done'?'done-convo':'active-convo'}`;
  renderConvoList();
}
function renderConvoList() {
  const active=conversations.filter(c=>c.status!=='done');
  const done=conversations.filter(c=>c.status==='done');
  let h='';
  if(!active.length && !done.length) {
    h = `<div style="padding:12px 16px">
      <div style="color:var(--text-2);font-size:var(--caption);line-height:1.6">No conversations yet</div>
    </div>`;
  }
  if(active.length) {
    for(const c of active) {
      const lastMsg=c.messages.filter(m=>m.role==='agent').pop();
      const preview=lastMsg?stripMd(lastMsg.content).substring(0,60)+'...':'No messages yet';
      h+=`<div class="convo-item ${activeConversation?.id===c.id?'active':''}" onclick="openConversation('${c.id}')">
        <span class="convo-title">${esc(c.title)}</span>
        <span class="convo-preview">${esc(preview)}</span>
        <div class="convo-meta"><div class="avatar xs" style="background:${c.agent.colour}">${c.agent.icon}</div><span>${c.agent.displayName}</span></div>
      </div>`;
    }
  }
  if(done.length) {
    h+=`<div style="padding:12px 8px 6px"><span class="sidebar-label" style="cursor:pointer" onclick="document.getElementById('done-convos').classList.toggle('hidden')">Done (${done.length}) &#x25BE;</span></div>`;
    h+=`<div id="done-convos" class="hidden">`;
    for(const c of done) {
      const lastMsg=c.messages.filter(m=>m.role==='agent').pop();
      const preview=lastMsg?stripMd(lastMsg.content).substring(0,50)+'...':'';
      h+=`<div class="convo-item ${activeConversation?.id===c.id?'active':''}" onclick="openConversation('${c.id}')" style="opacity:0.7">
        <span class="convo-title">${esc(c.title)}</span>
        <span class="convo-preview">${esc(preview)}</span>
        <div class="convo-meta"><div class="avatar xs" style="background:${c.agent.colour}">${c.agent.icon}</div><span>${c.agent.displayName}</span></div>
      </div>`;
    }
    h+=`</div>`;
  }
  document.getElementById('convo-list').innerHTML=h;
}
function openConversation(id) {
  const c=conversations.find(x=>x.id===id); if(!c) return;
  activeConversation=c;
  if(c.status==='done') { c.status='active'; }
  setupChat(c);
  const el=document.getElementById('messages'); el.innerHTML='';
  for(const m of c.messages) { if(m.role==='user') addUserMsg(m.content,false); else if(m.role==='agent') addAgentMsg(m.content,m.agentId,false); }
  // Restore processing state if this conversation is still working
  const state = getConvoState(id);
  if(state.isProcessing) {
    document.getElementById('chat-status').textContent='· working...'; document.getElementById('chat-status').classList.add('working');
    document.getElementById('send-btn').disabled=true; document.getElementById('msg-input').disabled=true;
    const a=c.agent;
    const m2=document.getElementById('messages'),d=document.createElement('div'); d.className='msg msg-agent'; d.id='thinking-indicator';
    d.innerHTML=`<div class="msg-sender" style="color:${a?.colour||'var(--accent)'}"><div class="avatar xs" style="background:${a?.colour||'var(--accent)'}">${a?.icon||'?'}</div> ${a?.displayName||'Agent'}</div><div class="msg-bubble thinking-bubble"><div class="thinking-pulse" style="background:${a?.colour||'var(--accent)'}"></div><div><div class="thinking-label">Thinking</div><div class="thinking-status" id="thinking-status"></div></div></div>`;
    m2.appendChild(d);
  } else {
    document.getElementById('chat-status').textContent=''; document.getElementById('chat-status').classList.remove('working');
    document.getElementById('send-btn').disabled=false;
    document.getElementById('msg-input').disabled=false;
    document.getElementById('msg-input').focus();
  }
  showView('chat'); scrollBottom(); renderConvoList();
}

// ===== 9. CHAT & MESSAGING =====

function sendMessage() {
  const input=document.getElementById('msg-input'),text=input.value.trim();
  if(!activeConversation||!ws) return;
  const state = getConvoState(activeConversation.id);
  if(!text||state.isProcessing) return;
  addUserMsg(text); activeConversation.messages.push({role:'user',content:text});
  if(activeConversation.messages.filter(m=>m.role==='user').length===1) { activeConversation.title=text.substring(0,50)+(text.length>50?'...':''); document.getElementById('chat-title-input').value=activeConversation.title; renderConvoList(); }
  input.value=''; input.style.height='44px'; document.getElementById('send-btn').classList.remove('active'); startProcessing(activeConversation.id);
  const chatMsg = {type:'chat', content:text, agent:activeConversation.agentId, conversationId:activeConversation.id};
  // Include session ID for resume if this isn't the first message
  if(activeConversation.sessionId) chatMsg.sessionId = activeConversation.sessionId;
  ws.send(JSON.stringify(chatMsg));
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
  else if(nav==='conversations') showView(activeConversation?'chat':'convo-empty');
  else showView('home');
}
function showView(v) { currentView=v; ['workspace','home','profile','chat','convo-empty','editor','skills','settings'].forEach(id=>{const e=document.getElementById(`view-${id}`);if(e){e.classList.add('hidden');e.style.display='none';e.classList.remove('main-view-transition');}}); const e=document.getElementById(`view-${v}`); if(e){e.classList.remove('hidden');e.style.display='flex';e.classList.add('main-view-transition');} if(v==='home')setTimeout(drawAndScaleOrgChart,50); }
function goHome() { activeConversation=null; showView('home'); switchNav('team'); document.querySelectorAll('.agent-status-item').forEach(el=>el.classList.remove('active')); }
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
      ${guide ? `<button class="empty-cta" style="margin-top:4px" onclick="switchNav('conversations');startConversation('${guide.id}')">Talk to the Guide</button>` : ''}`;
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
      ${guide ? `<button class="empty-cta" style="margin-top:4px" onclick="switchNav('conversations');startConversation('${guide.id}')">Talk to the Guide</button>` : ''}
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
    onWorkspaceReady(d.current);
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

function onWorkspaceReady(dir) {
  currentWorkspacePath = dir;
  // Show nav and sidebar
  document.querySelector('.nav-rail').style.display = '';
  document.querySelector('.sidebar').style.display = '';
  // Load workspace data
  ws.send(JSON.stringify({ type: 'get_agents' }));
  ws.send(JSON.stringify({ type: 'get_files' }));
  ws.send(JSON.stringify({ type: 'get_skills' }));
  skillsLoaded = false;
  // Reset state
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

window.addEventListener('resize',()=>{ if(currentView==='home') drawAndScaleOrgChart(); });
connect();
