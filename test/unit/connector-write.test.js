'use strict';
// The one writer of a workspace's .mcp.json for a connector change. Every
// change, an agent's through the save and delete handlers or Rundock's own
// setup's, goes through proposeConnectorChange: these tests pin what it
// refuses before any card, the card it raises, and what an Allow writes once
// the file is read again.
// Some tests hold a turn's guard, which watches the home folder's shell
// startup files.
require('../helpers/made-up-home.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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
// isInsideWorkspace is the first thing reading it calls. It is the open
// workspace while the test runs, so what a reply keeps in its conversation
// lands in this folder and goes with it.
const config = require('../../lib/config.js');
async function inWorkspace(holds, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-write-'));
  const open = config.getWorkspace();
  config.setWorkspace(dir);
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
  try { return await fn(s); } finally { config.setWorkspace(open); fs.rmSync(dir, { recursive: true, force: true }); }
}

function propose(s, req) {
  const w = captureWs();
  return { w, outcome: cw.proposeConnectorChange(s.ctx, w, req) };
}

// The conversation every agent's change in this suite comes from, which each
// reply to it carries; a reply to a request without it carries none.
const ASKED_IN = 'convo-write';
const answered = (req, payload) => (req && req.conversationId === ASKED_IN ? { ...payload, conversationId: ASKED_IN } : payload);

// A change refused before any card: nobody asked, the file's bytes as they
// were, one message, the refusal's, and the outcome naming why.
async function refusedAtRequest(s, req, reason, message) {
  const before = s.bytes();
  const { w, outcome } = propose(s, req);
  assert.strictEqual(s.asked.length, 0, 'no card is raised');
  assert.deepStrictEqual(s.bytes(), before, 'the file is byte-identical');
  assert.deepStrictEqual(w.sent, [answered(req, { type: 'connector_error', message })], 'one message, the refusal\'s');
  assert.deepStrictEqual(await outcome, { ok: false, reason, message });
}

const NAME_REFUSED = 'That connector name can\'t be used, so nothing was changed. A name uses letters, numbers, dots, dashes and underscores, and starts with a letter, number or underscore.';
const NO_CONVERSATION = 'That connector change didn\'t say which conversation it came from, so nothing was changed.';
const NOT_ALLOWED = 'The change was not allowed, so nothing was changed.';
const TIMED_OUT = 'Nobody answered the card in time, so nothing was changed.';
const UNREADABLE = 'The connector file is not valid JSON, so nothing was changed. Fix or remove it first: writing over it now would discard whatever was meant to be there.';
const SAVED = (name, action, change = action === 'removed' ? 'remove' : 'add', conversationId = ASKED_IN) =>
  [{ type: 'connector_saved', name, change, action, takesEffect: 'next agent start', ...(conversationId ? { conversationId } : {}) }];

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
  assert.deepStrictEqual(w.sent, [answered(req, { type: 'connector_error', message })], 'one message, the refusal\'s, and no save');
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
    assert.deepStrictEqual(w.sent, SAVED('local-tools', 'saved', 'add', null));
    assert.deepStrictEqual(await outcome, { ok: true, change: 'add', name: 'local-tools', takesEffect: 'next agent start' });
  });
});

test('a replace allowed while the entry is as the card showed it writes the new entry', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({ 'local-tools': STDIO_HELD }, async (s) => {
    const { w, outcome } = propose(s, s.request({ change: 'replace', entry: { command: 'node', args: ['server.js'] } }));
    s.answer(0, true);
    assert.deepStrictEqual(s.servers(), { 'local-tools': { command: 'node', args: ['server.js'] } });
    assert.deepStrictEqual(w.sent, SAVED('local-tools', 'saved', 'replace'));
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
    assert.deepStrictEqual(w.sent, SAVED('local-tools', 'saved', 'replace'));
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
  await inWorkspace({ 'local-tools': STDIO_HELD }, async (s) => {
    propose(s, s.request({ change: 'replace', entry: { command: 'node', args: ['server.js'] } }));
    assert.deepStrictEqual(s.asked[0].toolInput, {
      name: 'local-tools', action: 'replace', command: 'node', args: ['server.js'],
      current: { command: 'node', args: ['tools.js', '--stdio'], env: ['API_KEY'] },
    });
  });
});

// The entry a replace would overwrite is shown exactly or not at all: a value
// the card can't draw would be lost on Allow without anyone seeing it.
const CURRENT_UNSHOWN = (name) => `The connector "${name}" as it is now holds a setting the approval card can't show, so nothing was changed. Change it in .mcp.json yourself.`;

test('a replace of a connector whose current entry holds a setting the card does not show is refused, and nobody is asked', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({ 'local-tools': { command: 'node', timeout: 5 } }, async (s) => {
    const req = s.request({ change: 'replace', entry: { command: 'node', args: ['new.js'] } });
    await refusedAtRequest(s, req, 'invalid', CURRENT_UNSHOWN('local-tools'));
  });
});

for (const [what, held] of [['a string', 'node tools.js'], ['null', null], ['an array', ['node', 'tools.js']]]) {
  test(`a replace of a connector whose current entry is ${what} is refused, and nobody is asked`, async () => {
    assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
    await inWorkspace({ 'local-tools': held }, async (s) => {
      const req = s.request({ change: 'replace', entry: { command: 'node', args: ['new.js'] } });
      await refusedAtRequest(s, req, 'invalid', CURRENT_UNSHOWN('local-tools'));
    });
  });
}

test('a replace of a connector whose current arguments are not a list of strings is refused, and nobody is asked', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({ 'local-tools': { command: 'node', args: 'old.js' } }, async (s) => {
    const req = s.request({ change: 'replace', entry: { command: 'node', args: ['new.js'] } });
    await refusedAtRequest(s, req, 'invalid', CURRENT_UNSHOWN('local-tools'));
  });
});

