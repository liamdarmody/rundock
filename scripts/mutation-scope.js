#!/usr/bin/env node
'use strict';

/**
 * Decide which mutation harnesses a change can reach, split them across CI
 * shards, run them, and report one of three outcomes: pass, fail, or no
 * verdict.
 *
 * THE DANGER IS THE WHOLE POINT. A selection that skips work is one that can
 * report green without having looked, so every rule below is written to make
 * skipping conservative and visible rather than convenient and silent:
 *
 *   - What a harness touches comes from its ROWS: each row's target names the
 *     source file it breaks and the suite that must go red. Every harness
 *     exports its rows and runs only under `require.main`, so requiring it to
 *     read them executes nothing (a test enforces both).
 *   - A harness that cannot be loaded, or whose rows cannot be read, RUNS.
 *   - A changed file that no harness guards selects a harness when one of that
 *     harness's guarded files reads it by path: a require or import specifier,
 *     or a path string literal that resolves to it. One hop, static, nothing
 *     executed. This is how a fixture, a capture or a test helper reaches the
 *     harnesses whose suites read it, and only those.
 *   - A change to the mutation machinery itself runs everything. So does a
 *     change to a dependency in package.json or package-lock.json; a
 *     scripts-only edit to package.json changes nothing a harness proves.
 *   - The base is the MERGE BASE, set explicitly where it is known. A diff
 *     against anything later than the merge base hides the branch's own work;
 *     a diff against anything earlier re-tests main's. An unresolvable base
 *     runs everything; an empty diff from a resolved base runs nothing, and
 *     says so.
 *   - What was skipped is named, with its reason.
 *
 *   node scripts/mutation-scope.js                  # run the scoped set
 *   node scripts/mutation-scope.js --explain        # decide and print, run nothing
 *   node scripts/mutation-scope.js --all            # every harness
 *   node scripts/mutation-scope.js --base <rev>     # compare against <rev>
 *   node scripts/mutation-scope.js --head <rev>     # measure a past commit
 *   node scripts/mutation-scope.js --plan           # write the shard plan (CI)
 *   node scripts/mutation-scope.js --shard k/n      # run one shard of the plan
 *   node scripts/mutation-scope.js --aggregate      # one outcome from every shard
 *
 * Exit codes: 0 pass, 1 fail, 3 no verdict.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TOOLS = path.join(ROOT, 'test', 'tools');

const PASS = 'pass';
const FAIL = 'fail';
const NO_VERDICT = 'no verdict';
const EXIT = { [PASS]: 0, [FAIL]: 1, [NO_VERDICT]: 3 };
// The harness exit code for "could not find out", owned by mutation-run.js.
const HARNESS_NO_VERDICT = 3;

// A change to any of these can change what ANY harness proves: the selector,
// the envelope every harness runs inside, and the workflow that runs them.
const RUN_EVERYTHING_WHEN_TOUCHED = [
  'scripts/mutation-scope.js',
  'test/tools/mutation-run.js',
  '.github/workflows/ci.yml',
];

// Files whose change matters only where a dependency moved. A scripts-only
// edit to package.json cannot change what a harness proves; a new or bumped
// dependency can change what every suite does.
const DEPENDENCY_MANIFESTS = ['package.json', 'package-lock.json'];
const DEPENDENCY_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

// Shards: rows per shard and the most shards a run may use. At roughly three
// seconds a row, 200 rows is about ten minutes, a third of a shard's cap.
const ROWS_PER_SHARD = 200;
const MAX_SHARDS = 10;

const rel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');
const suiteFile = (suite) => String(suite).split('#')[0];

function harnessFiles(toolsDir = TOOLS) {
  return fs.readdirSync(toolsDir)
    .filter((n) => /^mutate-.*-guards\.js$/.test(n))
    .sort();
}

/**
 * Every harness, read from its rows: its row count, the files it mutates and
 * the suites it reads, as repository-relative paths.
 *
 * A harness that cannot be loaded, or exports no rows, is returned with an
 * `error` and no targets, and the selection runs it: knowing nothing about a
 * harness is a reason to run it, never to skip it.
 */
