# Screenshot placement plan (Site, README, Docs)

A curated proposal for where the generated assets should go and why. The
pipeline produces more than any surface needs on purpose; this plan uses fewer,
better images, each earning its place, and pairs them with copy where a feature
is not self-evident. Proposal only; wiring the repos is Phase 2.

Principle: a still shows a state, a GIF shows a behaviour. Use a GIF only where
the motion is the point (a drag, a live update, a reply streaming in, the org
pulse). Everywhere else, a still is lighter and clearer.

## Asset inventory (per theme, unless noted)

- **Stills:** org-chart, agent-profile, skills, conversations, streaming, files,
  markdown-note, callouts, kanban-board, artifact-review, image-viewer,
  pdf-viewer, search, find, settings (plus element-scoped `-tile` crops).
- **GIFs:** kanban-drag, live-refresh, review-comment, search, streaming,
  org-chart-status.
- **Framing variants:** `hero/` (window chrome), `stills/flat/` (clean master
  for destinations that CSS-frame), `stills/framed/` (self-framed, for
  plain-markdown). All transparent-background, so they drop onto any page.

## Rundock Site (`Rundock Site/index.html`)

The strongest surface. One hero, then a tight run of feature sections. The Site
frames images in its own rounded containers, so it takes the **flat** masters
(or the hero for the top).

| Slot | Asset | Variant | Why | Copy |
|---|---|---|---|---|
| Hero | `org-chart` | hero (chrome), dark | The flagship "one operator, a whole team" image; the org pulse and routines make it read as alive. Replaces the April `rundock-app-hero.png`. | Keep the existing hero headline. |
| Team section (5a) | `org-chart-status` GIF | dark | The live pulse sells "your team, working" better than a still. | Existing Team copy. |
| Conversations (5b) | `streaming` GIF | dark | A reply streaming in is the point; a still of a chat is inert. | Existing copy. |
| Files (5d, rewrite) | `files` or `markdown-note` | flat | Corrects the "markdown rendering" undersell (see gap analysis Site gap 1). | New copy from gap analysis. |
| New: Search | `search` still (or `search` GIF) | flat / dark | Cmd+K is a headline 0.10.0 feature, absent today. | New section, gap analysis Site gap 2. |
| New: Review | `artifact-review` | flat | The strongest differentiator: review your agent's work in place. | New section, gap analysis Site gap 3. |
| New: Boards | `kanban-drag` GIF | dark | Boards are new and photograph as motion. | New section, gap analysis Site gap 4. |
| Skills (5c) | `skills` | flat | Refreshes the April `skills-detail.png`. | Existing copy. |

Retire the April `agent-profile.png`, `conversation-flow.png`, `file-browser.png`
once the above land.

## GitHub README (`Rundock/README.md`, `docs/`)

A README is not a gallery. One hero and at most three features, all
plain-markdown, so use the **self-framed** variants (README-width derivations).

| Slot | Asset | Variant | Why |
|---|---|---|---|
| Hero | `org-chart` | hero, README-width, dark | The single strongest image. |
| Feature | `artifact-review` | self-framed, README-width | The differentiator, reads in one glance. |
| Feature | `search` | self-framed, README-width | Concrete, universally understood. |
| Feature | `kanban-board` | self-framed, README-width | Shows the workspace is more than chat. |

Hold GIFs out of the README (weight, and they autoplay unevenly on GitHub). If
one GIF is wanted, `org-chart-status` is the most on-brand.

## rundock-docs (Mintlify MDX)

The workhorse: this is where the long tail belongs, one or two images per
concept page, tied to explanatory copy. Docs frame in their own containers, so
prefer **flat** masters; use **self-framed** only on any raw-markdown page.

| Page | Asset(s) | Notes |
|---|---|---|
| `introduction.mdx` (hero) | `conversations` (hero, chrome) | Product-in-use hero. |
| `concepts/files.mdx` (new) | `files`, `markdown-note`, `callouts`, `kanban-board`, `artifact-review`, `image-viewer`, `pdf-viewer`; `live-refresh` GIF; `kanban-drag` GIF | The largest hole (gap analysis Docs gap 1). One image per subsection: editor, properties, any-file, boards, review, sync. |
| `concepts/search.mdx` (new) | `search`, `find` | New page (gap analysis Docs gap 2). |
| `concepts/agents.mdx` | `agent-profile`, `org-chart` | Role, skills, routines on a profile; the hierarchy. |
| `concepts/skills.mdx` | `skills` + `skills-tile` | List plus a detail. |
| `concepts/conversations.mdx` | `conversations`, `streaming` GIF | Also fixes the Pinned-pill error and adds Lists (gap analysis Docs gap 3). |
| `concepts/routines.mdx` | `org-chart` (routines panel visible) | The scheduled-work panel. |
| `concepts/runtimes.mdx` | `settings` | Runtimes surface. |

## Copy that placement needs

- **Site:** three new section headers and one rewrite, all drafted in
  `content-and-copy-gaps.md` (Files rewrite, Search, Review, Boards).
- **Docs:** two new pages (`concepts/files.mdx`, `concepts/search.mdx`) with
  skeletons already drafted in `content-and-copy-gaps.md`, plus one-line captions
  under each image and alt text on every image.
- **README:** a one-line caption under each of the three feature images.

## What to drop

Not every shot earns a home. `find`, `image-viewer`, `pdf-viewer`, and the
`settings` still are reference-only: keep them for the Docs `files`/`runtimes`
pages if useful, but they are not Site or README material. The `review-comment`
GIF overlaps the `artifact-review` still; pick one per surface (still for the
Site section, GIF only if a page wants the motion).

## Open composition note

The `org-chart` still leaves vertical breathing room: the tree is wide and short,
so it fits the panel width at a small scale and cannot zoom up without
overflowing. It reads as a balanced, centred composition rather than the old
top-third dead canvas, but it is not edge-to-edge. Two ways to tighten it if you
want a denser hero: (a) a content-aware crop that trims the empty lower-right of
the main panel, or (b) hide the left sidebar for the hero so the tree fills the
full width (this also removes the tree/sidebar name duplication the review
flagged, at the cost of the routines-panel context). Flagged for a decision, not
yet applied.
