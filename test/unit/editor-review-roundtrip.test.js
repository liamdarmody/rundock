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

  test('review operations do not grow the trailing newline run across save/load cycles', async () => {
    // Regression: buildEndmatter's yaml.dump output ends with \n and the
    // pipeline appended the file's trailing run on top, adding one newline
    // per review-op save/load cycle.
    const env = await bootEditorEnv();
    const { createReviewController } = await import('../../public/editor/review/controller.js');
    let file = ANNOTATED;
    for (let i = 0; i < 3; i++) {
      const element = env.window.document.createElement('div');
      env.window.document.body.appendChild(element);
      const { editor } = env.createEditor({ element, rawMarkdown: file });
      const parts = env.pipeline.parseFile(file);
      const review = createReviewController({ editor, endmatter: parts.endmatter, now: () => '2026-07-13T00:00:00.000Z' });
      review.reply('c1', `cycle ${i}`);
      file = env.pipeline.serialiseFile(editor, { ...parts, endmatterRaw: review.getEndmatterRaw() });
      env.destroyEditor(editor);
      element.remove();
    }
    assert.match(file, /[^\n]\n$/, `file must end with exactly one newline, got ${JSON.stringify(file.slice(-6))}`);
  });

  test('CRLF input is normalised to LF end-to-end (no mixed line endings)', async () => {
    // The server already normalises CRLF on read; the pipeline now applies
    // the same contract so endmatter detection and trailing runs cannot mix
    // \r\n into an otherwise-LF output.
    const out = await roundTrip('One.\r\n\r\nTwo.\r\n');
    assert.equal(out, 'One.\n\nTwo.\n');
    const env = await bootEditorEnv();
    const parts = env.pipeline.parseFile('Body.\r\n\r\n---\r\ncomments:\r\n  c1: { by: a, at: t }\r\n');
    assert.ok(parts.endmatter.raw.startsWith('---\ncomments:'), 'endmatter must be detected in CRLF files');
  });

  test('a file that is only endmatter does not grow a leading separator', async () => {
    const src = '---\ncomments:\n  c1: { by: a, at: t }\n';
    assert.equal(await roundTrip(src), src);
  });

  test('review-shaped YAML inside an unclosed code fence is not endmatter', async () => {
    const env = await bootEditorEnv();
    const parts = env.pipeline.parseFile('Text.\n\n```\n---\ncomments:\n  c1: { by: a, at: t }\n');
    assert.equal(parts.endmatter.raw, '', 'unclosed-fence tail must stay body');
  });

  test('fence tracking understands lengths, markers, and indentation', async () => {
    const env = await bootEditorEnv();
    // Closed 4-backtick fence containing a 3-backtick line: endmatter is real.
    const a = env.pipeline.parseFile('````\n```\n````\n\n---\ncomments:\n  c1: { by: a, at: t }\n');
    assert.ok(a.endmatter.raw.startsWith('---\ncomments:'), '4-backtick fence must count as closed');
    // Closed backtick fence containing a tilde line: endmatter is real.
    const b = env.pipeline.parseFile('```\n~~~\n```\n\n---\ncomments:\n  c1: { by: a, at: t }\n');
    assert.ok(b.endmatter.raw.startsWith('---\ncomments:'), 'mismatched inner marker must not open a fence');
    // Unclosed fence indented 1-3 spaces is still a fence.
    const c = env.pipeline.parseFile('Text.\n\n ```\n---\ncomments:\n  c1: { by: a, at: t }\n');
    assert.equal(c.endmatter.raw, '', 'indented unclosed fence tail must stay body');
  });

  test('frontmatter + endmatter with an empty body is cycle-stable', async () => {
    const src = '---\ntitle: x\n---\n---\ncomments:\n  c1: { by: a, at: t }\n';
    let out = src;
    for (let i = 0; i < 3; i++) out = await roundTrip(out);
    assert.equal(out, src);
  });

  test('every line-ending style normalises fully to LF', async () => {
    const env = await bootEditorEnv();
    const element = env.window.document.createElement('div');
    env.window.document.body.appendChild(element);
    const { editor } = env.createEditor({ element, rawMarkdown: 'One.\r\r\nTwo.\r' });
    try {
      const out = env.getMarkdown(editor);
      assert.ok(!out.includes('\r'), `no carriage returns may survive, got ${JSON.stringify(out)}`);
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
