# Sample: Feature Option Scoring

**Date Created:** [[2026-07-10]]
**Project:** [[2026-07-10-sample-scoring]]
**Core idea:** A worked scoring example exercising the editor's round-trip guarantees.
**Funnel stage:** Evaluation
**Visual format:** Comparison table. This fixture reproduces the structures that historically broke round-trips: a 7-column table with non-uniform cell padding, bold cells, non-ASCII cells, a ragged final row, and a 14-item ordered list.

## Generated Options

1. Cache the parsed tree between saves.
2. Rebuild the tree on every keystroke.
3. Split parsing into a worker thread.
4. Debounce saves behind a shared timer.
5. Precompute spans at load time.
6. Store byte offsets alongside nodes.
7. Diff serialized output against source.
8. Keep a shadow copy of the raw file.
9. Re-parse only dirty blocks.
10. Normalise once, then track deltas.
11. Anchor edits to stable node ids.
12. Snapshot state before every mutation.
13. Validate output against the input bytes.
14. Fail loudly on any byte drift.

## Scoring (evaluation criteria, 1-10)

| # | Option | Effort | Risk | Payoff | Fit | Score |
|---|------|---------|-----------------|---------------|-----------|-------|
| 1 | Cache the parsed tree between saves | High | High | High (then why?) | Strong | **9** |
| 2 | Rebuild the tree on every keystroke | High | High | Med-High | Strong | **8.5** |
| 3 | Split parsing into a worker thread | High | High | High | Good | **8.5** |
| 4 | Debounce saves behind a shared timer | Med-High | High | Med | Good | 8 |
| 7 | Diff serialized output against source | Med-High | Med | Med | Good | 7.5 |
| 9 | Re-parse only dirty blocks | Med-High | High | Med | Good | 7.5 |
| 5 | Precompute spans at load time | Med | High | Med | Med | 7 |
| 8 | Keep a shadow copy of the raw file | Med | Med | Med | Overused frame | 6.5 |
| 13 | Validate output against the input bytes | Med | Med | Med | Good | 7 |
| others | → | → | → | → | 6-7 |

## Top 3

1. **Option 1 (9/10):** Cache the parsed tree between saves. Clean single mechanism, and the payoff compounds with file size. **Recommended.**
2. **Option 3 (8.5/10):** Split parsing into a worker thread. Strong but carries more moving parts.
3. **Option 2 (8.5/10):** Rebuild the tree on every keystroke. Simple to reason about; costs latency.

**Selected for draft:** Option 1. Meets the 8+ threshold.
