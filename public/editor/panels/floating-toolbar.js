// Floating toolbar: appears on text selection, positioned above the cursor.
// Buttons cover bold, italic, code, link, h1, h2, h3 (per the spec).
// Hides when the selection is empty or when focus leaves the editor.
//
// The toolbar element lives in index.html under #floating-toolbar. This
// module owns the show/hide/position logic and the click bindings.

// Lucide chain-link icon, monochrome, picks up the button's text colour via
// stroke=currentColor so it sits flush with the B / I / </> / H1 / H2 / H3
// text buttons rather than reading as an emoji.
const LINK_ICON_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

// Lucide message-square icon for the review Comment action.
const COMMENT_ICON_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

// Formatting buttons render as a row; the review Comment action renders as a
// full-width bar beneath them (the pattern proven in Roughdraft: commenting
// is the primary review gesture, so it gets primary prominence). Suggesting
// was deliberately removed from the human toolbar (2026-07-13): a human in
// an editable document just makes the edit; suggestions remain the AGENT's
// authoring direction, decided via the sidebar's Accept/Reject.
const BUTTON_DEFS = [
  { id: 'bold',   label: 'B',   title: 'Bold (Cmd/Ctrl+B)',   styled: 'b' },
  { id: 'italic', label: 'I',   title: 'Italic (Cmd/Ctrl+I)', styled: 'i' },
  { id: 'code',   label: '</>', title: 'Inline code',          styled: '' },
  { id: 'link',   icon:  LINK_ICON_SVG, title: 'Link',          styled: '' },
  { id: 'h1',     label: 'H1',  title: 'Heading 1',            styled: '' },
  { id: 'h2',     label: 'H2',  title: 'Heading 2',            styled: '' },
  { id: 'h3',     label: 'H3',  title: 'Heading 3',            styled: '' },
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

function renderToolbarHTML(withComment) {
  const buttons = BUTTON_DEFS
    .map(b => {
      const styled = b.styled ? ` data-style="${b.styled}"` : '';
      // SVG icons are hardcoded above and trusted; text labels are escaped.
      const content = b.icon ? b.icon : escapeHtml(b.label || '');
      return `<button type="button" class="tb-btn" data-cmd="${b.id}" title="${escapeHtml(b.title)}"${styled}>${content}</button>`;
    })
    .join('');
  const commentBar = withComment
    ? `<button type="button" class="tb-comment" data-cmd="comment" title="Comment on selection">${COMMENT_ICON_SVG}<span>Comment</span></button>`
    : '';
  return `<div class="tb-row">${buttons}</div>${commentBar}`;
}

function applyCommand(editor, id) {
  if (!editor) return;
  const chain = editor.chain().focus();
  switch (id) {
    case 'bold':   return chain.toggleBold().run();
    case 'italic': return chain.toggleItalic().run();
    case 'code':   return chain.toggleCode().run();
    case 'link': {
      const prev = editor.getAttributes('link').href || '';
      const url = window.prompt('Link URL', prev);
      if (url === null) return;
      if (url === '')   return chain.unsetLink().run();
      return chain.setLink({ href: normaliseLinkHref(url), rel: 'noopener noreferrer' }).run();
    }
    case 'h1': return chain.toggleHeading({ level: 1 }).run();
    case 'h2': return chain.toggleHeading({ level: 2 }).run();
    case 'h3': return chain.toggleHeading({ level: 3 }).run();
    default:   return;
  }
}

function updateActiveStates(editor, toolbar) {
  if (!editor) return;
  toolbar.querySelectorAll('.tb-btn').forEach(btn => {
    const cmd = btn.getAttribute('data-cmd');
    let active = false;
    switch (cmd) {
      case 'bold':   active = editor.isActive('bold');   break;
      case 'italic': active = editor.isActive('italic'); break;
      case 'code':   active = editor.isActive('code');   break;
      case 'link':   active = editor.isActive('link');   break;
      case 'h1':     active = editor.isActive('heading', { level: 1 }); break;
      case 'h2':     active = editor.isActive('heading', { level: 2 }); break;
      case 'h3':     active = editor.isActive('heading', { level: 3 }); break;
    }
    btn.classList.toggle('active', active);
  });
}

// Attach the toolbar to an editor instance. Returns a teardown function so
// the editor module can clean up when the editor is destroyed.
export function attachFloatingToolbar({ toolbarElement, hostElement, editor, onReviewAction = null }) {
  if (!toolbarElement || !editor) return () => {};

  toolbarElement.innerHTML = renderToolbarHTML(typeof onReviewAction === 'function');
  toolbarElement.classList.remove('visible');

  const onClick = (event) => {
    const btn = event.target.closest('.tb-btn, .tb-comment');
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();
    const cmd = btn.getAttribute('data-cmd');
    if (cmd === 'comment') {
      if (typeof onReviewAction === 'function') onReviewAction('comment');
      toolbarElement.classList.remove('visible');
      return;
    }
    applyCommand(editor, cmd);
    updateActiveStates(editor, toolbarElement);
  };
  toolbarElement.addEventListener('mousedown', onClick);

  // Stop selection-collapse on toolbar click by preventing the host element
  // from losing focus during the brief mousedown on the button.
  toolbarElement.addEventListener('mousedown', (e) => {
    if (e.target.closest('.tb-btn, .tb-comment')) e.preventDefault();
  });

  const position = () => {
    const { from, to, empty } = editor.state.selection;
    if (empty || !editor.isFocused) {
      toolbarElement.classList.remove('visible');
      return;
    }
    const view = editor.view;
    let startCoords;
    let endCoords;
    try {
      startCoords = view.coordsAtPos(from);
      endCoords   = view.coordsAtPos(to);
    } catch {
      toolbarElement.classList.remove('visible');
      return;
    }
    // The host element is the scrolling container (overflow-y: auto), so the
    // absolutely-positioned toolbar inside it is positioned relative to the
    // host's CONTENT box, not its visible viewport. coordsAtPos returns
    // viewport coordinates; converting to host-content coordinates means
    // subtracting the host's viewport offset and ADDING its scrollTop /
    // scrollLeft so the toolbar tracks the selection correctly at any scroll
    // position.
    const hostRect = hostElement.getBoundingClientRect();
    toolbarElement.classList.add('visible');
    const tbRect = toolbarElement.getBoundingClientRect();
    const scrollTop  = hostElement.scrollTop  || 0;
    const scrollLeft = hostElement.scrollLeft || 0;
    const midX = (startCoords.left + endCoords.left) / 2 - hostRect.left + scrollLeft;
    const aboveTop = startCoords.top - hostRect.top + scrollTop - tbRect.height - 8;
    // Above the selection by default. If the selection sits near the top of
    // the pane content with no room above for the toolbar, drop it to just
    // below the selection instead so it never overlaps the highlighted text.
    const top = aboveTop >= 8
      ? aboveTop
      : endCoords.bottom - hostRect.top + scrollTop + 8;
    const minLeft = 8;
    const maxLeft = hostElement.scrollWidth - tbRect.width - 8;
    toolbarElement.style.left = Math.max(minLeft, Math.min(maxLeft, midX - tbRect.width / 2)) + 'px';
    toolbarElement.style.top  = top + 'px';
    updateActiveStates(editor, toolbarElement);
  };

  const onSelection = () => position();
  const onUpdate    = () => position();
  const onBlur      = () => toolbarElement.classList.remove('visible');

  editor.on('selectionUpdate', onSelection);
  editor.on('transaction',     onUpdate);
  editor.on('blur',            onBlur);

  return () => {
    editor.off('selectionUpdate', onSelection);
    editor.off('transaction',     onUpdate);
    editor.off('blur',            onBlur);
    toolbarElement.removeEventListener('mousedown', onClick);
    toolbarElement.classList.remove('visible');
    toolbarElement.innerHTML = '';
  };
}