test('a remove of a connector holding a setting the card does not show still asks, listing it by name, and Allow removes it', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({ 'local-tools': { command: 'node', timeout: 5 } }, async (s) => {
    const { w, outcome } = propose(s, s.request({ change: 'remove', entry: undefined }));
    assert.strictEqual(s.asked.length, 1, 'one card');
    assert.strictEqual(s.asked[0].toolName, 'DeleteConnector');
    assert.deepStrictEqual(s.asked[0].toolInput, { name: 'local-tools', action: 'remove', command: 'node', args: [], others: ['timeout'] });
    s.answer(0, true);
    assert.deepStrictEqual(s.servers(), {});
    assert.deepStrictEqual(w.sent, SAVED('local-tools', 'removed'));
    assert.deepStrictEqual(await outcome, { ok: true, change: 'remove', name: 'local-tools', takesEffect: 'next agent start' });
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
        assert.deepStrictEqual(w.sent, [{ type: 'connector_error', conversationId: ASKED_IN, message }]);
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

// fs.writeSync for the file's own writes, throwing for the first `failures`
// of them and then writing for real. The standard streams pass straight
// through.
function failingWrites(failures, words = 'ENOSPC: no space left on device, write') {
  const real = fs.writeSync;
  let calls = 0;
  return function writeSync(fd, ...rest) {
    if (fd <= 2 || calls++ >= failures) return real.call(fs, fd, ...rest);
    throw Object.assign(new Error(words), { code: words.split(':')[0] });
  };
}

test('an allowed change whose write fails says so in one message and resolves write-failed', async (t) => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({}, async (s) => {
    const before = s.bytes();
    const { w, outcome } = propose(s, s.request());
    const warned = t.mock.method(console, 'warn', () => {});
    t.mock.method(fs, 'writeSync', failingWrites(1, 'EIO: disk full, write'));
    try { s.answer(0, true); } finally { t.mock.restoreAll(); }
    const message = 'Rundock couldn\'t save the connector file, so nothing was changed.';
    assert.deepStrictEqual(s.bytes(), before, 'the file is byte-identical');
    assert.deepStrictEqual(w.sent, [{ type: 'connector_error', conversationId: ASKED_IN, message }]);
    assert.deepStrictEqual(await outcome, { ok: false, reason: 'write-failed', message });
    assert.ok(warned.mock.calls.some((c) => String(c.arguments[0]).includes('disk full')), 'the error\'s own words go to the log');
  });
});

// ===== Only a regular file is read, never through a link =====

const UNREADABLE_FILE = 'The connector file could not be read, so nothing was changed. Its current contents are unknown and writing now would drop whatever it holds.';
const NOT_AN_OBJECT = 'The connector file does not hold an object, so nothing was changed.';
const LINK_REFUSED = 'The connector file is a link, so Rundock does not write through it and nothing was changed.';
const SERVERS_NOT_AN_OBJECT = 'The connector file\'s "mcpServers" does not hold an object, so nothing was changed.';

// Links need a permission some Windows accounts lack; pipes and file modes
// are not what they are on Windows, and permissions do not stop root.
const NO_LINKS = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-link-probe-'));
  try { fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link')); return false; } catch (e) {
    if (e.code === 'EPERM') return 'this account cannot make links';
    throw e;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})();
const NO_PIPES = process.platform === 'win32' ? 'no named pipes in the file system on Windows' : false;
const NO_MODES = process.platform === 'win32' || (process.getuid && process.getuid() === 0) ? 'file modes do not stop this account' : false;

// What stands at `p`, told apart without following a link: a link and where
// it leads, a folder and what it holds, a pipe, or a file, its bytes (null
// when they can't be read) and its mode.
function standing(p) {
  let st;
  try { st = fs.lstatSync(p); } catch (e) { return null; }
  if (st.isSymbolicLink()) return { link: fs.readlinkSync(p) };
  if (st.isDirectory()) return { dir: fs.readdirSync(p) };
  if (st.isFIFO()) return { pipe: true };
  let bytes = null;
  try { bytes = fs.readFileSync(p); } catch (e) { /* unreadable */ }
  return { bytes, mode: st.mode & 0o777 };
}

// A folder outside the workspace, for a link to lead into.
async function elsewhere(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-elsewhere-'));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const OUTSIDE = JSON.stringify({ mcpServers: { alpha: { url: 'https://mcp.example.com/mcp' } } }, null, 2);

// Each thing at .mcp.json that leaves nothing to build on, and what is said.
const writes = (text) => (s) => fs.writeFileSync(s.file, text);
const UNREADABLE_CAUSES = [
  ['a file this account cannot read', (s) => { fs.writeFileSync(s.file, '{"mcpServers": {}}\n'); fs.chmodSync(s.file, 0o000); }, UNREADABLE_FILE, NO_MODES],
  ['a folder', (s) => fs.mkdirSync(s.file), UNREADABLE_FILE, false],
  ['a named pipe', (s) => execFileSync('mkfifo', [s.file]), UNREADABLE_FILE, NO_PIPES],
  ['invalid JSON', writes('{ not json'), UNREADABLE, false],
  ['a top-level array', writes('[{"mcpServers": {}}]'), NOT_AN_OBJECT, false],
  ['a top-level null', writes('null'), NOT_AN_OBJECT, false],
  ['a top-level string', writes('"mcpServers"'), NOT_AN_OBJECT, false],
  ['a top-level number', writes('42'), NOT_AN_OBJECT, false],
  ['an mcpServers that is an array', writes('{"mcpServers": [{"command": "node"}]}'), SERVERS_NOT_AN_OBJECT, false],
  ['an mcpServers that is null', writes('{"mcpServers": null}'), SERVERS_NOT_AN_OBJECT, false],
  ['an mcpServers that is a string', writes('{"mcpServers": "alpha"}'), SERVERS_NOT_AN_OBJECT, false],
  ['an mcpServers that is a number', writes('{"mcpServers": 7}'), SERVERS_NOT_AN_OBJECT, false],
];
// A read that waited on a pipe would never return, so the pipe's tests first
// ask whether the writer reads through its own steps at all.
const readsItsOwnWay = () => assert.strictEqual(typeof (cw.io && cw.io.read), 'function', 'the writer reads the file through its own no-follow, non-blocking step');

for (const [cause, makeIt, message, skip] of UNREADABLE_CAUSES) {
  test(`${cause} at .mcp.json is refused at request time, and nobody is asked`, { skip }, async () => {
    assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
    if (cause === 'a named pipe') readsItsOwnWay();
    await inWorkspace(undefined, async (s) => {
      try {
        makeIt(s);
        const before = standing(s.file);
        const { w, outcome } = propose(s, s.request());
        assert.strictEqual(s.asked.length, 0, 'no card is raised');
        assert.deepStrictEqual(standing(s.file), before, 'what stands there is as it was');
        assert.deepStrictEqual(w.sent, [{ type: 'connector_error', conversationId: ASKED_IN, message }], 'one message, the refusal\'s');
        assert.deepStrictEqual(await outcome, { ok: false, reason: 'unreadable', message });
      } finally { try { fs.chmodSync(s.file, 0o644); } catch (e) { /* not a file */ } }
    });
  });

  test(`${cause} put at .mcp.json while the card waits is refused at Allow, and nothing is written`, { skip }, async () => {
    assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
    if (cause === 'a named pipe') readsItsOwnWay();
    await inWorkspace({}, async (s) => {
      try {
        const { w, outcome } = propose(s, s.request());
        assert.strictEqual(s.asked.length, 1, 'one card');
        fs.rmSync(s.file);
        makeIt(s);
        const atAllow = standing(s.file);
        s.answer(0, true);
        assert.deepStrictEqual(standing(s.file), atAllow, 'what stands there is as it was at the Allow');
        assert.deepStrictEqual(w.sent, [{ type: 'connector_error', conversationId: ASKED_IN, message }], 'one message, the refusal\'s, and no save');
        assert.deepStrictEqual(await outcome, { ok: false, reason: 'unreadable', message });
      } finally { try { fs.chmodSync(s.file, 0o644); } catch (e) { /* not a file */ } }
    });
  });
}

// A link at .mcp.json is refused wherever it leads, and what it leads to is
// never read as the connectors nor written through.
async function linkRefusedAtRequest(s, target) {
  const before = standing(target);
  const { w, outcome } = propose(s, s.request());
  assert.strictEqual(s.asked.length, 0, 'no card is raised');
  assert.deepStrictEqual(standing(target), before, 'what the link leads to is byte-identical');
  assert.deepStrictEqual(w.sent, [{ type: 'connector_error', conversationId: ASKED_IN, message: LINK_REFUSED }], 'one message, the refusal\'s, and no save');
  assert.deepStrictEqual(await outcome, { ok: false, reason: 'unreadable', message: LINK_REFUSED });
}

test('a connector file that is a link to a file outside the workspace is refused at request time, with no guard', { skip: NO_LINKS }, async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace(undefined, (s) => elsewhere(async (dir) => {
    const target = path.join(dir, 'servers.json');
    fs.writeFileSync(target, OUTSIDE);
    fs.symlinkSync(target, s.file);
    await linkRefusedAtRequest(s, target);
    assert.deepStrictEqual(standing(s.file), { link: target }, 'the link is left as it was');
  }));
});

test('a connector file that is a link to a file inside the workspace is refused at request time', { skip: NO_LINKS }, async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace(undefined, async (s) => {
    const target = path.join(s.dir, 'servers.json');
    fs.writeFileSync(target, OUTSIDE);
    fs.symlinkSync(target, s.file);
    await linkRefusedAtRequest(s, target);
  });
});

