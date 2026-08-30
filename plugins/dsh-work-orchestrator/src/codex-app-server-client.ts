import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface, type Interface as ReadLineInterface } from 'node:readline'

export interface CodexAppServerOptions {
  executable: string
  cwd: string
  model?: string
  reasoningEffort?: string
  requestTimeoutMs?: number
  turnTimeoutMs?: number
}

export interface CodexProgress {
  kind: 'message' | 'command' | 'file-change'
  text: string
}

export interface CodexWorkerClient {
  startThread(title: string): Promise<string>
  resumeThread(threadId: string): Promise<void>
  runTurn(threadId: string, prompt: string, onProgress?: (progress: CodexProgress) => void): Promise<string>
  close(): Promise<void>
}

interface RpcPending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface TurnPending {
  threadId: string
  turnId?: string
  text: string
  onProgress?: (progress: CodexProgress) => void
  resolve: (text: string) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type RpcMessage = Record<string, unknown> & { id?: number | string; method?: string; params?: Record<string, unknown> }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function errorMessage(value: unknown): string {
  const record = asRecord(value)
  return typeof record?.message === 'string' ? record.message : JSON.stringify(value)
}

function finalAgentText(turn: Record<string, unknown> | undefined): string {
  const items = Array.isArray(turn?.items) ? turn.items : []
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = asRecord(items[index])
    if (item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim() !== '') return item.text.trim()
  }
  return ''
}

function resolveExecutable(configured: string): string {
  if (configured !== 'codex' || process.platform !== 'win32') return configured
  const localAppData = process.env.LOCALAPPDATA?.trim()
  if (localAppData === undefined || localAppData === '') return configured
  const binRoot = join(localAppData, 'OpenAI', 'Codex', 'bin')
  if (!existsSync(binRoot)) return configured
  for (const directory of readdirSync(binRoot).sort().reverse()) {
    const candidate = join(binRoot, directory, 'codex.exe')
    if (existsSync(candidate)) return candidate
  }
  return configured
}

/** Minimal, version-tolerant JSONL client for `codex app-server` over stdio. */
export class CodexAppServerClient implements CodexWorkerClient {
  private child?: ChildProcessWithoutNullStreams
  private lines?: ReadLineInterface
  private startPromise?: Promise<void>
  private nextId = 1
  private readonly requests = new Map<number | string, RpcPending>()
  private readonly turns = new Set<TurnPending>()
  private stderrTail = ''
  private closing = false

  constructor(private readonly options: CodexAppServerOptions) {}

  private async ensureStarted(): Promise<void> {
    if (this.startPromise !== undefined) return await this.startPromise
    this.startPromise = this.start()
    return await this.startPromise
  }

