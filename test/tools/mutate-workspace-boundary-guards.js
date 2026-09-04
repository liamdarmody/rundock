#!/usr/bin/env node
'use strict';
// Break each of the boundary's guards in turn and report which tests notice.
//
// Every rule here is a rule about a card that fires or stays quiet, and both
// failure directions are quiet ones: a guard deleted leaves inside paths
// carding (the storm this lane exists to end) or outside paths sliding by.
// A green suite proves nothing about either until each rule is broken on
// purpose and a test goes red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-workspace-boundary-guards.js            # report
//   node test/tools/mutate-workspace-boundary-guards.js --markdown # as a table
//
// The files are restored afterwards, including when a run throws. Same shape
// as the sibling harnesses, deliberately a separate copy: see
// mutate-routines-guards.js for the reason.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

const HOOK = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/workspace-boundary.test.js' };
const SCAFFOLD = { src: path.join(ROOT, 'lib', 'workspace', 'scaffold.js'), suite: 'test/unit/workspace-boundary.test.js' };
const BOUNDARY = { src: path.join(ROOT, 'lib', 'workspace', 'boundary.js'), suite: 'test/unit/workspace-boundary.test.js' };
const CHAT_VIEW = { src: path.join(ROOT, 'public', 'views', 'chat.js'), suite: 'test/unit/boundary-card.test.js' };
const SETTINGS_VIEW = { src: path.join(ROOT, 'public', 'views', 'settings.js'), suite: 'test/unit/workspace-boundary.test.js' };

const MUTATIONS = [
  // ===== ONE DIRECTORY UNDER TWO NAMES IS ONE IDENTITY =====
  // Compare unresolved again and every symlink, alias and case spelling of
  // an inside path reads as outside: the false-positive half of the storm.
  [HOOK, 'file targets are canonicalised before the comparison',
    '  const resolvedPath = canonicalize(path.resolve(workspaceRoot, target));',
    '  const resolvedPath = path.resolve(workspaceRoot, target);'],
  [HOOK, 'the roots are canonicalised too, or a symlink-opened workspace denies its own files',
    '  return [canonicalize(workspaceRoot, pmod), ...extraDirs.map(d => canonicalize(d, pmod))];',
    '  return [pmod.resolve(workspaceRoot), ...extraDirs.map(d => pmod.resolve(d))];'],
  // A grant stored under one spelling must cover the other, both directions.
  [BOUNDARY, 'grants are canonicalised on write and on read',
    '  const t = canonicalize(targetPath);',
    '  const t = path.resolve(targetPath);'],

  // ===== THE BLOCK NAMES THE MEASURED PLUMBING =====
  // Drop the runtime home from the measured roots and the field storm is
  // back; the shape test and the doc binding both have to notice.
  [SCAFFOLD, 'the runtime home is a measured writable root',
    "    path.posix.join(home, '.claude'),\n",
    ''],
  // Refuse the legacy shape and every workspace the two-root release wrote
  // treats its own block as a person's edit, denying the plumbing forever.
  [SCAFFOLD, 'the two-root release\'s block is still recognised as ours',
    '  if (sameSandbox(block, legacySandboxSettings(claimedWorkspace, claimedHome))) return true;\n',
    ''],
  // Demand this machine's exact temp tail and a workspace opened on another
  // machine is never recognised, so it never reconciles.
  [SCAFFOLD, 'another machine\'s temp tail is ours to reconcile, not a stranger\'s edit',
    "  if (!tail.every(t => typeof t === 'string' && t.length > 0)) return false;",
    '  if (JSON.stringify(tail) !== JSON.stringify(tempRoots())) return false;'],
  // Drop the pairing check and a root a person appends, sitting in the
  // second tail slot, is structurally indistinguishable from a legitimate
  // temp-directory real path: the block is read as ours and their root is
  // rewritten away on the next reconcile.
  [SCAFFOLD, 'a second tail entry must be the first entry\'s own /private pairing, or it is somebody\'s edit',
    "  if (tail.length === 2 && tail[1] !== path.posix.join('/private', tail[0])) return false;\n",
    ''],

  // ===== THE SWITCH WITHDRAWS HONESTLY =====
  // Ignore the choice and the off switch writes the block anyway.
  [SCAFFOLD, 'opting out really withdraws the block',
    '  const desired = off ? null : sandboxSettings(dir, platform);',
    '  const desired = sandboxSettings(dir, platform);'],
  // Ignore the choice on the NEXT OPEN specifically, not through the switch:
  // scaffoldWorkspace's own reconcile has to read the opt-out too, or an
  // opted-out workspace has its block silently rewritten the next time it is
  // opened.
  [SCAFFOLD, 'the next open honours an existing opt-out, not only the switch',
    '    const desired = sandboxOptedOut(dir) ? null : sandboxSettings(dir, platform);',
    '    const desired = sandboxSettings(dir, platform);'],

  // ===== THE SENSITIVE TABLE AND THE NARROW GRANT =====
  // Empty the table and a crossing into the runtime home renders the
  // ordinary card, stakes unstated.
  [HOOK, 'the runtime home is in the sensitive table',
    "  return [{ id: 'claude-home', root: path.join(home, '.claude') }];",
    '  return [];'],
  // Trust the derived name without checking the layout and a scheme drift
  // grants a folder the runtime never meant.
  [HOOK, 'the narrow grant is offered only when the layout confirms it',
    '    return entries.includes(flattened) ? derived : null;',
    '    return derived;'],
  // Drop the grantable gate and the narrow-grant button renders on a shell
  // crossing, which would let approving a command leave behind a standing
  // folder grant: the exact regression 'a shell request never carries a
  // standing folder grant' exists to prevent.
  [CHAT_VIEW, 'the narrow grant is offered only where a folder grant may be remembered at all',
    '  const sensNarrow = grantable && sensitiveCrossing ? sensitiveCrossing.narrowGrantDir || null : null;',
    '  const sensNarrow = sensitiveCrossing ? sensitiveCrossing.narrowGrantDir || null : null;'],

  // ===== THE VIEW MODULE'S EXPORT CONTRACT =====
  // Un-republish the sandbox card's render and toggle functions and the WS
  // dispatch and the card's own onclick markup resolve against nothing: the
  // control exists in markup but throws ReferenceError on every click.
  [SETTINGS_VIEW, 'the sandbox card\'s render and toggle functions are republished, not just declared',
    '  renderSandboxCard, setSandboxMode,\n',
    ''],
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
  const targets = [HOOK, SCAFFOLD, BOUNDARY, CHAT_VIEW, SETTINGS_VIEW];
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
      // A GUARD THAT MATCHES MORE THAN ONCE IS REFUSED RATHER THAN TAKING THE
      // FIRST: String.replace takes the first occurrence, so a search text
      // that also appears somewhere else quietly breaks the wrong code and
      // reports on whatever that turns red.
      if (matches > 1) {
        results.push({ label, applied: false, ambiguous: matches, red: [] });
        continue;
      }
      fs.writeFileSync(target.src, original.replace(guard, without));
      results.push({ label, applied: true, red: redTests(target.suite) });
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
  for (const { label, applied, red, ambiguous } of results) {
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

// REFUSE TO START ON A MACHINE THAT WOULD MISREPORT. See
// mutate-routines-guards.js for the two runs that taught this: a full temp
// root surfaces as tests going red, and red tests are exactly what this
// instrument reports as a guard nobody was watching.
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
