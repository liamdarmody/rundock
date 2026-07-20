# Content and Copy Gap Analysis

- **Date / release context:** `package.json` reads version 0.10.0 (Search, Review & Codex, shipped 2026-07-14). The "Files, Boards & Streaming" body sits in `## Unreleased` in `Rundock/CHANGELOG.md`, staged as the imminent 0.11.0. Public site and docs imagery and feature copy date from late April (all five screenshots in `Rundock Site/images/` and the site root are stamped 29 Apr; the site feature sections have not changed since). Everything shipped from 0.10.0 onward, and the whole Unreleased block, is effectively uncommunicated.

- **Method:** I read the full `Rundock/CHANGELOG.md` (Unreleased + 0.10.0 in detail, earlier entries for the feature inventory), the marketing site (`Rundock Site/index.html` in full, plus `llms.txt`, `compare.html`), and the docs site (`rundock-docs/`: `docs.json` navigation, `introduction.mdx`, all of `concepts/`, `first-run.mdx`, `reference/workspace-structure.mdx`). For each shipped capability I checked whether the behaviour is described anywhere on the Site and in the Docs, then located the exact file and section where it belongs. The Site is static HTML (hand-authored `index.html`, feature sections are `<section class="feature-section">` blocks around lines 1568-1657). The Docs are Mintlify MDX, navigation defined in `docs.json`.

## Summary table

| Feature | Shipped in | Shown on Site? | Shown on Docs? | Gap severity |
|---|---|---|---|---|
| Universal search (Cmd+K) | 0.10.0 | No | No | High |
| In-editor review loop (CriticMarkup comments, agent accept/reject) | 0.10.0 | No | No | High |
| Any-file-type viewer (HTML/SVG/PNG/PDF etc, locked-down preview) | Unreleased 0.11 | No (Files section says "markdown rendering" only) | No | High |
| Rich markdown editor (format-as-you-type, tables, wikilinks) | 0.8.11 / 0.10.0 | No (still "preview and edit") | No | High |
| Kanban boards (Obsidian-compatible) | Unreleased 0.11 | No | No | Medium |
| Review extended to HTML/SVG artifacts | Unreleased 0.11 | No | No | Medium |
| Codex second runtime (specialists on ChatGPT plan) | 0.10.0 | Partial (positioning only) | Yes (`runtimes.mdx`) | Low (Site), Covered (Docs) |
| Codex streaming + permission cards mid-turn | Unreleased 0.11 | No | Stale (`runtimes.mdx` says no cards) | High (Docs, on 0.11) |
| Frontmatter editing in the panel | Unreleased 0.11 | No | Stale (`workspaces` implies read-only era) | Medium |
| Obsidian callouts render/edit in place | 0.8.11 / 0.11 | No | No | Low |
| Live external file refresh + overwrite guard | Unreleased 0.11 | No | No | Low |
| Conversation Lists | Unreleased 0.11 | No | No | Medium |
| Files sidebar create/reveal, keeps your place | Unreleased 0.11 | No | No | Low |
| Draft while agent responds | Unreleased 0.11 | No | No | Low |
| Runtime-adaptive first-run setup (Codex detection step) | Unreleased 0.11 | No | Stale (`first-run.mdx`, `runtimes.mdx`) | Medium |
| Pinned filter pill removed (pins always on top) | 0.10.0 | n/a | Stale (`conversations.mdx` still lists it) | Medium (factual error) |
| Resizable sidebar / review panel | 0.10.0 | No | No | Low |

## Site gaps

The Site's four feature sections (`index.html` lines 1568-1657: Team, Conversations, Skills, Files) are the marketing surface. Match the existing pattern: a short `<h2>` behaviour headline and a one or two sentence paragraph. I am proposing one rewritten section, two new sections, and a stale-copy fix, plus a `llms.txt` refresh.

### Site gap 1 (High): the "Files" section undersells the workspace to "markdown rendering"

**What's missing:** Section 5d (`index.html` lines 1637-1657) still says "full markdown rendering" and "Browse, preview, and edit those same files." Since then Rundock shipped a rich editor (formats as you type, tables, wikilinks, callouts, frontmatter properties) and a viewer for any file type (HTML and SVG rendered live in a locked-down preview, images, PDFs). This is now one of the strongest reasons to use Rundock over the terminal, and the copy predates all of it.

