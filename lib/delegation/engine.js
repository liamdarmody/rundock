'use strict';
// Delegation / scope-return engine, extracted verbatim from server.js in
// slice 10 of the Foundations decomposition. The three engine functions
// (wireProcessHandlers, handleScopeReturn, handleDelegation) plus the
// end_delegation glue live here; the kill-window transition machine stays in
// the composition root and calls in through the injected deps (nothing moves
// out). Lib modules are required directly; root-owned live state and
// capabilities arrive once through createDelegationEngine(deps). Function
// declarations stay at column 0 so the coverage-area anchors and source-scan
// pins address them exactly as they did in the root.
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config.js');
const codexRuntime = require('../../codex.js');
const { resolveMarkers } = require('./markers.js');
const { createDelegationRecord, attachDelegationRecord } = require('./state.js');
const { discoverAgents } = require('../agents/discovery.js');
const { buildSystemPrompt, buildTeamRoster, findDirectReportMatch, findOffRosterWorkspaceMatch } = require('../agents/prompt.js');
const { buildToolSummary } = require('../store/transcripts.js');
const { readConversations } = require('../store/persistence.js');
const { recordEvent, bumpSkillUsage } = require('../signals.js');
const { spawnClaude, getSpawnEnv, getBareArgs, modelArgs, killProcessTree } = require('../runtime/claude.js');
const { startCodexTurn, wireCodexDelegate, readAgentInstructions } = require('../runtime/codex-glue.js');

// Root-owned capabilities, assigned once by createDelegationEngine. Module-
// scope bindings (not a deps.* indirection) keep the moved function bodies
// byte-identical to their server.js originals.
let chatProcesses;                    // identity: the live process map
let safeSend;                         // broadcast with reconnect buffering
let appendTranscript, formatTranscript, buildHandbackPayload;
let beginConvoTransition, endConvoTransition, scheduleScopeReturnKill, bufferedFollowUpTakesOver;
let incrementAutoResume, resetAutoResume, MAX_CONSECUTIVE_AGENT_RESUMES;
let getAllowedToolsInteractive, getDisallowedTools, getPermissionMode;
let handleChatSpawnError, isAuthError, isModelError, sendAuthError, sendModelError, isSilentParkResponse;
let noteClaudeAuthEvidence;           // marks Claude sign-in demonstrably working
let RESTORE_DELAY_MS;                 // test-only restore delay (env const)
let stopEntryProcess;                 // graceful entry kill (root process control)

const DEP_NAMES = [
  'MAX_CONSECUTIVE_AGENT_RESUMES', 'RESTORE_DELAY_MS', 'appendTranscript',
  'beginConvoTransition', 'bufferedFollowUpTakesOver', 'buildHandbackPayload',
  'endConvoTransition', 'formatTranscript', 'getAllowedToolsInteractive',
  'getDisallowedTools', 'getPermissionMode', 'handleChatSpawnError',
  'incrementAutoResume', 'isAuthError', 'isModelError', 'isSilentParkResponse',
  'noteClaudeAuthEvidence', 'processes', 'resetAutoResume', 'safeSend',
  'scheduleScopeReturnKill', 'sendAuthError', 'sendModelError',
  'stopEntryProcess',
];

// Composed ONCE by the server's composition root. The returned functions are
// the module's singletons, re-exported through _internal by identity.
function createDelegationEngine(deps) {
  const missing = DEP_NAMES.filter(n => !(n in deps));
  if (missing.length) throw new Error('createDelegationEngine: missing deps: ' + missing.join(', '));
  chatProcesses = deps.processes;
  safeSend = deps.safeSend;
  appendTranscript = deps.appendTranscript;
  formatTranscript = deps.formatTranscript;
  buildHandbackPayload = deps.buildHandbackPayload;
  beginConvoTransition = deps.beginConvoTransition;
  endConvoTransition = deps.endConvoTransition;
  scheduleScopeReturnKill = deps.scheduleScopeReturnKill;
  bufferedFollowUpTakesOver = deps.bufferedFollowUpTakesOver;
  incrementAutoResume = deps.incrementAutoResume;
  resetAutoResume = deps.resetAutoResume;
  MAX_CONSECUTIVE_AGENT_RESUMES = deps.MAX_CONSECUTIVE_AGENT_RESUMES;
  getAllowedToolsInteractive = deps.getAllowedToolsInteractive;
  getDisallowedTools = deps.getDisallowedTools;
  getPermissionMode = deps.getPermissionMode;
  handleChatSpawnError = deps.handleChatSpawnError;
  isAuthError = deps.isAuthError;
  isModelError = deps.isModelError;
  sendAuthError = deps.sendAuthError;
  sendModelError = deps.sendModelError;
  isSilentParkResponse = deps.isSilentParkResponse;
  noteClaudeAuthEvidence = deps.noteClaudeAuthEvidence;
  RESTORE_DELAY_MS = deps.RESTORE_DELAY_MS;
  stopEntryProcess = deps.stopEntryProcess;
  return { wireProcessHandlers, handleScopeReturn, handleDelegation, handleEndDelegation };
}

/**
 * Shared stdout/stderr handler for all Claude Code processes.
 * Consolidates JSONL parsing, metadata enrichment, session capture,
 * Agent tool interception, response text accumulation, and result handling.
 *
 * @param {object} entry - Process entry (must have: process, buffer, processId, agentId, responseText, exited, pendingAgentTools)
 * @param {string} convoId - Conversation ID
 * @param {object} ws - WebSocket connection (unused, kept for signature compatibility)
 * @param {object} options
 * @param {boolean} options.enableInterception - Whether to intercept Agent tool calls targeting direct reports
 * @param {function} options.onResult - Callback(entry, parsed) when a 'result' message is received
 * @returns {{ value: string }} - Mutable stderr buffer reference
 */
