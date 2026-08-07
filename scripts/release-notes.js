#!/usr/bin/env node

/**
 * Produce the release name and notes for a version from CHANGELOG.md.
 *
 * The release workflow publishes a draft GitHub release for each tag; until
 * this script existed the draft arrived untitled and empty, and the notes
 * were retyped by hand from the changelog at publish time. Now the workflow
 * runs this before building and passes the results to electron-builder via
 * releaseInfo, so the draft arrives named and documented.
 *
 * Usage:
 *   node scripts/release-notes.js <version> --out <dir>
 *
 * Writes <dir>/release-name.txt and <dir>/release-notes.md. Exits non-zero
 * if the changelog has no entry for the version: a release with blank notes
 * is precisely the failure this exists to prevent, so it must stop the tag
 * build rather than let it publish.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { extractChangelogEntry } = require('./release.js');

// The changelog heading is "## <version>: <Name> (<YYYY-MM-DD>)". The
// release name matches every release published to date: version and name,
// no date (GitHub shows its own timestamp).
function buildReleaseInfo(version, changelogText) {
  const entry = extractChangelogEntry(version, changelogText);
  if (!entry) {
    throw new Error(`CHANGELOG.md has no entry for ${version}. Add release notes before tagging.`);
  }
  const name = entry.title.replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*$/, '');
  if (!entry.body) {
    throw new Error(`The changelog entry for ${version} has an empty body. A release must not ship with blank notes.`);
  }
  return { name, notes: entry.body };
}

function main() {
  const args = process.argv.slice(2);
  const version = args[0];
  const outFlag = args.indexOf('--out');
  const outDir = outFlag !== -1 ? args[outFlag + 1] : null;
  if (!version || !outDir) {
    console.error('Usage: node scripts/release-notes.js <version> --out <dir>');
    process.exit(1);
  }

  let info;
  try {
    info = buildReleaseInfo(version);
  } catch (err) {
    console.error(`release-notes: ${err.message}`);
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'release-name.txt'), info.name + '\n');
  fs.writeFileSync(path.join(outDir, 'release-notes.md'), info.notes + '\n');
  console.log(`release-notes: "${info.name}" (${info.notes.length} chars of notes) -> ${outDir}`);
}

if (require.main === module) main();

module.exports = { buildReleaseInfo };
