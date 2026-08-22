# Rundock routines

A routine in Rundock is a scheduled prompt sent to a specific agent on a cadence. The same prompt the user would type in the conversation panel, fired automatically at a time the user defines.

Routines power the kind of automation that needs to happen unattended: a morning briefing on the orchestrator, an end-of-day sync that processes the day's meeting notes, a weekly research digest that runs before the user is awake. They are the scheduled equivalent of clicking "send" on a prompt every day.

Every routine is declared on the agent it runs for. The agent file's frontmatter has a `routines:` array; each entry is one routine. Rundock discovers routines when it discovers agents, registers them with a per-minute scheduler, and fires them when their schedule comes due.

```
<workspace>/.claude/agents/<slug>.md
  └── frontmatter
      └── routines:
          - name: ...
            schedule: ...
            prompt: ...
            description: ...
```

Routines are a Rundock concept. The `routines:` array is read by Rundock's scheduler and ignored by Claude Code. An agent file with routines works in plain Claude Code; the routines just do not run there.

## Frontmatter reference

Each entry in the `routines:` array is a YAML object with four fields. The parser is `parseRoutines` in `lib/agents/discovery.js`. It splits the array on `  - name:` markers, reads each indented `key: value` line within a block, and pushes the result if a `name` was found. Anything else in the block is silently dropped.

| Field | Type | Scope | Required | Purpose | Example |
|---|---|---|---|---|---|
| `name` | string | Rundock-only | Yes | Display name for the routine. Shown in the Routines panel, on the agent profile, and in the scheduler logs. Required: a routine without a `name` is dropped during parse. | `name: Morning briefing` |
| `schedule` | string | Rundock-only | Yes | When the routine runs. Accepts only the human-readable forms documented below. The scheduler ignores routines with an unrecognised schedule (silent fail). | `schedule: every day at 05:00` |
| `prompt` | string | Rundock-only | Yes | The instruction sent to the agent when the routine fires. Treated as a single user message: the same text the user would type. | `prompt: Run the morning briefing` |
| `description` | string | Rundock-only | No | One-line plain English explanation of the routine, surfaced on the agent profile. Optional: omitting it does not break the routine. | `description: Triage today's tasks, calendar, and content pipeline.` |

The whole `routines` block is Rundock-only. Claude Code does not parse it. Other tools that read agent frontmatter ignore it.

A minimal valid routine has `name`, `schedule`, and `prompt`. The fourth field, `description`, is for the user reading the profile, not for the scheduler.

## Schedule format

The `schedule` field accepts only two patterns. Both are exact regex matches.

| Pattern | Format | Notes |
|---|---|---|
| Daily | `every day at HH:MM` | Hour and minute must be two-digit, zero-padded. `09:00` works; `9:00` does not match. |
| Weekly | `every <weekday> at HH:MM` | Weekday must be one of `monday`, `tuesday`, `wednesday`, `thursday`, `friday`, `saturday`, `sunday`, lowercase, full word. Two-digit zero-padded time. |

Examples that work:

```yaml
schedule: every day at 05:00
schedule: every day at 21:30
schedule: every monday at 09:00
schedule: every friday at 04:00
schedule: every saturday at 03:00
```

Examples that look correct but silently never fire:

```yaml
schedule: 0 5 * * *                # cron: not supported
schedule: every day at 9:00        # missing leading zero on the hour
schedule: every weekday at 18:00   # "weekday" is not a recognised day
schedule: every day @ 05:00        # only "at" is recognised
```

Cron expressions are not supported. The parser does not raise an error on a cron schedule; the scheduler's next-run calculation simply returns null and the routine is skipped on every tick. If a routine has been declared but appears to never run, the schedule string is the first thing to check.

The schedule is interpreted in the local timezone of the machine running Rundock. There is no timezone field on a routine.

## Scheduler behaviour

The scheduler ticks every 60 seconds. On each tick:

1. Rundock re-discovers all agents (this picks up routine changes without a restart).
2. For every routine on every agent, the scheduler computes `getNextRun(schedule, lastRun)`.
3. If the next run time has come due (the current time has passed it), Rundock fires the routine.

