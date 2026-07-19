'use strict';
// Unit tests for in-place callout editing: the raw-markdown <-> attributes
// helpers must round-trip byte-honestly and reject invalid heads.
const { test, describe, before } = require('node:test');
const assert = require('node:assert');

// The node module is an ESM file; import it dynamically.
let calloutAttrsToRaw, rawToCalloutAttrs;
before(async () => {
  const mod = await import('../../public/editor/nodes/callout.js');
  ({ calloutAttrsToRaw, rawToCalloutAttrs } = mod);
});

describe('callout raw <-> attrs', () => {
  test('parses a plain callout head, fold marker, title, and body', () => {
    const attrs = rawToCalloutAttrs('> [!note] A title\n> line one\n> line two');
    assert.deepStrictEqual(attrs, {
      type: 'note', fold: '', title: 'A title', body: 'line one\nline two',
      head: '> [!note] A title',
    });
  });

  test('captures the fold marker and a blank body line', () => {
    const attrs = rawToCalloutAttrs('> [!warning]- Blocked\n>\n> after blank');
    assert.strictEqual(attrs.fold, '-');
    assert.strictEqual(attrs.body, '\nafter blank');
  });

  test('rejects a non-callout first line', () => {
    assert.strictEqual(rawToCalloutAttrs('not a callout\n> body'), null);
    assert.strictEqual(rawToCalloutAttrs(''), null);
  });

  test('raw -> attrs -> raw is a fixed point (byte-honest)', () => {
    const raw = '> [!tip]+ Keep this\n> first\n>\n> third';
    assert.strictEqual(calloutAttrsToRaw(rawToCalloutAttrs(raw)), raw);
  });

  test('an untouched head with irregular spacing survives verbatim', () => {
    // The exact head bytes are preserved via the captured `head`, so an unedited
    // callout never churns on save.
    const raw = '> [!quote]   Extra   spaces   ';
    const attrs = rawToCalloutAttrs(raw);
    assert.strictEqual(calloutAttrsToRaw(attrs).split('\n')[0], raw);
  });

  test('reconstructs a head when none was captured (in-editor callout)', () => {
    assert.strictEqual(
      calloutAttrsToRaw({ type: 'info', fold: '+', title: 'Hi', body: 'x' }),
      '> [!info]+ Hi\n> x');
  });
});
