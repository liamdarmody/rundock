// Tests for the judgement half of the desktop profile override run
// (test/electron/user-data-entrypoint.cjs). The run launches the shipped
// entrypoint and collects what happened; these tests prove that what it
// collects is read the right way, so a green run means what it says:
// - the environment it launches in never inherits a switch that changes the
//   profile;
// - the default profile location counts as inside the throwaway HOME only
//   when their real paths say so, so a symlinked temporary folder spelt two
//   ways is inside and a genuinely outside path is refused;
// - the default profile location is snapshotted by name, size and mtime,
//   recursively, without opening a file, and any difference is named by its
//   relative entry name;
// - a startup log is read for the lines that mean a window or the server;
// - each expectation that does not hold is named, and one that holds is not.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const entry = require('../helpers/user-data-entrypoint.js');

const HOME = path.join(path.sep, 'scratch', 'home');
const WS = path.join(path.sep, 'scratch', 'ws');
const PROFILE = path.join(path.sep, 'scratch', 'profile');

describe('the launch environment', () => {
  const base = { PATH: '/bin', RUNDOCK_SMOKE_TEST: '1', RUNDOCK_ELECTRON: '1', ELECTRON_RUN_AS_NODE: '1', RUNDOCK_USER_DATA_DIR: '/elsewhere', CFFIXED_USER_HOME: '/elsewhere', XDG_CONFIG_HOME: '/elsewhere' };

  test('every home the platform reads points at the throwaway HOME', () => {
    const env = entry.launchEnv({ home: HOME, ws: WS, userData: PROFILE }, base);
    assert.strictEqual(env.HOME, HOME);
    assert.strictEqual(env.CFFIXED_USER_HOME, HOME);
    assert.strictEqual(env.XDG_CONFIG_HOME, path.join(HOME, '.config'));
    assert.strictEqual(env.WORKSPACE, WS);
    assert.strictEqual(env.PATH, '/bin');
  });

  test('the override is exactly the value given, relative or absolute', () => {
    assert.strictEqual(entry.launchEnv({ home: HOME, ws: WS, userData: PROFILE }, base).RUNDOCK_USER_DATA_DIR, PROFILE);
    assert.strictEqual(entry.launchEnv({ home: HOME, ws: WS, userData: entry.RELATIVE_VALUE }, base).RUNDOCK_USER_DATA_DIR, entry.RELATIVE_VALUE);
  });

  test('nothing that would change the profile is inherited from whoever runs it', () => {
    const env = entry.launchEnv({ home: HOME, ws: WS, userData: PROFILE }, base);
    assert.strictEqual(env.RUNDOCK_SMOKE_TEST, undefined, 'the packaged-boot switch picks its own profile');
    assert.strictEqual(env.RUNDOCK_ELECTRON, undefined);
    assert.strictEqual(env.ELECTRON_RUN_AS_NODE, undefined, 'Electron would run as plain Node');
  });

  test('the relative value is relative', () => {
    assert.ok(!path.isAbsolute(entry.RELATIVE_VALUE));
  });
});

describe('where the single-instance lock is kept', () => {
  test('a named file in the profile on macOS and Linux, a lockfile on Windows', () => {
    assert.strictEqual(entry.lockName('darwin'), 'SingletonLock');
    assert.strictEqual(entry.lockName('linux'), 'SingletonLock');
    assert.strictEqual(entry.lockName('win32'), 'lockfile');
  });
});

describe('a folder inside another', () => {
  test('the folder itself and anything below it are inside; a sibling with the same prefix is not', () => {
    assert.ok(entry.insideFolder(HOME, HOME));
    assert.ok(entry.insideFolder(path.join(HOME, 'Library', 'Application Support'), HOME));
    assert.ok(!entry.insideFolder(`${HOME}-other`, HOME));
    assert.ok(!entry.insideFolder(path.join(path.sep, 'Users', 'someone'), HOME));
  });
});

