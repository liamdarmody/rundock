'use strict';
// A routine that runs on a chosen set of days.
//
// `every weekday at 09:00` is Monday to Friday, and `every monday, wednesday
// and sunday at 09:00` is those three. The scheduler reads both, the writer's
// save check accepts both, and the editor reopens both as a week with exactly
// those days ticked. Each set of days has one saved form, so two files that
// mean the same days say them the same way.
//
// EVERY FORM AN EARLIER RELEASE READ STILL READS AS IT DID. The comparison
// below runs a frozen copy of the grammar this release replaced over every
// form it read, and asks for the same answer, form by form.

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const scheduler = require('../../lib/scheduler.js');
const { isWritableSchedule } = require('../../lib/agents/routines.js');
const editor = require('../../public/routine-editor-model.js');
const rows = require('../../public/routines-model.js');
const before = require('../helpers/schedule-grammar-before-days.js');

const WEEK = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const GET_DAY = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const WEEKDAYS = WEEK.slice(0, 5);

// Every non-empty set of days, Monday first: 127 of them.
function everySet() {
  const out = [];
  for (let bits = 1; bits < 128; bits++) out.push(WEEK.filter((_, i) => bits & (1 << i)));
  return out;
}

// The saved form of a set, worked out here from its rule rather than read off
// the code under test: all seven are every day, exactly Monday to Friday is
// weekday, one day is its name, and any other set is its days Monday first,
// joined by commas and a final "and".
function canonical(set) {
  if (set.length === 7) return 'day';
  if (set.join() === WEEKDAYS.join()) return 'weekday';
  if (set.length === 1) return set[0];
  return `${set.slice(0, -1).join(', ')} and ${set[set.length - 1]}`;
}

// The days a reopened schedule has ticked: all seven for every day.
const reopenedDays = (r) => (r && r.frequency === 'day' ? WEEK.slice() : r && r.days);

// ===== THE GRAMMAR AN EARLIER RELEASE READ, FROZEN =====
//
// The scheduler as it was before sets of days, copied in the helper, so a
// change to any form it read is seen here as a different answer. Not to be
// updated with the scheduler: it is the record of what that build did.
const priorParse = before.parseBefore;

// Every form the earlier release read, in the cases and times a file holds.
function priorForms() {
  const times = ['00:00', '06:30', '07:00', '07:03', '09:00', '12:00', '18:45', '23:59'];
  const out = [];
  for (const time of times) {
    out.push(`every day at ${time}`, `Every Day at ${time}`, `EVERY DAY AT ${time}`);
    for (const day of WEEK) {
      out.push(`every ${day} at ${time}`, `Every ${day[0].toUpperCase()}${day.slice(1)} at ${time}`,
        `EVERY ${day.toUpperCase()} AT ${time}`);
    }
    for (let n = 1; n <= 28; n++) {
      out.push(`on day ${n} of every month at ${time}`);
      if (n < 10) out.push(`on day 0${n} of every month at ${time}`);
    }
    out.push(`on the last day of every month at ${time}`, `On The Last Day Of Every Month At ${time}`);
  }
  // Forms a file can hold that the earlier grammar read, by its loose match.
  out.push('run every day at 07:00 please', 'every day at 07:00 then every monday at 09:00',
    'every monday and every friday at 09:00', 'every tuesday, every monday at 09:00',
    'on day 15 of every month at 09:00 and every friday at 08:00', 'every day at 25:00');
  return out;
}

