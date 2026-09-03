#!/usr/bin/env node
'use strict';
// Every innerHTML assignment in public/, found rather than remembered, and
// classified beside the finding.
//
// WHY THIS IS A TOOL AND NOT A LIST IN A REVIEW FILE
//
// The audit this belongs to (docs/evidence/innerhtml-audit-evidence.md) makes one
// claim that a prose list cannot keep: that EVERY assignment was looked at. A
// list in a document is true on the day it is written and silently false the
// first time somebody adds an assignment, and nothing tells them. That is
// exactly how the 86 in the renderer's header comment became 91 without anyone
// noticing.
//
// So the inventory is discovered by walking the tree, and the classification
// is a table matched against what was discovered. A site with no entry fails.
// An entry with no site fails. Adding an innerHTML assignment to public/ turns
// the suite red until it is classified, which is the point: the next person
// has to answer the same two questions rather than inherit an answer.
//
//   node test/tools/innerhtml-sites.js            # the table, plus totals
//   node test/tools/innerhtml-sites.js --counts   # totals only
//
// It reads the tree and writes nothing.
//
// WHAT IS COUNTED. Occurrences of `.innerHTML =` (there are no `+=` forms in
// public/ and there never have been), over .js, .mjs and .html. Occurrences,
// not lines: two files put two assignments on one line, so a line count is
// short by two and always has been. `public/vendor/` is excluded and reported
// separately: those are pre-built third-party bundles this repository does not
// author, and claiming them as audited would be claiming to have read a
// minified file.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');

// The assignment, and only the assignment. The negative lookahead keeps `==`
// and `===` out; there are none today and a comparison counted as a write
// would be a site that cannot be fixed because it does not exist.
const ASSIGNMENT = /\.innerHTML\s*\+?=(?!=)/g;

// ── THE TWO GROUPS ──────────────────────────────────────────────────────────
//
// 'a'  markup built entirely from values the app itself produced: constants,
//      hardcoded strings, numbers, booleans, a key into a table this
//      repository writes, or an external value already escaped for the
//      position it lands in. Closed with the reason, not changed.
//
// 'b'  an agent-influenced or external value reaches the DOM through this
//      assignment in a position where it can become something other than
//      text. Fixed.
//
// The 'a' reasons are codes rather than sentences so the totals below are
// arithmetic on the table rather than a second count kept by hand.
const REASONS = {
  cleared: "assigned '': no value, nothing to construct",
  iconConst: 'a module-level SVG or icon constant, assigned whole',
  staticMarkup: 'a literal with no interpolation, or only booleans choosing between literals',
  appValues: 'numbers, booleans, or a key into a table this repository writes',
  renderer: 'external text, through the markdown renderer, which is the boundary #192 built and tests',
  escapedText: 'external text, escaped for element content, which is the right escaper for that position',
  closedWithReason: 'closed with a stated reason rather than a fix, see the audit',
};

