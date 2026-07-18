---

kanban-plugin: board

---

## Guidance

- [ ] **What goes on the backlog**
	  A backlog item describes a specific piece of work that could help deliver a roadmap card. It is tactical: you know the problem, you have a proposed approach, and you can write acceptance criteria that tell you when it's done.
	  Every Ready / In Progress / Done item must link up to exactly one roadmap card. Inbox items can sit unlinked while being triaged.
- [ ] **Card title format**
	  Imperative verb, specific scope.
	  Good: "Gate onboarding orchestrator default behind [WORKSPACE_ANALYSIS] block"
	  Good: "Port rundock-guide mode-gating fix to scaffold"
	  Bad: "Fix Doc" (too vague)
	  Bad: "Specialists need valid parents" (that's a roadmap card)
- [ ] **Problem statement: pick the format that fits**
	  **Format A (user story):** use for user-facing work where user and value are the point.
	  `As a [user type], I want [capability], so that [outcome].`
	  **Format B (problem statement):** use for platform, infra, or internal work where "as a user" is fiction.
	  `[Current broken state]. [User-visible consequence]. [Why it matters now.]`
	  Don't force-fit. Pick whichever makes the problem clearer.
- [ ] **Card body (required and optional fields)**
	  Required:
	  • **Problem:** Format A or Format B above
	  • **Acceptance criteria:** checklist of observable conditions, not opinions
	  • **Tags:** must include a `#type/...` tag (see Tagging scheme)
	  • **Parent:** wikilink to the [[Rundock-Roadmap]] card this item ladders up to. Required for `#type/feature`, optional for `#type/bug`, `#type/hygiene`, `#type/ops` (see Parent rule)
	  Optional:
	  • **Approach:** one paragraph on how you plan to solve it
	  • **Files touched:** rough list, not exhaustive
	  • **Dependencies:** other backlog items or external blockers
	  • **Out of scope:** what you're explicitly NOT doing in this item
	  • **Notes:** technical context, commit hashes, transcript links
- [ ] **Columns (workflow states)**
	  **Inbox:** captured, not yet refined. May lack a parent roadmap card. One-liners are fine here.
	  **Ready:** fully specced against the Definition of Ready below. Parent roadmap card linked. Could be picked up today. Top of column = next to pull.
	  **In Progress:** actively being worked. Ideally no more than one or two items at a time.
	  **Done:** work complete, committed to main, awaiting release. Items live here between merge and `npm run release`.
	  **Shipped:** in a tagged release users can download. Items move here from Done when the release ships. Kept for 30 days, then archived to `04_Archive/`.
- [ ] **Definition of Ready (INVEST, Bill Wake)**
	  Before moving an item from Inbox to Ready, it must be:
	  • **Independent:** can be shipped without waiting on another backlog item, or the dependency is explicit
	  • **Negotiable:** the approach isn't locked. You could ship a smaller or different version and still address the problem
	  • **Valuable:** feature work links to a roadmap card so the value is traceable; maintenance work (bug, hygiene, ops) has a clear problem statement and user-visible impact
	  • **Estimable:** you can t-shirt-size it (xs / s / m / l / xl). If you can't, it needs more shaping
	  • **Small:** fits in a single work session ideally, one week maximum. Larger means split it
	  • **Testable:** has acceptance criteria that are observable, not opinions
- [ ] **Backlog Health Review (DEEP, Roman Pichler)**
	  Run this monthly. The backlog as a whole should be:
	  • **Detailed appropriately:** items near the top of Ready are fully specced. Items in Inbox can be one-liners. Don't over-spec what you might never build
	  • **Emergent:** items change as you learn. Rewriting is normal. Delete items that no longer matter
	  • **Estimated:** every item in Ready has a size tag
	  • **Prioritised:** Ready column is ordered top-to-bottom by pull order
	  Without this review, the backlog rots into an unreadable dumping ground.
- [ ] **Tagging scheme**
	  `#type/...` **(required)** feature, bug, hygiene, ops. Governs whether a parent roadmap card is required (see Parent rule).
	  `#area/...` platform, scaffold, docs, release, onboarding (matches roadmap)
	  `#size/...` xs, s, m, l, xl (t-shirt, not story points)
	  `#priority/...` p1, p2, p3
	  `#status/blocked` optional flag beyond column (use sparingly)
- [ ] **Parent rule**
	  Every `#type/feature` item in Ready / In Progress / Done must link to exactly one roadmap card via `[[Rundock-Roadmap]]` wikilink. `#type/bug`, `#type/hygiene`, and `#type/ops` items can stand alone without a parent: maintenance work flows through the backlog without needing strategic framing. Inbox items can be unlinked regardless of type.
	  If a feature item has no viable parent, either archive it or promote its underlying idea to a new roadmap card first. If a string of related bug fixes or hygiene items reveals a pattern worth tracking strategically, that's a signal to create a roadmap card and retro-link the existing items to it.
- [ ] **Example card (Format B, no parent, copy and adapt)**
	  **Preserve blank line after Unreleased heading promotion**
	  **Problem:** When `promoteUnreleasedChangelog` in `scripts/release.js` promotes `## Unreleased` to a versioned heading, the Name line is stripped but the trailing blank line is consumed with it, leaving the new heading adjacent to the body paragraph with no blank line between them. 0.8.4 shipped with a manual post-hoc fix. Every release cut requires the same manual touch-up until this is corrected.
	  **Approach:** Adjust the regex in `promoteUnreleasedChangelog` to preserve one blank line between the new heading and the body. Self-contained, roughly 5 lines.
	  **Acceptance criteria:**
	  - [ ] Running the release script produces changelog output with exactly one blank line between the new versioned heading and the body paragraph
	  - [ ] No manual edit required post-release
	  **Files touched:** `scripts/release.js`
	  #type/bug #area/release #size/xs #priority/p2
- [ ] **Example card (Format A, with parent, copy and adapt)**
	  **Show a completion toast when an agent is saved**
	  **Parent:** [[Rundock-Roadmap#specialists-land-on-the-org-chart-with-a-valid-parent]]
	  **Problem:** As a Rundock user creating a new agent, I want a visible confirmation when the save completes, so that I know the action succeeded without having to refresh the sidebar.
	  **Acceptance criteria:**
	  - [ ] A toast appears within 500ms of a successful SAVE_AGENT marker
	  - [ ] The toast includes the new agent's display name
	  - [ ] No toast appears on SAVE_AGENT failure (error surfaces in chat instead)
	  #type/feature #area/platform #size/s #priority/p2


## Inbox

- [ ] **Requests: transfer the Edition surface into Rundock (GATED: Liam deems the Edition experiment ready)**
	  **Problem:** The self-improving-team mechanism needs a workspace-level approval surface: one inbox where loop and agent proposals arrive, carry attributed human verdicts, and land in an append-only decision ledger. This exists and is live-proven as Edition (standalone, outside the repo; the RA1 eval's steer-approvals and rejection rendered as an auditable Decided trail with zero UI-owned state). Rundock's spend-governance positioning card is gated on this feature existing in-product.
	  **Approach (the transfer is pre-engineered; see the CC1 spec's build-reality note):** reimplement `lib/host-adapter.js` against Rundock's server (`.rundock/` stores, Files-viewer links, session links); mount Edition's client and API routes as a Rundock view; `lib/store.js`, `lib/ledger.js`, and the Edition client transfer untouched; the masthead shell and personal-OS queue registry retire; on completion the Edition repo decommissions (ledgers, staging contracts, and the spec carry everything that compounded).
	  **Contract alignment (binding):** the verdict/handback payload aligns with the one interaction language used by the file-level review loop (shipped 0.10.0) and the FV2 batch-verdict surface, so file, batch, and workspace approvals share one primitive.
	  **Dependencies:** HARD: Liam's validated-in-use readiness verdict on Edition: BAR SET 2026-07-16: Edition runs as the daily driver through end of July; if it holds up (decisions keep flowing, the inbox is not abandoned), the gate opens 2026-08-01. Also: the dispatcher extraction with ledger-ready attributed events (quiet-cycle phase 2); the FV2 file-type registry (mount point). Sequence after both.
	  **Tags:** #type/feature #area/platform #size/l #priority/p2
	  **Notes:** Carded 2026-07-16 by Dev from Liam's integration question. Spec of record: CC1-Command-Centre-Spec (Personal-OS specs) including the transfer/decommission terms; positioning card "Integrate spend-governance positioning" (this backlog) is gated on THIS card shipping and being validated in use.
- [ ] **Codex-only workspaces: run a full team without Claude Code installed**
	  **Problem:** Rundock requires Claude Code even for users who only have a ChatGPT plan: the orchestrator and Doc are enforced onto the Claude runtime (by design: Codex exec has no Agent tool, so a Codex orchestrator cannot route), and onboarding assumes Claude Code. A ChatGPT-only user cannot run Rundock at all today, which caps the addressable audience of the two-runtime story.
	  **Approach (to be shaped after the app-server protocol card lands):** the protocol integration gives Codex processes real tool round-trips, which removes the technical barrier to Codex orchestration. Then: lift the orchestrator/platform runtime enforcement behind a capability check (orchestration allowed on any runtime that supports tool round-trips), give Doc a runtime-appropriate spawn path, make first-run onboarding runtime-aware (detect what is installed; guide Codex-only users through codex login instead of the Claude wizard), and sweep the Claude-Code assumptions out of scaffolds/base rules conditionally.
	  **Test-coverage pairing (Liam, 2026-07-14):** delivering this is the moment to level up coverage of the surface it touches: orchestration/delegation paths per runtime, onboarding flows, and runtime detection E2E. Coordinate with the client test coverage stages 2-3 cards so the new paths land tested rather than retrofitted.
	  **Acceptance criteria (draft):**
	  - [ ] A machine with Codex signed in and NO Claude Code runs onboarding, creates a team, converses, and delegates end to end
	  - [ ] Runtime enforcement replaced by a capability model with tests per agent type x runtime
	  - [ ] Mixed workspaces unchanged; Claude-only workspaces unchanged
	  - [ ] New orchestration-per-runtime surface covered by unit + E2E tests at the levels the coverage cards define
	  **Dependencies:** [[Rundock-Backlog#Ready|Integrate Codex via the app-server protocol]] (hard); client test coverage stages 2-3 (coordination).
	  **Tags:** #type/feature #area/platform #size/l #priority/p2
	  **Notes:** Requested by Liam 2026-07-14 after the orchestrator-runtime enforcement landed (c5c2567). Deliberately Inbox until the protocol card ships: the design space (can Doc be Codex? which onboarding flow?) is not shapeable before that. NOT a duplicate of the Ready onboarding story: that one onboards honestly WITHIN the Claude-orchestrator constraint; this card removes the constraint (boundary recorded on both cards 2026-07-16).
- [ ] **Address open review comments with one click (Done-Reviewing gate)**
	  **Problem:** As a user who has left comments on a reviewed file, I want one action that hands the open comments to an agent to address and resolve, so that closing out a review does not require composing a chat message. NOTE (2026-07-16, Liam + Dev correction): the substantive loop is ALREADY SHIPPED: suggestion verdicts apply to the document immediately with the markup removed, and agents act on comments today via a plain chat ask (live-proven on both runtimes with zero integration code). This card is the remaining convenience affordance only, plus recording who applied what.
	  **Acceptance criteria:**
	  - [ ] A reviewed file with open comments offers one action that sends it to an agent; the agent addresses the comments, resolves the threads, and the who-decided/who-applied trail is recorded
	  **Tags:** #type/feature #area/editor #size/s #priority/p3
	  **Notes:** The deferred Done-Reviewing gate from the review loop's initial ship. Deliberately Inbox: the manual loop works well; pull this when review volume makes the chat ask feel like friction.
- [ ] **Distinguish auto-approved low-risk commands from a silently absent permission hook**
	  **Problem:** The client auto-approves low-risk read-only commands with no card (by design), but from the user's seat that is indistinguishable from a broken hook failing open: command runs, nothing shown. This exact ambiguity cost a diagnostic detour during Windows testing (2026-07-14): a genuinely dead hook looked "fixed" because commands ran.
	  **Approach (negotiable):** a subtle "auto-approved: read-only" annotation on the tool chip/activity summary for hook-approved low-risk commands, so the healthy path is visibly different from the broken one.
	  **Tags:** #type/ux #size/xs
	  **Notes:** Captured 2026-07-14 (Dev, from the Windows permission-hook investigation).
- [ ] **Permission card copy robustness: heading fallback for shell keywords, purpose line, auto-allow bare date**
	  **Problem:** (1) The permission-card heading parser takes the command's first token, so compound commands and shell keywords produce nonsense headings ("Run for" for a for-loop, observed 2026-07-13 when an agent looped `date`). (2) Bare read-only `date`/`Get-Date` variants could arguably auto-allow like other low-risk reads; agents mint timestamps constantly for review annotations.
	  **Approach:** heading falls back to a generic "Run shell command" + one-line purpose (from the tool description field when present); extend the low-risk list with bare date variants after checking the classifier's anchoring.
	  **Tags:** #type/ux #size/xs
	  **Notes:** Both flagged during FV1 round 8 (2026-07-13); re-confirmed worth doing during the Windows pass.
- [ ] **File the Codex CLI sandbox-subcommand issue upstream (rewritten)**
	  **Problem:** `codex sandbox windows --full-auto -- <cmd>` mis-parses its arguments (tries to execute the literal word "windows"; `CreateProcessAsUserW failed: 2`), which produced a false "ARM64 sandbox broken" diagnosis during Windows testing. The sandbox itself works; the diagnostic subcommand is what fails. A silent-downgrade warning for `codex exec --sandbox workspace-write` on unconfigured Windows is worth requesting in the same issue.
	  **Approach:** rewrite [[Codex-Windows-ARM-Sandbox-Issue-Draft]] around the subcommand repro (drop the broken-sandbox framing), Liam files from his account.
	  **Tags:** #type/ops #size/xs
	  **Notes:** Captured 2026-07-14 (Dev).
- [ ] **Make Skill view selection unambiguous when the same slug exists in both skill roots**
	  **Problem:** `discoverSkills` (server.js:4303-4306) scans both `System/Playbooks/<slug>/PLAYBOOK.md` and `.claude/skills/<slug>/SKILL.md`, and both records get `id = dir.name`. `selectSkill(id)` (public/app.js) does `skills.find(x => x.id === id)`, so when a slug exists in both roots the sidebar shows two identical entries and clicking EITHER selects the first record (the Playbooks-sourced one). The `.claude/skills` copy is unviewable until the duplicate is removed. Observed 2026-07-08 during the PS1 playbook-to-skill pilot (`writing-critique` present in both roots mid-migration).
	  **Approach (negotiable):** key skill records by `source + slug` (e.g. `id = sourceLabel + '/' + slug`), and/or render a source badge on duplicate names so the two entries are distinguishable.
	  **Acceptance criteria:** with the same slug in both roots, the sidebar entries are visually distinguishable and each opens its own record (verified by differing body content); no regression for single-source skills.
	  **Tags:** #type/bug #size/xs
	  **Notes:** Found by Dev during PS1 (see `Liam-Agent-Workspace/01_Projects/Fable-Testing-July-2026/PS1-Playbook-To-Skill-Migration-Completion.md`). Low urgency: the migration protocol keeps duplicate windows short, and the state disappears entirely once the playbook folder retires post-migration.
- [ ] **Integrate spend-governance positioning into site, docs, and deck materials (GATED: Requests/self-improving-teams feature set built and validated in use)**
	  **Parent:** [[Rundock-Roadmap#the-team-improves-itself-with-the-operators-approval]] (this card is that epic's success signal made public)
	  **Problem:** Rundock's marketing surfaces do not yet carry its strongest differentiator against the always-on/autonomous class (OpenClaw, Hermes): deterministic-free sensing plus approval-gated execution means every token spent traces to an attributed human decision. Liam endorsed this positioning 2026-07-07; it must not ship as words before the feature ships as fact.
	  **Approach:** When the gate clears, update rundock.ai (positioning sections, compare pages), docs.rundock.ai, and the standing deck/one-pager sources with the line "your team improves for free and spends only when you say so", grounded in the shipped ledger and tier mechanics. Sources: [[CC1-Command-Centre-Spec]] Addenda 7 to 9 and the RS1 positioning note (`Self-Improving-Teams-Positioning-Note.md`) once RS1 has run.
	  **Acceptance criteria:** site, docs, and deck sources updated with consistent language; claims match shipped behaviour exactly; compare-page contrasts cite verifiable mechanics.
	  **Tags:** #type/ops
	  **Notes:** Captured 2026-07-07 during the CC1 design sessions (Dev). Deliberately not actioned now.
- [ ] **Coverage-areas tool uses anchor-based ranges, not hardcoded line numbers**
	  **Problem:** `test/tools/coverage-areas.js` maps coverage to functional areas using hardcoded `server.js` line ranges. Any change that shifts line numbers (as the 0.9.2 bug-fix work did) makes the per-area figures misreport; the overall and delegation-engine numbers stay reliable, the other rows drift.
	  **Approach:** Resolve each area's line range by matching function signatures / anchor comments at runtime instead of fixed line numbers, so the per-area report stays correct as the file changes.
	  **Notes:** Surfaced 2026-07-03 during the 0.9.2 test-suite work.
	  #type/hygiene #area/dx #size/s #priority/p3
	  **Problem:** Doc's scaffolding currently creates a default orchestrator named Ted, role Team Lead (order 0). The Lean Agent Team lead magnet and Liam's own Personal OS both use a Chief of Staff named Cos. Shipping a different default orchestrator across the ecosystem is inconsistent, and "Chief of Staff" is the stronger, more aspirational framing for the principal-and-team model. Aligning Doc's default to Cos / Chief of Staff makes the ecosystem consistent and spreads the "Cos = AI chief of staff" coinage.
	  **Acceptance criteria:**
	- [ ] Decision recorded: keep Ted / Team Lead, or switch the scaffold default orchestrator to Cos / Chief of Staff
	- [ ] If switching: Doc scaffolds the default orchestrator as name `chief-of-staff`, displayName `Cos`, role `Chief of Staff`, type `orchestrator`, order 0
	- [ ] The displayName naming convention (name contains the role acronym or a key part of the role) is documented if adopted
	  **Notes:** Raised 2026-06-02 from the Lean Agent Team lead magnet work (uses Cos / Cleo / Bea). See [[01_Projects/Lean-Agent-Team/build-plan.md]]. Parent to assign at refinement (onboarding / scaffold).
	  #type/feature #area/scaffold #size/xs #priority/p3
- [ ] **Add project folders to the conversation sidebar for grouping related conversations**
	  **Parent:** [[Rundock-Roadmap#users-organise-conversations-into-themed-projects]]
	  **Problem:** As a Rundock user working on multiple distinct themes at once (a client, a product, a research area), I want to group related conversations into named folders in the sidebar so that conversations on the same theme live together rather than being interleaved chronologically with unrelated work. Raised by beta user James Compton 2026-04-24: "Rundock could benefit from project folders which consists of chats that can be with different agents, so the project is a theme".
	  **Approach:** Minimal v1 modelled on the existing collapsible "Previous" section pattern. Sidebar gains user-created named folders rendered at the top, above the Pinned section (per Des's ordering model in [[Sidebar-Ordering-Findings]], Projects sit above Pinned). Each folder is independently collapsible. A conversation belongs to at most one folder — when moved into a folder it leaves the Active / Pinned / Done flat list entirely and appears only inside the folder. Folder creation and conversation-move both flow through a right-click context menu on the conversation row ("Move to folder → [existing folders] / New folder…"). Folder rename and delete flow through a right-click menu on the folder header. Folder-delete only works when the folder is empty; non-empty deletes surface a message asking the user to move conversations out first. Folder state (name, ordered member list, collapsed/expanded) persists to the existing `.rundock/` workspace metadata so it survives reloads and workspace switches.
	  **Acceptance criteria:**
	  - [ ] A user can create a named folder via the conversation-row context menu ("Move to folder → New folder…")
	  - [ ] Created folders render at the top of the sidebar, above the Pinned section, each as an independently collapsible section matching the visual pattern of the existing "Previous" section
	  - [ ] A conversation moved into a folder leaves the Active / Pinned / Done flat list and appears only inside the folder
	  - [ ] A conversation belongs to at most one folder at any time
	  - [ ] A user can rename a folder via the folder-header context menu
	  - [ ] A user can delete a folder via the folder-header context menu, but only when the folder is empty; non-empty deletes surface a message asking the user to move conversations out first
	  - [ ] A user can move a conversation out of a folder via the conversation-row context menu ("Move to folder → None" or equivalent); the conversation returns to the Active list
	  - [ ] Folder membership, names, order, and collapsed/expanded state persist to `.rundock/` workspace metadata and survive a page reload and a workspace switch
	  - [ ] Folders containing a conversation with an active agent or an unread message surface an indicator on the collapsed folder header (dot for unread, pulsing indicator for active) so the user sees that something needs attention without expanding
	  - [ ] Empty folders (zero conversations) render with a subtle empty state rather than disappearing from the sidebar
	  - [ ] No regression to the Pinned / Active / Done ordering model from the sidebar-ordering card — folders sit above, ordering within Active / Pinned / Done applies only to conversations not inside any folder
	  **Files touched:** `public/app.js` (sidebar render, context menus, folder state), `server.js` (folder CRUD endpoints, `.rundock/` metadata persistence, folder-aware conversation enrichment on workspace load). Possibly a new small module for folder data management if the folder state grows complex enough to warrant it.
	  **Out of scope:** Multi-folder membership (a conversation in two or more folders). Nested folders. Drag-and-drop conversation moves — context menu only for v1; drag-drop can be added later if users ask. Project-level context, brief, or settings injected into agents inside the folder. Project-scoped agents. Sharing a folder between workspaces or users. Any agent-level awareness of the folder structure — folders are purely a UI grouping construct.
	  **Dependencies:** Works alongside [[Rundock-Backlog#rework-sidebar-ordering-so-pinned-active-and-unread-conversations-surface-predictably]]. If the sidebar ordering card ships first, project folders are layered on top of the three-section model with no rework. If this card ships first, the sidebar ordering card operates on the set of conversations not inside any folder. Either order works; no hard blocker either way.
	  **Notes:** Raised 2026-04-24 by beta user James Compton. Scoped with Liam 2026-04-24: single-folder membership, context menu interaction (not drag-drop), folders sit above Pinned, deletes require empty first, no project-level context or settings. These are deliberate v1 simplifications — richer behaviours (multi-membership, project briefs, drag-drop) can land as future cards if demand emerges.
	  #type/feature #area/platform #size/m #priority/p2
- [ ] **Fix agent and skill instructions being clipped in the profile instructions view**
	  **Problem:** The instructions panel on agent and skill profile pages cuts off content mid-sentence. The underlying `.md` files are complete and unmodified. The bug is a rendering or parsing issue in the UI: special characters in the instructions (likely square brackets, markdown constructs, or code fences) cause the renderer to stop early. Observed live during the Lucas Simonian beta session (2026-04-30): Scout's instructions displayed "Core Ideas Ke" and nothing after. Confirmed by Liam on the call: "It's cut off at a certain point. My hunch is there's a square bracket or something. It's not showing in this view but it should still be there in the file."
	  **Acceptance criteria:**
	  - [ ] Agent and skill instructions render in full in the profile view regardless of whether the content contains square brackets, markdown code fences, wikilinks, or other special characters
	  - [ ] No truncation occurs on any instruction file present in the Lucas Simonian workspace or the Rundock scaffold defaults
	  - [ ] If content genuinely exceeds a display limit, a clear "Show more" affordance is present rather than a silent hard cut
	  **Files touched:** `public/app.js` (instructions rendering path in `showProfile` or equivalent profile render function).
	  **Notes:** Surfaced during Lucas Simonian beta session, 2026-04-30. See [[03_Resources/Granola/Notes/2026-04-30 - 30 Min Meeting (Lucas Simonian __ Liam Darmody)]] for session context. Transcript timestamp approx. 14:56.
	  #type/bug #area/platform #size/xs #priority/p2
- [ ] **Gate scaffold folder creation behind a workspace emptiness check**
	  **Problem:** When a user opens an existing workspace that already has a folder structure, Doc's onboarding flow proposes (or executes) adding the default Rundock folder scaffold. This should only happen for empty directories or brand-new workspaces. Observed live during the Lucas Simonian beta session (2026-04-30): Lucas opened his existing well-organised Obsidian vault. Doc identified the structure correctly but then proposed adding folders to it anyway. Liam's reaction on the call: "I can see there's an issue here with Doc who's now identified your workspace and given you some folders to get started with. But in your case you've already got a good file structure." Users with existing vaults should not have scaffold folders imposed on them.
	  **Acceptance criteria:**
	  - [ ] Scaffold folder creation is skipped when the target workspace already contains a non-trivial folder structure (at minimum, more than a `.claude/` directory or one or two files)
	  - [ ] Doc's onboarding conversation in an existing workspace does not propose adding default Rundock folders unless the workspace is effectively empty
	  - [ ] New and empty workspaces continue to receive the full scaffold as today
	  - [ ] The workspace analysis step correctly distinguishes empty/new from pre-existing structured workspaces before surfacing scaffold suggestions
	  **Files touched:** `server.js` (workspace analysis and scaffold trigger logic), `scaffold/rundock-guide.md` (onboarding instructions that govern when Doc proposes folder creation).
	  **Notes:** Surfaced during Lucas Simonian beta session, 2026-04-30. See [[03_Resources/Granola/Notes/2026-04-30 - 30 Min Meeting (Lucas Simonian __ Liam Darmody)]] for session context. Transcript timestamp approx. 14:00. Related: the existing `isEmpty` and `scaffoldError` fields on the `workspace_ready` payload (see Bundle workspace-open card) suggest server-side emptiness detection already exists in some form. Check whether `isEmpty` can gate the scaffold proposal directly.
	  #type/bug #area/scaffold #size/s #priority/p2
- [ ] **Bundle workspace-open into a single workspace_ready server push**
	  **Problem:** When the server replies to `set_workspace` (or surfaces an existing workspace via the initial `workspaces` message), the client immediately fires four sequential WebSocket round-trips: `get_agents`, `get_files`, `get_skills`, `get_conversations` (`public/app.js:3056-3059`). The server already knows everything required to compute these payloads at the moment it sets the workspace. The round-trip pattern adds avoidable latency to every workspace open, and the slowest reply (`get_conversations`, which now reads JSONLs across delegated agents to compute `messageCount` since 0.8.8) gates when the conversations sidebar can render. The picker-sequencing fix removes the visible artefact but not the underlying load time.
	  **Approach:** Server: in the `set_workspace` handler (and the initial workspace bootstrap path that emits `workspaces` with a `current` value) enumerate agents, files, skills, and conversations in parallel server-side, then push a single `workspace_ready` message containing all four payloads alongside the existing `analysis`, `workspaceMode`, `isEmpty`, `scaffoldError`, and `setupComplete` fields. Client: route the bundled payload through the existing `handleAgents`, `handleFiles`, `handleSkills`, and `handlePersistedConversations` functions without changing their contracts. Drop the four `ws.send` calls in `onWorkspaceReady`. Keep the standalone `get_*` message handlers in place: they remain in use by skills lazy-load, file refresh after save, and other non-workspace-open paths.
	  **Acceptance criteria:**
	  - [ ] Selecting a workspace produces exactly one server-to-client message carrying agents, files, skills, conversations, analysis, workspaceMode, isEmpty, scaffoldError, and setupComplete (verifiable in the browser DevTools network pane)
	  - [ ] After the bundled message arrives, the client renders the team, conversations sidebar, skills (when the panel is first opened), and files tree with no further server round-trips during the workspace-open sequence
	  - [ ] Time from `set_workspace` send to first conversation row painted in the sidebar is measurably lower than the four-round-trip baseline; record before/after timings in the change summary
	  - [ ] First-launch flow (server has a workspace from env var or last-selection) uses the same single-push payload — no separate code path
	  - [ ] Reconnecting to the same workspace preserves in-memory conversations and the active view (the `isSameWorkspace` branch in `onWorkspaceReady` works with the bundled payload)
	  - [ ] Standalone `get_agents`, `get_files`, `get_skills`, `get_conversations` messages still work for any non-workspace-open code path that depends on them
	  - [ ] Empty / new workspace flow (Path C, setup conversation) still routes correctly with the bundled payload
	  - [ ] No regression to scaffold writes, workspace mode auto-detection, or active-process reconciliation on workspace open
	  **Files touched:** `server.js` (`set_workspace` handler, workspace bootstrap path that builds the initial `workspaces` message, likely a shared `buildWorkspaceReadyPayload` helper). `public/app.js` (`onWorkspaceReady` drops the four `ws.send` calls; message dispatcher routes `workspace_ready` through the existing handlers).
	  **Out of scope:** Optimising the `messageCount` enrichment itself — if profiling shows it dominates the bundled-payload assembly time, file a separate card. Reworking the agents/skills/files parsing or persistence model. Partial / streamed payloads (do not ship "agents now, conversations later"; this card delivers the full bundle in one push).
	  **Dependencies:** No hard blocker, but only delivers user-visible benefit once [[Rundock-Backlog#hide-the-workspace-picker-immediately-on-selection-so-it-doesnt-linger-as-the-workspace-loads]] has shipped — without that, the visible picker hang masks any latency improvement here.
	  **Notes:** Surfaced 2026-04-30 alongside the picker-sequencing investigation. The four-round-trip pattern dates back to when workspace switching was first added and was never revisited; the `messageCount` enrichment in 0.8.8 made the conversations reply slower and put the cost on the user-visible critical path. Sits in Inbox (not Ready) because the picker fix should land first; specced now so it can be pulled the moment the picker fix ships and we measure the residual delay.
	  #type/hygiene #area/platform #size/m #priority/p3
- [ ] **Users upload images into agent conversations**
	  **Problem:** As a Rundock user working with an agent on visual context (design review, debugging a screenshot, reading a whiteboard photo, explaining an error dialog), I want to paste, drop, or pick an image into the chat input and have the agent receive and reason about it, so that I do not have to describe the image in text or switch tools to work with visual content. First raised by a beta user 2026-04-19.
	  **Approach:** Two stages with a spike gate.
	  *Stage 0 — Input-channel spike (½ day):* Confirm which Claude Code input channel actually carries images. Try two options in a throwaway sandbox: (a) write the image to a temp file under the conversation's workspace and reference its path inside the existing stream-json `content` text (e.g. `[image: /path/to/foo.png]`) and let the CLI read from disk; (b) extend the stream-json stdin payload with proper multimodal content blocks (`{ type: 'image', source: { type: 'base64', media_type: ..., data: ... } }`) and see if the CLI accepts them. Deliverable: one working "agent describes an uploaded image" round-trip, plus a one-paragraph note on which channel to use for Stage 1.
	  *Stage 1 — Implementation (~3 days):* Frontend gets file-picker button, paste handler, and drag-drop on the chat input. Attached images show as thumbnail previews in the input area with a remove button before send. Message object gains an optional `attachments: [{ type: 'image', dataUrl, filename, mime, bytes }]` field. Server accepts attachments in the `chat` WebSocket payload and routes them to Claude Code via the channel chosen in Stage 0. User bubble renders the image in chat. Sidebar-preview strippers handle messages whose text content is only an image by falling back to a sensible placeholder (e.g. `[image]`).
	  **Acceptance criteria:**
	  - [ ] Stage 0 spike output documented: the chosen input channel plus one working round-trip where an agent correctly answers "what do you see" for an uploaded image
	  - [ ] User can attach an image via (a) file-picker button, (b) paste into the chat textarea, (c) drag-drop onto the chat input
	  - [ ] Attached image renders as a thumbnail preview in the input area before send, with a remove button that clears it
	  - [ ] On send, the image renders in the user's message bubble
	  - [ ] The agent receives the image and can reason about it, for both the orchestrator and specialists, with no per-agent wiring
	  - [ ] The image and its message survive a page reload and re-opening the conversation from the sidebar (persistence round-trip)
	  - [ ] Sidebar preview for a conversation whose last message is an image renders a sensible text fallback rather than empty or broken content
	  - [ ] Non-image file drops (PDF, txt, etc.) are rejected with a clear inline message — not silently accepted
	  - [ ] No regression to text-only conversations: a normal text message still dispatches with no attachment plumbing in the payload
	  **Files touched:** `server.js` (WebSocket `chat` handler, stream-json stdin payload construction, possible temp-file write), `public/app.js` (chat input UI, paste/drop handlers, attachment state, message rendering, sidebar-preview strippers), `public/index.html` (file input element, thumbnail preview container in the chat-input block), conversation persistence path (attachment serialisation).
	  **Out of scope:** Video upload. Non-image file upload (PDFs, docs) — separate future card. Image generation by agents (different outcome entirely). Automatic image compression / resizing (revisit if large images cause perf issues). Multi-image drag-drop in a single message (start with one attachment per message; add multi later if users ask).
	  **Dependencies / notes:** Not yet linked to a roadmap card. Features in Ready must link up per the Parent rule, so before this moves out of Inbox, either (1) a new roadmap outcome like *"Users share rich content with agents in conversation"* gets created and this card links to it, or (2) this stays in Inbox. Claude Code is multimodal at the model level (Opus / Sonnet / Haiku are all multimodal) so the capability exists; the open question is the stream-json CLI input shape, which Stage 0 answers. If the spike shows neither channel works cleanly, resize this card or split it further.
	  #type/feature #area/platform #size/m #priority/p2
- [ ] **Device Sync two-machine spike**
	  **Parent:** [[Rundock-Roadmap#teams-use-rundock-together]]
	  **Problem:** As a Rundock user exploring multi-device and multi-user workflows, I want a time-boxed experiment that proves or disproves whether Device Sync via a user-owned sync service is a viable path to multi-user Rundock, so that we know whether to invest in the full architecture or retire the card before building anything.
	  **Approach:** Pick one sync layer (Dropbox is fastest to set up; git is cleanest for conflict handling). Build the minimum assembly engine needed: a script that reads an `Agents/`, `Skills/`, `Knowledge/` directory structure and produces a working `.claude/` directory. Set up a shared sync folder containing this structure on two machines. Run two scenarios: (1) one person edits different files on different machines and reloads; (2) two people edit the same agent file within a few minutes of each other. Observe conflict behaviour, secrets handling, and live session state. Capture findings in a spike report.
	  **Acceptance criteria:**
	  - [ ] Assembly engine stub exists and successfully rebuilds `.claude/` from source directories on both machines
	  - [ ] Scenario 1 (non-conflicting edits) produces the expected result on both machines with no manual intervention
	  - [ ] Scenario 2 (concurrent same-file edits) is executed and the outcome documented (conflict file, silent overwrite, git merge conflict, whatever happens)
	  - [ ] Spike report written covering: concurrent-edit behaviour, secrets strategy (shared vs per-machine), whether session JSONL files can sync safely or must stay local, recommended next step (promote to full build, retry with a different sync layer, retire the card)
	  - [ ] Timeboxed to one work session. If the assembly engine alone takes longer, stop and document why.
	  **Out of scope:** Production-quality assembly engine. Multi-user access control. Team routines. Anything that isn't "does this architecture survive first contact with two machines and two people".
	  **Notes:** Gate for promoting [[Rundock-Roadmap#teams-use-rundock-together]] from Later to Next. If findings are positive, the full Device Sync backlog gets written. If findings are negative, the card retires and teams fall under [[Rundock-Roadmap#interactive-remote-access-to-rundock-from-anywhere]]. Sits in Inbox (not Ready) because the parent card is in Later and the spike is not yet pulled.
	  #type/feature #area/platform #size/s #priority/p3
- [ ] **Add routing coverage audit to surface unroutable skills and stale triggers**
	  **Problem:** As a Rundock operator maintaining a workspace over time, I want a tool that parses `CLAUDE.md` and the orchestrator agent file for delegation rules and surfaces problems (unroutable skills, triggerless agents, stale triggers, references to agents that no longer exist), so that I can catch routing drift before it causes silent failures in specialist handoff.
	  **Approach:** Parse `CLAUDE.md` and the orchestrator agent file for the delegation table and any trigger mappings. Cross-reference against the actual `Agents/` and `Skills/` directories. Surface: (1) skills with no trigger in the delegation table, (2) agents with no trigger, (3) triggers pointing at agents or skills that don't exist, (4) duplicate triggers. Output: a report. Not an interactive UI: a command or vault-lint-style report is enough.
	  **Acceptance criteria:**
	  - [ ] Audit runs against a workspace and produces a report listing the four problem categories
	  - [ ] Report has zero false positives against a clean workspace
	  - [ ] Audit handles both `CLAUDE.md` and direct agent-file inspection
	  - [ ] Runnable as a command (vault-lint pattern acceptable)
	  **Notes:** Spec: [[Workspace-Audit-v2]]. Demoted from old Roadmap Later column 2026-04-15: this is developer tooling, not a strategic outcome, so it stands alone as a `#type/ops` item rather than ladder under a roadmap card. Sits in Inbox rather than Ready because it's not currently the next thing to pull.
	  #type/ops #area/platform #size/m #priority/p3
- [ ] **Routines-as-compute end-to-end spike**
	  **Parent:** [[Rundock-Roadmap#rundock-runs-scheduled-work-while-im-away]]
	  **Problem:** As a Rundock user exploring always-on automations, I want a time-boxed experiment that proves or disproves whether Claude Code Routines can credibly back a "scheduled Rundock automation" feature, so that we know whether to invest in the Routines-backed architecture or fall back to a server-based scheduler.
	  **Approach:** Pick one Rundock workspace. Create a shadow GitHub repo containing `CLAUDE.md`, `.claude/skills/`, `.claude/agents/`, and the relevant context files (ICP, voice profile, rules). Manually create a single daily-briefing routine on claude.ai pointed at this repo. Fire it once via the `/fire` API trigger to validate the auth token flow. Schedule it daily for seven days. Choose one result-delivery path (Slack via MCP connector, shadow repo commit, or session URL check) and confirm results arrive for all seven days. Document real daily run caps, setup friction, and any research-preview gotchas encountered.
	  **Acceptance criteria:**
	  - [ ] Shadow repo exists and contains enough workspace context for the routine to behave as if it were running inside Rundock
	  - [ ] `/fire` endpoint triggers the routine and returns a valid `session_id` / `session_url`
	  - [ ] The routine fires on schedule for seven consecutive days, producing usable output each day
	  - [ ] Results reach an observable channel without manual intervention each day
	  - [ ] Real daily run cap is documented for the account tier used (Pro / Max / Team)
	  - [ ] Spike report written covering: setup friction story (end-to-end time and steps), run cap findings, result-delivery path chosen and why, observed failure modes, recommended next step (promote to full build, retry with different result-delivery path, retire the card)
	  **Out of scope:** Automated routine creation (the research confirms no API exists). Programmatic output capture. Multi-user routine management. Anything that isn't "prove one routine runs reliably for a week against real workspace context".
	  **Notes:** Gate for promoting [[Rundock-Roadmap#rundock-runs-scheduled-work-while-im-away]] from Later to Next. References [[Routines-as-Cloud-Compute]] research. If findings are positive, the full Routines-backed automation backlog gets written. If research-preview risk or run caps prove prohibitive, the scheduled-work case falls under [[Rundock-Roadmap#interactive-remote-access-to-rundock-from-anywhere]]. Sits in Inbox (not Ready) because the parent card is in Later and the spike is not yet pulled.
	  #type/feature #area/platform #size/m #priority/p3
- [ ] **Capture routine output to a recoverable per-run log or conversation**
	  **Problem:** `executeRoutine` at `server.js:894` spawns Claude Code with stdout and stderr piped but nothing reads them. The model's response, tool calls, and tool results are never captured into a Rundock conversation, transcript, or file. Only `lastRun`, `status`, and `duration` are recorded. Routines that write files via Bash or update external systems via MCP are fine because the side effects live in those tools. Routines that ask the agent to "summarise the week" produce output nobody can recover, even though the run completed successfully.
	  **Approach:** Two options. (a) Write stdout to a per-run log file under `.rundock/routine-logs/` keyed by routine slug and timestamp. (b) Auto-create a Rundock conversation under the agent for each run, with the model output rendered as the agent's reply. Option (b) is the better UX (output appears in the same UI as ad-hoc conversations) but more complex; pick during spec.
	  **Acceptance criteria:** Dev to write before moving to Ready. Anchors: model output from a routine run is recoverable by the user after the run completes; output is attributed to the agent that ran the routine; the user can find a routine's output without inspecting server logs.
	  **Files touched:** `server.js` (executeRoutine and surrounding scheduler functions), possibly conversation persistence path, possibly `public/app.js` if surfaced in UI.
	  **Notes:** Surfaced in the ROUTINES.md audit, 2026-04-29.
	  #type/bug #area/platform #size/s #priority/p2
- [ ] **Add cron expression support to schedule parser plus validate unrecognised formats**
	  **Problem:** `parseRoutines` at `server.js:785` accepts any string as the schedule. `getNextRun` at `server.js:851` only recognises `every day at HH:MM` and `every <weekday> at HH:MM` with strict lowercase weekday and zero-padded time. Cron expressions like `0 5 * * *`, hours without leading zero like `every day at 9:00`, and weekday shorthand like `every weekday at 18:00` all parse fine and silently never fire. No warning, no log line. Users have no way to know a routine is dead. Anthropic's Claude Code Routines support cron natively, so users moving between tools hit two different mental models.
	  **Approach:** Two parts. (a) Validate at parse time. If the schedule string does not match a recognised format, log a warning and surface the routine in the UI as "schedule not understood" so the user can fix it. (b) Extend `getNextRun` to accept cron expressions in standard 5-field format. Use a battle-tested library (cron-parser or node-cron). Preserve existing human-readable strings unchanged.
	  **Acceptance criteria:** Dev to write before moving to Ready. Anchors: cron-format schedules parse and fire correctly; existing human-readable strings continue to work; unrecognised formats produce a warning and surface as misconfigured in UI; ROUTINES.md updated to reflect cron support.
	  **Files touched:** `server.js` (parseRoutines, getNextRun), possibly `public/app.js` (UI for misconfigured routines), `02_Areas/Rundock/Specs/Rundock-ROUTINES.md`.
	  **Notes:** Surfaced in the ROUTINES.md audit, 2026-04-29. Aligning with Anthropic's schedule mental model reduces user friction across tools.
	  #type/bug #area/platform #size/m #priority/p3
- [ ] **Add per-routine HTTP webhook trigger with bearer-token auth**
	  **Problem:** Anthropic's Claude Code Routines provide a per-routine bearer-token endpoint that accepts a freeform `text` body for run-specific context. External systems (alerting tools, monitoring, CI pipelines, Slack, Granola) can fire a saved prompt with live data merged in. Rundock has no equivalent: routine prompts are static once saved. Routines can react to timers but not to events. This means Rundock cannot be the home for any automation that needs to respond to external triggers.
	  **Approach:** Add a local HTTP endpoint per routine, addressed by routine slug. POST with a `text` body merges the body into the routine prompt at fire time (template substitution or similar). Authentication via a per-routine bearer token, generated at routine creation, surfaced in the UI for the user to copy and use externally. Rotation supported.
	  **Acceptance criteria:** Dev to write before moving to Ready. Anchors: each routine has a unique HTTP endpoint visible in the UI; POST with `text` body fires the routine with body merged into prompt; bearer-token auth prevents unauthorised triggers; failed auth returns a clean error; the user can rotate the token if compromised.
	  **Files touched:** `server.js` (HTTP endpoint, routine fire path, auth), `public/app.js` (UI for endpoint URL and token rotation), routine state schema (token storage).
	  **Notes:** Surfaced in the ROUTINES.md audit, 2026-04-29. Loosely models Anthropic Routines `/fire` endpoint pattern. Differentiator: this fires in the user's local agent team with full workspace context, where Anthropic's fires in their managed environment with repo-bound context. Genuinely complementary, not redundant.
	  **Dependencies / notes:** No roadmap parent yet. Per the parent rule, before this moves out of Inbox either a new roadmap card like "Routines react to events, not just timers" gets created and this card links to it, or this stays in Inbox. Worth promoting to a roadmap card if the feature value is confirmed.
	  #type/feature #area/platform #size/m #priority/p3
- [ ] **Audit agent files for inline-array skills: declarations that parse to empty**
	  **Problem:** `parseSkills` at `server.js:816` only matches the YAML block form for the `skills:` array. The inline flow-style array `skills: [a, b]` parses to an empty array. Agents that declare skills inline appear to Rundock to have no skills, even though the file looks correct to the human author. There is no warning at load time. Existing agent files in the rundock repo, in the rundock-managed workspace, and in any reference workspaces may contain inline declarations that have been silently empty.
	  **Approach:** Two parts. (a) Audit existing agent files in the workspace at `.claude/agents/*.md` and in the rundock repo. Convert any inline-array `skills:` declarations to block form. (b) Optionally extend `parseSkills` to handle inline arrays, OR add a parse-time warning when inline form is detected so future authors get told.
	  **Acceptance criteria:** Dev to write before moving to Ready. Anchors: every agent file in the rundock-managed workspace and the rundock repo uses block-form `skills:`; either inline form is supported, or a warning fires on parse when inline form is detected; agents created via Doc do not produce inline form.
	  **Files touched:** `server.js` (parseSkills); various agent files in the workspace and rundock repo.
	  **Notes:** Surfaced in the SKILLS.md audit, 2026-04-29.
	  #type/bug #area/platform #size/xs #priority/p2
- [ ] **Decide and document per-skill allowed-tools direction**
	  **Problem:** The skill frontmatter parser at `server.js:3638` reads only `name` and `description` from skill files. Other fields (`allowed-tools`, `model`, etc.) are ignored, even though Claude Code's broader skill format documents them. SKILLS.md currently documents the current behaviour as final. The roadmap question: should Rundock parse and forward `allowed-tools` per skill so a skill can restrict its own tool surface, or is the workspace-mode-only model the intended design? Open.
	  **Approach:** Decision first, implementation second. Two paths. (a) Commit to the current "all tooling at agent level" model. Update SKILLS.md to mark this as deliberate design rather than a parser limitation. (b) Extend the parser to read `allowed-tools` (and possibly `model`) per skill. Forward to Claude Code at spawn. Document the new behaviour in SKILLS.md and ARCHITECTURE.md. Trade-off: (a) is simpler, keeps the workspace-mode model intact; (b) gives skill authors finer control and aligns with Claude Code's documented skill format.
	  **Acceptance criteria:** Decision recorded in an ADR or directly in SKILLS.md. If (b), parser extended, agent spawn args updated to forward, and docs reflect new behaviour (both source `SKILLS.md` and the public `docs.rundock.ai/reference/skill-file-format` page). If (a), SKILLS.md explicitly notes the current behaviour is intentional design and the public skill-file-format page is updated to match.
	  **Files touched:** `02_Areas/Rundock/Specs/Rundock-SKILLS.md` (always); `02_Areas/Rundock/Docs/reference/skill-file-format.md` (vault source; always, must mirror the SKILLS.md decision); `~/Documents/Projects/rundock-docs/reference/skill-file-format.mdx` (production renderer-target; always, promoted from the vault source); `server.js` (parseSkillFrontmatter and spawn args, only if option b); potentially `02_Areas/Rundock/Specs/Rundock-ARCHITECTURE.md` and a CONTRIBUTING note or ADR.
	  **Notes:** Surfaced in the SKILLS.md audit, 2026-04-29. The decision affects how SKILLS.md reads (resigned acceptance vs deliberate design). Public docs path added 2026-05-04: any change to the source-of-truth SKILLS.md must propagate to the public `skill-file-format` reference page so docs.rundock.ai stays accurate.
	  #type/ops #area/platform #size/s #priority/p3
- [ ] **View and edit Excalidraw files in the file viewer (Obsidian Excalidraw plugin parity)**
	  **Parent:** [[Rundock-Roadmap#users-edit-knowledge-inline-without-switching-to-obsidian]]
	  **Problem:** As a Rundock user who keeps diagrams and sketches as Excalidraw files in my workspace, I want to open, view, and edit `.excalidraw` files directly in Rundock with an experience similar to the Obsidian Excalidraw plugin, so that I can work with my drawings natively instead of switching to Obsidian or excalidraw.com. Today, `.excalidraw` files have zero handling: they fall through to the legacy text path and display as raw JSON.
	  **Approach:** Add a new branch to the file-type routing in `loadFileContent()` for the `.excalidraw` extension that mounts an embedded Excalidraw canvas instead of the text editor. Excalidraw files are JSON documents (`{ type: "excalidraw", version, elements, appState, files }`); the official `@excalidraw/excalidraw` component reads and writes exactly this shape, so the canvas loads the parsed JSON and serialises edits back to the same format on save. This is a contained, self-isolated viewer/editor that shares nothing with Tiptap. Note: `@excalidraw/excalidraw` is a React component, which is net-new for a vanilla-JS frontend; a spike must confirm how to mount it (scoped React island in a container, or the lighter-weight standalone export/render path) without pulling a build step into the project. The Obsidian Excalidraw plugin is the UX target: open to a live editable canvas, full draw tools, edits persist back to the `.excalidraw` file in a format Obsidian's plugin also reads.
	  **Acceptance criteria:**
	  - [ ] Opening a `.excalidraw` file renders an interactive Excalidraw canvas showing the existing drawing, not raw JSON
	  - [ ] The user can edit the drawing (add, move, delete, restyle elements) using standard Excalidraw tools
	  - [ ] Edits persist back to the `.excalidraw` file as valid Excalidraw JSON that the Obsidian Excalidraw plugin and excalidraw.com both open without corruption (round-trip safe)
	  - [ ] A new or empty `.excalidraw` file opens to a usable blank canvas
	  - [ ] The Excalidraw surface is isolated from the rest of the app and does not regress markdown (Tiptap), HTML, or other non-markdown file handling
	  - [ ] Spike output documents the React-mounting decision (how `@excalidraw/excalidraw` is loaded into the vanilla-JS frontend without a build step) before full implementation
	  **Files touched:** `public/app.js` (`loadFileContent` routing branch, Excalidraw mount/unmount lifecycle, save serialisation), `public/index.html` (canvas container), a new Excalidraw viewer module, `public/vendor/` (Excalidraw bundle), possibly `server.js` if `.excalidraw` needs different read/write normalisation than plain text.
	  **Notes:** Research 2026-06-05 (Dev). **Tiptap question, confirmed: this does NOT use the Tiptap rich markdown editor.** There are zero references to Excalidraw, canvas, or drawing formats anywhere in the codebase today, and `.excalidraw` files currently get no special handling. Tiptap is a markdown editor (`.md` / `.mdx` only, `html: false`) and cannot host a drawing canvas; this needs a fully separate embedded viewer/editor added as a new branch in the `loadFileContent()` if-chain (no file-type registry exists). The format target is Excalidraw JSON (`.excalidraw`); the UX target is the Obsidian Excalidraw plugin's live-canvas editing experience. Larger and higher-risk than the HTML card because of the React-component-in-vanilla-JS mounting question and the canvas/save lifecycle: recommend a time-boxed spike on the mount approach before committing to full build. Size and exact scope to be confirmed at shaping.
	  #type/feature #area/platform #size/l #priority/p3


## Ready

- [ ] **Audit Obsidian markdown syntax parity in the rich editor and card the gaps**
	  **Parent:** [[Rundock-Roadmap#users-edit-knowledge-inline-without-switching-to-obsidian]]
	  **Problem:** As a user who edits the same vault in Rundock and Obsidian interchangeably, I want to know that every Obsidian syntax construct either renders correctly in Rundock or at minimum survives a save untouched, so that using Rundock never degrades my files or hides my content. Callouts and frontmatter wikilinks were found as live gaps by daily friction; the rest of the surface (embeds `![[...]]`, highlights `==text==`, comments `%%...%%`, block references `^id`, tags, footnotes, task lists, maths, mermaid, strikethrough) has never been systematically checked.
	  **Acceptance criteria:**
	  - [ ] A parity matrix covering every construct in Obsidian's syntax reference (https://obsidian.md/help/syntax and https://studio-obsidian.com/obsidian-markdown-guide/) with three verdicts per construct: renders correctly / renders wrong / unsupported-but-round-trips
	  - [ ] Round-trip safety verified BY TEST for every construct, including unsupported ones: opening and saving a file using any construct changes zero bytes (a rendering gap is acceptable; corruption never is)
	  - [ ] Each renders-wrong gap becomes a prioritised backlog story, ordered by real vault usage, with Liam choosing the order
	  **Approach:** build the matrix as a fixture corpus in the editor round-trip harness (one file per construct family), so the audit's artefact IS the regression suite.
	  **Tags:** #type/hygiene #area/editor #size/s #priority/p2
	  **Notes:** Raised by Liam 2026-07-16 while hardening the Kanban interchangeability requirement; generalises the callouts card's origin story into a systematic sweep.
- [ ] **Render Obsidian callouts and make frontmatter wikilinks clickable in the editor**
	  **Parent:** [[Rundock-Roadmap#users-edit-knowledge-inline-without-switching-to-obsidian]]
	  **Problem:** As a user whose vault files use Obsidian callouts and frontmatter wikilinks (my daily briefing is built from them), I want them to render in Rundock the way they do in Obsidian, so that I can read and work with my own files without switching apps.
	  **Acceptance criteria (user-observable):**
	  - [ ] A file with `> [!note]`, a collapsible `> [!abstract]+`, and a nested `> > [!warning]-` shows titled admonition boxes with working expand/collapse, and no literal `[!type]` or `+`/`-` characters
	  - [ ] The live morning briefing renders with its labelled sections intact, matching Obsidian
	  - [ ] A `related:` frontmatter list of wikilinks is clickable and navigates to the resolved files; unresolvable links look visibly dead rather than erroring
	  - [ ] Byte-for-byte round-trip holds: opening and saving a callout-heavy file changes nothing
	  **Approach:** two independent tasks (callout parser; frontmatter link resolution), built directly against the editor round-trip harness. Prior shaping in the 2026-07-15 card notes.
	  #type/feature #area/editor #size/m #priority/p2
- [ ] Test new KANBAN board card
	- [ ] Overall client line coverage at least doubles from the 30.9% baseline and the ratchet (never goes down) is recorded
	  #type/hygiene #area/platform #size/m #priority/p1
- [ ] **Organise conversations with Lists so related work stays together**
	  **Parent:** [[Rundock-Roadmap#users-organise-conversations-into-themed-projects]]
	  **Problem:** As a user running many conversations across agents, I want to group them into named lists shown as sidebar pills (the way WhatsApp organises chats), so that work on one theme stays together instead of interleaving chronologically with everything else.
	  **Acceptance criteria (user-observable):**
	  - [ ] I can create a list, name it, and add any conversation to it from the conversation's context menu; a conversation can belong to several lists
	  - [ ] Lists appear as pills beside All and Unread; selecting one filters the sidebar to its conversations, pinned-first ordering unchanged
	  - [ ] Lists survive reload and workspace switches
	  - [ ] Removing a list never deletes conversations
	  **Approach:** list/filter logic lands as a stage-2-style tested module. Shaping decision vs the project-folders Inbox card recorded here: Lists is the first iteration; folders decision follows usage.
	  **Dependencies:** ideally after the client extraction lands (module pattern); not blocked by it.
	  #type/feature #area/platform #size/m #priority/p2
- [ ] **First-run onboarding detects both runtimes and sets users up honestly**
	  **Parent:** [[Rundock-Roadmap#users-run-their-team-on-whichever-ai-subscription-they-already-have]]
	  **Problem:** As a new user arriving with a ChatGPT plan (with or without a Claude subscription), I want first-run to detect what I have and guide me through what I need (set up Codex for my specialists; explain plainly that the orchestrator needs Claude Code today), so that the "works with your ChatGPT subscription" promise survives my first ten minutes.
	  **Boundary (2026-07-16):** this story works WITHIN today's architecture: Claude Code remains required for the orchestrator and this flow says so honestly. Removing that requirement entirely is the separate, gated "Codex-only workspaces" card (Inbox), which depends on the Codex protocol story above. First iteration vs endgame; not duplicates.
	  **Acceptance criteria (user-observable):**
	  - [ ] First-run detects installed runtimes and adapts: a Codex-signed-in machine is not told to install Claude Code as step one with no explanation of why
	  - [ ] A ChatGPT-plan user finishes first-run with Codex set up for specialists and a truthful, specific statement of what Claude Code is still needed for, without leaving the app for documentation
	  - [ ] Settings and onboarding tell one consistent runtime story
	  **Approach:** shaped in [[R6.2-Codex-First-Onboarding-Handoff]]. CURRENCY NOTE (2026-07-16): that handoff predates 0.10.0; the executing session reconciles it against shipped reality first (runtime status detection, the Windows sandbox guidance, the enforced Claude-only orchestrator, the two-runtime base rules) and records deltas in its run notes. Copy honesty rules from the 0.10.0 docs sweep apply (never claim wizard support that does not exist).
	  #type/feature #area/onboarding #size/m #priority/p2
- [ ] **Edit frontmatter properties in the panel without touching raw YAML**
	  **Parent:** [[Rundock-Roadmap#users-edit-knowledge-inline-without-switching-to-obsidian]]
	  **Problem:** As a user viewing a file's properties panel, I want to edit values there (text, lists, wikilinks, dates), so that updating metadata does not require switching to raw markdown or to Obsidian.
	  **Acceptance criteria (user-observable):**
	  - [ ] Text, list, and wikilink property values are editable in the panel and persist correctly to the file's YAML
	  - [ ] Invalid edits cannot corrupt the frontmatter (the file still parses; body editing unaffected)
	  - [ ] Byte-honest saves: editing one property changes only that property
	  #type/feature #area/editor #size/m #priority/p2
- [ ] **Warn before overwriting a file that changed outside Rundock**
	  **Parent:** [[Rundock-Roadmap#users-edit-knowledge-inline-without-switching-to-obsidian]]
	  **Problem:** As a user who edits the same vault in Rundock and Obsidian (the interchangeable workflow the Kanban story makes binding), I want Rundock to notice when a file changed on disk since it was opened and ask before overwriting, so that auto-save can never silently destroy edits I made elsewhere.
	  **Acceptance criteria (user-observable):**
	  - [ ] Editing a file in Obsidian while it is open in Rundock, then typing in Rundock, produces a visible choice (reload theirs / keep mine) instead of a silent overwrite
	  - [ ] Agent edits to open files surface the same way
	  - [ ] No prompt when nothing external changed (zero false positives in normal use)
	  #type/feature #area/editor #size/m #priority/p2
- [ ] **Review agent-produced HTML files with inline comments agents can act on**
	  **Parent:** [[Rundock-Roadmap#the-team-improves-itself-with-the-operators-approval]]
	  **Problem:** As a user whose agents produce HTML deliverables (proposals, slides, designs), I want to view them faithfully in Rundock and leave comments anchored to what I see, so that an agent can execute my feedback without me switching apps or describing locations by hand.
	  **Acceptance criteria (user-observable):**
	  - [ ] An HTML file in the workspace renders faithfully (sandboxed) instead of showing source
	  - [ ] I can leave a comment anchored to a passage; the comment is stored openly (file-native or sidecar) and an agent can read it, act on it, and resolve it
	  - [ ] Verdict/handback payloads use the same shape as the shipped file-level review loop, so one interaction language spans inline, batch, and (later) inbox review
	  **Approach:** design-complete: [[FV2-Design]] (file-type registry + sandboxed viewer; registry seam already in code), [[Review-And-Feedback-Loop-Spec]] phases 1-2, batch-verdict surface per the proven c1 pattern. Roughdraft is the live prototype: mine it, don't rebuild it.
	  **Dependencies:** none hard; registry swap lands after the client extraction merges.
	  #type/feature #area/editor #size/l #priority/p2
- [ ] **Open images and PDFs in Rundock, including from wikilinks in conversations**
	  **Parent:** [[Rundock-Roadmap#users-edit-knowledge-inline-without-switching-to-obsidian]]
	  **Problem:** As a user whose workspace contains images and PDFs (agent-generated or dropped in via Finder), I want clicking them, in the file tree or as a wikilink in a conversation, to show the actual image or document, so that I never have to leave Rundock to look at my own files.
	  **Acceptance criteria (user-observable):**
	  - [ ] Clicking an image in the file tree shows the image; clicking a PDF shows a readable document view
	  - [ ] Clicking a wikilink to an image or PDF in a CONVERSATION opens it the same way (agents reference their outputs by wikilink; those links must not be dead ends)
	  - [ ] Unsupported binary types degrade gracefully (clear "cannot preview" state, never raw bytes)
	  - [ ] No upload mechanism in scope: the workspace is a local folder; Finder is the upload mechanism
	  **Approach:** file-type registry views (the registry ships with the HTML-review card above); wikilink resolution already exists for markdown targets and extends to these types.
	  **Dependencies:** the file-type registry (HTML-review card). Same lane; same delivery plan.
	  **Tags:** #type/feature #area/editor #size/m #priority/p2
- [ ] **Persist routine state so restarts cannot double-fire scheduled work**
	  **Problem:** Routine last-run state lives in memory, so a restart after a routine has fired can fire it again (duplicate morning briefings observed). The common exposure is the DESKTOP quit-and-reopen pattern, not long-running servers: any user who reopens Rundock later the same day is in the window. Deprioritised 2026-07-16 (Liam): the routine-using population is small today; grows with the scheduled-work roadmap outcome.
	  **Acceptance criteria:**
	  - [ ] A routine that ran, followed by a restart inside the same window, does not run again (pinned by test)
	  - [ ] State survives in `.rundock/` alongside other workspace state
	  #type/bug #area/platform #size/s #priority/p2
- [ ] **Manage markdown Kanban boards inside Rundock (Obsidian Kanban parity)**
	  **Parent:** [[Rundock-Roadmap#users-edit-knowledge-inline-without-switching-to-obsidian]]
	  **Problem:** As a user who runs backlogs and roadmaps as Obsidian Kanban boards (this backlog is one), I want Rundock to render and edit them as real boards, so that managing my work does not require Obsidian.
	  **Acceptance criteria (user-observable):**
	  - [ ] A `kanban-plugin: board` markdown file opens as a column board; cards drag between columns; edits persist to markdown
	  - [ ] BINDING (Liam, 2026-07-16): full format interchangeability with the Obsidian Kanban plugin: the exact same structure and syntax, so one board file is edited in Rundock and Obsidian alternately with neither app breaking the other's features (checkboxes, card metadata, archive section, settings block)
	  - [ ] The BACKLOG FILE ITSELF round-trips: open in Rundock, move a card, open in Obsidian, move a card back, nothing broken and no formatting churn in the diff
	  **Approach (two-step, deliberate):** (1) reverse-engineer the plugin's format as research: the docs (https://publish.obsidian.md/kanban/Obsidian+Kanban+Plugin) and the source (https://github.com/obsidian-community/obsidian-kanban), covering the frontmatter settings block, column/card syntax, archive handling, and any metadata the plugin round-trips; then a standalone local prototype against a COPY of this backlog file answers the drag/persistence questions, validated by alternating edits between the prototype and Obsidian; (2) the Rundock build lands as a registry view AFTER the HTML-review card ships the file-type registry (building it earlier means building it twice).
	  **Dependencies:** the file-type registry (HTML-review card above). Deliberately last in this column.
	  #type/feature #area/platform #size/l #priority/p3


## Test Before

- [ ] **Queue a follow-up that races an in-flight handoff instead of losing it**
	  **Problem:** A message sent in the moment an agent handoff is completing can be written to a dying process and lost, or clear a committed handback. Rare, but when it happens the user's message silently vanishes: the worst failure mode a chat product has.
	  **Acceptance criteria:**
	  - [ ] A message sent during any kill/handback window is delivered to the restored process and answered, never dropped (pinned by an integration test that fires the race deliberately)
	  **Approach:** small state machine in the kill-window path; folds into the dispatcher extraction above (same layer, same motion).
	  #type/bug #area/platform #size/s #priority/p2
- [ ] **Extract the conversation state machine as the WS dispatcher, with contract fixtures shared with the server**
	  **Spec:** [[Client-Test-Coverage-Spec]] (stage 3 of 3) · **Delivery plan:** [[R10-Rundock-Quiet-Cycle-Handoff]] phase 2 (one paired effort with the protocol story above)
	  **Problem:** The client's multi-agent orchestration experience (who is working, who joined, who resumed, which events are stale, which turns are silent) is a several-hundred-line untested switch. It is the layer users watch when they "watch delegation happen", and the layer this month's client bugs lived in. A server/client divergence in the delegation protocol is currently only catchable by a human noticing the UI misbehave.
	  **Acceptance criteria:**
	  - [ ] The per-conversation state machine is a reducer ((state, message) -> state + effects) unit-tested per message family, including the full delegation sequences (join, stale-done suppression, silent park, resume)
	  - [ ] The server's stub-runtime delegation sequences run as table-driven CLIENT tests from one shared fixture corpus: a protocol divergence is a failing test
	  - [ ] Dispatcher events carry enough to attribute and log a decision (the enabler for [[Rundock-Roadmap#the-team-improves-itself-with-the-operators-approval]])
	  - [ ] Zero behaviour change per commit (full suite + e2e green)
	  - [ ] Folded hygiene (was a separate Inbox card): the 'info' system subtype's session-clearing side effect is audited and side-effect-free senders move to 'notice'; designed-path done-suppression logs stop logging at warn level; notice pills render wikilinks as links
	  #type/hygiene #area/platform #size/l #priority/p1
- [ ] **New card (with added text) + more added text**
	*New italic text here*
	And standard text here


## In Progress

- [ ] **Upgrade Electron from 39 to 42 to clear the dependency-security audit cluster**
	  **Problem:** `npm audit` reports a cluster of advisories rooted in the packaged Electron version. Users are not directly exposed today, but every fresh contributor install prints security warnings, and the gap widens with each Electron release. Deferred from the 0.10.0 train ("wrong moment for a runtime bump"); the quiet cycle is the right moment.
	  **Acceptance criteria:**
	  - [ ] `npm audit` reports zero advisories from the Electron cluster
	  - [ ] Full suite + e2e green; a locally built packaged app launches and stays alive (the 0.10.0 packaging lesson: this change class breaks packaging silently)
	  - [ ] Auto-update from a 0.10.0 install to a build on the new Electron works
	  #type/hygiene #area/release #size/s #priority/p1


## Test after

- [ ] **Extract the client's decision logic into unit-tested modules (palette, conversation list, markers, permissions)**
	  **Spec:** [[Client-Test-Coverage-Spec]] (stage 2 of 3) · **Delivery plan:** [[R10-Rundock-Quiet-Cycle-Handoff]] phase 1
	  **Problem:** app.js is 4,401 lines at 30.9% test coverage, and it holds logic users feel directly: this is where the vanishing-short-reply bug and the stale focus ring shipped from. It also holds the permission/risk classification the trust page's claims rest on, unfindable by anyone accepting the licence's "audit it" invitation. New client logic lands untestable by default until this is done.
	  **Acceptance criteria:**
	  - [ ] Palette, conversation-list, marker-scanning, and permission/risk logic live in ES modules unit-tested at 90%+ lines, with zero behaviour change (full suite + e2e green before and after every extraction commit)
	  - [ ] The permissions module is findable by name and documents the auto-allow policy it implements
	  - [ ] Overall client line coverage at least doubles from the 30.9% baseline and the ratchet (never goes down) is recorded
	  #type/hygiene #area/platform #size/m #priority/p1


## Done

- [ ] **Codex agents stream, approve, and cancel like Claude agents on every platform**
	  **Parent:** [[Rundock-Roadmap#users-run-their-team-on-whichever-ai-subscription-they-already-have]]
	  **Problem:** As a user running specialists on my ChatGPT plan, I want their replies to stream live, every command and file write to ask my permission individually where no sandbox protects me, and cancel to stop them instantly, so that a Codex teammate is as trustworthy and responsive as a Claude one.
	  **Acceptance criteria (user-observable):**
	  - [ ] A Codex agent's reply renders progressively as it is produced, not all at once at the end of the turn
	  - [ ] On Windows without the native sandbox, a Codex agent running a shell command or writing a file produces a permission card for THAT action; deny stops it, approve runs it
	  - [ ] Pressing stop on a streaming Codex turn halts output within a second and the conversation accepts the next message normally
	  - [ ] A Codex conversation resumed after a Rundock restart retains its context
	  - [ ] The write-request card flow shipped in 0.10.0 no longer exists as a separate mechanism (its behaviour is subsumed by per-action approvals)
	  **Approach:** integrate via Codex's app-server protocol; design record [[Codex-Windows-Writes-F-vs-E]] ("Option E"); delivery plan [[R10-Rundock-Quiet-Cycle-Handoff]] phase 2, including the runtime adapter contract that makes a third runtime additive.
	  **Dependencies:** the client decision-logic extraction above (same message layer; sequence, don't overlap). Windows live pass requires Liam's VM.
	  #type/feature #area/platform #size/l #priority/p1


## Shipped

- [x] **Update repo README, About, site, and docs for Codex availability** — SHIPPED in 0.10.0 (2026-07-14)
	  All surfaces on the two-runtime story with one canonical description ("Works with your Claude or ChatGPT subscription"): GitHub About (Liam), README (runtimes section, Node 22 correction, per-runtime security section), CHANGELOG Codex narrative, package.json, Doc's scaffold descriptions, docs.rundock.ai/concepts/runtimes CREATED (the in-app 404 target) + installation/how-rundock-works/trust pages, site metas + JSON-LD + llms.txt + body copy (index, download; trust tile now "Two runtimes"). Copy discipline: ChatGPT is always "add a plan for specialists", never an alternative (the orchestrator requires Claude Code); compare page deliberately left Claude-scoped; testimonial quotes untouched. e2e spec vault-path comment removed. Repo commits 46965f3/5328e62/022ff33, docs 60e3cf8, site a9dd4fe/91c2060.
	  #type/ops
- [x] **Stop unlabelled code blocks mis-highlighting as VB.NET in the conversations UI** — SHIPPED in 0.10.0 (2026-07-14) (shipped to main in 1e0a373)
	  Option B as approved, all four slices in one pass: decision logic extracted to code-language.js (pure UMD, unit-tested in Node against the real vendored hljs build); explicit hints unchanged; plaintext/text/plain first-class (escaped, labelled "text"); unlabelled blocks auto-detect over a curated subset (markdown in, vbnet out) gated on relevance >= 5, tuned by measurement (prose 2, plain lists/logs 4, real content 6-9). Regression suite pins the upstream vbnet misdetection so removing the gate fails loudly. 10 new tests; suite 556 → 566. Remaining manual AC (eyeball the original two blocks in the live app) lands with Liam's next session on the release build.
	  #type/bug #area/platform #size/s #priority/p2
- [x] **Index Codex-runtime conversations for content search** — SHIPPED in 0.10.0 (2026-07-14) (shipped to main in 30d006a)
	  Codex thread files resolve via the rollout filename convention (one file per thread; resumes append, verified against real sessions, so byte-offset reconcile applies unchanged). Extractor indexes user + assistant text and excludes developer instructions, environment_context blocks, and Rundock's injected identity prompt. Mixed conversations index both runtimes under one conversation id. All acceptance criteria met; live-verified against the real demo workspace (28 messages, real phrases findable, injected prompts absent). Suite 551 → 556.
	  #type/bug #area/platform #size/s #priority/p1
- [x] **Codex runtime: run agents on the Codex CLI** — SHIPPED in 0.10.0 (2026-07-14) (merged to main in 73b4d14, PR #13)
	  Agents with `runtime: codex` run on the official Codex CLI under a ChatGPT plan: direct chat with thread resume, cross-runtime delegation (Claude orchestrator → Codex specialist, transactional handback), review annotations with correct attribution, quota/auth/model failures classified into guidance cards, runtime status detection in Settings (presence-only evidence), off-roster impersonation guard, Windows write support (direct sandboxed writes with `[windows] sandbox` configured; validated write-request markers behind permission cards without it, never silent read-only). Live-tested end to end on Mac (7 checkpoints) and Windows ARM (9 checkpoints); suite 253 → 549 across the release train. Run of record: `01_Projects/Fable-Testing-July-2026/FV1-Run-Notes.md` rounds 15-23.
	  #type/feature #area/platform #size/xl #priority/p1
- [x] **Make the left sidebar width adjustable (drag-resize, persisted)** — SHIPPED in 0.10.0 (2026-07-14; merged 2026-07-13) (shipped to main in d6a2ad0)
	  Drag handle on the sidebar's inner edge, clamped 200-480px, width persisted locally, one width shared by team/conversations/skills/files views, default unchanged. Reuses the review panel's resize interaction grammar. Built on post-merge main as planned. All acceptance criteria verified by measurement (default 280, drag accuracy, both clamps, persistence across reload, cross-view width).
	  #type/feature #area/platform #size/s #priority/p2
- [x] **Render markdown tables in the Tiptap rich markdown editor** — SHIPPED in 0.10.0 (2026-07-14; merged 2026-07-13) (shipped to main in 280080a)
	  GFM tables render and edit in the rich editor with STRICT source-preserving serialization: unedited tables round-trip byte-for-byte (padding, alignment markers, column spacing), an edited cell changes only its own bytes, undo restores the source exactly, and blockquote/list-nested and ragged rows hold. Cell editing inline; add/remove rows supported (canonical style for new rows). Wide tables scroll in place. Fixed three pre-existing save-drift bugs found by the byte-for-byte bar (frontmatter blank line, 10+-item ordered-list padding, POSIX trailing newline).
	  #type/feature #area/platform #size/s #priority/p2
- [x] **Native inline markdown review in the Rundock editor** — SHIPPED in 0.10.0 (2026-07-14; merged 2026-07-13) (shipped to main in 280080a; superseded the prototype-first phasing per Liam 2026-07-12: wire format and UX were live-proven in Roughdraft + c1-review.html, so it went straight to a production build)
	  Roughdraft-style review native in the editor: five CriticMarkup constructs as atoms on the free Tiptap core, YAML endmatter for attribution/threading, review sidebar with Accept/Reject verdicts, reply/resolve, both authoring directions, workspace identity ("Me"/agent roster/Unattributed), orphan-highlight handling, and byte-exact round-trips. The Suggest-mode open question resolved from real usage: suggestions are agent-authored; humans comment (full-width Comment action). Reference semantics: ids are invisible plumbing, display numbers positional, cross-party references quote text. Done-Reviewing gate deferred with the agent-apply decision. Design decisions of record in [[Review-And-Feedback-Loop-Spec]] ("Phase 2 as built").
	  #type/feature #area/editor #size/l #priority/p3
- [x] **SPIKE: CriticMarkup / Pandiff rendering in the Tiptap editor** — SHIPPED in 0.10.0 (2026-07-14; merged 2026-07-13) (superseded by the production build shipped in 280080a, per Liam's 2026-07-12 decision to skip the throwaway phase)
	  All acceptance questions answered in-flight and folded into [[Review-And-Feedback-Loop-Spec]]: custom atoms (not marks — escaping would drift bytes), YAML-endmatter serializer with byte-exact round-trip, resolve lifecycle + overlapping/orphan handling, Tiptap Pro rejection confirmed unnecessary. Pandiff untouched; still the reference for the future agent-apply "propose edits" direction.
	  #type/research #area/editor #size/s #priority/p2
- [ ] **Add Playwright E2E smoke suite with client coverage measurement**
	**Spec:** [[Client-Test-Coverage-Spec]] (stage 1 of 3)
	**Problem:** `public/app.js` (4,130 lines, the entire user-facing layer) has zero automated regression protection. During SR1, two user-facing bugs shipped through the 338-test suite because both lived in the browser layer the suite cannot observe: the anchor flash replayed on every view switch (CSS animations restart on `display:none` cycles), and the nav rail desynced from the destination when navigating from search. Manual driven verification caught them once; nothing re-checks on later changes.
	**Approach:** Playwright (devDependency only) driving the real server + browser, ~10 tests: the two escaped bugs as named invariant tests, plus palette golden paths. Browser-side V8 coverage (`page.coverage`) converted to lcov and merged with the Node runner's report so `app.js` gets a tracked coverage number and baseline. CI job lands non-blocking for a two-week soak, then flips to gating releases. Architecture decisions frozen in the spec (incl. why jsdom was rejected).
	**Files touched:** new `test/e2e/` directory, `package.json` (devDependency + scripts), CI workflow, `.gitignore` (Playwright artefacts)
	**Acceptance criteria:**
	- [ ] Named regression test: a search-anchored message flashes once and does not re-flash when navigating away and back
	- [ ] Named regression test: opening each result type (conversation, file, agent, skill) from each origin view (conversations, files, skills, team) lands with nav icon, sidebar, and main view in agreement (the full matrix)
	- [ ] Golden paths covered: palette opens via nav icon and Cmd+K, grouped results render with highlights, Enter navigates, Esc closes and restores focus
	- [ ] Deliberately reverting the anchor-flash fix or the setNavState fix makes the corresponding named test fail (proof the net catches exactly what escaped)
	- [ ] `public/app.js` appears in the merged coverage report with a recorded baseline
	- [ ] E2E job runs in CI non-blocking; a dated follow-up note records when to flip it to gating (two weeks after landing, if flake-free)
	- [ ] Suite runs deterministically against a seeded temp workspace (no dependence on a real vault or live model)
	**Dependencies:** none (resequenced by Liam 2026-07-12: built directly on the `universal-search` branch, which merges to `main` ahead of the Codex branch). Stage 1 must land before stages 2-3 (it is their behaviour-preservation safety net).
	**Out of scope:** any refactor of `app.js` (stages 2-3); expanding E2E beyond ~10 tests to chase coverage (depth belongs to unit tests on extracted modules).
	**Release note:** ships in the SAME release as universal search. Test-only, zero product-code risk, and it protects exactly the features in that release (Liam, 2026-07-12).
	**Tags:** #type/hygiene #area/platform #size/m #priority/p1
	**Notes:** Specced by Dev 2026-07-12 from the SR1 production-readiness review. Coverage context: server.js 84.6%, search.js 98.5%, app.js 0%. DONE (Dev, 2026-07-13): merged to main in 47067b4. 10 E2E tests, all acceptance criteria met incl. both revert-proofs. Client coverage baseline: public/app.js 31.3% lines (1,293/4,130). CI e2e job green on first run (non-blocking soak until 2026-07-27).
- [x] **Windows support** *(shipped 0.9.0)*
	  Rundock now runs on Windows: native NSIS installer (Desktop + Start Menu shortcuts) + portable `.exe`, built x64 via the activated `windows-latest` CI job. First-run wizard works on Windows: platform-aware menu (File/Edit/View/Help), `darwin`-only `titleBarStyle`, fixed window sizing, Windows install command (PowerShell/WinGet), and a one-click **"Sign in to Claude"** button that launches the OAuth flow (no terminal needed; lands on Mac too). Rundock adds Claude's `.local\bin` to the user PATH on first-run (Anthropic's installer doesn't). Wizard now also gates on auth (no more silent 401). **The hard part — permissions on Windows:** the hook needs a runtime (packaged users have no `node`) so it runs via Rundock's bundled runtime; it must cover the **PowerShell tool** (Windows shell tool, not Bash); and the launcher must be invoked with PowerShell's `&` call operator (Claude runs hooks via PowerShell, which treats a bare quoted path as a string). All three landed → permission cards work on Windows. Validated end-to-end in Parallels (install → wizard → sign-in → permission cards → MCP connectors). rundock.ai/download now offers a Windows installer with a SmartScreen note. Reused @DMCK96's titleBarStyle/menu/win-config ideas (credit logged). **Remaining:** 2-3 real **x64** beta testers (VM is ARM); code signing deferred (SmartScreen click-through documented).
	  #type/feature #area/release #size/m #priority/p2
- [x] **CI release pipeline + universal Mac build** *(shipped 0.8.14)*
	  Moved releases off Liam's laptop to a tag-triggered GitHub Actions workflow (`.github/workflows/release.yml`) that builds, signs, notarises, and publishes a draft release; Apple credentials moved from `.env` to 6 GitHub Secrets (see [[CI-Release-Setup]]). `release.js` collapsed to bump-and-tag (`890834e`). The Mac build is now a **universal** DMG (one download for Apple Silicon + Intel, no architecture to choose) — `ffab87c`, validated in CI (universal binary contains x86_64 + arm64, notarised). New **rundock.ai/download** page with a smart OS-detected download button + "Other platforms" link and a Windows "Coming soon" row; all site footers routed through `/download`. Absorbed the retired Intel x64 card. `windows-latest`/`ubuntu-latest` jobs are scaffolded for their platform cards. Failure recovery is now re-run-the-tag (no `main` revert). Pipeline proven by cutting 0.8.14 itself through it.
	  #type/ops #area/release #size/m #priority/p2
- [x] **Show a recovery card when the Claude Code sign-in expires (401)** *(shipped 0.8.13)*
	  When a Claude Code session expired, Rundock forwarded the raw 401 `authentication_error` blob, which looked like a crash (5+ users got stuck). It now detects the case and shows a recovery card with reconnect steps + a copy button, plus a Troubleshooting > Authentication docs page. `3379f3f` (+ docs `16da2ef`).
	  #type/feature #area/platform #size/s #priority/p1
- [x] **MCP read/write permissions across all sources (B-unified)** *(shipped 0.8.13)*
	  Knowledge mode now auto-approves read-style MCP calls and shows a permission card for writes/destructive actions, uniformly across workspace `.mcp.json`, user-global servers, and Claude.ai connectors. MCP removed from `--allowed-tools` and routed through the permission hook (read/destructive classification, server-side). Code mode unchanged. Subsumes the v2.1.166 fix. `f5d6518`.
	  #type/feature #area/platform #size/m #priority/p2
- [x] **Syntax highlighting and copy button for chat code blocks** *(shipped 0.8.13)*
	  Chat code blocks render with highlight.js syntax highlighting (vendored locally, works offline) and a copy button, with the theme following the app's light/dark setting. Isolated and hardened from external PRs #6/#7 + #10/#11 (escaped label, clipboard fallback, auto-detect cap); @dougseven credited as co-author. `01186ee`.
	  #type/feature #area/platform #size/m #priority/p2
- [x] **Update positioning copy to "visual workspace for your AI agent team"** *(shipped 0.8.13)*
	  Updated the two remaining "visual interface" surfaces in the repo (README opening line + scaffold product description). `04d1a1c`.
	  #type/hygiene #area/scaffold #size/xs #priority/p2
- [x] **Replace blanket mcp__* allow rule with per-server scopes for Claude Code v2.1.166+** *(shipped 0.8.12)*
	  Claude Code v2.1.166 tightened `--allowed-tools` validation and rejected the blanket `mcp__*` allow rule, erroring before every response and dropping MCP tools to per-invocation prompts. Fixed with a per-spawn allow-list builder that reads `WORKSPACE/.mcp.json` and expands registered servers into `mcp__<server>__*` scopes, a shared `readMcpServerNames()` reader (replacing a duplicate parser), and server-name validation against injection. Shipped as `af6eb27`. Correct diagnosis credited to @dougseven (#8 / #9). Validated by an 8/8 logic suite, a live in-app test, and a clean-clone + signed-build gate.
	  #type/bug #area/platform #size/s #priority/p1
- [x] **Render agent profile capabilities (Reads from / Writes to) consistently** *(shipped 0.8.12)*
	  The capabilities card rendered Writes to as a single comma-joined line while Reads from listed each entry separately, and reads entries were unescaped. Both sections now list each entry on its own line, HTML-escaped, with the split preserving entries that contain commas inside parentheses (e.g. subreddit lists), padded list items, and a null-safe display name. Shipped as `c29e3b7` (contribution from @dougseven, PR #3) plus follow-up `c363f87`. PR #3 and issue #4 closed with credit.
	  #type/bug #area/platform #size/xs #priority/p2
- [x] **Replace the file editor with a Tiptap rich markdown editor** *(shipped 0.8.11)*
	  Markdown files now open in a Tiptap-based WYSIWYG editor that formats text as you type, replacing the previous Preview/Edit toggle. Custom Wikilink (inline atom) and Callout (block atom) nodes preserve Obsidian-flavoured syntax through markdown-it plugins registered via tiptap-markdown's `parse.setup` hook; the SoftHardBreak extension overrides the GFM hard-break serialiser to plain `\n` so round-trips are byte-for-byte. Frontmatter renders in a read-only properties panel above the editor (editable in a follow-up). Floating toolbar on selection covers bold, italic, code, link, h1, h2, h3. External links open on plain click with `target=_blank`; the link prompt normalises bare domains to `https://`. Non-markdown files fall through to the legacy preview/edit pane unchanged. Bundle infrastructure under `public/vendor/`; editor module under `public/editor/`.
	  #type/feature #area/platform #size/l #priority/p1
- [x] **Add Cmd+F find within the active conversation and file view** *(shipped 0.8.11)*
	  In-view find for the active panel. Press Cmd+F (Ctrl+F on Windows and Linux) to search the current conversation, an open markdown file, or a non-markdown file preview. Three search backends share a single find-bar UI: text-node DOM walks with `<mark class="find-match">` wrapping via the Range API for the conversation messages and the legacy preview, and a ProseMirror decoration plugin for the markdown editor that never modifies the document. The bar shows position as you go (e.g. *3 of 12*), navigates via Enter / Shift+Enter with wrap-around, and clears cleanly on Esc or any navigation to a different view. Resolves the long-standing gap that browser-native Cmd+F was broken in the Electron window and only ever matched currently-rendered DOM in browser tabs.
	  #type/hygiene #area/platform #size/m #priority/p2
- [x] **Conversation sidebar: session continuity on reopen and stronger selected-row contrast** *(shipped 0.8.11)*
	  Two conversation-sidebar polish items shipped together. (1) Reopening Rundock now lands on the conversation last opened in that workspace, falling back to the most-recently-active non-archived conversation when the last-opened is missing or archived. The default-load priority chain replaced three pinned-first patterns in `handlePersistedConversations`, the post-delete handler, and the nav-to-conversations fallback with a shared `pickDefaultConversation` helper. (2) Selected conversation rows use a terracotta tint (`var(--accent-glow)`) instead of the same neutral elevated background as hover, with a slightly stronger tint on hover-while-selected so the active row stays identifiable when scanning. `lastActiveConversationId` persists per workspace via `.rundock/state.json`.
	  #type/hygiene #area/platform #size/s #priority/p2
- [x] **Restore agent message content lost in get_session_history merge** *(shipped 0.8.11)*
	  Old agent messages no longer render as blank bubbles on reload. The merge in `get_session_history` was pairing real agent transcript entries with whitespace-only JSONL entries via a permissive substring match, producing empty bubbles where the original responses should have appeared. The fix filters whitespace entries from the jsonl pool, prevents them at the `parseSessionHistory` source, raises the slice limit on reopen from 50 to 200, and raises the per-conversation transcript soft cap from 100 to 1000 (forward-protective only; existing already-dropped middle history stays dropped).
	  #type/bug #area/platform #size/m #priority/p1
- [x] **Fix Windows Claude detection so npm-installed claude.cmd is recognised** *(shipped 0.8.11)*
	  Windows users who installed Claude Code via npm previously hit a first-run wizard error saying Claude was not installed, even though the `.cmd` shim was on PATH. `findClaude` now uses `where.exe` on Windows (parsing multi-line output and preferring `.exe` over `.cmd`) and returns the absolute path. `spawnClaude` uses a new `resolveClaudeBin` helper so the standalone server path doesn't depend on the Electron entry point. `ensurePath` uses `path.delimiter` and adds `%USERPROFILE%\.local\bin`, `%LOCALAPPDATA%\Microsoft\WinGet\Links`, and `%APPDATA%\npm` to PATH on Windows.
	  #type/bug #area/platform #size/s #priority/p1
- [x] **Document Rundock's data, privacy, and security story in the public docs** *(shipped 2026-05-26, docs only)*
	  New top-level Trust section added to the docs navigation, with a Data, privacy, and security page covering where files live, what gets transmitted, training defaults, retention and Zero Data Retention, and the BYOK relationship between users and Anthropic. Designed to be forwardable to a buyer's IT, legal, or compliance lead during evaluation. All Anthropic claims linked to primary sources: Commercial Terms, the commercial data retention policy (30-day default), the Claude Code ZDR docs (available via Commercial-organisation API keys or Claude Enterprise), and the training privacy article. The page also surfaces the limit that ZDR does not extend to third-party MCP servers an agent connects to from the workspace. Surfaced during sales coaching session 2026-05-15 while assessing fit for boutique law firms as an outbound niche; the same page unblocks the regulated sub-segments of consulting and search.
	  #type/hygiene #area/docs #size/s #priority/p1
- [x] **Replace Pinned/Active/Done sidebar sections with filter pills and a left-border state system** *(shipped 0.8.10)*
	  The 0.8.9 three-section model (Pinned, Active with working/unread/idle tiers, Done) created a double-clustering problem at higher conversation volumes: a pinned unread conversation appeared in both the Pinned section and the unread tier of Active. Replaced with a flat list filtered by three pills (All, Unread, Pinned), a left-border state system on each row (green for working or unread, orange for pinned-idle, no border otherwise), and WhatsApp-style recency labels right-aligned in the meta row. Scope expanded during implementation to include the Done to Archive UI rename, a Mark Done sidebar action replacing the soft-delete on non-archived items, a custom CSS tooltip layer with immediate hover-show and simplified copy (Pin / Unpin / Archive / Delete), search results that narrow by the active pill, and a fix for the click-on-archived auto-unarchive bug surfaced during testing. Triggered by James Compton feedback.
	  #type/feature #area/platform #size/s #priority/p2
- [x] **Migrate persisted conversation status from 'done' to 'archived'** *(shipped 0.8.10)*
	  The UI rename of Done to Archive originally left the data model at `status: 'done'` for backwards compatibility, creating an internal mismatch (`isArchivedSet = convo.status === 'done'`) that future readers would have had to context-switch on. Server-side migration in `readConversations()` rewrites `status: 'done'` to `status: 'archived'` on first workspace open, logs a single line, and snapshots the pre-migration file to `.rundock/conversations.json.pre-archive-backup` for manual recovery. Idempotent and failure-safe. Verified on rundock-sandbox-testing (29 conversations, 2 migrated) and Liam-Agent-Workspace (100 conversations, 2 migrated) before release; zero data loss, every non-status field byte-identical to backup.
	  #type/hygiene #area/platform #size/xs #priority/p1
- [x] **Defer the conversation empty state until conversations have loaded** *(shipped 0.8.10)*
	  Opening a workspace used to flash the "No conversations yet" sidebar text and the "Start a conversation" main-panel empty state for a few hundred milliseconds before the get_conversations reply arrived. Pre-0.8.9 the gap was masked by the workspace picker staying visible; 0.8.9's picker-hides-immediately fix exposed it. Added a `conversationsLoaded` boolean to the client state (false on workspace open, true at the top of `handlePersistedConversations`); the sidebar's "No conversations yet" line gates on it, and `onWorkspaceReady` now hides the workspace picker view directly instead of calling `showView('convo-empty')` so the main panel stays blank until handlePersistedConversations picks the right destination.
	  #type/bug #area/platform #size/xs #priority/p1
- [x] **Vertically centre the sidebar search clear button** *(shipped 0.8.10)*
	  The clear (×) button rendered 5px below the search input's vertical centre across conversations, skills, and files. `.sidebar-search-wrap` declares `padding: 0 8px 10px` (10px bottom padding, no top padding), so the wrap is 10px taller than the input and the wrap's vertical centre sits 5px below the input's centre. Shifted the clear button up by 5px via `top: calc(50% - 5px)` on `.sidebar-search-clear`; the existing `translateY(-50%)` continues to pull the button up by half its own height. Single property change on the button, no change to the wrap (an earlier attempt that moved the wrap's padding-bottom to margin-bottom broke the visual framing of the search section).
	  #type/bug #area/platform #size/xs #priority/p2
- [x] **Rework sidebar ordering so pinned, active, and unread conversations surface predictably** *(shipped 0.8.9)*
	  Three-section model in `renderConvoList`. Section A (Pinned) sorts by `lastActiveAt` desc. Section B (Active) uses a three-tier compound sort: working agents first, unread second, idle last, each tier by `lastActiveAt` desc. Section C (Done) collapses at the bottom and shows an unread dot when any done conversation has unread messages. Idle Active items older than seven days fold under a collapsible "Older" section. The Active/Done badge in the chat header reveals "Mark Done" / "Mark Active" on hover. Working-to-idle animation deferred to 0.9.0 after the View Transitions API approach produced visible ghosting.
	  #type/hygiene #area/platform #size/s #priority/p2
- [x] **Hide the workspace picker immediately on selection so it doesn't linger as the workspace loads** *(shipped 0.8.9)*
	  `onWorkspaceReady` calls `showView('convo-empty')` at the end of the different-workspace branch so the picker hides within one frame of the `set_workspace` reply. The reconnect-to-same-workspace branch is untouched, preserving the active view and in-memory conversation list.
	  #type/bug #area/platform #size/xs #priority/p2
- [x] **Teach every agent the basics about Rundock, with Doc holding the full reference** *(shipped 0.8.9)*
	  Two-tier fix. Tier 1 prepends a short identity line to the base system prompt every agent receives: states what Rundock is, gives the docs URL, and routes deeper meta questions to Doc or the docs. Tier 2 rewrites the body of `## What you know` in `scaffold/rundock-guide.md` into "### About Rundock" (what it is, the licence summary, and creator credit with three canonical surfaces) and "### Workspaces" (the existing definition preserved). Follow-up refinement tightens the Tier 1 wording so specialists answer the basic identity question directly rather than routing it.
	  #type/hygiene #area/platform #size/s #priority/p3
- [x] **Add error handlers on every spawned Claude Code child process** *(shipped 0.8.9)*
	  A baseline `'error'` listener now attaches inside the `spawnClaude` wrapper so every spawn callsite is covered safely. Five chat callsites also pass an `onError` callback that surfaces a `system/info` message in the conversation with distinct copy per error code (`ENOENT`, `EACCES`, fallback), dedupes consecutive identical errors per conversation within a 30-second window, and gates close handlers via a new `entry.spawnFailed` flag so error and close paths never double-fire. Follow-up commit emits a `subtype: 'done'` from the error handler so the conversation's "thinking" indicator clears after a spawn failure.
	  #type/bug #area/platform #size/s #priority/p2
- [x] **Harden Doc fallback so a broken scaffold file does not produce duplicate agents** *(shipped 0.8.9)*
	  The built-in `rundock-guide` fallback in `server.js` now checks for the file's existence, not only for an agent with `type: 'platform'`. A second clause `!agents.find(a => a.id === 'rundock-guide')` skips the injection when a file-parsed Doc exists with broken frontmatter, so the agents list never contains two `rundock-guide` entries with the same id.
	  #type/bug #area/platform #size/xs #priority/p3
- [x] **Fix CRLF line-ending bug that breaks agent and skill frontmatter parsing on Windows** *(shipped 0.8.9)*
	  Two-layer fix. `.gitattributes` at the repo root forces LF endings on every text file across all platforms. A new `readNormalisedFile(path)` helper in `server.js` strips `\r\n` to `\n` before frontmatter parsing, routed through seven read sites (agent files, skill `defPath` reads, CLAUDE.md instructions, and the `read_file` endpoint that serves content to the client). Mac smoke test passed by hand-CRLF'ing a test agent and re-opening the workspace; Windows verification by beta users still pending per the spec's deferred Task 9.
	  #type/bug #area/platform #size/s #priority/p1
- [x] **Ship a one-command Windows from-source bootstrap so non-developer Windows users can get into Rundock without a real terminal session** *(shipped 0.8.9)*
	  `scripts/install-windows-source.ps1` runs end-to-end via `irm ... | iex`: detects/installs Node 20+ and Git via `winget`, prompts to install Claude Code via Anthropic's official installer, clones to `%USERPROFILE%\Rundock`, runs `npm install`, and creates a Desktop shortcut and Start Menu entry pointing at a generated `launch-rundock.ps1` launcher. README gains a "Run on Windows (interim)" subsection naming the retirement trigger explicitly. CI smoke test on `windows-latest` covers deps detection, clone, install, shortcuts, and idempotency. Four interactive criteria (Claude consent prompt, double-click launch, beta onboarding call, Parallels rehearsal) deferred pending real-world testing.
	  #type/hygiene #area/release #size/s #priority/p1
- [x] **Tidy the repo root: relocate reference docs into `docs/` and add SECURITY.md** *(shipped 0.8.9)*
	  `AGENTS.md`, `ROUTINES.md`, and `SKILLS.md` moved into `docs/` via `git mv` so history follows. `ARCHITECTURE.md` stays at root per the matklad single-architecture-doc convention. Cross-links in `README.md` and `ARCHITECTURE.md` updated. New `SECURITY.md` at root covers reporting channel, response window, and scope.
	  #type/hygiene #area/docs #size/s #priority/p3
- [x] **Swap README hero image to the launch site app screenshot** *(shipped 0.8.9)*
	  `README.md` now references `docs/rundock-app-hero.png` (a real screenshot of the running app, mirroring the launch site at rundock.ai) instead of the org-chart-only render. Old `docs/rundock-agent-team-org-chart.png` removed.
	  #type/hygiene #area/docs #size/xs #priority/p3
- [x] **Add subtle personal-reference hyperlinks to the README** *(shipped 0.8.9)*
	  Two natural-text hyperlinks. A single short credit line "Built by [Liam Darmody](https://www.linkedin.com/in/liamdarmody/)." sits beneath the opening paragraph as the canonical creator mention. The "Built from real use" principle now opens with "I run my own business" hyperlinked to https://liamdarmody.com. No URLs appear as visible link text.
	  #type/hygiene #area/docs #size/xs #priority/p3
- [x] **Ship Mintlify docs site at docs.rundock.ai**
	  Public docs site live at https://docs.rundock.ai. New `liamdarmody/rundock-docs` repo holds 17 MDX pages across Get Started / Concepts / Guides / Reference plus `docs.json` config, deployed via Mintlify Hobby tier. The original plan was a `rundock.ai/docs` subfolder via Netlify `_redirects` proxy; the proxy approach proved unworkable so a subdomain deploy was the operational fix, with the SEO trade-off accepted. Shipped 2026-05-04, separate from any tagged app release.
	  #type/ops #area/docs #size/s #priority/p1
- [x] **Preserve line breaks in sent messages end-to-end** *(shipped 0.8.8)*
	  Multi-paragraph messages composed with Shift+Enter or pasted text now survive end-to-end through the send pipeline (textarea → WebSocket → transcript → stdin → render) instead of being flattened. Fix was a single CSS rule: `white-space: pre-wrap` on `.msg-user .msg-bubble`. The pipeline was already preserving newlines; the visible regression was HTML rendering collapsing them under default `white-space: normal`.
	  #type/bug #area/platform #size/s #priority/p2
- [x] **Persist orchestrator handoff text to transcript on intercepted delegation** *(shipped 0.8.8)*
	  RETURN-path interception now persists the orchestrator's handoff text correctly. Two changes in `server.js`: send the orchestrator's `done` event AFTER `handleDelegation` returns so `agent_switch` reaches the client while `currentStreamingMsg` is still set; on RETURN-path interception, always append a transcript entry — a `routing`-typed entry with `buildToolSummary(toolCalls)` content when `responseText` is empty. New optional `type` field on `appendTranscript`. Client renderer skips routing entries from chat bubbles.
	  #type/bug #area/platform #size/s #priority/p2
- [x] **Relocate Existing Conversations section below instructions on agent profile page** *(shipped 0.8.8)*
	  Pure DOM reorder in `showProfile()`: the existing-conversations block now renders at the bottom of agent profiles, after the configuration sections (Capabilities, Skills, Routines, Connectors, Model, Instructions). Existing `if(existing.length)` hide-when-empty guard preserved.
	  #type/hygiene #area/platform #size/xs #priority/p2
- [x] **Fix chat message timestamps showing the same time for every message** *(shipped 0.8.8)*
	  Every message in a conversation rendered with the same timestamp on rehydrate (e.g. all 19:51 if the conversation was reopened at 19:51). Root cause was hybrid: `addAgentMsg` computed `Date.now()` at render-time so replayed messages all got the re-open time, and `convo.messages` had no timestamp field. Fix sources timestamps from Claude Code JSONL on rehydrate, stamps live messages at push, and threads the timestamp through `addAgentMsg`. Legacy entries with no JSONL match render no time span (sensible fallback rather than wrong-for-all).
	  #type/bug #area/platform #size/s #priority/p2
- [x] **Deploy Rundock launch site and repo docs to production**
	  Production deploy of the Rundock launch site and repo documentation. Marketing site at rundock.ai (Marketing-Site-Launch.html lifted into `rundock-site/index.html`, 11 image assets moved to repo root). Repo docs at github.com/liamdarmody/rundock root: README.md (overwritten), plus ARCHITECTURE.md, AGENTS.md, SKILLS.md, ROUTINES.md (all new). Followed by post-deploy polish across nine commits: testimonial quote-mark cleanup, mobile horizontal-overflow fix on iOS Safari, hero glow CLS fix via aspect-ratio, og:image swap to a purpose-built typographic asset, and the directory consistency port (Liquid Glass + sticky nav + 3-column footer + shared.css extraction). Shipped via direct push to `rundock-site` main and `rundock` main 2026-04-29 — no app version (site deploys via Netlify on push).
	  #type/ops #area/release #size/m #priority/p1
- [x] **Give orchestrator visibility into specialist output on handback** *(shipped 0.8.7)*
	  Specialist output injected into orchestrator resume prompt via `sanitizeSpecialistOutput`. Silent-park leakage suppressed with `<silent>` sentinel, server-side `isSilentParkResponse` filter, and client-side no-op filter. Delegation dividers persisted as explicit markers in `convo.messages` for navigate-away survival.
	  #type/bug #area/platform #size/m #priority/p2
- [x] **Show skill instructions and description for skills created without frontmatter** *(shipped 0.8.5)*
	  Skills without YAML frontmatter now display full content as instructions. Doc scaffold includes frontmatter template and audit guidance.
	  #type/bug #area/scaffold #size/xs #priority/p2
- [x] **Fix rehydrate rendering: ghost bubbles, message ordering, and false-positive drops** *(shipped 0.8.5)*
	  Transcript-authoritative merge eliminates ghost bubbles and ordering mismatches after page refresh on delegation conversations. Pre-0.8.3 attribution damage accepted as-is.
	  #type/bug #area/platform #size/s #priority/p2
- [x] **Reconcile stale `activeAgentId` pointers on conversation load** *(shipped 0.8.5)*
	  Pre-0.8.3 delegations left `activeAgentId` stuck on delegatee. Reconciliation runs once on load, persists corrected pointer.
	  #type/bug #area/platform #size/s #priority/p2
- [x] **Invalidate skill "Used By" list when SAVE_AGENT modifies an agent's skills frontmatter** *(shipped 0.8.5)*
	  "Used By" list updates immediately after SAVE_AGENT. SAVE_SKILL no longer auto-navigates away from conversation.
	  #type/bug #area/platform #size/xs #priority/p3
- [x] **Include agent identity in `process_started` events sent to frontend** *(shipped 0.8.5)*
	  Agent slug included in `process_started` payload. Frontend logs show actual agent name instead of `agent=?`.
	  #type/hygiene #area/platform #size/xs #priority/p2
- [x] **Add narrow auto-resume gate after COMPLETE marker** *(shipped 0.8.5)*
	  Orchestrator left idle after specialist COMPLETE on sub-delegate path. No silent re-delegation.
	  #type/bug #area/platform #size/s #priority/p1
- [x] **Clear orchestrator working indicator on delegation handoff** *(shipped 0.8.5)*
	  Emits `done` event for orchestrator before specialist's `process_started` at SIGKILL interception site.
	  #type/bug #area/platform #size/xs #priority/p2
- [x] **Page refresh re-invokes orchestrator on completed conversation** *(shipped 0.8.5)*
	  Parked orchestrator process marked idle so client skips it on reconnect.
	  #type/bug #area/platform #size/s #priority/p1
- [x] **Suppress "Cos resumed" badge when orchestrator is parked silently after COMPLETE** *(shipped 0.8.5)*
	  COMPLETE-path rendering no longer emits spurious "[Agent] resumed" badge.
	  #type/bug #area/platform #size/xs #priority/p2
- [x] **SAVE_AGENT marker parser truncates agent files containing markdown code fences** *(shipped 0.8.5)*
	  Parser extracts content between HTML comment markers, treating inner code fences as content. SAVE_SKILL uses same fix.
	  #type/bug #area/platform #size/s #priority/p1
- [x] **Require explicit execution signal before emitting SAVE/DELETE markers in `rundock-guide`** *(shipped 0.8.5)*
	  Doc now proposes before executing. Multi-turn proposal flows supported. Emits COMPLETE not RETURN. SAVE_SKILL emission working.
	  #type/bug #area/scaffold #size/s #priority/p1
- [x] **Add delegation loop circuit breaker and RETURN-path auto-pause** *(shipped 0.8.5)*
	  Auto-pauses after 3 consecutive agent events without user input. Counter resets on each user message.
	  #type/bug #area/platform #size/s #priority/p1
- [x] **Orchestrator must only reference agents on the runtime roster and not claim parallel delegation** *(shipped 0.8.5)*
	  Scaffold orchestrator prompt constrains delegation to runtime roster and states delegation is sequential.
	  #type/bug #area/scaffold #size/xs #priority/p1
- [x] **Support `skills:` frontmatter field for explicit skill-to-agent assignment** *(shipped 0.8.5)*
	  Frontmatter `skills:` field takes precedence over body-text scan. Both methods coexist, duplicates suppressed.
	  #type/feature #area/platform #size/s #priority/p1
- [x] **Prevent orchestrator re-delegation to the specialist that just returned** *(shipped 0.8.5)*
	  Scaffold prompt instruction plus code-level guard with clear error message on edge cases.
	  #type/bug #area/platform #size/xs #priority/p2
- [x] **Harden orchestrator error messaging on tool failure** *(shipped 0.8.5)*
	  Error strings describe what happened factually. No loaded words that invite the model to infer platform rules.
	  #type/bug #area/platform #size/s #priority/p1
- [x] **Neutralise canned permission hook timeout message** *(shipped 0.8.5)*
	  Hook failure messages describe observed failure without inferring user intent. No "user" in fallback text.
	  #type/bug #area/platform #size/xs #priority/p2
- [x] **Filter stale entries from recent workspaces list and derive names from path** *(shipped 0.8.5)*
	  Deleted directories filtered from picker, names derived from current path, scaffold guards against recreating deleted directories.
	  #type/hygiene #area/platform #size/xs #priority/p2
- [x] **Unify Conversations sidebar footer chrome with adjacent panels** *(shipped 0.8.5)*
	  Fixed footer with separator aligned to chat input border-top. Full-width button, SVG icon, subtle hover treatment.
	  #type/hygiene #area/platform #size/xs #priority/p2
- [x] **Deterministic tag placement in release script** *(shipped 0.8.5)*
	  `gh release create` receives `--target <sha>` pointing at the version-bump commit.
	  #type/bug #area/release #size/xs #priority/p2
- [x] **Auto-commit and push version bump before tagging** *(shipped 0.8.5)*
	  Release script commits, pushes, and runs pre-flight checks (clean tree, on main, remote reachable) before tagging.
	  #type/bug #area/release #size/xs #priority/p2
- [x] **Preserve blank line after Unreleased heading promotion** *(shipped 0.8.5)*
	  Fixed `\s*` to `[ \t]*` in `promoteUnreleasedChangelog` regex.
	  #type/bug #area/release #size/xs #priority/p2
- [x] **Port rundock-guide mode-gating fix to scaffold** *(shipped 0.8.5)*
	  Onboarding default orchestrator rule gated behind `[WORKSPACE_ANALYSIS]` check. "Existing workspace mode" section with six concrete rules added.
	  #type/bug #area/scaffold #size/s #priority/p1
- [x] **Resume delegate's prior session on re-delegation instead of spawning fresh**
	  **Shipped:** Re-delegations to a specialist already in the conversation now pass `--resume <prior-session-id>` to the spawn path. The specialist retains tool results, reasoning, and working state from earlier turns; only the new delegation brief is sent, not a full transcript replay. Platform delegates continue to cold-spawn under the transactional one-shot pattern. Session-id bookkeeping is unchanged: the CLI extends the existing JSONL in place, so the frontend's dedup check handles it with no schema changes.
	  **Shipped in:** 0.8.6 (2026-04-17)
	  **Notes:** Reproduced on conversation `1776378506613` with four accumulated content-lead sessions before the fix. Commit `1c16bf1`.
	  #type/bug #area/platform #size/m #priority/p2
- [x] **Render sidebar agent and preview from last agent message, not reconciled `activeAgentId`**
	  **Shipped:** Server now enriches each persisted conversation on workspace load with `lastAgentId` and `lastMessagePreview` derived from the final agent message in the transcript. Sidebar renders the last speaker's avatar and name for idle conversations, the currently-active agent during live delegation, and a clean plain-text preview of the last message. Preview pipeline strips tool-call markers, paired RUNDOCK marker blocks (including the YAML payload between them), markdown formatting, and HTML comments so the sidebar reads as human-readable prose regardless of what the transcript contains.
	  **Shipped in:** 0.8.6 (2026-04-17)
	  **Notes:** Commits `1c16bf1` (server enrichment + base render), `c35d414` (frontend hydration), `4f6d1bf` (tool-marker strip), `7c491f1` (markdown strip), `4f7222d` (paired RUNDOCK marker block strip). Originally surfaced in 0.8.5 after cut; too late for that release.
	  #type/bug #area/platform #size/s #priority/p2
- [x] **Align chat input label with actual message recipient when a conversation has a live process**
	  **Shipped:** Server's `active_processes` WebSocket message now includes idle-but-alive processes with `idle: true`. Client sets `activeAgentId` and `activeProcessId` for both processing and idle entries, and the history-load reconciliation now gates on `activeProcessId` instead of `isProcessing`. Chat input placeholder, header avatar/name, and actual message routing all point at the same agent after a page reload — idle-but-alive specialists are preserved through the reload instead of being overwritten by the default orchestrator attribution.
	  **Shipped in:** 0.8.6 (2026-04-17)
	  **Notes:** Commits `369a162` (initial client fix keyed on `isProcessing` — too narrow) and `ff445ea` (server surfaces idle processes + client handles them). Surfaced in sandbox testing: input said "Message Ted..." while messages routed to Nina.
	  #type/bug #area/platform #size/s #priority/p2
- [x] **Render orchestrator handoff text and "agent joined" divider on intercepted delegations**
	  **Shipped:** On intercepted delegations (orchestrator uses the Agent tool, server SIGKILLs mid-stream, emits `agent_switch`), the `agent_switch` handler now captures `outgoingAgentId` before reassigning `activeAgentId`, strips RUNDOCK markers from accumulated streaming text, promotes the streaming DOM node to a permanent message, and pushes the cleaned text to `convo.messages` under the outgoing agent's id. Orchestrator's brief handoff text and the "[specialist] joined" divider now render in the correct order during live delegation, matching post-reload history view.
	  **Shipped in:** 0.8.6 (2026-04-17)
	  **Notes:** Pre-existing bug; caught during 0.8.6 testing on sandbox conversation `1776425281982`. Commit `98baef8`.
	  #type/bug #area/platform #size/m #priority/p2
- [x] **Ship delegation hygiene and permission reliability bundle**
	  **Shipped:** Delegation pipeline split into RETURN (out-of-scope) vs COMPLETE (pipeline finished) markers so orchestrators stop re-delegating after clean completion and stop silent-resume narrating filler. Routing prompt gagged against user-facing chatter, delegation briefs tagged so rehydrate drops them, specialists no longer narrate briefs in chat. Permission hook bundled into packaged builds (scripts directory marked `asarUnpack`, Electron-aware path resolution) with stale-entry auto-repair on workspace open: every packaged-build user since the hook architecture shipped had a silently broken permission system, and 0.8.3 auto-heals their stale settings on first launch. UI fixes: outgoing-agent working indicator clears on handoff, chat-status header resets on workspace switch, nav rail unread indicators reset on workspace switch, late responses no longer dirty unread on the wrong workspace.
	  **Shipped in:** 0.8.3 (2026-04-13)
	  **Notes:** Migrated from [[2026-04-16-Rundock-Roadmap#delegation-hygiene-and-permission-reliability]] 2026-04-15. Reclassified from [[Rundock-Roadmap]] Shipped as a tactical multi-fix delivery bundle with no strategic outcome parent. Recorded here for historical delivery tracking.
	  #type/ops #area/platform #size/l #priority/p1
- [x] **Redesign Skills UI to sidebar and detail page pattern**
	  **Shipped:** Skills UI moved to a sidebar + detail page layout. Addressed user testing feedback on skills panel confusion.
	  **Shipped in:** 0.8.0 (2026-04-09)
	  **Notes:** Mock: `mocks/skills-redesign.html`. Migrated from [[2026-04-16-Rundock-Roadmap#skills-ui-redesign]] 2026-04-15. Reclassified from [[Rundock-Roadmap]] Shipped as a tactical UI change without a strategic outcome parent.
	  #type/ops #area/platform #size/m #priority/p2
- [x] **Ship stability pass bundle**
	  **Shipped:** Five scoped reliability items: MCP routing, `--bare` flag, reconnection, crash cleanup, audit v2. Routing coverage descoped at the time and later added to this backlog as a standalone audit item.
	  **Shipped in:** 0.8.0 (2026-04-09)
	  **Notes:** Spec: [[Workspace-Audit-v2]]. Migrated from [[2026-04-16-Rundock-Roadmap#stability-pass]] 2026-04-15. Reclassified from [[Rundock-Roadmap]] Shipped as a tactical multi-fix delivery bundle with no strategic outcome parent.
	  #type/ops #area/platform #size/l #priority/p1
- [x] **Ship code signing and auto-update**
	  **Shipped:** Enrolled in Apple Developer Program. Signed `.dmg`, notarisation, auto-update via GitHub Releases.
	  **Shipped in:** 0.8.0 (2026-04-09)
	  **Notes:** Migrated from [[2026-04-16-Rundock-Roadmap#code-signing-and-auto-update]] 2026-04-15. Reclassified from [[Rundock-Roadmap]] Shipped as a release-infrastructure bundle with no strategic outcome parent.
	  #type/ops #area/platform #size/m #priority/p1
- [x] **Prepare Rundock for open source release**
	  **Shipped:** LICENSE, CONTRIBUTING.md, issue templates, README, commit history review. Demo GIF deferred.
	  **Shipped in:** 0.8.0 (2026-04-09)
	  **Notes:** Migrated from [[2026-04-16-Rundock-Roadmap#open-source-prep]] 2026-04-15. Reclassified from [[Rundock-Roadmap]] Shipped as a release-prep bundle with no strategic outcome parent.
	  #type/ops #area/platform #size/m #priority/p2


***

## Archive

- [ ] **Release pipeline launches the packaged app before signing**
	  **Problem:** The first 0.10.0 build died on launch (a module missing from the packaging manifest) and no gate had ever launched the packaged app: tests drive the source tree and the pipeline built without running. The contents gate added in the incident checks presence, not behaviour; a human launch is on the runbook but manual steps get skipped under pressure (that is how the incident happened).
	  **Acceptance criteria:**
	  - [ ] The release pipeline boots the built app on the macOS runner after packing and fails the build if the process exits within a grace window
	  - [ ] Verified by deliberately breaking the manifest on a branch: the pipeline catches it
	  #type/hygiene #area/release #size/s #priority/p2
- [ ] Adding a new card as part of the test

%% kanban:settings
```
{"kanban-plugin":"board","list-collapse":[true,false,false,false,true,false,false,false],"mark-cards-in-list-as-complete":["Done","Shipped"]}
```
%%