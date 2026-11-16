'use strict';
// A reply that shows an agent file without a save marker saves nothing, in the
// real client against the real server.
//
// THE DEFECT. When a finished reply carried no save marker, the client looked
// for anything shaped like an agent file (frontmatter with `name:` and `type:
// orchestrator` or `type: specialist`, fenced or not) and asked the server to
// save it. A reply that only showed an agent file for the person to approve
// wrote it at the preview, before the yes, and an existing agent of the same
// name was replaced with no copy kept.
//
// AND ONLY DOC'S MARKERS SAVE. A marked save is acted on by the server at the
// end of the turn, only when the turn is Doc's (lib/agents/team-markers.js),
// and the page sends no file-writing message at all: the marked cases run with
// Doc, and another agent's marker is refused with a line on the page.
//
// WHAT IS ASSERTED, AND WHERE. On the files in the workspace's .claude/agents/
// and .claude/skills/, not only on the page, and on every message the page
// sends. A negative needs a point after which nothing more can arrive, so each
// turn ends with a probe sent on the page's own socket: the server answers it
// only after every message the page sent before it, and the server writes a
// marked save before it sends the turn's result, so once the probe is answered
// a save the reply caused is on disk and its confirmation is on its way.
//
// IN CONVERSATIONS OF THEIR OWN, deleted afterwards, never a seeded one: the
// specs share one server and one workspace, and a turn gives its conversation
// a transcript. Every agent and skill file this spec creates is removed
// afterwards, and the server's roster is read until it no longer lists them.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const credentials = require('./credentials.js');

const PORT = Number(process.env.E2E_PORT || 34517);
const STUB_VERSION = '2.1.318-stub';

// The kinds of message that make the server write or delete a file under
// .claude/agents/ or .claude/skills/, the legacy save names included.
const FILE_WRITES = ['save_agent', 'create_agent', 'update_agent', 'save_skill', 'delete_agent', 'delete_skill'];

const EXISTING_NAME = 'example-agent';
const EXISTING = [
  '---',
  `name: ${EXISTING_NAME}`,
  'displayName: Example',
  'role: Example Specialist',
  'type: specialist',
  'order: 7',
  'tools: Read',
  '---',
  '',
  'You are the example agent as the workspace already has it.',
  '',
].join('\n');

function agentFile(name, type, body) {
  return [
    '---',
    `name: ${name}`,
    'displayName: Example',
    'role: Example Specialist',
    `type: ${type}`,
    'order: 8',
    'tools: Read, Write, Edit, Bash',
    '---',
    '',
    body || `You are ${name}. You help with examples.`,
  ].join('\n');
}

// Every file name this spec may cause, so cleanup never depends on which
// assertion failed first.
const CREATED_AGENTS = ['example-agent', 'example-lead', 'example-helper', 'example-new', 'example-made'];
const CREATED_SKILL = 'example-skill';

