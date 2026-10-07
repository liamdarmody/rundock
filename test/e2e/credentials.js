'use strict';
// THE E2E BROWSER'S WAY IN, and the hook tokens the specs that stand in for
// the permission hook send.
//
// The server lets only Rundock's own window drive it (lib/auth). A person
// running from source opens the printed link once per browser, and the page
// trades its one-time code for a session token kept in the page's own
// storage. The E2E launcher (serve.js) runs the server in its own process, so
// it makes that exchange itself, with its own session store, and leaves the
// token here as Playwright storage state for every spec's browser to start
// with, beside the cookie for pictures and PDFs. The launch key is never
// written anywhere.
//
// A few specs raise a card exactly as the permission hook does. The hook
// sends the token Rundock started its agent with, bound to one conversation
// (a routine run's to none), so the launcher issues those here too, for the
// conversations those specs use.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.E2E_PORT || 34517);
const DIR = path.join(os.tmpdir(), `rundock-e2e-${PORT}`);
const STORAGE_STATE = path.join(DIR, 'storage-state.json');
const HOOK_TOKENS = path.join(DIR, 'hook-tokens.json');
// The conversations whose hook tokens are issued up front: `null` is the
// routine-run token, the rest are conversation ids the specs raise cards in.
const HOOK_SCOPES = [null, 'c1', 'c2', 'c3'];

const SESSION_FILE = path.join(DIR, 'session-token');
// The headers a spec's own socket or request sends as the test browser's page.
function sessionHeaders() {
  return { 'X-Rundock-Session': fs.readFileSync(SESSION_FILE, 'utf-8').trim() };
}

function hookToken(conversationId = null) {
  const tokens = JSON.parse(fs.readFileSync(HOOK_TOKENS, 'utf-8'));
  const token = tokens[conversationId == null ? '' : conversationId];
  if (!token) throw new Error(`no hook token issued for ${conversationId}; add it to HOOK_SCOPES in test/e2e/credentials.js`);
  return token;
}

// A read a spec makes beside the page (Playwright's own request context, not
// the page's fetch), carrying the page's session token as the page's own
// requests do. The server answers only Rundock's window, and the token is in
// the page's storage, not in a cookie the request context would send.
function sessionGet(page, url) {
  return page.request.get(url, { headers: sessionHeaders() });
}

module.exports = { PORT, DIR, STORAGE_STATE, SESSION_FILE, HOOK_TOKENS, HOOK_SCOPES, sessionHeaders, sessionGet, hookToken };