describe('the grammar: a set of days', () => {
  test('`every weekday at HH:MM` is read as Monday to Friday', () => {
    assert.deepStrictEqual(scheduler.parseSchedule('every weekday at 09:00'),
      { kind: 'days', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 });
    assert.deepStrictEqual(scheduler.parseSchedule('Every Weekday at 18:30'),
      { kind: 'days', days: [1, 2, 3, 4, 5], hour: 18, minute: 30 });
  });

  test('a list of full day names in any order and any case is read as that set', () => {
    assert.deepStrictEqual(scheduler.parseSchedule('every monday, wednesday and sunday at 09:00'),
      { kind: 'days', days: [1, 3, 0], hour: 9, minute: 0 });
    assert.deepStrictEqual(scheduler.parseSchedule('Every Sunday, Monday And WEDNESDAY at 09:00'),
      { kind: 'days', days: [1, 3, 0], hour: 9, minute: 0 }, 'the same set, whatever the order and case');
    assert.deepStrictEqual(scheduler.parseSchedule('every saturday and sunday at 07:30'),
      { kind: 'days', days: [6, 0], hour: 7, minute: 30 });
    assert.deepStrictEqual(scheduler.parseSchedule('every friday, thursday, wednesday, tuesday and monday at 09:00'),
      { kind: 'days', days: [1, 2, 3, 4, 5], hour: 9, minute: 0 }, 'Monday to Friday by name is weekday');
    assert.deepStrictEqual(
      scheduler.parseSchedule('every sunday, saturday, friday, thursday, wednesday, tuesday and monday at 09:00'),
      { kind: 'daily', hour: 9, minute: 0 }, 'all seven are every day, and walk its slots');
  });

  // A SET READS A CLOCK TIME OR NOTHING. 25:00 on a Saturday is 01:00 on
  // Sunday, so a set read at an hour past 23 would put a slot on the next day,
  // which the set may leave out, and the walk would skip a date. The forms an
  // earlier release read keep rolling as they did.
  test('a set at an hour past 23 or a minute past 59 reads as nothing, and the earlier forms still roll', () => {
    for (const schedule of [
      'every saturday and sunday at 25:00',
      'every weekday at 24:00',
      'every monday and friday at 09:60',
      'every monday, wednesday and sunday at 99:99',
    ]) {
      assert.strictEqual(scheduler.parseSchedule(schedule), null, `parseSchedule on "${schedule}"`);
      assert.strictEqual(scheduler.getNextRun(schedule, null), null, `"${schedule}" is never due`);
      assert.strictEqual(isWritableSchedule(schedule), false, `isWritableSchedule on "${schedule}"`);
    }
    for (const schedule of ['every day at 25:00', 'every monday at 25:00', 'on day 15 of every month at 25:00']) {
      assert.ok(priorParse(schedule), `sanity: the earlier grammar read "${schedule}"`);
      assert.deepStrictEqual(scheduler.parseSchedule(schedule), priorParse(schedule), `"${schedule}" reads as it did`);
    }
  });

  test('every form the earlier release read gives the same result, form by form', () => {
    const differ = [];
    for (const schedule of priorForms()) {
      const before = priorParse(schedule);
      if (!before) continue;
      const now = scheduler.parseSchedule(schedule);
      if (JSON.stringify(now) !== JSON.stringify(before)) {
        differ.push(`${schedule}: was ${JSON.stringify(before)}, now ${JSON.stringify(now)}`);
      }
    }
    assert.ok(priorForms().filter(priorParse).length > 400, 'sanity: the forms were generated and read');
    assert.deepStrictEqual(differ, [], 'a form the earlier release read now reads differently');
  });

  test('a misspelled day, a repeated day or an empty list reads as nothing, to every reader', () => {
    for (const schedule of [
      'every wensday and friday at 09:00',
      'every mon and fri at 09:00',
      'every monday and monday at 09:00',
      'every monday, friday and monday at 09:00',
      'every weekday and saturday at 09:00',
      'every monday, friday at 09:00',
      'every monday, wednesday, and friday at 09:00',
      'every monday and at 09:00',
      'every  at 09:00',
      'every and at 09:00',
      'every , and at 09:00',
      'every weekdays at 09:00',
    ]) {
      assert.strictEqual(scheduler.parseSchedule(schedule), null, `parseSchedule on "${schedule}"`);
      assert.strictEqual(isWritableSchedule(schedule), false, `isWritableSchedule on "${schedule}"`);
      assert.strictEqual(editor.readSchedule(schedule), null, `readSchedule on "${schedule}"`);
      assert.strictEqual(rows.scheduleWords(schedule), null, `scheduleWords on "${schedule}"`);
      assert.strictEqual(editor.reopenSchedule({ schedule }), null, `reopenSchedule on "${schedule}"`);
    }
  });

  // ONE GRAMMAR, NOT A COPY PER READER. Every list a file could hold, written
  // the right way and several wrong ones, is asked of the scheduler, the save
  // check, the editor's reopen and the row's sentence. Wherever the scheduler
  // reads a set at an offered time, all of them do, and wherever it does not,
  // none of them does.
  test('the save check, the row sentence and the reopen read exactly the sets the scheduler reads', () => {
    const variants = (set) => {
      const names = set.slice().reverse();
      return [
        canonical(set),
        names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0],
        set.join(' and '),
        set.join(', '),
        set.length > 2 ? `${set.slice(0, -1).join(', ')}, and ${set[set.length - 1]}` : null,
        set.concat(set[0]).join(', ').replace(/, ([a-z]+)$/, ' and $1'),
        set.map(d => d.slice(0, 3)).join(' and '),
      ].filter(Boolean);
    };
    let read = 0;
    let refused = 0;
    for (const set of everySet()) {
      for (const words of variants(set)) {
        const schedule = `every ${words} at 09:00`;
        const parsed = scheduler.parseSchedule(schedule);
        const scheduled = !!parsed && (parsed.kind === 'days' || parsed.kind === 'weekly' || parsed.kind === 'daily');
        const verdicts = {
          'the save check': isWritableSchedule(schedule),
          'the reopen': editor.readSchedule(schedule) !== null,
          'the row sentence': rows.scheduleWords(schedule) !== null,
        };
        for (const [reader, verdict] of Object.entries(verdicts)) {
          assert.strictEqual(verdict, scheduled, `${reader} and the scheduler disagree on "${schedule}"`);
        }
        if (scheduled) {
          read += 1;
          const days = parsed.kind === 'daily' ? WEEK : WEEK.filter(d => (parsed.kind === 'weekly'
            ? parsed.day === GET_DAY[d] : parsed.days.includes(GET_DAY[d])));
          assert.deepStrictEqual(reopenedDays(editor.readSchedule(schedule)), days,
            `the reopen ticks other days than the scheduler fires on for "${schedule}"`);
        } else refused += 1;
      }
    }
    assert.ok(read > 250 && refused > 250, `sanity: both verdicts were reached (${read} read, ${refused} refused)`);
  });
});

