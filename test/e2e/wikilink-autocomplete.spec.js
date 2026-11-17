'use strict';
// E2E: typing [[ in a note suggests notes to link to, in real Chromium against
// the real server.
//
// The unit suite drives the suggestion plugin in jsdom. What only a browser
// can say is the whole round: real keys reach the list, the chosen link is
// written to disk as exactly [[target]], undo is the browser's own shortcut,
// a reopened note's link opens the note that was chosen, and a note named
// like markup is shown as characters with nothing run. Every note here is
// made by the spec in a folder of its own and removed afterwards.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const FOLDER = 'example-links';
const HOSTILE = '<img src=x onerror=alert(1)>';
const FIXTURES = {
  [`${FOLDER}/alpha/Roadmap.md`]: '# Roadmap (alpha)\n',
  [`${FOLDER}/beta/Roadmap.md`]: '# Roadmap (beta)\n',
  [`${FOLDER}/${HOSTILE}.md`]: 'A note with an awkward name.\n',
  [`${FOLDER}/.Zqx hidden.md`]: 'Hidden from the Files tree.\n',
};
const draftPath = (name) => `${FOLDER}/alpha/${name}.md`;
const draftText = (name) => `# ${name}\n\nStart here.\n`;

let workspace = null;

test.afterAll(() => {
  if (workspace) fs.rmSync(path.join(workspace, FOLDER), { recursive: true, force: true });
});

function write(rel, content) {
  const absolute = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}
const onDisk = (rel) => fs.readFileSync(path.join(workspace, rel), 'utf8');

async function boot(page) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
}

async function openNote(page, rel) {
  await page.evaluate((p) => openWorkspaceFilePath(p), rel);
  await expect(page.locator('#editor-filename')).toHaveText(rel);
}

// Writes the fixtures, any extra notes and a fresh draft, opens the draft,
// and puts the caret at the end of its body line.
async function openDraft(page, name, extra = {}) {
  await boot(page);
  workspace = await page.evaluate(() => currentWorkspacePath);
  for (const [rel, content] of Object.entries({ ...FIXTURES, ...extra })) write(rel, content);
  write(draftPath(name), draftText(name));
  await page.reload();
  await expect(page.locator('.convo-item').first()).toBeVisible();
  const wanted = [draftPath(name), `${FOLDER}/beta/Roadmap.md`, `${FOLDER}/${HOSTILE}.md`, ...Object.keys(extra)];
  await expect.poll(() => page.evaluate((paths) => {
    const tree = JSON.stringify(typeof cachedFileTree === 'undefined' ? null : cachedFileTree);
    return paths.every((p) => tree.includes(JSON.stringify(p)));
  }, wanted)).toBe(true);
  await openNote(page, draftPath(name));
  await caretAtEndOf(page, 'Start here.');
}

// Tiptap's focus command hands the browser's focus to the editor on the next
// animation frame, so this waits until the editor has it: a key typed before
// then goes to the page and is lost.
async function caretAtEndOf(page, text) {
  await expect(page.locator('#tiptap-editor .ProseMirror p', { hasText: text })).toBeVisible();
  await page.evaluate((needle) => {
    const ed = activeTiptapEditor;
    let at = null;
    ed.state.doc.descendants((node, pos) => {
      if (at === null && node.isText && node.text.includes(needle)) at = pos + node.text.indexOf(needle) + needle.length;
    });
    ed.commands.focus();
    ed.commands.setTextSelection(at);
  }, text);
  await expect(page.locator('#tiptap-editor .ProseMirror')).toBeFocused();
}

const popup = (page) => page.locator('.wikilink-suggest');
const rows = (page) => page.locator('.wikilink-suggest-item');
const exactly = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const row = (page, title, folder) => rows(page)
  .filter({ has: page.locator('.wikilink-suggest-title', { hasText: exactly(title) }) })
  .filter({ has: page.locator('.wikilink-suggest-meta', { hasText: exactly(folder) }) });

