'use strict';
// What a routine row says, and in which of the three tones.
//
// EVERY DATE HERE IS BUILT FROM LOCAL COMPONENTS, and every assertion reads
// them back through local getters. `new Date(2026, 7, 20, 7, 0)` is 7:00am on
// the twentieth wherever this runs, and getHours() gives 7 back in the same
// zone, so the pairs in this file describe the code rather than the machine.
// An ISO string would not: it carries an offset, and the calendar day it names
// changes with the runner's zone. Seven tests on this project were found
// yesterday whose result depended on the box they ran on, which is why this is
// said here rather than assumed.
//
// The times avoid 01:00 to 03:00 for the same reason: that is the window a
// daylight-saving change deletes, and a local time inside a deleted hour is
// the one construction that does not round-trip.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const m = require('../../public/routines-model.js');

// Thursday 20 August 2026, twenty past nine in the morning. Every scenario
// below is that instant looking at one routine scheduled for 7:00am daily,
// which is the mock's own setup: one routine, one agent, one execution
// target, only the outcome changing.
const NOW = new Date(2026, 7, 20, 9, 20);
const TODAYS_SLOT = new Date(2026, 7, 20, 7, 0);
const YESTERDAYS_SLOT = new Date(2026, 7, 19, 7, 0);
const TOMORROWS_SLOT = new Date(2026, 7, 21, 7, 0);
const ZONE = 'Europe/London';

// The four rows of the locked frame, as inputs. One routine, four outcomes.
// `lastStart` throughout, never a completion time: see the model's own note.
const RAN_ON_TIME = {
  lastStart: new Date(2026, 7, 20, 7, 0, 12), lastRunStatus: 'completed', lastSlot: TODAYS_SLOT,
  missedSlot: null, nextRun: TOMORROWS_SLOT,
};
const CAUGHT_UP = {
  lastStart: new Date(2026, 7, 20, 9, 14), lastRunStatus: 'completed', lastSlot: TODAYS_SLOT,
  missedSlot: null, nextRun: TOMORROWS_SLOT,
};
const MISSED = {
  lastStart: new Date(2026, 7, 18, 7, 0), lastRunStatus: 'completed', lastSlot: new Date(2026, 7, 18, 7, 0),
  missedSlot: YESTERDAYS_SLOT, nextRun: TODAYS_SLOT,
};
const FAILED = {
  lastStart: new Date(2026, 7, 20, 7, 0), lastRunStatus: 'failed', lastSlot: TODAYS_SLOT,
  missedSlot: null, nextRun: TOMORROWS_SLOT,
};
const ALL_FOUR = [
  ['ran on time', RAN_ON_TIME], ['caught up', CAUGHT_UP],
  ['missed', MISSED], ['failed', FAILED],
];

const status = (input) => m.runStatus({ ...input, now: NOW, zone: ZONE });
const next = (input) => m.nextRunLabel({ ...input, now: NOW, zone: ZONE });

describe('the four outcomes, each in its own tone and its own leading word', () => {
  // AC-14. Driven as four separate rows rather than as four asserts on one,
  // because the claim is that a reader can tell them apart.
  test('each outcome renders its own tone and its own leading word', () => {
    const seen = ALL_FOUR.map(([, input]) => status(input));
    assert.deepStrictEqual(seen.map(s => s.kind), ['on-time', 'caught-up', 'missed', 'failed']);
    assert.deepStrictEqual(seen.map(s => s.tone), ['ok', 'ok-quiet', 'neutral', 'failed']);
    assert.deepStrictEqual(seen.map(s => s.lead), ['Ran', 'Caught up', 'Missed', 'Failed']);
    // Four rows, four different first words, so nothing is told apart by
    // colour alone.
    assert.strictEqual(new Set(seen.map(s => s.lead)).size, 4);
  });

  // The ruling, as an assertion rather than as a note. A late run is a
  // success; a slot nobody served is a non-event; only a failure is a failure.
  //
  // WHAT EACH TONE LOOKS LIKE IS NOT ASSERTED HERE, deliberately. The page's
  // colour and weight come from the stylesheet, so the place to hold the
  // ruling to account is what the page resolves, which is done in "the ruling,
  // against what the page resolves" in test/unit/routines-view.test.js. A
  // table of colours in this module would be a second statement of the ruling
  // that nothing consumes, and it could agree with its tests forever while the
  // stylesheet said something else.
  test('a late run keeps the success tone and a passed slot does not take the failure one', () => {
    assert.strictEqual(status(RAN_ON_TIME).tone, 'ok');
    assert.strictEqual(status(CAUGHT_UP).tone, 'ok-quiet');
    assert.strictEqual(status(MISSED).tone, 'neutral');
    assert.strictEqual(status(FAILED).tone, 'failed');
  });

  // WHAT MAKES A RUN LATE IS WHEN IT STARTED, and nothing about how long it
  // then took. An agent run routinely lasts longer than the catch-up boundary,
  // so a tone measured from a completion time would put the quieter tone on
  // almost every ordinary row, which is the exact outcome the ruling exists to
  // prevent.
  test('a punctual run that took a long time is still punctual', () => {
    const elevenMinutes = {
      ...RAN_ON_TIME, lastStart: new Date(2026, 7, 20, 7, 0, 12),
    };
    assert.strictEqual(status(elevenMinutes).kind, 'on-time');
    assert.strictEqual(status(elevenMinutes).text, 'Ran today, 7:00am, London time',
      'the row says when the run began, not when it finished');
    // And the boundary still bites on a run that genuinely started late.
    assert.strictEqual(status({ ...RAN_ON_TIME, lastStart: new Date(2026, 7, 20, 7, 11) }).kind, 'caught-up');
  });

  test('the text of each row is the text the locked frame draws', () => {
    assert.strictEqual(status(RAN_ON_TIME).text, 'Ran today, 7:00am, London time');
    assert.strictEqual(status(CAUGHT_UP).text, 'Caught up: ran today, 9:14am, London time, due 7:00am');
    assert.strictEqual(status(MISSED).text, 'Missed: Rundock was closed at 7:00am yesterday, London time');
    assert.strictEqual(status(FAILED).text, 'Failed: today, 7:00am, London time');
  });

  // AC-6. The machine being off is not the routine failing, so the sentence is
  // about Rundock and not about the routine.
  test('a missed row names the cause and not the routine', () => {
    const text = status(MISSED).text;
    assert.match(text, /Rundock was closed/);
    assert.ok(!/routine/i.test(text), 'the routine is not what went wrong here');
  });

  // A run still in flight has no completed outcome to name: the routine state
  // holds one slot per routine, so there is nothing to say yet.
  test('a run still going names no outcome', () => {
    assert.strictEqual(status({ ...RAN_ON_TIME, lastRunStatus: 'running' }), null);
  });

  test('a routine that has never run names no outcome', () => {
    assert.strictEqual(status({ lastStart: null, lastRunStatus: null, lastSlot: null, missedSlot: null }), null);
  });

  // A run the process died inside did not succeed, so it takes the failure
  // tone rather than a fifth one nothing in the frame draws.
  test('a run the process died inside reads as a failure', () => {
    assert.strictEqual(status({ ...FAILED, lastRunStatus: 'interrupted' }).tone, 'failed');
  });

  // Which of the two facts is the LAST thing that happened. A miss older than
  // the last run is history the run already answered.
  test('a miss older than the last run is not what happened last', () => {
    const stale = { ...RAN_ON_TIME, missedSlot: new Date(2026, 7, 17, 7, 0) };
    assert.strictEqual(status(stale).kind, 'on-time');
  });

  test('a miss later than the last run is what happened last', () => {
    assert.strictEqual(status(MISSED).kind, 'missed');
  });

  // The line between the two successes. Inside a few ticks of its slot a run
  // is the scheduler doing its ordinary work, not a catch-up.
  test('a run within a few ticks of its slot is on time, not caught up', () => {
    const justLate = { ...RAN_ON_TIME, lastStart: new Date(2026, 7, 20, 7, 1, 30) };
    assert.strictEqual(status(justLate).kind, 'on-time');
    const wellLate = { ...RAN_ON_TIME, lastStart: new Date(2026, 7, 20, 7, 30) };
    assert.strictEqual(status(wellLate).kind, 'caught-up');
  });
});

