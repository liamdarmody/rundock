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
| the zero-skills state offers something to press | 4 | `a workspace with no skills renders the create-a-skill path`<br>`the create-a-skill path leads somewhere`<br>`a loaded and empty workspace still gets the offer`<br>`an agent with no skills of its own still offers the way in` |
| the zero-skills state does not ask the reader to pick from nothing | 5 | `a workspace with no skills renders the create-a-skill path`<br>`the zero-skills state does not ask the reader to pick from nothing`<br>`the create-a-skill path leads somewhere`<br>`a loaded and empty workspace still gets the offer`<br>`an agent with no skills of its own still offers the way in` |
| a save that cannot be built does not leave the editor | 1 | `a schedule value that was never offered saves nothing and stays put` |
| a save asks for the routine it built | 1 | `saving sends the routine that was built` |
| a skill name reaches the page as text, not as markup | 1 | `a skill name carrying markup renders as text` |
| the time zone reaches the page | 2 | `the browser's zone reaches the schedule step as words`<br>`the time zone reads as a place and never as an offset` |
| sending is not saving | 2 | `save returns to the list, and only once the routine is written`<br>`a refused save stays put and says why` |
| a refusal is shown where the reader is looking | 1 | `a refused save stays put and says why` |
| a refused save does not leave the editor | 1 | `a refused save stays put and says why` |
| a save in flight is not sent twice | 1 | `a save in flight cannot be sent twice` |
| the destination is checked for a sidebar panel, not just a rail entry | 1 | `a destination the shell only half has is not used` |
| an unreachable destination falls back to one the shell has | 3 | `save returns to the list, and only once the routine is written`<br>`the destination is the routines surface once the shell can reach it`<br>`a destination the shell only half has is not used` |
| a skill list that has not arrived is not an empty one | 1 | `an editor opened before the skills arrive waits instead of offering` |
| the editor asks for the skill list it is missing | 1 | `an editor opened before the skills arrive waits instead of offering` |
| the skill list fills in when it arrives | 1 | `an editor opened before the skills arrive waits instead of offering` |
| the breadcrumb returns to the agent it names | 2 | `the breadcrumb goes to the agent it names`<br>`leaving by the breadcrumb and leaving after a save go to different places` |
| the breadcrumb names an agent only when there is one to return to | 1 | `an editor opened without an agent offers no breadcrumb to one` |
| the client tells the editor its skill list arrived | 1 | `the arriving skill list is handed to an open editor` |
| the client releases the editor when the routine is written | 1 | `a written routine is confirmed and the editor is released` |
| the client hands a refusal back to the editor | 1 | `a refusal is shown to the user and handed back to the editor` |
| the client shows the refusal the server sent | 2 | `a refusal is shown to the user and handed back to the editor`<br>`a refusal with no message still says something` |
| the roster is invalidated before it is rebroadcast | 1 | `a routine lands in the agent file it names` |
| a refusal from the data model is reported rather than swallowed | 3 | `a routine the data model refuses is an error, not a half written file`<br>`a file the routine cannot be placed in errors and is left byte identical`<br>`a file declaring routines in an unreadable form errors and is left alone` |
| an agent profile offers a way to schedule its skills | 3 | `an agent profile offers a way to schedule one of its skills`<br>`pressing it opens the editor scoped to that agent`<br>`an agent with no skills of its own still offers the way in` |
| the way in carries the agent whose profile it is on | 2 | `pressing it opens the editor scoped to that agent`<br>`an agent with no skills of its own still offers the way in` |
| the sidebar offers a way in that belongs to no agent | 6 | `no way into the editor exists that this file does not name`<br>`the sidebar door opens the editor across the whole team`<br>`the same journey from the sidebar door reaches another agent's skill`<br>`the confirmation step can be edited by pressing its own link`<br>`the offer in an empty workspace is pressed, not called`<br>`no rendered control names a handler that does not exist` |
| a routines key in a form this module cannot address is refused | 2 | `is refused rather than joined by a second one`<br>`a file declaring routines in an unreadable form errors and is left alone` |
| whether the file already declares routines is asked of the independent counter | 2 | `is refused rather than joined by a second one`<br>`a file declaring routines in an unreadable form errors and is left alone` |

