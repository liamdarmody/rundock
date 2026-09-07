#!/usr/bin/env node
'use strict';
// Break each of the Packages page's manage rules in turn and report which
// tests notice.
//
// Each rule is a promise to a person managing what they installed, and each
// can be deleted with the page still drawing SOMETHING, so each is broken on
// purpose here and a test must go red for it. A mutation that turns nothing
// red is reported as a FAILURE rather than passed over.
//
//   node test/tools/mutate-packages-manage-guards.js            # report
//   node test/tools/mutate-packages-manage-guards.js --markdown # as a table
//
// Files are restored afterwards, including when a run throws; the shape is
// a deliberate separate copy, for the reason in mutate-routines-guards.js.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');
// Each row names its suite as a literal beside its target: the scoped gate reads both statically.
const MODEL = { src: path.join(ROOT, 'public', 'packages-manage-model.js'), suite: 'test/unit/packages-manage-model.test.js' };
const INSTALL_MODEL = { src: path.join(ROOT, 'public', 'packages-install-model.js'), suite: 'test/unit/packages-manage-model.test.js' };
const MANAGE = { src: path.join(ROOT, 'lib', 'packages', 'extension-manage.js'), suite: 'test/unit/packages-manage.test.js' };
const REGISTRY = { src: path.join(ROOT, 'lib', 'packages', 'extension-registry.js'), suite: 'test/unit/packages-manage.test.js' };
const HANDLERS = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'packages.js'), suite: 'test/unit/packages-manage.test.js' };
const SETTINGS_VIEW = { src: path.join(ROOT, 'public', 'views', 'settings.js'), suite: 'test/unit/packages-manage.test.js' };
const APP = { src: path.join(ROOT, 'public', 'app.js'), suite: 'test/unit/packages-manage.test.js' };
const INDEX = { src: path.join(ROOT, 'public', 'index.html'), suite: 'test/unit/packages-manage.test.js' };
const SHEET = { src: path.join(ROOT, 'public', 'styles', 'views', 'settings.css'), suite: 'test/unit/packages-manage.test.js' };

