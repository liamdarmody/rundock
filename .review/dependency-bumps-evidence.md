# Evidence: bring the shell and its two advisories current

Recorded here because a reviewer sees the change and nothing else. Every
measurement below names the command that produces it, from a clone, so nothing
here asks you to take a number on trust.

The acceptance criteria this was judged against live outside this repository,
so each one is quoted in full rather than cited by number.

**What this change is allowed to be.** A version change and a verification, not
a refactor. No product code is touched: the diff is `package.json`,
`package-lock.json`, one user-facing entry in `CHANGELOG.md`, and this file.
Nothing in the bump required a source change, so nothing was absorbed quietly.

**On the size of the diff.** The lockfile moves about 2,100 lines. That is three
version decisions and their mechanical fanout, not 2,100 decisions. The three
decisions are in the table below and in `package.json`, which moves two lines.

## The three versions

| What | Where declared | Before | After |
|---|---|---|---|
| The shipped browser engine | `package.json` devDependency `electron` | `^42.7.0`, lockfile pinned `42.7.0` | `42.9.3`, pinned exactly |
| The updater's parser | transitive, `electron-updater` -> `js-yaml` (`^4.1.0`) | `4.3.0` | `4.3.1` |
| The redirect helper on the publish path | transitive, `electron-builder` -> `app-builder-lib` -> `electron-publish` -> `builder-util-runtime` | `9.5.1` | `9.7.0` |

The third is reached by moving `electron-builder` itself, since
`builder-util-runtime` is pinned exactly by every package in that chain and
cannot be moved on its own:

    electron-builder  26.8.1 -> 26.15.7   (package.json range ^26.0.0 -> ^26.15.7)

Reproduce the resolved versions:

    npm ci
    npm ls electron js-yaml builder-util-runtime

Resolved positions before this change, which is the detail the card turns on:

    builder-util-runtime@9.5.1   <- electron-builder (the publish path)
    builder-util-runtime@9.7.0   <- electron-updater (the production tree)

The production tree already had the fixed helper. The build and publish tooling
did not. That is why the audit run with `--omit=dev` showed only one finding
while the full run showed the helper as well.

## AC-1 to AC-4: the audit, before and after

> **AC-1:** The shipped engine is current within its major.

`42.9.3` is the newest release of the 42 line. Checked against the registry,
not against a changelog:

    npm view electron versions --json | grep '"42\.'
    -> ... 42.7.0 42.7.1 42.8.0 42.8.1 42.9.0 42.9.1 42.9.2 42.9.3

`43.4.1` exists and was deliberately not taken. The criterion says current
within its major, and a major bump of the engine is not a bump, it is a
migration with its own release notes and its own card.

> **AC-2:** The advisory on the updater's parser is cleared.

`GHSA-5p4m-2wfm-xmqj`, quadratic CPU consumption in `!!omap` resolution.
Advisory range `>= 4.0.0, < 4.3.1`, first patched `4.3.1`. `electron-updater`
declares `js-yaml: ^4.1.0`, so `4.3.1` is reached by the lockfile alone with no
override needed, and a future clean resolve cannot fall back below it because
`4.3.1` is the newest 4.x.

> **AC-3:** The redirect-handling helper on the publish path is current.

`9.7.0` is the newest release of `builder-util-runtime`
(`npm view builder-util-runtime version` -> `9.7.0`).

This one is stronger than the card that raised it assumed. The card described it
as "a version behind on a credential-handling library" and "not currently
exploitable". It is in fact a published advisory, `GHSA-p2f4-r6v6-j797`,
`builder-util-runtime < 9.7.0`, severity high, and it appears in the full audit
run below. The card's judgement of the impact on THIS app still holds, and the
reason is worth writing down rather than leaving as a version number.

Read out of the two shipped copies in `node_modules`, which is the artifact that
actually runs:

`9.5.1`, `out/httpExecutor.js`, `prepareRedirectUrlOptions`:

    if (headers?.authorization) {
      if (HttpExecutor.isCrossOriginRedirect(originalUrl, parsedRedirectUrl)) {
        delete headers.authorization
      }
    }

One header, matched by exact lowercase key. `9.7.0` replaces that with a
normalised lookup against a set of nine: `authorization`, `proxyauthorization`,
`privatetoken`, `xapikey`, `xauthtoken`, `xaccesstoken`, `xgitlabtoken`,
`cookie`, `xcsrftoken`, matched case- and separator-insensitively, and adds
hashing of sensitive values in debug output.

