'use strict';
// The Pins list, pressed.
//
// WHAT IS PRESSED HERE AND WHAT IS NOT. The sidebar list, the pane's empty
// state, the header control, the context-menu row, the arrival rule and the
// missing-file policy are all driven through the shipped view under jsdom,
// against the REAL rail, sidebar and panes cut out of index.html, and with
// the REAL files view required beside it, so a tree row and a pinned row are
// clicked through the same code the product runs. Which rail entry a Pins
// open lights is the doors file's business (test/unit/navigation-doors.test.js
// presses showView under both entries); this file asserts the entry is set.
//
// THE MODEL DOES THE RECONCILING. The view carries no second copy of the
// missing rule, and the lane's mutation harness proves it by replacing the
// model call with an inline map and requiring this file to go red.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const INDEX_SRC = read('public', 'index.html');
const PINS_SRC = read('public', 'views', 'pins.js');

const FilesMenuModel = require(path.join(ROOT, 'public', 'files-menu-model.js'));
const RundockFileTreeDiff = require(path.join(ROOT, 'public', 'file-tree-diff.js'));
const PinsModel = require(path.join(ROOT, 'public', 'pins-model.js'));
const filesView = require(path.join(ROOT, 'public', 'views', 'files.js'));
const pinsView = require(path.join(ROOT, 'public', 'views', 'pins.js'));

// One glyph per kind, all different, so "the tree's own icon" is a claim a
// swapped kind would fail rather than one any svg satisfies.
const TREE_ICONS = {
  folder: '<path d="folder"/>', folderOpen: '<path d="open"/>',
  note: '<path d="note"/>', board: '<path d="board"/>', artifact: '<path d="artifact"/>',
  pdf: '<path d="pdf"/>', image: '<path d="image"/>', file: '<path d="file"/>',
};

const TREE = [
  { type: 'folder', name: 'notes', path: 'notes', children: [
    { type: 'file', name: 'backlog.md', kind: 'note', path: 'notes/backlog.md' },
  ] },
  { type: 'file', name: 'Roadmap.md', kind: 'note', path: 'Roadmap.md' },
  { type: 'file', name: 'Sprint Board.md', kind: 'board', path: 'Sprint Board.md' },
  { type: 'file', name: 'dash.html', kind: 'artifact', path: 'dash.html' },
];

// The shell is the REAL page's chrome and panes. A copy written here would
// keep passing after the page stopped carrying the elements the view resolves
// by id, which is the class of proof this project keeps finding it has written.
function shellMarkup() {
  const rail = /<nav class="nav-rail"[\s\S]*?<\/nav>/.exec(INDEX_SRC);
  assert.ok(rail, 'index.html no longer carries a nav rail');
  const sidebar = /<aside class="sidebar"[\s\S]*?<\/aside>/.exec(INDEX_SRC);
  assert.ok(sidebar, 'index.html no longer carries a sidebar');
  const editor = /<div id="view-editor"[\s\S]*?(?=\s*<!-- Pins: shown only)/.exec(INDEX_SRC);
  assert.ok(editor, 'index.html no longer carries the editor pane ahead of the pins pane');
  const pins = /<div id="view-pins"[\s\S]*?<\/div>\s*<\/div>/.exec(INDEX_SRC);
  assert.ok(pins, 'index.html no longer carries the pins pane');
  return `<!doctype html><html><body><div class="app">${rail[0]}${sidebar[0]}<main>${editor[0]}${pins[0]}</main></div></body></html>`;
}

