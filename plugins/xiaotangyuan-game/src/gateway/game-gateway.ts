import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkOrchestratorService } from '@qimidandapigu/dsh-work-orchestrator'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import {
  readAdapterHello,
  readGameCompose,
  readGameChat,
  readGameRetry,
  readGameSpeak,
  readStateUpdate,
  readStateUpdateSaveId,
  type AdapterHello,
  type GameChatContext,
} from '../protocol/game.js'
import { failure, parseRpcRequest, success, type RpcRequest } from '../protocol/json-rpc.js'
import { GameAgentSession } from '../runtime/agent/game-agent-session.js'
import { MultimodalRouter } from '../runtime/multimodal/multimodal-router.js'
import type { VoiceInteractionHandler } from '../runtime/speech/speech-controller.js'
import type { ResolvedConfig } from '../config.js'
import type { MemoryService } from '../runtime/memory/memory-service.js'
import type { SkillService } from '../runtime/skills/skill-service.js'
import type { SkillValue } from '../runtime/skills/contracts.js'
import { normalizeGameContext } from '../runtime/context/game-context.js'

function normalizeContextObservation(context: GameChatContext | undefined, adapter: AdapterHello | undefined): void {
  if (context?.observation !== undefined) context.observation = normalizeGameContext(context.observation, adapter).value
}

export async function playPresentedSpeech(
  speak: () => Promise<void>,
  speechStarted: () => void,
  speechFinished: () => void,
): Promise<void> {
  speechStarted()
  try {
    await speak()
  } finally {
    speechFinished()
  }
}

export function playerFacingVoiceFailure(message: string): string {
  if (/fetch failed|network|socket|econn|enotfound|connection/i.test(message)) {
    return '网络刚才有点不稳，我没能回答出来。请再问我一次吧。'
  }
  if (/timeout|timed out|超时/i.test(message)) {
    return '这次等得太久了，我先停下来。请再问我一次吧。'
  }
  if (/credential|api key|凭据|密钥/i.test(message)) {
    return '我的模型配置暂时不可用，请到桌面设置里检查一下。'
  }
  return '我这次没能回答出来，请再问我一次吧。'
}

export function gatewayReadyParams(adapterProtocolUrl: string): Record<string, unknown> {
  return {
    protocolVersion: '1.1',
    adapterProtocolUrl,
    capabilities: [
      'assistant.text-stream',
      'assistant.autonomous-speech',
      'speech.asr-stream',
      'speech.tts-stream',
      'speech.barge-in',
      'adapter.endpoint-discovery',
    ],
  }
}

export function globalPushToTalkProcessIds(adapters: readonly (AdapterHello | undefined)[]): number[] {
  return [...new Set(adapters
    .filter(adapter => adapter?.gameId !== 'oxygen-not-included')
    .map(adapter => adapter?.processId)
    .filter((value): value is number => value !== undefined))]
}

export function matchPostReplyVoiceCommand(
  adapter: AdapterHello | undefined,
  transcript: string,
  reply: string,
): string | undefined {
  const text = transcript.replace(/[\s，。！？、,.!?]/g, '')
  if (text === '' || /(?:不要|不用|别|不准)/.test(text)
    || /(?:吗|么)$|(?:怎么|为什么|能不能|会不会|可不可以)/.test(text)) return undefined
  const answer = reply.replace(/[\s，。！？、,.!?]/g, '')
  if (/(?:不行|不能|没法|无法|做不到|先别|不要|拒绝|不帮|不想)/.test(answer)) return undefined
  for (const command of adapter?.voiceCommands ?? []) {
    for (const rawPhrase of command.phrases) {
      const phrase = rawPhrase.replace(/[\s，。！？、,.!?]/g, '')
      if (text === phrase
        || (text.length <= 24 && text.includes(phrase) && /(?:请|帮我|给我|现在|这里|这边|一下|把|吧)/.test(text))) {
        return command.atom
      }
    }
  }
  return undefined
}

interface PendingAdapterRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface ConnectionState {
  socket: WebSocket
  adapter?: AdapterHello
  session?: GameAgentSession
  latestObservation?: Record<string, unknown>
  latestSaveId?: string
  queue: Promise<void>
  lastInteractionAt: number
  proactiveInFlight: boolean
  speechQueue: Promise<void>
  streamingInteractions: Set<string>
  memorySessionKey: string
  pendingAdapterRequests: Map<string, PendingAdapterRequest>
  postReplyAction?: AbortController
}

