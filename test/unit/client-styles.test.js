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

describe('the client fetches nothing from the internet', () => {
  // Rundock is local-first and runs from source on someone else's machine. A
  // resource loaded from a third party is a request on every launch, a
  // different result offline, and a record of the launch at whoever serves it.
  //
  // Two shipped that way until 0.11.7, and both failed silently in their own
  // manner. The typeface fell back to San Francisco or Segoe, so the app's
  // typography was non-deterministic across machines and nobody noticed. The
  // org chart's layout library did not fall back at all: views/team.js calls
  // d3.hierarchy() unguarded, so the team view threw outright with no internet.
  //
  // No allowlist. There is nothing to except, and an empty rule is the only one
  // that cannot be argued with later.

  test('index.html loads no resource from another origin', () => {
    const urls = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(m => m[1]);
    assert.deepStrictEqual(
      urls, [],
      'vendor it under public/vendor/ with its licence and a provenance note instead',
    );
  });

  test('no stylesheet fetches from another origin either', () => {
    // @font-face src and any url() would bypass the check above entirely.
    for (const href of sheets) {
      const css = fs.readFileSync(path.join(root, 'public', href.replace(/^\//, '')), 'utf-8');
      for (const m of css.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)) {
        assert.ok(
          !/^https?:/.test(m[1]),
          `${href} fetches ${m[1]} from another origin`,
        );
      }
      assert.ok(!/@import\s+url\(['"]?https?:/.test(css), `${href} imports from another origin`);
    }
  });

  test('every vendored third party ships its licence and its provenance', () => {
    // The rule that keeps vendoring honest: a copied file with no record of
    // where it came from cannot be verified or updated by anyone else.
    const vendor = path.join(root, 'public', 'vendor');
    for (const dir of ['fonts', 'd3-hierarchy']) {
      const d = path.join(vendor, dir);
      const files = fs.readdirSync(d);
      assert.ok(files.some(f => /LICENSE/i.test(f)), `public/vendor/${dir} must ship its licence`);
      assert.ok(files.includes('README.md'), `public/vendor/${dir} must record where the files came from`);
      const readme = fs.readFileSync(path.join(d, 'README.md'), 'utf-8');
      assert.match(readme, /Upstream/, `public/vendor/${dir}/README.md must name the upstream`);
      assert.match(readme, /[0-9a-f]{40}|sha512|SHA-512|SHA-1/i, `public/vendor/${dir}/README.md must record a verifiable hash`);
    }
  });

  test('the typeface is served from this repo, with its licence', () => {
    const fonts = path.join(root, 'public', 'vendor', 'fonts');
    for (const f of ['InterVariable.woff2', 'InterVariable-Italic.woff2', 'Inter-LICENSE.txt']) {
      assert.ok(fs.existsSync(path.join(fonts, f)), `public/vendor/fonts/${f} must ship`);
    }
    // The OFL permits redistribution only if the licence travels with the font.
    const licence = fs.readFileSync(path.join(fonts, 'Inter-LICENSE.txt'), 'utf-8');
    assert.match(licence, /SIL Open Font License/, 'the licence file must be the real one');

    const css = fs.readFileSync(path.join(root, 'public', 'styles', 'fonts.css'), 'utf-8');
    for (const m of css.matchAll(/url\('([^']+)'\)/g)) {
      assert.match(m[1], /^\//, 'font sources must be local paths');
      assert.ok(fs.existsSync(path.join(root, 'public', m[1].replace(/^\//, ''))), `${m[1]} is referenced but missing`);
    }
  });
});
