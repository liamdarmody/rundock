'use strict';
// The routes around Doc's markers: the other runtime, routines, turns that
// end without a result, the decision failing, two windows, and the sequences
// a person actually runs.
//
// Only a turn the server recorded as Doc's (rundock-guide), ending with a
// result, saves or deletes agents and skills (lib/agents/team-markers.js).
// team-markers.test.js holds the main cases; this file holds the rest. Doc
// here is a workspace file of its own, so the built-in Doc and a file-backed
// one are both covered between the two files.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const fx = require('../fixtures/stream-json.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');
const teamMarkers = require('../../lib/agents/team-markers.js');
const teamHandlers = require('../../lib/protocol/handlers/team.js');

let client;

before(async () => {
  await h.boot({
    agents: {
      ...standardTeam(),
      'rundock-guide': agentFile({
        name: 'rundock-guide', displayName: 'Doc', role: 'Rundock Guide', description: 'Sets up the workspace',
        type: 'platform', order: 90, body: 'You are Doc.',
      }),
      // A second agent whose file says it is a platform agent. Identity is
      // the id, so this is any other agent.
      'second-guide': agentFile({
        name: 'second-guide', displayName: 'Gil', role: 'Another Guide', description: 'Says it is a guide',
        type: 'platform', order: 91, body: 'You are Gil.',
      }),
      'researcher': agentFile({
        name: 'researcher', displayName: 'Ida', role: 'Researcher', description: 'Researches suppliers',
        type: 'specialist', order: 5, reportsTo: 'chief-of-staff', runtime: 'codex', body: 'You are Ida.',
      }),
    },
  });
  client = await h.connect();
});
after(async () => h.shutdown());

const agentPath = (name) => path.join(h.workspaceDir, '.claude', 'agents', `${name}.md`);
const readOrNull = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null);
function teamFile(name, label) {
  return agentFile({
    name, displayName: label, role: 'Example Role', description: 'An example agent',
    type: 'specialist', order: 30, reportsTo: 'chief-of-staff', body: `You are ${label}.`,
  }).trim();
}
const saveMarker = (name, label) => `<!-- RUNDOCK:SAVE_AGENT name=${name} -->\n${teamFile(name, label)}\n<!-- /RUNDOCK:SAVE_AGENT -->`;
const deleteMarker = (name) => `<!-- RUNDOCK:DELETE_AGENT name=${name} -->`;
function seed(name, label) {
  fs.writeFileSync(agentPath(name), teamFile(name, label));
  h.internal.invalidateAgentCache();
}
function unseed(...names) {
  for (const name of names) fs.rmSync(agentPath(name), { force: true });
  h.internal.invalidateAgentCache();
}

const TEAM_LINES = ['agent_saved', 'agent_deleted', 'skill_saved', 'skill_deleted', 'agent_error', 'skill_error'];
const linesFor = (messages, convoId) => messages.filter((m) => TEAM_LINES.includes(m.type) && m.conversationId === convoId);

// One turn of a direct chat, run to its done.
async function chat(convoId, agent, content, from = client) {
  const since = from.messages.length;
  from.send({ type: 'chat', conversationId: convoId, agent, content });
  await from.waitFor((m) => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId, { since, label: `${agent} done` });
  return since;
}

async function refusal(convoId, who, verbed, since = 0, from = client) {
  const { msg } = await from.waitFor((m) => (m.type === 'agent_error' || m.type === 'skill_error') && m.conversationId === convoId
    && m.refused === true && m.message.startsWith(`${who} asked to ${verbed}`) && m.message.includes('only Doc can change the team'),
  { since, timeout: 4000, label: `${who}'s refusal to ${verbed}` });
  return msg;
}

