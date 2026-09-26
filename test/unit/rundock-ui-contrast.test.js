'use strict';
// Every colour pairing a Rundock UI component draws, measured in both themes
// from the real tokens and the real stylesheet.
//
// NOTHING HERE IS A NUMBER TYPED BESIDE A TOKEN. Each row names a rule in
// public/styles/rundock-ui.css and the property that carries the foreground;
// the test reads that declaration, resolves it against tokens.css for the
// theme (including a `body.light` override where the stylesheet has one),
// and computes the WCAG 2 ratio. So an edit to a token, to a component's
// rule, or to which token a rule reads, is measured here on the next run.
//
// THE BARS. 4.5:1 for text (SC 1.4.3), 3:1 for large text (18.66px bold and
// up) and for a control's edge or a state it shows by colour (SC 1.4.11).
// --text-3 is held to 3:1, the contract tokens.css states for it and the bar
// the whole app holds it to; that is a known compromise of the app's, not of
// this library's, and it is named as one below rather than hidden.
//
// KNOWN SHORTFALLS ARE PINNED, NOT FORGIVEN. A pairing that misses its bar
// because it copies an app pattern this design did not change (the
// settings button's accent hover, the mode toggle's inactive text) is listed
// with its measured ratio and why, and the test holds the ratio to that
// value: it may improve, and then this list must shrink, but it cannot get
// worse and a new failure cannot join it unannounced.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');

// ---- tokens, per theme ----
function tokens() {
  const clean = strip(fs.readFileSync(path.join(ROOT, 'public', 'styles', 'tokens.css'), 'utf-8'));
  const block = (selector) => {
    const start = clean.indexOf(`${selector} {`);
    assert.ok(start !== -1, `tokens.css has no ${selector} block`);
    return new Map([...clean.slice(start, clean.indexOf('}', start)).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  };
  const dark = block(':root');
  const light = new Map([...dark, ...block('body.light')]);
  return { dark, light };
}

// ---- the component stylesheet, as selector -> declarations ----
function rules() {
  let css = strip(fs.readFileSync(path.join(ROOT, 'public', 'styles', 'rundock-ui.css'), 'utf-8'));
  // Keyframes and media blocks hold no colour pairings this test reads.
  css = css.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '').replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const map = new Map();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = new Map();
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i > 0) decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
    for (const selector of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      map.set(selector, new Map([...(map.get(selector) || []), ...decls]));
    }
  }
  return map;
}

