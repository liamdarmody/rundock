# d3-force, vendored

The map view's layout. Four files rather than one, because `d3-force`'s UMD
build declares `d3-quadtree`, `d3-dispatch` and `d3-timer` as externals and
reads them off the `d3` global at call time. All four must be present, and the
three siblings must load first.

They compose with the org chart's `d3-hierarchy` rather than competing with it:
every one of these builds attaches with `.d3 = n.d3 || {}`, so
`d3.forceSimulation` lands beside `d3.hierarchy` on the same object. All on the
d3 v3 line.

## Why a library rather than a hand-rolled solver

A hand-rolled force layout was written first, on purpose, so that the decision
to take a dependency would be made against evidence. The evidence arrived: at
3,687 files that solver's coordinates grew 6.34x per tick, reached `Infinity`
at tick 382 of 700, and the view rendered a blank canvas with no error. Three
separate properties fix that, and d3-force has all three:

- **Alpha cooling and velocity decay** stop the divergence.
- **A timer-driven tick** stops the settle blocking the main thread for
  minutes at a time.
- **Barnes-Hut** in `forceManyBody` replaces an O(n^2) pair loop that measured
  at about n^2.45 across three workspace sizes.

Rendering stays Canvas 2D and is not the bottleneck: a settled 4,570-node,
5,912-edge graph draws in about 1ms per frame, and canvas holds 60fps to
roughly 20,000 nodes.

## Provenance

| | |
| --- | --- |
| Upstream | https://github.com/d3/d3-force, https://github.com/d3/d3-quadtree, https://github.com/d3/d3-dispatch, https://github.com/d3/d3-timer |
| Source | npm registry tarballs, `dist/<name>.min.js` taken from each. Tarballs are not committed |
| Licence | ISC, Copyright Mike Bostock, reproduced verbatim in `LICENSE.txt`. All four packages carry the identical licence text, which is why one file covers them |

Per package: the registry tarball's SHA-1 and SHA-512 as the registry
publishes them (`npm view <package>@<version> dist.shasum dist.integrity`),
and the SHA-256 of the one file extracted from it as it sits in this directory.

| Package | Version | Tarball SHA-1 | Tarball SHA-512 (base64) | File taken | Bytes | SHA-256 of the extracted file |
| --- | --- | --- | --- | --- | --- | --- |
| d3-quadtree | 3.0.1 | `6dca3e8be2b393c9a9d514dabbd80a92deef1a4f` | `04xDrxQTDTCFwP5H6hRhsRcb9xxv2RzkcsygFzmkSIOJy3PeRJP7sNk3VRIbKXcog561P9oU0/rVH6vDROAgUw==` | `dist/d3-quadtree.min.js` | 5,279 | `57e2ad12824ed82893ba447523f2a2fb9beeb9222aafb2c778a9f5b313348b0e` |
| d3-dispatch | 3.0.1 | `5fc75284e9c2375c36c839411a0cf550cbfc4d5e` | `rzUyPU/S7rwUflMyLc1ETDeBj0NRuHKKAcvukozwhshr6g6c5d8zh4c2gQjY2bZ0dXeGLWc1PF174P2tVvKhfg==` | `dist/d3-dispatch.min.js` | 1,901 | `94b3bbdb6b98dc1325a15762b051013e8253999b0e0436b27d1da17b952ba0af` |
| d3-timer | 3.0.1 | `6284d2a2708285b1abb7e201eda4380af35e63b0` | `ndfJ/JxxMd3nw31uyKoY2naivF+r29V+Lc0svZxe1JvvIRmi8hUsrMvdOwgS1o6uBHmiz91geQ0ylPP0aj1VUA==` | `dist/d3-timer.min.js` | 1,947 | `911ceda305f014b6b53ca68d5c896a9a387da120cfd56a421a2c60cca2fc9b36` |
| d3-force | 3.0.0 | `3e2ba1a61e70888fe3d9194e30d6d14eece155c4` | `zxV/SsA+U4yte8051P4ECydjD/S+qeYtnaIyAs9tgHCqfguma/aAQDjo85A9Z6EKhBirHRJHXIgJUlffT4wdLg==` | `dist/d3-force.min.js` | 8,300 | `1e07b473241328795d5ea9ad479a7bbabd765012fa2ef95633c83b69868dff6b` |

On 2026-09-07 each tarball was fetched from the registry with `npm pack`, its
SHA-1 and SHA-512 were computed locally and both were checked against the
registry's own metadata for that version before the file was extracted. All
eight matched. The SHA-256 column is of the extracted file, so the table can
be checked against this directory without fetching anything:
`shasum -a 256 public/vendor/d3-force/*.js`.

## Updating

Same procedure as `../d3-hierarchy/README.md`: fetch each tarball, verify both
hashes against the registry metadata, extract `dist/<name>.min.js`, and update
the table including the SHA-256 of the new file. Keep all four on one d3 major
line. Load order in `index.html` is quadtree, dispatch, timer, then force, and
all four ahead of `views/graph.js`.
