'use strict';
// WS handlers: permission decisions from the browser and user-initiated
// cancel. Extracted verbatim from server.js. The pending-permission map and
// live process map are root-owned identities on ctx; boundary grants,
// signals, and the process-tree kill are lib-owned direct requires. The
// kill-window MACHINE (transitions, scheduled kills) stays in the root:
// cancel kills immediately and marks entries itself, it never opens a
// transition window.
const { addBoundaryGrant } = require('../../workspace/boundary.js');
const { readWorkingFolders, writeWorkingFolders, normalizeOne } = require('../../workspace/working-folders.js');
const { reconcileSandboxForMode, workspaceModeFor } = require('../../workspace/scaffold.js');
const { getWorkspace } = require('../../config.js');
const { recordEvent } = require('../../signals.js');
const { killProcessTree } = require('../../runtime/claude.js');

// The durable half of "Always allow this folder": the folder joins the Working
// folders, which is where a person goes to see or revoke it, and which is what
// the permission card's own hint already tells them to use.
//
// GOES THROUGH THE SAME DOOR THE SETTINGS PANE USES, deliberately: one
// normalisation, one store, one sandbox reconcile, one broadcast. A second
// writer with its own spelling of any of those is how the two lists drift into
// disagreeing about what a person chose.
//
// WHEN IT TAKES EFFECT. The stored list is read at every agent spawn, so the
// folder covers shell commands from the next spawn rather than mid-command. The
// boundary grant stored beside it is consulted server-side at decision time and
// covers file access immediately, so nothing regresses in the meantime.
//
// Already-named folders are left alone rather than appended twice: approving a
// folder twice is an ordinary thing to do and must not grow the list.
function adoptWorkingFolder(ctx, dir) {
  const normalized = normalizeOne(dir);
  if (!normalized) return;
  const existing = readWorkingFolders();
  if (existing.some(d => d === normalized)) return;
  const folders = writeWorkingFolders([...existing, normalized]);
  // The operating system is told in a file, the hook at every spawn. Warned
  // rather than raised: the list is stored and in effect for the next spawn
  // either way, and the next workspace open reconciles the block again.
  try {
    const ws = getWorkspace();
    if (ws) reconcileSandboxForMode(ws, workspaceModeFor(ws), process.platform);
  } catch (e) {
    console.warn(`  Working folder added, but the sandbox was not updated: ${e.message}`);
  }
  console.log(`[Permission] Standing folder grant added for this workspace: ${normalized}`);
  // So the Settings pane shows it without a reload, in every open window.
  if (ctx && typeof ctx.broadcast === 'function') {
    ctx.broadcast(JSON.stringify({
      type: 'working_folders',
      folders: folders.map(d => ({ path: d, missing: !require('node:fs').existsSync(d) })),
      rejected: [],
      home: require('node:os').homedir(),
    }));
  }
}

// Permission response: user approved/denied a tool in the browser UI.
// Resolves the pending HTTP long-poll from the PreToolUse hook script.
function handlePermissionResponse(ctx, ws, msg) {
  const pending = ctx.pendingPermissions.get(msg.requestId);
  if (pending) {
    clearTimeout(pending.timer);
    ctx.pendingPermissions.delete(msg.requestId);
    // "Always allow this folder": the user chose a standing grant along
    // with the approval. Folder-level, this workspace only.
    //
    // BOTH STORES, because they cover different things and the button's promise
    // needs both. Reported from the field: a person approved a folder, watched
    // the very next command raise a card for a path inside it, and then went
    // looking for the folder in Settings and could not find it.
    //
    // A boundary grant is consulted server-side at decision time, so it takes
    // effect instantly, but it is never consulted for a SHELL command (see the
    // grantable note in http-router.js: a folder grant says an agent may touch
    // a folder, approving a command says that command may run, and the second
    // cannot be inferred from the first). A working folder is handed to the
    // runtime at spawn, so it covers the shell too, and it is the thing the
    // Settings list shows and the card's own hint points people at.
    //
    // Storing only the grant meant the button quietly did the weaker half of
    // what its label said, and left no trace anywhere a person could look.
    if (msg.allow === true && msg.grantDir) {
      addBoundaryGrant(msg.grantDir);
      try { adoptWorkingFolder(ctx, msg.grantDir); } catch (e) {
        // The grant is already stored and already in effect for file access.
        // Losing the durable half is worth a warning, never the approval the
        // person just gave.
        console.warn(`[Permission] Folder approved, but not added to Working folders: ${e.message}`);
      }
    }
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