function wireProcessHandlers(entry, convoId, ws, options = {}) {
  const { enableInterception = false, onResult } = options;

  entry.process.stdout.on('data', (chunk) => {
    if (entry.exited) return; // P0: guard against data after SIGKILL
    entry.buffer += chunk.toString();
    const lines = entry.buffer.split('\n');
    entry.buffer = lines.pop();
    for (const line of lines) {
      if (entry.exited) break; // per-line guard: stop once a mid-chunk kill sets exited
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        parsed._agent = entry.agentId;
        parsed._conversationId = convoId;
        parsed._processId = entry.processId;

        // Capture session ID from init message
        if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
          entry.sessionId = parsed.session_id;
          parsed._sessionId = parsed.session_id;
        }

        // ── Agent tool interception: collection ──
        // Blocks are only COLLECTED as they stream. The interception decision
        // waits for the end-of-message `assistant` envelope, because a turn
        // can emit several Agent calls: acting (and SIGKILLing) on the first
        // block's stop meant blocks 2..N were never even parsed, so the
        // engine silently discarded them with no log and no event. Deferring
        // to message end sees the whole turn. The cost is a few milliseconds
        // in which the runtime may begin its own generic subagent for the
        // call; killProcessTree takes that subagent down with its parent
        // before it can act, so nothing observable escapes.
        if (enableInterception) {
          const evt = parsed.type === 'stream_event' ? parsed.event : null;
          if (evt) {
            if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use' && evt.content_block?.name === 'Agent') {
              if (!entry.pendingAgentTools) entry.pendingAgentTools = [];
              entry.pendingAgentTools.push({ blockIndex: evt.index, inputJson: '', complete: false });
            }
            if (entry.pendingAgentTools && evt.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta') {
              const block = entry.pendingAgentTools.find(b => b.blockIndex === evt.index && !b.complete);
              if (block) block.inputJson += evt.delta.partial_json;
            }
            if (entry.pendingAgentTools && evt.type === 'content_block_stop') {
              const block = entry.pendingAgentTools.find(b => b.blockIndex === evt.index && !b.complete);
              if (block) block.complete = true;
            }
          }
        }

        // Track tool calls for activity summary and transcript
        if (parsed.type === 'stream_event' && parsed.event?.type === 'content_block_start' && parsed.event?.content_block?.type === 'tool_use') {
          const toolName = parsed.event.content_block.name;
          entry.toolCalls.push({ tool: toolName, time: Date.now(), arg: null });
          // Track input JSON for known tools to extract first argument
          if (/^(Read|Edit|Write|Glob|Grep|Bash|PowerShell|WebFetch|WebSearch)$/.test(toolName)) {
            entry._pendingToolArg = { blockIndex: parsed.event.index, inputJson: '' };
          }
          // Signal layer: Skill invocations get their own tracker (separate
          // from _pendingToolArg so the two can never interfere) because the
          // slug feeds the turn event and the usage sidecar. Claude runtime
          // only by nature: Codex agents receive skills in their instruction
          // body, so there is no tool call to observe there.
          if (toolName === 'Skill') {
            entry._pendingSkillArg = { blockIndex: parsed.event.index, inputJson: '' };
          }
        }
        if (entry._pendingSkillArg && parsed.type === 'stream_event' && parsed.event?.type === 'content_block_delta' && parsed.event?.index === entry._pendingSkillArg.blockIndex && parsed.event?.delta?.type === 'input_json_delta') {
          entry._pendingSkillArg.inputJson += parsed.event.delta.partial_json;
        }
        if (entry._pendingSkillArg && parsed.type === 'stream_event' && parsed.event?.type === 'content_block_stop' && parsed.event?.index === entry._pendingSkillArg.blockIndex) {
          try {
            const input = JSON.parse(entry._pendingSkillArg.inputJson);
            const slug = input.skill || input.name || null;
            if (slug) {
              const lastSkillCall = [...entry.toolCalls].reverse().find(t => t.tool === 'Skill' && !t.arg);
              if (lastSkillCall) lastSkillCall.arg = slug;
              bumpSkillUsage(slug);
            }
          } catch (e) { /* partial input: no slug, no count */ }
          entry._pendingSkillArg = null;
        }
        if (entry._pendingToolArg && parsed.type === 'stream_event' && parsed.event?.type === 'content_block_delta' && parsed.event?.index === entry._pendingToolArg.blockIndex && parsed.event?.delta?.type === 'input_json_delta') {
          entry._pendingToolArg.inputJson += parsed.event.delta.partial_json;
        }
        if (entry._pendingToolArg && parsed.type === 'stream_event' && parsed.event?.type === 'content_block_stop' && parsed.event?.index === entry._pendingToolArg.blockIndex) {
          try {
            const input = JSON.parse(entry._pendingToolArg.inputJson);
            const last = entry.toolCalls[entry.toolCalls.length - 1];
            if (last) {
              last.arg = input.file_path || input.path || input.pattern || input.query || input.url
                || (input.command ? input.command.substring(0, 60) : null);
            }
            // A backgrounded command outlives the turn that started it, and it
            // is the one kind of work that never appears in this stream again.
            // Remember it so the idle reaper leaves this conversation alone:
            // the turn ends, the entry looks idle, and killing it would take
            // the job with it while the user waits for exactly that result.
            if (input.run_in_background === true) entry.startedBackgroundTask = true;
          } catch (e) {}
          entry._pendingToolArg = null;
        }

        // Accumulate response text. The partial-message delta stream is the
        // authoritative source for the turn's text (a marker streamed in
        // an earlier block must survive, so we never overwrite). The consolidated
        // `assistant` message is only a fallback for a turn that produced NO
        // deltas. Appending its blocks when deltas already ran double-counts a
        // multi-text-block message: the delta stream concatenates the blocks
        // ("AB") while the assistant message keeps them separate, and the old
        // per-block endsWith check then appended A then B -> "ABAB". Reset
        // per turn in the result handler below.
        if (parsed.type === 'stream_event' && parsed.event?.type === 'content_block_delta' && parsed.event?.delta?.type === 'text_delta' && parsed.event.delta.text) {
          entry.responseText += parsed.event.delta.text;
          entry.sawTextDelta = true;
        } else if (parsed.type === 'assistant' && parsed.message?.content && !entry.sawTextDelta) {
          for (const block of parsed.message.content) {
            if (block.type === 'text' && block.text) {
              entry.responseText += block.text;
            }
          }
        }

        // ── Agent tool interception: decision ──
        // Runs at end of message with every Agent block of the turn
        // collected (see the collection block above), and AFTER text
        // accumulation so the transcript entry written below carries the
        // turn's full prose.
        //
        // The trigger is the message_stop stream event, with the result
        // envelope as a belt-and-braces fallback for any stream shape that
        // ends a turn without one. It is NEVER the consolidated `assistant`
        // envelope: the real interactive stream emits that envelope PER
        // BLOCK, mid-message, BEFORE the block's content_block_stop
        // (captured from a live CLI stream, v2.1.226, 2026-08-12). The
        // 0.11.6 regression anchored the decision there: on real streams it
        // fired while the Agent block was still incomplete, skipped it,
        // cleared the collection, and every real delegation fell through to
        // the runtime's native subagent, which then did teammate-shaped
        // work invisibly while the caller narrated an invented success. The
        // stub-shaped suite stayed green throughout because the stub only
        // emitted the envelope at end of message. The stub now emits the
        // real end-of-message events (message_delta + message_stop) and a
        // realStream rule mode pins the exact production shape.
        const messageEnded = (parsed.type === 'stream_event' && parsed.event?.type === 'message_stop')
          || parsed.type === 'result';
        if (enableInterception && messageEnded && entry.pendingAgentTools && entry.pendingAgentTools.length) {
          const agentCalls = [];
          for (const block of entry.pendingAgentTools) {
            if (!block.complete) continue; // never closed: stream ended mid-block
            try {
              agentCalls.push(JSON.parse(block.inputJson));
            } catch (e) {
              console.log(`[AgentIntercept] convo=${convoId} failed to parse Agent tool input: ${e.message}`);
              recordEvent('marker_error', { conv: convoId, agent: entry.agentId, d: { kind: 'agent_tool_input' } });
            }
          }
          entry.pendingAgentTools = null;

          // First call naming a direct report wins; delegation is sequential.
          // The REMAINING calls are recorded and named back to the caller on
          // handback so it can sequence them: an honest queue, never a
          // silent drop. Actual concurrent execution is a separate card.
          let target = null, targetInput = null;
          const deferredTargets = [];
          for (const input of agentCalls) {
            const match = findDirectReportMatch(entry.agentId, input);
            if (!target && match) {
              target = match; targetInput = input;
              continue;
            }
            // Every other call in the turn dies with the kill below, whether
            // it names a direct report or a built-in subagent type, so every
            // one of them is named back.
            deferredTargets.push(match ? match.name : (input.subagent_type || 'an unnamed target'));
          }

          if (target) {
            console.log(`[AgentIntercept] convo=${convoId} agent=${entry.agentId} intercepting Agent tool call targeting: ${target.name}${deferredTargets.length ? ` (deferring: ${deferredTargets.join(', ')})` : ''}`);
            // Save orchestrator's response to transcript before killing the process.
            // The result event won't fire after SIGKILL so we must persist here.
            // With prose: append the prose (with tools prefix) as a regular agent
            // entry so it renders in the chat and survives navigate-away/back.
            // Without prose: still append a routing-typed entry so the orchestrator's
            // turn is recorded in the transcript (otherwise the turn is invisible
            // on rehydrate). The renderer skips routing entries from chat bubbles.
            if (entry.responseText) {
              const toolSummary = buildToolSummary(entry.toolCalls);
              const textWithTools = toolSummary ? toolSummary + '\n' + entry.responseText : entry.responseText;
              appendTranscript(convoId, 'agent', entry.agentId, textWithTools, undefined, entry);
            } else {
              const toolSummary = buildToolSummary(entry.toolCalls);
              appendTranscript(convoId, 'agent', entry.agentId, toolSummary, 'routing', entry);
            }
            try { killProcessTree(entry.process, 'SIGKILL'); } catch (e) {}
            entry.exited = true;
            // Order matters: handleDelegation sends agent_switch synchronously,
            // which the client uses to promote the orchestrator's streaming
            // bubble (state.currentStreamingMsg) into a permanent message.
            // If 'done' fires first, finishProcessing nulls currentStreamingMsg
            // and the handoff text is orphaned. Send 'done' AFTER handleDelegation
            // so agent_switch (and the specialist's process_started, also sent
            // inside handleDelegation) reach the client first. By then
            // activeProcessId points at the specialist, so the orchestrator's
            // 'done' fails the process-id match in finishProcessing: exactly
            // what we want: the orchestrator's working indicator clears via
            // agent_switch, not via 'done'.
            handleDelegation({
              type: 'delegate', conversationId: convoId,
              targetAgent: target.name,
              context: targetInput.prompt || targetInput.description || 'Handle this request.',
              _intercepted: true, _parentSessionId: entry.sessionId, _parentAgentId: entry.agentId,
              _deferredTargets: deferredTargets.length ? deferredTargets : null
            }, chatProcesses);
            safeSend(JSON.stringify({ type: 'system', subtype: 'done', code: 0, _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId }));
            continue; // suppress this end-of-message envelope: agent_switch owns the client handoff
          }

          // Impersonation guard: an explicit subagent_type naming a
          // workspace agent OUTSIDE this caller's direct reports must
          // not fall through, or Claude Code spawns a generic subagent
          // wearing that agent's name (for runtime: codex agents this
          // silently bypasses the user's runtime choice). Soft block:
          // kill the turn and resume the caller with a corrective
          // message so it recovers in-conversation.
          // KNOWN LIMITATION: without a captured sessionId the caller cannot be resumed, so the block does not fire and the call falls through (pre-fix behavior). In practice init always precedes tool_use, so sessionId is present. Narrow.
          const offInput = entry.sessionId ? agentCalls.find(input => findOffRosterWorkspaceMatch(entry.agentId, input)) : null;
          const offRoster = offInput ? findOffRosterWorkspaceMatch(entry.agentId, offInput) : null;
          if (offRoster) {
            console.log(`[AgentIntercept] convo=${convoId} agent=${entry.agentId} blocking off-roster Agent tool target: ${offRoster.name}`);
            recordEvent('delegation_error', { conv: convoId, agent: entry.agentId, d: { reason: 'off_roster_blocked' } });
            if (entry.responseText) {
              const toolSummary = buildToolSummary(entry.toolCalls);
              const textWithTools = toolSummary ? toolSummary + '\n' + entry.responseText : entry.responseText;
              appendTranscript(convoId, 'agent', entry.agentId, textWithTools, undefined, entry);
            } else {
              appendTranscript(convoId, 'agent', entry.agentId, buildToolSummary(entry.toolCalls), 'routing', entry);
            }
            try { killProcessTree(entry.process, 'SIGKILL'); } catch (e) {}
            entry.exited = true;
            const offName = offRoster.displayName || offRoster.name;
            safeSend(JSON.stringify({ type: 'system', subtype: 'info', content: `Blocked a handoff to ${offName}: not one of this agent's direct reports.`, _conversationId: convoId }));
            const blockedEntry = spawnResumedProcess(convoId, entry.agentId, entry.sessionId, chatProcesses, {});
            blockedEntry.idle = false; blockedEntry.idleSince = null;
            safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: blockedEntry.processId, _agent: entry.agentId, autoContinue: true }));
            const runtimeNote = offRoster.runtime === 'codex' ? ` ${offName} runs on a different runtime (Codex), which only their own leader can start.` : '';
            const blockPrompt = `[SYSTEM: delegation-blocked] Your Agent tool call named "${offName}" (${offRoster.name}), a workspace agent who is not one of your direct reports, so it was NOT run. No subagent may act as ${offName}.${runtimeNote} Do not retry the same call. If the task needs ${offName}, tell the user this needs routing through ${offName}'s leader and hand back. Otherwise continue without them.`;
            blockedEntry.process.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: blockPrompt } }) + '\n');
            continue;
          }
        }

        // Result handling
        if (parsed.type === 'result') {
          entry.resultSent = true;
          // Surface a recovery card when the turn failed on an expired auth session.
          if (parsed.is_error && isAuthError(JSON.stringify(parsed))) {
            sendAuthError(entry, convoId);
          } else if (parsed.is_error && isModelError(JSON.stringify(parsed))) {
            sendModelError(entry, convoId);
          } else if (!parsed.is_error) {
            // A successful turn is proof of a working sign-in (runtime status).
            noteClaudeAuthEvidence(); // root-owned runtime-status evidence
          }
          // Attach server-tracked tool calls for activity summary
          parsed._toolCalls = entry.toolCalls || [];
          parsed._turnStartTime = entry.turnStartTime || null;
          safeSend(JSON.stringify(parsed));
          safeSend(JSON.stringify({ type: 'system', subtype: 'done', code: 0, _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId }));
          if (onResult) onResult(entry, parsed);
          entry.sawTextDelta = false; // turn boundary: next turn re-decides delta vs assistant
          entry.pendingAgentTools = null; // turn boundary: stale collected blocks never leak across turns
        } else {
          safeSend(JSON.stringify(parsed));
        }
      } catch (e) {
        safeSend(JSON.stringify({ type: 'raw', content: line, _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId }));
      }
    }
  });

  const stderrBuf = { value: '' };
  entry.process.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrBuf.value += text;
    if (text.includes('no stdin data') || text.includes('proceeding without')) return;
    // Expired Claude Code session: show the recovery card, not the raw 401 blob.
    // Reset the buffer after a match so the accumulated signature does not
    // short-circuit every later, unrelated stderr chunk. The card stays
    // single via the authErrorSent/modelErrorSent guards.
    // KNOWN LIMITATION: later stderr chunks after the recovery card can still forward. Cosmetic.
    if (isAuthError(stderrBuf.value)) { sendAuthError(entry, convoId); stderrBuf.value = ''; return; }
    if (isModelError(stderrBuf.value)) { sendModelError(entry, convoId); stderrBuf.value = ''; return; }
    safeSend(JSON.stringify({ type: 'error', content: text, _conversationId: convoId, _processId: entry.processId }));
  });

  return stderrBuf;
}

