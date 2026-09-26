// Tests for where the desktop app keeps its own state (electron/user-data.js).
//
// RUNDOCK_USER_DATA_DIR starts the desktop app on a profile of its own. The
// property these tests defend: a value that is set but unusable is refused,
// never ignored. Whoever sets it expects to be kept away from the real
// profile; falling back to it would take the real app's single-instance lock
// and write into its state.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { resolveUserData } = require('../../electron/user-data.js');

const TMP = path.join(path.sep, 'tmp-root');

describe('no override set', () => {
  test('an absent variable keeps the default profile', () => {
    assert.deepStrictEqual(resolveUserData({}, TMP), { kind: 'none' });
  });

  test('whitespace only keeps the default profile', () => {
    assert.deepStrictEqual(resolveUserData({ RUNDOCK_USER_DATA_DIR: '  ' }, TMP), { kind: 'none' });
  });

  test('a missing env object keeps the default profile', () => {
    assert.deepStrictEqual(resolveUserData(undefined, TMP), { kind: 'none' });
  });
});

describe('an override that can be used', () => {
  test('an absolute folder becomes the profile', () => {
    const dir = path.join(path.sep, 'somewhere', 'profile');
    assert.deepStrictEqual(resolveUserData({ RUNDOCK_USER_DATA_DIR: ` ${dir} ` }, TMP), { kind: 'path', path: dir });
  });

  test('the packaged-boot check keeps its own disposable profile, whatever else is set', () => {
    const got = resolveUserData({ RUNDOCK_SMOKE_TEST: '1', RUNDOCK_USER_DATA_DIR: path.join(path.sep, 'elsewhere') }, TMP);
    assert.deepStrictEqual(got, { kind: 'path', path: path.join(TMP, 'rundock-smoke-userdata') });
  });
});

describe('an override that cannot be used is refused', () => {
  test('a relative folder is refused with its reason, never read against the working directory', () => {
    const got = resolveUserData({ RUNDOCK_USER_DATA_DIR: 'profile' }, TMP);
    assert.strictEqual(got.kind, 'invalid');
    assert.match(got.reason, /RUNDOCK_USER_DATA_DIR must be an absolute path/);
  });
});

// A quick static check of the wiring only. The behaviour itself is proved on
// the running app by test/electron/user-data-entrypoint.cjs
// (npm run test:user-data:electron).
describe('the desktop entrypoint applies it before anything reads the profile', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'main.js'), 'utf-8');

  test('the profile is resolved and set before the single-instance lock is taken', () => {
    const resolved = main.indexOf('resolveUserData(process.env');
    const set = main.indexOf("app.setPath('userData', userData.path)");
    const lock = main.indexOf('app.requestSingleInstanceLock()');
    assert.ok(resolved > -1 && set > resolved && lock > set, 'resolve, then set, then lock');
  });

  test('a refused value stops the app before it starts', () => {
    assert.match(main, /if \(userData\.kind === 'invalid'\) \{\n[^\n]*\n\s*process\.exit\(1\);/);
  });
});
