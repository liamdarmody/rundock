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
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const m = require('../../public/routines-model.js');
const editorModel = require('../../public/routine-editor-model.js');
const scheduler = require('../../lib/scheduler.js');
const config = require('../../lib/config.js');
const { invalidateAgentCache, discoverAgents } = require('../../lib/agents/discovery.js');
const { agentFile, makeWorkspace, cleanup } = require('../helpers/workspace.js');

after(cleanup);

const ROOT = path.join(__dirname, '..', '..');
const readSrc = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

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

  // The declaration is checked against the writers themselves, so it cannot
  // become a hand-maintained double. Every status literal the scheduler's
  // source assigns to a `status` field is collected; a writer that gains a
  // word fails here until the word is classified, either into the vocabulary
  // (teaching the declaration and the list together) or into the named
  // exclusion below. Under-reporting is impossible: the parse collects, it
  // never filters silently.
  test('the declared vocabulary is the one the writers actually write', () => {
    const src = readSrc('lib', 'scheduler.js');
    const written = new Set();
    // Object-literal writes: `status: <expression up to the field's comma>`.
    for (const site of src.matchAll(/\bstatus:\s*([^,\n]+)/g)) {
      for (const lit of site[1].matchAll(/'([a-z-]+)'/g)) written.add(lit[1]);
    }
    // Property assignments: `.status = <expression>`, and not comparisons.
    for (const site of src.matchAll(/\.status\s*=\s*([^=][^\n]*)/g)) {
      for (const lit of site[1].matchAll(/'([a-z-]+)'/g)) written.add(lit[1]);
    }
    // THE ONE NAMED EXCLUSION: readRunProgress and its helpers answer whether
    // a live run's ACTIVITY can be observed ('known'/'unknown'), which is a
    // different question from what a run's record says, rendered by the run
    // screen's own model and never by the routines list. Excluding it here is
    // a decision this test states; a new word lands in neither set and fails
    // below until somebody classifies it.
    const observation = new Set(['known', 'unknown']);
    const vocabulary = [...written].filter(word => !observation.has(word)).sort();
    assert.deepStrictEqual(vocabulary, scheduler.statusesTheSchedulerRecords().slice().sort(),
      'a status a writer records that the declaration does not carry would render through the '
      + 'time-based reading as Ran: classify the word, teaching statusesTheSchedulerRecords and '
      + 'RUN_STATUS_WORDS together, or name it an observation word here with its reason');
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
    // EVERY RETURN IS ACCOUNTED FOR, so the parse fails loudly rather than
    // under-reports. A branch added as a double-quoted literal, a template
    // literal, a constant or a returned variable would be invisible to the
    // word extractor, and an extractor that silently skips it is an
    // instrument gone quietly blind. Each return is therefore required to be
    // either the null return or a single-quoted word the extractor reads.
    const returns = [...source.matchAll(/return\b([^;]*);/g)].map(hit => hit[1].trim());
    assert.ok(returns.length > 0, 'the parse found no return statements, which is a broken instrument, not an empty list');
    const words = [];
    for (const returned of returns) {
      if (returned === 'null') continue;
      const word = /^'([A-Za-z]+)'$/.exec(returned);
      assert.ok(word,
        `routineRefusal has a return this walk cannot read: \`return ${returned};\`. `
        + 'Express the refusal as a single-quoted word literal, or teach this parse the new form, '
        + 'so the divergence check keeps seeing every branch');
      words.push(word[1]);
    }
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

  // THE SWITCH NEVER SHADOWS THE REAL FAULT. The published word is the one
  // answer the offer consumes, and the offer stands only on 'enabled', so a
  // refusal function that reported the switch first would hand every
  // switched-off routine the word the offer rightly ignores, whatever else
  // was wrong with it. The scheduler reports the switch last for exactly this
  // reader, and these are the two routines that used to fall through: off and
  // promptless, and off with a run target nothing supports. Each must publish
  // its real fault, and the row must withhold the offer on it.
  test('a switched-off routine with a deeper fault publishes the fault, and the offer is withheld', () => {
    const offAndPromptless = { enabled: false, runOn: 'local', prompt: '' };
    assert.strictEqual(scheduler.routineRefusal(offAndPromptless), 'prompt',
      'the missing prompt is reported, not the switch in front of it');
    assert.strictEqual(m.somethingElseStopsIt({ ...RUNNABLE, prompt: '', enabled: false,
      refusal: scheduler.routineRefusal(offAndPromptless) }), true,
      'so the row does not promise that flipping the switch starts a routine the tick would refuse');

    const offOnUnsupportedTarget = { enabled: false, runOn: 'the-moon', prompt: 'go' };
    assert.strictEqual(scheduler.routineRefusal(offOnUnsupportedTarget), 'runOn',
      'the unsupported target is reported, not the switch in front of it');
    assert.strictEqual(m.somethingElseStopsIt({ ...RUNNABLE, runOn: 'the-moon', enabled: false,
      refusal: scheduler.routineRefusal(offOnUnsupportedTarget) }), true);

    const offAndOtherwiseFine = { enabled: false, runOn: 'local', prompt: 'go' };
    assert.strictEqual(scheduler.routineRefusal(offAndOtherwiseFine), 'enabled',
      'a routine where the switch really is the only thing in the way says so, and only that routine');
    assert.strictEqual(m.somethingElseStopsIt({ ...RUNNABLE, enabled: false,
      refusal: scheduler.routineRefusal(offAndOtherwiseFine) }), false,
      'which is the one row the Turn on offer is true on');
  });
});

