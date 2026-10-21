# Releasing

A release is one pull request and three commands. The candidate carries its
own version bump and promoted changelog, CI runs the required checks on it, the
release gate runs what CI cannot on the same tree, and the merged commit is
tagged. The commands and the reasons they are separate are documented at the
top of `scripts/release.js`.

```
npm run release -- bump <version>       # version + promoted changelog, committed with the candidate
...push the candidate and open its pull request; wait for CI to finish on it...
npm run walk                            # the release walk: use the product (the gate runs it too)
npm run release:gate                    # what CI cannot do, on the candidate's exact tree
...write the release summary; where it flags a hands-on check, try the candidate from source...
npm run release -- signoff <version> --confirm <version>   # sign off this tree, at a terminal
npm run release -- signoff <version> --confirm <version> --on-instruction "<your words>"   # or as given in chat
...merge the pull request...
npm run release -- tag <version>        # tag the merged commit, which starts the build
npm run release -- publish <version> --confirm <version>   # publish the reviewed draft
```

## Which checks come from CI

CI runs the suite on Node 22 and 24, coverage with its floors, the browser
suite (E2E), typecheck and hygiene as required checks on the pull request. The
release gate does not run them again. It asks GitHub for CI's results on the
exact tree it gates and refuses, naming the check, unless each of those jobs
passed there. A push or dispatched run counts for the tree of its commit; a
pull request run counts only when the branch already contains main, because CI
tests the merge, and that merge has the branch's tree only then. A job that
passed on a re-run counts, and so does a green job inside a run that was
cancelled overall.

The gate runs what CI cannot: the runtime truth captures (they need the real
CLI), the Electron steps (CI runs no Electron), the case-insensitive disk and
volume checks, smoke and personas against the stub and the live runtime, and
the packaged build's boot. Before any of them it names any process already
holding a port the smoke steps need.

## The version and the gate record

The candidate's `package.json` is exactly one release past the latest tag (the
next patch, minor or major), and the top heading of `CHANGELOG.md` names that
version: `npm run release -- bump <version>` writes both from the
`## Unreleased` section. The gate refuses any other version.

`.release-gate.json` records the tree the gate passed on. `release -- tag`
accepts it when the merged commit has that tree, so a merge that makes a new
commit with the same content needs no second gate, and any difference is
refused. If main moved under the pull request, the merged tree differs: run the
gate again on main once CI has finished there.

## The release summary

Once the gate has passed, the candidate gets a short summary: what changed,
what is risky, what was tested, and whether a hands-on check is worth it.
The summary flags the hands-on check for this release. It is required when
the release changes security, permissions or data-loss behaviour, and
optional otherwise.

## The hands-on check and its sign-off

Where the summary calls for a hands-on check, do it before the cut, and never
after the build: start Rundock from the release branch on your own machine,
signed in to the real runtime, and try the short test list for this release
in the browser. The desktop draft that `tag` builds is a final smoke test,
not the place to find a release blocker, because a finding there costs a
full recut.

Then sign the tree off. `release -- tag` refuses without a sign-off for
exactly the tree it tags, naming the command, whether or not the release
called for a hands-on check. A sign-off is given in one of two ways.

**In the terminal**, by running it yourself:

```
npm run release -- signoff <version> --confirm <version>
```

`--confirm` must name the version; the command refuses inside an agent
session (Claude Code sets `CLAUDECODE` for every command it runs); and it
asks one thing, an optional note, read from the controlling terminal, never
from stdin or arguments, so nothing can be piped into it and a shell without
a terminal is refused. Copying a printed command satisfies none of these.

**In chat**, by telling the agent running the release. The agent records it
with your words, verbatim:

```
npm run release -- signoff <version> --confirm <version> --on-instruction "<your words>"
```

This lifts the agent-session and terminal refusals and nothing else:
`--confirm` must still name the version, the tree must be clean and carry
that version, and an empty instruction is refused. Publishing is run the
same way, on an instruction given in chat, with `--confirm`.

**What each proves.** A terminal sign-off shows it was typed at the machine.
A chat sign-off records that an agent acted on an instruction given in chat:
it is an audit trail, not proof of who typed the words, because on one
machine under one identity nothing local can tell the two apart. Both bind
to the exact tree.

Either way the record goes to `rundock-release-signoff.json` in git's common
directory, with how it was given (`terminal` or `chat`), the tree, the
version, the time, and the note or the instruction. A sign-off made in a
worktree on the release branch is seen by the checkout that tags, and the
record can never be committed. The instruction stays in that local record:
the tag step logs only which kind of sign-off it accepted, and the words
never reach the tag, the build or the release notes. A record written before
sign-offs said how they were given counts as a terminal sign-off. A fix
merged after the sign-off changes the tree, so it needs signing off again,
and the hands-on check again where the summary calls for one.

**Tests go through the real handler.** Both blockers of the first 0.15.1 cut
passed every gate because their tests reached the store, not the handler
that the page and the runtime call. A test for a surface a release touches
drives the real entry point: the protocol dispatch table, the HTTP router, or
the spawned hook. `test/unit/rule-key-allows.test.js` saves each Code-mode
rule key through the `add_tool_allow` handler, and
`test/unit/putback-same-step.test.js` runs the real permission hook against
the real router; both fail on the code of that first cut.

## Pull requests and merges

Opening a pull request needs no separate go: once a change is ready, its
branch is pushed and the pull request opened.

An agent may merge a pull request when CI is green on it and an independent
review, by a reviewer that did not write the change, has passed. A person
merges any pull request that changes the CI or release workflows
(`.github/`), the release scripts (`scripts/release*.js`), or the
repository's settings. Merges are reported in a summary.

## A recut

To recut an unpublished draft: delete the draft release, delete the tag here
and on the remote (`git tag -d v<version>`, `git push origin :refs/tags/v<version>`),
merge the fix with its note under the release's changelog heading, run the gate
on main once CI is green there, sign the fixed tree off (trying it from source
first where the summary calls for a hands-on check), and tag again. With the tag gone, the version on
main is one release past the latest tag again, which is all the gate asks.

## The release walk

`npm run walk` is a scripted session that uses the release candidate the way
a person does, before the release gate and the merge. It boots `server.js` from source on a fresh
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
in CI, and it is a step of the release gate, so a walk that has rotted fails
the gate instead of being skipped. Its checks of where the product keeps
things (a package card's key, the pins file) are held to the product's own
code by `test/unit/release-walk-checks.test.js`, so a move in the product
turns a unit test red before it turns the walk red.

**The report is attached to the release pull request.** The walk writes
`.walk/report.md` and `.walk/report.json` (the directory is ignored by git),
naming the server commit, the tags installed, and for each step its verdict,
its screenshot path and, on failure, the reason. Attach `report.md` to the
release pull request, with the screenshots for any step that failed and was
judged acceptable. A walk with a failed step is a reason not to merge the
release until the failure is understood.

The runner lives under `scripts/walk/`: `runner.js` is the step engine
(pinned by `test/unit/release-walk.test.js`), `steps.js` the walked steps,
`workspace.js` the seeded scratch workspace, `repos.js` the repository
expectations, and `run.js` the entry the npm script names.