const PROACTIVE_PROMPT = [
  '玩家已经一段时间没有和你说话了。',
  '观察当前游戏画面，主动说一句简短、自然、符合当前情况的话。',
  '有值得提醒的事情就给出实用提醒；没有要紧事就轻松陪伴或随口聊聊。',
  '不要提到定时器、截图、系统提示或“玩家没有说话”。',
].join('')

export class GameGateway implements VoiceInteractionHandler {
  private server?: WebSocketServer
  private readonly connections = new Set<ConnectionState>()
  private proactiveTimer?: ReturnType<typeof setInterval>

  constructor(
    private readonly ctx: Context,
    private readonly host: string,
    private readonly port: number,
    private readonly multimodal: MultimodalRouter,
    private readonly memory: MemoryService | undefined,
    private readonly skills: SkillService | undefined,
    private readonly work: WorkOrchestratorService,
    private readonly proactiveChat: ResolvedConfig['proactiveChat'],
    private readonly processTargetsChanged: (processIds: readonly number[]) => void,
    private readonly feedbackEnabled: boolean,
    private readonly speak: (text: string, signal: AbortSignal) => Promise<void>,
    private readonly appendSpeechDelta: (processId: number, interactionId: string, delta: string) => Promise<void>,
    private readonly finishSpeechReply: (processId: number, interactionId: string, finalText: string) => Promise<boolean>,
    private readonly startRecording: (processId: number) => boolean = () => false,
    private readonly stopRecording: (processId: number) => boolean = () => false,
    private readonly adapterProtocolUrl: string = 'ws://127.0.0.1:33245/adapter',
  ) {}