describe('the next-run fact, on every row', () => {
  // AC-3 and AC-4. Present on all four, including the longest status text.
  test('every row carries a next-run value', () => {
    for (const [name, input] of ALL_FOUR) {
      assert.ok(next(input).text, `${name} lost its next-run fact`);
      assert.match(next(input).text, /^Next run: /, name);
    }
    // The longest status line is still paired with one.
    const longest = ALL_FOUR
      .map(([, input]) => status(input).text)
      .sort((a, b) => b.length - a.length)[0];
    assert.strictEqual(longest, status(MISSED).text);
    assert.strictEqual(next(MISSED).text, 'Next run: today, 7:00am, London time');
  });

  // AC-15. THE VALUE THAT IS CONSTRAINED, NOT COPY. A missed row pairs with a
  // next run TODAY. A slot missed today is caught up within a minute by an
  // open Rundock and would render as Caught up instead, so the only slot that
  // survives to render as Missed is one from an earlier day, and the slot it
  // is next due at has not rolled forward.
  test('a missed row pairs with a next run today, never tomorrow', () => {
    const label = next(MISSED);
    assert.strictEqual(label.text, 'Next run: today, 7:00am, London time');
    assert.ok(!/tomorrow/.test(label.text), 'two design frames wrote tomorrow here and both were wrong');
  });

  test('the other three rows read the value they were given', () => {
    assert.strictEqual(next(RAN_ON_TIME).text, 'Next run: tomorrow, 7:00am, London time');
    assert.strictEqual(next(CAUGHT_UP).text, 'Next run: tomorrow, 7:00am, London time');
    assert.strictEqual(next(FAILED).text, 'Next run: tomorrow, 7:00am, London time');
  });

  // AC-5 seen from this side: the label does not decide the value. It renders
  // whatever instant it is handed, so a missed row and a ran-on-time row go
  // through the same words.
  test('the same instant reads the same on every row', () => {
    const texts = ALL_FOUR.map(([, input]) => next({ ...input, nextRun: TODAYS_SLOT }).text);
    assert.deepStrictEqual(new Set(texts).size, 1);
    assert.strictEqual(texts[0], 'Next run: today, 7:00am, London time');
  });

  // A paused routine says so in the slot a next-run time would occupy.
  test('a paused routine says paused where its next run would be', () => {
    const label = next({ ...RAN_ON_TIME, paused: true });
    assert.strictEqual(label.text, 'Paused');
    assert.match(label.className, /paused-label/);
  });

  test('a routine with no next run instant says nothing rather than guessing', () => {
    assert.strictEqual(next({ ...RAN_ON_TIME, nextRun: null }), null);
  });
});

describe('times and days in local words', () => {
  // AC-7. Never a raw timestamp.
  test('a next-run time never reaches the page as a timestamp', () => {
    for (const [name, input] of ALL_FOUR) {
      const text = next(input).text;
      assert.ok(!/\d{4}-\d{2}-\d{2}/.test(text), `${name} rendered an ISO date`);
      assert.ok(!/T\d{2}:\d{2}/.test(text), `${name} rendered an ISO time`);
      assert.ok(!/GMT|UTC|[+-]\d{2}:\d{2}/.test(text), `${name} rendered an offset`);
    }
  });

  test('the day nearest now is a word', () => {
    assert.strictEqual(m.dayWords(TODAYS_SLOT, NOW), 'today');
    assert.strictEqual(m.dayWords(TOMORROWS_SLOT, NOW), 'tomorrow');
    assert.strictEqual(m.dayWords(YESTERDAYS_SLOT, NOW), 'yesterday');
  });

  test('a day inside the week is its weekday name', () => {
    // Thursday the twentieth, so Monday the twenty fourth is four days out.
    assert.strictEqual(m.dayWords(new Date(2026, 7, 24, 7, 0), NOW), 'Monday');
    assert.strictEqual(m.dayWords(new Date(2026, 7, 16, 7, 0), NOW), 'Sunday');
  });

  test('a day beyond the week is a date in words', () => {
    assert.strictEqual(m.dayWords(new Date(2026, 8, 3, 7, 0), NOW), '3 September');
    assert.strictEqual(m.dayWords(new Date(2026, 6, 4, 7, 0), NOW), '4 July');
  });

  test('a day word is the calendar day, not a count of hours', () => {
    // Ten past midnight tomorrow is tomorrow, though it is under three hours
    // from now. A difference in milliseconds would call this today.
    assert.strictEqual(m.dayWords(new Date(2026, 7, 21, 0, 10), new Date(2026, 7, 20, 23, 50)), 'tomorrow');
  });

  test('the clock reads in plain words, and twelve is twelve', () => {
    assert.strictEqual(m.clockWords(new Date(2026, 7, 20, 7, 0)), '7:00am');
    assert.strictEqual(m.clockWords(new Date(2026, 7, 20, 9, 14)), '9:14am');
    assert.strictEqual(m.clockWords(new Date(2026, 7, 20, 0, 5)), '12:05am');
    assert.strictEqual(m.clockWords(new Date(2026, 7, 20, 12, 0)), '12:00pm');
    assert.strictEqual(m.clockWords(new Date(2026, 7, 20, 18, 30)), '6:30pm');
  });

  test('the zone is named as a place, never as an offset', () => {
    assert.match(status(RAN_ON_TIME).text, /London time/);
    assert.strictEqual(m.runStatus({ ...RAN_ON_TIME, now: NOW, zone: 'America/New_York' }).text,
      'Ran today, 7:00am, New York time');
  });

  test('a row with no zone drops the zone rather than inventing one', () => {
    assert.strictEqual(m.runStatus({ ...RAN_ON_TIME, now: NOW, zone: null }).text, 'Ran today, 7:00am');
    assert.strictEqual(m.nextRunLabel({ ...RAN_ON_TIME, now: NOW, zone: null }).text,
      'Next run: tomorrow, 7:00am');
  });
});

