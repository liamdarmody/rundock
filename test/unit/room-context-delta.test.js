'use strict';
// What a delegate missed while it was away.
//
// THE DEFECT. A specialist wrote a draft, work passed through two other
// specialists, and when it came back to her she rebuilt the draft from scratch.
// Her own session WAS resumed, which the server log records. What she was never
// given is what the others did: a resumed, intercepted delegate receives its own
// thread and the orchestrator's brief, and nothing else. Each agent has a
// private thread and there is no shared room.
//
// SIZED BY MEASUREMENT. Across 307 transcripts and 4,449 real returns, the
// median delta is 242 characters and the worst is 232,770. A 12,000-character
// cap leaves 94% untruncated. Handing every delegate the whole transcript
// instead would have cost 47 million tokens on the longest real conversation,
// against 89 thousand for the capped delta.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const { deltaSince, DELTA_CAP_CHARS } = require(path.join(ROOT, 'lib', 'store', 'transcripts.js'));

const CONVO = [
  { role: 'agent', agent: 'vox', text: 'FIRST DRAFT by Vox' },
  { role: 'user', text: 'now research it' },
  { role: 'agent', agent: 'research-lead', text: 'RESEARCH FINDINGS' },
  { role: 'agent', agent: 'fact-checker', text: 'FACT CHECK NOTES' },
];

describe('the delta a returning delegate is given', () => {
  test('carries what the other agents did while it was away', () => {
    const d = deltaSince(CONVO, 'vox');
    assert.match(d.text, /RESEARCH FINDINGS/, 'the research it missed');
    assert.match(d.text, /FACT CHECK NOTES/, 'and the fact check');
  });

  test('does not repeat the agent its own earlier turn', () => {
    // Its session already carries this. Re-sending it is what makes a naive
    // full-transcript approach expensive, and it invites the agent to re-process
    // work it has already done.
    const d = deltaSince(CONVO, 'vox');
    assert.doesNotMatch(d.text, /FIRST DRAFT by Vox/,
      "the agent's own prior turn is not sent back to it");
  });

  test('carries the user turns it missed', () => {
    const d = deltaSince(CONVO, 'vox');
    assert.match(d.text, /now research it/, 'what the user said while it was away');
  });

  test('an agent with no earlier turn is given nothing', () => {
    // A first delegation has missed nothing: everything before it is the brief's
    // job, and the cold-spawn path already handles that case.
    const d = deltaSince(CONVO, 'never-seen-before');
    assert.strictEqual(d.text, null, 'no delta for an agent that was never here');
  });

  test('nothing missed produces no delta at all', () => {
    const justMe = [{ role: 'agent', agent: 'vox', text: 'only my own turn' }];
    assert.strictEqual(deltaSince(justMe, 'vox').text, null,
      'an empty delta must not become an empty section in the prompt');
  });
});

describe('the cap, and saying when it bit', () => {
  const long = [
    { role: 'agent', agent: 'vox', text: 'my old turn' },
    { role: 'agent', agent: 'a', text: 'OLDEST-MISSED ' + 'x'.repeat(DELTA_CAP_CHARS) },
    { role: 'agent', agent: 'b', text: 'NEWEST-MISSED' },
  ];

  test('keeps the most recent entries when it truncates', () => {
    const d = deltaSince(long, 'vox');
    assert.match(d.text, /NEWEST-MISSED/, 'what happened most recently survives');
    assert.doesNotMatch(d.text, /OLDEST-MISSED/, 'the oldest is what gets dropped');
  });

  test('says that it truncated, and how many turns went', () => {
    const d = deltaSince(long, 'vox');
    assert.strictEqual(d.truncated, 1, 'it reports how many entries were dropped');
    assert.match(d.text, /1 earlier turn/,
      'and says so in the text the agent reads, because an agent handed a silently '
      + 'trimmed history has no way to know it is working from a partial account');
  });

  test('a delta inside the cap is not marked truncated', () => {
    const d = deltaSince(CONVO, 'vox');
    assert.strictEqual(d.truncated, 0);
    assert.doesNotMatch(d.text, /earlier turn/);
  });

  test('the cap is one named number', () => {
    assert.strictEqual(typeof DELTA_CAP_CHARS, 'number');
    assert.ok(DELTA_CAP_CHARS > 0, 'and it is real');
  });
});

describe('the delta reaches the delegate', () => {
  // A BINDING, AND IT SAYS SO. Driving a re-delegation through the stub runtime
  // proved harder than it looked: the brief reaches a Claude delegate over
  // stdin, and two attempts at an end-to-end test matched stale messages rather
  // than the second delegation. Rather than ship a test that passes without
  // exercising the path, this pins the wiring and the gap is stated openly:
  // the delta's CONTENT is proven above; that a real re-delegation carries it
  // has been read in the code and not yet driven.
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'delegation', 'engine.js'), 'utf8');

  test('a resumed delegate has the delta built for it', () => {
    assert.match(src, /priorSessionId\s*\n?\s*\?\s*deltaSince\(/,
      'the delta is built only for a delegate being resumed, since a cold spawn '
      + 'already receives the full transcript');
  });

  test('and it is carried in the text the delegate is sent', () => {
    const at = src.indexOf('const contextWithHistory');
    assert.ok(at > -1, 'the delegate context is still assembled here');
    const block = src.slice(at, at + 400);
    assert.match(block, /sinceYouWereHere/,
      'the delta is part of what the delegate receives');
    // The same value goes to the Claude delegate over stdin and into the Codex
    // prompt, so one assertion covers both runtimes.
    assert.match(src, /stdin\.write\(JSON\.stringify\(\{ type: 'user', message: \{ role: 'user', content: contextWithHistory \}/,
      'and that text is what is written to the delegate');
  });
});
