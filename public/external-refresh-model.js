// Decision model for live external refresh: when the file open in Rundock
// changes on disk (Obsidian, an agent, another tool), decide what to do.
//
//   'noop'     disk already matches what we last knew/wrote (typically our own
//              save echoed back by the watcher), so there is nothing to do
//   'reload'   no unsaved local edits, so refresh the view seamlessly
//   'conflict' there ARE unsaved local edits and disk moved, so the user must
//              choose (reload theirs / keep mine)
//
// The clean/dirty call is made from an explicit `dirty` flag (did the user
// edit since load/save?), NOT by comparing re-serialized editor content: the
// rich editor's markdown serializer is not byte-idempotent, so a comparison
// would misread a clean file as dirty and false-conflict, and would misread a
// read-only viewer too. `baseline` is what we last loaded or wrote.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.ExternalRefresh = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function externalChangeAction({ disk, baseline, dirty }) {
    if (disk === baseline) return 'noop';
    if (!dirty) return 'reload';
    return 'conflict';
  }
  return { externalChangeAction };
});
