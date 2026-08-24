#!/usr/bin/env node
'use strict';
// Break each of the navigation guards in turn and report which tests notice.
//
// WHY THIS EXISTS SEPARATELY FROM THE SUITE
//
// A green suite says the guards and the tests agree today. It does not say the
// tests are testing the guards, and most of what this change is judged on is an
// ABSENCE: nothing outside setNavState lights a rail entry, nothing outside it
// hides a panel, and no destination sets nav state for itself. A rule whose
// whole content is "nothing does this" is the easiest kind of test to write so
// that it cannot fail, because it passes against a client that does nothing at
// all.
//
// So the mutations here mostly put the defect BACK rather than take a guard
// away. Each one is a real form the defect had before this change:
//
//   * a destination that sets its own section, and sets the wrong one
//   * a second hard-coded list of the sidebar panels
//   * showView revealing a pane and leaving the rail where it was
//   * a view added to showView and not to the table
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-nav-guards.js            # report
//   node test/tools/mutate-nav-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws.
//
// The harness is the same shape as mutate-routines-guards.js and is
// deliberately a third copy rather than a shared module, for the reason stated
// there: pulling them together means editing an instrument already in the
// gate, and mixing that refactor into a feature is how a gate quietly stops
// checking what it used to.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

const SUITE = 'test/unit/navigation-doors.test.js';
const APP = { src: path.join(ROOT, 'public', 'app.js'), suite: SUITE };
const INDEX = { src: path.join(ROOT, 'public', 'index.html'), suite: SUITE };
const ROUTINE_EDITOR = { src: path.join(ROOT, 'public', 'views', 'routine-editor.js'), suite: SUITE };
const SKILLS = { src: path.join(ROOT, 'public', 'views', 'skills.js'), suite: SUITE };
const FILES = { src: path.join(ROOT, 'public', 'views', 'files.js'), suite: SUITE };
// The run detail screen, which arrived from another branch already setting its
// own section. Merging is exactly where this defect class comes back, so the
// code that branch shipped is what this mutation restores.
const RUN_DETAIL = { src: path.join(ROOT, 'public', 'views', 'run-detail.js'), suite: SUITE };

