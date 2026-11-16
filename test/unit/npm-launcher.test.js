'use strict';
// STARTING AN NPM-INSTALLED RUNTIME ON WINDOWS, THROUGH NODE AND NEVER A SHELL.
//
// npm puts `claude.cmd` and `codex.cmd` on PATH on Windows. Node refuses to
// start a .cmd without a shell, and a shell would read `&`, `|`, `%` and `^`
// in a prompt as part of a command. So Rundock never starts the .cmd: it reads
// the entry point from the package npm installed beside it, keeps it inside
// that package's folder, and starts it with the Node Rundock runs on. Anything
// it cannot read is refused, never started some other way.
//
// Every case stands win32 in through the helper's own argument, and lays the
// npm folder out in a real temp folder.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir, cleanup } = require('../helpers/workspace.js');

after(cleanup);

// Required where used, so a test reports on the behaviour even where the
// module does not exist.
const launcher = () => require('../../lib/runtime/npm-launcher.js');

const NODE = '/opt/example/node';
const WIN = { platform: 'win32', execPath: NODE };

// A folder laid out as npm lays out a global install on Windows
// (`%APPDATA%\npm`): the launcher, and the package it starts beside it in
// node_modules. `pkg` is the package.json, as an object or as raw text, or
// undefined for none; `files` are written inside the package folder.
function npmFolder(runtime, { pkg, files = {}, name = `${runtime.command}.cmd` } = {}) {
  const dir = makeTempDir('npm-launcher-');
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, '@ECHO off\r\n');
  const folder = path.join(dir, 'node_modules', ...runtime.pkg.split('/'));
  if (pkg !== undefined || Object.keys(files).length) fs.mkdirSync(folder, { recursive: true });
  if (pkg !== undefined) fs.writeFileSync(path.join(folder, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
    fs.writeFileSync(path.join(folder, file), text);
  }
  return { dir, bin, folder, entry: (file) => fs.realpathSync(path.join(folder, file)) };
}
const claudePackage = (bin = { claude: 'cli.js' }) => ({ name: '@anthropic-ai/claude-code', version: '2.1.318', bin });

// RUNDOCK_ELECTRON is how the app says it runs inside Electron. Each test sets
// it as it needs and puts it back.
function inElectron(on, fn) {
  const before = process.env.RUNDOCK_ELECTRON;
  if (on) process.env.RUNDOCK_ELECTRON = '1'; else delete process.env.RUNDOCK_ELECTRON;
  try { return fn(); } finally {
    if (before === undefined) delete process.env.RUNDOCK_ELECTRON; else process.env.RUNDOCK_ELECTRON = before;
  }
}

// The refusal, word for word, for a launcher at `bin`.
const refusalFor = (label, pkg, bin) => `Rundock found ${label} at ${bin}, but could not read the ${label} package installed beside it, `
  + `so it was not started. Reinstall ${label} with npm install -g ${pkg}, then try again.`;

function assertRefused(plan, npm, runtime, why) {
  assert.ok(plan.refusal instanceof Error, `${why}: refused`);
  assert.strictEqual(plan.program, undefined, `${why}: nothing to start`);
  assert.strictEqual(plan.refusal.code, 'NPM_PACKAGE_UNREADABLE', why);
  assert.strictEqual(plan.refusal.path, npm.bin, `${why}: names the launcher found`);
  assert.strictEqual(plan.refusal.message, refusalFor(runtime.label, runtime.pkg, npm.bin), why);
}

