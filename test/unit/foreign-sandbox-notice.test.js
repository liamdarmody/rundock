'use strict';
// THE PANE STOPS PROMISING WHAT RUNDOCK CANNOT DELIVER.
//
// Rundock never rewrites a sandbox block somebody else wrote. That rule is
// right and stays. What it cost was paid in silence: Code mode's description
// promises the operating-system write block is off, and in a workspace with a
// hand-authored block it was on the whole time, with no way to tell from the
// UI. Reported after a headless render failed in a workspace sitting in Code
// mode; the only way to find out was to read the JSON.
//
// The detector already existed (isRundockSandbox) and never left scaffold.js.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const scaffold = require('../../lib/workspace/scaffold.js');

const made = [];
after(() => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} } });

function workspaceWithSandbox(block) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-sb-'));
  made.push(ws);
  fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
  const settings = block === null ? {} : { sandbox: block };
  fs.writeFileSync(path.join(ws, '.claude', 'settings.local.json'), JSON.stringify(settings, null, 2));
  return ws;
}

describe('who owns a workspace sandbox, as the server reports it', () => {
  test('a block Rundock wrote is reported managed', () => {
    const ws = workspaceWithSandbox(null);
    scaffold.reconcileSandboxForMode(ws, 'knowledge', 'darwin');
    const own = scaffold.sandboxOwnership(ws);
    assert.strictEqual(own.managed, true, 'Rundock wrote this one, so the mode switch moves it');
    assert.strictEqual(own.enabled, true);
  });

  test('a block a person wrote is reported unmanaged, whatever the mode says', () => {
    // The reported shape: richer than anything Rundock writes.
    const ws = workspaceWithSandbox({
      enabled: true,
      filesystem: { denyRead: ['/Users/x'], allowRead: ['/a'], allowWrite: ['/a'] },
      network: { allowLocalBinding: true },
      excludedCommands: ['*ship.sh*'],
    });
    const own = scaffold.sandboxOwnership(ws);
    assert.strictEqual(own.managed, false, 'this is the case the pane has to stop guessing about');
    assert.strictEqual(own.enabled, true, 'and the pane reports what the block says, not what the mode implies');
  });

  test('a mode switch leaves a hand-authored block byte for byte alone', () => {
    // The guarantee the notice describes. Asserted on the bytes, because a
    // person who configured this deliberately must find it exactly as they
    // left it, and a notice that said this while the file quietly changed
    // would be worse than no notice.
    const custom = {
      enabled: true,
      filesystem: { denyRead: ['/Users/x'], allowRead: ['/a'], allowWrite: ['/a'] },
      network: { allowLocalBinding: true },
      excludedCommands: ['*ship.sh*'],
    };
    const ws = workspaceWithSandbox(custom);
    const f = path.join(ws, '.claude', 'settings.local.json');
    const before = fs.readFileSync(f, 'utf-8');
    for (const mode of ['knowledge', 'code', 'knowledge', 'code']) {
      scaffold.reconcileSandboxForMode(ws, mode, 'darwin');
    }
    assert.strictEqual(fs.readFileSync(f, 'utf-8'), before,
      'four mode switches, and not one byte of a hand-authored block moved');
  });

  test('a workspace with no settings file is managed, because the next open writes ours', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-sb-none-'));
    made.push(ws);
    const own = scaffold.sandboxOwnership(ws);
    assert.strictEqual(own.managed, true, 'nothing is claiming it, so there is nothing to warn about');
    assert.strictEqual(own.present, false);
  });
});

// WHAT THE PANE SAYS about a block Rundock did not write is now the switch
// row's job: the effective state, a lock, and where it was set up
// (test/unit/sandbox-row-model.test.js and test/unit/permissions-pane.test.js).
// The mode card no longer describes the sandbox at all, so it has no promise
// about the operating system to withdraw.
describe('the mode card makes no promise about the sandbox', () => {
  const ROOT = path.join(__dirname, '..', '..');
  const VIEW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'views', 'settings.js'), 'utf-8');

  function modeCard(mode) {
    const dom = new JSDOM('<!doctype html><html><body><div id="settings-content"></div></body></html>', { runScripts: 'dangerously' });
    const w = dom.window;
    w.esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    w.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    w.eval(VIEW_SRC);
    Object.assign(w, { serverPlatform: 'darwin', workspaceMode: mode, currentView: 'settings', agents: [], skills: [],
      runtimeStatus: null, currentWorkspacePath: '/w', ws: { readyState: 1, send() {} }, WebSocket: { OPEN: 1 } });
    w.renderSettingsSection('permissions');
    const text = w.document.getElementById('mode-description').textContent;
    dom.window.close();
    return text;
  }

  test('each mode says how agents work, in the mock\'s words, and nothing about the operating system', () => {
    assert.strictEqual(modeCard('notes'), 'Notes, documents and other files. Agents ask before running commands.');
    assert.strictEqual(modeCard('code'), "Websites and software. Agents can edit code and run everyday development commands without asking. Commands that can't be undone still ask every time.");
    for (const mode of ['notes', 'code']) assert.doesNotMatch(modeCard(mode), /operating.system|sandbox|write block/i);
  });
});
