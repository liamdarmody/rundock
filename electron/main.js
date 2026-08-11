const { app, BrowserWindow, Menu, nativeImage, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const buildContextMenuTemplate = require('./context-menu-template.js');
const { resolveUpdateFeed } = require('./update-feed.js');
const { decideUpdateUi } = require('./update-state.js');
const { reconcileOnLaunch, recordDownloaded } = require('./update-launches.js');

let autoUpdater;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch {
  console.warn('[Electron] electron-updater not available, auto-updates disabled');
  autoUpdater = null;
}

let mainWindow = null;
let serverPort = null;

// ===== SMOKE MODE ISOLATION =====

// The packaged-boot check (scripts/smoke-packaged.mjs) must not contend with
// a real running Rundock: the single-instance lock is keyed on userData, so
// without this a smoke run on a machine where Rundock is open loses the lock
// and exits 0 silently, before any boot code runs. A disposable userData,
// set BEFORE the lock is requested, gives smoke runs their own lock scope
// and keeps them from ever touching the user's real state.
if (process.env.RUNDOCK_SMOKE_TEST === '1') {
  app.setPath('userData', path.join(require('os').tmpdir(), 'rundock-smoke-userdata'));
}

// ===== SINGLE INSTANCE =====

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ===== CLAUDE CODE DETECTION =====

// Electron packaged apps don't inherit the user's full shell PATH.
// Ensure common Claude Code install locations are on PATH so the lookup works.
function ensurePath() {
  const home = require('os').homedir();
  const isWindows = process.platform === 'win32';
  const extraDirs = isWindows
    ? [
        // Anthropic's PowerShell installer drops claude.exe here.
        path.join(home, '.local', 'bin'),
        // WinGet shim location.
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : null,
        // npm global bin (Claude installed via `npm install -g`).
        process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null,
      ].filter(Boolean)
    : [
        path.join(home, '.local', 'bin'),
        path.join(home, '.claude', 'bin'),
        '/usr/local/bin',
        '/opt/homebrew/bin',
      ];
  const current = process.env.PATH || '';
  const segments = current.split(path.delimiter);
  const missing = extraDirs.filter(d => !segments.includes(d));
  if (missing.length) {
    process.env.PATH = missing.join(path.delimiter) + path.delimiter + current;
  }
}

function findClaude() {
  ensurePath();
  const isWindows = process.platform === 'win32';
  try {
    // Windows: where.exe returns one absolute path per line, possibly multiple
    // candidates when both .exe and .cmd shims are present. Prefer .exe so the
    // recommended PowerShell-installer path wins over an npm .cmd shim.
    // Unix: which returns a single absolute path.
    const lookupCmd = isWindows ? 'where.exe claude' : 'which claude';
    const output = execSync(lookupCmd, { timeout: 5000, encoding: 'utf-8' }).trim();
    if (!output) return null;
    let bin;
    if (isWindows) {
      const candidates = output.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const exe = candidates.find(c => c.toLowerCase().endsWith('.exe'));
      const cmd = candidates.find(c => c.toLowerCase().endsWith('.cmd'));
      bin = exe || cmd || candidates[0];
      if (!bin) return null;
    } else {
      bin = output;
    }
    // Sanity-check the resolved binary. Quote the path so a directory with
    // spaces (common on Windows) does not split the command.
    execSync(`"${bin}" --version`, { timeout: 10000 });
    return bin;
  } catch {
    return null;
  }
}

// Anthropic's Windows installer drops claude.exe in ~/.local/bin but does NOT
// add that directory to the user's PATH, so `claude` is unrecognised in the
// terminal even though it's installed. Rundock detects claude regardless (see
// ensurePath), but the user still needs `claude` on PATH to run the one-time
// sign-in. Since we know where claude lives, persist its directory onto the
// user's PATH so a freshly opened terminal recognises `claude`. Idempotent,
// Windows-only, best-effort (never throws). Takes effect in new terminals.
function ensureClaudeOnUserPath(binDir) {
  if (process.platform !== 'win32' || !binDir) return;
  const d = binDir.replace(/'/g, "''"); // escape for PowerShell single-quoted string
  const psCmd = [
    `$d='${d}';`,
    `$p=[Environment]::GetEnvironmentVariable('Path','User'); if(-not $p){$p=''};`,
    `if(($p -split ';') -notcontains $d){`,
    `  if($p){$p=$p.TrimEnd(';')+';'+$d}else{$p=$d};`,
    `  [Environment]::SetEnvironmentVariable('Path',$p,'User')`,
    `}`,
  ].join(' ');
  try {
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psCmd}"`, { timeout: 8000 });
  } catch {
    // Best-effort: if PATH can't be written, the user can still sign in via the
    // full path; we never block first-run on this.
  }
}

function isClaudeAuthenticated() {
  try {
    execSync('claude --print "test" --output-format text', { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

// Codex detection for the wizard. Reuses the server-side detector in codex.js
// (packaged with the app) rather than porting it: binary resolution is
// .cmd-shim aware on Windows, auth detection is the PRESENCE of auth.json
// under $CODEX_HOME or ~/.codex, contents never read. Detection must never
// break the wizard's Claude path, so failures collapse to "not installed".
function detectCodexForWizard() {
  try {
    const { detectCodex } = require('../codex.js');
    const d = detectCodex();
    return { installed: !!d.installed, authenticated: !!d.authenticated };
  } catch {
    return { installed: false, authenticated: false };
  }
}

// Launch Codex's sign-in (`codex login`) in a visible terminal, mirroring
// launchClaudeSignIn below. Best-effort (never throws); the wizard keeps
// polling auth.json presence and advances automatically once sign-in lands.
function launchCodexSignIn() {
  let bin = null;
  try { bin = require('../codex.js').resolveCodexBin(); } catch { /* fall through */ }
  if (!bin) return { ok: false, error: 'Codex was not found.' };
  const { spawn } = require('child_process');
  try {
    if (process.platform === 'win32') {
      spawn(`start "Sign in to Codex" cmd /k ""${bin}" login"`, {
        shell: true, detached: true, stdio: 'ignore',
      }).unref();
    } else if (process.platform === 'darwin') {
      // Terminal.app opens files, not commands with arguments, so the login
      // command travels via a tiny generated .command script.
      const os = require('os');
      const script = path.join(os.tmpdir(), 'rundock-codex-login.command');
      fs.writeFileSync(script, `#!/bin/bash\n"${bin}" login\n`, { mode: 0o755 });
      spawn('open', ['-a', 'Terminal', script], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('x-terminal-emulator', ['-e', `${bin} login`], { detached: true, stdio: 'ignore' }).unref();
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

// Launch Claude Code's interactive sign-in in a visible terminal, so the user
// can complete the browser OAuth without opening a terminal or knowing any
// commands themselves. The wizard keeps polling and advances automatically once
// authentication succeeds. Cross-platform; best-effort (never throws).
function launchClaudeSignIn() {
  const bin = findClaude();
  if (!bin) return { ok: false, error: 'Claude Code was not found.' };
  const { spawn } = require('child_process');
  try {
    if (process.platform === 'win32') {
      // Open a new console window running claude and keep it open (/k). The
      // doubled quotes around the path tolerate spaces in the user profile path.
      spawn(`start "Sign in to Claude" cmd /k ""${bin}""`, {
        shell: true, detached: true, stdio: 'ignore',
      }).unref();
    } else if (process.platform === 'darwin') {
      // Open Terminal.app and run claude in it.
      spawn('open', ['-a', 'Terminal', bin], { detached: true, stdio: 'ignore' }).unref();
    } else {
      // Linux: use the distribution's default terminal emulator.
      spawn('x-terminal-emulator', ['-e', bin], { detached: true, stdio: 'ignore' }).unref();
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

// ===== FIRST-RUN WIZARD =====

function showWizard() {
  return new Promise((resolve) => {
    const wizard = new BrowserWindow({
      width: 520,
      height: 520,
      useContentSize: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      // The first-run wizard has no menu; hide the bar so it can't add chrome
      // (on Windows the default menu bar also ate vertical space, forcing a scroll).
      autoHideMenuBar: true,
      // hiddenInset is macOS-only; on Windows it produces a broken title bar.
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    // Remove the app menu (File/Edit/View/...) from the wizard window entirely.
    // No-op on macOS (which uses a global app menu), clean on Windows/Linux.
    wizard.removeMenu();

    wizard.loadFile(path.join(__dirname, 'wizard.html'));

    // Wizard polls for both runtimes via IPC. The Claude checks are unchanged;
    // Codex detection rides alongside so the wizard can adapt honestly to what
    // the user has (a Codex user is told why Claude Code is still needed, and
    // can sign in to Codex as an optional final step).
    ipcMain.handle('wizard-check-runtimes', () => {
      const claude = (() => {
        const bin = findClaude();
        if (!bin) return { status: 'not-installed' };
        // Claude is installed: make sure its directory is on the user's PATH so
        // they can simply type `claude` in a new terminal to sign in.
        ensureClaudeOnUserPath(path.dirname(bin));
        if (!isClaudeAuthenticated()) return { status: 'not-authenticated' };
        return { status: 'ready' };
      })();
      return { claude, codex: detectCodexForWizard() };
    });

    // Launch Claude's browser sign-in for the user (no terminal needed).
    ipcMain.handle('wizard-signin-claude', () => launchClaudeSignIn());

    // Launch Codex's terminal sign-in (optional wizard step).
    ipcMain.handle('wizard-signin-codex', () => launchCodexSignIn());

    ipcMain.handle('wizard-done', () => {
      ipcMain.removeHandler('wizard-check-runtimes');
      ipcMain.removeHandler('wizard-signin-claude');
      ipcMain.removeHandler('wizard-signin-codex');
      ipcMain.removeHandler('wizard-done');
      wizard.close();
      resolve();
    });

    wizard.on('closed', () => {
      ipcMain.removeHandler('wizard-check-runtimes');
      ipcMain.removeHandler('wizard-signin-claude');
      ipcMain.removeHandler('wizard-signin-codex');
      ipcMain.removeHandler('wizard-done');
      resolve();
    });
  });
}

// ===== IPC HANDLERS =====

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose a workspace folder',
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('get-app-version', () => app.getVersion());

// ===== RENDERER STORAGE =====

// Durable storage for the renderer (see electron/renderer-storage.js). The
// page's origin changes every launch with the OS-assigned port, so anything
// the renderer needs across sessions is kept here, under userData, where no
// port ever enters the path. The snapshot read is synchronous because
// preload fetches it once before the page loads.
const { loadRendererStorage, setRendererStorageKey } = require('./renderer-storage.js');

ipcMain.on('rundock-storage-snapshot', (event) => {
  event.returnValue = loadRendererStorage(app.getPath('userData'));
});

ipcMain.handle('rundock-storage-set', (event, key, value) => {
  try {
    setRendererStorageKey(app.getPath('userData'), key, value);
  } catch (err) {
    // A failed persist must never surface as a renderer error: the value is
    // already applied in-page for this session, and losing it on relaunch is
    // the lesser harm.
    console.warn('[Electron] Failed to persist renderer storage:', err && err.message ? err.message : err);
  }
});

// The sidebar's update strip offers Restart when an update is ready.
// Installing means quitting and relaunching, which only this process can
// do; the explicit call is the same deterministic path the native prompt
// uses, rather than relying on install-on-quit winning a race at exit.
ipcMain.handle('rundock-update-restart', () => {
  if (autoUpdater) autoUpdater.quitAndInstall();
});

// The Windows caption buttons are drawn by the OS from colours we pass, so
// they keep the old ones until re-sent. The renderer calls this on every theme
// change AND on the restore-from-storage path at launch: sending only on
// toggle leaves the buttons correct after a click and wrong after a restart.
// A no-op anywhere but Windows, where setTitleBarOverlay does not exist.
ipcMain.handle('set-title-bar-overlay', (event, isLight) => {
  if (process.platform !== 'win32') return false;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || typeof win.setTitleBarOverlay !== 'function') return false;
  try {
    win.setTitleBarOverlay({ ...(isLight ? OVERLAY_COLOURS.light : OVERLAY_COLOURS.dark), height: TOPBAR_HEIGHT });
    return true;
  } catch (e) {
    // Throws if the window was created without titleBarOverlay. Not fatal:
    // the caption buttons simply keep the colours they had.
    console.warn('[Electron] setTitleBarOverlay failed:', e.message);
    return false;
  }
});

// ===== APP MENU =====

function setupMenu() {
  const isMac = process.platform === 'darwin';

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
      // Failures normally surface through the updater's error event, which
      // resets the flag before this rejection lands. Only report here if
      // that event never fired, so the user gets one dialog, not two.
      if (!isCheckingManually) return;
      isCheckingManually = false;
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        message: 'Could not check for updates',
        detail: err && err.message ? err.message : String(err),
        buttons: ['OK'],
      });
    });
  } };

  const aboutWindows = { label: 'About Rundock', click: () => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'About Rundock',
      message: 'Rundock',
      detail: `Version ${app.getVersion()}\nA visual workspace for your AI agent team.`,
      buttons: ['OK'],
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

  // macOS: app-name menu (About / Check for Updates / Quit) + Edit + View.
  // Windows/Linux: File / Edit / View / Help, the platform convention.
  const template = isMac
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
            checkForUpdatesItem,
            { type: 'separator' },
            { label: 'Quit', accelerator: 'Ctrl+Q', click: () => { app.quit(); } },
          ],
        },
        editMenu,
        viewMenu,
        { label: 'Help', submenu: [ aboutWindows ] },
      ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ===== AUTO-UPDATE =====

// Set to true when the user clicks "Check for Updates" from the menu so the
// event handlers below know to show a visible confirmation. Reset as soon as
// the check resolves. The silent startup check leaves this false so it never
// pops a dialog unprompted.
let isCheckingManually = false;

// How many times the app has launched with an update downloaded but not yet
// installed (see electron/update-launches.js for the counting rules). The
// record survives restarts in userData; reading or writing it is
// best-effort, because losing the count only delays the escape-hatch
// message, while crashing here would break updates entirely.
function launchRecordPath() {
  return path.join(app.getPath('userData'), 'update-launches.json');
}

function readLaunchRecord() {
  try {
    return JSON.parse(fs.readFileSync(launchRecordPath(), 'utf8'));
  } catch {
    return null;
  }
}

function writeLaunchRecord(record) {
  try {
    if (record) fs.writeFileSync(launchRecordPath(), JSON.stringify(record));
    else fs.rmSync(launchRecordPath(), { force: true });
  } catch { /* best-effort, see above */ }
}

function setupAutoUpdate() {
  if (!autoUpdater) return;

  // RUNDOCK_UPDATE_FEED points the updater at any static server hosting the
  // artefacts electron-builder generates (see scripts/update-harness/), so
  // the full update cycle can be exercised locally before anything ships.
  // An unusable value disables the updater for the run rather than silently
  // falling back to the production feed: whoever set it is testing, and a
  // test that quietly hits the wrong feed passes for the wrong reason.
  const feed = resolveUpdateFeed(process.env);
  if (feed.kind === 'invalid') {
    console.warn(`[Electron] ${feed.reason}. Auto-updates disabled for this run.`);
    // Nulling the handle disables every update path, including the menu
    // item, which would otherwise still check against the production feed.
    autoUpdater = null;
    return;
  }
  if (feed.kind === 'feed') {
    autoUpdater.setFeedURL({ provider: 'generic', url: feed.url });
    // Unpacked dev builds refuse update checks unless forced, and moving
    // back to the older test version is how the cycle repeats.
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.allowDowngrade = true;
    console.log(`[Electron] Update feed overridden: ${feed.url}`);
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // If the previous run left an update downloaded and this run is still on
  // the old version, that install failed; count the launch so repeated
  // failures eventually switch the downloaded prompt to the escape hatch.
  const launch = reconcileOnLaunch({ currentVersion: app.getVersion(), stored: readLaunchRecord() });
  writeLaunchRecord(launch.record);
  let pendingRecord = launch.record;

  let updateState = {
    phase: 'idle',
    percent: null,
    version: null,
    manual: false,
    launchesSinceDownload: launch.launchesSinceDownload,
  };

  // Everything the user sees about an update is decided by the pure module
  // (electron/update-state.js); this function only carries state between
  // events and delivers the result. The renderer receives every decision on
  // the existing channel so it can show update state in place; dialogs are
  // shown here because they are native.
  function showUpdateUi(patch) {
    updateState = { ...updateState, ...patch };
    const ui = decideUpdateUi(updateState);
    if (mainWindow) mainWindow.webContents.send('rundock-update', ui);
    return ui;
  }

  autoUpdater.on('update-available', (info) => {
    const ui = showUpdateUi({
      phase: 'available',
      version: info && info.version ? info.version : null,
      percent: null,
      manual: isCheckingManually,
    });
    isCheckingManually = false;
    updateState.manual = false;
    if (ui.dialog) dialog.showMessageBox(mainWindow, ui.dialog);
  });

  autoUpdater.on('download-progress', (progress) => {
    showUpdateUi({
      phase: 'downloading',
      percent: progress && typeof progress.percent === 'number' ? progress.percent : null,
    });
  });

  autoUpdater.on('update-not-available', () => {
    const wasManual = isCheckingManually;
    isCheckingManually = false;
    showUpdateUi({ phase: 'idle', version: null, percent: null, manual: false });
    if (wasManual) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        message: 'Rundock is up to date.',
        detail: `You are running version ${app.getVersion()}.`,
        buttons: ['OK'],
      });
    }
  });

  autoUpdater.on('error', (err) => {
    const ui = showUpdateUi({
      phase: 'error',
      manual: isCheckingManually,
      error: err && err.message ? err.message : String(err),
    });
    isCheckingManually = false;
    updateState.manual = false;
    if (ui.dialog) dialog.showMessageBox(mainWindow, ui.dialog);
  });

  autoUpdater.on('update-downloaded', (info) => {
    const version = info && info.version ? info.version : updateState.version;
    let launchesSinceDownload = updateState.launchesSinceDownload;
    if (version) {
      pendingRecord = recordDownloaded(version, pendingRecord);
      writeLaunchRecord(pendingRecord);
      launchesSinceDownload = pendingRecord.launches;
    }
    const ui = showUpdateUi({ phase: 'downloaded', version, launchesSinceDownload });
    presentInstallPrompt(ui);
  });

  // The decided UI names its buttons and the action each one performs, so
  // this stays a dumb translator: show the dialog, run the chosen action.
  // "Restart now" calling quitAndInstall() directly is the core fix: the
  // install used to depend entirely on autoInstallOnAppQuit winning a race
  // at process exit, which it often lost. That setting remains as a
  // fallback, but the explicit call is what makes the install deterministic.
  function presentInstallPrompt(ui) {
    if (ui.kind !== 'ready' && ui.kind !== 'stuck') return;
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      message: ui.text,
      detail: ui.detail,
      buttons: ui.buttons,
      defaultId: ui.defaultId,
      cancelId: ui.actions.indexOf('dismiss'),
    }).then(({ response }) => {
      const action = ui.actions[response];
      if (action === 'quitAndInstall') {
        autoUpdater.quitAndInstall();
      } else if (action === 'openDownloadPage') {
        shell.openExternal(ui.downloadUrl);
      }
    }).catch(() => { /* window closed mid-dialog; the update installs on quit */ });
  }

  // Check for updates silently on launch (don't block startup). Plain
  // checkForUpdates, not checkForUpdatesAndNotify: the built-in OS
  // notification announces that the update "will be automatically installed
  // on exit", which is the promise this updater no longer makes. The
  // downloaded prompt above is the announcement now.
  autoUpdater.checkForUpdates().catch(() => {});
}

// ===== MAIN WINDOW =====

// Height of the app's top bar, which the window controls now sit inside.
// Must match --topbar-height in public/index.html. Deliberately NOT tied to
// the nav rail width any more: the bar is 50 and the rail stays 60. The 50
// is derived from the search field reading as evenly padded on screen:
// macOS draws a 1px highlight along the window's top edge, so 1 + 6.5 + 36
// + 6.5 is the shortest bar where the field's visible gaps match.
const TOPBAR_HEIGHT = 50;

// Colours for the Windows caption buttons, which the OS draws for us from
// values we pass. They must track the app theme, so they are re-sent whenever
// it changes (see the set-title-bar-overlay handler). Values match --base and
// --text-1 in public/index.html.
const OVERLAY_COLOURS = {
  dark: { color: '#1A1A1A', symbolColor: '#F0EDE8' },
  light: { color: '#F5F2ED', symbolColor: '#1A1A1A' },
};

// The per-platform half of the window chrome, and deliberately the ONLY place
// a platform is named. Everything else derives from the two insets the
// renderer computes (see public/chrome-insets.js).
//
// titleBarStyle: 'hidden', NOT frame: false. frame: false removes the native
// buttons entirely and would mean drawing our own; the whole approach here is
// to keep the real controls and their real behaviour, and only move them.
function chromeWindowOptions() {
  if (process.platform === 'darwin') {
    // We position the traffic lights ourselves, which is why the renderer's
    // left inset is a constant rather than a measurement: x=19 puts the
    // 52px-wide cluster at 19..71, and the inset reserves 87 so the first
    // interface element is not flush against it. x equals the centred y, so
    // the cluster's padding from the left edge matches its padding from the
    // top: the corner reads as one even inset. (A tighter x matching the nav
    // rail's 9px icon inset was tried and sat too close to the corner.)
    return { titleBarStyle: 'hidden', trafficLightPosition: { x: 19, y: (TOPBAR_HEIGHT - 12) / 2 } };
  }
  if (process.platform === 'win32') {
    // Enabling the overlay is also what switches on the Window Controls
    // Overlay API in the renderer, which is the only way to learn how wide the
    // caption buttons actually are. Without this they cannot be measured.
    return { titleBarStyle: 'hidden', titleBarOverlay: { ...OVERLAY_COLOURS.dark, height: TOPBAR_HEIGHT } };
  }
  // Linux keeps its standard title bar. There is no dependable convention
  // there (GNOME right and often close-only, KDE configurable, older Ubuntu
  // left) and titleBarOverlay depends on the window manager honouring
  // client-side decorations. Standard chrome cannot break, and Linux is not a
  // shipping build target.
  return {};
}

// Electron does not provide Chromium's default context menu: unless the main
// process listens for `context-menu` and builds one, right-clicking does
// nothing at all. Without this the packaged app had no spelling suggestions
// and, more consequentially, no Cut, Copy, Paste or Select All in the editor
// or the chat composer.
//
// The menu's SHAPE is decided in context-menu-template.js, which requires
// nothing from electron and is unit-tested. This function is only the wiring.
//
// The template returns null for anything that is not editable, which is what
// keeps this menu off the conversation rows and file-tree rows that draw their
// own. A renderer calling preventDefault() does NOT suppress this event, so
// that gate is load-bearing rather than defensive. The chat composer is
// editable and so is covered by the same gate, with no extra wiring.
function attachContextMenu(webContents) {
  webContents.on('context-menu', (event, params) => {
    const descriptors = buildContextMenuTemplate(params);
    if (!descriptors) return;

    const template = descriptors.map((item) => {
      if (!item.action) return item;
      const { type, word } = item.action;
      return {
        label: item.label,
        click: () => {
          if (type === 'replaceMisspelling') webContents.replaceMisspelling(word);
          // Learned words persist in the session's dictionary across restarts.
          else if (type === 'addToDictionary') webContents.session.addWordToSpellCheckerDictionary(word);
        },
      };
    });

    Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(webContents) });
  });
}

function createMainWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: true,
    center: true,
    ...chromeWindowOptions(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  attachContextMenu(mainWindow.webContents);

  // macOS hides the traffic lights in fullscreen. The renderer drops its left
  // inset to 0 in response, so the bar does not carry a permanent empty gap.
  const sendFullScreen = (isFullScreen) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('rundock-fullscreen', isFullScreen);
    }
  };
  mainWindow.on('enter-full-screen', () => sendFullScreen(true));
  mainWindow.on('leave-full-screen', () => sendFullScreen(false));

  const url = `http://localhost:${port}`;
  console.log(`[Electron] Loading ${url}`);
  mainWindow.loadURL(url);
  mainWindow.show();
  mainWindow.focus();

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error(`[Electron] Failed to load: ${errorDescription} (${errorCode})`);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Electron] Page loaded successfully');
  });

  // Prevent in-app navigation to external URLs; open them in the default browser
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://localhost:${port}`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Prevent target="_blank" links from opening a new Electron window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ===== APP LIFECYCLE =====

