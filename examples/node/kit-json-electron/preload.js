const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('terminal', {
  connect: (host, port, protocol) => ipcRenderer.invoke('terminal:connect', host, port, protocol),
  disconnect: () => ipcRenderer.invoke('terminal:disconnect'),
  send: (message) => ipcRenderer.invoke('terminal:send', message),
  
  onReceived: (callback) => ipcRenderer.on('terminal:received', (event, data) => callback(data)),
  onSent: (callback) => ipcRenderer.on('terminal:sent', (event, data) => callback(data)),
  onDisconnected: (callback) => ipcRenderer.on('terminal:disconnected', () => callback()),
  onError: (callback) => ipcRenderer.on('terminal:error', (event, msg) => callback(msg)),
  onHeartbeat: (callback) => ipcRenderer.on('terminal:heartbeat', () => callback()),
  onParseError: (callback) => ipcRenderer.on('terminal:parseError', (event, data) => callback(data))
});
