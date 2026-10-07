'use strict';
// The one rule for a file an extension may be handed, or may write: it
// resolves by its real location inside the workspace, nothing on the way to
// it is a link, it is not hidden after resolution, and it has no second name
// (a hard link). Every link these tests plant points inside this run's own
// temporary root, never at a real file.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { extensionFileRefusal, writeExtensionFile, REASONS } = require('../../lib/workspace/extension-file.js');
const { makeTempDir } = require('../helpers/workspace.js');

const CANARY = 'CANARY-NOT-A-REAL-KEY';

function fixture() {
  const root = makeTempDir('ext-file-');
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'notes', 'plain.csv'), 'a,b\n');
  fs.writeFileSync(path.join(workspace, '.env'), `KEY=${CANARY}\n`);
  fs.writeFileSync(path.join(outside, 'secret.csv'), `${CANARY}\n`);
  return { root, workspace, outside };
}

describe('extensionFileRefusal', () => {
  test('an ordinary file inside the workspace is handed over', () => {
    const { workspace } = fixture();
    assert.strictEqual(extensionFileRefusal(workspace, 'notes/plain.csv'), null);
  });

  test('a linked file is refused, whether it points at a hidden file or outside the workspace', () => {
    const { workspace, outside } = fixture();
    fs.symlinkSync(path.join(workspace, '.env'), path.join(workspace, 'notes', 'x.csv'));
    fs.symlinkSync(path.join(outside, 'secret.csv'), path.join(workspace, 'notes', 'y.csv'));
    assert.strictEqual(extensionFileRefusal(workspace, 'notes/x.csv'), REASONS.linked);
    assert.strictEqual(extensionFileRefusal(workspace, 'notes/y.csv'), REASONS.linked);
  });

  test('a file inside a linked folder is refused', () => {
    const { workspace, outside } = fixture();
    fs.symlinkSync(outside, path.join(workspace, 'mirror'));
    assert.strictEqual(extensionFileRefusal(workspace, 'mirror/secret.csv'), REASONS.linked);
  });

  test('a hard link, a visible second name for a file, is refused', () => {
    const { workspace } = fixture();
    fs.linkSync(path.join(workspace, '.env'), path.join(workspace, 'notes', 'hard.csv'));
    assert.strictEqual(extensionFileRefusal(workspace, 'notes/hard.csv'), REASONS.hardLink);
  });

  test('a hidden path, a missing file and a folder are refused, each by its own rule', () => {
    const { workspace } = fixture();
    assert.strictEqual(extensionFileRefusal(workspace, '.env'), REASONS.hidden);
    assert.strictEqual(extensionFileRefusal(workspace, 'notes/../.env'), REASONS.hidden);
    assert.strictEqual(extensionFileRefusal(workspace, 'notes/missing.csv'), REASONS.missing);
    assert.strictEqual(extensionFileRefusal(workspace, 'notes'), REASONS.notFile);
    assert.strictEqual(extensionFileRefusal(workspace, '../outside/secret.csv'), REASONS.hidden,
      'a traversing path is refused before anything is read');
  });

  test('a reason names the rule, never the target', () => {
    for (const reason of Object.values(REASONS)) {
      assert.doesNotMatch(reason, /\/|secret|\.env|CANARY/);
    }
  });
});

describe('writeExtensionFile', () => {
  test('writes an ordinary file and nothing else', () => {
    const { workspace } = fixture();
    assert.strictEqual(writeExtensionFile(workspace, 'notes/plain.csv', 'c,d\n'), null);
    assert.strictEqual(fs.readFileSync(path.join(workspace, 'notes', 'plain.csv'), 'utf8'), 'c,d\n');
  });

  test('never writes through a link, and leaves its target byte for byte', () => {
    const { workspace, outside } = fixture();
    fs.symlinkSync(path.join(outside, 'secret.csv'), path.join(workspace, 'notes', 'y.csv'));
    fs.linkSync(path.join(workspace, '.env'), path.join(workspace, 'notes', 'hard.csv'));
    assert.strictEqual(writeExtensionFile(workspace, 'notes/y.csv', 'overwritten'), REASONS.linked);
    assert.strictEqual(writeExtensionFile(workspace, 'notes/hard.csv', 'overwritten'), REASONS.hardLink);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'secret.csv'), 'utf8'), `${CANARY}\n`);
    assert.strictEqual(fs.readFileSync(path.join(workspace, '.env'), 'utf8'), `KEY=${CANARY}\n`);
  });
});

