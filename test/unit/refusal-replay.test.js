'use strict';
// THE ACCEPTANCE REPLAY for stopping after a refusal: a recorded spiral of six
// refused steps (test/fixtures/refusal-spiral.js) through the real hook, the
// real router and the real card handler.
//
// Before this change the session's agent was told to stop and ask at none of
// its six refusals: four sandbox blocks were told nothing, a denied card said
// to move on, and a card nobody answered said to try again. It made five more
// attempts after its first refusal, all of them untold. Now every refusal says,
// in its own step, that it was deliberate and to stop and ask, so none of
// those attempts is made untold.
//
// What the agent then does is the model's to show, in a live session; this
// pins what it is told.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { replay } = require('../helpers/refusal-replay.js');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');

test('every refusal in the replayed spiral tells the agent, in its own step, to stop and ask', async () => {
  const { steps, summary } = await replay(HOOK);
  assert.ok(steps.every((s) => s.carded), 'each step met the card it was recorded with');
  assert.deepStrictEqual(steps.map((s) => s.kind), ['sandbox', 'sandbox', 'denied', 'timeout', 'sandbox', 'sandbox']);
  assert.deepStrictEqual(summary, {
    refusals: 6, toldToStopAndAsk: 6, invitedToRetry: 0, toldNothing: 0, attemptsAfterRefusal: 5, attemptsUntold: 0,
  });
});

test('without the failure hook registered, the sandbox blocks go untold: the registration is what reaches them', async () => {
  const { summary } = await replay(HOOK, { failureHook: false });
  assert.strictEqual(summary.toldNothing, 4);
  assert.strictEqual(summary.toldToStopAndAsk, 2, 'the two cards still say it');
  assert.strictEqual(summary.attemptsUntold, 2, 'the two blocks before the first card');
});
