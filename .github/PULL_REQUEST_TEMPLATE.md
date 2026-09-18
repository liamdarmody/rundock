## Description

A clear description of what this PR does.

## Why

The motivation for the change. Link the issue if there is one.

## Testing

How you tested this. Include the manual steps you took to verify the change works.

For anything a person can see, say what was driven in a browser and what was on
the screen. The e2e suite runs against a stubbed agent, so it cannot see
permission cards, agent replies, or the first screen: those are only ever
proven live. See `docs/browser-pass.md`.

## Checklist

- [ ] Code changes are scoped to one logical concern
- [ ] CHANGELOG.md updated under `## Unreleased` if user-visible
- [ ] No accidental edits to `.env`, secrets, or build output
- [ ] User-visible change driven in a browser (`npm run look`), or not user-visible
