'use strict';
// Floating toolbar pure logic: the "Text" block-type dropdown's command
// dispatch, active-block detection (which drives the dropdown label), and the
// rendered markup. The DOM menu open/close and positioning are covered by e2e.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderToolbarHTML, applyCommand, applyLink, activeBlockType } from '../../public/editor/panels/floating-toolbar.js';

// A mock editor whose chain records each command call in order, so we can
// assert exactly which Tiptap commands a toolbar action dispatches without a
// real ProseMirror instance.
function mockEditor(active = {}) {
  const calls = [];
  const chain = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'run') return () => { calls.push('run'); return true; };
      return (...args) => {
        calls.push(args.length ? `${String(prop)}(${JSON.stringify(args[0])})` : String(prop));
        return chain;
      };
    },
  });
  return {
    calls,
    chain: () => chain,
    isActive: (name, attrs) => !!active[attrs ? `${name}:${JSON.stringify(attrs)}` : name],
    getAttributes: () => ({}),
  };
}

describe('floating toolbar markup', () => {
  test('the full toolbar renders a block-type dropdown with every block type, and no inline heading buttons', () => {
    const html = renderToolbarHTML(false);
    assert.match(html, /class="tb-dd"/, 'has the dropdown trigger');
    for (const cmd of ['paragraph', 'h1', 'h2', 'h3', 'bulletList', 'orderedList', 'taskList']) {
      assert.match(html, new RegExp(`data-cmd="${cmd}"`), `dropdown menu has ${cmd}`);
    }
    for (const cmd of ['bold', 'italic', 'code', 'link']) {
      assert.match(html, new RegExp(`data-cmd="${cmd}"`), `inline mark ${cmd} remains`);
    }
    // Headings moved into the dropdown, so no inline .tb-btn heading buttons.
    assert.doesNotMatch(html, /class="tb-btn"[^>]*data-cmd="h1"/, 'no inline H1 button');
  });

  test('a reduced toolbar (board cards: buttonIds set) has no dropdown, only the chosen inline marks', () => {
    const html = renderToolbarHTML(false, ['bold', 'italic', 'code', 'link']);
    assert.doesNotMatch(html, /class="tb-dd"/, 'no dropdown on the reduced toolbar');
    assert.doesNotMatch(html, /data-cmd="bulletList"/, 'no block types on the reduced toolbar');
    assert.match(html, /data-cmd="bold"/);
  });

  test('the comment bar appears only when review is enabled', () => {
    assert.doesNotMatch(renderToolbarHTML(false), /data-cmd="comment"/);
    assert.match(renderToolbarHTML(true), /data-cmd="comment"/);
  });

  test('the link popover is rendered whenever a link button is present, and omitted otherwise', () => {
    // Full toolbar carries a link mark -> in-UI popover markup is present.
    const full = renderToolbarHTML(false);
    assert.match(full, /class="tb-linkpop"/, 'full toolbar has the link popover');
    assert.match(full, /class="tb-link-input"/, 'popover has an input');
    assert.match(full, /class="tb-link-apply"/, 'popover has an apply control');
    assert.match(full, /class="tb-link-unlink"/, 'popover has an unlink control');

    // A reduced toolbar without a link button omits the popover entirely.
    const noLink = renderToolbarHTML(false, ['bold', 'italic']);
    assert.doesNotMatch(noLink, /class="tb-linkpop"/, 'no popover without a link button');

    // A reduced toolbar that keeps the link button keeps the popover.
    assert.match(renderToolbarHTML(false, ['bold', 'link']), /class="tb-linkpop"/);
  });
});

