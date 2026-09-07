#!/usr/bin/env node
'use strict';
// Break each of the extension host's wiring rules in turn and report which
// tests notice.
//
// The joins between the host and the client are each one line that can be
// deleted with the product still drawing SOMETHING: the roster still
// arrives, the file still opens, the plain surface still paints. That is why
// each is broken on purpose here and a test must go red for it. A guard
// whose mutation turns nothing red is reported as a FAILURE rather than
// passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-host-wiring-guards.js            # report
//   node test/tools/mutate-host-wiring-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws. The
// harness is the same shape as its siblings and deliberately a separate
// copy, for the reason stated in mutate-routines-guards.js.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

// The roster reader over the install store, watched by the handler suite
// that reads a temporary workspace carrying that store.
const SERVER = { src: path.join(ROOT, 'lib', 'packages', 'extension-registry.js'), suite: 'test/unit/protocol-handlers-lib.test.js' };
// The host, watched by the suite that reads init off the wire and compares
// the contract document against the exported tables and cap.
const HOST = { src: path.join(ROOT, 'public', 'extension-host.js'), suite: 'test/unit/extension-host.test.js' };
// The client wiring, the seam's mount lifecycle, the registry's failure
// answer and the frame's stylesheet, all watched by the wiring suite that
// cuts them out and runs them.
const APP = { src: path.join(ROOT, 'public', 'app.js'), suite: 'test/unit/host-wiring.test.js' };
const FILES = { src: path.join(ROOT, 'public', 'views', 'files.js'), suite: 'test/unit/host-wiring.test.js' };
const REGISTRY = { src: path.join(ROOT, 'public', 'renderer-registry.js'), suite: 'test/unit/host-wiring.test.js' };
const SHEET = { src: path.join(ROOT, 'public', 'styles', 'components', 'extension-frame.css'), suite: 'test/unit/host-wiring.test.js' };
// The file tree's filter, watched by the handler suite that builds a tree
// over a workspace carrying the install store.
const TREE = { src: path.join(ROOT, 'server.js'), suite: 'test/unit/protocol-handlers-lib.test.js' };

