import { constants } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureElectronRuntime } from '../../scripts/desktop-electron-runtime.mjs'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Desktop Electron runtime preparation', () => {
  it('re-reads and normalizes a stale path after installing a missing Electron binary', async () => {
    const electronRoot = await mkdtemp(join(tmpdir(), 'desktop-electron-runtime-'))
    tempRoots.push(electronRoot)
    const relativePath = 'Electron.app/Contents/MacOS/Electron'
    const expectedExecutable = join(electronRoot, 'dist', relativePath)
    await writeFile(join(electronRoot, 'path.txt'), `${relativePath}\n`)
    await writeFile(join(electronRoot, 'install.js'), '')

    let installCalls = 0
    const result = await ensureElectronRuntime({
      electronRoot,
      install: async () => {
        installCalls += 1
        await mkdir(dirname(expectedExecutable), { recursive: true })
        await writeFile(expectedExecutable, '')
        await chmod(expectedExecutable, 0o755)
        await writeFile(join(electronRoot, 'path.txt'), relativePath)
      },
    })

    expect(installCalls).toBe(1)
    expect(result).toEqual({ executable: expectedExecutable, installed: true })
    await expect(access(result.executable, constants.X_OK)).resolves.toBeUndefined()
  })

  it('keeps an already valid Electron runtime without invoking the installer', async () => {
    const electronRoot = await mkdtemp(join(tmpdir(), 'desktop-electron-runtime-'))
    tempRoots.push(electronRoot)
    const relativePath = 'Electron.app/Contents/MacOS/Electron'
    const executable = join(electronRoot, 'dist', relativePath)
    await mkdir(dirname(executable), { recursive: true })
    await writeFile(executable, '')
    await chmod(executable, 0o755)
    await writeFile(join(electronRoot, 'path.txt'), relativePath)

    const result = await ensureElectronRuntime({
      electronRoot,
      install: async () => {
        throw new Error('installer should not run')
      },
    })

    expect(result).toEqual({ executable, installed: false })
  })

  it('rejects an installer result that still contains trailing whitespace', async () => {
    const electronRoot = await mkdtemp(join(tmpdir(), 'desktop-electron-runtime-'))
    tempRoots.push(electronRoot)
    const relativePath = 'Electron.app/Contents/MacOS/Electron'
    const executable = join(electronRoot, 'dist', relativePath)
    await writeFile(join(electronRoot, 'path.txt'), `${relativePath}\n`)
    await writeFile(join(electronRoot, 'install.js'), '')

    await expect(ensureElectronRuntime({
      electronRoot,
      install: async () => {
        await mkdir(dirname(executable), { recursive: true })
        await writeFile(executable, '')
        await chmod(executable, 0o755)
      },
    })).rejects.toThrow('non-canonical executable path')
  })
})