// file -> one entry per assignment, IN SOURCE ORDER.
//   ['a', reasonKey, what]   or   ['b', cause, what]
//
// `what` names the thing rendered, so a reader can tell which assignment an
// entry is without counting brackets in the source.
const TABLE = {
  'app.js': [
    ['a', 'renderer', 'handoff text promoted into the stream element'],
    ['b', 'agent-identity', 'the streaming bubble sender line'],
    ['a', 'renderer', 'the live stream'],
    ['b', 'agent-identity', 'the thinking indicator'],
    ['a', 'renderer', 'the final message'],
    ['a', 'iconConst', 'the theme toggle glyph, one of two constants'],
    ['b', 'attr-escaper', 'the workspace picker, Recent list'],
    ['a', 'cleared', 'the Recent list, emptied'],
    ['b', 'attr-escaper', 'the workspace picker, Discovered list'],
    ['a', 'cleared', 'the Discovered list, emptied'],
    ['a', 'cleared', 'the Discovered list, emptied on the no-candidates path'],
    ['a', 'cleared', 'the update strip, emptied'],
    ['a', 'appValues', 'the update strip: a rounded percentage and esc() text'],
    ['a', 'staticMarkup', 'the collapsed update strip'],
    ['a', 'appValues', 'the ready update strip: esc() text and a constant glyph'],
  ],
  'markdown-render.js': [
    ['a', 'iconConst', 'the copy button, showing the check glyph'],
    ['a', 'iconConst', 'the copy button, restored to the copy glyph'],
  ],
  'editor/nodes/callout.js': [
    // The body's markdown container. The only value in the assignment is the
    // shared renderer's whole output: external text (a workspace file an
    // agent may have written unattended) goes through the same boundary the
    // chat stream trusts, and the pipeline-less fallback path builds text
    // nodes and never reaches this assignment, so every interpolation that
    // can occur here is the renderer's.
    ['a', 'renderer', 'the callout body, markdown rendered'],
    ['a', 'cleared', 'the callout title bar, emptied before rebuild'],
    ['a', 'iconConst', 'the edit button glyph'],
    ['a', 'cleared', 'the callout title bar, emptied on the plain path'],
  ],
  'editor/nodes/source-markers.js': [
    ['a', 'closedWithReason', 'the fenced-block newline trim, a read-modify-write of markup'],
  ],
  'editor/panels/floating-toolbar.js': [
    ['a', 'appValues', 'the toolbar, from a boolean and an id list that is only membership-tested'],
    ['a', 'cleared', 'the toolbar, emptied on teardown'],
  ],
  'editor/panels/properties.js': [
    ['a', 'cleared', 'the properties panel, emptied before rebuild'],
    ['a', 'escapedText', 'frontmatter keys and values, through a local escaper that includes both quotes'],
  ],
  'editor/panels/review.js': [
    ['a', 'iconConst', 'the send arrow'],
    ['a', 'cleared', 'the review sidebar, emptied when closed'],
    ['a', 'cleared', 'the review sidebar, emptied before rebuild'],
  ],
  'editor/plugins/code-copy.js': [
    ['a', 'iconConst', 'the copy glyph'],
    ['a', 'iconConst', 'the check glyph'],
    ['a', 'iconConst', 'the copy glyph, restored'],
  ],
  'viewers/board-view.js': [
    ['a', 'cleared', 'the board pane, emptied'],
    ['a', 'cleared', 'the lane scroller, emptied'],
    ['b', 'transform-order', 'a kanban card title, escaped and then transformed into markup'],
    ['a', 'cleared', 'a lane wrapper, emptied'],
    ['a', 'cleared', 'a lane wrapper, emptied'],
    ['a', 'cleared', 'the board pane, emptied on teardown'],
  ],
  'viewers/registry.js': [
    ['a', 'cleared', 'the viewer pane, emptied'],
    ['a', 'cleared', 'the viewer pane, emptied'],
    ['a', 'cleared', 'the viewer pane, emptied'],
    ['a', 'cleared', 'the viewer pane, emptied'],
    ['a', 'cleared', 'the viewer pane, emptied'],
  ],
  'views/chat.js': [
    ['a', 'iconConst', 'the send button, stop glyph'],
    ['b', 'agent-identity', 'the thinking indicator'],
    ['a', 'iconConst', 'the send button, arrow glyph'],
    ['a', 'renderer', 'the buffered stream'],
    ['b', 'agent-identity', 'a settled agent message'],
    ['a', 'escapedText', 'a user message, esc() into element content'],
    ['b', 'agent-identity', 'the delegation divider'],
    ['a', 'staticMarkup', 'the auth-error card'],
    ['a', 'escapedText', 'the Codex quota card: display name and the CLI failure text, esc()'],
    ['a', 'escapedText', 'the Codex guidance card: title, body and detail, esc()'],
    ['a', 'staticMarkup', 'the previous-session divider'],
    ['a', 'escapedText', 'a replayed user message, esc()'],
    ['b', 'agent-identity', 'a replayed agent message'],
    ['a', 'escapedText', 'the permission card: every model-chosen value esc() into element content'],
    ['a', 'escapedText', 'the resolved permission card, read back as textContent and re-escaped'],
    ['a', 'escapedText', 'an activity row: elapsed time and esc() of a tool name'],
  ],
  'views/conversations.js': [
    ['a', 'cleared', 'the message list, emptied'],
    ['a', 'escapedText', 'the Codex first-run card, esc() display name'],
    ['b', 'agent-identity', 'the prompt pills on a new conversation'],
    ['a', 'iconConst', 'the send button, stop glyph'],
    ['a', 'iconConst', 'the send button, arrow glyph'],
    ['a', 'iconConst', 'the send button, arrow glyph on the second path'],
    ['a', 'escapedText', 'a list-menu row: a tick and esc() of a list name'],
    // Counted under inline-handler rather than agent-identity: it carries
    // both, and the conversation id in five inline handlers is the half that
    // no choice of escaper answers.
    ['b', 'inline-handler', 'the conversation sidebar'],
    ['a', 'cleared', 'the message list, emptied before history'],
    ['a', 'staticMarkup', 'the history loading line'],
    ['a', 'iconConst', 'the send button, stop glyph on reconnect'],
    ['b', 'agent-identity', 'the reconnect bubble, mid-stream'],
    ['b', 'agent-identity', 'the reconnect thinking indicator'],
  ],
  'views/files.js': [
    ['a', 'cleared', 'the editor host, emptied'],
    ['a', 'staticMarkup', 'the changed-on-disk banner'],
    ['a', 'appValues', 'a tree icon, from a table keyed by a closed set of file kinds'],
    ['a', 'cleared', 'the tree container, emptied'],
    ['a', 'staticMarkup', 'the no-files line'],
    ['b', 'inline-handler', 'the empty-tree pane, offering the guide'],
    ['a', 'staticMarkup', 'the select-a-file pane'],
    ['a', 'escapedText', 'a folder row: a constant glyph and esc() of the folder name'],
    ['a', 'iconConst', 'a folder glyph, swapped on collapse'],
    ['a', 'escapedText', 'a file row: a table glyph and esc() of the file name'],
    ['a', 'appValues', 'a menu button: a constant glyph and a constant label'],
    ['a', 'cleared', 'the menu, emptied'],
    ['a', 'renderer', 'the file preview'],
    ['a', 'iconConst', 'a folder glyph, opened'],
  ],
  'views/find.js': [
    ['a', 'escapedText', 'the find overlay: file bytes through escapeOverlay, element content only'],
  ],
  'views/palette.js': [
    ['b', 'attr-escaper', 'the search palette results'],
    ['a', 'staticMarkup', 'the palette footer hint, one of two literals'],
  ],
  'views/profile.js': [
    ['b', 'inline-handler', 'the agent profile'],
  ],
  'views/routine-editor.js': [
    ['b', 'inline-handler', 'the routine editor'],
  ],
  'views/routines-panel.js': [
    ['b', 'inline-handler', 'the routines scope panel'],
  ],
  'views/routines.js': [
    ['b', 'attr-escaper', 'the delete confirmation'],
    ['b', 'attr-escaper', 'the empty routines pane'],
    ['b', 'attr-escaper', 'the routines list'],
  ],
  'views/run-detail.js': [
    ['b', 'attr-escaper', 'the run detail, waiting state'],
    ['b', 'attr-escaper', 'the run detail, loaded state'],
  ],
  'views/settings.js': [
    ['b', 'attr-escaper', 'the packages section: model copy and outcomes through esc(), the field value through escAttr()'],
    ['b', 'attr-escaper', 'the workspace card'],
    ['a', 'staticMarkup', 'the appearance card'],
    ['a', 'appValues', 'the about card: the app version from package.json'],
    ['a', 'appValues', 'the runtimes card: constant labels and a regex-clamped version'],
  ],
  'views/skills.js': [
    ['a', 'escapedText', 'the skills empty state, esc() copy'],
    ['b', 'inline-handler', 'the skills sidebar'],
    ['b', 'inline-handler', 'the skill detail'],
  ],
  'views/team.js': [
    ['b', 'inline-handler', 'the agent roster'],
    ['b', 'inline-handler', 'the agent cards on the empty conversations pane'],
    ['a', 'escapedText', 'the guide line, esc() copy'],
    ['b', 'inline-handler', 'the org chart'],
  ],
};

