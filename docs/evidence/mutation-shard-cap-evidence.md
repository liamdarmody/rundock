# The mutation shard cap, and the plans that call for it

`MAX_SHARDS` in `scripts/mutation-scope.js` caps how many shards the full mutation set is cut into. `test/unit/mutation-scope.test.js` holds every shard of the full plan to fifteen minutes ("the full set, planned with the real costs, keeps every shard well under its limit"). This file records the plans behind each raise: from twelve to thirteen (2026-11-06), then from thirteen to fifteen (2026-11-09). There is no cap argument, so for each plan the cap was set by editing `MAX_SHARDS` in the export before running the command.

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