  async start(retryDelaysMs: readonly number[] = [300, 700, 1_500, 3_000]): Promise<void> {
    if (this.server !== undefined) return
    let lastError: unknown
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
      if (attempt > 0) {
        const delayMs = retryDelaysMs[attempt - 1]!
        this.ctx.logger.warn(`xiaotangyuan-game: ${this.host}:${this.port} 暂时被占用，${delayMs}ms 后重试（${attempt}/${retryDelaysMs.length}）`)
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
      try {
        const server = await this.listenOnce()
        this.server = server
        console.info(`[dsh-xiaotangyuan-game] listening on ws://${this.host}:${this.port}`)
        this.proactiveTimer = setInterval(() => {
          void this.runProactiveCycle().catch(error => {
            this.ctx.logger.warn('xiaotangyuan-game: 主动聊天调度失败')
            this.ctx.logger.warn(error)
          })
        }, 1_000)
        return
      } catch (error) {
        lastError = error
        if (!isAddressInUse(error) || attempt === retryDelaysMs.length) break
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError)
    throw new Error(`小汤圆游戏 Gateway 无法监听 ws://${this.host}:${this.port}：${detail}`, { cause: lastError })
  }

  private async listenOnce(): Promise<WebSocketServer> {
    const server = new WebSocketServer({ host: this.host, port: this.port, maxPayload: 1024 * 1024 })
    server.on('connection', socket => this.onConnection(socket))
    try {
      await new Promise<void>((resolve, reject) => {
        const onListening = (): void => {
          server.off('error', onError)
          resolve()
        }
        const onError = (error: Error): void => {
          server.off('listening', onListening)
          reject(error)
        }
        server.once('listening', onListening)
        server.once('error', onError)
      })
    } catch (error) {
      await closeWebSocketServer(server)
      throw error
    }
    server.on('error', error => {
      console.error('[dsh-xiaotangyuan-game] WebSocket server error', error)
    })
    return server
  }

  private onConnection(socket: WebSocket): void {
    const state: ConnectionState = {
      socket,
      queue: Promise.resolve(),
      lastInteractionAt: Date.now(),
      proactiveInFlight: false,
      speechQueue: Promise.resolve(),
      streamingInteractions: new Set(),
      memorySessionKey: randomUUID(),
      pendingAdapterRequests: new Map(),
    }
    this.connections.add(state)
    this.send(socket, {
      jsonrpc: '2.0',
      method: 'gateway.ready',
      params: gatewayReadyParams(this.adapterProtocolUrl),
    })

    socket.on('message', (data) => {
      if (this.handleAdapterResponse(state, data)) return
      state.queue = state.queue
        .then(() => this.onMessage(state, data))
        .catch(error => {
          console.error('[dsh-xiaotangyuan-game] request processing failed', error)
        })
    })
    socket.on('close', () => {
      state.postReplyAction?.abort(new Error('游戏 Adapter 已断开'))
      for (const pending of state.pendingAdapterRequests.values()) pending.reject(new Error('游戏 Adapter 已断开'))
      state.pendingAdapterRequests.clear()
      this.connections.delete(state)
      this.memory?.endSession(state.memorySessionKey)
      this.publishProcessTargets()
      void state.session?.dispose().catch(error => {
        console.error('[dsh-xiaotangyuan-game] failed to dispose game agent', error)
      })
    })
  }

  private async onMessage(state: ConnectionState, data: RawData): Promise<void> {
    let request: RpcRequest
    try {
      request = parseRpcRequest(data.toString())
    } catch (error) {
      this.send(state.socket, failure(null, -32700, error instanceof Error ? error.message : String(error)))
      return
    }

    if (request.id === undefined) {
      try {
        await this.dispatch(state, request)
      } catch (error) {
        this.ctx.logger.warn('xiaotangyuan-game: 适配器通知处理失败')
        this.ctx.logger.warn(error)
      }
      return
    }
    try {
      const result = await this.dispatch(state, request)
      this.send(state.socket, success(request.id, result))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.send(state.socket, failure(request.id, -32000, message))
    }
  }

  private async dispatch(state: ConnectionState, request: RpcRequest): Promise<unknown> {
    switch (request.method) {
      case 'adapter.hello': {
        if (state.session !== undefined) throw new Error('adapter.hello may only be sent once per connection')
        state.adapter = readAdapterHello(request.params)
        state.latestSaveId = state.adapter.saveId
        this.memory?.adapterConnected(state.memorySessionKey, state.adapter)
        state.session = new GameAgentSession(
          this.ctx,
          state.adapter,
          this.multimodal,
          this.memory,
          this.skills,
          this.work,
          (atom, args, signal) => this.callAdapterAtom(state, atom, args, signal),
          state.memorySessionKey,
          this.feedbackEnabled,
          update => {
            if (update.source !== 'voice') {
              if (!state.streamingInteractions.has(update.interactionId)) {
                state.streamingInteractions.add(update.interactionId)
                this.notify(state, 'assistant.text.start', {
                  interactionId: update.interactionId,
                  source: update.source,
                })
              }
              this.notify(state, 'assistant.text.delta', update)
              if (state.adapter?.capabilities?.includes('assistant.text-stream') !== true) {
                this.notify(state, 'assistant.delta', update)
              }
            }
            if (update.source === 'voice' && state.adapter?.processId !== undefined) {
              state.speechQueue = state.speechQueue.then(() => this.appendSpeechDelta(state.adapter!.processId!, update.interactionId, update.delta)).catch(error => {
                this.ctx.logger.warn('xiaotangyuan-game: 流式语音合成入队失败')
                this.ctx.logger.warn(error)
              })
            }
          },
          update => {
            if (!this.connections.has(state) || state.socket.readyState !== WebSocket.OPEN) return
            const interactionId = randomUUID()
            this.notify(state, 'assistant.present', {
              text: update.text,
              source: 'work',
              workSessionId: update.workSessionId,
              title: update.title,
              executor: update.executor,
              status: update.status,
              ...(update.codexThreadId === undefined ? {} : { codexThreadId: update.codexThreadId }),
            })
            this.finishTextStream(state, interactionId, update.text, 'work')
            if (update.source === 'voice' && state.adapter?.processId !== undefined) {
              const processId = state.adapter.processId
              state.speechQueue = state.speechQueue.then(() => playPresentedSpeech(
                () => this.speak(update.text, AbortSignal.timeout(120_000)),
                () => this.speechStarted(processId, interactionId),
                () => this.speechFinished(processId, interactionId),
              )).catch(error => {
                  this.ctx.logger.warn('xiaotangyuan-game: 后台工作更新已显示，但语音播放失败')
                  this.ctx.logger.warn(error)
                })
            }
          },
        )
        void state.session.warmup(state.latestSaveId).catch(error => {
          this.ctx.logger.warn('xiaotangyuan-game: 陪聊 Session 预热失败；首次对话时会自动重试')
          this.ctx.logger.warn(error)
        })
        this.publishProcessTargets()
        return { accepted: true, protocolVersion: '1.1' }
      }
      case 'gateway.ping':
        return { pong: true }
      case 'chat.send': {
        if (state.session === undefined) throw new Error('adapter.hello must be sent before chat.send')
        this.markInteraction(state)
        const chat = readGameChat(request.params)
        normalizeContextObservation(chat.context, state.adapter)
        if (chat.context?.saveId !== undefined) state.latestSaveId = chat.context.saveId
        if (chat.context?.observation !== undefined) state.latestObservation = chat.context.observation
        const result = await state.session.ask(chat)
        this.finishTextStream(state, result.interactionId, result.reply, 'chat')
        this.schedulePostReplyAction(state, chat.text, result.reply, result.interactionId)
        return result
      }
      case 'chat.retry': {
        if (state.session === undefined) throw new Error('adapter.hello must be sent before chat.retry')
        this.markInteraction(state)
        const retry = readGameRetry(request.params)
        normalizeContextObservation(retry.context, state.adapter)
        if (retry.context?.saveId !== undefined) state.latestSaveId = retry.context.saveId
        if (retry.context?.observation !== undefined) state.latestObservation = retry.context.observation
        const result = await state.session.retry(retry.context)
        this.finishTextStream(state, result.interactionId, result.reply, 'retry')
        this.notify(state, 'assistant.present', { text: result.reply, source: 'retry' })
        const processId = state.adapter?.processId
        state.speechQueue = state.speechQueue.then(() => processId === undefined
          ? this.speak(result.reply, AbortSignal.timeout(120_000))
          : playPresentedSpeech(
              () => this.speak(result.reply, AbortSignal.timeout(120_000)),
              () => this.speechStarted(processId, result.interactionId),
              () => this.speechFinished(processId, result.interactionId),
            )).catch(error => {
          const message = error instanceof Error ? error.message : String(error)
          this.notify(state, 'assistant.error', { message: `重试回复已生成，但语音播放失败：${message}` })
        })
        return result
      }
      case 'assistant.compose': {
        if (state.session === undefined) throw new Error('adapter.hello must be sent before assistant.compose')
        this.markInteraction(state)
        const chat = readGameCompose(request.params)
        normalizeContextObservation(chat.context, state.adapter)
        if (chat.context?.saveId !== undefined) state.latestSaveId = chat.context.saveId
        if (chat.context?.observation !== undefined) state.latestObservation = chat.context.observation
        const result = await state.session.compose(chat)
        if (chat.speak) {
          const processId = state.adapter?.processId
          state.speechQueue = state.speechQueue.then(async () => {
            this.notify(state, 'assistant.status', { status: 'speaking' })
            try {
              if (processId === undefined) {
                await this.speak(result.reply, AbortSignal.timeout(120_000))
              } else {
                await playPresentedSpeech(
                  () => this.speak(result.reply, AbortSignal.timeout(120_000)),
                  () => this.speechStarted(processId, result.interactionId),
                  () => this.speechFinished(processId, result.interactionId),
                )
              }
            } finally {
              this.notify(state, 'assistant.status', { status: 'ready' })
            }
          }).catch(error => {
            this.ctx.logger.warn('xiaotangyuan-game: 陪伴文本已生成，但可选语音播放失败')
            this.ctx.logger.warn(error)
          })
        }
        return result
      }
      case 'assistant.speak': {
        if (state.session === undefined) throw new Error('adapter.hello must be sent before assistant.speak')
        this.markInteraction(state)
        const speech = readGameSpeak(request.params)
        const interactionId = randomUUID()
        const processId = state.adapter?.processId
        this.notify(state, 'assistant.status', { status: 'speaking' })
        try {
          if (processId === undefined) {
            await this.speak(speech.text, AbortSignal.timeout(120_000))
          } else {
            await playPresentedSpeech(
              () => this.speak(speech.text, AbortSignal.timeout(120_000)),
              () => this.speechStarted(processId, interactionId),
              () => this.speechFinished(processId, interactionId),
            )
          }
          return { accepted: true }
        } finally {
          this.notify(state, 'assistant.status', { status: 'ready' })
        }
      }
      case 'state.update': {
        state.latestObservation = normalizeGameContext(readStateUpdate(request.params), state.adapter).value
        const saveId = readStateUpdateSaveId(request.params)
        if (saveId !== undefined) state.latestSaveId = saveId
        this.memory?.observeSession(state.memorySessionKey, state.adapter, {
          text: 'state heartbeat',
          context: {
            ...(saveId === undefined ? {} : { saveId }),
            observation: state.latestObservation,
          },
        })
        return { accepted: true }
      }
      case 'voice.start': {
        const processId = state.adapter?.processId
        if (processId === undefined) throw new Error('adapter.hello must provide processId before voice.start')
        if (!this.startRecording(processId)) throw new Error('Windows 媒体服务尚未启动')
        return { accepted: true }
      }
      case 'voice.stop': {
        const processId = state.adapter?.processId
        if (processId === undefined) throw new Error('adapter.hello must provide processId before voice.stop')
        if (!this.stopRecording(processId)) throw new Error('Windows 媒体服务尚未启动')
        return { accepted: true }
      }
      default:
        throw new Error(`unknown method: ${request.method}`)
    }
  }

  private markInteraction(state: ConnectionState): void {
    state.lastInteractionAt = Date.now()
  }

  private handleAdapterResponse(state: ConnectionState, data: RawData): boolean {
    let value: unknown
    try {
      value = JSON.parse(data.toString())
    } catch {
      return false
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const record = value as Record<string, unknown>
    if (record.method !== undefined || (typeof record.id !== 'string' && typeof record.id !== 'number')) return false
    const pending = state.pendingAdapterRequests.get(String(record.id))
    if (pending === undefined) return false
    state.pendingAdapterRequests.delete(String(record.id))
    const error = record.error
    if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
      const message = (error as Record<string, unknown>).message
      pending.reject(new Error(typeof message === 'string' ? message : '游戏原子能力执行失败'))
    } else {
      pending.resolve(record.result)
    }
    return true
  }

  private async callAdapterAtom(
    state: ConnectionState,
    atom: string,
    args: Record<string, SkillValue>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const declared = state.adapter?.atoms?.some(definition => definition.name === atom) === true
      || state.adapter?.capabilities?.includes(atom) === true
    if (!declared) throw new Error(`Adapter 未声明原子能力：${atom}`)
    if (state.socket.readyState !== WebSocket.OPEN) throw new Error('游戏 Adapter 未连接')
    const id = randomUUID()
    return await new Promise<unknown>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        state.pendingAdapterRequests.delete(id)
      }
      const onAbort = () => {
        cleanup()
        reject(signal.reason instanceof Error ? signal.reason : new Error('技能执行已取消'))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`游戏原子能力超时：${atom}`))
      }, 15_000)
      state.pendingAdapterRequests.set(id, {
        resolve: value => { cleanup(); resolve(value) },
        reject: error => { cleanup(); reject(error) },
      })
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) {
        onAbort()
        return
      }
      this.send(state.socket, {
        jsonrpc: '2.0', id, method: 'game.atom.execute',
        params: { atom, arguments: args },
      })
    })
  }

  private async runProactiveCycle(): Promise<void> {
    if (!this.proactiveChat.enabled) return
    const now = Date.now()
    const intervalMs = this.proactiveChat.intervalSeconds * 1_000
    const due = [...this.connections].filter(state =>
      state.socket.readyState === WebSocket.OPEN
      && state.session !== undefined
      && !state.proactiveInFlight
      && now - state.lastInteractionAt >= intervalMs)
    const scheduled = due.map(state => {
      state.proactiveInFlight = true
      state.lastInteractionAt = now
      const task = state.queue.then(() => this.runProactiveChat(state))
      state.queue = task.catch(error => {
        this.ctx.logger.warn('xiaotangyuan-game: 主动聊天队列执行失败')
        this.ctx.logger.warn(error)
      })
      return task
    })
    await Promise.allSettled(scheduled)
  }

  private async runProactiveChat(state: ConnectionState): Promise<void> {
    if (state.session === undefined) {
      state.proactiveInFlight = false
      return
    }
    try {
      const context: GameChatContext = {
        ...(state.latestSaveId === undefined ? {} : { saveId: state.latestSaveId }),
        ...(state.latestObservation === undefined ? {} : { observation: state.latestObservation }),
      }
      const result = await state.session.compose({ text: PROACTIVE_PROMPT, context })
      if (!this.connections.has(state) || state.socket.readyState !== WebSocket.OPEN) return
      this.notify(state, 'assistant.present', { text: result.reply, source: 'proactive' })
      this.finishTextStream(state, result.interactionId, result.reply, 'proactive')
      try {
        const processId = state.adapter?.processId
        if (processId === undefined) {
          await this.speak(result.reply, AbortSignal.timeout(120_000))
        } else {
          await playPresentedSpeech(
            () => this.speak(result.reply, AbortSignal.timeout(120_000)),
            () => this.speechStarted(processId, result.interactionId),
            () => this.speechFinished(processId, result.interactionId),
          )
        }
      } catch (error) {
        this.ctx.logger.warn(`xiaotangyuan-game: ${state.adapter?.gameId ?? 'unknown'} 主动回复已显示，但语音播放失败`)
        this.ctx.logger.warn(error)
      }
    } catch (error) {
      this.ctx.logger.warn(`xiaotangyuan-game: ${state.adapter?.gameId ?? 'unknown'} 主动聊天生成失败`)
      this.ctx.logger.warn(error)
    } finally {
      state.proactiveInFlight = false
    }
  }

  private publishProcessTargets(): void {
    this.processTargetsChanged(globalPushToTalkProcessIds(
      [...this.connections].map(connection => connection.adapter),
    ))
  }

  private connectionForProcess(processId: number): ConnectionState | undefined {
    return [...this.connections].find(connection => connection.adapter?.processId === processId)
  }

  private notify(connection: ConnectionState, method: string, params: unknown): void {
    this.send(connection.socket, { jsonrpc: '2.0', method, params })
  }

  recordingStarted(processId: number): void {
    const connection = this.connectionForProcess(processId)
    if (connection !== undefined) {
      connection.postReplyAction?.abort(new Error('玩家开始了新的语音输入'))
      connection.postReplyAction = undefined
      connection.session?.cancel()
      connection.streamingInteractions.clear()
      this.notify(connection, 'assistant.text.cancel', { reason: 'barge-in' })
      this.notify(connection, 'assistant.status', { status: 'recording' })
    }
  }

  async respond(processId: number, transcript: string, signal: AbortSignal): Promise<{
    reply: string
    speechPlayed: boolean
    sessionId: string
    interactionId: string
    gameId: string
  }> {
    const connection = this.connectionForProcess(processId)
    if (connection?.session === undefined) throw new Error('前台游戏没有连接到小汤圆 Gateway')
    signal.throwIfAborted()
    this.markInteraction(connection)
    const context: GameChatContext = {
      ...(connection.latestSaveId === undefined ? {} : { saveId: connection.latestSaveId }),
      ...(connection.latestObservation === undefined ? {} : { observation: connection.latestObservation }),
    }
    const cancelAgent = (): void => connection.session?.cancel()
    signal.addEventListener('abort', cancelAgent, { once: true })
    try {
      this.notify(connection, 'assistant.status', { status: 'thinking', transcript })
      const result = await connection.session.ask({ text: transcript, context }, 'voice')
      signal.throwIfAborted()
      // The in-game caption is a primary response channel, not a side effect of
      // TTS playback. Publish the complete answer as soon as the model turn
      // finishes so a slow or missing speech-sync event cannot leave players
      // with audio only.
      this.notify(connection, 'assistant.present', { text: result.reply, source: 'voice' })
      this.finishTextStream(connection, result.interactionId, result.reply, 'voice')
      this.schedulePostReplyAction(connection, transcript, result.reply, result.interactionId)
      await connection.speechQueue
      signal.throwIfAborted()
      const speechPlayed = await this.finishSpeechReply(processId, result.interactionId, result.reply)
      signal.throwIfAborted()
      if (speechPlayed) this.speechFinished(processId, result.interactionId)
      return {
        reply: result.reply,
        speechPlayed,
        sessionId: result.sessionId,
        interactionId: result.interactionId,
        gameId: connection.adapter?.gameId ?? 'unknown',
      }
    } finally {
      signal.removeEventListener('abort', cancelAgent)
    }
  }

  failed(processId: number, message: string): void {
    const connection = this.connectionForProcess(processId)
    if (connection !== undefined) this.notify(connection, 'assistant.error', { message: playerFacingVoiceFailure(message) })
  }

  private send(socket: WebSocket, payload: unknown): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
  }

  recordingStopped(processId: number): void {
    const connection = this.connectionForProcess(processId)
    if (connection !== undefined) this.notify(connection, 'assistant.status', { status: 'recognizing' })
  }

  private schedulePostReplyAction(
    connection: ConnectionState,
    transcript: string,
    reply: string,
    interactionId: string,
  ): void {
    const atom = matchPostReplyVoiceCommand(connection.adapter, transcript, reply)
    if (atom === undefined) return
    connection.postReplyAction?.abort(new Error('新的游戏动作已取代上一动作'))
    const controller = new AbortController()
    connection.postReplyAction = controller
    queueMicrotask(() => {
      void this.runPostReplyAction(connection, atom, interactionId, controller).catch(error => {
        this.ctx.logger.warn(`xiaotangyuan-game: 回复已完成，但后置游戏动作 ${atom} 执行失败`)
        this.ctx.logger.warn(error)
      })
    })
  }

  private async runPostReplyAction(
    connection: ConnectionState,
    atom: string,
    interactionId: string,
    controller: AbortController,
  ): Promise<void> {
    try {
      this.notify(connection, 'assistant.status', { status: 'acting' })
      const value = await this.callAdapterAtom(connection, atom, {}, controller.signal)
      const record = typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
      const succeeded = typeof record?.success === 'boolean'
        ? record.success
        : typeof record?.ok === 'boolean' ? record.ok : true
      const detail = typeof record?.reply === 'string' && record.reply.trim() !== ''
        ? record.reply.trim()
        : succeeded ? '动作已执行。' : '游戏拒绝了这次动作。'
      this.notify(connection, 'assistant.action.result', {
        interactionId,
        atom,
        success: succeeded,
        text: succeeded ? detail : `动作执行失败：${detail}`,
      })
    } catch (error) {
      if (controller.signal.aborted) return
      const text = error instanceof Error ? error.message : String(error)
      this.notify(connection, 'assistant.action.result', {
        interactionId,
        atom,
        success: false,
        text: `动作执行失败：${text}`,
      })
      throw error
    } finally {
      if (connection.postReplyAction === controller) {
        connection.postReplyAction = undefined
        this.notify(connection, 'assistant.status', { status: 'idle' })
      }
    }
  }

  speechStarted(processId: number, interactionId: string): void {
    const connection = this.connectionForProcess(processId)
    if (connection !== undefined) this.notify(connection, 'assistant.speech.start', { interactionId })
  }

  speechPhraseStarted(processId: number, interactionId: string, phrase: string, text: string): void {
    const connection = this.connectionForProcess(processId)
    if (connection === undefined) return
    if (!connection.streamingInteractions.has(interactionId)) {
      connection.streamingInteractions.add(interactionId)
      this.notify(connection, 'assistant.text.start', { interactionId, source: 'voice' })
    }
    this.notify(connection, 'assistant.speech.phrase', { interactionId, phrase, text })
    if (connection.adapter?.capabilities?.includes('assistant.speech-sync') !== true) {
      this.notify(connection, 'assistant.present', { interactionId, text, source: 'voice', streaming: true })
    }
  }

  speechFinished(processId: number, interactionId: string): void {
    const connection = this.connectionForProcess(processId)
    if (connection !== undefined) this.notify(connection, 'assistant.speech.done', { interactionId })
  }

  private finishTextStream(connection: ConnectionState, interactionId: string, text: string, source: string): void {
    connection.streamingInteractions.delete(interactionId)
    this.notify(connection, 'assistant.text.done', { interactionId, text, source })
  }

  async close(): Promise<void> {
    if (this.proactiveTimer !== undefined) clearInterval(this.proactiveTimer)
    this.proactiveTimer = undefined
    const sessions: GameAgentSession[] = []
    for (const connection of this.connections) {
      connection.postReplyAction?.abort(new Error('gateway shutting down'))
      this.memory?.endSession(connection.memorySessionKey)
      connection.socket.close(1001, 'gateway shutting down')
      if (connection.session !== undefined) sessions.push(connection.session)
    }
    this.connections.clear()
    await Promise.allSettled(sessions.map(session => session.dispose()))
    const server = this.server
    this.server = undefined
    if (server !== undefined) await closeWebSocketServer(server)
  }
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EADDRINUSE'
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  await new Promise<void>(resolve => {
    try {
      server.close(() => resolve())
    } catch {
      resolve()
    }
  })
}
