import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '../..')
const desktopMain = readFileSync(resolve(repoRoot, 'apps/desktop/src/main.mjs'), 'utf8')

describe('desktop gateway lifecycle wiring', () => {
  it('allows only one Desktop owner for the embedded Runtime', () => {
    expect(desktopMain).toContain('app.requestSingleInstanceLock()')
    expect(desktopMain).toContain("app.on('second-instance'")
  })

  it('does not publish Runtime readiness before the game gateway is listening', () => {
    const webReady = desktopMain.indexOf('await waitForWeb(url, dshProcess)')
    const gatewayReady = desktopMain.indexOf('await waitForGameGateway(() => recentLog)')
    const productBridge = desktopMain.indexOf('await dshProductRuntime.start()')
    expect(webReady).toBeGreaterThan(0)
    expect(gatewayReady).toBeGreaterThan(webReady)
    expect(productBridge).toBeGreaterThan(gatewayReady)
  })

  it('awaits the embedded Runtime shutdown before releasing the Desktop instance', () => {
    expect(desktopMain).toContain('await stopDshRuntime()')
    expect(desktopMain.indexOf('await stopDshRuntime()')).toBeLessThan(desktopMain.indexOf('shutdownComplete = true'))
  })
})
