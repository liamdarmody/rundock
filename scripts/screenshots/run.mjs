// Orchestrator behind `npm run screenshots`. Runs the whole Phase 1 pipeline:
//   generate sanitized workspace -> sanitization gate -> boot server ->
//   capture stills (both themes, @2x) -> frame (hero chrome + feature
//   self-frame) -> derive per-target sizes -> record motion -> convert to GIFs
//   -> write everything plus MANIFEST.md into the gitignored screenshots-out/
//   review folder at the repo root.
//
// Nothing is written into the README/docs/, Rundock Site, or rundock-docs.
// Liam reviews screenshots-out/ and cherry-picks; wiring the target repos is
// Phase 2.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

import { buildWorkspace, checkSanitization } from './generate-workspace.mjs';
import { startRundock } from './serve.mjs';
import { captureStills, SHOTS } from './capture.mjs';
import { frameImage, FRAME_HTML_URL, resizeTo, toWebp, pngDims } from './frame.mjs';
import { captureMotion, ffmpegAvailable, CLIPS, MOTION_THEMES } from './motion.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO_ROOT, 'screenshots-out');
const GAPS_SRC = path.join(__dirname, 'content-and-copy-gaps.md');

// README-friendly derived width (GitHub's content column is ~1000px, crisp at @2x).
const README_WIDTH = 2200;

// Per-shot destination hints, grounded in the content/copy gap analysis. Each
// entry drives the MANIFEST rows. `hero` placements are added separately.
const TARGETS = {
  'org-chart':        { repo: 'Rundock Site',  path: 'index.html (hero) + images/rundock-app-hero.png',       note: 'Flagship "one operator, whole team" image; replaces the stale April hero.' },
  'agent-profile':    { repo: 'rundock-docs',  path: 'concepts/agents.mdx',                                    note: 'Shows an agent profile with role, skills, and routines.' },
  'skills':           { repo: 'Rundock Site',  path: 'index.html Skills section + rundock-docs/concepts/skills.mdx', note: 'Skills list plus a skill detail; refreshes the April skills-detail.png.' },
  'conversations':    { repo: 'rundock-docs',  path: 'images/conversation-flow.png + introduction.mdx',        note: 'Conversation list plus an open thread; product-in-use hero candidate.' },
  'streaming':        { repo: 'Rundock Site',  path: 'index.html Conversations section',                       note: 'A reply streaming in; supports the live, working-team story.' },
  'files':            { repo: 'Rundock Site',  path: 'index.html Files section + rundock-docs/concepts/files.mdx', note: 'File tree with per-type icons; replaces the materially wrong April file-browser.png.' },
  'markdown-note':    { repo: 'rundock-docs',  path: 'concepts/files.mdx (the editor + properties)',           note: 'Frontmatter properties panel, callouts, and clickable wikilinks.' },
  'callouts':         { repo: 'rundock-docs',  path: 'concepts/files.mdx (callouts)',                          note: 'Nested Obsidian callouts rendered in place.' },
  'kanban-board':     { repo: 'Rundock Site',  path: 'index.html new Boards section + rundock-docs/concepts/files.mdx', note: 'Kanban board with columns and rich cards; new capability, no current imagery.' },
  'artifact-review':  { repo: 'Rundock Site',  path: 'index.html new Review section + rundock-docs/concepts/files.mdx', note: 'Anchored review comments on a rendered artifact; the strongest differentiator.' },
  'image-viewer':     { repo: 'rundock-docs',  path: 'concepts/files.mdx (any file type)',                     note: 'Image viewer for a real decoded image.' },
  'pdf-viewer':       { repo: 'rundock-docs',  path: 'concepts/files.mdx (any file type)',                     note: 'PDF opens inline alongside notes and boards.' },
  'search':           { repo: 'Rundock Site',  path: 'index.html new Search section + rundock-docs/concepts/search.mdx', note: 'Cmd+K universal search; headline 0.10.0 feature, absent everywhere today.' },
  'find':             { repo: 'rundock-docs',  path: 'concepts/search.mdx (Cmd+F)',                            note: 'In-view find inside the editor.' },
  'settings':         { repo: 'rundock-docs',  path: 'concepts/runtimes.mdx',                                  note: 'Settings and runtimes surface.' },
};

// The three chrome-framed hero placements (spec: Site hero, README hero, docs
// intro hero). Each is fed by a hero-designated master.
const HERO_PLACEMENTS = {
  'org-chart':     { repo: 'Rundock Site',  path: 'index.html hero (near full-bleed) + Rundock repo README hero', note: 'The flagship org-chart hero, chrome-framed.' },
  'conversations': { repo: 'rundock-docs',  path: 'introduction.mdx hero',                                        note: 'Product-in-use hero for the docs introduction.' },
  'files':         { repo: 'Rundock',       path: 'README.md secondary / docs/ hero',                             note: 'Spare chrome-framed hero showing the file workspace.' },
};

function rel(p) { return path.relative(OUT, p); }
function mb(bytes) { return (bytes / 1e6).toFixed(2) + ' MB'; }

