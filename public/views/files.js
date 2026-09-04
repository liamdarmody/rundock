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
      const base = String(target).split('#')[0].trim();
      return !!findFileInTree(cachedFileTree, base.endsWith('.md') ? base : base + '.md');
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
  // The extension mount is a file-scoped surface too, released in the one
  // place that releases them all: without this, a workspace switch leaves
  // the previous workspace's frame in the pane with its mediator still
  // listening, and its open messages driving navigation against the new
  // workspace.
  releaseExtensionMount();
  currentFilePath = null;
  rawFileContent = ''; fileFrontmatter = ''; fileBody = '';
  editorMode = 'preview';
  editorDirty = false;
  fileHistory = [];
  closeFindBar();
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
    // EVERY OPEN RELEASES THE LIVE MOUNT, before the board-or-seam decision,
    // so the board branch that returns early cannot leave a previous
    // extension's frame and listener alive in the pane it is about to claim.
    // The token bump also invalidates any seam open still resolving, so a
    // board opening after a claimed file cannot be repainted by the earlier
    // mount's late callback.
    releaseExtensionMount();
    // A markdown file whose frontmatter carries the kanban-plugin key opens as
    // a board (detection is content-based, so it cannot ride the path-keyed
    // classify table); everything else dispatches by file kind.
    if (viewers.classify(path) === 'markdown' && window.Kanban && window.Kanban.isBoardFile(content)) {
      openBoardFile(path, content);
      return;
    }
    const surface = FILE_SURFACES[viewers.classify(path)] || openBinaryOrUnsupportedFile;
    // THE RENDER-TARGET SEAM. An installed extension may claim this file's
    // extension through the renderer registry; a claimed file mounts through
    // the sandboxed host, and everything else falls through to the plain
    // surface exactly as before. The plain surface is also every failure's
    // destination: an unregistered target, a mount that cannot be built, a
    // view that errors or never starts, all land on `surface` with the
    // reason named, because the one thing this seam is forbidden to produce
    // is a broken frame where a working plain rendering used to be.
    openThroughRendererSeam(viewers, path, content, surface);
  });
}

// The seam's own function, cut small so a test can drive it without the rest
// of the file: consult the registry, mount through the host on a claim,
// degrade to the plain surface with the failure named on anything else.
function openThroughRendererSeam(viewers, path, content, surface) {
  // A PER-OPEN TOKEN, because currentFilePath cannot tell two opens of ONE
  // path apart. A double-click sends read_file twice and a watcher push
  // re-opens the same path; without a token both resolutions pass a
  // path-equality guard and both mount, leaking the first frame and its
  // listener, and the first's superseded degrade then repaints over the
  // live second mount. The token is captured at entry and checked in every
  // async callback: a superseded open neither mounts nor degrades.
  const token = ++extensionSeamToken;
  const superseded = () => currentFilePath !== path || token !== extensionSeamToken;
  const registry = window.rundockRendererRegistry;
  const claim = registry && registry.rendererFor ? registry.rendererFor(path) : null;
  if (!claim || !claim.registered) {
    surface(viewers, path, content);
    return;
  }
  Promise.all([
    loadExtensionHost(),
    fetchExtensionUi(claim.extension, claim.renderer),
  ]).then(([host, payload]) => {
    if (superseded()) return;
    // SUCCESS IS AN ENTRY, NOT A FLAG. The server sends its payload without
    // an `ok`, so the seam decides from the field a mount actually needs,
    // which means a transport can forward the server message verbatim. A
    // reply that names a reason, or carries no entry string, degrades.
    if (!payload || typeof payload.entry !== 'string') {
      surface(viewers, path, content);
      noteRendererFailure(payload && payload.reason
        ? payload.reason : 'the renderer payload carried no entry to mount');
      return;
    }
    const pane = claimEditorPane();
    activeExtensionMount = host.mountExtension({
      paneElement: pane,
      payload,
      onOpen: (target) => openWikilink(target),
      onDegrade: (reason) => {
        // A superseded mount that degrades tears down its own frame (the
        // host does that before calling onDegrade) but must not repaint the
        // surface: a newer open owns the pane now. It also nulls the shared
        // handle only when it still owns it, so a later closeOpenFile is
        // never handed a dead handle.
        if (token === extensionSeamToken) activeExtensionMount = null;
        if (superseded()) return;
        surface(viewers, path, content);
        noteRendererFailure(reason);
      },
    });
  }).catch((e) => {
    if (superseded()) return;
    surface(viewers, path, content);
    noteRendererFailure(String(e && e.message || e));
  });
}

