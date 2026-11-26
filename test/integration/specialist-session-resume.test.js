'use strict';
// Each agent resumes only its own session, or starts a new one.
//
// THE DEFECT. A conversation stores one primary session, the one the window
// resumes for the conversation's own agent, beside a chain of every agent's
// sessions. Once the lead's own session had been forgotten, the next init to
// arrive became the primary, whichever agent it came from. A teammate's init
// arriving first made the teammate's session the lead's, and the next message
// to the lead resumed it: the teammate's work carried on under the lead's
// name, and when the teammate was Doc, its changes to the team were refused,
// since the server records that process as the lead.
//
// WHAT IS ASSERTED, AND WHERE. On the chat message a window built from the
// real reducer and the real resume rules sends, on the invocations the stub
// runtimes log, and, for a chat message sent raw, on the server's own reading
// of the stored record: a record left by the defect is still on disk after an
// upgrade, and a window from before it still sends what it stored.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');
const { createState, reduce, forgetSession, resumeSessionFor } = require('../../public/conversation-state.js');
const { startingFresh } = require('../../lib/runtime/missing-session.js');

const LEAD = 'chief-of-staff';
const DOC = 'rundock-guide';

let client;
before(async () => {
  await h.boot({
    agents: {
      ...standardTeam(),
      // The workspace's first agent: discovery gives it the id "default", so
      // the slug a message names and the id it resolves to differ.
      'example-lead': agentFile({ name: 'example-lead', displayName: 'Ash', type: 'specialist', order: 0 }),
      researcher: agentFile({
        name: 'researcher', displayName: 'Ida', role: 'Researcher', description: 'Researches suppliers',
        type: 'specialist', order: 5, reportsTo: LEAD, runtime: 'codex', body: 'You are Ida, the researcher.\n\nYou research suppliers.',
      }),
      summariser: agentFile({
        name: 'summariser', displayName: 'Sam', role: 'Summariser', description: 'Summarises documents',
        type: 'specialist', order: 6, reportsTo: LEAD, runtime: 'codex', model: 'gpt-5.3-codex', body: 'You are Sam, the summariser.',
      }),
    },
  });
  client = await h.connect();
});
after(h.shutdown);

/** The record the defect left: the conversation's primary is a session the chain lists only under Doc. */
function takenOver(agentId = LEAD, sessionId = 'sess-doc') {
  return { agentId, sessionId, sessionIds: [{ sessionId, agentId: DOC }] };
}

/** The stub's script, with the sessions Claude Code no longer has. */
function scenario(rules, deadSessions = []) {
  fs.writeFileSync(path.join(h.workspaceDir, 'stub-scenario.json'), JSON.stringify({ rules, deadSessions }, null, 2));
}

function stored(convoId) {
  return h.internal.readConversations().find(c => c.id === convoId) || null;
}

function seed(convoId, record) {
  const all = h.internal.readConversations().filter(c => c.id !== convoId);
  h.internal.writeConversations([{ id: convoId, title: convoId, status: 'active', ...record }, ...all]);
  return stored(convoId);
}

function spawnsFor(convoId) {
  return h.readInvocations().filter(i => i.env && i.env.RUNDOCK_CONVO_ID === convoId);
}

function messagesFor(convoId, since = 0) {
  return client.messages.slice(since).filter(m => m._conversationId === convoId);
}

function nameOf(agentId) {
  const a = h.internal.discoverAgents().find(x => x.id === agentId);
  return (a && (a.displayName || a.name)) || agentId;
}

/** The first result for the conversation since `since`, or the first holding `text`. */
async function resultFor(convoId, since, text = null) {
  const { msg } = await client.waitFor(m => m.type === 'result' && m._conversationId === convoId
    && (text === null || String(m.result || '').includes(text)), { since, label: `the result${text ? ` ${text}` : ''}`, timeout: 15000 });
  return msg;
}

/** Which agent the server announced the turn's process as. */
function startedAs(convoId, since) {
  const started = messagesFor(convoId, since).find(m => m.type === 'system' && m.subtype === 'process_started');
  return started ? started._agent : null;
}

