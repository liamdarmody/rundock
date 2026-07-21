# Marketing screenshot pipeline

Generates marketing-grade visuals of every current Rundock feature: framed
light and dark stills at retina resolution, plus short looping GIFs, all from a
realistic but fully sanitized demo workspace driven through the real app with
Playwright. Everything lands in a single local review folder with a manifest;
nothing is written into the README, `docs/`, the Rundock Site, or the docs site.

Spec: the marketing screenshot pipeline spec, kept in the private workspace (not shipped here).

## Run it

```bash
npm run screenshots
```

Output lands in the gitignored `screenshots-out/` folder at the repo root.
Re-runnable: the folder is rebuilt from scratch each time. Stills are
deterministic (fixed clock, seeded data, animations disabled), so re-running
reproduces them byte for byte. GIFs are re-encoded from fresh Playwright video
capture, so their bytes vary run to run even when the content is identical:
regenerate them intentionally, not as a side effect of a still refresh, and do
not expect a clean git diff to tell you whether a GIF actually changed.

## What it does

1. **Generate** a sanitized demo workspace (invented nine-agent team, ~14 skills,
   conversations, routines, and a rich file tree) plus a fake `$HOME` of Claude
   Code transcripts, all with fixed dates.
2. **Sanitization gate** greps the whole build root, both the demo workspace and
   the fake `$HOME` transcripts (whose text is rendered into the conversation
   shots), for banned tokens, and aborts before any capture if a real name or
   private term slips in. Binary files (images, PDFs) are trusted, not scanned.
   The gate warns if no project-specific token source is configured (see
   Configuration); the built-in defaults only cover the owner's own markers.
3. **Boot** the real `server.js` against that workspace on a dedicated port.
4. **Capture** the full still shot list in light and dark at deviceScaleFactor 2
   (2880x1800 @2x masters), plus element-scoped crops.
5. **Frame** the three hero shots in window chrome and every feature shot as a
   flat clean master plus a self-framed variant, on a neutral theme-aware
   gradient, and derive README-width sizes.
6. **Motion**: record five scripted interactions and convert each to an optimized,
   palette-based looping GIF.
7. Write **`MANIFEST.md`** mapping every asset to its intended target repo, path,
   feature, theme, and rationale, and copy in the content and copy gap analysis.

## Prerequisites

- **Node 22+** and the repo's dependencies (`npm install`).
- **Playwright Chromium**, already installed with the dev dependencies.
- **ffmpeg** for the GIFs. Resolved in order: the `FFMPEG_PATH` env, a system
  `ffmpeg` on `PATH`, then the `ffmpeg-static` dev dependency. If none is found,
  stills are still produced and motion is skipped with a note.
- **sips** (macOS built-in) for resizing and format conversion. On this build it
  cannot write WebP, so WebP derivations are skipped and the PNG masters serve
  as the source.

## Configuration

- `FFMPEG_PATH` overrides which ffmpeg binary is used.
- `RUNDOCK_CAPTURE_PORT` overrides the dedicated capture port (default 34519,
  deliberately distinct from the e2e port 34517).
- `RUNDOCK_BANNED_TOKENS` (comma-separated) and a gitignored
  `scripts/screenshots/.banned-tokens.json` (a JSON array of strings) add
  project-specific tokens to the sanitization gate, so private names never live
  in this public repo.

## Files

- `generate-workspace.mjs` the sanitized demo workspace v2 plus the gate.
- `serve.mjs` boots the real server in an isolated child process.
- `harness.mjs` shared Playwright helpers: fixed clock, themes, seeding.
- `capture.mjs` the still shot list and capture loop.
- `frame.mjs` + `frame.html` the framing wrapper and per-target derivations.
- `motion.mjs` the five clips and ffmpeg conversion.
- `run.mjs` the orchestrator behind `npm run screenshots`.
- `content-and-copy-gaps.md` the release content and copy gap analysis (a
  proposal; copied into the output folder each run).

## Phase 2 (not built yet)

Auto-opening PRs into the Rundock repo README/`docs/`, the Rundock Site, and the
docs site, triggered on release. Queue it once the placements in `MANIFEST.md`
are agreed.
