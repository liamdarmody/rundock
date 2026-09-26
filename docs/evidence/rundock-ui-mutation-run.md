# Rundock UI mutation run

Every row of `test/tools/mutate-rundock-ui-guards.js` on the tree this commit records, with the tests each turned red. Rows marked "in Chromium" and the geometry and chip rows ran one named Chromium test through Playwright; the rest ran their unit suite. A row that turned nothing red would be printed in bold and fail the run; there are none. Regenerate with `node test/tools/mutate-rundock-ui-guards.js --markdown`.
| Guard broken | Tests red | Which |
|---|---|---|
| an alert with an action aligns message and action on the first baseline | 1 | `message and action align on the first baseline; the icon joins it; an alert without one is untouched` |
| the alert icon joins the first line | 1 | `message and action align on the first baseline; the icon joins it; an alert without one is untouched` |
| a mounted view is built with Rundock UI | 3 | `a mounted view gets the same library as a region, and the same posture as before`<br>`an embedded view is built with Rundock UI, which runs before its entry`<br>`an embedded view is told so on its body, and a view opened on its own is not` |
| a region frame is built with Rundock UI | 4 | `the library runs before the entry, so an extension can call it at once`<br>`the stylesheet sits after the floor and before the extension, so the extension can override it`<br>`the frame body carries the light class in the light theme, and none in dark`<br>`without a page to read, the library still travels and the stylesheet is simply absent` |
| the library runs before the entry | 3 | `the library runs before the entry, so an extension can call it at once`<br>`an embedded view is built with Rundock UI, which runs before its entry`<br>`without a page to read, the library still travels and the stylesheet is simply absent` |
| the component stylesheet sits before the extension's own | 2 | `the stylesheet sits after the floor and before the extension, so the extension can override it`<br>`an embedded view is built with Rundock UI, which runs before its entry` |
| the frame body carries the theme class | 2 | `the frame body carries the light class in the light theme, and none in dark`<br>`an embedded view is told so on its body, and a view opened on its own is not` |
| the gallery page carries the frame policy | 1 | `the Rundock UI gallery is served, under the same frame policy` |
| the stylesheet is read from the sheet marked data-rundock-ui | 2 | `the stylesheet sits after the floor and before the extension, so the extension can override it`<br>`an embedded view is built with Rundock UI, which runs before its entry` |
| the library source has no way out of the frame | 1 | `its source has no way out of the frame: no messages, no parent, no network, no parsed markup` |
| a label is text, never markup | 3 | `its source has no way out of the frame: no messages, no parent, no network, no parsed markup`<br>`a label is text, never markup`<br>`column headers are scoped, numeric columns align right, and cells are text or rendered nodes` |
| the factory set is frozen | 1 | `installs from its source text alone, with every factory and a version` |
| one tab is the tab stop | 4 | `a named tablist whose selected tab is the one tab stop`<br>`ArrowRight and ArrowLeft move focus and selection together, wrapping`<br>`Home and End jump to the ends`<br>`a click selects without a key, and other keys do nothing` |
| End jumps to the last item | 2 | `Home and End jump to the ends`<br>`Space checks the focused radio; Home and End jump to the ends` |
| Home jumps to the first item | 2 | `Home and End jump to the ends`<br>`Space checks the focused radio; Home and End jump to the ends` |
| the arrows wrap | 2 | `ArrowRight and ArrowLeft move focus and selection together, wrapping`<br>`all four arrows move focus and selection together, wrapping` |
| a vertical tablist moves on the vertical arrows | 1 | `vertical orientation moves on ArrowDown and ArrowUp` |
| a tab panel is shown only for its selected tab | 1 | `panels, when given, are wired both ways and shown only for the selected tab` |
| Space checks the focused radio | 1 | `Space checks the focused radio; Home and End jump to the ends` |
| with nothing checked the first radio is the tab stop | 1 | `with nothing checked, the first radio is the tab stop` |
| the slider announces its formatted value | 1 | `aria-valuetext replaces the raw number and follows every input` |
| a field marks its control invalid | 1 | `an error sets aria-invalid and points aria-describedby at the error text` |
| a field describes its control by the error | 1 | `an error sets aria-invalid and points aria-describedby at the error text` |
| a toggle is a switch | 1 | `a toggle is a checkbox with the switch role` |
| indeterminate is set as the property | 1 | `a checkbox is a native box inside its label, and indeterminate is the property` |
| an interactive card answers Enter and Space | 1 | `an interactive card is a keyboard button: role, tab stop, Enter and Space` |
| loading is a status | 1 | `loading is a polite status with words for a screen reader` |
| Escape returns focus to the menu trigger | 1 | `opens on the trigger, arrows move through the items, Escape closes and returns focus` |
| a menu choice closes the menu | 1 | `choosing an item selects it, closes, and returns focus to the trigger` |
| a press outside closes the menu | 1 | `Tab and a press outside both close it` |
| a board card moves from its menu | 1 | `a menu choice moves the card, reports the move, says it aloud, and keeps focus on the card` |
| a board move is said aloud | 1 | `a menu choice moves the card, reports the move, says it aloud, and keeps focus on the card` |
| focus follows a moved card | 1 | `a menu choice moves the card, reports the move, says it aloud, and keeps focus on the card` |
| statusOptions narrows where a card may go | 1 | `statusOptions narrows where a card may go` |
| a failed canvas offers Retry | 1 | `a failed render shows the failure and a Retry that draws again` |
| stale time is said in words | 1 | `stale past its threshold, said in words as well as colour` |
| the primary button fills with --accent-action, not the brand | 3 | `every pairing clears its bar in both themes, or is a pinned, explained shortfall`<br>`no Rundock UI fill is the brand, and every orange fill is on its own side of the rule`<br>`each fill sits where the rule puts it` |
| a measured rule is a measured member (a removed rule is loud) | 4 | `Rundock UI contrast, computed from tokens.css and rundock-ui.css`<br>`the stat delta reads in --text-1 both ways, its dot decorative`<br>`the current menu item is --text-1 with a check mark`<br>`the danger button's hover and pressed tints keep its label at 4.5:1 in light` |
| the stale time is readable in light | 1 | `every pairing clears its bar in both themes, or is a pinned, explained shortfall` |
| the danger button is an outline, never the fill | 2 | `every pairing clears its bar in both themes, or is a pinned, explained shortfall`<br>`--accent-action and --danger sit close in luminance, which is why danger differs by form` |
| no solid fill is the brand --accent | 3 | `every pairing clears its bar in both themes, or is a pinned, explained shortfall`<br>`no Rundock UI fill is the brand, and every orange fill is on its own side of the rule`<br>`each fill sits where the rule puts it` |
| a bare control shape is control orange, not action orange | 4 | `every pairing clears its bar in both themes, or is a pinned, explained shortfall`<br>`every entry in the known list is still a shortfall, so the list only ever shrinks`<br>`no Rundock UI fill is the brand, and every orange fill is on its own side of the rule`<br>`each fill sits where the rule puts it` |
| a fill carrying text is action orange, not control orange | 3 | `every pairing clears its bar in both themes, or is a pinned, explained shortfall`<br>`no Rundock UI fill is the brand, and every orange fill is on its own side of the rule`<br>`each fill sits where the rule puts it` |
| control orange clears 3:1 on the light surfaces | 3 | `every pairing clears its bar in both themes, or is a pinned, explained shortfall`<br>`control orange clears 3:1 against every surface in both themes, and is the brand itself in dark`<br>`the white tick and thumb on control orange: 3.83:1 in light, and the accepted 2.85:1 in dark` |
| the send icon button copies the chat send button | 1 | `.rui-icon-btn-send matches views/chat.css .send-btn` |
| an icon button must be named | 1 | `a named native button with a decorative icon, the default 32px variant unless told` |
| the send button becomes a named stop button | 2 | `a named native button with a decorative icon, the default 32px variant unless told`<br>`the send variant moves through empty, active and cancel, renaming itself for the stop` |
| white on --accent-action clears 4.5:1 | 3 | `every pairing clears its bar in both themes, or is a pinned, explained shortfall`<br>`white on --accent-action clears 4.5:1, and its hover is darker and clears it further`<br>`--accent-action and --danger sit close in luminance, which is why danger differs by form` |
| the input copies the settings input | 1 | `.rui-input matches views/settings.css .settings-input` |
| a copied rule is a member (a removed copy is loud) | 2 | `.rui-tabs matches views/settings.css .mode-toggle`<br>`the drift lint passes on the tree, and it reads rundock-ui.css` |
| every animation stops under reduced motion | 1 | `every animation stops under reduced motion` |
| an app rule that changes is followed by its copy | 1 | `.rui-tabs matches views/settings.css .mode-toggle` |
| the pane an extension holds has no padding | 1 | `the pane an extension holds has no padding, and its frame fills it` |
| the frame paints the pane's own colour | 1 | `the frame and its document paint the pane's own colour, with no radius` |
| the frame document paints the pane's own colour | 1 | `the frame and its document paint the pane's own colour, with no radius` |
| the frame document carries the note's padding | 1 | `the frame document carries exactly the note's padding, so content lines up with note text` |
| a view can opt out to an edge-to-edge canvas | 1 | `an embedded view paints its panel's surface with no padding, and a view can opt out to full bleed` |
| the seam marks the pane full bleed | 1 | `releasing the mount removes the frame, unbinds the mediator, and a late message from the old frame is ignored` |
| the pane gets its padding back when the view goes | 1 | `releasing the mount removes the frame, unbinds the mediator, and a late message from the old frame is ignored` |
| an embedded view is built with Rundock UI | 2 | `an embedded view is built with Rundock UI, which runs before its entry`<br>`an embedded view is told so on its body, and a view opened on its own is not` |
| an embedded view is told so on its body | 1 | `an embedded view is told so on its body, and a view opened on its own is not` |
| in Chromium, a mounted view carries Rundock UI | 1 | `a view that uses the library and then leaves with the file reaches nothing, and the view ends` |
| in Chromium, the library runs before the entry | 1 | `a view that uses the library and then leaves with the file reaches nothing, and the view ends` |
| in Chromium, an embedded view carries Rundock UI | 1 | `an embedded view is built with Rundock UI before its entry runs, and told it is embedded` |
| in Chromium, the library sends no message of its own | 1 | `a frame working every component posts nothing but ready, and reaches nothing` |
| in Chromium, a failed install stops the frame before the entry runs | 1 | `a library that fails as it installs ends the view in the plain view, with the reason named` |
| the host ignores everything a frame says after it has failed | 1 | `once a frame has reported a failure, the host ignores everything it says after` |
| in Chromium, a vertical tablist moves on ArrowDown and ArrowUp | 1 | `vertical tabs: ArrowDown and ArrowUp move and select with wrapping, and the selected tab stays the one tab stop` |
| in Chromium, the option list wraps | 1 | `option list: arrows move and select, wrapping; Space checks` |
| in Chromium, Escape returns focus to the menu trigger | 1 | `menu: opens from the keyboard, moves, selects, and Escape returns focus` |
| in Chromium, focus follows a moved card | 1 | `board: a card moves between columns from its menu, and focus follows it` |
| in Chromium, the slider announces its formatted value | 1 | `slider: the arrows move it and the announced value follows` |
| in Chromium, the chip label is trimmed to its ink | 1 | `a chip label is centred on its ink, not on the font box` |
| in Chromium, the chip keeps its line-height fallback | 1 | `without text-box, the fallback keeps a chip label on a one-line box inside the chip` |
| in Chromium, the chip has a line-height fallback at all | 1 | `without text-box, the fallback keeps a chip label on a one-line box inside the chip` |
| in Chromium, the pane an extension holds has no padding | 2 | `an extension view is the pane, not a box inside it (dark)`<br>`an extension view is the pane, not a box inside it (light)` |
| in Chromium, the frame document paints the pane's own colour | 2 | `an extension view is the pane, not a box inside it (dark)`<br>`an extension view is the pane, not a box inside it (light)` |
| in Chromium, the view's first line starts where a note's does | 2 | `an extension view is the pane, not a box inside it (dark)`<br>`an extension view is the pane, not a box inside it (light)` |
| in Chromium, a view can opt out to an edge-to-edge canvas | 2 | `a view can opt out to an edge-to-edge canvas, or set its own padding (dark)`<br>`a view can opt out to an edge-to-edge canvas, or set its own padding (light)` |
| in Chromium, an embedded view paints its panel's surface | 2 | `an embedded view paints its panel's surface with no inner box (dark)`<br>`an embedded view paints its panel's surface with no inner box (light)` |
| the source scan refuses postMessage | 1 | `its source has no way out of the frame: no messages, no parent, no network, no parsed markup` |
| the source scan refuses the parent | 1 | `its source has no way out of the frame: no messages, no parent, no network, no parsed markup` |
| the source scan refuses window.top | 1 | `its source has no way out of the frame: no messages, no parent, no network, no parsed markup` |
| the source scan refuses the opener | 1 | `its source has no way out of the frame: no messages, no parent, no network, no parsed markup` |
| the source scan refuses fetch | 1 | `its source has no way out of the frame: no messages, no parent, no network, no parsed markup` |
| the source scan refuses XMLHttpRequest | 1 | `its source has no way out of the frame: no messages, no parent, no network, no parsed markup` |
| the source scan refuses WebSocket | 1 | `its source has no way out of the frame: no messages, no parent, no network, no parsed markup` |
| the source scan refuses EventSource | 1 | `its source has no way out of the frame: no messages, no parent, no network, no parsed markup` |
| the source scan refuses eval | 1 | `its source has no way out of the frame: no messages, no parent, no network, no parsed markup` |
| the source scan refuses Function | 1 | `its source has no way out of the frame: no messages, no parent, no network, no parsed markup` |
| the source scan refuses innerHTML | 1 | `its source has no way out of the frame: no messages, no parent, no network, no parsed markup` |
| the source scan refuses outerHTML | 1 | `its source has no way out of the frame: no messages, no parent, no network, no parsed markup` |
| the source scan refuses insertAdjacentHTML | 1 | `its source has no way out of the frame: no messages, no parent, no network, no parsed markup` |
| the source scan refuses dynamic import | 1 | `its source has no way out of the frame: no messages, no parent, no network, no parsed markup` |
| the source scan refuses localStorage | 1 | `its source has no way out of the frame: no messages, no parent, no network, no parsed markup` |
| the source scan refuses sessionStorage | 1 | `its source has no way out of the frame: no messages, no parent, no network, no parsed markup` |
| the source scan refuses cookies | 1 | `its source has no way out of the frame: no messages, no parent, no network, no parsed markup` |
| the source scan refuses a loaded source | 1 | `its source has no way out of the frame: no messages, no parent, no network, no parsed markup` |
| the source scan refuses a location | 1 | `its source has no way out of the frame: no messages, no parent, no network, no parsed markup` |
| every factory is in the set | 4 | `installs from its source text alone, with every factory and a version`<br>`a named native button with a decorative icon, the default 32px variant unless told`<br>`the send variant moves through empty, active and cancel, renaming itself for the stop`<br>`disabled holds the click` |
| the accepted dark exception is pinned where it was accepted | 3 | `a known shortfall is pinned at its measured ratio: it may improve, never slip`<br>`control orange clears 3:1 against every surface in both themes, and is the brand itself in dark`<br>`the white tick and thumb on control orange: 3.83:1 in light, and the accepted 2.85:1 in dark` |
| the app's resting destructive button is an outline over --elevated | 1 | `the outline button reads as destructive at rest, and never fills with the danger colour` |
| a literal in the component stylesheet is refused unless allowlisted | 1 | `the drift lint passes on the tree, and it reads rundock-ui.css` |
| the server and the library agree on the version | 1 | `Rundock.ui.version is the version the install checks against` |
| the checkbox tick is centred in its box | 1 | `the checkbox tick is centred in its box` |
| the slider thumb sits on the track centre (margin-top -6px) | 1 | `the slider thumb is centred on its track` |
| the slider track is the 4px line the thumb is centred on | 1 | `the slider thumb is centred on its track` |
| the library source never reads the bare global top | 1 | `its source never reads the bare global top, the frame's way to the window above it` |
| a newer minor is refused | 2 | `a newer minor is refused, naming both versions and what to do`<br>`a version this Rundock cannot honour is refused by name, with its own code` |
| another major is refused | 2 | `another major is refused in either direction`<br>`a version this Rundock cannot honour is refused by name, with its own code` |
| the manifest reads rundockUi exactly as declared, never trimmed | 1 | `a value is read exactly as declared: surrounding space is malformed, never trimmed into a version` |
| the manifest holds rundockUi to the rule | 2 | `a version this Rundock cannot honour is refused by name, with its own code`<br>`a value is read exactly as declared: surrounding space is malformed, never trimmed into a version` |
| the mode toggle carries the tablist role | 1 | `is a named tablist whose selected mode is the one tab stop` |
| the mode toggle roves its tab stop | 1 | `ArrowRight selects the next mode, asks the server, and keeps focus through the re-render` |
| focus survives the re-render | 1 | `ArrowRight selects the next mode, asks the server, and keeps focus through the re-render` |
