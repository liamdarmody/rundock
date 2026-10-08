# The browser pass

**A change to anything a person can see is not done until the machine has driven it in a browser.** Sent the prompts a user would send, read what came back, and looked at the screen. Manual testing confirms rather than discovers.

## Why this exists

Measured across 0.13.3: twelve defects. Four were found by the suite or a gate. **Eight were found by one person noticing that something on screen looked odd.** Twice as much test code as product code shipped in that release, a suite of 4,333 tests, ten gate runs and twelve CI runs, and the majority of real defects were still found by eye.

Browser tooling was available the entire time and was used once, for a CSS measurement, which immediately found a real defect. A four-minute browser pass over the already-shipped release found two more.

Each missed defect became a field report, an investigation, a fix, a gate cycle and a re-test. Looking first collapses that whole chain.

## What the e2e suite does not cover, and cannot

`test/e2e/serve.js` seeds a disposable workspace, points `HOME` at a fake home, and puts a **stub runtime** first on `PATH` so no real agent is ever spawned. That is correct for a hermetic suite and it is why the e2e specs are fast and deterministic.

It also means the e2e suite structurally cannot see:

- permission cards, their wording, their buttons, or which folder they offer
- what an agent says about the product, including claims about what the product will and will not do
- anything that depends on a real workspace, a real home directory, or real credentials
- anything about the first screen a person sees before they open a workspace

Every one of those categories produced defects in 0.13.3. Adding e2e specs would not have caught them. The gap is a live pass, not more fixtures.

## Running one

```bash
npm run look                 # serves this branch on the first free port, prints the URL
```

Nothing gates this and nothing needs to. The local gate takes seconds and CI does the rest, so run them alongside, not in front:

```bash
npm run precommit
```