**Effect on this app.** The publish path here is the GitHub provider, and the
GitHub provider sets the header through `configureRequestOptions`, which writes
the key as lowercase `authorization` (`out/httpExecutor.js:460` in `9.5.1`). The
one header `9.5.1` does strip is therefore exactly the one this app sets, so the
release token was not being forwarded across a cross-origin redirect before this
change. The advisory's reproduced path is the GitLab flow, which sets
`PRIVATE-TOKEN` or a mixed-case `Authorization`, and this app does not use it.
What the bump buys is the removal of a class rather than the closing of a live
hole: the strip no longer depends on the casing a caller happened to choose.

> **AC-4:** No advisory remains in the production tree, or each remaining one is
> named with why it stays.

The production tree is clean. The full tree has one left, named below.

### Before

    $ npm audit --omit=dev

    # npm audit report

    js-yaml  4.0.0 - 4.3.0
    Severity: high
    JS-YAML: Quadratic CPU consumption in !!omap resolution (3.x and 4.x) -- CVE-2026-59870 fix not backported - https://github.com/advisories/GHSA-5p4m-2wfm-xmqj
    fix available via `npm audit fix`
    node_modules/js-yaml

    1 high severity vulnerability

    To address all issues, run:
      npm audit fix

    $ npm audit

    # npm audit report

    app-builder-lib  <=26.14.0
    Severity: high
    electron-updater: Uncontrolled search path elements within `AppImage` built by `app-builder-lib` - https://github.com/advisories/GHSA-7g7r-gx96-252g
    Depends on vulnerable versions of builder-util
    Depends on vulnerable versions of builder-util-runtime
    Depends on vulnerable versions of dmg-builder
    Depends on vulnerable versions of electron-builder-squirrel-windows
    Depends on vulnerable versions of electron-publish
    fix available via `npm audit fix`
    node_modules/app-builder-lib
      dmg-builder  2.0.0 - 26.14.0
      Depends on vulnerable versions of app-builder-lib
      Depends on vulnerable versions of builder-util
      node_modules/dmg-builder
        electron-builder  19.25.0 || 19.28.0 - 26.14.0
        Depends on vulnerable versions of app-builder-lib
        Depends on vulnerable versions of builder-util
        Depends on vulnerable versions of builder-util-runtime
        Depends on vulnerable versions of dmg-builder
        node_modules/electron-builder
      electron-builder-squirrel-windows  19.28.0 - 26.14.0
      Depends on vulnerable versions of app-builder-lib
      Depends on vulnerable versions of builder-util
      node_modules/electron-builder-squirrel-windows

    brace-expansion  <=1.1.17 || 2.0.0 - 2.1.3 || 4.0.0 - 5.0.8
    Severity: high
    brace-expansion: DoS via exponential-time expansion of consecutive non-expanding {} groups - https://github.com/advisories/GHSA-3jxr-9vmj-r5cp
    brace-expansion: DoS via exponential-time expansion of consecutive non-expanding {} groups - https://github.com/advisories/GHSA-3jxr-9vmj-r5cp
    brace-expansion: DoS via unbounded expansion length causing an out-of-memory process crash - https://github.com/advisories/GHSA-mh99-v99m-4gvg
    brace-expansion: DoS via unbounded expansion length causing an out-of-memory process crash - https://github.com/advisories/GHSA-mh99-v99m-4gvg
    brace-expansion: DoS via unbounded expansion length causing an out-of-memory process crash - https://github.com/advisories/GHSA-mh99-v99m-4gvg
    brace-expansion: DoS via unbounded intermediate arrays, bypassing the CVE-2026-14257 mitigation - https://github.com/advisories/GHSA-rgw5-rvv9-x895
    brace-expansion: DoS via unbounded intermediate arrays, bypassing the CVE-2026-14257 mitigation - https://github.com/advisories/GHSA-rgw5-rvv9-x895
    brace-expansion: DoS via unbounded intermediate arrays, bypassing the CVE-2026-14257 mitigation - https://github.com/advisories/GHSA-rgw5-rvv9-x895
    fix available via `npm audit fix`
    node_modules/@electron/asar/node_modules/brace-expansion
    node_modules/@electron/universal/node_modules/brace-expansion
    node_modules/brace-expansion
    node_modules/cacache/node_modules/brace-expansion
    node_modules/dir-compare/node_modules/brace-expansion
    node_modules/filelist/node_modules/brace-expansion
    node_modules/glob/node_modules/brace-expansion

    builder-util-runtime  <9.7.0
    Severity: high
    electron-updater: Cross-origin redirect leaks `PRIVATE-TOKEN` and mixed-case `Authorization` credentials in `builder-util-runtime` - https://github.com/advisories/GHSA-p2f4-r6v6-j797
    fix available via `npm audit fix`
    node_modules/builder-util-runtime
      builder-util  2.0.0 - 25.0.6 || 25.1.2 - 26.14.0
      Depends on vulnerable versions of builder-util-runtime
      node_modules/builder-util
      electron-publish  19.28.0 - 25.0.6 || 25.1.2 - 26.14.0
      Depends on vulnerable versions of builder-util
      Depends on vulnerable versions of builder-util-runtime
      node_modules/electron-publish

    ip-address  <=10.3.0
    Severity: high
    ip-address: Address4 decodes leading-zero octets as decimal while resolvers decode them as octal, allowing SSRF and trust-boundary bypass - https://github.com/advisories/GHSA-mwp4-54f8-5fhr
    ip-address: a CIDR suffix on the parsed address suppresses special-use classification and can bypass SSRF and trust-boundary checks - https://github.com/advisories/GHSA-4xrf-jv44-h6hh
    ip-address: misclassification of IPv4-mapped/NAT64 IPv6 addresses can bypass SSRF and trust-boundary checks - https://github.com/advisories/GHSA-22jq-vg5j-6vgg
    fix available via `npm audit fix`
    node_modules/ip-address

    js-yaml  4.0.0 - 4.3.0
    Severity: high
    JS-YAML: Quadratic CPU consumption in !!omap resolution (3.x and 4.x) -- CVE-2026-59870 fix not backported - https://github.com/advisories/GHSA-5p4m-2wfm-xmqj
    fix available via `npm audit fix`
    node_modules/js-yaml

    tar  <=7.5.20
    Severity: high
    node-tar: Uncontrolled recursion in mapHas/filesFilter allows uncatchable stack-overflow DoS via crafted long-path tar with member selection - https://github.com/advisories/GHSA-r292-9mhp-454m
    fix available via `npm audit fix`
    node_modules/tar

    undici  7.0.0 - 7.28.0
    Severity: high
    undici vulnerable to downstream response desynchronization via retry interceptor - https://github.com/advisories/GHSA-8xcm-r25x-g524
    undici vulnerable to cross-user information disclosure and parse-time crash via degenerate private cache directives - https://github.com/advisories/GHSA-4cwx-7wf7-3272
    undici vulnerable to CRLF Injection via blob-like body 'type' property - https://github.com/advisories/GHSA-m8rv-5g2x-5cg5
    undici vulnerable to cross-user information disclosure via whitespace around equals in Cache-Control directives - https://github.com/advisories/GHSA-jr45-8vmc-qm54
    undici vulnerable to cookie attribute injection via unsanitized domain and unparsed setCookie fields - https://github.com/advisories/GHSA-v3r7-h72x-cjcm
    fix available via `npm audit fix`
    node_modules/undici

    12 high severity vulnerabilities

    To address all issues, run:
      npm audit fix

