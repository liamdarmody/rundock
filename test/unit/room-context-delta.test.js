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

  test('the engine sends that assembled text, and says whether the agent is arriving or returning', () => {
    // The one binding left against source: which VALUES the pure functions are
    // called with. Their behaviour is driven above.
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'delegation', 'engine.js'), 'utf8');
    // THE RULE CHANGED DELIBERATELY. It was "only for a delegate being
    // resumed", on the reasoning that a first-time delegate had missed
    // nothing. That held for a delegate spawned from a chat message, which
    // gets the full transcript, and failed for one brought in by an
    // intercepted Agent call, which got the brief alone and could not see a
    // draft written earlier in the same conversation.
    //
    // Now: everyone except Codex, whose prompt assembly is separate, and
    // except the cold spawn already receiving a full transcript, which would
    // otherwise be sent the same conversation twice.
    assert.match(src, /const needsCatchUp = !isCodexDelegate && !needsTranscript;/,
      'the catch-up is built for arriving delegates as well as returning ones');
    assert.match(src, /const arriving = !priorSessionId;/,
      'and which of the two it is decides the heading it carries');
    assert.match(src, /buildDelegateContext\(\{ transcript, missed, brief: msg\.context, arriving \}\)/,
      'the assembled context carries which case this is, so the heading it '
      + 'renders is true of the agent reading it');
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
    assert.match(body, /deltaSince\(loadTranscript\(convoId\) \|\| \[\], orchestrator\.id, undefined, \[specialistEntry\.agentId\], agentDisplayNames\(\)\)/,
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

describe('every path that resumes an agent gives it the delta', () => {
  // THESE ASSERTIONS ARE EXACT ON PURPOSE. When the names map was added they
  // failed, because they pinned the call signature. They were changed to end
  // in [,)] so either shape matched, described at the time as pinning "the
  // arguments that matter while allowing the roster". That was a loosening
  // dressed as a refinement: with it, dropping agentDisplayNames() from any
  // call site restores id-only labelling in production and nothing goes red.
  // The whole point of pinning a call is that its arguments are the rule.
  // THREE PATHS, NOT TWO. Review round 3 found the third: a mid-level parent,
  // a specialist that has its own direct reports, is resumed when its
  // sub-delegate hands back. It was given the sub-delegate's output and
  // nothing else, which is the same blindness this change set out to fix, one
  // level deeper. Real shape: the orchestrator delegates to Ren, Ren delegates
  // to Sage, Sage returns, and Ren is resumed knowing nothing about what
  // happened in the conversation while she waited.
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'delegation', 'engine.js'), 'utf8');

  test('the delegate delta is computed against the delegate, not the delegator', () => {
    // Pinned because the arguments are the whole rule. Computing this against
    // originalAgentId would hand a resumed delegate its own history back and
    // hide what it actually missed, and every test that exercises the pure
    // function with hand-picked ids would stay green.
    assert.match(src, /deltaSince\(loadTranscript\(convoId\) \|\| \[\], targetAgent\.id, undefined, \[\], agentDisplayNames\(\), arriving\)/,
      "the target agent's own id, so the delta is what THAT agent missed, and "
      + 'the arriving flag, so a newcomer is given the conversation rather than '
      + 'nothing');
  });

  test('the orchestrator delta excludes the specialist handing back', () => {
    assert.match(src, /deltaSince\(loadTranscript\(convoId\) \|\| \[\], orchestrator\.id, undefined, \[specialistEntry\.agentId\], agentDisplayNames\(\)\)/);
  });

  test('the mid-level parent gets one too, and excludes its returning delegate', () => {
    assert.match(src, /deltaSince\(loadTranscript\(convoId\) \|\| \[\], parentAgentId, undefined, \[delegateEntry\.agentId\], agentDisplayNames\(\)\)/,
      'the third resume path, found only because a reviewer walked all of them');
  });

  test('all three are gated on actually having been resumed', () => {
    assert.match(src, /const needsCatchUp = !isCodexDelegate && !needsTranscript;/, 'delegate');
    assert.match(src, /orchestratorSession\s*\n?\s*\? deltaSince/, 'orchestrator');
    assert.match(src, /parentSessionId\s*\n?\s*\? deltaSince/, 'mid-level parent');
  });

  test('and the mid-level catch-up reaches all three of its prompts', () => {
    const hits = (src.match(/content: parentCatchUp \+ \w+Prompt/g) || []).length;
    assert.strictEqual(hits, 3,
      'resume, complete and normal exit all resume the same parent, so all '
      + 'three must carry what it missed');
  });
});

