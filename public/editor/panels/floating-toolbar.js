// Floating toolbar: appears on text selection, positioned above the cursor.
//
// Layout: a "Text" block-type dropdown (paragraph, headings, and all three
// list types) followed by the inline marks (bold, italic, code, link), and an
// optional review Comment bar. Headings and lists live in the dropdown rather
// than as inline buttons so the bar stays narrow while exposing more (the
// Tiptap/Notion pattern); the dropdown label reflects the current block.
//
// The toolbar element lives in index.html under #floating-toolbar. This module
// owns the show/hide/position logic, the dropdown menu open/close, and the
// click bindings. A reduced toolbar (buttonIds set, e.g. board cards) renders
// only the chosen inline marks and no dropdown.

// ---- Icons (Lucide, monochrome, currentColor so they sit flush with text) ----
const LINK_ICON_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
const UNLINK_ICON_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 0 1 4 8"/><line x1="8" y1="12" x2="12" y2="12"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';
const COMMENT_ICON_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const CHEVRON_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const CHECK_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const BULLET_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>';
const NUMBERED_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/></svg>';
const CHECKLIST_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><line x1="13" y1="6" x2="21" y2="6"/><line x1="13" y1="12" x2="21" y2="12"/><line x1="13" y1="18" x2="21" y2="18"/></svg>';

// Inline marks (the row after the dropdown). Suggesting was deliberately kept
// out of the human toolbar: a human in an editable document just makes the
// edit; suggestions remain the AGENT's authoring direction via the sidebar.
const INLINE_DEFS = [
  { id: 'bold',   label: 'B',   title: 'Bold (Cmd/Ctrl+B)',   styled: 'b' },
  { id: 'italic', label: 'I',   title: 'Italic (Cmd/Ctrl+I)', styled: 'i' },
  { id: 'code',   label: '</>', title: 'Inline code',          styled: '' },
  { id: 'link',   icon:  LINK_ICON_SVG, title: 'Link',          styled: '' },
];

// The block-type dropdown. `label` is both the menu item text and, when active,
// the dropdown's trigger label. `svg: true` marks an SVG icon (else a glyph).
const BLOCK_TYPES = [
  { id: 'paragraph',   label: 'Text',          icon: 'T' },
  { id: 'h1',          label: 'Heading 1',     icon: 'H1' },
  { id: 'h2',          label: 'Heading 2',     icon: 'H2' },
  { id: 'h3',          label: 'Heading 3',     icon: 'H3' },
  { sep: true },
  { id: 'bulletList',  label: 'Bullet list',   icon: BULLET_ICON_SVG,    svg: true },
  { id: 'orderedList', label: 'Numbered list', icon: NUMBERED_ICON_SVG,  svg: true },
  { id: 'taskList',    label: 'Checklist',     icon: CHECKLIST_ICON_SVG, svg: true },
];

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Normalises a user-typed link href. Bare domains like "rundock.ai" get
// "https://" prepended; anchors, root-relative paths, and existing protocols
// pass through untouched. Matches the behaviour users expect from Notion,
// Apple Notes, and similar consumer editors.
function normaliseLinkHref(url) {
  if (!url) return url;
  url = String(url).trim();
  if (url === '') return url;
  if (/^(https?|mailto|tel|ftp|sftp|file):/i.test(url)) return url;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('#') || url.startsWith('/')) return url;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(url)) return 'https://' + url;
  return url;
}

const blockLabel = (id) => (BLOCK_TYPES.find((t) => t.id === id) || { label: 'Text' }).label;

// The block type the current selection sits in, used for the dropdown label and
// the menu's active tick. Lists are checked first: a list item's content is a
// paragraph, so the list wrapper is the meaningful "what is this block" answer.
export function activeBlockType(editor) {
  if (!editor) return 'paragraph';
  if (editor.isActive('bulletList'))  return 'bulletList';
  if (editor.isActive('orderedList')) return 'orderedList';
  if (editor.isActive('taskList'))    return 'taskList';
  if (editor.isActive('heading', { level: 1 })) return 'h1';
  if (editor.isActive('heading', { level: 2 })) return 'h2';
  if (editor.isActive('heading', { level: 3 })) return 'h3';
  return 'paragraph';
}

