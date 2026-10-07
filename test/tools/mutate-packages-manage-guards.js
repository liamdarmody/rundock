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
const {
  beginMutationRun, targetsFromRows, rowsForShard, exitCodeFor, NO_VERDICT,
} = require('./mutation-run.js');

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
// The Extensions settings page: its row model, and the view drawing it.
const EXT_MODEL = { src: path.join(ROOT, 'public', 'extensions-view-model.js'), suite: 'test/unit/extensions-view-model.test.js' };
const EXT_VIEW = { src: path.join(ROOT, 'public', 'views', 'settings.js'), suite: 'test/unit/extensions-page.test.js' };
// Every reason Settings shows is a sentence, at the source and on display.
const REASONS_ROSTER = { src: path.join(ROOT, 'lib', 'packages', 'extension-registry.js'), suite: 'test/unit/settings-reasons.test.js' };
const REASONS_VIEW = { src: path.join(ROOT, 'public', 'extensions-view-model.js'), suite: 'test/unit/settings-reasons.test.js' };
const REASONS_CARDS = { src: path.join(ROOT, 'public', 'packages-update-model.js'), suite: 'test/unit/settings-reasons.test.js' };
const REASONS_PACKAGES = { src: path.join(ROOT, 'public', 'views', 'settings.js'), suite: 'test/unit/settings-reasons.test.js' };

