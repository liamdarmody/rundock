'use strict';
// In-view find bar (app.js section 17), extracted verbatim as a Foundations
// view module. Same UMD pattern as markers.js (node-requireable,
// window-attached); additionally republishes every function on the root
// object, because classic-script function declarations were window properties
// and the callers rely on that: views/files.js (closeFindBar on file switch
// and on an editor mode change, syncTiptapFindStateFromPlugin from the
// editor's update event), views/conversations.js (closeFindBar when the
// active conversation changes), switchNav in app.js, the top-level
// initFindBar() call that stays in app.js, and test/e2e/viewers.spec.js,
// which reaches detectFindBackend through page.evaluate. That last one makes
// root republication load-bearing for detectFindBackend specifically, not
// merely conventional.
//
// One find-bar UI over five backends, chosen by the active view:
//   'conversation'    text-node walk + Range surroundContents on .msg-bubble
//   'tiptap'          ProseMirror decoration plugin, plus DOM marks for the
//                     frontmatter properties panel, which lives outside the
//                     ProseMirror doc and is presented as one ordered list
//   'legacy-preview'  the same text-node walk, rooted at #editor-content
//   'artifact'        the sandboxed preview iframe, painted with the CSS
//                     Custom Highlight API so nothing wraps or splits the
//                     artifact DOM and the review loop's marks never collide
//   'textarea'        the source-edit view, painted by a layout-mirroring
//                     overlay laid behind the transparent textarea
//
// Shared state stays in app.js and is reached through the global lexical
// environment at call time: currentView, activeConversation, currentFilePath,
// activeTiptapEditor, _tiptapEditorModuleResolved, editorMode,
// activeFileViewer and paletteOpen. findState stays there too, because
// views/files.js reads it on an editor mode change to close the bar when the
// backend would otherwise change underneath it.
//
// View-local state is the three declarations below, each left in place beside
// the backend its comment block documents rather than hoisted to the top:
// artifactFind, ARTIFACT_FIND_STYLE_ID and textareaFind. None has a reader
// outside this module, and all are inert allocations, so the factory stays
// side-effect-free and the module stays requireable under Node.
//
// Every function body is byte-identical to the app.js original at column 0.
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.RundockFindView = factory();
    Object.assign(root, root.RundockFindView);
  }
}(typeof self !== 'undefined' ? self : this, function () {

function isFindHotkey(e) {
  return (e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'f' || e.key === 'F');
}

function detectFindBackend() {
  // Return the active view's search backend, or null if find shouldn't
  // activate (e.g. workspace picker, settings, no file open).
  if (currentView === 'chat' && activeConversation) return 'conversation';
  if (currentView === 'editor' && activeTiptapEditor) return 'tiptap';
  if (currentView === 'editor' && currentFilePath) {
    // Artifact preview: the rendered HTML/SVG lives in the sandboxed iframe,
    // which the host DOM walker cannot reach. Only the artifact viewer sets
    // handle.iframe (the PDF viewer does not), so this gates on real preview.
    if (typeof editorMode !== 'undefined' && editorMode === 'preview'
        && activeFileViewer && activeFileViewer.iframe) return 'artifact';
    // Source-edit view (Code toggle) puts the raw source in the textarea.
    const ta = document.getElementById('editor-textarea');
    if (typeof editorMode !== 'undefined' && editorMode === 'edit'
        && ta && !ta.classList.contains('hidden')) return 'textarea';
    // A read-only binary viewer (image, PDF, unsupported) has no searchable
    // text: it is a mounted viewer with no source-save path and no artifact
    // iframe. Make Cmd+F a no-op instead of stale-routing to legacy-preview.
    if (activeFileViewer && !activeFileViewer.iframe && activeFileViewer.getContentForSave == null) return null;
    return 'legacy-preview';
  }
  return null;
}

function openFindBar() {
  const bar = document.getElementById('find-bar');
  const input = document.getElementById('find-input');
  if (!bar || !input) return;
  if (findState.open) {
    // Already open: re-focus and select so a second Cmd+F lets the user
    // refine their query (matches Chrome's behaviour).
    input.focus();
    input.select();
    return;
  }
  const backend = detectFindBackend();
  if (!backend) return;
  findState.open = true;
  findState.backend = backend;
  findState.matches = [];
  findState._propCount = 0;
  findState.currentIndex = 0;
  findState.query = '';
  bar.classList.remove('hidden');
  input.value = '';
  input.focus();
  updateFindCount();
  updateFindButtons();
}

function closeFindBar() {
  if (!findState.open) return;
  removeTextareaOverlay(); // tear down the source-view highlight layer, if any
  clearFindMatches();
  findState.open = false;
  findState.backend = null;
  findState.query = '';
  findState.matches = [];
  findState.currentIndex = 0;
  const bar = document.getElementById('find-bar');
  const count = document.getElementById('find-count');
  if (bar) bar.classList.add('hidden');
  if (count) {
    count.textContent = '';
    count.classList.remove('no-results');
  }
}

function clearFindMatches() {
  // Unwrap every <mark.find-match>, restoring original text nodes. Covers the
  // conversation and legacy-preview backends AND the properties-panel marks
  // that ride alongside the tiptap backend. Safe no-op when none exist.
  const marks = document.querySelectorAll('mark.find-match');
  if (marks.length) {
    const parents = new Set();
    marks.forEach(mark => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parents.add(parent);
    });
    parents.forEach(p => p.normalize());
  }
  if (findState.backend === 'tiptap') {
    // Tiptap backend: clear the find plugin's state, which empties the
    // decoration set. Document content is never touched.
    if (_tiptapEditorModuleResolved && activeTiptapEditor) {
      _tiptapEditorModuleResolved.clearFind(activeTiptapEditor);
    }
  } else if (findState.backend === 'artifact') {
    clearArtifactFind();
  }
  // (textarea backend leaves the browser selection in place; nothing to unwrap)
  findState.matches = [];
  findState._propCount = 0;
  findState.currentIndex = 0;
}

function runFindSearch(query) {
  clearFindMatches();
  findState.query = query || '';
  if (!findState.query) {
    updateFindCount();
    updateFindButtons();
    return;
  }
  if (findState.backend === 'conversation') {
    searchDomSubtree(document.getElementById('messages'), query, parent => {
      const bubble = parent.closest && parent.closest('.msg-bubble');
      if (!bubble) return false;
      // Bubbles inside system, tool, and delegation rows should not match.
      return !!bubble.closest('.msg-user, .msg-agent');
    });
  } else if (findState.backend === 'legacy-preview') {
    const root = document.getElementById('editor-content');
    if (root && !root.classList.contains('hidden')) {
      searchDomSubtree(root, query, () => true);
    }
  } else if (findState.backend === 'artifact') {
    runArtifactFind(query);
  } else if (findState.backend === 'textarea') {
    runTextareaFind(query);
  } else if (findState.backend === 'tiptap') {
    if (_tiptapEditorModuleResolved && activeTiptapEditor) {
      // The frontmatter properties panel lives OUTSIDE the ProseMirror doc,
      // so the find plugin cannot see it. Search it as DOM marks first, then
      // the body via the plugin, and present one unified ordered match list:
      // [properties marks..., body matches...].
      let propMarks = [];
      const propRoot = document.getElementById('tiptap-properties');
      if (propRoot && propRoot.classList.contains('visible')) {
        searchDomSubtree(propRoot, query, () => true); // pushes <mark> into findState.matches
        propMarks = findState.matches.slice();
      }
      _tiptapEditorModuleResolved.setFindQuery(activeTiptapEditor, query);
      const tipState = _tiptapEditorModuleResolved.getFindState(activeTiptapEditor);
      // Placeholders for body matches: the real positions live in the plugin.
      findState.matches = propMarks.concat(tipState.matches.map(() => ({ tiptap: true })));
      findState._propCount = propMarks.length;
      findState.currentIndex = 0;
    }
  }
  if (findState.matches.length) {
    setCurrentFindMatch(0);
  }
  updateFindCount();
  updateFindButtons();
}

// Walks all text nodes under root, applies the predicate to each text node's
// parent element to decide whether to search it, and wraps every match in a
// <mark class="find-match"> via the Range API. Matches accumulate into
// findState.matches in DOM order.
function searchDomSubtree(root, query, predicate) {
  if (!root || !query) return;
  const lowerQuery = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      // Don't re-wrap inside an existing match (defensive).
      if (parent.closest('mark.find-match')) return NodeFilter.FILTER_REJECT;
      return predicate(parent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const textNodes = [];
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);

  for (const textNode of textNodes) {
    const text = textNode.nodeValue;
    const lower = text.toLowerCase();
    const positions = [];
    let pos = 0;
    while (true) {
      const idx = lower.indexOf(lowerQuery, pos);
      if (idx === -1) break;
      positions.push({ start: idx, end: idx + lowerQuery.length });
      // Advance by query length; do not advance by 0 even on empty (guarded above).
      pos = idx + lowerQuery.length;
    }
    if (!positions.length) continue;
    // Wrap from right to left so earlier offsets stay valid against the
    // shrinking text node. Collect in left-to-right order for findState.matches.
    const nodeMarks = new Array(positions.length);
    for (let i = positions.length - 1; i >= 0; i--) {
      const { start, end } = positions[i];
      try {
        const range = document.createRange();
        range.setStart(textNode, start);
        range.setEnd(textNode, end);
        const mark = document.createElement('mark');
        mark.className = 'find-match';
        range.surroundContents(mark);
        nodeMarks[i] = mark;
      } catch (err) {
        // Range / surroundContents can fail if the node was mutated mid-walk.
        // Skip this position silently.
        nodeMarks[i] = null;
      }
    }
    for (const m of nodeMarks) if (m) findState.matches.push(m);
  }
}

// ----- artifact-frame backend: find inside the sandboxed HTML/SVG preview.
// The preview iframe carries sandbox="allow-same-origin"
// with NO allow-scripts, so the host can read its contentDocument (the same
// grant the review loop uses) but the artifact still cannot run code. Find
// walks that document and paints matches with the CSS Custom Highlight API:
// it never splits or wraps the content DOM (unlike <mark> highlighting), so it
// never collides with the review loop's <mark> wraps and needs no re-index.
// The only node added is one idempotent <style> in the frame head (the same
// technique the review loop uses for its mark styles). No sandbox change is
// made; the posture is identical to shipped code.
const artifactFind = { win: null, doc: null, ranges: [] };
const ARTIFACT_FIND_STYLE_ID = 'rundock-find-frame-style';

function frameTextIndex(root) {
  const doc = root.ownerDocument;
  // Skip text inside script/style/etc: it is not visible, so matching it would
  // inflate the count and scroll to a zero-rect target. (head is already out
  // of scope: the walk is body-rooted.)
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (parent && parent.closest('script, style, noscript, template')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let text = '';
  let n;
  while ((n = walker.nextNode())) { nodes.push({ node: n, start: text.length }); text += n.nodeValue; }
  return { text, nodes };
}

function frameRangeFor(doc, index, start, end) {
  const nodeAt = (offset, isEnd) => {
    // The end boundary belongs to the node containing offset-1 so a span
    // ending on a node border does not spill into the next node.
    const probe = isEnd ? offset - 1 : offset;
    let entry = index.nodes[0];
    for (const e of index.nodes) { if (e.start > probe) break; entry = e; }
    return { node: entry.node, offset: offset - entry.start };
  };
  const s = nodeAt(start, false);
  const e = nodeAt(end, true);
  const range = doc.createRange();
  range.setStart(s.node, s.offset);
  range.setEnd(e.node, e.offset);
  return range;
}

function ensureArtifactFindStyle(doc) {
  if (doc.getElementById(ARTIFACT_FIND_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = ARTIFACT_FIND_STYLE_ID;
  // Decoration only (no geometry), matching the review-mark discipline.
  style.textContent =
    '::highlight(rundock-find){background:rgba(232,168,76,0.30);}' +
    '::highlight(rundock-find-current){background:rgba(232,122,90,0.55);color:#000;}';
  doc.head.appendChild(style);
}

function runArtifactFind(query) {
  const iframe = activeFileViewer && activeFileViewer.iframe;
  const doc = iframe && iframe.contentDocument;
  artifactFind.win = doc && doc.defaultView;
  artifactFind.doc = doc;
  artifactFind.ranges = [];
  if (!doc || !doc.body || !query) return;
  ensureArtifactFindStyle(doc);
  const index = frameTextIndex(doc.body);
  const hay = index.text.toLowerCase();
  const needle = query.toLowerCase();
  let pos = 0;
  while (true) {
    const i = hay.indexOf(needle, pos);
    if (i === -1) break;
    try { artifactFind.ranges.push(frameRangeFor(doc, index, i, i + needle.length)); } catch (e) {}
    pos = i + needle.length;
  }
  findState.matches = artifactFind.ranges.map(() => ({ artifact: true }));
}

function paintArtifactHighlights(currentIdx) {
  const win = artifactFind.win;
  if (!win || !win.CSS || !win.CSS.highlights || typeof win.Highlight !== 'function') return;
  win.CSS.highlights.delete('rundock-find');
  win.CSS.highlights.delete('rundock-find-current');
  const rest = [];
  const cur = [];
  artifactFind.ranges.forEach((r, i) => { (i === currentIdx ? cur : rest).push(r); });
  if (rest.length) win.CSS.highlights.set('rundock-find', new win.Highlight(...rest));
  if (cur.length) win.CSS.highlights.set('rundock-find-current', new win.Highlight(...cur));
}

function clearArtifactFind() {
  const win = artifactFind.win;
  if (win && win.CSS && win.CSS.highlights) {
    win.CSS.highlights.delete('rundock-find');
    win.CSS.highlights.delete('rundock-find-current');
  }
  artifactFind.ranges = [];
}

function scrollArtifactMatch(idx) {
  const win = artifactFind.win;
  const range = artifactFind.ranges[idx];
  if (!win || !range) return;
  try {
    const rect = range.getBoundingClientRect();
    const target = rect.top + (win.scrollY || 0) - (win.innerHeight || 0) / 2;
    win.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  } catch (e) {}
}

// ----- textarea backend: find in the HTML/text source-edit view.
// A textarea cannot carry per-match marks, and Chromium does not paint an
// UNFOCUSED textarea's selection, so matches are painted by a highlight overlay
// laid behind the textarea: a div that mirrors the textarea's exact text layout
// and wraps each match in a <mark> whose background shows through the textarea's
// transparent background. The overlay's marks use the class find-hl (not
// find-match) so the generic find-clear pass never unwraps them.
const textareaFind = { el: null, positions: [], overlay: null, prevParentPos: undefined };

function runTextareaFind(query) {
  const ta = document.getElementById('editor-textarea');
  textareaFind.el = ta;
  textareaFind.positions = [];
  if (!ta || !query) { updateTextareaOverlay(0); return; }
  const hay = ta.value.toLowerCase();
  const needle = query.toLowerCase();
  let pos = 0;
  while (true) {
    const i = hay.indexOf(needle, pos);
    if (i === -1) break;
    textareaFind.positions.push({ start: i, end: i + needle.length });
    pos = i + needle.length;
  }
  findState.matches = textareaFind.positions.map(() => ({ textarea: true }));
  updateTextareaOverlay(0);
}

function escapeOverlay(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Lay (or reuse) a layout-mirroring overlay behind the textarea and render the
// matches into it, with the current match emphasised.
function updateTextareaOverlay(currentIdx) {
  const ta = textareaFind.el || document.getElementById('editor-textarea');
  if (!ta) return;
  if (!textareaFind.positions.length) { removeTextareaOverlay(); return; }
  let overlay = textareaFind.overlay;
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'textarea-find-overlay';
    ta.parentElement.insertBefore(overlay, ta); // behind the textarea in paint order
    textareaFind.overlay = overlay;
    textareaFind.prevParentPos = ta.parentElement.style.position;
    if (getComputedStyle(ta.parentElement).position === 'static') ta.parentElement.style.position = 'relative';
    ta.style.position = 'relative';
    ta.style.zIndex = '1';
    ta._overlaySync = () => { if (textareaFind.overlay) { textareaFind.overlay.scrollTop = ta.scrollTop; textareaFind.overlay.scrollLeft = ta.scrollLeft; } };
    ta.addEventListener('scroll', ta._overlaySync);
  }
  // Mirror every style that affects where each character lands, and the box.
  const cs = getComputedStyle(ta);
  // wordBreak/overflowWrap are left to the overlay's own CSS (anywhere) so a
  // long unbreakable line wraps like the textarea's soft wrap rather than
  // overflowing; everything else that moves a glyph is mirrored.
  const mirror = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing',
    'whiteSpace', 'tabSize', 'textAlign', 'textIndent',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing'];
  for (const p of mirror) overlay.style[p] = cs[p];
  overlay.style.top = ta.offsetTop + 'px';
  overlay.style.left = ta.offsetLeft + 'px';
  overlay.style.width = ta.offsetWidth + 'px';
  overlay.style.height = ta.offsetHeight + 'px';

  const text = ta.value;
  let html = '';
  let last = 0;
  textareaFind.positions.forEach((p, i) => {
    html += escapeOverlay(text.slice(last, p.start));
    html += `<mark class="find-hl${i === currentIdx ? ' current' : ''}">` + escapeOverlay(text.slice(p.start, p.end)) + '</mark>';
    last = p.end;
  });
  html += escapeOverlay(text.slice(last)) + '\n'; // trailing newline: match textarea's own extra line box
  overlay.innerHTML = html;
  overlay.scrollTop = ta.scrollTop;
  overlay.scrollLeft = ta.scrollLeft;
}

function removeTextareaOverlay() {
  const ta = textareaFind.el || document.getElementById('editor-textarea');
  if (ta) {
    if (ta._overlaySync) { ta.removeEventListener('scroll', ta._overlaySync); ta._overlaySync = null; }
    ta.style.position = '';
    ta.style.zIndex = '';
    if (ta.parentElement && textareaFind.prevParentPos !== undefined) ta.parentElement.style.position = textareaFind.prevParentPos;
  }
  textareaFind.prevParentPos = undefined;
  if (textareaFind.overlay) { textareaFind.overlay.remove(); textareaFind.overlay = null; }
}

function scrollTextareaMatch(idx) {
  const ta = textareaFind.el;
  const p = textareaFind.positions[idx];
  if (!ta || !p) return;
  const before = ta.value.slice(0, p.start);
  const line = before.split('\n').length - 1;
  const cs = getComputedStyle(ta);
  const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 14) * 1.5;
  ta.scrollTop = Math.max(0, line * lh - ta.clientHeight / 2);
  updateTextareaOverlay(idx); // re-emphasise the current match and re-sync scroll
}

function setCurrentFindMatch(idx) {
  findState.currentIndex = idx;
  if (findState.backend === 'artifact') {
    paintArtifactHighlights(idx);
    scrollArtifactMatch(idx);
    updateFindCount();
    return;
  }
  if (findState.backend === 'textarea') {
    scrollTextareaMatch(idx);
    updateFindCount();
    return;
  }
  if (findState.backend === 'tiptap') {
    const propCount = findState._propCount || 0;
    if (idx < propCount) {
      // A properties-panel match is current: clear the body's current mark
      // (the -1 sentinel keeps its other matches visible) and highlight the
      // DOM mark directly.
      if (_tiptapEditorModuleResolved && activeTiptapEditor) {
        _tiptapEditorModuleResolved.setFindIndex(activeTiptapEditor, -1);
      }
      for (let i = 0; i < propCount; i++) {
        const m = findState.matches[i];
        if (m && m.classList) m.classList.toggle('current', i === idx);
      }
      const target = findState.matches[idx];
      if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else {
      // A body match is current: clear any properties current class and let
      // the plugin dispatch the index change, recompute decorations, scroll.
      for (let i = 0; i < propCount; i++) {
        const m = findState.matches[i];
        if (m && m.classList) m.classList.remove('current');
      }
      if (_tiptapEditorModuleResolved && activeTiptapEditor) {
        _tiptapEditorModuleResolved.setFindIndex(activeTiptapEditor, idx - propCount);
      }
    }
  } else {
    for (let i = 0; i < findState.matches.length; i++) {
      const m = findState.matches[i];
      if (m && m.classList) m.classList.toggle('current', i === idx);
    }
    const target = findState.matches[idx];
    if (target && target.scrollIntoView) {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
  updateFindCount();
}

function gotoNextFindMatch() {
  if (!findState.matches.length) return;
  setCurrentFindMatch((findState.currentIndex + 1) % findState.matches.length);
}

function gotoPrevFindMatch() {
  if (!findState.matches.length) return;
  setCurrentFindMatch((findState.currentIndex - 1 + findState.matches.length) % findState.matches.length);
}

function updateFindCount() {
  const countEl = document.getElementById('find-count');
  if (!countEl) return;
  if (!findState.query) {
    countEl.textContent = '';
    countEl.classList.remove('no-results');
    return;
  }
  if (!findState.matches.length) {
    countEl.textContent = 'No matches';
    countEl.classList.add('no-results');
    return;
  }
  countEl.textContent = `${findState.currentIndex + 1} of ${findState.matches.length}`;
  countEl.classList.remove('no-results');
}

function updateFindButtons() {
  const has = findState.matches.length > 0;
  const prev = document.getElementById('find-prev');
  const next = document.getElementById('find-next');
  if (prev) prev.disabled = !has;
  if (next) next.disabled = !has;
}

// Called from the Tiptap editor's `update` event so the count display stays
// honest when the user types in the editor while the find bar is open. The
// plugin handles matches and decorations itself; this just mirrors the new
// count + current index into app-side state for the UI.
function syncTiptapFindStateFromPlugin() {
  if (findState.backend !== 'tiptap' || !findState.open) return;
  if (!_tiptapEditorModuleResolved || !activeTiptapEditor) return;
  // With frontmatter matches in play the two match sources must stay in sync;
  // re-running the search is simplest and correct (rare: editing the body
  // while find is open on a file whose frontmatter also matched).
  if (findState._propCount) { runFindSearch(findState.query); return; }
  const tipState = _tiptapEditorModuleResolved.getFindState(activeTiptapEditor);
  findState.matches = tipState.matches.map(() => ({ tiptap: true }));
  findState.currentIndex = tipState.currentIndex;
  updateFindCount();
  updateFindButtons();
}

function initFindBar() {
  // Global Cmd+F / Ctrl+F: only intercept if find has a backend in the
  // current view. In other views (workspace picker, settings, etc.) the
  // browser's native find runs as usual.
  document.addEventListener('keydown', (e) => {
    if (isFindHotkey(e)) {
      const backend = detectFindBackend();
      if (!backend) return;
      e.preventDefault();
      openFindBar();
      return;
    }
    if (e.key === 'Escape' && findState.open) {
      // The palette overlays the find bar; when both are open, Escape
      // closes the topmost surface only (the palette's own handler).
      if (typeof paletteOpen !== 'undefined' && paletteOpen) return;
      e.preventDefault();
      closeFindBar();
    }
  });
  const input = document.getElementById('find-input');
  if (input) {
    input.addEventListener('input', (e) => {
      clearTimeout(findState.inputTimer);
      const q = e.target.value;
      findState.inputTimer = setTimeout(() => runFindSearch(q), 100);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) gotoPrevFindMatch();
        else gotoNextFindMatch();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeFindBar();
      }
    });
  }
  const prev = document.getElementById('find-prev');
  const next = document.getElementById('find-next');
  const close = document.getElementById('find-close');
  if (prev) prev.addEventListener('click', () => { gotoPrevFindMatch(); document.getElementById('find-input')?.focus(); });
  if (next) next.addEventListener('click', () => { gotoNextFindMatch(); document.getElementById('find-input')?.focus(); });
  if (close) close.addEventListener('click', closeFindBar);
}

return {
  isFindHotkey, detectFindBackend, openFindBar, closeFindBar,
  clearFindMatches, runFindSearch, searchDomSubtree, frameTextIndex,
  frameRangeFor, ensureArtifactFindStyle, runArtifactFind,
  paintArtifactHighlights, clearArtifactFind, scrollArtifactMatch,
  runTextareaFind, escapeOverlay, updateTextareaOverlay,
  removeTextareaOverlay, scrollTextareaMatch, setCurrentFindMatch,
  gotoNextFindMatch, gotoPrevFindMatch, updateFindCount, updateFindButtons,
  syncTiptapFindStateFromPlugin, initFindBar,
};
}));
