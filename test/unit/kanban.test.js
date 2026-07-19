'use strict';
// Byte-level parity tests for public/kanban.js, the Obsidian Kanban plugin
// (v2.0.51) parser/serializer. The bar is byte interchangeability: a board
// file edited in Rundock and Obsidian alternately must never churn. Every
// move/CRUD/lane op is proven to change ONLY the bytes it should, by
// constructing the expected output through pure text surgery on the canonical
// form.
//
// Fixtures (test/fixtures/kanban/) are synthetic sample boards. Format rules were
// reverse-engineered from the installed plugin's compiled bundle.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const Kanban = require('../../public/kanban.js');

const FIX = path.join(__dirname, '..', 'fixtures', 'kanban');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');

// Line diff sufficient for eyeballing failures and for the drift classifier.
function lineDiff(a, b) {
  const la = a.split('\n'), lb = b.split('\n');
  const out = [];
  let i = 0, j = 0;
  while (i < la.length && j < lb.length) {
    if (la[i] === lb[j]) { i++; j++; continue; }
    let synced = false;
    for (let k = 1; k <= 6 && !synced; k++) {
      if (la[i + k] === lb[j]) { for (let x = 0; x < k; x++) out.push(`-${i + x + 1}: ${JSON.stringify(la[i + x])}`); i += k; synced = true; }
      else if (la[i] === lb[j + k]) { for (let x = 0; x < k; x++) out.push(`+${j + x + 1}: ${JSON.stringify(lb[j + x])}`); j += k; synced = true; }
    }
    if (!synced) { out.push(`-${i + 1}: ${JSON.stringify(la[i])}`); out.push(`+${j + 1}: ${JSON.stringify(lb[j])}`); i++; j++; }
    if (out.length > 60) { out.push('... (diff truncated)'); return out; }
  }
  for (; i < la.length; i++) out.push(`-${i + 1}: ${JSON.stringify(la[i])}`);
  for (; j < lb.length; j++) out.push(`+${j + 1}: ${JSON.stringify(lb[j])}`);
  return out;
}

/** Extract a card's text block (title line + all tab-continuation lines, incl. trailing \n). */
function extractBlock(text, titleLinePrefix) {
  const start = text.indexOf('\n' + titleLinePrefix) + 1;
  if (start <= 0) throw new Error('card not found: ' + titleLinePrefix);
  let end = text.indexOf('\n', start) + 1;
  while (end < text.length && text[end] === '\t') end = text.indexOf('\n', end) + 1;
  return { block: text.slice(start, end), start, end };
}

// Canonical form (a fixed point of parse->serialize) for each fixture, computed
// once. Byte-surgery expectations are built against `.once`, so a hand-edit in
// the raw fixture never destabilises the move/CRUD/lane tests.
function canonical(file) {
  const orig = read(file);
  const board = Kanban.parse(orig);
  const once = Kanban.serialize(board);
  return { orig, board, once };
}

const backlog = canonical('backlog.md');
const roadmap = canonical('roadmap.md');
// A single board packing many constructs at once (WIP limit, Complete marker,
// nested checkboxes, block id, <br> lane title, block-style frontmatter,
// archive, and cards with wikilinks/links/dates/tags/code): proves byte-exact
// round-trip holds when constructs coexist, not just in isolation.
const combined = canonical('combined.md');

describe('round-trip idempotence and canonicalisation drift', () => {
  for (const [label, fx] of [['backlog', backlog], ['roadmap', roadmap], ['combined', combined]]) {
    test(`${label}: serialize is idempotent (canonical form is a fixed point)`, () => {
      const twice = Kanban.serialize(Kanban.parse(fx.once));
      assert.strictEqual(fx.once, twice, lineDiff(fx.once, twice).join('\n'));
    });

    test(`${label}: drift vs original is blank-line normalisation only (no content changes)`, () => {
      const drift = lineDiff(fx.orig, fx.once);
      const removed = drift.filter(d => d.startsWith('-')).map(d => JSON.parse(d.replace(/^-\d+: /, '')));
      const added = drift.filter(d => d.startsWith('+')).map(d => JSON.parse(d.replace(/^\+\d+: /, '')));
      const nonBlankRemoved = removed.filter(l => l.trim() !== '').sort().join(' ');
      const nonBlankAdded = added.filter(l => l.trim() !== '').sort().join(' ');
      assert.strictEqual(nonBlankRemoved, nonBlankAdded,
        'non-blank line content changed:\n' + drift.slice(0, 30).join('\n'));
    });

    test(`${label}: zero dropped lines (plugin-canonical board carries nothing droppable)`, () => {
      assert.strictEqual(fx.board.dropped.length, 0, JSON.stringify(fx.board.dropped.slice(0, 5)));
    });
  }
});

