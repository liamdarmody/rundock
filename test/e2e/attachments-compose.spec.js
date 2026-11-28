'use strict';
// Attaching files to a message in the real client against the real server:
// the + button's file input, the chips, the send, the server's answer and
// the bubble drawn from the stored text. Then a pick of six files, refused
// whole with the composer left as it was.
//
// IN A CONVERSATION OF ITS OWN, created here and deleted afterwards, with its
// files written to a temporary folder of this test's own: the specs share one
// server and one workspace. Deleting the conversation removes its stored
// attachments too.
const base = require('@playwright/test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendRawCoverage, writeLcov, isClientEntry } = require('./coverage.js');
const store = require('../../lib/attachments/store.js');

const test = base.test.extend({
  page: async ({ page }, use) => {
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await use(page);
    const entries = await page.coverage.stopJSCoverage();
    appendRawCoverage(entries.filter(e => isClientEntry(e.url)));
  },
});
const { expect } = base;

test.afterAll(async () => { await writeLcov(); });

// A one-pixel PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

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

// The workspace the server is serving, as the page holds it.
async function workspaceDir(page) {
  return page.evaluate(() => currentWorkspacePath);
}

function fixtureFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-attach-'));
  const write = (name, bytes) => { const file = path.join(dir, name); fs.writeFileSync(file, bytes); return file; };
  return {
    dir,
    png: write('pixel.png', PNG),
    txt: write('notes.txt', 'A few lines of notes.\n'),
    six: [1, 2, 3, 4, 5, 6].map((n) => write(`part-${n}.txt`, `Part ${n}.\n`)),
  };
}

test('files attached through the + button are sent with the message, drawn from the stored text, and a pick of six is refused whole', async ({ page }) => {
  const files = fixtureFiles();
  let convoId = null;
  try {
    const stored = collectStored(page);
    await page.goto('/');
    await expect(page.locator('.convo-item').first()).toBeVisible();
    convoId = await page.evaluate(() => createConversation('default', 'Attachments e2e').id);
    await expect(page.locator('#view-chat')).toBeVisible();

    const input = page.locator('#msg-input');
    const sendBtn = page.locator('#send-btn');
    const chips = page.locator('#composer-chips .composer-chip');
    const picker = page.locator('#attach-input');
    await expect(page.locator('#attach-btn')).toBeVisible();

    await picker.setInputFiles([files.png, files.txt]);
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toContainText('pixel.png');
    await expect(chips.nth(1)).toContainText('notes.txt');

    await input.fill('see these');
    await expect(sendBtn).toHaveClass(/\bactive\b/);
    await sendBtn.click();

    const bubble = page.locator('#messages .msg-user').last();
    await expect(bubble).toContainText('see these');
    // The bubble draws the files, in the order picked, in place of their lines.
    await expect(bubble.locator('.msg-files > *')).toHaveCount(2);
    await expect(bubble.locator('.msg-files > *').nth(0)).toHaveAttribute('aria-label', 'Open pixel.png');
    await expect(bubble.locator('.msg-files > *').nth(1)).toHaveAttribute('aria-label', 'notes.txt');
    await expect(bubble).not.toContainText('[Attached: ');
    // The entry the answer reports is the one on record, each line of the
    // stored text names one of its files, and each stored copy is the picked
    // file, byte for byte.
    await expect.poll(() => stored.filter((m) => m.conversationId === convoId).length).toBe(1);
    const { entry, content } = stored.find((m) => m.conversationId === convoId);
    // Each line names the stored copy, in the order picked, with its kind and size.
    expect(content).toMatch(/\[Attached: \.rundock\/attachments\/\d+\/1-pixel\.png \(PNG image, \d+ KB\)\]/);
    expect(content).toMatch(/\[Attached: \.rundock\/attachments\/\d+\/2-notes\.txt \(text file, \d+ KB\)\]/);
    const workspace = await workspaceDir(page);
    expect(store.readRecord(workspace, convoId).messages).toEqual([entry]);
    const picked = { 'pixel.png': fs.readFileSync(files.png), 'notes.txt': fs.readFileSync(files.txt) };
    expect(entry.files.map((f) => f.name)).toEqual(['pixel.png', 'notes.txt']);
    // The stored text's lines, in order, each the text after its '[Attached: '.
    const lines = content.split('[Attached: ').slice(1);
    expect(lines).toHaveLength(entry.files.length);
    for (const [i, f] of entry.files.entries()) {
      const names = `.rundock/attachments/${convoId}/${f.file} (`;
      expect(lines[i].slice(0, names.length)).toBe(names);
      const copy = fs.readFileSync(path.join(workspace, '.rundock', 'attachments', convoId, f.file));
      expect(copy.equals(picked[f.name])).toBe(true);
      expect(f.bytes).toBe(picked[f.name].length);
      expect(f.sha256).toBe(sha256(picked[f.name]));
      expect(store.checkRecordedFile(workspace, convoId, f.file)).toBe('present');
    }
    await expect(input).toHaveValue('');
    await expect(chips).toHaveCount(0);
    // The turn the send started runs to its end before the next pick.
    await expect(sendBtn).not.toHaveClass(/\bcancel\b/);

    await picker.setInputFiles(files.six);
    const notice = page.locator('#composer-notice');
    await expect(notice).toContainText('6 files not added');
    await expect(chips).toHaveCount(0);
    await expect(input).toHaveValue('');
  } finally {
    if (convoId) await page.evaluate((id) => deleteConversation(id, { stopPropagation() {} }), convoId).catch(() => {});
    fs.rmSync(files.dir, { recursive: true, force: true });
  }
});
