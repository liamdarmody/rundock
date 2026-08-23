'use strict';
// Every caller of the scheduler's starter and stopper, enumerated and pinned
// to the test that drives it.
//
// WHY THIS FILE IS A MANIFEST AND NOT A LIST OF TESTS.
//
// Eight cards tested this scheduler. They proved catch-up, single-flight,
// missed slots, run records, the schedule grammar and DST, and every one of
// them armed the tick by calling startScheduler itself. Not one asked who
// calls it in the product. The answer was one boot path guarded by
// `if (WORKSPACE)`: choosing a workspace at runtime started nothing, and
// stopScheduler had no caller in the product at all. A suite that arms the
// tick itself cannot notice that nobody else does.
//
// This is the same instrument that ended the same loop one layer above, in
// test/unit/routine-editor-doors.test.js and test/unit/routines-view-doors.test.js,
// where four reviews each found a different untested way into the editor. Same
// three parts, applied to a server-side lifecycle rather than to client entry
// points: an enumeration, a check that reads the SOURCE and fails when the
// enumeration and the source disagree, and a reverse check so a row cannot
// name a test nobody wrote.
//
// It carries a second enumeration the editor's did not need. The way this
// defect happened was not a caller going missing, it was a caller never
// existing on a path that sets a workspace. So the workspace-setting paths are
// enumerated too, and the check that binds them is that not one of them can
// reach the workspace root except through the single function that runs the
// lifecycle.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

// ===== THE ENUMERATION =====
//
// Every call to the starter or the stopper anywhere in the product, with the
// surface it belongs to and the test that drives that surface. Adding a call
// means adding a row here, which means naming a test.
const CALLERS = [
  {
    call: 'stopScheduler',
    file: 'server.js',
    fn: 'setWorkspaceRoot',
    surface: 'every workspace change, including leaving one for no workspace at all',
    provenIn: 'test/integration/scheduler-workspace-lifecycle.test.js',
    provenBy: 'a workspace that disappears takes its ticker with it',
  },
  {
    call: 'startScheduler',
    file: 'server.js',
    fn: 'setWorkspaceRoot',
    surface: 'every workspace change that lands on a workspace: chosen, created, or rolled back to',
    provenIn: 'test/integration/scheduler-workspace-lifecycle.test.js',
    provenBy: 'choosing a folder arms the tick, and the routine runs when its time comes',
  },
  {
    call: 'startScheduler',
    file: 'server.js',
    fn: 'startServer',
    surface: 'boot, for a workspace preset in the environment, which never passes through the setter',
    provenIn: 'test/integration/scheduler-boot-lifecycle.test.js',
    provenBy: 'booting with a workspace already set arms the tick, with nobody calling the starter',
  },
];

// Calls left out of the enumeration above, each with the reason. A named
// exclusion is a decision; an unnamed one is how a lifecycle ends up with one
// caller and nobody noticing.
const NOT_ENUMERATED = [
  {
    what: 'the definitions in lib/scheduler.js',
    why: 'a function declaration is not a call. The check below reads them out of the scan by their '
      + 'declaration line rather than by skipping the file, so a genuine call added to the scheduler '
      + 'itself would still have to be listed.',
  },
  {
    what: 'the whole of test/, including the eight suites that arm the tick themselves',
    why: 'those calls are the habit this card exists to correct. They prove what the tick does once it '
      + 'is running, which is shipped and worth keeping, and they say nothing about who arms it. '
      + 'Counting them as callers would let the product have none again and still read as covered.',
  },
  {
    what: 'the destructuring import and the _internal re-export in server.js',
    why: 'both name the functions without calling them. Neither can arm or disarm anything, and the '
      + 'scan only matches a name followed by an opening bracket, so neither appears in it.',
  },
];

