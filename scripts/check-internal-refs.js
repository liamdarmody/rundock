#!/usr/bin/env node
'use strict';
// Guard against internal-reference leaks in the public repository.
//
// Rundock is developed from a private workspace that tracks work with run
// codenames, review-round and priority labels, and vault paths. None of that
// belongs in the public source: comments, tests, and docs should read as plain
// descriptive language to any external contributor browsing the repo.
//
// This scans every tracked text file (minus generated/vendored artifacts) for
// those patterns and exits non-zero on a hit, so CI blocks the leak before it
// merges. To run locally: `npm run check:refs`.
//
// It also scans COMMIT MESSAGES via `--message <file>`, wired up by the
// optional commit-msg hook in scripts/hooks. File scanning alone is not
// enough: a message is history that has to be rewritten to change, and it
// travels further than file content (PR bodies, release notes, git log output
// pasted into issues). A hygiene commit once shipped the very vault paths its
// new rule was written to block, because nothing looked at the message.
//
// If a match is a genuine false positive, prefer rewording the line. As a last
// resort, add an inline `internal-refs-allow` marker on the same line.

const { execSync } = require('node:child_process');
const fs = require('node:fs');

// Paths never scanned: generated bundles, dependency locks, coverage, build
// output, and this checker itself (its pattern list would self-match).
const SKIP = [
  /^public\/vendor\//,
  /^node_modules\//,
  /(^|\/)package-lock\.json$/,
  /(^|\/)coverage\.lcov$/,
  /^dist\//,
  /\.min\.(js|css)$/,
  /^scripts\/check-internal-refs\.js$/,
  // Captured artefacts: transcripts and streams recorded verbatim from the
  // real runtime, kept byte for byte so a format change is visible as a diff.
  // The prose inside them is the runtime's, not ours, and rewording it to
  // satisfy a house style rule would destroy the only thing the capture is
  // for. Skipped rather than marked line by line, because the file is one
  // long machine-written line per message.
  /^scripts\/[a-z-]+\/captured-[a-z-]+\.json$/,
];

