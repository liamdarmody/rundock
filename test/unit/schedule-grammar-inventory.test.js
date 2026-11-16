'use strict';
// Every copy of the schedule grammar, asked the same questions.
//
// A schedule is read by the scheduler (parseSchedule), the writer's save check
// (isWritableSchedule), the editor's reopen (readSchedule), the row's sentence
// (scheduleWords, which reads through the editor's reopen) and the package
// install disclosure. Nothing else ties them together, so this table pins every
// reader's verdict on every row: a form added to one and not to another fails
// here, on the row and the reader that disagree.
//
// THE SCHEDULER DECIDES WHAT RUNS. The save check may be stricter, never
// looser: everything it accepts, the scheduler reads. The editor's reopen and
// the row's sentence read only what the editor can build, so they answer
// nothing for a schedule the editor cannot show: a minute off the half hour, or
// a day the scheduler does not read. The disclosure paraphrases the daily and
// single-day weekly forms and quotes anything else as written, a set of days
// among them.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const scheduler = require('../../lib/scheduler.js');
const { isWritableSchedule } = require('../../lib/agents/routines.js');
const editor = require('../../public/routine-editor-model.js');
const routinesModel = require('../../public/routines-model.js');
const packagesModel = require('../../public/packages-install-model.js');

const ROOT = path.join(__dirname, '..', '..');

// How the disclosure says a schedule: in its own words, or quoted as written.
function disclosure(schedule) {
  const said = packagesModel.routineSentence('Piper', { name: 'digest', enabled: true, schedule });
  return said.includes(`on the schedule "${schedule}"`) ? 'quoted' : 'paraphrased';
}

// What the scheduler read, as the fields the slot arithmetic depends on, or
// null for a schedule it cannot read.
function read(schedule) {
  const parsed = scheduler.parseSchedule(schedule);
  if (!parsed) return null;
  const { kind, day, days, hour, minute } = parsed;
  if (days !== undefined) return { kind, days, hour, minute };
  return day === undefined ? { kind, hour, minute } : { kind, day, hour, minute };
}

const monthly = (day, hour = 9, minute = 0) => ({ kind: 'monthly', day, hour, minute });
const days = (list, hour = 9, minute = 0) => ({ kind: 'days', days: list, hour, minute });
// What the editor reopens a set of days as.
const week = (list, time = '09:00') => ({ frequency: 'week', days: list, time });
// What the editor reopens a monthly schedule as, and the row's sentence for it.
const reopen = (day, time = '09:00') => ({ frequency: 'month', day, time });
const ordinal = (n) => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');

// [schedule, scheduler, save check, editor reopen, row sentence, disclosure]
const ROWS = [];
for (let n = 1; n <= 28; n++) {
  ROWS.push([`on day ${n} of every month at 09:00`, monthly(n), true,
    reopen(String(n)), `Every month on the ${ordinal(n)} at 9:00am`, 'quoted']);
}
ROWS.push(
  ['on the last day of every month at 09:00', monthly('last'), true,
    reopen('last'), 'Every month on the last day at 9:00am', 'quoted'],

  // Not in every month, so never read: Rundock will not move one to another date.
  ['on day 0 of every month at 09:00', null, false, null, null, 'quoted'],
  ['on day 29 of every month at 09:00', null, false, null, null, 'quoted'],
  ['on day 30 of every month at 09:00', null, false, null, null, 'quoted'],
  ['on day 31 of every month at 09:00', null, false, null, null, 'quoted'],
  ['every month at 09:00', null, false, null, null, 'quoted'],

  // Case is folded, as it is for the daily and weekly forms.
  ['On Day 15 Of Every Month At 09:00', monthly(15), true,
    reopen('15'), 'Every month on the 15th at 9:00am', 'quoted'],
  ['ON THE LAST DAY OF EVERY MONTH AT 09:00', monthly('last'), true,
    reopen('last'), 'Every month on the last day at 9:00am', 'quoted'],
  // Spacing is not folded, by any copy.
  ['on day 15 of every  month at 09:00', null, false, null, null, 'quoted'],
  ['on the last day of  every month at 09:00', null, false, null, null, 'quoted'],
  // One leading zero on the day is read as the day without it, and no more.
  ['on day 05 of every month at 09:00', monthly(5), true,
    reopen('5'), 'Every month on the 5th at 9:00am', 'quoted'],
  ['on day 005 of every month at 09:00', null, false, null, null, 'quoted'],
  // Any minute is read, as it is for the other forms; the editor offers the half hour.
  ['on day 15 of every month at 09:07', monthly(15, 9, 7), true, null, null, 'quoted'],
  ['on the last day of every month at 23:59', monthly('last', 23, 59), true, null, null, 'quoted'],

  // Today's daily and weekly rows. One day reopens as a week with that day
  // ticked, and reads and fires as it did.
  ['every day at 07:00', { kind: 'daily', hour: 7, minute: 0 }, true,
    { frequency: 'day', time: '07:00' }, 'Every day at 7:00am', 'paraphrased'],
  ['every monday at 07:00', { kind: 'weekly', day: 1, hour: 7, minute: 0 }, true,
    week(['monday'], '07:00'), 'Every Monday at 7:00am', 'paraphrased'],
  ['Every Monday at 07:00', { kind: 'weekly', day: 1, hour: 7, minute: 0 }, true,
    week(['monday'], '07:00'), 'Every Monday at 7:00am', 'paraphrased'],
  ['every day at 07:03', { kind: 'daily', hour: 7, minute: 3 }, true, null, null, 'paraphrased'],

  // A set of days: weekday is Monday to Friday, and a list is full day names
  // joined by commas and a final "and", in any order and any case.
  ['every weekday at 18:00', days([1, 2, 3, 4, 5], 18), true,
    week(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], '18:00'), 'Every weekday at 6:00pm', 'quoted'],
  ['every monday, wednesday and sunday at 09:00', days([1, 3, 0]), true,
    week(['monday', 'wednesday', 'sunday']), 'Every Mon, Wed and Sun at 9:00am', 'quoted'],
  ['Every Sunday, Monday And Wednesday at 09:00', days([1, 3, 0]), true,
    week(['monday', 'wednesday', 'sunday']), 'Every Mon, Wed and Sun at 9:00am', 'quoted'],
  ['every saturday and sunday at 09:00', days([6, 0]), true,
    week(['saturday', 'sunday']), 'Every Sat and Sun at 9:00am', 'quoted'],
  ['every weekday at 07:03', days([1, 2, 3, 4, 5], 7, 3), true, null, null, 'quoted'],
  // All seven named are every day, and reopen as it.
  ['every monday, tuesday, wednesday, thursday, friday, saturday and sunday at 09:00',
    { kind: 'daily', hour: 9, minute: 0 }, true, { frequency: 'day', time: '09:00' }, 'Every day at 9:00am', 'quoted'],
  // A day misspelled, shortened or named twice, a list joined another way, or
  // no day at all, is no set.
  ['every wensday and friday at 09:00', null, false, null, null, 'quoted'],
  ['every mon and fri at 09:00', null, false, null, null, 'quoted'],
  ['every monday and monday at 09:00', null, false, null, null, 'quoted'],
  ['every monday, friday at 09:00', null, false, null, null, 'quoted'],
  ['every monday, wednesday, and friday at 09:00', null, false, null, null, 'quoted'],
  ['every weekdays at 09:00', null, false, null, null, 'quoted'],
  ['every  at 09:00', null, false, null, null, 'quoted'],
  ['every and at 09:00', null, false, null, null, 'quoted'],
);

