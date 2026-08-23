# Evidence: the routine editor

Recorded here because a reviewer sees the change and these criteria and nothing
else. Every measurement below is reproducible from a clone with the command
shown next to it.

The acceptance criteria this was judged against live outside this repository,
so each one is quoted in full rather than cited by number. A reader with only
this checkout can still follow what was asked and check whether it was done.

## The copy rule the whole change is shaped around

Where a routine runs is a choice between two options and only one of them is
real in this release. The local option runs while Rundock is open on this
computer. The always-on option is reserved and refused, and its whole point is
that it keeps running while the computer is off.

So the only option a user can actually pick is precisely the one whose point is
that it does NOT run while the computer is off. Writing the other option's
promise onto it would advertise the single thing this release cannot do, at the
exact moment the choice is being made.

That is why the run-on copy is data rather than text in a template. Each option
carries its own name, its own second line, its own form inside the preview
sentence, and its own selectability. Three separate surfaces read them off the
chosen option, so a fixed string cannot be right for one and wrong about the
other: it is wrong in both places or in neither.

## The schedule and the skill

> **AC-1:** A skill can be chosen with no agent selected first.

`test/unit/routine-editor-model.test.js`, `a skill can be chosen with no agent
selected first` and `with no agent selected each row names the agent that runs
it`. Driven through the DOM as well, in
`test/unit/routine-editor-view.test.js`: `opening with no agent offers every
agent's skills and names each one` and `with no agent, the picker spans the team
and names who runs each skill`, the second of which goes through the real entry
point rather than through the render function.

The agent-agnostic list names which agent runs each skill, because the reader
has not chosen one and that is the fact they are missing.

> **AC-2:** From an agent's page the choice is scoped to that agent.

`from an agent's page the choice is scoped to that agent` and `a scoped row does
not repeat the agent it was scoped to` in the model's tests; `opening from an
agent offers only that agent's skills` and `from an agent, the picker is that
agent's and the page names it` in the view's.

One rule worth naming because it is a judgment rather than a reading: a skill
assigned to NO agent is not offered by either entry. A routine is declared in an
agent file, so a skill with no agent has no file to be written into, and
offering it would build a picker whose selection cannot be saved. Pinned by `a
skill assigned to no agent is not offered`.

> **AC-3:** A schedule is built by the sentence builder rather than typed as an
> expression.

Two tests, and the second is the one that matters.

`an expression typed into either field builds nothing` feeds eight real
attempts through the builder, including a cron expression in each field, a
one-digit hour, a quarter hour and a capitalised weekday. Both halves are looked
up in the offered set; neither is formatted from the input, so nothing that was
not offered assembles into anything.

`the schedule step has no field anything can be typed into` asserts the ABSENCE
of any typeable element in the rendered step, rather than the presence of two
selects. A friendly-looking box is the failure worth catching, and a test that
checks two selects exist would pass with a text input beside them.

`every offered combination matches the schedule format the scheduler reads`
round-trips all 384 combinations the builder can produce through the format the
scheduler documents. Nothing in this change touches the scheduler.

> **AC-4:** A workspace with no skills offers the create-a-skill path rather
> than an empty control.

`a workspace with no skills offers the create-a-skill path` and `an agent with
no skills of its own offers the same path`, which is the likelier way to meet
it. In the DOM, `a workspace with no skills renders the create-a-skill path`
asserts the offer is present AND pressable, and `the create-a-skill path leads
somewhere` presses it and checks where it lands.

## The run-on field

> **AC-5:** The local option renders "This computer".
> **AC-6:** It renders "Runs while Rundock is open here".

`the local option renders "This computer"` and `the local option renders "Runs
while Rundock is open here"` against the model; `the local option renders its
two lines` reads both back out of the rendered element.

> **AC-7:** No string on the local option promises running while the computer is
> off.

**This is asserted as a pair, in one test, twice over.**

An absence on its own is worth nothing: `assert the string is not there` passes
against a module that returns an empty object and against a page that rendered
nothing. Both of those are failure modes a copy test is otherwise least likely
to notice. So the same string is asserted PRESENT on the option it belongs to,
in the same test. The claim is the pair: these words exist here, and they are
not on the option a user can pick.

The string is named as a constant rather than described by shape:

```js
const OFF_COMPUTER_PROMISE = 'while your computer is off';
```