describe('one saved form per set of days', () => {
  test('all seven save as every day, Monday to Friday as every weekday, one day by its name', () => {
    const build = (days) => editor.buildSchedule({ frequency: 'week', days, time: '09:00' });
    assert.strictEqual(build(WEEK), 'every day at 09:00');
    assert.strictEqual(build(WEEKDAYS), 'every weekday at 09:00');
    assert.strictEqual(build(['friday', 'thursday', 'wednesday', 'tuesday', 'monday']), 'every weekday at 09:00');
    assert.strictEqual(build(['wednesday']), 'every wednesday at 09:00');
    assert.strictEqual(build(['sunday', 'monday', 'wednesday']), 'every monday, wednesday and sunday at 09:00',
      'any other set is Monday first, in full lowercase names, with commas and a final "and"');
    assert.strictEqual(build(['saturday', 'sunday']), 'every saturday and sunday at 09:00');
    assert.strictEqual(build([]), null, 'no day saves nothing');
  });

  test('all 127 sets save in their one form, and reopen and fire as the same set', () => {
    for (const set of everySet()) {
      const built = editor.buildSchedule({ frequency: 'week', days: set, time: '09:00' });
      assert.strictEqual(built, `every ${canonical(set)} at 09:00`);
      assert.strictEqual(isWritableSchedule(built), true, `${built} is refused by the writer`);
      const reopened = editor.readSchedule(built);
      assert.deepStrictEqual(reopenedDays(reopened), set, `${built} reopens on other days`);
      assert.strictEqual(reopened.time, '09:00');
      assert.strictEqual(editor.buildSchedule(reopened), built, `${built} saves differently once reopened`);
      const parsed = scheduler.parseSchedule(built);
      const fires = parsed.kind === 'daily' ? WEEK.map(d => GET_DAY[d])
        : parsed.kind === 'weekly' ? [parsed.day] : parsed.days;
      assert.deepStrictEqual(fires, set.map(d => GET_DAY[d]), `${built} fires on other days`);
    }
  });

  test('a hand-typed equivalent reads as the same set and is written in the one form on the next save', () => {
    for (const set of everySet()) {
      const names = set.slice().reverse().map(d => d[0].toUpperCase() + d.slice(1));
      const typed = `Every ${names.length > 1 ? `${names.slice(0, -1).join(', ')} And ${names[names.length - 1]}` : names[0]} at 09:00`;
      const reopened = editor.readSchedule(typed);
      assert.deepStrictEqual(reopenedDays(reopened), set, `"${typed}" reopens on other days`);
      assert.strictEqual(editor.buildSchedule(reopened), `every ${canonical(set)} at 09:00`,
        `"${typed}" is not rewritten in its one form`);
    }
  });
});