// Globals the two views reach at call time, installed on node's global the
// way test/unit/map-foothold.test.js installs them, so the REAL modules run
// rather than copies evaluated into a window.
function shell({ pins = [], tree = TREE, currentFilePath = null } = {}) {
  const dom = new JSDOM(shellMarkup(), { pretendToBeVisual: true });
  const w = dom.window;
  const sent = [];
  const shown = [];
  const viewers = {
    classify: (p) => (p.endsWith('.md') ? 'text' : p.endsWith('.html') ? 'text' : 'image'),
    mountViewer: () => ({ destroy: () => {} }),
  };
  const stubs = {
    window: w, document: w.document, CustomEvent: w.CustomEvent,
    ws: { send: (raw) => sent.push(JSON.parse(raw)), readyState: 1 },
    cachedFileTree: tree,
    currentFilePath, editorReturnView: 'editor', editorEntry: 'files', fileHistory: [],
    rawFileContent: '', fileFrontmatter: '', fileBody: '', editorMode: 'preview',
    editorDirty: false, saveTimer: null, boardSaveTimer: null, boardPendingSave: null,
    diskBaselines: new Map(),
    workspaceAnalysis: null, agents: [], currentWorkspacePath: null, serverPlatform: 'linux',
    TREE_ICONS, FilesMenuModel, RundockPinsModel: PinsModel, RundockFileTreeDiff,
    CREATABLE_TYPES: FilesMenuModel.CREATABLE_TYPES,
    esc: (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    switchNav: () => {}, showView: (v) => shown.push(v), highlightFileInSidebar: () => {},
    closeFindBar: () => {}, findState: { open: false }, syncTiptapFindStateFromPlugin: () => {},
    paletteOpenFile: () => {}, formatMdFull: (t) => String(t),
    activeTiptapEditor: null, _tiptapSaveTimer: null,
    _viewersModuleResolved: viewers, _viewersModule: Promise.resolve(viewers),
    _tiptapEditorModule: null, _tiptapEditorModuleResolved: null,
    activeFileViewer: null,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ indexed: false, links: [] }) }),
    // The files view's own functions the pins view calls by bare name, and
    // the pins view's own that the files view calls by bare name.
    treeIconSvg: filesView.treeIconSvg, updateEditorBackButton: filesView.updateEditorBackButton,
    renderEditorPinControl: pinsView.renderEditorPinControl, noteTreeForPins: pinsView.noteTreeForPins,
    pinMenuRow: pinsView.pinMenuRow,
  };
  for (const [k, v] of Object.entries(stubs)) global[k] = v;
  // The state the workspace open would leave: the tree drawn, the reply in.
  // A null tree is the state before the first push, so nothing is drawn.
  pinsView.requestPins();
  if (tree) filesView.renderFileTree(tree);
  pinsView.handlePinsReply(pins);
  // The request the open sent is the shell's, not the test's.
  sent.splice(0);
  const cleanup = () => {
    pinsView.handlePinsReply([]);
    for (const k of Object.keys(stubs)) delete global[k];
    dom.window.close();
  };
  const settle = () => new Promise((r) => setTimeout(r, 0)).then(() => new Promise((r) => setTimeout(r, 0)));
  return { w, doc: w.document, sent, shown, cleanup, settle };
}

const rows = (doc) => [...doc.querySelectorAll('#pin-list .pin-item')];
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const click = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, cancelable: true }));

