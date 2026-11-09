# Boundary harness row costs, re-derived from CI

The planner in `scripts/mutation-scope.js` cuts the mutation set into shards by the seconds `test/tools/mutation-costs.json` gives each row. Two shards of `test/tools/mutate-workspace-boundary-guards.js` ran far past their plan. This file records why, how the costs were re-derived from CI shard logs, and how the new costs predict the shards CI ran. Measured 2026-11-09, on rows at main `2ac7cce6`. Row ranges are written as the logs write them: `a:b` is rows a up to, not including, b.

## The two overruns

| Run | Shard | Rows | Planned | Took |
|---|---|---|---|---|
| 42625901207 (#426 at `39a30de0`) | 4 | 745:903 | 9.3 min | 28.4 min for the harness, 28.7 min for the job; passed |
| 42626462142 (#412 at `9d30693a`) | 5 | 731:902 | 9.2 min | 29.8 min for the harness; the job was cancelled at its 30-minute limit, on both attempts |

These were not one-off: rows 731:902 took 29.7 minutes in run 42600452339 (main at `69d0ab75`) and 25.2 and 25.7 in two other runs, and rows 745:903 took 27.0 to 28.4 minutes in each of five runs, all on 2026-11-09.

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

**Runs.** Every CI run on 2026-11-09 from the first to hold the boundary harness's "Folder reads:" rows (#403): 42596195029, 42600452339, 42601132361, 42612674381, 42613267711, 42617502454, 42625901207, 42626462142, 42630320371, 42631470848, 42631520174, 42633231846 and 42640417868. That is 133 slices of the boundary harness over 13 runs and 12 of `mutate-sdlc-gate-guards.js` over 8. Older runs were left out because suites grow: a suite that gains tests slows every row that runs it, and older runs time the smaller suites. Every one of the boundary harness's 1,040 rows at `2ac7cce6` ran in at least one of these slices.

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

Every shard of the three runs is within 25%. The largest error, +23%, is on a shard that ran for 7 seconds.

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
- **The full set** plans 15 shards, the cap, at 13,331 s in all; the longest is 892 s. `test/unit/mutation-scope.test.js` holds every shard of the full plan to 900 s, so a few more rows will turn that test red. Main's table planned the full set short, which hid how close the cap is.

## Costing a new row

The `about` text of `test/tools/mutation-costs.json` now says:

> Cost a new row from CI, never from a run on a developer machine, whose times are not the runner's. A new row that runs a suite other rows of its harness already run is costed at the mean of their costs by label. A row whose suite no row runs yet has no cost by label until a CI run has run it, its own pull request's run included, and is planned meanwhile at its harness's rate, or its integration rate for an integration row; its cost is then the measured seconds of the slice that ran it, less what this table gives the slice's other rows, shared among its new rows. Do not leave it at the rate once CI has run it: rows left there though their suites take four times it on CI planned a slice at nine minutes that CI ran for twenty-eight.

## The planner test

"the boundary harness is planned at what CI measured: no shard past the margin, and no overrun slice in one shard" in `test/unit/mutation-scope.test.js` plans the boundary harness with the committed table. It requires every shard at or under 900 s, and, for each overrun slice above, from its first row's label to its last, a plan of at least 75% of the seconds CI took and at least two shards holding it. With main's table it fails on the first overrun: "rows 745:903 are planned at 560s; CI run 42625901207 took 1704s over them". With the new table it passes.