### After

    $ npm audit --omit=dev

    found 0 vulnerabilities

    $ npm audit

    # npm audit report

    undici  7.0.0 - 7.28.0
    Severity: high
    undici vulnerable to downstream response desynchronization via retry interceptor - https://github.com/advisories/GHSA-8xcm-r25x-g524
    undici vulnerable to cross-user information disclosure and parse-time crash via degenerate private cache directives - https://github.com/advisories/GHSA-4cwx-7wf7-3272
    undici vulnerable to CRLF Injection via blob-like body 'type' property - https://github.com/advisories/GHSA-m8rv-5g2x-5cg5
    undici vulnerable to cross-user information disclosure via whitespace around equals in Cache-Control directives - https://github.com/advisories/GHSA-jr45-8vmc-qm54
    undici vulnerable to cookie attribute injection via unsanitized domain and unparsed setCookie fields - https://github.com/advisories/GHSA-v3r7-h72x-cjcm
    fix available via `npm audit fix`
    node_modules/undici

    1 high severity vulnerability

    To address all issues, run:
      npm audit fix

Both runs on 2026-08-23. An audit is a reading of a feed, so the "before" column
is reproducible only from this file, which is why it is here in full rather than
described.

**One character was changed in the quoted output, and only one.** The js-yaml
advisory title as npm prints it contains an em dash, which this repository's own
`check:refs` step refuses in tracked files. It appears above as two hyphens, in
both the production and the full run. Nothing else in either block is altered:
no wrapping, no elision, no reordering. Noted rather than done quietly, because
evidence a reader cannot trust to be verbatim is not evidence.

