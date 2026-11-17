'use strict';
// Where a long conversation was summarised to make room, in the real client
// against the real server, from the runtime's own events.
//
// WHAT IS ASSERTED, AND WHERE. The stub runtime replays the events Claude Code
// writes for a summary, in the shape its capture shows (a status line saying a
// summary has started, a status line saying it is over, and the
// compact_boundary system line that marks where it fell), held at the moments
// a test needs. On the page: the live state while it runs, the divider it
// settles into, the reply it splits, what a reopen and a reload draw, the
// "Why?" button under each key, and the colours the text takes.
//
// IN CONVERSATIONS OF THEIR OWN, deleted afterwards, never a seeded one: the
// specs share one server and one workspace.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const credentials = require('./credentials.js');

const PORT = Number(process.env.E2E_PORT || 34517);
const STUB_VERSION = '2.1.318-stub';
const WORDS = 'Earlier messages were summarised to make room';
const LIVE = 'Summarising earlier messages…';
const EXPLANATION = 'Long conversations are summarised so the agent can carry on. It keeps a summary of everything above, and may not recall every detail. For a new topic, start a new conversation.';

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
const scenarioFile = () => path.join(workspace, 'stub-scenario.json');
const gate = (name) => path.join(workspace, `summarised-e2e-${name}.gate`);
const GATES = ['split', 'nofinish', 'stop', 'elsewhere-start', 'elsewhere-finish', 'short'];

// The events, in the shapes the capture shows.
const started = (n) => ({ raw: { type: 'system', subtype: 'status', status: 'compacting', uuid: `00000000-0000-4000-8000-0e000000000${n}` } });
const over = (result) => ({ raw: { type: 'system', subtype: 'status', status: null, compact_result: result, uuid: '00000000-0000-4000-8000-0e00000000ff' } });
const boundary = (key) => ({ raw: { type: 'system', subtype: 'compact_boundary', uuid: key, compact_metadata: { trigger: 'auto', pre_tokens: 180000, post_tokens: 9000 } } });
const KEY_SPLIT = '00000000-0000-4000-8000-0d0000000001';
const KEY_ELSEWHERE = '00000000-0000-4000-8000-0d0000000002';

const FIRST_HALF = 'The first half of the answer.';
const SECOND_HALF = 'The second half of the answer.';

function writeScenario() {
  fs.writeFileSync(scenarioFile(), JSON.stringify({ rules: [
    // A summary in the middle of a reply, its finish delivered twice.
    { match: { promptIncludes: 'SUMMARISED-SPLIT' }, turn: [
      { text: FIRST_HALF }, started(1), { holdUntil: gate('split') }, over('success'), boundary(KEY_SPLIT), boundary(KEY_SPLIT), { text: SECOND_HALF },
    ] },
    { match: { promptIncludes: 'SUMMARISED-NEXT' }, turn: [{ text: 'A reply below the divider.' }] },
    // A start, then the turn ends with no finish.
    { match: { promptIncludes: 'SUMMARISED-NOFINISH' }, turn: [
      { text: 'Working on it.' }, started(2), { holdUntil: gate('nofinish') }, { text: ' Done, with no summary.' },
    ] },
    // A start, then the person stops the turn.
    { match: { promptIncludes: 'SUMMARISED-STOP' }, turn: [started(3), { holdUntil: gate('stop') }, { text: 'Never sent.' }] },
    // A start, then the runtime says the summary stopped short.
    { match: { promptIncludes: 'SUMMARISED-SHORT' }, turn: [
      started(4), { holdUntil: gate('short') }, over('failed'), { text: 'Carried on without a summary.' },
    ] },
    // A summary in a conversation that is not on screen.
    { match: { promptIncludes: 'SUMMARISED-ELSEWHERE' }, turn: [
      { holdUntil: gate('elsewhere-start') }, started(5), { holdUntil: gate('elsewhere-finish') }, over('success'), boundary(KEY_ELSEWHERE),
      { text: 'A reply after the summary.' },
    ] },
  ] }));
}