- `no string on the local option promises running while the computer is off`
  (model). Joins the local option's name, second line, sentence form and setup
  label, asserts the phrase is absent, then joins the always-on option's four
  and asserts it is present.
- `the local option on the page promises nothing about the computer being off`
  (view). The same pair, read out of `[data-run-on="local"]` and
  `[data-run-on="agent-computer"]` in a rendered DOM.

Widened past the one phrase by `the local option promises nothing about the
computer being closed`, which refuses six other ways of saying it: `computer is
off`, `laptop is closed`, `even when closed`, `always on`, `24/7`, `while you
are away`.

**And the mutation is the proof that any of it discriminates.** The first entry
in the table below writes the always-on option's exact copy onto the local
option. Four tests turn red. Until that had been run, the absence was a claim
about a test nobody had tried to break.

> **AC-8:** The value is produced as a variable per option rather than as a
> fixed string.

`the run-on words come from the option rather than a fixed string` builds the
preview sentence for both options and asserts two different sentences from one
code path. A fixed string satisfies one half and fails the other.

`the confirmation line reads its second sentence off the same option` does it
again on the second reader, and asserts the two options produce different
captions.

Two mutations back this: replacing `option.sentence` with a literal and
replacing `option.meta` with a literal each turn a test red.

Selectability is the third value read per option, and it is COMPUTED rather than
declared: it is membership of the supported set. So the reserved option becomes
pickable when the product can honour it, and not because someone edited a
boolean. `the always-on option cannot be chosen in this release` asserts local
is the only selectable value; `the always-on option cannot be picked` presses
the reserved row in the DOM and asserts nothing moved.

## The caveat

> **AC-9:** The caveat states that routines run on the machine they were made
> on.

`the caveat states that routines run on the machine they were made on`, plus
`the caveat says a workspace on more than one computer runs on each`, which is
the second half the multi-machine decision requires: four synced machines are
four locals, and the copy has to say so rather than be silent.

The copy:

> Routines run on the machine they were made on. A workspace open on more than
> one computer runs its routines on each of them.

> **AC-10:** It is present where the run-on choice is made, not only in a help
> page.

The caveat is a PROPERTY OF THE FIELD, not a loose export. `runOnField()`
returns the label, the options and the caveat as one object, and `the caveat is
part of the run-on field itself` asserts that. A separate constant can be
rendered on a help page and nowhere else while every test still passes.

In the DOM, `the caveat is rendered inside the run-on field` finds the caveat
INSIDE `[data-routine-editor="run-on-field"]` and, in the same test, asserts the
local option row is inside that same element. The caveat therefore cannot be
rendered without the choice it qualifies being on screen.

The same caveat now also appears in `docs/ROUTINES.md`, in the section that
recommends the setup that hits it. That is additional to AC-10 rather than a
discharge of it: the criterion says the editor, not only a help page, and the
editor is where the two tests above read it from. Why the page needed it is
below.

## Behaviour

> **AC-11:** Save returns to the list.

Where a save goes is one fact with one reader: `SAVE_DESTINATION` in the model,
asserted by `save returns to the list`. The view's `saveRoutine` navigates to
it, asserted through the wiring by `save returns to the list` in
`test/unit/routine-editor-view.test.js`, which drives the real save and reads
the destination the router was handed.

Two facts about it worth a reviewer's attention:

- `saving sends the routine that was built` is a separate test on the same
  action, because a save that navigates correctly and sends nothing passes a
  navigation test, and a save that sends correctly and stays put passes a
  message test. Both are asserted on the same call.
- `a save that cannot be built sends nothing and stays put`. Leaving on a failed
  save returns the reader to a list that does not contain what they think they
  just made, which is worse than staying.

**The routines list does not exist yet; it is another card.** The router
resolves the routines destination to the section that lists routines today when
no routines rail entry is present, in one line in `switchNav` with its reason.
The editor keeps one answer for where a save goes, and gains the real list the
day the rail entry exists, without this file being edited.

> **AC-12:** The repository's banned-word check exits zero over the files this
> card adds.

`npm run check:refs` is the repository's check. It runs over every tracked file,
it is step four of `npm run precommit`, and it passed on the tree this file is
committed with. Its rules include the em and en dash refusal and the phrasing
patterns this repository refuses to ship.

