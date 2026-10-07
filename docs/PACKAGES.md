# Packages

A package is a GitHub repository that Rundock can add to a workspace. This page covers the content half: the agents, skills and routines a package carries, what the install offer says about them, and the receipt an install leaves behind. An extension (a package that ships code which changes how a file opens) is covered in [EXTENSION-HOST.md](EXTENSION-HOST.md).

## Layout

A content package is a plain repository whose folders mirror where things land in the workspace:

| In the package | Lands at | Seen in |
|---|---|---|
| `.claude/agents/<slug>.md` | `.claude/agents/<slug>.md` | Team |
| `.claude/skills/<slug>/` | `.claude/skills/<slug>/` | Skills |
| a `routines:` block in an agent's frontmatter | inside that agent's file | Routines |
| `starter/<path>` | `<path>`, for example `starter/Investments/Portfolio.md` lands at `Investments/Portfolio.md` | Files |

Nothing needs a manifest. A repository with no agents and no skills is not a package, and the install says there is nothing to add; starter files alone do not make one.

## Naming a package

A package can say what people should call it, in a `rundock.json` at its root:

```json
{ "name": "csv-table", "displayName": "CSV Viewer", "version": "1.0.3" }
```

`displayName` is optional. When it is there, the install card, the package's card on the Packages page and the Extensions page's "From the X package" line use it; when it is not, they title-case `name`, so `investment-partner` reads "Investment Partner" but `csv-table` reads "Csv Table". It must be plain text of 1 to 60 characters, with no markup (`<` or `>`), line break or control character, and surrounding spaces are trimmed. A `displayName` that breaks the rule is refused at install, by name, rather than cleaned up. A package of agents and skills may carry a `rundock.json` with just `name`, `version` and `displayName`; a package with an extension adds its `extension` block beside them (see [EXTENSION-HOST.md](EXTENSION-HOST.md)).

## Starter files

Starter files are files of the person's own that a package's agents work on: a portfolio, a watchlist, a decision journal. They are ordinary workspace files, and once they land they belong to the person, not the package.

- **Only where nothing exists.** A starter file is written only when its path is empty. If you already have a file there, yours is kept, and no decision anywhere can replace it. A path is also treated as taken, and never written through, when a symlink or a file stands on the way to it.
- **Never hidden.** Every folder and file name under `starter/` must be visible: a name starting with a dot (`.gitkeep`, `.claude`, `.rundock`) makes the whole package refuse to install, by name, so nothing lands anywhere hidden. So do symlinks, and two paths that differ only by case.
- **Yours afterwards.** Nothing Rundock does later removes a starter file: uninstalling the package leaves it in place, and so does any later install. Delete one like any other file if you no longer want it.
- **Byte for byte.** A starter file lands exactly as the author wrote it.

The install offer names each one by path. The wording it uses:

> Starter files: Investments/Portfolio.md, Investments/Watchlist.md. They're added only where you have nothing at that path, and they're yours from then on: removing the package never removes them.

and, for a path you already have:

> Already in your workspace, so yours is kept: Investments/Portfolio.md.

On the review, a kept starter file has its own row saying so, with nothing to press. The receipt records each starter file with its outcome, and one that arrived links to the file from its package's card on the Packages page.

## What the install asks

Nothing is written until the person confirms, and nothing they already have is replaced unless they switch that item to overwrite themselves. An item that already exists starts decided skip. A routine an agent carries is named on the offer, with its schedule, before the person agrees.

