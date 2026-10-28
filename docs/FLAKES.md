# Flaky tests

**The rule: a test that flakes twice is fixed or quarantined.** A flake is a
test that failed and then passed on the same code. The first time, add a row
here. The second time, fix it, or quarantine it (skip it with a pointer to its
row) until it is fixed. A third re-run is not one of the options.

One row per test: the test, the dates it flaked, the cause as far as it is
known, and its status. Status is one of `retry once`, `open`, `fixed` or
`quarantined`. `retry once` is a single retry for that test alone, configured
in a `test.describe` that holds only it; the browser suite has no global retry,
because a retry hides a timing regression as readily as a slow runner.
`test/unit/flake-register.test.js` holds every retry in the suite to this page.
A pass on a retry is a strike too, and a passing run would hide it, so
`test/e2e/flake-reporter.js` reports each one: a warning annotation in CI, a
plain `[flake]` line locally. Add its date to the test's row.

Before fixing one, read [TEST-TIMING.md](TEST-TIMING.md): most flakes here are
timing assertions, and it says how to tell a wait that is needed from one that
hides a defect.

| Test | Date | Cause | Status |
|---|---|---|---|
| `test/e2e/packages-manage.spec.js` "a package is a card; opening Packages checks for updates; a package updates, then uninstalls, from its card" | 2026-10-11 | Passed the 60-second test timeout on a CI runner while waiting for the file list after the uninstall. It is the longest single test in the browser suite: two page loads, an update check, an update and an uninstall. A timeout there cost a full E2E re-run of about 15 minutes. | retry once |
| `test/unit/red-first-orphans.test.js` "a second start is refused, and the refusal names the run it found" | 2026-09-21, 2026-10-08 | Failed in two gate runs on 2026-09-21, after an earlier failure on CI Node 24 that was fixed on 2026-08-26, and again on main on 2026-10-08, in CI run 37799173469, job "Test (Node 24)", with "the refusal must not end the run it found"; Node 22 passed in that run, and the next run passed. The test read the run record once, as soon as the suite's shell had written its pids, but the tool names the suite's process group in the record only after the spawn returns, so on a loaded runner the read could still see `group: null`. The check for the group's number then passed by matching the "null" in the command's `/dev/null`, and the test failed asking whether group null was running, as "the refusal must not end the run it found". Reproduced every time by holding back the record's update by a second and a half. The test now waits for the record to name the group the suite's shell heads, and looks for the refusal's own words for it. | fixed 2026-10-24 |
| `test/e2e/packages-install.spec.js` "switching workspace returns the flow to idle, discarding the previous plan" | 2026-09-29, 2026-10-02, 2026-10-11 | The test went on as soon as the page heard of the switch to a fresh workspace, but the page chooses where to land only when the conversation list arrives, and for a fresh workspace that is the setup conversation, which hides the Settings sidebar. A click on the Packages item that it hid waited with no limit, so the poll around it timed out. The spec now waits for the page to settle after a switch and bounds each click; the other test that switches workspace shares both. Found by reading the code, since the failure message was not in the run annotations: if it flakes again, quarantine it. | fixed 2026-10-22 |
| `test/e2e/trust-boundary-app.spec.js` "a source edited on disk after mount raises the reload-theirs or keep-mine choice instead of being overwritten" | 2026-10-28 | Failed on the first attempt of CI run 40606795934, for a change that touched only CI, reading `notes/a.csv` as an empty string at its check that the file still held the disk edit (line 142 before the fix), and passed on the single re-run. The retry loop checked for the conflict banner with `isVisible({ timeout })`, which ignores the timeout and does not wait, so an attempt could see a banner the previous attempt had raised late, then read the file while its own save, a legitimate one, was still writing it. Each attempt now polls until its own outcome is known, the banner raised with nothing written or the view's save on disk (a lost race, tried again), before the next attempt starts, and the check after the loop expects the edit of the attempt that raised the banner. | fixed 2026-10-28 |

## CI and release gate steps

A step that fails for a reason outside the code is held to the same two-strike rule.

- **Release gate "personas (stub)"** (once, in a gate run on a loaded machine; it passed alone, 16 of 16). The journeys slept a fixed 1.5 seconds after signing in before sending on the page's socket, and started conversations with the team the journey had just created half a second after asking, while the roster naming that team could still be on its way to the page; the client then opens a conversation with the first agent it knows instead, and the message goes to the wrong agent. Fixed 2026-10-24: the journeys wait for the socket to be open and the workspace named, and for the roster to hold the agent, and check that the conversation that opened is with it (`scripts/smoke/page-ready.mjs`). Found by reading the code, not from the failing output: if the step fails again, note here which check failed.
- **E2E "Install Chromium"** (2026-10-22, twice). A slow package mirror stalled the first attempt; `timeout` ended the installer but not the `apt-get` it had started as root, which kept the dpkg lock, so the second and third attempts failed on the lock at once. Fixed 2026-10-22: each retry waits for any package manager still running.
