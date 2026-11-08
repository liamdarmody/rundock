'use strict';
// Which mutation harnesses a change can reach, how they are split across CI
// shards, and how their results become one of three outcomes.
//
// EVERY SELECTION TEST HERE IS ABOUT THE FAIL-SAFE DIRECTION, because that is
// the only failure this tool can introduce. Running a harness that was not
// needed costs minutes. NOT running one that was needed produces a green check
// that never looked.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const {
  harnessFiles, loadHarnesses, pathReferences, makeReaderIndex, selectHarnesses, resolveBase,
  changedFiles, dependencyChangeIn, planShards, outcomeOf, combine, aggregate, decide, buildPlan,
  RUN_EVERYTHING_WHEN_TOUCHED, SECONDS_PER_SHARD, MAX_SHARDS, readCosts, PASS, FAIL, NO_VERDICT,
  unstagedTargets, aggregateCommand,
} = require('../../scripts/mutation-scope.js');

const REPO = path.join(__dirname, '..', '..');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function tempDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function write(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

// A harness as the real ones are shaped: rows of [target, label, guard, without],
// exported, and run only under require.main.
function harnessSource(targets, { exitCode = 0, signal = null } = {}) {
  const defs = targets.map(([name, src, suite]) =>
    `const ${name} = { src: path.join(__dirname, '..', '..', ${JSON.stringify(src)}), suite: ${JSON.stringify(suite)} };`).join('\n');
  const rows = targets.map(([name]) => `[${name}, 'breaks ${name}', 'x', 'y']`).join(',\n  ');
  const end = signal ? `process.kill(process.pid, ${JSON.stringify(signal)});` : `process.exit(${exitCode});`;
  return `'use strict';
const path = require('node:path');
${defs}
const MUTATIONS = [
  ${rows},
];
if (require.main === module) { ${end} }
module.exports = { MUTATIONS };
`;
}

// A throwaway repository holding two harnesses: A guards lib/a.js through a
// suite that reads a capture by path, B guards lib/b.js through a suite that
// reads nothing.
function fixtureRoot() {
  const root = tempDir('mutation-scope-');
  write(root, 'lib/a.js', 'a\n');
  write(root, 'lib/b.js', 'b\n');
  write(root, 'test/fixtures/capture.json', '{}\n');
  write(root, 'test/helpers/shared.js', 'module.exports = 1;\n');
  write(root, 'test/unit/a.test.js',
    "const path = require('node:path');\nconst capture = path.join(__dirname, '..', 'fixtures', 'capture.json');\nrequire('../helpers/shared.js');\n");
  write(root, 'test/unit/b.test.js', "require('node:assert');\n");
  write(root, 'test/tools/mutate-a-guards.js', harnessSource([['A', 'lib/a.js', 'test/unit/a.test.js']]));
  write(root, 'test/tools/mutate-b-guards.js', harnessSource([['B', 'lib/b.js', 'test/unit/b.test.js']]));
  write(root, 'package.json', `${JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { t: 'x' }, dependencies: { ws: '1.0.0' } }, null, 2)}\n`);
  write(root, 'CHANGELOG.md', '# log\n');
  return root;
}

function fixtureRepo() {
  const root = fixtureRoot();
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.email', 'scope-test@example.com');
  git('config', 'user.name', 'Scope Test');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return { root, git, commit: (msg) => { git('add', '-A'); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD'); } };
}

const tools = (root) => path.join(root, 'test', 'tools');
const explain = (root, argv) => decide(argv, { root, toolsDir: tools(root) });
// How GitHub records a plan job and shard jobs that both ended well. The
// aggregate defaults neither to success, so a test that means it says so.
const SUCCEEDED = { planResult: 'success', shardsResult: 'success' };

describe('what a harness guards comes from its rows', () => {
  test('every real harness loads, and names the files it mutates and the suites it reads', () => {
    const hs = loadHarnesses({ toolsDir: path.join(REPO, 'test', 'tools'), root: REPO });
    assert.ok(hs.length >= 14, `expected the real harnesses, found ${hs.length}`);
    for (const h of hs) {
      assert.strictEqual(h.error, undefined, `${h.tool} could not be read: ${h.error}`);
      assert.ok(h.rows > 0 && h.sources.length && h.suites.length, `${h.tool} names nothing`);
      for (const f of [...h.sources, ...h.suites]) {
        assert.doesNotMatch(f, /^\/|^\.\./, `${h.tool}: ${f} should be repository-relative`);
        assert.ok(fs.existsSync(path.join(REPO, f)), `${h.tool}: ${f} does not exist`);
      }
      assert.ok(h.guarded.includes(`test/tools/${h.tool}`), `${h.tool} guards its own file`);
    }
  });

  test('adding a harness touches only the harness: a planted one is in every full plan', () => {
    const root = fixtureRoot();
    write(root, 'lib/planted.js', 'p\n');
    write(root, 'test/unit/planted.test.js', '\n');
    write(root, 'test/tools/mutate-planted-guards.js', harnessSource([['P', 'lib/planted.js', 'test/unit/planted.test.js']]));
    assert.ok(harnessFiles(tools(root)).includes('mutate-planted-guards.js'));
    const plan = buildPlan(explain(root, ['--all']));
    assert.ok(plan.run.includes('mutate-planted-guards.js'), 'the planted harness is in --all --plan');
    assert.ok(plan.shards.some((s) => s.units.some((u) => u.tool === 'mutate-planted-guards.js')), 'and in a shard');
  });

  test('a harness whose rows cannot be read runs, never skips', () => {
    const root = fixtureRoot();
    write(root, 'test/tools/mutate-broken-guards.js', "module.exports = { MUTATIONS: 'not rows' };\n");
    const hs = loadHarnesses({ toolsDir: tools(root), root });
    const broken = hs.find((h) => h.tool === 'mutate-broken-guards.js');
    assert.ok(broken.error, 'the unreadable harness is marked');
    const plan = selectHarnesses(['CHANGELOG.md'], hs);
    assert.ok(plan.run.includes('mutate-broken-guards.js'));
  });
});

describe('selection', () => {
  const root = fixtureRoot();
  const hs = loadHarnesses({ toolsDir: tools(root), root });
  const readerOf = makeReaderIndex(root);
  const pick = (changed, opts = {}) => selectHarnesses(changed, hs, { readerOf, ...opts });

  test('a guarded source selects its harness and no other, with the reason', () => {
    const plan = pick(['lib/a.js']);
    assert.deepStrictEqual(plan.run, ['mutate-a-guards.js']);
    assert.match(plan.why['mutate-a-guards.js'], /guards lib\/a\.js/);
    assert.ok(plan.skipped.some((s) => s.tool === 'mutate-b-guards.js'));
  });

  test('a harness\'s own file selects that harness only', () => {
    assert.deepStrictEqual(pick(['test/tools/mutate-b-guards.js']).run, ['mutate-b-guards.js']);
  });

  test('a data file selects only the harnesses whose guarded files read it', () => {
    // The capture is read by a's suite through path.join, so a runs and b,
    // which reads nothing, is skipped.
    const plan = pick(['test/fixtures/capture.json']);
    assert.deepStrictEqual(plan.run, ['mutate-a-guards.js']);
    assert.match(plan.why['mutate-a-guards.js'], /test\/unit\/a\.test\.js reads test\/fixtures\/capture\.json/);
  });

  test('a shared helper reaches its readers, through a require specifier', () => {
    assert.deepStrictEqual(pick(['test/helpers/shared.js']).run, ['mutate-a-guards.js']);
  });

  test('a documentation-only change runs nothing', () => {
    const plan = pick(['CHANGELOG.md']);
    assert.deepStrictEqual(plan.run, []);
    assert.strictEqual(plan.skipped.length, hs.length, 'every harness is accounted for as a skip');
  });

  test('the machinery runs everything, one case per trigger', () => {
    assert.deepStrictEqual(RUN_EVERYTHING_WHEN_TOUCHED.slice().sort(),
      ['.github/workflows/ci.yml', 'scripts/mutation-scope.js', 'test/tools/mutation-run.js']);
    for (const trigger of RUN_EVERYTHING_WHEN_TOUCHED) {
      const plan = pick([trigger]);
      assert.deepStrictEqual(plan.run.slice().sort(), hs.map((h) => h.tool).sort(), `${trigger} runs everything`);
      assert.match(plan.reason, /can change what any harness proves/);
    }
  });

  test('a dependency change runs everything; a scripts-only manifest edit runs nothing', () => {
    assert.strictEqual(pick(['package.json'], { dependencyChange: 'package.json' }).run.length, hs.length);
    assert.deepStrictEqual(pick(['package.json']).run, []);
  });

  test('an unresolved base runs everything; an empty diff from a resolved base runs nothing', () => {
    const none = pick(null);
    assert.strictEqual(none.run.length, hs.length);
    assert.match(none.reason, /no comparison base could be resolved/);
    const empty = pick([]);
    assert.deepStrictEqual(empty.run, []);
    assert.match(empty.reason, /nothing changed/);
  });

  test('path references are read statically, in each form a suite names a file', () => {
    const refs = pathReferences(
      "require('../helpers/shared.js'); const c = path.join(__dirname, '..', 'fixtures', 'capture.json'); const d = 'lib/b.js';",
      'test/unit/x.test.js', root);
    assert.ok(refs.has('test/helpers/shared.js'), 'a require specifier');
    assert.ok(refs.has('test/fixtures/capture.json'), 'a path.join of literals');
    assert.ok(refs.has('lib/b.js'), 'a repository-relative literal');
  });
});

describe('the base is the merge base, and a merge of main re-tests only the branch', () => {
  test('branch edits A, main edits guarded B, branch merges main: only A\'s harness runs', () => {
    // The defect this pins: measured against the branch's pre-merge tree, the
    // diff holds everything main brought in, and a merge of main re-tested
    // main. Against the merge base it holds only the branch's own work.
    const { root, git, commit } = fixtureRepo();
    git('checkout', '-q', '-b', 'feature');
    write(root, 'lib/a.js', 'a on the branch\n');
    commit('branch edits a');
    git('checkout', '-q', 'main');
    write(root, 'lib/b.js', 'b on main\n');
    write(root, 'package.json', `${JSON.stringify({ name: 'fixture', version: '1.0.1', scripts: { t: 'y' }, dependencies: { ws: '1.0.0' } }, null, 2)}\n`);
    commit('main edits b');
    git('checkout', '-q', 'feature');
    git('merge', '-q', '--no-edit', 'main');
    const d = explain(root, []);
    assert.deepStrictEqual(d.selection.run, ['mutate-a-guards.js']);
    assert.match(d.selection.reason, /merge base with main/);
    assert.ok(!d.changed.includes('lib/b.js'), 'main\'s change is not the branch\'s');
  });

  test('a push to main is measured from the commit it moved from, given as --base', () => {
    const { root, git, commit } = fixtureRepo();
    const before = git('rev-parse', 'HEAD');
    write(root, 'lib/b.js', 'b pushed\n');
    const pushed = commit('push b');
    const d = explain(root, ['--base', before, '--head', pushed]);
    assert.deepStrictEqual(d.selection.run, ['mutate-b-guards.js']);
    // Without the base, a commit on main is its own merge base: nothing changed.
    const bare = explain(root, []);
    assert.deepStrictEqual(bare.selection.run, []);
    assert.match(bare.selection.reason, /nothing changed/);
  });

  test('a base that does not resolve runs everything, and says so', () => {
    const { root } = fixtureRepo();
    const d = explain(root, ['--base', 'no-such-ref']);
    assert.strictEqual(d.selection.run.length, 2);
    assert.match(d.selection.reason, /no-such-ref could not be resolved/);
  });

  test('the newer of origin/main and a local main is the base', () => {
    const { root, git, commit } = fixtureRepo();
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    write(root, 'lib/b.js', 'local main moved\n');
    commit('local main moves');
    git('checkout', '-q', '-b', 'feature');
    git('merge', '-q', 'main');
    write(root, 'lib/a.js', 'feature\n');
    commit('feature');
    const r = resolveBase({ root });
    assert.strictEqual(r.base, git('rev-parse', 'main'));
    assert.match(r.described, /merge base with main/);
  });

  test('a dependency entry that moved runs everything; a version bump in the lockfile does not', () => {
    const { root, git, commit } = fixtureRepo();
    write(root, 'package-lock.json', `${JSON.stringify({ name: 'fixture', version: '1.0.0', packages: { '': { name: 'fixture', version: '1.0.0' }, 'node_modules/ws': { version: '1.0.0' } } }, null, 2)}\n`);
    const base = commit('lockfile');
    write(root, 'package-lock.json', `${JSON.stringify({ name: 'fixture', version: '1.0.1', packages: { '': { name: 'fixture', version: '1.0.1' }, 'node_modules/ws': { version: '1.0.0' } } }, null, 2)}\n`);
    write(root, 'package.json', `${JSON.stringify({ name: 'fixture', version: '1.0.1', scripts: { t: 'z' }, dependencies: { ws: '1.0.0' } }, null, 2)}\n`);
    const bump = commit('bump');
    const changed = changedFiles({ root, base, head: bump });
    assert.strictEqual(dependencyChangeIn(changed, { root, base, head: bump }), null);
    assert.deepStrictEqual(explain(root, ['--base', base, '--head', bump]).selection.run, []);
    write(root, 'package.json', `${JSON.stringify({ name: 'fixture', version: '1.0.1', scripts: { t: 'z' }, dependencies: { ws: '2.0.0' } }, null, 2)}\n`);
    const dep = commit('dep');
    assert.strictEqual(dependencyChangeIn(changedFiles({ root, base, head: dep }), { root, base, head: dep }), 'package.json');
    assert.strictEqual(explain(root, ['--base', base, '--head', dep]).selection.run.length, 2);
  });
});

describe('shards are planned by time, not rows', () => {
  const h = (tool, rows) => ({ tool, rows });
  const costs = { perRow: { slow: 10, fast: 0.5 }, fallback: 5 };

  test('a single scoped harness within the target is one shard', () => {
    const { shards } = planShards([h('fast', 58)], { costs });
    assert.strictEqual(shards.length, 1);
    assert.deepStrictEqual(shards[0].units, [{ tool: 'fast', rows: 58, seconds: 29 }]);
  });

  test('a slow harness is split by its time, and equal rows are not equal shards', () => {
    // 120 slow rows are twenty minutes; 120 fast rows are one. By rows they
    // would share evenly and the slow half would sit at its job's limit.
    const { shards, seconds } = planShards([h('slow', 120), h('fast', 120)], { costs });
    assert.strictEqual(seconds, 1260);
    assert.strictEqual(shards.length, Math.ceil(1260 / SECONDS_PER_SHARD));
    assert.ok(shards.filter((s) => s.units.some((u) => u.tool === 'slow')).length >= 2, 'the slow harness is split');
    for (const s of shards) assert.ok(s.seconds <= SECONDS_PER_SHARD * 1.1, `shard ${s.index} is planned at ${s.seconds}s`);
  });

  test('a harness whose rows differ in cost is split by time, not rows', () => {
    // Slow rows sit together. Cut by row count, the slice holding them ran
    // past its job's limit while the others finished in minutes; weighted by
    // what each row is estimated to take, the cut follows the time.
    const rowLabels = Array.from({ length: 200 }, (_, i) => `row ${i}`);
    const mixed = { tool: 'mixed', rows: rowLabels.length, rowLabels };
    const slow = Object.fromEntries(rowLabels.slice(0, 60).map((l) => [l, 20]));
    const weighted = { ...costs, perLabel: { mixed: slow } };
    const cost = (i) => (i < 60 ? 20 : 5);
    const { shards, seconds } = planShards([mixed], { costs: weighted });
    assert.strictEqual(seconds, 60 * 20 + 140 * 5, 'a row costs what is given for its label, else its harness rate');
    const units = shards.flatMap((s) => s.units).sort((a, b) => a.start - b.start);
    assert.ok(units.length >= 2, 'the harness is split');
    for (const u of units) {
      let real = 0;
      for (let i = u.start; i < u.end; i++) real += cost(i);
      assert.strictEqual(u.seconds, real, `rows ${u.start}:${u.end} are planned at what they cost`);
      assert.ok(real <= SECONDS_PER_SHARD * 1.1, `rows ${u.start}:${u.end} cost ${real}s, within a shard`);
    }
    assert.ok(units[0].rows < units[units.length - 1].rows, 'the slice of slow rows holds fewer rows');
    const covered = units.flatMap((u) => [...Array(u.end - u.start).keys()].map((i) => i + u.start));
    assert.deepStrictEqual(covered, [...Array(rowLabels.length).keys()], 'every row once, in order');
  });

  test('a slow row just past a slice\'s share starts the next slice rather than stretching this one', () => {
    // A slice used to end at the first row that took it past its share, so a
    // slow row whose start sat just short of the share was taken whole and the
    // slice ran on by nearly that row's cost. Ending each slice at whichever
    // boundary is nearer its share keeps it within a row's half of the share.
    const rowLabels = Array.from({ length: 100 }, (_, i) => `row ${i}`);
    const lumpy = { tool: 'lumpy', rows: rowLabels.length, rowLabels };
    const weighted = { ...costs, perLabel: { lumpy: { 'row 85': 400 } } };
    const { shards, seconds } = planShards([lumpy], { costs: weighted });
    assert.strictEqual(seconds, 99 * 5 + 400, 'sanity: one row of 400s among rows at the 5s rate');
    const units = shards.flatMap((s) => s.units).sort((a, b) => a.start - b.start);
    assert.deepStrictEqual(units.map((u) => [u.start, u.end, u.seconds]), [[0, 85, 425], [85, 100, 470]],
      'the slow row opens the second slice; taken into the first, that slice would be 825s');
    for (const u of units) assert.ok(u.seconds <= SECONDS_PER_SHARD, `rows ${u.start}:${u.end} are planned at ${u.seconds}s`);
  });

  // Slices of one lumpy harness, as [start, end, seconds], in row order.
  const lumpySlices = (perLabel) => {
    const rowLabels = Array.from({ length: 100 }, (_, i) => `row ${i}`);
    const lumpy = { tool: 'lumpy', rows: rowLabels.length, rowLabels };
    const { shards } = planShards([lumpy], { costs: { ...costs, perLabel: { lumpy: perLabel } } });
    return shards.flatMap((s) => s.units).sort((a, b) => a.start - b.start).map((u) => [u.start, u.end, u.seconds]);
  };

  test('a first row that crosses its slice\'s share is taken into that slice, never left an empty one', () => {
    // 1200s, then 99 rows at 5s: three slices of 565s. The first row starts at
    // nothing spent, so ending the slice before it would leave the slice empty.
    const slices = lumpySlices({ 'row 0': 1200 });
    assert.ok(slices.every(([start, end]) => end > start), `no slice is empty: ${JSON.stringify(slices)}`);
    assert.deepStrictEqual(slices[0].slice(0, 2), [0, 1], 'the first slice starts at row 0 and takes the slow row');
    assert.deepStrictEqual(slices.flatMap(([start, end]) => Array.from({ length: end - start }, (_, k) => start + k)),
      [...Array(100).keys()], 'every row once, in order');
  });

  test('a share exactly midway through a row keeps the row, and so does one nearer its end', () => {
    // 100s at row 60 and a last row that sets the share: rows 0 to 59 spend
    // 300s, so row 60 runs from 300s to 400s. A 110s last row puts the share
    // at 350s, exactly midway; a 150s one puts it at 370s, nearer the end.
    // Either way the slice takes the row, as it did before the nearer-side cut.
    assert.deepStrictEqual(lumpySlices({ 'row 60': 100, 'row 99': 110 }), [[0, 61, 400], [61, 100, 300]],
      'at a tie the row is taken; cut before it, the slices would be 300s and 400s');
    assert.deepStrictEqual(lumpySlices({ 'row 60': 100, 'row 99': 150 }), [[0, 61, 400], [61, 100, 340]],
      'nearer its end the row is taken; cut before it, the slices would be 300s and 440s');
  });

  test('an integration row with no cost of its own is planned at its harness\'s integration rate', () => {
    // Integration rows start a server and run several times slower than the
    // rest, so a new one planned at the harness's average was planned short.
    const rowLabels = ['known', 'new unit', 'new integration'];
    const rowSuites = ['test/unit/a.test.js', 'test/unit/b.test.js', 'test/integration/c.test.js'];
    const h = { tool: 'mixed', rows: 3, rowLabels, rowSuites };
    const priced = { ...costs, perLabel: { mixed: { known: 2 } }, perIntegration: { mixed: 30 } };
    assert.strictEqual(planShards([h], { costs: priced }).seconds, 2 + 5 + 30, 'its own cost, its harness rate, its integration rate');
    assert.strictEqual(planShards([h], { costs: { ...priced, perIntegration: {} } }).seconds, 2 + 5 + 5, 'with no integration rate, its harness rate');
    const c = readCosts(path.join(REPO, 'test', 'tools'));
    assert.ok(Object.keys(c.perIntegration).length >= 1, 'sanity: the table has integration rates');
    for (const [tool, r] of Object.entries(c.perIntegration)) {
      assert.ok(Number(r) > Number(c.perRow[tool]), `${tool}: integration rows are planned above the harness average`);
    }
  });

  test('a harness is read with the suite each row runs', () => {
    const hs = loadHarnesses({ toolsDir: path.join(REPO, 'test', 'tools'), root: REPO });
    for (const h of hs) {
      assert.ok(Array.isArray(h.rowSuites) && h.rowSuites.length === h.rows, `${h.tool}: one suite per row`);
      for (const s of h.rowSuites) assert.ok(h.suites.includes(s), `${h.tool}: ${s} is one of its suites`);
    }
  });

  test('a harness is read with the label of each row', () => {
    const hs = loadHarnesses({ toolsDir: path.join(REPO, 'test', 'tools'), root: REPO });
    for (const h of hs) {
      assert.ok(Array.isArray(h.rowLabels) && h.rowLabels.length === h.rows, `${h.tool}: one label per row`);
      assert.ok(h.rowLabels.every((l) => typeof l === 'string' && l.length > 0), `${h.tool}: every row has a label`);
    }
  });

  test('the inferred costs by label name rows that exist', () => {
    // A label renamed or removed falls back to its harness's rate, which is
    // safe, but a table that names nothing that exists measures nothing.
    const tools = path.join(REPO, 'test', 'tools');
    const { perLabel } = readCosts(tools);
    const hs = loadHarnesses({ toolsDir: tools, root: REPO });
    assert.ok(Object.keys(perLabel).length >= 1, 'sanity: the table has costs by label');
    for (const [tool, labels] of Object.entries(perLabel)) {
      const h = hs.find((x) => x.tool === tool);
      assert.ok(h, `${tool} has costs by label but is not on disk`);
      const known = new Set(h.rowLabels);
      const named = Object.keys(labels);
      assert.ok(named.filter((l) => known.has(l)).length >= named.length * 0.9, `${tool}: most labels with a cost are rows today`);
      for (const v of Object.values(labels)) assert.ok(Number(v) > 0, `${tool}: every cost is positive`);
    }
  });

  test('every row lands in exactly one shard', () => {
    const hs = [h('slow', 271), h('fast', 262), h('unmeasured', 217), h('a', 127), h('b', 95), h('c', 58)];
    const { shards } = planShards(hs, { costs });
    for (const t of hs) {
      const covered = [];
      for (const s of shards) for (const u of s.units) if (u.tool === t.tool) {
        for (let i = u.start || 0; i < (u.end === undefined ? t.rows : u.end); i++) covered.push(i);
      }
      assert.deepStrictEqual(covered.sort((x, y) => x - y), [...Array(t.rows).keys()], `${t.tool} rows covered once`);
    }
  });

  test('the shard count is capped, and the plan is the same every time', () => {
    const many = Array.from({ length: 30 }, (_, i) => h(`t${i}`, 150));
    const a = planShards(many, { costs });
    assert.strictEqual(a.shards.length, MAX_SHARDS);
    assert.deepStrictEqual(planShards(many, { costs }), a);
  });

  test('a plan the cap does not reach is the same whatever the cap', () => {
    // The cap only binds once a plan needs more shards than it allows, so
    // raising it changes the full nightly set and leaves a scoped plan alone.
    const scoped = [h('slow', 120), h('fast', 120)];
    const at = (maxShards) => planShards(scoped, { costs, maxShards });
    assert.ok(at(MAX_SHARDS).shards.length < MAX_SHARDS - 1, 'sanity: this plan is well under the cap');
    assert.deepStrictEqual(at(MAX_SHARDS - 1), at(MAX_SHARDS));
  });

  test('the committed cost table is well formed, and names only harnesses that exist', () => {
    // A harness missing from the table is planned at the default, so adding a
    // harness still touches only the harness; a stale entry is flagged here.
    const tools = path.join(REPO, 'test', 'tools');
    const c = readCosts(tools);
    assert.ok(c.fallback > 0);
    const names = Object.keys(c.perRow);
    assert.ok(names.length >= 14, `sanity: the table was read (${names.length} entries)`);
    for (const [tool, rate] of Object.entries(c.perRow)) {
      assert.ok(harnessFiles(tools).includes(tool), `${tool} is in the cost table but not on disk`);
      assert.ok(Number(rate) > 0, `${tool} has no positive cost`);
    }
  });

  test('the full set, planned with the real costs, keeps every shard well under its limit', () => {
    const tools = path.join(REPO, 'test', 'tools');
    const plan = buildPlan(decide(['--all'], { root: REPO, toolsDir: tools }), { toolsDir: tools });
    for (const s of plan.shards) assert.ok(s.seconds <= 15 * 60, `shard ${s.index} is planned at ${s.seconds}s`);
  });
});

describe('every harness, asked for and none found, is refused rather than planned as nothing to do', () => {
  test('--all with no harnesses found exits non-zero, says so, and writes no plan', () => {
    // Zero shards skips every shard job, and the aggregate reads a plan of no
    // shards as nothing to fail. The tool is copied into a fixture whose tools
    // folder holds the envelope and no harness, and run there.
    const root = tempDir('mutation-scope-no-harnesses-');
    for (const rel of ['scripts/mutation-scope.js', 'scripts/lib/run-record.js', 'test/tools/mutation-run.js']) {
      write(root, rel, fs.readFileSync(path.join(REPO, rel), 'utf8'));
    }
    assert.deepStrictEqual(harnessFiles(tools(root)), [], 'sanity: the tools folder holds no harness');
    const env = { ...process.env };
    for (const k of ['GITHUB_ACTIONS', 'GITHUB_STEP_SUMMARY', 'GITHUB_OUTPUT']) delete env[k];
    const out = path.join(root, 'mutation-plan.json');
    for (const argv of [['--all', '--plan', '--out', out], ['--all', '--explain']]) {
      const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'mutation-scope.js'), ...argv], { cwd: root, encoding: 'utf8', env });
      assert.notStrictEqual(r.status, 0, `${argv.join(' ')}: refused\n${r.stdout}${r.stderr}`);
      assert.ok(r.stderr.includes('found no harnesses'), `${argv.join(' ')}: and says why\n${r.stderr}`);
    }
    assert.ok(!fs.existsSync(out), 'no plan is written for the shards to read as nothing to do');
  });

  test('no harnesses found is refused without --all as well, as the scoped plan CI runs', () => {
    // CI's plan has no --all. A change that removed or renamed every harness
    // planned zero shards there, the shard job was skipped, and the aggregate
    // read a plan of nothing as a pass.
    const root = tempDir('mutation-scope-no-harnesses-scoped-');
    for (const rel of ['scripts/mutation-scope.js', 'scripts/lib/run-record.js', 'test/tools/mutation-run.js']) {
      write(root, rel, fs.readFileSync(path.join(REPO, rel), 'utf8'));
    }
    assert.deepStrictEqual(harnessFiles(tools(root)), [], 'sanity: the tools folder holds no harness');
    const env = { ...process.env };
    for (const k of ['GITHUB_ACTIONS', 'GITHUB_STEP_SUMMARY', 'GITHUB_OUTPUT']) delete env[k];
    const out = path.join(tempDir('mutation-scope-no-harnesses-out-'), 'mutation-plan.json');
    for (const argv of [['--plan', '--out', out, '--base', 'HEAD^1'], ['--plan', '--out', out], ['--explain']]) {
      const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'mutation-scope.js'), ...argv], { cwd: root, encoding: 'utf8', env });
      assert.strictEqual(r.status, 3, `${argv.join(' ')}: refused as no verdict\n${r.stdout}${r.stderr}`);
      assert.ok(r.stderr.includes('found no harnesses'), `${argv.join(' ')}: and says why\n${r.stderr}`);
    }
    assert.ok(!fs.existsSync(out), 'no plan is written for the shards to read as nothing to do');
  });

  test('harnesses found and none selected is still a plan of nothing to do, and green', () => {
    // The legitimate zero: a change that touches nothing any harness guards.
    const { root, commit } = fixtureRepo();
    for (const rel of ['scripts/mutation-scope.js', 'scripts/lib/run-record.js', 'test/tools/mutation-run.js']) {
      write(root, rel, fs.readFileSync(path.join(REPO, rel), 'utf8'));
    }
    commit('the tool');
    write(root, 'notes.md', 'guarded by nothing\n');
    commit('a change no harness guards');
    const outDir = tempDir('mutation-scope-none-selected-out-');
    const out = path.join(outDir, 'mutation-plan.json');
    const githubOutput = path.join(outDir, 'github-output');
    const env = { ...process.env, GITHUB_OUTPUT: githubOutput };
    for (const k of ['GITHUB_ACTIONS', 'GITHUB_STEP_SUMMARY']) delete env[k];
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'mutation-scope.js'), '--plan', '--out', out, '--base', 'HEAD^1'],
      { cwd: root, encoding: 'utf8', env });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(JSON.parse(fs.readFileSync(out, 'utf8')).shards.length, 0, 'a plan of no shards is written');
    assert.match(fs.readFileSync(githubOutput, 'utf8'), /^count=0$/m);
  });
});

