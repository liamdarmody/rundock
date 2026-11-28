'use strict';
// What a connector change an agent asked for leaves in the conversation that
// asked, once its reply is sent: one line in the conversation's history, the
// words the window drew, and one outcome waiting for the agent's next turn.
//
// Driven through the real save and delete handlers and the real writer, with
// the cards held for the test to answer, and the server loaded so the history
// is written by its own writer. Every conversation id is new to the process,
// since the history writer keeps each conversation's lines in memory.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
// Loaded for its wiring: the notes module writes each line through the
// server's history writer.
require(path.join(ROOT, 'server.js'));
const config = require(path.join(ROOT, 'lib', 'config.js'));
const { buildDispatch } = require(path.join(ROOT, 'lib', 'protocol', 'handlers', 'index.js'));
const connectorWrite = require(path.join(ROOT, 'lib', 'workspace', 'connector-write.js'));

// The words each change ends with, as the writer and the handler say them.
const ADDED = (name) => `Connector "${name}" added. It starts the next time an agent starts.`;
const REPLACED = (name) => `Connector "${name}" replaced. It starts the next time an agent starts.`;
const REMOVED = (name) => `Connector "${name}" removed. Agents stop using it the next time they start.`;
const NOT_ALLOWED = 'The change was not allowed, so nothing was changed.';
const TIMED_OUT = 'Nobody answered the card in time, so nothing was changed.';
const ALREADY_SET_UP = (name) => `A connector named "${name}" is already set up, so nothing was changed. Ask to replace it if you meant to change it.`;
const NOT_CONFIGURED = (name) => `No connector named "${name}" is configured in this workspace, so nothing was changed.`;
const CHANGED = 'The connectors changed after you were asked, so nothing was changed. Ask again to see the change as it stands now.';
const NOT_JSON_FILE = 'The connector file is not valid JSON, so nothing was changed. Fix or remove it first: writing over it now would discard whatever was meant to be there.';
const WRITE_FAILED = 'Rundock couldn\'t save the connector file, so nothing was changed.';
const NOT_CONFIRMED = 'Rundock saved the connector file but couldn\'t confirm it holds the change. Check Connectors in Settings.';
const CURRENT_UNSHOWN = (name) => `The connector "${name}" as it is now holds a setting the approval card can't show, so nothing was changed. Change it in .mcp.json yourself.`;
const NO_CONVERSATION = 'That connector change didn\'t say which conversation it came from, so nothing was changed.';
const NAME_REFUSED = 'That connector name can\'t be used, so nothing was changed. A name uses letters, numbers, dots, dashes and underscores, and starts with a letter, number or underscore.';

const NAME = 'example.alpha';
const ALPHA = { [NAME]: { command: 'node', args: ['alpha.js'] } };

let made = 0;
// A workspace, open while `fn` runs, whose .mcp.json holds `holds` (a servers
// map, a string written as it is, or no file at all), and a conversation new
// to the process. `save` and `remove` send what the window sends for a
// marker, from that conversation unless the fields say otherwise; each
// returns the replies. The cards are held for `answer`.
function inWorkspace(holds, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-outcomes-'));
  const file = path.join(dir, '.mcp.json');
  if (typeof holds === 'string') fs.writeFileSync(file, holds);
  else if (holds) fs.writeFileSync(file, JSON.stringify({ mcpServers: holds }, null, 2));
  const asked = [];
  const ctx = {
    workspace: { isInsideWorkspace: () => true },
    agents: { validateAgentSlug: () => true },
    runtime: { requestServerPermission: (req) => { asked.push(req); } },
  };
  const convoId = `convo-outcomes-${process.pid}-${++made}`;
  const send = (type, fields) => {
    const sent = [];
    buildDispatch()[type](ctx, { send: (m) => sent.push(JSON.parse(m)), readyState: 1 }, { conversationId: convoId, ...fields });
    return sent;
  };
  const rundock = path.join(dir, '.rundock');
  const w = {
    dir, file, convoId, asked, rundock,
    save: (fields) => send('save_connector', { name: NAME, content: '{"command":"node","args":["alpha.js"]}', ...fields }),
    remove: (fields) => send('delete_connector', { name: NAME, ...fields }),
    answer: (i, allow, reason = 'user', how = { card: true }) => asked[i].onDecision(allow, reason, how),
    // The conversation's record as the next start reads it, or null.
    record: (id = convoId) => {
      try { return JSON.parse(fs.readFileSync(path.join(rundock, 'conversations.json'), 'utf-8')).find((c) => c.id === id) || null; } catch (e) { return null; }
    },
    waiting: (id = convoId) => { const r = w.record(id); return (r && r.teamOutcomes) || []; },
    // The lines kept in the conversation's history for the window to draw.
    lines: (id = convoId) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(rundock, 'transcripts', `${id}.json`), 'utf-8'))
          .filter((e) => e.role === 'system' && e.type === 'team').map((e) => e.text);
      } catch (e) { return []; }
    },
  };
  const open = config.getWorkspace();
  config.setWorkspace(dir);
  try { return fn(w); } finally { config.setWorkspace(open); fs.rmSync(dir, { recursive: true, force: true }); }
}

