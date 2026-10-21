'use strict';
// What the shell check reads in a command that carries code or text for
// another program, and what it leaves alone.
//
// The check reads a command's words for places outside the workspace. Code
// handed to an interpreter is full of words that are not places: a division
// (`int(ms)/1000`), a join on a separator (`'/'.join(parts)`), an escape
// string (`"\n\n"`). Read as paths, each one raised an "outside your
// workspace" card, and a shell card can never be remembered, so an unattended
// run stopped at every one of them. The fixtures here are made up, in the
// shapes those commands took.
//
// The same check is the tripwire for a real read, and on Windows the only
// one, so every rule that quiets a false card sits beside a test proving the
// true card it must keep.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hook = require('../../scripts/permission-hook.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-code-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const home = path.join(root, 'home');
const ws = path.join(home, 'Workspace');
fs.mkdirSync(path.join(ws, '.rundock', 'scratch', 'data'), { recursive: true });
fs.mkdirSync(path.join(ws, '.rundock', 'scratch', 'tools'), { recursive: true });

const MODES = [['Notes', false], ['Code', true]];
const scan = (command, { tool = 'Bash', codeMode = false, workspace = ws, opts = {} } = {}) =>
  hook.classifyShellAccess(tool, { command }, workspace, [], home, false, { codeMode, ...opts });
const places = (command, o) => {
  const r = scan(command, o);
  return r ? r.crossings.map(c => c.path) : [];
};
const real = p => hook.canonicalize(p);

describe('a backslash in a Bash word on a POSIX host is not a Windows separator', () => {
  for (const [mode, codeMode] of MODES) {
    test(`escape strings with more than one escape reach nothing (${mode} mode)`, () => {
      for (const c of [
        "printf '\\n\\n'",
        'printf "\\n== %s: %s" name count',
        "printf '%s\\n## Summary\\n' x",
        "tr -s '\\n\\n' '\\n' < notes.txt",
        "echo 'a\\tb\\tc' | cut -f2",
      ]) {
        assert.deepStrictEqual(places(c, { codeMode }), [], c);
      }
    });
  }

  test('a backslash inside quotes is part of a POSIX file name', () => {
    assert.deepStrictEqual(places("cat 'notes\\draft.md'"), []);
    assert.deepStrictEqual(places('cat "..\\..\\x.md"'), [], 'one file name with backslashes in it, inside the workspace');
  });

  test('an unquoted escape is read the way bash reads it, so the path it spells still cards', () => {
    assert.deepStrictEqual(places('cat \\/etc/hosts'), [real('/etc/hosts')]);
    assert.deepStrictEqual(places('cat ..\\/..\\/secret.txt'), [real(path.join(root, 'secret.txt'))]);
  });

  test('a drive letter or a UNC name is still a Windows path', () => {
    assert.ok(scan('cat C:\\Users\\someone\\notes.txt'), 'a drive letter');
    assert.ok(scan("cp a.md '\\\\server\\share\\a.md'"), 'a UNC name');
  });

  test('PowerShell keeps the backslash as a separator', () => {
    const r = scan('Get-Content ..\\..\\elsewhere\\x.txt', { tool: 'PowerShell' });
    assert.ok(r && r.where === 'outside');
  });

  test('a Windows workspace keeps the Windows reading, for the Bash tool too', () => {
    const winWs = 'C:\\Users\\someone\\ws';
    for (const opts of [{}, { platform: 'win32' }]) {
      const r = scan('cat ..\\..\\elsewhere\\x.txt', { workspace: winWs, opts });
      assert.ok(r && r.where === 'outside', `a backslash climb out of a Windows workspace (${JSON.stringify(opts)})`);
      assert.ok(scan('cat C:\\Users\\someone\\notes.txt', { workspace: winWs, opts }), 'a drive letter elsewhere');
    }
  });
});
