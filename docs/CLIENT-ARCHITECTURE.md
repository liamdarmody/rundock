# The browser client

Read this before changing anything in `public/`. It explains how the client is
put together, why it is put together that way, and which parts look like
mistakes but are not.

The short version: there is no build step, the client is a set of classic
scripts, and modules publish their functions onto the global object on purpose.
If that sounds like something to modernise, read the next two sections before
you do, because the inline handlers in `index.html` depend on it.

## Why there is no build step

`npm start` runs `node server.js`. Change a file in `public/`, reload the
browser. That is the whole loop. No bundler, no transpiler, no minifier, no
watch process, no source maps to go stale.

Three production dependencies (`ws`, `marked`, `electron-updater`) and none of
them touch the client build, because there is not one.

This is a deliberate constraint, not an accident of age. Rundock is a local-first
desktop app that people run from source; a build step means a second thing to
install, a second thing to break on someone else's machine, and a gap between
what you read and what runs. The cost is that the client cannot use ES modules,
`import`, JSX or TypeScript syntax. Everything below follows from paying that
cost.

## How a module is found and loaded

Every client script is a classic `<script src>` tag in `public/index.html`, in
this order:

1. vendored third-party bundles (`marked`, `highlight.js`)
2. standalone pure modules (`markers.js`, `permissions.js`, `conversation-state.js`, `chat-markup.js`, and others)
3. the nine view modules under `public/views/`
4. `public/app.js`, last

Serving is two route patterns in `lib/http-router.js`: `/^\/[\w-]+\.m?js$/` for
top-level files under `public/`, and `/^\/(editor|vendor|viewers|views)\/...$/`
for the subdirectories. Both resolve against a realpath prefix check so traversal
cannot be expressed.

A script tag without a route is a silent 404 that a defensive fallback can mask,
which shipped once (`code-language.js`, 0.10.0). `test/integration/http-api.test.js`
now asserts every local script tag in `index.html` resolves to a live route, so
that class cannot ship again. Add a script tag, add a serve test.

Every module uses the same UMD wrapper:

```js
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockThing = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  /* ... */
  return { /* public surface */ };
}));
```

That `typeof self` is the UMD idiom, not a load-order guard. There are 24 of
them, one per module, and they all mean the same thing: run under Node when
required, attach to the window when loaded in a browser.

**The factory must be side-effect-free.** It may declare functions and allocate
inert values; it may not touch the DOM, read a global from another module, or
register a listener. If it does, `require()` throws under `node --test` and the
module loses its unit tests. This is checkable: every module under `public/views/`
requires cleanly in Node with `document` undefined.

## Republication, and when a name must not be republished

The view modules do something the standalone modules do not. After building the
namespace object they copy every name onto the root:

```js
root.RundockFilesView = factory();
Object.assign(root, root.RundockFilesView);
```

This exists for one reason: **things outside JavaScript resolve these names as
bare window properties.** Specifically:

- 28 inline `onclick=` attributes in `index.html` (plus one `onchange` and one
  `onmousedown`), which call `sendMessage()`, `cancelProcessing()` and friends
- `onclick` strings generated into HTML at render time
- e2e specs reaching client functions through `page.evaluate`, for example
  `page.evaluate(() => openSkillFile('CLAUDE.md'))` in `test/e2e/viewers.spec.js`

None of those can see a namespaced export. Remove the republication and they
break at runtime, not at load, and not in a way any type checker will tell you
about.

**The rule.** A module republishes when something outside module code resolves
its names bare. A module does not republish when every caller is ordinary
JavaScript that can say `RundockThing.method()`. `public/chat-markup.js` is the
worked example of the second case: three modules call it, none of them through an
inline handler, so it publishes one namespaced global instead of eight bare ones.

The republished surface is currently 165 names across nine modules. It is
enumerated in `test/unit/client-namespace.test.js`, which fails if two modules
claim the same name, if a view claims a name `app.js` already declares at top
level, if the surface drifts from its manifest, or if a republished name is never
called by its bare name anywhere. Adding a public function is therefore a
deliberate edit to that manifest.

## What stays in `app.js`, and why

`app.js` is 1,601 lines, down from 5,647. It owns boot, the WebSocket client,
routing, and shared-state wiring. It also keeps four things that render, each a
recorded decision rather than leftover mess:

| What | Why it stays |
|---|---|
| Workspace picker | Delegated document listeners plus `onWorkspaceReady` lifecycle wiring |
| Update strip | A top-level `window.electronAPI.onUpdate` registration |
| `EFFECT_EXECUTORS` | The effect half of the reducer in `conversation-state.js`, cross-view by construction: the same object renders chat bubbles, repaints the sidebar, clears agent status dots, moves unread badges and persists conversations |
| Application shell | Nav badges, sidebar resize handle, theme toggle icon: chrome present in every view, so it belongs in none of them |

`test/unit/app-retentions.test.js` enforces this. It classifies every DOM-writing
site in `app.js` by enclosing function and fails if one falls outside that list,
and it also fails if an entry stops rendering, because a retention list naming
functions that no longer render is how the previous version of this documentation
went stale.

Classify by enclosing function, never by the section banner above a line. Those
banners went stale as sections moved out, and reading them produced two confident
and wrong claims that the decomposition was finished.

## How modules share state

