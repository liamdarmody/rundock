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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(REPO_ROOT, 'server.js');

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
async function spawnAttempt({ workspace, home, port, quiet }) {
  const bootScript = `require(${JSON.stringify(SERVER)}).startServer({ port: ${port} })`;
  const child = spawn(process.execPath, ['-e', bootScript], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,      // Windows equivalent
      WORKSPACE: workspace,
      RUNDOCK_ELECTRON: '1',  // keep the recent-workspaces file inside the fake home
    },
    stdio: quiet ? ['ignore', 'ignore', 'pipe'] : 'inherit',
  });

  let stderr = '';
  if (quiet && child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });

  const url = `http://localhost:${port}`;
  const exited = new Promise((_, reject) => {
    child.on('exit', (code) => reject(new Error(`Rundock server exited early (code ${code}).\n${stderr}`)));
  });

  try {
    await Promise.race([waitForReady(url), exited]);
  } catch (err) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    throw err;
  }

  // Ready. The `exited` promise is still live: if the child crashes mid-capture
  // (before stop() detaches the listener) it would reject with no awaiter. Mark
  // it handled; the crash then surfaces as the next Playwright call failing
  // against a dead server, with its own clear error.
  exited.catch(() => { /* handled */ });

  return {
    url,
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
// `workspace` and `home` come from the generator.
export async function startRundock({ workspace, home, port = CAPTURE_PORT, quiet = true } = {}) {
  const candidates = [port, port + 1, port + 2, port + 5, port + 11];
  let lastErr;
  for (const p of candidates) {
    try {
      return await spawnAttempt({ workspace, home, port: p, quiet });
    } catch (err) {
      lastErr = err;
      // Retry only on a bind/startup failure; rethrow anything unexpected.
      if (!/exited early|EADDRINUSE|did not become ready/i.test(String(err && err.message))) throw err;
    }
  }
  throw new Error(`Rundock server could not start on any candidate port (${candidates.join(', ')}). Last error:\n${lastErr && lastErr.message}`);
}
