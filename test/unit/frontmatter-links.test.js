// Links in frontmatter values: which text is a link, read the way the Map
// reads it (lib/links.js), from values YAML has already parsed. Every name and
// note here is made up.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { bootEditorEnv } from '../helpers/editor-harness.js';
import { linkSegments, wholeLink, unquotedLinkText } from '../../public/editor/markdown/prop-links.js';
import { rawValueText } from '../../public/editor/markdown/frontmatter-edit.js';
import { extractFrontmatter } from '../../public/editor/markdown/frontmatter.js';

const env = await bootEditorEnv();
const { extractLinks } = createRequire(import.meta.url)('../../lib/links.js');

const links = (text) => linkSegments(text).filter((s) => s.link).map((s) => s.link);

const UNQUOTED = [
  '---',
  'plain: [[Launch checklist]]',
  'aliased: [[Style guide|house style]]',
  'heading: [[Plan#Risks]]',
  'year: [[2024]]',
  'comma: [[One, Two]]',
  'commented: [[Brief]] # kept for later',
  'list:',
  '  - [[Alpha]]',
  '  - "[[Beta]]"',
  'pair: [[a], [b]]',
  'quoted: "[[Gamma]]"',
  '---',
  '',
].join('\n');

describe('links inside a text value', () => {
  test('several links with words between them are each a link, and the words stay words', () => {
    const value = '[[Plan]] section 4, [[Templates]] W4 and W5, [[Log]]';
    const segs = linkSegments(value);
    assert.deepEqual(segs.map((s) => s.text), ['[[Plan]]', ' section 4, ', '[[Templates]]', ' W4 and W5, ', '[[Log]]']);
    assert.deepEqual(links(value).map((l) => l.target), ['Plan', 'Templates', 'Log']);
    assert.equal(segs.map((s) => s.text).join(''), value, 'the runs join back to the value exactly');
  });

  test('a link inside a sentence is a link', () => {
    assert.deepEqual(links('Complete. See [[Field notes]].'), [{ target: 'Field notes', alias: null }]);
  });

  test('an alias is display only, and a heading stays on the target', () => {
    assert.deepEqual(links('[[Style guide|house style]]'), [{ target: 'Style guide', alias: 'house style' }]);
    assert.deepEqual(links('[[Plan#Risks]]'), [{ target: 'Plan#Risks', alias: null }]);
    assert.deepEqual(links('[[Plan#Risks|the risks]]'), [{ target: 'Plan#Risks', alias: 'the risks' }]);
  });

  test('an embed and a link inside code are not links, as the Map does not count them', () => {
    assert.deepEqual(links('![[diagram.png]] and `[[Not a link]]`'), []);
    assert.equal(linkSegments('![[diagram.png]] and `[[Not a link]]`').map((s) => s.text).join(''), '![[diagram.png]] and `[[Not a link]]`');
  });

  test('an empty or blank target is not a link', () => {
    assert.deepEqual(links('[[]] and [[   ]]'), []);
  });

  test('the grammar is the Map\'s: the same text gives the same targets', () => {
    for (const text of [
      '[[Plan]] section 4, [[Templates]] W4 and W5, [[Log]]',
      'See [[A|one|two]], [[B|]] and [[ C ]]', '[[x]y]] [[ok]]', '![[e.png]] [[f]] `[[g]]`',
      '[[Plan#Risks|risks]] then [[Q3: plan]]', '[[a\nb]] [[c]]',
    ]) {
      const map = extractLinks(text).filter((l) => l.kind === 'wikilink').map((l) => l.target);
      assert.deepEqual(links(text).map((l) => l.target), map, text);
    }
  });

  test('wholeLink is a value that is one link and nothing else', () => {
    assert.deepEqual(wholeLink('  [[Brief|the brief]] '), { target: 'Brief', alias: 'the brief' });
    assert.equal(wholeLink('see [[Brief]]'), null);
    assert.equal(wholeLink(42), null);
  });
});

