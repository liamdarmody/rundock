'use strict';
// The one writer of a workspace's .mcp.json for a connector change. Every
// change, an agent's through the save and delete handlers or Rundock's own
// setup's, goes through proposeConnectorChange: these tests pin what it
// refuses before any card, the card it raises, and what an Allow writes once
// the file is read again.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Required inside a try, so that without the module each test fails on its
// first assertion rather than the file failing to load.
let cw = {};
try { cw = require('../../lib/workspace/connector-write.js'); } catch (e) { cw = {}; }

const ROOT = path.join(__dirname, '..', '..');

function captureWs() {
  const sent = [];
  return { sent, send: (m) => sent.push(JSON.parse(m)), readyState: 1 };
}

// A workspace whose .mcp.json holds `holds` (a servers map, a string written
// as it is, or no file at all), the context the writer is handed, the cards it
// raises, held for the test to answer, and each time the file is opened:
// isInsideWorkspace is the first thing reading it calls.
async function inWorkspace(holds, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-write-'));
  const file = path.join(dir, '.mcp.json');
  if (typeof holds === 'string') fs.writeFileSync(file, holds);
  else if (holds) fs.writeFileSync(file, JSON.stringify({ mcpServers: holds }, null, 2));
  const asked = [];
  const opened = [];
  const ctx = {
    workspace: { isInsideWorkspace: (p) => { opened.push(p); return true; } },
    runtime: { requestServerPermission: (req) => { asked.push(req); } },
  };
  const s = {
    dir, file, ctx, asked, opened,
    answer: (i, allow, how = { card: true }, reason = 'user') => asked[i].onDecision(allow, reason, how),
    bytes: () => (fs.existsSync(file) ? fs.readFileSync(file) : null),
    servers: () => JSON.parse(fs.readFileSync(file, 'utf-8')).mcpServers,
    rewrite: (servers) => fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2)),
    request: (fields) => ({ workspace: dir, conversationId: 'convo-write', change: 'add', name: 'local-tools', entry: { command: 'node' }, source: 'agent', ...fields }),
  };
  try { return await fn(s); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function propose(s, req) {
  const w = captureWs();
  return { w, outcome: cw.proposeConnectorChange(s.ctx, w, req) };
}

// A change refused before any card: nobody asked, the file's bytes as they
// were, one message, the refusal's, and the outcome naming why.
async function refusedAtRequest(s, req, reason, message) {
  const before = s.bytes();
  const { w, outcome } = propose(s, req);
  assert.strictEqual(s.asked.length, 0, 'no card is raised');
  assert.deepStrictEqual(s.bytes(), before, 'the file is byte-identical');
  assert.deepStrictEqual(w.sent, [{ type: 'connector_error', message }], 'one message, the refusal\'s');
  assert.deepStrictEqual(await outcome, { ok: false, reason, message });
}

const NAME_REFUSED = 'That connector name can\'t be used, so nothing was changed. A name uses letters, numbers, dots, dashes and underscores, and starts with a letter, number or underscore.';
const NO_CONVERSATION = 'That connector change didn\'t say which conversation it came from, so nothing was changed.';
const NOT_ALLOWED = 'The change was not allowed, so nothing was changed.';
const TIMED_OUT = 'Nobody answered the card in time, so nothing was changed.';
const UNREADABLE = 'The connector file is not valid JSON, so nothing was changed. Fix or remove it first: writing over it now would discard whatever was meant to be there.';
const SAVED = (name, action) => [{ type: 'connector_saved', name, action, takesEffect: 'next agent start' }];

// ===== One writer =====

test('one module writes the connector file: it alone defines the reader, the writer and the card input, and both handlers go through it', () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(path.join(ROOT, 'lib'));
  files.push(path.join(ROOT, 'server.js'));
  // Code only: a line whose first characters open or continue a comment is
  // left out, so a comment naming the file is not a writer of it.
  const code = (file) => fs.readFileSync(file, 'utf-8').split('\n')
    .filter((line) => { const t = line.trim(); return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')); })
    .join('\n');
  const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');
  const holding = (text) => files.filter((f) => code(f).includes(text)).map(rel).sort();
  assert.deepStrictEqual(holding('.mcp.json'), [
    'lib/agents/prompt.js',
    'lib/workspace/analysis.js',
    'lib/workspace/answer-file-guard.js',
    'lib/workspace/connector-write.js',
    'lib/workspace/mcp-secrets.js',
    'lib/workspace/scaffold.js',
  ]);
  for (const fn of ['function connectorFile', 'function writeConnectorFile', 'function connectorCardInput']) {
    assert.deepStrictEqual(holding(fn), ['lib/workspace/connector-write.js'], `${fn} is defined in the writer and nowhere else`);
  }
  const team = require('../../lib/protocol/handlers/team.js');
  for (const handler of [team.handleSaveConnector, team.handleDeleteConnector]) {
    const source = handler.toString();
    assert.ok(source.includes('proposeConnectorChange'), `${handler.name} goes through the writer`);
    assert.ok(!source.includes('writeFileSync'), `${handler.name} writes no file itself`);
    assert.ok(!source.includes('writeConnectorFile'), `${handler.name} does not call the file writer`);
  }
});

// ===== The conversation an agent's change came from =====

test('an agent\'s connector change that names no conversation is refused before the file is read', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({}, async (s) => {
    const req = s.request();
    delete req.conversationId;
    await refusedAtRequest(s, req, 'invalid', NO_CONVERSATION);
    assert.deepStrictEqual(s.opened, [], 'the file is never opened');
  });
});

test('an agent\'s connector change whose conversation is empty is refused before the file is read', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({}, async (s) => {
    await refusedAtRequest(s, s.request({ conversationId: '' }), 'invalid', NO_CONVERSATION);
    assert.deepStrictEqual(s.opened, [], 'the file is never opened');
  });
});