**Where to change:** `Rundock Site/index.html`, the `feature-copy` block inside section 5d (lines 1644-1647). Replace the `<h2>` and `<p>`.

**Ready-to-paste copy:**
```html
<h2>Not just markdown. Any file your agents touch.</h2>
<p>Open a note in an editor that formats as you type, with tables, callouts, and clickable wikilinks. Open an HTML or SVG file and see the real rendered page, not its source. Open an image or a PDF and read it in place. Edit a file's properties without touching raw YAML. It is your workspace, shown the way you would expect to see it.</p>
```

### Site gap 2 (High): universal search has no presence

**What's missing:** Cmd+K searches file contents and names, conversation messages, and agent and skill names from one palette. It shipped in 0.10.0 as a headline feature and appears nowhere on the Site. For anyone weighing Rundock as a place to keep their whole business, "find anything instantly" is a strong, concrete claim.

**Where to change:** `Rundock Site/index.html`. Add a new `<section class="feature-section">` after section 5d (after line 1657), before the diversity section. Use the `reverse` layout variant to keep the alternating rhythm.

**Ready-to-paste copy (copy block; screenshot slot to be captured):**
```html
<h2>One shortcut finds everything you have.</h2>
<p>Press Cmd+K and search across every file, every conversation, and every agent and skill at once. Type part of a word and it still finds the match. Pick a result and it opens at the right place, scrolling a conversation straight to the message you were looking for.</p>
```

### Site gap 3 (High): the review loop is invisible, and it is a real differentiator

**What's missing:** You can select text in a file an agent wrote, leave an anchored comment, and the agent proposes an inline edit you accept or reject, all stored in the file itself as plain text. No competitor framing on the Site captures "review your agent's work where it lives." This is the kind of behaviour that separates a team you manage from a chatbot you copy-paste out of.

**Where to change:** `Rundock Site/index.html`. Add a second new `<section class="feature-section">` alongside the search section (non-reverse layout).

**Ready-to-paste copy:**
```html
<h2>Review your agent's work where it lives.</h2>
<p>Select any passage in a file an agent produced and leave a comment. The agent reads it, proposes an edit inline, and you accept or reject with a click. The feedback lives in the file as plain text you can read in any editor, so nothing is locked inside Rundock.</p>
```

### Site gap 4 (Medium): Kanban boards

**What's missing:** A markdown file that is an Obsidian Kanban board opens as a real column board you drag cards across, and it writes back the exact same markdown so it stays interchangeable with Obsidian. Visual and demo-friendly. Optional for the Site depending on how many feature sections you want, but it photographs well.

**Where to change:** Either a fifth feature section, or fold a line into Site gap 1's Files section. If a standalone section, place it after the review section.

**Ready-to-paste copy (standalone):**
```html
<h2>Your boards, not just your notes.</h2>
<p>A Kanban board in your workspace opens as a real column board. Drag cards, tick them off, rename and reorder columns. It writes back the same markdown Obsidian uses, so the same board edits cleanly in both.</p>
```

### Site gap 5 (Medium): `llms.txt` Core Features list is stale

**What's missing:** `Rundock Site/llms.txt` is the machine-readable feature list AI tools read. Its "Core Features" section (the `## Core Features` block) omits universal search, the review loop, the file viewer, Kanban boards, and markdown tables entirely, and its "Shared workspace" bullet still says "browse, preview, and edit those files in Rundock with markdown rendering." As agents increasingly answer "what does Rundock do", this is worth keeping current.

**Where to change:** `Rundock Site/llms.txt`, the `## Core Features` list. Replace the "Shared workspace" bullet and add three bullets.

**Ready-to-paste copy (add / replace bullets):**
```
- **Shared workspace with a real editor.** Agents and files live in one folder on your machine. You open notes in an editor that formats as you type (tables, callouts, wikilinks, editable properties), and open HTML, SVG, images, and PDFs as rendered files, not source.
- **Universal search.** One shortcut (Cmd+K) searches file contents and names, conversation messages, and agent and skill names, with forgiving partial matching and results that open at the right place.
- **Review agent work in place.** Comment on any passage in a file an agent produced; the agent proposes inline edits you accept or reject. Feedback is stored in the file as plain text, no lock-in.
- **Kanban boards.** Obsidian-compatible boards open as real column boards you drag cards across, and write back the same markdown so they stay interchangeable with Obsidian.
```

