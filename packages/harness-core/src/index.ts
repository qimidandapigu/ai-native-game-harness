import { randomUUID } from 'node:crypto'
import {
  assertActionResult,
  assertActionRequest,
  assertAdapterHello,
  assertObservation,
  type ActionRequest,
  type ActionResult,
  type AdapterHello,
  type AdapterConnectionState,
  type GameAdapter,
  type GameObservation,
  type JsonValue,
} from '@ai-native-game-harness/adapter-protocol'

export interface HarnessTrace {
  traceId: string
  sessionId: string
  gameId: string
  kind: 'adapter.connected' | 'adapter.disconnected' | 'adapter.reconnected' | 'game.observed' | 'action.executed' | 'agent.event'
  createdAt: string
  detail: Record<string, JsonValue>
}

export interface AgentRequest {
  sessionId: string
  gameId: string
  message: string
  observation: GameObservation
}

export interface AgentActionRequest {
  type: 'action'
  callId?: string
  capability: string
  arguments: Record<string, JsonValue>
  expectedRevision?: number
}

export interface AgentActionFeedback {
  callId: string
  capability: string
  result: ActionResult
  observation: GameObservation
}

export type AgentEvent =
  | { type: 'analysis'; text: string }
  | { type: 'text-delta'; text: string }
  | AgentActionRequest
  | ({ type: 'action-result' } & AgentActionFeedback)
  | { type: 'done'; text: string }

export interface AgentDriver {
  /** Standalone conformance-test seam. The shipped product uses DSH Agent sessions. */
  stream(request: AgentRequest): AsyncGenerator<AgentEvent, void, AgentActionFeedback>
}

export interface AgentChatOptions {
  maxActions?: number
}

export interface AdapterSummary extends AdapterHello {
  connectedAt: string
  status: AdapterConnectionState
}

export interface HarnessSnapshot {
  adapters: AdapterSummary[]
  observations: GameObservation[]
  traces: HarnessTrace[]
}

interface ConnectedAdapter {
  adapter: GameAdapter
  hello: AdapterHello
  connectedAt: string
  status: AdapterConnectionState
  unsubscribe?: () => void
  unsubscribeConnection?: () => void
}

export class HarnessCore {
  readonly #adapters = new Map<string, ConnectedAdapter>()
  readonly #observations = new Map<string, GameObservation>()
  readonly #traces: HarnessTrace[] = []
  readonly #snapshotListeners = new Set<(snapshot: HarnessSnapshot) => void>()

  subscribe(listener: (snapshot: HarnessSnapshot) => void): () => void {
    this.#snapshotListeners.add(listener)
    return () => this.#snapshotListeners.delete(listener)
  }

