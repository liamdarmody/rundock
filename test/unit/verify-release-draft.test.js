// Tests for the draft-release verification that runs at the end of a tag
// build (scripts/verify-release-draft.js).
//
// The release pipeline ships the product and was itself unchecked: a workflow
// that went green proved only that no step had thrown. Cutting 0.11.7 produced
// a draft that looked completely correct, right name, right notes, all nine
// artefacts, and was bound to `untagged-084fdf02808ef05fdba4` rather than
// `v0.11.7`. Publishing it would have released under a meaningless tag with
// the auto-update feed pointing at it.
//
// So the case that matters most below is not a hypothetical: it is that exact
// release object, and the check must reject it while every other assertion
// about it passes.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  expectedAssets,
  allExpectedAssets,
  findReleaseForTag,
  verifyReleaseDraft,
} = require('../../scripts/verify-release-draft.js');

// Copied verbatim from the assets of the published v0.11.7 release. Every
// release from v0.9.0 onward carries this same nine, with the version swapped.
const PUBLISHED_0_11_7_ASSET_NAMES = [
  'latest-mac.yml',
  'latest.yml',
  'Rundock-0.11.7-universal-mac.zip',
  'Rundock-0.11.7-universal-mac.zip.blockmap',
  'Rundock-0.11.7-universal.dmg',
  'Rundock-0.11.7-universal.dmg.blockmap',
  'Rundock-0.11.7.exe',
  'Rundock-Setup-0.11.7.exe',
  'Rundock-Setup-0.11.7.exe.blockmap',
];

const NAME = '0.11.7: Foundations & File Tree Stability';
const NOTES = '### Fixed\n\n- **The file tree stopped losing its place:** it no longer collapses on refresh.\n';

function assets(names = PUBLISHED_0_11_7_ASSET_NAMES) {
  return names.map((name) => ({ name, state: 'uploaded', size: 1024 }));
}

function release(overrides = {}) {
  return {
    id: 1001,
    tag_name: 'v0.11.7',
    name: NAME,
    body: NOTES,
    draft: true,
    assets: assets(),
    ...overrides,
  };
}

function verify(releases, tag = 'v0.11.7') {
  return verifyReleaseDraft({ releases, tag, expectedName: NAME + '\n', expectedNotes: NOTES });
}

describe('expectedAssets', () => {
  test('expects exactly the nine assets a real release carries', () => {
    assert.deepStrictEqual(
      allExpectedAssets('0.11.7').slice().sort(),
      PUBLISHED_0_11_7_ASSET_NAMES.slice().sort()
    );
  });

  test('splits them by the job that produces them', () => {
    const groups = expectedAssets('0.11.7');
    assert.strictEqual(groups.macOS.length, 5);
    assert.strictEqual(groups.Windows.length, 4);
    assert.ok(groups.macOS.includes('Rundock-0.11.7-universal.dmg'));
    assert.ok(groups.Windows.includes('Rundock-Setup-0.11.7.exe'));
  });
});

describe('a draft that is what the tag should have produced', () => {
  test('passes with no failures and no warnings', () => {
    const result = verify([release()]);
    assert.deepStrictEqual(result.failures, []);
    assert.deepStrictEqual(result.warnings, []);
    assert.strictEqual(result.matchedBy, 'tag');
  });

  test('reports the artefact count it verified', () => {
    const result = verify([release()]);
    assert.deepStrictEqual(result.assets, { total: 9, expected: 9, present: 9 });
  });

  test('is found among other releases rather than by position', () => {
    const older = release({ id: 900, tag_name: 'v0.11.6', draft: false, assets: [] });
    const result = verify([older, release()]);
    assert.deepStrictEqual(result.failures, []);
    assert.strictEqual(result.release.id, 1001);
  });
});

