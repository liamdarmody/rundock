'use strict';
// The routine screens, measured in both themes from the real tokens and the
// real stylesheets: the routines list and its sidebar, the run screen, the
// routine editor, and the two rail badges every screen shows.
//
// Each row names the rules that draw one kind of text or mark, the property
// carrying its color, the token those rules must draw, the surface it sits on
// and the bar it has to clear: 4.5:1 for text (SC 1.4.3), 3:1 for a badge, a
// dot or a focus ring (SC 1.4.11). Every row is two tests: the rule draws the
// token, so a rule moved back to its old token fails by name, and the color
// the rule draws clears the bar on its surface in each theme, so a token
// edited to a value that no longer reads fails by name too.
//
// HOW A TOKEN RESOLVES IN EACH THEME, which is the part a quick parse gets
// wrong. The light theme overrides tokens on body, not on :root, and a custom
// property is computed on the element that declares it. A token declared only
// on :root is computed there with the dark values, and body inherits that
// result even in light. So a token whose value names other tokens (a
// color-mix of --accent-text and --text-1) has to be declared on a rule that
// body.light matches, or the light theme reads the dark mix. The resolver
// below follows that rule rather than merging the two blocks, so a
// declaration made only on :root fails its light row.
//
// THE STATED RATIOS are pinned to two places beside each row, so a token or a
// surface that moves fails here even while it still clears its bar. A mixed
// or composited color is measured without rounding its channels to whole
// numbers, so three of them read 0.01 or 0.02 off the design's table, which
// rounded them: the ring on the selected row (4.72 and 3.35 here, 4.70 and
// 3.36 there) and the link text (5.06 and 5.53 here, 5.05 and 5.55 there).
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, 'public', 'styles', ...parts), 'utf-8');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');

const TOKENS_SRC = read('tokens.css');
const SHEETS = {
  sidebar: read('components', 'sidebar.css'),
  routines: read('views', 'routines.css'),
  run: read('views', 'run-detail.css'),
  editor: read('views', 'routine-editor.css'),
  // The shared switch, which the routines list draws for this computer.
  ui: read('rundock-ui.css'),
};

// Every rule in a stylesheet, as selector => declarations. A selector list is
// split, and a selector written twice has its declarations merged in order.
// @media blocks are dropped: each row here is about the rule a reader sees at
// rest, and a media override merged into it would answer a different question.
function rules(source) {
  const css = strip(source).replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const out = new Map();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = new Map();
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i > 0) decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
    for (const sel of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
      out.set(sel, new Map([...(out.get(sel) || []), ...decls]));
    }
  }
  return out;
}

