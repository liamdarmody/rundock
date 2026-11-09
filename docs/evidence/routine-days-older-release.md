# Sets of days: what an older release does with them

This change adds two schedule forms, `every weekday at HH:MM` and a list of full day names such as `every monday, wednesday and sunday at HH:MM`. A workspace is a folder of files, and the same folder can be opened by an older Rundock on another computer, or by this one after a downgrade. This file records what 0.15.7, the last release before this change, does with a routine saved in either new form. Its last section records the mutation rows that hold the change, and what each turned red.

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

## The mutation rows for sets of days

Each row below takes one guard out of the source, or rewrites it, and runs its harness's suite. Every one was run alone, with `node test/tools/<harness>.js --rows N:N+1`, where N is the row's index in that harness's own list, counting from 0, after main was last merged in. Each turned the tests named here red, and the count is how many went red. "New" rows were added for sets of days; "rewritten" rows already existed and quote code this change rewrote.

The routines harness is `test/tools/mutate-routines-guards.js`; the routine editor harness is `test/tools/mutate-routine-editor-guards.js`.

| Harness, row | Kind | What the row does | Red when run alone |
| --- | --- | --- | --- |
| routines, 330 | new | a day named twice is no set | 1: a misspelled day, a repeated day or an empty list reads as nothing, to every reader |
| routines, 331 | new | a list is joined by commas and a final "and" | 1: a misspelled day, a repeated day or an empty list reads as nothing, to every reader |
| routines, 332 | new | the scheduler reads every weekday as a set | 4: `every weekday at HH:MM` is read as Monday to Friday; the save check, the row sentence and the reopen read exactly the sets the scheduler reads; all 127 sets save in their one form, and reopen and fire as the same set; 0.15.7 reads no set of days, and its save check refuses each one |
| routines, 333 | new | Monday to Friday saves as every weekday | 5: all seven save as every day, Monday to Friday as every weekday, one day by its name; all 127 sets save in their one form, and reopen and fire as the same set; a hand-typed equivalent reads as the same set and is written in the one form on the next save; the preview says weekday in full, and a set by its short names with commas and "and"; the row says weekday, a set by its short names, and one day as it does today |
| routines, 334 | new | a set saves Monday first, whatever order it was ticked in | 1: all seven save as every day, Monday to Friday as every weekday, one day by its name |
| routines, 335 | new | a day the set leaves out has no slot of its own | 1: a set of days names and records no slot on a day it leaves out |
| routines, 336 | new | the walk steps only to the chosen days | 1: a set of days names and records no slot on a day it leaves out |
| routines, 337 | new | a set reads only a clock time | 1: a set at an hour past 23 or a minute past 59 reads as nothing, and the earlier forms still roll |
| routines, 161 | rewritten | both halves of the schedule are looked up, never formatted from the string | 10: the sentence names the day of the month; the row's sentence and its next run name the same hour; a row with a last-run fact carries two lines; a schedule the editor never offered assembles into no sentence; a monthly routine reads as every month on its day; delete states what stops; the pieces carry the schedule and the skill name, and nothing else; the pieces concatenate to exactly the sentence; a schedule with no plain words yields no pieces; a row that cannot assemble a sentence carries no pieces either |
| routine editor, 116 | new | Continue with no day ticked stops on the step and says why | 1: Continue with no day ticked saves nothing, says why in red, and moves focus to Monday |
| routine editor, 117 | new | week from a month starts with no day ticked | 1: choosing week from day ticks all seven, from month ticks none, and from week keeps its days |
| routine editor, 118 | new | week from every day starts with all seven ticked | 2: choosing week from day ticks all seven, from month ticks none, and from week keeps its days; ticking then unticking a day, and week to day and back, put back what was there |
| routine editor, 119 | new | the days module loads before the editor model | 1: index.html loads schedule-days.js before routine-editor-model.js |
| routine editor, 6 | rewritten | a stored schedule is looked up too, never taken from the string | 3: every schedule the builder can produce survives the round trip; a schedule this editor could not have built reads back as nothing; a schedule the editor cannot build is named back, verbatim |
| routine editor, 7 | rewritten | a stored schedule is read whole, not found inside a longer line | 1: a schedule this editor could not have built reads back as nothing |
| routine editor, 79 | rewritten | the grammar is the one the scheduler actually reads | 4: every schedule the editor can build is one the writer accepts; a schedule that would never fire is refused; a monthly schedule on a day every month has is accepted, and one on 29 to 31 is not; a schedule on a day every month has is written |
| routine editor, 80 | rewritten | a schedule is read whole, not found inside a longer line | 2: a schedule that would never fire is refused; a monthly schedule on a day every month has is accepted, and one on 29 to 31 is not |
| routine editor, 100 | rewritten | leaving month drops its day | 1: choosing month starts on the 1st and keeps the time; any other frequency drops the day |
| routine editor, 107 | rewritten | a new monthly routine saves the day it shows | 1: a day and a time read back in the preview and the note, and save as the monthly text |
| routine editor, 108 | rewritten | an edited monthly routine saves the day it shows | 2: a monthly routine reopens on its own day and time, and saves the day it shows; a hand-typed day 31 opens on month and the last day, says so, and sends nothing until saved |
| routine editor, 111 | rewritten | choosing a frequency follows the model's rule for the day | 5: choosing month and then day again restores the daily sentence, with the time kept; each box is a native checkbox in the Tab order, named by its full day, and a press ticks it; the line under the sentence is a polite live region, and follows the boxes; week from day ticks all seven, and from month ticks none; a tick then an untick, and week to day and back, put back what was there |