describe('an unquoted [[X]], which YAML reads as a nested list', () => {
  const { raw, parsed } = extractFrontmatter(UNQUOTED);
  const unquoted = (key) => unquotedLinkText(parsed[key], rawValueText(raw, key).inline);

  test('is read back as the link that was written', () => {
    assert.deepEqual(parsed.plain, [['Launch checklist']], 'the shape YAML gives it');
    assert.equal(unquoted('plain'), '[[Launch checklist]]');
    assert.equal(unquoted('aliased'), '[[Style guide|house style]]');
    assert.equal(unquoted('heading'), '[[Plan#Risks]]');
  });

  test('keeps the name YAML would have changed: a number, a comma', () => {
    assert.deepEqual(parsed.year, [[2024]], 'YAML makes the name a number');
    assert.equal(unquoted('year'), '[[2024]]');
    assert.deepEqual(parsed.comma, [['One', 'Two']], 'YAML splits the name in two');
    assert.equal(unquoted('comma'), '[[One, Two]]');
  });

  test('a trailing comment is not part of the link', () => {
    assert.equal(unquoted('commented'), '[[Brief]]');
  });

  test('an unquoted list item is read from its own line', () => {
    const items = rawValueText(raw, 'list').items;
    assert.deepEqual(items, ['[[Alpha]]', '"[[Beta]]"']);
    assert.equal(unquotedLinkText(parsed.list[0], items[0]), '[[Alpha]]');
    assert.equal(unquotedLinkText(parsed.list[1], items[1]), null, 'a quoted item is a string, read as one');
  });

  test('only the list\'s own items count, not the dashes inside a nested list or a block of text', () => {
    const src = [
      '---',
      'related:',
      '  - [[Alpha]]',
      '  - - nested',
      '    - list',
      '  - |',
      '    - not an item',
      '  - [[Beta]]',
      '---',
      '',
    ].join('\n');
    const fm = extractFrontmatter(src);
    assert.equal(fm.parsed.related.length, 4, 'YAML reads four items');
    assert.deepEqual(rawValueText(fm.raw, 'related').items, ['[[Alpha]]', '- nested', '|', '[[Beta]]']);
  });

  test('a nested list that is not one link, or a quoted value, is left alone', () => {
    assert.equal(unquoted('pair'), null);
    assert.equal(unquoted('quoted'), null);
    assert.equal(unquotedLinkText([['X']], undefined), null, 'no raw text, no guess');
    assert.equal(unquotedLinkText('[[X]]', '[[X]]'), null, 'a parsed string is not the nested shape');
  });

  test('the text is read as a link only when the parse has the shape that text gives', () => {
    // Text and parse that do not belong together (a misread line) are never
    // trusted: the parse must be exactly one list holding one list.
    assert.equal(unquotedLinkText(['X'], '[[X]]'), null, 'a flat list');
    assert.equal(unquotedLinkText([['A'], ['B']], '[[A]]'), null, 'two lists');
    assert.equal(unquotedLinkText([], '[[A]]'), null, 'an empty list');
    assert.equal(unquotedLinkText([['A']], '[[A]] and more'), null, 'words after the link');
    assert.equal(unquotedLinkText([['A']], '[[A]] [[B]]'), null, 'a second link');
  });

  test('rawValueText answers null for a key that is not there', () => {
    assert.equal(rawValueText(raw, 'absent'), null);
    assert.equal(rawValueText(null, 'plain'), null);
  });
});

// ── The properties panel, through the real editor ──────────────────────────
const NOTE = [
  '---',
  'status: Draft, reviewed Monday',
  'builds-on: "[[Plan]] section 4, [[Templates]] W4 and W5, [[Log]]"',
  'supersedes: [[Launch checklist]]',
  'related:',
  '  - "[[Brief]]"',
  '  - "[[Style guide|house style]]"',
  '  - [[Plan#Risks]]',
  'depends-on: "[[Roadmap]]"',
  'see-also: "See [[Plan]], and [[Old plan]] once it is written"',
  '---',
  '',
  'Body text.',
  '',
].join('\n');
const EXISTING = new Set(['Plan', 'Templates', 'Log', 'Launch checklist', 'Brief', 'Style guide']);
const exists = (target) => EXISTING.has(target.split('#')[0]);

function mount(src, extra = {}) {
  const doc = env.window.document;
  const props = doc.createElement('div');
  const element = doc.createElement('div');
  doc.body.append(props, element);
  const opened = [];
  const { editor } = env.createEditor({
    element, rawMarkdown: src, propertiesElement: props,
    onWikilinkClick: (t) => opened.push(t), resolveWikilink: exists, ...extra,
  });
  const row = (key) => props.querySelector(`.prop-row[data-prop-key="${key}"]`);
  const click = (el) => el.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true }));
  const key = (el, k) => el.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
  const done = () => { env.destroyEditor(editor); props.remove(); element.remove(); };
  return { doc, editor, element, props, opened, row, click, key, done, markdown: () => env.getMarkdown(editor) };
}

