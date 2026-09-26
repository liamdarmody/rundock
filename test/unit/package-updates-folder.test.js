'use strict';
// The hidden folder an update saves the author's versions and backups in:
// its size is on the Packages page, and Clear empties it, only it, and only
// when asked. Nothing ever clears it by itself.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const handlers = require('../../lib/protocol/handlers/packages.js');
const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
const config = require('../../lib/config.js');
const { makeTempDir } = require('../helpers/workspace.js');

function captureWs() {
  return { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } };
}
function write(root, relative, content) {
  const absolute = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}
function withWorkspace(fn) {
  const root = makeTempDir('updates-folder-');
  const previous = config.getWorkspace();
  config.setWorkspace(root);
  try { return fn(root); } finally { config.setWorkspace(previous); }
}

describe('the package updates folder', () => {
  test('the page carries its size, and an absent folder is empty', () => {
    withWorkspace((root) => {
      let sock = captureWs();
      handlers.handleGetPackagesPage({}, sock);
      assert.deepStrictEqual(sock.sent[0].updatesFolder, { bytes: 0, files: 0 });
      assert.deepStrictEqual(sock.sent[0].packages, [], 'the page carries a card per installed package, none here');
      write(root, '.rundock/package-updates/a-b/v2.0.0/.claude/agents/x.md', '12345');
      write(root, '.rundock/package-updates/a-b/v1.0.0/.claude/skills/s/SKILL.md', '123');
      sock = captureWs();
      handlers.handleGetPackagesPage({}, sock);
      assert.deepStrictEqual(sock.sent[0].updatesFolder, { bytes: 8, files: 2 });
    });
  });

  test('Clear removes that folder and nothing else, and answers with the page', () => {
    withWorkspace((root) => {
      write(root, '.rundock/package-updates/a-b/v2.0.0/x.md', 'x');
      write(root, '.rundock/receipts/r.json', '{}');
      write(root, 'notes/keep.md', 'keep');
      const sock = captureWs();
      buildDispatch().clear_package_updates({}, sock, { type: 'clear_package_updates' });
      assert.strictEqual(fs.existsSync(path.join(root, '.rundock', 'package-updates')), false);
      assert.ok(fs.existsSync(path.join(root, '.rundock', 'receipts', 'r.json')));
      assert.ok(fs.existsSync(path.join(root, 'notes', 'keep.md')));
      assert.strictEqual(sock.sent[0].type, 'packages_page');
      assert.deepStrictEqual(sock.sent[0].updatesFolder, { bytes: 0, files: 0 });
    });
  });

  test('a folder that is a link is refused rather than followed', () => {
    withWorkspace((root) => {
      const outside = makeTempDir('outside-');
      write(outside, 'precious.md', 'mine');
      fs.mkdirSync(path.join(root, '.rundock'), { recursive: true });
      fs.symlinkSync(outside, path.join(root, '.rundock', 'package-updates'));
      const sock = captureWs();
      handlers.handleClearPackageUpdates({}, sock, { type: 'clear_package_updates' });
      assert.strictEqual(sock.sent[0].type, 'package_install_error');
      assert.ok(fs.existsSync(path.join(outside, 'precious.md')));
    });
  });
});
