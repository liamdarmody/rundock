'use strict';
// The stored list of folders a workspace's agents work in.
//
// This module stores and renders; it decides nothing about permissions. So the
// tests here are about the list being exactly what was named, and about the two
// inputs that would make the rendered environment value mean something OTHER
// than what the list says, because that is the only way a storage bug becomes a
// boundary bug.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

const fs = require('fs');
const wf = require('../../lib/workspace/working-folders.js');
const hook = require('../../scripts/permission-hook.js');
const config = require('../../lib/config.js');
const claudeRuntime = require('../../lib/runtime/claude.js');

const HOME = path.join(path.sep, 'Users', 'someone');

describe('one folder, as it will be stored', () => {
  test('a home-relative path is expanded, and a bare tilde is the home folder itself', () => {
    assert.strictEqual(wf.normalizeOne('~/Projects', HOME), path.join(HOME, 'Projects'));
    assert.strictEqual(wf.normalizeOne('~', HOME), HOME);
  });

  test('trailing separators and redundant segments are removed, so one folder has one spelling', () => {
    const projects = path.join(HOME, 'Projects');
    for (const spelling of [`${projects}${path.sep}`, path.join(projects, 'alchemist', '..'), `  ${projects}  `]) {
      assert.strictEqual(wf.normalizeOne(spelling, HOME), projects, `${spelling} is the same folder`);
    }
  });

  test('a relative path is refused, because it would mean a different folder depending on who asked', () => {
    for (const bad of ['Projects', './Projects', '', '   ', null, undefined, 42]) {
      assert.strictEqual(wf.normalizeOne(bad, HOME), null, `${String(bad)} cannot be stored`);
    }
  });

  test('a folder whose name contains the list separator is refused, not stored and split later', () => {
    // THE ONE STORAGE BUG THAT WOULD WIDEN THE BOUNDARY. The environment value
    // is a single string joined by the platform's path delimiter. A stored
    // folder containing that delimiter is split back into two SHORTER paths on
    // the other side, and a shorter path covers more than the one that was
    // named. Legal on POSIX, so refused here rather than corrupted downstream.
    const nasty = path.join(HOME, `weird${path.delimiter}name`);
    assert.strictEqual(wf.normalizeOne(nasty, HOME), null,
      'a name carrying the separator cannot survive the round trip, so it is never stored');
  });

  test('the filesystem root is refused, because it is the absence of a boundary rather than one', () => {
    assert.strictEqual(wf.normalizeOne(path.parse(path.resolve(HOME)).root, HOME), null);
  });
});

describe('the list a person reads matches what is actually in force', () => {
  test('a child of a named parent is KEPT, because this file answers no containment question', () => {
    // The store performs no prefix comparison at all. Collapsing a child into
    // its parent would make this the second place answering "is this path
    // inside that one", and the hook is the first. They disagreed the moment
    // both existed: the hook folds case by the host filesystem, this folded by
    // the server platform, and the client's hint folded none, so on macOS a
    // path typed `~/projects/x` under a named `~/Projects` was accepted, was
    // collapsed away here, and its row simply never appeared.
    //
    // Nothing is lost. The hook covers the child either way, so a redundant row
    // is untidy and never wrong, and the interface discourages one as it is
    // typed rather than deleting it afterwards.
    const parent = path.join(HOME, 'Projects');
    const child = path.join(parent, 'alchemist');
    assert.deepStrictEqual(wf.normalizeWorkingFolders([parent, child], HOME), [parent, child]);
    assert.deepStrictEqual(wf.normalizeWorkingFolders([child, parent], HOME), [child, parent],
      'and the order is the one that was given, not one this file chose');
  });

  test('a sibling whose name merely starts with another is kept, as is everything else', () => {
    const projects = path.join(HOME, 'Projects');
    const lookalike = path.join(HOME, 'Projects-old');
    assert.deepStrictEqual(
      wf.normalizeWorkingFolders([projects, lookalike], HOME),
      [projects, lookalike]);
  });

  test('duplicates collapse, and unstorable entries fall out without taking the rest with them', () => {
    const projects = path.join(HOME, 'Projects');
    assert.deepStrictEqual(
      wf.normalizeWorkingFolders([projects, `${projects}${path.sep}`, 'relative', '', projects], HOME),
      [projects]);
  });

  test('a folder that no longer exists is KEPT, because a setting that quietly edits itself is not one', () => {
    const gone = path.join(HOME, 'a-folder-that-was-deleted');
    assert.deepStrictEqual(wf.normalizeWorkingFolders([gone], HOME), [gone],
      'existence is a thing the interface reports, never a reason to drop a row a person added');
  });

  test('anything that is not a list is an empty list, never a throw', () => {
    for (const bad of [null, undefined, 'string', 7, {}]) {
      assert.deepStrictEqual(wf.normalizeWorkingFolders(bad, HOME), []);
    }
  });
});