describe('the properties panel shows links inside values', () => {
  test('every link in a text value is a link, and the words between stay words', () => {
    const p = mount(NOTE);
    try {
      const row = p.row('builds-on');
      assert.deepEqual([...row.querySelectorAll('a.prop-wikilink')].map((a) => a.textContent), ['Plan', 'Templates', 'Log']);
      assert.equal(row.querySelector('.prop-value').textContent, 'Plan section 4, Templates W4 and W5, Log');
      assert.deepEqual([...p.row('see-also').querySelectorAll('a')].map((a) => [a.textContent, a.classList.contains('dead')]),
        [['Plan', false], ['Old plan', true]], 'a missing link sits among live ones, marked');
    } finally { p.done(); }
  });

  test('the words and a link\'s alias are escaped, so markup in a value is text', () => {
    const p = mount('---\nnote: "<img src=x onerror=boom()> and [[Plan|<b>the plan</b>]]"\n---\n');
    try {
      const row = p.row('note');
      assert.equal(row.querySelector('img'), null, 'no element is made from the words');
      assert.equal(row.querySelector('b'), null, 'no element is made from the alias');
      assert.equal(row.querySelector('.prop-value').textContent, '<img src=x onerror=boom()> and <b>the plan</b>');
    } finally { p.done(); }
  });

  test('the links the panel draws are the links the Map counts', () => {
    const p = mount(NOTE);
    try {
      const drawn = [...p.props.querySelectorAll('a.prop-wikilink')].map((a) => a.getAttribute('data-target'));
      const counted = extractLinks(extractFrontmatter(NOTE).raw).filter((l) => l.kind === 'wikilink').map((l) => l.target);
      assert.deepEqual(drawn, counted);
    } finally { p.done(); }
  });

  test('an unquoted link in a list that also holds a nested list or a block of text is a link', () => {
    const src = '---\nrelated:\n  - [[Brief]]\n  - - nested\n    - list\n  - |\n    - not an item\n  - [[Plan]]\n---\n';
    const p = mount(src);
    try {
      assert.deepEqual([...p.row('related').querySelectorAll('a.prop-wikilink')].map((a) => a.getAttribute('data-target')),
        ['Brief', 'Plan']);
      assert.equal(p.markdown(), src);
    } finally { p.done(); }
  });

  test('the links the Map counts and the panel does not are exactly the ones written down', () => {
    // The list in public/editor/markdown/prop-links.js, one line each.
    const src = [
      '---',
      '# see [[In a comment]]',
      'title: Kept # and [[After a value]]',
      '"[[In a key]]": x',
      'nested:',
      '  child: "[[In a nested object]]"',
      'flow: [[[In a flow list]]]',
      '"quoted key": [[Under a quoted key]]',
      'source: "[the brief](Brief.md)"',
      '---',
      '',
    ].join('\n');
    const counted = extractLinks(extractFrontmatter(src).raw).filter((l) => l.kind !== 'embed').map((l) => l.target);
    assert.deepEqual(counted, ['In a comment', 'After a value', 'In a key', 'In a nested object', 'In a flow list',
      'Under a quoted key', 'Brief.md']);
    const p = mount(src);
    try {
      assert.equal(p.props.querySelectorAll('a').length, 0, 'the panel draws none of them');
      assert.equal(p.markdown(), src, 'and leaves every one as written');
    } finally { p.done(); }

    const unparsable = '---\nbad: [unclosed\nref: "[[Plan]]"\n---\n';
    assert.deepEqual(extractLinks(unparsable).map((l) => l.target), ['Plan']);
    const q = mount(unparsable);
    try {
      assert.equal(q.props.querySelectorAll('a').length, 0, 'frontmatter that cannot parse shows nothing');
    } finally { q.done(); }
  });

  test('an alias shows its words, a heading stays on the target, an unquoted item is a link', () => {
    const p = mount(NOTE);
    try {
      const related = [...p.row('related').querySelectorAll('a.prop-wikilink')];
      assert.deepEqual(related.map((a) => [a.textContent, a.getAttribute('data-target')]),
        [['Brief', 'Brief'], ['house style', 'Style guide'], ['Plan#Risks', 'Plan#Risks']]);
      assert.ok(p.row('depends-on').querySelector('a.prop-wikilink.dead'), 'a missing whole-value link is marked');
    } finally { p.done(); }
  });

  test('an unquoted link renders as a link, and the file is left byte for byte', () => {
    const p = mount(NOTE);
    try {
      const row = p.row('supersedes');
      assert.equal(row.getAttribute('data-prop-type'), 'string', 'a text value, not a nested list');
      assert.equal(row.querySelector('a.prop-wikilink').getAttribute('data-target'), 'Launch checklist');
      p.click(row.querySelector('.prop-wikilink-edit'));
      const input = row.querySelector('input.prop-edit-input');
      assert.equal(input.value, '[[Launch checklist]]', 'the editor shows the link as written');
      p.key(input, 'Escape');
      assert.equal(p.markdown(), NOTE);
    } finally { p.done(); }
  });
});

