'use strict';
// Every custom property that gets used has to be declared somewhere.
//
// `color: var(--text-3)` with no `--text-3` behind it and no fallback is
// invalid at computed-value time. CSS does not fall back to the property's
// initial value; it inherits. So the declaration does nothing and the element
// silently takes the colour around it. Nothing errors, nothing logs, and the
// only symptom is that a surface looks slightly wrong to someone who knows
// what it was meant to look like.
//
// That happened here for three releases: nine declarations referenced
// --text-3 and it was declared nowhere. The style drift lint could not catch
// it, because that looks for hardcoded values, which is the opposite mistake.
//
// This checks the rule in the direction nothing else does: a reference with
// nothing behind it.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', '..', 'public');

// Third-party bundles bring their own conventions and are not ours to police.
const SKIP = ['vendor', 'node_modules'];

function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(css|js|html)$/.test(entry.name)) out.push(full);
    }
  };
  walk(PUBLIC);
  return out;
}

// Comments are not code. An earlier version of this counted `var(--x)` inside
// an explanatory comment in index.html and reported a phantom. Blanking rather
// than deleting keeps offsets, and therefore line numbers, intact.
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

describe('custom property references', () => {
  test('every var() has a declaration behind it', () => {
    const declared = new Set();
    const used = new Map();

    for (const file of sourceFiles()) {
      const text = stripComments(fs.readFileSync(file, 'utf-8'));
      for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) declared.add(m[1]);
      // Properties set from script are declared just as much as ones written
      // in a stylesheet; the sidebar width is set this way and no rule
      // declares it.
      for (const m of text.matchAll(/setProperty\(\s*['"](--[\w-]+)/g)) declared.add(m[1]);
      // A reference WITH a fallback is fine by construction: `var(--a, red)`
      // renders red. Only the bare form can fail silently, so only the bare
      // form is checked.
      for (const m of text.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
        if (!used.has(m[1])) used.set(m[1], new Set());
        used.get(m[1]).add(path.relative(PUBLIC, file));
      }
    }

    const orphans = [...used.keys()].filter(name => !declared.has(name)).sort();
    assert.deepStrictEqual(
      orphans, [],
      `used but never declared: ${orphans.map(o => `${o} (${[...used.get(o)].join(', ')})`).join('; ')}`,
    );

    // Guard the guard. If the scan found no references at all, the assertion
    // above passes while proving nothing, which is how this class of check
    // usually rots.
    assert.ok(used.size > 20, `only ${used.size} custom properties referenced; the scan is not reaching the stylesheets`);
    assert.ok(declared.has('--text-3'), 'the token this test was written for should be declared');
  });

  test('a token the light theme overrides is also declared in the base', () => {
    // Found while trying to prove the test above could fail: removing the dark
    // declaration of --text-3 left the light one, and the check still passed,
    // because it collects declarations from everywhere at once.
    //
    // That is a real gap and not just a bad proof. The light theme is an
    // OVERRIDE layer: it restates a handful of tokens and inherits the rest.
    // A token declared only there resolves in light and is undefined in dark,
    // which is the same silent inheritance as declaring it nowhere, except it
    // only shows up in one theme.
    const css = fs.readFileSync(path.join(PUBLIC, 'styles', 'tokens.css'), 'utf-8');
    const clean = stripComments(css);

    const start = clean.indexOf('body.light {');
    assert.ok(start !== -1, 'the light theme block should exist');
    const end = clean.indexOf('}', start);
    const lightBlock = clean.slice(start, end);
    const base = clean.slice(0, start) + clean.slice(end);

    const names = (text) => new Set([...text.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
    const inBase = names(base);
    const lightOnly = [...names(lightBlock)].filter(n => !inBase.has(n)).sort();

    assert.deepStrictEqual(lightOnly, [], `declared only in the light theme: ${lightOnly.join(', ')}`);
    assert.ok(names(lightBlock).size > 3, 'the light block parse found almost nothing, so this proves nothing');
  });
});
