#!/usr/bin/env node
'use strict';
// Put the fence corruption back, one fault at a time, and report which tests
// notice.
//
// WHY THIS FILE RATHER THAN A REVERT
//
// What this change owes are prohibitions: adding a comment to a file that
// contains a fenced block must leave every byte outside the comment markers
// alone, editing one must, and removing one must give the file back. A revert
// cannot show any of that. Revert the source and the tests fail because the
// refusal is gone, which is a different sentence: it says the tests notice the
// change, not that bytes were preserved. A prohibition is only ever proved by
// committing the thing it forbids and requiring something to object.
//
// So each mutation below writes one of the two faults back into the source and
// runs the suite that should turn red for it.
//
//   node test/tools/mutate-fence-guards.js            # report
//   node test/tools/mutate-fence-guards.js --markdown # as a table
//
// The files are restored afterwards, including when a run throws.
//
// The harness is the same shape as mutate-workspace-rollback-guards.js and is
// deliberately a second copy rather than a shared module, for the reason stated
// there: pulling them together means editing an instrument already in the gate,
// and mixing that refactor into a change is how a gate quietly stops checking
// what it used to.
//
// THE TWO FAULTS, AND WHY THEIR ROWS READ DIFFERENTLY
//
// One is anchor placement: a review construct is an inline atom and a fenced
// block holds text and nothing else, so putting one there closes the block and
// sweeps the rest of it into a paragraph, where the next save escapes the
// asterisks and backticks that were code.
//
// The other is serialisation: the fence marker the file was written with was
// not carried through the round trip, so a four-backtick fence came back three
// backticks long and the NEXT read closed it at its own inner fence. That one
// moves the fence boundary with the content still inside a code block, so
// nothing is escaped. Reintroduced separately, and red in different tests.
//
// BOTH FORMS THE USER SAW ARE COMMITTED BACK, and the escaping is the one worth
// being careful about. In the incident it arrived as a consequence of the
// anchor fault, and along that route there is no guard to remove: paragraph
// text is escaped because it is paragraph text. But the serialiser reaches the
// same damage by a second route with a line of its own, the escape flag on the
// call that writes a block's contents, and turning it back on escapes a fenced
// block with no comment anywhere near it. So the escaping is mutated directly
// as well as arriving with the anchor rows.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

// The authoring commands, watched by the file that drives a real fixture
// through the real editor and compares bytes.
const CONTROLLER = {
  src: path.join(ROOT, 'public', 'editor', 'review', 'controller.js'),
  suite: 'test/unit/review-fenced-roundtrip.test.js',
};

// The code block serialiser, watched by the same file for the fixture and by
// the parity corpus for the construct families.
const SERIALISER = {
  src: path.join(ROOT, 'public', 'editor', 'nodes', 'source-markers.js'),
  suite: 'test/unit/review-fenced-roundtrip.test.js',
};
const SERIALISER_IN_CORPUS = { ...SERIALISER, suite: 'test/unit/ofm-parity.test.js' };

// [target, label, the guard as it is written, what it becomes without it]
const MUTATIONS = [
  // FAULT ONE, in each of the three places a person can author from.
  [CONTROLLER, 'a comment refuses a range in a block that holds only text',
    "    if (!rangeHoldsConstructs(from, to)) return refusalForRange(from, to);\n    const id = nextId('c');",
    "    const id = nextId('c');"],
  [CONTROLLER, 'a suggested replacement refuses a range in a block that holds only text',
    "    if (!rangeHoldsConstructs(from, to)) return refusalForRange(from, to);\n    const id = nextId('s');",
    "    const id = nextId('s');"],
  [CONTROLLER, 'a suggested insertion refuses a cursor in a block that holds only text',
    '    if (!blockHoldsConstructs(to)) return refusalAt(to);\n',
    ''],
  // FAULT TWO, in each of the three things the source fence line carries.
  [SERIALISER, 'the fence is the one the file was written with, not a fixed three backticks',
    'const fence = fenceFor(node.attrs.srcFence, node.textContent);',
    "const fence = '```';"],
  [SERIALISER, 'the fence keeps its marker character, so a tilde fence stays a tilde fence',
    "const marker = srcFence && srcFence[0] === '~' ? '~' : '`';",
    "const marker = '`';"],
  [SERIALISER, 'the fence is widened past any fence inside the block',
    'Math.max(3, srcFence ? srcFence.length : 3, longestInside + 1)',
    'Math.max(3, srcFence ? srcFence.length : 3)'],
  // FAULT ONE'S SECOND SYMPTOM, WHICH HAS A LINE OF ITS OWN AFTER ALL. The
  // escaping reached the user as a consequence of the anchor fault, but the
  // serialiser's escape flag is what stands between a fenced block's contents
  // and the prose escaper, and turning it back on writes `\*\*bold\*\*` into a
  // fence with no comment anywhere near it. Two routes to the same damage, so
  // both are committed back rather than one standing in for the other.
  [SERIALISER, 'the contents of a fenced block are written literally, not escaped as prose',
    'state.text(node.textContent, false);',
    'state.text(node.textContent, true);'],
  [SERIALISER_IN_CORPUS, 'the whole info string is written back, not just the language word',
    "const info = node.attrs.srcInfo != null ? node.attrs.srcInfo : (node.attrs.language || '');",
    "const info = node.attrs.language || '';"],
];

