'use strict';
// WS handlers: conversation search, the universal palette, and session
// history assembly. Extracted verbatim from server.js. The search engine,
// its reconcile step, the grep fallback, and the session-history parser are
// root-owned (injected via ctx.store); transcripts and conversation records
// are lib-owned. Workspace read at USE time.
const { getWorkspace } = require('../../config.js');
const { readConversations } = require('../../store/persistence.js');
const { loadTranscript, stripToolSummaryPrefix } = require('../../store/transcripts.js');
const { isRundockPrompt, isRundockReply } = require('../../delegation/rundock-lines.js');

// ── CONVERSATION SEARCH: search titles and transcript content ──
function handleSearchConversations(ctx, ws, msg) {
  // Conversation-only search. No in-repo client sends this today
  // (the palette's search_universal replaced the sidebar search field);
  // retained deliberately as a stable WS surface for stale cached
  // clients and a possible sidebar-search reinstatement, and kept
  // honest by the integration suite. Results carry the conversation
  // entry plus matchType/snippet, extended with sessionId/seq anchors
  // on content hits. Grep fallback covers runtimes without node:sqlite.
  (async () => {
    const query = (msg.query || '').toLowerCase().trim();
    if (!getWorkspace() || !query) {
      ws.send(JSON.stringify({ type: 'search_results', results: [], query: msg.query }));
      return;
    }
    const convos = readConversations();
    // First pass: title matches (instant)
    const titleMatches = convos.filter(c => (c.title || '').toLowerCase().includes(query)).map(c => ({ ...c, matchType: 'title' }));
    // Second pass: content matches (FTS index, or the legacy jsonl grep)
    let contentResults = [];
    const engine = ctx.store.ensureSearchEngine();
    if (engine) {
      try {
        ctx.store.reconcileSearchBeforeQuery();
        const byId = new Map(convos.map(c => [c.id, c]));
        // prefix keeps mid-word typing states matching, on par with
        // the old substring grep ("discoun" must find "discount").
        contentResults = engine.searchMessages(msg.query, { limit: 50, prefix: true })
          .filter(h => byId.has(h.conversationId))
          .map(h => ({
            ...byId.get(h.conversationId), matchType: 'content', snippet: h.snippet,
            sessionId: h.sessionId, seq: h.seq, matchCount: h.matchCount,
          }));
      } catch (e) {
        console.warn('[Search] FTS query failed, using grep fallback:', e.message);
        contentResults = await ctx.store.grepSearchTranscripts(msg.query, convos);
      }
    } else {
      contentResults = await ctx.store.grepSearchTranscripts(msg.query, convos);
    }
    // Merge: title matches first, then content-only matches (no duplicates)
    const titleIds = new Set(titleMatches.map(c => c.id));
    const merged = [...titleMatches, ...contentResults.filter(c => !titleIds.has(c.id))];
    ws.send(JSON.stringify({ type: 'search_results', results: merged.slice(0, 50), query: msg.query }));
  })().catch(err => {
    console.warn('[Search] Error:', err.message);
    ws.send(JSON.stringify({ type: 'search_results', results: [], query: msg.query }));
  });
}

function handleSearchUniversal(ctx, ws, msg) {
  // Cmd+K universal palette: one query across files,
  // conversations, agents, and skills, grouped by type.
  ctx.store.runUniversalSearch(msg).then(({ groups, recent }) => {
    ws.send(JSON.stringify({ type: 'search_universal_results', query: (msg.query || '').trim(), reqId: msg.reqId, groups, recent }));
  }).catch(err => {
    // Defensive backstop: each corpus inside runUniversalSearch catches
    // its own failures (degrading to partial results), so a rejection
    // here is unexpected. `error: true` lets the client distinguish a
    // genuine failure from a query with no hits.
    console.warn('[Search] universal error:', err && err.message ? err.message : err);
    ws.send(JSON.stringify({
      type: 'search_universal_results', query: (msg.query || '').trim(), reqId: msg.reqId,
      groups: { files: [], conversations: [], agents: [], skills: [] }, recent: false, error: true,
    }));
  });
}

// WHEN THE TRANSCRIPT BEGAN, known only when it opens with the person's own
// message. Rundock records a chat message (appendTranscript, server.js) before
// Claude Code is sent it, so no line Claude Code writes for that turn or any
// later one is stamped earlier. A transcript that opens with an agent turn was
// started by a prompt Rundock sent, which says nothing about what came before,
// so it claims no start. Milliseconds, or NaN when unknown: no time compares
// as earlier than NaN, so then nothing is taken for earlier history.
function transcriptStart(transcript) {
  const first = transcript[0];
  return first && first.role === 'user' ? Date.parse(first.timestamp) : NaN;
}