// What each 'b' cause is, so the totals print as sentences.
const CAUSES = {
  'agent-identity': 'agent colour, icon, display name, role, description or model, written into markup unescaped',
  'inline-handler': 'a filename-derived identifier interpolated into an inline event handler',
  'attr-escaper': 'esc() used in attribute position, where it cannot hold the attribute closed',
  'transform-order': 'an escaping break created by a transform that ran after escaping',
};

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every assignment under public/, in file then source order. */
function findSites() {
  const sites = [];
  for (const file of walk(PUBLIC).sort()) {
    const rel = path.relative(PUBLIC, file).split(path.sep).join('/');
    const src = fs.readFileSync(file, 'utf8');
    const re = new RegExp(ASSIGNMENT.source, 'g');
    let m;
    let index = 0;
    while ((m = re.exec(src))) {
      sites.push({
        file: rel,
        index: index++,
        line: src.slice(0, m.index).split('\n').length,
        vendor: rel.startsWith('vendor/'),
      });
    }
  }
  return sites;
}

/**
 * Join the discovered sites to the table.
 *
 * Both directions are checked. A site with no entry is UNCLASSIFIED, which is
 * the case this tool exists for. An entry with no site is ORPHANED, which is
 * the case that would otherwise let the table keep asserting something about
 * code that has gone.
 */