/** Wait until the server has read every save sent so far: the socket is ordered. */
async function settled() {
  const since = client.messages.length;
  client.send({ type: 'get_lists' });
  await client.waitFor(m => m.type === 'lists', { since, label: 'saves read' });
}

/**
 * What the open window holds for one conversation, driven by the real reducer
 * and the real stored-session rules. The two effect executors mirror
 * public/app.js; each ends in the save the window sends.
 */
function windowFor(record) {
  const convo = JSON.parse(JSON.stringify(record));
  let state = Object.assign(createState(), { activeAgentId: record.activeAgentId || null });
  let seen = 0;
  const save = () => client.send({ type: 'save_conversation', conversation: {
    id: convo.id, agentId: convo.agentId, activeAgentId: state.activeAgentId || null,
    sessionId: convo.sessionId || null, sessionIds: convo.sessionIds || [], title: convo.title, status: 'active',
  } });
  const ctxFor = (m) => (m.subtype === 'init'
    ? { convoExists: true, convoAgentId: convo.agentId, hasPrimarySession: !!convo.sessionId,
      knownSessionIds: (convo.sessionIds || []).map(s => s.sessionId) }
    : { hasPrimarySession: !!convo.sessionId, convoAgentId: convo.agentId, toAgentExists: true, toAgentType: 'specialist', fromAgentExists: true });
  const run = (effects) => {
    for (const ef of effects) {
      if (ef.type === 'set-session') {
        if (ef.setPrimary) convo.sessionId = ef.sessionId;
        if (!convo.sessionIds) convo.sessionIds = [];
        if (ef.addToChain) convo.sessionIds.push({ sessionId: ef.sessionId, agentId: ef.agentId });
        save();
      } else if (ef.type === 'forget-session') {
        if (forgetSession(convo, ef.sessionId)) save();
      }
    }
  };
  return {
    convo,
    get activeAgentId() { return state.activeAgentId || convo.agentId; },
    sync(until = client.messages.length) {
      for (; seen < until; seen++) {
        const m = client.messages[seen];
        if (m._conversationId !== convo.id || m.type !== 'system') continue;
        if (!['init', 'info', 'session_expired', 'agent_switch'].includes(m.subtype)) continue;
        if (m.subtype === 'init' && !m._sessionId) continue;
        const r = reduce(state, m, ctxFor(m));
        state = r.state;
        run(r.effects);
      }
    },
    /** A message the person sends, resumed exactly as the window would resume it. */
    send(content) {
      this.sync();
      const agent = this.activeAgentId;
      const sessionId = resumeSessionFor(convo, agent);
      client.send({ type: 'chat', conversationId: convo.id, agent, content, ...(sessionId ? { sessionId } : {}) });
      return { agent, sessionId };
    },
  };
}

/** The turn has ended with nothing forgotten: the session is still stored, under the agent it belongs to. */
async function assertKept(convoId, since, sessionId, owner) {
  await client.waitForEvent('system', 'done', convoId, { since, timeout: 15000 });
  await settled();
  const mine = messagesFor(convoId, since);
  assert.deepStrictEqual(mine.filter(m => m.subtype === 'session_expired').map(m => m.sessionId), [],
    'no window is told to forget a session');
  assert.deepStrictEqual(mine.filter(m => m.expiredSessionId).map(m => m.expiredSessionId), [],
    'and no line names one as expired');
  const chain = (stored(convoId) || {}).sessionIds || [];
  assert.ok(chain.some(s => s.sessionId === sessionId && s.agentId === owner),
    'the chain still lists the session under the agent it belongs to');
}

