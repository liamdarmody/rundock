// Kanban board view: renders a markdown board file (frontmatter carries the
// kanban-plugin key) as columns of cards, and serializes every edit back to
// byte-compatible markdown through kanban.js. The board view owns no state that
// is not in the file: the parsed model IS the state, and getContentForSave
// re-serializes it.
//
// Mount contract (shared with the other registry viewers):
//   mount({ paneElement, path, content }) -> { getContentForSave, destroy }
// getContentForSave is non-null: the board participates in autosave/Cmd+S like
// the editor, and the external-edit guard protects concurrent disk changes.
//
// This first increment: render (rich card text), drag between columns, add
// card, checkbox toggle. Lane menus, in-place card editing, collapse, and undo
// build on this model in follow-ups.

import { renderCardHtml } from './board-markdown.js';
import { createEditorInstance } from '../editor/factory.js';
import { attachFloatingToolbar } from '../editor/panels/floating-toolbar.js';

let stylesInjected = false;
function ensureStyles(doc) {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = doc.createElement('style');
  style.dataset.rundockBoard = '';
  style.textContent = `
    .board-host { padding: 0 !important; display: flex; flex-direction: column; overflow: hidden; }
    .board-scroll { flex: 1; display: flex; gap: 16px; align-items: flex-start; padding: 20px; overflow-x: auto; overflow-y: hidden; }
    .board-lane { flex: 0 0 300px; max-height: 100%; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
    .board-lane-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--border); }
    .board-lane-collapse { display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; flex: 0 0 auto; border-radius: 6px; color: var(--text-2); }
    .board-lane-collapse:hover { color: var(--text-1); background: var(--elevated); }
    .board-lane.collapsed { flex: 0 0 42px; cursor: pointer; }
    .board-lane.collapsed .board-lane-head { flex-direction: column; height: 100%; padding: 12px 8px; gap: 12px; border-bottom: none; align-items: center; }
    .board-lane.collapsed .board-lane-title { writing-mode: vertical-rl; transform: rotate(180deg); white-space: nowrap; overflow: visible; }
    .board-lane.collapsed .board-lane-count { margin-left: 0; }
    .board-lane.collapsed .board-lane-menu-btn { display: none; }
    .board-lane-title { font-size: var(--body); font-weight: 600; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .board-lane-count { font-size: var(--caption); color: var(--text-2); font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; margin-left: auto; }
    .board-lane-menu-btn { display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 6px; color: var(--text-2); }
    .board-lane-menu-btn:hover { color: var(--text-1); background: var(--elevated); }
    .board-lane-rename { flex: 1; min-width: 0; background: var(--elevated); border: 1px solid var(--accent); border-radius: 6px; color: var(--text-1); font-size: var(--body); font-weight: 600; padding: 3px 8px; outline: none; }
    .board-lane-popup { position: absolute; z-index: 10; min-width: 180px; padding: 4px; background: var(--card); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.25); display: flex; flex-direction: column; }
    .board-lane-popup-divider { height: 1px; background: var(--border); margin: 4px 6px; }
    .board-lane-popup-item { text-align: left; padding: 7px 10px; border-radius: 6px; color: var(--text-1); font-size: var(--body); }
    .board-lane-popup-item:hover { background: var(--elevated); }
    .board-lane-popup-item.danger:hover { color: var(--danger, #E85A5A); }
    .board-lane-body { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; min-height: 24px; }
    /* Insertion indicator: an accent line at the gap the card would drop into. */
    .board-lane-body.insert-end { box-shadow: inset 0 -3px 0 -1px var(--accent); }
    .board-card { position: relative; background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; font-size: var(--body); color: var(--text-1); line-height: 1.5; cursor: grab; }
    .board-card:hover { border-color: var(--text-2); }
    .board-card.dragging { opacity: 0.4; }
    .board-card-controls { position: absolute; top: 6px; right: 6px; display: none; gap: 2px; }
    .board-card:hover .board-card-controls { display: flex; }
    .board-card.editing .board-card-controls { display: none; }
    .board-card-ctl { display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 6px; color: var(--text-2); background: var(--surface); }
    .board-card-ctl:hover { color: var(--danger, #E85A5A); background: var(--elevated); }
    .board-card.editing { cursor: default; }
    .board-card-edit { width: 100%; box-sizing: border-box; resize: none; background: var(--elevated); border: 1px solid var(--accent); border-radius: 6px; color: var(--text-1); font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; font-size: 13px; line-height: 1.5; padding: 8px 10px; outline: none; cursor: text; }
    .board-card-editor { background: var(--elevated); border: 1px solid var(--accent); border-radius: 6px; padding: 6px 10px; cursor: text; }
    .board-card-editor .ProseMirror { cursor: text; }
    .board-card-editor .ProseMirror { outline: none; font-size: var(--body); line-height: 1.5; color: var(--text-1); min-height: 1.4em; overflow-wrap: anywhere; }
    .board-card-editor .ProseMirror p { margin: 0; }
    .board-card-editor .ProseMirror p + p { margin-top: 4px; }
    .board-card-editor .ProseMirror a { color: var(--accent); text-decoration: none; }
    .board-card-editor .ProseMirror code { font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; font-size: 12px; background: var(--card); padding: 1px 4px; border-radius: 4px; }
    .board-undo-toast { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 8; display: flex; align-items: center; gap: 12px; padding: 8px 12px 8px 16px; border-radius: 8px; background: var(--card); border: 1px solid var(--border); box-shadow: 0 4px 16px rgba(0,0,0,0.25); font-size: var(--body); color: var(--text-1); }
    .board-undo-btn { color: var(--accent); font-weight: 600; padding: 4px 8px; border-radius: 6px; }
    .board-undo-btn:hover { background: var(--accent-glow); }
    .board-card-row { display: flex; gap: 8px; align-items: flex-start; }
    .board-card-check { flex: 0 0 auto; margin-top: 2px; width: 15px; height: 15px; cursor: pointer; accent-color: var(--accent); }
    .board-card-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .board-card-text.checked { color: var(--text-2); text-decoration: line-through; }
    .board-card-text a { color: var(--accent); text-decoration: none; }
    .board-card-text a:hover { text-decoration: underline; }
    .board-card-text code { font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; font-size: 12px; background: var(--elevated); padding: 1px 4px; border-radius: 4px; }
    .board-card-text .board-tag { display: inline-block; padding: 0 7px; border-radius: 100px; background: var(--accent-glow, rgba(232,122,90,0.14)); color: var(--accent); font-size: 12px; font-weight: 500; white-space: nowrap; }
    .board-card-text .board-date { color: var(--text-2); font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; font-size: 12px; }
    .board-card.insert-before::before, .board-card.insert-after::after { content: ''; position: absolute; left: 0; right: 0; height: 2px; border-radius: 2px; background: var(--accent); }
    .board-card.insert-before::before { top: -5px; }
    .board-card.insert-after::after { bottom: -5px; }
    /* Add-card composer: the standing small-input grammar (field is the input,
       accent border on focus, circular submit inside, faded when empty). */
    .board-add { margin: 8px; position: relative; }
    .board-add-field { width: 100%; display: flex; align-items: flex-start; background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 8px 36px 8px 10px; transition: border-color 0.15s ease; }
    .board-add-field:focus-within { border-color: var(--accent); }
    .board-add textarea { flex: 1; resize: none; border: none; background: transparent; color: var(--text-1); font-family: inherit; font-size: var(--body); line-height: 1.5; outline: none; max-height: 160px; }
    .board-add textarea::placeholder { color: var(--text-2); }
    .board-add-submit { position: absolute; right: 8px; bottom: 8px; width: 24px; height: 24px; border-radius: 100px; display: flex; align-items: center; justify-content: center; background: var(--border); color: var(--text-2); opacity: 0.6; transition: background 0.15s ease, opacity 0.15s ease; }
    .board-add-field:focus-within .board-add-submit.ready, .board-add-submit.ready { background: var(--accent); color: #fff; opacity: 1; box-shadow: 0 2px 8px rgba(232,122,90,0.30); }
    .board-add-open { margin: 4px 8px 8px; padding: 8px 10px; border-radius: 8px; color: var(--text-2); font-size: var(--body); text-align: left; }
    .board-add-open:hover { background: var(--elevated); color: var(--text-1); }
    /* Trailing "Add a list" column: always present at the end of the row, so it
       doubles as the empty-board state (a board with zero lists shows only this,
       which is the only way to add the first column). */
    .board-add-lane { flex: 0 0 272px; align-self: flex-start; }
    .board-add-lane-empty { flex: 0 0 320px; }
    .board-add-lane-open { width: 100%; padding: 12px 14px; border: 1px dashed var(--border); border-radius: 12px; color: var(--text-2); font-size: var(--body); text-align: left; background: transparent; transition: color .15s ease, background .15s ease, border-color .15s ease; }
    .board-add-lane-open:hover { color: var(--text-1); background: var(--surface); border-color: var(--text-2); }
    .board-add-lane .board-add-field { background: var(--surface); }
    .board-add-lane-input { flex: 1; min-width: 0; border: none; background: transparent; color: var(--text-1); font: inherit; font-size: var(--body); outline: none; }
    .board-dropped-warn { margin: 8px 20px; padding: 10px 14px; border-radius: 8px; background: rgba(232,168,76,0.12); border: 1px solid rgba(232,168,76,0.35); color: var(--text-1); font-size: var(--caption); }
  `;
  doc.head.appendChild(style);
}