function overWs(fn) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`, { headers: credentials.sessionHeaders() });
    const messages = [];
    const waitFor = (pred) => new Promise((ok, no) => {
      const timer = setTimeout(() => no(new Error('timed out waiting over the socket')), 10000);
      const check = () => { const m = messages.find(pred); if (m) { clearTimeout(timer); ok(m); return true; } return false; };
      if (!check()) ws.on('message', check);
    });
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    ws.on('error', reject);
    ws.on('open', () => fn({ send: (o) => ws.send(JSON.stringify(o)), waitFor }).then((v) => { ws.close(); resolve(v); }, reject));
  });
}

let workspace = null;
const agentsDir = () => path.join(workspace, '.claude', 'agents');
const skillsDir = () => path.join(workspace, '.claude', 'skills');
const scenarioFile = () => path.join(workspace, 'stub-scenario.json');
const listAgents = () => fs.readdirSync(agentsDir()).sort();

test.beforeAll(async () => {
  workspace = await overWs(async ({ send, waitFor }) => {
    send({ type: 'get_runtime_status' });
    const status = await waitFor((m) => m.type === 'runtime_status');
    if (!(status.claude && status.claude.version === STUB_VERSION)) return null;
    send({ type: 'get_workspaces' });
    const set = await waitFor((m) => m.type === 'workspaces' && m.current);
    return set.current;
  });
});

test.beforeEach(() => {
  expect(workspace, 'the server must resolve the stub runtime, or nothing may be sent').toBeTruthy();
  // The workspace already has an agent of the previewed name, as it stood
  // before each test, so a save that should not happen has something to
  // replace and is seen replacing it.
  fs.writeFileSync(path.join(agentsDir(), `${EXISTING_NAME}.md`), EXISTING);
});

test.afterAll(async () => {
  if (!workspace) return;
  fs.rmSync(scenarioFile(), { force: true });
  for (const name of CREATED_AGENTS) fs.rmSync(path.join(agentsDir(), `${name}.md`), { force: true });
  fs.rmSync(path.join(skillsDir(), CREATED_SKILL), { recursive: true, force: true });
  // Leave the server's roster as the next spec expects it. Its caches expire
  // on their own, so this reads until they have.
  await expect.poll(() => overWs(async ({ send, waitFor }) => {
    send({ type: 'get_agents' });
    const roster = await waitFor((m) => m.type === 'agents');
    send({ type: 'get_skills' });
    const skills = await waitFor((m) => m.type === 'skills');
    return roster.agents.some((a) => CREATED_AGENTS.includes(a.id) || CREATED_AGENTS.includes(a.name))
      || (skills.skills || []).some((s) => s.id === CREATED_SKILL || s.name === CREATED_SKILL);
  }), { timeout: 15000 }).toBe(false);
});

// Every message the page sends and receives, from before it loads.
function watch(page) {
  const wire = { sent: [], received: [] };
  page.on('websocket', (socket) => {
    socket.on('framesent', (f) => { try { wire.sent.push(JSON.parse(f.payload)); } catch (e) { /* not JSON */ } });
    socket.on('framereceived', (f) => { try { wire.received.push(JSON.parse(f.payload)); } catch (e) { /* not JSON */ } });
  });
  return wire;
}

async function openNewConversation(page, title, agent = 'default') {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  const id = await page.evaluate(([a, t]) => createConversation(a, t).id, [agent, title]);
  await expect(page.locator('#view-chat')).toBeVisible();
  return id;
}

// The point after which the page has nothing more to send for a turn: the
// server has answered a probe sent behind everything the page sent before it,
// and the probe itself has been seen leaving, so every earlier frame has too.
async function settle(page, wire) {
  const probe = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await page.evaluate((p) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the server never answered the probe')), 10000);
    const onMessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type !== 'lists') return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      resolve(null);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ type: 'get_lists', probe: p }));
  }), probe);
  await expect.poll(() => wire.sent.some((m) => m.probe === probe)).toBe(true);
}

// One turn to the stub, to its end: the reply shown, its result handled (the
// send button is back from cancel only after handleResult has run), then the
// probe.
async function turn(page, wire, convoId, prompt, replyLead) {
  const results = () => wire.received.filter((m) => m.type === 'result' && m._conversationId === convoId).length;
  const before = results();
  await page.locator('#msg-input').fill(prompt);
  await page.locator('#send-btn').click();
  await expect(page.locator('#messages')).toContainText(replyLead);
  await expect.poll(results).toBe(before + 1);
  await expect(page.locator('#send-btn')).not.toHaveClass(/\bcancel\b/);
  await settle(page, wire);
}

function scenario(rules) {
  fs.writeFileSync(scenarioFile(), JSON.stringify({ rules }));
}

const fileWritesFrom = (wire) => wire.sent.filter((m) => FILE_WRITES.includes(m.type));

async function noMarkerSavesNothing(page, { title, prompt, replyLead, reply }) {
  scenario([{ match: { promptIncludes: prompt }, turn: [{ text: reply }] }]);
  const wire = watch(page);
  let convoId = null;
  try {
    convoId = await openNewConversation(page, title);
    const before = listAgents();
    const existingBefore = fs.readFileSync(path.join(agentsDir(), `${EXISTING_NAME}.md`));
    await turn(page, wire, convoId, prompt, replyLead);

    // The files first: they are what the person loses.
    const existingAfter = fs.readFileSync(path.join(agentsDir(), `${EXISTING_NAME}.md`));
    expect(existingAfter.equals(existingBefore), 'the existing agent file changed').toBe(true);
    expect(listAgents(), 'a file was added to or removed from .claude/agents/').toEqual(before);
    expect(fileWritesFrom(wire), 'the page asked the server to write or delete a file').toEqual([]);
    await expect(page.locator('#messages')).not.toContainText(/Agent "example-[a-z]+" (created|updated)/);
  } finally {
    fs.rmSync(scenarioFile(), { force: true });
    if (convoId) await page.evaluate((id) => deleteConversation(id, { stopPropagation() {} }), convoId).catch(() => {});
  }
}

const FENCED = [
  ['a markdown fence and type specialist, named as an existing agent', '```markdown\n', EXISTING_NAME, 'specialist'],
  ['a bare fence and type specialist, named as an existing agent', '```\n', EXISTING_NAME, 'specialist'],
  ['a markdown fence and type orchestrator, under a new name', '```markdown\n', 'example-lead', 'orchestrator'],
  ['a bare fence and type orchestrator, named as an existing agent', '```\n', EXISTING_NAME, 'orchestrator'],
];

