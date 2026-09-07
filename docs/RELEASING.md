# Releasing

A release is the gate, the walk, then the three release commands. The
commands and the reasons they are separate are documented at the top of
`scripts/release.js`; this page adds the stage that sits between the gate and
the first of them.

```
npm run release:gate                    # the full gauntlet on the candidate
npm run walk                            # the release walk: use the product
npm run release -- prepare <version>    # bump, promote the changelog, open the PR
...review and merge that pull request...
npm run release -- tag <version>        # tag the merged commit, which starts the build
npm run release -- publish <version>    # publish the reviewed draft
```

## The release walk

`npm run walk` is a scripted session that uses the release candidate the way
a person does, after `npm run release:gate` has passed and before
`npm run release -- prepare`. It boots `server.js` from source on a fresh
scratch workspace with a scratch `HOME` and the stub runtime first on `PATH`,
drives the real page through Playwright over the real socket and HTTP
surfaces, and reads the disk the server wrote. Every step records PASS or
FAIL with a screenshot, a step whose precondition is missing fails by name
with the reason and takes its dependents with it, and the command exits
non-zero when any step failed.

It walks the surfaces the release touches: the two example packages
installed from their GitHub tags (`liamdarmody/lean-agent-team` as agents
and skills, `liamdarmody/rundock-csv-extension` as a sandboxed renderer,
each checked against the expectations stated in `scripts/walk/repos.js`
before the product is touched), the extension rendering, disabled and
uninstalled, a pin made from the editor header and opened from the rail, the
map filtered to one file and clicked, and a routine created through the
editor and run by hand.

**It needs network access to GitHub**, because the installs clone the real
tagged repositories. It runs locally on the release engineer's machine, not
in CI, and the release gate's own step list does not include it.

**The report is attached to the release pull request.** The walk writes
`.walk/report.md` and `.walk/report.json` (the directory is ignored by git),
naming the server commit, the tags installed, and for each step its verdict,
its screenshot path and, on failure, the reason. Attach `report.md` to the
pull request `npm run release -- prepare` opens, with the screenshots for any
step that failed and was judged acceptable. A walk with a failed step is a
reason not to prepare the release until the failure is understood.

The runner lives under `scripts/walk/`: `runner.js` is the step engine
(pinned by `test/unit/release-walk.test.js`), `steps.js` the walked steps,
`workspace.js` the seeded scratch workspace, `repos.js` the repository
expectations, and `run.js` the entry the npm script names.