**Seven things are mutated: the model, the view, the client's message dispatch, the protocol handler, the data model's write path, and the two views that render the ways in.** That is not thoroughness
for its own sake. The model can carry exactly the right words while the view
renders different ones, and every model test still passes. The rule this editor
exists to hold is a claim about what a person SEES, so the render is broken and
noticed too. Nineteen break the render, four break the dispatch, two break the handler and three break a way in.

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

## What an independent review found, and what changed

Four blocking findings. All four were real and all four are fixed here. Two of
them compounded into the worst outcome this flow had.

**A save that changed nothing reported success.** `appendRoutineBlock` handed
back the content it was given when the frontmatter pattern did not match, and
the handler wrote those unchanged bytes, logged the add and announced the save.
The pattern fails on a file with Windows line endings, which the migration path
in that same module already says exist, and on a file with no frontmatter.

It now refuses, and says which of the two it means. It also READS THE ROUTINE
BACK before returning: every named refusal covers a cause somebody thought of,
and the read-back covers the ones nobody has met yet. The handler keeps a
backstop of its own, refusing when the bytes are identical, because announcing
a save that did not happen is worse than any error.

**And no refusal could have reached the user anyway.** The client dispatch had
no case for either reply, so both fell out of the switch in silence, unlike
every other error the client handles. Both are handled now, and the editor no
longer leaves on send: it waits to be told, so a refusal has somewhere to land,
and it says so next to the button that caused it. `a refused save stays put and
says why` and the three tests in `routine editor: the reply reaches the user`
cover it. Those last three cut the two case bodies out of the client source and
RUN them against stubs, which is the difference between checking the words are
there and checking what they do.

**AC-11's proof would have passed with the feature deleted.** It asserted that a
stubbed router had been handed a string. The line that actually resolved that
destination lived inside the router, could only be reached by loading the whole
shell, and could be deleted with the suite green.

The resolution is now a function in the view, `routinesListNav`, and the router
line is gone. The test drives it against a real DOM and checks the destination
for the property that makes it one: the shell must have BOTH a rail entry
carrying the name and the sidebar panel revealed by it. Half of a destination is
worse than none, because the router hides every sidebar and matches no branch,
which leaves the editor on screen with the save looking like it did nothing.
Three tests, three mutations, and `a destination the shell only half has is not
used` exists because a mutation asked for it.

**The picker's fixture had never been compared to what produces the list.** Every
picker test asserted against a hand-written fixture shaped the way the picker
reads it, which proves the picker agrees with its author and not that it agrees
with discovery.

This is the same shape as the absence this card is built around, and the
reviewer was right to name it that way: an assertion that matches only your own
reader passes whether or not it matches the producer.
`test/unit/routine-editor-contract.test.js` scaffolds a real workspace, runs the
same discovery the server runs to answer a client asking for skills, and feeds
the result into the picker unmodified. The shape turned out to be right. It is
now proven rather than assumed, and it fails with the key named if discovery
moves.

**One advisory was worth taking with them:** an unloaded skill list is not an
empty one, and the two were indistinguishable, so the offer to build a first
skill was shown to anyone who opened the editor before the reply arrived. The
editor now asks for the list, waits, and fills in when it lands.

**One test was passing for the wrong reason and the fix found it.** Asserting
only that a refusal was sent left the two unwritable files green even when
discovery never saw them, because a missing agent produces a refusal and an
untouched file too. Asserting the MESSAGE turned it red, and it was red: a
stale roster cache meant the append path was never reached. The fixture now
clears that cache, and lets the lazy migration settle before it snapshots, so a
byte comparison changes only if the code under test changed it.

## Round two

Three more findings, all real.

**A control that did not do what its label said.** The breadcrumb read "Back to
Piper" and went to the team chart, because it shared its exit with the one taken
after a save, where the list IS the right destination. They are different exits
and now have different destinations: the breadcrumb returns to the agent it
names, a save goes to the list.

The test asserts the label and the destination AGAINST EACH OTHER rather than
each against a constant, so renaming either alone fails it. That is the shape
this defect had: both halves were individually defensible and only the pairing
was wrong.

**The skill list's arrival was dispatch wiring with no test.** The view tests
called the function directly and the view mutations broke the view, so deleting
the call from the client left everything green while an editor opened before the
reply landed sat on its loading line forever. It gets the same treatment the
router got: the case body is cut out of the client source and RUN.

The client dispatch is now a mutation target in its own right. Four mutations
delete one call each, and each turns a test red.

