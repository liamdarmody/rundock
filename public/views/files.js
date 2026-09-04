'use strict';
// Files view (app.js section 11 plus the section-1 file-surface lifecycle),
// extracted verbatim as a Foundations view module. Same UMD pattern as
// markers.js (node-requireable, window-attached); additionally republishes
// every function on the root object, because classic-script function
// declarations were window properties and the callers rely on that: the
// static inline handlers (setEditorMode, editorGoBack, openCreateMenu), the
// delegated wikilink listener registered in app.js (openWikilink), the
// WS dispatch (renderFileTree, loadFileContent, handleExternalFileChange,
// highlightFileInSidebar), routing (destroyTiptapEditorIfActive,
// updateEditorBackButton), the workspace picker (closeOpenFile), the init
// listeners (saveFileGuarded, getFileContentForSave, saveTiptapFile), the
// palette (paletteFileIcon), and the retained menu-close document listeners
// (closeFilesMenu).
//
// Shared state stays in app.js and is reached through the global lexical
// environment at call time: ws, agents, workspaceAnalysis, currentFilePath,
// activeTiptapEditor, _tiptapEditorModule, _tiptapEditorModuleResolved,
// _tiptapSaveTimer, _viewersModule, _viewersModuleResolved, activeFileViewer,
// serverPlatform, editorMode, rawFileContent, fileFrontmatter, fileBody,
// editorDirty, saveTimer, workspaceOpenStartedAt, cachedFileTree,
// editorReturnView, fileHistory, findState, plus the call-time constants
// TREE_ICONS and CREATABLE_TYPES (their declarations read FilesMenuModel at
// load time, which a side-effect-free factory cannot do). Helpers reached the
// same way: esc, getGuide, formatMdFull, closeFindBar,
// syncTiptapFindStateFromPlugin, paletteOpenFile, switchNav, showView, and
// the classic-script globals FilesMenuModel, ExternalRefresh, window.Kanban.
//
// The four dynamic import() specifiers are absolute (/editor/...,
// /viewers/...) instead of app.js's relative ./ forms: import() resolves
// against this script's URL, and /views/ would misroute the relative forms.
// They load the same URLs app.js loaded. Every function body is otherwise
// byte-identical to the app.js original at column 0.
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.RundockFilesView = factory();
    Object.assign(root, root.RundockFilesView);
  }
}(typeof self !== 'undefined' ? self : this, function () {

function loadTiptapEditorModule() {
  if (!_tiptapEditorModule) _tiptapEditorModule = import('/editor/index.js');
  return _tiptapEditorModule;
}
function loadViewersModule() {
  if (!_viewersModule) _viewersModule = import('/viewers/registry.js').then(m => { _viewersModuleResolved = m; return m; });
  return _viewersModule;
}
function destroyActiveFileViewer() {
  destroyActiveArtifactReview();
  if (activeFileViewer) { try { activeFileViewer.destroy(); } catch {} activeFileViewer = null; }
}
// Artifact review: sidecar-backed comments on the HTML
// preview. Detached before its pane is cleared so the header pill and the
// frame listeners never leak.
let activeArtifactReview = null;
function destroyActiveArtifactReview() {
  if (activeArtifactReview) { try { activeArtifactReview.detach(); } catch {} activeArtifactReview = null; }
}
async function attachArtifactReviewForCurrentFile(paneEl) {
  const path = currentFilePath;
  const iframe = activeFileViewer && activeFileViewer.iframe;
  if (!iframe) return;
  const mod = await import('/viewers/artifact-review.js');
  const sidecarPath = mod.sidecarPathFor(path);
  let sidecarContent = null;
  let loadFailed = false;
  try {
    const res = await fetch('/api/file?path=' + encodeURIComponent(sidecarPath));
    if (res.ok) sidecarContent = await res.text();
    else if (res.status !== 404) loadFailed = true; // 404 = no reviews yet; anything else = a real read failure
  } catch { loadFailed = true; /* network failure: existing sidecar may be on disk */ }
  const wire = () => {
    if (currentFilePath !== path || !iframe.isConnected) return; // stale: file switched meanwhile
    destroyActiveArtifactReview();
    activeArtifactReview = mod.attachArtifactReview({
      iframe,
      paneElement: paneEl,
      path,
      sidecarContent,
      author: (workspaceAnalysis && workspaceAnalysis.userProfile && workspaceAnalysis.userProfile.fields && workspaceAnalysis.userProfile.fields.name)
        ? String(workspaceAnalysis.userProfile.fields.name).trim().toLowerCase()
        : 'me',
      agents: Array.isArray(agents) ? agents.map(a => ({ name: a.name, displayName: a.displayName })) : [],
      pillHostElement: document.getElementById('editor-header'),
      // A link inside the artifact to another workspace file opens in Rundock
      // (any supported type), not in the sandboxed frame or the browser.
      onOpenInternalLink: (link) => {
        if (link.kind === 'wikilink') openWikilink(link.value);
        else if (link.kind === 'path') openWorkspaceFilePath(link.value);
      },
      // Data-safety gate: never overwrite a sidecar we could not read
      // cleanly (a fetch/5xx failure) or one that parsed as corrupt: either
      // could destroy existing comments. Saving is disabled for this mount;
      // the artifact still renders and existing comments still show.
      allowSave: !loadFailed,
      onSaveSidecar: (content) => {
        fetch('/api/review-sidecar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: sidecarPath, content }),
        }).catch(() => { /* next mutation retries; comments also live in memory */ });
      },
    });
  };
  if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete' && iframe.contentDocument.body) wire();
  else iframe.addEventListener('load', wire, { once: true });
}
async function initTiptapEditor(path, content) {
  // Tear down any previous instance so a rapid file-switch leaves a clean
  // ProseMirror state and detached event listeners.
  const mod = await loadTiptapEditorModule();
  _tiptapEditorModuleResolved = mod;
  if (activeTiptapEditor) {
    try { mod.destroyEditor(activeTiptapEditor); } catch {}
    activeTiptapEditor = null;
  }
  const editorEl = document.getElementById('tiptap-editor');
  if (!editorEl) return;
  editorEl.innerHTML = '';
  const { editor } = mod.createEditor({
    element: editorEl,
    rawMarkdown: content || '',
    propertiesElement: document.getElementById('tiptap-properties'),
    toolbarElement: document.getElementById('tiptap-toolbar'),
    toolbarHostElement: document.getElementById('tiptap-editor-pane'),
    onUpdate: () => onTiptapEditorUpdate(),
    onWikilinkClick: (target) => openWikilink(target),
    // Frontmatter wikilinks that match no file render visibly dead.
    resolveWikilink: (target) => {
      if (!cachedFileTree) return true; // tree not loaded yet: never false-flag
      // Through the shared search-name rule, which also fixes a drift this
      // check had grown: it appended .md to anything not already ending .md,
      // so a frontmatter [[chart.png]] was tested as chart.png.md and
      // rendered dead while clicking it worked.
      return !!findFileInTree(cachedFileTree, wikilinkSearchName(target));
    },
    // Review identity: workspace profile name -> 'me' fallback; the agent
    // roster lets review attribution render known agents as agent chips.
    author: (workspaceAnalysis && workspaceAnalysis.userProfile && workspaceAnalysis.userProfile.fields && workspaceAnalysis.userProfile.fields.name)
      ? String(workspaceAnalysis.userProfile.fields.name).trim().toLowerCase()
      : 'me',
    agents: Array.isArray(agents) ? agents.map(a => ({ name: a.name, displayName: a.displayName })) : [],
    // The minimised review pill sits in the header row, next to the save
    // status, level with the filename.
    reviewPillHostElement: document.getElementById('editor-header'),
    // Cross-file navigation routes through the universal-search file-open
    // path; same-file locations stay local to the editor.
    onNavigate: (loc) => {
      if (loc && loc.path) { paletteOpenFile(loc.path); return true; }
      return false;
    },
  });
  activeTiptapEditor = editor;
  // Re-sync the find-bar count from plugin state whenever the document
  // changes. The plugin's apply() already recomputes matches on docChanged,
  // but app.js's mirror of the count is independent and otherwise stays
  // pinned to whatever the last manual search produced.
  editor.on('update', () => syncTiptapFindStateFromPlugin());
}
function onTiptapEditorUpdate() {
  if (!currentFilePath || !activeTiptapEditor) return;
  editorDirty = true;
  const statusEl = document.getElementById('editor-status');
  if (statusEl) {
    statusEl.textContent = 'Unsaved';
    statusEl.style.color = 'var(--attention)';
  }
  clearTimeout(_tiptapSaveTimer);
  _tiptapSaveTimer = setTimeout(() => saveTiptapFile(), 1500);
}
function saveTiptapFile() {
  if (!currentFilePath || !activeTiptapEditor || !_tiptapEditorModule) return;
  _tiptapEditorModule.then(mod => {
    const content = mod.getMarkdown(activeTiptapEditor);
    saveFileGuarded(currentFilePath, content);
  });
}

// ---- External-edit guard ----
// Rundock and Obsidian edit the same vault interchangeably, so auto-save
// must never silently overwrite an edit made outside Rundock. Baseline =
// the bytes we believe are on disk (set at load and after each save we
// made). Before every save, the current disk bytes are fetched and
// compared: an unexpected difference surfaces a reload-theirs / keep-mine
// choice instead of a write. Our own saves move the baseline, so
// Rundock-caused writes (including agent writes we then reload) never
// false-positive; a disk state identical to what we are writing is not a
// conflict either.
const diskBaselines = new Map();

async function saveFileGuarded(path, content) {
  let disk = null;
  try {
    const res = await fetch('/api/file?path=' + encodeURIComponent(path));
    if (res.ok) disk = (await res.text()).replace(/\r\n?/g, '\n');
  } catch { /* offline check: fall through and save as before */ }
  const baseline = diskBaselines.get(path);
  if (disk !== null && baseline !== undefined && disk !== baseline && disk !== content) {
    showExternalEditConflict(path, disk, content);
    return false;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'save_file', path, content }));
    diskBaselines.set(path, content);
    // Track what we just wrote as the current bytes for the open file. Without
    // this, a surface whose live content falls back to rawFileContent (the
    // board) looks stale when the file-watcher echoes our own save back, and
    // the echo is misread as an external change.
    if (path === currentFilePath) { rawFileContent = content; editorDirty = false; }
  }
  const statusEl = document.getElementById('editor-status');
  if (statusEl) {
    statusEl.style.color = 'var(--success)';
    statusEl.textContent = 'Saved';
  }
  hideExternalEditConflict();
  return true;
}