## Docs gaps

The Docs have no page at all covering files, the editor, boards, search, or the review loop. The `Concepts` group in `docs.json` runs how-rundock-works, how-rundock-compares, workspaces, agents, skills, conversations, runtimes, routines. Files and search are conceptually first-class now and deserve their own pages.

### Docs gap 1 (High): no page covers the file viewer, editor, boards, or review loop

**What's missing:** Everything about working with files. The editor (0.8.11), tables and review (0.10.0), and the any-file viewer, boards, frontmatter editing, and callouts (Unreleased) are described nowhere. `how-rundock-works.mdx` and `workspaces.mdx` mention files only as things agents read and write.

**Where to add:** A new page `rundock-docs/concepts/files.mdx`, registered in `docs.json` under the `Concepts` group (suggested position: after `conversations`).

**Ready-to-paste copy (new page skeleton in Rundock's voice):**
```mdx
---
title: 'Files and the editor'
description: 'How you view, edit, and review the files in your workspace, from markdown notes to HTML, images, boards, and PDFs.'
---

Your workspace is a folder of files, and Rundock is where you work with them. Agents read and write these files; you view, edit, and review the same files without leaving the app.

## The markdown editor

Markdown files open in an editor that formats as you type. Headings, bold, lists, and links render live rather than showing raw syntax. Wikilinks are clickable and navigate to the linked file. Tables open cell by cell: click in and type, and your file's exact spacing and alignment are preserved on save. Callouts render as coloured boxes you can expand, collapse, and edit in place.

Every save is byte-honest: editing one line changes only that line, and the rest of the file comes back exactly as it was.

## Properties without raw YAML

A file's frontmatter appears in a properties panel above the editor. Click a value to edit it, toggle a boolean, add or remove list items, and follow property links on click. You change properties without touching the raw YAML, and an edit that would corrupt the frontmatter is refused rather than guessed.

## Any file type, not just markdown

Open an HTML or SVG file and Rundock shows the real rendered page, with its own styles and fonts, in a locked-down preview where scripts never run and the page cannot reach the network. Images open as images; PDFs open as readable documents. File types Rundock cannot preview say so plainly. The Edit toggle still shows editable source for text and HTML.

## Kanban boards

A markdown file that is an Obsidian Kanban board opens as a real column board. Drag cards between columns, add and edit cards in place, tick them off, and rename, move, sort, archive, or delete columns. Everything writes back as the exact markdown the Obsidian Kanban plugin produces, so the same board edits interchangeably in Rundock and Obsidian.

## Reviewing agent work

When an agent produces a file, you review it where it lives. Select a passage and press Comment to leave anchored feedback. Agents propose inline edits with Accept and Reject buttons, replies thread and resolve, and a review panel lists everything open. Feedback is stored in the file itself as CriticMarkup, a small block of plain text readable in any editor, attributed honestly: you show as "Me", agents under their names. The same review flow now covers rendered HTML and SVG files, not only markdown.

## Files stay in sync

A file you have open updates in place when it changes on disk, whether an agent, Obsidian, or another window changed it. If you have unsaved edits when that happens, the next save offers a clear choice, reload theirs or keep yours, instead of overwriting silently.
```

### Docs gap 2 (High): universal search has no page

**What's missing:** Cmd+K and how search works (what it covers, forgiving matching, the local index in `.rundock/`) are undocumented.

**Where to add:** Either a new `rundock-docs/concepts/search.mdx` in the `Concepts` group, or a "Finding things" section appended to `concepts/conversations.mdx`. A dedicated page is cleaner because search spans files, conversations, and agents, not just conversations.

**Ready-to-paste copy (new page):**
```mdx
---
title: 'Search'
description: 'One palette finds file contents and names, conversation messages, and agent and skill names across the whole workspace.'
---

Press Cmd+K (Ctrl+K on Windows and Linux) to open one keyboard-first palette that searches your whole workspace at once: file contents and names, conversation messages and titles, and agent and skill names. Results are grouped and ranked, with the matching text highlighted.

Matching is forgiving. You can type partial words as you go, so "rdmp" finds "Roadmap-2026". An empty query shows your recent items. Every result opens at the right place: pick a conversation and it scrolls to the matched message and highlights it.

Search reaches inside rendered HTML and SVG files (visible text only, never markup or styles) and matches frontmatter property values, not just their names. Cmd+F searches within whatever you have open: a conversation, an editor, a rendered file preview, or the properties panel.

## How it works

The index is a small local file inside your workspace's `.rundock/` folder, rebuilt automatically. It never leaves your machine. Where the index engine is not available, search falls back to a simpler scan rather than failing.
```

### Docs gap 3 (Medium, factual error): `conversations.mdx` still lists the removed "Pinned" filter pill and omits Lists

**What's missing / wrong:** `rundock-docs/concepts/conversations.mdx` line 31 lists filter pills as "(All, Unread, Pinned)". 0.10.0 removed the Pinned pill (pinned conversations are always grouped at the top now). The page also predates conversation Lists (Unreleased), which group conversations into named pills beside All and Unread.

**Where to change:** `concepts/conversations.mdx`, the "What the sidebar tells you" list (lines 29-34). Fix the pill line and add a Lists bullet.

**Ready-to-paste copy (replace the "Filter pills" bullet, add a bullet):**
```mdx
- **Filter pills** (All, Unread) sit above the list. Tap a pill to narrow the list to what needs attention right now. The Unread pill auto-hides when nothing is unread. Pinned conversations are always grouped at the top, so there is no separate Pinned pill.
- **Lists** let you group conversations by hand. Right-click any conversation to add it to a named list, or create one on the spot. Lists appear as their own pills beside All and Unread and filter the sidebar. A conversation can belong to several lists, and deleting a list never deletes the conversations in it.
```
Add a short "Finding a conversation" line cross-linking to the new search page if Docs gap 2 lands.

### Docs gap 4 (High on 0.11 release): `runtimes.mdx` will be stale on Codex permission behaviour

**What's missing / will be wrong:** `rundock-docs/concepts/runtimes.mdx` currently states (lines 38-39) "You will not see Rundock permission cards in a Codex conversation; the sandbox confines the agent." The Unreleased entry changes exactly this: Codex agents now stream, and any action needing extra access raises the familiar permission card mid-turn, on every platform. Do not change this until 0.11 ships, but it is queued to go stale.

**Where to change (on 0.11 release):** `concepts/runtimes.mdx`, "Permissions and sandboxing" section (lines 35-52). The "Codex agents use Codex's own built-in sandbox instead" bullet and the Windows subsection both need reworking to say permission cards now appear mid-turn for out-of-sandbox actions and writes.

**Ready-to-paste replacement bullet (hold until 0.11):**
```mdx
- **Codex agents** stream their replies as they think, over one long-lived process. Any action that needs extra access, a command outside the sandbox or a write it cannot normally make, raises the same permission card you approve or deny, mid-turn, on every platform. An ignored request is declined automatically so a turn never hangs.
```

### Docs gap 5 (Medium, on 0.11 release): `first-run.mdx` and `runtimes.mdx` predate the runtime-adaptive setup

**What's missing:** `first-run.mdx` describes a Claude-only wizard. The Unreleased entry makes first-run detect both Claude Code and Codex: a Codex user is told plainly why Claude Code is still needed, and a machine with the Codex CLI gets an optional Codex sign-in step, skippable and available later from Settings. `runtimes.mdx` line 32 says "Codex setup is currently manual: two commands in any terminal," which the in-wizard step supersedes.

**Where to change:** `first-run.mdx`, section 3 area (add a step covering runtime detection and the optional Codex sign-in); `runtimes.mdx` line 32 (soften "currently manual").

**Ready-to-paste copy (new subsection for `first-run.mdx`, hold until 0.11):**
```mdx
### Setup adapts to the runtimes you have

First-run detects which engines are on your machine. It always sets up Claude Code, which runs your team's orchestrator and Doc himself. If you also have the Codex CLI installed, setup offers an optional step to sign in to Codex, so specialists can run on your ChatGPT plan. The step is skippable, and you can do it later from Settings. A machine without Codex sees the flow exactly as before.
```

## Cross-cutting notes

- **Retire the April imagery.** Every screenshot on both properties is stamped 29 April and predates the current UI (universal search palette, the richer editor, resizable panels, the review sidebar). The Site uses `rundock-app-hero.png`, `agent-profile.png`, `conversation-flow.png`, `skills-detail.png`, `file-browser.png`; the Docs reuse `rundock-app-hero.png`, `file-browser.png`, `conversation-flow.png` in `rundock-docs/images/`. At minimum, recapture `file-browser.png` (it is now materially wrong: it shows a plain preview pane, not the editor) and the hero (to show search or the review panel). Any new Site sections for search, review, and boards need fresh captures.

- **Version string is fine, feature copy is not.** The Site's structured data already reads `"softwareVersion": "0.10.0"` (`index.html` line 36), so the number is current; the prose is the stale part. When 0.11 ships, bump this line too.

- **Priority order for the Site.** 1) Rewrite the Files section (gap 1, one edit, corrects an active undersell). 2) Add the search section (gap 2, headline 0.10.0 feature). 3) Add the review section (gap 3, strongest differentiator). 4) Refresh `llms.txt` (gap 5). 5) Kanban section (gap 4) if you want a fifth feature block.