// ---- Where the rule is applied: every server path an extension's bytes
// travel. The page only forwards what these say. ----
describe('the server states the rule with every read, and holds it on every extension save', () => {
  const config = require('../../lib/config.js');
  const files = require('../../lib/protocol/handlers/files.js');

  function withWorkspace(fn) {
    const original = config.getWorkspace();
    const f = fixture();
    config.setWorkspace(f.workspace);
    try { return fn(f); } finally { config.setWorkspace(original); }
  }
  function ctx(workspace) {
    return {
      workspace: {
        isInsideWorkspace: (p) => path.resolve(p).startsWith(path.resolve(workspace) + path.sep),
        isWritableInWorkspace: (p) => require('../../lib/workspace/link-safe-write.js').writeLandsInside(p, [workspace]),
        watchOpenFile() {}, invalidateFileListCache() {}, invalidateFileTreeCache() {},
      },
      store: { ensureSearchEngine: () => null },
    };
  }
  function socket() {
    const sent = [];
    return { sent, send: (m) => sent.push(JSON.parse(m)) };
  }

  test('read_file carries null for an ordinary file and the rule for a linked one', () => withWorkspace(({ workspace }) => {
    fs.symlinkSync(path.join(workspace, '.env'), path.join(workspace, 'notes', 'x.csv'));
    const ws = socket();
    files.handleReadFile(ctx(workspace), ws, { type: 'read_file', path: 'notes/plain.csv' });
    files.handleReadFile(ctx(workspace), ws, { type: 'read_file', path: 'notes/x.csv' });
    assert.deepStrictEqual(ws.sent.map((m) => [m.path, m.extensionRefusal]),
      [['notes/plain.csv', null], ['notes/x.csv', REASONS.linked]]);
  }));

  test('an extension save through a link is refused and its target untouched; the editor\'s own save is unchanged', () => withWorkspace(({ workspace, outside }) => {
    fs.symlinkSync(path.join(outside, 'secret.csv'), path.join(workspace, 'notes', 'y.csv'));
    const ws = socket();
    files.handleSaveFile(ctx(workspace), ws, { type: 'save_file', path: 'notes/y.csv', content: 'overwritten', origin: 'extension' });
    assert.deepStrictEqual(ws.sent, [{ type: 'file_save_refused', path: 'notes/y.csv', reason: REASONS.linked }]);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'secret.csv'), 'utf8'), `${CANARY}\n`);
    files.handleSaveFile(ctx(workspace), ws, { type: 'save_file', path: 'notes/plain.csv', content: 'x,y\n', origin: 'extension' });
    assert.strictEqual(fs.readFileSync(path.join(workspace, 'notes', 'plain.csv'), 'utf8'), 'x,y\n');
    assert.strictEqual(ws.sent[1].type, 'file_saved');
  }));

  test('an extension save may not change the sources list of the file it writes, whether or not it declared sources', () => withWorkspace(({ workspace }) => {
    const note = '---\nsources:\n  - notes/plain.csv\n---\nbody\n';
    fs.writeFileSync(path.join(workspace, 'dash.md'), note);
    const ws = socket();
    files.handleSaveFile(ctx(workspace), ws, { type: 'save_file', path: 'dash.md', content: note.replace('notes/plain.csv', '.env'), origin: 'extension' });
    assert.deepStrictEqual(ws.sent, [{ type: 'file_save_refused', path: 'dash.md', reason: REASONS.changedList }]);
    assert.strictEqual(fs.readFileSync(path.join(workspace, 'dash.md'), 'utf8'), note);
    files.handleSaveFile(ctx(workspace), ws, { type: 'save_file', path: 'dash.md', content: note.replace('body', 'edited'), origin: 'extension' });
    assert.match(fs.readFileSync(path.join(workspace, 'dash.md'), 'utf8'), /edited/, 'an edit that keeps the list is written');
  }));

  test('/api/file always states the rule in a header, so its absence is never read as permission', () => withWorkspace(({ workspace }) => {
    fs.linkSync(path.join(workspace, '.env'), path.join(workspace, 'notes', 'hard.csv'));
    const router = require('../../lib/http-router.js');
    router.wireHttpRouterDeps({ isInsideWorkspace: () => true });
    const res = () => {
      const calls = { writeHead: [], end: [] };
      return { calls, writeHead(code, headers) { calls.writeHead.push([code, headers]); }, end(p) { calls.end.push(p); } };
    };
    const ok = res();
    router.handleHttpRequest({ url: '/api/file?path=notes%2Fplain.csv', method: 'GET' }, ok);
    assert.strictEqual(ok.calls.writeHead[0][1]['X-Rundock-Extension-Refusal'], 'none');
    const hard = res();
    router.handleHttpRequest({ url: '/api/file?path=notes%2Fhard.csv', method: 'GET' }, hard);
    assert.strictEqual(decodeURIComponent(hard.calls.writeHead[0][1]['X-Rundock-Extension-Refusal']), REASONS.hardLink);
  }));
});
