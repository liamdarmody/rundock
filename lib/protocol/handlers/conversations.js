'use strict';
// WS handlers: conversation metadata, lists, and last-active persistence.
// Extracted verbatim from server.js. Persistence primitives are lib-owned
// (direct require); the live process map, message-count/search capabilities
// are root-owned and injected via ctx. Workspace read at USE time.
const { getWorkspace } = require('../../config.js');
const {
  readConversations, writeConversations,
  readLists, writeLists, deleteListEverywhere,
  readState, writeState,
} = require('../../store/persistence.js');
const { loadTranscript } = require('../../store/transcripts.js');

function handleGetConversations(ctx, ws, msg) {
  if (!getWorkspace()) return;
  // Clean up empty conversations (no sessionId means no message was ever sent)
  // Only remove if older than 5 minutes to avoid race with sessionId assignment
  const convos = readConversations();
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  const cleaned = convos.filter(c => c.sessionId || new Date(c.lastActiveAt || c.createdAt).getTime() > fiveMinAgo);
  let convosChanged = cleaned.length < convos.length;
  // Reconcile activeAgentId on load. A pointer to a delegatee is stale
  // ONLY when there is no live process: the orchestrator resumes after a
  // delegate returns or the conversation goes idle. Skip any conversation
  // with a live process, whose activeAgentId (a live delegate) is
  // legitimate and must not be clobbered mid-delegation.
  for (const c of cleaned) {
    if (c.activeAgentId && c.activeAgentId !== c.agentId && !ctx.processes.has(c.id)) {
      c.activeAgentId = c.agentId;
      convosChanged = true;
    }
  }
  // Persist at most once per load, and only when something changed
  // (previously wrote unconditionally, up to twice per load).
  if (convosChanged) writeConversations(cleaned);
  // Strip markdown formatting for plain-text previews (mirrors frontend stripMd)
  function stripMdServer(t) {
    return t
      .replace(/\*\*(.*?)\*\*/g, '$1')       // bold
      .replace(/\*(.*?)\*/g, '$1')            // italic *
      .replace(/_(.*?)_/g, '$1')              // italic _
      .replace(/~~(.*?)~~/g, '$1')            // strikethrough
      .replace(/`([^`]+)`/g, '$1')            // inline code
      .replace(/^#+\s*/gm, '')                // headings
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2') // wikilinks with alias
      .replace(/\[\[([^\]]+)\]\]/g, '$1')     // wikilinks
      .replace(/==(.*?)==/g, '$1')             // highlights
      .replace(/^[\s]*[-*+]\s/gm, '');         // list markers
  }
  // Enrich each conversation for sidebar/profile display. Two passes:
  //   1. messageCount: sum of user/assistant chat-bubble turns across
  //      every Claude Code session JSONL the conversation touches. This
  //      is the canonical source: Rundock's own transcript only covers
  //      messages emitted after appendTranscript started running and is
  //      partial or missing for older conversations.
  //   2. lastAgentId / lastMessagePreview: still sourced from the
  //      transcript, which is the only place the orchestrator/specialist
  //      attribution is recorded for the last visible turn.
  for (const c of cleaned) {
    try { c.messageCount = ctx.store.countConversationMessages(c); }
    catch (e) { c.messageCount = 0; }
    try {
      const transcript = loadTranscript(c.id);
      if (!transcript || !transcript.length) continue;
      for (let i = transcript.length - 1; i >= 0; i--) {
        const entry = transcript[i];
        if (entry.role === 'agent' && entry.text) {
          c.lastAgentId = entry.agent || null;
          c.lastMessagePreview = stripMdServer(
            entry.text
              .replace(/<!-- RUNDOCK:(?:SAVE|CREATE)_AGENT name=[\w-]+ -->[\s\S]*?<!-- \/RUNDOCK:(?:SAVE|CREATE)_AGENT -->/g, '')
              .replace(/<!-- RUNDOCK:SAVE_SKILL name=[\w-]+ -->[\s\S]*?<!-- \/RUNDOCK:SAVE_SKILL -->/g, '')
              .replace(/<!--[\s\S]*?-->/g, '')
              .replace(/\n/g, ' ')
              .replace(/^(\s*\[[^\]]+\]\s*)+/, '')
          ).trim().substring(0, 80);
          break;
        }
      }
    } catch (e) { /* preview enrichment is best-effort */ }
  }
  const lastActiveConversationId = readState().lastActiveConversationId || null;
  ws.send(JSON.stringify({ type: 'conversations', conversations: cleaned, lastActiveConversationId }));
}

function handleSetLastActiveConversation(ctx, ws, msg) {
  if (!getWorkspace()) return;
  const state = readState();
  if (msg.id) state.lastActiveConversationId = msg.id;
  else delete state.lastActiveConversationId;
  writeState(state);
}

function handleSaveConversation(ctx, ws, msg) {
  if (!getWorkspace() || !msg.conversation || !msg.conversation.id) return;
  const convos = readConversations();
  const idx = convos.findIndex(c => c.id === msg.conversation.id);
  // Only persist metadata, never message content
  const entry = {
    id: msg.conversation.id,
    agentId: msg.conversation.agentId,
    activeAgentId: msg.conversation.activeAgentId || null,
    sessionId: msg.conversation.sessionId || null,
    sessionIds: msg.conversation.sessionIds || [],
    title: msg.conversation.title,
    status: msg.conversation.status || 'active',
    pinned: msg.conversation.pinned || false,
    pinnedAt: msg.conversation.pinnedAt || null,
    listIds: Array.isArray(msg.conversation.listIds) ? msg.conversation.listIds.filter(x => typeof x === 'string') : [],
    createdAt: msg.conversation.createdAt || new Date().toISOString(),
    lastActiveAt: new Date().toISOString()
  };
  if (idx >= 0) { convos[idx] = entry; } else { convos.unshift(entry); }
  // Cap at 100 conversations
  writeConversations(convos.slice(0, 100));
}

// ── CONVERSATION LISTS: named many-to-many sidebar groupings ──
function handleGetLists(ctx, ws, msg) {
  if (!getWorkspace()) return;
  ws.send(JSON.stringify({ type: 'lists', lists: readLists() }));
}

function handleCreateList(ctx, ws, msg) {
  if (!getWorkspace()) return;
  const name = typeof msg.name === 'string' ? msg.name.trim().slice(0, 60) : '';
  if (!name) return;
  const lists = readLists();
  // Same name twice is a no-op rather than a duplicate pill.
  if (!lists.some(l => l.name.toLowerCase() === name.toLowerCase())) {
    lists.push({ id: 'list-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, createdAt: new Date().toISOString() });
    writeLists(lists);
  }
  ws.send(JSON.stringify({ type: 'lists', lists }));
}

function handleDeleteList(ctx, ws, msg) {
  if (!getWorkspace() || typeof msg.id !== 'string') return;
  deleteListEverywhere(msg.id);
  ws.send(JSON.stringify({ type: 'lists', lists: readLists() }));
}

function handleDeleteConversation(ctx, ws, msg) {
  if (!getWorkspace() || !msg.id) return;
  const convos = readConversations().filter(c => c.id !== msg.id);
  writeConversations(convos);
  // Drop the conversation's rows from the search index (spec: a
  // deleted conversation no longer appears in results).
  const engine = ctx.store.ensureSearchEngine();
  if (engine) {
    try { engine.removeConversation(msg.id); } catch (e) { /* rebuild covers it */ }
  }
  ws.send(JSON.stringify({ type: 'conversation_deleted', id: msg.id }));
}

module.exports = { handleGetConversations, handleSetLastActiveConversation, handleSaveConversation, handleGetLists, handleCreateList, handleDeleteList, handleDeleteConversation };