function hideExternalEditConflict() {
  const banner = document.getElementById('external-edit-banner');
  if (banner) banner.remove();
}

function showExternalEditConflict(path, diskContent, myContent) {
  hideExternalEditConflict();
  const statusEl = document.getElementById('editor-status');
  if (statusEl) {
    statusEl.style.color = 'var(--attention)';
    statusEl.textContent = 'Changed outside Rundock';
  }
  const header = document.getElementById('editor-header');
  if (!header) return;
  const banner = document.createElement('div');
  banner.id = 'external-edit-banner';
  banner.innerHTML = `
    <span class="banner-text">This file changed outside Rundock while you were editing.</span>
    <button type="button" class="banner-btn" data-choice="theirs">Reload theirs</button>
    <button type="button" class="banner-btn primary" data-choice="mine">Keep mine</button>`;
  banner.addEventListener('click', (e) => {
    const btn = e.target.closest('.banner-btn');
    if (!btn || currentFilePath !== path) return;
    if (btn.dataset.choice === 'theirs') {
      hideExternalEditConflict();
      diskBaselines.set(path, diskContent);
      loadFileContent(path, diskContent);
      const s = document.getElementById('editor-status');
      if (s) { s.style.color = 'var(--success)'; s.textContent = 'Reloaded'; }
    } else {
      // Keep mine: an explicit human decision to overwrite.
      diskBaselines.set(path, diskContent); // guard passes because disk now matches
      saveFileGuarded(path, myContent);
    }
  });
  header.insertAdjacentElement('afterend', banner);
}

