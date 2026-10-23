'use strict';
// Where a note created from a link to a missing note goes, and what is
// refused. A bare name goes beside the note the link was written in; a name
// with a folder in it counts from the workspace root. The created path has to
// be the path the resolver then finds for the same link, or the link would
// stay missing after the note exists. Every name here is made up.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { linkCreatePath, findFileInTree, wikilinkSearchName } = require('../../public/views/files.js');

const FROM = 'Projects/Alpha/Launch.md';

// A tree holding exactly one file, as the server's file tree shapes it.
function treeWith(filePath) {
  const parts = filePath.split('/');
  let node = { type: 'file', name: parts[parts.length - 1], path: filePath };
  for (let i = parts.length - 2; i >= 0; i--) {
    node = { type: 'folder', name: parts[i], path: parts.slice(0, i + 1).join('/'), children: [node] };
  }
  return [node];
}

describe('where a note made from a link goes', () => {
  test('a bare name goes in the folder of the note holding the link', () => {
    assert.deepStrictEqual(linkCreatePath('Roadmap', FROM), { path: 'Projects/Alpha/Roadmap.md' });
    assert.deepStrictEqual(linkCreatePath('Roadmap', 'Launch.md'), { path: 'Roadmap.md' });
    assert.deepStrictEqual(linkCreatePath('Roadmap', null), { path: 'Roadmap.md' }, 'no current note: the root');
  });

  test('a heading is not part of the name', () => {
    assert.deepStrictEqual(linkCreatePath('Roadmap#Risks', FROM), { path: 'Projects/Alpha/Roadmap.md' });
    assert.deepStrictEqual(linkCreatePath(' Roadmap #^block ', FROM), { path: 'Projects/Alpha/Roadmap.md' });
  });

  test('a name with a folder in it counts from the workspace root', () => {
    assert.deepStrictEqual(linkCreatePath('Archive/Old plan', FROM), { path: 'Archive/Old plan.md' });
    assert.deepStrictEqual(linkCreatePath('Archive/2024/Q3 notes.md', FROM), { path: 'Archive/2024/Q3 notes.md' });
  });

  test('a dot in a name is not taken for an extension', () => {
    assert.deepStrictEqual(linkCreatePath('Release 1.5', FROM), { path: 'Projects/Alpha/Release 1.5.md' });
  });

  test('the created note is the one the same link then resolves to', () => {
    for (const target of ['Roadmap', 'Roadmap#Risks', 'Archive/Old plan', 'Notes/Plan.md', 'Release 1.5']) {
      const { path } = linkCreatePath(target, FROM);
      assert.strictEqual(findFileInTree(treeWith(path), wikilinkSearchName(target), FROM), path, target);
    }
  });
});

describe('what a link cannot create, said in plain words', () => {
  const refused = (target) => {
    const r = linkCreatePath(target, FROM);
    assert.ok(!('path' in r), `${target} must not produce a path, got ${r.path}`);
    assert.match(r.refusal, /^[A-Z][^]*\.$/, `${target}: a sentence, not a code`);
    return r.refusal;
  };

  test('a character a file name cannot hold', () => {
    for (const ch of [':', '*', '?', '"', '<', '>', '|', '\\']) {
      assert.match(refused(`Q3${ch} plan`), /cannot contain/, ch);
    }
  });

  test('anything that leaves the workspace or its own folder', () => {
    for (const target of ['../elsewhere', 'Archive/../../elsewhere', '..', '.', 'a/./b']) {
      assert.match(refused(target), /outside this workspace/, target);
    }
  });

  test('a hidden name, an empty folder name, or no name at all', () => {
    assert.match(refused('.hidden'), /start with a dot/);
    assert.match(refused('Archive/.drafts/x'), /start with a dot/);
    assert.match(refused('Archive//x'), /no name/);
    assert.match(refused('/Roadmap'), /no name/);
    assert.match(refused('#Risks'), /no note name/);
    assert.match(refused('   '), /no note name/);
  });

  test('a file that is not a note', () => {
    for (const target of ['chart.png', 'report.pdf', 'data.json', 'page.html', 'draft.mdx']) {
      assert.match(refused(target), /Only notes/, target);
    }
  });

  test('no input of any shape yields a path outside the workspace', () => {
    for (const target of ['../x', '..\\x', '/etc/x', 'a/../../x', '~/x', 'C:\\x', '\\\\server\\x']) {
      const r = linkCreatePath(target, FROM);
      if (r.path) {
        assert.ok(!r.path.startsWith('/') && !r.path.split('/').includes('..'), `${target} -> ${r.path}`);
      }
    }
  });
});
