'use strict';
// Pasting and dropping files into the composer in the real client against the
// real server: two screenshots pasted with text beside them, files dropped on
// the field and over the messages, a file let go on the sidebar, the messages
// for files Rundock can't take, a PDF held for an agent on Codex, and the
// stored name of a pasted image.
//
// IN CONVERSATIONS OF THEIR OWN, created here and deleted afterwards: the
// specs share one server and one workspace. Deleting a conversation removes
// its stored attachments too. The agent on Codex is written into the
// workspace's .claude/agents/ for this spec and removed afterwards, and the
// server's roster is read until it no longer lists it.
const base = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const credentials = require('./credentials.js');
const { appendRawCoverage, writeLcov, isClientEntry } = require('./coverage.js');
const { typed, ftyp } = require('../helpers/attachment-bytes.js');

const test = base.test.extend({
  page: async ({ page }, use) => {
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await use(page);
    const entries = await page.coverage.stopJSCoverage();
    appendRawCoverage(entries.filter(e => isClientEntry(e.url)));
  },
});
const { expect } = base;

const PORT = Number(process.env.E2E_PORT || 34517);
const STUB_VERSION = '2.1.318-stub';

// A one-pixel PNG, whole, so the browser's clipboard takes it as an image.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const HEIC = 'Rundock can\'t attach HEIC photos. Save it as JPEG or PNG first.';
const CODEX_PDF = 'This agent runs on Codex, which can\'t read PDFs yet. Attach a screenshot of the page or paste the text.';
const READER = 'paste-drop-reader';
const READER_FILE = [
  '---',
  `name: ${READER}`,
  'displayName: Reader',
  'role: Example Specialist',
  'type: specialist',
  'order: 9',
  'runtime: codex',
  'tools: Read',
  '---',
  '',
  'You read what you are given.',
  '',
].join('\n');

// A file the picker takes, by name and bytes.
const asUpload = (name, bytes) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });

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

// The server's roster as it stands, read over a socket of its own.
const rosterRuntime = () => overWs(async ({ send, waitFor }) => {
  send({ type: 'get_agents' });
  const roster = await waitFor((m) => m.type === 'agents');
  const reader = roster.agents.find((a) => a.id === READER);
  return reader ? reader.runtime : null;
});

let workspace = null;
const readerPath = () => path.join(workspace, '.claude', 'agents', `${READER}.md`);

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

test.afterAll(async () => {
  if (workspace) {
    fs.rmSync(readerPath(), { force: true });
    // Leave the server's roster as the next spec expects it. Its caches
    // expire on their own, so this reads until they have.
    await expect.poll(rosterRuntime, { timeout: 15000 }).toBe(null);
  }
  await writeLcov();
});

// Every chat_stored answer the page receives, oldest first. Registered before
// the page loads so no frame is missed.
function collectStored(page) {
  const stored = [];
  page.on('websocket', (socket) => {
    socket.on('framereceived', (frame) => {
      try {
        const msg = JSON.parse(frame.payload);
        if (msg && msg.type === 'chat_stored') stored.push(msg);
      } catch (e) { /* binary or non-JSON frame */ }
    });
  });
  return stored;
}

async function openNewConversation(page, title, agent = 'default') {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  const id = await page.evaluate(([a, t]) => createConversation(a, t).id, [agent, title]);
  await expect(page.locator('#view-chat')).toBeVisible();
  return id;
}

const deleteConvo = (page, id) => page.evaluate((c) => deleteConversation(c, { stopPropagation() {} }), id).catch(() => {});

// A drag of one file onto `selector`, built as the browser builds it: the
// field's box before the drag and while it is marked, and whether the drop's
// default was prevented.
function dropOn(page, selector, name, bytes) {
  return page.evaluate(([sel, fileName, data]) => {
    const target = document.querySelector(sel);
    const field = document.querySelector('#view-chat .composer-field');
    const box = () => { const r = field.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(data)], fileName, { type: '' }));
    const fire = (type) => {
      const event = new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    };
    const before = box();
    fire('dragenter');
    fire('dragover');
    const marked = field.classList.contains('drop');
    const during = box();
    const drop = fire('drop');
    return { before, during, marked, prevented: drop.defaultPrevented };
  }, [selector, name, Array.from(bytes)]);
}