test('a connector file that is a dangling link is refused at request time, and nothing is made where it leads', { skip: NO_LINKS }, async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace(undefined, async (s) => {
    const target = path.join(s.dir, 'nowhere.json');
    fs.symlinkSync(target, s.file);
    await linkRefusedAtRequest(s, target);
    assert.strictEqual(standing(target), null, 'still nothing there');
  });
});

test('a link swapped in at .mcp.json while the card waits, no turn watching, is refused at Allow', { skip: NO_LINKS }, async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace({}, (s) => elsewhere(async (dir) => {
    const target = path.join(dir, 'servers.json');
    fs.writeFileSync(target, OUTSIDE);
    const { w, outcome } = propose(s, s.request());
    assert.strictEqual(s.asked.length, 1, 'one card');
    fs.rmSync(s.file);
    fs.symlinkSync(target, s.file);
    s.answer(0, true);
    assert.strictEqual(fs.readFileSync(target, 'utf-8'), OUTSIDE, 'what the link leads to is byte-identical');
    assert.deepStrictEqual(standing(s.file), { link: target }, 'the link is left as it was');
    assert.deepStrictEqual(w.sent, [{ type: 'connector_error', conversationId: ASKED_IN, message: LINK_REFUSED }], 'one message, the refusal\'s, and no save');
    assert.deepStrictEqual(await outcome, { ok: false, reason: 'unreadable', message: LINK_REFUSED });
  }));
});

test('after a link is refused, the same change asked again once the link is a plain file is written', { skip: NO_LINKS }, async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace(undefined, (s) => elsewhere(async (dir) => {
    const target = path.join(dir, 'servers.json');
    fs.writeFileSync(target, OUTSIDE);
    fs.symlinkSync(target, s.file);
    await linkRefusedAtRequest(s, target);
    fs.rmSync(s.file);
    fs.writeFileSync(s.file, OUTSIDE);
    const { w, outcome } = propose(s, s.request());
    assert.strictEqual(s.asked.length, 1, 'the change asked again gets its card');
    s.answer(0, true);
    assert.deepStrictEqual(s.servers(), { alpha: { url: 'https://mcp.example.com/mcp' }, 'local-tools': { command: 'node' } });
    assert.deepStrictEqual(w.sent, SAVED('local-tools', 'saved'));
    assert.strictEqual((await outcome).ok, true);
    assert.strictEqual(fs.readFileSync(target, 'utf-8'), OUTSIDE, 'and the file the link led to is still untouched');
  }));
});

test('a connector file with no mcpServers gets one as its last key, after every other key', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace('{"$schema": "https://example.com/schema.json", "extra": {"a": [1, 2]}}', async (s) => {
    const { outcome } = propose(s, s.request());
    s.answer(0, true);
    const written = JSON.parse(fs.readFileSync(s.file, 'utf-8'));
    assert.deepStrictEqual(Object.keys(written), ['$schema', 'extra', 'mcpServers']);
    assert.deepStrictEqual(written, { $schema: 'https://example.com/schema.json', extra: { a: [1, 2] }, mcpServers: { 'local-tools': { command: 'node' } } });
    assert.strictEqual((await outcome).ok, true);
  });
});

// ===== The copy a change is built on =====

const guard = require('../../lib/workspace/answer-file-guard.js');
const formatted = (value) => `${JSON.stringify(value, null, 2)}\n`;
const ALPHA = { alpha: { url: 'https://mcp.example.com/mcp' } };
const LOCAL_TOOLS = { 'local-tools': { command: 'node' } };

// A turn's guard on the workspace, its poll pushed far out so only a check a
// test makes, or the writer runs, finds a change. `heard` is every change the
// guard hands the turn.
function turnIn(s) {
  const heard = [];
  const held = guard.acquireAnswerFileGuard(s.dir, (c) => heard.push(c), { intervalMs: 60 * 60 * 1000, convoId: 'convo-write' });
  return { heard, release: () => held.release() };
}
// A turn that starts and ends, so the guard holds the file as it stands now.
const turnEnded = (s) => turnIn(s).release();
const told = (heard) => heard.map((c) => ({ relative: c.relative, kept: c.kept, outsideTurn: c.outsideTurn }));
const NAMED_ONCE = [{ relative: '.mcp.json', kept: true, outsideTurn: true }];

test('while a turn watches, an allowed add is built on the copy the guard accepted, and an agent\'s change is not carried in', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace(formatted({ mcpServers: ALPHA }), async (s) => {
    const t = turnIn(s);
    try {
      const { w, outcome } = propose(s, s.request());
      assert.strictEqual(s.asked.length, 1, 'one card');
      const agents = formatted({ mcpServers: { ...ALPHA, 'example-beta': { command: 'node' } }, extra: 1 });
      fs.writeFileSync(s.file, agents);
      s.answer(0, true);
      const written = fs.readFileSync(s.file);
      assert.strictEqual(written.toString('utf-8'), formatted({ mcpServers: { ...ALPHA, ...LOCAL_TOOLS } }), 'the accepted copy and the add, nothing else');
      assert.deepStrictEqual(w.sent, SAVED('local-tools', 'saved'));
      assert.strictEqual((await outcome).ok, true);
      assert.deepStrictEqual(t.heard.map((c) => [c.relative, c.agentContent]), [['.mcp.json', agents]], 'the agent\'s change was put back and handed to the turn');
      assert.deepStrictEqual(guard.checkAnswerFilesNow(s.dir), [], 'the next check puts nothing back');
      assert.deepStrictEqual(guard.answerFileBaseline(s.dir, s.file), written, 'and the baseline is the bytes written');
    } finally { t.release(); }
  });
});

test('while a turn watches, an agent\'s server and key written after the guard\'s check, just before the read, are not built on', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  readsItsOwnWay();
  await inWorkspace(formatted({ mcpServers: ALPHA }), async (s) => {
    const t = turnIn(s);
    try {
      const { w, outcome } = propose(s, s.request());
      assert.strictEqual(s.asked.length, 1, 'one card');
      const agents = formatted({ mcpServers: { ...ALPHA, 'example-beta': { command: 'node' } }, extra: 1 });
      const real = cw.io.read;
      let landed = false;
      cw.io.read = (file) => {
        if (!landed) { landed = true; fs.writeFileSync(file, agents); }
        return real(file);
      };
      try { s.answer(0, true); } finally { cw.io.read = real; }
      assert.ok(landed, 'the agent\'s write landed just before the read');
      assert.deepStrictEqual(t.heard, [], 'after the guard\'s check, which found nothing to put back');
      assert.strictEqual(fs.readFileSync(s.file, 'utf-8'), formatted({ mcpServers: { ...ALPHA, ...LOCAL_TOOLS } }), 'exactly the accepted copy and the add');
      assert.deepStrictEqual(w.sent, SAVED('local-tools', 'saved'));
      assert.strictEqual((await outcome).ok, true);
    } finally { t.release(); }
  });
});

