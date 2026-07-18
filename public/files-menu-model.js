'use strict';
// Files-sidebar creation menu model: the creatable file-shaped types (the
// "registry" of what the "+" menu and row context menu can make) and the pure
// path/label helpers. Same UMD pattern as the other client modules; the DOM
// menu code in app.js consumes this. Pinned by test/unit/files-menu-model.test.js.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FilesMenuModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Lucide-style icon inner-SVG per menu action (24 viewBox, 1.8 stroke).
  const ICONS = {
    note: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 12h4"/><path d="M10 16h4"/>',
    board: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M8 7v7"/><path d="M12 7v4"/><path d="M16 7v9"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M12 10v6"/><path d="M9 13h6"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    reveal: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  };

  // The creatable types. Adding a row here is the only change needed to offer a
  // new creatable type in both the header menu and the row context menu.
  const CREATABLE_TYPES = [
    { label: 'New note',  kind: 'note',   ext: '.md', icon: ICONS.note },
    { label: 'New board', kind: 'board',  ext: '.md', icon: ICONS.board },
    { label: 'New folder', kind: 'folder', ext: '',   icon: ICONS.folder },
  ];

  // Build the workspace-relative path for a new item, sanitising the name
  // (path separators are collapsed so creation can never escape the folder)
  // and joining it under the folder. Returns '' for an empty name.
  function creatablePath(folder, name, ext) {
    const clean = String(name == null ? '' : name).trim().replace(/[\\/]+/g, '-');
    if (!clean) return '';
    const dir = String(folder || '').replace(/^\/+|\/+$/g, '');
    return (dir ? dir + '/' : '') + clean + (ext || '');
  }

  // The parent folder of a row: the folder itself for a folder target, or the
  // file's containing folder for a file target ('' at workspace root).
  function parentFolder(targetPath, isFolder) {
    if (isFolder) return String(targetPath || '');
    return String(targetPath || '').split('/').slice(0, -1).join('/');
  }

  // The Obsidian-style wikilink for a path: its basename without a .md suffix.
  function wikilinkFor(targetPath) {
    const base = String(targetPath || '').split('/').pop().replace(/\.md$/i, '');
    return '[[' + base + ']]';
  }

  return { ICONS, CREATABLE_TYPES, creatablePath, parentFolder, wikilinkFor };
});
