'use strict';
// The danger colour is two tokens, and the stylesheets have to keep them apart.
//
// --danger is a FILL. It is the same value in both themes, chosen so that white
// text on it clears 4.5:1 and so that it sits far enough from --accent in
// lightness that a filled destructive button no longer reads as another orange
// one. Hue alone could not do that: the two hues are thirteen degrees apart,
// which is exactly the distinction protanopes and deuteranopes lose, and a
// lightness step is visible to everyone.
//
// --danger-text is for TEXT, and it is theme-aware, because the fill value
// fails as text on a dark card at 2.52:1. One value cannot be both a fill
// that carries white text and a text colour that reads on --card in the dark
// theme, so the token split rather than compromise.
//
// This file guards the split three ways: no `color:` declaration may reach
// for the fill token; every stylesheet that used the family before the split
// still uses it after, so no reference was dropped in the sort; and the
// contrast the values were chosen for is computed from tokens.css on every
// run, so a later edit to either value, or to a surface, fails here rather
// than in someone's eyes.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const STYLES = path.join(ROOT, 'public', 'styles');

function stylesheets() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.css')) out.push(full);
    }
  };
  walk(STYLES);
  return out.sort();
}

// Blank comments rather than delete them, so reported line numbers stay true.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

const TOKENS = path.join(STYLES, 'tokens.css');

// tokens.css as two maps: the dark declarations on :root and the light
// overrides on body.light. The light block is cut out by its selector, the
// same way test/unit/token-references.test.js reads it.
function tokenBlocks() {
  const clean = stripComments(fs.readFileSync(TOKENS, 'utf-8'));
  const start = clean.indexOf('body.light {');
  assert.ok(start !== -1, 'the light theme block should exist');
  const end = clean.indexOf('}', start);
  const declare = (text) => new Map(
    [...text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]),
  );
  const blocks = { dark: declare(clean.slice(0, start) + clean.slice(end)), light: declare(clean.slice(start, end)) };
  assert.ok(blocks.dark.size > 30 && blocks.light.size > 3, 'the token parse found almost nothing, so this proves nothing');
  return blocks;
}

// One rule's declarations, by selector, as a property-to-value map, so a
// pattern is asserted by what it declares rather than by its text. The
// selector is matched whole, at a rule boundary, so `.settings-btn:hover`
// cannot be satisfied by `.settings-btn.danger:hover`. Null when the rule
// is absent; ruleOf asserts it found.
function findRule(file, selector) {
  const text = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf-8'));
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(text);
  if (!m) return null;
  return new Map(m[1].split(';').map(d => d.trim()).filter(Boolean)
    .map(d => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]));
}
function ruleOf(file, selector) {
  const rule = findRule(file, selector);
  assert.ok(rule, `${file} carries no rule for ${selector}; if it moved, move this lookup with it`);
  return rule;
}

