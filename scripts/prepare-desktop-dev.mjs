import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  profileStoreNeedsReset,
  resolvePnpmInvocation,
} from './desktop-profile-store.mjs'
import { ensureElectronRuntime } from './desktop-electron-runtime.mjs'
import { stageContentAddressedArchive } from '../apps/desktop/src/plugin-archive-cache.mjs'

const scriptRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptRoot, '..')
const artifactRoot = join(repoRoot, '.artifacts', 'xiaotangyuan')
const stardewRoot = join(repoRoot, '.artifacts', 'stardew')
const devUserData = join(repoRoot, '.artifacts', 'desktop-dev-user-data')
const forceMediaHost = process.argv.includes('--force-media-host')

async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
      ...options,
    })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`${command} ${args.join(' ')} failed (${code ?? signal})`))
    })
  })
}

function runPnpm(args, options = {}) {
  const invocation = resolvePnpmInvocation(
    process.env.npm_execpath,
    process.platform,
    process.execPath,
  )
  return run(invocation.command, [...invocation.argsPrefix, ...args], options)
}

function runCaptured(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const stdout = []
    const stderr = []
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...options,
    })
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => resolveRun({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }))
  })
}

function forwardCaptured(result) {
  if (result.stdout !== '') process.stdout.write(result.stdout)
  if (result.stderr !== '') process.stderr.write(result.stderr)
}

function assertSucceeded(command, args, result) {
  if (result.code === 0) return
  forwardCaptured(result)
  throw new Error(`${command} ${args.join(' ')} failed (${result.code ?? result.signal})`)
}

async function resolveProfilePnpmVersion(profileDir) {
  await mkdir(profileDir, { recursive: true })
  const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const result = await runCaptured(pnpmCommand, ['--version'], { cwd: profileDir })
  assertSucceeded(pnpmCommand, ['--version'], result)
  const version = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(result.stdout)?.[1]
  if (version === undefined) {
    throw new Error(`Unable to determine the pnpm version used by the DSH profile: ${result.stdout.trim()}`)
  }
  return version
}

