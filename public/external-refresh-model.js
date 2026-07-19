// Decision model for live external refresh: when the file open in Rundock
// changes on disk (Obsidian, an agent, another tool), decide what to do.
//
//   'noop'     disk already matches what we have (typically our own save,
//              echoed back by the watcher) so there is nothing to do
//   'reload'   no unsaved local edits, so refresh the view seamlessly
//   'conflict' unsaved local edits differ from the new disk content, so the
//              user must choose (reload theirs / keep mine)
//
// `current` is the live editor content, or null for a read-only surface
// (image, PDF, rendered preview) that can always take the newer bytes.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.ExternalRefresh = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function externalChangeAction({ current, baseline, disk }) {
    if (disk === current) return 'noop';
    if (current == null) return 'reload';
    if (current === baseline) return 'reload';
    return 'conflict';
  }
  return { externalChangeAction };
});
