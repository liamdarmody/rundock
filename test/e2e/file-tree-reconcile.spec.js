'use strict';
// The file tree updates in place.
//
// It used to be destroyed and rebuilt on every push from the server. Two
// mitigations hid the cheap case: skip the render when the data is identical,
// and reapply a remembered set of open folders afterwards. Neither did
// anything for the real case, a file appearing or disappearing while you are
// looking at the tree, which still tore down every row.
//
// The assertions below are all of one kind: TAG A LIVE DOM NODE, cause a
// structural change, then check the tag is still there. A tag survives only if
// the element was never replaced, so it distinguishes "updated in place" from
// "rebuilt and made to look the same", which is the distinction the whole
// change is about and the one that a screenshot cannot see.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { sequence } = require('../helpers/tree-fixtures.js');

async function openFiles(page) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await page.locator('.nav-item[data-nav="files"]').click();
  await expect(page.locator('.folder-item').first()).toBeVisible();
}

/** Push a tree the way the server does, through the real message handler. */
async function pushTree(page, tree) {
  await page.evaluate((t) => {
    ws.onmessage({ data: JSON.stringify({ type: 'file_tree', tree: t }) });
  }, tree);
}

const file = (path, kind = 'note') => ({ type: 'file', name: path.split('/').pop(), path, kind });
const folder = (path, children) => ({ type: 'folder', name: path.split('/').pop(), path, children });

const countFiles = (nodes) => nodes.reduce(
  (n, x) => n + (x.type === 'folder' ? countFiles(x.children) : 1), 0);

/** A tree tall enough that the sidebar has somewhere to scroll to. */
function bigTree(extra = []) {
  const kids = [];
  for (let i = 0; i < 40; i++) kids.push(file(`deep/f${String(i).padStart(2, '0')}.md`));
  return [folder('deep', kids.concat(extra)), file('root-a.md'), file('root-b.md')];
}

test('a created file appears without rebuilding the tree around it', async ({ page }) => {
  await openFiles(page);
  await page.locator('#file-tree .folder-item').first().click();
  const before = await page.locator('#file-tree .file-item').count();

  // Tag every row that exists now. Any of them being replaced loses its tag.
  await page.evaluate(() => {
    document.querySelectorAll('#file-tree .file-item, #file-tree .folder-item')
      .forEach((el, i) => { el.dataset.tag = 'row' + i; });
  });

  // A real file, created on disk, arriving back as a real server push.
  await page.evaluate(() => ws.send(JSON.stringify({
    type: 'create_path', path: 'reconcile-probe.md', kind: 'note',
  })));
  await expect(page.locator('#file-tree .file-item', { hasText: 'reconcile-probe' })).toHaveCount(1);
  expect(await page.locator('#file-tree .file-item').count()).toBe(before + 1);

  // Every pre-existing row kept its tag, so nothing was torn down to add one.
  const untagged = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#file-tree .file-item, #file-tree .folder-item'))
      .filter(el => !el.dataset.tag && !el.textContent.includes('reconcile-probe')).length);
  expect(untagged).toBe(0);
  // No cleanup: each run gets its own throwaway workspace directory.
});

test('expansion, selection and scroll all survive a structural change', async ({ page }) => {
  await openFiles(page);
  await pushTree(page, bigTree());

  // Open the folder, select a file inside it, scroll away from the top.
  await page.locator('#file-tree .folder-item[data-path="deep"]').click();
  const target = page.locator('#file-tree .file-item[data-path="deep/f05.md"]');
  await expect(target).toBeVisible();
  await page.evaluate(() => {
    document.querySelector('#file-tree .file-item[data-path="deep/f05.md"]').classList.add('active');
    document.querySelector('#file-tree').scrollTop = 220;
  });
  await page.evaluate(() => {
    document.querySelector('#file-tree .file-item[data-path="deep/f05.md"]').dataset.tag = 'survivor';
    document.querySelector('#file-tree .folder-item[data-path="deep"]').dataset.tag = 'folder';
  });
  const scrollBefore = await page.evaluate(() => document.querySelector('#file-tree').scrollTop);
  expect(scrollBefore).toBeGreaterThan(0);

  // A file appears in the middle of the open folder.
  await pushTree(page, bigTree([file('deep/f05a-new.md')]));
  await expect(page.locator('#file-tree .file-item[data-path="deep/f05a-new.md"]')).toHaveCount(1);

  const after = await page.evaluate(() => {
    const tree = document.querySelector('#file-tree');
    const row = tree.querySelector('.file-item[data-path="deep/f05.md"]');
    const dir = tree.querySelector('.folder-item[data-path="deep"]');
    return {
      rowTag: row && row.dataset.tag,
      folderTag: dir && dir.dataset.tag,
      stillActive: !!(row && row.classList.contains('active')),
      stillOpen: !dir.nextElementSibling.classList.contains('collapsed'),
      scrollTop: tree.scrollTop,
    };
  });

  // AC-3, and all of it for the same reason: these nodes were never replaced.
  expect(after.rowTag).toBe('survivor');
  expect(after.folderTag).toBe('folder');
  expect(after.stillActive).toBe(true);
  expect(after.stillOpen).toBe(true);
  expect(after.scrollTop).toBe(scrollBefore);
});

