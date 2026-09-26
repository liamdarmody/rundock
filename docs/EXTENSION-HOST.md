# The extension host contract

What a mounted extension can reach, what it cannot, and how each line is
enforced. This file is the contract: the host's message table is checked
against the table below by a test, so the two cannot drift apart. If you are
writing an extension, this page is the whole of the surface you may rely on;
if you are reviewing one, it is the whole of what the extension could do
inside its frame.

An extension's view runs in a frame with an opaque origin. Its agents and
skills, if it ships any, are ordinary files installed into the workspace and
are not governed by this contract; the install flow's trust step is where
those are consented to. This page is only about the rendered view.

## What a mounted extension can reach

Exactly the messages in the table below, sent to the host with
`parent.postMessage`. Nothing else. Every message is validated by the host
against this table; a message whose `type` is not listed, or whose fields do
not match the listed shape, is refused, and the refusal is posted back so the
extension can see what it did wrong.

| Type | Shape | What it does |
|---|---|---|
| `ready` | `{ type: 'ready', handles: <array> }` | Announces the view has booted. Until this arrives the host is waiting, and a view that never sends it is torn down and replaced with the plain rendering. `handles` is optional: the host messages this view answers beyond the ones every view gets. The only one is `'theme'` (see "The palette inside the frame" below); a view that names it is restyled in place when the theme changes, and one that does not is rebuilt. |
| `resize` | `{ type: 'resize', height: <number> }` | Asks the host for a frame height. Clamped to sane bounds; never trusted raw. |
| `error` | `{ type: 'error', message: <string> }` | Reports that the view has failed. The host tears the frame down and shows the plain rendering with the message named. |
| `open` | `{ type: 'open', target: <string> }` | Asks Rundock to open a workspace file, the way a wikilink would. Honoured after a click inside the view, one request per click across every view (see "One click, one request" below): the host reads the click from its own window's user activation, never from the message. A request the host cannot attribute to a fresh click in this view is put to the person in Rundock's own bar; a request with no click at all is refused with a reason. The host passes the request to Rundock's own opener; the extension never navigates anything itself. |
| `save` | `{ type: 'save', content: <string> }` | Hands back the whole contents of the file this view was mounted on, for the host to write. There is no path: the extension cannot name what it writes to, and the host writes the file it mounted and nothing else. Honoured only where the manifest declared `writes`; from an extension that did not, it is refused like any unknown type. |
| `change` | `{ type: 'change', content: <string> }` | Says the view has changed, with the whole contents of the file this view was mounted on. The host writes it once the changes pause, through the same debounce and the same guarded save the editors use, so a view that announces every keystroke writes once. Like `save`, there is no path, and it is honoured only where the manifest declared `writes`. Use `change` as the person edits and `save` for an explicit "save now". |
| `openExternal` | `{ type: 'openExternal', url: <string> }` | Asks Rundock to open a web address outside the view: the system browser in the desktop app, a new tab in browser mode. `http` and `https` only, and only after a click inside the view, under the same one-request rule as `open`; anything else is refused with a reason. This is how a view offers a link, because the frame itself may not navigate (see below). |
| `saveSource` | `{ type: 'saveSource', source: <string>, content: <string> }` | Hands back the whole contents of one of the files the note lists as its sources (see "Named sources" below), for Rundock to write. `source` is the name exactly as the note wrote it and as `init` or `sources` carried it; it is compared as a string against that list and never resolved as a path by the view. Honoured only where the manifest declared both `sources` and `writes`, and only for a source that resolved; Rundock resolves the list again from the note on disk at write time, writes through the same guarded save the editors use, and never follows a link. |
| `changeSource` | `{ type: 'changeSource', source: <string>, content: <string> }` | To `saveSource` what `change` is to `save`: the view changed a source, and Rundock writes it once the changes pause, through the same shared debounce. The same conditions as `saveSource`. |
| `ask` | `{ type: 'ask', agent: <string>, message: <string> }` | Asks Rundock to open a new conversation with an agent and put `message` in the message box, unsent (see "Asking an agent" below). `agent` is an agent id (lowercase letters, digits, `-` and `_`, at most 64) that the manifest declared in `extension.asks` and that is on the team; `message` is 1 to 4000 characters. Honoured after a click inside the view, under the same one-request rule as `open` and `openExternal`: an `ask` on a fresh click uses it, whether or not it is honoured. Nothing is posted back when it is honoured. |
| `setState` | `{ type: 'setState', state: <object> }` | Keeps the view's own state for this note: the whole state object, plain JSON, at most 64 KB. There is no extension, note or path in it: Rundock keeps it for the extension and the note it mounted, in its own folder, never in the note (see "A view's own state" below). Written once the changes pause, through the same debounce the editors use. Refused from an embedded view. A view built on Rundock UI uses `Rundock.viewState` rather than posting this itself. |