// The live content of whatever surface is open, for the external-refresh
// clean/dirty decision. Each surface holds its live edits differently: a
// board's freshest bytes are its pending debounced write, the rich editor's
// are the live ProseMirror serialization, the source view's are the textarea,
// and a read-only viewer has none (null -> always safe to take newer bytes).
function currentLiveContent() {
  if (boardPendingSave && boardPendingSave.path === currentFilePath) return boardPendingSave.md;
  if (activeTiptapEditor && _tiptapEditorModuleResolved) {
    try { return _tiptapEditorModuleResolved.getMarkdown(activeTiptapEditor); } catch (e) { /* fall through */ }
  }
  if (editorMode === 'edit') {
    const ta = document.getElementById('editor-textarea');
    if (ta) return ta.value;
  }
  return rawFileContent;
}

// Live external refresh: the server pushes file_changed when the open file
// changes on disk. Reload seamlessly when the editor is clean; if there are
// unsaved local edits, fall back to the same reload-theirs / keep-mine choice
// the save-time guard already uses, so no edit is ever silently overwritten.
function handleExternalFileChange(path, diskContent) {
  if (path !== currentFilePath) return;
  const action = ExternalRefresh.externalChangeAction({
    disk: diskContent,
    baseline: diskBaselines.get(path),
    dirty: editorDirty,
  });
  if (action === 'noop') return; // our own save echoed back, or nothing new
  if (action === 'reload') {
    loadFileContent(path, diskContent); // re-renders the surface and moves the baseline
    const s = document.getElementById('editor-status');
    if (s) { s.style.color = 'var(--text-2)'; s.textContent = 'Updated from disk'; }
    return;
  }
  showExternalEditConflict(path, diskContent, currentLiveContent());
}

function destroyTiptapEditorIfActive() {
  // Capture the current instance and clear the global ref synchronously so a
  // subsequent initTiptapEditor sees a clean slate even if the module's
  // destroy promise has not yet resolved.
  const editor = activeTiptapEditor;
  activeTiptapEditor = null;
  if (editor && _tiptapEditorModule) {
    _tiptapEditorModule.then(mod => {
      try { mod.destroyEditor(editor); } catch {}
    });
  }
}

// Fully close whatever file is open and reset all file-scoped state. Used when
// switching to a DIFFERENT workspace: the previous workspace's file must never
// be left mounted in the editor/viewer. (Switching VIEWS within a workspace
// deliberately keeps the file open via currentFilePath; this runs only on a
// workspace switch.) Pending debounced writes are CANCELLED, never flushed: by
// the time this runs the server's WORKSPACE has already changed, so a flush
// would resolve the old relative path against the new workspace and could
// overwrite a same-named file there with stale content.
function closeOpenFile() {
  clearTimeout(_tiptapSaveTimer);
  clearTimeout(saveTimer);
  if (boardSaveTimer) { clearTimeout(boardSaveTimer); boardSaveTimer = null; }
  boardPendingSave = null;
  destroyActiveFileViewer();      // artifact review + iframe/board viewer
  destroyTiptapEditorIfActive();  // tiptap editor
  currentFilePath = null;
  rawFileContent = ''; fileFrontmatter = ''; fileBody = '';
  editorMode = 'preview';
  editorDirty = false;
  fileHistory = [];
  closeFindBar();
  removeFileConnections();
  document.querySelectorAll('.file-item.active').forEach((el) => el.classList.remove('active'));
}

// The tree as it is currently drawn, which is what an incoming push is
// compared against. Deliberately not cachedFileTree: that belongs to wikilink
// resolution, is assigned at a different moment, and tying rendering to it
// would couple two things that only look alike.
let renderedTree = null;
// Which workspace the drawn tree belongs to. Without this, switching
// workspaces patches the new tree onto the old one's DOM: paths are matched as
// plain strings with nothing scoping them to a workspace, and a fresh
// workspace is scaffolded from a template, so the shared paths look like
// survivors and carry their expanded state across from somewhere the user has
// never been. Checked where the decision is made rather than reset by whoever
// happens to handle the switch, so a new caller cannot forget it.
let renderedWorkspace = null;

// Which folders are open is no longer tracked anywhere. It lives in the DOM,
// on the class, because the node holding it is never destroyed. The Set that
// used to shadow it existed only to survive the rebuild that no longer
// happens.
function renderFileTree(tree) {
  // A changed tree can change what any link resolves to, and a file opened
  // before the first tree arrived rendered its connections against nothing:
  // redraw the open file's section now that there is a tree to resolve with.
  if (currentFilePath && document.getElementById('file-connections')) {
    const section = document.getElementById('file-connections');
    renderFileConnections(section.parentElement);
  }
  const c = document.getElementById('file-tree');
  const next = tree || [];

  // Reconciliation needs a drawn tree to reconcile against. Entering or
  // leaving the empty state replaces the container wholesale, and an empty
  // container has nothing worth preserving, so those stay full builds.
  const sameWorkspace = renderedWorkspace === currentWorkspacePath;
  const canPatch = sameWorkspace && next.length && renderedTree && renderedTree.length && c.firstElementChild;
  if (canPatch) {
    try {
      patchTree(c, RundockFileTreeDiff.diffTree(renderedTree, next));
      renderedTree = next;
      return;
    } catch (e) {
      // A patch that does not fit the DOM means the two have drifted apart.
      // Falling through to a full rebuild is always correct, and it is the
      // behaviour this whole change replaces, so the worst case is the old
      // one rather than a sidebar quietly disagreeing with the disk.
      console.warn('[FileTree] reconcile failed, rebuilding:', e && e.message);
    }
  }
  renderedTree = next;
  renderedWorkspace = currentWorkspacePath;
  rebuildFileTree(c, next);
}

/**
 * Execute a diff against the live DOM. Throws rather than skipping when an
 * operation does not fit: the caller turns that into a rebuild, and a silently
 * dropped operation would leave the tree wrong with nothing to notice it.
 */
function patchTree(rootEl, ops) {
  for (const op of ops) {
    const container = treeContainerEl(rootEl, op.parent);
    if (!container) throw new Error(`no container for "${op.parent}"`);

    if (op.op === 'insert') {
      const frag = document.createDocumentFragment();
      buildTree([op.node], frag);
      // A folder occupies two elements, its row and the children box beneath
      // it, so positions are counted in rows and never in child nodes.
      const rows = treeRows(container);
      container.insertBefore(frag, rows[op.index] || null);
      continue;
    }

    const row = treeRows(container).find(el => el.dataset.path === op.path);
    if (!row) throw new Error(`no row "${op.path}" in "${op.parent}"`);

    if (op.op === 'remove') {
      const kids = row.nextElementSibling;
      if (row.classList.contains('folder-item') && kids && kids.classList.contains('file-children')) {
        kids.remove();
      }
      row.remove();
    } else if (op.op === 'update') {
      const svg = row.querySelector('svg.file-item-icon');
      if (svg) svg.innerHTML = TREE_ICONS[op.kind] || TREE_ICONS.file;
    } else {
      throw new Error(`unknown operation "${op.op}"`);
    }
  }
}

