'use strict';
// Typing [[ in the note body suggests notes to link to. These tests drive the
// real editor in jsdom: keys go through the editor's own key handlers, typing
// through its text-input handlers (so the [[...]] input rule runs), and what
// is saved is read back through the editor's own serialiser. Every name here
// is made up.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { bootEditorEnv } from '../helpers/editor-harness.js';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { wikilinkCandidates, findFileInTree, wikilinkSearchName } = require('../../public/views/files.js');

const env = await bootEditorEnv();
globalThis.RundockFuzzy = require('../../public/fuzzy-score.js');
const suggest = await import('../../public/editor/plugins/wikilink-suggest.js');
const { insertWikilink, rankTargets, wikilinkSuggestKey, MAX_SUGGESTIONS, NO_NOTES_TEXT } = suggest;
const { document, KeyboardEvent, MouseEvent } = env.window;

const NOTES = [
  { path: 'example/alpha/Roadmap.md', name: 'Roadmap', target: 'Roadmap' },
  { path: 'example/beta/Roadmap.md', name: 'Roadmap', target: 'example/beta/Roadmap' },
  { path: 'example/Plan.md', name: 'Plan', target: 'Plan' },
  { path: 'Ideas.md', name: 'Ideas', target: 'Ideas' },
];

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const mounted = [];
afterEach(() => {
  while (mounted.length) mounted.pop()();
  for (const el of document.querySelectorAll('.wikilink-suggest')) el.remove();
});

// One editor on rawMarkdown, the cursor at the end of the last paragraph.
// list is what the host hands back each time the list opens.
function mount(rawMarkdown = 'Intro\n', list = () => NOTES, extra = {}) {
  const element = document.createElement('div');
  document.body.appendChild(element);
  let calls = 0;
  const { editor } = env.createEditor({
    element,
    rawMarkdown,
    listWikilinkTargets: list === null ? null : () => { calls += 1; return list(); },
    ...extra,
  });
  const view = editor.view;
  mounted.push(() => { env.destroyEditor(editor); element.remove(); });
  editor.commands.setTextSelection(view.state.doc.content.size - 1);

  const type = (text) => {
    for (const ch of text) {
      const { from, to } = view.state.selection;
      if (!view.someProp('handleTextInput', (f) => f(view, from, to, ch))) {
        view.dispatch(view.state.tr.insertText(ch, from, to));
      }
    }
  };
  const press = (key, init = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    return !!view.someProp('handleKeyDown', (f) => f(view, event));
  };
  // A plain Backspace in text is the browser's own deletion, which jsdom
  // does not perform; the same change is dispatched directly.
  const backspace = () => {
    if (press('Backspace')) return;
    const { from } = view.state.selection;
    view.dispatch(view.state.tr.delete(from - 1, from));
  };
  const popup = () => document.querySelector('.wikilink-suggest');
  const shown = () => !!popup() && !popup().hidden;
  const rows = () => [...document.querySelectorAll('.wikilink-suggest-item')];
  const names = () => rows().map((r) => r.querySelector('.wikilink-suggest-title').textContent);
  const selectedIndex = () => rows().findIndex((r) => r.classList.contains('selected'));
  const links = () => {
    const out = [];
    view.state.doc.descendants((n) => { if (n.type.name === 'wikilink') out.push(n.attrs.target); });
    return out;
  };
  const markdown = () => env.getMarkdown(editor);
  return {
    editor, view, element, type, press, backspace, popup, shown, rows, names, selectedIndex, links, markdown,
    calls: () => calls,
  };
}

// Records unhandled rejections and uncaught errors while fn runs.
async function nothingThrows(fn) {
  const seen = [];
  const record = (err) => seen.push(err);
  process.on('unhandledRejection', record);
  process.on('uncaughtException', record);
  try {
    await fn();
    await tick();
    await tick();
  } finally {
    process.off('unhandledRejection', record);
    process.off('uncaughtException', record);
  }
  assert.deepEqual(seen, [], 'something threw');
}

