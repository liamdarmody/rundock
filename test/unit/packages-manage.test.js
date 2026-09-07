'use strict';
// The Packages page as a place to manage what was installed: the nav entry
// that reaches it, the handlers that write enablement and answer the page,
// the rows the real settings view draws for every state, the receipts of
// what a package added, and the stylesheet block that draws all of it from
// tokens alone.
//
// Server halves run against a temporary workspace through the real
// handlers; client halves render through the real settings view under jsdom
// with the model modules loaded the way the page loads them; the client
// wiring is cut out of app.js and run, never matched.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');

// ---------------------------------------------------------------------------
// The stylesheet block: every colour a token, tints through color-mix over a
// token, the hover tint and the keyboard ring on different properties.
// ---------------------------------------------------------------------------

const SHEET = 'public/styles/views/settings.css';
const BLOCK_START = '/* ---- The Packages page: managed extensions and receipts ---- */';
const BLOCK_END = '/* ---- end of the Packages page block ---- */';

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

// The block between its two markers, comments blanked. Asserted found and
// non-trivial, so a moved or deleted block fails here by name rather than
// scanning an empty string that carries no literal.
function manageBlock() {
  const sheet = read(SHEET);
  const start = sheet.indexOf(BLOCK_START);
  const end = sheet.indexOf(BLOCK_END);
  assert.ok(start !== -1 && end > start, `${SHEET} no longer carries the Packages page block between its markers`);
  const block = stripComments(sheet.slice(start + BLOCK_START.length, end));
  assert.ok(block.split('{').length > 20, 'the block has fewer rules than the page needs; an empty read here is a broken instrument');
  return block;
}

// One rule's declarations by exact selector, as a property-to-value map.
function ruleIn(block, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(block);
  assert.ok(m, `the block carries no rule for ${selector}`);
  return new Map(m[1].split(';').map((d) => d.trim()).filter(Boolean)
    .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]));
}

const HEX = /(^|[^&\w])#[0-9a-fA-F]{3,8}\b/g;
const COLOUR_FUNC = /\b(rgba?|hsla?)\(/g;
const COLOUR_PROPS = new Set(['color', 'background', 'background-color', 'border-color', 'border', 'border-top', 'box-shadow', 'outline']);

describe('the Packages page stylesheet block draws only from tokens', () => {
  test('the literal scans bite on specimens before the block is trusted', () => {
    assert.ok('.a { color: #E85A5A; }'.match(HEX), 'the hex scan no longer matches its own specimen');
    assert.ok('.a { background: rgba(0,0,0,0.1); }'.match(COLOUR_FUNC), 'the colour-function scan no longer matches its own specimen');
    assert.strictEqual('.a { content: "&#8593;"; }'.match(HEX), null, 'the hex scan reads a character reference as a colour');
  });

  test('no hex and no rgba or hsla literal anywhere in the block', () => {
    const block = manageBlock();
    assert.deepStrictEqual([...block.matchAll(HEX)].map((m) => m[0].trim()), [], 'a hex literal in the block; use a token');
    assert.deepStrictEqual([...block.matchAll(COLOUR_FUNC)].map((m) => m[0]), [], 'an rgba or hsla literal in the block; tint through color-mix over a token');
  });

  test('every colour-carrying declaration references a token, and every tint is a color-mix over one', () => {
    const block = manageBlock();
    const offenders = [];
    let declarations = 0;
    for (const m of block.matchAll(/([\w-]+)\s*:\s*([^;{}]+);/g)) {
      const [, prop, value] = m;
      if (!COLOUR_PROPS.has(prop)) continue;
      declarations += 1;
      const v = value.trim();
      const inert = /^(none|transparent|inherit|currentColor|0)$/.test(v);
      if (inert) continue;
      if (!/var\(--[\w-]+\)/.test(v)) offenders.push(`${prop}: ${v}`);
      if (/color-mix\(/.test(v) && !/color-mix\(in srgb, var\(--[\w-]+\) \d+%, transparent\)/.test(v)) {
        offenders.push(`a tint not drawn over a token: ${prop}: ${v}`);
      }
    }
    assert.ok(declarations >= 25, `only ${declarations} colour declarations found; the scan has gone blind`);
    assert.deepStrictEqual(offenders, []);
  });

  test('the hover tint and the keyboard ring sit on different properties, so both render together', () => {
    const block = manageBlock();
    const hover = ruleIn(block, '.ext-row:hover');
    assert.strictEqual(hover.get('background'), 'var(--elevated)', 'hover is the elevated tint');
    assert.ok(!hover.has('box-shadow') && !hover.has('outline'), 'hover draws no ring, so it cannot cancel the keyboard one');
    const ring = ruleIn(block, '.ext-row:focus-within');
    assert.match(ring.get('box-shadow') || '', /inset[^;]*var\(--accent\)|var\(--accent\)[^;]*inset/, 'the keyboard ring is an inset accent outline');
    assert.ok(!ring.has('background'), 'the ring rule leaves the background to the hover rule');
  });

  test('the quiet link button rests in the secondary text colour and turns danger text on hover; the fill is never resting', () => {
    const block = manageBlock();
    assert.strictEqual(ruleIn(block, '.linkbtn').get('color'), 'var(--text-2)');
    assert.strictEqual(ruleIn(block, '.linkbtn.danger:hover').get('color'), 'var(--danger-text)');
    assert.strictEqual(ruleIn(block, '.linkbtn.quiet:hover').get('color'), 'var(--accent)');
    for (const m of block.matchAll(/\.linkbtn[^{]*\{([^}]*)\}/g)) {
      assert.ok(!/background\s*:\s*var\(--danger\)/.test(m[1]), 'a link button never takes the danger fill; that is the confirmation button alone');
    }
    assert.ok(ruleIn(block, '.linkbtn:focus-visible').get('outline'), 'the link button carries the keyboard focus convention');
  });

  test('the repository segment wraps and is never clipped with an ellipsis', () => {
    const block = manageBlock();
    const src = ruleIn(block, '.ext-row .meta .src');
    assert.strictEqual(src.get('white-space'), 'normal');
    assert.strictEqual(src.get('overflow-wrap'), 'anywhere');
    assert.ok(!src.has('text-overflow') && !src.has('overflow'), 'provenance is never truncated');
  });

  test('each state chip takes its named tone token, and the danger chips take the text token, never the fill', () => {
    const block = manageBlock();
    const tones = {
      '.ext-chip.enabled': 'var(--success)',
      '.ext-chip.disabled': 'var(--idle)',
      '.ext-chip.update': 'var(--attention)',
      '.ext-chip.working': 'var(--working)',
      '.ext-chip.bad': 'var(--danger-text)',
    };
    for (const [selector, token] of Object.entries(tones)) {
      assert.strictEqual(ruleIn(block, selector).get('color'), token, `${selector} is drawn in ${token}`);
    }
    assert.match(ruleIn(block, '.ext-row .problem').get('color'), /var\(--danger-text\)/);
    assert.match(ruleIn(block, '.ext-row .row-note.danger').get('color'), /var\(--danger-text\)/);
  });
});