describe('a location inside the throwaway HOME, by real path', () => {
  function scratch(t) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'userdata-real-')));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  // A /tmp versus /private/tmp style pair: the same folder reached through a
  // symlink, and by its real path.
  function symlinkedPair(t) {
    const root = scratch(t);
    const real = path.join(root, 'private', 'tmp');
    fs.mkdirSync(real, { recursive: true });
    const alias = path.join(root, 'tmp');
    fs.symlinkSync(real, alias);
    const home = path.join(real, 'home');
    fs.mkdirSync(home);
    return { root, real, alias, home };
  }

  test('a location spelt through a symlink, not yet created, is inside the HOME its real path is in', (t) => {
    const { alias, home } = symlinkedPair(t);
    const appData = path.join(alias, 'home', 'Library', 'Application Support');
    assert.ok(!entry.insideFolder(appData, home), 'the plain string comparison reads it as outside');
    assert.strictEqual(entry.realInside(appData, home), path.join(home, 'Library', 'Application Support'));
  });

  test('a HOME spelt through the symlink holds a location spelt by its real path', (t) => {
    const { alias, home } = symlinkedPair(t);
    const appData = path.join(home, 'Library', 'Application Support');
    assert.strictEqual(entry.realInside(appData, path.join(alias, 'home')), appData);
  });

  test('a location genuinely outside the HOME is refused', (t) => {
    const { root, home } = symlinkedPair(t);
    assert.strictEqual(entry.realInside(path.join(root, 'elsewhere', 'Library', 'Application Support'), home), null);
    assert.strictEqual(entry.realInside(path.join(path.sep, 'Users', 'someone', 'Library', 'Application Support'), home), null);
    assert.strictEqual(entry.realInside(`${home}-other`, home), null);
  });

  test('a symlink inside the HOME that points out of it is refused', (t) => {
    const { root, home } = symlinkedPair(t);
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(home, 'Library'));
    assert.strictEqual(entry.realInside(path.join(home, 'Library', 'Application Support'), home), null);
  });

  test('no answer, or a relative one, is refused', (t) => {
    const { home } = symlinkedPair(t);
    assert.strictEqual(entry.realInside(null, home), null);
    assert.strictEqual(entry.realInside('Library/Application Support', home), null);
  });
});

describe('reading the startup log', () => {
  const refusal = '[Electron] RUNDOCK_USER_DATA_DIR must be an absolute path, got "relative-profile". Not starting.\n';

  test('a refusal and nothing else is read as a refusal, with no window and no server', () => {
    assert.deepStrictEqual(entry.startupSeen(refusal), { refusal: true, ready: false, window: false, server: false });
  });

  test('the main window, the first-run wizard and the server are each noticed', () => {
    assert.strictEqual(entry.startupSeen('[Electron] App ready\n').ready, true);
    assert.strictEqual(entry.startupSeen('[Electron] Loading http://localhost:5123\n').window, true);
    assert.strictEqual(entry.startupSeen('[Electron] Showing first-run wizard (Claude missing or not signed in)\n').window, true);
    assert.strictEqual(entry.startupSeen('[Electron] Starting server...\n').server, true);
    assert.strictEqual(entry.startupSeen('[Electron] Server running on port: 5123\n').server, true);
  });
});