describe('typing [[ lists notes', () => {
  test('[[ opens the list of notes by name, sorted, each with its folder', async () => {
    const ed = mount();
    ed.type(' [[');
    await tick();
    assert.ok(ed.shown(), 'the list opened');
    assert.deepEqual(ed.names(), ['Ideas', 'Plan', 'Roadmap', 'Roadmap']);
    assert.deepEqual(ed.rows().map((r) => r.querySelector('.wikilink-suggest-meta')?.textContent ?? ''),
      ['', 'example', 'example/alpha', 'example/beta']);
    assert.equal(ed.selectedIndex(), 0, 'the first row is selected');
  });

  test('what is typed after [[ filters the list with the fuzzy scorer', async () => {
    const ed = mount();
    ed.type('[[rdmp');
    await tick();
    assert.deepEqual(ed.names(), ['Roadmap', 'Roadmap']);
    ed.backspace(); ed.backspace(); ed.backspace(); ed.backspace();
    ed.type('pl');
    await tick();
    assert.deepEqual(ed.names(), ['Plan']);
  });

  test('a query with a folder in it matches the path', async () => {
    const ed = mount();
    ed.type('[[beta/road');
    await tick();
    assert.deepEqual(ed.rows().map((r) => r.querySelector('.wikilink-suggest-meta').textContent), ['example/beta']);
  });

  test('nothing matching says so in words', async () => {
    const ed = mount();
    ed.type('[[zzz');
    await tick();
    assert.ok(ed.shown());
    assert.equal(ed.rows().length, 0);
    assert.equal(ed.popup().textContent, NO_NOTES_TEXT);
    assert.equal(NO_NOTES_TEXT, 'No notes found');
  });

  test(`at most ${MAX_SUGGESTIONS} notes are listed`, async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ path: `example/Note ${String(i).padStart(2, '0')}.md`, name: `Note ${String(i).padStart(2, '0')}`, target: `Note ${String(i).padStart(2, '0')}` }));
    const ed = mount('Intro\n', () => many);
    ed.type('[[');
    await tick();
    assert.equal(MAX_SUGGESTIONS, 20);
    assert.equal(ed.rows().length, 20);
    ed.type('note');
    await tick();
    assert.equal(ed.rows().length, 20);
    assert.equal(rankTargets(many, '').length, 20);
  });

  test('no list callback, no suggestions, and [[ is ordinary text', async () => {
    const ed = mount('Intro\n', null);
    ed.type('[[Pla');
    await tick();
    assert.equal(ed.popup(), null);
    assert.equal(ed.markdown(), 'Intro[[Pla\n');
  });

  test('moving the cursor into an unclosed [[ does not open the list', async () => {
    const ed = mount('See [[Roadmap later\n');
    ed.editor.commands.setTextSelection(12);
    await tick();
    assert.equal(ed.popup(), null);
    ed.type('s');
    await tick();
    assert.equal(ed.popup(), null, 'typing after an old [[ does not open it either');
    assert.equal(ed.calls(), 0);
  });

  // Straight after a link the browser can hand over several keys in one
  // change, so [[ arrives together with what follows it.
  test('[[ arriving in one change with the keys after it opens the list filtered', async () => {
    const ed = mount('See [[Ideas]]\n');
    const { from } = ed.view.state.selection;
    ed.view.dispatch(ed.view.state.tr.insertText(' [[rdmp', from, from));
    await tick();
    assert.ok(ed.shown(), 'the list opened');
    assert.deepEqual(ed.names(), ['Roadmap', 'Roadmap']);
    assert.equal(ed.calls(), 1);
  });
});

