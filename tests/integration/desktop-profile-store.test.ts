import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  contentFingerprint,
  stageContentAddressedArchive,
} from '../../apps/desktop/src/plugin-archive-cache.mjs'
import {
  profileStoreNeedsReset,
  resolvePnpmInvocation,
} from '../../scripts/desktop-profile-store.mjs'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Desktop development plugin archive cache', () => {
  it('uses a new install path when a same-version tarball changes content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-plugin-archive-'))
    tempRoots.push(root)
    const archive = join(root, 'plugin-0.8.0.tgz')
    await writeFile(archive, 'first-build')
    const first = stageContentAddressedArchive(archive, contentFingerprint(archive))

    await writeFile(archive, 'second-build')
    const second = stageContentAddressedArchive(archive, contentFingerprint(archive))

    expect(first).not.toBe(second)
    await expect(readFile(first, 'utf8')).resolves.toBe('first-build')
    await expect(readFile(second, 'utf8')).resolves.toBe('second-build')
  })
})

describe('Desktop preparation pnpm invocation', () => {
  it('runs a native pnpm executable directly', () => {
    expect(resolvePnpmInvocation(
      '/Users/example/Library/pnpm/.tools/pnpm-exe/10.28.2/pnpm',
      'darwin',
      '/usr/local/bin/node',
    )).toEqual({
      command: '/Users/example/Library/pnpm/.tools/pnpm-exe/10.28.2/pnpm',
      argsPrefix: [],
    })
  })

  it('runs a pnpm JavaScript launcher through Node', () => {
    expect(resolvePnpmInvocation(
      '/workspace/node_modules/pnpm/bin/pnpm.cjs',
      'darwin',
      '/usr/local/bin/node',
    )).toEqual({
      command: '/usr/local/bin/node',
      argsPrefix: ['/workspace/node_modules/pnpm/bin/pnpm.cjs'],
    })
  })
})

describe('Desktop development profile pnpm store recovery', () => {
  it('resets node_modules when the linked store differs from the isolated Desktop store', () => {
    const metadata = JSON.stringify({
      packageManager: 'pnpm@11.7.0',
      storeDir: '/Users/example/Library/pnpm/store/v11',
    })

    expect(profileStoreNeedsReset(
      metadata,
      '/workspace/.artifacts/desktop-dev-user-data/pnpm-store/v10',
    )).toBe(true)
  })

  it('keeps node_modules when it already uses the expected store', () => {
    const storeDir = '/workspace/.artifacts/desktop-dev-user-data/pnpm-store/v10'
    expect(profileStoreNeedsReset(
      JSON.stringify({ packageManager: 'pnpm@10.28.2', storeDir }),
      storeDir,
      '10.28.2',
    )).toBe(false)
  })

  it('resets node_modules when the pnpm major differs even if the store path matches', () => {
    const storeDir = '/workspace/.artifacts/desktop-dev-user-data/pnpm-store/shared'
    expect(profileStoreNeedsReset(
      JSON.stringify({ packageManager: 'pnpm@11.7.0', storeDir }),
      storeDir,
      '10.28.2',
    )).toBe(true)
  })

  it('understands pnpm metadata written as YAML', () => {
    const metadata = [
      'packageManager: pnpm@10.28.2',
      'storeDir: /Users/example/Library/pnpm/store/v10',
      'virtualStoreDir: .pnpm',
    ].join('\n')

    expect(profileStoreNeedsReset(
      metadata,
      '/workspace/.artifacts/desktop-dev-user-data/pnpm-store/v10',
    )).toBe(true)
  })
})
