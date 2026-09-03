'use strict';
// What a link means, told the same way everywhere.
//
// Four walls around one rule: the resolver applies exact-path precedence
// across the whole tree with a stated tie rule; the index stores what a file
// says and never what that resolves to; the endpoint resolves at read time
// against the server's cached tree through the same resolver; and the
// connections list under a file names exactly the files a click would open.
//
// The regression case at the top is the one that mattered: a fully qualified
// link opening a different file of the same name in whichever folder sorted
// first, because basename matching on an earlier file returned before exact
// path matching on a later file was ever considered.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const filesView = require('../../public/views/files.js');
const { findFileInTree, wikilinkSearchName, fileConnections } = filesView;
const { extractLinks } = require('../../lib/links.js');

const file = (p) => ({ type: 'file', name: p.split('/').pop(), path: p });
const folder = (p, children) => ({ type: 'folder', name: p.split('/').pop(), path: p, children });

describe('the resolver: exact path first, then the stated tie rule', () => {
  // The proven wrong-file case. alpha/Decoy sorts before beta/Target, so the
  // per-file walk returned the decoy on its basename before ever reaching the
  // file the link named in full. Renaming an unrelated folder changed where
  // the link went.
  test('a fully qualified link opens the exactly matching file, wherever it sits in tree order', () => {
    const tree = [
      folder('alpha', [folder('alpha/Decoy', [file('alpha/Decoy/Notes.md')])]),
      folder('beta', [folder('beta/Target', [file('beta/Target/Notes.md')])]),
    ];
    assert.strictEqual(findFileInTree(tree, 'beta/Target/Notes.md'), 'beta/Target/Notes.md',
      'an exact path names one file, and nothing else may win');
    assert.strictEqual(findFileInTree(tree, 'alpha/Decoy/Notes.md'), 'alpha/Decoy/Notes.md',
      'and the same in the direction that happened to work before, so the fix is symmetry, not luck');
  });

  test('exact path wins case-insensitively, matching how every other path comparison here reads', () => {
    const tree = [folder('Docs', [file('Docs/Plan.md')]), file('plan.md')];
    assert.strictEqual(findFileInTree(tree, 'docs/plan.md'), 'Docs/Plan.md');
  });

  test('a bare name resolves to the least nested match', () => {
    // Both candidates sit under folders, deliberately: a root-level file's
    // path IS its bare name, so a root candidate would satisfy the exact-path
    // rule and this test would stop exercising the tie rule at all.
    const tree = [
      folder('deep', [folder('deep/deeper', [file('deep/deeper/Notes.md')])]),
      folder('shallow', [file('shallow/Notes.md')]),
    ];
    assert.strictEqual(findFileInTree(tree, 'Notes.md'), 'shallow/Notes.md',
      'a bare link most plausibly means the least nested file of that name');
  });

  test('between equally nested matches, tree order decides', () => {
    const tree = [
      folder('a', [file('a/Notes.md')]),
      folder('b', [file('b/Notes.md')]),
    ];
    assert.strictEqual(findFileInTree(tree, 'Notes.md'), 'a/Notes.md',
      'the tie rule is stated: shortest path, then tree order, and this is the tree-order half');
  });

  test('a name the tree does not hold resolves to nothing, never to a near miss', () => {
    const tree = [file('ax.md')];
    // The old third rule stripped the first '.md' occurrence anywhere in the
    // search string, so a link written [[a.mdx]] could match a file named
    // ax.md that it never named. Gone means gone.
    assert.strictEqual(findFileInTree(tree, 'a.mdx'), null);
    assert.strictEqual(findFileInTree(tree, 'missing.md'), null);
  });

  test('the search-name rule is one function: anchor dropped, extension defaulted only when absent', () => {
    assert.strictEqual(wikilinkSearchName('Notes#section'), 'Notes.md');
    assert.strictEqual(wikilinkSearchName('chart.png'), 'chart.png',
      'a viewable extension is kept, so an image link never chases a phantom .md sibling');
    assert.strictEqual(wikilinkSearchName('  Plan  '), 'Plan.md');
    assert.strictEqual(wikilinkSearchName('notes/Plan.md#top'), 'notes/Plan.md');
  });
});

