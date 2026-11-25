'use strict';
// How electron/main.js uses the desktop's setup check (electron/setup-check.js):
// the setup screen's runtime answer and the launch gate both go through the
// one check main.js makes, awaited, so neither holds the main process.
//
// electron/main.js cannot be loaded outside Electron, so this reads its source.
// The lines that load and make the check, the setup screen's handler and the
// launch gate are cut out by name, failing loudly when one is renamed or lost,
// and run with the real module and stand-ins only for the children it starts
// and for what the launch gate reaches outside it.
const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { answerChildren, claudeAt } = require('../helpers/setup-check-children.js');

const MAIN_PATH = path.join(__dirname, '..', '..', 'electron', 'main.js');
const main = fs.readFileSync(MAIN_PATH, 'utf8');

const BIN = '/home/example/.local/bin/claude';
const OAUTH = 'Failed to authenticate: OAuth session expired and could not be refreshed';
const SETUP_REQUIRE = /^const \{ createSetupCheck \} = require\('\.\/setup-check\.js'\);\n/m;
const MAKES_THE_CHECK = /^const setupCheck = createSetupCheck\(\{\n[\s\S]*?\n\}\);\n/m;
const HANDLER = /^ *ipcMain\.handle\('wizard-check-runtimes', ([^\n]*)\);\n/m;
const LAUNCH = /^ {2}const signIn = [\s\S]*?\n {2}if \(needsWizard\) \{\n[\s\S]*?\n {2}\}\n/m;

function piece(pattern, what) {
  const found = pattern.exec(main);
  assert.ok(found, `electron/main.js no longer carries ${what}`);
  return found;
}

// main.js's lines that make the check and answer the setup screen, run in one
// scope with the real modules. Codex's detection is a stand-in whose answer
// is passed through as it is.
function handler(t, state) {
  const ran = answerChildren(t, claudeAt(BIN, state));
  const codex = { installed: true, authenticated: false };
  const body = [
    piece(SETUP_REQUIRE, "the line that loads the check: const { createSetupCheck } = require('./setup-check.js');")[0],
    piece(MAKES_THE_CHECK, 'the line that makes the check, const setupCheck = createSetupCheck({ ... });')[0],
    `return ${piece(HANDLER, "the setup screen's runtime check, wizard-check-runtimes")[1]};`,
  ].join('\n');
  const { createSignInReason } = require('../../electron/sign-in-reason.js');
  const answer = new Function('require', 'process', 'app', 'shellConfigDir', 'signInReason', 'ensurePath', 'detectCodexForWizard', body)(
    createRequire(MAIN_PATH), { platform: 'linux', env: { PATH: '/usr/bin' } }, { getPath: () => null },
    { checkAuthenticated: (run) => run() }, createSignInReason(), () => {}, () => codex);
  return { answer, ran, codex };
}

describe("the setup screen's runtime answer keeps its shape", () => {
  const cases = [
    ['nothing is found', { found: false }, { status: 'not-installed' }],
    ['the copy found does not start', { starts: false }, { status: 'found-not-started' }],
    ['the copy started is not signed in', { said: `${OAUTH}\n` }, { status: 'not-authenticated', reason: { kind: 'said', text: OAUTH, signIn: true } }],
    ['the copy started is signed in', { signedIn: true }, { status: 'ready' }],
  ];
  for (const [name, state, claude] of cases) {
    test(`when ${name}: { claude, codex }, with Codex as detectCodexForWizard says`, async (t) => {
      const { answer, ran, codex } = handler(t, state);
      const got = await answer();
      assert.deepStrictEqual(Object.keys(got).sort(), ['claude', 'codex']);
      assert.deepStrictEqual(got.claude, claude);
      assert.strictEqual(got.codex, codex, "Codex's answer is passed through as detected");
      assert.strictEqual(ran[0], 'which claude', 'the answer comes from the setup check, which looked for Claude Code');
    });
  }
});