## What the host says to a mounted extension

Exactly these three messages, posted into the frame. The frame is told about
the one file it was mounted for, and the files that file names as its sources,
and nothing else about the page. There is no message about asking: an
honoured `ask` is answered with nothing, and no conversation, reply or
socket ever reaches a frame.

| Type | Shape | What it does |
|---|---|---|
| `init` | `{ type: 'init', path: <string>, content: <string>, theme: <string>, sources: <array>, state: <object> }` | Sent once per frame, after `ready`. A second `ready` from the same frame ends the view instead: it is what a page that has replaced the extension sends. Carries the opened file's workspace path and its text. The text is a copy; only `save` and `change` write it back, and only for an extension that declared `writes`. `theme` is `'dark'` or `'light'`, the theme the page shows at mount time, because an opaque frame has no other way to match it. Text longer than the host's cap, `MAX_INIT_CONTENT_CHARS` (2000000 characters), is never handed to a frame: the mount degrades to the plain rendering before any frame is appended, with the cap named. `state` is the view's own state for this note as last kept, or `null` (see "A view's own state" below). |
| `refused` | `{ type: 'refused', of: <string>, reason: <string> }` | The answer to anything the table above does not allow: `of` names the message type that was refused and `reason` says why. |
| `sources` | `{ type: 'sources', sources: <array> }` | The note's sources again, resolved from scratch, whenever a listed file or the note's own list changes on disk. Replaces the list `init` carried, for the view and for what `saveSource` may write. |
| `theme` | `{ type: 'theme', theme: <string>, tokens: <array> }` | Sent when the page's theme changes while the view is mounted, only to a view whose `ready` named `'theme'` in `handles`, and only after its `init`. `theme` is `'dark'` or `'light'`; `tokens` is the page's design tokens for that theme as `[name, value]` pairs of literal values, the same values the frame was built with. Before the view's own listener sees it, the frame applies it: the token block is rewritten and the body's `light` class set, so Rundock UI and every style written in `var(--...)` restyle with nothing rebuilt. The view keeps its state, including edits not yet written. |

`init.sources` and `sources.sources` hold one entry per name the note lists,
in its order: `{ path, content }` for a file handed over, or `{ path, refused }`
naming the rule that refused it. `path` is the name as the note wrote it,
never where it really lives, and nothing else about a file is sent. The list
is empty unless the manifest declared `sources`, the view claimed the note by
its marker, and the note lists files; an embedded view is always handed an
empty list.

Resource read and write are deliberately not in this table. An extension
reading and writing its own declared resources is a real future capability,
but it needs a server transport that resolves a resource id inside the
extension's directory and enforces a byte cap, and none of that is built yet.
Naming those messages here while the server dropped them would be the
absent-contract failure this whole surface exists to avoid, so they are
absent: a `read` or `write` today is an unnamed type, and the mediator refuses
it with a reason like any other. When the transport ships, the rows and their
enforcement arrive together.

An extension declares one entry, one match rule, optionally a frontmatter
marker that narrows the match rule to the files carrying it, and optionally
a list of stylesheets. Declared stylesheets are validated at install exactly as the
entry is (relative, present, no symlinks), served from inside the
extension's own installed directory under the same path guard, and inlined
into the frame as `<style>` elements; a declared stylesheet that does not
resolve inside the directory refuses the whole payload the way a bad entry
does. Resources remain undeclared and unserved: the `resources` field on
the roster and the mount payload is a shape-only placeholder that is always
empty, kept so the client reads one shape now and when a resource transport
ships. When the read and write transport above ships, declared resources,
their rows and their enforcement arrive together; until then a reader of
the wire should treat that field as empty by contract.

## Named sources

A dashboard over several files is built by naming them. The person lists the
files in the dashboard note's frontmatter, as exact workspace-relative paths:

```yaml
---
portfolio-dashboard: true
sources:
  - Investments/Holdings.csv
  - Investments/Limits.csv
---
```

