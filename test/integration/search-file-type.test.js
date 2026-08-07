'use strict';
// Integration: files that differ only by type must be tellable apart in search
// results, and a title shown on screen must be findable by typing it.
//
// The reported case: a report held as PDF, HTML, PNG, JPG and GIF produced five
// rows with the same text and the same generic icon, so there was no way to
// pick the right one.
//
// Two facts about how file results are produced shape every test here, and
// both were established by reading the code rather than assumed:
//
//   1. Only .md, .txt, .html, .htm and .svg are content-indexed (see
//      INDEXED_EXTENSIONS). PDFs and images are NEVER in the FTS index, so
//      they can only ever be found by the name layer.
//   2. The name layer matches against the FULL file name, extension included,
//      over every file in the tree. So searchability of a shown extension is
//      already provided there; it is the DISPLAY that dropped it.
//
// The searchability tests below therefore guard behaviour that must not
// regress, rather than behaviour being added.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('../helpers/harness.js');

let client;

async function search(query) {
  const since = client.messages.length;
  client.send({ type: 'search_universal', query });
  const { msg } = await client.waitFor(
    m => m.type === 'search_universal_results' && m.query === query,
    { since, label: `search_universal_results(${query})` }
  );
  return msg;
}

function fileRows(reply) {
  const groups = (reply && reply.groups) || {};
  return groups.files || [];
}
function titlesFor(reply) {
  return fileRows(reply).map(r => r.title);
}

before(async () => {
  await h.boot({
    workspaceOpts: {
      files: {
        // The reported collision: one name, five types.
        'packs/board-pack-q3.pdf': '%PDF-1.4 binary-ish placeholder',
        'packs/board-pack-q3.html': '<h1>Board pack</h1><p>Quarterly board pack.</p>',
        'packs/board-pack-q3.png': 'PNG placeholder bytes',
        'packs/board-pack-q3.jpg': 'JPG placeholder bytes',
        'packs/board-pack-q3.gif': 'GIF placeholder bytes',
        // A markdown note, to prove .md keeps its clean title.
        'packs/board-pack-q3.md': '# Board pack\n\nThe written board pack.',
        // An ordinary note that must not change at all.
        'notes/pricing-strategy.md': '# Pricing\n\nThe enterprise pricing ladder.',
      },
    },
  });
  client = await h.connect();
});
after(async () => h.shutdown());

describe('telling files apart in search results', () => {
  test('five files sharing a name produce five distinguishable rows', async () => {
    const reply = await search('board-pack-q3');
    const titles = titlesFor(reply);

    const collisions = titles.filter(t => String(t).startsWith('board-pack-q3'));
    assert.ok(collisions.length >= 5,
      `expected the five same-named files in results, got ${JSON.stringify(titles)}`);

    assert.strictEqual(new Set(collisions).size, collisions.length,
      'every row must carry a distinct title. Identical titles are the reported bug: '
      + `got ${JSON.stringify(collisions)}`);
  });

  test('the extension is shown for every type, markdown included', async () => {
    // Markdown used to be the one hidden extension here. That was reversed:
    // the tree shows .md and both panes must give a file one name. The full
    // rationale is recorded on displayTitle in search.js.
    const titles = titlesFor(await search('board-pack-q3'));
    for (const ext of ['pdf', 'html', 'png', 'jpg', 'gif', 'md']) {
      assert.ok(titles.includes(`board-pack-q3.${ext}`),
        `expected a row titled board-pack-q3.${ext}; got ${JSON.stringify(titles)}`);
    }
  });

  test('a title shown on screen can be found by typing it exactly', async () => {
    // The regression that would be worst: showing a name that finds nothing.
    // Query tokens are combined with implicit AND, so this is not automatic.
    for (const ext of ['pdf', 'html', 'png']) {
      const reply = await search(`board-pack-q3.${ext}`);
      assert.ok(titlesFor(reply).includes(`board-pack-q3.${ext}`),
        `typing the visible title board-pack-q3.${ext} must return that file. `
        + `Got ${JSON.stringify(titlesFor(reply))}`);
    }
  });

  test('searching a bare stem still finds a markdown note', async () => {
    // The title now carries .md, but a user typing just the name they think
    // of must still find the note.
    const titles = titlesFor(await search('pricing-strategy'));
    assert.ok(titles.includes('pricing-strategy.md'),
      `an ordinary note must be found by its stem; got ${JSON.stringify(titles)}`);
  });

  test('results carry a kind, so the row can show a per-type icon', async () => {
    // An extension alone cannot separate a note from a board (both .md), and
    // one generic icon for every file is half the reported problem. The server
    // already computes kind for the tree, so results should carry it.
    const rows = fileRows(await search('board-pack-q3'));
    const withKind = rows.filter(r => r.kind);
    assert.strictEqual(withKind.length, rows.length,
      `every file result needs a kind for its icon; ${rows.length - withKind.length} of `
      + `${rows.length} had none: ${JSON.stringify(rows.map(r => [r.title, r.kind]))}`);

    const byTitle = Object.fromEntries(rows.map(r => [r.title, r.kind]));
    assert.strictEqual(byTitle['board-pack-q3.pdf'], 'pdf');
    assert.strictEqual(byTitle['board-pack-q3.png'], 'image');
    assert.strictEqual(byTitle['board-pack-q3.md'], 'note');
  });
});