describe('the log says a delta went only when one went', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'delegation', 'engine.js'), 'utf8');

  test('the scope-return delta is logged where the prompt is written', () => {
    // Two branches park the prompt rather than sending it: a buffered user
    // message that supersedes it, and the auto-resume circuit breaker. Logged
    // beside the spawn, the line claimed a delta had gone in both cases.
    const at = src.indexOf('prompt sent');
    assert.ok(at > -1, 'the send-site log exists');
    const write = src.indexOf("content: prompt } }) + '\\n');");
    assert.ok(write > -1, 'the scope-return write is still here');
    assert.ok(write < at, 'the log must sit after the write');
    // And nothing that could divert the prompt sits between them.
    const between = src.slice(write, at);
    assert.ok(!/bufferedFollowUpTakesOver|incrementAutoResume|spawnClaude/.test(between),
      'no branch between the write and the log, so the log cannot outrun the send');
  });
});

describe('the log line itself, on every branch it has', () => {
  // EXPORTED TO BE TESTED, AND THEN NOT TESTED. deltaNote exists as its own
  // function because the two log sites had already drifted apart: one
  // reported the truncated-turn count and the other did not. Four branches,
  // no coverage, in the one place a regression would be easiest to
  // reintroduce silently.
  const { deltaNote } = require(path.join(ROOT, 'lib', 'delegation', 'catch-up.js'));

  test('a cold agent gets no note at all', () => {
    assert.strictEqual(deltaNote({ text: null }, false), '',
      'nothing was resumed, so there is nothing to say');
  });

  test('a resumed agent with nothing missed says so out loud', () => {
    assert.strictEqual(deltaNote({ text: null }, true), ' delta=none',
      'the difference between "no catch-up was sent" and "a catch-up was sent '
      + 'and ignored" is two different faults with two different fixes');
  });

  test('a delta reports its size', () => {
    assert.strictEqual(deltaNote({ text: 'abc', truncated: 0, clipped: 0 }, true), ' delta=3chars');
  });

  test('and says when it dropped turns', () => {
    assert.match(deltaNote({ text: 'abc', truncated: 2, clipped: 0 }, true), /\/truncated2/);
  });

  test('and when it cut one short', () => {
    assert.match(deltaNote({ text: 'abc', truncated: 0, clipped: 1 }, true), /\/clipped/);
  });

  test('both at once, because both happened', () => {
    const note = deltaNote({ text: 'abc', truncated: 1, clipped: 1 }, true);
    assert.match(note, /\/truncated1/);
    assert.match(note, /\/clipped/);
  });

  test('a missing object never throws in a log line', () => {
    // A logger that can crash the path it observes is worse than no logger.
    assert.strictEqual(deltaNote(undefined, false), '');
    assert.strictEqual(deltaNote(null, true), ' delta=none');
  });
});

describe('every delta log sits at a send, not at a computation', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'delegation', 'engine.js'), 'utf8');

  test('no deltaNote call sits beside a spawn', () => {
    // Both delta logs were written beside their spawn, before branches that
    // park the prompt rather than sending it. Both then reported a delta that
    // never went. This pins the shape so the third one cannot repeat it.
    for (const m of src.matchAll(/deltaNote\(/g)) {
      const before = src.slice(Math.max(0, m.index - 600), m.index);
      assert.ok(/stdin\.write|prompt sent/.test(before),
        'a deltaNote call must follow a write or sit in a helper named for the send');
    }
  });

  test('the mid-level parent reports its delta at all three of its sends', () => {
    const hits = (src.match(/noteParentSend\(\);/g) || []).length;
    assert.strictEqual(hits, 3, 'resume, complete and normal exit each write a prompt');
  });
});

