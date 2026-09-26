'use strict';
// BRINGING A PERSON'S OWN SANDBOX RULES INTO RUNDOCK.
//
// A block a person wrote is never touched by Rundock on its own. This is the
// one route by which it is replaced, and only after a review that lists every
// folder that becomes a working folder and names every rule Rundock cannot
// represent. The review writes nothing; only the confirmation does, and only
// if the file is still the one that was reviewed.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
const config = require('../../lib/config.js');
const scaffold = require('../../lib/workspace/scaffold.js');

const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function captureWs() {
  const sent = [];
  return { sent, send: (m) => sent.push(JSON.parse(m)), readyState: 1 };
}
function withWorkspace(dir, fn) {
  const original = config.getWorkspace();
  config.setWorkspace(dir);
  try { return fn(); } finally { config.setWorkspace(original); }
}
const bytes = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : null);

// The reported shape: Rundock's own roots, two folders added by hand, a deny
// pattern Rundock has no place for, and a command exclusion.
function handAuthored(enabled = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-import-'));
  made.push(dir);
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-projects-'));
  const sites = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sites-'));
  made.push(projects, sites);
  const home = os.homedir();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.rundock', 'state.json'), JSON.stringify({ workspaceMode: 'code' }, null, 2));
  const block = {
    enabled,
    filesystem: {
      allowWrite: [dir, path.join(home, '.npm'), projects, sites],
      denyWrite: ['*.env'],
    },
    excludedCommands: ['*ship.sh*'],
  };
  fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: block, hooks: { PreToolUse: [] } }, null, 2));
  return { dir, projects, sites };
}
const files = (dir) => [path.join(dir, '.claude', 'settings.local.json'), path.join(dir, '.rundock', 'state.json')];

describe('the review', () => {
  test('lists the folders that become working folders and names every rule that cannot come, writing nothing', () => {
    const { dir, projects, sites } = handAuthored();
    const before = files(dir).map(bytes);
    withWorkspace(dir, () => {
      const ws = captureWs();
      buildDispatch().review_sandbox_import({}, ws, {}, 'darwin');
      const { review } = ws.sent[0];
      assert.deepStrictEqual(review.folders, [projects, sites]);
      assert.deepStrictEqual(review.dropped.map((d) => d.rule).sort(), ['excludedCommands', 'filesystem.denyWrite']);
      assert.ok(review.dropped.some((d) => d.value === '*.env'), 'the planted deny pattern is named');
      assert.strictEqual(typeof review.digest, 'string');
    });
    assert.deepStrictEqual(files(dir).map(bytes), before);
  });

  test('is refused for a block that is already Rundock\'s own', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-import-ours-'));
    made.push(dir);
    scaffold.reconcileSandboxForMode(dir, 'on', 'darwin');
    withWorkspace(dir, () => {
      const ws = captureWs();
      buildDispatch().review_sandbox_import({}, ws, {}, 'darwin');
      assert.ok(ws.sent[0].error);
      assert.strictEqual(ws.sent[0].review, undefined);
    });
  });
});

describe('bringing the rules in', () => {
  for (const enabled of [true, false]) {
    test(`${enabled ? 'on' : 'off'}: the block becomes Rundock's, the folders become working folders, and what is in force is unchanged`, () => {
      const { dir, projects, sites } = handAuthored(enabled);
      withWorkspace(dir, () => {
        const reviewWs = captureWs();
        buildDispatch().review_sandbox_import({}, reviewWs, {}, 'darwin');
        const ws = captureWs();
        buildDispatch().import_sandbox_rules({}, ws, { digest: reviewWs.sent[0].review.digest }, 'darwin');
        const status = ws.sent.find((m) => m.type === 'sandbox_status');
        assert.strictEqual(status.error, undefined);
        assert.strictEqual(status.managed, true);
        assert.strictEqual(status.on, enabled, 'the effective state is what it was before');
        assert.ok(ws.sent.some((m) => m.type === 'working_folders'), 'the pane is sent the new list');
      });
      const settings = JSON.parse(bytes(files(dir)[0]));
      assert.ok(scaffold.isRundockSandbox(settings.sandbox), 'the block is Rundock\'s own now');
      assert.strictEqual(settings.sandbox.enabled, enabled);
      assert.ok(settings.sandbox.filesystem.allowWrite.includes(projects) && settings.sandbox.filesystem.allowWrite.includes(sites));
      assert.deepStrictEqual(settings.hooks, { PreToolUse: [] }, 'nothing else in the file changes');
      const state = JSON.parse(bytes(files(dir)[1]));
      assert.deepStrictEqual(state.workingFolders, [projects, sites]);
      assert.strictEqual(state.sandboxSwitch, enabled ? 'on' : 'off');
    });
  }

  test('a file that changed after the review is not brought in, and nothing is written', () => {
    const { dir } = handAuthored();
    withWorkspace(dir, () => {
      const reviewWs = captureWs();
      buildDispatch().review_sandbox_import({}, reviewWs, {}, 'darwin');
      const settings = JSON.parse(bytes(files(dir)[0]));
      settings.sandbox.filesystem.allowWrite.push('/Volumes/Other');
      fs.writeFileSync(files(dir)[0], JSON.stringify(settings, null, 2));
      const before = files(dir).map(bytes);
      const ws = captureWs();
      buildDispatch().import_sandbox_rules({}, ws, { digest: reviewWs.sent[0].review.digest }, 'darwin');
      assert.match(ws.sent[0].error, /changed since/);
      assert.deepStrictEqual(files(dir).map(bytes), before);
    });
  });

  test('a write that fails restores both files', () => {
    const { dir } = handAuthored();
    withWorkspace(dir, () => {
      const reviewWs = captureWs();
      buildDispatch().review_sandbox_import({}, reviewWs, {}, 'darwin');
      const before = files(dir).map(bytes);
      fs.chmodSync(files(dir)[0], 0o444);
      try {
        const ws = captureWs();
        buildDispatch().import_sandbox_rules({}, ws, { digest: reviewWs.sent[0].review.digest }, 'darwin');
        assert.match(ws.sent[0].error, /Could not bring/);
        assert.strictEqual(ws.sent[0].managed, false, 'the status still describes the person\'s block');
      } finally { fs.chmodSync(files(dir)[0], 0o600); }
      assert.deepStrictEqual(files(dir).map(bytes), before);
    });
  });
});
