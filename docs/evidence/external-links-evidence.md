# External links: every one opens outside the app

The rule: clicking a web link (http, https, or protocol-relative `//host/path`) anywhere in Rundock opens it in a new tab in a browser, and in the system browser in the desktop app, and the app page never navigates to it. An in-page anchor, a relative or workspace link, a wikilink and a mail link keep their own behaviour.

## How it is held

One rule for each half, so a surface added later cannot forget it:

- **The page:** `public/external-links.js`, a classic script loaded early on every page load, installs one click handler at the document root in the capture phase, ahead of every surface's own handler. A plain click on a link written as the web opens it with `window.open(href, '_blank', 'noopener,noreferrer')` and the page does not follow it. Modified and middle clicks are left to the browser, which already opens those in a new tab. The rich editor no longer opens links itself (`openOnClick: false`), because it opens from its own mouse handling and would have opened each link twice.
- **The desktop window:** `electron/external-links.js`, installed on the main window. A new window is always denied, and a web or mail address is handed to `shell.openExternal`; any other scheme is handed to nothing. The window may navigate only within the app's own origin, compared exactly; a prefix check it replaces read `http://localhost:3000@example.com/` as the app, and handed any scheme to the system.
- **Separate documents** keep their own single opener: the HTML preview's capture-phase handler (`public/viewers/registry.js`), which the review overlay now defers to rather than opening the same link a second time, and never hands a non-web scheme out; and an extension view, which reaches the web only through the host's click-gated `openExternal`.
- **Rendered markdown** writes `target="_blank"` on web links, protocol-relative ones included, which are no longer mistaken for workspace files.

## The surfaces

Audited at `fbdef2b` (before) and with this change (after).

| Surface | Before, browser mode | After |
|---|---|---|
| Conversation messages (agent, streaming, history) | New tab (target=_blank, added in `fbdef2b`); a protocol-relative link navigated the app page away | New tab through the page rule; protocol-relative too |
| User messages | Not a link (escaped) | Unchanged |
| Chat error cards (sign-in, runtime limits) | New tab (hard-coded target=_blank) | New tab through the page rule |
| Notes in the rich editor | New tab, opened by the editor's own link handling | New tab through the page rule, opened once |
| A relative link to a workspace file in the rich editor | A stray browser tab at the app's own address | Opens that file inside Rundock, by the resolver read-only rendering uses (`RundockMarkdown.workspaceFileTarget`); one that climbs out of the workspace names nothing |
| Links inside a callout in the editor | New tab | New tab through the page rule |
| Read-only rendering (text and JSON drawn as markdown) | New tab | New tab through the page rule |
| Source (textarea) view | Renders no links | Unchanged |
| HTML preview | Opened by two handlers, so twice where a second popup was allowed; any scheme (`javascript:`, `file:`) handed to `window.open` | Opened once; only the web and mail leave |
| Embedded notes | New tab | New tab through the page rule |
| Extension views | Only through the click-gated `openExternal` message | Unchanged |
| Board cards | New tab, and the card also switched into editing | New tab; the card stays as it was |
| Agent profile, skill pages, routines, run detail | Not links (escaped) | Unchanged |
| Settings: Report an issue; connectors account link | New tab (hard-coded target=_blank) | New tab through the page rule |
| Package offer, trust card, managed rows, receipts | Not links (escaped; receipt items are buttons that open in-app) | Unchanged |
| Search palette, find bar | Render no links | Unchanged |
| Help and docs button | `window.open` to the docs | Unchanged |
| Desktop app, any of the above | Window-open handler handed any URL, any scheme, to `shell.openExternal`; navigation off the app matched by prefix | Web and mail only, to `shell.openExternal`; navigation off the exact app origin stopped |

## How it is proved

| Run | Where | What it shows |
|---|---|---|
| Unit | `test/unit/external-links.test.js`, `test/unit/markdown-render.test.js` | The page rule opens web and protocol-relative links, runs ahead of a surface's own handler, and leaves anchors, relative links, wikilinks, mail and other schemes alone; the desktop guards deny every new window, hand out only the web and mail, and keep the window on its exact origin |
| Browser e2e | `test/e2e/external-links.spec.js` | On each surface that renders a link, a click opens exactly one new page at the address and the app page stays: a conversation message, a protocol-relative link, a chat error card, a note in the rich editor, a read-only rendering, an embedded note, a board card (which does not start editing), an HTML preview (once, not twice), Settings, and the help button; an in-page wikilink stays in the app |
| The shipped Electron | `test/electron/confinement.cjs` | With the main window's real guards on the real app page: a navigation to an external address is stopped and handed to the system browser, a new window is denied and handed out, another scheme is handed to nothing, and a real click (CDP input) on a web link in the app opens it in the system browser while the window stays |

Each rule has a row in `test/tools/mutate-extension-host-guards.js` that removes it, and a test fails for every row.