  private async start(): Promise<void> {
    const child = spawn(resolveExecutable(this.options.executable), ['app-server'], {
      cwd: this.options.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-4_000)
    })
    this.lines = createInterface({ input: child.stdout })
    this.lines.on('line', line => this.onLine(line))
    child.once('error', error => this.failAll(new Error(`Codex App Server failed to start: ${error.message}`)))
    child.once('exit', (code, signal) => {
      if (!this.closing) {
        const detail = this.stderrTail.trim()
        this.failAll(new Error(`Codex App Server exited (${code ?? signal ?? 'unknown'})${detail === '' ? '' : `: ${detail}`}`))
      }
    })
    await this.request('initialize', {
      clientInfo: { name: 'dsh-work-orchestrator', title: 'DSH Work Orchestrator', version: '0.1.0' },
      capabilities: null,
    })
    this.notify('initialized', {})
  }

  private write(message: unknown): void {
    if (this.child?.stdin.writable !== true) throw new Error('Codex App Server is not writable')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    if (method !== 'initialize') await this.ensureStarted()
    const id = this.nextId++
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id)
        reject(new Error(`Codex App Server request timed out: ${method}`))
      }, this.options.requestTimeoutMs ?? 30_000)
      this.requests.set(id, { resolve, reject, timer })
      try {
        this.write({ method, id, params })
      } catch (error) {
        clearTimeout(timer)
        this.requests.delete(id)
        reject(error)
      }
    })
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params })
  }

  private onLine(line: string): void {
    let message: RpcMessage
    try {
      message = JSON.parse(line) as RpcMessage
    } catch {
      return
    }
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.requests.get(message.id)
      if (pending === undefined) return
      clearTimeout(pending.timer)
      this.requests.delete(message.id)
      if ('error' in message) pending.reject(new Error(`Codex App Server error: ${errorMessage(message.error)}`))
      else pending.resolve(message.result)
      return
    }
    if (message.id !== undefined && message.method !== undefined) {
      const result = message.method.includes('requestApproval')
        ? { decision: 'decline' }
        : undefined
      if (result === undefined) this.write({ id: message.id, error: { code: -32601, message: 'Unsupported server request' } })
      else this.write({ id: message.id, result })
      return
    }
    if (message.method !== undefined) this.onNotification(message.method, message.params ?? {})
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined
    const turnRecord = asRecord(params.turn)
    const turnId = typeof params.turnId === 'string'
      ? params.turnId
      : typeof turnRecord?.id === 'string' ? turnRecord.id : undefined
    if (threadId === undefined) return
    const pending = [...this.turns].find(turn => turn.threadId === threadId && (turn.turnId === undefined || turn.turnId === turnId))
    if (pending === undefined) return
    if (turnId !== undefined) pending.turnId = turnId

    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      pending.text += params.delta
      pending.onProgress?.({ kind: 'message', text: params.delta })
      return
    }
    if (method === 'item/completed') {
      const item = asRecord(params.item)
      if (item?.type === 'agentMessage' && typeof item.text === 'string') pending.text = item.text
      if (item?.type === 'commandExecution') pending.onProgress?.({ kind: 'command', text: typeof item.command === 'string' ? item.command : '命令执行完成' })
      if (item?.type === 'fileChange') pending.onProgress?.({ kind: 'file-change', text: '文件修改完成' })
      return
    }
    if (method !== 'turn/completed') return
    clearTimeout(pending.timer)
    this.turns.delete(pending)
    const status = turnRecord?.status
    if (status !== 'completed') {
      pending.reject(new Error(`Codex turn ${String(status ?? 'failed')}: ${errorMessage(turnRecord?.error)}`))
      return
    }
    const text = finalAgentText(turnRecord) || pending.text.trim()
    if (text === '') pending.reject(new Error('Codex App Server returned no public text'))
    else pending.resolve(text)
  }

  async startThread(title: string): Promise<string> {
    await this.ensureStarted()
    const response = asRecord(await this.request('thread/start', {
      cwd: this.options.cwd,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
      serviceName: 'dsh-work-orchestrator',
      developerInstructions: 'You are the execution worker for a DeepSeek Harness companion. Preserve the user request, report verified results, and keep work inside the configured workspace.',
    }))
    const thread = asRecord(response?.thread)
    if (typeof thread?.id !== 'string') throw new Error('Codex App Server returned no thread id')
    await this.request('thread/name/set', { threadId: thread.id, name: `DSH Work · ${title}` })
    return thread.id
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.ensureStarted()
    await this.request('thread/resume', {
      threadId,
      cwd: this.options.cwd,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      excludeTurns: true,
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
    })
  }

  async runTurn(threadId: string, prompt: string, onProgress?: (progress: CodexProgress) => void): Promise<string> {
    await this.ensureStarted()
    const result = new Promise<string>((resolve, reject) => {
      const pending: TurnPending = {
        threadId,
        text: '',
        ...(onProgress === undefined ? {} : { onProgress }),
        resolve,
        reject,
        timer: setTimeout(() => {
          this.turns.delete(pending)
          reject(new Error('Codex turn timed out'))
        }, this.options.turnTimeoutMs ?? 30 * 60_000),
      }
      this.turns.add(pending)
    })
    try {
      const response = asRecord(await this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }],
        turnTrigger: 'dsh-work-orchestrator',
        cwd: this.options.cwd,
        approvalPolicy: 'never',
        ...(this.options.model === undefined ? {} : { model: this.options.model }),
        ...(this.options.reasoningEffort === undefined ? {} : { effort: this.options.reasoningEffort }),
      }))
      const turn = asRecord(response?.turn)
      const pending = [...this.turns].find(candidate => candidate.threadId === threadId && candidate.turnId === undefined)
      if (pending !== undefined && typeof turn?.id === 'string') pending.turnId = turn.id
    } catch (error) {
      const pending = [...this.turns].find(candidate => candidate.threadId === threadId && candidate.turnId === undefined)
      if (pending !== undefined) {
        clearTimeout(pending.timer)
        this.turns.delete(pending)
        pending.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    return await result
  }

  private failAll(error: Error): void {
    for (const pending of this.requests.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.requests.clear()
    for (const pending of this.turns) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.turns.clear()
  }

  async close(): Promise<void> {
    this.closing = true
    this.failAll(new Error('Codex App Server client closed'))
    this.lines?.close()
    if (this.child === undefined || this.child.exitCode !== null) return
    const child = this.child
    child.stdin.end()
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 1_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}
