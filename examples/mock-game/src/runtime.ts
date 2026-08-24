import { HarnessCore } from '@ai-native-game-harness/harness-core'
import { MockAgentDriver } from './agent.js'
import { MockGameAdapter } from './adapter.js'

export async function createMockRuntime(): Promise<{
  core: HarnessCore
  adapter: MockGameAdapter
  agent: MockAgentDriver
}> {
  const core = new HarnessCore()
  const adapter = new MockGameAdapter()
  await core.connectAdapter(adapter)
  return { core, adapter, agent: new MockAgentDriver() }
}