/** Direct child rows of a container, in order. Excludes the children boxes. */
function treeRows(containerEl) {
  return Array.from(containerEl.children).filter(el =>
    el.classList.contains('folder-item') || el.classList.contains('file-item'));
}

/**
 * The element that holds a path's children, or the root for the empty path.
 *
 * Compares dataset values rather than building a selector out of a path. An
 * earlier version escaped only the backslash and the quote, which left every
 * other character CSS treats as syntax: a file called `notes [draft].md` threw
 * a DOMException, and because the caller turns a throw into a rebuild, those
 * names would have quietly lost the whole benefit of this change. Square
 * brackets in filenames are ordinary in a vault. This is also the lookup
 * pattern the rest of the file already uses.
 */
function treeContainerEl(rootEl, parentPath) {
  if (!parentPath) return rootEl;
  const row = Array.from(rootEl.querySelectorAll('.folder-item'))
    .find(el => el.dataset.path === parentPath);
  const kids = row && row.nextElementSibling;
  return kids && kids.classList.contains('file-children') ? kids : null;
}

function rebuildFileTree(c, tree) {
  const editorEmpty=document.getElementById('editor-empty');
  c.innerHTML='';
  if(!tree||!tree.length) {
    c.innerHTML=`<div style="padding:12px 16px"><div style="color:var(--text-2);font-size:var(--caption);line-height:1.6">No files yet</div></div>`;
    const guide = getGuide();
    if(editorEmpty) editorEmpty.innerHTML=`
      <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" class="empty-icon"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <div class="empty-title">No files yet</div>
      ${guide ? `<button class="empty-cta" style="margin-top:8px" data-agent-id="${escAttr(guide.id)}" onclick="startConversation(this.dataset.agentId)">Talk to Doc</button>` : ''}`;
    return;
  }
  if(editorEmpty) editorEmpty.innerHTML=`
    <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" class="empty-icon"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
    <span style="color:var(--text-2);font-size:var(--body)">Select a file from the sidebar</span>`;
  buildTree(tree,c);
}

function treeIconSvg(inner) {
  return '<svg class="file-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
}
// The palette draws the same glyphs as the file tree, so a file looks the same
// wherever it appears and the two cannot drift. Only the frame differs: tree
// rows size their icon from CSS, palette rows carry explicit dimensions.
function paletteFileIcon(kind) {
  const inner = TREE_ICONS[kind] || TREE_ICONS.file;
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
}
function buildTree(items,container) {
  for(const item of items) {
    if(item.type==='folder') {
      const f=document.createElement('div'); f.className='folder-item'; f.innerHTML=`${treeIconSvg(TREE_ICONS.folder)}<span class="file-item-name">${esc(item.name)}</span>`;
      f.dataset.path=item.path;
      f.onclick=()=>{const ch=f.nextElementSibling,svg=f.querySelector('svg.file-item-icon');const collapsed=ch.classList.toggle('collapsed');if(svg)svg.innerHTML=collapsed?TREE_ICONS.folder:TREE_ICONS.folderOpen;};
      f.oncontextmenu=(e)=>{e.preventDefault();openRowContextMenu(e,item.path,'folder');};
      container.appendChild(f);
      const ch=document.createElement('div'); ch.className='file-children collapsed'; buildTree(item.children,ch); container.appendChild(ch);
    } else {
      const fi=document.createElement('div'); fi.className='file-item';
      fi.innerHTML=`${treeIconSvg(TREE_ICONS[item.kind]||TREE_ICONS.file)}<span class="file-item-name">${esc(item.name)}</span>`;
      fi.dataset.path = item.path;
      fi.onclick=()=>{document.querySelectorAll('.file-item').forEach(x=>x.classList.remove('active'));fi.classList.add('active');editorReturnView='editor';fileHistory=[];ws.send(JSON.stringify({type:'read_file',path:item.path}));showView('editor');};
      fi.oncontextmenu=(e)=>{e.preventDefault();openRowContextMenu(e,item.path,'file');};
      container.appendChild(fi);
    }
  }
}


function contentForKind(kind) {
  return kind === 'board' && window.Kanban ? window.Kanban.newBoardContent() : '';
}
function menuIconSvg(inner) {
  return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" '
    + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
}

let _filesMenu = null;
function closeFilesMenu() {
  if (_filesMenu) { _filesMenu.remove(); _filesMenu = null; }
}

// A small floating menu at (x, y) built from [label, fn, icon, danger] rows
// (falsy row = a divider). Returns the menu element.
function buildFloatingMenu(x, y, rows) {
  document.dispatchEvent(new CustomEvent('rundock:closemenus')); // dismiss any other open menu first
  const menu = document.createElement('div');
  menu.className = 'files-menu';
  for (const row of rows) {
    if (!row) { const d = document.createElement('div'); d.className = 'files-menu-divider'; menu.appendChild(d); continue; }
    const [label, fn, icon, danger] = row;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'files-menu-item' + (danger ? ' danger' : '');
    btn.innerHTML = (icon ? menuIconSvg(icon) : '') + '<span>' + esc(label) + '</span>';
    btn.addEventListener('click', (e) => { e.stopPropagation(); closeFilesMenu(); fn(); });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
  _filesMenu = menu;
  return menu;
}

// Replace the menu's contents with an inline name input (the standing small-
// input composer grammar): Enter creates, Escape cancels.
function promptCreate(menu, type, folder) {
  menu.innerHTML = '';
  const field = document.createElement('div');
  field.className = 'files-menu-field';
  const input = document.createElement('input');
  input.type = 'text';
  // Note, board, and folder all behave identically. The default name is the
  // single source of truth: pre-filled and selected so the user types over it
  // or accepts it with Enter. The placeholder is a plain fallback for the rare
  // cleared-field state (the type is already obvious from the menu item).
  input.value = type.label;
  input.placeholder = 'Name';
  field.appendChild(input);
  menu.appendChild(field);
  input.focus();
  input.select();
  const submit = () => {
    const rel = FilesMenuModel.creatablePath(folder, input.value, type.ext);
    if (!rel) { closeFilesMenu(); return; }
    ws.send(JSON.stringify({ type: 'create_path', kind: type.kind, path: rel, content: contentForKind(type.kind) }));
    closeFilesMenu();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFilesMenu(); }
  });
  // Keep the menu open while the field is focused.
}