// WCAG 2 relative luminance and contrast ratio, from a six-digit hex. The
// parse asserts the shape, so a token rewritten as rgb() or a shorthand hex
// fails by name rather than as a NaN ratio that compares equal to nothing.
function channels(hex, name) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(m, `${name} is ${hex}, not a six-digit hex; this test reads only that shape`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
const twoPlaces = (x) => Math.round(x * 100) / 100;
const WHITE = [255, 255, 255];

const rel = (file) => path.relative(ROOT, file);
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// A declaration whose property is exactly `color`, whose value references the
// fill token. Anchored on what precedes the property, so border-color,
// background-color and --callout-color (all of which end in "color") cannot
// match, and closed on the token name, so --danger-text cannot match either.
// The value part stops at the declaration's end, so a `color: var(--danger-
// text)` beside a `background: ... var(--danger)` in the same rule is not
// pulled across the semicolon into a false match.
const TEXT_ON_FILL = /(^|[{;\s])color\s*:\s*[^;}]*?var\(\s*--danger\s*\)/g;

// The same rule through indirection: a custom property whose declared value
// carries the fill (`--callout-color: var(--danger)`), or carries another
// property that does, is a fill-carrying property, and a `color` declaration
// that references one colours text with the fill just as surely as the
// literal shape above. Resolved to a fixpoint over the file, so a chain of
// properties is followed, and closed on the token name so `--danger-text`
// never counts as the fill.
function fillCarryingProperties(text) {
  // Resolved rule by rule: a reference to a property the same rule declares
  // means that rule's own value (`--callout-text: var(--callout-color)` in a
  // rule whose tone is a status colour carries that colour, not the fill),
  // and a reference to a property the rule does not declare means whatever
  // any rule in the file gave it, so a chain across rules is followed too.
  const blocks = [...text.matchAll(/\{([^{}]*)\}/g)].map((m) => {
    const local = new Map();
    for (const d of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]*)/g)) local.set(d[1], d[2]);
    return local;
  });
  const refsOf = (value) => [...value.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1]);
  const carrying = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const local of blocks) {
      const seen = new Set();
      const localCarries = (name) => {
        if (seen.has(name)) return false;
        seen.add(name);
        return refsOf(local.get(name)).some((r) => r === '--danger'
          || (local.has(r) ? localCarries(r) : carrying.has(r)));
      };
      for (const name of local.keys()) {
        if (carrying.has(name)) continue;
        seen.clear();
        if (localCarries(name)) { carrying.add(name); grew = true; }
      }
    }
  }
  return carrying;
}
function textThroughIndirection(text) {
  const hits = [];
  const carrying = fillCarryingProperties(text);
  if (carrying.size === 0) return hits;
  const names = [...carrying].map((n) => n.replace(/[-]/g, '\\-')).join('|');
  const pattern = new RegExp(`(^|[{;\\s])color\\s*:\\s*[^;}]*?var\\(\\s*(${names})\\s*\\)`, 'g');
  for (const m of text.matchAll(pattern)) hits.push({ index: m.index, text: m[0].trim(), via: m[2] });
  return hits;
}

// The ten stylesheets that referenced the danger family before the split, and
// the number of references across them at that point. Each file must still
// reference the family afterwards, and the total must not fall, so a use
// dropped while sorting fills from text is loud rather than silent.
const FAMILY_FILES = [
  'public/styles/components/connection-bar.css',
  'public/styles/components/find-bar.css',
  'public/styles/components/sidebar.css',
  'public/styles/views/chat.css',
  'public/styles/views/editor.css',
  'public/styles/views/routine-editor.css',
  'public/styles/views/routines.css',
  'public/styles/views/run-detail.css',
  'public/styles/views/settings.css',
  'public/styles/views/workspace.css',
];
const FAMILY_REFERENCES_AT_SPLIT = 27;
const FAMILY = /var\(\s*--danger(?:-text)?\s*\)/g;

