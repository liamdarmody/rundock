#!/usr/bin/env node
'use strict';
// Break each rule that keeps a conversation's earlier history in view once a
// transcript exists, and each that keeps Rundock's own session lines out of it
// and out of the message counts, and report which tests notice
// (lib/protocol/handlers/history.js, lib/delegation/rundock-lines.js).
//
// A conversation whose history is only in its session files, imported, seeded,
// or older than transcripts, starts a transcript with its first new message.
// The transcript then orders and attributes what is shown. Every rule below
// can be deleted with history still showing SOMETHING: the new turn alone, the
// earlier lines out of order or twice, a delegate's brief in plain view. So
// each is broken on purpose and a test must go red, one row each.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-history-guards.js            # report
//   node test/tools/mutate-history-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws. Same shape
// as its siblings (mutate-readable-error-guards.js), deliberately a separate
// copy.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const {
  beginMutationRun, targetsFromRows, rowsForShard, exitCodeFor, NO_VERDICT,
} = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

const HISTORY = path.join(ROOT, 'lib', 'protocol', 'handlers', 'history.js');
const MERGE = { src: HISTORY, suite: 'test/unit/session-history-merge.test.js' };
const MERGE_SERVER = { src: HISTORY, suite: 'test/integration/session-history.test.js' };
// Which session lines are Rundock's own, and the message counts that read them.
const LINES = { src: path.join(ROOT, 'lib', 'delegation', 'rundock-lines.js'), suite: 'test/unit/session-history-merge.test.js' };
const COUNTS = { src: path.join(ROOT, 'server.js'), suite: 'test/integration/session-history.test.js' };

