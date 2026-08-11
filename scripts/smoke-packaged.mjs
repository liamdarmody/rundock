#!/usr/bin/env node
// Boot the PACKAGED app once and require it to come up cleanly.
//
// The unit and e2e suites run against source. Nothing they prove survives a
// packaging mistake: a module missing from the build whitelist, a broken
// main entry, a dependency that did not make it into the asar. One shipped
// release died exactly that way, on its first require, after install, where
// no test had ever looked.
//
// This script builds an unpacked app (electron-builder --dir), launches the
// real packaged binary with RUNDOCK_SMOKE_TEST=1, and waits for the boot
// marker that electron/main.js prints after modules load, the embedded
// server starts, and the window is created. No marker, or a non-zero exit,
// fails the run. The release workflow runs this before anything publishes.
//
// Usage:
//   node scripts/smoke-packaged.mjs [--skip-build]

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
// The throwaway build lands OUTSIDE the repo tree on purpose: a repo under a
// file-provider-synced folder (iCloud Documents) gets extended attributes
// re-applied by the sync daemon faster than afterPack can strip them, and
// codesign then fails on "detritus not allowed". A temp path is out of the
// provider's reach, and this build is disposable by definition.
const DIST = join(tmpdir(), 'rundock-smoke-packaged');
const MARKER = '[Electron] Smoke test OK';
const BOOT_TIMEOUT_MS = 120000;

const skipBuild = process.argv.includes('--skip-build');

function fail(msg) {
  console.error(`smoke-packaged: FAIL: ${msg}`);
  process.exit(1);
}

// Locate the packaged binary for the current platform under dist/.
function findBinary() {
  if (process.platform === 'darwin') {
    const dirs = existsSync(DIST) ? readdirSync(DIST).filter((d) => d.startsWith('mac')) : [];
    for (const d of dirs) {
      const bin = join(DIST, d, 'Rundock.app', 'Contents', 'MacOS', 'Rundock');
      if (existsSync(bin)) return bin;
    }
    return null;
  }
  if (process.platform === 'win32') {
    const bin = join(DIST, 'win-unpacked', 'Rundock.exe');
    return existsSync(bin) ? bin : null;
  }
  const bin = join(DIST, 'linux-unpacked', 'rundock');
  return existsSync(bin) ? bin : null;
}

if (!skipBuild) {
  const target = process.platform === 'win32' ? '--win' : process.platform === 'darwin' ? '--mac' : '--linux';
  console.log(`smoke-packaged: building unpacked app (electron-builder ${target} --dir, unsigned)`);
  // Signing is the publish jobs' concern, explicitly: on a dev Mac with a
  // Developer ID cert in the keychain, electron-builder's identity
  // auto-discovery would try to codesign this throwaway build (and fails on
  // local xattr detritus). This gate answers one question only: does the app
  // that packaging produces actually start?
  execFileSync('npx', ['electron-builder', target, '--dir', `-c.directories.output=${DIST}`], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  });
}

const bin = findBinary();
if (!bin) fail(`no packaged binary found under ${DIST}. Build first or drop --skip-build.`);

// Apple Silicon refuses to map a framework whose Team ID differs from the
// process. electron-builder's unsigned fallback signs the outer app ad-hoc
// but leaves the Electron Framework on its upstream signature, so the boot
// dies in dyld before main() runs. One deep ad-hoc pass makes every Mach-O
// in the throwaway bundle consistent; the real releases never hit this
// because CI deep-signs with the Developer ID.
if (process.platform === 'darwin') {
  const app = resolve(bin, '..', '..', '..');
  console.log('smoke-packaged: deep ad-hoc re-sign for a consistent throwaway bundle');
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
}

console.log(`smoke-packaged: launching ${bin}`);
const child = spawn(bin, [], {
  env: { ...process.env, RUNDOCK_SMOKE_TEST: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
let sawMarker = false;
const onData = (chunk) => {
  const text = chunk.toString();
  output += text;
  process.stdout.write(text);
  if (text.includes(MARKER)) sawMarker = true;
};
child.stdout.on('data', onData);
child.stderr.on('data', onData);

const timer = setTimeout(() => {
  // Kill only the child this script spawned, by its own PID.
  child.kill('SIGKILL');
  fail(`no "${MARKER}" within ${BOOT_TIMEOUT_MS / 1000}s. The packaged app did not finish booting.`);
}, BOOT_TIMEOUT_MS);

child.on('exit', (code) => {
  clearTimeout(timer);
  if (!sawMarker) {
    fail(`the app exited (code ${code}) without printing "${MARKER}". Boot did not complete.`);
  }
  if (code !== 0) {
    fail(`boot marker seen but the app exited with code ${code}.`);
  }
  console.log('smoke-packaged: PASS: packaged app booted, served, and shut down cleanly.');
});

child.on('error', (err) => {
  clearTimeout(timer);
  fail(`could not launch the packaged binary: ${err.message}`);
});
