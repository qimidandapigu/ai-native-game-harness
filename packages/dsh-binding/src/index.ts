import {
  assertObjectJsonSchema,
  type JsonSchemaNode,
  type ObjectJsonSchema,
  type ToolDefinition,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import {
  isJsonObject,
  type AdapterCapability,
  type JsonObject,
  type JsonValue,
} from '@ai-native-game-harness/adapter-protocol'
import type {
  AgentActionFeedback,
  HarnessCore,
} from '@ai-native-game-harness/harness-core'

export interface DshToolRegistry {
  register(definition: ToolDefinition): () => void
}

export interface DshGameBindingOptions {
  /** Override the stable model-visible tool name when a product needs a custom namespace. */
  toolName?: (gameId: string, capability: AdapterCapability) => string
  /** Override DSH session correlation. By default Agent.id, DSH's canonical SessionId, is used. */
  sessionId?: (exec: ToolRunContext) => string
}

export interface DshGameToolsBinding {
  readonly gameId: string
  readonly toolNames: readonly string[]
  dispose(): void
}

const OPEN_ARGUMENTS_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: true,
}

const ACTION_FEEDBACK_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    callId: { type: 'string' },
    capability: { type: 'string' },
    result: {
      type: 'object',
      additionalProperties: false,
      properties: {
        requestId: { type: 'string' },
        ok: { type: 'boolean' },
        revision: { type: 'integer' },
        result: { type: 'object', additionalProperties: true },
        error: {
          type: 'object',
          additionalProperties: false,
          properties: { code: { type: 'string' }, message: { type: 'string' } },
          required: ['code', 'message'],
        },
      },
      required: ['requestId', 'ok', 'revision'],
    },
    observation: {
      type: 'object',
      additionalProperties: false,
      properties: {
        gameId: { type: 'string' },
        saveId: { type: 'string' },
        revision: { type: 'integer' },
        observedAt: { type: 'string' },
        state: { type: 'object', additionalProperties: true },
      },
      required: ['gameId', 'saveId', 'revision', 'observedAt', 'state'],
    },
  },
  required: ['callId', 'capability', 'result', 'observation'],
}

/**
 * Register one standard DSH Tool for every action declared by a connected game
 * Adapter. DSH continues to own model calls, Agent sessions, approval middleware
 * and durable tool logs; the tool body delegates only the game action to Core.
 */
export function bindDshGameTools(
  tools: DshToolRegistry,
  core: HarnessCore,
  gameId: string,
  options: DshGameBindingOptions = {},
): DshGameToolsBinding {
  const adapter = core.listAdapters().find(item => item.gameId === gameId)
  if (adapter === undefined) throw new Error(`Cannot bind DSH tools before the game Adapter connects: ${gameId}`)

  const actions = adapter.capabilities.filter(capability => capability.kind === 'action')
  const disposers: Array<() => void> = []
  const toolNames: string[] = []
  const seen = new Set<string>()

  try {
    for (const capability of actions) {
      const toolName = (options.toolName ?? defaultDshToolName)(gameId, capability)
      if (seen.has(toolName)) throw new Error(`DSH tool name collision for ${gameId}: ${toolName}`)
      seen.add(toolName)
      const parameters = capability.inputSchema ?? OPEN_ARGUMENTS_SCHEMA
      assertObjectJsonSchema(parameters)
      const definition = createActionTool(core, gameId, capability, toolName, parameters, options)
      disposers.push(tools.register(definition))
      toolNames.push(toolName)
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }

  let disposed = false
  return {
    gameId,
    toolNames,
    dispose() {
      if (disposed) return
      disposed = true
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

export function defaultDshToolName(gameId: string, capability: AdapterCapability): string {
  const normalized = `game_${gameId}_${capability.name}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (normalized.length <= 64) return normalized
  const suffix = stableHash(normalized)
  return `${normalized.slice(0, 55)}_${suffix}`
}

function createActionTool(
  core: HarnessCore,
  gameId: string,
  capability: AdapterCapability,
  toolName: string,
  parameters: ObjectJsonSchema,
  options: DshGameBindingOptions,
): ToolDefinition {
  return {
    name: toolName,
    description: [
      capability.description,
      'This action is executed by AI Native Game Harness against authoritative game state.',
      'Only claim success when the returned result has ok=true.',
    ].join(' '),
    parameters: parameters as unknown as Record<string, unknown>,
    output: {
      schema: ACTION_FEEDBACK_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderActionFeedback(value as JsonValue) }],
    },
    presentCall: args => ({
      card: 'generic',
      title: `Game action: ${capability.name}`,
      kind: 'execute',
      rawInput: args,
    }),
    async execute(args, exec) {
      if (!isJsonObject(args)) throw new Error('DSH game action arguments must be a JSON object')
      if (exec.signal.aborted) throw exec.signal.reason
      const sessionId = options.sessionId?.(exec) ?? String(exec.agent?.id ?? 'dsh')
      const feedback = await core.dispatchAgentAction({ sessionId, gameId }, {
        type: 'action',
        callId: String(exec.callId),
        capability: capability.name,
        arguments: args,
      })
      if (exec.signal.aborted) throw exec.signal.reason
      return feedbackToJson(feedback)
    },
  }
}

function feedbackToJson(feedback: AgentActionFeedback): JsonObject {
  const result: JsonObject = {
    requestId: feedback.result.requestId,
    ok: feedback.result.ok,
    revision: feedback.result.revision,
  }
  if (feedback.result.result !== undefined) result.result = feedback.result.result
  if (feedback.result.error !== undefined) {
    result.error = { code: feedback.result.error.code, message: feedback.result.error.message }
  }
  return {
    callId: feedback.callId,
    capability: feedback.capability,
    result,
    observation: {
      gameId: feedback.observation.gameId,
      saveId: feedback.observation.saveId,
      revision: feedback.observation.revision,
      observedAt: feedback.observation.observedAt,
      state: feedback.observation.state,
    },
  }
}

function renderActionFeedback(value: JsonValue): string {
  if (!isJsonObject(value) || !isJsonObject(value.result) || !isJsonObject(value.observation)) {
    return 'The Harness returned an invalid game action result. Do not claim success.'
  }
  const ok = value.result.ok === true
  const revision = value.result.revision
  const outcome = ok
    ? `succeeded at authoritative revision ${String(revision)}`
    : `failed at authoritative revision ${String(revision)}: ${renderError(value.result.error)}`
  return [
    `Game action ${String(value.capability)} ${outcome}.`,
    `ActionResult: ${JSON.stringify(value.result)}`,
    `Latest authoritative observation: ${JSON.stringify(value.observation)}`,
    ok ? 'You may report this action as successful.' : 'Do not claim this action succeeded.',
  ].join('\n')
}

function renderError(value: JsonValue | undefined): string {
  if (!isJsonObject(value)) return 'unknown game rejection'
  return `${String(value.code)} - ${String(value.message)}`
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
