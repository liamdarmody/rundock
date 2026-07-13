// Review sidebar: the UI over the review controller. Lists comments and
// suggestions, carries Accept / Reject / Reply / Resolve, a progress line,
// the Done-Reviewing gate, and the composer for authoring new comments and
// suggested edits from the current selection.
//
// The panel owns no data: every operation goes through the controller, and
// the controller writes everything into the file (constructs + endmatter).
// Layout: the editor pane becomes a two-column grid while review is open;
// the sidebar column is sticky inside the pane's scroll container.

import { openWorkspaceLocation } from '../review/deep-link-shim.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const TYPE_LABEL = {
  criticInsert: 'Insert',
  criticDelete: 'Delete',
  criticSubstitution: 'Replace',
};

// Constructs without {#id} anchors are addressed by position PLUS identity
// (type + content): positions go stale after every operation, and the
// controller refuses a locator whose identity no longer matches.
function locatorFor(item) {
  if (item.id != null) return item.id;
  const content = item.type === 'criticSubstitution' ? `${item.from}~>${item.text}` : item.text;
  return { pos: item.pos, type: item.type, content };
}

const SIDEBAR_WIDTH_KEY = 'rundock.reviewSidebarWidth';
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 420;
const SIDEBAR_DEFAULT = 260;

export function attachReviewPanel({ paneElement, editor, controller, onRequestSave = null, author = null, agents = [], pillHostElement = null }) {
  if (!paneElement || !editor || !controller) return { detach: () => {}, refresh: () => {}, openComposer: () => {} };

  const sidebar = el('aside', 'review-sidebar');
  const pill = el('button', 'review-pill');
  pill.type = 'button';
  // The minimised pill lives at the far right of the editor header row,
  // after the save status, when the host provides it; otherwise it pins to
  // the pane's top-right corner.
  if (pillHostElement) {
    pill.classList.add('in-header');
    pillHostElement.appendChild(pill);
  } else {
    paneElement.appendChild(pill);
  }
  paneElement.appendChild(sidebar);

  // Sidebar width: a UI preference, persisted locally (never in the file).
  const applyWidth = (w) => {
    const clamped = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w || SIDEBAR_DEFAULT));
    paneElement.style.setProperty('--review-sidebar-width', `${clamped}px`);
    return clamped;
  };
  let sidebarWidth = applyWidth(Number(localStorage.getItem(SIDEBAR_WIDTH_KEY)) || SIDEBAR_DEFAULT);

  const agentNames = new Map();
  for (const a of Array.isArray(agents) ? agents : []) {
    if (a && a.name) agentNames.set(String(a.name).toLowerCase(), a.displayName || a.name);
    if (a && a.displayName) agentNames.set(String(a.displayName).toLowerCase(), a.displayName);
  }

  // Attribution rendering. The wire format keeps real handles; the UI maps
  // the workspace user to "Me", known agents to their roster display name
  // (styled as agents), and everything else to the literal handle. Absent
  // metadata renders as "Unattributed" — never a guessed name.
  function authorBadge(meta) {
    const by = meta && meta.by ? String(meta.by) : null;
    if (!by) return el('span', 'review-by unattributed', 'Unattributed');
    if (author && by.toLowerCase() === String(author).toLowerCase()) {
      return el('span', 'review-by me', 'Me');
    }
    const agentName = agentNames.get(by.toLowerCase());
    if (agentName) return el('span', 'review-by agent', agentName);
    return el('span', 'review-by', by);
  }

  let open = false;
  let composer = null; // { mode: 'comment'|'suggest', range: {from,to}|null }

  const save = () => { if (typeof onRequestSave === 'function') onRequestSave(); };

  function counts() {
    const items = controller.listItems();
    return { items, total: items.length };
  }

  function setOpen(next) {
    open = next;
    paneElement.classList.toggle('review-active', open);
    sidebar.classList.toggle('visible', open);
    render();
  }

  // ------------------------------------------------------------------
  // composer
  // ------------------------------------------------------------------

  function openComposer(mode) {
    const { from, to } = editor.state.selection;
    composer = { mode, range: from === to ? null : { from, to } };
    if (!open) setOpen(true); else render();
    const ta = sidebar.querySelector('.review-composer textarea');
    if (ta) ta.focus();
  }

  function renderComposer(container) {
    if (!composer) return;
    const box = el('div', 'review-composer');
    const isSuggest = composer.mode === 'suggest';
    box.appendChild(el('div', 'review-composer-title', isSuggest ? 'Suggest a replacement' : 'Add a comment'));
    if (composer.range) {
      const quote = editor.state.doc.textBetween(composer.range.from, composer.range.to, ' ');
      // Degenerate selections (a stray period, whitespace) render no quote.
      if (quote.trim().length > 1) {
        box.appendChild(el('div', 'review-quote', quote.length > 120 ? quote.slice(0, 117) + '…' : quote));
      }
    }
    const ta = el('textarea');
    ta.rows = 3;
    ta.placeholder = isSuggest ? 'Replacement text…' : 'Comment…';
    box.appendChild(ta);
    const row = el('div', 'review-actions');
    const saveBtn = el('button', 'review-btn primary', isSuggest ? 'Suggest' : 'Comment');
    saveBtn.type = 'button';
    saveBtn.onclick = () => {
      const text = ta.value.trim();
      if (!text) return;
      if (isSuggest) controller.suggestReplace(text, composer.range);
      else controller.addComment(text, composer.range);
      composer = null;
      render();
      save();
    };
    const cancelBtn = el('button', 'review-btn', 'Cancel');
    cancelBtn.type = 'button';
    cancelBtn.onclick = () => { composer = null; render(); };
    row.appendChild(saveBtn);
    row.appendChild(cancelBtn);
    box.appendChild(row);
    container.appendChild(box);
  }

  // ------------------------------------------------------------------
  // cards
  // ------------------------------------------------------------------

  function scrollToItem(item) {
    // Deep-link first (see review/deep-link-shim.js); local scroll is the
    // fallback and the only path until the navigation branch merges.
    if (openWorkspaceLocation({ path: null, anchor: item.id })) return;
    try {
      const dom = editor.view.nodeDOM(item.pos);
      if (dom && dom.scrollIntoView) {
        dom.scrollIntoView({ block: 'center', behavior: 'smooth' });
        dom.classList.add('critic-flash');
        setTimeout(() => dom.classList.remove('critic-flash'), 1200);
      }
    } catch { /* node may have moved; harmless */ }
  }

  function renderSuggestionCard(item) {
    const card = el('div', 'review-card suggestion');
    const head = el('div', 'review-card-head');
    head.appendChild(el('span', 'review-badge', TYPE_LABEL[item.type] || 'Suggestion'));
    head.appendChild(authorBadge(item.meta));
    card.appendChild(head);

    if (item.type === 'criticSubstitution') {
      const body = el('div', 'review-card-body');
      body.appendChild(el('span', 'review-sub-from', item.from));
      body.appendChild(el('span', 'review-sub-arrow', '→'));
      body.appendChild(el('span', 'review-sub-to', item.text));
      card.appendChild(body);
    } else {
      card.appendChild(el('div', 'review-card-body', item.text));
    }

    const row = el('div', 'review-actions');
    const acceptBtn = el('button', 'review-btn accept', 'Accept');
    acceptBtn.type = 'button';
    acceptBtn.onclick = () => { controller.accept(locatorFor(item)); render(); save(); };
    const rejectBtn = el('button', 'review-btn reject', 'Reject');
    rejectBtn.type = 'button';
    rejectBtn.onclick = () => { controller.reject(locatorFor(item)); render(); save(); };
    row.appendChild(acceptBtn);
    row.appendChild(rejectBtn);
    card.appendChild(row);
    card.querySelector('.review-card-body, .review-card-head').style.cursor = 'pointer';
    card.querySelector('.review-card-head').onclick = () => scrollToItem(item);
    return card;
  }

  function renderCommentCard(item, number) {
    const card = el('div', 'review-card comment');
    const head = el('div', 'review-card-head');
    // Numbered by document order, matching the inline chip's CSS counter.
    // Wire-format anchor ids (c1, c2...) are plumbing and never render.
    head.appendChild(el('span', 'review-badge comment-badge', String(number)));
    head.appendChild(authorBadge(item.meta));
    card.appendChild(head);
    if (item.anchor) {
      card.appendChild(el('div', 'review-quote', item.anchor.length > 120 ? item.anchor.slice(0, 117) + '…' : item.anchor));
    }
    card.appendChild(el('div', 'review-card-body', item.text));
    for (const r of item.replies) {
      const reply = el('div', 'review-reply');
      reply.appendChild(authorBadge(r));
      reply.appendChild(el('span', null, r.body || ''));
      card.appendChild(reply);
    }

    const row = el('div', 'review-actions');
    const replyBtn = el('button', 'review-btn', 'Reply');
    replyBtn.type = 'button';
    replyBtn.onclick = () => {
      if (card.querySelector('.review-reply-box')) return;
      const box = el('div', 'review-reply-box');
      const ta = el('textarea');
      ta.rows = 2;
      ta.placeholder = 'Reply…';
      const send = el('button', 'review-btn primary', 'Send');
      send.type = 'button';
      send.onclick = () => {
        const text = ta.value.trim();
        if (!text) return;
        controller.reply(item.id, text);
        render();
        save();
      };
      box.appendChild(ta);
      box.appendChild(send);
      card.insertBefore(box, row);
      ta.focus();
    };
    const resolveBtn = el('button', 'review-btn resolve', 'Resolve');
    resolveBtn.type = 'button';
    resolveBtn.onclick = () => { controller.resolve(locatorFor(item)); render(); save(); };
    row.appendChild(replyBtn);
    row.appendChild(resolveBtn);
    card.appendChild(row);
    card.querySelector('.review-card-head').style.cursor = 'pointer';
    card.querySelector('.review-card-head').onclick = () => scrollToItem(item);
    return card;
  }

  // A highlight with no attached comment (comment resolved separately, or
  // edits separated the pair): releasable so it never strands in the file.
  function renderHighlightCard(item) {
    const card = el('div', 'review-card highlight');
    const head = el('div', 'review-card-head');
    head.appendChild(el('span', 'review-badge', 'Highlight'));
    card.appendChild(head);
    card.appendChild(el('div', 'review-card-body', item.text));
    const row = el('div', 'review-actions');
    const releaseBtn = el('button', 'review-btn resolve', 'Remove highlight');
    releaseBtn.type = 'button';
    releaseBtn.onclick = () => { controller.release(locatorFor(item)); render(); save(); };
    row.appendChild(releaseBtn);
    card.appendChild(row);
    card.querySelector('.review-card-head').style.cursor = 'pointer';
    card.querySelector('.review-card-head').onclick = () => scrollToItem(item);
    return card;
  }

  // ------------------------------------------------------------------
  // render
  // ------------------------------------------------------------------

  // Drag handle on the sidebar's left edge.
  function attachResizeHandle() {
    const handle = el('div', 'review-resize-handle');
    handle.title = 'Drag to resize';
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = sidebarWidth;
      const onMove = (ev) => { sidebarWidth = applyWidth(startW + (startX - ev.clientX)); };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth)); } catch { /* private mode */ }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    sidebar.appendChild(handle);
  }

  function render() {
    const { items, total } = counts();

    // The pill is the minimised state: open feedback stays loudly visible
    // (accent treatment + count), and the panel re-opens automatically on
    // every file open while items remain, so closing is never "dismiss".
    const hasTrail = controller.isDirty() || total > 0;
    pill.classList.toggle('visible', hasTrail && !open);
    pill.classList.toggle('has-items', total > 0);
    pill.textContent = total > 0 ? `Review · ${total}` : 'Review';
    pill.title = total > 0 ? `${total} open review item${total === 1 ? '' : 's'}` : 'Review history';
    pill.onclick = () => setOpen(true);

    if (!open) { sidebar.innerHTML = ''; return; }

    sidebar.innerHTML = '';
    attachResizeHandle();
    const head = el('div', 'review-head');
    head.appendChild(el('span', 'review-title', 'Review'));
    const closeBtn = el('button', 'review-close', '−');
    closeBtn.type = 'button';
    closeBtn.title = 'Minimise (items stay marked in the document)';
    closeBtn.onclick = () => setOpen(false);
    head.appendChild(closeBtn);
    sidebar.appendChild(head);

    // No progress line: verdicts live in the file's endmatter and decided
    // constructs leave the document, so the remaining cards ARE the open
    // state. A derived tally added bookkeeping noise (and could read oddly
    // across sessions, since decided counts persist in the endmatter while
    // open counts come from the document).

    // All content sits in a body with one symmetric gutter, mirroring the
    // properties box's structure.
    const body = el('div', 'review-body');
    sidebar.appendChild(body);

    renderComposer(body);

    if (!items.length && !composer) {
      body.appendChild(el('div', 'review-empty', 'No open review items. Select text and use Comment in the toolbar.'));
    }
    let commentNumber = 0;
    for (const item of items) {
      if (item.kind === 'highlight') body.appendChild(renderHighlightCard(item));
      else if (item.kind === 'comment') body.appendChild(renderCommentCard(item, ++commentNumber));
      else body.appendChild(renderSuggestionCard(item));
    }
    // NOTE: "Done reviewing" (controller.doneReviewing) is deliberately not
    // rendered: the handback gate returns to the UI together with the
    // agent-apply decision. The controller API and its tests remain.
  }

  // Re-render when the document changes (constructs decided inline, undo,
  // typing near constructs) — cheap enough at sidebar scale.
  const onTransaction = ({ transaction }) => { if (transaction.docChanged) render(); };
  editor.on('transaction', onTransaction);

  // Open automatically when the file arrives with review items.
  if (counts().total > 0) setOpen(true); else render();

  return {
    detach: () => {
      editor.off('transaction', onTransaction);
      sidebar.remove();
      pill.remove();
      paneElement.classList.remove('review-active');
    },
    refresh: render,
    openComposer,
  };
}
