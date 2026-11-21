'use strict';
// The prove workflow's input checks, its merge of main into the blocked head,
// and its application of a breakage row.
//
// Every job checks every input before using any of them, and stops at the
// first check that fails, named: shape (the hex inputs and the digest of the
// lists), lists (their entries, indexes and cross references), commits (how
// main, the blocked head and the fix head are related), then paths (each file
// a test or row names is a plain path to a regular file in the fix head).
//
// The code is cut out of the workflow itself, so these tests run the code the
// workflow runs, against throwaway repositories for everything git answers.
const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { loadPiece } = require('../helpers/prove-workflow.js');
const { makeTempDir } = require('../helpers/workspace.js');

const { shapeCheck, listsCheck, pathsCheck, checkInputs } =
  loadPiece('input checks', ['shapeCheck', 'listsCheck', 'pathsCheck', 'checkInputs']);
const { mergeMain } = loadPiece('merge', ['mergeMain']);
const { applyRow } = loadPiece('apply row', ['applyRow']);

const HEX40 = (c) => c.repeat(40);
const digest = (tests, rows) => crypto.createHash('sha256').update(`${tests}\n${rows}`, 'utf8').digest('hex');

/** The env a job's `check inputs` step sees, with the digest made to match. */
function inputs({ tests, rows, blocked = HEX40('b'), main = HEX40('c'), head = HEX40('d'), sha } = {}) {
  const T = JSON.stringify(tests || [{ i: 1, file: 'test/a.test.js', name: 'a works' }]);
  const R = JSON.stringify(rows || [{ i: 1, file: 'src/a.js', from: '1', to: '2', test: 1 }]);
  return {
    NONCE: '0123456789abcdef0123456789abcdef',
    BLOCKED_SHA: blocked, MAIN_SHA: main, HEAD_SHA: head,
    TESTS: T, ROWS: R, INPUTS_SHA256: sha === undefined ? digest(T, R) : sha,
  };
}

// A throwaway repository. Its origin is itself, so fetching main and fetching
// each commit by SHA work as they do against the real remote.
function makeRepo(dir) {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: dir,
  };
  const git = (args) => execFileSync('git', args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (args) => String(git(args)).trim();
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const commit = (message) => {
    git(['add', '-A']);
    git(['commit', '-q', '--allow-empty', '-m', message]);
    return out(['rev-parse', 'HEAD']);
  };
  git(['init', '-q', '-b', 'main']);
  // The identity is the repository's own, so a -c on the command line, as the
  // merge passes, overrides it the way it would on a runner.
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['remote', 'add', 'origin', dir]);
  return { dir, git, out, write, commit };
}

describe('shape', () => {
  // The worked example: its digest is the SHA-256 of tests, a newline, rows.
  const TESTS = '[{"i":1,"file":"test/example.test.js","name":"example parses a date"}]';
  const ROWS = '[{"i":1,"file":"src/example.js","from":"return a;","to":"return b;","test":1}]';
  const WORKED = '5d8b95986db9c92c9cadc911b18a769045da1d630ffb818e29651f539e869ff3';
  const worked = (over = {}) => ({ ...inputs(), TESTS, ROWS, INPUTS_SHA256: WORKED, ...over });

  test('the worked digest holds', () => {
    assert.strictEqual(shapeCheck(worked()), null);
  });

  test('a one-character change to tests or to rows breaks the digest', () => {
    for (const over of [{ TESTS: TESTS.replace('date', 'data') }, { ROWS: ROWS.replace('return b;', 'return c;') }]) {
      const why = shapeCheck(worked(over));
      assert.ok(why && why.includes('inputs_sha256'), why);
    }
  });

  test('each hex input must be lowercase hex of its length', () => {
    const bad = {
      NONCE: 'ABCDEF0123456789abcdef0123456789',
      BLOCKED_SHA: HEX40('b').slice(1),
      MAIN_SHA: `${HEX40('c').slice(1)}g`,
      HEAD_SHA: `${HEX40('d')}0`,
      INPUTS_SHA256: WORKED.toUpperCase(),
    };
    const names = { NONCE: 'nonce', BLOCKED_SHA: 'blocked', MAIN_SHA: 'main', HEAD_SHA: 'head', INPUTS_SHA256: 'inputs_sha256' };
    for (const [key, value] of Object.entries(bad)) {
      const why = shapeCheck(worked({ [key]: value }));
      assert.ok(why && why.startsWith(names[key]), `${key}: ${why}`);
    }
  });
});