test.beforeAll(async () => {
  workspace = await overWs(async ({ send, waitFor }) => {
    send({ type: 'get_runtime_status' });
    const status = await waitFor((m) => m.type === 'runtime_status');
    if (!(status.claude && status.claude.version === STUB_VERSION)) return null;
    send({ type: 'get_workspaces' });
    const set = await waitFor((m) => m.type === 'workspaces' && m.current);
    return set.current;
  });
  if (workspace) writeScenario();
});

test.afterAll(() => {
  if (!workspace) return;
  for (const f of [scenarioFile(), ...GATES.map(gate)]) fs.rmSync(f, { force: true });
});

// What the conversation on screen holds, in order. A conversation loaded from
// its history after a reload ends with the "Previous session" divider, which
// the app has always drawn there.
const kinds = (page) => page.evaluate(() => [...document.querySelectorAll('#messages > *')].map((el) => {
  if (el.classList.contains('msg-summarised')) return el.classList.contains('summarising') ? 'summarising' : 'divider';
  if (el.id === 'history-divider') return 'previous-session';
  if (el.id === 'thinking-indicator') return 'thinking';
  if (el.classList.contains('msg-user')) return 'user';
  if (el.classList.contains('msg-agent')) return getComputedStyle(el).display === 'none' ? 'hidden-agent' : 'agent';
  return el.className || el.tagName;
}));

// The colour a token resolves to here, to compare a computed colour against.
const tokenColour = (page, token) => page.evaluate((t) => {
  const el = document.createElement('span');
  el.style.color = `var(${t})`;
  document.body.appendChild(el);
  const c = getComputedStyle(el).color;
  el.remove();
  return c;
}, token);

async function start(page, title, prompt, received) {
  const id = await page.evaluate((t) => createConversation('rundock-guide', t).id, title);
  await page.locator('#msg-input').fill(prompt);
  await page.locator('#send-btn').click();
  await expect.poll(() => received.some((m) => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === id)).toBe(true);
  return id;
}

const turnOver = (received, id) => () => received.some((m) => m.type === 'system' && m.subtype === 'done' && m._conversationId === id);

function watch(page) {
  const received = [];
  page.on('websocket', (socket) => socket.on('framereceived', (f) => { try { received.push(JSON.parse(f.payload)); } catch (e) { /* not JSON */ } }));
  return received;
}

async function cleanUp(page, ids) {
  for (const id of ids) {
    if (id) await page.evaluate((c) => deleteConversation(c, { stopPropagation() {} }), id).catch(() => {});
  }
}

