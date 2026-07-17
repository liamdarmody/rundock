// Byte-honest frontmatter editing: the edited key's lines change, every
// other byte of the block is identical. Quote styles preserved, wikilinks
// quoted, unlocatable keys refused.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { replaceProperty } from '../../public/editor/markdown/frontmatter-edit.js';

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

describe('byte-honesty (adversarial regressions)', () => {
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
