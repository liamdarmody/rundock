// Tests for release-notes extraction (scripts/release.js and
// scripts/release-notes.js).
//
// The tag build publishes a draft GitHub release, and until now that draft
// arrived with no title and no notes: they were retyped by hand from
// CHANGELOG.md at publish time, or forgotten. These tests pin the extraction
// that feeds the draft automatically.
//
// The failure mode that matters most: a version with no changelog entry must
// be an ERROR, never an empty release published with blank notes.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { extractChangelogEntry } = require('../../scripts/release.js');
const { buildReleaseInfo } = require('../../scripts/release-notes.js');

const CHANGELOG = `# Changelog

Header prose.

## Unreleased

**Name:** Something In Flight

### Fixed

- An unreleased fix.

## 0.11.4: Window Chrome & Search (2026-08-05)

### Added

- **Window controls inside the app.**

---

## 0.11.3: Long Sessions & Large Workspaces (2026-08-03)

### Fixed

- A fix.
`;

describe('extractChangelogEntry', () => {
  test('finds a versioned entry and returns its heading and body', () => {
    const entry = extractChangelogEntry('0.11.4', CHANGELOG);
    assert.strictEqual(entry.title, '0.11.4: Window Chrome & Search (2026-08-05)');
    assert.ok(entry.body.includes('Window controls inside the app'));
  });

  test('the body stops at the next version heading', () => {
    const entry = extractChangelogEntry('0.11.4', CHANGELOG);
    assert.ok(!entry.body.includes('Long Sessions'));
    assert.ok(!entry.body.includes('unreleased fix'));
  });

  test('horizontal rules are stripped from the body', () => {
    const entry = extractChangelogEntry('0.11.4', CHANGELOG);
    assert.ok(!/^---\s*$/m.test(entry.body));
  });

  test('finds the Unreleased block by its exact heading', () => {
    const entry = extractChangelogEntry('Unreleased', CHANGELOG);
    assert.strictEqual(entry.title, 'Unreleased');
    assert.ok(entry.body.includes('An unreleased fix'));
  });

  test('a version with no entry returns null', () => {
    assert.strictEqual(extractChangelogEntry('9.9.9', CHANGELOG), null);
  });
});

describe('buildReleaseInfo', () => {
  test('the release name is the heading without the date suffix', () => {
    // Matches the naming of every published release to date, which until now
    // was retyped by hand: "0.11.4: Window Chrome & Search".
    const info = buildReleaseInfo('0.11.4', CHANGELOG);
    assert.strictEqual(info.name, '0.11.4: Window Chrome & Search');
  });

  test('the notes are the entry body', () => {
    const info = buildReleaseInfo('0.11.4', CHANGELOG);
    assert.ok(info.notes.includes('Window controls inside the app'));
  });

  test('a heading without a date is used as-is', () => {
    const log = '## 0.12.0: No Date Yet\n\n- A change.\n';
    const info = buildReleaseInfo('0.12.0', log);
    assert.strictEqual(info.name, '0.12.0: No Date Yet');
  });

  test('a missing entry throws rather than producing an empty release', () => {
    assert.throws(() => buildReleaseInfo('9.9.9', CHANGELOG), /9\.9\.9/);
  });

  test('an empty body throws rather than producing an empty release', () => {
    const log = '## 0.12.0: Hollow (2026-01-01)\n\n## 0.11.9: Previous (2025-12-01)\n\n- x\n';
    assert.throws(() => buildReleaseInfo('0.12.0', log), /empty/i);
  });
});
