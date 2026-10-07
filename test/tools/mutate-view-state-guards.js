#!/usr/bin/env node
'use strict';
// Break each extension view state rule in turn and report which tests notice.
//
// View state is a new message on the trust boundary and a new folder on
// disk. Every rule it is held to can be deleted with the product still
// working for an honest view: a store keyed by note alone still reads back,
// a state with a Date in it still saves as something, a table that ignores
// its floor still draws. So each rule is broken on purpose here and a named
// test must go red for it, one row per rule, at both ends where the spec
// asks for both (the host and the server).
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-view-state-guards.js            # report
//   node test/tools/mutate-view-state-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws. The harness
// is the same shape as its siblings, deliberately a separate copy.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const {
  beginMutationRun, targetsFromRows, rowsForShard, exitCodeFor, NO_VERDICT,
} = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

const STORE = { src: path.join(ROOT, 'lib', 'packages', 'extension-state.js'), suite: 'test/unit/extension-state.test.js' };
const UNINSTALL = { src: path.join(ROOT, 'lib', 'packages', 'package-uninstall.js'), suite: 'test/unit/extension-state.test.js' };
const PACKAGE_UNINSTALL = { src: path.join(ROOT, 'lib', 'packages', 'package-uninstall.js'), suite: 'test/unit/package-uninstall.test.js' };
const HANDLER = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'view-state.js'), suite: 'test/unit/view-state-handler.test.js' };
const HOST = { src: path.join(ROOT, 'public', 'extension-host.js'), suite: 'test/unit/extension-view-state.test.js' };
const FRAME = { src: path.join(ROOT, 'public', 'extension-host.js'), suite: 'test/unit/extension-view-state-frame.test.js' };
const SEAM = { src: path.join(ROOT, 'public', 'views', 'files.js'), suite: 'test/unit/host-wiring.test.js' };
const TABLE = { src: path.join(ROOT, 'public', 'rundock-ui.js'), suite: 'test/unit/rundock-ui-state-key.test.js' };
const CARD = { src: path.join(ROOT, 'public', 'packages-install-model.js'), suite: 'test/unit/extension-privileges.test.js' };