describe('Doc is the id rundock-guide, not a type, and never another runtime', () => {
  test('another agent whose file declares type: platform is refused', async () => {
    const convoId = h.freshConvoId('typed');
    h.writeScenario([{ match: { agent: 'second-guide', promptIncludes: 'TYPED-PLATFORM' }, turn: [{ text: `Saving.\n${saveMarker('typed-made', 'Typed')}` }] }]);
    try {
      const since = await chat(convoId, 'second-guide', 'TYPED-PLATFORM make one');
      await refusal(convoId, 'Gil', 'save the agent "typed-made"', since);
      assert.strictEqual(fs.existsSync(agentPath('typed-made')), false, 'nothing was written');
    } finally {
      h.reapConvo(convoId);
      unseed('typed-made');
    }
  });

  test('a Codex agent\'s marker in a direct chat is refused', async () => {
    const convoId = h.freshConvoId('codex');
    seed('codex-target', 'Before');
    h.writeCodexScenario([{ match: { promptIncludes: 'CODEX-DIRECT' }, text: `Done.\n${deleteMarker('codex-target')}` }]);
    try {
      const since = client.messages.length;
      client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'CODEX-DIRECT remove it' });
      await refusal(convoId, 'Ida', 'delete the agent "codex-target"', since);
      assert.strictEqual(readOrNull(agentPath('codex-target')), teamFile('codex-target', 'Before'), 'the agent is still there, unchanged');
    } finally {
      h.reapConvo(convoId);
      unseed('codex-target');
    }
  });

  test('a Codex agent\'s marker as a delegate is refused', async () => {
    const convoId = h.freshConvoId('codexdel');
    seed('codex-del-target', 'Before');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'CODEX-DELEGATED' },
        turn: [{ agentTool: { subagent_type: 'researcher', prompt: 'CODEX-BRIEF remove it' } }] },
      { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' }, turn: [{ text: '<silent>' }] },
    ]);
    h.writeCodexScenario([{ match: { promptIncludes: 'CODEX-BRIEF' }, text: `Removed.\n${deleteMarker('codex-del-target')}\n<!-- RUNDOCK:COMPLETE -->` }]);
    try {
      const since = client.messages.length;
      client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'CODEX-DELEGATED please' });
      await refusal(convoId, 'Ida', 'delete the agent "codex-del-target"', since);
      assert.strictEqual(readOrNull(agentPath('codex-del-target')), teamFile('codex-del-target', 'Before'), 'the agent is still there, unchanged');
    } finally {
      h.reapConvo(convoId);
      unseed('codex-del-target');
    }
  });
});

