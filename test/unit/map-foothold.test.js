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

  test('an index from the previous schema is rebuilt on open, so links appear for untouched files', () => {
    // The version bump is the only thing that gives links to a workspace that
    // ALREADY has an index: the reconcile pass skips any file whose mtime and
    // size are unchanged, so without the mismatch-triggered rebuild a
    // pre-existing note is never re-read and its links never exist. This
    // walks the upgrade path itself: an index whose stored version is the
    // previous one, holding a files row for a file that is not touched again,
    // reopened at the current version. It must go red if the version constant
    // reverts.
    write('old-note.md', 'Points at [[Alpha]].');
    idx = fresh();
    reconcile(idx);
    assert.strictEqual(linksFrom(idx, 'old-note.md').length, 1, 'sanity: indexed at the current version');
    idx.close();

    // Age the index back one schema version and erase the links, which is
    // exactly what an index written before the links table looked like:
    // files rows present, links absent, version one behind.
    // The literal 3 is the point: written relative to the current constant,
    // a reverted constant would move this value with it and the mismatch
    // would fire anyway, hiding exactly the revert this test exists to catch.
    const raw = new sqlite.DatabaseSync(dbPath);
    raw.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
    raw.prepare('DELETE FROM links').run();
    raw.close();

    idx = fresh();
    reconcile(idx);
    assert.deepStrictEqual(linksFrom(idx, 'old-note.md'), ['wikilink:Alpha'],
      'opening at the current version rebuilds, so an untouched file\'s links exist without an edit');
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

  const TREE = [
    folder('alpha', [folder('alpha/Decoy', [file('alpha/Decoy/Notes.md')])]),
    folder('beta', [folder('beta/Target', [file('beta/Target/Notes.md')])]),
  ];
  const ENGINE = {
    allLinks: () => [
      { src: 'src.md', target: 'beta/Target/Notes', kind: 'wikilink' },
      { src: 'src.md', target: 'Nowhere', kind: 'wikilink' },
    ],
  };

  test('nodes come from the cached tree and links carry what they resolve to', () => {
    const { code, body } = drive({
      getFileTreeCached: () => TREE,
      getSearchEngine: () => ENGINE,
    });
    assert.strictEqual(code, 200);
    assert.strictEqual(body.indexed, true);
    assert.deepStrictEqual(body.nodes.map(n => n.path),
      ['alpha/Decoy/Notes.md', 'beta/Target/Notes.md'],
      'every file the tree holds is a node, whether or not anything links it');
    // THE FIELDS THE CONNECTIONS LIST CONSUMES, pinned where the payload is
    // produced: the client reads src, target and kind (and ignores resolved,
    // re-resolving on its own tree), so a projection that narrowed them would
    // otherwise stay green while every list rendered empty and every embed
    // counted as a link.
    assert.deepStrictEqual(
      { src: body.links[0].src, target: body.links[0].target, kind: body.links[0].kind },
      { src: 'src.md', target: 'beta/Target/Notes', kind: 'wikilink' },
      'the served link carries the fields the connections list reads, as the links table holds them');
    assert.strictEqual(body.links[0].resolved, 'beta/Target/Notes.md',
      'the endpoint and a click in a document go through one resolver, so they cannot disagree');
    assert.strictEqual(body.links[1].resolved, null, 'an unresolved link is a fact, not an omission');
  });

  test('an unchanged tree is never re-resolved: the second request answers from the memo', () => {
    // A fresh tree object, so this test owns its memo generation whatever
    // ran before it: the memo is keyed by tree identity, and the shared
    // fixture may already be resolved by an earlier test.
    const tree = [...TREE];
    const before1 = httpRouter.graphResolutionStats().count;
    drive({ getFileTreeCached: () => tree, getSearchEngine: () => ENGINE });
    const afterFirst = httpRouter.graphResolutionStats().count;
    assert.ok(afterFirst > before1, 'sanity: the first request against this tree resolved something');
    drive({ getFileTreeCached: () => tree, getSearchEngine: () => ENGINE });
    assert.strictEqual(httpRouter.graphResolutionStats().count, afterFirst,
      'a second request against the same tree resolves nothing: the answers are the memo\'s');
    // A NEW tree object is a new generation: every answer may have moved.
    drive({ getFileTreeCached: () => [...tree], getSearchEngine: () => ENGINE });
    assert.ok(httpRouter.graphResolutionStats().count > afterFirst,
      'and a changed tree empties the memo rather than serving yesterday\'s answers');
  });

  test('no index is an absent capability, stated, with the full shape intact', () => {
    const { code, body } = drive({
      getFileTreeCached: () => [],
      getSearchEngine: () => null,
    });
    assert.strictEqual(code, 200);
    assert.strictEqual(body.indexed, false,
      'a runtime without the index says the capability is missing, rather than rendering as an unlinked workspace');
    assert.deepStrictEqual(body.nodes, [], 'the shape does not change with the capability');
    assert.deepStrictEqual(body.links, []);
  });

  test('a failing index is a 500 with the error named, never a quiet 200', () => {
    const { code, body } = drive({
      getFileTreeCached: () => TREE,
      getSearchEngine: () => ({ allLinks: () => { throw new Error('index file is corrupt'); } }),
    });
    assert.strictEqual(code, 500, 'a real failure is a failure, not an empty success');
    assert.match(body.error, /index file is corrupt/, 'and it names its cause');
  });
});