describe('choosing a note', () => {
  test('the arrows move the selection and wrap at either end', async () => {
    const ed = mount();
    ed.type('[[');
    await tick();
    assert.ok(ed.press('ArrowDown'));
    assert.equal(ed.selectedIndex(), 1);
    assert.ok(ed.press('ArrowUp'));
    assert.ok(ed.press('ArrowUp'));
    assert.equal(ed.selectedIndex(), 3, 'up from the first row goes to the last');
    assert.ok(ed.press('ArrowDown'));
    assert.equal(ed.selectedIndex(), 0, 'down from the last row goes to the first');
  });

  test('Enter inserts the selected note', async () => {
    const ed = mount();
    ed.type(' [[');
    await tick();
    ed.press('ArrowDown');
    assert.ok(ed.press('Enter'));
    await tick();
    assert.deepEqual(ed.links(), ['Plan']);
    assert.equal(ed.markdown(), 'Intro [[Plan]]\n');
    assert.equal(ed.popup(), null, 'the list closes');
  });

  test('Tab inserts the selected note', async () => {
    const ed = mount();
    ed.type(' [[ide');
    await tick();
    assert.ok(ed.press('Tab'));
    await tick();
    assert.equal(ed.markdown(), 'Intro [[Ideas]]\n');
  });

  test('a click inserts the note clicked, and the mouse down keeps the editor focus', async () => {
    const ed = mount();
    ed.type(' [[');
    await tick();
    const row = ed.rows()[2];
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    row.dispatchEvent(down);
    assert.ok(down.defaultPrevented, 'mousedown on the list would otherwise take the focus');
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    assert.equal(ed.markdown(), 'Intro [[Roadmap]]\n');
  });

  test('Escape closes the list and inserts nothing', async () => {
    const ed = mount();
    ed.type(' [[Pla');
    await tick();
    assert.ok(ed.press('Escape'));
    await tick();
    assert.equal(ed.popup(), null);
    assert.deepEqual(ed.links(), []);
    assert.equal(ed.markdown(), 'Intro [[Pla\n');
  });

  test('Enter with no match finishes the link with the typed text', async () => {
    const ed = mount();
    ed.type(' [[New idea ');
    ed.type('zz');
    await tick();
    assert.equal(ed.rows().length, 0);
    assert.ok(ed.press('Enter'));
    await tick();
    assert.equal(ed.markdown(), 'Intro [[New idea zz]]\n');
  });

  test('Enter with nothing typed and nothing listed is an ordinary Enter', async () => {
    const ed = mount('Intro\n', () => []);
    ed.type('[[');
    await tick();
    assert.equal(ed.popup().textContent, NO_NOTES_TEXT);
    assert.equal(ed.press('Enter'), true, 'the editor still handles Enter');
    await tick();
    assert.deepEqual(ed.links(), []);
    assert.equal(ed.view.state.doc.childCount, 2, 'the paragraph split as Enter always does');
    assert.equal(ed.view.state.doc.firstChild.textContent, 'Intro[[');
  });

  test('a modified Enter is left to the editor', async () => {
    const ed = mount();
    ed.type('[[');
    await tick();
    ed.press('Enter', { shiftKey: true });
    await tick();
    assert.deepEqual(ed.links(), []);
  });
});

