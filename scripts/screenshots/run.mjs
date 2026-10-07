// Orchestrator behind `npm run screenshots`. Runs the whole capture pipeline:
//   generate sanitized workspace -> sanitization gate -> boot server ->
//   capture stills (both themes, @2x) -> frame (hero chrome + feature
//   self-frame) -> derive per-target sizes -> record motion -> convert to GIFs
//   -> write everything plus MANIFEST.md into the gitignored screenshots-out/
//   review folder at the repo root.
//
// Nothing is written into the README/docs/, Rundock Site, or rundock-docs.
// A person reviews screenshots-out/ and cherry-picks; wiring the target repos
// comes later.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

import { buildWorkspace, checkSanitization, hasProjectBannedTokens } from './generate-workspace.mjs';
import { startRundock, CAPTURE_PORT } from './serve.mjs';
import { assertAppContract, BROWSER_ARGS } from './harness.mjs';
import { captureStills, selectedShots, variantsNeeded, THEMES } from './capture.mjs';
import { frameImage, FRAME_HTML_URL, resizeTo, toWebp, socialCard } from './frame.mjs';
import { captureMotion, ffmpegAvailable, selectedClips, MOTION_THEMES } from './motion.mjs';
import { TARGETS, HERO_PLACEMENTS, SOCIAL_CARDS } from './placements.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO_ROOT, 'screenshots-out');