describe('text never reaches for the danger fill', () => {
  test('the text-on-fill pattern bites every text shape and no fill or edge shape', () => {
    // The scan below passes on an empty list, and an empty list is what a
    // pattern that has quietly stopped matching returns. The specimen proves
    // it still bites first, on every shape it must catch, and proves it stays
    // silent on every shape it must ignore.
    const bites = [
      '.a { color: var(--danger); }',
      '.a{color:var(--danger)}',
      '.a { font-weight: 600; color: var(--danger); }',
      '.a { color: color-mix(in srgb, var(--danger) 60%, white); }',
      '.a:hover { color: var( --danger ); background: var(--surface); }',
    ];
    for (const s of bites) {
      assert.ok(s.match(TEXT_ON_FILL), `the text-on-fill pattern no longer matches its own specimen: ${s}`);
    }
    const silent = [
      '.a { border-color: var(--danger); }',
      '.a { background-color: var(--danger); }',
      '.a { background: var(--danger); color: white; }',
      '.a { background: color-mix(in srgb, var(--danger) 10%, transparent); }',
      '.a { color: var(--danger-text); }',
      '.a { color: var(--danger-text); background: color-mix(in srgb, var(--danger) 12%, transparent); }',
      '.a { box-shadow: 0 0 0 2px color-mix(in srgb, var(--danger) 30%, transparent); }',
    ];
    for (const s of silent) {
      assert.strictEqual(s.match(TEXT_ON_FILL), null, `the text-on-fill pattern over-matches a fill or edge shape: ${s}`);
    }
  });

  test('the indirect shape is caught: a custom property carrying the fill, read by a color declaration', () => {
    // The specimen the literal pattern cannot see. A property set to the
    // fill and then read as text is the callout tone's own shape, so it
    // must bite, and it must bite through a chain; a property set to the
    // text token, or a fill-carrying property read only by a fill, is
    // silent.
    const bites = [
      '.a { --callout-color: var(--danger); } .b { color: var(--callout-color); }',
      '.a { --tone: var(--danger); --ink: var(--tone); } .b { color: var(--ink); }',
      '.a { --tone: var(--danger); } .b::before { content: "x"; color: var( --tone ); }',
      // A cross-rule chain still resolves through the file.
      '.a { --tone: var(--danger); } .c { --ink: var(--tone); } .b { color: var(--ink); }',
    ];
    for (const s of bites) {
      assert.ok(textThroughIndirection(s).length > 0, `indirection is not caught: ${s}`);
    }
    const silent = [
      '.a { --callout-color: var(--danger); --callout-text: var(--danger-text); } .b { color: var(--callout-text); }',
      // The same-rule reference resolves to that rule's own tone: a status
      // callout whose text follows its tone is not the danger callout.
      '.d { --callout-color: var(--danger); --callout-text: var(--danger-text); } .a { --callout-color: var(--success); --callout-text: var(--callout-color); } .b { color: var(--callout-text); }',
      '.a { --callout-color: var(--danger); } .b { background: var(--callout-color); border-color: var(--callout-color); }',
      '.a { --tone: var(--danger-text); } .b { color: var(--tone); }',
    ];
    for (const s of silent) {
      assert.deepStrictEqual(textThroughIndirection(s), [], `over-matched: ${s}`);
    }
  });

  test('no stylesheet colours text with the fill token, directly or through a custom property', () => {
    const offenders = [];
    for (const file of stylesheets()) {
      const text = stripComments(fs.readFileSync(file, 'utf-8'));
      for (const m of text.matchAll(TEXT_ON_FILL)) {
        offenders.push(`${rel(file)}:${lineOf(text, m.index)}: ${m[0].trim()}`);
      }
      for (const hit of textThroughIndirection(text)) {
        offenders.push(`${rel(file)}:${lineOf(text, hit.index)}: ${hit.text} (${hit.via} carries the fill)`);
      }
    }
    assert.deepStrictEqual(offenders, [],
      'a `color:` declaration reaches var(--danger), the fill, directly or through a custom property; text takes var(--danger-text)');
  });

  test('every stylesheet that used the family still does, and no reference was dropped', () => {
    const files = new Set(stylesheets().map(rel));
    let total = 0;
    for (const file of FAMILY_FILES) {
      assert.ok(files.has(file), `${file} is gone; if it moved, move its row here with it`);
      const text = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf-8'));
      const n = (text.match(FAMILY) || []).length;
      assert.ok(n >= 1, `${file} no longer references the danger family at all`);
      total += n;
    }
    assert.ok(total >= FAMILY_REFERENCES_AT_SPLIT,
      `${total} danger-family references across the ten files, fewer than the ${FAMILY_REFERENCES_AT_SPLIT} there were at the split`);
  });
});

describe('the split is declared', () => {
  test('the fill is declared on :root and has no light override', () => {
    const { dark, light } = tokenBlocks();
    assert.ok(dark.has('--danger'), 'the fill token is not declared on :root');
    assert.ok(!light.has('--danger'), 'the fill must be the same in both themes, so body.light must not restate it');
  });

  test('the text token is declared on :root and overridden on body.light', () => {
    const { dark, light } = tokenBlocks();
    assert.ok(dark.has('--danger-text'), 'the text token is not declared on :root, so it would be undefined in dark');
    assert.ok(light.has('--danger-text'), 'the text token has no light override, so light text would take the dark value');
    assert.notStrictEqual(dark.get('--danger-text'), light.get('--danger-text'),
      'the light override must change the value, or it is not an override');
  });
});

