'use strict';
// Per-conversation state machine for Rundock's client. Pure decision logic
// extracted from the WebSocket message handlers in app.js (process lifecycle,
// streaming, result finalisation, delegation) so it is unit-testable under
// node --test. Same UMD pattern as markers.js: loads as a classic script in
// the browser, requires directly in Node.
//
// reduce(state, message, ctx) -> { state, effects } where effects are
// declarative objects that app.js's glue executes 1:1 against the DOM and
// WebSocket. ctx carries read-only outside facts the decision needs
// (isActive, convoAgentId, toAgentType, delegationTriggered, ...). The
// reducer never touches the DOM: the streaming bubble element stays in
// app.js glue and is tracked here only as the boolean hasStreamingBubble.
//
// Attribution contract: effects representing lifecycle and delegation
// transitions (start-processing, finish-processing, show-delegation-divider,
// promote-handoff-message, finalize-agent-message) carry an `attribution`
// object { agentId, processId, timestamp } populated from the message's
// _agent/_processId/_timestamp when provided (null otherwise); a future
// decision ledger consumes the effect stream.
//
// Behaviour contract (pinned by test/unit/conversation-state.test.js):
//   - Stale-process gating: a message carrying a _processId that differs
//     from activeProcessId is dropped (drop-stale effect, no state change).
//   - system/done only finishes processing when the process ids match (or
//     either side has none); a mismatched done is suppressed.
//   - Streaming deltas always accumulate raw text; rendering effects are
//     emitted only when the conversation is active and the turn isn't
//     silent. The first delta of a turn starts the streaming bubble.
//   - The assistant message records latestText as the result-time fallback:
//     result text resolves as streamingRawText || result || latestText.
//   - Silent-park no-op turns (silentTurn flag or <silent> sentinel, and the
//     stripped text is under 10 chars or a stock acknowledgement) suppress
//     rendering entirely instead of finalising a message.
//   - agent_switch promotes any in-progress streamed text to a permanent
//     handoff message (markers stripped) before resetting streaming state.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./markers.js'));
  else root.RundockConversationState = factory(root.RundockMarkers);
}(typeof self !== 'undefined' ? self : this, function (RundockMarkers) {

  // Initial per-conversation reducer state. app.js keeps DOM-only fields
  // (currentStreamingMsg, processingTimeout, lastStreamActivity) alongside
  // these on the same object; reduce() carries unknown fields through
  // untouched.
  function createState() {
    return {
      isProcessing: false,
      hasStreamingBubble: false,
      latestText: '',
      streamingRawText: '',
      latestAgentId: null,
      activeProcessId: null,
      silentTurn: false,
      afterToolUse: false,
      activeAgentId: null,
      delegationActive: false,
    };
  }

  // Attribution payload for lifecycle/delegation effects (see header).
  function attribution(message) {
    return {
      agentId: message._agent !== undefined ? message._agent : null,
      processId: message._processId !== undefined ? message._processId : null,
      timestamp: message._timestamp !== undefined ? message._timestamp : null,
    };
  }

  // The activeProcessId acceptance rule: a message with no _processId is
  // never stale; otherwise it must match the active process (when one is
  // tracked). Exported so the glue can gate BEFORE its marker/WS side
  // effects, exactly where the old isStaleProcess check sat.
  function isStale(state, message) {
    if (!message._processId) return false;
    return !!(state.activeProcessId && message._processId !== state.activeProcessId);
  }

  function applyStartProcessing(next) {
    // Mirrors the state half of app.js startProcessing so the reducer's
    // returned state matches what the glue will hold after the effect runs.
    next.isProcessing = true;
    next.latestText = '';
    next.latestAgentId = null;
  }

  // Strip RUNDOCK markers from streaming display text so marker content
  // never leaks to the user mid-stream (complete blocks, standalone
  // markers, and a partial marker still streaming with no closing tag).
  function stripStreamingMarkers(text) {
    let displayText = text;
    displayText = displayText.replace(/<!--\s*RUNDOCK:[A-Z_]+ [^>]*-->\n?[\s\S]*?<!--\s*\/RUNDOCK:[A-Z_]+ -->/g, '');
    displayText = displayText.replace(/<!--\s*RUNDOCK:(?:DELETE_\w+ name=[\w-]+|RETURN)\s*-->/g, '');
    displayText = displayText.replace(/<!--\s*RUNDOCK:[\s\S]*$/g, '');
    return displayText;
  }

  function none(state) {
    return { state, effects: [] };
  }

  // ── system subtype reducers ───────────────────────────────────────────────

  function reduceProcessStarted(state, message) {
    if (!message._processId) return none(state);
    const next = { ...state, activeProcessId: message._processId, silentTurn: message.silent === true };
    // Stale permission cards from the previous process are removed on every
    // new process.
    const effects = [{ type: 'remove-permission-cards' }];
    // Auto-continue: orchestrator picking up after a specialist return.
    // Silent-park turns suppress all UI, including the thinking indicator.
    if (message.autoContinue && !next.silentTurn) {
      applyStartProcessing(next);
      effects.push({ type: 'start-processing', attribution: attribution(message) });
    }
    return { state: next, effects };
  }

  function reduceInit(state, message, ctx) {
    if (!message._sessionId || !ctx.convoExists) return none(state);
    const agentId = message._agent || ctx.convoAgentId;
    // Only the orchestrator's session becomes the primary sessionId (used
    // for --resume on reload); delegate sessions join the chain without
    // replacing it, unless no primary exists yet.
    const isOrchestrator = agentId === ctx.convoAgentId;
    const setPrimary = isOrchestrator || !ctx.hasPrimarySession;
    const addToChain = !(ctx.knownSessionIds || []).includes(message._sessionId);
    return {
      state,
      effects: [{ type: 'set-session', sessionId: message._sessionId, agentId, setPrimary, addToChain }],
    };
  }

  function reduceNotice(state, message) {
    // Neutral notice: informational pill with NO side effects (distinct
    // from 'info', which doubles as the stale-session signal).
    if (!message.content) return none(state);
    return { state, effects: [{ type: 'notice', content: message.content }] };
  }

  function reduceInfo(state, message, ctx) {
    if (!message.content) return none(state);
    const effects = [];
    // Stale session: the server is retrying fresh, so the stored primary
    // sessionId must be cleared.
    if (ctx.hasPrimarySession) effects.push({ type: 'clear-session' });
    effects.push({ type: 'notice', content: message.content });
    return { state, effects };
  }

  function reduceCancelled(state, message) {
    return {
      state,
      effects: [
        {
          type: 'add-cancelled-badge',
          toolCalls: message._toolCalls || [],
          turnStartTime: message._turnStartTime || null,
        },
        { type: 'notice', content: 'Agent stopped by user.' },
      ],
    };
  }

  function reduceDone(state, message) {
    // Only finish if this done event is from the currently active process.
    const match = !message._processId || !state.activeProcessId || message._processId === state.activeProcessId;
    if (!match) {
      return {
        state,
        effects: [{
          type: 'drop-stale',
          reason: 'stale-done',
          processId: message._processId,
          activeProcessId: state.activeProcessId,
        }],
      };
    }
    const next = { ...state, isProcessing: false, hasStreamingBubble: false };
    return { state: next, effects: [{ type: 'finish-processing', attribution: attribution(message) }] };
  }

  function reduceAgentSwitch(state, message, ctx) {
    const next = { ...state };
    const effects = [];
    // Capture the agent we're switching away from so the glue can clear its
    // working indicator (unless it's still legitimately working elsewhere,
    // which the glue checks against live cross-conversation state).
    const outgoingAgentId = state.activeAgentId || ctx.convoAgentId || null;
    next.delegationActive = !!(ctx.toAgentExists && ctx.toAgentType !== 'orchestrator');
    next.activeAgentId = message.toAgent;
    if (outgoingAgentId && outgoingAgentId !== message.toAgent) {
      effects.push({ type: 'clear-outgoing-working', outgoingAgentId });
    }
    // Finalise any in-progress orchestrator text before resetting streaming
    // state. Without this, the orchestrator's handoff message (e.g. "I'll
    // delegate this to Dev") is orphaned when the streaming bubble is reset
    // and the specialist's stream overwrites it. Markers are stripped from
    // the promoted text.
    if (state.streamingRawText) {
      let handoffText = RundockMarkers.stripDelegateTail(state.streamingRawText).trim();
      handoffText = RundockMarkers.stripMarkers(handoffText).trim();
      if (handoffText) {
        effects.push({
          type: 'promote-handoff-message',
          text: handoffText,
          agentId: outgoingAgentId,
          attribution: attribution(message),
        });
      }
    }
    // Reset streaming state so the new agent gets a fresh bubble.
    next.streamingRawText = '';
    next.latestText = '';
    next.latestAgentId = null;
    next.hasStreamingBubble = false;
    effects.push({ type: 'clear-streaming-bubble' });
    effects.push({ type: 'render-convo-list' });
    // A return goes back to the orchestrator; anything else is a forward
    // delegation (orchestrator->specialist or specialist->sub-specialist).
    const isReturn = ctx.toAgentType === 'orchestrator';
    if (ctx.isActive) {
      if (ctx.toAgentExists && ctx.fromAgentExists) {
        effects.push({
          type: 'show-delegation-divider',
          toAgentId: message.toAgent,
          fromAgentId: message.fromAgent,
          isReturn,
          attribution: attribution(message),
        });
      }
      if (ctx.toAgentExists) effects.push({ type: 'update-chat-header', toAgentId: message.toAgent });
    }
    // Show the delegate as working AFTER the divider is rendered.
    if (!isReturn && next.delegationActive) {
      applyStartProcessing(next);
      effects.push({ type: 'start-processing', attribution: attribution(message) });
    }
    return { state: next, effects };
  }

  function reduceSystem(state, message, ctx) {
    switch (message.subtype) {
      case 'process_started': return reduceProcessStarted(state, message);
      case 'init': return reduceInit(state, message, ctx);
      case 'notice': return reduceNotice(state, message);
      case 'info': return reduceInfo(state, message, ctx);
      case 'cancelled': return reduceCancelled(state, message);
      case 'done': return reduceDone(state, message);
      case 'agent_switch': return reduceAgentSwitch(state, message, ctx);
      default: return none(state);
    }
  }

  // ── streaming reducers ────────────────────────────────────────────────────

  function reduceStreamEvent(state, message, ctx) {
    const evt = message.event;
    if (!evt) return none(state);
    const next = { ...state };
    const effects = [];

    // Text streaming: always accumulate raw text, only render when active.
    if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta' && evt.delta.text) {
      let text = evt.delta.text;
      // Insert a newline between tool-use progress updates so they don't
      // run together.
      if (next.afterToolUse && next.streamingRawText && next.streamingRawText.length > 0) {
        text = '\n\n' + text;
      }
      next.afterToolUse = false;
      next.streamingRawText += text;
      if (ctx.isActive && !next.silentTurn) {
        if (!next.hasStreamingBubble) {
          next.hasStreamingBubble = true;
          effects.push({
            type: 'start-streaming-bubble',
            agentId: message._agent || next.activeAgentId || next.latestAgentId || null,
          });
        }
        // The glue re-renders the whole accumulated (marker-stripped) text
        // each delta, so the effect carries the full display text.
        effects.push({ type: 'render-stream-text', text: stripStreamingMarkers(next.streamingRawText) });
      }
    }

    // Tool use: surface the tool name on the thinking indicator when active,
    // and schedule a file-tree refresh for file-writing tools.
    if (evt.type === 'content_block_start' && evt.content_block && evt.content_block.type === 'tool_use') {
      next.afterToolUse = true;
      const toolName = evt.content_block.name || '';
      if (ctx.isActive && !next.silentTurn) {
        effects.push({
          type: 'ensure-tool-status',
          toolName,
          agentId: message._agent || next.activeAgentId || next.latestAgentId || null,
        });
      }
      if (/^(Write|Edit|Bash|NotebookEdit)/.test(toolName)) {
        effects.push({ type: 'schedule-file-refresh' });
      }
    }

    return { state: next, effects };
  }

  function reduceAssistant(state, message, ctx) {
    const msg = message.message;
    if (!msg || !msg.content) return none(state);
    const next = { ...state };
    const effects = [];
    for (const block of msg.content) {
      if (block.type === 'text' && block.text) {
        // Recorded as the result-time fallback: used only when no stream
        // deltas were seen (result text resolves streamingRawText first).
        next.latestText = block.text;
        next.latestAgentId = message._agent || null;
      } else if (block.type === 'tool_use') {
        if (ctx.isActive) effects.push({ type: 'update-tool-status', toolName: block.name });
      }
    }
    return { state: next, effects };
  }

  function reduceResult(state, message, ctx) {
    const agentId = message._agent || state.activeAgentId || state.latestAgentId || null;
    const delegationTriggered = !!ctx.delegationTriggered;

    // In stream-json mode the response text arrives via stream_event deltas
    // and 'result' is a completion signal: prefer the streamed text, then
    // the result field, then the assistant fallback.
    let responseText = state.streamingRawText || message.result || state.latestText || '';
    // Strip RUNDOCK markers from displayed text. DELEGATE strips the marker
    // block AND any text after it (the orchestrator should stop after
    // delegating).
    responseText = RundockMarkers.stripDelegateTail(responseText).trim();
    responseText = RundockMarkers.stripMarkers(responseText).trim();

    // Strip the silent-park sentinel and drop if the response is a no-op.
    // The no-op heuristic ONLY applies to turns that are actually
    // silent-park context: the server flagged the restart silent
    // (state.silentTurn) or the text carries the literal <silent> sentinel.
    // It must never apply to a normal turn: legitimate short answers
    // ("Forty.", "Ten.") are shorter than the 10-char threshold.
    const silentStripped = responseText.replace(/<silent>/gi, '').trim();
    const isParkContext = state.silentTurn || /<silent>/i.test(responseText);
    const isNoOp = isParkContext && (silentStripped.length < 10 || /^(No response requested\.|\.|OK|ok|Understood\.|Acknowledged\.)$/i.test(silentStripped));

    const next = {
      ...state,
      streamingRawText: '',
      latestText: '',
      latestAgentId: null,
      silentTurn: false,
      hasStreamingBubble: false,
    };
    const effects = [];

    if (isNoOp && responseText) {
      // Silent-park turn: remove any streaming bubble, reset state, skip
      // the render entirely.
      effects.push({ type: 'suppress-silent-park' });
      if (!delegationTriggered) {
        next.isProcessing = false;
        effects.push({ type: 'finish-processing', attribution: attribution(message) });
      }
      effects.push({ type: 'render-convo-list' });
      return { state: next, effects };
    }
    responseText = silentStripped;

    if (responseText && ctx.convoExists) {
      effects.push({
        type: 'finalize-agent-message',
        text: responseText,
        agentId,
        attribution: attribution(message),
      });
      // Mark unread when the user isn't viewing this conversation.
      if (ctx.convoInWorkspace && !ctx.viewingChat) effects.push({ type: 'mark-unread' });
    }

    if (ctx.isActive) {
      effects.push({ type: 'remove-thinking-indicator' });
      if (state.hasStreamingBubble) {
        // Text was already streamed in real time: final re-render with
        // complete markdown plus the activity summary.
        effects.push({
          type: 'finalize-stream-bubble',
          text: responseText,
          toolCalls: message._toolCalls || [],
          turnStartTime: message._turnStartTime || null,
        });
      } else if (responseText) {
        // No streaming happened (e.g. a very short response): render now.
        effects.push({
          type: 'append-final-message',
          text: responseText,
          agentId,
          toolCalls: message._toolCalls || [],
          turnStartTime: message._turnStartTime || null,
        });
      }
    }

    // Don't finish processing when the orchestrator just delegated: the
    // delegate is about to start.
    if (!delegationTriggered) {
      next.isProcessing = false;
      effects.push({ type: 'finish-processing', attribution: attribution(message) });
    }
    effects.push({ type: 'render-convo-list' });
    return { state: next, effects };
  }

  // ── entry point ───────────────────────────────────────────────────────────

  function reduce(state, message, ctx) {
    ctx = ctx || {};
    switch (message.type) {
      case 'system':
        return reduceSystem(state, message, ctx);
      case 'stream_event':
      case 'assistant':
      case 'result': {
        // Defence in depth: the glue gates stale messages before its own
        // side effects, but the reducer honours the same rule.
        if (isStale(state, message)) {
          return {
            state,
            effects: [{
              type: 'drop-stale',
              reason: 'stale-process',
              messageType: message.type,
              processId: message._processId,
              activeProcessId: state.activeProcessId,
            }],
          };
        }
        if (message.type === 'stream_event') return reduceStreamEvent(state, message, ctx);
        if (message.type === 'assistant') return reduceAssistant(state, message, ctx);
        return reduceResult(state, message, ctx);
      }
      default:
        return none(state);
    }
  }

  return { createState, reduce, isStale };
}));