async function main() {
  const t0 = Date.now();
  const log = (m) => console.log(m);

  // Clean, re-runnable output folder.
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const dirs = {
    hero: path.join(OUT, 'hero'),
    flat: path.join(OUT, 'stills', 'flat'),
    framed: path.join(OUT, 'stills', 'framed'),
    motion: path.join(OUT, 'motion'),
  };
  Object.values(dirs).forEach((d) => fs.mkdirSync(d, { recursive: true }));

  // 1. Generate + sanitize (hard gate).
  log('\n[1/6] Generating sanitized demo workspace...');
  const built = buildWorkspace();
  const gate = checkSanitization(built.workspace);
  if (!gate.ok) {
    console.error('SANITIZATION FAILED. Aborting before any capture:');
    for (const h of gate.hits) console.error(`  ${h.file}: "${h.token}"`);
    process.exit(1);
  }
  log(`      workspace: ${built.workspace}`);
  log('      sanitization gate: PASS');

  // 2. Boot the real server against it.
  log('[2/6] Booting Rundock server...');
  const server = await startRundock({ workspace: built.workspace, home: built.home });
  log(`      ${server.url}`);

  const browser = await chromium.launch();
  const manifest = [];
  const staging = path.join(OUT, '.staging');

  try {
    // 3. Capture flat @2x masters + crops, both themes.
    log('[3/6] Capturing stills (light + dark, @2x)...');
    const shots = await captureStills({ browser, url: server.url, stagingDir: staging, log });

    // 4. Frame + derive per target.
    log('[4/6] Framing (hero chrome + feature self-frame) and deriving sizes...');
    const frameCtx = await browser.newContext({ deviceScaleFactor: 2 });
    const framePage = await frameCtx.newPage();
    await framePage.goto(FRAME_HTML_URL);

    for (const asset of shots) {
      const isTile = asset.kind === 'crop';
      const base = `${asset.name}.${asset.theme}.png`;
      // Crops (-tile) inherit their parent shot's destination.
      const target = TARGETS[asset.name.replace(/-tile$/, '')] || { repo: 'Rundock Site', path: '(to place)', note: asset.feature };

      // Flat clean master (for destinations that CSS-frame their own containers).
      const flatOut = path.join(dirs.flat, base);
      fs.copyFileSync(asset.file, flatOut);
      manifest.push({ file: rel(flatOut), repo: target.repo, path: target.path, feature: asset.feature, theme: asset.theme, variant: isTile ? 'flat crop' : 'flat master', note: `${target.note} Clean @2x master; destination frames it in its own container.` });

      // Self-framed variant (for plain-markdown placements: README, raw docs).
      const framedOut = path.join(dirs.framed, base);
      await frameImage(framePage, { masterPath: asset.file, outPath: framedOut, theme: asset.theme, treatment: 'feature' });
      manifest.push({ file: rel(framedOut), repo: 'Rundock', path: 'README.md / raw markdown', feature: asset.feature, theme: asset.theme, variant: isTile ? 'self-framed crop' : 'self-framed', note: `${asset.feature}: rounded corners + shadow baked in, for plain-markdown placements that cannot CSS-frame.` });

      // README-width derivation of the self-framed variant (feature stills only).
      if (!isTile) {
        const readmeOut = path.join(dirs.framed, `${asset.name}.${asset.theme}.readme.png`);
        resizeTo(framedOut, readmeOut, README_WIDTH);
        manifest.push({ file: rel(readmeOut), repo: 'Rundock', path: 'README.md / docs/', feature: asset.feature, theme: asset.theme, variant: `self-framed ${README_WIDTH}px`, note: `README-ready width (${README_WIDTH}px) derived from the self-framed master.` });
      }

      // Hero chrome for hero-designated masters.
      if (asset.hero && !isTile) {
        const heroOut = path.join(dirs.hero, base);
        await frameImage(framePage, { masterPath: asset.file, outPath: heroOut, theme: asset.theme, treatment: 'hero' });
        const hp = HERO_PLACEMENTS[asset.name] || { repo: 'Rundock Site', path: 'hero', note: 'Chrome-framed hero.' };
        manifest.push({ file: rel(heroOut), repo: hp.repo, path: hp.path, feature: asset.feature, theme: asset.theme, variant: 'hero (window chrome)', note: hp.note });

        const heroReadme = path.join(dirs.hero, `${asset.name}.${asset.theme}.readme.png`);
        resizeTo(heroOut, heroReadme, README_WIDTH);
        manifest.push({ file: rel(heroReadme), repo: 'Rundock', path: 'README.md hero', feature: asset.feature, theme: asset.theme, variant: `hero ${README_WIDTH}px`, note: `README-width hero derived from the chrome-framed master.` });

        // Site hero also gets a WebP where the platform can produce it.
        const webp = toWebp(flatOut, path.join(dirs.flat, `${asset.name}.${asset.theme}.webp`));
        if (webp) manifest.push({ file: rel(webp), repo: 'Rundock Site', path: 'hero (WebP with PNG fallback)', feature: asset.feature, theme: asset.theme, variant: 'webp', note: 'WebP for the site page, PNG master as fallback.' });
      }
    }
    await frameCtx.close();

    // 5. Motion.
    log('[5/6] Recording motion and converting to GIFs...');
    if (ffmpegAvailable()) {
      const clips = await captureMotion({ browser, url: server.url, workspace: built.workspace, outDir: dirs.motion, log });
      for (const c of clips) {
        const target = TARGETS[c.name] || { repo: 'Rundock Site', path: '(to place)', note: c.feature };
        manifest.push({ file: rel(c.file), repo: target.repo, path: target.path, feature: c.feature, theme: c.theme, variant: `gif (${mb(c.bytes)})`, note: `${c.feature}: web-optimized looping GIF.` });
      }
    } else {
      log('      ! ffmpeg not available; skipped motion. Set FFMPEG_PATH or run `npm install`.');
    }

    // 6. Gap analysis + MANIFEST.
    log('[6/6] Writing gap analysis and MANIFEST...');
    if (fs.existsSync(GAPS_SRC)) fs.copyFileSync(GAPS_SRC, path.join(OUT, 'content-and-copy-gaps.md'));
    writeManifest(manifest, { built, gate, webpOk: manifest.some((m) => m.variant === 'webp') });

    // Cleanup staging (flat masters are already copied into stills/flat).
    fs.rmSync(staging, { recursive: true, force: true });

    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    log(`\nDone in ${secs}s. ${manifest.length} assets in ${OUT}`);
    log('Review screenshots-out/ and cherry-pick. Nothing was written to the target repos.');
  } finally {
    await browser.close();
    await server.stop();
  }
}

