'use strict';
// The sources transport: what the page may ask, what the server answers, and
// the watch that belongs to one mount.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../../lib/config.js');
const sources = require('../../lib/protocol/handlers/sources.js');
const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
const { makeTempDir } = require('../helpers/workspace.js');

const CANARY = 'CANARY-NOT-A-REAL-KEY';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let previous;
let previousPoll;
before(() => { previous = config.getWorkspace(); previousPoll = sources.timing.pollMs; sources.timing.pollMs = 40; });
after(() => { config.setWorkspace(previous); sources.timing.pollMs = previousPoll; });

function world() {
  const ws = makeTempDir('src-transport-');
  const w = (rel, t) => { fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true }); fs.writeFileSync(path.join(ws, rel), t); };
  w('notes/a.csv', 'a1');
  w('notes/b.csv', 'b1');
  w('notes/unnamed.csv', CANARY);
  w('.env', CANARY);
  w('dash.md', '---\nportfolio-dashboard: true\nsources:\n  - notes/a.csv\n  - notes/b.csv\n---\n# D\n');
  config.setWorkspace(ws);
  return ws;
}
function socket() {
  const sent = [];
  return { sent, readyState: 1, send: (m) => sent.push(JSON.parse(m)) };
}
const ctx = { workspace: { invalidateFileListCache() {}, invalidateFileTreeCache() {} }, store: { ensureSearchEngine: () => null } };
const dispatch = (ws, msg) => buildDispatch()[msg.type](ctx, ws, msg);

describe('what the page may ask', () => {
  test('the answer is resolved from the note on disk; a list, a name or a path the page adds is never read', () => {
    world();
    const ws = socket();
    dispatch(ws, { type: 'get_sources', path: 'dash.md', watchId: 'm1', sources: ['.env', 'notes/unnamed.csv'], names: ['.env'], source: '.env', list: '.env' });
    sources.closeSourcesWatch(ws);
    assert.deepStrictEqual(ws.sent, [{ type: 'sources_resolved', path: 'dash.md', watchId: 'm1', ok: true,
      sources: [{ path: 'notes/a.csv', content: 'a1' }, { path: 'notes/b.csv', content: 'b1' }] }]);
    assert.ok(!JSON.stringify(ws.sent).includes(CANARY));
  });

  test('save_source writes only what the note on disk lists, and says why otherwise', () => {
    const root = world();
    const ws = socket();
    dispatch(ws, { type: 'save_source', path: 'dash.md', source: 'notes/unnamed.csv', content: 'PWNED' });
    dispatch(ws, { type: 'save_source', path: 'dash.md', source: '.env', content: 'PWNED' });
    dispatch(ws, { type: 'save_source', path: 'dash.md', source: 'notes/a.csv', content: 'a2' });
    assert.deepStrictEqual(ws.sent.map((m) => m.type), ['source_save_refused', 'source_save_refused', 'source_saved']);
    assert.strictEqual(fs.readFileSync(path.join(root, 'notes', 'unnamed.csv'), 'utf8'), CANARY);
    assert.strictEqual(fs.readFileSync(path.join(root, '.env'), 'utf8'), CANARY);
    assert.strictEqual(fs.readFileSync(path.join(root, 'notes', 'a.csv'), 'utf8'), 'a2');
  });
});

describe('the watch', () => {
  test('a changed source, an edited list and a file swapped for a link each arrive; a new unnamed file never does', async () => {
    const root = world();
    const ws = socket();
    dispatch(ws, { type: 'get_sources', path: 'dash.md', watchId: 'm1' });
    fs.writeFileSync(path.join(root, 'notes', 'a.csv'), 'a-changed');
    fs.writeFileSync(path.join(root, 'notes', 'new.csv'), CANARY);
    await wait(150);
    let changed = ws.sent.filter((m) => m.type === 'sources_changed');
    assert.strictEqual(changed.length, 1);
    assert.strictEqual(changed[0].sources[0].content, 'a-changed');
    fs.writeFileSync(path.join(root, 'dash.md'), '---\nportfolio-dashboard: true\nsources:\n  - notes/b.csv\n---\n# D\n');
    await wait(150);
    fs.rmSync(path.join(root, 'notes', 'b.csv'));
    fs.symlinkSync(path.join(root, '.env'), path.join(root, 'notes', 'b.csv'));
    await wait(150);
    changed = ws.sent.filter((m) => m.type === 'sources_changed');
    assert.deepStrictEqual(changed[1].sources.map((s) => s.path), ['notes/b.csv'], 'the name the person removed is gone');
    assert.match(changed[2].sources[0].refused, /linked/);
    assert.ok(!JSON.stringify(ws.sent).includes(CANARY));
    sources.closeSourcesWatch(ws);
  });

  for (const [name, end] of [
    ['the page says the mount ended', (ws) => dispatch(ws, { type: 'unwatch_sources', watchId: 'm1' })],
    ['the next mount starts its own', (ws) => { dispatch(ws, { type: 'get_sources', path: 'other.md', watchId: 'm2' }); }],
    ['the workspace changes', () => config.setWorkspace(makeTempDir('src-other-'))],
    ['the connection closes', (ws) => { ws.readyState = 3; }],
  ]) {
    test(`the watch ends when ${name}, and nothing is sent after`, async () => {
      const root = world();
      const ws = socket();
      dispatch(ws, { type: 'get_sources', path: 'dash.md', watchId: 'm1' });
      end(ws);
      const count = ws.sent.length;
      fs.writeFileSync(path.join(root, 'notes', 'a.csv'), 'a-after');
      await wait(150);
      assert.deepStrictEqual(ws.sent.slice(count).filter((m) => m.watchId === 'm1'), []);
      assert.ok(!ws._sourcesWatch || ws._sourcesWatch.watchId !== 'm1', 'and the watch itself is gone, not merely silent');
      sources.closeSourcesWatch(ws);
    });
  }

  test('an unwatch naming another mount leaves this one watching', async () => {
    const root = world();
    const ws = socket();
    dispatch(ws, { type: 'get_sources', path: 'dash.md', watchId: 'm1' });
    dispatch(ws, { type: 'unwatch_sources', watchId: 'stale' });
    fs.writeFileSync(path.join(root, 'notes', 'a.csv'), 'a3');
    await wait(150);
    assert.strictEqual(ws.sent.filter((m) => m.type === 'sources_changed').length, 1);
    sources.closeSourcesWatch(ws);
  });

  test('the sources watch and the open-file watch are separate fields, and closing one leaves the other', () => {
    world();
    const ws = socket();
    ws._openFileWatch = { timer: setInterval(() => {}, 1000) };
    dispatch(ws, { type: 'get_sources', path: 'dash.md', watchId: 'm1' });
    sources.closeSourcesWatch(ws);
    assert.ok(ws._openFileWatch, 'the open-file watch is untouched');
    clearInterval(ws._openFileWatch.timer);
  });
});