describe('the rest of the row', () => {
  // AC-1 and AC-2. Two lines, and the second carries both facts.
  test('a row with a last-run fact carries two lines', () => {
    const row = m.row({
      name: 'Compile the ops summary', schedule: 'every day at 07:00',
      agentName: 'Piper', runOn: 'local', ...RAN_ON_TIME, now: NOW, zone: ZONE,
    });
    assert.strictEqual(row.sentence, 'Every day at 7:00am, run: Compile the ops summary');
    assert.strictEqual(row.meta, 'Piper');
    assert.strictEqual(row.runsOn, 'Runs on this computer');
    assert.strictEqual(row.status.text, 'Ran today, 7:00am, London time');
    assert.strictEqual(row.nextRun.text, 'Next run: tomorrow, 7:00am, London time');
  });

  // The frame's own judgment call: the second line appears only once there is
  // a last-run fact worth pairing with next-run, so a routine that has never
  // run stays the single-line row revision 6 drew.
  test('a routine that has never run stays one line, with its next run on it', () => {
    const row = m.row({
      name: 'Refresh the reading digest', schedule: 'every day at 06:30',
      agentName: 'Doc', runOn: 'local', lastRun: null, lastRunStatus: null,
      lastSlot: null, missedSlot: null, nextRun: new Date(2026, 7, 21, 6, 30), now: NOW, zone: ZONE,
    });
    assert.strictEqual(row.status, null);
    assert.strictEqual(row.nextRun.text, 'Next run: tomorrow, 6:30am, London time');
  });

  test('the execution target reads off the option rather than a string built here', () => {
    const editor = require('../../public/routine-editor-model.js');
    for (const option of editor.runOnOptions()) {
      const row = m.row({
        name: 'x', schedule: 'every day at 07:00', agentName: 'Piper', runOn: option.value,
        ...RAN_ON_TIME, now: NOW, zone: ZONE,
      });
      assert.strictEqual(row.runsOn, `Runs on ${option.sentence}`);
    }
  });

  test('a schedule the editor never offered assembles into no sentence', () => {
    assert.strictEqual(m.scheduleWords('0 7 * * *'), null);
    assert.strictEqual(m.scheduleWords('every weekday at 07:00'), null);
    assert.strictEqual(m.scheduleWords('every monday at 08:00'), 'Every Monday at 8:00am');
  });

  // AC-11. Delete says what stops, what does not, and that it is final.
  test('delete states what stops', () => {
    const confirm = m.deleteConfirmation({
      agentName: 'Piper', name: 'Compile the ops summary', schedule: 'every day at 07:00',
    });
    assert.strictEqual(confirm.title, 'Delete this routine?');
    assert.strictEqual(confirm.body,
      'This stops Piper running Compile the ops summary, every day at 7:00am. '
      + 'The file it last updated stays exactly as it is. This can\'t be undone.');
    assert.strictEqual(confirm.confirmLabel, 'Delete routine');
    assert.strictEqual(confirm.cancelLabel, 'Cancel');
    // Named rather than vague: the agent, the routine and the schedule are all
    // in the sentence, and so is the thing that does NOT stop.
    assert.match(confirm.body, /Piper/);
    assert.match(confirm.body, /Compile the ops summary/);
    assert.match(confirm.body, /7:00am/);
    assert.match(confirm.body, /stays exactly as it is/);
    assert.ok(!/are you sure/i.test(confirm.body));
  });

  // A refused pause or delete says what happened and, for somebody who has
  // just pressed Delete, that nothing happened.
  test('a refusal with no words of its own still says something useful', () => {
    assert.strictEqual(m.actionProblem({ message: 'Routine "x" could not be paused.' }),
      'Routine "x" could not be paused.', 'the server knows what went wrong, so its words win');
    for (const empty of [{}, { message: '' }, { message: '   ' }, null]) {
      assert.strictEqual(m.actionProblem(empty), m.ACTION_PROBLEM);
    }
    assert.match(m.ACTION_PROBLEM, /Nothing has been altered/,
      'the half that matters to somebody who just pressed Delete');
  });

  // AC-12. The empty state's Add belongs to no agent.
  test('the empty state offers an add that names no agent', () => {
    assert.strictEqual(m.EMPTY.lead, 'No routines yet.');
    assert.strictEqual(m.EMPTY.body, 'Pick a tested skill and give it a schedule. Your agents take it from there.');
    assert.strictEqual(m.EMPTY.action, 'Add routine');
    assert.strictEqual(m.EMPTY.aside,
      'Looking at a skill you already trust? You can also schedule it right from its own page.');
    // Agent-agnostic: plural agents, and no single agent named anywhere in it.
    assert.match(m.EMPTY.body, /Your agents/);
    assert.ok(!/\bDoc\b|\bPiper\b|\byour agent\b/.test(`${m.EMPTY.body} ${m.EMPTY.action} ${m.EMPTY.aside}`));
  });
});

describe('which empty state, decided mechanically', () => {
  // THE CHAIN, which is what makes this decidable. A skill is declared on an
  // agent and a routine schedules a skill, so the surfaces are a chain: agents,
  // then skills, then routines. Every empty state points one step back up that
  // chain, and the FIRST MISSING PREREQUISITE picks the variant. Not taste.
  const WITH_SKILL = [{ id: 'sk', name: 'Compile the ops summary', assignedAgents: [{ id: 'piper', name: 'Piper' }] }];

  test('a workspace with a skill gets the locked copy, word for word', () => {
    const state = m.emptyState({ skills: WITH_SKILL, guideName: 'Wren' });
    assert.strictEqual(state.lead, 'No routines yet.');
    assert.strictEqual(state.body, 'Pick a tested skill and give it a schedule. Your agents take it from there.');
    assert.strictEqual(state.action, 'Add routine');
    assert.strictEqual(state.aside,
      'Looking at a skill you already trust? You can also schedule it right from its own page.');
  });

  test('a workspace with no skill is told where a skill comes from', () => {
    const state = m.emptyState({ skills: [], guideName: 'Wren' });
    assert.strictEqual(state.lead, 'No routines yet.');
    assert.strictEqual(state.body,
      'Routines schedule skills your agents already have. Build one and it will show up here.');
    assert.strictEqual(state.action, 'Build a skill');
    assert.strictEqual(state.aside, null, 'the aside names a skill page this workspace has no skill for');
  });

  // BOTH REPLACEMENT LINES ALREADY SHIP, one screen away, in the routine
  // editor's own zero-skills state. Writing a second sentence for a fact the
  // product already has a sentence for is the drift this pass argues against,
  // so this asserts they are the SAME strings rather than equal ones.
  test('the no-skills lines belong to the editor, not to a second pair written here', () => {
    const editor = require('../../public/routine-editor-model.js');
    const state = m.emptyState({ skills: [], guideName: 'Wren' });
    assert.strictEqual(state.body, editor.STEP_LEADS.empty);
    assert.strictEqual(state.action, editor.STEP_LEADS.build);
  });

  // The condition is the same question the picker already answers, so the two
  // surfaces cannot disagree about whether a workspace has skills.
  test('the variant is the question skillChoices already answers', () => {
    const editor = require('../../public/routine-editor-model.js');
    for (const skills of [[], WITH_SKILL, [{ id: 'orphan', name: 'Orphan', assignedAgents: [] }]]) {
      const offers = editor.skillChoices({ skills }).createSkill;
      const state = m.emptyState({ skills, guideName: 'Wren' });
      assert.strictEqual(state.action === 'Build a skill', offers,
        'the empty state and the picker disagree about whether this workspace has skills');
    }
  });

  test('skills that have not arrived are not a workspace with no skills', () => {
    const state = m.emptyState({ skills: [], loading: true, guideName: 'Wren' });
    assert.strictEqual(state.action, null, 'an offer was made before anything was known');
    assert.strictEqual(state.aside, null);
    assert.strictEqual(state.lead, 'No routines yet.', 'the routines fact is known either way');
    assert.strictEqual(state.body, require('../../public/routine-editor-model.js').STEP_LEADS.loading,
      'the editor already has a line for this state and the two must not disagree');
  });

  // AFTER REVIEW: the action goes with the guide and the SHIPPED LINE STAYS
  // WHOLE, with the agent-independent next step appended to it. Splitting the
  // shipped string would be this pass writing a second version of a sentence
  // the product already has, which is the thing it exists to stop.
  test('with no guide the shipped line is kept whole and a next step is appended', () => {
    const editor = require('../../public/routine-editor-model.js');
    const skillsModel = require('../../public/skills-model.js');
    const state = m.emptyState({ skills: [], guideName: null });
    assert.strictEqual(state.action, null, 'a button was offered with no agent to fulfil it');
    assert.strictEqual(state.lead, 'No routines yet.');
    assert.strictEqual(state.body,
      `${editor.STEP_LEADS.empty} ${skillsModel.EMPTY.nextStepNoGuide}`);
    assert.ok(state.body.startsWith(editor.STEP_LEADS.empty),
      'the shipped line was rewritten rather than kept whole');
  });

  // ONE SENTENCE, ONE PLACE. Both readers are missing the same fact, so the
  // routines state appends the Skills pane's own sentence rather than a second
  // copy of it that can drift.
  test('the appended next step is the Skills pane\'s own sentence, not a copy', () => {
    const skillsModel = require('../../public/skills-model.js');
    const routines = m.emptyState({ skills: [], guideName: null }).body;
    const skillsPane = skillsModel.emptyState({}).body;
    const sentence = skillsModel.EMPTY.nextStepNoGuide;
    assert.ok(routines.endsWith(sentence));
    assert.ok(skillsPane.endsWith(sentence));
  });

  // Neither no-guide state is a dead end: each ends in a next step, which may
  // be a sentence rather than an action.
  test('every empty state this card ships ends in a next step', () => {
    const skillsModel = require('../../public/skills-model.js');
    for (const [label, state] of [
      ['routines, skills exist', m.emptyState({ skills: WITH_SKILL, guideName: 'Wren' })],
      ['routines, no skills, guide', m.emptyState({ skills: [], guideName: 'Wren' })],
      ['routines, no skills, no guide', m.emptyState({ skills: [], guideName: null })],
      ['skills, guide', skillsModel.emptyState({ guideName: 'Wren' })],
      ['skills, no guide', skillsModel.emptyState({})],
    ]) {
      const ends = state.action || state.body.split('. ').filter(Boolean).pop();
      assert.ok(ends && ends.length > 3, `${label} ends in nothing to do`);
      assert.ok(!/get started|dive in|explore/i.test(ends), `${label} ends in a generic encouragement`);
    }
  });

  // The locked variant's Add routine is not the guide's to fulfil: it opens
  // the picker, which is on this side of the app. It stays whatever the team
  // looks like.
  test('the locked variant keeps its add with no guide on the team', () => {
    const state = m.emptyState({ skills: WITH_SKILL, guideName: null });
    assert.strictEqual(state.action, 'Add routine');
    assert.strictEqual(state.body,
      'Pick a tested skill and give it a schedule. Your agents take it from there.',
      'the locked copy gained a sentence it was not amended to carry');
  });
});

