# Security

## Reporting a vulnerability

Use [GitHub's private security advisory form](https://github.com/liamdarmody/rundock/security/advisories/new) to report a vulnerability in Rundock. Reports go directly to the maintainer with no public exposure during triage.

Please include a description of the issue, steps to reproduce, the Rundock version (visible in the app menu), and the platform (macOS arm64, Intel Mac via source, etc.).

## Response

I aim to acknowledge reports within 72 hours and to fix or scope a fix within two weeks. Disclosure timing is coordinated with the reporter.

## Scope

In scope: Rundock itself. The desktop app, the Node.js server, the WebSocket protocol, the local API surface, and how Rundock reads, writes, and spawns from agent and skill files.

Out of scope: vulnerabilities in third-party tools that Rundock invokes (Claude Code and Anthropic's API, the Codex CLI and OpenAI's API, Node.js, Electron). Report those upstream.

## Accepted dependency advisories

Advisories in shipped (production) dependencies that are knowingly carried, with the reason. Reviewed whenever `npm audit --omit=dev` reports something new. Anything not listed here is expected to be fixed rather than accepted.

### GHSA-5p4m-2wfm-xmqj: quadratic CPU consumption in `js-yaml` `!!omap`

**Status:** accepted, tracked, not fixed.

`js-yaml` 4.3.0 reaches the production tree only through `electron-updater`, which declares `js-yaml: ^4.1.0`. The fix was not backported to the 4.x line and the patched release is 5.x, a major version outside that range, so no in-range fix exists. Forcing 5.x through a dependency override would put `electron-updater` on a transitive major it does not declare support for, on the exact code path that installs updates. That trade is not worth a denial-of-service advisory.

**Why the impact is limited on this path:** `electron-updater` uses `js-yaml` to parse the update manifests (`latest-mac.yml`, `latest.yml`) that Rundock itself publishes to its own GitHub releases. The input is not attacker-controlled in normal operation, and the failure mode is a slow or hung update check rather than code execution.

**Revisit when** `electron-updater` widens its `js-yaml` range or ships a release depending on 5.x. Re-run `npm audit --omit=dev` at that point and remove this entry.

**Note, separate from the above:** the same advisory also applies to a *second*, independent copy of `js-yaml` (4.1.0) vendored inside `public/vendor/tiptap-bundle.mjs`, which parses frontmatter in files the user opens. `npm audit` cannot see that copy because it is pre-built. That exposure is different in kind and is tracked on its own backlog item, not accepted here.
