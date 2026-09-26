// Copying from inside a code block in the rich editor puts the code on the
// clipboard, not a fenced markdown block; a selection that reaches outside the
// block keeps its fences; and pasting what was copied back into a code block
// leaves no stray fences.
//
// The clipboard text is computed exactly the way ProseMirror computes it for a
// copy: the first clipboardTextSerializer any plugin offers, over the
// selection's own slice. Pasting goes through the view's own pasteText, which
// runs the same paste pipeline a keyboard paste does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootEditorEnv } from '../helpers/editor-harness.js';

const NOTE = '# Notes\n\nSome prose before.\n\n```js\nconst total = 4471;\nconsole.log(total);\n```\n\nProse after.\n\n```\nplain fenced content\n```\n';

function clipboardText(view) {
  const slice = view.state.selection.content();
  return view.someProp('clipboardTextSerializer', (f) => f(slice, view))
    || slice.content.textBetween(0, slice.content.size, '\n\n');
}

// The document positions of each code block's text.
function codeBlocks(doc) {
  const blocks = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock') blocks.push({ from: pos + 1, to: pos + 1 + node.content.size, text: node.textContent });
  });
  return blocks;
}

async function withEditor(fn) {
  const env = await bootEditorEnv();
  const element = env.window.document.createElement('div');
  env.window.document.body.appendChild(element);
  const { editor } = env.createEditor({ element, rawMarkdown: NOTE });
  try { return await fn(editor, env); } finally { env.destroyEditor(editor); }
}

test('part of a code block copies as exactly that text, no fences and no language', async () => {
  await withEditor((editor) => {
    const [block] = codeBlocks(editor.state.doc);
    editor.commands.setTextSelection({ from: block.from + 6, to: block.from + 11 });
    assert.equal(clipboardText(editor.view), 'total');
  });
});

test('all of a code block\'s text copies as the code alone', async () => {
  await withEditor((editor) => {
    const [block] = codeBlocks(editor.state.doc);
    editor.commands.setTextSelection({ from: block.from, to: block.to });
    const copied = clipboardText(editor.view);
    assert.equal(copied, 'const total = 4471;\nconsole.log(total);');
    assert.ok(!copied.includes('```'));
  });
});

test('a selection from prose into a code block keeps the fences, because there they carry meaning', async () => {
  await withEditor((editor) => {
    const [block] = codeBlocks(editor.state.doc);
    let prose = null;
    editor.state.doc.descendants((node, pos) => { if (prose === null && node.isText && node.text.startsWith('Some prose')) prose = pos; });
    editor.commands.setTextSelection({ from: prose, to: block.to });
    const copied = clipboardText(editor.view);
    assert.match(copied, /Some prose before\./);
    assert.match(copied, /```js\nconst total = 4471;\nconsole\.log\(total\);\n```/);
  });
});

test('pasting what was copied from one code block into another leaves no stray fences', async () => {
  await withEditor((editor, env) => {
    const [first, second] = codeBlocks(editor.state.doc);
    editor.commands.setTextSelection({ from: first.from, to: first.to });
    const copied = clipboardText(editor.view);
    editor.commands.setTextSelection(second.to);
    editor.view.pasteText(copied);
    const after = codeBlocks(editor.state.doc)[1];
    assert.equal(after.text, 'plain fenced contentconst total = 4471;\nconsole.log(total);');
    assert.ok(!env.getMarkdown(editor).includes('``````'));
    assert.equal((env.getMarkdown(editor).match(/```/g) || []).length, 4, 'two blocks, four fences, none added');
  });
});
