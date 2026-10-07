// Boots the real Rundock server (server.js) against a given workspace + fake
// $HOME, in an isolated child process, on a dedicated port. Returns a handle
// with the base URL and a stop() that tears the child down.
//
// The child is separate from the harness process on purpose: server.js starts
// a routine scheduler and search warm-up on boot, and keeping those timers out
// of the Playwright-driving process keeps the harness clean and killable.
//
// It reuses server.js exactly as e2e does (env HOME/WORKSPACE + startServer),
// without forking it.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXED_EPOCH, TIMEZONE } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(REPO_ROOT, 'server.js');
const SCHEDULER = path.join(REPO_ROOT, 'lib', 'scheduler.js');

// Dedicated capture port, deliberately distinct from the e2e port (34517) so
// captures and the e2e suite can run at the same time.
export const CAPTURE_PORT = Number(process.env.RUNDOCK_CAPTURE_PORT || 34519);

async function waitForReady(url, { timeoutMs = 20000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Rundock server did not become ready at ${url} within ${timeoutMs}ms`);
}

// One boot attempt on a specific port. Throws if the port is taken or the
// server does not come up.
async function spawnAttempt({ workspace, home, port, quiet, env = {} }) {
  // The server reads the time too: the scheduler computes every routine's
  // next run (and its first-seen stamp) from its own clock, and the client
  // only formats the instant it is sent. Left on wall-clock time, the
  // Routines shot showed the capture day's dates beside a page frozen at
  // FIXED_EPOCH. The scheduler's own clock seam (wireSchedulerDeps' `now`) is
  // set to the same instant before server.js loads; server.js wires only the
  // client set, so the clock survives its wiring. The tick stays disabled
  // (below), so a frozen clock can never fire a routine.
  //
  // The child's stdin stands in for the terminal, where Enter asks for
  // another link (lib/auth): each browser context needs its own.
  const bootScript = [
    `require(${JSON.stringify(SCHEDULER)}).wireSchedulerDeps({ now: () => new Date(${FIXED_EPOCH}) });`,
    `require(${JSON.stringify(SERVER)}).startServer({ port: ${port}, linkRequests: process.stdin });`,
  ].join('\n');
  const child = spawn(process.execPath, ['-e', bootScript], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,      // Windows equivalent
      WORKSPACE: workspace,
      RUNDOCK_ELECTRON: '1',  // keep the recent-workspaces file inside the fake home
      // The demo workspace's routines are seeded as enabled with real run
      // history so the routines panel has something real to show, but with
      // no genuine tick history behind them they read as overdue on real
      // wall-clock time from the moment the process starts. A capture run
      // long enough for one tick to land would otherwise let the scheduler
      // actually fire one against fake data and overwrite the seeded state.
      // See server.js's SCHEDULER_DISABLED for the other half of this.
      RUNDOCK_DISABLE_SCHEDULER: '1',
      // The browser's zone (harness.mjs TIMEZONE), so a schedule is read and
      // its next run shown in the same zone.
      TZ: TIMEZONE,
      ...env,
    },
    // stdout is always read: the sign-in link the server prints is how this
    // process learns the key, exactly as a person running from source does.
    stdio: ['pipe', 'pipe', quiet ? 'pipe' : 'inherit'],
  });

  let stderr = '';
  if (quiet && child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });
  // The links, held in this process only. Each carries a one-time code, and
  // the server prints another only when asked at its stdin, so every browser
  // context asks for one it has not been given before (takeSignInUrl). Echoed
  // output has the code cut out, so it never lands in a terminal log or a
  // capture record.
  let signInUrl = null;
  let out = '';
  const links = [];
  const given = new Set();
  child.stdout.on('data', (d) => {
    const text = d.toString();
    out += text;
    for (const m of text.matchAll(/Rundock is running: (http:\/\/localhost:\d+\/#c=[A-Za-z0-9_-]+)/g)) links.push(m[1]);
    if (!signInUrl && links.length) signInUrl = links[0];
    if (!quiet) process.stdout.write(text.replace(/#c=[A-Za-z0-9_-]+/g, '#c=…'));
  });

  const url = `http://localhost:${port}`;
  const exited = new Promise((_, reject) => {
    child.on('exit', (code) => reject(new Error(`Rundock server exited early (code ${code}).\n${stderr}`)));
  });

  try {
    await Promise.race([waitForReady(url), exited]);
    // The banner can trail the port opening by a moment.
    const deadline = Date.now() + 10000;
    while (!signInUrl && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    if (!signInUrl) throw new Error('Rundock server did not print its sign-in link');
  } catch (err) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    throw err;
  }

  // Ready. The `exited` promise is still live: if the child crashes mid-capture
  // (before stop() detaches the listener) it would reject with no awaiter. Mark
  // it handled; the crash then surfaces as the next Playwright call failing
  // against a dead server, with its own clear error.
  exited.catch(() => { /* handled */ });

  let askedAt = 0;
  async function takeSignInUrl() {
    const until = Date.now() + 15000;
    let asked = false;
    for (;;) {
      const fresh = links.find((l) => !given.has(l));
      if (fresh) { given.add(fresh); return fresh; }
      if (!asked) {
        // At most one request a second is answered.
        const gap = 1100 - (Date.now() - askedAt);
        if (gap > 0) await new Promise((r) => setTimeout(r, gap));
        child.stdin.write('\n');
        askedAt = Date.now();
        asked = true;
      }
      if (Date.now() > until) throw new Error('Rundock printed no fresh link for the next browser');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  return {
    url,
    // Open one of these, not `url`, in each new browser context: it lets the
    // context in (lib/auth). A function, because each link is good once.
    // Never log what it returns.
    signInUrl: takeSignInUrl,
    port,
    stop() {
      return new Promise((resolve) => {
        if (child.exitCode != null || child.signalCode) { resolve(); return; }
        child.removeAllListeners('exit');
        child.on('exit', () => resolve());
        child.kill('SIGTERM');
        // Hard stop if it lingers.
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 3000);
      });
    },
  };
}

// Boots the server, retrying on nearby ports if the preferred one is busy (a
// stray process or a concurrent run should not fail the whole pipeline).
// `workspace` and `home` come from the generator. `env` adds to the child's
// environment (look-view puts the stub runtime first on PATH with it).
export async function startRundock({ workspace, home, port = CAPTURE_PORT, quiet = true, env = {} } = {}) {
  const candidates = [port, port + 1, port + 2, port + 5, port + 11];
  let lastErr;
  for (const p of candidates) {
    try {
      return await spawnAttempt({ workspace, home, port: p, quiet, env });
    } catch (err) {
      lastErr = err;
      // Retry only on a bind/startup failure; rethrow anything unexpected.
      if (!/exited early|EADDRINUSE|did not become ready/i.test(String(err && err.message))) throw err;
    }
  }
  throw new Error(`Rundock server could not start on any candidate port (${candidates.join(', ')}). Last error:\n${lastErr && lastErr.message}`);
}