describe('a marker in a turn that does not end with a result is not acted on', () => {
  test('a routine run by Doc changes nothing', async () => {
    seed('routine-target', 'Before');
    h.clearInvocations();
    h.writeScenario([{ match: { promptIncludes: 'ROUTINE-MARKERS' }, turn: [{ text: `${deleteMarker('routine-target')}\n${saveMarker('routine-made', 'Made')}` }] }]);
    const since = client.messages.length;
    try {
      const doc = h.internal.discoverAgents().find((a) => a.id === 'rundock-guide');
      h.internal.executeRoutine(doc, { name: 'team-check', schedule: 'daily 09:00', prompt: 'ROUTINE-MARKERS tidy the team' }, 'team-markers-routine');
      assert.ok(await h.waitUntil(() => h.readInvocations().some((i) => JSON.stringify(i).includes('ROUTINE-MARKERS'))), 'the routine ran');
      // The run's output goes nowhere the server reads. Proving that nothing
      // follows needs real time.
      await h.delay(600);
      assert.strictEqual(readOrNull(agentPath('routine-target')), teamFile('routine-target', 'Before'), 'nothing was deleted');
      assert.strictEqual(fs.existsSync(agentPath('routine-made')), false, 'nothing was made');
      assert.deepStrictEqual(client.messages.slice(since).filter((m) => TEAM_LINES.includes(m.type)), [], 'and no line about the team');
    } finally {
      unseed('routine-target', 'routine-made');
    }
  });

  test('an orchestrator\'s turn intercepted by its own Agent call changes nothing', async () => {
    const convoId = h.freshConvoId('intercept');
    seed('intercept-target', 'Before');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'INTERCEPTED' },
        turn: [{ text: `Removing it first.\n${deleteMarker('intercept-target')}` }, { agentTool: { subagent_type: 'content-lead', prompt: 'INTERCEPT-BRIEF' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'INTERCEPT-BRIEF' }, turn: [{ text: 'Done. <!-- RUNDOCK:COMPLETE -->' }] },
      { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' }, turn: [{ text: '<silent>' }] },
    ]);
    try {
      const since = client.messages.length;
      client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'INTERCEPTED go' });
      await client.waitFor((m) => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead', { since, label: 'the delegate\'s result' });
      await client.waitFor((m) => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId && m._agent === 'chief-of-staff', { since, timeout: 5000, label: 'the orchestrator restored' });
      await h.delay(300);
      assert.strictEqual(readOrNull(agentPath('intercept-target')), teamFile('intercept-target', 'Before'), 'nothing was deleted');
      assert.deepStrictEqual(linesFor(client.messages.slice(since), convoId), [], 'the intercepted turn was not acted on, not even to refuse it');
    } finally {
      h.reapConvo(convoId);
      unseed('intercept-target');
    }
  });

  test('Doc\'s turn blocked for an off-roster Agent call changes nothing', async () => {
    const convoId = h.freshConvoId('offroster');
    seed('offroster-target', 'Before');
    h.writeScenario([
      { match: { agent: 'rundock-guide', promptIncludes: 'OFF-ROSTER' },
        turn: [{ text: `Removing it.\n${deleteMarker('offroster-target')}` }, { agentTool: { subagent_type: 'content-analyst', prompt: 'not yours' } }] },
      { match: { agent: 'rundock-guide', promptIncludes: 'delegation-blocked' }, turn: [{ text: 'Understood, carrying on.' }] },
    ]);
    try {
      const since = client.messages.length;
      client.send({ type: 'chat', conversationId: convoId, agent: 'rundock-guide', content: 'OFF-ROSTER go' });
      await client.waitFor((m) => m.type === 'result' && m._conversationId === convoId && m.result === 'Understood, carrying on.', { since, label: 'the resumed turn' });
      await h.delay(300);
      assert.strictEqual(readOrNull(agentPath('offroster-target')), teamFile('offroster-target', 'Before'), 'nothing was deleted');
      assert.deepStrictEqual(linesFor(client.messages.slice(since), convoId), [], 'the blocked turn was not acted on');
    } finally {
      h.reapConvo(convoId);
      unseed('offroster-target');
    }
  });

  test('Doc\'s turn that dies before its result changes nothing', async () => {
    const convoId = h.freshConvoId('crash');
    seed('crash-target', 'Before');
    // The marker reaches the server as streamed text, then the process dies
    // with no result.
    const streamed = [fx.contentBlockStartText(), fx.textDelta(`Removing it.\n${deleteMarker('crash-target')}`)].map((e) => JSON.stringify(e)).join('\n');
    h.writeScenario([{ match: { agent: 'rundock-guide', promptIncludes: 'CRASH-TURN' }, crash: 1, crashTail: `${streamed}\n{"type":"stream_event"` }]);
    try {
      const since = client.messages.length;
      client.send({ type: 'chat', conversationId: convoId, agent: 'rundock-guide', content: 'CRASH-TURN go' });
      await client.waitFor((m) => m.type === 'stream_event' && m._conversationId === convoId && JSON.stringify(m).includes('crash-target'), { since, label: 'the marker streamed' });
      await client.waitFor((m) => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId, { since, label: 'the turn ended' });
      await h.delay(300);
      assert.strictEqual(readOrNull(agentPath('crash-target')), teamFile('crash-target', 'Before'), 'nothing was deleted');
      assert.deepStrictEqual(linesFor(client.messages.slice(since), convoId), [], 'and no line about the team');
    } finally {
      h.reapConvo(convoId);
      unseed('crash-target');
    }
  });
});

