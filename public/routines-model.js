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
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./routine-editor-model.js'));
  else root.RundockRoutinesModel = factory(root.RundockRoutineEditorModel);
}(typeof self !== 'undefined' ? self : this, function (editor) {

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

  const LEAD = {
    title: 'Routines',
    lead: 'Every scheduled skill across your team, and when it runs next.',
  };

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

  function routineSentence(input) {
    const words = scheduleWords(input && input.schedule);
    const name = (input && input.name) || null;
    if (!words || !name) return null;
    return `${words}, run: ${name}`;
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
  function outcomeOf(input) {
    const started = asDate(input && input.lastStart);
    const missedSlot = asDate(input && input.missedSlot);
    const statusWord = (input && input.lastRunStatus) || null;
    if (statusWord === 'running') return null;
    if (missedSlot && (!started || missedSlot > started)) return 'missed';
    if (!started) return null;
    // A run the process died inside did not succeed. It borrows the failure
    // tone rather than adding a fifth state nothing in the frame draws.
    if (statusWord === 'failed' || statusWord === 'interrupted') return 'failed';
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
    const words = timeWords(input && input.nextRun, input && input.now, input && input.zone);
    if (!words) return null;
    return { text: `Next run: ${words}`, className: 'next-run' };
  }

  /** Everything one row shows, as data. */
  function row(input) {
    const option = editor.runOnOption(input && input.runOn);
    return {
      sentence: routineSentence(input),
      meta: (input && input.agentName) || null,
      runsOn: option ? `Runs on ${option.sentence}` : null,
      status: runStatus(input),
      nextRun: nextRunLabel(input),
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
    OUTCOMES, LEAD, EMPTY, ACTION_PROBLEM, CATCH_UP_AFTER_MS,
    actionProblem,
    dayWords, clockWords, zoneWords, timeWords,
    scheduleWords, routineSentence,
    outcomeOf, runStatus, nextRunLabel, row, deleteConfirmation,
  };
}));