describe('the separator between turns counts toward the cap', () => {
  // THE THIRD DEFECT OF THIS SHAPE, and the reason the shape matters more than
  // the size. kept.join('\n\n') puts two characters between every pair, and
  // the admission loop counted only the entries. The assembled text could run
  // two characters per gap past the cap, and the final clamp then chopped the
  // tail off the NEWEST kept turn while reporting clipped: 0. Two characters
  // is nothing. An instrument reporting that nothing was cut while something
  // was cut is the whole defect this release exists to remove.
  const { deltaSince, DELTA_CAP_CHARS } = require(path.join(ROOT, 'lib', 'store', 'transcripts.js'));

  /** Two newest entries sized to land exactly on the budget boundary. */
  function boundaryTranscript() {
    const notice = '[3 earlier turns omitted for length; ask if you need what came before this.]\n\n';
    const budget = DELTA_CAP_CHARS - notice.length;
    const half = Math.floor(budget / 2);
    return [
      { agent: 'vox', text: 'mine' },
      { agent: 'a', text: 'x'.repeat(50) },
      { agent: 'b', text: 'y'.repeat(50) },
      { agent: 'c', text: 'z'.repeat(50) },
      { agent: 'd', text: 'd'.repeat(half - 'D: '.length) },
      { agent: 'e', text: 'e'.repeat(budget - half - 'E: '.length) }
    ];
  }

  test('two entries on the boundary still fit inside the cap', () => {
    const out = deltaSince(boundaryTranscript(), 'vox');
    assert.ok(out.text.length <= DELTA_CAP_CHARS,
      `text was ${out.text.length}, cap is ${DELTA_CAP_CHARS}`);
  });

  test('the newest turn arrives whole, not two characters short', () => {
    // THE ASSERTION THAT DISTINGUISHES A FIX FROM A CONFESSION. Reporting the
    // clamp is necessary but not sufficient: with the separator uncounted the
    // loop admits more than fits, the clamp bites into the newest entry, and
    // the agent silently reads a truncated final turn. Counting the separator
    // means it is never admitted in the first place, so it arrives complete.
    const t = boundaryTranscript();
    const newest = t[t.length - 1];
    const out = deltaSince(t, 'vox');
    assert.ok(out.text.endsWith(newest.text),
      'the newest turn is cut short: the delta ends '
      + JSON.stringify(out.text.slice(-8)) + ' and the turn ends '
      + JSON.stringify(newest.text.slice(-8)));
  });

  test('and if anything is trimmed anyway, the caller is told', () => {
    const out = deltaSince(boundaryTranscript(), 'vox');
    const fits = out.text.length < DELTA_CAP_CHARS;
    assert.ok(fits || out.clipped === 1,
      'a clamp that cuts content while reporting clipped: 0 is the defect');
  });

  test('many small turns do not accumulate separator overflow', () => {
    // Worst case for this defect: the more gaps, the further past the cap.
    const many = [{ agent: 'vox', text: 'mine' }];
    for (let i = 0; i < 400; i++) many.push({ agent: `a${i}`, text: 'q'.repeat(60) });
    const out = deltaSince(many, 'vox');
    assert.ok(out.text.length <= DELTA_CAP_CHARS,
      `text was ${out.text.length} across ${out.text.split('\n\n').length} joined parts`);
  });

  test('the clamp reports itself whenever it fires', () => {
    // A tiny cap forces the clamp regardless of the reservation.
    const out = deltaSince([
      { agent: 'vox', text: 'mine' },
      { agent: 'a', text: 'aaaa' },
      { agent: 'b', text: 'bbbb' }
    ], 'vox', 12);
    assert.ok(out.text.length <= 12);
    if (out.text.length === 12) {
      assert.ok(out.clipped === 1 || out.truncated > 0,
        'content that did not fit must be accounted for somewhere the caller sees');
    }
  });
});

