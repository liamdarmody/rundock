'use strict';
// A ROUTINE NEVER APPROVED IS WAITING, NOT CHANGED. The Routines row said
// "what this runs has changed since you last approved it" for every routine
// the scheduler refused for approval, including one nobody had ever approved,
// which is every routine a package brings in switched off. Nothing changed and
// nobody approved it. The row now says which of the two it is, from a fact the
// server publishes beside the refusal: whether an earlier approval exists.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { approvedBefore, computePlanHash, APPROVAL_PENDING } = require('../../lib/agents/routines.js');
const model = require('../../public/routines-model.js');
const { agentFile, makeWorkspace } = require('../helpers/workspace.js');

const WAITING = 'Waiting for your approval before its first run.';

describe('whether an earlier approval exists', () => {
  test('pending and absent mean never approved; any recorded hash means approved before', () => {
    assert.strictEqual(approvedBefore({ planApprovedHash: APPROVAL_PENDING }), false);
    assert.strictEqual(approvedBefore({ planApprovedHash: null }), false);
    assert.strictEqual(approvedBefore({}), false);
    assert.strictEqual(approvedBefore({ planApprovedHash: computePlanHash({ prompt: 'an older plan' }) }), true);
  });

  test('the roster publishes it beside the refusal', () => {
    const config = require('../../lib/config.js');
    const { invalidateAgentCache, discoverAgents } = require('../../lib/agents/discovery.js');
    const dir = makeWorkspace({
      agents: {
        piper: agentFile({
          name: 'piper', displayName: 'Piper', type: 'specialist', order: 1,
          routines: [
            { name: 'never', schedule: 'every day at 07:00', prompt: 'go', enabled: true, planApprovedHash: APPROVAL_PENDING },
            { name: 'changed', schedule: 'every day at 07:00', prompt: 'go', enabled: true, planApprovedHash: computePlanHash({ prompt: 'older' }) },
          ],
        }),
      },
    });
    const original = config.getWorkspace();
    config.setWorkspace(dir);
    invalidateAgentCache();
    try {
      const piper = discoverAgents().find((a) => a.id === 'piper');
      const byName = Object.fromEntries(piper.routines.map((r) => [r.name, r]));
      assert.strictEqual(byName.never.refusal, 'approval');
      assert.strictEqual(byName.never.approvedBefore, false);
      assert.strictEqual(byName.changed.refusal, 'approval');
      assert.strictEqual(byName.changed.approvedBefore, true);
    } finally {
      config.setWorkspace(original);
      invalidateAgentCache();
    }
  });
});

describe('the row says which it is', () => {
  test('a routine never approved is waiting for its first run, with Review and resume', () => {
    const state = model.pausedState({ refusal: 'approval', approvedBefore: false, prompt: 'go' });
    assert.strictEqual(state.text, WAITING);
    assert.doesNotMatch(state.text, /changed/);
    assert.strictEqual(state.label, 'Review and resume');
    assert.strictEqual(state.action, 'approve_routine_plan');
  });

  test('"changed since you last approved it" shows when an earlier approval exists', () => {
    const state = model.pausedState({ refusal: 'approval', approvedBefore: true, prompt: 'go' });
    assert.match(state.text, /changed since you last approved it/);
    assert.strictEqual(state.label, 'Review and resume');
  });
});
