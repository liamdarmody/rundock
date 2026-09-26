#!/usr/bin/env node
'use strict';
// A pull request's title and body, checked before it is opened, with the same
// rules as a push (scripts/leak-scan.js), private denylist included. A pull
// request body is public the moment it is created and outlives any edit in
// notification emails, so it is checked first, not fixed after.
//
//   node scripts/check-pr-text.js --title "<title>" --body-file <file>
//   gh pr create --title "<title>" --body-file <file>
//
// Exits 0 when clean, 1 on a finding, 2 when it could not run.

const fs = require('node:fs');
const { scanText, report } = require('./leak-scan.js');
const { loadDenylist } = require('./private-denylist.js');

function main(argv) {
  const at = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
  const title = at('--title');
  const bodyFile = at('--body-file');
  if (title === null || !bodyFile) {
    console.error('usage: check-pr-text.js --title <title> --body-file <file|->');
    return 2;
  }
  let body;
  try { body = fs.readFileSync(bodyFile === '-' ? 0 : bodyFile, 'utf8'); } catch {
    console.error(`check-pr-text: could not read ${bodyFile}`);
    return 2;
  }
  const list = loadDenylist();
  if (list.warning) console.error(list.warning);
  for (const e of list.errors) console.error(`private denylist ${e}`);
  const findings = [
    ...scanText('PR title', title, { denylist: list.entries }),
    ...scanText('PR body', body, { denylist: list.entries }),
  ];
  if (!findings.length) { console.log('check-pr-text: clean.'); return 0; }
  report(findings, 'pull request text');
  return 1;
}

process.exit(main(process.argv.slice(2)));