describe('what the cap protects and what it spends', () => {
  // TWO CHANGES MEASURED ON A REAL CONVERSATION, not guessed. In a live
  // handoff the delta came to 11,650 of 12,000 characters and dropped two
  // turns. Of that transcript, the user's own turns were 3.2% and tool-call
  // summaries were 8.1%, and one of the two dropped turns was tool summary and
  // nothing else.
  //
  // So: pin the user's turns, which carry the intent every later turn exists
  // to serve and are the OLDEST thing in the window, hence the first thing a
  // newest-first rule discards. And stop spending budget on a record of how
  // work was done rather than what it found.
  const { deltaSince, DELTA_CAP_CHARS } = require(path.join(ROOT, 'lib', 'store', 'transcripts.js'));

  test("the user's original request survives a cap that drops agent turns", () => {
    const t = [{ agent: 'vox', text: 'my earlier turn' },
      { role: 'user', text: 'THE-ORIGINAL-REQUEST: write me a thread' }];
    // Enough agent noise after it to bury the request many times over.
    for (let i = 0; i < 30; i++) t.push({ agent: `a${i}`, text: 'x'.repeat(900) });
    const out = deltaSince(t, 'vox');
    assert.match(out.text, /THE-ORIGINAL-REQUEST/,
      'the oldest turn is the first a newest-first rule drops, and it is the one '
      + 'every later turn exists to serve');
    assert.ok(out.truncated > 0, 'and this case genuinely did drop turns');
    assert.ok(out.text.length <= DELTA_CAP_CHARS, 'while still respecting the cap');
  });

  test('several user turns are all kept, not just the first', () => {
    const t = [{ agent: 'vox', text: 'mine' }];
    for (let i = 0; i < 5; i++) {
      t.push({ role: 'user', text: `USER-TURN-${i}` });
      t.push({ agent: 'a', text: 'y'.repeat(3000) });
    }
    const out = deltaSince(t, 'vox');
    for (let i = 0; i < 5; i++) {
      assert.match(out.text, new RegExp(`USER-TURN-${i}`),
        `user turn ${i} was dropped; the thread of intent has a hole in it`);
    }
  });

  test('the delta reads in the order the conversation happened', () => {
    // Pinning must not reorder. Every question first and every answer second
    // is a different conversation from the one that took place.
    const t = [{ agent: 'vox', text: 'mine' },
      { role: 'user', text: 'FIRST-ASK' },
      { agent: 'a', text: 'FIRST-ANSWER' },
      { role: 'user', text: 'SECOND-ASK' },
      { agent: 'b', text: 'SECOND-ANSWER' }];
    const out = deltaSince(t, 'vox');
    const order = ['FIRST-ASK', 'FIRST-ANSWER', 'SECOND-ASK', 'SECOND-ANSWER']
      .map((k) => out.text.indexOf(k));
    assert.ok(order.every((v) => v > -1), 'all four turns are present');
    assert.deepStrictEqual(order, [...order].sort((a, b) => a - b),
      'the delta is out of order, so the agent reads a conversation that did not happen');
  });

  test('a tool-call summary is not spent on', () => {
    // THE REAL SHAPE. appendTranscript writes `toolSummary + '\n' + text`, so
    // the summary is always its own line. The earlier fixture put both on one
    // line, which no transcript contains, and a strip written to satisfy it
    // had to match bracket groups character by character: that breaks on a
    // bracket inside a command, which is ordinary, and glued the remainder of
    // the summary onto the front of what the agent said.
    const t = [{ agent: 'vox', text: 'mine' },
      { agent: 'ren', text: '[ToolSearch] [Read /Users/x/a.md] [WebFetch https://x.com]\nthe finding that matters' }];
    const out = deltaSince(t, 'vox');
    assert.match(out.text, /the finding that matters/, 'what it found is kept');
    assert.ok(!out.text.includes('WebFetch'),
      'how it was done is not: that is a record for the conversation, not for '
      + 'an agent being told what it missed');
    assert.ok(!out.text.includes('ToolSearch'));
  });

  test('a command containing a bracket does not corrupt what was said', () => {
    const t = [{ agent: 'vox', text: 'mine' },
      { agent: 'ren', text: "[Bash grep '[abc]' file.txt]\nthe real finding" }];
    const out = deltaSince(t, 'vox');
    assert.strictEqual(out.text, 'REN: the real finding',
      'the summary matched only as far as the bracket inside the command, and '
      + "the remainder was glued to the front of the agent's own words");
  });

  test('a turn that is nothing but tool calls costs nothing', () => {
    const t = [{ agent: 'vox', text: 'mine' },
      { agent: 'ren', text: '[Read /a] [Read /b] [Grep c]' },
      { agent: 'sage', text: 'the real content' }];
    const out = deltaSince(t, 'vox');
    assert.match(out.text, /the real content/);
    assert.ok(!/REN:/.test(out.text),
      'an entry with nothing left after stripping is not rendered as an empty '
      + 'speaker line');
  });
});