describe('a resting destructive action is not filled', () => {
  const SETTINGS = 'public/styles/views/settings.css';
  const ROUTINES = 'public/styles/views/routines.css';
  const SIDEBAR = 'public/styles/components/sidebar.css';

  test('the outline button turns danger on hover, and nothing fills at rest or on hover', () => {
    // The resting state is the plain .settings-btn: a rule of its own for
    // .settings-btn.danger would be a change at rest, which is the thing
    // this pattern exists to avoid.
    assert.strictEqual(findRule(SETTINGS, '.settings-btn.danger'), null,
      'the resting destructive button must be the plain outline, with no rule of its own');
    const hover = ruleOf(SETTINGS, '.settings-btn.danger:hover');
    assert.strictEqual(hover.get('border-color'), 'var(--danger)', 'the edge takes the fill token on hover');
    assert.strictEqual(hover.get('color'), 'var(--danger-text)', 'the label takes the text token on hover');
    for (const prop of ['background', 'background-color']) {
      assert.ok(!hover.has(prop), `the hover must not fill: it declares ${prop}`);
    }
  });

  test('the confirmation fill keeps its fill and its white text', () => {
    const fill = ruleOf(SETTINGS, '.settings-btn-danger');
    assert.strictEqual(fill.get('background'), 'var(--danger)');
    assert.strictEqual(fill.get('color'), 'white');
    assert.strictEqual(fill.get('border'), 'none');
  });

  test('the hover-only destructive rules colour their text with the text token', () => {
    for (const [file, selector] of [
      [ROUTINES, '.icon-btn.danger:hover'],
      [SIDEBAR, '.files-menu-item.danger:hover'],
      [SIDEBAR, '.convo-delete:hover'],
    ]) {
      assert.strictEqual(ruleOf(file, selector).get('color'), 'var(--danger-text)', `${selector} in ${file}`);
    }
  });
});

describe('the values were chosen against contrast, and stay chosen', () => {
  // Every figure below is computed from tokens.css on each run, never
  // written as a constant beside the token, so an edit to either danger
  // value OR to a surface it lands on fails here with the new ratio in the
  // message. The expected ratios are pinned to two places because that is
  // the precision the values were chosen at; the thresholds beneath them are
  // the bars they were chosen to clear.
  const read = (block, name) => {
    assert.ok(block.has(name), `${name} is not declared in that theme block`);
    return channels(block.get(name), name);
  };

  test('white on the fill clears AA, and the fill is a fill in both themes', () => {
    const { dark } = tokenBlocks();
    const ratio = contrast(WHITE, read(dark, '--danger'));
    assert.strictEqual(twoPlaces(ratio), 5.01, `white on the fill measures ${ratio.toFixed(4)}`);
    assert.ok(ratio >= 4.5, 'white on the fill must clear 4.5:1');
  });

  test('dark-theme text reads on the card and the base', () => {
    const { dark } = tokenBlocks();
    const text = read(dark, '--danger-text');
    const onCard = contrast(text, read(dark, '--card'));
    const onBase = contrast(text, read(dark, '--base'));
    assert.strictEqual(twoPlaces(onCard), 4.36, `dark text on --card measures ${onCard.toFixed(4)}`);
    assert.strictEqual(twoPlaces(onBase), 6.01, `dark text on --base measures ${onBase.toFixed(4)}`);
    for (const [label, r] of [['card', onCard], ['base', onBase]]) {
      assert.ok(r >= 3.0, `dark text on the ${label} must clear 3:1`);
    }
  });

  test('light-theme text reads on the card, the base and the elevated surface', () => {
    const { light } = tokenBlocks();
    const text = read(light, '--danger-text');
    const onCard = contrast(text, read(light, '--card'));
    const onBase = contrast(text, read(light, '--base'));
    const onElevated = contrast(text, read(light, '--elevated'));
    assert.strictEqual(twoPlaces(onCard), 4.29, `light text on --card measures ${onCard.toFixed(4)}`);
    assert.strictEqual(twoPlaces(onBase), 4.49, `light text on --base measures ${onBase.toFixed(4)}`);
    assert.strictEqual(twoPlaces(onElevated), 5.01, `light text on --elevated measures ${onElevated.toFixed(4)}`);
    for (const [label, r] of [['card', onCard], ['base', onBase], ['elevated', onElevated]]) {
      assert.ok(r >= 3.0, `light text on the ${label} must clear 3:1`);
    }
  });

  test('the fill sits apart from the accent in lightness, not only in hue', () => {
    // A hue rotation is what protanopes and deuteranopes lose, so the two
    // fills have to differ in value as well. The bar is the gray-scale
    // contrast between the two, computed from the tokens so a drift that
    // closes the gap fails here: the old pair measured 1.22 and read as the
    // same button.
    const { dark, light } = tokenBlocks();
    assert.ok(!light.has('--accent') && !light.has('--danger'), 'both fills are shared by the themes, so one block is enough');
    const apart = contrast(read(dark, '--accent'), read(dark, '--danger'));
    assert.ok(apart >= 1.70, `accent and danger fills measure ${apart.toFixed(4)} apart, under the 1.70 bar`);
  });
});
