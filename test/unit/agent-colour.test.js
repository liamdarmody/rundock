'use strict';
// The colour rule, and the property that makes it a rule rather than a filter.
//
// An agent's colour is written into a `style` attribute, so there are two ways
// for it to stop being a colour and only one of them is an escaping problem.
// It can END the attribute and open an event handler after it, which escaping
// answers. Or it can stay inside the attribute and still be CSS, which
// escaping does not touch at all: `red;background-image:url(https://x)` breaks
// no quote, needs no handler, and makes a request on render.
//
// So the rule is an allowlist, and what is asserted below is not a list of
// payloads it happens to catch. It is the PROPERTY: a value that passes can
// carry no second declaration, can open no url(), and contains no character an
// attribute escaper would have to touch. A payload list goes stale the moment
// somebody thinks of a payload nobody wrote down; the property does not.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { safeColour, COLOUR } = require('../../public/agent-colour.js');
const chatMarkup = require('../../public/chat-markup.js');

// Every colour Rundock itself produces, from lib/agents/discovery.js's palette
// and the two design tokens the call sites fall back to. Read them here rather
// than trusting a memory of them: a palette entry the rule refuses would turn
// every agent in a fresh workspace grey.
const RUNDOCK_WRITES = [
  '#E87A5A', '#6B9EF0', '#6BC67E', '#E8A84C',
  '#A07AE8', '#E87AAC', '#5BCFC4', '#E8A07A',
  'var(--accent)', 'var(--idle)', 'var(--card)',
];

// Shapes an agent file may reasonably carry that Rundock never writes.
const ALSO_VALID = [
  '#fff', '#FFFF', '#ff0000ff', 'red', 'rebeccapurple', 'transparent',
  'rgb(255, 0, 0)', 'rgba(255,0,0,0.5)', 'hsl(210 50% 40%)', 'hsla(210,50%,40%,.5)',
  'var( --accent )',
];

// What a frontmatter block can carry that must not reach the attribute. The
// first four end the attribute; the rest do not, which is the half an escaper
// would let through.
const HOSTILE = [
  'red" onmouseover="alert(1)',
  'red"><img src=x onerror=alert(1)>',
  "red' onload='alert(1)",
  '#fff" onfocus="alert(1)" autofocus x="',
  'red;background-image:url(https://example.invalid/beacon)',
  'red;behavior:url(#x)',
  'url(https://example.invalid/beacon)',
  'expression(alert(1))',
  '#fff;position:fixed;inset:0;z-index:99999',
  'var(--accent);background:url(https://example.invalid/b)',
  '/**/red',
  '\\72 ed',
];

describe('what an agent colour is allowed to be', () => {
  test('every colour Rundock itself writes survives unchanged', () => {
    for (const value of RUNDOCK_WRITES) {
      assert.strictEqual(safeColour(value), value,
        `${value} is a colour this app produces; refusing it would grey out a real agent`);
    }
  });

  test('the shapes an agent file may reasonably carry survive unchanged', () => {
    for (const value of ALSO_VALID) {
      assert.strictEqual(safeColour(value), value, value);
    }
  });

  test('nothing hostile reaches the attribute, whether or not it breaks a quote', () => {
    for (const value of HOSTILE) {
      assert.strictEqual(safeColour(value), 'var(--accent)',
        `${value} was written into the style attribute`);
    }
  });

  test('a missing colour is the fallback, which is what it was before this rule', () => {
    // The call sites all used `a?.colour || 'var(--accent)'`, which fired for a
    // null agent AND for an agent whose colour is the empty string. Both still
    // do, so nothing about a colourless agent changed.
    for (const value of [undefined, null, '', '   ', 0, false, {}, []]) {
      assert.strictEqual(safeColour(value), 'var(--accent)', JSON.stringify(value));
    }
  });

  test('the caller chooses the fallback, because two surfaces already used different ones', () => {
    // The chat thread falls back to the accent; the routines list and the run
    // detail fall back to the idle token. Hard-coding one would have changed
    // the appearance of the other.
    assert.strictEqual(safeColour('nonsense colour', 'var(--idle)'), 'var(--idle)');
    assert.strictEqual(safeColour(null, 'var(--idle)'), 'var(--idle)');
    assert.strictEqual(safeColour('#f00', 'var(--idle)'), '#f00', 'a valid colour ignores the fallback');
  });

  // ── the property, rather than the payload list ──────────────────────────

  test('a value that passes carries nothing an attribute escaper would touch', () => {
    for (const value of [...RUNDOCK_WRITES, ...ALSO_VALID]) {
      const out = safeColour(value);
      for (const ch of ['&', '"', "'", '<', '>']) {
        assert.ok(!out.includes(ch),
          `${value} passed the rule and contains ${ch}, so escaping it would change it, `
          + 'which means the rule and the escaper disagree about what a colour is');
      }
    }
  });

  test('a value that passes can carry no second declaration and no url()', () => {
    for (const value of [...RUNDOCK_WRITES, ...ALSO_VALID]) {
      const out = safeColour(value);
      assert.ok(!out.includes(';'), `${value} passed and contains a semicolon`);
      assert.ok(!/\burl\s*\(/i.test(out), `${value} passed and opens a url()`);
      assert.ok(!out.includes('/*') && !out.includes('\\'),
        `${value} passed and carries a comment or an escape sequence`);
    }
  });

  test('the property holds for anything the rule admits, not only the corpus', () => {
    // The two tests above are only as good as the values written above them.
    // This one asks the pattern directly: build strings out of the characters
    // the pattern's own character classes contain, keep the ones it admits,
    // and hold every one of them to the same property. A widening that let a
    // semicolon or a quote through would fail here even if nobody thought to
    // add a payload for it.
    const alphabet = '#0369afABF-_ .,%/()rgbhslvar;\'"<>&\\*';
    let admitted = 0;
    for (let i = 0; i < 20000; i++) {
      let s = '';
      const len = 1 + (i % 12);
      for (let j = 0; j < len; j++) s += alphabet[(i * 31 + j * 17 + j * j) % alphabet.length];
      if (!COLOUR.test(s)) continue;
      admitted++;
      for (const ch of ['&', '"', "'", '<', '>', ';', '\\', '*']) {
        assert.ok(!s.includes(ch), `the pattern admits ${JSON.stringify(s)}, which contains ${ch}`);
      }
      assert.ok(!/\burl\s*\(/i.test(s), `the pattern admits ${JSON.stringify(s)}, which opens a url()`);
    }
    assert.ok(admitted > 20,
      `only ${admitted} generated strings were admitted, so this test proved almost nothing; `
      + 'widen the alphabet or the length rather than trusting the pass');
  });

  // ── the two copies ──────────────────────────────────────────────────────

  test('chat-markup.js and this module agree on every input above', () => {
    // public/chat-markup.js keeps its own copy of this rule, for the reason
    // recorded in its header and in markdown-render.js before it: it has to
    // stay requireable under node without the rest of the client. A second
    // copy is only acceptable while something checks the two say the same
    // thing, and this is that something.
    const corpus = [...RUNDOCK_WRITES, ...ALSO_VALID, ...HOSTILE,
      undefined, null, '', '   ', 0, false];
    for (const value of corpus) {
      assert.strictEqual(chatMarkup.safeColour(value), safeColour(value),
        `the two copies disagree about ${JSON.stringify(value)}`);
    }
  });
});
