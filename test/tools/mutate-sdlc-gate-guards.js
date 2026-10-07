#!/usr/bin/env node
'use strict';
// Break each of the gate-hardening guards in turn and report which tests
// notice.
//
// The rules this change leaves behind are rules about the instruments
// themselves: a documented destructive step must carry its caution, a
// source-walking extraction must be registered with a fail-loud property, an
// unparsable mutation result must refuse rather than crash, and the
// reference scanner must know the acceptance-label shape. Every one of them
// polices an absence, and an absence nobody can break is an absence nobody
// is checking, so each is broken here on purpose and a test must go red.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-sdlc-gate-guards.js            # report
//   node test/tools/mutate-sdlc-gate-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws.
//
// The harness is the same shape as mutate-routines-truth-guards.js and is
// deliberately a separate copy rather than a shared module, for the reason
// stated there: pulling them together means editing an instrument already in
// the gate, and mixing that refactor into a feature is how a gate quietly
// stops checking what it used to.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const {
  beginMutationRun, targetsFromRows, rowsForShard, exitCodeFor, NO_VERDICT,
} = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

// The evidence document whose destructive commands carry cautions, watched by
// the scan that requires the caution beside the command.
const EVIDENCE = { src: path.join(ROOT, 'docs', 'evidence', 'setup-race-flakes-evidence.md'), suite: 'test/unit/sdlc-gate-hardening.test.js' };
// The mutation envelope, watched for its stated limitation.
const ENVELOPE = { src: path.join(ROOT, 'test', 'tools', 'mutation-run.js'), suite: 'test/unit/sdlc-gate-hardening.test.js' };
// The focused suite itself, mutated only in the put-something-back direction:
// its registry is emptied so its own registration check must fire, proving
// the detector finds files and the equality bites rather than agreeing with
// whatever it happens to hold.
const FOCUSED = { src: path.join(ROOT, 'test', 'unit', 'sdlc-gate-hardening.test.js'), suite: 'test/unit/sdlc-gate-hardening.test.js' };
// One harness, reverted to the crash it no longer has, watched by the
// uniformity walk that drives every harness's parser.
const TRUTH_HARNESS = { src: path.join(ROOT, 'test', 'tools', 'mutate-routines-truth-guards.js'), suite: 'test/unit/sdlc-gate-hardening.test.js' };
// The reference scanner, watched by the tests that drive its rule table.
const SCANNER = { src: path.join(ROOT, 'scripts', 'check-internal-refs.js'), suite: 'test/unit/sdlc-gate-hardening.test.js' };
// The one harness that proved parser and report can drift apart, watched by
// the report-path uniformity tests.
const ROLLBACK_HARNESS = { src: path.join(ROOT, 'test', 'tools', 'mutate-workspace-rollback-guards.js'), suite: 'test/unit/sdlc-gate-hardening.test.js' };
// A registered enumeration whose guard the registry claims: deleting the
// guard must redden the registry's anchor check, or the inventory is prose.
const DOC_LINKS = { src: path.join(ROOT, 'test', 'unit', 'doc-links.test.js'), suite: 'test/unit/sdlc-gate-hardening.test.js' };
// Personal data: the rules, the scanner's use of them, the capture scrubber
// and both capture scripts, each watched by the suite that drives them with
// specimens.
const PERSONAL = { src: path.join(ROOT, 'scripts', 'personal-data.js'), suite: 'test/unit/personal-data.test.js' };
const SCANNER_PD = { src: path.join(ROOT, 'scripts', 'check-internal-refs.js'), suite: 'test/unit/personal-data.test.js' };
const SCRUB = { src: path.join(ROOT, 'scripts', 'capture-scrub.js'), suite: 'test/unit/personal-data.test.js' };
const STREAM_CAPTURE = { src: path.join(ROOT, 'scripts', 'stream-truth', 'run.mjs'), suite: 'test/unit/personal-data.test.js' };
const TRANSCRIPT_CAPTURE = { src: path.join(ROOT, 'scripts', 'transcript-truth', 'run.mjs'), suite: 'test/unit/personal-data.test.js' };
// The pre-commit gate's record of each tree it passed, watched by the suite
// that runs the real gate against a throwaway repository.
const GATE = { src: path.join(ROOT, 'scripts', 'precommit-gate.js'), suite: 'test/unit/precommit-gate.test.js' };
// The release gate's refusals: CI's verdict on the exact tree, the candidate's
// version, the smoke ports, and the tag's tree-keyed record, each watched by
// the suite that drives it.
const RELEASE_CI = { src: path.join(ROOT, 'scripts', 'release-ci.js'), suite: 'test/unit/release-ci.test.js' };
const RELEASE_GATE = { src: path.join(ROOT, 'scripts', 'release-gate.js'), suite: 'test/unit/release-gate.test.js' };
const RELEASE_RECORD = { src: path.join(ROOT, 'scripts', 'release.js'), suite: 'test/unit/release-gate.test.js' };
const RELEASE_TAG = { src: path.join(ROOT, 'scripts', 'release.js'), suite: 'test/unit/release-tag.test.js' };
// The mutation scope and the CI retry classifier, each watched by its suite.
const SCOPE = { src: path.join(ROOT, 'scripts', 'mutation-scope.js'), suite: 'test/unit/mutation-scope.test.js' };
const CI_VERDICT = { src: path.join(ROOT, 'scripts', 'ci-verdict.js'), suite: 'test/unit/ci-verdict.test.js' };

