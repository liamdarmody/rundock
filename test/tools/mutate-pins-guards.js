#!/usr/bin/env node
'use strict';
// Break each of the Pins rules in turn and report which tests notice.
//
// A pin is a short list the reader curates, and every rule it is judged on
// can be deleted with the product still drawing SOMETHING: a list in the
// wrong order is still a list, a pin written under the workspace root still
// persists, a missing file drawn as present still opens a dead editor, and a
// pinned file that lights Files instead of Pins still shows. So each rule is
// broken on purpose here and a test must go red for it, one row per rule.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-pins-guards.js            # report
//   node test/tools/mutate-pins-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws. The harness
// is the same shape as its siblings, deliberately a separate copy: pulling
// them together means editing instruments already in the gate.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

const MODEL = { src: path.join(ROOT, 'public', 'pins-model.js'), suite: 'test/unit/pins-model.test.js' };
const STORE = { src: path.join(ROOT, 'lib', 'store', 'pins.js'), suite: 'test/unit/pins-store.test.js' };
const HANDLER = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'pins.js'), suite: 'test/unit/pins-store.test.js' };
const VIEW = { src: path.join(ROOT, 'public', 'views', 'pins.js'), suite: 'test/unit/pins-view.test.js' };
const FILES = { src: path.join(ROOT, 'public', 'views', 'files.js'), suite: 'test/unit/pins-view.test.js' };
// The one line in the shell that decides which list a file lights, watched
// by the doors suite that presses showView under both entries.
const APP = { src: path.join(ROOT, 'public', 'app.js'), suite: 'test/unit/navigation-doors.test.js' };

