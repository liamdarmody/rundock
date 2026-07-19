// Byte-honest frontmatter editing: the edited key's lines change, every
// other byte of the block is identical. Quote styles preserved, wikilinks
// quoted, unlocatable keys refused.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { replaceProperty, editListItem, onlyEditedKeyChanged } from '../../public/editor/markdown/frontmatter-edit.js';

const RAW = [
  '---',
  'title: "Morning Briefing"',
  'status: draft',
  'count: 3',
  'flagged: false',
  'date: 2026-07-17',
  'tags: [alpha, beta]',
  'related:',
  '  - "[[Some Note]]"',
  '  - "[[Another|alias]]"',
  'nested:',
  '  inner: value',
  'summary: \'single quoted\'',
  '---',
  '',
].join('\n');

// Every line except the edited key's lines must be byte-identical.
function assertOnlyKeyChanged(before, after, keyLinePrefixes) {
  const a = before.split('\n');
  const b = after.split('\n');
  const bSet = new Set(b);
  for (const line of a) {
    if (keyLinePrefixes.some((p) => line.startsWith(p) || line.trim().startsWith('- '))) continue;
    assert.ok(bSet.has(line), `untouched line must survive byte-exact: ${JSON.stringify(line)}`);
  }
}

describe('scalar edits', () => {
  test('double-quoted string keeps its quotes; other lines untouched', () => {
    const { raw, changed } = replaceProperty(RAW, 'title', 'Evening Briefing');
    assert.equal(changed, true);
    assert.ok(raw.includes('title: "Evening Briefing"'));
    assertOnlyKeyChanged(RAW, raw, ['title:']);
  });

  test('bare scalar stays bare; single quotes stay single', () => {
    assert.ok(replaceProperty(RAW, 'status', 'final').raw.includes('status: final'));
    assert.ok(replaceProperty(RAW, 'summary', "it's fine").raw.includes("summary: 'it''s fine'"));
  });

  test('numbers and booleans write bare', () => {
    assert.ok(replaceProperty(RAW, 'count', 7).raw.includes('count: 7'));
    assert.ok(replaceProperty(RAW, 'flagged', true).raw.includes('flagged: true'));
  });

  test('a bare value that would misparse gets quoted (wikilinks, colons, numbers-as-strings)', () => {
    assert.ok(replaceProperty(RAW, 'status', '[[A Note]]').raw.includes('status: "[[A Note]]"'));
    assert.ok(replaceProperty(RAW, 'status', 'a: b').raw.includes('status: "a: b"'));
    assert.ok(replaceProperty(RAW, 'status', '42').raw.includes('status: "42"'));
  });

  test('date values write bare ISO', () => {
    assert.ok(replaceProperty(RAW, 'date', '2026-08-01').raw.includes('date: 2026-08-01'));
  });
});

describe('list edits', () => {
  test('block list reuses indentation and quote style; only its lines change', () => {
    const { raw, changed } = replaceProperty(RAW, 'related', ['[[Some Note]]', '[[Third Note]]']);
    assert.equal(changed, true);
    assert.ok(raw.includes('related:\n  - "[[Some Note]]"\n  - "[[Third Note]]"'));
    assert.ok(!raw.includes('[[Another|alias]]'));
    assertOnlyKeyChanged(RAW, raw, ['related:']);
    assert.ok(raw.includes('nested:\n  inner: value'), 'the nested object after the list is untouched');
  });

  test('flow list re-emits flow; hazardous items are quoted', () => {
    const { raw } = replaceProperty(RAW, 'tags', ['alpha', 'gamma delta']);
    assert.ok(raw.includes('tags: [alpha, gamma delta]'), 'plain scalars stay bare in flow');
    const hazard = replaceProperty(RAW, 'tags', ['a,b', '[[Note]]']).raw;
    assert.ok(hazard.includes('tags: ["a,b", "[[Note]]"]'), 'commas and wikilinks quote');
  });

  test('emptying a block list collapses to []', () => {
    const { raw } = replaceProperty(RAW, 'related', []);
    assert.ok(raw.includes('related: []'));
    assert.ok(!raw.includes('[[Some Note]]'));
  });
});