describe('the copy this card ships', () => {
  // AC-13, narrowed to the files this card adds and to the word list the
  // workspace guide states, so the criterion is discharged from the diff
  // rather than from a command nobody here ran.
  const BANNED = ['leverage', 'streamline', 'empower', 'utilize', 'robust', 'seamless', 'dive into'];

  function everyString(value, out = []) {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const v of value) everyString(v, out);
    else if (value && typeof value === 'object') for (const v of Object.values(value)) everyString(v, out);
    return out;
  }

  function copyShipped() {
    return everyString([
      m.LEAD, m.EMPTY, m.OUTCOMES, m.ACTION_PROBLEM, m.NOT_ENABLED, m.SCHEDULE_PROBLEM,
      ALL_FOUR.map(([, input]) => [status(input), next(input)]),
      m.deleteConfirmation({ agentName: 'Piper', name: 'Compile the ops summary', schedule: 'every day at 07:00' }),
    ]);
  }

  test('no banned word reaches this view\'s copy', () => {
    for (const line of copyShipped()) {
      for (const word of BANNED) assert.ok(!line.toLowerCase().includes(word), `"${word}" in: ${line}`);
    }
  });

  test('no em dash or en dash reaches this view\'s copy', () => {
    for (const line of copyShipped()) assert.ok(!/[\u2014\u2013]/.test(line), `dash in: ${line}`);
  });

  test('the copy is UK spelling', () => {
    for (const line of copyShipped()) {
      assert.ok(!/\b\w+ize[sd]?\b/i.test(line), `US spelling in: ${line}`);
      assert.ok(!/\bcolor\b/i.test(line), `US spelling in: ${line}`);
    }
  });

  test('the files these surfaces ship carry no em dash or en dash', () => {
    const root = path.join(__dirname, '..', '..');
    for (const rel of [
      'public/routines-model.js', 'public/views/routines.js',
      'public/styles/views/routines.css',
      'test/unit/routines-model.test.js', 'test/unit/routines-view.test.js',
      'test/unit/routines-next-run.test.js', 'test/unit/routines-end-to-end.test.js',
      'test/unit/routines-view-doors.test.js',
      'test/tools/mutate-routines-guards.js',
      // The empty states the permanent rail requires, which ship copy on the
      // same rule and would otherwise be held to it by nothing.
      'public/skills-model.js', 'public/views/skills.js',
      'test/unit/routines-view-doors.test.js',
      'public/styles/views/skills.css', 'test/unit/skills-empty.test.js',
    ]) {
      const text = fs.readFileSync(path.join(root, rel), 'utf-8');
      assert.ok(!/[\u2014\u2013]/.test(text), `${rel} carries a dash the repository check refuses`);
    }
  });
});

describe('the order the list is read in', () => {
  // WHAT MAKES THESE CAPABLE OF FAILING. Every fixture below is written so
  // that roster order and next-run order DISAGREE, and each asserts the whole
  // sequence rather than a property of it. A list handed back untouched comes
  // out in the order it went in, so reverting to roster order turns every one
  // of these red by name.
  const item = (name, facts) => ({ name, nextRun: null, paused: false, ...facts });

  const SOON = new Date(2026, 7, 20, 18, 0);
  const LATER = new Date(2026, 7, 21, 7, 0);
  const LATEST = new Date(2026, 7, 22, 7, 0);

  test('the soonest next run is first, whatever order the roster held', () => {
    const roster = [
      item('third', { nextRun: LATEST }),
      item('first', { nextRun: SOON }),
      item('second', { nextRun: LATER }),
    ];
    assert.deepStrictEqual(m.orderByNextRun(roster).map(r => r.name),
      ['first', 'second', 'third'],
      'the list came back in the order the roster held it, which is file order');
  });

  test('paused routines are last, grouped, and in roster order among themselves', () => {
    const roster = [
      item('paused first in the file', { paused: true }),
      item('runs later', { nextRun: LATEST }),
      item('paused second in the file', { paused: true }),
      item('runs soon', { nextRun: SOON }),
    ];
    assert.deepStrictEqual(m.orderByNextRun(roster).map(r => r.name), [
      'runs soon', 'runs later', 'paused first in the file', 'paused second in the file',
    ], 'a paused routine has no next run, so it belongs after everything that has one');
  });

  // A paused routine can still carry the instant it WOULD have run at, and it
  // must not be sorted by it: paused is a band, not a time.
  test('a paused routine carrying a next run is still last', () => {
    const roster = [
      item('paused but due first', { paused: true, nextRun: SOON }),
      item('actually runs', { nextRun: LATEST }),
    ];
    assert.deepStrictEqual(m.orderByNextRun(roster).map(r => r.name),
      ['actually runs', 'paused but due first']);
  });

  // A schedule the editor never offered has no computable slot, so the routine
  // is real, is listed, and cannot be placed on the timeline.
  test('a routine with no next run sits after the scheduled ones and before the paused', () => {
    const roster = [
      item('paused', { paused: true }),
      item('no next run'),
      item('scheduled', { nextRun: LATER }),
    ];
    assert.deepStrictEqual(m.orderByNextRun(roster).map(r => r.name),
      ['scheduled', 'no next run', 'paused']);
  });

  test('two routines due at the same instant keep the order the roster gave them', () => {
    const roster = [item('written first', { nextRun: LATER }), item('written second', { nextRun: LATER })];
    assert.deepStrictEqual(m.orderByNextRun(roster).map(r => r.name),
      ['written first', 'written second']);
  });

  // The caller's array is what the namesake count was taken over, so it must
  // come back as it went in.
  test('the roster handed in is not reordered underneath the caller', () => {
    const roster = [item('later', { nextRun: LATEST }), item('sooner', { nextRun: SOON })];
    m.orderByNextRun(roster);
    assert.deepStrictEqual(roster.map(r => r.name), ['later', 'sooner'],
      'the caller\'s list was sorted in place, so the namesake count it holds now names other rows');
  });

  // The two facts are read through the caller's own accessor, so the model
  // never has to know the shape of an entry the view assembles.
  test('the two facts are found wherever the caller says they are', () => {
    const roster = [
      { routine: { nextRun: LATEST, paused: false }, tag: 'later' },
      { routine: { nextRun: SOON, paused: false }, tag: 'sooner' },
    ];
    assert.deepStrictEqual(m.orderByNextRun(roster, e => e.routine).map(e => e.tag),
      ['sooner', 'later']);
  });

  // Both instants arrive from the server as strings, which is the only shape
  // this ever sees in the product.
  test('the instants sort as instants rather than as strings', () => {
    const roster = [
      item('nine in the evening', { nextRun: new Date(2026, 7, 20, 21, 0).toISOString() }),
      item('nine in the morning', { nextRun: new Date(2026, 7, 20, 9, 0).toISOString() }),
    ];
    assert.deepStrictEqual(m.orderByNextRun(roster).map(r => r.name),
      ['nine in the morning', 'nine in the evening']);
  });

  test('no row is added, dropped or altered by being ordered', () => {
    const roster = [item('a', { nextRun: LATEST }), item('b', { paused: true }), item('c', { nextRun: SOON })];
    const ordered = m.orderByNextRun(roster);
    assert.strictEqual(ordered.length, roster.length);
    for (const original of roster) {
      assert.ok(ordered.includes(original), 'ordering replaced a row with a copy of it');
    }
  });
});

