'use strict';
// WHERE A RELOCATED RUNTIME HOME KEEPS ITS SECRETS, AS RECORDED.
//
// The permission hook follows CLAUDE_CONFIG_DIR and CODEX_HOME only as far as
// scripts/runtime-home-truth/captured-runtime-homes.json says the installed
// CLI was seen to go: that record is what scripts/runtime-home-truth/capture.js
// measured (run by hand: it needs real installs, and uses a stand-in for the
// messages API, so no account is used and no model is called).
//
// This half runs in CI, which has neither CLI. It holds the record to what it
// claims, keeps it free of any machine's names, and binds the hook's list to
// it both ways: an entry the hook joins under the variable's folder was seen
// there, or the record gives the basis for joining it unseen, and an entry
// seen there that the registry names under the default home is joined.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hook = require('../../scripts/permission-hook.js');
const { leaks, listTree, createRunRoot, caseFolders, removeRunRoot, scrubber, scrubRunNames } = require('../../scripts/runtime-home-truth/capture.js');

const FILE = path.join(__dirname, '..', '..', 'scripts', 'runtime-home-truth', 'captured-runtime-homes.json');
const RAW = fs.readFileSync(FILE, 'utf8');
const RECORD = JSON.parse(RAW);
const ROW = Object.fromEntries(hook.RELOCATED_HOMES.map(r => [r.runtime, r]));