describe('move-card byte discipline (backlog)', () => {
  const base = backlog.once;
  const readyIdx = () => Kanban.parse(base).lanes.findIndex(l => l.title === 'Ready');
  const firstTwoTitles = () => {
    const b = Kanban.parse(base);
    const r = b.lanes.findIndex(l => l.title === 'Ready');
    return [0, 1].map(i => '- [' + b.lanes[r].items[i].checkChar + '] ' + b.lanes[r].items[i].titleRaw.split('\n')[0]);
  };

  test('reorder within Ready: bytes differ ONLY by the two swapped card blocks', () => {
    const board = Kanban.parse(base);
    const ready = board.lanes.findIndex(l => l.title === 'Ready');
    const [t0, t1] = firstTwoTitles();
    const b0 = extractBlock(base, t0);
    const b1 = extractBlock(base, t1);
    const expected = base.slice(0, b0.start) + b1.block + b0.block + base.slice(b1.end);
    Kanban.moveItem(board, ready, 0, ready, 1);
    assert.strictEqual(Kanban.serialize(board), expected);
  });

  test('cross-lane move Inbox->Ready: bytes differ ONLY by the moved card block', () => {
    const board = Kanban.parse(base);
    const inbox = board.lanes.findIndex(l => l.title === 'Inbox');
    const ready = board.lanes.findIndex(l => l.title === 'Ready');
    const [t0] = firstTwoTitles();
    const ti = '- [' + board.lanes[inbox].items[0].checkChar + '] ' + board.lanes[inbox].items[0].titleRaw.split('\n')[0];
    const bi = extractBlock(base, ti);
    const withoutCard = base.slice(0, bi.start) + base.slice(bi.end);
    const br0 = extractBlock(withoutCard, t0);
    const expected = withoutCard.slice(0, br0.start) + bi.block + withoutCard.slice(br0.start);
    Kanban.moveItem(board, inbox, 0, ready, 0);
    assert.strictEqual(Kanban.serialize(board), expected);
  });

  test('move to In Progress and back restores canonical bytes exactly', () => {
    const board = Kanban.parse(base);
    const ready = board.lanes.findIndex(l => l.title === 'Ready');
    const inprog = board.lanes.findIndex(l => l.title === 'In Progress');
    Kanban.moveItem(board, ready, 0, inprog, 0);
    Kanban.moveItem(board, inprog, 0, ready, 0);
    assert.strictEqual(Kanban.serialize(board), base);
  });

  test('move into empty lane: canonical spacing and idempotent under reparse', () => {
    const board = Kanban.parse(base);
    const ready = board.lanes.findIndex(l => l.title === 'Ready');
    const inprog = board.lanes.findIndex(l => l.title === 'In Progress');
    const [t0] = firstTwoTitles();
    const b0 = extractBlock(base, t0);
    Kanban.moveItem(board, ready, 0, inprog, 0);
    const out = Kanban.serialize(board);
    assert.strictEqual(Kanban.serialize(Kanban.parse(out)), out, 'idempotent');
    assert.ok(out.includes('## In Progress\n\n' + b0.block.split('\n')[0]), 'card under heading with canonical spacing');
  });
});

