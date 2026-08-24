'use strict';
// The routines sidebar's scope list: which rows it holds, what each one
// counts, and what it says when it holds no rows at all.
//
// WHY THIS IS A MODULE AND NOT A RENDER. Every word this panel ships is here,
// and every rule about which rows exist is here, because a copy rule or an
// ordering rule written inline in a render is reachable only by a browser. The
// routines list made the same split for the same reason, and the panel keeps
// it so the two surfaces cannot drift apart in private.
//
// IT IS A SCOPE LIST AND NOT A ROSTER, and the difference is the whole point.
// A roster answers "who is on the team". This answers "whose routines am I
// looking at", so an agent that owns nothing is not a row: it would be an
// option that filters to nothing, offered next to options that do not.
//
// ORDER IS THE ROSTER'S, NEVER THE COUNT'S. A row that appears or disappears
// at the bottom of a short list goes unnoticed; a row that MOVES does not. In
// count order every added routine reshuffles the panel under a reader who had
// learnt where things were, to say something the counts beside the names
// already say.
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockRoutinesScopeModel = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // The panel's own words, all of them, in one object a copy check can read.
  //
  // `none` IS NOT THE PANE'S SENTENCE, and that is deliberate rather than a
  // near miss. The pane already leads with "No routines yet." and offers the
  // way out of it. A panel that led with the same sentence would say the same
  // nothing twice on one screen, so this says the other half: what the list
  // would hold once there is anything to hold.
  const COPY = {
    label: 'Routines',
    add: 'Add routine',
    all: 'All routines',
    none: 'Agents with routines are listed here.',
    // The agent's name is substituted rather than concatenated, for the same
    // reason the editor's step leads substitute theirs: every word shipped is
    // in this object.
    soleOwner: 'Every routine belongs to {agent}. Filtering by agent starts once a second agent has one.',
  };

  // Below this many owners the list is not drawn at all. A filter with one
  // option is decoration: it cannot change what the pane beside it shows, so
  // drawing it teaches the reader that scoping does nothing.
  const MIN_OWNERS = 2;

  const ALL = 'all';

  function soleOwnerLine(name) {
    return COPY.soleOwner.replace('{agent}', name);
  }

  function roster(input) {
    return input && Array.isArray(input.agents) ? input.agents : [];
  }

  /**
   * Every agent that owns at least one routine, in roster order, with its
   * count.
   *
   * A PAUSED ROUTINE IS COUNTED. It still exists, and the count answers how
   * many an agent has rather than how many will fire this week. A count that
   * qualified itself would have to qualify itself on every row, and the list
   * one click away already marks each paused routine plainly.
   */
  function owners(input) {
    const out = [];
    for (const agent of roster(input)) {
      if (!agent || !agent.routines || !agent.routines.length) continue;
      out.push({
        id: agent.id,
        name: agent.displayName || agent.name || agent.id,
        icon: agent.icon || '',
        colour: agent.colour || null,
        count: agent.routines.length,
      });
    }
    return out;
  }

  /**
   * The scope the panel should be on, given the scope it was last put on.
   *
   * THE FALLBACK IS THE POINT OF THIS FUNCTION. A reader scopes to an agent,
   * that agent's last routine is deleted, and the roster arrives again without
   * them. Held as it was, the panel would carry a selection whose row it no
   * longer draws, beside a list with nothing in it, and nothing on screen
   * would say why. Resolving on every read means the selection can only ever
   * name a row that exists, and All is what it falls back to.
   *
   * A scope also cannot survive the list itself being withdrawn: below two
   * owners there are no rows to select, so there is no scope either.
   */
  function resolveScope(input) {
    const scope = input ? input.scope : null;
    if (!scope || scope === ALL) return null;
    const list = owners(input);
    if (list.length < MIN_OWNERS) return null;
    return list.filter(o => o.id === scope).length ? scope : null;
  }

  /**
   * The panel, as rows and a line.
   *
   * All routines is pinned first and is present in EVERY state, including a
   * workspace where nobody owns one. It is what stops the panel being blank
   * when the list is empty, and what stops the panel reading as a filter that
   * has lost its options.
   */
  function scopeList(input) {
    const list = owners(input);
    const scope = resolveScope(input);
    const total = list.reduce((sum, o) => sum + o.count, 0);

    const all = { id: ALL, name: COPY.all, count: total, active: scope === null };
    if (list.length >= MIN_OWNERS) {
      return {
        all,
        owners: list.map(o => Object.assign({ active: o.id === scope }, o)),
        quiet: null,
      };
    }
    return {
      all,
      owners: [],
      quiet: list.length === 1 ? soleOwnerLine(list[0].name) : COPY.none,
    };
  }

  return { COPY, ALL, MIN_OWNERS, owners, resolveScope, scopeList, soleOwnerLine };
}));
