'use strict';
// SCRATCH STAYS INSIDE THE WORKSPACE, and the agent has to be told.
//
// Rundock already points TMPDIR, TEMP and TMP at a scratch folder inside the
// workspace, so an agent using the platform temp path writes somewhere that is
// already inside the boundary. Measured on a live workspace, that redirection
// works: the runtime's own temp files land in .rundock/scratch.
//
// An agent that hardcodes /tmp bypasses it entirely, and that is what happened
// in real use: a specialist wrote /tmp/claude/rundock_docs.html and then raised
// an approval card on every attempt to read the file back. Every attempt,
// because a shell command that reaches outside the workspace is deliberately
// not grantable (classifyShellAccess returns grantable: false), so no standing
// grant can ever cover it. The approval storm was correct behaviour about a
// file that should never have been written there.
//
// THE PROMPT NOW NAMES THE FOLDER, NOT THE VARIABLE. Telling agents to use
// $TMPDIR did not hold: the runtime's sandbox gives each command a TMPDIR of
// its own, outside the workspace, and the Code-mode check grades a delete
// through a variable as always asking, because it cannot know where the
// variable points. The redirection below still matters, for tools that ask the
// platform; what an agent is told is the folder's full path.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..', '..');

describe('the platform prompt tells agents where scratch goes', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'agents', 'prompt.js'), 'utf8');

  test('it names the folder the spawn points TMPDIR at, rather than the variable', () => {
    assert.match(src, /const scratch = scratchDir\(\)/,
      'the same helper the spawn environment uses, so the folder named and the '
      + 'folder created cannot disagree');
    assert.match(src, /use the folder \$\{scratchFolder\}/);
    assert.doesNotMatch(src, /use the path in \$TMPDIR/,
      'the variable is not the thing to use: the sandbox replaces it, and a '
      + 'delete through it always asks');
  });

  test('and says plainly not to use the variables or a literal temp path', () => {
    assert.match(src, /Do not use \$TMPDIR, TEMP, TMP or \/tmp for scratch/);
  });

  test('and says why, because "it needs approval" invites working around it', () => {
    assert.match(src, /Rundock can't tell where a variable points when a command runs/);
    assert.match(src, /standing folder grant/,
      'an agent told only that something is disallowed will look for another '
      + 'route to the same place; told that the card cannot be dismissed, it '
      + 'has a reason to use the folder that works');
  });
});

describe('the redirection the rule depends on is still wired', () => {
  // DRIVEN, NOT READ. The first version of this checked that the strings
  // "env.TMPDIR =", "env.TEMP =" and "env.TMP =" appeared in the source, and
  // separately that a function named scratchDir mentioned rundockDir nearby.
  // Neither called the spawn-env builder, and the two checks were not linked:
  // a build setting env.TMPDIR to the operating system's temp directory,
  // alongside an unused scratchDir, would have passed both while writing every
  // scratch file outside the workspace. The claim the rule rests on was
  // unfalsifiable by the test meant to protect it.
  const os = require('node:os');
  const claudeRuntime = require(path.join(ROOT, 'lib', 'runtime', 'claude.js'));
  const config = require(path.join(ROOT, 'lib', 'config.js'));

  test('all three platform variables point inside the workspace', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-ws-'));
    fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
    const original = config.getWorkspace();
    try {
      config.setWorkspace(dir);
      claudeRuntime.wireClaudeRuntimeDeps({ getActualPort: () => 0 });
      const env = claudeRuntime.getSpawnEnv();
      const root = fs.realpathSync(dir);
      for (const v of ['TMPDIR', 'TEMP', 'TMP']) {
        assert.ok(env[v], `${v} is unset, so an agent on that platform writes outside the workspace`);
        const resolved = fs.realpathSync(env[v]);
        assert.ok(resolved === root || resolved.startsWith(root + path.sep),
          `${v} is ${env[v]}, which is not inside the workspace, so every scratch `
          + 'file an agent writes raises an approval card on the way back');
      }
    } finally {
      config.setWorkspace(original);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the folder is real, so the first write does not fail', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-ws2-'));
    fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
    const original = config.getWorkspace();
    try {
      config.setWorkspace(dir);
      claudeRuntime.wireClaudeRuntimeDeps({ getActualPort: () => 0 });
      const env = claudeRuntime.getSpawnEnv();
      assert.ok(fs.existsSync(env.TMPDIR),
        'pointing at a folder that does not exist sends the agent back to /tmp');
    } finally {
      config.setWorkspace(original);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