A block list or a flow list (`sources: [a.csv, b.csv]`) both work, and
`"[[Investments/Holdings.csv]]"` is read as a spelling of that exact path.
Nothing is searched for, globbed or enumerated, so the only files a view is
ever handed are ones a person typed. A view is handed its note's sources only
when all three hold: the manifest declares `extension.sources: true`, which it
may only do together with `extension.declares` (a marker; the install and the
roster refuse `sources` without one, because `sources` is a common frontmatter
key and a bare claim on every note of a type would harvest every note's
list); the view claimed this note by that marker; and the note lists files.

Each name is refused, with a reason naming the rule and never the target, when
it is an absolute path, starts with `~` or a drive letter, uses a backslash,
has a `.` or `..` or empty segment, contains a glob character, an alias or a
heading (`|`, `#`), has any segment beginning with a dot, is a symlink or
passes through a symlinked folder, is a hard link (a file with a second name
elsewhere), is a folder or missing, is listed twice, or is the note itself
under any spelling (compared by device and inode, because a case-insensitive
disk keeps whatever spelling it was handed). A note may list at most 12
names, and the note and its sources together are held to the same
`MAX_INIT_CONTENT_CHARS` as the note alone; a source past it is refused.

Rundock's server is the authority. The page asks for sources with the note's
path and nothing else; the server reads the list from the note on disk,
resolves it, and watches the mount: a change to a listed file, to the note's
own list, a deleted source and a file swapped for a link all reach the view
as a `sources` message with the whole list resolved again. The watch belongs
to the mount and ends with it.

No write an extension causes, `save`, `change`, `saveSource` or
`changeSource`, and whether or not the extension declared sources, may change
the `sources` list of the file it writes. The host refuses it with a reason,
and the server refuses it again for every write it makes for an extension. A
view that could rewrite its own note's list could name any file and be handed
it next time. An edit that keeps the list is allowed.

## Asking an agent

A view can offer the person a way to ask an agent about what it shows. It
never reaches the agent itself: it drafts, and the person decides.

The manifest names the agents a view may ask, `extension.asks`, one to four
agent ids, validated at install. After a click inside the view, `ask`
opens a new conversation with that agent (never the open one, never an
existing one), puts the message in the message box, unsent, and shows a line
saying which extension drafted it from which file and that nothing has been
sent. The person sends it, changes it, or leaves it; a conversation nobody
sends is never saved. Anything the person had typed and not sent in another
conversation stays with that conversation and is there when they return to
it: every conversation keeps its own unsent text. Before the message reaches the box, control
characters other than tab and newline, bidirectional marks, overrides and
isolates, and zero-width characters are removed, so the box shows exactly
what would be sent.

An `ask` is refused, with a reason, without a click inside the view, for
an agent the manifest did not declare (the person is never asked about one), for a
declared agent that is not on the team, from an embedded view, and for a
shape the table does not allow. The name is checked by membership of the
declared list, so a name like `constructor` is simply not declared. On
success nothing is posted back: the view never learns a conversation id, the
reply, or whether the person sent, changed or ignored the draft. No
conversation is ever shown inside a file.

## One click, one request

The browser keeps one record of a click for the whole page, and it lasts a
few seconds after the last click. A click inside any view sets it, and the
host cannot see a click inside a frame, so while that record is live the host
cannot tell one click from the next. The rule follows from that:

- **One click authorises one request, across every view.** Once any view's
  `open`, `openExternal` or `ask` is honoured on a click, that click is used
  for every view until the browser reports that it has lapsed.
- **A view opened while a click is live did not earn it.** A view mounted
  during a live click (the tree click that opened its file, or another view's
  button) cannot use that click as its own, even if it moves focus into
  itself.
- **A person's first click works** whenever no earlier click is still live.

A request that meets a live click the host cannot attribute to a fresh click
in that view is not guessed at. Rundock asks the person in its own bar,
directly above the view, inside the file's panel: "Open Investment
Dashboard.md?", "Open https://example.org/ in a new tab?", or "Start a
conversation with Wren with a drafted message?", with Open and Dismiss. The
bar is part of Rundock's page, so the view cannot draw it, read it or press
it; Open and Dismiss act only for a real press, and only once the bar has
been on screen for a moment. Open performs the request as Rundock's own act.
Dismiss tells the view `you dismissed this in Rundock`. One request waits at
a time: while it does, any other such request is refused with `Rundock is
already asking you about another request`. Leaving the file clears the bar.