test('while a turn watches, a replace card shows the accepted entry an agent changed before the save handler read, and Allow writes over it', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  const team = require('../../lib/protocol/handlers/team.js');
  const config = require('../../lib/config.js');
  await inWorkspace(formatted({ mcpServers: { calendar: { url: 'https://accepted.example.com/mcp' } } }), async (s) => {
    const previous = config.getWorkspace();
    config.setWorkspace(s.dir);
    const t = turnIn(s);
    try {
      fs.writeFileSync(s.file, formatted({ mcpServers: { calendar: { url: 'https://planted.example.com/mcp' } } }));
      const w = captureWs();
      team.handleSaveConnector(s.ctx, w, { name: 'calendar', content: JSON.stringify({ url: 'https://new.example.com/mcp' }), conversationId: 'convo-write' });
      assert.strictEqual(s.asked.length, 1, 'one card');
      assert.deepStrictEqual(s.asked[0].toolInput, { name: 'calendar', action: 'replace', url: 'https://new.example.com/mcp', current: { url: 'https://accepted.example.com/mcp' } },
        'the card shows the entry the guard accepted, not the agent\'s');
      s.answer(0, true);
      assert.deepStrictEqual(s.servers(), { calendar: { url: 'https://new.example.com/mcp' } });
      assert.deepStrictEqual(w.sent, SAVED('calendar', 'saved', 'replace'));
    } finally { t.release(); config.setWorkspace(previous); }
  });
});

test('with no turn watching, a person\'s edit made while the card waits is kept beside the add, and the next turn start names it once', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace(formatted({ mcpServers: ALPHA }), async (s) => {
    turnEnded(s);
    const { w, outcome } = propose(s, s.request());
    const persons = { ...ALPHA, 'example-gamma': { url: 'https://gamma.example.com/mcp' } };
    s.rewrite(persons);
    s.answer(0, true);
    assert.deepStrictEqual(s.servers(), { ...persons, ...LOCAL_TOOLS }, 'the person\'s edit is kept, and the add beside it');
    assert.deepStrictEqual(w.sent, SAVED('local-tools', 'saved'));
    assert.strictEqual((await outcome).ok, true);
    const written = s.bytes();
    const next = turnIn(s);
    try {
      assert.deepStrictEqual(told(next.heard), NAMED_ONCE, 'the next turn start takes it with its notice');
      assert.deepStrictEqual(s.bytes(), written, 'and puts nothing back');
    } finally { next.release(); }
  });
});

test('with no turn watching, the same name added by a person while the card waits is kept, and Allow ends exists', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace(formatted({ mcpServers: ALPHA }), async (s) => {
    turnEnded(s);
    const persons = { 'local-tools': { url: 'https://tools.example.com/mcp' } };
    await refusedAtAllow(s, s.request(), () => s.rewrite({ ...ALPHA, ...persons }), 'exists', ALREADY_SET_UP('local-tools'));
    assert.deepStrictEqual(s.servers(), { ...ALPHA, ...persons }, 'the person\'s entry is kept');
  });
});

test('with no turn watching and the file as the guard holds it, the write is recorded and the next turn start says nothing', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace(formatted({ mcpServers: ALPHA }), async (s) => {
    turnEnded(s);
    const { w, outcome } = propose(s, s.request());
    s.answer(0, true);
    assert.deepStrictEqual(w.sent, SAVED('local-tools', 'saved'));
    assert.strictEqual((await outcome).ok, true);
    const written = s.bytes();
    const next = turnIn(s);
    try {
      assert.deepStrictEqual(next.heard, [], 'no notice and nothing put back');
      assert.deepStrictEqual(s.bytes(), written);
      assert.deepStrictEqual(guard.answerFileBaseline(s.dir, s.file), written, 'Rundock\'s write is the baseline');
    } finally { next.release(); }
  });
});

test('with no guard, the change is built on the file as it stands', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace(formatted({ mcpServers: ALPHA }), async (s) => {
    const { w, outcome } = propose(s, s.request());
    s.rewrite({ ...ALPHA, 'example-beta': { url: 'https://beta.example.com/mcp' } });
    s.answer(0, true);
    assert.deepStrictEqual(s.servers(), { ...ALPHA, 'example-beta': { url: 'https://beta.example.com/mcp' }, ...LOCAL_TOOLS });
    assert.deepStrictEqual(w.sent, SAVED('local-tools', 'saved'));
    assert.strictEqual((await outcome).ok, true);
  });
});

test('a card raised during a turn and allowed after it ended is built on the file as it stands, and keeps the person\'s edit', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace(formatted({ mcpServers: ALPHA }), async (s) => {
    const t = turnIn(s);
    let w;
    let outcome;
    try { ({ w, outcome } = propose(s, s.request())); } finally { t.release(); }
    assert.strictEqual(s.asked.length, 1, 'one card, still waiting after the turn');
    const persons = { ...ALPHA, 'example-gamma': { command: 'node', args: ['gamma.js'] } };
    s.rewrite(persons);
    s.answer(0, true);
    assert.deepStrictEqual(s.servers(), { ...persons, ...LOCAL_TOOLS });
    assert.deepStrictEqual(w.sent, SAVED('local-tools', 'saved'));
    assert.strictEqual((await outcome).ok, true);
    const next = turnIn(s);
    try { assert.deepStrictEqual(told(next.heard), NAMED_ONCE, 'the next turn start names the edit once'); } finally { next.release(); }
  });
});

test('undoing an allowed add during a turn is a remove built on the accepted copy, which leaves the file as it was', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  const before = formatted({ $schema: 'https://example.com/schema.json', mcpServers: ALPHA });
  await inWorkspace(before, async (s) => {
    const t = turnIn(s);
    try {
      const add = propose(s, s.request());
      s.answer(0, true);
      assert.strictEqual((await add.outcome).ok, true);
      assert.deepStrictEqual(guard.checkAnswerFilesNow(s.dir), [], 'the poll after it takes the add as Rundock\'s own');
      fs.writeFileSync(s.file, formatted({ $schema: 'https://example.com/schema.json', mcpServers: { ...ALPHA, ...LOCAL_TOOLS }, extra: 1 }));
      const remove = propose(s, s.request({ change: 'remove', entry: undefined }));
      assert.strictEqual(s.asked.length, 2, 'the remove has its own card');
      s.answer(1, true);
      assert.deepStrictEqual(remove.w.sent, SAVED('local-tools', 'removed'));
      assert.strictEqual(fs.readFileSync(s.file, 'utf-8'), before, 'byte for byte as before the add, with nothing of the agent\'s');
    } finally { t.release(); }
  });
});

test('a connector file the guard holds as the person\'s own link is still refused, and what it leads to is untouched', { skip: NO_LINKS }, async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace(undefined, (s) => elsewhere(async (dir) => {
    const target = path.join(dir, 'servers.json');
    fs.writeFileSync(target, OUTSIDE);
    fs.symlinkSync(target, s.file);
    const t = turnIn(s);
    try {
      await linkRefusedAtRequest(s, target);
      assert.deepStrictEqual(standing(s.file), { link: target }, 'the person\'s link is left as it was');
    } finally { t.release(); }
  }));
});