// Every product path that sets the workspace root. None of them calls the
// starter, and none of them should have to: they all reach it through the one
// function that owns the lifecycle, which is the property the checks below
// exist to hold.
const WORKSPACE_SETTERS = [
  {
    file: 'server.js',
    fn: 'startServer',
    surface: 'boot, clearing the pointer when the remembered workspace no longer exists',
  },
  {
    file: 'server.js',
    fn: 'setWorkspace',
    surface: 'the test-only re-export used to point a booted server at a fixture',
  },
  {
    file: 'lib/protocol/handlers/workspace.js',
    fn: 'handleGetWorkspaces',
    surface: 'the picker refreshing, clearing the pointer when the workspace has vanished',
  },
  {
    file: 'lib/protocol/handlers/workspace.js',
    fn: 'handleSetWorkspace',
    surface: 'rolling the root back when an open throws part way through',
  },
  {
    file: 'lib/protocol/handlers/workspace.js',
    fn: 'openWorkspace',
    surface: 'choosing a folder: the path this card was raised for',
  },
  {
    file: 'lib/protocol/handlers/workspace.js',
    fn: 'handleCreateWorkspace',
    surface: 'creating a workspace from a name typed into the interface',
  },
];

// ===== READING THE SOURCE =====

// Product files only. The suite is excluded deliberately and the reason is in
// NOT_ENUMERATED; node_modules and the build outputs are not source.
const SKIP_DIRS = new Set(['node_modules', '.git', 'test', 'dist', 'coverage', 'vendor', '.rundock']);

function productFiles() {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel || '.'), { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith('.js')) out.push(next);
    }
  };
  walk('');
  return out;
}

// Comments are not code. A name in prose followed by a bracket would otherwise
// read as a call, and this file's own header would be a caller.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

