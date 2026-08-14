#!/usr/bin/env node
'use strict';
// What actually changed between two versions of the styling.
//
//   node test/tools/style-resolve-diff.js <refA> <refB>
//   node test/tools/style-resolve-diff.js <refA> WORKTREE
//
// Reads every declaration in the stylesheets, index.html and the editor's
// injected stylesheet, substitutes var() references with the token values in
// force at that ref, and reports every declaration whose RESOLVED value
// differs. It answers a review question, so it is not wired into CI: a
// deliberate visual change should be read, not blocked.
//
// WHY THIS EXISTS, AND WHY IT IS STATIC
//
// test/e2e/style-snapshot.tool.js captures computed styles from a running app,
// which is the right instrument for "did the rendered page change". It has one
// blind spot that matters: it only ever sees elements in their DEFAULT state.
// Nothing in a capture is hovered, focused, disabled, or in an error state, so
// a rule that only applies in those states is invisible to it.
//
// That is not hypothetical. Slice 3 of the styling work reported "zero painted
// properties differ" and was, for its 209 substitutions, correct. Adding the
// --danger token in the same change also gave a value to references written as
// var(--danger, #fallback) back when the token did not exist, which altered 8
// declarations across 6 selectors. Every one of them was a :hover, an error
// state or a review-mode rule, so the snapshot walked straight past them.
//
// Three attempts were made to extend the snapshot tool to cover those states by
// applying each CSS rule to a probe element in the browser. All three produced
// results that could not be explained, and they are recorded here so nobody
// spends the time again:
//
//   1. Guarding recursion with `if (rule.cssRules) continue` captured NOTHING.
//      Modern Chromium gives every CSSStyleRule a cssRules list for CSS
//      nesting, so every ordinary rule looked like a container. A silent empty
//      result is indistinguishable from "no differences found".
//   2. Reading the rule's own longhand properties reported 145 selectors as
//      changed when the true number was 3. A shorthand whose value contains
//      var() cannot be expanded into longhands, so `border-radius:
//      var(--radius-lg)` exposes its longhands as empty strings and every
//      tokenised rule reads as though its corners went square.
//   3. Setting the whole declaration block and reading a fixed property list
//      still reported eleven nav and toolbar selectors as changing colour,
//      with no explanation that survived checking. Unexplained is unusable.
//
// Resolving the text statically has none of those failure modes. It cannot
// model the cascade, so it will not tell you which rule WINS: use it to learn
// what changed, and the snapshot tool or a screenshot to learn how it looks.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const EXTRA = ['public/index.html', 'public/editor/styles.js'];

function readAt(ref, file) {
  if (ref === 'WORKTREE') {
    const p = path.join(ROOT, file);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
  }
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], { cwd: ROOT, encoding: 'utf-8' });
  } catch { return null; }
}

function filesAt(ref) {
  let list;
  if (ref === 'WORKTREE') {
    list = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf-8' }).split('\n');
  } else {
    list = execFileSync('git', ['ls-tree', '-r', '--name-only', ref], { cwd: ROOT, encoding: 'utf-8' }).split('\n');
  }
  return list.filter(f => (f.startsWith('public/styles/') && f.endsWith('.css')) || EXTRA.includes(f));
}

// Custom property values in force at a ref.
//
// index.html is read because before the tokens moved to their own file that is
// where they lived, so a diff spanning that move resolves both sides. EVERY
// scanned file is read too, because not all custom properties are global:
// --callout-color is declared on the callout classes themselves, and reading
// only tokens.css reported eleven declarations as unresolved when nine of them
// were component-scoped and perfectly fine.
//
// The limitation this accepts: scope is ignored, so a property declared on one
// component resolves everywhere. That is coarse, but it is coarse CONSISTENTLY
// on both sides of a diff, which is what this tool compares. It is why the tool
// reports what changed rather than what any given element computes.
function tokensAt(ref) {
  const t = new Map();
  const files = ['public/styles/tokens.css', 'public/index.html', ...filesAt(ref)];
  for (const file of files) {
    const src = readAt(ref, file);
    if (!src) continue;
    for (const m of src.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
      if (!t.has(m[1])) t.set(m[1], m[2].trim());
    }
  }
  return t;
}

const VAR = /var\(\s*(--[\w-]+)\s*((?:,[^()]*(?:\([^()]*\))?[^()]*)?)\)/g;

function resolve(value, tokens) {
  let prev = null;
  let out = value;
  let guard = 0;
  while (prev !== out && guard++ < 10) {
    prev = out;
    out = out.replace(VAR, (_, name, fallback) => {
      if (tokens.has(name)) return tokens.get(name);
      const fb = (fallback || '').replace(/^\s*,/, '').trim();
      // No token and no fallback is a declaration that resolves to nothing.
      // Naming it is the point: it is how .ws-picker-error rendered as body
      // text rather than red for as long as --danger did not exist.
      return fb || '<<UNRESOLVED>>';
    });
  }
  return out.replace(/\s+/g, ' ').trim();
}

function declarations(ref) {
  const tokens = tokensAt(ref);
  const out = new Map();
  for (const file of filesAt(ref)) {
    const src = readAt(ref, file);
    if (!src) continue;
    for (const block of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = block[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
      if (!sel || sel.startsWith('@') || sel.includes('</')) continue;
      for (const decl of block[2].split(';')) {
        const i = decl.indexOf(':');
        if (i === -1) continue;
        const prop = decl.slice(0, i).trim();
        if (!/^[a-z-]+$/.test(prop) || prop.startsWith('--')) continue;
        out.set(`${file}|${sel}|${prop}`, resolve(decl.slice(i + 1).trim(), tokens));
      }
    }
  }
  return out;
}

function diff(refA, refB) {
  const a = declarations(refA);
  const b = declarations(refB);
  const common = [...a.keys()].filter(k => b.has(k));
  const changed = common.filter(k => a.get(k) !== b.get(k)).map(k => ({ key: k, from: a.get(k), to: b.get(k) }));
  return {
    compared: common.length,
    added: [...b.keys()].filter(k => !a.has(k)).length,
    removed: [...a.keys()].filter(k => !b.has(k)).length,
    changed,
  };
}

function main() {
  const [refA, refB] = process.argv.slice(2);
  if (!refA || !refB) {
    console.error('usage: style-resolve-diff.js <refA> <refB|WORKTREE>');
    return 2;
  }
  const r = diff(refA, refB);
  console.log(`declarations compared: ${r.compared} (${r.added} added, ${r.removed} removed)`);
  console.log(`resolved values changed: ${r.changed.length}\n`);
  for (const c of r.changed.sort((x, y) => x.key.localeCompare(y.key))) {
    const [file, sel, prop] = c.key.split('|');
    console.log(`  ${file.replace('public/', '')}  ${sel}`);
    console.log(`    ${prop}: ${c.from}  ->  ${c.to}`);
  }
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { resolve, declarations, diff, tokensAt };
