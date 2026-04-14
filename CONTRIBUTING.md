# Contributing to Rundock

Rundock is early stage. Contributions are welcome, but please read this guide before opening a PR.

## Setting up the dev environment

**Requirements:**

- Node.js 20+
- Claude Code installed and signed in (`claude --version` to verify)
- Git

**Setup:**

```bash
git clone https://github.com/liamdarmody/rundock.git
cd rundock
npm install
npm start
```

This starts the server at `http://localhost:3000`. There is no build step. Changes to source files take effect on the next server restart (or page reload for frontend changes).

## Code structure

Rundock is intentionally simple. Three source files, two dependencies, no bundler.

| File | Purpose |
|---|---|
| `server.js` | Node.js HTTP + WebSocket server. Agent/skill discovery, Claude Code process management, delegation, transcripts, permissions. |
| `public/app.js` | Single-page client application. Streaming, delegation UI, permission cards, conversation management. |
| `public/index.html` | Layout, styles, and markup. Nav rail, sidebar, main panel. |

**Dependencies:** `ws` (WebSocket library) and `marked` (markdown renderer). That's it.

## Reporting issues

Use the [issue templates](https://github.com/liamdarmody/rundock/issues/new/choose) on GitHub. Include steps to reproduce, expected behaviour, and actual behaviour. Screenshots help.

## Pull requests

Before opening a PR:

1. Check existing issues and PRs to avoid duplicating work.
2. For non-trivial changes, open an issue first to discuss the approach.
3. Keep PRs focused. One logical change per PR.

### Conventions

- **No build step.** Rundock ships plain JS. No transpilation, no bundling, no minification. Keep it that way.
- **Changelog entries go under `## Unreleased`.** New entries accumulate at the top of `CHANGELOG.md` under a single `## Unreleased` heading. Start the body with a `**Name:** <release name>` line so the release script can promote it to a titled heading at release time. The release script auto-promotes `## Unreleased` to `## X.Y.Z: <Name> (YYYY-MM-DD)` when you run `npm run release -- X.Y.Z`. Entries follow the structure and voice rules in [Changelog entry standards](#changelog-entry-standards) below.
- **No new dependencies** without discussion. The two-dependency footprint is deliberate.
- **Vanilla JS only.** No frameworks, no TypeScript. The codebase is readable without tooling.
- **Commit messages:** Start with a verb in imperative mood. Keep the first line under 72 characters. Examples: `fix permission card timeout race condition`, `add workspace mode toggle to settings panel`.
- **UK spelling** in user-facing strings, comments, and documentation.

### Changelog entry standards

Every entry in `CHANGELOG.md` should follow the same shape so release notes read consistently from version to version. The mechanics of the `## Unreleased` heading are covered in Conventions above; this section covers the content.

- **Opening paragraph.** 1-3 sentences describing what the user now experiences, written from the user's point of view rather than from the implementer's. Lead with the behaviour change, not with what was built.
- **Sections.** Use `### Added`, `### Changed`, and `### Fixed` in that order (per Keep a Changelog). Omit any section with no entries.
- **Bullets.** Each bullet starts with a short title in bold followed by a colon: `- **Short user-visible behaviour title:** body`. The title is a behaviour statement, not an internal component name.
- **Bullet body.** Use before-and-after framing where relevant ("was X, is now Y"). Be concrete and specific. Technical detail is welcome when it clarifies what actually changed, but it should support the behaviour description, not replace it.
- **Voice.** Plain UK English, user-facing. No marketing language. Refer to agents by their type or role (orchestrator, specialist, platform agent) rather than by workspace-specific names that would only be meaningful in the author's own workspace.

### Testing your changes

Run the server locally and test against a real workspace with agents. There is no automated test suite yet. Verify that your change works across the team, conversations, skills, and files views as relevant.

## Licence

Rundock is licensed under PolyForm Perimeter 1.0.0. By submitting a pull request, you agree that your contribution will be licensed under the same terms. This licence allows any use except building a competing product. Review [LICENSE](LICENSE) before contributing if you have questions about the terms.