describe('who said what, in a conversation with several agents', () => {
  // THE POINT OF THE WHOLE FEATURE is that an agent returning to a
  // conversation can read it like a person who stepped out of the room. That
  // requires knowing who spoke. Two things were in the way, both visible in a
  // real delta:
  //
  //   RESEARCH-LEAD: Draft written. Now handing to Sage...
  //   FACT-CHECKER: ...That's the full list, Ren
  //   DEFAULT: Handing to Vox...
  //   <!-- RUNDOCK:CONTINUE -->
  //
  // The turns are labelled with the ids they are filed under while the agents
  // address each other by name in their own text, so the reader holds two
  // naming schemes at once and `DEFAULT` names nobody. And another agent's
  // handoff markers arrive as if they were something said.
  const { deltaSince } = require(path.join(ROOT, 'lib', 'store', 'transcripts.js'));

  const NAMES = { 'research-lead': 'Ren', 'fact-checker': 'Sage', default: 'Roo', vox: 'Vox' };
  const convo = [
    { agent: 'vox', text: 'my earlier draft' },
    { role: 'user', text: 'get Ren to check it' },
    { agent: 'research-lead', text: 'Handing to Sage to verify. <!-- RUNDOCK:CONTINUE -->' },
    { agent: 'fact-checker', text: "That's the full list, Ren. <!-- RUNDOCK:RETURN -->" },
    { agent: 'default', text: 'Handing back to Vox.' },
  ];

  test('each turn is labelled with the name the team uses', () => {
    const out = deltaSince(convo, 'vox', undefined, [], NAMES);
    assert.match(out.text, /^REN: /m, 'not RESEARCH-LEAD');
    assert.match(out.text, /^SAGE: /m, 'not FACT-CHECKER');
    assert.match(out.text, /^ROO: /m, 'not DEFAULT, which names nobody');
    assert.match(out.text, /^USER: /m, 'and the person is distinguishable from every agent');
  });

  test('an id with no name still reads, rather than breaking', () => {
    const out = deltaSince(convo, 'vox', undefined, [], { default: 'Roo' });
    assert.match(out.text, /^RESEARCH-LEAD: /m,
      'a roster that has changed under a running conversation degrades to the '
      + 'id, which is worse to read and still true');
  });

  test('no roster at all is still a readable delta', () => {
    const out = deltaSince(convo, 'vox');
    assert.match(out.text, /^RESEARCH-LEAD: /m);
    assert.match(out.text, /^USER: /m);
  });

  test("another agent's handoff markers are not shown as things it said", () => {
    const out = deltaSince(convo, 'vox', undefined, [], NAMES);
    assert.ok(!/RUNDOCK:(RETURN|COMPLETE|CONTINUE)/.test(out.text),
      'a control signal between the server and one agent is not content for '
      + 'another, and an agent reading a marker in its own context has been '
      + 'handed something it may act on');
    assert.match(out.text, /Handing to Sage to verify/, 'while what was said survives');
  });
});

describe('the names come from the real roster', () => {
  // NOT A HAND-BUILT MAP. Every attribution test above passes its own names
  // object, which proves deltaSince uses what it is given and says nothing
  // about what production gives it. agentDisplayNames is the function that
  // decides, and its fallback chain (displayName, then name, then id) and its
  // failure path are the parts that determine what a returning agent is
  // called. Driven here rather than imitated.
  // It lives with the roster, not with delegation: the engine's export
  // surface is frozen to its factory and deps, and this is a roster question.
  const roster = require(path.join(ROOT, 'lib', 'agents', 'discovery.js'));

  test('it never throws, whatever discovery does', () => {
    // A delta labelled by id still reads. One that throws takes the delegation
    // with it, so this is the property that matters most.
    assert.doesNotThrow(() => roster.agentDisplayNames());
    assert.strictEqual(typeof roster.agentDisplayNames(), 'object');
  });

  test('a map it produces is usable by the renderer', () => {
    const names = roster.agentDisplayNames();
    const out = deltaSince([
      { agent: 'vox', text: 'mine' },
      { agent: 'research-lead', text: 'what I found' },
    ], 'vox', undefined, [], names);
    // With no workspace the map is empty and the id is the label; with a
    // roster it is the name. Both must render.
    assert.match(out.text, /^(REN|RESEARCH-LEAD): what I found/m,
      'the real map must produce something the renderer can label a turn with');
  });

  test('the engine passes that function, not a literal', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'delegation', 'engine.js'), 'utf8');
    const calls = (src.match(/deltaSince\(loadTranscript\(convoId\)[^;]*agentDisplayNames\(\)[,)]/g) || []).length;
    assert.strictEqual(calls, 3,
      'all three resume paths must build the map from the live roster, or one '
      + 'of them silently labels turns with internal ids');
  });
});

