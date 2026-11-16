'use strict';
// A mutation row with no verdict shows the end of what its suite printed.
//
// WHAT WAS MISSING. A row whose suite failed with output its harness could
// not read, or ran out of time, was reported as "no verdict" and nothing
// more: what the suite printed was dropped with the row. The cause was then a
// guess until the row was run again, and on CI a rerun was the only way to
// see a suite's output at all. One CI row got no verdict on two runs in a row
// and its log could not say why.
//
// WHAT HOLDS NOW, and is pinned here:
//
// - the runner keeps the end of each stream of the suite it ran last, a few
//   hundred characters starting at a line, with the repository's own paths
//   made relative and every other absolute path taken out, because these
//   lines go into CI logs anyone can read;
// - a row with no verdict carries that end from its harness's run to the end
//   of the run, and the runner prints it there by the row's label: every
//   harness ends through exitCodeFor, so this is said once, for all of them;
// - a row with a verdict prints nothing more.
//
// That every real harness hands its rows their suite's output is pinned, per
// harness, in mutation-harness-runner.test.js.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const mutationRun = require('../tools/mutation-run.js');
const { makeTempDir } = require('../helpers/workspace.js');

const REPO = path.join(__dirname, '..', '..');
const FIXTURES = path.join(REPO, 'test', 'fixtures', 'mutation-row-limit');
const HARNESS = path.join(FIXTURES, 'harness.js');

const settle = (p) => p.then((out) => ({ out }), (error) => ({ error }));
const spellings = (p) => [...new Set([p, fs.realpathSync(p)])];

// A child's environment. NODE_TEST_CONTEXT is left out: a nested node --test
// that inherits it reports in a form nobody here reads and still exits 0.
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

