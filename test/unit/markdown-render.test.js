'use strict';
// The renderer's behaviour contract: ordinary markdown renders as it always
// did, and hostile markdown cannot become script.
//
// Everything here drives renderMarkdown itself, not a unit of the parser. The
// defects this suite exists for all live in the pre- and post-processing
// wrapped around marked, so a test that called marked directly would exercise
// none of them.
//
// AC-9, AC-11 and AC-15 are the half that matters most day to day: the likeliest
// way to fail this card is to break ordinary markdown while closing the hole.
// formatMd has nine call sites across chat and message handling, so a
// regression here is visible in every conversation in the app.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { makeRenderer, attachWikilinkHandler } = require('../helpers/markdown-harness.js');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const BENIGN_MD = fs.readFileSync(path.join(FIXTURES, 'markdown-benign.md'), 'utf8');
// What this renderer produces now. Regenerated only by a commit that means to
// change rendering, and never without the invariant below still holding.
const BENIGN_HTML = fs.readFileSync(path.join(FIXTURES, 'markdown-benign.html'), 'utf8');
// What the renderer produced on main BEFORE this card, generated from the code
// in public/app.js as it stood. Frozen: nothing on this branch may regenerate
// it, because it is the only record of what "unchanged" means.
const BENIGN_BEFORE = fs.readFileSync(path.join(FIXTURES, 'markdown-benign-before.html'), 'utf8');

const { renderMarkdown } = makeRenderer();
const render = (src) => renderMarkdown(src, { callouts: true });

// The shape of a rendered document: every element, its class, and its own
// text, exactly.
//
// This is the invariant that must hold across every commit on this card. The
// byte fixture is stricter and legitimately moves, because this card turns two
// inline handlers into listeners and drops the blank line the old callout box
// left behind it. This does not move. If the escaping work ever swallows an
// element, changes a class, or alters a single character INSIDE one, it fails,
// and regenerating the byte fixture cannot hide it.
//
// Text is compared per element rather than as one string for the whole
// document, so whitespace BETWEEN block elements is out of scope while
// whitespace inside them, which is the whole content of a <pre>, is compared
// exactly. The container's own text nodes are the only thing skipped, and at
// the top level of marked's output those are the inter-block newlines.
function outline(html) {
  const dom = new JSDOM(`<div id="root">${html}</div>`);
  const ownText = (el) => Array.from(el.childNodes)
    .filter((node) => node.nodeType === 3)
    .map((node) => node.data)
    .join('');
  const walk = (el) => Array.from(el.children).map((child) => ({
    tag: child.tagName.toLowerCase(),
    cls: child.getAttribute('class') || '',
    text: ownText(child),
    children: walk(child),
  }));
  return walk(dom.window.document.getElementById('root'));
}

describe('renderMarkdown: ordinary markdown is untouched by this card', () => {
  test('AC-15: the benign document renders to the recorded bytes', () => {
    assert.strictEqual(render(BENIGN_MD), BENIGN_HTML);
  });

  test('AC-15: the benign document keeps the structure and text it had before this card', () => {
    assert.deepStrictEqual(outline(render(BENIGN_MD)), outline(BENIGN_BEFORE));
  });

  test('AC-9: code blocks, tables, task lists and callouts still render', () => {
    const doc = new JSDOM(`<div id="root">${render(BENIGN_MD)}</div>`).window.document;
    assert.strictEqual(doc.querySelectorAll('.code-block-wrapper pre code.hljs').length, 2, 'both fenced blocks');
    assert.ok(doc.querySelector('.md-table-wrap > table > thead'), 'table wrapped and intact');
    assert.strictEqual(doc.querySelectorAll('input[type="checkbox"]').length, 2, 'both task list items');
    assert.strictEqual(doc.querySelectorAll('input[checked]').length, 1, 'the ticked one stays ticked');
    const callout = doc.querySelector('.callout.callout-note');
    assert.ok(callout, 'callout box');
    assert.strictEqual(callout.querySelector('.callout-title').textContent, 'Plain title');
    assert.ok(callout.querySelector('.callout-content strong'), 'callout body is still parsed as markdown');
  });

  test('AC-11: highlighting still applies to fenced code', () => {
    const doc = new JSDOM(`<div id="root">${render(BENIGN_MD)}</div>`).window.document;
    const js = doc.querySelector('.code-block-wrapper');
    assert.strictEqual(js.querySelector('.code-lang').textContent, 'JavaScript');
    assert.ok(js.querySelector('code.hljs .hljs-keyword'), 'hljs token spans are present');
  });
});

