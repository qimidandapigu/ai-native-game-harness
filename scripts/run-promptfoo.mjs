import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const linked = join(root, 'node_modules', 'promptfoo', 'dist', 'src', 'entrypoint.js')
let entrypoint = linked

if (!existsSync(entrypoint)) {
  const store = join(root, 'node_modules', '.pnpm')
  const packageDirectory = existsSync(store)
    ? readdirSync(store).find(name => name.startsWith('promptfoo@'))
    : undefined
  if (packageDirectory !== undefined) {
    entrypoint = join(store, packageDirectory, 'node_modules', 'promptfoo', 'dist', 'src', 'entrypoint.js')
  }
}

if (!existsSync(entrypoint)) {
  console.error('Promptfoo is not installed. Run pnpm install and retry.')
  process.exit(1)
}

const child = spawn(process.execPath, [entrypoint, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
})
child.on('error', error => {
  console.error(error.message)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
