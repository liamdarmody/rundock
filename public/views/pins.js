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
// 'pins', and showView in app.js reads that beside the table's editor row,
// so Pins stays lit and the Pins panel stays up while the file shows. Every
// Files opener sets it back. Nothing here touches the rail or a panel.
//
// MISSING-FILE POLICY, and it is (a): a pinned file the tree no longer
// carries stays in the list, marked missing, with a one-click Remove. The
// model's reconcile marks it on every tree arrival and removes nothing; the
// store is written only by a message the reader sent. The alternative,
// dropping the pin on the next tree arrival, is indistinguishable from
// Rundock losing the pin for no reason, and a reader whose file merely moved
// deserves to notice rather than to wonder.
//
// THE ROW'S SHAPE follows the mock: the tree's own file icon, the name, the
// folder underneath in a smaller face, a filled pin at rest that the hover
// unpin control replaces in the same slot, which is the idiom the
// conversation list already uses for its own curated rows. No add button in
// the sidebar: a pin is made from a file already open (the header control) or
// from the tree (the row's right-click), never from this list.
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

// The glyph a missing row carries in place of the file icon: the file is not
// there to have a kind.
const MISSING_ICON = '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>';

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

// Every reply carries the whole list, so every reply redraws the whole list
// and the header control that reads it.
function handlePinsReply(list) {
  pinnedPaths = pinsModel().normalize(list);
  renderPins();
  renderEditorPinControl();
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
  const rows = pinRows();
  renderPinsSidebar(rows);
  renderPinsPane(rows);
}

function renderPinsSidebar(rows) {
  const list = document.getElementById('pin-list');
  if (!list) return;
  const model = pinsModel();
  list.innerHTML = '';
  if (!rows.length) {
    // The sidebar teaches in fewer words than the pane, from the same copy.
    const quiet = document.createElement('div');
    quiet.className = 'sidebar-quiet pins-quiet';
    quiet.innerHTML = `<b>${esc(model.EMPTY.lead)}</b> ${esc(model.EMPTY.mechanism)}<br><br>${esc(model.EMPTY.nextStep)}`;
    list.appendChild(quiet);
    return;
  }
  for (const row of rows) {
    const el = document.createElement('div');
    el.className = 'pin-item' + (row.missing ? ' missing' : '') + (!row.missing && row.path === currentFilePath ? ' active' : '');
    el.dataset.path = row.path;
    const icon = row.missing ? treeIconSvg(MISSING_ICON) : treeIconSvg(TREE_ICONS[row.kind] || TREE_ICONS.file);
    const under = row.missing
      ? `<span class="pin-path pin-missing-note">${esc(model.MISSING_NOTE)}</span>`
      : (row.folder ? `<span class="pin-path">${esc(row.folder)}/</span>` : '');
    el.innerHTML = `${icon}<div class="pin-body"><span class="pin-name">${esc(row.name)}</span>${under}</div>`;
    if (row.missing) {
      // Not a link to a dead editor: the row does nothing but offer Remove.
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'pin-remove-btn';
      remove.textContent = 'Remove';
      remove.addEventListener('click', (e) => { e.stopPropagation(); unpinPath(row.path); });
      el.appendChild(remove);
    } else {
      el.insertAdjacentHTML('beforeend', model.glyphSvg(true, 'pin-static'));
      const unpin = document.createElement('button');
      unpin.type = 'button';
      unpin.className = 'pin-unpin';
      unpin.title = 'Unpin';
      unpin.setAttribute('aria-label', 'Unpin');
      unpin.innerHTML = model.glyphSvg(true);
      unpin.addEventListener('click', (e) => { e.stopPropagation(); unpinPath(row.path); });
      el.appendChild(unpin);
      el.addEventListener('click', () => openPinnedFile(row.path));
    }
    list.appendChild(el);
  }
}

// The pane is on screen only when there is no pin to open, so it carries the
// empty state, or the one line for a list whose every file has gone.
function renderPinsPane(rows) {
  const pane = document.getElementById('pins-content');
  if (!pane) return;
  const model = pinsModel();
  if (!rows.length) {
    const state = model.emptyState();
    pane.innerHTML = `<div class="pins-empty">
      <p class="pins-empty-lead">${esc(state.lead)}</p>
      <p class="pins-empty-body">${esc(state.body)}</p>
      <p class="pins-empty-aside">${esc(state.aside)}</p>
    </div>`;
    return;
  }
  if (!model.firstOpenable(rows)) {
    pane.innerHTML = `<div class="pins-empty"><p class="pins-empty-lead">${esc(model.ALL_MISSING)}</p></div>`;
    return;
  }
  pane.innerHTML = '';
}

function highlightPinRow(filePath) {
  document.querySelectorAll('.pin-item.active').forEach((el) => el.classList.remove('active'));
  const row = Array.from(document.querySelectorAll('.pin-item')).find((el) => el.dataset.path === filePath);
  if (row && !row.classList.contains('missing')) row.classList.add('active');
}

// Open a pinned file: the same message and the same view a tree row sends,
// with the entry recorded so the rail stays on Pins.
function openPinnedFile(path) {
  editorEntry = 'pins';
  editorReturnView = 'editor';
  fileHistory = [];
  highlightPinRow(path);
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
    highlightPinRow(currentFilePath);
    showView('editor');
    return;
  }
  const first = pinsModel().firstOpenable(rows);
  if (first) { openPinnedFile(first.path); return; }
  showView('pins');
}

function unpinPath(path) {
  ws.send(JSON.stringify({ type: 'unpin_file', path }));
}

// Pin or unpin a path, whichever the list says is the other one.
function sendPinToggle(path) {
  ws.send(JSON.stringify({ type: isPinned(path) ? 'unpin_file' : 'pin_file', path }));
}

// The header control's handler: the open file, if there is one.
function toggleCurrentFilePin() {
  if (!currentFilePath) return;
  sendPinToggle(currentFilePath);
}

// The header control reads the open file against the list. Called on every
// open (from loadFileContent) and on every pins reply, so it can never show
// yesterday's answer for today's file.
function renderEditorPinControl() {
  const control = document.getElementById('editor-pin');
  if (!control) return;
  const pinned = !!currentFilePath && isPinned(currentFilePath);
  control.setAttribute('aria-pressed', pinned ? 'true' : 'false');
  control.setAttribute('aria-label', pinned ? 'Unpin' : 'Pin');
  control.title = pinned ? 'Unpin' : 'Pin';
  control.classList.toggle('pinned', pinned);
  control.innerHTML = pinsModel().glyphSvg(pinned);
  highlightPinRow(currentFilePath);
}

// The row the tree's context menu adds for a file: label by state, message
// by state, in the [label, fn, icon] shape buildFloatingMenu reads. The
// filled glyph is the outline glyph's paths with a fill on each, because
// the menu's icon frame fixes fill="none" on the svg.
function pinMenuRow(targetPath) {
  const model = pinsModel();
  const pinned = isPinned(targetPath);
  const icon = pinned ? model.GLYPH.replace(/<path /g, '<path fill="currentColor" ') : model.GLYPH;
  return [pinned ? 'Unpin' : 'Pin', () => sendPinToggle(targetPath), icon];
}

return {
  isPinned, requestPins, handlePinsReply, noteTreeForPins, pinRows, renderPins,
  highlightPinRow, openPinnedFile, openPinsSection, unpinPath, sendPinToggle,
  toggleCurrentFilePin, renderEditorPinControl, pinMenuRow,
};
}));
