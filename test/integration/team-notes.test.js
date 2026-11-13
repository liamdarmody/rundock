'use strict';
// The next turn is told what Rundock did with the agent and skill markers in
// the last reply, and the line a person reads is kept with the conversation.
//
// THE DEFECT. The server decides each marker at the end of the turn that wrote
// it (lib/agents/team-markers.js), after the reply has finished, and nothing
// reached the agent's next turn. So an agent never learned whether its save
// worked: one whose save was refused told the person it was done. When Doc was
// brought in by an orchestrator, Doc was ended after its save and the
// orchestrator was handed back the conversation with no word of the outcome.
//
// WHAT IS ASSERTED, AND WHERE. On the exact prompt each stub runtime was sent,
// byte for byte, and on the conversation's stored history. Each turn runs on
// the stub Claude or Codex runtime against the real server.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');

let client;

before(async () => {
  await h.boot({
    agents: {
      ...standardTeam(),
      'researcher': agentFile({
        name: 'researcher', displayName: 'Ida', role: 'Researcher', description: 'Researches suppliers',
        type: 'specialist', order: 5, reportsTo: 'chief-of-staff', runtime: 'codex', body: 'You are Ida.',
      }),
    },
  });
  client = await h.connect();
});
after(async () => h.shutdown());

// The note, as the next turn reads it: the heading, one line per outcome, and
// a blank line before whatever the turn was going to be sent anyway.
const HEADING = 'WHAT RUNDOCK DID WITH THE LAST REPLY:';
const note = (...lines) => `${HEADING}\n${lines.join('\n')}\n\n`;
const refusedLine = (who, verb, kind, name, past) =>
  `- Refused: ${verb} ${kind} "${name}", asked by ${who}. ${who} asked to ${verb} the ${kind} "${name}", but only Doc can change the team, so nothing was ${past}. Ask Doc to make this change.`;

const agentPath = (name) => path.join(h.workspaceDir, '.claude', 'agents', `${name}.md`);
const skillPath = (name) => path.join(h.workspaceDir, '.claude', 'skills', name, 'SKILL.md');
function teamFile(name, label, type = 'specialist') {
  return agentFile({
    name, displayName: label, role: 'Example Role', description: 'An example agent',
    type, order: 30, reportsTo: 'chief-of-staff', body: `You are ${label}.`,
  }).trim();
}
const saveAgent = (name, body) => `<!-- RUNDOCK:SAVE_AGENT name=${name} -->\n${body}\n<!-- /RUNDOCK:SAVE_AGENT -->`;
const deleteAgent = (name) => `<!-- RUNDOCK:DELETE_AGENT name=${name} -->`;
const deleteSkill = (name) => `<!-- RUNDOCK:DELETE_SKILL name=${name} -->`;
function seedAgent(name, label) {
  fs.writeFileSync(agentPath(name), teamFile(name, label));
  h.internal.invalidateAgentCache();
}
function seedSkill(name) {
  fs.mkdirSync(path.dirname(skillPath(name)), { recursive: true });
  fs.writeFileSync(skillPath(name), `---\nname: ${name}\ndescription: An example skill.\n---\n\nDo the example.`);
}
function removeAgents(...names) {
  for (const name of names) fs.rmSync(agentPath(name), { force: true });
  h.internal.invalidateAgentCache();
}

// Every prompt a stub runtime was sent that carries `token`, in order, to one
// agent when it is named (an arriving agent is sent the conversation so far).
const promptsWith = (token, agent) => h.readPrompts().filter((p) => p.prompt.includes(token) && (!agent || p.agent === agent));
const onlyPrompt = (token, agent) => {
  const found = promptsWith(token, agent);
  assert.strictEqual(found.length, 1, `one prompt carries ${token} (got ${found.length})`);
  return found[0];
};

