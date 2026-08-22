#!/usr/bin/env node
'use strict';
// Delete each of the renderer's guards in turn and report which tests notice.
//
// WHY THIS IS AN INSTRUMENT AND NOT A NOTE
//
// A green suite says the guards and the tests agree today. It does not say the
// tests are testing the guards. A test can assert the shape a fix happens to
// have rather than the property it exists for, and such a test stays green when
// the guard is deleted. That has happened here twice, on this very file's
// subject: the escaping on a wikilink target and the escaping on a rewritten
// relative href could both be removed with nothing turning red, because every
// payload on record used a single quote and neither position is broken by one.
//
// So the check is mechanical and runnable. Each entry below names a guard, the
// exact text that implements it, and what removing it looks like. The harness
// applies one at a time, runs the renderer's suite, and prints which tests turn
// red BY NAME. A guard with no red test is reported as such rather than passed
// over: an experiment that changes nothing has not been run, it has failed.
//
//   node test/tools/mutate-render-guards.js            # report
//   node test/tools/mutate-render-guards.js --markdown # the same, as a table
//
// The file is restored afterwards, including when a run throws.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'public', 'markdown-render.js');
const SUITE = 'test/unit/markdown-render.test.js';

// [label, the guard as it is written, what it becomes without it]
const MUTATIONS = [
  ['wikilink target escaped into its attribute',
    '<a class="wikilink" data-wikilink="${escapeAttr(token.target)}">',
    '<a class="wikilink" data-wikilink="${token.target}">'],
  ['callout title escaped',
    '<div class="callout-title">${escapeHtml(token.title)}</div>',
    '<div class="callout-title">${token.title}</div>'],
  ['raw HTML escaped',
    "return escapeHtml(token.text.replace(/<!--[\\s\\S]*?-->/g, ''));",
    "return token.text.replace(/<!--[\\s\\S]*?-->/g, '');"],
  ['HTML comments dropped rather than escaped',
    "return escapeHtml(token.text.replace(/<!--[\\s\\S]*?-->/g, ''));",
    'return escapeHtml(token.text);'],
  ['link destination checked before it is written',
    '          if (!isNavigableHref(href)) return text;\n',
    ''],
  ['image destination checked before it is written',
    "          if (!isNavigableHref(token.href)) return escapeHtml(token.text || '');\n",
    ''],
  ['href written as an attribute value, not left to the parser',
    'return `<a href="${escapeAttr(href)}"${title}>${text}</a>`;',
    'return `<a href="${href}"${title}>${text}</a>`;'],
  ['workspace-file href escaped into its attribute',
    'return `<a class="wikilink" data-wikilink="${escapeAttr(href)}">${text}</a>`;',
    'return `<a class="wikilink" data-wikilink="${href}">${text}</a>`;'],
  ['tag offered only where a hash follows whitespace',
    '          const match = /\\s#[a-zA-Z]/.exec(src);\n          return match ? match.index + 1 : undefined;',
    "          const match = /(?:^|\\s)#[a-zA-Z]/.exec(src);\n          if (!match) return undefined;\n          return match[0].startsWith('#') ? match.index : match.index + 1;"],
  ['copy button carries no inline handler',
    '<button class="copy-code-btn" title="Copy code">',
    '<button class="copy-code-btn" onclick="copyCode(this)" title="Copy code">'],
  ['wikilink anchor carries no inline handler',
    '<a class="wikilink" data-wikilink="${escapeAttr(token.target)}">',
    '<a class="wikilink" data-wikilink="${escapeAttr(token.target)}" onclick="openWikilink(\'x\')">'],
];

function redTests() {
  let out = '';
  try {
    out = execFileSync('node', ['--test', SUITE], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  const marker = out.indexOf('failing tests:');
  if (marker === -1) return [];
  const names = [];
  for (const line of out.slice(marker).split('\n')) {
    const m = /^✖ (.+?) \(\d/.exec(line.trim());
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function run() {
  const original = fs.readFileSync(SRC, 'utf8');
  const results = [];
  try {
    for (const [label, guard, without] of MUTATIONS) {
      if (!original.includes(guard)) {
        results.push({ label, applied: false, red: [] });
        continue;
      }
      fs.writeFileSync(SRC, original.replace(guard, without));
      results.push({ label, applied: true, red: redTests() });
    }
  } finally {
    fs.writeFileSync(SRC, original);
  }
  return results;
}

function report(results, markdown) {
  let failed = 0;
  const lines = [];
  for (const { label, applied, red } of results) {
    if (!applied) {
      failed++;
      lines.push(markdown
        ? `| ${label} | **the guard text was not found, so nothing was mutated** | |`
        : `${label}\n  THE GUARD TEXT WAS NOT FOUND, so nothing was mutated`);
      continue;
    }
    if (red.length === 0) {
      failed++;
      lines.push(markdown
        ? `| ${label} | **nothing turned red** | |`
        : `${label}\n  NOTHING TURNED RED`);
      continue;
    }
    lines.push(markdown
      ? `| ${label} | ${red.length} | ${red.map((n) => `\`${n}\``).join('<br>')} |`
      : `${label}\n  ${red.length} red\n${red.map((n) => `    - ${n}`).join('\n')}`);
  }
  if (markdown) {
    console.log('| Guard removed | Tests red | Which |');
    console.log('|---|---|---|');
    for (const line of lines) console.log(line);
  } else {
    for (const line of lines) console.log(`\n${line}`);
  }
  return failed;
}

if (require.main === module) {
  const failed = report(run(), process.argv.includes('--markdown'));
  if (failed) {
    console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded.`);
    process.exit(1);
  }
}

module.exports = { MUTATIONS, run };
