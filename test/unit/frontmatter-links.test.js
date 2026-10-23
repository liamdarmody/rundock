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

await bootEditorEnv();

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
    const { extractLinks } = createRequire(import.meta.url)('../../lib/links.js');
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

  test('a nested list that is not one link, or a quoted value, is left alone', () => {
    assert.equal(unquoted('pair'), null);
    assert.equal(unquoted('quoted'), null);
    assert.equal(unquotedLinkText([['X']], undefined), null, 'no raw text, no guess');
    assert.equal(unquotedLinkText('[[X]]', '[[X]]'), null, 'a parsed string is not the nested shape');
  });

  test('rawValueText answers null for a key that is not there', () => {
    assert.equal(rawValueText(raw, 'absent'), null);
    assert.equal(rawValueText(null, 'plain'), null);
  });
});