A request with no click in the view at all is refused, and Rundock says so
in the same place: "The investment-partner extension tried to open
Investment Dashboard.md without you asking, so Rundock stopped it." The view
is told `Rundock stopped this because it did not come from your click`, with
`of` naming the request. These reasons are written for the person, because a
view may show them; a view that shows its own notice for a refused `open`,
`openExternal` or `ask` should not, since Rundock has already said it.

## The palette inside the frame

An opaque-origin frame inherits nothing from the page, so a third-party
stylesheet written against Rundock's design tokens (`var(--accent)` and the
rest) would resolve to nothing without help. The host therefore inlines a
`:root` block of the page's custom properties ahead of the extension's own
styles: the extension reads the palette from the host and stays free to
override its own layout. The token names are derived from the page's loaded
stylesheets at frame build, not kept as a list, so a token added to
`tokens.css` reaches extensions with nothing to update; the values are read
out of the live computed style, so they are the showing theme's values with
no second copy to drift. What crosses the boundary is a block of literal
values, never a live reference: the sandbox posture is exactly what it was
before tokens existed, and nothing in the block can reach back.

A theme change while a view is mounted restyles it in place, for a view that
says it can take that. Its `ready` names `'theme'` in `handles`, and on a
flip the host sends a `theme` message carrying the new theme and the token
values read off the page at that moment. Code the host inlines ahead of
Rundock UI and the entry rewrites the token block and sets the body's
`light` class, so Rundock UI and the extension's own `var(--...)` styles
follow, and the view's own listener then sees the same message for anything
it drew from `init`'s `theme` itself. Nothing is rebuilt, so the view keeps
its state, and an editing view keeps what it has not yet written. A view
built on Rundock UI needs nothing more than the `handles` line:

```js
parent.postMessage({ type: 'ready', handles: ['theme'] }, '*');
```

A view that does not name `'theme'` is rebuilt instead, as every view was
before the message existed: a fresh frame with the new theme's values, a
fresh `ready`, and an `init` carrying the new theme and the file as the host
last handed it. It loses transient state such as scroll position, and an
editing view loses anything not yet written, so a view that edits should
name `'theme'`.

## A view's own state

A view has preferences that are nobody's data: the widths someone dragged, a tab they chose. Rundock keeps them for the view, one value per extension per note, so a view never has to write them into the person's note. Every extension gets this; there is nothing to declare, and the install card says so.

`Rundock.viewState` is the whole of it for a view. `get(key)` returns the entry kept under `key`, or `undefined`, and works from the entry's first line: the host inlines the state into the frame's document before the entry runs, and `init` carries it too. `set(key, value)` changes the frame's copy at once and asks Rundock to keep the whole state, and `set(key, undefined)` removes the entry. A key is 1 to 64 letters, digits, `.`, `_`, `:` or `-`; any other key throws a `TypeError` and nothing is sent. Keys starting `rui.` belong to Rundock UI. `Rundock.viewState` is frozen and cannot be replaced. A region renderer, which belongs to no one note, has no `Rundock.viewState`.

- **Plain JSON only.** Objects with string keys, arrays, strings, finite numbers, booleans and `null`, at most 16 levels deep and 64 KB (65,536 bytes of UTF-8 once serialised). A `Date`, `Map`, `Set`, typed array, `RegExp`, `Blob`, `undefined` or a hole in an array, `NaN`, `Infinity`, an object that is not plain, or a cycle is refused. The host checks before anything leaves the page and the server checks again. Each extension's state is also capped in total, at 1 MB and 1,000 notes; a write that would pass either is refused, and a write that shrinks or removes state is always allowed.
- **Every refusal is named.** The view receives `refused` with `of: 'setState'` and the reason, such as "the view state is larger than 64 KB", "the view state is not plain JSON: a Date at settings.since" or "this extension's view state is over its limit". Its own copy stays as it set it, so it keeps working for the session.
- **Written after a pause.** A burst of `set` calls (a column being dragged) is written once, through the same debounce the editors and `change` use, and a pending write is made when the person opens another file.
- **Embedded views read, never write.** A view shown inside another note receives its state and every `setState` from it is refused, as `save` and `change` are.
- **The last write wins.** Two views of one note (opened and embedded) each read the state once, when they mount; neither is told about the other's writes.
- **Stored per machine.** The state lives in `.rundock/extension-state/<extension>/`, one file per note named by a hash of the note's path. `.rundock/` is a hidden folder that Rundock does not sync, so a workspace opened on another machine may not carry it. A state file is never handed to any view.
- **Renames start afresh.** A note's state is kept under its path, so renaming or moving the note starts its state again; the old file stays until the extension is uninstalled.
- **Kept on update and disable, removed on uninstall.** Uninstalling the package removes the extension's whole state folder in the same step as its files, and leaves every other extension's state as it was.

