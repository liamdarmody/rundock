#!/usr/bin/env node

/**
 * Release script for Rundock.
 *
 * Chains the full release pipeline:
 *   1. Build the .app and .dmg via electron-builder
 *   2. Submit for Apple notarisation via xcrun notarytool
 *   3. Poll for notarisation completion (every 30s)
 *   4. Staple the notarisation ticket
 *   5. Log the final .dmg path
 *
 * Usage:
 *   node scripts/release.js <version>
 *   npm run release -- <version>
 *
 * Example:
 *   npm run release -- 0.8.1
 *
 * Requires .env with: APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER,
 * CSC_LINK, CSC_KEY_PASSWORD, APPLE_TEAM_ID
 */

const { execFileSync, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const APP_PATH = '/tmp/rundock-dist/mac-arm64/Rundock.app';
const DMG_PATH = '/tmp/rundock-dist/Rundock.dmg';
const POLL_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(step, msg) {
  console.log(`[release:${step}] ${msg}`);
}

function fail(step, msg) {
  console.error(`[release:${step}] ERROR: ${msg}`);
  process.exit(1);
}

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
    log('env', 'Loaded .env');
  } else {
    fail('env', 'No .env file found. Cannot sign or notarise without credentials.');
  }

  const required = [
    'APPLE_API_KEY',
    'APPLE_API_KEY_ID',
    'APPLE_API_ISSUER',
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
    'APPLE_TEAM_ID',
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    fail('env', `Missing required env vars: ${missing.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function setVersion() {
  const version = process.argv[2];

  if (!version) {
    fail('version', 'Usage: npm run release -- <version> (e.g. npm run release -- 0.8.1)');
  }

  const semverRe = /^\d+\.\d+\.\d+$/;
  if (!semverRe.test(version)) {
    fail('version', `Invalid version "${version}". Expected semver format: MAJOR.MINOR.PATCH (e.g. 0.8.1)`);
  }

  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  log('version', `Releasing version ${version}`);
}

function build() {
  log('build', 'Running electron-builder --mac');
  try {
    execFileSync(
      path.join(ROOT, 'node_modules', '.bin', 'electron-builder'),
      ['--mac', '--publish', 'never'],
      { stdio: 'inherit', cwd: ROOT }
    );
  } catch (err) {
    fail('build', `electron-builder exited with code ${err.status || 1}`);
  }

  if (!fs.existsSync(APP_PATH)) {
    fail('build', `Expected .app not found at ${APP_PATH}`);
  }
  log('build', `Built ${APP_PATH}`);
}

function submitNotarisation() {
  log('notarise', 'Submitting for Apple notarisation...');

  // Zip the .app for submission
  const zipPath = '/tmp/rundock-dist/Rundock-notarize.zip';
  try {
    execSync(
      `ditto -c -k --keepParent "${APP_PATH}" "${zipPath}"`,
      { stdio: 'inherit' }
    );
  } catch (err) {
    fail('notarise', 'Failed to zip .app for notarisation');
  }

  let output;
  try {
    output = execFileSync('xcrun', [
      'notarytool', 'submit', zipPath,
      '--key', process.env.APPLE_API_KEY,
      '--key-id', process.env.APPLE_API_KEY_ID,
      '--issuer', process.env.APPLE_API_ISSUER,
      '--output-format', 'json',
    ], { cwd: ROOT, encoding: 'utf8' });
  } catch (err) {
    fail('notarise', `notarytool submit failed: ${err.stderr || err.message}`);
  }

  let result;
  try {
    result = JSON.parse(output);
  } catch (err) {
    fail('notarise', `Could not parse notarytool output: ${output}`);
  }

  const submissionId = result.id;
  if (!submissionId) {
    fail('notarise', `No submission ID in response: ${output}`);
  }

  log('notarise', `Submission ID: ${submissionId}`);

  // Clean up the zip
  try { fs.unlinkSync(zipPath); } catch (_) {}

  return submissionId;
}

function pollNotarisation(submissionId) {
  log('notarise', 'Polling for notarisation result...');

  while (true) {
    let output;
    try {
      output = execFileSync('xcrun', [
        'notarytool', 'info', submissionId,
        '--key', process.env.APPLE_API_KEY,
        '--key-id', process.env.APPLE_API_KEY_ID,
        '--issuer', process.env.APPLE_API_ISSUER,
        '--output-format', 'json',
      ], { cwd: ROOT, encoding: 'utf8' });
    } catch (err) {
      fail('notarise', `notarytool info failed: ${err.stderr || err.message}`);
    }

    let result;
    try {
      result = JSON.parse(output);
    } catch (err) {
      fail('notarise', `Could not parse notarytool info output: ${output}`);
    }

    const status = result.status;
    log('notarise', `Status: ${status}`);

    if (status === 'Accepted') {
      log('notarise', 'Notarisation accepted');
      return;
    }

    if (status === 'Invalid' || status === 'Rejected') {
      fail('notarise', `Notarisation ${status}. Check Apple's log for details.`);
    }

    // Still in progress, wait and retry
    log('notarise', `Waiting ${POLL_INTERVAL_MS / 1000}s before next check...`);
    execFileSync('sleep', [String(POLL_INTERVAL_MS / 1000)]);
  }
}

function staple() {
  log('staple', `Stapling notarisation ticket to ${APP_PATH}`);
  try {
    execSync(`xcrun stapler staple "${APP_PATH}"`, { stdio: 'inherit' });
  } catch (err) {
    fail('staple', 'xcrun stapler staple failed');
  }
  log('staple', 'Stapled successfully');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

setVersion();
loadEnv();
build();
const submissionId = submitNotarisation();
pollNotarisation(submissionId);
staple();

console.log('');
log('done', `Release complete: ${DMG_PATH}`);