// The function a byte offset sits in: the nearest declaration above it, taking
// whichever is closer of a top-level `function name(` and an indented object
// method `name(args) {`. Both shapes hold callers in this codebase.
const NOT_A_FUNCTION_NAME = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try', 'with',
]);
function enclosingFn(src, index) {
  const before = src.slice(0, index);
  let best = null;
  for (const re of [/^function ([A-Za-z0-9_$]+)\s*\(/gm, /^\s{2,}([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/gm]) {
    let m;
    while ((m = re.exec(before)) !== null) {
      if (NOT_A_FUNCTION_NAME.has(m[1])) continue;
      if (best === null || m.index > best.index) best = { index: m.index, name: m[1] };
    }
  }
  return best ? best.name : '(top level)';
}

// Is this occurrence the DECLARATION of the name rather than a call to it?
// Both shapes this codebase declares in look the same to a bare name-then-
// bracket scan: `function name(args) {` at the top level, and `name(args) {`
// as an object method. Both are preceded on their line by nothing but
// whitespace or the `function` keyword, and both are followed by `) {`. A call
// is followed by `)` and then anything else.
function isDeclaration(src, index, name) {
  const lineStart = src.lastIndexOf('\n', index) + 1;
  const before = src.slice(lineStart, index);
  if (!/^\s*(function\s+)?$/.test(before)) return false;
  return /^\s*\)\s*\{/.test(src.slice(index + name.length).replace(/^\([^)]*/, ''));
}

// Every call to `name` in the product, as `name in file:function`.
function callSites(name) {
  const found = [];
  for (const rel of productFiles()) {
    const src = stripComments(read(rel));
    const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
    let m;
    while ((m = re.exec(src)) !== null) {
      if (isDeclaration(src, m.index, name)) continue;
      found.push({ call: name, file: rel, fn: enclosingFn(src, m.index) });
    }
  }
  return found;
}

const asKey = (r) => `${r.call} in ${r.file}:${r.fn}`;
const setterKey = (r) => `${r.file}:${r.fn}`;

describe('every caller of the scheduler lifecycle is enumerated', () => {
  // THE CHECK THAT ENDS THE LOOP. A new call to either function fails here, by
  // name, until it is listed with the test that drives its surface.
  test('no product code arms or disarms the scheduler without being listed here', () => {
    const found = [...callSites('startScheduler'), ...callSites('stopScheduler')].map(asKey);
    assert.deepStrictEqual(
      found.sort(), CALLERS.map(asKey).sort(),
      'the scheduler is started or stopped somewhere CALLERS does not name, or a listed caller has '
      + 'gone. Add the row and the test that drives its surface, or remove the row.',
    );
  });

  test('every caller names a test, and every named test exists', () => {
    for (const row of CALLERS) {
      assert.ok(row.surface && row.provenBy && row.provenIn,
        `${asKey(row)} needs a surface and a test that drives it`);
      const suite = read(row.provenIn);
      assert.ok(suite.includes(`test('${row.provenBy}'`),
        `${asKey(row)} names "${row.provenBy}" in ${row.provenIn} and no test there has that name`);
    }
  });

  test('a call left out of the enumeration says why', () => {
    assert.ok(NOT_ENUMERATED.length > 0, 'the exclusions are part of the enumeration, not a gap in it');
    for (const excluded of NOT_ENUMERATED) {
      assert.ok(excluded.what && excluded.why && excluded.why.length > 60,
        `"${excluded.what}" is excluded without a reason, which is how the last one went unnoticed`);
    }
  });

  // The suite is the one place allowed to arm the tick itself, and it should
  // stay obvious how much of the coverage that is. This is the number the card
  // was raised over: proof of the tick, none of it proof of the lifecycle.
  test('the lifecycle proofs never arm the tick themselves', () => {
    const selfArming = [];
    for (const dir of ['test/integration', 'test/unit']) {
      for (const name of fs.readdirSync(path.join(ROOT, dir))) {
        if (!name.endsWith('.test.js')) continue;
        const src = stripComments(read(`${dir}/${name}`));
        if (/\b(?:start|stop)Scheduler\s*\(/.test(src)) selfArming.push(`${dir}/${name}`);
      }
    }
    assert.ok(selfArming.length >= 8,
      `sanity: the suites that arm the tick themselves are still there, found ${selfArming.length}`);
    for (const proof of new Set(CALLERS.map(r => r.provenIn))) {
      assert.ok(!selfArming.includes(proof),
        `${proof} arms or disarms the tick itself. It is the proof that the PRODUCT does, and calling `
        + 'the starter is exactly what let eight suites stay green while nothing did');
    }
  });
});

describe('no path can set a workspace without starting the scheduler', () => {
  // AC-8, and the reason the lifecycle lives where it does. Every product path
  // that sets a workspace is listed, and the two checks after this one make
  // listing enough: they cannot reach the root except through the function
  // that runs the lifecycle, and that function runs it.
  test('no product code sets a workspace without being listed here', () => {
    const found = callSites('setWorkspaceRoot')
      // The declaration's own body is where the root is written; it is the
      // destination of every row below rather than a row itself.
      .filter(r => !(r.file === 'server.js' && r.fn === 'setWorkspaceRoot'))
      .map(setterKey);
    assert.deepStrictEqual(
      found.sort(), WORKSPACE_SETTERS.map(setterKey).sort(),
      'a workspace is set somewhere WORKSPACE_SETTERS does not name, or a listed one has gone. '
      + 'Add the row, or remove it.',
    );
  });

  test('the workspace root cannot be written except through the function that runs the lifecycle', () => {
    const writers = [];
    for (const rel of productFiles()) {
      if (rel === 'lib/config.js') continue; // where setWorkspace is declared
      const src = stripComments(read(rel));
      const re = /\bsetWorkspace\s*\(/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        if (isDeclaration(src, m.index, 'setWorkspace')) continue;
        writers.push(`${rel}:${enclosingFn(src, m.index)}`);
      }
    }
    assert.deepStrictEqual(writers.sort(), [
      'server.js:setWorkspaceRoot',  // the one write of the root
    ], 'lib/config.setWorkspace is being called from somewhere other than setWorkspaceRoot, so that '
      + 'path sets a workspace and never starts a scheduler. Route it through setWorkspaceRoot.');
  });

  test('the function every workspace-setting path reaches runs the lifecycle', () => {
    const src = stripComments(read('server.js'));
    const start = src.indexOf('function setWorkspaceRoot(');
    assert.ok(start > 0, 'setWorkspaceRoot has been renamed; this whole file is about that function');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    assert.match(body, /\bstopScheduler\s*\(\s*\)/,
      'setWorkspaceRoot no longer stops the scheduler, so a workspace left keeps its ticker');
    assert.match(body, /\bstartScheduler\s*\(\s*\)/,
      'setWorkspaceRoot no longer starts the scheduler, so choosing a workspace arms nothing: '
      + 'this is the defect the card was raised for, returned');
    assert.ok(body.indexOf('stopScheduler') < body.indexOf('startScheduler'),
      'the stop must come first, or the start meets a live handle, declines, and leaves the old '
      + 'ticker running for a workspace nobody is in');
  });
});
