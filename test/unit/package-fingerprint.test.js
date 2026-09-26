'use strict';
// The authored fingerprint: what a package update compares to tell "the
// author changed this" from "the person edited this". An agent's routine
// state that Rundock writes (the lazy migration, a switch in the Routines
// view, a plan approval) is not an edit, so it must not move the
// fingerprint; anything the person or the author wrote must.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { authoredDigest } = require('../../lib/packages/package-fingerprint.js');
const { digestFile } = require('../../lib/packages/import-apply.js');
const { migrateAgentRoutines, updateRoutineBlock } = require('../../lib/agents/routines.js');
const { makeTempDir } = require('../helpers/workspace.js');

// Hand-written, the way a package author writes a routine: no runOn, no
// enabled, no plan hash. Rundock adds those on first read.
const AGENT = [
  '---',
  'name: scout',
  'source: https://github.com/example/team',
  'routines:',
  '  - name: Morning briefing',
  '    schedule: every day at 08:00',
  '    prompt: Summarise what changed overnight.',
  '---',
  '',
  'You scout.',
  '',
].join('\n');

const agentDigest = (text) => authoredDigest('agent', Buffer.from(text, 'utf8'));

describe('authored fingerprint of an agent', () => {
  test('the lazy routine migration does not move it', () => {
    const ws = makeTempDir('fingerprint-');
    const file = path.join(ws, '.claude', 'agents', 'scout.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, AGENT);
    const migrated = migrateAgentRoutines(file, AGENT);
    assert.notStrictEqual(migrated, AGENT, 'the fixture must actually be migrated');
    assert.strictEqual(agentDigest(migrated), agentDigest(AGENT));
  });

  test('switching, pausing and approving a routine do not move it', () => {
    const base = agentDigest(AGENT);
    for (const updates of [
      { enabled: true }, { enabled: false }, { paused: true }, { runOn: 'this-computer' },
      { planApprovedHash: 'abc123', planApprovedAt: '2026-09-24T08:00:00.000Z' },
      { planHash: 'def456' },
    ]) {
      const next = updateRoutineBlock(AGENT, 'Morning briefing', updates);
      assert.notStrictEqual(next, AGENT, `fixture must change for ${JSON.stringify(updates)}`);
      assert.strictEqual(agentDigest(next), base, `moved by ${JSON.stringify(updates)}`);
    }
  });

  test('an edit to a routine instruction or schedule moves it', () => {
    const base = agentDigest(AGENT);
    const prompt = updateRoutineBlock(AGENT, 'Morning briefing', { prompt: 'Summarise the week.' });
    const schedule = updateRoutineBlock(AGENT, 'Morning briefing', { schedule: 'every day at 09:00' });
    assert.notStrictEqual(agentDigest(prompt), base);
    assert.notStrictEqual(agentDigest(schedule), base);
  });

  test('an edit to the body or to other frontmatter moves it', () => {
    const base = agentDigest(AGENT);
    assert.notStrictEqual(agentDigest(AGENT.replace('You scout.', 'You scout carefully.')), base);
    assert.notStrictEqual(agentDigest(AGENT.replace('name: scout', 'name: scout\nmodel: opus')), base);
  });

  test('a state key outside the routines section is an edit', () => {
    const withTopLevel = AGENT.replace('name: scout', 'name: scout\nenabled: true');
    assert.notStrictEqual(agentDigest(withTopLevel), agentDigest(AGENT));
  });

  test('line endings and a byte-order mark do not move it', () => {
    assert.strictEqual(agentDigest(`\ufeff${AGENT.replace(/\n/g, '\r\n')}`), agentDigest(AGENT));
  });

  test('it never equals the whole-file digest of the same bytes', () => {
    assert.notStrictEqual(agentDigest(AGENT), digestFile(Buffer.from(AGENT, 'utf8')));
  });
});

describe('authored fingerprint of other kinds', () => {
  test('a skill or starter file is its ordinary fingerprint', () => {
    const fingerprint = digestFile(Buffer.from('x'));
    assert.strictEqual(authoredDigest('starter', Buffer.from('x'), fingerprint), fingerprint);
    assert.strictEqual(authoredDigest('skill', null, 'sha256:' + 'a'.repeat(64)), 'sha256:' + 'a'.repeat(64));
  });
});
