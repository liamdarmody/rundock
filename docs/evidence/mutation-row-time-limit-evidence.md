# Every mutation row, run through the bounded suite runner on CI

A mutation harness starts each row's suite through `runSuite`, which ends a suite that runs past its limit (300 s for a node:test suite, 240 s for a desktop app suite) and reports that row as no verdict. A change to that runner touches every harness, so CI plans and runs all of them. This file records one such run: every one of its 13 mutation shards passed, every row got a verdict, and no row reached its limit.

**The run:** https://github.com/liamdarmody/rundock/actions/runs/42482937437, on commit `ef06810a`, 2026-11-08. That commit's tree differs from the commit that adds this file only by this file.

## The shards

The plan cut 2,781 rows into 13 shards, each planned at about 12 to 13 minutes. Rows are as the plan printed them. Job time is the whole job, setup included, against a 30-minute job limit. Each shard's outcome is the line `[mutation-scope] pass: all N unit(s) in shard K passed` at the end of its job log.

| Shard | Rows | Harnesses | Outcome | Job time |
|---|---|---|---|---|
| 1 | 274 | `mutate-sdlc-gate-guards.js`, `mutate-package-update-guards.js`, `mutate-workspace-rollback-guards.js`, `mutate-import-apply-guards.js` | passed | 16m02s |
| 2 | 204 | `mutate-workspace-boundary-guards.js` rows 120:265, `mutate-approve-once-guards.js`, `mutate-run-now-guards.js`, `mutate-fence-guards.js` | passed | 12m00s |
| 3 | 158 | `mutate-workspace-boundary-guards.js` rows 485:521, `mutate-atomic-write-guards.js`, `mutate-run-detail-guards.js`, `mutate-pins-guards.js` | passed | 14m24s |
| 4 | 221 | `mutate-host-wiring-guards.js`, `mutate-packages-manage-guards.js`, `mutate-map-foothold-guards.js`, `mutate-factory-shape-guards.js`, `mutate-import-protocol-guards.js` | passed | 12m27s |
| 5 | 232 | `mutate-workspace-boundary-guards.js` rows 521:703, `mutate-render-guards.js`, `mutate-map-view-guards.js`, `mutate-region-markup-guards.js` | passed | 16m20s |
| 6 | 227 | `mutate-workspace-boundary-guards.js` rows 265:453, `mutate-routine-fallback-guards.js`, `mutate-collision-decisions-guards.js`, `mutate-import-plan-guards.js` | passed | 13m14s |
| 7 | 307 | `mutate-workspace-boundary-guards.js` rows 703:901, `mutate-routine-editor-guards.js`, `mutate-readable-error-guards.js` | passed | 22m16s |
| 8 | 71 | `mutate-workspace-boundary-guards.js` rows 453:485, `mutate-frontmatter-links-guards.js` | passed | 9m01s |
| 9 | 161 | `mutate-workspace-boundary-guards.js` rows 0:120, `mutate-view-state-guards.js` | passed | 13m50s |
| 10 | 149 | `mutate-extension-host-guards.js` rows 0:35, `mutate-extension-install-guards.js`, `mutate-nav-guards.js`, `mutate-routines-truth-guards.js` | passed | 11m05s |
| 11 | 138 | `mutate-extension-host-guards.js` rows 35:127, `mutate-history-guards.js`, `mutate-install-flow-guards.js` | passed | 12m02s |
| 12 | 443 | `mutate-rundock-ui-guards.js` rows 90:262, `mutate-routines-guards.js` | passed | 7m48s |
| 13 | 196 | `mutate-rundock-ui-guards.js` rows 0:90, `mutate-stale-session-guards.js` | passed | 14m31s |

The job that reads every shard's verdict, Mutation guards, passed ("Mutation guards passed").

## No row reached its limit

When a suite reaches its limit, the runner prints `[mutation-run] ... did not finish in N s; ending it and everything it started`, and the harness reports the row as "no verdict: the suite did not finish in N s". A row whose output could not be read is reported as "the suite failed but its output could not be parsed", and a run with any row of no verdict prints "The end of what each suite with no verdict printed" under its report.

None of those lines appears in any mutation shard's log. They appear in the run's log only in the unit test jobs, where the runner's own tests print them on purpose.

## The row that had no verdict before

On an earlier head of this change, the row "the desktop app runs on the RUNDOCK_USER_DATA_DIR folder it resolved" had no verdict. In this run it is in shard 9 and got one: 2 tests red. On CI's runners the desktop app suites stop at setup, so the tests that turned red are its setup checks. That is unchanged by this change.
