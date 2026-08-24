'use strict';
/**
 * Every user-facing sentence that names the guide, in one object.
 *
 * WHY THESE ARE HERE AND NOT AT THE CALL SITES. `getGuide()` resolves the guide
 * by `type === 'platform'` and has never resolved it by name. Four sentences a
 * person reads named one anyway, so a workspace whose platform agent is called
 * anything else was told to talk to somebody it does not have, with the button
 * beside the sentence opening a conversation with a differently named agent.
 * On the shipped default workspace the name happens to be right, which is
 * exactly why four surfaces carried it for as long as they did.
 *
 * THE NAME IS A SLOT AND THE SLOT IS SUBSTITUTED, NEVER CONCATENATED, which is
 * the rule `STEP_LEADS.pick` in routine-editor-model.js already states and the
 * reason it gives: every word a surface ships stays readable in one object, so
 * a copy check can read all of it. A view that built a sentence around a name
 * would put half the copy at the call site, where nobody reviewing copy looks.
 *
 * AND NO SENTENCE CARRIES A PRONOUN FOR THE AGENT IT NAMES. The name is the
 * only thing this code knows about a guide, so "he" is a guess and "they" is a
 * different guess.
 */
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockGuideCopy = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  const GUIDE_COPY = {
    // The team sidebar, on a workspace with no team on it.
    sidebar: 'No team agents yet. {agent} can explore this workspace and create a team for you.',
    // The conversations pane, in the same state, where the question is who to
    // talk to rather than who is on the team.
    conversations: '{agent} can explore this workspace and set up your agent team.',
    // The org chart on a workspace with nothing in it yet.
    fresh: 'Fresh workspace. {agent} can help you set up your agent team from scratch.',
    // The button on an agent that has never been set up. A label rather than a
    // sentence, and a slot for the same reason.
    setup: 'Setup with {agent}',

    // THE TWO SURFACES THAT DRAW WITHOUT A GUIDE, and only those two.
    //
    // The sidebar and the conversations pane render their sentence only where
    // a platform agent exists, so with none there is nothing to say and they
    // say nothing. The other two draw regardless: the org chart's fresh state
    // and the Setup button are on the page whether or not anything can answer
    // them, so each needs a line that names no agent. Both keep their state
    // and lose only the part that named somebody, which is the rule the empty
    // states settled: dropping the agent drops the agent, not the next step.
    freshNoGuide: 'Fresh workspace. Add an agent to this workspace to get started.',
    setupNoGuide: 'Set up this agent',
  };

  /**
   * One line, named through the slot or not naming anybody.
   *
   * A GUIDE WITH NO NAME IS NOT A GUIDE A SENTENCE CAN NAME. The roster always
   * resolves a display name, falling back to the agent's id, so an empty name
   * is a guard rather than a state anybody should meet. It resolves the way an
   * absent guide does, because a sentence with an empty slot in it is worse
   * than the agent-independent one.
   *
   * Returns null where there is no guide and no line for that case, which is
   * the honest answer for a surface that draws nothing without one.
   *
   * @param {string} key
   * @param {string|null} [guideName]
   * @returns {string|null}
   */
  function guideLine(key, guideName) {
    const name = guideName || null;
    if (!name) return GUIDE_COPY[`${key}NoGuide`] || null;
    const line = GUIDE_COPY[key];
    return line ? line.replace('{agent}', name) : null;
  }

  return { GUIDE_COPY, guideLine };
}));
