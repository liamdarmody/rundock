#!/usr/bin/env node
'use strict';
// Break each rule that makes Rundock read Claude Code's own files from where
// Claude Code keeps them, and report which tests notice
// (lib/runtime/claude-home.js and its four readers: history in server.js, the
// transcript reader, the Connectors route and the sandbox status), and keep
// search's remembered session paths and its index on the folder in use.
//
// With CLAUDE_CONFIG_DIR set, Claude Code keeps its transcripts, its user
// settings and its account file in that folder and nothing in home. Every rule
// below can be broken with Rundock still showing SOMETHING: history from an
// old session in home, connectors the person removed long ago, a sandbox
// state from a file Claude Code no longer reads. So each is broken on purpose
// and a test must go red, one row each.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-claude-config-dir-guards.js            # report
//   node test/tools/mutate-claude-config-dir-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws. Same shape
// as its siblings (mutate-history-guards.js), deliberately a separate copy.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const {
  beginMutationRun, targetsFromRows, rowsForShard, exitCodeFor, NO_VERDICT,
  runSuite, didNotFinishWhy, suiteOutput,
} = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

const UNIT = 'test/unit/claude-home.test.js';
const SERVER_SUITE = 'test/integration/claude-config-dir.test.js';
const MODULE = { src: path.join(ROOT, 'lib', 'runtime', 'claude-home.js'), suite: UNIT };
const MODULE_SERVER = { src: path.join(ROOT, 'lib', 'runtime', 'claude-home.js'), suite: SERVER_SUITE };
const HISTORY = { src: path.join(ROOT, 'server.js'), suite: SERVER_SUITE };
const TRANSCRIPTS = { src: path.join(ROOT, 'lib', 'runtime', 'session-transcript.js'), suite: UNIT };
const CONNECTORS = { src: path.join(ROOT, 'lib', 'http-router.js'), suite: SERVER_SUITE };
const SANDBOX = { src: path.join(ROOT, 'lib', 'workspace', 'sandbox-status.js'), suite: UNIT };
const SEARCH_INDEX = { src: path.join(ROOT, 'search.js'), suite: SERVER_SUITE };

