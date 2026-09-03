#!/usr/bin/env node
'use strict';
// Style drift lint.
//
// A design token only works if it is the ONLY place its value is written. The
// moment a colour, a radius or a duration is typed as a literal somewhere else,
// changing the token stops changing the app, and the drift is invisible until
// someone notices two things that should match no longer do. Rundock had four
// near-identical reds by the time this was written, for exactly that reason.
//
// This flags a literal wherever one is written outside tokens.css, and refuses
// to pass unless that literal is listed in style-drift-allowlist.json with a
// reason and a count. It is a RATCHET: the counts are maxima, so drift can be
// paid down but not accumulated.
//
//   node test/tools/style-drift.js            check, exit non-zero on drift
//   node test/tools/style-drift.js --report   print what is there, exit 0
//   node test/tools/style-drift.js --write    regenerate the counts (keeps reasons)
//
// Adding an entry to the allowlist is deliberately a code review, not a
// formality: the reason field is the only part a person has to write, and it is
// the only part worth reading.
//
// ── If this lint just failed you ────────────────────────────────────────────
//
// docs/DESIGN.md, "The drift lint", is the source of truth for what to do
// about it, and for which literals are deliberate and why. The short version:
// a token usually already covers the value, and adding an allowlist entry is
// the last option rather than the first.
//
// Comments are stripped before anything is counted. They used to be included,
// which meant explaining a value raised its own allowance.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ALLOWLIST = path.join(__dirname, 'style-drift-allowlist.json');

// Where styling can be written. tokens.css is the source of truth and is
// exempt by definition; vendor/ is third-party and not ours to tidy.
function surfaces() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.css') && e.name !== 'tokens.css') out.push(rel);
    }
  };
  walk('public/styles');
  out.push('public/index.html', 'public/app.js', 'public/editor/styles.js');
  for (const f of fs.readdirSync(path.join(ROOT, 'public/views'))) {
    if (f.endsWith('.js')) out.push(`public/views/${f}`);
  }
  return out.sort();
}

// ── layout ownership ─────────────────────────────────────────────────────────
//
// THE RULE, IN ONE SENTENCE: a view container's selector (#view-<name>) may
// only appear in that view's own stylesheet, public/styles/views/<name>.css;
// any cross-file override must be declared in the allowlist with a reason.
//
// Why it exists: one line in a stylesheet linked from index.html
// (#view-chat { flex-direction: row; }) laid the whole chat view out
// sideways, because every stylesheet shares one global cascade by the
// no-build-step decision, and an ID selector beats the base layout every
// view depends on. Nothing else in the gate had anything to say about it:
// the literal scan asks a different question. This scan asks the ownership
// one, over the stylesheet surfaces only (css files and the editor's style
// module), because a #view- string in a view's JS is a selection, not a rule.
const VIEW_ID = /#view-([a-z-]+)/g;

function layoutFindings(rel, src) {
  const out = [];
  const clean = stripComments(src);
  const lines = clean.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let m;
    VIEW_ID.lastIndex = 0;
    while ((m = VIEW_ID.exec(lines[i]))) {
      const owner = `public/styles/views/${m[1]}.css`;
      if (rel !== owner) out.push({ file: rel, line: i + 1, selector: m[0], owner });
    }
  }
  return out;
}

function layoutScan() {
  const out = [];
  for (const rel of surfaces()) {
    if (!rel.endsWith('.css') && rel !== 'public/editor/styles.js') continue;
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    out.push(...layoutFindings(rel, src));
  }
  return out;
}

// ── detectors ────────────────────────────────────────────────────────────────

// A hex colour, but NOT an HTML numeric character reference. `&#8593;` is an
// up arrow and its digits are all valid hex, so length cannot tell them apart:
// the `&` is the only signal. index.html and three view modules are full of
// them, and a scan without this rule reports arrow glyphs as colour drift.
const HEX = /(^|[^&\w])(#[0-9a-fA-F]{3,8})\b/g;
const FUNC = /\b(rgba?|hsla?)\(\s*[\d.]/g;
const RADIUS = /border-radius:\s*([^;}\n]+)/g;
const TIMED = /\b(?:transition|animation)(?:-duration)?:\s*([^;}\n]+)/g;
const TIME = /\b\d*\.?\d+m?s\b/g;

// Blank out comments, keeping newlines so reported line numbers stay true.
//
// A literal written INSIDE a comment is not drift, and counting it has a nasty
// property: explaining a value raises its own allowance, so documenting drift
// creates room for more drift. That is the exact inverse of the point. It
// shipped once, when a comment saying "#1a1a1a is dark text on a bright fill"
// pushed that file's allowance from one to two.
function stripComments(src) {
  const blanked = (m) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blanked)      // css and js block comments
    .replace(/<!--[\s\S]*?-->/g, blanked)       // html comments
    .replace(/(^|[^:\w])\/\/[^\n]*/g, (m, p) => p + m.slice(p.length).replace(/./g, ' '));
}