describe('lists', () => {
  const t = (i, file = `test/${i}.test.js`) => ({ i, file, name: `test ${i}` });
  const r = (i, test = i) => ({ i, file: `src/${i}.js`, from: 'a', to: 'b', test });
  const why = (tests, rows) => listsCheck(inputs({ tests, rows }));

  test('a well-formed pair of lists passes', () => {
    assert.strictEqual(why([t(1), t(2)], [r(1), r(2), r(3, 1)]), null);
  });

  test('each list holds 1 to 20 entries', () => {
    const many = Array.from({ length: 21 }, (_, n) => n + 1);
    assert.ok(why([], [r(1)]));
    assert.ok(why([t(1)], []));
    assert.ok(why(many.map((i) => t(i)), many.map((i) => r(i))));
    const twenty = many.slice(0, 20);
    assert.strictEqual(why(twenty.map((i) => t(i)), twenty.map((i) => r(i))), null);
  });

  test('entries are indexed 1..n, with no gap or repeat', () => {
    for (const tests of [[t(1), t(3)], [t(1), t(1)], [t(0)], [t(2)]]) {
      assert.ok(why(tests, tests.map((x) => r(x.i))), JSON.stringify(tests));
    }
    assert.ok(why([t(1)], [r(1), r(1, 1)]), 'a repeated row index');
  });

  test('entries have exactly their keys, of the right types', () => {
    const shapes = [
      [{ ...t(1), extra: 1 }], [{ i: 1, file: 'test/a.test.js' }], [{ ...t(1), i: '1' }],
      [{ ...t(1), name: '' }], [{ ...t(1), file: 7 }], [null], [[1]],
    ];
    for (const tests of shapes) assert.ok(why(tests, [r(1)]), JSON.stringify(tests));
    for (const rows of [[{ ...r(1), from: '' }], [{ ...r(1), to: 2 }], [{ ...r(1), test: '1' }]]) {
      assert.ok(why([t(1)], rows), JSON.stringify(rows));
    }
    assert.strictEqual(why([t(1)], [{ ...r(1), to: '' }]), null, 'a row may delete its text');
  });

  test("each row's test names an entry, and every test is named by a row", () => {
    const missing = why([t(1)], [r(1), r(2, 2)]);
    assert.ok(missing && missing.includes('row 2'), missing);
    const unnamed = why([t(1), t(2)], [r(1), r(2, 1)]);
    assert.ok(unnamed && unnamed.includes('test 2'), unnamed);
  });

  test('a list that is not a JSON array is refused', () => {
    for (const text of ['', 'not json', '{"i":1}', '"[]"']) {
      const env = { ...inputs(), TESTS: text };
      assert.ok(listsCheck(env), JSON.stringify(text));
    }
  });
});

describe('paths, on their own', () => {
  const modes = new Map([
    ['test/a.test.js', '100644'], ['src/a.js', '100644'], ['bin/run.js', '100755'],
    ['src/link.js', '120000'], ['vendor/sub', '160000'],
    ['package.json', '100644'], ['.github/workflows/x.yml', '100644'],
  ]);
  const T = [{ i: 1, file: 'test/a.test.js', name: 'a works' }];
  const rowAt = (file) => [{ i: 1, file, from: '1', to: '2', test: 1 }];

  test('a plain path to a regular or executable file passes', () => {
    assert.strictEqual(pathsCheck(T, rowAt('src/a.js'), modes), null);
    assert.strictEqual(pathsCheck(T, rowAt('bin/run.js'), modes), null);
  });

  test('a test file outside test/ is refused', () => {
    const why = pathsCheck([{ i: 1, file: 'src/a.js', name: 'a works' }], rowAt('src/a.js'), modes);
    assert.ok(why && why.includes('"src/a.js"') && why.includes('test/'), why);
  });

  test('a symlink, a submodule or a missing file is refused', () => {
    for (const file of ['src/link.js', 'vendor/sub', 'src/none.js', 'src']) {
      const why = pathsCheck(T, rowAt(file), modes);
      assert.ok(why && why.includes(JSON.stringify(file)), `${file}: ${why}`);
    }
  });
});

