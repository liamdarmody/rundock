// Byte-for-byte round-trip tests for the Tiptap editor surface.
//
// These exercise the REAL editor (public/editor/ + vendor bundle) under
// jsdom via test/helpers/editor-harness.js. The invariant: loading a file
// into the editor and serializing it back without edits must reproduce the
// input exactly. This is the Obsidian-parity contract the editor already
// holds for wikilinks, callouts, and soft breaks; the table suite extends it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { roundTrip } from '../helpers/editor-harness.js';

describe('editor round-trip: existing constructs (harness smoke)', () => {
  test('plain paragraphs and headings round-trip byte-for-byte', async () => {
    const src = '# Title\n\nA paragraph with **bold** and *italic*.\n\n## Section\n\nAnother line.';
    assert.equal(await roundTrip(src), src);
  });

  test('wikilinks, soft breaks, and frontmatter round-trip byte-for-byte', async () => {
    const src = '---\ntitle: "Test"\n---\n**Date:** [[2026-07-10]]\n**Project:** [[some-project|Alias]]\n\n- item one\n- item two';
    assert.equal(await roundTrip(src), src);
  });
});
