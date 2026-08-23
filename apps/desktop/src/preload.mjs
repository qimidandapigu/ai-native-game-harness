import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('harnessDesktop', {
  onStatus(callback) {
    ipcRenderer.on('harness-status', (_event, status) => callback(status))
  },
})
