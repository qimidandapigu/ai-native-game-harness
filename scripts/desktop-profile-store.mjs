import { normalize } from 'node:path'

export function resolvePnpmInvocation(npmExecPath, platform, nodeExecPath) {
  if (typeof npmExecPath === 'string' && npmExecPath !== '') {
    if (/\.(?:c?js)$/i.test(npmExecPath)) {
      return { command: nodeExecPath, argsPrefix: [npmExecPath] }
    }
    if (/(?:^|[\\/])pnpm(?:\.cmd|\.exe)?$/i.test(npmExecPath)) {
      return { command: npmExecPath, argsPrefix: [] }
    }
  }
  return {
    command: platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    argsPrefix: [],
  }
}

function unquote(value) {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseMetadata(modulesMetadata) {
  if (typeof modulesMetadata !== 'string' || modulesMetadata.trim() === '') return {}
  try {
    const value = JSON.parse(modulesMetadata)
    if (typeof value === 'object' && value !== null) return value
  } catch {
    // pnpm 10 may write this file as YAML instead of JSON.
  }
  const storeDir = /^\s*storeDir:\s*(.+?)\s*$/m.exec(modulesMetadata)?.[1]
  const packageManager = /^\s*packageManager:\s*(.+?)\s*$/m.exec(modulesMetadata)?.[1]
  return {
    ...(storeDir === undefined ? {} : { storeDir: unquote(storeDir) }),
    ...(packageManager === undefined ? {} : { packageManager: unquote(packageManager) }),
  }
}

function pnpmMajor(value) {
  if (typeof value !== 'string') return undefined
  const match = /^(?:pnpm@)?(\d+)\./.exec(value.trim())
  return match === null ? undefined : Number.parseInt(match[1], 10)
}

export function profileStoreNeedsReset(modulesMetadata, expectedStoreDir, expectedPnpmVersion) {
  const metadata = parseMetadata(modulesMetadata)
  if (typeof metadata.storeDir !== 'string') return true
  if (normalize(metadata.storeDir) !== normalize(expectedStoreDir)) return true
  if (expectedPnpmVersion === undefined) return false
  return pnpmMajor(metadata.packageManager) !== pnpmMajor(expectedPnpmVersion)
}