describe('extraction stores what a file says, and nothing it resolves', () => {
  test('wikilinks, aliases, embeds and workspace markdown links are told apart', () => {
    const links = extractLinks([
      'See [[Alpha]] and [[Beta|shown differently]].',
      'Embedded: ![[Diagram.png]].',
      'And [docs](notes/Gamma.md), but not [out](https://example.com/x.md).',
      '`[[not a link]]` and:',
      '```',
      '[[also not a link]]',
      '```',
    ].join('\n'));
    assert.deepStrictEqual(links.map(l => `${l.kind}:${l.target}`).sort(), [
      'embed:Diagram.png', 'markdown:notes/Gamma.md', 'wikilink:Alpha', 'wikilink:Beta',
    ].sort(), 'code is stripped first, the alias never resolves, and the embed is labelled, not dropped');
  });
});

const { probeSqlite, createSearchIndex } = require('../../search.js');
const sqlite = probeSqlite();

describe('the links table lives and dies with its file', { skip: !sqlite.available && 'no node:sqlite on this runtime' }, () => {
  let tmpRoot, workspace, dbPath, idx;
  const write = (rel, content) => {
    const full = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  const fresh = () => {
    const i = createSearchIndex({ dbPath, DatabaseSync: sqlite.DatabaseSync });
    i.open();
    return i;
  };
  const linksFrom = (index, src) => index.allLinks().filter(l => l.src === src)
    .map(l => `${l.kind}:${l.target}`).sort();
  const reconcile = (index) => index.reconcileFiles(workspace);

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'map-foothold-'));
    workspace = path.join(tmpRoot, 'ws');
    fs.mkdirSync(path.join(workspace, '.rundock'), { recursive: true });
    dbPath = path.join(workspace, '.rundock', 'search-index.db');
    idx = null;
  });
  afterEach(() => {
    if (idx) { try { idx.close(); } catch (e) { /* already closed */ } }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('a pass records what a file says, and a re-index replaces rather than accumulates', () => {
    write('note.md', 'To [[Alpha]] and ![[Pic.png]] and [d](docs/G.md).');
    idx = fresh();
    reconcile(idx);
    assert.deepStrictEqual(linksFrom(idx, 'note.md'),
      ['embed:Pic.png', 'markdown:docs/G.md', 'wikilink:Alpha']);
    write('note.md', 'Now only [[Beta]].');
    reconcile(idx);
    assert.deepStrictEqual(linksFrom(idx, 'note.md'), ['wikilink:Beta'],
      'yesterday\'s edges do not survive a re-index of their source');
  });

  test('a removed file takes its links with it, on both removal paths', () => {
    write('gone.md', 'Points at [[Alpha]].');
    idx = fresh();
    reconcile(idx);
    assert.strictEqual(linksFrom(idx, 'gone.md').length, 1);
    fs.rmSync(path.join(workspace, 'gone.md'));
    reconcile(idx);
    assert.deepStrictEqual(linksFrom(idx, 'gone.md'), [],
      'edges out of a file that no longer exists are not edges');
    // And the direct removal path used by single-file updates.
    write('gone2.md', 'Points at [[Beta]].');
    reconcile(idx);
    idx.removeFile('gone2.md');
    assert.deepStrictEqual(linksFrom(idx, 'gone2.md'), []);
  });

  test('links come off raw content, so a frontmatter wikilink counts', () => {
    write('front.md', '---\nrelated: "[[Plan]]"\n---\nBody.');
    idx = fresh();
    reconcile(idx);
    assert.deepStrictEqual(linksFrom(idx, 'front.md'), ['wikilink:Plan'],
      'the editor renders wikilinks inside frontmatter, so they are links');
  });

  test('the table stores the target as written, never a resolution', () => {
    write('a/Notes.md', 'x');
    write('src.md', 'To [[Notes]].');
    idx = fresh();
    reconcile(idx);
    const row = idx.allLinks().find(l => l.src === 'src.md');
    assert.strictEqual(row.target, 'Notes',
      'which file a bare name means depends on every other file, so a stored resolution would go stale');
  });
});