// [target, label, the guard as it is written, what it becomes without it]
const MUTATIONS = [
  // ===== THE MECHANISM ITSELF =====
  // The whole change in one line. Without it showView reveals a pane and leaves
  // the rail saying wherever the reader last was, which is the defect on every
  // route rather than on the three that were named.
  [APP, 'showing a view is what sets the section',
    " const nav=NAV_FOR_VIEW[v]; if(nav) setNavState(nav); }",
    ' }'],
  // The exception, inverted. The workspace picker hides the rail and the
  // sidebar, and setNavState resolves a sidebar panel by name, so treating
  // null as a section rather than as a decision throws on the screen a user
  // meets before they have a workspace.
  [APP, 'a view with no section is shown without one rather than with a missing one',
    ' const nav=NAV_FOR_VIEW[v]; if(nav) setNavState(nav); }',
    ' setNavState(NAV_FOR_VIEW[v]); }'],
  [APP, 'the table answers for every view the shell can show',
    "  'routine-editor': 'routines',\n",
    ''],
  [APP, 'the table is the one showView reads, not a second opinion beside it',
    "  'routine-editor': 'routines',",
    "  'routine-editor': 'team',"],

  // ===== ONE PLACE DECIDES =====
  // The second panel list, put back exactly as it was: a hand-written copy of
  // setNavState in the workspace-switch reset. It is the form the drift took,
  // and the form it will take again, because copying four lines is easier than
  // reading the function they came from.
  [APP, 'the workspace switch asks for the chrome rather than repeating it',
    "  setNavState('conversations');",
    "  document.querySelectorAll('.nav-item[data-nav]').forEach(n=>n.classList.remove('active'));\n"
    + "  document.querySelector('[data-nav=\"conversations\"]')?.classList.add('active');\n"
    + "  ['team','conversations','skills','files','settings'].forEach(s=>document.getElementById(`sidebar-${s}`).classList.add('hidden'));\n"
    + "  document.getElementById('sidebar-conversations').classList.remove('hidden');"],
  // The panel list held to the page. A sixth panel added to index.html and not
  // to this list stays visible under the fifth, which is the reported defect.
  [INDEX, 'the panel list knows every panel the page carries',
    '    <div id="sidebar-settings" class="hidden">',
    '    <div id="sidebar-inspector" class="hidden"></div>\n    <div id="sidebar-settings" class="hidden">'],
  // The reverse: a list naming a panel the page no longer has. setNavState
  // resolves panels by id, so this is a null dereference on every navigation.
  [APP, 'the panel list names no panel the page has stopped carrying',
    "  ['team','conversations','skills','files','settings','routines'].forEach",
    "  ['team','conversations','skills','files','settings','routines','inspector'].forEach"],

  // ===== THE DESTINATIONS THAT USED TO SET THEIR OWN =====
  // Each of these is the code as it shipped before this change, restored one at
  // a time. If the enumeration only checks a table, none of them turns anything
  // red and the change has bought a comment.
  [ROUTINE_EDITOR, 'the routine editor does not name a section of its own',
    '    if (typeof showView === \'function\') showView(\'routine-editor\');',
    '    if (typeof setNavState === \'function\') setNavState(\'team\');\n'
    + '    if (typeof showView === \'function\') showView(\'routine-editor\');'],
  [SKILLS, 'selecting a skill does not name a section of its own',
    "  currentSkillId = id;\n  showView('skills');",
    "  currentSkillId = id;\n  setNavState('team');\n  showView('skills');"],
  [RUN_DETAIL, 'the run detail screen does not name a section of its own',
    "  if (typeof showView === 'function') showView('run-detail');",
    "  if (typeof setNavState === 'function') setNavState('routines');\n"
    + "  if (typeof showView === 'function') showView('run-detail');"],
  [FILES, "opening a skill's file does not name a section of its own",
    "  ws.send(JSON.stringify({ type: 'read_file', path: filePath }));\n  showView('editor');",
    "  ws.send(JSON.stringify({ type: 'read_file', path: filePath }));\n"
    + "  setNavState('skills');\n  showView('editor');"],

  // ===== THE ENUMERATION =====
  // A destination added and not listed. This is the only mutation that adds a
  // call site rather than changing one, because the enumeration's whole claim
  // is about calls nobody thought to write down.
  [SKILLS, 'a destination nobody listed fails the enumeration by name',
    "function selectSkill(id) {",
    "function selectSkillElsewhere(id) { showView('profile'); }\n\nfunction selectSkill(id) {"],
  // The rail and the arms, which is what makes removing setNavState from
  // switchNav safe: an entry with no arm shows no view, and a view is now the
  // only thing that moves the rail.
  [APP, 'every rail entry has an arm that shows a view',
    "  else if(nav==='team') { showView('home'); renderOrgChart(); }\n",
    ''],

  // ===== THE SCAN'S OWN REACH =====
  // Every check here is only as wide as what it reads, so the width is
  // mutated too. Each of these is a way a real destination could exist and be
  // invisible to a scan that looked only where the first version looked.
  //
  // A destination written in the page's own handlers. The rail is written in
  // these, so they are code the shell runs, and they were outside the scan
  // until they were not.
  [INDEX, 'a destination in an inline handler is enumerated like any other',
    '<button class="nav-item" data-nav="files" onclick="switchNav(\'files\')" data-tooltip="Files">',
    '<button class="nav-item" data-nav="files" onclick="showView(\'editor\')" data-tooltip="Files">'],
  // A destination reached through a property rather than by name. Skipping
  // these was how the first version of the scan could be walked around.
  [SKILLS, 'a destination reached through a property is enumerated like any other',
    'function selectSkill(id) {',
    "function selectSkillElsewhere(id) { window.showView('profile'); }\n\nfunction selectSkill(id) {"],
  // A call the scan cannot read, refused rather than missed.
  [SKILLS, 'a call broken across lines is refused rather than read wrongly',
    "  currentSkillId = id;\n  showView('skills');",
    "  currentSkillId = id;\n  showView(\n    'skills');"],
  // The variable behind the one row whose view is not a literal.
  [FILES, 'the view Back returns to is one the table knows',
    "  editorReturnView = 'skills';",
    '  editorReturnView = currentView;'],

  // ===== WHETHER THERE IS ANY CHROME AT ALL =====
  // The reason both no-section rows give is that the chrome comes down on the
  // way to the picker. It was true of one route and not the other.
  [APP, 'every route to the picker takes the chrome down through one place',
    "    case 'needs_workspace': setWorkspaceChrome(false); showView('workspace'); break;",
    "    case 'needs_workspace': showView('workspace'); break;"],
  [APP, 'nothing takes the chrome down beside the one place that owns it',
    '  setWorkspaceChrome(false);\n  showView(\'workspace\');',
    "  document.querySelector('.nav-rail').style.display = 'none';\n"
    + "  document.querySelector('.sidebar').style.display = 'none';\n"
    + "  showView('workspace');"],
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
  const targets = [APP, INDEX, ROUTINE_EDITOR, SKILLS, FILES, RUN_DETAIL];
  const originals = new Map();
  for (const target of targets) originals.set(target, fs.readFileSync(target.src, 'utf8'));
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
      // FIRST. String.replace takes the first occurrence, so a search text
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
    for (const [target, original] of originals) fs.writeFileSync(target.src, original);
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

const failed = report(run(), process.argv.includes('--markdown'));
if (failed) {
  console.error(`\n${failed} mutation${failed === 1 ? '' : 's'} turned nothing red, or could not be applied.`);
  process.exit(1);
}
