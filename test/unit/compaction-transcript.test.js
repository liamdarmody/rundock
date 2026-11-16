'use strict';
// Where a conversation was summarised to make room, as Rundock keeps it: its
// own entry in the conversation transcript (.rundock/transcripts/), holding
// the key the runtime gave the summary and nothing else, and never part of
// what an agent is told it missed.
const { test, describe, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { _internal: srv } = require('../../server.js');
const { appendCompaction, deltaSince } = require('../../lib/store/transcripts.js');
const { makeWorkspace, cleanup, standardTeam } = require('../helpers/workspace.js');

after(cleanup);

let dir;
beforeEach(() => {
  dir = makeWorkspace({ agents: standardTeam() });
  srv.setWorkspace(dir);
  srv.convoTranscripts.clear();
});

const onDisk = (convoId) => JSON.parse(fs.readFileSync(path.join(dir, '.rundock', 'transcripts', `${convoId}.json`), 'utf-8'));
const marks = (entries) => entries.filter((t) => t.type === 'compaction').map((t) => t.key);

describe('the stored entry', () => {
  test('is its own entry, after the turns before it, with the key and no text, and survives a restart', () => {
    srv.appendTranscript('c1', 'user', 'user', 'First question about alpha');
    srv.appendTranscript('c1', 'agent', 'content-lead', 'First answer about alpha');
    assert.strictEqual(appendCompaction('c1', 'summary-1'), true);
    srv.appendTranscript('c1', 'user', 'user', 'Second question about beta');
    const entries = onDisk('c1');
    assert.deepStrictEqual(entries.map((t) => t.type || t.role), ['user', 'agent', 'compaction', 'user']);
    const { timestamp, ...rest } = entries[2];
    assert.deepStrictEqual(rest, { role: 'system', agent: null, text: '', type: 'compaction', key: 'summary-1' });
    assert.ok(!Number.isNaN(Date.parse(timestamp)));
    srv.convoTranscripts.clear();
    assert.deepStrictEqual(marks(srv.loadTranscript('c1')), ['summary-1']);
  });

  test('a summary announced twice is one entry; two summaries are two, in order', () => {
    appendCompaction('c2', 'first');
    assert.strictEqual(appendCompaction('c2', 'first'), false);
    srv.convoTranscripts.clear();
    assert.strictEqual(appendCompaction('c2', 'first'), false, 'and still one after a restart');
    appendCompaction('c2', 'second');
    assert.deepStrictEqual(marks(onDisk('c2')), ['first', 'second']);
  });

  test('without a key it names nothing, so nothing is stored', () => {
    for (const key of [undefined, null, '', 7, { id: 'x' }]) assert.strictEqual(appendCompaction('c3', key), false);
    assert.ok(!fs.existsSync(path.join(dir, '.rundock', 'transcripts', 'c3.json')));
  });
});

describe('what an agent is told it missed', () => {
  const NAMES = { 'example-agent': 'Alpha' };
  // The agent being caught up spoke once at the start, so a returning one has
  // something to return from.
  const transcript = (marker) => [
    { role: 'agent', agent: 'other-agent', text: 'Earlier work of my own' },
    { role: 'user', agent: 'user', text: 'First question about alpha' },
    { role: 'agent', agent: 'example-agent', text: 'First answer about alpha' },
    marker,
    { role: 'user', agent: 'user', text: 'Second question about beta' },
    { role: 'agent', agent: 'example-agent', text: 'Second answer about beta' },
  ];
  const STORED = { role: 'system', agent: null, text: '', type: 'compaction', key: 'k' };
  // An entry of the type with text in it. Rundock never writes one; it stands
  // for any text such an entry might come to carry.
  const WITH_TEXT = { ...STORED, text: 'SUMMARY-TEXT of everything above' };

  test('leaves the entry out for a returning agent and an arriving one, whatever text it holds', () => {
    for (const arriving of [false, true]) {
      const out = deltaSince(transcript(WITH_TEXT), 'other-agent', undefined, [], NAMES, arriving);
      assert.ok(out.text && out.text.includes('Second answer about beta'));
      assert.ok(!out.text.includes('SUMMARY-TEXT'), `arriving=${arriving}: ${out.text}`);
    }
  });

  test('the entry as stored adds nothing either: no line, no count (main already behaves this way)', () => {
    for (const arriving of [false, true]) {
      const withMark = deltaSince(transcript(STORED), 'other-agent', undefined, [], NAMES, arriving);
      const without = deltaSince(transcript(STORED).filter((t) => t !== STORED), 'other-agent', undefined, [], NAMES, arriving);
      assert.deepStrictEqual(withMark, without);
    }
  });

  test('is never counted among the turns a short catch-up leaves out', () => {
    const long = 'x'.repeat(400);
    const t = [
      { role: 'agent', agent: 'other-agent', text: 'my own turn' },
      { role: 'agent', agent: 'example-agent', text: long },
      { ...WITH_TEXT, text: long },
      { role: 'agent', agent: 'example-agent', text: 'the latest turn' },
    ];
    const out = deltaSince(t, 'other-agent', 300, [], NAMES, false);
    assert.strictEqual(out.truncated, 1, 'one real turn left out, and the summary entry not among them');
  });
});