describe('judging the absolute case', () => {
  const good = { profile: PROFILE, userData: PROFILE, lockInProfile: true, storageInProfile: true, defaultChanges: [], windowError: null };

  test('everything held: no failure', () => {
    assert.deepStrictEqual(entry.judgeAbsolute(good), []);
  });

  test('the app on any other profile is named, even one that differs only by a trailing separator', () => {
    assert.deepStrictEqual(entry.judgeAbsolute({ ...good, userData: path.join(HOME, 'Library', 'Application Support', 'rundock') }), [entry.FAIL.absoluteUserData]);
    assert.deepStrictEqual(entry.judgeAbsolute({ ...good, userData: PROFILE + path.sep }), [entry.FAIL.absoluteUserData]);
    assert.deepStrictEqual(entry.judgeAbsolute({ ...good, userData: null }), [entry.FAIL.absoluteUserData]);
  });

  test('each missing piece of profile state is named on its own', () => {
    assert.deepStrictEqual(entry.judgeAbsolute({ ...good, lockInProfile: false }), [entry.FAIL.absoluteLock]);
    assert.deepStrictEqual(entry.judgeAbsolute({ ...good, storageInProfile: false }), [entry.FAIL.absoluteStorage]);
    assert.deepStrictEqual(entry.judgeAbsolute({ ...good, defaultChanges: ['added: Local Storage'] }), [`${entry.FAIL.absoluteDefault} (added: Local Storage)`]);
  });

  test('a window that never came is named with its reason', () => {
    const got = entry.judgeAbsolute({ ...good, windowError: 'the app opened no main window', storageInProfile: false });
    assert.deepStrictEqual(got, [`${entry.FAIL.absoluteWindow} (the app opened no main window)`, entry.FAIL.absoluteStorage]);
  });
});

describe('judging the relative case', () => {
  const refusal = '[Electron] RUNDOCK_USER_DATA_DIR must be an absolute path, got "relative-profile". Not starting.\n';
  const good = { exited: true, code: 1, output: refusal, relativeExists: false, defaultChanges: [] };

  test('everything held: no failure', () => {
    assert.deepStrictEqual(entry.judgeRelative(good), []);
  });

  test('an exit of 0, a signal, or no exit at all is not a refusal', () => {
    assert.deepStrictEqual(entry.judgeRelative({ ...good, code: 0 }), [entry.FAIL.relativeExit]);
    assert.deepStrictEqual(entry.judgeRelative({ ...good, code: null }), [entry.FAIL.relativeExit]);
    assert.deepStrictEqual(entry.judgeRelative({ ...good, exited: false, code: null }), [entry.FAIL.relativeExit]);
  });

  test('an app that carries on past the refusal is named for every step it took', () => {
    const output = `${refusal}[Electron] App ready\n[Electron] Showing first-run wizard (Claude missing or not signed in)\n`;
    assert.deepStrictEqual(entry.judgeRelative({ ...good, exited: false, code: null, output, defaultChanges: ['the folder appeared'] }),
      [entry.FAIL.relativeExit, entry.FAIL.relativeWindow, `${entry.FAIL.relativeDefault} (the folder appeared)`]);
    const served = `${refusal}[Electron] App ready\n[Electron] Starting server...\n[Electron] Loading http://localhost:5123\n`;
    assert.deepStrictEqual(entry.judgeRelative({ ...good, output: served }), [entry.FAIL.relativeWindow, entry.FAIL.relativeServer]);
  });

  test('an exit that does not name the refusal is named', () => {
    assert.deepStrictEqual(entry.judgeRelative({ ...good, output: '' }), [entry.FAIL.relativeReason]);
  });

  test('profile state under the working directory or the default location is named', () => {
    assert.deepStrictEqual(entry.judgeRelative({ ...good, relativeExists: true }), [entry.FAIL.relativeFolder]);
    assert.deepStrictEqual(entry.judgeRelative({ ...good, defaultChanges: ['changed: Preferences', 'removed: Cookies'] }),
      [`${entry.FAIL.relativeDefault} (changed: Preferences; removed: Cookies)`]);
  });

  test('every failure name is distinct, so the mutation harness can tell them apart', () => {
    const names = Object.values(entry.FAIL);
    assert.strictEqual(new Set(names).size, names.length);
  });
});


