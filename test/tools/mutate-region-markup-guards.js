#!/usr/bin/env node
'use strict';
// Widen what a region extension is allowed to put on Rundock's page, one
// entry at a time, and report which tests notice.
//
// THIS HARNESS IS THE CONDITION THE OPAQUE ORIGIN WAS TRADED AWAY UNDER.
// Every other extension surface in this product keeps third-party output
// behind a frame the host cannot be reached from. A region extension's output
// is put into the host's own document on purpose, so that a diagram can be
// selected, copied, found by search and reflowed with the prose. The entire
// safety argument for that is one file: nothing unrecognised is ever built.
// A green suite proves nothing about that claim until the allowlist is
// widened on purpose and a test goes red for it.
//
// THE MUTATIONS RUN THE OTHER WAY ROUND FROM THIS HARNESS'S SIBLINGS. They
// do not break a guard, they RELAX one: the defect being hunted is not a rule
// deleted but a rule that was never strict enough. So each row adds something
// to an allowlist, or removes a condition, and a row that turns nothing red
// means the suite would not notice that widening in a future edit.
//
//   node test/tools/mutate-region-markup-guards.js            # report
//   node test/tools/mutate-region-markup-guards.js --markdown # the same, as a table
//
// The file is restored afterwards, including when a run throws.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

const MARKUP = {
  src: path.join(ROOT, 'public', 'region-markup.js'),
  suite: 'test/unit/region-markup.test.js',
};

const MUTATIONS = [
  // ===== THE ELEMENT ALLOWLIST =====
  // The two elements that turn a drawing into a page. A script is the
  // obvious one; foreignObject is the documented way to put arbitrary HTML
  // inside an SVG, and would reopen everything escaping closed elsewhere.
  [MARKUP, 'a script element is never built',
    "    'svg', 'g', 'defs', 'title', 'desc', 'style',",
    "    'svg', 'g', 'defs', 'title', 'desc', 'style', 'script',"],
  [MARKUP, 'a foreignObject is never built',
    "    'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',",
    "    'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'foreignObject',"],
  // <use> and <image> are how a drawing fetches something.
  [MARKUP, 'an element that fetches is never built',
    "    'text', 'tspan', 'textPath',",
    "    'text', 'tspan', 'textPath', 'image', 'use',"],

  // ===== THE ATTRIBUTE ALLOWLIST =====
  // An allowlist does not name what it excludes, so the mutation is to put a
  // handler in it and watch the suite fail to care.
  [MARKUP, 'an event handler attribute is never built',
    "    'id', 'class', 'transform', 'viewBox', 'width', 'height', 'x', 'y', 'dx', 'dy',",
    "    'id', 'class', 'transform', 'viewBox', 'width', 'height', 'x', 'y', 'dx', 'dy', 'onclick', 'onload',"],
  [MARKUP, 'an attribute that names a destination is never built',
    "    'patternUnits', 'spreadMethod', 'xmlns',",
    "    'patternUnits', 'spreadMethod', 'xmlns', 'href', 'src',"],

  // ===== WHAT MAKES A PREFIX UNREACHABLE =====
  // This row replaces one that mutated a separate `if (attr.namespaceURI)
  // continue;`. That line turned NOTHING red when removed, because the name
  // check below had already done all of its work: a prefixed attribute's
  // `name` carries its prefix and can never equal an unprefixed entry. It was
  // deleted rather than kept as reassurance, and the row was rewritten to
  // mutate the line the property actually lives on. Reading localName here is
  // the real way back in, and now something says so.
  [MARKUP, 'the allowlist is matched on the qualified name, not the bare one',
    '      if (!ATTRIBUTES.has(attr.name)) continue;',
    '      if (!ATTRIBUTES.has(attr.localName)) continue;'],

  // ===== WHAT A VALUE MAY POINT AT =====
  // url(#local) is the whole reason these attributes exist; url(http…) and a
  // data: payload in the same position are fetches.
  [MARKUP, 'a url() value may point only inside the document',
    "      .every((m) => m[2].startsWith('#'));",
    '      .every(() => true);'],

  // ===== WHAT IS COPIED AT ALL =====
  // Comments carry the app's own protocol markers elsewhere in this product,
  // which is exactly why a diagram must not be able to write one.
  [MARKUP, 'a comment is never carried out of a diagram',
    '      if (child.nodeType !== 1) continue; // comments and the rest are not copied',
    '      if (child.nodeType === 8) { built.appendChild(doc.createComment(child.nodeValue)); continue; }\n'
    + '      if (child.nodeType !== 1) continue;'],
  // The unknown-element rule itself: without it, everything above is moot.
  [MARKUP, 'an element outside the allowlist is not built',
    '    if (!ELEMENTS.has(source.localName)) return null;',
    '    if (false) return null;'],
  // And the unknown-attribute rule itself, removed rather than widened, so
  // this proves the check exists at all where the row above proves it reads
  // the right name.
  [MARKUP, 'an attribute outside the allowlist is not built',
    '      if (!valueIsLocal(attr.value)) continue;\n      built.setAttribute(attr.name, attr.value);',
    '      built.setAttribute(attr.name, attr.value);'],
];

