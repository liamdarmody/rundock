#!/usr/bin/env node
'use strict';
// The leak scan: what must not reach a public repository, checked before it
// gets there. It applies, to any text:
//   - the personal-data rules (scripts/personal-data.js): emails, home paths,
//     account identifiers, tokens, session links;
//   - the generic rules below, which name no one;
//   - the planning-language rules of scripts/check-internal-refs.js, where the
//     repository has that file;
//   - the private denylist (scripts/private-denylist.js), which lives outside
//     every repository because its terms are the names themselves.
// A finding carries a masked match, never the term, so the output of a
// blocked push is itself safe to paste anywhere.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { scanPersonal, mask } = require('./personal-data.js');
const { scanPrivate, loadDenylist } = require('./private-denylist.js');

let planning = null;
try { planning = require('./check-internal-refs.js'); } catch { /* not every repository has it */ }

// MCP servers written as placeholders, which name no service anyone connected.
const PLACEHOLDER_SERVER = /^(?:claude_ai_)?(?:server|service|example[-\w]*|placeholder|name|x|foo|(?:my|some)[-_]?server)$/i;
// The capture scrubber's own numbering (scripts/capture-scrub.js): a service
// becomes connector_N and each of its tools tool_M. Only the pair passes, so
// a real tool name under a numbered server is still a finding.
const SCRUBBED_SERVER = /^connector_\d+$/;
const SCRUBBED_TOOL = /^tool_\d+$/;

const GENERIC_RULES = [
  // A connected service is named by its tool names: mcp__<server>__<tool>.
  // The server may itself hold single underscores, so it ends at the first
  // double one; the tool is the rest of the name.
  {
    label: 'MCP tool name for a real service (use a placeholder server)',
    re: /\bmcp__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*?)__([A-Za-z0-9][A-Za-z0-9_-]*)/g,
    allowed: (m, server, tool) => PLACEHOLDER_SERVER.test(server) || (SCRUBBED_SERVER.test(server) && SCRUBBED_TOOL.test(tool)),
    masked: true,
  },
  // Text that addresses the person the repository belongs to as a third party
  // reads as though someone else wrote it on their behalf.
  {
    label: 'internal-address phrasing (state it in plain engineering voice)',
    re: /\bthe (?:owner|maintainer|product owner)'s (?:call|decision|approval|sign-?off|review)\b|\bflag(?:ging|ged)? (?:this )?for (?:the )?(?:owner|maintainer)\b|\bper the (?:owner|maintainer)\b/gi,
  },
];

function scanGeneric(label, text) {
  const out = [];
  String(text).split('\n').forEach((line, i) => {
    for (const rule of GENERIC_RULES) {
      rule.re.lastIndex = 0;
      for (const m of line.matchAll(rule.re)) {
        if (rule.allowed && rule.allowed(m[0], m[1], m[2])) continue;
        out.push({ file: label, line: i + 1, label: rule.label, match: rule.masked ? mask(m[0]) : m[0] });
      }
    }
  });
  return out;
}

function scanPlanning(label, text) {
  if (!planning || planning.SKIP.some((re) => re.test(label))) return [];
  return planning.scanLines(label, text).map(({ file, line, label: l, match }) => ({ file, line, label: l, match }));
}

// Every finding in `text`, reported against `label` (a path or "commit message").
// `scope` ("<repository folder>/<path>") is where a private entry's signed-off
// exception is matched.
function scanText(label, text, { denylist = [], scope = null } = {}) {
  return [
    ...scanPersonal(label, text).map(({ file, line, label: l, match }) => ({ file, line, label: l, match })),
    ...scanGeneric(label, text),
    ...scanPlanning(label, text),
    ...scanPrivate(label, text, denylist, { scope }),
  ];
}

const IDENTITY_OK = /@users\.noreply\.github\.com$|^noreply@github\.com$/i;

