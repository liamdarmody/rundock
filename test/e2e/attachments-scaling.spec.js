'use strict';
// Images fitted to the limits in the real client, through the browser's own
// canvas, and stored by the real server: a large flat PNG scaled to 2,576 px,
// an opaque photo of noise re-encoded as JPEG under its own name, an image
// with see-through pixels stepped down to 1,568 px and kept as PNG, and an
// animated GIF marked "First frame only". Then an image chip's preview, which
// loads, and whose URL stops loading once the chip is removed.
//
// IN CONVERSATIONS OF THEIR OWN, created here and deleted afterwards, with
// the images written to a temporary folder of this spec's own: the specs share
// one server and one workspace. Deleting a conversation removes its stored
// attachments too. Every image is built here.
const base = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { appendRawCoverage, writeLcov, isClientEntry } = require('./coverage.js');
const { gifOf } = require('../helpers/attachment-bytes.js');
const { detectFile } = require('../../lib/attachments/detect.js');

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

const LIMIT = 3500000;

// ===== IMAGES, BUILT HERE =====

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// A PNG of `width` by `height`, RGB or, with `alpha`, RGBA, whose pixel bytes
// `fill(raw, stride, channels)` writes into rows that each start with a zero
// filter byte.
function pngFile(width, height, alpha, fill) {
  const channels = alpha ? 4 : 3;
  const stride = width * channels + 1;
  const raw = Buffer.alloc(stride * height);
  fill(raw, stride, channels);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// One color, opaque.
const flatPng = (width, height) => pngFile(width, height, false, (raw, stride) => {
  for (let at = 0; at < raw.length; at += stride) raw.fill(Buffer.from([0x3b, 0x6f, 0xd1]), at + 1, at + stride);
});

// Noise from a seeded generator, so a run builds the same bytes each time.
// With `alpha`, every pixel is see-through, its alpha between 160 and 254.
function noisePng(width, height, alpha, seed = 1) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) & 0xff;
  };
  return pngFile(width, height, alpha, (raw, stride, channels) => {
    for (let at = 0; at < raw.length; at += stride) {
      for (let i = at + 1; i < at + stride; i++) raw[i] = alpha && (i - at) % channels === 0 ? 160 + (next() % 95) : next();
    }
  });
}

// ===== THE PAGE =====

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

async function openNewConversation(page, title) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  const id = await page.evaluate((t) => createConversation('default', t).id, title);
  await expect(page.locator('#view-chat')).toBeVisible();
  return id;
}

const deleteConvo = (page, id) => page.evaluate((c) => deleteConversation(c, { stopPropagation() {} }), id).catch(() => {});

// The size of `bytes` encoded as PNG by the page's own codec with its longest
// edge at each of `edges`, and whether the codec read it as opaque.
function encodedSizes(page, bytes, edges) {
  return page.evaluate(async ([data, steps]) => {
    const raw = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const { codec } = RundockAttachmentScale;
    const decoded = await codec.decode(new File([raw], 'probe.png', { type: 'image/png' }));
    const longest = Math.max(decoded.width, decoded.height);
    const sizes = [];
    for (const edge of steps) {
      const blob = await codec.encode(decoded.source, Math.round((decoded.width * edge) / longest), Math.round((decoded.height * edge) / longest), 'image/png');
      sizes.push(blob.size);
    }
    decoded.source.close();
    return { opaque: decoded.opaque, sizes };
  }, [bytes.toString('base64'), edges]);
}

// An image with see-through pixels whose PNG, as this browser encodes it, is
// over the limit at 2,048 px and under it at 1,568 px: noise 2,576 px wide,
// at the first of these heights that gives both.
async function seeThroughFixture(page) {
  const tried = [];
  for (const height of [734, 840, 640, 960, 560]) {
    const bytes = noisePng(2576, height, true);
    const { opaque, sizes } = await encodedSizes(page, bytes, [2048, 1568]);
    tried.push({ height, opaque, sizes });
    if (!opaque && sizes[0] > LIMIT && sizes[1] <= LIMIT) return bytes;
  }
  throw new Error(`no noise image was over the limit at 2,048 px and under it at 1,568 px: ${JSON.stringify(tried)}`);
}