test('a summary in the middle of a reply: the live state, then one divider splitting the reply, kept where it fell after a reload', async ({ page }) => {
  expect(workspace, 'the server must resolve the stub runtime, or nothing may be sent').toBeTruthy();
  const received = watch(page);
  const ids = [];
  try {
    await page.goto('/');
    await expect(page.locator('.convo-item').first()).toBeVisible();
    const id = await start(page, 'Summarised split e2e', 'SUMMARISED-SPLIT tell me in two halves', received);
    ids.push(id);

    // While the runtime summarises: the words in a status region, with the
    // reconnect card's dot, below what the agent has said so far.
    const live = page.locator('#messages .msg-summarised.summarising');
    await expect(live).toHaveCount(1);
    await expect(live.locator('[role="status"]')).toHaveText(LIVE);
    await expect(live.locator('.auth-pulse[aria-hidden="true"]')).toHaveCount(1);
    await expect(page.locator('#messages')).toContainText(FIRST_HALF);
    expect((await kinds(page)).filter((k) => k !== 'thinking')).toEqual(['user', 'agent', 'summarising']);

    // It finishes, and its finish arrives twice: one divider, settled in place.
    fs.writeFileSync(gate('split'), '');
    await expect.poll(turnOver(received, id)).toBe(true);
    const divider = page.locator('#messages .msg-summarised');
    await expect(divider).toHaveCount(1);
    await expect(live).toHaveCount(0);
    await expect(divider.locator('[role="status"]')).toContainText(WORDS);
    expect(await kinds(page)).toEqual(['user', 'agent', 'divider', 'agent']);
    const agents = page.locator('#messages > .msg-agent');
    await expect(agents.nth(0)).toContainText(FIRST_HALF);
    await expect(agents.nth(0)).not.toContainText(SECOND_HALF);
    await expect(agents.nth(1)).toContainText(SECOND_HALF);
    await expect(agents.nth(1)).not.toContainText(FIRST_HALF);
    await expect(agents.nth(1).locator('.msg-sender')).toBeVisible();

    // The person carries on: the next message and its reply below the divider.
    await page.locator('#msg-input').fill('SUMMARISED-NEXT and then');
    await page.locator('#send-btn').click();
    await expect(page.locator('#messages')).toContainText('A reply below the divider.');
    expect(await kinds(page)).toEqual(['user', 'agent', 'divider', 'agent', 'user', 'agent']);
    await expect(divider).toHaveCount(1);

    // Switching away and back, and a reload, draw it once more and no more:
    // the reply is rebuilt from what was kept as one bubble, so the divider
    // sits straight after the message it followed and straight before that
    // reply, and the whole reply is there, each half shown once.
    const rebuiltAroundReply = async () => {
      await expect(page.locator('#messages > .msg-user + .msg-summarised')).toHaveCount(1);
      const reply = page.locator('#messages > .msg-summarised + .msg-agent');
      await expect(reply).toBeVisible();
      await expect(reply).toContainText(FIRST_HALF);
      await expect(reply).toContainText(SECOND_HALF);
      const shown = await page.locator('#messages').innerText();
      expect(shown.split(FIRST_HALF).length - 1, 'the first half is shown once').toBe(1);
      expect(shown.split(SECOND_HALF).length - 1, 'the second half is shown once').toBe(1);
    };
    const other = await page.evaluate(() => createConversation('rundock-guide', 'Summarised other e2e').id);
    ids.push(other);
    await expect(page.locator('#messages .msg-summarised'), 'a new conversation starts with no divider').toHaveCount(0);
    await page.evaluate((c) => openConversation(c), id);
    await expect(page.locator('#messages')).toContainText('A reply below the divider.');
    await expect(divider).toHaveCount(1);
    expect(await kinds(page)).toEqual(['user', 'divider', 'agent', 'user', 'agent']);
    await rebuiltAroundReply();
    await page.reload();
    await expect(page.locator('.convo-item').first()).toBeVisible();
    await page.evaluate((c) => openConversation(c), id);
    await expect(page.locator('#messages')).toContainText('A reply below the divider.');
    await expect(divider).toHaveCount(1);
    expect(await kinds(page)).toEqual(['user', 'divider', 'agent', 'user', 'agent', 'previous-session']);
    await rebuiltAroundReply();
    // Drawn from the history, it is no status region: nothing is under way.
    await expect(divider.locator('.summarised-label')).toContainText(WORDS);
    expect(await divider.locator('[role="status"]').count()).toBe(0);
  } finally {
    await cleanUp(page, ids);
  }
});

