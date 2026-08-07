const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // OS platform, so the first-run wizard can show the right install command.
  platform: process.platform,

  // Native folder picker for workspace selection
  selectDirectory: () => ipcRenderer.invoke('select-directory'),

  // App version for display
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Wizard-specific (only used during first-run). checkRuntimes detects both
  // CLIs (Claude Code and Codex) so the wizard can adapt to what the user has.
  checkRuntimes: () => ipcRenderer.invoke('wizard-check-runtimes'),
  signInClaude: () => ipcRenderer.invoke('wizard-signin-claude'),
  signInCodex: () => ipcRenderer.invoke('wizard-signin-codex'),
  wizardDone: () => ipcRenderer.invoke('wizard-done'),

  // Listen for update notifications from main process
  onUpdate: (callback) => {
    ipcRenderer.on('rundock-update', (event, data) => callback(data));
  },

  // The sidebar's update surface offers Restart when an update is ready;
  // installing means quitting, which only the main process can do.
  updateRestart: () => ipcRenderer.invoke('rundock-update-restart'),

  // Durable renderer storage. The page's origin includes an OS-assigned port
  // that changes every launch, so localStorage cannot hold anything across
  // sessions; durable state lives in the main process instead. The snapshot
  // is fetched synchronously here, before the page loads, so boot-time reads
  // (the theme) apply without a flash of the wrong value. The one sendSync is
  // a single small read during preload, never on the hot path.
  storage: {
    snapshot: ipcRenderer.sendSync('rundock-storage-snapshot'),
    set: (key, value) => ipcRenderer.invoke('rundock-storage-set', key, value),
  },

  // Window chrome. macOS hides the traffic lights in fullscreen, so the
  // renderer drops its left inset in response rather than carrying an empty
  // gap. Windows caption buttons are drawn by the OS from colours we pass, so
  // they must be re-sent whenever the app theme changes.
  onFullScreenChange: (callback) => {
    ipcRenderer.on('rundock-fullscreen', (event, isFullScreen) => callback(isFullScreen));
  },
  setTitleBarOverlay: (isLight) => ipcRenderer.invoke('set-title-bar-overlay', isLight),
});
