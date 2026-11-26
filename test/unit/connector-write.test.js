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

// ===== What can't be asked about at all =====

const CHANGE_REFUSED = 'That connector change can\'t be made, so nothing was changed.';
const SETUP_ADDS_ONLY = 'Rundock\'s setup can only add a connector, so nothing was changed.';
const ALREADY_SET_UP = (name) => `A connector named "${name}" is already set up, so nothing was changed. Ask to replace it if you meant to change it.`;
const NOT_CONFIGURED = (name) => `No connector named "${name}" is configured in this workspace, so nothing was changed.`;
const CHANGED = 'The connectors changed after you were asked, so nothing was changed. Ask again to see the change as it stands now.';

test('a connector change that is not an add, a replace or a remove is refused before the file is read', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({}, async (s) => {
    await refusedAtRequest(s, s.request({ change: 'save' }), 'invalid', CHANGE_REFUSED);
    assert.deepStrictEqual(s.opened, [], 'the file is never opened');
  });
});

test('a connector change from neither an agent nor Rundock\'s setup is refused before the file is read', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({}, async (s) => {
    await refusedAtRequest(s, s.request({ source: 'window' }), 'invalid', CHANGE_REFUSED);
    assert.deepStrictEqual(s.opened, [], 'the file is never opened');
  });
});

test('a connector change that names no workspace is refused before any file is read', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({}, async (s) => {
    await refusedAtRequest(s, s.request({ workspace: '' }), 'invalid', CHANGE_REFUSED);
    assert.deepStrictEqual(s.opened, [], 'no file is opened');
  });
});

test('Rundock\'s setup replacing a connector that is set up is refused before the file is read', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({ 'local-tools': { command: 'node' } }, async (s) => {
    const req = s.request({ source: 'rundock', change: 'replace', entry: { command: 'node', args: ['server.js'] } });
    delete req.conversationId;
    await refusedAtRequest(s, req, 'invalid', SETUP_ADDS_ONLY);
    assert.deepStrictEqual(s.opened, [], 'the file is never opened');
  });
});

test('Rundock\'s setup removing a connector that is set up is refused before the file is read', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({ 'local-tools': { command: 'node' } }, async (s) => {
    const req = s.request({ source: 'rundock', change: 'remove', entry: undefined });
    delete req.conversationId;
    await refusedAtRequest(s, req, 'invalid', SETUP_ADDS_ONLY);
    assert.deepStrictEqual(s.opened, [], 'the file is never opened');
  });
});

// ===== What the file must hold for the change to make sense =====

test('an agent\'s add of a connector already set up is refused, and nobody is asked', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({ 'local-tools': { url: 'https://mcp.example.com/mcp' } }, async (s) => {
    await refusedAtRequest(s, s.request(), 'exists', ALREADY_SET_UP('local-tools'));
  });
});

test('Rundock\'s own add of a connector already set up is refused, and nobody is asked', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({ 'local-tools': { url: 'https://mcp.example.com/mcp' } }, async (s) => {
    const req = s.request({ source: 'rundock' });
    delete req.conversationId;
    await refusedAtRequest(s, req, 'exists', ALREADY_SET_UP('local-tools'));
  });
});

test('a replace of a connector that is not set up is refused, and nobody is asked', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({ calendar: { url: 'https://mcp.example.com/mcp' } }, async (s) => {
    await refusedAtRequest(s, s.request({ change: 'replace' }), 'absent', NOT_CONFIGURED('local-tools'));
  });
});

test('a remove of a connector that is not set up is refused, and nobody is asked', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({ calendar: { url: 'https://mcp.example.com/mcp' } }, async (s) => {
    await refusedAtRequest(s, s.request({ change: 'remove', entry: undefined }), 'absent', NOT_CONFIGURED('local-tools'));
  });
});

// ===== Allow writes only while the file still holds what the card showed =====

// The card is raised, the file is changed while it waits, and the Allow given
// on it writes nothing: the file keeps what it held at the Allow, one message
// says why, and no save is reported.
async function refusedAtAllow(s, req, meanwhile, reason, message) {
  const { w, outcome } = propose(s, req);
  assert.strictEqual(s.asked.length, 1, 'one card');
  meanwhile(s);
  const atAllow = s.bytes();
  s.answer(0, true);
  assert.deepStrictEqual(s.bytes(), atAllow, 'the file is byte-identical to what it held at the Allow');
  assert.deepStrictEqual(w.sent, [{ type: 'connector_error', message }], 'one message, the refusal\'s, and no save');
  assert.deepStrictEqual(await outcome, { ok: false, reason, message });
}
const STDIO_HELD = { command: 'node', args: ['tools.js', '--stdio'], env: { API_KEY: 'old-secret' } };

