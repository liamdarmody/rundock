'use strict';
// WS handlers: permission decisions from the browser and user-initiated
// cancel. Extracted verbatim from server.js. The pending-permission map and
// live process map are root-owned identities on ctx; boundary grants,
// signals, and the process-tree kill are lib-owned direct requires. The
// kill-window MACHINE (transitions, scheduled kills) stays in the root:
// cancel kills immediately and marks entries itself, it never opens a
// transition window.
const { addBoundaryGrant } = require('../../workspace/boundary.js');
const { recordEvent } = require('../../signals.js');
const { killProcessTree } = require('../../runtime/claude.js');

// Permission response: user approved/denied a tool in the browser UI.
// Resolves the pending HTTP long-poll from the PreToolUse hook script.
function handlePermissionResponse(ctx, ws, msg) {
  const pending = ctx.pendingPermissions.get(msg.requestId);
  if (pending) {
    clearTimeout(pending.timer);
    ctx.pendingPermissions.delete(msg.requestId);
    // "Always allow this folder": the user chose a standing grant along
    // with the approval. Folder-level, this workspace only.
    if (msg.allow === true && msg.grantDir) addBoundaryGrant(msg.grantDir);
    if (pending.res) {
      // Hook-originated request: answer the held HTTP response.
      pending.res.writeHead(200, { 'Content-Type': 'application/json' });
      pending.res.end(JSON.stringify({ allow: msg.allow }));
    } else if (pending.onDecision) {
      // Server-originated request (e.g. Codex write markers): callback.
      try { pending.onDecision(msg.allow === true, 'user'); } catch (e) { console.error('[Permission] onDecision threw:', e); }
    }
    console.log(`[Permission] convo=${msg.conversationId} requestId=${msg.requestId} decision=${msg.allow ? 'allow' : 'deny'}`);
    recordEvent('permission', { conv: msg.conversationId, d: { tool: pending.toolName, decision: msg.allow ? 'allow' : 'deny' } });
  } else {
    console.warn(`[Permission] No pending request for requestId=${msg.requestId} (expired or already resolved)`);
  }
}

// ── CANCEL: User interrupts a running agent ────────────
function handleCancel(ctx, ws, msg) {
  const convoId = msg.conversationId;
  const entry = ctx.processes.get(convoId);
  if (!entry || entry.exited) {
    console.log(`[Cancel] convo=${convoId} no active process to cancel`);
  } else if (entry.idle) {
    console.log(`[Cancel] convo=${convoId} process is idle, nothing to cancel`);
  } else {
    console.log(`[Cancel] convo=${convoId} proc=${entry.processId} agent=${entry.agentId} killing`);

    // Auto-deny any pending permission requests for this conversation
    for (const [reqId, pending] of ctx.pendingPermissions) {
      if (pending.conversationId === convoId) {
        clearTimeout(pending.timer);
        ctx.pendingPermissions.delete(reqId);
        try {
          if (pending.res) {
            pending.res.writeHead(200, { 'Content-Type': 'application/json' });
            pending.res.end(JSON.stringify({ allow: false, reason: 'cancelled' }));
          } else if (pending.onDecision) {
            pending.onDecision(false, 'cancelled');
          }
        } catch (e) {}
      }
    }

    // Mark as cancelled so delegation close handlers skip parent restoration
    entry.cancelled = true;
    entry.exited = true;

    // Send cancelled event before kill so client gets it before the done event
    ctx.broadcast(JSON.stringify({
      type: 'system', subtype: 'cancelled',
      _conversationId: convoId, _processId: entry.processId, _agent: entry.agentId,
      _toolCalls: entry.toolCalls || [], _turnStartTime: entry.turnStartTime || null
    }));

    // Stop the active work. Runtime-aware: Codex entries interrupt
    // their turn on the SHARED app-server (never kill it on a
    // conversation cancel); Claude entries kill their child process.
    if (entry.interrupt) {
      entry.interrupt();
    } else {
      try { killProcessTree(entry.process, 'SIGTERM'); } catch (e) {}
      // Safety net: SIGKILL after 2 seconds
      setTimeout(() => {
        try { killProcessTree(entry.process, 'SIGKILL'); } catch (e) {}
      }, 2000);
    }

    // If this is a delegate, also kill every parked ANCESTOR. Walk the
    // full parent chain rather than only orchestratorEntry, which is null
    // for non-intercepted nested WS-delegate chains and would otherwise
    // leak the grandparent orchestrator as a live process.
    if (entry.delegation) {
      const killParked = (e) => {
        if (!e || e.exited) return;
        e.exited = true;
        e.cancelled = true;
        if (e.interrupt) {
          e.interrupt();
        } else if (e.process) {
          try { killProcessTree(e.process, 'SIGTERM'); } catch (err) {}
          setTimeout(() => { try { killProcessTree(e.process, 'SIGKILL'); } catch (err) {} }, 2000);
        }
        console.log(`[Cancel] convo=${convoId} also killed parked ancestor agent=${e.agentId}`);
      };
      const seen = new Set([entry]);
      let d = entry.delegation;
      let depth = 0;
      while (d && depth++ < 50) {
        if (d.orchestratorEntry && !seen.has(d.orchestratorEntry)) {
          seen.add(d.orchestratorEntry);
          killParked(d.orchestratorEntry);
        }
        const parent = d.originalEntry;
        if (!parent || seen.has(parent)) break;
        seen.add(parent);
        killParked(parent);
        d = parent.delegation;
      }
    }

    // Clean up from the map immediately (close handler will also try but we guard with exited flag)
    ctx.processes.delete(convoId);

    // Send done so client unblocks
    ctx.broadcast(JSON.stringify({
      type: 'system', subtype: 'done', code: null,
      _conversationId: convoId, _processId: entry.processId, _agent: entry.agentId
    }));
  }
}

module.exports = { handlePermissionResponse, handleCancel };