// A creation row: opens an inline name field (keeping the chosen type's icon).
function creationRow(t, x, y, folder) {
  return [t.label, () => {
    const m = buildFloatingMenu(x, y, [[t.label, () => {}, t.icon]]);
    promptCreate(m, t, folder);
  }, t.icon];
}

// The "+" header menu: creation rows only, creating at workspace root. The
// button toggles: clicking it while the menu is open closes it (the button's
// own click fires before the outside-click handler, so without this it would
// close and immediately reopen).
function openCreateMenu(anchor, folder) {
  if (_filesMenu) { closeFilesMenu(); return; }
  const r = anchor.getBoundingClientRect();
  buildFloatingMenu(r.left, r.bottom + 4, CREATABLE_TYPES.map((t) => creationRow(t, r.left, r.bottom + 4, folder)));
}

// Right-click on a row: the same creation rows (creating IN the folder, or the
// file's parent), plus clipboard and reveal actions.
function openRowContextMenu(e, targetPath, targetKind) {
  const folder = FilesMenuModel.parentFolder(targetPath, targetKind === 'folder');
  const rows = CREATABLE_TYPES.map((t) => creationRow(t, e.clientX, e.clientY, folder));
  rows.push(null);
  rows.push(['Copy workspace path', () => { try { navigator.clipboard.writeText(targetPath); } catch (err) {} }, FilesMenuModel.ICONS.copy]);
  rows.push(['Copy wikilink', () => { try { navigator.clipboard.writeText(FilesMenuModel.wikilinkFor(targetPath)); } catch (err) {} }, FilesMenuModel.ICONS.link]);
  // Reveal in Finder only works on macOS (the server no-ops elsewhere), so the
  // row is hidden off darwin rather than shown as a dead action.
  if (serverPlatform === 'darwin') {
    rows.push(['Reveal in Finder', () => ws.send(JSON.stringify({ type: 'reveal_in_finder', path: targetPath })), FilesMenuModel.ICONS.reveal]);
  }
  buildFloatingMenu(e.clientX, e.clientY, rows);
}


function loadFileContent(path, content) {
  // Close any active find before swapping the editor content.
  if (currentFilePath !== path) closeFindBar();
  flushBoardSave(); // never drop a board's last edit when switching files
  destroyActiveFileViewer();
  hideExternalEditConflict();
  currentFilePath = path;
  rawFileContent = content;
  // The previous file's connections must not outlive it under ANY next
  // surface, including the read-only viewers and boards that never draw a
  // section of their own.
  removeFileConnections();
  editorDirty = false; // freshly loaded: no unsaved edits
  // Reset the Preview/Code mode on every open. Only the legacy text surface
  // used to reset it, so a stale 'edit' left over from a previous text file
  // could leak into a markdown, board, or read-only viewer and make find or
  // currentLiveContent misbehave.
  editorMode = 'preview';
  // What we believe is on disk: the external-edit guard compares against
  // this before every save.
  diskBaselines.set(path, content);
  document.getElementById('editor-filename').textContent = path;
  document.getElementById('editor-status').textContent = '';
  document.getElementById('editor-header').classList.remove('hidden');
  document.getElementById('editor-empty').classList.add('hidden');
  updateEditorBackButton();

  // The file-type registry decides the surface for EVERY path (it replaced
  // the old per-type if-chain). markdown -> Tiptap editor,
  // text -> legacy preview/edit pane, artifact -> sandboxed preview with
  // the legacy code view, image/pdf -> read-only viewers over the binary
  // endpoint, anything else -> the cannot-preview state. A new file type
  // lands as one registry entry + one surface function, no dispatch edits.
  loadViewersModule().then((viewers) => {
    if (currentFilePath !== path) return; // stale: another file opened while the module loaded
    // A markdown file whose frontmatter carries the kanban-plugin key opens as
    // a board (detection is content-based, so it cannot ride the path-keyed
    // classify table); everything else dispatches by file kind.
    if (viewers.classify(path) === 'markdown' && window.Kanban && window.Kanban.isBoardFile(content)) {
      openBoardFile(path, content);
      return;
    }
    const surface = FILE_SURFACES[viewers.classify(path)] || openBinaryOrUnsupportedFile;
    surface(viewers, path, content);
  });
}

// Board view: a writable registry view. Mounts the board into the editor pane
// and wires its edits to the same guarded autosave the editor uses. Unlike the
// read-only viewers, its getContentForSave is non-null (unless the board holds
// content the grammar would drop, in which case saving is refused).
let boardSaveTimer = null;
let boardPendingSave = null; // { path, md }: the latest debounced board write
// Flush a pending board save immediately. Called before opening any file so a
// board's last edit is never dropped when switching away inside the debounce
// window (the pending save carries its own path, so it writes the right file).
function flushBoardSave() {
  if (boardSaveTimer) { clearTimeout(boardSaveTimer); boardSaveTimer = null; }
  if (boardPendingSave) {
    const p = boardPendingSave;
    boardPendingSave = null;
    saveFileGuarded(p.path, p.md);
  }
}
function openBoardFile(path, content) {
  destroyTiptapEditorIfActive();
  document.getElementById('tiptap-editor-pane').classList.add('hidden');
  document.getElementById('toggle-preview').classList.add('hidden');
  document.getElementById('toggle-edit').classList.add('hidden');
  document.getElementById('editor-textarea').classList.add('hidden');
  const pane = document.getElementById('editor-content');
  pane.classList.remove('hidden');
  pane.className = 'editor-content';
  import('/viewers/board-view.js').then((mod) => {
    if (currentFilePath !== path) return; // stale
    activeFileViewer = mod.mountBoardView({ paneElement: pane, path, content, onWikilink: (target) => openWikilink(target) }, window.Kanban);
    if (typeof activeFileViewer.setOnChange === 'function' && typeof activeFileViewer.getContentForSave === 'function') {
      activeFileViewer.setOnChange(() => {
        const md = activeFileViewer.getContentForSave();
        if (md == null) return; // save refused (droppable content)
        const status = document.getElementById('editor-status');
        if (status) { status.textContent = 'Unsaved'; status.style.color = 'var(--attention)'; }
        editorDirty = true;
        boardPendingSave = { path, md };
        clearTimeout(boardSaveTimer);
        boardSaveTimer = setTimeout(flushBoardSave, 500);
      });
    }
  });
}

