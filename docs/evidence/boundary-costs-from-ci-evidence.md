# Boundary harness row costs, re-derived from CI

The planner in `scripts/mutation-scope.js` cuts the mutation set into shards by the seconds `test/tools/mutation-costs.json` gives each row. Two shards of `test/tools/mutate-workspace-boundary-guards.js` ran far past their plan. This file records why, how the costs were re-derived from CI shard logs, and how the new costs predict the shards CI ran. Measured 2026-11-09, on rows at main `2ac7cce6`. Row ranges are written as the logs write them: `a:b` is rows a up to, not including, b.

## The overruns

| Run | Shard | Rows | Planned | Took |
|---|---|---|---|---|
| 42625901207 (#426 at `39a30de0`) | 4 | 745:903 | 9.3 min | 28.4 min for the harness, 28.7 min for the job; passed |
| 42626462142 (#412 at `9d30693a`) | 5 | 731:902 | 9.2 min | 29.8 min for the harness; the job was cancelled at its 30-minute limit, on both attempts |

These were not one-off: rows 731:902 took 29.7 minutes in run 42600452339 (main at `69d0ab75`) and 25.2 and 25.7 in two other runs, and rows 745:903 took 27.0 to 28.4 minutes in each of five runs, all on 2026-11-09. After this table was derived, run 42644607063 (#427 at `900ce9dc`) put rows 751:915 in one shard, planned at 9.3 minutes, and that job too ran to its 30-minute limit and was cancelled.

## Why the plan was short

A mutation row breaks one guard and runs that guard's whole suite, so a row costs about what its suite takes on the CI runner. Main's table priced the rows of the first overrun, by where each cost came from, as follows (minutes, rows as numbered at `2ac7cce6`):

| Rows 745:903 | Rows | Main's table | New table |
|---|---|---|---|
| Inferred from older CI runs, shared by tests turned red | 105 | 5.0 | 7.6 |
| No cost by label, planned at the harness rate of 4.95 s | 52 | 4.3 | 19.9 |
| Timed on a developer machine | 1 | 0.0 | 0.1 |

A third of the slice had no cost of its own. Most of those rows run `test/unit/hook-never-crashes.test.js`, which takes about 28 seconds a row on CI, and were planned at 4.95 seconds. The costs inferred from older runs were a third short of these runs as well. Over the whole harness:

| Whole harness | Rows | Main's table | New table |
|---|---|---|---|
| Inferred from older CI runs, shared by tests turned red | 776 | 64.0 | 67.7 |
| No cost by label, planned at the harness or integration rate | 203 | 17.1 | 48.1 |
| "Folder reads:" rows, timed on a developer machine | 33 | 20.0 | 11.4 |
| PowerShell rows, timed on a developer machine | 26 | 1.2 | 2.1 |
| Workspace switch rows, timed on a developer machine | 2 | 0.4 | 1.7 |
| Total | 1,040 | 102.8 | 131.0 |

The costs timed on a developer machine were wrong in both directions: the "Folder reads:" rows, timed one row at a time, were priced at nearly twice what CI takes, the PowerShell rows at a little over half, and the workspace switch rows at a quarter. A time from another machine does not predict the runner either way.

## Method

**Seconds per slice.** A shard log prints `[mutation-scope] <harness> rows a:b` as each slice starts and a verdict line when the shard's harness step ends. A slice's seconds are the time between its start line and the next start line or the verdict line. No log records a row's own time.

**Runs.** Every CI run on 2026-11-09 that ran the boundary harness, from the first to hold its "Folder reads:" rows (#403) to main at `2ac7cce6`: 42596195029, 42600452339, 42601132361, 42612674381, 42613267711, 42617502454, 42625901207, 42626462142, 42630320371, 42631470848, 42631520174, 42633231846 and 42640417868. Runs after those are held out, below. That is 133 slices of the boundary harness over 13 runs and 12 of `mutate-sdlc-gate-guards.js` over 8. Older runs were left out because suites grow: a suite that gains tests slows every row that runs it, and older runs time the smaller suites. Every one of the boundary harness's 1,040 rows at `2ac7cce6` ran in at least one of these slices.

**Shared by suite.** The table's earlier method shares each slice's seconds among its rows in proportion to one plus the tests each turned red. On these logs that misprices whole groups: in run 42626462142, shard 1 ran the 25 Keychain rows (499:524) in under 7 seconds, and sharing by tests turned red priced them at 2.3 minutes, because some of those rows turn a hundred fast tests red. Since a row's time is its suite's time, each slice's seconds are instead shared among its rows in proportion to the cost of the suite each row runs. A suite's cost is the mean of the shares its rows were given; starting from equal shares, the two steps repeat until no slice's estimate moves by more than 0.1% in a pass. Each label's cost is the mean of its shares over the runs. The harness rate is the mean of its labels' costs and the integration rate the mean over its integration rows, so a row without a label is still planned at a CI rate. Over the training slices longer than a minute, the boundary harness's costs give each slice's time within 6% at the median and 16% at the 90th percentile.

| Shards within 25% of what CI measured | Runs 42625901207 and 42626462142 (26 shards) | Run 42640417868, held out of the derivation (10 shards) |
|---|---|---|
| Main's table | 9 | 3 |
| Shared by tests turned red, over the same runs | 22 | 8 |
| Shared by suite (this change) | 26 | 10 |

## Predicted against measured

"Planned then" is the plan that run printed. "Measured" is the time the shard's slices took, from the shard log; "Job" is the whole job, setup included. "Predicted now" is the new table's cost for the same rows, by label. Minutes.

### Run 42625901207

| Shard | Slices | Planned then | Measured (step) | Job | Predicted now | Error |
|---|---|---|---|---|---|---|
| 1 | workspace-boundary 381:500 | 10.6 | 14.2 | 14.6 | 14.1 | -1% |
| 2 | workspace-boundary 524:569 | 9.9 | 19.0 | 19.2 | 18.3 | -4% |
| 3 | workspace-boundary 937:954 | 9.8 | 7.6 | 8.0 | 7.5 | -2% |
| 4 | workspace-boundary 745:903 | 9.3 | 28.4 | 28.7 | 27.6 | -3% |
| 5 | workspace-boundary 0:119 | 9.3 | 9.4 | 9.7 | 8.9 | -5% |
| 6 | workspace-boundary 208:381 | 9.3 | 10.8 | 11.1 | 11.6 | +7% |
| 7 | workspace-boundary 119:208 | 9.3 | 8.0 | 8.3 | 9.5 | +18% |
| 8 | workspace-boundary 903:937 | 9.3 | 4.8 | 5.2 | 5.2 | +7% |
| 9 | workspace-boundary 569:745 | 9.3 | 13.6 | 13.9 | 13.6 | +0% |
| 10 | workspace-boundary 954:1038 | 8.9 | 14.6 | 15.0 | 12.9 | -12% |
| 11 | workspace-boundary 500:524, stale-session | 12.8 | 4.8 | 5.0 | 5.4 | +13% |

### Run 42626462142

| Shard | Slices | Planned then | Measured (step) | Job | Predicted now | Error |
|---|---|---|---|---|---|---|
| 1 | workspace-boundary 499:524 | 10.7 | 0.1 | 0.3 | 0.1 | +23% |
| 2 | workspace-boundary 924:941 | 9.8 | 7.9 | 8.2 | 7.5 | -5% |
| 3 | workspace-boundary 524:563 | 9.3 | 15.5 | 15.8 | 15.0 | -3% |
| 4 | workspace-boundary 206:373 | 9.2 | 12.8 | 13.1 | 11.3 | -12% |
| 5 | workspace-boundary 731:902 | 9.2 | 29.8 | 30.1, cancelled | 27.5 | -8% |
| 6 | workspace-boundary 0:116 | 9.2 | 9.5 | 10.0 | 8.6 | -10% |
| 7 | workspace-boundary 116:206 | 9.2 | 10.1 | 10.4 | 9.6 | -5% |
| 8 | workspace-boundary 563:731 | 9.2 | 18.5 | 18.8 | 16.4 | -11% |
| 9 | workspace-boundary 902:924 | 9.0 | 4.4 | 4.7 | 3.8 | -12% |
| 10 | workspace-boundary 941:1025, readable-error | 9.1 | 14.8 | 15.0 | 13.1 | -11% |
| 11 | workspace-boundary 373:499, packages-manage, approve-once, run-now | 9.2 | 16.3 | 16.7 | 16.0 | -2% |
| 12 | sdlc-gate 0:107, routine-editor, run-detail, map-view, routines-truth | 9.1 | 8.1 | 8.3 | 8.3 | +3% |
| 13 | sdlc-gate 107:201, frontmatter-links, atomic-write, nav, pins | 9.1 | 13.7 | 14.0 | 13.2 | -3% |
| 14 | routines, host-wiring 29:57 | 10.8 | 9.8 | 10.1 | 10.9 | +12% |
| 15 | host-wiring 0:29, stale-session | 10.7 | 10.3 | 10.7 | 10.7 | +3% |

### Run 42640417868, held out

Run 42640417868 is main at `2ac7cce6`. These predictions come from the same method over the other twelve runs, so this run had no part in them. The committed table includes it.

| Shard | Slices | Planned then | Measured (step) | Job | Predicted now | Error |
|---|---|---|---|---|---|---|
| 1 | sdlc-gate, collision-decisions, import-protocol | 12.2 | 13.8 | 14.1 | 14.9 | +8% |
| 2 | workspace-boundary 0:143, workspace-rollback | 12.2 | 12.4 | 12.7 | 13.7 | +10% |
| 3 | workspace-boundary 489:524, map-foothold, install-flow | 12.2 | 3.2 | 3.5 | 2.5 | -22% |
| 4 | workspace-boundary 932:953, package-update, run-now | 12.3 | 8.2 | 8.5 | 7.1 | -14% |
| 5 | workspace-boundary 582:824, approve-once, map-view | 12.3 | 17.9 | 18.2 | 19.2 | +7% |
| 6 | workspace-boundary 824:932, packages-manage, readable-error | 12.3 | 22.7 | 22.9 | 24.7 | +9% |
| 7 | workspace-boundary 953:1040, run-detail | 12.3 | 18.4 | 18.9 | 18.6 | +1% |
| 8 | workspace-boundary 305:489, routine-fallback | 12.8 | 18.5 | 18.8 | 19.5 | +5% |
| 9 | workspace-boundary 524:582, routine-editor | 12.5 | 22.8 | 23.1 | 23.3 | +2% |
| 10 | workspace-boundary 143:305, frontmatter-links | 12.8 | 10.5 | 10.8 | 12.7 | +21% |

Every shard of these three runs is within 25%. The largest error, +23%, is on a shard that ran for 7 seconds.

### Later runs, held out

Three runs started after the table was derived and are not in it: 42644502679 (#428 at `3880e4f5`), 42644607063 (#427 at `900ce9dc`) and 42647247770 (this change at `3dbc3e6e`). All three ran main's rows at `2ac7cce6`. The tables give this table's predictions for them, so they test the costs on runs they were not fitted to. Of the 42 shards among them whose log ends in a verdict, 41 are within 25% of this table's prediction; main's table predicts 15 of them within 25%.

#### Run 42644502679 (#428)

| Shard | Slices | Planned then | Measured (step) | Job | Predicted now | Error |
|---|---|---|---|---|---|---|
| 1, rerun | workspace-boundary 384:500 | 10.4 | 14.0 | 14.3 | 13.9 | -1% |
| 2 | workspace-boundary 524:571 | 10.1 | 19.6 | 20.0 | 19.4 | -1% |
| 3 | workspace-boundary 915:938, run-now | 9.8 | 3.8 | 4.0 | 4.4 | +17% |
| 4 | workspace-boundary 210:384, map-view, routines-truth | 9.9 | 14.2 | 14.5 | 12.3 | -13% |
| 5 | workspace-boundary 0:121, map-foothold, readable-error | 10.0 | 9.1 | 9.3 | 9.7 | +6% |
| 6 | workspace-boundary 751:915, nav, import-protocol | 9.8 | 28.5 | 28.8 | 29.2 | +2% |
| 7 | workspace-boundary 121:210, package-update | 9.8 | 8.4 | 8.6 | 10.0 | +19% |
| 8 | workspace-boundary 954:1040, approve-once | 9.8 | 13.1 | 13.3 | 15.1 | +16% |
| 9 | workspace-boundary 571:751, atomic-write | 9.9 | 15.7 | 16.0 | 13.3 | -15% |
| 10 | workspace-boundary 938:954, packages-manage | 9.9 | 7.4 | 7.7 | 7.9 | +7% |
| 11 | workspace-boundary 500:524, routine-editor, run-detail | 9.9 | 2.9 | 3.1 | 3.3 | +15% |
| 12 | routines, frontmatter-links, routine-fallback | 10.1 | 10.8 | 11.1 | 10.1 | -7% |
| 13 | sdlc-gate 0:107, history, pins | 9.8 | 5.1 | 5.3 | 8.1 | +58% |
| 14 | sdlc-gate 107:201, host-wiring 29:57 | 11.3 | 15.6 | 19.0 | 15.4 | -1% |
| 15 | host-wiring 0:29, stale-session | 10.7 | 10.4 | 10.8 | 10.7 | +2% |

Shard 1's first attempt held rows 384:500, planned then at 10.4 minutes. Its runner was lost: the job ran past its 30-minute limit, was stopped at 35 minutes, and GitHub kept no log of it, so nothing from that attempt can be read. Its rerun, on the same commit, ran the same rows in 14.0 minutes, the row above, against 13.9 predicted. The same rows took 14.1 minutes in run 42644607063, and rows 381:500 took 14.2 and 13.8 minutes in runs 42625901207 and 42631520174.

Shard 13 is the one shard past 25%. The error is in `mutate-history-guards.js`, which has no rate in the table and is planned at the 5 s default: 3.4 minutes for a harness CI runs in under 20 seconds. That cost is high, not short, so it is left as it is.

#### Run 42644607063 (#427)

| Shard | Slices | Planned then | Measured (step) | Job | Predicted now | Error |
|---|---|---|---|---|---|---|
| 1 | workspace-boundary 384:500 | 10.4 | 14.1 | 14.4 | 13.9 | -2% |
| 2 | workspace-boundary 524:571 | 10.1 | 19.0 | 19.3 | 19.4 | +2% |
| 3 | workspace-boundary 915:938 | 9.5 | 4.6 | 4.9 | 4.0 | -11% |
| 4 | workspace-boundary 210:384 | 9.4 | 12.7 | 13.0 | 11.6 | -9% |
| 5 | workspace-boundary 0:121 | 9.3 | 9.2 | 9.7 | 9.1 | -1% |
| 6 | workspace-boundary 751:915 | 9.3 | 30.0, no verdict | 30.3, cancelled | 28.7 |  |
| 7 | workspace-boundary 121:210 | 9.3 | 10.1 | 10.4 | 9.5 | -6% |
| 8 | workspace-boundary 954:1040 | 9.3 | 12.7 | 13.0 | 14.6 | +16% |
| 9 | workspace-boundary 571:751 | 9.3 | 15.7 | 15.9 | 12.7 | -19% |
| 10 | workspace-boundary 938:954 | 9.2 | 7.6 | 7.8 | 7.3 | -4% |
| 11 | workspace-boundary 500:524, run-detail, nav, readable-error | 9.0 | 2.7 | 3.0 | 2.5 | -9% |
| 12 | routines, routine-fallback, package-update, routines-truth | 9.0 | 10.4 | 10.7 | 9.1 | -12% |
| 13 | sdlc-gate 0:107, routine-editor, packages-manage, approve-once, run-now | 9.1 | 8.8 | 9.0 | 7.4 | -16% |
| 14 | sdlc-gate 107:201, stale-session | 11.3 | 15.1 | 15.4 | 15.5 | +2% |

Shard 6, rows 751:915 in one slice, is the overrun above. Cut off before its verdict, its log names no rows, so its prediction is the table's cost for those rows by label: 28.7 minutes, for a slice that ran 30.0 before it was stopped. This table never plans those rows in one shard.

#### Run 42647247770 (this change)

This run was planned with this table, so "Planned then" is this table's own plan, and every shard was planned at 14.8 or 14.9 minutes.

| Shard | Slices | Planned then | Measured (step) | Job | Predicted now | Error |
|---|---|---|---|---|---|---|
| 1 | workspace-boundary 685:831, collision-decisions, install-flow | 14.8 | 15.9 | 16.2 | 14.8 | -7% |
| 2 | workspace-boundary 497:561, region-markup | 14.8 | 15.2 | 15.6 | 14.8 | -2% |
| 3 | sdlc-gate, readable-error | 14.8 | no log | 35.0, runner lost | 14.8 | |
| 4 | workspace-boundary 954:1040, fence, import-protocol | 14.8 | 12.8 | 13.0 | 14.8 | +16% |
| 5 | workspace-boundary 0:165, factory-shape | 14.8 | 12.9 | 13.1 | 14.8 | +15% |
| 6 | workspace-boundary 165:367, pins | 14.8 | 18.7 | 18.9 | 14.8 | -21% |
| 7 | workspace-boundary 367:497, run-now | 14.9 | 15.2 | 15.5 | 14.9 | -2% |
| 8 | workspace-boundary 561:685, map-view | 14.8 | 18.4 | 18.7 | 14.8 | -19% |
| 9 | workspace-boundary 891:954, workspace-rollback | 14.8 | 15.3 | 15.6 | 14.8 | -3% |
| 10 | workspace-boundary 831:891, nav, import-plan | 14.8 | 15.8 | 16.0 | 14.8 | -6% |
| 11 | host-wiring, view-state, routine-editor, approve-once | 14.8 | 14.3 | 14.5 | 14.8 | +4% |
| 12 | extension-host 0:35, extension-install, frontmatter-links, render, atomic-write | 14.8 | 12.3 | 12.6 | 14.8 | +21% |
| 13 | extension-host 35:127, history, run-detail, packages-manage, routines-truth | 14.8 | 14.1 | 14.3 | 14.8 | +5% |
| 14 | rundock-ui 90:262, stale-session, routine-fallback, package-update | 14.8 | 12.4 | 12.8 | 14.8 | +19% |
| 15 | rundock-ui 0:90, routines, map-foothold, import-apply | 14.8 | 18.7 | 19.1 | 14.8 | -21% |

Shard 3 held `mutate-sdlc-gate-guards.js` and `mutate-readable-error-guards.js`, planned at 14.8 minutes. Like the first attempt of #428's shard 1, its runner was lost at 35 minutes with no log kept, so this run says nothing about how long that shard takes. The same shard, the same two harnesses, ended in a pass in 14.6 minutes in this change's next run, below.

### Why the later runs are not in the table

Folding the three later runs in leaves the boundary harness's total where it is (7,857 s against 7,844 s) and moves 5% of its labels by more than 20%. It also moves where the full set's cuts fall: the full set's longest shard goes from 892 s to 936 s, past the 900 s the planner suite holds it to, and only more shards, through `MAX_SHARDS`, fix that. This change leaves `MAX_SHARDS` alone, so the later runs serve as the held-out check above.

## This change's own CI run

Run 42689058445 is this change at `9d3ff21a`, merged with main at `04dafdf0`. A change to `scripts/mutation-scope.js` makes CI run every harness, so it ran all 35 harnesses, 3,033 rows, in 15 shards planned with this table. Every shard's log ends in a verdict, and every verdict is a pass. "Harness" runs from the shard's first unit starting to its verdict line; "Job" is the whole job, setup included. "Error" is the plan less the harness time, over the harness time. Minutes.

| Shard | Slices | Planned | Harness | Job | Error |
|---|---|---|---|---|---|
| 1 | workspace-boundary 685:831, import-apply, import-plan | 14.8 | 15.1 | 15.4 | -2% |
| 2 | workspace-boundary 497:561, region-markup, install-flow | 14.8 | 15.1 | 15.3 | -2% |
| 3 | sdlc-gate, readable-error | 14.8 | 14.6 | 14.8 | +2% |
| 4 | workspace-boundary 954:1040, fence, collision-decisions | 14.8 | 14.3 | 14.6 | +4% |
| 5 | workspace-boundary 0:165, run-now | 14.9 | 13.8 | 14.1 | +8% |
| 6 | workspace-boundary 165:367, factory-shape | 14.8 | 13.6 | 13.8 | +9% |
| 7 | workspace-boundary 367:497, map-view | 14.9 | 14.8 | 15.1 | +0% |
| 8 | workspace-boundary 561:685, workspace-rollback | 14.9 | 18.1 | 18.3 | -18% |
| 9 | workspace-boundary 891:954, routines-truth | 14.8 | 11.5 | 11.7 | +29% |
| 10 | workspace-boundary 831:891, map-foothold, import-protocol | 14.8 | 13.6 | 13.8 | +9% |
| 11 | host-wiring, view-state, routine-editor, package-update | 14.8 | 15.0 | 15.3 | -1% |
| 12 | extension-host 0:35, extension-install, frontmatter-links, render, atomic-write | 14.8 | 13.0 | 13.4 | +14% |
| 13 | extension-host 35:127, history, run-detail, packages-manage, nav | 14.8 | 15.0 | 15.3 | -1% |
| 14 | rundock-ui 90:262, stale-session, routine-fallback, approve-once | 14.8 | 11.1 | 11.4 | +33% |
| 15 | rundock-ui 0:90, routines, pins | 14.8 | 19.0 | 19.4 | -22% |

Shard 3 holds `mutate-sdlc-gate-guards.js` and `mutate-readable-error-guards.js`, the pair whose runner was lost in run 42647247770. Here it ended with a verdict 14.6 minutes after its first unit started, and the job took 14.8:

```
2026-11-09T20:17:18.0305409Z [mutation-scope] pass: all 2 unit(s) in shard 3 passed
```

27 of the sdlc-gate harness's rows break the planner and run `test/unit/mutation-scope.test.js`, the suite this change adds tests to. All 27 ran in that shard and each turned a test red.

Thirteen of the 15 shards are planned within 25% of what they ran. The two outside it were planned longer than they ran, so both finished early: shard 9, whose boundary rows 891:954 ran in 11.2 minutes, and shard 14, whose harnesses this change does not cost. The longest job, shard 15 at 19.4 minutes, holds three harnesses this change does not cost; its plan is 22% short of the 19.0 minutes they ran.

The commits after `9d3ff21a` change tests, comments and docs only. The planner gives the full set the same plan before and after them.

## Other harnesses

Costs outside the boundary harness change only where the same two runs show the same drift: a harness costed short of what CI took, by more than 25%. Units of other harnesses in those runs (minutes):

| Run | Shard | Harness | Measured | Old table | New table |
|---|---|---|---|---|---|
| 42625901207 | 11 | stale-session | 4.7 | 5.3 (+13%) | 5.3 (+13%) |
| 42626462142 | 10 | readable-error | 0.2 | 0.2 (-10%) | 0.2 (-10%) |
| 42626462142 | 11 | packages-manage | 0.7 | 0.7 (-1%) | 0.7 (-1%) |
| 42626462142 | 11 | approve-once | 0.6 | 0.5 (-17%) | 0.5 (-17%) |
| 42626462142 | 11 | run-now | 0.4 | 0.4 (-4%) | 0.4 (-4%) |
| 42626462142 | 12 | sdlc-gate 0:107 | 4.3 | 6.1 (+41%) | 4.4 (+2%) |
| 42626462142 | 12 | routine-editor | 1.6 | 1.5 (-9%) | 1.5 (-9%) |
| 42626462142 | 12 | run-detail | 1.5 | 0.9 (-40%) | 1.7 (+12%) |
| 42626462142 | 12 | map-view | 0.3 | 0.3 (+29%) | 0.3 (+29%) |
| 42626462142 | 12 | routines-truth | 0.3 | 0.2 (-30%) | 0.4 (+8%) |
| 42626462142 | 13 | sdlc-gate 107:201 | 10.6 | 6.0 (-43%) | 10.2 (-4%) |
| 42626462142 | 13 | frontmatter-links | 1.8 | 1.7 (-2%) | 1.7 (-2%) |
| 42626462142 | 13 | atomic-write | 0.5 | 0.6 (+18%) | 0.6 (+18%) |
| 42626462142 | 13 | nav | 0.5 | 0.4 (-19%) | 0.4 (-19%) |
| 42626462142 | 13 | pins | 0.3 | 0.3 (-7%) | 0.3 (-7%) |
| 42626462142 | 14 | routines | 4.7 | 5.7 (+21%) | 5.7 (+21%) |
| 42626462142 | 14 | host-wiring 29:57 | 5.0 | 5.2 (+3%) | 5.2 (+3%) |
| 42626462142 | 15 | host-wiring 0:29 | 5.5 | 5.4 (-2%) | 5.4 (-2%) |
| 42626462142 | 15 | stale-session | 4.8 | 5.3 (+9%) | 5.3 (+9%) |

Re-derived:

- **`mutate-sdlc-gate-guards.js`**: its slice 107:201 was costed 43% short, and its slice 0:107 41% over. It is re-derived the same way as the boundary harness, from 12 slices over 8 runs. Its four labels timed on a developer machine (0.9 min in all) now cost 0.5 min, and its other 197 rows, planned at 3.41 s (11.2 min), now cost 14.2 min. Rate 3.41 to 4.37.
- **`mutate-run-detail-guards.js`** (40% short) and **`mutate-routines-truth-guards.js`** (30% short): CI runs each whole, so the logs give one time for all its rows and no slices to tell them apart. Each rate is re-derived by the table's method for a harness's rate, its measured seconds over its rows, averaged over the runs above that ran it: run-detail 0.57 to 1.17 over 8 runs, routines-truth 1.03 to 1.58 over 6 runs. Run-detail's 41 costs by label, timed on a developer machine, are removed, since a whole run cannot support them and they would override the rate.

Left as they are: every other harness above is within 25%, or costed above what CI took. `mutate-routine-editor-guards.js` ran 33% over its cost in run 42640417868 only, by 0.7 minutes.

## Plans with the new table

- **The boundary harness alone** plans 14 shards, the longest at 609 s. Rows 731:903 fall in four of them.
- **The full set** plans 15 shards, the cap, at 13,331 s in all; the longest is 892 s. `test/unit/mutation-scope.test.js` holds every shard of the full plan to 900 s, so a few more rows will turn that test red. Its failure message says what the red means: the costs come from CI, so the full set needs more shards, through a higher `MAX_SHARDS` in a change of its own, and no cost is to be lowered to fit. Main's table planned the full set short, which hid how close the cap is.

## Costing a new row

The `about` text of `test/tools/mutation-costs.json` now says:

> Cost a new row from CI, never from a run on a developer machine, whose times are not the runner's. A new row that runs a suite other rows of its harness already run is costed at the mean of their costs by label. A row whose suite no row runs yet has no cost by label until a CI run has run it, its own pull request's run included, and is planned meanwhile at its harness's rate, or its integration rate for an integration row; its cost is then the measured seconds of the slice that ran it, less what this table gives the slice's other rows, shared among its new rows. Do not leave it at the rate once CI has run it: rows left there though their suites take four times it on CI planned a slice at nine minutes that CI ran for twenty-eight.

The repo has no separate guide to writing a mutation row. A row's shape is defined in the doc comment on `targetsFromRows` in `test/tools/mutation-run.js`, which every harness loads its rows through, so the rule is there too, and CONTRIBUTING.md points to it from its section on testing a change.

## The planner test

"the boundary harness is planned at what CI measured: every shard within the margin, every slice CI timed planned near its time, and no overrun slice in one shard" in `test/unit/mutation-scope.test.js` plans the boundary harness with the committed table. It holds every planned shard to 900 s. Because a shard planned under that margin still runs long when its rows are costed short, it also plans each slice CI timed, from its first row's label to its last, and requires at least 75% of the seconds CI took: the nine slices of run 42640417868, which between them held every row the harness had, and the two overrun slices. Each overrun slice must also span at least two shards.

A slice whose first or last label has since been renamed or removed is skipped rather than failed, so relabeling a row does not turn the test red. The test fails instead when fewer than three quarters of the eleven slices are still found, and says to time them again. The shard margin is checked whatever the lookups find, and every slice still found is checked. Two tests hold that. One renames a slice's last label and finds nothing wrong, then, with every row costed at a tenth of a second, finds the slices still found planned short. The other renames the first labels of three slices and finds too few slices left.

### Red with main's table, green with this one

`scripts/red-first.js` reverts a change's source and keeps its tests, and it counts every file under `test/` as a test, `test/tools/mutation-costs.json` included. It has no option to revert a file there, so on this change it keeps the new table and reverts only what the suite does not read, the comment in `scripts/mutation-scope.js` and two documents, and reports NOT-DISCRIMINATING: 61 tests passed with the change and 0 failed without it, with three source files reverted and three test files kept. The red was run by hand instead, at this change's head, swapping only the table:

```
git show 2ac7cce6:test/tools/mutation-costs.json > test/tools/mutation-costs.json
node --test --test-timeout=120000 test/unit/mutation-scope.test.js
```

`2ac7cce6` is the commit this change was cut from, and main's table has not changed since. With that table the suite exits 1:

```
ℹ tests 61
ℹ pass 59
ℹ fail 2

✖ the boundary harness is planned at what CI measured: every shard within the margin, every slice CI timed planned near its time, and no overrun slice in one shard (60.171583ms)
  AssertionError [ERR_ASSERTION]: rows 305:489 are planned at 681s; CI run 42640417868 took 1040s over them
  rows 524:582 are planned at 666s; CI run 42640417868 took 1244s over them
  rows 582:824 are planned at 687s; CI run 42640417868 took 1037s over them
  rows 824:932 are planned at 683s; CI run 42640417868 took 1321s over them
  rows 953:1040 are planned at 682s; CI run 42640417868 took 996s over them
  rows 745:903 are planned at 560s; CI run 42625901207 took 1704s over them
  rows 731:915 are planned at 617s; CI run 42626462142 took 1788s over them
✖ a timed slice whose endpoint is renamed is skipped, and the rest are still held to what CI took (60.792042ms)
```

The second failure is the rename test, whose remaining slices fail the same way. With this change's table put back, the same command exits 0:

```
git show HEAD:test/tools/mutation-costs.json > test/tools/mutation-costs.json
node --test --test-timeout=120000 test/unit/mutation-scope.test.js
```

```
ℹ tests 61
ℹ pass 61
ℹ fail 0
```
