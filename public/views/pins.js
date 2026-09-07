'use strict';
// Pins view: the Files view with the tree swapped for a short list the reader
// chose. Same UMD pattern as files.js (node-requireable, window-attached),
// republishing every function on the root object because the rail's arm
// (openPinsSection), the client dispatch (handlePinsReply, requestPins), the
// tree renderer (noteTreeForPins), the editor open path
// (renderEditorPinControl), the header control's inline handler
// (toggleCurrentFilePin) and the row context menu (pinMenuRow) all reach these
// by bare name.
//
// WHAT THIS VIEW IS NOT. It is not a second viewer. A pinned row opens its
// file through the same read_file message and the same loadFileContent path a
// tree row uses, so a board renders as a board and an HTML file as an
// artifact with no branch here that knows the difference. The list is the
// only thing this file draws.
//
// WHERE THE RAIL LANDS. A permanent entry opens onto something, and the
// arrival rule is the list's own: arriving with the open file already pinned
// keeps it open; with pins present and nothing pinned open, the first pin
// that can be opened opens (the Skills precedent of picking the first item);
// with nothing to open, the pane says what pinning is for.
//
// WHICH ENTRY IS LIT. A file opened from this list sets editorEntry to
// 'pins', and navSectionFor in app.js reads that beside the table's editor
// row, so Pins stays lit and the Pins panel stays up while the file shows.
// Every Files opener sets it back. Nothing here touches the rail or a panel.
//
// MISSING-FILE POLICY, and it is (a): a pinned file the tree no longer
// carries stays in the list, marked missing, with a one-click Remove. The
// model's reconcile marks it on every tree arrival and removes nothing; the
// store is written only by a message the reader sent. The alternative,
// dropping the pin on the next tree arrival, is indistinguishable from
// Rundock losing the pin for no reason, and a reader whose file merely moved
// deserves to notice rather than to wonder.
//
// Shared state reached through the global lexical environment at call time:
// ws, currentFilePath, editorReturnView, editorEntry, fileHistory, TREE_ICONS,
// plus the helpers esc, showView, treeIconSvg, updateEditorBackButton, and
// the classic-script global RundockPinsModel.
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.RundockPinsView = factory();
    Object.assign(root, root.RundockPinsView);
  }
}(typeof self !== 'undefined' ? self : this, function () {

// The list as the server last sent it, in pin order, and the last tree it is
// read against. Both belong to the workspace on screen: requestPins clears
// them when a workspace opens, and the replies fill them back in.
let pinnedPaths = [];
let pinsTree = null;

function pinsModel() {
  return typeof RundockPinsModel !== 'undefined' ? RundockPinsModel : require('../pins-model.js');
}

function isPinned(filePath) {
  return pinsModel().has(pinnedPaths, filePath);
}

// Asked for beside the tree on every workspace open. The previous
// workspace's list is dropped first so nothing of it draws while the reply
// is in flight.
function requestPins() {
  pinnedPaths = [];
  pinsTree = null;
  renderPins();
  ws.send(JSON.stringify({ type: 'get_pins' }));
}

function handlePinsReply(list) {
  pinnedPaths = pinsModel().normalize(list);
  renderPins();
}

// Every tree arrival is a reconciliation: the rows are read against the tree
// the server just sent, so a file deleted or renamed outside Rundock is
// marked on the next push rather than on the next reload.
function noteTreeForPins(tree) {
  pinsTree = Array.isArray(tree) ? tree : [];
  renderPins();
}

function pinRows() {
  return pinsModel().reconcile(pinnedPaths, pinsTree);
}

function renderPins() {
  // Drawn by the sidebar and pane renderers, which arrive with the list.
}

// Open a pinned file: the same message and the same view a tree row sends,
// with the entry recorded so the rail stays on Pins.
function openPinnedFile(path) {
  editorEntry = 'pins';
  editorReturnView = 'editor';
  fileHistory = [];
  ws.send(JSON.stringify({ type: 'read_file', path }));
  showView('editor');
  updateEditorBackButton();
}

// The arrival rule, in the order the boundary states it.
function openPinsSection() {
  const rows = pinRows();
  const open = currentFilePath ? rows.find((r) => r.path === currentFilePath && !r.missing) : null;
  if (open) {
    editorEntry = 'pins';
    showView('editor');
    return;
  }
  const first = pinsModel().firstOpenable(rows);
  if (first) { openPinnedFile(first.path); return; }
  showView('pins');
}

return {
  requestPins, handlePinsReply, noteTreeForPins, pinRows, renderPins,
  openPinnedFile, openPinsSection,
};
}));