## Where a view sits: full bleed

A view opened on its own is the pane, not a box inside it. While an extension holds the editor pane, the pane has no padding and the frame spans it edge to edge and top to bottom. The frame and its document paint `--elevated`, the pane's own colour, in both themes, with no radius or border. The document's `body` carries the note's `24px 32px` padding, so a view's first line starts exactly where a note's first line of text does. An extension should not add an outer padding of its own.

Two variations, each a class on the frame's `body`:

- **`rundock-embedded`**, set by the host for a view shown inside another note: the panel already pads it, so the document paints the panel's `--surface` and adds no padding.
- **`rundock-full-bleed`**, set by the view itself (`document.body.classList.add('rundock-full-bleed')`) when it wants an edge-to-edge canvas: the body padding goes to zero. Setting `body { padding: ... }` in the extension's own stylesheet works too, since it is inlined after the floor.

## Rundock UI inside the frame

Every frame the host builds, for a mounted view, an embedded view or a region renderer, also carries Rundock UI, the component library ([RUNDOCK-UI.md](RUNDOCK-UI.md)): its stylesheet is inlined after the floor and before the extension's own styles, and the library itself runs after the error bootstrap and before the entry, so `window.Rundock.ui` exists when the entry starts. In the light theme the frame's `<body>` carries the class `light`, stating early enough for a stylesheet what `init` already says in `theme`.

None of this widens the frame. The library is the host's own code inlined as text under the frame's unchanged policy, and it runs as the frame: it posts no message, reads nothing of the page and fetches nothing, so the tables above are the whole of what a view can say and hear with it as without it. The sandbox attribute, the Content-Security-Policy and the mediator are unchanged. `test/unit/rundock-ui-frame.test.js` runs the frame document the host builds and holds each of these; `test/e2e/rundock-ui-gallery.spec.js` drives the library inside real sandboxed frames.

