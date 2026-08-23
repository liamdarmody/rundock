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
const RAN_ON_TIME = {
  lastRun: new Date(2026, 7, 20, 7, 0, 12), lastRunStatus: 'completed', lastSlot: TODAYS_SLOT,
  missedSlot: null, nextRun: TOMORROWS_SLOT,
};
const CAUGHT_UP = {
  lastRun: new Date(2026, 7, 20, 9, 14), lastRunStatus: 'completed', lastSlot: TODAYS_SLOT,
  missedSlot: null, nextRun: TOMORROWS_SLOT,
};
const MISSED = {
  lastRun: new Date(2026, 7, 18, 7, 0), lastRunStatus: 'completed', lastSlot: new Date(2026, 7, 18, 7, 0),
  missedSlot: YESTERDAYS_SLOT, nextRun: TODAYS_SLOT,
};
const FAILED = {
  lastRun: new Date(2026, 7, 20, 7, 0), lastRunStatus: 'failed', lastSlot: TODAYS_SLOT,
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
  test('a late run keeps the success tone and a passed slot does not take the failure one', () => {
    assert.strictEqual(status(RAN_ON_TIME).tone, 'ok');
    assert.strictEqual(status(CAUGHT_UP).tone, 'ok-quiet');
    assert.strictEqual(status(MISSED).tone, 'neutral');
    assert.strictEqual(status(FAILED).tone, 'failed');
    // The two successes share a hue and differ by weight, which is what the
    // tone names carry: ok and ok-quiet are one colour, neutral is not.
    assert.ok(m.TONES.ok.colour === m.TONES['ok-quiet'].colour);
    assert.ok(m.TONES.ok.weight > m.TONES['ok-quiet'].weight);
    assert.notStrictEqual(m.TONES.neutral.colour, m.TONES.ok.colour);
    assert.notStrictEqual(m.TONES.failed.colour, m.TONES.neutral.colour);
    // Nothing here reaches for amber. The legend spends that colour on
    // "needs the user, not an error", which none of these four states is.
    for (const tone of Object.values(m.TONES)) {
      assert.notStrictEqual(tone.colour, 'var(--attention)');
    }
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
    assert.strictEqual(status({ lastRun: null, lastRunStatus: null, lastSlot: null, missedSlot: null }), null);
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
    const justLate = { ...RAN_ON_TIME, lastRun: new Date(2026, 7, 20, 7, 1, 30) };
    assert.strictEqual(status(justLate).kind, 'on-time');
    const wellLate = { ...RAN_ON_TIME, lastRun: new Date(2026, 7, 20, 7, 30) };
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
      m.LEAD, m.EMPTY, m.OUTCOMES,
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

  test('the files this card adds carry no em dash or en dash', () => {
    const root = path.join(__dirname, '..', '..');
    for (const rel of [
      'public/routines-model.js', 'public/views/routines.js', 'public/rail-presence.js',
      'public/styles/views/routines.css',
      'test/unit/routines-model.test.js', 'test/unit/routines-view.test.js',
      'test/unit/routines-next-run.test.js', 'test/tools/mutate-routines-guards.js',
    ]) {
      const text = fs.readFileSync(path.join(root, rel), 'utf-8');
      assert.ok(!/[\u2014\u2013]/.test(text), `${rel} carries a dash the repository check refuses`);
    }
  });
});
