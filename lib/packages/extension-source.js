'use strict';
// Where an extension comes from: a GitHub repository plus a pinned reference,
// validated before anything is fetched, and fetched through injectable
// dependencies so every test drives the flow without a network and the
// default implementations here are the only place git is spelled.
//
// THE PIN IS REQUIRED FOR CODE, AND DERIVED RATHER THAN TYPED. "Run whatever
// is on main" and "run this exact snapshot" are different promises, and only
// the second is one an install screen can honestly make: the bytes the trust
// step derives its facts from must be the bytes that land. Agents and skills
// are files, not code that runs at install, so a link may arrive without a
// reference and be read at the repository's head for the content it offers;
// the moment the bytes classify as an extension, the caller resolves the
// missing reference to the repository's latest tag, or refuses by name when
// no tag exists, rather than quietly pointing the install at a branch.
// requirePin stays as the last stand between unpinned bytes and an install.
//
// AN EXTENSION IS NEVER INSTALLED FROM A BRANCH (decided 2026-09-23). A pin
// is a tag or an exact commit, and nothing else: a branch is a name for
// whatever was pushed last, so installing from one is the "run whatever is
// on main" promise under another name. Which of the two a reference is, is a
// fact about the remote, so the fetch records it (acquiredPinKind) and
// requireFixedPin refuses every reference that fetched as neither. The
// well-known moving names are also refused by name before anything is
// fetched, in a link or beside one, because naming "main" is the branch wish
// spelled out and costs nobody a fetch to say so.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

// Accepted spellings of one identity: the https URL, with or without .git,
// and the bare owner/repo shorthand the Directory's submission field uses.
// Everything normalises to the canonical https URL so two spellings of one
// repository produce one record.
const HTTPS_URL = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;
const SHORTHAND = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/;

// A link may name its own reference, and when it does the link is the pin:
// a release page, a tree URL, or the owner/repo@ref shorthand. The reference
// is taken verbatim from the link (a trailing slash aside), because the
// record must carry what the person pinned, not a rewriting, and it then
// passes through exactly the same moving-name and dash rules a separately
// supplied reference does.
const RELEASE_URL = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)\/releases\/tag\/(.+?)\/?$/;
const TREE_URL = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)\/tree\/(.+?)\/?$/;
const SHORTHAND_AT = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)@(.+)$/;

// Names that are conventions for "the newest thing", which is exactly what a
// pin exists to not mean.
const MOVING_NAMES = new Set(['main', 'master', 'head', 'trunk', 'develop']);

// An exact commit is its full object name. A short one is a prefix that can
// grow ambiguous, and git will not fetch one.
const COMMIT = /^[0-9a-f]{40}$/i;

// The one sentence every branch refusal says, so the field reads the same
// whichever check caught it.
const BRANCH_REFUSED = 'an extension is never installed from a branch; use a tag or an exact commit';

function refuse(message, code) {
  const error = new TypeError(`extension source refused: ${message}`);
  error.code = code || 'extension-source-refused';
  throw error;
}

/**
 * Validate and normalise a pasted source. Returns { url, owner, repo,
 * reference } or throws a named refusal. The reference comes back verbatim,
 * because the record must carry what the person pinned, not a rewriting;
 * an absent one comes back null, and requirePin is where null is refused.
 */
