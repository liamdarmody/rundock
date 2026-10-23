'use strict';
// Where a note created from a link to a missing note goes, and what is
// refused. A bare name goes beside the note the link was written in; a name
// with a folder in it counts from the workspace root. The created path has to
// be the path the resolver then finds for the same link, or the link would
// stay missing after the note exists. Every name here is made up.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

const {
  linkCreatePath, findFileInTree, wikilinkSearchName, createNoteFromLink, settleLinkCreate, wikilinkResolves,
} = require('../../public/views/files.js');

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

describe('which links are missing, by the resolver the editor is handed', () => {
  test('a heading in the same note, a found note and an unloaded tree are never missing', () => {
    const tree = treeWith('Projects/Alpha/Plan.md');
    assert.strictEqual(wikilinkResolves(tree, '#Risks', FROM), true, 'a heading in this note');
    assert.strictEqual(wikilinkResolves(tree, ' #^block ', FROM), true, 'a block in this note');
    assert.strictEqual(wikilinkResolves(tree, 'Plan#Risks', FROM), true, 'a heading in a note that exists');
    assert.strictEqual(wikilinkResolves(null, 'Anything', FROM), true, 'no tree yet: never flagged');
    assert.strictEqual(wikilinkResolves(tree, 'Roadmap', FROM), false, 'a note that does not exist');
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

// The click itself, in the app-owned globals files.js reads at call time.
function shell() {
  const dom = new JSDOM('<!doctype html><body></body>');
  const sent = [];
  const stubs = {
    window: dom.window, document: dom.window.document,
    WebSocket: { OPEN: 1 },
    ws: { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) },
    currentFilePath: FROM, editorReturnView: 'editor', fileHistory: [],
    enteredFromFiles: () => {}, switchNav: () => {}, showView: () => {},
  };
  for (const [k, v] of Object.entries(stubs)) global[k] = v;
  const notice = () => dom.window.document.querySelector('.link-notice');
  const cleanup = () => { for (const k of Object.keys(stubs)) delete global[k]; dom.window.close(); };
  return { sent, notice, cleanup };
}

describe('creating the note from a click', () => {
  test('one click sends one create, and a second click while it is on its way sends nothing', () => {
    const { sent, cleanup } = shell();
    try {
      createNoteFromLink('Roadmap');
      createNoteFromLink('Roadmap');
      assert.deepStrictEqual(sent, [{ type: 'create_path', kind: 'note', path: 'Projects/Alpha/Roadmap.md', content: '' }]);
    } finally { settleLinkCreate({ type: 'create_error', path: 'Projects/Alpha/Roadmap.md', reason: 'x' }); cleanup(); }
  });

  test('when it is made, it opens at once with a short notice naming where it went', () => {
    const { sent, notice, cleanup } = shell();
    try {
      createNoteFromLink('Archive/Old plan');
      assert.strictEqual(settleLinkCreate({ type: 'path_created', path: 'Archive/Old plan.md', kind: 'note' }), true);
      assert.deepStrictEqual(sent.slice(1), [{ type: 'read_file', path: 'Archive/Old plan.md' }]);
      assert.strictEqual(notice().textContent, 'Created Old planArchive/Old plan.md');
      assert.ok(!notice().classList.contains('refused'));
      createNoteFromLink('Archive/Old plan');
      assert.strictEqual(sent.length, 3, 'once settled, the guard lets go');
    } finally { settleLinkCreate({ type: 'create_error', path: 'Archive/Old plan.md', reason: 'x' }); cleanup(); }
  });

  test('a note that already exists is opened, never overwritten, and nothing is said as an error', () => {
    const { sent, notice, cleanup } = shell();
    try {
      createNoteFromLink('Roadmap');
      assert.strictEqual(settleLinkCreate({ type: 'create_error', path: 'Projects/Alpha/Roadmap.md', reason: 'already exists' }), true);
      assert.deepStrictEqual(sent.map((m) => m.type), ['create_path', 'read_file']);
      assert.strictEqual(sent[1].path, 'Projects/Alpha/Roadmap.md');
      assert.strictEqual(notice(), null);
    } finally { cleanup(); }
  });

  test('a name that cannot be used is refused in plain words, and nothing is sent', () => {
    const { sent, notice, cleanup } = shell();
    try {
      createNoteFromLink('Q3: plan');
      assert.deepStrictEqual(sent, []);
      assert.ok(notice().classList.contains('refused'));
      assert.match(notice().textContent, /^That note cannot be created.*cannot contain/);
    } finally { cleanup(); }
  });

  test('a refusal from the server is said plainly too', () => {
    const { notice, cleanup } = shell();
    try {
      createNoteFromLink('Roadmap');
      settleLinkCreate({ type: 'create_error', path: 'Projects/Alpha/Roadmap.md', reason: 'invalid path' });
      assert.match(notice().textContent, /outside this workspace/);
    } finally { cleanup(); }
  });

  test('an answer for a create no link asked for is left to the caller', () => {
    const { sent, cleanup } = shell();
    try {
      assert.strictEqual(settleLinkCreate({ type: 'path_created', path: 'Board.md', kind: 'board' }), false);
      assert.deepStrictEqual(sent, []);
    } finally { cleanup(); }
  });
});
