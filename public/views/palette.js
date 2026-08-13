'use strict';
// Search palette view (app.js section 18), extracted verbatim as a Foundations
// view module. Same UMD pattern as markers.js (node-requireable,
// window-attached); additionally republishes every function on the root
// object, because classic-script function declarations were window properties
// and the callers rely on that: the static inline handlers in index.html
// (openPalette, closePalette, setPaletteScope), the generated result-row
// handlers (openPaletteResult, hoverPaletteItem), the WS dispatch
// (handlePaletteResults), the keyboard wiring that stays in app.js
// (togglePalette, closePalette, movePaletteSelection, openPaletteResult,
// schedulePaletteSearch), the files view (paletteOpenFile) and the chat
// view's session-history render (tryMessageAnchor).
//
// One keyboard-first surface over four corpora: files, conversations, agents,
// skills. The server answers `search_universal` with grouped results (title
// fuzzy layer + FTS content, or grep fallback). Navigation REUSES the
// existing routes: read_file + showView('editor') for files (same as the
// file tree), openConversation for conversations (extended with the message
// anchor), showProfile for agents, selectSkill for skills. The one new
// mechanic is the message anchor: opening a conversation scrolled to the
// matched message.
//
// Shared state stays in app.js and is reached through the global lexical
// environment at call time: ws, agents, currentView, currentWorkspacePath,
// skillsLoaded, editorReturnView and fileHistory. Five palette identifiers
// stay there too, each because something outside this module touches it:
// paletteOpen (the find bar's Escape handler defers to the palette, and the
// keydown wiring below it reads the flag), paletteSel (the palette input's
// Enter handler reads it), palettePendingSkill (the WS `skills` handler
// replays a pending selection once skills load), pendingMessageAnchor
// (openConversation clears it in views/conversations.js) and IS_MAC (the top
// bar's shortcut hint reads it). PALETTE_GROUP_LIMIT stays for a different
// reason: it reads RundockPalette at load time, and evaluating that inside
// the factory would throw under a Node require and cost the module its
// requireability. Helpers reached the same way: esc, switchNav, showView,
// showProfile, selectSkill, openConversation, highlightFileInSidebar,
// paletteFileIcon and the RundockPalette decision module.
//
// View-local state is the nine declarations below: the query, the debounce
// timer, the last reply and its flattened list, the loading and stale-reply
// guards, the focus to restore on close, and the icon table. None has a
// reader outside this module, and all are inert allocations, so the factory
// stays side-effect-free.
//
// Every function body is byte-identical to the app.js original at column 0.
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.RundockPaletteView = factory();
    Object.assign(root, root.RundockPaletteView);
  }
}(typeof self !== 'undefined' ? self : this, function () {

let paletteScope = 'all';
let paletteQuery = '';
let paletteTimer = null;
let paletteReply = null;      // last server reply {groups, recent}
let paletteFlat = [];         // flat selectable items in display order
let paletteLoading = false;
let paletteReqId = 0;         // stale-reply guard (query text alone can't distinguish filter/fuzzy toggles)
let paletteReturnFocus = null; // element to restore focus to on close

function openPalette() {
  if (currentView === 'workspace' || !currentWorkspacePath) return; // no workspace yet
  const overlay = document.getElementById('palette-overlay');
  if (!overlay) return;
  // The rail is deliberately left alone. Opening search used to clear the
  // current view's highlight, because the rail's own magnifier took the active
  // state in its place and two lit icons would have been wrong. That magnifier
  // is gone: search lives in the top bar now, so clearing the highlight lit
  // nothing instead, and the rail simply went dark while a view was still
  // open behind the panel. The view has not changed, so its icon should not
  // change either.
  paletteOpen = true;
  paletteReturnFocus = document.activeElement;
  // Hides the top bar's field while the panel stands in its place. visibility,
  // not display, so the grid column keeps its width and nothing in the bar
  // shifts as the panel opens.
  document.body.classList.add('palette-open');
  overlay.classList.remove('hidden');
  const input = document.getElementById('palette-input');
  input.value = paletteQuery = '';
  schedulePaletteSearch(0); // empty query -> recent items
  input.focus();
}

function closePalette(opts = {}) {
  // restoreFocus defaults true: cancel closes (Escape, Cmd/Ctrl+K toggle)
  // return focus to where the user was, which keyboard flow continuity
  // requires. Selection closes pass false: after NAVIGATING somewhere,
  // handing focus back to a stale nav-rail button paints the browser's
  // keyboard focus ring on a view the user just left (a white border next
  // to the new view's active highlight).
  const restoreFocus = opts.restoreFocus !== false;
  paletteOpen = false;
  clearTimeout(paletteTimer);
  // Blur before hiding so focus never sits inside a hidden subtree
  // (browsers silently drop it to <body>; an explicit blur is deterministic).
  try { document.activeElement?.blur?.(); } catch (e) {}
  // MUST come before the focus restore below. The opener is usually the top
  // bar's search field, and a visibility:hidden element cannot take focus:
  // restoring first would drop focus to <body> instead, silently breaking
  // keyboard flow after Escape. Verified in both orders before landing.
  document.body.classList.remove('palette-open');
  document.getElementById('palette-overlay')?.classList.add('hidden');
  // Nothing to restore: the highlight was never removed. Navigating to a
  // result still hands the active icon to the destination, because setNavState
  // clears every nav item before lighting the new one.
  if (restoreFocus && paletteReturnFocus && document.contains(paletteReturnFocus)) {
    try { paletteReturnFocus.focus(); } catch (e) {}
  }
  paletteReturnFocus = null;
}

function togglePalette() { paletteOpen ? closePalette() : openPalette(); }

function setPaletteScope(scope) {
  paletteScope = scope;
  paletteSel = 0; // the flat list is about to change shape
  document.querySelectorAll('.palette-scope').forEach(b => b.classList.toggle('active', b.dataset.scope === scope));
  renderPalette();
  document.getElementById('palette-input')?.focus();
}

function schedulePaletteSearch(delay = 220) {
  if (!paletteOpen) return;
  clearTimeout(paletteTimer);
  paletteTimer = setTimeout(runPaletteSearch, delay);
}

function runPaletteSearch() {
  if (!paletteOpen || !ws || ws.readyState !== 1) return;
  paletteQuery = document.getElementById('palette-input')?.value || '';
  paletteLoading = true;
  renderPaletteStatus();
  // Fuzzy matching is always on for the title/name layer (no toggle in V1);
  // content matching stays lexical FTS with type-ahead prefixing.
  ws.send(JSON.stringify({
    type: 'search_universal',
    query: paletteQuery,
    reqId: ++paletteReqId,
    prefix: true, // type-ahead: last token matches as a prefix
    limit: PALETTE_GROUP_LIMIT,
  }));
}

function handlePaletteResults(d) {
  if (!paletteOpen) return;
  // Stale replies are dropped by request id (query text alone can't
  // distinguish a fuzzy/filter toggle on the same query).
  if (RundockPalette.isStaleReply(d, paletteReqId)) return;
  paletteLoading = false;
  paletteReply = d;
  paletteSel = 0;
  renderPalette();
}

// Escape then swap the server's control-char highlight markers for <mark>.
// Order matters: HTML is escaped FIRST, so the only markup in the string is
// the <mark> pair we introduce ourselves.
function paletteHl(s) { return RundockPalette.highlightToMark(s, esc); }

function paletteSnippetPlain(s) { return RundockPalette.snippetPlain(s); }

const PALETTE_ICONS = {
  skill: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
};

function renderPalette() {
  const container = document.getElementById('palette-results');
  if (!container || !paletteReply) return;
  // Grouping, ordering, and count-floor rules live in palette-model.js.
  const flattened = RundockPalette.flattenReply(paletteReply, paletteScope);
  paletteFlat = flattened.flat;
  let h = '';
  for (const g of flattened.groups) {
    h += `<div class="palette-group-label" role="presentation">${g.label}<span class="palette-group-count">${g.countLabel}</span></div>`;
    g.items.forEach((item, i) => { h += paletteItemHtml(item, g.startIdx + i); });
  }
  if (!paletteFlat.length) {
    const state = RundockPalette.emptyState(paletteReply, paletteQuery);
    if (state === 'error') {
      // A genuine server failure must not masquerade as "no matches".
      h = `<div class="palette-empty">Search hit a problem<div class="palette-empty-sub">Try again; if it persists, check the server log.</div></div>`;
    } else {
      h = state === 'no-matches'
        ? `<div class="palette-empty">No matches for &ldquo;${esc(paletteQuery.trim())}&rdquo;<div class="palette-empty-sub">Search covers file contents and names, conversation messages and titles, and agent and skill names.</div></div>`
        : `<div class="palette-empty">Start typing to search your workspace<div class="palette-empty-sub">Files, conversations, agents, and skills.</div></div>`;
    }
  }
  container.innerHTML = h;
  updatePaletteSelection();
  renderPaletteStatus();
}

function paletteItemHtml(item, idx) {
  let icon = '', title = '', meta = '';
  if (item.type === 'file') {
    icon = `<div class="palette-item-icon">${paletteFileIcon(item.kind)}</div>`;
    title = esc(item.title || item.path);
    const dir = item.path && item.path.includes('/') ? item.path.substring(0, item.path.lastIndexOf('/')) + '/' : '';
    const tagStr = (item.tags && item.tags.length) ? ` &middot; #${item.tags.map(esc).join(' #')}` : '';
    meta = item.snippet ? paletteHl(item.snippet) : esc(dir) + tagStr;
  } else if (item.type === 'conversation') {
    const a = agents.find(x => x.id === item.agentId);
    icon = `<div class="avatar sm" style="background:${esc(a?.colour || 'var(--card)')};width:26px;height:26px;font-size:12px">${esc(a?.icon || '?')}</div>`;
    title = esc(item.title || 'Untitled conversation');
    meta = item.snippet ? paletteHl(item.snippet) : (a ? esc(a.displayName) : '');
    if (item.matchCount > 1) meta += ` <span style="opacity:0.7">&middot; ${parseInt(item.matchCount, 10) || 0} matches</span>`;
  } else if (item.type === 'agent') {
    icon = `<div class="avatar sm" style="background:${esc(item.colour || 'var(--card)')};width:26px;height:26px;font-size:12px">${esc(item.icon || '?')}</div>`;
    title = esc(item.name);
    meta = esc(item.role || '');
  } else if (item.type === 'skill') {
    icon = `<div class="palette-item-icon">${PALETTE_ICONS.skill}</div>`;
    title = esc(item.name);
    meta = esc((item.description || '').slice(0, 90));
  }
  return `<div class="palette-item" id="palette-item-${idx}" role="option" aria-selected="false" data-idx="${idx}" data-type="${item.type}" onclick="openPaletteResult(${idx})" onmousemove="hoverPaletteItem(${idx})">
    ${icon}
    <div class="palette-item-body">
      <div class="palette-item-title">${title}</div>
      ${meta ? `<div class="palette-item-meta">${meta}</div>` : ''}
    </div>
    <span class="palette-item-kbd">&#9166;</span>
  </div>`;
}

function renderPaletteStatus() {
  const el = document.getElementById('palette-status');
  if (!el) return;
  el.innerHTML = paletteLoading
    ? '<span><span class="spin">&#9696;</span> searching&hellip;</span>'
    : '<span>&#8593;&#8595; navigate</span><span>&#9166; open</span><span>esc close</span>';
}

function hoverPaletteItem(idx) {
  if (paletteSel === idx) return;
  paletteSel = idx;
  updatePaletteSelection(false);
}

function updatePaletteSelection(scroll = true) {
  document.querySelectorAll('.palette-item').forEach(el => {
    const selected = parseInt(el.dataset.idx) === paletteSel;
    el.classList.toggle('selected', selected);
    el.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (selected && scroll) el.scrollIntoView({ block: 'nearest' });
  });
  // Screen readers track the arrow-key selection through the combobox input.
  const input = document.getElementById('palette-input');
  if (input) {
    if (paletteFlat.length) input.setAttribute('aria-activedescendant', `palette-item-${paletteSel}`);
    else input.removeAttribute('aria-activedescendant');
  }
}

function movePaletteSelection(delta) {
  if (!paletteFlat.length) return;
  paletteSel = RundockPalette.moveSelection(paletteSel, delta, paletteFlat.length);
  updatePaletteSelection();
}

function openPaletteResult(idx) {
  const item = paletteFlat[idx];
  if (!item) return;
  closePalette({ restoreFocus: false }); // navigating away: no stale focus ring
  if (item.type === 'file') {
    paletteOpenFile(item.path);
  } else if (item.type === 'conversation') {
    paletteOpenConversation(item);
  } else if (item.type === 'agent') {
    showProfile(item.id);
  } else if (item.type === 'skill') {
    paletteOpenSkill(item.id);
  }
}

// File route: same mechanics as a file-tree click (read_file + editor view),
// plus nav state so the sidebar matches where the user landed.
function paletteOpenFile(filePath) {
  switchNav('files');
  editorReturnView = 'editor';
  fileHistory = [];
  ws.send(JSON.stringify({ type: 'read_file', path: filePath }));
  showView('editor');
  // Reveal, don't just select. Marking the row active while its folders stay
  // collapsed leaves the user looking at a file they cannot see, since
  // .file-children.collapsed is display:none. This also handles the active
  // class, the folder icons and scrolling it into view, which is why the
  // sibling route for links inside an artifact has always ended here.
  highlightFileInSidebar(filePath);
}

// Conversation route: the existing openConversation, extended with the
// message anchor (the one genuinely new deep-link mechanic here).
function paletteOpenConversation(item) {
  if (item.snippet) {
    pendingMessageAnchor = {
      convoId: item.id,
      text: paletteSnippetPlain(item.snippet).replace(/…/g, ' ').trim(),
      fragment: RundockPalette.snippetFragment(item.snippet),
    };
  } else {
    pendingMessageAnchor = null;
  }
  openConversation(item.id, !!pendingMessageAnchor);
  // Already-loaded conversations render synchronously: anchor now. History
  // loads anchor from renderSessionHistory when the fetch lands.
  if (!document.getElementById('history-loading')) tryMessageAnchor(item.id);
}

function paletteOpenSkill(skillId) {
  if (!skillsLoaded) palettePendingSkill = skillId;
  switchNav('skills');
  if (skillsLoaded) selectSkill(skillId);
}

// ── Message anchor ──────────────────────────────────────────────────────────
// Find the rendered message whose text contains the search snippet and
// scroll to it. Text-content matching (normalised) survives the markdown
// rendering that separates the jsonl source from the DOM.

function tryMessageAnchor(convoId) {
  if (!pendingMessageAnchor || pendingMessageAnchor.convoId !== convoId) return;
  const anchor = pendingMessageAnchor;
  pendingMessageAnchor = null;
  // Let the DOM paint before measuring.
  setTimeout(() => {
    const bubbles = document.querySelectorAll('#messages .msg .msg-bubble');
    const idx = RundockPalette.findAnchorIndex([...bubbles].map(b => b.textContent), anchor);
    const target = idx === -1 ? null : bubbles[idx].closest('.msg');
    if (!target) return; // message outside the loaded window: land at the conversation as usual
    target.scrollIntoView({ block: 'center', behavior: 'auto' });
    target.classList.remove('anchor-flash');
    void target.offsetWidth; // restart the animation if re-triggered
    target.classList.add('anchor-flash');
    // Remove the class once the flash has served its purpose. CSS animations
    // replay whenever the element cycles through display:none (navigating to
    // another view and back), so a lingering class re-flashes the message on
    // every return to the conversation. The timeout (animation is 1.6s) also
    // covers prefers-reduced-motion, where no animationend would ever fire
    // and the static fallback ring would otherwise persist indefinitely.
    setTimeout(() => target.classList.remove('anchor-flash'), 1700);
  }, 60);
}

return {
  openPalette, closePalette, togglePalette, setPaletteScope,
  schedulePaletteSearch, runPaletteSearch, handlePaletteResults, paletteHl,
  paletteSnippetPlain, renderPalette, paletteItemHtml, renderPaletteStatus,
  hoverPaletteItem, updatePaletteSelection, movePaletteSelection,
  openPaletteResult, paletteOpenFile, paletteOpenConversation,
  paletteOpenSkill, tryMessageAnchor,
};
}));
