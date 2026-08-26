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
   *
   * TIGHTENED IN THE DESIGN REVIEW PASS, from two sentences of 41 words to
   * two clauses of 32, joined as one sentence rather than two: "so" carries
   * the cause the reader needs (this workspace, not that one) in fewer words
   * than a full stop and a restart did. Every phrase the tests pin (the rule,
   * "do not run", "caught up") is still here in the same order; what went is
   * padding around them ("While you are in", "when you open it again").
   */
  const WORKSPACE_CAVEAT = 'Rundock only runs the routines of the workspace that is open, '
    + "so this one's do not run while you are elsewhere. "
    + 'A missed slot is caught up the same day you return.';

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

  /**
   * The step that decides WHEN a routine runs, as one thing, including the
   * sentence that says WHERE it will run.
   *
   * SAME RULE AS `runOnField`, one level out. A caveat kept as a loose export
   * can be rendered on a help page and nowhere else with every test still
   * green; a caveat carried by the thing it qualifies cannot be rendered
   * without it. The run-on caveat qualifies a FIELD, so the field carries it.
   * This one qualifies the whole step, because what it says is true of the
   * routine being made rather than of any one control on the screen, so the
   * step carries it.
   *
   * The frequencies and times come back on the same object for the same
   * reason: a view that assembled the step out of three separate exports could
   * drop this one and still draw a complete-looking step.
   */
  function scheduleStepFields() {
    return {
      lead: STEP_LEADS.schedule,
      frequencies: FREQUENCIES,
      times: times(),
      runOn: runOnField(),
      workspaceCaveat: WORKSPACE_CAVEAT,
    };
  }

  // ===== THE SKILL PICKER =====

  /**
   * Why an unassigned skill cannot be scheduled, said once and read by both
   * surfaces that have to say so: the routines view's own empty state, when
   * every skill the workspace has is unassigned, and a skill's own page,
   * when that specific skill is. ONE STRING, so the two cannot drift into
   * two different explanations of the same fact.
   *
   * NEITHER 'NOBODY HAS' NOR 'NO AGENT HAS', DELIBERATELY. A skill's own
   * page, directly above where this string is shown, already describes an
   * unassigned skill as available to all agents, and a reason phrased as a
   * denial that any agent had it would contradict the card sitting above it
   * on the same page. So this states the MECHANISM instead: a routine is
   * declared on one specific agent's file, which is a fact about routines
   * rather than a claim about who has the skill, and it holds together with
   * the skill being available to every agent rather than instead of it.
   *
   * NO DEICTIC EITHER, so 'a skill' rather than 'this skill'. The routines
   * view can carry this state with any number of unassigned skills and
   * names none of them, so 'this skill' would point at nothing there, and
   * with more than one it would be false on the skill's own page too: there
   * is no single 'this skill' once the workspace has several. Stated as a
   * general fact about a skill, it reads true wherever it is shown and for
   * however many skills the state applies to.
   */
  const UNASSIGNED_REASON = "A routine is written into one specific agent's file, "
    + 'so a skill has to be assigned to a specific agent before it can be scheduled.';

  /**
   * A skill's assigned agents, safe against a skill with none and against
   * `skill` itself being missing. The one place that reads `assignedAgents`,
   * so `skillChoices` below has a single spot to trust it from rather than
   * two copies of the same defensive lookup that could drift apart.
   */
  function assignedAgentsOf(skill) {
    return (skill && skill.assignedAgents) || [];
  }

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
      const assigned = assignedAgentsOf(skill);
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
      // A FACT ABOUT THE SKILLS SUPPLIED, NOT ABOUT `options`, and so NOT
      // SCOPED BY `agentId`. `options` answers "what can this call offer",
      // which for a scoped call is silent about skills belonging to other
      // agents; a workspace where every skill belongs to somebody else would
      // read as "unassigned" under a scoped reading, which is false. This
      // reads `skills` directly instead, true only when at least one was
      // supplied and none of them has an agent, which is true or false the
      // same way whichever scope the call was made with.
      onlyUnassignedSkills: skills.length > 0
        && skills.every(skill => assignedAgentsOf(skill).length === 0),
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
    return `Run ${skillName} every ${freq.label} at ${time.label}, on ${option.sentence}.`;
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
    UNASSIGNED_REASON,
    runOnOptions, runOnOption, runOnField, scheduleStepFields,
    skillChoices, stepLead,
    times, buildSchedule, previewSentence,
    timezoneWords, timezoneCaption, readyCaption,
    routineDraft,
  };
}));
