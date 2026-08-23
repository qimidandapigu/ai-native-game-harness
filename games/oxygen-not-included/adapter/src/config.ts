import { isAbsolute, join } from 'node:path'

export interface Config {
  host?: string
  port?: number
  bridgeRoot?: string
  installer?: Partial<OniInstallerConfig>
}

export interface OniInstallerConfig {
  manifestUrl: string
  archivePath?: string
  archiveVersion?: string
  archiveSha256?: string
}

export interface ResolvedConfig {
  host: string
  port: number
  bridgeRoot: string
  installer: OniInstallerConfig
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

export function resolveConfig(config: Config = {}): ResolvedConfig {
  const host = config.host ?? '127.0.0.1'
  const port = config.port ?? 32145
  if (!isLoopback(host)) throw new Error('ONI Adapter only permits loopback Gateway hosts')
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('ONI Adapter port must be an integer between 1024 and 65535')
  }

  const manifestUrl = config.installer?.manifestUrl?.trim()
    ?? 'https://github.com/qimidandapigu/dsh-xiaotangyuan-game/releases/download/oni-v0.6.1/oxygen-not-included-v1.json'
  const manifest = new URL(manifestUrl)
  if (manifest.protocol !== 'https:' && !(manifest.protocol === 'http:' && isLoopback(manifest.hostname))) {
    throw new Error('ONI installer manifestUrl must use HTTPS except for loopback development')
  }
  const archivePath = config.installer?.archivePath?.trim()
  const archiveVersion = config.installer?.archiveVersion?.trim()
  const archiveSha256 = config.installer?.archiveSha256?.trim().toLowerCase()
  const localValues = [archivePath, archiveVersion, archiveSha256].filter(value => value !== undefined)
  if (localValues.length !== 0 && localValues.length !== 3) {
    throw new Error('local ONI installer requires archivePath, archiveVersion, and archiveSha256 together')
  }
  if (archivePath !== undefined && !isAbsolute(archivePath)) throw new Error('ONI installer archivePath must be absolute')
  if (archiveVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(archiveVersion)) {
    throw new Error('ONI installer archiveVersion must be a stable semantic version')
  }
  if (archiveSha256 !== undefined && !/^[a-f0-9]{64}$/.test(archiveSha256)) {
    throw new Error('ONI installer archiveSha256 must be a SHA-256 digest')
  }

  return {
    host,
    port,
    bridgeRoot: config.bridgeRoot?.trim()
      || join(process.env.LOCALAPPDATA ?? process.cwd(), 'XiaoTangYuan', 'oni-bridge'),
    installer: {
      manifestUrl,
      ...(archivePath === undefined
        ? {}
        : { archivePath, archiveVersion: archiveVersion!, archiveSha256: archiveSha256! }),
    },
  }
}
