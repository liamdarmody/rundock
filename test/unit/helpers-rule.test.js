'use strict';
// THE HELPERS RULE: WHICH AGENT CALLS A LEAD MAY START BESIDE ITSELF.
//
// A lead's Agent calls are either a handoff (one teammate takes over, as
// always) or helpers (several calls run beside the lead). Every helper call is
// checked first, and a call that may not start is named back to the lead with
// its own reason, so the lead can do that part itself or say why it wasn't
// done. The checks run in a fixed order and the first that applies wins.
//
// The team: Wren leads; Ash and Rowan (agent name example-research-lead)
// report to Wren; Sky reports to Ash; Fern reports to Wren and runs on Codex.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { _internal: srv } = require('../../server.js');
const { makeWorkspace, agentFile, cleanup } = require('../helpers/workspace.js');

after(cleanup);

const HELPERS = path.join(__dirname, '..', '..', 'lib', 'delegation', 'helpers.js');
// Asserted before the module is required, so a missing module fails here on
// an assertion instead of throwing from require.
function helpers() {
  assert.ok(fs.existsSync(HELPERS), 'lib/delegation/helpers.js exists');
  return require(HELPERS);
}

function team(extra = {}) {
  return {
    wren: agentFile({ name: 'wren', displayName: 'Wren', role: 'Lead', order: 1 }),
    ash: agentFile({ name: 'ash', displayName: 'Ash', order: 2, reportsTo: 'wren' }),
    'example-research-lead': agentFile({ name: 'example-research-lead', displayName: 'Rowan', order: 3, reportsTo: 'wren' }),
    sky: agentFile({ name: 'sky', displayName: 'Sky', order: 4, reportsTo: 'ash' }),
    fern: agentFile({ name: 'fern', displayName: 'Fern', order: 5, reportsTo: 'wren', runtime: 'codex' }),
    ...extra,
  };
}

function useTeam(agents) { srv.setWorkspace(makeWorkspace({ agents })); }

const NOTICES = {
  fromHelper: "Helpers can't start helpers. Do this part yourself, and say in your report what you would have handed on.",
  fork: "Each helper starts from its brief, so a copy of this conversation can't be started. Write a brief for this part, or do it yourself.",
  self: "Wren can't be Wren's own helper. Do this part yourself.",
  stopped: "The person stopped Ash. Don't restart Ash; say plainly that Ash's part wasn't done.",
  statusline: "statusline-setup changes the person's Claude Code settings, so it can't run here. Do this part yourself.",
  inexact: 'To start Rowan, set the agent to example-research-lead.',
  general: 'To start Rowan, set the agent to example-research-lead. A general helper can\'t work as Rowan.',
  otherLead: 'Sky works for Ash, so only Ash can start Sky. Do this part yourself, or say that this part needs Ash.',
  offTeam: "Sky isn't on your team, so you can't start Sky. Do this part yourself.",
  codex: "Fern runs on another runtime, so Fern can't work as a helper. Hand over to Fern once your helpers finish, or do this part yourself.",
};

function refusal(input, opts) {
  const verdict = helpers().classifyCall('wren', input, opts);
  assert.strictEqual(verdict.kind, 'refused', `refused: ${JSON.stringify(verdict)}`);
  return verdict.notice;
}

describe('the switch', () => {
  test('HELPERS_ENABLED is exported and off', () => {
    assert.strictEqual(helpers().HELPERS_ENABLED, false);
  });

  // Nothing a caller can reach sets the switch: no environment variable, no
  // setting, no request field, no message and no file. Its one value is the
  // literal in the module's exports; every other mention only reads it.
  test('no source outside the module\'s exports assigns the switch or ties it to the environment', () => {
    helpers();
    const root = path.join(__dirname, '..', '..');
    const sources = [path.join(root, 'server.js')];
    for (const dir of ['lib', 'scripts']) {
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('.js')) sources.push(p);
        }
      };
      walk(path.join(root, dir));
    }
    const writes = [];
    for (const file of sources) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line) => {
        if (!/HELPERS_ENABLED/.test(line)) return;
        const assigns = /HELPERS_ENABLED\s*(=(?!=)|:)/.test(line) || /\[\s*['"]HELPERS_ENABLED['"]\s*\]\s*=(?!=)/.test(line);
        if (assigns || /process\.env|argv/.test(line)) writes.push(`${path.relative(root, file)}: ${line.trim()}`);
      });
    }
    assert.deepStrictEqual(writes, [`${path.join('lib', 'delegation', 'helpers.js')}: HELPERS_ENABLED: false,`]);
  });
});

