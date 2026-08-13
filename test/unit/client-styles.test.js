'use strict';
// The shape of the client's styling, pinned.
//
// index.html carried a single 1,125-line <style> block until 0.11.7. It is now
// linked stylesheets under public/styles/, and these assertions stop it drifting
// back: styling in the HTML is invisible to the drift lint, cannot be cached
// separately, and grows without anyone reviewing a stylesheet.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf-8');
const sheets = [...html.matchAll(/<link[^>]+href="(\/styles\/[^"]+\.css)"/g)].map(m => m[1]);

describe('client styling lives in stylesheets', () => {
  test('index.html contains no <style> block', () => {
    assert.strictEqual(
      /<style[\s>]/.test(html), false,
      'styling belongs in public/styles/, not in index.html',
    );
  });

  test('the token sheet is linked before every other stylesheet', () => {
    // Everything downstream resolves var(--x) against tokens.css. A sheet
    // linked ahead of it would resolve its tokens to nothing, and the failure
    // is a silently unstyled region rather than an error.
    assert.ok(sheets.length >= 2, `sanity: found ${sheets.length} stylesheets`);
    assert.strictEqual(sheets[0], '/styles/tokens.css', 'tokens.css must be first');
  });

  test('every linked stylesheet exists and parses its comments cleanly', () => {
    for (const href of sheets) {
      const file = path.join(root, 'public', href.replace(/^\//, ''));
      assert.ok(fs.existsSync(file), `${href} is linked but missing`);
      const css = fs.readFileSync(file, 'utf-8');

      // An unbalanced comment is the specific way a stylesheet fails silently:
      // an unclosed /* swallows the rest of the file, and an orphan */ is
      // consumed as part of the next selector, dropping that rule. The split
      // that created these files shipped four of both before a computed-style
      // snapshot caught it, so the class is pinned here.
      let depth = 0;
      for (let i = 0; i < css.length; i++) {
        if (css.startsWith('/*', i)) { depth++; i++; }
        else if (css.startsWith('*/', i)) { depth--; i++; }
        assert.ok(depth === 0 || depth === 1, `${href} has nested or stray comment delimiters`);
      }
      assert.strictEqual(depth, 0, `${href} ends inside an unclosed comment`);
    }
  });
});
