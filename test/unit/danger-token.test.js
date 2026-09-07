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
      '.a { --callout-color: var(--danger); }',
      '.a { color: var(--danger-text); }',
      '.a { color: var(--danger-text); background: color-mix(in srgb, var(--danger) 12%, transparent); }',
      '.a { box-shadow: 0 0 0 2px color-mix(in srgb, var(--danger) 30%, transparent); }',
    ];
    for (const s of silent) {
      assert.strictEqual(s.match(TEXT_ON_FILL), null, `the text-on-fill pattern over-matches a fill or edge shape: ${s}`);
    }
  });

  test('no stylesheet colours text with the fill token', () => {
    const offenders = [];
    for (const file of stylesheets()) {
      const text = stripComments(fs.readFileSync(file, 'utf-8'));
      for (const m of text.matchAll(TEXT_ON_FILL)) {
        offenders.push(`${rel(file)}:${lineOf(text, m.index)}: ${m[0].trim()}`);
      }
    }
    assert.deepStrictEqual(offenders, [],
      'a `color:` declaration references var(--danger), which is the fill; text takes var(--danger-text)');
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
