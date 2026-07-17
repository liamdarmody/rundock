const { app, BrowserWindow, Menu, nativeImage, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

let autoUpdater;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch {
  console.warn('[Electron] electron-updater not available, auto-updates disabled');
  autoUpdater = null;
}

let mainWindow = null;
let serverPort = null;

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

function setupAutoUpdate() {
  if (!autoUpdater) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    if (mainWindow) {
      mainWindow.webContents.send('rundock-update', { type: 'available', version: info.version });
    }
    if (isCheckingManually) {
      isCheckingManually = false;
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        message: `Update available: ${info.version}`,
        detail: 'Downloading in the background. Rundock will install the update on next quit.',
        buttons: ['OK'],
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    if (isCheckingManually) {
      isCheckingManually = false;
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        message: 'Rundock is up to date.',
        detail: `You are running version ${app.getVersion()}.`,
        buttons: ['OK'],
      });
    }
  });

  autoUpdater.on('error', (err) => {
    if (isCheckingManually) {
      isCheckingManually = false;
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        message: 'Could not check for updates',
        detail: err && err.message ? err.message : String(err),
        buttons: ['OK'],
      });
    }
  });

  autoUpdater.on('update-downloaded', () => {
    if (mainWindow) {
      mainWindow.webContents.send('rundock-update', { type: 'ready' });
    }
  });

  // Check for updates silently on launch (don't block startup)
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
}

// ===== MAIN WINDOW =====

function createMainWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: true,
    center: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

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
  const needsWizard = !claudeBin || (!setupVerified && !isClaudeAuthenticated());

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
  // skip the auth API call. The 401 recovery card covers later expiry.
  try { fs.writeFileSync(setupMarker, new Date().toISOString()); } catch { /* non-fatal */ }

  // Start the embedded server on an OS-assigned port
  console.log('[Electron] Starting server...');
  process.env.RUNDOCK_ELECTRON = '1';
  const { startServer } = require('../server.js');
  serverPort = await startServer({ port: 0 });
  console.log('[Electron] Server running on port:', serverPort);

  // Open the main window
  createMainWindow(serverPort);
  setupMenu();
  setupAutoUpdate();
  console.log('[Electron] Ready');
});

// macOS: re-show window when dock icon is clicked
app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  }
});

