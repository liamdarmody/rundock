#!/usr/bin/env node
'use strict';
// Break each guard on running an approved command outside the sandbox in turn
// and report which tests notice.
//
// A card approved for a Bash or PowerShell call with
// `dangerouslyDisableSandbox: true` leaves one use of that exact command, for
// the conversation and agent it was raised for, within a minute; the hook's
// PermissionRequest answer spends it through a route that only a hook's token
// reaches; and a refusal after an approval is said once. Every one of these
// can be deleted with the product still running, which is why each is broken
// on purpose here and a test must go red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-sandbox-override-guards.js            # report
//   node test/tools/mutate-sandbox-override-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws. The
// harness is the same shape as its siblings and deliberately a separate
// copy, for the reason recorded in mutate-routines-guards.js.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const {
  beginMutationRun, targetsFromRows, rowsForShard, exitCodeFor, NO_VERDICT,
  runSuite, didNotFinishWhy, suiteOutput,
} = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

// The grants themselves: the key, the window and the single use.
const GRANTS = { src: path.join(ROOT, 'lib', 'runtime', 'sandbox-grants.js'), suite: 'test/unit/sandbox-grants.test.js' };
// Where a card's answer records a grant, and the route that spends one.
const ROUTE_SUITE = 'test/integration/sandbox-grant-route.test.js';
const RECORDING = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'process-control.js'), suite: ROUTE_SUITE };
const ROUTE = { src: path.join(ROOT, 'lib', 'http-router.js'), suite: ROUTE_SUITE };
// The hook's PermissionRequest answer.
const HOOK = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/hook-permission-request.test.js' };
// The settings entry that has Claude Code ask the hook at all.
const SCAFFOLD = { src: path.join(ROOT, 'lib', 'workspace', 'scaffold.js'), suite: 'test/unit/scaffold-permission-request.test.js' };
// The stream reader that says a refusal after an approval.
const ENGINE = { src: path.join(ROOT, 'lib', 'delegation', 'engine.js'), suite: 'test/integration/sandbox-override-answer.test.js' };

const MUTATIONS = [
  // ===== ONLY A PERSON'S CLICK ON A CARD RECORDS =====
  // Record on any allow and the window's own answer, which no person gave,
  // leaves a command free to run outside the sandbox.
  [RECORDING, 'only an approved card records a grant',
    '      if (card && !pending.run) {',
    '      if (!pending.run) {'],
  // Record a routine's card and an unattended run's approval carries over to a
  // call nobody watched.
  [RECORDING, 'a routine\'s card never records a grant',
    '      if (card && !pending.run) {',
    '      if (card) {'],

  // ===== ONE USE OF ONE COMMAND, WITHIN THE WINDOW =====
  // Leave a spent grant in place and one approval runs the command forever.
  [GRANTS, 'a spent grant is gone',
    '  times.shift();\n',
    ''],
  // Leave the command out of the key and approving one command lets any other
  // run in its place.
  [GRANTS, 'the grant is for the exact command',
    '  return JSON.stringify([conversationId, agentId, toolName, command]);',
    '  return JSON.stringify([conversationId, agentId, toolName]);'],
  // Drop the window and an approval from long ago is still spendable.
  [GRANTS, 'a grant lives for one minute',
    '  return now - at < GRANT_WINDOW_MS;',
    '  return true;'],

  // ===== THE ROUTE ACTS ONLY FOR THE TOKEN'S CONVERSATION =====
  // Read the conversation from the body and anything holding a token spends a
  // grant meant for another conversation.
  [ROUTE, 'the conversation comes from the token, never the body',
    '        conversationId: scope.conversationId,',
    '        conversationId: data.conversationId || scope.conversationId,'],
  // Answer an unknown token like a known one and the route stops saying who
  // may use it.
  [ROUTE, 'a missing or unknown token is refused with 401',
    "    if (scope === undefined) {\n      res.writeHead(401, { 'Content-Type': 'application/json' });\n      res.end(JSON.stringify({ spent: false }));",
    "    if (false) {\n      res.writeHead(401, { 'Content-Type': 'application/json' });\n      res.end(JSON.stringify({ spent: false }));"],

  // ===== THE HOOK ALLOWS ONLY ON A SPENT GRANT =====
  // Allow on any 200 and a reply that spent nothing still runs the command.
  [HOOK, 'the hook allows only when the route says the grant was spent',
    "      finish(res.statusCode === 200 && Boolean(reply) && typeof reply === 'object' && reply.spent === true);",
    '      finish(res.statusCode === 200);'],
  // Drop the flag check and the hook asks about calls Claude Code never sends
  // it for, spending grants on them.
  [HOOK, 'the hook asks only about a call with the flag exactly true',
    "    && Boolean(input) && typeof input === 'object' && input.dangerouslyDisableSandbox === true\n",
    "    && Boolean(input) && typeof input === 'object'\n"],

  // ===== THE WORKSPACE HAS CLAUDE CODE ASK THE HOOK =====
  // Leave the entry out and an approved command is refused as before.
  [SCAFFOLD, 'the workspace settings carry the PermissionRequest entry',
    '      if (!currentAsk) keptAsk.push({ matcher: ASK_MATCHER, hooks: [hookCommand(10)] });\n',
    ''],

  // ===== A REFUSAL IS SAID ONLY AFTER AN APPROVAL =====
  // Say it for any refusal and the conversation claims an approval nobody gave.
  [ENGINE, 'the notice follows only a command whose card was approved',
    '  if (!approved) return null;\n',
    ''],
];

