'use strict';
// The stored line saying a delegate stopped before finishing: Rundock's own
// row in the conversation transcript (.rundock/transcripts/). It is never
// part of what an agent is told it missed, and the history a reopened
// conversation asks for hands it back as Rundock's own line, unchanged.
const { test, describe, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const { _internal: srv } = require(path.join(ROOT, 'server.js'));
const { deltaSince } = require(path.join(ROOT, 'lib', 'store', 'transcripts.js'));
const { handleGetSessionHistory } = require(path.join(ROOT, 'lib', 'protocol', 'handlers', 'history.js'));
const { makeWorkspace, cleanup, standardTeam } = require(path.join(ROOT, 'test', 'helpers', 'workspace.js'));

after(cleanup);

beforeEach(() => {
  srv.setWorkspace(makeWorkspace({ agents: standardTeam() }));
  srv.convoTranscripts.clear();
});

const LINE = "Wren stopped before finishing\nWren's session ended before a final answer (exit code 1). "
  + 'Cos has the conversation again. Anything Wren changed before stopping is still in your workspace.';

describe('what an agent is told it missed', () => {
  const NAMES = { 'example-agent': 'Alpha' };
  const ROW = { role: 'system', agent: null, text: LINE, type: 'delegation' };
  const transcript = () => [
    { role: 'agent', agent: 'other-agent', text: 'Earlier work of my own' },
    { role: 'user', agent: 'user', text: 'First question about alpha' },
    { role: 'agent', agent: 'example-agent', text: 'First answer about alpha' },
    ROW,
    { role: 'user', agent: 'user', text: 'Second question about beta' },
  ];

  test('leaves the line out for a returning agent and an arriving one', () => {
    for (const arriving of [false, true]) {
      const withRow = deltaSince(transcript(), 'other-agent', undefined, [], NAMES, arriving);
      const without = deltaSince(transcript().filter((t) => t !== ROW), 'other-agent', undefined, [], NAMES, arriving);
      assert.ok(withRow.text && withRow.text.includes('Second question about beta'), 'sanity: the turns around it are still told');
      assert.ok(!withRow.text.includes('stopped before finishing'), `arriving=${arriving}: ${withRow.text}`);
      assert.deepStrictEqual(withRow, without, `arriving=${arriving}: no line, no count`);
    }
  });
});

describe('the history a reopened conversation asks for', () => {
  function historyOf(conversationId) {
    return new Promise((resolve) => handleGetSessionHistory(
      { store: { parseSessionHistory: async () => ({ messages: [] }) } },
      { send: (s) => resolve(JSON.parse(s)) },
      { conversationId, sessionIds: [] },
    ));
  }

  test('hands the stored line back as Rundock\'s own, with its words unchanged', async () => {
    srv.appendTranscript('ds-h1', 'user', 'user', 'write the post');
    srv.appendTranscript('ds-h1', 'system', null, LINE, 'delegation');
    const row = srv.loadTranscript('ds-h1').find((t) => t.type === 'delegation');
    assert.ok(row, 'sanity: the line is stored');
    const reply = await historyOf('ds-h1');
    const lines = reply.messages.filter((m) => m.type === 'delegation');
    assert.deepStrictEqual(lines, [{ role: 'system', content: LINE, agentId: null, type: 'delegation', timestamp: row.timestamp }]);
  });
});
