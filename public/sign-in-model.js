// Signing a browser in from the printed link, and what a tab says when it is
// not signed in. Pure: no DOM, following public/update-strip-view.js.
//
// Running from source, the terminal prints `http://localhost:<port>/#c=<code>`.
// A browser never sends the part after `#` to any server, so the code reaches
// only this page, which trades it once for a session token (lib/auth) and
// takes it out of the address bar. The code is good once and only for a few
// minutes, so the copy a browser keeps in its history is dead.
//
// The token is kept in this page's own storage, which belongs to its scheme,
// host and port alone, and sent as a header on every request and in the
// WebSocket handshake: never as a cookie, which a browser would send to every
// server on localhost. After that, new tabs, restarts and browser restarts
// all carry on as before.
//
// A tab that is not signed in shows one line and nothing else. Which line
// depends on whether this tab was ever connected: one that was is a tab left
// open across a restart into a version that asks for the link ("Rundock
// restarted"); one that never was is a browser that was never signed in. In
// both, the person opens the printed link once and the tab carries on by
// itself.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockSignIn = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // The code in a `#c=<code>` fragment, or null. The code is URL-safe base64,
  // so anything else in its place is not a code.
  function codeFromHash(hash) {
    const match = /^#(?:.*&)?c=([A-Za-z0-9_-]{16,128})(?:&|$)/.exec(String(hash || ''));
    return match ? match[1] : null;
  }

  const STORAGE_KEY = 'rundock-session';
  const SESSION_HEADER = 'X-Rundock-Session';

  // The session token this page keeps, or null. Storage can be missing or
  // refuse (a private window, a blocked site), and that is simply no token.
  function readToken(storage) {
    try { const t = storage && storage.getItem(STORAGE_KEY); return t && /^[A-Za-z0-9_-]{22,128}$/.test(t) ? t : null; } catch (e) { return null; }
  }
  function keepToken(storage, token) {
    try { if (storage && token) storage.setItem(STORAGE_KEY, token); } catch (e) { /* not kept: the link is needed again */ }
  }

  // The subprotocols the page's WebSocket offers: `rundock`, and with a token
  // the one carrying it. The server only ever chooses `rundock`.
  function socketProtocols(token) {
    return token ? ['rundock', `rundock.session.${token}`] : ['rundock'];
  }

  // Wrap fetch so every request to this page's own server carries the token,
  // and nothing sent anywhere else ever does.
  function withSessionHeader(fetchImpl, getToken, ownOrigin) {
    return function sessionFetch(input, init) {
      const token = getToken();
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      let same = false;
      try { same = new URL(url, ownOrigin).origin === ownOrigin; } catch (e) { same = false; }
      if (!token || !same) return fetchImpl(input, init);
      const opts = Object.assign({}, init || {});
      const headers = new Headers(opts.headers || (typeof input !== 'string' && input && input.headers) || undefined);
      headers.set(SESSION_HEADER, token);
      opts.headers = headers;
      return fetchImpl(input, opts);
    };
  }

  const RESTARTED = 'Rundock restarted. Open it from the link in your terminal';
  const NEVER_SIGNED_IN = 'Open Rundock from the link in your terminal';
  // A Rundock the Windows launcher started has no terminal to point to: the
  // launcher hands each new browser its link when it is opened again.
  const FROM_LAUNCHER = 'Open Rundock again from its icon on your desktop';

  function signedOutLine(everConnected, fromLauncher) {
    if (fromLauncher) return FROM_LAUNCHER;
    return everConnected ? RESTARTED : NEVER_SIGNED_IN;
  }

  // Whether an exchange should be tried again: anything but the server's
  // own answer (a refusal, or a token) means it was not up yet.
  function exchangeFinal(status) {
    return status === 200 || status === 401;
  }

  return { codeFromHash, readToken, keepToken, socketProtocols, withSessionHeader, signedOutLine, exchangeFinal, RESTARTED, NEVER_SIGNED_IN, FROM_LAUNCHER, STORAGE_KEY };
}));