// Presses ArrowDown until the selected row is the one in folder.
async function selectFolder(page, folder) {
  for (let i = 0; i < 25; i++) {
    const meta = await page.evaluate(() => {
      const el = document.querySelector('.wikilink-suggest-item.selected .wikilink-suggest-meta');
      return el ? el.textContent : null;
    });
    if (meta === folder) return;
    await page.keyboard.press('ArrowDown');
  }
  throw new Error(`no row in ${folder}`);
}

const body = (page) => page.locator('#tiptap-editor .ProseMirror p', { hasText: 'Start here.' });

test('[[ lists notes, filters as typed, and the keys and a click insert the chosen one, saved as exactly [[target]]', async ({ page }) => {
  await openDraft(page, 'Draft one');
  await page.keyboard.type(' [[');
  await expect(popup(page)).toBeVisible();
  const listed = await rows(page).count();
  expect(listed).toBeGreaterThan(0);
  expect(listed).toBeLessThanOrEqual(20);

  // Filtered by the fuzzy scorer; both notes named Roadmap are offered.
  await page.keyboard.type('rdmp');
  await expect(row(page, 'Roadmap', `${FOLDER}/alpha`)).toHaveCount(1);
  await expect(row(page, 'Roadmap', `${FOLDER}/beta`)).toHaveCount(1);
  await expect(row(page, 'Draft one', `${FOLDER}/alpha`)).toHaveCount(0);

  // The arrows move the selection; Enter inserts the note in the other folder.
  await selectFolder(page, `${FOLDER}/beta`);
  await page.keyboard.press('Enter');
  await expect(popup(page)).toHaveCount(0);
  await expect(body(page).locator(`a.wikilink[data-target="${FOLDER}/beta/Roadmap"]`)).toHaveCount(1);

  // Tab inserts the selected row.
  await page.keyboard.type(' [[draft one');
  await expect(page.locator('.wikilink-suggest-item.selected .wikilink-suggest-title')).toHaveText('Draft one');
  await page.keyboard.press('Tab');
  await expect(body(page).locator('a.wikilink[data-target="Draft one"]')).toHaveCount(1);

  // A click inserts the row clicked; from this folder the bare name opens it.
  await page.keyboard.type(' [[roadmap');
  await row(page, 'Roadmap', `${FOLDER}/alpha`).click();
  await expect(popup(page)).toHaveCount(0);
  await expect(body(page).locator('a.wikilink[data-target="Roadmap"]')).toHaveCount(1);

  // Nothing matching says so; Escape closes and leaves the text as typed.
  await page.keyboard.type(' [[zz');
  await expect(popup(page)).toHaveText('No notes found');
  await page.keyboard.press('Escape');
  await expect(popup(page)).toHaveCount(0);
  await expect(page.locator('#editor-filename')).toHaveText(draftPath('Draft one'));

  // Every other byte of the file is as it was.
  await expect.poll(() => onDisk(draftPath('Draft one'))).toBe(
    `# Draft one\n\nStart here. [[${FOLDER}/beta/Roadmap]] [[Draft one]] [[Roadmap]] [[zz\n`);
});

test('undo: one Cmd/Ctrl+Z after inserting puts back exactly what was typed', async ({ page }) => {
  await openDraft(page, 'Draft two');
  await page.keyboard.type(' [[roadm');
  await expect(row(page, 'Roadmap', `${FOLDER}/alpha`)).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(body(page).locator('a.wikilink')).toHaveCount(1);

  await page.keyboard.press('ControlOrMeta+z');
  await expect(body(page)).toHaveText('Start here. [[roadm');
  await expect(body(page).locator('a.wikilink')).toHaveCount(0);
  await expect(popup(page)).toHaveCount(0);
  await expect.poll(() => onDisk(draftPath('Draft two'))).toBe('# Draft two\n\nStart here. [[roadm\n');
});