describe('the value an agent is spawned with', () => {
  test('the folders are joined by the platform separator, and an empty list is an empty string', () => {
    const a = path.join(HOME, 'Projects');
    const b = path.join(HOME, 'Claude');
    assert.strictEqual(wf.workingFoldersEnv([a, b]), `${a}${path.delimiter}${b}`);
    assert.strictEqual(wf.workingFoldersEnv([]), '',
      'no folders named is an empty value, which the hook reads as no extra folders at all');
  });

  test('the folders are joined with the platform delimiter, and nothing else is added', () => {
    // WHAT THIS FILE CAN HONESTLY PROVE, and no more. It renders a string; it
    // does not read one. An earlier version split the value here and called
    // that a round trip with the hook, which proved only that this file agrees
    // with itself. The real contract, that the string this produces is the
    // string the hook process parses back into separate folders, is asserted
    // where both halves actually run, in the boundary integration suite, with
    // two folders in the value so a working split is distinguishable from none.
    const named = [path.join(HOME, 'Projects'), path.join(HOME, 'Claude')];
    assert.strictEqual(wf.workingFoldersEnv(named), named.join(path.delimiter));
  });
});

describe('the spawn env, which is the only thing that makes any of this reach an agent', () => {
  test('the stored list reaches RUNDOCK_EXTRA_DIRS, and a removal reaches the next spawn with no restart', () => {
    // THE ONE LINE THE WHOLE CARD RESTS ON, and it had no test: the original
    // defect was precisely this wiring being absent, so deleting it would have
    // turned nothing red. Driven through the real store and the real spawn-env
    // builder rather than by calling workingFoldersEnv with an explicit list,
    // because the explicit-list call cannot fail the way the wiring can.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-spawn-ws-'));
    fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
    const original = config.getWorkspace();
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-spawn-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-spawn-b-'));
    try {
      config.setWorkspace(dir);
      claudeRuntime.wireClaudeRuntimeDeps({ getActualPort: () => 0 });

      // WHAT THE PERSON CHOSE, PLUS WHAT RUNDOCK NAMES FOR THEM. The runtime's
      // own scratch root is named on every workspace's behalf: an agent that
      // hardcodes /tmp instead of the redirected temp path would otherwise
      // raise an approval card on every read of a file it wrote itself, and no
      // grant can answer a shell crossing. Asserted as a set rather than a
      // string so this test states the contract it means: the stored folders
      // all reach the agent, and removals take effect immediately.
      const dirsIn = () => (claudeRuntime.getSpawnEnv().RUNDOCK_EXTRA_DIRS || '')
        .split(path.delimiter).filter(Boolean);
      const builtin = wf.builtinWorkingFolders();

      assert.deepStrictEqual(dirsIn(), builtin,
        'with nothing stored, an agent is born with exactly what Rundock names');

      wf.writeWorkingFolders([a, b]);
      assert.deepStrictEqual(dirsIn(), [...[a, b].map(p => path.resolve(p)), ...builtin],
        'the stored folders are what an agent is born with, in order, ahead of '
        + 'the built-in one');

      // The value is read at every spawn, so the very next call reflects the
      // change with nothing reloaded and nothing restarted.
      wf.writeWorkingFolders([a]);
      assert.deepStrictEqual(dirsIn(), [path.resolve(a), ...builtin],
        'a removal reaches the next agent immediately');
      assert.ok(!dirsIn().includes(path.resolve(b)),
        'and the removed folder is genuinely gone, not merely reordered');
    } finally {
      config.setWorkspace(original);
      for (const d of [dir, a, b]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