describe('every check, through the step, in a repository', () => {
  let repo;
  const sha = {};
  before(() => {
    repo = makeRepo(makeTempDir('prove-inputs-'));
    const { write, commit, git } = repo;
    write('src/a.js', 'module.exports = 1;\n');
    write('test/a.test.js', "require('../src/a.js');\n");
    write('package.json', '{}\n');
    write('.github/workflows/x.yml', 'name: x\n');
    sha.base = commit('base');
    git(['switch', '-q', '-c', 'side']);
    write('side.txt', 'side\n');
    sha.side = commit('side');
    git(['switch', '-q', '-c', 'blocked', sha.base]);
    write('test/blocked.test.js', '// blocked\n');
    sha.blocked = commit('blocked');
    git(['switch', '-q', 'main']);
    write('src/m.js', '// main\n');
    sha.main = commit('main');
    git(['switch', '-q', '-c', 'fix', sha.blocked]);
    git(['merge', '-q', '--no-edit', sha.main]);
    write('src/a.js', 'module.exports = 2;\n');
    fs.symlinkSync('a.js', path.join(repo.dir, 'src', 'link.js'));
    git(['add', '-A']);
    // Committed without add -A, which would drop the gitlink: no directory
    // stands at vendor/sub.
    git(['update-index', '--add', '--cacheinfo', `160000,${sha.base},vendor/sub`]);
    git(['commit', '-q', '-m', 'fix']);
    sha.head = repo.out(['rev-parse', 'HEAD']);
    const modes = repo.out(['ls-tree', sha.head, 'src/link.js', 'vendor/sub']);
    assert.match(modes, /^120000 blob \w+\tsrc\/link\.js$/m, 'the fix head holds a symlink');
    assert.match(modes, /^160000 commit \w+\tvendor\/sub$/m, 'the fix head holds a submodule');
    git(['switch', '-q', 'main']);
    write('src/later.js', '// later\n');
    sha.tip = commit('later');
  });
  const env = (over = {}) => inputs({ blocked: sha.blocked, main: sha.main, head: sha.head, ...over });
  const run = (over) => checkInputs(env(over), repo.git);

  test('inputs that hold pass', () => {
    assert.strictEqual(run(), null);
  });

  test('main must be on main, and main and the blocked head inside the fix head', () => {
    for (const [over, what] of [
      [{ main: sha.side }, 'main off main'],
      [{ blocked: sha.side }, 'the blocked head outside the fix head'],
      [{ main: sha.tip }, 'main outside the fix head'],
      [{ head: HEX40('f') }, 'a fix head that does not exist'],
    ]) {
      const why = run(over);
      assert.ok(why && why.startsWith('commits: '), `${what}: ${why}`);
    }
  });

  test('main may be the tip of main', () => {
    const r = makeRepo(makeTempDir('prove-tip-'));
    r.write('src/a.js', '1;\n');
    r.write('test/a.test.js', '1;\n');
    const m = r.commit('base');
    r.git(['switch', '-q', '-c', 'fix']);
    r.write('src/a.js', '2;\n');
    const h = r.commit('fix');
    assert.strictEqual(checkInputs(inputs({ blocked: m, main: m, head: h }), r.git), null);
  });

  const T = (file) => [{ i: 1, file, name: 'a works' }];
  const R = (file) => [{ i: 1, file, from: '1', to: '2', test: 1 }];
  const PATHS = [
    ['a row file starting ./', { rows: R('./src/a.js') }, './src/a.js', 'starts with ./'],
    ['an empty segment', { rows: R('src//a.js') }, 'src//a.js', 'has an empty segment'],
    ['a . segment', { rows: R('src/./a.js') }, 'src/./a.js', 'has a . segment'],
    ['a trailing /', { rows: R('src/a.js/') }, 'src/a.js/', 'ends with /'],
    ['a .. segment', { rows: R('test/../src/a.js') }, 'test/../src/a.js', 'has a .. segment'],
    ['a backslash', { rows: R('src\\a.js') }, 'src\\a.js', 'holds a backslash'],
    ['a row file under .github/', { rows: R('.github/workflows/x.yml') }, '.github/workflows/x.yml', 'is under .github/'],
    ['a row file that is package.json', { rows: R('package.json') }, 'package.json', 'is a root file npm or Node reads'],
    ['a row file in test/', { rows: R('test/a.test.js') }, 'test/a.test.js', 'is under test/'],
    ['a test file outside test/', { tests: T('src/a.js') }, 'src/a.js', 'is outside test/'],
    ['a test file starting ./', { tests: T('./test/a.test.js') }, './test/a.test.js', 'starts with ./'],
    ['a symlink at the fix head', { rows: R('src/link.js') }, 'src/link.js', 'is a symlink in the fix head'],
    ['a submodule at the fix head', { rows: R('vendor/sub') }, 'vendor/sub', 'is a submodule in the fix head'],
    ['a file missing from the fix head', { rows: R('src/none.js') }, 'src/none.js', 'is not a file in the fix head'],
  ];
  for (const [what, over, file, reason] of PATHS) {
    test(`${what} fails the paths check, naming the file and why`, () => {
      const why = run(over);
      assert.ok(why && why.startsWith('paths: ') && why.includes(JSON.stringify(file)), why);
      assert.ok(why.endsWith(`, which ${reason}`), why);
    });
  }

  test('a test no row names fails the lists check', () => {
    const why = run({ tests: [...T('test/a.test.js'), { i: 2, file: 'test/a.test.js', name: 'other' }] });
    assert.ok(why && why.startsWith('lists: ') && why.includes('test 2'), why);
  });

  test('the first check that fails is the one named', () => {
    const shape = run({ rows: R('./src/a.js'), sha: '0'.repeat(64) });
    assert.ok(shape && shape.startsWith('shape: '), shape);
    const lists = run({ tests: [...T('test/a.test.js'), { i: 3, file: 'test/a.test.js', name: 'x' }], main: sha.side });
    assert.ok(lists && lists.startsWith('lists: '), lists);
    const commits = run({ rows: R('./src/a.js'), main: sha.side });
    assert.ok(commits && commits.startsWith('commits: '), commits);
  });
});

