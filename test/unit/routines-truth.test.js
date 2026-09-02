'use strict';
// What Rundock says about a run is true.
//
// Three walks, each reading one side's own declaration and proving the other
// side handles all of it, so the two sides cannot drift apart silently:
//
//   1. The scheduler's status vocabulary drives the routines list. Every word
//      the scheduler can record has a mapping in the list's model, and each
//      mapping's claim is proven against the row the word actually produces.
//   2. The scheduler's refusal words drive the row's offer. Every reason the
//      tick can refuse for is one the offer's sentence understands, read out
//      of the refusal function's own source so a branch added there without
//      teaching the row fails here rather than rendering as a promise.
//   3. The ambiguous-skill picker keeps the skill. One skill several agents
//      have offers exactly one row per agent, and the lead asks only the
//      question that is open.
//
// The pre-turn cancel window and the delivered-not-requested rule are pinned
// in test/unit/scheduler-lib.test.js beside the functions they describe; the
// lane's gate runs both files together.
//
// Dates are built from local components and read back through local getters,
// for the reason routines-model.test.js states at length: an ISO string names
// a different calendar day depending on the runner's zone.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const m = require('../../public/routines-model.js');
const editorModel = require('../../public/routine-editor-model.js');
const scheduler = require('../../lib/scheduler.js');

const NOW = new Date(2026, 7, 20, 9, 20);
const TODAYS_SLOT = new Date(2026, 7, 20, 7, 0);
const ZONE = 'Europe/London';

// A run that started on time this morning, with only the status word varying.
function startedRun(status) {
  return {
    lastStart: new Date(2026, 7, 20, 7, 0, 12),
    lastRunStatus: status,
    lastSlot: TODAYS_SLOT,
    missedSlot: null,
    now: NOW,
    zone: ZONE,
  };
}

describe('RT-1: the scheduler vocabulary and the routines list are one list', () => {
  // The divergence check itself. The scheduler declares every word its two
  // stores can carry, in the same comment block that reasons about the
  // vocabulary; the list's model declares a mapping for every word it
  // handles. Equal sets or a failure naming the word.
  test('every status the scheduler records has a mapping in the list, and none is invented', () => {
    const declared = scheduler.statusesTheSchedulerRecords().slice().sort();
    const handled = Object.keys(m.RUN_STATUS_WORDS).sort();
    assert.deepStrictEqual(handled, declared,
      'a word on one side and not the other is a run the list would misdescribe: '
      + 'teach RUN_STATUS_WORDS in public/routines-model.js and statusesTheSchedulerRecords in lib/scheduler.js together');
  });

  // Each mapping's claim, proven against the row the word actually produces
  // through the list's own row builder rather than against the mapping table.
  test('each status word renders as what its mapping claims', () => {
    for (const [word, claim] of Object.entries(m.RUN_STATUS_WORDS)) {
      const status = m.runStatus(startedRun(word));
      if (claim === 'in-flight') {
        // The row's status line stays silent; the live treatment is the
        // view's and has its own tests.
        assert.strictEqual(status, null, `${word}: an in-flight run has no outcome yet`);
      } else if (claim === 'stopped') {
        assert.strictEqual(status.kind, 'stopped', `${word}: a deliberate stop is its own outcome`);
        assert.strictEqual(status.tone, 'neutral',
          `${word}: history, like a missed slot, neither celebrated nor alarmed about`);
        assert.strictEqual(status.lead, 'Stopped', word);
      } else if (claim === 'failed') {
        assert.strictEqual(status.kind, 'failed', `${word}: reads as a failure`);
        assert.strictEqual(status.tone, 'failed', word);
      } else if (claim === 'time-based') {
        assert.strictEqual(status.kind, 'on-time',
          `${word}: an ending on time reads from the clock, not the word`);
        assert.strictEqual(status.tone, 'ok', word);
      } else {
        assert.fail(`${word}: mapping claim '${claim}' is not one this walk knows; teach the walk before shipping it`);
      }
    }
  });

  // The card's first sentence, asked directly of the whole row: a stopped run
  // is not reported in the success tone anywhere the row speaks.
  test('a stopped run is never rendered in a success tone', () => {
    const row = m.row({ name: 'digest', agentName: 'Piper', ...startedRun('cancelled') });
    assert.strictEqual(row.status.tone, 'neutral');
    assert.match(row.status.text, /^Stopped /);
    assert.doesNotMatch(row.status.text, /^Ran|^Caught up/);
  });

  // The rail agrees with the row by deriving from the same reading: a stop
  // the user chose raises no failure dot.
  test('the rail\'s failure dot stays down for a stopped run and rises for a failed one', () => {
    assert.strictEqual(m.anyFailure([startedRun('cancelled')]), false,
      'a deliberate stop is not a failure, and a dot here would teach the reader to ignore the dot');
    assert.strictEqual(m.anyFailure([startedRun('failed')]), true);
    assert.strictEqual(m.anyFailure([startedRun('interrupted')]), true);
  });
});

