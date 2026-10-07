// The one-line strip shown the first time this computer opens a workspace
// that arrived with routines switched on. Pure: no DOM, following
// public/update-strip-view.js.
//
// The server holds those routines until the person allows them here
// (lib/agents/approval-locality.js). The strip names them, offers to allow
// them, and offers Review, which opens Routines, where each has the approve
// step it always had. Closing it leaves them held, and it does not return.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockHeldRoutines = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  function named(r) {
    const name = String((r && r.name) || '').trim();
    const agent = String((r && r.agent) || '').trim();
    return agent ? `${name} (${agent})` : name;
  }

  function list(items) {
    if (items.length <= 1) return items.join('');
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  }

  // What the strip says and what its button is called, or null for nothing
  // to show.
  function heldStrip(routines) {
    const held = Array.isArray(routines) ? routines.filter((r) => r && r.name) : [];
    if (!held.length) return null;
    const one = held.length === 1;
    const text = one
      ? `This workspace came with a routine switched on: ${named(held[0])}. It won't run on this computer until you allow it.`
      : `This workspace came with ${held.length} routines switched on: ${list(held.map(named))}. They won't run on this computer until you allow them.`;
    const allowLabel = one ? 'Allow it' : held.length === 2 ? 'Allow both' : 'Allow all';
    return { text, allowLabel, reviewLabel: 'Review', closeLabel: 'Close' };
  }

  return { heldStrip };
}));
