'use strict';
// The view state transport, the server's half: the page names the extension and
// the note from its mount; the server reads and writes through the store,
// only for a note an extension may be handed, and answers every refusal with
// its reason.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../../lib/config.js');
const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
const { RECORDS_PATH, RECORDS_SCHEMA, EXTENSIONS_ROOT } = require('../../lib/packages/extension-record.js');
const { STATE_ROOT } = require('../../lib/packages/extension-state.js');
const { makeTempDir } = require('../helpers/workspace.js');

let previous;
before(() => { previous = config.getWorkspace(); });
after(() => { config.setWorkspace(previous); });

function world() {
  const ws = makeTempDir('view-state-');
  const w = (rel, t) => { fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true }); fs.writeFileSync(path.join(ws, rel), t); };
  w('Dash.md', '# D\n');
  w('Other.md', '# O\n');
  w('.hidden/secret.md', 'x');
  const records = ['investment-partner', 'risk-board'].map((name) => ({
    name, version: '1.0.0', source: { url: `https://github.com/example/${name}`, reference: 'v1.0.0' }, root: `${EXTENSIONS_ROOT}/${name}`,
  }));
  w(RECORDS_PATH, JSON.stringify({ schema: RECORDS_SCHEMA, extensions: records }));
  config.setWorkspace(ws);
  return ws;
}
function socket() {
  const sent = [];
  return { sent, readyState: 1, send: (m) => sent.push(JSON.parse(m)) };
}
const dispatch = (ws, msg) => buildDispatch()[msg.type]({}, ws, msg);
const stateDir = (root) => path.join(root, ...STATE_ROOT.split('/'));
const listing = (root) => (fs.existsSync(stateDir(root)) ? fs.readdirSync(stateDir(root), { recursive: true }).sort() : []);

describe('reading and writing through the handler', () => {
  test('a write is read back by the same extension and note, and by nothing else', () => {
    world();
    const ws = socket();
    dispatch(ws, { type: 'set_view_state', extension: 'investment-partner', path: 'Dash.md', state: { 'rui.table.positions': { account: 180 } } });
    assert.deepStrictEqual(ws.sent, [], 'a write that lands says nothing');
    for (const [extension, note, requestId, expected] of [
      ['investment-partner', 'Dash.md', 'r1', { 'rui.table.positions': { account: 180 } }],
      ['risk-board', 'Dash.md', 'r2', null],
      ['investment-partner', 'Other.md', 'r3', null],
    ]) {
      dispatch(ws, { type: 'get_view_state', extension, path: note, requestId });
      assert.deepStrictEqual(ws.sent.pop(), { type: 'view_state', extension, path: note, requestId, state: expected });
    }
  });

  test('the file is named by the hash of the note path, in the extension\'s own folder', () => {
    const root = world();
    dispatch(socket(), { type: 'set_view_state', extension: 'risk-board', path: 'Dash.md', state: { k: 1 } });
    const hash = crypto.createHash('sha256').update('Dash.md').digest('hex');
    assert.deepStrictEqual(listing(root), ['risk-board', `risk-board${path.sep}${hash}.json`]);
  });

  test('an empty object removes the note\'s state', () => {
    const root = world();
    const ws = socket();
    dispatch(ws, { type: 'set_view_state', extension: 'risk-board', path: 'Dash.md', state: { k: 1 } });
    dispatch(ws, { type: 'set_view_state', extension: 'risk-board', path: 'Dash.md', state: {} });
    assert.deepStrictEqual(listing(root), ['risk-board']);
    assert.deepStrictEqual(ws.sent, []);
  });
});

