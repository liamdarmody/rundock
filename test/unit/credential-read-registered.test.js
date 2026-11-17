'use strict';
// A CREDENTIAL READ IS REFUSED BY THE HOOK AS THE WORKSPACE REGISTERS IT.
//
// test/unit/credential-read-unanswered.test.js spawns the hook script itself.
// What the runtime runs is the command a workspace open writes into
// .claude/settings.local.json, through the launcher beside it, with whatever
// the entry says to do when that command fails. The runtime cannot be started
// here, as it needs a sign-in, so the boundary these tests reach is that
// registered command, run the way the runtime runs a command hook: through sh,
// with the tool call on stdin, Rundock's variables in its environment and the
// workspace as its working folder.
//
// With Rundock unreachable, a read of each file the secrets registry names, by
// the file tools and by the shell, is refused in Notes and Code mode, from an
// ordinary workspace and from one at the home folder, which holds every one of
// those files. The entries that carry those tools block the call when the hook
// itself fails, so a hook that cannot answer refuses too.
//
// Everything here uses a made-up home folder and a port nothing listens on.
const { test, describe, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scaffold = require('../../lib/workspace/scaffold.js');
const { secretsRegistry } = require('../../scripts/permission-hook.js');
const { makeTempDir } = require('../helpers/workspace.js');
const { closedPort } = require('../helpers/code-mode-fixture.js');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const FILE_TOOLS = 'Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep';
const MODES = [['Notes mode', ''], ['Code mode', '1']];
// The registered command is a POSIX shell line here; on Windows it is a
// PowerShell one, run another way.
const POSIX = { skip: process.platform === 'win32' && 'the registered command is run with sh here' };

let prevDeps;
beforeEach(() => { prevDeps = scaffold.wireScaffoldDeps({ invalidateAgentCache() {}, rebaselineAgentsWatcher() {} }); });
afterEach(() => { scaffold.wireScaffoldDeps(prevDeps); });

let home;
let port;
before(async () => {
  home = fs.realpathSync(makeTempDir('credential-read-registered-home-'));
  for (const f of secretsRegistry(home)) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '{}\n');
  }
  port = await closedPort();
});

// A workspace opened the way Rundock opens one, at `dir`.
function opened(dir) {
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
  scaffold.scaffoldWorkspace(dir, { platform: process.platform });
  return JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf-8'));
}
const entryFor = (settings, matcher) => settings.hooks.PreToolUse.find((e) => e.matcher === matcher);

// Runs the command an entry registers, the way the runtime runs a command hook.
function runRegistered(dir, command, code, toolName, toolInput) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, RUNDOCK: '1', RUNDOCK_WORKSPACE: dir, RUNDOCK_PORT: String(port), RUNDOCK_EXTRA_DIRS: '', RUNDOCK_CODE_MODE: code };
  env.NODE_V8_COVERAGE = '';
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: dir, tool_name: toolName, tool_input: toolInput });
  const r = spawnSync('sh', ['-c', command], { cwd: dir, input, env, encoding: 'utf-8', timeout: 60000 });
  let answer = null;
  try { answer = JSON.parse(r.stdout).hookSpecificOutput; } catch (e) { /* reported below */ }
  return { status: r.status, answer, stdout: r.stdout };
}

const fileReads = (f) => [['Read', { file_path: f }], ['Grep', { pattern: 'token', path: f }], ['Glob', { pattern: '*', path: f }]];
const shellReads = (f, dir) => [['Bash', { command: `cat ${f}` }], ['Bash', { command: `head ${f}` }], ['Bash', { command: `cp ${f} ${path.join(dir, 'copy.json')}` }]];

describe('with Rundock unreachable, the registered hook refuses every read of a credential file', POSIX, () => {
  for (const [where, at] of [['', () => fs.realpathSync(makeTempDir('credential-read-registered-'))], [', workspace at home', () => home]]) {
    test(`the entries for the shell and the file tools run this hook, and block the call when it fails${where}`, () => {
      const dir = at();
      const settings = opened(dir);
      const launcher = path.join(dir, '.rundock', 'permission-hook.sh');
      for (const matcher of ['Bash', FILE_TOOLS]) {
        const entry = entryFor(settings, matcher);
        assert.ok(entry, `${matcher}: registered`);
        assert.deepStrictEqual(entry.hooks, [{ type: 'command', command: `sh "${launcher}"`, timeout: 300, onFailure: 'block' }], `${matcher}: the launcher, blocking on failure`);
      }
      assert.ok(fs.readFileSync(launcher, 'utf-8').includes(`"${HOOK}"`), 'the launcher runs the hook under test');
    });
    for (const [label, code] of MODES) {
      test(`${label}${where}: Read, Grep, Glob, cat, head and a copy into the workspace of each credential file are refused`, () => {
        const dir = at();
        const settings = opened(dir);
        const cases = secretsRegistry(home).flatMap((f) => [...fileReads(f), ...shellReads(f, dir)]);
        const notRefused = [];
        for (const [tool, input] of cases) {
          const { command } = entryFor(settings, tool === 'Bash' ? 'Bash' : FILE_TOOLS).hooks[0];
          const r = runRegistered(dir, command, code, tool, input);
          const ok = r.status === 0 && r.answer && r.answer.permissionDecision === 'deny'
            && r.answer.permissionDecisionReason.startsWith('Rundock server unreachable. This reads a sign-in credential');
          if (!ok) notRefused.push(`${tool} ${JSON.stringify(input)}: exit ${r.status}: ${r.answer ? `${r.answer.permissionDecision}: ${r.answer.permissionDecisionReason}` : r.stdout}`);
        }
        assert.ok(cases.length >= 30, 'every file the registry names, six ways');
        assert.deepStrictEqual(notRefused, []);
      });
    }
  }
});