const MUTATIONS = [
  // ===== A READER JOINS CLAUDE CODE'S FOLDER ONTO HOME AGAIN =====
  // Each reads home's copy, which with the variable set is a folder Claude
  // Code is not using.
  [HISTORY, 'history joins Claude Code\'s folder onto home again',
    "  try { projectsDir = path.join(claudeHome(home).folder, 'projects'); } catch (e) { return null; }",
    "  try { projectsDir = path.join(home, '.claude', 'projects'); } catch (e) { return null; }"],
  [TRANSCRIPTS, 'the transcript reader joins Claude Code\'s folder onto home again',
    "  return claude.relocated || home ? path.join(claude.folder, 'projects') : null;",
    "  return home ? path.join(home, '.claude', 'projects') : null;"],
  [CONNECTORS, 'the Connectors route joins the account file onto home again',
    '      claudeUserGlobal = readOne(claudeHome(home).accountState);',
    "      claudeUserGlobal = readOne(path.join(home, '.claude.json'));"],
  [SANDBOX, 'the sandbox status joins the user settings file onto home again',
    "  const file = path.join(claude.folder, 'settings.json');",
    "  const file = path.join(home, '.claude', 'settings.json');"],
  // ===== READ AT LOAD =====
  // Read once, a value set after start is never seen, and one removed is
  // still followed.
  [MODULE, 'the folder is read once at load instead of at each call',
    "function claudeHome(home) {\n  const moved = hook.relocatedRuntimeHomes(process.env).find((row) => row.runtime === 'claude');\n",
    "const MOVED = hook.relocatedRuntimeHomes(process.env).find((row) => row.runtime === 'claude');\nfunction claudeHome(home) {\n  const moved = MOVED;\n"],
  [MODULE_SERVER, 'the folder is read once at load instead of at each call, through the server',
    "function claudeHome(home) {\n  const moved = hook.relocatedRuntimeHomes(process.env).find((row) => row.runtime === 'claude');\n",
    "const MOVED = hook.relocatedRuntimeHomes(process.env).find((row) => row.runtime === 'claude');\nfunction claudeHome(home) {\n  const moved = MOVED;\n"],
  // ===== THE ACCOUNT FILE =====
  // Claude Code keeps it at the top of the variable's folder: left in home,
  // the route reads `<home>/.claude.json` while the variable is set.
  [MODULE_SERVER, 'the Connectors route reads the account file in home while the variable is set',
    "  if (moved) return { folder: moved.value, accountState: path.join(moved.value, '.claude.json'), relocated: true };",
    "  if (moved) return { folder: moved.value, accountState: path.join(home, '.claude.json'), relocated: true };"],
  // ===== THE FALLBACK SCAN =====
  [HISTORY, 'the session lookup\'s fallback scan still scans home',
    "      const candidate = path.join(projectsDir, dir, sessionId + '.jsonl');",
    "      const candidate = path.join(home, '.claude', 'projects', dir, sessionId + '.jsonl');"],
  // ===== WHEN THE FOLDER CANNOT BE WORKED OUT =====
  // Nothing is found, and home is never read in its place.
  [HISTORY, 'history reads home when the folder cannot be worked out',
    "  try { projectsDir = path.join(claudeHome(home).folder, 'projects'); } catch (e) { return null; }",
    "  try { projectsDir = path.join(claudeHome(home).folder, 'projects'); } catch (e) { projectsDir = path.join(home, '.claude', 'projects'); }"],
  [TRANSCRIPTS, 'the transcript reader reads home when the folder cannot be worked out',
    '  const claude = claudeHome(home);\n',
    "  let claude;\n  try { claude = claudeHome(home); } catch (e) { return home ? path.join(home, '.claude', 'projects') : null; }\n"],
  [CONNECTORS, 'the Connectors route reads home when the folder cannot be worked out',
    "      claudeUserGlobal = { text: null, missing: false, error: 'Could not work out where Claude Code keeps its account file, so your user-global Claude Code connectors are not shown here.' };",
    "      claudeUserGlobal = readOne(path.join(home, '.claude.json'));"],
  [SANDBOX, 'the sandbox status reads home when the folder cannot be worked out',
    '  try { claude = claudeHome(home); } catch (e) { return layers; }',
    "  try { claude = claudeHome(home); } catch (e) { claude = { folder: path.join(home, '.claude'), relocated: false }; }"],
  // ===== NO HOME =====
  // The variable names the folder whether or not there is a home.
  [TRANSCRIPTS, 'with no home, the transcript reader ignores the variable',
    "  return claude.relocated || home ? path.join(claude.folder, 'projects') : null;",
    "  return home ? path.join(claude.folder, 'projects') : null;"],
  // ===== THE ROW'S LABEL =====
  [SANDBOX, 'the sandbox status names the moved settings file as home\'s',
    "  layers.push({ label: claude.relocated ? file : '~/.claude/settings.json', file });",
    "  layers.push({ label: '~/.claude/settings.json', file });"],
  // ===== A REMEMBERED SESSION PATH AFTER A FOLDER CHANGE =====
  // The path lookup search uses remembers each answer. Remembered across a
  // folder change, a hit names a transcript Claude Code no longer uses and a
  // miss hides one it does, until something clears the memory.
  [HISTORY, 'a remembered session path is served after a folder change',
    '  if (memo && memo.folder === folder) {',
    '  if (memo) {'],
  [HISTORY, 'only a remembered hit is checked against the folder',
    '  if (memo && memo.folder === folder) {',
    '  if (memo && (memo.folder === folder || !memo.path)) {'],
  [HISTORY, 'only a remembered miss is checked against the folder',
    '  if (memo && memo.folder === folder) {',
    '  if (memo && (memo.folder === folder || memo.path)) {'],
  [HISTORY, 'the folder a remembered path is checked against is read once at load',
    'function resolveSessionPathCached(sessionId) {\n  const now = Date.now();\n  const folder = claudeFolderNow();\n',
    'const FOLDER_AT_LOAD = claudeFolderNow();\nfunction resolveSessionPathCached(sessionId) {\n  const now = Date.now();\n  const folder = FOLDER_AT_LOAD;\n'],
  [HISTORY, 'a remembered path is checked against home\'s folder when the folder cannot be worked out',
    '  try { return claudeHome(home).folder; } catch (e) { return null; }',
    "  try { return claudeHome(home).folder; } catch (e) { return path.join(home, '.claude'); }"],
  // Not recorded, no entry ever matches, so nothing is remembered at all: a
  // miss no longer holds within its window.
  [HISTORY, 'a remembered path does not record its folder',
    '  _sessionPathMemo.set(sessionId, { path: resolved || null, ts: now, folder });',
    '  _sessionPathMemo.set(sessionId, { path: resolved || null, ts: now });'],
  // The search index's mark for a session read from another file: kept, the
  // index goes on finding what the old transcript said.
  [SEARCH_INDEX, 'the index keeps a session\'s rows when the session is read from another file',
    '        const wipe = inherit || replaced || st.size < mark.byte_offset || st.size < mark.size;',
    '        const wipe = inherit || st.size < mark.byte_offset || st.size < mark.size;'],
  [SEARCH_INDEX, 'the index skips a session read from another file of the same size and time',
    '        if (!inherit && !replaced && st.mtimeMs === mark.mtime_ms && st.size === mark.size) continue;',
    '        if (!inherit && st.mtimeMs === mark.mtime_ms && st.size === mark.size) continue;'],
];

// The reporter is named explicitly rather than left to the default, which
// varies with whether stdout is a TTY.
const REPORTER = ['--test-reporter=spec', '--test-reporter-destination=stdout'];

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

async function run() {
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