// README-friendly derived width (GitHub's content column is ~1000px, crisp at @2x).
const README_WIDTH = 2200;

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
    social: path.join(OUT, 'social'),
  };
  Object.values(dirs).forEach((d) => fs.mkdirSync(d, { recursive: true }));

  // 1. Generate + sanitize (hard gate). The gate scans the whole build root, so
  // the fake $HOME Claude Code transcripts (whose text is rendered into the
  // conversation shots and the handover clip) are covered too, not just the
  // vault tree. One build per workspace variant the selected shots use (the
  // motion clips all run against the main one), each through the same gate.
  const clipsWanted = selectedClips();
  const variants = variantsNeeded();
  if (clipsWanted.length && !variants.includes('main')) variants.unshift('main');
  log(`\n[1/6] Generating sanitized demo workspaces (${variants.join(', ')})...`);
  if (!hasProjectBannedTokens()) {
    log('      ! no project-specific banned tokens configured (RUNDOCK_BANNED_TOKENS or');
    log('        scripts/screenshots/.banned-tokens.json); gate is on built-in defaults only.');
  }
  const builds = {};
  const gate = { ok: true, hits: [] };
  for (const variant of variants) {
    const built = buildWorkspace({ variant });
    const result = checkSanitization(built.root);
    if (!result.ok) {
      console.error(`SANITIZATION FAILED (${variant}). Aborting before any capture:`);
      for (const h of result.hits) console.error(`  ${h.file}: "${h.token}"`);
      process.exit(1);
    }
    builds[variant] = built;
    log(`      ${variant}: ${built.workspace}`);
  }
  log('      sanitization gate: PASS (every workspace + fake $HOME scanned)');
  const built = builds.main || builds[variants[0]];

  // 2. Boot the real server against each, with git pointed at the local
  // package repositories so the install review and update check need no
  // network.
  log('[2/6] Booting Rundock servers...');
  const servers = {};
  for (const variant of variants) {
    const b = builds[variant];
    // Ports spaced apart, so one server's fallback ports never meet the next's.
    const port = CAPTURE_PORT + variants.indexOf(variant) * 20;
    servers[variant] = await startRundock({ workspace: b.workspace, home: b.home, env: b.serverEnv, port });
    // The bare address only: a sign-in link carries a code and is never logged.
    log(`      ${variant}: ${servers[variant].url}`);
  }
  const server = servers[variants[0]];

  // Prefer system Chrome (bundles PDFium, so the PDF viewer renders); fall back
  // to the bundled Chromium where Chrome is not installed. A browser that will
  // not start must not leave the servers above running with nobody to stop
  // them.
  const stopServers = async () => { for (const s of Object.values(servers)) await s.stop(); };
  let browser, browserChannel = 'chrome (system)';
  try { browser = await chromium.launch({ channel: 'chrome', args: BROWSER_ARGS }); }
  catch {
    try { browser = await chromium.launch({ args: BROWSER_ARGS }); browserChannel = 'chromium (bundled)'; }
    catch (err) { await stopServers(); throw err; }
  }
  log(`      browser: ${browserChannel}`);
  if (browserChannel.startsWith('chromium')) {
    log('      ! system Chrome not found; the pdf-viewer shot may render blank (bundled Chromium lacks PDFium).');
  }
  const manifest = [];
  const staging = path.join(OUT, '.staging');

  try {
    // Preflight: fail fast (naming the missing symbol) if this Rundock build has
    // moved any global, function, or effect executor the clips/shots depend on,
    // rather than quietly capturing broken assets.
    await assertAppContract(browser, server.signInUrl, log);

    // 3. Capture flat @2x masters + crops, in each capture theme. Each shot
    // signs in to its own variant's server.
    log(`[3/6] Capturing stills (${THEMES.join(' + ')}, @2x)...`);
    const shots = await captureStills({ browser, servers, stagingDir: staging, log });

    // A shot that fails is caught and logged inside captureStills so one bad
    // selector cannot lose the whole run. That is right, but on its own it is
    // too quiet: the run still exits 0, and a missing shot shows up only as one
    // `!` line inside a couple of hundred, then as an asset nobody notices is
    // absent. Motion already gates on its expected count; stills did not, so a
    // renamed selector could silently ship a set with the search shots missing.
    const missingShots = [];
    for (const shot of selectedShots()) {
      for (const theme of THEMES) {
        if (!shots.some(p => p.name === shot.name && p.theme === theme && p.kind === 'flat')) {
          missingShots.push(`${shot.name}.${theme}`);
        }
      }
    }
    if (missingShots.length) {
      log(`      ! STILLS INCOMPLETE: expected ${selectedShots().length * THEMES.length} flat masters, got ${shots.filter(p => p.kind === 'flat').length}. Missing: ${missingShots.join(', ')}`);
    }

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

    // Social cards, cut from their master in each theme captured.
    for (const asset of shots.filter((a) => a.name === SOCIAL_CARDS.from && a.kind === 'flat')) {
      for (const file of SOCIAL_CARDS.files) {
        const out = path.join(dirs.social, file.replace(/\.png$/, `.${asset.theme}.png`));
        await socialCard(browser, { masterPath: asset.file, outPath: out });
        manifest.push({ file: rel(out), repo: 'Rundock Site', path: file, feature: asset.feature, theme: asset.theme, variant: 'social card 1200x630', note: SOCIAL_CARDS.note });
      }
    }

    // 5. Motion.
    log('[5/6] Recording motion and converting to GIFs...');
    if (ffmpegAvailable()) {
      const clips = await captureMotion({ browser, url: servers.main.signInUrl, workspace: builds.main.workspace, outDir: dirs.motion, log });
      // A clip that throws is logged and omitted rather than failing the run, so
      // assert the full set landed; a short count means a clip broke (e.g. an
      // app rename slipped past the contract) and needs a look before publishing.
      const expectedGifs = clipsWanted.length * MOTION_THEMES.length;
      if (clips.length < expectedGifs) {
        const got = new Set(clips.map((c) => `${c.name}.${c.theme}`));
        const missing = [];
        for (const cl of clipsWanted) for (const th of MOTION_THEMES) if (!got.has(`${cl.name}.${th}`)) missing.push(`${cl.name}.${th}`);
        log(`      ! MOTION INCOMPLETE: expected ${expectedGifs} GIFs, got ${clips.length}. Missing: ${missing.join(', ')}`);
      }
      for (const c of clips) {
        const target = TARGETS[c.name] || { repo: 'Rundock Site', path: '(to place)', note: c.feature };
        manifest.push({ file: rel(c.file), repo: target.repo, path: target.path, feature: c.feature, theme: c.theme, variant: `gif (${mb(c.bytes)})`, note: `${c.feature}: web-optimized looping GIF.` });
      }
    } else {
      log('      ! ffmpeg not available; skipped motion. Set FFMPEG_PATH or run `npm install`.');
    }

    // 6. Gap analysis + MANIFEST.
    log('[6/6] Writing MANIFEST...');
    // The content and copy gap analysis is deliberately NOT copied here.
    // It was written against a specific release and reasons throughout from
    // that feature set, so copying it beside freshly generated assets made it
    // read as current when it was several releases behind. It stays in
    // scripts/screenshots/ as a dated record; regenerate it against the
    // current release before relying on it again.
    writeManifest(manifest, { built, gate, webpOk: manifest.some((m) => m.variant === 'webp') });

    // Cleanup staging (flat masters are already copied into stills/flat).
    fs.rmSync(staging, { recursive: true, force: true });

    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    log(`\nDone in ${secs}s. ${manifest.length} assets in ${OUT}`);
    log('Review screenshots-out/ and cherry-pick. Nothing was written to the target repos.');
  } finally {
    await browser.close();
    await stopServers();
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
    'Generated by `npm run screenshots` (`scripts/screenshots/`). Every asset below is a candidate; nothing has been written into the README, `docs/`, `Rundock Site`, or `rundock-docs`. Review, then cherry-pick. Wiring the target repos comes later.',
    '',
    '## Standards',
    '',
    '- **Master:** 1440x900 logical at deviceScaleFactor 2, so every flat master is 2880x1800 @2x. Per-target sizes are derived down from the master, never upscaled.',
    `- **Themes:** captured in ${THEMES.join(' and ')} (RUNDOCK_CAPTURE_THEMES; dark only unless set).`,
    '- **Names:** a shot from the current shot list is named by its id (IMG-01 to IMG-18); the other names are recaptures of existing scenes. See `scripts/screenshots/placements.mjs`.',
    '- **Determinism:** fixed data and a frozen clock (2026-07-18, UTC), animations disabled for stills, scrollbars and caret hidden, the connection toast suppressed, web fonts awaited before capture.',
    '- **Framing:** transparent-background PNGs, so one framed image drops onto any page background (light or dark). The macOS window controls are drawn into the app\'s own top bar during capture, so every shot that includes that bar carries them and element-scoped crops do not. Hero images take wider padding; feature shots ship as a flat clean master (for destinations that CSS-frame) plus a self-framed variant (rounded corners, soft drop shadow, and a neutral hairline ring that holds the edge on dark backgrounds). Tight padding.',
    '- **Motion:** palette-optimized looping GIFs, ~1280px wide, 15fps. Length follows what the interaction needs to read clearly rather than a fixed target: a single gesture (a drag, a search) is a quick 4-6s loop; a multi-step flow (the routine editor\'s 3 screens) is paced for reading and runs longer, currently up to ~10s.',
    '',
    '## Folder layout',
    '',
    '- `hero/` the chrome-framed hero images (full plus a README-width derivation).',
    '- `stills/flat/` flat clean @2x masters and element-scoped crops (`-tile`), for the Site and Docs to frame in their own containers.',
    '- `stills/framed/` self-framed variants (and README-width derivations) for plain-markdown placements.',
    `- \`motion/\` the looping GIFs (${MOTION_THEMES.join(' and ')}).`,
    '- `social/` 1200x630 social cards cropped from the IMG-01 master.',
    '- The content and copy gap analysis is not included: it was written against an earlier release and would read as current. See `scripts/screenshots/content-and-copy-gaps.md`, and check its stated release before relying on it.',
    '',
    '## Sanitization',
    '',
    `- Banned-token grep over the generated workspace: **${gate.ok ? 'PASS' : 'FAIL'}**. The demo team is invented (only the generic role-names Cos, Dev, Des are kept); no real people, clients, content, or business specifics.`,
    '- A human glance over the assets is still required before anything is published.',
    '',
    '## Notes',
    '',
    `- **WebP:** ${webpOk ? 'produced for hero flats via sips.' : 'this macOS build’s sips cannot write WebP, so WebP derivations were skipped; the PNG masters serve as the source, and the Site can generate WebP at deploy time.'}`,
    '- **Rendering:** captured through system Chrome (bundles PDFium) so the PDF viewer renders; falls back to bundled Chromium where Chrome is absent (the PDF pane may then be blank).',
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
