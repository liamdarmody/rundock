# Windows Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Add Windows (NSIS installer) support to Rundock, defaulting to Windows builds when Apple credentials are absent and preserving the existing Mac pipeline when they are present.

**Architecture:** Five targeted changes — build config, two build scripts, one Electron runtime file, and a new CI workflow. No unit tests exist for build scripts; verification is done by running the scripts and inspecting output. Electron runtime changes are verified by launching `npm run electron` on Windows.

**Tech Stack:** electron-builder (NSIS target), GitHub Actions (windows-latest runner), Node.js, Electron 35.

---

### Task 1: `package.json` — add win/nsis build config and fix output path

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`

**Step 1: Add `dist-output` to `.gitignore`**

Append one line to `.gitignore`:

```
dist-output/
```

**Step 2: Update `package.json` build config**

Make three changes to the `"build"` section:

1. Change `directories.output` from `/tmp/rundock-dist` to `dist-output`
2. Add `"win"` section after `"dmg"`
3. Add `"nsis"` section after `"win"`

The updated `"build"` block (only changed/added lines shown):

```json
"directories": {
  "output": "dist-output"
},
```

```json
"win": {
  "icon": "electron/build/icon.ico",
  "target": [{ "target": "nsis", "arch": ["x64"] }]
},
"nsis": {
  "oneClick": true,
  "perMachine": false,
  "artifactName": "Rundock-${version}-Setup.exe",
  "createDesktopShortcut": true,
  "createStartMenuShortcut": true
},
```

The `artifactName` avoids a space in the filename (`Rundock Setup 0.8.11.exe` → `Rundock-0.8.11-Setup.exe`), which keeps glob patterns simple in CI.

**Step 3: Verify JSON is valid**

```powershell
node -e "const p = require('./package.json'); console.log('win target:', p.build.win.target[0].target); console.log('output:', p.build.directories.output)"
```

Expected output:
```
win target: nsis
output: dist-output
```

**Step 4: Commit**

```bash
git add package.json .gitignore
git commit -m "build: add windows NSIS target and fix output path"
```

---

### Task 2: `scripts/build.js` — add `hasAppleCreds()`, default to `--win`

**Files:**
- Modify: `scripts/build.js`

**Step 1: Replace the current platform arg with credential-aware detection**

Current code at the bottom of `scripts/build.js` (around line 29):

```js
// Forward all CLI args to electron-builder
const args = ['--mac', ...process.argv.slice(2)];
```

Replace with:

```js
function hasAppleCreds() {
  return !!(process.env.CSC_LINK && process.env.APPLE_API_KEY);
}

