'use strict';
// A pending approval card that another agent's reply moves, in the real client
// against the real server, clicked with the real mouse.
//
// THE DEFECT. A card that has just moved sits where the pointer may already be
// on its way to something else, so a click meant for whatever used to be there
// lands on the card's Allow. Every button on a card that moves waits half a
// second before it takes a click again.
//
// THE SCENE. One conversation, two agents. Wren is the conversation's agent
// and is replying; the card is asked by Cos, through the permission hook route
// with a token bound to this conversation and to Cos, which is the only route
// that lets the asker differ from the agent whose process is running (a turn's
// own hooks would carry Wren's token). The card is drawn at the bottom of a
// thread long enough to scroll, so the thread follows the bottom. The stub
// runtime holds Wren's reply at a gate file until the card has armed, then
// streams it in below the card, and following the bottom moves the card up by
// the height of the reply. Nothing else moves it: the reply is held again
// after its text, until the end of the test.
//
// WHAT IS ASSERTED. Right after the observed move, a click at the center of
// Allow, as measured after the move, sends no answer. Half a second after the
// move, a click at the same point sends exactly one answer, allowing it, and
// the server takes it before its timeout.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const credentials = require('./credentials.js');
const fx = require(path.join(__dirname, '..', 'fixtures', 'stream-json.js'));