const MUTATIONS = [
  // ===== ONE STORE =====
  // Point the extension root back at the retired per-directory layout and a
  // payload for an installed extension reads from a directory nothing
  // writes to.
  [SERVER, 'the payload reads the install store, not the retired per-directory layout',
    "const EXTENSIONS_ROOT = '.claude/rundock/extensions';",
    "const EXTENSIONS_ROOT = '.rundock/plugins';"],
  // Point the roster at the retired state file and the records the install
  // flow writes are read by nothing.
  [SERVER, 'the roster reads the records file the install flow writes',
    "const RECORDS_PATH = '.claude/rundock/extensions.json';",
    "const RECORDS_PATH = '.rundock/plugin-state.json';"],
  // Widen the match grammar and a rule the registry can never honour turns
  // into a claim that silently renders nothing.
  [SERVER, 'only a match of the form *.<ext> becomes a claim',
    "const SIMPLE_MATCH = /^\\*\\.([A-Za-z0-9][A-Za-z0-9-]*)$/;",
    "const SIMPLE_MATCH = /^.*\\.([A-Za-z0-9][A-Za-z0-9-]*)$/;"],
  // Require enabled to be stated and every freshly installed extension is
  // off.
  [SERVER, 'an absent enabled field means enabled',
    '      enabled: record.enabled !== false,',
    '      enabled: record.enabled === true,'],
  // Treat a broken records file as empty and "your records are broken"
  // reads as "you have no extensions".
  [SERVER, 'an unreadable records file is a refusal, never an empty roster',
    '    throw new TypeError(`extension records unreadable: ${e.message}`);',
    '    return [];'],
  // Serve any renderer id and the roster and the payload stop agreeing on
  // what a renderer is.
  [SERVER, 'the one renderer id is the only one served',
    '  if (rendererId !== RENDERER_ID) {',
    '  if (false) {'],

  // Restore the fixed filter and a file an installed extension renders is
  // never listed, so the roster's claim can never be opened from the tree.
  [TREE, 'the tree lists what an enabled record claims, beside the built-in kinds',
    '      } else if (VIEWABLE_FILE_RE.test(item.name) || (claimed && claimed.test(item.name))) {',
    '      } else if (VIEWABLE_FILE_RE.test(item.name)) {'],
  // Stop the freshness pass reading the records file and a disabled record
  // goes on being listed until some directory happens to change.
  [TREE, 'a records change alone makes the cached tree stale',
    '  if (_treeCache.records !== extensionRecordsMtime()) return false;\n',
    ''],

  // ===== THE INIT MESSAGE =====
  // Strip the file from init and a renderer has nothing to render.
  [HOST, 'init carries the opened file and the theme',
    "      send({ type: 'init', path: filePath, content, theme: currentTheme(doc) });",
    "      send({ type: 'init' });"],
  // Drop the cap and any size of file is handed to a frame.
  [HOST, 'text over the cap is never handed to a frame',
    '  if (content.length > MAX_INIT_CONTENT_CHARS) {',
    '  if (false) {'],
  // Move the cap without the document and the two promise different limits.
  [HOST, 'the document states the cap the host enforces',
    'export const MAX_INIT_CONTENT_CHARS = 2000000;',
    'export const MAX_INIT_CONTENT_CHARS = 2000001;'],
  // Hard-code the theme and a light page tells its frames it is dark.
  [HOST, 'the theme is read from the body class at mount time',
    "  return doc.body && doc.body.classList.contains('light') ? 'light' : 'dark';",
    "  return 'dark';"],

  // ===== THE ROSTER JOIN =====
  [APP, 'the roster is registered through the registry module\'s own constructor',
    '    registry.registerFromRoster(roster);\n',
    ''],
  // Drop the sequence guard and the roster whose module resolves last wins,
  // whichever workspace it came from.
  [APP, 'the last roster is the truth, whatever order the module loads resolve',
    '    if (seq !== extensionRosterSeq) return null;\n',
    ''],
  // Keep the previous registry on an error and the old workspace's claims
  // answer for the new one.
  [APP, 'a roster error installs an empty registry, never the previous one',
    '  return installRendererRegistry((mod) => mod.createRendererRegistry({ unavailable: reason }));',
    '  return Promise.resolve(null);'],
  [APP, 'the roster is requested in the startup batch',
    "  ws.send(JSON.stringify({ type: 'list_extensions' }));\n",
    ''],
  [APP, 'every roster arrival reconciles the live mount',
    '    if (registry) reconcileExtensionMount(roster);\n',
    ''],
  [APP, 'a roster reply reaches the registry through the dispatch',
    "    case 'extensions': extensionRosterArrived(d); break;\n",
    ''],
  [REGISTRY, 'an empty registry carries the roster failure as every answer\'s reason',
    '      if (unavailable) return { registered: false, reason: unavailable };\n',
    ''],

  // ===== THE TRANSPORT =====
  // Key by extension alone and two renderers of one extension take each
  // other's payload.
  [APP, 'a fetch is correlated by extension id plus renderer id',
    '  return `${extensionId} ${rendererId}`;',
    '  return String(extensionId);'],
  // Remove the clock and a reply that never comes leaves the pane blank.
  [APP, 'a reply that never comes settles by the clock',
    '    waiter.timer = setTimeout(() => {\n      waiter.settle({ extensionId, rendererId, reason: `no renderer payload arrived within ${timeoutMs}ms` });\n    }, timeoutMs);\n',
    ''],
  [APP, 'a closed socket settles every fetch in flight',
    "      waiter.settle({ reason: 'the connection closed before the renderer payload arrived' });\n",
    ''],

  // ===== TEARDOWN AND RECONCILE =====
  // Keep the file open across a workspace switch and the previous
  // workspace's frame stays in the pane with its mediator listening.
  [APP, 'a different workspace closes the open file, which releases the mount',
    '  closeOpenFile();\n  conversations = [];',
    '  conversations = [];'],
  [FILES, 'the mount is handed the opened file',
    "      // after ready. The host's cap applies here as it does to any caller.\n      path,\n      content,\n",
    ''],
  [FILES, 'an extension absent from the roster is torn down',
    '  if (!entry || entry.enabled === false) {',
    '  if (entry && entry.enabled === false) {'],
  [FILES, 'a disabled extension is torn down',
    '  if (!entry || entry.enabled === false) {',
    '  if (!entry) {'],
  [FILES, 'a different version swaps and the same version is left alone',
    "  if (version === info.version) return { action: 'kept' };",
    "  if (version !== info.version) return { action: 'kept' };"],
  [FILES, 'a swap mounts the freshly fetched payload',
    '    activeExtensionMount = mount.swap(payload);',
    '    activeExtensionMount = mount;'],
  [FILES, 'a late swap is abandoned when the mount was released meanwhile',
    '    if (token !== extensionSeamToken || activeExtensionMount !== mount) return;\n    if (!payload',
    '    if (!payload'],
  [FILES, 'releasing the mount forgets what was mounted',
    '  activeExtensionMountInfo = null;\n}\n\n// The live mount\'s identity',
    '}\n\n// The live mount\'s identity'],
  // Route the frame's open around the resolver and a bare name opens the
  // wrong file, or none.
  [FILES, 'the frame\'s open goes through the wikilink resolver',
    '      onOpen: (target) => openWikilink(target),',
    '      onOpen: (target) => openWorkspaceFilePath(target),'],

  // ===== THE STYLESHEET =====
  [SHEET, 'the frame\'s floor is the host\'s floor',
    'min-height: 40px;',
    'min-height: 0;'],
  [SHEET, 'the frame paints its surface through a token',
    'background: var(--surface);',
    'background: #212121;'],
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

function run() {
  const targets = [SERVER, HOST, APP, FILES, REGISTRY, SHEET, TREE];
  const session = beginMutationRun({ files: [...new Set(targets.map((t) => t.src))] });
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