const REPORTER = ['--test-reporter', 'spec'];

async function redTests(suite) {
  let out = '';
  let failed = false;
  try {
    out = await runSuite('node', ['--test', ...REPORTER, suite], { cwd: ROOT });
  } catch (e) {
    if (e.didNotFinish) return { didNotFinish: e.didNotFinish };
    failed = true;
    out = (e.stdout || '') + (e.stderr || '');
  }
  const marker = out.indexOf('failing tests:');
  if (marker === -1) {
    if (!failed) return [];
    // A suite that failed with output this could not read has produced no
    // verdict: not red, not green, nothing. Refused as a named row rather
    // than thrown, so the report says which mutation was in flight instead
    // of a stack trace that names nothing.
    return { unparsable: true };
  }
  const names = [];
  for (const line of out.slice(marker).split('\n')) {
    const m = /^✖ (.+?) \(\d/.exec(line.trim());
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

async function run() {
  // Derived from the rows, never kept by hand, so a row can never name a
  // target the run does not hold.
  const targets = targetsFromRows(MUTATIONS);
  const session = beginMutationRun({ files: [...new Set(targets.map((target) => target.src))] });
  const originals = new Map();
  for (const target of targets) originals.set(target, session.original(target.src));
  const results = [];
  try {
    for (const [target, label, guard, without] of rowsForShard(MUTATIONS)) {
      const original = originals.get(target);
      const matches = original.split(guard).length - 1;
      if (matches === 0) {
        results.push({ label, applied: false, red: [] });
        continue;
      }
      if (matches > 1) {
        results.push({ label, applied: false, ambiguous: matches, red: [] });
        continue;
      }
      fs.writeFileSync(target.src, original.replace(guard, without));
      const red = await redTests(target.suite);
      if (red && red.didNotFinish) results.push({ label, applied: true, didNotFinish: red.didNotFinish, output: suiteOutput(), red: [] });
      else results.push(red && red.unparsable
        ? { label, applied: true, unparsable: true, output: suiteOutput(), red: [] }
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
  for (const { label, applied, red, ambiguous, unparsable, didNotFinish } of results) {
    if (didNotFinish) {
      failed++;
      const why = didNotFinishWhy(didNotFinish);
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  ${why.toUpperCase()}`);
      continue;
    }
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
  process.exit(NO_VERDICT);
}

if (require.main === module) {
  requireSaneTempRoot();
  if (process.argv.includes('--preflight-only')) process.exit(0);
  run().then((results) => {
    const failed = report(results, process.argv.includes('--markdown'));
    if (failed) {
      console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded,`
        + ' and a mutation that could break more than one place proves nothing about either.');
      process.exit(exitCodeFor(failed, results));
    }
  });
}

module.exports = { MUTATIONS, run };