test('large images are scaled or re-encoded before they are sent, under their own names, and an animated GIF is marked', async ({ page }) => {
  test.setTimeout(180_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-scale-'));
  const write = (name, bytes) => { const file = path.join(dir, name); fs.writeFileSync(file, bytes); return file; };
  const stored = collectStored(page);
  const convoId = await openNewConversation(page, 'Scaling e2e');
  try {
    const glass = await seeThroughFixture(page);
    const noise = noisePng(2000, 1000, false);
    expect(noise.length).toBeGreaterThan(LIMIT);
    const animated = Buffer.from(gifOf(2));
    const files = [write('flat.png', flatPng(4000, 3000)), write('noise.png', noise), write('glass.png', glass), write('clip.gif', animated)];

    await page.locator('#attach-input').setInputFiles(files);
    const chips = page.locator('#composer-chips .composer-chip');
    await expect(chips).toHaveCount(4, { timeout: 60_000 });
    await expect(page.locator('#composer-chips .composer-chip-name')).toHaveText(['flat.png', 'noise.png', 'glass.png', 'clip.gif']);
    const meta = page.locator('#composer-chips .composer-chip-meta');
    await expect(meta.nth(0)).toHaveText('Scaled to 2,576 px');
    await expect(meta.nth(1)).toContainText('JPEG · ');
    await expect(meta.nth(2)).toHaveText('Scaled to 1,568 px');
    await expect(meta.nth(3)).toHaveText('First frame only');
    await expect(page.locator('#composer-notice .composer-notice-item')).toHaveCount(0);

    await page.locator('#msg-input').fill('see these');
    await page.locator('#send-btn').click();
    await expect.poll(() => stored.filter((m) => m.conversationId === convoId).length, { timeout: 30_000 }).toBe(1);
    const { entry } = stored.find((m) => m.conversationId === convoId);
    expect(entry.files.map((f) => f.name)).toEqual(['flat.png', 'noise.png', 'glass.png', 'clip.gif']);
    const workspace = await page.evaluate(() => currentWorkspacePath);
    const [flat, photo, seeThrough, gif] = entry.files.map((f) => fs.readFileSync(path.join(workspace, '.rundock', 'attachments', convoId, f.file)));
    expect(detectFile(flat, 'flat.png')).toEqual({ type: 'png', width: 2576, height: 1932 });
    expect(detectFile(photo, 'noise.png').type).toBe('jpg');
    expect(photo.length).toBeLessThanOrEqual(LIMIT);
    const glassKind = detectFile(seeThrough, 'glass.png');
    expect([glassKind.type, Math.max(glassKind.width, glassKind.height)]).toEqual(['png', 1568]);
    expect(seeThrough.length).toBeLessThanOrEqual(LIMIT);
    expect(gif.equals(animated)).toBe(true);
    // The turn the send started runs to its end before the conversation goes.
    await expect(page.locator('#send-btn')).not.toHaveClass(/\bcancel\b/, { timeout: 30_000 });
  } finally {
    await deleteConvo(page, convoId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an image chip\'s preview loads, and its URL no longer loads once the chip is removed', async ({ page }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-preview-'));
  const convoId = await openNewConversation(page, 'Preview e2e');
  try {
    const file = path.join(dir, 'small.png');
    fs.writeFileSync(file, flatPng(64, 48));
    await page.locator('#attach-input').setInputFiles([file]);
    const preview = page.locator('#composer-chips .composer-chip-tile img');
    await expect(preview).toHaveCount(1);
    await expect(preview).toHaveAttribute('alt', '');
    await expect.poll(() => preview.evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
    const url = await preview.getAttribute('src');
    await page.locator('#composer-chips .composer-chip-remove').click();
    await expect(page.locator('#composer-chips .composer-chip')).toHaveCount(0);
    const loads = await page.evaluate((src) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = src;
    }), url);
    expect(loads).toBe(false);
  } finally {
    await deleteConvo(page, convoId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
