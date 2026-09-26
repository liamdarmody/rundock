# Rundock UI: what is claimed, and what proves it

Rundock UI is the component library the host injects into every extension frame (`docs/RUNDOCK-UI.md`). This maps each claim to the check that observes it. The unit suite runs under jsdom, which enforces neither sandbox flags nor Content-Security-Policy, so every claim about the frame's confinement is also observed in real engines: Chromium (`test/e2e/extension-confinement.spec.js`, part of the e2e step) and the shipped Electron (`test/electron/confinement.cjs`, a release gate step). Visual claims are measured off real screenshots or glyph metrics in Chromium, never described.

## The library widens nothing

| Claim | Observed by |
|---|---|
| The library runs in the frame, as the frame, and every frame the host builds carries it before the extension's own code runs | Every confinement run in both engines: before the fixture's first statement the frame builds one of every component and reports the library's version, that every factory built, and that the injected stylesheet styled them, and the run fails otherwise (`test/helpers/confinement-harness.js`, `rundockUiProbe`). Unit: the frame document run for real (`test/unit/rundock-ui-frame.test.js`) |
| It adds no message type and sends no message | Both engines: a view that works every component, before and after `init`, sends nothing but `ready` and reaches nothing (`test/fixtures/hostile/every-component.js`). Unit: the library's source contains no `postMessage`, and the host's table matches `docs/EXTENSION-HOST.md` |
| It cannot reach the parent, the network, storage or parsed markup | Unit: a scan of the exact source text the host inlines, including the bare global `top` with comments and strings blanked and the scan proved on specimens that must and must not match, and a label containing markup renders as text (`test/unit/rundock-ui.test.js`); a mutation row adds a bare `top` read and the scan goes red |
| Injection leaves the frame's policy and sandbox as they were | Both engines: every confinement run, including a view that uses the library and then leaves with the file, which reaches nothing and is ended (`test/fixtures/hostile/ui-then-leave.js`). Unit: the policy text is the same with and without the library |
| It is in every frame: a mounted view, an embedded view and a region renderer | Both engines: an embedded view carries the library before its entry runs and is told it is embedded; the region run carries it too. Unit and mutation: a row removes the injection from each builder, the embedded view's included, and a named test goes red |
| A failure inside it ends in the plain view with the reason named, and nothing after it runs | A library that fails to install stops the frame's document (`window.stop()`), so the extension's entry never runs, and reports the failure; the host ignores everything a frame says once it has reported one. Both engines: a library served broken by the harness, as a control, ends the view with its reason, and the frame says exactly one thing, the error, with no ready and no open; a view that misuses a component is ended with the library's own refusal. Unit: after a reported failure, a ready, an open, a save and a second error from the same frame change nothing |

## Components, contrast and styles

| Claim | Observed by |
|---|---|
| Every component's states, events and accessibility wiring | `test/unit/rundock-ui.test.js`, installed from the exact text a frame gets |
| Tabs, the option list, the slider, the menu and board moves work from the keyboard | Real key presses inside sandboxed frames on the gallery the app serves, including a vertical tablist driven with ArrowDown and ArrowUp (`test/e2e/rundock-ui-gallery.spec.js`) |
| The checkbox tick, the slider thumb and a chip's label are centred | Pixels and glyph metrics in Chromium (`test/e2e/rundock-ui-gallery.spec.js`). Mutation rows break the tick's centring, the thumb's offset and the track's height, and each turns the named pixel check red: the harness runs that one Chromium test for those rows |
| Without text-box, a chip label falls back to a one-line box | Chromium: the one `@supports` trim rule is taken out of the stylesheet the host injected, which is what an engine without text-box sees, and the shipped fallback (`.rui-chip-label { line-height: 1 }`) sets the label's line box to its font size with the ink within 0.75px of centre; no inline style stands in for it. Mutation rows change the fallback and remove it, and the named test goes red for each |
| Every colour pairing clears its bar in both themes, or is a pinned shortfall; the two-orange rule; the accepted dark exception | Computed from `tokens.css` and `rundock-ui.css` on every run (`test/unit/rundock-ui-contrast.test.js`) |
| Components copy the app's own rules, and the copies hold | `test/unit/rundock-ui-parity.test.js` |

## Full-bleed views

| Claim | Observed by |
|---|---|
| The pane an extension holds has no padding and the frame spans it edge to edge and top to bottom | The real app, both themes, with a claimed view written into the e2e server's own temporary workspace: pane and frame edges and width equal, the pane's padding 0, the frame at least the pane's height though the view asked for less (`test/e2e/full-bleed.spec.js`) |
| No colour seam between the view and the pane | The same run: the frame and a plain note's pane paint identical pixels at the same point, and a changed frame document colour fails it |
| The view's text starts where a note's does | The same run: the view's first line and a plain note's first line at the same x |
| A view can opt out to an edge-to-edge canvas, or set its own padding | The real app, both themes: a view that adds `rundock-full-bleed` to its body has no body padding and starts at the frame's own corner, and one that sets its own padding starts exactly where it asked, with the frame filling the pane in both (`test/e2e/full-bleed.spec.js`) |
| An embedded view paints its panel with no inner box | The real app, both themes: the embedded document is told it is embedded, has no padding, paints the panel's surface to its edges, the frame has no border, radius or padding, starts at the panel body's content edge, and paints the same pixels as the panel beside it (`test/e2e/full-bleed.spec.js`) |

## Versioning and mutation coverage

The install-time version rule is `test/unit/rundock-ui-manifest.test.js`, which also refuses a declared version with surrounding whitespace, read exactly as declared.

Every criterion that is a guard in the code, and the gallery page's frame policy, has a row in `test/tools/mutate-rundock-ui-guards.js` that breaks it and requires a named test to go red, and the harness fails if one does not. Rows for claims proved in a real engine run the named Chromium test itself (the injection in a mounted and an embedded view, the library's order, a message of its own, a failed install stopping the frame, the vertical tablist, the option list, the menu, the board, the slider, the chip's trim and its fallback, the pane padding, the frame document's colour, the first line, the opt-out and the embed surface); the source scan has a row per forbidden primitive. The recorded run, every row and the tests it turned red, is [rundock-ui-mutation-run.md](rundock-ui-mutation-run.md). `test/unit/rundock-ui-mutation-coverage.test.js` checks the coverage the harness cannot see about itself: each row names the criteria it guards, the three criteria areas hold every criterion between them and every criterion in each that is a guard in the code has a row (the documentation, the separate starter repository and this check itself say why they have none), the gallery policy row maps to its criterion, every criterion proved in a real engine has a row that runs one, every named test exists, and the harness is in `mutate:guards:all` and seen by the gate's selector.