// History the session files alone hold, as bubbles, in the order given. Used
// for a conversation with no transcript at all, and for what a conversation
// said before its transcript began. An exact copy, the same words from the
// same side at the same moment, is shown once: a resumed session's new file
// can repeat the lines of the one before it. The person's own messages are
// also shown once per wording, as they always were here.
function sessionOnlyHistory(entries) {
  const seenLines = new Set();
  const seenUserMsgs = new Set();
  const out = [];
  for (const m of entries) {
    if (m.timestamp) {
      const line = `${m.role}\u0000${m.timestamp}\u0000${m.content}`;
      if (seenLines.has(line)) continue;
      seenLines.add(line);
    }
    if (m.role === 'user') {
      const key = m.content.substring(0, 200);
      if (seenUserMsgs.has(key)) continue;
      seenUserMsgs.add(key);
    }
    out.push({ role: m.role, content: m.content, agentId: null, timestamp: m.timestamp || null });
  }
  return out;
}

function handleGetSessionHistory(ctx, ws, msg) {
  const { sessionId, sessionIds, conversationId, limit, offset } = msg;

  // Multi-session merge: load JSONL content from all sessions, then use the
  // conversation transcript as the ordering and attribution authority.
  // The transcript records the correct interleaved order from live use;
  // JSONL sessions group messages per-process and can reorder across agents.
  if (sessionIds && sessionIds.length > 0) {
    Promise.all(sessionIds.map(async (s) => {
      const result = await ctx.store.parseSessionHistory(s.sessionId, 999, 0).catch(() => ({ messages: [] }));
      return result.messages;
    })).then(allSessions => {
      const transcript = loadTranscript(conversationId);

      // Build a pool of JSONL messages for content lookup
      // THE SHARED ONE. This was a regex that stopped at the first `]`, so a
      // command carrying a bracket left the rest of the summary in front of the
      // agent's words AND poisoned the prefix this rebuilder looks a turn up
      // by, which is why the lookup below failed and fell back to itself.
      const stripToolSummaries = (s) => stripToolSummaryPrefix(s).trim();
      const jsonlPool = [];
      for (const sessionMsgs of allSessions) {
        for (const m of sessionMsgs) {
          // Skip whitespace-only content. Without this filter, an entry
          // whose content is just a space character falsely matches any
          // cleanPrefix that contains a space (i.e. virtually all of
          // them), so real transcript text gets replaced by empty
          // bubbles. Whitespace entries are artifacts of tool-heavy
          // assistant turns where parseSessionHistory joined empty
          // `text` blocks into a single whitespace string.
          if (!m.content || !m.content.trim()) continue;
          // Skip Rundock's own lines: the prompts it sends agents, catch-up
          // headings and all, and the <silent> sentinel and resume ghosts on
          // the reply side. The one list the message counts use too.
          if (m.role === 'user' && isRundockPrompt(m.content)) continue;
          if (m.role === 'assistant' && isRundockReply(m.content)) continue;
          jsonlPool.push({ ...m, _used: false });
        }
      }

      // If we have a transcript, use it as the ordering authority
      const merged = [];
      if (transcript && transcript.length > 0) {
        // HISTORY FROM BEFORE THE TRANSCRIPT BEGAN. A conversation imported,
        // seeded, or older than transcripts has its earlier history in the
        // session files alone, and its first new message starts a transcript.
        // Matching only the transcript's turns left all of that out of view.
        // Lines stamped before the transcript began are set aside first, so a
        // turn the transcript records is never matched to an earlier line that
        // opens with the same words, and shown ahead of the transcript's turns.
        // What came after it began is still the transcript's to show: lines it
        // does not name, a delegate's brief or an orchestrator's <silent>, stay
        // hidden as before.
        //
        // In time order across files (a stable sort, so a file keeps its own
        // order). Read file by file, a specialist's replies land after
        // everything the orchestrator said, the ordering fault the transcript
        // was made the authority to end; before the transcript, time is what
        // orders them, and every line here has one.
        const start = transcriptStart(transcript);
        const before = jsonlPool.filter((m) => Date.parse(m.timestamp) < start)
          .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
        const earlier = new Set(before);
        const pool = jsonlPool.filter((m) => !earlier.has(m));
        merged.push(...sessionOnlyHistory(before));
        const seenUserMsgs = new Set();
        for (const t of transcript) {
          const role = t.role === 'user' ? 'user' : 'assistant';
          const tText = t.text || '';

          // Routing entries: orchestrator turn that was an immediate Agent-tool
          // call with no prose. Pass through with type so the client preserves
          // the agent change for divider rendering but skips the chat bubble.
          if (t.type === 'routing') {
            merged.push({ role: 'assistant', content: tText, agentId: t.agent || null, type: 'routing', timestamp: t.timestamp || null });
            continue;
          }

          if (role === 'user') {
            const key = tText.substring(0, 200);
            if (seenUserMsgs.has(key)) continue;
            seenUserMsgs.add(key);
            // Find matching JSONL entry for full content
            const match = pool.find(m => !m._used && m.role === 'user' &&
              m.content && m.content.substring(0, 200) === key);
            if (match) {
              match._used = true;
              merged.push({ role: 'user', content: match.content, agentId: null, timestamp: match.timestamp || t.timestamp || null });
            } else if (tText) {
              merged.push({ role: 'user', content: tText, agentId: null, timestamp: t.timestamp || null });
            }
          } else {
            // Agent message: match by content prefix (transcript stores ~200 chars)
            const cleanPrefix = stripToolSummaries(tText).substring(0, 100);
            if (!cleanPrefix) continue;
            const match = pool.find(m => !m._used && m.role === 'assistant' &&
              m.content && m.content.trim() && (
                m.content.substring(0, 100).includes(cleanPrefix.substring(0, 60)) ||
                cleanPrefix.includes(m.content.substring(0, 60))
              ));
            if (match) {
              match._used = true;
              // A transcript entry holds a whole agent TURN. The session file
              // splits that same turn into one entry per stretch of text
              // between tool calls, so a turn shaped text, tool, text, tool,
              // summary arrives here as several entries. Claiming one of them
              // per turn showed the opening stretch and silently dropped the
              // rest, which is why long working turns lost their closing
              // summary on reload while short ones were fine.
              //
              // Absorb the stretches that follow, but only while their opening
              // text is present in this turn's own transcript text. That check
              // is doing real work: a second agent replying straight after the
              // first, with no user message between, is ordinary, and without
              // it that reply would be swallowed into this bubble and
              // attributed to the wrong agent.
              // Walk FORWARD through the turn text rather than asking whether
              // each stretch appears anywhere in it. A plain containment test
              // would absorb a following agent's short reply whose opening
              // happens to repeat a phrase from earlier in this turn, which is
              // not far-fetched between agents that share a house style. Each
              // stretch must appear after the one before it, which is the only
              // arrangement the accumulator can actually have produced.
              const parts = [match.content];
              const turnText = stripToolSummaries(tText);
              // Advance past the WHOLE stretch, not merely the head matched on.
              // Advancing by the head alone leaves the rest of that stretch in
              // range, so a later stretch could match inside text already
              // claimed. The accumulator concatenates stretches verbatim, so
              // the whole of one is present at the position its head was found.
              const headOf = (m) => m.content.trim().substring(0, 60);
              const advance = (m, at) => at + m.content.trim().length;
              const firstAt = turnText.indexOf(headOf(match));
              let searchFrom = firstAt < 0 ? 0 : advance(match, firstAt);
              for (let k = pool.indexOf(match) + 1; k < pool.length; k += 1) {
                const next = pool[k];
                if (next.role === 'user' || next._used) break;
                const head = headOf(next);
                const at = head ? turnText.indexOf(head, searchFrom) : -1;
                if (at < 0) break;
                next._used = true;
                parts.push(next.content);
                searchFrom = advance(next, at);
              }
              merged.push({ role: 'assistant', content: parts.join('\n\n'), agentId: t.agent || null, timestamp: match.timestamp || t.timestamp || null });
            } else {
              // No JSONL match: use transcript text (may be truncated but better than dropping)
              const cleanText = stripToolSummaries(tText);
              if (cleanText) {
                merged.push({ role: 'assistant', content: cleanText, agentId: t.agent || null, timestamp: t.timestamp || null });
              }
            }
          }
        }
      } else {
        // No transcript: the session files are the whole history.
        merged.push(...sessionOnlyHistory(jsonlPool));
      }

      const total = merged.length;
      const lim = limit || 200;
      const off = offset || 0;
      const start = Math.max(0, total - lim - off);
      const end = Math.max(0, total - off);
      ws.send(JSON.stringify({
        type: 'session_history',
        conversationId,
        messages: merged.slice(start, end),
        totalCount: total,
        hasMore: start > 0
      }));
    }).catch(err => {
      console.warn('[Session history] Multi-session merge error:', err.message);
      ws.send(JSON.stringify({ type: 'session_history', conversationId, messages: [], totalCount: 0, hasMore: false }));
    });
  } else {
    // Fallback: single session (backward compatible)
    ctx.store.parseSessionHistory(sessionId, limit || 20, offset || 0).then(result => {
      ws.send(JSON.stringify({
        type: 'session_history',
        conversationId,
        messages: result.messages,
        totalCount: result.totalCount,
        hasMore: result.hasMore
      }));
    }).catch(err => {
      console.warn('[Session history] Parse error:', err.message);
      ws.send(JSON.stringify({ type: 'session_history', conversationId, messages: [], totalCount: 0, hasMore: false }));
    });
  }
}

module.exports = { handleSearchConversations, handleSearchUniversal, handleGetSessionHistory };