describe('the sentence in the pieces the view composes it from', () => {
  const INPUT = { schedule: 'every day at 07:00', name: 'Compile the ops summary' };

  // AC-B4. Every word of this sentence is asserted here, on the model, and not
  // on the markup a view happens to produce from it.
  test('the pieces carry the schedule and the skill name, and nothing else', () => {
    assert.deepStrictEqual(m.sentenceParts(INPUT),
      { lead: 'Every day at 7:00am, run: ', name: 'Compile the ops summary' });
  });

  // The two cannot say different things, because one is built from the other.
  test('the pieces concatenate to exactly the sentence', () => {
    const parts = m.sentenceParts(INPUT);
    assert.strictEqual(parts.lead + parts.name, m.routineSentence(INPUT));
    assert.strictEqual(m.routineSentence(INPUT), 'Every day at 7:00am, run: Compile the ops summary');
  });

  // The lead owns the space, so a caller that puts the name in its own element
  // does not have to invent one and cannot leave the two words joined.
  test('the space before the name belongs to the lead', () => {
    assert.match(m.sentenceParts(INPUT).lead, / $/);
    assert.ok(!/^\s/.test(m.sentenceParts(INPUT).name));
  });

  // A schedule the editor never offered assembles into nothing rather than
  // into a sentence that reads as though the product understood it, and the
  // pieces answer the same way the whole sentence does.
  test('a schedule with no plain words yields no pieces', () => {
    assert.strictEqual(m.sentenceParts({ schedule: 'every fortnight at 07:00', name: 'A skill' }), null);
    assert.strictEqual(m.routineSentence({ schedule: 'every fortnight at 07:00', name: 'A skill' }), null);
  });

  test('a routine with no name yields no pieces', () => {
    assert.strictEqual(m.sentenceParts({ schedule: 'every day at 07:00' }), null);
  });

  test('the row carries the pieces beside the sentence', () => {
    const row = m.row({ ...INPUT, runOn: 'local', agentName: 'Piper' });
    assert.strictEqual(row.parts.lead + row.parts.name, row.sentence);
  });

  test('a row that cannot assemble a sentence carries no pieces either', () => {
    const row = m.row({ schedule: 'every fortnight at 07:00', name: 'A skill', runOn: 'local' });
    assert.strictEqual(row.sentence, null);
    assert.strictEqual(row.parts, null);
  });
});

describe('the header this view heads itself with', () => {
  test('the title is the name of the surface', () => {
    assert.strictEqual(m.header().title, 'Routines');
    assert.strictEqual(m.header().title, m.LEAD.title);
  });

  // AC-C3, unscoped: the locked sentence, word for word.
  test('unscoped, the subtitle is the locked sentence', () => {
    assert.strictEqual(m.header().subtitle,
      'Every scheduled skill across your team, and when it runs next.');
    assert.strictEqual(m.header({}).subtitle, m.LEAD.lead);
    assert.strictEqual(m.header({ agentName: null }).subtitle, m.LEAD.lead);
  });

  // AC-C3, scoped: a filtered list under an unfiltered sentence reads as a
  // list that has lost rows.
  test('scoped to an agent, the subtitle names that agent', () => {
    assert.strictEqual(m.header({ agentName: 'Piper' }).subtitle,
      'Every scheduled skill Piper runs, and when it runs next.');
    assert.strictEqual(m.header({ agentName: 'Wren' }).subtitle,
      'Every scheduled skill Wren runs, and when it runs next.');
  });

  // The name is substituted into the shipped sentence rather than concatenated
  // onto a fragment of one, so the whole of what ships is in the model.
  test('the scoped sentence is one string with a slot in it', () => {
    assert.match(m.LEAD.scopedLead, /\{agent\}/);
    assert.ok(!m.header({ agentName: 'Piper' }).subtitle.includes('{agent}'),
      'the slot reached the page');
  });

  // A DISPLAY NAME IS USER TEXT AND MUST NOT BE READ AS A PATTERN. A string
  // replacement interprets dollar sequences in what it is handed: $& is the
  // match, $` and $' the text either side, $$ a literal dollar. An agent can
  // be named anything.
  test('a name carrying a replacement pattern is inserted, not interpreted', () => {
    for (const name of ['A $& B', "$`", "$'", 'A $$ B', '$1', 'Ops $&$& team']) {
      assert.strictEqual(m.header({ agentName: name }).subtitle,
        `Every scheduled skill ${name} runs, and when it runs next.`,
        `the name ${name} was read as a replacement pattern rather than inserted`);
    }
  });

  test('an agent whose name is a token does not rewrite the sentence twice', () => {
    assert.strictEqual(m.header({ agentName: '{agent}' }).subtitle,
      'Every scheduled skill {agent} runs, and when it runs next.');
  });
});

