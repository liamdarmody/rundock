#!/usr/bin/env node

/**
 * Release script for Rundock (tag-and-let-CI-build model).
 *
 * Bumps the version, promotes the CHANGELOG `## Unreleased` block to a versioned
 * heading, commits, pushes main, and pushes a `v<version>` tag. The GitHub Actions
 * release workflow (.github/workflows/release.yml) then builds, signs, notarises,
 * and publishes a DRAFT GitHub release for that tag. Building no longer happens on
 * your laptop.
 *
 * After this script: watch the Actions run, then review and publish the draft
 * release. Update the Rundock Site download links once the release is published.
 *
 * Usage:
 *   npm run release -- <version>     (e.g. npm run release -- 0.8.14)
 *
 * Recovery: if the CI build fails (e.g. an expired Apple agreement), fix the cause
 * and re-run the workflow on the same tag (gh run rerun, or the Actions UI). There
 * is no need to revert main: the bump + tag stay, and CI publishes once it passes.
 *
 * No Apple/signing credentials are needed locally any more; those live in GitHub
 * Secrets are provided by the CI environment (see the repository CI settings).
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const REPO = 'liamdarmody/rundock';

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

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function getVersion() {
  const version = process.argv[2];
  if (!version) {
    fail('version', 'Usage: npm run release -- <version> (e.g. npm run release -- 0.8.14)');
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    fail('version', `Invalid version "${version}". Expected semver MAJOR.MINOR.PATCH (e.g. 0.8.14).`);
  }
  return version;
}

// Must be on main, fully clean tree, in sync with origin, and the tag must not
// already exist. Runs BEFORE any file is modified so a failed pre-flight leaves
// the working tree untouched.
function preflight(version) {
  let branch;
  try {
    branch = git(['symbolic-ref', '--short', 'HEAD']).trim();
  } catch (err) {
    fail('preflight', `Could not determine current branch: ${err.message}`);
  }
  if (branch !== 'main') {
    fail('preflight', `Must be on main to release (currently on "${branch}").`);
  }

  const status = git(['status', '--porcelain']).trim();
  if (status) {
    fail('preflight', `Working tree is not clean. Commit or stash changes before releasing:\n${status}`);
  }

  try {
    git(['fetch', 'origin', 'main'], { stdio: 'pipe' });
  } catch (err) {
    fail('preflight', `git fetch origin main failed: ${err.message}`);
  }
  const behind = git(['rev-list', '--count', 'HEAD..origin/main']).trim();
  if (parseInt(behind, 10) > 0) {
    fail('preflight', `Local main is ${behind} commit(s) behind origin/main. Pull before releasing.`);
  }

  const tag = `v${version}`;
  if (git(['tag', '-l', tag]).trim()) {
    fail('preflight', `Tag ${tag} already exists locally. Choose a new version or delete the tag.`);
  }
}

function setVersion(version) {
  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  log('version', `Set version to ${version}`);
}

// Extract the title line and body of a specific version from CHANGELOG.md.
function extractChangelogEntry(version) {
  const changelogPath = path.join(ROOT, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) return null;
  const lines = fs.readFileSync(changelogPath, 'utf8').split('\n');
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

// Promote the `## Unreleased` heading to the versioned heading for this release.
// If `## ${version}:` already exists, no-op. If neither exists, abort: we must
// not release without notes. The release name is read from a `**Name:**` line.
function promoteUnreleasedChangelog(version) {
  const changelogPath = path.join(ROOT, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) {
    fail('changelog', `CHANGELOG.md not found at ${changelogPath}`);
  }
  const original = fs.readFileSync(changelogPath, 'utf8');

  const versionHeadingRe = new RegExp(`^## ${version.replace(/\./g, '\\.')}:`, 'm');
  if (versionHeadingRe.test(original)) {
    log('changelog', `Versioned heading for ${version} already present, skipping promotion`);
    return;
  }

  const unreleasedRe = /^## Unreleased[ \t]*$/m;
  if (!unreleasedRe.test(original)) {
    fail(
      'changelog',
      `No "## Unreleased" block and no "## ${version}:" block in CHANGELOG.md. ` +
      `Add release notes under "## Unreleased" before running release.`
    );
  }

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
  let updated = original.replace(unreleasedRe, newHeading);
  updated = updated.replace(/^[ \t]*\*\*Name:\*\*[ \t]*.+?[ \t]*$\n?/m, '');
  updated = updated.replace(/\n{3,}/g, '\n\n');

  fs.writeFileSync(changelogPath, updated, 'utf8');
  log('changelog', `Promoted "## Unreleased" to "${newHeading}"`);
}

function commitTagPush(version) {
  const tag = `v${version}`;
  try {
    git(['add', 'package.json', 'CHANGELOG.md'], { stdio: 'inherit' });
    git(['commit', '-m', `chore: release ${version}`], { stdio: 'inherit' });
    git(['push', 'origin', 'main'], { stdio: 'inherit' });
    git(['tag', tag], { stdio: 'inherit' });
    git(['push', 'origin', tag], { stdio: 'inherit' });
  } catch (err) {
    fail('push', `git commit/tag/push failed: ${err.message}`);
  }
  log('push', `Committed, pushed main, and pushed tag ${tag}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const version = getVersion();
preflight(version);
setVersion(version);
promoteUnreleasedChangelog(version);
commitTagPush(version);

console.log('');
log('done', `Tagged v${version}. GitHub Actions is now building, signing, notarising, and publishing a DRAFT release.`);
log('done', `Watch the build:   https://github.com/${REPO}/actions`);
log('done', `Review + publish:  https://github.com/${REPO}/releases`);
log('done', `Then bump the Rundock Site download links to v${version}.`);
log('done', `If CI fails (e.g. expired Apple agreement): fix it and re-run the workflow on tag v${version}: no need to revert main.`);
