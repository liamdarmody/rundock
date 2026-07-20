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

**One image per concept page.** An earlier draft of this plan padded
`files.mdx` with eight images plus two GIFs, which was a dumping ground, not
curation. A concept page needs a single image that anchors the idea. Docs frame
in their own containers, so use the **flat** masters.

| Page | Asset | Why |
|---|---|---|
| `introduction.mdx` (hero) | `org-chart` hero | The team model, up front. |
| `concepts/files.mdx` (new) | `markdown-note` | Files render richly (properties, callouts, wikilinks); boards and review get their own coverage rather than a pile here. |
| `concepts/agents.mdx` | `agent-profile` | How an agent is actually configured. |
| `concepts/skills.mdx` | `skills` | List plus a populated detail. |
| `concepts/conversations.mdx` | `conversations` | The daily surface; also fixes the Pinned-pill error and adds Lists (gap analysis Docs gap 3). |
| `concepts/search.mdx` (new) | `search` | Cmd+K, one shot. |

Boards and review already appear on the Site and README; in Docs, add them to
`files.mdx` inline only if a section genuinely needs them, and use a GIF only
where the motion is the point. No dedicated `find`, `settings`, `pdf-viewer`, or
`image-viewer` pages: those are reference states, not concept anchors.

## Copy that placement needs

- **Site:** three new section headers and one rewrite, all drafted in
  `content-and-copy-gaps.md` (Files rewrite, Search, Review, Boards).
- **Docs:** two new pages (`concepts/files.mdx`, `concepts/search.mdx`) with
  skeletons already drafted in `content-and-copy-gaps.md`, plus one-line captions
  under each image and alt text on every image.
- **README:** a one-line caption under each of the three feature images.

## Cut from the shortlist (they earn no place)

Honest curation means some shots are used nowhere:
- **`streaming` still** and **`settings` still**: dropped from the pipeline (the
  first was a buggy capture, the second leaked a build path). Streaming lives as
  a GIF; runtimes are text, not a hero.
- **`pdf-viewer`, `image-viewer`, `find`**: placeholder-file and
  duplicate-of-search shots. "Any file opens inline" is proven once inside
  `files.mdx`; it does not need dedicated shots of a synthetic PDF and a gradient
  image, and `find` overlaps `search`.
- **`callouts` and the `-tile` crops** as standalone assets: fold into their
  parents (`markdown-note`, `skills`).

The set that actually carries each surface:
- **Site (new user):** `org-chart` hero, `artifact-review`, and the `search` and
  `kanban-drag` GIFs. Four assets do the pitch.
- **Docs (existing user):** `agent-profile`, `conversations`, `markdown-note`,
  with `kanban-board` and `artifact-review` where a page needs them.

## Open composition note

The `org-chart` still leaves vertical breathing room: the tree is wide and
short, so it fits the panel width at a small scale and cannot zoom up. It now
reads as balanced and centred rather than top-third dead canvas, but it is not
edge-to-edge, the platform "Doc" node sits low, and the sidebar duplicates every
name. The strongest fix, endorsed by both design reviews: hide the left sidebar
for the hero so the tree fills the width and the duplication disappears. Flagged
for a decision, not yet applied.
