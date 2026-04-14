#!/usr/bin/env node

/**
 * Release script for Rundock.
 *
 * Chains the full release pipeline:
 *   1. Build the .app, .dmg, and .zip via electron-builder
 *   2. Submit for Apple notarisation via xcrun notarytool
 *   3. Poll for notarisation completion (every 30s)
 *   4. Staple the notarisation ticket
 *   5. Publish all feed artifacts to a GitHub Release so electron-updater
 *      can auto-update existing installs
 *   6. Bump the download buttons in the Rundock Site repo to the new DMG
 *      and push (skipped if the site repo is dirty or not on main)
 *
 * Usage:
 *   node scripts/release.js <version>
 *   npm run release -- <version>
 *
 * Example:
 *   npm run release -- 0.8.1
 *
 * Requires .env with: APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER,
 * CSC_LINK, CSC_KEY_PASSWORD, APPLE_TEAM_ID.
 *
 * Requires gh CLI authenticated against the target repo.
 */

const { execFileSync, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const APP_PATH = '/tmp/rundock-dist/mac-arm64/Rundock.app';
const DIST_DIR = '/tmp/rundock-dist';
const POLL_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(step, msg) {
  console.log(`[release:${step}] ${msg}`);
}

function fail(step, msg) {
  console.error(`[release:${step}] ERROR: ${msg}`);
  process.exit(1);
}

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
    log('env', 'Loaded .env');
  } else {
    fail('env', 'No .env file found. Cannot sign or notarise without credentials.');
  }

  const required = [
    'APPLE_API_KEY',
    'APPLE_API_KEY_ID',
    'APPLE_API_ISSUER',
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
    'APPLE_TEAM_ID',
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    fail('env', `Missing required env vars: ${missing.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function setVersion() {
  const version = process.argv[2];

  if (!version) {
    fail('version', 'Usage: npm run release -- <version> (e.g. npm run release -- 0.8.1)');
  }

  const semverRe = /^\d+\.\d+\.\d+$/;
  if (!semverRe.test(version)) {
    fail('version', `Invalid version "${version}". Expected semver format: MAJOR.MINOR.PATCH (e.g. 0.8.1)`);
  }

  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  log('version', `Releasing version ${version}`);
}

function build() {
  log('build', 'Running electron-builder --mac');
  try {
    execFileSync(
      path.join(ROOT, 'node_modules', '.bin', 'electron-builder'),
      ['--mac', '--publish', 'never'],
      { stdio: 'inherit', cwd: ROOT }
    );
  } catch (err) {
    fail('build', `electron-builder exited with code ${err.status || 1}`);
  }

  if (!fs.existsSync(APP_PATH)) {
    fail('build', `Expected .app not found at ${APP_PATH}`);
  }
  log('build', `Built ${APP_PATH}`);
}

function submitNotarisation() {
  log('notarise', 'Submitting for Apple notarisation...');

  // Zip the .app for submission
  const zipPath = '/tmp/rundock-dist/Rundock-notarize.zip';
  try {
    execSync(
      `ditto -c -k --keepParent "${APP_PATH}" "${zipPath}"`,
      { stdio: 'inherit' }
    );
  } catch (err) {
    fail('notarise', 'Failed to zip .app for notarisation');
  }

  let output;
  try {
    output = execFileSync('xcrun', [
      'notarytool', 'submit', zipPath,
      '--key', process.env.APPLE_API_KEY,
      '--key-id', process.env.APPLE_API_KEY_ID,
      '--issuer', process.env.APPLE_API_ISSUER,
      '--output-format', 'json',
    ], { cwd: ROOT, encoding: 'utf8' });
  } catch (err) {
    fail('notarise', `notarytool submit failed: ${err.stderr || err.message}`);
  }

  let result;
  try {
    result = JSON.parse(output);
  } catch (err) {
    fail('notarise', `Could not parse notarytool output: ${output}`);
  }

  const submissionId = result.id;
  if (!submissionId) {
    fail('notarise', `No submission ID in response: ${output}`);
  }

  log('notarise', `Submission ID: ${submissionId}`);

  // Clean up the zip
  try { fs.unlinkSync(zipPath); } catch (_) {}

  return submissionId;
}

function pollNotarisation(submissionId) {
  log('notarise', 'Polling for notarisation result...');

  while (true) {
    let output;
    try {
      output = execFileSync('xcrun', [
        'notarytool', 'info', submissionId,
        '--key', process.env.APPLE_API_KEY,
        '--key-id', process.env.APPLE_API_KEY_ID,
        '--issuer', process.env.APPLE_API_ISSUER,
        '--output-format', 'json',
      ], { cwd: ROOT, encoding: 'utf8' });
    } catch (err) {
      fail('notarise', `notarytool info failed: ${err.stderr || err.message}`);
    }

    let result;
    try {
      result = JSON.parse(output);
    } catch (err) {
      fail('notarise', `Could not parse notarytool info output: ${output}`);
    }

    const status = result.status;
    log('notarise', `Status: ${status}`);

    if (status === 'Accepted') {
      log('notarise', 'Notarisation accepted');
      return;
    }

    if (status === 'Invalid' || status === 'Rejected') {
      fail('notarise', `Notarisation ${status}. Check Apple's log for details.`);
    }

    // Still in progress, wait and retry
    log('notarise', `Waiting ${POLL_INTERVAL_MS / 1000}s before next check...`);
    execFileSync('sleep', [String(POLL_INTERVAL_MS / 1000)]);
  }
}

