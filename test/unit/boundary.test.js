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

const { classifyFileAccess, classifyShellAccess } = require('../../scripts/permission-hook.js');
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

  test('a target inside the workspace is not a crossing, on either separator', () => {
    assert.strictEqual(classifyShellAccess('PowerShell', { command: 'ni C:\\Users\\me\\ws\\sub\\file.txt' }, ws, []), null);
    assert.strictEqual(classifyShellAccess('PowerShell', { command: 'ni C:/Users/me/ws/sub/file.txt' }, ws, []), null);
    assert.strictEqual(classifyShellAccess('PowerShell', { command: 'ni sub\\file.txt' }, ws, []), null);
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
