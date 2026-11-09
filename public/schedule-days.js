'use strict';
/**
 * The days a schedule names, read and written in one place.
 *
 * A routine can run on a set of days: `every weekday at 09:00` is Monday to
 * Friday, and `every monday, wednesday and sunday at 09:00` is those three. A
 * schedule is read by the scheduler, which decides what runs, by the writer's
 * save check, and by the editor's reopen, which the row's sentence reads
 * through. Each of them keeps its own pattern for a whole schedule, and every
 * one of them reads the days inside it HERE, so a set one of them reads is a
 * set all of them read, and a list one refuses they all refuse.
 *
 * A BROWSER MODULE AND A SERVER ONE AT ONCE, for that reason. lib/ requires
 * it, and index.html loads it before the editor's model.
 *
 * A LIST IS WRITTEN ONE WAY: full day names, in any order and any case, joined
 * by commas and a final "and" (`saturday and sunday`, `monday, wednesday and
 * sunday`). A name misspelled or given twice, a list joined any other way, or
 * no day at all is no set, and the schedule is one nothing reads, which is
 * what any unknown schedule already is. Every reader folds the case before it
 * asks.
 */
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockScheduleDays = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // Monday first: the order the editor draws the days in and a list is saved
  // in. `day` is the date's own getDay(), which the slot arithmetic compares.
  const WEEK = [
    { value: 'monday', short: 'Mon', name: 'Monday', day: 1 },
    { value: 'tuesday', short: 'Tue', name: 'Tuesday', day: 2 },
    { value: 'wednesday', short: 'Wed', name: 'Wednesday', day: 3 },
    { value: 'thursday', short: 'Thu', name: 'Thursday', day: 4 },
    { value: 'friday', short: 'Fri', name: 'Friday', day: 5 },
    { value: 'saturday', short: 'Sat', name: 'Saturday', day: 6 },
    { value: 'sunday', short: 'Sun', name: 'Sunday', day: 0 },
  ];
  const VALUES = WEEK.map(d => d.value);
  // What `weekday` means: Monday to Friday.
  const WEEKDAY = VALUES.slice(0, 5);

  const NAME = `(?:${VALUES.join('|')})`;
  // The words between "every" and "at" that name days: weekday, one day, or a
  // list. A pattern's SOURCE, for each reader to set into its own pattern for a
  // whole schedule; it has alternatives, so it goes inside a group.
  const DAYS = `weekday|${NAME}(?:(?:, ${NAME})* and ${NAME})?`;
  const WHOLE = new RegExp(`^(?:${DAYS})$`);

  /**
   * The days `words` names, Monday first, or null. `words` is the part of a
   * lowercased schedule between "every" and "at".
   */
  function readDays(words) {
    if (typeof words !== 'string' || !WHOLE.test(words)) return null;
    if (words === 'weekday') return WEEKDAY.slice();
    const named = words.split(/, | and /);
    if (new Set(named).size !== named.length) return null;
    return VALUES.filter(v => named.indexOf(v) !== -1);
  }

  /** "a, b and c", "a and b", or the one item. */
  function joined(items) {
    return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  }

  /**
   * The words a set of days is saved as, between "every" and "at": ONE FORM
   * PER SET, so two files that mean the same days say them the same way. All
   * seven are `day`, exactly Monday to Friday is `weekday`, one day is its
   * name, and any other set is its days in week order. Null for no day, or for
   * a value that is not a day.
   */
  function daysWords(values) {
    if (!Array.isArray(values) || values.some(v => VALUES.indexOf(v) === -1)) return null;
    const chosen = VALUES.filter(v => values.indexOf(v) !== -1);
    if (chosen.length === 0) return null;
    if (chosen.length === 7) return 'day';
    if (chosen.join() === WEEKDAY.join()) return 'weekday';
    return joined(chosen);
  }

  return { WEEK, WEEKDAY, DAYS, readDays, daysWords, joined };
}));
