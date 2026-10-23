'use strict';
// E2E: links inside frontmatter values, and creating a missing note from a link.
//
// The unit suites drive the panel and the create rule in jsdom. What only a
// real browser and a real server can say is the whole round: a click on a
// missing link reaches the server's create, the new note opens, the notice
// names it, and the tree holds exactly one of it. Each note here is made by
// the spec in a folder of its own, so the shared workspace keeps its shape.
const { test, expect } = require('@playwright/test');

const FOLDER = 'link-probe';

async function openNew(page, name, content) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await page.locator('.nav-item[data-nav="files"]').click();
  // A note made through the real create opens itself when the server answers.
  await page.evaluate(([p, c]) => ws.send(JSON.stringify({ type: 'create_path', kind: 'note', path: p, content: c })),
    [`${FOLDER}/${name}`, content]);
  await expect(page.locator('#editor-filename')).toHaveText(`${FOLDER}/${name}`);
}

test('links among the words of a property open, and a missing one creates its note', async ({ page }) => {
  await openNew(page, 'panel.md', [
    '---',
    'builds-on: "[[Roadmap-2026]] section 4, and [[Not yet written]] next"',
    '---',
    '',
    'Body.',
    '',
  ].join('\n'));
  const row = page.locator('#tiptap-properties .prop-row[data-prop-key="builds-on"]');
  await expect(row.locator('.prop-value')).toHaveText('Roadmap-2026 section 4, and Not yet written next');
  await expect(row.locator('a.prop-wikilink:not(.dead)', { hasText: 'Roadmap-2026' })).toBeVisible();
  const missing = row.locator('a.prop-wikilink.dead', { hasText: 'Not yet written' });
  await expect(missing).toHaveCSS('text-decoration-style', 'dashed');

  await missing.click();
  await expect(page.locator('#editor-filename')).toHaveText(`${FOLDER}/Not yet written.md`);
  await expect(page.locator('.link-notice')).toContainText('Created Not yet written');
  await expect(page.locator(`.file-item[data-path="${FOLDER}/Not yet written.md"]`)).toHaveCount(1);
});

test('a missing link in the note body is marked, and a click creates and opens it', async ({ page }) => {
  await openNew(page, 'body.md', 'See [[Also not written]] for the rest.\n');
  const link = page.locator('#tiptap-editor a.wikilink.dead', { hasText: 'Also not written' });
  await expect(link).toHaveCSS('text-decoration-style', 'dashed');

  await link.click();
  await expect(page.locator('#editor-filename')).toHaveText(`${FOLDER}/Also not written.md`);
  await expect(page.locator('.link-notice')).toContainText('Created Also not written');
});