describe('what is inserted and saved', () => {
  test('the typed [[query becomes one link; every other byte of the file is unchanged', async () => {
    const raw = '---\ntitle: Example\n---\n# Heading\n\nFirst line here\n\nSecond *para* with `code` and text.\n\n- one\n- two\n';
    const ed = mount(raw);
    assert.equal(ed.markdown(), raw, 'the fixture round-trips as it is');
    ed.editor.commands.setTextSelection(ed.view.state.doc.firstChild.nodeSize + 1 + 'First line here'.length);
    ed.type(' [[pla');
    await tick();
    ed.press('Enter');
    await tick();
    assert.equal(ed.markdown(), raw.replace('First line here', 'First line here [[Plan]]'));
  });

  test('the insert command replaces the range with a wikilink node in one transaction', () => {
    const ed = mount('Intro [[Roa\n');
    const end = ed.view.state.doc.content.size - 1;
    let transactions = 0;
    ed.editor.on('transaction', () => { transactions += 1; });
    assert.equal(insertWikilink(ed.editor, { from: end - 5, to: end }, 'example/beta/Roadmap'), true);
    assert.equal(transactions, 1);
    const node = ed.view.state.doc.firstChild.lastChild;
    assert.equal(node.type.name, 'wikilink');
    assert.deepEqual({ ...node.attrs }, { target: 'example/beta/Roadmap', alias: null });
    assert.equal(ed.markdown(), 'Intro [[example/beta/Roadmap]]\n');
    assert.equal(ed.view.state.selection.from, ed.view.state.doc.content.size - 1, 'the cursor sits after the link');
  });

  test('the insert command refuses an empty target and changes nothing', () => {
    const ed = mount('Intro [[\n');
    const end = ed.view.state.doc.content.size - 1;
    assert.equal(insertWikilink(ed.editor, { from: end - 2, to: end }, ''), false);
    assert.equal(ed.markdown(), 'Intro [[\n');
  });

  test('names that are awkward but legal round-trip intact', async () => {
    for (const target of ['Idea (draft)', 'Release 1.5', 'Trail .md', 'Café notes', 'a & b']) {
      const ed = mount('Intro\n', () => [{ path: `${target}.md`, name: target, target }]);
      ed.type(' [[');
      await tick();
      ed.press('Enter');
      await tick();
      const saved = ed.markdown();
      assert.equal(saved, `Intro [[${target}]]\n`, target);
      const again = mount(saved, null);
      assert.deepEqual(again.links(), [target], `${target} reads back as the same link`);
    }
  });

  test('a note whose name would break the link is never listed', async () => {
    const bad = ['a]]b', 'a|b', 'a#b', 'a^b', 'a[b', 'a\nb'].map((n) => ({ path: `${n}.md`, name: n, target: n }));
    const ed = mount('Intro\n', () => [...bad, NOTES[2]]);
    ed.type('[[');
    await tick();
    assert.deepEqual(ed.names(), ['Plan']);
  });

  test('a name with markup in it is listed as text and makes no element', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const ed = mount('Intro\n', () => [{ path: `example/${hostile}.md`, name: hostile, target: hostile }]);
    ed.type('[[');
    await tick();
    assert.deepEqual(ed.names(), [hostile]);
    assert.equal(ed.popup().querySelector('img'), null);
    assert.equal(ed.popup().querySelectorAll('*').length, 3, 'a row, its name and its folder: nothing else');
  });
});

describe('two notes with the same name', () => {
  // The host's list (public/views/files.js) carries the target that opens each
  // note from the note being edited; the editor must insert exactly that.
  const tree = [
    { type: 'folder', name: 'example', path: 'example', children: [
      { type: 'folder', name: 'alpha', path: 'example/alpha', children: [
        { type: 'file', name: 'Roadmap.md', path: 'example/alpha/Roadmap.md' },
        { type: 'file', name: 'Plan.md', path: 'example/alpha/Plan.md' },
      ] },
      { type: 'folder', name: 'beta', path: 'example/beta', children: [
        { type: 'file', name: 'Roadmap.md', path: 'example/beta/Roadmap.md' },
      ] },
    ] },
  ];
  const FROM = 'example/alpha/Plan.md';

  for (const chosen of ['example/alpha/Roadmap.md', 'example/beta/Roadmap.md']) {
    test(`choosing ${chosen} inserts a link that opens it`, async () => {
      const ed = mount('Intro\n', () => wikilinkCandidates(tree, FROM));
      ed.type(' [[roadmap');
      await tick();
      const at = ed.rows().findIndex((r) => r.querySelector('.wikilink-suggest-meta').textContent === path.posix.dirname(chosen));
      assert.ok(at >= 0);
      while (ed.selectedIndex() !== at) ed.press('ArrowDown');
      ed.press('Enter');
      await tick();
      const [target] = ed.links();
      assert.equal(findFileInTree(tree, wikilinkSearchName(target), FROM), chosen);
    });
  }
});