test('while a turn watches, a link an agent swaps in is put back as the plain file, and the change lands on that file, not where the link led', { skip: NO_LINKS }, async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace(formatted({ mcpServers: ALPHA }), (s) => elsewhere(async (dir) => {
    const target = path.join(dir, 'servers.json');
    fs.writeFileSync(target, OUTSIDE);
    const t = turnIn(s);
    try {
      const { w, outcome } = propose(s, s.request());
      fs.rmSync(s.file);
      fs.symlinkSync(target, s.file);
      s.answer(0, true);
      assert.strictEqual(fs.readFileSync(target, 'utf-8'), OUTSIDE, 'what the link led to is byte-identical');
      assert.ok(standing(s.file).bytes, 'a plain file stands at .mcp.json again');
      assert.strictEqual(fs.readFileSync(s.file, 'utf-8'), formatted({ mcpServers: { ...ALPHA, ...LOCAL_TOOLS } }), 'the change is on the plain file');
      assert.deepStrictEqual(w.sent, SAVED('local-tools', 'saved'));
      assert.strictEqual((await outcome).ok, true);
    } finally { t.release(); }
  }));
});

// ===== A baseline the guard holds with no bytes it could read =====

// While a turn watches, the change is built on the copy the guard accepted.
// A baseline that is a file this account could not read, or a pipe, held
// connectors nobody knows, so nothing is built on it, even once a plain file
// stands there: only a baseline holding no file at all is built on as empty.
const HELD = formatted({ mcpServers: { ...ALPHA, 'example-beta': { command: 'node', args: ['beta.js'] } } });
const unreadable = (s) => fs.chmodSync(s.file, 0o000);
const readable = (s) => fs.chmodSync(s.file, 0o644);
const piped = (s) => { fs.rmSync(s.file); execFileSync('mkfifo', [s.file]); };
const plainAgain = (s) => { fs.rmSync(s.file); fs.writeFileSync(s.file, HELD); };
// `between` changes .mcp.json after a turn has ended, the next turn start
// takes that as the baseline, and `during` puts a plain file holding
// connectors there while that turn watches. Returns the turn.
function overUnreadBaseline(s, between, during) {
  between(s);
  const t = turnIn(s);
  during(s);
  return t;
}
const UNREAD_BASELINES = [
  ['a file this account could not read, made readable', unreadable, readable, NO_MODES],
  ['a named pipe, replaced by a plain file', piped, plainAgain, NO_PIPES],
];

for (const [baseline, between, during, skip] of UNREAD_BASELINES) {
  test(`while a turn watches over a baseline that is ${baseline}, an add is refused at request time as unreadable, and nobody is asked`, { skip }, async () => {
    assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
    await inWorkspace(HELD, async (s) => {
      turnEnded(s);
      const t = overUnreadBaseline(s, between, during);
      try {
        await refusedAtRequest(s, s.request(), 'unreadable', UNREADABLE_FILE);
      } finally { t.release(); }
    });
  });

  test(`while a turn watches over a baseline that is ${baseline}, an add is refused at Allow as unreadable, and nothing is written`, { skip }, async () => {
    assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
    await inWorkspace(HELD, async (s) => {
      turnEnded(s);
      let t = null;
      try {
        await refusedAtAllow(s, s.request(), () => { t = overUnreadBaseline(s, between, during); }, 'unreadable', UNREADABLE_FILE);
      } finally { if (t) t.release(); }
    });
  });
}

test('while a turn watches over a baseline holding no connector file, an add is built on an empty one, and an agent\'s file is not carried in', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace(undefined, async (s) => {
    const t = turnIn(s);
    try {
      const { w, outcome } = propose(s, s.request());
      assert.strictEqual(s.asked.length, 1, 'one card');
      fs.writeFileSync(s.file, HELD);
      s.answer(0, true);
      assert.strictEqual(fs.readFileSync(s.file, 'utf-8'), formatted({ mcpServers: LOCAL_TOOLS }), 'an empty file and the add, nothing of the agent\'s');
      assert.deepStrictEqual(w.sent, SAVED('local-tools', 'saved'));
      assert.strictEqual((await outcome).ok, true);
    } finally { t.release(); }
  });
});

test('after an add is refused over a baseline the guard could not read, the same add asked again in the next turn keeps every connector', { skip: NO_MODES }, async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace(HELD, async (s) => {
    turnEnded(s);
    const t = overUnreadBaseline(s, unreadable, readable);
    try { await refusedAtRequest(s, s.request(), 'unreadable', UNREADABLE_FILE); } finally { t.release(); }
    const next = turnIn(s);
    try {
      const { w, outcome } = propose(s, s.request());
      assert.strictEqual(s.asked.length, 1, 'the change asked again gets its card');
      s.answer(0, true);
      assert.deepStrictEqual(s.servers(), { ...JSON.parse(HELD).mcpServers, ...LOCAL_TOOLS }, 'every connector kept, and the add beside them');
      assert.deepStrictEqual(w.sent, SAVED('local-tools', 'saved'));
      assert.strictEqual((await outcome).ok, true);
    } finally { next.release(); }
  });
});

// ===== Nothing else in the file changes =====

// Every top-level key and every other entry as in the copy built on, in the
// same order: an add goes last, a replace stays in place, a remove leaves the
// rest in order.
const SCHEMA_FIRST = {
  $schema: 'https://example.com/schema.json',
  mcpServers: {
    alpha: { url: 'https://mcp.example.com/mcp' },
    'example-beta': { command: 'node', args: ['beta.js'] },
    'local-tools': { url: 'https://tools.example.com/mcp' },
  },
  extra: { a: [1, 2] },
};
function keptInOrder(written, servers) {
  assert.deepStrictEqual(Object.keys(written), ['$schema', 'mcpServers', 'extra'], 'the top-level keys in their order');
  assert.strictEqual(written.$schema, SCHEMA_FIRST.$schema);
  assert.deepStrictEqual(written.extra, SCHEMA_FIRST.extra);
  assert.deepStrictEqual(Object.keys(written.mcpServers), Object.keys(servers), 'the connectors in their order');
  for (const n of Object.keys(servers)) assert.deepStrictEqual(written.mcpServers[n], servers[n], n);
}

test('an add, a replace of the middle entry and a remove of it each keep every other key and connector, in order', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  const { alpha, 'local-tools': tools } = SCHEMA_FIRST.mcpServers;
  const gamma = { url: 'https://gamma.example.com/mcp' };
  for (const [fields, servers] of [
    [{ name: 'example-gamma', entry: gamma }, { ...SCHEMA_FIRST.mcpServers, 'example-gamma': gamma }],
    [{ change: 'replace', name: 'example-beta', entry: gamma }, { alpha, 'example-beta': gamma, 'local-tools': tools }],
    [{ change: 'remove', name: 'example-beta', entry: undefined }, { alpha, 'local-tools': tools }],
  ]) {
    await inWorkspace(formatted(SCHEMA_FIRST), async (s) => {
      const { outcome } = propose(s, s.request(fields));
      s.answer(0, true);
      assert.strictEqual((await outcome).ok, true, fields.change || 'add');
      keptInOrder(JSON.parse(fs.readFileSync(s.file, 'utf-8')), servers);
    });
  }
});

test('an own __proto__ entry in the connector file is kept in its place', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  const held = '{"mcpServers": {"alpha": {"url": "https://mcp.example.com/mcp"}, "__proto__": {"command": "node", "args": ["proto.js"]}, "example-beta": {"command": "node"}}}';
  await inWorkspace(held, async (s) => {
    const { outcome } = propose(s, s.request());
    s.answer(0, true);
    assert.strictEqual((await outcome).ok, true);
    const servers = JSON.parse(fs.readFileSync(s.file, 'utf-8')).mcpServers;
    assert.deepStrictEqual(Object.keys(servers), ['alpha', '__proto__', 'example-beta', 'local-tools']);
    assert.ok(Object.prototype.hasOwnProperty.call(servers, '__proto__'), 'still an entry of its own');
    assert.deepStrictEqual(Object.getOwnPropertyDescriptor(servers, '__proto__').value, { command: 'node', args: ['proto.js'] });
  });
});

