'use strict';
// A mutation harness shaped like the ones under test/tools, run over a
// throwaway repository by test/unit/mutation-row-time-limit.test.js.
//
// It arms the same envelope, takes its slice of rows the same way, starts each
// row's suite through the same runner, reads the spec reporter's output the
// way those harnesses do, and reports and exits the way they do. What differs
// is where its rows come from: a JSON file, so each case can stage its own
// suites, and the runner's limit and grace, which only this fixture lowers so
// a case can watch a row run out of time in seconds rather than minutes.
//
//   node harness.js <repo> '<config as JSON>' [--markdown] [--rows a:b]
//
// config: { rows: [{ suite, label, guard, without }], limitMs, graceMs,
//           spawnThrows, command }
// `suite` is a file in this folder. `spawnThrows` makes starting any suite
// throw, the control failing on the runner's side. `command` replaces node as
// what starts each suite, so a case can name one the system cannot find.

const fs = require('node:fs');
const path = require('node:path');

const [root, configJson] = process.argv.slice(2);
const config = JSON.parse(configJson);
// Replaced before the runner is loaded, so it is the runner's own call that
// throws, as it would for a suite the system refuses to start.
if (config.spawnThrows) {
  require('node:child_process').spawn = () => { throw new Error('the suite could not be started'); };
}

const {
  beginMutationRun, targetsFromRows, rowsForShard, exitCodeFor, runSuite, didNotFinishWhy, suiteOutput,
} = require('../../tools/mutation-run.js');

const SRC = path.join(root, 'src.js');
const targets = new Map();
const MUTATIONS = config.rows.map(({ suite, label, guard, without }) => {
  if (!targets.has(suite)) targets.set(suite, { src: SRC, suite: path.join(__dirname, suite) });
  return [targets.get(suite), label, guard, without];
});
const LIMITS = {
  ...(config.limitMs ? { limitMs: config.limitMs } : {}),
  ...(config.graceMs ? { graceMs: config.graceMs } : {}),
};
const REPORTER = ['--test-reporter', 'spec'];

async function redTests(suite) {
  let out = '';
  let failed = false;
  try {
    out = await runSuite(config.command || 'node', ['--test', ...REPORTER, suite], { cwd: root, ...LIMITS });
  } catch (e) {
    if (e.didNotFinish) return { didNotFinish: e.didNotFinish };
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

async function run() {
  const rowTargets = targetsFromRows(MUTATIONS, { root });
  const session = beginMutationRun({ root, files: [SRC], suites: rowTargets.map((t) => t.suite) });
  const original = session.original(SRC);
  const results = [];
  try {
    for (const [target, label, guard, without] of rowsForShard(MUTATIONS)) {
      const matches = original.split(guard).length - 1;
      if (matches !== 1) { results.push({ label, applied: false, ambiguous: matches > 1 ? matches : 0, red: [] }); continue; }
      fs.writeFileSync(target.src, original.replace(guard, without));
      const red = await redTests(target.suite);
      if (red && red.didNotFinish) results.push({ label, applied: true, didNotFinish: red.didNotFinish, output: suiteOutput(), red: [] });
      else results.push(red && red.unparsable ? { label, applied: true, unparsable: true, output: suiteOutput(), red: [] } : { label, applied: true, red });
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
    if (!applied) {
      failed++;
      const why = ambiguous ? `the guard text matches ${ambiguous} places` : 'the guard text was not found, so nothing was mutated';
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  ${why.toUpperCase()}`);
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

if (require.main === module) {
  run().then((results) => {
    const failed = report(results, process.argv.includes('--markdown'));
    if (failed) {
      console.error(`\n${failed} mutation(s) proved nothing.`);
      process.exit(exitCodeFor(failed, results));
    }
  });
}
