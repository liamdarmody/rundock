'use strict';
// No money anywhere a reply's figures pass through.
//
// Claude Code's result carries a dollar estimate beside its token counts, and
// Rundock never shows it: a subscription is not billed per reply, so a figure
// in dollars would be wrong for the people reading it. The surest way to
// never draw it is never to read it, so no source the page or the server
// runs from names the fields that carry it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const COST_FIELDS = ['total_cost_usd', 'modelUsage', 'costUSD'];

// Every file under a folder, recursively, as paths from the repository root.
function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

// Pins what main already does; its sibling in turn-used-view.test.js, "no
// money is shown, whatever the result carries", fails on main.
test('no file under public/ or lib/, nor server.js or codex-appserver.js, names a cost field', () => {
  const pub = filesUnder('public');
  const lib = filesUnder('lib');
  assert.ok(pub.length > 20 && pub.includes('public/views/chat.js'), 'sanity: the page sources were walked');
  assert.ok(lib.length > 20 && lib.includes('lib/runtime/codex-glue.js'), 'sanity: the server sources were walked');
  const offenders = [];
  for (const file of [...pub, ...lib, 'server.js', 'codex-appserver.js']) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf-8');
    for (const field of COST_FIELDS) if (text.includes(field)) offenders.push(`${file} names ${field}`);
  }
  assert.deepStrictEqual(offenders, []);
});