// One turn of a direct chat, run to its result.
async function chat(convoId, agent, content, extra = {}) {
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: convoId, agent, content, ...extra });
  const { msg } = await client.waitFor((m) => m.type === 'result' && m._conversationId === convoId,
    { since, timeout: 8000, label: `the reply to "${content}"` });
  return msg;
}
const livePid = (convoId) => {
  const entry = h.internal.chatProcesses.get(convoId);
  return entry && !entry.exited && entry.process ? entry.process.pid : null;
};
async function exited(convoId) {
  assert.ok(await h.waitUntil(() => { const e = h.internal.chatProcesses.get(convoId); return !e || e.exited; }),
    'the process ended after its turn');
}
async function sessionOf(convoId, since = 0) {
  const { msg } = await client.waitFor((m) => m.type === 'system' && m.subtype === 'init' && m._conversationId === convoId && m._sessionId,
    { since, label: 'the session it started' });
  return msg._sessionId;
}
// The lines the conversation's history keeps, in order.
const storedLines = (convoId) => (h.internal.convoTranscripts.get(convoId) || []).filter((t) => t.type === 'team').map((t) => t.text);

describe('the next turn is told, first, under Rundock\'s heading', () => {
  test('a live Claude Code process: its next message opens with the refusal, and the one after carries nothing', async () => {
    const convoId = h.freshConvoId('live');
    h.writeScenario([
      { match: { agent: 'content-lead', promptIncludes: 'LIVE-ONE' }, turn: [{ text: `I saved the helper.\n${saveAgent('live-helper', teamFile('live-helper', 'Helper'))}` }] },
      { match: { agent: 'content-lead', promptIncludes: 'LIVE-TWO' }, turn: [{ text: 'Second turn.' }] },
      { match: { agent: 'content-lead', promptIncludes: 'LIVE-THREE' }, turn: [{ text: 'Third turn.' }] },
    ]);
    try {
      await chat(convoId, 'content-lead', 'LIVE-ONE save the helper');
      const pid = livePid(convoId);
      assert.ok(pid, 'the process is still running after its turn');
      await chat(convoId, 'content-lead', 'LIVE-TWO did it work?');
      assert.strictEqual(livePid(convoId), pid, 'the second message went to the same live process');
      await chat(convoId, 'content-lead', 'LIVE-THREE and now?');
      assert.strictEqual(onlyPrompt('LIVE-TWO').prompt,
        note(refusedLine('Wren', 'save', 'agent', 'live-helper', 'saved')) + 'LIVE-TWO did it work?',
        'the refusal, then the person\'s message as sent');
      assert.strictEqual(onlyPrompt('LIVE-THREE').prompt, 'LIVE-THREE and now?', 'told once: the turn after carries no note');
      assert.strictEqual(fs.existsSync(agentPath('live-helper')), false, 'and nothing was written');
    } finally {
      h.reapConvo(convoId);
    }
  });

  test('a resumed Claude Code session: the message that resumes it opens with Doc\'s new agent', async () => {
    const convoId = h.freshConvoId('resumed');
    h.writeScenario([
      { match: { agent: 'rundock-guide', promptIncludes: 'RESUMED-ONE' }, exitAfterTurn: 0,
        turn: [{ text: `Made the helper.\n${saveAgent('resumed-helper', teamFile('resumed-helper', 'Helper'))}` }] },
      { match: { agent: 'rundock-guide', resume: true, promptIncludes: 'RESUMED-TWO' }, turn: [{ text: 'Back again.' }] },
    ]);
    try {
      const since = client.messages.length;
      await chat(convoId, 'rundock-guide', 'RESUMED-ONE make a helper');
      const sessionId = await sessionOf(convoId, since);
      await exited(convoId);
      await chat(convoId, 'rundock-guide', 'RESUMED-TWO is it there?', { sessionId });
      const two = onlyPrompt('RESUMED-TWO');
      assert.strictEqual(two.resume, sessionId, 'the second turn resumed the session');
      assert.strictEqual(two.prompt, note('- Saved (new): agent "resumed-helper", asked by Doc.') + 'RESUMED-TWO is it there?');
    } finally {
      h.reapConvo(convoId);
      removeAgents('resumed-helper');
    }
  });

  test('a resume Claude Code refuses: the turn started again in its place is told, once', async () => {
    const convoId = h.freshConvoId('deadresume');
    const rules = [
      { match: { agent: 'rundock-guide', promptIncludes: 'DEAD-ONE' }, exitAfterTurn: 0,
        turn: [{ text: `Made the helper.\n${saveAgent('dead-helper', teamFile('dead-helper', 'Helper'))}` }] },
      { match: { agent: 'rundock-guide', promptIncludes: 'DEAD-TWO' }, turn: [{ text: 'Started again.' }] },
    ];
    h.writeScenario(rules);
    try {
      const since = client.messages.length;
      await chat(convoId, 'rundock-guide', 'DEAD-ONE make a helper');
      const sessionId = await sessionOf(convoId, since);
      await exited(convoId);
      // Claude Code no longer has the session, so the resume is refused before
      // the process reads its message, and the server starts the turn again.
      h.writeScenario(rules, { deadSessions: [sessionId] });
      await chat(convoId, 'rundock-guide', 'DEAD-TWO is it there?', { sessionId });
      const told = promptsWith('DEAD-TWO', 'rundock-guide');
      assert.strictEqual(told.length, 1, 'one prompt reached a process that read it');
      assert.strictEqual(told[0].resume, null, 'the one started again, fresh');
      assert.ok(told[0].prompt.startsWith(note('- Saved (new): agent "dead-helper", asked by Doc.')),
        `and it opens with the note (got ${JSON.stringify(told[0].prompt.slice(0, 200))})`);
      assert.ok(told[0].prompt.endsWith('DEAD-TWO is it there?'));
    } finally {
      h.reapConvo(convoId);
      removeAgents('dead-helper');
    }
  });

  test('a Codex chat: the next turn opens with the refusal, and the one after carries nothing', async () => {
    const convoId = h.freshConvoId('codex');
    seedAgent('codex-kept', 'Kept');
    h.writeCodexScenario([
      { match: { promptIncludes: 'CODEX-ONE' }, text: `Removed it.\n${deleteAgent('codex-kept')}` },
      { match: { promptIncludes: 'CODEX-TWO' }, text: 'Second.' },
      { match: { promptIncludes: 'CODEX-THREE' }, text: 'Third.' },
    ]);
    try {
      const since = client.messages.length;
      await chat(convoId, 'researcher', 'CODEX-ONE remove it');
      const threadId = await sessionOf(convoId, since);
      await chat(convoId, 'researcher', 'CODEX-TWO is it gone?', { sessionId: threadId });
      await chat(convoId, 'researcher', 'CODEX-THREE and now?', { sessionId: threadId });
      const prompts = h.codexTurnPrompts();
      assert.deepStrictEqual(prompts.filter((p) => p.includes('CODEX-TWO')),
        [note(refusedLine('Ida', 'delete', 'agent', 'codex-kept', 'deleted')) + 'CODEX-TWO is it gone?']);
      assert.deepStrictEqual(prompts.filter((p) => p.includes('CODEX-THREE')), ['CODEX-THREE and now?']);
      assert.ok(fs.existsSync(agentPath('codex-kept')), 'and nothing was deleted');
    } finally {
      h.reapConvo(convoId);
      removeAgents('codex-kept');
    }
  });

  test('a turn with no agent or skill markers adds nothing: the next prompt is the person\'s message, byte for byte', async () => {
    const convoId = h.freshConvoId('plain');
    h.writeScenario([
      { match: { agent: 'content-lead', promptIncludes: 'PLAIN-ONE' }, turn: [{ text: 'Just words, and an agent file shown as text:\n---\nname: shown\ntype: specialist\n---' }] },
      { match: { agent: 'content-lead', promptIncludes: 'PLAIN-TWO' }, turn: [{ text: 'Still words.' }] },
    ]);
    try {
      await chat(convoId, 'content-lead', 'PLAIN-ONE say something');
      await chat(convoId, 'content-lead', 'PLAIN-TWO and again');
      assert.strictEqual(onlyPrompt('PLAIN-ONE').prompt, 'PLAIN-ONE say something');
      assert.strictEqual(onlyPrompt('PLAIN-TWO').prompt, 'PLAIN-TWO and again');
      assert.deepStrictEqual(storedLines(convoId), [], 'and no line is stored');
    } finally {
      h.reapConvo(convoId);
    }
  });
});