// The two themes, each as a function from a token name to its color, read
// from a tokens.css source (the real one, or a specimen altered on purpose).
function themesOf(source) {
  const all = rules(source);
  const declaredOn = (selector) => {
    const out = new Map();
    for (const [sel, decls] of all) {
      if (sel !== selector) continue;
      for (const [k, v] of decls) if (k.startsWith('--')) out.set(k, v);
    }
    return out;
  };
  const root = declaredOn(':root');
  const light = declaredOn('body.light');
  assert.ok(root.size > 30, 'the token parse found almost nothing on :root, so nothing below is measured');
  assert.ok(light.size > 10, 'the token parse found almost nothing on body.light, so nothing below is measured');

  function resolve(theme, name, where) {
    // Declared on body.light: computed on body, against the light values.
    // Declared only on :root: computed on :root against the dark values, and
    // inherited by body as that result, in either theme.
    if (theme === 'light' && light.has(name)) return value(light.get(name), 'light', where);
    assert.ok(root.has(name) || light.has(name), `${where}: ${name} is declared nowhere in tokens.css`);
    assert.ok(root.has(name), `${where}: ${name} is declared nowhere the ${theme} theme reads`);
    return value(root.get(name), 'dark', where);
  }
  function value(raw, theme, where) {
    const v = raw.trim();
    let m = /^#([0-9a-f]{6})$/i.exec(v);
    if (m) {
      const n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    if (v === 'white') return [255, 255, 255];
    m = /^var\((--[\w-]+)\)$/.exec(v);
    if (m) return resolve(theme, m[1], where);
    m = /^color-mix\(in srgb, (var\(--[\w-]+\)) (\d+)%, (var\(--[\w-]+\))\)$/.exec(v);
    if (m) {
      const a = value(m[1], theme, where);
      const b = value(m[3], theme, where);
      const p = Number(m[2]) / 100;
      return a.map((c, i) => c * p + b[i] * (1 - p));
    }
    m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(v);
    if (m) return { tint: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: Number(m[4]) };
    assert.fail(`${where}: cannot read the color ${v}`);
  }
  return {
    dark: (name, where) => resolve('dark', name, where),
    light: (name, where) => resolve('light', name, where),
    value: (raw, theme, where) => value(raw, theme, where),
  };
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const round2 = (n) => Math.round(n * 100) / 100;
// A tint laid over an opaque surface, as the browser composites it.
const over = (tint, base) => base.map((c, i) => tint.tint[i] * tint.alpha + c * (1 - tint.alpha));

// The declaration a rule makes, refusing by name when the rule or the
// property is missing.
function declared(sheet, selector, prop) {
  const rule = rules(SHEETS[sheet]).get(selector);
  assert.ok(rule, `${sheet}.css has no ${selector} rule`);
  assert.ok(rule.has(prop), `${selector} declares no ${prop}`);
  return rule.get(prop);
}
// The color a declaration paints. An outline or border shorthand paints its
// last word.
function paint(prop, raw) {
  if (prop === 'border') {
    const edge = /^1px solid (var\(--[\w-]+\))$/.exec(raw);
    assert.ok(edge, `the edge is a 1px solid token, not ${raw}`);
    return edge[1];
  }
  if (prop !== 'outline') return raw;
  const m = /^2px solid (var\(--[\w-]+\))$/.exec(raw);
  assert.ok(m, `the ring is a 2px solid token, not ${raw}`);
  return m[1];
}

// The selected scope row's fill, read from the sidebar's own rules: the
// selected tint over the sidebar it sits on.
function selectedFill(themes, theme, where) {
  const tint = themes.value(declared('sidebar', '.scope-item.active', 'background'), theme, where);
  const base = themes.value(declared('sidebar', '.sidebar', 'background'), theme, where);
  assert.ok(tint.tint, `${where}: the selected fill is not a tint, so this measures the wrong surface`);
  return over(tint, base);
}
const SELECTED = 'the selected scope row';
function surface(themes, theme, name, where) {
  if (name === SELECTED) return selectedFill(themes, theme, where);
  return themes[theme](name, where);
}

// [where, sheet, selectors, property, token, surface, bar, stated dark, stated light]
const ROWS = [
  ['the Conversations rail badge', 'sidebar', ['.nav-badge'], 'background', '--attention-text', '--chrome', 3, 8.97, 4.21],
  ['the Team rail badge', 'sidebar', ['.nav-badge-working'], 'background', '--success-text', '--chrome', 3, 8.85, 5.18],
  ['the Finished chip', 'run', ['.rd-chip.ok'], 'color', '--success-text', '--card', 4.5, 6.02, 5.62],
  ['the row\'s Ran lines', 'routines', ['.run-status.ok', '.run-status.ok-quiet'], 'color', '--success-text', '--card', 4.5, 6.02, 5.62],
  ['the row\'s Next run', 'routines', ['.next-run'], 'color', '--success-text', '--card', 4.5, 6.02, 5.62],
  ['the Stopped and No ending recorded chips', 'run', ['.rd-chip.stopped', '.rd-chip.unwitnessed'], 'color', '--text-2-strong', '--card', 4.5, 4.70, 5.02],
  ['the run guidance', 'run', ['.rd-guidance'], 'color', '--text-2-strong', '--card', 4.5, 4.70, 5.02],
  ['the editor\'s option explanation', 'editor', ['.re-meta'], 'color', '--text-2-strong', '--card', 4.5, 4.70, 5.02],
  ['the Still going chip', 'run', ['.rd-chip.live'], 'color', '--working-text', '--card', 4.5, 4.91, 5.01],
  ['the row\'s Still going line', 'routines', ['.run-status.live'], 'color', '--working-text', '--card', 4.5, 4.91, 5.01],
  ['the row\'s Missed and Stopped lines', 'routines', ['.run-status.neutral'], 'color', '--text-2-strong', '--card', 4.5, 4.70, 5.02],
  ['the row\'s meta line and its separator', 'routines', ['.rr-meta', '.rr-meta .sep'], 'color', '--text-2-strong', '--card', 4.5, 4.70, 5.02],
  ['the Paused label', 'routines', ['.next-run.paused-label'], 'color', '--text-2-strong', '--card', 4.5, 4.70, 5.02],
  ['the Paused dot', 'routines', ['.rr-paused-dot'], 'background', '--text-2-strong', '--card', 4.5, 4.70, 5.02],
  ['View last run', 'routines', ['.rr-view-run'], 'color', '--text-2-strong', '--card', 4.5, 4.70, 5.02],
  ['the Took line', 'run', ['.rd-took'], 'color', '--text-2-strong', '--card', 4.5, 4.70, 5.02],
  ['the file paths', 'run', ['.rd-file-path'], 'color', '--text-2-strong', '--card', 4.5, 4.70, 5.02],
  ['the change tags', 'run', ['.rd-tag'], 'color', '--text-2-strong', '--card', 4.5, 4.70, 5.02],
  ['the started time', 'run', ['.rd-when'], 'color', '--text-2-strong', '--card', 4.5, 4.70, 5.02],
  ['the scope counts', 'sidebar', ['.scope-count'], 'color', '--text-2-strong', '--surface', 4.5, 5.99, 5.53],
  ['the sidebar label', 'sidebar', ['.sidebar-label'], 'color', '--text-2-strong', '--surface', 4.5, 5.99, 5.53],
  ['the scope focus ring', 'sidebar', ['.scope-item:focus-visible'], 'outline', '--accent-control', '--surface', 3, 5.65, 3.61],
  ['the scope focus ring on the selected row', 'sidebar', ['.scope-item:focus-visible'], 'outline', '--accent-control', SELECTED, 3, 4.72, 3.35],
  ['the run screen\'s context line', 'run', ['.rd-context'], 'color', '--text-2-strong', '--elevated', 4.5, 5.55, 5.86],
  ['the refused line and the unknown reason', 'run', ['.rd-refused', '.rd-unknown-why'], 'color', '--text-2-strong', '--card', 4.5, 4.70, 5.02],
  ['the empty sentence and the file label', 'run', ['.rd-empty', '.rd-files-label'], 'color', '--text-2-strong', '--elevated', 4.5, 5.55, 5.86],
  ['the row\'s skill link and quiet Resume', 'routines', ['.rr-skill-link', '.rr-resume-quiet'], 'color', '--link-text', '--card', 4.5, 5.06, 5.53],
  // The switch that turns routines off on this computer: its row sits on
  // --surface inside the list's --elevated panel, so its edge is measured
  // against the panel, and the row's own words against its fill.
  ['the switch row\'s title', 'routines', ['.routines-here-title'], 'color', '--text-1', '--surface', 4.5, 13.79, 16.42],
  ['the switch row\'s On and Off', 'routines', ['.routines-here-word'], 'color', '--text-1', '--surface', 4.5, 13.79, 16.42],
  ['the switch row\'s hint', 'routines', ['.routines-here-hint'], 'color', '--text-2-strong', '--surface', 4.5, 5.99, 5.53],
  ['the switch row\'s laptop', 'routines', ['.routines-here-icon'], 'color', '--text-2-strong', '--surface', 3, 5.99, 5.53],
  ['the switch row\'s edge while off', 'routines', ['.routines-here.off'], 'border-color', '--border-strong', '--elevated', 3, 3.78, 4.57],
  ['the switch\'s edge while off', 'ui', ['.rui-toggle'], 'border', '--text-3', '--surface', 3, 3.32, 3.40],
  ['the switch\'s fill while on', 'ui', ['.rui-toggle:checked'], 'background', '--accent-control', '--surface', 3, 5.65, 3.61],
  ['the switch\'s focus ring', 'routines', ['.routines-here .rui-toggle:focus-visible'], 'outline', '--accent-control', '--surface', 3, 5.65, 3.61],
  ['Off on this computer', 'routines', ['.next-run.paused-label'], 'color', '--text-2-strong', '--card', 4.5, 4.70, 5.02],
  ['the dot beside Off on this computer', 'routines', ['.rr-paused-dot'], 'background', '--text-2-strong', '--card', 3, 4.70, 5.02],
  ['the header line while off', 'routines', ['.routines-workspace'], 'color', '--text-2', '--elevated', 4.5, 5.03, 4.57],
  ['the selected scope row\'s name and count', 'sidebar', ['.scope-item.active .scope-name', '.scope-item.active .scope-count'], 'color', '--accent-text', SELECTED, 4.5, 4.72, 4.64],
];

const THEMES = themesOf(TOKENS_SRC);

// One row in one theme: every rule draws a color that clears the bar on the
// surface. Takes the themes as an argument so the instrument can be proven
// against a tokens.css with a token taken out.
function measureRow(themes, row, theme) {
  const [where, sheet, selectors, prop, , surf, bar, statedDark, statedLight] = row;
  const bg = surface(themes, theme, surf, `${where} (${theme})`);
  const got = [];
  for (const selector of selectors) {
    const fg = themes.value(paint(prop, declared(sheet, selector, prop)), theme, `${where}, ${selector} (${theme})`);
    assert.ok(Array.isArray(fg), `${where}, ${selector} (${theme}): paints a tint, which this cannot measure on its own`);
    const r = ratio(fg, bg);
    assert.ok(r >= bar, `${where}, ${selector} (${theme}): ${round2(r)}:1, below ${bar}:1`);
    got.push(r);
  }
  const stated = theme === 'dark' ? statedDark : statedLight;
  for (const r of got) {
    assert.strictEqual(round2(r), stated, `${where} (${theme}): a token or a surface moved`);
  }
  return got;
}

describe('each rule draws the token its row names', () => {
  for (const [where, sheet, selectors, prop, token] of ROWS) {
    for (const selector of selectors) {
      test(`${where}: ${selector} draws ${token}`, () => {
        assert.strictEqual(paint(prop, declared(sheet, selector, prop)), `var(${token})`);
      });
    }
  }
});

describe('the scope focus ring', () => {
  test('is drawn inside the row, so the panel cannot clip it', () => {
    assert.strictEqual(declared('sidebar', '.scope-item:focus-visible', 'outline-offset'), '-2px');
  });
});

for (const theme of ['dark', 'light']) {
  describe(`each row clears its bar, ${theme} theme`, () => {
    for (const row of ROWS) {
      test(`${row[0]}: at least ${row[6]}:1 on ${row[5]}`, () => {
        measureRow(THEMES, row, theme);
      });
    }
  });
}

describe('the two text tokens these rows added', () => {
  test('--working-text is the working hue in dark and a darker blue in light', () => {
    assert.deepStrictEqual(THEMES.dark('--working-text', 'working text'), [0x7A, 0xA2, 0xE8]);
    assert.deepStrictEqual(THEMES.light('--working-text', 'working text'), [0x3A, 0x63, 0xB0]);
  });

  test('--link-text is computed from each theme\'s own accent text and body text', () => {
    // The light value has to be mixed from light's --accent-text and --text-1.
    // Declared only on :root it would be mixed once from the dark pair and
    // inherited, which this refuses.
    for (const theme of ['dark', 'light']) {
      const accent = THEMES[theme]('--accent-text', `link text (${theme})`);
      const body = THEMES[theme]('--text-1', `link text (${theme})`);
      const got = THEMES[theme]('--link-text', `link text (${theme})`);
      const want = accent.map((c, i) => c * 0.85 + body[i] * 0.15);
      assert.ok(got.every((c, i) => Math.abs(c - want[i]) < 1e-9),
        `--link-text in ${theme} is [${got}], not the 85% mix of that theme's --accent-text and --text-1, [${want}]`);
    }
    assert.notDeepStrictEqual(THEMES.dark('--link-text', 'link text'), THEMES.light('--link-text', 'link text'));
  });
});


describe('a paused row keeps its text at full strength', () => {
  const css = rules(SHEETS.routines);

  test('nothing dims a paused row as a whole', () => {
    // At 72% the row's own secondary text measured 3.19:1 in dark and 2.87:1
    // in light, below 4.5:1 even with every token above in place.
    const dimming = [...css].filter(([sel, decls]) => /\.routine-row\.paused(?![\w-])/.test(sel)
      && !/\.avatar$/.test(sel) && decls.has('opacity'));
    assert.deepStrictEqual(dimming.map(([sel]) => sel), [], 'a paused row is dimmed as a whole');
  });

  test('the avatar alone dims, at half strength', () => {
    const avatar = css.get('.routine-row.paused .avatar');
    assert.ok(avatar, 'routines.css has no rule for a paused row\'s avatar');
    assert.strictEqual(avatar.get('opacity'), '0.5');
  });
});

describe('the measuring instrument', () => {
  const row = (where) => {
    const found = ROWS.find(r => r[0] === where);
    assert.ok(found, `no row named ${where}`);
    return found;
  };

  test('a token missing from tokens.css fails its row by name, not on a fallback', () => {
    const without = TOKENS_SRC.replace(/^\s*--working-text:[^;]*;\s*$/gm, '');
    assert.notStrictEqual(without, TOKENS_SRC, 'sanity: the specimen took --working-text out');
    const themes = themesOf(without);
    for (const theme of ['dark', 'light']) {
      assert.throws(() => measureRow(themes, row('the Still going chip'), theme),
        /--working-text is declared nowhere in tokens\.css/);
    }
  });

  test('a theme block without its own value fails that theme\'s row', () => {
    // Light inherits the dark blue, 2.20:1 on the light card.
    const lightLine = /^(\s*)--working-text:\s*#3A63B0;\s*$/m;
    assert.match(TOKENS_SRC, lightLine, 'sanity: the light block declares its own working text');
    const themes = themesOf(TOKENS_SRC.replace(lightLine, ''));
    assert.throws(() => measureRow(themes, row('the Still going chip'), 'light'), /below 4\.5:1/);
    measureRow(themes, row('the Still going chip'), 'dark');
  });

  test('a mix declared only on :root is read with the dark values in light', () => {
    const shared = /:root, body\.light \{/;
    assert.match(TOKENS_SRC, shared, 'sanity: the link text is declared for both themes in one rule');
    const themes = themesOf(TOKENS_SRC.replace(shared, ':root {'));
    assert.deepStrictEqual(themes.light('--link-text', 'specimen'), themes.dark('--link-text', 'specimen'),
      'the resolver merged the blocks instead of computing a :root token on :root');
  });

  test('it fails a pairing known to fail and passes one known to pass', () => {
    const card = THEMES.light('--card', 'specimen');
    assert.ok(ratio(THEMES.light('--working', 'specimen'), card) < 4.5, 'the working hue on the light card is 2.20:1');
    assert.ok(ratio(THEMES.light('--text-1', 'specimen'), card) >= 4.5);
  });
});