const MUTATIONS = [
  // ===== THE LIST'S OWN RULES =====
  // Prepend instead of append and the position a reader learned for a pin
  // moves every time they pin another.
  [MODEL, 'pins keep the order they were pinned in, earliest first',
    '    return list.concat([p]);',
    '    return [p].concat(list);'],
  // Drop the membership check and a second pin of the same file doubles it.
  [MODEL, 'pinning a path already pinned is a no-op',
    "    if (typeof p !== 'string' || !p.trim() || list.includes(p)) return list;",
    "    if (typeof p !== 'string' || !p.trim()) return list;"],
  // Reverse the rest on removal and unpinning one file reorders the others.
  [MODEL, 'unpinning one path keeps the rest in their order',
    '    return normalize(pins).filter(x => x !== p);',
    '    return normalize(pins).filter(x => x !== p).reverse();'],
  // Never mark and a deleted file draws as an ordinary row that opens a dead
  // editor, which is the defect the acceptance criterion names.
  [MODEL, 'reconcile marks a pin the tree no longer carries',
    '        missing: arrived && !item,',
    '        missing: false,'],

  // ===== WHERE PINS LIVE =====
  // Write a copy under the workspace root and a synced folder starts sharing
  // one person's pins: the byte-identical snapshot is what notices.
  [STORE, 'the store writes nothing under the workspace root',
    '  writeAll(all);\n  return next;',
    "  writeAll(all);\n  fs.writeFileSync(path.join(root, '.rundock-pins.json'), '[]');\n  return next;"],
  // Keep every key and a workspace moved to a new path leaves its old entry
  // behind forever, which is not what the stated rule says happens.
  [STORE, 'an entry whose workspace path no longer exists is pruned on load',
    '    if (fs.existsSync(key)) valid[key] = list;\n    else pruned = true;',
    '    valid[key] = list;'],
  // Key by the path as typed and a symlinked workspace is two workspaces.
  [STORE, 'the key is the realpath of the workspace root',
    '  try { return fs.realpathSync(root); } catch (e) { return path.resolve(root); }',
    '  return path.resolve(root);'],

  // ===== THE WIRE =====
  // Drop the boundary guard and a pin_file for a path outside the workspace
  // is written to the home file.
  [HANDLER, 'a pin outside the workspace is refused before any write',
    '  if (!rel || !ctx.workspace.isInsideWorkspace(full) || !isFile()) {',
    '  if (!rel || !isFile()) {'],

  // ===== THE VIEW READS THE MODEL =====
  // Replace the model call with an inline map and the view carries a second
  // copy of the rules, one that marks nothing missing and knows no kinds.
  [VIEW, 'the view reads the list through the model, not a copy of its rules',
    '  return pinsModel().reconcile(pinnedPaths, pinsTree);',
    "  return pinnedPaths.map((p) => ({ path: p, name: p.split('/').pop(), folder: '', kind: 'file', missing: false }));"],
  // Let the unpin click bubble and removing a pin also opens the file.
  [VIEW, 'the remove control unpins without opening',
    "      unpin.addEventListener('click', (e) => { e.stopPropagation(); unpinPath(row.path); });",
    "      unpin.addEventListener('click', (e) => { unpinPath(row.path); });"],
  // Draw a missing row as a present one and it is a link to a dead editor
  // with no way to remove it but the hover control.
  [VIEW, 'a missing row offers Remove and opens nothing',
    '    if (row.missing) {\n      // Not a link to a dead editor',
    '    if (false) {\n      // Not a link to a dead editor'],
  // Stop redrawing the control on a reply and the header keeps saying Pin
  // after the reply that pinned the file.
  [VIEW, 'the header control reads the open file against the list on every reply',
    '  renderPins();\n  renderEditorPinControl();\n}',
    '  renderPins();\n}'],
  // Record the wrong entry and a file opened from the Pins list lights Files.
  [VIEW, 'a pinned row records that the reader came in through Pins',
    "function openPinnedFile(path) {\n  editorEntry = 'pins';",
    "function openPinnedFile(path) {\n  editorEntry = 'files';"],
  // Open the first pin whether or not it exists and the rail entry lands on
  // a dead editor when the first pin has gone.
  [VIEW, 'the rail entry opens onto the first pin that can be opened',
    '  const first = pinsModel().firstOpenable(rows);',
    '  const first = rows[0] || null;'],
  // Forget the open file and arriving from the rail re-reads a file the
  // reader is already looking at, or replaces it with the first pin.
  [VIEW, 'arriving with the open file already pinned keeps it open',
    '  const open = currentFilePath ? rows.find((r) => r.path === currentFilePath && !r.missing) : null;',
    '  const open = null;'],

  // ===== THE SEAMS INTO THE FILES VIEW =====
  // Stop feeding the tree to the list and a file deleted outside Rundock is
  // never marked: the reconcile happens against a tree that never arrives.
  [FILES, 'every tree arrival reconciles the list',
    "  if (typeof noteTreeForPins === 'function') noteTreeForPins(tree || []);\n",
    ''],
  // Stop redrawing the control on open and a pinned file followed by an
  // unpinned one inherits the first one's answer.
  [FILES, 'the header control re-renders on every open',
    "  if (typeof renderEditorPinControl === 'function') renderEditorPinControl();\n",
    ''],
  // Offer the row for folders and a folder can be pinned, which the model
  // then marks missing forever.
  [FILES, 'the context menu offers the pin row for files only',
    "  if (targetKind !== 'folder' && typeof pinMenuRow === 'function') rows.push(pinMenuRow(targetPath));",
    "  if (typeof pinMenuRow === 'function') rows.push(pinMenuRow(targetPath));"],

  // ===== WHICH LIST IS LIT =====
  // Invert the editor row's second answer and a file opened from the Pins
  // list lights Files, with the Pins panel gone from under the reader.
  [APP, 'a file entered from Pins lights Pins, and the same view entered from Files lights Files',
    "editorEntry==='pins')?'pins':NAV_FOR_VIEW[v]",
    "editorEntry==='pins')?'files':NAV_FOR_VIEW[v]"],
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
  const targets = [MODEL, STORE, HANDLER, VIEW, FILES, APP];
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