// Guards in this change that are deliberately NOT mutated, each with the
// reason. A named exclusion is a decision; an unnamed one is a harness that
// quietly checks less than it claims.
const NOT_MUTATED = [
  {
    what: 'the escaping of text swept out of a block by the anchor fault',
    why: 'that route has no line of its own to break. Once an atom has closed the block, the '
      + 'remainder is paragraph text, and escaping paragraph text is the serialiser doing the '
      + 'correct thing: there is no guard there to remove. It is reintroduced by the first '
      + 'three rows, whose tests assert on the backslashes as well as on the fence. The OTHER '
      + 'route to the same damage does have a line, and it is mutated: see the escape flag row '
      + 'above, which escapes a fenced block with no comment involved.',
  },
  {
    what: 'the panel showing the refusal reason in the composer',
    why: 'it is display, and the byte-preservation claims do not rest on it. It has a test '
      + 'that drives the real sidebar and reads the rendered reason, which is the right '
      + 'instrument for it; a mutation here would report on that test twice.',
  },
];

// The reporter is named explicitly rather than left to the default, which
// varies with whether stdout is a TTY.
const REPORTER = ['--test-reporter=spec', '--test-reporter-destination=stdout'];

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
  if (marker === -1) {
    if (!failed) return [];
    // A suite that failed with output this could not read has produced no
    // verdict: not red, not green, nothing. Refused as a named row rather
    // than thrown, so the report says which mutation was in flight instead
    // of a stack trace that names nothing. The spec reporter's format is
    // what this parses; if it changed, fix the parser rather than trusting
    // an empty result.
    return { unparsable: true };
  }
  const names = [];
  for (const line of out.slice(marker).split('\n')) {
    const m = /^✖ (.+?) \(\d/.exec(line.trim());
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function run() {
  const targets = [...new Set(MUTATIONS.map(([target]) => target.src))];
  const session = beginMutationRun({ files: targets });
  const originals = new Map();
  for (const src of targets) originals.set(src, session.original(src));
  const results = [];
  try {
    for (const [target, label, guard, without] of MUTATIONS) {
      const original = originals.get(target.src);
      const matches = original.split(guard).length - 1;
      if (matches === 0) {
        results.push({ label, applied: false, red: [] });
        continue;
      }
      // A GUARD THAT MATCHES MORE THAN ONCE IS REFUSED RATHER THAN TAKING THE
      // FIRST. String.replace takes the first occurrence, so a search text that
      // also appears somewhere else quietly breaks the wrong code and reports
      // on whatever that turns red. Load-bearing here: the two range guards are
      // the same line, told apart only by the id allocation under them.
      if (matches > 1) {
        results.push({ label, applied: false, ambiguous: matches, red: [] });
        continue;
      }
      fs.writeFileSync(target.src, original.replace(guard, without));
      const red = redTests(target.suite);
      results.push(red && red.unparsable
        ? { label, applied: true, matches, suite: target.suite, unparsable: true, red: [] }
        : { label, applied: true, matches, suite: target.suite, red });
      fs.writeFileSync(target.src, original);
    }
  } finally {
    session.finish();
  }
  return results;
}

function report(results, markdown) {
  let failed = 0;
  const lines = [];
  for (const { label, applied, red, ambiguous, matches, unparsable } of results) {
    if (unparsable) {
      failed++;
      const why = 'no verdict: the suite failed but its output could not be parsed, so nothing '
        + 'about this mutation is known; fix the reporter parsing rather than trusting a rerun';
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  ${why.toUpperCase()}`);
      continue;
    }
    if (ambiguous) {
      failed++;
      const why = `the guard text matches ${ambiguous} places, so it would break whichever came first`;
      lines.push(markdown ? `| ${label} | ${ambiguous} | **${why}** | |` : `${label}\n  AMBIGUOUS: ${why}`);
      continue;
    }
    if (!applied) {
      failed++;
      lines.push(markdown
        ? `| ${label} | 0 | **the guard text was not found, so nothing was mutated** | |`
        : `${label}\n  THE GUARD TEXT WAS NOT FOUND, so nothing was mutated`);
      continue;
    }
    if (red.length === 0) {
      failed++;
      lines.push(markdown ? `| ${label} | ${matches} | **nothing turned red** | |` : `${label}\n  NOTHING TURNED RED`);
      continue;
    }
    // The match count travels with the result. A guard text that matched once
    // is a guard that was addressed; the harness refuses anything else, so
    // printing it turns "addressed exactly once" from a claim into a reading.
    lines.push(markdown
      ? `| ${label} | ${matches} | ${red.length} | ${red.map((n) => `\`${n}\``).join('<br>')} |`
      : `${label}\n  found in ${matches} place\n  ${red.length} red\n${red.map((n) => `    - ${n}`).join('\n')}`);
  }
  if (markdown) {
    console.log('| Guard broken | Places found | Tests red | Which |');
    console.log('|---|---|---|---|');
    for (const line of lines) console.log(line);
    console.log('');
    console.log('Deliberately not mutated:');
    console.log('');
    for (const { what, why } of NOT_MUTATED) console.log(`- **${what}:** ${why}`);
  } else {
    for (const line of lines) console.log(`\n${line}`);
    console.log('\nDeliberately not mutated:');
    for (const { what, why } of NOT_MUTATED) console.log(`\n  ${what}\n    ${why}`);
  }
  return failed;
}

// REFUSE TO START ON A MACHINE THAT WOULD MISREPORT. Same reason as the other
// mutation harnesses: this runs a suite per guard, so it is a heavy producer of
// fixtures, and write failures on a full disk surface as red tests, which is
// exactly what this instrument reports as an unguarded guard.
function requireSaneTempRoot() {
  const verdict = preflight(os.tmpdir());
  if (verdict.ok) return;
  console.error(verdict.message);
  process.exit(2);
}

if (require.main === module) {
  requireSaneTempRoot();
  const markdown = process.argv.includes('--markdown');
  const failed = report(run(), markdown);
  process.exit(failed ? 1 : 0);
}

module.exports = { MUTATIONS, NOT_MUTATED, run, report };