function staple() {
  log('staple', `Stapling notarisation ticket to ${APP_PATH}`);
  try {
    execSync(`xcrun stapler staple "${APP_PATH}"`, { stdio: 'inherit' });
  } catch (err) {
    fail('staple', 'xcrun stapler staple failed');
  }
  log('staple', 'Stapled successfully');
}

// Extract the title line and body of a specific version from CHANGELOG.md.
// Returns { title, body } or null if not found. `title` is the heading text
// without the leading "## ". `body` is everything between this heading and
// the next "## " (or end of file), with trailing "---" separators stripped.
function extractChangelogEntry(version) {
  const changelogPath = path.join(ROOT, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) return null;
  const lines = fs.readFileSync(changelogPath, 'utf8').split('\n');
  // Accept either a versioned heading ("## 1.2.3:") or the literal
  // "## Unreleased" heading used in-flight before a release is cut.
  const matchesHeading = (line) => {
    if (version === 'Unreleased') return /^## Unreleased\s*$/.test(line);
    return line.startsWith(`## ${version}:`);
  };
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (matchesHeading(lines[i])) { start = i; break; }
  }
  if (start === -1) return null;
  const title = lines[start].replace(/^## /, '').trim();
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { end = i; break; }
  }
  const body = lines.slice(start + 1, end).join('\n')
    .replace(/^---\s*$/gm, '')
    .trim();
  return { title, body };
}

// Promote the `## Unreleased` changelog heading to the versioned heading
// for the current release. If `## ${version}:` already exists, no-op. If
// neither exists, abort: we must not publish a release without notes.
//
// The release name is read from a `**Name:** <name>` line at the top of
// the Unreleased body (see CONTRIBUTING.md). If missing, logs a warning
// and falls back to "Release" so the release still ships.
function promoteUnreleasedChangelog(version) {
  const changelogPath = path.join(ROOT, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) {
    fail('changelog', `CHANGELOG.md not found at ${changelogPath}`);
  }
  const original = fs.readFileSync(changelogPath, 'utf8');

  // If a versioned heading for this release already exists, nothing to do.
  const versionHeadingRe = new RegExp(
    `^## ${version.replace(/\./g, '\\.')}:`,
    'm'
  );
  if (versionHeadingRe.test(original)) {
    log('changelog', `Versioned heading for ${version} already present, skipping promotion`);
    return;
  }

  // Otherwise we need an Unreleased heading to promote.
  const unreleasedRe = /^## Unreleased\s*$/m;
  if (!unreleasedRe.test(original)) {
    fail(
      'changelog',
      `No "## Unreleased" block and no "## ${version}:" block in CHANGELOG.md. ` +
      `Add release notes under "## Unreleased" before running release.`
    );
  }

  // Read the Unreleased body to extract the release name.
  const entry = extractChangelogEntry('Unreleased');
  const nameMatch = entry && entry.body.match(/^\s*\*\*Name:\*\*\s*(.+?)\s*$/m);
  let name;
  if (nameMatch) {
    name = nameMatch[1];
  } else {
    log('changelog', 'WARNING: No "**Name:**" line in Unreleased body, falling back to "Release"');
    name = 'Release';
  }

  const today = new Date().toISOString().slice(0, 10);
  const newHeading = `## ${version}: ${name} (${today})`;
  // Also strip the **Name:** line from the body now that it's been
  // lifted into the heading, so it doesn't show up twice in release notes.
  let updated = original.replace(unreleasedRe, newHeading);
  updated = updated.replace(/^\s*\*\*Name:\*\*\s*.+?\s*$\n?/m, '');

  fs.writeFileSync(changelogPath, updated, 'utf8');
  log('changelog', `Promoted "## Unreleased" to "${newHeading}"`);
}