const PORT = Number(process.env.E2E_PORT || 34517);
const STUB_VERSION = '2.1.318-stub';
// The conversation the hook token in credentials.js is issued for.
const ID = 'card-moves';
const MARK = 'CARD-MOVES-E2E';
// Long enough to overflow the thread at the default viewport, so a reply
// written below the card scrolls the thread and moves the card.
const PROMPT = [`${MARK} please run the script.`]
  .concat(Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long brief, so the thread scrolls.`))
  .join('\n');
// Short enough that the card stays on screen after it moves up.
const REPLY = 'Reading the scripts folder first.\n\nThen running the card moves script.';
// A move this size is the reply, never a rounding difference.
const MARGIN = 40;
const HALF_SECOND = 500;

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

// Everything the page has sent before this point has reached the test once
// this frame has: the socket and its frame events are ordered. The server
// ignores a message type it does not know.
async function sentSoFar(page, sent, n) {
  await page.evaluate((k) => ws.send(JSON.stringify({ type: 'approval-card-moves-marker', n: k })), n);
  await expect.poll(() => sent.some((m) => m.type === 'approval-card-moves-marker' && m.n === n), { intervals: [20] }).toBe(true);
}

test('a pending card moved by another agent\'s streaming reply ignores a click until half a second after the move', async ({ page }) => {
  const workspace = await overWs(async ({ send, waitFor }) => {
    send({ type: 'get_runtime_status' });
    const status = await waitFor((m) => m.type === 'runtime_status');
    if (!(status.claude && status.claude.version === STUB_VERSION)) return null;
    send({ type: 'get_workspaces' });
    const set = await waitFor((m) => m.type === 'workspaces' && m.current);
    send({ type: 'save_conversation', conversation: { id: ID, agentId: 'wren', title: 'Moved card', status: 'active', sessionIds: [] } });
    // Answered only after the save above has been read: the socket is ordered.
    send({ type: 'get_lists' });
    await waitFor((m) => m.type === 'lists');
    return set.current;
  });
  expect(workspace, 'the server must resolve the stub runtime, or nothing may be pressed').toBeTruthy();

  const gates = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-card-moves-'));
  const replyGate = path.join(gates, 'reply');
  const endGate = path.join(gates, 'end');
  const scenario = path.join(workspace, 'stub-scenario.json');
  // The block start is written before the first hold, so the page receiving it
  // means the process has started and written everything up to the hold.
  fs.writeFileSync(scenario, JSON.stringify({
    rules: [{ match: { agent: 'wren', promptIncludes: MARK }, turn: [
      { raw: fx.contentBlockStartText(0) },
      { holdUntil: replyGate },
      { raw: fx.textDelta(REPLY, 0) },
      { holdUntil: endGate },
      { raw: fx.contentBlockStop(0) },
    ] }],
  }));

  const sent = [];
  const received = [];
  page.on('websocket', (socket) => {
    socket.on('framesent', (f) => { try { sent.push(JSON.parse(f.payload)); } catch (e) { /* not JSON */ } });
    socket.on('framereceived', (f) => { try { received.push(JSON.parse(f.payload)); } catch (e) { /* not JSON */ } });
  });
  const answers = () => sent.filter((m) => m.type === 'permission_response');

  try {
    await page.goto('/');
    await expect(page.locator('.convo-item').first()).toBeVisible();
    // Switching away from a conversation before its history has arrived drops
    // it from the list, so whatever the page opened by itself finishes first.
    await expect.poll(() => page.evaluate(() => !document.getElementById('history-loading'))).toBe(true);
    await page.evaluate((id) => openConversation(id), ID);
    await expect.poll(() => page.evaluate(() => activeConversation && activeConversation.id)).toBe(ID);
    await expect(page.locator('#view-chat')).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => true));

    await page.locator('#msg-input').fill(PROMPT);
    await page.locator('#send-btn').click();

    // Wren's process is running this conversation's turn and is held before
    // its reply. A card raised before the page hears that the process started
    // would be cleared when it does.
    const started = (m) => m.type === 'stream_event' && m._conversationId === ID && m.event && m.event.type === 'content_block_start';
    await expect.poll(() => received.some(started), { intervals: [20], message: 'Wren started its turn' }).toBe(true);
    expect(received.find(started)._agent, 'the reply is Wren\'s').toBe('wren');

    // Raised as the hook raises it. The answer is awaited at the end.
    const told = fetch(`http://localhost:${PORT}/api/permission-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Rundock-Hook-Token': credentials.hookToken(ID) },
      body: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'sh scripts/card-moves.sh' }, conversation_id: ID }),
    }).then((r) => r.json()).catch(() => null);

    const card = page.locator('#messages .msg-permission');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.permission-origin'), 'asked by an agent other than the one replying').toHaveText('Asked by Cos');
    const askedFor = () => received.find((m) => m.type === 'control_request' && m._conversationId === ID);
    await expect.poll(() => Boolean(askedFor()), { message: 'the request reached the page' }).toBe(true);
    const asked = askedFor();
    expect(asked._agent, 'the server names Cos as the asker').toBe('default');
    const requestId = asked.request_id;
    const allow = card.locator('[data-perm-action="allow"]');
    await expect(allow).toHaveAttribute('data-perm-id', requestId);

    // Armed first: a card that has just appeared waits too, and this test is
    // about the wait a move starts, not that one.
    await expect.poll(() => card.locator('.btn-perm[aria-disabled]').count(), { intervals: [20], message: 'the new card arms' }).toBe(0);
    expect(await card.locator('.btn-perm').count(), 'the card has buttons to click').toBeGreaterThan(0);

    // Watched independently of the page's own watcher: the first change in the
    // card's position is recorded with the center of Allow where it is now,
    // whether the point there is Allow, and the reply that caused it. Every
    // click is recorded as the document sees it, before any handler.
    const before = await page.evaluate(({ id, snippet }) => {
      const host = document.getElementById('messages');
      const button = [...host.querySelectorAll('[data-perm-action="allow"]')].find((b) => b.dataset.permId === id);
      const moving = button.closest('.msg-permission');
      const base = moving.getBoundingClientRect().top;
      const state = { base, move: null, clicks: [] };
      const look = () => {
        if (state.move) return;
        const top = moving.getBoundingClientRect().top;
        if (Math.abs(top - base) < 2) return;
        const r = button.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const there = document.elementFromPoint(x, y);
        const replies = [...host.querySelectorAll('.msg-agent')];
        const reply = replies[replies.length - 1];
        state.move = {
          at: performance.now(), top, x, y,
          hit: Boolean(there && button.contains(there)),
          replyBelow: Boolean(reply && (moving.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING) && reply.textContent.includes(snippet)),
        };
      };
      new MutationObserver(look).observe(host, { childList: true, subtree: true, characterData: true, attributes: true });
      host.addEventListener('scroll', look);
      document.addEventListener('click', (e) => {
        state.clicks.push({
          at: performance.now(),
          onAllow: Boolean(e.target && e.target.closest && e.target.closest('[data-perm-action="allow"]') === button),
          waiting: button.getAttribute('aria-disabled') === 'true',
        });
      }, true);
      window.cardMovesWatch = state;
      return { base, overflow: host.scrollHeight - host.clientHeight, following: !userScrolledUp };
    }, { id: requestId, snippet: 'Reading the scripts folder first.' });
    expect(before.overflow, 'the thread is long enough to scroll').toBeGreaterThan(0);
    expect(before.following, 'the thread follows the bottom').toBe(true);

    // The reply streams in below the card and the thread follows it.
    fs.writeFileSync(replyGate, '');
    const moved = await (await page.waitForFunction(() => window.cardMovesWatch.move, null, { polling: 'raf', timeout: 5000 })).jsonValue();
    await page.mouse.click(moved.x, moved.y);
    await expect.poll(() => page.evaluate(() => window.cardMovesWatch.clicks.length), { intervals: [20] }).toBe(1);
    const first = await page.evaluate(() => window.cardMovesWatch.clicks[0]);

    expect(moved.replyBelow, 'the move came from the reply written below the card').toBe(true);
    expect(before.base - moved.top, 'the card moved up by a clear margin').toBeGreaterThan(MARGIN);
    expect(moved.hit, 'the point clicked is Allow, on screen and uncovered, after the move').toBe(true);
    expect(first.onAllow, 'the click landed on Allow').toBe(true);
    const soon = first.at - moved.at;
    expect(soon, 'clicked within half a second of the move').toBeLessThan(HALF_SECOND);
    await sentSoFar(page, sent, 1);
    expect(answers(), `a click ${Math.round(soon)} ms after the card moved must send nothing (Allow ${first.waiting ? 'was' : 'was not'} marked as waiting)`).toEqual([]);

    // Half a second after the move, the same point takes the click.
    await page.waitForFunction(({ at, id, ms }) => {
      const button = [...document.querySelectorAll('#messages [data-perm-action="allow"]')].find((b) => b.dataset.permId === id);
      return performance.now() >= at + ms && Boolean(button) && button.getAttribute('aria-disabled') !== 'true';
    }, { at: moved.at, id: requestId, ms: HALF_SECOND }, { polling: 'raf', timeout: 3000 });
    const still = await page.evaluate(({ id }) => {
      const button = [...document.querySelectorAll('#messages [data-perm-action="allow"]')].find((b) => b.dataset.permId === id);
      return button.closest('.msg-permission').getBoundingClientRect().top;
    }, { id: requestId });
    expect(Math.abs(still - moved.top), 'nothing moved the card again').toBeLessThanOrEqual(1);
    await page.mouse.click(moved.x, moved.y);
    await expect.poll(() => page.evaluate(() => window.cardMovesWatch.clicks.length), { intervals: [20] }).toBe(2);
    const second = await page.evaluate(() => window.cardMovesWatch.clicks[1]);
    expect(second.onAllow, 'the second click landed on Allow').toBe(true);
    expect(second.at - moved.at, 'clicked at least half a second after the move').toBeGreaterThanOrEqual(HALF_SECOND);
    await expect.poll(() => answers().length, { intervals: [20], message: 'the second click answers the card' }).toBeGreaterThan(0);
    await sentSoFar(page, sent, 2);
    expect(answers().map((m) => ({ requestId: m.requestId, allow: m.allow })), 'exactly one answer, allowing this card').toEqual([{ requestId, allow: true }]);
    expect(await told, 'the server took the answer before its timeout').toEqual({ allow: true, card: true });
  } finally {
    // The held turn is let go and finished before the conversation is deleted,
    // so the page has nothing left to save for it afterwards.
    fs.writeFileSync(replyGate, '');
    fs.writeFileSync(endGate, '');
    await expect.poll(() => received.some((m) => m.type === 'result' && m._conversationId === ID), { timeout: 5000 }).toBe(true).catch(() => {});
    await expect(page.locator('#send-btn')).not.toHaveClass(/\bcancel\b/, { timeout: 5000 }).catch(() => {});
    await page.evaluate((id) => deleteConversation(id, { stopPropagation() {} }), ID).catch(() => {});
    const deleted = await expect.poll(() => received.some((m) => m.type === 'conversation_deleted' && m.id === ID), { timeout: 3000 }).toBe(true).then(() => true, () => false);
    if (!deleted) {
      await overWs(async ({ send, waitFor }) => {
        send({ type: 'delete_conversation', id: ID });
        await waitFor((m) => m.type === 'conversation_deleted' && m.id === ID);
      }).catch(() => {});
    }
    fs.rmSync(scenario, { force: true });
    // Deleting keeps the conversation's transcript on disk, so it goes too.
    fs.rmSync(path.join(workspace, '.rundock', 'transcripts', `${ID}.json`), { force: true });
    fs.rmSync(gates, { recursive: true, force: true });
  }
});