Twelve findings to one. Five of them (`app-builder-lib` and its four dependants,
`brace-expansion`, `builder-util-runtime`, `ip-address`, `tar`) were cleared by
the single `electron-builder` move, which is more than the card that raised it
expected from "a one-line fix riding along".

### The one that stays, and why

`undici 7.28.0`, high, five advisories, fixed in `7.29.0`.

It reaches the tree twice, both dev-only:

    electron@42.9.3 -> @electron/get@5.0.0 -> undici@7.28.0
    jsdom@29.1.1 -> undici@7.28.0

It is not in the production tree, which is why `npm audit --omit=dev` reports
zero. `@electron/get` uses it to fetch the engine zip from a known host during
packaging; `jsdom` pulls it in for the unit suite's DOM. All five advisories are
about behaving as an HTTP cache or a retrying proxy in front of untrusted
upstreams: response desynchronisation via the retry interceptor, cache-directive
parsing, cookie attribute injection. None of that describes fetching one signed
artifact from one known origin, or a test-only DOM.

It is not fixed here for a reason worth stating rather than assuming. `jsdom`
declares `undici: ^7.25.0`, so `7.29.0` is inside the range and a lockfile line
would clear it. That would be a fourth version change in a card that scoped
three, and the criterion asks for the production tree, which is clean. Named
here, and worth its own line on the board rather than absorbed into this diff.

## AC-5 and AC-6: that it still works

> **AC-5:** The app boots.
> **AC-6:** The packaged smoke gate passes.

One run covers both. `scripts/smoke-packaged.mjs` builds an unpacked app with
`electron-builder --mac --dir`, launches the real packaged binary, and requires
the boot marker that `electron/main.js` prints after modules load, the embedded
server starts and the window is created.

    $ node scripts/smoke-packaged.mjs

    smoke-packaged: building unpacked app (electron-builder --mac --dir, unsigned)
      • electron-builder  version=26.15.7 os=25.4.0
      • loaded configuration  file=package.json ("build" field)
      • executing @electron/rebuild  electronVersion=42.9.3 arch=arm64 buildFromSource=false
      • installing native dependencies  arch=arm64
      • completed installing native dependencies
      • packaging       platform=darwin arch=arm64 electron=42.9.3
      • downloaded      label=electron progress=100%
      • downloaded electron zip extracted successfully
      • searching for node modules  pm=npm
    [afterPack] packaged-contents gate: codex.js, search.js, permission-routing.js,
      lib/delegation/markers.js, lib/delegation/handback.js, lib/delegation/state.js,
      lib/config.js, lib/agents/discovery.js, lib/agents/prompt.js,
      lib/workspace/boundary.js, lib/workspace/analysis.js, lib/workspace/scaffold.js,
      lib/store/persistence.js, lib/store/transcripts.js, lib/signals.js,
      lib/scheduler.js, lib/runtime/claude.js, lib/runtime/codex-glue.js,
      lib/http-router.js, lib/delegation/engine.js, lib/protocol/handlers/index.js
      all present in app.asar
    [afterPack] Stripping extended attributes from .../Rundock.app
      • skipped macOS application code signing  reason=, see https://electron.build/code-signing CSC_IDENTITY_AUTO_DISCOVERY=false
    smoke-packaged: deep ad-hoc re-sign for a consistent throwaway bundle
    smoke-packaged: launching .../Rundock.app/Contents/MacOS/Rundock
    [Electron] App ready
    [Electron] Checking for Claude Code...
    [Electron] Starting server...

      Rundock running at http://localhost:54111
      Reachable from this machine only: Rundock listens on loopback by default.
      No workspace set. Waiting for workspace selection.

    [Electron] Server running on port: 54111
    [Electron] Loading http://localhost:54111
    [Electron] Ready
    [Electron] Smoke test OK
    smoke-packaged: PASS: packaged app booted, served, and shut down cleanly.

Absolute paths and the machine-local temp directory are elided. Nothing else is.

**What this run does not cover.** macOS arm64 only. The Windows `nsis` and
`portable` targets and the Linux targets are not built on this machine, and two
of the `electron-builder` releases in the span touch the NSIS installer
(26.15.6) and the Windows executable rebuild (26.8.2). CI is where those are
exercised, and this note is here so a reader does not read a green macOS smoke
as a green Windows one.

## AC-7: the release notes, and the span actually read

> **AC-7:** Anything behavioural in the release notes between the old and new
> versions is read and its effect on this app stated, including "nothing
> applies" where that is the answer.

### electron, span 42.7.0 -> 42.9.3

Seven releases, every one read in full: `v42.7.1`, `v42.8.0`, `v42.8.1`,
`v42.9.0`, `v42.9.1`, `v42.9.2`, `v42.9.3`
(`gh release view v42.9.3 --repo electron/electron --json body`).

