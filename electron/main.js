const { app, BrowserWindow, Menu, nativeImage, dialog, ipcMain, shell } = require('electron');
const path = require('path');
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
// Ensure common install locations are on PATH so `which claude` works.
function ensurePath() {
  const home = require('os').homedir();
  const extraDirs = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
  const current = process.env.PATH || '';
  const missing = extraDirs.filter(d => !current.split(':').includes(d));
  if (missing.length) {
    process.env.PATH = missing.join(':') + ':' + current;
  }
}

function findClaude() {
  ensurePath();
  try {
    const bin = execSync('which claude', { timeout: 5000, encoding: 'utf-8' }).trim();
    execSync('claude --version', { timeout: 10000 });
    return bin;
  } catch {
    return null;
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

// ===== FIRST-RUN WIZARD =====

function showWizard() {
  return new Promise((resolve) => {
    const wizard = new BrowserWindow({
      width: 520,
      height: 440,
      resizable: false,
      minimizable: false,
      maximizable: false,
      titleBarStyle: 'hiddenInset',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    wizard.loadFile(path.join(__dirname, 'wizard.html'));

    // Wizard polls for Claude Code via IPC
    ipcMain.handle('wizard-check-claude', () => {
      const bin = findClaude();
      if (!bin) return { status: 'not-installed' };
      if (!isClaudeAuthenticated()) return { status: 'not-authenticated' };
      return { status: 'ready' };
    });

    ipcMain.handle('wizard-done', () => {
      ipcMain.removeHandler('wizard-check-claude');
      ipcMain.removeHandler('wizard-done');
      wizard.close();
      resolve();
    });

    wizard.on('closed', () => {
      ipcMain.removeHandler('wizard-check-claude');
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
  const template = [
    {
      label: 'Rundock',
      submenu: [
        { label: 'About Rundock', role: 'about' },
        { label: 'Check for Updates', click: () => {
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
        } },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => { app.quit(); } },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
      ],
    },
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

  // Check for Claude Code (installed only; auth check happens in wizard if needed)
  console.log('[Electron] Checking for Claude Code...');
  const claudeBin = findClaude();
  console.log('[Electron] Claude binary:', claudeBin || 'not found');

  if (!claudeBin) {
    console.log('[Electron] Showing wizard (Claude not installed)');
    await showWizard();
    if (!findClaude()) {
      app.quit();
      return;
    }
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
  setupAutoUpdate();
  console.log('[Electron] Ready');
});

// macOS: re-show window when dock icon is clicked
app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  }
});