- **Priority order for the Docs.** 1) New `concepts/files.mdx` (gap 1, largest hole, covers five shipped capabilities). 2) New `concepts/search.mdx` (gap 2). 3) Fix the `conversations.mdx` Pinned-pill error and add Lists (gap 3, it is currently wrong). 4) Hold gaps 4 and 5 until 0.11 promotes, then update `runtimes.mdx` and `first-run.mdx` in the same pass.

- **Two edits are corrections, not additions,** and should go first regardless of the 0.11 timeline: the `conversations.mdx` Pinned pill (removed in the already-shipped 0.10.0) and the Site Files section's "markdown rendering" claim (superseded since 0.8.11). Both currently tell users something untrue.

- **Do not touch the compare tables to add features.** `compare.html` and `concepts/how-rundock-compares.mdx` are positioning tables (context, ownership, effort, price), not feature lists. Adding per-feature rows would dilute them. They carry "checked July 2026" GO-STALE markers on the price rows; that is a separate freshness task and the dates are current.

## What is already well-covered (leave alone)

- **The Codex runtime as a concept.** `rundock-docs/concepts/runtimes.mdx` is thorough and current: per-agent `runtime: codex`, the orchestrator-stays-on-Claude rule, the subscription table, sandboxing, Windows config, and Settings status. Only the permission-card behaviour goes stale on 0.11 (Docs gap 4). The Site references Codex correctly in the hero subline, pricing, the data-privacy flow (section 9), the FAQ, and "the layer that stays yours" (section 10b).

