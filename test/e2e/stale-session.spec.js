'use strict';
// A conversation whose stored session Claude Code no longer has, in the real
// client against the real server.
//
// The orchestrator delegates to an agent whose last stored session was
// removed by Claude Code. The stub runtime refuses that resume exactly as
// Claude Code does, before reading anything. The delegate must answer from a
// fresh session, the window must say so in plain words and never show the raw
// refusal, the dead id must be gone from what the window holds and from what
// the server stores, and the next message must carry the fresh session.
//
// IN A CONVERSATION OF ITS OWN, deleted afterwards, never a seeded one: the
// specs share one server and one workspace, and a turn gives its conversation
// a transcript.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const credentials = require('./credentials.js');

const PORT = Number(process.env.E2E_PORT || 34517);
const STUB_VERSION = '0.0.0-stub';
const CONVO = 'stale-session-e2e';
const LIVE = 'e2e-live-orch-session';
const DEAD = 'e2e-removed-lead-session';

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

test('delegating to an agent whose stored session is gone answers fresh, says so plainly, and never sends the dead id again', async ({ page }) => {
  const workspace = await overWs(async ({ send, waitFor }) => {
    send({ type: 'get_runtime_status' });
    const status = await waitFor((m) => m.type === 'runtime_status');
    if (!(status.claude && status.claude.version === STUB_VERSION)) return null;
    send({ type: 'get_workspaces' });
    const set = await waitFor((m) => m.type === 'workspaces' && m.current);
    send({ type: 'save_conversation', conversation: {
      id: CONVO, agentId: 'chief-of-staff', title: 'Stale session e2e', status: 'active', sessionId: LIVE,
      sessionIds: [{ sessionId: LIVE, agentId: 'chief-of-staff' }, { sessionId: DEAD, agentId: 'wren' }],
    } });
    // Answered only after the save above has been read: the socket is ordered.
    send({ type: 'get_lists' });
    await waitFor((m) => m.type === 'lists');
    return set.current;
  });
  expect(workspace, 'the server must resolve the stub runtime, or nothing may be pressed').toBeTruthy();
  const scenario = path.join(workspace, 'stub-scenario.json');
  fs.writeFileSync(scenario, JSON.stringify({
    rules: [
      { match: { resume: true, promptIncludes: 'STALE-E2E-ASK', promptExcludes: 'DELEGATION BRIEF' },
        turn: [{ agentTool: { subagent_type: 'wren', description: 'Handing this to Wren.', prompt: 'STALE-E2E-BRIEF draft it' } }] },
      { match: { agent: 'wren', promptIncludes: 'STALE-E2E-BRIEF' }, turn: [{ text: 'Fresh draft from the lead.' }] },
      { match: { agent: 'wren', promptIncludes: 'STALE-E2E-AGAIN' }, turn: [{ text: 'Second pass from the lead.' }] },
    ],
    deadSessions: [DEAD],
  }));
  const sent = [];
  page.on('websocket', (socket) => socket.on('framesent', (f) => { try { sent.push(JSON.parse(f.payload)); } catch (e) { /* not JSON */ } }));
  const stored = () => {
    const all = JSON.parse(fs.readFileSync(path.join(workspace, '.rundock', 'conversations.json'), 'utf-8'));
    return all.find((c) => c.id === CONVO) || null;
  };
  try {
    await page.goto('/');
    await expect(page.locator('.convo-item').first()).toBeVisible();
    await page.evaluate((id) => openConversation(id), CONVO);
    await expect(page.locator('#view-chat')).toBeVisible();

    await page.locator('#msg-input').fill('STALE-E2E-ASK please draft');
    await page.locator('#send-btn').click();

    const messages = page.locator('#messages');
    await expect(messages).toContainText('Fresh draft from the lead.');
    // Naming the lead, whose earlier context is the part that is gone.
    await expect(messages).toContainText(/'s previous session expired\. Starting fresh\./);
    await expect(messages).not.toContainText('No conversation found');

    // What the window holds: the dead id is gone and the orchestrator's live
    // session is untouched.
    await expect.poll(() => page.evaluate(({ id, dead }) => {
      const c = conversations.find((x) => x.id === id);
      return { primary: c.sessionId, dead: (c.sessionIds || []).some((s) => s.sessionId === dead) };
    }, { id: CONVO, dead: DEAD })).toEqual({ primary: LIVE, dead: false });
    // What the server stores.
    await expect.poll(() => JSON.stringify(stored()).includes(DEAD)).toBe(false);

    // The next message goes to the recovered lead on its fresh session.
    await expect(page.locator('#send-btn')).not.toHaveClass(/\bcancel\b/);
    await page.locator('#msg-input').fill('STALE-E2E-AGAIN tighten it');
    await page.locator('#send-btn').click();
    await expect(messages).toContainText('Second pass from the lead.');
    const chats = sent.filter((m) => m.type === 'chat' && m.conversationId === CONVO);
    expect(chats.length).toBe(2);
    expect(chats[1].agent).toBe('wren');
    expect(chats[1].sessionId, 'the lead resumes its own fresh session').toBeTruthy();
    expect(chats.map((m) => m.sessionId)).not.toContain(DEAD);
    expect(chats[1].sessionId).not.toBe(LIVE);
  } finally {
    fs.rmSync(scenario, { force: true });
    // Leave the shared workspace as the next spec expects it.
    await page.evaluate((id) => deleteConversation(id, { stopPropagation() {} }), CONVO).catch(() => {});
  }
});
