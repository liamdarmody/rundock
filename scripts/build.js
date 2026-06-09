#!/usr/bin/env node

/**
 * Build script for Rundock.
 *
 * Loads .env (signing credentials, notarisation keys) into the environment
 * before spawning electron-builder. This keeps secrets out of npm scripts
 * and shell history.
 *
 * Usage:
 *   node scripts/build.js            # build .dmg + .zip (no publish)
 *   node scripts/build.js --publish always  # build and publish to GitHub
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Load .env from repo root
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
  console.log('[build] Loaded .env');
} else {
  console.warn('[build] No .env file found. Signing and notarisation will be skipped.');
}

function hasAppleCreds() {
  return !!(process.env.CSC_LINK && process.env.APPLE_API_KEY);
}

const explicitMac = process.argv.includes('--mac');
const explicitWin = process.argv.includes('--win');
const platform = explicitMac ? '--mac' : explicitWin ? '--win' : hasAppleCreds() ? '--mac' : '--win';
const extraArgs = process.argv.slice(2).filter(a => a !== '--mac' && a !== '--win');
const args = [platform, ...extraArgs];

console.log(`[build] Running: electron-builder ${args.join(' ')}`);

try {
  execFileSync(
    path.join(__dirname, '..', 'node_modules', '.bin', 'electron-builder'),
    args,
    { stdio: 'inherit', cwd: path.join(__dirname, '..'), shell: true }
  );
} catch (err) {
  process.exit(err.status || 1);
}
