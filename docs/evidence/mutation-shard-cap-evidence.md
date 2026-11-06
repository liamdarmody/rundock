# The mutation shard cap at thirteen, and the plans that call for it

`MAX_SHARDS` in `scripts/mutation-scope.js` caps how many shards the full mutation set is cut into. `test/unit/mutation-scope.test.js` holds every shard of the full plan to fifteen minutes ("the full set, planned with the real costs, keeps every shard well under its limit"). This file records the plans behind raising the cap from twelve to thirteen.

## The plans

Each plan is `node scripts/mutation-scope.js --all --plan --out plan.json`, run in an export of the commit named (`git archive`), with the cap set as shown. Seconds are the planner's own inferred cost per shard, from `test/tools/mutation-costs.json`. Measured 2026-11-06.

| Rows | Cap | Shards | Longest shard | Shards at 900 s or more |
|---|---|---|---|---|
| main at `b5f0f229` | 12 | 12 | 783 s | 0 |
| main at `b5f0f229` | 13 | 13 | 744 s | 0 |
| the recursive-read change at `fe4b94b9` (2,677 rows) | 12 | 12 | 935 s | 1 |
| the recursive-read change at `fe4b94b9` | 13 | 13 | 749 s | 0 |

Main's rows plan under the limit at either cap. The recursive-read change adds rows to `test/tools/mutate-workspace-boundary-guards.js`, and at twelve one shard is planned at 935 s, past the limit, so that branch's planner test fails and the pre-commit gate refuses it. At thirteen its longest shard is 749 s.

## Why one shard jumps

A shard is cut at the first row that takes it past its share. Two of the boundary harness's slowest rows, about 193 s and 188 s, sit three rows apart. Before the new rows, a cut fell between them. The new rows move that cut past both, so one shard takes both. A cut that lands on whichever side of the share is nearer would stop this as rows grow. That is a separate change, since it alters the planner's cutting rule.

## What else the cap touches

- **The nightly sweep** reads its shard matrix from the plan, so a thirteenth shard needs no workflow change: the plan step runs `node scripts/mutation-scope.js --all --plan` (`.github/workflows/mutation-nightly.yml:87`), its output carries the matrix (`:65`), and the shard job's matrix is that output (`:107`). Each shard keeps its 30-minute timeout (`:104`).
- **A pull request's scoped plan** is the same at either cap unless it needs more shards than the cap allows. `test/unit/mutation-scope.test.js` pins that: "a plan the cap does not reach is the same whatever the cap".
