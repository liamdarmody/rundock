'use strict';
// E2E server launcher, used by Playwright's webServer. Seeds a disposable
// workspace fixture, points HOME at the fixture's fake home (so the fake
// Claude Code session jsonl resolves and nothing touches the real one), and
// boots the real server.js in-process on the E2E port.
const path = require('node:path');
const { buildFixture } = require('./fixture.js');

// The stub runtime first on PATH, so a spec that presses Run on a routine
// spawns the stub and never a real agent CLI with permissions skipped.
process.env.PATH = path.join(__dirname, '..', 'helpers', 'stub-claude') + path.delimiter + process.env.PATH;

const { workspace, home } = buildFixture();
process.env.HOME = home;
process.env.USERPROFILE = home; // Windows equivalent
process.env.WORKSPACE = workspace;
process.env.RUNDOCK_ELECTRON = '1'; // keep recent-workspaces file inside the fake home

// Package installs fetch from GitHub through the real acquirer. Git's own
// url rewriting points one fixture organisation at repositories the specs
// seed beside the workspace, so that path runs unchanged with no network.
process.env.GIT_CONFIG_COUNT = '1';
process.env.GIT_CONFIG_KEY_0 = `url.file://${require('node:path').join(workspace, '..', 'repos')}/.insteadOf`;
process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/e2e-fixture/';

// A permission request nobody answers is denied at this timeout. Six seconds
// rather than the product's two minutes, so a spec can watch one expire. No
// spec answers a card slower than this.
if (!process.env.RUNDOCK_PERMISSION_TIMEOUT_MS) process.env.RUNDOCK_PERMISSION_TIMEOUT_MS = '6000';

const PORT = Number(process.env.E2E_PORT || 34517);
const { startServer } = require('../../server.js');

// Let the test browser in as opening the printed link would, BEFORE the
// server listens, so the storage state exists by the time Playwright sees the
// port open: the session token in the page's own storage, and the cookie for
// pictures and PDFs. See test/e2e/credentials.js.
//
// The run's own session store, in its temporary folder: never the checkout's
// real one, which a developer's own browser depends on.
const fs = require('node:fs');
const auth = require('../../lib/auth/index.js');
const credentials = require('./credentials.js');
fs.mkdirSync(credentials.DIR, { recursive: true, mode: 0o700 });
auth.configureSessionStore(require('node:path').join(credentials.DIR, 'sessions.json'));
auth.setLinkPrinter(() => {});
const { token, mediaCookie } = auth.exchangeCode(auth.codeOf(auth.signInLink(PORT)), PORT);
const [mediaName, mediaValue] = mediaCookie.split('=');
const expires = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
fs.writeFileSync(credentials.STORAGE_STATE, JSON.stringify({
  cookies: ['localhost', '127.0.0.1'].map((domain) => ({ name: mediaName, value: mediaValue, domain, path: '/workspace-file', expires, httpOnly: true, secure: false, sameSite: 'Strict' })),
  origins: [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`].map((origin) => ({ origin, localStorage: [{ name: 'rundock-session', value: token }] })),
}), { mode: 0o600 });
fs.writeFileSync(credentials.SESSION_FILE, token, { mode: 0o600 });
fs.writeFileSync(credentials.HOOK_TOKENS, JSON.stringify(Object.fromEntries(
  credentials.HOOK_SCOPES.map((scope) => [scope == null ? '' : scope, auth.issueHookToken(scope)]),
)), { mode: 0o600 });

startServer({ port: PORT });
