'use strict';
// The edges of the file handlers that the main protocol suite doesn't reach:
// a save whose target is a link at the last step (refused with the rule's own
// words, nothing written), a save that fails for any other reason (the error
// is not swallowed), and Reveal in Finder (only for a path inside the
// workspace, only on macOS, and only with the fixed `open -R` command).
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const config = require('../../lib/config.js');
const files = require('../../lib/protocol/handlers/files.js');

function withWorkspace(fn) {
  const original = config.getWorkspace();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'files-edges-')));
  config.setWorkspace(dir);
  try {
    return fn(dir);
  } finally {
    config.setWorkspace(original);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function recorder() {
  const sent = [];
  return { sent, ws: { send: (m) => sent.push(JSON.parse(m)) } };
}

const insideCtx = { workspace: { isInsideWorkspace: () => true, isWritableInWorkspace: () => true } };

describe('saving a file', () => {
  test('a target that is a link at the last step is refused, and nothing is written through it', () => {
    withWorkspace((dir) => {
      fs.writeFileSync(path.join(dir, 'real.md'), 'original\n');
      fs.symlinkSync(path.join(dir, 'real.md'), path.join(dir, 'link.md'));
      const { sent, ws } = recorder();
      files.handleSaveFile(insideCtx, ws, { path: 'link.md', content: 'changed\n' });
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0].type, 'file_save_refused');
      assert.strictEqual(sent[0].path, 'link.md');
      assert.match(sent[0].reason, /link to somewhere outside the workspace/);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'real.md'), 'utf8'), 'original\n');
    });
  });

  test('a write that fails for any other reason is not swallowed', () => {
    withWorkspace((dir) => {
      fs.mkdirSync(path.join(dir, 'a-folder'));
      const { sent, ws } = recorder();
      assert.throws(() => files.handleSaveFile(insideCtx, ws, { path: 'a-folder', content: 'x' }));
      assert.deepStrictEqual(sent, []);
    });
  });
});

describe('Reveal in Finder', () => {
  function spying(fn) {
    const original = childProcess.spawn;
    const calls = [];
    childProcess.spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() {} }; };
    try { fn(calls); } finally { childProcess.spawn = original; }
  }

  test('a path inside the workspace is revealed with the fixed command, on macOS', { skip: process.platform !== 'darwin' }, () => {
    withWorkspace((dir) => {
      spying((calls) => {
        files.handleRevealInFinder(insideCtx, recorder().ws, { path: 'notes/a.md' });
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].cmd, 'open');
        assert.deepStrictEqual(calls[0].args, ['-R', path.join(dir, 'notes', 'a.md')]);
      });
    });
  });

  test('a path outside the workspace starts nothing', () => {
    withWorkspace(() => {
      spying((calls) => {
        const outsideCtx = { workspace: { isInsideWorkspace: () => false } };
        files.handleRevealInFinder(outsideCtx, recorder().ws, { path: '../elsewhere' });
        assert.strictEqual(calls.length, 0);
      });
    });
  });
});