const MUTATIONS = [
  // ===== ONE CHIP LEADS, AND IT TELLS THE TRUTH =====
  [MODEL, 'a failed update keeps the Enabled chip, never a Failed one',
    "      row.chip = chip('enabled');\n      row.note = { text: `Update to",
    "      row.chip = chip('install-failed');\n      row.note = { text: `Update to"],
  [MODEL, 'an ordinary pending update takes the attention chip, not danger',
    "      row.chip = chip('update-available');", "      row.chip = chip('broken');"],
  [MODEL, 'disabled with an update waiting says so in prose beneath the one chip',
    "      if (newer) row.note = { text: `${newer} is available. Re-enabling does not update it automatically.`, tone: 'attention' };\n", ''],
  // ===== WHAT IS SENT, AND WHEN =====
  [MODEL, 'uninstall sends nothing before its confirmation is answered',
    '    if (state.confirming !== name) return { state };\n', ''],
  [MODEL, 'a check carries the name and never a url',
    "    return ask(state, 'update-check', name, { type: 'check_extension_update', name });",
    "    return ask(state, 'update-check', name, { type: 'check_extension_update', name, url: entryFor(state, name).source.url });"],
  [MODEL, 'a second action waits while one is in flight',
    '    if (state.busy || !entryFor(state, name)) return { state };', '    if (!entryFor(state, name)) return { state };'],
  [INSTALL_MODEL, 'the update plan carries the name and the reference, never a url',
    "      send: { type: 'plan_extension_update', name: target.name, reference: target.reference },",
    "      send: { type: 'plan_extension_update', name: target.name, reference: target.reference, url: target.link },"],
  // ===== RECEIPTS =====
  [MODEL, 'Recently added shows the last five, not all',
    '    const shown = state.seeAll ? sorted : sorted.slice(0, RECENT_LIMIT);', '    const shown = sorted;'],
  [MODEL, 'only an item that arrived links to a live thing',
    '    const arrived = items.filter((i) => i && ARRIVED.has(i.outcome));', '    const arrived = items.filter((i) => i);'],
  [MANAGE, 'receipts come back newest first',
    '\n    .sort((a, b) => (a.appliedAt < b.appliedAt ? 1 : a.appliedAt > b.appliedAt ? -1 : (a.file < b.file ? 1 : -1)))', ''],
  // ===== ONE STORE, ONE RECORD =====
  [MANAGE, 'enablement is written on the named record only',
    '  const next = records.map((r) => (r.name === name ? { ...r, enabled } : r));', '  const next = records.map((r) => ({ ...r, enabled }));'],
  [MANAGE, 'a flag that is not a boolean is refused by name',
    "  if (typeof enabled !== 'boolean') refuse('enabled must be true or false', 'invalid-state');\n", ''],
  [HANDLERS, 'an enablement write tells the file tree',
    "    ctx.workspace.noteExtensionRecordsChanged();\n    ws.send(JSON.stringify({ type: 'extension_state'",
    "    ws.send(JSON.stringify({ type: 'extension_state'"],
  [HANDLERS, 'the uninstall reply carries the fresh roster',
    "...outcome, extensions: listExtensions(workspace) }));", '...outcome }));'],
  [HANDLERS, 'the page is answered from the roster reader',
    'extensions: listExtensions(workspace), receipts: listReceipts(workspace)', 'extensions: [], receipts: listReceipts(workspace)'],
  [REGISTRY, 'the roster carries the record\'s source and install date',
    '      resources: [],\n      ...provenance(record),\n', '      resources: [],\n'],
  // ===== THE VIEW =====
  [SETTINGS_VIEW, 'the filled danger button lives only inside the confirmation',
    "  const cls = a.danger ? 'linkbtn danger' : a.accent ? 'linkbtn accent' : 'linkbtn quiet';",
    "  const cls = a.danger ? 'settings-btn-danger' : a.accent ? 'linkbtn accent' : 'linkbtn quiet';"],
  [SETTINGS_VIEW, 'asking to uninstall opens the question rather than acting',
    "  if (action === 'uninstall') return packagesManageApply(m.askUninstall(packagesManage, name));",
    "  if (action === 'uninstall') return packagesManageApply(m.confirmUninstall(m.askUninstall(packagesManage, name).state, name));"],
  [SETTINGS_VIEW, 'the page says Rundock does not review packages, with the field',
    ' Rundock does not review packages; what you add is your choice.', ''],
  [SETTINGS_VIEW, 'the repository sits in the wrapping segment',
    '<span class="seg src">', '<span class="seg">'],
  [APP, 'a reply that carries a roster reconciles the live mount',
    "    case 'packages_page': case 'extension_state': case 'extension_uninstalled':\n      extensionRosterArrived(d); packagesReplyArrived(d); break;",
    "    case 'packages_page': case 'extension_state': case 'extension_uninstalled':\n      packagesReplyArrived(d); break;"],
  [INDEX, 'the Packages nav item carries no hiding style',
    '<div class="settings-nav-item" data-settings="packages" onclick=',
    '<div class="settings-nav-item" data-settings="packages" style="display:none" onclick='],
  // ===== THE STYLESHEET =====
  [SHEET, 'the keyboard ring is drawn on its own property, independent of the hover tint',
    '.ext-row:focus-within { box-shadow: inset 0 0 0 2px var(--accent); }', '.ext-row:focus-within { background: var(--elevated); }'],
  [SHEET, 'the repository segment wraps and is never clipped',
    '.ext-row .meta .src { white-space: normal; overflow-wrap: anywhere; }', '.ext-row .meta .src { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }'],
  [SHEET, 'the uninstall link turns danger text on hover, never the fill',
    '.linkbtn.danger:hover { color: var(--danger-text); }', '.linkbtn.danger:hover { color: var(--danger); }'],
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
    // verdict: refused as a named row rather than thrown.
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
  const targets = [MODEL, INSTALL_MODEL, MANAGE, REGISTRY, HANDLERS, SETTINGS_VIEW, APP, INDEX, SHEET];
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
      // first: the replacement would break whichever came first.
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
      + ' and a guard whose text was not found was not tested.');
    process.exit(1);
  }
}

module.exports = { MUTATIONS, run, report };