describe('RT-4: the row\'s promise and the scheduler\'s refusals are one list', () => {
  // Every word routineRefusal can answer, read from its own source. Driving
  // crafted routines through it can only elicit branches this test already
  // knows about; reading the returns finds the branch somebody adds next.
  function refusalWordsTheSchedulerCanGive() {
    const source = scheduler.routineRefusal.toString();
    const words = [...source.matchAll(/return '([A-Za-z]+)'/g)].map(hit => hit[1]);
    assert.ok(words.length >= 4, 'the parse found the refusal branches; an empty read here is a broken instrument, not an empty list');
    return words;
  }

  test('every refusal the scheduler can give is one the row understands', () => {
    const given = [...new Set(refusalWordsTheSchedulerCanGive())].sort();
    const understood = m.REFUSALS_UNDERSTOOD.slice().sort();
    assert.deepStrictEqual(understood, given,
      'a refusal the scheduler grew that the row never learned would let the offer promise a run the tick refuses: '
      + 'teach REFUSALS_UNDERSTOOD in public/routines-model.js and routineRefusal in lib/scheduler.js together');
  });

  // Each word is really reachable, so the source parse above describes live
  // branches rather than comments or dead code.
  test('each understood refusal word is one a real routine elicits', () => {
    const elicits = {
      paused: { paused: true, enabled: true, runOn: 'local', prompt: 'go' },
      enabled: { enabled: false, runOn: 'local', prompt: 'go' },
      runOn: { enabled: true, runOn: 'the-moon', prompt: 'go' },
      prompt: { enabled: true, runOn: 'local', prompt: '' },
    };
    for (const word of m.REFUSALS_UNDERSTOOD) {
      assert.ok(elicits[word], `${word}: no routine shape elicits this word; teach this table with the new branch`);
      assert.strictEqual(scheduler.routineRefusal(elicits[word]), word);
    }
    assert.strictEqual(scheduler.routineRefusal({ enabled: true, runOn: 'local', prompt: 'go' }), null,
      'a runnable routine is refused for nothing');
  });

  // The offer's sentence is true on every state the scheduler can refuse for.
  // 'enabled' alone leaves the offer standing, because flipping enabled is the
  // thing the offer does; every other refusal stops it.
  const RUNNABLE = { schedule: 'every day at 7:00am', scheduleReadable: true, prompt: 'go' };
  test('the offer consumes the published refusal, fail-safe on words it has never heard', () => {
    for (const word of refusalWordsTheSchedulerCanGive()) {
      const stopped = m.somethingElseStopsIt({ ...RUNNABLE, refusal: word });
      if (word === 'enabled') {
        assert.strictEqual(stopped, false,
          'the switch itself never stops the offer that flips the switch');
      } else {
        assert.strictEqual(stopped, true, `${word}: the tick would refuse, so the offer must not promise`);
      }
    }
    assert.strictEqual(m.somethingElseStopsIt({ ...RUNNABLE, refusal: null }), false,
      'a routine the tick refuses for nothing gets its offer');
    assert.strictEqual(m.somethingElseStopsIt({ ...RUNNABLE, refusal: 'quota' }), true,
      'a refusal this row has never heard of stops the offer, which is the fail-safe direction for a sentence that promises a run');
  });

  // A roster written before the refusal field existed still reads truthfully
  // through the row's own checks, so an old server behind a new client never
  // renders a promise it cannot keep.
  test('a roster without the field falls back to the row\'s own checks', () => {
    assert.strictEqual(m.somethingElseStopsIt({ ...RUNNABLE, paused: true }), true);
    assert.strictEqual(m.somethingElseStopsIt({ ...RUNNABLE }), false);
  });
});

describe('RT-5: scheduling an ambiguous skill keeps the skill', () => {
  const AMBIGUOUS = {
    id: 'ops-summary', slug: 'ops-summary', name: 'Compile the ops summary',
    assignedAgents: [{ id: 'piper', name: 'Piper' }, { id: 'doc', name: 'Doc' }],
  };
  const SETTLED = {
    id: 'reading-digest', slug: 'reading-digest', name: 'Refresh the reading digest',
    assignedAgents: [{ id: 'doc', name: 'Doc' }],
  };

  test('one skill several agents have offers one row per agent and nothing else', () => {
    const choice = editorModel.skillChoices({ skills: [AMBIGUOUS] });
    assert.deepStrictEqual(choice.options.map(o => o.key), ['ops-summary:piper', 'ops-summary:doc'],
      'the skill is settled; the rows are the agents that could run it');
    assert.deepStrictEqual(choice.options.map(o => o.agentName), ['Piper', 'Doc'],
      'the agent name is the fact the reader is missing, so every row carries it');
  });

  test('the lead asks only the question that is open', () => {
    assert.strictEqual(editorModel.stepLead({ skills: [AMBIGUOUS] }),
      'Step 1 of 2. Pick which agent runs Compile the ops summary.',
      'asking the reader to pick a skill would ask a question they answered by pressing its control');
    assert.strictEqual(editorModel.stepLead({ skills: [SETTLED] }),
      'Step 1 of 2. Pick a skill any of your agents already has.',
      'one skill one agent is not the ambiguous case, and the general lead stays');
    assert.strictEqual(editorModel.stepLead({ agentName: 'Piper', skills: [AMBIGUOUS] }),
      'Step 1 of 2. Pick a skill Piper already has.',
      'an agent already chosen wins: the open question there is the skill');
  });

  // The unambiguous door landing straight on the schedule step, and the
  // ambiguous door pressed in a real DOM with nothing preselected, are pinned
  // in test/unit/routine-editor-doors.test.js; this file proves the model
  // seam those doors stand on.
});
