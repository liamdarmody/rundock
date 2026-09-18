'use strict';
// The workspace file-access boundary.
//
// The boundary contract: anything outside the workspace requires a
// permission card UNLESS a standing per-workspace grant covers it, and
// standing grants are at the folder level, never machine-wide. Enforcement
// lives in the PreToolUse hook (classification) and the server (grants);
// the incident this closes: an agent wrote the workspace CLAUDE.md to the
// user's HOME DIRECTORY silently, because Write/Edit were allowed
// everywhere under acceptEdits and file tools never reached the hook.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { classifyFileAccess, classifyShellAccess, canonicalize } = require('../../scripts/permission-hook.js');
const { _internal: srv } = require('../../server.js');
const { makeWorkspace, cleanup } = require('../helpers/workspace.js');
const claudeRuntime = require('../../lib/runtime/claude.js');

after(cleanup);

describe('classifyFileAccess (hook-side)', () => {
  const ws = '/tmp/boundary-ws';
  test('non-file tools are not classified', () => {
    assert.strictEqual(classifyFileAccess('Bash', { command: 'ls ~' }, ws, []), null);
    assert.strictEqual(classifyFileAccess('WebFetch', { url: 'https://x' }, ws, []), null);
  });

  test('in-workspace targets are inside, relative paths resolve against the workspace', () => {
    assert.strictEqual(classifyFileAccess('Write', { file_path: path.join(ws, 'notes.md') }, ws, []).where, 'inside');
    assert.strictEqual(classifyFileAccess('Write', { file_path: 'CLAUDE.md' }, ws, []).where, 'inside');
    assert.strictEqual(classifyFileAccess('Edit', { file_path: 'sub/dir/file.md' }, ws, []).where, 'inside');
    assert.strictEqual(classifyFileAccess('Read', { file_path: './a.md' }, ws, []).where, 'inside');
  });

  test('outside targets are outside, with the resolved path reported', () => {
    const home = os.homedir();
    const r = classifyFileAccess('Write', { file_path: path.join(home, 'CLAUDE.md') }, ws, []);
    assert.strictEqual(r.where, 'outside');
    assert.strictEqual(r.resolvedPath, path.join(home, 'CLAUDE.md'));
    // Prefix trickery is not inside: /tmp/boundary-ws-evil shares the string prefix.
    assert.strictEqual(classifyFileAccess('Write', { file_path: ws + '-evil/x.md' }, ws, []).where, 'outside');
    // Traversal out of the workspace is outside.
    assert.strictEqual(classifyFileAccess('Edit', { file_path: '../outside.md' }, ws, []).where, 'outside');
  });

  test('every file tool and its path field is covered', () => {
    const home = os.homedir();
    assert.strictEqual(classifyFileAccess('NotebookEdit', { notebook_path: path.join(home, 'n.ipynb') }, ws, []).where, 'outside');
    assert.strictEqual(classifyFileAccess('MultiEdit', { file_path: path.join(home, 'm.md') }, ws, []).where, 'outside');
    assert.strictEqual(classifyFileAccess('Read', { file_path: path.join(home, 'secrets.txt') }, ws, []).where, 'outside');
    // Glob/Grep card only when an explicit outside path is given; default cwd scan is inside.
    assert.strictEqual(classifyFileAccess('Glob', { pattern: '**/*.md' }, ws, []).where, 'inside');
    assert.strictEqual(classifyFileAccess('Grep', { pattern: 'x', path: home }, ws, []).where, 'outside');
  });

  test('extra allowed roots count as inside', () => {
    const extra = '/tmp/boundary-extra';
    const r = classifyFileAccess('Write', { file_path: path.join(extra, 'f.md') }, ws, [extra]);
    assert.strictEqual(r.where, 'inside');
  });
});