function renderInlineButton(b) {
  const styled = b.styled ? ` data-style="${b.styled}"` : '';
  const content = b.icon ? b.icon : escapeHtml(b.label || '');
  return `<button type="button" class="tb-btn" data-cmd="${b.id}" title="${escapeHtml(b.title)}"${styled}>${content}</button>`;
}

// The in-UI link popover: an input plus apply/remove controls, anchored under
// the toolbar. Rendered only when the toolbar carries a link button. Replaces
// the OS-native window.prompt so link editing stays inside the app chrome
// (the Notion/Bear pattern): pre-filled with the current href, Enter applies,
// Escape cancels, the unlink control clears the mark.
function renderLinkPopover() {
  return '<div class="tb-linkpop" role="dialog" aria-label="Link">'
    + '<input type="text" class="tb-link-input" placeholder="Paste or type a link" spellcheck="false" autocomplete="off" />'
    + `<button type="button" class="tb-link-apply" title="Apply link (Enter)" aria-label="Apply link">${CHECK_SVG}</button>`
    + `<button type="button" class="tb-link-unlink" title="Remove link" aria-label="Remove link">${UNLINK_ICON_SVG}</button>`
    + '</div>';
}

function renderBlockMenu() {
  const items = BLOCK_TYPES.map((t) => {
    if (t.sep) return '<div class="tb-menu-sep"></div>';
    const icon = t.svg ? t.icon : escapeHtml(t.icon);
    return `<button type="button" class="tb-menu-item" role="menuitem" data-cmd="${t.id}">`
      + `<span class="tb-menu-ic">${icon}</span>`
      + `<span class="tb-menu-label">${escapeHtml(t.label)}</span>`
      + `<span class="tb-menu-check">${CHECK_SVG}</span></button>`;
  }).join('');
  return `<div class="tb-menu" role="menu">${items}</div>`;
}

// buttonIds set (e.g. board cards) -> a reduced, inline-only toolbar with no
// block-type dropdown. Otherwise the full toolbar: dropdown + inline marks.
export function renderToolbarHTML(withComment, buttonIds = null) {
  const inlineDefs = buttonIds ? INLINE_DEFS.filter((b) => buttonIds.includes(b.id)) : INLINE_DEFS;
  const inline = inlineDefs.map(renderInlineButton).join('');
  const dropdown = buttonIds
    ? ''
    : `<button type="button" class="tb-dd" data-cmd="__blockmenu" title="Turn into…" aria-haspopup="true" aria-expanded="false"><span class="tb-dd-label">Text</span>${CHEVRON_SVG}</button><span class="tb-sep"></span>`;
  const menu = buttonIds ? '' : renderBlockMenu();
  // Comment lives inline on the single row, after a separator (matches the
  // narrower dropdown-based bar), not as a full-width second-line bar.
  const comment = withComment
    ? `<span class="tb-sep"></span><button type="button" class="tb-comment" data-cmd="comment" title="Comment on selection">${COMMENT_ICON_SVG}<span>Comment</span></button>`
    : '';
  const linkpop = inlineDefs.some((b) => b.id === 'link') ? renderLinkPopover() : '';
  return `<div class="tb-row">${dropdown}${inline}${comment}</div>${menu}${linkpop}`;
}

// Applies (or clears) a link on the current selection. Empty/whitespace URL
// removes the mark; otherwise the href is normalised and set. extendMarkRange
// means editing an existing link updates the whole link, not just the part
// under the caret. Exported so callers (and tests) can drive links directly.
export function applyLink(editor, url) {
  if (!editor) return;
  const chain = editor.chain().focus().extendMarkRange('link');
  const norm = normaliseLinkHref(String(url == null ? '' : url).trim());
  if (norm === '') return chain.unsetLink().run();
  return chain.setLink({ href: norm, rel: 'noopener noreferrer' }).run();
}

