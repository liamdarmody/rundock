# The mutation shard cap, and the plans that call for it

`MAX_SHARDS` in `scripts/mutation-scope.js` caps how many shards the full mutation set is cut into. `test/unit/mutation-scope.test.js` holds every shard of the full plan to fifteen minutes ("the full set, planned with the real costs, keeps every shard well under its limit"). This file records the plans behind each raise: from twelve to thirteen (2026-11-06), then from thirteen to fifteen (2026-11-09), then from fifteen to sixteen (2026-11-09), then from sixteen to seventeen (2026-11-10). There is no cap argument, so for each plan the cap was set by editing `MAX_SHARDS` in the export before running the command.

## Raised to thirteen: the plans

Each plan is `node scripts/mutation-scope.js --all --plan --out plan.json`, run in an export of the commit named (`git archive`), with the cap set as shown. Seconds are the planner's own inferred cost per shard, from `test/tools/mutation-costs.json`. Measured 2026-11-06.

| Rows | Cap | Shards | Longest shard | Shards at 900 s or more |
|---|---|---|---|---|
| main at `b5f0f229` | 12 | 12 | 783 s | 0 |
| main at `b5f0f229` | 13 | 13 | 744 s | 0 |
| the recursive-read change at `fe4b94b9` (2,677 rows) | 12 | 12 | 935 s | 1 |
| the recursive-read change at `fe4b94b9` | 13 | 13 | 749 s | 0 |

Main's rows plan under the limit at either cap. The recursive-read change adds rows to `test/tools/mutate-workspace-boundary-guards.js`, and at twelve one shard is planned at 935 s, past the limit, so that branch's planner test fails and the pre-commit gate refuses it. At thirteen its longest shard is 749 s.

## Why one shard jumped, on 2026-11-06

At the time, a shard was cut at the first row that took it past its share. Two of the boundary harness's slowest rows, about 193 s and 188 s, sit three rows apart. Before the new rows, a cut fell between them. The new rows move that cut past both, so one shard takes both. A cut that lands on whichever side of the share is nearer would stop this as rows grow. That was a separate change to the cutting rule, and it has since landed: `planShards` now cuts at whichever side of the crossing row is nearer the share. The plans for fifteen below were made with that rule.

## What else the cap touches

- **The nightly sweep** reads its shard matrix from the plan, so a raise needs no workflow change. The lines are quoted, with their current numbers, under "Both workflows read the shard count from the plan" below.
- **A pull request's scoped plan** is the same at either cap unless it needs more shards than the cap allows. `test/unit/mutation-scope.test.js` pins that: "a plan the cap does not reach is the same whatever the cap".

## Raised to fifteen

