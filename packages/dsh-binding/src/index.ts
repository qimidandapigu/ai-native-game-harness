import type { AgentActionFeedback, AgentDriver, AgentEvent, AgentRequest } from '@ai-native-game-harness/harness-core'

export type DshSessionChunk =
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  | { type: 'complete'; text: string }

export interface DshSessionFacade {
  stream(input: {
    sessionId: string
    prompt: string
    context: unknown
  }): AsyncIterable<DshSessionChunk>
}

/**
 * Optional migration adapter. HarnessCore knows nothing about DSH; a host app
 * may supply a facade for its installed DSH version here.
 */
export class DshAgentDriver implements AgentDriver {
  constructor(readonly session: DshSessionFacade) {}

  async *stream(request: AgentRequest): AsyncGenerator<AgentEvent, void, AgentActionFeedback> {
    for await (const chunk of this.session.stream({
      sessionId: request.sessionId,
      prompt: request.message,
      context: request.observation,
    })) {
      if (chunk.type === 'reasoning') yield { type: 'analysis', text: chunk.text }
      if (chunk.type === 'text') yield { type: 'text-delta', text: chunk.text }
      if (chunk.type === 'complete') yield { type: 'done', text: chunk.text }
    }
  }
}