describe('the 0.11.7 tag reset', () => {
  // The real one. Name, notes and all nine artefacts correct; tag_name reset
  // to the placeholder the API handed back.
  const resetDraft = release({ tag_name: 'untagged-084fdf02808ef05fdba4' });

  test('is rejected', () => {
    const result = verify([resetDraft]);
    assert.strictEqual(result.failures.length, 1);
  });

  test('the failure names the tag it has and the tag it should have', () => {
    const [failure] = verify([resetDraft]).failures;
    assert.match(failure, /untagged-084fdf02808ef05fdba4/);
    assert.match(failure, /v0\.11\.7/);
  });

  test('nothing else about the draft is flagged, which is why it passed by eye', () => {
    // Every other assertion holds. Anything looking at name, notes or
    // artefacts alone would have called this draft ready to publish.
    const result = verify([resetDraft]);
    assert.strictEqual(result.matchedBy, 'assets');
    assert.deepStrictEqual(result.assets, { total: 9, expected: 9, present: 9 });
  });

  test('a tag reset by a later edit is caught the same way', () => {
    // The binding drops on any edit that omits tag_name, including a rename
    // in the GitHub interface, so the value differs from run to run.
    const result = verify([release({ tag_name: 'untagged-9f2c1de4a7b30516' })]);
    assert.strictEqual(result.failures.length, 1);
    assert.match(result.failures[0], /untagged-9f2c1de4a7b30516/);
  });

  test('a draft bound to a different real tag is caught too', () => {
    const result = verify([release({ tag_name: 'v0.11.6' })]);
    assert.strictEqual(result.failures.length, 1);
    assert.match(result.failures[0], /v0\.11\.6/);
  });
});

describe('locating the release', () => {
  test('an empty release list fails rather than passing vacuously', () => {
    const result = verify([]);
    assert.strictEqual(result.release, null);
    assert.strictEqual(result.failures.length, 1);
    assert.match(result.failures[0], /No release carries the tag v0\.11\.7/);
  });

  test('a release with no artefacts at all fails', () => {
    const result = verify([release({ tag_name: 'untagged-abc123', assets: [] })]);
    assert.match(result.failures[0], /no release carries any 0\.11\.7 artefact/);
  });

  test('two releases on the same tag fail rather than one being picked', () => {
    const result = verify([release(), release({ id: 1002 })]);
    assert.strictEqual(result.release, null);
    assert.match(result.failures[0], /2 releases carry the tag v0\.11\.7/);
  });

  test('artefacts split across two untagged releases fail', () => {
    const macOnly = release({ id: 1, tag_name: 'untagged-aaa', assets: assets(expectedAssets('0.11.7').macOS) });
    const winOnly = release({ id: 2, tag_name: 'untagged-bbb', assets: assets(expectedAssets('0.11.7').Windows) });
    const result = verify([macOnly, winOnly]);
    assert.strictEqual(result.release, null);
    assert.match(result.failures[0], /2 releases carry 0\.11\.7 artefacts/);
  });

  test('findReleaseForTag prefers the tag over the artefacts', () => {
    const tagged = release({ id: 7 });
    const orphan = release({ id: 8, tag_name: 'untagged-ccc' });
    assert.strictEqual(findReleaseForTag([orphan, tagged], 'v0.11.7').release.id, 7);
  });
});

describe('artefacts', () => {
  test('a silently broken Windows build fails, naming what is missing', () => {
    const macOnly = release({ assets: assets(expectedAssets('0.11.7').macOS) });
    const result = verify([macOnly]);
    assert.strictEqual(result.failures.length, 1);
    assert.match(result.failures[0], /Windows artefacts missing/);
    assert.match(result.failures[0], /Rundock-Setup-0\.11\.7\.exe/);
    assert.match(result.failures[0], /latest\.yml/);
  });

  test('a missing update feed fails even when the installers are all there', () => {
    const noFeed = PUBLISHED_0_11_7_ASSET_NAMES.filter((name) => name !== 'latest-mac.yml');
    const result = verify([release({ assets: assets(noFeed) })]);
    assert.match(result.failures[0], /macOS artefacts missing from the draft, 4 of 5 present/);
  });

  test('an upload that never finished fails', () => {
    const partial = assets();
    partial[4].state = 'starting';
    const result = verify([release({ assets: partial })]);
    assert.match(result.failures[0], /Rundock-0\.11\.7-universal\.dmg is in state "starting"/);
  });

  test('a zero-byte artefact fails', () => {
    const empty = assets();
    empty[4].size = 0;
    const result = verify([release({ assets: empty })]);
    assert.match(result.failures[0], /Rundock-0\.11\.7-universal\.dmg is 0 bytes/);
  });

  test('an artefact left over from another version fails', () => {
    const stale = assets().concat(assets(['Rundock-0.11.6-universal.dmg']));
    const result = verify([release({ assets: stale })]);
    assert.strictEqual(result.failures.length, 1);
    assert.match(result.failures[0], /unexpected artefact: Rundock-0\.11\.6-universal\.dmg/);
  });

  test('an unrelated file attached to the draft warns rather than failing', () => {
    // Someone attaching a supplementary file to a draft is not a broken
    // release, but it should not go unmentioned either.
    const extra = assets().concat(assets(['checksums.txt']));
    const result = verify([release({ assets: extra })]);
    assert.deepStrictEqual(result.failures, []);
    assert.strictEqual(result.warnings.length, 1);
    assert.match(result.warnings[0], /checksums\.txt/);
  });
});

