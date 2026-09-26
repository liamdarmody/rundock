'use strict';
// A fenced block becomes a drawn region in place, the
// document keeps its own bytes, and one region's failure is one region's
// failure.
//
// Every case here starts from the REAL markdown renderer's output rather than
// hand-written HTML. The whole design rests on region mount being a pass over
// what the renderer already produces, so a test that invents its own markup
// would be testing an agreement with itself. If the renderer's shape changes
// under this, these should fail.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

const mount = require('../../public/region-mount.js');
const markup = require('../../public/region-markup.js');
const { makeRenderer } = require('../helpers/markdown-harness.js');

const { renderMarkdown } = makeRenderer();

function rendered(md) {
  const dom = new JSDOM('<!doctype html><html><body><div id="doc"></div></body></html>');
  const doc = dom.window.document;
  doc.getElementById('doc').innerHTML = renderMarkdown(md);
  return { dom, doc, scope: doc.getElementById('doc') };
}
const claimsMermaid = (lang) => lang === 'mermaid';

const THREE = 'Intro.\n\n```mermaid\ngraph TD; A-->B\n```\n\nMiddle prose.\n\n'
  + '```mermaid\ngraph TD; C-->D\n```\n\nMore prose.\n\n```mermaid\ngraph TD; E-->F\n```\n\nEnd.\n';

describe('the blocks an extension claims are the ones it gets', () => {
  test('a claimed language is found and an unclaimed one is left alone', () => {
    const { scope } = rendered('```mermaid\ngraph TD; A-->B\n```\n\n```js\nconst x = 1;\n```\n');
    const found = mount.claimedBlocks(scope, claimsMermaid);
    assert.strictEqual(found.length, 1, 'one claimed block, and the javascript is not it');
    assert.strictEqual(found[0].language, 'mermaid');
  });

  test('the source is the author\'s text, not the renderer\'s escaping', () => {
    // The bug this exists for is invisible until a diagram contains an
    // ampersand or an angle bracket, at which point the extension is handed
    // `A --&gt; B` and fails to parse something the author wrote correctly.
    const { scope } = rendered('```mermaid\ngraph TD; A --> B & C <D>\n```\n');
    const [block] = mount.claimedBlocks(scope, claimsMermaid);
    assert.strictEqual(block.source.trim(), 'graph TD; A --> B & C <D>');
  });

  test('a document with three diagrams yields three blocks, in the order they appear', () => {
    const { scope } = rendered(THREE);
    const found = mount.claimedBlocks(scope, claimsMermaid);
    assert.deepStrictEqual(found.map((b) => b.source.trim()),
      ['graph TD; A-->B', 'graph TD; C-->D', 'graph TD; E-->F']);
  });

  test('an unlabelled fence is labelled text by the renderer, and that is what a claim sees', () => {
    // Worth pinning rather than assuming either way. A fence the author left
    // unlabelled does NOT arrive here with no language: the renderer gives it
    // `text`. So an extension that claims `text` claims every unlabelled
    // block in the document, which is a consequence of the renderer's
    // labelling and not a decision this seam can make differently, since by
    // the time a block reaches here the two cases are the same DOM.
    const { scope } = rendered('```\nplain text\n```\n');
    assert.deepStrictEqual(mount.claimedBlocks(scope, () => true).map((b) => b.language), ['text']);
    assert.deepStrictEqual(mount.claimedBlocks(scope, claimsMermaid), [],
      'and an extension that claims something else does not get it');
  });
});

describe('the document keeps what it had', () => {
  test('the block is hidden beside the region, never removed, and comes back on release', () => {
    const { doc, scope } = rendered('```mermaid\ngraph TD; A-->B\n```\n');
    const [block] = mount.claimedBlocks(scope, claimsMermaid);
    const before = scope.innerHTML;
    const placed = mount.placeRegion(block, doc);
    assert.strictEqual(placed.wrapper.hidden, true, 'the source is out of the way');
    assert.ok(scope.querySelector('.region'), 'and a region stands where it was');
    assert.ok(scope.contains(placed.wrapper), 'but the block itself is still in the document');
    placed.release();
    assert.strictEqual(scope.innerHTML, before,
      'release restores the rendered document exactly, so nothing is lost by drawing');
  });

  test('showing the source is a toggle of two nodes that both already exist', () => {
    const { doc, scope } = rendered('```mermaid\ngraph TD; A-->B\n```\n');
    const placed = mount.placeRegion(mount.claimedBlocks(scope, claimsMermaid)[0], doc);
    placed.showSource();
    assert.strictEqual(placed.wrapper.hidden, false);
    assert.strictEqual(placed.region.hidden, true);
    placed.showRegion();
    assert.strictEqual(placed.wrapper.hidden, true);
    assert.strictEqual(placed.region.hidden, false);
  });

  test('the prose around a region is untouched', () => {
    const { doc, scope } = rendered('Before.\n\n```mermaid\ngraph TD; A-->B\n```\n\nAfter.\n');
    mount.placeRegion(mount.claimedBlocks(scope, claimsMermaid)[0], doc);
    const text = scope.textContent;
    assert.ok(text.includes('Before.') && text.includes('After.'),
      'a region is placed among the prose, not instead of it');
  });
});