test('a deleted file leaves and takes nothing else with it', async ({ page }) => {
  await openFiles(page);
  await pushTree(page, bigTree([file('deep/doomed.md')]));
  await page.locator('#file-tree .folder-item[data-path="deep"]').click();
  await expect(page.locator('#file-tree .file-item[data-path="deep/doomed.md"]')).toHaveCount(1);

  await page.evaluate(() => {
    document.querySelector('#file-tree .file-item[data-path="deep/f00.md"]').dataset.tag = 'neighbour';
  });
  await pushTree(page, bigTree());

  await expect(page.locator('#file-tree .file-item[data-path="deep/doomed.md"]')).toHaveCount(0);
  expect(await page.evaluate(() =>
    document.querySelector('#file-tree .file-item[data-path="deep/f00.md"]').dataset.tag)).toBe('neighbour');
});

test('a folder that disappears takes its children box with it', async ({ page }) => {
  await openFiles(page);
  await pushTree(page, bigTree());
  const boxes = await page.locator('#file-tree .file-children').count();

  await pushTree(page, [file('root-a.md'), file('root-b.md')]);

  await expect(page.locator('#file-tree .folder-item[data-path="deep"]')).toHaveCount(0);
  // A folder is two elements. Removing only the row would strand its children
  // box, leaving forty rows on screen with no folder above them.
  expect(await page.locator('#file-tree .file-children').count()).toBe(boxes - 1);
  expect(await page.locator('#file-tree .file-item').count()).toBe(2);
});

test('an identical push changes nothing, with no guard standing in front of it', async ({ page }) => {
  await openFiles(page);
  await pushTree(page, bigTree());
  await page.evaluate(() => {
    document.querySelector('#file-tree').dataset.tag = 'untouched';
    document.querySelectorAll('#file-tree .file-item').forEach((el, i) => { el.dataset.tag = 'r' + i; });
  });

  // The same tree, three times over. The skip-if-unchanged comparison that
  // used to sit in front of this call is gone; nothing is rendered because
  // the diff is empty, which is a property rather than a special case.
  await pushTree(page, bigTree());
  await pushTree(page, bigTree());
  await pushTree(page, bigTree());

  const intact = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#file-tree .file-item')).every((el, i) => el.dataset.tag === 'r' + i));
  expect(intact).toBe(true);
});

test('a kind change swaps the icon and keeps the row', async ({ page }) => {
  await openFiles(page);
  await pushTree(page, [file('note.md', 'note')]);
  const row = page.locator('#file-tree .file-item[data-path="note.md"]');
  await expect(row).toHaveCount(1);
  const noteGlyph = await row.locator('svg.file-item-icon').innerHTML();
  await page.evaluate(() => {
    document.querySelector('#file-tree .file-item[data-path="note.md"]').dataset.tag = 'same-row';
  });

  await pushTree(page, [file('note.md', 'board')]);

  expect(await row.locator('svg.file-item-icon').innerHTML()).not.toBe(noteGlyph);
  expect(await row.evaluate(el => el.dataset.tag)).toBe('same-row');
});

