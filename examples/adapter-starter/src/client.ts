import { ReconnectingAdapterClient } from '@ai-native-game-harness/adapter-websocket'
import { StarterGameAdapter } from './adapter.js'

const client = new ReconnectingAdapterClient({
  url: process.env.AI_GAME_HARNESS_ADAPTER_URL ?? 'ws://127.0.0.1:43145/adapter',
  adapter: new StarterGameAdapter(),
})

client.start()
await client.waitUntilConnected(10_000)
process.stdout.write('[adapter-starter] connected\n')

let stopping = false
async function stop(): Promise<void> {
  if (stopping) return
  stopping = true
  await client.stop()
  process.exit(0)
}

process.on('SIGINT', () => { void stop() })
process.on('SIGTERM', () => { void stop() })
