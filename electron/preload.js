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

  // Window chrome. macOS hides the traffic lights in fullscreen, so the
  // renderer drops its left inset in response rather than carrying an empty
  // gap. Windows caption buttons are drawn by the OS from colours we pass, so
  // they must be re-sent whenever the app theme changes.
  onFullScreenChange: (callback) => {
    ipcRenderer.on('rundock-fullscreen', (event, isFullScreen) => callback(isFullScreen));
  },
  setTitleBarOverlay: (isLight) => ipcRenderer.invoke('set-title-bar-overlay', isLight),
});