  async connectAdapter(adapter: GameAdapter): Promise<AdapterSummary> {
    const hello = await adapter.hello()
    assertAdapterHello(hello)
    if (this.#adapters.has(hello.gameId)) throw new Error(`Game already connected: ${hello.gameId}`)
    const connectedAt = new Date().toISOString()
    const unsubscribe = adapter.subscribe?.((event) => {
      this.#trace('system', event.gameId, 'agent.event', {
        eventId: event.eventId,
        eventType: event.type,
        revision: event.revision,
      })
    })
    const connected: ConnectedAdapter = {
      adapter,
      hello,
      connectedAt,
      status: adapter.connectionState?.() ?? 'connected',
      unsubscribe,
    }
    connected.unsubscribeConnection = adapter.subscribeConnection?.((status) => {
      const previous = connected.status
      connected.status = status
      if (previous === status) return
      this.#trace('system', hello.gameId, status === 'connected' ? 'adapter.reconnected' : 'adapter.disconnected', {
        adapterId: hello.adapterId,
      })
      if (status === 'connected') {
        void this.observe(hello.gameId, 'system', { reason: 'reconnect' }).catch(() => undefined)
      }
    })
    this.#adapters.set(hello.gameId, connected)
    this.#trace('system', hello.gameId, 'adapter.connected', {
      adapterId: hello.adapterId,
      protocolVersion: hello.protocolVersion,
    })
    await this.observe(hello.gameId, 'system', { reason: 'initial' })
    return { ...hello, connectedAt, status: connected.status }
  }

  listAdapters(): AdapterSummary[] {
    return [...this.#adapters.values()].map(({ hello, connectedAt, status }) => ({
      ...hello,
      connectedAt,
      status,
    }))
  }

  async disconnectAdapter(gameId: string): Promise<void> {
    const connected = this.#adapters.get(gameId)
    if (connected === undefined) return
    this.#adapters.delete(gameId)
    this.#observations.delete(gameId)
    connected.unsubscribe?.()
    connected.unsubscribeConnection?.()
    await connected.adapter.close?.()
    this.#trace('system', gameId, 'adapter.disconnected', {
      adapterId: connected.hello.adapterId,
      reason: 'removed',
    })
  }

  async observe(
    gameId: string,
    sessionId = 'system',
    context: { requestId?: string; reason?: 'initial' | 'manual' | 'post-action' | 'reconnect' } = {},
  ): Promise<GameObservation> {
    const connected = this.#requireAdapter(gameId)
    const startedAt = performance.now()
    const observation = await connected.adapter.observe()
    assertObservation(observation, gameId)
    this.#observations.set(gameId, observation)
    this.#trace(sessionId, gameId, 'game.observed', {
      revision: observation.revision,
      adapterRoundTripMs: Math.max(0, Math.round(performance.now() - startedAt)),
      ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
      ...(context.reason === undefined ? {} : { reason: context.reason }),
    })
    return observation
  }

  async executeAction(
    gameId: string,
    capability: string,
    args: Record<string, JsonValue>,
    options: { sessionId?: string; expectedRevision?: number; requestId?: string } = {},
  ): Promise<ActionResult> {
    const validationStartedAt = performance.now()
    const connected = this.#requireAdapter(gameId)
    const request: ActionRequest = {
      requestId: options.requestId ?? randomUUID(),
      gameId,
      capability,
      arguments: args,
      expectedRevision: options.expectedRevision,
    }
    try {
      const declared = connected.hello.capabilities.some((item) => item.kind === 'action' && item.name === capability)
      if (!declared) throw new Error(`Adapter does not declare action capability: ${capability}`)
      assertActionRequest(request, gameId)
    } catch (error) {
      this.#trace(options.sessionId ?? 'system', gameId, 'action.executed', {
        requestId: request.requestId,
        capability,
        ok: false,
        revision: this.#observations.get(gameId)?.revision ?? 0,
        stage: 'core-validation',
        coreValidationMs: Math.max(0, Math.round(performance.now() - validationStartedAt)),
        adapterRoundTripMs: 0,
        durationMs: 0,
        errorCode: 'CORE_VALIDATION_FAILED',
      })
      throw error
    }
    const coreValidationMs = Math.max(0, Math.round(performance.now() - validationStartedAt))
    const adapterStartedAt = performance.now()
    let result: ActionResult
    try {
      result = await connected.adapter.execute(request)
      assertActionResult(request, result)
    } catch (error) {
      const adapterRoundTripMs = Math.max(0, Math.round(performance.now() - adapterStartedAt))
      const rawCode = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined
      const errorCode = typeof rawCode === 'string' || typeof rawCode === 'number' ? rawCode : 'ADAPTER_EXECUTION_FAILED'
      this.#trace(options.sessionId ?? 'system', gameId, 'action.executed', {
        requestId: request.requestId,
        capability,
        ok: false,
        revision: this.#observations.get(gameId)?.revision ?? 0,
        stage: 'adapter',
        coreValidationMs,
        adapterRoundTripMs,
        durationMs: adapterRoundTripMs,
        errorCode,
      })
      throw error
    }
    const adapterRoundTripMs = Math.max(0, Math.round(performance.now() - adapterStartedAt))
    this.#trace(options.sessionId ?? 'system', gameId, 'action.executed', {
      requestId: request.requestId,
      capability,
      ok: result.ok,
      revision: result.revision,
      coreValidationMs,
      adapterRoundTripMs,
      // Compatibility alias for existing consumers. New analysis views should
      // use the named segments above and the Adapter-reported timing below.
      durationMs: adapterRoundTripMs,
      ...(result.timing?.bridgeRoundTripMs === undefined ? {} : { bridgeRoundTripMs: result.timing.bridgeRoundTripMs }),
      ...(result.timing?.gameExecutionMs === undefined ? {} : { gameExecutionMs: result.timing.gameExecutionMs }),
      ...(result.ok ? {} : { errorCode: result.error?.code ?? 'UNKNOWN' }),
    })
    await this.observe(gameId, options.sessionId, { requestId: request.requestId, reason: 'post-action' })
    return result
  }

  /**
   * Execute one action requested by an Agent host such as DSH. This is the
   * shared action/action-result boundary used by both the standalone test
   * driver and the default DSH Binding.
   */
  async dispatchAgentAction(
    request: Omit<AgentRequest, 'message' | 'observation'>,
    action: AgentActionRequest,
    options: { actionNumber?: number } = {},
  ): Promise<AgentActionFeedback> {
    const callId = action.callId?.trim() || randomUUID()
    this.#trace(request.sessionId, request.gameId, 'agent.event', {
      eventType: 'action',
      callId,
      capability: action.capability,
      ...(options.actionNumber === undefined ? {} : { actionNumber: options.actionNumber }),
    })
    const feedback = await this.#executeAgentAction(request, action, callId)
    this.#trace(request.sessionId, request.gameId, 'agent.event', {
      eventType: 'action-result',
      callId,
      capability: feedback.capability,
      ok: feedback.result.ok,
      revision: feedback.result.revision,
    })
    return feedback
  }

  async *chat(
    driver: AgentDriver,
    request: Omit<AgentRequest, 'observation'>,
    options: AgentChatOptions = {},
  ): AsyncIterable<AgentEvent> {
    // Deterministic Mock/standalone conformance loop only. Production DSH Tool
    // calls enter through dispatchAgentAction(), not through a second Agent runtime.
    const maxActions = options.maxActions ?? 12
    if (!Number.isSafeInteger(maxActions) || maxActions < 1 || maxActions > 100) {
      throw new Error('maxActions must be an integer from 1 to 100')
    }
    const observation = await this.observe(request.gameId, request.sessionId)
    const stream = driver.stream({ ...request, observation })
    let actionCount = 0
    try {
      let step = await stream.next()
      while (!step.done) {
        const event = step.value
        if (event.type !== 'action') {
          // Reasoning/analysis content is deliberately not persisted in the
          // auditable trace. Public output is represented by type and size only.
          if (event.type !== 'analysis') {
            this.#trace(request.sessionId, request.gameId, 'agent.event', {
              eventType: event.type,
              characters: 'text' in event ? event.text.length : 0,
            })
          }
          yield event
          step = await stream.next()
          continue
        }

        actionCount += 1
        if (actionCount > maxActions) throw new Error(`Agent action limit exceeded: ${maxActions}`)
        const callId = event.callId?.trim() || randomUUID()
        const action: AgentActionRequest = { ...event, callId }
        yield action

        const feedback = await this.dispatchAgentAction(request, action, { actionNumber: actionCount })
        const resultEvent: AgentEvent = { type: 'action-result', ...feedback }
        yield resultEvent
        step = await stream.next(feedback)
      }
    } finally {
      await stream.return?.()
    }
  }

  listTraces(limit = 100): HarnessTrace[] {
    return this.#traces.slice(-Math.max(0, limit))
  }

  snapshot(): HarnessSnapshot {
    return {
      adapters: this.listAdapters(),
      observations: [...this.#observations.values()],
      traces: this.listTraces(),
    }
  }

  async close(): Promise<void> {
    for (const gameId of [...this.#adapters.keys()]) await this.disconnectAdapter(gameId)
    this.#publish()
  }

  #requireAdapter(gameId: string): ConnectedAdapter {
    const connected = this.#adapters.get(gameId)
    if (!connected) throw new Error(`Game is not connected: ${gameId}`)
    return connected
  }

  async #executeAgentAction(
    request: Omit<AgentRequest, 'message' | 'observation'>,
    action: AgentActionRequest,
    callId: string,
  ): Promise<AgentActionFeedback> {
    let current = this.#observations.get(request.gameId)
    if (!current) current = await this.observe(request.gameId, request.sessionId)
    const usesAutomaticRevision = action.expectedRevision === undefined
    if (usesAutomaticRevision) {
      current = await this.observe(request.gameId, request.sessionId, {
        requestId: callId,
        reason: 'manual',
      })
    }
    let result: ActionResult
    try {
      result = await this.executeAction(request.gameId, action.capability, action.arguments, {
        sessionId: request.sessionId,
        expectedRevision: action.expectedRevision ?? current.revision,
        requestId: callId,
      })
      if (usesAutomaticRevision && !result.ok && result.error?.code === 'REVISION_CONFLICT') {
        current = await this.observe(request.gameId, request.sessionId, {
          requestId: callId,
          reason: 'manual',
        })
        result = await this.executeAction(request.gameId, action.capability, action.arguments, {
          sessionId: request.sessionId,
          expectedRevision: current.revision,
          requestId: callId,
        })
      }
    } catch (error) {
      result = {
        requestId: callId,
        ok: false,
        revision: current.revision,
        error: {
          code: 'HARNESS_ACTION_REJECTED',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
    const latest = this.#observations.get(request.gameId) ?? current
    return { callId, capability: action.capability, result, observation: latest }
  }

  #trace(sessionId: string | undefined, gameId: string, kind: HarnessTrace['kind'], detail: Record<string, JsonValue>): void {
    this.#traces.push({
      traceId: randomUUID(),
      sessionId: sessionId ?? 'system',
      gameId,
      kind,
      createdAt: new Date().toISOString(),
      detail,
    })
    this.#publish()
  }

  #publish(): void {
    if (!this.#snapshotListeners.size) return
    const snapshot = this.snapshot()
    for (const listener of this.#snapshotListeners) listener(snapshot)
  }
}
