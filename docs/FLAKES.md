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
| `test/e2e/packages-install.spec.js` "switching workspace returns the flow to idle, discarding the previous plan" | 2026-09-29, 2026-10-02, 2026-10-11 | The test went on as soon as the page heard of the switch to a fresh workspace, but the page chooses where to land only when the conversation list arrives, and for a fresh workspace that is the setup conversation, which hides the Settings sidebar. A click on the Packages item that it hid waited with no limit, so the poll around it timed out. The spec now waits for the page to settle after a switch and bounds each click; the other test that switches workspace shares both. Found by reading the code, since the failure message was not in the run annotations: if it flakes again, quarantine it. | fixed 2026-10-22 |

## CI steps

A step that fails for a reason outside the code is held to the same two-strike rule.

- **E2E "Install Chromium"** (2026-10-22, twice). A slow package mirror stalled the first attempt; `timeout` ended the installer but not the `apt-get` it had started as root, which kept the dpkg lock, so the second and third attempts failed on the lock at once. Fixed 2026-10-22: each retry waits for any package manager still running.