**A broadcast test that asserted a message shape rather than what produced it.**
The handler's contract is that the roster it sends after a save carries the
routine just written. The fixture stubbed the cache invalidation as a no-op, so
the roster went out warm and without the routine, and the test passed because a
message of type `agents` had been sent.

The stub is the real invalidation now and the test reads the routine out of what
was broadcast. **That alone was not enough, and the mutation tool is what said
so.** The roster cache expires on a two second timer, so "the broadcast carried
the routine" discriminates only while the cache happens to still be warm, which
makes it a statement about how fast the machine ran. The test also records what
the handler did, in order, and asserts the invalidation happened once and before
the roster was read back. No clock in it.

**And the mutation for it proved nothing twice before it proved anything.** The
call text appears in six places in that file and a string replace takes the
first, so the mutation was silently breaking a different handler. It carries its
neighbouring line now, which makes it unique to this one. An instrument can
assert the adjacent thing just as easily as a test can.

**Two criteria are not discharged here and cannot be.** Whether the editor
matches the frames in both themes, and whether the zero-skills state reads as an
offer, are judgements about a built interface. They are for the owner looking at
it, and no diff can carry them.

## Round three

One finding, and it is the third instance of a class already fixed twice here.

**The only door into the scoped editor had no test.** The way in is a control
rendered on an agent's profile, and every test of the scoped entry called the
entry function directly. That proves the function works and says nothing about
whether anything calls it. The control could be deleted, or the agent id written
into it broken, with the suite, the mutation table and the contract test all
staying green while the scoped entry point no longer existed.

Same treatment as the router line and the skill dispatch case: the profile is
rendered for real and the control is pressed for real, then the editor is read
back to check it opened scoped to that agent. The profile is a mutation target
now, and deleting the control turns three tests red.

The agent the control was RENDERED for and the agent the editor OPENED for are
asserted against each other, not each against a constant, which is the same
pairing the breadcrumb needed: a wrong id in the handler leaves both halves
looking right on their own.

## The instrument had the defect it exists to find

A mutation whose search text appears more than once was silently breaking
whichever came first. One did: the text appeared six times in its file, the
mutation broke a different handler, and the row read as a proven guard while the
guard it named was never touched.

That is now structural rather than a habit. A guard matching more than one place
is REFUSED, with the count, and the run fails:

```
AMBIGUOUS: the guard text matches 3 places, so it would break whichever came first
```

The table's authority rests on each mutation breaking the thing it says it
breaks, and until now nothing was checking that. The fix for an ambiguous guard
is to make its search text unique, usually by including a neighbouring line.

## Every way into this editor, enumerated

Four separate reviews each found a different way in with no test behind it: a
destination resolved inside the router, a message case in the client dispatch, a
control on an agent's profile, a control in the team sidebar. Every fix was
correct and every one covered exactly the door that had been named, so the next
one arrived.

The rule is the one the last round produced: **an entry point is tested by the
surface a user touches, or it is not tested.** Applied to all of them rather
than to the one most recently found.

`test/unit/routine-editor-doors.test.js` carries the list, and checks it against
the source.

| Way in | Surface | Scope | Pressed by |
|---|---|---|---|
| `addRoutineForAgent` in `views/profile.js` | the Add routine control on an agent profile | that agent | `the profile door opens the editor scoped to that agent` |
| `addRoutine` in `views/team.js` | the Add control in the sidebar Routines section | the whole team | `the sidebar door opens the editor across the whole team` |

**Deliberately not pressed, with the reason:**

- **The routines view empty state.** Not built; it belongs to the routines list,
  which is separate work. When it lands it adds a row and a test, and this file
  fails until it does.
- **A keyboard or command-palette route.** There is none. The palette indexes
  files, conversations, agents and skills, not routines. Checked by a test
  rather than asserted here.

### The check that ends this

`no way into the editor exists that this file does not name` scans every client
file for a call to any function that OPENS the editor and requires the set to
equal the table above. A new way in fails by name until somebody lists it and
names the test that presses its surface. `every door names a test, and every
named test exists` closes the other half, so a row cannot name a test that was
never written.

**Verified by adding a fifth door rather than by trusting the check.** A call
placed in an unrelated view failed it with exactly that message; deleting the
sidebar control turned six tests red.

### Pressed, never called