describe('the one state the chrome is allowed to alarm about', () => {
  // AC-D2 AT THE MODEL. The rail asks this the same question a row asks, so
  // the ruling cannot say one thing on a row and another on the chrome. Each
  // non-failure state is asserted on its own: the four asserted together would
  // be one failure that could be any of them.
  const withFacts = (facts) => [{ ...facts }];

  test('a failed most recent completed run is a failure', () => {
    assert.strictEqual(m.anyFailure(withFacts(FAILED)), true);
  });

  test('a run the process died inside is a failure', () => {
    assert.strictEqual(m.anyFailure(withFacts({ ...FAILED, lastRunStatus: 'interrupted' })), true);
  });

  test('a missed slot is not a failure', () => {
    assert.strictEqual(m.anyFailure(withFacts(MISSED)), false,
      'the machine being off is not the routine failing');
  });

  test('a catch-up is not a failure', () => {
    assert.strictEqual(m.anyFailure(withFacts(CAUGHT_UP)), false, 'a late run is a success');
  });

  test('a run in flight is not a failure', () => {
    assert.strictEqual(m.anyFailure(withFacts({ ...FAILED, lastRunStatus: 'running' })), false,
      'a run that has not finished has no outcome to report');
  });

  test('a routine that has never run is not a failure', () => {
    assert.strictEqual(m.anyFailure(withFacts({ lastStart: null, lastRunStatus: null })), false);
  });

  test('a run that went fine is not a failure', () => {
    assert.strictEqual(m.anyFailure(withFacts(RAN_ON_TIME)), false);
  });

  // AC-D5 at the model.
  test('one failure among several is a failure', () => {
    assert.strictEqual(m.anyFailure([RAN_ON_TIME, MISSED, FAILED, CAUGHT_UP]), true);
  });

  test('another routine succeeding does not clear one that failed', () => {
    assert.strictEqual(m.anyFailure([FAILED, RAN_ON_TIME]), true);
  });

  test('a routine that failed and then succeeded is not failing', () => {
    assert.strictEqual(m.anyFailure([RAN_ON_TIME]), false,
      'the question is about the most recent completed run, not about history');
  });

  // THE PAUSE CLAUSE OF AC-D2, WITH A FIXTURE THAT WOULD RAISE THE DOT IF
  // PAUSE WERE IGNORED. A paused routine with no run history proves nothing
  // about pause: it is indistinguishable from one that has never run, and the
  // never-run branch already answers it. The pause has to be the only thing
  // between the routine and a dot.
  test('a paused routine whose last run failed is not a failure', () => {
    assert.strictEqual(m.anyFailure(withFacts({ ...FAILED, paused: true })), false,
      'a paused routine can never succeed again, so a dot it raised could never be cleared');
  });

  test('a paused routine whose last run was interrupted is not a failure', () => {
    assert.strictEqual(
      m.anyFailure(withFacts({ ...FAILED, lastRunStatus: 'interrupted', paused: true })), false);
  });

  test('the same routine unpaused is a failure, so the pause is what decides it', () => {
    assert.strictEqual(m.anyFailure(withFacts({ ...FAILED, paused: false })), true,
      'sanity: without the pause this fixture raises the dot');
  });

  test('a paused routine does not hide a failure on another routine', () => {
    assert.strictEqual(m.anyFailure([{ ...FAILED, paused: true }, { ...FAILED }]), true);
  });

  // AC-D1, READ LITERALLY, AND THE READING IS RECORDED HERE RATHER THAN LEFT
  // TO FALL OUT OF THE ROW'S RULE. A row says what happened most recently,
  // which is the later of a run and a slot that went by unserved. The rail
  // asks whether the last completed run failed. A failure followed by a night
  // with the machine shut is still a failure nobody has seen, and letting the
  // miss mask it would hide the only alarming state in the product behind the
  // most ordinary event there is.
  test('a missed slot after a failed run does not mask the failure on the rail', () => {
    const failedThenMissed = {
      ...FAILED,
      missedSlot: new Date(2026, 7, 20, 7, 0),
      lastStart: new Date(2026, 7, 19, 7, 0),
      lastSlot: new Date(2026, 7, 19, 7, 0),
    };
    assert.strictEqual(m.outcomeOf(failedThenMissed), 'missed',
      'sanity: the ROW says missed, because that is the newer fact');
    assert.strictEqual(m.anyFailure([failedThenMissed]), true,
      'the rail asks about the last completed run, and it failed');
  });

  // The two questions share what a failure IS, so they cannot drift apart on
  // that while deliberately differing on what masks one.
  test('the row and the rail agree on which statuses are failures', () => {
    for (const status of ['failed', 'interrupted']) {
      const facts = { ...FAILED, lastRunStatus: status };
      assert.strictEqual(m.outcomeOf(facts), 'failed', status);
      assert.strictEqual(m.lastCompletedRunFailed(facts), true, status);
    }
    for (const status of ['completed', 'running', null]) {
      assert.strictEqual(m.lastCompletedRunFailed({ ...FAILED, lastRunStatus: status }), false, String(status));
    }
  });

  test('nothing at all is not a failure', () => {
    assert.strictEqual(m.anyFailure([]), false);
    assert.strictEqual(m.anyFailure(), false);
    assert.strictEqual(m.anyFailure(null), false);
  });
});

// ===== A ROUTINE THE UPGRADE HELD BACK =====
//
// A routine whose file never said `enabled` is not running, and the reason it
// is not running is that nobody has yet said it may. That is a state with an
// action attached, which is what separates it from every other state on this
// list: paused is a decision already taken, and the four outcomes are history.
// This one is a question waiting for an answer.
//
// THE OFFER HAS TO SAY WHAT ACCEPTING IT DOES. Somebody upgrading arrives with
// cron already running these jobs, so "Turn on" alone reads as tidying a
// switch. What they need to know before pressing it is that Rundock will begin
// running the routine itself, which is the sentence that stops a briefing going
// out twice.
describe('a routine nobody has turned on yet', () => {
  // A ROUTINE HELD BACK AND NOTHING ELSE. It carries a schedule the scheduler
  // can read, because the offer is only made when turning it on is the one
  // thing in the way, and a fixture with no schedule at all is a routine that
  // could never run whatever the switch said.
  const NOT_ENABLED = {
    enabled: false, paused: false, nextRun: TOMORROWS_SLOT,
    schedule: 'every day at 07:00', scheduleReadable: true, runOn: 'local',
  };
  const offer = (input) => m.enableOffer({ ...input, now: NOW, zone: ZONE });

  test('the offer states that Rundock will begin running it', () => {
    const o = offer(NOT_ENABLED);
    assert.ok(o, 'a routine that is not enabled makes no offer');
    assert.match(o.text, /Rundock/,
      'the offer does not say who begins running it');
    assert.match(o.text, /\brun/i,
      'the offer does not say that turning it on starts it running');
    assert.strictEqual(o.label, 'Turn on');
  });

  // The state is only ever reached from the file saying so. A routine that is
  // enabled, and one that says nothing about it at all because it arrived from
  // somewhere that does not carry the field, both make no offer: an offer
  // drawn on a routine that is already running is an invitation to break it.
  test('nothing else on the list makes this offer', () => {
    assert.strictEqual(offer({ enabled: true, nextRun: TOMORROWS_SLOT }), null);
    assert.strictEqual(offer({ nextRun: TOMORROWS_SLOT }), null);
    assert.strictEqual(offer(null), null);
  });

  // THE ROW MUST NOT PROMISE A RUN IT WILL NOT MAKE. The server computes a next
  // run from the schedule alone, so a routine held back by the upgrade still
  // arrives carrying tomorrow's instant. Rendering it would put "Next run:
  // tomorrow, 7:00am" on a routine that will never run, which is worse than
  // saying nothing: it is the exact reassurance the reader is looking for.
  test('a routine that is not enabled promises no next run', () => {
    assert.strictEqual(next(NOT_ENABLED), null);
    // And the ordinary routine beside it still does, so this is the state
    // rather than a next-run line that stopped working.
    assert.ok(next({ enabled: true, nextRun: TOMORROWS_SLOT }));
  });

  // WHEN THE FIRST RUN LANDS IS SAID ONLY WHERE IT IS TRUE.
  //
  // Same-day catch-up means a slot already gone today fires within the minute,
  // which is what this reader most needs to know: their own scheduler ran the
  // same job this morning. But it is not true on every row the offer appears
  // on. A routine that already ran today and was then switched off is
  // suppressed until tomorrow by the run guard, and a weekly routine turned on
  // away from its weekday does not run shortly at all.
  //
  // So the sentence is read off the instant the server computed, which already
  // accounts for both: it is the same value the next-run line would render.
  // Past means catch-up, future means then, and none means nothing is said.
  const offerAt = (nextRun) => offer({ ...NOT_ENABLED, nextRun });

  test('a slot already gone says the first run is immediate', () => {
    assert.match(offerAt(new Date(2026, 7, 20, 7, 0)).text,
      /has already gone, so it runs shortly after you turn it on/);
  });

  test('a run still to come names when, rather than promising it is immediate', () => {
    const text = offerAt(new Date(2026, 7, 21, 7, 0)).text;
    assert.match(text, /it runs tomorrow, 7:00am/,
      'the offer does not say when the first run lands');
    assert.ok(!/shortly after you turn it on/.test(text),
      'a routine whose time has not come is told it runs straight away');
  });

  // A routine that already ran today and was switched off. The scheduler
  // suppresses it until tomorrow, so it has no next run at all, and the offer
  // says nothing about timing rather than guessing.
  test('no next run at all means the offer promises no timing', () => {
    const text = offerAt(null).text;
    assert.ok(!/shortly after you turn it on/.test(text));
    assert.ok(!/it runs /.test(text), `the offer invented a time: ${text}`);
    assert.match(text, /Rundock will start running it on this schedule/);
  });

  test('the offer reaches the row', () => {
    const row = m.row({ ...NOT_ENABLED, name: 'Compile the ops summary', now: NOW, zone: ZONE });
    assert.ok(row.offer, 'the row drops the offer');
    assert.strictEqual(row.offer.label, 'Turn on');
    assert.strictEqual(row.nextRun, null);
  });
});