describe('editing a value with links in it', () => {
  test('clicking a link opens it and does not start an edit', () => {
    const p = mount(NOTE);
    try {
      const row = p.row('builds-on');
      p.click(row.querySelectorAll('a.prop-wikilink')[1]);
      assert.deepEqual(p.opened, ['Templates']);
      assert.equal(row.querySelector('input'), null);
    } finally { p.done(); }
  });

  test('clicking the words opens the raw text with the caret where the click landed', () => {
    const p = mount(NOTE);
    try {
      const row = p.row('builds-on');
      const words = row.querySelectorAll('.prop-text')[1]; // " W4 and W5, "
      const range = p.doc.createRange();
      range.setStart(words.firstChild, 3);
      const sel = p.doc.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      p.click(words);
      const input = row.querySelector('input.prop-edit-input');
      assert.equal(input.value, '[[Plan]] section 4, [[Templates]] W4 and W5, [[Log]]');
      const at = '[[Plan]] section 4, [[Templates]] W4'.length;
      assert.deepEqual([input.selectionStart, input.selectionEnd], [at, at]);
      assert.deepEqual(p.opened, []);
    } finally { p.done(); }
  });

  test('an edit changes only the bytes that were typed', () => {
    const p = mount(NOTE);
    try {
      const row = p.row('builds-on');
      p.click(row.querySelector('.prop-text'));
      const input = row.querySelector('input.prop-edit-input');
      input.value = input.value.replace('W4 and W5', 'W4 to W6');
      p.key(input, 'Enter');
      assert.equal(p.markdown(), NOTE.replace('W4 and W5', 'W4 to W6'));
    } finally { p.done(); }
  });

  test('an unquoted link that is edited is written as a quoted value', () => {
    const p = mount(NOTE);
    try {
      const row = p.row('supersedes');
      p.click(row.querySelector('.prop-wikilink-edit'));
      const input = row.querySelector('input.prop-edit-input');
      input.value = '[[Launch list]]';
      p.key(input, 'Enter');
      assert.equal(p.markdown(), NOTE.replace('supersedes: [[Launch checklist]]', 'supersedes: "[[Launch list]]"'));
    } finally { p.done(); }
  });

  test('clicking a link to a missing note asks the host to create it, and opens nothing', () => {
    const created = [];
    const p = mount(NOTE, { onCreateWikilink: (t) => created.push(t) });
    try {
      p.click(p.row('see-also').querySelector('a.dead'));
      assert.deepEqual(created, ['Old plan']);
      assert.deepEqual(p.opened, []);
      assert.equal(p.row('see-also').querySelector('input'), null, 'no edit starts either');
    } finally { p.done(); }
  });

  test('a value the file cannot take an edit to offers none, and says why', () => {
    // The edit is refused for a value with a comment beside it (the comment
    // could not be kept), so the panel must not offer one that snaps back.
    const src = '---\nsupersedes: [[Brief]] # kept for later\ntitle: Hello # draft\nplain: Hello\n---\n';
    const p = mount(src);
    try {
      for (const key of ['supersedes', 'title']) {
        const row = p.row(key);
        assert.ok(!row.classList.contains('editable'), `${key}: not offered for editing`);
        assert.equal(row.querySelector('.prop-wikilink-edit'), null, `${key}: no pencil`);
        assert.match(row.getAttribute('title'), /comment beside it/, `${key}: says why`);
        p.click(row.querySelector('.prop-value'));
        assert.equal(row.querySelector('input'), null, `${key}: a click opens no editor`);
      }
      p.click(p.row('supersedes').querySelector('a.prop-wikilink'));
      assert.deepEqual(p.opened, ['Brief'], 'the link still opens');
      assert.ok(p.row('plain').classList.contains('editable'), 'a value without a comment still edits');
      assert.equal(p.markdown(), src);
    } finally { p.done(); }
  });

  test('every value holding a link has the pencil', () => {
    const p = mount(NOTE);
    try {
      for (const key of ['builds-on', 'supersedes', 'depends-on', 'see-also']) {
        assert.ok(p.row(key).querySelector('.prop-wikilink-edit'), key);
      }
      assert.equal(p.row('status').querySelector('.prop-wikilink-edit'), null, 'plain text needs none');
    } finally { p.done(); }
  });
});