describe('the sidebar lists pinned files flat, in pin order', () => {
  test('three pins draw three rows in the order they were pinned, with no folder rows', () => {
    const { doc, cleanup } = shell({ pins: ['dash.html', 'notes/backlog.md', 'Roadmap.md'] });
    try {
      assert.deepStrictEqual(rows(doc).map(r => r.dataset.path), ['dash.html', 'notes/backlog.md', 'Roadmap.md'],
        'the list is in pin order, never tree order');
      assert.deepStrictEqual(rows(doc).map(r => text(r.querySelector('.pin-name'))), ['dash.html', 'backlog.md', 'Roadmap.md']);
      assert.strictEqual(doc.querySelectorAll('#sidebar-pins .folder-item').length, 0, 'a folder row in the Pins list');
      assert.strictEqual(doc.querySelectorAll('#sidebar-pins .file-children').length, 0, 'a nested tree in the Pins list');
      assert.strictEqual(text(rows(doc)[1].querySelector('.pin-path')), 'notes/', 'a nested file names its folder underneath');
    } finally { cleanup(); }
  });

  test('each row carries the tree\'s own icon for its kind', () => {
    const { doc, cleanup } = shell({ pins: ['Sprint Board.md', 'Roadmap.md', 'dash.html'] });
    try {
      const treeIcon = (p) => doc.querySelector(`#file-tree .file-item[data-path="${p}"] svg.file-item-icon`).outerHTML;
      for (const row of rows(doc)) {
        assert.strictEqual(row.querySelector('svg.file-item-icon').outerHTML, treeIcon(row.dataset.path),
          `${row.dataset.path}: the pin row draws a different icon from the tree row`);
      }
      assert.notStrictEqual(rows(doc)[0].querySelector('svg').outerHTML, rows(doc)[1].querySelector('svg').outerHTML,
        'sanity: a board and a note draw different icons, so the equality above discriminates');
    } finally { cleanup(); }
  });

  test('the remove control sends unpin_file for its row, and opens nothing', () => {
    const { doc, sent, shown, cleanup } = shell({ pins: ['dash.html', 'notes/backlog.md', 'Roadmap.md'] });
    try {
      click(rows(doc)[1].querySelector('.pin-unpin'));
      assert.deepStrictEqual(sent, [{ type: 'unpin_file', path: 'notes/backlog.md' }]);
      assert.deepStrictEqual(shown, [], 'unpinning showed a view');
      assert.ok(!sent.some(m => m.type === 'read_file'), 'unpinning opened the file');
    } finally { cleanup(); }
  });

  test('the sidebar carries no add button: a pin is made from a file, never from this list', () => {
    const { doc, cleanup } = shell({ pins: [] });
    try {
      assert.strictEqual(doc.querySelectorAll('#sidebar-pins button.files-add-btn').length, 0);
      assert.strictEqual(text(doc.querySelector('#sidebar-pins .sidebar-label')), 'Pins');
    } finally { cleanup(); }
  });
});

describe('a pinned row opens its file the way a tree row does', () => {
  test('a pinned row and a tree row for one path send the same message and show the same view', () => {
    const { doc, sent, shown, cleanup } = shell({ pins: ['Roadmap.md'] });
    try {
      click(rows(doc)[0]);
      const fromPins = { sent: sent.splice(0), shown: shown.splice(0), entry: global.editorEntry };
      click(doc.querySelector('#file-tree .file-item[data-path="Roadmap.md"]'));
      const fromTree = { sent: sent.splice(0), shown: shown.splice(0), entry: global.editorEntry };
      assert.deepStrictEqual(fromPins.sent, [{ type: 'read_file', path: 'Roadmap.md' }]);
      assert.deepStrictEqual(fromTree.sent, fromPins.sent, 'the two routes send different messages');
      assert.deepStrictEqual(fromPins.shown, ['editor']);
      assert.deepStrictEqual(fromTree.shown, fromPins.shown, 'the two routes show different views');
      // The one thing that differs is where the reader came in from, which is
      // what the rail reads.
      assert.strictEqual(fromPins.entry, 'pins');
      assert.strictEqual(fromTree.entry, 'files');
    } finally { cleanup(); }
  });

  test('the view has no viewer branch of its own', () => {
    // The reply to read_file lands in loadFileContent for every route, and
    // the file-type registry decides the surface there. A pins-specific open
    // would be a second dispatch that boards and artifacts could fall out of.
    for (const forbidden of ['loadFileContent(', 'classify(', 'Kanban', 'mountViewer', 'file_content']) {
      assert.ok(!PINS_SRC.includes(forbidden), `views/pins.js carries "${forbidden}", a viewer decision of its own`);
    }
  });
});