describe('the window, on a record whose primary is a teammate\'s session', () => {
  test('a message to the conversation\'s agent starts it fresh, and the next resumes the session that start reported', async () => {
    const convoId = h.freshConvoId('own-fresh');
    const record = seed(convoId, takenOver());
    scenario([
      { match: { resume: false, promptIncludes: 'ASK-OF' }, turn: [{ text: 'FRESH-OF' }] },
      { match: { resume: true, promptIncludes: 'AGAIN-OF' }, turn: [{ text: 'RESUMED-OF' }] },
    ]);
    h.clearInvocations();
    const win = windowFor(record);
    let since = client.messages.length;
    assert.deepStrictEqual(win.send('ASK-OF hello'), { agent: LEAD, sessionId: null },
      'the window sends the lead\'s message with no session');
    assert.strictEqual((await resultFor(convoId, since)).result, 'FRESH-OF');
    const first = spawnsFor(convoId);
    assert.deepStrictEqual(first.map(i => [i.agent, i.resume]), [[LEAD, null]], 'the lead is started fresh, as itself');
    assert.strictEqual(startedAs(convoId, since), LEAD, 'and announced as the lead');

    win.sync();
    await settled();
    const init = messagesFor(convoId, since).find(m => m.subtype === 'init' && m._sessionId);
    assert.strictEqual(win.convo.sessionId, init._sessionId, 'the session that start reported becomes the primary');
    h.reapConvo(convoId);

    since = client.messages.length;
    assert.deepStrictEqual(win.send('AGAIN-OF carry on'), { agent: LEAD, sessionId: init._sessionId },
      'the next message carries the session the fresh start reported');
    assert.strictEqual((await resultFor(convoId, since)).result, 'RESUMED-OF');
    assert.deepStrictEqual(spawnsFor(convoId).map(i => i.resume), [null, init._sessionId], 'and it is resumed');
    h.reapConvo(convoId);
  });

  test('a message to the teammate whose session it is resumes that session', async () => {
    const convoId = h.freshConvoId('own-doc');
    const record = seed(convoId, { ...takenOver(), activeAgentId: DOC });
    scenario([{ match: { resume: true, promptIncludes: 'ASK-OD' }, turn: [{ text: 'RESUMED-OD' }] }]);
    h.clearInvocations();
    const win = windowFor(record);
    const since = client.messages.length;
    assert.deepStrictEqual(win.send('ASK-OD hello'), { agent: DOC, sessionId: 'sess-doc' });
    assert.strictEqual((await resultFor(convoId, since)).result, 'RESUMED-OD');
    assert.deepStrictEqual(spawnsFor(convoId).map(i => i.resume), ['sess-doc'], 'Doc resumes its own session');
    assert.strictEqual(startedAs(convoId, since), DOC, 'announced as Doc');
    h.reapConvo(convoId);
  });
});

