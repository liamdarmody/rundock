'use strict';
// The colors the line under each reply reads ("6 steps · Worked 4 min 05 s",
// its Details button, the step times and the token sentence), measured in the
// dark theme and the light theme from the token values in tokens.css.
//
// The step list used to sit at --text-2 under an opacity, which fails 4.5:1
// in the light theme. The line now takes --text-2-strong at full strength,
// and the step names keep --text-1. Each ratio is resolved from the
// declarations, following var(), never typed beside a token, and each rule is
// read out of chat.css, so a rule that names another token fails here.
//
// The stylesheets are walked brace by brace rather than matched with a
// pattern, so a rule inside an @media block is told apart from one outside.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const source = (file) => fs.readFileSync(path.join(ROOT, file), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');

function declarations(body) {
  const out = new Map();
  for (const d of body.split(';')) {
    const i = d.indexOf(':');
    if (i > 0) out.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
  }
  return out;
}

// Every rule in a stylesheet, in order: its selectors, its declarations and
// the at-rule it sits in (null at the top level).
function parse(css, at = null, out = []) {
  let i = 0;
  for (;;) {
    const open = css.indexOf('{', i);
    if (open < 0) return out;
    let head = css.slice(i, open);
    head = head.slice(head.lastIndexOf(';') + 1).trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') depth -= 1;
      j += 1;
    }
    const body = css.slice(open + 1, j - 1);
    if (head.startsWith('@')) parse(body, head, out);
    else out.push({ at, selectors: head.split(',').map((s) => s.trim()).filter(Boolean), decls: declarations(body) });
    i = j;
  }
}

// The top-level rules by selector, later rules for a selector merged over
// earlier ones.
function topRules(file) {
  const map = new Map();
  for (const rule of parse(source(file))) {
    if (rule.at !== null) continue;
    for (const selector of rule.selectors) map.set(selector, new Map([...(map.get(selector) || []), ...rule.decls]));
  }
  return map;
}

const TOKENS = topRules('public/styles/tokens.css');
const DARK = TOKENS.get(':root');
const LIGHT = TOKENS.get('body.light');
const THEMES = {
  dark: DARK,
  light: new Map([...(DARK || []), ...(LIGHT || [])]),
};
const CHAT_RULES = parse(source('public/styles/views/chat.css'));
const CHAT = topRules('public/styles/views/chat.css');

function resolve(value, theme, where) {
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) {
    const n = parseInt(v.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  if (v.startsWith('var(') && v.endsWith(')') && !v.includes(',')) {
    const name = v.slice(4, -1).trim();
    assert.ok(THEMES[theme].has(name), `${where}: ${name} is declared nowhere for the ${theme} theme`);
    return resolve(THEMES[theme].get(name), theme, `${where} -> ${name}`);
  }
  assert.fail(`${where}: cannot resolve ${v}`);
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

// The value a chat.css rule declares, refusing when the rule or the property
// is missing so a renamed selector fails by name.
function declared(selector, property) {
  assert.ok(CHAT.has(selector), `chat.css has no rule for ${selector}`);
  assert.ok(CHAT.get(selector).has(property), `chat.css declares no ${property} on ${selector}`);
  return CHAT.get(selector).get(property);
}

// The four rules the line reads at full strength.
const LINE_RULES = ['.turn-used-line', '.turn-details', '.activity-time', '.turn-tokens-line'];
const SURFACES = ['--elevated', '--base'];
// Every class the line and its step list are drawn with.
const LINE_CLASSES = ['.activity-summary', '.activity-time', '.activity-tool', '.turn-used', '.turn-used-line', '.turn-details', '.turn-tokens', '.turn-tokens-line'];

describe('the tokens the line under a reply reads', () => {
  // Pins the parse, which reads main's stylesheets too; its sibling "the
  // line, Details, the step times and the token sentence take
  // --text-2-strong and no other token" fails on main.
  test('the parse found more than a handful of declarations', () => {
    // A floor under the extraction: a walk that stopped finding rules would
    // otherwise leave empty maps, and every lookup below would fail for a
    // reason the message does not name.
    assert.ok(DARK && DARK.size > 40, 'the token parse found almost nothing in :root, so nothing below is measured');
    assert.ok(LIGHT && LIGHT.size > 15, 'the token parse found almost nothing in body.light, so nothing below is measured');
    assert.ok(CHAT.size > 40, 'the chat.css parse found almost no rules, so nothing below is measured');
  });

  test('the line, Details, the step times and the token sentence take --text-2-strong and no other token', () => {
    for (const selector of LINE_RULES) {
      assert.strictEqual(declared(selector, 'color'), 'var(--text-2-strong)', `${selector} must take --text-2-strong`);
    }
  });

  // Pins what main already does; its sibling "the line, Details, the step
  // times and the token sentence take --text-2-strong and no other token"
  // fails on main.
  test('the step names keep --text-1', () => {
    assert.strictEqual(declared('.activity-tool', 'color'), 'var(--text-1)');
  });

  test('no rule naming the line or its steps fades it with opacity', () => {
    const named = CHAT_RULES.filter((rule) => rule.selectors.some((s) => LINE_CLASSES.some((c) => s.includes(c))));
    assert.ok(named.length >= LINE_CLASSES.length, 'sanity: the rules naming the line were found');
    for (const rule of named) {
      assert.ok(!rule.decls.has('opacity'), `${rule.selectors.join(', ')} declares opacity`);
    }
  });

  test('Details reads --text-1 when hovered or open, and shows a focus ring', () => {
    assert.strictEqual(declared('.turn-details:hover', 'color'), 'var(--text-1)');
    assert.strictEqual(declared('.turn-details[aria-expanded="true"]', 'color'), 'var(--text-1)');
    assert.strictEqual(declared('.turn-details:focus-visible', 'outline'), '2px solid var(--accent-control)');
  });

  test('the token sentence is hidden until Details opens it', () => {
    assert.strictEqual(declared('.turn-tokens[hidden]', 'display'), 'none');
  });
});

describe('each rule clears 4.5:1 on the surfaces a reply sits on, in both themes', () => {
  for (const selector of LINE_RULES) {
    test(`${selector} on ${SURFACES.join(' and ')}`, () => {
      for (const theme of ['dark', 'light']) {
        for (const surface of SURFACES) {
          const where = `${selector} on ${surface} (${theme})`;
          const measured = ratio(resolve(declared(selector, 'color'), theme, where), resolve(`var(${surface})`, theme, where));
          assert.ok(measured >= 4.5, `${where} measures ${measured.toFixed(2)}:1, under 4.5:1`);
        }
      }
    });
  }
});
