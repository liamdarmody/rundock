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
  // NOW DRIVEN, NOT READ. The previous version of this block matched regexes
  // against engine.js: it proved two identifiers sat near each other, and would
  // have passed unchanged if the wiring were assigned from the wrong variable.
  // The prompt assembly is a pure function now, so these assert on the bytes a
  // delegate actually receives.
  const { buildDelegateContext } = require(path.join(ROOT, 'lib', 'delegation', 'catch-up.js'));

  const transcript = [
    { role: 'user', text: 'write me a short blog post' },
    { agent: 'vox', text: 'here is the first draft' },
    { agent: 'ed', text: 'I tightened the opening' },
    { agent: 'nia', text: 'and I checked the facts' }
  ];

  test('a resumed delegate is sent what the others did while it was away', () => {
    const missed = deltaSince(transcript, 'vox');
    const sent = buildDelegateContext({ transcript: null, missed, brief: 'now finish it' });
    assert.match(sent, /I tightened the opening/, "the other agents' work is in the prompt");
    assert.match(sent, /and I checked the facts/);
    assert.match(sent, /\[DELEGATION BRIEF\]\nnow finish it/, 'and the brief still arrives');
  });

  test('and not its own earlier turn, which its session already carries', () => {
    const missed = deltaSince(transcript, 'vox');
    const sent = buildDelegateContext({ transcript: null, missed, brief: 'now finish it' });
    assert.ok(!sent.includes('here is the first draft'),
      're-sending an agent its own work is pure cost and invites it to redo the work');
  });

  test('a first-time delegate gets the transcript, and no catch-up section', () => {
    const sent = buildDelegateContext({
      transcript: 'USER: write me a short blog post', missed: { text: null }, brief: 'draft it'
    });
    assert.match(sent, /CONVERSATION SO FAR:/);
    assert.ok(!sent.includes('SINCE YOUR LAST TURN'),
      'an agent that has missed nothing must not be told it missed something');
  });

  test('a delegate with nothing missed gets the brief alone', () => {
    const sent = buildDelegateContext({ transcript: null, missed: { text: null }, brief: 'go' });
    assert.strictEqual(sent, '[DELEGATION BRIEF]\ngo', 'no empty catch-up heading');
  });

  test('the engine sends that assembled text, and builds the delta only on resume', () => {
    // The one binding left against source: which VALUES the pure functions are
    // called with. Their behaviour is driven above.
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'delegation', 'engine.js'), 'utf8');
    assert.match(src, /\(priorSessionId && !isCodexDelegate\)/,
      'built only for a delegate being resumed, and never for Codex, whose resumed '
      + 'thread already carries the history');
    assert.match(src, /buildDelegateContext\(\{ transcript, missed, brief: msg\.context \}\)/);
    assert.match(src, /stdin\.write\(JSON\.stringify\(\{ type: 'user', message: \{ role: 'user', content: contextWithHistory \}/,
      'and that text is what is written to the delegate');
  });
});

