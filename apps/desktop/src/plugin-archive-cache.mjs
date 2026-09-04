import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'

export function contentFingerprint(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * pnpm keys local tarballs by path as well as package version. A source build
 * can therefore keep serving old bytes when the canonical archive is replaced
 * in place. Install from an immutable content-addressed sibling instead.
 */
export function stageContentAddressedArchive(archivePath, fingerprint = contentFingerprint(archivePath)) {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('plugin archive fingerprint must be a SHA-256 hex digest')
  const extension = extname(archivePath)
  const stem = basename(archivePath, extension)
  const cacheRoot = join(dirname(archivePath), '.install-cache')
  const destination = join(cacheRoot, `${stem}-${fingerprint}${extension}`)
  mkdirSync(cacheRoot, { recursive: true })
  if (existsSync(destination) && contentFingerprint(destination) === fingerprint) return destination

  const temporary = `${destination}.${process.pid}.tmp`
  try {
    copyFileSync(archivePath, temporary)
    if (contentFingerprint(temporary) !== fingerprint) {
      throw new Error(`plugin archive changed while staging: ${archivePath}`)
    }
    renameSync(temporary, destination)
  } finally {
    rmSync(temporary, { force: true })
  }
  return destination
}