describe('the connections list rides the real open path', () => {
  const TREE = [
    folder('a', [file('a/Here.md'), file('a/Other.md')]),
    file('Top.md'),
    file('plain.txt'),
  ];
  const LINKS = [
    { src: 'a/Here.md', target: 'Other', kind: 'wikilink' },
    // The embed's target RESOLVES, deliberately: an unresolvable embed would
    // be dropped for its null resolution whatever the kind rule said, and the
    // exclusion would look proven while proving nothing.
    { src: 'a/Here.md', target: 'Top', kind: 'embed' },
    { src: 'Top.md', target: 'a/Here.md', kind: 'markdown' },
    { src: 'a/Here.md', target: 'Other', kind: 'wikilink' },
    { src: 'plain.txt', target: 'Top', kind: 'wikilink' },
  ];

  test('outgoing and incoming are resolved through the one resolver, deduplicated, embeds excluded', () => {
    const { outgoing, incoming } = fileConnections('a/Here.md', LINKS, TREE);
    assert.deepStrictEqual(outgoing, [{ target: 'Other', resolved: 'a/Other.md' }],
      'one row per destination, and the embed renders a file rather than linking to it');
    assert.deepStrictEqual(incoming, [{ src: 'Top.md' }]);
  });

  // THE SHELL THE REAL PATH RUNS IN. The editor skeleton from index.html, the
  // module loaders pre-seeded so the registry and the editor resolve to test
  // doubles, and every app-owned global the open path reaches for. What runs
  // is the real loadFileContent dispatch, the real surface functions, and the
  // real connections renderer: nothing below hands the section a detached
  // element or calls the drawing function itself.
  function shell() {
    const dom = new JSDOM(`<!doctype html><body>
      <div id="editor-header" class="hidden"></div>
      <span id="editor-filename"></span><span id="editor-status"></span>
      <button id="toggle-preview"></button><button id="toggle-edit"></button>
      <div id="editor-empty"></div>
      <div id="file-tree"></div>
      <div id="editor-pane">
        <div id="editor-content" class="hidden"></div>
        <textarea id="editor-textarea" class="hidden"></textarea>
        <div id="tiptap-editor-pane" class="hidden">
          <div id="tiptap-properties"></div>
          <div id="tiptap-editor"></div>
          <div id="tiptap-toolbar"></div>
        </div>
      </div>
    </body>`);
    const w = dom.window;
    const sent = [];
    const stubs = {
      window: w, document: w.document,
      ws: { send: (raw) => sent.push(JSON.parse(raw)) },
      cachedFileTree: TREE,
      currentFilePath: null, editorReturnView: 'editor', fileHistory: [],
      rawFileContent: '', fileFrontmatter: '', fileBody: '', editorMode: 'preview',
      editorDirty: false, saveTimer: null, boardSaveTimer: null, boardPendingSave: null,
      diskBaselines: new Map(),
      workspaceAnalysis: null, agents: [], currentWorkspacePath: null,
      TREE_ICONS: new Proxy({}, { get: () => '<svg></svg>' }),
      esc: (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      paletteFileIcon: () => '<svg></svg>', menuIconSvg: () => '<svg></svg>',
      CREATABLE_TYPES: [],
      switchNav: () => {}, showView: () => {}, highlightFileInSidebar: () => {},
      closeFindBar: () => {}, findState: { open: false }, syncTiptapFindStateFromPlugin: () => {},
      paletteOpenFile: () => {},
      activeTiptapEditor: null, _tiptapSaveTimer: null,
      // The registry double: classification by extension, which is all the
      // dispatch reads. Pre-seeded so loadViewersModule never imports.
      _viewersModuleResolved: null, _viewersModule: null,
      _tiptapEditorModule: null, _tiptapEditorModuleResolved: null,
      activeFileViewer: null,
      formatMdFull: (t) => String(t),
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ indexed: true, links: LINKS }) }),
    };
    const viewers = {
      classify: (p) => (p.endsWith('.md') ? 'markdown' : p.endsWith('.txt') ? 'text' : 'image'),
      mountViewer: () => ({ destroy: () => {} }),
    };
    stubs._viewersModuleResolved = viewers;
    stubs._viewersModule = Promise.resolve(viewers);
    const tiptap = {
      createEditor: ({ element }) => {
        element.textContent = 'rendered document';
        return { editor: { destroyed: false, on: () => {} } };
      },
      destroyEditor: () => {},
    };
    stubs._tiptapEditorModule = Promise.resolve(tiptap);
    stubs._tiptapEditorModuleResolved = tiptap;
    for (const [k, v] of Object.entries(stubs)) global[k] = v;
    const cleanup = () => {
      for (const k of Object.keys(stubs)) delete global[k];
      dom.window.close();
    };
    const settle = () => new Promise((r) => setTimeout(r, 0)).then(() => new Promise((r) => setTimeout(r, 0)));
    return { w, doc: w.document, sent, cleanup, settle };
  }

  test('opening a markdown file through the real dispatch mounts the connections under its surface', async () => {
    const { doc, cleanup, settle } = shell();
    try {
      filesView.loadFileContent('a/Here.md', 'To [[Other]].');
      await settle();
      const section = doc.getElementById('file-connections');
      assert.ok(section, 'the section exists after a real markdown open, not after a hand call');
      assert.strictEqual(section.parentElement.id, 'tiptap-editor-pane',
        'and it is mounted under the surface a linked document is actually read on');
      const rows = [...section.querySelectorAll('.file-connections-row')].map(r => r.textContent);
      assert.deepStrictEqual(rows, ['a/Other.md', 'Top.md'],
        'outgoing resolved, incoming source, nothing else');
    } finally { cleanup(); }
  });

  test('a clicked row and the same link clicked in the document open one file', async () => {
    const { doc, sent, cleanup, settle } = shell();
    try {
      filesView.loadFileContent('a/Here.md', 'To [[Other]].');
      await settle();
      const row = doc.querySelector('#file-connections .file-connections-row');
      assert.ok(row, 'sanity: the rendered list produced a row');
      row.dispatchEvent(new (doc.defaultView.Event)('click'));
      const viaConnections = sent.filter(m => m.type === 'read_file').pop();
      sent.length = 0;
      filesView.openWikilink('Other');
      const viaDocument = sent.filter(m => m.type === 'read_file').pop();
      assert.ok(viaConnections && viaDocument, 'both routes asked the server for a file');
      assert.strictEqual(viaConnections.path, viaDocument.path,
        'the row the code produced and the link in the document name one file, off one resolver');
    } finally { cleanup(); }
  });

  test('the section lives exactly as long as the file it describes', async () => {
    const { doc, cleanup, settle } = shell();
    try {
      filesView.loadFileContent('plain.txt', 'points at [[Top]]');
      await settle();
      assert.ok(doc.getElementById('file-connections'), 'sanity: the text surface drew its section');
      // The reported defect: a markdown file opened next kept the text
      // file's section mounted underneath it, naming another document's
      // links.
      filesView.loadFileContent('a/Here.md', 'To [[Other]].');
      await settle();
      const section = doc.getElementById('file-connections');
      assert.ok(section, 'the markdown file has its own section');
      const rows = [...section.querySelectorAll('.file-connections-row')].map(r => r.textContent);
      assert.ok(!rows.includes('Top.md') || rows.includes('a/Other.md'),
        'and its rows are the new file\'s, not the text file\'s leftovers');
      assert.deepStrictEqual(rows, ['a/Other.md', 'Top.md'], 'exactly the markdown file\'s connections');
      // A surface that owns the pane exclusively carries no section at all.
      filesView.loadFileContent('shot.png', '');
      await settle();
      assert.strictEqual(doc.getElementById('file-connections'), null,
        'a read-only viewer shows no other file\'s connections');
      // And closing the file removes it rather than leaving it for the next open.
      filesView.loadFileContent('a/Here.md', 'To [[Other]].');
      await settle();
      filesView.closeOpenFile();
      assert.strictEqual(doc.getElementById('file-connections'), null,
        'a closed file leaves nothing behind');
    } finally { cleanup(); }
  });

  test('a link typed into a note reaches the next render, with no tree change anywhere', async () => {
    // The staleness this pins: links change on content edits, and a content
    // edit changes no tree, so any cache keyed to the tree serves yesterday's
    // answer for the rest of the session. Here the server's answer changes
    // between renders while the tree never does, and the next render must
    // show the new set.
    const { doc, cleanup, settle } = shell();
    try {
      filesView.loadFileContent('a/Here.md', 'To [[Other]].');
      await settle();
      let rows = [...doc.querySelectorAll('#file-connections .file-connections-row')].map(r => r.textContent);
      assert.deepStrictEqual(rows, ['a/Other.md', 'Top.md'], 'sanity: the first answer rendered');
      // The edit lands server-side: the graph now also links Here to Top.
      global.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({
        indexed: true,
        links: LINKS.concat([{ src: 'a/Here.md', target: 'Top', kind: 'wikilink' }]),
      }) });
      filesView.loadFileContent('a/Here.md', 'To [[Other]] and [[Top]].');
      await settle();
      rows = [...doc.querySelectorAll('#file-connections .file-connections-row')].map(r => r.textContent);
      assert.deepStrictEqual(rows, ['a/Other.md', 'Top.md', 'Top.md'],
        'the next render carries the new link, because no cache outlives a render');
    } finally { cleanup(); }
  });

  test('a file opened before the tree arrives gets its rows when the tree does', async () => {
    const { doc, cleanup, settle } = shell();
    try {
      global.cachedFileTree = null;
      filesView.loadFileContent('a/Here.md', 'To [[Other]].');
      await settle();
      const before = [...doc.querySelectorAll('#file-connections .file-connections-row')];
      assert.strictEqual(before.length, 0, 'sanity: nothing resolves against no tree');
      // The tree arrives, the way the shell delivers it: renderFileTree.
      global.cachedFileTree = TREE;
      global.renderedTree = null;
      filesView.renderFileTree(TREE);
      await settle();
      const rows = [...doc.querySelectorAll('#file-connections .file-connections-row')].map(r => r.textContent);
      assert.deepStrictEqual(rows, ['a/Other.md', 'Top.md'],
        'the section recovers when the data it depended on arrives');
      await settle();
    } finally { cleanup(); }
  });

  test('the rendered list says why it is empty, in both empty states', async () => {
    const { doc, cleanup, settle } = shell();
    try {
      global.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ indexed: false, nodes: [], links: [] }) });
      filesView.loadFileContent('a/Here.md', 'To [[Other]].');
      await settle(); await settle();
      assert.match(doc.getElementById('file-connections').textContent, /need the search index/,
        'no index is named, not rendered as a workspace with no links');
      global.fetch = () => Promise.reject(new Error('down'));
      filesView.loadFileContent('Top.md', 'x');
      await settle(); await settle();
      assert.match(doc.getElementById('file-connections').textContent, /could not be read/,
        'an unreachable link list is named too');
    } finally { cleanup(); }
  });
});