export function applyCommand(editor, id) {
  if (!editor) return;
  const chain = editor.chain().focus();
  switch (id) {
    case 'bold':   return chain.toggleBold().run();
    case 'italic': return chain.toggleItalic().run();
    case 'code':   return chain.toggleCode().run();
    // 'link' is intentionally absent: links are edited through the in-UI link
    // popover (openLinkPopover / applyLink), not this dispatch.
    case 'h1': return chain.toggleHeading({ level: 1 }).run();
    case 'h2': return chain.toggleHeading({ level: 2 }).run();
    case 'h3': return chain.toggleHeading({ level: 3 }).run();
    case 'bulletList':  return chain.toggleBulletList().run();
    case 'orderedList': return chain.toggleOrderedList().run();
    case 'taskList':    return chain.toggleTaskList().run();
    case 'paragraph': {
      // "Turn into Text": unwrap any surrounding list first so a list item
      // becomes a plain paragraph, not a paragraph still inside the list.
      if (editor.isActive('bulletList'))       chain.toggleBulletList();
      else if (editor.isActive('orderedList')) chain.toggleOrderedList();
      else if (editor.isActive('taskList'))    chain.toggleTaskList();
      return chain.setParagraph().run();
    }
    default: return;
  }
}

function updateActiveStates(editor, toolbar) {
  if (!editor) return;
  toolbar.querySelectorAll('.tb-btn').forEach((btn) => {
    const cmd = btn.getAttribute('data-cmd');
    let active = false;
    switch (cmd) {
      case 'bold':   active = editor.isActive('bold');   break;
      case 'italic': active = editor.isActive('italic'); break;
      case 'code':   active = editor.isActive('code');   break;
      case 'link':   active = editor.isActive('link');   break;
    }
    btn.classList.toggle('active', active);
  });
  const active = activeBlockType(editor);
  const label = toolbar.querySelector('.tb-dd-label');
  if (label) label.textContent = blockLabel(active);
  toolbar.querySelectorAll('.tb-menu-item').forEach((item) => {
    item.classList.toggle('active', item.getAttribute('data-cmd') === active);
  });
}

