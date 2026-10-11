'use strict';
// What the new-workspace form says when the server will not create a name as
// typed. Two states, both on the form itself:
//
//   - The name is taken. Nothing failed and nothing changed on disk, so this
//     is the attention notice under the form, not the red error slot, with an
//     "Open it" button for the folder the server found.
//   - Characters were removed. Nothing was made yet: the field takes the
//     cleaned name, and the hint and the field turn to the attention colour
//     until Create is pressed again.
//
// Kept out of app.js so it can be driven under jsdom against the shipped
// markup. Every function takes the document it acts on.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockCreateNotice = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT_HINT = 'Creates ~/Documents/Rundock/<name>';

  function parts(doc) {
    return {
      input: doc.getElementById('create-workspace-name'),
      hint: doc.getElementById('create-workspace-hint'),
      notice: doc.getElementById('workspace-name-notice'),
      noticeText: doc.getElementById('workspace-name-notice-text'),
      openExisting: doc.getElementById('workspace-open-existing'),
    };
  }

  /** Back to the plain form: default hint, no notice, no "Open it". */
  function clear(doc) {
    const p = parts(doc);
    if (p.hint) { p.hint.textContent = DEFAULT_HINT; p.hint.classList.remove('is-notice'); }
    if (p.input) p.input.classList.remove('is-notice');
    if (p.notice) p.notice.style.display = 'none';
    if (p.noticeText) p.noticeText.textContent = '';
    if (p.openExisting) { p.openExisting.style.display = 'none'; p.openExisting.dataset.wsPath = ''; }
  }

  /** The server's workspace_name_taken reply. */
  function showNameTaken(doc, d) {
    clear(doc);
    const p = parts(doc);
    if (p.noticeText) p.noticeText.textContent = d.message || '';
    if (p.notice) p.notice.style.display = 'block';
    if (p.openExisting && d.openPath) {
      p.openExisting.dataset.wsPath = d.openPath;
      p.openExisting.style.display = 'block';
    }
  }

  /** The server's workspace_name_notice reply. */
  function showNameNotice(doc, d) {
    clear(doc);
    const p = parts(doc);
    if (p.input) {
      p.input.value = d.name || '';
      // Removed and re-added across a layout read, so the settle glow plays
      // again on a second notice rather than only the first.
      void p.input.offsetWidth;
      p.input.classList.add('is-notice');
    }
    if (p.hint) { p.hint.textContent = d.message || ''; p.hint.classList.add('is-notice'); }
  }

  /** The folder "Open it" opens, or null when it is not on offer. */
  function openPath(doc) {
    const b = parts(doc).openExisting;
    return (b && b.style.display !== 'none' && b.dataset.wsPath) || null;
  }

  return { DEFAULT_HINT, clear, showNameTaken, showNameNotice, openPath };
}));
