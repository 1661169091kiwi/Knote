const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('knotePrint', {
  getJob: () => ipcRenderer.invoke('knote:print-job'),
  readImage: relative => ipcRenderer.invoke('knote:print-image', String(relative || '')),
  progress: value => ipcRenderer.send('knote:print-progress', value),
  ready: result => ipcRenderer.invoke('knote:print-ready', result)
})
