'use strict';
// WHO MAY DRIVE THE SERVER: Rundock's own window, and nothing else.
//
// lib/local-origin.js already refuses other machines' pages (Host) and other
// sites' writes (Origin). What it cannot tell apart is Rundock's window and
// any other process on this machine, an agent included, because a local
// process sends no Origin at all. This module is that second half: one
// question, `authenticate(req, port)`, asked of every WebSocket upgrade and
// every HTTP route except the page's own static files, the two routes a
// browser uses to be let in, and the permission hook's two routes.
//
// THE LAUNCH KEY. Made in memory when this module loads. It is never written
// to disk, the environment, a URL or the HTML, and never printed: agents are
// started with a copy of process.env, and anything a browser is given ends up
// in its history. Only the desktop app's own main process uses it: it runs
// this server in-process, reads the key with launchKey(), and adds it as a
// header to every request its window makes. The page never holds it.
//
// FROM SOURCE, IN A BROWSER: a one-time code, then a session token.
//   - The terminal prints `http://localhost:<port>/#c=<code>`. The code is
//     good for one exchange, for CODE_TTL_MS, and for nothing else: a link
//     left in a browser's history, or on a browser's command line, is dead
//     once it has been opened. A link is printed only when the person asks:
//     when Rundock starts, and when Enter is pressed in the terminal it runs
//     in (listenForLinkRequests), at most once a second. Nothing a program
//     can send over the network makes one appear, because whatever reads the
//     terminal, a service's journal or a multiplexer's scrollback can read
//     the newest link until it is used or expires.
//   - The page trades the code for a session token, which it keeps in its own
//     storage (scoped to its scheme, host AND port) and sends as a header on
//     every request and in the WebSocket handshake. Never as a cookie: a
//     browser sends a localhost cookie to every port on localhost, so any
//     server an agent starts there would be handed it.
//   - Pictures and PDFs are loaded by the browser itself, which cannot attach
//     a header, so the exchange also sets a separate media cookie, good only
//     for GET /workspace-file and for files whose real place is inside the
//     workspace. Sent elsewhere by mistake, it can read those files and do
//     nothing else.
//   - Only fingerprints of tokens are kept on disk, each with its kind, the
//     port it was issued for and when, and each expires after
//     SESSION_MAX_AGE_S.
//
// THE DESKTOP APP accepts its window's key and nothing else: setDesktopOnly.
// Its window never holds a token or a cookie, so honouring them there would
// only let a program that can write the sessions file in.
//
// THE HOOK'S TOKENS. The permission hook runs inside the agent's own process
// tree, so whatever it holds the agent holds too: it can never be given the
// window's key. Each agent is started with a token bound to its conversation
// instead (a routine run's token is bound to no conversation). The hook's
// routes accept only that token, and act only for the conversation it names:
// an agent can ask for a card in its own conversation and collect its own
// notice, and nothing else. Nothing the hook sends can answer a card.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const KEY_HEADER = 'x-rundock-key';
const CODE_HEADER = 'x-rundock-code';
const SESSION_HEADER = 'x-rundock-session';
const HOOK_HEADER = 'x-rundock-hook-token';
// The WebSocket subprotocol the page asks for, and the prefix of the second
// one that carries its session token (a browser WebSocket cannot send a
// header, and the URL is no place for a secret).
const WS_PROTOCOL = 'rundock';
const WS_SESSION_PREFIX = 'rundock.session.';
// How long a printed code is good for.
const CODE_TTL_MS = 15 * 60 * 1000;
// How many browsers are remembered, of each kind; the oldest goes first.
const MAX_SESSIONS = 32;
// A browser stays let in for a year from the day it opened the link (D1).
const SESSION_MAX_AGE_S = 365 * 24 * 60 * 60;

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{22,128}$/;
const LAUNCH_KEY = crypto.randomBytes(32).toString('base64url');
function launchKey() { return LAUNCH_KEY; }

let desktopOnly = false;
// The desktop app: only the window's key is accepted.
function setDesktopOnly(on) { desktopOnly = !!on; }

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

// Constant-time comparison of two secrets of any length, by comparing their
// digests, which always have the same length.
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  return crypto.timingSafeEqual(digest(a), digest(b));
}

function fingerprint(token) { return digest(token).toString('hex'); }
const newSecret = () => crypto.randomBytes(32).toString('base64url');

// ===== ONE-TIME CODES =====

// Every code still good: code -> the moment it stops being good.
const codes = new Map();
let printedCode = null;
let lastPrintAt = 0;
let printLink = (line) => console.log(line);

