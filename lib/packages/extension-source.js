'use strict';
// Where an extension comes from: a GitHub repository plus a pinned reference,
// validated before anything is fetched, and fetched through an injectable
// acquirer so every test drives the flow without a network and the one
// default implementation is the only place git is spelled.
//
// THE PIN IS REQUIRED, NOT DEFAULTED. "Run whatever is on main" and "run this
// exact snapshot" are different promises, and only the second is one an
// install screen can honestly make: the bytes the trust step derives its
// facts from must be the bytes that land. A URL without a reference is
// refused with the reason rather than quietly pointed at a branch, and the
// well-known moving names are refused by name when supplied explicitly,
// because typing "main" into a field labelled as a pin is the same wish
// spelled out.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Accepted spellings of one identity: the https URL, with or without .git,
// and the bare owner/repo shorthand the Directory's submission field uses.
// Everything normalises to the canonical https URL so two spellings of one
// repository produce one record.
const HTTPS_URL = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;
const SHORTHAND = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/;

// Names that are conventions for "the newest thing", which is exactly what a
// pin exists to not mean.
const MOVING_NAMES = new Set(['main', 'master', 'head', 'trunk', 'develop']);

function refuse(message, code) {
  const error = new TypeError(`extension source refused: ${message}`);
  error.code = code || 'extension-source-refused';
  throw error;
}

/**
 * Validate and normalise a pasted source. Returns { url, owner, repo,
 * reference } or throws a named refusal. The reference comes back verbatim,
 * because the record must carry what the person pinned, not a rewriting.
 */
function parseGitHubSource(rawUrl, rawReference) {
  const url = String(rawUrl == null ? '' : rawUrl).trim();
  if (!url) refuse('a GitHub repository URL is required');
  let match = HTTPS_URL.exec(url) || SHORTHAND.exec(url);
  if (!match) refuse(`"${url}" is not a GitHub repository URL or owner/repo shorthand`);
  const [, owner, repoRaw] = match;
  const repo = repoRaw.replace(/\.git$/, '');
  const reference = String(rawReference == null ? '' : rawReference).trim();
  if (!reference) {
    refuse('a pinned reference (tag, release or commit) is required; an install is a promise '
      + 'about exact bytes, and a moving branch cannot keep it', 'unpinned-reference');
  }
  if (MOVING_NAMES.has(reference.toLowerCase())) {
    refuse(`"${reference}" is a moving branch name, not a pin; use a tag, release or commit`,
      'unpinned-reference');
  }
  return { url: `https://github.com/${owner}/${repo}`, owner, repo, reference };
}

/**
 * Fetch the pinned snapshot into a fresh temporary directory and return its
 * path. This is the default acquirer; callers take it as a dependency so a
 * test hands in one that materialises a fixture instead. Shallow by design:
 * one reference, no history, nothing to run.
 */
function acquireWithGit(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-ext-'));
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git(['init', '--quiet']);
    git(['remote', 'add', 'origin', source.url]);
    git(['fetch', '--quiet', '--depth', '1', 'origin', source.reference]);
    git(['checkout', '--quiet', 'FETCH_HEAD']);
    fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    return dir;
  } catch (e) {
    discardAcquisition(dir);
    refuse(`could not fetch ${source.url} at ${source.reference}: ${e.message}`, 'acquire-failed');
  }
}

/**
 * Remove an acquired snapshot. Declining an install calls this, because "no"
 * has to leave nothing behind anywhere, the temporary directory included.
 */
function discardAcquisition(dir) {
  if (typeof dir === 'string' && dir) fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { parseGitHubSource, acquireWithGit, discardAcquisition, MOVING_NAMES };
