'use strict';
// The User PATH the desktop's setup check writes on Windows: the merge that
// appends the folder Claude Code was found in, and the PowerShell it runs.
//
// The User PATH is the person's. A merge that drops, reorders, expands or
// retypes an entry damages other programs, so the merge is a pure function
// held to a table, and the scripts are fixed text that the values reach only
// as data.
const { describe, test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MODULE = path.join(__dirname, '..', '..', 'electron', 'setup-check.js');

// Asserted before every use, so with the module missing each test fails on
// this assertion rather than on a thrown require.
function load() {
  let found = null;
  try { found = require.resolve(MODULE); } catch { /* asserted next */ }
  assert.ok(found, 'electron/setup-check.js is there to load');
  return require(MODULE);
}

const ENV = { USERPROFILE: 'C:\\Users\\example', SystemRoot: 'C:\\Windows' };
const FOLDER = 'C:\\Users\\example\\.local\\bin';

describe('the User PATH merge keeps every entry', () => {
  const rows = [
    ['a raw %USERPROFILE% entry that is the folder once expanded is no change',
      '%USERPROFILE%\\.local\\bin;C:\\Windows', null],
    ['a name is expanded whatever its case',
      'C:\\Windows;%userprofile%\\.local\\bin', null],
    ['an entry differing only in case is no change',
      'C:\\Windows;c:\\users\\EXAMPLE\\.LOCAL\\bin', null],
    ['an entry with one trailing backslash is no change',
      'C:\\Windows;C:\\Users\\example\\.local\\bin\\', null],
    ['an empty entry and unexpanded entries are kept byte for byte, and the folder appended',
      '%SystemRoot%\\system32;;%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools',
      '%SystemRoot%\\system32;;%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools;C:\\Users\\example\\.local\\bin'],
    ['a name with no value is left as written, and does not match',
      '%NOWHERE%\\.local\\bin', '%NOWHERE%\\.local\\bin;C:\\Users\\example\\.local\\bin'],
    ['a value ending in ; gets no second separator',
      'C:\\Windows;C:\\Tools;', 'C:\\Windows;C:\\Tools;C:\\Users\\example\\.local\\bin'],
    ['an empty value gives the folder alone', '', FOLDER],
    ['a missing value gives the folder alone', null, FOLDER],
  ];
  for (const [name, raw, expected] of rows) {
    test(name, () => {
      const { mergeUserPath } = load();
      assert.strictEqual(mergeUserPath(raw, FOLDER, ENV), expected);
    });
  }

  test('the merge reads nothing but its arguments', () => {
    const { mergeUserPath } = load();
    const env = { ...ENV };
    assert.strictEqual(mergeUserPath('C:\\Windows', FOLDER, env), `C:\\Windows;${FOLDER}`);
    assert.deepStrictEqual(env, ENV, 'the environment it expands from is left as it was');
  });
});
