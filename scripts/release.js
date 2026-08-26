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

const { GATE_FILE_NAME, readGateRecord } = require('./release-gate.js');

const ROOT = path.join(__dirname, '..');
const REPO = 'liamdarmody/rundock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function logStep(step, msg) {
  console.log(`[release:${step}] ${msg}`);
}

function fail(step, msg) {
  console.error(`[release:${step}] ERROR: ${msg}`);
  process.exit(1);
}

// A git runner bound to one repository. Every step takes its runner as an
// option so the release flow can be exercised end to end against a throwaway
// repository in a temp directory rather than against this checkout.
function gitIn(root) {
  return (args, opts = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', ...opts });
}

const git = gitIn(ROOT);

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
// the working tree untouched. Throws so it is unit-testable; the main flow
// converts to fail().
function preflight(version, { root = ROOT, git = gitIn(root) } = {}) {
  let branch;
  try {
    branch = git(['symbolic-ref', '--short', 'HEAD']).trim();
  } catch (err) {
    throw new Error(`Could not determine current branch: ${err.message}`);
  }
  if (branch !== 'main') {
    throw new Error(`Must be on main to release (currently on "${branch}").`);
  }

  const status = git(['status', '--porcelain']).trim();
  if (status) {
    throw new Error(`Working tree is not clean. Commit or stash changes before releasing:\n${status}`);
  }

  try {
    git(['fetch', 'origin', 'main'], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`git fetch origin main failed: ${err.message}`);
  }
  const behind = git(['rev-list', '--count', 'HEAD..origin/main']).trim();
  if (parseInt(behind, 10) > 0) {
    throw new Error(`Local main is ${behind} commit(s) behind origin/main. Pull before releasing.`);
  }

  const tag = `v${version}`;
  if (git(['tag', '-l', tag]).trim()) {
    throw new Error(`Tag ${tag} already exists locally. Choose a new version or delete the tag.`);
  }
}

// The tag refuses to move without a gate pass on the exact current SHA.
// The gate record (`.release-gate.json`) is written only by a fully green
// `npm run release:gate` on a clean tree; a record for any other SHA, or one
// gated without live smoke, is refused. Throws so it is unit-testable; the
// main flow converts to fail().
function requireGatePass(headSha, { root = ROOT } = {}) {
  const record = readGateRecord(root);
  if (!record || !record.sha) {
    throw new Error(
      `No release gate pass found (${GATE_FILE_NAME} missing or unreadable). ` +
      `Run "npm run release:gate" on this candidate first; the tag refuses to move without it.`
    );
  }
  if (record.sha !== headSha) {
    throw new Error(
      `The release gate passed on ${record.sha} but HEAD is ${headSha}. ` +
      `Every commit invalidates the gate. Re-run "npm run release:gate" on the current candidate.`
    );
  }
  if (!record.live) {
    throw new Error(
      `The gate on ${record.sha} ran without live smoke (--no-live). ` +
      `Releases require the full gauntlet: re-run "npm run release:gate" without flags.`
    );
  }
}

// ---------------------------------------------------------------------------
// Publish subcommand
// ---------------------------------------------------------------------------

// Default GitHub API transport via the gh CLI. `api(method, path, body)`.
// The gh argument list for one API call. Split out from ghApi so the encoding
// can be tested without a network call: the bug this exists to prevent was in
// the encoding, and the publish tests inject a fake transport, so nothing ever
// exercised the real arguments.
function ghApiArgs(method, apiPath, body) {
  const args = ['api', '-X', method, apiPath];
  if (body) {
    for (const [key, value] of Object.entries(body)) {
      // Strings go through -f, everything else through -F.
      //
      // -F preserves JSON types, which is what booleans need: draft=false has
      // to arrive as a boolean, not as the word "false". But -F with a
      // JSON.stringify'd STRING sends the quote marks as part of the value, so
      // tag_name arrived as "v0.11.7" WITH quotes and the tag binding silently
      // became garbage. Caught publishing 0.11.7 by the verification below,
      // which is the only reason it did not ship that way.
      if (typeof value === 'string') args.push('-f', `${key}=${value}`);
      else args.push('-F', `${key}=${JSON.stringify(value)}`);
    }
  }
  return args;
}

function ghApi(method, apiPath, body) {
  const out = execFileSync('gh', ghApiArgs(method, apiPath, body), { cwd: ROOT, encoding: 'utf8' });
  return out ? JSON.parse(out) : {};
}

// Publish the draft release for `version`, binding the tag BEFORE flipping
// the draft flag. The 0.11.6 lesson mechanised: after a recut deletes a tag,
// the draft's tag_name falls back to `untagged-*`, and publishing in that
// state binds the release to the junk tag permanently. Order is the fix:
// PATCH tag_name, VERIFY it stuck, only then PATCH draft=false.
function publishRelease(version, { api = ghApi, log = (msg) => console.log(`[release:publish] ${msg}`) } = {}) {
  const tag = `v${version}`;
  const releases = api('GET', `repos/${REPO}/releases`);
  const draft = (releases || []).find(r => r.draft && (
    r.tag_name === tag || (r.name && r.name.startsWith(`${version}:`))
  ));
  if (!draft) {
    throw new Error(
      `No draft release found for ${version} (looked for tag_name ${tag} or a name starting "${version}:"). ` +
      `Has the CI build finished and produced its draft?`
    );
  }

  log(`Found draft ${draft.id} "${draft.name}" (tag_name currently "${draft.tag_name}")`);
  const bound = api('PATCH', `repos/${REPO}/releases/${draft.id}`, { tag_name: tag });
  if (!bound || bound.tag_name !== tag) {
    throw new Error(
      `Binding the tag failed: asked for tag_name ${tag}, release reports "${bound && bound.tag_name}". ` +
      `Draft left untouched (still a draft); nothing was published.`
    );
  }
  log(`Tag bound: ${tag}`);

  const published = api('PATCH', `repos/${REPO}/releases/${draft.id}`, { draft: false });
  log(`Published: ${published.html_url || `release ${draft.id}`}`);
  return { id: draft.id, tag, url: published.html_url };
}

function setVersion(version, { root = ROOT, log = logStep } = {}) {
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  log('version', `Set version to ${version}`);
}

// Extract the title line and body of a specific version from CHANGELOG.md.
// Pass `changelogText` to parse supplied content (used by tests and by
// scripts/release-notes.js); omit it to read the repository's CHANGELOG.md.
function extractChangelogEntry(version, changelogText) {
  let text = changelogText;
  if (typeof text !== 'string') {
    const changelogPath = path.join(ROOT, 'CHANGELOG.md');
    if (!fs.existsSync(changelogPath)) return null;
    text = fs.readFileSync(changelogPath, 'utf8');
  }
  const lines = text.split('\n');
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
// Returns the versioned heading it wrote, or the one already present, so the
// caller can quote it without re-parsing the file. Throws so it is
// unit-testable; the main flow converts to fail().
function promoteUnreleasedChangelog(version, { root = ROOT, log = logStep } = {}) {
  const changelogPath = path.join(root, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) {
    throw new Error(`CHANGELOG.md not found at ${changelogPath}`);
  }
  const original = fs.readFileSync(changelogPath, 'utf8');

  const versionHeadingRe = new RegExp(`^## ${version.replace(/\./g, '\\.')}:.*$`, 'm');
  const alreadyPromoted = original.match(versionHeadingRe);
  if (alreadyPromoted) {
    log('changelog', `Versioned heading for ${version} already present, skipping promotion`);
    return alreadyPromoted[0];
  }

  const unreleasedRe = /^## Unreleased[ \t]*$/m;
  if (!unreleasedRe.test(original)) {
    throw new Error(
      `No "## Unreleased" block and no "## ${version}:" block in CHANGELOG.md. ` +
      `Add release notes under "## Unreleased" before running release.`
    );
  }

  // Parse the block we already have in memory rather than re-reading the file,
  // which is what makes this work against any root, not only this checkout.
  const entry = extractChangelogEntry('Unreleased', original);
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
  return newHeading;
}

// ---------------------------------------------------------------------------
// Prepare subcommand
// ---------------------------------------------------------------------------

// Default transport for `gh` invocations that are not API calls. Injected as an
// option so the prepare flow can be exercised without reaching GitHub, which is
// the same arrangement publishRelease uses for its API transport.
function ghCli(root = ROOT) {
  return (args) => execFileSync('gh', args, { cwd: root, encoding: 'utf8' });
}

// Short, factual, and held to the same writing rules as anything committed:
// this text is published under the project's name.
function pullRequestBody(version, { gatedSha, heading, branch }) {
  const entry = heading.replace(/^##\s*/, '');
  return [
    `Version bump and changelog promotion for ${version}, and nothing else. The commit sits on top of ${gatedSha.slice(0, 9)}, which is the commit the release gate passed on.`,
    '',
    `Promoted changelog heading: ${entry}`,
    `Full entry: https://github.com/${REPO}/blob/${branch}/CHANGELOG.md`,
    '',
    `Branch protection requires the checks on this pull request to pass before it can merge, so there is nothing further to run locally. Once it has merged, \`npm run release -- tag ${version}\` tags the merged commit on main, and that tag is what starts the build, sign, notarise and draft publish workflow.`,
    '',
  ].join('\n');
}

// Everything up to the point a human has to look at something: preflight, gate
// check, version bump, changelog promotion, a commit on `release/<version>`,
// the branch pushed, and a pull request opened against main. It does not push
// to main and it does not tag. Throws so it is unit-testable; the main flow
// converts to fail().
function prepareRelease(version, { root = ROOT, git = gitIn(root), gh = ghCli(root), log = logStep } = {}) {
  preflight(version, { root, git });

  // The gate governs the SHA being released: check it BEFORE the version-bump
  // commit is created, because that commit only adds package.json and
  // CHANGELOG.md on top of the gated code.
  const gatedSha = git(['rev-parse', 'HEAD']).trim();
  requireGatePass(gatedSha, { root });

  const branch = `release/${version}`;
  if (git(['branch', '--list', branch]).trim()) {
    throw new Error(`Branch ${branch} already exists locally. Delete it, or finish the release it belongs to.`);
  }
  if (git(['ls-remote', '--heads', 'origin', branch]).trim()) {
    throw new Error(`Branch ${branch} already exists on the remote. An earlier prepare got that far; review its pull request rather than starting again.`);
  }

  // The push is the boundary between what can be wound back and what cannot.
  // Before it, the only changes anywhere are the ones made below, because the
  // preflight proved the tree was clean, so a failure restores exactly what
  // this function wrote and nothing of anyone else's. After it, the branch is
  // on the remote and somebody may already be reading it, so the failure says
  // what exists rather than tidying it away.
  let pushed = false;
  try {
    git(['checkout', '-b', branch], { stdio: 'pipe' });
    setVersion(version, { root, log });
    const heading = promoteUnreleasedChangelog(version, { root, log });
    git(['add', 'package.json', 'CHANGELOG.md'], { stdio: 'pipe' });
    git(['commit', '-m', `chore: release ${version}`], { stdio: 'pipe' });
    git(['push', '-u', 'origin', branch], { stdio: 'pipe' });
    pushed = true;
    log('prepare', `Pushed ${branch}`);

    const out = gh([
      'pr', 'create',
      '--base', 'main',
      '--head', branch,
      '--title', `Prepare the ${version} release`,
      '--body', pullRequestBody(version, { gatedSha, heading, branch }),
    ]);
    const pullRequest = String(out || '').trim().split('\n').filter(Boolean).pop() || '';
    log('prepare', `Opened ${pullRequest || 'the pull request'}`);
    return { branch, gatedSha, heading, pullRequest };
  } catch (err) {
    if (pushed) {
      throw new Error(
        `${err.message}\n\nThe branch ${branch} is pushed and carries the release commit, but the pull request was not opened. ` +
        `Open it against main by hand, or delete the branch and run prepare again. No tag exists either way.`
      );
    }
    const restored = restoreMain(branch, { git });
    throw new Error(
      `${err.message}\n\n${restored}`
    );
  }
}

// Put the repository back on main as the preflight found it. Safe only because
// the preflight refuses a dirty tree, so the sole thing discarded here is the
// version bump and changelog promotion this run just wrote.
function restoreMain(branch, { git }) {
  try {
    git(['checkout', '--force', 'main'], { stdio: 'pipe' });
    if (git(['branch', '--list', branch]).trim()) {
      git(['branch', '-D', branch], { stdio: 'pipe' });
    }
    return 'Nothing was pushed. The working tree is back on main as it was, and no tag exists.';
  } catch (err) {
    return (
      `Nothing was pushed, and winding the working tree back failed as well: ${err.message}. ` +
      `Check "git status" and "git branch" before running prepare again.`
    );
  }
}

// ---------------------------------------------------------------------------
// Tag subcommand
// ---------------------------------------------------------------------------

// Run after the prepare pull request has been reviewed and merged. It cannot
// assume the merge landed just because it was asked to run, so it reads the
// state of `origin/main` and refuses unless the release commit is actually
// there. Tagging is the irreversible half of a release: the tag is what starts
// the build, sign, notarise and draft publish workflow.
//
// THE GATE IS DELIBERATELY NOT RE-RUN HERE. The tagged commit is always one
// past the gated one, because the bump commit sits on top of it, so a gate
// check at this point would be gating a commit that only touches package.json
// and CHANGELOG.md. The gate check happens once, in prepare, against the
// pre-bump commit, which is where it has always happened.
//
// Throws so it is unit-testable; the main flow converts to fail().
function tagRelease(version, { root = ROOT, git = gitIn(root), log = logStep } = {}) {
  const tag = `v${version}`;

  // On main, clean tree, not behind origin, and the tag not already local.
  preflight(version, { root, git });

  // The tag must land on the reviewed commit, so local main has to BE that
  // commit rather than merely contain it: the preflight rules out being behind,
  // and this rules out being ahead.
  const head = git(['rev-parse', 'HEAD']).trim();
  const merged = git(['rev-parse', 'origin/main']).trim();
  if (head !== merged) {
    throw new Error(
      `Local main is at ${head.slice(0, 9)} but origin/main is at ${merged.slice(0, 9)}. ` +
      `The tag must land on the reviewed commit, so local main must carry nothing of its own.`
    );
  }

  let pkg;
  try {
    pkg = JSON.parse(git(['show', `${merged}:package.json`]));
  } catch (err) {
    throw new Error(`Could not read package.json at origin/main: ${err.message}`);
  }
  if (pkg.version !== version) {
    throw new Error(
      `package.json at origin/main is ${pkg.version}, not ${version}. ` +
      `The prepare pull request for ${version} has not merged yet: run "npm run release -- prepare ${version}" first, then merge it.`
    );
  }

  // The version alone is not proof the release commit landed. A tree with the
  // bump but no promoted heading would publish a release with empty notes,
  // which is the failure the changelog promotion exists to prevent.
  const changelog = git(['show', `${merged}:CHANGELOG.md`]);
  const headingRe = new RegExp(`^## ${version.replace(/\./g, '\\.')}:`, 'm');
  if (!headingRe.test(changelog)) {
    throw new Error(
      `CHANGELOG.md at origin/main has no "## ${version}:" heading, so the changelog promotion is not on main. ` +
      `Tagging now would publish a release with no notes.`
    );
  }

  if (git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]).trim()) {
    throw new Error(`Tag ${tag} already exists on the remote. Choose a new version, or recut deliberately by deleting it first.`);
  }

  git(['tag', tag], { stdio: 'pipe' });
  try {
    git(['push', 'origin', tag], { stdio: 'pipe' });
  } catch (err) {
    // Leave nothing tagged anywhere. A local tag left behind would make the
    // next attempt fail the preflight instead of retrying the push.
    let cleanup = 'The local tag has been removed, so nothing is tagged anywhere.';
    try {
      git(['tag', '-d', tag], { stdio: 'pipe' });
    } catch (deleteErr) {
      cleanup = `The local tag could not be removed either (${deleteErr.message}); delete it with "git tag -d ${tag}" before trying again.`;
    }
    throw new Error(`Pushing ${tag} failed: ${err.message}\n\n${cleanup}`);
  }

  log('tag', `Tagged ${tag} on ${merged.slice(0, 9)} and pushed it`);
  return { tag, sha: merged };
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
  logStep('push', `Committed, pushed main, and pushed tag ${tag}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Guarded so the changelog helpers are requireable (by tests and by
// scripts/release-notes.js) without starting a release.
if (require.main === module) {
  if (process.argv[2] === 'publish') {
    // npm run release -- publish <version>
    // Publishes the reviewed draft, binding the tag before the draft flip.
    const version = process.argv[3];
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
      fail('publish', 'Usage: npm run release -- publish <version> (e.g. npm run release -- publish 0.11.7)');
    }
    try {
      const result = publishRelease(version);
      console.log('');
      logStep('done', `v${version} is live: ${result.url || `https://github.com/${REPO}/releases`}`);
      logStep('done', 'Site download links resolve via /releases/latest; no bump needed.');
    } catch (err) {
      fail('publish', err.message);
    }
  } else {
    const version = getVersion();
    try {
      preflight(version);
    } catch (err) {
      fail('preflight', err.message);
    }
    // The gate governs the SHA being tagged: check it BEFORE the version-bump
    // commit is created (that commit only adds package.json + CHANGELOG.md on
    // top of the gated code).
    try {
      requireGatePass(git(['rev-parse', 'HEAD']).trim());
    } catch (err) {
      fail('gate', err.message);
    }
    setVersion(version);
    try {
      promoteUnreleasedChangelog(version);
    } catch (err) {
      fail('changelog', err.message);
    }
    commitTagPush(version);

    console.log('');
    logStep('done', `Tagged v${version}. GitHub Actions is now building, signing, notarising, and publishing a DRAFT release.`);
    logStep('done', `Watch the build:   https://github.com/${REPO}/actions`);
    logStep('done', `Review the draft:  https://github.com/${REPO}/releases`);
    logStep('done', `Then publish with: npm run release -- publish ${version}  (binds the tag before flipping the draft flag)`);
    logStep('done', `If CI fails (e.g. expired Apple agreement): fix it and re-run the workflow on tag v${version}: no need to revert main.`);
  }
}

module.exports = {
  extractChangelogEntry,
  promoteUnreleasedChangelog,
  preflight,
  requireGatePass,
  prepareRelease,
  tagRelease,
  publishRelease,
  ghApiArgs,
};