// Each rule: a label and a regex that identifies an internal reference. Keep
// these precise so ordinary code never trips them.
const RULES = [
  { label: 'priority/process label (e.g. P0-1)', re: /\bP[0-9]-[0-9]\b/ },
  // Board card ids, the same class as the rule above but in the shape the
  // release cards actually use. The P0-1 rule was written for one board's
  // vocabulary and did not generalise, so a build journal carrying ten
  // instances of R0-01 through R0-04 passed this checker for a day. A card id
  // means nothing to a reader outside the board it came from: name the change,
  // not its tracking number.
  { label: 'board card id (e.g. R0-01, R1-02)', re: /\b[A-Z][0-9]-[0-9]{2}\b/ },
  { label: 'review-round label (e.g. Review R1)', re: /\bReview R[0-9]\b/i },
  { label: 'review-round + priority label (e.g. R2 P3-1)', re: /\bR[0-9] P[0-9](-[0-9])?\b/ },
  { label: 'review-round label (e.g. round-2 regressions)', re: /\bround-?[0-9] regress/i },
  { label: 'internal plan/run codename (e.g. HARDEN1, KAN2)', re: /\b(HARDEN[0-9]*|KAN[0-9])\b/ },
  { label: 'vault / private workspace path', re: /02_Areas|01_Projects|Liam-Agent-Workspace|Obsidian Vaults?/ },
  // The path rule above only catches vault PATHS. These catch references to
  // private workspace CONTENT, which reads as internal to any external
  // contributor even though no path appears. Deliberately narrow: a bare
  // "vault" is a legitimate product term (Obsidian vault support), and a bare
  // 13-digit number is a legitimate millisecond timestamp in protocol traces.
  { label: 'private workspace content reference', re: /\b(vault|private workspace) (conversation|transcript|note|entry)\b/i },
  { label: 'workspace conversation id', re: /\bconversation 1[0-9]{12}\b/i },
  { label: 'internal process phrase', re: /adversarial (sweep|review round)|handoff file per run|completion report per run/i },
  // Board vocabulary (priority/size markers) is planning language, not public
  // language. Narrow by construction: parenthesised or hash-tagged forms only,
  // never a bare token like p1, which appears legitimately in code.
  { label: 'internal priority/size marker', re: /\((?:p[0-3])\)|#priority\/p[0-3]|#size\/(?:xs|s|m|l|xl)\b|\bsize `?(?:xs|m|l|xl)`?, priority\b/ },
  // Internal programme phase names are planning language too. "Phase" alone
  // is a legitimate English word; the internal form is Phase + a bare
  // letter/digit token (with or without a joining colon or dash). One leak
  // shipped in a merge commit before this rule existed.
  { label: 'internal programme phase name (e.g. Phase 0, Phase S)', re: /\bPhase[ -](?:[0-9]|[A-Z])\b(?![a-z])/ },
  // An external tool named as the JUSTIFICATION for a design choice. Naming
  // formats we interoperate with describes the system and belongs in the code;
  // naming a tool as authority describes how the decision was reached, which is
  // planning context. State the reason on its own merits instead: not "hidden,
  // following X" but "markdown is the default format, so the extension never
  // distinguishes one file from another". That also survives the tool changing.
  // Narrow by construction: it matches the citing phrasing, never a bare
  // product name, which appears legitimately across docs, app.js and search.js.
  {
    label: 'external tool cited as design rationale (state the reason itself)',
    re: /\b(following|per|as in|mirrors?|matching|copying|like)\s+(Obsidian|Notion|Cursor|VS ?Code|Linear)\b|\b(Obsidian|Notion|Cursor|VS ?Code|Linear)('s)?\s+(convention|precedent|rule|behaviou?r)\b/i,
  },
  // Owner-attributed decisions. The name itself is legitimate here: it is in
  // the LICENSE, the README byline, and the example agent files. What does not
  // belong is who authorised something, which describes how work was approved
  // rather than what the software does. An earlier version matched only the
  // parenthesised and dated forms, and "Liam authorised proceeding" walked
  // straight through it into a tracked file.
  {
    label: 'owner-attributed decision note',
    re: /\(Liam[ ,]|Liam 20[0-9]{2}|decision,? Liam|\bLiam (authoris|approv|decid|direct|instruct|confirm|request|sign)\w*\b|\bper Liam\b|\bLiam's (call|decision|instruction|approval)\b/i,
  },
  // Planning arithmetic about how the work is MANAGED: budgets and their
  // revisions. Deliberately narrow. A factual count like "3 of 3 rounds" is
  // the harness recording what happened and is the entire point of a ledger,
  // so it must not trip this. The first version of this rule caught exactly
  // that, which is a rule wider than its stated intent.
  {
    label: 'internal process budget',
    re: /\b(programme|program|round|review) budget\b|\bbudget from [0-9]+ to [0-9]+\b/i,
  },
  // Style rule: no em or en dashes anywhere. Use a colon, comma, full stop, or
  // restructure. Genuinely intentional dashes (a splitter char class, the
  // prompt that defines the rule) carry an inline internal-refs-allow marker.
  { label: 'em or en dash (use a colon, comma, or full stop)', re: /[—–]/ },
];

function trackedFiles() {
  const out = execSync('git ls-files', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').filter(Boolean).filter((f) => !SKIP.some((re) => re.test(f)));
}

function isProbablyBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// Scan one file's lines, collecting rule hits. Comment lines in a commit
// message (git's own `#` scissors and help text) are skipped: they never
// become part of the stored message.
function scanLines(label, text, { skipHashComments = false } = {}) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (line.includes('internal-refs-allow')) return;
    if (skipHashComments && line.startsWith('#')) return;
    for (const rule of RULES) {
      const m = line.match(rule.re);
      if (m) out.push({ file: label, line: i + 1, label: rule.label, match: m[0], text: line.trim().slice(0, 120) });
    }
  });
  return out;
}

const msgFlag = process.argv.indexOf('--message');
const MESSAGE_FILE = msgFlag >= 0 ? process.argv[msgFlag + 1] : null;

const findings = [];
if (MESSAGE_FILE) {
  // Commit-message mode: scan only the message.
  let text = '';
  try { text = fs.readFileSync(MESSAGE_FILE, 'utf8'); } catch {
    console.error(`check-internal-refs: could not read message file ${MESSAGE_FILE}`);
    process.exit(1);
  }
  findings.push(...scanLines('commit message', text, { skipHashComments: true }));
} else {
  for (const file of trackedFiles()) {
    let buf;
    try { buf = fs.readFileSync(file); } catch { continue; }
    if (isProbablyBinary(buf)) continue;
    findings.push(...scanLines(file, buf.toString('utf8')));
  }
}

const scope = MESSAGE_FILE ? 'commit message' : 'tracked files';
if (findings.length === 0) {
  console.log(`check-internal-refs: clean (no internal references in ${scope}).`);
  process.exit(0);
}

console.error(`check-internal-refs: found ${findings.length} internal reference(s) that must not ship in the public repo.\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  [${f.label}]  matched "${f.match}"`);
  console.error(`    ${f.text}`);
}
console.error(`\nReword these in plain descriptive language${MESSAGE_FILE ? ', then commit again.' : ', then re-run: npm run check:refs'}`);
process.exit(1);
