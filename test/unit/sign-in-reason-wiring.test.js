'use strict';
// The desktop app keeps why its last Claude sign-in check failed in one holder
// (electron/sign-in-reason.js), made once when main.js loads. main.js hands it
// to the setup check (electron/setup-check.js), whose sign-in check fills it,
// and the wizard's runtime answer carries what it kept.
//
// electron/main.js cannot be loaded outside Electron, so this reads its source.
// The lines that load the reason module and make the holder, the lines that
// load and make the setup check, and the wizard's handler are cut out and run
// together in one scope, with the real modules and nothing standing in for
// the holder: a failed check is read back by the handler only when the check
// reaches the holder those lines make. Only the children the check starts are
// stand-ins. Each piece is also pinned by name, so a holder that is lost,
// renamed or made twice fails here loudly.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { answerChildren, claudeAt } = require('../helpers/setup-check-children.js');

const MAIN_PATH = path.join(__dirname, '..', '..', 'electron', 'main.js');
const main = fs.readFileSync(MAIN_PATH, 'utf8');
const CHECK_PATH = path.join(__dirname, '..', '..', 'electron', 'setup-check.js');

const BIN = '/home/example/.local/bin/claude';
const OAUTH = 'Failed to authenticate: OAuth session expired and could not be refreshed';
const REQUIRE = /^const \{ createSignInReason \} = require\('\.\/sign-in-reason\.js'\);\n/m;
const HOLDER = 'const signInReason = createSignInReason();';
// Any module-level line that makes a holder, whatever it names it, so a holder
// made under another name runs here and shows what the app would do with it.
const MAKES_A_HOLDER = /^(?:const|let|var) [\w$]+ = createSignInReason\(\);\n/m;
const SETUP_REQUIRE = /^const \{ createSetupCheck \} = require\('\.\/setup-check\.js'\);\n/m;
const MAKES_THE_CHECK = /^const setupCheck = createSetupCheck\(\{\n[\s\S]*?\n\}\);\n/m;
const HANDLER = /^ *ipcMain\.handle\('wizard-check-runtimes', ([^\n]*)\);\n/m;

function piece(pattern, what) {
  const found = pattern.exec(main);
  assert.ok(found, `electron/main.js no longer carries ${what}`);
  return found;
}

// A dev run's routing: the check runs once and its answer stands.
const runsOnce = { checkAuthenticated: async (check) => check() };

// main.js's own lines, run in one scope. The holder is whatever those lines
// make: nothing here passes one in. The parameters are what those lines reach
// that has nothing to do with the reason. `state` says how the stand-in
// Claude Code answers each child the check starts.
function desktop(t, state, shellConfigDir = runsOnce) {
  answerChildren(t, claudeAt(BIN, state));
  const body = [
    piece(REQUIRE, "the line that loads the reason module: const { createSignInReason } = require('./sign-in-reason.js');")[0],
    piece(MAKES_A_HOLDER, 'a module-level line that makes a reason holder')[0],
    piece(SETUP_REQUIRE, "the line that loads the setup check: const { createSetupCheck } = require('./setup-check.js');")[0],
    piece(MAKES_THE_CHECK, 'the line that makes the setup check, const setupCheck = createSetupCheck({ ... });')[0],
    `return ${piece(HANDLER, "its answer to the wizard's runtime check")[1]};`,
  ].join('\n');
  return new Function('require', 'process', 'app', 'shellConfigDir', 'ensurePath', 'detectCodexForWizard', body)(
    createRequire(MAIN_PATH), { platform: 'linux', env: { PATH: '/usr/bin' } }, { getPath: () => null }, shellConfigDir, () => {},
    () => ({ installed: false, authenticated: false }));
}

describe("main.js's own lines, run together with the real reason module", () => {
  test("a failed check's reason is read back by the wizard's answer, and goes when a check passes", async (t) => {
    const state = { said: `${OAUTH}\n` };
    const answer = desktop(t, state);
    assert.deepStrictEqual((await answer()).claude,
      { status: 'not-authenticated', reason: { kind: 'said', text: OAUTH, signIn: true } });
    state.signedIn = true;
    assert.deepStrictEqual((await answer()).claude, { status: 'ready' });
    Object.assign(state, { signedIn: false, said: 'API Error: Connection error.\n' });
    assert.deepStrictEqual((await answer()).claude,
      { status: 'not-authenticated', reason: { kind: 'said', text: 'API Error: Connection error.', signIn: false } });
  });

  test('the answer reads what the check itself left, even when the routing does not run it again', async (t) => {
    const state = { said: `${OAUTH}\n` };
    const routing = { runs: true, checkAuthenticated: async (check) => (routing.runs ? check() : false) };
    const answer = desktop(t, state, routing);
    assert.deepStrictEqual((await answer()).claude.reason, { kind: 'said', text: OAUTH, signIn: true }, 'a check that ran and failed');
    routing.runs = false;
    assert.deepStrictEqual((await answer()).claude.reason, { kind: 'said', text: OAUTH, signIn: true }, 'kept while no check runs');
    Object.assign(routing, { runs: true });
    state.signedIn = true;
    assert.deepStrictEqual((await answer()).claude, { status: 'ready' });
    routing.runs = false;
    assert.strictEqual((await answer()).claude.reason, null, 'what the check that passed left');
  });
});