describe('byte-honesty (edge-case regressions)', () => {
  test('removing one block-list item leaves the others byte-identical (no requoting, no type change)', () => {
    const raw = '---\ntags:\n  - plain\n  - "quoted with spaces"\n  - 42\n---\n';
    // Remove the middle item -> the survivors keep their exact original lines.
    const { raw: out, changed } = replaceProperty(raw, 'tags', ['plain', '42']);
    assert.equal(changed, true);
    assert.ok(out.includes('  - plain\n  - 42'), 'survivors keep raw form (42 stays a number, no quotes added)');
    assert.ok(!out.includes('"quoted with spaces"'), 'removed item gone');
    assert.ok(!out.includes('- "plain"') && !out.includes('- "42"'), 'no spurious requoting of untouched items');
  });

  test('a folded/multi-line scalar is refused, not merged into the value', () => {
    const folded = '---\ntitle: >\n  first line\n  second line\nother: x\n---\n';
    assert.equal(replaceProperty(folded, 'title', 'short').changed, false, 'block scalar refused');
    const plainMulti = '---\ntitle: first\n  second\n---\n';
    assert.equal(replaceProperty(plainMulti, 'title', 'short').changed, false, 'wrapped plain scalar refused');
  });

  test('zero-indent block lists (Obsidian style) are located and edited, not corrupted', () => {
    const raw = '---\ntags:\n- alpha\n- beta\n---\n';
    const { raw: out, changed } = replaceProperty(raw, 'tags', ['alpha']);
    assert.equal(changed, true);
    assert.equal(out, '---\ntags:\n- alpha\n---\n', 'beta removed, alpha kept verbatim, no phantom insertion');
  });
});

describe('editListItem: index-based, byte-honest', () => {
  test('removing an item never re-parses survivors: ~, comments, and quote-twins are untouched', () => {
    // Remove "alpha" (index 0); every other item's LINE must be byte-identical,
    // including the null sigil and the comment-bearing item.
    const raw = '---\ntags:\n  - alpha\n  - ~\n  - foo # keep this comment\n  - "beta"\n---\n';
    const { raw: out, changed } = editListItem(raw, 'tags', { remove: 0 });
    assert.equal(changed, true);
    assert.equal(out, '---\ntags:\n  - ~\n  - foo # keep this comment\n  - "beta"\n---\n');
  });

  test('adding an item appends one formatted line, leaving all others verbatim', () => {
    const raw = '---\ntags:\n  - alpha\n  - "quoted item"\n---\n';
    const { raw: out } = editListItem(raw, 'tags', { add: 'gamma' });
    assert.ok(out.includes('  - alpha\n  - "quoted item"\n  - gamma'));
    const hazard = editListItem(raw, 'tags', { add: '[[Note]]' }).raw;
    assert.ok(hazard.includes('  - "[[Note]]"'), 'hazardous new items are quoted');
  });

  test('removing the last block item collapses to []', () => {
    const { raw: out } = editListItem('---\ntags:\n  - only\n---\n', 'tags', { remove: 0 });
    assert.ok(out.includes('tags: []'));
    assert.ok(!out.includes('- only'));
  });

  test('zero-indent block lists edit by line too', () => {
    const { raw: out } = editListItem('---\ntags:\n- a\n- b\n- c\n---\n', 'tags', { remove: 1 });
    assert.equal(out, '---\ntags:\n- a\n- c\n---\n');
  });

  test('flow lists mutate in place; adding to [] works', () => {
    assert.ok(editListItem('---\ntags: [a, b]\n---\n', 'tags', { remove: 0 }).raw.includes('tags: [b]'));
    assert.ok(editListItem('---\ntags: [a]\n---\n', 'tags', { add: 'x,y' }).raw.includes('tags: [a, "x,y"]'));
    assert.ok(editListItem('---\ntags: []\n---\n', 'tags', { add: 'first' }).raw.includes('tags: [first]'));
  });

  test('out-of-range and unlocatable are refused', () => {
    assert.equal(editListItem('---\ntags:\n  - a\n---\n', 'tags', { remove: 5 }).changed, false);
    assert.equal(editListItem('---\ntags:\n  - a\n---\n', 'ghost', { remove: 0 }).changed, false);
  });
});