// The launch gate, cut from the line that decides whether sign-in is checked
// to the end of the block that shows the setup screen, run with stand-ins.
// It answers 'continued' when the app would go on to start its server.
async function launch({ setupVerified = false, isSmokeTest = false, statuses }) {
  const asked = [];
  const shown = [];
  let quit = 0;
  const setupCheck = {
    check: (opts) => {
      asked.push(opts);
      const status = statuses[asked.length - 1];
      // Answered a turn later, as the real check is.
      return new Promise((resolve) => setImmediate(() => resolve({ status })));
    },
  };
  const app = { quit: () => { quit++; } };
  const quiet = { log: () => {} };
  const showWizard = async () => { shown.push(asked.length); };
  const run = new Function('setupCheck', 'showWizard', 'app', 'console', 'setupVerified', 'isSmokeTest',
    `return (async () => {\n${piece(LAUNCH, 'its launch gate, from const signIn = ... to the end of if (needsWizard) { ... }')[0]}\nreturn 'continued';\n})();`);
  const result = await run(setupCheck, showWizard, app, quiet, setupVerified, isSmokeTest);
  return { result, asked, shown, quit };
}

describe('the launch gate goes through the setup check, awaited', () => {
  test('a first launch checks sign-in, and goes on without the setup screen when the check reads ready', async () => {
    const r = await launch({ statuses: ['ready'] });
    assert.deepStrictEqual(r.asked, [{ signIn: true }]);
    assert.deepStrictEqual(r.shown, [], 'no setup screen');
    assert.strictEqual(r.result, 'continued');
    assert.strictEqual(r.quit, 0);
  });

  test('a copy found but not started opens the setup screen', async () => {
    const r = await launch({ statuses: ['found-not-started', 'ready'] });
    assert.deepStrictEqual(r.shown, [1], 'the setup screen opens after the launch check');
    assert.strictEqual(r.result, 'continued', 'and the app goes on once a check after it reads ready');
  });

  for (const status of ['not-installed', 'found-not-started', 'not-authenticated']) {
    test(`after the setup screen closes, ${status} quits the app`, async () => {
      const r = await launch({ statuses: ['not-installed', status] });
      assert.deepStrictEqual(r.shown, [1]);
      assert.strictEqual(r.asked.length, 2, 'one check at launch and one after the setup screen');
      assert.ok(r.asked[1] === undefined || r.asked[1].signIn !== false, 'the check after the setup screen checks sign-in');
      assert.strictEqual(r.quit, 1);
      assert.strictEqual(r.result, undefined, 'nothing after the gate runs');
    });
  }

  test('once setup is verified, the launch check only looks for and starts Claude Code', async () => {
    const started = await launch({ setupVerified: true, statuses: ['started'] });
    assert.deepStrictEqual(started.asked, [{ signIn: false }]);
    assert.deepStrictEqual(started.shown, []);
    assert.strictEqual(started.result, 'continued');
    for (const status of ['found-not-started', 'not-installed']) {
      const r = await launch({ setupVerified: true, statuses: [status, 'ready'] });
      assert.deepStrictEqual(r.shown, [1], `${status} opens the setup screen`);
      assert.strictEqual(r.result, 'continued');
    }
  });

  test('a smoke test never opens the setup screen', async () => {
    for (const status of ['not-installed', 'found-not-started']) {
      const r = await launch({ isSmokeTest: true, statuses: [status] });
      assert.deepStrictEqual(r.asked, [{ signIn: false }], 'sign-in is never checked during a smoke test');
      assert.deepStrictEqual(r.shown, []);
      assert.strictEqual(r.result, 'continued');
    }
  });

  test('the launch check runs after the login shell is read and before the server starts', () => {
    const atLaunch = main.indexOf('await shellConfigDir.atLaunch();');
    const gate = main.indexOf('await setupCheck.check({ signIn });');
    const server = main.indexOf('startServer(');
    assert.ok(atLaunch > 0 && gate > atLaunch, 'the launch check waits for the login shell to be read');
    assert.ok(server > gate, 'and the server starts after it');
  });
});

describe('main.js holds no blocking lookup', () => {
  test('nothing in main.js runs a command synchronously, and the old lookup and checks are gone', () => {
    for (const name of ['execSync', 'findClaude', 'isClaudeAuthenticated', 'ensureClaudeOnUserPath', 'claudeFoundVersion']) {
      assert.ok(!new RegExp(`\\b${name}\\b`).test(main), `electron/main.js no longer names ${name}`);
    }
  });

  test("the check is made with main.js's ensurePath, so the lookup searches the folders it adds", () => {
    assert.match(piece(MAKES_THE_CHECK, 'the line that makes the check')[0], /\bextendPath: ensurePath\b/);
    assert.match(main, /^function ensurePath\(\) \{\n/m);
  });
});