describe('RT-4: the published refusal reaches the row on the live path', () => {
  // The two lines that make the lists one, each proven where it lives: the
  // roster enrichment in lib/agents/discovery.js, and the pass-through in
  // public/views/routines.js. Without these, the model quietly falls back to
  // its private copy of the reasons and every seam-level test above stays
  // green, so each line here is driven through the real thing it belongs to.
  test('real discovery stamps the scheduler\'s own answer onto the roster', () => {
    const dir = makeWorkspace({
      agents: {
        piper: agentFile({
          name: 'piper', displayName: 'Piper', type: 'specialist', order: 1,
          routines: [
            // Promptless AND switched off: the roster must carry the fault,
            // not the switch in front of it.
            { name: 'No prompt', schedule: 'every day at 07:00', enabled: false },
            { name: 'Runnable', schedule: 'every day at 07:00', prompt: 'p', enabled: true },
          ],
        }),
      },
    });
    const originalWorkspace = config.getWorkspace();
    config.setWorkspace(dir);
    invalidateAgentCache();
    try {
      const piper = discoverAgents().find(a => a.id === 'piper');
      const routine = Object.fromEntries(piper.routines.map(r => [r.name, r]));
      assert.strictEqual(routine['No prompt'].refusal, 'prompt',
        'the roster carries the tick\'s own refusal for a routine it would refuse');
      assert.strictEqual(routine['Runnable'].refusal, null,
        'and carries the tick\'s own null for one it would not');
    } finally {
      config.setWorkspace(originalWorkspace);
      invalidateAgentCache();
    }
  });

  // The view's pass-through, proven with a refusal word the row has no
  // private check for. The four live words are all mirrored by the model's
  // own fallback, so on those the pass-through's loss is invisible; a word
  // the fallback has never heard is the one input whose rendering depends on
  // the field actually arriving, which is what makes it the honest probe.
  test('the routines view hands the published refusal to the model unchanged', () => {
    const shell = (refusal) => {
      const dom = new JSDOM('<!doctype html><html><body>'
        + '<nav class="nav-rail"><button class="nav-item" data-nav="routines"></button></nav>'
        + '<div id="view-routines"><div id="routines-content"></div></div>'
        + '</body></html>', { runScripts: 'dangerously' });
      const w = dom.window;
      w.eval(readSrc('public', 'routine-editor-model.js'));
      w.eval(readSrc('public', 'skills-model.js'));
      w.eval(readSrc('public', 'routines-model.js'));
      w.eval(readSrc('public', 'views', 'routines.js'));
      w.agents = [{
        id: 'piper', name: 'piper', displayName: 'Piper', type: 'specialist',
        routines: [{
          name: 'digest', schedule: 'every day at 07:00', prompt: 'p', runOn: 'local',
          enabled: false, scheduleReadable: true, refusal,
        }],
      }];
      w.esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      w.ws = { send: () => {} };
      w.routinesNow = () => NOW;
      w.Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Europe/London' }) }) };
      w.renderRoutines();
      return { doc: w.document, dom };
    };

    const withheld = shell('quota');
    assert.strictEqual(withheld.doc.querySelector('.rr-offer-line'), null,
      'a refusal the model has never heard of withholds the offer, which can only happen if the view '
      + 'passed the field through: every private check on this routine would have offered');
    withheld.dom.window.close();

    const offered = shell('enabled');
    assert.ok(offered.doc.querySelector('.rr-offer-line'),
      'and the same routine under the switch-only word gets its offer, so it is the word deciding, '
      + 'not the harness');
    offered.dom.window.close();
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