const MUTATIONS = [
  // ===== THE EARLIER HISTORY =====
  // Leave it out and a conversation's first new message hides everything
  // before it, which is the defect.
  [MERGE, 'the earlier history is left out once a transcript exists',
    '        merged.push(...sessionOnlyHistory(before));\n',
    ''],
  [MERGE_SERVER, 'the earlier history is left out once a transcript exists, through the server',
    '        merged.push(...sessionOnlyHistory(before));\n',
    ''],
  // ===== WHEN THE TRANSCRIPT BEGAN =====
  // A transcript that opens with an agent turn was started by a prompt Rundock
  // sent: taking its time as the start shows that prompt as a message.
  [MERGE, 'a transcript that opens with an agent turn is taken to say when it began',
    "  return first && first.role === 'user' ? Date.parse(first.timestamp) : NaN;",
    '  return first ? Date.parse(first.timestamp) : NaN;'],
  // A clock stepped back puts the turn's own line a few milliseconds before
  // its transcript entry: taken for earlier history, the message shows twice.
  [MERGE, 'a line a few milliseconds before the start is taken for earlier history',
    'const EARLIER_MARGIN_MS = 1000;',
    'const EARLIER_MARGIN_MS = 0;'],
  [MERGE, 'a line exactly a second before the start is taken for earlier history',
    'const isEarlier = timed ? at < cut :',
    'const isEarlier = timed ? at <= cut :'],
  // Everything with a time taken for earlier history shows what the
  // transcript keeps hidden, and shows the transcript's own turns twice.
  [MERGE, 'every line with a time is taken for earlier history',
    'const isEarlier = timed ? at < cut :',
    'const isEarlier = timed ? at > 0 :'],
  // ===== LINES WITH NO TIME =====
  // Compared by time an untimed line is never earlier, and vanishes.
  [MERGE, 'an earlier line with no time is never earlier history',
    ' : !reached && Number.isFinite(cut);',
    ' : false;'],
  // Without noticing where its file reached the start, an untimed line of the
  // new turn is taken for earlier history and shown twice.
  [MERGE, 'an untimed line after its file reached the start is taken for earlier history',
    '          if (timed && at >= cut) reached = true;\n',
    ''],
  // Ordered as if it had no neighbours, an untimed line jumps to the front.
  [MERGE, 'an untimed earlier line loses its place beside the line before it',
    '          if (timed && isEarlier) lastEarlier = at;\n',
    ''],
  // ===== MATCHING THE TRANSCRIPT'S TURNS =====
  // Matched among the earlier lines too, a turn said in the same words as an
  // earlier one takes the earlier lines, and its own vanish.
  [MERGE, 'a turn\'s message is matched among the earlier lines too',
    "const match = pool.find(m => !m._used && m.role === 'user' &&",
    "const match = jsonlPool.find(m => !m._used && m.role === 'user' &&"],
  [MERGE, 'a turn\'s reply is matched among the earlier lines too',
    "const match = pool.find(m => !m._used && m.role === 'assistant' &&",
    "const match = jsonlPool.find(m => !m._used && m.role === 'assistant' &&"],
  // Walked from its place in a list that still holds the earlier history, a
  // turn's later stretches are skipped and lost.
  [MERGE, 'a turn\'s stretches are walked from its place in the whole list',
    'for (let k = pool.indexOf(match) + 1;',
    'for (let k = jsonlPool.indexOf(match) + 1;'],
  // ===== ORDER AND COPIES =====
  // File by file, a specialist's earlier reply lands after everything the
  // orchestrator said.
  [MERGE, 'the earlier history is shown file by file, not in time order',
    'jsonlPool.filter((m) => m._earlier).sort((a, b) => a._at - b._at);',
    'jsonlPool.filter((m) => m._earlier);'],
  // A resumed session's new file repeats the lines before it.
  [MERGE, 'a line a resumed file repeats is shown twice',
    '      if (seenLines.has(line)) continue;\n',
    ''],
  // ===== RUNDOCK'S OWN LINES =====
  // A prompt behind a catch-up heading opens with the heading, not its tag:
  // left off the list, every delegate's brief and every handback is shown.
  [LINES, 'a prompt behind a catch-up heading is taken for a message',
    '  ...Object.values(CATCH_UP_HEADINGS),\n',
    ''],
  [LINES, 'the <silent> sentinel is taken for a reply',
    "  return /<silent>/i.test(t) && withoutSilentSentinel(t) === '';",
    '  return false;'],
  // Without the sentinel itself in it, a reply that is only a marker would be
  // hidden too: it is narrower than the live path's test on purpose.
  [LINES, 'a reply that is only a marker is taken for the sentinel',
    "  return /<silent>/i.test(t) && withoutSilentSentinel(t) === '';",
    "  return withoutSilentSentinel(t) === '';"],
  [MERGE, 'the history shows Rundock\'s own prompts',
    "          if (m.role === 'user' && isRundockPrompt(m.content)) continue;\n",
    ''],
  [MERGE, 'the history shows the <silent> sentinel',
    "          if (m.role === 'assistant' && isRundockReply(m.content)) continue;\n",
    ''],
  // The conversation list counts what the history shows, from the same list.
  [COUNTS, 'the message count counts Rundock\'s own prompts',
    '      if (rundockLines.isRundockPrompt(obj.message.content)) continue;\n',
    ''],
  [COUNTS, 'the message count counts the <silent> sentinel',
    "      if (rundockLines.isRundockReply(textParts.join('\\n\\n'))) continue;\n",
    ''],
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
    // verdict: refused as a named row rather than thrown, so the report says
    // which mutation was in flight instead of a stack trace that names nothing.
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
      // A GUARD THAT MATCHES MORE THAN ONCE IS REFUSED RATHER THAN TAKING THE
      // FIRST: String.replace takes the first occurrence, so a search text
      // that also appears somewhere else quietly breaks the wrong code and
      // reports on whatever that turns red.
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

// REFUSE TO START ON A MACHINE THAT WOULD MISREPORT. See
// mutate-routines-guards.js for the two runs that taught this: a full temp
// root surfaces as tests going red, and red tests are exactly what this
// instrument reports as a guard nobody was watching.
function requireSaneTempRoot() {
  const verdict = preflight(os.tmpdir());
  if (verdict.ok) return;
  console.error(verdict.message);
  process.exit(NO_VERDICT);
}

if (require.main === module) {
  requireSaneTempRoot();
  if (process.argv.includes('--preflight-only')) process.exit(0);
  const results = run();
  const failed = report(results, process.argv.includes('--markdown'));
  if (failed) {
    console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded,`
      + ' and a mutation that could break more than one place proves nothing about either.');
    process.exit(exitCodeFor(failed, results));
  }
}

module.exports = { MUTATIONS, run };