describe('the record, as written', () => {
  test('says how it was taken, and that no account, model or Keychain was used', () => {
    for (const phrase of ['No account was used', 'no model was called', 'the Keychain was never touched', 'print mode']) {
      assert.ok(RECORD.method.includes(phrase), phrase);
    }
  });

  test('holds no name of this machine, and no path from any machine', () => {
    assert.deepStrictEqual(leaks(RAW), []);
  });

  test('names Claude Code\'s version, and what it was seen to write, with both runs finished', () => {
    const c = RECORD.runtimes.claude;
    assert.strictEqual(c.variable, 'CLAUDE_CONFIG_DIR');
    assert.strictEqual(c.measured, true);
    assert.ok(/^\d+\.\d+\.\d+$/.test(String(c.runtimeVersion)), c.runtimeVersion);
    assert.deepStrictEqual(c.cliExitCodes, [0, 0]);
    assert.deepStrictEqual(c.credentialSent, ['the placeholder key'], 'the stand-in saw only the placeholder key');
  });

  test('Claude Code kept its account file and its backups folder in the variable\'s folder, and nothing in home', () => {
    const c = RECORD.runtimes.claude;
    assert.deepStrictEqual(c.created.home, [], 'nothing was written under HOME');
    assert.deepStrictEqual(c.files['.claude.json'], ['relocated']);
    assert.deepStrictEqual(c.files['backups/'], ['relocated']);
    assert.ok(c.created.relocated.some(f => f.startsWith('backups/.claude.json.backup.')), 'the backups folder held a copy of the account file');
  });

  test('the credential file is recorded as not measured, with the reason', () => {
    const c = RECORD.runtimes.claude;
    assert.deepStrictEqual(c.files['.credentials.json'], []);
    assert.ok(/sign/.test(c.notMeasured['.credentials.json']) && /Keychain/.test(c.notMeasured['.credentials.json']));
  });

  test('the credential file is joined unmeasured, on a basis the record states', () => {
    const basis = (RECORD.runtimes.claude.joinedUnmeasured || {})['.credentials.json'];
    assert.ok(typeof basis === 'string', 'the record gives the basis for joining it');
    for (const [claim, re] of [
      ['the measured run kept everything in the variable\'s folder, the home folder\'s account file included, and nothing in home', /everything Claude Code keeps, `~\/\.claude\.json` from home included, in the variable's folder and nothing in home/],
      ['the file is the default home\'s registry name', /`\.credentials\.json` in the default home's registry/],
      ['joining a name that never appears only adds a card', /only adds a card and frees nothing/],
    ]) assert.match(basis, re, claim);
  });

  test('names Codex\'s version, with its sign-in finished', () => {
    const x = RECORD.runtimes.codex;
    assert.strictEqual(x.variable, 'CODEX_HOME');
    assert.strictEqual(x.measured, true);
    assert.ok(/^\d+\.\d+\.\d+$/.test(String(x.runtimeVersion)), x.runtimeVersion);
    assert.deepStrictEqual(x.cliExitCodes, [0]);
  });

  test('Codex kept its sign-in file in the variable\'s folder, and nothing in home', () => {
    const x = RECORD.runtimes.codex;
    assert.deepStrictEqual(x.created.home, [], 'nothing was written under HOME');
    assert.deepStrictEqual(x.files['auth.json'], ['relocated']);
    assert.ok(x.created.relocated.includes('auth.json'));
  });

  test('a name made new for each run is written as a placeholder, so a rerun can match', () => {
    for (const runtime of Object.values(RECORD.runtimes)) {
      for (const name of [...runtime.created.home, ...runtime.created.relocated]) {
        assert.strictEqual(scrubRunNames(name), name, `${name} carries no name a rerun would change`);
      }
    }
  });
});

describe('the hook follows the variable exactly as far as the record', () => {
  test('each runtime reads the variable the record names', () => {
    for (const [runtime, r] of Object.entries(RECORD.runtimes)) {
      assert.ok(ROW[runtime], `the hook has a row for ${runtime}`);
      assert.strictEqual(ROW[runtime].variable, r.variable, runtime);
    }
    assert.deepStrictEqual(Object.keys(ROW).sort(), Object.keys(RECORD.runtimes).sort(), 'and no row the record does not cover');
  });

  const joined = (row) => [...row.secrets, ...row.secretDirs.map(d => `${d}/`)];
  test('every entry joined under the variable\'s folder was seen there, or is joined on a basis the record states', () => {
    for (const [runtime, row] of Object.entries(ROW)) {
      const r = RECORD.runtimes[runtime];
      assert.strictEqual(r.measured, true, `${runtime}: the runtime was measured`);
      for (const name of joined(row)) {
        const seen = (r.files[name] || []).includes('relocated');
        const basis = (r.joinedUnmeasured || {})[name];
        assert.ok(seen || (typeof basis === 'string' && basis.length > 0), `${runtime}: ${name} was seen in the variable's folder, or the record says why it is joined unseen`);
      }
      for (const name of Object.keys(r.joinedUnmeasured || {})) {
        assert.ok(joined(row).includes(name), `${runtime}: ${name}, given a basis in the record, is joined`);
        assert.deepStrictEqual(r.files[name], [], `${runtime}: and was seen nowhere, or it would need no basis`);
      }
    }
  });

  test('every secret seen there that the registry names under the default home is joined', () => {
    const NAMED = {
      claude: [...hook.HOME_SECRET_FILES, ...hook.SECRET_RELATIVE_PATHS, ...hook.SECRET_RELATIVE_DIRS.map(d => `${d}/`)],
      codex: [...hook.CODEX_SECRET_RELATIVE_PATHS, ...hook.CODEX_SECRET_RELATIVE_DIRS.map(d => `${d}/`)],
    };
    for (const [runtime, r] of Object.entries(RECORD.runtimes)) {
      const top = r.created.relocated.filter(n => !n.replace(/\/$/, '').includes('/'));
      const seen = [...top, ...Object.entries(r.files).filter(([, at]) => at.includes('relocated')).map(([name]) => name)];
      for (const name of seen.filter(n => NAMED[runtime].includes(n))) {
        assert.ok(joined(ROW[runtime]).includes(name), `${name} is joined under ${r.variable}`);
      }
    }
  });

  test('each variable adds a row with what it joins, and only a folder it names', () => {
    assert.deepStrictEqual(hook.relocatedRuntimeHomes({ CODEX_HOME: '/srv/codex-home' }).map(r => [r.runtime, r.value, r.secrets, r.secretDirs]),
      [['codex', '/srv/codex-home', ['auth.json'], []]]);
    assert.deepStrictEqual(hook.relocatedRuntimeHomes({ CLAUDE_CONFIG_DIR: '/srv/claude-home' }).map(r => [r.runtime, r.value, r.secrets, r.secretDirs]),
      [['claude', '/srv/claude-home', ['.claude.json', '.credentials.json'], ['backups']]]);
    assert.deepStrictEqual(hook.relocatedRuntimeHomes({ CLAUDE_CONFIG_DIR: '/srv/claude-home', CODEX_HOME: '/srv/codex-home' }).map(r => r.runtime), ['claude', 'codex']);
    assert.deepStrictEqual(hook.relocatedRuntimeHomes({ CODEX_HOME: 'codex-home', CLAUDE_CONFIG_DIR: '' }), [], 'a value that names no folder adds nothing');
  });
});

describe('the capture\'s own helpers', () => {
  test('a run folder is made new, listed without following links, and removed', () => {
    const run = createRunRoot();
    try {
      const dirs = caseFolders(run, 'case');
      fs.mkdirSync(path.join(dirs.relocated, 'backups'));
      fs.writeFileSync(path.join(dirs.relocated, 'backups', '.claude.json.backup.1700000000000'), '{}');
      fs.symlinkSync(os.tmpdir(), path.join(dirs.relocated, 'away'));
      assert.deepStrictEqual(listTree(dirs.relocated, s => s.replace(/\d{10,}/g, '<time>')), ['away', 'backups/', 'backups/.claude.json.backup.<time>']);
    } finally { removeRunRoot(run); }
    assert.strictEqual(fs.existsSync(run), false);
  });

  test('a folder name made new for each run is written as a placeholder', () => {
    // Codex makes `tmp/arg0/codex-arg0<six random characters>/` on each run.
    assert.strictEqual(scrubRunNames('tmp/arg0/codex-arg0WJNIvk/'), 'tmp/arg0/codex-arg0<id>/');
    assert.strictEqual(scrubRunNames('tmp/arg0/codex-arg0a1B2c3/apply_patch'), 'tmp/arg0/codex-arg0<id>/apply_patch');
    // And a name that is the same on every run is kept.
    for (const name of ['tmp/arg0/', 'log/codex-login.log', 'auth.json', 'backups/.claude.json.backup.<time>']) assert.strictEqual(scrubRunNames(name), name);
    // The scrub a case lists its folders with writes it so.
    const run = createRunRoot();
    try {
      const dirs = caseFolders(run, 'case');
      fs.mkdirSync(path.join(dirs.relocated, 'tmp', 'arg0', 'codex-arg0Zq9xY1'), { recursive: true });
      fs.writeFileSync(path.join(dirs.relocated, 'tmp', 'arg0', 'codex-arg0Zq9xY1', '.lock'), '');
      assert.deepStrictEqual(listTree(dirs.relocated, scrubber(dirs)), ['tmp/', 'tmp/arg0/', 'tmp/arg0/codex-arg0<id>/', 'tmp/arg0/codex-arg0<id>/.lock']);
    } finally { removeRunRoot(run); }
  });

  test('the leak check finds a home path, a temp path and a dash', () => {
    assert.ok(leaks(`at ${os.homedir()}/x`).length > 0);
    assert.ok(leaks('/home/someone/x').length > 0);
    assert.ok(leaks('/var/folders/ab/x').length > 0);
    assert.ok(leaks('a \u2014 b').length > 0);
    assert.deepStrictEqual(leaks('backups/.claude.json.backup.<time>'), []);
  });
});
