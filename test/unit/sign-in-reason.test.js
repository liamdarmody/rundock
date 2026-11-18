// Tests for the reason a failed sign-in check gives the wizard
// (electron/sign-in-reason.js).
//
// The check's output is text Rundock did not write: Claude Code's own
// messages, error bodies relayed from a server or a proxy, and whatever the
// person's Claude Code settings run at start-up. Before any of it may leave the
// main process it is cut to one line, stripped of escape sequences, control
// characters and direction controls, has anything shaped like a credential
// replaced, and is capped. Each of those is pinned here on its own, as is each
// fixed answer for a check that says nothing usable.
//
// Fake keys are built from pieces at run time, so this file carries none.

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const sr = require('../../electron/sign-in-reason.js');

const ESC = '\u001b';
const fakeKey = (...parts) => ['sk', ...parts].join('-');
// Each shorter than the long-run length, so only its own rule can hide it.
const ANT_KEY = fakeKey('ant', 'api03', 'EXAMPLE1234');
const OTHER_KEY = fakeKey('proj', 'EXAMPLE1234');
const SHORT_TOKEN = ['example', 'TOKEN', '1234'].join('');
const LONG_RUN = 'EXAMPLE_token-'.repeat(3);

// A failed check, shaped the way execSync throws it with stdio piped.
function exitError({ stderr = '', stdout = '', status = 1, signal = null, code } = {}) {
  const err = new Error('Command failed');
  err.status = status;
  err.signal = signal;
  err.stderr = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr);
  err.stdout = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  if (code) err.code = code;
  return err;
}
const answerFor = (stderr, stdout) => sr.reasonFor(exitError({ stderr, stdout }));
const lineFor = (stderr, stdout) => answerFor(stderr, stdout).text;

const savedDeps = { ...sr.deps };
afterEach(() => { Object.assign(sr.deps, savedDeps); });

describe('which line is taken', () => {
  test('the first non-empty line of stderr is taken', () => {
    assert.strictEqual(lineFor('\n\n  \nFailed to authenticate\nat stack frame\n'), 'Failed to authenticate');
  });

  test('stdout is read when stderr has no line', () => {
    assert.strictEqual(lineFor('\n \n', 'Failed to authenticate\nmore\n'), 'Failed to authenticate');
  });

  test('stderr is read before stdout when both have a line', () => {
    assert.strictEqual(lineFor('from stderr\n', 'from stdout\n'), 'from stderr');
  });

  test('a line that is empty after cleaning counts as no output', () => {
    const blank = `${ESC}[31m${ESC}[0m\u0000\u0007\u200e\u202e\t \n`;
    assert.deepStrictEqual(answerFor(blank, blank), { kind: 'no-reason' });
  });

  test('thousands of lines give only the first', () => {
    const many = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
    assert.strictEqual(lineFor(many), 'line 0');
  });

  test('binary bytes give one line with no control characters in it', () => {
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x41, 0x07, 0x42, 0x0a, 0x80, 0x43]);
    const line = lineFor(bytes);
    assert.ok(line.includes('AB'), `the printable bytes are kept: ${JSON.stringify(line)}`);
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(line), `no control character crosses: ${JSON.stringify(line)}`);
    assert.ok(!line.includes('C'), 'nothing after the first line is taken');
  });
});