describe('the header control says whether the open file is pinned', () => {
  test('opening a file draws the control, a pins reply naming it presses it, activating it sends the matching message', async () => {
    const { doc, sent, cleanup, settle } = shell({ pins: [] });
    try {
      filesView.loadFileContent('Roadmap.md', '# Roadmap\n');
      await settle();
      const control = doc.getElementById('editor-pin');
      assert.ok(control, 'the editor header carries no pin control');
      assert.strictEqual(control.getAttribute('aria-pressed'), 'false');
      assert.strictEqual(control.getAttribute('aria-label'), 'Pin');
      assert.ok(!control.classList.contains('pinned'));

      pinsView.handlePinsReply(['notes/backlog.md', 'Roadmap.md']);
      assert.strictEqual(control.getAttribute('aria-pressed'), 'true', 'a pins reply naming the open file did not press the control');
      assert.strictEqual(control.getAttribute('aria-label'), 'Unpin');
      assert.ok(control.classList.contains('pinned'));
      assert.ok(control.querySelector('svg').getAttribute('fill') === 'currentColor', 'pinned draws the filled glyph');

      // The page wires the control's onclick to toggleCurrentFilePin (the
      // markup test below pins that); jsdom without scripting runs no inline
      // handler, so the handler the attribute names is pressed directly.
      pinsView.toggleCurrentFilePin();
      assert.deepStrictEqual(sent.splice(0), [{ type: 'unpin_file', path: 'Roadmap.md' }]);

      pinsView.handlePinsReply(['notes/backlog.md']);
      assert.strictEqual(control.getAttribute('aria-pressed'), 'false');
      assert.strictEqual(control.querySelector('svg').getAttribute('fill'), 'none', 'unpinned draws the outline glyph');
      pinsView.toggleCurrentFilePin();
      assert.deepStrictEqual(sent.splice(0), [{ type: 'pin_file', path: 'Roadmap.md' }]);
    } finally { cleanup(); }
  });

  test('the control re-renders on every open, so a pinned file followed by an unpinned one reads unpinned', async () => {
    const { doc, cleanup, settle } = shell({ pins: ['Roadmap.md'] });
    try {
      filesView.loadFileContent('Roadmap.md', '# Roadmap\n');
      await settle();
      assert.strictEqual(doc.getElementById('editor-pin').getAttribute('aria-pressed'), 'true');
      filesView.loadFileContent('notes/backlog.md', '- a\n');
      await settle();
      assert.strictEqual(doc.getElementById('editor-pin').getAttribute('aria-pressed'), 'false');
    } finally { cleanup(); }
  });

  test('the control sits left of Preview and Edit, behind its own divider, and uses the toggle primitive', () => {
    const { doc, cleanup } = shell();
    try {
      const header = doc.getElementById('editor-header');
      const order = [...header.children].map(el => el.id || el.className);
      const pinAt = order.indexOf('editor-pin');
      assert.ok(pinAt >= 0, 'no pin control in the header');
      assert.ok(pinAt < order.indexOf('toggle-preview'), 'the control sits after Preview');
      assert.strictEqual(order[pinAt + 1], 'editor-header-divider', 'no divider between the control and the toggles');
      assert.ok(doc.getElementById('editor-pin').classList.contains('editor-toggle'), 'the control is not the .editor-toggle primitive');
      assert.strictEqual(doc.getElementById('editor-pin').getAttribute('onclick'), 'toggleCurrentFilePin()');
    } finally { cleanup(); }
  });

  test('activating the control with no file open sends nothing', () => {
    const { sent, cleanup } = shell({ currentFilePath: null });
    try {
      pinsView.toggleCurrentFilePin();
      assert.deepStrictEqual(sent, []);
    } finally { cleanup(); }
  });
});