test('an agent\'s add allowed after the same name was set up meanwhile writes nothing and resolves exists', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({}, async (s) => {
    await refusedAtAllow(s, s.request(), () => s.rewrite({ 'local-tools': { url: 'https://mcp.example.com/mcp' } }), 'exists', ALREADY_SET_UP('local-tools'));
  });
});

test('Rundock\'s own add allowed after the same name was set up meanwhile writes nothing and resolves exists', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({}, async (s) => {
    const req = s.request({ source: 'rundock' });
    delete req.conversationId;
    await refusedAtAllow(s, req, () => s.rewrite({ 'local-tools': { url: 'https://mcp.example.com/mcp' } }), 'exists', ALREADY_SET_UP('local-tools'));
  });
});

test('a replace allowed after an environment value of the entry changed writes nothing and resolves changed', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({ 'local-tools': STDIO_HELD }, async (s) => {
    const meanwhile = () => s.rewrite({ 'local-tools': { ...STDIO_HELD, env: { API_KEY: 'other-secret' } } });
    await refusedAtAllow(s, s.request({ change: 'replace', entry: { command: 'node', args: ['server.js'] } }), meanwhile, 'changed', CHANGED);
  });
});

test('a replace allowed after the entry\'s arguments were reordered writes nothing and resolves changed', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({ 'local-tools': STDIO_HELD }, async (s) => {
    const meanwhile = () => s.rewrite({ 'local-tools': { ...STDIO_HELD, args: ['--stdio', 'tools.js'] } });
    await refusedAtAllow(s, s.request({ change: 'replace', entry: { command: 'node', args: ['server.js'] } }), meanwhile, 'changed', CHANGED);
  });
});

test('a replace allowed after the connector was removed meanwhile writes nothing and resolves absent', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({ 'local-tools': STDIO_HELD, calendar: { url: 'https://mcp.example.com/mcp' } }, async (s) => {
    const meanwhile = () => s.rewrite({ calendar: { url: 'https://mcp.example.com/mcp' } });
    await refusedAtAllow(s, s.request({ change: 'replace', entry: { command: 'node', args: ['server.js'] } }), meanwhile, 'absent', NOT_CONFIGURED('local-tools'));
  });
});

test('a remove allowed after the entry\'s URL changed writes nothing and resolves changed', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({ calendar: { url: 'https://old.example.com/mcp' } }, async (s) => {
    const meanwhile = () => s.rewrite({ calendar: { url: 'https://mcp.example.com/mcp' } });
    await refusedAtAllow(s, s.request({ change: 'remove', name: 'calendar', entry: undefined }), meanwhile, 'changed', CHANGED);
  });
});

test('a remove allowed after the connector was removed meanwhile writes nothing and resolves absent', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({ calendar: { url: 'https://old.example.com/mcp' }, 'local-tools': { command: 'node' } }, async (s) => {
    const meanwhile = () => s.rewrite({ 'local-tools': { command: 'node' } });
    await refusedAtAllow(s, s.request({ change: 'remove', name: 'calendar', entry: undefined }), meanwhile, 'absent', NOT_CONFIGURED('calendar'));
  });
});

// ===== Every value an Allow writes is on the card =====

const TIMEOUT_REFUSED = 'The connector entry\'s "timeout" isn\'t a setting the approval card can show, so nothing was changed.';

test('Rundock\'s own add of an entry holding a setting the card does not show is refused naming it, before the file is read', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({}, async (s) => {
    const req = s.request({ source: 'rundock', entry: { command: 'node', timeout: 5 } });
    delete req.conversationId;
    await refusedAtRequest(s, req, 'invalid', TIMEOUT_REFUSED);
    assert.deepStrictEqual(s.opened, [], 'the file is never opened');
  });
});