// ===== A SCHEDULE THE SCHEDULER CANNOT READ =====
//
// Whether a schedule parses is the SCHEDULER'S question, answered on the server
// and carried on the roster. It is deliberately not asked again here: the
// editor offers times on the half hour, so `scheduleWords` returns null for
// `every day at 07:03` as well, which the scheduler reads perfectly well. A row
// that judged readability by whether it had plain words to show would tell a
// working routine it will never fire.
describe('a routine whose schedule the scheduler cannot read', () => {
  const problem = (input) => m.scheduleProblem(input);

  test('the row is told it will not run, and what to change', () => {
    const p = problem({ schedule: '0 7 * * *', scheduleReadable: false });
    assert.ok(p, 'an unreadable schedule raises nothing');
    assert.match(p.text, /cannot read this schedule/i);
    // Both accepted shapes, by example rather than by description. A reader
    // who has just been told their schedule is wrong needs one they can copy.
    assert.match(p.text, /every day at 07:00/);
    assert.match(p.text, /every Monday at 07:00/);
  });

  test('a schedule the scheduler reads raises nothing', () => {
    assert.strictEqual(problem({ schedule: 'every day at 07:00', scheduleReadable: true }), null);
    // Including the ones with no plain words to show, which is the case that
    // would break if this asked the editor's lists instead of the scheduler.
    assert.strictEqual(problem({ schedule: 'every day at 07:03', scheduleReadable: true }), null);
  });

  // A ROSTER THAT DID NOT CARRY THE FIELD SAYS NOTHING, rather than accusing
  // every routine on it. The fact is new, and a client meeting an older server,
  // or any caller that builds a row by hand, must not turn silence into a
  // complaint about a routine that runs perfectly well.
  test('a routine that never said raises nothing', () => {
    assert.strictEqual(problem({ schedule: 'every day at 07:00' }), null);
    assert.strictEqual(problem({}), null);
    assert.strictEqual(problem(null), null);
  });

  // A routine with no schedule at all is a different fault, and telling its
  // owner to change a schedule they never wrote is an answer to a question
  // nobody asked.
  test('a routine with no schedule at all is not told to change one', () => {
    assert.strictEqual(problem({ schedule: null, scheduleReadable: false }), null);
    assert.strictEqual(problem({ schedule: '   ', scheduleReadable: false }), null);
  });

  // NAMED HERE AS WELL AS SWEPT. The combination sweep also fails without this
  // guard, because it builds a row carrying an unreadable schedule and a next
  // run together. This states the property on its own so the failure names it
  // rather than naming a combination the reader then has to decode.
  test('an instant supplied with an unreadable schedule is still not promised', () => {
    assert.strictEqual(m.nextRunLabel({
      schedule: '0 7 * * *', scheduleReadable: false,
      nextRun: TOMORROWS_SLOT, now: NOW, zone: ZONE,
    }), null, 'a row promised a run for a schedule nothing can read');
    // The same instant on a readable schedule is promised, so this is the
    // guard rather than an instant the model cannot render.
    assert.ok(m.nextRunLabel({
      schedule: 'every day at 07:00', scheduleReadable: true,
      nextRun: TOMORROWS_SLOT, now: NOW, zone: ZONE,
    }));
  });

  test('the problem reaches the row, and the row promises no run', () => {
    const row = m.row({
      name: 'Cron briefing', schedule: '0 7 * * *', scheduleReadable: false,
      enabled: true, paused: false, nextRun: null, now: NOW, zone: ZONE,
    });
    assert.ok(row.scheduleProblem, 'the row drops the problem');
    assert.strictEqual(row.nextRun, null);
  });
});

