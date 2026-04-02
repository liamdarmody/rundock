const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Native folder picker for workspace selection
  selectDirectory: () => ipcRenderer.invoke('select-directory'),

  // App version for display
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Wizard-specific (only used during first-run)
  checkClaude: () => ipcRenderer.invoke('wizard-check-claude'),
  wizardDone: () => ipcRenderer.invoke('wizard-done'),

  // Listen for update notifications from main process
  onUpdate: (callback) => {
    ipcRenderer.on('rundock-update', (event, data) => callback(data));
  },
});