const MUTATIONS = [
  // ===== A DESTRUCTIVE STEP WITHOUT ITS CAUTION =====
  // Delete the first caution sentence and the command it excuses stands
  // alone, which is the exact document shape that cost a reader their
  // working tree.
  [EVIDENCE, 'a documented destructive command keeps its caution beside it',
    ' (A caution before repeating that revert: it\nrestores the committed file by throwing away whatever is in the working copy, so\nif you carry uncommitted work in that file it is erased, not restored. Copy the\nfile aside before making the break, and put the copy back instead.)',
    ''],

  // ===== THE RESIDUE LIMITATION =====
  // Remove the statement and a reader is back to trusting a clean tree.
  [ENVELOPE, 'the envelope states that a clean tree cannot prove work was not erased',
    'the scan cannot tell\n// untouched from erased',
    'the scan reports\n// the tree state'],

  // ===== THE ENUMERATION REGISTRY =====
  // Empty the registry and every detected extraction is unregistered, so the
  // registration check must fire for all of them. A check that stayed green
  // here would be comparing the detector against nothing and agreeing.
  [FOCUSED, 'the registration check reads the registry and the detector finds files',
    'const ENUMERATIONS = [',
    'const ENUMERATIONS = [] || ['],

  // ===== THE UNPARSABLE REFUSAL =====
  // Put the crash back in one harness and the uniformity walk must name it.
  [TRUTH_HARNESS, 'an unparsable suite result refuses instead of crashing',
    '    return { unparsable: true };',
    "    throw new Error('unparsable suite output');"],

  // ===== THE ACCEPTANCE-LABEL RULE =====
  // Remove the rule and a new file can ship the label shape again.
  [SCANNER, 'the scanner knows the acceptance-label shape',
    "    re: /\\bAC-[A-Z]?[0-9]+\\b/,\n    amnesty: AC_LABEL_AMNESTY,",
    "    re: /\\bNEVER-MATCHES-ANYTHING-[0-9]+\\b/,\n    amnesty: AC_LABEL_AMNESTY,"],
  // Remove the amnesty consult and every legacy file fails the gate at once,
  // which is the ratchet collapsing into a flag day nobody scheduled.
  // ===== A REGISTERED GUARD DELETED UNDER A GREEN INVENTORY =====
  // Remove a registered file's floor and the registry row still says the
  // enumeration fails loudly; the anchor check is what has to notice, by
  // row, or the whole inventory is a list of claims.
  [DOC_LINKS, 'deleting a registered guard reddens the registry by row',
    "  assert.ok(checked >= 10, `only ${checked} relative links found; the link pattern has gone blind`);\n",
    ''],

  // ===== A REFUSAL MISREPORTED AS A DEFINITE RESULT =====
  // Remove the report branch and a parser refusal falls through to the
  // nothing-turned-red case: a definite verdict about a mutation for which
  // no verdict exists, in the one harness that already drifted this way once.
  [ROLLBACK_HARNESS, 'a parser refusal reaches the report as no verdict, never as nothing-turned-red',
    "    if (unparsable) {\n      failed++;\n      const why = 'no verdict: the suite failed but its output could not be parsed, so nothing '\n        + 'about this mutation is known; fix the reporter parsing rather than trusting a rerun';\n      lines.push(markdown ? `| ${label} | ${matches} | **${why}** | |` : `${label}\\n  ${why.toUpperCase()}`);\n      continue;\n    }\n",
    ''],

  [SCANNER, 'the amnesty is consulted before the rule fires',
    '      if (rule.amnesty && rule.amnesty.has(label)) continue;',
    '      if (rule.amnesty && false) continue;'],
  // ===== NO PERSONAL DATA IN THE PUBLIC REPOSITORY =====
  [PERSONAL, "an email address is a finding",
    "  { label: 'email address (use a reserved example domain)', re: EMAIL, allowed: emailAllowed },\n",
    ""],
  [PERSONAL, "only reserved example domains pass as addresses",
    "const RESERVED_DOMAIN = /(^|\\.)(example\\.(com|net|org)|example|test|invalid|localhost)$/i;",
    "const RESERVED_DOMAIN = /./;"],
  [PERSONAL, "only the exact upstream addresses pass by value",
    "  return UPSTREAM.has(address.toLowerCase());",
    "  return true;"],
  [PERSONAL, "a home directory with a name in it is a finding",
    "  { label: 'home directory with a name in it (use a placeholder)', re: HOME, allowed: (m, g1) => PLACEHOLDER_NAMES.has(g1) },\n",
    ""],
  [PERSONAL, "a real name is not a placeholder",
    "  { label: 'home directory with a name in it (use a placeholder)', re: HOME, allowed: (m, g1) => PLACEHOLDER_NAMES.has(g1) },",
    "  { label: 'home directory with a name in it (use a placeholder)', re: HOME, allowed: (m, g1) => g1.length < 6 },"],
  [PERSONAL, "a project directory named after a real path is a finding",
    "  { label: 'Claude Code project directory for a real path', re: PROJECTS, allowed: (m, name) => name !== undefined && PLACEHOLDER_NAMES.has(name) },\n",
    ""],
  [PERSONAL, "a per-user temporary directory is a finding",
    "  { label: 'per-user temporary directory', re: MAC_TEMP },\n",
    ""],
  [PERSONAL, "an account or organisation identifier is a finding",
    "  { label: 'account or organisation identifier', re: ID_KEY, allowed: (m, uuid) => ZERO_UUID.test(uuid) },\n",
    ""],
  [PERSONAL, "an identifier is caught inside a JSON string too",
    "const QUOTE = `(?:\\\\\\\\?[\"'])?`;",
    "const QUOTE = `[\"']?`;"],
  [PERSONAL, "a token-shaped string is a finding",
    "  { label: 'token-shaped secret', re: TOKEN },\n",
    ""],
  [PERSONAL, "a private key block is a token",
    "  `-----BEGIN [A-Z ]*${'PRIVATE'} KEY-----`,\n",
    ""],
  [PERSONAL, "a session link is a finding",
    "  { label: 'Claude Code session link', re: SESSION_LINK },\n",
    ""],
  [PERSONAL, "a finding never prints what it found",
    "match: mask(m[0]),",
    "match: m[0],"],
  [SCANNER_PD, "every tracked file is checked for personal data, whatever the planning rules skip",
    "    findings.push(...scanPersonal(file, text));\n",
    "    if (!SKIP.some((re) => re.test(file))) findings.push(...scanPersonal(file, text));\n"],
  [SCANNER_PD, "a commit message is checked for personal data",
    "  findings.push(...scanPersonal('commit message', text, { skipHashComments: true }));\n",
    ""],
  [SCRUB, "a capture is scrubbed of emails",
    "    (m) => (emailAllowed(m) ? m : PLACEHOLDERS.email));",
    "    (m) => m);"],
  [SCRUB, "a capture is scrubbed of the home directory",
    "  if (values.home) out = replaceAll(replaceAll(out, values.home, PLACEHOLDERS.home), encodePath(values.home), ENCODED.home);\n",
    ""],
  [SCRUB, "a capture is scrubbed of the temporary directory",
    "  for (const t of tmps) out = replaceAll(replaceAll(out, t, PLACEHOLDERS.tmp), encodePath(t), ENCODED.tmp);\n",
    ""],
  [SCRUB, "a capture is scrubbed of the username",
    "    out = out.replace(new RegExp(escape(values.user), 'g'), PLACEHOLDERS.user);\n",
    ""],
  [SCRUB, "a capture is scrubbed of account identifiers",
    "    (m, key) => `${key}${PLACEHOLDERS.uuid}`,",
    "    (m) => m,"],
  [SCRUB, "a capture is scrubbed of its session id",
    "  for (const id of values.sessionIds || []) out = replaceAll(out, id, PLACEHOLDERS.session);\n",
    ""],
  [SCRUB, "a capture is scrubbed of the account email block",
    "  out = out.replace(/The user's email address is [^\\n\\\\\"]*?unless the user explicitly asks\\./g, PLACEHOLDERS.emailBlock);\n",
    ""],
  [STREAM_CAPTURE, "the stream capture is scrubbed before it is written",
    "  fs.writeFileSync(CAPTURE_FILE, scrubCapture(JSON.stringify(captured, null, 2) + '\\n'));",
    "  fs.writeFileSync(CAPTURE_FILE, (JSON.stringify(captured, null, 2) + '\\n'));"],
  [TRANSCRIPT_CAPTURE, "the transcript capture is scrubbed before it is written",
    "  fs.writeFileSync(CAPTURE_FILE, scrubCapture(JSON.stringify({",
    "  fs.writeFileSync(CAPTURE_FILE, (JSON.stringify({"],

  // ===== NO CONNECTED SERVICE IN A CAPTURE =====
  [PERSONAL, "a connected service named in a capture is a finding",
    "  { label: 'connected service named in a capture (scrub it)', re: MCP_NAME, appliesTo: CAPTURE_FILE, allowed: (m) => MCP_PLACEHOLDER.test(m) },\n",
    ""],
  [PERSONAL, "a connected service's display name in a capture is a finding",
    "  { label: 'connected service named in a capture (scrub it)', re: CONNECTOR_DISPLAY, appliesTo: CAPTURE_FILE },\n",
    ""],
  [PERSONAL, "only the scrubber's placeholder form passes in a capture",
    "allowed: (m) => MCP_PLACEHOLDER.test(m) },",
    "allowed: () => true },"],
  [PERSONAL, "the connected-service rule applies only to captures",
    "      if (rule.appliesTo && !rule.appliesTo.test(label)) continue;\n",
    ""],
  [SCRUB, "a capture is scrubbed of connected services",
    "  return scrubConnectors(out);",
    "  return out;"],
  [SCRUB, "a connected service's instructions are removed from a capture",
    "      s = s.split(b).join(`## ${name}\\n${REMOVED_INSTRUCTIONS}`);\n",
    ""],
  [SCRUB, "installed skills are scrubbed from a capture",
    "      s = s.replace(new RegExp(`(^|\\\\n)- ${escape(n)}:[^\\\\n]*`, 'g'), `$1- ${k}: ${REMOVED_SKILL}`);\n",
    ""],

  // ===== EVERY GATED TREE KEEPS ITS OWN RECORD =====
  [GATE, "a pass keeps its record under its tree's name too",
    "      writeTreeRecord(record);\n",
    ""],
  [GATE, "the oldest kept records beyond the limit are removed",
    "  for (const old of kept.slice(keep)) fs.rmSync(path.join(dir, old.name), { force: true });\n",
    ""],
  [GATE, "a kept record needs a full tree hash for its name",
    "  if (!record || !/^[0-9a-f]{40}$/.test(String(record.tree))) {",
    "  if (!record) {"],
  [GATE, "pruning touches only files named for a tree",
    "    .filter((name) => TREE_RECORD_NAME.test(name))",
    "    .filter(() => true)"],
  [GATE, "fifty records are kept",
    "const TREE_RECORDS_KEPT = 50;",
    "const TREE_RECORDS_KEPT = 5;"],

  // ===== THE RELEASE GATE TAKES THE SUITE FROM CI, FOR THIS TREE ONLY =====
  [RELEASE_CI, "a required check CI has not passed refuses the gate",
    "  if (missing.length) {",
    "  if (false) {"],
  [RELEASE_CI, "a run of another tree does not count",
    "  if (!run.head_commit || run.head_commit.tree_id !== tree) return { exact: false };",
    "  if (!run.head_commit) return { exact: false };"],
  [RELEASE_CI, "a pull request run counts only when its branch contains main",
    "  const based = (run.pull_requests || []).some((pr) => pr && pr.base && pr.base.sha && isAncestor(pr.base.sha, run.head_sha));",
    "  const based = true;"],
  [RELEASE_CI, "only a completed, successful job counts",
    "      if (job.status === 'completed' && job.conclusion === 'success') {",
    "      if (job.status === 'completed') {"],
  [RELEASE_CI, "GitHub unreachable is a refusal",
    "    return { ok: false, error: `Could not read CI's results from GitHub: ${err.message}` };",
    "    runs = [];"],
  [RELEASE_GATE, "the gate stops when CI has not passed this tree",
    "    if (!verdict.ok) return finish(false, verdict.error);",
    ""],
  [RELEASE_GATE, "the candidate is exactly one release past the latest tag",
    "  if (!allowed.includes(pkgVersion)) {",
    "  if (false) {"],
  [RELEASE_GATE, "the changelog's top heading names the candidate's version",
    "  if (top === -1 || !lines[top].startsWith(`## ${pkgVersion}:`)) {",
    "  if (top === -1) {"],
  [RELEASE_GATE, "a held smoke port refuses before any step",
    "  if (held.length) {",
    "  if (false) {"],
  [RELEASE_GATE, "a dirty tree refuses",
    "    if (dirty) {",
    "    if (false) {"],
  [RELEASE_RECORD, "the record must name the tree being tagged",
    "  if (record.tree !== headTree) {",
    "  if (false) {"],
  [RELEASE_RECORD, "a record without live smoke is refused",
    "  if (!record.live) {",
    "  if (false) {"],
  [RELEASE_RECORD, "a record that did not read CI is refused",
    "  if (!record.ci || record.ci.skipped || !record.ci.checks) {",
    "  if (false) {"],
  [RELEASE_TAG, "the tag checks the gate record against the merged tree",
    "  requireGatePass(git(['rev-parse', `${merged}^{tree}`]).trim(), { root });\n",
    ""],

  // ===== THE MUTATION SCOPE: WHAT A CHANGE CAN REACH =====
  // Comparing against HEAD instead of the merge base is the defect that made
  // every push to main run everything and every merge of main re-test main.
  [SCOPE, "the merge base is the base, not HEAD",
    "      const mb = git(['merge-base', head, trunk]);",
    "      const mb = git(['rev-parse', head]);"],
  [SCOPE, "an empty diff from a resolved base runs nothing",
    "    return { run: [], skipped: harnesses.map((h) => ({ tool: h.tool, reason: 'nothing changed' })), reason: 'nothing changed against the base' };",
    "    return all('no changed files could be determined, so nothing was narrowed');"],
  [SCOPE, "an unresolved base runs everything",
    "  if (changed === null) return all('no comparison base could be resolved, so nothing was narrowed');",
    "  if (changed === null) changed = [];"],
  [SCOPE, "a file a guarded file reads selects that harness",
    "      if (reader) { read = `${reader} reads ${f}`; break; }",
    "      if (false && reader) { read = `${reader} reads ${f}`; break; }"],
  [SCOPE, "a dependency change runs everything",
    "  if (dependencyChange) return all(`${dependencyChange} can change what any suite does`);\n",
    ""],
  [SCOPE, "a harness ended by a signal is no verdict, not a pass",
    "  if (signal) return { outcome: NO_VERDICT, cause: `ended by signal ${signal}` };",
    "  if (signal) return { outcome: PASS };"],
  [SCOPE, "a shard with no verdict file is no verdict",
    "    if (!v) {\n      outcomes.push(NO_VERDICT);",
    "    if (!v) {\n      outcomes.push(PASS);"],

  // ===== THE CI RETRY: ONCE, AND ONLY FOR A LOST RUNNER =====
  [CI_VERDICT, "a runner shutdown is retried",
    "  /runner has received a shutdown signal/i,\n",
    ""],
  [CI_VERDICT, "a second attempt is never retried",
    "  if (Number(run.run_attempt) !== 1) return none(`attempt ${run.run_attempt} is never re-run, so a retry cannot loop`);\n",
    ""],
  [CI_VERDICT, "a superseded run is not retried",
    "  if (newerRun || notOk.some((j) => j.kind === 'superseded')) return none('superseded: a newer run is the one that counts');\n",
    ""],
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
    // verdict: not red, not green, nothing. Refused as a named row rather
    // than thrown, so the report says which mutation was in flight instead
    // of a stack trace that names nothing. The spec reporter's format is
    // what this parses; if it changed, fix the parser rather than trusting
    // an empty result.
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
  // Derived from the rows, so a row naming a new target cannot crash the run
  // on a target nobody listed.
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
// mutate-routines-guards.js for the runs that taught this: a full temp root
// surfaces as tests going red, and red tests are exactly what this
// instrument reports as a guard nobody was watching.
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
      + ' and a mutation that could break more than one place proves nothing about either.');
    process.exit(exitCodeFor(failed, results));
  }
}

module.exports = { MUTATIONS, run };
