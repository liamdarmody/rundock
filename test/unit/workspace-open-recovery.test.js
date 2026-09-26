'use strict';
// An interrupted package transaction (an install or an update the process
// died in the middle of) is healed when the workspace next opens, before the
// scheduler, the roster or the extension records read anything, rather than
// waiting for the next time the person happens to install something.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { _internal: srv } = require('../../server.js');
const { journalPath, IMPORT_SUBDIR } = require('../../lib/workspace/atomic-write.js');
const { makeTempDir, cleanup } = require('../helpers/workspace.js');

after(() => { srv.stopScheduler(); cleanup(); });

function write(root, relative, content) {
  const absolute = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

test('a transaction left mid-commit is rolled back when its workspace opens', () => {
  const workspace = makeTempDir('open-recovery-');
  // The shape the journaled write leaves when the process dies mid-commit:
  // the destination holds new bytes, the original lives only in the backup.
  write(workspace, '.claude/skills/parked/SKILL.md', 'half-committed bytes');
  write(workspace, path.join(IMPORT_SUBDIR, 'run', 'backup', '0', 'SKILL.md').split(path.sep).join('/'), 'parked');
  fs.writeFileSync(journalPath(workspace), JSON.stringify({
    version: 1, runId: 'stale', createdState: [], phase: 'committing',
    entries: [{ slot: 0, type: 'dir', priorType: 'dir', destination: '.claude/skills/parked' }], createdDirs: [],
  }));
  srv.setWorkspace(workspace);
  assert.strictEqual(fs.readFileSync(path.join(workspace, '.claude/skills/parked/SKILL.md'), 'utf8'), 'parked');
  assert.strictEqual(fs.existsSync(journalPath(workspace)), false);
});

test('a journal that cannot be trusted never stops the workspace opening', () => {
  const workspace = makeTempDir('open-recovery-');
  fs.mkdirSync(path.dirname(journalPath(workspace)), { recursive: true });
  fs.writeFileSync(journalPath(workspace), 'not json');
  assert.doesNotThrow(() => srv.setWorkspace(workspace));
  assert.strictEqual(srv.getWorkspace(), workspace);
});
