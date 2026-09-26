'use strict';
// EVERY EXTERNAL LINK OPENS OUTSIDE THE APP, AND THE APP'S WINDOW NEVER
// LEAVES ITS OWN PAGE.
//
// The desktop half of one rule (the page half is public/external-links.js):
// clicking a web address anywhere in Rundock opens it in the system browser,
// never in the main window. Two doors, both held here:
//
// - A new window (a target=_blank link, window.open): denied, and a web or
//   mail address is handed to the system instead. Any other scheme (file:,
//   javascript:, a custom protocol) is denied and handed to nothing, because
//   the system would run whatever is registered for it.
// - A navigation of the main window: allowed only to the app's own origin,
//   compared exactly. Anything else is stopped, and a web or mail address is
//   handed to the system.

function parse(url) {
  try { return new URL(String(url)); } catch (e) { return null; }
}

// What the system may be handed: the web and mail, nothing else.
function isHandedOutside(url) {
  const u = parse(url);
  return !!u && (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:');
}

// Whether a navigation stays inside the app: exactly the app's own origin.
function isAppUrl(url, appOrigin) {
  const u = parse(url);
  return !!u && u.origin === appOrigin;
}

function installExternalLinkGuards(webContents, { appOrigin, openExternal, log = () => {} }) {
  if (typeof openExternal !== 'function') throw new Error('installExternalLinkGuards needs openExternal');
  webContents.setWindowOpenHandler(({ url }) => {
    if (isHandedOutside(url)) openExternal(url);
    else log(`denied a window for ${String(url).slice(0, 80)}`);
    return { action: 'deny' };
  });
  webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url, appOrigin)) return;
    event.preventDefault();
    if (isHandedOutside(url)) openExternal(url);
    else log(`stopped the window navigating to ${String(url).slice(0, 80)}`);
  });
  return ['setWindowOpenHandler', 'will-navigate'];
}

module.exports = { isHandedOutside, isAppUrl, installExternalLinkGuards };