describe('applyCommand dispatch', () => {
  const cases = [
    ['bold', 'toggleBold'],
    ['italic', 'toggleItalic'],
    ['code', 'toggleCode'],
    ['h1', 'toggleHeading({"level":1})'],
    ['h2', 'toggleHeading({"level":2})'],
    ['h3', 'toggleHeading({"level":3})'],
    ['bulletList', 'toggleBulletList'],
    ['orderedList', 'toggleOrderedList'],
    ['taskList', 'toggleTaskList'],
  ];
  for (const [id, expected] of cases) {
    test(`${id} dispatches ${expected} and runs`, () => {
      const ed = mockEditor();
      applyCommand(ed, id);
      assert.ok(ed.calls.includes(expected), `expected ${expected} in ${JSON.stringify(ed.calls)}`);
      assert.equal(ed.calls.at(-1), 'run', 'the chain is run');
    });
  }

  test('paragraph on a plain block sets a paragraph', () => {
    const ed = mockEditor();
    applyCommand(ed, 'paragraph');
    assert.ok(ed.calls.includes('setParagraph'));
    assert.equal(ed.calls.at(-1), 'run');
  });

  test('paragraph inside a list unwraps that list first, then sets a paragraph', () => {
    for (const [listName, toggle] of [['bulletList', 'toggleBulletList'], ['orderedList', 'toggleOrderedList'], ['taskList', 'toggleTaskList']]) {
      const ed = mockEditor({ [listName]: true });
      applyCommand(ed, 'paragraph');
      assert.ok(ed.calls.includes(toggle), `${listName}: unwraps via ${toggle}`);
      assert.ok(ed.calls.includes('setParagraph'), `${listName}: then sets a paragraph`);
    }
  });

  test('a null editor is a no-op', () => {
    assert.doesNotThrow(() => applyCommand(null, 'bold'));
  });

  test('link is not handled by applyCommand (it goes through the popover/applyLink)', () => {
    const ed = mockEditor();
    applyCommand(ed, 'link');
    // The link case is a no-op: no link command dispatched and the chain never runs.
    assert.ok(!ed.calls.some((c) => c.startsWith('setLink(')), 'no setLink');
    assert.ok(!ed.calls.includes('unsetLink'), 'no unsetLink');
    assert.ok(!ed.calls.includes('run'), 'the chain is never run');
  });
});

describe('applyLink', () => {
  test('sets a link, extending over the whole existing link range, and normalises a bare domain', () => {
    const ed = mockEditor();
    applyLink(ed, 'rundock.ai');
    assert.ok(ed.calls.includes('extendMarkRange("link")'), 'extends the link range');
    const setCall = ed.calls.find((c) => c.startsWith('setLink('));
    assert.ok(setCall, 'calls setLink');
    assert.match(setCall, /https:\/\/rundock\.ai/, 'bare domain normalised to https');
    assert.match(setCall, /noopener noreferrer/, 'sets a safe rel');
    assert.equal(ed.calls.at(-1), 'run');
  });

  test('leaves an explicit protocol untouched', () => {
    const ed = mockEditor();
    applyLink(ed, 'mailto:hi@rundock.ai');
    const setCall = ed.calls.find((c) => c.startsWith('setLink('));
    assert.match(setCall, /mailto:hi@rundock\.ai/);
  });

  test('an empty or whitespace URL unsets the link', () => {
    for (const val of ['', '   ', null, undefined]) {
      const ed = mockEditor();
      applyLink(ed, val);
      assert.ok(ed.calls.includes('unsetLink'), `"${val}" removes the link`);
      assert.ok(!ed.calls.some((c) => c.startsWith('setLink(')), 'never sets a link');
      assert.equal(ed.calls.at(-1), 'run');
    }
  });

  test('a null editor is a no-op', () => {
    assert.doesNotThrow(() => applyLink(null, 'rundock.ai'));
  });
});

describe('activeBlockType (drives the dropdown label)', () => {
  test('a plain paragraph is "paragraph"', () => {
    assert.equal(activeBlockType(mockEditor()), 'paragraph');
  });
  test('headings map to h1/h2/h3', () => {
    assert.equal(activeBlockType(mockEditor({ 'heading:{"level":1}': true })), 'h1');
    assert.equal(activeBlockType(mockEditor({ 'heading:{"level":2}': true })), 'h2');
    assert.equal(activeBlockType(mockEditor({ 'heading:{"level":3}': true })), 'h3');
  });
  test('lists map to their type and take priority over the inner paragraph', () => {
    assert.equal(activeBlockType(mockEditor({ bulletList: true })), 'bulletList');
    assert.equal(activeBlockType(mockEditor({ orderedList: true })), 'orderedList');
    assert.equal(activeBlockType(mockEditor({ taskList: true })), 'taskList');
  });
});