describe('the runner keeps the end of what the suite it ran last printed', () => {
  const { runSuite, suiteOutput, SUITE_TAIL_CHARS } = mutationRun;

  test('the end of each stream, from the start of a line, with paths outside the repository taken out', { timeout: 60000 }, async () => {
    const run = await settle(runSuite('node', [path.join(FIXTURES, 'prints-and-fails.js')], { cwd: REPO }));
    assert.ok(run.error, 'the suite fails');
    const kept = suiteOutput();
    assert.ok(kept, 'the runner keeps what the suite printed');
    const { stdout, stderr } = kept;

    assert.ok(Number.isInteger(SUITE_TAIL_CHARS) && SUITE_TAIL_CHARS >= 200 && SUITE_TAIL_CHARS <= 1000,
      'a few hundred characters of each stream, from one named constant');
    assert.ok(stdout.length <= SUITE_TAIL_CHARS, `stdout is cut to its end (${stdout.length} characters kept)`);
    assert.ok(stdout.length >= SUITE_TAIL_CHARS / 2, `and still shows a good part of it (${stdout.length} characters kept)`);
    assert.match(stdout, /the last line on stdout$/, 'the end is the last thing the suite printed');
    assert.match(stdout.split('\n')[0], /^progress line \d+ of a suite that prints a great deal$/,
      'and it starts at the start of a line, never inside one');

    assert.match(stderr, /^Error: it broke at node_modules\/electron\/index\.js:43:13$/m, 'a path inside the repository is shown relative to it');
    assert.match(stderr, /^ {4}at load \(lib\/loader\.js:1:1\)$/m, 'a file URL inside the repository too');
    assert.match(stderr, /^ {4}at fetch \(<path>:5:2\)$/m, 'a path outside it is taken out, and where it was is kept');
    assert.match(stderr, /^ {4}under <path>$/m);
    assert.match(stderr, /^ {4}and <path>$/m, 'a Windows path too');
    assert.match(stderr, /https:\/\/github\.com\/electron\/electron\/releases\/download\/v1\/electron\.zip/, 'a web address is not a path, and is kept');
    assert.match(stderr, /the last line on stderr$/);
    for (const leak of [...spellings(REPO), '/home/someone', ...spellings(os.tmpdir()), 'C:\\Users', 'file://']) {
      assert.ok(!stdout.includes(leak) && !stderr.includes(leak), `${JSON.stringify(leak)} is still in what was kept:\n${stderr}`);
    }
  });

  test('a repository reached through a link is made relative under the real spelling its suite prints', { timeout: 60000 }, async (t) => {
    // A suite's own paths come from process.cwd(), which is the real path.
    // Where the repository is reached through a link (a macOS temp folder, a
    // linked checkout) a scrub that knew only the spelling it was given would
    // take the repository's own paths out as foreign ones.
    const dir = makeTempDir('suite-output-link-');
    t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });
    const real = path.join(dir, 'real');
    const link = path.join(dir, 'link');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    await settle(runSuite('node', [path.join(FIXTURES, 'prints-and-fails.js')], { cwd: link }));
    const { stderr } = suiteOutput();
    assert.match(stderr, /^Error: it broke at node_modules\/electron\/index\.js:43:13$/m, `the real spelling is the repository too:\n${stderr}`);
    for (const leak of [link, ...spellings(real)]) assert.ok(!stderr.includes(leak), `${JSON.stringify(leak)} is still in:\n${stderr}`);
  });

  test('what is kept is the last run\'s alone, never an earlier one\'s', { timeout: 60000 }, async () => {
    await settle(runSuite('node', [path.join(FIXTURES, 'prints-and-fails.js')], { cwd: REPO }));
    assert.ok(suiteOutput().stdout.length > 0);
    const running = settle(runSuite('node', ['-e', 'setTimeout(() => {}, 300)'], { cwd: REPO }));
    assert.strictEqual(suiteOutput(), null, 'while the next suite runs, nothing is kept: the last one\'s output is not this one\'s');
    await running;
    await settle(runSuite('node', ['-e', 'process.stdout.write("only this\\n")'], { cwd: REPO }));
    assert.deepStrictEqual(suiteOutput(), { stdout: 'only this', stderr: '' }, 'a suite that passes is kept as it is');
    await settle(runSuite('node', [path.join(FIXTURES, 'prints-and-fails.js')], { cwd: REPO }));
    const missing = await settle(runSuite('rundock-mutation-fixture-no-such-command', [], { cwd: REPO }));
    assert.ok(missing.error, 'a command the system cannot find fails');
    assert.deepStrictEqual(suiteOutput(), { stdout: '', stderr: '' },
      'and what it printed, which is nothing, replaces what the run before it printed');
  });

  test('scrubbing leaves a line with no path alone, and works on text a suite never printed whole', () => {
    const { outputTail } = mutationRun;
    assert.strictEqual(outputTail('a line\nnode:internal/modules/cjs/loader:1761:14\n', { root: REPO }),
      'a line\nnode:internal/modules/cjs/loader:1761:14', 'a Node internal is not a path');
    assert.strictEqual(outputTail('', { root: REPO }), '');
    assert.strictEqual(outputTail(undefined, { root: REPO }), '');
    const long = `${'x'.repeat(20000)} ${path.join(REPO, 'a', 'b.js')}\nend`;
    const tail = outputTail(long, { root: REPO });
    assert.ok(tail.length <= mutationRun.SUITE_TAIL_CHARS);
    assert.ok(!tail.includes(REPO), 'a path on a line longer than what is kept is still taken out');
    assert.match(tail, /end$/);
  });
});

describe('a run with rows of no verdict ends with the end of each one\'s suite output', () => {
  const { exitCodeFor, NO_VERDICT } = mutationRun;
  function printed(failed, results) {
    const said = [];
    const real = console.log;
    console.log = (...args) => { said.push(args.join(' ')); };
    let code;
    try { code = exitCodeFor(failed, results); } finally { console.log = real; }
    return { code, out: said.join('\n') };
  }

  test('by the row\'s label, for a row whose output was unreadable and one whose suite did not finish, and for no other row', () => {
    const { code, out } = printed(3, [
      { label: 'a row a test noticed', applied: true, red: ['the guard holds'] },
      { label: 'a row whose output was unreadable', applied: true, unparsable: true, output: { stdout: 'Downloading a dependency...', stderr: 'Error: it failed to install\n    at fetch (<path>:5:2)' }, red: [] },
      { label: 'a row whose suite did not finish', applied: true, didNotFinish: 300, output: { stdout: '', stderr: 'still waiting' }, red: [] },
      { label: 'a row nothing noticed', applied: true, red: [] },
    ]);
    assert.strictEqual(code, 1, 'the exit code is decided as before');
    const at = (label) => out.split('\n').indexOf(label);
    assert.ok(at('a row whose output was unreadable') !== -1, `the unreadable row is named on a line of its own:\n${out}`);
    assert.ok(at('a row whose suite did not finish') !== -1, 'and so is the row that did not finish');
    assert.ok(out.includes('  stdout:\n    Downloading a dependency...\n  stderr:\n    Error: it failed to install\n        at fetch (<path>:5:2)'),
      `each stream of the unreadable row's suite follows its label, indented:\n${out}`);
    assert.ok(out.includes('  stdout: (nothing)\n  stderr:\n    still waiting'), 'a stream that printed nothing says so');
    assert.ok(!out.includes('a row a test noticed') && !out.includes('a row nothing noticed'), 'a row with a verdict prints nothing more');
  });

  test('a run whose rows all have a verdict, or carry no output, prints nothing more', () => {
    assert.deepStrictEqual(printed(1, [{ label: 'a', applied: true, red: [] }]), { code: 1, out: '' });
    assert.deepStrictEqual(printed(1, [{ label: 'b', applied: true, unparsable: true, output: null, red: [] }]), { code: NO_VERDICT, out: '' });
    assert.deepStrictEqual(printed(0, [{ label: 'c', applied: true, red: ['t'] }]), { code: 0, out: '' });
  });
});