test('most common next step: saved, closed and reopened, the link is still [[target]] and opens the chosen note', async ({ page }) => {
  await openDraft(page, 'Draft three');
  await page.keyboard.type(' [[roadmap');
  await selectFolder(page, `${FOLDER}/beta`);
  await page.keyboard.press('Enter');
  const saved = `# Draft three\n\nStart here. [[${FOLDER}/beta/Roadmap]]\n`;
  await expect.poll(() => onDisk(draftPath('Draft three'))).toBe(saved);

  await boot(page);
  await openNote(page, draftPath('Draft three'));
  const link = body(page).locator(`a.wikilink[data-target="${FOLDER}/beta/Roadmap"]`);
  await expect(link).toHaveCount(1);
  expect(onDisk(draftPath('Draft three'))).toBe(saved);
  await link.click();
  await expect(page.locator('#editor-filename')).toHaveText(`${FOLDER}/beta/Roadmap.md`);
  await expect(page.locator('#tiptap-editor .ProseMirror h1')).toHaveText('Roadmap (beta)');
});

test('a note named like markup is listed and linked as characters and runs nothing; a note the Files tree hides is never listed', async ({ page }) => {
  const dialogs = [];
  page.on('dialog', (dialog) => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
  await page.addInitScript(() => {
    window.__hostileRan = false;
    window.alert = () => { window.__hostileRan = true; };
  });

  await openDraft(page, 'Draft four');
  await page.keyboard.type(' [[img src');
  const hostile = row(page, HOSTILE, FOLDER);
  await expect(hostile).toHaveCount(1);
  await expect(hostile.locator('.wikilink-suggest-title')).toHaveText(HOSTILE);
  await expect(popup(page).locator('img')).toHaveCount(0);

  await selectFolder(page, FOLDER);
  await page.keyboard.press('Enter');
  const link = body(page).locator('a.wikilink');
  await expect(link).toHaveText(HOSTILE);
  await expect(link.locator('img')).toHaveCount(0);
  await expect.poll(() => onDisk(draftPath('Draft four'))).toBe(`# Draft four\n\nStart here. [[${HOSTILE}]]\n`);

  // The Files tree hides a dot-named note, so the list never offers it.
  expect(fs.existsSync(path.join(workspace, FOLDER, '.Zqx hidden.md'))).toBe(true);
  expect(await page.evaluate(() => JSON.stringify(cachedFileTree).includes('Zqx'))).toBe(false);
  await page.keyboard.type(' [[zqx');
  await expect(popup(page)).toHaveText('No notes found');
  await page.keyboard.press('Escape');

  expect(await page.evaluate(() => window.__hostileRan)).toBe(false);
  expect(await page.locator('img[src="x"]').count()).toBe(0);
  expect(dialogs).toEqual([]);
});

test('more notes match than the list holds: it shows exactly 20', async ({ page }) => {
  const many = {};
  for (let i = 1; i <= 25; i++) many[`${FOLDER}/many/Overflow ${String(i).padStart(2, '0')}.md`] = `# Overflow ${i}\n`;
  await openDraft(page, 'Draft five', many);
  await page.keyboard.type(' [[overflow');
  await expect(popup(page)).toBeVisible();
  await expect(rows(page)).toHaveCount(20);
  await expect(rows(page).filter({ has: page.locator('.wikilink-suggest-title', { hasText: /^Overflow \d\d$/ }) })).toHaveCount(20);
  await page.keyboard.press('Escape');
  await expect(popup(page)).toHaveCount(0);
});

test('Enter with nothing matching finishes the link with the typed text, and the saved file holds exactly that', async ({ page }) => {
  await openDraft(page, 'Draft six');
  await page.keyboard.type(' [[Zz new idea ');
  await expect(popup(page)).toHaveText('No notes found');
  await page.keyboard.press('Enter');
  await expect(popup(page)).toHaveCount(0);
  await expect(body(page).locator('a.wikilink[data-target="Zz new idea "]')).toHaveCount(1);
  await expect.poll(() => onDisk(draftPath('Draft six'))).toBe('# Draft six\n\nStart here. [[Zz new idea ]]\n');
});
