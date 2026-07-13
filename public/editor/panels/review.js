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
import { createComposingPlugin, composingKey, setComposingRange, getComposingRange } from '../review/composing-decoration.js';

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

  // The panel's height is derived from the pane's actual viewport so the
  // bottom gap always equals the top and right gaps (24px each): the pane's
  // visible height minus the top inset and the matching bottom inset. In
  // overlay mode (narrow panes) the fixed top/bottom offsets own the height
  // instead. Recomputed on any pane resize.
  const PANEL_INSET = 24;
  const isOverlay = () => (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1000px)').matches);
  const updateLayout = () => {
    if (isOverlay()) { sidebar.style.maxHeight = ''; sidebar.style.marginRight = ''; return; }
    const h = paneElement.clientHeight - PANEL_INSET * 2;
    if (h > 0) sidebar.style.maxHeight = `${h}px`;
    // Right alignment with the header's save status: the pane's padding is
    // 32px against the header's 24px (hence the -8px pull), and the pane's
    // scrollbar gutter (present only when the document scrolls) shifts the
    // content edge by its width, so it joins the derivation.
    const scrollbarWidth = paneElement.offsetWidth - paneElement.clientWidth;
    sidebar.style.marginRight = `${-(8 + scrollbarWidth)}px`;
  };
  let resizeObserver = null;
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(updateLayout);
    resizeObserver.observe(paneElement);
  }

  const agentNames = new Map();
  for (const a of Array.isArray(agents) ? agents : []) {
    if (a && a.name) agentNames.set(String(a.name).toLowerCase(), a.displayName || a.name);
    if (a && a.displayName) agentNames.set(String(a.displayName).toLowerCase(), a.displayName);
  }

  // Attribution rendering. The wire format keeps real handles; the UI maps
  // the workspace user to "Me", known agents to their roster display name,
  // and everything else to the title-cased handle (by: penn renders as
  // Penn even when penn is not in this workspace's roster). Absent
  // metadata renders as "Unattributed" — never a guessed name. One visual
  // treatment for every author: identity is information, not decoration.
  function titleCaseHandle(handle) {
    return handle.split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
  }

  function authorBadge(meta) {
    const by = meta && meta.by ? String(meta.by) : null;
    if (!by) return el('span', 'review-by unattributed', 'Unattributed');
    if (author && by.toLowerCase() === String(author).toLowerCase()) {
      return el('span', 'review-by', 'Me');
    }
    const agentName = agentNames.get(by.toLowerCase());
    if (agentName) return el('span', 'review-by', agentName);
    return el('span', 'review-by', titleCaseHandle(by));
  }

  let open = false;
  let composer = null; // { mode: 'comment'|'suggest' }; the range lives in the composing plugin
  let decidedThisSession = false;

  // While the composer is open the target range stays visibly decorated
  // (the editor blurs, so the native selection disappears) and the plugin
  // maps the range through any document edits.
  editor.registerPlugin(createComposingPlugin());

  const save = () => { if (typeof onRequestSave === 'function') onRequestSave(); };

  // The one input grammar for review text entry, borrowed from the
  // conversations message input: a growing textarea with an embedded
  // circular send button that activates when there is text. Enter sends,
  // Shift+Enter breaks the line, Cmd/Ctrl+Enter also sends, Escape cancels.
  // With autoCollapse, an empty input dismisses itself on blur — that IS
  // the cancel affordance, so no button row eats the narrow panel width.
  const SEND_ARROW_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';

  function inputWithSend({ placeholder, onSubmit, onCancel = null, autoCollapse = false, submitTitle = 'Send' }) {
    const wrap = el('div', 'review-input');
    const ta = el('textarea');
    ta.rows = 1;
    ta.placeholder = placeholder;
    const btn = el('button', 'review-send');
    btn.type = 'button';
    btn.title = submitTitle;
    btn.innerHTML = SEND_ARROW_SVG; // static, trusted markup
    btn.disabled = true;
    const sync = () => {
      const has = ta.value.trim().length > 0;
      btn.disabled = !has;
      btn.classList.toggle('active', has);
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
    };
    const submit = () => {
      const text = ta.value.trim();
      if (text) onSubmit(text);
    };
    ta.addEventListener('input', sync);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
      else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); if (onCancel) onCancel(); }
    });
    if (autoCollapse && onCancel) {
      // Deferred so a click landing on the send button wins over the blur.
      ta.addEventListener('blur', () => setTimeout(() => { if (!ta.value.trim()) onCancel(); }, 150));
    }
    btn.onclick = submit;
    wrap.appendChild(ta);
    wrap.appendChild(btn);
    return { wrap, ta };
  }

  // Settle flash on the block a verdict just changed, so every action
  // visibly causes its effect.
  function flashAt(pos) {
    try {
      const clamped = Math.max(1, Math.min(pos, editor.state.doc.content.size - 1));
      const dom = editor.view.domAtPos(clamped);
      const target = dom.node.nodeType === 1 ? dom.node : dom.node.parentElement;
      if (target && target.classList) {
        target.classList.add('critic-flash');
        setTimeout(() => target.classList.remove('critic-flash'), 1200);
      }
    } catch { /* position may be gone; harmless */ }
  }

  // Card exit animation, then the operation. Input is blocked on the card
  // while it departs so a second click cannot target a stale locator.
  function departThen(card, op) {
    card.classList.add('leaving');
    card.style.pointerEvents = 'none';
    setTimeout(() => { op(); render(); save(); }, 160);
  }

  function counts() {
    const items = controller.listItems();
    return { items, total: items.length };
  }

  function setOpen(next) {
    open = next;
    paneElement.classList.toggle('review-active', open);
    sidebar.classList.toggle('visible', open);
    updateLayout();
    render();
  }

  // ------------------------------------------------------------------
  // composer
  // ------------------------------------------------------------------

  function closeComposer() {
    composer = null;
    setComposingRange(editor, null);
    render();
  }

  function openComposer(mode) {
    const { from, to } = editor.state.selection;
    composer = { mode };
    setComposingRange(editor, from === to ? null : { from, to });
    if (!open) setOpen(true); else render();
    const ta = sidebar.querySelector('.review-composer textarea');
    if (ta) ta.focus();
  }

  function renderComposer(container) {
    if (!composer) return;
    const box = el('div', 'review-composer');
    const isSuggest = composer.mode === 'suggest';
    const titleRow = el('div', 'review-composer-head');
    titleRow.appendChild(el('div', 'review-composer-title', isSuggest ? 'Suggest a replacement' : 'Add a comment'));
    // The composer holds decoration state, so it keeps one explicit way out
    // for the mouse (Escape covers the keyboard).
    const closeX = el('button', 'review-composer-close', '×');
    closeX.type = 'button';
    closeX.title = 'Discard';
    closeX.onclick = closeComposer;
    titleRow.appendChild(closeX);
    box.appendChild(titleRow);
    // The live range comes from the plugin, mapped through any edits made
    // while the composer sat open.
    const range = getComposingRange(editor);
    if (range) {
      const quote = editor.state.doc.textBetween(range.from, range.to, ' ');
      // Degenerate selections (a stray period, whitespace) render no quote.
      if (quote.trim().length > 1) {
        box.appendChild(el('div', 'review-quote', quote.length > 120 ? quote.slice(0, 117) + '…' : quote));
      }
    }
    const { wrap, ta } = inputWithSend({
      placeholder: isSuggest ? 'Replacement text…' : 'Comment…',
      submitTitle: isSuggest ? 'Suggest' : 'Comment',
      onCancel: closeComposer,
      onSubmit: (text) => {
        const liveRange = getComposingRange(editor);
        if (isSuggest) controller.suggestReplace(text, liveRange);
        else controller.addComment(text, liveRange);
        composer = null;
        setComposingRange(editor, null);
        render();
        save();
      },
    });
    box.appendChild(wrap);
    container.appendChild(box);
    void ta; // focused by openComposer
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
    acceptBtn.onclick = () => departThen(card, () => {
      if (controller.accept(locatorFor(item))) { flashAt(item.pos); decidedThisSession = true; }
    });
    const rejectBtn = el('button', 'review-btn reject', 'Reject');
    rejectBtn.type = 'button';
    rejectBtn.onclick = () => departThen(card, () => {
      if (controller.reject(locatorFor(item))) { flashAt(item.pos); decidedThisSession = true; }
    });
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
    // Numbered top-to-bottom, matching the inline chip's CSS counter. The
    // number is position, not identity: cross-party references quote the
    // comment text, and wire-format ids never render.
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
      if (card.querySelector('.review-input')) return;
      const { wrap, ta } = inputWithSend({
        placeholder: 'Reply…',
        submitTitle: 'Send reply',
        autoCollapse: true, // an empty reply box dismisses itself on blur
        onCancel: () => wrap.remove(),
        onSubmit: (text) => {
          controller.reply(item.id, text);
          render();
          save();
        },
      });
      card.insertBefore(wrap, row);
      ta.focus();
    };
    const resolveBtn = el('button', 'review-btn resolve', 'Resolve');
    resolveBtn.type = 'button';
    resolveBtn.onclick = () => departThen(card, () => {
      if (controller.resolve(locatorFor(item))) { flashAt(item.pos); decidedThisSession = true; }
    });
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
    releaseBtn.onclick = () => departThen(card, () => {
      if (controller.release(locatorFor(item))) { flashAt(item.pos); decidedThisSession = true; }
    });
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
    if (open) updateLayout(); // scrollbar gutter appears/disappears with content length
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
      // Two distinct empty states: finishing a review is a product moment,
      // not the same as never having started one.
      if (decidedThisSession) {
        body.appendChild(el('div', 'review-empty completed', 'All feedback addressed.'));
      } else {
        body.appendChild(el('div', 'review-empty', 'No open review items. Select text and use Comment in the toolbar.'));
      }
    }
    let commentNumber = 0;
    for (const item of items) {
      let card;
      if (item.kind === 'highlight') card = renderHighlightCard(item);
      else if (item.kind === 'comment') card = renderCommentCard(item, ++commentNumber);
      else card = renderSuggestionCard(item);
      card.dataset.pos = String(item.pos);
      body.appendChild(card);
    }
    // NOTE: "Done reviewing" (controller.doneReviewing) is deliberately not
    // rendered: the handback gate returns to the UI together with the
    // agent-apply decision. The controller API and its tests remain.
  }

  // Re-render when the document changes (constructs decided inline, undo,
  // typing near constructs) — cheap enough at sidebar scale.
  const onTransaction = ({ transaction }) => { if (transaction.docChanged) render(); };
  editor.on('transaction', onTransaction);

  // Clicking an inline construct opens the panel and lights up its card —
  // the mirror of the card's scroll-to-construct.
  const onConstructClick = (event) => {
    const target = event.target.closest && event.target.closest('.critic');
    if (!target || sidebar.contains(target)) return;
    const item = controller.listItems().find((i) => {
      try {
        const dom = editor.view.nodeDOM(i.pos);
        return dom === target || (dom && dom.contains && dom.contains(target));
      } catch { return false; }
    });
    if (!item) return;
    if (!open) setOpen(true);
    const card = sidebar.querySelector(`.review-card[data-pos="${item.pos}"]`);
    if (card) {
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      card.classList.add('attention');
      setTimeout(() => card.classList.remove('attention'), 1200);
    }
  };
  paneElement.addEventListener('click', onConstructClick);

  // Open automatically when the file arrives with review items.
  if (counts().total > 0) setOpen(true); else render();

  return {
    detach: () => {
      editor.off('transaction', onTransaction);
      paneElement.removeEventListener('click', onConstructClick);
      if (resizeObserver) resizeObserver.disconnect();
      try { editor.unregisterPlugin(composingKey); } catch { /* editor may be gone */ }
      sidebar.remove();
      pill.remove();
      paneElement.classList.remove('review-active');
    },
    refresh: render,
    openComposer,
  };
}
