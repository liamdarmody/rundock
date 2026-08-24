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
      m.LEAD, m.EMPTY, m.OUTCOMES, m.ACTION_PROBLEM,
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

  test('an agent whose name is a token does not rewrite the sentence twice', () => {
    assert.strictEqual(m.header({ agentName: '{agent}' }).subtitle,
      'Every scheduled skill {agent} runs, and when it runs next.');
  });
});