function loadHarnesses({ toolsDir = TOOLS, root = ROOT } = {}) {
  // Compared as real paths: a module's __dirname is resolved through symlinks
  // (a temp directory on macOS is one), the root as given may not be.
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const realRoot = real(root);
  return harnessFiles(toolsDir).map((tool) => {
    const file = path.join(toolsDir, tool);
    const own = rel(realRoot, real(file));
    try {
      const mod = require(file);
      const rows = mod && mod.MUTATIONS;
      if (!Array.isArray(rows) || !rows.length) throw new Error('it exports no MUTATIONS');
      const sources = new Set();
      const suites = new Set();
      for (const row of rows) {
        const target = Array.isArray(row) && row[0] && typeof row[0] === 'object' ? row[0] : mod.TARGET;
        if (!target || typeof target.src !== 'string' || typeof target.suite !== 'string') {
          throw new Error(`a row names no target with a src and a suite: ${JSON.stringify(row && row[1])}`);
        }
        sources.add(rel(realRoot, real(path.resolve(root, target.src))));
        suites.add(suiteFile(target.suite));
      }
      const guarded = new Set([own, ...sources, ...suites]);
      return { tool, file: own, rows: rows.length, sources: [...sources], suites: [...suites], guarded: [...guarded] };
    } catch (e) {
      return { tool, file: own, rows: null, error: e.message, guarded: [own] };
    }
  });
}

// ---------------------------------------------------------------------------
// Readers: which guarded files read a changed file by path
// ---------------------------------------------------------------------------

const STRING_LITERAL = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const JOIN_CALL = /path\.(?:join|resolve)\(([^()]*)\)/g;
const RESOLVE_EXTENSIONS = ['', '.js', '.json', '.mjs', '.cjs', '/index.js'];

function existsAt(root, candidate) {
  if (!candidate || candidate.startsWith('..')) return null;
  for (const ext of RESOLVE_EXTENSIONS) {
    const p = candidate + ext;
    try {
      if (fs.statSync(path.join(root, p)).isFile()) return p;
    } catch { /* not this one */ }
  }
  return null;
}

/**
 * Every repository file a source file names by path, read statically.
 *
 * Two readings, and each can only ADD a file, which is the safe direction: a
 * string literal (a require or import specifier is one) resolved against the
 * file's directory and against the repository root; and a `path.join` or
 * `path.resolve` call whose string arguments are joined and resolved the same
 * two ways. A bare file name is NOT matched on its own: names like SKILL.md
 * and rundock.json recur across the tree, and matching them selected nearly
 * every harness for a change that touched none of their inputs.
 */
