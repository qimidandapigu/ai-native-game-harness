import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, normalize } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function numericVersion(value: string): readonly number[] | undefined {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/)
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareStableVersions(left: string, right: string): number | undefined {
  const leftParts = numericVersion(left)
  const rightParts = numericVersion(right)
  if (leftParts === undefined || rightParts === undefined) return undefined
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index]! > rightParts[index]!) return 1
    if (leftParts[index]! < rightParts[index]!) return -1
  }
  return 0
}

export function parseSteamLibraryPaths(vdf: string): string[] {
  const paths = new Set<string>()
  for (const match of vdf.matchAll(/"path"\s+"([^"]+)"/g)) {
    const value = match[1]?.replaceAll('\\\\', '\\').trim()
    if (value !== undefined && value !== '') paths.add(normalize(value))
  }
  return [...paths]
}

async function windowsSteamRoot(signal?: AbortSignal): Promise<string | undefined> {
  try {
    const result = await execFileAsync(
      'reg.exe',
      ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
      { encoding: 'utf8', windowsHide: true, signal },
    )
    return result.stdout.match(/SteamPath\s+REG_SZ\s+(.+)$/im)?.[1]?.trim()
  } catch {
    return undefined
  }
}

export async function steamRoots(signal?: AbortSignal): Promise<string[]> {
  const roots = new Set<string>()
  const add = (value: string | undefined): void => {
    if (value !== undefined && value.trim() !== '') roots.add(normalize(value))
  }
  if (process.platform === 'win32') {
    add(await windowsSteamRoot(signal))
    add(process.env['ProgramFiles(x86)'] === undefined ? undefined : join(process.env['ProgramFiles(x86)'], 'Steam'))
    add(process.env.ProgramFiles === undefined ? undefined : join(process.env.ProgramFiles, 'Steam'))
  } else if (process.platform === 'darwin') {
    add(join(homedir(), 'Library', 'Application Support', 'Steam'))
  } else {
    add(join(homedir(), '.local', 'share', 'Steam'))
    add(join(homedir(), '.steam', 'steam'))
  }
  for (const root of [...roots]) {
    try {
      const vdf = await readFile(join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8')
      for (const library of parseSteamLibraryPaths(vdf)) add(library)
    } catch {
      // Candidate roots may not exist.
    }
  }
  return [...roots]
}