The reason this bump is tagged to this release is the parser, not the API.
**Five** of the seven carry a Chromium, V8, ANGLE or Skia backport line, and
between them they carry six such lines, which is where an earlier draft of this
paragraph got the count wrong:

- `42.7.1`: "Backported fixes from upstream Chromium and V8" (#52395)
- `42.9.0`: "Backported fixes from upstream ANGLE, Chromium and V8" (#52664)
- `42.9.1`: two lines, "Backported fixes from upstream ANGLE, Chromium, Skia and
  V8" (#52706) and "Backported fixes from upstream Chromium and V8" (#52785)
- `42.9.2`: "Backported fixes for 542224257, 542025190" (#52843), two Chromium
  bug IDs
- `42.9.3`: "Backported fix for 524628213" (#52869)

The two that carry none are `42.8.0` and `42.8.1`. `42.8.0` is a Linux
`meminfo` addition, a macOS background-throttling fix and a Windows fix for ICO
files loaded from an asar leaving temporary files behind. `42.8.1`'s
engine-adjacent change is the Node.js bump to v24.18.1, which is the main
process rather than the renderer, so it is not a backport to the parser this
card cares about.

The card before this one closed six ways for agent output to become script in
the markdown renderer, and that renderer hands its output to this engine. Those
backport lines are the whole point of shipping 42.9.3 rather than 42.7.0 in a
release that increases how much unattended agent output flows through it.

Behavioural items and what each does to this app:

- **42.9.2, windows opened by a sandboxed top-level frame now inherit the
  opener's sandbox restrictions.** Does not apply. `electron/main.js:754` sets a
  `setWindowOpenHandler` that calls `shell.openExternal(url)` and returns
  `{ action: 'deny' }`, so no child window is ever created.
- **42.9.2, `<webview>` and `window.open` now inherit `nodeIntegrationInWorker`
  from the embedder.** Does not apply, same reason, and there is no `<webview>`
  anywhere in the tree.
- **42.9.2, `registerFileProtocol` and `registerHttpProtocol` now return opaque
  responses to cross-origin `no-cors` fetches.** Does not apply. The renderer is
  served over `http://localhost` by the embedded server
  (`electron/main.js:733`, `loadURL`); no custom protocol is registered
  anywhere.
- **42.9.2, crash resolving a path inside a malformed ASAR with cyclic link
  entries.** Does not apply as a threat. The app opens exactly one asar, its
  own, produced by its own build.
- **42.8.1, `Dirent.parentPath` was `undefined` for `fs.readdir` with
  `withFileTypes: true` inside an asar.** Does not apply. The app does read
  directories inside the asar (`lib/workspace/scaffold.js`), but no code reads
  `.parentPath` off a `Dirent`. The three `parentPath` hits in the tree
  (`public/file-tree-diff.js`, `public/views/files.js`) are local function
  parameters in browser code with no relation to the Node API.
- **42.8.1, Node.js in the main process updated to v24.18.1.** Applies, and is
  the one item here with real reach: every `lib/` module runs on it. The
  packaged smoke boots on it and the suite passes.
- **42.8.1, UAF in `protocol.registerStreamProtocol` when an error is emitted
  during a read.** Does not apply; not used.
- **42.8.1, asar integrity failure messages now name the failing entry.** No
  behaviour change, better diagnostics if `disableAsarIntegrity` ever bites.
- **42.9.3, memory leak when creating `BrowserWindow`s.** Applies weakly. This
  app creates at most two windows (the wizard and the main window), so the leak
  was bounded; the fix is free.
- **42.9.3, on Windows the process could fail to exit after `app.quit()` while a
  `shell.openExternal` or `shell.openPath` call was still waiting on a system
  "Open with" dialog.** Applies. `electron/main.js` calls `shell.openExternal`
  in three places, one of them from the window-open handler above, and this app
  does quit on window close. A hung Windows process on quit is a shape a user
  would report as "it will not close". Worth having.
- **42.9.3, reduced idle main-process CPU wakeups from Node timers and
  immediates.** Applies as a straight improvement to an app that idles in a
  menu bar.
- **42.7.1, crash during maglev compilation.** Applies. Maglev is a V8 tier, so
  this is on the path that runs renderer script, which is the path this card
  cares about.
- **42.7.1, `--remote-debugging-port` DevTools frontend fixed; 42.7.1 autofill
  popup latency on macOS; 42.7.1 Windows `disableHardwareAcceleration`;
  42.7.1/42.8.0/42.9.0/42.9.1/42.9.3 Linux and Windows window, menu, X server,
  TouchID, `contentTracing` and frameless-window fixes; 42.8.0
  `process.getSystemMemoryInfo().available` on Linux; 42.9.0
  `webFrameMain.printToPDF()`; 42.9.2 `WebContentsView` background
  throttling; 42.9.2 downloading files from inside an asar.** Nothing applies.
  None of these APIs is called and none of these surfaces is used.

No API this app calls changed shape. No source change was required.

### js-yaml, span 4.3.0 -> 4.3.1

One release. The 4.x line has no published changelog entry for it; what exists
is the advisory, read in full (`gh api /advisories/GHSA-5p4m-2wfm-xmqj`).
`resolveYamlOmap()` enforced key uniqueness with `objectKeys.indexOf(...)`
inside the per-element loop, making `!!omap` resolution quadratic in entry
count. `4.3.1` uses a `Set`. Behaviour is otherwise identical: same API, same
schema, same output.

**Effect on this app.** `js-yaml` is reached only through `electron-updater`,
which parses the `latest-mac.yml` channel file fetched from the release feed.
The input is therefore attacker-controlled only if the release feed is, which is
the card's own assessment and it holds. The consequence was a hung or spinning
updater, not code execution. `4.3.1` is a strict improvement on a hot path with
no API surface change, so nothing to adapt.

### electron-builder, span 26.8.1 -> 26.15.7

Nineteen releases, every one read: 26.8.2, 26.9.0, 26.9.1, 26.10.0, 26.11.0,
26.11.1, 26.12.0, 26.12.1, 26.13.0, 26.13.1, 26.14.0, 26.15.0, 26.15.1, 26.15.2,
26.15.3, 26.15.4, 26.15.5, 26.15.6, 26.15.7
(`gh release view "electron-builder@26.15.7" --repo electron-userland/electron-builder`).

**A note on which version is "current".** The npm `latest` dist-tag on
`electron-builder` points at `26.15.3`, but the 26 line continues to `26.15.7`
under the `v26` tag, published later. `npm update` and `npm outdated` follow
`latest` and therefore stop at `26.15.3`; the newest release of the major is
`26.15.7`. This change takes `26.15.7`. A reviewer running `npm outdated` will
see `Current 26.15.7 / Latest 26.15.3`, which looks like a downgrade is
available and is not. Recorded here so that reading is not mistaken for a
mistake.

Behavioural items and what each does to this app:

- **26.15.0, `feat(migration): fully replace Go binary `app-builder-bin` with a
  TypeScript implementation.`** Applies, and it is the largest change in the
  span. `app-builder-bin@5.0.0-alpha.12` is gone from the lockfile entirely: it
  is one of the 119 packages this bump removes. A Go binary that used to run on
  the release runner no longer exists there. Adjacent to the separate card about
  an unverified binary downloaded onto the signing machine, and not a
  replacement for it: that card is about `ffmpeg-static`, whose install hook is
  untouched here. The set of packages with install scripts is byte-identical
  before and after (`electron-winstaller`, `ffmpeg-static`, `fsevents`), so this
  bump neither adds nor removes a network install hook.
- **26.15.0, `fix(mac): skip signing when no certificate found; warn on ad-hoc +
  hardenedRuntime.`** Applies to the local gate. The smoke run above prints
  `skipped macOS application code signing`, then re-signs ad hoc itself. The
  release job supplies a real identity, so its path is unchanged.
- **26.15.2, `fix(mac): use native zip for the macOS zip target to preserve
  .framework symlinks.`** Applies directly. `build.mac.target` is
  `["dmg", "zip"]` and the zip is the artifact `electron-updater` consumes. A
  zip that flattened framework symlinks is an update that installs and then
  fails to launch. Not verified here, since the smoke builds `--dir` and never
  produces a zip; CI's release job is where that lands.
- **26.15.6, `fix(nsis): reliably install the main executable and native
  binaries on x64 and arm64.`** Applies to a shipped target
  (`build.win.target` includes `nsis`) and is the reason `26.15.7` was taken
  over `26.15.3`. Not verifiable on this machine.
- **26.8.2, `fix(win): rebuild app exe if the header of the asar has changed.`**
  Applies to the same Windows targets, same caveat.
- **26.13.0, `fix: harden the auto-update flow from relative paths and env var
  intercepts`, and 26.15.3, `ELECTRON_BUILDER_BINARIES_ALLOW_HTTP` opt-in for
  env vars targeting non-localhost HTTP.** Apply as hardening of the same
  publish and update path this card is about. Neither env var is set here.
- **26.11.0, `fix: improving filtering of log redactor`, and 26.15.0, `fix:
  holistic field detection for <text> (sha256 hash) redaction.`** Apply. This is
  the machinery that keeps the release token out of build logs, on a job that
  has both the token and the signing identity in its environment.
- **26.10.0, `feat: migrate electronDownload to use @electron/get instead of
  app-builder.`** Applies. It changes how the engine zip is fetched during
  packaging, and it is visible in the lockfile as `@electron/get` moving into
  the `app-builder-lib` tree.
- **26.12.1, `chore: better logging when electron in devDependencies or the
  electronVersion property is not pinned.`** Applies, and it bears on AC-8
  below: the packaging tool this project uses now warns when the engine
  dependency is a range rather than a pin.
- **26.13.0, `feat: add disableAsarIntegrity config option.`** Available, not
  set, default unchanged.
- **26.15.2, `fix(icons): replace png2icons with wasm-vips resampling`, and
  26.15.5, icons toolset 1.2.1.** Do not apply. This build supplies
  `electron/build/icon.icns` and `icon.ico` directly, so no conversion runs.
- **26.15.3, `fix(publish): set x-amz-content-sha256: UNSIGNED-PAYLOAD before
  SigV4 signing.`** Does not apply. `build.publish.provider` is `github`.
- **26.9.1, `fix(electron-updater): filter draft releases in
  PrivateGitHubProvider.`** Does not apply. This app uses the public GitHub
  provider.
- **AppImage, snap, flatpak, deb, Linux `.desktop`, pnpm and Yarn Berry
  resolution, Wine and Docker, squirrel-windows vendor warnings, GitLab auth,
  Azure trusted signing, `nsis-web` `appPackageUrl`, `electronLanguages`
  filtering, `core24`.** Nothing applies. None of these targets is built and
  none of these options is set. This is the bulk of the nineteen releases.

`electron-builder` is a build tool, so none of the above can change what the
app does at runtime. It can change what lands in the bundle, which is what the
packaged smoke above answers for macOS.

### builder-util-runtime, span 9.5.1 -> 9.7.0

The package ships from the `electron-builder` monorepo and has no release notes
of its own, so there is nothing to quote. What was read instead: the advisory
`GHSA-p2f4-r6v6-j797` in full, and a direct comparison of the shipped
`out/httpExecutor.js` between the two copies that were installed side by side in
`node_modules` before this change. Both are set out under AC-3 above. Stated
plainly so a reader is not left assuming a changelog was read that does not
exist.

## AC-8: the range

> **AC-8:** Whether to keep a version range that can outrun its lockfile is
> answered with a reason, since the range currently implies a tracking practice
> that does not happen.

**Answer: pin the engine exactly. Keep ranges everywhere else. Do not pretend
either one is tracking.**

`package.json` moves `"electron": "^42.7.0"` to `"electron": "42.9.3"`.

The reasoning, in the order it actually matters.

**1. Nothing installs from the range, so the range decides nothing.** Every job
runs `npm ci` or `npm ci --omit=dev`: `ci.yml` lines 79, 111, 141, 183, 242,
`release.yml` lines 42, 71, 116, 192, `smoke.yml` line 31. `npm ci` reads the
lockfile and refuses if the manifest disagrees with it. The lockfile has decided
the shipped engine on every build this project has ever made.

**2. The range's only remaining job is to describe intent, and the intent it
describes is not carried out.** `^42.7.0` says "we take patches within 42".
Checked: there is no `dependabot.yml`, no `renovate.json`, no scheduled
dependency job, and no `npm audit` step in any of the four workflows
(`grep -rn "npm audit\|dependabot\|npm update" .github/` returns nothing). The
caret has had no mechanism behind it for the whole life of the project, which is
how the engine came to sit two minors behind while the manifest suggested
otherwise. A signal nothing produces is worse than no signal, because it is read
as one.

**3. The engine's version is a property of the product, not an implementation
detail.** It is the browser that parses agent output. Which one ships should be
readable in the manifest, in one line, rather than recovered from a lockfile of
several thousand. Pinning makes every future engine change a reviewable
one-line diff that has to be argued for, which is the behaviour this card is
demonstrating.

**4. The packaging tool already prefers the pin.** `electron-builder` 26.12.1,
inside the span read above, added a warning when the `electron` devDependency is
not pinned.

**5. The cost of pinning is the thing pinning is accused of, and it is already
being paid.** Pinning means `npm update` will not pick up a patch. Nothing runs
`npm update`. The cost is zero today and the false comfort is not.

**What this answer explicitly does NOT do.** Pinning removes a false signal. It
does not add tracking, and no reader should take it as having done so. The
honest replacement for a caret nobody acts on is a notification, not a different
range: an `npm audit` step in CI, or a scheduled job that opens a pull request.
That is a change to the workflows, which is product surface this card is not
allowed to widen into. It belongs on the board as its own card, and it is named
in the pull request rather than done here.

**Why the other ranges stay.** `electron-builder` moves from `^26.0.0` to
`^26.15.7` and stays a range. The change of floor is not cosmetic: `^26.0.0`
permits `26.0.x`, which carries `builder-util-runtime` below `9.7.0`, so the old
range allowed a clean resolve to reinstate the exact advisory AC-3 clears. A
range must not permit what the change just removed. Beyond that it stays a
caret, because `electron-builder` is a build tool whose version is not a
property of anything shipped, and because the lockfile pins it anyway.
`marked`, `ws` and `electron-updater` keep their carets unchanged for the same
reason.

`js-yaml` has no manifest expression available at all: it is transitive, and the
only control over it is the lockfile. It is worth being explicit that this is
the general case rather than the exception, and that an `overrides` block is the
only way to express a floor for a transitive dependency. None is added here,
because `electron-updater` declares `^4.1.0` and `4.3.1` is the newest 4.x, so
a clean resolve cannot go below the fix.

## What else this change touched, named rather than hidden

**The lockfile's root `version` field moves `0.11.6` to `0.11.8`.** That is the
cosmetic drift recorded on the manifest-hygiene card, which is out of scope
here. npm rewrites that field on any install and it cannot be left behind
without hand-editing a generated file, which would be worse. Recorded so the
hygiene card's author knows it is already done.

**119 packages leave the tree, 33 arrive, 37 change version.** The removals are
dominated by the `app-builder-bin` retirement and by `fs-extra` and `jsonfile`
deduplication. `node-gyp` brings in a second, older `undici@6.28.0`, which
carries no advisory. Reproduce the full list against `HEAD`:

    node -e "const {execSync}=require('child_process');
    const b=JSON.parse(execSync('git show HEAD:package-lock.json',{maxBuffer:1e9})).packages;
    const a=require('./package-lock.json').packages;
    for (const k of new Set([...Object.keys(b),...Object.keys(a)]))
      if ((b[k]||{}).version !== (a[k]||{}).version)
        console.log(k, (b[k]||{}).version || '-', '->', (a[k]||{}).version || '-');"

## Red-first

Run directly, output not redirected, on a clean tree after the commit.

**The result: NOT-PROVABLE, and that is the correct answer.**

    $ node scripts/red-first.js --base origin/main --tests "npm test"
    [red-first] NOT-PROVABLE: the change adds no tests, so there is nothing to
               prove; that is its own finding
    exit 1

A version-only change adds no test. Reverting it restores two manifest files
while `node_modules` stays as installed, so there is nothing for a suite to
notice. This is recorded as not-provable rather than dressed up as a pass,
because a discrimination result the run does not support is the exact failure
mode the check exists to prevent.

### The first run said PROVEN, and it was wrong

Worth writing down rather than deleting, because it is a false pass produced by
the check whose whole purpose is preventing false passes.

    $ node scripts/red-first.js --base main --tests "npm test"
    [red-first] PROVEN: the tests fail without the change and pass with it
    exit 0

    record: testsPassedWithChange 1981, testsFailedWithoutChange 2,
            sourceFiles 12, testFiles 8
            names: "every DOM-writing function in app.js is an enumerated
                    retention", "test/unit/markdown-render.test.js"

Twelve source files and eight test files, for a change that touches three files.
The local `main` ref in this checkout sits at `346fb13`, one commit behind the
`9549be7` this branch was cut from, because a worktree does not move the local
branch ref that another worktree checked out. `--base main` therefore reverted
seventeen files belonging to the previously merged card as well, and the two
tests that went red are that card's tests, proving that card's change.

Nothing in the output says so. The verdict line, the exit code and the record
are indistinguishable from a genuine pass. The only tell is the file counts, and
those are inside the record rather than on the verdict line. A builder who ran
the documented invocation, saw PROVEN and exit 0, and moved on would have
attributed someone else's discrimination to their own diff in perfect good
faith.

The base that is correct here is the fork point, not a local branch name that
may be stale:

    git merge-base HEAD origin/main   ->   9549be7   (this branch's fork point)
    git rev-parse main                ->   346fb13   (stale)

Both runs are recorded because the second one alone would hide the first, and
the first is the more useful of the two.
