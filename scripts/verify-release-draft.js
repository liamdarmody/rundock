#!/usr/bin/env node
'use strict';

/**
 * Verify the draft GitHub release a tag build produced, before it is publishable.
 *
 * Why: the product has a nine-step gate in front of every commit, and the
 * machinery that turns a gated commit into a downloadable release had no
 * verification at all. Cutting 0.11.7 hit three faults in that machinery and
 * none in application code. The dangerous one was a draft carrying the right
 * name, the right notes and all nine artefacts, bound to
 * `untagged-084fdf02808ef05fdba4` instead of `v0.11.7`. Publishing it would
 * have created a release under a meaningless tag with the auto-update feed
 * pointing at it. It looked entirely correct in the GitHub interface, and was
 * caught only because the tag was read back and compared rather than glanced
 * at.
 *
 * That binding comes loose on any edit that omits `tag_name`, including edits
 * made in the GitHub interface, which is exactly where a release gets renamed
 * before publishing. So this runs as the last step of the release workflow's
 * `finalize` job, after that job's own PATCH, and re-fetches the release list
 * from the API rather than trusting an id or a field read earlier in the run.
 *
 * A passing release workflow used to mean nothing had been checked. The point
 * here is that it means something, so this prints what it verified on success
 * and names every problem individually on failure.
 *
 * Usage:
 *   node scripts/verify-release-draft.js [--info-dir <dir>]
 *
 * Reads GITHUB_REPOSITORY and GITHUB_REF_NAME from the environment, and the
 * expected name and notes from <dir>/release-name.txt and
 * <dir>/release-notes.md (default `release-info`, as written by
 * scripts/release-notes.js). Needs `gh` authenticated, as GH_TOKEN in CI.
 * Exits non-zero if the draft is not exactly what the tag should have made.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Expectations and checks (pure, unit-tested)
// ---------------------------------------------------------------------------

// Every artefact a tag build attaches, grouped by the job that produces it.
// These names are copied from the asset lists of real published releases
// (v0.11.7 and v0.11.8 each carry exactly these nine), not inferred from the
// electron-builder config: the config says which targets run, not what
// electron-builder names their output. macOS builds universal dmg + zip,
// Windows builds an NSIS installer + a portable exe, each platform publishes
// its own update feed, and the differential-update blockmaps ride along.
function expectedAssets(version) {
  return {
    macOS: [
      `Rundock-${version}-universal.dmg`,
      `Rundock-${version}-universal.dmg.blockmap`,
      `Rundock-${version}-universal-mac.zip`,
      `Rundock-${version}-universal-mac.zip.blockmap`,
      'latest-mac.yml',
    ],
    Windows: [
      `Rundock-Setup-${version}.exe`,
      `Rundock-Setup-${version}.exe.blockmap`,
      `Rundock-${version}.exe`,
      'latest.yml',
    ],
  };
}

function allExpectedAssets(version) {
  const groups = expectedAssets(version);
  return Object.keys(groups).reduce((names, platform) => names.concat(groups[platform]), []);
}

// GitHub stores a release body verbatim, but the value being compared against
// it came off disk with a trailing newline and may have travelled through a
// Windows runner, so compare on line endings and edge whitespace normalised.
function normaliseText(value) {
  return String(value == null ? '' : value).replace(/\r\n/g, '\n').trim();
}

// Locate the release this tag build produced.
//
// Matching on `tag_name` is the primary lookup and is also the assertion: a
// draft whose tag has been reset is not found by it. Rather than report the
// unhelpful "no release found", fall back to finding the release by the
// artefacts it carries, because a draft bound to an `untagged-` placeholder
// still holds this version's files. That fallback is what turns the 0.11.7
// failure from a mystery into a one-line diagnosis.
function findReleaseForTag(releases, tag) {
  const version = String(tag).replace(/^v/, '');
  const list = Array.isArray(releases) ? releases : [];

  const byTag = list.filter((r) => r && r.tag_name === tag);
  if (byTag.length === 1) return { release: byTag[0], matchedBy: 'tag', candidates: byTag };
  if (byTag.length > 1) return { release: null, matchedBy: 'ambiguous-tag', candidates: byTag };

  const versioned = new Set(allExpectedAssets(version).filter((name) => name.includes(version)));
  const byAssets = list.filter((r) => {
    const assets = r && Array.isArray(r.assets) ? r.assets : [];
    return assets.some((a) => a && versioned.has(a.name));
  });
  if (byAssets.length === 1) return { release: byAssets[0], matchedBy: 'assets', candidates: byAssets };
  if (byAssets.length > 1) return { release: null, matchedBy: 'ambiguous-assets', candidates: byAssets };

  return { release: null, matchedBy: null, candidates: [] };
}

function describeTags(releases) {
  return releases.map((r) => `${r && r.tag_name} (id ${r && r.id})`).join(', ');
}

// Returns every problem found rather than the first: a release cut is
// expensive to repeat, so a run should report the whole picture at once.
function verifyReleaseDraft({ releases, tag, expectedName, expectedNotes }) {
  const failures = [];
  const warnings = [];
  const version = String(tag).replace(/^v/, '');
  const found = findReleaseForTag(releases, tag);
  const release = found.release;

  if (!release) {
    if (found.matchedBy === 'ambiguous-tag') {
      failures.push(
        `${found.candidates.length} releases carry the tag ${tag}: ${describeTags(found.candidates)}. ` +
        'One of them is a leftover; delete it before publishing, or the wrong one gets promoted.'
      );
    } else if (found.matchedBy === 'ambiguous-assets') {
      failures.push(
        `No release carries the tag ${tag}, and ${found.candidates.length} releases carry ${version} artefacts: ` +
        `${describeTags(found.candidates)}. The build's artefacts are split across releases, none of them tagged ${tag}.`
      );
    } else {
      failures.push(
        `No release carries the tag ${tag}, and no release carries any ${version} artefact. ` +
        'The build should have created a draft and attached files to it; there is nothing here to publish.'
      );
    }
    return { failures, warnings, release: null, matchedBy: found.matchedBy, assets: null };
  }

  // 1. The tag binding. Reaching the release through its artefacts rather than
  //    its tag IS the failure, so it is reported from how it was found.
  if (found.matchedBy === 'assets') {
    failures.push(
      `tag_name is "${release.tag_name}", expected "${tag}". The release holding the ${version} artefacts is bound ` +
      'to the wrong tag: publishing it would ship under that tag with the auto-update feed pointing at it. Repoint ' +
      'it with a PATCH that sets tag_name, and re-check afterwards, since any later edit that omits tag_name resets it.'
    );
  }

  // 2. The artefacts, by name and by count, per platform. A platform whose
  //    build broke leaves a draft that still looks complete at a glance.
  const groups = expectedAssets(version);
  const expectedNames = allExpectedAssets(version);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const byName = new Map(assets.filter((a) => a && a.name).map((a) => [a.name, a]));
  let present = 0;

  Object.keys(groups).forEach((platform) => {
    const names = groups[platform];
    const missing = names.filter((name) => !byName.has(name));
    present += names.length - missing.length;
    if (missing.length) {
      failures.push(
        `${platform} artefacts missing from the draft, ${names.length - missing.length} of ${names.length} present. ` +
        `Missing: ${missing.join(', ')}.`
      );
    }
    names.forEach((name) => {
      const asset = byName.get(name);
      if (!asset) return;
      // An asset stuck at "starting" is an upload that never finished. It is
      // listed on the release and downloads as nothing.
      if (asset.state !== 'uploaded') {
        failures.push(`Asset ${name} is in state "${asset.state}", not "uploaded": its upload did not complete.`);
      } else if (!(Number(asset.size) > 0)) {
        failures.push(`Asset ${name} is ${asset.size} bytes.`);
      }
    });
  });

  assets.forEach((asset) => {
    const name = asset && asset.name;
    if (!name || expectedNames.includes(name)) return;
    if (/^Rundock-/.test(name)) {
      // Every Rundock artefact this build produces is accounted for by name,
      // so an extra one belongs to another version or another target. A stale
      // artefact on a draft downloads as if it were this release.
      failures.push(`The draft carries an unexpected artefact: ${name}. It is not part of the ${version} build.`);
    } else {
      warnings.push(`Unrecognised extra asset on the draft: ${name}.`);
    }
  });

  // 3. The name, against the changelog heading this version's notes came from.
  const wantName = normaliseText(expectedName);
  const haveName = normaliseText(release.name);
  if (!wantName) {
    failures.push('No expected release name was supplied: release-name.txt is empty, so the name cannot be verified.');
  } else if (!haveName) {
    failures.push(`The draft has no name. It should carry the changelog heading for ${version}: "${wantName}".`);
  } else if (haveName !== wantName) {
    failures.push(`The draft is named "${haveName}", expected the changelog heading "${wantName}".`);
  }

  // 4. The notes. A draft release with blank notes must never be published,
  //    and a body that no longer matches the changelog means an edit or a
  //    partial patch replaced them after they were written.
  const wantNotes = normaliseText(expectedNotes);
  const haveNotes = normaliseText(release.body);
  if (!wantNotes) {
    failures.push('No expected release notes were supplied: release-notes.md is empty, so the body cannot be verified.');
  } else if (!haveNotes) {
    failures.push(
      'The draft body is empty. The patch that fills it from the changelog either did not apply or was overwritten.'
    );
  } else if (haveNotes !== wantNotes) {
    failures.push(
      `The draft body does not match the changelog notes for ${version} ` +
      `(draft ${haveNotes.length} chars, changelog ${wantNotes.length} chars).`
    );
  }

  return {
    failures,
    warnings,
    release,
    matchedBy: found.matchedBy,
    assets: { total: assets.length, expected: expectedNames.length, present },
  };
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

// One page of 100 covers every release this project has, and the API returns
// newest first, so the release just built is always on it. Deliberately not
// `--paginate`: combined with `--jq` it emits one result per page, which is
// not parseable as a single document, and this needs structured output.
function fetchReleases(repo) {
  const out = execFileSync('gh', ['api', `repos/${repo}/releases?per_page=100`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(out);
  if (!Array.isArray(parsed)) {
    throw new Error('the releases endpoint did not return a list');
  }
  return parsed;
}

function main() {
  const args = process.argv.slice(2);
  const dirFlag = args.indexOf('--info-dir');
  const infoDir = dirFlag !== -1 ? args[dirFlag + 1] : 'release-info';

  const repo = process.env.GITHUB_REPOSITORY;
  const tag = process.env.GITHUB_REF_NAME;
  if (!repo || !tag) {
    console.error('verify-release-draft: GITHUB_REPOSITORY and GITHUB_REF_NAME must both be set.');
    process.exit(1);
  }

  let expectedName;
  let expectedNotes;
  try {
    expectedName = fs.readFileSync(path.join(infoDir, 'release-name.txt'), 'utf8');
    expectedNotes = fs.readFileSync(path.join(infoDir, 'release-notes.md'), 'utf8');
  } catch (err) {
    console.error(
      `verify-release-draft: could not read the changelog-derived name and notes from ${infoDir} (${err.message}). ` +
      'Run scripts/release-notes.js first.'
    );
    process.exit(1);
  }

  let releases;
  try {
    releases = fetchReleases(repo);
  } catch (err) {
    console.error(`verify-release-draft: could not list the releases of ${repo} (${err.message}).`);
    process.exit(1);
  }

  const result = verifyReleaseDraft({ releases, tag, expectedName, expectedNotes });
  result.warnings.forEach((warning) => console.log(`verify-release-draft: warning: ${warning}`));

  if (result.failures.length) {
    console.error(`\nverify-release-draft: the draft for ${tag} is NOT publishable. ${result.failures.length} problem(s):\n`);
    result.failures.forEach((failure, i) => console.error(`  ${i + 1}. ${failure}`));
    console.error('\nNothing has been published: the release is still a draft. Fix it, then re-run this job.');
    process.exit(1);
  }

  const release = result.release;
  console.log(`verify-release-draft: release ${release.id} verified for ${tag}.`);
  console.log(`  tag_name    ${release.tag_name}`);
  console.log(`  name        ${normaliseText(release.name)}`);
  console.log(`  notes       ${normaliseText(release.body).length} chars, matching the changelog entry`);
  console.log(
    `  artefacts   ${result.assets.present} of ${result.assets.expected} expected present, ` +
    `${result.assets.total} assets on the release`
  );
}

if (require.main === module) main();

module.exports = { expectedAssets, allExpectedAssets, findReleaseForTag, verifyReleaseDraft };
