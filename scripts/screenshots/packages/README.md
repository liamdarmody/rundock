# Vendored example packages

Release copies of four public Rundock packages, used only by the screenshot pipeline. `generate-workspace.mjs` installs them into the demo workspace through Rundock's own install code, with no network, and serves each from a local git repository so the install review and the update check run unchanged.

| Folder | Repository | Release | Commit |
|---|---|---|---|
| `investment-partner/` | github.com/liamdarmody/rundock-investment-partner | v1.0.0 | 6d0d3b677bcaedeb45719df8cf595dcdaedddbc9 |
| `csv-table/` | github.com/liamdarmody/rundock-csv-extension | v1.0.4 | 7a285a82d63b85b9bb38ae6e5509a4213863ea70 |
| `lean-agent-team/` | github.com/liamdarmody/lean-agent-team | v1.2.0 (and `v1.2.1/rundock.json`, the only installable file v1.2.1 adds) | 7e04e7a8dcaef957909c77928412d94bb3b556a2 |
| `my-tracker/` | github.com/liamdarmody/rundock-package-starter, `extension-package/` | no release; pinned to a commit | 47e44e8c18af63ce882085453332bffc113d05e6 |

Only what an install reads is kept: the manifest, the view, agents, skills and starter files. Tests, tooling, READMEs and licence files are left in their repositories. Each package is MIT-licensed; its licence and copyright notice are in its repository at the release above.

## Edits for the demo

The demo runs against a clock frozen at 2026-07-18, so a few bytes differ from the release:

- `investment-partner/starter/Investments/`: every date in Portfolio, Risk Profile and Decision Journal is moved back into June and July 2026, before the frozen clock, and Portfolio's `"sample"` is `false`, so the dashboard draws the demo holdings without the first-run sample banner. The holdings, limits and decisions are invented.
- `lean-agent-team/.claude/skills/clean-a-note/SKILL.md`: one sentence reworded, with the same meaning, so the vendored text passes this repository's wording checks.

To refresh a package, replace its folder with the files at the new release, keep the two edits above, and update the table.
