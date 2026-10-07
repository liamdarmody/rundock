'use strict';
// For the tools that start Rundock from source as a child process (the smoke
// runs, the walk, the screenshot pipeline, the desktop parity run): read the
// link the server prints, which carries a one-time code, and keep that code
// out of anything they echo or save.
//
// Only Rundock's own window may drive the server (lib/auth). A tool driving
// a browser opens the link in that browser, exactly as a person running from
// source does. Each code is good once, and the server prints another link
// only when asked at its terminal (a line on its stdin), so a tool opening
// several browsers asks there and reads the newest link (latestSignInLink). A tool with no browser trades a code for a session
// token itself (exchangeForSession).

const LINK = /Rundock is running: (http:\/\/localhost:\d+\/#c=[A-Za-z0-9_-]+)/;
const LINKS = /Rundock is running: (http:\/\/localhost:\d+\/#c=[A-Za-z0-9_-]+)/g;

function signInLink(text) {
  const m = LINK.exec(String(text || ''));
  return m ? m[1] : null;
}

// Server output with each link's code cut out, for logs, failure tails and
// saved files.
function withoutKey(text) {
  return String(text || '').replace(/#c=[A-Za-z0-9_-]+/g, '#c=…');
}

// The newest link printed so far, for a tool that has used earlier ones.
function latestSignInLink(text) {
  const all = [...String(text || '').matchAll(LINKS)];
  return all.length ? all[all.length - 1][1] : null;
}

// Trade a link's code for a session token, as the page does. Resolves the
// headers a non-browser client sends as Rundock's own page.
async function exchangeForSession(link) {
  const url = new URL(link);
  const code = (/#c=([A-Za-z0-9_-]+)/.exec(link) || [])[1];
  const res = await fetch(`${url.origin}/api/auth/session`, { method: 'POST', headers: { 'X-Rundock-Code': code } });
  if (!res.ok) throw new Error(`the link was not accepted (${res.status})`);
  const { token } = await res.json();
  return { 'X-Rundock-Session': token };
}

// Wait until `read()` (the output captured so far) carries the link.
async function waitForSignInLink(read, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const link = signInLink(read());
    if (link) return link;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Ask a server started with scripts/smoke/boot-server.js for the token the
// permission hook of `conversationId` would be started with (null: a routine
// run). Over the child's own IPC channel, which only the parent holds.
function askHookToken(child, conversationId = null) {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => { child.off('message', onMessage); reject(new Error('no hook token from the server')); }, 5000);
    function onMessage(m) {
      if (!m || m.type !== 'hook-token' || m.id !== id) return;
      clearTimeout(timer);
      child.off('message', onMessage);
      resolve(m.token);
    }
    child.on('message', onMessage);
    child.send({ type: 'hook-token', id, conversationId });
  });
}

module.exports = { signInLink, latestSignInLink, withoutKey, waitForSignInLink, exchangeForSession, askHookToken };
