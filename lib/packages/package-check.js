'use strict';
// THE PACKAGE UPDATE CHECK, decided 2026-09-24: an update is offered only
// for a new release. A package installed at a version tag is offered the
// tags that come strictly after it, under the one semver order the
// extension records already use; a package installed at a commit, because
// its repository had no tags when it was added, is never offered anything,
// so an update never carries work merged between releases.
//
// Pure: the tag listing is handed in as { name, commit } pairs, with each
// commit the one the tag resolves to (peeled), so an annotated tag compares
// against the commit that was installed rather than its tag object.

const { semverParts, compareSemver } = require('./extension-record.js');

function requireListing(tags) {
  if (!Array.isArray(tags)) throw new TypeError('the tag listing must be an array of { name, commit }');
  return tags.filter((t) => t && typeof t.name === 'string');
}

function checkPackageUpdate(pkg, tags) {
  const listing = requireListing(tags);
  const base = { id: pkg.id, current: pkg.reference, newer: [], moved: null };
  if (!pkg.updatable) return { ...base, outcome: 'not-updatable' };
  const pin = typeof pkg.reference === 'string' ? semverParts(pkg.reference) : null;
  if (!pin) return { ...base, outcome: 'no-release' };
  // The installed tag resolving to different code now is a fact about the
  // author's repository worth saying, and never itself an update.
  const same = listing.find((t) => t.name === pkg.reference);
  const moved = same && pkg.commit && same.commit && same.commit !== pkg.commit
    ? { tag: pkg.reference, was: pkg.commit, now: same.commit } : null;
  const newer = listing
    .map((t) => [t.name, semverParts(t.name)])
    .filter(([, parts]) => parts && compareSemver(parts, pin) > 0)
    .sort(([, a], [, b]) => compareSemver(a, b))
    .map(([name]) => name);
  return { ...base, newer, moved, outcome: newer.length ? 'newer-available' : 'up-to-date' };
}

module.exports = { checkPackageUpdate };