describe('add + archive round-trip (backlog)', () => {
  const base = backlog.once;

  test('add card: diff is exactly one added line', () => {
    const board = Kanban.parse(base);
    Kanban.addItem(board, 0, 'in-app test card #type/ops');
    const d1 = lineDiff(base, Kanban.serialize(board));
    assert.ok(d1.length === 1 && d1[0].startsWith('+'), d1.join('\n'));
  });

  test('archive card: *** + ## Archive present, card is last archive entry, before settings', () => {
    const board = Kanban.parse(base);
    Kanban.addItem(board, 0, 'in-app test card #type/ops');
    const withCard = Kanban.serialize(board);
    const board2 = Kanban.parse(withCard);
    Kanban.archiveItem(board2, 0, board2.lanes[0].items.length - 1);
    const archived = Kanban.serialize(board2);
    const parsedBack = Kanban.parse(archived);
    assert.ok(archived.includes('***\n\n## Archive\n\n'), 'separator + heading');
    assert.strictEqual(parsedBack.archive[parsedBack.archive.length - 1].titleRaw, 'in-app test card #type/ops');
    const idxArchive = archived.indexOf('## Archive');
    const idxSettings = archived.indexOf('%% kanban:settings');
    assert.ok(idxArchive > 0 && idxArchive < idxSettings, 'archive sits before settings');
  });
});

describe('edge inventory (edge-cases fixture)', () => {
  const fx = read('edge-cases.md');
  const b = Kanban.parse(fx);

  test('fixture is byte-stable (canonical fixed point) with zero dropped lines', () => {
    assert.strictEqual(Kanban.serialize(b), fx, lineDiff(fx, Kanban.serialize(b)).join('\n'));
    assert.strictEqual(b.dropped.length, 0, JSON.stringify(b.dropped));
  });

  test('lane WIP limit "(3)" parses as maxItems; **Complete** marker parses', () => {
    const doing = b.lanes[0];
    assert.strictEqual(doing.title, 'Doing');
    assert.strictEqual(doing.maxItems, 3);
    assert.strictEqual(doing.shouldMarkItemsComplete, true);
  });

  test('multi-paragraph body: blank line round-trips through a tab-only line', () => {
    assert.ok(b.lanes[0].items[0].titleRaw.includes('here.\n\n  Second paragraph'));
  });

  test('fenced code block inside a card is preserved in titleRaw', () => {
    assert.ok(b.lanes[0].items[1].titleRaw.includes('```js\n  const x = 1;\n  ```'));
  });

  test('block id split from first line; checkChar preserved; nested checkboxes stay inside parent', () => {
    const bid = b.lanes[0].items[2];
    assert.strictEqual(bid.blockId, 'abc-123');
    assert.strictEqual(bid.checkChar, 'x');
    assert.ok(!bid.titleRaw.includes('^abc-123'));
    assert.strictEqual(b.lanes[0].items.length, 4);
    assert.ok(bid.titleRaw.includes('- [ ] nested unchecked'));
  });

  test('custom checkChar preserved; <br> lane title parses to newline; archive parsed', () => {
    assert.strictEqual(b.lanes[0].items[3].checkChar, '-');
    assert.strictEqual(b.lanes[1].title, 'Two\nLines');
    assert.strictEqual(b.archive.length, 1);
    assert.strictEqual(b.archive[0].checkChar, 'x');
  });

  test('hand-authored normalisations: ### -> ##, bare item gains checkbox, 2-space cont. gains a tab', () => {
    const hand = ['---', '', 'kanban-plugin: board', '', '---', '', '',
      '### Deep Heading', '', '- bare item no checkbox', '- [ ] two-space indent card', '  indented with two spaces only', '', '', ''].join('\n')
      + ['', '', '%% kanban:settings', '```', '{"kanban-plugin":"board"}', '```', '%%'].join('\n');
    const hout = Kanban.serialize(Kanban.parse(hand));
    assert.ok(hout.includes('## Deep Heading') && !hout.includes('### Deep Heading'));
    assert.ok(hout.includes('- [ ] bare item no checkbox'));
    assert.ok(hout.includes('- [ ] two-space indent card\n\t  indented with two spaces only'));
    assert.strictEqual(Kanban.serialize(Kanban.parse(hout)), hout, 'idempotent after one canonicalisation');
  });
});

