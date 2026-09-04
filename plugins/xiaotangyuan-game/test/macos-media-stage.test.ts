import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stageMacMediaExecutable } from '../src/runtime/media/native-media-host.js'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('macOS Media Host staging', () => {
  it('atomically creates an executable user-level copy from a read-only package asset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xty-media-stage-'))
    temporaryPaths.push(root)
    const source = join(root, 'bundled-host')
    const targetRoot = join(root, 'runtime')
    await writeFile(source, 'native-host', { mode: 0o644 })

    const target = await stageMacMediaExecutable(source, targetRoot)

    expect(target).toBe(join(targetRoot, 'XtyMediaHost'))
    await expect(readFile(target, 'utf8')).resolves.toBe('native-host')
    expect((await stat(target)).mode & 0o111).not.toBe(0)
  })
})