// CLAIM THE EDITOR PANE, the way every surface opener does before it draws.
// Factored so an extension mount is a peer of the other surfaces rather than
// an overlay on whichever one was open: it destroys the live viewer and
// Tiptap editor (so no pending or future editor save can fire against the
// newly opened path), cancels the debounced editor save, hides the Tiptap
// pane, the textarea and the mode toggles, and resets editor-content. Every
// opener below and this seam call it, so the claim has one definition.
function claimEditorPane() {
  destroyActiveFileViewer();
  destroyTiptapEditorIfActive();
  clearTimeout(_tiptapSaveTimer);
  document.getElementById('tiptap-editor-pane').classList.add('hidden');
  document.getElementById('editor-textarea').classList.add('hidden');
  document.getElementById('toggle-preview').classList.add('hidden');
  document.getElementById('toggle-edit').classList.add('hidden');
  const pane = document.getElementById('editor-content');
  pane.classList.remove('hidden');
  pane.className = 'editor-content';
  pane.textContent = '';
  return pane;
}

// The host module loader, overridable so the seam can be driven in a test
// without a real dynamic import (which resolves against the filesystem root
// under Node and would always fail). Product code takes the import; a test
// assigns window.rundockExtensionHostLoader to hand in a stub host.
function loadExtensionHost() {
  const loader = window.rundockExtensionHostLoader;
  if (typeof loader === 'function') return Promise.resolve(loader());
  return import('/extension-host.js');
}

// The registered payload fetcher. Overridable so the seam is testable and so
// the integration that delivers extension rosters can supply its own
// transport; until one is registered the seam answers as an unregistered
// target would, which renders the plain surface.
function fetchExtensionUi(extensionId, rendererId) {
  const fetcher = window.rundockExtensionUiFetcher;
  if (typeof fetcher !== 'function') {
    return Promise.resolve({ reason: 'no extension transport is registered yet' });
  }
  return Promise.resolve(fetcher(extensionId, rendererId));
}

let activeExtensionMount = null;
// Monotonic per-open token: every seam entry claims the next value, and an
// async callback whose token is no longer current abandons its work.
let extensionSeamToken = 0;

// Release the live extension mount and invalidate any pending seam open. One
// definition, called before every file open and by closeOpenFile, so no
// frame or mediator listener outlives its file or its workspace.
function releaseExtensionMount() {
  extensionSeamToken += 1;
  if (activeExtensionMount) { activeExtensionMount.teardown(); activeExtensionMount = null; }
}

// A renderer failure is a note beside the plain rendering, never a blank:
// the person keeps their file, and the message says what stood down.
function noteRendererFailure(reason) {
  const status = document.getElementById('editor-status');
  if (status) {
    status.textContent = `Extension renderer stood down: ${reason}`;
    status.style.color = 'var(--attention)';
  }
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
  } else {
    destroyActiveFileViewer();
    previewEl.classList.add('hidden');
    textareaEl.classList.remove('hidden');
    textareaEl.className = 'editor-content source';
    textareaEl.value = rawFileContent;
    textareaEl.focus();
  }
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
  const baseName = name.split('#')[0].trim();
  // Agents reference their outputs by wikilink: [[chart.png]] or
  // [[report.pdf]] must open the real file through the registry, not chase
  // a phantom chart.png.md. Only extensionless targets get the .md default.
  const hasViewableExt = /\.(md|mdx|txt|json|html?|svg|png|jpe?g|gif|webp|pdf)$/i.test(baseName);
  const searchName = hasViewableExt ? baseName : baseName + '.md';
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

function findFileInTree(items, searchName) {
  // Normalise search: could be "filename.md" or "path/to/filename.md"
  const searchLower = searchName.toLowerCase();
  const searchBase = searchName.split('/').pop().toLowerCase();

  for (const item of items) {
    if (item.type === 'file') {
      const itemPath = item.path.toLowerCase();
      const itemName = item.name.toLowerCase();
      // Exact path match
      if (itemPath === searchLower) return item.path;
      // Exact name match
      if (itemName === searchBase) return item.path;
      // Name without .md match
      if (itemName === searchBase.replace('.md', '') + '.md') return item.path;
    } else if (item.type === 'folder' && item.children) {
      const found = findFileInTree(item.children, searchName);
      if (found) return found;
    }
  }
  return null;
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
  highlightFileInSidebar, findFileInTree, updateEditorBackButton,
  openSkillFile, editorGoBack,
};
}));