function publishRelease(version) {
  const tag = `v${version}`;
  const dmg = path.join(DIST_DIR, `Rundock-${version}-arm64.dmg`);
  const dmgBlockmap = `${dmg}.blockmap`;
  const zip = path.join(DIST_DIR, `Rundock-${version}-arm64-mac.zip`);
  const zipBlockmap = `${zip}.blockmap`;
  const feed = path.join(DIST_DIR, 'latest-mac.yml');
  const assets = [dmg, dmgBlockmap, zip, zipBlockmap, feed];

  for (const a of assets) {
    if (!fs.existsSync(a)) fail('publish', `Missing release artifact: ${a}`);
  }

  // Determine whether the release already exists.
  let exists = false;
  try {
    execFileSync('gh', ['release', 'view', tag], { stdio: 'pipe' });
    exists = true;
  } catch (_) {
    exists = false;
  }

  if (exists) {
    log('publish', `Release ${tag} already exists, uploading assets (clobbering)`);
    try {
      execFileSync('gh', ['release', 'upload', tag, ...assets, '--clobber'], {
        stdio: 'inherit',
      });
    } catch (err) {
      fail('publish', `gh release upload failed: ${err.message}`);
    }
    log('publish', `Assets uploaded to ${tag}`);
    return;
  }

  log('publish', `Creating GitHub release ${tag}`);
  const entry = extractChangelogEntry(version);
  const title = entry ? entry.title : `Rundock ${version}`;
  const notes = entry && entry.body
    ? entry.body
    : `Rundock ${version}. See CHANGELOG.md for details.`;

  try {
    execFileSync(
      'gh',
      ['release', 'create', tag, ...assets, '--title', title, '--notes', notes],
      { stdio: 'inherit' }
    );
  } catch (err) {
    fail('publish', `gh release create failed: ${err.message}`);
  }
  log('publish', `Release ${tag} created with ${assets.length} assets`);
}

// Update the Rundock Site repo's download buttons to point at the new DMG,
// then commit and push. Skips (with a warning) if the site repo is not on
// main, has uncommitted changes, or is missing entirely — a failure here
// should never block a release that has already been published.
function updateSiteDownloadUrls(version) {
  const sitePath = process.env.RUNDOCK_SITE_PATH
    || path.resolve(ROOT, '..', 'Rundock Site');

  if (!fs.existsSync(sitePath)) {
    log('site', `Site repo not found at ${sitePath}; skipping`);
    return;
  }

  const indexPath = path.join(sitePath, 'index.html');
  if (!fs.existsSync(indexPath)) {
    log('site', `index.html not found in ${sitePath}; skipping`);
    return;
  }

  let branch, status;
  try {
    branch = execFileSync('git', ['-C', sitePath, 'symbolic-ref', '--short', 'HEAD'],
      { encoding: 'utf8' }).trim();
    status = execFileSync('git', ['-C', sitePath, 'status', '--porcelain'],
      { encoding: 'utf8' });
  } catch (err) {
    log('site', `Failed to read site repo git state: ${err.message}; skipping`);
    return;
  }

  if (branch !== 'main') {
    log('site', `Site repo is on branch "${branch}", not main; skipping`);
    return;
  }
  if (status.trim()) {
    log('site', 'Site repo has uncommitted changes; skipping to avoid clobbering');
    return;
  }

  const content = fs.readFileSync(indexPath, 'utf8');
  const pattern = /releases\/download\/v\d+\.\d+\.\d+\/Rundock-\d+\.\d+\.\d+-arm64\.dmg/g;
  const replacement = `releases/download/v${version}/Rundock-${version}-arm64.dmg`;
  const updated = content.replace(pattern, replacement);

  if (updated === content) {
    log('site', 'No download URL changes needed');
    return;
  }

  fs.writeFileSync(indexPath, updated, 'utf8');
  log('site', `Updated download URLs in index.html to v${version}`);

  const commitMessage = `chore: bump download buttons to v${version}\n\n` +
    `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>\n`;

  try {
    execFileSync('git', ['-C', sitePath, 'add', 'index.html'], { stdio: 'inherit' });
    execFileSync('git', ['-C', sitePath, 'commit', '-m', commitMessage], { stdio: 'inherit' });
    execFileSync('git', ['-C', sitePath, 'push', 'origin', 'main'], { stdio: 'inherit' });
    log('site', `Pushed site update for v${version}`);
  } catch (err) {
    log('site', `Git operation failed: ${err.message}`);
    log('site', 'Site repo changes left in working tree; review and push manually');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

setVersion();
loadEnv();
promoteUnreleasedChangelog(process.argv[2]);
build();
const submissionId = submitNotarisation();
pollNotarisation(submissionId);
staple();

const version = process.argv[2];
publishRelease(version);
updateSiteDownloadUrls(version);

const dmgPath = path.join(DIST_DIR, `Rundock-${version}-arm64.dmg`);

console.log('');
log('done', `Release complete: ${dmgPath}`);