async function resetMismatchedProfileStore(profileDir, storeDir, pnpmVersion) {
  const nodeModules = join(profileDir, 'node_modules')
  if (!(await exists(nodeModules))) return false
  const modulesMetadata = await readFile(join(nodeModules, '.modules.yaml'), 'utf8')
    .catch(error => {
      if (error?.code === 'ENOENT') return ''
      throw error
    })
  if (!profileStoreNeedsReset(modulesMetadata, storeDir, pnpmVersion)) return false
  process.stderr.write(
    `[desktop:prepare] pnpm ${pnpmVersion} uses a different profile store; rebuilding the isolated web profile dependencies.\n`,
  )
  await rm(nodeModules, { recursive: true, force: true })
  return true
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function prepareElectronRuntime() {
  const electronRoot = join(repoRoot, 'apps', 'desktop', 'node_modules', 'electron')
  return ensureElectronRuntime({
    electronRoot,
    install: installScript => run(process.execPath, [installScript], { cwd: electronRoot }),
  })
}

async function buildMediaHost() {
  if (process.platform === 'darwin') {
    if (process.arch !== 'arm64') {
      throw new Error('The bundled macOS Media Host currently requires Apple Silicon (arm64).')
    }
    const mediaRoot = join(repoRoot, 'plugins', 'xiaotangyuan-game', 'media', 'macos-arm64')
    const output = join(mediaRoot, 'XtyMediaHost')
    const sources = [join(mediaRoot, 'XtyMediaHost.swift'), join(mediaRoot, 'Info.plist'), join(mediaRoot, 'build.sh')]
    const outputStat = await stat(output).catch(() => undefined)
    const sourceStats = await Promise.all(sources.map(path => stat(path)))
    const outdated = forceMediaHost
      || outputStat === undefined
      || sourceStats.some(source => source.mtimeMs > outputStat.mtimeMs)
    if (outdated) await run('/bin/zsh', [join(mediaRoot, 'build.sh')])
    await access(output, constants.X_OK)
    return { platform: 'darwin-arm64', rebuilt: outdated, output }
  }

  if (process.platform === 'win32') {
    const project = join(repoRoot, 'apps', 'windows-media-host', 'XtyMediaHost.csproj')
    const outputRoot = join(repoRoot, 'plugins', 'xiaotangyuan-game', 'media', 'windows-x64')
    const output = join(outputRoot, 'XtyMediaHost.exe')
    const rebuilt = forceMediaHost || !(await exists(output))
    if (rebuilt) {
      await mkdir(outputRoot, { recursive: true })
      await run('dotnet', ['publish', project, '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-o', outputRoot])
    }
    await access(output)
    return { platform: 'windows-x64', rebuilt, output }
  }

  throw new Error(`Desktop Media Host is not available for ${process.platform}/${process.arch}.`)
}

async function stageStardewMods() {
  const project = join(repoRoot, 'games', 'stardew-valley', 'adapter', 'StardewAgentMod.csproj')
  await run('dotnet', ['build', project, '-c', 'Release'])

  const adapterSource = join(repoRoot, 'games', 'stardew-valley', 'adapter')
  const adapterBuild = join(adapterSource, 'bin', 'Release', 'net6.0')
  const companionSource = join(
    repoRoot,
    'games',
    'stardew-valley',
    'content-pack',
    'XiaoTangYuanCompanion',
  )
  const adapterManifest = JSON.parse(await readFile(join(adapterSource, 'manifest.json'), 'utf8'))
  const companionManifest = JSON.parse(await readFile(join(companionSource, 'manifest.json'), 'utf8'))
  if (adapterManifest.Version !== companionManifest.Version) {
    throw new Error(`Stardew bundled versions differ: ${adapterManifest.Version} / ${companionManifest.Version}`)
  }

  await rm(stardewRoot, { recursive: true, force: true })
  const adapterTarget = join(stardewRoot, 'StardewAgentMod')
  const companionTarget = join(stardewRoot, 'XiaoTangYuanCompanion')
  await mkdir(adapterTarget, { recursive: true })
  await cp(join(adapterSource, 'manifest.json'), join(adapterTarget, 'manifest.json'))
  await cp(join(adapterBuild, 'StardewAgentMod.dll'), join(adapterTarget, 'StardewAgentMod.dll'))
  await cp(companionSource, companionTarget, { recursive: true })
  const bundle = {
    schemaVersion: 1,
    version: adapterManifest.Version,
    adapterFolder: 'StardewAgentMod',
    companionFolder: 'XiaoTangYuanCompanion',
  }
  await writeFile(join(stardewRoot, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`)
  return bundle
}

async function buildWorkspacePackages(manifest) {
  const builds = [
    ['--filter', '@ai-native-game-harness/game-transport...', 'build'],
    ['--filter', manifest.workOrchestrator.packageName, 'build'],
    ['--filter', manifest.packageName, 'build'],
    ['--filter', '@ai-native-game-harness/game-learning-binding', 'build'],
    ['--filter', '@ai-native-game-harness/dsh-story-generator...', 'build'],
    ['--filter', manifest.oniAdapter.packageName, 'build'],
  ]
  for (const args of builds) await runPnpm(args)
}

async function packWorkspacePackages(manifest) {
  await mkdir(artifactRoot, { recursive: true })
  const packages = [
    {
      root: join(repoRoot, manifest.workOrchestrator.source),
      name: `qimidandapigu-dsh-work-orchestrator-${manifest.workOrchestrator.expectedVersion}.tgz`,
      hoisted: false,
    },
    {
      root: join(repoRoot, manifest.development.defaultSource),
      name: `qimidandapigu-dsh-xiaotangyuan-game-${manifest.development.expectedVersion}.tgz`,
      hoisted: false,
    },
    {
      root: join(repoRoot, manifest.oniAdapter.source),
      name: `qimidandapigu-oni-adapter-${manifest.oniAdapter.expectedVersion}.tgz`,
      hoisted: true,
    },
  ]
  for (const item of packages) {
    const args = item.hoisted
      ? ['--config.node-linker=hoisted', 'pack', '--pack-destination', artifactRoot]
      : ['pack', '--pack-destination', artifactRoot]
    await runPnpm(args, { cwd: item.root })
    const archivePath = join(artifactRoot, item.name)
    await access(archivePath)
    item.installPath = stageContentAddressedArchive(archivePath)
  }
  return packages
}

async function installDevelopmentProfile(packages) {
  const dshBin = join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  await access(dshBin)
  const dshHome = join(devUserData, 'dsh-home')
  const profileDir = join(dshHome, 'profiles', 'web')
  const pnpmVersion = await resolveProfilePnpmVersion(profileDir)
  const pnpmMajor = /^\d+/.exec(pnpmVersion)?.[0]
  if (pnpmMajor === undefined) throw new Error(`Invalid pnpm version: ${pnpmVersion}`)
  const storeDir = join(devUserData, 'pnpm-store', `v${pnpmMajor}`)
  const nodeModules = join(profileDir, 'node_modules')
  await mkdir(storeDir, { recursive: true })
  await resetMismatchedProfileStore(profileDir, storeDir, pnpmVersion)

  for (const item of packages) {
    const args = [
      '--expose-internals',
      dshBin,
      'plugin',
      '--profile',
      'web',
      'add',
      item.installPath,
      '--store-dir',
      storeDir,
    ]
    const options = { env: { ...process.env, DSH_HOME: dshHome } }
    let result = await runCaptured(process.execPath, args, options)
    const output = `${result.stdout}\n${result.stderr}`
    if (result.code !== 0 && output.includes('ERR_PNPM_UNEXPECTED_STORE')) {
      process.stderr.write(
        '[desktop:prepare] The isolated profile store changed during installation; rebuilding it once and retrying.\n',
      )
      await rm(nodeModules, { recursive: true, force: true })
      result = await runCaptured(process.execPath, args, options)
    }
    assertSucceeded(process.execPath, args, result)
    forwardCaptured(result)
  }
  return dshHome
}

async function writeFingerprint(manifest, packages) {
  const byRoot = new Map(packages.map(item => [item.root, item]))
  const plugin = byRoot.get(join(repoRoot, manifest.development.defaultSource))
  const work = byRoot.get(join(repoRoot, manifest.workOrchestrator.source))
  const oni = byRoot.get(join(repoRoot, manifest.oniAdapter.source))
  const value = [
    `${manifest.development.expectedVersion}:${await sha256(join(artifactRoot, plugin.name))}`,
    `work=${manifest.workOrchestrator.expectedVersion}:${await sha256(join(artifactRoot, work.name))}`,
    `oni=${manifest.oniAdapter.expectedVersion}:${await sha256(join(artifactRoot, oni.name))}`,
  ].join(';')
  const stateRoot = join(devUserData, 'runtime-state')
  await mkdir(stateRoot, { recursive: true })
  await writeFile(join(stateRoot, 'xiaotangyuan.version'), `${value}\n`)
}

async function main() {
  if (!(await exists(join(repoRoot, 'node_modules')))) {
    throw new Error('Workspace dependencies are missing. Run pnpm install --frozen-lockfile once first.')
  }
  const manifest = JSON.parse(await readFile(
    join(repoRoot, 'integrations', 'xiaotangyuan', 'manifest.json'),
    'utf8',
  ))
  const electronRuntime = await prepareElectronRuntime()
  const mediaHost = await buildMediaHost()
  const stardew = await stageStardewMods()
  await buildWorkspacePackages(manifest)
  const packages = await packWorkspacePackages(manifest)
  const profile = await installDevelopmentProfile(packages)
  await writeFingerprint(manifest, packages)
  process.stdout.write(`${JSON.stringify({
    mode: 'source-development',
    artifacts: artifactRoot,
    profile,
    electronRuntime,
    mediaHost,
    stardew: { root: stardewRoot, version: stardew.version },
    next: 'pnpm desktop:dev',
  }, null, 2)}\n`)
}

await main()
