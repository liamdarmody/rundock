// Quote-anchor engine: capture, locate (with duplicate disambiguation),
// orphan behaviour, and offset<->Range mapping across element boundaries.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  buildTextIndex, captureSelector, locateSelector, rangeToOffsets, offsetsToRange,
} from '../../public/viewers/text-anchor.js';

function indexOf(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  const body = dom.window.document.body;
  return buildTextIndex(body);
}

describe('buildTextIndex', () => {
  test('linearises text across nested elements', () => {
    const idx = indexOf('<h1>Quarterly <b>Proposal</b></h1><p>Three workstreams.</p>');
    assert.equal(idx.text, 'Quarterly ProposalThree workstreams.');
    assert.equal(idx.nodes.length, 3);
  });

  test('empty document produces an empty index', () => {
    const idx = indexOf('');
    assert.equal(idx.text, '');
    assert.equal(locateSelector(idx, { quote: 'anything' }), null);
  });
});

describe('captureSelector', () => {
  test('captures quote with bounded prefix/suffix context', () => {
    const idx = indexOf('<p>The enterprise pricing ladder was agreed in June.</p>');
    const start = idx.text.indexOf('pricing ladder');
    const sel = captureSelector(idx, start, start + 'pricing ladder'.length);
    assert.equal(sel.quote, 'pricing ladder');
    assert.equal(sel.prefix, 'The enterprise ');
    assert.equal(sel.suffix, ' was agreed in June.');
  });

  test('context truncates at document edges; invalid spans return null', () => {
    const idx = indexOf('<p>short</p>');
    const sel = captureSelector(idx, 0, 5);
    assert.equal(sel.prefix, '');
    assert.equal(sel.suffix, '');
    assert.equal(captureSelector(idx, 3, 3), null);
    assert.equal(captureSelector(idx, 0, 99), null);
  });
});

describe('locateSelector', () => {
  test('unique quote is found regardless of context drift', () => {
    const idx = indexOf('<p>alpha beta gamma</p>');
    const hit = locateSelector(idx, { quote: 'beta', prefix: 'totally different ', suffix: ' context' });
    assert.deepEqual(hit, { start: 6, end: 10 });
  });

  test('duplicate quotes disambiguate by surrounding context', () => {
    const idx = indexOf('<p>Total: 42% growth.</p><p>Churn: 42% decline.</p>');
    const hit = locateSelector(idx, { quote: '42%', prefix: 'Churn: ', suffix: ' decline' });
    assert.equal(idx.text.slice(hit.start - 7, hit.start), 'Churn: ');
  });

  test('missing quote returns null (caller marks orphaned)', () => {
    const idx = indexOf('<p>nothing to see</p>');
    assert.equal(locateSelector(idx, { quote: 'deleted passage', prefix: '', suffix: '' }), null);
    assert.equal(locateSelector(idx, null), null);
    assert.equal(locateSelector(idx, { quote: '' }), null);
  });

  test('partial context damage still picks the better occurrence', () => {
    const idx = indexOf('<p>use the ladder here</p><p>climb the ladder now</p>');
    const hit = locateSelector(idx, { quote: 'ladder', prefix: 'climb the ', suffix: ' EDITED' });
    assert.equal(idx.text.slice(hit.start - 10, hit.start), 'climb the ');
  });
});

describe('offset <-> Range mapping', () => {
  test('rangeToOffsets and offsetsToRange round-trip inside one text node', () => {
    const idx = indexOf('<p>The quick brown fox</p>');
    const range = offsetsToRange(idx, 4, 9);
    assert.equal(range.toString(), 'quick');
    const back = rangeToOffsets(idx, range);
    assert.deepEqual(back, { start: 4, end: 9 });
  });

  test('a span crossing element boundaries maps to a multi-node Range', () => {
    const idx = indexOf('<p>Quarterly <b>Proposal</b> deck</p>');
    const start = idx.text.indexOf('erly Prop');
    const range = offsetsToRange(idx, start, start + 'erly Prop'.length);
    assert.equal(range.toString(), 'erly Prop');
    assert.notEqual(range.startContainer, range.endContainer);
    const back = rangeToOffsets(idx, range);
    assert.deepEqual(back, { start, end: start + 'erly Prop'.length });
  });

  test('a span ending exactly at a node border stays in that node', () => {
    const idx = indexOf('<p><b>one</b>two</p>');
    const range = offsetsToRange(idx, 0, 3);
    assert.equal(range.toString(), 'one');
    assert.equal(range.endContainer.nodeValue, 'one');
  });

  test('element-container ranges (selectNodeContents, triple-click) map correctly', () => {
    const idx = indexOf('<p>before</p><div id="t">Quarterly <b>Proposal</b></div><p>after</p>');
    const doc = idx.root.ownerDocument;
    const range = doc.createRange();
    range.selectNodeContents(doc.getElementById('t'));
    const offs = rangeToOffsets(idx, range);
    assert.equal(idx.text.slice(offs.start, offs.end), 'Quarterly Proposal');
  });

  test('degenerate inputs return null', () => {
    const idx = indexOf('<p>abc</p>');
    assert.equal(offsetsToRange(idx, 2, 2), null);
    assert.equal(offsetsToRange(idx, 0, 99), null);
    const foreign = indexOf('<p>other</p>');
    const range = offsetsToRange(foreign, 0, 3);
    assert.equal(rangeToOffsets(idx, range), null, 'ranges from another document do not map');
  });
});
