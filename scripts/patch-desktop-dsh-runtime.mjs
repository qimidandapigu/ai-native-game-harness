import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const runtimeRoot = resolve(process.argv[2] ?? '')
if (!runtimeRoot) throw new Error('runtime root is required')

const libRoot = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
const needle = 'if (!signalShutdown.signal.aborted && ctx.fiber.state === 2 && ctx.get("loader") !== void 0) try {'
const replacement = 'if (process.env.DSH_DISABLE_HMR !== "1" && !signalShutdown.signal.aborted && ctx.fiber.state === 2 && ctx.get("loader") !== void 0) try {'
const candidates = readdirSync(libRoot)
  .filter((name) => /^profile-boot-.+\.js$/.test(name))
  .map((name) => ({ name, source: readFileSync(join(libRoot, name), 'utf8') }))
  .filter(({ source }) => source.includes(needle))
if (candidates.length !== 1) {
  throw new Error(`expected one patchable DSH profile boot file, found ${candidates.length}`)
}

const [{ name, source }] = candidates
const target = join(libRoot, name)
writeFileSync(target, source.replace(needle, replacement))
console.log(`Patched production HMR guard: ${target}`)