Main grew after the cap was set at thirteen. Its full set now plans its longest shard at 791 s at thirteen, still under the limit. The credential-folder read change (#403) adds rows to the boundary harness. Merged onto main at `36714997` (tree `59b5df34`), that change's full plan puts one shard at 917 s at thirteen, so its planner test fails and the pre-commit gate refuses the merge. On CI, a full-set run of that change merged onto an earlier main had one mutation shard cancelled at its 30-minute timeout.

Each plan below is `node scripts/mutation-scope.js --all --plan --out plan.json`, run in an export (`git archive`) of the tree named, with the cap set as shown. Average is the plan's seconds over its shards. Measured 2026-11-09.

| Rows | Cap | Shards | Longest shard | Average | Shards at 900 s or more |
|---|---|---|---|---|---|
| main at `36714997` (2,963 rows) | 13 | 13 | 791 s | 775 s | 0 |
| main at `36714997` | 14 | 14 | 726 s | 720 s | 0 |
| main at `36714997` | 15 | 15 | 695 s | 672 s | 0 |
| main at `36714997` | 16 | 16 | 686 s | 630 s | 0 |
| main at `36714997` | 17 | 17 | 646 s | 593 s | 0 |
| the credential-folder read change on main, tree `59b5df34` (2,996 rows) | 13 | 13 | 917 s | 867 s | 1 |
| tree `59b5df34` | 14 | 14 | 812 s | 806 s | 0 |
| tree `59b5df34` | 15 | 15 | 791 s | 752 s | 0 |
| tree `59b5df34` | 16 | 16 | 711 s | 705 s | 0 |
| tree `59b5df34` | 17 | 17 | 695 s | 663 s | 0 |

## Why fifteen

At fourteen the change's plan clears the limit, but its longest shard is 812 s against an average of 806 s. Every shard is close to full, so the next rows added would put one past 900 s again. At fifteen the longest is 791 s and the average 752 s. Each shard past that is another CI job on every pull request that runs the full set. The planner's ten-minute target (`SECONDS_PER_SHARD`) would want about nineteen shards for this set (11,277 s over 600 s), so the cap is what holds the count, as before.

## Both workflows read the shard count from the plan

Fifteen shards need no workflow change, in either workflow that runs the full set:

- **Pull requests** (`.github/workflows/ci.yml`): the plan step runs `node scripts/mutation-scope.js --plan --out mutation-plan.json` (`:219` and `:221`), which plans the full set when a change touches what every harness depends on. Its output carries the matrix (`matrix: ${{ steps.plan.outputs.matrix }}`, `:157`), and the shard job's matrix is that output (`matrix: ${{ fromJSON(needs.mutation-plan.outputs.matrix) }}`, `:252`). Each shard keeps its 30-minute timeout (`timeout-minutes: 30`, `:249`).
- **The nightly sweep** (`.github/workflows/mutation-nightly.yml`): the plan step runs `node scripts/mutation-scope.js --all --plan --out mutation-plan.json` (`:88`). Its output carries the matrix (`matrix: ${{ steps.plan.outputs.matrix }}`, `:65`), and the shard job's matrix is that output (`matrix: ${{ fromJSON(needs.mutation-plan.outputs.matrix) }}`, `:111`). Each shard keeps its 30-minute timeout (`timeout-minutes: 30`, `:108`).

Line numbers are those of both workflows on main at `36714997`, which this change doesn't touch.

## The planner suite and CI, at fifteen

- `node --test test/unit/mutation-scope.test.js` passes 58 of 58 at `7f84c311`, the commit that sets the cap to fifteen. That includes "the full set, planned with the real costs, keeps every shard well under its limit" (main's rows) and "a plan the cap does not reach is the same whatever the cap". The planner test can't fail on main's rows at either cap (791 s at thirteen), so what tells the caps apart is the table for tree `59b5df34` above.
- CI run 42587697025 on `7f84c311` planned the full set, because the change touches the planner. It ran all fifteen shards, and every one passed, as did "Mutation guards" and the rest of the run.


## Raised to sixteen

The boundary harness's costs are now taken from CI shard logs (#429). Main's table had priced the full set short, and with costs that match CI the full set sits at the fifteen-shard bound. Main at `6b15e20a` plans its longest shard at 898 s at fifteen, 2 s under the 900 s the planner suite allows. The set-of-days change (#427) adds rows to the routines and routine-editor harnesses, and its branch at `f1f5acc8`, costed as below, plans one shard at 917 s at fifteen, so its planner test fails and the pre-commit gate refuses it.

Tree `c89daf19` is that branch with eleven costs added to its table: its rows on a suite other rows of their harness already run take the mean of those rows' costs, and the rows of a suite no other row runs were given the remainder of their harness's CI shard time, after what the table gives the harness's other rows.

Each plan below is `node scripts/mutation-scope.js --all --plan --out plan.json`, run in an export (`git archive`) of the tree named, with the cap set as shown. Average is the plan's seconds over its shards. Totals differ by a second between caps because each slice's seconds are rounded. Measured 2026-11-09.

| Rows | Cap | Shards | Total | Longest shard | Average | Shards past 900 s |
|---|---|---|---|---|---|---|
| main at `6b15e20a` (3,044 rows) | 15 | 15 | 13,375 s | 898 s | 892 s | 0 |
| main at `6b15e20a` | 16 | 16 | 13,376 s | 895 s | 836 s | 0 |
| main at `6b15e20a` | 17 | 17 | 13,376 s | 877 s | 787 s | 0 |
| the set-of-days branch at `f1f5acc8`, costed, tree `c89daf19` (3,045 rows) | 15 | 15 | 13,516 s | 917 s | 901 s | 6 |
| tree `c89daf19` | 16 | 16 | 13,517 s | 899 s | 845 s | 0 |
| tree `c89daf19` | 17 | 17 | 13,517 s | 878 s | 795 s | 0 |

At fifteen the costed tree's average, 901 s, is itself past the limit, so no cutting of its rows fits fifteen shards.

## Why sixteen

Sixteen is the smallest cap at which every shard of both trees plans within the limit. Its headroom is thin: the costed tree's longest shard is 899 s, 1 s under 900 s, and main's is 895 s. Seventeen leaves 22 s on the costed tree (878 s) and 23 s on main (877 s).

At both caps the longest shard is two slices of about 440 to 460 s that the packing puts on one shard, not a full share. At sixteen the costed tree's two longest shards each pair a slice of `mutate-rundock-ui-guards.js` with a slice of `mutate-sdlc-gate-guards.js`: rows 0:90 (458 s) with rows 136:201 (441 s) at 899 s, and rows 90:262 (459 s) with rows 0:136 (437 s) at 896 s. Every other shard plans at 881 s or less. At seventeen the longest is both slices of `mutate-sdlc-gate-guards.js` (437 s and 441 s) on one shard. So the margin at either cap is set by how those slices pair, and rows added to those two harnesses spend it: at sixteen, a second's worth on the shard at 899 s; at seventeen, 22 s on the SDLC gate harness. Seventeen buys 21 s on the costed tree for another job on every full-set run, against a margin of the same kind, so this change takes the smallest cap that fits.

Each shard beyond fifteen is another CI job on every run of the full set: the nightly sweep, and every pull request that touches what every harness depends on. The planner's ten-minute target (`SECONDS_PER_SHARD`) would want about twenty-three shards for this set (13,517 s over 600 s), so the cap is what holds the count, as before.

## Both workflows still read the shard count from the plan

Sixteen shards need no workflow change. The lines quoted under "Both workflows read the shard count from the plan" above are unchanged on main at `6b15e20a`, at the same line numbers:

- **Pull requests** (`.github/workflows/ci.yml`): `node scripts/mutation-scope.js --plan --out mutation-plan.json` (`:219` and `:221`), `matrix: ${{ steps.plan.outputs.matrix }}` (`:157`), `matrix: ${{ fromJSON(needs.mutation-plan.outputs.matrix) }}` (`:252`), and `timeout-minutes: 30` (`:249`).
- **The nightly sweep** (`.github/workflows/mutation-nightly.yml`): `node scripts/mutation-scope.js --all --plan --out mutation-plan.json` (`:88`), `matrix: ${{ steps.plan.outputs.matrix }}` (`:65`), `matrix: ${{ fromJSON(needs.mutation-plan.outputs.matrix) }}` (`:111`), and `timeout-minutes: 30` (`:108`).

A pull request's scoped plan is the same at fifteen and sixteen unless it needs more than fifteen shards, which "a plan the cap does not reach is the same whatever the cap" in `test/unit/mutation-scope.test.js` pins.

## Raised to seventeen

Main at `b2c87dfc` plans the full set in sixteen shards, its longest at 895 s, 5 s under the 900 s the planner suite allows. The read-only answer change (#433) adds nine rows to the boundary harness. Its branch at `1485920c` also plans its longest shard at 895 s, but merged into main it plans one shard at 907 s at sixteen, so the planner test fails and the pre-commit gate refuses the merge.

The trees, and how each is costed:

- **Main at `b2c87dfc`** (3,146 rows) is costed by its committed table, `test/tools/mutation-costs.json`, whose `about` says how each harness's costs were made.
- **Tree `8e693514`** (3,155 rows) is #433's branch at `1485920c` merged into main at `b2c87dfc`. #433 adds no cost entries, and its nine rows run a suite no other row runs, so the table's rule plans each at the boundary harness's integration rate, 15.5 s, until a CI shard log times them.
- **No third tree.** One more change that adds rows before the next release, on zsh patterns, has pushed none yet. Its rows will be planned when it merges main.

Each plan below is `node scripts/mutation-scope.js --all --plan --out plan.json`, run in an export (`git archive`) of the tree named, with the cap set as shown. Average is the plan's seconds over its shards. Totals differ by a second between caps because each slice's seconds are rounded. Measured 2026-11-10.

| Rows | Cap | Shards | Total | Longest shard | Average | Shards past 900 s |
|---|---|---|---|---|---|---|
| main at `b2c87dfc` (3,146 rows) | 16 | 16 | 13,926 s | 895 s | 870 s | 0 |
| main at `b2c87dfc` | 17 | 17 | 13,927 s | 895 s | 819 s | 0 |
| main at `b2c87dfc` | 18 | 18 | 13,927 s | 878 s | 774 s | 0 |
| #433 merged into main, tree `8e693514` (3,155 rows) | 16 | 16 | 14,067 s | 907 s | 879 s | 1 |
| tree `8e693514` | 17 | 17 | 14,068 s | 895 s | 828 s | 0 |
| tree `8e693514` | 18 | 18 | 14,068 s | 878 s | 782 s | 0 |

## Why seventeen

Seventeen is the smallest cap at which every shard of both trees plans within the limit.

At sixteen the merged tree's longest shard pairs rows 0:90 of `mutate-rundock-ui-guards.js` (458 s) with the whole of `mutate-routines-guards.js` (449 s), at 907 s. On main at sixteen, that slice of the UI harness is paired with rows 0:136 of `mutate-sdlc-gate-guards.js` (437 s), at 895 s, and the routines harness with rows 136:201 of the SDLC gate harness (441 s), at 890 s. At seventeen both trees plan those same two pairs as their two longest shards, at 895 s and 890 s. At eighteen the longest shard of both trees holds both SDLC gate slices, at 878 s.

So seventeen leaves 5 s on both trees, and eighteen leaves 22 s. At either cap the margin is set by how those half-harness slices pair, not by the boundary harness, where #433's rows are. Rows added to the UI, SDLC gate or routines harnesses spend it. Eighteen buys 17 s for another job on every full-set run, against a margin of the same kind, so this change takes the smallest cap that fits.

Each shard beyond sixteen is another CI job on every run of the full set: the nightly sweep, and every pull request that touches what every harness depends on. The planner's ten-minute target (`SECONDS_PER_SHARD`) would want about twenty-four shards for this set (14,068 s over 600 s), so the cap is what holds the count, as before.

## The planner suite passes at seventeen

At `313d4d32`, the commit that sets the cap to seventeen, `node --test test/unit/mutation-scope.test.js` passes 61 of 61 tests with none skipped, unchanged from main. That includes "the full set, planned with the real costs, keeps every shard well under its limit" and "a plan the cap does not reach is the same whatever the cap". Run 2026-11-11. CI's test jobs on Node 22 and 24 run every `test/**/*.test.js` file, this suite included, and both passed at the same commit (run 42925690030).

## Both workflows still read the shard count from the plan, at seventeen

Seventeen shards need no workflow change. Both workflows that run the full set read their shard matrix from the plan, at the same line numbers on main at `b2c87dfc` as above:

- **Pull requests** (`.github/workflows/ci.yml`): `node scripts/mutation-scope.js --plan --out mutation-plan.json --base "$BASE"` (`:219`) and `node scripts/mutation-scope.js --plan --out mutation-plan.json` (`:221`), `matrix: ${{ steps.plan.outputs.matrix }}` (`:157`), `matrix: ${{ fromJSON(needs.mutation-plan.outputs.matrix) }}` (`:252`), and `timeout-minutes: 30` (`:249`).
- **The nightly sweep** (`.github/workflows/mutation-nightly.yml`): `run: node scripts/mutation-scope.js --all --plan --out mutation-plan.json` (`:88`), `matrix: ${{ steps.plan.outputs.matrix }}` (`:65`), `matrix: ${{ fromJSON(needs.mutation-plan.outputs.matrix) }}` (`:111`), and `timeout-minutes: 30` (`:108`).

A pull request's scoped plan is the same at sixteen and seventeen unless it needs more than sixteen shards, which "a plan the cap does not reach is the same whatever the cap" in `test/unit/mutation-scope.test.js` pins.
