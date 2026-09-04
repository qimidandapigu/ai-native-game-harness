import { mkdir, readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const VOICE_CREDENTIAL_REF = 'VOLCENGINE_API_KEY'
const GROUP_OR_OTHER_BITS = 0o077
const MAX_CREDENTIAL_LENGTH = 8_192

function isMissing(error) {
  return error?.code === 'ENOENT'
}

async function readCredentialDocument(filename) {
  try {
    const metadata = await stat(filename)
    if (process.platform !== 'win32' && (metadata.mode & GROUP_OR_OTHER_BITS) !== 0) {
      throw new Error(`语音凭据文件权限不安全，请先执行 chmod 600 ${filename}`)
    }
    return await readFile(filename, 'utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

function inheritedCredential(environment) {
  const value = environment[VOICE_CREDENTIAL_REF]
  return typeof value === 'string' && value.length > 0
}

function normalizeCredential(value) {
  if (typeof value !== 'string') throw new TypeError('火山语音 API Key 格式无效。')
  const normalized = value.trim()
  if (normalized === '') throw new Error('火山语音 API Key 不能为空。')
  if (normalized.length > MAX_CREDENTIAL_LENGTH) throw new Error('火山语音 API Key 过长。')
  return normalized
}

async function loadRuntimeModules(dshPackagePath) {
  const runtimeRequire = createRequire(dshPackagePath)
  const [credentials, yaml, atomicWrite] = await Promise.all([
    import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-credentials-local')).href),
    import(pathToFileURL(runtimeRequire.resolve('yaml')).href),
    import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-atomic-write')).href),
  ])
  return {
    parseCredentialsDocument: credentials.parseCredentialsDocument,
    Document: yaml.Document,
    parseDocument: yaml.parseDocument,
    withFileLock: atomicWrite.withFileLock,
    writeFileAtomic: atomicWrite.writeFileAtomic,
  }
}

/**
 * Desktop-owned facade over DSH's official versioned credential document.
 * The renderer can inspect only metadata; secret values never cross IPC.
 */
export function createVoiceCredentialStore({ dshHome, environment = process.env, dshPackagePath }) {
  if (typeof dshHome !== 'string' || dshHome === '') throw new TypeError('dshHome is required')
  if (typeof dshPackagePath !== 'string' || dshPackagePath === '') throw new TypeError('dshPackagePath is required')
  const filename = join(dshHome, '.credentials.yaml')
  let modulesPromise
  const modules = () => (modulesPromise ??= loadRuntimeModules(dshPackagePath))

  async function status() {
    if (inheritedCredential(environment)) return { configured: true, source: 'env', writable: false }
    const source = await readCredentialDocument(filename)
    if (source === undefined) return { configured: false, writable: true }
    const { parseCredentialsDocument } = await modules()
    const parsed = parseCredentialsDocument(source, filename)
    return parsed.refs.has(VOICE_CREDENTIAL_REF)
      ? { configured: true, source: 'file', writable: true }
      : { configured: false, writable: true }
  }

  async function update(value) {
    if (inheritedCredential(environment)) {
      throw new Error('火山语音 API Key 由环境变量提供，当前客户端不能覆盖。')
    }
    const runtime = await modules()
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
    await runtime.withFileLock(filename, async () => {
      const source = await readCredentialDocument(filename)
      const parsed = source === undefined
        ? { refs: new Map() }
        : runtime.parseCredentialsDocument(source, filename)
      if (value === undefined && !parsed.refs.has(VOICE_CREDENTIAL_REF)) return
      const document = source === undefined || source.trim() === ''
        ? new runtime.Document({})
        : runtime.parseDocument(source, { prettyErrors: true, uniqueKeys: true })
      document.setIn(['version'], 1)
      if (value === undefined) document.deleteIn(['refs', VOICE_CREDENTIAL_REF])
      else document.setIn(['refs', VOICE_CREDENTIAL_REF], value)
      await runtime.writeFileAtomic(filename, document.toString(), {
        mode: 0o600,
        dirMode: 0o700,
      })
    }, { waitMs: 5_000 })
    return await status()
  }

  return {
    status,
    set: async value => await update(normalizeCredential(value)),
    unset: () => update(undefined),
  }
}