// THE WINDOWS LAUNCHER'S CODE. The launcher a from-source install puts on the
// Windows desktop starts the server hidden, its output going to a log file,
// and opens the browser itself. So it makes a code, hands it over in
// RUNDOCK_LAUNCH_CODE and opens the link with it. Taken and removed from the
// environment as this module loads, good once and for CODE_TTL_MS like any
// other, and the server it started prints no link at all, so its log never
// holds a live one. The desktop app ignores it.
const HANDED_CODE = process.env.RUNDOCK_LAUNCH_CODE;
delete process.env.RUNDOCK_LAUNCH_CODE;
const FROM_LAUNCHER = !process.versions.electron && typeof HANDED_CODE === 'string' && TOKEN_SHAPE.test(HANDED_CODE);
if (FROM_LAUNCHER) codes.set(HANDED_CODE, Date.now() + CODE_TTL_MS);
// Whether a launcher holds this server's link, so none is printed.
function codeFromLauncher() { return FROM_LAUNCHER; }

function linkFor(port, code) { return `http://localhost:${port}/#c=${code}`; }
function codeOf(link) { const m = /#c=([A-Za-z0-9_-]+)/.exec(String(link || '')); return m ? m[1] : null; }

function liveCode(code) {
  const until = codes.get(code);
  if (until === undefined) return false;
  if (Date.now() > until) { codes.delete(code); return false; }
  return true;
}

// The link to print: the current code while it is good, or a new one.
function signInLink(port) {
  if (!printedCode || !liveCode(printedCode)) {
    printedCode = newSecret();
    codes.set(printedCode, Date.now() + CODE_TTL_MS);
  }
  return linkFor(port, printedCode);
}

// Where links are printed (the server's own output); tests capture it.
function setLinkPrinter(fn) { printLink = typeof fn === 'function' ? fn : printLink; }

// Print the current link. The desktop app has no link, and a server its
// launcher started has handed its code over already and prints none.
function announceLink(port) {
  if (FROM_LAUNCHER || desktopOnly) return;
  lastPrintAt = Date.now();
  printLink(`  Rundock is running: ${signInLink(port)}`);
}

// THE PERSON ASKING FOR ANOTHER LINK: a line on `input`, the terminal Rundock
// was started from. The last link printed is retired and a new one printed,
// at most once a second. Only the person at that terminal can press Enter in
// it, which is what makes this the one way to get a link after the first.
function listenForLinkRequests(input, port) {
  if (!input || typeof input.on !== 'function' || FROM_LAUNCHER || desktopOnly) return false;
  input.on('data', (chunk) => {
    if (!String(chunk).includes('\n')) return;
    if (Date.now() - lastPrintAt < 1000) return;
    if (printedCode) codes.delete(printedCode);
    printedCode = null;
    announceLink(port);
  });
  input.on('error', () => {});
  return true;
}

// ===== BROWSER SESSIONS =====

let sessionFile = null;
let memorySessions = [];
let cache = { mtimeMs: -1, sessions: [] };

function sessionStorePath() { return sessionFile; }

// Where the fingerprints are kept: Rundock's own folder, outside every
// workspace. Set once by the server at boot; unset means in memory only.
function configureSessionStore(filePath) {
  sessionFile = filePath || null;
  memorySessions = [];
  cache = { mtimeMs: -1, sessions: [] };
}

// Read once per change of the file, not once per request.
function readSessions() {
  if (!sessionFile) return memorySessions;
  let stat;
  try { stat = fs.statSync(sessionFile); } catch (e) { return []; }
  if (stat.mtimeMs === cache.mtimeMs) return cache.sessions;
  let sessions = [];
  try {
    const data = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
    sessions = Array.isArray(data.sessions) ? data.sessions.filter(s => s && typeof s.fp === 'string') : [];
  } catch (e) { sessions = []; }
  cache = { mtimeMs: stat.mtimeMs, sessions };
  return sessions;
}

function writeSessions(sessions) {
  const now = Date.now();
  const fresh = sessions.filter(s => now - Number(s.at) <= SESSION_MAX_AGE_S * 1000);
  const kept = ['session', 'media'].flatMap(kind => fresh.filter(s => s.kind === kind).slice(-MAX_SESSIONS));
  if (!sessionFile) { memorySessions = kept; return; }
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  const tmp = `${sessionFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ sessions: kept }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, sessionFile);
  cache = { mtimeMs: -1, sessions: [] };
}

function mediaCookieName(port) { return `rundock_media_${port}`; }

function readCookie(req, name) {
  const header = req && req.headers && req.headers.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// A token this install issued, of this kind, for this port, not yet expired.
function knownSession(token, port, kind) {
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return false;
  const fp = fingerprint(token);
  const now = Date.now();
  return readSessions().some(s => s.kind === kind && String(s.port) === String(port)
    && now - Number(s.at) <= SESSION_MAX_AGE_S * 1000 && sameSecret(s.fp, fp));
}

// The session token in a WebSocket handshake's offered subprotocols.
function tokenFromProtocols(header) {
  if (typeof header !== 'string') return null;
  for (const p of header.split(',')) {
    const v = p.trim();
    if (v.startsWith(WS_SESSION_PREFIX)) return v.slice(WS_SESSION_PREFIX.length);
  }
  return null;
}

// A request for a picture or PDF, the one kind the media cookie answers.
function isMediaRequest(req) {
  const method = String((req && req.method) || 'GET').toUpperCase();
  return (method === 'GET' || method === 'HEAD') && String((req && req.url) || '').startsWith('/workspace-file?');
}

// ===== THE ONE QUESTION =====

// What let this request in: 'key' (the desktop window), 'session' (a browser
// that opened the link), 'media' (that browser's picture or PDF), or null.
function authorisedBy(req, port) {
  const headers = (req && req.headers) || {};
  if (sameSecret(headers[KEY_HEADER], LAUNCH_KEY)) return 'key';
  if (desktopOnly) return null;
  const token = headers[SESSION_HEADER] || tokenFromProtocols(headers['sec-websocket-protocol']);
  if (token) return knownSession(token, port, 'session') ? 'session' : null;
  if (isMediaRequest(req) && knownSession(readCookie(req, mediaCookieName(port)), port, 'media')) return 'media';
  return null;
}

function authenticate(req, port) { return authorisedBy(req, port) !== null; }

// Trade a live code for a session token and a media token; null when the
// code is not good. The code is spent either way it was good, and a fresh
// link is printed for the next browser.
function exchangeCode(code, port, done) {
  if (desktopOnly || typeof code !== 'string' || !liveCode(code)) return null;
  codes.delete(code);
  const token = newSecret();
  const media = newSecret();
  const at = Date.now();
  writeSessions([...readSessions(),
    { fp: fingerprint(token), kind: 'session', port: String(port), at },
    { fp: fingerprint(media), kind: 'media', port: String(port), at }]);
  // Spent: the next browser asks the terminal for its own link.
  if (code === printedCode) printedCode = null;
  const mediaCookie = `${mediaCookieName(port)}=${media}`;
  if (typeof done === 'function') done(token, mediaCookie);
  return { token, mediaCookie };
}

// POST /api/auth/session, sent once by a page opened from the printed link,
// with the link's code in a header. Answers the session token in the body
// and sets the media cookie, or 401. The launch key is never accepted here.
function signInBrowser(req, res, port) {
  const headers = (req && req.headers) || {};
  const result = exchangeCode(headers[CODE_HEADER], port);
  if (!result) {
    res.writeHead(401, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('Open Rundock from the link in your terminal');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Set-Cookie': `${result.mediaCookie}; HttpOnly; SameSite=Strict; Path=/workspace-file; Max-Age=${SESSION_MAX_AGE_S}`,
  });
  res.end(JSON.stringify({ token: result.token }));
}

// GET /api/auth/status: whether this page is let in, and on a server the
// Windows launcher started, whether that server is idle (the launcher
// restarts an idle one to hand a new browser a fresh code). Says nothing
// else, so it needs no key, and it never prints a link.
let idleProbe = () => false;
function setIdleProbe(fn) { if (typeof fn === 'function') idleProbe = fn; }
function sessionStatus(req, res, port) {
  const by = authorisedBy(req, port);
  const letIn = by === 'key' || by === 'session';
  const body = { signedIn: letIn };
  if (FROM_LAUNCHER) { body.launcher = true; body.idle = !!idleProbe(); }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// ===== THE HOOK'S TOKENS =====

const ROUTINE_SCOPE = '\u0000routine';
const hookTokensByScope = new Map(); // scope -> token
const hookScopes = new Map();        // token -> conversation id, or null for a routine run

// The token an agent is started with, bound to its conversation (null: a
// routine run, which has none). One per conversation for the life of this
// launch, so an agent restarted for the same conversation asks the same way.
function issueHookToken(conversationId) {
  const scope = conversationId ? String(conversationId) : ROUTINE_SCOPE;
  let token = hookTokensByScope.get(scope);
  if (!token) {
    token = crypto.randomBytes(24).toString('base64url');
    hookTokensByScope.set(scope, token);
    hookScopes.set(token, conversationId ? String(conversationId) : null);
  }
  return token;
}

// The conversation a hook token was issued for: a string, null for a routine
// run, or undefined for a token this launch never issued.
function hookTokenScope(token) {
  if (typeof token !== 'string' || !token) return undefined;
  return hookScopes.has(token) ? hookScopes.get(token) : undefined;
}

function hookScopeOf(req) {
  return hookTokenScope(req && req.headers ? req.headers[HOOK_HEADER] : undefined);
}

module.exports = {
  KEY_HEADER, CODE_HEADER, SESSION_HEADER, HOOK_HEADER, WS_PROTOCOL, WS_SESSION_PREFIX,
  CODE_TTL_MS, MAX_SESSIONS, SESSION_MAX_AGE_S,
  launchKey, setDesktopOnly, codeFromLauncher,
  signInLink, codeOf, announceLink, listenForLinkRequests, setLinkPrinter, setIdleProbe, sessionStorePath,
  authorisedBy, authenticate, exchangeCode, signInBrowser, sessionStatus,
  configureSessionStore, mediaCookieName,
  issueHookToken, hookTokenScope, hookScopeOf,
};