describe('when the decision fails, nothing is written and the next turn still works', () => {
  // Each failure is forced through a module attribute, the only seams there
  // are, and put back before the next turn, which must then write.
  const FAILURES = [
    ['the scan throws', () => { const was = teamMarkers.seams.scan; teamMarkers.seams.scan = () => { throw new Error('scan broke'); }; return () => { teamMarkers.seams.scan = was; }; },
      /could not read the changes to the team/],
    ['the author lookup finds nobody', () => { const was = teamMarkers.seams.authorOf; teamMarkers.seams.authorOf = () => null; return () => { teamMarkers.seams.authorOf = was; }; },
      /^An agent asked to save the agent "fail-made", but only Doc can change the team/],
    ['the author lookup throws', () => { const was = teamMarkers.seams.authorOf; teamMarkers.seams.authorOf = () => { throw new Error('lookup broke'); }; return () => { teamMarkers.seams.authorOf = was; }; },
      /^An agent asked to save the agent "fail-made", but only Doc can change the team/],
    ['the write throws', () => { const was = teamHandlers.handleSaveAgent; teamHandlers.handleSaveAgent = () => { throw new Error('disk full'); }; return () => { teamHandlers.handleSaveAgent = was; }; },
      /^Doc asked to save the agent "fail-made", but it could not be done \(disk full\)/],
  ];
  for (const [label, breakIt, line] of FAILURES) {
    test(label, async () => {
      const convoId = h.freshConvoId('fail');
      h.writeScenario([{ match: { agent: 'rundock-guide', promptIncludes: 'FAIL-CLOSED' }, turn: [{ text: `Making it.\n${saveMarker('fail-made', 'Made')}` }] }]);
      const restore = breakIt();
      try {
        const since = await chat(convoId, 'rundock-guide', 'FAIL-CLOSED make it');
        const { msg } = await client.waitFor((m) => m.type === 'agent_error' && m.conversationId === convoId, { since, timeout: 4000, label: 'the line' });
        assert.match(msg.message, line);
        assert.strictEqual(fs.existsSync(agentPath('fail-made')), false, 'nothing was written');
      } finally {
        restore();
      }
      try {
        const since = await chat(convoId, 'rundock-guide', 'FAIL-CLOSED again');
        await client.waitFor((m) => m.type === 'agent_saved' && m.agentId === 'fail-made' && m.conversationId === convoId, { since, timeout: 4000, label: 'the next turn\'s save' });
        assert.strictEqual(readOrNull(agentPath('fail-made')), teamFile('fail-made', 'Made'), 'the next turn wrote it');
      } finally {
        h.reapConvo(convoId);
        unseed('fail-made');
      }
    });
  }
});

