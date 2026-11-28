'use strict';
// The prove workflow's input checks, its merge of main into the blocked head,
// and its application of a breakage row.
//
// Every job checks every input before using any of them, and stops at the
// first check that fails, named: shape (the hex inputs, the label and the
// digest of the lists), lists (their entries, indexes and cross references),
// commits (how main, the blocked head and the fix head are related), then
// paths (each file a test or row names is a plain path to a regular file in
// the fix head).
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

const { loadPiece, runStep } = require('../helpers/prove-workflow.js');
const { makeTempDir } = require('../helpers/workspace.js');

const { shapeCheck, listsCheck, pathsCheck, checkInputs } =
  loadPiece(['bytes', 'input checks'], ['shapeCheck', 'listsCheck', 'pathsCheck', 'checkInputs']);
const { mergeMain } = loadPiece('merge', ['mergeMain']);
const { applyRow } = loadPiece('apply row', ['applyRow']);

const HEX40 = (c) => c.repeat(40);
// What a label that is neither empty nor # then 1 to 6 digits, a space and 7
// lowercase hex characters is refused with, word for word.
const LABEL_WHY = 'label must be empty or # then 1 to 6 digits, a space and 7 lowercase hex characters';
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
  const git = (args, input) => execFileSync('git', args, { cwd: dir, env, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  const out = (args, input) => String(git(args, input)).trim();
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

  test('an empty label passes', () => {
    assert.strictEqual(shapeCheck(worked({ LABEL: '' })), null);
    // Empty holds nothing: a label of one space is not empty.
    assert.strictEqual(shapeCheck(worked({ LABEL: ' ' })), LABEL_WHY);
  });

  test('a label of a pull request and a short head passes', () => {
    for (const label of ['#515 c1e6428', '#1 0000000', '#999999 abcdef0']) {
      assert.strictEqual(shapeCheck(worked({ LABEL: label })), null, label);
    }
    // Each beside its nearest neighbour that is refused: a head one character
    // short, no digits, and one digit too many.
    for (const label of ['#515 c1e642', '# 0000000', '#9999999 abcdef0']) {
      assert.strictEqual(shapeCheck(worked({ LABEL: label })), LABEL_WHY, label);
    }
  });

  test('a label is refused for each way it can be wrong', () => {
    const WRONG = [
      ['#1234567 c1e6428', 'seven digits'],
      ['# c1e6428', 'no digits'],
      ['515 c1e6428', 'no #'],
      ['#515 C1E6428', 'uppercase'],
      ['#515 c1e642', 'six hex'],
      ['#515 c1e64289', 'eight hex'],
      ['#515  c1e6428', 'two spaces'],
      ['#515\tc1e6428', 'a tab'],
      ['#515 c1e6428\n', 'a trailing newline'],
      ['\n#515 c1e6428', 'a leading newline'],
      ['#515 c1e6428 x', 'a word after'],
      ['#515 0123456789abcdef0123456789abcdef', 'a 32-hex word where the head belongs'],
      ['${{ github.token }}', 'an expression'],
      ['$(id)', 'a command substitution'],
    ];
    for (const [label, what] of WRONG) assert.strictEqual(shapeCheck(worked({ LABEL: label })), LABEL_WHY, what);
  });

  test('a run with a well-formed label still fails on a bad hex input first', () => {
    // Each hex input made bad, in the order they are checked, and its refusal.
    const BAD = [
      ['NONCE', 'ABCDEF0123456789abcdef0123456789', 'nonce must be 32 lowercase hex characters'],
      ['BLOCKED_SHA', HEX40('b').slice(1), 'blocked must be 40 lowercase hex characters'],
      ['MAIN_SHA', `${HEX40('c').slice(1)}g`, 'main must be 40 lowercase hex characters'],
      ['HEAD_SHA', `${HEX40('d')}0`, 'head must be 40 lowercase hex characters'],
      ['INPUTS_SHA256', WORKED.toUpperCase(), 'inputs_sha256 must be 64 lowercase hex characters'],
    ];
    // A label that passes stands in for none of them.
    for (const [key, value, why] of BAD) {
      assert.strictEqual(shapeCheck(worked({ LABEL: '#515 c1e6428', [key]: value })), why, key);
    }
    // Nor does it move among them, which only a label that fails can show:
    // with every hex input bad, the label malformed and tests that no longer
    // match the digest, repairing each in turn hands the refusal to the next,
    // the hex inputs in their order, then the label, then the digest.
    const env = worked({ ...Object.fromEntries(BAD.map(([key, value]) => [key, value])), LABEL: '#515 C1E6428', TESTS: TESTS.replace('date', 'data') });
    for (const [key, , why] of BAD) {
      assert.strictEqual(shapeCheck(env), why, `${key} is the first bad input`);
      env[key] = worked()[key];
    }
    assert.strictEqual(shapeCheck(env), LABEL_WHY, 'the label is the first bad input');
    env.LABEL = '#515 c1e6428';
    assert.match(shapeCheck(env), /^inputs_sha256 is not the SHA-256 of tests, a newline and rows, which is [0-9a-f]{64}$/);
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

  test('a run started with no label passes every check, as one started today does', () => {
    assert.strictEqual(checkInputs({ ...env(), LABEL: '' }, repo.git), null);
    // A runner that leaves an empty variable out gives no LABEL at all, which
    // is no label too.
    assert.strictEqual(checkInputs(env(), repo.git), null);
    // No label is an empty one, and nothing else: one space is refused.
    assert.strictEqual(checkInputs({ ...env(), LABEL: ' ' }, repo.git), `shape: ${LABEL_WHY}`);
  });

  test('a run started with a well-formed label passes every check', () => {
    assert.strictEqual(checkInputs({ ...env(), LABEL: '#515 c1e6428' }, repo.git), null);
    // The same label with its head in uppercase is refused, so the label was
    // checked rather than passed over.
    assert.strictEqual(checkInputs({ ...env(), LABEL: '#515 C1E6428' }, repo.git), `shape: ${LABEL_WHY}`);
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

  const NAMES = [['a trailing space', 'a works '], ['a leading tab', '\ta works'], ['a trailing no-break space', 'a works\u00a0']];
  for (const [what, name] of NAMES) {
    test(`a test name with ${what} fails the names check`, () => {
      assert.strictEqual(run({ tests: [{ i: 1, file: 'test/a.test.js', name }] }),
        'names: test 1 has a name that starts or ends with whitespace');
    });
  }

  test("a lone surrogate in a test's name or a row's from fails the well-formed check", () => {
    assert.strictEqual(run({ tests: [{ i: 1, file: 'test/a.test.js', name: 'a \ud800 works' }] }),
      'well-formed: test 1 has a name that is not well-formed Unicode');
    assert.strictEqual(run({ rows: [{ i: 1, file: 'src/a.js', from: 'x\udc00', to: '2', test: 1 }] }),
      'well-formed: row 1 has a from that is not well-formed Unicode');
  });

  test('a fix head whose tree holds a path with byte 0xFF fails the paths check, naming it', () => {
    // A file system may refuse a name that is not UTF-8, so the tree is
    // written with git mktree, which takes bytes, on top of the fix head.
    const blob = repo.out(['hash-object', '-w', '--stdin'], '1;\n');
    const entry = Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), Buffer.from([0xff, 0x2e, 0x6a, 0x73]), Buffer.from([0])]);
    const tree = String(repo.git(['mktree', '-z'], Buffer.concat([repo.git(['ls-tree', '-z', sha.head]), entry]))).trim();
    const head = String(repo.git(['commit-tree', tree, '-p', sha.head, '-m', 'name as bytes'])).trim();
    repo.git(['update-ref', 'refs/heads/name-as-bytes', head]);
    assert.strictEqual(run({ head }), 'paths: the fix head holds the path "\\xFF.js", which is not well-formed UTF-8');
  });

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

describe('a malformed label, through the whole check inputs step of each job', () => {
  test('a malformed label fails check inputs with the label message in every job, before any later step', (t) => {
    const said = [];
    t.mock.method(console, 'error', (line) => said.push(String(line)));
    t.mock.method(console, 'log', () => {});
    // The step's git, which nothing may reach once the label is refused.
    const git = [];
    const fakeRequire = (name) => (name === 'node:child_process'
      ? { execFileSync: (cmd, args) => { git.push([cmd, ...args].join(' ')); throw new Error('no git here'); } }
      : require(name));
    for (const job of ['red', 'green', 'break']) {
      said.length = 0;
      git.length = 0;
      let code = null;
      const proc = { env: { ...inputs(), LABEL: '#515 C1E6428' }, exit: (c) => { code = c; throw new Error('exited'); } };
      assert.throws(() => runStep(job, 'check inputs', fakeRequire, proc), { message: 'exited' }, job);
      // A step that exits 1 fails its job there, and no later step runs: the
      // static tests hold that no step is skipped on a condition or lets a
      // failure pass.
      assert.strictEqual(code, 1, job);
      assert.deepStrictEqual(said, [`check inputs failed: shape: ${LABEL_WHY}`], job);
      assert.deepStrictEqual(git, [], `${job}: no commit was read`);
    }
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
