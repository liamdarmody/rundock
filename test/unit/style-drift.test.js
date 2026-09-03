'use strict';
// The drift lint's own logic.
//
// A lint that over-reports is worse than none: people learn to add allowlist
// entries without reading them, and the allowlist stops meaning anything. The
// cases below are the ones where this lint nearly did exactly that.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { findings, surfaces } = require('../tools/style-drift.js');

const ROOT = path.join(__dirname, '..', '..');
const ALLOW = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/tools/style-drift-allowlist.json'), 'utf-8'));

// findings() reads relative to the repo root, so a fixture has to live in it.
function withFixture(contents, fn) {
  const rel = `public/styles/__drift-fixture.css`;
  const abs = path.join(ROOT, rel);
  fs.writeFileSync(abs, contents);
  try { return fn(rel); } finally { fs.unlinkSync(abs); }
}

describe('style drift detection', () => {
  test('an HTML numeric character reference is not a colour', () => {
    // &#8593; is an up arrow. Its digits are all valid hex and it is four of
    // them, so nothing about the shape distinguishes it from #8593: only the
    // ampersand does. index.html and three view modules are full of these, and
    // the first version of this lint reported every arrow glyph in the app as
    // colour drift.
    const found = withFixture('.a::after { content: "&#8593;&#8595;&#9166;"; }', findings);
    assert.deepStrictEqual(found.filter(f => f.kind === 'colour'), []);
  });

  test('a real hex colour is still caught beside an entity', () => {
    const found = withFixture('.a { color: #BADA55; } .b::after { content: "&#8593;"; }', findings);
    assert.deepStrictEqual(found.filter(f => f.kind === 'colour').map(f => f.literal), ['#BADA55']);
  });

  test('a colour function is recorded as its whole value, not a prefix', () => {
    const found = withFixture('.a { background: rgba(1, 2, 3, 0.4); }', findings);
    const c = found.filter(f => f.kind === 'colour');
    assert.deepStrictEqual(c.map(f => f.literal), ['rgba(1,2,3,0.4)']);
  });

  test('a token reference is not drift', () => {
    const found = withFixture(
      '.a { color: var(--accent); border-radius: var(--radius-lg); transition: color var(--duration-base) ease; }',
      findings,
    );
    assert.deepStrictEqual(found, []);
  });

  test('durations only count inside a transition or animation', () => {
    // A duration is only a duration in context. `grid-auto-columns: 2s` is not
    // a thing, but neither is every bare number a timing value, and flagging
    // them everywhere would bury the real ones.
    const found = withFixture(
      '.a { transition: opacity 0.3s ease; } .b { animation: spin 2s linear; } .c { content: "5s"; }',
      findings,
    );
    assert.deepStrictEqual(found.filter(f => f.kind === 'duration').map(f => f.literal).sort(), ['0.3s', '2s']);
  });

  test('a multi-value border-radius reports every literal in it', () => {
    const found = withFixture('.a { border-radius: 8px 8px 0 0; }', findings);
    assert.deepStrictEqual(found.filter(f => f.kind === 'radius').map(f => f.literal), ['8px', '8px']);
  });

  test('tokens.css and vendor are never scanned', () => {
    const list = surfaces();
    assert.ok(!list.some(f => f.endsWith('tokens.css')), 'tokens.css defines the literals; it cannot be drift');
    assert.ok(!list.some(f => f.includes('/vendor/')), 'vendored third-party code is not ours to tidy');
    assert.ok(list.includes('public/editor/styles.js'), 'the editor injects CSS from JS and must be scanned');
    assert.ok(list.includes('public/index.html'), 'index.html must be scanned even though its styling moved out');
  });
});

describe('the drift allowlist is a document, not a dump', () => {
  test('every file entry gives a reason of substance', () => {
    for (const [file, entry] of Object.entries(ALLOW)) {
      assert.ok(entry.why, `${file} has no reason`);
      assert.ok(
        entry.why.length > 80,
        `${file}'s reason is too short to be one: an allowlist whose reasons are "legacy" teaches people to skip reading it`,
      );
      assert.ok(!/^TODO/.test(entry.why), `${file} still has the generated placeholder reason`);
    }
  });

  test('every allowed literal has a positive count', () => {
    for (const [file, entry] of Object.entries(ALLOW)) {
      assert.ok(Object.keys(entry.allow).length > 0, `${file} allows nothing and should be removed`);
      for (const [lit, n] of Object.entries(entry.allow)) {
        assert.ok(Number.isInteger(n) && n > 0, `${file}: ${lit} has a non-count of ${n}`);
      }
    }
  });

  test('each allowlisted file still exists and is still scanned', () => {
    const list = new Set(surfaces());
    for (const file of Object.keys(ALLOW)) {
      assert.ok(list.has(file), `${file} is allowlisted but no longer scanned; remove its entry`);
    }
  });
});

describe('an allowlist reason describes only what it still allows', () => {
  // A reason that names a literal the entry no longer carries is worse than no
  // reason: it reads as an unpaid debt and hides that the debt was settled.
  // Five entries drifted that way in one slice, all of them missed by me and
  // caught in review, which is why this is now mechanical.
  const LITERAL = /#[0-9a-fA-F]{3,8}\b|\b\d+px\b|\b\d*\.?\d+m?s\b/g;

  test('no reason names a literal that is not in its allow list', () => {
    // A prohibition over extracted literals passes vacuously when the pattern
    // goes blind, so it proves it still bites before the empty result counts.
    LITERAL.lastIndex = 0;
    assert.deepStrictEqual('a #fff wash over 200ms at 4px'.match(LITERAL), ['#fff', '200ms', '4px'],
      'the literal pattern no longer matches its own specimen');
    const stale = [];
    for (const [file, entry] of Object.entries(ALLOW)) {
      for (const lit of entry.why.match(LITERAL) || []) {
        if (!(lit in entry.allow)) stale.push(`${file}: reason names ${lit}, which it no longer allows`);
      }
    }
    assert.deepStrictEqual(
      stale, [],
      'describe what is there, or say it in words rather than naming a value that has gone',
    );
  });
});

describe('a literal written in a comment is not drift', () => {
  // Counting comments had a property worth naming: explaining a value raised
  // its own allowance, so documenting drift created room for more drift. That
  // is the inverse of the point, and it shipped: a comment reading "#1a1a1a is
  // dark text on a bright fill" pushed that file's allowance from one to two.
  const { stripComments } = require('../tools/style-drift.js');

  test('a css block comment contributes no literals', () => {
    const found = withFixture('/* #BADA55 and 7px and 2s */\n.a { color: var(--accent); }', findings);
    assert.deepStrictEqual(found, []);
  });

  test('the declaration beside the comment is still caught', () => {
    const found = withFixture('/* explaining #BADA55 */\n.a { color: #BADA55; }', findings);
    assert.deepStrictEqual(found.map(f => f.literal), ['#BADA55']);
  });

  test('stripping preserves line numbers so a report still points at the right line', () => {
    const src = '/* a\n b\n c */\n.a { color: #BADA55; }';
    assert.strictEqual(stripComments(src).split('\n').length, src.split('\n').length);
    const found = withFixture(src, findings);
    assert.strictEqual(found[0].line, 4);
  });

  test('a url is not mistaken for a line comment', () => {
    // The // stripper must not eat the rest of a line containing https://.
    const found = withFixture('.a { background: url(https://x/y.png); border-radius: 7px; }', findings);
    assert.deepStrictEqual(found.map(f => f.literal), ['7px']);
  });
});