Because a command run here is not something a reviewer holding a diff can see,
the same ground is covered by tests in the diff:

- `no banned word reaches the editor's copy` walks every string the editor can
  ship (the run-on field, the frequency and time lists, the picker in both its
  populated and empty states, the preview sentence, the confirmation line, both
  time zone captions and the step leads) against the word list the workspace
  guide states.
- `no em dash or en dash reaches the editor's copy`, and `no em dash or en dash
  reaches the page`, which renders three states and reads the DOM text back.
- `the copy is UK spelling`.
- `the files this card adds carry no em dash or en dash`, reading the files
  themselves.

One thing worth knowing if you edit those tests: the dash test file cannot
contain a literal dash, or it fails itself and trips `check:refs`. The character
classes are written as escapes for that reason. The first version was not, and
the test caught its own source.

## Proof

> **AC-13:** A test drives the zero-skills state and asserts the create-a-skill
> path is offered.

`a workspace with no skills offers the create-a-skill path` (model) and `a
workspace with no skills renders the create-a-skill path` (DOM). The second
drives the same render function every other state goes through, with an empty
workspace, and asserts both that the offer is there and that there is nothing to
pick.

> **AC-14:** A test asserts the local option's copy, including the absence
> required by AC-7.

`the local option renders its two lines` and `the local option on the page
promises nothing about the computer being off`, both reading the rendered
element rather than the model.

> **AC-15:** Each proof fails when its own guard is removed.

`node test/tools/mutate-routine-editor-guards.js --markdown`, committed so the
run can be repeated, and wired into `npm run mutate:guards`, which is a step in
`npm run precommit` and runs in the guards job on every pull request. It exits
non-zero if any mutation turns nothing red, so it is a check and not a report,
and the table below is machine-verified rather than transcribed.

Run on the tree this file is committed with:

| Guard broken | Tests red | Which |
|---|---|---|
| the local option carries its own words, not the always-on option's | 4 | `the local option renders "Runs while Rundock is open here"`<br>`no string on the local option promises running while the computer is off`<br>`the local option promises nothing about the computer being closed`<br>`the confirmation line reads its second sentence off the same option` |
| selectability is membership of the supported set | 1 | `the always-on option cannot be chosen in this release` |
| the supported set is the one the data model supports | 3 | `the always-on option cannot be chosen in this release`<br>`what the editor offers matches what the data model supports`<br>`a draft naming the reserved target is refused` |
| the preview sentence reads the run-on words off the option | 1 | `the run-on words come from the option rather than a fixed string` |
| the confirmation line reads its second sentence off the option | 1 | `the confirmation line reads its second sentence off the same option` |
| both halves of the schedule are looked up, never taken from the input | 2 | `an expression typed into either field builds nothing`<br>`a draft with an unbuildable schedule is refused` |
| the picker is scoped to the agent it was opened from | 2 | `from an agent's page the choice is scoped to that agent`<br>`an agent with no skills of its own offers the same path` |
| a scoped row does not repeat the agent | 1 | `a scoped row does not repeat the agent it was scoped to` |
| an unscoped row names the agent that runs it | 1 | `with no agent selected each row names the agent that runs it` |
| a skill with no agent is not offered | 2 | `a skill can be chosen with no agent selected first`<br>`a skill assigned to no agent is not offered` |
| the zero-skills state offers a way to make one | 2 | `a workspace with no skills offers the create-a-skill path`<br>`an agent with no skills of its own offers the same path` |
| the reserved target is refused where a routine is made | 1 | `a draft naming the reserved target is refused` |
| the caveat names the machine a routine was made on | 1 | `the caveat states that routines run on the machine they were made on` |
| the caveat names what a workspace on several computers does | 1 | `the caveat says a workspace on more than one computer runs on each` |
| the caveat travels with the field the choice is made in | 1 | `the caveat is part of the run-on field itself` |
| save leaves the editor for the list | 1 | `save returns to the list` |
| midnight and noon read as twelve rather than zero | 1 | `times read as plain clock words` |
| the lead line names the agent the choice was scoped to | 1 | `the lead line names the agent when the choice was scoped to one` |
| the run-on row reads its second line off the option | 2 | `the local option renders its two lines`<br>`the local option on the page promises nothing about the computer being off` |
| the run-on row reads its name off the option | 1 | `the local option on the page promises nothing about the computer being off` |
| the caveat is rendered inside the field | 1 | `the caveat is rendered inside the run-on field` |
| the reserved option cannot be selected by pressing its row | 1 | `the always-on option cannot be picked` |
| the zero-skills state offers something to press | 2 | `a workspace with no skills renders the create-a-skill path`<br>`the create-a-skill path leads somewhere` |
| the zero-skills state does not ask the reader to pick from nothing | 3 | `a workspace with no skills renders the create-a-skill path`<br>`the zero-skills state does not ask the reader to pick from nothing`<br>`the create-a-skill path leads somewhere` |
| a save that cannot be built does not leave the editor | 1 | `a schedule value that was never offered saves nothing and stays put` |
| a save sends the routine before it leaves | 1 | `saving sends the routine that was built` |
| a skill name reaches the page as text, not as markup | 1 | `a skill name carrying markup renders as text` |
| the time zone reaches the page | 2 | `the browser's zone reaches the schedule step as words`<br>`the time zone reads as a place and never as an offset` |

