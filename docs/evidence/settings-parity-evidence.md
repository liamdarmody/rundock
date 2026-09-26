# Permissions settings: browser and desktop parity, and the red-first record

Evidence for the Keep agents inside this workspace row: that the desktop app and the browser show the same row, with the same effective state, for the same workspace, and that reverting the change turns tests red.

## Browser and desktop show the same row

Run: `npm run test:settings:electron` (test/electron/settings-parity.cjs), 2026-09-25, on darwin, Electron 42.9.3, Chromium 149.0.7827.55. Exit 0.

One temporary workspace and HOME, both surfaces at the same moment:

- **Desktop:** the shipped app itself, launched through Playwright's Electron driver with the repository root as its argument, so package.json `main` boots electron/main.js exactly as `npm run electron` does: its own preload, its own main-process handlers, its own embedded server and its own window. The only inputs are `WORKSPACE`, `HOME` and `RUNDOCK_USER_DATA_DIR` (a throwaway profile, carrying the setup marker so the first-run wizard is skipped). Before any comparison the run requires the desktop window to show the preload bridge and a storage snapshot answered by the main process; the report's `bridge` field records both.
- **Browser:** the same server.js started in browser mode as a separate process, and the page loaded in Chromium through Playwright.

For each effective state written to disk, both pages open Settings, then Permissions, the way a person does, and every field the row shows is compared: the state, the control, the captions, who controls it, the one-time notice, the folders sentence and the number of rows. The snapshot, the cases and the comparison are shared in test/helpers/settings-parity.js and proved without an engine by test/unit/settings-parity.test.js.

| Case | Desktop state | Desktop control | Browser state | Browser control | Result |
|---|---|---|---|---|---|
| Rundock's block on | On | switch-on | On | switch-on | match |
| Rundock's block off | Off | switch-off | Off | switch-off | match |
| off, with the project's settings turning it on | On | lock | On | lock | match |

Full report (the temporary workspace path elided):

```json
{
  "platform": "darwin",
  "electron": "42.9.3",
  "chromium": "149.0.7827.55",
  "bridge": { "bridge": true, "storage": true },
  "workspace": "(a temporary folder)",
  "cases": [
    {
      "case": "Rundock's block on",
      "match": true,
      "differences": [],
      "desktop": {
        "state": "On",
        "control": "switch-on",
        "captions": [
          "Agents can change files in this workspace and the temporary folders they need. Changes elsewhere are blocked.",
          "Uses macOS's built-in sandbox."
        ],
        "ownership": null,
        "notice": "Keeping agents inside this workspace is now its own switch. Yours is still on. Switching between Notes and Code won't change it.",
        "folders": "Agents can change files in these folders too. Anywhere else, changes are blocked unless you approve them.",
        "rows": 1
      },
      "browser": {
        "state": "On",
        "control": "switch-on",
        "captions": [
          "Agents can change files in this workspace and the temporary folders they need. Changes elsewhere are blocked.",
          "Uses macOS's built-in sandbox."
        ],
        "ownership": null,
        "notice": "Keeping agents inside this workspace is now its own switch. Yours is still on. Switching between Notes and Code won't change it.",
        "folders": "Agents can change files in these folders too. Anywhere else, changes are blocked unless you approve them.",
        "rows": 1
      }
    },
    {
      "case": "Rundock's block off",
      "match": true,
      "differences": [],
      "desktop": {
        "state": "Off",
        "control": "switch-off",
        "captions": [
          "Agents can change or delete files outside this workspace wherever your account allows. Your approval settings still apply.",
          "Uses macOS's built-in sandbox."
        ],
        "ownership": null,
        "notice": "Keeping agents inside this workspace is now its own switch. Yours is still off. Switching between Notes and Code won't change it.",
        "folders": "Agents can edit files in these folders without asking. Anywhere else, changes need your approval.",
        "rows": 1
      },
      "browser": {
        "state": "Off",
        "control": "switch-off",
        "captions": [
          "Agents can change or delete files outside this workspace wherever your account allows. Your approval settings still apply.",
          "Uses macOS's built-in sandbox."
        ],
        "ownership": null,
        "notice": "Keeping agents inside this workspace is now its own switch. Yours is still off. Switching between Notes and Code won't change it.",
        "folders": "Agents can edit files in these folders without asking. Anywhere else, changes need your approval.",
        "rows": 1
      }
    },
    {
      "case": "off, with the project's settings turning it on",
      "match": true,
      "differences": [],
      "desktop": {
        "state": "On",
        "control": "lock",
        "captions": [
          "Agents can change files in this workspace and the temporary folders they need. Changes elsewhere are blocked."
        ],
        "ownership": "Turned on in .claude/settings.json. Rundock's switch can't turn this off while that file turns it on.",
        "notice": "Keeping agents inside this workspace is now its own switch. Yours is still off. Switching between Notes and Code won't change it.",
        "folders": "Agents can change files in these folders too. Anywhere else, changes are blocked unless you approve them.",
        "rows": 1
      },
      "browser": {
        "state": "On",
        "control": "lock",
        "captions": [
          "Agents can change files in this workspace and the temporary folders they need. Changes elsewhere are blocked."
        ],
        "ownership": "Turned on in .claude/settings.json. Rundock's switch can't turn this off while that file turns it on.",
        "notice": "Keeping agents inside this workspace is now its own switch. Yours is still off. Switching between Notes and Code won't change it.",
        "folders": "Agents can change files in these folders too. Anywhere else, changes are blocked unless you approve them.",
        "rows": 1
      }
    }
  ],
  "pass": true
}
```