test('every copy of the grammar gives the verdict this table pins, row by row', () => {
  for (const [schedule, scheduled, writable, reopened, sentence, disclosed] of ROWS) {
    assert.deepStrictEqual(read(schedule), scheduled, `parseSchedule on "${schedule}"`);
    assert.strictEqual(isWritableSchedule(schedule), writable, `isWritableSchedule on "${schedule}"`);
    assert.deepStrictEqual(editor.readSchedule(schedule), reopened, `readSchedule on "${schedule}"`);
    assert.strictEqual(routinesModel.scheduleWords(schedule), sentence, `scheduleWords on "${schedule}"`);
    assert.strictEqual(disclosure(schedule), disclosed, `the install disclosure on "${schedule}"`);
  }
});

// THE SUBSET RULE stated where the save check is defined: a schedule the
// writer accepts and the scheduler cannot read saves, is listed, and never
// fires.
test('the save check is never looser than the scheduler', () => {
  for (const [schedule] of ROWS) {
    if (isWritableSchedule(schedule)) {
      assert.notStrictEqual(scheduler.parseSchedule(schedule), null,
        `"${schedule}" is accepted by the writer and unreadable to the scheduler`);
    }
  }
});

// A HAND-TYPED DAY 29 TO 31 IS NAMED BY THE SERVER, beside the verdict that it
// cannot be read, so the row can say what to write instead and the editor can
// open on the last day. It is the scheduler's answer, sent on the roster: the
// client keeps no reading of those days of its own.
test('the server names the day and time of an unreadable day 29 to 31, and of nothing else', () => {
  const said = (schedule) => scheduler.routineDisplayFacts('inventory:probe', schedule).unreadableMonthDay || null;
  const named = {
    'on day 29 of every month at 09:00': { day: 29, time: '09:00' },
    'on day 30 of every month at 09:00': { day: 30, time: '09:00' },
    'on day 31 of every month at 09:00': { day: 31, time: '09:00' },
  };
  for (const [schedule] of ROWS) {
    assert.deepStrictEqual(said(schedule), named[schedule] || null, `on "${schedule}"`);
  }
  assert.deepStrictEqual(said('ON DAY 30 OF EVERY MONTH AT 23:30'), { day: 30, time: '23:30' });
  assert.deepStrictEqual(said('on day 29 of every month at 07:03'), { day: 29, time: '07:03' });
  assert.strictEqual(said('on day 31 of every month at 24:00'), null, 'a time no form reads is no time to suggest');
  assert.strictEqual(said('on day 32 of every month at 09:00'), null);
});

// Two spellings of one day are one schedule, so editing a file from one to the
// other is not a schedule edit and moves no anchor.
test('a leading zero on the day reads as the same schedule as the day without it', () => {
  assert.deepStrictEqual(scheduler.parseSchedule('on day 05 of every month at 09:00'),
    scheduler.parseSchedule('on day 5 of every month at 09:00'));
});

// ===== NO FIFTH COPY =====
// A copy of the grammar is a regular expression that reads "every ... at" up to
// the group that captures the time. Four files hold one today; a fifth would be
// a fifth place for the forms to drift, and it fails here until it is either
// removed or added to the table above. The row's sentence reads through the
// editor's copy rather than holding its own.
const COPIES = [
  'lib/agents/routines.js',
  'lib/scheduler.js',
  'public/packages-install-model.js',
  'public/routine-editor-model.js',
];

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

function holdsAGrammar(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8').split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .some(line => /every.* at \(/.test(line));
}

test('the grammar is copied into these four files and no others', () => {
  const found = [...sourceFiles('lib'), ...sourceFiles('public')].filter(holdsAGrammar).sort();
  assert.deepStrictEqual(found, COPIES,
    'a copy of the schedule grammar appeared, or one went; add it to the table above or remove it');
});