Then drive the real interface at that URL. For a single screen, a screenshot is often enough: see [Look at one view](#look-at-one-view) below. Not the classifier, not the HTTP payload, not a unit test standing in for the screen: **the surface whose wording the claim names.** A proxy one layer in is the failure mode this project has paid for five times in one release.

## Look at one view

One command takes one screenshot of one view of this checkout, so a coding agent (or a person) can check a visible change without starting the app by hand. It builds the sanitized demo workspace from `scripts/screenshots/`, serves this checkout's code against it with a fake home directory and the stub runtime first on `PATH` (no real agent, no routine that runs for real), takes the picture, prints its path, and stops everything it started. It is contributor tooling and is not part of the desktop build.

Run it from the checkout root:

```bash
npx playwright test --config scripts/screenshots/look-view.config.mjs
```

It reads its options from `.rundock/look-view.json` in the checkout (gitignored). With no file it takes the team chart, dark, at 1440 by 900. Every option is optional:

| Option | Default | Meaning |
| --- | --- | --- |
| `view` | `team` | `team`, `conversations`, `files`, `routines`, `settings`, `skills`, `map` or `pins` |
| `file` | `Welcome.md` | files view: the file to open, relative to the demo workspace |
| `conversation` | none | conversations view: a conversation to open, by title or id |
| `section` | `workspace` | settings view: `workspace`, `permissions`, `connectors`, `packages`, `extensions`, `appearance` or `about` |
| `skill` | none | skills view: a skill to open, by name or id |
| `theme` | `dark` | `dark` or `light` |
| `width`, `height` | `1440`, `900` | the viewport, in CSS pixels |
| `scale` | `1` | device pixel ratio, 1 to 3 |
| `element` | none | a CSS selector: photograph only that element |
| `actions` | none | steps to take after the view opens, in order (below) |
| `arrived` | `false` | `true` opens the demo workspace as one copied in from elsewhere, so its routines are held and the strip naming them shows |
| `out` | `.rundock/scratch/look-view.png` | where the PNG goes, relative to the checkout or absolute |

Each action is one of `{"click": T}`, `{"fill": T, "value": "text"}`, `{"press": "Escape"}` or `{"waitForText": "Saved"}`, where `T` names an element as a CSS selector string, `{"role": "button", "name": "Save"}`, `{"text": "Plan the week"}`, `{"label": "Name"}` or `{"selector": "#x"}`.

For example, the permissions settings in light at a narrow width:

```json
{
  "view": "settings",
  "section": "permissions",
  "theme": "light",
  "width": 420,
  "height": 900,
  "out": ".rundock/scratch/permissions-narrow.png"
}
```

Or a board with its new-card field open:

```json
{
  "view": "files",
  "file": "Backlog.md",
  "actions": [{ "click": { "text": "+ Add a card" } }]
}
```

A mistake fails with one plain sentence naming it: an unknown view, option, file, conversation, settings section or skill lists what exists, and an element an action cannot find is named with the action's position. When an action fails, the screen at that moment is saved beside the output as `<name>.failed.png`.

**In a sandboxed agent shell, run the command bare.** Change into the checkout in its own step first, then run `npx playwright test --config scripts/screenshots/look-view.config.mjs` on its own, with no `cd … &&`, pipe, redirect or `VAR=` prefix. A compound command may fall outside the sandbox's allowances, and the browser then fails to start. Write the options file with your file tool rather than an `echo` redirect, for the same reason. Where the shell's working directory resets between calls, write `{"cwd": "<checkout>", "argv": ["npx", "playwright", "test", "--config", "scripts/screenshots/look-view.config.mjs"]}` to a file and run `node <checkout>/scripts/exempt-run.js <file>` bare instead; it runs only commands the sandbox exclusions already name. `scripts/command-shape.js`, installed as a `PreToolUse` hook on Bash, refuses the wrapped shapes before they run and prints both forms.

## What to cover

Derived from where defects actually came from, not from a guess. Each one is recorded with the surface it was found at, so this list is maintained from evidence rather than from taste.

1. **The change itself**, driven as a user would drive it, including the path that is awkward rather than the one that is convenient.
2. **The first screen**, before opening anything. Two escapes lived here: a recent-workspaces list with eight of ten slots filled by test fixtures, and a caption describing a list it no longer matched.
3. **Permission cards**, if the change touches the permission layer at all. Read the card's full text, every button, and the folder any standing grant would name. Approve one and check what it actually granted.
4. **What the agent says about the product.** Ask it to do the thing the change is about and read the reply. Four defects in 0.13.3 were the product stating something untrue about itself, and an agent will repeat that to a user with the product's authority.
5. **The shipped artefact**, for anything release-shaped. Every check was green while the tag pointed two days behind main, because no check was looking at the artefact.

## Two ways a pass invents defects that are not there

Both of these cost real time on the first pass, and both produce a finding that looks solid until it is checked.

**The environment the server runs in is not the environment a user's server runs in.** Pinning a file appeared to be completely broken: the control did nothing, the list stayed empty, and `pin_file` returned no reply at all while `get_pins` answered normally. The cause was the automation sandbox refusing the write to the file the design puts pins in, which at the time was under the home directory. With a writable home it works and persists. Before reporting anything the product "cannot" do, read the server log: the EPERM was sitting in it the whole time. A finding that the product is broken is worth ten minutes of checking that the harness is not.

**An automated tab is usually backgrounded, and Chrome throttles `requestAnimationFrame` to nothing there.** Anything the view redraws on a frame is therefore frozen: canvas contents, and any readout written during the draw. A filter applied through the console changed nothing on screen, which reads exactly like a missing feature and was not. Check `document.visibilityState` before believing any of it. **Frame-timing criteria cannot be discharged this way at all** and need a real foreground window, so a performance criterion is recorded as not covered by the pass rather than quietly skipped.

The general form: when the screen disagrees with the criteria, establish whether the harness or the product is responsible, and say which. Confirm the classification with the product's own model rather than a reimplementation. A count computed by hand from the API said 4,298 unlinked files where the product said 1,774, and the product was right: the hand count matched link endpoints that the model resolves differently. Two of the first pass's candidate defects came from trusting that number.

## Recording what it finds

Every defect gets recorded when it is found, with three things: what it was, which surface it was found at, and **who found it**. The last is the one that matters. A defect found by a person using the product escaped; a defect found by the machine did not.

That number is the point. A pass that finds nothing and records nothing is indistinguishable from a pass nobody ran, and the escape rate is what tells the two apart over a release rather than on the day.

**Baseline to beat, from 0.13.3:** escape rate 0.57, median report-to-verifiable-fix 16.5 minutes.