describe('refusals (never a guess)', () => {
  test('missing key, nested object, and non-frontmatter input are refused', () => {
    assert.equal(replaceProperty(RAW, 'ghost', 'x').changed, false);
    assert.equal(replaceProperty(RAW, 'nested', 'x').changed, false, 'scalar write onto a block value refused');
    assert.equal(replaceProperty('no frontmatter here', 'title', 'x').changed, false);
    assert.equal(replaceProperty(null, 'title', 'x').changed, false);
  });

  test('a key name that prefixes another key does not mismatch', () => {
    const raw = '---\ndate: 2026-01-01\ndated: yes\n---\n';
    const out = replaceProperty(raw, 'date', '2026-02-02').raw;
    assert.ok(out.includes('date: 2026-02-02'));
    assert.ok(out.includes('dated: yes'));
  });

  test('round-trip stability: replacing a value with itself changes only that line, byte-stably', () => {
    const once = replaceProperty(RAW, 'title', 'Morning Briefing').raw;
    assert.equal(once, RAW, 'same value -> identical bytes');
  });
});

describe('unindented multi-line quoted scalar', () => {
  // A double-quoted scalar whose value continues on an unindented line at
  // column 0. locateKey used to miss the continuation, so editing the key
  // truncated the value and promoted the continuation to a spurious top-level
  // key while still parsing as valid YAML.
  const RAW_MULTILINE = '---\ndesc: "first\nsecond: nope"\ntitle: hi\n---\n';

  test('editing the multi-line quoted key is refused, not truncated', () => {
    const res = replaceProperty(RAW_MULTILINE, 'desc', 'X');
    assert.equal(res.changed, false);
    assert.equal(res.raw, RAW_MULTILINE);
  });

  test('a single-line double-quoted scalar still edits normally', () => {
    const raw = '---\ndesc: "hello"\ntitle: hi\n---\n';
    const res = replaceProperty(raw, 'desc', 'bye');
    assert.equal(res.changed, true);
    assert.ok(res.raw.includes('desc: "bye"'));
    assert.ok(res.raw.includes('title: hi'));
  });

  test('editing a later key does not disturb the multi-line quoted scalar above it', () => {
    const res = replaceProperty(RAW_MULTILINE, 'title', 'bye');
    // title has no continuation, so it edits; desc must stay byte-identical.
    assert.equal(res.changed, true);
    assert.ok(res.raw.includes('desc: "first\nsecond: nope"'));
  });
});

describe('byte-honesty backstop: onlyEditedKeyChanged', () => {
  const BEFORE = '---\ndesc: "first\nsecond: nope"\ntitle: hi\n---\n';

  test('rejects a transform that invents or drops a non-edited key', () => {
    // Simulates the truncating transform: desc shortened, spurious `second`.
    const bad = '---\ndesc: X\nsecond: nope"\ntitle: hi\n---\n';
    assert.equal(onlyEditedKeyChanged(BEFORE, bad, 'desc'), false);
  });

  test('rejects a transform that alters a non-edited key value', () => {
    const before = '---\na: 1\nb: 2\n---\n';
    const bad = '---\na: 9\nb: 9\n---\n';
    assert.equal(onlyEditedKeyChanged(before, bad, 'a'), false);
  });

  test('accepts a transform that changes only the edited key', () => {
    const before = '---\na: 1\nb: 2\n---\n';
    const good = '---\na: 9\nb: 2\n---\n';
    assert.equal(onlyEditedKeyChanged(before, good, 'a'), true);
  });

  test('accepts a list-item edit under the edited key', () => {
    const before = '---\ntags:\n  - a\n  - b\nkeep: yes\n---\n';
    const good = '---\ntags:\n  - a\nkeep: yes\n---\n';
    assert.equal(onlyEditedKeyChanged(before, good, 'tags'), true);
  });
});
