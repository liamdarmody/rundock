# Security

## Reporting a vulnerability

Use [GitHub's private security advisory form](https://github.com/liamdarmody/rundock/security/advisories/new) to report a vulnerability in Rundock. Reports go directly to the maintainer with no public exposure during triage.

Please include a description of the issue, steps to reproduce, the Rundock version (visible in the app menu), and the platform (macOS arm64, Intel Mac via source, etc.).

## Response

I aim to acknowledge reports within 72 hours and to fix or scope a fix within two weeks. Disclosure timing is coordinated with the reporter.

## Scope

In scope: Rundock itself. The desktop app, the Node.js server, the WebSocket protocol, the local API surface, and how Rundock reads, writes, and spawns from agent and skill files.

Out of scope: vulnerabilities in third-party tools that Rundock invokes (Claude Code, Anthropic's API, Node.js, Electron). Report those upstream.