describe('where the list never opens', () => {
  test('inside a code block', async () => {
    const ed = mount('Intro\n\n```\nlet a = 1\n```\n');
    // The end of the code block's text, not the empty paragraph after it.
    ed.editor.commands.setTextSelection(ed.view.state.doc.firstChild.nodeSize + 1 + 'let a = 1'.length);
    assert.equal(ed.view.state.selection.$from.parent.type.name, 'codeBlock');
    ed.type('[[');
    await tick();
    assert.equal(ed.popup(), null);
    assert.equal(ed.calls(), 0);
    assert.equal(ed.markdown(), 'Intro\n\n```\nlet a = 1[[\n```\n');
  });

  test('inside inline code', async () => {
    const ed = mount('Intro `ab cd` end\n');
    ed.editor.commands.setTextSelection(1 + 'Intro ab'.length);
    ed.type('[[');
    await tick();
    assert.equal(ed.popup(), null);
    assert.equal(ed.calls(), 0);
    assert.equal(ed.markdown(), 'Intro `ab[[ cd` end\n');
  });

  test('in the properties panel, which is outside the note body', async () => {
    const properties = document.createElement('div');
    document.body.appendChild(properties);
    const ed = mount('---\ntopic: Roadmap\n---\nBody\n', () => NOTES, { propertiesElement: properties, onUpdate: () => {} });
    properties.querySelector('.prop-row.editable .prop-value').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const input = properties.querySelector('input.prop-edit-input');
    assert.ok(input, 'the property is being edited');
    for (const ch of '[[Ro') {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      input.value += ch;
      input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
    }
    await tick();
    assert.equal(ed.popup(), null);
    assert.equal(ed.calls(), 0);
    properties.remove();
  });

  // A link typed or pasted whole stays as typed text while editing and is
  // saved as written, so the saved file reads back as exactly one link.
  test('[[Page]] typed in full makes exactly one link and leaves the line as typed', async () => {
    const ed = mount();
    ed.type(' see [[Plan]] today');
    await tick();
    assert.equal(ed.popup(), null, 'the closing ] closed the list');
    const saved = ed.markdown();
    assert.equal(saved, 'Intro see [[Plan]] today\n');
    assert.deepEqual(mount(saved, null).links(), ['Plan']);
  });

  test('[[Page]] pasted makes exactly one link and leaves the line as it was', async () => {
    const ed = mount();
    ed.view.pasteText(' see [[Plan]] today');
    await tick();
    assert.equal(ed.popup(), null);
    assert.equal(ed.calls(), 0, 'a paste never opens the list');
    const saved = ed.markdown();
    assert.equal(saved, 'Intro see [[Plan]] today\n');
    assert.deepEqual(mount(saved, null).links(), ['Plan']);
  });
});

describe('the host is asked for the list once each time it opens', () => {
  test('typing never asks again; closing and reopening asks once more', async () => {
    const ed = mount();
    ed.type('[[');
    await tick();
    ed.type('roadm');
    await tick();
    ed.press('ArrowDown');
    ed.backspace();
    await tick();
    assert.equal(ed.calls(), 1);
    ed.press('Escape');
    await tick();
    ed.type(' [[');
    await tick();
    assert.equal(ed.calls(), 2);
  });

  test('the suggestion module touches no files, network or storage', () => {
    const src = fs.readFileSync(path.join(HERE, '..', '..', 'public', 'editor', 'plugins', 'wikilink-suggest.js'), 'utf8');
    for (const word of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'require(', 'import(', 'localStorage', 'sessionStorage', 'indexedDB', 'innerHTML', 'insertAdjacentHTML']) {
      assert.ok(!src.includes(word), `uses ${word}`);
    }
    const imports = src.split('\n').filter((line) => line.startsWith('import '));
    assert.deepEqual(imports, ["import { Suggestion, PluginKey, exitSuggestion } from '../../vendor/tiptap-bundle.mjs';"]);
  });
});

