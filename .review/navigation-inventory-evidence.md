# Evidence: every navigation destination, and a rail that agrees with the pane

Recorded here because a reviewer sees the change and nothing else. Every
measurement below is reproducible from a clone with the command shown beside
it, and nothing here asks for a number on trust.

The requirements this was judged against live outside this repository, so each
is quoted in full rather than cited.

## The defect, verified before the change

Verified by reading the source rather than by taking the report on trust. The
enumeration below is produced by the check that ships with this change, run
against the tree before it:

```
git stash && node --test test/unit/navigation-doors.test.js
```

At `ea14682` the source carried twenty call sites of `showView` and five of
`setNavState`. The count in hand was fourteen and five, so six destinations were
outside the list this work started from. Of the three routes reported as
wrong:

- **Real.** `openRoutineEditor` called `setNavState('team')` and lit Team on a
  routines surface.
- **Real.** `selectSkill` called `showView('skills')` and set no nav state at
  all, so any route into Skills that was not the rail left the previous entry
  lit. `skills.js` disagreed with itself twelve lines apart: the agent chip
  called `switchNav('team')` and the selector called nothing.
- **Not real at this commit.** The search palette opening a file already called
  `switchNav('files')` on the first line of `paletteOpenFile`, and the comment
  above `closePalette` already recorded why nothing is restored on close. This
  is why the enumeration had to come from the source: the report named three
  defects and the source had two of them.

And one nobody had named:

- **`openSkillFile` in `views/files.js`** set no nav state at all. Opening a
  skill's own file from the skill page left Skills lit over the editor pane,
  and left the sidebar offering skills whose detail the reader could no longer
  see. Found by the enumeration, not by a report.

A second defect of the same shape, one level up, was found by review on another
branch while this was being written and is fixed here:

- **Two hard-coded lists of the sidebar panels.** `setNavState` carried one and
  the different-workspace branch of `onWorkspaceReady` carried a second, in
  four lines that were a hand-written copy of `setNavState`. Extending one and
  not the other leaves two panels un-hidden and stacked in the same column. The
  copy also never learned what the original grew later: `setNavState` toggles
  the New conversation footer and the copy did not, so a reader who switched
  workspace from any section but Conversations arrived at Conversations with no
  way to start one.

## Every call site, with the rail section it should show

> Every call site of `showView` is listed, with the rail section it should
> show.
>
> The list is derived from the call sites in the source, not from any list
> handed to the author.

The manifest is `DESTINATIONS` in `test/unit/navigation-doors.test.js`. The
derivation is `showViewCallSites()` in the same file: it walks every `.js` file
under `public/` except `vendor/`, finds every call to `showView` that is not the
declaration, and attributes each to the construct that carries it, which is the
nearest enclosing `case` label, `switchNav` arm, or function declaration above
it. The key carries the argument, because one function landing on two views is
two destinations.

`no call that lands the reader somewhere exists that this file does not name`
compares the derived list against the manifest with `deepStrictEqual`. A call
site added later fails by name until somebody lists it with the section it
lands on, and a listed row whose call no longer exists fails the same way.

**What it disagrees with.** The two lists differing in either direction is a
failure, not a warning. The message names which side is short.

Twenty call sites, six more than the fourteen reported:

| Call site | Rail section | Surface |
|---|---|---|
| `app.js: case 'needs_workspace': -> showView('workspace')` | none, reason below | the server saying there is no workspace open |
| `app.js: function showWorkspacePicker(recent, discovered) -> showView('workspace')` | none, reason below | the workspace picker being drawn |
| `app.js: if(nav==='settings') -> showView('settings')` | settings | the Settings entry on the nav rail |
| `app.js: else if(nav==='files') -> showView('editor')` | files | the Files entry, with a file open and with none |
| `app.js: else if(nav==='skills') -> showView('skills')` | skills | the Skills entry on the nav rail |
| `app.js: else if(nav==='conversations') -> showView('chat')` | conversations | the Conversations entry with a conversation already open |
| `app.js: else if(nav==='team') -> showView('home')` | team | the Team entry on the nav rail |
| `app.js: else if(nav==='routines') -> showView('routines')` | routines | the Routines entry on the nav rail |
| `views/conversations.js: function createConversation(agentId, title) -> showView('chat')` | conversations | a conversation being started, from a profile, the org chart or an empty state |
| `views/conversations.js: function newConversation() -> showView('convo-empty')` | conversations | New conversation, with team agents and no orchestrator to pick |
| `views/conversations.js: function openConversation(id, withAnchor) -> showView('chat')` | conversations | a conversation being opened, from the sidebar, the palette or a profile |
| `views/files.js: function buildTree(items,container) -> showView('editor')` | files | a row in the file tree being clicked |
| `views/files.js: function openWikilink(name) -> showView('editor')` | files | a wikilink inside a note being followed |
| `views/files.js: function openWorkspaceFilePath(path) -> showView('editor')` | files | a link inside a rendered artifact being followed |
| `views/files.js: function openSkillFile(filePath) -> showView('editor')` | files | a skill's own file, opened from the skill page |
| `views/files.js: function editorGoBack() -> showView(editorReturnView)` | whichever the returned-to view names | Back in the editor |
| `views/palette.js: function paletteOpenFile(filePath) -> showView('editor')` | files | a file result in the search palette |
| `views/profile.js: function showProfile(agentId) -> showView('profile')` | team | an agent's page, from the org chart, the sidebar, the palette or a skill's agent chip |
| `views/routine-editor.js: function openRoutineEditor(input) -> showView('routine-editor')` | routines | the routine editor, from an agent page or from the routines list |
| `views/skills.js: function selectSkill(id) -> showView('skills')` | skills | a skill being selected, from the sidebar or from the palette |

**The section column is not this file's opinion.** Every row is checked against
`NAV_FOR_VIEW` in `public/app.js`, which is the table `showView` actually reads,
by `the section every destination names is the one the source resolves`. A
manifest holding its own copy of the answer is a second opinion that drifts from
the first.

**The one row whose view is a variable** is `editorGoBack`, which shows
`editorReturnView`. Its section cannot be read off a literal, so the variable is
held to its values instead: `the one destination whose view is a variable can
only hold views the table knows` derives every literal assigned to
`editorReturnView` anywhere in the client, requires the set to be exactly
`editor` and `skills`, and requires the table to have a section for both. A
third value added later fails there.

## Each site either sets nav state or carries a stated reason not to

> Each site either sets nav state or carries a stated reason not to.

Eighteen of the twenty sites set nav state, and none of them does it by asking:
`showView` resolves the section from the view and sets it. That is the point of
the change rather than a convenience. The section used to be a second thing each
destination did for itself, which is why several did not do it, and a rule you
have to remember is not a rule.

**Two sites set no nav state, both showing the workspace picker, and the reason
is the same for both.** The workspace picker is the screen shown when there is
no workspace to be a section of. `showWorkspacePicker` sets the
display of the nav rail and the sidebar to `none`, so lighting an entry behind
them would name a place the reader can neither reach nor see. It is
recorded in the table as `workspace: null`, which is a decision written down
rather than a row somebody forgot. `the workspace picker takes no nav state,
because it has no rail to take one on` presses it: the rail is set to a section,
the picker is then shown, and the rail must be exactly where it was.

`every destination either names its section or says why it has none` fails a row
that has neither, and fails a reason under sixty characters, because an
exclusion without an account of itself is how the earlier door file on this
codebase went round four times.

**Two functions call `setNavState`, and the manifest names both.**
`PANEL_DECIDERS` lists them, `nothing but showView asks for a section` derives
every call site of `setNavState` in the client and requires the two lists to be
equal, and each row carries a reason over a hundred characters.

- `showView`, which is the rule.
- `onWorkspaceReady`, which is the one moment the chrome is decided and the pane
  deliberately is not. Which view comes next is the answer to a request still in
  flight, and the pane stays blank until it lands, because blank reads as
  loading where an empty state reads as "you have nothing here". There is no
  view to resolve a section from, so this asks for one directly.

## The rule is written where the next person will read it

> The rule is written where the next person adding a destination will read it.

Three places, in the order somebody meets them:

1. **`public/app.js`**, immediately above `NAV_FOR_VIEW` and beside `showView`.
   This is the file anyone adding a view or a destination is already in. It
   states the rule in one line, says what `null` means, says what to do when
   adding a view, and names the check that will fail if they do not.
2. **`docs/CLIENT-ARCHITECTURE.md`**, in a section of its own, which
   `ARCHITECTURE.md` already points at as the place where the rules that keep
   `public/` the way it is are documented. A row in that document's "Where to
   look" table points at `NAV_FOR_VIEW`.
3. **`test/unit/navigation-doors.test.js`**, whose header carries the reasoning
   in full and whose failure messages carry the rule again at the moment
   somebody breaks it, which is the only moment they are certain to read it.

## Whether it can silently drift again

> Whether it can silently drift again is answered, even if the answer is that
> it can.

**Yes, in one way, and the honest answer is in the source rather than in this
file only.** `NOT_CAUGHT` in `test/unit/navigation-doors.test.js` lists four
holes, each with what a person would have to notice instead, and
`every hole is named with what a person would have to notice instead` fails a
hole listed without one.

The one that matters:

**Whether the section a view is mapped to is the right section is a judgement no
check can make.** The table says the routine editor lights Routines. Somebody
who decided it should light Team would edit one line, and every check here would
stay green. What holds it is that the table is one screen long, names every view,
and is what a navigation change has to be read against, with the locked mock's
chrome-parity rule as the source that decides the values.

The three lesser ones: a view panel un-hidden by hand rather than through
`showView`; a sidebar panel reached by walking the DOM rather than by its id,
which the scan addresses by id and would miss; and `onWorkspaceReady` pressed
only at the line this change touches rather than end to end.

**Everything else is held mechanically**, and each of these is a named test:

| Drift | What fails |
|---|---|
| a call site nobody listed | `no call that lands the reader somewhere exists that this file does not name` |
| a view added to `showView` and not to the table, or the reverse | `every view the shell can show has a section, or an explicit none` |
| a section naming a rail entry or a sidebar panel that does not exist | `every section a view names is a section the rail actually carries` |
| a rail entry with no arm that shows a view | `every entry on the rail has an arm that shows a view` |
| anything but `showView` asking for a section | `nothing but showView asks for a section` |
| a second place lighting a rail entry | `nothing outside setNavState decides which rail entry is lit` |
| a second place hiding a sidebar panel | `nothing outside setNavState decides which sidebar panel is visible` |
| a panel added to the page and not to the list, or the reverse | `the panels setNavState hides are the panels the page carries` |
| `editorReturnView` gaining a third value | `the one destination whose view is a variable can only hold views the table knows` |

## The proofs are pressed, not matched

`showView` and `setNavState` are cut out of `public/app.js` and run, against the
nav rail and the sidebar cut out of `public/index.html`, in one `eval` so the
functions close over the two tables the way they do in the file. A copy of
either written into the test would keep passing after the real one changed, and
a shell that supplied its own markup would answer its own question, which is the
correction the routines door file already records having had.

`every view the shell can show lands the rail on the section its own table
names` iterates every view `showView` knows, and for each asserts the mapped
rail entry is the only lit one, the mapped sidebar panel is the only visible one,
and the pane itself was revealed. One test covers all eighteen destinations
because the source now has one mechanism, not because the test was written wide.

## Red first

The guards were written and run against the unmodified tree before the change
existed. Twelve of the eighteen were red, and the six that were green are the
drift guards and the manifest's self-checks, which describe what is already true
and exist to fail later. Reproduce with:

```
git checkout origin/main -- public/app.js public/views/conversations.js \
  public/views/profile.js public/views/routine-editor.js
node --test test/unit/navigation-doors.test.js
git checkout HEAD -- public/
```

Then mechanically, over the whole suite:

```
node scripts/red-first.js --base origin/main --tests "npm test"
```

**PROVEN: the tests fail without the change and pass with it.** 2,438 tests pass
with it; reverting the seven source files and keeping the tests turns 17 red.
The full record, including every name, is written to `.precommit-gate.json`
against the tree the gate passed on.