const REPORTER = ['--test-reporter', 'spec'];

function redTests(suite) {
  let out = '';
  let failed = false;
  try {
    out = execFileSync('node', ['--test', ...REPORTER, suite],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    failed = true;
    out = (e.stdout || '') + (e.stderr || '');
  }
  const marker = out.indexOf('failing tests:');
  if (marker === -1) return failed ? { unparsable: true } : [];
  const names = [];
  for (const line of out.slice(marker).split('\n')) {
    const m = /^✖ (.+?) \(\d/.exec(line.trim());
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function run() {
  const session = beginMutationRun({ files: [MARKUP.src] });
  const original = session.original(MARKUP.src);
  const results = [];
  try {
    for (const [, label, guard, without] of MUTATIONS) {
      const matches = original.split(guard).length - 1;
      if (matches !== 1) {
        results.push({ label, applied: false, ambiguous: matches > 1 ? matches : 0, red: [] });
        continue;
      }
      fs.writeFileSync(MARKUP.src, original.replace(guard, without));
      const red = redTests(MARKUP.suite);
      results.push(red && red.unparsable
        ? { label, applied: true, unparsable: true, red: [] }
        : { label, applied: true, red });
      fs.writeFileSync(MARKUP.src, original);
    }
  } finally {
    session.finish();
  }
  return results;
}

function report(results, markdown) {
  let failed = 0;
  const lines = [];
  for (const { label, applied, red, ambiguous, unparsable } of results) {
    if (unparsable) {
      failed++;
      const why = 'no verdict: the suite failed but its output could not be parsed';
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  ${why.toUpperCase()}`);
      continue;
    }
    if (ambiguous) {
      failed++;
      const why = `the guard text matches ${ambiguous} places`;
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  AMBIGUOUS: ${why}`);
      continue;
    }
    if (!applied) {
      failed++;
      lines.push(markdown
        ? `| ${label} | **the guard text was not found, so nothing was mutated** | |`
        : `${label}\n  THE GUARD TEXT WAS NOT FOUND, so nothing was mutated`);
      continue;
    }
    if (red.length === 0) {
      failed++;
      lines.push(markdown ? `| ${label} | **nothing turned red** | |` : `${label}\n  NOTHING TURNED RED`);
      continue;
    }
    lines.push(markdown
      ? `| ${label} | ${red.length} | ${red.map((n) => `\`${n}\``).join('<br>')} |`
      : `${label}\n  ${red.length} red\n${red.map((n) => `    - ${n}`).join('\n')}`);
  }
  if (markdown) {
    console.log('| Allowlist widened | Tests red | Which |');
    console.log('|---|---|---|');
    for (const line of lines) console.log(line);
  } else {
    for (const line of lines) console.log(`\n${line}`);
  }
  return failed;
}

function requireSaneTempRoot() {
  const verdict = preflight(os.tmpdir());
  if (verdict.ok) return;
  console.error(verdict.message);
  process.exit(2);
}

if (require.main === module) {
  requireSaneTempRoot();
  if (process.argv.includes('--preflight-only')) process.exit(0);
  const failed = report(run(), process.argv.includes('--markdown'));
  if (failed) {
    console.error(`\n${failed} widening(s) proved nothing. An allowlist nobody checks is a list, not a guard,`
      + ' and this one is the whole reason a region extension may write to the page at all.');
    process.exit(1);
  }
}

module.exports = { MUTATIONS, run };