// One kept outcome, as the record holds it.
const kept = (kind, outcome, extra = {}) => ({ kind, name: NAME, author: null, outcome, ...extra });

describe('each outcome is kept once, in the conversation that asked', () => {
  test('an allowed add stores one line in the conversation\'s history and keeps one outcome waiting', () => {
    inWorkspace({}, (w) => {
      const sent = w.save();
      assert.deepStrictEqual(w.lines(), [], 'nothing is kept while the card waits');
      w.answer(0, true);
      assert.deepStrictEqual(w.lines(), [ADDED(NAME)]);
      assert.deepStrictEqual(w.waiting(), [kept('save_connector', 'saved')]);
      assert.deepStrictEqual(sent, [{ type: 'connector_saved', name: NAME, change: 'add', action: 'saved', takesEffect: 'next agent start', conversationId: w.convoId }]);
    });
  });

  test('an allowed replace stores one line in the conversation\'s history and keeps one outcome waiting', () => {
    inWorkspace(ALPHA, (w) => {
      w.save({ content: '{"command":"node","args":["beta.js"]}' });
      w.answer(0, true);
      assert.deepStrictEqual(w.lines(), [REPLACED(NAME)]);
      assert.deepStrictEqual(w.waiting(), [kept('save_connector', 'updated')]);
    });
  });

  test('an allowed remove stores one line in the conversation\'s history and keeps one outcome waiting', () => {
    inWorkspace(ALPHA, (w) => {
      w.remove();
      w.answer(0, true);
      assert.deepStrictEqual(w.lines(), [REMOVED(NAME)]);
      assert.deepStrictEqual(w.waiting(), [kept('delete_connector', 'deleted')]);
    });
  });

  // Each way the writer refuses or fails a change, reached through the
  // handlers: what the file holds, the request, and what happens once it is
  // asked about. The refusal's message is the line, and the reason is kept.
  const SAVE = 'save_connector';
  const DELETE = 'delete_connector';
  const REFUSALS = [
    ['invalid', SAVE, 'refused', { [NAME]: { command: 'node', timeout: 5 } }, (w) => w.save({ content: '{"url":"https://alpha.example.com/mcp"}' }), CURRENT_UNSHOWN(NAME)],
    ['exists', SAVE, 'refused', {}, (w) => { w.save(); fs.writeFileSync(w.file, JSON.stringify({ mcpServers: ALPHA })); w.answer(0, true); }, ALREADY_SET_UP(NAME)],
    ['absent', DELETE, 'refused', {}, (w) => w.remove(), NOT_CONFIGURED(NAME)],
    ['changed', DELETE, 'refused', ALPHA, (w) => { w.remove(); fs.writeFileSync(w.file, JSON.stringify({ mcpServers: { [NAME]: { command: 'node' } } })); w.answer(0, true); }, CHANGED],
    ['denied', SAVE, 'refused', {}, (w) => { w.save(); w.answer(0, false); }, NOT_ALLOWED],
    ['timeout', DELETE, 'refused', ALPHA, (w) => { w.remove(); w.answer(0, false, 'timeout'); }, TIMED_OUT],
    ['unreadable', DELETE, 'error', '{ not json', (w) => w.remove(), NOT_JSON_FILE],
    ['write-failed', SAVE, 'error', {}, (w) => {
      w.save();
      const real = connectorWrite.io.write;
      connectorWrite.io.write = () => { throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' }); };
      try { w.answer(0, true); } finally { connectorWrite.io.write = real; }
    }, WRITE_FAILED],
    ['not-confirmed', SAVE, 'error', {}, (w) => {
      w.save();
      const real = connectorWrite.io.readBack;
      connectorWrite.io.readBack = () => ({ bytes: Buffer.from('{}\n') });
      try { w.answer(0, true); } finally { connectorWrite.io.readBack = real; }
    }, NOT_CONFIRMED],
  ];
  for (const [reason, kind, outcome, holds, act, message] of REFUSALS) {
    test(`a change that ends ${reason} stores its message as the line and keeps one outcome with its reason`, (t) => {
      t.mock.method(console, 'warn', () => {});
      inWorkspace(holds, (w) => {
        act(w);
        assert.deepStrictEqual(w.lines(), [message], 'one line, the refusal\'s own words');
        assert.deepStrictEqual(w.waiting(), [kept(kind, outcome, { message, reason })], 'one outcome, with its reason');
      });
    });
  }

  test('a save refused because the connector file cannot be read is kept as unreadable', () => {
    inWorkspace('{ not json', (w) => {
      w.save();
      assert.deepStrictEqual(w.lines(), [NOT_JSON_FILE]);
      assert.deepStrictEqual(w.waiting(), [kept('save_connector', 'error', { message: NOT_JSON_FILE, reason: 'unreadable' })]);
    });
  });

  test('an outcome is kept in the step that sends its reply, before the request\'s call returns', () => {
    inWorkspace({}, (w) => {
      w.save({ name: '-alpha' });
      assert.strictEqual(w.waiting().length, 1, 'a refusal is kept by the time the handler returns');
      w.save();
      w.answer(0, true);
      assert.strictEqual(w.waiting().length, 2, 'an allowed change is kept by the time the card\'s answer returns');
    });
  });
});

describe('a request that names no conversation, or not in a well-formed id, keeps nothing', () => {
  const NONE = [
    ['no conversation id', { conversationId: undefined }],
    ['a conversation id that is not well formed', { conversationId: '../escape' }],
  ];
  for (const [what, fields] of NONE) {
    test(`a request with ${what} records nothing: no line, no waiting outcome, no record, no history file`, () => {
      inWorkspace(ALPHA, (w) => {
        const sent = [
          ...w.save({ ...fields, name: '-alpha' }),
          ...w.save({ ...fields, content: 'not json' }),
          ...w.save(fields),
          ...w.remove(fields),
        ];
        assert.deepStrictEqual(sent, [
          { type: 'connector_error', message: NAME_REFUSED },
          { type: 'connector_error', message: 'The connector entry is not valid JSON, so nothing was changed.' },
          { type: 'connector_error', message: NO_CONVERSATION },
          { type: 'connector_error', message: NO_CONVERSATION },
        ], 'each refused once, with no conversation named');
        assert.strictEqual(w.asked.length, 0, 'nobody is asked');
        assert.ok(!fs.existsSync(w.rundock), 'no record created and no history file written');
        assert.strictEqual(w.record('../escape'), null);
      });
    });
  }

  test('Rundock\'s own add with no conversation records nothing', () => {
    inWorkspace({}, (w) => {
      const sent = [];
      const ws = { send: (m) => sent.push(JSON.parse(m)) };
      const ctx = { workspace: { isInsideWorkspace: () => true }, runtime: { requestServerPermission: ({ onDecision }) => onDecision(true, 'user', { card: true }) } };
      connectorWrite.proposeConnectorChange(ctx, ws, { workspace: w.dir, change: 'add', name: NAME, entry: { command: 'node' }, source: 'rundock' });
      assert.deepStrictEqual(sent, [{ type: 'connector_saved', name: NAME, change: 'add', action: 'saved', takesEffect: 'next agent start' }]);
      assert.ok(!fs.existsSync(w.rundock), 'no record and no history');
    });
  });
});
