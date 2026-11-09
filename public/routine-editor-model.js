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
 * one of them is real in this release. `local` runs while Rundock is open, on
 * each computer that has the workspace open. The always-on option is reserved and refused, and its whole
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
(/** @param {any} root @param {(scheduleDays: any) => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./schedule-days.js'));
  else root.RundockRoutineEditorModel = factory(root.RundockScheduleDays);
}(typeof self !== 'undefined' ? self : this, function (scheduleDays) {

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
   * is a different grammatical position and therefore different words ("your
   * computers", not "Your computers"). `setupLabel` is the way in for an option
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
      // PLURAL, BECAUSE IT IS. A routine carries no machine: every computer
      // with this workspace open runs it, so "This computer" named a
      // different computer on each one and promised the routine ran on one.
      name: 'Your computers',
      meta: 'Runs on each computer that has this workspace open, while Rundock is open there.',
      sentence: 'your computers',
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
   * made, with the way out.
   *
   * There is no machine identity in a routine and nothing coordinates two
   * copies of a workspace, so a workspace opened on four computers is four
   * separate local schedulers, and four runs. The way to run them on one is
   * the switch on the Routines page that turns routines off on a computer,
   * for that workspace, without syncing. The second sentence is that way out,
   * exported on its own so the view can give it weight.
   */
  const RUN_ON_CAVEAT_ACTION = 'To run them on one only, turn routines off on the others, from the Routines page.';
  const RUN_ON_CAVEAT = 'If you use this workspace on more than one computer, each one runs its routines. '
    + RUN_ON_CAVEAT_ACTION;

  /**
   * Added to the local option's meta while routines are off on this computer
   * for this workspace, so the reader is not told it runs here when it will
   * not.
   */
  const RUN_ON_OFF_HERE = 'Routines are off on this computer, so this one will not run here until you turn them on, from the Routines page.';

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
   * "That day", not "the same day you return", which read as whichever day
   * you return: someone away over a weekend would expect Friday's slot on
   * Monday, and it does not run then.
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
    + 'A missed slot is caught up if Rundock is open again that day.';
  // A monthly slot is caught up anywhere in its month, so its note says that.
  const MONTHLY_WORKSPACE_CAVEAT = WORKSPACE_CAVEAT
    .replace('if Rundock is open again that day.', 'the next time Rundock is open that month.');

  const RUN_ON_LABEL = 'Run on';

  // The frequencies the scheduler recognises, and only those: every day,
  // every week on the days ticked under the sentence (`weekDays`), and every
  // month on a day from `monthDays`.
  //
  // WEEKDAYS ARE CHOSEN WITH THE DAYS, NOT AS A WORD OF THEIR OWN, and nor is
  // any single day. The word "weekday" was kept out of this list while the
  // scheduler could not read it, because a routine saved that way would have
  // saved, appeared in the list and never once fired. It reads it now, and a
  // week with Monday to Friday ticked is saved as `every weekday at HH:MM`. A
  // second way to choose the same days would be a second answer to which one
  // a routine reopens as. Every set of days the boxes can make is one the
  // scheduler reads, and every value here round-trips through the scheduler's
  // own format, asserted in the model's tests.
  const FREQUENCIES = [
    { value: 'day', label: 'day' },
    { value: 'week', label: 'week' },
    { value: 'month', label: 'month' },
  ];

  // The row of days under the sentence when the frequency is `week`: the word
  // before it, the name of the group, and what the preview line says while no
  // day is ticked, at rest and once Continue has been pressed.
  const WEEK_DAYS = {
    lead: 'on',
    label: 'Days this routine runs',
    none: 'Choose at least one day.',
    noneOnContinue: 'Choose at least one day to continue.',
  };
  const ALL_DAYS = scheduleDays.WEEK.map(d => d.value);

  // The lead line above each step. The agent's name is substituted rather than
  // concatenated, so every word the editor ships is in this object and a copy
  // check can read all of it.
  const STEP_LEADS = {
    pick: 'Step 1 of 2. Pick a skill {agent} already has.',
    pickAny: 'Step 1 of 2. Pick a skill any of your agents already has.',
    // The lead for a picker that already knows the skill and not the agent:
    // pressing a skill's own control when several agents have it. Asking the
    // reader to pick a skill there would ask a question they just answered.
    pickAgent: 'Step 1 of 2. Pick which agent runs {skill}.',
    schedule: 'Step 2 of 2. Say when to run it, in plain terms.',
    empty: 'Routines schedule skills your agents already have. Build one and it will show up here.',
    loading: 'Looking for skills your agents can run.',
    build: 'Build a skill',
    // EDITING IS NOT STEP TWO OF TWO, and this line exists because saying so
    // would be false. There is no step one behind it: the skill and the run
    // target are settled and are shown rather than asked for, so a reader who
    // arrived here arrived at the whole of what they came to change. A step
    // counter would offer a first step that does not exist, and its second
    // sentence says what is NOT about to move, which is the question somebody
    // editing a live routine actually has.
    edit: 'Say when this should run instead. Nothing else about the routine changes.',
  };

  /**
   * The routine's stored schedule, said back to a reader the editor cannot
   * show it to.
   *
   * WHY A SENTENCE IS OWED AT ALL. Agent files are written by hand, and the
   * scheduler reads more than this editor offers: any minute of the hour, in
   * any case. `readSchedule` refuses to pre-fill from a schedule the controls
   * cannot display, which is right, and leaves the form showing values that are
   * not the routine's with nothing accounting for the difference. So the note
   * names the stored schedule, verbatim, and says plainly what saving would do
   * to it.
   *
   * IT NAMES THE SCHEDULE RATHER THAN DESCRIBING IT. The reader wrote that line
   * themselves, in a file they can open, and quoting it is the only thing that
   * lets them tell whether replacing it matters.
   *
   * NEITHER A FAULT NOR A WARNING IN ITS TONE. A schedule this editor cannot
   * build is an ordinary thing to find: it may be one that runs perfectly well.
   * What is true is that the picker cannot show it, which is a fact about the
   * picker, so that is what the sentence says.
   */
  const STORED_SCHEDULE_NOTE = "This routine's schedule, {schedule}, is not one this editor can build. "
    + 'Saving replaces it with the one above.';
  // A hand-typed day 29 to 31, which the editor reopens on the last day.
  const LAST_DAY_NOTE = "This routine's schedule, {schedule}, is not one this editor can build. "
    + 'The last day of the month is selected instead. Saving replaces it.';

  function storedScheduleNote(input) {
    const schedule = input && typeof input.schedule === 'string' ? input.schedule.trim() : '';
    if (!schedule || readSchedule(schedule)) return null;
    if (input.unreadableMonthDay) return LAST_DAY_NOTE.replace('{schedule}', schedule);
    return STORED_SCHEDULE_NOTE.replace('{schedule}', schedule);
  }

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
  function runOnField(input) {
    const offHere = !!(input && input.offHere);
    const options = runOnOptions().map(option => (offHere && option.value === 'local'
      ? { ...option, meta: `${option.meta} ${RUN_ON_OFF_HERE}` }
      : option));
    return {
      label: RUN_ON_LABEL, options, caveat: RUN_ON_CAVEAT, caveatAction: RUN_ON_CAVEAT_ACTION,
    };
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
  function scheduleStepFields(input) {
    return {
      lead: STEP_LEADS.schedule,
      frequencies: FREQUENCIES,
      days: monthDays(),
      week: Object.assign({ days: weekDays() }, WEEK_DAYS),
      times: times(),
      runOn: runOnField(input),
      workspaceCaveat: input && input.frequency === 'month' ? MONTHLY_WORKSPACE_CAVEAT : WORKSPACE_CAVEAT,
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
    if (agentName) return STEP_LEADS.pick.replace('{agent}', agentName);
    // One skill, several agents that have it: the skill is settled and the
    // open question is the agent, so the lead asks that question and no other.
    const skills = (input && input.skills) || [];
    if (skills.length === 1 && assignedAgentsOf(skills[0]).length > 1) {
      return STEP_LEADS.pickAgent.replace('{skill}', skills[0].name || skills[0].id);
    }
    return STEP_LEADS.pickAny;
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

  /**
   * The days a monthly routine can run on: 1st to 28th, which every month
   * has, then the month's last day, drawn after a rule. Days 29 to 31 are not
   * offered because the scheduler does not read them: they are not in every
   * month, and nothing moves a slot to another date.
   */
  function monthDays() {
    const out = [];
    for (let n = 1; n <= 28; n++) {
      const tens = n % 100 >= 11 && n % 100 <= 13;
      const suffix = !tens && n % 10 === 1 ? 'st' : !tens && n % 10 === 2 ? 'nd' : !tens && n % 10 === 3 ? 'rd' : 'th';
      out.push({ value: String(n), label: `${n}${suffix}` });
    }
    out.push({ value: 'last', label: 'last day', afterRule: true });
    return out;
  }

  /**
   * The seven days a weekly routine can run on, Monday first: the box's value,
   * the short name it shows, and the full name it is called by, which
   * contains the short one.
   */
  function weekDays() {
    return scheduleDays.WEEK.map(d => ({ value: d.value, label: d.short, name: d.name }));
  }

  function frequency(value) {
    return FREQUENCIES.filter(f => f.value === value)[0] || null;
  }

  function monthDay(value) {
    return monthDays().filter(d => d.value === value)[0] || null;
  }

  /**
   * The builder's values after the frequency changes. Month starts on the 1st
   * unless a day is already chosen, any other frequency has no day, and the
   * time stays as it was.
   *
   * WEEK STARTS FROM WHAT THE SENTENCE SAID, so the days are never a blank
   * page and never a guess: from every day, all seven are ticked; from a
   * month, which names no day of the week, none are.
   */
  function chooseFrequency(choice, value) {
    const from = choice ? choice.frequency : null;
    const day = value === 'month' ? ((from === 'month' && choice.day) || '1') : null;
    let days = null;
    if (value === 'week') days = from === 'week' ? (choice.days || []).slice() : (from === 'day' ? ALL_DAYS.slice() : []);
    return { frequency: value, day, days, time: choice ? choice.time : null };
  }

  /** The days after one box is ticked or unticked, Monday first. */
  function toggleDay(days, value) {
    const was = Array.isArray(days) ? days : [];
    const now = was.indexOf(value) === -1 ? was.concat(value) : was.filter(v => v !== value);
    return ALL_DAYS.filter(v => now.indexOf(v) !== -1);
  }

  /**
   * Whether the builder is a week with no day ticked, which is the one
   * schedule it can hold that saves nothing. Continue stays pressable then,
   * and says why it went nowhere.
   */
  function needsADay(input) {
    return !!input && input.frequency === 'week' && !scheduleDays.daysWords(input.days);
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
    // The day is written without a leading zero, the form the save check and
    // the scheduler both read.
    if (freq && freq.value === 'month') {
      const day = monthDay(input.day);
      if (!day || !time) return null;
      return day.value === 'last'
        ? `on the last day of every month at ${time.value}`
        : `on day ${day.value} of every month at ${time.value}`;
    }
    // A week is saved in the one form its set has: all seven as every day,
    // Monday to Friday as every weekday, one day by its name, any other set
    // as its days in week order.
    if (freq && freq.value === 'week') {
      const days = scheduleDays.daysWords(input.days);
      return days && time ? `every ${days} at ${time.value}` : null;
    }
    if (!freq || !time) return null;
    return `every ${freq.value} at ${time.value}`;
  }

  /**
   * The reverse of `buildSchedule`: a schedule already on disk, taken back
   * apart into the two values the builder holds.
   *
   * WHY THIS EXISTS. Editing a routine's schedule opens the sentence builder
   * with that routine's current words already in it, and the builder's state is
   * a frequency and a time rather than a sentence. Something has to turn one
   * into the other, and this is the only place that does.
   *
   * BOTH HALVES ARE LOOKED UP, NEVER LIFTED OUT OF THE STRING, which is the
   * same rule `buildSchedule` follows and it matters more in this direction.
   * An agent file is written by hand as well as by this editor, so the string
   * arriving here can say anything. Handing back whatever the pattern captured
   * would pre-fill a form with values no control on it can show: a `<select>`
   * asked to select an option it does not have shows its first one instead, so
   * the reader would be looking at a schedule that is not theirs with nothing
   * saying so. A schedule this editor could not have built therefore reads back
   * as nothing, and the caller decides what to do about that.
   *
   * THE CASE IS FOLDED BEFORE THE LOOKUP, because the scheduler folds it before
   * it reads. `Every Monday at 07:00` is a routine that fires, so it is one this
   * has to be able to reopen; the values handed back are the editor's own, so
   * what is rebuilt afterwards is the canonical spelling rather than the
   * author's.
   */
  function readSchedule(schedule) {
    if (!schedule || typeof schedule !== 'string') return null;
    // The monthly forms, with one leading zero on the day read as the
    // scheduler reads it, and the day handed back in the builder's spelling.
    const monthly = /^on (?:day 0?([1-9]|1\d|2[0-8])|the last day) of every month at (\d{2}:\d{2})$/
      .exec(schedule.toLowerCase());
    if (monthly) {
      const time = timeOption(monthly[2]);
      if (!time) return null;
      return { frequency: 'month', day: monthly[1] ? String(Number(monthly[1])) : 'last', time: time.value };
    }
    // Every day, or a set of days read by the module the scheduler reads
    // them through: one day, weekday, or a list. A set reopens as a week with
    // exactly its days ticked, and all seven reopen as every day, which is
    // what saving them writes.
    const parts = DAILY_OR_DAYS.exec(schedule.toLowerCase());
    if (!parts) return null;
    const days = parts[1] === 'day' ? ALL_DAYS : scheduleDays.readDays(parts[1]);
    const time = timeOption(parts[2]);
    if (!days || !time) return null;
    if (days.length === 7) return { frequency: 'day', time: time.value };
    return { frequency: 'week', days, time: time.value };
  }
  const DAILY_OR_DAYS = new RegExp(`^every (day|${scheduleDays.DAYS}) at (\\d{2}:\\d{2})$`);

  /**
   * The plain sentence the editor shows back.
   *
   * The run-on clause is read off the chosen option. A fixed string here would
   * be right for one option and a lie about the other, which is the defect
   * this whole module is shaped around.
   */
  function previewSentence(input) {
    const when = whenWords(input);
    const option = runOnOption(input && input.runOn);
    const skillName = (input && input.skillName) || null;
    if (!when || !option || !skillName) return null;
    return `Run ${skillName} ${when}, on ${option.sentence}.`;
  }

  /**
   * "every month on the 15th at 9:00am": the builder's values in words, or
   * null for values it did not offer. The routine row's sentence reads this
   * too, so the two say a schedule the same way.
   *
   * A WEEK SAYS ITS DAYS as its saved form does: all seven as every day, one
   * day in full, several by their short names ("every Mon, Wed and Sun"), and
   * Monday to Friday as "every weekday", which the preview spells out once
   * for anyone whose working week is another five days. The row (`forRow`)
   * says only "weekday", so it stays one line.
   */
  function whenWords(input, forRow) {
    const freq = frequency(input && input.frequency);
    const time = timeOption(input && input.time);
    if (!freq || !time) return null;
    if (freq.value === 'week') {
      const days = scheduleDays.daysWords(input.days);
      if (!days) return null;
      const chosen = scheduleDays.WEEK.filter(d => input.days.indexOf(d.value) !== -1);
      let said = days;
      if (days === 'weekday') said = forRow ? 'weekday' : 'weekday (Monday to Friday)';
      else if (days !== 'day') said = chosen.length === 1 ? chosen[0].name : scheduleDays.joined(chosen.map(d => d.short));
      return `every ${said} at ${time.label}`;
    }
    if (freq.value !== 'month') return `every ${freq.label} at ${time.label}`;
    const day = monthDay(input.day);
    return day ? `every month on the ${day.label} at ${time.label}` : null;
  }

  /**
   * What Edit schedule opens on for a routine on the roster: its own values
   * when the builder can show them; for a hand-typed day 29 to 31, which the
   * server reports beside the schedule, month and the last day at the file's
   * time where the builder offers it; otherwise nothing, and the defaults.
   */
  function reopenSchedule(routine) {
    const read = readSchedule(routine && routine.schedule);
    if (read || !routine || !routine.unreadableMonthDay) return read;
    const time = timeOption(routine.unreadableMonthDay.time);
    return { frequency: 'month', day: 'last', time: time ? time.value : null };
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

  /**
   * Whose clock the schedule follows: the computer Rundock runs on, which on a
   * server is the server's.
   *
   * THE ZONE IS THE ONE THE SERVER REPORTS, never the window's. A window
   * reached through a tunnel can be in another zone, and the routine fires on
   * the server's hour whatever that window says. With no zone reported the
   * place is left out, and the caption still says whose clock it is.
   */
  function timezoneCaption(input) {
    const words = timezoneWords(input && input.zone);
    const agentName = (input && input.agentName) || null;
    const who = agentName || 'Your agents';
    const verb = agentName ? 'reads' : 'read';
    const place = words ? `, ${words} time` : '';
    return `${who} ${verb} this on the clock of the computer Rundock runs on${place}, never the Agent Computer's.`;
  }

  /**
   * The line under the finished sentence: the server's zone in words, then
   * what the chosen option promises.
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
    RUN_ON_SUPPORTED, RUN_ON_CAVEAT, RUN_ON_CAVEAT_ACTION, RUN_ON_OFF_HERE, WORKSPACE_CAVEAT, RUN_ON_LABEL, FREQUENCIES, STEP_LEADS, SAVE_DESTINATION,
    UNASSIGNED_REASON, STORED_SCHEDULE_NOTE, storedScheduleNote,
    runOnOptions, runOnOption, runOnField, scheduleStepFields,
    skillChoices, stepLead,
    times, monthDays, weekDays, chooseFrequency, toggleDay, needsADay, WEEK_DAYS,
    buildSchedule, readSchedule, reopenSchedule, previewSentence, whenWords,
    timezoneWords, timezoneCaption, readyCaption,
    routineDraft,
  };
}));
