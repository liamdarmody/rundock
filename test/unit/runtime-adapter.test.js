'use strict';
// Shape-pinning tests for the runtime adapter contract
// (docs/RUNTIME-ADAPTER.md). A third runtime is additive only while the
// documented seams actually exist; these tests fail when a seam is renamed
// or removed without the contract document (and this file) moving with it.
// Source-level pinning follows the repo precedent set by regression.test.js
// and packaging.test.js: cheap, honest, and loud when the architecture
// drifts under the documentation.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf-8');
const docSrc = fs.readFileSync(path.join(ROOT, 'docs', 'RUNTIME-ADAPTER.md'), 'utf-8');

describe('runtime adapter contract: the documented seams exist', () => {
  test('the Codex protocol client exposes the turn-execution surface', () => {
    const appServer = require('../../codex-appserver.js');
    const client = appServer.createCodexAppServer({ binPath: '/nonexistent' });
    for (const method of ['start', 'shutdown', 'startThread', 'resumeThread', 'startTurn', 'interruptTurn', 'isReady']) {
      assert.strictEqual(typeof client[method], 'function', `codex-appserver client must expose ${method}()`);
    }
  });

  test('status detection stays evidence-only in codex.js', () => {
    const codex = require('../../codex.js');
    assert.strictEqual(typeof codex.detectCodex, 'function');
    assert.strictEqual(typeof codex.hasWindowsSandboxConfig, 'function');
    assert.strictEqual(typeof codex.isValidThreadId, 'function');
    // Presence-only principle: detection never reads credential contents.
    const codexSrc = fs.readFileSync(path.join(ROOT, 'codex.js'), 'utf-8');
    assert.ok(!/readFileSync\([^)]*auth\.json/.test(codexSrc), 'auth.json must never be read, only checked for existence');
  });

  test('the server routes both runtimes through the documented spawn seams', () => {
    assert.match(serverSrc, /function spawnClaude/, 'Claude spawn seam');
    assert.match(serverSrc, /function getCodexAppServer/, 'Codex shared-server seam');
    assert.match(serverSrc, /function startCodexTurn/, 'Codex turn seam');
    assert.match(serverSrc, /runtime\s*===\s*'codex'|runtime:\s*'codex'/, 'runtime routing by frontmatter field');
  });

  test('approvals route through the shared permission bridge', () => {
    assert.match(serverSrc, /function requestServerPermission/, 'server-originated permission bridge');
    assert.match(serverSrc, /handleCodexApproval|requestServerPermission\(/, 'Codex approvals use the bridge');
  });

  test('the contract document names every seam it pins', () => {
    for (const needle of ['requestServerPermission', 'detectCodex', 'spawn-argv-freeze', 'system/init', 'msg.sessionId']) {
      assert.ok(docSrc.includes(needle), `docs/RUNTIME-ADAPTER.md must mention ${needle}`);
    }
  });
});