**Both halves are mutated: the model and the view.** That is not thoroughness
for its own sake. The model can carry exactly the right words while the view
renders different ones, and every model test still passes. The rule this editor
exists to hold is a claim about what a person SEES, so the render is broken and
noticed too. Ten of the twenty-eight break the render.

**Four tests exist because a mutation asked for them, not because they were
thought of first.** Two turned nothing red on the model's first run and two on
the view's:

- Offering a skill assigned to no agent turned nothing red, because the fixture
  had no such skill. The fixture gained one and the rule gained a test.
- Dropping the agent's name from the picker's lead line turned nothing red,
  because nothing exercised it.
- **Printing the local option's NAME on both rows turned nothing red.** Every
  assertion still held: the promise was present on one row and absent from the
  other, and the page named one option twice while the tests reported the copy
  was right. `the local option on the page promises nothing about the computer
  being off` now asserts both names, so the two rows have to be two options.
- **Making a failed save navigate anyway turned nothing red.** The only
  unbuildable save on record had no skill picked, so it returned at an earlier
  guard and never reached this one: two guards with one test between them. `a
  schedule value that was never offered saves nothing and stays put` picks a
  skill and sets a time the builder never offered, which is the case that
  reaches the second.

## Red-first and the gate

`node scripts/red-first.js --base origin/main --tests "npm test"` reports
`proven`: 2122 tests passing with the change, 19 failing without it.

**The base is `origin/main`, not `main`.** In a worktree the local branch ref
does not move, so `--base main` can compare against a stale tree and report
proven using another change's tests. That is a known trap here and this run
avoided it deliberately.

Read the result with its own limit, which travels with it: reverting proves the
tests NOTICE this change. It cannot prove they assert the right thing. The
mutation table above is what shows each individual guard is noticed, which is
why that instrument exists rather than red-first alone.

`npm run precommit` passes all six steps on every commit in this branch:
`test:coverage`, `typecheck`, `lint:styles`, `check:refs`, `mutate:guards`,
`check:fixture`. The record it writes, `.precommit-gate.json`, is not tracked:
it names the tree hash the checks passed on, and writing its contents into a
tracked file would change the tree it names.

## Coverage, measured inside the gate

`npm run test:coverage`:

```
public/routine-editor-model.js   |  99.72 |    79.73 |  100.00 | uncovered: line 30
lib/agents/routines.js           | 100.00                     | uncovered: none
lib/protocol/handlers/team.js    |  99.20                     | uncovered: lines 56, 57
```

Line 30 of the model is the browser half of the module wrapper, which cannot
execute under node. It is the only uncovered line in the file.

Branch coverage at 80% is the honest number and lower than the line figure. The
uncovered branches are absent-argument fallbacks (`input && input.x` where the
caller always passes an object), not guards. Every guard in the mutation table
is covered, which is a stronger statement about this file than its branch
percentage is.

The two uncovered lines in the handlers file are in `handleAddToTeam` and
predate this change.

`node test/tools/coverage-areas.js coverage.lcov`: all 51 floors hold.

## Nothing here reads the machine it runs on