test('an agent\'s replace with an entry holding a setting the card does not show is refused naming it, before the file is read', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({ 'local-tools': { command: 'node' } }, async (s) => {
    await refusedAtRequest(s, s.request({ change: 'replace', entry: { command: 'node', timeout: 5 } }), 'invalid', TIMEOUT_REFUSED);
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

test('a replace allowed while the entry is as the card showed it writes the new entry', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({ 'local-tools': STDIO_HELD }, async (s) => {
    const { w, outcome } = propose(s, s.request({ change: 'replace', entry: { command: 'node', args: ['server.js'] } }));
    s.answer(0, true);
    assert.deepStrictEqual(s.servers(), { 'local-tools': { command: 'node', args: ['server.js'] } });
    assert.deepStrictEqual(w.sent, SAVED('local-tools', 'saved'));
    assert.deepStrictEqual(await outcome, { ok: true, change: 'replace', name: 'local-tools', takesEffect: 'next agent start' });
  });
});

test('a replace allowed after the entry was rewritten with the same settings in another order still writes', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({ 'local-tools': STDIO_HELD }, async (s) => {
    const { w, outcome } = propose(s, s.request({ change: 'replace', entry: { command: 'node', args: ['server.js'] } }));
    s.rewrite({ 'local-tools': { env: { API_KEY: 'old-secret' }, args: ['tools.js', '--stdio'], command: 'node' } });
    s.answer(0, true);
    assert.deepStrictEqual(s.servers(), { 'local-tools': { command: 'node', args: ['server.js'] } });
    assert.deepStrictEqual(w.sent, SAVED('local-tools', 'saved'));
    assert.deepStrictEqual(await outcome, { ok: true, change: 'replace', name: 'local-tools', takesEffect: 'next agent start' });
  });
});

test('a remove allowed while the entry is as the card showed it removes it', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({ calendar: { url: 'https://old.example.com/mcp' }, 'local-tools': { command: 'node' } }, async (s) => {
    const { w, outcome } = propose(s, s.request({ change: 'remove', name: 'calendar', entry: undefined }));
    s.answer(0, true);
    assert.deepStrictEqual(s.servers(), { 'local-tools': { command: 'node' } }, 'the other connector stays');
    assert.deepStrictEqual(w.sent, SAVED('calendar', 'removed'));
    assert.deepStrictEqual(await outcome, { ok: true, change: 'remove', name: 'calendar', takesEffect: 'next agent start' });
  });
});

test('another connector set up while an add card waits is kept beside the one allowed', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({}, async (s) => {
    const { outcome } = propose(s, s.request());
    s.rewrite({ calendar: { url: 'https://mcp.example.com/mcp' } });
    s.answer(0, true);
    assert.deepStrictEqual(s.servers(), { calendar: { url: 'https://mcp.example.com/mcp' }, 'local-tools': { command: 'node' } });
    assert.strictEqual((await outcome).ok, true);
  });
});

// ===== The replace card shows the entry it would replace =====

test('a replace card carries the entry it would replace, drawn like the new one', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({ 'local-tools': { ...STDIO_HELD, timeout: 5 } }, async (s) => {
    propose(s, s.request({ change: 'replace', entry: { command: 'node', args: ['server.js'] } }));
    assert.deepStrictEqual(s.asked[0].toolInput, {
      name: 'local-tools', action: 'replace', command: 'node', args: ['server.js'],
      current: { command: 'node', args: ['tools.js', '--stdio'], env: ['API_KEY'], others: ['timeout'] },
    });
  });
});

test('a replace card for an entry that is not an object carries an empty current entry', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({ 'local-tools': 'node tools.js' }, async (s) => {
    propose(s, s.request({ change: 'replace' }));
    assert.deepStrictEqual(s.asked[0].toolInput, { name: 'local-tools', action: 'replace', command: 'node', args: [], current: {} });
  });
});

test('environment and header values reach neither the replace card\'s input nor what the card says', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  const RP = require('../../public/permissions.js');
  const held = { url: 'https://old.example.com/mcp', env: { API_KEY: 'old-secret' }, headers: { Authorization: 'Bearer old' } };
  await inWorkspace({ calendar: held }, async (s) => {
    const entry = { url: 'https://mcp.example.com/mcp', env: { API_KEY: 'new-secret' }, headers: { Authorization: 'Bearer new' } };
    propose(s, s.request({ change: 'replace', name: 'calendar', entry }));
    const input = s.asked[0].toolInput;
    assert.deepStrictEqual(input.current, { url: 'https://old.example.com/mcp', env: ['API_KEY'], headers: ['Authorization'] }, 'the current entry is on the card, by name');
    const shown = [JSON.stringify(input), JSON.stringify(RP.describeToolRequest(s.asked[0].toolName, input))];
    for (const value of ['old-secret', 'Bearer old', 'new-secret', 'Bearer new']) {
      for (const text of shown) assert.ok(!text.includes(value), `${value} is not shown`);
    }
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