// ── SCOPE RETURN: specialist hands off to orchestrator ──
// Called when a specialist emits a handoff marker (<!-- RUNDOCK:RETURN --> for out-of-scope,
// <!-- RUNDOCK:COMPLETE --> for pipeline-complete). Two flavours:
//   - Out-of-scope return (default): the specialist is handing back mid-task because the user
//     asked for something outside its domain. We tag the new orchestrator entry with
//     scopeReturnSource so the immediate-reuse guard in handleDelegation blocks the orchestrator
//     from routing the very next user message straight back to the same specialist.
//   - Pipeline-complete return (wasPipelineComplete=true): the specialist finished its delegated
//     work cleanly and is handing back control with nothing outstanding. In that case the user's
//     next message is a fresh request and the orchestrator must be free to route it anywhere,
//     including back to the same specialist. Do not tag scopeReturnSource.
function handleScopeReturn(specialistEntry, convoId, wasPipelineComplete = false) {
  const agentList = discoverAgents();
  const orchestrator = agentList.find(a => a.type === 'orchestrator');

  if (!orchestrator || !orchestrator.fileName) {
    console.warn(`[ScopeReturn] convo=${convoId} no orchestrator found, cannot route`);
    chatProcesses.delete(convoId);
    safeSend(JSON.stringify({ type: 'system', subtype: 'done', code: 0,
      _agent: specialistEntry.agentId, _conversationId: convoId,
      _processId: specialistEntry.processId }));
    // Close any kill-window transition (replays buffer into a fresh spawn).
    endConvoTransition(convoId, specialistEntry);
    return;
  }

  const processId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const systemPrompt = buildSystemPrompt(orchestrator);

  const disallowed = getDisallowedTools();
  const permMode = getPermissionMode();
  const args = [...getBareArgs(), ...modelArgs(orchestrator), '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--permission-mode', permMode,
    '--allowed-tools', getAllowedToolsInteractive(),
    ...(disallowed ? ['--disallowed-tools', disallowed] : []),
    '--append-system-prompt', systemPrompt,
    '--agent', orchestrator.name];

  console.log(`[ScopeReturn] convo=${convoId} from=${specialistEntry.agentId} to=${orchestrator.id} proc=${processId}`);

  const proc = spawnClaude(args, {
    cwd: config.getWorkspace(),
    env: getSpawnEnv(convoId),
    stdio: ['pipe', 'pipe', 'pipe']
  }, (err) => handleChatSpawnError(err, convoId));

  recordEvent('handback', {
    conv: convoId, agent: specialistEntry.agentId, runtime: specialistEntry.runtime || 'claude',
    d: { kind: wasPipelineComplete ? 'complete' : 'return', to: orchestrator.id },
  });
  const orchEntry = {
    process: proc, buffer: '', processId, agentId: orchestrator.id,
    responseText: '', exited: false, resultSent: false,
    lastUserMessage: specialistEntry.lastUserMessage,
    pendingAgentTools: null,
    toolCalls: [], turnStartTime: Date.now()
  };
  attachDelegationRecord(orchEntry, createDelegationRecord({
    scopeReturnSource: wasPipelineComplete ? null : specialistEntry.agentId
  }));
  chatProcesses.set(convoId, orchEntry);

  // Notify client of agent switch
  safeSend(JSON.stringify({
    type: 'system', subtype: 'agent_switch', _conversationId: convoId,
    _processId: processId,
    fromAgent: specialistEntry.agentId, toAgent: orchestrator.id
  }));
  safeSend(JSON.stringify({ type: 'system', subtype: 'process_started',
    _conversationId: convoId, _processId: processId, _agent: orchestrator.id, autoContinue: true,
    ...(wasPipelineComplete ? { silent: true } : {}) }));

  // A chat message buffered during the kill/restore window supersedes the
  // out-of-scope routing prompt: the user has spoken, so the fresh
  // orchestrator parks idle and the replay (endConvoTransition below)
  // drives it instead. Same rule as the three finishDelegateClose gates;
  // without it the replayed message queues BEHIND the routing prompt and
  // dies unread in stdin when that prompt re-delegates (interception
  // SIGKILLs the orchestrator). The pipeline-complete prompt is not gated:
  // it only parks the orchestrator silently, never re-delegates, so the
  // replay queues safely behind it (matching the delegate COMPLETE paths).
  if (!wasPipelineComplete && bufferedFollowUpTakesOver(convoId, orchEntry, 'scope-return routing prompt')) {
    // parked by the gate; the replayed message drives the orchestrator
  } else {
    // Circuit breaker: check consecutive auto-resume count before sending prompt.
    // COMPLETE paths are low-risk (orchestrator goes silent) but still count.
    const resumeCount = incrementAutoResume(convoId);
    if (resumeCount >= MAX_CONSECUTIVE_AGENT_RESUMES) {
      console.log(`[CircuitBreaker] convo=${convoId} ${resumeCount} consecutive agent resumes in handleScopeReturn, pausing orchestrator`);
          recordEvent('circuit_breaker', { conv: convoId, d: { count: resumeCount } });
      resetAutoResume(convoId);
      orchEntry.idle = true; orchEntry.idleSince = Date.now();
      safeSend(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: `[Auto-paused: ${resumeCount} consecutive agent handoffs without user input. Last specialist: ${specialistEntry.agentId}. Please review the output above and send your next message to continue.]` }, _agent: orchestrator.id, _conversationId: convoId }));
    } else {
      // Build context for orchestrator. Both shapes inject the specialist's final output
      // so the orchestrator has visibility into what was delivered. Without this, the
      // orchestrator's JSONL only contains its own pre-delegation state and it has to
      // guess or re-read files to know what the specialist did.
      const specialistOutput = buildHandbackPayload(specialistEntry, convoId);
      const outputBlock = specialistOutput
        ? `\n\n--- ${specialistEntry.agentId} ---\n${specialistOutput}\n---`
        : '';
      let prompt;
      if (wasPipelineComplete) {
        prompt = `[SYSTEM: pipeline-complete] ${specialistEntry.agentId} has finished the delegated work. Here is their final message to the conversation:${outputBlock}\n\nYour output for this turn MUST be exactly the literal string <silent> and nothing else. Do not narrate, summarise, or quote the specialist's output. Do not invoke any tools. Do not emit any other text. Just output <silent> and stop.`;
      } else {
        const pendingRequest = specialistEntry.lastUserMessage || '';
        prompt = `[SYSTEM: routing-request] ${specialistEntry.agentId} returned because the request was outside their scope. Here is what they said:${outputBlock}\n\nThe user's latest request was: "${pendingRequest}". Respond with full awareness of what ${specialistEntry.agentId} delivered. Do not re-delegate work already done. Route to the right specialist using the Agent tool.`;
      }

      proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
    }
  }

  wireProcessHandlers(orchEntry, convoId, null, {
    enableInterception: true,
    onResult: (e) => {
      // Filter silent-park responses: strip sentinel and suppress near-empty/no-op output
      if (e.responseText && !isSilentParkResponse(e.responseText)) {
        const toolSummary = buildToolSummary(e.toolCalls);
        const textWithTools = toolSummary ? toolSummary + '\n' + e.responseText : e.responseText;
        appendTranscript(convoId, 'agent', e.agentId, textWithTools, undefined, e);
      }
      e.responseText = '';
      e.idle = true; e.idleSince = Date.now();
    }
  });

  proc.on('close', (orchCode) => {
    if (orchEntry.spawnFailed) return; // error handler already surfaced
    orchEntry.exited = true;
    const current = chatProcesses.get(convoId);
    if (current === orchEntry) chatProcesses.delete(convoId);
    if (!orchEntry.resultSent) {
      safeSend(JSON.stringify({ type: 'system', subtype: 'done', code: orchCode,
        _agent: orchEntry.agentId, _conversationId: convoId, _processId: processId }));
    }
  });

  // Send done for the specialist that triggered the scope return
  safeSend(JSON.stringify({ type: 'system', subtype: 'done', code: 0,
    _agent: specialistEntry.agentId, _conversationId: convoId,
    _processId: specialistEntry.processId }));

  // The orchestrator is live: close any kill-window transition opened when
  // the specialist's auto-return kill fired, replaying buffered messages.
  endConvoTransition(convoId, specialistEntry);
}

