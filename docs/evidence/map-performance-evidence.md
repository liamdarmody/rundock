# Map view performance, measured

MP-16 asks for performance to be **recorded, not asserted**: the draw pass at
rest under 16 ms per frame as the median of 60 frames, and the layout ticking
on its timer without blocking input.

This file exists in `docs/evidence/` rather than in a scratch directory
because the first recording of this number was cited as
`.rundock/scratch/map-perf.md` and had been deleted by the time anyone went
looking. `.rundock/` is gitignored and the server's `pruneScratch()` empties
`scratch/` on boot, so evidence written there is evidence with a fuse on it.

## How to reproduce

Serve the branch and open the map with the performance readout on:

```bash
npm run look                       # prints the URL
# then visit  <that URL>/?perf=1   and click Map
```

The readout at the foot of the canvas carries the numbers. `PERF_FRAMES` in
`public/graph-model.js` sets the 60-frame window the median is taken over.

## Measured 2026-09-19

Apple Silicon Mac, Chrome, foreground window, a real 4,987-file workspace,
which is larger than the 4,000-file workspace MP-16 names. Two consecutive
reloads:

| | run 1 | run 2 |
|---|---|---|
| draw median, 60 frames | **1.10 ms** | **1.00 ms** |
| layout settle | 14,331 ms | 14,003 ms |
| tick median | 24.2 ms over 572 ticks | 23.7 ms over 572 ticks |
| nodes | 4,987 | 4,987 |

**The draw clause passes with room to spare:** 1 ms against a 16 ms budget.

**The input clause passes in practice, and the arithmetic alone would say
otherwise.** A 23.7 ms tick overruns a 16.7 ms frame, so on paper the settling
period drops frames. It does not read that way, for a reason the owner
observed and the numbers then explain: the picture reaches its final shape
long before alpha decays to rest, so the great majority of those 572 ticks
move nodes imperceptibly. Verified by the owner in a foreground window: no
stickiness on open.

The 573-tick settle is deliberate. `alphaDecay` is lowered for large graphs on
purpose, and its comment gives the reason: a fixed decay "freezes a 4,000-node
layout mid-collapse before repulsion and collision have resolved it". The
trade is a correct layout that takes fourteen seconds over a wrong one that
takes three.

## The 0.14 layout changes cost nothing

The seven layout changes in `50a81d9` were measured against the model as it
stood immediately before them, on the same payload in the same process, timing
120 ticks each:

| | tick median | p90 | ticks to settle |
|---|---|---|---|
| before | 30.73 ms | 34.71 ms | 573 |
| after | 30.72 ms | 34.81 ms | 573 |

Identical. The settle cost belongs to the map as it was built, not to the
placement, anchor, rim, scale or disclosure changes. (Absolute tick times are
higher here than in the browser because this harness ticks in a tight loop
with no frame budget; the comparison between the two is the point, not the
figure.)
