'use strict';
// Characterization: conversation transcript persistence (.rundock/transcripts/).
const { test, describe, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { _internal: srv } = require('../../server.js');
const { makeWorkspace, cleanup, standardTeam } = require('../helpers/workspace.js');

after(cleanup);

let dir;
beforeEach(() => {
  dir = makeWorkspace({ agents: standardTeam() });
  srv.setWorkspace(dir);
  srv.convoTranscripts.clear();
});

function transcriptFile(convoId) {
  return path.join(dir, '.rundock', 'transcripts', `${convoId}.json`);
}

describe('append/load/save transcript', () => {
  test('append persists to disk and loads back after a simulated restart', () => {
    srv.appendTranscript('c1', 'user', 'user', 'hello');
    srv.appendTranscript('c1', 'agent', 'content-lead', 'hi there, here is a draft');
    const onDisk = JSON.parse(fs.readFileSync(transcriptFile('c1'), 'utf-8'));
    assert.strictEqual(onDisk.length, 2);
    assert.strictEqual(onDisk[0].role, 'user');
    assert.strictEqual(onDisk[1].agent, 'content-lead');
    assert.ok(onDisk[1].timestamp);

    // simulate restart: drop in-memory cache, reload from disk
    srv.convoTranscripts.clear();
    const loaded = srv.loadTranscript('c1');
    assert.strictEqual(loaded.length, 2);
    assert.strictEqual(loaded[1].text, 'hi there, here is a draft');
  });

  test('routing-typed entries carry type', () => {
    srv.appendTranscript('c2', 'agent', 'chief-of-staff', '[Read a.md]', 'routing');
    const onDisk = JSON.parse(fs.readFileSync(transcriptFile('c2'), 'utf-8'));
    assert.strictEqual(onDisk[0].type, 'routing');
  });

  test('missing transcript loads as empty array', () => {
    assert.deepStrictEqual(srv.loadTranscript('nope'), []);
  });

  test('soft cap: at 1000 entries the SECOND entry is evicted (index 1), first is kept', () => {
    const t = [];
    for (let i = 0; i < 1000; i++) t.push({ role: 'user', agent: 'user', text: `m${i}` });
    srv.convoTranscripts.set('c3', t);
    srv.appendTranscript('c3', 'user', 'user', 'overflow');
    const after_ = srv.convoTranscripts.get('c3');
    assert.strictEqual(after_.length, 1000);
    assert.strictEqual(after_[0].text, 'm0', 'first entry retained');
    assert.strictEqual(after_[1].text, 'm2', 'index 1 evicted');
    assert.strictEqual(after_[999].text, 'overflow');
  });

  test('recovery: a truncated array with a partial trailing object salvages the complete leading ones', () => {
    // Truncation mid-key on the second object cannot be auto-closed, so the
    // complete-object salvage keeps only the first entry.
    fs.mkdirSync(path.dirname(transcriptFile('rec1')), { recursive: true });
    fs.writeFileSync(transcriptFile('rec1'), '[{"role":"user","agent":"user","text":"one"},{"role":"agent","ag');
    const loaded = srv.loadTranscript('rec1');
    assert.strictEqual(loaded.length, 1, 'one complete object recovered');
    assert.strictEqual(loaded[0].text, 'one');
  });

  test('recovery: unrecoverable garbage loads as empty (does not throw)', () => {
    fs.mkdirSync(path.dirname(transcriptFile('rec2')), { recursive: true });
    fs.writeFileSync(transcriptFile('rec2'), 'not json at all {{{');
    assert.deepStrictEqual(srv.loadTranscript('rec2'), []);
  });

  test('a corrupt (truncated) transcript is salvaged, not wiped, on the next append', () => {
    // Post-fix behavior: loadTranscript recovers as much history as possible
    // from a truncated file, so appendTranscript preserves it rather than
    // overwriting with only the new entry. Regression companion in regression.test.js.
    fs.mkdirSync(path.dirname(transcriptFile('c4')), { recursive: true });
    fs.writeFileSync(transcriptFile('c4'), '[{"role":"user","text":"old history"'); // truncated JSON
    srv.appendTranscript('c4', 'user', 'user', 'new message');
    const onDisk = JSON.parse(fs.readFileSync(transcriptFile('c4'), 'utf-8'));
    assert.strictEqual(onDisk.length, 2, 'salvaged prior entry + new entry');
    assert.strictEqual(onDisk[0].text, 'old history', 'prior history recovered');
    assert.strictEqual(onDisk[1].text, 'new message');
  });
});

describe('formatTranscript', () => {
  test('formats user and agent turns with display names', () => {
    srv.appendTranscript('c5', 'user', 'user', 'write me a post');
    srv.appendTranscript('c5', 'agent', 'content-lead', 'Here is a draft.');
    const out = srv.formatTranscript('c5');
    assert.strictEqual(out, 'USER: write me a post\n\nPENN: Here is a draft.');
  });

  test('unknown agent id falls back to raw id', () => {
    srv.appendTranscript('c6', 'agent', 'ghost-agent', 'boo');
    assert.strictEqual(srv.formatTranscript('c6'), 'GHOST-AGENT: boo');
  });

  test('excludeAgent filters that agent\'s own turns but keeps user turns', () => {
    srv.appendTranscript('c7', 'user', 'user', 'q1');
    srv.appendTranscript('c7', 'agent', 'content-lead', 'a1');
    srv.appendTranscript('c7', 'agent', 'lead-designer', 'a2');
    const out = srv.formatTranscript('c7', { excludeAgent: 'content-lead' });
    assert.ok(out.includes('USER: q1'));
    assert.ok(!out.includes('a1'));
    assert.ok(out.includes('DES: a2'));
  });

  test('empty or missing transcript returns null', () => {
    assert.strictEqual(srv.formatTranscript('missing'), null);
    srv.appendTranscript('c8', 'agent', 'content-lead', 'only agent');
    assert.strictEqual(srv.formatTranscript('c8', { excludeAgent: 'content-lead' }), null);
  });
});
