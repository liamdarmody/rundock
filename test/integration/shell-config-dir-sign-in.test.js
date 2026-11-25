'use strict';
// Signing in when CLAUDE_CONFIG_DIR is set only in the login shell, through
// the real server and the desktop's own sign-in check.
//
// The packaged app opened from the Finder starts without the login shell's
// environment. Claude Code started without CLAUDE_CONFIG_DIR looks for its
// sign-in in the wrong place, so every check fails and every agent starts
// signed out. Here the stub claude is signed in only when started with the
// value a fake login shell's profile sets, and the routing of the checks
// (electron/shell-config-dir.js, passed to startServer as electron/main.js
// passes it) is what has to bring that value across.
//
// No real shell or profile runs: the shell is a /bin/sh script in a temporary
// folder, and the home folder is a temporary one with its own .claude.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');

const h = require('../helpers/harness.js');
const { makeTempDir } = require('../helpers/workspace.js');
const { fakeShell } = require('../helpers/fake-login-shell.js');
const scd = require('../../electron/shell-config-dir.js');
const { createSignInReason } = require('../../electron/sign-in-reason.js');

const SKIP = process.platform === 'win32'
  ? 'the read runs a POSIX login shell, which Windows does not have, and it never runs there'
  : false;

function post(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.port, method: 'POST', path: url, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

// The desktop's own setup check (electron/setup-check.js), made by the lines
// in electron/main.js that make it, with the routing given and the reason
// holder main.js gives it. main.js cannot be loaded outside Electron, so the
// lines are taken from its source. Its PATH extender is a stand-in that adds
// nothing: the stub claude is first on PATH.
function desktopSetupCheck(shellConfigDir) {
  const mainPath = path.join(__dirname, '../../electron/main.js');
  const src = fs.readFileSync(mainPath, 'utf8');
  const load = /^const \{ createSetupCheck \} = require\('\.\/setup-check\.js'\);\n/m.exec(src);
  const make = /^const setupCheck = createSetupCheck\(\{\n[\s\S]*?\n\}\);\n/m.exec(src);
  assert.ok(load && make, 'electron/main.js makes its setup check');
  return new Function('require', 'process', 'app', 'shellConfigDir', 'signInReason', 'ensurePath', `${load[0]}${make[0]}return setupCheck;`)(
    createRequire(mainPath), process, { getPath: () => appDataFor() }, shellConfigDir, createSignInReason(), () => {});
}
const appDataFor = () => makeTempDir('shell-config-setup-log-');

describe('signing in with CLAUDE_CONFIG_DIR from the login shell', { skip: SKIP }, () => {
  const savedDeps = { ...scd.deps };
  const inherited = process.env.CLAUDE_CONFIG_DIR;
  let claudeDir;
  let appData;
  let reads = 0;
  let controller;
  let client;

  // One launch of the packaged app on macOS, over the process's own environment.
  const launch = () => scd.createShellConfigDir({ isPackaged: true, platform: 'darwin', env: process.env, appData });
  const marker = () => path.join(appData, scd.MARKER_FILE);

  async function agentEnv() {
    const convoId = h.freshConvoId();
    h.clearInvocations();
    h.writeScenario([{ match: {}, turn: [{ text: 'ok.' }] }]);
    client.send({ type: 'chat', conversationId: convoId, agent: 'lead-designer', content: 'hello' });
    await client.waitForEvent('system', 'done', convoId);
    return h.readInvocations()[0].env;
  }

  before(async () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    const home = makeTempDir('shell-config-home-');
    claudeDir = path.join(home, '.claude');
    fs.mkdirSync(claudeDir);
    appData = makeTempDir('shell-config-data-');
    const { shell } = fakeShell(`echo "Welcome back, example-user"\nexport CLAUDE_CONFIG_DIR='${claudeDir}'\n`);
    const spawn = scd.deps.spawn;
    Object.assign(scd.deps, { shell: () => shell, home: () => home, log: () => {}, spawn: (...args) => { reads++; return spawn(...args); } });
    controller = launch();
    await h.boot({
      env: { STUB_CLAUDE_SIGNED_IN_WITH: claudeDir },
      startOptions: { signInRetry: (check) => controller.checkConnection(check) },
    });
    client = await h.connect();
  });
  after(async () => {
    Object.assign(scd.deps, savedDeps);
    if (inherited === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = inherited;
    delete process.env.STUB_CLAUDE_SIGNED_IN_WITH;
    await h.shutdown();
  });

  test('a failed connection check reads the login shell once, and the check passes with its CLAUDE_CONFIG_DIR', async () => {
    assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, undefined);
    const res = await post('/api/claude/connection', h.authHeaders());
    assert.strictEqual(res.status, 200, res.text);
    assert.deepStrictEqual(JSON.parse(res.text), { connected: true, known: true });
    assert.strictEqual(reads, 1);
    assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, claudeDir);
    assert.ok(fs.existsSync(marker()), 'the next launch reads at start-up');
  });

  test('the next connection check passes without reading again', async () => {
    const res = await post('/api/claude/connection', h.authHeaders());
    assert.deepStrictEqual(JSON.parse(res.text), { connected: true, known: true });
    assert.strictEqual(reads, 1);
  });

  test("an agent's first message after the check starts Claude Code with CLAUDE_CONFIG_DIR", async () => {
    assert.strictEqual((await agentEnv()).CLAUDE_CONFIG_DIR, claudeDir);
  });

  test('the next launch reads at start-up, and its agents start with the value and no check run', async () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    controller = launch();
    assert.strictEqual(await controller.atLaunch(), true);
    assert.strictEqual(reads, 2);
    assert.strictEqual((await agentEnv()).CLAUDE_CONFIG_DIR, claudeDir);
  });

  test("the desktop's own sign-in check is run again with the value, and passes", async () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    fs.rmSync(marker(), { force: true });
    controller = launch();
    const runsOnce = { checkAuthenticated: (check) => check() };
    assert.strictEqual((await desktopSetupCheck(runsOnce).check()).status, 'not-authenticated', 'signed out without the value');
    assert.strictEqual(reads, 2, 'a check run once reads nothing');
    assert.deepStrictEqual(await desktopSetupCheck(controller).check(), { status: 'ready' });
    assert.strictEqual(reads, 3);
    assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, claudeDir);
  });
});
