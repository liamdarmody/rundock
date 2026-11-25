'use strict';
// Every Claude sign-in check in the desktop app goes through the reading of
// CLAUDE_CONFIG_DIR from the login shell (electron/shell-config-dir.js), and
// the reading at start-up comes before anything starts Claude Code.
//
// electron/main.js cannot be loaded outside Electron, so these read its source.
// The server's half runs for real in
// test/integration/shell-config-dir-sign-in.test.js.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
const setupCheck = fs.readFileSync(path.join(root, 'electron', 'setup-check.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

const count = (src, text) => src.split(text).length - 1;
// Every Claude Code check main.js runs goes through the one setup check it
// makes (electron/setup-check.js), whose sign-in check runs inside this.
const CHECK = 'setupCheck.check(';
const ROUTED = 'shellConfigDir.checkAuthenticated(async () => {';

describe('the desktop app', () => {
  test('makes one reader per launch, told whether this is the packaged app, the platform and its own environment', () => {
    assert.strictEqual(count(main, "require('./shell-config-dir.js')"), 1);
    assert.strictEqual(count(main, 'createShellConfigDir({'), 1);
    assert.match(main, /createShellConfigDir\(\{\s*isPackaged: app\.isPackaged, platform: process\.platform, env: process\.env, appData: app\.getPath\('userData'\),\s*\}\)/);
  });

  test('reads at start-up before it looks for Claude Code, checks its sign-in or starts the server', () => {
    const ready = main.indexOf('app.whenReady().then(async () => {');
    assert.ok(ready > 0);
    const atLaunch = main.indexOf('await shellConfigDir.atLaunch();', ready);
    assert.ok(atLaunch > ready, 'reads at start-up');
    assert.strictEqual(count(main, 'shellConfigDir.atLaunch()'), 1);
    for (const later of [CHECK, 'startServer(']) {
      const at = main.indexOf(later, ready);
      assert.ok(at > atLaunch, `${later} comes after the read at start-up`);
    }
  });

  test('runs its sign-in check only through the reader: at the launch gate, after the wizard and in the wizard', () => {
    assert.match(main, /^const setupCheck = createSetupCheck\(\{\n[^]*?[\s{,]shellConfigDir[,\s}][^]*?\n\}\);\n/m,
      'the setup check is given the reader');
    assert.ok(!/\bisClaudeAuthenticated\b|--print/.test(main), 'main.js runs no sign-in check of its own');
    assert.strictEqual(count(main, CHECK), 3);
    assert.match(main, /const launchCheck = await setupCheck\.check\(\{ signIn \}\);/);
    assert.match(main, /if \(\(await setupCheck\.check\(\)\)\.status !== 'ready'\) \{/);
    const wizard = main.indexOf("ipcMain.handle('wizard-check-runtimes', async () => ({ claude: await setupCheck.check(),");
    assert.ok(wizard > 0, 'the wizard handler waits for the check');
    assert.ok(wizard < main.indexOf("ipcMain.handle('wizard-signin-claude'", wizard));
    // In the setup check, the sign-in run is started only inside the reader.
    assert.strictEqual(count(setupCheck, ROUTED), 1);
    const routed = setupCheck.slice(setupCheck.indexOf(ROUTED), setupCheck.indexOf('\n    });\n', setupCheck.indexOf(ROUTED)));
    assert.match(routed, /runChild\(plan\.program, \[\.\.\.plan\.args, \.\.\.SIGN_IN_ARGS\]/);
    assert.strictEqual(count(setupCheck, '...SIGN_IN_ARGS'), 1, 'no sign-in run is started around the reader');
  });

  test("hands the server the reader for the reconnect card's check", () => {
    assert.match(main, /startServer\(\{ port: 0, signInRetry: \(check\) => shellConfigDir\.checkConnection\(check\) \}\)/);
  });
});

describe('the server', () => {
  test("runs the reconnect card's check through the handling it was given, or on its own without one", () => {
    assert.strictEqual(count(server, "if (typeof options.signInRetry === 'function') _signInRetry = options.signInRetry;"), 1);
    assert.match(server, /checkClaudeConnection: \(\) => \{\n\s*const check = \(\) => claudeConsole\.checkConnection\(\{ bin: resolveClaudeBin\(\), isAuthFailure: isAuthError \}\);\n\s*return \(_signInRetry \? _signInRetry\(check\) : check\(\)\)\.then\(/);
    assert.strictEqual(count(server, 'claudeConsole.checkConnection('), 1, 'no check is run around the handling');
  });
});