describe('the endpoint resolves at read time against the cached tree', () => {
  const httpRouter = require('../../lib/http-router.js');

  function drive(deps) {
    const prev = httpRouter.wireHttpRouterDeps(deps);
    const chunks = [];
    const res = {
      writeHead: (code, headers) => { res.code = code; res.headers = headers; },
      end: (body) => { chunks.push(body); },
    };
    try {
      httpRouter.handleHttpRequest({ url: '/api/graph', method: 'GET' }, res);
    } finally {
      httpRouter.wireHttpRouterDeps(prev);
    }
    return { code: res.code, body: JSON.parse(chunks.join('')) };
  }

  test('links come back carrying what they resolve to right now, read from the cached tree', () => {
    let cachedReads = 0;
    const tree = [
      folder('alpha', [folder('alpha/Decoy', [file('alpha/Decoy/Notes.md')])]),
      folder('beta', [folder('beta/Target', [file('beta/Target/Notes.md')])]),
    ];
    const { code, body } = drive({
      getFileTreeCached: () => { cachedReads += 1; return tree; },
      getSearchEngine: () => ({
        allLinks: () => [
          { src: 'src.md', target: 'beta/Target/Notes', kind: 'wikilink' },
          { src: 'src.md', target: 'Nowhere', kind: 'wikilink' },
        ],
      }),
    });
    assert.strictEqual(code, 200);
    assert.strictEqual(body.indexed, true);
    assert.strictEqual(body.links[0].resolved, 'beta/Target/Notes.md',
      'the endpoint and a click in a document go through one resolver, so they cannot disagree');
    assert.strictEqual(body.links[1].resolved, null, 'an unresolved link is a fact, not an omission');
    assert.ok(cachedReads >= 1, 'resolution reads the tree the server already holds');
  });

  test('no index is a statement, not an error and not an empty graph', () => {
    const { code, body } = drive({
      getFileTreeCached: () => [],
      getSearchEngine: () => null,
    });
    assert.strictEqual(code, 200);
    assert.strictEqual(body.indexed, false,
      'a runtime without the index says so, rather than rendering as an unlinked workspace');
  });
});

describe('the connections list names the files a click would open', () => {
  const TREE = [
    folder('a', [file('a/Here.md'), file('a/Other.md')]),
    file('Top.md'),
  ];
  const LINKS = [
    { src: 'a/Here.md', target: 'Other', kind: 'wikilink' },
    // The embed's target RESOLVES, deliberately: an unresolvable embed would
    // be dropped for its null resolution whatever the kind rule said, and the
    // exclusion would look proven while proving nothing.
    { src: 'a/Here.md', target: 'Top', kind: 'embed' },
    { src: 'Top.md', target: 'a/Here.md', kind: 'markdown' },
    { src: 'a/Here.md', target: 'Other', kind: 'wikilink' },
  ];

  test('outgoing and incoming are resolved through the one resolver, deduplicated, embeds excluded', () => {
    const { outgoing, incoming } = fileConnections('a/Here.md', LINKS, TREE);
    assert.deepStrictEqual(outgoing, [{ target: 'Other', resolved: 'a/Other.md' }],
      'one row per destination, and the embed renders a file rather than linking to it');
    assert.deepStrictEqual(incoming, [{ src: 'Top.md' }]);
  });

  test('a document click and a connections click open the same file', () => {
    // The document route: openWikilink builds the search name and resolves.
    // The connections route: the list carries the resolved path and opens it
    // directly. Both are driven here and must send the same read_file path.
    const dom = new JSDOM('<!doctype html><body></body>');
    const sent = [];
    global.document = dom.window.document;
    global.ws = { send: (raw) => sent.push(JSON.parse(raw)) };
    global.cachedFileTree = TREE;
    global.currentFilePath = null;
    global.editorReturnView = 'editor';
    global.fileHistory = [];
    global.switchNav = () => {};
    global.showView = () => {};
    global.highlightFileInSidebar = () => {};
    try {
      filesView.openWikilink('Other');
      const viaDocument = sent.find(m => m.type === 'read_file');
      sent.length = 0;
      const { outgoing } = fileConnections('a/Here.md', LINKS, TREE);
      filesView.openWorkspaceFilePath(outgoing[0].resolved);
      const viaConnections = sent.find(m => m.type === 'read_file');
      assert.ok(viaDocument && viaConnections, 'both routes asked the server for a file');
      assert.strictEqual(viaConnections.path, viaDocument.path,
        'the list and the link name one file, because both answers came from one resolver');
    } finally {
      delete global.document; delete global.ws; delete global.cachedFileTree;
      delete global.currentFilePath; delete global.editorReturnView;
      delete global.fileHistory; delete global.switchNav;
      delete global.showView; delete global.highlightFileInSidebar;
      dom.window.close();
    }
  });

  test('the rendered list says why it is empty, in both empty states', () => {
    const dom = new JSDOM('<!doctype html><body><div id="s"></div></body>');
    const section = dom.window.document.getElementById('s');
    global.document = dom.window.document;
    global.cachedFileTree = TREE;
    try {
      filesView.drawFileConnections(section, 'a/Here.md', { indexed: false, links: [] });
      assert.match(section.textContent, /need the search index/,
        'no index is named, not rendered as a workspace with no links');
      filesView.drawFileConnections(section, 'a/Here.md', null);
      assert.match(section.textContent, /could not be read/,
        'an unreachable link list is named too');
    } finally {
      delete global.document; delete global.cachedFileTree;
      dom.window.close();
    }
  });
});
