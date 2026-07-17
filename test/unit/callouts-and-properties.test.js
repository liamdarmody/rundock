// Story: callouts render as Obsidian does (fold markers, nesting) and
// frontmatter wikilinks are clickable. Rendering assertions run the REAL
// editor under jsdom; round-trip safety for the same constructs is pinned
// by the OFM parity corpus.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { bootEditorEnv } from '../helpers/editor-harness.js';
import { parseCalloutBody } from '../../public/editor/nodes/callout.js';
import { renderProperties, parsePropWikilink } from '../../public/editor/panels/properties.js';

async function renderedHtml(src) {
  const env = await bootEditorEnv();
  const element = env.window.document.createElement('div');
  const { editor } = env.createEditor({ element, rawMarkdown: src });
  const html = element.innerHTML;
  env.destroyEditor(editor);
  return html;
}

describe('callout rendering', () => {
  test('foldable callouts render as details/summary with the right default state', async () => {
    const html = await renderedHtml('> [!abstract]+ Open one\n> Body A.\n\n> [!warning]- Closed one\n> Body B.');
    const dom = new JSDOM(html);
    const details = dom.window.document.querySelectorAll('details.callout-fold');
    assert.equal(details.length, 2);
    assert.equal(details[0].hasAttribute('open'), true, '+ defaults open');
    assert.equal(details[1].hasAttribute('open'), false, '- defaults closed');
    assert.match(details[0].querySelector('summary .callout-title').textContent, /Open one/);
    assert.ok(!html.includes('[!abstract]'), 'no literal [!type] in the render');
    assert.ok(!dom.window.document.querySelector('.callout-title')?.textContent.includes('+'), 'no stray fold char');
  });

  test('a nested callout renders as a real box, never literal > [!type] text', async () => {
    const html = await renderedHtml('> [!note] Outer\n> Outer body.\n> > [!warning]- Nested\n> > Nested body.');
    const dom = new JSDOM(html);
    const nested = dom.window.document.querySelector('.callout .callout-nested');
    assert.ok(nested, 'nested box rendered');
    assert.match(nested.textContent, /Nested body\./);
    assert.ok(!dom.window.document.querySelector('.callout-body').textContent.includes('[!warning]'), 'no literal nested head');
    assert.ok(nested.querySelector('details.callout-fold'), 'nested fold works too');
  });

  test('plain callouts stay non-collapsible divs', async () => {
    const html = await renderedHtml('> [!tip] Title only, no body');
    const dom = new JSDOM(html);
    assert.equal(dom.window.document.querySelector('details'), null);
    assert.match(dom.window.document.querySelector('.callout-title').textContent, /Title only/);
  });
});

describe('parseCalloutBody', () => {
  test('splits plain lines and nested callout runs', () => {
    const segs = parseCalloutBody('line one\n> [!tip]+ Nest\n> nested line\nline two');
    assert.deepEqual(segs.map((s) => s.kind), ['line', 'callout', 'line']);
    assert.equal(segs[1].type, 'tip');
    assert.equal(segs[1].fold, '+');
    assert.equal(segs[1].body, 'nested line');
  });
});

describe('frontmatter wikilink properties', () => {
  test('parsePropWikilink recognises whole-value wikilinks only', () => {
    assert.deepEqual(parsePropWikilink('[[Some Note]]'), { target: 'Some Note', alias: null });
    assert.deepEqual(parsePropWikilink('  [[A|B]]  '), { target: 'A', alias: 'B' });
    assert.equal(parsePropWikilink('see [[Some Note]] maybe'), null);
    assert.equal(parsePropWikilink('plain text'), null);
    assert.equal(parsePropWikilink(42), null);
    assert.equal(parsePropWikilink('[[]]'), null);
  });

  test('renderProperties makes wikilink values clickable and marks dead links', () => {
    const dom = new JSDOM('<div id="p"></div>', { url: 'http://localhost/' });
    global.HTMLElement = dom.window.HTMLElement; // renderValue never needs it, but keep env sane
    const container = dom.window.document.getElementById('p');
    const clicks = [];
    renderProperties(container, {
      related: ['[[Live Note]]', '[[Ghost Note]]', 'plain'],
      project: '[[Live Note|The Project]]',
    }, {
      onWikilinkClick: (t) => clicks.push(t),
      resolveWikilink: (t) => t === 'Live Note',
    });
    const links = [...container.querySelectorAll('a.prop-wikilink')];
    assert.equal(links.length, 3);
    const dead = links.find((l) => l.classList.contains('dead'));
    assert.equal(dead.textContent, 'Ghost Note');
    const alias = links.find((l) => l.textContent === 'The Project');
    assert.ok(alias, 'alias renders as display text');

    links[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    dead.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(clicks, ['Live Note'], 'live link routes; dead link is inert');
  });

  test('a malicious wikilink target cannot break out of the attribute (stored XSS regression)', () => {
    const dom = new JSDOM('<div id="p"></div>', { url: 'http://localhost/' });
    global.HTMLElement = dom.window.HTMLElement;
    const container = dom.window.document.getElementById('p');
    // A frontmatter value that tries to inject an event handler.
    renderProperties(container, {
      ref: '[[x" onmouseover="pwn()]]',
    }, { onWikilinkClick: () => {}, resolveWikilink: () => true });
    const link = container.querySelector('a.prop-wikilink');
    // The quote is escaped, so no onmouseover attribute materialises.
    assert.equal(link.getAttribute('onmouseover'), null, 'no injected handler');
    assert.ok(container.innerHTML.includes('&quot;'), 'the quote is entity-escaped');
    // The whole hostile string lives inside data-target as inert text.
    assert.ok(link.getAttribute('data-target').includes('onmouseover'));
  });
});