function writeManifest(rows, { built, gate, webpOk }) {
  const stills = rows.filter((r) => !r.variant.includes('gif'));
  const gifs = rows.filter((r) => r.variant.includes('gif'));
  const table = (list) => [
    '| File | Target repo | Target path | Feature | Theme | Variant | Rationale |',
    '|---|---|---|---|---|---|---|',
    ...list.map((r) => `| \`${r.file}\` | ${r.repo} | ${r.path} | ${r.feature} | ${r.theme} | ${r.variant} | ${r.note} |`),
  ].join('\n');

  const md = [
    '# Screenshot pipeline: review manifest',
    '',
    'Generated by `npm run screenshots` (`scripts/screenshots/`). Every asset below is a candidate; nothing has been written into the README, `docs/`, `Rundock Site`, or `rundock-docs`. Review, then cherry-pick. Wiring the target repos is Phase 2.',
    '',
    '## Standards',
    '',
    '- **Master:** 1440x900 logical at deviceScaleFactor 2, so every flat master is 2880x1800 @2x. Per-target sizes are derived down from the master, never upscaled.',
    '- **Themes:** every still and every GIF captured in both light and dark.',
    '- **Determinism:** fixed data and a frozen clock (2026-07-18, UTC), animations disabled for stills, scrollbars and caret hidden, the connection toast suppressed, web fonts awaited before capture.',
    '- **Framing:** window chrome on the three hero images only; feature shots ship as a flat clean master (for destinations that CSS-frame) plus a self-framed variant (rounded corners + soft shadow + neutral padding, for plain-markdown placements). Neutral, theme-aware gradient.',
    '- **Motion:** palette-optimized looping GIFs, ~1280px wide, 15fps, roughly 5-6s.',
    '',
    '## Folder layout',
    '',
    '- `hero/` the three chrome-framed hero images (full plus a README-width derivation), light and dark.',
    '- `stills/flat/` flat clean @2x masters and element-scoped crops (`-tile`), for the Site and Docs to frame in their own containers.',
    '- `stills/framed/` self-framed variants (and README-width derivations) for plain-markdown placements.',
    '- `motion/` the six looping GIFs, light and dark.',
    '- `content-and-copy-gaps.md` the release content and copy gap analysis (proposal only).',
    '',
    '## Sanitization',
    '',
    `- Banned-token grep over the generated workspace: **${gate.ok ? 'PASS' : 'FAIL'}**. The demo team is invented (only the generic role-names Cos, Dev, Des are kept); no real people, clients, content, or business specifics.`,
    '- A human glance over the assets is still required before anything is published.',
    '',
    '## Notes',
    '',
    `- **WebP:** ${webpOk ? 'produced for hero flats via sips.' : 'this macOS build’s sips cannot write WebP, so WebP derivations were skipped; the PNG masters serve as the source, and the Site can generate WebP at deploy time.'}`,
    '- **PDF viewer:** headless Chromium may render the PDF pane blank; recapture in a headed run if the PDF shot is needed.',
    '- Re-run any time with `npm run screenshots`; the output folder is rebuilt from scratch and is gitignored.',
    '',
    `## Stills (${stills.length})`,
    '',
    table(stills),
    '',
    `## Motion (${gifs.length})`,
    '',
    gifs.length ? table(gifs) : '_No GIFs produced (ffmpeg unavailable)._',
    '',
  ].join('\n');

  fs.writeFileSync(path.join(OUT, 'MANIFEST.md'), md);
}

main().catch((err) => { console.error(err); process.exit(1); });
