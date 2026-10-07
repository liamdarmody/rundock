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

describe('three outcomes: pass, fail, no verdict', () => {
  test('a harness\'s exit code and signal map to its outcome', () => {
    assert.strictEqual(outcomeOf(0, null).outcome, PASS);
    assert.strictEqual(outcomeOf(1, null).outcome, FAIL);
    assert.strictEqual(outcomeOf(3, null).outcome, NO_VERDICT);
    // Killed by a signal is no verdict, never a pass and never a failure.
    assert.strictEqual(outcomeOf(null, 'SIGTERM').outcome, NO_VERDICT);
    assert.match(outcomeOf(null, 'SIGKILL').cause, /signal SIGKILL/);
  });

  test('any fail is fail; otherwise any no verdict is no verdict', () => {
    assert.strictEqual(combine([PASS, NO_VERDICT, FAIL]), FAIL);
    assert.strictEqual(combine([PASS, NO_VERDICT]), NO_VERDICT);
    assert.strictEqual(combine([PASS, PASS]), PASS);
  });

  test('the aggregator reads a missing verdict file as no verdict for that shard', () => {
    const plan = { id: 'p1', shards: [{ index: 1 }, { index: 2 }] };
    const one = [{ plan: 'p1', shard: 1, outcome: PASS, results: [] }];
    const r = aggregate(plan, one);
    assert.strictEqual(r.outcome, NO_VERDICT);
    assert.match(r.causes[0], /shard 2 wrote no verdict/);
    assert.strictEqual(aggregate(plan, [...one, { plan: 'p1', shard: 2, outcome: PASS }]).outcome, PASS);
    assert.strictEqual(aggregate(plan, [...one, { plan: 'other', shard: 2, outcome: PASS }]).outcome, NO_VERDICT);
    assert.strictEqual(aggregate(plan, [...one, { plan: 'p1', shard: 2, outcome: FAIL }]).outcome, FAIL);
  });

  test('a failed plan job is a failure; a cancelled one is no verdict', () => {
    assert.strictEqual(aggregate(null, [], { planResult: 'failure' }).outcome, FAIL);
    assert.strictEqual(aggregate(null, [], { planResult: 'cancelled' }).outcome, NO_VERDICT);
    assert.strictEqual(aggregate({ id: 'x', shards: [] }, []).outcome, PASS, 'an empty plan has nothing to fail');
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
    const r = aggregate(plan, verdicts);
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
      '--plan-file', path.join(dir, 'plan.json'), '--verdicts', dir], { encoding: 'utf8', env });
    assert.strictEqual(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /No verdict: shard 2 wrote no verdict/);
    assert.doesNotMatch(r.stdout, /failed/i, 'no verdict is never titled a failure');
  });
});