describe('what is removed, one removal each', () => {
  test('ANSI escape sequences are removed', () => {
    const line = `${ESC}[1;31mFailed${ESC}[0m to ${ESC}]0;window title${ESC}\\authenticate${ESC}(B${ESC}]8;;x${ESC}\u0007 now`;
    assert.strictEqual(lineFor(line), 'Failed to authenticate now');
  });

  test('control characters are removed', () => {
    const line = 'Fail\u0000ed to\u0001 auth\u0008entic\u007fate\u0085 now\u009f';
    assert.strictEqual(lineFor(line), 'Failed to authenticate now');
  });

  test('a carriage return is removed, never treated as the end of the line', () => {
    assert.strictEqual(lineFor('Failed to \rauthenticate\r\n'), 'Failed to authenticate');
  });

  test('tabs become spaces', () => {
    assert.strictEqual(lineFor('Failed:\tOAuth\texpired'), 'Failed: OAuth expired');
  });

  test('every bidi control is removed', () => {
    const controls = ['\u200e', '\u200f', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069'];
    const line = `Run ${controls.join('')}exe.txt${controls.join('')} now`;
    assert.strictEqual(lineFor(line), 'Run exe.txt now');
  });

  test('whitespace is collapsed to single spaces and trimmed', () => {
    assert.strictEqual(lineFor('   Failed    to \u00a0 authenticate   '), 'Failed to authenticate');
  });

  test('a line longer than 300 characters is cut to 300 with an ellipsis', () => {
    const line = lineFor('word '.repeat(100));
    assert.strictEqual([...line].length, 300);
    assert.ok(line.endsWith('\u2026'), 'the cut is marked with an ellipsis');
  });

  test('a line of exactly 300 characters is kept whole', () => {
    const exact = 'ab '.repeat(99) + 'abc';
    assert.strictEqual(exact.length, 300);
    assert.strictEqual(lineFor(exact), exact);
  });

  test('the cut counts characters, never splitting one in two', () => {
    const line = lineFor('\u{1F600}'.repeat(400));
    assert.strictEqual([...line].length, 300);
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(line), 'no half of a character is left at the cut');
  });
});

describe('credentials are replaced, one shape each', () => {
  test('an sk-ant- key is replaced', () => {
    assert.strictEqual(lineFor(`Invalid key ${ANT_KEY} given`), 'Invalid key [hidden] given');
  });

  test('any other sk- key is replaced', () => {
    assert.strictEqual(lineFor(`Invalid key ${OTHER_KEY}.`), 'Invalid key [hidden].');
  });

  test('a Bearer token is replaced', () => {
    assert.strictEqual(lineFor(`Authorization: Bearer ${SHORT_TOKEN} refused`), 'Authorization: Bearer [hidden] refused');
  });

  test('an x-api-key value is replaced', () => {
    assert.strictEqual(lineFor(`header x-api-key: ${SHORT_TOKEN} refused`), 'header x-api-key: [hidden] refused');
    assert.strictEqual(lineFor(`{"x-api-key":"${SHORT_TOKEN}"}`), '{"x-api-key":"[hidden]"}');
  });

  test('an ANTHROPIC_API_KEY value is replaced', () => {
    assert.strictEqual(lineFor(`ANTHROPIC_API_KEY=${SHORT_TOKEN} is invalid`), 'ANTHROPIC_API_KEY=[hidden] is invalid');
  });

  test('a CLAUDE_CODE_OAUTH_TOKEN value is replaced', () => {
    assert.strictEqual(lineFor(`CLAUDE_CODE_OAUTH_TOKEN="${SHORT_TOKEN}" expired`), 'CLAUDE_CODE_OAUTH_TOKEN="[hidden]" expired');
  });

  test('any unbroken run of 32 or more key characters is replaced', () => {
    assert.strictEqual(LONG_RUN.length >= 32, true);
    assert.strictEqual(lineFor(`session ${LONG_RUN} refused`), 'session [hidden] refused');
    const under = 'a'.repeat(31);
    assert.strictEqual(lineFor(`kept ${under} here`), `kept ${under} here`);
  });

  test('a token straddling the 300th character leaves no part of itself', () => {
    const token = 'EXAMPLEtoken'.repeat(3);
    const line = lineFor(`${'a '.repeat(145)}${token} end`);
    assert.ok(!line.includes('EXAMPLE') && !line.includes('token'), `no piece of the token is left: ${JSON.stringify(line.slice(-20))}`);
  });

  test('a token split by a control or bidi character is still replaced', () => {
    const split = `${OTHER_KEY.slice(0, 6)}\u0000${OTHER_KEY.slice(6, 12)}\u202e${OTHER_KEY.slice(12)}`;
    assert.strictEqual(lineFor(`bad ${split} key`), 'bad [hidden] key');
    const run = `${LONG_RUN.slice(0, 20)}${ESC}[0m\u0007${LONG_RUN.slice(20)}`;
    assert.strictEqual(lineFor(`bad ${run} key`), 'bad [hidden] key');
  });
});

