'use strict';
// One debounced save for whatever is open, owned by the caller.
//
// THE DEBOUNCE LIVES HERE, NOT IN THE VIEWER. The text editor, the rich
// editor and the board each kept a timer of their own, and every writable
// viewer after them would have written a fourth. A viewer's whole part in
// saving is to announce that it changed (its mount's `onChange`) and to hand
// back its bytes when asked (`getContentForSave`); when the write happens,
// how long to wait, and what happens on a switch or Cmd+S are decided once,
// here, for all of them.
//
// One pending save at a time, carrying the path it was scheduled for, so a
// flush after the person has moved on still writes the file the edit was
// made in. A task that returns null or undefined wrote nothing on purpose
// (a board holding content its grammar would drop refuses to save).
//
// UMD so it loads as a browser global (RundockSaveScheduler) and is
// requireable in node tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockSaveScheduler = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  function create(opts) {
    const setTimer = (opts && opts.setTimer) || ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = (opts && opts.clearTimer) || ((t) => clearTimeout(t));
    let timer = null;
    let pending = null; // { path, task }

    function run() {
      if (timer !== null) { clearTimer(timer); timer = null; }
      const p = pending;
      pending = null;
      if (p) p.task();
    }

    return {
      // Wait `delayMs` from the latest change, then run `task`. A second
      // change before then replaces the first: only the latest bytes matter.
      schedule(path, task, delayMs) {
        if (typeof task !== 'function') return;
        if (timer !== null) clearTimer(timer);
        pending = { path, task };
        timer = setTimer(run, typeof delayMs === 'number' ? delayMs : 1500);
      },
      // Write now: Cmd+S, or leaving a file, where waiting would lose the edit.
      flush: run,
      // Drop what is waiting without writing it.
      cancel() {
        if (timer !== null) { clearTimer(timer); timer = null; }
        pending = null;
      },
      pendingPath() { return pending ? pending.path : null; },
    };
  }

  // What every writable view's `onChange` does: mark the file unsaved and
  // schedule the save of whatever the view hands back when the wait is over.
  function viewerSaveTask(getContentForSave, save, path) {
    return () => {
      const content = getContentForSave();
      if (content == null) return;
      save(path, content);
    };
  }

  return { create, viewerSaveTask };
}));
