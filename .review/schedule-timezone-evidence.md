# Evidence: a schedule stores its timezone as location words

Recorded here because a reviewer sees the change and these criteria and nothing
else. Every measurement below is reproducible from a clone with the command
shown next to it.

The acceptance criteria this was judged against live outside this repository,
so each one is quoted in full rather than cited by number. A reader with only
this checkout can still follow what was asked and check whether it was done.

## What this card is

The storage half only. A schedule carries when it runs and never carried where
"when" is measured from. Rendering belongs to the views, the per-platform
caveat copy belongs to the editor and has shipped there, and nothing here
changes how a schedule is parsed or when it fires.

## The trap, and how the proof is built around it

`Intl.DateTimeFormat().resolvedOptions().timeZone` returns location words and
looks exactly like the value this field wants. It answers a different question:
what this computer is set to, rather than what the person chose when they built
the schedule. On the machine a routine was made on those are the same string,
which is why a test that inherits the runner's zone cannot tell them apart, and
why a value defaulted from the machine passes such a test everywhere.

`test/unit/routine-timezone.test.js` sets `process.env.TZ = 'UTC'` before its
first require, in its own file so no other suite is affected, on the same
grounds as `test/unit/scheduler-slots-dst.test.js`. The host's zone is then a
constant the file controls rather than a reading it inherits, and every zone
the tests store is a different one, chosen in the test:

    const HOST_ZONE = 'UTC';
    const SET_ZONE = 'Pacific/Kiritimati';   // +14
    const OTHER_ZONE = 'Pacific/Niue';       // -11

`the host zone is pinned, so a zone differing from it is a real difference`
asserts the pinning itself, because if it failed every assertion below would be
comparing against whatever the runner happened to be set to, which is the
defect rather than the check.

Nothing else in the suite reads a clock, a zone or a home directory. The
migration tests write throwaway files under the system temp directory and call
the migration directly, so no workspace, cache or agent roster is involved.

## The hole

> **AC-1:** A schedule stores its timezone as location words.

`normalizeRoutine` reads a `timezone` key through `readTimezone`, and
`appendRoutineBlock` writes one, refusing anything that is not an area and a
place. `a timezone is read off the file as the location words it carries` and
`a value that is not location words is refused rather than stored`, which walks
`+01:00`, `-05:00`, `GMT+1`, `UTC+2`, `BST`, `PST`, `UTC`, the empty string,
`Europe`, `Europe//London` and `../../etc/passwd` through the write path and
requires each to be refused, then stores `Europe/London`,
`America/Argentina/Buenos_Aires`, `Australia/Lord_Howe`,
`America/Port-au-Prince` and `Etc/GMT+10` and reads each back.

**The shape is checked rather than the zone database.** `Intl` knows which
zones exist, and asking it would make what a file may contain depend on the ICU
data of whichever machine did the writing: the same zone accepted on one
computer and refused on another, and refused everywhere on a Node built without
full ICU. That is the machine reaching a stored value by a second road. Which
zones exist is not this module's question; whether this is location words
rather than an offset is.

**The cost, named rather than hidden:** `UTC` is refused. It is a real zone
identifier and it names no place, and it is what a machine in a container
reports, so accepting it would mean accepting the one value that cannot be
distinguished from a default. A caller that means it can say `Etc/UTC`.

> **AC-2:** The value round-trips byte-for-byte, on the same terms as every
> other field the data model already carries.

`a timezone survives a write-then-read cycle on a file carrying fields this
card never touches`. The fixture carries a frontmatter key nobody declared, a
key inside the routine block the writer has never heard of, a second routine, a
top-level key after the section and a body. The test asserts the write landed,
then compares every line above the edited block, every line from the next
routine onward, the unknown key inside the edited block and the whole body,
byte for byte. A second write of the same value returns identical content.

**Its last assertion is the one that says the field is typed rather than
carried.** The block parser copies every `key: value` it finds with no
whitelist, so an unrecognised `timezone` already arrived on the routine as the
raw text of its line. Most of the round-trip assertions therefore hold against
the reader this card started from as well. A quoted value discriminates: the
raw text carries the quotes and the typed read does not, on the same terms as
every other field this module types.

> **AC-3:** No machine timezone reaches a stored value.

Two assertions, both on values constructed in the test.