describe('each refused call is named back with its own reason', () => {
  before(() => useTeam(team()));

  test('a call made by a helper', () => {
    assert.strictEqual(refusal({ subagent_type: 'ash', description: 'Draft the summary' }, { fromHelper: true }), NOTICES.fromHelper);
  });

  test('a fork of the lead\'s context', () => {
    assert.strictEqual(refusal({ subagent_type: 'fork', description: 'Carry on' }), NOTICES.fork);
  });

  test('a call naming the lead itself', () => {
    assert.strictEqual(refusal({ subagent_type: 'wren', description: 'Check my work' }), NOTICES.self);
    assert.strictEqual(refusal({ subagent_type: 'Wren', description: 'Check my work' }), NOTICES.self, 'by display name too');
  });

  test('a call naming a teammate the person stopped', () => {
    const stopped = new Set(['ash']);
    assert.strictEqual(refusal({ subagent_type: 'ash', description: 'Draft the summary' }, { stopped }), NOTICES.stopped);
    assert.strictEqual(refusal({ subagent_type: 'general-purpose', description: 'Ash drafts the summary' }, { stopped }), NOTICES.stopped,
      'a general call whose description names the stopped teammate');
  });

  test('statusline-setup', () => {
    assert.strictEqual(refusal({ subagent_type: 'statusline-setup', description: 'Set the status line' }), NOTICES.statusline);
  });

  test('a teammate named by display name', () => {
    assert.strictEqual(refusal({ subagent_type: 'Rowan', description: 'Research the market' }), NOTICES.inexact);
  });

  test('a teammate named in another case', () => {
    assert.strictEqual(refusal({ subagent_type: 'Example-Research-Lead', description: 'Research the market' }), NOTICES.inexact);
  });

  test('a general-purpose call whose description names a teammate', () => {
    assert.strictEqual(refusal({ subagent_type: 'general-purpose', description: 'ROWAN researches the market', prompt: 'Look into it.' }), NOTICES.general);
  });

  test('an untyped call whose description names a teammate by agent name', () => {
    assert.strictEqual(refusal({ description: 'Hand this to example-research-lead', prompt: 'Look into it.' }), NOTICES.general);
  });

  test('a general call whose brief alone names a teammate starts', () => {
    const verdict = helpers().classifyCall('wren', { subagent_type: 'general-purpose', description: 'Research the market', prompt: 'Rowan asked for this.' });
    assert.deepStrictEqual(verdict, { kind: 'builtin', type: 'general-purpose' });
  });

  test('a call naming an agent who reports to another lead', () => {
    assert.strictEqual(refusal({ subagent_type: 'sky', description: 'Design the cover' }), NOTICES.otherLead);
  });

  test('an agent with no leader names the orchestrator in its leader\'s place', () => {
    useTeam({
      ...team(),
      alpha: agentFile({ name: 'alpha', displayName: 'Alpha', type: 'orchestrator', order: 6 }),
      sky: agentFile({ name: 'sky', displayName: 'Sky', order: 4 }),
    });
    try {
      assert.strictEqual(refusal({ subagent_type: 'sky', description: 'Design the cover' }),
        'Sky works for Alpha, so only Alpha can start Sky. Do this part yourself, or say that this part needs Alpha.');
    } finally { useTeam(team()); }
  });

  test('an agent with neither a leader nor an orchestrator is off the team', () => {
    useTeam({ ...team(), sky: agentFile({ name: 'sky', displayName: 'Sky', order: 4 }) });
    try {
      assert.strictEqual(refusal({ subagent_type: 'sky', description: 'Design the cover' }), NOTICES.offTeam);
    } finally { useTeam(team()); }
  });

  test('a teammate who runs on Codex can\'t be a helper', () => {
    assert.strictEqual(refusal({ subagent_type: 'fern', description: 'Port the script' }), NOTICES.codex);
  });

  for (const type of ['code-reviewer', 'example-plugin:reviewer', 'not-a-known-type', 'claude', 'claude-code-guide']) {
    test(`a type this workspace doesn't have: ${type}`, () => {
      assert.strictEqual(refusal({ subagent_type: type, description: 'Review it' }), `${type} isn't on this workspace's team. Do this part yourself.`);
    });
  }

  test('a built-in type spelled any other way is unknown', () => {
    assert.strictEqual(refusal({ subagent_type: 'explore', description: 'Look around' }), "explore isn't on this workspace's team. Do this part yourself.");
  });
});

