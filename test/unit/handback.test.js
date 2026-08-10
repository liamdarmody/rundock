'use strict';
// buildHandbackPayload: the single source of the content a parent agent
// receives when a delegate hands back.
//
// Incident (0.11.2, conversation of 2026-07-29): an analyst delivered a 6,665
// character analysis in turn 1, was asked to hand back, and signed off in 106
// characters. Only the sign-off reached the lead, because finalResponseText
// held the last turn alone: responseText is reset after every turn by design.
// The lead correctly refused to invent the analysis and the user pasted 6,050
// characters by hand. The full report was in the transcript on disk the
// entire time.
//
// The contract these tests pin:
// 1. Accumulated turns (entry.deliveredTurns) are preferred: every turn, not
//    just the last.
// 2. When deliveredTurns is empty (the delegate crashed before any result),
//    the transcript on disk is the fallback, bounded by the delegation start
//    TIMESTAMP. A timestamp, not an index: appendTranscript splices entry 1
//    at the 1000-entry soft cap, so stored indices drift on long
//    conversations.
// 3. Truncation over the cap is LOUD: the payload states what was omitted and
//    names the transcript file, so the parent can read the rest instead of
//    silently working from a fragment.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { _internal: srv } = require('../../server.js');
const { makeWorkspace, cleanup } = require('../helpers/workspace.js');

after(cleanup);

let convoCounter = 0;
function freshConvoId() {
  return `hb-unit-${Date.now().toString(36)}-${++convoCounter}`;
}

function useWorkspace() {
  const dir = makeWorkspace({ agents: [] });
  srv.setWorkspace(dir);
  return dir;
}

function writeTranscript(dir, convoId, entries) {
  const tDir = path.join(dir, '.rundock', 'transcripts');
  fs.mkdirSync(tDir, { recursive: true });
  fs.writeFileSync(path.join(tDir, `${convoId}.json`), JSON.stringify(entries, null, 2));
}

describe('buildHandbackPayload', () => {
  test('joins every accumulated turn, not just the last, and strips markers', () => {
    const entry = {
      agentId: 'content-analyst',
      deliveredTurns: [
        'CADENCE-SUBSTANCE-T1: the full analysis.',
        'Passing this back now. <!-- RUNDOCK:RETURN -->',
      ],
    };
    const payload = srv.buildHandbackPayload(entry, freshConvoId());
    assert.ok(payload.includes('CADENCE-SUBSTANCE-T1: the full analysis.'), 'turn 1 substance present');
    assert.ok(payload.includes('Passing this back now.'), 'turn 2 sign-off present');
    assert.ok(payload.indexOf('CADENCE-SUBSTANCE-T1') < payload.indexOf('Passing this back now.'), 'turns in delivery order');
    assert.ok(!payload.includes('RUNDOCK:RETURN'), 'markers stripped');
  });

  test('falls back to the on-disk transcript when deliveredTurns is empty (crash path)', () => {
    const dir = useWorkspace();
    const convoId = freshConvoId();
    writeTranscript(dir, convoId, [
      { role: 'user', agent: 'user', text: 'brief', timestamp: '2026-08-10T10:00:00.000Z' },
      { role: 'agent', agent: 'content-analyst', text: 'TRANSCRIPT-SUBSTANCE from turn 1', timestamp: '2026-08-10T10:01:00.000Z' },
      { role: 'agent', agent: 'content-analyst', text: 'TRANSCRIPT-SIGNOFF from turn 2', timestamp: '2026-08-10T10:02:00.000Z' },
    ]);
    const entry = { agentId: 'content-analyst', deliveredTurns: [], delegationStartedAt: '2026-08-10T09:59:00.000Z' };
    const payload = srv.buildHandbackPayload(entry, convoId);
    assert.ok(payload.includes('TRANSCRIPT-SUBSTANCE from turn 1'));
    assert.ok(payload.includes('TRANSCRIPT-SIGNOFF from turn 2'));
  });

  test('transcript fallback is bounded by the delegation start timestamp and scoped to the agent', () => {
    const dir = useWorkspace();
    const convoId = freshConvoId();
    writeTranscript(dir, convoId, [
      // Before this delegation began: an earlier stint by the same agent.
      { role: 'agent', agent: 'content-analyst', text: 'STALE earlier-delegation output', timestamp: '2026-08-10T08:00:00.000Z' },
      // Other participants inside the window.
      { role: 'user', agent: 'user', text: 'USER message', timestamp: '2026-08-10T10:00:30.000Z' },
      { role: 'agent', agent: 'content-lead', text: 'PARENT turn', timestamp: '2026-08-10T10:00:45.000Z' },
      // Bookkeeping rows carry no session content.
      { role: 'agent', agent: 'content-analyst', text: '[Agent content-analyst]', type: 'routing', timestamp: '2026-08-10T10:00:50.000Z' },
      // The delegation's real output.
      { role: 'agent', agent: 'content-analyst', text: 'FRESH delegation output', timestamp: '2026-08-10T10:01:00.000Z' },
    ]);
    const entry = { agentId: 'content-analyst', deliveredTurns: [], delegationStartedAt: '2026-08-10T10:00:00.000Z' };
    const payload = srv.buildHandbackPayload(entry, convoId);
    assert.ok(payload.includes('FRESH delegation output'));
    assert.ok(!payload.includes('STALE'), 'turns before the delegation started are excluded');
    assert.ok(!payload.includes('USER message'), 'user rows excluded');
    assert.ok(!payload.includes('PARENT turn'), 'other agents excluded');
    assert.ok(!payload.includes('routing'), 'typed bookkeeping rows excluded');
  });

  test('truncation over the cap is loud: states the omission and names the transcript file', () => {
    const convoId = freshConvoId();
    const bigTurn = 'A'.repeat(13000);
    const entry = { agentId: 'content-analyst', deliveredTurns: [bigTurn, 'the closing turn'] };
    const payload = srv.buildHandbackPayload(entry, convoId);
    assert.ok(payload.length < bigTurn.length + 2000, 'payload is capped');
    assert.ok(/truncated/i.test(payload), 'truncation is announced');
    assert.ok(/\d/.test(payload.slice(12000)), 'omission is quantified');
    assert.ok(payload.includes(`.rundock/transcripts/${convoId}.json`), 'transcript path named so the parent can read the rest');
  });

  test('under the cap there is no truncation notice', () => {
    const entry = { agentId: 'content-analyst', deliveredTurns: ['short turn one', 'short turn two'] };
    const payload = srv.buildHandbackPayload(entry, freshConvoId());
    assert.ok(!/truncated/i.test(payload));
    assert.ok(!payload.includes('.rundock/transcripts/'));
  });

  test('no turns anywhere yields an empty payload, matching the empty-block contract at the injection sites', () => {
    useWorkspace();
    const entry = { agentId: 'content-analyst', deliveredTurns: [] };
    assert.strictEqual(srv.buildHandbackPayload(entry, freshConvoId()), '');
  });
});
