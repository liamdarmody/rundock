'use strict';
// EVERY EXTERNAL LINK OPENS OUTSIDE THE APP.
//
// One rule for the whole page, so a surface added later cannot forget it:
// a click on a link to a web address (http or https), anywhere on Rundock's
// page, opens that address in a new tab in browser mode, and in the system
// browser in the desktop app (whose window-open handler hands it out; see
// electron/external-links.js). The app page itself never navigates to it.
// Before this, each surface decided for itself, and a conversation link
// navigated the whole app away in browser mode.
//
// Everything else keeps its own behaviour: an in-page anchor, a relative or
// workspace link, a wikilink (which carries no href), and mailto. Clicks with
// a modifier or a middle button are left to the browser, which already opens
// those in a new tab (and the desktop window-open handler catches them).
//
// Classic script, loaded early and always, in the capture phase at the
// document root, so no surface's own handler runs before it and none can
// forget it. Frames are separate documents: an extension view reaches the
// web only through the host's openExternal, and the HTML preview carries its
// own handler.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.RundockExternalLinks = api;
    if (root.document) api.install(root.document, root);
  }
}(typeof self !== 'undefined' ? self : this, function () {
  // The web address a link opens outside, or null for any link the rule
  // leaves alone. Read from the attribute and resolved against the page, so
  // a relative link is never mistaken for one.
  function externalHref(anchor, baseUrl) {
    if (!anchor || typeof anchor.getAttribute !== 'function') return null;
    const raw = anchor.getAttribute('href');
    if (!raw) return null;
    // Written as the web (http: or https:) or protocol-relative (`//host`,
    // the web at the page's own scheme) only. A relative href resolves to the
    // app's own origin and is the app's to handle; any other scheme is not
    // the web. Resolved only to normalise, so the scheme test is the rule.
    if (!/^(?:https?:|\/\/)/i.test(raw.trim())) return null;
    try { return new URL(raw, baseUrl).href; } catch (e) { return null; }
  }

  function onClick(win) {
    return (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      const anchor = target && typeof target.closest === 'function' ? target.closest('a[href]') : null;
      const href = externalHref(anchor, win.location.href);
      if (!href) return;
      event.preventDefault();
      win.open(href, '_blank', 'noopener,noreferrer');
    };
  }

  function install(doc, win) {
    if (!doc || doc.rundockExternalLinksInstalled) return false;
    doc.rundockExternalLinksInstalled = true;
    doc.addEventListener('click', onClick(win || doc.defaultView), true);
    return true;
  }

  return { externalHref, install };
}));