const FILE_SURFACES = {
  markdown: openMarkdownFile,
  text: openLegacyTextFile,
  artifact: openLegacyTextFile, // preview mode mounts the sandboxed iframe from renderEditorContent
  image: openBinaryOrUnsupportedFile,
  pdf: openBinaryOrUnsupportedFile,
  unsupported: openBinaryOrUnsupportedFile,
};

// Markdown: the Tiptap surface; the legacy DOM and Preview/Edit toggle are
// hidden and the Tiptap pane is shown and seeded.
function openMarkdownFile(viewers, path, content) {
  document.getElementById('editor-content').classList.add('hidden');
  document.getElementById('editor-textarea').classList.add('hidden');
  document.getElementById('toggle-preview').classList.add('hidden');
  document.getElementById('toggle-edit').classList.add('hidden');
  document.getElementById('tiptap-editor-pane').classList.remove('hidden');
  fileFrontmatter = '';
  fileBody = content;
  initTiptapEditor(path, content);
  // The connections list rides this surface because this is the surface a
  // linked document is read on: markdown is the one file kind that carries
  // wikilinks. Mounted on the pane, beside the editor element rather than
  // inside it, because the editor owns its own element's children and clears
  // them on init.
  renderFileConnections(document.getElementById('tiptap-editor-pane'));
}

// Text keeps the legacy preview/edit chrome; artifacts share it so the Code
// toggle (raw source, still editable and saveable) keeps working, with
// preview mode mounting the sandboxed iframe from renderEditorContent.
function openLegacyTextFile(viewers, path, content) {
  destroyTiptapEditorIfActive();
  document.getElementById('tiptap-editor-pane').classList.add('hidden');
  document.getElementById('toggle-preview').classList.remove('hidden');
  document.getElementById('toggle-edit').classList.remove('hidden');
  document.getElementById('editor-content').classList.remove('hidden');

  // Split frontmatter from body
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (fmMatch) {
    fileFrontmatter = '---\n' + fmMatch[1] + '\n---\n';
    fileBody = fmMatch[2];
  } else {
    fileFrontmatter = '';
    fileBody = content;
  }

  // Always open in preview mode
  editorMode = 'preview';
  renderEditorContent();
}

// Read-only viewers own the pane: no Preview/Code toggle, and no save path
// (their bytes ride /workspace-file; the WS text content for a binary file
// is utf-8-mangled and must never be written back).
function openBinaryOrUnsupportedFile(viewers, path) {
  destroyTiptapEditorIfActive();
  document.getElementById('tiptap-editor-pane').classList.add('hidden');
  document.getElementById('toggle-preview').classList.add('hidden');
  document.getElementById('toggle-edit').classList.add('hidden');
  document.getElementById('editor-textarea').classList.add('hidden');
  const pane = document.getElementById('editor-content');
  pane.classList.remove('hidden');
  pane.className = 'editor-content';
  activeFileViewer = viewers.mountViewer(viewers.classify(path), { paneElement: pane, path });
}

function renderEditorContent() {
  const previewEl = document.getElementById('editor-content');
  const textareaEl = document.getElementById('editor-textarea');
  document.getElementById('toggle-preview').classList.toggle('active', editorMode === 'preview');
  document.getElementById('toggle-edit').classList.toggle('active', editorMode === 'edit');

  if (editorMode === 'preview') {
    textareaEl.classList.add('hidden');
    previewEl.classList.remove('hidden');
    destroyActiveFileViewer();
    // Artifact files (html/svg) preview as their real rendered DOM in a
    // sandboxed iframe instead of a markdown-ish approximation.
    if (_viewersModuleResolved && _viewersModuleResolved.classify(currentFilePath) === 'artifact') {
      previewEl.className = 'editor-content';
      activeFileViewer = _viewersModuleResolved.mountArtifactPreview({ paneElement: previewEl, content: rawFileContent });
      attachArtifactReviewForCurrentFile(previewEl);
      return;
    }
    previewEl.className = 'editor-content formatted';
    previewEl.innerHTML = formatMdFull(fileBody);
    renderFileConnections(previewEl.parentElement);
  } else {
    // Leaving preview for the code view: the section describes the rendered
    // document, and the code view is not it.
    removeFileConnections();
    destroyActiveFileViewer();
    previewEl.classList.add('hidden');
    textareaEl.classList.remove('hidden');
    textareaEl.className = 'editor-content source';
    textareaEl.value = rawFileContent;
    textareaEl.focus();
  }
}

// The connections list: what links here, what this links to. A LIST, not a
// canvas, drawn under the rendered file from the same resolver every click
// goes through. Built with createElement throughout: nothing here may
// interpolate file names into markup.
//
// ONE REMOVER, CALLED ON EVERY WAY OUT. The section describes one file, so
// its lifetime is the file's: every open of any surface starts by removing
// it (loadFileContent), closing the file removes it, and leaving preview for
// the code view removes it. The first version removed it only at the top of
// its own renderer, so a text file's connections stayed mounted under the
// next markdown file, naming links that belonged to a document no longer on
// screen.
function removeFileConnections() {
  const section = document.getElementById('file-connections');
  if (section) section.remove();
}

function renderFileConnections(host) {
  if (!host) return;
  removeFileConnections();
  if (!currentFilePath) return;
  const section = document.createElement('div');
  section.id = 'file-connections';
  section.className = 'file-connections';
  host.appendChild(section);
  const forFile = currentFilePath;
  fetchWorkspaceLinks().then((data) => {
    // The reader may have moved on while the fetch was out.
    if (currentFilePath !== forFile || !document.getElementById('file-connections')) return;
    drawFileConnections(section, forFile, data);
  }).catch(() => {
    // Links unavailable is a statement, not a blank: say why the list is
    // not here rather than leaving a heading over nothing.
    drawFileConnections(section, forFile, null);
  });
}

