// When the person last interacted with Rundock's own page.
//
// WHY THIS EXISTS, measured in a real engine. An extension view may ask
// Rundock to open a file or a web address only after the person clicks
// inside it. The browser's record of a click (`navigator.userActivation`)
// cannot say WHERE the click was: a click in the file tree sets it for a few
// seconds exactly as a click inside the view does. A view mounted by that
// tree click boots inside the window, and a sandboxed frame can move focus
// into itself without a click, so neither "a click happened" nor "the view
// has focus" is enough on its own. Both were tried; a hostile fixture got
// through each.
//
// What a frame cannot do is make Rundock's own page see a click. Events on
// this page are delivered to listeners on this window; a click inside an
// embedded frame is delivered to that frame and never here. So this records
// the page's own clicks and keys, from the moment the page loads (before the
// first tree click could mount anything), and the extension host refuses a
// click-gated request while one of them is recent enough to be the click the
// browser is reporting.
//
// Classic script, loaded early and always, because the host module is loaded
// lazily and would miss the click that opened the first view.
(function (root) {
  if (!root || typeof root.addEventListener !== 'function') return;
  if (typeof root.rundockLastHostGesture === 'number') return;
  root.rundockLastHostGesture = -Infinity;
  const note = function () { root.rundockLastHostGesture = Date.now(); };
  // Capture phase, so a handler that stops propagation cannot hide a gesture.
  for (const type of ['pointerdown', 'mousedown', 'keydown', 'touchstart']) {
    root.addEventListener(type, note, true);
  }
})(typeof window !== 'undefined' ? window : null);
