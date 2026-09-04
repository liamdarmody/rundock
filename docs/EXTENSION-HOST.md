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
| `ready` | `{ type: 'ready' }` | Announces the view has booted. Until this arrives the host is waiting, and a view that never sends it is torn down and replaced with the plain rendering. |
| `resize` | `{ type: 'resize', height: <number> }` | Asks the host for a frame height. Clamped to sane bounds; never trusted raw. |
| `error` | `{ type: 'error', message: <string> }` | Reports that the view has failed. The host tears the frame down and shows the plain rendering with the message named. |
| `open` | `{ type: 'open', target: <string> }` | Asks Rundock to open a workspace file, the way a wikilink would. The host passes the request to Rundock's own opener; the extension never navigates anything itself. |

Messages from the host to the extension: `init` (once, after `ready`) and
`refused` (`{ type: 'refused', of, reason }`, the answer to anything the table
does not allow).

Resource read and write are deliberately not in this table. An extension
reading and writing its own declared resources is a real future capability,
but it needs a server transport that resolves a resource id inside the
extension's directory and enforces a byte cap, and none of that is built yet.
Naming those messages here while the server dropped them would be the
absent-contract failure this whole surface exists to avoid, so they are
absent: a `read` or `write` today is an unnamed type, and the mediator refuses
it with a reason like any other. When the transport ships, the rows and their
enforcement arrive together.

The `resources` a manifest declares are carried on the roster and the mount
payload as inert metadata: they name what an extension will one day be able to
read and write, so the install trust step can show them, but nothing reads the
field at runtime today. The host composes the frame from the entry and styles
only. A reader of the wire should not mistake a declared resource for a
reachable one; it becomes reachable when the read and write transport above
ships and enforces it.

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
- **The filesystem.** No message in the table reaches it. The server does
  resolve one class of path inside an extension's own directory, the
  renderer's own entry and stylesheet bytes it serves to the host at mount
  time, and refuses any manifest path that escapes that directory; but that
  is the host reading the extension to display it, never the extension
  reaching the disk.
- **Other extensions.** Each mount has its own frame and its own mediator.
  There is no shared surface.

## How the enforcement works

Three layers, and each is tested rather than promised:

1. **The sandbox attribute.** `allow-scripts` alone. Combining it with
   `allow-same-origin` would hand the frame the app's origin, which is why
   the host refuses to construct such a frame at all rather than trusting
   callers not to ask. Under a browser this is enforced by the engine; the
   focused suite runs under jsdom, which does not enforce sandbox flags or
   Content-Security-Policy, so the tests assert that the host writes the
   correct posture (the attribute and the frame CSP), not that a live engine
   denies a script. The posture strings are what a widening would change, so
   an attribute assertion is what a widening would lose; a browser-level check
   is a follow-up the browser suite carries, not a thing jsdom can prove.
2. **The mediator.** One listener, bound to the live frame's window, that
   validates every arriving message against the closed table above and
   refuses everything else with a reason. Messages from a window that is not
   the live frame, including a frame that has since been torn down, are
   ignored entirely.
3. **The server's path guard for renderer bytes.** The entry script and
   stylesheets a mount needs are read from inside the extension's own
   installed directory; a manifest path that resolves outside it is refused
   server-side regardless of what the manifest or the client asked for.

## Failure, update, and removal

A view that throws, reports an error, or never becomes ready does not get to
break the surface it was mounted on: the host tears the frame down and the
plain rendering returns, with the failure named beside it. When an extension
is updated or uninstalled while mounted, the mount is torn down cleanly: the
frame leaves the page, the mediator stops listening to it, and a message that
arrives late from the old frame is ignored. Nothing about the workspace's
data or layout is ever in the frame's hands.

## Wiring note, and what this lane deliberately does not connect

The host and registry are modules and a seam; the join that makes them a
running feature is a separate, tracked piece of work, not an oversight in
this one. Three connection points are owed by the lane that ships the first
renderer (the install flow, or the Dataview renderer), because each needs a
client message handler in `public/app.js`, which is outside this lane's
permitted paths:

1. **Populate the registry.** On a `list_extensions` roster, build a
   `createRendererRegistry`, call `registerFromRoster`, and assign it to
   `window.rundockRendererRegistry`. Until this exists the seam always takes
   the unregistered branch and renders the plain surface, which is correct
   for a workspace with no renderers but means the mount, mediator, degrade
   and swap paths are exercised only by this lane's tests, not yet at
   runtime.
2. **Register a transport.** Assign `window.rundockExtensionUiFetcher` to a
   function that requests `get_extension_ui` and resolves with the server's
   reply. The server sends `{ type: 'extension_ui', ..., entry, styles,
   resources }`; the seam treats a reply carrying an `entry` string as a
   success, so a transport forwards the server message as-is and needs no
   success flag of its own. A reply without an entry, or an
   `extension_ui_error`, degrades to the plain surface with the reason named.
3. **Signal update and uninstall to a live mount.** The mount exposes
   `swap(newPayload)` (re-mount) and `teardown()` (uninstall), and the file
   view already tears the mount down on the next file open and on
   `closeOpenFile`. What has no trigger yet is a roster change arriving while
   a mount is live: when the manage surface ships, an update or uninstall
   notice for the mounted extension calls `swap`/`teardown`. Until then the
   swap and teardown mechanics are proven as units here rather than end to
   end, which is stated so the evidence is not read as more than it is.

This is recorded so the dependency is a tracked handoff rather than a
paragraph nobody owns.