describe('each region carries its own outcome', () => {
  function placeAll(md) {
    const { doc, scope } = rendered(md);
    const placed = mount.claimedBlocks(scope, claimsMermaid).map((b) => mount.placeRegion(b, doc));
    return { doc, scope, placed };
  }

  test('a drawing is appended as built nodes, never as returned markup', () => {
    const { doc, scope, placed } = placeAll('```mermaid\ngraph TD; A-->B\n```\n');
    const { node } = markup.buildRegionTree(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>window.x=1</script>'
      + '<rect x="1" y="1" width="8" height="8"/></svg>', doc);
    mount.drawResult(placed[0], node, doc);
    assert.ok(scope.querySelector('.region-drawn svg rect'), 'the diagram is drawn');
    assert.strictEqual(scope.querySelector('.region-drawn script'), null,
      'and what the builder refused never reaches the page through this path either');
  });

  test('one failure is one region: its neighbours and the prose are untouched', () => {
    const { doc, scope, placed } = placeAll(THREE);
    assert.strictEqual(placed.length, 3);
    const { node } = markup.buildRegionTree('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', doc);
    mount.drawResult(placed[0], node, doc);
    mount.drawFailure(placed[1], 'parse error on line 1', doc);
    mount.drawResult(placed[2], markup.buildRegionTree(
      '<svg xmlns="http://www.w3.org/2000/svg"><circle/></svg>', doc).node, doc);
    assert.strictEqual(scope.querySelectorAll('.region-drawn').length, 2, 'two drew');
    assert.strictEqual(scope.querySelectorAll('.region-failed').length, 1, 'one did not');
    assert.match(scope.querySelector('.region-failed-reason').textContent, /parse error on line 1/,
      'and it says what went wrong where it went wrong');
    assert.ok(scope.textContent.includes('Middle prose.'), 'the prose between them is unharmed');
  });

  test('a failed region offers the source, and offers a retry only when retrying could differ', () => {
    const { doc, scope, placed } = placeAll('```mermaid\nbroken\n```\n');
    mount.drawFailure(placed[0], 'parse error', doc);
    const actions = [...scope.querySelectorAll('.region-failed-action')].map((b) => b.textContent);
    assert.deepStrictEqual(actions, ['Show the source'],
      'no retry for a syntax error: the same bytes fail the same way, and a button that does nothing is worse than none');

    const second = placeAll('```mermaid\nbroken\n```\n');
    let retried = 0;
    mount.drawFailure(second.placed[0], 'the extension could not be loaded', second.doc, () => { retried += 1; });
    const withRetry = [...second.scope.querySelectorAll('.region-failed-action')].map((b) => b.textContent);
    assert.deepStrictEqual(withRetry, ['Show the source', 'Try again'],
      'a service failure CAN differ on a retry, because the retry rebuilds the frame');
    second.scope.querySelectorAll('.region-failed-action')[1].click();
    assert.strictEqual(retried, 1);
  });

  test('showing the source from a failed region puts the real block back in front of the reader', () => {
    const { doc, scope, placed } = placeAll('```mermaid\nbroken\n```\n');
    mount.drawFailure(placed[0], 'parse error', doc);
    scope.querySelector('.region-failed-action').click();
    assert.strictEqual(placed.wrapper ? placed.wrapper.hidden : placed[0].wrapper.hidden, false,
      'the thing the document actually contains is what a person falls back to');
  });

  test('each state replaces the last, so a region is never two things at once', () => {
    const { doc, scope, placed } = placeAll('```mermaid\ngraph TD; A-->B\n```\n');
    mount.drawWaiting(placed[0], doc);
    assert.strictEqual(scope.querySelectorAll('.region-skeleton').length, 1);
    mount.drawFailure(placed[0], 'no', doc);
    assert.strictEqual(scope.querySelectorAll('.region-skeleton').length, 0, 'the skeleton is gone');
    mount.drawResult(placed[0], markup.buildRegionTree(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', doc).node, doc);
    assert.strictEqual(scope.querySelectorAll('.region-failed').length, 0, 'and so is the failure card');
    assert.strictEqual(scope.querySelectorAll('.region-drawn').length, 1);
  });
});

// A link inside a diagram resolves in the app the reader
// clicked in. The convention is the counterpart's, deliberately: a node is a
// link when it carries `internal-link` and its destination is its own text,
// which is how the identical file behaves in Obsidian. Matching it is what
// makes one document work in both, and is why a wikilink inside a fence is
// the wrong answer however natural it looks.
describe('links inside a drawing are the host\'s to resolve', () => {
  function drawn(svgSource) {
    const { doc } = rendered('```mermaid\ngraph TD; A-->B\n```\n');
    const { node } = markup.buildRegionTree(svgSource, doc);
    return { doc, node };
  }
  const withLink = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
    + '<text class="node internal-link">Biology</text>'
    + '<text class="node">Just a label</text></svg>';

  test('a marked node becomes a link whose destination is its own text', () => {
    const { doc, node } = drawn(withLink);
    const opened = [];
    const wired = mount.attachInternalLinks(node, doc, (t) => opened.push(t));
    assert.strictEqual(wired, 1, 'one marked node, and the unmarked one beside it is left alone');
    const link = node.querySelector('.internal-link');
    link.dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.deepStrictEqual(opened, ['Biology'],
      'the node\'s own text is the destination, exactly as the counterpart reads it');
  });

  test('the class survives the rebuild, which is what makes any of this possible', () => {
    const { node } = drawn(withLink);
    assert.ok(node.querySelector('.internal-link'),
      'class is on the allowlist, so a marked node arrives marked');
  });

  test('a link is reachable by keyboard, not only by mouse', () => {
    const { doc, node } = drawn(withLink);
    const opened = [];
    mount.attachInternalLinks(node, doc, (t) => opened.push(t));
    const link = node.querySelector('.internal-link');
    assert.strictEqual(link.getAttribute('role'), 'link');
    assert.strictEqual(link.getAttribute('tabindex'), '0');
    link.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.deepStrictEqual(opened, ['Biology']);
  });

  test('a marked node with no text is not a link to nowhere', () => {
    const { doc, node } = drawn('<svg xmlns="http://www.w3.org/2000/svg"><text class="internal-link">   </text></svg>');
    assert.strictEqual(mount.attachInternalLinks(node, doc, () => {}), 0,
      'whitespace is not a destination, and a link that opens nothing is worse than no link');
  });
});

// Decide 27: provenance, not permission.
describe('a region says whose work it is, quietly', () => {
  test('the mark names the extension and is a label rather than a control', () => {
    const { doc, scope } = rendered('```mermaid\ngraph TD; A-->B\n```\n');
    const placed = mount.placeRegion(mount.claimedBlocks(scope, claimsMermaid)[0], doc);
    mount.markProvenance(placed, 'mermaid', doc);
    const mark = scope.querySelector('.region-mark');
    assert.strictEqual(mark.textContent, 'mermaid');
    assert.match(mark.getAttribute('aria-label'), /Drawn by mermaid/);
    assert.strictEqual(mark.tagName.toLowerCase(), 'span',
      'it answers why this looks different; it does not ask for anything');
  });
});

// Decide 26: a diagram taller than the reader.
describe('a tall drawing is capped with a way to see it whole', () => {
  test('capping adds the class and the control, and expanding removes both', () => {
    const { doc, scope } = rendered('```mermaid\ngraph TD; A-->B\n```\n');
    const placed = mount.placeRegion(mount.claimedBlocks(scope, claimsMermaid)[0], doc);
    let expanded = 0;
    mount.capTallRegion(placed, doc, (p) => {
      expanded += 1;
      p.region.classList.remove('region-capped');
      p.region.querySelector('.region-expand').remove();
    });
    assert.ok(placed.region.classList.contains('region-capped'));
    scope.querySelector('.region-expand').click();
    assert.strictEqual(expanded, 1);
    assert.strictEqual(placed.region.classList.contains('region-capped'), false,
      'expanding uncaps it rather than opening a second scroller nobody asked for');
    assert.strictEqual(scope.querySelector('.region-expand'), null);
  });
});

describe('what a reader is told when a region cannot be drawn', () => {
  // This path runs rarely, which is exactly why it is pinned: a sentence
  // nobody sees in normal use is a sentence nobody notices has gone wrong.

  test('an extension that will not load is named, without a duration', () => {
    const said = mount.failureText('mermaid', null);
    assert.strictEqual(said, 'Mermaid is not loading');
    assert.doesNotMatch(said, /\d+\s*ms/,
      'a duration is a fact about the implementation, not something to act on');
  });

  test('a diagram that will not parse keeps the message naming its line', () => {
    // Replacing this with something friendlier sends an author back to a
    // diagram with no idea which part of it to look at.
    const said = mount.failureText('mermaid', 'Parse error on line 2: bogus');
    assert.strictEqual(said, 'Parse error on line 2: bogus');
  });

  test('the extension is spoken about, not addressed', () => {
    assert.strictEqual(mount.displayName('mermaid'), 'Mermaid');
    assert.strictEqual(mount.displayName('excalidraw'), 'Excalidraw');
    // Only the first letter: the rest of the name belongs to its author, and
    // title-casing would rename it on their behalf.
    assert.strictEqual(mount.displayName('gantt-pro'), 'Gantt-pro');
  });

  test('a failure with no extension to name still reads as a sentence', () => {
    assert.strictEqual(mount.failureText('', null), 'The extension is not loading');
    assert.strictEqual(mount.failureText(undefined, null), 'The extension is not loading');
  });
});
