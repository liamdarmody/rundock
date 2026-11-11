'use strict';
// A Claude Code older than the flags Rundock passes, in the real client
// against a real server.
//
// The server is started here as a person starts it from source, `node
// server.js`, with the stub Claude Code first on its PATH reporting 2.0.58,
// one release below the floor. The shared server the other specs use cannot
// be made to: once a copy passes there, it is not read again. The person
// types a message and sends it, and the conversation shows the one sentence
// that says which copy was found and what to do with it, and stops thinking.
//
// A new chat and a resumed one are driven here. A delegation is not: it
// starts from an orchestrator already running, and on a copy below the floor
// nothing runs, so the browser has no way to reach one. The integration suite
// drives it with a stand-in orchestrator in the server.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { latestSignInLink } = require('../../scripts/sign-in-link.js');
const { buildFixture } = require('./fixture.js');

const ROOT = path.join(__dirname, '..', '..');
const STUB_DIR = path.join(ROOT, 'test', 'helpers', 'stub-claude');
const PORT = Number(process.env.E2E_PORT || 34517) + 2;
// The floor's own notice for the stub's copy, as the server, with its own home
// folder, writes it: the stub's path is in this checkout and can be long
// enough to be shortened. Its words are held in the unit suite, and the part
// after the path here.
const notice = () => require('../../lib/runtime/claude-floor.js')
  .tooOldError('2.0.58', path.join(STUB_DIR, 'claude'), { home: fixture.home }).message;
const WHAT_TO_DO = 'Rundock needs 2.0.59 or later. '
  + 'The Rundock app looks for it in ~/.local/bin, ~/.claude/bin, /usr/local/bin and /opt/homebrew/bin first. '
  + 'Update that copy, or install a current one with the native installer, which puts it in ~/.local/bin. '
  + 'Then send your message again.';

let fixture = null;
let server = null;
let context = null;
let page = null;
const sent = [];

function start() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        ...process.env,
        PATH: STUB_DIR + path.delimiter + process.env.PATH,
        PORT: String(PORT), HOME: fixture.home, USERPROFILE: fixture.home, WORKSPACE: fixture.workspace,
        RUNDOCK_ELECTRON: '1', RUNDOCK_DISABLE_SCHEDULER: '1',
        STUB_CLAUDE_VERSION: '2.0.58',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error(`no link printed:\n${out}`)), 20000);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      if (latestSignInLink(out)) { clearTimeout(timer); resolve({ child, link: latestSignInLink(out) }); }
    });
    child.stderr.on('data', (chunk) => { out += chunk.toString(); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}:\n${out}`)); });
  });
}

function stop() {
  return new Promise((resolve) => {
    if (!server || server.child.exitCode !== null) return resolve();
    server.child.removeAllListeners('exit');
    server.child.once('exit', () => resolve());
    server.child.kill('SIGTERM');
  });
}

// Send a message in the open conversation, and wait for the turn to settle.
async function sendInOpenConversation(text) {
  await expect(page.locator('#view-chat')).toBeVisible();
  await page.locator('#msg-input').fill(text);
  await page.locator('#send-btn').click();
}

test.describe.serial('a Claude Code below the floor', () => {
  test.skip(process.platform === 'win32', 'the stub is found as a POSIX script; a Windows .cmd copy is an unknown version');

  test.beforeAll(async ({ browser }) => {
    fixture = buildFixture();
    server = await start();
    context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    page = await context.newPage();
    page.on('websocket', (socket) => socket.on('framesent', (f) => { try { sent.push(JSON.parse(f.payload)); } catch (e) { /* not JSON */ } }));
    await page.goto(server.link);
    await expect.poll(() => page.evaluate(() => typeof ws !== 'undefined' && !!ws && ws.readyState === 1)).toBe(true);
    await expect(page.locator('.convo-item').first()).toBeVisible();
  });

  test.afterAll(async () => {
    if (context) await context.close();
    await stop();
    if (fixture) fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test('a new chat says which copy was found and what to do, and the thinking state clears', async () => {
    await page.evaluate(() => newConversation());
    await sendInOpenConversation('FLOOR-E2E-NEW hello');

    const shown = page.locator('#messages .msg-system', { hasText: 'Rundock found Claude Code' });
    await expect(shown).toHaveText(notice());
    await expect(shown).toContainText(WHAT_TO_DO);
    await expect(shown).toHaveCount(1);
    await expect(page.locator('#thinking-indicator')).toHaveCount(0);
    await expect(page.locator('#send-btn')).not.toHaveClass(/\bcancel\b/);
    const chat = sent.find((m) => m.type === 'chat' && JSON.stringify(m).includes('FLOOR-E2E-NEW'));
    expect(chat, 'the message was sent').toBeTruthy();
    expect(chat.sessionId || null, 'as a new chat, with no session to resume').toBeNull();
  });

  test('a resumed chat says the same, and the thinking state clears', async () => {
    await page.evaluate(() => openConversation('c1'));
    await sendInOpenConversation('FLOOR-E2E-RESUME hello again');

    const shown = page.locator('#messages .msg-system', { hasText: 'Rundock found Claude Code' });
    await expect(shown).toHaveText(notice());
    await expect(shown).toContainText(WHAT_TO_DO);
    await expect(shown).toHaveCount(1);
    await expect(page.locator('#thinking-indicator')).toHaveCount(0);
    await expect(page.locator('#send-btn')).not.toHaveClass(/\bcancel\b/);
    const chat = sent.find((m) => m.type === 'chat' && JSON.stringify(m).includes('FLOOR-E2E-RESUME'));
    expect(chat, 'the message was sent').toBeTruthy();
    expect(chat.sessionId, 'resuming the conversation\'s stored session').toBe('s1');
  });
});
