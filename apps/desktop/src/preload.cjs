const { contextBridge, ipcRenderer } = require('electron')

let chatSequence = 0
let evaluationSequence = 0

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
  evaluation: {
    catalog: () => ipcRenderer.invoke('evaluation:catalog'),
    async run(evaluationId, onEvent) {
      const requestId = `evaluation-${Date.now()}-${++evaluationSequence}`
      const listener = (_event, payload) => {
        if (payload?.requestId === requestId) onEvent?.(payload.event)
      }
      ipcRenderer.on('evaluation-progress', listener)
      try {
        return await ipcRenderer.invoke('evaluation:run', { evaluationId, requestId })
      } finally {
        ipcRenderer.removeListener('evaluation-progress', listener)
      }
    },
  },
})
