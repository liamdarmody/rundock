# The release smoke test presses Allow on the hand-off card: the smoke run

**This file is a dated record of runs on one machine, not a source of truth.**
The smoke test re-measures every claim below each time the release gate runs
it. If this file and that run ever disagree, the run is right.

Taken on 2026-11-13 on macOS (Darwin 25.4.0, arm64) with Node 24.12.0, at
`cd9e8ed9`, the last commit to change `scripts/smoke/run.mjs`; the commit
after it adds only this file. CI does not run the smoke test, so this is the
record of it.

---

## What changed

S3 in `scripts/smoke/run.mjs` has the orchestrator bring Doc in to create an
agent. A save Doc makes while another agent brought it in waits on a card,
and nothing is written until the person presses Allow. S3 now finds the
permission card whose summary is exactly "Add the agent smokey" (a
`.permission-summary` matched against the whole text, not text anywhere on
the card), records that the agent's file does not exist yet, presses the
card's Allow, and then runs its three existing checks.

## Before the change

`npm run smoke` on the release candidate: 21/24 checks passed. The three S3
checks failed: the file on disk, the created line, and the marker payload
check that depends on them.

## The smoke run at `cd9e8ed9`

`npm run smoke`, outside the sandbox:

```
PASS  S0 server boots from source
PASS  S0 server prints its sign-in link
PASS  S1 direct orchestrator turn renders a reply
PASS  S1 turn event recorded
PASS  S2 delegation intercepts on realStream shape and the delegate answers
PASS  S2 delegation_start event (to kit, intercepted)
PASS  S2 no off-roster block for the reportsTo-less specialist
PASS  S3 a save during a hand-off waits on a card whose summary names the agent
PASS  S3 nothing is written before Allow
PASS  S3 Doc SAVE_AGENT marker creates the file on disk
PASS  S3 created pill renders
PASS  S3 marker payload never renders as message text
PASS  S4 specialist scope return hands back (handback event, kind return)
PASS  S5 low-risk command auto-approves without a card
PASS  S5 high-risk command shows the permission card
PASS  S5 clicking Allow resolves the hook request
PASS  S5 permission event recorded
PASS  S5b a listing that discards its error output auto-approves
PASS  S5b a shell operator inside quotes is text, not a separator
PASS  S5b a destructive command after a lone & does not auto-approve
PASS  S7 in-workspace write allowed instantly by the hook
PASS  S7 outside-workspace write produces the boundary card
PASS  S7 folder approval resolves the hook with allow
PASS  S7 grant persisted into the workspace, folder-level
PASS  S7 granted folder allows silently on the next access
PASS  S6 events log carries structure, never message content
26/26 checks passed
```