describe('the server, given a session the chain lists only under another agent', () => {
  test('on the chat path, the agent starts fresh as itself and nothing is forgotten', async () => {
    const convoId = h.freshConvoId('raw-chat');
    seed(convoId, takenOver());
    scenario([{ match: { promptIncludes: 'ASK-RC' }, turn: [{ text: 'FRESH-RC' }] }]);
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: LEAD, content: 'ASK-RC hello', sessionId: 'sess-doc' });
    await resultFor(convoId, since);
    assert.deepStrictEqual(spawnsFor(convoId).map(i => [i.agent, i.resume]), [[LEAD, null]], 'started fresh, as the lead');
    await assertKept(convoId, since, 'sess-doc', DOC);
    h.reapConvo(convoId);
  });

  test('on the legacy path, the agent starts fresh as itself and nothing is forgotten', async () => {
    const convoId = h.freshConvoId('raw-legacy');
    seed(convoId, takenOver());
    scenario([{ match: { promptIncludes: 'ASK-RL' }, turn: [{ text: 'FRESH-RL' }] }]);
    h.clearInvocations();
    process.env.RUNDOCK_LEGACY_SPAWN = '1';
    try {
      const since = client.messages.length;
      client.send({ type: 'chat', conversationId: convoId, agent: LEAD, content: 'ASK-RL hello', sessionId: 'sess-doc' });
      await resultFor(convoId, since);
      assert.deepStrictEqual(spawnsFor(convoId).map(i => [i.agent, i.resume]), [[LEAD, null]], 'started fresh, as the lead');
      await assertKept(convoId, since, 'sess-doc', DOC);
    } finally {
      delete process.env.RUNDOCK_LEGACY_SPAWN;
    }
    h.reapConvo(convoId);
  });

  test('on Codex, the other agent\'s thread is not resumed, a new one is started, and nothing is forgotten', async () => {
    const convoId = h.freshConvoId('raw-codex');
    const thread = '0199f0a1-2b3c-7d4e-8f90-1a2b3c4d5e6f';
    seed(convoId, { agentId: 'researcher', sessionId: thread, sessionIds: [{ sessionId: thread, agentId: 'summariser' }] });
    h.writeCodexScenario([{ match: { promptIncludes: 'ASK-RX' }, text: 'FRESH-RX' }]);
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'ASK-RX hello', sessionId: thread });
    await resultFor(convoId, since);
    const appServer = h.readInvocations().filter(i => i.mode === 'app-server');
    assert.deepStrictEqual(appServer.filter(i => i.method === 'thread/resume' && i.params && i.params.threadId === thread), [],
      'the other agent\'s thread is not resumed');
    assert.ok(appServer.some(i => i.method === 'thread/start'), 'a new thread is started');
    await assertKept(convoId, since, thread, 'summariser');
    h.reapConvo(convoId);
  });

  test('named by a slug that resolves to another id, a session listed only under a teammate is not resumed', async () => {
    const convoId = h.freshConvoId('raw-slug');
    seed(convoId, { agentId: 'example-lead', sessionId: 'sess-rs', sessionIds: [{ sessionId: 'sess-rs', agentId: LEAD }] });
    scenario([{ match: { promptIncludes: 'ASK-RS' }, turn: [{ text: 'FRESH-RS' }] }]);
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'example-lead', content: 'ASK-RS hello', sessionId: 'sess-rs' });
    await resultFor(convoId, since);
    assert.deepStrictEqual(spawnsFor(convoId).map(i => [i.agent, i.resume]), [['example-lead', null]], 'started fresh, as itself');
    await assertKept(convoId, since, 'sess-rs', LEAD);
    h.reapConvo(convoId);
  });

  test('a session listed only under the slug of an agent whose id differs is not resumed for a teammate', async () => {
    const convoId = h.freshConvoId('raw-mate');
    seed(convoId, { agentId: LEAD, sessionId: 'sess-rm', sessionIds: [{ sessionId: 'sess-rm', agentId: 'example-lead' }] });
    scenario([{ match: { promptIncludes: 'ASK-RM' }, turn: [{ text: 'FRESH-RM' }] }]);
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: LEAD, content: 'ASK-RM hello', sessionId: 'sess-rm' });
    await resultFor(convoId, since);
    assert.deepStrictEqual(spawnsFor(convoId).map(i => [i.agent, i.resume]), [[LEAD, null]], 'started fresh, as the lead');
    await assertKept(convoId, since, 'sess-rm', 'example-lead');
    h.reapConvo(convoId);
  });
});

