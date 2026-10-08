'use strict';
// A system error, said in one plain sentence with the raw words behind
// "Details" (public/readable-error.js).
//
// THE SENTENCE IS BUILT ONLY FROM FIXED WORDS AND THE CALLER'S ACTION, so the
// path an error names can never reach it. Every case below carries an
// invented path in its message and asserts it is absent from the sentence and
// present in the detail.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const RE = require('../../public/readable-error.js');

const WIN_PATH = 'C:\\Users\\example\\Workspace\\notes\\plan.md';
const POSIX_PATH = '/home/example/workspace/notes/plan.md';

function osError(code, syscall, filePath, text) {
  const e = new Error(text || `${code}: something low-level, ${syscall} '${filePath}'`);
  e.code = code; e.syscall = syscall; e.path = filePath; e.errno = -1;
  return e;
}

// The copy rules every sentence is held to.
function assertCopy(sentence) {
  assert.ok(!/[\u2013\u2014]/.test(sentence), `no en or em dash: ${sentence}`);
  assert.ok(!/sign in/i.test(sentence), `no "sign in": ${sentence}`);
  assert.ok(!/\byou (did|made|caused)\b/i.test(sentence), `never blames: ${sentence}`);
  assert.ok(!/[A-Za-z]:\\|\/home\/|\\\\\?\\/.test(sentence), `no path: ${sentence}`);
  assert.ok(!/\bE[A-Z]{3,}\b/.test(sentence), `no raw code: ${sentence}`);
  assert.match(sentence, /^Rundock couldn't /);
  assert.match(sentence, /\. [^.]*try again[^.]*\.$/i, `ends on a next step: ${sentence}`);
}

describe('each mapped code', () => {
  const expected = {
    EPERM: /didn't allow/,
    EACCES: /doesn't have permission/,
    EBUSY: /another program is using/,
    ENOENT: /couldn't be found/,
    ENAMETOOLONG: /too long/,
    EXDEV: /between two drives/,
    ENOSPC: /drive is full/,
    EROFS: /read-only/,
    EEXIST: /already exists/,
    ENOTEMPTY: /isn't empty/,
    EISDIR: /a folder where a file should be/,
    ENOTDIR: /where a folder should be/,
    EMFILE: /too many files/,
    ENFILE: /too many files/,
    ETIMEDOUT: /connection failed/,
    ENOTFOUND: /connection failed/,
  };
  for (const [code, words] of Object.entries(expected)) {
    test(`${code} says why in plain words and keeps the path in Details`, () => {
      const r = RE.describe(osError(code, 'open', WIN_PATH), { action: 'save this file' });
      assert.ok(r, `${code} is described`);
      assert.match(r.message, words);
      assert.match(r.message, /^Rundock couldn't save this file because /);
      assertCopy(r.message);
      assert.ok(!r.message.includes(WIN_PATH));
      assert.ok(r.detail.includes(WIN_PATH), 'the path is in the detail');
      assert.ok(r.detail.includes(code), 'the code is in the detail');
    });
  }

  test('every code in the table passes the copy rules, both clauses', () => {
    for (const code of Object.keys(RE.CODES)) {
      for (const syscall of ['unlink', 'open']) {
        const r = RE.describe(osError(code, syscall, POSIX_PATH), { action: 'install the package' });
        assertCopy(r.message);
        assert.ok(!r.message.includes(POSIX_PATH));
      }
    }
  });
});

describe('what Rundock was doing', () => {
  test('a precise system call names the operation, as in the card example', () => {
    const r = RE.describe(osError('EBUSY', 'unlink', WIN_PATH), { action: 'install the package' });
    assert.strictEqual(r.message,
      "Rundock couldn't remove a file because another program is using it. Close the program that has it open, then try again.");
  });

  test('a call that adds nothing (open, write) falls back to the caller\'s action', () => {
    const r = RE.describe(osError('EPERM', 'open', WIN_PATH), { action: 'save this file' });
    assert.match(r.message, /^Rundock couldn't save this file because your computer didn't allow a change to a file\./);
  });

  test('no action and no precise call still makes a sentence', () => {
    const r = RE.describe(osError('EACCES', 'stat', WIN_PATH));
    assert.match(r.message, /^Rundock couldn't finish that because /);
  });

  test('rename, mkdir and rmdir name their operations', () => {
    assert.match(RE.describe(osError('EXDEV', 'rename', WIN_PATH)).message, /^Rundock couldn't move a file /);
    assert.match(RE.describe(osError('EACCES', 'mkdir', WIN_PATH)).message, /^Rundock couldn't create a folder /);
    assert.match(RE.describe(osError('ENOTEMPTY', 'rmdir', WIN_PATH)).message, /^Rundock couldn't remove a folder /);
  });

  test('a program that is missing is said as missing, not as a lost file', () => {
    const e = osError('ENOENT', 'spawn claude', undefined, 'spawn claude ENOENT');
    const r = RE.describe(e, { action: 'run the routine' });
    assert.match(r.message, /^Rundock couldn't start a program because it isn't installed or couldn't be found\. Check that it's installed/);
    assert.strictEqual(r.detail, 'spawn claude ENOENT');
  });
});

describe('the raw message Windows actually showed', () => {
  // The shape a recursive remove raised on Windows in 0.15.2: a code, a comma,
  // and a long path, with no system call to say which operation it was.
  const raw = 'EPERM, Permission denied: \\\\?\\C:\\Users\\example\\AppData\\Local\\Temp\\rundock-x\\.git\\objects\\pack\\p.idx';

  test('a code read from the message of an error that kept it', () => {
    const e = new Error(raw); e.code = 'EPERM';
    const r = RE.describe(e, { action: 'install the package' });
    assert.match(r.message, /^Rundock couldn't install the package because your computer didn't allow a change to a file\./);
    assertCopy(r.message);
    assert.strictEqual(r.detail, raw);
  });

  test('a wrapped error that lost its code is still recognised from its message', () => {
    const r = RE.describe(new Error(`could not tidy up: ${raw}`), { action: 'install the package' });
    assert.ok(r, 'described');
    assert.ok(!r.message.includes('AppData'));
  });

  test('a stored string (a run record\'s reason) is described too', () => {
    const r = RE.describe(raw, { action: 'run the routine' });
    assert.match(r.message, /^Rundock couldn't run the routine because /);
  });

  test('the detail names the code even when the message does not', () => {
    const e = Object.assign(new Error('resource busy or locked'), { code: 'EBUSY', syscall: 'unlink' });
    assert.strictEqual(RE.describe(e).detail, 'EBUSY: resource busy or locked');
  });

  test('the code is read from a cause when the wrapper has none', () => {
    const outer = new Error('the install stopped');
    outer.cause = osError('EBUSY', 'unlink', WIN_PATH);
    assert.strictEqual(RE.codeOf(outer), 'EBUSY');
  });
});

describe('unknown codes and errors that are not the system\'s', () => {
  test('an unmapped system code falls back to a plain generic sentence', () => {
    for (const code of ['EIO', 'ELOOP', 'UNKNOWN', 'EINVAL']) {
      const r = RE.describe(osError(code, 'open', WIN_PATH), { action: 'save this file' });
      assert.strictEqual(r.message,
        "Rundock couldn't save this file because something unexpected went wrong. Try again, and if it keeps happening, include the details when you report it.");
      assertCopy(r.message);
      assert.ok(r.detail.includes(code));
    }
  });

  test('a domain code is not re-worded, so clients can still classify by it', () => {
    const e = new Error('The package has nothing to add.'); e.code = 'empty-package';
    assert.strictEqual(RE.describe(e), null);
    assert.deepStrictEqual(RE.readable(e), { message: 'The package has nothing to add.', detail: null });
  });

  test('Node\'s own ERR_ codes are not taken for system errors', () => {
    const e = new TypeError('The "path" argument must be of type string'); e.code = 'ERR_INVALID_ARG_TYPE';
    assert.strictEqual(RE.describe(e), null);
  });

  test('a capitalised word in a message is never taken for a code', () => {
    assert.strictEqual(RE.describe(new Error('ERROR: EVERYTHING failed')), null);
  });

  test('readable keeps the caller\'s fallback for an error with no system code', () => {
    const r = RE.readable(new Error('No workspace is open.'), { action: 'open this workspace', fallback: 'Could not open workspace: No workspace is open.' });
    assert.deepStrictEqual(r, { message: 'Could not open workspace: No workspace is open.', detail: null });
  });

  test('readable answers with the sentence and detail for a system error', () => {
    const r = RE.readable(osError('EBUSY', 'unlink', WIN_PATH), { fallback: 'unused' });
    assert.match(r.message, /another program is using it/);
    assert.ok(r.detail.includes(WIN_PATH));
  });
});

describe('the Details control', () => {
  test('is the permission card\'s disclosure, labelled Details, with the detail escaped', () => {
    const html = RE.detailsHtml('EPERM: <x> & "y" C:\\a');
    assert.match(html, /^<details class="permission-detail-collapse error-details"><summary>Details<\/summary><code class="permission-detail">/);
    assert.ok(html.includes('&lt;x&gt; &amp; &quot;y&quot;'));
    assert.ok(!html.includes('<x>'));
  });

  test('is absent when there is nothing to disclose', () => {
    assert.strictEqual(RE.detailsHtml(null), '');
    assert.strictEqual(RE.detailsHtml('   '), '');
  });
});
