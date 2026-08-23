'use strict';
/**
 * What the Skills view says when the workspace has no skills.
 *
 * WHY A MODULE FOR FOUR LINES. The same reason the routines list and the
 * routine editor each have one. Everything this pane is judged on is copy, and
 * copy written inline in a render is reachable only by a browser: the rule
 * "an empty state ends in a specific next step" becomes a screenshot instead
 * of a test. Pulled out here, every word this pane ships can be asserted.
 *
 * THE THREE STATES THIS SURFACE HAS, and they are not two. Skills have not
 * arrived, there are no skills, and there are skills. Only the middle one is
 * an offer. Showing it while the reply is in flight tells somebody with a
 * dozen skills that they have none, which is the interface saying something
 * false to the most confident reader it has.
 *
 * IT POINTS ONE STEP BACK UP THE CHAIN. A skill is declared on an agent, in
 * the agent file's `skills:` frontmatter; a routine schedules a skill. So the
 * three surfaces are a chain, agents then skills then routines, and an empty
 * one names the step before it rather than something sideways. The step before
 * a skill is the agent that writes skills, which is why this sentence names
 * the guide and why it is the sentence that goes when there is no guide to
 * name.
 *
 * THE ACTION IS THE EDITOR'S WORD, NOT A SECOND ONE. `Build a skill` and the
 * loading line both come from routine-editor-model.js, because the reader
 * meeting this pane is the same reader who meets that state one screen away,
 * and two labels for one offer is exactly the drift these surfaces were
 * reconciled to remove.
 */
(/** @param {any} root @param {(editor: any) => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./routine-editor-model.js'));
  else root.RundockSkillsModel = factory(root.RundockRoutineEditorModel);
}(typeof self !== 'undefined' ? self : this, function (editor) {

  // What the pane calls itself. A bare plural, like every other panel and
  // every other section heading.
  const TITLE = 'Skills';

  /**
   * The four slots, in the shape every empty state in this product uses.
   *
   * STATE says what is true right now, in three or four words, and is never a
   * welcome. MECHANISM says what the thing is and what happens after, so the
   * reader knows what they are choosing rather than being told to choose. The
   * ACTION is the one thing to press, never two. There is no ASIDE, because
   * an aside names a second real way in and there is no second way to get a
   * skill.
   *
   * The Doc sentence is its own field rather than the tail of the body, and
   * that split is load-bearing: it is the half that has to go when there is no
   * guide on the team, and a sentence spliced out of a paragraph at render
   * time is a sentence nothing can assert.
   */
  const EMPTY = {
    lead: 'No skills yet.',
    body: 'A skill is a job written down once, so an agent does it the same way every time '
      + 'and you can put it on a schedule.',
    guideLine: 'Tell Doc what you find yourself repeating and he will write the first one.',
    action: editor.STEP_LEADS.build,
  };

  /**
   * The pane, in whichever of its three states the workspace is in.
   *
   * @param {{loading?: boolean, hasGuide?: boolean}} [input]
   * @returns {{lead: string|null, body: string, action: string|null, aside: null}}
   */
  function emptyState(input) {
    // NOTHING IS KNOWN YET, SO NOTHING IS CLAIMED, and that includes the state
    // line: "No skills yet" is a claim about a list that has not arrived.
    if (input && input.loading) {
      return { lead: null, body: editor.STEP_LEADS.loading, action: null, aside: null };
    }
    const hasGuide = !!(input && input.hasGuide);
    return {
      lead: EMPTY.lead,
      // The state and the mechanism are true whoever is on the team. Only the
      // sentence naming an agent goes when that agent is not there.
      body: hasGuide ? `${EMPTY.body} ${EMPTY.guideLine}` : EMPTY.body,
      action: hasGuide ? EMPTY.action : null,
      aside: null,
    };
  }

  return { TITLE, EMPTY, emptyState };
}));
