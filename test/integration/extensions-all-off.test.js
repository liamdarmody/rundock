'use strict';
// Integration: turning an extension off is enforced where its bytes are
// served, and every connected window is told, not only the one that asked.
//
// The earlier shape was a flag each window honoured on its own: the server
// kept serving a disabled extension's code, and a second window kept its live
// mount until it happened to ask for the roster again. The switch that turns
// every extension off would have inherited that on day one. Here both are
// pinned against the real server with two connected windows.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');

const record = (name, extra) => ({
  name, version: '1.0.0', entry: 'ui/index.js', match: `*.${name}`,
  source: { url: `https://github.com/example/${name}`, reference: 'v1.0.0' },
  installedAt: '2026-09-07T00:00:00.000Z', root: `.rundock/extensions/${name}`, ...(extra || {}),
});
const manifest = (name) => JSON.stringify({ name, version: '1.0.0', extension: { entry: 'ui/index.js', match: `*.${name}` } });

let a;
let b;
before(async () => {
  await h.boot({
    workspaceOpts: {
      files: {
        '.rundock/extensions.json': JSON.stringify({ schema: 'rundock.extensions/v1', extensions: [record('charts'), record('tables', { enabled: false })] }),
        '.rundock/extensions/charts/rundock.json': manifest('charts'),
        '.rundock/extensions/charts/ui/index.js': 'draw();',
        '.rundock/extensions/tables/rundock.json': manifest('tables'),
        '.rundock/extensions/tables/ui/index.js': 'table();',
      },
    },
  });
  a = await h.connect();
  b = await h.connect();
});
after(async () => h.shutdown());

const byId = (roster) => Object.fromEntries(roster.map(e => [e.id, e]));
const recordsFile = () => JSON.parse(fs.readFileSync(path.join(h.workspaceDir, '.rundock', 'extensions.json'), 'utf-8'));

async function ui(client, extensionId) {
  const since = client.messages.length;
  client.send({ type: 'get_extension_ui', extensionId, rendererId: 'view' });
  const { msg } = await client.waitFor(m => (m.type === 'extension_ui' || m.type === 'extension_ui_error') && m.extensionId === extensionId, { since, label: `ui for ${extensionId}` });
  return msg;
}

test('a disabled extension\'s bytes are refused when asked for directly', async () => {
  assert.strictEqual((await ui(b, 'charts')).type, 'extension_ui', 'an enabled one is served');
  const refused = await ui(b, 'tables');
  assert.strictEqual(refused.type, 'extension_ui_error');
  assert.match(refused.reason, /disabled/);
});

test('disabling in one window tells the other, and the other can no longer fetch it', async () => {
  const since = b.messages.length;
  a.send({ type: 'set_extension_enabled', name: 'charts', enabled: false });
  const { msg } = await b.waitFor(m => m.type === 'extensions', { since, label: 'the roster in the other window' });
  assert.strictEqual(byId(msg.extensions).charts.enabled, false, 'the other window learns without asking');
  assert.strictEqual((await ui(b, 'charts')).type, 'extension_ui_error', 'and cannot mount it from a stale roster');
  a.send({ type: 'set_extension_enabled', name: 'charts', enabled: true });
  await b.waitFor(m => m.type === 'extensions' && byId(m.extensions).charts.enabled === true, { since: since + 1, label: 'back on' });
});

test('the switch turns every extension off, in every window, and back on restores each one exactly', async () => {
  const before = recordsFile().extensions.map(r => [r.name, r.enabled !== false]);
  const since = b.messages.length;
  a.send({ type: 'set_extensions_all_off', off: true });
  const { msg: reply } = await a.waitFor(m => m.type === 'extension_state' && m.operation === 'set-all-off', { label: 'the asker\'s reply' });
  assert.strictEqual(reply.allOff, true);
  const { msg } = await b.waitFor(m => m.type === 'extensions', { since, label: 'the other window hears' });
  assert.strictEqual(msg.allOff, true);
  for (const e of msg.extensions) {
    assert.strictEqual(e.enabled, false, `${e.id} reads as off`);
    assert.strictEqual(e.allOff, true, `${e.id} says the switch is why`);
  }
  assert.strictEqual(byId(msg.extensions).tables.ownEnabled, false, 'its own setting is still disabled');
  assert.strictEqual(byId(msg.extensions).charts.ownEnabled, true, 'its own setting is still enabled');
  assert.deepStrictEqual(recordsFile().extensions.map(r => [r.name, r.enabled !== false]), before, 'no extension\'s own setting changed');
  const refused = await ui(b, 'charts');
  assert.strictEqual(refused.type, 'extension_ui_error', 'the bytes are refused while the switch is on');
  assert.match(refused.reason, /every extension is switched off/);

  const since2 = b.messages.length;
  a.send({ type: 'set_extensions_all_off', off: false });
  const { msg: back } = await b.waitFor(m => m.type === 'extensions', { since: since2, label: 'back on in the other window' });
  assert.strictEqual(back.allOff, false);
  assert.strictEqual(byId(back.extensions).charts.enabled, true, 'restored to enabled');
  assert.strictEqual(byId(back.extensions).tables.enabled, false, 'restored to disabled');
  assert.ok(!('allOff' in recordsFile()), 'and the file carries no switch while it is off');
  assert.strictEqual((await ui(b, 'charts')).type, 'extension_ui');
});