const MUTATIONS = [
  // ===== ONE CHIP LEADS, AND IT TELLS THE TRUTH =====
  // ===== WHAT IS SENT, AND WHEN =====
  // Repointed when the way to the package moved into its own helper beside
  // the failure sentence: the rule is unchanged and only the line moved.
  [EXT_VIEW, 'a row that could not load offers the way to its package',
    '${esc(r.failedText)} ${extensionFailedWayHtml(r, i)}', '${esc(r.failedText)}'],
  [MODEL, 'a second action waits while one is in flight',
    '    if (state.busy || !entryFor(state, name)) return { state };', '    if (!entryFor(state, name)) return { state };'],
  // ===== RECEIPTS =====
  [MODEL, "a newer release reaches only the extension its package installed",
    "e.source.url === msg.id).map((e) => e.id);", "e.source).map((e) => e.id);"],
  [MODEL, 'the saved folder is mentioned only when it holds something',
    '    if (!f.files) return null;\n', ''],
  [MANAGE, 'receipts come back newest first',
    '\n    .sort((a, b) => (a.appliedAt < b.appliedAt ? 1 : a.appliedAt > b.appliedAt ? -1 : (a.file < b.file ? 1 : -1)))', ''],
  // ===== ONE STORE, ONE RECORD =====
  [MANAGE, 'enablement is written on the named record only',
    '  const next = records.map((r) => (r.name === name ? { ...r, enabled } : r));', '  const next = records.map((r) => ({ ...r, enabled }));'],
  [MANAGE, 'a flag that is not a boolean is refused by name',
    "  if (typeof enabled !== 'boolean') refuse('enabled must be true or false', 'invalid-state');\n", ''],
  [HANDLERS, 'an enablement write tells the file tree',
    "    ctx.workspace.noteExtensionRecordsChanged();\n    ws.send(JSON.stringify({ type: 'extension_state', operation: 'set-enabled'",
    "    ws.send(JSON.stringify({ type: 'extension_state', operation: 'set-enabled'"],
  [HANDLERS, 'the uninstall reply carries the fresh roster',
    "      id, title: plan.title, removed: plan.goes, kept: plan.stays,\n      extensions: listExtensions(workspace), allOff: readAllOff(workspace),\n",
    "      id, title: plan.title, removed: plan.goes, kept: plan.stays,\n"],
  [HANDLERS, 'the page is answered from the roster reader',
    'extensions: listExtensions(workspace), allOff: readAllOff(workspace), receipts: listReceipts(workspace)', 'extensions: [], allOff: readAllOff(workspace), receipts: listReceipts(workspace)'],
  // ===== OFF IS ENFORCED WHERE THE BYTES ARE SERVED, AND EVERY WINDOW IS TOLD =====
  [REGISTRY, 'a disabled extension\'s bytes are refused, not only left unmounted',
    "  if (record.enabled === false) return { ok: false, reason: `\"${extensionId}\" is disabled` };\n", ''],
  [REGISTRY, 'the switch refuses every extension\'s bytes',
    "  if (readAllOff(workspace)) return { ok: false, reason: 'every extension is switched off' };\n", ''],
  [REGISTRY, 'the roster reads every extension as off while the switch is on',
    '      enabled: record.enabled !== false && !allOff,', '      enabled: record.enabled !== false,'],
  [MANAGE, 'the switch changes no extension\'s own setting',
    '  writeAsUnit(workspace, [recordsWrite(workspace, records, { allOff: off })]);',
    '  writeAsUnit(workspace, [recordsWrite(workspace, records.map((r) => ({ ...r, enabled: !off })), { allOff: off })]);'],
  [HANDLERS, 'a change of enablement is sent to every other window',
    "    broadcastRoster(ctx, ws, workspace);\n  } catch (e) {\n    installFail(ws, 'set-enabled'",
    "  } catch (e) {\n    installFail(ws, 'set-enabled'"],
  [HANDLERS, 'the switch is sent to every other window',
    "    broadcastRoster(ctx, ws, workspace);\n  } catch (e) {\n    installFail(ws, 'set-all-off'",
    "  } catch (e) {\n    installFail(ws, 'set-all-off'"],
  [REGISTRY, 'the roster carries the record\'s source and install date',
    '      resources: [],\n      ...provenance(record),\n', '      resources: [],\n'],
  // ===== THE VIEW =====
  [SETTINGS_VIEW, 'the page says Rundock does not review packages, with the field',
    "Rundock doesn't review packages. What you add is your choice.", ''],
  [APP, 'a reply that carries a roster reconciles the live mount',
    "    case 'packages_page': case 'extension_state': case 'extension_install_result':\n      extensionRosterArrived(d.extensions); packagesReplyArrived(d); break;",
    "    case 'packages_page': case 'extension_state': case 'extension_install_result':\n      packagesReplyArrived(d); break;"],
  [APP, 'a package uninstall result reconciles the live mount with the roster it carries',
    "case 'package_uninstall_result': if (Array.isArray(d.extensions)) extensionRosterArrived(d.extensions); ",
    "case 'package_uninstall_result': "],
  [INDEX, 'the Packages nav item carries no hiding style',
    '<div class="settings-nav-item" data-settings="packages" onclick=',
    '<div class="settings-nav-item" data-settings="packages" style="display:none" onclick='],
  // ===== A MARKER CLAIM IS STATED ON THE ROW =====
  // ===== THE STYLESHEET =====
  [SHEET, "a package card's repository wraps and is never clipped",
    '.pkg-card-repo { font-size: var(--caption); margin-top: 4px; overflow-wrap: anywhere;', '.pkg-card-repo { font-size: var(--caption); margin-top: 4px; overflow: hidden;'],
  [SHEET, 'a package card\'s Uninstall rests in the danger text token, never the fill',
    '.pkg-card-uninstall { color: var(--settings-danger-text); }', '.pkg-card-uninstall { background: var(--danger); }'],
  [SHEET, 'the uninstall link turns danger text on hover, never the fill',
    '.linkbtn.danger:hover { color: var(--danger-text); }', '.linkbtn.danger:hover { color: var(--danger); }'],

  // ===== THE EXTENSIONS PAGE =====
  // A paused row shows its own setting, not the paused state as if it were one.
  [EXT_MODEL, 'a paused row keeps showing its own setting',
    '      const on = e.allOff === true ? e.ownEnabled !== false : e.enabled !== false;',
    '      const on = e.enabled !== false;'],
  // Paused, every switch is disabled: pressable, it would change a setting
  // the person cannot see take effect.
  [EXT_MODEL, 'while paused, every switch is disabled',
    '        disabled: paused || !!busy,',
    '        disabled: !!busy,'],
  // The package is named only where a receipt names the same source.
  [EXT_MODEL, 'no provenance line without a matching package',
    '    if (!card) return null;',
    "    if (!card) return { name: 'unknown', package: null };"],
  // A row that could not load names its package only when one is known;
  // otherwise it says plainly that the package cannot be told.
  [EXT_MODEL, 'a row that could not load points to its package only when the package is known',
    'provenance ? { ...LOAD_FAILED_WAY } : { text: LOAD_FAILED_UNKNOWN }', '{ ...LOAD_FAILED_WAY }'],
  // The update link appears only where the state already knows of an update.
  [EXT_MODEL, 'an update is flagged only when one is known',
    "        updateAvailable: !!(status && status.outcome === 'newer-available'),",
    '        updateAvailable: true,'],
  // A row that could not load has no switch; Uninstall tops its column.
  [EXT_VIEW, 'a row that could not load has no switch',
    "  const control = r.failed ? '' :",
    '  const control ='],
  // The page offers no update check. Wiring one to the pause button's place
  // must turn the message-set test red.
  [EXT_VIEW, 'nothing on the page sends an update check',
    "  extensionsApply(manageModel().setAllOff(packagesManage, paused));",
    "  extensionsApply({ state: packagesManage, send: { type: 'check_package_update' } });"],
  // The package goes by its manifest name, title-cased, not its repository.
  [EXT_MODEL, 'provenance names the package, not its repository',
    "    if (e && typeof e.id === 'string' && e.id) return titleCase(e.id);\n",
    ''],
  // A roster reason written as a fragment reads as one in Settings.
  [REASONS_ROSTER, 'the roster writes its reasons as sentences',
    "reason: 'The record carries no valid extension name.',",
    "reason: 'the record carries no valid extension name',"],
  // An error arriving as a lowercase fragment is held to a sentence on display.
  [REASONS_VIEW, 'the Extensions page shows every reason as a sentence',
    "    const capped = t[0].toUpperCase() + t.slice(1);",
    "    const capped = t;"],
  // The Packages page holds its errors and notices to sentences on display.
  [REASONS_CARDS, 'a package card shows its error as a sentence',
    'return { text: install.sentence(state.errors[card.id]), tone', 'return { text: state.errors[card.id], tone'],
  [REASONS_PACKAGES, 'the Packages page shows every notice as a sentence',
    '${esc(RundockPackagesInstallModel.sentence(n.text))}', '${esc(n.text)}'],
  [REASONS_PACKAGES, 'the Packages page shows a page it could not read as a sentence',
    'list = `<div class="pkg-empty is-danger">${esc(RundockPackagesInstallModel.sentence(st.error))}', 'list = `<div class="pkg-empty is-danger">${esc(st.error)}'],
  // No row is dimmed.
  [EXT_VIEW, 'rows are never dimmed',
    '  return `<div class="ext-page-row" data-extension="${escAttr(r.id)}">',
    '  return `<div class="ext-page-row${r.on ? \'\' : \' dimmed\'}" data-extension="${escAttr(r.id)}">'],
  // Removal is the package's: a row's control column holds only its switch.
  [EXT_VIEW, 'the Extensions page offers no uninstall of its own',
    '<div class="ext-page-controls">${control}', '<div class="ext-page-controls">${control}<button class="linkbtn ext-page-uninstall">Uninstall</button>'],

  // ===== THE PAUSE, WHEN SOMETHING IS WRONG =====
  // The switch acts on no record, so a record the page shows as one that
  // could not load must not refuse it: read strictly, it does.
  [MANAGE, 'the pause reads the store leniently, so a record that could not load does not refuse it',
    '  const records = parseRecordsFile(workspace);\n  writeAsUnit(workspace, [recordsWrite(workspace, records, { allOff: off })]);',
    '  const records = readExtensionRecords(workspace);\n  writeAsUnit(workspace, [recordsWrite(workspace, records, { allOff: off })]);'],
  // A refused pause names no extension, so without its own branch the wait
  // is never freed and the button reads "Pausing..." for ever.
  [MODEL, 'a refused pause frees the wait and says why',
    "    if (msg.type === 'package_install_error' && state.busy && state.busy.operation === 'set-all-off' && msg.operation === 'set-all-off') {",
    '    if (false) {'],
  [MODEL, 'only the pause\'s own refusal frees the pause\'s wait',
    "    if (msg.type === 'package_install_error' && state.busy && state.busy.operation === 'set-all-off' && msg.operation === 'set-all-off') {",
    "    if (msg.type === 'package_install_error' && state.busy && state.busy.operation === 'set-all-off') {"],
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
  process.exit(NO_VERDICT);
}

if (require.main === module) {
  requireSaneTempRoot();
  if (process.argv.includes('--preflight-only')) process.exit(0);
  const results = run();
  const failed = report(results, process.argv.includes('--markdown'));
  if (failed) {
    console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded,`
      + ' and a guard whose text was not found was not tested.');
    process.exit(exitCodeFor(failed, results));
  }
}

module.exports = { MUTATIONS, run, report };
