'use strict';
// Unit tests for in-place callout editing: the raw-markdown <-> attributes
// helpers must round-trip byte-honestly and reject invalid heads.
const { test, describe, before } = require('node:test');
const assert = require('node:assert');

// The node module is an ESM file; import it dynamically.
let calloutAttrsToRaw, rawToCalloutAttrs, calloutAttrsEqual;
before(async () => {
  const mod = await import('../../public/editor/nodes/callout.js');
  ({ calloutAttrsToRaw, rawToCalloutAttrs, calloutAttrsEqual } = mod);
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

  test('a blank body line with trailing whitespace round-trips byte-for-byte (P1-4)', () => {
    const raw = '> [!note] T\n> body\n> \n> more';
    assert.strictEqual(calloutAttrsToRaw(rawToCalloutAttrs(raw)), raw);
    // A blank body line that is a bare tab also survives.
    const tab = '> [!note] T\n> body\n>\t\n> end';
    assert.strictEqual(calloutAttrsToRaw(rawToCalloutAttrs(tab)), tab);
  });

  test('a bare blank line stays bare (no trailing space added)', () => {
    const raw = '> [!note] T\n> a\n>\n> b';
    assert.strictEqual(calloutAttrsToRaw(rawToCalloutAttrs(raw)), raw);
  });
});

describe('calloutAttrsEqual (P1-2: skip a no-op commit)', () => {
  test('equal when the callout-shaping attributes match', () => {
    const a = { type: 'note', fold: '', title: 'T', body: 'x', head: '> [!note] T' };
    const b = { type: 'note', fold: '', title: 'T', body: 'x', head: '> [!note] T' };
    assert.strictEqual(calloutAttrsEqual(a, b), true);
  });

  test('differs when any shaping attribute changes', () => {
    const base = { type: 'note', fold: '', title: 'T', body: 'x', head: '> [!note] T' };
    assert.strictEqual(calloutAttrsEqual(base, { ...base, body: 'y' }), false);
    assert.strictEqual(calloutAttrsEqual(base, { ...base, title: 'U' }), false);
    assert.strictEqual(calloutAttrsEqual(base, { ...base, fold: '-' }), false);
    assert.strictEqual(calloutAttrsEqual(base, { ...base, type: 'tip' }), false);
    assert.strictEqual(calloutAttrsEqual(base, { ...base, head: '> [!note]  T' }), false);
  });
});