describe('the sequences', () => {
  test('two windows: Doc\'s marker writes once, and each window is told once', async () => {
    const convoId = h.freshConvoId('twowin');
    const second = await h.connect();
    h.writeScenario([{ match: { agent: 'rundock-guide', promptIncludes: 'TWO-WINDOWS' }, turn: [{ text: `Made.\n${saveMarker('twowin-made', 'Made')}` }] }]);
    try {
      const sinceSecond = second.messages.length;
      const since = await chat(convoId, 'rundock-guide', 'TWO-WINDOWS make it');
      await second.waitFor((m) => m.type === 'agent_saved' && m.conversationId === convoId, { since: sinceSecond, label: 'the second window told' });
      await h.delay(300);
      for (const [label, window, from] of [['the window that sent it', client, since], ['the other window', second, sinceSecond]]) {
        const lines = linesFor(window.messages.slice(from), convoId);
        assert.deepStrictEqual(lines.map((m) => [m.type, m.agentId, m.updated]), [['agent_saved', 'twowin-made', false]], `${label}: one confirmation, saying created`);
      }
      assert.strictEqual(readOrNull(agentPath('twowin-made')), teamFile('twowin-made', 'Made'));
    } finally {
      second.close();
      h.reapConvo(convoId);
      unseed('twowin-made');
    }
  });

  test('the retry: a specialist\'s same marker in two turns is refused both times', async () => {
    const convoId = h.freshConvoId('retry');
    seed('retry-target', 'Before');
    h.writeScenario([{ match: { agent: 'content-lead', promptIncludes: 'RETRY-MARKER' }, turn: [{ text: saveMarker('retry-target', 'Retried') }] }]);
    try {
      for (const attempt of ['first', 'second']) {
        const since = await chat(convoId, 'content-lead', `RETRY-MARKER ${attempt}`);
        await refusal(convoId, 'Wren', 'save the agent "retry-target"', since);
        assert.strictEqual(readOrNull(agentPath('retry-target')), teamFile('retry-target', 'Before'), `${attempt} turn: unchanged`);
      }
    } finally {
      h.reapConvo(convoId);
      unseed('retry-target');
    }
  });

  test('the inverse: a specialist\'s DELETE_AGENT is refused, and Doc\'s removes the file', async () => {
    const convoId = h.freshConvoId('inverse');
    seed('inverse-target', 'Before');
    h.writeScenario([
      { match: { agent: 'content-lead', promptIncludes: 'INVERSE-DELETE' }, turn: [{ text: deleteMarker('inverse-target') }] },
      { match: { agent: 'rundock-guide', promptIncludes: 'INVERSE-DELETE' }, turn: [{ text: deleteMarker('inverse-target') }] },
    ]);
    try {
      let since = await chat(convoId, 'content-lead', 'INVERSE-DELETE remove it');
      await refusal(convoId, 'Wren', 'delete the agent "inverse-target"', since);
      assert.strictEqual(readOrNull(agentPath('inverse-target')), teamFile('inverse-target', 'Before'), 'the specialist removed nothing');
      h.reapConvo(convoId);
      since = await chat(convoId, 'rundock-guide', 'INVERSE-DELETE remove it');
      await client.waitFor((m) => m.type === 'agent_deleted' && m.agentId === 'inverse-target' && m.conversationId === convoId, { since, label: 'Doc\'s delete' });
      assert.strictEqual(fs.existsSync(agentPath('inverse-target')), false, 'Doc removed it');
    } finally {
      h.reapConvo(convoId);
      unseed('inverse-target');
    }
  });

  test('the undo: Doc saves then deletes an agent, and a specialist cannot put it back', async () => {
    const convoId = h.freshConvoId('undo');
    h.writeScenario([
      { match: { agent: 'rundock-guide', promptIncludes: 'UNDO-SAVE' }, turn: [{ text: saveMarker('undo-made', 'Made') }] },
      { match: { agent: 'rundock-guide', promptIncludes: 'UNDO-DELETE' }, turn: [{ text: deleteMarker('undo-made') }] },
      { match: { agent: 'content-lead', promptIncludes: 'UNDO-RESTORE' }, turn: [{ text: saveMarker('undo-made', 'Restored') }] },
    ]);
    try {
      let since = await chat(convoId, 'rundock-guide', 'UNDO-SAVE make it');
      await client.waitFor((m) => m.type === 'agent_saved' && m.agentId === 'undo-made' && m.conversationId === convoId, { since, label: 'saved' });
      assert.strictEqual(readOrNull(agentPath('undo-made')), teamFile('undo-made', 'Made'), 'saved on disk');
      since = await chat(convoId, 'rundock-guide', 'UNDO-DELETE remove it');
      await client.waitFor((m) => m.type === 'agent_deleted' && m.agentId === 'undo-made' && m.conversationId === convoId, { since, label: 'deleted' });
      assert.strictEqual(fs.existsSync(agentPath('undo-made')), false, 'deleted on disk');
      h.reapConvo(convoId);
      since = await chat(convoId, 'content-lead', 'UNDO-RESTORE put it back');
      await refusal(convoId, 'Wren', 'save the agent "undo-made"', since);
      assert.strictEqual(fs.existsSync(agentPath('undo-made')), false, 'still gone');
    } finally {
      h.reapConvo(convoId);
      unseed('undo-made');
    }
  });

  test('the next step: an orchestrator refused for its own marker hands the change to Doc, whose marker writes once', async () => {
    const convoId = h.freshConvoId('nextstep');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'NEXT-STEP-OWN' }, turn: [{ text: `Making it myself.\n${saveMarker('nextstep-made', 'Own')}` }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'NEXT-STEP-DOC' },
        turn: [{ agentTool: { subagent_type: 'rundock-guide', prompt: 'NEXT-STEP-BRIEF make it' } }] },
      { match: { agent: 'rundock-guide', promptIncludes: 'NEXT-STEP-BRIEF' }, turn: [{ text: `Made.\n${saveMarker('nextstep-made', 'By Doc')}` }] },
      { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' }, turn: [{ text: '<silent>' }] },
    ]);
    try {
      let since = await chat(convoId, 'chief-of-staff', 'NEXT-STEP-OWN make it');
      await refusal(convoId, 'Cos', 'save the agent "nextstep-made"', since);
      assert.strictEqual(fs.existsSync(agentPath('nextstep-made')), false, 'the orchestrator wrote nothing');
      since = client.messages.length;
      client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'NEXT-STEP-DOC ask Doc' });
      await client.waitFor((m) => m.type === 'agent_saved' && m.agentId === 'nextstep-made' && m.conversationId === convoId, { since, timeout: 5000, label: 'Doc\'s save' });
      await client.waitFor((m) => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m._agent === 'chief-of-staff' && m.autoContinue, { since, label: 'the orchestrator restored' });
      await h.delay(300);
      assert.strictEqual(readOrNull(agentPath('nextstep-made')), teamFile('nextstep-made', 'By Doc'), 'Doc\'s file, on disk');
      assert.strictEqual(linesFor(client.messages.slice(since), convoId).length, 1, 'one line: the save, once');
    } finally {
      h.reapConvo(convoId);
      unseed('nextstep-made');
    }
  });
});