// ===== The write: never through a link, and recorded only once it returned =====

const WRITE_FAILED = 'Rundock couldn\'t save the connector file, so nothing was changed.';
const NOT_PUT_BACK = 'Rundock couldn\'t save the connector file, and couldn\'t put back what it held before. Check Connectors in Settings.';
const writesItsOwnWay = () => assert.strictEqual(typeof (cw.io && cw.io.write), 'function', 'the writer writes the file through its own no-follow step');

// An Allow whose write fails: what it sends, what it resolves, and the file.
async function failedAtAllow(s, outcome, w, message, bytes) {
  assert.deepStrictEqual(s.bytes(), bytes, 'the file holds what it held before');
  assert.deepStrictEqual(w.sent, [{ type: 'connector_error', conversationId: ASKED_IN, message }], 'one message, and no save');
  assert.deepStrictEqual(await outcome, { ok: false, reason: 'write-failed', message });
}

test('an allowed change to a read-only connector file ends write-failed, with its bytes intact', { skip: NO_MODES }, async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace(ALPHA, async (s) => {
    fs.chmodSync(s.file, 0o444);
    try {
      const before = s.bytes();
      const { w, outcome } = propose(s, s.request());
      s.answer(0, true);
      await failedAtAllow(s, outcome, w, WRITE_FAILED, before);
    } finally { fs.chmodSync(s.file, 0o644); }
  });
});

test('after write-failed on a read-only connector file, the same change asked again once it is writable is written', { skip: NO_MODES }, async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace(ALPHA, async (s) => {
    fs.chmodSync(s.file, 0o444);
    try {
      const first = propose(s, s.request());
      s.answer(0, true);
      assert.strictEqual((await first.outcome).reason, 'write-failed');
      fs.chmodSync(s.file, 0o644);
      const again = propose(s, s.request());
      assert.strictEqual(s.asked.length, 2, 'the change asked again gets its own card');
      s.answer(1, true);
      assert.deepStrictEqual(s.servers(), { ...ALPHA, ...LOCAL_TOOLS });
      assert.deepStrictEqual(again.w.sent, SAVED('local-tools', 'saved'));
      assert.strictEqual((await again.outcome).ok, true);
    } finally { fs.chmodSync(s.file, 0o644); }
  });
});

test('a write that fails part way puts back what the file held and ends write-failed', async (t) => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  writesItsOwnWay();
  await inWorkspace(ALPHA, async (s) => {
    const before = s.bytes();
    const { w, outcome } = propose(s, s.request());
    t.mock.method(console, 'warn', () => {});
    t.mock.method(fs, 'writeSync', failingWrites(1));
    try { s.answer(0, true); } finally { t.mock.restoreAll(); }
    await failedAtAllow(s, outcome, w, WRITE_FAILED, before);
  });
});

test('a write that fails and cannot put back what the file held says so in its own words', async (t) => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  writesItsOwnWay();
  await inWorkspace(ALPHA, async (s) => {
    const { w, outcome } = propose(s, s.request());
    t.mock.method(console, 'warn', () => {});
    t.mock.method(fs, 'writeSync', failingWrites(Infinity));
    try { s.answer(0, true); } finally { t.mock.restoreAll(); }
    assert.deepStrictEqual(w.sent, [{ type: 'connector_error', conversationId: ASKED_IN, message: NOT_PUT_BACK }], 'one message, and no save');
    assert.deepStrictEqual(await outcome, { ok: false, reason: 'write-failed', message: NOT_PUT_BACK });
  });
});

test('a write that fails on a connector file that was not there leaves no file behind', async (t) => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  writesItsOwnWay();
  await inWorkspace(undefined, async (s) => {
    const { w, outcome } = propose(s, s.request());
    t.mock.method(console, 'warn', () => {});
    t.mock.method(fs, 'writeSync', failingWrites(1));
    try { s.answer(0, true); } finally { t.mock.restoreAll(); }
    await failedAtAllow(s, outcome, w, WRITE_FAILED, null);
  });
});

test('a link swapped in between the read and the write ends write-failed, and nothing is written where it leads', { skip: NO_LINKS }, async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  writesItsOwnWay();
  await inWorkspace(ALPHA, (s) => elsewhere(async (dir) => {
    const target = path.join(dir, 'servers.json');
    fs.writeFileSync(target, OUTSIDE);
    const { w, outcome } = propose(s, s.request());
    const real = cw.io.write;
    cw.io.write = (file, body) => {
      fs.rmSync(file);
      fs.symlinkSync(target, file);
      return real(file, body);
    };
    const warn = console.warn;
    console.warn = () => {};
    try { s.answer(0, true); } finally { cw.io.write = real; console.warn = warn; }
    assert.strictEqual(fs.readFileSync(target, 'utf-8'), OUTSIDE, 'what the link leads to is byte-identical');
    assert.deepStrictEqual(standing(s.file), { link: target });
    assert.deepStrictEqual(w.sent, [{ type: 'connector_error', conversationId: ASKED_IN, message: WRITE_FAILED }], 'one message, and no save');
    assert.deepStrictEqual(await outcome, { ok: false, reason: 'write-failed', message: WRITE_FAILED });
  }));
});

// ===== Where the platform has no O_NOFOLLOW =====

// There (Windows) an lstat just before each open refuses a link. Here the
// writer is told the flag is absent (io.noFollow), and every open the process
// makes has the flag taken off, so the open and the write beneath the writer
// follow a link as they would there: only the lstat checks stand between a
// link and what it leads to. Returns what puts both back.
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
function withoutNoFollow(t) {
  assert.strictEqual(typeof (cw.io && cw.io.noFollow), 'function', 'the writer asks for the no-follow flag through its own step');
  const real = cw.io.noFollow;
  cw.io.noFollow = () => 0;
  const open = fs.openSync;
  const opens = t.mock.method(fs, 'openSync', (p, flags, ...rest) => open.call(fs, p, typeof flags === 'number' ? flags & ~NOFOLLOW : flags, ...rest));
  return () => { cw.io.noFollow = real; opens.mock.restore(); };
}

test('where the platform has no O_NOFOLLOW, a connector file that is a link is refused at request time, and what it leads to is untouched', { skip: NO_LINKS }, async (t) => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  const putBack = withoutNoFollow(t);
  try {
    await inWorkspace(undefined, (s) => elsewhere(async (dir) => {
      const target = path.join(dir, 'servers.json');
      fs.writeFileSync(target, OUTSIDE);
      fs.symlinkSync(target, s.file);
      await linkRefusedAtRequest(s, target);
      assert.deepStrictEqual(standing(s.file), { link: target }, 'the link is left as it was');
    }));
  } finally { putBack(); }
});

test('where the platform has no O_NOFOLLOW, a link swapped in at .mcp.json while the card waits is refused at Allow', { skip: NO_LINKS }, async (t) => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  const putBack = withoutNoFollow(t);
  try {
    await inWorkspace({}, (s) => elsewhere(async (dir) => {
      const target = path.join(dir, 'servers.json');
      fs.writeFileSync(target, OUTSIDE);
      const { w, outcome } = propose(s, s.request());
      assert.strictEqual(s.asked.length, 1, 'one card');
      fs.rmSync(s.file);
      fs.symlinkSync(target, s.file);
      const warn = console.warn;
      console.warn = () => {};
      try { s.answer(0, true); } finally { console.warn = warn; }
      assert.strictEqual(fs.readFileSync(target, 'utf-8'), OUTSIDE, 'what the link leads to is byte-identical');
      assert.deepStrictEqual(standing(s.file), { link: target }, 'the link is left as it was');
      assert.deepStrictEqual(w.sent, [{ type: 'connector_error', conversationId: ASKED_IN, message: LINK_REFUSED }], 'one message, the refusal\'s, and no save');
      assert.deepStrictEqual(await outcome, { ok: false, reason: 'unreadable', message: LINK_REFUSED });
    }));
  } finally { putBack(); }
});