describe('the first check that applies gives the reason', () => {
  before(() => useTeam(team()));

  test('a helper\'s call naming the lead gets the helper\'s reason', () => {
    assert.strictEqual(refusal({ subagent_type: 'wren', description: 'Check it' }, { fromHelper: true }), NOTICES.fromHelper);
  });

  test('a stopped teammate named inexactly gets the stopped reason', () => {
    assert.strictEqual(refusal({ subagent_type: 'ASH', description: 'Draft it' }, { stopped: new Set(['ash']) }), NOTICES.stopped);
  });
});

describe('teammates and built-ins that may start', () => {
  before(() => useTeam(team()));

  test('a teammate named exactly', () => {
    assert.deepStrictEqual(helpers().classifyCall('wren', { subagent_type: 'example-research-lead', description: 'Research' }),
      { kind: 'teammate', type: 'example-research-lead', agent: 'example-research-lead', name: 'Rowan' });
  });

  for (const type of ['general-purpose', 'Explore', 'Plan', 'web-fetch']) {
    test(`the built-in ${type}`, () => {
      assert.deepStrictEqual(helpers().classifyCall('wren', { subagent_type: type, description: 'Look around' }), { kind: 'builtin', type });
    });
  }

  test('an untyped call', () => {
    assert.deepStrictEqual(helpers().classifyCall('wren', { description: 'Look around', prompt: 'Find the config.' }), { kind: 'builtin', type: null });
  });
});

// A lead's Agent calls in one message, decided together.
describe('placement: a handoff or a batch of helpers', () => {
  before(() => useTeam(team()));
  const call = (id, input) => ({ id, input });
  const place = (calls, opts) => helpers().placeCalls('wren', calls, opts);
  const kinds = (placement) => placement.calls.map((c) => c.verdict.kind);

  test('one teammate call without background is a handoff', () => {
    assert.deepStrictEqual(place([call('t1', { subagent_type: 'ash', description: 'Draft it' })]), { kind: 'handoff' });
  });

  test('one teammate call in the background is a helper', () => {
    const placement = place([call('t1', { subagent_type: 'ash', description: 'Draft it', run_in_background: true })]);
    assert.strictEqual(placement.kind, 'helpers');
    assert.deepStrictEqual(placement.calls[0].verdict, { kind: 'teammate', type: 'ash', agent: 'ash', name: 'Ash' });
    assert.strictEqual(placement.calls[0].id, 't1');
  });

  test('two teammate calls are helpers, in message order', () => {
    const placement = place([
      call('t1', { subagent_type: 'ash', description: 'Draft it' }),
      call('t2', { subagent_type: 'example-research-lead', description: 'Research it' }),
    ]);
    assert.strictEqual(placement.kind, 'helpers');
    assert.deepStrictEqual(placement.calls.map((c) => [c.id, c.verdict.agent]), [['t1', 'ash'], ['t2', 'example-research-lead']]);
  });

  test('built-ins alone are helpers: one Explore, then Explore and Plan', () => {
    assert.deepStrictEqual(kinds(place([call('b1', { subagent_type: 'Explore', description: 'Look' })])), ['builtin']);
    const two = place([call('b1', { subagent_type: 'Explore', description: 'Look' }), call('b2', { subagent_type: 'Plan', description: 'Plan' })]);
    assert.strictEqual(two.kind, 'helpers');
    assert.deepStrictEqual(kinds(two), ['builtin', 'builtin']);
  });

  test('a teammate beside a built-in are helpers', () => {
    const placement = place([call('t1', { subagent_type: 'ash', description: 'Draft it' }), call('b1', { subagent_type: 'Explore', description: 'Look' })]);
    assert.strictEqual(placement.kind, 'helpers');
    assert.deepStrictEqual(kinds(placement), ['teammate', 'builtin']);
  });

  test('a call naming the lead beside a teammate: the teammate is a helper, the lead\'s call refused', () => {
    const placement = place([call('s1', { subagent_type: 'wren', description: 'Check it' }), call('t1', { subagent_type: 'ash', description: 'Draft it' })]);
    assert.strictEqual(placement.kind, 'helpers');
    assert.deepStrictEqual(placement.calls.map((c) => c.verdict.kind), ['refused', 'teammate']);
    assert.strictEqual(placement.calls[0].verdict.notice, NOTICES.self);
  });

  test('a lone call naming the lead is refused, never handed over', () => {
    const placement = place([call('s1', { subagent_type: 'wren', description: 'Check it' })]);
    assert.strictEqual(placement.kind, 'helpers');
    assert.strictEqual(placement.calls[0].verdict.notice, NOTICES.self);
  });

  test('a lone call naming a stopped teammate is refused, never handed over', () => {
    const placement = place([call('t1', { subagent_type: 'ash', description: 'Draft it' })], { stopped: new Set(['ash']) });
    assert.strictEqual(placement.kind, 'helpers');
    assert.strictEqual(placement.calls[0].verdict.notice, NOTICES.stopped);
  });

  test('a lone call naming Fern, who runs on Codex, stays a handoff, as today', () => {
    assert.deepStrictEqual(place([call('t1', { subagent_type: 'fern', description: 'Port it' })]), { kind: 'handoff' });
  });
});