A manifest may declare `extension.rundockUi`, the Rundock UI version the extension was built against. The install refuses one this Rundock cannot honour by name; the rule is in [RUNDOCK-UI.md](RUNDOCK-UI.md#versions-and-compatibility).

## What a mounted extension cannot reach

- **Rundock's page.** The frame is `sandbox="allow-scripts"` with no
  `allow-same-origin`, so its origin is opaque: it has no access to Rundock's
  DOM, cookies, storage, or scripts, and `parent` is a cross-origin handle
  that accepts nothing but `postMessage`.
- **Rundock's socket, conversations, or permission bridge.** None of these
  are messages in the table, so the mediator refuses any attempt by shape.
- **The network.** The frame's document carries a Content-Security-Policy of
  `default-src 'none'` with inline script and style allowed and `data:`
  images only, so the view cannot fetch, beacon, or load anything external.
  That policy governs what the document loads, not the document replacing
  itself, so leaving is stopped separately (see "How the enforcement works").
  In the desktop app WebRTC is switched off as well. In a browser a peer
  connection cannot be prevented, and the trust card says so.
- **Any file it was not mounted on.** A view cannot open another file without
  a click, and it is never mounted on, sent, or allowed to save a file in a
  hidden folder or a hidden file (`.claude/`, `.rundock/`, `.mcp.json`,
  `.env`): the renderer registry refuses to claim one, however it was opened.
  Nor is it handed a linked file, a file in a linked folder, or a file with a
  second name elsewhere (a hard link), whose visible name could stand for a
  hidden file or one outside the workspace. The server decides that from the
  file's own metadata (`lib/workspace/extension-file.js`) and states it with
  every read; the page forwards the answer and reads no answer as a refusal.
  A save an extension causes is held to the same rule again at write time,
  and the file is opened without following a link.
- **The filesystem.** No message in the table reaches it. The server does
  resolve one class of path inside an extension's own directory, the
  renderer's declared bytes (its entry script and any declared stylesheets)
  it serves to the host at mount time, and refuses any declared path that
  escapes that directory; but that is the host reading the extension to
  display it, never the extension reaching the disk.
- **Other extensions.** Each mount has its own frame and its own mediator.
  There is no shared surface.

## How the enforcement works

Four layers, and each is tested rather than promised. The confinement
claims are proved in real engines, Chromium and the shipped Electron, with a
hostile extension and a local listener standing in for an attacker, because
jsdom enforces neither sandbox flags nor Content-Security-Policy. The unit
suite asserts the same rules fail fast when a guard is removed.


1. **The sandbox attribute.** `allow-scripts` alone. Combining it with
   `allow-same-origin` would hand the frame the app's origin, which is why
   the host refuses to construct such a frame at all rather than trusting
   callers not to ask.
2. **Leaving is stopped outside the frame, and ends the view if it happens.**
   A sandboxed frame is always allowed to navigate itself, and the page that
   replaces it is still the frame's window. So the app page is served with
   `frame-src 'self'`, which refuses the navigation before any request
   leaves; in the desktop app, guards keyed to opaque-origin frames refuse
   the navigation and cancel any request from those frames
   (`electron/extension-frame-guards.js`); and the host treats a frame's
   second `load`, or a second `ready`, as the view leaving and tears it
   down. The same rules apply to the headless frame that draws regions.
3. **The mediator.** One listener, bound to the live frame's window, that
   validates every arriving message against the closed table above and
   refuses everything else with a reason. Messages from a window that is not
   the live frame, including a frame that has since been torn down, are
   ignored entirely.
4. **The server's path guard for renderer bytes.** The entry script and the
   declared stylesheets a mount needs are read from inside the extension's
   own installed directory; a declared path that resolves outside it is
   refused server-side regardless of what the record, the manifest or the
   client asked for.

## Where an extension is installed from

An extension is installed from a tag or an exact commit of its GitHub repository, and never from a branch. A branch names whatever was pushed last, so the code the trust card describes could change after you agree to it. A link can name its tag or commit (`owner/repo@v1.2.0`, a release page, a `tree/` link, or `owner/repo@<full 40 character commit>`). A link that names nothing is pinned to the repository's latest version tag. A link to a branch is refused with the reason on the field: use a tag or an exact commit. What the reference is on the repository decides this, not how it is spelled: a tag is fetched as a tag, so a branch that shares its name never arrives in its place. The trust card names the commit a tag resolved to, and names a commit pin by its commit. Updates follow the same rule: an extension is updated as part of its package, from the Packages page, and only to a newer version tag (see [Updating a package](PACKAGES.md#updating-a-package)). Agents and skills are files rather than code, so a content-only package may still be read at a branch a link names.

## Failure, update, and removal

A view that throws, reports an error, or never becomes ready does not get to
break the surface it was mounted on: the host tears the frame down and the
plain rendering returns, with the failure named beside it. When an extension
is uninstalled while mounted, the mount is torn down cleanly: the
frame leaves the page, the mediator stops listening to it, and a message that
arrives late from the old frame is ignored. Nothing about the workspace's
data or layout is ever in the frame's hands. When its package is updated
while a view is open, the view is swapped to the new code, including when
only the commit changed and the version number did not, and an edit the view
was still waiting to save is saved first.

## How the host is wired into the client

The host and registry are modules; three joins in the client make them a
running feature, and each is held by a test that runs the shipped code
rather than a copy of it (`test/unit/host-wiring.test.js`).

1. **The registry is hydrated from the roster.** Opening a workspace
   requests `list_extensions` in the same batch as agents and files. The
   reply is registered through `createRendererRegistry` and
   `registerFromRoster` and assigned to `window.rundockRendererRegistry`,
   replacing the previous workspace's registry rather than merging into it.
   A roster error installs an empty registry carrying the server's reason,
   so every lookup answers "unregistered, because the roster could not be
   read" instead of the old workspace's claims.

2. **The transport is the socket.** `window.rundockExtensionUiFetcher`
   sends `get_extension_ui` and resolves with the server's reply forwarded
   as is, correlated by extension id plus renderer id. A reply that never
   arrives, because the socket closed or the exported timeout elapsed,
   resolves with a reason, so the seam always settles on the plain surface
   rather than a blank pane.

3. **A live mount follows the workspace and the roster.** A workspace
   change closes the open file, which releases the mount: the frame leaves
   the document, the mediator stops listening, and a late message from the
   old frame is ignored. Every roster arrival calls
   `reconcileExtensionMount(roster)`, the one entry point the manage
   surface also calls: an extension absent from the roster or carrying
   `enabled: false` is torn down with the plain surface drawn under a stated
   reason, one present with a different version is swapped with a freshly
   fetched payload, and one whose version is unchanged is left alone.

The roster itself is read from the install store: one entry per record in
`.rundock/extensions.json`, its renderer built from the extension's
`rundock.json` (`extension.entry`, `extension.match`), with a match of the
form `*.<ext>` mapped to the registry target `.<ext>` and any other rule
reported on the roster as a named refusal rather than a claim.

A manifest may also declare `extension.declares`, a single frontmatter key
in the slug grammar, and the renderer then claims only files of its match
rule whose frontmatter carries that key: the mechanism that lets an
extension own a kind of markdown file without claiming every note in the
workspace, mirroring how kanban detects a board by its `kanban-plugin` key.
The claim is decided at the file view's seam, which passes the opened
file's content to the registry lookup; the registry itself performs no IO.
Precedence is enforced rather than emergent: a marker claim beats a bare
claim on the same target because it is more specific, core beats an
extension on a core marker (an extension declaring `kanban-plugin` is
refused, on the roster and at registration), and two extensions declaring
one marker keep first-claim-wins in roster order with the losing claim
recorded and shown as the managed row's problem line. A marker extension's
row also states which files it claims, because a renderer waiting for a
marker is the one claim a person cannot see fire.

The file tree lists a file whose extension an enabled record claims, beside
the kinds Rundock renders itself, and stops listing it when the record is
disabled or removed; the tree reads the same roster reader at build time,
and a records change makes the cached tree stale on the next read or poll.

## The mount contract, and who owns the save

Every view that shows a file, built in or an extension, is mounted the same way and has the same two parts in saving:

- **`getContentForSave`**: the view hands back the whole file when asked. A view that cannot be written leaves it null and never takes part in saving. An extension answers this with `save` or `change`, which carry the content.
- **`onChange`**: the view says it changed, and does nothing else about saving. A built-in viewer is handed `onChange` at mount and calls it; an extension posts `change`.

**The debounce lives in the caller, not in the view.** Rundock keeps one debounced save for whatever file is open (`public/save-scheduler.js`), shared by the text editor, the rich editor, the board and every extension view. It decides how long to wait, writes the file the change was made in even after the person has moved to another, and writes at once on Cmd+S or when a file is closed with an edit still waiting. A writable view never keeps a save timer of its own.

## Embeds: one note, several files, each through its own extension

A note can show other files where it names them. A line holding only embeds, written the way Obsidian writes them, becomes a row of panels:

```
![[holdings.csv]] ![[allocation.csv]] ![[risk.md]]
```

Each panel is the file rendered by whatever extension claims it, exactly as it renders when opened directly, so a dashboard is a document that embeds files rather than an extension that reads several. The rules:

- **One file per view.** Each embedded view is its own mount on its own file, handed that file's text and nothing else. No extension gains a way to read a file it was not mounted on.
- **Read-only.** An embedded view is mounted without `writes`, whatever its manifest declared, so `save` and `change` from it are refused, and so is `open`: embed to see, open the file to edit.
- **Three to a row.** Up to three panels sit side by side; a fourth starts a new row. `![[file|400]]` sets a panel's height in pixels, within bounds.
- **Depth one.** An embedded note is drawn as a note, and its own embeds show as links, so a cycle cannot form. A note that embeds itself shows a link.
- **Never blank.** A target nothing claims shows its text if it is text, and a link if it is not. A missing file says so. Files in hidden folders are never shown.
- **The document is untouched.** Panels are drawn beside the line, never written into it, so a note with embeds saves byte for byte whether or not the extensions that draw them are installed. An embed inside a sentence stays a link.

## Pausing every extension

Settings, Extensions has one control, Pause all extensions, that stops every installed extension at once, for when something is wrong and it is not clear which extension. It changes no extension's own setting: while paused, each row's switch keeps its own on or off position but is disabled, and Resume extensions brings each one back to exactly the state that was set before.

Off, whether by the switch or by an extension's own setting, is enforced where the code is served: Rundock refuses to hand an extension's entry or styles to any window while it is off, and tells every open window, which tears down a live view and stops a running render service without asking again.