## The desktop wiring, broken on purpose

Rows in test/tools/mutate-workspace-boundary-guards.js break the shipped desktop wiring and require the parity run, or the profile resolver's unit test, to go red. Run 2026-09-25 with `node test/tools/mutate-workspace-boundary-guards.js --markdown`: all 87 rows in the harness turned a named test red, including the two desktop profile rows below.

| Guard broken | Tests red |
|---|---|
| the desktop main window loads the app's preload | `desktop: the window carries the app's preload bridge`, `desktop: the preload's storage snapshot comes back from the main process` |
| the desktop main process answers the preload's storage snapshot | `desktop: the window carries the app's preload bridge`, `desktop: the preload's storage snapshot comes back from the main process` |
| a relative RUNDOCK_USER_DATA_DIR is refused, never read against the working directory | `a relative folder is refused with its reason, never read against the working directory` |

## The desktop profile override, on the running app

The parity run above starts the desktop app on a profile of its own through `RUNDOCK_USER_DATA_DIR`. That the entrypoint really uses that folder, and really refuses a value it cannot use, is proved on the shipped app itself rather than on the text of electron/main.js.

Run: `npm run test:user-data:electron` (test/electron/user-data-entrypoint.cjs). Both cases launch the repository, so package.json `main` boots electron/main.js as `npm run electron` does. The run never launches Rundock unless its default profile location provably lives inside the throwaway HOME, so no case, and no mutation of the app under test, can touch a real profile. Every folder is new under the system temporary directory, HOME included, and the platform's other home variables point at it. Before each case a two-line probe app with no Rundock code, under its own name, asks Electron for `appData` in that environment. The answer and the throwaway HOME are compared by real path (the real path of the answer's nearest existing ancestor), because the system temporary directory is reached through a symlink and Electron and the run spell it differently; unless the answer is inside the throwaway HOME, the case stops with a named setup failure and Rundock is never launched. The default location, `appData` joined with the package name, is then checked by a read-only snapshot taken before the case and again after it (whether it exists, and each entry's relative name, type, size and mtime, recursively, listing folders and stating entries without opening any file), and the two must be identical. Nothing outside the run's own temporary folders is ever listed.

- **Absolute value:** a fresh temporary folder, set up past first run, launched through Playwright's Electron driver. The running app's `app.getPath('userData')`, read through `electronApp.evaluate`, must equal the folder exactly. While the app runs, its single-instance lock (`SingletonLock` on macOS and Linux) must be in that folder. A value written through the window's own storage bridge must land in that folder's `renderer-storage.json`. The app must reach its main window, which it does only after reading the setup marker from that folder, and nothing may change in the default profile location.
- **Relative value:** the same entrypoint with `RUNDOCK_USER_DATA_DIR=relative-profile`, from a throwaway working directory. This case spawns the Electron binary directly, because Playwright's launch rejects an app that exits during startup and discards the exit status that is being proved. The app must exit non-zero within the step bound and name the refusal. It must never print `App ready` (nothing opens a window before it), announce a window (the main window's page load or the first-run wizard), or announce the embedded server, which listens on an OS-assigned port and so is read from the entrypoint's own startup lines. Nothing may appear in `relative-profile` under the working directory, and nothing may change in the default profile location.

Each expectation that does not hold is named in the report's `failures`; the names and the reading of the startup log are proved without Electron by test/unit/user-data-entrypoint.test.js. Every step is bounded, and the whole run gives up with a named failure after 150 seconds. The run is a release-gate step beside the parity run.

Result: run 2026-09-25 as `node test/electron/user-data-entrypoint.cjs` (the command `npm run test:user-data:electron` runs), on darwin, Electron 42.9.3. Exit 0.