// ---------------------------------------------------------------------------
// Injection point 3: wikilink source rewriting.
//
// Before this card, renderMarkdown replaced [[target|label]] in the SOURCE with
//   <a class="wikilink" onclick="openWikilink('$1')">$2</a>
// and took both captures verbatim. `$1` lands inside a single-quoted JavaScript
// string inside a double-quoted HTML attribute, so a quote in the target ends
// the string and everything after it is code the page runs on click; a quote
// plus a space opens a NEW attribute, and onmouseover does not even need the
// click. Recorded payloads, run against the pre-card renderer:
//   [[note' onmouseover='alert(1)]]
//     -> onclick="openWikilink('note' onmouseover='alert(1)')"
//   [[a') + alert(1) + ('b]]
//     -> onclick="openWikilink('a') + alert(1) + ('b')"
// ---------------------------------------------------------------------------
describe('renderMarkdown: wikilink targets cannot reach the handler as code', () => {
  const attrs = (html) => {
    const doc = new JSDOM(`<div id="root">${html}</div>`).window.document;
    return Array.from(doc.querySelectorAll('*')).flatMap((el) => Array.from(el.attributes).map((a) => a.name));
  };

  test('AC-4: a quote in the target cannot open a second attribute', () => {
    const html = render("[[note' onmouseover='alert(1)]]");
    assert.ok(!attrs(html).some((name) => name.startsWith('on')), `handler attribute survived: ${html}`);
  });

  test('AC-4: a target that closes the call cannot append an expression', () => {
    const html = render("[[a') + alert(1) + ('b]]");
    assert.ok(!/alert\(1\)/.test(html.replace(/&#\d+;/g, '')) || !attrs(html).some((n) => n.startsWith('on')),
      `payload reached an executable position: ${html}`);
    assert.ok(!attrs(html).some((name) => name.startsWith('on')), `handler attribute survived: ${html}`);
  });

  test('AC-2: no wikilink render carries an event-handler attribute', () => {
    for (const src of ['[[Plain]]', '[[Target|Label]]', "[[a'b]]", '[[a"b]]', '[[a\\b]]']) {
      assert.ok(!attrs(render(src)).some((name) => name.startsWith('on')), `handler attribute in: ${src}`);
    }
  });

  test('AC-10: a click still reaches openWikilink with the same target value', () => {
    // The target values the old onclick would have passed, for targets that did
    // not break it. The listener must deliver these characters unchanged.
    const targets = ['Plain note', 'folder/Note', "Bobby's note", 'a"b', 'a\\b', "note' onmouseover='alert(1)"];
    for (const target of targets) {
      const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
      const doc = dom.window.document;
      doc.getElementById('root').innerHTML = render(`[[${target}]]`);
      const seen = [];
      attachWikilinkHandler(doc, (value) => seen.push(value));
      const anchor = doc.querySelector('a.wikilink');
      assert.ok(anchor, `no anchor for target: ${target}`);
      anchor.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      assert.deepStrictEqual(seen, [target]);
    }
  });

  test('AC-10: the visible label is still the alias, or the target when there is none', () => {
    const doc = (html) => new JSDOM(`<div id="root">${html}</div>`).window.document;
    assert.strictEqual(doc(render('[[Target|Label]]')).querySelector('a.wikilink').textContent, 'Label');
    assert.strictEqual(doc(render('[[Target]]')).querySelector('a.wikilink').textContent, 'Target');
    assert.ok(doc(render('[[Target|**bold**]]')).querySelector('a.wikilink strong'), 'alias is still parsed as markdown');
  });

  test('a wikilink inside code is left alone, which the source rewrite could not do', () => {
    // Recorded change of behaviour, not a regression. The old pass ran a
    // regex over the whole source, so `[[a]]` inside a code span became the
    // literal text of an anchor tag. A tokenizer never enters a code span.
    const html = render('`[[a]]`');
    assert.ok(/<code>\[\[a\]\]<\/code>/.test(html), html);
  });
});

// ---------------------------------------------------------------------------
// Injection point 2: callout titles.
//
// processCalloutsSrc built its box by string concatenation BEFORE any parser
// ran: `<div class="callout-title">${title}</div>`, where title is the raw
// remainder of the `> [!type]` line. marked was never involved, so nothing
// about the parser's own escaping applied. Recorded payload, run against the
// pre-card renderer:
//   > [!note] <img src=x onerror=alert(1)>
//     -> <div class="callout-title"><img src=x onerror=alert(1)></div>
// which is an image element in the DOM with an onerror handler, and needs no
// interaction at all: a broken src fires it on render.
// ---------------------------------------------------------------------------
describe('renderMarkdown: a callout title is text, not markup', () => {
  const doc = (html) => new JSDOM(`<div id="root">${html}</div>`).window.document;

  test('AC-3: a title containing a tag renders as text', () => {
    const d = doc(render('> [!note] <img src=x onerror=alert(1)>\n> body\n'));
    assert.strictEqual(d.querySelectorAll('img').length, 0, 'no element was created from the title');
    assert.strictEqual(d.querySelector('.callout-title').textContent, '<img src=x onerror=alert(1)>');
  });

  test('AC-3: a title cannot close the box it is written into', () => {
    const d = doc(render('> [!note] </div><a href="#" onclick="alert(1)">x</a><div>\n> body\n'));
    assert.strictEqual(d.querySelectorAll('a').length, 0);
    assert.strictEqual(d.querySelectorAll('.callout-title').length, 1);
    assert.ok(d.querySelector('.callout-content'), 'the box still has its content div');
  });

  test('AC-2: no callout render carries an event-handler attribute', () => {
    for (const src of [
      '> [!note] <img src=x onerror=alert(1)>\n> body\n',
      '> [!tip] " onmouseover="alert(1)\n> body\n',
    ]) {
      const d = doc(render(src));
      const names = Array.from(d.querySelectorAll('*')).flatMap((el) => Array.from(el.attributes).map((a) => a.name));
      assert.ok(!names.some((n) => n.startsWith('on')), `handler attribute in: ${src}`);
    }
  });

  test('the callout type still becomes the modifier class', () => {
    const d = doc(render('> [!Warning] Careful\n> body\n'));
    assert.ok(d.querySelector('.callout.callout-warning'), 'type is lowercased into the class');
  });
});