// A lone call that names no teammate exactly is never a handoff: it is placed
// as a helper, and its hook request is refused with its own reason.
describe('a lone call that may not start is refused through the hook, never handed over', () => {
  before(() => useTeam(team()));
  let n = 0;
  async function lone(input) {
    const convo = `lone-call-${++n}`;
    const placement = helpers().placeMessage(convo, { agentId: 'wren' }, [{ id: 'l1', input }]);
    const answer = await helpers().answerAgentRequest({ convoId: convo, askedBy: 'wren', data: { tool_use_id: 'l1', tool_input: input } });
    return { kind: placement.kind, answer };
  }
  const refusedWith = (notice) => ({ kind: 'helpers', answer: { allow: false, notice } });

  test('a teammate named by display name', async () => {
    assert.deepStrictEqual(await lone({ subagent_type: 'Rowan', description: 'Research it' }), refusedWith(NOTICES.inexact));
  });

  test('a teammate named in another case', async () => {
    assert.deepStrictEqual(await lone({ subagent_type: 'Example-Research-Lead', description: 'Research it' }), refusedWith(NOTICES.inexact));
  });

  test('an untyped call whose description names a teammate', async () => {
    assert.deepStrictEqual(await lone({ description: 'Hand this to Rowan', prompt: 'Look into it.' }), refusedWith(NOTICES.general));
  });

  test('a general-purpose call whose description names a teammate', async () => {
    assert.deepStrictEqual(await lone({ subagent_type: 'general-purpose', description: 'rowan researches it', prompt: 'Look into it.' }), refusedWith(NOTICES.general));
  });

  test('an agent who works for another lead', async () => {
    assert.deepStrictEqual(await lone({ subagent_type: 'sky', description: 'Design it' }), refusedWith(NOTICES.otherLead));
  });
});

describe('the task each helper is shown with', () => {
  test('whitespace runs collapse to one space', () => {
    assert.strictEqual(helpers().helperTask('  Draft\n\tthe   summary  ', ''), 'Draft the summary');
  });

  test('eighty characters stay whole', () => {
    const text = `${'word '.repeat(15)}abcd`;
    assert.strictEqual(text.length, 79);
    assert.strictEqual(helpers().helperTask(`${text}e`, ''), `${text}e`);
  });

  test('a longer description is cut at a word, the closing mark included in eighty', () => {
    const description = 'word '.repeat(20).trim();
    const task = helpers().helperTask(description, '');
    assert.ok(task.length <= 80, `${task.length}`);
    assert.strictEqual(task, `${'word '.repeat(16).trim()}…`);
  });

  test('an empty description gives the brief\'s first non-empty line', () => {
    assert.strictEqual(helpers().helperTask('   ', '\n  \n  Read the   notes\nThen write.'), 'Read the notes');
    assert.strictEqual(helpers().helperTask(undefined, `\n${'line '.repeat(30)}`), `${'line '.repeat(16).trim()}…`);
  });

  test('a single word longer than the limit is cut at seventy-nine characters', () => {
    const task = helpers().helperTask('x'.repeat(120), '');
    assert.strictEqual(task, `${'x'.repeat(79)}…`);
    assert.strictEqual(task.length, 80);
  });
});