function findings(rel) {
  const src = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
  const lines = src.split('\n');
  const found = [];
  const at = (idx) => src.slice(0, idx).split('\n').length;

  for (const m of src.matchAll(HEX)) {
    found.push({ kind: 'colour', literal: m[2], line: at(m.index) });
  }
  for (const m of src.matchAll(FUNC)) {
    // Re-read the whole call so the recorded literal is the value, not a prefix.
    const tail = src.slice(m.index);
    const close = tail.indexOf(')');
    if (close === -1) continue;
    found.push({ kind: 'colour', literal: tail.slice(0, close + 1).replace(/\s+/g, ''), line: at(m.index) });
  }
  for (const m of src.matchAll(RADIUS)) {
    for (const v of m[1].match(/\b\d+px\b/g) || []) {
      found.push({ kind: 'radius', literal: v, line: at(m.index) });
    }
  }
  for (const m of src.matchAll(TIMED)) {
    for (const v of m[1].match(TIME) || []) {
      found.push({ kind: 'duration', literal: v, line: at(m.index) });
    }
  }
  return found.map(f => ({ ...f, file: rel, text: (lines[f.line - 1] || '').trim().slice(0, 100) }));
}

function scan() {
  const byFile = {};
  for (const rel of surfaces()) {
    const f = findings(rel);
    if (f.length) byFile[rel] = f;
  }
  return byFile;
}

// ── modes ────────────────────────────────────────────────────────────────────

function counts(byFile) {
  const out = {};
  for (const [file, items] of Object.entries(byFile)) {
    out[file] = {};
    for (const i of items) out[file][i.literal] = (out[file][i.literal] || 0) + 1;
  }
  return out;
}

function main() {
  const mode = process.argv[2] || '--check';
  const byFile = scan();
  const total = Object.values(byFile).reduce((a, l) => a + l.length, 0);

  if (mode === '--report') {
    for (const [file, items] of Object.entries(byFile)) {
      console.log(`\n${file}  (${items.length})`);
      for (const i of items) console.log(`  ${i.line}: ${i.kind} ${i.literal}`);
    }
    console.log(`\nstyle-drift: ${total} literals across ${Object.keys(byFile).length} files`);
    return 0;
  }

  const allow = JSON.parse(fs.readFileSync(ALLOWLIST, 'utf-8'));

  if (mode === '--write') {
    const next = counts(byFile);
    for (const [file, lits] of Object.entries(next)) {
      const why = allow[file] && allow[file].why;
      next[file] = { why: why || 'TODO: say why these are not tokens yet, and what they wait on.', allow: lits };
    }
    fs.writeFileSync(ALLOWLIST, JSON.stringify(next, null, 2) + '\n');
    console.log(`style-drift: wrote ${Object.keys(next).length} file entries`);
    return 0;
  }

  const errors = [];
  for (const [file, items] of Object.entries(counts(byFile))) {
    const entry = allow[file];
    if (!entry) {
      errors.push(`${file}: not in the allowlist, and writes ${Object.values(items).reduce((a, b) => a + b, 0)} literals`);
      continue;
    }
    for (const [lit, n] of Object.entries(items)) {
      const cap = entry.allow[lit];
      if (cap === undefined) {
        const where = byFile[file].filter(f => f.literal === lit).map(f => f.line).join(', ');
        errors.push(`${file}:${where}: ${lit} is not in the allowlist. Use a token from public/styles/tokens.css, or add it with a reason.`);
      } else if (n > cap) {
        errors.push(`${file}: ${lit} appears ${n} times, allowed ${cap}. The allowlist is a ratchet: counts come down, never up.`);
      }
    }
  }
  // A stale allowlist is drift of its own: an entry describing a literal that
  // no longer exists reads as an unpaid debt and hides that it was paid.
  for (const [file, entry] of Object.entries(allow)) {
    // viewOverrides is the layout-ownership section below, not a file entry.
    if (file === 'viewOverrides') continue;
    const actual = counts(byFile)[file] || {};
    for (const [lit, cap] of Object.entries(entry.allow)) {
      if (actual[lit] === undefined) {
        errors.push(`${file}: allowlist still lists ${lit} (${cap}), which is no longer written. Remove it.`);
      } else if (actual[lit] < cap) {
        errors.push(`${file}: allowlist allows ${cap} of ${lit} but only ${actual[lit]} remain. Lower it to ${actual[lit]}.`);
      }
    }
  }

  // Layout ownership, judged against its own allowlist section. An entry is
  // {file, selector, reason}; a finding without one names the offender, and a
  // stale entry is drift of its own, same as the literal allowlist above.
  const ownership = layoutScan();
  const declared = allow.viewOverrides || [];
  for (const f of ownership) {
    const entry = declared.find(d => d.file === f.file && d.selector === f.selector);
    if (!entry) {
      errors.push(`${f.file}:${f.line}: ${f.selector} is owned by ${f.owner} and may not be `
        + 'restyled from here. Move the rule into the owning stylesheet, or declare the '
        + 'override in style-drift-allowlist.json under viewOverrides with a reason.');
    }
  }
  for (const d of declared) {
    if (!ownership.some(f => f.file === d.file && f.selector === d.selector)) {
      errors.push(`${d.file}: viewOverrides still lists ${d.selector}, which is no longer written. Remove it.`);
    }
  }

  if (errors.length) {
    console.error('style-drift: FAIL\n');
    for (const e of errors) console.error('  ' + e);
    console.error(`\n  ${errors.length} problem(s). Tokens live in public/styles/tokens.css.`);
    console.error('  Paying drift down is a visual change: check it with test/e2e/style-snapshot.tool.js.');
    return 1;
  }
  console.log(`style-drift: clean (${total} allowlisted literals across ${Object.keys(byFile).length} files)`);
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { scan, counts, findings, surfaces, stripComments, layoutFindings, layoutScan };