function pathReferences(source, fileRel, root = ROOT) {
  const dir = path.posix.dirname(fileRel);
  const files = new Set();
  const consider = (text) => {
    // Only something shaped like a path: a separator or an extension.
    if (!text || !/[/.]/.test(text) || text.length > 300 || /[\s*?<>|]/.test(text) || /^[a-z]+:\/\//i.test(text)) return;
    const clean = text.replace(/^\.\//, '');
    for (const base of [dir, '']) {
      const found = existsAt(root, path.posix.normalize(path.posix.join(base, clean)));
      if (found) files.add(found);
    }
  };
  for (const m of source.matchAll(STRING_LITERAL)) {
    if (m[1] === '`' && m[2].includes('${')) continue;
    consider(m[2]);
  }
  for (const m of source.matchAll(JOIN_CALL)) {
    const parts = [...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((p) => p[1] !== undefined ? p[1] : p[2]);
    if (parts.length) consider(parts.join('/'));
  }
  return files;
}

function makeReaderIndex(root = ROOT) {
  const cache = new Map();
  const refsOf = (fileRel) => {
    if (!cache.has(fileRel)) {
      let src = '';
      try { src = fs.readFileSync(path.join(root, fileRel), 'utf8'); } catch { /* unreadable reads nothing */ }
      cache.set(fileRel, pathReferences(src, fileRel, root));
    }
    return cache.get(fileRel);
  };
  // Which of `guarded` reads `changed`, or null.
  return (changed, guarded) => guarded.find((g) => refsOf(g).has(changed)) || null;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Which harnesses a set of changed files requires.
 *
 * `changed` is repository-relative paths, or null when no base could be
 * resolved. `harnesses` is what loadHarnesses returns. `dependencyChange`
 * names a dependency that moved, or is null. `readerOf(file, guarded)` names
 * the guarded file that reads `file`, or null.
 */
function selectHarnesses(changed, harnesses, { dependencyChange = null, readerOf = () => null } = {}) {
  const all = (reason) => ({ run: harnesses.map((h) => h.tool), skipped: [], reason });
  if (changed === null) return all('no comparison base could be resolved, so nothing was narrowed');
  if (!changed.length) {
    return { run: [], skipped: harnesses.map((h) => ({ tool: h.tool, reason: 'nothing changed' })), reason: 'nothing changed against the base' };
  }
  const trigger = changed.find((f) => RUN_EVERYTHING_WHEN_TOUCHED.includes(f));
  if (trigger) return all(`${trigger} can change what any harness proves`);
  if (dependencyChange) return all(`${dependencyChange} can change what any suite does`);

  // A scripts-only manifest edit has been ruled out above, so the manifests
  // take no further part.
  const files = changed.filter((f) => !DEPENDENCY_MANIFESTS.includes(f));
  const guardedByAny = new Set(harnesses.flatMap((h) => h.guarded));
  const run = [];
  const skipped = [];
  const why = {};
  for (const h of harnesses) {
    if (h.error) {
      run.push(h.tool);
      why[h.tool] = `its rows could not be read (${h.error})`;
      continue;
    }
    const direct = files.find((f) => h.guarded.includes(f));
    if (direct) {
      run.push(h.tool);
      why[h.tool] = direct === h.file ? 'its own file changed' : `it guards ${direct}`;
      continue;
    }
    let read = null;
    for (const f of files) {
      if (guardedByAny.has(f)) continue;
      const reader = readerOf(f, h.guarded);
      if (reader) { read = `${reader} reads ${f}`; break; }
    }
    if (read) {
      run.push(h.tool);
      why[h.tool] = read;
    } else {
      skipped.push({ tool: h.tool, reason: 'nothing it guards, or that its guarded files read, changed' });
    }
  }
  return { run, skipped, why, reason: 'scoped to the files this change touches' };
}

// ---------------------------------------------------------------------------
// The base, and what changed against it
// ---------------------------------------------------------------------------

function gitAt(root) {
  return (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function commitOf(git, rev) {
  try { return git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]) || null; } catch { return null; }
}

function isAncestor(git, a, b) {
  try { git(['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; }
}

/**
 * The commit to compare against.
 *
 * An explicit `--base` wins: CI knows the merge base exactly (the first parent
 * of a pull request's merge commit, or the commit a push to main moved from)
 * and passes it. Otherwise the merge base of HEAD with origin/main, or with a
 * local main that is newer, because a branch that has just merged main locally
 * should be compared against what it merged.
 *
 * Returns { base, described } with base null when nothing resolves.
 */
function resolveBase({ root = ROOT, base = null, head = 'HEAD', git = gitAt(root) } = {}) {
  if (base) {
    const sha = commitOf(git, base);
    return sha
      ? { base: sha, described: `against ${base} (${sha.slice(0, 12)})` }
      : { base: null, described: `the base ${base} could not be resolved` };
  }
  const bases = [];
  for (const trunk of ['origin/main', 'main']) {
    if (!commitOf(git, trunk)) continue;
    try {
      const mb = git(['merge-base', head, trunk]);
      if (mb) bases.push({ trunk, mb });
    } catch { /* no common history */ }
  }
  if (!bases.length) return { base: null, described: 'no merge base with origin/main or main could be found' };
  let best = bases[0];
  for (const b of bases.slice(1)) if (b.mb !== best.mb && isAncestor(git, best.mb, b.mb)) best = b;
  return { base: best.mb, described: `against the merge base with ${best.trunk} (${best.mb.slice(0, 12)})` };
}

/**
 * The files changed since `base`. With `head` given, exactly base..head;
 * otherwise base..HEAD plus whatever is staged, unstaged or untracked here,
 * because a local run is asked about the tree as it stands.
 */
function changedFiles({ root = ROOT, base, head = null, git = gitAt(root) }) {
  if (!base) return null;
  const lines = (out) => out.split('\n').map((s) => s.trim()).filter(Boolean);
  try {
    if (head) return [...new Set(lines(git(['diff', '--name-only', base, head])))];
    const seen = [
      ...lines(git(['diff', '--name-only', base, 'HEAD'])),
      ...lines(git(['diff', '--name-only', '--cached'])),
      ...lines(git(['diff', '--name-only'])),
      ...lines(git(['ls-files', '--others', '--exclude-standard'])),
    ];
    return [...new Set(seen)];
  } catch {
    return null;
  }
}

function dependencyView(manifest, text) {
  const json = JSON.parse(text);
  if (manifest === 'package.json') {
    return JSON.stringify(DEPENDENCY_KEYS.map((k) => [k, json[k] || {}]));
  }
  // The lockfile: everything but the project's own name and version, which a
  // release bump changes and no dependency does.
  delete json.name;
  delete json.version;
  if (json.packages && json.packages['']) {
    const rootEntry = { ...json.packages[''] };
    delete rootEntry.name;
    delete rootEntry.version;
    json.packages = { ...json.packages, '': rootEntry };
  }
  return JSON.stringify(json);
}

/**
 * The manifest whose dependencies moved between base and head, or null.
 * A manifest that cannot be read or parsed on either side counts as moved:
 * that is the direction that runs everything.
 */
function dependencyChangeIn(changed, { root = ROOT, base, head = null, git = gitAt(root) }) {
  for (const manifest of DEPENDENCY_MANIFESTS) {
    if (!changed || !changed.includes(manifest)) continue;
    try {
      const before = git(['show', `${base}:${manifest}`]);
      const after = head ? git(['show', `${head}:${manifest}`]) : fs.readFileSync(path.join(root, manifest), 'utf8');
      if (dependencyView(manifest, before) !== dependencyView(manifest, after)) return manifest;
    } catch {
      return manifest;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shards
// ---------------------------------------------------------------------------

/**
 * Pack the selected harnesses into shards.
 *
 * The unit of work is a harness, or a slice of rows within a harness too big
 * for one shard. The shard count is the row total over the budget, capped;
 * units are placed largest first onto the least-loaded shard. Deterministic,
 * so a shard can be recomputed anywhere from the same selection.
 */
function planShards(harnesses, { budget = ROWS_PER_SHARD, maxShards = MAX_SHARDS } = {}) {
  const items = harnesses.map((h) => ({ tool: h.tool, rows: h.rows }));
  const total = items.reduce((n, h) => n + (h.rows || 0), 0);
  if (!items.length) return { shards: [], total: 0 };
  const count = Math.max(1, Math.min(maxShards, Math.ceil(total / budget)));
  const cap = Math.max(budget, Math.ceil(total / count));
  const units = [];
  for (const h of items) {
    if (!h.rows || h.rows <= cap) { units.push({ tool: h.tool, rows: h.rows || 0 }); continue; }
    const pieces = Math.ceil(h.rows / cap);
    const size = Math.ceil(h.rows / pieces);
    for (let start = 0; start < h.rows; start += size) {
      const end = Math.min(h.rows, start + size);
      units.push({ tool: h.tool, start, end, rows: end - start });
    }
  }
  units.sort((a, b) => b.rows - a.rows || a.tool.localeCompare(b.tool) || (a.start || 0) - (b.start || 0));
  const shards = Array.from({ length: count }, (_, i) => ({ index: i + 1, rows: 0, units: [] }));
  for (const u of units) {
    const target = shards.reduce((lo, s) => (s.rows < lo.rows ? s : lo), shards[0]);
    target.units.push(u);
    target.rows += u.rows;
  }
  const used = shards.filter((s) => s.units.length).map((s, i) => ({ ...s, index: i + 1 }));
  return { shards: used, total };
}

function planId(shards) {
  return crypto.createHash('sha256').update(JSON.stringify(shards)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** One harness invocation's outcome from how it ended. */
function outcomeOf(code, signal) {
  if (signal) return { outcome: NO_VERDICT, cause: `ended by signal ${signal}` };
  if (code === 0) return { outcome: PASS };
  if (code === HARNESS_NO_VERDICT) return { outcome: NO_VERDICT, cause: 'the harness reached no verdict (an unreadable suite, or a temp root it refused)' };
  return { outcome: FAIL, cause: `exit ${code}` };
}

/** Any fail is fail; otherwise any no verdict is no verdict; otherwise pass. */
function combine(outcomes) {
  if (outcomes.some((o) => o === FAIL)) return FAIL;
  if (outcomes.some((o) => o === NO_VERDICT)) return NO_VERDICT;
  return PASS;
}

function unitLabel(u) {
  return u.start === undefined ? u.tool : `${u.tool} rows ${u.start}:${u.end}`;
}

function runUnits(units, { root = ROOT, spawn = spawnSync } = {}) {
  const results = [];
  for (const u of units) {
    const args = [path.join('test', 'tools', u.tool), '--markdown'];
    if (u.start !== undefined) args.push('--rows', `${u.start}:${u.end}`);
    console.log(`\n[mutation-scope] ${unitLabel(u)}`);
    const r = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
    const o = outcomeOf(r.status, r.signal);
    if (o.outcome !== PASS) console.error(`[mutation-scope] ${unitLabel(u)}: ${o.outcome}${o.cause ? ` (${o.cause})` : ''}`);
    results.push({ unit: unitLabel(u), ...o });
  }
  return { outcome: combine(results.map((r) => r.outcome)), results };
}

/**
 * One outcome from a plan and the verdicts its shards wrote.
 *
 * A shard with no verdict file died, was cancelled or timed out before it
 * could write one, and that is no verdict for that shard: never a pass.
 */
function aggregate(plan, verdicts, { planResult = 'success' } = {}) {
  if (planResult !== 'success') {
    return planResult === 'failure'
      ? { outcome: FAIL, causes: ['the plan job failed (the fixture check, or the selection itself)'] }
      : { outcome: NO_VERDICT, causes: [`the plan job was ${planResult || 'not run'}`] };
  }
  if (!plan || !Array.isArray(plan.shards)) return { outcome: NO_VERDICT, causes: ['no plan was found'] };
  const causes = [];
  const outcomes = [];
  for (const shard of plan.shards) {
    const v = verdicts.find((x) => x && x.shard === shard.index);
    if (!v) {
      outcomes.push(NO_VERDICT);
      causes.push(`shard ${shard.index} wrote no verdict (it died, was cancelled or timed out)`);
      continue;
    }
    if (v.plan !== plan.id) {
      outcomes.push(NO_VERDICT);
      causes.push(`shard ${shard.index} ran a different plan`);
      continue;
    }
    outcomes.push(v.outcome);
    for (const r of v.results || []) {
      if (r.outcome !== PASS) causes.push(`shard ${shard.index}: ${r.unit} ${r.outcome}${r.cause ? ` (${r.cause})` : ''}`);
    }
  }
  return { outcome: combine(outcomes), causes };
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

function argValue(argv, flag) {
  const at = argv.indexOf(flag);
  return at === -1 ? null : (argv[at + 1] || '');
}

function decide(argv, { root = ROOT, toolsDir = TOOLS } = {}) {
  const harnesses = loadHarnesses({ toolsDir, root });
  if (argv.includes('--all')) {
    return { harnesses, selection: { run: harnesses.map((h) => h.tool), skipped: [], reason: '--all was given' }, base: null };
  }
  const head = argValue(argv, '--head');
  const git = gitAt(root);
  const resolved = resolveBase({ root, base: argValue(argv, '--base'), head: head || 'HEAD', git });
  const changed = changedFiles({ root, base: resolved.base, head, git });
  const dependencyChange = changed ? dependencyChangeIn(changed, { root, base: resolved.base, head, git }) : null;
  const selection = selectHarnesses(changed, harnesses, { dependencyChange, readerOf: makeReaderIndex(root) });
  selection.reason = `${selection.reason} (${resolved.described}${changed ? `, ${changed.length} changed file(s)` : ''})`;
  return { harnesses, selection, base: resolved.base, changed };
}

function buildPlan(decision) {
  const chosen = decision.harnesses.filter((h) => decision.selection.run.includes(h.tool));
  const { shards, total } = planShards(chosen);
  return {
    id: planId(shards),
    base: decision.base,
    reason: decision.selection.reason,
    run: decision.selection.run,
    skipped: decision.selection.skipped,
    why: decision.selection.why || {},
    rows: total,
    shards,
  };
}

function explain(plan, harnessCount) {
  const lines = [`[mutation-scope] ${plan.run.length} of ${harnessCount} harnesses, ${plan.rows} rows, ${plan.shards.length} shard(s): ${plan.reason}`];
  for (const tool of plan.run) lines.push(`[mutation-scope] run ${tool}${plan.why[tool] ? `: ${plan.why[tool]}` : ''}`);
  for (const s of plan.skipped) lines.push(`[mutation-scope] skipped ${s.tool}: ${s.reason}`);
  for (const s of plan.shards) lines.push(`[mutation-scope] shard ${s.index}: ${s.rows} rows: ${s.units.map(unitLabel).join(', ')}`);
  return lines.join('\n');
}

function summaryMarkdown(plan) {
  const out = ['## Mutation plan', '', `${plan.run.length} harness(es), ${plan.rows} rows, ${plan.shards.length} shard(s).`, '', `Reason: ${plan.reason}`, ''];
  if (plan.run.length) {
    out.push('| Harness | Why |', '|---|---|');
    for (const tool of plan.run) out.push(`| ${tool} | ${plan.why[tool] || plan.reason} |`);
    out.push('');
  }
  for (const s of plan.shards) out.push(`- Shard ${s.index}: ${s.rows} rows: ${s.units.map(unitLabel).join(', ')}`);
  return `${out.join('\n')}\n`;
}

// GitHub's workflow-command escaping, so a title keeps its colon ("No verdict:
// ...") rather than having it read as the end of the property.
function escapeData(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function escapeProperty(text) {
  return escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function appendTo(file, text) {
  if (file) fs.appendFileSync(file, text);
}

function writeVerdict(file, verdict) {
  if (file) fs.writeFileSync(file, `${JSON.stringify(verdict, null, 2)}\n`);
}

function readPlan(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--aggregate')) {
    const planFile = argValue(argv, '--plan-file');
    const dir = argValue(argv, '--verdicts');
    let plan = null;
    try { plan = planFile ? readPlan(planFile) : null; } catch { plan = null; }
    const verdicts = [];
    try {
      for (const n of fs.readdirSync(dir)) {
        if (!/^verdict-\d+\.json$/.test(n)) continue;
        try { verdicts.push(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))); } catch { /* unreadable is missing */ }
      }
    } catch { /* no directory is no verdicts */ }
    const result = aggregate(plan, verdicts, { planResult: argValue(argv, '--plan-result') || 'success' });
    const title = result.outcome === PASS ? 'Mutation guards passed'
      : result.outcome === FAIL ? 'Mutation guards failed'
        : `No verdict: ${result.causes[0] || 'unknown'}`;
    console.log(`[mutation-scope] ${title}`);
    for (const c of result.causes) console.log(`[mutation-scope]   ${c}`);
    if (process.env.GITHUB_ACTIONS && result.outcome !== PASS) {
      console.log(`::error title=${escapeProperty(title)}::${escapeData(result.causes.join('; '))}`);
    }
    appendTo(process.env.GITHUB_STEP_SUMMARY, `## ${title}\n\n${result.causes.map((c) => `- ${c}`).join('\n')}\n`);
    return EXIT[result.outcome];
  }

  // A shard handed the plan file runs exactly what the plan job decided, with
  // no second decision that could disagree with the first.
  let plan;
  if (argv.includes('--shard') && argv.includes('--plan-file')) {
    try {
      plan = readPlan(argValue(argv, '--plan-file'));
    } catch (e) {
      console.error(`[mutation-scope] no verdict: the plan could not be read (${e.message})`);
      return EXIT[NO_VERDICT];
    }
  } else {
    plan = buildPlan(decide(argv));
  }
  console.log(explain(plan, plan.run.length + plan.skipped.length));

  if (argv.includes('--plan')) {
    const out = argValue(argv, '--out') || path.join(ROOT, '.mutation-plan.json');
    fs.writeFileSync(out, `${JSON.stringify(plan, null, 2)}\n`);
    appendTo(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(plan));
    appendTo(process.env.GITHUB_OUTPUT,
      `count=${plan.shards.length}\nmatrix=${JSON.stringify({ shard: plan.shards.map((s) => s.index) })}\n`);
    return 0;
  }
  if (argv.includes('--explain')) return 0;

  let units = plan.shards.flatMap((s) => s.units);
  let shardIndex = null;
  const shardArg = argValue(argv, '--shard');
  if (shardArg !== null) {
    const m = /^(\d+)\/(\d+)$/.exec(shardArg);
    const verdictFile = argValue(argv, '--verdict');
    if (!m || Number(m[2]) !== plan.shards.length || Number(m[1]) < 1 || Number(m[1]) > plan.shards.length) {
      const cause = `--shard ${shardArg} does not match a plan of ${plan.shards.length} shard(s)`;
      console.error(`[mutation-scope] no verdict: ${cause}`);
      writeVerdict(verdictFile, { plan: plan.id, shard: m ? Number(m[1]) : null, outcome: NO_VERDICT, results: [{ unit: 'plan', outcome: NO_VERDICT, cause }] });
      return EXIT[NO_VERDICT];
    }
    shardIndex = Number(m[1]);
    units = plan.shards[shardIndex - 1].units;
  }
  const ran = runUnits(units);
  writeVerdict(argValue(argv, '--verdict'), { plan: plan.id, shard: shardIndex, ...ran });
  console.log(`\n[mutation-scope] ${ran.outcome}: ${units.length} unit(s)${shardIndex ? ` in shard ${shardIndex}` : ''}`);
  return EXIT[ran.outcome];
}

module.exports = {
  harnessFiles, loadHarnesses, pathReferences, makeReaderIndex, selectHarnesses,
  resolveBase, changedFiles, dependencyChangeIn, planShards, outcomeOf, combine, aggregate,
  decide, buildPlan, main, escapeProperty, RUN_EVERYTHING_WHEN_TOUCHED, ROWS_PER_SHARD, MAX_SHARDS,
  PASS, FAIL, NO_VERDICT, EXIT,
};

if (require.main === module) process.exit(main());