test('where the platform has no O_NOFOLLOW, a link swapped in between the read and the write ends write-failed, and nothing is written where it leads', { skip: NO_LINKS }, async (t) => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  writesItsOwnWay();
  const putBack = withoutNoFollow(t);
  try {
    await inWorkspace(ALPHA, (s) => elsewhere(async (dir) => {
      const target = path.join(dir, 'servers.json');
      fs.writeFileSync(target, OUTSIDE);
      const { w, outcome } = propose(s, s.request());
      const real = cw.io.write;
      cw.io.write = (file, body) => {
        fs.rmSync(file);
        fs.symlinkSync(target, file);
        return real(file, body);
      };
      const warn = console.warn;
      console.warn = () => {};
      try { s.answer(0, true); } finally { cw.io.write = real; console.warn = warn; }
      assert.strictEqual(fs.readFileSync(target, 'utf-8'), OUTSIDE, 'what the link leads to is byte-identical');
      assert.deepStrictEqual(standing(s.file), { link: target });
      assert.deepStrictEqual(w.sent, [{ type: 'connector_error', conversationId: ASKED_IN, message: WRITE_FAILED }], 'one message, and no save');
      assert.deepStrictEqual(await outcome, { ok: false, reason: 'write-failed', message: WRITE_FAILED });
    }));
  } finally { putBack(); }
});

test('where the platform has no O_NOFOLLOW, an honest add to a plain connector file is written and confirmed', async (t) => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  const putBack = withoutNoFollow(t);
  try {
    await inWorkspace(ALPHA, async (s) => {
      const { w, outcome } = propose(s, s.request());
      s.answer(0, true);
      assert.strictEqual(fs.readFileSync(s.file, 'utf-8'), formatted({ mcpServers: { ...ALPHA, ...LOCAL_TOOLS } }));
      assert.deepStrictEqual(w.sent, SAVED('local-tools', 'saved'));
      assert.strictEqual((await outcome).ok, true);
    });
  } finally { putBack(); }
});

test('after a write that failed during a turn, an agent writing the bytes it tried is still put back by the guard', async (t) => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  writesItsOwnWay();
  const before = formatted({ mcpServers: ALPHA });
  await inWorkspace(before, async (s) => {
    const turn = turnIn(s);
    try {
      const { outcome } = propose(s, s.request());
      t.mock.method(console, 'warn', () => {});
      t.mock.method(fs, 'writeSync', failingWrites(1));
      try { s.answer(0, true); } finally { t.mock.restoreAll(); }
      assert.strictEqual((await outcome).reason, 'write-failed');
      fs.writeFileSync(s.file, formatted({ mcpServers: { ...ALPHA, ...LOCAL_TOOLS } }));
      assert.deepStrictEqual(guard.checkAnswerFilesNow(s.dir).map((c) => c.relative), ['.mcp.json'], 'taken as somebody else\'s change');
      assert.strictEqual(fs.readFileSync(s.file, 'utf-8'), before, 'and put back');
    } finally { turn.release(); }
  });
});

// ===== Only a confirmed read-back is called saved =====

const NOT_CONFIRMED = 'Rundock saved the connector file but couldn\'t confirm it holds the change. Check Connectors in Settings.';
const readsBackItsOwnWay = () => assert.strictEqual(typeof (cw.io && cw.io.readBack), 'function', 'the writer reads the file again through its own no-follow step');

// An allowed change whose read-back is `readBack` (handed the writer's own):
// one message, no save and no line saying saved, and the outcome not-confirmed.
async function notConfirmed(t, s, readBack) {
  readsBackItsOwnWay();
  const { w, outcome } = propose(s, s.request());
  const logged = t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const real = cw.io.readBack;
  cw.io.readBack = (file) => readBack(file, real);
  try { s.answer(0, true); } finally { cw.io.readBack = real; t.mock.restoreAll(); }
  assert.deepStrictEqual(w.sent, [{ type: 'connector_error', conversationId: ASKED_IN, message: NOT_CONFIRMED }], 'one message, and no save');
  assert.deepStrictEqual(await outcome, { ok: false, reason: 'not-confirmed', message: NOT_CONFIRMED });
  assert.ok(!logged.mock.calls.some((c) => /\[Connector\] saved/.test(String(c.arguments[0]))), 'and no line says it was saved');
}

test('a read-back that finds other bytes than were written is not called saved', async (t) => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace(ALPHA, async (s) => {
    await notConfirmed(t, s, () => ({ bytes: Buffer.from(formatted({ mcpServers: ALPHA })) }));
  });
});

test('a read-back in which another connector differs is not called saved', async (t) => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace(ALPHA, async (s) => {
    const other = formatted({ mcpServers: { alpha: { url: 'https://other.example.com/mcp' }, ...LOCAL_TOOLS } });
    await notConfirmed(t, s, () => ({ bytes: Buffer.from(other) }));
  });
});

test('a read-back that throws is not called saved', async (t) => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace(ALPHA, async (s) => {
    await notConfirmed(t, s, () => { throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' }); });
  });
});

test('a read-back that finds a link at .mcp.json is not called saved, and reads nothing through it', { skip: NO_LINKS }, async (t) => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  await inWorkspace(ALPHA, (s) => elsewhere(async (dir) => {
    const target = path.join(dir, 'servers.json');
    fs.writeFileSync(target, formatted({ mcpServers: { ...ALPHA, ...LOCAL_TOOLS } }));
    await notConfirmed(t, s, (file, real) => {
      fs.renameSync(file, path.join(s.dir, 'moved.json'));
      fs.symlinkSync(target, file);
      return real(file);
    });
  }));
});

test('connector_saved is sent after the read-back, never before it', async (t) => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  readsBackItsOwnWay();
  await inWorkspace(ALPHA, async (s) => {
    const { w, outcome } = propose(s, s.request());
    const real = cw.io.readBack;
    let sentByThen = null;
    cw.io.readBack = (file) => { sentByThen = w.sent.map((m) => m.type); return real(file); };
    try { s.answer(0, true); } finally { cw.io.readBack = real; }
    assert.deepStrictEqual(sentByThen, [], 'nothing was sent before the file was read again');
    assert.deepStrictEqual(w.sent, SAVED('local-tools', 'saved'));
    assert.strictEqual((await outcome).ok, true);
  });
});

test('after not-confirmed, asking again raises a card showing the connector as the file now holds it', async (t) => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  readsBackItsOwnWay();
  await inWorkspace({ calendar: { url: 'https://old.example.com/mcp' } }, async (s) => {
    const replace = { change: 'replace', name: 'calendar', entry: { url: 'https://new.example.com/mcp' } };
    const first = propose(s, s.request(replace));
    const real = cw.io.readBack;
    // Another writer lands between the write and the read-back.
    cw.io.readBack = (file) => { s.rewrite({ calendar: { url: 'https://other.example.com/mcp' } }); return real(file); };
    t.mock.method(console, 'warn', () => {});
    try { s.answer(0, true); } finally { cw.io.readBack = real; t.mock.restoreAll(); }
    assert.deepStrictEqual(await first.outcome, { ok: false, reason: 'not-confirmed', message: NOT_CONFIRMED });
    propose(s, s.request(replace));
    assert.strictEqual(s.asked.length, 2, 'asking again gets its own card');
    assert.deepStrictEqual(s.asked[1].toolInput.current, { url: 'https://other.example.com/mcp' }, 'showing the file as it now stands');
  });
});