describe('the row context menu offers Pin or Unpin for files only', () => {
  const menu = (doc) => doc.querySelector('.files-menu');
  const labels = (doc) => [...menu(doc).querySelectorAll('.files-menu-item')].map(b => text(b));
  const event = { clientX: 10, clientY: 10, preventDefault: () => {} };

  test('an unpinned file gets Pin, which sends pin_file', () => {
    const { doc, sent, cleanup } = shell({ pins: ['dash.html'] });
    try {
      filesView.openRowContextMenu(event, 'Roadmap.md', 'file');
      assert.ok(labels(doc).includes('Pin'), `no Pin row: ${labels(doc).join(', ')}`);
      assert.ok(!labels(doc).includes('Unpin'));
      // Grouped with the utility actions on an existing file, first in that
      // group, not among the creation rows above the divider.
      const items = [...menu(doc).children];
      const divider = items.findIndex(el => el.classList.contains('files-menu-divider'));
      const pin = items.findIndex(el => text(el) === 'Pin');
      assert.ok(divider >= 0 && pin === divider + 1, 'the Pin row is not first after the divider');
      assert.strictEqual(text(items[pin + 1]), 'Copy workspace path');
      click(items[pin]);
      assert.deepStrictEqual(sent, [{ type: 'pin_file', path: 'Roadmap.md' }]);
      assert.strictEqual(menu(doc), null, 'the menu stays open after the row');
    } finally { cleanup(); filesView.closeFilesMenu(); }
  });

  test('a pinned file gets Unpin, which sends unpin_file', () => {
    const { doc, sent, cleanup } = shell({ pins: ['Roadmap.md'] });
    try {
      filesView.openRowContextMenu(event, 'Roadmap.md', 'file');
      assert.ok(labels(doc).includes('Unpin'), `no Unpin row: ${labels(doc).join(', ')}`);
      assert.ok(!labels(doc).includes('Pin'));
      click([...menu(doc).querySelectorAll('.files-menu-item')].find(b => text(b) === 'Unpin'));
      assert.deepStrictEqual(sent, [{ type: 'unpin_file', path: 'Roadmap.md' }]);
    } finally { cleanup(); filesView.closeFilesMenu(); }
  });

  test('a folder gets neither', () => {
    const { doc, cleanup } = shell({ pins: ['notes'] });
    try {
      filesView.openRowContextMenu(event, 'notes', 'folder');
      assert.ok(!labels(doc).includes('Pin') && !labels(doc).includes('Unpin'), `a folder was offered a pin row: ${labels(doc).join(', ')}`);
      assert.ok(labels(doc).includes('Copy workspace path'), 'sanity: the rest of the menu is there');
    } finally { cleanup(); filesView.closeFilesMenu(); }
  });
});

describe('with nothing pinned, the pane says what pinning is for', () => {
  test('the pane carries the state, the mechanism, a next step naming both ways to pin, and the aside', () => {
    const { doc, cleanup } = shell({ pins: [] });
    try {
      const pane = text(doc.getElementById('pins-content'));
      assert.ok(pane.includes(PinsModel.EMPTY.lead));
      assert.ok(pane.includes(PinsModel.EMPTY.mechanism));
      assert.ok(pane.includes(PinsModel.EMPTY.nextStep));
      assert.ok(pane.includes(PinsModel.EMPTY.aside));
      assert.match(pane, /header/, 'the pane does not point at the header control');
      assert.match(pane, /right-click/, 'the pane does not point at the right-click row');
      assert.strictEqual(rows(doc).length, 0);
      // The sidebar teaches the same thing in fewer words, from the same copy.
      const quiet = text(doc.querySelector('#pin-list .sidebar-quiet'));
      assert.ok(quiet.includes(PinsModel.EMPTY.lead) && quiet.includes(PinsModel.EMPTY.nextStep));
    } finally { cleanup(); }
  });

  test('no banned word reaches the copy', () => {
    const BANNED = ['leverage', 'streamline', 'empower', 'utilize', 'robust', 'seamless', 'dive into', 'intuitive', 'effortless'];
    for (const s of [PinsModel.EMPTY.lead, PinsModel.EMPTY.mechanism, PinsModel.EMPTY.nextStep, PinsModel.EMPTY.aside, PinsModel.MISSING_NOTE, PinsModel.ALL_MISSING]) {
      for (const word of BANNED) assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(s), `"${word}" in "${s}"`);
    }
  });

  test('a pins reply that empties the list redraws the empty state', () => {
    const { doc, cleanup } = shell({ pins: ['Roadmap.md'] });
    try {
      assert.strictEqual(rows(doc).length, 1);
      pinsView.handlePinsReply([]);
      assert.strictEqual(rows(doc).length, 0);
      assert.ok(text(doc.getElementById('pins-content')).includes(PinsModel.EMPTY.lead));
    } finally { cleanup(); }
  });
});