const MUTATIONS = [
  // ===== THE STORE: WHERE STATE LIVES, AND WHOSE IT IS =====
  [STORE, 'state is keyed by the extension as well as the note',
    '  const folder = stateFolderFor(workspace, extension);',
    "  const folder = path.join(workspace, ...STATE_ROOT.split('/'));"],
  [STORE, 'only an installed extension has state',
    '  if (typeof extension !== \'string\' || !SLUG.test(extension) || !recordFor(readExtensionRecords(workspace), extension)) {',
    '  if (typeof extension !== \'string\' || extension.includes(\'/\')) {'],
  // The containment check, on disk: a link anywhere on the way would carry
  // a write out of Rundock's folder. (The lexical assertion beside it cannot
  // be reached behind the slug rule and the hashed file name, so its row is
  // this one.)
  [STORE, 'the resolved folder is checked on disk before any read or write',
    '  refuseLinks(workspace, file);\n',
    ''],
  [STORE, 'a note path outside the workspace is refused',
    "  if (normal === '.' || normal.startsWith('../') || normal === '..') refuse(",
    "  if (normal === '.') refuse("],
  [UNINSTALL, 'uninstalling removes the extension\'s state folder',
    '    removes.push(stateFolderFor(workspace, plan.extension.name));\n',
    ''],
  // The same removal seen from the package uninstall: the folder leaves in
  // its one transaction, and nothing else under .rundock does.
  [PACKAGE_UNINSTALL, 'a package uninstall removes its extension\'s state folder in its one transaction',
    '    removes.push(stateFolderFor(workspace, plan.extension.name));\n',
    ''],

  // ===== THE SERVER'S OWN CHECKS, PAST THE HOST =====
  [STORE, 'server: only plain JSON is kept',
    "  const problem = jsonProblem(state, 0, '', new Set());",
    '  const problem = null;'],
  [STORE, 'server: more than 16 levels is refused',
    '  if (depth >= LIMITS.depth) return',
    '  if (false) return'],
  [STORE, 'server: more than 64 KB is refused',
    '  if (Buffer.byteLength(text) > limits.noteBytes) refuse(',
    '  if (false) refuse('],
  [STORE, 'each extension is capped in total',
    '  if (grows && (bytes > limits.extensionBytes || others.length + 1 > limits.extensionNotes)) {',
    '  if (false) {'],
  [STORE, 'a write that shrinks is always allowed',
    '  const grows = Buffer.byteLength(record) > before;',
    '  const grows = true;'],
  // Judged empty by its enumerable keys before the check, a Date or an
  // object with only hidden keys would remove the kept state instead of
  // being refused.
  [STORE, 'server: a value is checked before it is taken as a removal',
    '  if (state === null || state === undefined) {',
    '  if (state === null || state === undefined || (typeof state === \'object\' && !Array.isArray(state) && Object.keys(state).length === 0)) {'],
  [STORE, 'a stored file that fails the checks reads as null',
    '    checked(kept && kept.state, LIMITS);\n',
    ''],

  // ===== THE HANDLER =====
  [HANDLER, 'state is written only for a note an extension may be handed',
    '  const refusal = extensionFileRefusal(workspace, path);\n  if (refusal) return refusal;\n',
    ''],
  [HANDLER, 'state is read only for a note an extension may be handed',
    '  const state = workspace && !extensionFileRefusal(workspace, path) ? readState(workspace, extension, path) : null;',
    '  const state = workspace ? readState(workspace, extension, path) : null;'],
  [HANDLER, 'a missing state never removes what is kept',
    "  if (!state || typeof state !== 'object' || Array.isArray(state)) return 'the view state must be an object';\n",
    ''],
  [HANDLER, 'a failure the store did not name never carries the workspace path',
    "    return NAMED.has(e && e.code) ? e.message : 'the view state could not be saved';",
    '    return e.message;'],

  // ===== THE HOST =====
  [HOST, 'an embedded view cannot write its state',
    "      if (embedded) { send({ type: 'refused', of: 'setState', reason: VIEW_STATE_REASONS.embedded }); return; }\n",
    ''],
  [HOST, 'host: only plain JSON leaves the page',
    '      const problem = viewStateProblem(data.state);',
    '      const problem = null;'],
  [HOST, 'host: more than 16 levels is refused',
    '  if (depth >= VIEW_STATE_MAX_DEPTH) return',
    '  if (false) return'],
  [HOST, 'host: size is counted in UTF-8 bytes',
    '  if (new TextEncoder().encode(JSON.stringify(state)).length > VIEW_STATE_MAX_BYTES)',
    '  if (JSON.stringify(state).length > VIEW_STATE_MAX_BYTES)'],
  [HOST, 'a stored state that fails the checks never reaches a view',
    '!viewStateProblem(opts.state) ? opts.state : null;',
    'true ? opts.state : null;'],
  [HOST, 'a server refusal reaches only a live view',
    "      if (alive && initSent && typeof reason === 'string') send({ type: 'refused', of: 'setState', reason });",
    "      send({ type: 'refused', of: 'setState', reason });"],

  // ===== THE FRAME =====
  [FRAME, 'Rundock.viewState is frozen',
    'var api=Object.freeze({',
    'var api=({'],
  [FRAME, 'window.Rundock cannot be replaced',
    'Object.defineProperty(window,"Rundock",{value:ns,enumerable:true});',
    'window.Rundock=ns;'],
  [FRAME, 'a key outside the rule throws before anything is posted',
    'if(typeof k!=="string"||!K.test(k))throw',
    'if(false)throw'],
  [FRAME, 'no key is anything but an entry',
    'Object.assign(Object.create(null),JSON.parse(',
    'Object.assign({},JSON.parse('],
  [FRAME, 'inlined state cannot end the script',
    ".replace(/</g, '\\\\u003c')",
    ''],
  [FRAME, 'a rebuilt frame opens with the last accepted state',
    '{ state: viewState });',
    '{ state: opts.state });'],

  // ===== THE SEAM =====
  [SEAM, 'a superseded mount writes nothing',
    '        if (token !== extensionSeamToken) return;\n        scheduleViewState(claim.extension, path, state);',
    '        scheduleViewState(claim.extension, path, state);'],
  [SEAM, 'a burst writes once, through the shared debounce',
    "  fileSaves.schedule(key, () => {\n    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'set_view_state', extension, path, state }));\n  }, 500);",
    "  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'set_view_state', extension, path, state }));"],
  [SEAM, 'a pending note save is written before a view state replaces it',
    '  if (fileSaves.pendingPath() && fileSaves.pendingPath() !== key) fileSaves.flush();\n',
    ''],
  [SEAM, 'a pending view state is written before a note save replaces it',
    '        if (fileSaves.pendingPath() && fileSaves.pendingPath() !== path) fileSaves.flush();\n        fileSaves.schedule(path, () => saveFileGuarded(path, nextContent, { origin: \'extension\' }), 500);',
    '        fileSaves.schedule(path, () => saveFileGuarded(path, nextContent, { origin: \'extension\' }), 500);'],
  [SEAM, 'a refusal reaches only the view it names',
    "  if (d.type === 'view_state_refused' && info && info.extension === d.extension && info.path === d.path",
    "  if (d.type === 'view_state_refused' && info"],

  // ===== THE TABLE =====
  [TABLE, 'a kept width never falls below the column\'s floor',
    'px > 0) override[i] = Math.max(minimum[i], Math.round(px));',
    'px > 0) override[i] = Math.round(px);'],
  [TABLE, 'a kept width fixes only a column that resizes',
    'if (handles[i] && override[i] === undefined && typeof px',
    'if (override[i] === undefined && typeof px'],
  [TABLE, 'only a positive width is used',
    '&& Number.isFinite(px) && px > 0) override',
    '&& Number.isFinite(px)) override'],
  [TABLE, 'a reset removes the column\'s entry',
    '        if (width === null) delete keptWidths[columns[i].key];',
    '        if (false) delete keptWidths[columns[i].key];'],
  [TABLE, 'with no stateKey the table never touches view state',
    'const store = stateKey && win.Rundock',
    'const store = win.Rundock'],
  [TABLE, 'stateKey is validated like a key',
    '/^[A-Za-z0-9._:-]{1,54}$/.test(o.stateKey)',
    '/^[A-Za-z0-9._:-]{1,64}$/.test(o.stateKey)'],

  // ===== THE CARD =====
  [CARD, 'every card says the view can keep its own settings',
    "      `It can keep up to ${facts.viewStateBytes / 1024} KB of its own settings for each note it opens, in Rundock's folder, never in your notes. Uninstalling it removes them.`,\n",
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