// ===== NO ROW SAYS TWO THINGS THAT CANNOT BOTH BE TRUE =====
//
// THE DEFECT THIS BLOCK EXISTS FOR, and the reason it is an enumeration rather
// than one more test. A row is composed of lines decided independently: what
// happened last time, when it runs next, whether the schedule can be read, and
// whether anything is being offered. Each was correct on its own. Put two of
// them on one row and the row could contradict itself.
//
// The pairing this is built around: a routine that predates the scheduler AND
// carries a cron schedule, which is every pre-existing cron routine after an
// upgrade, since the reader fills an absent `enabled` in as false and nothing
// ever rewrites a schedule. Such a row has grounds to say both "Rundock cannot
// read this schedule, so this routine will not run" and "Turn it on and
// Rundock will start running it on this schedule". The second is false there:
// turning it on starts nothing, because the schedule is still unreadable.
//
// THE RULE THAT REPLACES THE SPECIAL CASE. The offer is made only when turning
// it on is the ONLY thing standing between the routine and running. That is
// the scheduler's own refusal order asked on this side, so the offer cannot
// promise something the gate will refuse for a second reason.
//
// The enumeration is the fix rather than the pairing, because that pairing is
// one of several: paused, an unsupported run target and a routine with no
// schedule at all each falsify the same sentence.
describe('a row never says two things that cannot both be true', () => {
  // Every fact a row can carry that decides whether it runs, and what each one
  // means for the offer. `held` is the state this card creates.
  const held = { enabled: false, schedule: 'every day at 07:00', scheduleReadable: true, runOn: 'local', paused: false };

  const BLOCKED = [
    ['paused as well', { ...held, paused: true }],
    ['a schedule nothing can read', { ...held, schedule: '0 7 * * *', scheduleReadable: false }],
    // A block with a name and a prompt and no schedule at all. The parser
    // keeps any block that has a name, so this reaches the roster, and the
    // scheduler reports it unreadable because there is nothing to read.
    ['no schedule at all', { ...held, schedule: null, scheduleReadable: false }],
    ['a schedule that is only spaces', { ...held, schedule: '   ', scheduleReadable: false }],
    ['a run target this release cannot run', { ...held, runOn: 'agent-computer' }],
  ];

  // A ROUTINE THAT WAS NEVER TURNED ON DID NOT MISS ANYTHING.
  //
  // The slot store records every scheduled slot that went by unobserved, for
  // every routine, whatever the gate would have said. That is deliberate and
  // pinned in test/unit/scheduler-lib.test.js: the store keeps the facts and
  // the view decides what to make of them.
  //
  // What the view has to make of them here: the missed line names its cause,
  // "Rundock was closed at 7:00am yesterday". For a routine nobody has ever
  // turned on that cause is false. Rundock may well have been open all night;
  // the routine was never in service. Naming the wrong cause on the one screen
  // a person opens when a routine has not run is worse than naming none, and
  // it would sit directly above an offer to turn the routine on.
  //
  // ONLY THE MISSED OUTCOME IS WITHHELD. A run that happened, or failed, is
  // real history from when the routine was running, and a row that hid it
  // would be hiding the truth rather than declining to invent it.
  test('a routine nobody turned on reports no missed slot', () => {
    const missed = { missedSlot: YESTERDAYS_SLOT, lastStart: null, lastRunStatus: null, now: NOW, zone: ZONE };
    assert.strictEqual(m.runStatus({ ...missed, enabled: false }), null,
      'a routine that was never in service was told Rundock was closed on it');
    // The same slot on a routine in service still reports, so this is the
    // state rather than the missed line quietly breaking.
    const inService = m.runStatus({ ...missed, enabled: true });
    assert.ok(inService && inService.kind === 'missed');
  });

  // THE INPUT THE FIRST VERSION OF THIS RULE NEVER MET. A routine that ran and
  // failed, was switched off, and then had a slot pass. The missed slot is the
  // NEWER fact, so the withheld branch is the one taken, and returning null
  // there hides the failure entirely rather than falling through to it. The
  // rule is that the missed outcome is withheld, not that the row goes quiet.
  test('a routine switched off after a failure still reports the failure', () => {
    const status = m.runStatus({
      enabled: false,
      lastStart: new Date(2026, 7, 17, 7, 0), lastRunStatus: 'failed',
      lastSlot: new Date(2026, 7, 17, 7, 0),
      missedSlot: YESTERDAYS_SLOT,
      now: NOW, zone: ZONE,
    });
    assert.ok(status, 'the row went silent about a run that really happened');
    assert.strictEqual(status.kind, 'failed',
      'the failure was hidden by the slot that passed after it');
  });

  test('a routine nobody turned on still reports a run that really happened', () => {
    const ran = {
      enabled: false, lastStart: new Date(2026, 7, 20, 7, 0, 12), lastRunStatus: 'failed',
      lastSlot: TODAYS_SLOT, missedSlot: null, now: NOW, zone: ZONE,
    };
    const status = m.runStatus(ran);
    assert.ok(status && status.kind === 'failed',
      'history from when the routine was running was hidden rather than reported');
  });

  test('the offer is made when turning it on is the only thing in the way', () => {
    const o = m.enableOffer(held);
    assert.ok(o, 'a routine held back by nothing but the switch makes no offer');
    assert.strictEqual(o.label, 'Turn on');
  });

  // Each of these would make the offer's sentence false, so the offer is
  // withheld rather than reworded: there is nothing truthful a Turn on control
  // can promise on a row that will not run once it is pressed.
  for (const [what, input] of BLOCKED) {
    test(`no offer on a routine that also has ${what}`, () => {
      assert.strictEqual(m.enableOffer(input), null,
        'the row offers to start a routine that would still not run');
    });
  }

  // THE PAIRING, DRIVEN RATHER THAN REASONED.
  //
  // A row is built from lines decided independently, so the question is not
  // "is this instance fixed" but "which pairs of lines can disagree". Two
  // kinds of line can: one that PROMISES the routine will run, and one that
  // DENIES it. Every combination of the states listed below is built and
  // rendered here, and any row carrying one of each fails.
  //
  // Reading the pairs off the states rather than listing them by hand is the
  // point: a state joins the matrix by being added to STATES, and if it can
  // produce both kinds of line the test fails without anybody having thought
  // to pair it with the others.
  //
  // WHAT THIS SWEEP COVERS, EXACTLY: the states in STATES, and no others. It
  // is not a sweep over everything a row can carry, and the difference matters
  // because reading it as one is how a gap gets missed.
  //
  // THE RUN STATUS VOCABULARY IS OUTSIDE IT. `lastRunStatus` carries a word
  // the scheduler chose, and the set of those words grows: `cancelled` was
  // added after this sweep was written and is not among the states below, so
  // no row here is built with it. That omission is deliberate rather than an
  // oversight left standing. A cancelled run currently reads as an ordinary
  // one on this list, and settling what such a row should say, and what tone
  // it takes beside the four outcomes, is a decision this file cannot make on
  // its own. Adding the state here without that decision would pin whatever
  // the code happens to do today.
  //
  // So: this sweep says nothing about a cancelled run. If you came here
  // believing it did, that belief is the thing to correct.
  const STATES = [
    ['held back', { enabled: false }],
    ['paused', { paused: true }],
    ['an unreadable schedule', { schedule: '0 7 * * *', scheduleReadable: false }],
    // THE STATE THE SWEEP DID NOT CONTAIN, which is how it claimed more than
    // it covered. A routine with no schedule can never run, and the row says
    // nothing about it, so nothing else in the matrix stood in for it.
    ['no schedule at all', { schedule: null, scheduleReadable: false }],
    ['a run target this release cannot run', { runOn: 'agent-computer' }],
    ['a slot that went by', { missedSlot: YESTERDAYS_SLOT }],
    ['a next run', { nextRun: TOMORROWS_SLOT }],
    ['a run that failed', { lastStart: TODAYS_SLOT, lastRunStatus: 'failed', lastSlot: TODAYS_SLOT }],
  ];

  // What the row says, split by what it claims about running.
  function claims(row) {
    const promising = [];
    const denying = [];
    if (row.offer) promising.push(`offer: ${row.offer.text}`);
    if (row.nextRun && row.nextRun.text !== 'Paused') promising.push(`next run: ${row.nextRun.text}`);
    if (row.nextRun && row.nextRun.text === 'Paused') denying.push('next run: Paused');
    if (row.scheduleProblem) denying.push(`problem: ${row.scheduleProblem.text}`);
    // A RUN STATUS IS DELIBERATELY NEITHER. It reports the past, and the row
    // pairs it with the next run ON PURPOSE, because after a miss or a failure
    // the reader's question is whether it recovered and when it tries again.
    // Counting a missed line as denying a future run would make this test
    // demand the removal of the second line the row exists to draw. What a run
    // status can get wrong is not the future but its own cause, which is the
    // rule below.
    //
    // Only the `missed` outcome is read here, because it is the only one this
    // sweep has a rule for. Whether every word the scheduler can record ends
    // up in an outcome at all is a question this sweep does not ask.
    return { promising, denying };
  }

  test('no combination of row states promises a run and denies one at the same time', () => {
    const base = { name: 'r', schedule: 'every day at 07:00', scheduleReadable: true, runOn: 'local', now: NOW, zone: ZONE };
    let combinations = 0;
    // Every subset of the states above, so each pair is met inside at least
    // one row rather than only the pairs somebody thought to write down.
    for (let mask = 0; mask < (1 << STATES.length); mask++) {
      const picked = STATES.filter((_, i) => mask & (1 << i));
      const input = Object.assign({}, base, ...picked.map(([, fields]) => fields));
      const { promising, denying } = claims(m.row(input));
      combinations++;
      assert.ok(!(promising.length && denying.length),
        `a row with ${picked.map(([n]) => n).join(' + ') || 'nothing'} says both:\n`
        + `  promising: ${promising.join(' | ')}\n  denying:   ${denying.join(' | ')}`);
    }
    assert.strictEqual(combinations, 1 << STATES.length,
      'the sweep did not cover every combination it claims to');
  });

  // THE SECOND KIND OF FALSEHOOD A ROW CAN CARRY, and the one the sweep above
  // cannot see: a line that is true about the future while naming a cause that
  // never happened.
  //
  // The missed line says "Rundock was closed at 7:00am yesterday". On a
  // routine nobody has ever turned on, that is simply untrue: Rundock may have
  // been open throughout, and the routine was not in service. The row would
  // explain an absence by an event that did not occur, directly above an offer
  // to fix something else.
  test('no row explains an absence by a cause that did not apply', () => {
    const base = { name: 'r', schedule: 'every day at 07:00', scheduleReadable: true, runOn: 'local', now: NOW, zone: ZONE };
    for (let mask = 0; mask < (1 << STATES.length); mask++) {
      const picked = STATES.filter((_, i) => mask & (1 << i));
      const input = Object.assign({}, base, ...picked.map(([, fields]) => fields));
      const row = m.row(input);
      if (!row.status || row.status.kind !== 'missed') continue;
      assert.notStrictEqual(input.enabled, false,
        `a row with ${picked.map(([n]) => n).join(' + ')} says "${row.status.text}" `
        + 'about a routine that was never in service');
    }
  });
});