**Approvals never travel with a package.** Rundock ignores any `planApprovedHash` or `planApprovedAt` a package ships, on install and on update, and records its own. A routine the offer says will run itself (switched on, with a schedule) is approved when the person agrees to that offer, in that workspace only, and runs from its next scheduled time; any other routine waits for its first approval in Routines. A copy of that workspace holds it again (see [Routines](ROUTINES.md#an-approval-counts-only-where-it-was-given)). Writing an approval into a package's agent file has no effect, so leave it out.

A package that ships an extension is installed only from a tag or an exact commit, never from a branch; see [Where an extension is installed from](EXTENSION-HOST.md#where-an-extension-is-installed-from).

A link that names no reference installs the repository's newest version tag (`v1.2.0`, or `1.2.0`), for agents and skills as much as for an extension, so what you install has a release number an update can come after. A repository with no version tags installs its default branch at the exact commit fetched, and the receipt records that commit.

## Updating a package

A package updates as one unit from its card on the Packages page: its agents, skills, routines, starter files and extension together, in one step. The review opens under the card.

**Only a new release is offered.** Checking for updates looks for a version tag newer than the one installed, and nothing else: new commits on a branch are never offered, so an update always has a release number and never carries work the author merged before releasing it. A package installed at a commit, because its repository had no tags, is never offered an update; its entry says so, and pasting the link again gets the latest. Rundock checks when you open Packages or press Check for updates, never in the background, and reuses what it learned about a repository for an hour.

**For authors: tag a release to ship updates.** Push a version tag (`v1.3.0`) for every release you want people to receive. Moving a tag after people have installed it is reported to them as a tag that changed, and is never offered as an update.

**Nothing changes until you confirm.** The review lists what the update does, grouped:

- **Changed by the author**: updated. An agent you adopted under your own leader, or pointed at it, keeps that on its new version.
- **New in this version**: added. A new routine is named with its schedule and whether it arrives on or off, and anything that would act without asking is named, exactly as at install.
- **New starter templates**: a starter file is never replaced. When the author changes one, the new template lands beside yours as `Portfolio (v1.3.0).md`, whether or not you edited yours, so you can move your data across when you are ready.
- **You and the author both changed these**, **already in your workspace**, and **changed since they were added**: yours are kept, and the author's version is saved for you to review.
- **These would now act without asking**: an item whose new version adds `hooks`, `permissionMode`, `allowed-tools` or `mcpServers` is not updated; the author's version is saved for you to review.
- **You edited these**: kept, and the author has not changed them.
- **You removed these**: they stay removed.
- **No longer in the package**: kept, and marked.

**Your routine switches are not edits.** Turning a routine on or off, pausing it, choosing where it runs and approving its plan are carried onto the author's new version. If the author changed what a routine does, its next run asks for approval again.

**The author's versions and your backups** are saved under `.rundock/package-updates/<owner>-<repo>/`: the author's version of anything kept as yours in a folder named for the new release, and the previous bytes of everything the update replaced in a folder named for the old one. The folder is hidden on purpose, so a copied data file is never shown as a second dashboard or read by an agent in place of yours. It is kept on this computer only and never removed by itself: the Packages page shows its size with a Clear action, which asks first. After an update that kept anything of yours, the summary offers a prompt to copy and give an agent, naming each of your files beside the author's version.

**All or nothing.** The extension, every agent, skill and starter file, the saved copies and the receipt land together. If anything fails, or Rundock stops part way, nothing changes: an interrupted update is put back the next time the workspace opens. An update waits while a routine of an agent it would change is running, and an extension that is off stays off.

**What an update does not do.** It does not merge your edits with the author's, and it cannot be undone in one step; the backups make the old files available if you need them.

### For authors: when a data format changes

A starter file often holds the person's own data, which an update never touches. If a new version of your extension reads a new format:

- put a `schemaVersion` in the data file's frontmatter (or your format's equivalent);
- have the extension read every format it has ever written, and upgrade a file only when the person saves it;
- ship the new template at a new path, or let Rundock place it beside the old one, and have your agents' instructions name the file they should use.

A migration skill in the package is a welcome extra, but not a substitute: an agent's migration is not deterministic, and the extension must still open the person's existing file.

## Uninstalling a package

Uninstall on a package's card asks first, and lists exactly what would go and what would stay:

- **Goes:** each agent and skill that is exactly as the package installed it, and the package's extension with its record. Switching a routine on or off, pausing it or approving its plan does not count as changing its agent.
- **Stays:** anything you changed since it was installed, and every starter file, whether or not you touched it. They are yours from then on.

Nothing is removed until you press the named button, "Uninstall Investment Partner". Everything that goes, goes together or not at all, and if anything in the package changed after you opened the question, nothing is removed and you are asked to look again. An uninstall waits while a routine of an agent it would remove is running. Removed agents leave the team, so their routines stop with them. The package then leaves the Packages list: there is no separate history, and the receipts that recorded it go with it. The saved author versions and backups in `.rundock/package-updates/` are kept until you clear them.

An extension leaves only with its package. The Extensions page switches each one on or off and names the package it came from; it has no Uninstall of its own. An extension that couldn't load offers "Uninstall it from its package", which opens Packages.

## Receipts

Every install that the person confirmed leaves a receipt at `.rundock/receipts/<date>-<run>.json`, written in the same transaction as the files it describes, so a receipt exists exactly when the install landed. It records the package's source and pinned reference, when it was applied, and one entry per item with its `id`, `kind`, `destination`, the `decision` the person made and the `outcome` (`written`, `unchanged`, `skipped` or `blocked`).

An entry that is in the workspace after the install (`written` or `unchanged`) also records `fingerprint`: the sha256 content digest of the bytes as written. For an agent that is its file as it landed, provenance line included; for a skill it is the whole folder, every file's path and bytes; for a starter file it is the file. Each routine on an agent's entry carries its own `fingerprint`, taken over that routine's fields, so an edit to the routine is told apart from an edit to the agent around it. A skipped or blocked entry has none, because nothing was written there.

Beside it, such an entry records `authored`: the same kind of digest, except that for an agent it leaves out the routine fields Rundock itself writes into the file (`runOn`, `enabled`, `paused`, `planHash`, `planApprovedHash`, `planApprovedAt`). Rundock adds some of those to a routine the first time it reads it, and switching a routine on, pausing it or approving its plan writes others, and none of that is an edit. For a skill or a starter file `authored` equals `fingerprint`. An agent that was adopted under your leader, or re-pointed to it, also records `transform`, naming the leader, so a later update of the package shapes the new version the same way. And when the package came from a link, the receipt's `source` records `commit`, the exact commit that was fetched.

The fingerprint is what lets a later update of the same package tell "the author changed this" from "you edited this": if the file in your workspace still matches its fingerprint, any difference in the new version is the author's. A receipt is history, never authority: an update still reads what is in your workspace now and asks before it changes anything. Deleting a receipt removes that line of history and nothing else.