test('two pasted screenshots are "Pasted image" and "Pasted image 2", the text goes into the field, and the first is stored as 1-Pasted_image.png', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const stored = collectStored(page);
  const convoId = await openNewConversation(page, 'Paste e2e');
  try {
    const input = page.locator('#msg-input');
    const chips = page.locator('#composer-chips .composer-chip-name');
    await input.click();
    await page.evaluate(async (bytes) => {
      const image = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
      const text = new Blob(['see '], { type: 'text/plain' });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': image, 'text/plain': text })]);
    }, Array.from(PNG));
    await page.keyboard.press('ControlOrMeta+v');
    await expect(chips).toHaveText(['Pasted image']);
    await expect(input).toHaveValue('see ');
    await page.keyboard.press('ControlOrMeta+v');
    await expect(chips).toHaveText(['Pasted image', 'Pasted image 2']);
    await expect(input).toHaveValue('see see ');

    await input.press('Enter');
    await expect.poll(() => stored.filter((m) => m.conversationId === convoId).length).toBe(1);
    const { content } = stored.find((m) => m.conversationId === convoId);
    expect(content).toMatch(new RegExp(`\\[Attached: \\.rundock/attachments/${convoId}/1-Pasted_image\\.png \\(PNG image, `));
    expect(content).toMatch(new RegExp(`\\[Attached: \\.rundock/attachments/${convoId}/2-Pasted_image_2\\.png \\(PNG image, `));
    await expect(page.locator('#send-btn')).not.toHaveClass(/\bcancel\b/);
  } finally {
    await deleteConvo(page, convoId);
  }
});

test('a file dropped on the field or over the messages is added with the field\'s box unchanged, and one let go on the sidebar opens nothing', async ({ page }) => {
  const convoId = await openNewConversation(page, 'Drop e2e');
  try {
    const chips = page.locator('#composer-chips .composer-chip-name');

    const onField = await dropOn(page, '#view-chat .composer-field', 'field.png', PNG);
    expect(onField.marked).toBe(true);
    expect(onField.during).toEqual(onField.before);
    expect(onField.prevented).toBe(true);
    await expect(chips).toHaveText(['field.png']);

    const overMessages = await dropOn(page, '#messages', 'notes.txt', typed('notes.txt', 40));
    expect(overMessages.marked).toBe(true);
    expect(overMessages.during).toEqual(overMessages.before);
    await expect(chips).toHaveText(['field.png', 'notes.txt']);
    await expect(page.locator('#view-chat .composer-field.drop')).toHaveCount(0);

    const onSidebar = await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['words'], 'stray.txt', { type: 'text/plain' }));
      const target = document.querySelector('.sidebar');
      target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      const drop = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
      target.dispatchEvent(drop);
      return drop.defaultPrevented;
    });
    expect(onSidebar).toBe(true);
    await expect(chips).toHaveText(['field.png', 'notes.txt']);
  } finally {
    await deleteConvo(page, convoId);
  }
});

test('a HEIC photo is refused as it is added, two refusals stack, and each is dismissed', async ({ page }) => {
  const convoId = await openNewConversation(page, 'Refusals e2e');
  try {
    const picker = page.locator('#attach-input');
    const items = page.locator('#composer-notice .composer-notice-item');
    await picker.setInputFiles([asUpload('photo.heic', ftyp('heic'))]);
    await expect(items).toHaveCount(1);
    await expect(items.nth(0).locator('.composer-notice-title')).toHaveText('photo.heic');
    await expect(items.nth(0).locator('.composer-notice-text')).toHaveText(HEIC);
    await expect(page.locator('#composer-chips .composer-chip')).toHaveCount(0);

    await picker.setInputFiles([asUpload('second.heic', ftyp('heix'))]);
    await expect(items.locator('.composer-notice-title')).toHaveText(['photo.heic', 'second.heic']);

    await items.nth(0).locator('.composer-notice-dismiss').click();
    await expect(items.locator('.composer-notice-title')).toHaveText(['second.heic']);
    await items.nth(0).locator('.composer-notice-dismiss').click();
    await expect(items).toHaveCount(0);
    await expect(page.locator('#msg-input')).toBeFocused();
  } finally {
    await deleteConvo(page, convoId);
  }
});

test('a PDF for an agent on Codex holds Send disabled until it is removed', async ({ page }) => {
  expect(workspace, 'the server must resolve the stub runtime, or nothing may be written').toBeTruthy();
  fs.writeFileSync(readerPath(), READER_FILE);
  await expect.poll(rosterRuntime, { timeout: 15000 }).toBe('codex');
  const convoId = await openNewConversation(page, 'Codex hold e2e', READER);
  try {
    const sendBtn = page.locator('#send-btn');
    const chip = page.locator('#composer-chips .composer-chip');
    await page.locator('#msg-input').fill('read this');
    await page.locator('#attach-input').setInputFiles([asUpload('brief.pdf', typed('brief.pdf', 64))]);
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveClass(/\bwarn\b/);
    await expect(sendBtn).toBeDisabled();
    await expect(page.locator('#composer-notice .composer-notice-text')).toHaveText(CODEX_PDF);

    await chip.locator('.composer-chip-remove').click();
    await expect(chip).toHaveCount(0);
    await expect(sendBtn).toBeEnabled();
    await expect(page.locator('#composer-notice .composer-notice-item')).toHaveCount(0);
  } finally {
    await deleteConvo(page, convoId);
  }
});
