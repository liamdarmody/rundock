'use strict';
// WS handlers: named sources for the extension view mounted on a note.
//
// The page names the note and nothing else. `get_sources` resolves the note's
// list from disk and starts a watch that belongs to the mount: every interval
// the whole list is resolved again, and when anything about it changed (a
// listed file's text, the note's own list, a file deleted or swapped for a
// link) the new list is pushed. One watch per connection, beside and separate
// from the open-file watch, which it never replaces. It ends when the page
// says the mount ended, when the next mount starts one, when the workspace
// changes, and when the connection closes; nothing is sent after.
//
// `save_source` writes one listed source, resolved again at write time (see
// lib/workspace/named-sources.js).

const { getWorkspace } = require('../../config.js');
const { resolveSources, saveSource } = require('../../workspace/named-sources.js');
const { readable } = require('../../../public/readable-error.js');

// The watch interval, the open-file watch's own. Exposed so a test can drive
// it faster than a person would notice.
const timing = { pollMs: 700 };

function send(ws, message) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
}

function closeSourcesWatch(ws) {
  if (ws && ws._sourcesWatch) {
    clearInterval(ws._sourcesWatch.timer);
    ws._sourcesWatch = null;
  }
}

// The one answer shape, built field by field: the note's path as the page
// named it, the page's own watch id, and the resolver's list.
function answer(type, path, watchId, resolved) {
  return {
    type, path, watchId,
    ok: resolved.ok === true,
    ...(resolved.ok ? {} : { reason: resolved.reason }),
    sources: resolved.sources,
  };
}

function handleGetSources(ctx, ws, msg) {
  closeSourcesWatch(ws);
  const workspace = getWorkspace();
  // The note's path and the page's own id for this mount: nothing else the
  // page sends is read, so it cannot hand the resolver a list or a name.
  const notePath = msg && typeof msg.path === 'string' ? msg.path : '';
  const watchId = msg && typeof msg.watchId === 'string' ? msg.watchId.slice(0, 64) : '';
  if (!workspace) {
    send(ws, answer('sources_resolved', notePath, watchId, { ok: false, reason: 'no workspace is open', sources: [] }));
    return;
  }
  const first = resolveSources(workspace, notePath);
  send(ws, answer('sources_resolved', notePath, watchId, first));
  let last = JSON.stringify(first);
  const watch = { watchId, workspace, timer: null };
  watch.timer = setInterval(() => {
    // A closed connection or a switched workspace ends the watch: a list
    // resolved against another workspace is never sent to this mount.
    if (ws.readyState !== 1 || getWorkspace() !== workspace || ws._sourcesWatch !== watch) {
      clearInterval(watch.timer);
      if (ws._sourcesWatch === watch) ws._sourcesWatch = null;
      return;
    }
    let next;
    try { next = resolveSources(workspace, notePath); } catch (e) { return; } // mid-write: next tick
    const text = JSON.stringify(next);
    if (text === last) return;
    last = text;
    send(ws, answer('sources_changed', notePath, watchId, next));
  }, timing.pollMs);
  if (watch.timer.unref) watch.timer.unref();
  ws._sourcesWatch = watch;
}

function handleUnwatchSources(ctx, ws, msg) {
  const watchId = msg && typeof msg.watchId === 'string' ? msg.watchId : '';
  if (ws._sourcesWatch && (!watchId || ws._sourcesWatch.watchId === watchId)) closeSourcesWatch(ws);
}

function handleSaveSource(ctx, ws, msg) {
  const workspace = getWorkspace();
  const notePath = msg && typeof msg.path === 'string' ? msg.path : '';
  const source = msg && typeof msg.source === 'string' ? msg.source : '';
  if (!workspace) {
    send(ws, { type: 'source_save_refused', path: notePath, source, reason: 'no workspace is open' });
    return;
  }
  let refusal;
  try {
    refusal = saveSource(workspace, notePath, source, msg && msg.content);
  } catch (e) {
    // The system refused the write itself: said plainly, raw words as detail.
    const r = readable(e, { action: 'save this file' });
    send(ws, { type: 'source_save_refused', path: notePath, source, reason: r.message, detail: r.detail });
    return;
  }
  if (refusal) {
    send(ws, { type: 'source_save_refused', path: notePath, source, reason: refusal });
    return;
  }
  // The same freshness the editor's save keeps: file lists and the index.
  if (ctx && ctx.workspace) {
    ctx.workspace.invalidateFileListCache(); ctx.workspace.invalidateFileTreeCache();
  }
  const engine = ctx && ctx.store && ctx.store.ensureSearchEngine();
  if (engine) { try { engine.noteFileSaved(workspace, source); } catch (e) { /* reconcile catches up */ } }
  send(ws, { type: 'source_saved', path: notePath, source });
}

module.exports = { handleGetSources, handleUnwatchSources, handleSaveSource, closeSourcesWatch, timing };
