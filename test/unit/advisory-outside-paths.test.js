'use strict';
// A CARD THAT SAYS WHAT THE COMMAND ACTUALLY REACHES.
//
// The boundary check inspects tokens that look like paths. That is the right
// basis for a decision, because it does not guess. It also means a path inside
// a quoted interpreter argument is invisible to it:
//
//   cat /Users/me/.ssh/id_rsa                                -> a crossing
//   python3 -c "print(open('/Users/me/.ssh/id_rsa').read())" -> not a crossing
//
// Measured across every evading shape tried (python -c, node -e, sh -c, awk
// getline, command substitution): all of them are carded anyway, by the risk
// grader, because invoking an interpreter grades above the read-only commands
// that auto-approve. Nothing was silently allowed. What was wrong is that the
// card asked "may this command run" without saying that the command reads a
// file outside the workspace, which is easy to approve while reading past.
//
// This scan exists to word that card. It must never decide anything, and the
// last describe block is the one that enforces it.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const hook = require(path.join(ROOT, 'scripts', 'permission-hook.js'));

const fs = require('node:fs');
const os = require('node:os');

// A REAL FILE, OUTSIDE A REAL WORKSPACE. The scan names only targets that
// exist (or whose parent exists and whose name looks like a file), because a
// scan over raw text otherwise reports fragments of paths that contain spaces.
// A fictional path would test the wrong thing now: it would pass by being
// rejected.
// Canonicalised, because the scan reports the resolved form and macOS resolves
// /var to /private/var. Comparing an unresolved fixture against a resolved
// result fails on a difference that is not the one under test.
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-advisory-')));
const OUTSIDE_DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'outside-')));
const SECRET = path.join(OUTSIDE_DIR, 'id_rsa');
fs.writeFileSync(SECRET, 'PRIVATE KEY');

describe('it sees what the tokeniser cannot', () => {
  const EVADERS = [
    ['python -c', `python3 -c "print(open('${SECRET}').read())"`],
    ['node -e', `node -e "console.log(require('fs').readFileSync('${SECRET}','utf8'))"`],
    ['sh -c', `sh -c "cat ${SECRET}"`],
    ['awk getline', `awk 'BEGIN{while((getline l < "${SECRET}")>0) print l}'`],
    ['substitution', `cat "$(echo ${SECRET})"`],
  ];

  for (const [name, command] of EVADERS) {
    test(`${name}: the path is named even though it is not a crossing`, () => {
      const found = hook.advisoryOutsidePaths(command, WS, []);
      assert.ok(found.includes(SECRET),
        `the card would ask whether a command may run without saying it reads ${SECRET}`);
    });
  }
});

describe('it stays quiet when there is nothing to say', () => {
  test('a path inside the workspace is not named', () => {
    assert.deepStrictEqual(
      hook.advisoryOutsidePaths(`cat ${path.join(WS, 'notes.md')}`, WS, []), []);
  });

  test('a named working folder is not named', () => {
    const folder = path.join(path.sep + 'private', 'tmp', 'claude');
    const found = hook.advisoryOutsidePaths(`cat ${path.join(folder, 'page.html')}`, WS, [folder]);
    assert.deepStrictEqual(found, [],
      'a folder the workspace already names is not outside it');
  });

  test('a command with no paths says nothing', () => {
    assert.deepStrictEqual(hook.advisoryOutsidePaths('echo hello && date', WS, []), []);
  });

  test('a url is not a file path', () => {
    assert.deepStrictEqual(hook.advisoryOutsidePaths('curl https://example.com/a/b', WS, []), []);
  });

  test('nothing sensible to scan is not an error', () => {
    for (const bad of [undefined, null, '', 42, {}]) {
      assert.deepStrictEqual(hook.advisoryOutsidePaths(bad, WS, []), [],
        'a label that can throw would take down the path it is labelling');
    }
  });

  test('a very long command yields a label, not an inventory', () => {
    // Real files, or the scan names none of them and this passes by finding
    // nothing rather than by capping something.
    const files = Array.from({ length: 40 }, (_, i) => {
      const f = path.join(OUTSIDE_DIR, `f${i}.txt`);
      fs.writeFileSync(f, 'x');
      return f;
    });
    const many = files.join(' ');
    assert.ok(hook.advisoryOutsidePaths(`cat ${many}`, WS, []).length <= 8,
      'a card naming forty paths is a wall of text, which is the problem this '
      + 'set out to fix rather than a stronger version of the fix');
  });
});

