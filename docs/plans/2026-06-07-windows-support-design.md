# Windows Support Design

**Date:** 2026-06-07  
**Branch:** emdash/windows-conversion-laa3i

## Goal

Add Windows distribution to Rundock without changing the existing Mac build pipeline. Windows builds default when Apple credentials are absent; Mac builds run when credentials are present (or via explicit flag).

## Distribution format

NSIS one-click installer (`.exe`), x64 only. No Authenticode code signing initially — users will see a SmartScreen warning on first run, acceptable for early distribution.

## Release pipeline

- **Mac**: unchanged — `node scripts/release.js <version>` runs locally on a Mac with `.env` credentials, builds DMG, notarizes, staples, publishes the GitHub Release.
- **Windows**: GitHub Actions workflow triggered by `release: types: [published]`. Runs on `windows-latest`, builds the NSIS `.exe`, uploads artifacts to the existing release via `gh release upload`.

---

## Changes

### 1. `package.json`

Add `win` and `nsis` sections to the `build` config. Change `directories.output` from the Unix-only `/tmp/rundock-dist` to the relative path `dist-output` so it works on both platforms.

```json
"directories": { "output": "dist-output" },
"win": {
  "icon": "electron/build/icon.ico",
  "target": [{ "target": "nsis", "arch": ["x64"] }]
},
"nsis": {
  "oneClick": true,
  "perMachine": false,
  "createDesktopShortcut": true,
  "createStartMenuShortcut": true
}
```

### 2. `scripts/build.js`

Add a `hasAppleCreds()` helper that loads `.env` and checks for `CSC_LINK` and `APPLE_API_KEY`. Default to `--win` when absent; `--mac` when present. Honor explicit `--mac` / `--win` CLI flags as overrides.

```
node scripts/build.js           # --win (no creds) or --mac (creds found)
node scripts/build.js --mac     # force Mac
node scripts/build.js --win     # force Windows
```

### 3. `scripts/release.js`

Three targeted changes:

1. **Platform detection** — add `hasAppleCreds()`. Mac path: existing notarize/staple/xcrun chain. Windows path: skip all Apple-specific steps.
2. **`DIST_DIR`** — change from `/tmp/rundock-dist` to `path.join(ROOT, 'dist-output')` to match the updated `package.json`.
3. **`publishRelease()`** — make artifact filenames conditional:
   - Mac: `Rundock-{version}-arm64.dmg`, `.blockmap`, `-arm64-mac.zip`, `.blockmap`, `latest-mac.yml`
   - Windows: `Rundock Setup {version}.exe`, `.blockmap`, `latest.yml`
4. **`updateSiteDownloadUrls()`** — remains Mac-only (already conditional on site repo existing).
5. **`APP_PATH`** — hardcoded to `/tmp/rundock-dist/mac-arm64/Rundock.app`; update to use `DIST_DIR` and make the `.app` subpath Mac-only.

### 4. `electron/main.js`

Two small platform conditionals:

1. **Wizard `titleBarStyle`** — `'hiddenInset'` is macOS-only and renders incorrectly on Windows:
   ```js
   titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default'
   ```

2. **App menu** — The leading "Rundock" menu item (About, Check for Updates, Quit) is a macOS convention. On Windows, restructure to put About and Check for Updates in a "Help" menu, with Quit under "File":
   - macOS: current layout unchanged
   - Windows: File (Quit) / Edit / View / Help (About, Check for Updates)

### 5. `.github/workflows/release-windows.yml` (new file)

Triggered by `release: types: [published]`. Single job on `windows-latest`:

```yaml
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
      - run: node scripts/build.js --win
      - run: gh release upload ${{ github.event.release.tag_name }} dist-output/*.exe dist-output/*.blockmap dist-output/latest.yml --clobber
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## Files changed

| File | Change |
|---|---|
| `package.json` | Add `win`/`nsis` build config, fix `directories.output` |
| `scripts/build.js` | Add `hasAppleCreds()`, default to `--win` |
| `scripts/release.js` | Platform detection, fix `DIST_DIR`, conditional artifacts |
| `electron/main.js` | `titleBarStyle` conditional, platform-aware app menu |
| `.github/workflows/release-windows.yml` | New CI workflow |

## Out of scope

- Authenticode code signing (can be added later by setting `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` in `.env`)
- Retiring `scripts/install-windows-source.ps1` (can be done after the installer ships)
- Changing how the Mac release pipeline runs
