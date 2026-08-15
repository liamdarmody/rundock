'use strict';
// The design standard has to keep describing the tokens that actually exist.
//
// docs/DESIGN.md tells a contributor which token to reach for. That is only
// useful while it is complete: a token added to tokens.css and never written
// down is invisible to everyone who learns the system from the document, and a
// token described in the document but deleted from the stylesheets sends people
// looking for something that is not there.
//
// Both drift silently, because nothing about editing a stylesheet reminds you
// that a markdown file exists. The completeness of this document was checked by
// hand once, which is worth exactly as much as any other measurement taken once
// and then asserted in prose. This checks it on every run instead.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const TOKENS = path.join(ROOT, 'public', 'styles', 'tokens.css');
const DOC = path.join(ROOT, 'docs', 'DESIGN.md');

// Names the document uses as examples of what NOT to do. They are meant not to
// exist, so finding them in the stylesheets would be the surprise.
const ILLUSTRATIVE = new Set(['--grey-4']);

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ');

describe('the design standard describes the tokens that exist', () => {
  const declared = new Set(
    [...stripComments(fs.readFileSync(TOKENS, 'utf-8')).matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]),
  );
  const docText = fs.readFileSync(DOC, 'utf-8');

  // A token counts as documented only when it sits in a table row whose LAST
  // cell says something. Counting a bare mention was the first version, and it
  // proved something weaker than the rule it stands for: a token dropped into
  // a code sample or a cross-reference, with nothing saying what it is for,
  // would have satisfied it. The point of the document is that a contributor
  // can choose a token, and a name with no purpose beside it does not help
  // anyone choose.
  const documented = new Set();
  for (const line of docText.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map(c => c.trim()).filter((c, i, a) => i > 0 && i < a.length - 1);
    if (cells.length < 2) continue;
    const purpose = cells[cells.length - 1];
    if (!purpose || /^-+$/.test(purpose)) continue;      // separator row, or an empty cell
    const named = cells[0].match(/^`(--[\w-]+)`$/);
    if (named) documented.add(named[1]);
  }

  // Every name the document mentions at all, used only to catch the reverse
  // error: describing something that no longer exists.
  const mentioned = new Set([...docText.matchAll(/`(--[\w-]+)`/g)].map(m => m[1]));

  test('every token in tokens.css is named in the document', () => {
    const undocumented = [...declared].filter(t => !documented.has(t)).sort();
    assert.deepStrictEqual(
      undocumented, [],
      `declared in tokens.css but not given a purpose in docs/DESIGN.md: ${undocumented.join(', ')}`,
    );
  });

  test('every token the document names still exists', () => {
    const phantom = [...mentioned].filter(t => !declared.has(t) && !ILLUSTRATIVE.has(t)).sort();
    assert.deepStrictEqual(
      phantom, [],
      `described in docs/DESIGN.md but not declared in tokens.css: ${phantom.join(', ')}`,
    );
  });

  test('both sides of the comparison actually found something', () => {
    // Guard the guard. A parse that silently returned nothing would make both
    // assertions above pass while comparing two empty sets, which is the
    // failure mode this whole document exists to argue against.
    assert.ok(declared.size > 30, `only ${declared.size} tokens parsed from tokens.css`);
    assert.ok(documented.size > 30, `only ${documented.size} tokens documented with a purpose in DESIGN.md`);
    assert.ok(mentioned.size >= documented.size, 'every documented token is also a mentioned one');
  });
});