describe('it cannot change a decision', () => {
  // THE PROPERTY THAT MATTERS. This scan over-matches on purpose: a path in a
  // comment, in prose, or in a string that is never opened all count. That is
  // the correct failure direction for a label and the wrong one for a gate, so
  // the two must not be able to touch.
  const hookSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'permission-hook.js'), 'utf8');
  const routerSrc = fs.readFileSync(path.join(ROOT, 'lib', 'http-router.js'), 'utf8');

  test('the server relays the advisory field without deciding from it', () => {
    // THE INTENT, NOT THE WORD. This asserted the router never mentioned the
    // field at all, which was true only while the field never reached the
    // client: the request object is built from a whitelist, so the advisory
    // list was computed, sent, and silently dropped, and the card it exists to
    // word never changed. Relaying it is now required.
    //
    // What must stay true is that it reaches no decision. The router allows or
    // cards from `crossings`, `uncovered` and `grantable`; an over-matching
    // scan reaching any of those would deny real work.
    assert.match(routerSrc, /advisory_outside_paths: data\.advisory_outside_paths/,
      'the field must be relayed, or the card cannot show it');

    for (const m of routerSrc.matchAll(/advisory_outside_paths/g)) {
      const line = routerSrc.slice(routerSrc.lastIndexOf('\n', m.index) + 1,
        routerSrc.indexOf('\n', m.index));
      assert.ok(!/\b(uncovered|grantable|allow|deny|crossingCovered)\b/.test(line),
        `the advisory list appears on a decision line, which would let an `
        + `over-matching scan change what is permitted: ${line.trim()}`);
    }
  });

  test('the advisory value never feeds crossings or grantable', () => {
    const at = hookSrc.indexOf('const advisory =');
    assert.ok(at > -1, 'the advisory is still computed');
    const after = hookSrc.slice(at, at + 900);
    assert.ok(!/crossings\s*[=:]\s*advisory|grantable\s*[=:]\s*advisory/.test(after),
      'the advisory must not be assigned into either decision input');
  });

  test('classifying a command is unaffected by what the advisory finds', () => {
    const command = `python3 -c "print(open('${SECRET}').read())"`;
    assert.ok(hook.advisoryOutsidePaths(command, WS, []).length > 0, 'the label finds it');
    assert.strictEqual(hook.classifyShellAccess('Bash', { command }, WS, []), null,
      'and the decision is exactly what it was before: not a crossing, left to '
      + 'the risk grader, which cards an interpreter invocation');
  });
});

describe('a workspace whose path contains a space', () => {
  // FOUND IN PRODUCTION USE, on a workspace whose folder name contains a
  // space, which is entirely ordinary: "/Users/me/Documents/My Notes/work".
  //
  // The scan reads raw command text, so it splits that path at the space and
  // produces "/Users/me/Documents/My" plus a fragment. Neither exists,
  // both resolve outside the workspace, and every ordinary command in that
  // workspace would have been labelled as reaching outside it.
  //
  // A label that fires on everything is worse than no label: it teaches the
  // reader to skip the line, which is precisely the habit the whole permission
  // storm work exists to stop. This nearly shipped.
  const WS_WITH_SPACE = path.join(
    path.sep + 'Users', 'someone', 'Documents', 'My Notes', 'work');

  test('an ordinary command inside it names nothing', () => {
    const command = `python3 -c "d=open('${path.join(WS_WITH_SPACE, 'notes.json')}')"`;
    assert.deepStrictEqual(hook.advisoryOutsidePaths(command, WS_WITH_SPACE, []), [],
      'the workspace path was split at its space and the fragments named as '
      + 'outside locations');
  });

  test('and a real file outside is still named', () => {
    // The fix must not buy quiet by going blind.
    const real = path.join(require('node:os').homedir(), '.zshrc');
    if (!fs.existsSync(real)) return;
    const command = `python3 -c "print(open('${real}').read())"`;
    assert.ok(hook.advisoryOutsidePaths(command, WS_WITH_SPACE, []).includes(real));
  });

  test('a file about to be created outside is named', () => {
    // A REAL DIRECTORY THIS TEST MADE, not a platform path. This named
    // /private/tmp/claude, which exists on macOS and not on Linux, so the scan
    // correctly named nothing on CI and the assertion failed: the test was
    // asserting a property of the machine rather than of the code.
    const command = `curl https://x.example -o ${path.join(OUTSIDE_DIR, 'fresh.html')}`;
    const found = hook.advisoryOutsidePaths(command, WS_WITH_SPACE, []);
    assert.ok(found.some((p) => p.endsWith('fresh.html')),
      'writing somewhere outside is worth naming even before the file exists');
  });

  test('a directory fragment that happens to have a real parent is not named', () => {
    // The narrow case the existence check alone could not separate.
    const command = 'echo /Users/someone/Documents/My';
    assert.deepStrictEqual(hook.advisoryOutsidePaths(command, WS_WITH_SPACE, []), [],
      'a fragment whose parent exists would be named by a parent-exists rule alone');
  });
});