describe('the arrival rule: the rail entry always opens onto something', () => {
  test('arriving with the open file already pinned keeps it open and records the Pins entry', () => {
    const { sent, shown, cleanup } = shell({ pins: ['dash.html', 'Roadmap.md'], currentFilePath: 'Roadmap.md' });
    try {
      pinsView.openPinsSection();
      assert.deepStrictEqual(sent, [], 'the open file was re-read');
      assert.deepStrictEqual(shown, ['editor']);
      assert.strictEqual(global.editorEntry, 'pins');
    } finally { cleanup(); }
  });

  test('arriving with pins and nothing pinned open opens the first pin', () => {
    const { sent, shown, cleanup } = shell({ pins: ['dash.html', 'Roadmap.md'], currentFilePath: 'notes/backlog.md' });
    try {
      pinsView.openPinsSection();
      assert.deepStrictEqual(sent, [{ type: 'read_file', path: 'dash.html' }]);
      assert.deepStrictEqual(shown, ['editor']);
      assert.strictEqual(global.editorEntry, 'pins');
    } finally { cleanup(); }
  });

  test('arriving with the first pin missing opens the first that can be opened', () => {
    const { sent, cleanup } = shell({ pins: ['gone.md', 'Roadmap.md'] });
    try {
      pinsView.openPinsSection();
      assert.deepStrictEqual(sent, [{ type: 'read_file', path: 'Roadmap.md' }]);
    } finally { cleanup(); }
  });

  test('arriving with zero pins shows the pane', () => {
    const { sent, shown, cleanup } = shell({ pins: [] });
    try {
      pinsView.openPinsSection();
      assert.deepStrictEqual(sent, []);
      assert.deepStrictEqual(shown, ['pins']);
    } finally { cleanup(); }
  });

  test('arriving with every pin missing shows the pane, which says so', () => {
    const { doc, shown, cleanup } = shell({ pins: ['gone.md', 'also-gone.md'] });
    try {
      pinsView.openPinsSection();
      assert.deepStrictEqual(shown, ['pins']);
      assert.ok(text(doc.getElementById('pins-content')).includes(PinsModel.ALL_MISSING));
    } finally { cleanup(); }
  });
});

describe('a pinned file that has gone stays in the list, marked, with a Remove', () => {
  // THE POLICY IS (a), as the view's header records: the row stays, marked
  // missing, with an explicit Remove. The store is written only by that
  // Remove, never by the tree arriving.
  test('delivering a tree without the pinned path marks the row and offers Remove', () => {
    const { doc, sent, shown, cleanup } = shell({ pins: ['Roadmap.md', 'notes/gone.md'] });
    try {
      const [present, missing] = rows(doc);
      assert.ok(!present.classList.contains('missing'));
      assert.ok(missing.classList.contains('missing'), 'a pin the tree does not carry is not marked');
      assert.ok(text(missing).includes(PinsModel.MISSING_NOTE));
      assert.ok(text(missing.querySelector('.pin-name')).includes('gone.md'), 'the row still names the file');
      assert.strictEqual(missing.querySelector('.pin-unpin'), null, 'a missing row offers the hover unpin instead of an explicit Remove');
      const remove = missing.querySelector('.pin-remove-btn');
      assert.strictEqual(text(remove), 'Remove');
      assert.deepStrictEqual(sent, [], 'the tree arriving wrote to the store');

      click(missing);
      assert.deepStrictEqual(sent, [], 'clicking a missing row opened a dead editor');
      assert.deepStrictEqual(shown, []);

      click(remove);
      assert.deepStrictEqual(sent, [{ type: 'unpin_file', path: 'notes/gone.md' }]);
    } finally { cleanup(); }
  });

  test('the mark clears on the next tree that carries the file again', () => {
    const { doc, cleanup } = shell({ pins: ['notes/gone.md'] });
    try {
      assert.ok(rows(doc)[0].classList.contains('missing'));
      pinsView.noteTreeForPins(TREE.concat([{ type: 'file', name: 'gone.md', kind: 'note', path: 'notes/gone.md' }]));
      assert.ok(!rows(doc)[0].classList.contains('missing'), 'a file that came back is still marked');
      assert.ok(rows(doc)[0].querySelector('.pin-unpin'), 'a present row has its hover unpin back');
    } finally { cleanup(); }
  });

  test('before the first tree arrives nothing is marked, so a slow tree does not read as lost pins', () => {
    const { doc, sent, cleanup } = shell({ pins: ['whatever.md'], tree: null });
    try {
      assert.strictEqual(rows(doc).length, 1);
      assert.ok(!rows(doc)[0].classList.contains('missing'));
    } finally { cleanup(); }
  });
});