describe('the server, given a session it cannot tell is another agent\'s, resumes it as before', () => {
  /** A chat message sent raw, naming a session; what the runtime was started to resume. */
  async function sent(tag, record, chat, deadSessions = []) {
    const convoId = h.freshConvoId(`kept-${tag}`);
    if (record) seed(convoId, record);
    scenario([{ match: { promptIncludes: `ASK-${tag}` }, turn: [{ text: `REPLY-${tag}` }] }], deadSessions);
    h.clearInvocations();
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, content: `ASK-${tag} hello`, ...chat });
    await resultFor(convoId, since, `REPLY-${tag}`);
    const resumes = spawnsFor(convoId).map(i => i.resume);
    const info = messagesFor(convoId, since).find(m => m.subtype === 'info');
    h.reapConvo(convoId);
    return { resumes, info };
  }

  test('a session the chain lists under the agent itself', async () => {
    const r = await sent('k1', { agentId: LEAD, sessionId: 'sess-k1', sessionIds: [{ sessionId: 'sess-doc', agentId: DOC }, { sessionId: 'sess-k1', agentId: LEAD }] },
      { agent: LEAD, sessionId: 'sess-k1' });
    assert.deepStrictEqual(r.resumes, ['sess-k1']);
  });

  test('a session the chain does not list', async () => {
    const r = await sent('k2', { agentId: LEAD, sessionId: 'sess-k2', sessionIds: [{ sessionId: 'sess-doc', agentId: DOC }] },
      { agent: LEAD, sessionId: 'sess-k2' });
    assert.deepStrictEqual(r.resumes, ['sess-k2']);
  });

  test('a conversation with no stored record', async () => {
    const r = await sent('k3', null, { agent: LEAD, sessionId: 'sess-k3' });
    assert.deepStrictEqual(r.resumes, ['sess-k3']);
  });

  test('a session listed under an entry that names no agent', async () => {
    const r = await sent('k4', { agentId: LEAD, sessionId: 'sess-k4', sessionIds: [{ sessionId: 'sess-k4' }] },
      { agent: LEAD, sessionId: 'sess-k4' });
    assert.deepStrictEqual(r.resumes, ['sess-k4']);
  });

  test('a slug that resolves to another id, the session listed under that id', async () => {
    const r = await sent('k5', { agentId: 'default', sessionId: 'sess-k5', sessionIds: [{ sessionId: 'sess-k5', agentId: 'default' }] },
      { agent: 'example-lead', sessionId: 'sess-k5' });
    assert.deepStrictEqual(r.resumes, ['sess-k5']);
  });

  test('a slug that resolves to another id, the session listed under that slug', async () => {
    const r = await sent('k8', { agentId: 'example-lead', sessionId: 'sess-k8', sessionIds: [{ sessionId: 'sess-k8', agentId: 'example-lead' }] },
      { agent: 'example-lead', sessionId: 'sess-k8' });
    assert.deepStrictEqual(r.resumes, ['sess-k8']);
  });

  test('the id a slug resolves to, the session listed under that slug', async () => {
    const r = await sent('k9', { agentId: 'default', sessionId: 'sess-k9', sessionIds: [{ sessionId: 'sess-k9', agentId: 'example-lead' }] },
      { agent: 'default', sessionId: 'sess-k9' });
    assert.deepStrictEqual(r.resumes, ['sess-k9']);
  });

  test('an agent no longer on the team, the session listed under its name', async () => {
    const r = await sent('k6', { agentId: 'departed-agent', sessionId: 'sess-k6', sessionIds: [{ sessionId: 'sess-k6', agentId: 'departed-agent' }] },
      { agent: 'departed-agent', sessionId: 'sess-k6' });
    assert.deepStrictEqual(r.resumes, ['sess-k6']);
  });

  test('a session under the agent\'s own id that Claude Code no longer has is tried once, then the agent starts fresh', async () => {
    const r = await sent('k7', { agentId: LEAD, sessionId: 'dead-k7', sessionIds: [{ sessionId: 'dead-k7', agentId: LEAD }] },
      { agent: LEAD, sessionId: 'dead-k7' }, ['dead-k7']);
    assert.deepStrictEqual(r.resumes, ['dead-k7', null]);
    assert.strictEqual(r.info.content, startingFresh(nameOf(LEAD)), 'the person is told it started again');
    assert.strictEqual(r.info.expiredSessionId, 'dead-k7', 'naming the session to forget');
  });
});

// ── Doc's changes to the team ────────────────────────────────────────────
// Five markers in one reply, against files seeded for it: an agent saved
// over, a new agent made with the legacy CREATE marker, an agent deleted, a
// new skill, and a skill deleted. As in team-markers.test.js.

const agentPath = (name) => path.join(h.workspaceDir, '.claude', 'agents', `${name}.md`);
const skillPath = (name) => path.join(h.workspaceDir, '.claude', 'skills', name, 'SKILL.md');
const readOrNull = (file) => (fs.existsSync(file) ? fs.readFileSync(file) : null);

function teamFile(name, label) {
  return agentFile({
    name, displayName: label, role: 'Example Role', description: 'An example agent',
    type: 'specialist', order: 30, reportsTo: LEAD, body: `You are ${label}.`,
  }).trim();
}
function skillFile(name) {
  return `---\nname: ${name}\ndescription: An example skill.\n---\n\nDo the example.`;
}

