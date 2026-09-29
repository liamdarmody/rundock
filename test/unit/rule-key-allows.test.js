'use strict';
// "Always allow" on an Asks-once card is remembered under the verdict's rule
// key (`Bash:git-push:default-branch`), and must survive the trip through the
// real message handler, not only a direct call to the store. The handler's
// check on what a stored key may look like allowed one colon; every rule key
// has two, so the answer was refused at the wire, nothing was saved, and the
// card kept asking.
//
// Exactly the rule keys the verdict can produce are accepted, read from the
// verdict's own list. Plain tool keys keep working as before; anything else
// shaped like a rule key is still refused.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
const config = require('../../lib/config.js');
const boundary = require('../../lib/workspace/boundary.js');
const { RULES } = require('../../scripts/code-mode-verdict.js');
const RP = require('../../public/permissions.js');
const fx = require('../helpers/code-mode-fixture.js');

const RULE_KEYS = Object.values(RULES);
const LABELS = {
  'Bash:git-push:default-branch': 'Pushes to the default branch',
  'Bash:git-push:tags': 'Pushing tags',
  'Bash:git-push:delete-remote-ref': 'Deleting remote branches and tags',
  'PowerShell:execution-policy:change': 'Changing the PowerShell execution policy',
};

function captureWs() {
  const sent = [];
  return { sent, send: (m) => sent.push(JSON.parse(m)), readyState: 1 };
}
function inWorkspace(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-key-allows-'));
  fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
  const original = config.getWorkspace();
  try {
    config.setWorkspace(dir);
    return fn(buildDispatch());
  } finally {
    config.setWorkspace(original);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('a rule key goes through the real handler', () => {
  test('the four rule keys are the ones Settings has words for', () => {
    assert.deepStrictEqual([...RULE_KEYS].sort(), Object.keys(LABELS).sort());
  });

  for (const key of RULE_KEYS) {
    test(`${key} is saved, read back, and removed`, () => inWorkspace((table) => {
      const added = captureWs();
      table.add_tool_allow({}, added, { type: 'add_tool_allow', key });
      assert.deepStrictEqual(added.sent, [{ type: 'tool_allows', tools: [key] }], 'saved, not refused');
      const read = captureWs();
      table.get_tool_allows({}, read, { type: 'get_tool_allows' });
      assert.deepStrictEqual(read.sent[0].tools, [key], 'and read back');
      assert.deepStrictEqual(boundary.readToolAllows(), [key], 'from disk');
      const removed = captureWs();
      table.remove_tool_allow({}, removed, { type: 'remove_tool_allow', key });
      assert.deepStrictEqual(removed.sent[0].tools, []);
      assert.deepStrictEqual(boundary.readToolAllows(), []);
    }));
  }

  test('a refused save says so, naming the key, so the interface can show it', () => inWorkspace((table) => {
    const ws = captureWs();
    table.add_tool_allow({}, ws, { type: 'add_tool_allow', key: 'Bash:git-push:unknown-rule' });
    assert.strictEqual(ws.sent.length, 1);
    assert.strictEqual(ws.sent[0].type, 'tool_allow_failed');
    assert.strictEqual(ws.sent[0].key, 'Bash:git-push:unknown-rule');
  }));

  test('a save that cannot be written is reported, not claimed', () => inWorkspace((table) => {
    // The key is valid, but the workspace's permission folder cannot be written
    // to, so nothing is stored. The reply must say so rather than list the
    // allows as if the new one had been added.
    const dir = path.join(config.getWorkspace(), '.rundock');
    fs.chmodSync(dir, 0o555);
    let ws;
    try {
      ws = captureWs();
      table.add_tool_allow({}, ws, { type: 'add_tool_allow', key: 'Bash:git-push:tags' });
    } finally { fs.chmodSync(dir, 0o755); }
    assert.strictEqual(ws.sent.length, 1);
    assert.strictEqual(ws.sent[0].type, 'tool_allow_failed');
    assert.strictEqual(ws.sent[0].key, 'Bash:git-push:tags');
    assert.match(ws.sent[0].message, /could not be written/);
    assert.deepStrictEqual(boundary.readToolAllows(), [], 'and nothing is stored');
  }));

  test('anything else shaped like a rule key is still refused', () => inWorkspace((table) => {
    for (const key of ['Bash:git-push:default-branch:extra', 'Bash:git-push:unknown-rule', 'Bash:git:push', 'PowerShell:execution-policy:reset',
      'bash:git-push:default-branch', ' Bash:git-push:tags:', 'Bash:git-push:tags\nBash:rm']) {
      const ws = captureWs();
      table.add_tool_allow({}, ws, { type: 'add_tool_allow', key });
      assert.strictEqual(ws.sent[0].type, 'tool_allow_failed', JSON.stringify(key));
    }
    assert.deepStrictEqual(boundary.readToolAllows(), []);
  }));

  test('plain tool keys keep working', () => inWorkspace((table) => {
    for (const key of ['Bash', 'Bash:git', 'PowerShell:Get-Item', 'WebFetch', 'mcp__x__y']) {
      const ws = captureWs();
      table.add_tool_allow({}, ws, { type: 'add_tool_allow', key });
      assert.strictEqual(ws.sent[0].type, 'tool_allows', key);
    }
    assert.strictEqual(boundary.readToolAllows().length, 5);
  }));
});

describe('Settings lists a saved rule key in words', () => {
  test('each rule key renders its label, with the revoke control', () => {
    const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf-8');
    const dom = new JSDOM('<!doctype html><body><div id="settings-content"></div><div id="tool-allows-block"></div></body>', { runScripts: 'dangerously' });
    const w = dom.window;
    w.esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    w.escAttr = w.esc;
    w.eval(read('public', 'read-only-shell.js'));
    w.eval(read('public', 'permissions.js'));
    w.eval(read('public', 'sandbox-row-model.js'));
    w.eval(read('public', 'views', 'settings.js'));
    for (const key of RULE_KEYS) {
      w.toolAllowsArrived({ type: 'tool_allows', tools: [key] });
      const html = w.document.getElementById('tool-allows-block').innerHTML;
      assert.ok(html.includes(`<span class="tool-allow-name">${LABELS[key]}</span>`), key);
      assert.match(html, /revokeToolAllowAt\(0\)/);
    }
  });
});

// The whole way round: the hook's Asks-once verdict, "Always allow" remembered
// through the handler, the list read back as a reload reads it, and the next
// identical request answered from it with no card. The hook itself holds no
// standing allows; the interface answers the request from the saved list.
const root = fx.outsideTempRoot();
const SKIP = root.skip || false;
let world, capture, deadPort;
before(async () => {
  if (SKIP) return;
  world = fx.buildWorld(root.dir);
  capture = await fx.startCaptureServer();
  deadPort = await fx.closedPort();
});
after(async () => {
  if (capture) await capture.close();
  if (root.dir) fs.rmSync(root.dir, { recursive: true, force: true });
});

describe('an Asks-once answer remembered through the handler answers the next identical command', { skip: SKIP }, () => {
  test('git push to the default branch asks once, then runs with no card', async () => {
    const ask = () => fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: 'git push origin main' }, cwd: world.app });
    const first = await ask();
    assert.strictEqual(first.cls, 'asks-once');
    const verdict = first.payload.code_mode_verdict;
    const key = RP.verdictAllowKey(verdict);
    assert.strictEqual(key, 'Bash:git-push:default-branch');
    const risk = RP.classifyRisk('Bash', { command: 'git push origin main' });
    assert.deepStrictEqual(RP.decidePermission(risk, key, new Set(), verdict), { action: 'card' }, 'before: a card');

    const original = config.getWorkspace();
    let tools;
    try {
      config.setWorkspace(world.ws);
      const table = buildDispatch();
      table.add_tool_allow({}, captureWs(), { type: 'add_tool_allow', key });
      const reload = captureWs();
      table.get_tool_allows({}, reload, { type: 'get_tool_allows' });
      tools = reload.sent[0].tools;
    } finally { config.setWorkspace(original); }
    assert.ok(tools.includes(key), 'saved in the workspace');

    const second = await ask();
    assert.deepStrictEqual(second.payload.code_mode_verdict, verdict, 'the same request arrives again');
    assert.deepStrictEqual(RP.decidePermission(risk, key, new Set(tools), second.payload.code_mode_verdict),
      { action: 'allow', reason: 'always-allowed' }, 'after: answered from the saved list, no card');
  });
});