Six tests of this shape were found in this project in one session: a test whose
result depends on the clock, the locale or the time zone of whatever ran it. One
of them asserted nothing at all between midnight and three in the morning while
still reporting as passed.

So, deliberately:

- Time labels are arithmetic. `toLocaleTimeString` reads the runner's locale and
  ICU build, which would make the offered time list, and every assertion about
  it, a statement about the machine.
- A time zone is always SUPPLIED. The model never asks for one. The tests
  construct `Europe/London`, `America/New_York`, `Australia/Sydney`,
  `Pacific/Auckland` and `UTC` explicitly.
- The one place the machine is read is the editor's entry point, which is what
  "your local time" means. Its test replaces the browser's time zone API with a
  fixed value, so what is checked is that the value TRAVELS, not what the value
  is. `a zone the browser will not give up drops the line rather than guessing`
  covers the other side.
- No test calls `new Date()`.

## Why docs/ROUTINES.md changed

Two reasons, and the first is the load-bearing one.

The page RECOMMENDS keeping Rundock on an always-on cloud machine with the
workspace synced to a laptop, and said nothing about what a second live instance
does to a routine. A routine records what it does and when, and nothing about
where it was made. The last-run guard is a file inside the workspace, so it is
per machine and nothing coordinates two copies: both schedulers tick and each
fires the routine on its own guard. The reader most likely to follow that advice
is exactly the reader who meets this.

Shipping an editor that states the caveat while the page recommending the
hazardous setup stays silent would be inconsistent, so the caveat is in both
places, with the honest framing in each.

Pinned rather than left as prose, in `test/unit/doc-claims.test.js`:

- `the last-run guard is a file inside the workspace, so it is per machine`.
- `a workspace shared through git does not carry the guard` scaffolds a real
  workspace and reads the ignore file the scaffold wrote.
- `the page states the caveat where it recommends the setup that hits it`, which
  pins the PLACEMENT. The same words in the reference section would be absent
  from the part a reader acts on.

Second reason: the page documented routines as a hand-edited frontmatter array,
which is now half the story.

## What the mock did not settle, raised rather than absorbed

Four things. The first two are the ones a reviewer should look at hardest,
because both are places where the built editor deliberately shows LESS than the
frame does.

**1. The frame's frequency field reads "weekday". The scheduler has no such
value.** It reads `every day at HH:MM` or `every <weekday name> at HH:MM` and
nothing else. A routine saved as "every weekday" parses, saves, appears in the
list and never fires once. Offering it would be the same defect the run-on copy
rule exists to prevent: a control that says something the product does not do.
The field offers `day` plus the seven weekday names, and every combination it
can produce is round-tripped through the scheduler's format in a test. **The
scheduler was not touched.**

**2. The frame's skill rows carry a "Tested" badge and a "takes about 4 minutes"
estimate. Neither has any data behind it.** There is no tested attribute on a
skill anywhere in this product, and no duration is recorded. A usage sidecar
exists, but "has been used once" is not "tested", and inventing that equivalence
to fill a badge would put a claim of verification on screen that nobody made.
Both are omitted. The frame's copy line "Only tested skills can be scheduled" is
omitted with them, for the same reason.

**3. The frame's discovery row carries a link into a setup flow that does not
exist.** The reserved option renders, as the frame requires, with its own copy
and its own reason. It carries no button, because the flow it would open is not
in this release and a control that goes nowhere is the same defect class as copy
that promises what cannot be done.

**4. The frame's back link reads "Back to Piper" from an agent's page and "Back
to Routines" from the other entry.** The second target does not exist yet, so
the editor shows the agent breadcrumb when it has one and none when it does not,
rather than a link to a page that is not there.

## Raised rather than absorbed

- **The mutation harness is a second copy.** It is the same shape as the one
  beside it and could be one shared module. Pulling them together means editing
  an instrument that is already inside the gate, and mixing that refactor into a
  feature is how a gate quietly stops checking what it used to. Said out loud at
  the top of the file.
- **The agent-agnostic entry has a temporary home.** It sits in the routines
  section of the team sidebar, which only renders once a routine exists. Its
  proper home is the routines view's empty state, which is another card. Both
  entries are reachable today.
- **`npm ci` cannot complete behind a restricted network** because a dev
  dependency downloads a binary in its install script. `npm ci --ignore-scripts`
  installs everything the unit suite needs. Not touched here.
