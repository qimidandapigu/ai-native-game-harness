import { readFile } from 'node:fs/promises'

const profileUrl = new URL('../runtime/dsh-profile/versions.json', import.meta.url)
const profile = JSON.parse(await readFile(profileUrl, 'utf8'))
const response = await fetch('https://registry.npmjs.org/@deepseek-ai%2fdsh/latest', {
  headers: { accept: 'application/json' },
  signal: AbortSignal.timeout(15_000),
})
if (!response.ok) throw new Error(`npm registry returned ${response.status}`)
const latest = await response.json()
if (typeof latest.version !== 'string') throw new Error('npm registry response did not include a version')

const updateAvailable = latest.version !== profile.dsh
console.log(JSON.stringify({
  current: profile.dsh,
  latest: latest.version,
  updateAvailable,
  policy: profile.upgradePolicy,
}, null, 2))

if (process.argv.includes('--strict') && updateAvailable) process.exitCode = 1