describe('the entry point read from the package beside the launcher', () => {
  test('a claude.cmd starts the given Node with the entry its package names for claude first', () => {
    const { launchPlan, CLAUDE_CODE } = launcher();
    const npm = npmFolder(CLAUDE_CODE, { pkg: claudePackage(), files: { 'cli.js': '' } });
    const plan = inElectron(false, () => launchPlan(npm.bin, CLAUDE_CODE, WIN));
    assert.deepStrictEqual(plan, { program: NODE, args: [npm.entry('cli.js')], env: null });
  });

  test('a codex.cmd starts the given Node with the entry its package names for codex first', () => {
    const { launchPlan, CODEX } = launcher();
    const npm = npmFolder(CODEX, { pkg: { name: '@openai/codex', bin: { codex: 'bin/codex.js' } }, files: { 'bin/codex.js': '' } });
    const plan = inElectron(false, () => launchPlan(npm.bin, CODEX, WIN));
    assert.deepStrictEqual(plan, { program: NODE, args: [npm.entry('bin/codex.js')], env: null });
  });

  test('a bin given as one path is that entry', () => {
    const { launchPlan, CLAUDE_CODE } = launcher();
    const npm = npmFolder(CLAUDE_CODE, { pkg: claudePackage('bin/run.js'), files: { 'bin/run.js': '' } });
    assert.deepStrictEqual(inElectron(false, () => launchPlan(npm.bin, CLAUDE_CODE, WIN)).args, [npm.entry('bin/run.js')]);
  });

  test('an entry ending in .exe is started directly, without Node, inside Electron too', () => {
    const { launchPlan, CLAUDE_CODE } = launcher();
    for (const file of ['bin/claude.exe', 'bin/CLAUDE.EXE']) {
      const npm = npmFolder(CLAUDE_CODE, { pkg: claudePackage({ claude: file }), files: { [file]: '' } });
      for (const electron of [false, true]) {
        assert.deepStrictEqual(inElectron(electron, () => launchPlan(npm.bin, CLAUDE_CODE, WIN)),
          { program: npm.entry(file), args: [], env: null }, `${file}, electron ${electron}`);
      }
    }
  });

  test('.cmd, .BAT and .Cmd launchers are read the same way', () => {
    const { launchPlan, CLAUDE_CODE } = launcher();
    for (const name of ['claude.cmd', 'CLAUDE.BAT', 'claude.Cmd', 'claude.bat']) {
      const npm = npmFolder(CLAUDE_CODE, { pkg: claudePackage(), files: { 'cli.js': '' }, name });
      assert.deepStrictEqual(inElectron(false, () => launchPlan(npm.bin, CLAUDE_CODE, WIN)).args, [npm.entry('cli.js')], name);
    }
  });

  test('a package folder that is a link is followed, and its entry kept inside where it leads', () => {
    const { launchPlan, CLAUDE_CODE } = launcher();
    const real = npmFolder(CLAUDE_CODE, { pkg: claudePackage(), files: { 'cli.js': '' } });
    const npm = npmFolder(CLAUDE_CODE);
    fs.mkdirSync(path.dirname(npm.folder), { recursive: true });
    fs.symlinkSync(real.folder, npm.folder, 'dir');
    assert.deepStrictEqual(inElectron(false, () => launchPlan(npm.bin, CLAUDE_CODE, WIN)).args, [real.entry('cli.js')]);
  });

  test('inside Electron the Node start carries ELECTRON_RUN_AS_NODE, and under node server.js nothing is added', () => {
    const { launchPlan, CLAUDE_CODE, CODEX } = launcher();
    const claude = npmFolder(CLAUDE_CODE, { pkg: claudePackage(), files: { 'cli.js': '' } });
    const codex = npmFolder(CODEX, { pkg: { bin: { codex: 'bin/codex.js' } }, files: { 'bin/codex.js': '' } });
    for (const [npm, runtime] of [[claude, CLAUDE_CODE], [codex, CODEX]]) {
      assert.deepStrictEqual(inElectron(true, () => launchPlan(npm.bin, runtime, WIN)).env, { ELECTRON_RUN_AS_NODE: '1' }, runtime.label);
      assert.strictEqual(inElectron(false, () => launchPlan(npm.bin, runtime, WIN)).env, null, runtime.label);
    }
  });

  test('a .exe on Windows, and every binary on macOS and Linux, is started as found with nothing read or added', () => {
    const { launchPlan, CLAUDE_CODE, CODEX } = launcher();
    const exe = 'C:\\Users\\someone\\AppData\\Local\\Programs\\claude\\claude.exe';
    const cmd = 'C:\\Users\\someone\\AppData\\Roaming\\npm\\claude.cmd';
    for (const electron of [false, true]) {
      inElectron(electron, () => {
        assert.deepStrictEqual(launchPlan(exe, CLAUDE_CODE, WIN), { program: exe, args: [], env: null });
        assert.deepStrictEqual(launchPlan('claude', CLAUDE_CODE, WIN), { program: 'claude', args: [], env: null }, 'a lookup that found nothing');
        for (const platform of ['darwin', 'linux']) {
          assert.deepStrictEqual(launchPlan(cmd, CLAUDE_CODE, { platform, execPath: NODE }), { program: cmd, args: [], env: null }, platform);
          assert.deepStrictEqual(launchPlan('/usr/local/bin/codex', CODEX, { platform, execPath: NODE }), { program: '/usr/local/bin/codex', args: [], env: null }, platform);
        }
      });
    }
  });
});

