export const GAME_PACK_SCHEMA_VERSION = 1 as const

export interface GamePackManifest {
  schemaVersion: typeof GAME_PACK_SCHEMA_VERSION
  id: string
  version: string
  displayName: string
  adapter: {
    id: string
    entry: string
    protocolVersion: string
  }
  content: {
    story?: string
    characters?: string
    gameplay?: string
    localization?: string
  }
  assets?: string[]
  permissions?: string[]
  optionalBindings?: string[]
}

const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function assertRelativePath(value: string, label: string): void {
  const normalized = value.replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`${label} must be a relative path`)
  }
  if (normalized.split('/').includes('..')) throw new Error(`${label} cannot leave the pack root`)
}

export function assertGamePackManifest(manifest: GamePackManifest): void {
  if (manifest.schemaVersion !== GAME_PACK_SCHEMA_VERSION) throw new Error('Unsupported Game Pack schema version')
  if (!SAFE_ID.test(manifest.id)) throw new Error('Game Pack id must be a lowercase safe id')
  if (!VERSION.test(manifest.version)) throw new Error('Game Pack version must use semver')
  if (!manifest.displayName.trim()) throw new Error('Game Pack displayName is required')
  if (!SAFE_ID.test(manifest.adapter.id)) throw new Error('Adapter id must be a lowercase safe id')
  assertRelativePath(manifest.adapter.entry, 'adapter.entry')
  for (const [key, value] of Object.entries(manifest.content)) {
    if (value) assertRelativePath(value, `content.${key}`)
  }
  for (const [index, value] of (manifest.assets ?? []).entries()) assertRelativePath(value, `assets[${index}]`)
  if (new Set(manifest.permissions ?? []).size !== (manifest.permissions ?? []).length) {
    throw new Error('Game Pack permissions must be unique')
  }
}
