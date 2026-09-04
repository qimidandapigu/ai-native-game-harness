import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

async function isExecutable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function inspectElectronRuntime(electronRoot) {
  const pathFile = join(electronRoot, 'path.txt')
  let rawPath
  try {
    rawPath = await readFile(pathFile, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }

  const normalizedPath = rawPath.trim()
  if (normalizedPath === '') return undefined
  if (isAbsolute(normalizedPath)) {
    throw new Error(`Electron path must be relative to its dist directory: ${normalizedPath}`)
  }

  const distRoot = resolve(electronRoot, 'dist')
  const executable = resolve(distRoot, normalizedPath)
  const relativeExecutable = relative(distRoot, executable)
  if (relativeExecutable === '..'
    || relativeExecutable.startsWith(`..${sep}`)
    || isAbsolute(relativeExecutable)) {
    throw new Error(`Electron executable resolves outside its dist directory: ${normalizedPath}`)
  }

  return {
    canonical: rawPath === normalizedPath,
    executable,
  }
}

export async function ensureElectronRuntime({ electronRoot, install }) {
  let runtime = await inspectElectronRuntime(electronRoot)
  if (runtime?.canonical && await isExecutable(runtime.executable)) {
    return { executable: runtime.executable, installed: false }
  }

  const installScript = join(electronRoot, 'install.js')
  await access(installScript, constants.R_OK)
  await install(installScript)

  runtime = await inspectElectronRuntime(electronRoot)
  if (runtime === undefined) {
    throw new Error('Electron installer did not create path.txt.')
  }
  if (!runtime.canonical) {
    throw new Error('Electron installer left a non-canonical executable path in path.txt.')
  }
  if (!(await isExecutable(runtime.executable))) {
    throw new Error(`Electron installer did not create an executable binary: ${runtime.executable}`)
  }
  return { executable: runtime.executable, installed: true }
}