describe('a run refuses to start over a file with unstaged changes', () => {
  // Each harness refuses on its own, but only when its turn comes, so a full
  // run spent its time on the others and ended "fail". The run as a whole now
  // refuses before the first harness, in one line.
  const recording = (targets) => harnessSource(targets).replace('process.exit(0);',
    "require('node:fs').writeFileSync(__filename + '.ran', ''); process.exit(0);");
  // THE TOOL IS COPIED INTO THE FIXTURE AND RUN THERE, so its root is the
  // fixture's by construction. Run from this checkout, a run that failed to
  // refuse would start every real harness against the real source tree.
  const runAll = (root) => spawnSync(process.execPath, [path.join(root, 'scripts', 'mutation-scope.js'), '--all'],
    { cwd: root, encoding: 'utf8' });
  const copyTool = (root) => {
    for (const rel of ['scripts/mutation-scope.js', 'scripts/lib/run-record.js', 'test/tools/mutation-run.js']) {
      write(root, rel, fs.readFileSync(path.join(REPO, rel), 'utf8'));
    }
  };

  test('an unstaged edit to a file a selected harness mutates refuses the whole run, in one line', () => {
    const repo = fixtureRepo();
    write(repo.root, 'test/tools/mutate-a-guards.js', recording([['A', 'lib/a.js', 'test/unit/a.test.js']]));
    write(repo.root, 'test/tools/mutate-b-guards.js', recording([['B', 'lib/b.js', 'test/unit/b.test.js']]));
    copyTool(repo.root);
    repo.commit('recording harnesses');
    fs.appendFileSync(path.join(repo.root, 'lib', 'a.js'), 'edited\n');

    const refused = runAll(repo.root);
    assert.strictEqual(refused.status, 3, `refused as no verdict:\n${refused.stdout}${refused.stderr}`);
    const lines = refused.stderr.trim().split('\n');
    assert.strictEqual(lines.length, 1, `one line:\n${refused.stderr}`);
    assert.match(lines[0], /lib\/a\.js/, 'naming the file');
    assert.match(lines[0], /commit or stage/, 'and saying what to do');
    assert.ok(!fs.existsSync(path.join(tools(repo.root), 'mutate-b-guards.js.ran')), 'no harness ran');

    repo.git('add', 'lib/a.js');
    const ran = runAll(repo.root);
    assert.strictEqual(ran.status, 0, `staged is enough:\n${ran.stdout}${ran.stderr}`);
    assert.ok(fs.existsSync(path.join(tools(repo.root), 'mutate-a-guards.js.ran')), 'and the harnesses ran');
  });

  test('a run records itself in the checkout while it runs, and the record is gone after', () => {
    // So the check made before a change is reported done can see a run still
    // going, between harnesses as well as inside one, with no process table.
    const repo = fixtureRepo();
    write(repo.root, 'test/tools/mutate-a-guards.js', harnessSource([['A', 'lib/a.js', 'test/unit/a.test.js']])
      .replace('process.exit(0);', "const fs = require('node:fs'); const dir = path.join(__dirname, '..', '..', '.tool-runs');"
        + " fs.writeFileSync(__filename + '.saw', JSON.stringify(fs.readdirSync(dir)"
        + ".map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))))); process.exit(0);"));
    copyTool(repo.root);
    repo.commit('a harness that looks for the record');
    const r = runAll(repo.root);
    assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    const saw = JSON.parse(fs.readFileSync(path.join(tools(repo.root), 'mutate-a-guards.js.saw'), 'utf8'));
    assert.strictEqual(saw.length, 1, 'one run was recorded while the harness ran');
    assert.strictEqual(saw[0].pid, r.pid, 'naming the process that runs it');
    assert.match(saw[0].what, /mutate:guards/, 'and what it is');
    assert.deepStrictEqual(fs.readdirSync(path.join(repo.root, '.tool-runs')), [], 'and it is removed when the run ends');
  });

  test('an interrupted run removes its record at once, and dies of the signal', async (t) => {
    // With the harnesses run synchronously, a signal handler in the run could
    // not fire until the harness in hand had finished, so the run either died
    // leaving its record or kept going after being told to stop.
    const repo = fixtureRepo();
    write(repo.root, 'test/tools/mutate-a-guards.js', harnessSource([['A', 'lib/a.js', 'test/unit/a.test.js']])
      .replace('process.exit(0);', "require('node:fs').writeFileSync(__filename + '.pid', String(process.pid));"
        + ' setTimeout(() => process.exit(0), 60000);'));
    copyTool(repo.root);
    repo.commit('a harness that hangs');
    const { spawn } = require('node:child_process');
    const run = spawn(process.execPath, [path.join(repo.root, 'scripts', 'mutation-scope.js'), '--all'],
      { cwd: repo.root, stdio: 'ignore' });
    const exited = new Promise((resolve) => run.on('exit', (code, signal) => resolve({ code, signal })));
    const pidFile = path.join(tools(repo.root), 'mutate-a-guards.js.pid');
    t.after(() => {
      try { run.kill('SIGKILL'); } catch { /* gone */ }
      try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* gone */ }
    });
    const records = () => { try { return fs.readdirSync(path.join(repo.root, '.tool-runs')); } catch { return []; } };
    const deadline = Date.now() + 20000;
    while (!(fs.existsSync(pidFile) && records().length) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.ok(fs.existsSync(pidFile) && records().length === 1, 'the run is recorded while its harness runs');
    run.kill('SIGINT');
    const how = await Promise.race([exited, new Promise((r) => setTimeout(() => r({ timedOut: true }), 10000))]);
    assert.strictEqual(how.signal, 'SIGINT', `the run stops when told to, not after its harness: ${JSON.stringify(how)}`);
    assert.deepStrictEqual(records(), [], 'and its record goes with it');
  });

  test('a file a run record holds is left to the harness, which knows what to do with it', () => {
    const repo = fixtureRepo();
    fs.appendFileSync(path.join(repo.root, 'lib', 'a.js'), 'mutant\n');
    const hs = loadHarnesses({ toolsDir: tools(repo.root), root: repo.root });
    const units = [{ tool: 'mutate-a-guards.js' }, { tool: 'mutate-b-guards.js' }];
    assert.deepStrictEqual(unstagedTargets(units, hs, { root: repo.root }), ['lib/a.js']);
    assert.deepStrictEqual(unstagedTargets([{ tool: 'mutate-b-guards.js' }], hs, { root: repo.root }), [],
      'a file no selected harness mutates is not this run\'s business');
    write(repo.root, '.mutation-runs/999999.json', JSON.stringify({ pid: 999999, files: ['lib/a.js'] }));
    assert.deepStrictEqual(unstagedTargets(units, hs, { root: repo.root }), [],
      'a dead run\'s leftover mutation is swept by the harness, never staged on this advice');
  });
});