describe('many pinned turns cannot overflow the cap', () => {
  // FOUND BY THE REVERT CHECK, not by review. Disabling the "no usable room"
  // guard in clip() reddened nothing, which meant this behaviour had been
  // verified by hand and never written down.
  //
  // Without that guard, once the budget is spent clip() returns just the
  // ~62-character note, the admission loop sees a truthy value and keeps
  // going, and every further user turn adds another placeholder. The assembled
  // text runs past the cap, the final clamp cuts it at an arbitrary byte, and
  // `truncated` has already counted every placeholder as kept: the same
  // "nothing was lost" lie, one loop deeper.
  const { deltaSince, DELTA_CAP_CHARS } = require(path.join(ROOT, 'lib', 'store', 'transcripts.js'));

  function manyUserTurns(n, len) {
    const t = [{ agent: 'vox', text: 'my earlier turn' }];
    for (let i = 0; i < n; i++) t.push({ role: 'user', text: `U${i} ${'x'.repeat(len)}` });
    return t;
  }

  test('three hundred short user turns still fit the cap', () => {
    const out = deltaSince(manyUserTurns(300, 100), 'vox');
    assert.ok(out.text.length <= DELTA_CAP_CHARS,
      `text was ${out.text.length}, cap is ${DELTA_CAP_CHARS}`);
  });

  test('and the ones that did not fit are reported, not silently absent', () => {
    const out = deltaSince(manyUserTurns(300, 100), 'vox');
    assert.ok(out.truncated > 0,
      'the turns beyond the cap were dropped while the count said none were');
    assert.match(out.text, /earlier turns? omitted for length/,
      'and the agent is told, rather than working from a partial account it '
      + 'cannot see the edges of');
  });

  test('the oldest user turns are the ones kept, so the request survives', () => {
    const out = deltaSince(manyUserTurns(300, 100), 'vox');
    assert.match(out.text, /U0 /,
      'the first thing asked is what every later turn exists to serve');
  });
});

// AN AGENT DELEGATED TO A SECOND TIME, ARRIVING COLD.
//
// The first version of the arriving path decided "has this agent turns of its
// own" from the transcript, and used that both to skip its own turns and to
// slice from its last one. That is right for a RESUME, which carries its own
// history in a session, and exactly wrong for an arrival, which is a new
// process that has never seen the conversation. An agent delegated to, having
// spoken, and delegated to again by an intercepted cold spawn therefore got the
// tail of a conversation whose beginning it had never seen, and specifically
// lost its OWN earlier turn: the defect this change exists to fix, reappearing
// the second time an agent is used.
test('an arriving agent that has spoken before is still given the whole conversation, its own turns included', () => {
  const transcript = [
    { role: 'user', agent: 'user', text: 'write me a post' },
    { role: 'agent', agent: 'penn', text: 'PENN-FIRST-DRAFT: here is a draft' },
    { role: 'agent', agent: 'cos', text: 'COS-NOTE: asking research for numbers' },
    { role: 'agent', agent: 'arlo', text: 'ARLO-RESEARCH: the numbers' },
  ];
  const arriving = deltaSince(transcript, 'penn', undefined, [], null, true);
  assert.match(arriving.text, /PENN-FIRST-DRAFT/,
    'its own earlier turn, which a cold spawn holds nowhere else');
  assert.match(arriving.text, /ARLO-RESEARCH/, 'and what happened while it was away');
  assert.match(arriving.text, /write me a post/, 'and the request that started it');

  // The resume path is unchanged and still trims: a session already carries
  // these, and re-sending them invites the agent to redo work it has done.
  const returning = deltaSince(transcript, 'penn', undefined, [], null, false);
  assert.ok(!returning.text.includes('PENN-FIRST-DRAFT'),
    'a returning agent is not re-sent its own turn');
  assert.match(returning.text, /ARLO-RESEARCH/, 'only what it missed');
});