Each routine has a `lastRun` guard. Daily routines do not re-fire once they have run at or after their scheduled hour that calendar day; weekly routines do not re-fire on the same weekday they last ran on. The guard is persisted to `.rundock/routine-state.json` in the workspace, so it survives a restart and a routine is not fired twice by one.

**Routines fire only while Rundock is running, but a missed slot is caught up the same day.** If Rundock is closed at 05:00 and you open it at 09:00, the 05:00 routine fires shortly after launch. A next-run time that has already passed stays on today rather than rolling forward to tomorrow, and the scheduler fires anything already due on its next tick.

The catch-up window is the calendar day for daily routines and the weekday for weekly ones. (Pinned by `test/unit/doc-claims.test.js`: change the scheduler's window and that test fails, so this sentence and the behaviour move together.) Closed all of Tuesday means Tuesday's daily run is lost: you get one run on Wednesday, not two. Closed all of Friday means a Friday weekly routine waits until the following Friday.

Catch-up means routines run late, not on time. A 05:00 briefing on a machine opened at 09:00 runs at 09:00. If the timing matters rather than the fact that it ran, see the always-on options below.

The scheduler runs each routine by spawning a headless Claude Code subprocess with the routine's prompt as the input message. The agent slug is passed so Claude Code loads the correct system prompt. The subprocess runs with `--dangerously-skip-permissions` because there is no user available to approve tool calls in real time.

If you want routines to fire while you are away from your computer, see [Always-on routines: VPS or Claude routines](#always-on-routines-vps-or-claude-routines) for two practical paths.

## Always-on routines: VPS or Claude routines

The constraint is real, though narrower than it looks. Rundock's scheduler runs in-process, so routines only fire while the Rundock server is up on your machine. Same-day catch-up covers the common case: close the laptop at night, open it in the morning, and the 04:00 routine runs when you open it. What it cannot do is run at 04:00, or run at all on a day you never open Rundock. There are two practical ways around this, and each has a real cost: one is a small monthly fee plus initial setup time, the other is a separate subscription tier on a different scheduling system. Pick the one that matches the routine you are trying to run.

### Option 1: Run Rundock on a VPS

Keep Rundock running on a small cloud server (Hetzner, DigitalOcean, Hostinger, etc) and reach it from any device through a browser. The scheduler ticks 24/7, routines fire on cadence regardless of whether your laptop is open, and the workspace stays in sync via Obsidian Sync.

For a working setup guide, see Liam's gist: [How to Build a 24/7 Personal AI Agent with Claude Code](https://gist.github.com/liamdarmody/4aba083c26ccb1b3b0f1068ec185ef66). It walks through Ubuntu 24.04 on a VPS, Claude Code installation and authentication, server hardening (ufw, fail2ban, unattended-upgrades), Obsidian Sync, and a systemd service so Rundock comes back up after a reboot. It is opinionated and worked end-to-end at the time of writing. The general pattern (VPS plus authenticated Claude Code plus Rundock as a service) is durable; the specific provider, hardening commands, and pricing will drift. Treat the gist as a starting point and verify each step against current docs before running it on a fresh server.

What this gives you:

- Routines fire 24/7. The morning briefing runs at 05:00 whether you are awake, on a flight, or off the laptop entirely.
- Rundock is reachable from any device with a browser, including phone and tablet.
- Token usage from routines happens on the VPS, outside your interactive sessions, so heavy off-hours work does not eat into the conversation context you are using during the day.

What it costs:

- A small monthly VPS fee. Around £5 to £10 per month at the cheapest reliable tiers.
- One-time setup time. The first run through the gist is a couple of hours if you are comfortable with a Linux terminal, longer if you are not.
- Ongoing maintenance. OS updates, the occasional service restart, and keeping Claude Code authenticated.

### Option 2: Anthropic Claude Code Routines

Anthropic shipped a managed routines feature, currently in research preview, that runs Claude Code sessions on their cloud infrastructure on a schedule, on an HTTP trigger, or in response to GitHub events. See the official docs at [code.claude.com/docs/en/routines](https://code.claude.com/docs/en/routines).

What it is:

- A scheduling layer on Anthropic's side that fires saved Claude Code configurations (prompt + repositories + connectors + environment) on a cadence. Schedules are managed at [claude.ai/code/routines](https://claude.ai/code/routines) or via the `/schedule` CLI command.
- Available on Pro, Max, Team, and Enterprise plans with Claude Code on the web enabled. Daily run caps apply; the minimum recurring interval is one hour.
- Routines run as full Claude Code cloud sessions with skipped approvals, scoped by the repositories, environment, and MCP connectors you attach.

How it relates to Rundock's routines: complementary, not a replacement. Rundock routines fire prompts at agents inside your local agent team, with full read and write access to the workspace (vault, project folders, local files, configured MCP servers). Anthropic's Routines run inside a Claude Code cloud environment with access to whatever you wire into that environment, primarily GitHub repositories and remote connectors. They do not see your local vault or your Rundock agent definitions.

The split that tends to make sense in practice: keep workspace-bound work (morning briefings that read the daily note, end-of-day syncs that write to your vault, anything that depends on local files or a Rundock agent's system prompt) on Rundock's local routines (and host Rundock on a VPS if you need 24/7 firing). Move repo-bound work (PR triage, scheduled code review, release notes) to Anthropic's Routines, which is built for that shape.

### Liam's setup

For reference, Liam runs Rundock on a VPS and schedules context-heavy routines outside working hours, so they do not consume tokens during interactive sessions. The morning briefing, end-of-day sync, and the two weekly research digests all fire on the VPS while the laptop is closed. By the time the day starts, the daily note has been written and the inbox has been triaged.

### When not to bother

Neither option is worth the setup cost for most laptop-only setups, and same-day catch-up is why. The orchestrator's morning briefing is scheduled for 05:00; if you open Rundock at 09:00, it runs at 09:00. The daily note is written and the inbox triaged by the time you have made coffee, which is usually what the routine was for.

Two cases genuinely need an always-on host. The first is when the hour itself matters and not merely that the work happened: a briefing that must be sitting there at 05:00 cannot be produced by a machine that boots at 09:00. The second is a day you never open Rundock at all, because a daily routine missed for a whole calendar day is not replayed the next day.

If neither applies, schedule routines for whenever you tend to be at the machine and let catch-up absorb the rest.

## Where routine output goes

When a routine fires, the spawned Claude Code subprocess produces output on stdout (stream-json) and stderr. **Rundock discards both.** The child's stdout and stderr are attached to the null device, so a routine can print as much as it likes and every write completes. (Pinned by `test/unit/doc-claims.test.js`, which reads this sentence and the configuration the scheduler really passes to the spawn, and fails if either moves without the other.) The model's response and its running commentary do not flow back into a Rundock conversation or notification. What the run *changed* is a separate question with a separate answer: see **What a run can say it changed**, below.

This page used to say the pipes were open but unread, and described that as a deliberate choice. It was a hang. Nothing was reading them, and an unread pipe fills: past roughly 128 KB of output the subprocess could no longer complete its writes and so never exited, so the run never recorded an outcome, the routine stayed marked as in flight, and it did not run again until Rundock was restarted. Verbose stream output passes that in the opening list of available tools alone, and stderr filled the same way. Discarding the output removes the hazard. Whether Rundock should read the output instead was left open here, and the answer is no: it reads Claude Code's session transcript, which needs nothing from the spawn and is the only source that records whether a write succeeded rather than only that the model asked for one.

What Rundock does record:

- The routine's `lastRun` timestamp.
- The routine's `status` (`running`, `completed`, `failed`, or `interrupted`). `completed` and `failed` normally follow the subprocess exit code; `interrupted` is written on startup when a run was still marked `running` when the process died, so a routine killed mid-run is distinguishable from one that failed.
- The routine's `duration` in seconds.
- An `error` string, written only when a start never produced a subprocess at all. A routine whose spawn throws is recorded as `failed` with the reason the failure gave, and with a `duration` of zero, because nothing ran. Its `lastRun` is the instant the start was attempted, so the ordinary guard holds it for the rest of its period rather than retrying it every 60 seconds; the next period attempts it again. One routine failing this way does not stop any other routine on the same tick.

These fields update in the Routines panel and on the agent profile in real time over the WebSocket, except after a failed start, which the next update carries.

### What a run can say it changed

Every run keeps a record of its own under `.rundock/runs/`, and that record lists the files the run changed: the path, the tool that touched it, whether the file was created or edited, and when.

It comes from the session transcript Claude Code writes for the run, not from the run's output. Each run tells Claude Code which session to be, so its transcript is found by an identity the run chose rather than by looking for whatever changed most recently, which would answer with another run's files and look perfectly plausible doing it. The transcript records each tool call's outcome, so a write that failed is not listed as a file the run changed.

Two limits, stated rather than implied. A file written through a shell command is invisible, because there is no path argument to read: the list covers the file tools and nothing else. And a run whose transcript cannot be found or read reports that it does not know, which is a different answer from a run that changed nothing; nothing here turns the first into the second.

The practical implication: any routine that needs to leave a trace should write that trace itself, through the agent's tools. A morning briefing that creates a file in the daily note, a research digest that writes a markdown report to a folder, an end-of-day sync that updates Todoist via MCP: all of these work because the agent's system prompt instructs the agent to write its output to a known location. A routine that simply asks the model to think out loud will produce output that nobody ever reads.

There is no built-in notification when a routine completes. The user notices a routine ran by either seeing the timestamp update in the Routines panel, or seeing the file the agent wrote, or seeing the Todoist tasks the agent created.

## The Routines panel

The Routines panel sits at the bottom of the left sidebar, beneath the team list and the platform agent list. It is workspace-level: routines from every agent in the workspace are aggregated into one flat list.

Each row in the panel shows three things:

- The owning agent's avatar (icon and colour from the agent's frontmatter).
- The routine's `name`.
- A short formatted schedule: `5:00 AM` for daily, `Fri 4:00 AM` for weekly.

While a routine is running, the schedule text is replaced with a `Running...` indicator in the workspace's working colour.

The panel is display-only. Routine rows are not clickable. There is no per-routine enable or disable toggle and no delete control. To pause a routine without deleting it, the only mechanism today is to comment it out (or remove it) from the agent's frontmatter; Rundock will pick up the change on the next scheduler tick.

The agent profile page shows a richer Routines card for each agent that owns routines. Each entry on the profile shows the routine's `name`, the raw `schedule` string, and a status line: `Last run: <relative time> (<status>)` once a run has occurred, or `Not yet run` before the first run.

## Complete example

This is the live `chief-of-staff.md` agent in the workspace. It owns one routine: the morning briefing. Every field is present in the actual file.

```yaml
---
name: chief-of-staff
displayName: Cos
role: Chief of Staff
type: orchestrator
order: 0
icon: ★
colour: "#E87A5A"
description: >
  Chief orchestrator. Protects Liam's time, routes work to specialists,
  manages priorities, and runs daily briefings.
capabilities:
  does: Routes work to specialists, manages priorities, daily briefings, session starts, challenges low-leverage tasks
  reads: Entire workspace, Todoist tasks, Google Calendar, Notion, Granola meeting notes, Readwise highlights
  writes: Daily briefings, meeting notes, knowledge graph updates, task management
  connectors: Todoist, Google Calendar, Notion, Granola, Readwise
routines:
  - name: Morning briefing
    schedule: every day at 05:00
    prompt: Run the morning briefing
    description: Triage today's tasks, calendar, and content pipeline at 5am.
model: opus
---
```

Notes on this routine:

- The schedule uses the daily form, two-digit zero-padded. The scheduler matches it on the first tick that follows 05:00 each day.
- The prompt is short. It assumes the agent's system prompt knows what "the morning briefing" means and how to produce it. The actual session-start logic lives in `System/Context/session-start-protocol.md`, loaded by the orchestrator's body.
- The description appears on Cos's profile under the Routines card. It does not affect the scheduler.

## Common patterns

A handful of patterns that work well in practice. Each one is a small recipe.

**Morning briefing on the orchestrator.** Fires at 5am, runs whatever the orchestrator's body defines as "session start". The orchestrator writes the briefing to the day's daily note so the user sees it when they open the workspace.

```yaml
routines:
  - name: Morning briefing
    schedule: every day at 05:00
    prompt: Run the morning briefing
    description: Triage today's tasks, calendar, and content pipeline at 5am.
```

**End-of-day sync on the executive assistant.** Fires at 9pm, pulls the day's meetings from Granola, writes meeting notes, creates Todoist action items, updates the people graph.

```yaml
routines:
  - name: Granola EOD sync
    schedule: every day at 21:00
    prompt: Run the Granola end-of-day sync
    description: Pull today's meetings from Granola and write notes, tasks, and people updates.
```

**Weekly research digest on a research-focused agent.** Fires once a week before the user is awake. The agent runs a long pipeline (LinkedIn analysis, competitor scan, trending research) and writes a digest to a known folder.

```yaml
routines:
  - name: Weekly research digest
    schedule: every friday at 04:00
    prompt: Run the full weekly research pipeline and produce a digest
    description: Weekly content opportunities digest. Runs Friday before the working day starts.
```

**Weekly AI intelligence digest on the AI research lead.** Fires once a week on a different day so the two long-running weekly routines do not collide.

```yaml
routines:
  - name: Weekly AI intelligence digest
    schedule: every saturday at 03:00
    prompt: Run the full AI research pipeline and produce the weekly signal digest
    description: Weekly AI intelligence digest covering frontier labs, open-source LLMs, and Rundock competitors.
```

**Multiple routines on one agent.** An agent can own as many routines as needed. Use distinct `name` fields and stagger the times so two routines on the same agent do not fire in the same minute.

```yaml
routines:
  - name: Morning sweep
    schedule: every day at 06:00
    prompt: Run the morning sweep
  - name: Afternoon sweep
    schedule: every day at 14:00
    prompt: Run the afternoon sweep
```

## Common pitfalls

A few specific things that go wrong silently.

**Cron expressions silently never fire.** The scheduler does not understand cron. A routine with `schedule: 0 5 * * *` parses fine, registers fine, and never runs. There is no error, no warning, no log line. If a routine appears to do nothing, the schedule string is the first thing to check.

**Hours without a leading zero never fire.** The pattern is exact. `every day at 9:00` does not match `every day at (\d{2}):(\d{2})`. Always zero-pad.

**Capitalised weekdays never fire.** The schedule string is lowercased before matching, so `every Friday at 04:00` works in practice. But the parser only matches one full lowercased weekday word. `every Fri at 04:00`, `every Mon-Fri at 09:00`, and `every weekday at 18:00` do not match.

**Rundock is closed for a whole day when the schedule comes due.** The scheduler is in-process, so a routine can only fire while Rundock is running. If Rundock is shut at 05:00 but opened later the same day, the morning briefing fires when you open it: that is the catch-up window described above. What is lost is a day Rundock is never opened at all, because the window is the calendar day and it does not carry over. Routines are best suited to cadences you keep Rundock running through; for one that must never miss a slot, schedule it when Rundock is reliably open.

**Routines that need their output read.** Rundock discards the routine's stdout. If the agent does not write its output somewhere durable through tools (file system, Todoist, Notion, etc), the run produces nothing the user can find later. Always design routines so the agent writes a trace.

**Two routines on the same agent fire in the same minute.** Both routines spawn Claude Code subprocesses concurrently. They do not share context, conversation history, or file locks. Stagger the schedules unless the routines are genuinely independent and idempotent.

**A routine takes longer than the next scheduler tick.** Long-running routines (a weekly research digest can run for many minutes) are fine. The scheduler runs every 60 seconds, but the daily and weekly schedule guards prevent the same routine being launched twice in the same window. The next-run calculation only fires once per day or week, regardless of how long the previous run took.

**Routine name changed after first run.** The routine's lastRun guard is keyed on `agentId:name`. Renaming a routine creates a new key, which means the new name has no run history and may fire immediately on the next tick if its schedule has already passed. To rename a routine without an immediate re-fire, do it just after a known successful run rather than just before the next due time.

## Pointers

- [AGENTS.md](AGENTS.md): the agent frontmatter reference, including a brief on the `routines:` array that points back here.
- [ARCHITECTURE.md](../ARCHITECTURE.md): where the scheduler sits in the server's process model and what `.rundock/` does and does not persist.
- The agent files in `.claude/agents/`: the canonical reference for what works in practice.