describe('each outcome says what happened, and a refusal or a failure says why', () => {
  test('saved over an existing agent, and a deleted skill', async () => {
    const convoId = h.freshConvoId('updated');
    seedAgent('kinds-agent', 'Before');
    seedSkill('kinds-skill');
    h.writeScenario([
      { match: { agent: 'rundock-guide', promptIncludes: 'KINDS-ONE' },
        turn: [{ text: `Done.\n${saveAgent('kinds-agent', teamFile('kinds-agent', 'After'))}\n${deleteSkill('kinds-skill')}` }] },
      { match: { agent: 'rundock-guide', promptIncludes: 'KINDS-TWO' }, turn: [{ text: 'Checked.' }] },
    ]);
    try {
      await chat(convoId, 'rundock-guide', 'KINDS-ONE update and remove');
      await chat(convoId, 'rundock-guide', 'KINDS-TWO all good?');
      assert.strictEqual(onlyPrompt('KINDS-TWO').prompt, note(
        '- Saved (updated): agent "kinds-agent", asked by Doc.',
        '- Deleted: skill "kinds-skill", asked by Doc.',
      ) + 'KINDS-TWO all good?');
    } finally {
      h.reapConvo(convoId);
      removeAgents('kinds-agent');
    }
  });

  test('a save the handler could not do carries the handler\'s own message', async () => {
    const convoId = h.freshConvoId('failed');
    h.writeScenario([
      { match: { agent: 'rundock-guide', promptIncludes: 'FAILED-ONE' },
        turn: [{ text: `Saved.\n${saveAgent('Bad_Name', teamFile('bad-name', 'Bad'))}` }] },
      { match: { agent: 'rundock-guide', promptIncludes: 'FAILED-TWO' }, turn: [{ text: 'Checked.' }] },
    ]);
    try {
      await chat(convoId, 'rundock-guide', 'FAILED-ONE save it');
      await chat(convoId, 'rundock-guide', 'FAILED-TWO did it save?');
      assert.strictEqual(onlyPrompt('FAILED-TWO').prompt, note(
        '- Failed: save agent "Bad_Name", asked by Doc. Invalid agent name. Use lowercase letters, numbers, and hyphens only.',
      ) + 'FAILED-TWO did it save?');
      assert.strictEqual(fs.existsSync(agentPath('Bad_Name')), false);
    } finally {
      h.reapConvo(convoId);
    }
  });
});

