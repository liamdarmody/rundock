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

  test('ordered lists with 10+ items keep unpadded numbers', async () => {
    // Regression: tiptap-markdown left-pads ordered-list numbers so
    // multi-digit lists align (" 1." ... "10."), which drifted every 10+
    // item list on every save. SoftOrderedList serializes unpadded.
    const items = Array.from({ length: 12 }, (_, i) => `${i + 1}. Item ${i + 1}`);
    const src = items.join('\n');
    assert.equal(await roundTrip(src), src);
  });

  test('the file\'s trailing newline survives the round-trip', async () => {
    // Regression: markdown parsing swallows final newlines, so every save
    // stripped the POSIX trailing newline. The pipeline now captures the
    // trailing newline run and re-appends it on serialize.
    const src = '# Title\n\nBody text.\n';
    assert.equal(await roundTrip(src), src);
    const multi = '# Title\n\nBody text.\n\n\n';
    assert.equal(await roundTrip(multi), multi);
  });

  test('blank line between frontmatter and body survives the round-trip', async () => {
    // Regression: extractFrontmatter used to leave the separator blank line
    // in the body, where markdown parsing swallowed it, so every save of a
    // conventionally formatted file (frontmatter, blank line, body) dropped
    // that line. The blank run now travels with the raw frontmatter block.
    const src = '---\ntitle: "Test"\n---\n\n# Heading\n\nBody text.';
    assert.equal(await roundTrip(src), src);
  });
});

describe('editor round-trip: serializer fidelity corpus', () => {
  // These constructs previously drifted on every save because the serializer
  // normalised source markers or over-escaped punctuation. Autosave writes the
  // serialized body, so any drift silently rewrote released notes. Each case
  // must reproduce the input byte-for-byte.

  test('task lists round-trip as real checkboxes, not escaped brackets', async () => {
    for (const src of ['- [ ] todo', '- [x] done', '- [ ] a\n- [x] b']) {
      assert.equal(await roundTrip(src), src);
    }
  });

  test('nested task lists stay tight (no injected blank line)', async () => {
    const src = '- [ ] parent\n  - [ ] child';
    assert.equal(await roundTrip(src), src);
  });

  test('a task list nested under a bullet round-trips', async () => {
    const src = '- parent\n  - [ ] child';
    assert.equal(await roundTrip(src), src);
  });

  test('emphasis content survives regardless of delimiter (no single-char deletion)', async () => {
    // Regression: a dynamic emphasis delimiter broke tiptap-markdown's inline
    // trim and deleted a single-character emphasis span flanked by other text
    // ("a _b_ c" -> "a c"). Content must never be lost. The `_`/`*` delimiter
    // itself is normalised to `*` on save (a documented cosmetic change), so
    // these assert content preservation, not the exact delimiter.
    assert.equal(await roundTrip('a *b* c'), 'a *b* c');
    assert.equal(await roundTrip('the variable *n* here'), 'the variable *n* here');
    assert.equal(await roundTrip('*a* *b*'), '*a* *b*');
    // Underscore emphasis keeps its content; the delimiter normalises to `*`.
    assert.equal(await roundTrip('a _b_ c'), 'a *b* c');
    assert.equal(await roundTrip('the variable _n_ here'), 'the variable *n* here');
  });

  test('strong content survives; delimiter normalises to **', async () => {
    assert.equal(await roundTrip('**bold**'), '**bold**');
    assert.equal(await roundTrip('__bold__'), '**bold**');
    assert.equal(await roundTrip('a **b** c'), 'a **b** c');
  });

  test('bullet-list markers are preserved (*, +, -)', async () => {
    assert.equal(await roundTrip('* one\n* two'), '* one\n* two');
    assert.equal(await roundTrip('+ one\n+ two'), '+ one\n+ two');
    assert.equal(await roundTrip('- one\n- two'), '- one\n- two');
  });

  test('thematic-break style is preserved (***, ___, ---)', async () => {
    assert.equal(await roundTrip('***'), '***');
    assert.equal(await roundTrip('___'), '___');
    assert.equal(await roundTrip('---\n'), '---\n');
  });

  test('literal brackets in prose are not over-escaped', async () => {
    assert.equal(await roundTrip('text [ ] more'), 'text [ ] more');
  });

  test('already-escaped punctuation is preserved verbatim', async () => {
    assert.equal(await roundTrip('1\\. not a list'), '1\\. not a list');
  });
});
