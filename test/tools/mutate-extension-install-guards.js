#!/usr/bin/env node
'use strict';
// Break each of the extension install flow's guards in turn and report which
// tests notice.
//
// The rules this lane leaves behind are all promises to a person deciding
// whether to trust code: the pin is required, the trust step tells the
// truth, no is really no, the record remembers the source so they never
// retype it, one transaction carries the install, and uninstall removes
// exactly what install created. Every one can be deleted with the product
// still installing SOMETHING, which is why each is broken on purpose here
// and a test must go red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-extension-install-guards.js            # report
//   node test/tools/mutate-extension-install-guards.js --markdown # as a table
//
// The files are restored afterwards, including when a run throws. The
// harness is the same shape as its siblings and deliberately a separate
// copy, for the reason recorded in mutate-routines-guards.js.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');
const SUITE = 'test/unit/extension-install.test.js';

const SOURCE = { src: path.join(ROOT, 'lib', 'packages', 'extension-source.js'), suite: SUITE };
const MANIFEST = { src: path.join(ROOT, 'lib', 'packages', 'extension-manifest.js'), suite: SUITE };
const RECORD = { src: path.join(ROOT, 'lib', 'packages', 'extension-record.js'), suite: SUITE };
const INSTALL = { src: path.join(ROOT, 'lib', 'packages', 'extension-install.js'), suite: SUITE };
const HANDLERS = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'packages.js'), suite: SUITE };
const MODEL = { src: path.join(ROOT, 'public', 'packages-install-model.js'), suite: SUITE };

const MUTATIONS = [
  // ===== THE PIN IS REQUIRED =====
  // Let the well-known moving names through and "pinned at main" becomes a
  // promise about whatever main means tomorrow.
  [SOURCE, 'a moving branch name is refused as not a pin',
    `  if (MOVING_NAMES.has(reference.toLowerCase())) {
    refuse(\`"\${reference}" is a moving branch name, not a pin; use a tag, release or commit\`,
      'unpinned-reference');
  }`,
    ''],
  // Default the absent pin and the refusal's whole reason is inverted.
  [SOURCE, 'an absent reference is refused, never defaulted to a branch',
    `  if (!reference) {
    refuse('a pinned reference (tag, release or commit) is required; an install is a promise '
      + 'about exact bytes, and a moving branch cannot keep it', 'unpinned-reference');
  }`,
    `  if (!reference) {
    return { url: \`https://github.com/\${owner}/\${repo}\`, owner, repo, reference: 'main' };
  }`],

  // ===== CODE REQUIRES A MANIFEST =====
  // Wave a manifest-less snapshot through as an extension and inference has
  // quietly grown the one thing it must never infer.
  [MANIFEST, 'a snapshot without a manifest is not an extension',
    `      refuse(\`the package has no \${MANIFEST_NAME}; code requires a manifest, always\`, 'not-an-extension');`,
    `      return { name: 'inferred', version: '0.0.0', entry: 'index.html', match: '*' };`],

  // ===== NO IS REALLY NO =====
  // Keep the snapshot after a decline and "nothing left behind" is false in
  // the one place the person cannot see.
  [HANDLERS, 'declining discards the acquired snapshot',
    '  if (pending) discardAcquisition(pending.snapshot);',
    ''],

  // ===== THE TRUST STEP TELLS THE TRUTH =====
  // Drop the no-review sentence and the screen implies a vetting nobody did.
  [MODEL, 'the trust step says Rundock does not review extensions',
    `        + 'Rundock does not review extensions; what you install is your choice.',`,
    `        + '',`],

  // ===== THE RECORD REMEMBERS THE SOURCE =====
  // Forget the pin and every update check needs the URL and reference typed
  // again, which is the exact gap the record exists to close.
  [INSTALL, 'the record carries the pinned reference',
    `    installedAt: options.now || new Date().toISOString(),
    root,
  };`,
    `    installedAt: options.now || new Date().toISOString(),
    root,
  };
  record.source = { url: source.url, reference: null };`],
  // Report nothing newer and the check reads as "up to date" forever.
  [RECORD, 'the update check reports references beyond the pin',
    "  const newer = refs.filter((name) => typeof name === 'string' && name && name !== record.source.reference);",
    '  const newer = [];'],

  // ===== ONE TRANSACTION CARRIES THE INSTALL =====
  // Split the record from the files and a crash between them leaves a
  // directory nothing knows about, or a record whose files never landed.
  [INSTALL, 'the files and the record land as one unit',
    `  writeAsUnit(workspace, [
    { path: path.join(workspace, ...RECORDS_PATH.split('/')), content: serialiseRecords([...others, record]) },
  ], {
    replaceDirs: [{ path: path.join(workspace, ...root.split('/')), files }],
  });`,
    `  writeAsUnit(workspace, [], {
    replaceDirs: [{ path: path.join(workspace, ...root.split('/')), files }],
  });
  writeAsUnit(workspace, [
    { path: path.join(workspace, ...RECORDS_PATH.split('/')), content: serialiseRecords([...others, record]) },
  ]);`],

  // ===== UNINSTALL REMOVES THE RECORD =====
  [INSTALL, 'uninstall removes the record entry with the files',
    '  const remaining = records.filter((r) => r.name !== name);',
    '  const remaining = records;'],
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
  const targets = [SOURCE, MANIFEST, RECORD, INSTALL, HANDLERS, MODEL];
  const session = beginMutationRun({ files: [...new Set(targets.map((target) => target.src))] });
  const originals = new Map();
  for (const target of targets) originals.set(target, session.original(target.src));
  const results = [];
  try {
    for (const [target, label, guard, without] of MUTATIONS) {
      const original = originals.get(target);
      const matches = original.split(guard).length - 1;
      if (matches === 0) {
        results.push({ label, applied: false, red: [] });
        continue;
      }
      // A guard matching more than once is refused rather than taking the
      // first: the replacement would break whichever came first and report
      // on whatever that turns red.
      if (matches > 1) {
        results.push({ label, applied: false, ambiguous: matches, red: [] });
        continue;
      }
      fs.writeFileSync(target.src, original.replace(guard, without));
      const red = redTests(target.suite);
      results.push(red && red.unparsable
        ? { label, applied: true, unparsable: true, red: [] }
        : { label, applied: true, red });
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
  for (const { label, applied, red, ambiguous, unparsable } of results) {
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
    console.log('| Guard broken | Tests red | Which |');
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
    console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded,`
      + ' and a mutation that could break more than one place proves nothing about either.');
    process.exit(1);
  }
}

module.exports = { MUTATIONS, run };