function drawFileConnections(section, filePath, data) {
  while (section.firstChild) section.removeChild(section.firstChild);
  const heading = document.createElement('div');
  heading.className = 'file-connections-heading';
  heading.textContent = 'Connections';
  section.appendChild(heading);
  const note = (text) => {
    const p = document.createElement('div');
    p.className = 'file-connections-empty';
    p.textContent = text;
    section.appendChild(p);
  };
  if (!data) { note('Connections are unavailable: the link index could not be read.'); return; }
  if (data.indexed === false) { note('Connections need the search index, which this runtime does not have.'); return; }
  const { outgoing, incoming } = fileConnections(filePath, data.links, cachedFileTree || []);
  const group = (label, rows, pathOf) => {
    const title = document.createElement('div');
    title.className = 'file-connections-group';
    title.textContent = label;
    section.appendChild(title);
    if (!rows.length) { note('None.'); return; }
    for (const row of rows) {
      const target = pathOf(row);
      const a = document.createElement('a');
      a.className = 'file-connections-row';
      a.textContent = target;
      a.addEventListener('click', () => openWorkspaceFilePath(target));
      section.appendChild(a);
    }
  };
  group('Links to', outgoing, (r) => r.resolved);
  group('Linked from', incoming, (r) => r.src);
}

function fetchWorkspaceLinks() {
  // ONE FETCH PER RENDER, AND NO CACHE ACROSS OPENS, deliberately. A file's
  // links change on a content edit, and a content edit changes no tree: the
  // tree carries only names and paths, so no client event reliably announces
  // that an answer moved. A first version cached this answer and dropped it
  // only when the tree redrew, which meant a link typed into a note was
  // missing from every connections list for the rest of the session. The
  // payload is small and a render happens on a file open, so the honest
  // fetch costs less than the stale answer did.
  return fetch('/api/graph').then((r) => {
    if (!r.ok) throw new Error('links unavailable');
    return r.json();
  });
}

function setEditorMode(mode) {
  if (mode !== editorMode && findState.open) closeFindBar(); // find backend differs per mode
  if (mode === 'preview' && editorMode === 'edit') {
    // Switching from edit to preview: capture changes first
    rawFileContent = document.getElementById('editor-textarea').value;
    const fmMatch = rawFileContent.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (fmMatch) { fileFrontmatter = '---\n' + fmMatch[1] + '\n---\n'; fileBody = fmMatch[2]; }
    else { fileFrontmatter = ''; fileBody = rawFileContent; }
  }
  editorMode = mode;
  renderEditorContent();
}

function getFileContentForSave() {
  if (editorMode === 'edit') {
    rawFileContent = document.getElementById('editor-textarea').value;
  }
  return rawFileContent;
}

// Wikilink navigation
function openWikilink(name) {
  // Agents reference their outputs by wikilink: [[chart.png]] or
  // [[report.pdf]] must open the real file through the registry, not chase
  // a phantom chart.png.md. Only extensionless targets get the .md default,
  // decided in wikilinkSearchName so every resolving surface agrees.
  const searchName = wikilinkSearchName(name);
  editorReturnView = 'editor';

  // Push current file onto history so back button returns to it
  if (currentFilePath) fileHistory.push(currentFilePath);
  if (fileHistory.length > 20) fileHistory.shift();

  // Search the cached file tree data (not the DOM)
  if (cachedFileTree) {
    const match = findFileInTree(cachedFileTree, searchName);
    if (match) {
      switchNav('files');
      ws.send(JSON.stringify({ type: 'read_file', path: match }));
      showView('editor');
      highlightFileInSidebar(match);
      return;
    }
  }

  // If not found in cache, ask the server directly
  if (ws) {
    ws.send(JSON.stringify({ type: 'read_file', path: searchName }));
    switchNav('files');
    showView('editor');
    highlightFileInSidebar(searchName);
  }
}

// Open a workspace file by its exact path. read_file routes it to the right
// viewer by extension (markdown, HTML/SVG artifact, image, PDF), like a
// file-tree click. Used by internal links clicked inside an artifact.
function openWorkspaceFilePath(path) {
  if (!path || !ws) return;
  editorReturnView = 'editor';
  if (currentFilePath) { fileHistory.push(currentFilePath); if (fileHistory.length > 20) fileHistory.shift(); }
  switchNav('files');
  ws.send(JSON.stringify({ type: 'read_file', path }));
  showView('editor');
  highlightFileInSidebar(path);
}

function highlightFileInSidebar(filePath) {
  document.querySelectorAll('.file-item').forEach(x => x.classList.remove('active'));
  const target = Array.from(document.querySelectorAll('.file-item')).find(fi => fi.dataset.path === filePath);
  if (!target) return;
  target.classList.add('active');
  // Reveal it: expand every collapsed ancestor folder so the highlighted file
  // is actually visible, then scroll it into view within the sidebar.
  let node = target.parentElement;
  while (node && node !== document.body) {
    if (node.classList && node.classList.contains('file-children') && node.classList.contains('collapsed')) {
      node.classList.remove('collapsed');
      const folder = node.previousElementSibling;
      // No bookkeeping needed to make the reveal stick: a structural change
      // patches the tree around this node instead of replacing it.
      // Swap the folder's icon to the open-folder SVG, matching the manual
      // click-expand path. The earlier selector (.folder-icon) matched nothing
      // and injected a text chevron into an <svg>, so the icon stayed closed.
      const svg = folder && folder.classList.contains('folder-item') ? folder.querySelector('svg.file-item-icon') : null;
      if (svg) svg.innerHTML = TREE_ICONS.folderOpen;
    }
    node = node.parentElement;
  }
  if (target.scrollIntoView) target.scrollIntoView({ block: 'nearest' });
}