function parseGitHubSource(rawUrl, rawReference) {
  const url = String(rawUrl == null ? '' : rawUrl).trim();
  if (!url) refuse('a GitHub repository URL is required');
  let linkReference = null;
  let match = RELEASE_URL.exec(url) || TREE_URL.exec(url) || SHORTHAND_AT.exec(url);
  if (match) linkReference = match[3];
  else match = HTTPS_URL.exec(url) || SHORTHAND.exec(url);
  if (!match) refuse(`"${url}" is not a GitHub repository URL or owner/repo shorthand`);
  const [, owner, repoRaw] = match;
  const repo = repoRaw.replace(/\.git$/, '');
  const typed = String(rawReference == null ? '' : rawReference).trim();
  // The link's own reference and a separately supplied one are the same
  // channel spelled twice. When both arrive they must agree, because
  // silently preferring either would install something other than what one
  // half of the input asked for.
  if (linkReference && typed && typed !== linkReference) {
    refuse(`the link already names "${linkReference}"; it cannot also be pinned to "${typed}"`);
  }
  const reference = linkReference || typed;
  if (!reference) return { url: `https://github.com/${owner}/${repo}`, owner, repo, reference: null };
  // The well-known moving names are refused in every spelling git accepts
  // for a branch tip, qualified or bare: "refs/heads/main" names exactly
  // what "main" names.
  if (MOVING_NAMES.has(reference.toLowerCase().replace(/^refs\/heads\//, '').replace(/^heads\//, ''))) {
    refuse(`"${reference}" is a branch, and ${BRANCH_REFUSED}`, 'unpinned-reference');
  }
  // The reference lands directly in a git argv position (both the fetch here
  // and the ls-remote below). A value starting with a dash is read by git as
  // an option rather than as the thing to fetch, which changes the command
  // instead of naming a snapshot, so it is refused before it ever reaches an
  // argv rather than trusted because it happens to also fail well.
  if (reference.startsWith('-')) {
    refuse(`"${reference}" is not a reference; a pin cannot begin with "-"`, 'unpinned-reference');
  }
  return { url: `https://github.com/${owner}/${repo}`, owner, repo, reference };
}

/**
 * The rule for code: a source about to be installed as an extension must be
 * pinned. Refused with the reason, never defaulted to a branch.
 */
function requirePin(source) {
  if (!source || typeof source.reference !== 'string' || !source.reference) {
    refuse('this repository is an extension, and installing one needs an exact tag, release or commit; '
      + 'an install is a promise about exact bytes, and a moving branch cannot keep it', 'unpinned-reference');
  }
  return source;
}

/**
 * The rule for an extension's pin, once its bytes are fetched: the reference
 * must have fetched as a tag or as an exact commit. Anything else (a branch,
 * or any other ref a remote may carry) is refused with the plain reason, and
 * the caller discards what was fetched.
 */
function requireFixedPin(source, kind) {
  if (kind !== 'tag' && kind !== 'commit') {
    refuse(`"${source && source.reference}" is not a tag or a commit of this repository, and ${BRANCH_REFUSED}`,
      'unpinned-reference');
  }
  return source;
}

/**
 * Fetch the snapshot into a fresh temporary directory and return its
 * path. This is the default acquirer; callers take it as a dependency so a
 * test hands in one that materialises a fixture instead. Shallow by design:
 * one reference, no history, nothing to run.
 */
// BOUNDED, AND NEVER WAITING ON A PERSON. Git runs synchronously inside the
// server's handler, so while it runs nothing else is served. Every call is
// capped in time, a stalled transfer is abandoned once it has been slow for
// long enough, and git is told never to prompt for credentials: a private or
// mistyped repository fails at once rather than waiting on a terminal
// nobody is looking at. The cap bounds the freeze rather than removing it;
// moving git off the handler is the complete fix, recorded as open.
const GIT_TIMEOUT_MS = 90 * 1000;
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never' };
const GIT_LOW_SPEED = ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=30'];

// The commit each acquired snapshot is, by its directory. Read from
// FETCH_HEAD before the repository metadata is removed, because a reference
// is a name and only a commit is the bytes: "pinned to dev" names something
// that can move, and the record must say what was actually installed.
const acquiredCommits = new Map();
function acquiredCommit(dir) {
  return acquiredCommits.get(dir) || null;
}

// What each acquired snapshot's reference turned out to be on the remote:
// 'tag', 'commit', or 'other' (a branch, the head, any other ref). Only the
// fetch can know, so it is recorded here beside the commit.
const acquiredKinds = new Map();
function acquiredPinKind(dir) {
  return acquiredKinds.get(dir) || null;
}

// A tag is fetched by its qualified name, so a branch that happens to share
// the tag's name can never be what arrives in its place.
function tagRefFor(reference) {
  return reference.startsWith('refs/tags/') ? reference : `refs/tags/${reference}`;
}

function acquireWithGit(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-ext-'));
  const git = (args) => execFileSync('git', [...GIT_LOW_SPEED, ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS, env: GIT_ENV });
  try {
    git(['init', '--quiet']);
    git(['remote', 'add', 'origin', source.url]);
    // No pin means the repository's head, which is only ever read for the
    // agents and skills it offers: requirePin stands between these bytes
    // and any extension install. A named reference is tried as an exact
    // commit, then as a tag, and only then by its bare name, which is how a
    // branch arrives; what it turned out to be is recorded for
    // requireFixedPin.
    const fetch = (ref) => git(['fetch', '--quiet', '--depth', '1', 'origin', ref]);
    let kind = 'other';
    if (!source.reference) fetch('HEAD');
    else if (COMMIT.test(source.reference)) { fetch(source.reference); kind = 'commit'; }
    else {
      try { fetch(tagRefFor(source.reference)); kind = 'tag'; } catch { fetch(source.reference); }
    }
    git(['checkout', '--quiet', 'FETCH_HEAD']);
    const commit = String(git(['rev-parse', 'HEAD'])).trim();
    if (/^[0-9a-f]{40}$/.test(commit)) acquiredCommits.set(dir, commit);
    acquiredKinds.set(dir, kind);
    fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    return dir;
  } catch (e) {
    discardAcquisition(dir);
    refuse(`could not fetch ${source.url} at ${source.reference || 'its head'}: ${e.message}`, 'acquire-failed');
  }
}

/**
 * Remove an acquired snapshot. Declining an install calls this, because "no"
 * has to leave nothing behind anywhere, the temporary directory included.
 */
function discardAcquisition(dir) {
  if (typeof dir === 'string' && dir) {
    acquiredCommits.delete(dir);
    acquiredKinds.delete(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * List every tag reference a repository has, in whatever order git returns
 * them. This is the default ref-lister the update check takes as a
 * dependency; it lives here, beside acquireWithGit, rather than in the
 * protocol layer, so this file stays the one place that spells git and a
 * test can drive the update check with a fixture lister instead. Ordering
 * and "which of these is newer" are not this function's job: it answers
 * only what exists, and the caller decides what that means.
 */
function listRefsWithGit(url) {
  return execFileSync('git', [...GIT_LOW_SPEED, 'ls-remote', '--tags', '--refs', url], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env: GIT_ENV })
    .split('\n').filter(Boolean).map((line) => line.split('refs/tags/')[1]).filter(Boolean);
}

/**
 * Every tag of a repository with the COMMIT it resolves to, for the package
 * update check. Asynchronous, so a check never holds the server while git
 * talks to the network, and bounded like every other call here. Listed
 * without --refs so an annotated tag's peeled line (`name^{}`) is seen: that
 * line names the commit, where the plain one names the tag object, and only
 * the commit can be compared with what was installed.
 */
function listTagCommitsWithGit(url) {
  return new Promise((resolve, reject) => {
    execFile('git', [...GIT_LOW_SPEED, 'ls-remote', '--tags', url], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env: GIT_ENV }, (error, stdout) => {
      if (error) {
        reject(Object.assign(new Error(`could not list the releases of ${url}: ${error.message}`), { code: 'acquire-failed' }));
        return;
      }
      const plain = new Map();
      const peeled = new Map();
      for (const line of String(stdout).split('\n')) {
        const m = /^([0-9a-f]{40})\trefs\/tags\/(.+?)(\^\{\})?$/.exec(line);
        if (m) (m[3] ? peeled : plain).set(m[2], m[1]);
      }
      resolve([...plain.keys()].map((name) => ({ name, commit: peeled.get(name) || plain.get(name) })));
    });
  });
}

module.exports = {
  parseGitHubSource, requirePin, requireFixedPin, acquireWithGit, acquiredCommit, acquiredPinKind,
  discardAcquisition, listRefsWithGit, listTagCommitsWithGit, MOVING_NAMES, GIT_TIMEOUT_MS,
};