// Attach the toolbar to an editor instance. Returns a teardown function so the
// editor module can clean up when the editor is destroyed.
export function attachFloatingToolbar({ toolbarElement, hostElement, editor, onReviewAction = null, buttonIds = null, fixed = false }) {
  if (!toolbarElement || !editor) return () => {};
  // fixed: anchor to the viewport (position: fixed) instead of a scrolling host
  // container. Used where the editor lives inside a nested-scroll layout (board
  // cards) and there is no single positioned host to measure against.

  toolbarElement.innerHTML = renderToolbarHTML(typeof onReviewAction === 'function', buttonIds);
  toolbarElement.classList.remove('visible');
  if (fixed) toolbarElement.style.position = 'fixed';

  const dropdownBtn = toolbarElement.querySelector('.tb-dd');
  const menuEl = toolbarElement.querySelector('.tb-menu');
  const closeMenu = () => {
    if (!menuEl) return;
    menuEl.classList.remove('open');
    if (dropdownBtn) dropdownBtn.setAttribute('aria-expanded', 'false');
  };
  const toggleMenu = () => {
    if (!menuEl) return;
    const open = menuEl.classList.toggle('open');
    if (dropdownBtn) dropdownBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  // The in-UI link popover. While it is open the editor is blurred (the input
  // holds focus), so the blur/reposition handlers must not tear the toolbar
  // down: linkPopoverOpen guards them.
  const linkPopEl = toolbarElement.querySelector('.tb-linkpop');
  const linkInput = toolbarElement.querySelector('.tb-link-input');
  let linkPopoverOpen = false;
  const closeLinkPopover = () => {
    if (linkPopEl) linkPopEl.classList.remove('open');
    linkPopoverOpen = false;
  };
  const openLinkPopover = () => {
    if (!linkPopEl || !linkInput) return;
    linkPopoverOpen = true; // set BEFORE focusing the input so onBlur is guarded
    linkInput.value = editor.getAttributes('link').href || '';
    linkPopEl.classList.add('open');
    linkInput.focus();
    linkInput.select();
  };
  const commitLink = () => {
    if (!linkInput) return;
    applyLink(editor, linkInput.value);
    closeLinkPopover();
    updateActiveStates(editor, toolbarElement);
  };
  const removeLink = () => {
    applyLink(editor, '');
    closeLinkPopover();
    updateActiveStates(editor, toolbarElement);
  };
  const cancelLink = () => {
    closeLinkPopover();
    editor.chain().focus().run(); // restore the caret/selection in the document
  };

  // Removing 'visible' anywhere must also close the menu and link popover, so a
  // hidden toolbar never leaves an orphaned open panel.
  const hide = () => { toolbarElement.classList.remove('visible'); closeMenu(); closeLinkPopover(); };

  const onClick = (event) => {
    // Link popover: let the input take the caret; the apply/unlink buttons act.
    if (event.target.closest('.tb-link-input')) return;
    if (event.target.closest('.tb-link-apply')) {
      event.preventDefault(); event.stopPropagation();
      commitLink();
      return;
    }
    if (event.target.closest('.tb-link-unlink')) {
      event.preventDefault(); event.stopPropagation();
      removeLink();
      return;
    }
    if (event.target.closest('.tb-dd')) {
      event.preventDefault(); event.stopPropagation();
      toggleMenu();
      return;
    }
    const item = event.target.closest('.tb-menu-item');
    if (item) {
      event.preventDefault(); event.stopPropagation();
      applyCommand(editor, item.getAttribute('data-cmd'));
      closeMenu();
      updateActiveStates(editor, toolbarElement);
      return;
    }
    const btn = event.target.closest('.tb-btn, .tb-comment');
    if (!btn) return;
    event.preventDefault(); event.stopPropagation();
    closeMenu();
    const cmd = btn.getAttribute('data-cmd');
    if (cmd === 'link') {
      // Toggle the in-UI link popover instead of an OS dialog.
      if (linkPopoverOpen) cancelLink();
      else openLinkPopover();
      return;
    }
    if (cmd === 'comment') {
      if (typeof onReviewAction === 'function') onReviewAction('comment');
      hide();
      return;
    }
    applyCommand(editor, cmd);
    updateActiveStates(editor, toolbarElement);
  };
  toolbarElement.addEventListener('mousedown', onClick);

  // Stop selection-collapse on any toolbar interaction by preventing the host
  // from losing focus during the brief mousedown on a control.
  // Keep the document focus on any toolbar control EXCEPT the link input, which
  // must be able to take focus so the user can type a URL.
  const preventBlur = (e) => {
    if (e.target.closest('.tb-link-input')) return;
    if (e.target.closest('.tb-btn, .tb-comment, .tb-dd, .tb-menu-item, .tb-link-apply, .tb-link-unlink')) e.preventDefault();
  };
  toolbarElement.addEventListener('mousedown', preventBlur);

  // Enter/Escape drive the link input; Escape otherwise closes an open menu.
  const onKeyDown = (e) => {
    if (linkPopoverOpen && e.target.closest('.tb-link-input')) {
      if (e.key === 'Enter')  { e.preventDefault(); commitLink(); return; }
      if (e.key === 'Escape') { e.preventDefault(); cancelLink();  return; }
    }
    if (e.key === 'Escape' && menuEl && menuEl.classList.contains('open')) {
      e.preventDefault();
      closeMenu();
    }
  };
  toolbarElement.addEventListener('keydown', onKeyDown);

  const position = () => {
    // While the link popover holds focus the editor is blurred and the toolbar
    // must stay put; don't let the usual empty/blur checks tear it down.
    if (linkPopoverOpen) return;
    const { from, to, empty } = editor.state.selection;
    if (empty || !editor.isFocused) { hide(); return; }
    // An atom node selection (e.g. clicking a callout) is not inline-formattable,
    // so the formatting toolbar has nothing to act on: keep it hidden. Callouts
    // are edited through their own in-place editor, not these marks.
    const sel = editor.state.selection;
    if (sel.node && sel.node.type && sel.node.type.isAtom) { hide(); return; }
    const view = editor.view;
    let startCoords;
    let endCoords;
    try {
      startCoords = view.coordsAtPos(from);
      endCoords   = view.coordsAtPos(to);
    } catch { hide(); return; }
    // The host element is the scrolling container (overflow-y: auto), so the
    // absolutely-positioned toolbar inside it is positioned relative to the
    // host's CONTENT box, not its visible viewport. coordsAtPos returns
    // viewport coordinates; converting to host-content coordinates means
    // subtracting the host's viewport offset and ADDING its scrollTop /
    // scrollLeft so the toolbar tracks the selection correctly at any scroll
    // position.
    toolbarElement.classList.add('visible');
    const tbRect = toolbarElement.getBoundingClientRect();
    if (fixed) {
      // Viewport coordinates, straight from coordsAtPos (no host math).
      const midX = (startCoords.left + endCoords.left) / 2;
      const above = startCoords.top - tbRect.height - 8;
      const top = above >= 8 ? above : endCoords.bottom + 8;
      const left = Math.max(8, Math.min(window.innerWidth - tbRect.width - 8, midX - tbRect.width / 2));
      toolbarElement.style.left = left + 'px';
      toolbarElement.style.top  = top + 'px';
      updateActiveStates(editor, toolbarElement);
      return;
    }
    const hostRect = hostElement.getBoundingClientRect();
    const scrollTop  = hostElement.scrollTop  || 0;
    const scrollLeft = hostElement.scrollLeft || 0;
    const midX = (startCoords.left + endCoords.left) / 2 - hostRect.left + scrollLeft;
    const aboveTop = startCoords.top - hostRect.top + scrollTop - tbRect.height - 8;
    // Above the selection by default. If the selection sits near the top of the
    // pane content with no room above for the toolbar, drop it to just below
    // the selection instead so it never overlaps the highlighted text.
    const top = aboveTop >= 8
      ? aboveTop
      : endCoords.bottom - hostRect.top + scrollTop + 8;
    const minLeft = 8;
    const maxLeft = hostElement.scrollWidth - tbRect.width - 8;
    toolbarElement.style.left = Math.max(minLeft, Math.min(maxLeft, midX - tbRect.width / 2)) + 'px';
    toolbarElement.style.top  = top + 'px';
    updateActiveStates(editor, toolbarElement);
  };

  // A real selection change (moving the caret, clicking into other text, or a
  // block command's own transaction) closes any open menu/link popover, then
  // repositions. Closing the popover first clears its guard so the toolbar can
  // follow the new selection (e.g. the user clicked back into the document).
  const onSelection = () => { closeLinkPopover(); closeMenu(); position(); };
  const onUpdate    = () => position();
  const onBlur      = () => { if (linkPopoverOpen) return; hide(); };

  editor.on('selectionUpdate', onSelection);
  editor.on('transaction',     onUpdate);
  editor.on('blur',            onBlur);

  return () => {
    editor.off('selectionUpdate', onSelection);
    editor.off('transaction',     onUpdate);
    editor.off('blur',            onBlur);
    toolbarElement.removeEventListener('mousedown', onClick);
    toolbarElement.removeEventListener('mousedown', preventBlur);
    toolbarElement.removeEventListener('keydown', onKeyDown);
    toolbarElement.classList.remove('visible');
    toolbarElement.innerHTML = '';
  };
}