// One test per cause, each named after it. A refusal is never a plan to start
// the launcher, so nothing can fall back to a shell.
describe('a package that cannot be read is refused, and nothing is started', () => {
  test('the package folder is missing', () => {
    const { launchPlan, CLAUDE_CODE, CODEX } = launcher();
    for (const runtime of [CLAUDE_CODE, CODEX]) {
      const npm = npmFolder(runtime);
      assertRefused(launchPlan(npm.bin, runtime, WIN), npm, runtime, runtime.label);
    }
  });

  test('its package.json is missing', () => {
    const { launchPlan, CLAUDE_CODE } = launcher();
    const npm = npmFolder(CLAUDE_CODE, { files: { 'cli.js': '' } });
    assertRefused(launchPlan(npm.bin, CLAUDE_CODE, WIN), npm, CLAUDE_CODE, 'no package.json');
  });

  test('its package.json does not parse', () => {
    const { launchPlan, CLAUDE_CODE } = launcher();
    for (const text of ['{ "bin": { "claude": "cli.js" }, ', '', 'not json']) {
      const npm = npmFolder(CLAUDE_CODE, { pkg: text, files: { 'cli.js': '' } });
      assertRefused(launchPlan(npm.bin, CLAUDE_CODE, WIN), npm, CLAUDE_CODE, JSON.stringify(text));
    }
  });

  test('it has no bin entry for the runtime\'s command', () => {
    const { launchPlan, CLAUDE_CODE, CODEX } = launcher();
    const cases = [
      [CLAUDE_CODE, { name: '@anthropic-ai/claude-code', version: '2.1.318' }, 'no bin at all'],
      [CLAUDE_CODE, claudePackage({ 'claude-code': 'cli.js' }), 'a bin for another command'],
      [CLAUDE_CODE, claudePackage({ claude: '' }), 'an empty entry'],
      [CLAUDE_CODE, claudePackage({ claude: 7 }), 'an entry that is not a path'],
      [CLAUDE_CODE, claudePackage(['cli.js']), 'a list'],
      [CLAUDE_CODE, null, 'a package.json that is null'],
      [CODEX, { name: '@openai/codex', bin: { claude: 'cli.js' } }, 'Claude Code\'s entry in the Codex package'],
    ];
    for (const [runtime, pkg, why] of cases) {
      const npm = npmFolder(runtime, { pkg, files: { 'cli.js': '' } });
      assertRefused(launchPlan(npm.bin, runtime, WIN), npm, runtime, why);
    }
  });

  test('the entry is not a file inside the folder', () => {
    const { launchPlan, CLAUDE_CODE } = launcher();
    const outside = makeTempDir('npm-launcher-outside-');
    fs.writeFileSync(path.join(outside, 'evil.js'), '');
    const cases = [
      [{ claude: '../../evil.js' }, (npm) => fs.writeFileSync(path.join(npm.dir, 'node_modules', 'evil.js'), ''), 'a relative path out of the folder'],
      [{ claude: path.join(outside, 'evil.js') }, () => {}, 'an absolute path elsewhere'],
      [{ claude: 'cli.js' }, (npm) => fs.symlinkSync(path.join(outside, 'evil.js'), path.join(npm.folder, 'cli.js')), 'a link inside that leads out'],
      [{ claude: 'cli.js' }, () => {}, 'an entry that is not there'],
      [{ claude: 'bin' }, (npm) => fs.mkdirSync(path.join(npm.folder, 'bin')), 'a folder'],
      [{ claude: '.' }, () => {}, 'the package folder itself'],
    ];
    for (const [bin, lay, why] of cases) {
      const npm = npmFolder(CLAUDE_CODE, { pkg: claudePackage(bin) });
      lay(npm);
      assertRefused(launchPlan(npm.bin, CLAUDE_CODE, WIN), npm, CLAUDE_CODE, why);
    }
  });

  test('a package fixed after a refusal starts on the next try, with nothing remembered', () => {
    const { launchPlan, CLAUDE_CODE } = launcher();
    const npm = npmFolder(CLAUDE_CODE, { pkg: 'not json', files: { 'cli.js': '' } });
    assertRefused(launchPlan(npm.bin, CLAUDE_CODE, WIN), npm, CLAUDE_CODE, 'before the fix');
    fs.writeFileSync(path.join(npm.folder, 'package.json'), JSON.stringify(claudePackage()));
    assert.deepStrictEqual(inElectron(false, () => launchPlan(npm.bin, CLAUDE_CODE, WIN)), { program: NODE, args: [npm.entry('cli.js')], env: null }, 'after it');
    fs.rmSync(path.join(npm.folder, 'cli.js'));
    assertRefused(launchPlan(npm.bin, CLAUDE_CODE, WIN), npm, CLAUDE_CODE, 'and refused again once it breaks');
  });

  test('an unexpected failure while reading the package refuses, and never starts the launcher', () => {
    const { launchPlan, CLAUDE_CODE } = launcher();
    const npm = npmFolder(CLAUDE_CODE, { pkg: claudePackage(), files: { 'cli.js': '' } });
    for (const name of ['statSync', 'realpathSync', 'readFileSync']) {
      const real = fs[name];
      fs[name] = () => { throw new TypeError(`${name} broke unexpectedly`); };
      let plan;
      try { plan = launchPlan(npm.bin, CLAUDE_CODE, WIN); } finally { fs[name] = real; }
      assertRefused(plan, npm, CLAUDE_CODE, name);
      assert.match(String(plan.refusal.cause && plan.refusal.cause.message), new RegExp(`${name} broke`), `${name}: the cause is kept for the log`);
    }
  });
});