function classify() {
  const sites = findSites().filter((s) => !s.vendor);
  const vendor = findSites().filter((s) => s.vendor);
  const unclassified = [];
  const rows = [];
  for (const site of sites) {
    const entry = (TABLE[site.file] || [])[site.index];
    if (!entry) { unclassified.push(site); continue; }
    rows.push({ ...site, group: entry[0], reason: entry[1], what: entry[2] });
  }
  const orphaned = [];
  for (const [file, entries] of Object.entries(TABLE)) {
    const found = sites.filter((s) => s.file === file).length;
    for (let i = found; i < entries.length; i++) orphaned.push(`${file}[${i}] ${entries[i][2]}`);
    if (found && !entries.length) orphaned.push(`${file} has an empty entry list`);
  }
  return { rows, unclassified, orphaned, vendorCount: vendor.length };
}

function totals(rows) {
  const byGroup = { a: 0, b: 0 };
  const byReason = {};
  for (const r of rows) {
    byGroup[r.group]++;
    byReason[r.reason] = (byReason[r.reason] || 0) + 1;
  }
  return { total: rows.length, byGroup, byReason };
}

function report({ rows, unclassified, orphaned, vendorCount }, countsOnly) {
  if (!countsOnly) {
    console.log('| Site | Line | Group | Reason | What it renders |');
    console.log('|---|---|---|---|---|');
    for (const r of rows) {
      console.log(`| \`${r.file}\`[${r.index}] | ${r.line} | ${r.group} | ${r.reason} | ${r.what} |`);
    }
    console.log('');
  }
  const t = totals(rows);
  console.log(`First-party assignments: ${t.total}`);
  console.log(`  group (a), closed with a reason: ${t.byGroup.a}`);
  console.log(`  group (b), fixed:                ${t.byGroup.b}`);
  console.log(`Pre-built vendor bundles, out of scope: ${vendorCount}`);
  console.log('');
  console.log('group (b), by cause:');
  for (const [key, text] of Object.entries(CAUSES)) {
    console.log(`  ${String(t.byReason[key] || 0).padStart(3)}  ${key}: ${text}`);
  }
  console.log('');
  console.log('group (a), by reason:');
  for (const [key, text] of Object.entries(REASONS)) {
    console.log(`  ${String(t.byReason[key] || 0).padStart(3)}  ${key}: ${text}`);
  }
  let failed = 0;
  if (unclassified.length) {
    failed = 1;
    console.error('\nUNCLASSIFIED: an innerHTML assignment exists that the table says nothing about.');
    console.error('Answer the two questions in docs/evidence/innerhtml-audit-evidence.md and add an entry:');
    for (const s of unclassified) console.error(`  ${s.file}[${s.index}] at line ${s.line}`);
  }
  if (orphaned.length) {
    failed = 1;
    console.error('\nORPHANED: the table classifies assignments that no longer exist. Remove them:');
    for (const o of orphaned) console.error(`  ${o}`);
  }
  return failed;
}

if (require.main === module) {
  process.exit(report(classify(), process.argv.includes('--counts')));
}

module.exports = { findSites, classify, totals, TABLE, REASONS, CAUSES };
