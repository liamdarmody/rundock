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
// The file is restored afterwards, including when a run throws and when one is
// killed. That part is not this file's: see test/tools/mutation-run.js for what
// the envelope covers and for the one way out it cannot.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

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
  ['raw-block text escaped rather than emitted verbatim',
    "        if (token.type === 'text' && token.escaped) token.escaped = false;",
    '        return;'],
  ['raw HTML escaped',
    "return escapeHtml(token.text.replace(/<!--[\\s\\S]*?-->/g, ''));",
    "return token.text.replace(/<!--[\\s\\S]*?-->/g, '');"],
  ['HTML comments dropped rather than escaped',
    "return escapeHtml(token.text.replace(/<!--[\\s\\S]*?-->/g, ''));",
    'return escapeHtml(token.text);'],
  ['link destination decoded before it is judged',
    '          const href = decodeCharacterReferences(token.href);',
    '          const href = token.href;'],
  ['image destination decoded before it is judged',
    '          const src = decodeCharacterReferences(token.href);',
    '          const src = token.href;'],
  ['link destination checked before it is written',
    '          if (!isNavigableHref(href)) return text;\n',
    ''],
  ['image destination checked before it is written',
    "          if (!isNavigableHref(src)) return escapeHtml(token.text || '');\n",
    ''],
  ['href written as an attribute value, not left to the parser',
    'return `<a href="${escapeAttr(href)}"${title}>${text}</a>`;',
    'return `<a href="${href}"${title}>${text}</a>`;'],
  ['workspace-file href escaped into its attribute',
    'return `<a class="wikilink" data-wikilink="${escapeAttr(href)}">${text}</a>`;',
    'return `<a class="wikilink" data-wikilink="${href}">${text}</a>`;'],
  ['image alt escaped into its attribute',
    "          const alt = escapeAttr(token.text || '');",
    "          const alt = token.text || '';"],
  ['image title escaped into its attribute',
    '          const title = token.title ? ` title="${escapeAttr(token.title)}"` : \'\';\n          return `<img src="${escapeAttr(src)}" alt="${alt}"${title}>`;',
    '          const title = token.title ? ` title="${token.title}"` : \'\';\n          return `<img src="${escapeAttr(src)}" alt="${alt}"${title}>`;'],
  ['tag keeps the whitespace that precedes it',
    "          const match = /^([ \\t]?)#([a-zA-Z][a-zA-Z0-9_/-]*)/.exec(src);",
    "          const match = /^()#([a-zA-Z][a-zA-Z0-9_/-]*)/.exec(src);"],
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

// The reporter is named explicitly rather than left to the default, which
// varies with whether stdout is a TTY. This parses the spec reporter's summary,
// so a different reporter would yield no names, every mutation would read as
// "nothing turned red", and a passing gate would fail as fourteen phantom
// unguarded guards instead of one clear message about the reporter.
const REPORTER = ['--test-reporter=spec', '--test-reporter-destination=stdout'];

function redTests() {
  let out = '';
  let failed = false;
  try {
    out = execFileSync('node', ['--test', ...REPORTER, SUITE],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    failed = true;
    out = (e.stdout || '') + (e.stderr || '');
  }
  const marker = out.indexOf('failing tests:');
  if (marker === -1) {
    if (!failed) return [];
    // The suite failed and the summary this reads is not in its output. That is
    // a reporting problem, not a result, and reporting it as "no tests noticed"
    // would be a lie in the dangerous direction.
    throw new Error(
      'the suite failed but its output carries no "failing tests:" summary, so no '
      + 'test names could be read. The spec reporter\'s format is what this parses; '
      + 'if it changed, fix this parser rather than trusting the empty result.');
  }
  const names = [];
  for (const line of out.slice(marker).split('\n')) {
    const m = /^✖ (.+?) \(\d/.exec(line.trim());
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function run() {
  const session = beginMutationRun({ files: [SRC] });
  const original = session.original(SRC);
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
    session.finish();
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

// REFUSE TO START ON A MACHINE THAT WOULD MISREPORT.
//
// This harness runs a suite once per guard, so it is the single
// largest producer of test fixtures on the machine and the tool most likely to
// meet a full disk. When it does, the write failures surface as tests going
// red, and red tests are exactly what this instrument reports as a guard
// nobody was watching. Two runs did precisely that, reporting 293 and 32
// failures that were out of space rather than unguarded. Wrong numbers in the
// direction that looks like work to do are worse than no numbers.
//
// The check sweeps roots whose owning process is gone before it counts, so a
// machine dirtied by earlier runs repairs itself rather than stopping.
function requireSaneTempRoot() {
  const verdict = preflight(os.tmpdir());
  if (verdict.ok) return;
  console.error(verdict.message);
  process.exit(2);
}

if (require.main === module) {
  requireSaneTempRoot();
  // Check and stop. Exists so the test that proves this entry point runs the
  // preflight does not have to let a harness loose to prove it: without it, the
  // only way to observe a MISSING preflight is to watch the harness start
  // mutating and then kill it, which skips the restore below and leaves a
  // source file mutated on every red run. The flag is read after the check, so
  // deleting the check still fails that test rather than passing it.
  if (process.argv.includes('--preflight-only')) process.exit(0);
  const failed = report(run(), process.argv.includes('--markdown'));
  if (failed) {
    console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded.`);
    process.exit(1);
  }
}

module.exports = { MUTATIONS, run };
