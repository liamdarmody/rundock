// Review controller contract: verdicts, resolve lifecycle, authoring,
// and the Done-Reviewing handback. Semantics:
//
//  - suggestions ({++}/{--}/{~~}) carry Accept / Reject verdicts
//  - comments ({>>}) carry reply + resolve, no verdicts
//  - one document-level Done-Reviewing stamps the review status in the
//    endmatter and exposes a compact machine-readable verdict summary
//  - the FILE is the handback payload; no agent run is triggered

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bootEditorEnv } from '../helpers/editor-harness.js';

const NOW = '2026-07-12T12:00:00.000Z';

const DOC = `# Draft

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

async function withReview(rawMarkdown, fn) {
  const env = await bootEditorEnv();
  const { createReviewController } = await import('../../public/editor/review/controller.js');
  const element = env.window.document.createElement('div');
  env.window.document.body.appendChild(element);
  const { editor } = env.createEditor({ element, rawMarkdown });
  const handle = null;
  const { parseFile } = env.pipeline;
  const parts = parseFile(rawMarkdown);
  const review = createReviewController({
    editor,
    endmatter: parts.endmatter,
    author: 'liam',
    now: () => NOW,
  });
  const save = () => {
    const p = { ...parts, endmatterRaw: review.getEndmatterRaw() };
    return env.pipeline.serialiseFile(editor, p);
  };
  try {
    return await fn({ editor, review, save, env });
  } finally {
    env.destroyEditor(editor);
    element.remove();
  }
}

describe('listItems', () => {
  test('surfaces suggestions and comments with ids and kinds', async () => {
    await withReview(DOC, ({ review }) => {
      const items = review.listItems();
      const kinds = items.map((i) => `${i.kind}:${i.id}`);
      assert.deepEqual(kinds, ['comment:c1', 'suggestion:s1', 'suggestion:s2', 'suggestion:s3']);
      const c1 = items[0];
      assert.equal(c1.text, 'Needs a source');
      assert.equal(c1.anchor, 'this sentence');
      assert.equal(c1.meta.by, 'liam');
    });
  });
});

describe('suggestion verdicts', () => {
  test('accepting an insert lands its text in the document', async () => {
    await withReview(DOC, ({ review, save }) => {
      review.accept('s1');
      const out = save();
      assert.ok(out.includes('Add one concrete example and drop'), out);
      assert.ok(!out.includes('{++'), 'insert construct should be gone');
      assert.match(out, /s1:\n {4}by: penn\n {4}at: "[^"]+"\n {4}verdict: accepted\n {4}decidedAt: "2026-07-12T12:00:00\.000Z"/);
    });
  });

  test('rejecting an insert removes it', async () => {
    await withReview(DOC, ({ review, save }) => {
      review.reject('s1');
      const out = save();
      assert.ok(out.includes('Add  and drop') || out.includes('Add and drop'), out);
      assert.match(out, /verdict: rejected/);
    });
  });

  test('accepting a delete removes the text; rejecting restores it', async () => {
    await withReview(DOC, ({ review, save }) => {
      review.accept('s2');
      review.reject('s3');
      const out = save();
      assert.ok(!out.includes('the fluff'), 'accepted delete should remove text');
      assert.ok(out.includes('The intro is vague.'), 'rejected substitution keeps the original text');
    });
  });

  test('accepting a substitution swaps in the new text', async () => {
    await withReview(DOC, ({ review, save }) => {
      review.accept('s3');
      const out = save();
      assert.ok(out.includes('The intro needs a tighter claim.'), out);
      assert.ok(!out.includes('~>'), 'substitution construct should be gone');
    });
  });
});

describe('comment lifecycle', () => {
  test('resolving an anchored comment releases the highlighted text and records resolution', async () => {
    await withReview(DOC, ({ review, save }) => {
      review.resolve('c1');
      const out = save();
      assert.ok(out.includes('Review this sentence before publishing.'), out);
      assert.ok(!out.includes('{=='), 'highlight should be released');
      assert.ok(!out.includes('{>>'), 'comment construct should be gone');
      assert.match(out, /c1:\n {4}by: liam\n {4}at: "[^"]+"\n {4}body: "?Needs a source"?\n {4}resolved: true/);
    });
  });

  test('replying threads into the endmatter with re:', async () => {
    await withReview(DOC, ({ review, save }) => {
      review.reply('c1', 'Added the 2025 survey link.');
      const out = save();
      assert.match(out, /c2:\n {4}body: "?Added the 2025 survey link\."?\n {4}re: c1\n {4}by: liam\n {4}at: "2026-07-12T12:00:00\.000Z"/);
      assert.ok(out.includes('{>>Needs a source<<}{#c1}'), 'root comment stays inline');
    });
  });
});

describe('authoring', () => {
  test('adding a comment on a plain selection wraps it as an anchored highlight', async () => {
    const src = 'The pricing section needs work.';
    await withReview(src, ({ editor, review, save }) => {
      // Select "pricing section" (doc position: paragraph starts at 1)
      const text = editor.state.doc.textBetween(0, editor.state.doc.content.size);
      const start = text.indexOf('pricing section') + 1;
      editor.commands.setTextSelection({ from: start, to: start + 'pricing section'.length });
      review.addComment('Tighten this.');
      const out = save();
      assert.ok(out.includes('The {==pricing section==}{>>Tighten this.<<}{#c1} needs work.'), out);
      assert.match(out, /---\ncomments:\n {2}c1:\n {4}by: liam\n {4}at: "2026-07-12T12:00:00\.000Z"/);
    });
  });

  test('suggesting a replacement for a selection becomes a substitution', async () => {
    const src = 'The intro is vague today.';
    await withReview(src, ({ editor, review, save }) => {
      const text = editor.state.doc.textBetween(0, editor.state.doc.content.size);
      const start = text.indexOf('is vague') + 1;
      editor.commands.setTextSelection({ from: start, to: start + 'is vague'.length });
      review.suggestReplace('needs a claim');
      const out = save();
      assert.ok(out.includes('The intro {~~is vague~>needs a claim~~}{#s1} today.'), out);
      assert.match(out, /---\nsuggestions:\n {2}s1:\n {4}by: liam/);
    });
  });

  test('ids increment past existing anchors', async () => {
    await withReview(DOC, ({ editor, review, save }) => {
      editor.commands.setTextSelection({ from: 3, to: 8 });
      review.addComment('New thread.');
      const out = save();
      assert.ok(out.includes('{#c2}'), 'next comment id should be c2');
    });
  });
});

describe('id-less constructs and orphan handling', () => {
  test('verdicts on id-less constructs resolve by position, not first-null-id match', async () => {
    // Regression: findConstruct(null) matched the first critic node with a
    // null id (often a highlight), so Accept/Reject silently no-opped.
    const src = 'A {==hl==} B {++ins++} C {--del--} D.';
    await withReview(src, ({ review, save }) => {
      const ins = review.listItems().find((i) => i.type === 'criticInsert');
      assert.equal(ins.id, null);
      assert.equal(review.accept(ins.id != null ? ins.id : { pos: ins.pos }), true);
      const out = save();
      assert.ok(out.includes('A {==hl==} B ins C {--del--} D.'), out);
      assert.match(out, /verdict: accepted/);
    });
  });

  test('an orphan highlight is listed and releasable', async () => {
    // A highlight separated from its comment (or left behind by external
    // edits) must have a UI path out; it surfaces as a review item whose
    // release restores the plain text.
    const src = 'Note {==this==} gap {>>why<<}{#c1} here.';
    await withReview(src, ({ review, save }) => {
      review.resolve('c1');
      const orphan = review.listItems().find((i) => i.kind === 'highlight');
      assert.ok(orphan, 'orphan highlight must appear in listItems');
      assert.equal(review.release({ pos: orphan.pos }), true);
      const out = save();
      assert.ok(out.includes('Note this gap  here.'), out);
      assert.ok(!out.includes('{=='), 'highlight construct must be gone');
    });
  });

  test('replying to a nonexistent comment id is refused', async () => {
    await withReview(DOC, ({ review, save }) => {
      assert.equal(review.reply('c999', 'hello?'), false);
      assert.ok(!save().includes('c999'), 'no orphan thread persisted');
    });
  });

  test('replying to a suggestion or highlight id is refused', async () => {
    const src = 'Take {~~this~>that~~}{#s1} word {==here==}{#c9}.';
    await withReview(src, ({ review, save }) => {
      assert.equal(review.reply('s1', 'why though?'), false);
      assert.equal(review.reply('c9', 'why though?'), false);
      assert.ok(!save().includes('re:'), 'no orphan threads persisted');
    });
  });

  test('a stale position locator is refused, never applied to a shifted construct', async () => {
    const src = 'X {++aa++}{++bb++} Y.';
    await withReview(src, ({ review, save }) => {
      const first = review.listItems()[0];
      const locator = { pos: first.pos, type: first.type, content: first.text };
      assert.equal(review.reject(locator), true);
      assert.equal(review.reject(locator), false, 'second call with a stale locator must refuse');
      const out = save();
      assert.ok(out.includes('{++bb++}'), 'the neighbouring construct must survive');
    });
  });

  test('out-of-range position locators are refused, not thrown', async () => {
    await withReview(DOC, ({ review }) => {
      assert.equal(review.accept({ pos: 99999 }), false);
      assert.equal(review.accept({ pos: -1 }), false);
      assert.equal(review.accept({ pos: NaN }), false);
    });
  });

  test('release refuses a highlight that anchors a live comment', async () => {
    const src = 'Note {==this==}{>>why<<}{#c1} here.';
    await withReview(src, ({ editor, review, save }) => {
      let hlPos = null;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'criticHighlight') hlPos = pos;
        return true;
      });
      assert.equal(review.release({ pos: hlPos, type: 'criticHighlight', content: 'this' }), false);
      assert.ok(save().includes('{==this==}{>>why<<}{#c1}'), 'anchored pair must stay intact');
    });
  });
});

describe('verdict/undo reconciliation', () => {
  test('undoing an accepted suggestion drops the stale verdict from the endmatter', async () => {
    // A construct present in the document is undecided by definition: after
    // accept + Cmd+Z the construct returns, so serializing both it AND its
    // verdict would hand agents a self-contradicting file.
    await withReview(DOC, async ({ editor, review, save }) => {
      await new Promise((r) => setTimeout(r, 550)); // separate history group
      review.accept('s1');
      editor.commands.undo();
      const out = save();
      assert.ok(out.includes('{++one concrete example++}{#s1}'), 'construct must be restored');
      assert.ok(!out.includes('verdict:'), 'stale verdict must not serialize');
    });
  });

  test('a fully undone review session serializes the original endmatter bytes', async () => {
    await withReview(DOC, async ({ editor, review, save }) => {
      await new Promise((r) => setTimeout(r, 550));
      review.accept('s1');
      editor.commands.undo();
      const emStart = DOC.indexOf('---\ncomments:');
      assert.equal(save(), DOC.slice(0, DOC.length), 'byte-identical after full undo');
    });
  });

  test('undoing a resolve drops the stale resolution fields', async () => {
    await withReview(DOC, async ({ editor, review, save }) => {
      await new Promise((r) => setTimeout(r, 550));
      review.resolve('c1');
      editor.commands.undo();
      const out = save();
      assert.ok(out.includes('{>>Needs a source<<}{#c1}'), 'comment construct must be restored');
      assert.ok(!out.includes('resolved:'), 'stale resolution must not serialize');
    });
  });

  test('verdicts on constructs that stay decided still serialize', async () => {
    await withReview(DOC, async ({ review, save }) => {
      review.accept('s1');
      review.reject('s2');
      const out = save();
      assert.match(out, /s1:[\s\S]*?verdict: accepted/);
      assert.match(out, /s2:[\s\S]*?verdict: rejected/);
    });
  });
});

describe('identity', () => {
  test('the default author handle is me, never a personal name', async () => {
    const env = await bootEditorEnv();
    const { createReviewController } = await import('../../public/editor/review/controller.js');
    const element = env.window.document.createElement('div');
    env.window.document.body.appendChild(element);
    const { editor } = env.createEditor({ element, rawMarkdown: 'Plain text here.' });
    try {
      const review = createReviewController({ editor, endmatter: { raw: '', data: null }, now: () => NOW });
      editor.commands.setTextSelection({ from: 1, to: 6 });
      review.addComment('note');
      assert.equal(review.getData().comments.c1.by, 'me');
    } finally {
      env.destroyEditor(editor);
      element.remove();
    }
  });
});

describe('Done-Reviewing handback', () => {
  test('stamps review status and a compact verdict summary into the endmatter', async () => {
    await withReview(DOC, ({ review, save }) => {
      review.accept('s1');
      review.reject('s2');
      review.resolve('c1');
      const payload = review.doneReviewing();
      assert.equal(payload.review.status, 'done');
      assert.equal(payload.review.at, NOW);
      assert.deepEqual(payload.review.summary, {
        suggestions: { accepted: 1, rejected: 1, open: 1 },
        comments: { resolved: 1, open: 0, replies: 0 },
      });
      const out = save();
      assert.match(out, /review:\n {2}status: done\n {2}at: "2026-07-12T12:00:00\.000Z"/);
      assert.match(out, /summary:/);
    });
  });

  test('the endmatter passes through byte-exact until a review op happens', async () => {
    await withReview(DOC, ({ review }) => {
      assert.equal(review.isDirty(), false);
      const raw = review.getEndmatterRaw();
      assert.ok(raw.startsWith('---\ncomments:'));
      assert.ok(raw.includes('at: "2026-07-12T10:07:00.000Z"'));
    });
  });
});
