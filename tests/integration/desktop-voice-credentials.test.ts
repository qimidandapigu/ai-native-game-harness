import { createRequire } from 'node:module'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createVoiceCredentialStore } from '../../apps/desktop/src/voice-credentials.mjs'

const root = resolve(import.meta.dirname, '../..')
const requireFromDesktop = createRequire(resolve(root, 'apps/desktop/package.json'))
const dshPackagePath = requireFromDesktop.resolve('@deepseek-ai/dsh/package.json')
const tempRoots: string[] = []

async function temporaryStore(environment: NodeJS.ProcessEnv = {}) {
  const dshHome = await mkdtemp(join(tmpdir(), 'desktop-voice-credentials-'))
  tempRoots.push(dshHome)
  return {
    dshHome,
    filename: join(dshHome, '.credentials.yaml'),
    store: createVoiceCredentialStore({ dshHome, environment, dshPackagePath }),
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Desktop voice credential store', () => {
  it('reports only configuration metadata and never returns the secret', async () => {
    const { store } = await temporaryStore()

    expect(await store.status()).toEqual({ configured: false, writable: true })

    await store.set('test-volcengine-key')
    const status = await store.status()
    expect(status).toEqual({ configured: true, source: 'file', writable: true })
    expect(status).not.toHaveProperty('value')
  })

  it('patches the official versioned document atomically while preserving unrelated entries', async () => {
    const { filename, store } = await temporaryStore()
    await writeFile(filename, `version: 1\n# keep this account\nrefs:\n  OPENAI_API_KEY: keep-openai\nrecords:\n  provider/account:\n    kind: grant\n    payload:\n      access: keep-token\n`, { mode: 0o600 })
    await chmod(filename, 0o600)

    await store.set('test-volcengine-key')

    const source = await readFile(filename, 'utf8')
    const runtimeRequire = createRequire(dshPackagePath)
    const credentialModulePath = runtimeRequire.resolve('@deepseek-ai/dsh-credentials-local')
    const credentials = await import(pathToFileURL(credentialModulePath).href)
    const parsed = credentials.parseCredentialsDocument(source, filename)
    expect(parsed.refs.get('OPENAI_API_KEY')).toBe('keep-openai')
    expect(parsed.refs.get('VOLCENGINE_API_KEY')).toBe('test-volcengine-key')
    expect(parsed.records.get('provider/account')).toEqual({ kind: 'grant', payload: { access: 'keep-token' } })
    expect(source).toContain('# keep this account')
    if (process.platform !== 'win32') expect((await stat(filename)).mode & 0o777).toBe(0o600)
  })

  it('refuses a write that would be shadowed by an inherited environment value', async () => {
    const { store } = await temporaryStore({ VOLCENGINE_API_KEY: 'environment-key' })

    expect(await store.status()).toEqual({ configured: true, source: 'env', writable: false })
    await expect(store.set('replacement-key')).rejects.toThrow('环境变量')
  })

  it('rejects blank values and can remove only the managed voice key', async () => {
    const { filename, store } = await temporaryStore()
    await expect(store.set('   ')).rejects.toThrow('不能为空')
    await store.set('test-volcengine-key')
    await store.unset()

    const source = await readFile(filename, 'utf8')
    expect(source).not.toContain('VOLCENGINE_API_KEY')
    expect(await store.status()).toEqual({ configured: false, writable: true })
  })
})
