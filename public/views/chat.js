'use strict';
// Chat view (app.js section 9 plus the session-history and permission-UI
// subsections), extracted verbatim as a Foundations view module. Same UMD
// pattern as markers.js (node-requireable, window-attached); additionally
// republishes every function on the root object, because classic-script
// function declarations were window properties and the callers rely on that:
// the static inline handlers (sendMessage, cancelProcessing, copyAuthCmd), the
// WS dispatch and its effect executors (startProcessing, finishProcessing,
// handleActiveProcesses, handlePermissionRequest, renderSessionHistory,
// addAgentMsg, addSystemMsg, renderAuthErrorCard, the three Codex cards,
// formatToolName, buildActivitySummary, scrollBottom), the conversations view
// (dispatchMessage, setupChat's send-button wiring, renderPendingPermissionCards),
// and the composer's keydown listener (sendMessage).
//
// Shared state stays in app.js and is reached through the global lexical
// environment at call time: ws, agents, conversations, activeConversation,
// convoState, currentView, workingConvos, unread, agentLastActivity, and the
// two permission stores pendingPermissions and pendingPermissionsByConvo (the
// WS dispatch reads them for the permission-timeout and cancel sweeps, so they
// keep their declarations there). userScrolledUp stays for the same reason:
// the DOMContentLoaded scroll listener writes it. Helpers reached the same
// way: esc, formatMd, formatTimeAgo, stripRundockMarkers, getConvoState,
// persistConversation, renderConvoList, updateUnreadBadge, updateWorkingBadge,
// tryMessageAnchor, and the classic-script globals RundockPermissions,
// RundockConversationState and RundockChatMarkup.
//
// buildDelegationDivider moved the other way, from app.js into this module,
// once the markup came out of it: it renders a thread element, and both of its
// other callers (the agent_switch effect executor in app.js, in-memory replay
// in the conversations view) reach it through the root republication.
//
// alwaysAllowedTools is the one piece of view-local state: the session-level
// "always allow" grant set has no reader outside the permission cards, and a
// bare Set allocation keeps the factory side-effect-free.
//
// Every function body is byte-identical to the app.js original at column 0.
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.RundockChatView = factory();
    Object.assign(root, root.RundockChatView);
  }
}(typeof self !== 'undefined' ? self : this, function () {

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
    // Input stays enabled during processing so a next message can be drafted.
    // Use the active delegate agent during delegation, otherwise the conversation agent
    const activeId = state.activeAgentId || convo?.agentId;
    const a = (activeId && agents.find(x => x.id === activeId)) || convo?.agent || agents[0];
    const m=document.getElementById('messages'),d=document.createElement('div'); d.className='msg msg-agent'; d.id='thinking-indicator';
    d.innerHTML=RundockChatMarkup.thinkingIndicatorHtml(a);
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
    unread.markMessage(convoId);
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
    const draftInput = document.getElementById('msg-input');
    draftInput.disabled = false;
    // A message drafted while the agent was responding is now ready to send, so
    // reflect its presence on the Send button.
    sendBtn.classList.toggle('active', !!draftInput.value.trim());
    draftInput.focus();
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
  // Non-idle: actively generating output: restore thinking indicator.
  // Idle: specialist waiting for input: record agent identity so
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

// UI helpers
function addAgentMsg(text,agentId,anim=true,timestamp=null) {
  const a=agents.find(x=>x.id===agentId)||activeConversation?.agent||agents[0],m=document.getElementById('messages'),d=document.createElement('div');
  d.className='msg msg-agent'; if(!anim)d.style.animation='none';
  const t = timestamp ? new Date(timestamp) : new Date();
  d.innerHTML=RundockChatMarkup.agentMessageHtml(a, formatMd(text), RundockChatMarkup.msgTimeHtml(t));
  m.appendChild(d); scrollBottom(); return d;
}
function addUserMsg(text,anim=true) { const m=document.getElementById('messages'),d=document.createElement('div'); d.className='msg msg-user'; if(!anim)d.style.animation='none'; d.innerHTML=RundockChatMarkup.userBubbleHtml(esc(text)); m.appendChild(d); scrollBottom(true); }
function addSystemMsg(text) { const m=document.getElementById('messages'),d=document.createElement('div'); d.className='msg-system'; d.textContent=text; m.appendChild(d); scrollBottom(); }

// Build a delegation divider element. Used by live agent_switch (the effect
// executor in app.js), in-memory replay in the conversations view, and history
// replay below. It lived in app.js until the markup came out of it; it is
// chat thread rendering, so it belongs with the rest of the thread.
function buildDelegationDivider(agentData, isReturn, opts = {}) {
  const divider = document.createElement('div');
  divider.className = 'msg-delegation' + (opts.historyClass ? ' history-msg' : '');
  if (opts.noAnimation) divider.style.animation = 'none';
  divider.innerHTML = RundockChatMarkup.delegationDividerHtml(agentData, isReturn);
  return divider;
}

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
    // render a chat bubble: the agent-change divider on the next message
    // carries the visible handoff. Update lastAgentId so the divider triggers.
    if (msg.type === 'routing') {
      lastAgentId = msg.agentId || lastAgentId;
      continue;
    }
    const div = document.createElement('div');
    div.style.animation = 'none';
    if (msg.role === 'user') {
      div.className = 'msg msg-user history-msg';
      div.innerHTML = RundockChatMarkup.userBubbleHtml(esc(msg.content));
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
      // Strip RUNDOCK markers before rendering: the stored copy below strips
      // them (line ~2906), but this first-paint fragment rendered the raw
      // wire text, so a rehydrated Doc turn leaked its SAVE_AGENT payload as
      // visible frontmatter until the user navigated away and back.
      div.innerHTML = RundockChatMarkup.agentMessageHtml(msgAgent, formatMd(stripRundockMarkers(msg.content || '').trim()), RundockChatMarkup.msgTimeHtml(ht));
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
  // Workspace-boundary requests NEVER auto-allow client-side: standing
  // folder grants are evaluated by the server before the card is sent, so a
  // boundary request arriving here means no grant covers it and a human
  // must decide.
  const decision = req.boundary ? { action: 'card' } : RundockPermissions.decidePermission(risk, key, alwaysAllowedTools);
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
    unread.markPermission(convoId);
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
  // A WS reconnect re-sends control_request for every pending request, but the
  // DOM (and any existing card) survive the reconnect, so guard against a
  // duplicate card, exactly as renderPendingPermissionCards does.
  if (requestId && document.getElementById('perm-' + requestId)) return;
  const toolName = req.tool_name || 'Unknown';
  const input = req.input || {};
  const risk = classifyRisk(toolName, input);
  let { summary, context, detail } = describeToolRequest(toolName, input);
  const key = toolAllowKey(toolName, input);
  // Workspace-boundary requests get their own copy: the point is WHERE the
  // access lands, not which tool wants it.
  const boundary = req.boundary === true;
  // A standing folder grant is only on offer when the crossing HAS a folder.
  // A shell command denied by the runtime sandbox and retried with the sandbox
  // turned off is a crossing established by the operating system, not by a
  // path, so there is no directory to remember. respondPermission already
  // drops a grant it has no directory for, which would leave the button inert
  // while reading as a standing decision.
  const grantable = boundary && !!req.grant_dir;
  if (boundary) {
    const shell = toolName === 'Bash' || toolName === 'PowerShell';
    const reads = toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep';
    // A shell crossing does not say which act it is. The sandbox refuses
    // reads and network hosts as well as writes, and the retry that reaches
    // here carries no direction, so naming one would be a guess printed as a
    // fact. A file tool names its own act, so there it stays specific.
    summary = shell
      ? 'Wants to reach outside your workspace'
      : `Wants to ${reads ? 'read' : 'write'} outside your workspace`;
    context = grantable
      ? 'Outside-workspace access needs your approval. "Always allow this folder" remembers it for this workspace only.'
      : 'Outside-workspace access needs your approval. This one cannot be remembered: it is not about a single folder.';
    detail = req.resolved_path || detail;
  }

  // Store callback data for safe event handling (no inline onclick injection).
  // toolInput is echoed back in control_response (required by Claude Code).
  pendingPermissions.set(requestId, { convoId, key, toolInput: input, grantDir: grantable ? req.grant_dir : null });

  const icons = {
    low: '<svg class="permission-icon" width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/><path d="M6 8l1.5 1.5L10.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    medium: '<svg class="permission-icon" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1L1 4.5V8c0 3.5 3 6.5 7 7.5 4-1 7-4 7-7.5V4.5L8 1z" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M6 8l1.5 1.5L10.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    high: '<svg class="permission-icon" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1L1 4.5V8c0 3.5 3 6.5 7 7.5 4-1 7-4 7-7.5V4.5L8 1z" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M8 5v3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="10.75" r="0.75" fill="currentColor"/></svg>'
  };

  const m = document.getElementById('messages');
  const card = document.createElement('div');
  card.className = 'msg msg-permission';
  card.id = 'perm-' + requestId;
  const renderRisk = boundary ? 'high' : risk;
  card.innerHTML = `
    <div class="permission-card risk-${renderRisk}">
      <div class="permission-header">
        ${icons[renderRisk]}
        <span class="permission-summary">${esc(summary)}</span>
      </div>
      ${context ? `<div class="permission-context">${esc(context)}</div>` : ''}
      ${(toolName === 'Bash' && input.description && detail.length > 60)
        ? `<details class="permission-detail-collapse"><summary>Show command</summary><code class="permission-detail">${esc(detail)}</code></details>`
        : `<code class="permission-detail">${esc(detail)}</code>`}
      <div class="permission-actions">
        <button class="btn-perm btn-allow" data-perm-id="${esc(requestId)}" data-perm-action="allow">Allow</button>
        ${grantable
          ? `<button class="btn-perm btn-always" data-perm-id="${esc(requestId)}" data-perm-action="allow-folder">Always allow this folder</button>`
          : (!boundary && RundockPermissions.offersAlwaysAllow(risk) ? `<button class="btn-perm btn-always" data-perm-id="${esc(requestId)}" data-perm-action="always">Always allow</button>` : '')}
        <button class="btn-perm btn-deny" data-perm-id="${esc(requestId)}" data-perm-action="deny">Deny</button>
      </div>
    </div>
  `;

  // Attach event listeners safely (no inline onclick)
  card.querySelectorAll('[data-perm-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.permAction;
      const id = btn.dataset.permId;
      respondPermission(id, action !== 'deny', action === 'always', action === 'allow-folder');
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

function respondPermission(requestId, allow, always, allowFolder) {
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
    ...(allowFolder && pending.grantDir ? { grantDir: pending.grantDir } : {}),
    allow: allow,
    toolInput: pending.toolInput || {}
  }));

  // Store always-allow pattern if requested
  if (allow && always) {
    alwaysAllowedTools.add(pending.key);
  }

  // Replace the card with a resolved indicator
  resolvePermissionCard(requestId, allow, allow ? (always ? '✓ Always' : '✓') : '✕', true);

  // Resume thinking indicator
  const t = document.getElementById('thinking-indicator');
  if (t) t.style.display = '';
}

// Replace an answered permission card with its resolved indicator. Shared with
// the WS permission_timeout branch in app.js, which answers the same card when
// the server auto-denies it: that branch used to write its own markup, which
// had drifted to a different shape from this one.
//
// keepSummary decides whether the card's own summary text is carried into the
// resolved state. The user-answered path keeps it so the thread still reads as
// a record of what was approved; the timeout path never showed it.
function resolvePermissionCard(requestId, allowed, label, keepSummary) {
  const card = document.getElementById('perm-' + requestId);
  if (!card) return;
  const summary = keepSummary ? (card.querySelector('.permission-summary')?.textContent || '') : '';
  card.innerHTML = RundockChatMarkup.permissionResolvedHtml(allowed, label, summary ? esc(summary) : '');
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

function scrollBottom(force) {
  const m=document.getElementById('messages'); if(!m) return;
  if (force) { userScrolledUp = false; m.scrollTop=m.scrollHeight; return; }
  if (!userScrolledUp) m.scrollTop=m.scrollHeight;
}

return {
  dispatchMessage, sendMessage, startProcessing, finishProcessing,
  cancelProcessing, handleActiveProcesses, addAgentMsg, addUserMsg,
  addSystemMsg, buildDelegationDivider, renderAuthErrorCard, copyAuthCmd, agentDisplayName,
  renderCodexQuotaCard, renderCodexGuidanceCard, renderCodexErrorPill,
  createHistoryDivider, renderSessionHistory, classifyRisk,
  describeToolRequest, toolAllowKey, handlePermissionRequest,
  renderPermissionCard, renderPendingPermissionCards, respondPermission,
  resolvePermissionCard,
  formatToolName, formatToolShort, buildActivitySummary, scrollBottom,
};
}));