test('"Why?" opens and closes in place by click, Enter, Space and Escape, focus staying on it, with a tall enough target and the text in its tokens', async ({ page }) => {
  expect(workspace, 'the server must resolve the stub runtime, or nothing may be sent').toBeTruthy();
  const received = watch(page);
  const ids = [];
  try {
    await page.goto('/');
    await expect(page.locator('.convo-item').first()).toBeVisible();
    const id = await start(page, 'Summarised why e2e', 'SUMMARISED-SPLIT tell me in two halves', received);
    ids.push(id);
    fs.writeFileSync(gate('split'), '');
    await expect.poll(turnOver(received, id)).toBe(true);

    const why = page.locator('#messages .msg-summarised button.summarised-why');
    const explain = page.locator('#messages .msg-summarised .summarised-explain');
    await expect(why).toHaveText('Why?');
    await expect(why).toHaveAttribute('aria-expanded', 'false');
    expect(await why.getAttribute('aria-controls')).toBe(await explain.getAttribute('id'));
    await expect(explain).toBeHidden();
    expect(await page.locator('#messages .msg-summarised').getAttribute('role')).toBeNull();
    const box = await why.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(26);

    const text2 = await tokenColour(page, '--text-2');
    const text1 = await tokenColour(page, '--text-1');
    const colour = (loc) => loc.evaluate((el) => getComputedStyle(el).color);
    const label = page.locator('#messages .msg-summarised .summarised-label');
    expect(await colour(label)).toBe(text2);
    expect(await colour(why)).toBe(text2);
    await why.hover();
    await expect.poll(() => colour(why)).toBe(text1);
    await page.mouse.move(0, 0);
    await expect.poll(() => colour(why)).toBe(text2);

    const isFocused = () => why.evaluate((el) => document.activeElement === el);
    const shut = async () => {
      await expect(why).toHaveAttribute('aria-expanded', 'false');
      await expect(explain).toBeHidden();
    };
    const open = async () => {
      await expect(why).toHaveAttribute('aria-expanded', 'true');
      await expect(explain).toBeVisible();
      await expect(explain).toHaveText(EXPLANATION);
    };
    const before = await kinds(page);

    // Every colour change in the app eases over a moment (the base stylesheet),
    // so each is read once it has settled. The pointer leaves first, so the
    // colour shown is the open state's own, never the hover's.
    await why.click();
    await open();
    await page.mouse.move(0, 0);
    await expect.poll(() => colour(why)).toBe(text1);
    await expect.poll(() => colour(explain)).toBe(text2);
    await why.click();
    await shut();
    await page.mouse.move(0, 0);
    await expect.poll(() => colour(why)).toBe(text2);

    await why.focus();
    await page.keyboard.press('Enter');
    await open();
    expect(await isFocused()).toBe(true);
    await page.keyboard.press('Enter');
    await shut();
    expect(await isFocused()).toBe(true);
    await page.keyboard.press('Space');
    await open();
    expect(await isFocused()).toBe(true);
    await page.keyboard.press('Space');
    await shut();
    await page.keyboard.press('Enter');
    await open();
    await page.keyboard.press('Escape');
    await shut();
    expect(await isFocused()).toBe(true);
    expect(await kinds(page)).toEqual(before);

    // The "Previous session" divider's text moves to the same token.
    const previous = await page.evaluate(() => {
      const d = createHistoryDivider();
      document.getElementById('messages').appendChild(d);
      const c = getComputedStyle(d).color;
      d.remove();
      return c;
    });
    expect(previous).toBe(text2);
  } finally {
    await cleanUp(page, ids);
  }
});

