'use strict';
// The desktop app keeps why its last Claude sign-in check failed in one holder
// (electron/sign-in-reason.js), made once when main.js loads. The check fills
// it and the wizard's runtime answer reads it.
//
// electron/main.js cannot be loaded outside Electron, so this reads its source.
// The line that loads the reason module, the line that makes the holder, the
// check and the wizard's handler are cut out and run together in one scope,
// with the real module and nothing standing in for the holder: a failed check
// is read back by the handler only when both reach the holder those lines
// make. Each piece is also pinned by name, so a holder that is lost, renamed
// or made twice fails here loudly.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const MAIN_PATH = path.join(__dirname, '..', '..', 'electron', 'main.js');
const main = fs.readFileSync(MAIN_PATH, 'utf8');

const OAUTH = 'Failed to authenticate: OAuth session expired and could not be refreshed';
const REQUIRE = /^const \{ createSignInReason \} = require\('\.\/sign-in-reason\.js'\);\n/m;
const HOLDER = 'const signInReason = createSignInReason();';
// Any module-level line that makes a holder, whatever it names it, so a holder
// made under another name runs here and shows what the app would do with it.
const MAKES_A_HOLDER = /^(?:const|let|var) [\w$]+ = createSignInReason\(\);\n/m;
const CHECK = /^function isClaudeAuthenticated\(\) \{\n[\s\S]*?\n\}\n/m;
const HANDLER = /ipcMain\.handle\('wizard-check-runtimes', (async \(\) => \{\n[\s\S]*?\n {4}\})\);\n/;

function piece(pattern, what) {
  const found = pattern.exec(main);
  assert.ok(found, `electron/main.js no longer carries ${what}`);
  return found;
}

// What execSync throws for a check that exits 1 having printed `said`, and
// what it returns for one that passes.
const exitsOne = (said) => () => {
  const err = new Error('Command failed: claude --print "test" --output-format text');
  Object.assign(err, { status: 1, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.from(said) });
  throw err;
};
const passes = () => Buffer.from('ok\n');

// A dev run's routing: the check runs once and its answer stands.
const runsOnce = { checkAuthenticated: async (check) => check() };

// main.js's own lines, run in one scope. The holder is whatever those lines
// make: nothing here passes one in. The parameters are the helpers the handler
// calls that have nothing to do with the reason.
function desktop(execSync, shellConfigDir = runsOnce) {
  const body = [
    piece(REQUIRE, "the line that loads the reason module: const { createSignInReason } = require('./sign-in-reason.js');")[0],
    piece(MAKES_A_HOLDER, 'a module-level line that makes a reason holder')[0],
    piece(CHECK, 'its sign-in check')[0],
    `return { isClaudeAuthenticated, answer: ${piece(HANDLER, "its answer to the wizard's runtime check")[1]} };`,
  ].join('\n');
  return new Function('require', 'execSync', 'findClaude', 'ensureClaudeOnUserPath', 'path', 'shellConfigDir', 'detectCodexForWizard', body)(
    createRequire(MAIN_PATH), execSync, () => path.join('bin', 'claude'), () => {}, path, shellConfigDir,
    () => ({ installed: false, authenticated: false }));
}

describe("main.js's own lines, run together with the real reason module", () => {
  test("a failed check's reason is read back by the wizard's answer, and goes when a check passes", async () => {
    let run = exitsOne(`${OAUTH}\n`);
    const { answer } = desktop((...args) => run(...args));
    assert.deepStrictEqual((await answer()).claude,
      { status: 'not-authenticated', reason: { kind: 'said', text: OAUTH, signIn: true } });
    run = passes;
    assert.deepStrictEqual((await answer()).claude, { status: 'ready' });
    run = exitsOne('API Error: Connection error.\n');
    assert.deepStrictEqual((await answer()).claude,
      { status: 'not-authenticated', reason: { kind: 'said', text: 'API Error: Connection error.', signIn: false } });
  });

  test('the answer reads what the check itself left, even when the routing does not run it again', async () => {
    let run = exitsOne(`${OAUTH}\n`);
    const failsWithoutRunning = { checkAuthenticated: async () => false };
    const { answer, isClaudeAuthenticated } = desktop((...args) => run(...args), failsWithoutRunning);
    assert.strictEqual(isClaudeAuthenticated(), false);
    assert.deepStrictEqual((await answer()).claude.reason, { kind: 'said', text: OAUTH, signIn: true });
    run = passes;
    assert.strictEqual(isClaudeAuthenticated(), true);
    assert.strictEqual((await answer()).claude.reason, null);
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

  test('nothing else in main.js declares, assigns or shadows signInReason: every other mention reads the holder', () => {
    const code = main.split('\n').filter((line) => !/^\s*\/\//.test(line));
    const made = [];
    const reads = [];
    const other = [];
    for (const line of code) {
      for (const m of line.matchAll(/\bsignInReason\b/g)) {
        const rest = line.slice(m.index);
        if (line === HOLDER) made.push(line);
        else if (/^signInReason\.(?:passed|failed|last)\(/.test(rest)) reads.push(rest);
        else other.push(line.trim());
      }
    }
    assert.ok(reads.length >= 3, `sanity: the check's and the handler's reads were found, found ${reads.length}`);
    assert.deepStrictEqual(made, [HOLDER]);
    assert.deepStrictEqual(other, [], 'a mention of signInReason that is neither the holder line nor a read of it');
  });
});
