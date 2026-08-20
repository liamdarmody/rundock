'use strict';
// E2E: accepting a review suggestion puts back MARKDOWN, not literal text.
//
// Every replacement string these paths handle was read out of the file, where
// it is markdown source. A substitution's `to`, an insert's content, the text
// a highlight wraps: all of it means what markdown says it means. Inserting
// those strings as a plain text node made them literal, and the serialiser
// then escaped them on the next save, so `**bold**` was written back to disk
// as backslash-asterisk-asterisk and a wikilink survived as dead text.
//
// These tests assert the BYTES ON DISK rather than what the editor shows,
// because that is where the defect lives. The escaping happens at the
// serialisation boundary, so a render-only assertion passes happily while the
// file on disk is corrupt: the document held the right characters the whole
// time, and only saving mangled them.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { reviewedFormatting } = require('./fixture.js');

const NOTE = 'escaping.md';

// The specs WRITE to this fixture, so each one starts from a known state
// rather than from whatever the previous test left behind. The content comes
// from the fixture module, so there is one definition and nothing to drift.
async function restoreFixture(page) {
  await page.goto('/');
  const workspace = await page.evaluate(() => currentWorkspacePath);
  expect(workspace).toBeTruthy();
  fs.writeFileSync(path.join(workspace, NOTE), reviewedFormatting());
}

async function openNote(page) {
  await page.locator('.nav-item[data-nav="files"]').click();
  await page.locator(`#file-tree .file-item[data-path="${NOTE}"]`).click();
  await expect(page.locator('.ProseMirror h1')).toBeVisible();
  await expect(page.locator('.review-card').first()).toBeVisible();
}

// Acts on the card whose text carries `needle`, then waits for the verdict to
// land. Addressing by content rather than by index means a card order change
// cannot silently point a test at a different construct.
async function actOnCard(page, needle, label) {
  const card = page.locator('.review-card', { hasText: needle });
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: label, exact: true }).click();
  // Wait for the CARD to go, not for the save status. A verdict consumes its
  // construct, so the card disappearing is proof the verdict applied. The save
  // status is the wrong signal here: after the first action it already reads
  // "Saved", so asserting it resolves instantly and the next click lands on a
  // panel that has not re-rendered. That raced silently, and the cost was a
  // test that reported four verdicts while applying one.
  await expect(card).toHaveCount(0);
  await expect(page.locator('#editor-status')).toHaveText('Saved', { timeout: 10000 });
}

async function savedBody(page) {
  const text = await (await page.request.get(`/api/file?path=${NOTE}`)).text();
  // Body only: the endmatter records verdicts and is expected to change.
  //
  // Split on the endmatter's opening delimiter followed by ANY review key,
  // rather than on one key by name. Re-serialising the block reorders those
  // keys (comments ahead of suggestions once a comment is resolved), so a
  // split naming a single key silently matches nothing and hands back the
  // whole file, including the endmatter it was supposed to remove.
  return text.split(/\n---\n(?=(?:comments|suggestions|review):)/)[0];
}

test('accepting a substitution writes its replacement as markdown, not escaped text', async ({ page }) => {
  await restoreFixture(page);
  await openNote(page);
  await actOnCard(page, 'plain text', 'Accept');

  const body = await savedBody(page);
  expect(body).toContain('A substitution: **bold** and `code` and [[Roadmap-2026]] here.');
  // The specific corruption, named rather than implied by the line above, so a
  // failure says which half broke.
  expect(body).not.toContain('\\*');
  expect(body).not.toContain('\\`');
  // The construct is consumed: no CriticMarkup left at the accept site.
  expect(body).not.toContain('{~~');

  // And it is live markup in the document, not characters that merely survived
  // the round trip. A wikilink that reads correctly but does not resolve is
  // still broken for the reader.
  await expect(page.locator('.ProseMirror strong', { hasText: 'bold' }).first()).toBeVisible();
  await expect(page.locator('.ProseMirror code', { hasText: 'code' }).first()).toBeVisible();
  await expect(page.locator('.ProseMirror a.wikilink')).toHaveCount(1);
});

test('accepting an insert writes its content as markdown', async ({ page }) => {
  await restoreFixture(page);
  await openNote(page);
  await actOnCard(page, 'inserted bold', 'Accept');

  const body = await savedBody(page);
  expect(body).toContain('An insert: **inserted bold** and `tick` here.');
  expect(body).not.toContain('\\*');
  expect(body).not.toContain('{++');
});

test('rejecting a delete restores its content as markdown', async ({ page }) => {
  await restoreFixture(page);
  await openNote(page);
  // Reject, not accept: rejecting a delete is the branch that puts the content
  // BACK, which is the one that can escape it. Accepting a delete removes the
  // text and never touches the replacement path at all.
  await actOnCard(page, 'doomed bold', 'Reject');

  const body = await savedBody(page);
  expect(body).toContain('A delete: **doomed bold** here.');
  expect(body).not.toContain('\\*');
  expect(body).not.toContain('{--');
});

test('resolving a comment restores its highlighted text as markdown', async ({ page }) => {
  await restoreFixture(page);
  await openNote(page);
  await actOnCard(page, 'please check', 'Resolve');

  const body = await savedBody(page);
  expect(body).toContain('A highlight: **highlighted bold** here.');
  expect(body).not.toContain('\\*');
  // The anchor goes with the comment it was anchoring.
  expect(body).not.toContain('{==');
  expect(body).not.toContain('{>>');
});

test('the whole document survives every verdict without a single escape', async ({ page }) => {
  await restoreFixture(page);
  await openNote(page);
  await actOnCard(page, 'plain text', 'Accept');
  await actOnCard(page, 'inserted bold', 'Accept');
  await actOnCard(page, 'doomed bold', 'Reject');
  await actOnCard(page, 'please check', 'Resolve');

  const body = await savedBody(page);
  // Four constructs resolved in one session, each rewriting the file. The
  // escaping compounds if it is present at all, so the end state is the
  // cheapest place to see it.
  expect(body).toContain('A substitution: **bold** and `code` and [[Roadmap-2026]] here.');
  expect(body).toContain('An insert: **inserted bold** and `tick` here.');
  expect(body).toContain('A delete: **doomed bold** here.');
  expect(body).toContain('A highlight: **highlighted bold** here.');
  expect(body).not.toMatch(/\\[*`[\]]/);
  // No CriticMarkup survives once every construct has a verdict.
  expect(body).not.toMatch(/\{(~~|\+\+|--|==|>>)/);
});