describe('snapshotting the default profile location', () => {
  function scratch(t) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'userdata-snap-')));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  // Every fs call the snapshot may make, and nothing that opens a file.
  function statOnly(calls) {
    return {
      lstatSync: (...a) => { calls.push('lstat'); return fs.lstatSync(...a); },
      readdirSync: (...a) => { calls.push('readdir'); return fs.readdirSync(...a); },
    };
  }

  test('a folder that does not exist is recorded as absent', (t) => {
    const dir = path.join(scratch(t), 'missing');
    assert.deepStrictEqual(entry.snapshotFolder(dir), { exists: false, entries: {} });
  });

  test('every entry is recorded by its relative name, type, size and mtime, recursively', (t) => {
    const dir = scratch(t);
    fs.writeFileSync(path.join(dir, 'Preferences'), 'abc');
    fs.mkdirSync(path.join(dir, 'Local Storage', 'leveldb'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Local Storage', 'leveldb', 'LOG'), 'hello');
    fs.symlinkSync('Preferences', path.join(dir, 'link'));
    const snap = entry.snapshotFolder(dir);
    assert.strictEqual(snap.exists, true);
    assert.deepStrictEqual(Object.keys(snap.entries).sort(),
      ['Local Storage', path.join('Local Storage', 'leveldb'), path.join('Local Storage', 'leveldb', 'LOG'), 'Preferences', 'link']);
    assert.strictEqual(snap.entries.Preferences.type, 'file');
    assert.strictEqual(snap.entries.Preferences.size, 3);
    assert.strictEqual(typeof snap.entries.Preferences.mtimeMs, 'number');
    assert.strictEqual(snap.entries[path.join('Local Storage', 'leveldb', 'LOG')].size, 5);
    assert.strictEqual(snap.entries['Local Storage'].type, 'dir');
    assert.strictEqual(snap.entries.link.type, 'symlink', 'a link is recorded, never followed');
  });

  test('no entry name carries the absolute path of the folder', (t) => {
    const dir = scratch(t);
    fs.writeFileSync(path.join(dir, 'a'), '');
    const snap = entry.snapshotFolder(dir);
    assert.ok(!JSON.stringify(snap).includes(dir));
  });

  test('the snapshot only lists and stats: it never opens, reads or writes a file', (t) => {
    const dir = scratch(t);
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'f'), 'x');
    const calls = [];
    entry.snapshotFolder(dir, statOnly(calls));
    assert.ok(calls.length > 0);
    assert.deepStrictEqual([...new Set(calls)].sort(), ['lstat', 'readdir']);
  });

  test('a folder that cannot be listed is an error, never an empty snapshot', () => {
    const refusing = {
      lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false, size: 0, mtimeMs: 0 }),
      readdirSync: () => { const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; },
    };
    assert.throws(() => entry.snapshotFolder(path.join(path.sep, 'nowhere'), refusing), /EPERM/);
  });
});

describe('comparing two snapshots', () => {
  const at = (entries, exists = true) => ({ exists, entries });
  const file = (size, mtimeMs) => ({ type: 'file', size, mtimeMs });

  test('identical snapshots, or a folder absent both times, differ in nothing', () => {
    assert.deepStrictEqual(entry.snapshotDiff(at({ a: file(1, 1) }), at({ a: file(1, 1) })), []);
    assert.deepStrictEqual(entry.snapshotDiff(at({}, false), at({}, false)), []);
  });

  test('a folder that appears or disappears is named', () => {
    assert.deepStrictEqual(entry.snapshotDiff(at({}, false), at({ a: file(1, 1) })), ['the folder appeared']);
    assert.deepStrictEqual(entry.snapshotDiff(at({ a: file(1, 1) }), at({}, false)), ['the folder disappeared']);
  });

  test('each added, removed or changed entry is named by its relative name, in order', () => {
    const before = at({ keep: file(1, 1), gone: file(1, 1), grown: file(1, 1), touched: file(1, 1), [path.join('d', 'x')]: file(2, 2) });
    const after = at({ keep: file(1, 1), grown: file(9, 1), touched: file(1, 5), [path.join('d', 'x')]: file(2, 2), [path.join('d', 'new')]: file(0, 3) });
    assert.deepStrictEqual(entry.snapshotDiff(before, after),
      [`added: ${path.join('d', 'new')}`, 'removed: gone', 'changed: grown', 'changed: touched']);
  });

  test('an entry that changes type is named as changed', () => {
    assert.deepStrictEqual(entry.snapshotDiff(at({ a: file(0, 1) }), at({ a: { type: 'dir', size: 0, mtimeMs: 1 } })), ['changed: a']);
  });
});
