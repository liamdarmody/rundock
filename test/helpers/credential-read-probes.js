'use strict';
// SHELL PROBES OVER THE CREDENTIAL FILES, FOR THE TESTS THAT RUN THEM IN A REAL
// SANDBOX. Each probe is one line of `sh` that prints its label, its command's
// exit status and what the command printed, on one line, so a run reads back
// as a table whatever ran it. Every path a probe names is under a made-up home
// holding dummy contents: no probe names the account's own home.
const fs = require('fs');
const path = require('path');

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const probe = (label, command) =>
  `out=$(${command} 2>&1); s=$?; printf '%s\\t%s\\t%s\\n' ${quote(label)} "$s" "$(printf %s "$out" | tr '\\n\\t' '  ')"`;

// The lines of a run's output that carry one of the labels asked for.
function parseReport(text, labels) {
  const wanted = new Set(labels);
  return new Map(String(text).split('\n').map((line) => line.split('\t'))
    .filter(([label, status]) => wanted.has(label) && /^\d+$/.test(status))
    .map(([label, status, out = '']) => [label, { status: Number(status), out }]));
}

const dummy = (file) => `dummy contents of ${path.basename(file)}\n`;
const beside = (file) => path.join(path.dirname(file), 'beside-it.txt');
const linkIn = (ws, i) => path.join(ws, `link-${i}`);

// A dummy file at each path, an unnamed one beside each, and a symbolic link
// in the workspace to each.
function plant(files, ws) {
  fs.mkdirSync(ws, { recursive: true });
  files.forEach((file, i) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, dummy(file));
    fs.writeFileSync(beside(file), dummy(beside(file)));
    fs.symlinkSync(file, linkIn(ws, i));
  });
}

// The read spellings both tests use: the plain path, a quoted one, and the
// symbolic link in the workspace.
const reads = (file, i, ws) => [
  { label: `plain ${i}`, file, command: `cat ${file}` },
  { label: `quoted ${i}`, file, command: `cat ${quote(file)}` },
  { label: `link ${i}`, file, command: `cat ${quote(linkIn(ws, i))}` },
];

// A hard link, measured in three separate steps so no step's outcome is
// mistaken for another's: `ln` alone; then the destination's link count, read
// from the destination only, since a metadata read of the credential file
// itself may be refused; then a read of the destination.
const hardLink = (file, i, dest) => [
  { label: `ln ${i}`, file, command: `ln ${quote(file)} ${quote(dest)}` },
  { label: `link count ${i}`, file, command: `stat -f %l ${quote(dest)}` },
  { label: `read through hard link ${i}`, file, command: `cat ${quote(dest)}` },
];

// The link was made if `ln` succeeded or the destination is a second name.
const linkMade = (report, i) => report.get(`ln ${i}`).status === 0
  || (report.get(`link count ${i}`).status === 0 && Number(report.get(`link count ${i}`).out) >= 2);

const refused = (o, file) => o.status !== 0 && /Operation not permitted/.test(o.out) && !o.out.includes(dummy(file).trim());

// One table row per probe, with the made-up home written as <home>.
const row = (block, p, o, home) => `| ${block} | ${p.label} | ${p.file ? path.relative(home, p.file) : '-'} | ${o ? o.status : 'no line'} | ${(o ? o.out : '').split(home).join('<home>').replace(/\|/g, '\\|').slice(0, 300)} |`;
const HEADER = '| block | probe | file | exit | output |';

module.exports = { quote, probe, parseReport, dummy, beside, plant, reads, hardLink, linkMade, refused, row, HEADER };