describe('a harness whose row gets no verdict', () => {
  const GUARD = 'const GUARD = true;';
  const SOURCE = `'use strict';\n${GUARD}\nmodule.exports = { GUARD };\n`;

  test('prints the end of what that row\'s suite printed, by the row, with no path outside the repository', { timeout: 60000 }, async (t) => {
    const dir = makeTempDir('suite-output-repo-');
    t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });
    const root = path.join(dir, 'repo');
    fs.mkdirSync(root);
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    fs.writeFileSync(path.join(root, 'src.js'), SOURCE);
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    // The suite command, outside the repository: it prints, names a path in
    // the folder it runs in and one outside it, and fails with nothing a
    // harness can read.
    const command = path.join(dir, 'fails-unreadably');
    fs.writeFileSync(command, [
      '#!/usr/bin/env node',
      "const path = require('node:path');",
      "process.stdout.write('Downloading a dependency...\\n');",
      "process.stderr.write(`Error: it failed to install at ${path.join(process.cwd(), 'node_modules', 'dep', 'index.js')}:43:13\\n    at fetch (/home/someone/.cache/dep/get.js:5:2)\\n`);",
      'process.exit(1);',
      '',
    ].join('\n'), { mode: 0o755 });
    const label = 'a row whose suite prints and fails';
    const config = JSON.stringify({ rows: [{ suite: 'reads-src.js', label, guard: GUARD, without: 'const GUARD = false;' }], command });

    const kid = spawn(process.execPath, [HARNESS, root, config, '--markdown'], { cwd: REPO, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    kid.stdout.on('data', (b) => { stdout += b; });
    kid.stderr.on('data', (b) => { stderr += b; });
    t.after(() => { try { kid.kill('SIGKILL'); } catch { /* gone */ } });
    const status = await new Promise((resolve) => {
      const limit = setTimeout(() => { try { kid.kill('SIGKILL'); } catch { /* gone */ } }, 45000);
      kid.on('close', (code) => { clearTimeout(limit); resolve(code); });
    });
    t.diagnostic(`exit ${status}\n${stdout}\n${stderr}`);

    assert.match(stdout, new RegExp(`^\\| ${label} \\| \\*\\*no verdict: the suite failed but its output could not be parsed`, 'm'),
      `the row is reported as before:\n${stdout}`);
    assert.strictEqual(status, mutationRun.NO_VERDICT, 'and the harness exits as before');
    const block = stdout.slice(stdout.indexOf(`\n${label}\n`));
    assert.ok(block.length > label.length, `the row is named again, under the report, with its suite's output:\n${stdout}`);
    assert.match(block, /^ {4}Downloading a dependency\.\.\.$/m, 'what it printed on stdout');
    assert.match(block, /^ {4}Error: it failed to install at node_modules\/dep\/index\.js:43:13$/m, 'and on stderr, the path inside the folder made relative');
    assert.match(block, /^ {8}at fetch \(<path>:5:2\)$/m, 'the path outside it taken out');
    for (const leak of [...spellings(root), ...spellings(dir), '/home/someone']) {
      assert.ok(!block.includes(leak), `${JSON.stringify(leak)} is printed:\n${block}`);
    }
    assert.strictEqual(fs.readFileSync(path.join(root, 'src.js'), 'utf8'), SOURCE, 'the file is put back');
  });
});
