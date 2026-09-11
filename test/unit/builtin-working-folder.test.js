'use strict';
// THE RUNTIME'S OWN SCRATCH IS NAMED FOR THE PERSON.
//
// Rundock points TMPDIR, TEMP and TMP at a folder inside the workspace, so an
// agent using the platform temp path never crosses the boundary. An agent that
// hardcodes /tmp does cross it, and then every read of the file it wrote
// seconds earlier raises an approval card: EVERY read, because a shell command
// reaching outside is deliberately not grantable (classifyShellAccess returns
// grantable: false, so that a folder grant can never answer "may this command
// run"). Observed in real use as eight identical cards in a row.
//
// A person who clicks through eight meaningless approvals has stopped reading
// them, and the ninth is the one that matters. That is the reason this is
// worth a small widening of the boundary, and the reason it must stay visible
// rather than becoming a silent default nobody remembers.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const wf = require(path.join(ROOT, 'lib', 'workspace', 'working-folders.js'));

describe('what Rundock names on the workspace\'s behalf', () => {
  test('the runtime scratch root is named, resolved as the boundary sees it', () => {
    const builtin = wf.builtinWorkingFolders();
    if (process.platform === 'win32') {
      assert.deepStrictEqual(builtin, [],
        'the scratch location on Windows is unverified; naming a wrong path '
        + 'would widen nothing while looking as though it had');
      return;
    }
    assert.strictEqual(builtin.length, 1);
    assert.match(builtin[0], /tmp[\\/]claude$/);
    assert.ok(path.isAbsolute(builtin[0]), 'absolute, so it cannot resolve against a cwd');
  });

  test('it reaches an agent through the same channel a named folder does', () => {
    const env = wf.workingFoldersEnv(wf.effectiveWorkingFolders([]));
    if (process.platform === 'win32') return;
    assert.ok(env.split(path.delimiter).includes(wf.builtinWorkingFolders()[0]),
      'an agent spawned with no user folders still gets the scratch root, or '
      + 'the storm this exists to stop continues');
  });

  test('and is kept out of the list the person edits', () => {
    // The stored list is what they chose. Mixing the two makes a built-in look
    // removable, and a removal look as though it failed.
    const stored = wf.readWorkingFolders();
    for (const b of wf.builtinWorkingFolders()) {
      assert.ok(!stored.includes(b),
        'a folder Rundock adds must not appear in the stored list, or the next '
        + 'write persists it as though the person had chosen it');
    }
  });

  test('a folder the person already named is not doubled', () => {
    const builtin = wf.builtinWorkingFolders();
    if (!builtin.length) return;
    const eff = wf.effectiveWorkingFolders(builtin);
    assert.strictEqual(eff.filter((d) => d === builtin[0]).length, 1);
  });
});

describe('the boundary actually stops carding for it', () => {
  const hook = require(path.join(ROOT, 'scripts', 'permission-hook.js'));

  test('a shell read of the scratch root is no longer a crossing', () => {
    const builtin = wf.builtinWorkingFolders();
    if (!builtin.length) return;
    const workspace = path.join(ROOT, '.rundock-test-ws');
    const command = `cat ${builtin[0]}/page.html`;
    const before = hook.classifyShellAccess('Bash', { command }, workspace, []);
    const after = hook.classifyShellAccess('Bash', { command }, workspace, builtin);
    assert.ok(before && before.where === 'outside',
      'without the named folder this is a crossing, which is the storm');
    assert.strictEqual(after, null,
      'with it named, the command no longer crosses the boundary at all, so no '
      + 'card is raised and none needs granting');
  });

  test('and the widening reaches no further than that folder', () => {
    const workspace = path.join(ROOT, '.rundock-test-ws');
    const builtin = wf.builtinWorkingFolders();
    if (!builtin.length) return;
    // The point of naming one folder is that it names ONE folder. A change
    // that quietened the storm by exempting the temp root, or anything above
    // it, would quieten every other card with it.
    // A sibling inside the same temp root is the one that matters: it proves
    // the exemption is the named folder and not its parent. (/usr/bin/env and
    // friends are exempt for a different, pre-existing reason: a command names
    // its binary, and that is not a file access.)
    for (const elsewhere of ['/etc/hosts', '/private/tmp/somethingelse/x']) {
      const r = hook.classifyShellAccess('Bash', { command: `cat ${elsewhere}` }, workspace, builtin);
      assert.ok(r && r.where === 'outside',
        `${elsewhere} stopped crossing the boundary, so the widening is broader `
        + 'than the folder it was meant to cover');
    }
  });
});