test('a real file written to disk leaves expansion, selection and scroll intact', async ({ page }) => {
  // The whole claim, end to end, with nothing synthesised.
  //
  // The other tests hand the client a tree to make the shape of a change
  // precise. This one writes a file to the workspace directory the way an
  // agent does, lets the server walk the disk and push the result, and checks
  // that everything the user had set up is still there afterwards. Written
  // because a review pointed out, correctly, that the test doing a real change
  // was not the test setting up any state, so the highest-risk claim in the
  // change was never actually exercised.
  await openFiles(page);

  const workspace = await page.evaluate(() => currentWorkspacePath);
  expect(workspace).toBeTruthy();

  // Real content, so the list has somewhere to scroll. Written before the
  // state is set up, so the scroll and selection below survive one real push
  // rather than being established after the last one.
  const bulk = path.join(workspace, 'bulk');
  fs.mkdirSync(bulk, { recursive: true });
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(bulk, `b${String(i).padStart(2, '0')}.md`), 'x');
  await page.evaluate(() => ws.send(JSON.stringify({ type: 'get_files' })));
  await expect(page.locator('#file-tree .folder-item[data-path="bulk"]')).toHaveCount(1);

  // Expand a real folder, select a real file, scroll the real list.
  await page.locator('#file-tree .folder-item[data-path="bulk"]').click();
  await page.locator('#file-tree .file-item[data-path="bulk/b04.md"]').click();
  await expect(page.locator('#file-tree .file-item[data-path="bulk/b04.md"]')).toHaveClass(/active/);
  await page.evaluate(() => { document.querySelector('#file-tree').scrollTop = 200; });
  const scrollBefore = await page.evaluate(() => document.querySelector('#file-tree').scrollTop);
  expect(scrollBefore).toBeGreaterThan(0);

  await page.evaluate(() => {
    document.querySelector('#file-tree .file-item[data-path="bulk/b04.md"]').dataset.tag = 'selected-row';
    document.querySelector('#file-tree .folder-item[data-path="bulk"]').dataset.tag = 'open-folder';
  });

  // The structural change: a file appears on disk, mid-folder, and the server
  // finds it on its own.
  fs.writeFileSync(path.join(bulk, 'b04a-arrived.md'), 'x');
  await page.evaluate(() => ws.send(JSON.stringify({ type: 'get_files' })));
  await expect(page.locator('#file-tree .file-item[data-path="bulk/b04a-arrived.md"]')).toHaveCount(1);

  const after = await page.evaluate(() => {
    const tree = document.querySelector('#file-tree');
    const row = tree.querySelector('.file-item[data-path="bulk/b04.md"]');
    const dir = tree.querySelector('.folder-item[data-path="bulk"]');
    return {
      rowTag: row && row.dataset.tag,
      folderTag: dir && dir.dataset.tag,
      active: !!(row && row.classList.contains('active')),
      open: !dir.nextElementSibling.classList.contains('collapsed'),
      scrollTop: tree.scrollTop,
    };
  });

  expect(after.rowTag).toBe('selected-row');   // the same elements, not replacements
  expect(after.folderTag).toBe('open-folder');
  expect(after.active).toBe(true);
  expect(after.open).toBe(true);
  expect(after.scrollTop).toBe(scrollBefore);
});

test('the tree never carries state across a workspace switch', async ({ page }) => {
  // Paths are matched as plain strings with nothing scoping them to a
  // workspace, and a new workspace is scaffolded from a template, so the two
  // trees share paths. Patching one onto the other would let a folder the
  // user expanded here arrive pre-expanded somewhere they have never been.
  await openFiles(page);
  await pushTree(page, bigTree());
  await page.locator('#file-tree .folder-item[data-path="deep"]').click();
  await page.evaluate(() => {
    document.querySelector('#file-tree .folder-item[data-path="deep"]').dataset.tag = 'old-workspace';
  });

  // The same shape arriving as a different workspace.
  await page.evaluate((t) => {
    currentWorkspacePath = '/somewhere/else';
    ws.onmessage({ data: JSON.stringify({ type: 'file_tree', tree: t }) });
  }, bigTree());

  const after = await page.evaluate(() => {
    const dir = document.querySelector('#file-tree .folder-item[data-path="deep"]');
    return { tag: dir.dataset.tag, collapsed: dir.nextElementSibling.classList.contains('collapsed') };
  });
  expect(after.tag).toBe(undefined);      // rebuilt, so the old node is gone
  expect(after.collapsed).toBe(true);     // and it is closed, as a fresh tree is
});

