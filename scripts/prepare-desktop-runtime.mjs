import { spawn } from 'node:child_process'
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptRoot, '..')
const artifactRoot = join(repoRoot, '.artifacts', 'xiaotangyuan')
const runtimeRoot = join(repoRoot, '.artifacts', 'desktop-runtime')
const appRoot = join(repoRoot, '.artifacts', 'desktop-app')

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
  const npmExecPath = process.env.npm_execpath
  if (npmExecPath && /pnpm(?:\.c?js)?$/i.test(npmExecPath)) {
    return run(process.execPath, [npmExecPath, ...args], options)
  }
  return run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, options)
}

async function copyBuiltPackage(source, destination) {
  await mkdir(destination, { recursive: true })
  await cp(join(source, 'package.json'), join(destination, 'package.json'))
  await cp(join(source, 'dist'), join(destination, 'dist'), { recursive: true, dereference: true })
}

async function cleanGeneratedRoot(path) {
  await run(process.execPath, [join(scriptRoot, 'clean-generated-desktop.mjs'), path])
}

async function main() {
  const manifest = JSON.parse(await readFile(
    join(repoRoot, 'integrations', 'xiaotangyuan', 'manifest.json'),
    'utf8',
  ))
  const pluginArchive = join(
    artifactRoot,
    `qimidandapigu-dsh-xiaotangyuan-game-${manifest.development.expectedVersion}.tgz`,
  )
  const workArchive = join(
    artifactRoot,
    `qimidandapigu-dsh-work-orchestrator-${manifest.workOrchestrator.expectedVersion}.tgz`,
  )
  const oniArchive = join(
    artifactRoot,
    `qimidandapigu-oni-adapter-${manifest.oniAdapter.expectedVersion}.tgz`,
  )
  await Promise.all([pluginArchive, workArchive, oniArchive].map(path => access(path)))
  await cleanGeneratedRoot(runtimeRoot)
  await cleanGeneratedRoot(appRoot)

  await mkdir(runtimeRoot, { recursive: true })
  await writeFile(join(runtimeRoot, 'package.json'), `${JSON.stringify({
    name: '@ai-native-game-harness/desktop-runtime',
    version: '0.1.0',
    private: true,
    dependencies: { '@deepseek-ai/dsh': manifest.compatibility.desktopDsh },
  }, null, 2)}\n`)
  const runtimePnpm = ['--ignore-workspace', '--config.node-linker=hoisted']
  await runPnpm([...runtimePnpm, 'install', '--prod', '--ignore-scripts'], { cwd: runtimeRoot })
  for (const archive of [workArchive, pluginArchive, oniArchive]) {
    await runPnpm([
      ...runtimePnpm,
      'add',
      '--prod',
      '--save-exact',
      '--ignore-scripts',
      archive,
    ], { cwd: runtimeRoot })
  }
  await run(process.execPath, [join(scriptRoot, 'patch-desktop-dsh-runtime.mjs'), runtimeRoot])

  const runtimePackages = [
    ['adapter-protocol', 'packages/adapter-protocol'],
    ['adapter-websocket', 'packages/adapter-websocket'],
    ['harness-core', 'packages/harness-core'],
    ['game-pack', 'packages/game-pack'],
    ['story-runtime', 'packages/story-runtime'],
    ['dsh-binding', 'packages/dsh-binding'],
    ['bridge-contract', 'contracts/bridge-v1'],
    ['game-core', 'plugins/game-core'],
    ['game-transport', 'plugins/game-transport'],
    ['game-learning-binding', 'plugins/game-learning-binding'],
    ['dsh-story-generator', 'plugins/dsh-story-generator'],
  ]
  const runtimeScope = join(runtimeRoot, 'node_modules', '@ai-native-game-harness')
  for (const [name, source] of runtimePackages) {
    await copyBuiltPackage(join(repoRoot, source), join(runtimeScope, name))
  }

  await mkdir(appRoot, { recursive: true })
  await cp(join(repoRoot, 'apps', 'desktop', 'src'), join(appRoot, 'src'), {
    recursive: true,
    dereference: true,
  })
  const appScope = join(appRoot, 'node_modules', '@ai-native-game-harness')
  for (const name of ['adapter-protocol', 'adapter-websocket', 'harness-core', 'game-pack']) {
    await copyBuiltPackage(join(repoRoot, 'packages', name), join(appScope, name))
  }
  await cp(
    join(repoRoot, 'packages', 'adapter-websocket', 'node_modules', 'ws'),
    join(appRoot, 'node_modules', 'ws'),
    { recursive: true, dereference: true },
  )
  await writeFile(join(appRoot, 'package.json'), `${JSON.stringify({
    name: '@ai-native-game-harness/desktop',
    version: '0.1.0',
    private: true,
    description: 'Desktop game edition of AI Native Game Harness.',
    author: 'qimidandapigu',
    license: 'MIT',
    type: 'module',
    main: 'src/main.mjs',
    dependencies: {
      '@ai-native-game-harness/adapter-websocket': '0.1.0',
      '@ai-native-game-harness/game-pack': '0.1.0',
      '@ai-native-game-harness/harness-core': '0.1.0',
      ws: '8.21.3',
    },
  }, null, 2)}\n`)

  process.stdout.write(`${JSON.stringify({
    app: appRoot,
    runtime: runtimeRoot,
    plugin: pluginArchive,
    workOrchestrator: workArchive,
    oniAdapter: oniArchive,
    stardew: join(repoRoot, '.artifacts', 'stardew'),
    dsh: manifest.compatibility.desktopDsh,
  }, null, 2)}\n`)
}

await main()
