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

// The two PowerShell scripts are fixed text: a value reaches them only through
// the child's environment, so nothing a folder holds can become code.
describe('the PowerShell the User PATH is read and written with', () => {
  const scripts = () => {
    const { READ_SCRIPT, WRITE_SCRIPT } = load();
    assert.strictEqual(typeof READ_SCRIPT, 'string', 'the read script is exported');
    assert.strictEqual(typeof WRITE_SCRIPT, 'string', 'the write script is exported');
    return { READ_SCRIPT, WRITE_SCRIPT };
  };
  const write = () => scripts().WRITE_SCRIPT;
  const before = (script, first, second) => {
    const a = script.indexOf(first);
    const b = script.indexOf(second);
    assert.ok(a >= 0, `the script holds ${first}`);
    assert.ok(b >= 0, `the script holds ${second}`);
    return a < b;
  };

  test('the read reads the value as stored, unexpanded, with its kind', () => {
    const { READ_SCRIPT } = scripts();
    assert.ok(READ_SCRIPT.includes("[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')"));
    assert.ok(READ_SCRIPT.includes("GetValue('Path', '', 'DoNotExpandEnvironmentNames')"), 'read raw, never expanded');
    assert.ok(READ_SCRIPT.includes("GetValueKind('Path')"), 'with its kind');
    assert.ok(READ_SCRIPT.includes("$kind = 'Missing'"), 'a value that is not there reads as missing');
  });

  test('each script stops at its first error, so a failure never reads as done', () => {
    const { READ_SCRIPT, WRITE_SCRIPT } = scripts();
    for (const script of [READ_SCRIPT, WRITE_SCRIPT]) assert.ok(script.startsWith("$ErrorActionPreference = 'Stop'; "));
  });

  test('the write reads the value again and writes nothing when it or its kind has changed since', () => {
    const script = write();
    assert.ok(before(script, "GetValue('Path', '', 'DoNotExpandEnvironmentNames')", '$k.SetValue('), 'the value is read again before the write');
    assert.ok(script.includes("if ($kind -cne [string]$env:SETUP_CHECK_PATH_KIND -or $v -cne [string]$env:SETUP_CHECK_PATH_OLD) { [Console]::Out.Write('stale'); exit 0 }"),
      'a kind or value other than the one read, compared exactly, writes nothing');
    assert.ok(before(script, "Write('stale'); exit 0", '$k.SetValue('), 'and that comes before the one write');
    assert.strictEqual(script.split('.SetValue(').length, 2, 'the value is set once, in one call');
  });

  test('the write sets the new value with the kind it is given', () => {
    assert.ok(write().includes("$k.SetValue('Path', [string]$env:SETUP_CHECK_PATH_NEW, [Microsoft.Win32.RegistryValueKind][string]$env:SETUP_CHECK_PATH_WRITE_KIND)"));
  });

  test('a write tells every window the environment changed', () => {
    const script = write();
    assert.ok(script.includes('SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, ' + "'Environment', 2, 5000, [ref]$r)"),
      'WM_SETTINGCHANGE for Environment, to every top-level window, not waiting on one that hangs');
    assert.ok(before(script, '$k.SetValue(', 'SendMessageTimeout(['), 'after the write');
    assert.ok(before(script, 'SendMessageTimeout([', "Write('written')"), 'and before it says written');
  });

  test('the scripts hold no double quote and no line break, so their one argument needs no escaping', () => {
    const { READ_SCRIPT, WRITE_SCRIPT } = scripts();
    for (const script of [READ_SCRIPT, WRITE_SCRIPT]) assert.ok(!/["\r\n]/.test(script));
  });
});