// Lucide-style inline SVG from a list of path `d` strings (24 viewBox, 1.8
// stroke, round caps): never a unicode glyph.
function iconSvg(doc, paths) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of paths) {
    const p = doc.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

// icon: a small lucide-style plus, inline SVG (24 viewBox, stroke 1.8)
function plusIcon(doc) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of ['M12 5v14', 'M5 12h14']) {
    const p = doc.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

// Pure: the corrected insertion index for a card move (drop indices are
// pre-removal positions), or -1 for a no-op (a card dropped back onto its own
// position within the same lane). When moving down within a lane, the target
// shifts left by one because the card is removed before it is re-inserted.
export function reorderTargetIndex(fromLane, fromIndex, toLane, toIndex) {
  let target = toIndex;
  if (fromLane === toLane && fromIndex < toIndex) target -= 1;
  if (fromLane === toLane && target === fromIndex) return -1;
  return target;
}

export function mountBoardView({ paneElement, content, onWikilink }, Kanban) {
  const doc = paneElement.ownerDocument;
  ensureStyles(doc);
  paneElement.innerHTML = '';
  paneElement.classList.add('viewer-host', 'board-host');

  let board = Kanban.parse(String(content == null ? '' : content));

  // Drag state: {fromLane, fromIndex}. Re-renders are deferred past dragend so
  // macOS does not play the ~400ms snap-back ghost.
  let drag = null;
  // The live insertion point while dragging: { lane, index }. Computed from the
  // cursor's position relative to each card's midpoint, so a card can be
  // dropped anywhere over another card (or the empty area) and it lands at the
  // nearest gap, with a visible accent line at that gap.
  let dropTarget = null;
  let onChange = () => {};

  function clearDropMarkers() {
    scroll.querySelectorAll('.board-card.insert-before, .board-card.insert-after')
      .forEach((c) => c.classList.remove('insert-before', 'insert-after'));
    scroll.querySelectorAll('.board-lane-body.insert-end')
      .forEach((b) => b.classList.remove('insert-end'));
  }

  const scroll = doc.createElement('div');
  scroll.className = 'board-scroll';
  paneElement.appendChild(scroll);

  function render() {
    // Any board change dismisses a pending undo (withUndo re-shows its toast
    // AFTER this render), so an Undo can only ever revert the immediately
    // preceding destructive op, never silently discard later edits.
    const staleToast = paneElement.querySelector('.board-undo-toast');
    if (staleToast) staleToast.remove();
    scroll.innerHTML = '';
    board.lanes.forEach((lane, laneIndex) => scroll.appendChild(renderLane(lane, laneIndex)));
    scroll.appendChild(renderAddLane());
    const oldWarn = paneElement.querySelector('.board-dropped-warn');
    if (oldWarn) oldWarn.remove(); // never stack banners across renders
    if (board.dropped && board.dropped.length) {
      const warn = doc.createElement('div');
      warn.className = 'board-dropped-warn';
      warn.textContent = `This board contains ${board.dropped.length} line(s) that the board grammar cannot represent. They are preserved on screen but editing here could drop them, so saving is disabled until they are removed in the source.`;
      paneElement.insertBefore(warn, scroll);
    }
  }

  function isCollapsed(laneIndex) {
    const lc = board.settings && board.settings['list-collapse'];
    return Array.isArray(lc) && lc[laneIndex] === true;
  }

  function renderLane(lane, laneIndex) {
    const el = doc.createElement('div');
    const collapsed = isCollapsed(laneIndex);
    el.className = 'board-lane' + (collapsed ? ' collapsed' : '');
    el.dataset.lane = String(laneIndex);

    const head = doc.createElement('div');
    head.className = 'board-lane-head';
    // Collapse/expand toggle (a chevron). Persists to list-collapse.
    const collapseBtn = doc.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.className = 'board-lane-collapse';
    collapseBtn.title = collapsed ? 'Expand list' : 'Collapse list';
    collapseBtn.appendChild(iconSvg(doc, collapsed ? ['M9 6l6 6-6 6'] : ['M6 9l6 6 6-6']));
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      Kanban.toggleCollapse(board, laneIndex);
      onChange();
      render();
    });
    const title = doc.createElement('span');
    title.className = 'board-lane-title';
    title.textContent = lane.title + (lane.maxItems ? ` (${lane.maxItems})` : '');
    const count = doc.createElement('span');
    count.className = 'board-lane-count';
    count.textContent = String(lane.items.length);
    const menuBtn = doc.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'board-lane-menu-btn';
    menuBtn.title = 'List actions';
    menuBtn.appendChild(iconSvg(doc, ['M12 5.5a.6.6 0 100-1.2.6.6 0 000 1.2', 'M12 12.6a.6.6 0 100-1.2.6.6 0 000 1.2', 'M12 19.7a.6.6 0 100-1.2.6.6 0 000 1.2']));
    menuBtn.addEventListener('click', (e) => { e.stopPropagation(); openLaneMenu(menuBtn, laneIndex); });
    head.appendChild(collapseBtn);
    head.appendChild(title);
    head.appendChild(count);
    head.appendChild(menuBtn);
    // Double-click the title to rename in place.
    title.addEventListener('dblclick', () => renameLaneInline(head, title, laneIndex));
    el.appendChild(head);

    // A collapsed lane is a narrow rail: just the head. Clicking it expands.
    if (collapsed) {
      el.addEventListener('click', () => { Kanban.toggleCollapse(board, laneIndex); onChange(); render(); });
      return el;
    }

    const body = doc.createElement('div');
    body.className = 'board-lane-body';
    lane.items.forEach((item, itemIndex) => body.appendChild(renderCard(item, laneIndex, itemIndex)));
    el.appendChild(body);

    el.appendChild(addComposer(laneIndex));

    // Dragging over the empty area of a lane (below the cards, or an empty
    // lane) inserts at the end. Cards stop propagation for their own midpoint
    // logic, so this only fires when the cursor is not over a card.
    body.addEventListener('dragover', (e) => {
      if (!drag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearDropMarkers();
      body.classList.add('insert-end');
      dropTarget = { lane: laneIndex, index: lane.items.length };
    });
    el.addEventListener('drop', (e) => {
      if (!drag || !dropTarget) return;
      e.preventDefault();
      const t = dropTarget;
      clearDropMarkers();
      commitMove(t.lane, t.index);
    });
    return el;
  }

  function renderCard(item, laneIndex, itemIndex) {
    const card = doc.createElement('div');
    card.className = 'board-card';
    card.draggable = true;

    const row = doc.createElement('div');
    row.className = 'board-card-row';
    const check = doc.createElement('input');
    check.type = 'checkbox';
    check.className = 'board-card-check';
    check.checked = item.checked;
    check.addEventListener('change', () => {
      Kanban.toggleItem(board, laneIndex, itemIndex);
      onChange();
      render();
    });
    const text = doc.createElement('div');
    text.className = 'board-card-text' + (item.checked ? ' checked' : '');
    text.innerHTML = renderCardHtml(item.titleRaw);
    // Click the card text to edit in place (a click on a wikilink does not
    // edit; navigation is wired separately).
    text.addEventListener('click', (e) => {
      const wl = e.target.closest && e.target.closest('a.board-wikilink');
      if (wl) { if (typeof onWikilink === 'function') onWikilink(wl.getAttribute('data-target') || ''); return; }
      enterCardEdit(card, laneIndex, itemIndex);
    });
    row.appendChild(check);
    row.appendChild(text);

    const controls = doc.createElement('div');
    controls.className = 'board-card-controls';
    const del = doc.createElement('button');
    del.type = 'button';
    del.className = 'board-card-ctl';
    del.title = 'Delete card';
    del.appendChild(iconSvg(doc, ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v6', 'M14 11v6']));
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteCardWithUndo(laneIndex, itemIndex); });
    controls.appendChild(del);
    card.appendChild(controls);

    card.appendChild(row);

    // Insert before or after this card based on which half the cursor is in.
    card.addEventListener('dragover', (e) => {
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation(); // this card owns the insertion point, not the lane end
      e.dataTransfer.dropEffect = 'move';
      const rect = card.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      clearDropMarkers();
      card.classList.add(after ? 'insert-after' : 'insert-before');
      dropTarget = { lane: laneIndex, index: after ? itemIndex + 1 : itemIndex };
    });

    card.addEventListener('dragstart', (e) => {
      drag = { fromLane: laneIndex, fromIndex: itemIndex };
      dropTarget = null;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', ''); } catch (err) {}
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      drag = null;
      dropTarget = null;
      clearDropMarkers();
      // Defer the re-render one frame past dragend so the drop animation
      // settles (avoids the snap-back ghost).
      requestAnimationFrame(() => render());
    });
    return card;
  }

  // Move the dragged card to (toLane, toIndex), correcting the target index for
  // the removal when moving within the same lane below the source.
  function commitMove(toLane, toIndex) {
    if (!drag) return;
    const { fromLane, fromIndex } = drag;
    const target = reorderTargetIndex(fromLane, fromIndex, toLane, toIndex);
    drag = null;
    if (target < 0) return; // dropped back onto its own position: no-op
    Kanban.moveItem(board, fromLane, fromIndex, toLane, target);
    onChange();
    render();
  }

  // In-place card edit. The card's markdown opens in a rich editor: formatting
  // (bold, links, wikilinks) renders as you type instead of raw syntax. Enter
  // saves, Shift+Enter inserts a line, Esc cancels, click-away saves. On save
  // the editor serializes back to markdown that feeds titleRaw straight through
  // the byte-exact board serializer (updateItem), so the round-trip is honest.
  function enterCardEdit(card, laneIndex, itemIndex) {
    if (card.querySelector('.board-card-editor, textarea.board-card-edit')) return;
    const item = board.lanes[laneIndex] && board.lanes[laneIndex].items[itemIndex];
    if (!item) return;
    const row = card.querySelector('.board-card-row');
    const host = doc.createElement('div');
    host.className = 'board-card-editor';
    row.replaceWith(host);
    card.draggable = false;
    card.classList.add('editing'); // swap the grab cursor for a text caret
    const editor = createEditorInstance({ element: host, initialBody: item.titleRaw });
    // The rich editor is only safe where it represents the card faithfully.
    // A card with constructs its serializer would reformat (nested checkboxes,
    // code blocks) falls back to the plain textarea, so merely opening a card
    // can never corrupt the byte-exact board markdown.
    if (editor.storage.markdown.getMarkdown().replace(/\n+$/, '') !== item.titleRaw) {
      try { editor.destroy(); } catch (e) { /* noop */ }
      enterCardEditPlain(card, host, laneIndex, itemIndex, item);
      return;
    }
    editor.commands.focus('end');
    // Selection toolbar (bold/italic/code/link), viewport-anchored so it clears
    // the board's nested scroll. Removed with the editor. Clear any stray one
    // first (e.g. if a prior edit was interrupted by a view switch).
    doc.querySelectorAll('.board-card-toolbar').forEach((t) => t.remove());
    const toolbar = doc.createElement('div');
    toolbar.className = 'floating-toolbar board-card-toolbar';
    doc.body.appendChild(toolbar);
    const detachToolbar = attachFloatingToolbar({
      toolbarElement: toolbar, editor,
      buttonIds: ['bold', 'italic', 'code', 'link'], fixed: true,
    });
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const next = commit ? editor.storage.markdown.getMarkdown().replace(/\n+$/, '') : null;
      try { detachToolbar(); } catch (e) { /* noop */ }
      toolbar.remove();
      try { editor.destroy(); } catch (e) { /* already torn down */ }
      if (commit && next != null && next.trim() !== item.titleRaw.trim()) {
        Kanban.updateItem(board, laneIndex, itemIndex, next);
        onChange();
      }
      render();
    };
    // Preserve the card grammar over the editor's own keymap: a capture-phase
    // listener pre-empts the editor so Enter commits (Shift+Enter still inserts
    // a line) and Esc cancels.
    host.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.stopPropagation(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    }, true);
    editor.on('blur', () => finish(true)); // click-away saves
  }

  // Plain-textarea editor: the byte-exact fallback for cards the rich editor
  // cannot round-trip. Same grammar as the rich path (Enter saves, Shift+Enter
  // a line, Esc cancels, click-away saves); the raw text feeds updateItem.
  function enterCardEditPlain(card, host, laneIndex, itemIndex, item) {
    const ta = doc.createElement('textarea');
    ta.className = 'board-card-edit';
    ta.value = item.titleRaw;
    host.replaceWith(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    grow();
    ta.addEventListener('input', grow);
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      if (commit && ta.value.trim() !== item.titleRaw.trim()) {
        Kanban.updateItem(board, laneIndex, itemIndex, ta.value);
        onChange();
      }
      render();
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    ta.addEventListener('blur', () => finish(true));
  }

  // Lane (three-dot) menu: every column operation the serializer supports.
  // Destructive ones (archive, delete) run through withUndo.
  let openMenu = null;
  function closeLaneMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
  // The lane menu joins the shared close signal so opening any other menu (or
  // this one again) dismisses it, and only one menu is ever open.
  doc.addEventListener('rundock:closemenus', closeLaneMenu);

  function openLaneMenu(anchor, laneIndex) {
    if (openMenu) { closeLaneMenu(); return; } // the button toggles
    doc.dispatchEvent(new CustomEvent('rundock:closemenus')); // dismiss any other open menu
    const lane = board.lanes[laneIndex];
    if (!lane) return;
    const menu = doc.createElement('div');
    menu.className = 'board-lane-popup';
    // Grouped by what the action affects, with the destructive group set apart
    // by a divider so Delete never sits flush against a benign action.
    const groups = [
      [ // this list's identity and position
        ['Rename list', () => renameLaneInline(anchor.closest('.board-lane-head'), anchor.closest('.board-lane-head').querySelector('.board-lane-title'), laneIndex)],
        ...(laneIndex > 0 ? [['Move list left', () => { Kanban.moveLane(board, laneIndex, laneIndex - 1); onChange(); render(); }]] : []),
        ...(laneIndex < board.lanes.length - 1 ? [['Move list right', () => { Kanban.moveLane(board, laneIndex, laneIndex + 1); onChange(); render(); }]] : []),
      ],
      [ // create adjacent lists
        ['Insert list before', () => { Kanban.insertLane(board, laneIndex, 'New list'); onChange(); render(); }],
        ['Insert list after', () => { Kanban.insertLane(board, laneIndex + 1, 'New list'); onChange(); render(); }],
      ],
      [ // reorder the cards inside
        ['Sort by card text', () => { Kanban.sortLane(board, laneIndex, 'text'); onChange(); render(); }],
        ['Sort by tags', () => { Kanban.sortLane(board, laneIndex, 'tags'); onChange(); render(); }],
      ],
      [ // destructive
        ['Archive all cards', () => withUndo('Cards archived', () => Kanban.archiveLaneCards(board, laneIndex))],
        ['Archive list', () => withUndo('List archived', () => Kanban.archiveLane(board, laneIndex))],
        ['Delete list', () => withUndo('List deleted', () => Kanban.deleteLane(board, laneIndex))],
      ],
    ];
    groups.forEach((group, gi) => {
      if (gi > 0) {
        const divider = doc.createElement('div');
        divider.className = 'board-lane-popup-divider';
        menu.appendChild(divider);
      }
      for (const [label, fn] of group) {
        const row = doc.createElement('button');
        row.type = 'button';
        row.className = 'board-lane-popup-item' + (/^(Archive|Delete)/.test(label) ? ' danger' : '');
        row.textContent = label;
        row.addEventListener('click', (e) => { e.stopPropagation(); closeLaneMenu(); fn(); });
        menu.appendChild(row);
      }
    });
    const r = anchor.getBoundingClientRect();
    const host = paneElement.getBoundingClientRect();
    menu.style.top = (r.bottom - host.top + 4) + 'px';
    menu.style.left = Math.max(4, r.right - host.left - 180) + 'px';
    paneElement.appendChild(menu);
    openMenu = menu;
    // Close on the next document click (this click is still propagating, so
    // defer the listener registration by a tick).
  }

  function renameLaneInline(head, titleEl, laneIndex) {
    closeLaneMenu();
    const lane = board.lanes[laneIndex];
    if (!lane || head.querySelector('input.board-lane-rename')) return;
    const input = doc.createElement('input');
    input.className = 'board-lane-rename';
    input.value = lane.maxItems ? `${lane.title} (${lane.maxItems})` : lane.title;
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (commit && v) { try { Kanban.renameLane(board, laneIndex, v); onChange(); } catch (e) {} }
      render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  // Run a destructive mutation with a single-level, in-session undo. Undo
  // restores a full snapshot of the board taken before the mutation, so it is
  // correct for card and lane operations alike (the closure's board is
  // reassigned; getContentForSave serializes whatever board currently is).
  function withUndo(label, mutate) {
    const snapshot = Kanban.serialize(board);
    mutate();
    onChange();
    render();
    showUndoToast(label, () => {
      board = Kanban.parse(snapshot);
      onChange();
      render();
    });
  }

  function deleteCardWithUndo(laneIndex, itemIndex) {
    if (!board.lanes[laneIndex] || !board.lanes[laneIndex].items[itemIndex]) return;
    withUndo('Card deleted', () => Kanban.deleteItem(board, laneIndex, itemIndex));
  }

  let undoTimer = null;
  function showUndoToast(label, undoFn) {
    const existing = paneElement.querySelector('.board-undo-toast');
    if (existing) existing.remove();
    clearTimeout(undoTimer);
    const toast = doc.createElement('div');
    toast.className = 'board-undo-toast';
    const msg = doc.createElement('span');
    msg.textContent = label;
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'board-undo-btn';
    btn.textContent = 'Undo';
    btn.addEventListener('click', () => { clearTimeout(undoTimer); toast.remove(); undoFn(); });
    toast.appendChild(msg);
    toast.appendChild(btn);
    paneElement.appendChild(toast);
    undoTimer = setTimeout(() => toast.remove(), 6000);
  }

  // Trailing "Add a list" column. Mirrors the add-card composer grammar (open
  // button -> inline field -> Enter/submit commits, Escape/empty-blur cancels)
  // but adds a lane via Kanban.insertLane. Always rendered, so an empty board
  // (zero lists) can be built and a fully-deleted board is never a dead end.
  function renderAddLane() {
    const empty = board.lanes.length === 0;
    const wrap = doc.createElement('div');
    wrap.className = 'board-add-lane' + (empty ? ' board-add-lane-empty' : '');
    const openBtn = doc.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'board-add-lane-open';
    openBtn.textContent = empty ? '+ Add your first list' : '+ Add list';
    wrap.appendChild(openBtn);

    openBtn.addEventListener('click', () => {
      wrap.innerHTML = '';
      const field = doc.createElement('div');
      field.className = 'board-add-field';
      const input = doc.createElement('input');
      input.type = 'text';
      input.placeholder = 'List name';
      input.className = 'board-add-lane-input';
      const submit = doc.createElement('button');
      submit.type = 'button';
      submit.className = 'board-add-submit';
      submit.appendChild(plusIcon(doc));
      field.appendChild(input);
      field.appendChild(submit);
      wrap.appendChild(field);
      input.focus();
      input.addEventListener('input', () => submit.classList.toggle('ready', input.value.trim().length > 0));
      const commit = () => {
        const v = input.value.trim();
        if (v) { Kanban.insertLane(board, board.lanes.length, v); onChange(); }
        render();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); render(); }
      });
      submit.addEventListener('mousedown', (e) => { e.preventDefault(); commit(); });
      input.addEventListener('blur', () => { if (!input.value.trim()) render(); });
    });
    return wrap;
  }

  function addComposer(laneIndex) {
    const wrap = doc.createElement('div');
    const openBtn = doc.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'board-add-open';
    openBtn.textContent = '+ Add a card';
    wrap.appendChild(openBtn);

    openBtn.addEventListener('click', () => {
      wrap.innerHTML = '';
      const field = doc.createElement('div');
      field.className = 'board-add-field';
      const ta = doc.createElement('textarea');
      ta.rows = 1;
      ta.placeholder = 'Card text';
      const submit = doc.createElement('button');
      submit.type = 'button';
      submit.className = 'board-add-submit';
      submit.appendChild(plusIcon(doc));
      field.appendChild(ta);
      field.appendChild(submit);
      wrap.className = 'board-add';
      wrap.appendChild(field);
      ta.focus();
      const sync = () => {
        submit.classList.toggle('ready', ta.value.trim().length > 0);
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
      };
      ta.addEventListener('input', sync);
      const commit = () => {
        const v = ta.value.trim();
        if (v) { Kanban.addItem(board, laneIndex, v); onChange(); }
        render();
      };
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); render(); }
      });
      submit.addEventListener('mousedown', (e) => { e.preventDefault(); commit(); });
      ta.addEventListener('blur', () => { if (!ta.value.trim()) render(); });
    });
    return wrap;
  }

  render();

  return {
    // A board carrying droppable content refuses to save (protect, never
    // replicate the plugin's silent destruction): a null save opts out of
    // autosave for this open, exactly like a read-only viewer.
    getContentForSave: (board.dropped && board.dropped.length)
      ? null
      : () => Kanban.serialize(board),
    setOnChange(cb) { onChange = typeof cb === 'function' ? cb : (() => {}); },
    destroy() {
      closeLaneMenu();
      doc.removeEventListener('rundock:closemenus', closeLaneMenu);
      clearTimeout(undoTimer);
      paneElement.classList.remove('viewer-host', 'board-host');
      paneElement.innerHTML = '';
    },
  };
}