test('an agent\'s connector change whose conversation is not a string is refused before the file is read', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({}, async (s) => {
    await refusedAtRequest(s, s.request({ conversationId: 5 }), 'invalid', NO_CONVERSATION);
    assert.deepStrictEqual(s.opened, [], 'the file is never opened');
  });
});

test('a connector change with a refused name and no conversation is refused for the name', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({}, async (s) => {
    const req = s.request({ name: '-tools' });
    delete req.conversationId;
    await refusedAtRequest(s, req, 'invalid', NAME_REFUSED);
    assert.deepStrictEqual(s.opened, [], 'the file is never opened');
  });
});

// ===== Honest changes =====

test('an agent\'s add of a connector not yet set up raises one add card in its conversation, and Allow writes it', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({}, async (s) => {
    const { w, outcome } = propose(s, s.request());
    assert.strictEqual(s.asked.length, 1, 'one card');
    assert.strictEqual(s.asked[0].toolName, 'SaveConnector');
    assert.strictEqual(s.asked[0].convoId, 'convo-write', 'raised in the conversation that asked');
    assert.deepStrictEqual(s.asked[0].toolInput, { name: 'local-tools', action: 'add', command: 'node', args: [] }, 'an add card carries no current entry');
    assert.deepStrictEqual(s.servers(), {}, 'nothing is written while the card waits');
    assert.deepStrictEqual(w.sent, [], 'and nothing is sent');
    s.answer(0, true);
    assert.deepStrictEqual(s.servers(), { 'local-tools': { command: 'node' } }, 'written once allowed');
    assert.deepStrictEqual(w.sent, SAVED('local-tools', 'saved'));
    assert.deepStrictEqual(await outcome, { ok: true, change: 'add', name: 'local-tools', takesEffect: 'next agent start' });
  });
});

test('Rundock\'s own add of a connector not yet set up needs no conversation, raises the card, and Allow writes it', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace(undefined, async (s) => {
    const req = s.request({ source: 'rundock' });
    delete req.conversationId;
    const { w, outcome } = propose(s, req);
    assert.strictEqual(s.asked.length, 1, 'one card');
    assert.strictEqual(s.asked[0].convoId, '', 'raised for no conversation');
    assert.deepStrictEqual(s.asked[0].toolInput, { name: 'local-tools', action: 'add', command: 'node', args: [] });
    s.answer(0, true);
    assert.deepStrictEqual(s.servers(), { 'local-tools': { command: 'node' } });
    assert.deepStrictEqual(w.sent, SAVED('local-tools', 'saved'));
    assert.deepStrictEqual(await outcome, { ok: true, change: 'add', name: 'local-tools', takesEffect: 'next agent start' });
  });
});

// ===== Only an Allow on the change's own card writes =====

const CHANGES = [
  ['an add', { 'example-beta': { command: 'node' } }, { change: 'add', entry: { command: 'node' } }, 'SaveConnector'],
  ['a replace', { 'local-tools': { command: 'node', args: ['old.js'] } }, { change: 'replace', entry: { command: 'node', args: ['server.js'] } }, 'SaveConnector'],
  ['a remove', { 'local-tools': { command: 'node' } }, { change: 'remove', entry: undefined }, 'DeleteConnector'],
];
const ANSWERS = [
  ['Deny', [false, 'user', { card: true }], 'denied', NOT_ALLOWED],
  ['no answer before the timeout', [false, 'timeout'], 'timeout', TIMED_OUT],
  ['an allow given on no card', [true, 'user', { card: false }], 'denied', NOT_ALLOWED],
  ['an allow that says nothing of a card', [true, 'user'], 'denied', NOT_ALLOWED],
];
for (const [said, holds, fields, toolName] of CHANGES) {
  for (const [answered, args, reason, message] of ANSWERS) {
    test(`${answered} on the card for ${said} writes nothing and resolves ${reason}`, async () => {
      assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
      await inWorkspace(holds, async (s) => {
        const before = s.bytes();
        const { w, outcome } = propose(s, s.request(fields));
        assert.strictEqual(s.asked.length, 1, 'one card');
        assert.strictEqual(s.asked[0].toolName, toolName);
        assert.strictEqual(s.asked[0].convoId, 'convo-write');
        s.asked[0].onDecision(...args);
        assert.deepStrictEqual(s.bytes(), before, 'the file is byte-identical');
        assert.deepStrictEqual(w.sent, [{ type: 'connector_error', message }]);
        assert.deepStrictEqual(await outcome, { ok: false, reason, message });
      });
    });
  }
}

test('a connector file that is not valid JSON is refused with its own message, and nobody is asked', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace('{ not json', async (s) => {
    await refusedAtRequest(s, s.request(), 'unreadable', UNREADABLE);
  });
});

test('an allowed change whose write fails says so in one message and resolves write-failed', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({}, async (s) => {
    const before = s.bytes();
    const { w, outcome } = propose(s, s.request());
    const real = fs.writeFileSync;
    fs.writeFileSync = (file, ...rest) => {
      if (file === s.file) throw new Error('disk full');
      return real(file, ...rest);
    };
    try { s.answer(0, true); } finally { fs.writeFileSync = real; }
    const message = 'The connector file could not be written: disk full';
    assert.deepStrictEqual(s.bytes(), before, 'the file is byte-identical');
    assert.deepStrictEqual(w.sent, [{ type: 'connector_error', message }]);
    assert.deepStrictEqual(await outcome, { ok: false, reason: 'write-failed', message });
  });
});
