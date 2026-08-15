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
  // Anything written as `--name` in the document counts as named. The document
  // is prose as well as tables, and a token explained in a paragraph is just as
  // documented as one in a row.
  const documented = new Set(
    [...fs.readFileSync(DOC, 'utf-8').matchAll(/`(--[\w-]+)`/g)].map(m => m[1]),
  );

  test('every token in tokens.css is named in the document', () => {
    const undocumented = [...declared].filter(t => !documented.has(t)).sort();
    assert.deepStrictEqual(
      undocumented, [],
      `declared in tokens.css but absent from docs/DESIGN.md: ${undocumented.join(', ')}`,
    );
  });

  test('every token the document names still exists', () => {
    const phantom = [...documented].filter(t => !declared.has(t) && !ILLUSTRATIVE.has(t)).sort();
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
    assert.ok(documented.size > 30, `only ${documented.size} tokens found in DESIGN.md`);
  });
});
