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
- **Changelog entries go under `## Unreleased`.** New entries accumulate at the top of `CHANGELOG.md` under a single `## Unreleased` heading. Start the body with a `**Name:** <release name>` line so the release script can promote it to a titled heading at release time. The release script auto-promotes `## Unreleased` to `## X.Y.Z: <Name> (YYYY-MM-DD)` when you run `npm run release -- X.Y.Z`.
- **No new dependencies** without discussion. The two-dependency footprint is deliberate.
- **Vanilla JS only.** No frameworks, no TypeScript. The codebase is readable without tooling.
- **Commit messages:** Start with a verb in imperative mood. Keep the first line under 72 characters. Examples: `fix permission card timeout race condition`, `add workspace mode toggle to settings panel`.
- **UK spelling** in user-facing strings, comments, and documentation.

### Testing your changes

Run the server locally and test against a real workspace with agents. There is no automated test suite yet. Verify that your change works across the team, conversations, skills, and files views as relevant.

## Licence

Rundock is licensed under PolyForm Perimeter 1.0.0. By submitting a pull request, you agree that your contribution will be licensed under the same terms. This licence allows any use except building a competing product. Review [LICENSE](LICENSE) before contributing if you have questions about the terms.
