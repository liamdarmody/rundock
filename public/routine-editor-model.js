'use strict';
/**
 * The routine editor's model: what the editor offers, in what words, and what
 * it refuses.
 *
 * WHY THIS IS A MODULE AND NOT A VIEW. Everything this editor is judged on is
 * either a piece of copy or a rule about what can be picked. Written inline in
 * a view, both are reachable only by a browser, and "the local option says
 * this and not that" becomes a screenshot rather than a test. Pulled out here,
 * it is a node-requireable module with no DOM in it, so every word it ships
 * can be asserted.
 *
 * THE COPY RULE THIS FILE EXISTS TO HOLD, AND IT IS THE ONE MOST LIKELY TO BE
 * GOT WRONG. Where a routine runs is a choice between two options, and only
 * one of them is real in this release. `local` runs while Rundock is open on
 * this computer. The always-on option is reserved and refused, and its whole
 * point is that it keeps running while the computer is off. Those words belong
 * to that option and to nothing else. Written onto the local option they would
 * advertise the single thing this release cannot do, at the exact moment the
 * user is choosing. So each option carries its OWN copy, as data, and the
 * sentence and the confirmation line read it off the chosen option rather than
 * concatenating a string that happens to be right for one of them.
 *
 * NOTHING HERE READS THE MACHINE IT RUNS ON. No clock, no locale, no ambient
 * time zone. A time label is arithmetic and a time zone is supplied by the
 * caller, so this module behaves identically wherever it runs and whenever.
 */
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockRoutineEditorModel = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // What can actually run, mirrored from lib/agents/routines.js.
  //
  // WRITTEN TWICE ON PURPOSE. A browser module cannot require a server one,
  // and the alternative to a second copy is a value shipped over the socket at
  // startup for a fact that has changed once in the product's life. What keeps
  // the two honest is not the comment: `what the editor offers matches what
  // the data model supports` compares them and fails if either moves alone.
  const RUN_ON_SUPPORTED = ['local'];

  /**
   * Where a routine runs, one entry per option, each carrying its own words.
   *
   * FOUR SEPARATE STRINGS PER OPTION, NOT ONE. `name` and `meta` are the row.
   * `sentence` is how the option reads inside the plain-words preview, which
   * is a different grammatical position and therefore different words ("this
   * computer", not "This computer"). `setupLabel` is the way in for an option
   * that is not set up. Keeping them apart is what lets every surface read the
   * option instead of rebuilding its own version of the same sentence.
   *
   * SELECTABILITY IS COMPUTED, NEVER DECLARED. It is membership of the
   * supported set, so the reserved option cannot become pickable by someone
   * editing a boolean here; it becomes pickable when the product can honour
   * it, and not before.
   */
  const RUN_ON = [
    {
      value: 'local',
      name: 'This computer',
      meta: 'Runs while Rundock is open here.',
      sentence: 'this computer',
      setupLabel: null,
    },
    {
      value: 'agent-computer',
      name: 'Your Agent Computer',
      // The promise that belongs here and nowhere else.
      meta: 'Not set up yet. Keeps your files synced, and keeps this routine running while your computer is off.',
      sentence: 'your Agent Computer',
      setupLabel: 'Set up an Agent Computer',
    },
  ];

  /**
   * The limitation a synced workspace hits, said plainly where the choice is
   * made.
   *
   * There is no machine identity in a routine and nothing coordinates two
   * copies of a workspace, so a workspace opened on four computers is four
   * separate local schedulers. Each keeps the guard that stops a re-fire in
   * memory, filled once when it starts, so each has its own idea of what has
   * already run for as long as it stays up. That is four runs, and no sync
   * tool changes it. None of it is solvable in this release, so the copy says
   * what happens instead of leaving the user to find out.
   */
  const RUN_ON_CAVEAT = 'Routines run on the machine they were made on. '
    + 'A workspace open on more than one computer runs its routines on each of them.';

  /**
   * What happens to this routine when its workspace is not the one open, said
   * where the routine is being made rather than in documentation met later.
   *
   * There is one scheduler and it serves the open workspace. Somebody with
   * three workspaces is therefore making a routine that runs in one of the
   * three, and nothing on this screen said so: they finished the editor
   * believing they had scheduled something that fires whenever Rundock is up.
   *
   * IT NAMES THE CATCH-UP IN THE SAME BREATH, because without it the sentence
   * reads as "you will lose runs" and the answer for most people is that they
   * will not: coming back to the workspace the same day serves the slot.
   */
  const WORKSPACE_CAVEAT = 'Rundock runs the routines of the workspace that is open. '
    + "While you are in another workspace this one's routines do not run, "
    + 'and a slot that goes by is caught up when you open it again that same day.';

  const RUN_ON_LABEL = 'Run on';

  // The frequencies the scheduler recognises, and only those.
  //
  // The mock illustrates this field with the word "weekday". The scheduler
  // reads `every day at HH:MM` or `every <weekday name> at HH:MM` and nothing
  // else, so a routine saved as "every weekday" would parse, save, appear in
  // the list and never once fire. Offering it would be the same defect as
  // promising a run while the computer is off: a control that says something
  // the product does not do. Every value here round-trips through the
  // scheduler's own format, asserted in the model's tests.
  const FREQUENCIES = [
    { value: 'day', label: 'day' },
    { value: 'monday', label: 'Monday' },
    { value: 'tuesday', label: 'Tuesday' },
    { value: 'wednesday', label: 'Wednesday' },
    { value: 'thursday', label: 'Thursday' },
    { value: 'friday', label: 'Friday' },
    { value: 'saturday', label: 'Saturday' },
    { value: 'sunday', label: 'Sunday' },
  ];

  // The lead line above each step. The agent's name is substituted rather than
  // concatenated, so every word the editor ships is in this object and a copy
  // check can read all of it.
  const STEP_LEADS = {
    pick: 'Step 1 of 2. Pick a skill {agent} already has.',
    pickAny: 'Step 1 of 2. Pick a skill any of your agents already has.',
    schedule: 'Step 2 of 2. Say when to run it, in plain terms.',
    empty: 'Routines schedule skills your agents already have. Build one and it will show up here.',
    loading: 'Looking for skills your agents can run.',
    build: 'Build a skill',
  };

  // Where save goes. A routine that has been written belongs on the list of
  // routines, so the editor's job finishes by leaving. Named here rather than
  // in the view because it is a fact about the flow, and a view that decides
  // its own exit is how two entries into one editor end up leaving to two
  // different places.
  const SAVE_DESTINATION = 'routines';

  // ===== THE RUN-ON FIELD =====

  function runOnOptions() {
    return RUN_ON.map(option => ({
      value: option.value,
      name: option.name,
      meta: option.meta,
      sentence: option.sentence,
      setupLabel: option.setupLabel,
      selectable: RUN_ON_SUPPORTED.indexOf(option.value) !== -1,
    }));
  }

  function runOnOption(value) {
    return runOnOptions().filter(o => o.value === value)[0] || null;
  }

  /**
   * The field as one thing: its label, its options and its caveat.
   *
   * The caveat is a PROPERTY OF THE FIELD rather than a loose export, because
   * the requirement is that it appears where the choice is made. A separate
   * constant can be rendered on a help page and nowhere else while every test
   * still passes; a field that carries it cannot be rendered without it.
   */
  function runOnField() {
    return { label: RUN_ON_LABEL, options: runOnOptions(), caveat: RUN_ON_CAVEAT };
  }

  // ===== THE SKILL PICKER =====

  /**
   * What can be scheduled, and for whom.
   *
   * Two entries reach this. From an agent's page the choice is that agent's,
   * so it is filtered to skills assigned to it and no row repeats the name.
   * From the routines view there is no agent yet, so every agent's skills are
   * offered and each row names which agent runs it, because that is the fact
   * the reader is missing.
   *
   * A SKILL WITH NO AGENT IS NOT OFFERED. A routine is declared on an agent
   * file, so a skill nothing is assigned to has no file to be written into.
   * Offering it would produce a picker whose selection cannot be saved.
   *
   * One row per skill and agent pair: a skill two agents both have is two
   * different routines, and the reader has to be able to say which.
   */
  function skillChoices(input) {
    const skills = (input && input.skills) || [];
    const agentId = (input && input.agentId) || null;
    const options = [];

    for (const skill of skills) {
      const assigned = (skill && skill.assignedAgents) || [];
      for (const agent of assigned) {
        if (agentId && agent.id !== agentId) continue;
        options.push({
          id: skill.id,
          key: `${skill.id}:${agent.id}`,
          name: skill.name,
          slug: skill.slug || skill.id,
          agentId: agent.id,
          // Named only where the reader has not already chosen the agent.
          agentName: agentId ? null : (agent.name || null),
        });
      }
    }

    return {
      options,
      // The zero-skills state is an OFFER. A workspace with nothing to
      // schedule has not failed at anything; it has not built a skill yet, and
      // the editor's job at that moment is to say where one comes from.
      createSkill: options.length === 0,
      createSkillLabel: STEP_LEADS.build,
      emptyLead: STEP_LEADS.empty,
    };
  }

  function stepLead(input) {
    const agentName = (input && input.agentName) || null;
    if (!agentName) return STEP_LEADS.pickAny;
    return STEP_LEADS.pick.replace('{agent}', agentName);
  }

  // ===== THE SENTENCE BUILDER =====

  /**
   * Every time the editor offers, on the half hour, labelled in plain clock
   * words.
   *
   * BUILT BY ARITHMETIC, NOT BY A LOCALE FORMATTER. `toLocaleTimeString` reads
   * the runner's locale and ICU build, which would make this list, and every
   * test of it, a statement about the machine rather than about the code.
   */
  function times() {
    const out = [];
    for (let minutes = 0; minutes < 24 * 60; minutes += 30) {
      const hour = Math.floor(minutes / 60);
      const minute = minutes % 60;
      const value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      const hour12 = hour % 12 === 0 ? 12 : hour % 12;
      const label = `${hour12}:${String(minute).padStart(2, '0')}${hour < 12 ? 'am' : 'pm'}`;
      out.push({ value, label });
    }
    return out;
  }

  function frequency(value) {
    return FREQUENCIES.filter(f => f.value === value)[0] || null;
  }

  function timeOption(value) {
    return times().filter(t => t.value === value)[0] || null;
  }

  /**
   * Assemble a schedule from the words the builder offered.
   *
   * BOTH HALVES ARE LOOKED UP, NEVER FORMATTED FROM THE INPUT. That is the
   * whole difference between a sentence builder and a text field with a
   * friendly label: a value that was not offered assembles into nothing, so a
   * cron expression pasted into either field produces null rather than a
   * routine that saves and never fires.
   */
  function buildSchedule(input) {
    const freq = frequency(input && input.frequency);
    const time = timeOption(input && input.time);
    if (!freq || !time) return null;
    return `every ${freq.value} at ${time.value}`;
  }

  /**
   * The plain sentence the editor shows back.
   *
   * The run-on clause is read off the chosen option. A fixed string here would
   * be right for one option and a lie about the other, which is the defect
   * this whole module is shaped around.
   */
  function previewSentence(input) {
    const freq = frequency(input && input.frequency);
    const time = timeOption(input && input.time);
    const option = runOnOption(input && input.runOn);
    const skillName = (input && input.skillName) || null;
    if (!freq || !time || !option || !skillName) return null;
    return `Every ${freq.label} at ${time.label}, run: ${skillName}, on ${option.sentence}.`;
  }

  // ===== TIME ZONES, IN WORDS =====

  /**
   * A zone identifier as the place a person would say.
   *
   * Never an offset. An offset is the one form that is both precise and
   * useless to read, and it changes twice a year while the place does not.
   */
  function timezoneWords(zone) {
    if (!zone || typeof zone !== 'string') return null;
    const parts = zone.split('/');
    const place = parts[parts.length - 1].replace(/_/g, ' ').trim();
    return place || null;
  }

  function timezoneCaption(input) {
    const words = timezoneWords(input && input.zone);
    if (!words) return null;
    const agentName = (input && input.agentName) || null;
    const who = agentName || 'Your agents';
    const verb = agentName ? 'reads' : 'read';
    return `Your time zone: ${words}. ${who} ${verb} this in your local time, never the Agent Computer's.`;
  }

  /**
   * The line under the finished sentence: the zone in words, then what the
   * chosen option promises.
   *
   * Second reader of the same per-option copy. Both this and the preview
   * sentence go wrong together or not at all, which is the point of the option
   * carrying its own words.
   */
  function readyCaption(input) {
    const words = timezoneWords(input && input.zone);
    const option = runOnOption(input && input.runOn);
    if (!option) return null;
    return words ? `${words} time. ${option.meta}` : option.meta;
  }

  // ===== WHAT SAVE PRODUCES =====

  /**
   * The routine a save would write, or null.
   *
   * REFUSES THE RESERVED TARGET HERE AS WELL AS IN THE PICKER. The picker not
   * offering it is a fact about one screen; this is the fact about the data.
   * A caller that reaches this function with the reserved value, however it
   * got there, gets nothing rather than a routine nothing can run.
   *
   * The prompt is derived from the skill rather than typed. Routines schedule
   * skills, never freeform instructions, so there is no prompt field on this
   * screen and nothing for a user to get wrong.
   */
  function routineDraft(input) {
    const skill = (input && input.skill) || null;
    const runOn = (input && input.runOn) || null;
    if (!skill) return null;
    if (RUN_ON_SUPPORTED.indexOf(runOn) === -1) return null;
    const schedule = buildSchedule(input);
    if (!schedule) return null;
    const slug = skill.slug || skill.id;
    return {
      agentId: (input && input.agentId) || null,
      name: skill.name,
      schedule,
      skill: slug,
      prompt: `Run the ${slug} skill.`,
      runOn,
    };
  }

  return {
    RUN_ON_SUPPORTED, RUN_ON_CAVEAT, WORKSPACE_CAVEAT, RUN_ON_LABEL, FREQUENCIES, STEP_LEADS, SAVE_DESTINATION,
    runOnOptions, runOnOption, runOnField,
    skillChoices, stepLead,
    times, buildSchedule, previewSentence,
    timezoneWords, timezoneCaption, readyCaption,
    routineDraft,
  };
}));
