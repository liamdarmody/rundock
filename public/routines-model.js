'use strict';
/**
 * The routines list's model: what a row says, and in which of the three tones.
 *
 * WHY THIS IS A MODULE AND NOT A VIEW. The same reason the editor's model is
 * one. Everything this list is judged on is either a piece of copy or a rule
 * about which of four states a routine is in, and both are reachable only by a
 * browser once they are written inline in a render. Pulled out here, every
 * word this list ships can be asserted.
 *
 * THE RULING THIS FILE HOLDS, AND IT IS THE ONE MOST LIKELY TO BE UNDONE BY
 * SOMEBODY TIDYING. There are three tones, not two. A run that happened late
 * is a SUCCESS and must not be dressed as a warning. A slot that passed
 * unserved is HISTORY, not an error. Only a real failure is a failure. For
 * someone on a laptop, missing runs is the ordinary case, so an interface that
 * alarms every time the machine was shut overnight reads as broken while
 * behaving perfectly, and teaches its user to ignore the one signal that
 * matters.
 *
 * So: Ran on time and Caught up share the success colour, Caught up one weight
 * quieter because it is still a success. Missed is idle grey, the only state
 * where nothing ran at all. Failed is the danger colour. Amber appears
 * nowhere: the palette already spends it on "needs the user, not an error",
 * which none of these four states is, and amber reads as an alert whatever a
 * legend says it means.
 *
 * MISSED NAMES THE CAUSE, NOT THE ROUTINE. The machine being off is not the
 * routine failing, and the sentence says so.
 *
 * NOTHING HERE READS THE MACHINE IT RUNS ON. No clock, no locale, no ambient
 * time zone. `now` and every instant arrive from the caller, day and clock
 * words are arithmetic over local date components, and the zone is a string
 * passed in. So this module behaves identically wherever it runs and whenever,
 * and so does every test of it.
 */