Six of those names are not evidence of anything and are called out rather than
left to inflate the number. They belong to the routines view, and they go red
under the revert for a mechanical reason: that file loads the shipped view
router and now loads the table beside it, so with the source reverted there is
no table to load. They discriminate this change without asserting anything about
it. Everything else in the list is a guard this change adds.

**One thing a reader should know about running the suite here.** Three tests in
this repository are timing dependent on subprocess lifecycle and fail
intermittently on a loaded machine, in `test/integration/process-lifecycle`,
`test/integration/delegation` and `test/unit/red-first`. Each failed once across
the runs of this change, in its own setup rather than in an assertion, each
passed on re-run, and none is touched by this diff. `red-first` refuses to
conclude anything when the suite does not pass with the change in place, which
is the correct response to a flake and means a run may need repeating.

## Mutation results

Thirteen mutations, each a form the defect actually took, including three that
put back the exact code that shipped before this change. Every one turns a named test
red.

```
node test/tools/mutate-nav-guards.js --markdown
```

| Guard broken | Tests red | Which |
|---|---|---|
| showing a view is what sets the section | 3 | `nothing but showView asks for a section`<br>`every view the shell can show lands the rail on the section its own table names`<br>`the routine editor is a routines surface and the rail says so` |
| a view with no section is shown without one rather than with a missing one | 2 | `the routine editor is a routines surface and the rail says so`<br>`the workspace picker takes no nav state, because it has no rail to take one on` |
| the table answers for every view the shell can show | 4 | `the section every destination names is the one the source resolves`<br>`every view the shell can show has a section, or an explicit none`<br>`every view the shell can show lands the rail on the section its own table names`<br>`the routine editor is a routines surface and the rail says so` |
| the table is the one showView reads, not a second opinion beside it | 2 | `the section every destination names is the one the source resolves`<br>`the routine editor is a routines surface and the rail says so` |
| the workspace switch asks for the chrome rather than repeating it | 4 | `nothing but showView asks for a section`<br>`nothing outside setNavState decides which sidebar panel is visible`<br>`nothing outside setNavState decides which rail entry is lit`<br>`switching workspace resets the chrome through the one place that owns it` |
| the panel list knows every panel the page carries | 1 | `the panels setNavState hides are the panels the page carries` |
| the panel list names no panel the page has stopped carrying | 5 | `the panels setNavState hides are the panels the page carries`<br>`every view the shell can show lands the rail on the section its own table names`<br>`the routine editor is a routines surface and the rail says so`<br>`exactly one sidebar panel is visible after any section is set`<br>`switching workspace resets the chrome through the one place that owns it` |
| the routine editor does not name a section of its own | 1 | `nothing but showView asks for a section` |
| selecting a skill does not name a section of its own | 1 | `nothing but showView asks for a section` |
| opening a skill's file does not name a section of its own | 1 | `nothing but showView asks for a section` |
| a destination nobody listed fails the enumeration by name | 1 | `no call that lands the reader somewhere exists that this file does not name` |
| every rail entry has an arm that shows a view | 2 | `no call that lands the reader somewhere exists that this file does not name`<br>`every entry on the rail has an arm that shows a view` |

The three that put shipped code back are the ones the enumeration is judged on.
Written as a table check alone, none of them would turn anything red, and the
change would have bought a comment.

## What this change does not do

Out of scope and untouched, as the criteria state:

- **What any view renders.** No view module's output changes. The one behaviour
  a reader will notice beyond a corrected rail entry is that opening a skill's
  own file now moves the sidebar to the file tree, because the editor is the
  Files surface and the rail now says so. The editor's Back control already
  returns to Skills and is unchanged.
- **The sidebar panel structure**, which is separate work already in flight. The
  panel work here is the two lists that decided which panel is visible, not the
  panels themselves.

## Two routes created alongside this

A skill link on a routine row, and scheduling a skill from its own page, were
built on other branches while this was written, each fixing only the route it
created. Both reach the reader through `selectSkill` and `openRoutineEditor`,
which are call sites this manifest already names, so neither adds a row. On
merge they inherit the corrected section rather than carrying one of their own.
If either lands a new `showView` call, the enumeration fails by name until it is
listed.
