'use strict';
// WHAT IS SAID WHEN AN AGENT IS HANDED A SHORTENED COPY OF THE CONVERSATION.
//
// The catch-up an agent is handed is capped (lib/store/transcripts.js), and the
// cap cuts it in two ways: older turns dropped whole, or one turn longer than
// the cap cut short. When either happens, two things are said. The person sees
// one plain line in the conversation, built here from the agent's name. The
// agent finds one line in its own catch-up, directly under the heading, telling
// it to ask for exactly what the person can hand over. Both are pure text, so
// these assert the bytes.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const catchUp = require(path.join(ROOT, 'lib', 'delegation', 'catch-up.js'));
const {
  CATCH_UP_HEADINGS, catchUpPrefix, buildDelegateContext, buildScopeReturnPrompt, buildFreshHandbackCatchUp,
} = catchUp;
const { deltaSince, DELTA_CAP_CHARS } = require(path.join(ROOT, 'lib', 'store', 'transcripts.js'));
const { isRundockPrompt } = require(path.join(ROOT, 'lib', 'delegation', 'rundock-lines.js'));

const LINE = '[If you need something from earlier, ask the person to paste it again or save it as a workspace file.]';
const FOR_WREN = 'Wren was given a shortened copy of this conversation, because it is longer than an agent is handed at once. '
  + 'If Wren needs something from earlier, paste it again or save it as a file in the workspace and say where it is.';
const FOR_NOBODY = 'The agent was given a shortened copy of this conversation, because it is longer than an agent is handed at once. '
  + 'If the agent needs something from earlier, paste it again or save it as a file in the workspace and say where it is.';

/** The opening check of every test that calls something only this change adds. */
function noticeBuilderExists() {
  assert.strictEqual(typeof catchUp.shortenedCopyNotice, 'function',
    'catch-up.js builds the shortened-copy notice from the agent name');
}

/** Many ordinary replies: older ones are dropped whole and none is cut short. */
function manyTurns() {
  const entries = [{ role: 'user', text: 'plan the alpha launch' }];
  for (let i = 0; i < 40; i++) {
    entries.push({ role: 'agent', agent: i % 2 ? 'chief-of-staff' : 'content-analyst', text: `alpha reply ${i} ` + 'a'.repeat(900) });
  }
  return entries;
}

/** One person's turn longer than the cap: it is cut short and nothing is dropped. */
function oneLongTurn() {
  return [{ role: 'user', text: 'ONE-LONG-PASTE ' + 'p'.repeat(DELTA_CAP_CHARS + 1000) }];
}

/** A conversation well inside the cap. */
function shortTalk() {
  return [
    { role: 'user', text: 'plan the alpha launch' },
    { role: 'agent', agent: 'chief-of-staff', text: 'Handing this to Wren.' },
  ];
}

/** What an agent that has never spoken here is handed, as the engine builds it. */
function arriving(entries) {
  return deltaSince(entries, 'content-lead', undefined, [], null, true);
}

function truncatedOnly() {
  const d = arriving(manyTurns());
  assert.ok(d.truncated > 0 && d.clipped === 0, `fixture is cut by dropped turns only: ${JSON.stringify({ truncated: d.truncated, clipped: d.clipped })}`);
  return d;
}

function clippedOnly() {
  const d = arriving(oneLongTurn());
  assert.ok(d.clipped === 1 && d.truncated === 0, `fixture is cut by one clipped turn only: ${JSON.stringify({ truncated: d.truncated, clipped: d.clipped })}`);
  return d;
}

function uncut() {
  const d = arriving(shortTalk());
  assert.ok(d.text && d.truncated === 0 && d.clipped === 0, 'fixture is inside the cap');
  return d;
}

function count(haystack, needle) { return haystack.split(needle).length - 1; }

const HEADINGS = [
  { arrivingFlag: true, heading: CATCH_UP_HEADINGS.arriving, label: 'an arriving agent' },
  { arrivingFlag: false, heading: CATCH_UP_HEADINGS.returning, label: 'a returning agent' },
];

describe('the line the person is shown', () => {
  test('names the agent by its display name, in these words', () => {
    noticeBuilderExists();
    assert.strictEqual(catchUp.shortenedCopyNotice('Wren'), FOR_WREN);
  });

  test('an agent with no display name is called the agent, never anything else', () => {
    noticeBuilderExists();
    assert.strictEqual(catchUp.shortenedCopyNotice(null), FOR_NOBODY);
    assert.strictEqual(catchUp.shortenedCopyNotice(undefined), FOR_NOBODY);
    assert.strictEqual(catchUp.shortenedCopyNotice(''), FOR_NOBODY);
  });
});

describe('which catch-ups count as shortened', () => {
  test('one that dropped older turns is shortened', () => {
    noticeBuilderExists();
    assert.strictEqual(catchUp.isCutCatchUp(truncatedOnly()), true);
  });

  test('one with a single turn cut short is shortened', () => {
    noticeBuilderExists();
    assert.strictEqual(catchUp.isCutCatchUp(clippedOnly()), true);
  });

  test('one inside the cap is not, and neither is nothing to catch up on', () => {
    noticeBuilderExists();
    assert.strictEqual(catchUp.isCutCatchUp(uncut()), false);
    assert.strictEqual(catchUp.isCutCatchUp(arriving([])), false);
    assert.strictEqual(catchUp.isCutCatchUp({ text: null, truncated: 0, clipped: 0 }), false);
    assert.strictEqual(catchUp.isCutCatchUp(null), false);
  });
});