describe('links in the note body behave the same way', () => {
  const BODY = 'The launch follows the [[Plan]]. Open questions live in [[Old plan|the old plan]].\n';
  const bodyLinks = (p) => [...p.element.querySelectorAll('a.wikilink')]
    .map((a) => [a.getAttribute('data-target'), a.classList.contains('dead')]);

  test('a link to a missing note is marked, and the file is unchanged', () => {
    const p = mount(BODY);
    try {
      assert.deepEqual(bodyLinks(p), [['Plan', false], ['Old plan', true]]);
      assert.equal(p.markdown(), BODY, 'the mark is a decoration, never content');
    } finally { p.done(); }
  });

  test('clicking it creates the note; clicking a found one opens it', () => {
    const created = [];
    const p = mount(BODY, { onCreateWikilink: (t) => created.push(t) });
    try {
      for (const a of p.element.querySelectorAll('a.wikilink')) p.click(a);
      assert.deepEqual(p.opened, ['Plan']);
      assert.deepEqual(created, ['Old plan']);
    } finally { p.done(); }
  });

  test('a link added while editing is marked as soon as it is there', () => {
    const p = mount(BODY);
    try {
      p.editor.commands.insertContentAt(1, [{ type: 'wikilink', attrs: { target: 'Ghost' } }, { type: 'text', text: ' ' }]);
      assert.deepEqual(bodyLinks(p)[0], ['Ghost', true]);
    } finally { p.done(); }
  });
});

describe('a link to a heading in the same note is never missing', () => {
  // Through the host's own resolver, the one the Files view hands the editor.
  const { wikilinkResolves } = createRequire(import.meta.url)('../../public/views/files.js');
  const TREE = [{ type: 'folder', name: 'notes', path: 'notes', children: [
    { type: 'file', name: 'Launch.md', path: 'notes/Launch.md' },
  ] }];
  const resolve = (t) => wikilinkResolves(TREE, t, 'notes/Launch.md');
  const src = '---\nsee: "[[#Risks]] and [[#^block|that line]]"\n---\n\nThe [[#Risks]] are below, unlike [[Ghost]].\n';

  test('in the properties panel', () => {
    const created = [];
    const p = mount(src, { resolveWikilink: resolve, onCreateWikilink: (t) => created.push(t) });
    try {
      const anchors = [...p.row('see').querySelectorAll('a.prop-wikilink')];
      assert.deepEqual(anchors.map((a) => [a.getAttribute('data-target'), a.classList.contains('dead')]),
        [['#Risks', false], ['#^block', false]]);
      p.click(anchors[0]);
      assert.deepEqual(created, [], 'a click creates nothing');
    } finally { p.done(); }
  });

  test('in the note body', () => {
    const created = [];
    const p = mount(src, { resolveWikilink: resolve, onCreateWikilink: (t) => created.push(t) });
    try {
      assert.deepEqual([...p.element.querySelectorAll('a.wikilink')].map((a) => [a.getAttribute('data-target'), a.classList.contains('dead')]),
        [['#Risks', false], ['Ghost', true]]);
      p.click(p.element.querySelector('a.wikilink'));
      assert.deepEqual(created, [], 'a click creates nothing');
    } finally { p.done(); }
  });
});