describe('the fixed answers, which quote nothing', () => {
  test('a check that ran past its time limit is the fixed timeout answer', () => {
    const err = exitError({ code: 'ETIMEDOUT', signal: 'SIGTERM', status: null, stderr: 'Failed to authenticate' });
    assert.deepStrictEqual(sr.reasonFor(err), { kind: 'timeout' });
  });

  test("a check whose claude could not be started is the fixed not-started answer", () => {
    assert.deepStrictEqual(sr.reasonFor(exitError({ status: 127, stderr: 'sh: claude: command not found' })), { kind: 'not-started' });
    assert.deepStrictEqual(sr.reasonFor(exitError({ code: 'ENOENT', status: null })), { kind: 'not-started' });
  });

  test('a non-zero exit with no output is the fixed no-reason answer', () => {
    assert.deepStrictEqual(sr.reasonFor(exitError({ status: 1 })), { kind: 'no-reason' });
  });

  test('a line is answered as Claude Code saying it, with nothing else', () => {
    assert.deepStrictEqual(answerFor('Failed to authenticate: OAuth session expired and could not be refreshed\n'),
      { kind: 'said', text: 'Failed to authenticate: OAuth session expired and could not be refreshed', signIn: true });
  });
});

describe('whether the line reads as a sign-in failure', () => {
  for (const words of ['authenticat', 'oauth', 'log in', 'login', 'logged in', 'expired', 'credential', 'unauthori', '401', 'invalid api key']) {
    test(`a line containing "${words}" in any case reads as a sign-in failure`, () => {
      assert.strictEqual(answerFor(`Something ${words.toUpperCase()} happened`).signIn, true);
    });
  }

  test('a usage-limit line does not read as a sign-in failure', () => {
    assert.strictEqual(answerFor("You've hit your usage limit. Resets at 5pm").signIn, false);
  });

  test('a network-error line does not read as a sign-in failure', () => {
    assert.strictEqual(answerFor('API Error: Connection error.').signIn, false);
  });

  test('none of the fixed answers carries a sign-in reading', () => {
    for (const err of [exitError({ code: 'ETIMEDOUT', stderr: 'login expired' }), exitError({ status: 127, stderr: 'login' }), exitError({})]) {
      assert.strictEqual('signIn' in sr.reasonFor(err), false);
    }
  });
});

describe('the reason kept beside the check', () => {
  test('a failed check records its reason and a passing one clears it', () => {
    const reason = sr.createSignInReason();
    assert.strictEqual(reason.last(), null);
    reason.failed(exitError({ stderr: 'Failed to authenticate' }));
    assert.strictEqual(reason.last().text, 'Failed to authenticate');
    reason.passed();
    assert.strictEqual(reason.last(), null);
  });

  test("each failed check replaces the last one's reason", () => {
    const reason = sr.createSignInReason();
    reason.failed(exitError({ stderr: 'OAuth session expired' }));
    reason.failed(exitError({ code: 'ETIMEDOUT', status: null }));
    assert.deepStrictEqual(reason.last(), { kind: 'timeout' });
    reason.failed(exitError({ stderr: 'API Error: Connection error.' }));
    assert.deepStrictEqual(reason.last(), { kind: 'said', text: 'API Error: Connection error.', signIn: false });
  });

  test('when the cleaner throws, the answer is the fixed no-reason one and carries no output', () => {
    sr.deps.clean = () => { throw new Error('cleaner broke'); };
    const reason = sr.createSignInReason();
    reason.failed(exitError({ stderr: `Failed to authenticate ${OTHER_KEY}`, stdout: 'raw stdout' }));
    assert.deepStrictEqual(reason.last(), { kind: 'no-reason' });
    assert.deepStrictEqual(sr.reasonFor(exitError({ stderr: 'raw stderr' })), { kind: 'no-reason' });
  });

  test('a failed check with no error object at all is the fixed no-reason answer', () => {
    assert.deepStrictEqual(sr.reasonFor(undefined), { kind: 'no-reason' });
  });
});
