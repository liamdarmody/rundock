'use strict';
// The week editor's day boxes in a real engine: the order Tab takes them in,
// Space on a focused box, and where the row sits at a narrow width.
//
// Built the way routines-keyboard.spec.js is. One routine is written through
// the real save road over the spec's own socket, on a weekly slot three days
// out, so the live scheduler cannot fire it during the spec, and it is taken
// back afterwards: the server and its workspace are shared with the specs that
// run after this one. Edit schedule opens the editor on it, on week with that
// one day ticked. Nothing here saves: boxes are pressed and the editor is left.
const { test, expect } = require('@playwright/test');
const WebSocket = require('ws');
const credentials = require('./credentials.js');

const PORT = Number(process.env.E2E_PORT || 34517);
const BY_GET_DAY = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEK = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY = BY_GET_DAY[(new Date().getDay() + 3) % 7];
const ROUTINE = { agentId: 'wren', name: 'Days keyboard', prompt: 'days e2e body', schedule: `every ${DAY} at 07:00` };

// One WS session from the test's own process.
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

const line = (page) => page.locator('[data-routine-editor="sentence"]');
const focusedDay = (page) => page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-routine-day'));

async function openWeek(page) {
  await page.goto('/');
  await page.click('.nav-item[data-nav="routines"]');
  const row = page.locator('.routine-row', { hasText: ROUTINE.name });
  await expect(row).toBeVisible();
  await row.locator('[data-routines-action="edit"]').click();
  await expect(page.locator('select[data-routine-field="frequency"]')).toHaveValue('week');
  await expect(page.locator('.re-days [data-routine-day]')).toHaveCount(7);
  await expect(page.locator(`[data-routine-day="${DAY}"]`)).toBeChecked();
}

test.describe('the days of a week, in a real engine', () => {
  test.beforeAll(async () => {
    await overWs(async ({ send, waitFor }) => {
      const { agentId, name, schedule, prompt } = ROUTINE;
      send({ type: 'save_routine', agentId, routine: { name, schedule, prompt, runOn: 'local' } });
      await waitFor(m => m.type === 'routine_saved' && m.name === name);
    });
  });
  test.afterAll(async () => {
    await overWs(async ({ send, waitFor }) => {
      send({ type: 'delete_routine', agentId: ROUTINE.agentId, name: ROUTINE.name, occurrence: 0 });
      await waitFor(m => m.type === 'routine_deleted' && m.name === ROUTINE.name);
    });
  });

  test('Tab takes the seven boxes in order, Monday to Sunday', async ({ page }) => {
    await openWeek(page);
    await page.locator('select[data-routine-field="time"]').focus();
    const order = [];
    for (let i = 0; i < 7; i++) {
      await page.keyboard.press('Tab');
      order.push(await focusedDay(page));
    }
    expect(order).toEqual(WEEK);
  });

  test('Space on a focused box ticks it, and the line under the sentence follows', async ({ page }) => {
    await openWeek(page);
    const other = WEEK.find(d => d !== DAY);
    const box = page.locator(`[data-routine-day="${other}"]`);
    const before = await line(page).textContent();
    await expect(box).not.toBeChecked();
    await box.focus();
    await page.keyboard.press('Space');
    await expect(box).toBeChecked();
    await expect(line(page)).not.toHaveText(before);
    expect(await focusedDay(page), 'the focus stays on the box that was pressed').toBe(other);
    await page.keyboard.press('Space');
    await expect(box).not.toBeChecked();
    await expect(line(page)).toHaveText(before);
  });

  // The row sits under the sentence, inside the card, at any width. At 1400
  // the seven boxes take one line. At 820 the panels beside the editor keep
  // their width and the card is left too narrow for that, so the boxes wrap,
  // and they have to stay in the card while they do.
  test('at a narrow width the row sits below the sentence, inside its card', async ({ page }) => {
    const measure = () => page.evaluate(() => {
      const card = document.querySelector('.re-sentence');
      const days = document.querySelector('.re-days');
      const box = (el) => el.getBoundingClientRect();
      const c = box(card);
      const d = box(days);
      const sentenceBottom = Math.max(...[...card.children].filter(el => el !== days).map(el => box(el).bottom));
      const within = (r) => r.left >= c.left - 0.5 && r.right <= c.right + 0.5 && r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5;
      const labels = [...days.querySelectorAll('.re-day')];
      return {
        lines: new Set(labels.map(el => Math.round(box(el).top))).size,
        place: {
          inCard: days.parentElement === card,
          below: d.top >= sentenceBottom - 0.5,
          rowWithin: within(d),
          boxesWithin: labels.every(el => within(box(el))),
          pageScrolls: document.documentElement.scrollWidth > window.innerWidth,
        },
      };
    });
    const placed = { inCard: true, below: true, rowWithin: true, boxesWithin: true, pageScrolls: false };

    await page.setViewportSize({ width: 1400, height: 900 });
    await openWeek(page);
    const wide = await measure();
    expect(wide.lines, 'sanity: at full width the seven boxes fit on one line').toBe(1);
    expect(wide.place, 'at full width').toEqual(placed);

    await page.setViewportSize({ width: 820, height: 640 });
    const narrow = await measure();
    expect(narrow.place, 'at a narrow width').toEqual(placed);
    expect(narrow.lines, 'sanity: at this width the boxes wrap, which is the case being checked').toBeGreaterThan(1);
  });
});