describe('classifyShellAccess (hook-side)', () => {
  // The seam this closes: a shell command is not a file tool, so
  // classifyFileAccess never looks at it, and in Code mode the hook
  // auto-approves everything the classifier returns null for. A write
  // outside the workspace therefore happened with no boundary card at all.
  //
  // The seam is SHELL COMMANDS, not Bash: on Windows the same commands run
  // through the PowerShell tool, which the scaffold registers as its own
  // matcher and which was equally unclassified.
  const ws = '/tmp/boundary-ws';
  const home = os.homedir();

  // A LEADING `cd` MOVES WHERE THE RELATIVE PATHS START FROM.
  //
  // Reported from the field, and the card was wrong in the way that is worst:
  // it named a file that does not exist. An agent asked "what can you do in
  // this workspace" ran
  //
  //   cd <ws>/.claude && ... ; cat ../.mcp.json
  //
  // which reads <ws>/.mcp.json, inside the workspace. Every relative token was
  // resolved against the workspace ROOT instead, so `../.mcp.json` was reported
  // as <ws>/../.mcp.json: one level too high, outside the workspace, and on
  // that machine not a file at all. The agent was reading its own workspace's
  // configuration to answer the question it was asked.
  //
  // The direction of the error matters. Resolving against too shallow a base
  // turns paths that climb back INTO the workspace into false crossings, so
  // this cost cards rather than containment. The fix must not buy them back by
  // spending containment, which is what the masking tests below are for.
  describe('a leading cd is where the relative paths start from', () => {
    test('the reported command: a file inside the workspace is not a crossing', () => {
      const r = classifyShellAccess('Bash', {
        command: `cd ${ws}/.claude && for f in agents/roo.md; do cat "$f"; done; cat ../.mcp.json`,
      }, ws, []);
      assert.strictEqual(r, null,
        'every path this command touches is inside the workspace, so there is no card to raise');
    });

    test('a relative cd counts too, and so does a semicolon', () => {
      assert.strictEqual(classifyShellAccess('Bash', { command: 'cd .claude && cat ../.mcp.json' }, ws, []), null);
      assert.strictEqual(classifyShellAccess('Bash', { command: 'cd .claude; cat ../.mcp.json' }, ws, []), null);
    });

    test('climbing PAST the workspace is still a crossing, from wherever it starts', () => {
      // The masking case. A deeper base must not let a token climb out unseen.
      const r = classifyShellAccess('Bash', { command: `cd ${ws}/.claude && cat ../../secret` }, ws, []);
      assert.ok(r && r.where === 'outside', 'two levels up from .claude is outside, and must still card');
      assert.ok(r.crossings.some(c => c.path.endsWith('/secret')), 'and it names the file it would actually read');
      assert.ok(!r.crossings.some(c => c.path.includes('.claude')),
        'the resolved path is the real one, not one measured from the wrong floor');
    });

    test('a cd OUT of the workspace is itself the crossing, and is not trusted as a base', () => {
      const r = classifyShellAccess('Bash', { command: 'cd /etc && cat hosts' }, ws, []);
      assert.ok(r && r.where === 'outside', 'leaving the workspace is the whole thing this card is for');
    });

    test('a cd it cannot read literally is not guessed at', () => {
      // A variable, a substitution or a glob means the base is unknown at
      // classification time. Unknown falls back to the workspace root, which
      // over-reports rather than under-reports: the safe direction.
      for (const cmd of ['cd $DIR && cat ../../x', 'cd "$(pwd)/sub" && cat ../../x', 'cd s*b && cat ../../x']) {
        const r = classifyShellAccess('Bash', { command: cmd }, ws, []);
        assert.ok(r && r.where === 'outside', `an unreadable cd must not soften the check: ${cmd}`);
      }
    });

    test('a later cd is not a base for what came before it', () => {
      // Only a LEADING cd is honoured. Anything more needs an interpreter, and
      // a half-interpreted shell is the kind of guess that masks a crossing.
      const r = classifyShellAccess('Bash', { command: `cat ../../secret && cd ${ws}/.claude` }, ws, []);
      assert.ok(r && r.where === 'outside', 'the cat runs at the workspace root, and reaches outside from there');
    });
  });

  // A SHELL CARD MAY NAME THE FOLDER IT IS ABOUT.
  //
  // It could not, and that made the offer nearly unreachable: measured across 91
  // real sessions against one workspace, 68% of boundary cards came from shell
  // commands, because an agent asked to read a file reaches for `cat` far more
  // often than for the file tool. People were told to go and name a folder in
  // Settings while standing in front of the card that knew exactly which folder
  // they meant.
  //
  // `grantable` stays FALSE and that is not what changed. A stored grant still
  // never answers a command, because everything in a command runs, not only the
  // part that touches the named folder. What the card now carries is what the
  // BUTTON would name, which is a different question from what a stored grant
  // may answer, and conflating the two is why nothing was offered.
  describe('the folder a shell card offers to name', () => {
    const home = os.homedir();

    test('a command reaching one folder offers that folder', () => {
      // A REAL DIRECTORY, because "is this a folder or a file" is answered by
      // asking the filesystem. A path that does not exist is judged by its
      // parent, which is the right guess for an unborn file and the wrong one
      // for an unborn directory; using a real folder keeps this test about the
      // offer rather than about that guess.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-one-'));
      try {
        const r = classifyShellAccess('Bash', { command: `ls -la ${dir}` }, ws, []);
        assert.strictEqual(r.grantDir, canonicalize(dir));
        assert.strictEqual(r.grantable, false,
          'and it is still not answerable from a stored grant: the button names a folder, it does not approve this command');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    test('a file names the folder holding it, not the file', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-file-'));
      try {
        fs.writeFileSync(path.join(dir, 'notes.md'), 'x');
        const r = classifyShellAccess('Bash', { command: `cat ${path.join(dir, 'notes.md')}` }, ws, []);
        assert.strictEqual(r.grantDir, canonicalize(dir));
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    test('several paths under one folder offer that folder', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-many-'));
      try {
        fs.writeFileSync(path.join(dir, 'a.md'), 'x');
        fs.writeFileSync(path.join(dir, 'b.md'), 'y');
        const r = classifyShellAccess('Bash', {
          command: `cat ${path.join(dir, 'a.md')} ${path.join(dir, 'b.md')}`,
        }, ws, []);
        assert.strictEqual(r.grantDir, canonicalize(dir));
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    test('paths with nothing in common offer nothing, rather than their ancestor', () => {
      // The failure this guard exists for: two unrelated paths meet at the
      // filesystem root, and offering that would let one click hand over the
      // machine.
      const r = classifyShellAccess('Bash', { command: `cat /etc/hosts && ls ${home}/Documents/x` }, ws, []);
      assert.strictEqual(r.grantDir, null);
    });

    test('the home directory and the shallow system folders are never offered', () => {
      for (const cmd of [`ls ${home}`, 'ls /etc', 'ls /tmp', 'ls /private/etc', 'ls /usr', 'ls /Users']) {
        const r = classifyShellAccess('Bash', { command: cmd }, ws, []);
        assert.ok(!r || r.grantDir === null, `${cmd} must offer no folder`);
      }
    });

    test('a system folder reached through its real name is refused too', () => {
      // Every crossing arrives canonicalised, and on macOS /etc IS /private/etc,
      // so a literal match against the refusal list let the real spelling walk
      // past it. Found by running the list, not by reading it.
      assert.strictEqual(classifyShellAccess('Bash', { command: 'ls /etc' }, ws, []).grantDir, null,
        '/etc canonicalises to /private/etc, and both spellings must be refused');
    });

    test('a command touching a credential offers nothing at all', () => {
      // Not merely skipped for that one path: a command that reads a credential
      // must not become the occasion for naming the folder holding it.
      const r = classifyShellAccess('Bash', {
        command: `cat ${home}/.claude/.credentials.json && ls ${home}/Documents/Somewhere`,
      }, ws, []);
      assert.strictEqual(r.grantDir, null);
    });

    test('once the folder is named, there is no card to offer anything on', () => {
      // The end state, and the whole point: a named folder is not a crossing, so
      // the question stops being asked rather than being asked more politely.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-named-'));
      try {
        assert.strictEqual(classifyShellAccess('Bash', { command: `ls -la ${dir}/Notes` }, ws, [dir]), null);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  });

  test('non-shell tools are not classified here', () => {
    assert.strictEqual(classifyShellAccess('Write', { file_path: '/etc/hosts' }, ws, []), null);
    assert.strictEqual(classifyShellAccess('WebFetch', { url: 'https://x' }, ws, []), null);
  });

  test('an ordinary command is NOT reported inside, so its own card survives', () => {
    // The load-bearing non-regression. Reporting 'inside' would make the hook
    // allow it instantly with no server round-trip, which would DELETE the
    // Bash card that knowledge mode shows today. Only a crossing is reported;
    // everything else stays null and keeps whatever card it already had.
    assert.strictEqual(classifyShellAccess('Bash', { command: 'npm test' }, ws, []), null);
    assert.strictEqual(classifyShellAccess('Bash', { command: 'git commit -m "x"' }, ws, []), null);
    assert.strictEqual(classifyShellAccess('Bash', { command: 'rm -rf node_modules' }, ws, []), null);
  });

  test('the sandbox escape hatch is a crossing, whatever the command says', () => {
    // Measured against the CLI on 2026-08-22: a command the sandbox denies is
    // retried with dangerouslyDisableSandbox true, and that retry reaches this
    // hook with the flag in tool_input. It is the one signal that does not
    // depend on reading the command text: the operating system already
    // decided, at syscall time, that this command reached outside.
    const r = classifyShellAccess('Bash', { command: 'make install', dangerouslyDisableSandbox: true }, ws, []);
    assert.strictEqual(r.where, 'outside');
    assert.strictEqual(r.grantDir, null,
      'a standing folder grant must never be offered for a sandbox escape: there is no one folder it is about');
    assert.strictEqual(r.grantable, false,
      'and the server is told no grant may answer it, so this does not rest on the crossing list happening to be empty');
  });

  test('a path outside the workspace in the command text is a crossing', () => {
    assert.strictEqual(classifyShellAccess('Bash', { command: 'touch /etc/hosts' }, ws, []).where, 'outside');
    assert.strictEqual(classifyShellAccess('Bash', { command: 'cp a.txt ' + path.join(home, 'notes.md') }, ws, []).where, 'outside');
    assert.strictEqual(classifyShellAccess('Bash', { command: 'cd /tmp && touch x' }, ws, []).where, 'outside');
  });

  test('the forms that resolve outside WITHOUT containing an absolute path', () => {
    // `cd /tmp` does NOT get past a literal-path scan: /tmp is a literal
    // absolute path. These are the forms that do, because none of them
    // contains an absolute path at all.
    assert.strictEqual(classifyShellAccess('Bash', { command: 'touch ~/probe.txt' }, ws, []).where, 'outside');
    assert.strictEqual(classifyShellAccess('Bash', { command: 'touch "$HOME/probe.txt"' }, ws, []).where, 'outside');
    assert.strictEqual(classifyShellAccess('Bash', { command: 'cp report.md ../../elsewhere/' }, ws, []).where, 'outside');
  });

  test('in-workspace paths and allowed extra roots are not crossings', () => {
    assert.strictEqual(classifyShellAccess('Bash', { command: 'touch ' + path.join(ws, 'notes.md') }, ws, []), null);
    assert.strictEqual(classifyShellAccess('Bash', { command: 'cat ./src/app.js' }, ws, []), null);
    const extra = '/tmp/boundary-extra';
    assert.strictEqual(classifyShellAccess('Bash', { command: 'ls ' + extra + '/x' }, ws, [extra]), null);
  });

  // NO TEST HERE FOR "a URL is not a path", DELIBERATELY, and this note is the
  // record so it is not added back as an oversight. One was written, passed,
  // and was deleted when mutation showed nothing could make it fail: the
  // explicit URL guard it credited was already unreachable, and so is the
  // path-shape filter that replaced the credit. A relative token resolves
  // against the workspace root, so it lands inside whatever it looks like.
  // The property is real; no mutation of this module can violate it, so a
  // test asserting it is decoration that reports green forever.

  test('PowerShell is classified exactly as Bash is', () => {
    // On Windows the shell tool is PowerShell, and the scaffold registers it
    // as its own hook matcher. A boundary that only knew about Bash would be
    // absent on one of the two platforms this product ships.
    assert.strictEqual(classifyShellAccess('PowerShell', { command: 'ni /etc/probe.txt' }, ws, []).where, 'outside');
    assert.strictEqual(classifyShellAccess('PowerShell', { command: 'ls .' }, ws, []), null);
  });

  test('a command that discards its output is not reaching outside', () => {
    // `2>/dev/null` is in a large share of real commands, and the null device
    // is not a place: a write to it stores nothing anybody can read back.
    // Carding it would put a boundary card on ordinary work, and a card that
    // fires on ordinary work is a card people learn to click through, which
    // costs more than it protects.
    assert.strictEqual(classifyShellAccess('Bash', { command: 'npm test 2>/dev/null' }, ws, []), null);
    assert.strictEqual(classifyShellAccess('Bash', { command: 'cmd > /dev/null 2>&1' }, ws, []), null);
    assert.strictEqual(classifyShellAccess('Bash', { command: '/usr/bin/env node build.js' }, ws, []), null);
    // The exemption is the null device and where interpreters live, NOT the
    // whole of the system tree.
    assert.strictEqual(classifyShellAccess('Bash', { command: 'touch /etc/hosts' }, ws, []).where, 'outside');
    assert.strictEqual(classifyShellAccess('Bash', { command: 'cat /dev/../etc/hosts' }, ws, []).where, 'outside');
  });

  test('a URL carrying enough dot-dot segments to climb out is not a crossing', () => {
    // The scheme guard is load-bearing and this is the input that shows it:
    // a URL reaches the traversal test, and with enough `..` segments it
    // resolves ABOVE the workspace and produces a card naming a folder
    // nobody is touching. Fewer segments land back on the workspace root and
    // pass either way, which is why the example has four.
    assert.strictEqual(classifyShellAccess('Bash', { command: 'curl https://example.com/../../../..' }, ws, []), null);
    assert.strictEqual(classifyShellAccess('Bash', { command: 'curl https://ex.com/../../../../../x' }, ws, []), null);
  });

  test('a system path that climbs out of an exempt directory is still a crossing', () => {
    // `/usr/bin/...` is exempt because interpreters live there, and the
    // exemption is judged on the NORMALISED token for this reason: matched
    // raw, `/usr/bin/../../etc/passwd` begins with an exempt prefix and would
    // be waved through while reading the password file.
    // Canonicalised: the reported path is the file's real name, so on macOS
    // /etc resolves through /private. The comparison goes through the hook's
    // own canonicaliser so the pin holds on hosts where /etc is no symlink.
    assert.strictEqual(classifyShellAccess('Bash', { command: 'cat /usr/bin/../../etc/passwd' }, ws, []).crossings[0].path, canonicalize('/etc/passwd'));
    assert.strictEqual(classifyShellAccess('Bash', { command: 'cat /dev/fd/../../etc/passwd' }, ws, []).crossings[0].path, canonicalize('/etc/passwd'));
  });

  test('a stored grant still never answers a shell command, whatever folder the card names', () => {
    // A folder grant answers "may an agent touch this folder"; approving a
    // shell request answers "may this command run". The second cannot be
    // inferred from the first, because everything in the command runs, not only
    // the part that touches the folder.
    //
    // THAT RULE IS `grantable`, AND IT HAS NOT MOVED. What changed is that the
    // card may now NAME a folder, which is a different question: the person
    // approves this command explicitly either way, and the button adds "and
    // work here from now on". Refusing to name one left the offer unreachable
    // on 68% of real boundary cards, which is how people ended up being told to
    // go to Settings by the very card that knew which folder they meant.
    const home = os.homedir();
    const r = classifyShellAccess('Bash', { command: `cp a ${path.join(home, 'Exports', 'a')}` }, ws, []);
    assert.strictEqual(r.where, 'outside');
    assert.strictEqual(r.grantable, false,
      'the server is told a stored grant must not answer this, which is the control that matters');
    assert.ok(r.crossings.every(c => c.grantDir === undefined),
      'and no per-crossing folder is smuggled in, which is what the server reads when deciding coverage');
  });

  test('EVERY distinct crossing is reported, not just the first', () => {
    // A single reported path is not enough, because the server decides a
    // standing folder grant against what it is given. With one path, a
    // command whose FIRST target sits in an already-granted folder is allowed
    // outright, and a second target somewhere else rides along with no card
    // at all. On macOS the sandbox may still stop that second write; on
    // Windows there is no sandbox and nothing else would.
    const home = os.homedir();
    const r = classifyShellAccess('Bash',
      { command: `cp a.md ${path.join(home, 'Exports', 'a.md')} && cp key ${path.join(home, '.ssh', 'x')}` }, ws, []);
    assert.strictEqual(r.where, 'outside');
    const paths = r.crossings.map(c => c.path);
    assert.ok(paths.includes(path.join(home, 'Exports', 'a.md')), 'the first target is reported');
    assert.ok(paths.includes(path.join(home, '.ssh', 'x')), 'and so is the second');
  });

  test('crossings follow the order the command names them, quoted or not', () => {
    // Quoted segments used to be collected before everything else, so a
    // command whose second target was quoted reported it FIRST, and the
    // card's headline target was the wrong one. The earlier order test
    // passed only because its command had no quotes.
    const home = os.homedir();
    const first = '/etc/one';
    const second = path.join(home, 'two');
    const r = classifyShellAccess('Bash', { command: `cp a ${first} && cp b "${second}"` }, ws, []);
    assert.deepStrictEqual(r.crossings.map(c => c.path), [canonicalize(first), canonicalize(second)],
      'source order, so the headline target is the one named first');
    assert.strictEqual(r.resolvedPath, canonicalize(first));
  });

  test('a path written after an equals sign is recognised too', () => {
    // Flag values and shell assignments are the two commonest places a target
    // hides in plain sight. Widening to them is an improvement to a
    // best-effort check, NOT a claim that the check is now complete: the
    // copy says what it recognises and says a spelling it does not recognise
    // raises no card.
    assert.strictEqual(classifyShellAccess('Bash', { command: 'tar --output=/etc/x .' }, ws, []).crossings[0].path, canonicalize('/etc/x'));
    const home = os.homedir();
    assert.strictEqual(classifyShellAccess('Bash', { command: 'OUT=$HOME/x; cp a "$OUT"' }, ws, []).crossings[0].path, canonicalize(path.join(home, 'x')));
    assert.strictEqual(classifyShellAccess('Bash', { command: 'run --dest=../../elsewhere' }, ws, []).where, 'outside');
  });

  test('an equals sign that is not naming a path is still not a crossing', () => {
    assert.strictEqual(classifyShellAccess('Bash', { command: 'FOO=bar npm test' }, ws, []), null);
    assert.strictEqual(classifyShellAccess('Bash', { command: 'rsync --exclude=*.js a b' }, ws, []), null);
    assert.strictEqual(classifyShellAccess('Bash', { command: 'cc -DPATH=/usr/bin/env x.c' }, ws, []), null);
  });

  test('the same target named twice is reported once', () => {
    const home = os.homedir();
    const t = path.join(home, 'notes.md');
    const r = classifyShellAccess('Bash', { command: `cp ${t} b && cp ${t} c` }, ws, []);
    assert.strictEqual(r.crossings.length, 1, 'a repeat is not a second crossing');
  });
});

describe('classifyShellAccess: native Windows command forms', () => {
  // Windows is where this matters MOST, because it is the platform with no
  // command sandbox: there the card is the entire boundary. A PowerShell
  // agent writes drive letters and backslashes, and none of those contain a
  // leading forward slash or a slash-delimited `..`, so a filter written for
  // POSIX shapes alone would let every native Windows target through with no
  // card while the release notes said Windows was covered.
  const ws = 'C:\\Users\\me\\ws';

  const outside = (command) => {
    const r = classifyShellAccess('PowerShell', { command }, ws, []);
    assert.ok(r && r.where === 'outside', `expected a crossing for: ${command}`);
    return r;
  };

  test('a drive-letter absolute path outside the workspace', () => {
    outside('ni C:\\Users\\me\\probe.txt');
    outside('ni C:/Users/me/probe.txt');
  });

  test('a UNC path is outside: it is not even this machine', () => {
    outside('cp a.md \\\\server\\share\\a.md');
  });

  test('the home shorthands PowerShell actually emits', () => {
    outside('ni ~\\probe.txt');
    outside('ni $HOME\\probe.txt');
    outside('ni $env:USERPROFILE\\probe.txt');
    outside('ni ${env:USERPROFILE}\\probe.txt');
  });

  test('backslash-delimited traversal climbs out just as ../ does', () => {
    outside('cp a.md ..\\..\\elsewhere\\');
  });

  test('a Windows path after an equals sign is recognised too', () => {
    outside('run --out=C:\\\\Users\\\\me\\\\probe.txt');
  });

  test('a target inside the workspace is not a crossing, on either separator', () => {
    assert.strictEqual(classifyShellAccess('PowerShell', { command: 'ni C:\\Users\\me\\ws\\sub\\file.txt' }, ws, []), null);
    assert.strictEqual(classifyShellAccess('PowerShell', { command: 'ni C:/Users/me/ws/sub/file.txt' }, ws, []), null);
    assert.strictEqual(classifyShellAccess('PowerShell', { command: 'ni sub\\file.txt' }, ws, []), null);
  });

  test('the POSIX exemptions still apply when the host is Windows', () => {
    // On a Windows host `path` is `path.win32`, so resolving `/dev/null`
    // first yields `C:\\dev\\null` and matches nothing. Every Git Bash
    // command carrying `2>/dev/null` or a `/usr/bin/env` shebang would then
    // raise a boundary card, which is the ordinary-work carding the
    // exemption exists to prevent. Judging the token rather than the
    // resolved path is what makes it platform-independent.
    assert.strictEqual(classifyShellAccess('Bash', { command: 'npm test 2>/dev/null' }, ws, []), null);
    assert.strictEqual(classifyShellAccess('Bash', { command: '/usr/bin/env node build.js' }, ws, []), null);
  });

  test('Windows path comparison ignores case, because the filesystem does', () => {
    assert.strictEqual(classifyShellAccess('PowerShell', { command: 'ni c:\\users\\me\\WS\\sub\\file.txt' }, ws, []), null,
      'the same folder in a different case is the same folder');
  });
});

describe('boundary grants (server-side, persisted in the workspace)', () => {
  test('grants persist to .rundock/permissions.json and cover the granted subtree only', () => {
    const dir = makeWorkspace({ agents: [] });
    srv.setWorkspace(dir);
    assert.strictEqual(srv.boundaryGrantCovers('/Users/x/Exports/file.md'), false, 'no grants yet');
    srv.addBoundaryGrant('/Users/x/Exports');
    assert.strictEqual(srv.boundaryGrantCovers('/Users/x/Exports/file.md'), true);
    assert.strictEqual(srv.boundaryGrantCovers('/Users/x/Exports/deep/nested.md'), true, 'subtree covered');
    assert.strictEqual(srv.boundaryGrantCovers('/Users/x/Exports-evil/f.md'), false, 'prefix trickery excluded');
    assert.strictEqual(srv.boundaryGrantCovers('/Users/x/other.md'), false, 'siblings not covered');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, '.rundock', 'permissions.json'), 'utf-8'));
    assert.deepStrictEqual(onDisk.allowedDirs, ['/Users/x/Exports'], 'workspace-encoded, folder-level');
  });

  test('grants are per workspace: a new workspace starts with none', () => {
    const dir2 = makeWorkspace({ agents: [] });
    srv.setWorkspace(dir2);
    assert.strictEqual(srv.boundaryGrantCovers('/Users/x/Exports/file.md'), false,
      'the previous workspace grant must not leak');
  });
});

describe('agent scratch files', () => {
  test('writing scratch and reading it back raises no approval card', () => {
    // The sequence from the field: an agent writes a working file, then reads
    // it back a step later, and the read raised an outside-the-workspace card
    // for a file the agent had just created. Scratch now resolves inside the
    // workspace, so both halves classify as inside and neither prompts.
    const ws = makeWorkspace({});
    srv.setWorkspace(ws);
    // Derive the path from the environment a spawned agent ACTUALLY receives,
    // not from the helper. Asking the helper would pass even if the spawn env
    // pointed somewhere else entirely, which is the thing worth knowing.
    const env = claudeRuntime.getSpawnEnv('convo-scratch');
    assert.ok(env.TMPDIR, 'the spawn env carries a temp directory');
    assert.strictEqual(env.TEMP, env.TMPDIR, 'all three names agree');
    assert.strictEqual(env.TMP, env.TMPDIR, 'all three names agree');

    const file = path.join(env.TMPDIR, 'some_project_scratch', 'render.html');
    for (const tool of ['Write', 'Read']) {
      const access = classifyFileAccess(tool, { file_path: file }, ws, []);
      assert.strictEqual(access.where, 'inside', `${tool} of scratch must not prompt`);
    }
  });

  test('scratch is excluded from version control without outside help', () => {
    // AC-3 asserted rather than reasoned. The scaffold does add the parent
    // directory to the workspace's .gitignore, but only when it runs, so a
    // workspace created earlier, or one whose .gitignore has since been
    // edited, would start committing working files. The directory excluding
    // itself is what makes this true regardless.
    const ws = makeWorkspace({});
    srv.setWorkspace(ws);
    const dir = claudeRuntime.getSpawnEnv(null).TMPDIR;
    const marker = path.join(dir, '.gitignore');
    assert.ok(fs.existsSync(marker), 'the scratch directory carries its own ignore file');
    assert.strictEqual(fs.readFileSync(marker, 'utf-8').trim(), '*',
      'it excludes everything inside it, itself included');
  });

  test('activating a workspace clears stale scratch, through the real switch path', () => {
    // The wiring, not the function. Every other test here calls the prune
    // directly, so all of them would still pass if the call were removed from
    // the switch path and nothing ever ran it. This one goes through the
    // server's own workspace activation, which is the way a workspace becomes
    // active for a person using the application.
    const ws = makeWorkspace({});
    srv.setWorkspace(ws);
    const dir = claudeRuntime.getSpawnEnv(null).TMPDIR;

    const stale = path.join(dir, 'stale-project');
    fs.mkdirSync(stale, { recursive: true });
    const staleFile = path.join(stale, 'render.html');
    fs.writeFileSync(staleFile, 'old');
    const fresh = path.join(dir, 'fresh.html');
    fs.writeFileSync(fresh, 'new');
    const longAgo = (Date.now() - (30 * 24 * 60 * 60 * 1000)) / 1000;
    fs.utimesSync(staleFile, longAgo, longAgo);
    fs.utimesSync(stale, longAgo, longAgo);

    // Activate it again, the way the interface does.
    srv.setWorkspace(ws);

    assert.strictEqual(fs.existsSync(stale), false, 'activation ran the prune');
    assert.strictEqual(fs.existsSync(fresh), true, 'recent scratch untouched');
  });

  test('the operating system temp directory would still have prompted', () => {
    // The counterpart, so the test above is shown to be about WHERE the file
    // is rather than about scratch files being special. This is the behaviour
    // that produced the original reports, and it is correct: that path really
    // is outside the workspace.
    const ws = makeWorkspace({});
    const outside = path.join(os.tmpdir(), 'some_project_scratch', 'render.html');
    assert.strictEqual(classifyFileAccess('Read', { file_path: outside }, ws, []).where, 'outside');
  });
});

// THE STORE'S OWN FAILURE BRANCHES.
//
// The handlers guard before reaching these, so exercising the store only
// through them leaves its own refusals untested: the guard could be removed
// from the handler and nothing would fail. These drive the module directly.
// THE ANSWER FILES ARE PROTECTED ON EVERY PLATFORM, not only where a sandbox
// runs. The sandbox denyWrite is the stronger protection and exists on macOS
// alone; these two files hold the person's own permission answers, so on a
// platform with no sandbox an agent with a shell could otherwise grant itself
// standing allows and silence every later card.
describe('an agent cannot quietly answer the questions it was asked', () => {
  const os2 = require('node:os');
  const boundary = require('../../lib/workspace/boundary.js');
  const config = require('../../lib/config.js');
  function tempWorkspace() {
    const d = fs.mkdtempSync(path.join(os2.tmpdir(), 'answer-files-'));
    fs.mkdirSync(path.join(d, '.rundock'), { recursive: true });
    return d;
  }
  const WS = path.join(os2.tmpdir(), 'answer-files-ws');

  const write = (target) => classifyFileAccess('Write', { file_path: target }, WS, [], os2.homedir(), false);
  const read = (target) => classifyFileAccess('Read', { file_path: target }, WS, [], os2.homedir(), false);

  test('writing either answer file is carded, though it sits inside the workspace', () => {
    for (const f of ['state.json', 'permissions.json']) {
      const target = path.join(WS, '.rundock', f);
      // Was `where === 'outside'`. The card is unchanged; what moved is that it
      // no longer claims a crossing to get it, which put a false heading on a
      // path plainly inside the workspace. The test name already said as much.
      assert.strictEqual(write(target).answerFile, true,
        `a write to ${f} must reach the person, not be auto-approved as ordinary workspace work`);
      assert.strictEqual(write(target).grantDir, null,
        'and no standing folder grant may be offered that would silence it next time');
    }
  });

  test('no standing folder grant covers them, however wide it is', () => {
    // Granting a PARENT of the workspace is an ordinary thing to do, and a
    // grant covers its whole subtree. Without this the grant would be
    // answering for the mechanism that records the answers.
    const original = config.getWorkspace();
    const dir = tempWorkspace();
    try {
      config.setWorkspace(dir);
      boundary.addBoundaryGrant(path.dirname(dir));
      assert.strictEqual(boundary.boundaryGrantCovers(path.join(dir, 'notes.md')), true,
        'sanity: the grant genuinely covers the workspace, so the next assertions mean something');
      for (const f of ['state.json', 'permissions.json']) {
        const target = path.join(dir, '.rundock', f);
        assert.strictEqual(boundary.crossingCovered({ path: target }), false,
          `a stored grant must never answer for ${f}`);
      }
      assert.strictEqual(boundary.crossingCovered({ path: path.join(dir, '.rundock', 'scratch', 'x.md') }), true,
        'while everything else the grant reaches is still covered by it');
    } finally { config.setWorkspace(original); }
  });

  test('reading them is ordinary workspace work', () => {
    // The protection is about answering questions, not about secrecy. Rundock
    // itself reads these constantly, and carding reads would make the
    // workspace unusable without protecting anything.
    for (const f of ['state.json', 'permissions.json']) {
      assert.strictEqual(read(path.join(WS, '.rundock', f)).where, 'inside');
    }
  });

  test('other files under .rundock stay free, so agent scratch still works', () => {
    // Agents are told to put scratch under .rundock. Protecting the folder
    // rather than the two files would take that away.
    for (const rel of ['scratch/notes.md', 'cache/x.json', 'something.json']) {
      assert.strictEqual(write(path.join(WS, '.rundock', rel)).where, 'inside',
        `${rel} is not an answer the person gave, and must not card`);
    }
  });

  // EVERY SPELLING, because the one an agent would actually type is the
  // relative one, and that is the spelling a filter designed for the
  // "does this reach outside the workspace" question skips by construction.
  // The first version of this test used the absolute path alone and passed
  // while `echo x > .rundock/permissions.json` went through untouched.
  test('a shell command writing one of them is caught however the path is spelled', () => {
    const spellings = [
      path.join(WS, '.rundock', 'permissions.json'),   // absolute
      '.rundock/permissions.json',                      // relative, the ordinary one
      './.rundock/permissions.json',                    // relative, dot-prefixed
      '.rundock/../.rundock/permissions.json',          // relative through a traversal
      path.join(WS, '.rundock', 'state.json'),
      '.rundock/state.json',
    ];
    for (const spelling of spellings) {
      const found = classifyShellAccess('Bash', { command: `echo '{}' > ${spelling}` }, WS, [], os2.homedir(), false);
      const paths = (found && found.crossings ? found.crossings : []).map((c) => c.path);
      assert.ok(paths.some((p) => p.endsWith('.json')),
        `a shell write spelled "${spelling}" has to be caught, or the lock is only on the door nobody uses`);
    }
  });

  test('an ordinary relative write inside the workspace is still free', () => {
    // The other direction, so the rule above cannot be satisfied by reporting
    // every relative token: resolving them all is new work, and it must not
    // turn ordinary workspace writing into a wall of cards.
    for (const spelling of ['notes.md', './src/app.js', '.rundock/scratch/draft.md']) {
      const found = classifyShellAccess('Bash', { command: `echo hi > ${spelling}` }, WS, [], os2.homedir(), false);
      const paths = (found && found.crossings ? found.crossings : []).map((c) => c.path);
      assert.deepStrictEqual(paths, [],
        `writing "${spelling}" is ordinary work inside the workspace and must raise nothing`);
    }
  });

  test('a shell command merely reading one of them is not', () => {
    const cmd = `cat ${path.join(WS, '.rundock', 'permissions.json')}`;
    const found = classifyShellAccess('Bash', { command: cmd }, WS, [], os2.homedir(), false);
    const paths = (found && found.crossings ? found.crossings : []).map((c) => c.path);
    assert.deepStrictEqual(paths.filter((found) => found.endsWith('permissions.json')), [],
      'reading the stored answers is not answering anything');
  });
});

describe('standing tool allows refuse rather than corrupt', () => {
  const boundary = require('../../lib/workspace/boundary.js');
  const config = require('../../lib/config.js');

  function tempWorkspace() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allows-store-'));
    fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
    return dir;
  }

  test('a blank or non-string key is never stored', () => {
    const original = config.getWorkspace();
    const dir = tempWorkspace();
    try {
      config.setWorkspace(dir);
      for (const bad of ['', '   ', null, undefined, 42, {}]) {
        boundary.addToolAllow(bad);
      }
      assert.deepStrictEqual(boundary.readToolAllows(), [],
        'nothing silences a card on the strength of a key that says nothing');
    } finally { config.setWorkspace(original); }
  });

  test('the same key twice is stored once', () => {
    const original = config.getWorkspace();
    const dir = tempWorkspace();
    try {
      config.setWorkspace(dir);
      boundary.addToolAllow('Bash:git');
      boundary.addToolAllow('Bash:git');
      assert.deepStrictEqual(boundary.readToolAllows(), ['Bash:git']);
    } finally { config.setWorkspace(original); }
  });

  test('a store holding something other than a list of strings reads as nothing allowed', () => {
    // The safe direction again: a file whose shape is wrong must make the card
    // appear, never let a request through on the strength of it.
    const original = config.getWorkspace();
    const dir = tempWorkspace();
    try {
      config.setWorkspace(dir);
      fs.writeFileSync(path.join(dir, '.rundock', 'permissions.json'),
        JSON.stringify({ allowedTools: ['Bash:git', 7, null, '', { k: 1 }] }));
      assert.deepStrictEqual(boundary.readToolAllows(), ['Bash:git'],
        'only the entries that are actually keys survive the read');
      fs.writeFileSync(path.join(dir, '.rundock', 'permissions.json'),
        JSON.stringify({ allowedTools: 'Bash:git' }));
      assert.deepStrictEqual(boundary.readToolAllows(), [],
        'and a value that is not a list at all allows nothing');
    } finally { config.setWorkspace(original); }
  });

  // A STORE THAT CANNOT BE WRITTEN MUST NOT REPORT SUCCESS.
  //
  // The catch exists so a disk failure degrades to "the card keeps appearing"
  // rather than crashing the server mid-permission-decision. What it must never
  // do is return the key as though it were stored: the interface would show a
  // standing allow that the next read cannot find, and the person would believe
  // they had answered once when they had not.
  function unwritableStore(dir) {
    // A directory where the file belongs: writeFileSync raises EISDIR, which is
    // a real failure of the same shape as a permissions or disk error, without
    // needing to stub the filesystem module.
    fs.mkdirSync(path.join(dir, '.rundock', 'permissions.json'), { recursive: true });
  }

  test('a grant that cannot be written is not reported as granted', () => {
    const original = config.getWorkspace();
    const dir = tempWorkspace();
    try {
      config.setWorkspace(dir);
      unwritableStore(dir);
      assert.deepStrictEqual(boundary.addToolAllow('Bash:git'), [],
        'the caller is told what is actually stored, which is nothing');
      assert.deepStrictEqual(boundary.readToolAllows(), [],
        'and the next read agrees, so the card will appear again');
    } finally { config.setWorkspace(original); }
  });

  test('a revoke that cannot be written is not reported as revoked', () => {
    const original = config.getWorkspace();
    const dir = tempWorkspace();
    try {
      config.setWorkspace(dir);
      boundary.addToolAllow('Bash:git');
      // Read-only, not replaced: the revoke must be able to READ the grant it
      // is trying to remove and still fail to write the removal. A store the
      // read also fails on would exit early and never reach the branch.
      const file = path.join(dir, '.rundock', 'permissions.json');
      fs.chmodSync(file, 0o444);
      assert.deepStrictEqual(boundary.removeToolAllow('Bash:git'), ['Bash:git'],
        'a revoke that did not land reports the grant as still standing, never as removed');
      fs.chmodSync(file, 0o644);
      assert.deepStrictEqual(boundary.readToolAllows(), ['Bash:git'],
        'and the grant is genuinely still there, which is why the revoke must not have claimed otherwise');
    } finally { config.setWorkspace(original); }
  });

  // ONE FILE, TWO SECTIONS, AND NEITHER WRITER MAY EAT THE OTHER.
  //
  // addBoundaryGrant used to compose the whole object as `{ allowedDirs }`,
  // which was correct for exactly as long as folder grants were the only thing
  // in the file. Adding tool allows to the same file made it a bug that
  // destroys data: allowing one folder would have silently deleted every
  // standing tool allow in that workspace.
  test('allowing a folder keeps the tool allows, and allowing a tool keeps the folders', () => {
    const original = config.getWorkspace();
    const dir = tempWorkspace();
    try {
      config.setWorkspace(dir);
      boundary.addToolAllow('Bash:git');
      boundary.addBoundaryGrant(dir);
      assert.deepStrictEqual(boundary.readToolAllows(), ['Bash:git'],
        'a folder grant must not take the tool allows with it');
      assert.strictEqual(boundary.readBoundaryGrants().length, 1, 'sanity: the folder was recorded');

      boundary.addToolAllow('Bash:npm');
      assert.strictEqual(boundary.readBoundaryGrants().length, 1,
        'and a tool allow must not take the folder grants with it');
      assert.deepStrictEqual(boundary.readToolAllows(), ['Bash:git', 'Bash:npm']);
    } finally { config.setWorkspace(original); }
  });

  test('a section this version has never heard of survives being written around', () => {
    // The same rule, stated against the future rather than the present: the
    // merging writer carries through keys it does not know, so a workspace
    // written by a newer Rundock is not quietly stripped by an older one.
    const original = config.getWorkspace();
    const dir = tempWorkspace();
    try {
      config.setWorkspace(dir);
      const file = path.join(dir, '.rundock', 'permissions.json');
      fs.writeFileSync(file, JSON.stringify({ allowedTools: [], somethingLater: { keep: 'me' } }));
      boundary.addToolAllow('Bash:git');
      const after = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.deepStrictEqual(after.somethingLater, { keep: 'me' },
        'a writer that owns one field must leave every other field exactly as it found it');
      assert.deepStrictEqual(after.allowedTools, ['Bash:git']);
    } finally { config.setWorkspace(original); }
  });

  test('with no workspace open, reading is empty and writing is a no-op', () => {
    const original = config.getWorkspace();
    try {
      config.setWorkspace(null);
      assert.deepStrictEqual(boundary.readToolAllows(), []);
      assert.deepStrictEqual(boundary.addToolAllow('Bash:git'), [],
        'there is nowhere to record it, so nothing is recorded');
      assert.deepStrictEqual(boundary.removeToolAllow('Bash:git'), []);
    } finally { config.setWorkspace(original); }
  });
});
