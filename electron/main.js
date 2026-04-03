const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain } = require('electron');
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
let tray = null;
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

// ===== TRAY =====

function setupTray() {
  // Use a simple template image for the tray (white on transparent, 18x18)
  // For now, use the app icon resized; replace with a proper template image later
  const iconPath = path.join(__dirname, 'build', 'tray-icon.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  } catch {
    // Fallback: no tray icon if file missing (dev mode)
    return;
  }

  tray = new Tray(icon);
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Rundock', click: () => { if (mainWindow) mainWindow.show(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => { if (mainWindow) mainWindow.show(); });
}

// ===== APP MENU =====

function setupMenu() {
  const template = [
    {
      label: 'Rundock',
      submenu: [
        { label: 'About Rundock', role: 'about' },
        { label: 'Check for Updates', click: () => { if (autoUpdater) autoUpdater.checkForUpdates(); } },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => { app.isQuitting = true; app.quit(); } },
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

function setupAutoUpdate() {
  if (!autoUpdater) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    if (mainWindow) {
      mainWindow.webContents.send('rundock-update', { type: 'available', version: info.version });
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

  // Hide to tray instead of quitting
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
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
  setupTray();
  setupAutoUpdate();
  console.log('[Electron] Ready');
});

// macOS: re-show window when dock icon is clicked
app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