describe('merging main into the blocked head', () => {
  function graph(t, blockedText, mainText) {
    const r = makeRepo(makeTempDir('prove-merge-'));
    t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
    r.write('a.txt', 'one\n');
    const base = r.commit('base');
    r.git(['switch', '-q', '-c', 'blocked']);
    r.write(...blockedText);
    const blocked = r.commit('blocked');
    r.git(['switch', '-q', 'main']);
    r.write(...mainText);
    const main = r.commit('main');
    return { r, base, blocked, main };
  }

  test('a clean merge leaves the merge of the two checked out', (t) => {
    const { r, blocked, main } = graph(t, ['b.txt', 'b\n'], ['m.txt', 'm\n']);
    assert.strictEqual(mergeMain(r.git, { BLOCKED_SHA: blocked, MAIN_SHA: main }), null);
    assert.strictEqual(r.out(['rev-parse', 'HEAD^1']), blocked);
    assert.strictEqual(r.out(['rev-parse', 'HEAD^2']), main);
    assert.strictEqual(r.out(['log', '-1', '--format=%an %ae']), 'prove prove@example.invalid');
  });

  test('a conflict fails the merge, and says so', (t) => {
    const { r, blocked, main } = graph(t, ['a.txt', 'two\n'], ['a.txt', 'three\n']);
    const why = mergeMain(r.git, { BLOCKED_SHA: blocked, MAIN_SHA: main });
    assert.ok(why && why.includes('CONFLICT'), why);
  });
});

describe('applying a row', () => {
  const row = (from, to = 'X') => ({ i: 4, file: 'src/a.js', from, to, test: 1 });
  const text = Buffer.from('const a = 1;\nconst b = 1;\nreturn café;\n');

  test('a from that occurs once is replaced', () => {
    const out = applyRow(text, row('const a', 'let a'));
    assert.strictEqual(out.why, undefined);
    assert.strictEqual(out.buffer.toString(), 'let a = 1;\nconst b = 1;\nreturn café;\n');
    assert.strictEqual(applyRow(text, row('café', 'tea')).buffer.toString(), 'const a = 1;\nconst b = 1;\nreturn tea;\n');
  });

  test('a from that does not occur is refused', () => {
    const out = applyRow(text, row('const c'));
    assert.ok(out.why && out.why.includes('row 4') && !out.buffer, out.why);
  });

  test('a from that occurs twice, even overlapping, is refused', () => {
    for (const from of [' = 1;', 'const ']) {
      const out = applyRow(text, row(from));
      assert.ok(out.why && out.why.includes('row 4') && !out.buffer, `${from}: ${out.why}`);
    }
    const overlap = applyRow(Buffer.from('aaa'), row('aa'));
    assert.ok(overlap.why, 'aa occurs twice in aaa');
  });
});
