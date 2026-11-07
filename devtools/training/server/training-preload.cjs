const { contextBridge, ipcRenderer } = require('electron');

// 不给参赛 iframe 注入桥接；Worker 也没有 Electron / Node 能力。
if (process.isMainFrame) contextBridge.exposeInMainWorld('training', {
  onRun: callback => ipcRenderer.on('training:run', (_event, request) => callback(request)),
  onReplay: callback => ipcRenderer.on('training:replay', (_event, request) => callback(request)),
  ready: () => ipcRenderer.invoke('training:ready'),
  progress: data => ipcRenderer.invoke('training:progress', data),
  round: data => ipcRenderer.invoke('training:round', data),
  done: data => ipcRenderer.invoke('training:done', data),
  failed: data => ipcRenderer.invoke('training:failed', data),
  replayed: data => ipcRenderer.invoke('training:replayed', data),
});