describe('sequences', () => {
  test('inverse action: Escape, or deleting back past [[, closes the list and leaves the text exactly as typed', async () => {
    const ed = mount();
    ed.type(' [[Roa');
    await tick();
    assert.ok(ed.shown());
    ed.press('Escape');
    await tick();
    assert.equal(ed.popup(), null);
    assert.equal(ed.markdown(), 'Intro [[Roa\n');

    const back = mount();
    back.type(' [[Roa');
    await tick();
    for (let i = 0; i < 4; i++) back.backspace();
    await tick();
    assert.equal(back.popup(), null);
    assert.equal(back.markdown(), 'Intro [\n');
    assert.deepEqual(back.links(), []);
  });

  test('undo: one undo after inserting puts back exactly what was typed', async () => {
    const ed = mount();
    ed.type(' [[pla');
    await tick();
    const before = ed.markdown();
    ed.press('Enter');
    await tick();
    assert.equal(ed.markdown(), 'Intro [[Plan]]\n');
    ed.editor.commands.undo();
    await tick();
    assert.equal(ed.markdown(), before);
    assert.equal(ed.popup(), null, 'undo does not reopen the list');
    ed.editor.commands.redo();
    await tick();
    assert.equal(ed.markdown(), 'Intro [[Plan]]\n');
  });

  test('retry: typing [[ again right after closing reopens it with the current list', async () => {
    let notes = NOTES.slice(0, 1);
    const ed = mount('Intro\n', () => notes);
    ed.type(' [[');
    await tick();
    assert.deepEqual(ed.names(), ['Roadmap']);
    ed.press('Escape');
    await tick();
    assert.equal(ed.popup(), null);
    notes = NOTES;
    ed.type('[[');
    await tick();
    assert.ok(ed.shown(), 'reopened');
    assert.deepEqual(ed.names(), ['Ideas', 'Plan', 'Roadmap', 'Roadmap'], 'the list is read again, not reused');
    assert.equal(ed.calls(), 2);
  });

  test('most common next step: saved, closed and reopened, the link is still there and opens the chosen note', async () => {
    const tree = [{ type: 'folder', name: 'example', path: 'example', children: [
      { type: 'file', name: 'Plan.md', path: 'example/Plan.md' },
      { type: 'folder', name: 'beta', path: 'example/beta', children: [{ type: 'file', name: 'Plan.md', path: 'example/beta/Plan.md' }] },
    ] }];
    const from = 'example/Notes.md';
    const ed = mount('Intro\n', () => wikilinkCandidates(tree, from));
    ed.type(' [[plan');
    await tick();
    ed.press('ArrowDown');
    ed.press('Enter');
    await tick();
    const saved = ed.markdown();
    assert.equal(saved, 'Intro [[example/beta/Plan]]\n');
    mounted.pop()();

    const clicked = [];
    const reopened = mount(saved, null, { onWikilinkClick: (target) => clicked.push(target) });
    assert.equal(reopened.markdown(), saved);
    reopened.element.querySelector('a.wikilink').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    assert.equal(clicked.length, 1);
    assert.equal(findFileInTree(tree, wikilinkSearchName(clicked[0]), from), 'example/beta/Plan.md');
  });

  test('control failing: a list that throws, rejects or never answers leaves typing and Enter working', async () => {
    const failures = {
      throws: () => { throw new Error('list failed'); },
      rejects: () => Promise.reject(new Error('list failed')),
      'never answers': () => new Promise(() => {}),
      'answers with junk': () => Promise.resolve({ not: 'a list' }),
    };
    for (const [name, list] of Object.entries(failures)) {
      await nothingThrows(async () => {
        const ed = mount('Intro\n', list);
        ed.type(' [[');
        await tick();
        if (ed.popup()) {
          assert.ok(ed.popup().hidden || ed.popup().textContent === NO_NOTES_TEXT, `${name}: empty or says so`);
        }
        assert.equal(ed.rows().length, 0, name);
        ed.type('Fresh note');
        await tick();
        assert.ok(ed.press('Enter'), `${name}: Enter finishes the link`);
        await tick();
        assert.equal(ed.markdown(), 'Intro [[Fresh note]]\n', name);
        assert.equal(ed.calls(), 1, name);
      });
    }
  });

  test('a list that answers after the list has closed changes nothing', async () => {
    let answer;
    const ed = mount('Intro\n', () => new Promise((resolve) => { answer = resolve; }));
    ed.type('[[');
    await tick();
    ed.press('Escape');
    await tick();
    answer(NOTES);
    await tick();
    assert.equal(ed.popup(), null);
    assert.equal(wikilinkSuggestKey.getState(ed.view.state).active, false);
  });

  test('a list that answers late fills the open list', async () => {
    let answer;
    const ed = mount('Intro\n', () => new Promise((resolve) => { answer = resolve; }));
    ed.type('[[pl');
    await tick();
    assert.ok(!ed.shown(), 'nothing to show yet');
    answer(NOTES);
    await tick();
    assert.ok(ed.shown());
    assert.deepEqual(ed.names(), ['Plan']);
  });
});