describe('three outcomes: pass, fail, no verdict', () => {
  test('a harness\'s exit code and signal map to its outcome', () => {
    assert.strictEqual(outcomeOf(0, null).outcome, PASS);
    assert.strictEqual(outcomeOf(1, null).outcome, FAIL);
    assert.strictEqual(outcomeOf(3, null).outcome, NO_VERDICT);
    // Killed by a signal is no verdict, never a pass and never a failure.
    assert.strictEqual(outcomeOf(null, 'SIGTERM').outcome, NO_VERDICT);
    assert.match(outcomeOf(null, 'SIGKILL').cause, /signal SIGKILL/);
  });

  test('a harness\'s no verdict names a row whose suite did not finish among its causes, and never reads as a lost runner', () => {
    // Exit 3 now also means a row whose suite ran past the runner's limit, so
    // the cause a reader is shown has to say so. CI re-runs a no-verdict
    // annotation that mentions a signal, as a runner that was lost; a row that
    // ran out of time is a test to fix, and a re-run would only repeat it.
    const { outcome, cause } = outcomeOf(3, null);
    assert.strictEqual(outcome, NO_VERDICT);
    assert.match(cause, /a suite that did not finish in its limit/);
    assert.doesNotMatch(cause, /signal/i);
  });

  test('any fail is fail; otherwise any no verdict is no verdict', () => {
    assert.strictEqual(combine([PASS, NO_VERDICT, FAIL]), FAIL);
    assert.strictEqual(combine([PASS, NO_VERDICT]), NO_VERDICT);
    assert.strictEqual(combine([PASS, PASS]), PASS);
  });

  test('the aggregator reads a missing verdict file as no verdict for that shard', () => {
    const plan = { id: 'p1', shards: [{ index: 1 }, { index: 2 }] };
    const one = [{ plan: 'p1', shard: 1, outcome: PASS, results: [] }];
    const r = aggregate(plan, one, SUCCEEDED);
    assert.strictEqual(r.outcome, NO_VERDICT);
    assert.match(r.causes[0], /shard 2 wrote no verdict/);
    assert.strictEqual(aggregate(plan, [...one, { plan: 'p1', shard: 2, outcome: PASS }], SUCCEEDED).outcome, PASS);
    assert.strictEqual(aggregate(plan, [...one, { plan: 'other', shard: 2, outcome: PASS }], SUCCEEDED).outcome, NO_VERDICT);
    assert.strictEqual(aggregate(plan, [...one, { plan: 'p1', shard: 2, outcome: FAIL }], SUCCEEDED).outcome, FAIL);
  });

  test('a failed plan job is a failure; a cancelled one is no verdict', () => {
    assert.strictEqual(aggregate(null, [], { planResult: 'failure', shardsResult: 'skipped' }).outcome, FAIL);
    assert.strictEqual(aggregate(null, [], { planResult: 'cancelled', shardsResult: 'skipped' }).outcome, NO_VERDICT);
    assert.strictEqual(aggregate({ id: 'x', shards: [] }, [], { planResult: 'success', shardsResult: 'skipped' }).outcome, PASS,
      'an empty plan has nothing to fail');
  });

  test('a failed plan is titled as one, and names no step only one workflow has', () => {
    // Both workflows read this message. The nightly's plan job runs no fixture
    // check, so naming one there sent a reader looking for a step that is not
    // there; the plan job's own log names the step that failed.
    const r = aggregate(null, [], { planResult: 'failure', shardsResult: 'skipped' });
    assert.strictEqual(r.outcome, FAIL);
    assert.strictEqual(r.title, 'The plan failed: see its job');
    assert.ok(!r.causes.join(' ').includes('fixture'), r.causes.join('; '));
  });

  test('a harness exiting 3, or killed, is no verdict from the run and from the aggregator', () => {
    const root = fixtureRoot();
    write(root, 'test/tools/mutate-a-guards.js', harnessSource([['A', 'lib/a.js', 'test/unit/a.test.js']], { exitCode: 3 }));
    write(root, 'test/tools/mutate-b-guards.js', harnessSource([['B', 'lib/b.js', 'test/unit/b.test.js']], { signal: 'SIGTERM' }));
    const runOne = (tool) => spawnSync(process.execPath, [path.join('test', 'tools', tool), '--markdown'], { cwd: root });
    const a = runOne('mutate-a-guards.js');
    const b = runOne('mutate-b-guards.js');
    const outcomes = [outcomeOf(a.status, a.signal), outcomeOf(b.status, b.signal)];
    assert.deepStrictEqual(outcomes.map((o) => o.outcome), [NO_VERDICT, NO_VERDICT]);
    const plan = { id: 'p', shards: [{ index: 1 }, { index: 2 }] };
    const verdicts = outcomes.map((o, i) => ({ plan: 'p', shard: i + 1, outcome: combine([o.outcome]), results: [{ unit: 'u', ...o }] }));
    const r = aggregate(plan, verdicts, { planResult: 'success', shardsResult: 'failure' });
    assert.strictEqual(r.outcome, NO_VERDICT);
    assert.ok(r.causes.some((c) => /signal SIGTERM/.test(c)), 'the cause names the signal');
  });

  test('the command line exits 3 for no verdict and writes the verdict file', () => {
    const dir = tempDir('mutation-verdicts-');
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ id: 'p', shards: [{ index: 1 }, { index: 2 }] }));
    fs.writeFileSync(path.join(dir, 'verdict-1.json'), JSON.stringify({ plan: 'p', shard: 1, outcome: PASS, results: [] }));
    const env = { ...process.env };
    delete env.GITHUB_ACTIONS;
    delete env.GITHUB_STEP_SUMMARY;
    const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'mutation-scope.js'), '--aggregate',
      '--plan-file', path.join(dir, 'plan.json'), '--verdicts', dir, '--plan-result', 'success', '--shards-result', 'success'],
    { encoding: 'utf8', env });
    assert.strictEqual(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /No verdict: shard 2 wrote no verdict/);
    assert.doesNotMatch(r.stdout, /failed/i, 'no verdict is never titled a failure');
  });
});