- **Local-first / privacy.** Site section 9, the FAQ, `llms.txt`, `concepts/how-rundock-works.mdx` ("Conversations stay local"), and `trust/data-privacy-security.mdx` all state the local-first story consistently and accurately, including the credentials-file-existence check.

- **Workspace model and file ownership.** `concepts/workspaces.mdx` and `reference/workspace-structure.mdx` are detailed and current on the folder shape, the sync / no-sync split, and workspace modes.

- **Routines, agents, skills, delegation.** The core team and delegation model is well told across `introduction.mdx`, `how-rundock-works.mdx`, `concepts/agents.mdx`, `concepts/skills.mdx`, `concepts/routines.mdx`, and Site sections 5a-5c. These are stable and do not need changes for this cycle.

- **Pricing, licence, get-started flow.** Consistent and correct across Site (hero, FAQ, get-started, footer), `llms.txt`, and Docs (`installation`, `first-run` except the Codex step, `quickstart`).

---

Note on scope: this is a proposal only. No edits were made to `Rundock/`, `Rundock Site/`, or `rundock-docs/`. The two items flagged as active factual errors (the Docs `conversations.mdx` Pinned pill and the Site Files "markdown rendering" copy) describe already-shipped 0.10.0 / 0.8.11 behaviour and can be actioned immediately; the runtimes and first-run Codex changes should wait until the Unreleased block promotes to 0.11.0.
