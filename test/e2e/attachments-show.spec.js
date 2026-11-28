'use strict';
// A sent message's files in the real client against the real server: a PNG
// and a PDF sent, drawn in the bubble as a thumbnail and a chip, each opened
// larger from the keyboard and closed with Escape back to its button. Then a
// follow-up, a reload that draws the same from the history, and, once the
// PNG is deleted, a reload that shows it as not available.
//
// IN A CONVERSATION OF ITS OWN, created here and deleted afterwards, with its
// files written to a temporary folder of this test's own: the specs share one
// server and one workspace. Deleting the conversation removes its stored
// attachments too, and its transcript is removed here.
const base = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { appendRawCoverage, writeLcov, isClientEntry } = require('./coverage.js');

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

// A real, decodable solid PNG of the given size, so the thumbnail's image can
// be seen to have been served and decoded.
function buildPng(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit depth, truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x4a)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');

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

function fixtureFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-show-'));
  const write = (name, bytes) => { const file = path.join(dir, name); fs.writeFileSync(file, bytes); return file; };
  return { dir, png: write('diagram.png', buildPng(320, 200)), pdf: write('report.pdf', PDF) };
}

const TEXT = 'the diagram and the report';

// The bubble the files were sent in, as its files and its text.
async function expectBothFiles(page) {
  const bubble = page.locator('#messages .msg-user', { hasText: TEXT });
  await expect(bubble).toHaveCount(1);
  await expect(bubble.locator('.msg-files > *')).toHaveCount(2);
  const thumb = bubble.locator('.msg-files > button.msg-thumb');
  await expect(thumb).toHaveAttribute('aria-label', 'Open diagram.png');
  const img = thumb.locator('img');
  await expect(img).toHaveAttribute('alt', 'diagram.png');
  await expect(img).toHaveAttribute('width', '224');
  await expect(img).toHaveAttribute('height', '140');
  // Served by the file route and decoded, at its own size.
  await expect.poll(() => img.evaluate((node) => node.naturalWidth)).toBe(320);
  const chip = bubble.locator('.msg-files > button.att-chip');
  await expect(chip).toHaveAttribute('aria-label', 'Open report.pdf');
  await expect(chip.locator('.att-name')).toHaveText('report.pdf');
  await expect(chip.locator('.att-meta')).toHaveText(/^PDF · \d+ KB$/);
  await expect(bubble).not.toContainText('[Attached: ');
  return { bubble, thumb, chip };
}

// Focus the button, open it with the key, check what the open file shows, and
// close it with Escape back to the button.
async function openAndClose(page, button, key, name, shows) {
  await button.focus();
  await page.keyboard.press(key);
  const dialog = page.locator('.sent-file[role="dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-label', name);
  await expect(dialog.locator('.sent-file-name')).toHaveText(name);
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
  await shows(dialog);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();
}

// The image shown larger by its name, served and decoded at its own size.
const showsImage = async (dialog) => {
  const image = dialog.locator('img');
  await expect(image).toHaveAttribute('alt', 'diagram.png');
  await expect.poll(() => image.evaluate((node) => node.naturalWidth)).toBe(320);
};

// The PDF in a frame on the file route.
const showsPdf = (convoId, file) => async (dialog) => {
  await expect(dialog.locator('iframe')).toHaveAttribute('src',
    `/workspace-file?path=${encodeURIComponent(`.rundock/attachments/${convoId}/${file}`)}#navpanes=0`);
};

async function reopen(page, convoId) {
  await page.reload();
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await page.evaluate((id) => openConversation(id), convoId);
  await expect(page.locator('#view-chat')).toBeVisible();
}

test('a sent PNG and PDF show in their bubble, open larger and close back to their button, after a reload too, and a deleted file shows as not available', async ({ page }) => {
  const files = fixtureFiles();
  let convoId = null;
  let workspace = null;
  try {
    const stored = collectStored(page);
    await page.goto('/');
    await expect(page.locator('.convo-item').first()).toBeVisible();
    convoId = await page.evaluate(() => createConversation('default', 'Sent files e2e').id);
    workspace = await page.evaluate(() => currentWorkspacePath);
    await expect(page.locator('#view-chat')).toBeVisible();

    const input = page.locator('#msg-input');
    const sendBtn = page.locator('#send-btn');
    await page.locator('#attach-input').setInputFiles([files.png, files.pdf]);
    await expect(page.locator('#composer-chips .composer-chip')).toHaveCount(2);
    await input.fill(TEXT);
    await sendBtn.click();
    await expect.poll(() => stored.filter((m) => m.conversationId === convoId).length).toBe(1);
    const { entry } = stored.find((m) => m.conversationId === convoId);
    expect(entry.files.map((f) => f.name)).toEqual(['diagram.png', 'report.pdf']);

    // As sent: the thumbnail opens with Enter and shows the image by its name,
    // the chip opens with Space and shows the PDF in a frame.
    const showsReport = showsPdf(convoId, entry.files[1].file);
    let shown = await expectBothFiles(page);
    await openAndClose(page, shown.thumb, 'Enter', 'diagram.png', showsImage);
    await openAndClose(page, shown.chip, 'Space', 'report.pdf', showsReport);

    // A follow-up of text alone is drawn as text.
    await expect(sendBtn).not.toHaveClass(/\bcancel\b/);
    await input.fill('and one more thing');
    await sendBtn.click();
    const followUp = page.locator('#messages .msg-user', { hasText: 'and one more thing' });
    await expect(followUp).toHaveCount(1);
    await expect(followUp.locator('.msg-files')).toHaveCount(0);
    await expect(sendBtn).not.toHaveClass(/\bcancel\b/);

    // After a reload, the history draws the same.
    await reopen(page, convoId);
    shown = await expectBothFiles(page);
    await openAndClose(page, shown.thumb, 'Enter', 'diagram.png', showsImage);
    await openAndClose(page, shown.chip, 'Space', 'report.pdf', showsReport);

    // The PNG deleted and the page reloaded: in its place, not available.
    fs.rmSync(path.join(workspace, '.rundock', 'attachments', convoId, entry.files[0].file));
    await reopen(page, convoId);
    const bubble = page.locator('#messages .msg-user', { hasText: TEXT });
    await expect(bubble.locator('.msg-files > *')).toHaveCount(2);
    await expect(bubble.locator('.msg-thumb')).toHaveCount(0);
    const gone = bubble.locator('.msg-files > .att-chip.gone');
    await expect(gone.locator('.att-name')).toHaveText('diagram.png');
    await expect(gone.locator('.att-meta')).toHaveText('File not available');
    await expect(bubble.locator('.msg-files > button.att-chip')).toHaveAttribute('aria-label', 'Open report.pdf');
  } finally {
    if (convoId) await page.evaluate((id) => deleteConversation(id, { stopPropagation() {} }), convoId).catch(() => {});
    // Deleting keeps the conversation's transcript on disk, so it goes too.
    if (convoId && workspace) fs.rmSync(path.join(workspace, '.rundock', 'transcripts', `${convoId}.json`), { force: true });
    fs.rmSync(files.dir, { recursive: true, force: true });
  }
});