There is no import graph. Top-level `let` and `const` in a classic script live in
the shared global lexical environment, so a function in `views/find.js` can read
`currentView` or `activeConversation` declared in `app.js` simply by naming them.
The read happens at call time, so the value is always current.

This is why `app.js` loads last and why the retained identifiers above stay where
they are: they have readers in more than one module.

**Note `let` and `const` are not window properties.** `window.currentView` is
undefined even though `currentView` resolves. Do not reach for `window.` when
debugging these; use the bare name in the console.

### The `typeof` guards, honestly

You will find three reads written defensively:

```js
if (typeof editorMode !== 'undefined' && editorMode === 'preview') { /* ... */ }
```

There are exactly three (`editorMode` twice and `paletteOpen` once, all in
`views/find.js`). **They are not a load-order rule, and they are inconsistent.**
Four lines above the first one, in the same function, `currentView`,
`activeConversation`, `activeTiptapEditor` and `currentFilePath` are read bare.
All of them are `app.js` top-level declarations in exactly the same situation.

The actual invariant is simpler: `app.js` is the last script, module factories
are side-effect-free, and every one of these code paths is reached from a user
event or from `app.js` itself, so the declarations are always initialised before
anything can read them. The guards buy nothing that being last does not already
buy.

They are documented here rather than deleted because a documentation change is
the wrong place to alter behaviour. Either remove them or apply the pattern
consistently, in a change of its own.

## How a destination sets the chrome

**Show a view. Do not touch the rail.**

Every destination in this client lands the reader on a view, and the nav rail
and sidebar have to agree with the pane that view shows. That agreement used to
be a second thing each destination did for itself: `showView` revealed a pane
and `setNavState` lit an icon. Several destinations only did the first, and no
test could see the difference, so opening the routine editor lit Team, selecting
a skill lit nothing, and opening a skill's own file left Skills lit over the
editor.

The section is now a property of the view, not of the caller. `NAV_FOR_VIEW` in
`app.js` maps every view to the rail section its pane belongs to, and `showView`
resolves it and sets it. `setNavState` has two callers and only two: `showView`,
and the workspace switch, which resets the chrome before it knows which view
comes next and records why where it does it. Adding a destination means calling
`showView`. Adding a view means adding a row to
`NAV_FOR_VIEW`, where `null` says the view is shown with no rail at all, which
the workspace picker is and nothing else is.

There is also exactly one list of the sidebar panels, inside `setNavState`.
There were two: the workspace-switch reset carried a hand-written copy, they
were extended separately, and the workspace being switched to ended up showing
two panels stacked in one column. A copy of a function also misses whatever the
original grows later, which is how that one never learned to bring the New
conversation footer back.

`test/unit/navigation-doors.test.js` enforces both. It enumerates every
`showView` call site in `public/` from the source and fails until each is listed
with the section it lands on, holds the listed section against `NAV_FOR_VIEW`
rather than against its author, checks the panel list against the panels
`index.html` actually carries, and fails if anything outside `setNavState` lights
a rail entry or hides a panel. What it cannot check, and says so in its own
`NOT_CAUGHT` list, is whether the section a view is mapped to is the right one.

## Why the test settings are the way they are

These look like things to tune. They are load-bearing, and each one is the
scar of a specific failure.

**Coverage floors never ratchet down.** `test/tools/coverage-floors.json` holds
50 floors and the check exits non-zero below them. A floor rises when coverage
rises and never falls, because the alternative is a number that quietly tracks
whatever the code currently does, which measures nothing. If a change genuinely
makes a floor unreachable, that is a conversation, not an edit.

**E2E runs one worker, no parallelism, and no retries.** The specs share one
stateful server and a seeded workspace, and several assert cross-view navigation
on that shared instance, so parallelism would make them lie. No retries is the
deliberate part: a retry converts a real timing regression into a green run with
a footnote nobody reads. The 60 second timeout is a ceiling for a stuck test, not
a wait, and green tests never approach it.

If you meet a flaky e2e run, the useful move is to run the single spec file on
its own. Order-dependent pollution inside one file reproduces that way and looks
identical to flakiness in a full run.

**Move slices are verified byte-identical.** When code moves file, the moved
bodies are checked character for character against the original read back out of
git, and any exception is enumerated in the pull request. A refactor that changes
behaviour while claiming to be a move is the expensive kind of bug, and "it still
passes the tests" does not distinguish the two.

**Guards are written red first.** A test that has never failed has not been shown
to test anything. Every guard in this client was proved to fail for the right
reason before it was kept, and where a guard asserts an absence it carries a
companion assertion that the thing it guards still exists, so it cannot pass
vacuously the day someone renames it.

## Where to look

| You want | Go to |
|---|---|
| The process model, server, workspace layout | [ARCHITECTURE.md](../ARCHITECTURE.md) |
| Dev setup, conventions, changelog rules | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| A view's behaviour | the header comment at the top of its module in `public/views/` |
| What a module may and may not export | `test/unit/client-namespace.test.js` |
| What `app.js` may still render | `test/unit/app-retentions.test.js` |
| Which rail section a view belongs to | `NAV_FOR_VIEW` in `public/app.js`, enumerated by `test/unit/navigation-doors.test.js` |
| Chat thread markup | `public/chat-markup.js`, which is the only file allowed to write it |
| Markdown rendering, and what a document may put in the page | `public/markdown-render.js`, whose header carries the decision |
