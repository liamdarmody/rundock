'use strict';
// The innerHTML inventory, checked against the tree rather than against itself.
//
// WHY THIS FILE EXISTS
//
// `docs/evidence/innerhtml-audit-evidence.md` makes one claim a document cannot
// keep on its own: that every innerHTML assignment in public/ was looked at.
// That claim was true of the renderer-hardening work too, and its header
// comment now names a figure (86) that the same command measures as 91,
// because six assignments were added afterwards and nothing objected.
//
// So the inventory is discovered by walking the tree and the classification is
// matched against what was found, in both directions. Adding an innerHTML
// assignment to public/ turns this red until somebody classifies it. Deleting
// one turns it red until somebody removes the entry. Neither is a nuisance:
// they are the two ways an audit quietly stops being an audit.
//
// The totals are asserted as numbers as well, because the audit quotes them
// and a quoted number that nothing checks is a number that drifts.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { findSites, classify, totals } = require('../tools/innerhtml-sites.js');

const ROOT = path.join(__dirname, '..', '..');
const AUDIT = path.join(ROOT, 'docs', 'evidence', 'innerhtml-audit-evidence.md');

describe('the innerHTML inventory', () => {
  test('every assignment in public/ is classified', () => {
    const { unclassified } = classify();
    assert.deepStrictEqual(
      unclassified.map((s) => `${s.file}[${s.index}] line ${s.line}`), [],
      'an innerHTML assignment exists that the classification table says nothing about. '
      + 'Read docs/evidence/innerhtml-audit-evidence.md, answer the two questions it sets, '
      + 'and add an entry to TABLE in test/tools/innerhtml-sites.js');
  });

  test('the table classifies nothing that has gone', () => {
    const { orphaned } = classify();
    assert.deepStrictEqual(orphaned, [],
      'the classification table has entries for assignments that no longer exist');
  });

  test('the counts the audit quotes are the counts the tree has', () => {
    const t = totals(classify().rows);
    assert.strictEqual(t.total, 108, 'first-party assignments under public/');
    assert.strictEqual(t.byGroup.a, 78, 'group (a): closed with a stated reason');
    assert.strictEqual(t.byGroup.b, 30, 'group (b): fixed');
    assert.strictEqual(t.byGroup.a + t.byGroup.b, t.total, 'every site is in exactly one group');
  });

  test('the vendor bundles are excluded by name, not by having been missed', () => {
    const vendor = findSites().filter((s) => s.vendor);
    assert.strictEqual(vendor.length, 7,
      'the pre-built third-party bundles under public/vendor/ carry 7 assignments; '
      + 'they are out of scope because this repository does not author them, and the '
      + 'count is pinned so a new vendored bundle is noticed rather than absorbed');
    const files = [...new Set(vendor.map((s) => s.file))].sort();
    assert.deepStrictEqual(files, ['vendor/highlight/highlight.min.js', 'vendor/tiptap-bundle.mjs']);
  });

  test('there are no += forms, which is what makes an occurrence count complete', () => {
    // The counter matches `=` and `+=` alike. If a `+=` ever appears it is
    // counted, but it also means markup is being APPENDED to markup already in
    // the page, which is a different hazard from building a string and
    // assigning it, and the audit does not cover it.
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(js|mjs|html)$/.test(entry.name)) continue;
        if (full.includes(`${path.sep}vendor${path.sep}`)) continue;
        if (/\.innerHTML\s*\+=/.test(fs.readFileSync(full, 'utf8'))) {
          offenders.push(path.relative(ROOT, full));
        }
      }
    };
    walk(path.join(ROOT, 'public'));
    assert.deepStrictEqual(offenders, [],
      'markup is being appended to markup already in the page; the audit covers assignment only');
  });

  test('the audit file exists and names the tool that regenerates it', () => {
    // A review file that cannot be reproduced is a claim. This one says how.
    const src = fs.readFileSync(AUDIT, 'utf-8');
    assert.match(src, /node test\/tools\/innerhtml-sites\.js/,
      'the audit should name the command that regenerates its inventory');
    assert.match(src, /test\/unit\/innerhtml-inventory\.test\.js/,
      'the audit should name the test that keeps it honest');
  });
});
