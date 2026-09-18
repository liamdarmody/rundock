'use strict';
// The editor's wikilink click delegate, and the two spellings it has to serve.
//
// THE DEFECT THIS EXISTS FOR, found by clicking a link in a real briefing after
// the callout rendering had shipped. The delegate matches `a.wikilink`, which is
// what BOTH producers emit, then stops propagation, then read only
// `data-target`. The editor's own wikilink node writes that attribute; the
// markdown renderer, which a callout's body is rendered through, writes
// `data-wikilink`. So a wikilink inside a callout was matched, its propagation
// stopped, its attribute missed, and the click dropped in silence: the link
// looked right and went nowhere, while the identical link outside a callout
// worked.
//
// It is the seam failure the criteria keep warning about: two layers, each
// internally correct, disagreeing about one name. The fix is one delegate that
// reads both, never a second delegate.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';
import { wireWikilinkClicks } from '../../public/editor/index.js';

function host(html) {
  const dom = new JSDOM(`<div id="host">${html}</div>`);
  const el = dom.window.document.getElementById('host');
  const seen = [];
  const unbind = wireWikilinkClicks(el, (target, alias) => seen.push({ target, alias }));
  return { dom, el, seen, unbind };
}

describe('the wikilink delegate serves both spellings', () => {
  test('an anchor written by the editor\'s own node is dispatched', () => {
    const { el, seen } = host('<a class="wikilink" data-target="Roadmap-2026" data-alias="plan">plan</a>');
    el.querySelector('a').click();
    assert.deepStrictEqual(seen, [{ target: 'Roadmap-2026', alias: 'plan' }]);
  });

  test('an anchor written by the MARKDOWN renderer is dispatched too', () => {
    // The half that was missing. A callout body goes through this renderer, so
    // this is the shape a link in a briefing actually has.
    const { el, seen } = host('<a class="wikilink" data-wikilink="digest-2026-09-04">digest</a>');
    el.querySelector('a').click();
    assert.strictEqual(seen.length, 1, 'the click must reach the callback, not be dropped');
    assert.strictEqual(seen[0].target, 'digest-2026-09-04');
  });

  test('a wikilink with NEITHER attribute is not dispatched, and says nothing', () => {
    // The guard that turned a missed attribute into silence. Kept, because an
    // anchor with no target has nowhere to go; what changed is that the shape
    // the renderer produces is no longer in this category.
    const { el, seen } = host('<a class="wikilink">nothing</a>');
    el.querySelector('a').click();
    assert.deepStrictEqual(seen, []);
  });

  test('an ordinary link and an email address are left alone entirely', () => {
    // The delegate claims only wikilinks. Anything else must keep its default
    // behaviour, or a callout would swallow every hyperlink in it.
    const { el, seen } = host('<a href="https://example.com">web</a><a href="mailto:a@b.c">mail</a>');
    for (const a of el.querySelectorAll('a')) a.click();
    assert.deepStrictEqual(seen, [], 'neither is claimed by the wikilink delegate');
  });

  test('unbinding stops the delegate, so a torn-down editor claims nothing', () => {
    const { el, seen, unbind } = host('<a class="wikilink" data-wikilink="x">x</a>');
    unbind();
    el.querySelector('a').click();
    assert.deepStrictEqual(seen, []);
  });
});