for (const [label, fence, name, type] of FENCED) {
  test(`a reply showing an agent file in ${label}, with no marker, saves nothing`, async ({ page }) => {
    const replyLead = 'Here is the fenced agent file for you to check before I save it.';
    await noMarkerSavesNothing(page, {
      title: 'Fenced agent file e2e',
      prompt: 'FENCED-PREVIEW-E2E draft the agent',
      replyLead,
      reply: `${replyLead}\n\n${fence}${agentFile(name, type, 'You are replaced by a preview.')}\n\`\`\`\n\nShall I save it?`,
    });
  });
}

test('a reply showing one unfenced agent file, with no marker, saves nothing', async ({ page }) => {
  const replyLead = 'Here is the unfenced agent file for you to check.';
  await noMarkerSavesNothing(page, {
    title: 'Unfenced agent file e2e',
    prompt: 'UNFENCED-ONE-E2E draft the agent',
    replyLead,
    reply: `${replyLead}\n\n${agentFile(EXISTING_NAME, 'specialist', 'You are replaced by a preview.')}\n\nShall I save it?`,
  });
});

test('a reply showing several unfenced agent files, with no marker, saves nothing', async ({ page }) => {
  const replyLead = 'Here are three unfenced agent files for you to check.';
  await noMarkerSavesNothing(page, {
    title: 'Unfenced agent files e2e',
    prompt: 'UNFENCED-MANY-E2E draft the agents',
    replyLead,
    reply: `${replyLead}\n\n${agentFile(EXISTING_NAME, 'specialist', 'You are replaced by a preview.')}\n\n`
      + `The lead:\n\n${agentFile('example-lead', 'orchestrator')}\n\n`
      + `And a helper:\n${agentFile('example-helper', 'specialist')}\n\nShall I save them?`,
  });
});

test('a previewed agent file is written only when Doc\'s next reply carries it in a SAVE_AGENT marker, once, by the server', async ({ page }) => {
  const file = agentFile('example-new', 'specialist', 'You are the new example agent, as approved.');
  const previewLead = 'Here is the new agent file. Shall I save it?';
  const savedLead = 'Saved the agent as approved.';
  scenario([
    { match: { promptIncludes: 'APPROVE-PREVIEW-E2E' },
      turn: [{ text: `${previewLead}\n\n\`\`\`markdown\n${file}\n\`\`\`` }] },
    { match: { promptIncludes: 'APPROVE-YES-E2E' },
      turn: [{ text: `${savedLead}\n<!-- RUNDOCK:SAVE_AGENT name=example-new -->\n\`\`\`markdown\n${file}\n\`\`\`\n<!-- /RUNDOCK:SAVE_AGENT -->` }] },
  ]);
  const wire = watch(page);
  const target = () => path.join(agentsDir(), 'example-new.md');
  let convoId = null;
  try {
    convoId = await openNewConversation(page, 'Approve then save e2e', 'rundock-guide');
    const before = listAgents();

    // The preview: nothing written, nothing asked for.
    await turn(page, wire, convoId, 'APPROVE-PREVIEW-E2E draft a new agent', previewLead);
    expect(fs.existsSync(target()), 'the preview wrote the agent file before the yes').toBe(false);
    expect(listAgents()).toEqual(before);
    expect(fileWritesFrom(wire), 'the preview asked the server to write a file').toEqual([]);

    // The yes: the marked save, once, with the marker's content, written by
    // the server with nothing sent by the page.
    await turn(page, wire, convoId, 'APPROVE-YES-E2E yes, save it', savedLead);
    expect(fs.readFileSync(target(), 'utf8'), 'the file on disk is the marker content').toBe(file);
    expect(listAgents()).toEqual([...before, 'example-new.md'].sort());
    expect(fileWritesFrom(wire), 'the page asked the server to write or delete a file').toEqual([]);
    const confirmations = page.locator('#messages .msg-system', { hasText: 'Agent "example-new"' });
    await expect(confirmations).toHaveCount(1);
    await expect(confirmations).toHaveText('Agent "example-new" created');
  } finally {
    fs.rmSync(scenarioFile(), { force: true });
    if (convoId) await page.evaluate((id) => deleteConversation(id, { stopPropagation() {} }), convoId).catch(() => {});
  }
});

