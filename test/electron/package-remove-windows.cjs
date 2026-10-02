'use strict';
// A package fetched by the desktop app's own runtime is removed completely.
//
// The defect this exists for was the runtime's, not plain Node's: under the
// desktop app on Windows, removing a fetched package's `.git` failed with
// EPERM, because git writes its pack files read-only and that runtime did not
// clear the read-only attribute before deleting. So this runs the real
// acquireWithGit, against a small local repository fetched over file://, under
// the pinned Electron with ELECTRON_RUN_AS_NODE, and checks that the snapshot
// arrives without its `.git` and that discarding it leaves nothing behind.
//
//   node test/electron/package-remove-windows.cjs
//
// Run with plain Node, it relaunches itself under the repository's Electron.
// It writes only under the system temporary directory and reaches no network.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync, spawnSync } = require('node:child_process');

if (!process.versions.electron) {
  const electron = require('electron');
  const r = spawnSync(electron, [__filename], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  process.exit(r.status === null ? 1 : r.status);
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}
// The test's own clean-up of its source repository, kept independent of the
// code under test.
function scrub(dir) {
  const walk = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { return; }
    if (st.isSymbolicLink()) return;
    try { fs.chmodSync(p, st.isDirectory() ? 0o700 : 0o600); } catch (e) { /* best effort */ }
    if (st.isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n));
  };
  walk(dir);
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (e) { /* best effort */ }
}

console.log(`Electron ${process.versions.electron}, Node ${process.versions.node}, ${process.platform}`);
const source = fs.mkdtempSync(path.join(os.tmpdir(), 'package-remove-source-'));
const git = (args) => execFileSync('git', args, { cwd: source, stdio: ['ignore', 'pipe', 'pipe'] });
git(['init', '--quiet']);
git(['config', 'user.email', 'test@example.com']);
git(['config', 'user.name', 'Test']);
fs.writeFileSync(path.join(source, 'rundock.json'), '{}\n');
fs.mkdirSync(path.join(source, 'agents'));
fs.writeFileSync(path.join(source, 'agents', 'helper.md'), '# helper\n');
git(['add', '.']);
git(['commit', '--quiet', '-m', 'one']);
git(['tag', 'v1.0.0']);

const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('rundock-ext-')));
const { acquireWithGit, discardAcquisition } = require('../../lib/packages/extension-source.js');
let snapshot;
try {
  snapshot = acquireWithGit({ url: pathToFileURL(source).href, reference: 'v1.0.0' });
} catch (e) {
  scrub(source);
  fail(`acquireWithGit threw: ${e && e.message ? e.message : e}`);
}
try {
  if (!fs.existsSync(path.join(snapshot, 'agents', 'helper.md'))) fail('the fetched files are not in the snapshot');
  if (fs.existsSync(path.join(snapshot, '.git'))) fail('the snapshot still has its .git');
  try {
    discardAcquisition(snapshot);
  } catch (e) {
    fail(`discarding the snapshot threw: ${e && e.message ? e.message : e}`);
  }
  if (fs.existsSync(snapshot)) fail(`the snapshot folder is still there: ${snapshot}`);
  const leaked = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('rundock-ext-') && !before.has(n));
  if (leaked.length) fail(`temporary folders left behind: ${leaked.join(', ')}`);
} finally {
  scrub(source);
}
console.log('OK: the package was fetched, its .git removed, and the snapshot discarded with nothing left behind');
