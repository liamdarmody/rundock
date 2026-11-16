// Keyboard shortcuts for the nav rail: Cmd/Ctrl with a digit opens the rail's
// main views by their place in it, counted top to bottom, and Cmd/Ctrl+,
// opens Settings.
//
// BY POSITION, READ AT THE KEY PRESS. The digit is the item's place in the
// rail when the key goes down, never a list of names kept here, so a rail that
// is reordered or grows keeps its numbers honest. The hints are built from the
// same read and the same key function, so a hint cannot name a key that does
// something else.
//
// THE MODIFIER IS THE CLIENT'S. A Mac browser can talk to a Linux server, so
// the platform comes from the navigator this page runs in, never from the
// server. When it cannot be read the answer is Control, and the hints say
// Control too, so the hint and the key still agree.
//
// The same UMD shape as palette-model.js: a script tag in the page and a
// require in a Node test, with everything from the page passed in.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockNavShortcuts = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAIN_ITEMS = '.nav-main button.nav-item[data-nav]';
  const SETTINGS_ITEM = '.nav-rail button.nav-item[data-nav="settings"]';
  const OPEN_MODAL = '[aria-modal="true"], dialog[open]';

  // 'Meta' on Apple platforms, 'Control' everywhere else and whenever the
  // platform cannot be read: userAgentData first, then navigator.platform.
  function modifierFor(nav) {
    const fromHints = nav && nav.userAgentData && nav.userAgentData.platform;
    const platform = (typeof fromHints === 'string' && fromHints)
      || (nav && typeof nav.platform === 'string' && nav.platform) || '';
    return /mac|iphone|ipad|ipod/i.test(platform) ? 'Meta' : 'Control';
  }

  // Every item with a shortcut and its key, read from the page as it is now:
  // the nth main item answers to the digit n (1 to 9), Settings to the comma.
  function bindings(doc) {
    const list = Array.from(doc.querySelectorAll(MAIN_ITEMS)).slice(0, 9)
      .map((item, i) => ({ item, key: String(i + 1) }));
    const settings = doc.querySelector(SETTINGS_ITEM);
    if (settings) list.push({ item: settings, key: ',' });
    return list;
  }

  // A digit or the comma by the character the key types, never by where the
  // key sits: a layout that types '-' or 'é' on the digit row keeps those keys
  // for its own shortcuts, zoom out among them.
  function pressedKey(event) {
    return /^[1-9,]$/.test(event.key) ? event.key : null;
  }

  // Exactly this client's modifier: not the other platform's, not both, and
  // never with Shift or Alt, which other shortcuts and layouts own.
  function modifierOnly(event, modifier) {
    if (event.shiftKey || event.altKey) return false;
    return modifier === 'Meta' ? !!event.metaKey && !event.ctrlKey : !!event.ctrlKey && !event.metaKey;
  }

  // The rail item a keydown asks for, or null when it is not one of these
  // shortcuts.
  function match(event, modifier, doc) {
    if (!event || !modifierOnly(event, modifier)) return null;
    const key = pressedKey(event);
    const hit = key && bindings(doc).find((b) => b.key === key);
    return hit ? hit.item : null;
  }

  // The same form the top bar's search hint uses.
  function hintFor(key, modifier) {
    return modifier === 'Meta' ? `⌘${key}` : `Ctrl ${key}`;
  }

  // Each item's tooltip and aria-keyshortcuts, from the same read a key press
  // makes. Every hint is rebuilt from the item's own label, kept aside the
  // first time, so applying them again replaces them.
  function applyHints(doc, modifier) {
    doc.querySelectorAll('.nav-rail [data-nav-label]').forEach((item) => {
      item.setAttribute('data-tooltip', item.getAttribute('data-nav-label'));
      item.removeAttribute('aria-keyshortcuts');
    });
    for (const { item, key } of bindings(doc)) {
      if (!item.hasAttribute('data-nav-label')) item.setAttribute('data-nav-label', item.getAttribute('data-tooltip') || '');
      item.setAttribute('data-tooltip', `${item.getAttribute('data-nav-label')} (${hintFor(key, modifier)})`);
      item.setAttribute('aria-keyshortcuts', `${modifier}+${key}`);
    }
  }

  // The hints now and whenever an item joins, leaves or moves within the
  // rail's main group, so a hint never names a key that opens something else.
  // Rebuilding them changes only attributes, which this does not watch.
  function installHints(doc, modifier) {
    applyHints(doc, modifier);
    const main = doc.querySelector('.nav-main');
    const Observer = doc.defaultView && doc.defaultView.MutationObserver;
    if (main && Observer) new Observer(() => applyHints(doc, modifier)).observe(main, { childList: true });
  }

  // The keydown listener. Everything it needs from the page is passed in:
  //   switchNav    the rail's own switch, the path a click takes
  //   currentView  () => the view on screen
  //   blocked      () => true while the search palette is open
  //   isShown      (el) => whether an element is on screen
  function createKeydownHandler({ doc, modifier, switchNav, currentView, blocked, isShown }) {
    const shown = isShown || ((el) => el.getClientRects().length > 0);
    let landed = null;
    return function onNavShortcut(event) {
      if (event.defaultPrevented || blocked() || Array.from(doc.querySelectorAll(OPEN_MODAL)).some(shown)) return;
      const item = match(event, modifier, doc);
      if (!item || !shown(item)) return;
      event.preventDefault();
      if (event.repeat) return;
      const nav = item.getAttribute('data-nav');
      // A second press that would arrive where the first one left you, with
      // nothing moved since, is not a second arrival.
      if (landed && landed.nav === nav && landed.view === currentView() && item.classList.contains('active')) return;
      switchNav(nav);
      landed = { nav, view: currentView() };
    };
  }

  return { modifierFor, bindings, match, hintFor, applyHints, installHints, createKeydownHandler };
}));