// THE ONE RESOLVER, and the precedence is the point.
//
// The first version of this applied its rules PER FILE while walking the
// tree, so a basename match on an earlier file returned before an exact path
// match on a later file was ever considered. Since a file whose full path
// equals the search string also has a matching basename by definition, exact
// path matching could only ever fire when the first basename match in tree
// order happened to also be the exact path: it was effectively unreachable,
// and a fully qualified link could open a different file of the same name in
// whichever folder sorted first. Renaming an unrelated folder changed where
// links went.
//
// So the rules are now applied ACROSS the whole tree, in order:
//   1. Exact path match (case-insensitive). A full path names one file; if it
//      is present, nothing else may win.
//   2. Basename match, tied by SHORTEST PATH first and TREE ORDER second. A
//      bare [[Notes]] most plausibly means the least-nested Notes; between
//      equals, the tree's own order decides, which is the one deterministic
//      answer the previous behavior gave that was worth keeping.
//
// The old third rule (basename with the first '.md' occurrence stripped and
// re-appended) is gone: for every ordinary name it was identical to rule 2,
// and for a name carrying '.md' mid-string it could match a file the link
// never named. Nothing may match under a rule a reader cannot predict.
function findFileInTree(items, searchName) {
  const searchLower = String(searchName).toLowerCase();
  const searchBase = searchLower.split('/').pop();
  let best = null;
  let order = 0;
  (function walk(list) {
    for (const item of list) {
      if (item.type === 'file') {
        const at = order++;
        if (item.path.toLowerCase() === searchLower) {
          if (!best || !best.exact) best = { path: item.path, exact: true };
        } else if (!(best && best.exact) && item.name.toLowerCase() === searchBase) {
          const depth = item.path.split('/').length;
          if (!best || depth < best.depth || (depth === best.depth && at < best.at)) {
            best = { path: item.path, exact: false, depth, at };
          }
        }
      } else if (item.type === 'folder' && item.children) {
        walk(item.children);
      }
    }
  })(items);
  return best ? best.path : null;
}

// The search string a link target becomes, in one place: the #anchor dropped
// (it is parsed and never used to scroll), and .md appended unless the target
// already names an extension the app can view. Every surface that resolves a
// link builds its search string here, so no two surfaces can disagree about
// what a target means before resolution even starts.
const VIEWABLE_LINK_EXT_RE = /\.(md|mdx|txt|json|html?|svg|png|jpe?g|gif|webp|pdf)$/i;
function wikilinkSearchName(target) {
  const baseName = String(target).split('#')[0].trim();
  return VIEWABLE_LINK_EXT_RE.test(baseName) ? baseName : baseName + '.md';
}

/**
 * What links here, and what this links to, as data the view can draw.
 *
 * Pure, so the whole answer is testable without a browser. `links` is the
 * as-written link list (source path, raw target); resolution happens here,
 * through the same findFileInTree every click goes through, so the list and
 * the click can never name different files. Embeds are excluded: they render
 * a file inside another rather than linking to it.
 */
function fileConnections(filePath, links, tree) {
  const outgoing = [];
  const incoming = [];
  const seenOut = new Set();
  const seenIn = new Set();
  for (const link of links || []) {
    if (link.kind === 'embed') continue;
    const resolved = findFileInTree(tree || [], wikilinkSearchName(link.target));
    if (link.src === filePath && resolved && resolved !== filePath && !seenOut.has(resolved)) {
      seenOut.add(resolved);
      outgoing.push({ target: link.target, resolved });
    }
    if (resolved === filePath && link.src !== filePath && !seenIn.has(link.src)) {
      seenIn.add(link.src);
      incoming.push({ src: link.src });
    }
  }
  return { outgoing, incoming };
}


// The editor back control is only useful when "back" leads somewhere: to the
// view a file was opened from (Skills, Agents) or to the previous file in a
// wikilink chain. Opened straight from the file tree with no history, "back"
// would only blank the pane, which reads as losing your place, so it is hidden.
function updateEditorBackButton() {
  const btn = document.getElementById('editor-back');
  if (!btn) return;
  const useful = editorReturnView !== 'editor' || fileHistory.length > 0;
  btn.style.display = useful ? '' : 'none';
}

function openSkillFile(filePath) {
  editorReturnView = 'skills';
  fileHistory = [];
  ws.send(JSON.stringify({ type: 'read_file', path: filePath }));
  showView('editor');
}

function editorGoBack() {
  // If opened from another view (e.g. skills), return there
  if (editorReturnView !== 'editor') {
    showView(editorReturnView);
    editorReturnView = 'editor';
    fileHistory = [];
    return;
  }
  // If there's a previous file in history, go back to it
  if (fileHistory.length) {
    const prev = fileHistory.pop();
    ws.send(JSON.stringify({ type: 'read_file', path: prev }));
    highlightFileInSidebar(prev);
    updateEditorBackButton();
    return;
  }
  // No useful back target: this branch is now unreachable from the UI (the
  // control hides itself in that state), but keep the safe fallback.
  currentFilePath = null;
  destroyTiptapEditorIfActive();
  document.getElementById('editor-header').classList.add('hidden');
  document.getElementById('editor-content').classList.add('hidden');
  document.getElementById('editor-textarea').classList.add('hidden');
  document.getElementById('tiptap-editor-pane').classList.add('hidden');
  document.getElementById('editor-empty').classList.remove('hidden');
  document.querySelectorAll('.file-item').forEach(x => x.classList.remove('active'));
}


return {
  loadTiptapEditorModule, loadViewersModule,
  destroyActiveFileViewer, destroyActiveArtifactReview,
  attachArtifactReviewForCurrentFile, initTiptapEditor, onTiptapEditorUpdate,
  saveTiptapFile, saveFileGuarded, hideExternalEditConflict,
  showExternalEditConflict, currentLiveContent, handleExternalFileChange,
  destroyTiptapEditorIfActive, closeOpenFile,
  renderFileTree, treeIconSvg, paletteFileIcon, buildTree, contentForKind,
  menuIconSvg, closeFilesMenu, buildFloatingMenu, promptCreate, creationRow,
  openCreateMenu, openRowContextMenu, loadFileContent, flushBoardSave,
  openBoardFile, openMarkdownFile, openLegacyTextFile,
  openBinaryOrUnsupportedFile, renderEditorContent, setEditorMode,
  getFileContentForSave, openWikilink, openWorkspaceFilePath,
  highlightFileInSidebar, findFileInTree, wikilinkSearchName, fileConnections,
  renderFileConnections, drawFileConnections, removeFileConnections,
  updateEditorBackButton,
  openSkillFile, editorGoBack,
};
}));
