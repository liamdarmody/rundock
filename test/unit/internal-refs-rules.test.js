'use strict';
// The planning-language rules of scripts/check-internal-refs.js that name no
// one: criteria ids, process lanes, numbered review iterations, owner phrasing, private
// workspace furniture. Specimens are assembled at run time, because the check
// reads this file too.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { scanLines, SKIP } = require('../../scripts/check-internal-refs.js');
const { loadDenylist, scanPrivate } = require('../../scripts/private-denylist.js');

const j = (...parts) => parts.join('');
const hit = (text, file = 'lib/x.js') => scanLines(file, text).map((f) => f.label);

describe('generic planning rules', () => {
  const MUST = [
    ['criteria id', `covers ${j('NS', '-3')} and ${j('AA', '-16')}`],
    ['criteria id', `see ${j('RU', '-31')}a`],
    ['process lane', `built in ${j('this', ' lane')}`],
    ['process lane', `closed ${j('the confinement', ' lane')}`],
    ['process lane', `${j('this', ' lane', "'s")} paths`],
    ['numbered review', `found by ${j('rev', 'iew', ' ro', 'und')} 4`],
    ['numbered review', `${j('Ro', 'und', ' 2')} rejected it`],
    ['owner', `verified by ${j('the', ' owner')} in a window`],
    ['owner', `is ${j('the', ' owner', "'s")} call`],
    ['personal workspace', `automations for ${j('Personal', ' OS')}`],
    ['personal workspace', `[[${j('_Daily', ' Notes')}/2026-03-31.md]]`],
    ['named person', `${j('You are Dev, ', 'Zed', "'s")} Lead Developer`],
    ['named person', `### ${j('Zed', "'s setup")}`],
    ['named person', `protects ${j('Zed', "'s time")}`],
  ];
  for (const [what, text] of MUST) {
    test(`${what}: flagged`, () => assert.ok(hit(text).length > 0, text));
  }

  const PASS = [
    'UTF-8 and SHA-256 and ISO-8601 stay',
    'the board lane menu, a lane title, bad lane index, inside a lane, the lane, not my lane',
    'lanes: [{ title }]',
    `${j('review', ' round')}-trip of the markup`,
    'the owner/repo@ref shorthand',
    "Claude Code's own transcripts and Rundock's time budget",
    'the user owns the file',
  ];
  for (const text of PASS) {
    test(`passes: ${text}`, () => assert.deepStrictEqual(hit(text), []));
  }

  test('an acceptance-criteria label is still reported once, by its own rule', () => {
    assert.strictEqual(hit(`see ${j('AC', '-3')}`).length, 1);
  });
});

describe('scope and self-reference', () => {
  test('public/vendor is no longer skipped', () => {
    assert.ok(!SKIP.some((re) => re.test('public/vendor/build-entry.js')));
    assert.ok(hit(j('02', '_Areas/x.md'), 'public/vendor/build-entry.js').length > 0);
  });
  test('third-party vendor bundles stay exempt from the dash style rule only', () => {
    assert.deepStrictEqual(hit('a \u2014 b', 'public/vendor/tiptap-bundle.mjs'), []);
    assert.ok(hit('a \u2014 b', 'public/vendor/build-entry.js').length > 0);
  });
  // The private names cannot be written here either, so this reads them from
  // the private denylist, where one is configured, and is skipped otherwise.
  const list = loadDenylist();
  test('the checker names nothing on the private denylist', { skip: list.status !== 'loaded' && 'no private denylist configured' }, () => {
    const src = fs.readFileSync(require.resolve('../../scripts/check-internal-refs.js'), 'utf8');
    assert.deepStrictEqual(scanPrivate('scripts/check-internal-refs.js', src, list.entries).map((f) => `${f.line} ${f.label}`), []);
  });
});
