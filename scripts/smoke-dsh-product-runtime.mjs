import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DshProductRuntime } from '../apps/desktop/src/dsh-product-runtime.mjs'

const require = createRequire(import.meta.url)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifactRoot = join(repoRoot, '.artifacts', 'dsh-product-smoke')
const dshPackage = require.resolve('@deepseek-ai/dsh/package.json')
const dshBin = join(dirname(dshPackage), 'lib', 'bin.js')

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

async function waitForHttp(url, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`DSH exited before ready: ${child.exitCode}`)
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error('Timed out waiting for DSH web runtime')
}

await mkdir(artifactRoot, { recursive: true })
const [webPort, adapterPort] = await Promise.all([freePort(), freePort()])
const patchPath = join(artifactRoot, 'product.patch.yml')
const coreUrl = pathToFileURL(join(repoRoot, 'plugins', 'game-core', 'dist', 'index.js')).href
const transportUrl = pathToFileURL(join(repoRoot, 'plugins', 'game-transport', 'dist', 'index.js')).href
await writeFile(patchPath, `- insert:\n    - id: ai-native-game-core-product-smoke\n      name: '${coreUrl}'\n      config:\n        productSnapshotOutput: true\n    - id: ai-native-game-transport-product-smoke\n      name: '${transportUrl}'\n      config:\n        enabled: true\n        host: 127.0.0.1\n        port: ${adapterPort}\n        path: /adapter\n`)

const baseUrl = `http://127.0.0.1:${webPort}`
const child = spawn(process.execPath, [
  dshBin,
  'web',
  '--patch', patchPath,
  '--no-open',
  '--host', '127.0.0.1',
  '--port', String(webPort),
], {
  cwd: repoRoot,
  env: { ...process.env, DSH_HOME: join(artifactRoot, 'dsh-home'), DSH_DISABLE_HMR: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
let coreSnapshotSeen = false
const collect = (data) => {
  const text = data.toString()
  output = `${output}${text}`.slice(-20_000)
  if (text.includes('AI_GAME_HARNESS_SNAPSHOT ')) coreSnapshotSeen = true
}
child.stdout.on('data', collect)
child.stderr.on('data', collect)

let runtime
try {
  await waitForHttp(baseUrl, child)
  runtime = new DshProductRuntime({
    baseUrl,
    cwd: repoRoot,
    adapterUrl: `ws://127.0.0.1:${adapterPort}/adapter`,
  })
  const info = await runtime.start()
  const snapshot = runtime.snapshot()
  const stats = snapshot.runtime.sessionStats
  const officialStatsReady = stats && Object.keys(stats).sort().join(',') === [
    'decodeMs',
    'decodeTokens',
    'llmMs',
    'steps',
    'toolMs',
    'ttftMs',
    'ttftSteps',
    'turns',
  ].sort().join(',')
  if (!info.sessionId || snapshot.runtime.status !== 'online' || !coreSnapshotSeen || !officialStatsReady || snapshot.runtime.sessionStatsSource !== 'dsh-sessionStats') {
    throw new Error(`Product bridge did not become ready: ${JSON.stringify({ info, runtime: snapshot.runtime, coreSnapshotSeen })}`)
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    sessionId: info.sessionId,
    runtimeStatus: snapshot.runtime.status,
    adapterUrl: info.adapterUrl,
    coreSnapshotSeen,
    sessionStats: stats,
  })}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n${output}\n`)
  process.exitCode = 1
} finally {
  await runtime?.close()
  child.kill()
}
