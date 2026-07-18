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
    .board-lane.drop-target { border-color: var(--accent); }
    .board-lane-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--border); }
    .board-lane-title { font-size: var(--body); font-weight: 600; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .board-lane-count { font-size: var(--caption); color: var(--text-2); font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; margin-left: auto; }
    .board-lane-body { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; min-height: 8px; }
    .board-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; font-size: var(--body); color: var(--text-1); line-height: 1.5; cursor: grab; }
    .board-card:hover { border-color: var(--text-2); }
    .board-card.dragging { opacity: 0.4; }
    .board-card-row { display: flex; gap: 8px; align-items: flex-start; }
    .board-card-check { flex: 0 0 auto; margin-top: 2px; width: 15px; height: 15px; cursor: pointer; accent-color: var(--accent); }
    .board-card-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .board-card-text.checked { color: var(--text-2); text-decoration: line-through; }
    .board-card-text a { color: var(--accent); text-decoration: none; }
    .board-card-text a:hover { text-decoration: underline; }
    .board-card-text code { font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; font-size: 12px; background: var(--elevated); padding: 1px 4px; border-radius: 4px; }
    .board-card-drop { height: 2px; margin: -5px 0; border-radius: 2px; background: transparent; }
    .board-card-drop.active { background: var(--accent); }
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
    .board-dropped-warn { margin: 8px 20px; padding: 10px 14px; border-radius: 8px; background: rgba(232,168,76,0.12); border: 1px solid rgba(232,168,76,0.35); color: var(--text-1); font-size: var(--caption); }
  `;
  doc.head.appendChild(style);
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

export function mountBoardView({ paneElement, content }, Kanban) {
  const doc = paneElement.ownerDocument;
  ensureStyles(doc);
  paneElement.innerHTML = '';
  paneElement.classList.add('viewer-host', 'board-host');

  let board = Kanban.parse(String(content == null ? '' : content));

  // Drag state: {fromLane, fromIndex}. Re-renders are deferred past dragend so
  // macOS does not play the ~400ms snap-back ghost.
  let drag = null;
  let onChange = () => {};

  const scroll = doc.createElement('div');
  scroll.className = 'board-scroll';
  paneElement.appendChild(scroll);

  function render() {
    scroll.innerHTML = '';
    board.lanes.forEach((lane, laneIndex) => scroll.appendChild(renderLane(lane, laneIndex)));
    if (board.dropped && board.dropped.length) {
      const warn = doc.createElement('div');
      warn.className = 'board-dropped-warn';
      warn.textContent = `This board contains ${board.dropped.length} line(s) that the board grammar cannot represent. They are preserved on screen but editing here could drop them, so saving is disabled until they are removed in the source.`;
      paneElement.insertBefore(warn, scroll);
    }
  }

  function renderLane(lane, laneIndex) {
    const el = doc.createElement('div');
    el.className = 'board-lane';
    el.dataset.lane = String(laneIndex);

    const head = doc.createElement('div');
    head.className = 'board-lane-head';
    const title = doc.createElement('span');
    title.className = 'board-lane-title';
    title.textContent = lane.title + (lane.maxItems ? ` (${lane.maxItems})` : '');
    const count = doc.createElement('span');
    count.className = 'board-lane-count';
    count.textContent = String(lane.items.length);
    head.appendChild(title);
    head.appendChild(count);
    el.appendChild(head);

    const body = doc.createElement('div');
    body.className = 'board-lane-body';
    lane.items.forEach((item, itemIndex) => {
      body.appendChild(dropZone(laneIndex, itemIndex));
      body.appendChild(renderCard(item, laneIndex, itemIndex));
    });
    body.appendChild(dropZone(laneIndex, lane.items.length));
    el.appendChild(body);

    el.appendChild(addComposer(laneIndex));

    // Lane is a drop target for the whole column (drops append to the end when
    // not over a specific card gap).
    el.addEventListener('dragover', (e) => {
      if (!drag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove('drop-target');
    });
    el.addEventListener('drop', (e) => {
      if (!drag) return;
      e.preventDefault();
      el.classList.remove('drop-target');
      commitMove(laneIndex, lane.items.length);
    });
    return el;
  }

  function dropZone(laneIndex, itemIndex) {
    const z = doc.createElement('div');
    z.className = 'board-card-drop';
    z.addEventListener('dragover', (e) => {
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      z.classList.add('active');
    });
    z.addEventListener('dragleave', () => z.classList.remove('active'));
    z.addEventListener('drop', (e) => {
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      z.classList.remove('active');
      commitMove(laneIndex, itemIndex);
    });
    return z;
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
    row.appendChild(check);
    row.appendChild(text);
    card.appendChild(row);

    card.addEventListener('dragstart', (e) => {
      drag = { fromLane: laneIndex, fromIndex: itemIndex };
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', ''); } catch (err) {}
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      drag = null;
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
    let target = toIndex;
    if (fromLane === toLane && fromIndex < toIndex) target -= 1;
    if (fromLane === toLane && target === fromIndex) { drag = null; return; }
    Kanban.moveItem(board, fromLane, fromIndex, toLane, target);
    drag = null;
    onChange();
    render();
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
      paneElement.classList.remove('viewer-host', 'board-host');
      paneElement.innerHTML = '';
    },
  };
}
