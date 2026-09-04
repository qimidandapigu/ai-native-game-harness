const { contextBridge, ipcRenderer } = require('electron')

let chatSequence = 0

contextBridge.exposeInMainWorld('harnessDesktop', {
  navigation: {
    showHarness: () => ipcRenderer.invoke('navigation:show-harness'),
    showGame: () => ipcRenderer.invoke('navigation:show-game'),
  },
  onStatus(callback) {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('harness-status', listener)
    return () => ipcRenderer.removeListener('harness-status', listener)
  },
  stardew: {
    status: () => ipcRenderer.invoke('stardew:installation-status'),
    reconcile: () => ipcRenderer.invoke('stardew:reconcile'),
    onStatus(callback) {
      const listener = (_event, status) => callback(status)
      ipcRenderer.on('stardew-installation-status', listener)
      return () => ipcRenderer.removeListener('stardew-installation-status', listener)
    },
  },
  voice: {
    status: () => ipcRenderer.invoke('voice:credential-status'),
    configure: apiKey => ipcRenderer.invoke('voice:configure', { apiKey }),
  },
  platform: {
    info: () => ipcRenderer.invoke('platform:info'),
    snapshot: () => ipcRenderer.invoke('platform:snapshot'),
    async chat(input, onEvent) {
      const requestId = `chat-${Date.now()}-${++chatSequence}`
      const listener = (_event, payload) => {
        if (payload?.requestId === requestId) onEvent?.(payload.event)
      }
      ipcRenderer.on('platform-chat-event', listener)
      try {
        return await ipcRenderer.invoke('platform:chat', { ...input, requestId })
      } finally {
        ipcRenderer.removeListener('platform-chat-event', listener)
      }
    },
    reset: gameId => ipcRenderer.invoke('platform:reset', { gameId }),
    exportDiagnostics: () => ipcRenderer.invoke('platform:export-diagnostics'),
    listGamePacks: () => ipcRenderer.invoke('platform:list-game-packs'),
    installGamePack: () => ipcRenderer.invoke('platform:install-game-pack'),
    uninstallGamePack: (id, version) => ipcRenderer.invoke('platform:uninstall-game-pack', { id, version }),
    onSnapshot(callback) {
      const listener = (_event, snapshot) => callback(snapshot)
      ipcRenderer.on('platform-snapshot', listener)
      return () => ipcRenderer.removeListener('platform-snapshot', listener)
    },
  },
})