// Respawn an orchestrator/parent with --resume as an idle, live process wired
// with the standard scope-return handlers. Used to keep a live process around
// after the loop guard blocks an immediate re-delegation: interception
// already SIGKILLed the orchestrator, so without this the turn is dropped and
// no process remains for the user to continue. The process idles waiting for
// the user's next stdin message (no prompt is written here).
function spawnResumedProcess(convoId, agentId, sessionId, processes, opts = {}) {
  const agentList = discoverAgents();
  const agentData = agentList.find(a => a.id === agentId || a.name === agentId);
  const systemPrompt = agentData ? buildSystemPrompt(agentData) : '';
  const disallowed = getDisallowedTools();
  const permMode = getPermissionMode();
  const args = [...getBareArgs(), ...modelArgs(agentData), '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--permission-mode', permMode,
    '--allowed-tools', getAllowedToolsInteractive(),
    ...(disallowed ? ['--disallowed-tools', disallowed] : [])];
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  if (agentData?.name) args.push('--agent', agentData.name);
  if (sessionId) args.push('--resume', sessionId);

  const processId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const proc = spawnClaude(args, { cwd: config.getWorkspace(), env: getSpawnEnv(convoId), stdio: ['pipe', 'pipe', 'pipe'] }, (err) => handleChatSpawnError(err, convoId));
  const entry = {
    process: proc, buffer: '', processId, agentId,
    responseText: '', exited: false, resultSent: false,
    pendingAgentTools: null, toolCalls: [], turnStartTime: Date.now(),
    idle: true,
    handbackAt: Date.now(), // stale end_delegation guard
  };
  // A respawned agent can hand back via its scope-return close path, so it
  // carries a delegation record like a delegate does.
  attachDelegationRecord(entry, createDelegationRecord({
    scopeReturnSource: opts.scopeReturnSource || null
  }));
  processes.set(convoId, entry);

  wireProcessHandlers(entry, convoId, null, {
    enableInterception: true,
    onResult: (e) => {
      const { hasReturn: hasOutOfScope, hasComplete } = resolveMarkers(e.responseText);
      // KNOWN LIMITATION: a respawned orchestrator that emits its own RETURN/COMPLETE marker here is self-treated as a scope-return. Low/narrow.
      if ((hasOutOfScope || hasComplete) && !e.delegation) {
        e.scopeReturn = true;
        e.scopeReturnMode = hasComplete ? 'complete' : 'return';
        scheduleScopeReturnKill(e, convoId); // follow-up in-window cancels; post-kill messages buffer
      }
      if (e.responseText && !isSilentParkResponse(e.responseText)) {
        const toolSummary = buildToolSummary(e.toolCalls);
        const textWithTools = toolSummary ? toolSummary + '\n' + e.responseText : e.responseText;
        appendTranscript(convoId, 'agent', e.agentId, textWithTools, undefined, e);
        if (e.deliveredTurns) e.deliveredTurns.push(e.responseText);
      }
      e.finalResponseText = e.responseText;
      e.responseText = '';
      e.idle = true; e.idleSince = Date.now();
    }
  });
  proc.on('close', (rCode) => {
    if (entry.spawnFailed) return;
    entry.exited = true;
    const cur = processes.get(convoId);
    if (entry.scopeReturn && cur === entry) {
      handleScopeReturn(entry, convoId, entry.scopeReturnMode === 'complete');
      return;
    }
    if (cur === entry) {
      processes.delete(convoId);
      endConvoTransition(convoId, entry); // replay buffered messages into a fresh spawn
    }
    safeSend(JSON.stringify({ type: 'system', subtype: 'done', code: rCode, _agent: entry.agentId, _conversationId: convoId, _processId: processId }));
  });
  return entry;
}

