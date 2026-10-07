'use strict';
// Running from source in a browser: being let in from the printed link, and
// what a browser that is not let in sees.
//
// The server is started here exactly as a person starts it from source,
// `node server.js`, as a child of this spec, and the link is read off what it
// prints. The link carries a one-time code, never the launch key, and another
// is printed only when asked for at the terminal (Enter on its stdin). Each browser context is a separate
// browser: a fresh one has never been let in. Nothing here ever opens a tab
// by itself, and neither may the product: every page below is one this spec
// opened.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { latestSignInLink } = require('../../scripts/sign-in-link.js');

const ROOT = path.join(__dirname, '..', '..');
const PORT = Number(process.env.E2E_PORT || 34517) + 1;
const BASE = `http://localhost:${PORT}`;
const RESTARTED = 'Rundock restarted. Open it from the link in your terminal';
const NEVER = 'Open Rundock from the link in your terminal';

let home;
let workspace;
let server = null;
const used = new Set();

function start() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        ...process.env,
        PATH: path.join(ROOT, 'test', 'helpers', 'stub-claude') + path.delimiter + process.env.PATH,
        PORT: String(PORT), HOME: home, USERPROFILE: home, WORKSPACE: workspace,
        // Keeps the recent-workspaces and sign-in files in this disposable
        // home rather than the checkout. It does not make this the desktop
        // app: only running inside Electron does that.
        RUNDOCK_ELECTRON: '1', RUNDOCK_DISABLE_SCHEDULER: '1',
      },
      // stdin is the terminal: Enter there asks for another link.
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error(`no link printed:\n${out}`)), 20000);
    // Each printed link carries a one-time code: `link()` is always the
    // newest printed.
    const handle = { child, link: () => latestSignInLink(out), output: () => out };
    // A link to open in a new browser: the newest, or, when that has been
    // used, a fresh one asked for at the terminal as a person would.
    handle.take = async () => {
      let link = latestSignInLink(out);
      if (used.has(link)) {
        await new Promise((r) => setTimeout(r, 1100));
        child.stdin.write('\n');
        const until = Date.now() + 10000;
        while (latestSignInLink(out) === link && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
        link = latestSignInLink(out);
        if (used.has(link)) throw new Error('no fresh link after Enter');
      }
      used.add(link);
      return link;
    };
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      if (latestSignInLink(out)) { clearTimeout(timer); resolve(handle); }
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

async function restart() {
  await stop();
  server = await start();
}

const connected = (page) => page.evaluate(() => typeof ws !== 'undefined' && !!ws && ws.readyState === 1);
const signedOutLine = (page) => page.locator('#signed-out');
const fresh = (browser) => browser.newContext({ storageState: { cookies: [], origins: [] } });

test.describe.serial('browser mode: the printed link', () => {
  test.beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-signin-home-'));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-signin-ws-'));
    fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), '# Sign-in workspace\n');
    server = await start();
  });
  test.afterAll(async () => {
    await stop();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('26. opening the printed link lets the browser in, and the code leaves the address bar', async ({ browser }) => {
    const context = await fresh(browser);
    const page = await context.newPage();
    await page.goto(await server.take());
    await expect.poll(() => connected(page)).toBe(true);
    expect(page.url()).toBe(`${BASE}/`);
    await expect(signedOutLine(page)).toBeHidden();
    // The token is kept by this page's own address, never as a cookie a
    // browser would send to every server on localhost.
    expect(await page.evaluate(() => localStorage.getItem('rundock-session'))).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    const cookies = await context.cookies();
    expect(cookies.filter((c) => c.path !== '/workspace-file'), 'no cookie reaches anything but pictures and PDFs').toEqual([]);
    expect(await page.evaluate(() => document.cookie)).toBe('');
    await context.close();
  });

  test('27. a new tab works with no link', async ({ browser }) => {
    const context = await fresh(browser);
    const first = await context.newPage();
    await first.goto(await server.take());
    await expect.poll(() => connected(first)).toBe(true);
    const second = await context.newPage();
    await second.goto(BASE);
    await expect.poll(() => connected(second)).toBe(true);
    await expect(signedOutLine(second)).toBeHidden();
    await context.close();
  });

  test('28. after a server restart, the open tab reconnects by itself', async ({ browser }) => {
    const context = await fresh(browser);
    const page = await context.newPage();
    await page.goto(await server.take());
    await expect.poll(() => connected(page)).toBe(true);
    const before = server.link();
    await restart();
    expect(server.link(), 'a restart prints a new link').not.toBe(before);
    await expect.poll(() => connected(page), { timeout: 15000 }).toBe(true);
    await expect(signedOutLine(page)).toBeHidden();
    expect(context.pages()).toHaveLength(1);
    await context.close();
  });

  test('29. a tab whose reconnect is refused says Rundock restarted, nothing opens, and the link brings it back', async ({ browser }) => {
    const context = await fresh(browser);
    const page = await context.newPage();
    await page.goto(await server.take());
    await expect.poll(() => connected(page)).toBe(true);
    // An upgrade into a version that asks for the link: the server restarts
    // and this browser is not signed in to it.
    await page.evaluate(() => localStorage.clear());
    await restart();
    await expect(signedOutLine(page)).toHaveText(RESTARTED, { timeout: 15000 });
    expect(await connected(page)).toBe(false);
    expect(context.pages(), 'no tab opened by itself').toHaveLength(1);
    // The person clicks the printed link once.
    const linkTab = await context.newPage();
    await linkTab.goto(await server.take());
    await expect.poll(() => connected(linkTab)).toBe(true);
    // The old tab carries on by itself, on the same browser's cookie.
    await expect.poll(() => connected(page), { timeout: 15000 }).toBe(true);
    await expect(signedOutLine(page)).toBeHidden();
    await context.close();
  });

  test('30. a browser never signed in sees only the one line', async ({ browser }) => {
    const context = await fresh(browser);
    const page = await context.newPage();
    const refused = [];
    page.on('response', (res) => { if (res.status() === 401) refused.push(res.url()); });
    await page.goto(BASE);
    await expect(signedOutLine(page)).toHaveText(NEVER);
    await expect(signedOutLine(page)).toBeVisible();
    expect(await connected(page)).toBe(false);
    // Nothing behind the line was handed over: no agent list, no files.
    expect(await page.evaluate(() => fetch('/api/agents').then((r) => r.status))).toBe(401);
    await context.close();
  });

  test('a wrong key in the link signs nothing in', async ({ browser }) => {
    const context = await fresh(browser);
    const page = await context.newPage();
    await page.goto(`${BASE}/#c=${'x'.repeat(43)}`);
    await expect(signedOutLine(page)).toHaveText(NEVER);
    expect(page.url()).toBe(`${BASE}/`);
    await context.close();
  });
});