test('a start, then the turn ends with no finish: the live state goes and no divider is drawn', async ({ page }) => {
  expect(workspace, 'the server must resolve the stub runtime, or nothing may be sent').toBeTruthy();
  const received = watch(page);
  const ids = [];
  try {
    await page.goto('/');
    await expect(page.locator('.convo-item').first()).toBeVisible();
    const id = await start(page, 'Summarised no finish e2e', 'SUMMARISED-NOFINISH go', received);
    ids.push(id);
    await expect(page.locator('#messages .msg-summarised.summarising')).toHaveCount(1);
    fs.writeFileSync(gate('nofinish'), '');
    await expect.poll(turnOver(received, id)).toBe(true);
    await expect(page.locator('#messages')).toContainText('Done, with no summary.');
    await expect(page.locator('#messages .msg-summarised')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.convo-item').first()).toBeVisible();
    await page.evaluate((c) => openConversation(c), id);
    await expect(page.locator('#messages')).toContainText('Done, with no summary.');
    await expect(page.locator('#messages .msg-summarised')).toHaveCount(0);
  } finally {
    await cleanUp(page, ids);
  }
});

test('a start, then the runtime says it stopped short: the live state goes, no divider is drawn, and the reply carries on', async ({ page }) => {
  expect(workspace, 'the server must resolve the stub runtime, or nothing may be sent').toBeTruthy();
  const received = watch(page);
  const ids = [];
  try {
    await page.goto('/');
    await expect(page.locator('.convo-item').first()).toBeVisible();
    const id = await start(page, 'Summarised short e2e', 'SUMMARISED-SHORT go', received);
    ids.push(id);
    await expect(page.locator('#messages .msg-summarised.summarising')).toHaveCount(1);
    fs.writeFileSync(gate('short'), '');
    await expect.poll(turnOver(received, id)).toBe(true);
    await expect(page.locator('#messages')).toContainText('Carried on without a summary.');
    await expect(page.locator('#messages .msg-summarised')).toHaveCount(0);
  } finally {
    await cleanUp(page, ids);
  }
});

test('a start, then the person stops the turn: the live state goes and no divider is drawn', async ({ page }) => {
  expect(workspace, 'the server must resolve the stub runtime, or nothing may be sent').toBeTruthy();
  const received = watch(page);
  const ids = [];
  try {
    await page.goto('/');
    await expect(page.locator('.convo-item').first()).toBeVisible();
    const id = await start(page, 'Summarised stop e2e', 'SUMMARISED-STOP go', received);
    ids.push(id);
    await expect(page.locator('#messages .msg-summarised.summarising')).toHaveCount(1);
    await page.evaluate(() => cancelProcessing());
    await expect.poll(turnOver(received, id)).toBe(true);
    await expect(page.locator('#messages .msg-summarised')).toHaveCount(0);
    await expect(page.locator('#messages')).not.toContainText('Never sent.');
  } finally {
    await cleanUp(page, ids);
  }
});

test('a summary in a conversation not on screen draws nothing in the one that is, and its divider is there on switching back', async ({ page }) => {
  expect(workspace, 'the server must resolve the stub runtime, or nothing may be sent').toBeTruthy();
  const received = watch(page);
  const ids = [];
  try {
    await page.goto('/');
    await expect(page.locator('.convo-item').first()).toBeVisible();
    const id = await start(page, 'Summarised elsewhere e2e', 'SUMMARISED-ELSEWHERE go', received);
    ids.push(id);
    const shown = await page.evaluate(() => createConversation('rundock-guide', 'Summarised on screen e2e').id);
    ids.push(shown);
    await expect.poll(() => page.evaluate(() => activeConversation && activeConversation.id)).toBe(shown);

    fs.writeFileSync(gate('elsewhere-start'), '');
    await expect.poll(() => received.some((m) => m.type === 'system' && m.subtype === 'status' && m.status === 'compacting' && m._conversationId === id)).toBe(true);
    await expect(page.locator('#messages .msg-summarised')).toHaveCount(0);
    fs.writeFileSync(gate('elsewhere-finish'), '');
    await expect.poll(turnOver(received, id)).toBe(true);
    await expect(page.locator('#messages .msg-summarised')).toHaveCount(0);

    await page.evaluate((c) => openConversation(c), id);
    await expect(page.locator('#messages')).toContainText('A reply after the summary.');
    await expect(page.locator('#messages .msg-summarised')).toHaveCount(1);
    await expect(page.locator('#messages .msg-summarised.summarising')).toHaveCount(0);
    expect(await kinds(page)).toEqual(['user', 'divider', 'agent']);
  } finally {
    await cleanUp(page, ids);
  }
});