(/** @param {any} root @param {(editor: any) => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./routine-editor-model.js'), require('./skills-model.js'));
  } else root.RundockRoutinesModel = factory(root.RundockRoutineEditorModel, root.RundockSkillsModel);
}(typeof self !== 'undefined' ? self : this, function (editor, skills) {

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  // WHERE THE THREE TONES ACTUALLY LIVE, and why they are not declared here.
  //
  // An earlier version of this file carried a table of colours and weights per
  // tone, so that the ruling "could be asserted". Nothing read it. The page's
  // colour comes from .run-status.ok and its neighbours in
  // public/styles/views/routines.css, so the table was a second statement of
  // the ruling that could agree with its tests forever while the stylesheet
  // said something else entirely: giving Missed the danger colour in CSS moved
  // the page and moved no test.
  //
  // A ruling this project spent three design rounds on cannot ship proven
  // against something nobody consumes. So the tone is a CLASS NAME here, the
  // colour and weight are the stylesheet's, and the ruling is asserted against
  // what the page resolves, in "the ruling, against what the page resolves" in
  // test/unit/routines-view.test.js.

  /**
   * The four outcomes, each carrying its own leading word and its own tone.
   *
   * EVERY PAIR DIFFERS ON AT LEAST TWO OF COLOUR, WEIGHT AND WORDING, so the
   * read survives both themes and a colour-blind eye. Ran on time states only
   * the time and takes no label, per the ruling: it reads as the time. The
   * other three lead with a flag before the fact.
   */
  const OUTCOMES = {
    'on-time': { tone: 'ok', lead: 'Ran' },
    'caught-up': { tone: 'ok-quiet', lead: 'Caught up' },
    'missed': { tone: 'neutral', lead: 'Missed' },
    'failed': { tone: 'failed', lead: 'Failed' },
  };

  /**
   * The offer made to a routine nobody has turned on yet.
   *
   * WHY THIS STATE EXISTS AT ALL. A routine whose file never carried `enabled`
   * was written by hand before this product could run one, beside a cron job
   * that is still doing the work. The reader treats that silence as "not yet"
   * rather than as consent, so after an upgrade these rows are the ones a
   * person meets first.
   *
   * AND WHY THE SENTENCE SAYS WHAT IT SAYS. The reader arriving here already
   * has the job running somewhere else. "Turn on" alone reads as tidying a
   * switch, and the thing they have to know before pressing it is that Rundock
   * will begin running the routine ITSELF, on top of whatever is running it
   * today. That is the sentence that stops a morning briefing going out twice.
   */
  const NOT_ENABLED = {
    lead: 'Not running.',
    body: 'Turn it on and Rundock will start running it on this schedule.',
    // WHEN THE FIRST RUN LANDS, said only where it is true.
    //
    // This reader most needs to know that a slot already gone today is caught
    // up within the minute: their own scheduler ran the same job this morning,
    // and an offer naming only the schedule would hand them the double run
    // this change exists to prevent, on the very first press.
    //
    // But that is not true on every row the offer appears on. A routine that
    // already ran today and was then switched off is suppressed by the run
    // guard until tomorrow, and a weekly routine turned on away from its
    // weekday does not run shortly at all. So the sentence is chosen from the
    // instant the server computed, which already accounts for both, rather
    // than asserted about all of them.
    catchUpGone: 'Its scheduled time has already gone, so it runs shortly after you turn it on.',
    catchUpAhead: 'Turned on now, it runs {when}.',
    label: 'Turn on',
  };

  /**
   * What a row says when the scheduler cannot read its schedule.
   *
   * THE SILENCE THIS ENDS. `parseSchedule` accepts two shapes and returns null
   * for everything else, at which point the tick skips the routine with no
   * error, no warning and no log line. A cron-scheduled routine then sits in a
   * first-class Routines view looking exactly like a routine, and the silence
   * has moved from a log nobody reads to a surface everybody reads. Migration
   * never touches a schedule, so every such entry survives an upgrade exactly
   * as written, which means anyone arriving from cron arrives with these.
   *
   * IT NAMES WHAT TO CHANGE, BY EXAMPLE. "Unsupported schedule" sends the
   * reader to documentation this product does not put in front of them. The
   * two shapes that work, written out, send them to the editor instead. Both
   * are given because a reader whose job is weekly should not have to guess
   * that the daily example generalises.
   */
  const SCHEDULE_PROBLEM = {
    lead: 'Rundock cannot read this schedule, so this routine will not run.',
    body: 'Change it to say every day at 07:00, or a weekday, like every Monday at 07:00.',
  };

  const LEAD = {
    title: 'Routines',
    lead: 'Every scheduled skill across your team, and when it runs next.',
    // SCOPED TO ONE AGENT, THE SENTENCE SAYS SO. A filtered list under an
    // unfiltered sentence reads as a list that has lost rows, which is the one
    // reading a header must never invite.
    //
    // THE NAME IS A SLOT AND NEVER A CONCATENATION, the same rule the editor's
    // own leads follow: the whole sentence is in this object, so a reviewer
    // reads the shipped copy here rather than assembling it out of a template
    // and a variable somewhere else.
    scopedLead: "Every scheduled skill {agent} runs, and when it runs next.",
  };

  /**
   * The header this view heads itself with: a title and the sentence under it.
   *
   * THE SUBTITLE IS THE LEAD SENTENCE, MOVED. It used to be a paragraph below
   * the heading; the component this view now shares with the skills view
   * carries it inside the header block instead, which is why it arrives from
   * here rather than being drawn separately.
   *
   * @param {{agentName?: string|null}} [input] the agent the list is scoped
   *   to, when it is scoped to one.
   */
  function header(input) {
    const agentName = (input && input.agentName) || null;
    return {
      title: LEAD.title,
      // THE NAME IS INSERTED, NEVER INTERPRETED. A string replacement reads
      // dollar sequences in what it is given as instructions: $& is the match,
      // $` and $' the text either side, $$ a literal dollar. An agent can be
      // named anything, so a display name carrying $& would put the slot's own
      // text back into the sentence instead of the name. A function
      // replacement is handed the match and returns a value, so nothing in
      // the name is read as a pattern.
      subtitle: agentName ? LEAD.scopedLead.replace('{agent}', () => agentName) : LEAD.lead,
    };
  }

  /**
   * What the list says when the server refused a pause or a delete.
   *
   * The server's own words are used whenever it sent any: it knows which of
   * several things went wrong and says so. This is the line for a refusal that
   * arrived with nothing in it, and the second sentence is the half that
   * matters to somebody who has just pressed Delete: every refusal on that
   * road returns before writing, so nothing has happened.
   */
  const ACTION_PROBLEM = 'That routine could not be changed. Nothing has been altered.';

  function actionProblem(input) {
    const message = input && typeof input.message === 'string' ? input.message.trim() : '';
    return message || ACTION_PROBLEM;
  }

  const EMPTY = {
    lead: 'No routines yet.',
    // Locked copy. Four options went to the owner and this is the one picked.
    body: 'Pick a tested skill and give it a schedule. Your agents take it from there.',
    // Agent-agnostic on purpose: this way in belongs to no agent, and the
    // picker it opens spans every agent's skills and names which runs each.
    action: 'Add routine',
    aside: 'Looking at a skill you already trust? You can also schedule it right from its own page.',
  };

  /**
   * WHICH empty state, decided mechanically rather than by taste.
   *
   * THE CHAIN IS WHAT MAKES THIS DECIDABLE. A skill is declared on an agent
   * and a routine schedules a skill, so the three surfaces are a chain: agents,
   * then skills, then routines. An empty one points one step back up that
   * chain, and the FIRST MISSING PREREQUISITE picks the variant.
   *
   * WHY THE LOCKED BODY CANNOT COVER BOTH. "Pick a tested skill and give it a
   * schedule" presupposes a tested skill. Gating quietly guaranteed one: you
   * could not reach this view without having had a routine, and you could not
   * have had a routine without a skill. A permanent rail entry removes the
   * guarantee and exposes a state the locked copy was never written for. Where
   * any skill exists the locked copy is untouched, aside included.
   *
   * BOTH REPLACEMENT LINES ALREADY SHIP, in the routine editor's own
   * zero-skills state, which is the same reader in the same state one screen
   * away. Writing a second sentence for a fact the product already has a
   * sentence for is the drift this reconciliation exists to remove, so these
   * are the editor's strings rather than copies of them.
   *
   * THE CONDITION IS THE PICKER'S OWN QUESTION, `skillChoices`, and not a new
   * one, so the two surfaces cannot disagree about whether a workspace has
   * skills. A skill no agent is assigned cannot be scheduled and therefore
   * does not count, which the picker already decides and this inherits.
   *
   * A THIRD VARIANT, FOR THE CASE THE CHAIN LEAVES OUT. "No skill exists" and
   * "a skill exists and nobody has it" both leave the picker's `options` at
   * zero, and until this pass both took the create-a-skill branch, which told
   * the second workspace to build the skill it already had. `skillChoices`
   * already knows the difference, having walked both `skills` and `options`
   * to answer its own question, so it reports it as `onlyUnassignedSkills`
   * rather than making this file recompute it as a second rule that could
   * disagree with the picker's own.
   *
   * AND IT WAITS. "Skills have not arrived yet" and "there are no skills" are
   * different states and only one of them is an offer. Without the wait, a
   * workspace that does have skills is told to build one for a beat on every
   * open.
   *
   * THE GUIDE ARRIVES AS A NAME, NOT AS A FLAG, and the type here is the
   * whole contract: a caller handed a boolean gets the no-guide variant with
   * nothing thrown, so documentation naming an input this never reads is a
   * silently wrong answer rather than an error.
   *
   * @param {{skills?: any[], loading?: boolean, guideName?: string|null}} [input]
   */
  function emptyState(input) {
    if (input && input.loading) {
      return { lead: EMPTY.lead, body: editor.STEP_LEADS.loading, action: null, actionKind: null, aside: null };
    }
    const choice = editor.skillChoices({ skills: (input && input.skills) || [] });
    // CHECKED BEFORE `createSkill`, WHICH IS ALSO TRUE HERE. Both a workspace
    // with no skill and a workspace whose only skill belongs to nobody leave
    // `options` empty, and until now that meant both took the create-a-skill
    // branch below, telling the second workspace to build the skill it
    // already has. `onlyUnassignedSkills` is the question `skillChoices`
    // already answers for this exact difference, so the branch reads it
    // rather than a new comparison written here that could disagree with it.
    if (choice.onlyUnassignedSkills) {
      return {
        lead: EMPTY.lead,
        // THE MECHANISM IS THE SKILL PAGE'S OWN SENTENCE, not a second one
        // written here: `editor.UNASSIGNED_REASON` is the exact string the
        // skill's own page states in its Schedule card when that skill has
        // no agent, so the two surfaces cannot end up disagreeing about why.
        body: `${editor.UNASSIGNED_REASON} Assign it to an agent and it will show up here.`,
        // NEITHER A BUTTON NOR AN ASIDE. Assigning a skill to an agent is
        // existing behaviour this state points at, not a control this pane
        // grows. And the aside the other states carry promises scheduling
        // "right from its own page", which is exactly the thing that page
        // withholds while the skill has no agent; offering it here would
        // have this state contradict the one it is naming.
        action: null,
        actionKind: null,
        aside: null,
      };
    }
    if (choice.createSkill) {
      // THE ACTION GOES WITH THE AGENT THAT FULFILS IT, AND THE NEXT STEP DOES
      // NOT. Dropping the button on its own would leave a line instructing an
      // action with nothing to press, so the agent-independent next step is
      // APPENDED to the shipped line rather than replacing it. The shipped
      // string stays whole: it already carries its own next step ("Build one
      // and it will show up here"), and it is the same string the editor ships
      // one screen away, so splitting it here would be this pass writing a
      // second version of a sentence the product already has.
      //
      // The appended sentence is the Skills pane's own, not a second copy of
      // it: both readers are missing the same fact, which is where a skill is
      // declared.
      const guideName = (input && input.guideName) || null;
      return {
        lead: EMPTY.lead,
        body: guideName ? choice.emptyLead : `${choice.emptyLead} ${skills.EMPTY.nextStepNoGuide}`,
        action: guideName ? choice.createSkillLabel : null,
        actionKind: guideName ? 'build-skill' : null,
        // No aside: the second way in it names is a skill's own page, and this
        // workspace has no skill to have one.
        aside: null,
      };
    }
    return {
      lead: EMPTY.lead, body: EMPTY.body,
      // Add routine opens the picker, which belongs to no agent, so it is not
      // the guide's to fulfil and does not go with them.
      action: EMPTY.action, actionKind: 'add-routine', aside: EMPTY.aside,
    };
  }

  /**
   * How late a run has to be before it is a catch-up rather than the ordinary
   * path.
   *
   * The tick is sixty seconds and measurably jittery, so a run a minute or two
   * after its slot is the scheduler doing its normal work and calling that
   * "caught up" would put the quieter tone on almost every row. Five minutes
   * is several ticks: past it, something kept the machine from serving the
   * slot, which is what the word describes.
   */
  const CATCH_UP_AFTER_MS = 5 * 60 * 1000;

  // THE INSTANT EVERY COMPARISON BELOW USES IS `lastStart`, THE MOMENT THE RUN
  // BEGAN, and the name is deliberate. The scheduler's stored `lastRun` is the
  // moment a finished run ENDED, so measuring against it would fold the run's
  // own duration into how late it was, and an agent run routinely takes longer
  // than the boundary above. A routine that fired exactly on its slot and
  // worked for eleven minutes would read as caught up. The server recovers the
  // start (lastRunStartedAt in lib/scheduler.js) and sends that; nothing here
  // ever sees the completion time, because nothing on this row is about it.

  function asDate(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  /**
   * Whole calendar days from `from` to `to`, counted as days and not as hours.
   *
   * Ten past midnight tomorrow is tomorrow even though it is under three hours
   * away, and half past eleven tonight is today even though it is nearly a
   * day. A millisecond difference divided by 86400000 gets both of those
   * wrong, which is why both ends are flattened to midnight first.
   */
  function dayGap(from, to) {
    const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
    return Math.round((b - a) / 86400000);
  }

  /**
   * The day an instant falls on, as a person would say it.
   *
   * Never a formatter. `toLocaleDateString` reads the runner's locale and ICU
   * build, which would make this a statement about the machine rather than
   * about the code, and would make every test of it one too.
   */
  function dayWords(instant, now) {
    const when = asDate(instant);
    const from = asDate(now);
    if (!when || !from) return null;
    const gap = dayGap(from, when);
    if (gap === 0) return 'today';
    if (gap === 1) return 'tomorrow';
    if (gap === -1) return 'yesterday';
    if (gap > -7 && gap < 7) return DAYS[when.getDay()];
    return `${when.getDate()} ${MONTHS[when.getMonth()]}`;
  }

  /** The clock, in the same plain words the editor offers times in. */
  function clockWords(instant) {
    const when = asDate(instant);
    if (!when) return null;
    const hour = when.getHours();
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    return `${hour12}:${String(when.getMinutes()).padStart(2, '0')}${hour < 12 ? 'am' : 'pm'}`;
  }

  /**
   * The zone as the place a person would say, or nothing.
   *
   * Read off the editor's model rather than written again here: one rule about
   * how a zone is said, in one place.
   */
  function zoneWords(zone) {
    return editor.timezoneWords(zone);
  }

  /** "today, 7:00am, London time", the shape every time in this list takes. */
  function timeWords(instant, now, zone) {
    const day = dayWords(instant, now);
    const clock = clockWords(instant);
    if (!day || !clock) return null;
    const place = zoneWords(zone);
    return place ? `${day}, ${clock}, ${place} time` : `${day}, ${clock}`;
  }

  /**
   * The plain sentence a routine reads as: its schedule, then the skill it
   * runs.
   *
   * BOTH HALVES ARE LOOKED UP IN THE EDITOR'S OWN LISTS, never formatted from
   * the string. A schedule the editor never offered has no plain words, so it
   * assembles into nothing rather than into a sentence that reads as though
   * the product understood it.
   */
  function scheduleWords(schedule) {
    if (!schedule || typeof schedule !== 'string') return null;
    const parts = /^every ([a-z]+) at (\d{2}:\d{2})$/.exec(schedule.toLowerCase());
    if (!parts) return null;
    const freq = editor.FREQUENCIES.filter(f => f.value === parts[1])[0];
    const time = editor.times().filter(t => t.value === parts[2])[0];
    if (!freq || !time) return null;
    return `Every ${freq.label} at ${time.label}`;
  }

  /**
   * The same sentence, as the two pieces it is made of.
   *
   * WHY THE PARTS RATHER THAN A SPLIT AT THE VIEW. The skill name is the one
   * reachable thing on a row, so the view has to draw it inside its own
   * element. Recovering it from the assembled string means matching
   * user-written text inside escaped markup, which is exactly the class of
   * thing the namesake counter above exists to avoid: a routine may be called
   * "run: something", and a name carrying a bracket or an ampersand does not
   * come back out of escaped markup as it went in.
   *
   * SO THE MODEL RETURNS THE PIECES AND THE VIEW COMPOSES THEM, which keeps
   * every word of this sentence asserted here rather than in a DOM test. The
   * assembled sentence is built FROM the parts rather than beside them, so the
   * two cannot say different things.
   *
   * `lead` carries its own trailing space. A caller that concatenates gets the
   * sentence back exactly; a caller that puts the name in its own element gets
   * the space on the outside of it, where a link's underline does not reach.
   */
  function sentenceParts(input) {
    const words = scheduleWords(input && input.schedule);
    const name = (input && input.name) || null;
    if (!words || !name) return null;
    return { lead: `${words}, run: `, name: name };
  }

  function routineSentence(input) {
    const parts = sentenceParts(input);
    return parts ? `${parts.lead}${parts.name}` : null;
  }

  /**
   * Which of the four states this routine is in, or null.
   *
   * WHAT HAPPENED LAST IS THE LATER OF TWO FACTS, and they come from two
   * stores that are kept apart for a reason stated at each of them: the run
   * state, which says when a run last happened and how it ended, and the slot
   * records, which say a scheduled slot went by while nobody was watching.
   * This reads both and writes to neither.
   *
   * A run still in flight names nothing. The run state holds one slot per
   * routine, so while a run is going there is no completed outcome to report,
   * and the row falls back to the single line revision 6 drew.
   */
  /**
   * Whether the most recent COMPLETED run failed.
   *
   * SEPARATED FROM `outcomeOf` BECAUSE TWO SURFACES ASK TWO DIFFERENT
   * QUESTIONS, and reading them as one question is what made this wrong.
   *
   * A ROW asks what happened most recently, which is the later of a run and a
   * slot that went by unserved, so a miss after a failure is what the row
   * says: it is the newer fact and it is the one that explains why nothing
   * has run since.
   *
   * THE RAIL asks whether the last completed run failed, full stop. A failure
   * followed by a night with the machine shut is still a failure nobody has
   * seen, and letting the miss mask it would hide the only alarming state in
   * the product behind the most ordinary event there is. So the dot is
   * decided here and the row's wording is decided by `outcomeOf`, which leans
   * on this for its own failure branch so the two cannot disagree about what
   * a failure IS while disagreeing about what masks it.
   *
   * A run still in flight has no completed outcome to report, and a routine
   * that has never run has none either.
   */
  function lastCompletedRunFailed(input) {
    const statusWord = (input && input.lastRunStatus) || null;
    if (statusWord === 'running') return false;
    if (!asDate(input && input.lastStart)) return false;
    // A run the process died inside did not succeed. It borrows the failure
    // tone rather than adding a fifth state nothing in the frame draws.
    return statusWord === 'failed' || statusWord === 'interrupted';
  }

  function outcomeOf(input) {
    const started = asDate(input && input.lastStart);
    const missedSlot = asDate(input && input.missedSlot);
    const statusWord = (input && input.lastRunStatus) || null;
    if (statusWord === 'running') return null;
    // A ROUTINE NOBODY TURNED ON DID NOT MISS ANYTHING.
    //
    // The slot store records every scheduled slot that went by unobserved, for
    // every routine, whatever the gate would have said about running it. That
    // split is deliberate: the store keeps the facts, and what to make of them
    // is decided here.
    //
    // Here, the missed line names its own cause: "Rundock was closed at 7:00am
    // yesterday". For a routine nobody has ever turned on, that cause is
    // false. Rundock may have been open all night; the routine was never in
    // service. It would also sit directly above an offer to turn the routine
    // on, so the row would explain an absence by an event that did not happen
    // and then offer to fix a different thing.
    //
    // ONLY THE MISSED OUTCOME IS WITHHELD. A run that happened, or failed, is
    // real history from when this routine was running, and hiding that would
    // be suppressing the truth rather than declining to invent it.
    // WITHHELD, NOT SHORT-CIRCUITED, and the difference is a run somebody
    // needs to see. Returning null here hid the whole status rather than the
    // missed outcome, so a routine that ran, failed, was switched off and then
    // had a slot pass went silent about the failure: the missed slot is the
    // newer fact, so this is the branch taken, and there is a real run
    // underneath it. Skipping only the outcome lets the evaluation below
    // report what actually happened.
    const heldBack = input && input.enabled === false;
    if (missedSlot && (!started || missedSlot > started) && !heldBack) return 'missed';
    if (!started) return null;
    if (lastCompletedRunFailed(input)) return 'failed';
    const lastSlot = asDate(input && input.lastSlot);
    // How late the run STARTED, with nothing about how long it then took.
    if (lastSlot && started - lastSlot >= CATCH_UP_AFTER_MS) return 'caught-up';
    return 'on-time';
  }

  /**
   * What happened last time, in the words and the tone that state gets.
   *
   * Caught up names BOTH times, the actual and the due, so it is legible as a
   * delay rather than an event with no explanation. Missed names the cause,
   * Rundock being closed, and the slot it was closed through.
   */
  function runStatus(input) {
    const kind = outcomeOf(input);
    if (!kind) return null;
    const now = asDate(input && input.now);
    const zone = (input && input.zone) || null;
    const outcome = OUTCOMES[kind];
    let text = null;
    if (kind === 'missed') {
      const slot = asDate(input.missedSlot);
      const place = zoneWords(zone);
      const when = `${clockWords(slot)} ${dayWords(slot, now)}`;
      text = `Missed: Rundock was closed at ${place ? `${when}, ${place} time` : when}`;
    } else if (kind === 'caught-up') {
      text = `Caught up: ran ${timeWords(input.lastStart, now, zone)}, due ${clockWords(input.lastSlot)}`;
    } else if (kind === 'failed') {
      text = `Failed: ${timeWords(input.lastStart, now, zone)}`;
    } else {
      text = `Ran ${timeWords(input.lastStart, now, zone)}`;
    }
    return { kind: kind, tone: outcome.tone, lead: outcome.lead, text: text };
  }

  /**
   * Whether anything on the team is in the one state the rail is allowed to
   * alarm about.
   *
   * THIS IS THE THREE-TONE RULING REACHING THE CHROME. A catch-up is a
   * success, a run in flight has no outcome yet, a slot that went by unserved
   * is history, and a paused routine is not going to run. Only a real failure
   * is a failure, and a dot that rose on anything else would teach its reader
   * to ignore the one signal that matters.
   *
   * PAUSED IS EXCLUDED BEFORE THE QUESTION IS ASKED, and it has to be rather
   * than merely happening to be. A paused routine has no next run by
   * definition, so it can never succeed again, so a dot raised by one could
   * never be cleared by the rule that clears dots. It would sit on the rail
   * until the routine was resumed or deleted, which is a permanent alarm about
   * something the user has already decided to stop.
   *
   * A LATER MISSED SLOT DOES NOT MASK A FAILURE HERE, which is where this
   * parts company with what a row says. See `lastCompletedRunFailed`.
   *
   * @param {Array<{lastStart?: any, lastRunStatus?: string|null, lastSlot?: any,
   *   missedSlot?: any, paused?: boolean}>} [list]
   */
  function anyFailure(list) {
    const routines = Array.isArray(list) ? list : [];
    return routines.some(routine => !(routine && routine.paused) && lastCompletedRunFailed(routine));
  }

  /**
   * Whether anything OTHER than the switch would stop this routine running.
   *
   * THIS MIRRORS `routineRefusal` IN lib/scheduler.js, which is the gate that
   * actually decides: it refuses for paused, then enabled, then an unsupported
   * run target, and getNextRun refuses a schedule it cannot parse. A row that
   * offers to turn a routine on is claiming every one of those would let it
   * through, so the two lists have to be found together. `enabled` is
   * deliberately absent from this one: it answers what would stop the routine
   * BESIDES the switch the offer is about.
   *
   * A BOOLEAN, because that is all the answer is used for. It named the
   * deciding field for a while and nothing ever read the name.
   *
   * IT NEVER DECIDES WHETHER ANYTHING RUNS. It decides whether a sentence on a
   * row is true. The gate is the server's and stays there.
   *
   * The run target is read through the editor's own list rather than a literal
   * here, so which targets work is stated in one place.
   *
   * @param {{paused?: boolean, runOn?: any, schedule?: any, scheduleReadable?: boolean}} [input]
   */
  function somethingElseStopsIt(input) {
    if (!input) return false;
    if (input.paused) return true;
    // ASKED OF THE SCHEDULE ITSELF, NOT OF THE LINE THE ROW WOULD DRAW.
    //
    // This used to lean on scheduleProblem, which deliberately says nothing
    // about a routine whose schedule is absent or blank, on the grounds that
    // telling somebody to change a schedule they never wrote answers a
    // question nobody asked. That is the right rule for what to SAY and the
    // wrong one for what would RUN: a routine with no schedule can never run,
    // so leaning on the wording let the offer promise a run there.
    if (!canProduceARun(input)) return true;
    // A roster that did not name a run target says nothing, for the same
    // reason an absent scheduleReadable says nothing: silence is not a fault.
    if (input.runOn !== undefined && input.runOn !== null) {
      const option = editor.runOnOption(input.runOn);
      if (!option || !option.selectable) return true;
    }
    return false;
  }

  /**
   * Whether this routine's schedule could ever produce a run.
   *
   * Two ways it cannot: there is no schedule, or the scheduler has said it
   * cannot read the one there is. The first is answered here because a missing
   * value needs no grammar to judge; the second is the server's answer, and an
   * absent `scheduleReadable` is not taken as a fault.
   */
  function canProduceARun(input) {
    const schedule = input && input.schedule;
    if (typeof schedule !== 'string' || !schedule.trim()) return false;
    return input.scheduleReadable !== false;
  }

  /**
   * Whether the row must say this routine will never fire, and what to change.
   *
   * ASKED OF THE SERVER'S ANSWER, NEVER RE-DERIVED HERE. Whether a schedule
   * parses is the scheduler's question, and its grammar lives beside the tick.
   * A second copy on this side would be free to disagree with the tick about
   * which routines can ever run. It is also not the same question as whether
   * `scheduleWords` has plain words to show: the editor offers times on the
   * half hour, so `every day at 07:03` has no words and runs perfectly well,
   * and a row judging readability that way would accuse a working routine.
   *
   * AN EXPLICIT FALSE AND NOTHING ELSE. A roster that did not carry the field
   * says nothing rather than accusing every routine on it, because the field is
   * new and silence must not become a complaint.
   *
   * AND A ROUTINE WITH NO SCHEDULE AT ALL IS LEFT ALONE. That is a different
   * fault, and telling its owner to change a schedule they never wrote is an
   * answer to a question nobody asked.
   *
   * @param {{schedule?: any, scheduleReadable?: boolean}} [input]
   */
  function scheduleProblem(input) {
    if (!input || input.scheduleReadable !== false) return null;
    const schedule = input.schedule;
    if (typeof schedule !== 'string' || !schedule.trim()) return null;
    return { text: `${SCHEDULE_PROBLEM.lead} ${SCHEDULE_PROBLEM.body}` };
  }

  /**
   * The offer to turn a held-back routine on, or nothing.
   *
   * READ OFF AN EXPLICIT FALSE, never off a falsy value. A routine that
   * arrives from somewhere carrying no `enabled` at all is not a routine
   * somebody declined to run; it is a caller that did not send the field, and
   * drawing an offer on a routine that is already running invites a reader to
   * break it. The data model has already turned an absent key into a real
   * false by the time anything here sees it.
   *
   * @param {{enabled?: boolean}} [input]
   */
  function enableOffer(input) {
    if (!input || input.enabled !== false) return null;
    // AND ONLY WHEN TURNING IT ON WOULD ACTUALLY START IT.
    //
    // The offer's whole value is that it says what pressing it does. On a row
    // where something ELSE also stops the routine, that sentence is false:
    // pressing it starts nothing. A routine that predates the scheduler and
    // carries a cron schedule is both at once, and it is not a corner case,
    // it is every pre-existing cron routine after an upgrade, because the
    // migration fills `enabled: false` and never touches a schedule.
    //
    // WITHHELD RATHER THAN REWORDED. There is nothing truthful a Turn on
    // control can promise on a row that will not run once it is pressed, and
    // the row already carries the thing that must be fixed first. When that is
    // fixed the offer appears, which is the order the work has to happen in
    // anyway.
    if (somethingElseStopsIt(input)) return null;
    // The instant is the one the next-run line would have rendered, so the
    // offer and the row cannot disagree about when this routine is due. It is
    // absent exactly when the scheduler has nothing to say, which is when this
    // says nothing too rather than inventing a time.
    const when = asDate(input.nextRun);
    const now = asDate(input.now);
    let timing = '';
    if (when && now) {
      timing = when <= now
        ? ` ${NOT_ENABLED.catchUpGone}`
        : ` ${NOT_ENABLED.catchUpAhead.replace('{when}', () => timeWords(when, now, input.zone))}`;
    }
    return {
      text: `${NOT_ENABLED.lead} ${NOT_ENABLED.body}${timing}`,
      label: NOT_ENABLED.label,
    };
  }

  /**
   * When it runs next, or that it is paused.
   *
   * THE INSTANT IS NOT DECIDED HERE. It arrives already computed, by one path
   * shared by every row, and this renders whatever it is handed. That is what
   * keeps a missed row's next-run value out of reach of a copy decision: a
   * missed row pairs with a next run TODAY, and it does so because the instant
   * says today, not because this function has a branch for it.
   */
  function nextRunLabel(input) {
    if (input && input.paused) return { text: 'Paused', className: 'next-run paused-label' };
    // A ROUTINE NOBODY HAS TURNED ON PROMISES NOTHING, and the guard is here
    // rather than at the caller because the instant is real. The server works
    // a next run out from the schedule alone, so a routine the upgrade held
    // back still arrives carrying tomorrow's slot, and rendering it would put
    // "Next run: tomorrow, 7:00am" on something that will never run. That is
    // worse than silence: it is the exact reassurance the reader came for.
    // The offer takes this line's place on the row.
    if (input && input.enabled === false) return null;
    // Nor does a routine whose schedule nothing here can read. The server does
    // not supply an instant for one today, so on that path this changes
    // nothing; it is here for the row that carries both, which is a state the
    // combination sweep in test/unit/routines-model.test.js builds and which
    // fails without this line. A time against a routine that will never fire
    // is the same false promise the offer is withheld for.
    if (input && input.scheduleReadable === false) return null;
    const words = timeWords(input && input.nextRun, input && input.now, input && input.zone);
    if (!words) return null;
    return { text: `Next run: ${words}`, className: 'next-run' };
  }

  /**
   * The list in the order a reader needs it: soonest next run first.
   *
   * WHY THIS IS NOT THE ORDER THE ROSTER HANDS OVER. The roster is file order,
   * which is the order routines happen to have been written in, and that is
   * arbitrary to everyone except whoever wrote the file. Invisible at nine
   * routines and the thing that makes this view unusable at thirty, and no
   * agent filter fixes it: whichever agent is selected, the rows underneath
   * are still in an order nobody chose.
   *
   * THREE BANDS, AND THE THIRD IS THE ONE WITH A RULE ATTACHED. A routine with
   * a next run sorts by it. A routine with none, because its schedule is one
   * the editor never offered and therefore has no computable slot, cannot be
   * placed on the timeline at all, so it sits after everything that can be.
   * Paused routines go last as a group: a paused routine has no next run by
   * definition, and mixing it into the band above would put "nothing is
   * scheduled" and "this will not run" in one undifferentiated tail.
   *
   * STABLE WITHIN EACH BAND, which is the whole of the paused rule and half of
   * the other two. Array sort has been required to be stable since ES2019, so
   * two routines due at the same instant, and every paused routine, keep the
   * order the roster gave them. The alternative is a list that reshuffles
   * itself on every redraw for no reason a reader could see.
   *
   * NOTHING HERE READS A CLOCK. Sorting by instant needs no `now`: which of
   * two runs comes first does not depend on when the question is asked.
   *
   * @param {any[]} list
   * @param {(item: any) => {nextRun?: any, paused?: boolean}} [read] where the
   *   two facts sit on an item. Defaults to the item itself, so this module's
   *   own tests can drive it with the two facts and nothing else, and the view
   *   can hand over its own entry shape without this knowing anything about it.
   */
  function orderByNextRun(list, read) {
    const facts = typeof read === 'function' ? read : (item => item);
    const band = (item) => {
      const f = facts(item) || {};
      if (f.paused) return 2;
      return asDate(f.nextRun) ? 0 : 1;
    };
    // ONLY THE FIRST BAND IS SORTED BY TIME, and the guard is the rule rather
    // than a shortcut. A paused routine can still carry the instant it WOULD
    // have run at, so comparing instants across the paused band puts a paused
    // routine that kept its next run behind one that has none, which is an
    // order derived from a fact the reader was told does not apply. Paused is
    // a band, not a time; so is having no next run at all.
    const at = (item) => asDate((facts(item) || {}).nextRun).getTime();
    // A COPY, NOT THE CALLER'S ARRAY. Array sort reorders in place, and a
    // caller that also holds the roster order for something else would find it
    // silently rewritten. The view counts namesakes in roster order before
    // this runs, and that count is what a delete is addressed by.
    return list.slice().sort((a, b) => {
      const gap = band(a) - band(b);
      if (gap !== 0) return gap;
      return band(a) === 0 ? at(a) - at(b) : 0;
    });
  }

  /** Everything one row shows, as data. */
  function row(input) {
    const option = editor.runOnOption(input && input.runOn);
    return {
      sentence: routineSentence(input),
      // The same sentence in pieces, so the view can make the skill name
      // reachable without matching text back out of its own escaped markup.
      parts: sentenceParts(input),
      meta: (input && input.agentName) || null,
      runsOn: option ? `Runs on ${option.sentence}` : null,
      status: runStatus(input),
      nextRun: nextRunLabel(input),
      // The one row state that carries an action rather than a fact. Null on
      // every other row, so the view draws nothing where there is nothing to
      // offer.
      offer: enableOffer(input),
      // The one thing on a row that is neither history nor a promise: a fault
      // in the routine itself, which only the person who wrote the file can fix.
      scheduleProblem: scheduleProblem(input),
    };
  }

  /**
   * What deleting this routine stops, said plainly.
   *
   * Names the agent, the routine and the schedule, so the reader knows exactly
   * what will not happen again. Names the thing that does NOT stop, because a
   * user about to delete a routine is entitled to know its output survives.
   * No vague "are you sure".
   */
  function deleteConfirmation(input) {
    const words = scheduleWords(input && input.schedule);
    const agentName = (input && input.agentName) || null;
    const name = (input && input.name) || null;
    const what = agentName && name && words
      ? `This stops ${agentName} running ${name}, ${words.charAt(0).toLowerCase()}${words.slice(1)}. `
      : 'This stops the routine running again. ';
    return {
      title: 'Delete this routine?',
      body: `${what}The file it last updated stays exactly as it is. This can't be undone.`,
      confirmLabel: 'Delete routine',
      cancelLabel: 'Cancel',
    };
  }

  return {
    OUTCOMES, LEAD, EMPTY, ACTION_PROBLEM, NOT_ENABLED, SCHEDULE_PROBLEM, CATCH_UP_AFTER_MS,
    actionProblem, emptyState, header,
    dayWords, clockWords, zoneWords, timeWords,
    scheduleWords, routineSentence, sentenceParts,
    outcomeOf, lastCompletedRunFailed, anyFailure, runStatus, nextRunLabel, enableOffer, scheduleProblem, somethingElseStopsIt, orderByNextRun, row, deleteConfirmation,
  };
}));
