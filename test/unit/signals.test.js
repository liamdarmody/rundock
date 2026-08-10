'use strict';
// Build A unit surface: the recordEvent core, docs-gap topic normalization,
// and retention. Integration coverage of the live seams is in
// test/integration/signals.test.js.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { _internal: srv } = require('../../server.js');
const { makeWorkspace, cleanup } = require('../helpers/workspace.js');

after(cleanup);

function monthStamp(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function waitFor(pred, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return pred();
}

describe('recordEvent', () => {
  test('writes the skinny schema to the monthly file', async () => {
    const dir = makeWorkspace({ agents: [] });
    srv.setWorkspace(dir);
    srv.recordEvent('handback', { conv: 'c1', agent: 'sollo', runtime: 'claude', d: { kind: 'return', to: 'cos' } });
    const file = path.join(dir, '.rundock', 'state', `events-${monthStamp()}.jsonl`);
    // Wait for the EVENT, not the file: appendFile makes the file visible at
    // open, momentarily empty, before the write lands.
    const readEvts = () => fs.existsSync(file)
      ? fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    assert.ok(await waitFor(() => readEvts().some(e => e.e === 'handback')), 'event recorded in the monthly file');
    const ev = readEvts().find(e => e.e === 'handback');
    assert.strictEqual(ev.conv, 'c1');
    assert.strictEqual(ev.agent, 'sollo');
    assert.strictEqual(ev.runtime, 'claude');
    assert.deepStrictEqual(ev.d, { kind: 'return', to: 'cos' });
    assert.ok(!Number.isNaN(Date.parse(ev.ts)), 'ts parses as a date');
  });

  test('omits empty fields so events stay skinny', async () => {
    const dir = makeWorkspace({ agents: [] });
    srv.setWorkspace(dir);
    srv.recordEvent('routine_run', { d: { routine: 'daily', status: 'completed', duration: 3 } });
    const file = path.join(dir, '.rundock', 'state', `events-${monthStamp()}.jsonl`);
    const readEvts = () => fs.existsSync(file)
      ? fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    assert.ok(await waitFor(() => readEvts().some(e => e.e === 'routine_run')), 'event recorded');
    const ev = readEvts().find(e => e.e === 'routine_run');
    assert.ok(!('conv' in ev), 'conv omitted where not applicable');
    assert.ok(!('agent' in ev), 'agent omitted where not applicable');
  });

  test('a write failure is swallowed, never thrown', () => {
    const dir = makeWorkspace({ agents: [] });
    srv.setWorkspace(dir);
    // Sabotage: .rundock/state is a file, so mkdir/append must fail.
    fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.rundock', 'state'), 'not a dir');
    assert.doesNotThrow(() => {
      srv.recordEvent('turn', { conv: 'c1', agent: 'x', d: {} });
    });
  });

  test('retention: files older than six months are pruned when a new month begins', async () => {
    const dir = makeWorkspace({ agents: [] });
    srv.setWorkspace(dir);
    const stateDir = path.join(dir, '.rundock', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'events-2020-01.jsonl'), '{"e":"turn"}\n');
    const recent = `events-${monthStamp()}.jsonl`;
    srv.recordEvent('turn', { conv: 'c1', agent: 'x', d: {} });
    assert.ok(await waitFor(() => fs.existsSync(path.join(stateDir, recent))), 'current month written');
    assert.ok(await waitFor(() => !fs.existsSync(path.join(stateDir, 'events-2020-01.jsonl'))),
      'ancient month pruned');
  });
});

describe('normalizeDocsGapTopic', () => {
  test('lowercases and drops stopwords: normalization is code, not a model', () => {
    assert.strictEqual(srv.normalizeDocsGapTopic('How Invoicing Works'), 'invoicing works');
    assert.strictEqual(srv.normalizeDocsGapTopic('what is the deploy process'), 'deploy process');
    assert.strictEqual(srv.normalizeDocsGapTopic(''), '');
  });

  test('the same question twice normalizes identically (the B9 detection contract)', () => {
    assert.strictEqual(
      srv.normalizeDocsGapTopic('How does invoicing work?'),
      srv.normalizeDocsGapTopic('how DOES  invoicing work'),
    );
  });
});

describe('stripRundockMarkers', () => {
  test('strips the DOCS_GAP marker like every other marker', () => {
    const input = 'Answer here. <!-- RUNDOCK:DOCS_GAP topic="how invoicing works" --> end';
    const out = srv.stripRundockMarkers(input);
    assert.ok(!out.includes('DOCS_GAP'), 'marker never renders');
    assert.ok(out.includes('Answer here.') && out.includes('end'), 'surrounding text kept');
  });
});
