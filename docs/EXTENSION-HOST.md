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
| `read` | `{ type: 'read', resource: <string> }` | Reads one of the extension's own declared resources. The host answers with a `resource` message. A resource id the extension's manifest does not declare is refused. |
| `write` | `{ type: 'write', resource: <string>, content: <string> }` | Writes one of the extension's own declared resources, capped at the manifest's `maximumBytes` for that resource. Undeclared ids and oversize writes are refused. |

Messages from the host to the extension: `init` (once, after `ready`, carrying
the render context), `resource` (the answer to a `read`), and `refused`
(`{ type: 'refused', of, reason }`, the answer to anything the table does not
allow).

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
- **The filesystem.** The only bytes an extension can read or write are its
  own declared resources, through the host, size-capped, path-resolved by the
  server inside the extension's own directory and nowhere else.
- **Other extensions.** Each mount has its own frame, its own mediator, and
  its own resource scope. There is no shared surface.

## How the enforcement works

Three layers, and each is tested rather than promised:

1. **The sandbox attribute.** `allow-scripts` alone. Combining it with
   `allow-same-origin` would hand the frame the app's origin, which is why
   the host refuses to construct such a frame at all rather than trusting
   callers not to ask.
2. **The mediator.** One listener, bound to the live frame's window, that
   validates every arriving message against the closed table above and
   refuses everything else with a reason. Messages from a window that is not
   the live frame, including a frame that has since been torn down, are
   ignored entirely.
3. **The server's path guard.** Resource reads and writes resolve inside the
   extension's installed directory; a resolved path that escapes it is
   refused server-side regardless of what the client asked for.

## Failure, update, and removal

A view that throws, reports an error, or never becomes ready does not get to
break the surface it was mounted on: the host tears the frame down and the
plain rendering returns, with the failure named beside it. When an extension
is updated or uninstalled while mounted, the mount is torn down cleanly: the
frame leaves the page, the mediator stops listening to it, and a message that
arrives late from the old frame is ignored. Nothing about the workspace's
data or layout is ever in the frame's hands.

## Wiring note

The host and registry are dynamically imported by the file view at its
render-target seam. Delivering the installed-extension roster to the client
is the install flow's work and arrives with the first shipped renderer; until
then the registry answers that no renderer is registered, which renders the
plain surface, as this contract requires of every unregistered target.