// A verdict is a file the shard writes and uploads itself, and the upload runs
// whether or not the steps after the verdict passed. So a shard whose harness
// left a file modified failed its own job at the diff check and still uploaded
// a passing verdict. How GitHub recorded the shard jobs ending is set by the
// runner from how their steps ended, and nothing a shard uploads can rewrite
// it afterwards, so the aggregate reads it.
const SCOPE = path.join(REPO, 'scripts', 'mutation-scope.js');
const SHARD_FAILED = 'A shard failed: see its job';
const PLAN_2 = { id: 'p2', shards: [{ index: 1 }, { index: 2 }] };
const passed = (shard) => ({ plan: 'p2', shard, outcome: PASS, results: [{ unit: `mutate-${shard}-guards.js`, outcome: PASS }] });
const PASSING = [passed(1), passed(2)];

// A plan and its verdicts on disk, as the aggregate job downloads them.
function verdictDir(plan, verdicts) {
  const dir = tempDir('mutation-aggregate-');
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan));
  for (const v of verdicts) fs.writeFileSync(path.join(dir, `verdict-${v.shard}.json`), JSON.stringify(v));
  return dir;
}

// The aggregate step as CI runs it, from this checkout. It reads files and
// runs no harness.
function aggregateCli(dir, extra = [], env = {}) {
  const clean = { ...process.env };
  for (const k of ['GITHUB_ACTIONS', 'GITHUB_STEP_SUMMARY', 'GITHUB_OUTPUT', 'NODE_OPTIONS']) delete clean[k];
  return spawnSync(process.execPath, [SCOPE, '--aggregate', '--plan-file', path.join(dir, 'plan.json'), '--verdicts', dir, ...extra],
    { encoding: 'utf8', env: { ...clean, ...env } });
}