// ===== Honest changes, formatted as before =====

test('an honest add, replace and remove with no turn and no guard are written two-space indented with a closing newline, and confirmed', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  const held = { alpha: { url: 'https://mcp.example.com/mcp' }, 'local-tools': { command: 'node', args: ['old.js'] } };
  for (const [fields, servers, said] of [
    [{ name: 'example-beta', entry: { url: 'https://beta.example.com/mcp' } }, { ...held, 'example-beta': { url: 'https://beta.example.com/mcp' } }, 'saved'],
    [{ change: 'replace', entry: { command: 'node', args: ['new.js'] } }, { ...held, 'local-tools': { command: 'node', args: ['new.js'] } }, 'saved'],
    [{ change: 'remove', name: 'alpha', entry: undefined }, { 'local-tools': held['local-tools'] }, 'removed'],
  ]) {
    await inWorkspace(held, async (s) => {
      const { w, outcome } = propose(s, s.request(fields));
      s.answer(0, true);
      assert.strictEqual(fs.readFileSync(s.file, 'utf-8'), `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
      assert.deepStrictEqual(w.sent, SAVED(fields.name || 'local-tools', said, fields.change || 'add'));
      assert.strictEqual((await outcome).ok, true);
    });
  }
});

// ===== Every reply names the conversation that asked =====

// Each way an agent's change ends in the writer, driven from the request: the
// file it starts from, and what happens once it is asked. Returns propose's
// { w, outcome }.
const allowing = (s, fields, meanwhile = () => {}) => {
  const asked = propose(s, s.request(fields));
  meanwhile(s);
  s.answer(0, true);
  return asked;
};
const ENDINGS = [
  ['invalid', {}, (s) => propose(s, s.request({ change: 'save' }))],
  ['exists', LOCAL_TOOLS, (s) => propose(s, s.request())],
  ['absent', ALPHA, (s) => propose(s, s.request({ change: 'remove', entry: undefined }))],
  ['changed', { 'local-tools': STDIO_HELD }, (s) => allowing(s, { change: 'replace', entry: { command: 'node', args: ['new.js'] } },
    () => s.rewrite({ 'local-tools': { ...STDIO_HELD, args: ['other.js'] } }))],
  ['unreadable', '{ not json', (s) => propose(s, s.request())],
  ['denied', {}, (s) => { const asked = propose(s, s.request()); s.answer(0, false); return asked; }],
  ['timeout', {}, (s) => { const asked = propose(s, s.request()); s.answer(0, false, undefined, 'timeout'); return asked; }],
  ['write-failed', {}, (s, t) => {
    t.mock.method(console, 'warn', () => {});
    const asked = propose(s, s.request());
    t.mock.method(fs, 'writeSync', failingWrites(1));
    try { s.answer(0, true); } finally { t.mock.restoreAll(); }
    return asked;
  }],
  ['not-confirmed', {}, (s, t) => {
    t.mock.method(console, 'warn', () => {});
    const real = cw.io.readBack;
    cw.io.readBack = () => ({ bytes: Buffer.from('{}\n') });
    try { return allowing(s, {}); } finally { cw.io.readBack = real; t.mock.restoreAll(); }
  }],
];

for (const [reason, holds, end] of ENDINGS) {
  test(`a change that ends ${reason} answers the conversation that asked, once`, async (t) => {
    assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
    await inWorkspace(holds, async (s) => {
      const { w, outcome } = end(s, t);
      const ended = await outcome;
      assert.strictEqual(ended.reason, reason);
      assert.deepStrictEqual(w.sent, [{ type: 'connector_error', message: ended.message, conversationId: ASKED_IN }], 'one reply, carrying the id');
    });
  });
}

const DONE = [
  ['add', {}, {}, 'saved'],
  ['replace', LOCAL_TOOLS, { change: 'replace', entry: { command: 'node', args: ['new.js'] } }, 'saved'],
  ['remove', LOCAL_TOOLS, { change: 'remove', entry: undefined }, 'removed'],
];
for (const [change, holds, fields, action] of DONE) {
  test(`an allowed ${change} answers the conversation that asked, once, naming the change`, async () => {
    assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
    await inWorkspace(holds, async (s) => {
      const { w, outcome } = allowing(s, fields);
      assert.strictEqual((await outcome).ok, true);
      assert.deepStrictEqual(w.sent, [{ type: 'connector_saved', name: 'local-tools', change, action, takesEffect: 'next agent start', conversationId: ASKED_IN }]);
    });
  });
}

// ===== Only a well-formed conversation id is used =====

// Every file under a folder, by its path inside it.
function filesUnder(dir) {
  const found = [];
  const walk = (at) => {
    let entries = [];
    try { entries = fs.readdirSync(at, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(at, e.name);
      if (e.isDirectory()) walk(p);
      else found.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return found.sort();
}

const MALFORMED_IDS = [
  ['../escape', '../escape'],
  ['an empty string', ''],
  ['65 characters', 'a'.repeat(65)],
  ['a number', 7],
  ['an object', { id: ASKED_IN }],
  ['a string with a slash', 'convo/write'],
  ['a string with a newline', 'convo\nwrite'],
];
for (const [what, id] of MALFORMED_IDS) {
  test(`an agent's change whose conversation id is ${what} is refused before any card, writes nothing, and its refusal names no conversation`, async () => {
    assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
    await inWorkspace(ALPHA, async (s) => {
      const rundock = path.join(s.dir, '.rundock');
      const before = s.bytes();
      const kept = filesUnder(rundock);
      const { w, outcome } = propose(s, s.request({ conversationId: id }));
      assert.strictEqual(s.asked.length, 0, 'no card');
      assert.deepStrictEqual(s.bytes(), before, 'the file is byte-identical');
      assert.deepStrictEqual(filesUnder(rundock), kept, 'no new file under .rundock/');
      assert.deepStrictEqual(w.sent, [{ type: 'connector_error', message: NO_CONVERSATION }], 'one refusal, with no conversationId');
      assert.deepStrictEqual(await outcome, { ok: false, reason: 'invalid', message: NO_CONVERSATION });
    });
  });
}

test('an agent\'s change whose conversation id is 64 characters is asked about there, and its reply names it', async () => {
  assert.strictEqual(typeof cw.proposeConnectorChange, 'function');
  const id = `${'a'.repeat(32)}-${'B'.repeat(29)}_9`;
  assert.strictEqual(id.length, 64);
  await inWorkspace({}, async (s) => {
    const { w, outcome } = propose(s, s.request({ conversationId: id }));
    assert.strictEqual(s.asked.length, 1, 'one card');
    assert.strictEqual(s.asked[0].convoId, id, 'raised in that conversation');
    s.answer(0, true);
    assert.deepStrictEqual(w.sent, [{ type: 'connector_saved', name: 'local-tools', change: 'add', action: 'saved', takesEffect: 'next agent start', conversationId: id }]);
    assert.strictEqual((await outcome).ok, true);
  });
});
