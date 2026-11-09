'use strict';
// WS handler: turn routines off, or back on, for the open workspace on this
// computer (lib/agents/routines-here.js).
//
//   set_routines_here { on, workspace }
//
// THE ONE WAY THE SWITCH CHANGES. The record is this install's own, and the
// scheduler reads it on every tick, so a window holds no state of its own
// that could turn routines off. The request names the workspace the window is
// showing, and it is refused unless that is still the open one: a window left
// on another workspace's list cannot change the workspace now open.
//
// Every window is told the result on the roster, which carries the switch's
// state, so a second window's switch moves too. A save that fails is said to
// the window that asked, and the record is left as it was.
const { getWorkspace } = require('../../config.js');
const routinesHere = require('../../agents/routines-here.js');

function handleSetRoutinesHere(ctx, ws, msg) {
  const on = msg && msg.on;
  const fail = (detail) => ws.send(JSON.stringify({
    type: 'routines_here_failed', on: on === true, detail,
  }));
  const dir = getWorkspace();
  if (!dir) { fail('Open a workspace first.'); return; }
  if (typeof on !== 'boolean') { fail('Say whether routines are on or off.'); return; }
  if (typeof msg.workspace !== 'string' || msg.workspace !== dir) {
    fail('Rundock has moved to another workspace since this list was drawn.');
    return;
  }
  try {
    if (routinesHere.setOffHere(dir, !on)) {
      console.log(`[Routines] Routines turned ${on ? 'on' : 'off'} on this computer for this workspace`);
    }
  } catch (e) {
    console.error(`[Routines] Could not save routines ${on ? 'on' : 'off'} on this computer: ${e.message}`);
    fail(e.message);
    return;
  }
  const { rosterMessage } = require('../../agents/discovery.js');
  ctx.broadcast(JSON.stringify(rosterMessage()));
}

module.exports = { handleSetRoutinesHere };
