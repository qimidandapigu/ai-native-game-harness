import { execFile as execFileCallback, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const runsMacArm64 = process.platform === 'darwin' && process.arch === 'arm64'
const execFile = promisify(execFileCallback)

describe('macOS native Media Host', () => {
  const platformIt = runsMacArm64 ? it : it.skip

  it('owns one AVAudioEngine per recording session so a stopped input tap is never reused', async () => {
    const source = await readFile(
      resolve(import.meta.dirname, '../media/macos-arm64/XtyMediaHost.swift'),
      'utf8',
    )
    const recorder = source.slice(
      source.indexOf('private final class MicrophoneRecorder'),
      source.indexOf('private final class PcmPlayback'),
    )
    const recordingState = source.slice(
      source.indexOf('private final class RecordingState'),
      source.indexOf('private final class MicrophoneRecorder'),
    )

    expect(recorder).not.toMatch(/private let engine\s*=\s*AVAudioEngine\(\)/)
    expect(recordingState).toContain('let engine: AVAudioEngine')
    expect(recorder).toContain('guard current === state else')
  })

  platformIt('starts with the JSON-lines protocol and shuts down cleanly', async () => {
    const buildRoot = await mkdtemp(join(tmpdir(), 'xty-media-host-test-'))
    try {
      const moduleCache = join(buildRoot, 'module-cache')
      await mkdir(moduleCache)
      const source = resolve(import.meta.dirname, '../media/macos-arm64/XtyMediaHost.swift')
      const plist = resolve(import.meta.dirname, '../media/macos-arm64/Info.plist')
      const executable = join(buildRoot, 'XtyMediaHost')
      await execFile('swiftc', [
        '-module-cache-path', moduleCache,
        '-target', 'arm64-apple-macos14.0',
        '-swift-version', '5',
        '-O',
        '-framework', 'AppKit',
        '-framework', 'ApplicationServices',
        '-framework', 'AVFoundation',
        '-framework', 'CoreGraphics',
        '-framework', 'ScreenCaptureKit',
        '-Xlinker', '-sectcreate',
        '-Xlinker', '__TEXT',
        '-Xlinker', '__info_plist',
        '-Xlinker', plist,
        source,
        '-o', executable,
      ])
      const child = spawn(executable, [], {
        env: { ...process.env, XTY_MEDIA_HOST_DISABLE_PERMISSION_PROMPTS: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const lines = createInterface({ input: child.stdout })
      const events: Array<Record<string, unknown>> = []
      const ready = new Promise<Record<string, unknown>>((resolveReady, rejectReady) => {
        const timeout = setTimeout(() => rejectReady(new Error('Media Host ready event timed out')), 5_000)
        lines.on('line', line => {
          const event = JSON.parse(line) as Record<string, unknown>
          events.push(event)
          if (event.type === 'ready') {
            clearTimeout(timeout)
            resolveReady(event)
          }
        })
        child.once('error', rejectReady)
        child.once('exit', code => {
          if (!events.some(event => event.type === 'ready')) rejectReady(new Error(`Media Host exited before ready: ${code}`))
        })
      })

      await expect(ready).resolves.toMatchObject({ type: 'ready', version: '0.1.0' })
      const exited = new Promise<number | null>((resolveExit, rejectExit) => {
        const timeout = setTimeout(() => {
          child.kill()
          rejectExit(new Error('Media Host shutdown timed out'))
        }, 5_000)
        child.once('exit', code => {
          clearTimeout(timeout)
          resolveExit(code)
        })
      })
      child.stdin.end(`${JSON.stringify({ method: 'shutdown', params: {} })}\n`)
      await expect(exited).resolves.toBe(0)
    } finally {
      await rm(buildRoot, { recursive: true, force: true })
    }
  }, 30_000)
})
