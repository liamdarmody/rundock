// look-view: one screenshot of one view of the app, so a contributor (or a
// coding agent) can check a visible change without a person looking first.
//
// It reuses the marketing pipeline end to end: the sanitized demo workspace and
// fake $HOME (generate-workspace.mjs), the isolated server boot (serve.mjs) and
// the deterministic browser context (harness.mjs). On top of that it puts the
// test suite's stub runtime first on PATH, so nothing it does can start a real
// agent, and serve.mjs already keeps the routine scheduler off.
//
// Everything it starts (the demo workspace, the server) is removed again before
// it returns, whether the capture succeeded or not.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildWorkspace } from './generate-workspace.mjs';
import { startRundock } from './serve.mjs';
import { newContext, gotoWorkspace, setTheme, settle, openFile } from './harness.mjs';
import { describeTarget } from './look-view-options.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STUB_RUNTIME = path.join(REPO_ROOT, 'test', 'helpers', 'stub-claude');

// Its own port, clear of e2e (34517) and the marketing run (34519), so all
// three can run at once. serve.mjs moves to a nearby port if this one is taken.
export const LOOK_VIEW_PORT = 34531;

const ELEMENT_TIMEOUT = 5000;
const VIEW_TIMEOUT = 10000;

function lookError(message) {
  const err = new Error(message);
  err.lookView = true;
  return err;
}

function locate(page, t) {
  if (t.selector) return page.locator(t.selector);
  if (t.role) return page.getByRole(t.role, t.name ? { name: t.name } : {});
  if (t.text) return page.getByText(t.text);
  return page.getByLabel(t.label);
}

async function visible(locator, what, kind = 'Element') {
  const first = locator.first();
  try {
    await first.waitFor({ state: 'visible', timeout: ELEMENT_TIMEOUT });
  } catch {
    throw lookError(`${kind} not found: nothing visible with ${what} within ${ELEMENT_TIMEOUT / 1000}s.`);
  }
  return first;
}

async function waitFor(page, selector, what) {
  try {
    await page.waitForSelector(selector, { state: 'visible', timeout: VIEW_TIMEOUT });
  } catch {
    throw lookError(`${what} did not appear within ${VIEW_TIMEOUT / 1000}s (waited for ${selector}).`);
  }
}

// Conversations are named by id or by title, as either is what a person sees.
function findConversation(workspace, wanted) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(path.join(workspace, '.rundock', 'conversations.json'), 'utf8')); } catch { /* none */ }
  const hit = list.find((c) => c.id === wanted) || list.find((c) => (c.title || '').toLowerCase() === wanted.toLowerCase());
  if (!hit) {
    throw lookError(`Conversation not found: ${JSON.stringify(wanted)}. The demo workspace has: ${list.map((c) => `${c.title} (${c.id})`).join(', ')}.`);
  }
  return hit.id;
}