describe('every refusal is named, and writes nothing', () => {
  const cases = [
    ['an extension that is not installed', { extension: 'not-installed', path: 'Dash.md', state: { k: 1 } }, 'no extension named "not-installed" is installed'],
    ['a slug with a separator', { extension: '../risk-board', path: 'Dash.md', state: { k: 1 } }, 'no extension named "../risk-board" is installed'],
    ['a hidden note', { extension: 'risk-board', path: '.hidden/secret.md', state: { k: 1 } }, 'a hidden file, or a file in a hidden folder, is never handed to an extension'],
    ['a note outside the workspace', { extension: 'risk-board', path: '../Dash.md', state: { k: 1 } }, 'a hidden file, or a file in a hidden folder, is never handed to an extension'],
    ['a note that does not exist', { extension: 'risk-board', path: 'Gone.md', state: { k: 1 } }, 'the file does not exist'],
    ['no state at all', { extension: 'risk-board', path: 'Dash.md' }, 'the view state must be an object'],
    ['a state that is an array', { extension: 'risk-board', path: 'Dash.md', state: [1] }, 'the view state must be an object'],
    ['a Date, past the host', { extension: 'risk-board', path: 'Dash.md', state: { settings: { since: new Date(0) } } }, 'the view state is not plain JSON: a Date at settings.since'],
    ['17 levels, past the host', { extension: 'risk-board', path: 'Dash.md', state: JSON.parse('{"a":'.repeat(16) + '{}' + '}'.repeat(16)) }, 'the view state is not plain JSON: more than 16 levels deep at a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a'],
    ['one byte over 64 KB, past the host', { extension: 'risk-board', path: 'Dash.md', state: { s: 'x'.repeat(65537 - 8) } }, 'the view state is larger than 64 KB'],
  ];
  for (const [label, msg, reason] of cases) {
    test(label, () => {
      const root = world();
      const ws = socket();
      dispatch(ws, { type: 'set_view_state', ...msg });
      assert.deepStrictEqual(ws.sent, [{ type: 'view_state_refused', extension: msg.extension, path: msg.path, reason }]);
      assert.deepStrictEqual(listing(root), [], 'nothing written');
    });
  }

  test('an extension over its total is refused with the named reason', () => {
    const root = world();
    const ws = socket();
    const big = { s: 'x'.repeat(60000) };
    for (let i = 0; i < 18; i += 1) {
      fs.writeFileSync(path.join(root, `N${i}.md`), 'n');
      dispatch(ws, { type: 'set_view_state', extension: 'risk-board', path: `N${i}.md`, state: big });
    }
    assert.deepStrictEqual(ws.sent.map((m) => m.reason), ["this extension's view state is over its limit"]);
    assert.strictEqual(ws.sent[0].path, 'N17.md');
  });

  test('a failure the store did not name is reported without the workspace\'s path', () => {
    const root = world();
    fs.mkdirSync(stateDir(root), { recursive: true });
    fs.writeFileSync(path.join(stateDir(root), 'risk-board'), 'a file where the folder goes');
    const ws = socket();
    dispatch(ws, { type: 'set_view_state', extension: 'risk-board', path: 'Dash.md', state: { k: 1 } });
    assert.deepStrictEqual(ws.sent, [{ type: 'view_state_refused', extension: 'risk-board', path: 'Dash.md', reason: 'the view state could not be saved' }]);
    assert.ok(!JSON.stringify(ws.sent).includes(root));
  });

  test('a read for a note an extension may not be handed answers null, whatever is stored', () => {
    const root = world();
    const hash = crypto.createHash('sha256').update('.hidden/secret.md').digest('hex');
    fs.mkdirSync(path.join(stateDir(root), 'risk-board'), { recursive: true });
    fs.writeFileSync(path.join(stateDir(root), 'risk-board', `${hash}.json`), JSON.stringify({ path: '.hidden/secret.md', state: { k: 1 } }));
    const ws = socket();
    dispatch(ws, { type: 'get_view_state', extension: 'risk-board', path: '.hidden/secret.md', requestId: 'r' });
    assert.strictEqual(ws.sent[0].state, null);
  });

  test('with no workspace open, a read answers null and a write is refused', () => {
    world();
    config.setWorkspace(null);
    const ws = socket();
    dispatch(ws, { type: 'get_view_state', extension: 'risk-board', path: 'Dash.md', requestId: 'r' });
    dispatch(ws, { type: 'set_view_state', extension: 'risk-board', path: 'Dash.md', state: { k: 1 } });
    assert.deepStrictEqual(ws.sent.map((m) => [m.type, m.state === undefined ? m.reason : m.state]),
      [['view_state', null], ['view_state_refused', 'no workspace is open']]);
  });
});

describe('the state folder is a hidden path', () => {
  test('a state file can never be handed to a view as a note', () => {
    const root = world();
    dispatch(socket(), { type: 'set_view_state', extension: 'risk-board', path: 'Dash.md', state: { k: 1 } });
    const { extensionFileRefusal, REASONS } = require('../../lib/workspace/extension-file.js');
    const stored = path.posix.join(STATE_ROOT, 'risk-board', fs.readdirSync(path.join(stateDir(root), 'risk-board'))[0]);
    assert.strictEqual(extensionFileRefusal(root, stored), REASONS.hidden);
  });
});
