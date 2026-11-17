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
// there, and an entry seen there that the registry names under the default
// home is joined.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hook = require('../../scripts/permission-hook.js');
const { leaks, listTree, createRunRoot, caseFolders, removeRunRoot } = require('../../scripts/runtime-home-truth/capture.js');

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

  test('Codex is recorded as not measured, with the reason', () => {
    const x = RECORD.runtimes.codex;
    assert.strictEqual(x.variable, 'CODEX_HOME');
    assert.strictEqual(x.measured, false);
    assert.ok(typeof x.reason === 'string' && x.reason.length > 0);
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

  test('every entry joined under the variable\'s folder was seen there', () => {
    for (const [runtime, row] of Object.entries(ROW)) {
      const r = RECORD.runtimes[runtime];
      for (const name of [...row.secrets, ...row.secretDirs.map(d => `${d}/`)]) {
        assert.strictEqual(r.measured, true, `${runtime}: ${name} is joined, so the runtime was measured`);
        assert.ok((r.files[name] || []).includes('relocated'), `${runtime}: ${name} was seen in the variable's folder`);
      }
    }
  });

  test('every secret seen there that the registry names under the default home is joined', () => {
    const c = RECORD.runtimes.claude;
    const seen = Object.entries(c.files).filter(([, at]) => at.includes('relocated')).map(([name]) => name);
    const named = new Set([...hook.HOME_SECRET_FILES, ...hook.SECRET_RELATIVE_DIRS.map(d => `${d}/`)]);
    for (const name of seen.filter(n => named.has(n))) {
      assert.ok([...ROW.claude.secrets, ...ROW.claude.secretDirs.map(d => `${d}/`)].includes(name), `${name} is joined under CLAUDE_CONFIG_DIR`);
    }
  });

  test('Codex, not measured, joins nothing, so CODEX_HOME adds no row', () => {
    assert.deepStrictEqual(ROW.codex.secrets, []);
    assert.deepStrictEqual(ROW.codex.secretDirs, []);
    assert.deepStrictEqual(hook.relocatedRuntimeHomes({ CODEX_HOME: '/srv/codex-home' }), []);
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

  test('the leak check finds a home path, a temp path and a dash', () => {
    assert.ok(leaks(`at ${os.homedir()}/x`).length > 0);
    assert.ok(leaks('/home/someone/x').length > 0);
    assert.ok(leaks('/var/folders/ab/x').length > 0);
    assert.ok(leaks('a \u2014 b').length > 0);
    assert.deepStrictEqual(leaks('backups/.claude.json.backup.<time>'), []);
  });
});
