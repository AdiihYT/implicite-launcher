const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  launch: (username) => ipcRenderer.invoke('launch', username),
  forceKill: () => ipcRenderer.invoke('force-kill'),
  gameIsRunning: () => ipcRenderer.invoke('game-is-running'),

  openDebugLog: () => ipcRenderer.invoke('open-debug-log'),
  openAppDir: () => ipcRenderer.invoke('open-app-dir'),

  onProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('progress', listener);
  },
  onGameStatus: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('game-status', listener);
  },
  removeProgressListeners: () => {
    ipcRenderer.removeAllListeners('progress');
    ipcRenderer.removeAllListeners('game-status');
  },
});