describe('update / delete / toggle byte discipline (backlog)', () => {
  const base = backlog.once;
  const readyFirstTitle = () => {
    const b = Kanban.parse(base);
    const r = b.lanes.findIndex(l => l.title === 'Ready');
    const it = b.lanes[r].items[0];
    return '- [' + it.checkChar + '] ' + it.titleRaw.split('\n')[0];
  };

  test('update: bytes differ ONLY by the edited card block (tab re-indent applied); idempotent', () => {
    const board = Kanban.parse(base);
    const ready = board.lanes.findIndex(l => l.title === 'Ready');
    const b0 = extractBlock(base, readyFirstTitle());
    Kanban.updateItem(board, ready, 0, '**Edited card title**\n  New body line for the CRUD test.');
    const after = Kanban.serialize(board);
    const expected = base.slice(0, b0.start)
      + '- [ ] **Edited card title**\n\t  New body line for the CRUD test.\n'
      + base.slice(b0.end);
    assert.strictEqual(after, expected, lineDiff(expected, after).slice(0, 10).join('\n'));
    assert.strictEqual(Kanban.serialize(Kanban.parse(after)), after, 'idempotent');
  });

  test('delete: bytes differ ONLY by the removed card block', () => {
    const board = Kanban.parse(base);
    const ready = board.lanes.findIndex(l => l.title === 'Ready');
    const b0 = extractBlock(base, readyFirstTitle());
    Kanban.deleteItem(board, ready, 0);
    assert.strictEqual(Kanban.serialize(board), base.slice(0, b0.start) + base.slice(b0.end));
  });

  test('toggle: exactly the checkbox char changes; double-toggle restores canonical bytes', () => {
    const board = Kanban.parse(base);
    const ready = board.lanes.findIndex(l => l.title === 'Ready');
    const b0 = extractBlock(base, readyFirstTitle());
    Kanban.toggleItem(board, ready, 0);
    assert.strictEqual(Kanban.serialize(board), base.slice(0, b0.start) + '- [x]' + base.slice(b0.start + 5));
    Kanban.toggleItem(board, ready, 0);
    assert.strictEqual(Kanban.serialize(board), base);
  });

  test('update preserves blockId and checkChar (fields live outside titleRaw)', () => {
    const fx = Kanban.parse(read('edge-cases.md'));
    const bidItem = fx.lanes[0].items[2];
    Kanban.updateItem(fx, 0, 2, 'Edited body, id must survive');
    assert.strictEqual(bidItem.blockId, 'abc-123');
    assert.strictEqual(bidItem.checkChar, 'x');
    assert.ok(Kanban.serialize(fx).includes('- [x] Edited body, id must survive ^abc-123'));
  });
});

