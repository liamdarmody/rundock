#!/usr/bin/env node
// Build one throwaway version into the local update feed.
//
// Build two consecutive versions and you can exercise the whole update cycle
// against scripts/update-harness/serve.mjs without publishing anything:
//
//   node scripts/update-harness/build.mjs --version 0.11.5-test.1
//   node scripts/update-harness/build.mjs --version 0.11.5-test.2
//   node scripts/update-harness/serve.mjs
//
// Install the .1 artefact, point it at the feed, and it should find .2.
// allowDowngrade puts you back on .1 so the cycle repeats in minutes.
//
// This temporarily rewrites the version in package.json, because that is what
// electron-builder stamps into the artefact and the manifest. It is restored
// on every exit path including a crash or Ctrl-C: losing the real version
// number in a working tree would be a far worse bug than the one being fixed.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const PKG = join(ROOT, 'package.json');
const FEED = join(HERE, 'feed');
const DIST = join(ROOT, 'dist');

function parseArgs(argv) {
  const out = { version: null, platform: process.platform === 'win32' ? 'win' : 'mac', clean: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--version' && argv[i + 1]) out.version = argv[++i];
    else if (argv[i] === '--platform' && argv[i + 1]) out.platform = argv[++i];
    else if (argv[i] === '--out' && argv[i + 1]) out.out = argv[++i];
    else if (argv[i] === '--clean') out.clean = true;
  }
  return out;
}

// The artefacts electron-updater needs in the feed. Everything else that
// electron-builder emits (the .dmg, the unpacked tree) is noise here: the
// macOS updater downloads the .zip and reads the manifest.
const WANTED = {
  mac: (f) => f === 'latest-mac.yml' || (f.endsWith('.zip') || f.endsWith('.zip.blockmap')),
  win: (f) => f === 'latest.yml' || (f.endsWith('.exe') || f.endsWith('.exe.blockmap')),
};

const { version, platform, clean, out } = parseArgs(process.argv.slice(2));

// --out redirects electron-builder's output. Needed when the repo lives in a
// folder managed by a sync service (iCloud Drive, Dropbox, OneDrive): those
// re-stamp Finder and file-provider metadata onto freshly written bundles
// while the build is still running, and codesign then rejects the app with
// "resource fork, Finder information, or similar detritus not allowed".
// Building into an unmanaged location (for example under /tmp) avoids the
// race entirely.
const outDir = out ? resolve(out) : DIST;

if (clean) {
  if (existsSync(FEED)) rmSync(FEED, { recursive: true, force: true });
  console.log(`Removed ${FEED}`);
  process.exit(0);
}

if (!version) {
  console.error('Usage: node scripts/update-harness/build.mjs --version <version> [--platform mac|win] [--out <dir>]');
  console.error('       node scripts/update-harness/build.mjs --clean');
  process.exit(1);
}
if (!WANTED[platform]) {
  console.error(`Unknown platform "${platform}". Use mac or win.`);
  process.exit(1);
}

const original = readFileSync(PKG, 'utf8');
let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  writeFileSync(PKG, original);
  console.log('Restored the real version in package.json');
}
// Every exit path. A dev tool that can strand the working tree on a fake
// version number is not a tool anyone should trust.
process.on('exit', restore);
process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('SIGTERM', () => { restore(); process.exit(143); });
process.on('uncaughtException', (err) => { restore(); console.error(err); process.exit(1); });

const pkg = JSON.parse(original);
console.log(`Building ${pkg.name} ${version} (real version is ${pkg.version}, restored afterwards)`);
pkg.version = version;
writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');

// --publish never: the whole point is that nothing leaves this machine.
const target = platform === 'mac' ? '--mac' : '--win';
const builderArgs = ['electron-builder', target, '--publish', 'never'];
if (outDir !== DIST) builderArgs.push(`--config.directories.output=${outDir}`);
execFileSync('npx', builderArgs, {
  cwd: ROOT,
  stdio: 'inherit',
});

mkdirSync(FEED, { recursive: true });
const keep = WANTED[platform];
let copied = 0;
for (const f of readdirSync(outDir)) {
  if (!keep(f)) continue;
  copyFileSync(join(outDir, f), join(FEED, f));
  console.log(`  -> feed/${f}`);
  copied++;
}

if (copied === 0) {
  console.error(`\nNothing matched in ${outDir}. Did the build actually produce artefacts?`);
  process.exit(1);
}

console.log(`\nCopied ${copied} file(s) into ${FEED}`);
console.log('Build the next version, then: node scripts/update-harness/serve.mjs');
