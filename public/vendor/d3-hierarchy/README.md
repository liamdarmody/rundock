# d3-hierarchy, vendored

The org chart's layout library. `public/views/team.js` calls `d3.hierarchy()`
and `d3.tree()` with no guard, so until 0.11.7 the **team view threw outright
on a machine with no internet**: the library was loaded from a CDN on every
launch.

That was not a considered trade-off. The line directly below it in
`index.html` loads highlight.js with a comment saying it is "vendored locally
so code-block highlighting works offline". The same decision had already been
made one line away, and this script was missed.

| | |
| --- | --- |
| Upstream | https://github.com/d3/d3-hierarchy |
| Version | 3.1.2 |
| Source | npm registry tarball `d3-hierarchy-3.1.2.tgz` |
| SHA-1 | `b01cd42c1eed3d46db77a5966cf726f8c09160c6` |
| SHA-512 | `FX/9frcub54beBdugHjDCdikxThEqjnR93Qt7PvQTOHxyiNCAlvMrHhclk3cD5VeAaq9fxmfRp+CnWw9rEMBuA==` |
| File taken | `dist/d3-hierarchy.min.js` (14,828 bytes) |
| Licence | ISC, reproduced verbatim in `LICENSE.txt` |

Both hashes were checked against the registry's own metadata before the file
was extracted, and the extracted file is **byte-for-byte identical** to what
`cdn.jsdelivr.net` was serving to the app, so vendoring it changed nothing
about what runs.

## Why a committed file rather than an npm dependency

Rundock has no client build step, so a dependency in `package.json` would still
need copying or a route to reach the browser. `public/vendor/` is where
highlight.js already lives for exactly this reason, and a committed file is the
version that cannot differ between two machines.

## Updating

Fetch the tarball from the registry, verify both hashes against the registry
metadata, extract `dist/d3-hierarchy.min.js` and `LICENSE`, and update the
table. The tarball is not committed.
