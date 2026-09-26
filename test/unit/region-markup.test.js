'use strict';
// What a region extension returns is rebuilt, not cleaned, and
// this suite is written as attacks rather than as happy paths: the happy path
// is one test, because a renderer that draws a rectangle proves very little
// and a renderer that refuses to build a script proves the thing the frame's
// opaque origin was traded away for.
//
// Every case below asserts an ABSENCE in the built tree. An absence is what a
// positive-only suite misses, and this file exists because the whole safety
// argument for injecting third-party markup into Rundock's page is that
// nothing unrecognised is ever built.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

const markup = require('../../public/region-markup.js');

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const doc = dom.window.document;

function build(svg) {
  return markup.buildRegionTree(svg, doc);
}
// The built tree as a string, for asserting what is not in it. Serialised
// from the BUILT node, never from the input, so this reads what the host
// would actually put on the page.
function built(svg) {
  const out = build(svg);
  return out.node ? out.node.outerHTML : '';
}
const wrap = (inner, attrs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${attrs ? ' ' + attrs : ''}>${inner}</svg>`;

describe('a diagram is rebuilt out of the parts that are understood', () => {
  test('the shapes and text a diagram is made of survive, with their geometry', () => {
    const out = built(wrap('<g transform="translate(1,2)"><rect x="1" y="1" width="8" height="8" fill="#eee"/>'
      + '<path d="M0 0L10 10" stroke="red" stroke-width="2"/><text x="3" y="4">Hub</text></g>'));
    for (const expected of ['<g', 'transform="translate(1,2)"', '<rect', 'width="8"', 'fill="#eee"',
      '<path', 'd="M0 0L10 10"', '<text', 'Hub']) {
      assert.ok(out.includes(expected), `${expected} is part of a diagram and is built: ${out}`);
    }
  });

  test('text content is carried as text, so a diagram\'s labels are the page\'s own words', () => {
    // Not merely that it survives: that it is a text node, which is what
    // makes it selectable and findable by the page's search. That property
    // is half the reason the calculator shape was chosen over a window.
    const out = build(wrap('<text>Quarterly &amp; annual</text>'));
    const text = out.node.querySelector('text');
    assert.strictEqual(text.textContent, 'Quarterly & annual');
    assert.strictEqual(text.firstChild.nodeType, 3, 'a real text node, not markup that looks like one');
  });
});

describe('nothing unrecognised is built, which is the whole of the safety argument', () => {
  test('a script is not built, and neither is what it contained', () => {
    const out = built(wrap('<script>window.stolen = 1;</script><rect x="1" y="1" width="2" height="2"/>'));
    assert.ok(!/script/i.test(out), `no script element survives: ${out}`);
    assert.ok(!out.includes('stolen'), 'nor its contents, which a text-node copy would have carried through');
    assert.ok(out.includes('<rect'), 'and the rest of the diagram is unharmed: one bad node is not a failed render');
  });

  test('an event handler attribute is not built, on any element', () => {
    for (const attr of ['onload', 'onclick', 'onmouseover', 'onfocus', 'onerror']) {
      const out = built(wrap(`<rect x="1" y="1" width="2" height="2" ${attr}="window.x=1"/>`));
      assert.ok(!out.toLowerCase().includes(attr), `${attr} is not an attribute this builds: ${out}`);
      assert.ok(out.includes('<rect'), 'the element itself still draws');
    }
  });

  test('foreignObject is not built, which is the documented way to smuggle HTML into a drawing', () => {
    const out = built(wrap('<foreignObject width="10" height="10">'
      + '<div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="window.x=1"/></div></foreignObject>'));
    assert.ok(!/foreignobject/i.test(out), 'the element is not built');
    assert.ok(!/<div|<img|onerror/i.test(out), 'and nothing inside it is built either');
  });

  test('an external reference is not built, in the forms that fetch', () => {
    const cases = [
      ['<image href="https://example.com/x.png" width="4" height="4"/>', /image|example\.com/i],
      ['<use href="#a"/>', /<use/i],
      ['<rect x="1" y="1" width="2" height="2" fill="url(https://example.com/x)"/>', /example\.com/i],
      ['<rect x="1" y="1" width="2" height="2" fill="url(data:image/svg+xml;base64,AAA)"/>', /data:/i],
    ];
    for (const [inner, forbidden] of cases) {
      assert.ok(!forbidden.test(built(wrap(inner))), `${inner} does not reach the page`);
    }
  });

  test('a local url() reference IS built, because that is how markers and gradients work', () => {
    const out = built(wrap('<defs><marker id="arrow"><path d="M0 0L4 2"/></marker></defs>'
      + '<line x1="0" y1="0" x2="8" y2="8" marker-end="url(#arrow)"/>'));
    assert.ok(out.includes('url(#arrow)'),
      'refusing this would make the allowlist useless for real diagrams, which is its own failure');
  });

  test('a namespaced attribute is not built, so xlink is not a way back in', () => {
    const out = built('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
      + 'viewBox="0 0 10 10"><text xlink:href="https://example.com">x</text></svg>');
    assert.ok(!/xlink|example\.com/i.test(out), `no prefixed attribute survives: ${out}`);
  });

  test('a destination attribute is not built even on an element that IS allowed', () => {
    // The element tests above refuse <image> and <use> outright, so they say
    // nothing about href arriving on something permitted. Its own harness row
    // found this gap: widening the attribute list turned nothing red.
    for (const attr of ['href', 'src']) {
      const out = built(wrap(`<text ${attr}="https://example.com">x</text>`));
      assert.ok(!out.includes('example.com'), `${attr} on a permitted element does not reach the page: ${out}`);
      assert.ok(out.includes('<text'), 'and the element still draws');
    }
  });

  test('the allowlist is matched on the qualified name, which is what makes a prefix unreachable', () => {
    // Not a restatement of the xlink test above: that one would still pass if
    // this matched on localName, because href is absent from the list either
    // way. This pins the property itself, by using a prefixed attribute whose
    // BARE name is allowed. Matching localName would let it through.
    // xlink:id, not xlink:title: `id` is on the list and `title` is not, so
    // only this one distinguishes matching the qualified name from matching
    // the bare one. The first attempt used title and proved nothing, which
    // the harness said so.
    const out = built('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
      + 'viewBox="0 0 10 10"><text xlink:id="smuggled" fill="red">x</text></svg>');
    assert.ok(!out.includes('smuggled'),
      `a prefixed attribute is not built even when its bare name is on the list: ${out}`);
    assert.ok(out.includes('fill="red"'), 'while the unprefixed one beside it is');
  });

  test('comments are not carried, so a marker the app uses cannot be smuggled back through a diagram', () => {
    const out = built(wrap('<!-- RUNDOCK:RETURN --><rect x="1" y="1" width="2" height="2"/>'));
    assert.ok(!out.includes('RUNDOCK'), 'the app\'s own protocol cannot be written by an extension');
  });
});

describe('what cannot be drawn is said, not swallowed', () => {
  test('nothing, unreadable markup, and markup that is not a drawing each answer with a reason', () => {
    for (const [input, pattern] of [
      ['', /nothing to draw/],
      ['   ', /nothing to draw/],
      [null, /nothing to draw/],
      ['<svg><unclosed></svg>', /could not be read/],
      ['<html><body>hello</body></html>', /not a drawing/],
    ]) {
      const out = build(input);
      assert.strictEqual(out.node, null, `${JSON.stringify(input)} builds nothing`);
      assert.match(out.reason, pattern, `and says why: ${out.reason}`);
    }
  });
});