describe('the orchestrator coming back is treated the same way', () => {
  // THE OTHER HALF, and on the evidence the more damaging one. A returning
  // DELEGATE at least had a session to resume. The orchestrator was spawned
  // with no session at all on a scope return: no history, only its system
  // prompt and the handback text. It came back knowing what the specialist had
  // just said and nothing about what the user originally asked for.
  //
  // Observed in real use: a request for a short blog post came back, after two
  // handoffs, as a delegation asking a specialist for a LinkedIn post.
  const { buildScopeReturnPrompt, lastSessionFor } = require(path.join(ROOT, 'lib', 'delegation', 'catch-up.js'));

  const transcript = [
    { role: 'user', text: 'write me a short blog post' },
    { agent: 'cos', text: 'delegating this to vox' },
    { agent: 'ed', text: 'I tightened the opening' },
    { agent: 'vox', text: 'FINAL: here is the finished post' }
  ];

  test('it is told the original request it delegated on', () => {
    const missed = deltaSince(transcript, 'cos', undefined, ['vox']);
    const prompt = buildScopeReturnPrompt({
      complete: true, orchMissed: missed, specialistId: 'vox',
      outputBlock: '\n\n--- vox ---\nFINAL: here is the finished post\n---'
    });
    assert.match(prompt, /I tightened the opening/,
      'what happened while it was away, which is what it had no way to know');
  });

  test("the specialist's handback is not sent twice in one prompt", () => {
    // outputBlock already carries it. Before the delta excluded the returning
    // specialist, the same text arrived in both halves on every handback.
    const missed = deltaSince(transcript, 'cos', undefined, ['vox']);
    const prompt = buildScopeReturnPrompt({
      complete: true, orchMissed: missed, specialistId: 'vox',
      outputBlock: '\n\n--- vox ---\nFINAL: here is the finished post\n---'
    });
    const hits = prompt.split('FINAL: here is the finished post').length - 1;
    assert.strictEqual(hits, 1, 'exactly once, in the block that exists to carry it');
  });

  test('a routing return carries the catch-up and the pending request', () => {
    const missed = deltaSince(transcript, 'cos', undefined, ['vox']);
    const prompt = buildScopeReturnPrompt({
      complete: false, orchMissed: missed, specialistId: 'vox',
      outputBlock: '\n\n--- vox ---\nout of scope\n---', pendingRequest: 'book me a flight'
    });
    assert.match(prompt, /SINCE YOUR LAST TURN IN THIS CONVERSATION/);
    assert.match(prompt, /book me a flight/);
  });

  test('a cold orchestrator is told nothing about turns it cannot remember', () => {
    const prompt = buildScopeReturnPrompt({
      complete: true, orchMissed: { text: null }, specialistId: 'vox', outputBlock: ''
    });
    assert.ok(!prompt.includes('SINCE YOUR LAST TURN'),
      'told "since your last turn" while cold-spawned, it hears about a turn it has '
      + 'no memory of, which is worse than the old cold spawn that claimed nothing');
  });

  test('the session it resumes is the one recorded for this conversation', () => {
    const convos = [{ id: 'c1', sessionIds: [
      { agentId: 'cos', sessionId: 'old' }, { agentId: 'vox', sessionId: 'v1' },
      { agentId: 'cos', sessionId: 'newest' }
    ] }];
    assert.strictEqual(lastSessionFor(convos, 'c1', 'cos'), 'newest', 'the latest, not the first');
    assert.strictEqual(lastSessionFor(convos, 'c1', 'nobody'), null, 'and cold spawn when there is none');
    assert.strictEqual(lastSessionFor([], 'c1', 'cos'), null);
  });

  test('the engine resumes the orchestrator and says which happened', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'delegation', 'engine.js'), 'utf8');
    const at = src.indexOf('function handleScopeReturn');
    const body = src.slice(at, src.indexOf('\nfunction ', at + 1));
    assert.match(body, /orchestratorSession \? \['--resume', orchestratorSession\]/,
      'the orchestrator keeps its own history across a handback');
    assert.match(body, /deltaSince\(loadTranscript\(convoId\) \|\| \[\], orchestrator\.id, undefined, \[specialistEntry\.agentId\]\)/,
      'and the returning specialist is excluded from its catch-up');
    assert.match(body, /resume=none/,
      'the log distinguishes a resumed orchestrator from a cold one, so a reader '
      + 'can tell which happened rather than inferring it from behaviour');
  });
});