An excerpt of the report follows. It keeps the verdict (`failures`, `pass`) and most of the fields behind it, with their values as the run printed them. Left out here: `absolute.windowError`, `relative.exited`, `value` and `defaultExisted`, and the report's other fields (the default location shown relative to the throwaway HOME, its entry counts, the profile's and the working directory's listings, the relative case's startup lines and signal, and the app's name).

```json
{
  "platform": "darwin",
  "failures": [],
  "absolute": {
    "userData": "(exactly the RUNDOCK_USER_DATA_DIR folder)",
    "lock": "SingletonLock in the folder",
    "storage": "renderer-storage.json in the folder carries the value written",
    "defaultChanges": []
  },
  "relative": {
    "exitCode": 1,
    "seen": {
      "refusal": true,
      "ready": false,
      "window": false,
      "server": false
    },
    "relativeExists": false,
    "defaultChanges": []
  },
  "electron": "42.9.3",
  "pass": true
}
```

### Broken on purpose

Two rows in test/tools/mutate-workspace-boundary-guards.js break electron/main.js and require this run to go red.

| Guard broken | Mutation | Tests red |
|---|---|---|
| the desktop app runs on the RUNDOCK_USER_DATA_DIR folder it resolved | the `app.setPath('userData', …)` call removed | `absolute: app.getPath('userData') is exactly RUNDOCK_USER_DATA_DIR`, `absolute: the single-instance lock is taken in that folder`, `absolute: the app opens its main window on that profile`, `absolute: the app's own storage is written in that folder`, `absolute: nothing is written in the default profile location` |
| a relative RUNDOCK_USER_DATA_DIR stops the running app before a window, the server or any profile state | the `process.exit(1)` after the refusal removed, the refusal still printed | `relative: the app exits non-zero`, `relative: no window opens`, `relative: nothing is written in the default profile location` |

## Red-first

Two measurements, because after this change was rebased the range from its fork point to the landed tree holds other landed work as well.

### This change alone

On a scratch branch cut from 5f93680 holding only this change's two commits (the Permissions and Extensions change, 0039062, and these fixes), 2026-09-25:

```
node scripts/red-first.js --base 5f93680 --tests 'node --test --test-skip-pattern="the phase really executes the suites it names" "test/**/*.test.js"'
[red-first] measuring against 5f93680
[red-first] running the tests with the change
[red-first] restoring the source, keeping the tests
[red-first] PROVEN: the tests fail without the change and pass with it
```

5,562 tests passed with the change and 149 failed without it, across 27 source files and 38 test files. Every failure is one of this change's own tests, among them "set_workspace_mode toggles code/knowledge and rejects invalid modes", "the Permissions pane, rendered in either mode, names Notes and never the old label", "the mode card makes no promise about the sandbox", "a never-before-opened workspace gets the right block on its FIRST open, in either detected mode: on", the sandbox switch, status, import and row-model suites, the Extensions page and view-model suites, the contrast and class-coverage suites, and test/unit/settings-parity.test.js.

One test is skipped by name, and only here: the preflight phase test, "the phase really executes the suites it names". It fails on this branch for a reason outside the change, because the installed Claude Code CLI is 2.1.282 and this branch predates the captures retaken for it (d5ab12f). With it included the tool reports INCONCLUSIVE, since the suite does not pass with the change in place. The full suite otherwise ran as `npm test` does.

**Why this base and not the default.** With no base, the tool measures against `origin/main`, the 0.14.0 release (1dfc6b1), and from the 0.15 integration branch that reverts every change landed since the release. 5f93680 is the integration commit this change was cut from, so on a branch holding only this change the revert is exactly this change.

### The landed tree, folded into its gate record

On the landed branch, after the pre-commit gate passed, `npm run red-first -- --base 5f93680` is run on the committed tree and folds into that tree's `.precommit-gate.json` under `redFirst`. On that branch the range 5f93680..HEAD holds five commits: this change's own two (0039062 and these fixes) and three other landed commits, d5ab12f (the runtime captures retaken on 2.1.282), c0f8896 (the one-action-one-request guards) and 1176ad0 (the editable Rundock UI table). The revert therefore takes all of them away, and the failures it records include those changes' tests (the table's editable-cell tests, the capture scrubber's personal-data tests) beside this change's own, which are named among them: the sandbox switch, status, import and row-model suites, the Permissions pane, the Notes label guard, the Extensions page, and the contrast suites.

Measured on the tree before this correction (24eb664, the same code with the earlier wording of this section): PROVEN, base 5f93680, 5,600 tests passed with the change and 184 failed without it. The record for the landed tree carries its own counts.