describe('the line the agent finds in its own catch-up', () => {
  for (const { arrivingFlag, heading, label } of HEADINGS) {
    test(`${label}: a catch-up that dropped turns carries it directly under the heading`, () => {
      const d = truncatedOnly();
      assert.strictEqual(catchUpPrefix(d, arrivingFlag), `${heading}\n${LINE}\n${d.text}\n\n`);
    });

    test(`${label}: a catch-up with one turn cut short carries it directly under the heading`, () => {
      const d = clippedOnly();
      assert.strictEqual(catchUpPrefix(d, arrivingFlag), `${heading}\n${LINE}\n${d.text}\n\n`);
    });

    test(`${label}: a catch-up inside the cap is exactly what it was`, () => {
      const d = uncut();
      assert.strictEqual(catchUpPrefix(d, arrivingFlag), `${heading}\n${d.text}\n\n`);
    });
  }

  test('nothing to catch up on still gives nothing', () => {
    assert.strictEqual(catchUpPrefix({ text: null, truncated: 0, clipped: 0 }, true), '');
    assert.strictEqual(catchUpPrefix(arriving([]), true), '');
  });
});

describe('every builder carries the line when the catch-up is shortened, and only then', () => {
  const brief = 'draft the alpha announcement';

  test('a delegate brief that follows a shortened catch-up', () => {
    for (const { arrivingFlag, heading } of HEADINGS) {
      const d = truncatedOnly();
      const prompt = buildDelegateContext({ missed: d, brief, arriving: arrivingFlag });
      assert.strictEqual(prompt, `${heading}\n${LINE}\n${d.text}\n\n[DELEGATION BRIEF]\n${brief}`);
      assert.strictEqual(count(prompt, LINE), 1, 'once');
      assert.strictEqual(isRundockPrompt(prompt), true, 'still read as a prompt Rundock wrote');
      assert.ok(prompt.length <= DELTA_CAP_CHARS + brief.length + 200, 'inside the bound the cap allows');
    }
  });

  test('a delegate brief that follows a catch-up inside the cap', () => {
    for (const { arrivingFlag, heading } of HEADINGS) {
      const d = uncut();
      const prompt = buildDelegateContext({ missed: d, brief, arriving: arrivingFlag });
      assert.strictEqual(prompt, `${heading}\n${d.text}\n\n[DELEGATION BRIEF]\n${brief}`);
      assert.ok(!prompt.includes(LINE));
    }
  });

  test('a handback prompt that follows a shortened catch-up, in every mode', () => {
    for (const mode of ['complete', 'continue', 'return']) {
      for (const { arrivingFlag, heading } of HEADINGS) {
        const d = clippedOnly();
        const prompt = buildScopeReturnPrompt({
          mode, orchMissed: d, specialistId: 'content-lead', outputBlock: '\n\nThe draft.', pendingRequest: 'Ship it.', arriving: arrivingFlag,
        });
        assert.ok(prompt.startsWith(`${heading}\n${LINE}\n${d.text}\n\n[SYSTEM: `), `${mode}: the line sits under the heading`);
        assert.strictEqual(count(prompt, LINE), 1, `${mode}: once`);
        assert.strictEqual(isRundockPrompt(prompt), true);
      }
    }
  });

  test('a handback prompt that follows a catch-up inside the cap, in every mode', () => {
    for (const mode of ['complete', 'continue', 'return']) {
      for (const { arrivingFlag, heading } of HEADINGS) {
        const d = uncut();
        const prompt = buildScopeReturnPrompt({
          mode, orchMissed: d, specialistId: 'content-lead', outputBlock: '\n\nThe draft.', pendingRequest: 'Ship it.', arriving: arrivingFlag,
        });
        assert.ok(prompt.startsWith(`${heading}\n${d.text}\n\n[SYSTEM: `), `${mode}: as it was`);
        assert.ok(!prompt.includes(LINE), `${mode}: no line`);
      }
    }
  });

  test('the catch-up held for a fresh orchestrator, after a shortened catch-up', () => {
    const d = truncatedOnly();
    const held = buildFreshHandbackCatchUp({ orchMissed: d, specialistId: 'content-lead', outputBlock: '\n\nThe draft.' });
    assert.strictEqual(held, `${CATCH_UP_HEADINGS.arriving}\n${LINE}\n${d.text}\n\n`
      + '[SYSTEM: content-lead handed this conversation back to you. Here is their final message to the conversation:\n\nThe draft.]\n\n');
    assert.strictEqual(count(held, LINE), 1);
    assert.strictEqual(isRundockPrompt(held), true);
  });

  test('the catch-up held for a fresh orchestrator, after a catch-up inside the cap', () => {
    const d = uncut();
    const held = buildFreshHandbackCatchUp({ orchMissed: d, specialistId: 'content-lead', outputBlock: '' });
    assert.strictEqual(held, `${CATCH_UP_HEADINGS.arriving}\n${d.text}\n\n`);
  });
});
