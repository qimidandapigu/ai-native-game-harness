import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('harnessDesktop', {
  onStatus(callback) {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('harness-status', listener)
    return () => ipcRenderer.removeListener('harness-status', listener)
  },
  platform: {
    info: () => ipcRenderer.invoke('platform:info'),
    snapshot: () => ipcRenderer.invoke('platform:snapshot'),
    chat: (input) => ipcRenderer.invoke('platform:chat', input),
    reset: (gameId) => ipcRenderer.invoke('platform:reset', { gameId }),
    onSnapshot(callback) {
      const listener = (_event, snapshot) => callback(snapshot)
      ipcRenderer.on('platform-snapshot', listener)
      return () => ipcRenderer.removeListener('platform-snapshot', listener)
    },
  },
})