function fiveMarkers(p) {
  return [
    'Working on the team.',
    `<!-- RUNDOCK:SAVE_AGENT name=${p}-saved -->`, teamFile(`${p}-saved`, 'After'), '<!-- /RUNDOCK:SAVE_AGENT -->',
    `<!-- RUNDOCK:CREATE_AGENT name=${p}-made -->`, teamFile(`${p}-made`, 'Made'), '<!-- /RUNDOCK:CREATE_AGENT -->',
    `<!-- RUNDOCK:DELETE_AGENT name=${p}-gone -->`,
    `<!-- RUNDOCK:SAVE_SKILL name=${p}-skill -->`, skillFile(`${p}-skill`), '<!-- /RUNDOCK:SAVE_SKILL -->',
    `<!-- RUNDOCK:DELETE_SKILL name=${p}-gone-skill -->`,
  ].join('\n');
}
const FILES = (p) => [agentPath(`${p}-saved`), agentPath(`${p}-made`), agentPath(`${p}-gone`), skillPath(`${p}-skill`), skillPath(`${p}-gone-skill`)];

function seedFive(p) {
  fs.writeFileSync(agentPath(`${p}-saved`), teamFile(`${p}-saved`, 'Before'));
  fs.writeFileSync(agentPath(`${p}-gone`), teamFile(`${p}-gone`, 'Gone'));
  fs.mkdirSync(path.dirname(skillPath(`${p}-gone-skill`)), { recursive: true });
  fs.writeFileSync(skillPath(`${p}-gone-skill`), skillFile(`${p}-gone-skill`));
  h.internal.invalidateAgentCache();
  return FILES(p).map(readOrNull);
}

function removeFive(p) {
  for (const n of ['saved', 'made', 'gone']) fs.rmSync(agentPath(`${p}-${n}`), { force: true });
  for (const n of ['skill', 'gone-skill']) fs.rmSync(path.dirname(skillPath(`${p}-${n}`)), { recursive: true, force: true });
  h.internal.invalidateAgentCache();
}

function assertDocWroteFive(p) {
  assert.strictEqual(fs.readFileSync(agentPath(`${p}-saved`), 'utf-8'), teamFile(`${p}-saved`, 'After'), 'SAVE_AGENT replaced the existing agent with the marker content');
  assert.strictEqual(fs.readFileSync(agentPath(`${p}-made`), 'utf-8'), teamFile(`${p}-made`, 'Made'), 'CREATE_AGENT made the new agent');
  assert.strictEqual(fs.existsSync(agentPath(`${p}-gone`)), false, 'DELETE_AGENT removed the agent');
  assert.strictEqual(fs.readFileSync(skillPath(`${p}-skill`), 'utf-8'), skillFile(`${p}-skill`), 'SAVE_SKILL made the skill');
  assert.strictEqual(fs.existsSync(path.dirname(skillPath(`${p}-gone-skill`))), false, 'DELETE_SKILL removed the skill');
}

function assertConfirmedOnce(messages, p, convoId) {
  const mine = (type, key, name) => messages.filter((m) => m.type === type && m[key] === name && m.conversationId === convoId);
  const saved = mine('agent_saved', 'agentId', `${p}-saved`);
  assert.strictEqual(saved.length, 1, 'one confirmation for the saved agent');
  assert.strictEqual(saved[0].updated, true, 'and it says updated');
  const made = mine('agent_saved', 'agentId', `${p}-made`);
  assert.strictEqual(made.length, 1, 'one confirmation for the made agent');
  assert.strictEqual(made[0].updated, false, 'and it says created');
  assert.strictEqual(mine('agent_deleted', 'agentId', `${p}-gone`).length, 1, 'one confirmation for the deleted agent');
  assert.strictEqual(mine('skill_saved', 'skillId', `${p}-skill`).length, 1, 'one confirmation for the saved skill');
  assert.strictEqual(mine('skill_deleted', 'skillId', `${p}-gone-skill`).length, 1, 'one confirmation for the deleted skill');
  const errors = messages.filter((m) => (m.type === 'agent_error' || m.type === 'skill_error') && m.conversationId === convoId);
  assert.deepStrictEqual(errors, [], 'and no error or refusal line');
}

