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
const { makeRenderer } = require('../helpers/markdown-harness.js');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const BENIGN_MD = fs.readFileSync(path.join(FIXTURES, 'markdown-benign.md'), 'utf8');
const BENIGN_HTML = fs.readFileSync(path.join(FIXTURES, 'markdown-benign.html'), 'utf8');

const { renderMarkdown } = makeRenderer();
const render = (src) => renderMarkdown(src, { callouts: true });

// The shape of a rendered document, ignoring attributes.
//
// This is the invariant that must hold across every commit on this card. The
// byte fixture below it is stricter and legitimately moves when a handler
// attribute becomes a listener; this does not move at all. If the escaping
// work ever swallows an element, changes a class, or alters a single visible
// character, this fails and the fixture update cannot hide it.
function outline(html) {
  const dom = new JSDOM(`<div id="root">${html}</div>`);
  const root = dom.window.document.getElementById('root');
  const walk = (el) => Array.from(el.children).map((child) => ({
    tag: child.tagName.toLowerCase(),
    cls: child.getAttribute('class') || '',
    children: walk(child),
  }));
  return { tree: walk(root), text: root.textContent };
}

describe('renderMarkdown: ordinary markdown is untouched by this card', () => {
  test('AC-15: the benign document renders to the recorded pre-change bytes', () => {
    // markdown-benign.html was produced by the renderer as it stood on main
    // before this card, by running the same fixture through the code in
    // public/app.js. Equality here is the claim that nothing about ordinary
    // rendering changed.
    assert.strictEqual(render(BENIGN_MD), BENIGN_HTML);
  });

  test('AC-15: the benign document keeps its structure and its every visible character', () => {
    assert.deepStrictEqual(outline(render(BENIGN_MD)), outline(BENIGN_HTML));
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
