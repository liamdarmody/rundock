// Update strip view decision. Pure: no DOM, following the convention of
// public/chrome-insets.js and public/theme-choice.js.
//
// The main process decides WHAT the user should know about an update
// (electron/update-state.js); this module decides how the sidebar strip
// presents it, given one piece of renderer-side state: whether the user
// chose "Later" on the ready row. Later defers, it never dismisses: the
// pending update is still pending regardless of what the interface shows,
// so the quiet chip remains, and one click brings the full row back.
//
// Modes:
//   download  collapsed ring while a download runs; percent or indeterminate
//   ready     expanded row with a restart action (the state the feature is for)
//   chip      the deferred form of ready: a small static dot, quiet, not gone
//
// The stuck state (downloaded repeatedly, never installed) renders like
// ready and ignores deferral: it is an escalation, and quieting it would
// defeat the escape hatch it exists to provide.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.updateStripView = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  function updateStripView(ui, deferred) {
    if (!ui || typeof ui !== 'object') return { show: false };
    switch (ui.kind) {
      case 'progress':
        return {
          show: true,
          mode: 'download',
          percent: typeof ui.percent === 'number' ? ui.percent : 0,
          indeterminate: Boolean(ui.indeterminate),
          text: ui.text || 'Downloading an update. You can keep working.',
        };
      case 'ready':
        if (deferred) return { show: true, mode: 'chip' };
        return {
          show: true,
          mode: 'ready',
          text: ui.text || 'An update is ready to install.',
          detail: ui.detail || '',
          canRestart: true,
        };
      case 'stuck':
        return {
          show: true,
          mode: 'ready',
          text: ui.text || 'An update was downloaded but has not installed.',
          detail: ui.detail || '',
          canRestart: true,
        };
      default:
        // none, dialog-only, and anything unrecognised: the strip stays out
        // of the way. Fail closed; a broken update path must not occupy the
        // sidebar.
        return { show: false };
    }
  }

  return updateStripView;
}));