app.whenReady().then(async () => {
  console.log('[Electron] App ready');

  // Set dock icon in dev mode only. In packaged builds, the .icns from the
  // app bundle is used automatically and macOS applies its own corner mask.
  if (process.platform === 'darwin' && !app.isPackaged) {
    try {
      const iconPath = path.join(__dirname, 'build', 'icon.png');
      const icon = nativeImage.createFromPath(iconPath);
      if (!icon.isEmpty()) app.dock.setIcon(icon);
    } catch {}
  }

  // Show the first-run wizard when Claude is either not installed OR not signed
  // in. Previously we only checked installation, so a user who had Claude
  // installed but had never authenticated skipped the wizard entirely and then
  // hit a confusing 401 the first time an agent ran. The auth check makes a
  // small API call, so we run it only until setup has been verified once
  // (cached via a marker in userData); after that we trust it and let the
  // in-app 401 recovery card handle any later token expiry.
  console.log('[Electron] Checking for Claude Code...');
  const claudeBin = findClaude();
  console.log('[Electron] Claude binary:', claudeBin || 'not found');

  const setupMarker = path.join(app.getPath('userData'), '.claude-setup-verified');
  const setupVerified = fs.existsSync(setupMarker);
  // RUNDOCK_SMOKE_TEST: boot verification for the packaged app (see
  // scripts/smoke-packaged.mjs). The machine running it has no CLI and no
  // sign-in, so the wizard gate is skipped; everything else about startup
  // (module loading, embedded server, window creation) runs for real, which
  // is the point: a packaging mistake that breaks any of it must fail here.
  const isSmokeTest = process.env.RUNDOCK_SMOKE_TEST === '1';
  const needsWizard = !isSmokeTest && (!claudeBin || (!setupVerified && !isClaudeAuthenticated()));

  if (needsWizard) {
    console.log('[Electron] Showing first-run wizard (Claude missing or not signed in)');
    await showWizard();
    // Only proceed if setup is genuinely complete: installed AND authenticated.
    if (!findClaude() || !isClaudeAuthenticated()) {
      app.quit();
      return;
    }
  }

  // Setup confirmed (installed + signed in): remember it so future launches
  // skip the auth API call. Sign-in expiry after this point is handled
  // separately, when a later request fails authentication.
  // Never written during a smoke test: on a developer machine that would
  // fake the verification the wizard exists to perform.
  if (!isSmokeTest) {
    try { fs.writeFileSync(setupMarker, new Date().toISOString()); } catch { /* non-fatal */ }
  }

  // Start the embedded server on an OS-assigned port
  console.log('[Electron] Starting server...');
  process.env.RUNDOCK_ELECTRON = '1';
  const { startServer } = require('../server.js');
  serverPort = await startServer({ port: 0 });
  console.log('[Electron] Server running on port:', serverPort);

  // Open the main window
  createMainWindow(serverPort);
  setupMenu();
  // The updater talks to the release feed over the network; a boot check
  // must not depend on that being reachable, so smoke runs skip it.
  if (!isSmokeTest) setupAutoUpdate();
  console.log('[Electron] Ready');

  if (isSmokeTest) {
    // Full boot succeeded: modules loaded, server up, window created. The
    // marker line is what scripts/smoke-packaged.mjs waits for; quitting
    // with code 0 is the pass signal.
    console.log('[Electron] Smoke test OK');
    app.quit();
  }
});

// macOS: re-show window when dock icon is clicked
app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  }
});

