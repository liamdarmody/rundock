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
 * THE FOUR SLOTS, AND WHERE THE SEAM BETWEEN THEM GOES. State, mechanism, next
 * step, aside. The seam that matters is between the middle two, and it was in
 * the wrong place until review found it: the mechanism slot was saying what a
 * skill is AND telling you what to do about it, and because the second half
 * named an agent, a workspace with no guide lost both. So:
 *
 *   THE MECHANISM NEVER NAMES AN AGENT AND NEVER MOVES. It is true on every
 *   workspace, so nothing can take it away.
 *
 *   THE NEXT STEP IS WHAT SWAPS, and it has an agent-independent form, so the
 *   slot is never empty and no state is a dead end. A next step is a sentence
 *   or a sentence plus one action, and never a generic encouragement.
 *
 * IT POINTS ONE STEP BACK UP THE CHAIN. A skill is declared on an agent, in
 * the agent file's `skills:` frontmatter; a routine schedules a skill. So the
 * three surfaces are a chain, agents then skills then routines, and an empty
 * one names the step before it rather than something sideways. Both next steps
 * below name that same step: one through the agent that writes skills, one
 * through the file they are written in.
 *
 * THE GUIDE'S NAME IS A SLOT, NEVER A LITERAL. `getGuide()` matches on
 * `type === 'platform'` and checks no name, so a sentence that hard-codes one
 * tells a workspace whose platform agent is called something else to talk to
 * somebody it does not have. The token is substituted rather than
 * concatenated, for the reason the editor's own STEP_LEADS already states:
 * every word this surface ships stays readable in one object, so a copy check
 * can read all of it.
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

  const EMPTY = {
    lead: 'No skills yet.',
    // Never names an agent, so nothing about the team can remove it.
    mechanism: 'A skill is a job written down once, so an agent does it the same way every time '
      + 'and you can put it on a schedule.',
    // The next step where there is a guide to name. `{agent}` is substituted,
    // never concatenated, and the sentence carries no pronoun for the agent it
    // names, because the name is the only thing this code knows about it.
    nextStep: 'Tell {agent} what you find yourself repeating, and that becomes your first skill.',
    // The next step where there is not.
    //
    // TRUE, AND CHECKED RATHER THAN ASSUMED. A skill is declared in an agent
    // file's `skills:` frontmatter, which parseSkills in lib/agents/discovery.js
    // reads. IT CARRIES NO ACTION, because opening a folder from an empty state
    // is a mechanism nobody has built, and a button that promises one would be
    // the same fault as copy that promises what the product cannot do.
    //
    // Shared with the routines no-skills state, which appends it to its own
    // shipped line, because both readers are missing the same fact and two
    // sentences for one fact is the drift this pass exists to remove.
    nextStepNoGuide: 'Skills are listed on each agent, so add one to an agent\'s file under '
      + 'skills: and it appears here.',
    action: editor.STEP_LEADS.build,
  };

  /**
   * The next step for a workspace, named through a slot or not named at all.
   *
   * A GUIDE WITH NO NAME IS NOT A GUIDE THIS SENTENCE CAN NAME. The roster
   * always resolves a display name, falling back to the agent's id, so this is
   * a guard rather than a state anybody should meet. It resolves the way an
   * absent guide does, because a sentence with an empty slot in it is worse
   * than the agent-independent one.
   *
   * @param {string|null} [guideName]
   */
  function nextStep(guideName) {
    const name = guideName || null;
    return name ? EMPTY.nextStep.replace('{agent}', name) : EMPTY.nextStepNoGuide;
  }

  /**
   * The pane, in whichever of its three states the workspace is in.
   *
   * @param {{loading?: boolean, guideName?: string|null}} [input]
   * @returns {{lead: string|null, body: string, action: string|null, aside: null}}
   */
  function emptyState(input) {
    // NOTHING IS KNOWN YET, SO NOTHING IS CLAIMED, and that includes the state
    // line: "No skills yet" is a claim about a list that has not arrived.
    if (input && input.loading) {
      return { lead: null, body: editor.STEP_LEADS.loading, action: null, aside: null };
    }
    const guideName = (input && input.guideName) || null;
    return {
      lead: EMPTY.lead,
      // Mechanism then next step, always both, in that order.
      body: `${EMPTY.mechanism} ${nextStep(guideName)}`,
      // The action belongs to the guide's next step and goes with it. The
      // other next step has none to offer, and says so by being a sentence.
      action: guideName ? EMPTY.action : null,
      // No aside: an aside names a second real way in, and there is no second
      // way to get a skill.
      aside: null,
    };
  }

  return { TITLE, EMPTY, nextStep, emptyState };
}));
