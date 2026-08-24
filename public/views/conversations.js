'use strict';
// Conversations view (app.js section 8), extracted verbatim as a Foundations
// view module. Same UMD pattern as markers.js (node-requireable,
// window-attached); additionally republishes every function on the root
// object, because classic-script function declarations were window properties
// and the callers rely on that: the static inline handlers (newConversation,
// toggleConvoStatus, renameConversation, setSidebarPill), the generated
// onclick and oncontextmenu handlers on every sidebar row (openConversation,
// togglePin, archiveConversation, deleteConversation, openConvoListMenu), the
// WS dispatch (handlePersistedConversations, renderConvoList, renderListPills,
// toggleConvoListMembership), routing (newConversation, discardIfEmpty), the
// prompt-pill delegate (sendPrompt), and the search palette
// (openConversation).
//
// Shared state stays in app.js and is reached through the global lexical
// environment at call time: ws, agents, conversations, activeConversation,
// convoState, conversationsLoaded, lastActiveConversationId,
// pendingActiveProcesses, pendingMessageAnchor, workingConvos, unread,
// convoLists, activeSidebarPill, workspaceAnalysis, workspaceMode,
// setupComplete, and pendingListAdd (openConvoListMenu writes it; the WS lists
// handler reads and clears it, so its declaration stays in app.js). Helpers
// reached the same way: esc, escAttr, stripMd, formatMd, persist,
// getConvoState, getGuide, getTeamAgents, pickDefaultConversation,
// persistLastActiveConversation, updateUnreadBadge, buildDelegationDivider,
// createHistoryDivider, renderPendingPermissionCards, scrollBottom, setNavState,
// switchNav, showView, closeFindBar, and the section 9 chat surface
// (addUserMsg, addAgentMsg, addSystemMsg, sendMessage, cancelProcessing,
// startProcessing, handleActiveProcesses), plus the classic-script global
// RundockConvoList (ordering and filtering, unit-tested separately).
//
// Every function body is byte-identical to the app.js original at column 0.
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.RundockConversationsView = factory();
    Object.assign(root, root.RundockConversationsView);
  }
}(typeof self !== 'undefined' ? self : this, function () {

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
  if (persist.get(key)) return;
  persist.set(key, '1');
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
  // chart, empty states). The chat view carries that section, so showView
  // sets it and this does not have to know.
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
  // The input stays enabled even while the agent is processing, so the user can
  // draft their next message. The Stop button is the only way to interrupt; a
  // draft is sent by stopping first, then Send.
  msgInput.disabled = false;
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
    // Reflect any draft already in the field so Send reads as ready.
    sendBtn.classList.toggle('active', !!msgInput.value.trim());
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
  unread.clearConvo(id);
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

// State dot for a convo row's meta line. The coloured left border is gone;
// working shows the pulsing halo dot, unread (and not working) the static
// dot, same hue, so the difference is motion plus ring-vs-no-ring rather
// than position. Pinned-ness stays list position + the title-row pin glyph.
function convoStateDot(c) {
  if (workingConvos.has(c.id)) return '<span class="convo-working"></span>';
  if (unread.isUnread(c.id)) return '<span class="convo-unread"></span>';
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
  // Messaging-style ordering: pinned conversations always group
  // at the top, then everything else; BOTH groups sort by lastActiveAt desc.
  // Pinned-ness is conveyed by position plus the title-row pin glyph; the
  // left-border channel is reserved for the unread/working signal (green).
  // Pills are All | Unread only: pinning is a layout concern, not a filter,
  // so the old Pinned pill is gone.
  // Ordering/filtering rules live in conversation-list.js (unit-tested;
  // loaded before this file).
  const { main, archived } = RundockConvoList.partitionConversations(conversations, {
    pill: activeSidebarPill,
    unreadIds: unread.ids(),
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
    const archivedHasUnread = archived.some(c => unread.isUnread(c.id));
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
// Row state lives in the meta-line dot via convoStateDot(c): pulsing halo
// for working, static for unread, none otherwise. Pinned-ness is conveyed
// by list position and the title-row pin glyph.
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

  const indicator = convoStateDot(c);
  // Recency label, right-aligned in the meta row. Omitted while the agent is
  // working: the pulsing dot already communicates "right now" and a time value
  // would be ambiguous.
  const timeStr = working ? '' : `<span class="convo-time">${formatRecency(c.lastActiveAt)}</span>`;

  const classes = ['convo-item'];
  if (isActive) classes.push('active');

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
  const c=conversations.find(x=>x.id===id);
  // Missing target (a search hit whose conversation is absent from the client
  // list, server/client desync): land in the Conversations section
  // consistently instead of switching the rail while the origin pane stays
  // shown (half-navigated).
  if(!c) { switchNav('conversations'); return; }
  // Opening a conversation IS a navigation to the Conversations section,
  // wherever it started (sidebar click, search palette, an agent profile's
  // conversation list); the rail and sidebar follow the chat view this ends in.
  // A stale search anchor must never fire on a later manual open (it would
  // scroll to and flash an old hit days later).
  if (!withAnchor) pendingMessageAnchor = null;
  // Close any active find before swapping the DOM out from under it.
  if (activeConversation && activeConversation.id !== id) closeFindBar();
  if (activeConversation && activeConversation.id !== id) discardIfEmpty();
  activeConversation=c;
  persistLastActiveConversation(id);
  unread.clearConvo(id);
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
    // Input stays enabled during processing so a next message can be drafted.
    const a=agents.find(x => x.id === state.activeAgentId) || c.agent;
    const m2=document.getElementById('messages');
    // Render any response text accumulated on the server before we reconnected
    if(state.streamingRawText) {
      const el = document.createElement('div');
      el.className = 'msg msg-agent';
      el.innerHTML = RundockChatMarkup.agentStreamingMessageHtml(a, formatMd(state.streamingRawText), RundockChatMarkup.msgTimeHtml(new Date()));
      m2.appendChild(el);
      state.currentStreamingMsg = el;
      state.hasStreamingBubble = true; // keep the reducer's bubble flag in sync with this out-of-band creation
    }
    // Show thinking indicator only if no text has been streamed yet.
    // If we have snapshot text, the stream is active and the bubble is unnecessary.
    if(!state.streamingRawText) {
      const d=document.createElement('div'); d.className='msg msg-agent'; d.id='thinking-indicator';
      d.innerHTML=RundockChatMarkup.thinkingIndicatorHtml(a);
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

return {
  persistConversation, handlePersistedConversations, createConversation,
  maybeShowCodexFirstRun, startConversation, startSetupConversation,
  sendPrompt, newConversation, setupChat, renameConversation,
  deleteConversation, archiveConversation, togglePin, toggleConvoStatus,
  formatRecency, convoStateDot, setSidebarPill, renderListPills,
  openConvoMenu, convoMenuEsc, closeConvoMenu, openConvoListMenu,
  toggleConvoListMembership, renderConvoList, renderConvoItem,
  discardIfEmpty, openConversation,
};
}));