/** The lead's turn has ended, nothing about the team was refused, and every seeded file is as it was. */
async function assertTeamUnchanged(convoId, since, p, before) {
  await client.waitForEvent('system', 'done', convoId, { since, timeout: 15000 });
  await settled();
  const refused = client.messages.slice(since).filter(m => (m.type === 'agent_error' || m.type === 'skill_error')
    && m.conversationId === convoId && String(m.message || '').includes('only Doc can change the team'));
  assert.deepStrictEqual(refused.map(m => m.message), [], 'no change to the team is refused');
  assert.deepStrictEqual(FILES(p).map(readOrNull), before, 'and every seeded file is as it was');
}

/** The lead's message on a record whose primary is Doc's session: Doc's reply on a resume, a plain one fresh. */
function leadRules(p) {
  return [
    { match: { resume: true, promptIncludes: 'TURN-ONE' }, turn: [{ text: fiveMarkers(p) }] },
    { match: { resume: false, promptIncludes: 'TURN-ONE' }, turn: [{ text: 'FRESH-ONE' }] },
  ];
}

describe('Doc\'s session, left as the primary of a conversation Doc does not lead', () => {
  test('the orchestrator starts fresh and nothing about the team changes; Doc then resumes its own session and makes its changes', async () => {
    const p = 'leadfresh';
    const convoId = h.freshConvoId('team-lead');
    const record = seed(convoId, takenOver());
    const seeded = seedFive(p);
    scenario([...leadRules(p), { match: { resume: true, promptIncludes: 'TURN-TWO' }, turn: [{ text: fiveMarkers(p) }] }]);
    h.clearInvocations();
    try {
      const win = windowFor(record);
      let since = client.messages.length;
      win.send('TURN-ONE change the team');
      assert.strictEqual((await resultFor(convoId, since)).result, 'FRESH-ONE', 'the orchestrator answers from a fresh session');
      await assertTeamUnchanged(convoId, since, p, seeded);

      win.sync();
      await settled();
      h.reapConvo(convoId);
      const docWin = windowFor({ ...stored(convoId), activeAgentId: DOC });
      since = client.messages.length;
      assert.deepStrictEqual(docWin.send('TURN-TWO change the team'), { agent: DOC, sessionId: 'sess-doc' });
      await client.waitFor(m => m.type === 'skill_deleted' && m.skillId === `${p}-gone-skill` && m.conversationId === convoId,
        { since, label: 'Doc\'s last change', timeout: 15000 });
      assert.ok(await h.waitUntil(() => !fs.existsSync(agentPath(`${p}-gone`)) && fs.existsSync(skillPath(`${p}-skill`))));
      assert.deepStrictEqual(spawnsFor(convoId).map(i => i.resume), [null, 'sess-doc'], 'Doc resumes its own session');
      assertDocWroteFive(p);
      // Proving a negative needs real time: nothing more for this turn arrives.
      await h.delay(300);
      assertConfirmedOnce(client.messages.slice(since), p, convoId);
    } finally {
      h.reapConvo(convoId);
      removeFive(p);
    }
  });

  test('the workspace\'s default agent starts fresh and nothing about the team changes', async () => {
    const p = 'defaultfresh';
    const convoId = h.freshConvoId('team-default');
    const record = seed(convoId, takenOver('default'));
    const seeded = seedFive(p);
    scenario(leadRules(p));
    h.clearInvocations();
    try {
      const win = windowFor(record);
      const since = client.messages.length;
      win.send('TURN-ONE change the team');
      assert.strictEqual((await resultFor(convoId, since)).result, 'FRESH-ONE', 'the default agent answers from a fresh session');
      await assertTeamUnchanged(convoId, since, p, seeded);
    } finally {
      h.reapConvo(convoId);
      removeFive(p);
    }
  });
});