async function openView(page, o, workspace) {
  if (o.view === 'files') {
    const full = path.resolve(workspace, o.file);
    if (!full.startsWith(workspace + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      const top = fs.readdirSync(workspace).filter((n) => !n.startsWith('.')).sort();
      throw lookError(`File not found in the demo workspace: ${JSON.stringify(o.file)}. Paths are relative to the workspace root, which holds: ${top.join(', ')}.`);
    }
    await openFile(page, o.file);
    await waitFor(page, '#file-tree', 'The file tree');
    return;
  }

  await page.evaluate((v) => switchNav(v), o.view);

  if (o.view === 'team') {
    await waitFor(page, '.org-card', 'The team chart');
  } else if (o.view === 'conversations') {
    await waitFor(page, '#convo-list', 'The conversation list');
    if (o.conversation) {
      const id = findConversation(workspace, o.conversation);
      await page.evaluate((cid) => openConversation(cid), id);
      await waitFor(page, '#messages .msg', `Conversation ${JSON.stringify(o.conversation)}`);
    }
  } else if (o.view === 'routines') {
    await waitFor(page, '#routines-content .routine-row', 'The routines list');
  } else if (o.view === 'settings') {
    const sections = await page.$$eval('.settings-nav-item[data-settings]', (els) => els.map((e) => e.getAttribute('data-settings')));
    if (!sections.includes(o.section)) {
      throw lookError(`Settings section not found: ${JSON.stringify(o.section)}. Sections: ${sections.join(', ')}.`);
    }
    await page.click(`.settings-nav-item[data-settings="${o.section}"]`);
  } else if (o.view === 'skills') {
    await waitFor(page, '#skills-sidebar-list', 'The skills list');
    if (o.skill) {
      // By id or by the name the list shows.
      const found = await page.evaluate((s) => {
        const all = (typeof skills !== 'undefined' && Array.isArray(skills)) ? skills : [];
        const hit = all.find((k) => k.id === s) || all.find((k) => (k.name || '').toLowerCase() === s.toLowerCase());
        if (hit) selectSkill(hit.id);
        return { ok: !!hit, names: all.map((k) => k.name || k.id) };
      }, o.skill);
      if (!found.ok) throw lookError(`Skill not found: ${JSON.stringify(o.skill)}. Skills: ${found.names.join(', ')}.`);
    }
  }
}

async function runAction(page, a, i) {
  const where = `Action ${i + 1} (${a.type})`;
  try {
    if (a.type === 'click') {
      await (await visible(locate(page, a.target), describeTarget(a.target))).click();
    } else if (a.type === 'fill') {
      await (await visible(locate(page, a.target), describeTarget(a.target))).fill(a.value);
    } else if (a.type === 'press') {
      await page.keyboard.press(a.key);
    } else if (a.type === 'waitForText') {
      await visible(page.getByText(a.text), `text ${JSON.stringify(a.text)}`, 'Text');
    }
  } catch (err) {
    if (err.lookView) throw lookError(`${where}: ${err.message}`);
    throw lookError(`${where} failed: ${String(err.message).split('\n')[0]}`);
  }
  await page.waitForTimeout(150);
}

// Takes the screenshot `o` (normalised by look-view-options.mjs) describes.
// Returns the absolute path written.
export async function captureView(browser, o, { log = () => {} } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-look-view-'));
  let server = null;
  let ctx = null;
  let page = null;
  try {
    const { workspace, home } = buildWorkspace({ root: path.join(scratch, 'demo') });
    server = await startRundock({
      workspace: fs.realpathSync(workspace),
      home,
      port: LOOK_VIEW_PORT,
      env: { PATH: STUB_RUNTIME + path.delimiter + (process.env.PATH || '') },
    });
    log(`serving this checkout at ${server.url}`);

    ctx = await newContext(browser, { theme: o.theme, viewport: { width: o.width, height: o.height }, deviceScaleFactor: o.scale });
    page = await ctx.newPage();
    await gotoWorkspace(page, server.url);
    await setTheme(page, o.theme);
    await openView(page, o, fs.realpathSync(workspace));
    for (let i = 0; i < o.actions.length; i += 1) await runAction(page, o.actions[i], i);
    await settle(page);

    fs.mkdirSync(path.dirname(o.out), { recursive: true });
    if (o.element) {
      const el = await visible(page.locator(o.element), `selector ${JSON.stringify(o.element)}`)
        .catch((err) => { throw lookError(`"element": ${err.message}`); });
      await el.screenshot({ path: o.out, animations: 'disabled' });
    } else {
      await page.screenshot({ path: o.out, animations: 'disabled' });
    }
    return o.out;
  } catch (err) {
    // What the screen showed when it went wrong, beside where the picture
    // would have gone, so the failure can be looked at rather than guessed at.
    if (page && err.lookView) {
      const shot = o.out.replace(/\.png$/i, '.failed.png');
      try {
        fs.mkdirSync(path.dirname(shot), { recursive: true });
        await page.screenshot({ path: shot });
        err.message += ` The screen at that point: ${shot}`;
      } catch { /* the message stands without it */ }
    }
    throw err;
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    if (server) await server.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
