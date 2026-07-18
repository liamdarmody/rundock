---

kanban-plugin: board

---

## Guidance

- [ ] **What goes on the roadmap**
	  A roadmap card describes a problem we've committed to solving or an outcome we're working toward. It is strategic, not tactical. One paragraph maximum.
	  Rule of thumb: if you can write acceptance criteria for it, it belongs on the backlog, not here. A roadmap card is answered by one or more backlog items, not by a single commit.
- [ ] **Card title format**
	  Outcome or problem statement, not feature name.
	  Good: "Specialists land on the org chart with a valid parent"
	  Good: "Releases are safe to cut unattended"
	  Bad: "Add reportsTo validation" (that's a backlog item)
	  Bad: "SAVE_AGENT marker rework" (that's implementation detail)
- [ ] **Card body (required and optional fields)**
	  Required:
	  • **Why now:** one sentence on the trigger or evidence
	  • **Target outcome:** what changes in the world, observable if possible
	  • Column placement (Now / Next / Later)
	  Optional:
	  • **Success signal:** how we'll know it worked, one metric or observable behaviour
	  • **Linked backlog:** wikilinks to [[Rundock-Backlog]] items that ladder up to this card
	  • **Tags**
- [ ] **What does NOT go on the roadmap**
	  No acceptance criteria, file paths, function names, effort estimates, commit hashes, or implementation notes. If you catch yourself writing any of those, the thought belongs on the backlog.
- [ ] **Columns (certainty gradient, not timeline)**
	  **Shipped:** delivered. Kept for 30 days, then archived to `04_Archive/`. Leftmost active column: completed items exit left.
	  **Now:** actively being worked or next up. High certainty. Has at least one backlog item in progress or Ready.
	  **Next:** committed to pursuing after Now clears. Medium certainty. May not yet have backlog items.
	  **Later:** on the radar, not yet committed. Low certainty. Rationale captured, details deliberately vague.
- [ ] **Tagging scheme**
	  `#area/...` platform, scaffold, docs, release, onboarding
	  `#horizon/...` now, next, later (mirrors column, useful for search)
	  `#confidence/...` high, medium, low
	  `#theme/...` optional grouping (e.g. `#theme/hygiene`, `#theme/dx`)
- [ ] **Linking to the backlog**
	  One roadmap card resolves to one or more backlog items. Use Obsidian wikilinks in the "Linked backlog" field: `[[Rundock-Backlog#card-slug]]`. Every `#type/feature` backlog item in Ready / In Progress / Done must link up to exactly one roadmap card. `#type/bug`, `#type/hygiene`, and `#type/ops` items can stand alone without a parent (see the Backlog.md Parent rule for details). Inbox items can be unlinked regardless of type.
- [ ] **Cards in Now must have linked backlog items**
	  A roadmap card with zero linked backlog items is either in Later (intentional, per DEEP "Detailed appropriately": items further out in the pull order stay high-level) or in Next awaiting activation. **Cards in Now with zero items in Ready or In Progress are a bug in the pull queue.** When a card moves from Next to Now, the same action creates at least one backlog item under it. A card should not sit in Now without linked work for more than one work session: if it does, either the backlog items were not written (fix the queue) or the card is not actually ready to pull (move it back to Next).
- [ ] **Example card (copy and adapt)**
	  **Specialists land on the org chart with a valid parent**
	  **Why now:** Doc assigned `reportsTo: team-lead` to a specialist in a workspace where the orchestrator slug is `chief-of-staff`, so the specialist was invisible in the org chart (0.8.3 incident).
	  **Target outcome:** Every specialist created in an existing workspace has a `reportsTo` value that resolves to a real agent in that workspace.
	  **Success signal:** Zero orphaned specialists reported over a 30-day window after 0.8.5.
	  **Linked backlog:** [[Rundock-Backlog#port-rundock-guide-mode-gating-fix-to-scaffold]]
	  #area/platform #horizon/now #confidence/high


## Shipped

- [x] **Changes to Rundock's core can't regress silently**
	  **Shipped:** 0.9.2 (2026-07-03)
	  Rundock's delegation and orchestration engine, previously changed blind, is now covered by an automated test suite with a harness that reproduces the full multi-agent delegation lifecycle without a live model. The suite runs on every change and must pass before any release build is produced, so a regression in the core engine is caught before it reaches users rather than in the field. The same release fixed a batch of reliability and hardening defects in that engine that were surfaced while the net was being built: more dependable specialist hand-offs, safer conversation history, immediate visibility of newly created agents, and a tighter workspace file boundary.
	  **Success signal:** A regression in the covered engine surfaces as a failed check on its change before merge, not as a user-visible bug in a shipped build.
	  #area/release #horizon/shipped #theme/dx
- [x] **Rundock is downloadable on every platform users run**
	  **Shipped:** Windows 0.9.0 (2026-06-26), Intel Mac 0.8.14 (2026-06-25)
	  A user on macOS Apple Silicon, macOS Intel, or Windows can download a native installer from the website and run Rundock without a terminal session; installing Claude Code is the only command-line step. The download page distinguishes the platform builds so users pick the right one. The Windows build is unsigned for now, so SmartScreen shows a one-time "More info → Run anyway" prompt, explained on the page. SmartScreen-clean signing (Azure Trusted Signing) is a demand-gated refinement now carried on the backlog, pulled when Windows conversions justify it rather than on a calendar.
	  #area/release #horizon/shipped
- [ ] <!-- Shipped 0.8.0–0.8.4 (April 2026) archived per the 30-day retention rule → [[2026-07-03-Rundock-Roadmap-Shipped-Archive]] -->


## Now

- [ ] **Users run their team on whichever AI subscription they already have**
	  **Why now:** 0.10.0 shipped the Codex runtime and every public surface (site, README, About) now claims "works with your Claude or ChatGPT subscription". The shipped integration is honest but first-generation: Codex replies arrive at end-of-turn rather than streaming, there are no per-action approvals (Windows file writes use a card-based workaround; shell commands can't be individually approved anywhere), and a ChatGPT-only subscriber still cannot onboard at all because the wizard installs Claude Code only. The positioning is ahead of the product; this outcome closes the gap.
	  **Target outcome:** A specialist on the Codex runtime is indistinguishable in capability and trustworthiness from a Claude one on every platform: replies stream live, every side effect can be individually approved, cancel is instant, and conversations survive restarts. A user whose only subscription is a ChatGPT plan can install Rundock, complete first-run, and operate a working team.
	  **Success signal:** A ChatGPT-plan user goes from download to a completed delegation without ever being told to buy a Claude subscription; Codex conversations are visually indistinguishable from Claude ones in responsiveness and approval behaviour.
	  **Linked backlog:** [[Rundock-Backlog#codex-agents-stream-approve-and-cancel-like-claude-agents-on-every-platform]] (Ready), [[Rundock-Backlog#first-run-onboarding-works-for-chatgpt-only-users]] (Ready), [[Rundock-Backlog#codex-only-workspaces-run-a-full-team-without-claude-code-installed]] (Inbox, gated)
	  #area/platform #horizon/now #confidence/high

- [ ] **Users organise conversations into themed projects**
	  **Why now:** Beta user James Compton asked for it 2026-04-24: "Rundock could benefit from project folders which consists of chats that can be with different agents, so the project is a theme". The workflow is already latent: users run multiple conversations with different agents on the same client, product, or research area, and they get interleaved chronologically with unrelated work. First iteration is cheap because no agent-level or server-level machinery is required — just a UI grouping layer above the existing sidebar.
	  **Target outcome:** A Rundock user can group conversations into named, collapsible folders in the sidebar so related work on the same theme lives together rather than being interleaved chronologically with everything else. Folders persist across page reloads and workspace switches, and survive the existing Pinned / Active / Done ordering behaviour.
	  **Success signal:** Within one month of shipping, at least one user actively uses project folders — self-reported until workspace-health observability lands, observable in usage afterwards. Secondary: James reports the feature addresses his original ask.
	  **Linked backlog:** [[Rundock-Backlog#organise-conversations-with-lists-so-related-work-stays-together]] (Ready, first iteration), [[Rundock-Backlog#add-project-folders-to-the-conversation-sidebar-for-grouping-related-conversations]] (Inbox, shaping decision pending vs Lists)
	  #area/platform #horizon/now #confidence/high

- [ ] **Users edit knowledge inline without switching to Obsidian**
	  **Why now:** Raw textarea editing is the last workflow that forces users out of Rundock into Obsidian. With 0.8.5 shipping the correctness platform (orchestrator auto-resume gate, `rundock-guide` propose-first rule, release-pipeline hygiene) and the Tiptap validation prototype proving all five round-trip tests pass, the editor is the next strategic move. Spec is finalised at revision 2.2 with three user-facing phases.
	  **Target outcome:** Every agent and knowledge file in the Rundock workspace can be edited inline via a rich WYSIWYG editor with auto-save, with full round-trip fidelity to Obsidian-flavour markdown syntax (wikilinks, callouts, frontmatter, bold, headings, lists, code blocks). No external editor switch required for any task that previously needed Obsidian.
	  **Success signal:** Open any knowledge file, click into the body, edit, reload the workspace, edits persist exactly as typed. Frontmatter renders as a structured panel and cannot be accidentally broken by body editing. Auto-save fires within 2 seconds of typing pause.
	  **Spec:** [[Tiptap-Editor-Implementation]], [[Editor-and-Collaboration-Decision]]
	  **Linked backlog:** editor shipped through 0.10.0 (rich editing, tables, inline review). Current: [[Rundock-Backlog#render-obsidian-callouts-and-make-frontmatter-wikilinks-clickable-in-the-editor]] (Ready), [[Rundock-Backlog#edit-frontmatter-properties-in-the-panel-without-touching-raw-yaml]] (Ready), [[Rundock-Backlog#warn-before-overwriting-a-file-that-changed-outside-rundock]] (Ready), [[Rundock-Backlog#manage-markdown-kanban-boards-inside-rundock-obsidian-kanban-parity]] (Ready, registry-gated), [[Rundock-Backlog#open-images-and-pdfs-in-rundock-including-from-wikilinks-in-conversations]] (Ready, registry-gated)
	  #area/platform #horizon/now #confidence/high



## Next

- [ ] **The team improves itself, with the operator's approval**
	  **Why now:** The three pieces exist separately and are each proven: the file-level review loop shipped in 0.10.0 (inline comments and suggestions with attributed accept/reject, live-proven on both runtimes), the batch-verdict pattern is live-proven in content review (itemised verdicts with a machine-readable handback), and the workspace-level approval inbox with an append-only attributed decision ledger is live-proven in the Edition experiment (external; transfer path pre-engineered). What does not exist is the connected loop: agents propose, the operator decides in one consistent interaction language at any zoom level (a passage, a batch, an inbox), agents apply, and every decision is attributed and auditable. This is also the gate on the spend-governance positioning ("every token traces to an attributed human decision").
	  **Target outcome:** An agent proposal, wherever it appears (inline in a file, in a batch review, in the approvals inbox), carries the same verdict affordances and produces the same machine-readable, attributed decision record; accepted proposals are applied by agents without manual editing; the operator can audit any decision after the fact.
	  **Success signal:** One full loop completes in product: an agent proposes an improvement, the operator approves it, an agent applies it, and the decision trail shows who decided what and when. The spend-governance positioning card ungates.
	  **Linked backlog:** [[Rundock-Backlog#address-open-review-comments-with-one-click-done-reviewing-gate]] (Inbox: the substantive loop shipped in 0.10.0; this is the remaining one-click affordance), [[Rundock-Backlog#review-agent-produced-html-files-with-inline-comments-agents-can-act-on]] (Ready), [[Rundock-Backlog#requests-transfer-the-edition-surface-into-rundock-gated-liam-deems-the-edition-experiment-ready]] (Inbox, gated)
	  #area/platform #horizon/next #confidence/medium


## Later

- [ ] **Teams use Rundock together**
	  **Why now:** Split out of the old "second user as always-on cloud service" card 2026-04-15. A team sharing a sync service they already own (Dropbox, Google Drive, git) is a leaner path to multi-user Rundock than provisioning a central server. Architecture is unproven but cheap to test, and avoids both infrastructure spend and access-control design.
	  **Target outcome:** Two or more people use a shared Rundock workspace from their own machines. Changes to agents, skills, and knowledge are visible to each other via the sync service the team already owns. Access control piggybacks on that service's existing permissions. Zero infrastructure cost to Rundock.
	  **Success signal:** A second person opens a shared workspace, makes a change, and the first person sees it on next launch without manual export or re-scaffold. No conflict files in normal-use traffic over a one-week window.
	  **Lean candidate:** Device Sync. Local state separation into `~/.rundock/` (credentials, sessions, memory). Assembly engine scans `Agents/`, `Skills/`, `Knowledge/` directories and rebuilds `.claude/` on launch. Sync layer is whatever the team already uses.
	  **Documented fallback candidates:** Rank-ordered if the Device Sync spike retires. (1) Real-Time Collaboration via Yjs + Hocuspocus on Tiptap (AI agents as CRDT peers) if concurrent-edit conflicts prove unworkable on the sync-service approach: see [[Real-Time-Collaboration-Research]]. (2) Full-cloud team workspaces (shared conversations, centralised access control) if the outcome needs live multi-user state that neither Device Sync nor RTC-on-local-files can deliver: this route merges back into `Interactive remote access to Rundock from anywhere` since it requires the same infrastructure.
	  **Absorbed:** Old Later cards 2026-04-15: Device Sync (now the lean candidate above), Team Workspace Structure (`rundock.yaml` / CLAUDE.md merge / collision-handling work, which becomes backlog items under this card when the spike passes), Team Workspaces (full-cloud fallback above), Real-Time Collaboration (RTC fallback above).
	  **Spec:** None yet. The old Device Sync Later card carries the original architectural sketch.
	  **Linked backlog:** [[Rundock-Backlog]] contains the Device Sync two-machine spike as the first and only item. Beyond the spike, backlog items are created when the spike validates the approach and the card moves up. Per DEEP "Detailed appropriately".
	  **Dependencies:** Gated on the Device Sync spike. If concurrent-edit conflicts, secrets handling, or live session state prove unworkable, this card retires and teams fall under `Interactive remote access to Rundock from anywhere` instead.
	  #area/platform #horizon/later #confidence/medium
- [ ] **Rundock runs scheduled work while I'm away**
	  **Why now:** Split out of the old "second user as always-on cloud service" card 2026-04-15. Anthropic's Claude Code Routines (see [[Routines-as-Cloud-Compute]] research, 2026-04-15) can credibly back the scheduled-automation half of the original cloud plan at zero infrastructure cost: routines run on Anthropic's compute, billed to the user's Pro/Max, with workspace context carried by a shadow GitHub repo. Materially cheaper than Hetzner and ships faster. The pre-baby window rewards the lean path.
	  **Target outcome:** A Rundock user sets up a scheduled automation (daily briefing, weekly review, alert triage) that runs on its own schedule without Rundock having to be open on any machine, without Rundock provisioning compute, and without the user keeping their machine awake. Results flow back via an observable channel (MCP connector, shadow repo commit, or session URL).
	  **Success signal:** A daily briefing routine fires on schedule for seven consecutive days, producing usable output each time, without Rundock running anywhere during the fire window.
	  **Lean candidate:** Routines-as-compute. Shadow GitHub repo per workspace carries `CLAUDE.md`, `.claude/skills/`, `.claude/agents/`, and context files. Rundock provides a setup wizard and fires routines via the `/fire` API trigger. Scheduling uses Anthropic's built-in scheduler.
	  **Absorbed:** Old "Always-On Workspace" Later card 2026-04-15. That card's outcome ("persistent agent connections, background processing, webhook triggers") is this card's outcome, now delivered via Routines-as-compute rather than a Rundock-managed server.
	  **Spec:** [[Routines-as-Cloud-Compute]] (research, not yet a committed spec).
	  **Linked backlog:** [[Rundock-Backlog]] contains the Routines end-to-end spike as the first and only item. Beyond the spike, backlog items are created when the spike validates the approach and the card moves up.
	  **Dependencies:** Gated on the Routines spike. Risks named in the research: research-preview status, unknown daily run caps, manual routine creation friction, no output-capture API. If any of these prove prohibitive, this card retires and scheduled work falls under `Interactive remote access to Rundock from anywhere`.
	  #area/platform #horizon/later #confidence/medium
- [ ] **Interactive remote access to Rundock from anywhere**
	  **Why now:** Split out of the old "second user as always-on cloud service" card 2026-04-15. Neither Device Sync (lean candidate for teams) nor Routines-as-compute (lean candidate for scheduled work) can deliver live interactive conversations with agents from a device that isn't running Rundock locally. The "phone away from my desk" use case survives both leaner alternatives and is the only remaining case where a Hetzner-shaped server is required. Parked as low-confidence until the other two cards prove the gap is real.
	  **Target outcome:** A user holds a live, interactive conversation with their Rundock agent team from a device that isn't running Rundock locally, with orchestrator routing, specialist delegation, and file access working end-to-end.
	  **Success signal:** To be developed if and when this card advances. Not worth defining until the gap is visible in practice.
	  **Absorbed:** Old Later cards 2026-04-15: Browser Cloud Access (`workspace-name.rundock.cloud`, login page, same app served remotely), Full Auth and User Accounts (signup, login, session management), Mobile-Responsive UI (phone/tablet browser access), Cloud Security Hardening (WORKSPACE refactor, safePath, TOCTOU spawn lock). All four describe parts of the infrastructure this card would need if it ever advances. They become backlog items if and when that happens.
	  **Spec:** [[Cloud-MVP-Spec]], [[Cloud-Security-Spec]], [[Electron-Cloud-Spec]], [[Cloud-Architecture-Decisions]]. These become the reference implementation only if this card moves up.
	  **Linked backlog:** None. No items until the other two cards ship or retire and the demand for interactive cloud is validated in practice.
	  **Dependencies:** Do not start until `Teams use Rundock together` and `Rundock runs scheduled work while I'm away` have both landed or both retired. If both leaner paths succeed and no one asks for interactive cloud over six months, archive this card.
	  #area/platform #horizon/later #confidence/low
- [ ] **Operators can tell whether their agent team is healthy**
	  **Why now:** Merged out of the old Organisation Health System + Usage Analytics Dashboard Later cards 2026-04-15. Today a Rundock operator has no visibility into whether their agents are being used, whether they're producing output that gets accepted, or whether the team shape itself makes sense. Layer 1 (stability pass) shipped already. Layers 2-3 (usage dashboard, quality monitoring) are outcome-adjacent but not yet needed because Liam is still the only active operator.
	  **Target outcome:** A Rundock operator can answer three questions from inside Rundock: (1) which agents am I using and how often, (2) which agents are producing output I accept vs reject, and (3) is my team shape (roster, routing, delegation chains) working.
	  **Success signal:** After one month of daily use with the health system live, the operator can point to one concrete decision they made (retire an agent, reshape a routing rule, adjust a skill) based on what the health system surfaced.
	  **Absorbed:** Old Later cards 2026-04-15: Organisation Health System (the parent idea), Usage Analytics Dashboard (layer 2 of org health per its own card body).
	  **Linked backlog:** None yet. Per DEEP "Detailed appropriately". Backlog items created when this card moves from Later to Next.
	  **Dependencies:** None. Independent of the teams/cloud stack. Pure observability work on the local workspace.
	  #area/platform #horizon/later #confidence/medium
- [ ] **Operators discover and install agents and skills built by others**
	  **Why now:** Merged out of the old Marketplace + Playbook Portability Format Later cards 2026-04-15. Longest-horizon card on the roadmap. No work happens until three preconditions are met: (1) Rundock has users beyond Liam, (2) those users are building agents and skills worth sharing, and (3) distribution demand is observed rather than assumed.
	  **Target outcome:** A Rundock operator browses a catalogue of agents and skills built by others, installs one with a single action, and uses it in their workspace without manual setup. The catalogue supports publish, install, and rate operations.
	  **Success signal:** One non-Liam user publishes one agent or skill that one other non-Liam user installs and uses.
	  **Absorbed:** Old Later cards 2026-04-15: Marketplace (the user-visible outcome), Playbook Portability Format (the technical substrate, which becomes the first backlog item under this card when it moves up).
	  **Linked backlog:** None yet. First backlog item when this card moves up: a playbook portability format (distributable skills with dependency declaration and install-time resolution), because the catalogue needs something to catalogue.
	  **Dependencies:** Blocked on Rundock having users beyond Liam. Gated behind `Teams use Rundock together` and `Interactive remote access to Rundock from anywhere` both producing real non-Liam users.
	  #area/platform #horizon/later #confidence/low
- [ ] **Complex multi-step delegations are observable and run in parallel**
	  **Why now:** Merged out of the old Progress Tracking + Parallel Delegation Later cards 2026-04-15. Long-running delegations today are opaque (the operator can't see intermediate state) and serial (independent subtasks wait in line). Both limits bite when the delegation shape gets ambitious, which 0.8.x shipping the correctness platform is making more common.
	  **Target outcome:** When a specialist runs a long multi-step task, the operator can see progress in real time via a visible plan-file state machine. When a specialist has independent subtasks, they run in parallel rather than in sequence, so the whole delegation finishes in roughly the time of the longest subtask rather than the sum of all subtasks.
	  **Success signal:** A delegation with three independent subtasks completes in the time of the longest one, with all three visible in the UI as they progress. The operator can glance at the Rundock window and see what's being worked on without opening individual conversations.
	  **Lean candidate:** Plan files as state machines (pattern from Dispatch). Workers update plan files; orchestrator reads for status. UI renders as progress bars. Parallel delegation uses one of: Claude Code Agent Teams, open-multi-agent, or a custom layer.
	  **Absorbed:** Old Later cards 2026-04-15: Progress Tracking (file-based progress visibility), Parallel Delegation (multiple agents on independent subtasks).
	  **Linked backlog:** None yet. Per DEEP "Detailed appropriately". Backlog items created when this card moves up.
	  **Dependencies:** Builds on Delegation Context Tiers (shipped 0.8.2). Progress Tracking is a prerequisite for Parallel Delegation within this card.
	  #area/platform #horizon/later #confidence/medium
- [ ] **Agent output reaches the operator outside Rundock's UI**
	  **Why now:** Split out of the old Notification Layer Later card 2026-04-15. Today, anything an agent produces is only visible inside the Rundock window. For scheduled work (see `Rundock runs scheduled work while I'm away`) and any other async agent activity, the operator has no way to be notified somewhere they actually are (phone, Slack, messaging app). Small card, isolated scope, but becomes more important once async activity grows.
	  **Target outcome:** A Rundock operator receives agent output at a channel of their choice (Telegram, Discord, iMessage, Slack, email) when the agent decides the output warrants interrupting them. Rundock provides the plumbing; the agent decides what's worth pushing.
	  **Success signal:** An agent finishes a scheduled task and the operator sees the result on their phone without opening Rundock.
	  **Lean candidate:** Claude Code Channels for the outbound side. MCP connectors (Telegram, Discord, Slack) for the delivery side. Agent-level rules for what counts as notification-worthy.
	  **Absorbed:** Old "Notification Layer" Later card 2026-04-15.
	  **Linked backlog:** None yet. Per DEEP "Detailed appropriately".
	  **Dependencies:** Most valuable once `Rundock runs scheduled work while I'm away` has landed. Not strictly blocked, though: an always-open Rundock conversation can still benefit from async notifications.
	  #area/platform #horizon/later #confidence/low




%% kanban:settings
```
{"kanban-plugin":"board","list-collapse":[true,true,false,false,false],"mark-cards-in-list-as-complete":["Shipped"]}
```
%%