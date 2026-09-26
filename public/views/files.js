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
// fileSaves, _viewersModule, _viewersModuleResolved, activeFileViewer,
// serverPlatform, editorMode, rawFileContent, fileFrontmatter, fileBody,
// editorDirty, workspaceOpenStartedAt, cachedFileTree,
// editorReturnView, editorEntry, fileHistory, findState, plus the call-time constants
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
      // rendered dead while clicking it worked. currentFilePath is this
      // file's own path, so a bare target resolves against the folder it was
      // actually written in, the same as a click on it would.
      return !!findFileInTree(cachedFileTree, wikilinkSearchName(target), currentFilePath);
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
  // The path and the editor are captured now, so a save flushed after the
  // person has moved on still writes the file the edit was made in, from the
  // editor it was made in.
  const path = currentFilePath;
  const editor = activeTiptapEditor;
  fileSaves.schedule(path, () => {
    const mod = _tiptapEditorModuleResolved;
    if (mod && editor) saveFileGuarded(path, mod.getMarkdown(editor));
    else if (path === currentFilePath) saveTiptapFile();
  }, 1500);
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

// `origin: 'extension'` marks a save an extension caused, which the server
// holds to the extension file rule again at write time.
async function saveFileGuarded(path, content, opts = {}) {
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
    ws.send(JSON.stringify(opts.origin === 'extension'
      ? { type: 'save_file', path, content, origin: 'extension' }
      : { type: 'save_file', path, content }));
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

// `opts` lets a file other than the open one raise the same choice: a named
// source an extension writes (see saveSourceGuarded). `owner` is the file the
// banner belongs to, and the two handlers replace the open file's own.
function showExternalEditConflict(path, diskContent, myContent, opts = {}) {
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
    <span class="banner-text">${opts.owner ? `${esc(path)}, which this view writes, changed outside Rundock.` : 'This file changed outside Rundock while you were editing.'}</span>
    <button type="button" class="banner-btn" data-choice="theirs">Reload theirs</button>
    <button type="button" class="banner-btn primary" data-choice="mine">Keep mine</button>`;
  banner.addEventListener('click', (e) => {
    const btn = e.target.closest('.banner-btn');
    if (!btn || currentFilePath !== (opts.owner || path)) return;
    if (btn.dataset.choice === 'theirs' && typeof opts.onTheirs === 'function') {
      hideExternalEditConflict();
      opts.onTheirs();
    } else if (btn.dataset.choice === 'mine' && typeof opts.onMine === 'function') {
      hideExternalEditConflict();
      opts.onMine();
    } else if (btn.dataset.choice === 'theirs') {
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
  // A writable viewer (the board) holds its freshest bytes itself, and hands
  // them back through the mount contract, pending save or not.
  if (activeFileViewer && typeof activeFileViewer.getContentForSave === 'function') {
    try { const live = activeFileViewer.getContentForSave(); if (live != null) return live; } catch (e) { /* fall through */ }
  }
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
// The editor is entered from the tree or from the Pins list, and the rail
// lights whichever the reader came in through (showView reads editorEntry
// beside its table). Every opener here says Files; the Pins list says Pins
// for itself. Guarded by typeof so this module runs in node with no shell
// around it, where the state does not exist and there is no rail to light.
function enteredFromFiles() {
  if (typeof editorEntry !== 'undefined') editorEntry = 'files';
}

function closeOpenFile() {
  fileSaves.cancel();
  destroyActiveFileViewer();      // artifact review + iframe/board viewer
  destroyTiptapEditorIfActive();  // tiptap editor
  // The extension mount is a file-scoped surface too, released in the one
  // place that releases them all: without this, a workspace switch leaves
  // the previous workspace's frame in the pane with its mediator still
  // listening, and its open messages driving navigation against the new
  // workspace.
  releaseExtensionMount();
  // And the render services go too, but only here. closeOpenFile is the
  // workspace-switch path as well as the close path, and a service holds a
  // frame running an extension installed in the workspace being left: keeping
  // it alive would carry one workspace's third-party code into the next.
  // Opening another file in the SAME workspace does not come through here,
  // which is what preserves the one-frame-per-session property.
  stopRegionServices();
  currentFilePath = null;
  rawFileContent = ''; fileFrontmatter = ''; fileBody = '';
  editorMode = 'preview';
  editorDirty = false;
  fileHistory = [];
  enteredFromFiles();
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
  // The Pins list is read against every tree that arrives, so a pinned file
  // deleted or renamed outside Rundock is marked on this push rather than on
  // the next reload. Guarded by typeof for a shell with no pins view loaded.
  if (typeof noteTreeForPins === 'function') noteTreeForPins(tree || []);
  // A changed tree can change what any link resolves to, and a file opened
  // before the first tree arrived rendered its connections against nothing:
  // redraw the open file's section now that there is a tree to resolve with.
  if (currentFilePath && document.getElementById('file-connections')) {
    const section = document.getElementById('file-connections');
    renderFileConnections(section.parentElement, { inset: section.classList.contains('file-connections-inset') });
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
      fi.onclick=()=>{document.querySelectorAll('.file-item').forEach(x=>x.classList.remove('active'));fi.classList.add('active');editorReturnView='editor';enteredFromFiles();fileHistory=[];ws.send(JSON.stringify({type:'read_file',path:item.path}));showView('editor');};
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
// file's parent), plus the pin row for a file, clipboard and reveal actions.
function openRowContextMenu(e, targetPath, targetKind) {
  const folder = FilesMenuModel.parentFolder(targetPath, targetKind === 'folder');
  const rows = CREATABLE_TYPES.map((t) => creationRow(t, e.clientX, e.clientY, folder));
  rows.push(null);
  // Pin or Unpin, for a file only: a folder is not a working surface anyone
  // returns to, and the model would mark it missing. First in the group of
  // actions on an existing file, ahead of the copy actions, per the mock.
  if (targetKind !== 'folder' && typeof pinMenuRow === 'function') rows.push(pinMenuRow(targetPath));
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
  // The header's pin control reads THIS file against the list, on every
  // open, so a pinned file followed by an unpinned one never inherits the
  // first one's answer. Guarded by typeof for a shell with no pins view.
  if (typeof renderEditorPinControl === 'function') renderEditorPinControl();

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
    const surface = plainSurfaceFor(viewers, path, content);
    if (surface === null) {
      openBoardFile(path, content);
      return;
    }
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
  // The content rides along with the path, because a renderer may claim a
  // marked subset of a container type (some .md files, never all of them)
  // and that claim can only be decided by looking at the file. This caller
  // already holds the text it is about to render, so the registry never
  // reads anything: the same reasoning that lets plainSurfaceFor detect a
  // board by content applies at this seam.
  const claim = registry && registry.rendererFor ? registry.rendererFor(path, content) : null;
  if (!claim || !claim.registered) {
    surface(viewers, path, content);
    return;
  }
  // THE SERVER'S ANSWER, BEFORE ANY FRAME. A linked, hard-linked or hidden
  // file is never handed to an extension; the server decided that from the
  // file's own metadata when it read it, and the seam only forwards it. No
  // answer at all is a refusal too.
  const refusal = typeof window.rundockExtensionRefusalFor === 'function'
    ? window.rundockExtensionRefusalFor(path) : 'Rundock has not checked this file for extensions';
  if (refusal) {
    surface(viewers, path, content);
    noteRendererFailure(refusal);
    return;
  }
  Promise.all([
    loadExtensionHost(),
    fetchExtensionUi(claim.extension, claim.renderer),
    fetchViewState(claim.extension, path),
  ]).then(([host, payload, viewState]) => {
    if (superseded()) return;
    // NAMED SOURCES, only for an extension that declared them and a note it
    // claimed by its marker; resolved before the frame exists, so init
    // carries them. Every other mount is handed an empty list.
    const wantsSources = !!(payload && payload.sources === true && claim.marker);
    return (wantsSources ? requestSources(path) : Promise.resolve(null)).then((resolved) => [host, payload, resolved, viewState]);
  }).then((ready) => {
    if (!ready || superseded()) return;
    const [host, payload, resolved, viewState] = ready;
    const handedSources = resolved && resolved.ok ? resolved.sources : [];
    noteSourceBaselines(handedSources);
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
    // Full bleed: the pane drops its padding while the view holds it, and
    // the frame's document carries the note's padding instead (editor.css,
    // extension-base.css). Every other opener resets the class.
    pane.classList.add('extension-pane');
    // WHAT IS MOUNTED, recorded beside the handle so a later roster can be
    // reconciled against it: the extension, its renderer, the version the
    // roster carried at mount time, and the file. Recorded before the mount
    // so a host that degrades synchronously clears a record that exists.
    activeExtensionMountInfo = {
      extension: claim.extension,
      renderer: claim.renderer,
      version: typeof registry.versionOf === 'function' ? registry.versionOf(claim.extension) : null,
      path,
    };
    activeExtensionMount = host.mountExtension({
      paneElement: pane,
      payload,
      // The names the host's own bar and refusal line use: the extension as
      // the roster names it, and an agent by the name the person knows it by.
      extensionName: claim.extension,
      agentName: (agentId) => {
        const agent = typeof agents !== 'undefined' && Array.isArray(agents) ? agents.find((a) => a.id === agentId) : null;
        return agent && typeof agent.displayName === 'string' ? agent.displayName : null;
      },
      // The opened file, read-only, for the init message the host posts
      // after ready. The host's cap applies here as it does to any caller.
      path,
      content,
      sources: handedSources,
      // The view's own state for this note, as last kept; the host checks it
      // again before handing it on.
      state: viewState,
      onOpen: (target) => openWikilink(target),
      // The host hands back bytes; the path is ours and is the one we
      // mounted this view for, captured here rather than read from anything
      // the frame said. A superseded mount writes nothing: by the time a
      // newer open owns the pane, a save from the old frame is a save to a
      // file the person has navigated away from.
      //
      // Through the SAME guarded save the editor uses, not a second path
      // beside it. That is where the external-edit check lives, and an
      // extension has no more right to silently overwrite a file something
      // else changed than the editor does. A second writer here would be a
      // second set of rules about somebody's files.
      onSave: (nextContent) => {
        if (token !== extensionSeamToken) return;
        // Unreachable while the registry refuses hidden paths, and kept so
        // the one write an extension can cause cannot reach an agent file or
        // a credential even if a future caller mounts one another way.
        if (window.rundockIsHiddenPath && window.rundockIsHiddenPath(path)) return;
        saveFileGuarded(path, nextContent, { origin: 'extension' });
      },
      // `change`: the view changed, and the shared debounce decides when to
      // write, under the same checks as `save`.
      onChange: (nextContent) => {
        if (token !== extensionSeamToken) return;
        if (window.rundockIsHiddenPath && window.rundockIsHiddenPath(path)) return;
        // A pending view state is written first, so the note's save cannot
        // replace it in the one debounce.
        if (fileSaves.pendingPath() && fileSaves.pendingPath() !== path) fileSaves.flush();
        fileSaves.schedule(path, () => saveFileGuarded(path, nextContent, { origin: 'extension' }), 500);
      },
      // `setState`: the host hands the state alone; the extension and the
      // note are this mount's, never anything the frame said.
      onState: (state) => {
        if (token !== extensionSeamToken) return;
        scheduleViewState(claim.extension, path, state);
      },
      // A web address the person clicked inside the view: out to the system
      // browser on desktop, where the window-open handler already sends it,
      // and a new tab in browser mode. Never into the pane.
      onOpenExternal: (url) => { window.open(url, '_blank', 'noopener,noreferrer'); },
      // A named source, written through the source save's own guard; the
      // host has already checked it is on the list and keeps the list's own
      // list. `changeSource` shares the editors' one debounce, flushing a
      // different file's pending save first so no edit is dropped.
      onSaveSource: (source, nextContent) => {
        if (token !== extensionSeamToken) return;
        saveSourceGuarded(path, source, nextContent);
      },
      onChangeSource: (source, nextContent) => {
        if (token !== extensionSeamToken) return;
        if (fileSaves.pendingPath() && fileSaves.pendingPath() !== source) fileSaves.flush();
        fileSaves.schedule(source, () => saveSourceGuarded(path, source, nextContent), 500);
      },
      // Ask an agent: the host has checked the click, one request per click and the
      // declared list; team membership and the new conversation are the
      // app's. Answers a reason, or nothing.
      onAsk: (agentId, message) => {
        if (token !== extensionSeamToken) return 'the view is no longer open';
        return typeof window.rundockAskFromView === 'function'
          ? window.rundockAskFromView({ agentId, message, extension: claim.extension, path })
          : 'asking an agent is not available here';
      },
      onDegrade: (reason) => {
        // A superseded mount that degrades tears down its own frame (the
        // host does that before calling onDegrade) but must not repaint the
        // surface: a newer open owns the pane now. It also nulls the shared
        // handle only when it still owns it, so a later closeOpenFile is
        // never handed a dead handle.
        if (token === extensionSeamToken) { activeExtensionMount = null; activeExtensionMountInfo = null; }
        if (superseded()) return;
        surface(viewers, path, content);
        noteRendererFailure(reason);
      },
    });
    // A host that refused to mount (over the cap, or a frame it could not
    // build) has already degraded and holds nothing to reconcile.
    if (activeExtensionMount && typeof activeExtensionMount.alive === 'function' && !activeExtensionMount.alive()) {
      activeExtensionMount = null;
      activeExtensionMountInfo = null;
    }
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
  fileSaves.cancel();
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

// ===== REGIONS: an extension draws a fenced block inside a document =====
//
// A pass over the rendered preview, not a change to the renderer. The
// markdown renderer has already escaped everything and produced a wrapper per
// fenced block; this finds the ones an extension claims, hides each block and
// puts a drawn region in its place. The document's bytes are never touched,
// so a note round-trips byte for byte whether or not anything is installed to
// draw its diagrams.

// One render service per extension, held for the life of the page, because
// the frame carries no document identity: switching between three notes that
// use one extension costs one frame load in total. The services belong to the
// page; the regions belong to the file.
const regionServices = new Map();
let placedRegions = [];

// Release every region this pass placed, so a region never outlives the
// document it was drawn into. Services stay: they are the expensive thing.
// ===== EMBEDS (shape A, provisional) =====
// A line of `![[file]]` embeds shows each file where it sits, rendered by
// whatever claims it, side by side. The rules (what a row is, three to a row,
// what a panel shows) are public/embed-model.js's; this only mounts. Each
// embedded view is its own mount on its own file, handed that file's text
// and nothing else, and mounted read-only. Reached by the editor's decoration
// through window.rundockMountEmbeds and by the preview pass below.
const embedMounts = new Set();

// The embedded file's text, and what the server said about handing it to an
// extension: null only on an explicit 'none', so a reply without the header
// is a refusal rather than permission.
function embedText(path) {
  return fetch('/api/file?path=' + encodeURIComponent(path))
    .then((r) => {
      if (!r.ok) return Promise.reject(new Error('unreadable'));
      const said = r.headers && typeof r.headers.get === 'function' ? r.headers.get('X-Rundock-Extension-Refusal') : null;
      const refusal = said === 'none' ? null : (said ? decodeURIComponent(said) : EXTENSION_UNCHECKED_REASON);
      return r.text().then((text) => ({ text, refusal }));
    });
}

function drawEmbedPlain(body, decision, path, text, name) {
  body.replaceChildren();
  if (decision.kind === 'markdown') {
    // Depth one: the embedded note is drawn by the ordinary renderer, which
    // shows its own embeds as links and mounts nothing.
    const doc = document.createElement('div');
    doc.className = 'formatted';
    doc.innerHTML = formatMdFull(text);
    body.appendChild(doc);
  } else if (decision.kind === 'text') {
    const pre = document.createElement('pre');
    pre.textContent = text;
    body.appendChild(pre);
  } else {
    const link = document.createElement('button');
    link.className = 'embed-link';
    link.textContent = `Open ${name}`;
    link.addEventListener('click', () => { if (path) openWorkspaceFilePath(path); });
    body.appendChild(link);
  }
  if (decision.note && decision.kind !== 'markdown' && decision.kind !== 'text') {
    const note = document.createElement('div');
    note.className = 'embed-note';
    note.textContent = decision.note;
    body.appendChild(note);
  }
}

function releaseEmbedMount(record) {
  embedMounts.delete(record);
  try { record.handle.teardown(); } catch (e) { /* going away anyway */ }
}

function embedPanel(embed, owner, mine) {
  const model = window.RundockEmbedModel;
  const panel = document.createElement('div');
  panel.className = 'embed-panel';
  const head = document.createElement('div');
  head.className = 'embed-head';
  const nameEl = document.createElement('span');
  nameEl.className = 'embed-name';
  const status = document.createElement('span');
  status.className = 'embed-status';
  const open = document.createElement('button');
  open.className = 'embed-open';
  open.textContent = 'Open';
  head.append(nameEl, status, open);
  const body = document.createElement('div');
  body.className = 'embed-body';
  body.style.height = `${embed.height}px`;
  panel.append(head, body);

  const path = cachedFileTree ? findFileInTree(cachedFileTree, model.searchName(embed.name), owner) : null;
  const hidden = !!(path && window.rundockIsHiddenPath && window.rundockIsHiddenPath(path));
  const name = path ? model.baseName(path) : embed.name;
  nameEl.textContent = name;
  open.addEventListener('click', () => { if (path) openWorkspaceFilePath(path); else openWikilink(embed.target); });
  const settle = (decision, text) => {
    status.textContent = decision.note && (decision.kind === 'extension' || decision.kind === 'markdown' || decision.kind === 'text') ? decision.note : '';
    if (decision.kind !== 'markdown' && decision.kind !== 'text' && decision.kind !== 'extension') body.style.height = '';
    drawEmbedPlain(body, decision, path, text || '', name);
  };
  const registry = window.rundockRendererRegistry;
  const early = model.panelFor({ path, owner, hidden, claimed: false });
  if (!path || path === owner || hidden) { settle(early); return panel; }
  if (model.isBinaryPath(path) && !(registry && registry.rendererFor && registry.rendererFor(path, '').registered)) { settle(early); return panel; }
  embedText(path).then(({ text, refusal }) => {
    const claim = registry && registry.rendererFor ? registry.rendererFor(path, text) : null;
    const decision = model.panelFor({ path, owner, hidden, claimed: !!(claim && claim.registered) });
    if (decision.kind !== 'extension') { settle(decision, text); return; }
    // A linked or hard-linked file is drawn plain, with the rule named, and
    // never handed to the extension that claims it.
    if (refusal) {
      settle(model.panelFor({ path, owner, hidden, claimed: false }), text);
      status.textContent = refusal;
      return;
    }
    status.textContent = decision.note;
    Promise.all([loadExtensionHost(), fetchExtensionUi(claim.extension, claim.renderer), fetchViewState(claim.extension, path)]).then(([host, payload, viewState]) => {
      if (!mine.alive) return;
      if (!payload || typeof payload.entry !== 'string') {
        settle(model.panelFor({ path, owner, hidden, claimed: false }), text);
        status.textContent = payload && payload.reason ? payload.reason : 'could not be drawn';
        return;
      }
      body.replaceChildren();
      const record = { extension: claim.extension, path, text, body, handle: null };
      record.handle = host.mountExtension({
        paneElement: body, payload: { ...payload, writes: false }, path, content: text, embedded: true, state: viewState,
        onDegrade: (reason) => {
          embedMounts.delete(record);
          settle(model.panelFor({ path, owner, hidden, claimed: false }), text);
          status.textContent = reason;
        },
      });
      embedMounts.add(record);
      mine.records.push(record);
    }, () => settle(model.panelFor({ path, owner, hidden, claimed: false }), text));
  }, () => {
    status.textContent = 'could not be read';
    settle({ kind: 'link', note: 'This file could not be read.' });
  });
  return panel;
}

// Fill `holder` with the rows for `embeds`, releasing whatever it held.
function mountEmbeds(holder, embeds, owner) {
  if (typeof holder.rundockRelease === 'function') holder.rundockRelease();
  const model = window.RundockEmbedModel;
  holder.replaceChildren();
  const mine = { alive: true, records: [] };
  holder.rundockRelease = () => {
    mine.alive = false;
    for (const record of mine.records) releaseEmbedMount(record);
    mine.records = [];
  };
  if (!model || !Array.isArray(embeds)) return;
  for (const row of model.rows(embeds)) {
    const rowEl = document.createElement('div');
    rowEl.className = 'embed-row';
    rowEl.style.setProperty('--embed-count', String(row.length));
    for (const embed of row) rowEl.appendChild(embedPanel(embed, owner, mine));
    holder.appendChild(rowEl);
  }
}
if (typeof window !== 'undefined') window.rundockMountEmbeds = mountEmbeds;

// A roster arrived: an embedded view whose extension is no longer installed
// and enabled is ended, and its panel falls back to the file's own text.
function reconcileEmbedMounts(roster) {
  const live = new Set((Array.isArray(roster) ? roster : [])
    .filter((e) => e && e.enabled !== false && !e.broken).map((e) => e.id));
  const model = window.RundockEmbedModel;
  for (const record of [...embedMounts]) {
    if (live.has(record.extension)) continue;
    releaseEmbedMount(record);
    if (model) drawEmbedPlain(record.body, model.panelFor({ path: record.path, owner: null, hidden: false, claimed: false }), record.path, record.text, model.baseName(record.path));
  }
}

// The preview surface: the same rows, after the rendered paragraph they
// stand for. The rendered text is never changed; the row is placed after it.
function mountPreviewEmbeds(scope) {
  const model = window.RundockEmbedModel;
  if (!model || !scope) return;
  for (const p of scope.querySelectorAll('p')) {
    const pieces = [];
    let ok = true;
    for (const child of p.childNodes) {
      if (child.nodeType === 3) pieces.push({ text: child.textContent });
      else if (child.nodeType === 1 && child.matches('a.wikilink')) {
        const target = child.getAttribute('data-wikilink') || '';
        const label = child.textContent;
        pieces.push({ target, alias: label && label !== target ? label : null });
      } else { ok = false; break; }
    }
    const embeds = ok ? model.embedsIn(pieces) : null;
    if (!embeds) continue;
    const holder = document.createElement('div');
    holder.className = 'embed-holder';
    p.classList.add('embed-source-hidden');
    p.after(holder);
    mountEmbeds(holder, embeds, currentFilePath);
    placedRegions.push({ release: () => holder.rundockRelease() });
  }
}

function releaseRegions() {
  for (const placed of placedRegions) {
    try { placed.release(); } catch (e) { /* the document has moved on */ }
  }
  placedRegions = [];
}

// The palette changed, so every drawing made in the old one is wrong.
//
// A mounted view rebuilds its own frame on a theme flip; a region service
// cannot, because it has no idea a theme exists. So the page tells it: each
// service throws away what it drew and rebuilds, and the document redraws.
// Without this a diagram keeps the colours it had when it was drawn, and the
// drawing cache makes that permanent rather than merely until the next open.
let regionThemeObserver = null;
function watchThemeForRegions() {
  if (regionThemeObserver || typeof window.MutationObserver !== 'function' || !document.body) return;
  let shown = document.body.classList.contains('light') ? 'light' : 'dark';
  regionThemeObserver = new window.MutationObserver(() => {
    const now = document.body.classList.contains('light') ? 'light' : 'dark';
    if (now === shown) return;
    shown = now;
    for (const svc of regionServices.values()) {
      try { svc.retheme(); } catch (e) { /* it will be rebuilt on next use */ }
    }
    // And redraw what is on screen, because the regions now hold drawings
    // made in the palette that just stopped being true.
    const preview = document.getElementById('editor-content');
    if (preview && !preview.classList.contains('hidden')) mountRegions(preview);
  });
  regionThemeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

// A roster arrived: any running render service whose extension is no longer
// installed and enabled is stopped, so turning an extension off (or every
// extension, with the switch) ends its running code in this window too, not
// only its next mount.
function reconcileRegionServices(roster) {
  const live = new Set((Array.isArray(roster) ? roster : [])
    .filter((e) => e && e.enabled !== false && !e.broken).map((e) => e.id));
  for (const [id, svc] of [...regionServices.entries()]) {
    if (live.has(id)) continue;
    try { svc.stop(); } catch (e) { /* going away anyway */ }
    regionServices.delete(id);
  }
}

function stopRegionServices() {
  for (const svc of regionServices.values()) {
    try { svc.stop(); } catch (e) { /* going away anyway */ }
  }
  regionServices.clear();
}

/**
 * Start the render service for every extension that draws, before anything
 * asks it to.
 *
 * WHY THIS EXISTS. The counterpart bundles its diagram library into the app,
 * so it is warm before a person opens anything. Ours loads on demand, and for
 * mermaid that is 2.83 MB: without this, the first note with a diagram in it
 * waits for a library nothing had a reason to start fetching until that
 * moment, and every note after it is instant. That difference is the whole of
 * where an installed extension feels slower than a built-in one.
 *
 * WHEN THE BROWSER HAS NOTHING BETTER TO DO, AND NEVER BEFORE. This is the
 * part that matters, because the person this costs is the one it does not
 * help: somebody with the extension installed who is not looking at a
 * diagram today would otherwise pay 2.83 MB of fetch, parse and execute on
 * every workspace open, competing with the thing they actually opened
 * Rundock to do.
 *
 * So it runs in idle time. requestIdleCallback only fires when the main
 * thread has finished the work a person is waiting on, which means this
 * cannot slow a workspace open: at worst it does not happen, and the first
 * diagram then loads on demand exactly as it would have anyway. The timeout
 * is generous for the same reason: a busy machine should keep deferring this
 * rather than eventually forcing it through.
 *
 * A hidden tab warms nothing. Somebody who opened Rundock in a background
 * tab has not begun using it, and spending their battery on a library they
 * may never reach is the same mistake in a different place.
 *
 * Nothing is drawn and nothing is shown. A failure here is silent, because a
 * person who never opens a diagram should not be told about a frame they did
 * not ask for; they will be told the moment a region needs it and it is not
 * there.
 */
function warmRegionServices() {
  const idle = window.requestIdleCallback;
  // No idle callback, no warming. The fallback for a browser without it is
  // to do nothing at all rather than to reach for a timer, because a timer
  // is exactly the thing this is written to avoid: work that lands whether
  // the main thread is busy or not.
  if (typeof idle !== 'function') return;
  if (document.visibilityState === 'hidden') return;
  idle(() => { warmRegionServicesNow(); }, { timeout: 30000 });
}

async function warmRegionServicesNow() {
  const service = window.RundockRegionService;
  const registry = window.rundockRendererRegistry;
  if (!service || !registry || typeof registry.languages !== 'function') return;
  const languages = registry.languages();
  // Nothing installed that draws: the overwhelmingly common case, and it
  // costs one map read to find out.
  if (!languages.length) return;
  const doc = document;
  for (const language of languages) {
    const extensionId = registry.drawerFor(language);
    if (!extensionId || regionServices.has(extensionId)) continue;
    try {
      const payload = await fetchExtensionUi(extensionId, null);
      if (!payload || typeof payload.entry !== 'string') continue;
      const host = await loadExtensionHost();
      if (regionServices.has(extensionId)) continue; // a draw got there first
      regionServices.set(extensionId, service.startRegionService({
        doc,
        win: window,
        // Asked for at each build, so a re-theme rebuilds the frame with the
        // palette that is true now rather than the one it started in.
        srcdoc: () => host.buildRegionSrcdoc(payload, doc),
        onUnusable: (reason) => failRegionsOf(extensionId, reason, doc, window.RundockRegionMount, doc.body),
      }));
    } catch (e) {
      // Warming is an optimisation. A failure here costs a person nothing
      // they can see, and the same path runs again, loudly, when a region
      // actually needs this extension.
    }
  }
}

/**
 * Draw every claimed fenced block in a rendered preview.
 *
 * Deliberately not awaited by its caller: a document with diagrams shows its
 * prose at once and fills the regions in as they arrive. Every await is
 * followed by a token check, because a person who opens another file
 * mid-draw owns the pane now and a late answer must not repaint it.
 */
async function mountRegions(scope) {
  releaseRegions();
  const mount = window.RundockRegionMount;
  const markup = window.RundockRegionMarkup;
  const service = window.RundockRegionService;
  const registry = window.rundockRendererRegistry;
  if (!mount || !markup || !service || !registry || typeof registry.drawerFor !== 'function') return;

  const token = extensionSeamToken;
  // The document's own path rides along so a note in a hidden folder keeps
  // its fenced blocks as text: see isHiddenPath in the registry.
  const documentPath = currentFilePath;
  const blocks = mount.claimedBlocks(scope, (lang) => registry.drawerFor(lang, documentPath) !== null);
  if (!blocks.length) return;

  const doc = scope.ownerDocument;
  const placed = blocks.map((block) => ({ block, region: mount.placeRegion(block, doc) }));
  placedRegions = placed.map((p) => p.region);
  for (const p of placed) mount.drawWaiting(p.region, doc);

  for (const { block, region } of placed) {
    const extensionId = registry.drawerFor(block.language, documentPath);
    let svc = regionServices.get(extensionId);
    if (!svc) {
      const payload = await fetchExtensionUi(extensionId, null);
      if (token !== extensionSeamToken) return;
      if (!payload || typeof payload.entry !== 'string') {
        mount.drawFailure(region, mount.failureText(extensionId, payload && payload.reason), doc);
        continue;
      }
      const host = await loadExtensionHost();
      if (token !== extensionSeamToken) return;
      svc = service.startRegionService({
        doc,
        win: window,
        // Asked for at each build, so a re-theme rebuilds the frame with the
        // palette that is true now rather than the one it started in.
        srcdoc: () => host.buildRegionSrcdoc(payload, doc),
        onUnusable: (reason) => failRegionsOf(extensionId, reason, doc, mount, scope),
      });
      regionServices.set(extensionId, svc);
    }
    const answer = await svc.render(block.source);
    if (token !== extensionSeamToken) return;
    if (!answer.ok) {
      // A service failure is the extension, not this block. The reason is
      // dropped so failureText names the extension plainly; a drawer's own
      // parse message is kept, because it names the line.
      mount.drawFailure(region, mount.failureText(extensionId, answer.serviceFailed ? null : answer.reason), doc);
      continue;
    }
    const built = markup.buildRegionTree(answer.svg, doc);
    if (!built.node) { mount.drawFailure(region, mount.failureText(extensionId, built.reason), doc); continue; }
    // Links first, while the tree is still detached: a node the host built,
    // never returned markup, and resolved through the app's own opener so a
    // click inside a diagram goes exactly where a wikilink would.
    mount.attachInternalLinks(built.node, doc, (target) => openWikilink(target));
    mount.drawResult(region, built.node, doc);
    // Provenance, not permission: the quiet mark that answers "why does this
    // look different", shown on hover.
    mount.markProvenance(region, extensionId, doc);
    capIfTall(region, doc, mount);
  }
}

// A drawing taller than the reader is capped rather than left to push the
// next paragraph off the screen. Measured after it is in the document,
// because a diagram's height is whatever its content turned out to be, and
// compared against the viewport rather than a fixed number so the rule means
// the same thing on every screen.
function capIfTall(region, doc, mount) {
  const win = doc.defaultView || window;
  const limit = (win.innerHeight || 800) * 1.5;
  const drawn = region.region.querySelector('.region-drawn');
  if (!drawn || typeof drawn.getBoundingClientRect !== 'function') return;
  const height = drawn.getBoundingClientRect().height;
  if (!height || height <= limit) return;
  mount.capTallRegion(region, doc, (placed) => {
    // Uncapping is the whole of "view full size": the document scrolls
    // through it as it would through any tall thing, rather than trapping
    // the drawing in a second scroller nobody asked for.
    placed.region.classList.remove('region-capped');
    const button = placed.region.querySelector('.region-expand');
    if (button) button.remove();
  });
}

// Tier two of the failure model: one wedged frame is one extension's outage,
// not the document's. Every region that extension was drawing says so and
// offers the restart the session-long frame was approved on; regions drawn by
// anything else, and all the prose, are untouched.
function failRegionsOf(extensionId, reason, doc, mount, scope) {
  const registry = window.rundockRendererRegistry;
  for (const placed of placedRegions) {
    const language = placed.region && placed.region.getAttribute('data-region-language');
    if (!language || !registry || registry.drawerFor(language) !== extensionId) continue;
    // The whole extension is unusable, so the sentence names it rather than
    // repeating a transport's description of how it stopped responding.
    mount.drawFailure(placed, mount.failureText(extensionId, null), doc, () => {
      const svc = regionServices.get(extensionId);
      if (svc) svc.restart();
      mountRegions(scope);
    });
  }
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

// NAMED SOURCES, the page's half. The page asks for a note's sources with the
// note's path and nothing else; the server resolves the list from disk and
// watches it for this mount (lib/protocol/handlers/sources.js). Each request
// carries its own watch id, so an answer or a change for a mount that has
// since ended is ignored rather than handed to whatever is mounted now.
let sourcesWatchId = null;
let sourcesWaiter = null;
let sourcesSeq = 0;
// What each source's view was last handed, for the external-edit check on a
// source write, the same check the editors' save makes against the disk.
const sourceBaselines = new Map();
const SOURCES_TIMEOUT_MS = 8000;

function requestSources(path) {
  return new Promise((resolve) => {
    const watchId = `s${Date.now().toString(36)}${(sourcesSeq += 1)}`;
    sourcesWatchId = watchId;
    const timer = setTimeout(() => settle({ ok: false, reason: 'the sources did not arrive in time', sources: [] }), SOURCES_TIMEOUT_MS);
    function settle(reply) {
      clearTimeout(timer);
      if (sourcesWaiter && sourcesWaiter.watchId === watchId) sourcesWaiter = null;
      resolve({ ...reply, watchId });
    }
    sourcesWaiter = { watchId, settle };
    try { ws.send(JSON.stringify({ type: 'get_sources', path, watchId })); }
    catch (e) { settle({ ok: false, reason: 'the sources could not be requested', sources: [] }); }
  });
}

// VIEW STATE, the page's half (lib/protocol/handlers/view-state.js). The page
// names the extension that claimed the note and the note it mounted, never
// anything the frame sent. A read that does not arrive, or answers anything
// but an object, is no state: the view opens without it rather than not at
// all.
const VIEW_STATE_TIMEOUT_MS = 4000;
const viewStateWaiters = new Map();
let viewStateSeq = 0;

function requestViewState(extension, path) {
  return new Promise((resolve) => {
    const requestId = `v${Date.now().toString(36)}${(viewStateSeq += 1)}`;
    const timer = setTimeout(() => settle(null), VIEW_STATE_TIMEOUT_MS);
    function settle(state) {
      clearTimeout(timer);
      viewStateWaiters.delete(requestId);
      resolve(state && typeof state === 'object' && !Array.isArray(state) ? state : null);
    }
    viewStateWaiters.set(requestId, settle);
    try { ws.send(JSON.stringify({ type: 'get_view_state', extension, path, requestId })); }
    catch (e) { settle(null); }
  });
}
if (typeof window !== 'undefined') window.rundockViewStateFetcher = requestViewState;

function fetchViewState(extension, path) {
  const fetcher = window.rundockViewStateFetcher;
  if (typeof fetcher !== 'function') return Promise.resolve(null);
  return Promise.resolve(fetcher(extension, path)).catch(() => null);
}

// Written once the changes pause, through the one debounce the editors
// share, under its own key. A different pending save (the note's own) is
// written first, so neither drops the other; opening another file flushes
// it, so the last state is not lost.
function scheduleViewState(extension, path, state) {
  const key = `view-state:${extension}:${path}`;
  if (fileSaves.pendingPath() && fileSaves.pendingPath() !== key) fileSaves.flush();
  fileSaves.schedule(key, () => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'set_view_state', extension, path, state }));
  }, 500);
}

// The server's answers: a read settles its own request, and a refusal is
// passed to the live view only when it names that view's extension and note.
function viewStateReplyArrived(d) {
  if (!d) return;
  if (d.type === 'view_state') {
    const settle = viewStateWaiters.get(d.requestId);
    if (settle) settle(d.state);
    return;
  }
  const info = activeExtensionMountInfo;
  if (d.type === 'view_state_refused' && info && info.extension === d.extension && info.path === d.path
    && activeExtensionMount && typeof activeExtensionMount.refuseState === 'function') {
    activeExtensionMount.refuseState(d.reason);
  }
}

function noteSourceBaselines(list) {
  for (const s of Array.isArray(list) ? list : []) {
    if (s && typeof s.path === 'string' && typeof s.content === 'string') sourceBaselines.set(s.path, s.content);
  }
}

// A reply from the server's sources handler. Only the live mount's watch id
// is answered; everything else is a mount that has ended.
function sourcesReplyArrived(d) {
  if (!d || d.watchId !== sourcesWatchId) return;
  if (d.type === 'sources_resolved' && sourcesWaiter && sourcesWaiter.watchId === d.watchId) {
    sourcesWaiter.settle(d);
    return;
  }
  if (d.type === 'sources_changed' && activeExtensionMount && typeof activeExtensionMount.updateSources === 'function') {
    const list = d.ok ? d.sources : [];
    noteSourceBaselines(list);
    activeExtensionMount.updateSources(list);
  }
}

function endSourcesWatch() {
  if (!sourcesWatchId) return;
  const watchId = sourcesWatchId;
  sourcesWatchId = null;
  if (sourcesWaiter) { sourcesWaiter.settle({ ok: false, reason: 'the view closed', sources: [] }); sourcesWaiter = null; }
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'unwatch_sources', watchId })); } catch (e) { /* the connection's close ends it too */ }
}

// A source write from the view: through the same external-edit check the
// editors' save makes, then to the server, which resolves the note's list
// again before it writes.
async function saveSourceGuarded(notePath, source, content) {
  let disk = null;
  try {
    const res = await fetch('/api/file?path=' + encodeURIComponent(source));
    if (res.ok) disk = (await res.text()).replace(/\r\n?/g, '\n');
  } catch { /* offline check: the server still re-resolves at write time */ }
  const baseline = sourceBaselines.get(source);
  if (disk !== null && baseline !== undefined && disk !== baseline && disk !== content) {
    showExternalEditConflict(source, disk, content, {
      owner: notePath,
      // Theirs: the view is handed what is on disk.
      onTheirs: () => {
        sourceBaselines.set(source, disk);
        if (activeExtensionMount && typeof activeExtensionMount.updateSources === 'function') {
          requestSources(notePath).then((r) => { if (r.ok && r.watchId === sourcesWatchId) { noteSourceBaselines(r.sources); activeExtensionMount.updateSources(r.sources); } });
        }
      },
      // Mine: an explicit decision to write over it.
      onMine: () => { sourceBaselines.set(source, disk); saveSourceGuarded(notePath, source, content); },
    });
    return false;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'save_source', path: notePath, source, content }));
    sourceBaselines.set(source, content);
  }
  return true;
}

// WHAT THE SERVER SAID ABOUT HANDING EACH FILE TO AN EXTENSION, by path:
// null when it may be, the rule's words when it may not. Written from every
// read that carries the answer (file_content, file_changed) and read by every
// place that mounts or draws an extension over a file. A path the server has
// said nothing about is refused, never assumed safe: see extension-file.js on
// the server, which is the only place this is decided.
const extensionRefusals = new Map();
const EXTENSION_UNCHECKED_REASON = 'Rundock has not checked this file for extensions';
function noteExtensionRefusal(path, refusal) {
  extensionRefusals.set(path, refusal === undefined ? EXTENSION_UNCHECKED_REASON : refusal);
}
function extensionRefusalFor(path) {
  return extensionRefusals.has(path) ? extensionRefusals.get(path) : EXTENSION_UNCHECKED_REASON;
}
if (typeof window !== 'undefined') window.rundockExtensionRefusalFor = extensionRefusalFor;

let activeExtensionMount = null;
// The identity of the live mount: { extension, renderer, version, path }, or
// null. What reconcileExtensionMount compares a roster against.
let activeExtensionMountInfo = null;
// Monotonic per-open token: every seam entry claims the next value, and an
// async callback whose token is no longer current abandons its work.
let extensionSeamToken = 0;

// Release the live extension mount and invalidate any pending seam open. One
// definition, called before every file open and by closeOpenFile, so no
// frame or mediator listener outlives its file or its workspace.
function releaseExtensionMount() {
  extensionSeamToken += 1;
  endSourcesWatch();
  // Regions travel with the file the way a mount does: bumping the token
  // above already abandons any draw still in flight, and this takes down what
  // was drawn. The services are deliberately NOT stopped here, because they
  // belong to the page and are the whole reason a second document costs no
  // frame load.
  releaseRegions();
  if (activeExtensionMount) { activeExtensionMount.teardown(); activeExtensionMount = null; }
  activeExtensionMountInfo = null;
  // The pane gets its padding back with the view gone, whichever surface
  // opens next and whether or not that surface resets the class itself.
  const pane = typeof document !== 'undefined' && document.getElementById('editor-content');
  if (pane) pane.classList.remove('extension-pane');
}

// The live mount's identity, for whoever needs to know what is on screen
// before asking for it to change.
function mountedExtension() {
  return activeExtensionMountInfo;
}

// THE ONE ENTRY POINT THAT RECONCILES A ROSTER WITH THE LIVE MOUNT. Called
// from every roster arrival, and by the manage surface after an update,
// disable or uninstall, so an extension that changes while its view is on
// screen is answered in one place rather than by whichever caller
// remembered. A mounted extension the roster no longer names, or names
// disabled, is torn down and the plain surface drawn under a stated reason;
// one present with a different version is swapped with a freshly fetched
// payload; one whose version is unchanged is left alone. Returns what it
// decided, so a caller can say so.
function reconcileExtensionMount(roster) {
  const info = activeExtensionMountInfo;
  const mount = activeExtensionMount;
  if (!info || !mount) return { action: 'none' };
  const entry = (Array.isArray(roster) ? roster : []).find((e) => e && e.id === info.extension) || null;
  if (!entry || entry.enabled === false) {
    const reason = entry
      ? `the extension "${info.extension}" was disabled`
      : `the extension "${info.extension}" is no longer installed`;
    const path = currentFilePath;
    const content = rawFileContent;
    releaseExtensionMount();
    redrawPlainSurface(path, content, reason);
    return { action: 'torn-down', reason };
  }
  // The roster may have changed what the extension claims (an update with a
  // different marker), so the file is asked again before anything is kept.
  const standing = recheckExtensionClaim();
  if (standing.action === 'released' || standing.action === 'reclaimed') return standing;
  // The build when the roster names one: new code under an unchanged
  // version number, as a package update can bring, is still new code.
  const version = typeof entry.build === 'string' ? entry.build : typeof entry.version === 'string' ? entry.version : null;
  if (version === info.version) return { action: 'kept' };
  // An edit the view handed over and is still waiting to be saved lands
  // before the view is replaced, so a swap never drops it.
  if (fileSaves.pendingPath()) fileSaves.flush();
  // A fresh payload for the new version. The token and the handle are
  // captured so a file opened, or a mount released, while the fetch is in
  // flight wins: the late swap is abandoned rather than mounted over it.
  const token = extensionSeamToken;
  fetchExtensionUi(info.extension, info.renderer).then((payload) => {
    if (token !== extensionSeamToken || activeExtensionMount !== mount) return;
    if (!payload || typeof payload.entry !== 'string') {
      const reason = payload && payload.reason
        ? payload.reason : 'the updated renderer payload carried no entry to mount';
      const path = currentFilePath;
      const content = rawFileContent;
      releaseExtensionMount();
      redrawPlainSurface(path, content, reason);
      return;
    }
    // The swapped handle is adopted only when it lives: a re-mount that
    // fails synchronously has already degraded through the host's own
    // callback, which nulls the mount and draws the plain surface, and
    // recording a dead handle over that would claim a mount that is not
    // there.
    const swapped = mount.swap(payload);
    if (!swapped || typeof swapped.alive !== 'function' || !swapped.alive()) {
      activeExtensionMount = null;
      activeExtensionMountInfo = null;
      return;
    }
    activeExtensionMount = swapped;
    activeExtensionMountInfo = { ...info, version };
  }).catch((e) => {
    if (token !== extensionSeamToken || activeExtensionMount !== mount) return;
    const path = currentFilePath;
    const content = rawFileContent;
    releaseExtensionMount();
    redrawPlainSurface(path, content, String(e && e.message || e));
  });
  return { action: 'swapping', from: info.version, to: version };
}

// THE FILE DECIDES, FOR AS LONG AS IT IS OPEN. A marker claim is the file's
// own content speaking, so a mount stands only while the open file's current
// text still names the extension that is mounted: asked again when a write to
// the open file lands (the server's file_saved, in app.js: under a mount the
// writer is the view itself, the one change to the open file's text that
// does not reopen it) and on every roster (reconcileExtensionMount). A change
// on disk from anywhere else reopens the file, which asks the seam afresh. A file that
// no longer claims the extension stands the mount down onto the plain
// surface with the reason named; one now claimed by a different extension is
// opened afresh through the seam, which mounts that one.
function recheckExtensionClaim() {
  const info = activeExtensionMountInfo;
  if (!info || !activeExtensionMount || info.path !== currentFilePath) return { action: 'none' };
  const registry = typeof window !== 'undefined' ? window.rundockRendererRegistry : null;
  if (!registry || typeof registry.rendererFor !== 'function') return { action: 'kept' };
  const path = currentFilePath;
  const content = rawFileContent;
  const claim = registry.rendererFor(path, content);
  if (claim && claim.registered && claim.extension === info.extension && claim.renderer === info.renderer) {
    return { action: 'kept' };
  }
  releaseExtensionMount();
  if (claim && claim.registered) {
    loadViewersModule().then((viewers) => {
      if (currentFilePath !== path) return;
      const surface = plainSurfaceFor(viewers, path, content);
      if (surface === null) openBoardFile(path, content);
      else openThroughRendererSeam(viewers, path, content, surface);
    });
    return { action: 'reclaimed', by: claim.extension };
  }
  const reason = `this file no longer claims the extension "${info.extension}": ${claim && claim.reason ? claim.reason : 'no renderer claims it'}`;
  redrawPlainSurface(path, content, reason);
  return { action: 'released', reason };
}

// The plain surface for the open file, drawn after a mount stood down for a
// reason that was not the file's: the same surface the seam would have
// chosen had nothing claimed the file, with the reason noted beside it.
function redrawPlainSurface(path, content, reason) {
  if (typeof path !== 'string' || !path) return;
  loadViewersModule().then((viewers) => {
    if (currentFilePath !== path) return;
    const surface = plainSurfaceFor(viewers, path, content);
    if (surface === null) openBoardFile(path, content);
    else surface(viewers, path, content);
    noteRendererFailure(reason);
  });
}

// THE PLAIN SURFACE FOR A FILE, decided in one place for the first open and
// for every redraw after a mount stood down: null means the file is a board
// (a markdown file whose frontmatter carries the kanban-plugin key; the
// detection is content-based, so it cannot ride the path-keyed classify
// table), and everything else dispatches by file kind.
function plainSurfaceFor(viewers, path, content) {
  if (viewers.classify(path) === 'markdown' && window.Kanban && window.Kanban.isBoardFile(content)) return null;
  return FILE_SURFACES[viewers.classify(path)] || openBinaryOrUnsupportedFile;
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
// Flush the pending save immediately. Called before opening any file so the
// last edit is never dropped when switching away inside the debounce window
// (the pending save carries its own path, so it writes the right file).
function flushBoardSave() {
  fileSaves.flush();
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
    // The board announces a change through the mount contract's onChange;
    // the save itself is the shared debounce's, like every other editor's.
    let viewer = null;
    viewer = activeFileViewer = mod.mountBoardView({
      paneElement: pane, path, content,
      onWikilink: (target) => openWikilink(target),
      onChange: () => {
        if (!viewer || typeof viewer.getContentForSave !== 'function') return; // save refused (droppable content)
        const status = document.getElementById('editor-status');
        if (status) { status.textContent = 'Unsaved'; status.style.color = 'var(--attention)'; }
        editorDirty = true;
        fileSaves.schedule(path, RundockSaveScheduler.viewerSaveTask(viewer.getContentForSave, saveFileGuarded, path), 500);
      },
    }, window.Kanban);
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
  // The connections list rides this surface because this is the surface a
  // linked document is read on: markdown is the one file kind that carries
  // wikilinks. Mounted on the pane, beside the editor element rather than
  // inside it, because the editor owns its own element's children and clears
  // them on init.
  //
  // Mounted BEFORE the editor is initialised, not after: initTiptapEditor is
  // async and its first await hands control straight back here, so this is
  // the earliest point the connections fetch can start. Starting it before
  // the (heavier, synchronous-until-its-own-await) editor init gives the
  // request the most possible time to resolve on the network while the
  // editor does its own work, instead of queueing behind it.
  renderFileConnections(document.getElementById('tiptap-editor-pane'));
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
    // Fetch first, format second: formatMdFull is synchronous markdown-to-
    // HTML work that can take real time on a large file, and it used to run
    // in front of the connections fetch rather than beside it, so the
    // network round trip only started once the formatting was already done.
    // renderFileConnections only reads previewEl.parentElement as a mount
    // point; it does not need previewEl's content, so nothing here depends
    // on the order.
    renderFileConnections(previewEl.parentElement, { inset: true });
    previewEl.innerHTML = formatMdFull(fileBody);
    mountRegions(previewEl);
    mountPreviewEmbeds(previewEl);
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

// The kinds the link index actually reads links out of, kept in step with
// INDEXED_EXTENSIONS in search.js by a test: a kind missing here hides a
// group that should show, and a kind wrongly here shows an empty group that
// can never fill.
const LINK_SOURCE_EXTENSIONS = new Set(['.md', '.txt', '.html', '.htm', '.svg']);
function extensionOf(p) {
  const base = String(p || '').split('/').pop();
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot).toLowerCase();
}

// `inset` is set by the callers that mount OUTSIDE a padded element. The
// section is appended as a sibling of the preview pane rather than inside it,
// because the viewer owns that pane and clears it on teardown, and the parent
// carries no padding of its own, so without this the list sat flush against
// the sidebar for every non-markdown file. The markdown pane pads its own
// children, so it must not be inset again or the list indents twice.
function renderFileConnections(host, opts) {
  if (!host) return;
  removeFileConnections();
  if (!currentFilePath) return;
  const section = document.createElement('div');
  section.id = 'file-connections';
  section.className = (opts && opts.inset) ? 'file-connections file-connections-inset' : 'file-connections';
  host.appendChild(section);
  // Drawn the instant the section mounts, before the fetch below has even
  // started: see drawFileConnectionsLoading for why this is the fix for the
  // page moving under the reader, not just a cosmetic nicety.
  drawFileConnectionsLoading(section);
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

// A SETTLED PLACEHOLDER, drawn synchronously the moment the section mounts.
// The section used to mount with no content at all and wait for its bytes:
// on a content-heavy workspace the fetch and its resolution took long enough
// to be visible, so a heading-less, near-zero-height div sat at the bottom of
// the pane for a few seconds and then, all at once, became a heading plus a
// tree of groups and rows. Nothing moved on the way in; a whole block simply
// replaced empty space wherever the reader's eye already was.
//
// Drawing the heading and a settled loading line up front means the block's
// TOP EDGE is fixed from the instant the file opens. Only the space below the
// heading changes once the real rows are known, and it grows from a line
// that was already sitting there rather than appearing from nothing.
function drawFileConnectionsLoading(section) {
  while (section.firstChild) section.removeChild(section.firstChild);
  const heading = document.createElement('div');
  heading.className = 'file-connections-heading';
  heading.textContent = 'Connections';
  section.appendChild(heading);
  const loading = document.createElement('div');
  loading.className = 'file-connections-empty';
  loading.textContent = 'Loading connections…';
  section.appendChild(loading);
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
    // No full stop: this sits in the row position, where every other item is a
    // bare path, and it is the app's only empty state that punctuates itself
    // (compare "No matches", "No team agents yet"). The heading above it
    // carries no colon for the same reason no heading in the product does:
    // a colon promises the value follows on that line, and here the rows are
    // separate elements beneath it.
    //
    // WHILE THE INDEX IS WARMING, an empty group is not a fact about the file:
    // the table is still filling, and None here would be a false answer that
    // the ready redraw then silently corrects. Say what is true instead.
    if (!rows.length) { note(data.warming ? 'Links are still being indexed' : 'None'); return; }
    for (const row of rows) {
      const target = pathOf(row);
      const a = document.createElement('a');
      a.className = 'file-connections-row';
      a.textContent = target;
      a.addEventListener('click', () => openWorkspaceFilePath(target));
      section.appendChild(a);
    }
  };
  // "Links to" is omitted for a file whose kind is never read for links, and
  // omitted rather than shown empty because the two say different things. A
  // JSON file has no outgoing links and never can, so "None" there implies a
  // state that could one day change and cannot: it is not an empty list, it is
  // a question that does not apply. "Linked from" always applies, because any
  // indexed file can point at anything.
  if (LINK_SOURCE_EXTENSIONS.has(extensionOf(filePath))) group('Links to', outgoing, (r) => r.resolved);
  group('Linked from', incoming, (r) => r.src);
}

// The index reporting ready is news for the open file's connections: they
// were drawn against a table that was still filling, and the section under
// the file said so. Redraw from a fresh fetch, through the same render the
// open path uses, and only when there is a file with a section to redraw.
function fileConnectionsIndexReady() {
  if (!currentFilePath) return;
  const section = document.getElementById('file-connections');
  if (!section) return;
  renderFileConnections(section.parentElement, { inset: section.classList.contains('file-connections-inset') });
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
  enteredFromFiles();

  // Push current file onto history so back button returns to it
  if (currentFilePath) fileHistory.push(currentFilePath);
  if (fileHistory.length > 20) fileHistory.shift();

  // Search the cached file tree data (not the DOM). currentFilePath is still
  // the file the link was clicked in: proximity resolves a bare target
  // against ITS folder, not whatever folder happens to sort first.
  if (cachedFileTree) {
    const match = findFileInTree(cachedFileTree, searchName, currentFilePath);
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
  enteredFromFiles();
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
//   1. Exact path match (case-insensitive), and ONLY when the search string
//      itself names a folder (it contains a '/'). A bare name with no folder
//      in it is never "a path"; it is a basename, and a basename cannot
//      disambiguate itself just because it happens to equal some file's whole
//      path. Without this qualifier, a root-level file's path IS its bare
//      name (the root has no prefix to put in front of it), so [[README]]
//      would "exactly" match the root's README.md before proximity or any
//      other tie-break ever ran, which is the shape the reported bug actually
//      took: a bare link short-circuited straight to root, tie-break rules
//      notwithstanding.
//   2. Basename match, tied by PROXIMITY TO fromPath first, then SHORTEST
//      PATH, then TREE ORDER. `fromPath` is the file the link was read from
//      (optional; every caller that knows its source passes it). A bare
//      [[README]] almost never means the workspace root's README, it means
//      the README nearest the note that wrote the link, so the candidate
//      sharing the most leading folders with fromPath wins first. Depth and
//      tree order are what decide for a caller that passes no fromPath, or
//      for a genuine tie once proximity is exhausted, which is the one
//      deterministic answer the previous behavior gave that was worth
//      keeping.
//
// The old third rule (basename with the first '.md' occurrence stripped and
// re-appended) is gone: for every ordinary name it was identical to rule 2,
// and for a name carrying '.md' mid-string it could match a file the link
// never named. Nothing may match under a rule a reader cannot predict.
function findFileInTree(items, searchName, fromPath) {
  const searchLower = String(searchName).toLowerCase();
  const searchBase = searchLower.split('/').pop();
  const searchIsQualified = searchLower.includes('/');
  const fromSegments = fromPath ? dirSegments(fromPath) : null;
  let best = null;
  let order = 0;
  (function walk(list) {
    for (const item of list) {
      if (item.type === 'file') {
        const at = order++;
        if (searchIsQualified && item.path.toLowerCase() === searchLower) {
          if (!best || !best.exact) best = { path: item.path, exact: true };
        } else if (!(best && best.exact) && item.name.toLowerCase() === searchBase) {
          const depth = item.path.split('/').length;
          const shared = fromSegments ? commonPrefixLen(fromSegments, dirSegments(item.path)) : 0;
          if (!best || shared > best.shared ||
              (shared === best.shared && (depth < best.depth || (depth === best.depth && at < best.at)))) {
            best = { path: item.path, exact: false, depth, at, shared };
          }
        }
      } else if (item.type === 'folder' && item.children) {
        walk(item.children);
      }
    }
  })(items);
  return best ? best.path : null;
}

// A path's folder, as lowercase segments with the filename dropped. A
// root-level file (no '/') has none. Lowercased to match the
// case-insensitive comparisons everywhere else in this resolver.
function dirSegments(p) {
  const parts = String(p).split('/');
  parts.pop();
  return parts.map((s) => s.toLowerCase());
}

// How many leading folders two segment lists share, stopping at the first
// difference. This is the proximity score: fromPath and a candidate in the
// very same folder share every segment; a candidate one folder further out
// shares one fewer; a candidate in an unrelated part of the tree shares none,
// however shallow it is.
function commonPrefixLen(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
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
    // The server (lib/http-router.js, the /api/graph handler) resolves every
    // link in the workspace once, memoised per tree generation, and hands
    // the answer back on the row as `resolved`. This used to be ignored and
    // recomputed here via findFileInTree for every link in the WHOLE
    // workspace on every single file open, not just the current file's own
    // links: an O(all links x tree size) walk on the main thread, repeated
    // on every open, which is exactly the kind of stall a large, densely
    // linked vault feels as the connections list sitting blank for seconds.
    // Prefer the given answer; only resolve locally when a caller hands raw,
    // unresolved links (the unit test below, and any future caller that
    // isn't the /api/graph payload).
    //
    // The local fallback passes link.src for the same reason the server
    // does: a bare target resolves against the folder the link was written
    // in rather than the shallowest match in the tree, so the two roads
    // reach the same file rather than disagreeing about which README was
    // meant.
    const resolved = Object.prototype.hasOwnProperty.call(link, 'resolved')
      ? link.resolved
      : findFileInTree(tree || [], wikilinkSearchName(link.target), link.src);
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
  enteredFromFiles();
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
  openCreateMenu, openRowContextMenu, loadFileContent, noteExtensionRefusal, sourcesReplyArrived, viewStateReplyArrived, flushBoardSave, reconcileRegionServices,
  mountEmbeds, reconcileEmbedMounts, mountPreviewEmbeds,
  openBoardFile, openMarkdownFile, openLegacyTextFile,
  openBinaryOrUnsupportedFile, renderEditorContent, setEditorMode,
  getFileContentForSave, openWikilink, openWorkspaceFilePath,
  highlightFileInSidebar, findFileInTree, wikilinkSearchName, fileConnections,
  renderFileConnections, drawFileConnections, drawFileConnectionsLoading, removeFileConnections,
  fileConnectionsIndexReady,
  updateEditorBackButton,
  openSkillFile, editorGoBack,
  mountedExtension, reconcileExtensionMount, recheckExtensionClaim,
};
}));