const explicitMac = process.argv.includes('--mac');
const explicitWin = process.argv.includes('--win');
const platform = explicitMac ? '--mac' : explicitWin ? '--win' : hasAppleCreds() ? '--mac' : '--win';
const extraArgs = process.argv.slice(2).filter(a => a !== '--mac' && a !== '--win');
const args = [platform, ...extraArgs];
```

Note: `.env` is already loaded earlier in the file via `require('dotenv').config()`, so `process.env.CSC_LINK` is populated before `hasAppleCreds()` is called.

**Step 2: Update the log line to show the resolved platform**

Current line:
```js
console.log(`[build] Running: electron-builder ${args.join(' ')}`);
```

This already uses `args`, so it will automatically reflect the resolved platform — no change needed.

**Step 3: Verify credential detection logic**

```powershell
node -e "
const path = require('path');
const fs = require('fs');
// Simulate no creds
delete process.env.CSC_LINK;
delete process.env.APPLE_API_KEY;
function hasAppleCreds() { return !!(process.env.CSC_LINK && process.env.APPLE_API_KEY); }
const platform = hasAppleCreds() ? '--mac' : '--win';
console.log('No creds, platform:', platform);
// Simulate creds present
process.env.CSC_LINK = 'fake';
process.env.APPLE_API_KEY = 'fake';
console.log('With creds, platform:', hasAppleCreds() ? '--mac' : '--win');
"
```

Expected output:
```
No creds, platform: --win
With creds, platform: --mac
```

**Step 4: Commit**

```bash
git add scripts/build.js
git commit -m "build: default to --win when Apple credentials absent"
```

---

### Task 3: `scripts/release.js` — platform detection, fix DIST_DIR, conditional artifacts

**Files:**
- Modify: `scripts/release.js`

This task has five sub-changes. Make them in order.

**Step 1: Fix `DIST_DIR` and `APP_PATH` constants (lines 34-35)**

Current:
```js
const APP_PATH = '/tmp/rundock-dist/mac-arm64/Rundock.app';
const DIST_DIR = '/tmp/rundock-dist';
```

Replace with:
```js
const DIST_DIR = path.join(ROOT, 'dist-output');
const APP_PATH = path.join(DIST_DIR, 'mac-arm64', 'Rundock.app');
```

**Step 2: Add `hasAppleCreds()` helper after the `fail()` helper function**

Find the `fail()` function (around line 47):
```js
function fail(step, msg) {
  console.error(`[release:${step}] ERROR: ${msg}`);
  process.exit(1);
}
```

Add immediately after it:
```js
function hasAppleCreds() {
  return !!(process.env.CSC_LINK && process.env.APPLE_API_KEY);
}
```

**Step 3: Update `loadEnv()` to not fail when `.env` is missing (Windows case)**

Current `loadEnv()`:
```js
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
```

Replace with:
```js
function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
    log('env', 'Loaded .env');
  } else {
    log('env', 'No .env file found, proceeding without signing credentials.');
  }

  if (hasAppleCreds()) {
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
}
```

**Step 4: Update `build()` to be platform-aware**

Current `build()`:
```js
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
```

Replace with:
```js
function build() {
  const platform = hasAppleCreds() ? '--mac' : '--win';
  log('build', `Running electron-builder ${platform}`);
  try {
    execFileSync(
      path.join(ROOT, 'node_modules', '.bin', 'electron-builder'),
      [platform, '--publish', 'never'],
      { stdio: 'inherit', cwd: ROOT }
    );
  } catch (err) {
    fail('build', `electron-builder exited with code ${err.status || 1}`);
  }

  if (hasAppleCreds()) {
    if (!fs.existsSync(APP_PATH)) {
      fail('build', `Expected .app not found at ${APP_PATH}`);
    }
    log('build', `Built ${APP_PATH}`);
  } else {
    log('build', `Built Windows artifacts in ${DIST_DIR}`);
  }
}
```

**Step 5: Update `publishRelease()` artifact filenames to be platform-conditional**

Current artifact block at the top of `publishRelease()` (around lines 373-379):
```js
const dmg = path.join(DIST_DIR, `Rundock-${version}-arm64.dmg`);
const dmgBlockmap = `${dmg}.blockmap`;
const zip = path.join(DIST_DIR, `Rundock-${version}-arm64-mac.zip`);
const zipBlockmap = `${zip}.blockmap`;
const feed = path.join(DIST_DIR, 'latest-mac.yml');
const assets = [dmg, dmgBlockmap, zip, zipBlockmap, feed];
```

Replace with:
```js
let assets;
if (hasAppleCreds()) {
  const dmg = path.join(DIST_DIR, `Rundock-${version}-arm64.dmg`);
  const zip = path.join(DIST_DIR, `Rundock-${version}-arm64-mac.zip`);
  const feed = path.join(DIST_DIR, 'latest-mac.yml');
  assets = [dmg, `${dmg}.blockmap`, zip, `${zip}.blockmap`, feed];
} else {
  const setup = path.join(DIST_DIR, `Rundock-${version}-Setup.exe`);
  const feed = path.join(DIST_DIR, 'latest.yml');
  assets = [setup, `${setup}.blockmap`, feed];
}
```

**Step 6: Wrap notarize/staple/site steps at the bottom of the file**

Current bottom of file:
```js
setVersion();
loadEnv();
promoteUnreleasedChangelog(process.argv[2]);
commitAndPush(process.argv[2]);
build();
const submissionId = submitNotarisation();
pollNotarisation(submissionId);
staple();

const version = process.argv[2];
publishRelease(version);
updateSiteDownloadUrls(version);
```

Replace with:
```js
setVersion();
loadEnv();
promoteUnreleasedChangelog(process.argv[2]);
commitAndPush(process.argv[2]);
build();

if (hasAppleCreds()) {
  const submissionId = submitNotarisation();
  pollNotarisation(submissionId);
  staple();
}

const version = process.argv[2];
publishRelease(version);

