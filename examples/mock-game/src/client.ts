import { ReconnectingAdapterClient } from '@ai-native-game-harness/adapter-websocket'
import { MockGameAdapter } from './adapter.js'

const adapter = new MockGameAdapter()
const client = new ReconnectingAdapterClient({
  url: process.env.MOCK_ADAPTER_URL ?? 'ws://127.0.0.1:4173/adapter',
  adapter,
  reconnectMinMs: 200,
  reconnectMaxMs: 2_000,
  onStateChange: (state) => console.log(`[mock-adapter] ${state}`),
})

client.start()

let stopping = false
async function stop(): Promise<void> {
  if (stopping) return
  stopping = true
  await client.stop()
  process.exit(0)
}

process.on('SIGINT', () => { void stop() })
process.on('SIGTERM', () => { void stop() })