`the stored timezone is the one that was set, never the one this machine is in`
creates a routine with `SET_ZONE`, reads it back, asserts it is `SET_ZONE`,
asserts it is not `HOST_ZONE`, and asserts the string `UTC` appears nowhere in
the written file. A second routine set in `OTHER_ZONE` keeps its own, so the
value travels with the schedule rather than with the process.

`a routine created without a timezone is left without one rather than filled in
from the machine` is the other half and the more important one: it creates a
routine naming no zone and requires the file to carry no `timezone` key at all,
on a machine that has a perfectly good zone available to default from.

`the migration invents no timezone, least of all the machine's` says the same
of the migration path.

**The mutation is what makes these more than assertions.** The harness rewrites
the absent branch to `Intl.DateTimeFormat().resolvedOptions().timeZone`, which
is the defect in its exact form, and a test goes red. See the table below.

> **AC-4:** A routine whose timezone is absent is distinguishable from one
> whose timezone is empty.

`a routine with no timezone is distinguishable from one whose timezone is
blank`. Absent reads as `null`, `timezone:` with nothing after it reads as the
empty string, both from a raw block and from a real file, and a blank one
round-trips as a blank rather than as an absence or as the four letters n-u-l-l.

This is why `readTimezone` exists instead of a call to `readString`, which
folds both to `null`. Every routine written before this field existed is in the
absent state, and whatever later decides what to do about a routine with no
zone has to tell a gap to fill from an answer already given.

> **AC-5:** Migration of existing routines is idempotent, on the same terms as
> the existing migration.
>
> **AC-6:** A routine already carrying the field is left byte-identical by a
> migration pass.
>
> **AC-7:** The backup behaviour the existing migration has is unchanged.

**The migration is not changed by this card, and that is the decision rather
than an omission.** `MIGRATED_KEYS` does not gain `timezone`. Every key already
in that list has a true value the migration can work out from the file: the run
target defaults, the two switches have the meaning files already had, and the
plan hash is computed from the routine itself. A routine written before this
field existed was set in a zone nobody recorded, and no value in the file says
which. The only value this process could supply is the machine it happens to be
running on, which is not the person's choice and is wrong for every routine
another computer wrote. Absent is the honest record. The reason is in the
source, beside the list.

Proven rather than argued, in `migrating a routine that predates the field`:

- `running the migration twice over a routine that carries a timezone changes
  nothing and says nothing` (AC-5, and the two-pass comparison AC-13 asks for).
- `a routine already carrying the field is left byte-identical by a migration
  pass` (AC-6), on a file made by migrating one and then adding the timezone to
  the result, so the only thing the pass could react to is this field.
- `the pre-migration backup still holds the file as it was before anything
  touched it` (AC-7), including the second migrating write that must not
  overwrite it.

> **AC-8:** Whether the timezone participates in the plan hash is decided in
> the source with its reason.

**It does not participate.** The reason is in `lib/agents/routines.js`, in the
comment block above `PLAN_FIELDS`, where the exclusions of the schedule, of
enabled and paused, and of the owner already live. It states the argument for
inclusion first, because it is a real one: changing a zone changes when a
routine runs by up to a day, which is a bigger move than the ten minutes the
schedule exclusion is written around.

It is excluded for the reason the schedule is. The line this hash draws is what
a routine DOES against WHEN it happens, not big changes against small ones. A
zone is the second half of a schedule: `08:00` is not a time until something
says where, and moving a routine from one zone to another is the same edit as
moving it by an hour, said differently. An approval that survived a schedule
edit and broke on a zone edit would draw the line somewhere nobody could
explain, and the person re-approving would be confirming a plan that had not
changed.

The cost is named there too: a routine moved across the world runs at a
genuinely different moment and nobody is asked again. That is the cost the
schedule exclusion already accepts. What approval covers is what a run will do
and which files it touches, and neither moves when the zone does.

**Plan approval is a later card and inherits this**, which is why it is decided
here rather than settled by leaving the field out of a list.

> **AC-9:** If it does participate, an existing routine's plan hash is not
> invalidated by the migration alone.

It does not participate, so the condition is not met. Pinned anyway, both ways
round: `a timezone does not reach the plan hash, so changing one does not
invalidate an approval` (two different zones, one hash, and the hash still
notices a changed skill so the equalities are not two hashes of nothing), and
`the hash a migration stamps is the same whether or not the routine names a
zone`, which is the criterion read the only way it can be given the decision
above.

> **AC-10:** Nothing in this card renders a time.

No file under `public/` is touched, and no file outside `lib/agents/` other
than tests and the mutation harness. `git show --stat` on the two commits is
the whole of it. The editor's own reading of the browser zone, which it uses
for a caption, is untouched and reaches no stored value.