test('an inline text field in the tree survives a structural change', async ({ page }) => {
  // AC-3 names an in-progress inline RENAME. There is no rename affordance in
  // this tree: the row context menu offers creation rows, copy path, copy
  // wikilink and reveal in Finder, and nothing else. The nearest real thing,
  // and the tree's only inline text entry, is naming a file as it is created,
  // so that is what gets tested. Keyboard focus rides along with it, which is
  // the other half of AC-3 that nothing else here covers.
  await openFiles(page);
  await pushTree(page, bigTree());

  await page.locator('#file-tree .file-item[data-path="root-a.md"]').click({ button: 'right' });
  await page.locator('.files-menu-item').first().click();
  const input = page.locator('.files-menu-field input');
  await expect(input).toBeVisible();
  await input.fill('half-typed-name');
  await input.focus();

  await page.evaluate(() => {
    const el = document.querySelector('.files-menu-field input');
    el.dataset.tag = 'mid-edit';
  });

  // A file appears elsewhere while the field is open.
  await pushTree(page, bigTree([file('deep/interrupting.md')]));
  await expect(page.locator('#file-tree .file-item[data-path="deep/interrupting.md"]')).toHaveCount(1);

  const state = await page.evaluate(() => {
    const el = document.querySelector('.files-menu-field input');
    return {
      tag: el && el.dataset.tag,
      value: el && el.value,
      focused: el === document.activeElement,
    };
  });
  expect(state.tag).toBe('mid-edit');     // the same element, not a replacement
  expect(state.value).toBe('half-typed-name');
  expect(state.focused).toBe(true);
});

test('the same generated sequences reconcile correctly in the real DOM', async ({ page }) => {
  // The unit suite proves the operation list is right. It says nothing about
  // the code that executes it: the DOM patcher is a second, independent
  // implementation of the same semantics, and container-scoped removals,
  // ascending insert indices, and a folder being two elements rather than one
  // are all restated there by hand.
  //
  // So the very sequences the unit suite runs are pushed through the real
  // renderer here, and the resulting DOM is read back and compared with the
  // tree the server sent. This is AC-2 for the half the user can see.
  //
  // Structure and order only: a kind change is a one-line update covered by
  // its own test above, and reading a glyph back to a kind would test the icon
  // table rather than the patcher.
  await openFiles(page);

  const shape = (nodes) => nodes.map(n => (
    n.type === 'folder'
      ? { type: 'folder', path: n.path, children: shape(n.children) }
      : { type: 'file', path: n.path }
  ));

  let compared = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const { before, after, changed } = sequence(seed);
    if (!changed) continue;

    await pushTree(page, before);
    await pushTree(page, after);

    const drawn = await page.evaluate(() => {
      const read = (container) => {
        const out = [];
        for (const el of Array.from(container.children)) {
          if (el.classList.contains('folder-item')) {
            const box = el.nextElementSibling;
            out.push({ type: 'folder', path: el.dataset.path, children: read(box) });
          } else if (el.classList.contains('file-item')) {
            out.push({ type: 'file', path: el.dataset.path });
          }
        }
        return out;
      };
      return read(document.querySelector('#file-tree'));
    });

    expect(drawn, `seed ${seed}`).toEqual(shape(after));
    compared++;
  }

  // Guard the guard: skipping every seed would pass while proving nothing.
  expect(compared).toBeGreaterThan(30);
});

test('a tree the patch cannot fit falls back to a rebuild rather than drifting', async ({ page }) => {
  await openFiles(page);
  await pushTree(page, bigTree());

  // Tear a hole in the DOM behind the renderer's back, so the next patch
  // cannot apply. The tree must still end up matching the data.
  await page.evaluate(() => {
    document.querySelector('#file-tree .folder-item[data-path="deep"]').nextElementSibling.remove();
  });
  await pushTree(page, bigTree([file('deep/after-the-fall.md')]));

  await page.locator('#file-tree .folder-item[data-path="deep"]').click();
  await expect(page.locator('#file-tree .file-item[data-path="deep/after-the-fall.md"]')).toHaveCount(1);
  // Every file the data describes is on screen exactly once: the rebuild
  // recovered the whole tree rather than papering over the hole.
  const expected = countFiles(bigTree([file('deep/after-the-fall.md')]));
  expect(await page.locator('#file-tree .file-item').count()).toBe(expected);
});