// ── DELEGATION HANDLER (standalone, no WebSocket dependency) ──
function handleDelegation(msg, processes) {
  const convoId = msg.conversationId;
  const existing = processes.get(convoId);
  const isIntercepted = !!msg._intercepted;

  // For intercepted Agent tool calls, the parent is already killed
  if (!isIntercepted && (!existing || existing.exited)) {
    safeSend(JSON.stringify({ type: 'system', subtype: 'delegation_error', content: 'No active process to delegate from', _conversationId: convoId }));
    return;
  }

  const agentList = discoverAgents();
  const targetAgent = agentList.find(a => a.id === msg.targetAgent || a.name === msg.targetAgent)
    || agentList.find(a => a.displayName && a.displayName.toLowerCase() === String(msg.targetAgent).toLowerCase());
  if (!targetAgent || !targetAgent.fileName) {
    safeSend(JSON.stringify({ type: 'system', subtype: 'delegation_error', content: `Agent "${msg.targetAgent}" not found`, _conversationId: convoId }));
    return;
  }

  // Prevent duplicate delegation: if the target agent is already the active process (e.g. Agent tool
  // interception already spawned the delegate, then the DELEGATE marker triggers a second attempt)
  const currentEntry = processes.get(convoId);
  if (currentEntry && currentEntry.agentId === (targetAgent.id || targetAgent.name) && !currentEntry.exited) {
    console.log(`[Delegate] convo=${convoId} skipping duplicate delegation to ${targetAgent.id || targetAgent.name} (already active)`);
    return;
  }

  // Prevent immediate re-delegation to the specialist that just scope-returned
  if (existing && existing.scopeReturnSource === targetAgent.id) {
    recordEvent('delegation_error', { conv: convoId, agent: existing.agentId, d: { reason: 'loop_guard' } });
    console.log(`[ScopeReturn] convo=${convoId} preventing loop: ${targetAgent.id} just scope-returned`);
    const displayName = targetAgent.displayName || targetAgent.name;
    const orchestratorAgentId = isIntercepted ? (msg._parentAgentId || existing.agentId) : existing.agentId;
    // On an intercepted re-target the orchestrator was already SIGKILLed,
    // so blocking here would drop the turn and leave no live process. Respawn
    // the orchestrator idle (via --resume) so the user can continue; otherwise
    // just clear the flag on the still-live process.
    if (existing.exited && isIntercepted && msg._parentSessionId) {
      spawnResumedProcess(convoId, orchestratorAgentId, msg._parentSessionId, processes, { scopeReturnSource: null });
    } else {
      // KNOWN LIMITATION: when _parentSessionId is missing on an intercepted, already-killed orchestrator, it is not respawned (degrades to clearing the flag on a dead process). Narrow.
      existing.scopeReturnSource = null;
    }
    safeSend(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: `${displayName} has already completed this task. Send your next message to continue.` },
      _agent: orchestratorAgentId, _conversationId: convoId
    }));
    return;
  }

  // Park the original process (or reference the killed one for intercepted calls)
  const originalAgentId = isIntercepted ? msg._parentAgentId : existing.agentId;
  const originalProcessId = isIntercepted ? (existing?.processId || 'intercepted') : existing.processId;
  if (!isIntercepted) existing.idle = true; existing.idleSince = Date.now();

  // Spawn delegate process
  const delegateProcessId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const isPlatformDelegate = targetAgent.type === 'platform';
  // Codex delegates are transactional: exec mode runs one process per turn,
  // so a delegated task is briefed, completed in one response, and control
  // returns to the parent with the output injected (the shared close handler
  // below). Direct conversations with Codex agents remain conversational via
  // thread resume; only the delegated flow is single-shot.
  const isCodexDelegate = targetAgent.runtime === 'codex';

  // Platform delegates (Doc): transactional, auto-return after task completion
  // Specialists with direct reports: multi-step pipeline, return when the pipeline is complete
  // Plain specialists: conversational, user controls when to return
  const targetHasDirectReports = !!buildTeamRoster(targetAgent.id, true);
  let delegationContext;
  if (isCodexDelegate) {
    // Transactional, and honest about the runtime's shape: a Codex exec
    // process cannot stay in the conversation to wait for a user reply, so
    // it must never promise to. Clarifications go through the handback.
    delegationContext = 'DELEGATION CONTEXT:\nYou have been delegated a task by another agent. Complete the task fully in this single response; you cannot wait for follow-up messages in this session. Prefer sensible defaults over asking questions. When the task is done, post your final summary and output <!-- RUNDOCK:COMPLETE --> at the very end of the response. If you genuinely cannot proceed without an answer from the user, state the question clearly in your response and still output <!-- RUNDOCK:COMPLETE -->; the reply will reach you when the task is re-delegated. Only use <!-- RUNDOCK:RETURN --> if the request is genuinely outside your scope and you cannot help.';
  } else if (isPlatformDelegate) {
    delegationContext = 'DELEGATION CONTEXT:\nYou have been delegated a task by another agent. Complete the task in a single response if possible. When the task is done (agent created, skill saved, file written, question answered, etc.), output <!-- RUNDOCK:COMPLETE --> at the very end of that same response. Do not wait for follow-up questions. Do not ask if there is anything else. Just complete the task, confirm what you did, and return immediately. If you genuinely need clarification before you can proceed, ask, but prefer using sensible defaults over asking.\n\nException: if you have proposed a plan and are waiting for the user to confirm before you execute (e.g. you asked them to say "go ahead"), do NOT emit COMPLETE. Stay in the conversation and wait for their response. Only emit COMPLETE once the task is genuinely finished: you executed the work, or you answered the question fully with no pending user decision.\n\nOnly use <!-- RUNDOCK:RETURN --> if the request is genuinely outside your scope and you cannot help. This is rare.';
  } else if (targetHasDirectReports) {
    delegationContext = 'DELEGATION CONTEXT:\nYou have been brought into this conversation by the orchestrator to run a task in your domain. You lead a support team and may delegate parts of the work to them. Do the real work, write the deliverables, and report the outcome.\n\nYou MUST hand control back using one of two markers, on its own line, as the very last thing in your response (after any final summary):\n\n- <!-- RUNDOCK:RETURN --> when the user asks for something outside your domain of expertise. Tell them briefly that this falls outside what you handle and you are handing them back so the right person can pick it up. Do NOT name other specialists or suggest who should handle it. Then emit the marker.\n\n- <!-- RUNDOCK:COMPLETE --> when the orchestrator\'s original delegated pipeline is finished end-to-end. All deliverables are written to their final locations and the workflow has reached its final status (for example content moved to Ready for Review, spec written and linked, final audit posted). Post your final summary first, then emit the marker.\n\nDo NOT emit either marker when you are pausing at a decision point to let the user choose between options, presenting drafts, hooks, options, or recommendations for user review, asking the user to confirm something before continuing, or waiting at a human gate midway through a multi-phase pipeline. Those are pauses, not completions. Stay in the conversation as the active agent and wait for the user\'s next message. You will pick up where you left off when they respond.\n\nReturning on completion is how control flows back up the chain. If you silently stop, the user\'s next message will be routed to the wrong agent.';
  } else {
    delegationContext = 'DELEGATION CONTEXT:\nYou have been brought into this conversation by the orchestrator to handle a specific request. Help the user with their request. Have a natural conversation. Stay in the conversation and keep helping with follow-up questions in your domain.\n\nIMPORTANT: Do NOT return after completing a single task. The user may have more questions for you. Wait for their next message.\n\nOnly return to the orchestrator (output <!-- RUNDOCK:RETURN --> at the very end of your response) when:\n- The user asks for something outside your area of expertise. Tell them briefly that this falls outside what you handle and you are handing them back so the right person can pick it up. Do NOT name other specialists or suggest who should handle it. That is the orchestrator\'s job. Then output the RETURN marker.\n\nDo not attempt tasks you are not designed for. Hand back promptly so the orchestrator can route correctly.';
  }

  const systemPrompt = buildSystemPrompt(targetAgent);
  const fullPrompt = systemPrompt + '\n\n' + delegationContext;

  // Look up prior session for this target agent in this conversation.
  // If found, resume instead of cold-spawning so the delegate retains its
  // internal context (tool results, reasoning, working state) from earlier turns.
  // Platform delegates are excluded: they are transactional one-shot processes.
  let priorSessionId = null;
  if (!isPlatformDelegate) {
    try {
      const convos = readConversations();
      const convo = convos.find(c => c.id === convoId);
      if (convo && convo.sessionIds) {
        const match = convo.sessionIds.filter(s => s.agentId === targetAgent.id).pop();
        if (match) priorSessionId = match.sessionId;
      }
    } catch (e) { /* cold spawn on failure */ }
  }

  const delegateDisallowed = getDisallowedTools();
  const delegatePermMode = getPermissionMode();
  const delegateArgs = [...getBareArgs(), ...modelArgs(targetAgent), '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--permission-mode', delegatePermMode,
    '--allowed-tools', getAllowedToolsInteractive(),
    ...(delegateDisallowed ? ['--disallowed-tools', delegateDisallowed] : []),
    '--append-system-prompt', fullPrompt,
    ...(priorSessionId ? ['--resume', priorSessionId] : []),
    '--agent', targetAgent.name];

  console.log(`[Delegate] convo=${convoId} from=${originalAgentId} to=${targetAgent.id} proc=${delegateProcessId} runtime=${targetAgent.runtime}${priorSessionId ? ` resume=${priorSessionId}` : ''}`);
  recordEvent('delegation_start', { conv: convoId, agent: originalAgentId, runtime: targetAgent.runtime, d: { from: originalAgentId, to: targetAgent.id, intercepted: isIntercepted } });

  // Normalised for the codex path: thread resolution and prompt must agree
  // on whether this is a resume (see startCodexTurn for the identity-loss
  // hazard). Codex delegates have NO per-turn child process: their turn runs
  // on the shared app-server, so delegateProc stays null for them.
  const codexResumeId = isCodexDelegate && codexRuntime.isValidThreadId(priorSessionId) ? priorSessionId : null;
  const delegateProc = isCodexDelegate
    ? null
    : spawnClaude(delegateArgs, {
        cwd: config.getWorkspace(),
        env: getSpawnEnv(convoId),
        stdio: ['pipe', 'pipe', 'pipe']
      }, (err) => handleChatSpawnError(err, convoId));

  const delegateEntry = {
    process: delegateProc || undefined, runtime: targetAgent.runtime, buffer: '', processId: delegateProcessId,
    agentId: targetAgent.id, responseText: '', exited: false, resultSent: false, idle: false,
    isPlatformDelegate, lastUserMessage: msg.context, receivedFollowUp: false,
    isIntercepted,
    pendingAgentTools: null,
    toolCalls: [], turnStartTime: Date.now(),
    delegation: {
      originalAgentId, originalProcessId,
      originalProcess: isIntercepted ? null : existing.process,
      originalEntry: isIntercepted ? null : existing,
      parentSessionId: isIntercepted ? msg._parentSessionId : null,
      // For sub-delegates (e.g. sub-agent spawned via lead interception): track the orchestrator
      // so out-of-scope returns can skip the mid-level parent and go straight back.
      orchestratorEntry: isIntercepted && existing?.delegation?.originalEntry
        ? existing.delegation.originalEntry : null,
      orchestratorAgentId: isIntercepted && existing?.delegation?.originalAgentId
        ? existing.delegation.originalAgentId : null
    }
  };
  // The delegation record owns the durable state: the accumulated turn log
  // for the handback, the timestamp bounding the transcript fallback, and
  // the Agent calls from the delegating turn that were not run (named back
  // to the caller so it can sequence them instead of believing they ran).
  attachDelegationRecord(delegateEntry, createDelegationRecord({
    deferredTargets: msg._deferredTargets || null
  }));
  processes.set(convoId, delegateEntry);

  // Notify client of agent switch
  safeSend(JSON.stringify({
    type: 'system', subtype: 'agent_switch', _conversationId: convoId, _processId: delegateProcessId,
    fromAgent: originalAgentId, toAgent: targetAgent.id
  }));
  safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: delegateProcessId, _agent: targetAgent.id }));

  // Send context as first message:
  // - Resumed delegate: brief only (session has prior context on disk)
  // - Intercepted cold spawn: brief only (orchestrator's brief is sufficient)
  // - Non-intercepted cold spawn: full transcript as safety net
  const needsTranscript = !priorSessionId && !isIntercepted;
  const transcript = needsTranscript ? formatTranscript(convoId) : null;
  const contextWithHistory = transcript
    ? `CONVERSATION SO FAR:\n${transcript}\n\nYOUR TASK:\n${msg.context}`
    : `[DELEGATION BRIEF]\n${msg.context}`;

  if (isCodexDelegate) {
    // Codex takes the whole prompt in one turn: identity + platform rules +
    // delegation contract on a fresh thread (Codex has no --agent or
    // --append-system-prompt equivalent); contract + brief on a resumed
    // thread (instructions are already in the thread).
    // The fresh variant travels too: if the stored thread turns out to be
    // expired, wireCodexDelegate falls back to a fresh thread and must use
    // the full prompt.
    const codexFreshPrompt = [readAgentInstructions(targetAgent), fullPrompt, contextWithHistory].filter(Boolean).join('\n\n');
    const codexPrompt = codexResumeId
      ? `${delegationContext}\n\n${contextWithHistory}`
      : codexFreshPrompt;
    // With no per-turn process there is no 'close' event: the turn's done
    // event fires this hook instead, running the SAME restoration handler
    // Claude delegates attach to process close (defined below).
    delegateEntry.onTurnDone = (code) => handleDelegateClose(code);
    wireCodexDelegate(delegateEntry, convoId, codexPrompt, {
      resumeThreadId: codexResumeId,
      model: targetAgent.model || undefined,
      freshPrompt: codexFreshPrompt,
    });
  } else {
  delegateProc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: contextWithHistory } }) + '\n');

  wireProcessHandlers(delegateEntry, convoId, null, {
    enableInterception: true,
    onResult: (e) => {
      const { hasReturn: hasOutOfScope, hasComplete, hasCrudMarker } = resolveMarkers(e.responseText);
      const hasHandoff = hasOutOfScope || hasComplete;
      const shouldAutoReturn = e.isPlatformDelegate
        ? (hasHandoff || hasCrudMarker)
        : hasHandoff;

      // COMPLETE takes priority when both markers are present.
      if (hasComplete) {
        e.returnMarkerSeen = 'complete';
        if (hasOutOfScope) {
          console.log(`[Delegate] convo=${convoId} agent=${e.agentId} both RETURN and COMPLETE markers detected, treating as COMPLETE (pipeline done)`);
        } else {
          console.log(`[Delegate] convo=${convoId} agent=${e.agentId} COMPLETE marker detected (pipeline done)`);
        }
      } else if (hasOutOfScope) {
        // Platform delegates are transactional: they do the task and return.
        // If a platform delegate emits RETURN but actually did the work (no
        // out-of-scope language in the response), treat it as COMPLETE.
        // This is a server-side safety net for models that ignore the
        // COMPLETE instruction in the delegation context.
        const outOfScopePhrases = /outside (my|what I|this agent's) scope|I can('|no)t help with th|falls outside what I handle|not (something|a task) I (can |)handle|genuinely outside my/i;
        if (e.isPlatformDelegate && !outOfScopePhrases.test(e.responseText)) {
          e.returnMarkerSeen = 'complete';
          console.log(`[Delegate] convo=${convoId} agent=${e.agentId} platform delegate RETURN overridden to COMPLETE (no out-of-scope language detected)`);
        } else {
          e.returnMarkerSeen = 'return';
          console.log(`[Delegate] convo=${convoId} agent=${e.agentId} RETURN marker detected (out-of-scope)`);
        }
      }

      if (shouldAutoReturn) {
        console.log(`[Delegate] Server-side auto-return convo=${convoId} (outOfScope=${hasOutOfScope}, complete=${hasComplete}, crud=${hasCrudMarker})`);
        // A user follow-up in this window cancels the auto-return; once the
        // kill fires, later messages buffer instead of hitting dying stdin.
        scheduleScopeReturnKill(e, convoId);
      }

      e.finalResponseText = e.responseText;
      if (e.responseText) {
            const toolSummary = buildToolSummary(e.toolCalls);
            const textWithTools = toolSummary ? toolSummary + '\n' + e.responseText : e.responseText;
            appendTranscript(convoId, 'agent', e.agentId, textWithTools, undefined, e);
            // Accumulate before the reset: the reset is correct for per-turn
            // streaming, but the handback must carry every turn.
            e.deliveredTurns.push(e.responseText);
          }
      e.responseText = '';
      e.idle = true; e.idleSince = Date.now();
    }
  });
  }

  // Shared close path for BOTH runtimes: Claude delegates attach it to the
  // child process's 'close'; Codex delegates fire it from their turn's done
  // event (entry.onTurnDone above). It owns agent_switch/done and parent
  // restoration.
  const handleDelegateClose = (code) => {
    if (delegateEntry.spawnFailed) return; // error handler already surfaced
    delegateEntry.exited = true;
    const current = processes.get(convoId);
    if (current !== delegateEntry) return;

    // The delegate is gone but its replacement (restored parent, respawned
    // orchestrator) is not ready yet: enter the restoring state so a chat
    // message arriving now is buffered rather than racing the restoration.
    // When an auto-return kill opened the window this moves killing ->
    // restoring on the same queue. endConvoTransition replays any buffered
    // messages against the restored process once restoration completes.
    beginConvoTransition(convoId, 'restoring', delegateEntry);
    const runRestore = () => {
      try { finishDelegateClose(code); }
      finally { endConvoTransition(convoId, delegateEntry); }
    };
    // RUNDOCK_TEST_RESTORE_DELAY_MS (test-only seam, default 0) widens this
    // window so the race is deterministically testable; in production the
    // restoration runs synchronously on the close event, exactly as before.
    if (RESTORE_DELAY_MS > 0) setTimeout(runRestore, RESTORE_DELAY_MS);
    else runRestore();
  };

  // Restoration body (behaviour unchanged apart from the buffered-follow-up
  // gates); separated from handleDelegateClose so the restoring window above
  // can wrap, and under test delay, it.
  const finishDelegateClose = (code) => {
    // A chat message buffered during the kill/restore window supersedes the
    // handoff's auto-continue: the user has spoken, so their replayed message
    // drives the restored parent instead of a routing prompt. Mirrors the
    // live-window rule where a follow-up cancels the auto-return.
    // Multi-target honesty: Agent calls from the delegating turn that were
    // not run are named back to the caller. The engine used to discard them
    // with no log and no event, so callers believed parallel work happened.
    // Worded to inform, not to command: two of the receiving prompts require
    // the parent to output <silent>, so the note must survive being read
    // without being acted on until the parent's next active turn.
    const deferred = delegateEntry.deferredTargets || [];
    const deferredNote = deferred.length
      ? `\n\nNOTE: the turn that delegated to ${delegateEntry.agentId} also invoked the Agent tool for: ${deferred.join(', ')}. Delegation is sequential, so ${deferred.length === 1 ? 'that call was' : 'those calls were'} NOT run. If that work is still needed, sequence it one target at a time on your next active turn.`
      : '';

    // If cancelled by user, skip all parent restoration logic
    if (delegateEntry.cancelled) {
      console.log(`[Delegate] convo=${convoId} delegate was cancelled, skipping parent restoration`);
      processes.delete(convoId);
      return;
    }

    // Signal layer: every delegate handback converges here for both runtimes
    // (Claude via process close, Codex via onTurnDone). kind 'none' is a
    // markerless exit; the tail scan mirrors the intercepted branch below
    // without changing its behavior.
    recordEvent('handback', {
      conv: convoId, agent: delegateEntry.agentId, runtime: delegateEntry.runtime || 'claude',
      d: {
        kind: delegateEntry.returnMarkerSeen
          || resolveMarkers(delegateEntry.finalResponseText || delegateEntry.responseText).mode
          || 'none',
        to: delegateEntry.delegation.originalAgentId,
      },
    });

    // Flush remaining buffer
    if (delegateEntry.buffer.trim()) {
      try {
        const parsed = JSON.parse(delegateEntry.buffer);
        parsed._agent = delegateEntry.agentId;
        parsed._conversationId = convoId;
        parsed._processId = delegateProcessId;
        safeSend(JSON.stringify(parsed));
      } catch (e) {}
    }

    // Restore original process
    const orig = delegateEntry.delegation.originalEntry;
    if (delegateEntry.isIntercepted) {
      // Two distinct handoff markers: RETURN means the user asked for something outside
      // the specialist's domain (route to another specialist); COMPLETE means the delegated
      // pipeline finished end-to-end (orchestrator resumes silently).
      let returnMarkerSeen = delegateEntry.returnMarkerSeen || null;
      if (!returnMarkerSeen) {
        // Tail scan for a marker the onResult handler never saw (e.g. the
        // process died after streaming it). Same single resolver, same
        // COMPLETE-beats-RETURN precedence.
        returnMarkerSeen = resolveMarkers(delegateEntry.finalResponseText || delegateEntry.responseText).mode;
      }
      const hasHandoffMarker = !!returnMarkerSeen;
      const isOutOfScope = returnMarkerSeen === 'return';
      const isPipelineComplete = returnMarkerSeen === 'complete';
      const orchestratorEntry = delegateEntry.delegation.orchestratorEntry;
      const orchestratorAgentId = delegateEntry.delegation.orchestratorAgentId;

      console.log(`[AgentIntercept] convo=${convoId} close handler: isIntercepted=${delegateEntry.isIntercepted} marker=${returnMarkerSeen || 'none'} hasOrchestratorEntry=${!!orchestratorEntry} orchestratorExited=${orchestratorEntry?.exited}`);

      if (hasHandoffMarker && orchestratorEntry && !orchestratorEntry.exited) {
        // Skip mid-level parent, return directly to orchestrator
        console.log(`[AgentIntercept] convo=${convoId} sub-delegate handed back (${returnMarkerSeen}), skipping ${delegateEntry.delegation.originalAgentId}, restoring orchestrator ${orchestratorAgentId}`);

        orchestratorEntry.idle = true; orchestratorEntry.idleSince = Date.now();
        orchestratorEntry.delegation = null;
        orchestratorEntry.handbackAt = Date.now(); // stale end_delegation guard
        processes.set(convoId, orchestratorEntry);

        safeSend(JSON.stringify({
          type: 'system', subtype: 'agent_switch', _conversationId: convoId,
          fromAgent: delegateEntry.agentId, toAgent: orchestratorAgentId
        }));

        // COMPLETE gate: when the specialist finished the delegated pipeline,
        // do NOT auto-resume the orchestrator. Leave it idle so the user sees
        // the specialist's output and decides what to do next.
        if (isPipelineComplete) {
          console.log(`[AgentIntercept] convo=${convoId} COMPLETE gate: specialist ${delegateEntry.agentId} finished, orchestrator ${orchestratorAgentId} stays idle`);
        } else if (bufferedFollowUpTakesOver(convoId, orchestratorEntry, 'RETURN auto-continue')) {
          // orchestrator stays idle; the replayed message drives it
        } else if (orchestratorEntry.process && orchestratorEntry.process.stdin && orchestratorEntry.process.stdin.writable && !orchestratorEntry.process.killed) {
          // RETURN path: auto-continue to route the pending request to another specialist
          const resumeCount = incrementAutoResume(convoId);
          if (resumeCount >= MAX_CONSECUTIVE_AGENT_RESUMES) {
            console.log(`[CircuitBreaker] convo=${convoId} ${resumeCount} consecutive agent resumes, pausing orchestrator`);
          recordEvent('circuit_breaker', { conv: convoId, d: { count: resumeCount } });
            resetAutoResume(convoId);
            safeSend(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: `[Auto-paused: ${resumeCount} consecutive agent handoffs without user input. Agents involved: ${delegateEntry.agentId} → ${orchestratorAgentId}. Please review the output above and send your next message to continue.]` }, _agent: orchestratorAgentId, _conversationId: convoId }));
          } else {
            const pendingRequest = delegateEntry.lastUserMessage || '';
            setTimeout(() => {
              if (!orchestratorEntry.exited) {
                console.log(`[AgentIntercept] convo=${convoId} auto-continuing orchestrator after skip-level ${returnMarkerSeen} (resume ${resumeCount}/${MAX_CONSECUTIVE_AGENT_RESUMES})`);
                orchestratorEntry.responseText = '';
                orchestratorEntry.idle = false; orchestratorEntry.idleSince = null;
                safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: orchestratorEntry.processId, _agent: orchestratorAgentId, autoContinue: true }));
                const prompt = pendingRequest
                  ? `[SYSTEM: A specialist just returned because the user asked for something outside their scope. The user's pending request is: "${pendingRequest}"\n\nRoute this request now. Delegate to the right specialist if one fits, or handle it yourself. Do not summarise what the previous specialist did. Do not ask the user to repeat themselves. Respond to their request.${deferredNote}]`
                  : `[SYSTEM: A specialist just returned. Ask the user what they need next.${deferredNote}]`;
                try {
                  orchestratorEntry.process.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
                } catch (err) {
                  console.warn(`[AgentIntercept] convo=${convoId} failed to write to orchestrator stdin: ${err.message}`);
                }
              }
            }, 300);
          }
        }

        safeSend(JSON.stringify({ type: 'system', subtype: 'done', code, _agent: delegateEntry.agentId, _conversationId: convoId, _processId: delegateProcessId }));
        return;
      }

      // Intercepted return: restart mid-level parent with --resume
      const parentAgentId = delegateEntry.delegation.originalAgentId;
      const parentSessionId = delegateEntry.delegation.parentSessionId;
      console.log(`[AgentIntercept] convo=${convoId} delegate done, restarting parent ${parentAgentId} (session=${parentSessionId}) marker=${returnMarkerSeen || 'none'}`);

      safeSend(JSON.stringify({
        type: 'system', subtype: 'agent_switch', _conversationId: convoId,
        fromAgent: delegateEntry.agentId, toAgent: parentAgentId
      }));

      const parentAgentList = discoverAgents();
      const parentAgentData = parentAgentList.find(a => a.id === parentAgentId || a.name === parentAgentId);
      const parentSystemPrompt = parentAgentData ? buildSystemPrompt(parentAgentData) : '';

      const resumeDisallowed = getDisallowedTools();
      const resumePermMode = getPermissionMode();
      const resumeArgs = [...getBareArgs(), ...modelArgs(parentAgentData), '--output-format', 'stream-json', '--input-format', 'stream-json',
        '--verbose', '--include-partial-messages', '--permission-mode', resumePermMode,
        '--allowed-tools', getAllowedToolsInteractive(),
        ...(resumeDisallowed ? ['--disallowed-tools', resumeDisallowed] : [])];
      if (parentSystemPrompt) resumeArgs.push('--append-system-prompt', parentSystemPrompt);
      if (parentAgentData?.name) resumeArgs.push('--agent', parentAgentData.name);
      if (parentSessionId) resumeArgs.push('--resume', parentSessionId);

      const resumeProcessId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const resumeProc = spawnClaude(resumeArgs, {
        cwd: config.getWorkspace(),
        env: getSpawnEnv(convoId),
        stdio: ['pipe', 'pipe', 'pipe']
      }, (err) => handleChatSpawnError(err, convoId));

      const resumeEntry = {
        process: resumeProc, buffer: '', processId: resumeProcessId,
        agentId: parentAgentId, responseText: '', exited: false, resultSent: false,
        pendingAgentTools: null,
        toolCalls: [], turnStartTime: Date.now(),
        handbackAt: Date.now() // stale end_delegation guard
      };
      // A restored parent can hand back onward via its scope-return close
      // path, so it carries a record. scopeReturnSource tags the returning
      // specialist so handleDelegation's guard blocks immediate re-delegation
      // to the same agent; only set for out-of-scope returns, because
      // pipeline-complete should allow re-delegation.
      attachDelegationRecord(resumeEntry, createDelegationRecord({
        scopeReturnSource: isOutOfScope ? delegateEntry.agentId : null
      }));
      processes.set(convoId, resumeEntry);

      // Auto-prompt only on out-of-scope: parent is resumed with a routing request so
      // it can delegate the pending user message to a different specialist. For
      // pipeline-complete and no-marker exits, the parent restarts silently and waits
      // for the user's next message. In the single-level case (delegate was direct
      // from the orchestrator, so the parent IS the orchestrator), this is all that's
      // needed. In deeper chains, the pipeline-complete marker would have fired the
      // skip-level orchestratorEntry branch above and never reached this code path.
      // Inject specialist output into the handback prompt so the parent has
      // visibility into what was delivered. The parent's --resume session only
      // contains its own pre-delegation state; the specialist's work is invisible
      // without this injection.
      const delegateOutput = buildHandbackPayload(delegateEntry, convoId);
      const delegateOutputBlock = delegateOutput
        ? `\n\n--- ${delegateEntry.agentId} ---\n${delegateOutput}\n---`
        : '';

      if (isOutOfScope && bufferedFollowUpTakesOver(convoId, resumeEntry, 'RETURN routing prompt')) {
        // parked by the gate; the replayed message drives the resumed parent
      } else if (isOutOfScope) {
        const resumeCount = incrementAutoResume(convoId);
        if (resumeCount >= MAX_CONSECUTIVE_AGENT_RESUMES) {
          console.log(`[CircuitBreaker] convo=${convoId} ${resumeCount} consecutive agent resumes on parked-parent RETURN path, pausing`);
          recordEvent('circuit_breaker', { conv: convoId, d: { count: resumeCount } });
          resetAutoResume(convoId);
          resumeEntry.idle = true; resumeEntry.idleSince = Date.now();
          safeSend(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: `[Auto-paused: ${resumeCount} consecutive agent handoffs without user input. Last specialist: ${delegateEntry.agentId}. Please review the output above and send your next message to continue.]` }, _agent: delegateEntry.delegation.originalAgentId, _conversationId: convoId }));
        } else {
          safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: resumeProcessId, _agent: parentAgentId, autoContinue: true }));

          const resumePrompt = `[SYSTEM: ${delegateEntry.agentId} returned because the request was outside their scope. Here is what they said:${delegateOutputBlock}\n\nThe user's latest request was: "${delegateEntry.lastUserMessage || 'continue'}". Respond with full awareness of what ${delegateEntry.agentId} delivered. Do not re-delegate work already done. Route to the right specialist using the Agent tool.${deferredNote}]`;
          resumeProc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: resumePrompt } }) + '\n');
        }
      } else if (isPipelineComplete) {
        // Park silently but inject specialist output so the next user message
        // resumes with real context about what was delivered.
        safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: resumeProcessId, _agent: parentAgentId, autoContinue: true, silent: true }));
        const completePrompt = `[SYSTEM: pipeline-complete] ${delegateEntry.agentId} has finished the delegated work. Here is their final message to the conversation:${delegateOutputBlock}${deferredNote}\n\nYour output for this turn MUST be exactly the literal string <silent> and nothing else. Do not narrate, summarise, or quote the specialist's output. Do not invoke any tools. Do not emit any other text. Just output <silent> and stop.`;
        resumeProc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: completePrompt } }) + '\n');
        resumeEntry.idle = true; resumeEntry.idleSince = Date.now();
        console.log(`[AgentIntercept] convo=${convoId} delegate emitted COMPLETE, parent ${parentAgentId} parked with specialist output`);
      } else {
        // Normal exit (no marker). Inject specialist output for context, then park.
        safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: resumeProcessId, _agent: parentAgentId, autoContinue: true, silent: true }));
        const normalPrompt = `[SYSTEM: pipeline-complete] ${delegateEntry.agentId} completed their work. Here is their final message to the conversation:${delegateOutputBlock}${deferredNote}\n\nYour output for this turn MUST be exactly the literal string <silent> and nothing else. Do not narrate, summarise, or quote the specialist's output. Do not invoke any tools. Do not emit any other text. Just output <silent> and stop.`;
        resumeProc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: normalPrompt } }) + '\n');
        resumeEntry.idle = true; resumeEntry.idleSince = Date.now();
        console.log(`[AgentIntercept] convo=${convoId} delegate completed normally, parent ${parentAgentId} parked with specialist output`);
      }

      wireProcessHandlers(resumeEntry, convoId, null, {
        enableInterception: true,
        onResult: (e) => {
          // Detect both handoff markers on a parked-and-resumed parent. scopeReturnMode
          // records which one fired so the close handler can route correctly: 'return'
          // means route the pending request to a different specialist, 'complete' means
          // the delegated pipeline is finished and the orchestrator should resume silently.
          const markers = resolveMarkers(e.responseText);
          if (markers.mode && !e.delegation) {
            e.scopeReturn = true;
            // mode already applies COMPLETE-beats-RETURN precedence
            e.scopeReturnMode = markers.mode;
            console.log(`[ScopeReturn] convo=${convoId} agent=${e.agentId} ${e.scopeReturnMode} marker on resumed parent`);
            // Follow-up in-window cancels the auto-return; post-kill messages buffer.
            scheduleScopeReturnKill(e, convoId);
          }
          // Filter silent-park responses: strip sentinel and suppress near-empty/no-op output
          if (e.responseText && !isSilentParkResponse(e.responseText)) {
            const toolSummary = buildToolSummary(e.toolCalls);
            const textWithTools = toolSummary ? toolSummary + '\n' + e.responseText : e.responseText;
            appendTranscript(convoId, 'agent', e.agentId, textWithTools, undefined, e);
            if (e.deliveredTurns) e.deliveredTurns.push(e.responseText);
          }
          // Mirror the delegate (~2673) and direct-start (~3134) paths:
          // preserve the final text so a later handleScopeReturn injects the real
          // specialist output into the orchestrator prompt, not an empty block.
          e.finalResponseText = e.responseText;
          e.responseText = '';
          e.idle = true; e.idleSince = Date.now();
        }
      });
      resumeProc.on('close', (rCode) => {
        if (resumeEntry.spawnFailed) return; // error handler already surfaced
        resumeEntry.exited = true;
        const cur = processes.get(convoId);

        // If the resumed parent itself emitted a handoff marker, route through
        // handleScopeReturn. The mode selects the downstream prompt: 'return' produces
        // a routing-request prompt to the orchestrator, 'complete' produces the
        // silent-exit prompt that prevents re-delegation and narration.
        if (resumeEntry.scopeReturn && cur === resumeEntry) {
          const wasComplete = resumeEntry.scopeReturnMode === 'complete';
          console.log(`[ScopeReturn] convo=${convoId} resumed parent ${resumeEntry.agentId} exited with ${resumeEntry.scopeReturnMode} marker, spawning orchestrator (pipelineComplete=${wasComplete})`);
          handleScopeReturn(resumeEntry, convoId, wasComplete);
          return;
        }

        if (cur === resumeEntry) {
          processes.delete(convoId);
          endConvoTransition(convoId, resumeEntry); // replay buffered messages into a fresh spawn
        }
        safeSend(JSON.stringify({ type: 'system', subtype: 'done', code: rCode, _agent: resumeEntry.agentId, _conversationId: convoId, _processId: resumeProcessId }));
      });

    } else if (orig && !orig.exited) {
      orig.idle = true; orig.idleSince = Date.now();
      orig.delegation = null;
      orig.handbackAt = Date.now(); // stale end_delegation guard
      processes.set(convoId, orig);
      console.log(`[Delegate] convo=${convoId} delegate exited, restored ${delegateEntry.delegation.originalAgentId}`);
      safeSend(JSON.stringify({
        type: 'system', subtype: 'agent_switch', _conversationId: convoId,
        fromAgent: delegateEntry.agentId, toAgent: delegateEntry.delegation.originalAgentId
      }));

      // bufferedFollowUp gate: a message buffered during the window replays
      // to the restored parent directly, superseding the auto-continue.
      if (!delegateEntry.isPlatformDelegate && delegateEntry.receivedFollowUp && !bufferedFollowUpTakesOver(convoId, orig, 'specialist-return auto-continue') && orig.process && orig.process.stdin && orig.process.stdin.writable) {
        const resumeCount = incrementAutoResume(convoId);
        if (resumeCount >= MAX_CONSECUTIVE_AGENT_RESUMES) {
          console.log(`[CircuitBreaker] convo=${convoId} ${resumeCount} consecutive agent resumes on delegate return path, pausing`);
          recordEvent('circuit_breaker', { conv: convoId, d: { count: resumeCount } });
          resetAutoResume(convoId);
          orig.idle = true; orig.idleSince = Date.now();
          safeSend(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: `[Auto-paused: ${resumeCount} consecutive agent handoffs without user input. Last specialist: ${delegateEntry.agentId}. Please review the output above and send your next message to continue.]` }, _agent: orig.agentId, _conversationId: convoId }));
        } else {
          const pendingRequest = delegateEntry.lastUserMessage || '';
          setTimeout(() => {
            if (!orig.exited) {
              console.log(`[Delegate] convo=${convoId} auto-continuing orchestrator after specialist return (resume ${resumeCount}/${MAX_CONSECUTIVE_AGENT_RESUMES})`);
              orig.responseText = '';
              orig.idle = false; orig.idleSince = null;
              safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: orig.processId, _agent: orig.agentId, autoContinue: true }));
              const prompt = pendingRequest
                ? `[SYSTEM: The specialist just returned because the user asked for something outside their scope. The user's pending request is: "${pendingRequest}"\n\nRoute this request now. Delegate to the right specialist if one fits, or handle it yourself. Do not summarise what the previous specialist did. Do not ask the user to repeat themselves. Respond to their request.${deferredNote}]`
                : `[SYSTEM: The specialist just returned. The user indicated they were done with that specialist. Ask the user what they need next.${deferredNote}]`;
              try {
                orig.process.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
              } catch (err) {
                console.warn(`[Delegate] convo=${convoId} failed to write to orchestrator stdin: ${err.message}`);
              }
            }
          }, 300);
        }
      }
    } else {
      processes.delete(convoId);
      console.log(`[Delegate] convo=${convoId} delegate exited, original process gone`);
    }
    safeSend(JSON.stringify({ type: 'system', subtype: 'done', code, _agent: delegateEntry.agentId, _conversationId: convoId, _processId: delegateProcessId }));
  };
  if (delegateProc) delegateProc.on('close', handleDelegateClose);
}