describe('the reason holder in main.js, by name', () => {
  test('main.js loads the reason module once', () => {
    assert.strictEqual((main.match(/require\(\s*['"]\.\/sign-in-reason(?:\.js)?['"]\s*\)/g) || []).length, 1);
    assert.ok(REQUIRE.test(main), "the module is loaded as const { createSignInReason } = require('./sign-in-reason.js');");
  });

  test('main.js makes one holder, as signInReason', () => {
    assert.strictEqual((main.match(/\bcreateSignInReason\s*\(/g) || []).length, 1, 'exactly one holder is made');
    assert.strictEqual(main.split('\n').filter((line) => line === HOLDER).length, 1, `the one holder is made by the line ${HOLDER}`);
  });

  test('the holder is made at module scope, where the check and the handler both reach it', () => {
    // V8 refuses a second declaration in one scope when it compiles, so a
    // declaration added at the end of the module tells, without running
    // anything, whether the module's own scope already declares the name.
    // main.js is compiled as Node wraps a CommonJS module.
    const compileError = (src) => {
      try {
        new vm.Script(`(function (exports, require, module, __filename, __dirname) {\n${src}\n})`, { filename: MAIN_PATH });
        return null;
      } catch (err) {
        return err.message;
      }
    };
    const ANOTHER = '\nconst signInReason = null;\n';
    assert.strictEqual(compileError(main), null, 'sanity: main.js compiles as it stands');
    assert.match(String(compileError(main + ANOTHER)), /Identifier 'signInReason' has already been declared/,
      'main.js declares signInReason at module scope');
    assert.strictEqual(compileError(main.replace(`${HOLDER}\n`, '') + ANOTHER), null,
      `and ${HOLDER} is that declaration, the only one at module scope`);
  });

  // Every mention outside comments, sorted into the holder line, reads of the
  // holder and anything else.
  const mentions = (src, isHolder) => {
    const made = [];
    const reads = [];
    const other = [];
    for (const line of src.split('\n').filter((l) => !/^\s*\/\//.test(l))) {
      for (const m of line.matchAll(/\bsignInReason\b/g)) {
        if (isHolder(line)) made.push(line);
        else if (/^signInReason\.(?:passed|failed|last)\(/.test(line.slice(m.index))) reads.push(line.slice(m.index));
        else other.push(line.trim());
      }
    }
    return { made, reads, other };
  };

  test('nothing else in main.js declares, assigns or shadows signInReason: its one other mention hands the holder to the setup check', () => {
    const { made, other } = mentions(main, (line) => line === HOLDER);
    assert.deepStrictEqual(made, [HOLDER]);
    const creation = piece(MAKES_THE_CHECK, 'the line that makes the setup check')[0];
    assert.strictEqual(other.length, 1, `one other mention of signInReason, found: ${JSON.stringify(other)}`);
    assert.ok(creation.includes(other[0]), 'and it is in the line that makes the setup check');
    assert.strictEqual((creation.match(/\bsignInReason\b/g) || []).length, 1);
    assert.match(creation, /[\s{,]signInReason\s*(?:,|\n|\})/, 'which is given the holder itself, by its name');
  });

  test('the setup check only reads the holder it is given', () => {
    assert.ok(fs.existsSync(CHECK_PATH), 'electron/setup-check.js is there to read');
    const src = fs.readFileSync(CHECK_PATH, 'utf8');
    const DEFAULT = 'signInReason = createSignInReason(),';
    const { made, reads, other } = mentions(src, (line) => line.trim() === DEFAULT);
    assert.ok(reads.length >= 3, `sanity: the check's reads were found, found ${reads.length}`);
    assert.deepStrictEqual(made, [`  ${DEFAULT}`], 'its own holder only when none is given');
    assert.deepStrictEqual(other, [], 'a mention of signInReason that is neither its parameter nor a read of it');
  });
});