describe('the orchestrator taking the conversation back after Doc\'s change is told the truth', () => {
  // Doc brought in by the orchestrator's Agent call. Doc is ended shortly after
  // a marker and the orchestrator is resumed with the hand-back; the note
  // opens that hand-back.
  function docDelegation(token, docReply) {
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: `${token}-ASK` },
        turn: [{ agentTool: { subagent_type: 'rundock-guide', prompt: `${token}-BRIEF change the team` } }] },
      { match: { agent: 'rundock-guide', promptIncludes: `${token}-BRIEF` }, turn: [{ text: docReply }] },
      { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' }, turn: [{ text: '<silent>' }] },
    ]);
  }
  async function handBack(token) {
    assert.ok(await h.waitUntil(() => h.readPrompts().some((p) => p.agent === 'chief-of-staff' && p.prompt.includes('[SYSTEM: pipeline-complete]') && p.prompt.includes(`${token}-DONE`))),
      'the orchestrator was resumed with the hand-back');
    return h.readPrompts().filter((p) => p.agent === 'chief-of-staff' && p.prompt.includes(`${token}-DONE`)).map((p) => p.prompt);
  }

  test('Doc\'s save worked: the orchestrator is told it was saved', async () => {
    const convoId = h.freshConvoId('hbok');
    docDelegation('HBOK', `HBOK-DONE made it.\n${saveAgent('handback-helper', teamFile('handback-helper', 'Helper'))}`);
    try {
      client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'HBOK-ASK get Doc to add a helper' });
      const [prompt, ...more] = await handBack('HBOK');
      assert.deepStrictEqual(more, [], 'one hand-back');
      assert.ok(prompt.startsWith(note('- Saved (new): agent "handback-helper", asked by Doc.')),
        `the hand-back opens with the outcome (got ${JSON.stringify(prompt.slice(0, 200))})`);
      assert.ok(prompt.includes('[SYSTEM: pipeline-complete]'), 'and is still the hand-back');
      assert.ok(fs.existsSync(agentPath('handback-helper')));
      const doc = onlyPrompt('HBOK-BRIEF');
      assert.ok(!doc.prompt.includes(HEADING), 'Doc\'s own brief carried no note');
    } finally {
      h.reapConvo(convoId);
      removeAgents('handback-helper');
    }
  });

  test('Doc\'s save was refused and another failed: the orchestrator is told so, never that it was saved, and the conversation keeps both lines', async () => {
    const convoId = h.freshConvoId('hbno');
    docDelegation('HBNO', `HBNO-DONE saved both.\n${saveAgent('fake-guide', teamFile('fake-guide', 'Fake', 'platform'))}\n${saveAgent('Bad_Name', teamFile('bad-name', 'Bad'))}`);
    try {
      const since = client.messages.length;
      client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'HBNO-ASK get Doc to add two' });
      const [prompt] = await handBack('HBNO');
      const refusal = 'Doc asked to save the agent "fake-guide", but Doc\'s own file and platform agents cannot be changed from a reply, so nothing was saved.';
      const failure = 'Invalid agent name. Use lowercase letters, numbers, and hyphens only.';
      assert.ok(prompt.startsWith(note(
        `- Refused: save agent "fake-guide", asked by Doc. ${refusal}`,
        `- Failed: save agent "Bad_Name", asked by Doc. ${failure}`,
      )), `the hand-back opens with both outcomes (got ${JSON.stringify(prompt.slice(0, 400))})`);
      assert.ok(!/^- Saved/m.test(prompt), 'and nothing in it says saved');
      assert.deepStrictEqual(storedLines(convoId), [refusal, failure], 'the conversation keeps the refusal and the failure');
      await client.waitFor((m) => m.type === 'agent_error' && m.conversationId === convoId && m.refused === true, { since, label: 'the refusal shown' });
      assert.strictEqual(fs.existsSync(agentPath('fake-guide')), false);
    } finally {
      h.reapConvo(convoId);
    }
  });
});