// The lines a unified diff adds, with their line numbers in the new file.
function addedLines(diff) {
  const out = [];
  let file = null; let n = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) { file = line === '+++ /dev/null' ? null : line.slice(4).replace(/^b\//, ''); continue; }
    const hunk = line.match(/^@@ -\S+ \+(\d+)/);
    if (hunk) { n = Number(hunk[1]); continue; }
    if (!file || line.startsWith('---')) continue;
    if (line.startsWith('+')) out.push({ file, line: n++, text: line.slice(1) });
    else if (line.startsWith(' ')) n++;
  }
  return out;
}

const git = (args) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

// A commit's message and the lines it adds (a merge contributes its message:
// what it brings in is scanned in the commits it brings).
function scanCommit(sha, denylist) {
  const short = sha.slice(0, 7);
  const found = scanText('commit message', git(['log', '-1', '--format=%B', sha]), { denylist });
  // Who the commit says wrote and committed it: published with it, and not
  // editable afterwards without rewriting it. Only GitHub's no-reply
  // addresses name no inbox.
  const [author, committer] = git(['log', '-1', '--format=%ae%n%ce', sha]).split('\n');
  for (const [role, email] of [['author', author], ['committer', committer]]) {
    if (!IDENTITY_OK.test(email)) found.push({ file: `commit ${role}`, line: '-', label: 'commit identity email (use the GitHub noreply address)', match: mask(email) });
  }
  const diff = git(['diff-tree', '-p', '-U0', '--no-color', '--no-ext-diff', '--no-renames', '--root', '-r', sha]);
  const byFile = new Map();
  for (const a of addedLines(diff)) {
    if (!byFile.has(a.file)) byFile.set(a.file, []);
    byFile.get(a.file).push(a);
  }
  const repo = path.basename(git(['rev-parse', '--show-toplevel']).trim());
  for (const [file, lines] of byFile) {
    const opts = { denylist, scope: `${repo}/${file}` };
    found.push(...scanText(file, file, opts).map((f) => ({ ...f, line: 'path' })));
    for (const a of lines) found.push(...scanText(file, a.text, opts).map((f) => ({ ...f, line: a.line })));
  }
  return found.map((f) => ({ ...f, commit: short }));
}

// The commits a push sends, from the lines git gives a pre-push hook:
// "<local ref> <local sha> <remote ref> <remote sha>".
function outgoingCommits(stdin, remote) {
  const shas = new Set();
  for (const line of stdin.split('\n').filter(Boolean)) {
    const [, local, , theirs] = line.split(' ');
    if (/^0+$/.test(local)) continue; // a deletion sends nothing
    const range = /^0+$/.test(theirs) ? [local, '--not', `--remotes=${remote}`] : [`${theirs}..${local}`];
    for (const c of git(['rev-list', ...range]).split('\n').filter(Boolean)) shas.add(c);
  }
  return [...shas];
}

function report(findings, what) {
  console.error(`leak-scan: ${what} blocked, ${findings.length} finding(s). Matches are masked; the lines are not printed.\n`);
  for (const f of findings) console.error(`  ${f.commit ? `${f.commit} ` : ''}${f.file}:${f.line}  [${f.label}]  matched "${f.match}"`);
}

function main(argv) {
  const list = loadDenylist();
  if (list.warning) console.error(list.warning);
  for (const e of list.errors) console.error(`private denylist ${e}`);
  const at = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
  let shas;
  if (argv.includes('--pre-push')) shas = outgoingCommits(fs.readFileSync(0, 'utf8'), at('--pre-push') || 'origin');
  else if (at('--range')) shas = git(['rev-list', at('--range')]).split('\n').filter(Boolean);
  else { console.error('usage: leak-scan.js --pre-push <remote> < refs | --range <a..b>'); return 2; }
  const findings = shas.flatMap((c) => scanCommit(c, list.entries));
  if (!findings.length) { console.log(`leak-scan: clean (${shas.length} commit(s)).`); return 0; }
  report(findings, argv.includes('--pre-push') ? 'push' : 'range');
  return 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { GENERIC_RULES, scanText, addedLines, scanCommit, outgoingCommits, report };
