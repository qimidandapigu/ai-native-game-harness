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

const pickerLibRoot = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-host-directory-picker-native', 'lib')
const pickerHostPath = join(pickerLibRoot, 'index.js')
const pickerHostSource = readFileSync(pickerHostPath, 'utf8')
const pickerEnvNeedle = '\t\t...process.env,\n\t\tDSH_DIALOG_TITLE: data.title'
const pickerEnvReplacement = '\t\t...process.env,\n\t\tELECTRON_RUN_AS_NODE: "1",\n\t\tDSH_DIALOG_TITLE: data.title'
if (!pickerHostSource.includes(pickerEnvNeedle)) {
  throw new Error(`directory picker worker environment was not patchable: ${pickerHostPath}`)
}
writeFileSync(pickerHostPath, pickerHostSource.replace(pickerEnvNeedle, pickerEnvReplacement))
console.log(`Patched directory picker worker environment: ${pickerHostPath}`)

const pickerWorkerPath = join(pickerLibRoot, 'worker.cjs')
const pickerWorkerSource = readFileSync(pickerWorkerPath, 'utf8')
const pickerDecodeNeedle = `function readUtf16(koffi, address) {
\tconst bytes = Buffer.from(koffi.view(address, 32768));
\tlet end = 0;
\twhile (end + 1 < bytes.length && bytes[end] !== 0) end += 2;
\treturn bytes.toString("utf16le", 0, end);
}`
const pickerDecodeReplacement = `function readUtf16(koffi, address) {
\treturn koffi.decode.string16(address);
}`
if (!pickerWorkerSource.includes(pickerDecodeNeedle)) {
  throw new Error(`directory picker UTF-16 decoder was not patchable: ${pickerWorkerPath}`)
}
writeFileSync(pickerWorkerPath, pickerWorkerSource.replace(pickerDecodeNeedle, pickerDecodeReplacement))
console.log(`Patched directory picker UTF-16 decoder: ${pickerWorkerPath}`)
