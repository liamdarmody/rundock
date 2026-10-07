'use strict';
// WS handlers: the one-line strip shown the first time this install opens a
// workspace that arrived with routines switched on (lib/agents/approval-locality.js).
//
//   allow_held_routines    approve every routine it names, here, now; each
//                          runs at its next slot, never on the click
//   dismiss_held_routines  close it: the routines stay held (each still has
//                          its approve step in Routines) and it does not return
//
// Every window is told the result, so a second window's strip closes too.
const { getWorkspace } = require('../../config.js');
const locality = require('../../agents/approval-locality.js');
const store = require('../../agents/approval-store.js');

function heldRoutinesMessage(dir = getWorkspace()) {
  return { type: 'held_routines', workspace: dir || null, routines: dir ? locality.heldForStrip(dir) : [] };
}

function announce(ctx) {
  ctx.agents.invalidateAgentCache();
  ctx.broadcast(JSON.stringify(heldRoutinesMessage()));
  const { rosterMessage } = require('../../agents/discovery.js');
  ctx.broadcast(JSON.stringify(rosterMessage()));
}

function handleAllowHeldRoutines(ctx) {
  const dir = getWorkspace();
  if (!dir) return;
  locality.allowHeld(dir, require('../../scheduler.js').schedulerNow().toISOString());
  console.log('[Routines] Allowed the routines this workspace came with');
  announce(ctx);
}

function handleDismissHeldRoutines(ctx) {
  const dir = getWorkspace();
  if (!dir) return;
  store.closeStrip(dir);
  announce(ctx);
}

module.exports = { heldRoutinesMessage, handleAllowHeldRoutines, handleDismissHeldRoutines };
