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

// Rendered the way the product renders it: the pane is drawn whole and read
// back, rather than a copy's worth of markup asserted in isolation. Mirrors the
// harness in working-folders-view.test.js, which presses the same pane.
describe('what the settings pane then says', () => {
  const ROOT = path.join(__dirname, '..', '..');
  const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
  const VIEW_SRC = read('public', 'views', 'settings.js');

  function paneHtml(mode, managed) {
    const dom = new JSDOM('<!doctype html><html><body><div id="settings-content"></div></body></html>',
      { runScripts: 'dangerously' });
    const w = dom.window;
    w.esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    w.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    w.eval(VIEW_SRC);
    w.serverPlatform = 'darwin';
    w.workspaceMode = mode;
    // The fact under test: whether Rundock authored this workspace's sandbox.
    w.sandboxManaged = managed;
    w.currentView = 'settings';
    w.agents = []; w.skills = []; w.runtimeStatus = null;
    w.currentWorkspacePath = '/Users/someone/Workspaces/team';
    w.ws = { readyState: 1, send: () => {} };
    w.WebSocket = { OPEN: 1 };
    w.workingFoldersArrived({ folders: [], home: '/Users/someone', rejected: [] });
    w.renderSettingsSection('permissions');
    const html = w.document.getElementById('settings-content').innerHTML;
    dom.window.close();
    return html;
  }

  const OS_PROMISE = /operating-system write block is off/;
  const NOTICE = /does not control the operating-system sandbox, which is set up outside Rundock/;

  test('Code mode, Rundock-managed: the promise is made, because it is kept', () => {
    const html = paneHtml('code', true);
    assert.match(html, OS_PROMISE, 'here Rundock does switch the block off, so it may say so');
    assert.doesNotMatch(html, NOTICE);
  });

  test('Code mode, someone else\'s sandbox: the promise is withdrawn and the reason given', () => {
    const html = paneHtml('code', false);
    assert.doesNotMatch(html, OS_PROMISE,
      'this is the sentence that was false for two evenings, and it must not be printed here');
    assert.match(html, NOTICE, 'and the reader is told why the switch will not help them');
  });

  test('Knowledge mode is treated the same way, in both directions', () => {
    assert.match(paneHtml('knowledge', true), /operating system enforces that too/);
    const foreign = paneHtml('knowledge', false);
    assert.doesNotMatch(foreign, /operating system enforces that too/,
      'Rundock cannot claim enforcement it is not the author of');
    assert.match(foreign, NOTICE);
  });

  test('the mode buttons still work, because the notice explains rather than disables', () => {
    // Deliberately NOT disabled. Mode still governs what Rundock itself asks
    // about, which is most of what mode means; only the operating-system half
    // is out of its hands. Disabling the switch would overstate the problem.
    const html = paneHtml('code', false);
    assert.match(html, /setWorkspaceMode\('knowledge'\)/);
    assert.match(html, /setWorkspaceMode\('code'\)/);
  });

  test('it says what mode still governs, not only what it does not', () => {
    // The first version said only that switching modes "does not change it",
    // and a reader concluded the control was inert. Three of mode's four
    // behaviours still work here; naming them is the difference between a
    // useful notice and one that makes the whole pane look broken.
    const html = paneHtml('code', false);
    assert.match(html, /Mode still controls file types and command approval here/,
      'the reader is told what the switch does do, so it does not read as dead');
  });

  test('what a person sees is one sentence, not a contradiction', () => {
    // The failure this whole notice exists to end: a pane that says the write
    // block is off while it is on. Whatever else changes, these two must never
    // appear together.
    for (const mode of ['code', 'knowledge']) {
      const html = paneHtml(mode, false);
      assert.ok(!(OS_PROMISE.test(html) && NOTICE.test(html)),
        'a promise about the sandbox and a notice that Rundock does not control it cannot both be true');
    }
  });
});