if (hasAppleCreds()) {
  updateSiteDownloadUrls(version);
}
```

**Step 7: Verify the script parses without errors**

```powershell
node --check scripts/release.js
```

Expected: no output (syntax is valid).

**Step 8: Commit**

```bash
git add scripts/release.js
git commit -m "build: make release.js platform-aware, default to windows when no Apple creds"
```

---

### Task 4: `electron/main.js` — Windows UI conditionals

**Files:**
- Modify: `electron/main.js`

**Step 1: Fix `titleBarStyle` in the wizard window (line 109)**

Current:
```js
titleBarStyle: 'hiddenInset',
```

Replace with:
```js
titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
```

**Step 2: Replace `setupMenu()` with a platform-aware version (lines 157-204)**

Replace the entire `setupMenu()` function body with:

```js
function setupMenu() {
  const checkForUpdatesItem = { label: 'Check for Updates', click: () => {
    if (!autoUpdater) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        message: 'Auto-update is not available in this build.',
        buttons: ['OK'],
      });
      return;
    }
    isCheckingManually = true;
    autoUpdater.checkForUpdates().catch((err) => {
      isCheckingManually = false;
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        message: 'Could not check for updates',
        detail: err && err.message ? err.message : String(err),
        buttons: ['OK'],
      });
    });
  } };

  const editMenu = {
    label: 'Edit',
    submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ],
  };

  const viewMenu = {
    label: 'View',
    submenu: [
      { role: 'reload' }, { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
    ],
  };

  const template = process.platform === 'darwin'
    ? [
        {
          label: 'Rundock',
          submenu: [
            { label: 'About Rundock', role: 'about' },
            checkForUpdatesItem,
            { type: 'separator' },
            { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => { app.quit(); } },
          ],
        },
        editMenu,
        viewMenu,
      ]
    : [
        {
          label: 'File',
          submenu: [
            { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => { app.quit(); } },
          ],
        },
        editMenu,
        viewMenu,
        {
          label: 'Help',
          submenu: [
            { label: 'About Rundock', role: 'about' },
            checkForUpdatesItem,
          ],
        },
      ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
```

**Step 3: Verify the app launches**

```powershell
npm run electron
```

Expected:
- App window opens
- Menu bar shows: File / Edit / View / Help (on Windows)
- Help menu contains "About Rundock" and "Check for Updates"
- Closing and reopening does not crash

If Claude Code is not installed, the wizard will appear — verify it opens without a blank/broken title bar area.

**Step 4: Commit**

```bash
git add electron/main.js
git commit -m "feat(electron): platform-aware titleBarStyle and app menu for Windows"
```

---

### Task 5: `.github/workflows/release-windows.yml` — CI workflow

**Files:**
- Create: `.github/workflows/release-windows.yml`

**Step 1: Create the workflow file**

```yaml
name: Release Windows

on:
  release:
    types: [published]

jobs:
  build-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.release.tag_name }}

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npm ci

      - name: Build Windows installer
        run: node scripts/build.js --win

      - name: Upload artifacts to release
        shell: bash
        run: |
          gh release upload "${{ github.event.release.tag_name }}" \
            dist-output/*.exe \
            dist-output/*.blockmap \
            dist-output/latest.yml \
            --clobber
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Note: `shell: bash` on the upload step is required because PowerShell does not expand glob patterns (`*.exe`) the way bash does. GitHub Actions Windows runners have Git Bash available.

**Step 2: Verify the workflow file is valid YAML**

```powershell
node -e "
const fs = require('fs');
const content = fs.readFileSync('.github/workflows/release-windows.yml', 'utf8');
console.log('File size:', content.length, 'bytes');
console.log('Trigger:', content.includes('release:') ? 'OK' : 'MISSING');
console.log('Windows runner:', content.includes('windows-latest') ? 'OK' : 'MISSING');
console.log('GH_TOKEN:', content.includes('GITHUB_TOKEN') ? 'OK' : 'MISSING');
"
```

Expected output:
```
File size: <number> bytes
Trigger: OK
Windows runner: OK
GH_TOKEN: OK
```

**Step 3: Commit**

```bash
git add .github/workflows/release-windows.yml
git commit -m "ci: add Windows release workflow triggered on release published"
```

---

## How to release after these changes

**Windows release (this fork — no Apple creds):**
```powershell
node scripts/release.js 0.8.12
```
This builds the NSIS `.exe` locally (since no `.env`/Apple creds), creates the GitHub Release, uploads the Windows artifacts. The CI workflow then fires and re-uploads (idempotent via `--clobber`).

Wait — actually on this fork, `release.js` creates the GitHub Release with the Windows artifacts directly. The CI workflow then fires from the `release: published` event, rebuilds, and uploads again via `--clobber`. This is fine — the CI upload is idempotent.

**Mac release (original repo, with Apple creds in `.env`):**
```bash
node scripts/release.js 0.8.12
```
Builds DMG, notarizes, staples, creates GitHub Release with Mac artifacts. The CI Windows workflow fires automatically after the release is published and adds the NSIS `.exe` to the same release.