describe('lane operations (column parity byte discipline, backlog)', () => {
  const base = backlog.once;

  test('moveLane: lane order changes; list-collapse reorders in LOCKSTEP; reversible', () => {
    const b1 = Kanban.parse(base);
    const lcBefore = [...b1.settings['list-collapse']];
    const titlesBefore = b1.lanes.map(l => l.title);
    Kanban.moveLane(b1, 0, 2);
    const out1 = Kanban.serialize(b1);
    const b1b = Kanban.parse(out1);
    assert.deepStrictEqual(b1b.lanes.map(l => l.title),
      [titlesBefore[1], titlesBefore[2], titlesBefore[0], ...titlesBefore.slice(3)]);
    assert.deepStrictEqual(b1b.settings['list-collapse'],
      [lcBefore[1], lcBefore[2], lcBefore[0], ...lcBefore.slice(3)]);
    assert.strictEqual(Kanban.serialize(Kanban.parse(out1)), out1, 'idempotent');
    Kanban.moveLane(b1, 2, 0);
    assert.strictEqual(Kanban.serialize(b1), base, 'reversible to canonical bytes');
  });

  test('toggleCollapse: diff is EXACTLY the settings JSON line; double-toggle restores', () => {
    const b2 = Kanban.parse(base);
    Kanban.toggleCollapse(b2, 1);
    const d2 = lineDiff(base, Kanban.serialize(b2));
    assert.ok(d2.length === 2 && d2.every(l => l.includes('list-collapse')), d2.join('\n'));
    Kanban.toggleCollapse(b2, 1);
    assert.strictEqual(Kanban.serialize(b2), base);
  });

  test('renameLane: one heading line changes; WIP suffix round-trips; reversible', () => {
    const b3 = Kanban.parse(base);
    const original = b3.lanes[3].maxItems ? `${b3.lanes[3].title} (${b3.lanes[3].maxItems})` : b3.lanes[3].title;
    Kanban.renameLane(b3, 3, 'Doing (2)');
    const d3 = lineDiff(base, Kanban.serialize(b3));
    assert.ok(d3.length === 2 && d3.some(l => l.includes('## Doing (2)')), d3.join('\n'));
    const b3b = Kanban.parse(Kanban.serialize(b3));
    assert.strictEqual(b3b.lanes[3].title, 'Doing');
    assert.strictEqual(b3b.lanes[3].maxItems, 2);
    Kanban.renameLane(b3, 3, original);
    assert.strictEqual(Kanban.serialize(b3), base);
  });

  test('insertLane: canonical empty-lane spacing; false spliced into list-collapse; deleteLane restores', () => {
    const b4 = Kanban.parse(base);
    const lc4 = [...b4.settings['list-collapse']];
    Kanban.insertLane(b4, 2, 'Blocked');
    const out4 = Kanban.serialize(b4);
    assert.ok(out4.includes('## Blocked\n\n\n\n## '), 'empty-lane spacing');
    assert.deepStrictEqual(b4.settings['list-collapse'], [...lc4.slice(0, 2), false, ...lc4.slice(2)]);
    assert.strictEqual(Kanban.serialize(Kanban.parse(out4)), out4, 'idempotent');
    Kanban.deleteLane(b4, 2);
    assert.strictEqual(Kanban.serialize(b4), base, 'deleteLane restores, collapse spliced back');
  });

  test('archiveLaneCards: cards PREPEND in lane order; lane stays empty; idempotent', () => {
    const b5 = Kanban.parse(base);
    const ready5 = b5.lanes.findIndex(l => l.title === 'Ready');
    const readyTitles = b5.lanes[ready5].items.map(i => i.titleRaw.split('\n')[0]);
    const archBefore = b5.archive.map(i => i.titleRaw.split('\n')[0]);
    Kanban.archiveLaneCards(b5, ready5);
    assert.deepStrictEqual(b5.archive.map(i => i.titleRaw.split('\n')[0]), [...readyTitles, ...archBefore]);
    assert.strictEqual(b5.lanes[ready5].items.length, 0);
    assert.strictEqual(b5.lanes[ready5].title, 'Ready');
    const out5 = Kanban.serialize(b5);
    assert.strictEqual(Kanban.serialize(Kanban.parse(out5)), out5);
  });

  test('archiveLane removes lane but keeps cards; deleteLane removes both', () => {
    const b6 = Kanban.parse(base);
    const inboxCount = b6.lanes[1].items.length;
    const archCount = b6.archive.length;
    Kanban.archiveLane(b6, 1);
    assert.ok(!b6.lanes.some(l => l.title === 'Inbox'));
    assert.strictEqual(b6.archive.length, archCount + inboxCount);
    const b7 = Kanban.parse(base);
    Kanban.deleteLane(b7, 1);
    assert.ok(!b7.lanes.some(l => l.title === 'Inbox'));
    assert.strictEqual(b7.archive.length, archCount);
    assert.strictEqual(Kanban.serialize(Kanban.parse(Kanban.serialize(b7))), Kanban.serialize(b7));
  });

  test('sortLane: pure permutation of card blocks; content set unchanged; byte-stable', () => {
    const b8 = Kanban.parse(base);
    const ready8 = b8.lanes.findIndex(l => l.title === 'Ready');
    const before8 = [...b8.lanes[ready8].items.map(i => i.titleRaw)].sort();
    Kanban.sortLane(b8, ready8, 'text');
    const out8 = Kanban.serialize(b8);
    const b8b = Kanban.parse(out8);
    assert.deepStrictEqual([...b8b.lanes[ready8].items.map(i => i.titleRaw)].sort(), before8);
    assert.strictEqual(Kanban.serialize(b8b), out8);
    Kanban.sortLane(b8, ready8, 'tags');
    assert.deepStrictEqual([...b8.lanes[ready8].items.map(i => i.titleRaw)].sort(), before8);
    assert.strictEqual(Kanban.serialize(Kanban.parse(Kanban.serialize(b8))), Kanban.serialize(b8));
  });
});