describe('name and notes', () => {
  test('a name that is not the changelog heading fails, quoting both', () => {
    const result = verify([release({ name: '0.11.7' })]);
    assert.strictEqual(result.failures.length, 1);
    assert.match(result.failures[0], /named "0\.11\.7", expected the changelog heading "0\.11\.7: Foundations & File Tree Stability"/);
  });

  test('an unnamed draft fails', () => {
    const result = verify([release({ name: '' })]);
    assert.match(result.failures[0], /has no name/);
  });

  test('the trailing newline release-name.txt carries is not a mismatch', () => {
    const result = verifyReleaseDraft({
      releases: [release()],
      tag: 'v0.11.7',
      expectedName: NAME + '\n',
      expectedNotes: NOTES + '\n\n',
    });
    assert.deepStrictEqual(result.failures, []);
  });

  test('notes that survived a Windows runner are not a mismatch', () => {
    const result = verifyReleaseDraft({
      releases: [release({ body: NOTES.replace(/\n/g, '\r\n') })],
      tag: 'v0.11.7',
      expectedName: NAME,
      expectedNotes: NOTES,
    });
    assert.deepStrictEqual(result.failures, []);
  });

  test('a blank body fails: a draft with blank notes must never be published', () => {
    const result = verify([release({ body: '' })]);
    assert.strictEqual(result.failures.length, 1);
    assert.match(result.failures[0], /body is empty/);
  });

  test('a null body fails rather than reading as a match', () => {
    const result = verify([release({ body: null })]);
    assert.match(result.failures[0], /body is empty/);
  });

  test('notes replaced by a later edit fail', () => {
    const result = verify([release({ body: 'Notes to follow.' })]);
    assert.strictEqual(result.failures.length, 1);
    assert.match(result.failures[0], /body does not match the changelog notes for 0\.11\.7/);
  });

  test('an empty expected name fails rather than verifying nothing', () => {
    // release-name.txt coming back empty would otherwise make the name check
    // pass against an equally empty draft name.
    const result = verifyReleaseDraft({
      releases: [release({ name: '' })],
      tag: 'v0.11.7',
      expectedName: '',
      expectedNotes: NOTES,
    });
    assert.match(result.failures[0], /No expected release name was supplied/);
  });

  test('empty expected notes fail rather than verifying nothing', () => {
    const result = verifyReleaseDraft({
      releases: [release({ body: '' })],
      tag: 'v0.11.7',
      expectedName: NAME,
      expectedNotes: '   \n',
    });
    assert.match(result.failures[0], /No expected release notes were supplied/);
  });
});

describe('reporting', () => {
  test('every problem is reported, not just the first', () => {
    const broken = release({
      tag_name: 'untagged-084fdf02808ef05fdba4',
      name: 'Untitled',
      body: '',
      assets: assets(expectedAssets('0.11.7').macOS),
    });
    const result = verify([broken]);
    assert.strictEqual(result.failures.length, 4);
    assert.match(result.failures.join('\n'), /untagged-084fdf02808ef05fdba4/);
    assert.match(result.failures.join('\n'), /Windows artefacts missing/);
    assert.match(result.failures.join('\n'), /named "Untitled"/);
    assert.match(result.failures.join('\n'), /body is empty/);
  });
});