describe('the sequences a person runs', () => {
  test('the inverse action: Doc\'s delete is told as deleted, a specialist\'s as refused', async () => {
    const docConvo = h.freshConvoId('invdoc');
    const specConvo = h.freshConvoId('invspec');
    seedAgent('inverse-doc', 'Doc target');
    seedAgent('inverse-spec', 'Spec target');
    h.writeScenario([
      { match: { agent: 'rundock-guide', promptIncludes: 'INV-DOC-ONE' }, turn: [{ text: `Removed.\n${deleteAgent('inverse-doc')}` }] },
      { match: { agent: 'rundock-guide', promptIncludes: 'INV-DOC-TWO' }, turn: [{ text: 'Checked.' }] },
      { match: { agent: 'content-lead', promptIncludes: 'INV-SPEC-ONE' }, turn: [{ text: `Removed.\n${deleteAgent('inverse-spec')}` }] },
      { match: { agent: 'content-lead', promptIncludes: 'INV-SPEC-TWO' }, turn: [{ text: 'Checked.' }] },
    ]);
    try {
      await chat(docConvo, 'rundock-guide', 'INV-DOC-ONE remove it');
      await chat(docConvo, 'rundock-guide', 'INV-DOC-TWO gone?');
      await chat(specConvo, 'content-lead', 'INV-SPEC-ONE remove it');
      await chat(specConvo, 'content-lead', 'INV-SPEC-TWO gone?');
      assert.strictEqual(onlyPrompt('INV-DOC-TWO').prompt, note('- Deleted: agent "inverse-doc", asked by Doc.') + 'INV-DOC-TWO gone?');
      assert.strictEqual(onlyPrompt('INV-SPEC-TWO').prompt, note(refusedLine('Wren', 'delete', 'agent', 'inverse-spec', 'deleted')) + 'INV-SPEC-TWO gone?');
      assert.strictEqual(fs.existsSync(agentPath('inverse-doc')), false);
      assert.ok(fs.existsSync(agentPath('inverse-spec')));
    } finally {
      h.reapConvo(docConvo);
      h.reapConvo(specConvo);
      removeAgents('inverse-doc', 'inverse-spec');
    }
  });

  test('the undo: Doc saves an agent, then deletes it, and each next turn is told its own outcome once', async () => {
    const convoId = h.freshConvoId('undo');
    h.writeScenario([
      { match: { agent: 'rundock-guide', promptIncludes: 'UNDO-ONE' }, turn: [{ text: `Made it.\n${saveAgent('undo-helper', teamFile('undo-helper', 'Helper'))}` }] },
      { match: { agent: 'rundock-guide', promptIncludes: 'UNDO-TWO' }, turn: [{ text: `Removed it.\n${deleteAgent('undo-helper')}` }] },
      { match: { agent: 'rundock-guide', promptIncludes: 'UNDO-THREE' }, turn: [{ text: 'Checked.' }] },
      { match: { agent: 'rundock-guide', promptIncludes: 'UNDO-FOUR' }, turn: [{ text: 'Nothing new.' }] },
    ]);
    try {
      await chat(convoId, 'rundock-guide', 'UNDO-ONE make it');
      await chat(convoId, 'rundock-guide', 'UNDO-TWO now remove it');
      await chat(convoId, 'rundock-guide', 'UNDO-THREE gone?');
      await chat(convoId, 'rundock-guide', 'UNDO-FOUR anything else?');
      assert.strictEqual(onlyPrompt('UNDO-TWO').prompt, note('- Saved (new): agent "undo-helper", asked by Doc.') + 'UNDO-TWO now remove it');
      assert.strictEqual(onlyPrompt('UNDO-THREE').prompt, note('- Deleted: agent "undo-helper", asked by Doc.') + 'UNDO-THREE gone?');
      assert.strictEqual(onlyPrompt('UNDO-FOUR').prompt, 'UNDO-FOUR anything else?');
      assert.deepStrictEqual(storedLines(convoId), ['Agent "undo-helper" created', 'Agent "undo-helper" removed']);
    } finally {
      h.reapConvo(convoId);
      removeAgents('undo-helper');
    }
  });

  test('the retry: a specialist refused in two turns gives two notes, one per following turn, and two stored lines', async () => {
    const convoId = h.freshConvoId('retry');
    const marker = saveAgent('retry-helper', teamFile('retry-helper', 'Helper'));
    h.writeScenario([
      { match: { agent: 'content-lead', promptIncludes: 'RETRY-ONE' }, turn: [{ text: `Saved.\n${marker}` }] },
      { match: { agent: 'content-lead', promptIncludes: 'RETRY-TWO' }, turn: [{ text: `Trying again.\n${marker}` }] },
      { match: { agent: 'content-lead', promptIncludes: 'RETRY-THREE' }, turn: [{ text: 'I will ask Doc.' }] },
      { match: { agent: 'content-lead', promptIncludes: 'RETRY-FOUR' }, turn: [{ text: 'Nothing new.' }] },
    ]);
    try {
      for (const step of ['RETRY-ONE save it', 'RETRY-TWO try again', 'RETRY-THREE well?', 'RETRY-FOUR anything else?']) {
        await chat(convoId, 'content-lead', step);
      }
      const refused = note(refusedLine('Wren', 'save', 'agent', 'retry-helper', 'saved'));
      assert.strictEqual(onlyPrompt('RETRY-TWO').prompt, `${refused}RETRY-TWO try again`);
      assert.strictEqual(onlyPrompt('RETRY-THREE').prompt, `${refused}RETRY-THREE well?`);
      assert.strictEqual(onlyPrompt('RETRY-FOUR').prompt, 'RETRY-FOUR anything else?');
      const line = 'Wren asked to save the agent "retry-helper", but only Doc can change the team, so nothing was saved. Ask Doc to make this change.';
      assert.deepStrictEqual(storedLines(convoId), [line, line]);
    } finally {
      h.reapConvo(convoId);
    }
  });

  test('the most common next step: after a refusal, the orchestrator brings in Doc, Doc saves, and the orchestrator is told it was saved', async () => {
    const convoId = h.freshConvoId('next');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'NEXT-ONE' }, turn: [{ text: `Saved it myself.\n${saveAgent('next-helper', teamFile('next-helper', 'Helper'))}` }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'NEXT-TWO' },
        turn: [{ agentTool: { subagent_type: 'rundock-guide', prompt: 'NEXT-BRIEF save the helper' } }] },
      { match: { agent: 'rundock-guide', promptIncludes: 'NEXT-BRIEF' }, turn: [{ text: `NEXT-DONE made it.\n${saveAgent('next-helper', teamFile('next-helper', 'Helper'))}` }] },
      { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' }, turn: [{ text: '<silent>' }] },
    ]);
    try {
      await chat(convoId, 'chief-of-staff', 'NEXT-ONE save a helper');
      client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'NEXT-TWO ask Doc then' });
      assert.ok(await h.waitUntil(() => h.readPrompts().some((p) => p.agent === 'chief-of-staff' && p.prompt.includes('NEXT-DONE'))),
        'the orchestrator was handed the conversation back');
      assert.strictEqual(onlyPrompt('NEXT-TWO', 'chief-of-staff').prompt,
        note(refusedLine('Cos', 'save', 'agent', 'next-helper', 'saved')) + 'NEXT-TWO ask Doc then', 'the refusal reached the orchestrator first');
      assert.ok(!onlyPrompt('NEXT-BRIEF').prompt.includes(HEADING), 'Doc\'s brief carried no note: the refusal was already told');
      const back = onlyPrompt('NEXT-DONE').prompt;
      assert.ok(back.startsWith(note('- Saved (new): agent "next-helper", asked by Doc.')),
        `the hand-back says it was saved (got ${JSON.stringify(back.slice(0, 200))})`);
      assert.ok(fs.existsSync(agentPath('next-helper')));
    } finally {
      h.reapConvo(convoId);
      removeAgents('next-helper');
    }
  });
});

