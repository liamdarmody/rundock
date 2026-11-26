'use strict';
// The changelog and the runtime adapter contract name the line under each
// reply: the changelog says what a person now sees, and the contract says what
// a runtime's usage and time mean on the result. Both files are read as lines
// and table cells, so a reworded entry or a moved row fails by name.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const lines = (file) => fs.readFileSync(path.join(ROOT, file), 'utf-8').split('\n');

const ENTRY = '- **See what each reply used:** each agent reply now says how long the agent worked on it, such as "Worked 4 min 05 s". Details lists the steps it took and the tokens Claude Code or Codex reported for that reply. The line shows on replies that arrive while the conversation is open, as the step list did.';

// The entries of one subsection under one release heading.
function entries(all, release, subsection) {
  const start = all.indexOf(release);
  assert.ok(start >= 0, `the changelog has a "${release}" heading`);
  let i = start + 1;
  while (i < all.length && all[i] !== subsection && !all[i].startsWith('## ')) i += 1;
  assert.strictEqual(all[i], subsection, `"${release}" has a "${subsection}" subsection`);
  const out = [];
  for (i += 1; i < all.length && !all[i].startsWith('## ') && !all[i].startsWith('### '); i += 1) {
    if (all[i].startsWith('- ')) out.push(all[i]);
  }
  return out;
}

test('the changelog adds the entry once, under Unreleased and Added, after the attachments entry', () => {
  const all = lines('CHANGELOG.md');
  assert.strictEqual(all.filter((l) => l === ENTRY).length, 1, 'the entry appears once, word for word');
  const added = entries(all, '## Unreleased', '### Added');
  const attachments = added.findIndex((l) => l.startsWith('- **Attach files to a message:**'));
  assert.ok(attachments >= 0, 'sanity: the attachments entry is under Added');
  assert.ok(added.indexOf(ENTRY) > attachments, 'the entry sits under Added, after the attachments entry');
});

// The cells of every row of the adapter contract's event table.
function eventRows() {
  const all = lines('docs/RUNTIME-ADAPTER.md');
  const head = all.indexOf('| Event | Meaning | Client-visible result |');
  assert.ok(head >= 0, 'the adapter contract has its event table');
  const rows = [];
  for (let i = head + 2; i < all.length && all[i].startsWith('|'); i += 1) {
    rows.push(all[i].split('|').slice(1, -1).map((c) => c.trim()));
  }
  return rows;
}

test('the adapter contract says usage holds only the counts the runtime reported, and adds the time worked after it', () => {
  const rows = eventRows();
  const usage = rows.findIndex((r) => r[0] === 'usage');
  assert.ok(usage >= 0, 'the event table has a usage row');
  assert.deepStrictEqual(rows[usage], [
    'usage',
    'token counts the runtime reported for the turn (subscription units, never dollars); a count it didn\'t report is left out, never zero',
    'usage on the `result`',
  ]);
  assert.deepStrictEqual(rows[usage + 1], [
    'time worked',
    'how long the turn ran in milliseconds, as the runtime reported it or, when it didn\'t, as the server measured it',
    '`duration_ms` on the `result`',
  ], 'the time worked row follows the usage row');
});