describe('one turn longer than the cap is still capped', () => {
  // THE CASE THE CAP EXISTS FOR, and the one it missed. The newest missed turn
  // is admitted unconditionally so a delta is never empty, and that admission
  // skipped the size check: a single 232,770-character turn passed through
  // whole while reporting `truncated: 0`. The measured corpus names that exact
  // number as its worst case, so the cap was defeated by precisely the input it
  // was sized against.
  test('a single oversized turn is clipped, not passed through', () => {
    const convo = [
      { role: 'agent', agent: 'vox', text: 'my own turn' },
      { role: 'agent', agent: 'ren', text: 'HUGE ' + 'x'.repeat(DELTA_CAP_CHARS * 3) },
    ];
    const d = deltaSince(convo, 'vox');
    assert.ok(d.text.length <= DELTA_CAP_CHARS,
      `the delta is within the cap it names (got ${d.text.length}, cap ${DELTA_CAP_CHARS})`);
  });

  test('and the delegate is told it was cut off', () => {
    const convo = [
      { role: 'agent', agent: 'vox', text: 'mine' },
      { role: 'agent', agent: 'ren', text: 'x'.repeat(DELTA_CAP_CHARS * 2) },
    ];
    const d = deltaSince(convo, 'vox');
    assert.strictEqual(d.clipped, 1, 'the clipping is reported');
    assert.match(d.text, /cut off here/,
      'and said in the text, because an agent given a silently truncated turn '
      + 'cannot know it is working from part of one');
  });

  test('a turn inside the cap is not clipped', () => {
    const d = deltaSince([{ role: 'agent', agent: 'vox', text: 'mine' },
                          { role: 'agent', agent: 'ren', text: 'short' }], 'vox');
    assert.strictEqual(d.clipped, 0);
    assert.doesNotMatch(d.text, /cut off here/);
  });
});

describe('a cold-spawned orchestrator is told nothing about turns it cannot remember', () => {
  // The delta excludes an agent's own turns on the grounds that its session
  // already carries them. That reasoning holds only when --resume actually
  // fired. Told "since your last turn" while cold-spawned, the orchestrator
  // hears about a turn it has no memory of, which is worse than the old
  // behaviour: that claimed nothing.
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'delegation', 'engine.js'), 'utf8');
  const at = src.indexOf('function handleScopeReturn');
  const body = src.slice(at, src.indexOf('\nfunction ', at + 1));

  test('the catch-up is gated on the session actually being found', () => {
    assert.match(body, /orchestratorSession\s*\n?\s*\?\s*deltaSince\(/,
      'no delta on the cold-spawn fallback, matching how the delegate path is gated');
  });
});

describe('the cap holds when both things happen at once', () => {
  // THE SECOND HALF OF THE SAME DEFECT. Clipping an oversized turn was fixed
  // first; the truncation notice was still prepended afterwards, outside the
  // budget the loop had just spent. Whenever a turn was dropped AND the kept
  // turn was clipped, the returned text ran past the one number this module
  // names, by the length of the notice. A cap that is only usually a cap is
  // the same class of instrument as a measurement that cannot fail.
  const { deltaSince, DELTA_CAP_CHARS } = require(path.join(ROOT, 'lib', 'store', 'transcripts.js'));

  test('a dropped turn and a clipped turn together still fit the cap', () => {
    const out = deltaSince([
      { agent: 'vox', text: 'mine' },
      { agent: 'a', text: 'old' },
      { agent: 'b', text: 'x'.repeat(DELTA_CAP_CHARS * 2) }
    ], 'vox');
    assert.strictEqual(out.truncated, 1, 'the older turn went');
    assert.strictEqual(out.clipped, 1, 'and the newest was cut short');
    assert.ok(out.text.length <= DELTA_CAP_CHARS,
      `text was ${out.text.length}, cap is ${DELTA_CAP_CHARS}`);
  });

  test('the notice and the clip note both survive inside the cap', () => {
    const out = deltaSince([
      { agent: 'vox', text: 'mine' },
      { agent: 'a', text: 'old' },
      { agent: 'b', text: 'x'.repeat(DELTA_CAP_CHARS * 2) }
    ], 'vox');
    assert.match(out.text, /1 earlier turn omitted for length/, 'it says a turn went');
    assert.match(out.text, /cut off here/, 'and that the one it kept was cut');
  });

  test('every return path names all three fields', () => {
    for (const out of [
      deltaSince([], 'vox'),
      deltaSince([{ agent: 'vox', text: 'mine' }], 'vox'),
      deltaSince([{ agent: 'a', text: 'not mine' }], 'vox'),
      deltaSince(null, 'vox')
    ]) {
      assert.strictEqual(typeof out.truncated, 'number');
      assert.strictEqual(typeof out.clipped, 'number', 'clipped is never undefined');
    }
  });
});
