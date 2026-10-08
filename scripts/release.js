#!/usr/bin/env node

/**
 * Release script for Rundock (tag-and-let-CI-build model).
 *
 * A release is one pull request and three commands, and the gaps between them
 * are the point. See docs/RELEASING.md for the full order.
 *
 *   npm run release -- bump <version>       # version + promoted changelog, committed with the candidate
 *   ...push the candidate, open its pull request, let CI finish on it...
 *   npm run release:gate                    # what CI cannot do, on the candidate's exact tree
 *   ...start Rundock from the candidate and try the test list in the browser...
 *   npm run release -- signoff <version> --confirm <version>   # record that check for this tree, yourself
 *   ...merge that pull request...
 *   npm run release -- tag <version>        # tag the merged commit, which starts the build
 *   ...watch the build, review the draft it publishes...
 *   npm run release -- publish <version> --confirm <version>   # publish the reviewed draft
 *
 * WHICH CHECKS COME FROM CI. The suite on Node 22 and 24, coverage with its
 * floors, the browser suite (E2E), typecheck and hygiene are required checks on
 * the pull request. The gate does not run them again: it reads their results
 * for the exact tree it gates and refuses, naming the check, unless each
 * passed there. It runs only what CI cannot (scripts/release-gate.js).
 *
 * ONE PULL REQUEST. The candidate carries its version bump and promoted
 * changelog, so the commit that merges is the content the gate passed. The
 * gate record names a TREE, and `tag` accepts it when the merged commit has
 * that tree: a merge that makes a new commit with identical content needs no
 * second gate, and any difference is refused.
 *
 * A RECUT of an unpublished draft is: delete the draft release, delete the tag
 * locally and on the remote, merge the fix, run the gate on main, tag again.
 * Once the tag is gone the version on main is one release past the latest tag
 * again, which is all the gate asks.
 *
 * WHY IT IS NOT ONE COMMAND. main requires status checks with admin
 * enforcement, so nothing pushes to it directly, and merging the pull request
 * is where a human already looks.
 *
 * `tag` starts something that cannot be un-started: the GitHub Actions
 * workflow that builds, signs, notarises, and publishes a DRAFT release.
 * Building does not happen on your laptop, and no Apple or signing
 * credentials are needed locally: those live in the CI environment. But CI
 * never makes anything public. It produces a DRAFT and stops there.
 *
 * `publish` is the step that matters most, and CI never runs it. Only a
 * human decides a specific version is ready for everyone, by running
 * `publish` themselves with --confirm naming that exact version (see
 * hasPublishConfirmation). This was not always enforced: on 2026-08-27 an
 * agent ran `publish` unprompted, straight after fixing unrelated build
 * bugs, because nothing but a naming convention separated it from `tag`.
 * See Ratchet-Log "A split command is not a control", 2026-08-27.
 *
 * Recovery: if the CI build fails (e.g. an expired Apple agreement), fix the
 * cause and re-run the workflow on the same tag (gh run rerun, or the Actions
 * UI). There is no need to revert main: the bump and the tag stay, and the
 * draft is still there to publish once CI passes.
 *
 * Update the Rundock Site download links once the release is published.
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

// The tag refuses to move without a gate pass on the exact tree being tagged.
// The gate record (`.release-gate.json`) is written only by a fully green
// `npm run release:gate` on a clean tree, and names the TREE it passed on, so a
// merge that makes a new commit with identical content is accepted and any
// difference at all is refused. A record gated without live smoke, or without
// reading CI's results, is refused too. Throws so it is unit-testable; the main
// flow converts to fail().
function requireGatePass(headTree, { root = ROOT } = {}) {
  const record = readGateRecord(root);
  if (!record) {
    throw new Error(
      `No release gate pass found (${GATE_FILE_NAME} missing or unreadable). ` +
      `Run "npm run release:gate" on this candidate first; the tag refuses to move without it.`
    );
  }
  if (!record.tree) {
    throw new Error(
      `The gate record names no tree (it was written by an older gate, keyed by commit). ` +
      `Re-run "npm run release:gate" on the candidate.`
    );
  }
  if (record.tree !== headTree) {
    throw new Error(
      `The release gate passed on tree ${record.tree.slice(0, 12)} but the commit being tagged has tree ${headTree.slice(0, 12)}. ` +
      `Any change to the content invalidates the gate. Re-run "npm run release:gate" on what is being tagged.`
    );
  }
  if (!record.live) {
    throw new Error(
      `The gate on tree ${record.tree.slice(0, 12)} ran without live smoke (--no-live). ` +
      `Releases require the full gate: re-run "npm run release:gate" without flags.`
    );
  }
  if (!record.ci || record.ci.skipped || !record.ci.checks) {
    throw new Error(
      `The gate on tree ${record.tree.slice(0, 12)} did not read CI's results (--no-ci). ` +
      `Releases require them: re-run "npm run release:gate" without flags.`
    );
  }
}

// ---------------------------------------------------------------------------
// Sign-off subcommand: the hands-on check from source, recorded by tree
// ---------------------------------------------------------------------------

// Before the cut, the release engineer starts Rundock from the release branch
// and tries a short test list in the browser. That is the step that found
// both blockers of the first 0.15.1 cut, which every gate had passed because
// their tests reached the store and not the handler. `signoff` records that
// it happened, against the tree that was tried, and `tag` refuses any other.
//
// The record lives in git's common directory, so a sign-off made in a
// worktree on the release branch is seen by the checkout that tags main, and
// it can never be committed. It holds the tree, the version, the time and an
// optional note, and nothing else.
//
// IT IS A HUMAN ACT. Three things stand between an agent and a sign-off:
// --confirm must name the version (as publish's does); the command refuses
// inside an agent session (Claude Code sets CLAUDECODE for every command it
// runs); and the note is read from the controlling terminal, not from stdin
// or argv, so nothing can be piped into it and a shell without a terminal,
// which is what an agent's tool runs in, is refused. Copying a printed
// command satisfies none of these. Writing the file by hand is forgery, and
// is the one thing this cannot stop: like the gate record, it is a friction
// boundary, not a security one.
const SIGNOFF_FILE_NAME = 'rundock-release-signoff.json';

function signoffPath({ root = ROOT, git = gitIn(root) } = {}) {
  return path.resolve(root, git(['rev-parse', '--git-common-dir']).trim(), SIGNOFF_FILE_NAME);
}

function readSignoff(opts = {}) {
  try { return JSON.parse(fs.readFileSync(signoffPath(opts), 'utf8')); } catch { return null; }
}

// One line read from the controlling terminal, synchronously. Throws when
// there is none (ENXIO), which is the case for every agent's shell.
function askAtTerminal(prompt, { open = () => fs.openSync('/dev/tty', 'r+') } = {}) {
  const fd = open();
  try {
    fs.writeSync(fd, prompt);
    const buf = Buffer.alloc(1);
    const bytes = [];
    while (fs.readSync(fd, buf, 0, 1, null) === 1 && buf[0] !== 10) bytes.push(buf[0]);
    return Buffer.from(bytes).toString('utf8').trim();
  } finally {
    fs.closeSync(fd);
  }
}

function signoffRelease(version, {
  root = ROOT, git = gitIn(root), argv = process.argv, env = process.env, ask = askAtTerminal, now = () => new Date(), log = logStep,
} = {}) {
  const command = `npm run release -- signoff ${version} --confirm ${version}`;
  if (!hasConfirmation(argv, version)) {
    throw new Error(`A sign-off needs --confirm naming the version you tried from source:\n    ${command}`);
  }
  if (env.CLAUDECODE) {
    throw new Error('This is running inside an agent session. The hands-on check is yours: run the sign-off yourself, at a terminal.');
  }
  if (git(['status', '--porcelain']).trim()) {
    throw new Error('The working tree is not clean, so what you tried is not a committed tree. Commit or stash, try it again, then sign off.');
  }
  const pkg = JSON.parse(git(['show', 'HEAD:package.json']));
  if (pkg.version !== version) {
    throw new Error(`This checkout is ${pkg.version}, not ${version}. Sign off on the release candidate, which carries the bump.`);
  }
  const tree = git(['rev-parse', 'HEAD^{tree}']).trim();
  let note;
  try {
    note = ask(`Tried ${version} from source on tree ${tree.slice(0, 12)}. Note (optional, Enter to record): `);
  } catch (err) {
    throw new Error(`A sign-off is typed at a terminal, and this has none (${err.code || err.message}). Run it yourself, at a terminal.`);
  }
  const record = { tree, version, signedAt: now().toISOString(), ...(note ? { note } : {}) };
  fs.writeFileSync(signoffPath({ root, git }), JSON.stringify(record, null, 2) + '\n');
  log('signoff', `Recorded the hands-on check of ${version} on tree ${tree.slice(0, 12)}`);
  return record;
}

// The tag refuses without a sign-off for exactly the tree it tags. A fix
// after the check changes the tree, so it needs the check again.
function requireSignoff(headTree, version, opts = {}) {
  const signoff = readSignoff(opts);
  const command = `npm run release -- signoff ${version} --confirm ${version}`;
  if (!signoff) {
    throw new Error(
      `No hands-on sign-off found. Start Rundock from the release branch, try the test list in the browser, ` +
      `then record it yourself, at a terminal: ${command}`
    );
  }
  if (signoff.tree !== headTree) {
    throw new Error(
      `The hands-on check was signed off on tree ${String(signoff.tree).slice(0, 12)} but the commit being tagged has tree ${headTree.slice(0, 12)}. ` +
      `Something changed after the check: try this tree from source and sign off again (${command}).`
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

// THE NOTES AND THE BUILD MUST DESCRIBE THE SAME WORK.
//
// Publishing binds a tag to a draft and flips a flag. Nothing in it asked
// whether the draft was built from anything current, so a tag cut days earlier,
// with a build to match, published happily under release notes written from a
// main that had moved a long way past it. That is the worst shape a release
// failure takes: every check green, the notes accurate about the work, and the
// binary missing all of it, so the notes read as a lie rather than an oversight.
// Caught once by hand, two days and seven merges after the tag was cut.
//
// COMPARED BY CHANGELOG SECTION, NOT BY COMMIT. A tag is legitimately behind
// main by the time anyone publishes, because main moves on, so "the tag must be
// main" or "no more than N commits behind" would refuse healthy releases and
// teach people to pass a force flag. What must NOT differ is this version's
// changelog section: the flow promotes it, merges, tags, builds, publishes, and
// nothing in that order rewrites the section after the tag. If it differs, one
// of the two is stale, and which one hardly matters: either the notes promise
// what the build lacks, or the build carries what the notes do not mention.
//
// Read through git rather than the API because publish is always run from a
// clone, and a local read cannot be fooled by a stale API cache. Injected for
// tests, like every other seam in this file.
function requireNotesMatchBuild(version, { root = ROOT, git = gitIn(root), log = logStep } = {}) {
  const tag = `v${version}`;
  try {
    git(['fetch', 'origin', 'main', '--tags'], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`Could not fetch origin before publishing: ${err.message}`);
  }

  let atTag;
  try {
    atTag = git(['show', `${tag}:CHANGELOG.md`]);
  } catch (err) {
    throw new Error(`Could not read CHANGELOG.md at ${tag}: ${err.message}. Does the tag exist?`);
  }
  const atMain = git(['show', 'origin/main:CHANGELOG.md']);

  const tagged = extractChangelogEntry(version, atTag);
  const current = extractChangelogEntry(version, atMain);
  if (!tagged) {
    throw new Error(
      `CHANGELOG.md at ${tag} has no "## ${version}:" section, so the build carries no notes for this release. ` +
      `The tag was cut before the changelog was promoted.`
    );
  }
  if (!current) {
    throw new Error(`CHANGELOG.md at origin/main has no "## ${version}:" section, so there are no notes to publish.`);
  }

  if (tagged.title !== current.title || tagged.body !== current.body) {
    const taggedSha = git(['rev-parse', `${tag}^{commit}`]).trim().slice(0, 9);
    const mainSha = git(['rev-parse', 'origin/main']).trim().slice(0, 9);
    const behind = git(['rev-list', '--count', `${tag}..origin/main`]).trim();
    throw new Error(
      `The notes for ${version} differ between ${tag} (${taggedSha}) and origin/main (${mainSha}), ` +
      `which is ${behind} commit(s) ahead of the tag.\n` +
      `The build was made from the tag and the notes are published from it, so publishing now would ` +
      `describe work the build may not contain.\n` +
      `Recut deliberately: delete the draft release, delete the tag locally and on the remote, then ` +
      `"npm run release -- tag ${version}" to tag and rebuild from current main.`
    );
  }
  log('publish', `Notes at ${tag} match origin/main, so the build and its notes describe the same work`);
}

// Publish the draft release for `version`, binding the tag BEFORE flipping
// the draft flag. The 0.11.6 lesson mechanised: after a recut deletes a tag,
// the draft's tag_name falls back to `untagged-*`, and publishing in that
// state binds the release to the junk tag permanently. Order is the fix:
// PATCH tag_name, VERIFY it stuck, only then PATCH draft=false.
function publishRelease(version, { api = ghApi, log = (msg) => console.log(`[release:publish] ${msg}`), checkNotes = requireNotesMatchBuild } = {}) {
  const tag = `v${version}`;
  // Before anything is bound or flipped: the draft has to have been built from
  // the work these notes describe. Nothing downstream can undo a publish.
  checkNotes(version);
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

// Reads --confirm <version> from argv and checks it names the exact version
// being published. This is a friction boundary, not a security one: anyone
// who can run this script can also type the flag. Its purpose is that the
// command tag prints for its own next step deliberately does not include a
// working --confirm, so publish can never be run by copying the previous
// step's own output. See Ratchet-Log "A split command is not a control",
// 2026-08-27: publish and tag were already separate commands specifically
// so a human decides when the last one runs, and nothing but that naming
// convention stopped an agent running it unprompted mid-task. A stale
// confirmation for a different version does not satisfy this, so an old
// command cannot be reused for a new release by habit.
function hasConfirmation(argv, version) {
  const i = argv.indexOf('--confirm');
  return i !== -1 && argv[i + 1] === version;
}
const hasPublishConfirmation = hasConfirmation;

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
// Bump subcommand
// ---------------------------------------------------------------------------

// The candidate carries its own version: this writes the bump and promotes the
// changelog in the working tree, for the release engineer to commit with the
// candidate. It runs no git and touches nothing else, so a mistake is an edit
// to discard. Throws so it is unit-testable; the main flow converts to fail().
function bumpRelease(version, { root = ROOT, log = logStep } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
    throw new Error(`"${version}" is not plain semver MAJOR.MINOR.PATCH.`);
  }
  const heading = promoteUnreleasedChangelog(version, { root, log });
  setVersion(version, { root, log });
  return { heading };
}

// ---------------------------------------------------------------------------
// Tag subcommand
// ---------------------------------------------------------------------------

// Run after the release pull request has been reviewed and merged. It cannot
// assume the merge landed just because it was asked to run, so it reads the
// state of `origin/main` and refuses unless the release commit is actually
// there. Tagging is the irreversible half of a release: the tag is what starts
// the build, sign, notarise and draft publish workflow.
//
// THE GATE IS CHECKED HERE, BY TREE. The candidate carries its bump, so the
// merged commit is the gated content itself: a merge that makes a new commit
// with the same tree is accepted, and any difference is refused.
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
      `The release pull request for ${version} has not merged yet: the candidate carries the bump ("npm run release -- bump ${version}"), so merge it first.`
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

  const mergedTree = git(['rev-parse', `${merged}^{tree}`]).trim();
  requireGatePass(mergedTree, { root });
  requireSignoff(mergedTree, version, { root, git });

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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const USAGE = [
  'Usage:',
  '  npm run release -- bump <version>                       write the version and promote the changelog, to commit with the candidate',
  '  npm run release -- signoff <version> --confirm <version>   after trying the candidate from source yourself, record it for its tree',
  '  npm run release -- tag <version>                        after the gated, signed-off release pull request merges, tag the merged commit',
  '  npm run release -- publish <version> --confirm <version>   publish the draft release CI built for that tag, only after you have tested it yourself',
].join('\n');

// Guarded so the changelog helpers are requireable (by tests and by
// scripts/release-notes.js) without starting a release.
if (require.main === module) {
  const [subcommand, arg] = process.argv.slice(2);

  const versionFor = (step) => {
    if (!arg || !/^\d+\.\d+\.\d+$/.test(arg)) {
      fail(step, `Usage: npm run release -- ${step} <version> (e.g. npm run release -- ${step} 0.12.0)`);
    }
    return arg;
  };

  if (subcommand === 'prepare') {
    // Retired: the candidate carries its own bump, so there is no second pull
    // request to open. Say what replaced it rather than fail as unknown.
    fail('prepare',
      'prepare is retired: the release candidate carries its own version bump and promoted changelog, in one pull request.\n' +
      `${USAGE}\n  See docs/RELEASING.md for the order.`);
  } else if (subcommand === 'bump') {
    const version = versionFor('bump');
    let result;
    try {
      result = bumpRelease(version);
    } catch (err) {
      fail('bump', err.message);
    }
    console.log('');
    logStep('done', `package.json is ${version} and CHANGELOG.md's top heading is "${result.heading.replace(/^##\s*/, '')}".`);
    logStep('done', 'Commit both with the candidate, push it and open its pull request. Once CI is green on it: npm run release:gate');
  } else if (subcommand === 'signoff') {
    const version = versionFor('signoff');
    try {
      signoffRelease(version);
    } catch (err) {
      fail('signoff', err.message);
    }
  } else if (subcommand === 'tag') {
    const version = versionFor('tag');
    try {
      tagRelease(version);
    } catch (err) {
      fail('tag', err.message);
    }
    console.log('');
    logStep('done', `Tagged v${version}. GitHub Actions is now building, signing, notarising, and publishing a DRAFT release.`);
    logStep('done', `Watch the build:   https://github.com/${REPO}/actions`);
    logStep('done', `Review the draft:  https://github.com/${REPO}/releases`);
    logStep('done', 'Do not publish yet. Download and test the draft build on your own machine(s) first.');
    logStep('done', `Once you have decided v${version} is ready for everyone: npm run release -- publish ${version} --confirm ${version}`);
    logStep('done', `If CI fails (e.g. expired Apple agreement): fix it and re-run the workflow on tag v${version}: no need to revert main.`);
  } else if (subcommand === 'publish') {
    // Publishes the reviewed draft, binding the tag before the draft flip.
    // --confirm is required and must name this exact version: see
    // hasPublishConfirmation's own comment for why.
    const version = versionFor('publish');
    if (!hasPublishConfirmation(process.argv, version)) {
      fail('publish',
        `Publishing v${version} makes it downloadable by everyone, not just you testing the draft.\n` +
        `  This requires --confirm ${version}, typed fresh for this exact version after you have tested the build yourself:\n` +
        `    npm run release -- publish ${version} --confirm ${version}\n` +
        `  Never run this because it was the next line printed by an earlier step, and an agent must never supply --confirm on its own.`
      );
    }
    try {
      const result = publishRelease(version);
      console.log('');
      logStep('done', `v${version} is live: ${result.url || `https://github.com/${REPO}/releases`}`);
      logStep('done', 'Site download links resolve via /releases/latest; no bump needed.');
    } catch (err) {
      fail('publish', err.message);
    }
  } else if (/^\d+\.\d+\.\d+$/.test(subcommand || '')) {
    // The form this script used to take. It pushed the bump straight to main,
    // which a protected branch refuses, so it cannot be made to work: say what
    // replaced it rather than start something that dies halfway through.
    fail('usage', `A release is no longer one command: the bump goes through the release pull request like any other change.\n${USAGE}`);
  } else {
    fail('usage', `${subcommand ? `Unknown subcommand "${subcommand}".` : 'No subcommand given.'}\n${USAGE}`);
  }
}

module.exports = {
  extractChangelogEntry,
  requireNotesMatchBuild,
  promoteUnreleasedChangelog,
  preflight,
  requireGatePass,
  signoffRelease,
  requireSignoff,
  readSignoff,
  askAtTerminal,
  SIGNOFF_FILE_NAME,
  bumpRelease,
  tagRelease,
  publishRelease,
  hasPublishConfirmation,
  ghApiArgs,
};