describe('the editor: day, week and month', () => {
  test('the dropdown offers exactly day, week and month', () => {
    assert.deepStrictEqual(editor.FREQUENCIES.map(f => f.value), ['day', 'week', 'month']);
    assert.deepStrictEqual(editor.FREQUENCIES.map(f => f.label), ['day', 'week', 'month']);
  });

  test('week has a row of the seven days, Monday first, each named in full', () => {
    const week = editor.scheduleStepFields().week;
    assert.strictEqual(week.lead, 'on');
    assert.strictEqual(week.label, 'Days this routine runs');
    assert.deepStrictEqual(week.days.map(d => d.value), WEEK);
    assert.deepStrictEqual(week.days.map(d => d.label), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    assert.deepStrictEqual(week.days.map(d => d.name),
      ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
    for (const d of week.days) assert.ok(d.name.startsWith(d.label), `${d.name} does not contain ${d.label}`);
  });

  // THE WEEK START RULE. From every day, the week starts with every day ticked,
  // which is the same schedule; from a month, which names no day of the week,
  // it starts with none, and asks.
  test('choosing week from day ticks all seven, from month ticks none, and from week keeps its days', () => {
    assert.deepStrictEqual(editor.chooseFrequency({ frequency: 'day', time: '09:00' }, 'week').days, WEEK);
    assert.deepStrictEqual(editor.chooseFrequency({ frequency: 'month', day: '15', time: '09:00' }, 'week').days, []);
    assert.deepStrictEqual(
      editor.chooseFrequency({ frequency: 'week', days: ['tuesday'], time: '09:00' }, 'week').days, ['tuesday']);
    assert.strictEqual(editor.chooseFrequency({ frequency: 'week', days: ['tuesday'], time: '09:00' }, 'day').days, null);
    assert.strictEqual(editor.chooseFrequency({ frequency: 'day', time: '07:30' }, 'week').time, '07:30',
      'and the time stays as it was');
  });

  test('a single day, weekdays or any set reopens as week with exactly its days; every day as day; a month as month', () => {
    assert.deepStrictEqual(editor.reopenSchedule({ schedule: 'every thursday at 07:00' }),
      { frequency: 'week', days: ['thursday'], time: '07:00' });
    assert.deepStrictEqual(editor.reopenSchedule({ schedule: 'every weekday at 07:00' }),
      { frequency: 'week', days: WEEKDAYS, time: '07:00' });
    assert.deepStrictEqual(editor.reopenSchedule({ schedule: 'every monday, wednesday and sunday at 07:00' }),
      { frequency: 'week', days: ['monday', 'wednesday', 'sunday'], time: '07:00' });
    assert.deepStrictEqual(editor.reopenSchedule({ schedule: 'every day at 07:00' }),
      { frequency: 'day', time: '07:00' });
    assert.deepStrictEqual(editor.reopenSchedule({ schedule: 'on day 15 of every month at 07:00' }),
      { frequency: 'month', day: '15', time: '07:00' });
  });

  // The inverse of each move puts back what was there.
  test('ticking then unticking a day, and week to day and back, put back what was there', () => {
    const start = ['monday', 'friday'];
    assert.deepStrictEqual(editor.toggleDay(editor.toggleDay(start, 'wednesday'), 'wednesday'), start);
    assert.deepStrictEqual(editor.toggleDay(editor.toggleDay(start, 'friday'), 'friday'), start);
    assert.deepStrictEqual(editor.toggleDay(['sunday'], 'monday'), ['monday', 'sunday'], 'always in week order');
    const day = editor.chooseFrequency({ frequency: 'week', days: start, time: '09:00' }, 'day');
    assert.strictEqual(editor.buildSchedule(day), 'every day at 09:00');
    assert.deepStrictEqual(editor.chooseFrequency(day, 'week').days, WEEK, 'back to week, all seven ticked');
  });

  test('a week with no day ticked saves nothing, and says so', () => {
    const none = { frequency: 'week', days: [], time: '09:00', skillName: 'Digest', runOn: 'local' };
    assert.strictEqual(editor.needsADay(none), true);
    assert.strictEqual(editor.buildSchedule(none), null);
    assert.strictEqual(editor.previewSentence(none), null);
    assert.strictEqual(editor.routineDraft({ skill: { slug: 'digest', name: 'Digest' }, agentId: 'piper', ...none }), null);
    assert.strictEqual(editor.WEEK_DAYS.none, 'Choose at least one day.');
    assert.strictEqual(editor.WEEK_DAYS.noneOnContinue, 'Choose at least one day to continue.');
    assert.strictEqual(editor.needsADay({ ...none, days: ['monday'] }), false);
    assert.strictEqual(editor.needsADay({ frequency: 'day', time: '09:00' }), false);
  });
});

describe('the words', () => {
  const preview = (days, runOn = 'local') => editor.previewSentence({
    frequency: 'week', days, time: '09:00', skillName: 'Digest', runOn,
  });

  // THE LAST WORDS ARE THE RUN ON OPTION'S OWN. Every preview ends on the
  // chosen option's `sentence`, so each line is written out in full with that
  // sentence read off the option, for every option the field has: if the
  // option's words change, these lines follow them, and a set preview that
  // wrote its own ending would differ from the option, and from the daily
  // preview beside it, here.
  test('the preview says weekday in full, and a set by its short names with commas and "and"', () => {
    const options = editor.runOnOptions();
    assert.ok(options.length >= 2, 'sanity: the field has its options');
    for (const option of options) {
      const place = option.sentence;
      const run = (days) => preview(days, option.value);
      assert.strictEqual(run(WEEKDAYS), `Run Digest every weekday (Monday to Friday) at 9:00am, on ${place}.`);
      assert.strictEqual(run(['monday', 'friday']), `Run Digest every Mon and Fri at 9:00am, on ${place}.`, 'two days');
      assert.strictEqual(run(['monday', 'wednesday', 'sunday']),
        `Run Digest every Mon, Wed and Sun at 9:00am, on ${place}.`, 'three days');
      assert.strictEqual(run(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']),
        `Run Digest every Mon, Tue, Wed, Thu, Fri and Sat at 9:00am, on ${place}.`, 'six days');
      assert.strictEqual(run(['thursday']), `Run Digest every Thursday at 9:00am, on ${place}.`, 'one day, as today');
      assert.strictEqual(run(WEEK), `Run Digest every day at 9:00am, on ${place}.`);
      const daily = editor.previewSentence({ frequency: 'day', time: '09:00', skillName: 'Digest', runOn: option.value });
      assert.strictEqual(run(['monday', 'friday']).split(' at 9:00am')[1], daily.split(' at 9:00am')[1],
        `a set ends as the daily preview does, on ${option.value}`);
    }
  });

  test('the row says weekday, a set by its short names, and one day as it does today', () => {
    const row = (schedule) => rows.routineSentence({ schedule, name: 'Digest' });
    assert.strictEqual(row('every weekday at 09:00'), 'Every weekday at 9:00am, run: Digest');
    assert.strictEqual(row('every monday, wednesday and sunday at 09:00'), 'Every Mon, Wed and Sun at 9:00am, run: Digest');
    assert.strictEqual(row('every monday at 09:00'), 'Every Monday at 9:00am, run: Digest');
  });

  test('an unreadable schedule is shown the forms that work, a weekday and a list among them', () => {
    assert.strictEqual(rows.scheduleProblem({ schedule: 'every mon and fri at 07:00', scheduleReadable: false }).body,
      'Use Edit schedule, or change the file to say every day at 07:00, every weekday at 07:00, '
      + 'every Monday and Friday at 07:00 or on day 15 of every month at 07:00.');
  });

  test('the catch-up note says "that day" for daily, weekly and set routines, and the month for monthly', () => {
    const rule = 'Rundock only runs the routines of the workspace that is open, '
      + "so this one's do not run while you are elsewhere. ";
    for (const frequency of ['day', 'week']) {
      assert.strictEqual(editor.scheduleStepFields({ frequency }).workspaceCaveat,
        `${rule}A missed slot is caught up if Rundock is open again that day.`, `the note for ${frequency}`);
    }
    assert.strictEqual(editor.scheduleStepFields({ frequency: 'month' }).workspaceCaveat,
      `${rule}A missed slot is caught up the next time Rundock is open that month.`);
  });

  // A set's slot is caught up on its own day or not at all, so a slot still
  // owed is today's, and is a moment away.
  test('a set routine still owed today\'s slot says it runs shortly', () => {
    const owed = {
      nextRun: new Date(2026, 10, 9, 9, 0).toISOString(), now: new Date(2026, 10, 9, 10, 15).toISOString(),
      scheduleKind: 'days', enabled: true, prompt: 'Run the digest skill.', runOn: 'local',
    };
    assert.deepStrictEqual(rows.nextRunLabel(owed),
      { text: 'Next run: shortly. It was due today, 9:00am.', className: 'next-run' });
    assert.deepStrictEqual(rows.nextRunLabel({ ...owed, now: new Date(2026, 10, 7, 10, 0).toISOString() }),
      { text: 'Next run: Monday, 9:00am', className: 'next-run' }, 'a slot still ahead reads as any other');
  });
});

// ===== WHAT 0.15.7 MAKES OF A SET OF DAYS =====
//
// The evidence file says 0.15.7 reads neither new form, quoting its grammar.
// Both halves are held here: the frozen 0.15.7 grammar reads each form as
// nothing and refuses to save it, and the file quotes exactly the patterns and
// the day table that grammar runs, with the results it gives.
describe('what 0.15.7 makes of a set of days', () => {
  const NEW_FORMS = [
    'every weekday at 09:00',
    'every monday, wednesday and sunday at 09:00',
    'every saturday and sunday at 10:00',
  ];

  test('0.15.7 reads no set of days, and its save check refuses each one', () => {
    for (const schedule of NEW_FORMS) {
      assert.strictEqual(before.parse0157(schedule), null, `0.15.7 read "${schedule}"`);
      assert.strictEqual(before.isWritable0157(schedule), false, `0.15.7 would save "${schedule}"`);
      assert.strictEqual(before.parseBefore(schedule), null, `the scheduler before sets of days read "${schedule}"`);
      assert.ok(scheduler.parseSchedule(schedule), `sanity: this release reads "${schedule}"`);
    }
    assert.deepStrictEqual(before.parse0157('every monday at 09:00'), { kind: 'weekly', day: 1, hour: 9, minute: 0 },
      'sanity: the frozen grammar reads a day it should');
    assert.deepStrictEqual(before.parse0157('every day at 09:00'), { kind: 'daily', hour: 9, minute: 0 });
  });

  test('the evidence file quotes the grammar this test runs, and the results it gives', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'evidence', 'routine-days-older-release.md'), 'utf8');
    const table = Object.entries(before.WEEKDAYS).map(([name, n]) => `${name}: ${n}`).join(', ');
    assert.ok(doc.includes(`const WEEKDAYS = { ${table} };`), 'the file quotes the day table the grammar looks names up in');
    assert.ok(doc.includes(`const weeklyMatch = s.match(${before.WEEKLY});`), `the file quotes the weekly pattern ${before.WEEKLY}`);
    assert.ok(doc.includes(`\`${before.DAILY}\``), `the file quotes the daily pattern ${before.DAILY}`);
    for (const schedule of NEW_FORMS.concat('every monday at 09:00', 'every day at 09:00')) {
      const line = `${JSON.stringify(schedule)} -> ${JSON.stringify(before.parse0157(schedule))}`
        + ` | save check: ${before.isWritable0157(schedule)}`;
      assert.ok(doc.includes(line), `the file shows: ${line}`);
    }
  });
});