Two walks drive the whole journey through the DOM only: press the door, press a
skill row, press Continue, choose from the two lists and fire their change
events, press the run-on row, press Continue, press Save. Not one handler is
called directly, because calling the handler is exactly what let four doors look
covered while being untested. One walk goes through the scoped door, the other
through the unscoped one to a second agent's skill, so the two entries are
proven to carry different agents through to the message that gets sent.

The remaining controls are pressed too: the Edit link on the confirmation step,
the offer in an empty workspace, and the breadcrumb.

`no rendered control names a handler that does not exist` collects every
`onclick` and `onchange` across the editor's states and requires each to resolve
to a published function, which covers the controls a walk does not reach. `both
doors name handlers the editor actually publishes` does the same for the two
views that hold the doors and for the three calls the client dispatch makes back
into the editor.

**One property worth knowing:** the sidebar section renders nothing until a
routine exists, so the unscoped door appears with the first routine and not
before. That is pinned, and it is why the routines view's own empty state is
still needed and is a named exclusion rather than an oversight.

## Two routines keys, and a read-back that could not see it

**The defect.** The block locator recognises a `routines:` key only with nothing
after it. `routines: []` and `routines: # none yet` are ordinary things to write
and both read as no section at all, so a second `routines:` key was pushed onto
the end of the frontmatter. The file then carried two mappings of the same name,
which nothing can read, written into somebody's agent file by an editor that
then reported the save.

**And the guard added to catch causes nobody thought of was blind to this one by
construction.** It parsed the result with this module's own locator, which found
the section it had just appended and was satisfied. A read-back that parses with
the writer's own parser confirms the writer is SELF-CONSISTENT. It cannot
confirm the file is valid, because it asks the same question that produced the
error.

That is pinned as a test rather than left as a lesson.
`the writer's own parser reads the broken file as fine` runs the exact broken
document through `parseRoutineBlocks` and asserts it comes back clean, with the
routine and its schedule present. The very next test puts the same document
through the independent check and asserts it is refused.

**The fix has two parts, and they ask different questions.**

`topLevelKeyCounts` counts names appearing at the start of a line inside the
frontmatter. It knows nothing about routines, items, indents or sections, and it
shares no code with any locator. Whether the file already declares routines is
now asked of THAT, not of the locator: "does this file declare routines" and
"can I find the section" are two different questions, and answering the first
with the machinery that answers the second is the whole of this defect.

A file whose key exists in a form the locator cannot address is refused, by
name, rather than rewritten. Turning `routines: []` into a block sequence is a
transformation with its own decisions, and guessing at one inside a save is how
the first version went wrong.

**The property, asserted in its own terms rather than through the refusal.**
`never leaves a file with two routines keys` runs all three unrecognised forms
through the write path, allows it to refuse or to succeed, and asserts the
outcome carries exactly one key either way. That test does not care how the
guarantee is kept, so it survives a change of approach.

**One backstop, named as one.** `assertFrontmatterKeysIntact` also runs after
the write, comparing top-level key counts before and after and allowing only
`routines` to appear where there was none. With the refusal in place no input
reaches it, so its call site carries no mutation, for the same reason lines 445
and 446 carry no test: it is a net under a named refusal rather than a
substitute for one. The function itself IS tested, directly, including that it
does not blame a pre-existing duplicate on this write.

## Red-first and the gate

`node scripts/red-first.js --base origin/main --tests "npm test"` reports
`proven`: 2175 tests passing with the change, 33 failing without it.

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
public/routine-editor-model.js   |  99.7 (357/358)  | uncovered: line 30
lib/agents/routines.js           |  99.7 (570/572)  | uncovered: lines 445, 446
lib/protocol/handlers/team.js    |  99.2 (248/250)  | uncovered: lines 56, 57
```

Line 30 of the model is the browser half of the module wrapper, which cannot
execute under node. It is the only uncovered line in the file.

**Lines 445 and 446 are a backstop with no test, and that is stated rather than
papered over.** They are the throw inside the read-back check: the append path
parses its own result and requires the routine to be in it. Every cause anyone
has met is refused earlier and by name, so no input reaches this throw, which is
the point of it: it covers the shapes nobody has met yet. The reachable half of
the same guarantee IS tested, through the handler, by `a file the routine cannot
be placed in errors and is left byte identical` and by the identical-bytes
refusal beside it. A guard no test notices is normally not a guard; this one is
a net under the named refusals rather than a substitute for them, and the honest
report is that it has never fired.

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