describe('board creation and detection lifecycle', () => {
  test('newBoardContent is byte-exact to the plugin basicFrontmatter', () => {
    assert.strictEqual(Kanban.newBoardContent(), '---\n\nkanban-plugin: board\n\n---\n\n');
  });

  test('isBoardFile mirrors hasFrontmatterKeyRaw', () => {
    assert.strictEqual(Kanban.isBoardFile(Kanban.newBoardContent()), true);
    assert.strictEqual(Kanban.isBoardFile(backlog.orig), true);
    assert.strictEqual(Kanban.isBoardFile('---\ntitle: Note\n---\n\n# Hi\n'), false);
    assert.strictEqual(Kanban.isBoardFile('# Just markdown\n'), false);
  });

  test('fresh board: zero lanes, settings hoisted from frontmatter', () => {
    const fresh = Kanban.parse(Kanban.newBoardContent());
    assert.strictEqual(fresh.lanes.length, 0);
    assert.strictEqual(fresh.dropped.length, 0);
    assert.deepStrictEqual(fresh.settings, { 'kanban-plugin': 'board' });
  });

  test('first save adds the settings block in the plugin first-save shape; idempotent', () => {
    const fresh = Kanban.parse(Kanban.newBoardContent());
    Kanban.insertLane(fresh, 0, 'To do');
    const firstSave = Kanban.serialize(fresh);
    assert.strictEqual(firstSave,
      '---\n\nkanban-plugin: board\n\n---\n\n## To do\n\n\n\n\n\n%% kanban:settings\n```\n{"kanban-plugin":"board","list-collapse":[false]}\n```\n%%');
    assert.strictEqual(Kanban.serialize(Kanban.parse(firstSave)), firstSave);
  });

  test('legacy kanban-plugin: basic migrates to board in both homes on save', () => {
    const legacy = '---\n\nkanban-plugin: basic\n\n---\n\n## Old\n\n- [ ] card\n\n\n\n%% kanban:settings\n```\n{"kanban-plugin":"basic"}\n```\n%%';
    const lOut = Kanban.serialize(Kanban.parse(legacy));
    assert.ok(lOut.includes('kanban-plugin: board'));
    assert.ok(lOut.includes('{"kanban-plugin":"board"}'));
    assert.ok(!lOut.includes('basic'));
  });

  test('the hoist is byte-neutral on canonical boards', () => {
    assert.strictEqual(Kanban.serialize(Kanban.parse(backlog.once)), backlog.once);
  });

  test('block-style frontmatter (multi-line lists, nested maps) survives a round-trip', () => {
    // A flat key/value re-emit would destroy these; the body is preserved verbatim.
    const src = '---\n\nkanban-plugin: board\ntitle: My board\ntags:\n  - project\n  - kanban\naliases:\n  - "[[Other]]"\n\n---\n\n## To do\n\n- [ ] a card\n\n\n\n\n%% kanban:settings\n```\n{"kanban-plugin":"board","list-collapse":[false]}\n```\n%%';
    const board = Kanban.parse(src);
    const out = Kanban.serialize(board);
    // The tag/alias lists and every frontmatter line survive intact.
    assert.ok(out.includes('tags:\n  - project\n  - kanban'), 'block tag list preserved');
    assert.ok(out.includes('aliases:\n  - "[[Other]]"'), 'block alias list preserved');
    assert.ok(out.includes('title: My board'), 'scalar preserved');
    // And it is a fixed point (idempotent) with a card edit staying byte-honest.
    assert.strictEqual(Kanban.serialize(Kanban.parse(out)), out, 'idempotent');
    assert.strictEqual(board.dropped.length, 0, 'nothing reported dropped');
    Kanban.toggleItem(board, 0, 0);
    const toggled = Kanban.serialize(board);
    assert.ok(toggled.includes('tags:\n  - project\n  - kanban'), 'tags still intact after a card edit');
  });

  test('a fresh board built via newBoardContent still emits the canonical first-save shape', () => {
    const fresh = Kanban.parse(Kanban.newBoardContent());
    Kanban.insertLane(fresh, 0, 'To do');
    assert.strictEqual(Kanban.serialize(fresh),
      '---\n\nkanban-plugin: board\n\n---\n\n## To do\n\n\n\n\n\n%% kanban:settings\n```\n{"kanban-plugin":"board","list-collapse":[false]}\n```\n%%');
  });
});
