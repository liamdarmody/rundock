// Tests for reading CLAUDE_CONFIG_DIR from the login shell
// (electron/shell-config-dir.js).
//
// The packaged app opened from the Finder starts without the login shell's
// environment. When a sign-in check fails, the app may run the person's login
// shell once to read CLAUDE_CONFIG_DIR, and takes it only when it names the
// default folder. The properties these tests defend: the shell is run only
// where it can help, only one value ever crosses, and that value is taken only
// when it resolves to <home>/.claude.
//
// No test runs the person's real shell or profile, or reads their home folder:
// each builds a temporary home with its own .claude.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('../helpers/workspace.js');
const scd = require('../../electron/shell-config-dir.js');

const { mayRun, gate } = scd;

// A temporary home with its own .claude, and somewhere else to point at.
function tempHome() {
  const home = makeTempDir('shell-config-home-');
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir);
  const elsewhere = path.join(home, 'elsewhere');
  fs.mkdirSync(elsewhere);
  return { home, claudeDir, elsewhere };
}

const SYMLINK_SKIP = process.platform === 'win32'
  ? 'making a directory link on Windows needs a privilege the CI runner does not have'
  : false;

describe('where the read may run', () => {
  test('the packaged app on macOS may run it', () => {
    assert.strictEqual(mayRun({ isPackaged: true, platform: 'darwin', env: {} }), true);
  });

  test('a missing environment is treated as no smoke test', () => {
    assert.strictEqual(mayRun({ isPackaged: true, platform: 'darwin' }), true);
  });

  test('a dev run never runs it', () => {
    assert.strictEqual(mayRun({ isPackaged: false, platform: 'darwin', env: {} }), false);
  });

  test('Linux never runs it', () => {
    assert.strictEqual(mayRun({ isPackaged: true, platform: 'linux', env: {} }), false);
  });

  test('Windows never runs it', () => {
    assert.strictEqual(mayRun({ isPackaged: true, platform: 'win32', env: {} }), false);
  });

  test('a smoke test never runs it', () => {
    assert.strictEqual(mayRun({ isPackaged: true, platform: 'darwin', env: { RUNDOCK_SMOKE_TEST: '1' } }), false);
  });
});

describe('the gate takes only the default folder', () => {
  test('the default folder is taken, as written', () => {
    const { home, claudeDir } = tempHome();
    assert.strictEqual(gate(claudeDir, { home, platform: process.platform }), claudeDir);
  });

  test('the default folder written with a trailing separator is taken, as written', () => {
    const { home, claudeDir } = tempHome();
    const written = claudeDir + path.sep;
    assert.strictEqual(gate(written, { home, platform: process.platform }), written);
  });

  test('a relative path is dropped', () => {
    const { home } = tempHome();
    assert.strictEqual(gate('.claude', { home, platform: process.platform }), null);
    assert.strictEqual(gate(path.join('..', path.basename(home), '.claude'), { home, platform: process.platform }), null);
  });

  test('a folder that does not exist is dropped', () => {
    const { home } = tempHome();
    assert.strictEqual(gate(path.join(home, 'missing'), { home, platform: process.platform }), null);
  });

  test('a file is dropped, even one at the default path', () => {
    const home = makeTempDir('shell-config-home-');
    const file = path.join(home, '.claude');
    fs.writeFileSync(file, 'not a folder');
    assert.strictEqual(gate(file, { home, platform: process.platform }), null);
  });

  test('another folder is dropped', () => {
    const { home, elsewhere } = tempHome();
    assert.strictEqual(gate(elsewhere, { home, platform: process.platform }), null);
  });

  test('a link to another folder is dropped', { skip: SYMLINK_SKIP }, () => {
    const { home, elsewhere } = tempHome();
    const link = path.join(home, 'looks-like-claude');
    fs.symlinkSync(elsewhere, link, 'dir');
    assert.strictEqual(gate(link, { home, platform: process.platform }), null);
  });

  test('a link that resolves to the default folder is taken, as written', { skip: SYMLINK_SKIP }, () => {
    const { home, claudeDir } = tempHome();
    const link = path.join(home, 'claude-link');
    fs.symlinkSync(claudeDir, link, 'dir');
    assert.strictEqual(gate(link, { home, platform: process.platform }), link);
  });

  test('nothing is taken when the home has no .claude', () => {
    const home = makeTempDir('shell-config-home-');
    const other = path.join(home, 'other');
    fs.mkdirSync(other);
    assert.strictEqual(gate(other, { home, platform: process.platform }), null);
    assert.strictEqual(gate(path.join(home, '.claude'), { home, platform: process.platform }), null);
  });

  test('anything but a string is dropped', () => {
    const { home } = tempHome();
    for (const value of [null, undefined, 42, ['x'], { CLAUDE_CONFIG_DIR: path.join(home, '.claude') }, '']) {
      assert.strictEqual(gate(value, { home, platform: process.platform }), null);
    }
  });

  describe('case', () => {
    const real = scd.deps.fs;
    // A disk that keeps the case it is given, as macOS's usually does while
    // ignoring it: the two spellings name one existing folder.
    const caseKeeping = {
      statSync: () => ({ isDirectory: () => true }),
      realpathSync: (p) => p,
    };
    const home = path.join(path.sep, 'home-x');

    test('on macOS the comparison ignores case', () => {
      scd.deps.fs = caseKeeping;
      try {
        const written = path.join(home, '.Claude');
        assert.strictEqual(gate(written, { home, platform: 'darwin' }), written);
      } finally {
        scd.deps.fs = real;
      }
    });

    test('elsewhere the comparison keeps case', () => {
      scd.deps.fs = caseKeeping;
      try {
        assert.strictEqual(gate(path.join(home, '.Claude'), { home, platform: 'linux' }), null);
      } finally {
        scd.deps.fs = real;
      }
    });
  });
});
