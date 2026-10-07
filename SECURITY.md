# Security

## Reporting a vulnerability

Use [GitHub's private security advisory form](https://github.com/liamdarmody/rundock/security/advisories/new) to report a vulnerability in Rundock. Reports go directly to the maintainer with no public exposure during triage.

Please include a description of the issue, steps to reproduce, the Rundock version (visible in the app menu), and the platform (macOS arm64, Intel Mac via source, etc.).

## Response

I aim to acknowledge reports within 72 hours and to fix or scope a fix within two weeks. Disclosure timing is coordinated with the reporter.

## Scope

In scope: Rundock itself. The desktop app, the Node.js server, the WebSocket protocol, the local API surface, and how Rundock reads, writes, and spawns from agent and skill files.

Out of scope: vulnerabilities in third-party tools that Rundock invokes (Claude Code and Anthropic's API, the Codex CLI and OpenAI's API, Node.js, Electron). Report those upstream.

## What protects what

Cards guard against ordinary agent behaviour; the sandbox guards against a determined one.

Only Rundock's own window can drive Rundock's local server. The desktop app's window carries a key made in memory at each launch, added to its requests by the app itself and never handed to the page; the desktop app accepts nothing else. Running from source, the link Rundock prints when it starts carries a one-time code, never that key: the code works once and only for fifteen minutes, so a copy left in a browser's history is useless. Rundock prints a link only when it starts, and when you press Enter in the terminal it is running in; nothing a program sends to it makes one appear. The page trades the code for a session token, keeps it in storage that belongs to its own address and port, and sends it with each request; it is never a cookie, because a browser sends a localhost cookie to every program listening on localhost. Pictures and PDFs, which a browser loads without the page's help, use a separate cookie that opens those files inside the workspace and nothing else. Rundock keeps only fingerprints of tokens, each expiring after a year; delete `.browser-sessions.json` beside Rundock to make every browser open the link again. An agent Rundock starts holds a token that lets its permission requests reach you as cards in its own conversation, and nothing else.

A routine runs unattended only where you approved it. Rundock keeps that record in its own folder, outside every workspace. On the Mac in the default mode, agents cannot write there. On Windows, and in Code mode, a program running as you can, so there the record, like the cards, guards against ordinary agent behaviour rather than a determined program.

How strong that is depends on how you run Rundock, because a program running as you can do what your operating system lets it:

| How you run Rundock | Strength | What a determined program running as you could still do |
|---|---|---|
| Mac desktop app | Strong. The key lives only in the app's memory; macOS's hardened runtime blocks debuggers and code injection; debugging switches are off in shipped builds. | Act through macOS accessibility controls, if you have granted them to something it can drive. |
| Windows desktop app | A much higher bar. | Read the key from the app's memory, which Windows allows a program running as you to do. |
| From source, in a browser | A much higher bar. | Read the session token from the browser's own files on disk, where the page's storage is kept unencrypted, or change Rundock's own code, which is yours to edit. Whoever can read the terminal can use the latest link it printed before a browser does. With the Windows launcher, a program watching new processes could read the link from the browser's command line in the moment before the page uses it. |
| From source, on a server you reach through a tunnel | A much higher bar. | As above, and also: a link printed when the service starts stays usable for fifteen minutes or until a browser uses it, and the service's journal keeps it. Any program running as the same user, or as a member of a group allowed to read the journal (on many Linux systems the first user is), can read that link in that time and let itself in. Open the link soon after the service starts, and keep other programs off the server's account. |
| Code mode, any of the above | As above, without the sandbox. | Anything you can do. Code mode trusts the agent more, by design. |

## Accepted dependency advisories

Advisories in shipped (production) dependencies that are knowingly carried, with the reason. Reviewed whenever `npm audit --omit=dev` reports something new. Anything not listed here is expected to be fixed rather than accepted.

### GHSA-5p4m-2wfm-xmqj: quadratic CPU consumption in `js-yaml` `!!omap`

**Status:** accepted, tracked, not fixed.

`js-yaml` 4.3.0 reaches the production tree only through `electron-updater`, which declares `js-yaml: ^4.1.0`. The fix was not backported to the 4.x line and the patched release is 5.x, a major version outside that range, so no in-range fix exists. Forcing 5.x through a dependency override would put `electron-updater` on a transitive major it does not declare support for, on the exact code path that installs updates. That trade is not worth a denial-of-service advisory.

**Why the impact is limited on this path:** `electron-updater` uses `js-yaml` to parse the update manifests (`latest-mac.yml`, `latest.yml`) that Rundock itself publishes to its own GitHub releases. The input is not attacker-controlled in normal operation, and the failure mode is a slow or hung update check rather than code execution.

**Revisit when** `electron-updater` widens its `js-yaml` range or ships a release depending on 5.x. Re-run `npm audit --omit=dev` at that point and remove this entry.

**Note, separate from the above:** the same advisory also applies to a *second*, independent copy of `js-yaml` (4.1.0) vendored inside `public/vendor/tiptap-bundle.mjs`, which parses frontmatter in files the user opens. `npm audit` cannot see that copy because it is pre-built. That exposure is different in kind and is tracked on its own backlog item, not accepted here.