// End delegation: kill the delegate, restore the original. The shim body
// moved here in slice 10; the root keeps a one-line dispatch shim.
function handleEndDelegation(msg, processes) {
  const convoId = msg.conversationId;
  const current = processes.get(convoId);
  if (current && current.delegation && !current.exited) {
    console.log(`[Delegate] convo=${convoId} ending delegation, killing delegate`);
    // This kill is immediate and uncancellable, so open the killing
    // window first: a follow-up landing in the kill-to-close gap is
    // buffered (see convoTransitions) instead of clearing the committed
    // handback and vanishing into the dying delegate's stdin.
    beginConvoTransition(convoId, 'killing', current);
    stopEntryProcess(current);
    // The close path (process close for Claude, turn done for Codex)
    // will restore the original process
  } else if (current && !current.delegation && !current.exited && !current.scopeReturn) {
    // Specialist started directly (no delegation) emitted RETURN
    // Server-side onResult should have caught this, but handle as fallback.
    // Stale-message guard, two signals:
    // 1. An entry restored/respawned by a delegate close handler within
    //    the last 15s (handbackAt): a fast-exiting delegate (e.g. Codex)
    //    can be handed back server-side before the client's marker scan
    //    round-trips, so the late end_delegation refers to a handback
    //    that already happened, for ANY parent type. Killing the
    //    restored parent would drop its session.
    // 2. An orchestrator or platform agent never emits RETURN, so the
    //    fallback can never be legitimate for one.
    const recentlyHandedBack = current.handbackAt && (Date.now() - current.handbackAt) < 15000;
    const agentList = discoverAgents();
    const currentAgent = agentList.find(a => a.id === current.agentId || a.name === current.agentId);
    if (recentlyHandedBack || (currentAgent && (currentAgent.type === 'orchestrator' || currentAgent.type === 'platform'))) {
      console.log(`[ScopeReturn] convo=${convoId} ignoring stale end_delegation for ${current.agentId} (${recentlyHandedBack ? 'recent handback' : currentAgent.type})`);
    } else {
      console.log(`[ScopeReturn] convo=${convoId} end_delegation fallback for non-delegated specialist`);
      current.scopeReturn = true;
      // Immediate uncancellable kill: open the killing window so a
      // follow-up in the kill-to-close gap buffers instead of clearing
      // scopeReturn and dying with the process (see convoTransitions).
      beginConvoTransition(convoId, 'killing', current);
      stopEntryProcess(current);
      // The close handler will call handleScopeReturn
    }
  }
}

module.exports = { createDelegationEngine, DEP_NAMES };