test('Doc\'s CREATE_AGENT marker still saves, once, by the server', async ({ page }) => {
  const file = agentFile('example-made', 'specialist', 'You are made by the legacy marker.');
  const lead = 'Created the agent with the legacy marker.';
  scenario([{ match: { promptIncludes: 'CREATE-MARKER-E2E' },
    turn: [{ text: `${lead}\n<!-- RUNDOCK:CREATE_AGENT name=example-made -->\n${file}\n<!-- /RUNDOCK:CREATE_AGENT -->` }] }]);
  const wire = watch(page);
  let convoId = null;
  try {
    convoId = await openNewConversation(page, 'Create marker e2e', 'rundock-guide');
    await turn(page, wire, convoId, 'CREATE-MARKER-E2E make the agent', lead);
    expect(fs.readFileSync(path.join(agentsDir(), 'example-made.md'), 'utf8')).toBe(file);
    expect(fileWritesFrom(wire), 'the page asked the server to write or delete a file').toEqual([]);
    const confirmations = page.locator('#messages .msg-system', { hasText: 'Agent "example-made"' });
    await expect(confirmations).toHaveCount(1);
    await expect(confirmations).toHaveText('Agent "example-made" created');
  } finally {
    fs.rmSync(scenarioFile(), { force: true });
    if (convoId) await page.evaluate((id) => deleteConversation(id, { stopPropagation() {} }), convoId).catch(() => {});
  }
});

test('Doc\'s SAVE_SKILL marker still writes the skill file, once, by the server', async ({ page }) => {
  const skill = `---\nname: ${CREATED_SKILL}\ndescription: An example skill.\n---\n\nDo the example.`;
  const lead = 'Saved the skill.';
  scenario([{ match: { promptIncludes: 'SKILL-MARKER-E2E' },
    turn: [{ text: `${lead}\n<!-- RUNDOCK:SAVE_SKILL name=${CREATED_SKILL} -->\n${skill}\n<!-- /RUNDOCK:SAVE_SKILL -->` }] }]);
  const wire = watch(page);
  let convoId = null;
  try {
    convoId = await openNewConversation(page, 'Skill marker e2e', 'rundock-guide');
    await turn(page, wire, convoId, 'SKILL-MARKER-E2E make the skill', lead);
    expect(fs.readFileSync(path.join(skillsDir(), CREATED_SKILL, 'SKILL.md'), 'utf8')).toBe(skill);
    expect(fileWritesFrom(wire), 'the page asked the server to write or delete a file').toEqual([]);
    const confirmations = page.locator('#messages .msg-system', { hasText: `Skill "${CREATED_SKILL}"` });
    await expect(confirmations).toHaveCount(1);
    await expect(confirmations).toHaveText(`Skill "${CREATED_SKILL}" created`);
  } finally {
    fs.rmSync(scenarioFile(), { force: true });
    if (convoId) await page.evaluate((id) => deleteConversation(id, { stopPropagation() {} }), convoId).catch(() => {});
  }
});

test('another agent\'s SAVE_AGENT marker leaves the file as it was, and the page says why', async ({ page }) => {
  const lead = 'Replacing the example agent.';
  scenario([{ match: { promptIncludes: 'OTHER-AGENT-E2E' },
    turn: [{ text: `${lead}\n<!-- RUNDOCK:SAVE_AGENT name=${EXISTING_NAME} -->\n${agentFile(EXISTING_NAME, 'specialist', 'You are replaced by another agent.')}\n<!-- /RUNDOCK:SAVE_AGENT -->` }] }]);
  const wire = watch(page);
  let convoId = null;
  try {
    convoId = await openNewConversation(page, 'Other agent marker e2e');
    const before = listAgents();
    const existingBefore = fs.readFileSync(path.join(agentsDir(), `${EXISTING_NAME}.md`));
    await turn(page, wire, convoId, 'OTHER-AGENT-E2E replace it', lead);
    const refusal = page.locator('#messages .msg-system', { hasText: `asked to save the agent "${EXISTING_NAME}", but only Doc can change the team` });
    await expect(refusal).toHaveCount(1);
    expect(fs.readFileSync(path.join(agentsDir(), `${EXISTING_NAME}.md`)).equals(existingBefore), 'the existing agent file changed').toBe(true);
    expect(listAgents()).toEqual(before);
    expect(fileWritesFrom(wire), 'the page asked the server to write or delete a file').toEqual([]);
    await expect(page.locator('#messages')).not.toContainText(`Agent "${EXISTING_NAME}" updated`);
  } finally {
    fs.rmSync(scenarioFile(), { force: true });
    if (convoId) await page.evaluate((id) => deleteConversation(id, { stopPropagation() {} }), convoId).catch(() => {});
  }
});
