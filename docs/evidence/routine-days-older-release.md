# Sets of days: what an older release does with them

This change adds two schedule forms, `every weekday at HH:MM` and a list of full day names such as `every monday, wednesday and sunday at HH:MM`. A workspace is a folder of files, and the same folder can be opened by an older Rundock on another computer, or by this one after a downgrade. This file records what 0.15.7, the last release before this change, does with a routine saved in either new form.

## The grammar 0.15.7 reads

From `lib/scheduler.js` at the `v0.15.7` tag (commit `4ba68d8`). The day names are looked up in a table of the seven full names:

```js
const WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
```

and a weekly schedule is read by one pattern with one word between `every` and `at`, which must be a key of that table:

```js
  const weeklyMatch = s.match(/every (\w+) at (\d{2}):(\d{2})/);
  if (weeklyMatch) {
    const day = WEEKDAYS[weeklyMatch[1]];
    if (day === undefined) return null;
    return { kind: 'weekly', day, hour: parseInt(weeklyMatch[2]), minute: parseInt(weeklyMatch[3]) };
  }
  return null;
```

The daily pattern before it, `/every day at (\d{2}):(\d{2})/`, does not match either new form.

## What it makes of the new forms

That pattern and table, with the daily pattern and the save check from `lib/agents/routines.js` at the same tag, run over three new forms and two old ones:

```
"every weekday at 09:00" -> null | save check: false
"every monday, wednesday and sunday at 09:00" -> null | save check: false
"every saturday and sunday at 10:00" -> null | save check: false
"every monday at 09:00" -> {"kind":"weekly","day":1,"hour":9,"minute":0} | save check: true
"every day at 09:00" -> {"kind":"daily","hour":9,"minute":0} | save check: true
```

- **`every weekday at 09:00`:** the weekly pattern matches with `weekday` as the day, `WEEKDAYS.weekday` is undefined, and the schedule reads as `null`.
- **`every monday, wednesday and sunday at 09:00`:** `\w+` cannot cross the comma, so the pattern finds no match at all, and the schedule reads as `null`.
- **`every saturday and sunday at 10:00`:** `\w+` cannot cross the spaces around "and", so the pattern finds no match, and the schedule reads as `null`.

So 0.15.7 reads each of them as unreadable. The routine never fires there: its tick records slots only for a schedule that parses, and `getNextRun` returns null for one that does not, so no run starts and no slot is recorded for it. The row says so, in 0.15.7's own words: "Rundock cannot read this schedule, so this routine will not run. Change it to say every day at 07:00, or a weekday, like every Monday at 07:00." Its editor reopens the routine on its defaults and names the stored schedule as one it cannot build, and its save check refuses to write any of them, so 0.15.7 cannot save one, though it leaves one it finds in a file untouched.

Opened again in a release with this change, the same file reads as before: the schedule was never rewritten, and every form 0.15.7 read still reads the same way here, which `test/unit/routine-days.test.js` checks form by form against a frozen copy of the grammar this change replaced.

The frozen copies live in `test/helpers/schedule-grammar-before-days.js`. `test/unit/routine-days.test.js` runs the 0.15.7 one over the three forms above and requires each to read as `null` and to be refused by the save check, and it reads this file and requires the day table, the weekly pattern, the daily pattern and every result line above to be the ones that copy runs and gives.