> **AC-11:** Nothing in this card reaches the value double-fire suppression
> reads.

`lib/scheduler.js` is not touched. `routineState.lastRun` is the only input to
double-fire suppression, and nothing added here is threaded into it.

Pinned as well as argued, in `nothing this card stores reaches double-fire
suppression`: with the scheduler's clock wired to a fixed instant and the
process zone pinned, a routine that declares `Pacific/Kiritimati` is judged due
at exactly the same moment as one that declares nothing, is suppressed by the
same recorded run, and `getNextRun` still takes two arguments, a schedule and
the last run. A later change that threads a stored zone into the next-run
calculation puts a second input beside `lastRun` and turns this red.

> **AC-12:** A test proves the round trip on a file that also carries fields
> this card does not touch.

The AC-2 fixture, described above. Nothing in the file except the routine's own
`timezone` line is written by any of these tests.

> **AC-13:** A test proves the migration idempotent by running it twice and
> comparing bytes.

`running the migration twice over a routine that carries a timezone changes
nothing and says nothing`. Both the returned content and the file on disk are
compared with `strictEqual` against the first pass's bytes, and `console.log`
is captured for the run: identical bytes alone would not be enough, because a
second pass that rewrites the same content and announces it has still done
something. The existing migration returns the content it was given and touches
no disk when nothing is pending, and that is what is asserted.

> **AC-14:** Each proof fails when its own guard is removed.

`node test/tools/mutate-routine-editor-guards.js --markdown`, wired into
`npm run mutate:guards`, which is a step in `npm run precommit` and runs on
every pull request. It exits non-zero if any mutation turns nothing red, so
this is a check rather than a report and the table below is machine-verified
rather than transcribed.

The eight rows this card adds, run on the tree this file is committed with:

| Guard broken | Tests red | Which |
|---|---|---|
| an absent timezone is left absent rather than filled in from the machine | 1 | `a routine created without a timezone is left without one rather than filled in from the machine` |
| absent and blank are read as different answers | 1 | `a routine with no timezone is distinguishable from one whose timezone is blank` |
| the timezone is a field the model reads, not a string carried through | 5 | `a timezone is read off the file as the location words it carries`<br>`a timezone survives a write-then-read cycle on a file carrying fields this card never touches`<br>`a routine with no timezone is distinguishable from one whose timezone is blank`<br>`a routine created without a timezone is left without one rather than filled in from the machine`<br>`the migration invents no timezone, least of all the machine's` |
| a written timezone is checked before it becomes bytes in a file | 1 | `a value that is not location words is refused rather than stored` |
| a timezone is location words rather than any text at all | 1 | `a value that is not location words is refused rather than stored` |
| a created routine carries its timezone into the file | 2 | `the stored timezone is the one that was set, never the one this machine is in`<br>`a value that is not location words is refused rather than stored` |
| the timezone stays out of the plan hash | 2 | `a timezone does not reach the plan hash, so changing one does not invalidate an approval`<br>`the hash a migration stamps is the same whether or not the routine names a zone` |
| the migration does not invent a timezone for a routine that never recorded one | 1 | `the migration invents no timezone, least of all the machine's` |

**The first row is the one these exist for.** It rewrites the absent branch of
the write path to read the machine's zone: it type-checks, it returns location
words, and on the computer a routine was made on it returns the right answer.
No test that inherited the runner's zone could see it. The suite pins the
process zone and stores a different one, so it has nowhere to hide.

**The last two are the decision made breakable.** Adding `timezone` to
`PLAN_FIELDS` or to `MIGRATED_KEYS` reverses a decision this card was required
to make, silently, which is exactly how it would happen. Both turn a test red.

## Red first

`node scripts/red-first.js --base origin/main --tests "npm test"`. The result
is folded into `.precommit-gate.json` and travels with the tree it was measured
on.

Its limitation travels with it: reverting proves the tests notice this change,
not that they assert the right thing. The mutation table above is the other
half, and the pinned process zone is what stops the AC-3 assertions measuring a
proxy.

## What the suite could not have caught on its own

Before the round-trip test's last assertion was added, every assertion in it
passed against the reader as it was, because the block parser already carried
an unrecognised `timezone` through as raw text. That is recorded here rather
than quietly fixed: a round-trip test for a new field on this module starts out
unable to fail, and the quoted value is what gives it teeth.
