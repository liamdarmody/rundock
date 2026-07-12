// Byte-for-byte round-trip of CriticMarkup constructs + YAML endmatter
// through the REAL editor (serialization boundary).
//
// The hard acceptance bar: an annotated document loads into the editor
// (constructs as inline atoms, endmatter stripped) and serializes back
// byte-for-byte when nothing was decided.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { roundTrip, bootEditorEnv } from '../helpers/editor-harness.js';

const ANNOTATED = `---
title: "Draft"
---

# The Draft

Review {==this sentence==}{>>Needs a source<<}{#c1} before publishing.

Add {++one concrete example++}{#s1} and drop {--the fluff--}{#s2}.

The intro {~~is vague~>needs a tighter claim~~}{#s3}.

---
comments:
  c1:
    by: liam
    at: "2026-07-12T10:00:00.000Z"
suggestions:
  s1:
    by: penn
    at: "2026-07-12T10:05:00.000Z"
  s2:
    by: penn
    at: "2026-07-12T10:06:00.000Z"
  s3:
    by: penn
    at: "2026-07-12T10:07:00.000Z"
`;

describe('review round-trip: constructs and endmatter', () => {
  test('a fully annotated document round-trips byte-for-byte', async () => {
    assert.equal(await roundTrip(ANNOTATED), ANNOTATED);
  });

  test('each construct round-trips alone', async () => {
    const cases = [
      'A {>>bare comment<<} inline.',
      'A {>>comment with id<<}{#c9} inline.',
      'An {++insertion++} and a {--deletion--}{#s1}.',
      'A {~~swap this~>for that~~}{#s2} substitution.',
      'A {==highlight==} alone, and paired {==text==}{>>why<<}{#c2}.',
    ];
    for (const src of cases) {
      assert.equal(await roundTrip(src), src);
    }
  });

  test('construct content with markdown syntax stays literal and byte-exact', async () => {
    const src = 'Keep {++**bold** and _em_ and [x](y)++} raw.';
    assert.equal(await roundTrip(src), src);
  });

  test('CriticMarkup inside inline code and fences stays literal', async () => {
    const src = 'Code `{++not a construct++}` span.\n\n```\n{>>also literal<<}\n```';
    assert.equal(await roundTrip(src), src);
  });

  test('constructs parse into atom nodes', async () => {
    const env = await bootEditorEnv();
    const element = env.window.document.createElement('div');
    env.window.document.body.appendChild(element);
    const { editor } = env.createEditor({
      element,
      rawMarkdown: 'Review {==x==}{>>why<<}{#c1} and {++add++}{#s1} and {~~a~>b~~}.',
    });
    try {
      const found = {};
      editor.state.doc.descendants((node) => {
        if (node.type.name.startsWith('critic')) {
          found[node.type.name] = (found[node.type.name] || 0) + 1;
        }
        return true;
      });
      assert.equal(found.criticHighlight, 1);
      assert.equal(found.criticComment, 1);
      assert.equal(found.criticInsert, 1);
      assert.equal(found.criticSubstitution, 1);
    } finally {
      env.destroyEditor(editor);
      element.remove();
    }
  });

  test('endmatter is not rendered into the document', async () => {
    const env = await bootEditorEnv();
    const element = env.window.document.createElement('div');
    env.window.document.body.appendChild(element);
    const { editor } = env.createEditor({ element, rawMarkdown: ANNOTATED });
    try {
      assert.ok(!editor.getText().includes('comments:'), 'endmatter YAML leaked into the editor');
    } finally {
      env.destroyEditor(editor);
      element.remove();
    }
  });

  test('editing body text leaves the endmatter bytes untouched', async () => {
    const env = await bootEditorEnv();
    const element = env.window.document.createElement('div');
    env.window.document.body.appendChild(element);
    const { editor } = env.createEditor({ element, rawMarkdown: ANNOTATED });
    try {
      editor.chain().insertContentAt(editor.state.doc.content.size, ' Appended.').run();
      const out = env.getMarkdown(editor);
      const emStart = out.indexOf('\n---\ncomments:');
      const srcEmStart = ANNOTATED.indexOf('\n---\ncomments:');
      assert.ok(emStart !== -1, 'endmatter missing after edit');
      assert.equal(out.slice(emStart), ANNOTATED.slice(srcEmStart), 'endmatter bytes drifted');
      assert.ok(out.includes('Appended.'));
    } finally {
      env.destroyEditor(editor);
      element.remove();
    }
  });
});