describe('the line a person reads is kept with the conversation', () => {
  test('stored once with two windows open, after the reply that asked, and given back by the history', async () => {
    const convoId = h.freshConvoId('kept');
    const second = await h.connect();
    h.writeScenario([
      { match: { agent: 'rundock-guide', promptIncludes: 'KEPT-ONE' }, turn: [{ text: `KEPT-REPLY made it.\n${saveAgent('kept-helper', teamFile('kept-helper', 'Helper'))}` }] },
    ]);
    try {
      const since = second.messages.length;
      await chat(convoId, 'rundock-guide', 'KEPT-ONE make a helper');
      await second.waitFor((m) => m.type === 'agent_saved' && m.conversationId === convoId, { since, label: 'the second window told too' });
      assert.ok(h.internal.connectedClients.size >= 2, 'two windows are open');
      const transcript = h.internal.convoTranscripts.get(convoId);
      assert.deepStrictEqual(transcript.map((t) => [t.role, t.type || null]), [['user', null], ['agent', null], ['system', 'team']],
        'the person\'s message, the reply, then one line for the one outcome');
      assert.strictEqual(transcript[2].text, 'Agent "kept-helper" created');

      const asked = second.messages.length;
      second.send({ type: 'get_session_history', conversationId: convoId, sessionIds: [], limit: 200 });
      const { msg: history } = await second.waitFor((m) => m.type === 'session_history' && m.conversationId === convoId, { since: asked, label: 'the history' });
      assert.deepStrictEqual(history.messages.map((m) => [m.role, m.content.split('\n')[0]]), [
        ['user', 'KEPT-ONE make a helper'],
        ['assistant', 'KEPT-REPLY made it.'],
        ['system', 'Agent "kept-helper" created'],
      ]);
    } finally {
      second.close();
      h.reapConvo(convoId);
      removeAgents('kept-helper');
    }
  });
});