// ---- colour arithmetic ----
function hex(value, where) {
  const m = /^#([0-9a-f]{6})$/i.exec(value);
  assert.ok(m, `${where} resolves to ${value}, not a six-digit hex`);
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
function ratio(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const two = (x) => Math.round(x * 100) / 100;

// A declared colour value, resolved: var(--token), white, or
// color-mix(in srgb, A p%, B), which mixes the encoded channels.
function resolve(value, theme, where) {
  const v = value.trim();
  if (v === 'white') return [255, 255, 255];
  const token = /^var\((--[\w-]+)\)$/.exec(v);
  if (token) {
    assert.ok(theme.has(token[1]), `${where} reads ${token[1]}, which tokens.css does not declare`);
    return resolve(theme.get(token[1]), theme, `${where} via ${token[1]}`);
  }
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*(.+)\)$/.exec(v);
  if (mix) {
    const p = Number(mix[2]) / 100;
    const a = resolve(mix[1], theme, where);
    const b = resolve(mix[3], theme, where);
    return a.map((c, i) => Math.round(c * p + b[i] * (1 - p)));
  }
  return hex(v, where);
}

const THEMES = tokens();
const RULES = rules();

// The value a rule declares for a property in a theme: the `body.light`
// variant of the selector wins in light, as it does in the page and in a
// frame (whose body carries the class).
function declared(selector, property, themeName) {
  const pick = (sel) => {
    const rule = RULES.get(sel);
    if (!rule) return null;
    if (rule.has(property)) return rule.get(property);
    if (property === 'background' && rule.has('background-color')) return rule.get('background-color');
    if (property === 'border-color' && rule.has('border')) return rule.get('border').replace(/^\d+px\s+(solid|dashed)\s+/, '');
    return null;
  };
  if (themeName === 'light') {
    const light = pick(`body.light ${selector}`);
    if (light) return light;
  }
  const value = pick(selector);
  assert.ok(value, `rundock-ui.css declares no ${property} on ${selector}; if the rule moved, move this row with it`);
  return value;
}

// A pairing: the foreground a rule declares, against a background that is
// either another declaration or a named token (where the component is
// transparent and lands on whatever surface it is placed on).
const SURFACES = ['--base', '--surface', '--elevated', '--card'];
const TEXT = 4.5;
const LARGE = 3;
const EDGE = 3;
const PAIRINGS = [
  // [component, label, [selector, property], background, bar]
  ['button', 'primary label', ['.rui-btn-primary', 'color'], ['.rui-btn-primary', 'background'], TEXT],
  ['button', 'primary label, hovered', ['.rui-btn-primary', 'color'], ['.rui-btn-primary:hover:not(:disabled)', 'background'], TEXT],
  ['button', 'secondary label', ['.rui-btn-secondary', 'color'], ['.rui-btn-secondary', 'background'], TEXT],
  ['button', 'secondary label, hovered', ['.rui-btn-secondary:hover:not(:disabled)', 'color'], ['.rui-btn-secondary', 'background'], TEXT],
  ['button', 'danger label', ['.rui-btn-danger', 'color'], ['.rui-btn-danger', 'background'], TEXT],
  ['button', 'danger label, hovered', ['.rui-btn-danger', 'color'], ['.rui-btn-danger:hover:not(:disabled)', 'background'], TEXT],
  ['button', 'danger label, pressed', ['.rui-btn-danger', 'color'], ['.rui-btn-danger:active:not(:disabled)', 'background'], TEXT],
  ['button', 'danger-confirm label', ['.rui-btn-danger-confirm', 'color'], ['.rui-btn-danger-confirm', 'background'], TEXT],
  ['card', 'title', ['.rui-card-title', 'color'], ['.rui-card', 'background'], TEXT],
  ['card', 'subtitle', ['.rui-card-sub', 'color'], ['.rui-card', 'background'], TEXT],
  ['field', 'label', ['.rui-field-label', 'color'], SURFACES, TEXT],
  ['field', 'help', ['.rui-field-help', 'color'], SURFACES, EDGE],
  ['field', 'error text', ['.rui-field-error-text', 'color'], SURFACES, TEXT],
  ['input', 'value', ['.rui-input', 'color'], ['.rui-input', 'background'], TEXT],
  ['input', 'placeholder', ['.rui-input::placeholder', 'color'], ['.rui-input', 'background'], EDGE],
  ['input', 'edge against its fill', ['.rui-input', 'border-color'], ['.rui-input', 'background'], EDGE],
  ['input', 'edge against the page', ['.rui-input', 'border-color'], ['--base', '--surface'], EDGE],
  ['select', 'value', ['.rui-select', 'color'], ['.rui-select', 'background'], TEXT],
  ['select', 'edge against its fill', ['.rui-select', 'border-color'], ['.rui-select', 'background'], EDGE],
  ['checkbox', 'edge, unchecked', ['.rui-checkbox', 'border-color'], ['.rui-checkbox', 'background'], EDGE],
  ['checkbox', 'label', ['.rui-check-row', 'color'], SURFACES, TEXT],
  ['toggle', 'edge, off', ['.rui-toggle', 'border-color'], ['.rui-toggle', 'background'], EDGE],
  ['toggle', 'thumb, off', ['.rui-toggle::after', 'background'], ['.rui-toggle', 'background'], EDGE],
  ['toggle', 'thumb, on', ['.rui-toggle:checked::after', 'background'], ['.rui-toggle:checked', 'background'], EDGE],
  ['toggle', 'track, on, against the page', ['.rui-toggle:checked', 'background'], SURFACES, EDGE],
  ['checkbox', 'checked fill against the page', ['.rui-checkbox:checked', 'background-color'], SURFACES, EDGE],
  ['slider', 'filled track against the page', ['.rui-slider::-moz-range-progress', 'background'], SURFACES, EDGE],
  ['optionList', 'selected dot against its option', ['.rui-option.rui-selected .rui-option-dot::after', 'background'], ['.rui-option.rui-selected', 'background'], EDGE],
  ['meter', 'fill against its track', ['.rui-meter-fill', 'background'], ['.rui-meter-track', 'background'], EDGE],
  ['iconButton', 'icon at rest', ['.rui-icon-btn', 'color'], SURFACES, EDGE],
  ['iconButton', 'send, empty', ['.rui-icon-btn-send', 'color'], ['.rui-icon-btn-send', 'background'], EDGE],
  ['iconButton', 'send, active', ['.rui-icon-btn-send.rui-active', 'color'], ['.rui-icon-btn-send.rui-active', 'background'], TEXT],
  ['iconButton', 'send, active, hovered', ['.rui-icon-btn-send.rui-active', 'color'], ['.rui-icon-btn-send.rui-active:hover:not(:disabled)', 'background'], TEXT],
  ['slider', 'label', ['.rui-slider-value', 'color'], SURFACES, TEXT],
  ['slider', 'value', ['.rui-slider-value b', 'color'], SURFACES, TEXT],
  ['slider', 'unfilled track against the page', ['.rui-slider::-moz-range-track', 'background'], ['--base', '--surface', '--elevated'], EDGE],
  ['tabs', 'inactive tab', ['.rui-tab', 'color'], ['.rui-tabs', 'background'], TEXT],
  ['tabs', 'selected tab', ['.rui-tab.rui-selected', 'color'], ['.rui-tab.rui-selected', 'background'], TEXT],
  ['optionList', 'unselected option', ['.rui-option', 'color'], ['.rui-option-list', 'background'], TEXT],
  ['optionList', 'selected option', ['.rui-option.rui-selected', 'color'], ['.rui-option.rui-selected', 'background'], TEXT],
  ['optionList', 'unselected dot', ['.rui-option-dot', 'border-color'], ['.rui-option-list', 'background'], EDGE],
  ['table', 'header', ['.rui-table th', 'color'], ['.rui-table th', 'background'], TEXT],
  ['table', 'cell', ['.rui-table td', 'color'], ['.rui-table', 'background'], TEXT],
  ['chip', 'neutral', ['.rui-chip-neutral', 'color'], ['.rui-chip-neutral', 'background'], TEXT],
  ['chip', 'accent', ['.rui-chip-accent', 'color'], ['.rui-chip-accent', 'background'], TEXT],
  ['chip', 'attention', ['.rui-chip-attention', 'color'], ['.rui-chip-attention', 'background'], TEXT],
  ['chip', 'success', ['.rui-chip-success', 'color'], ['.rui-chip-success', 'background'], TEXT],
  ['chip', 'danger', ['.rui-chip-danger', 'color'], ['.rui-chip-danger', 'background'], TEXT],
  ['emptyState', 'title', ['.rui-empty-title', 'color'], ['.rui-empty', 'background'], TEXT],
  ['emptyState', 'subtitle', ['.rui-empty-subtitle', 'color'], ['.rui-empty', 'background'], TEXT],
  ['board', 'column title', ['.rui-board-col-title', 'color'], ['.rui-board-col', 'background'], TEXT],
  ['board', 'card title', ['.rui-board-card-title', 'color'], ['.rui-board-card', 'background'], TEXT],
  ['board', 'card meta', ['.rui-board-card-meta', 'color'], ['.rui-board-card', 'background'], TEXT],
  ['menu', 'item', ['.rui-menu-item', 'color'], ['.rui-menu-list', 'background'], TEXT],
  ['menu', 'item, hovered', ['.rui-menu-item', 'color'], ['.rui-menu-item:hover', 'background'], TEXT],
  ['menu', 'current item', ['.rui-menu-item.rui-current', 'color'], ['.rui-menu-list', 'background'], TEXT],
  ['meter', 'name', ['.rui-meter-name', 'color'], SURFACES, TEXT],
  ['meter', 'value', ['.rui-meter-value', 'color'], SURFACES, TEXT],
  ['meter', 'value over its limit', ['.rui-meter-value.rui-over', 'color'], SURFACES, TEXT],
  ['alert', 'message', ['.rui-alert', 'color'], ['.rui-alert', 'background'], TEXT],
  ['stat', 'label', ['.rui-stat-label', 'color'], ['.rui-stat', 'background'], EDGE],
  ['stat', 'value (25px bold, large text)', ['.rui-stat-value', 'color'], ['.rui-stat', 'background'], LARGE],
  ['stat', 'negative value (large text)', ['.rui-stat-value.rui-negative', 'color'], ['.rui-stat', 'background'], LARGE],
  ['stat', 'delta', ['.rui-stat-delta', 'color'], ['.rui-stat', 'background'], TEXT],
  ['stat', 'delta up (the direction is in the arrow, the words and a decorative dot)', ['.rui-stat-delta', 'color'], ['.rui-stat', 'background'], TEXT],
  ['stat', 'delta down', ['.rui-stat-delta', 'color'], ['.rui-stat', 'background'], TEXT],
  ['relativeTime', 'fresh', ['.rui-time', 'color'], SURFACES, EDGE],
  ['relativeTime', 'stale', ['.rui-time.rui-stale', 'color'], SURFACES, TEXT],
  ['liveChip', 'label', ['.rui-live', 'color'], ['.rui-live', 'background'], TEXT],
  ['canvas', 'failure reason', ['.rui-canvas-failed-reason', 'color'], ['.rui-canvas-failed', 'background'], TEXT],
];

// Pairings that miss their bar, each with its measured ratio and why. Keyed
// `component / label / theme / background`. Two kinds, kept apart because
// they ask different people for different things.
const KNOWN = {
  // ---- INHERITED: the app's own patterns, copied exactly and left
  // unchanged by the approved design. Fixing them is an app-wide change.
  // --text-2 as secondary text on --card and on light surfaces (the app's
  // card captions, the mode toggle's inactive segment, board meta).
  'card / subtitle / dark / .rui-card': 4.26,
  'card / subtitle / light / .rui-card': 3.91,
  'board / card meta / dark / .rui-board-card': 4.26,
  'board / card meta / light / .rui-board-card': 3.91,
  'board / column title / light / .rui-board-col': 4.31,
  'tabs / inactive tab / light / .rui-tabs': 4.09,
  'optionList / unselected option / light / .rui-option-list': 4.09,
  'slider / label / dark / --card': 4.26,
  'slider / label / light / --base': 4.09,
  'slider / label / light / --surface': 4.31,
  'slider / label / light / --card': 3.91,
  'meter / value / dark / --card': 4.26,
  'meter / value / light / --base': 4.09,
  'meter / value / light / --surface': 4.31,
  'meter / value / light / --card': 3.91,
  // --text-3 on --card: tokens.css proves 3:1 on base, surface and elevated,
  // and --card is the one surface it was never chosen for.
  'field / help / dark / --card': 2.61,
  'stat / label / dark / .rui-stat': 2.61,
  'relativeTime / fresh / dark / --card': 2.61,
  // --danger-text on --card (4.29 to 4.36) and on light --base (4.49): the
  // token's own documented floor, which danger-token.test.js pins.
  'field / error text / dark / --card': 4.36,
  'field / error text / light / --base': 4.49,
  'field / error text / light / --card': 4.29,
  'meter / value over its limit / dark / --card': 4.36,
  'meter / value over its limit / light / --base': 4.49,
  'meter / value over its limit / light / --card': 4.29,
  // ---- ACCEPTED: the white thumb on control orange in dark (BUILD-SPEC
  // 3.10, approved). State is carried by position, and the track stands at
  // 4.43:1 against its card; a dark thumb would pass and is the look the
  // design moved away from. The checkbox tick is the same pairing, pinned in
  // the orange rule's own test.
  'toggle / thumb, on / dark / .rui-toggle:checked': 2.85,
  // --accent as hover text on --card: the app's own .settings-btn:hover.
  'button / secondary label, hovered / dark / .rui-btn-secondary': 4.43,
  'button / secondary label, hovered / light / .rui-btn-secondary': 2.44,

};

function key(component, label, theme, background) {
  return `${component} / ${label} / ${theme} / ${background}`;
}

function measure() {
  const out = [];
  for (const [component, label, [fgSel, fgProp], background, bar] of PAIRINGS) {
    for (const themeName of ['dark', 'light']) {
      const theme = THEMES[themeName];
      const fg = resolve(declared(fgSel, fgProp, themeName), theme, `${fgSel} ${fgProp}`);
      const backgrounds = Array.isArray(background) && typeof background[0] === 'string' && background[0].startsWith('--')
        ? background.map((name) => [name, resolve(`var(${name})`, theme, name)])
        : [[background[0], resolve(declared(background[0], background[1], themeName), theme, `${background[0]} ${background[1]}`)]];
      for (const [bgName, bg] of backgrounds) {
        out.push({ key: key(component, label, themeName, bgName), ratio: ratio(fg, bg), bar });
      }
    }
  }
  return out;
}

describe('Rundock UI contrast, computed from tokens.css and rundock-ui.css', () => {
  const results = measure();
  const shortfalls = results.filter((r) => r.ratio < r.bar);

  test('every pairing clears its bar in both themes, or is a pinned, explained shortfall', () => {
    const unexplained = shortfalls.filter((r) => !(r.key in LIVE_KNOWN)).map((r) => `${r.key}: ${r.ratio.toFixed(2)} under ${r.bar}`);
    assert.deepStrictEqual(unexplained, [], 'a pairing misses its bar and is not a known, explained shortfall');
  });

  test('a known shortfall is pinned at its measured ratio: it may improve, never slip', () => {
    for (const r of shortfalls) {
      if (!(r.key in LIVE_KNOWN)) continue;
      assert.ok(two(r.ratio) >= LIVE_KNOWN[r.key], `${r.key} measures ${r.ratio.toFixed(2)}, worse than its pinned ${LIVE_KNOWN[r.key]}`);
    }
  });

  test('every entry in the known list is still a shortfall, so the list only ever shrinks', () => {
    const stale = Object.keys(LIVE_KNOWN).filter((k) => !shortfalls.some((r) => r.key === k));
    assert.deepStrictEqual(stale, [], 'these pass now: remove them from the known list');
  });

  test('every component is measured', () => {
    const measured = new Set(PAIRINGS.map((p) => p[0]));
    for (const name of ['button', 'iconButton', 'card', 'field', 'input', 'select', 'checkbox', 'toggle', 'slider', 'tabs', 'table', 'chip',
      'emptyState', 'board', 'canvas', 'meter', 'alert', 'stat', 'optionList', 'relativeTime', 'liveChip', 'menu']) {
      assert.ok(measured.has(name), `no pairing measures ${name}`);
    }
  });
});

describe('the pairings BUILD-SPEC 3.8 fixed hold their new ratios', () => {
  const at = (key) => {
    const r = measure().find((m) => m.key === key);
    assert.ok(r, `no measured pairing ${key}`);
    return two(r.ratio);
  };
  test('the stat delta reads in --text-1 both ways, its dot decorative', () => {
    assert.strictEqual(at('stat / delta up (the direction is in the arrow, the words and a decorative dot) / light / .rui-stat'), 14.9, 'was 1.80 as --success text');
    assert.strictEqual(at('stat / delta down / light / .rui-stat'), 14.9, 'was 4.29 as --danger-text');
    assert.strictEqual(at('stat / delta up (the direction is in the arrow, the words and a decorative dot) / dark / .rui-stat'), 10.82);
    assert.strictEqual(declared('.rui-stat-delta.rui-up::before', 'background', 'light'), 'var(--success)');
    assert.strictEqual(declared('.rui-stat-delta.rui-down::before', 'background', 'light'), 'var(--danger-text)');
  });
  test('the trend dot, and the space it takes, exist only with a trend', () => {
    // A dot drawn on every delta indented a plain secondary line (a stat with
    // no trend) by the dot and the gap beside it.
    assert.strictEqual(RULES.get('.rui-stat-delta::before'), undefined, 'the plain delta must not draw a ::before');
    for (const dir of ['up', 'down']) {
      assert.strictEqual(declared(`.rui-stat-delta.rui-${dir}::before`, 'content', 'light'), "''", `the ${dir} delta draws its dot`);
    }
  });

  test('the current menu item is --text-1 with a check mark', () => {
    assert.strictEqual(at('menu / current item / light / .rui-menu-list'), 17.4, 'was 2.85 as --accent text');
    assert.strictEqual(declared('.rui-menu-item.rui-current::after', 'content', 'light'), "'\\2713'");
  });
  test('the danger button\'s hover and pressed tints keep its label at 4.5:1 in light', () => {
    assert.strictEqual(at('button / danger label, hovered / light / .rui-btn-danger:hover:not(:disabled)'), 4.63, 'was 4.44 at an 8% tint');
    assert.strictEqual(at('button / danger label, pressed / light / .rui-btn-danger:active:not(:disabled)'), 4.56);
  });
  test('the alert icons are decorative: measured, and recorded as such rather than as a shortfall', () => {
    // The message states the tone in words (BUILD-SPEC 3.8), so the icon is
    // not a graphical object needed to understand the alert (WCAG 1.4.11).
    const { light } = THEMES;
    const card = resolve(declared('.rui-alert', 'background', 'light'), light, 'alert');
    assert.strictEqual(two(ratio(resolve(declared('.rui-alert-attention > svg', 'color', 'light'), light, 'a'), card)), 1.77);
    assert.strictEqual(two(ratio(resolve(declared('.rui-alert-success > svg', 'color', 'light'), light, 's'), card)), 1.8);
    assert.ok(PAIRINGS.every((p) => !(p[0] === 'alert' && /icon/.test(p[1]))), 'a decorative icon is not held to a bar it is not required to meet');
  });
});

describe('the orange rule: action orange carries text or an icon, control orange is a bare shape', () => {
  // A fill that carries text or an icon is --accent-action (white at 4.5:1).
  // A bare shape is --accent-control (3:1 against its surface). The brand
  // --accent is never written as a fill: it is for outlines, focus rings,
  // hover and drag highlights and links, and --chart-* is a chart's palette.
  // Every fill in the stylesheet is sorted into one of the three, both ways.
  const FILL = /^(background|background-color)$/;
  const BRAND = /var\(--accent(?:-hover)?\)/;
  const ACTION = /var\(--accent-action(?:-hover)?\)/;
  const CONTROL = /var\(--accent-control(?:-hover)?\)/;
  const CARRIES_TEXT_OR_ICON = /rui-btn-primary|rui-chip-accent|rui-icon-btn-send/;
  // The column resize line is a bare shape too: no text, no icon.
  const BARE_SHAPE = /rui-checkbox|rui-toggle|rui-slider|rui-option-dot|rui-meter-fill|rui-col-resize/;
  function sort(rules) {
    const out = { brand: [], actionOnShape: [], controlUnderText: [] };
    for (const [selector, decls] of rules) {
      for (const [prop, value] of decls) {
        if (!FILL.test(prop)) continue;
        const rule = `${selector} { ${prop}: ${value} }`;
        // A tint mixes a colour with something else; that is a highlight, not a fill.
        if (/color-mix\(/.test(value)) continue;
        if (BRAND.test(value)) out.brand.push(rule);
        if (ACTION.test(value) && !CARRIES_TEXT_OR_ICON.test(selector)) out.actionOnShape.push(rule);
        if (CONTROL.test(value) && !BARE_SHAPE.test(selector)) out.controlUnderText.push(rule);
      }
    }
    return out;
  }

  test('the sort catches each misplaced fill it must, and passes the ones it must', () => {
    const bad = sort(new Map([
      ['.a', new Map([['background', 'var(--accent)']])],
      ['.b', new Map([['background-color', 'var(--accent-hover)']])],
      ['.c', new Map([['background', 'linear-gradient(to right, var(--accent) 0%, var(--text-3) 100%)']])],
      ['.rui-toggle:checked', new Map([['background', 'var(--accent-action)']])],
      ['.rui-btn-primary', new Map([['background', 'var(--accent-control)']])],
    ]));
    assert.deepStrictEqual([bad.brand.length, bad.actionOnShape.length, bad.controlUnderText.length], [3, 1, 1]);
    const good = sort(new Map([
      ['.a', new Map([['border-color', 'var(--accent)']])],
      ['.rui-btn-primary', new Map([['background', 'var(--accent-action)']])],
      ['.rui-slider::-webkit-slider-runnable-track', new Map([['background', 'linear-gradient(to right, var(--accent-control) 0%, var(--text-3) 100%)']])],
      ['.c', new Map([['background', 'var(--chart-1)']])],
      ['.d', new Map([['background', 'color-mix(in srgb, var(--accent) 8%, transparent)']])],
    ]));
    assert.deepStrictEqual(good, { brand: [], actionOnShape: [], controlUnderText: [] });
  });

  test('no Rundock UI fill is the brand, and every orange fill is on its own side of the rule', () => {
    assert.ok(RULES.size > 100, `only ${RULES.size} rules read; the scan has gone blind`);
    assert.deepStrictEqual(sort(RULES), { brand: [], actionOnShape: [], controlUnderText: [] });
  });

  test('each fill sits where the rule puts it', () => {
    for (const [selector, prop] of [['.rui-btn-primary', 'background'], ['.rui-chip-accent', 'background'], ['.rui-icon-btn-send.rui-active', 'background']]) {
      assert.strictEqual(declared(selector, prop, 'dark'), 'var(--accent-action)', `${selector} carries text or an icon`);
    }
    for (const [selector, prop] of [['.rui-checkbox:checked', 'background-color'], ['.rui-toggle:checked', 'background'], ['.rui-slider::-moz-range-progress', 'background'],
      ['.rui-slider::-webkit-slider-thumb', 'background'], ['.rui-option.rui-selected .rui-option-dot::after', 'background'], ['.rui-meter-fill', 'background'],
      ['.rui-col-resize:focus-visible::after', 'background']]) {
      assert.strictEqual(declared(selector, prop, 'dark'), 'var(--accent-control)', `${selector} is a bare shape`);
    }
    assert.strictEqual(declared('.rui-chip-accent', 'color', 'dark'), 'white');
  });

  test('control orange clears 3:1 against every surface in both themes, and is the brand itself in dark', () => {
    const { dark, light } = THEMES;
    assert.strictEqual(dark.get('--accent-control'), 'var(--accent)', 'dark reuses the brand, no new colour');
    assert.strictEqual(light.get('--accent-control'), '#DB5933');
    const measured = (theme) => ['--elevated', '--surface', '--base', '--card'].map((s) => two(ratio(resolve('var(--accent-control)', THEMES[theme], 'c'), hex(THEMES[theme].get(s), s))));
    assert.deepStrictEqual(measured('light'), [3.83, 3.61, 3.43, 3.28]);
    assert.strictEqual(measured('dark')[3], 4.43, 'against dark --card, the tightest surface');
    for (const r of [...measured('light'), ...measured('dark')]) assert.ok(r >= 3, `${r} is under 3:1`);
  });

  test('the white tick and thumb on control orange: 3.83:1 in light, and the accepted 2.85:1 in dark', () => {
    // The one reasoned exception (tokens.css, BUILD-SPEC 3.10): state is
    // carried by shape and position, and the control stands at 4.43:1
    // against its card. Pinned, so it cannot slip further unnoticed.
    const white = [255, 255, 255];
    assert.strictEqual(two(ratio(white, resolve('var(--accent-control)', THEMES.light, 'l'))), 3.83);
    assert.strictEqual(two(ratio(white, resolve('var(--accent-control)', THEMES.dark, 'd'))), 2.85);
    assert.match(fs.readFileSync(path.join(ROOT, 'public', 'styles', 'rundock-ui.css'), 'utf-8'), /stroke='white'/, 'the tick is white');
  });
});

describe('the filled-control token', () => {
  const { dark, light } = THEMES;
  const white = [255, 255, 255];
  test('white on --accent-action clears 4.5:1, and its hover is darker and clears it further', () => {
    const rest = ratio(white, hex(dark.get('--accent-action'), '--accent-action'));
    const hover = ratio(white, hex(dark.get('--accent-action-hover'), '--accent-action-hover'));
    assert.strictEqual(two(rest), 4.5, `white on --accent-action measures ${rest.toFixed(4)}`);
    assert.ok(rest >= 4.5, 'the margin is thin by design, and it must not be negative');
    assert.strictEqual(two(hover), 5.07);
    assert.ok(hover > rest, 'the hover darkens, so it gains contrast rather than losing it');
  });

  test('--accent-action is theme-constant, and --accent is untouched', () => {
    assert.ok(!light.has('--accent-action') || light.get('--accent-action') === dark.get('--accent-action'));
    assert.strictEqual(dark.get('--accent'), '#E87A5A', 'the brand colour is the app icon and the website: this design does not move it');
    const brand = ratio(white, hex(dark.get('--accent'), '--accent'));
    assert.strictEqual(two(brand), 2.85, 'white on the brand fill is why the filled-control token exists');
  });

  test('--accent-action and --danger sit close in luminance, which is why danger differs by form', () => {
    const apart = ratio(hex(dark.get('--accent-action'), 'a'), hex(dark.get('--danger'), 'd'));
    assert.strictEqual(two(apart), 1.11);
    const danger = RULES.get('.rui-btn-danger');
    assert.notStrictEqual(danger.get('background'), 'var(--danger)', 'a destructive button that merely starts an action is an outline, not a fill');
    assert.strictEqual(danger.get('border'), '1px solid var(--danger)');
  });
});

describe('the app carries the approved diffs', () => {
  const read = (file) => strip(fs.readFileSync(path.join(ROOT, 'public', 'styles', file), 'utf-8'));
  test('filled app controls take --accent-action with white', () => {
    assert.match(read('views/settings.css'), /\.settings-btn-primary \{[^}]*background: var\(--accent-action\); color: white;/);
    assert.match(read('views/settings.css'), /\.settings-btn-primary:hover \{ background: var\(--accent-action-hover\); \}/);
    assert.match(read('base.css'), /\.empty-cta \{[^}]*background: var\(--accent-action\); color: white;/);
    assert.match(read('views/chat.css'), /\.send-btn\.active \{ background: var\(--accent-action\); color: white;/);
  });

  test('control edges take --text-3; tinted chips are solid; the table header is --text-1', () => {
    assert.match(read('views/settings.css'), /\.settings-input \{[^}]*border: 1px solid var\(--text-3\)/);
    assert.match(read('extension-base.css'), /input, select, textarea \{[^}]*border: 1px solid var\(--text-3\)/);
    assert.match(read('extension-base.css'), /\bth \{ color: var\(--text-1\); font-weight: 700;/);
    assert.match(read('views/settings.css'), /\.pkg-card-chip \{[^}]*background: var\(--danger\); color: white; \}/);
    assert.match(read('views/chat.css'), /\.permission-resolved\.denied \{ background: var\(--accent\); color: var\(--on-chart\); \}/);
  });

  test('the working tone reads on a solid fill and the accent link has a light text token', () => {
    const settings = read('views/settings.css');
    assert.match(settings, /\.linkbtn\.accent \{ color: var\(--accent-text, var\(--accent\)\);/);
    const { dark, light } = THEMES;
    assert.strictEqual(two(ratio(hex(dark.get('--on-chart'), 'o'), hex(dark.get('--working'), 'w'))), 6.76);
    assert.strictEqual(dark.get('--accent-text'), dark.get('--accent'), 'in dark the accent text is the brand itself, unchanged');
    const text = hex(light.get('--accent-text'), '--accent-text');
    const got = ['--elevated', '--surface', '--base', '--card'].map((s) => two(ratio(text, hex(light.get(s), s))));
    assert.deepStrictEqual(got, [5.3, 5, 4.74, 4.54]);
    assert.strictEqual(dark.get('--accent'), '#E87A5A', 'the brand does not move');
  });

  test('the permission card: its own light colour, a separate code block, a readable light title', () => {
    const chat = read('views/chat.css');
    assert.match(chat, /body\.light \.permission-card \{ background: #E8E3DB; \}/);
    assert.match(chat, /body\.light \.risk-high \.permission-header \{ color: var\(--text-1\); \}/);
    assert.match(chat, /\.permission-detail \{ display: block; background: var\(--base\);/);
    assert.match(chat, /body\.light \.permission-detail \{ background: var\(--elevated\); \}/);
    const { light, dark } = THEMES;
    const card = [0xE8, 0xE3, 0xDB];
    assert.strictEqual(two(ratio(hex(light.get('--elevated'), 'e'), card)), 1.28, 'code block against the light card');
    assert.strictEqual(two(ratio(hex(dark.get('--base'), 'b'), hex(dark.get('--card'), 'c'))), 1.38, 'code block against the dark card');
    assert.ok(ratio(hex(light.get('--text-1'), 't'), card) >= 4.5, 'the light title reads on the light card');
    assert.ok(ratio(hex(dark.get('--attention'), 'a'), hex(dark.get('--card'), 'c')) >= 4.5, 'the dark title keeps its amber and reads');
  });
});

const LIVE_KNOWN = KNOWN;

if (process.env.RUNDOCK_UI_CONTRAST_REPORT) {
  for (const r of measure()) {
    if (r.ratio < r.bar) console.log(`SHORT ${r.key}: ${r.ratio.toFixed(2)} (bar ${r.bar})`);
  }
}

// The editable table's surfaces and rings (treatment A), all existing
// tokens, read from the rules that draw them. Each ring is a state shown by
// colour (SC 1.4.11), so it clears 3:1 against the active fill it sits on
// and the row separator (--border) it touches; the text clears 4.5:1 on the
// active fill and on the hovered row.
describe('the editable table: its rings and surfaces clear their bars in both themes', () => {
  const EDIT = '.rui-table td.rui-td-edit.rui-editing';
  const FOCUS = '.rui-table td.rui-td-edit:has(> .rui-cell:focus-visible)';
  const INVALID = '.rui-table td.rui-td-edit.rui-editing:has([aria-invalid="true"])';
  const HOVER = '.rui-table tbody tr:hover td';
  const ring = (selector, themeName) => /inset 0 0 0 \d+px (var\(--[\w-]+\))/.exec(declared(selector, 'box-shadow', themeName))[1];
  const measured = {};
  for (const themeName of ['dark', 'light']) {
    test(`${themeName}: every ring against the active fill and the separator, and the text on the active fill and the hovered row`, () => {
      const t = THEMES[themeName];
      const c = (value, where) => resolve(value, t, `${themeName} ${where}`);
      const active = c(declared(EDIT, 'background', themeName), 'active fill');
      assert.deepStrictEqual(c(declared(FOCUS, 'background', themeName), 'focus fill'), active, 'keyboard focus and editing share the active fill');
      const rows = {};
      for (const [name, selector] of [['focus', FOCUS], ['edit', EDIT], ['invalid', INVALID]]) {
        const fg = c(ring(selector, themeName), `${name} ring`);
        rows[`${name} ring on the active fill`] = two(ratio(fg, active));
        rows[`${name} ring on the separator`] = two(ratio(fg, c('var(--border)', 'separator')));
      }
      rows['text on the active fill'] = two(ratio(c('var(--text-1)', 'text'), active));
      rows['text on the hovered row'] = two(ratio(c('var(--text-1)', 'text'), c(declared(HOVER, 'background', themeName), 'row hover')));
      measured[themeName] = rows;
      for (const [label, value] of Object.entries(rows)) {
        assert.ok(value >= (label.startsWith('text') ? TEXT : EDGE), `${themeName}: ${label} is ${value}:1`);
      }
      if (process.env.RUI_RATIOS) console.log(themeName, JSON.stringify(rows));
    });
  }
  test('the dark active fill is lighter than the table, so the active cell reads as raised', () => {
    const active = resolve(declared(EDIT, 'background', 'dark'), THEMES.dark, 'active');
    const table = resolve(declared('.rui-table', 'background', 'dark'), THEMES.dark, 'table');
    assert.ok(luminance(active) > luminance(table), 'the dark active fill is not lighter than the table');
  });
  test('no ring or surface is a new colour: every one is an existing token', () => {
    for (const themeName of ['dark', 'light']) {
      for (const [selector, property] of [[EDIT, 'background'], [FOCUS, 'background'], [HOVER, 'background']]) {
        assert.match(declared(selector, property, themeName), /^var\(--[\w-]+\)$/, `${themeName} ${selector} ${property}`);
      }
      for (const selector of [FOCUS, EDIT, INVALID]) assert.match(ring(selector, themeName), /^var\(--[\w-]+\)$/);
    }
  });
});