describe('the shard jobs\' result is a witness nothing a shard uploads can rewrite', () => {
  test('a shard job that did not succeed is not green, even when every verdict passes', () => {
    for (const shardsResult of ['failure', 'cancelled', 'skipped']) {
      const r = aggregate(PLAN_2, PASSING, { planResult: 'success', shardsResult });
      assert.notStrictEqual(r.outcome, PASS, `shards ${shardsResult}: never a pass`);
      assert.strictEqual(r.title, SHARD_FAILED, `shards ${shardsResult}: titled for what happened`);
      assert.ok(r.causes.some((c) => c.includes(shardsResult)), `shards ${shardsResult}: the cause names the result`);

      const cli = aggregateCli(verdictDir(PLAN_2, PASSING), ['--plan-result', 'success', '--shards-result', shardsResult]);
      assert.notStrictEqual(cli.status, 0, `shards ${shardsResult}: the step exits non-zero\n${cli.stdout}${cli.stderr}`);
      assert.ok(cli.stdout.includes(SHARD_FAILED), `shards ${shardsResult}: the step says so\n${cli.stdout}`);
    }
  });

  test('the inverse: clean shards with passing verdicts are still green', () => {
    const r = aggregate(PLAN_2, PASSING, { planResult: 'success', shardsResult: 'success' });
    assert.strictEqual(r.outcome, PASS);
    assert.strictEqual(r.title, 'Mutation guards passed');
    const cli = aggregateCli(verdictDir(PLAN_2, PASSING), ['--plan-result', 'success', '--shards-result', 'success']);
    assert.strictEqual(cli.status, 0, cli.stdout + cli.stderr);
    assert.ok(cli.stdout.includes('Mutation guards passed'), cli.stdout);
    // A plan with no shards runs no shard job, so GitHub records it skipped.
    const none = { id: 'p0', shards: [] };
    assert.strictEqual(aggregate(none, [], { planResult: 'success', shardsResult: 'skipped' }).outcome, PASS, 'nothing planned, nothing to fail');
    assert.strictEqual(aggregateCli(verdictDir(none, []), ['--plan-result', 'success', '--shards-result', 'skipped']).status, 0);
  });

  test('the retry: a re-run that comes back clean is green, one still dirty stays red', () => {
    // "Re-run failed jobs" re-runs the failed shard and the aggregate that
    // needs it; the verdicts are the same files, and only the result moves.
    assert.strictEqual(aggregate(PLAN_2, PASSING, { planResult: 'success', shardsResult: 'failure' }).outcome, FAIL, 'the first attempt');
    assert.strictEqual(aggregate(PLAN_2, PASSING, { planResult: 'success', shardsResult: 'success' }).outcome, PASS, 'a clean re-run');
    assert.strictEqual(aggregate(PLAN_2, PASSING, { planResult: 'success', shardsResult: 'failure' }).title, SHARD_FAILED, 'a re-run still dirty');
  });

  test('a guard that survived is still reported as one, naming where, though its shard job failed too', () => {
    // A surviving guard fails its shard step, so the shard jobs' result is
    // failure here as well. The verdict explains it, and its title says so.
    const survived = { plan: 'p2', shard: 2, outcome: FAIL, results: [
      { unit: 'mutate-x-guards.js rows 0:3', outcome: PASS },
      { unit: 'mutate-x-guards.js rows 3:9', outcome: FAIL, cause: 'exit 1' },
    ] };
    const r = aggregate(PLAN_2, [passed(1), survived], { planResult: 'success', shardsResult: 'failure' });
    assert.strictEqual(r.outcome, FAIL);
    assert.strictEqual(r.title, 'A guard survived');
    assert.deepStrictEqual(r.causes, ['shard 2: mutate-x-guards.js rows 3:9 fail (exit 1)']);
    const cli = aggregateCli(verdictDir(PLAN_2, [passed(1), survived]), ['--plan-result', 'success', '--shards-result', 'failure']);
    assert.strictEqual(cli.status, 1, cli.stdout + cli.stderr);
    assert.ok(cli.stdout.includes('A guard survived'), cli.stdout);
    assert.ok(cli.stdout.includes('mutate-x-guards.js rows 3:9'), 'the step names the slice that let a guard through');
    assert.ok(!cli.stdout.includes(SHARD_FAILED), 'and does not send the reader to a job for a reason the verdict already gives');
  });

  test('a verdict with no outcome that can be read is no verdict, never a pass', () => {
    for (const odd of [{ plan: 'p2', shard: 2 }, { plan: 'p2', shard: 2, outcome: 'passed', results: [] }]) {
      const r = aggregate(PLAN_2, [passed(1), odd], { planResult: 'success', shardsResult: 'success' });
      assert.strictEqual(r.outcome, NO_VERDICT, JSON.stringify(odd));
      assert.ok(r.title.startsWith('No verdict: shard 2'), `the title names the shard: ${r.title}`);
    }
    assert.strictEqual(combine([PASS, undefined]), NO_VERDICT, 'an outcome nobody wrote is not a pass');
    assert.strictEqual(combine([PASS, 'passed']), NO_VERDICT, 'nor is one spelled wrong');
    assert.strictEqual(combine([PASS, PASS]), PASS);
  });

  test('the control failing: a truncated verdict file leaves the step non-green', () => {
    const dir = verdictDir(PLAN_2, PASSING);
    const file = path.join(dir, 'verdict-2.json');
    const whole = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, whole.slice(0, Math.floor(whole.length / 2)));
    const cli = aggregateCli(dir, ['--plan-result', 'success', '--shards-result', 'success']);
    assert.strictEqual(cli.status, 3, cli.stdout + cli.stderr);
    assert.ok(cli.stdout.includes('No verdict: shard 2'), cli.stdout);
  });

  test('the control failing: a reader that throws leaves the step non-green', () => {
    const dir = verdictDir(PLAN_2, PASSING);
    const argv = ['--aggregate', '--plan-file', path.join(dir, 'plan.json'), '--verdicts', dir,
      '--plan-result', 'success', '--shards-result', 'success'];
    const quiet = { log: () => {}, env: {} };
    const real = (f) => fs.readFileSync(f, 'utf8');
    assert.strictEqual(aggregateCommand(argv, quiet), 0, 'sanity: the same files, read, pass');
    const throws = () => { throw new Error('EIO: the disk went away'); };
    assert.strictEqual(aggregateCommand(argv, { ...quiet, readFile: throws }), 3, 'no file could be read');
    assert.strictEqual(aggregateCommand(argv, { ...quiet, listDir: throws }), 3, 'the verdicts could not be listed');
    assert.strictEqual(aggregateCommand(argv, { ...quiet, readFile: (f) => (f.endsWith('verdict-1.json') ? throws() : real(f)) }), 3,
      'one verdict could not be read');
  });

  test('the control failing: a crash in the step exits non-zero, however Node is told to treat it', () => {
    // A summary that cannot be written throws after the title is printed.
    // Left to Node, an unhandled rejection under --unhandled-rejections=warn
    // ends the process 0, which a runner reads as green.
    const summary = tempDir('mutation-summary-is-a-directory-');
    for (const NODE_OPTIONS of ['', '--unhandled-rejections=warn']) {
      const cli = aggregateCli(verdictDir(PLAN_2, PASSING), ['--plan-result', 'success', '--shards-result', 'success'],
        { GITHUB_STEP_SUMMARY: summary, NODE_OPTIONS });
      assert.notStrictEqual(cli.status, 0, `NODE_OPTIONS=${NODE_OPTIONS}: a crash is never green\n${cli.stdout}${cli.stderr}`);
      assert.ok(cli.stderr.includes('EISDIR'), `and the crash is shown\n${cli.stderr}`);
    }
  });

  test('a shard jobs\' result that was not given, or is empty, is no verdict, never a pass', () => {
    // An empty value is what a mistyped needs expression gives.
    for (const extra of [[], ['--shards-result', '']]) {
      const cli = aggregateCli(verdictDir(PLAN_2, PASSING), ['--plan-result', 'success', ...extra]);
      assert.strictEqual(cli.status, 3, `${JSON.stringify(extra)}\n${cli.stdout}${cli.stderr}`);
      assert.ok(cli.stdout.includes('No verdict: the shard jobs\' result was not given'), cli.stdout);
    }
  });

  test('a plan job\'s result that was not given, or is empty, is no verdict, never a pass', () => {
    // The same class of input as the shard jobs' result, and the same mistyped
    // needs expression empties it.
    for (const extra of [[], ['--plan-result', '']]) {
      const cli = aggregateCli(verdictDir(PLAN_2, PASSING), [...extra, '--shards-result', 'success']);
      assert.strictEqual(cli.status, 3, `${JSON.stringify(extra)}\n${cli.stdout}${cli.stderr}`);
      assert.ok(cli.stdout.includes('No verdict: the plan job\'s result was not given'), cli.stdout);
    }
  });

  test('the function defaults neither job\'s result to success: a caller that means success says so', () => {
    const cases = [
      [undefined, 'plan job\'s'],
      [{}, 'plan job\'s'],
      [{ shardsResult: 'success' }, 'plan job\'s'],
      [{ planResult: '', shardsResult: 'success' }, 'plan job\'s'],
      [{ planResult: 'success' }, 'shard jobs\''],
      [{ planResult: 'success', shardsResult: '' }, 'shard jobs\''],
      [{ planResult: 'success', shardsResult: null }, 'shard jobs\''],
    ];
    for (const [given, missing] of cases) {
      const r = aggregate(PLAN_2, PASSING, given);
      assert.strictEqual(r.outcome, NO_VERDICT, `${JSON.stringify(given)}: never a pass`);
      assert.ok(r.title.startsWith(`No verdict: the ${missing} result was not given`), `${JSON.stringify(given)}: ${r.title}`);
    }
    assert.strictEqual(aggregate(PLAN_2, PASSING, { planResult: 'success', shardsResult: 'success' }).outcome, PASS,
      'the inverse: both given as success, with passing verdicts, is green');
  });
});
