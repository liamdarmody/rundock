// Review sidebar: the UI over the review controller. Lists comments and
// suggestions, carries Accept / Reject / Reply / Resolve, a progress line,
// the Done-Reviewing gate, and the composer for authoring new comments and
// suggested edits from the current selection.
//
// The panel owns no data: every operation goes through the controller, and
// the controller writes everything into the file (constructs + endmatter).
// Layout: the editor pane becomes a two-column grid while review is open;
// the sidebar column is sticky inside the pane's scroll container.

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

export function attachReviewPanel({ paneElement, editor, controller, onRequestSave = null }) {
  if (!paneElement || !editor || !controller) return { detach: () => {}, refresh: () => {}, openComposer: () => {} };

  const sidebar = el('aside', 'review-sidebar');
  const pill = el('button', 'review-pill');
  pill.type = 'button';
  paneElement.appendChild(pill);
  paneElement.appendChild(sidebar);

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
      box.appendChild(el('div', 'review-quote', quote.length > 120 ? quote.slice(0, 117) + '…' : quote));
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
    if (item.meta && item.meta.by) head.appendChild(el('span', 'review-by', item.meta.by));
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
    acceptBtn.onclick = () => { controller.accept(item.id); render(); save(); };
    const rejectBtn = el('button', 'review-btn reject', 'Reject');
    rejectBtn.type = 'button';
    rejectBtn.onclick = () => { controller.reject(item.id); render(); save(); };
    row.appendChild(acceptBtn);
    row.appendChild(rejectBtn);
    card.appendChild(row);
    card.querySelector('.review-card-body, .review-card-head').style.cursor = 'pointer';
    card.querySelector('.review-card-head').onclick = () => scrollToItem(item);
    return card;
  }

  function renderCommentCard(item) {
    const card = el('div', 'review-card comment');
    const head = el('div', 'review-card-head');
    head.appendChild(el('span', 'review-badge comment-badge', item.id || 'Comment'));
    if (item.meta && item.meta.by) head.appendChild(el('span', 'review-by', item.meta.by));
    card.appendChild(head);
    if (item.anchor) {
      card.appendChild(el('div', 'review-quote', item.anchor.length > 120 ? item.anchor.slice(0, 117) + '…' : item.anchor));
    }
    card.appendChild(el('div', 'review-card-body', item.text));
    for (const r of item.replies) {
      const reply = el('div', 'review-reply');
      reply.appendChild(el('span', 'review-by', r.by || ''));
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
    resolveBtn.onclick = () => { controller.resolve(item.id); render(); save(); };
    row.appendChild(replyBtn);
    row.appendChild(resolveBtn);
    card.appendChild(row);
    card.querySelector('.review-card-head').style.cursor = 'pointer';
    card.querySelector('.review-card-head').onclick = () => scrollToItem(item);
    return card;
  }

  // ------------------------------------------------------------------
  // render
  // ------------------------------------------------------------------

  function render() {
    const { items, total } = counts();
    const progress = controller.progress();
    const decided = progress.suggestions.accepted + progress.suggestions.rejected;
    const decidable = decided + progress.suggestions.open;

    // Pill: visible whenever there is anything to review or a review trail.
    const hasTrail = controller.isDirty() || total > 0;
    pill.classList.toggle('visible', hasTrail && !open);
    pill.textContent = total > 0 ? `Review · ${total}` : 'Review';
    pill.onclick = () => setOpen(true);

    if (!open) { sidebar.innerHTML = ''; return; }

    sidebar.innerHTML = '';
    const head = el('div', 'review-head');
    head.appendChild(el('span', 'review-title', 'Review'));
    const closeBtn = el('button', 'review-close', '×');
    closeBtn.type = 'button';
    closeBtn.title = 'Close review panel';
    closeBtn.onclick = () => setOpen(false);
    head.appendChild(closeBtn);
    sidebar.appendChild(head);

    if (decidable > 0) {
      sidebar.appendChild(el('div', 'review-progress', `${decided} of ${decidable} suggestions decided`));
    }

    renderComposer(sidebar);

    if (!items.length && !composer) {
      sidebar.appendChild(el('div', 'review-empty', 'No open review items. Select text and use Comment or Suggest in the toolbar.'));
    }
    for (const item of items) {
      sidebar.appendChild(item.kind === 'comment' ? renderCommentCard(item) : renderSuggestionCard(item));
    }

    const footer = el('div', 'review-footer');
    const doneBtn = el('button', 'review-btn done', 'Done reviewing');
    doneBtn.type = 'button';
    doneBtn.title = 'Stamp the review status and verdict summary into the file';
    doneBtn.onclick = () => {
      const payload = controller.doneReviewing();
      save();
      render();
      const json = JSON.stringify(payload, null, 2);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(json).catch(() => {});
      }
      const note = el('div', 'review-done-note', 'Review stamped into the file. Verdict summary copied.');
      sidebar.appendChild(note);
      setTimeout(() => note.remove(), 4000);
    };
    footer.appendChild(doneBtn);
    sidebar.appendChild(footer);
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
