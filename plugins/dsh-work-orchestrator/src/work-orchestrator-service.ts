import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { installModelSelection, type AgentHandle, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-tools'
import { CodexAppServerClient, type CodexWorkerClient } from './codex-app-server-client.js'
import type { ResolvedConfig } from './config.js'
import { WorkSessionLinkStore, type WorkSessionLink } from './work-session-link-store.js'

export const WORK_RELAY_PREFIX = 'DSH_WORK_RELAY_V1'
export const WORK_RELAY_META_PREFIX = 'DSH_WORK_META_V1'
export const LEGACY_WORK_RELAY_PREFIX = 'XIAOTANGYUAN_WORK_RELAY_V1'

const WORK_RECOGNITION_SYSTEM_PROMPT = `You classify one completed conversation turn for an AI companion.
Return exactly one JSON object and no markdown:
{"kind":"none"|"start"|"continue"|"inspect","title"?:string,"instruction"?:string}

Definitions:
- start: the player asks the companion to do substantial external work through DeepSeek Harness, such as research, writing, presentations, HTML, documents, code, images, plans, or opening/revising a produced artifact.
- continue: the player gives feedback, approval, correction, or a next instruction for the currently linked work session.
- inspect: the player asks about progress, current approach, result, or status of the currently linked work session.
- none: ordinary conversation, in-game actions, companionship, factual questions answerable in the current reply, or ambiguous language.

Rules:
- This classifier runs after the companion has already answered. Do not rewrite that answer.
- Prefer none when uncertain. Never turn an in-game command into external work.
- Use continue or inspect only when CURRENT_WORK says a linked work session exists.
- instruction must preserve the player's actual request and must not add requirements.
- title is required only for start and must be concise.`

const WORKER_PREFIX = 'DSH_WORKER_SESSION_V1'

export type WorkIntent =
  | { kind: 'none' }
  | { kind: 'start'; title: string; instruction: string }
  | { kind: 'continue' | 'inspect'; instruction: string }

export interface WorkCompanionProfile {
  /** Stable caller identity for prompts and future policy routing. */
  id: string
  /** User-facing name used only when the Worker or source Session needs context. */
  name: string
  /** Player-facing name for the delegated helper. Internal executor names must stay hidden. */
  delegateName?: string
  /** Optional caller-owned rules for the independent Worker. */
  workerInstructions?: string
  /** Optional caller-owned rules for presenting Worker updates. */
  relayInstructions?: string
}

export interface WorkNotification {
  workSessionId: string
  title: string
  text: string
  kind: 'update' | 'status' | 'error'
  source: string
  executor: 'dsh' | 'codex-app-server'
  status: string
  codexThreadId?: string
}

export interface WorkContextSnapshot {
  title: string
  status: string
}

export interface CompletedCompanionTurn {
  companionSessionId: string
  playerText: string
  companionReply: string
  selection?: ModelSelection
  source: string
  companion?: WorkCompanionProfile
  notify?: (notification: WorkNotification) => void | Promise<void>
}

interface ActiveWorkSession {
  title: string
  sessionId: string
  selection: ModelSelection
  handle: AgentHandle
  executor: 'dsh' | 'codex-app-server'
  codexThreadId?: string
  lastReply?: string
  status: string
  running: boolean
  runQueue: Promise<void>
}

interface LinkedWorkReference {
  title: string
  sessionId: string
  executor?: 'dsh' | 'codex-app-server'
  codexThreadId?: string
  status?: string
}

function linkReference(link: WorkSessionLink | undefined): LinkedWorkReference | undefined {
  return link === undefined ? undefined : {
    title: link.title,
    sessionId: link.workerSessionId,
    executor: link.executor,
    ...(link.codexThreadId === undefined ? {} : { codexThreadId: link.codexThreadId }),
    status: link.status,
  }
}

function companionProfile(turn: CompletedCompanionTurn): WorkCompanionProfile {
  return turn.companion ?? { id: 'companion', name: '当前陪伴角色' }
}

function delegateName(turn: CompletedCompanionTurn): string {
  return cleanString(companionProfile(turn).delegateName, 40) ?? '另一位助手'
}

function sanitizePlayerFacingText(text: string, helper: string): string {
  return text
    .replace(/\b(?:worker|work)\s+(?:dsh\s+)?session\b/gi, helper)
    .replace(/\b(?:codex|dsh)\s+(?:app\s+server\s+)?(?:thread|session)\b/gi, helper)
    .replace(/(?:原)?(?:后台)?工作(?:会话|线程|执行器|任务)/g, helper)
    .replace(/后台工作/g, helper)
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*|__|~~|`{1,3}/g, '')
}

function compactSentences(text: string, maximum = 100): string {
  const cleaned = text
    .replace(/^\s*(?:[-*+]\s+|\d+[.)、]\s*)/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned === '') return ''
  const sentences = cleaned.match(/[^。！？!?]+[。！？!?]?/g) ?? [cleaned]
  const summary = sentences.slice(0, 2).join('').trim()
  return summary.length <= maximum ? summary : `${summary.slice(0, maximum - 1).trimEnd()}…`
}

export function compactWorkNotification(
  title: string,
  workerText: string,
  kind: WorkNotification['kind'],
  helper = '另一位助手',
): string {
  if (kind === 'update') {
    return `“${cleanString(title, 36) ?? '这件事'}”有新进展啦。要听我简单说说，还是打开工作页面看完整内容？`
  }
  const summary = compactSentences(sanitizePlayerFacingText(workerText, helper))
  if (summary !== '') return summary
  return kind === 'error' ? `${helper}这次没有处理成功，稍后再试试吧。` : '我暂时还没有拿到新的进展。'
}

function cleanString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.trim().replace(/\s+/g, ' ')
  return cleaned === '' ? undefined : cleaned.slice(0, maximum)
}

export function parseWorkIntent(text: string): WorkIntent {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const object = text.indexOf('{') >= 0 && text.lastIndexOf('}') >= text.indexOf('{')
    ? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
    : ''
  const candidate = fenced ?? object
  if (candidate.trim() === '') return { kind: 'none' }
  try {
    const value = JSON.parse(candidate) as Record<string, unknown>
    if (value.kind === 'start') {
      const title = cleanString(value.title, 80)
      const instruction = cleanString(value.instruction, 4_000)
      return title === undefined || instruction === undefined ? { kind: 'none' } : { kind: 'start', title, instruction }
    }
    if (value.kind === 'continue' || value.kind === 'inspect') {
      const instruction = cleanString(value.instruction, 4_000)
      return instruction === undefined ? { kind: 'none' } : { kind: value.kind, instruction }
    }
    return { kind: 'none' }
  } catch {
    return { kind: 'none' }
  }
}

/** Codex is an optional nested delegate and must be selected explicitly by the player. */
export function requestsCodex(instruction: string): boolean {
  const text = instruction.trim()
  if (text === '') return false
  return /(?:让|叫|用|交给|安排|指定|委派)\s*codex\b/i.test(text)
    || /\bcodex\s*(?:来|帮|处理|做|优化|修改|分析|开发|执行)/i.test(text)
    || /\b(?:use|ask|have|let|delegate(?:\s+to)?)\s+codex\b/i.test(text)
}

function asksForWorkChange(text: string): boolean {
  return /(?:不对|不太对|改(?:一下|下|成)|修改|更改|重做|再做|优化|增加|添加|删(?:掉|除)?|换(?:成|掉)?|调整|迭代|继续(?:做)?|开始做|做吧|执行|开始执行|打开|预览|查看|给我看|让我看|展示|运行|发布|导出|continue|revise|change|modify|redo|improve|execute|open|preview|show me|run|publish|export)/i.test(text)
}

function explicitlyStartsNewWork(text: string, linkedTitle: string): boolean {
  if (/(?:新任务|新的任务|另外|另一个|再开一个|重新开一个|换个任务|new task|another task|separate task)/i.test(text)) return true
  const kinds = [
    /(?:html|网页|网站|页面)/i,
    /(?:ppt|幻灯片|演示文稿)/i,
    /(?:文档|报告|文章|推文|markdown)/i,
    /(?:代码|程序|游戏)/i,
    /(?:图片|海报|视频)/i,
  ]
  const linkedKinds = kinds.map(pattern => pattern.test(linkedTitle))
  const requestedKinds = kinds.map(pattern => pattern.test(text))
  return requestedKinds.some((requested, index) => requested && !linkedKinds[index])
    && linkedKinds.some(Boolean)
}

export function requestsImmediateExecution(text: string): boolean {
  const planOnly = /(?:只要|只需|先|暂时|目前).{0,8}(?:思路|方案|计划|规划|大纲|建议)|(?:不要|先别|暂不|无需).{0,8}(?:执行|生成|制作|修改|打开|动手)/i.test(text)
  if (planOnly) return false
  return /(?:做|写|生成|制作|创建|开发|修改|优化|迭代|打开|预览|运行|发布|导出|execute|create|build|write|generate|make|modify|open|preview|run|publish|export)/i.test(text)
}

/** High-confidence non-game work only. Ambiguous language still goes through the model classifier. */
export function obviousExternalWorkRequest(playerText: string): boolean {
  const text = playerText.trim()
  if (text === '') return false
  const artifact = /(?:html|网页|网站|页面|ppt|幻灯片|汇报|文档|报告|文章|推文|方案|代码|程序|资料|调研|表格|邮件|图片|海报|视频)/i.test(text)
  const action = /(?:帮我|请|替我|给我|我要|想要|需要).{0,16}(?:写|做|生成|制作|创建|准备|整理|查询|查找|搜索|调研|打开|修改|优化|迭代|开发)/i.test(text)
    || /(?:写|做|生成|制作|创建|准备|整理|查询|查找|搜索|调研|打开|修改|优化|迭代|开发).{0,32}(?:html|网页|网站|页面|ppt|幻灯片|汇报|文档|报告|文章|推文|方案|代码|程序|资料|调研|表格|邮件|图片|海报|视频)/i.test(text)
  return artifact && action
}

function externalWorkTitle(playerText: string): string {
  const text = playerText.trim().replace(/[。！？!?]+$/u, '')
  const captured = text.match(/(?:写|做|生成|制作|准备|开发)(?:一个|个|一份|份)?\s*(.{2,50})$/iu)?.[1]
  return cleanString(captured, 50) ?? cleanString(text, 50) ?? '新工作'
}

/** Clear status questions should inspect the existing linked Session without
 * depending on the companion reply or another model classification. */
export function linkedWorkIntentShortcut(playerText: string, hasLinkedWork: boolean): WorkIntent | undefined {
  if (!hasLinkedWork) return undefined
  const text = playerText.trim()
  if (text === '') return undefined
  if (asksForWorkChange(text)) return undefined
  const asksForStatus = /(?:做得怎么样|做的怎么样|做到哪|进度|完成了吗|完成了没|做好了吗|做好了没|结果(?:呢|怎么样|如何)?|现在怎么样|到哪了|当前思路|汇报思路|status|progress|how(?:'s| is) it going|is it (?:done|ready)|result)/i.test(text)
  return asksForStatus ? { kind: 'inspect', instruction: text.slice(0, 4_000) } : undefined
}

/** Deterministic post-turn routing for explicit work and linked status queries. */
export function postTurnWorkIntentShortcut(playerText: string, hasLinkedWork: boolean): WorkIntent | undefined {
  const linked = linkedWorkIntentShortcut(playerText, hasLinkedWork)
  if (linked !== undefined) return linked
  const instruction = playerText.trim().slice(0, 4_000)
  if (hasLinkedWork && asksForWorkChange(instruction)) return { kind: 'continue', instruction }
  if (!obviousExternalWorkRequest(playerText)) return undefined
  return { kind: 'start', title: externalWorkTitle(instruction), instruction }
}

function assistantText(events: readonly SessionEvent[], firstSeq: number): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.seq < firstSeq || event.type !== 'assistant/message') continue
    return event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.type === 'text' ? block.text : '')
      .join('')
      .trim()
  }
  return ''
}

const REQUIRED_WORK_TOOLS = ['read', 'write', 'edit', 'glob', 'grep', 'pwsh'] as const

/** Office Workers must inherit the DSH base tool layer, not only game-plugin tools. */
export function assertRequiredWorkTools(toolNames: readonly string[]): void {
  const available = new Set(toolNames)
  const missing = REQUIRED_WORK_TOOLS.filter(name => !available.has(name))
  if (missing.length > 0) {
    throw new Error(`Work DSH Session tool configuration error: missing ${missing.join(', ')}`)
  }
}

export function requiresArtifactWrite(instruction: string): boolean {
  if (/(?:不要|无需|先别|暂不|不再).{0,8}(?:做|写|生成|制作|创建|修改|导出|保存|落盘)|不.{0,2}(?:做|写|生成|制作|创建|修改|导出|保存|落盘)/i.test(instruction)) return false
  const artifact = /(?:html?|网页|网站|页面|pptx?|幻灯片|演示文稿|markdown|\.md\b|文档|报告|文章|推文|表格|xlsx?|csv|代码|程序|图片|海报|视频|文件)/i.test(instruction)
  const planning = /(?:思路|方案|计划|规划|大纲|建议)/i.test(instruction)
  const commitsArtifact = /(?:生成|制作|创建|导出|保存|落盘|打开|预览).{0,20}(?:html?|网页|网站|页面|pptx?|幻灯片|演示文稿|markdown|\.md\b|文档|报告|文章|推文|表格|xlsx?|csv|代码|程序|图片|海报|视频|文件)/i.test(instruction)
    || /(?:html?|网页|网站|页面|pptx?|幻灯片|演示文稿|markdown|\.md\b|文档|报告|文章|推文|表格|xlsx?|csv|代码|程序|图片|海报|视频|文件).{0,20}(?:生成|制作|创建|导出|保存|落盘|打开|预览)/i.test(instruction)
  if (planning && !commitsArtifact) return false
  const action = /(?:做|写|生成|制作|创建|开发|修改|优化|迭代|重做|改成|导出|保存|落盘|create|build|write|generate|make|modify|edit|export|save)/i.test(instruction)
  return artifact && action
}

export function requiresArtifactOpen(instruction: string): boolean {
  if (/(?:不要|无需|先别|暂不|不再).{0,8}(?:打开|预览|展示|启动)|不.{0,2}(?:打开|预览|展示|启动)/i.test(instruction)) return false
  return /(?:打开|预览|给我看|让我看|展示|启动|open|preview|show me|launch)/i.test(instruction)
}

interface WorkExecutionEvidence {
  artifactPaths: string[]
  opened: boolean
  researched: boolean
}

function successfulToolCalls(events: readonly SessionEvent[], firstSeq: number): Array<{
  name: string
  arguments: string
}> {
  const succeeded = new Set<string>()
  for (const event of events) {
    if (event.seq < firstSeq || event.type !== 'tool/result' || event.data.error !== undefined) continue
    for (const block of event.data.message.content) {
      if (block.type === 'tool-result' && block.isError !== true) succeeded.add(String(block.toolCallId))
    }
  }
  return events
    .filter((event): event is SessionEvent<'tool/call'> => event.seq >= firstSeq && event.type === 'tool/call')
    .filter(event => succeeded.has(String(event.data.callId)))
    .map(event => ({ name: event.data.name, arguments: event.data.arguments }))
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

const OFFICE_ARTIFACT_EXTENSIONS = {
  html: ['.html', '.htm'],
  markdown: ['.md', '.markdown'],
  document: ['.docx', '.pdf', '.md', '.html', '.htm', '.txt'],
  presentation: ['.pptx', '.ppt'],
  spreadsheet: ['.xlsx', '.xls', '.csv'],
  image: ['.png', '.jpg', '.jpeg', '.webp', '.svg'],
  video: ['.mp4', '.webm', '.mov'],
} as const

function expectedArtifactExtensions(instruction: string): Set<string> {
  const extensions = new Set<string>()
  const add = (kind: keyof typeof OFFICE_ARTIFACT_EXTENSIONS): void => {
    for (const extension of OFFICE_ARTIFACT_EXTENSIONS[kind]) extensions.add(extension)
  }
  if (/(?:html?|网页|网站|页面)/i.test(instruction)) add('html')
  if (/(?:markdown|\.md\b)/i.test(instruction)) add('markdown')
  if (/(?:word|docx?|文档|报告|文章|推文)/i.test(instruction)) add('document')
  if (/(?:pptx?|幻灯片|演示文稿|汇报文件)/i.test(instruction)) add('presentation')
  if (/(?:xlsx?|excel|csv|表格|电子表格)/i.test(instruction)) add('spreadsheet')
  if (/(?:图片|海报|png|jpe?g|webp|svg)/i.test(instruction)) add('image')
  if (/(?:视频|mp4|webm|mov)/i.test(instruction)) add('video')
  return extensions
}

function isPathInside(root: string, filePath: string): boolean {
  const pathFromRoot = relative(root, filePath)
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

function isValidOfficeArtifact(filePath: string, expected: ReadonlySet<string>): boolean {
  if (!existsSync(filePath)) return false
  const stat = statSync(filePath)
  if (!stat.isFile() || stat.size === 0) return false
  const extension = extname(filePath).toLowerCase()
  if (expected.size > 0 && !expected.has(extension)) return false
  const prefix = readFileSync(filePath).subarray(0, 65_536)
  if (extension === '.html' || extension === '.htm') {
    const text = prefix.toString('utf8').toLowerCase()
    return text.includes('<!doctype html') || text.includes('<html')
  }
  if (extension === '.md' || extension === '.markdown' || extension === '.txt' || extension === '.csv') {
    return prefix.toString('utf8').trim() !== ''
  }
  if (extension === '.docx' || extension === '.xlsx' || extension === '.pptx') {
    return prefix.length >= 4 && prefix[0] === 0x50 && prefix[1] === 0x4b
  }
  return true
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringValues)
  if (typeof value !== 'object' || value === null) return []
  return Object.values(value).flatMap(stringValues)
}

function candidatePaths(call: { name: string; arguments: string }, root: string): string[] {
  const args = parseToolArguments(call.arguments)
  const direct = ['file_path', 'path', 'output_path', 'outputPath', 'destination', 'target']
    .flatMap(key => stringValues(args[key]))
  if (call.name === 'write' || call.name === 'edit') {
    return direct.map(filePath => resolve(root, filePath))
  }
  if (call.name !== 'pwsh') return []
  const command = typeof args.command === 'string' ? args.command : ''
  if (!/(?:Set-Content|Out-File|Export-Csv|SaveAs|WriteAll(?:Bytes|Text)|Copy-Item|Move-Item)/i.test(command)) return []
  const quoted = [...command.matchAll(/["']([^"']+\.[A-Za-z0-9]{1,8})["']/g)].map(match => match[1] ?? '')
  return [...direct, ...quoted].filter(Boolean).map(filePath => resolve(root, filePath))
}

function openedTargets(calls: ReadonlyArray<{ name: string; arguments: string }>, root: string): string[] {
  return calls.flatMap(call => {
    if (call.name !== 'pwsh') return []
    const command = parseToolArguments(call.arguments).command
    if (typeof command !== 'string' || !/(?:Start-Process|Invoke-Item|(?:^|[;\s])ii\s)/i.test(command)) return []
    return [...command.matchAll(/["']([^"']+)["']/g)]
      .map(match => match[1] ?? '')
      .filter(Boolean)
      .map(target => resolve(root, target))
  })
}

export function requiresWebResearch(instruction: string): boolean {
  if (/(?:不要|无需|别).{0,6}(?:联网|搜索|查资料|调研)/i.test(instruction)) return false
  return /(?:联网|上网|搜索|查资料|查一下|调研|最新|research|web search|search online)/i.test(instruction)
}

function isResearchToolCall(call: { name: string; arguments: string }): boolean {
  if (/(?:^|[._-])(?:web|search|browser)(?:$|[._-])/i.test(call.name)) return true
  if (call.name !== 'pwsh') return false
  const command = parseToolArguments(call.arguments).command
  if (typeof command !== 'string') return false
  return /(?:Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|(?:System\.Net\.)?(?:WebClient|WebRequest|HttpWebRequest)|System\.Net\.Http\.HttpClient|\.Download(?:String|Data|File)\s*\(|(?:^|[;&|\s])curl(?:\.exe)?(?:\s|$)|(?:^|[;&|\s])wget(?:\.exe)?(?:\s|$))/i.test(command)
}

export function verifyWorkExecution(
  events: readonly SessionEvent[],
  firstSeq: number,
  workspace: string,
  instruction: string,
): WorkExecutionEvidence {
  const root = resolve(workspace)
  const calls = successfulToolCalls(events, firstSeq)
  const expected = expectedArtifactExtensions(instruction)
  const artifactPaths = [...new Set(calls.flatMap(call => candidatePaths(call, root)))]
    .filter(filePath => isPathInside(root, filePath) && isValidOfficeArtifact(filePath, expected))
  const targets = openedTargets(calls, root)
  const opened = targets.some(target => {
    if (!isPathInside(root, target) || !existsSync(target)) return false
    if (artifactPaths.length === 0) return statSync(target).isFile()
    return artifactPaths.some(filePath => filePath.toLowerCase() === target.toLowerCase())
  })
  const researched = calls.some(isResearchToolCall)

  if (requiresArtifactWrite(instruction) && artifactPaths.length === 0) {
    throw new Error('Work DSH Session did not create or modify a verifiable artifact')
  }
  if (requiresArtifactOpen(instruction) && !opened) {
    throw new Error('Work DSH Session did not successfully open the verified artifact')
  }
  if (requiresWebResearch(instruction) && !researched) {
    throw new Error('Work DSH Session did not perform the requested web research')
  }
  return { artifactPaths, opened, researched }
}

export interface WorkOrchestratorDependencies {
  codexClient?: CodexWorkerClient
}

/** Generic post-turn work orchestration with a visible DSH control Session. */
export class WorkOrchestratorService extends Service {
  private readonly tasks = new Set<Promise<void>>()
  private readonly active = new Map<string, ActiveWorkSession>()
  private readonly failedRestores = new Map<string, WorkSessionLink>()
  private readonly linkStore: WorkSessionLinkStore
  private codexClient?: CodexWorkerClient
  private closing = false

  constructor(ctx: Context, readonly config: ResolvedConfig, dependencies: WorkOrchestratorDependencies = {}) {
    super(ctx, 'workOrchestrator')
    mkdirSync(config.codex.workingDirectory, { recursive: true })
    this.linkStore = new WorkSessionLinkStore(config.directory, config.legacyDirectories)
    this.codexClient = dependencies.codexClient
  }

  private selectionFor(turn: CompletedCompanionTurn): ModelSelection {
    const selection = this.config.selection ?? turn.selection
    if (selection === undefined) throw new Error('Work recognition requires a model selection')
    return selection
  }

  /** Minimal dynamic context for the companion's next public reply. */
  contextForCompanion(companionSessionId: string): WorkContextSnapshot | undefined {
    const current = this.active.get(companionSessionId)
    if (current !== undefined) {
      return {
        title: current.title,
        status: current.running ? '执行中' : current.status,
      }
    }
    const link = this.linkStore.get(companionSessionId)
    if (link === undefined) return undefined
    return {
      title: link.title,
      status: link.status === 'active' ? '执行中' : link.status === 'unavailable' ? '暂时无法连接' : '等待反馈',
    }
  }

  /** Enqueue recognition after the caller's answer without delaying that answer. */
  scheduleTurn(turn: CompletedCompanionTurn): void {
    if (!this.config.enabled || this.closing) return
    const task = Promise.resolve()
      .then(async () => this.processTurn(turn))
      .catch(async error => {
        this.ctx.logger.warn('dsh-work-orchestrator: post-turn recognition failed; the completed companion reply is unaffected')
        this.ctx.logger.warn(error)
        if (process.env.DSH_WORK_DIAGNOSTICS === '1') {
          console.error('[dsh-work-orchestrator] post-turn failure', error)
        }
        const current = this.active.get(turn.companionSessionId)
        const linked = linkReference(this.linkStore.get(turn.companionSessionId))
        const work = current ?? linked
        const helper = delegateName(turn)
        await turn.notify?.({
          workSessionId: work?.sessionId ?? '',
          title: work?.title ?? externalWorkTitle(turn.playerText),
          text: `${helper}暂时没能处理这件事，请稍后再告诉我一次。`,
          kind: 'error',
          source: turn.source,
          executor: work?.executor ?? 'dsh',
          status: '失败',
          ...(work?.codexThreadId === undefined ? {} : { codexThreadId: work.codexThreadId }),
        })
      })
      .finally(() => this.tasks.delete(task))
    this.tasks.add(task)
  }

  private async processTurn(turn: CompletedCompanionTurn): Promise<void> {
    const recovered = await this.restoreWorkSession(turn)
    const current = recovered.current
    let intent = await this.recognize(turn, current, recovered.unavailable)
    if (intent.kind === 'none') return

    if (intent.kind === 'inspect') {
      const helper = delegateName(turn)
      let text: string
      if (recovered.unavailable !== undefined) {
        text = `${helper}暂时没能接上“${recovered.unavailable.title}”之前的进度。我没有另请一位，请稍后再试。`
      } else if (current === undefined) {
        text = `目前没有请${helper}处理事情。你可以直接告诉我想完成什么。`
      } else if (current.running || (current.executor === 'dsh' && current.handle.agent.status === 'running')) {
        text = `${helper}还在处理“${current.title}”。`
      } else {
        const profile = companionProfile(turn)
        const prompt = [
          WORKER_PREFIX,
          `玩家正在询问“${current.title}”的真实进度、当前思路或结果。`,
          `玩家原话：${intent.instruction}`,
          '请只依据这个 Work DSH Session 已有的对话、已完成的操作和可验证成果，简洁汇报当前状态。',
          '不得猜测阶段、截止时间或完成情况；尚未实际生成的成果要明确说尚未生成。不要把本次查询当成新任务。',
          profile.workerInstructions,
        ].filter((line): line is string => line !== undefined && line !== '').join('\n')
        text = await this.runWorkerSession(current, prompt)
        current.lastReply = text
        await this.setWorkStatus(current, '等待反馈')
        this.saveLink(turn.companionSessionId, current, 'waiting')
      }
      await this.reportToCompanion(turn, current ?? linkReference(recovered.unavailable), text, recovered.unavailable === undefined ? 'status' : 'error')
      return
    }

    if (intent.kind === 'continue' && current === undefined && recovered.unavailable !== undefined) {
      intent = {
        kind: 'start',
        title: recovered.unavailable.title,
        instruction: [
          `继续处理“${recovered.unavailable.title}”。`,
          '之前的 DSH Session 无法恢复，请创建新的工作 Session，并先检查共享工作目录中是否已有可继续使用的成果。',
          `玩家当前要求：${intent.instruction}`,
        ].join('\n'),
      }
      this.failedRestores.delete(turn.companionSessionId)
    } else if (intent.kind === 'continue' && current === undefined) {
      const helper = delegateName(turn)
      const text = `目前没有可以继续处理的事情，请先把完整任务告诉我，我再请${helper}帮忙。`
      await this.reportToCompanion(turn, undefined, text, 'status')
      return
    }

    const work = current ?? await this.createWorkSession(turn, intent.kind === 'start' ? intent.title : recovered.unavailable?.title ?? '新工作')
    if (intent.kind === 'start' && current !== undefined) {
      // The companion owns one durable Work DSH Session. A new task changes the
      // subject inside that Session; it must not create another chat-list item.
      work.title = intent.title
      await this.setWorkStatus(work, '等待反馈')
      this.saveLink(turn.companionSessionId, work, 'waiting')
    }
    const profile = companionProfile(turn)
    const executeNow = requestsImmediateExecution(intent.instruction)
    const prompt = intent.kind === 'start'
      ? [
          WORKER_PREFIX,
          `你是由“${profile.name}”通过 DeepSeek Harness 创建的独立后台工作线程，负责完成玩家交付的通用工作。`,
          '优先使用当前执行环境已安装的插件、技能和工具；只有现有能力确实不够时才写少量新代码。',
          `所有成果统一保存到这个绝对目录：${this.config.codex.workingDirectory}`,
          '文本成果优先使用当前工具表中的官方 write 创建、edit 修改；PPT、Word、Excel 等二进制成果优先使用已安装的对应技能或插件，也可用 pwsh 调用本机已有运行时生成。Windows 打开成果必须调用 pwsh，并用 Start-Process 打开成果的绝对路径。需要联网资料时使用 web_search。',
          '不得调用游戏、剧情、角色记忆或 Mod 工具完成通用工作。没有成功写入文件，不得声称成果已经生成；没有成功执行打开命令，不得声称已经打开。若所需工具不可用，明确报告工具配置错误。',
          '这项通用工作可能由玩家在游戏中发起。不要操作游戏、不要评论游戏是否连接，也不要冒充发起工作的陪伴角色。不要声称尚未验证的结果已经完成。',
          executeNow
            ? '这是明确的执行请求。现在就使用可用工具完成实际操作，不要只给方案，不要反问已经能从任务标题、当前要求或共享工作目录确定的信息。要求生成、制作或修改成果时，必须真正落盘；要求打开或预览时，完成后必须实际打开并报告可验证路径或 URL。'
            : '玩家当前只要求思路、方案或规划。先给出简洁思路、关键假设和预期成果，等待玩家确认后再执行。',
          profile.workerInstructions,
          `任务标题：${intent.title}`,
          `玩家原始要求：${intent.instruction}`,
        ].filter((line): line is string => line !== undefined && line !== '').join('\n')
      : [
          WORKER_PREFIX,
          `继续处理“${work.title}”。`,
          `玩家刚刚给出的反馈或下一步要求：${intent.instruction}`,
          `所有成果统一保存到这个绝对目录：${this.config.codex.workingDirectory}`,
          executeNow
            ? '这是明确的执行请求。现在必须使用现有工作工具真实创建或修改成果；玩家要求打开或预览时，必须使用 pwsh 执行 Start-Process 打开本次成果的绝对路径。没有成功的工具结果不得声称已完成或已打开。'
            : '玩家当前只要求思路、方案、进度或反馈；只完成本轮授权的范围。',
          '不要调用游戏、剧情、角色记忆或 Mod 工具完成这项通用工作。',
          '保持此前工作上下文；根据玩家意见迭代。若玩家只是让你汇报思路或进度，不要擅自扩大执行范围。',
          profile.workerInstructions,
        ].filter((line): line is string => line !== undefined && line !== '').join('\n')

    const run = work.runQueue.then(async () => {
      work.running = true
      this.saveLink(turn.companionSessionId, work, 'active')
      await this.setWorkStatus(work, '执行中')
      try {
        const reply = await this.runWorker(work, prompt, intent.instruction, requestsCodex(turn.playerText))
        work.lastReply = reply
        await this.setWorkStatus(work, '等待反馈')
        await this.reportToCompanion(turn, work, reply, 'update')
      } catch (error) {
        await this.setWorkStatus(work, '失败')
        throw error
      } finally {
        work.running = false
        this.saveLink(turn.companionSessionId, work, 'waiting')
      }
    })
    work.runQueue = run.catch(() => undefined)
    await run
  }

  private async recognize(
    turn: CompletedCompanionTurn,
    current: ActiveWorkSession | undefined,
    unavailable: WorkSessionLink | undefined,
  ): Promise<WorkIntent> {
    const shortcut = linkedWorkIntentShortcut(
      turn.playerText,
      current !== undefined || unavailable !== undefined,
    )
    if (shortcut !== undefined) return shortcut
    const explicitFallback = postTurnWorkIntentShortcut(
      turn.playerText,
      current !== undefined || unavailable !== undefined,
    )
    if (explicitFallback?.kind === 'continue') return explicitFallback
    const selection = this.selectionFor(turn)
    const assembler = new BlockAssembler()
    const input = [
      `CURRENT_WORK: ${current !== undefined
        ? JSON.stringify({
            title: current.title,
            executor: current.executor,
            status: current.running ? 'running' : current.executor === 'dsh' ? current.handle.agent.status : 'waiting',
          })
        : unavailable !== undefined
          ? JSON.stringify({ title: unavailable.title, status: 'unavailable' })
          : 'none'}`,
      `COMPANION: ${JSON.stringify(companionProfile(turn))}`,
      `PLAYER_MESSAGE: ${turn.playerText.slice(0, 4_000)}`,
      `COMPANION_FINAL_REPLY: ${turn.companionReply.slice(0, 2_000)}`,
    ].join('\n')
    for await (const chunk of this.ctx.llm.stream({
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      messages: [createUserMessage({ content: [{ type: 'text', text: input }], source: { kind: 'user' } })],
      system: WORK_RECOGNITION_SYSTEM_PROMPT,
      temperature: 0,
      maxTokens: 400,
      signal: AbortSignal.timeout(45_000),
      purpose: 'compaction',
    })) assembler.push(chunk)
    const text = assembler.blocks()
      .filter(block => block.type === 'text')
      .map(block => block.type === 'text' ? block.text : '')
      .join('')
    const parsed = parseWorkIntent(text)
    const linkedTitle = current?.title ?? unavailable?.title
    if (parsed.kind === 'start' && linkedTitle !== undefined && !explicitlyStartsNewWork(turn.playerText, linkedTitle)) {
      return { kind: 'continue', instruction: parsed.instruction }
    }
    const intent = parsed.kind === 'none' && explicitFallback !== undefined ? explicitFallback : parsed
    if ((intent.kind === 'continue' || intent.kind === 'inspect') && current === undefined && unavailable === undefined) {
      return intent.kind === 'inspect' ? intent : { kind: 'none' }
    }
    return intent
  }

  private setupWorker(selection: ModelSelection): (agentCtx: Context) => void {
    return (agentCtx) => {
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
      agentCtx.inject(['tools'], (scoped) => {
        const toolNames = scoped.tools.schemas().map(tool => tool.name)
        assertRequiredWorkTools(toolNames)
        const gameToolPrefixes = [
          'game_', 'game.', 'xiaotangyuan_', 'stardew_', 'dont_starve_', 'dst_', 'oni_', 'oxygen_not_included_',
        ]
        const denied = toolNames
          .filter(name => gameToolPrefixes.some(prefix => name.startsWith(prefix)))
        if (denied.length > 0) scoped.tools.restrict({ deny: denied })
      })
    }
  }

  /** Create/resume from the parent DSH scope so the Worker inherits official
   * file, shell and web tools instead of only this game plugin's tool layer. */
  private agentOwnerContext(): Context {
    return this.ctx.fiber.parent
  }

  private agentRegistryForWorker() {
    const registry = this.agentOwnerContext().get('agents')
    if (registry === undefined) throw new Error('Work DSH Session cannot access the DSH agent registry')
    return registry
  }

  private saveLink(companionSessionId: string, work: ActiveWorkSession, status: WorkSessionLink['status']): void {
    this.linkStore.set({
      companionSessionId,
      workerSessionId: work.sessionId,
      title: work.title,
      selection: work.selection,
      status,
      executor: work.executor,
      ...(work.codexThreadId === undefined ? {} : { codexThreadId: work.codexThreadId, codexDelegated: true as const }),
      updatedAt: Date.now(),
    })
  }

  private async restoreWorkSession(turn: CompletedCompanionTurn): Promise<{
    current?: ActiveWorkSession
    unavailable?: WorkSessionLink
  }> {
    const current = this.active.get(turn.companionSessionId)
    if (current !== undefined) return { current }
    const failed = this.failedRestores.get(turn.companionSessionId)
    if (failed !== undefined) return { unavailable: failed }
    const link = this.linkStore.get(turn.companionSessionId)
    if (link === undefined) return {}
    try {
      const handle = await this.agentRegistryForWorker().resume({
        resumeSessionId: SessionId(link.workerSessionId),
        agentOptions: { provider: link.selection.provider, model: link.selection.model },
        setup: this.setupWorker(link.selection),
      })
      await handle.agent.whenIdle()
      this.ctx.permissionPresets.set(handle.agent.session, 'danger-full-access')
      await this.ctx.sessions.flush(handle.agent.session)
      if (link.codexThreadId !== undefined) {
        await this.getCodexClient().resumeThread(link.codexThreadId!)
      }
      const restored: ActiveWorkSession = {
        title: link.title,
        sessionId: link.workerSessionId,
        selection: link.selection,
        handle,
        executor: link.executor,
        ...(link.codexThreadId === undefined ? {} : { codexThreadId: link.codexThreadId }),
        lastReply: assistantText(handle.agent.session.events, 0) || undefined,
        status: link.status === 'active' ? '执行中' : '等待反馈',
        running: false,
        runQueue: Promise.resolve(),
      }
      this.active.set(turn.companionSessionId, restored)
      this.saveLink(turn.companionSessionId, restored, 'waiting')
      await this.setWorkStatus(restored, '等待反馈')
      return { current: restored }
    } catch (error) {
      const unavailable = { ...link, status: 'unavailable' as const, updatedAt: Date.now() }
      this.failedRestores.set(turn.companionSessionId, unavailable)
      this.linkStore.set(unavailable)
      this.ctx.logger.warn(`dsh-work-orchestrator: cannot resume Worker Session ${link.workerSessionId}`)
      this.ctx.logger.warn(error)
      return { unavailable }
    }
  }

  private async createWorkSession(turn: CompletedCompanionTurn, title: string): Promise<ActiveWorkSession> {
    const selection = this.selectionFor(turn)
    const sessionId = `dsh-work-${randomUUID()}`
    const handle = await this.agentRegistryForWorker().create({
      sessionId: SessionId(sessionId),
      meta: { cwd: this.config.codex.workingDirectory },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: this.setupWorker(selection),
    })
    await handle.agent.whenIdle()
    this.ctx.permissionPresets.set(handle.agent.session, 'danger-full-access')
    await this.ctx.sessions.flush(handle.agent.session)
    const work: ActiveWorkSession = {
      title,
      sessionId,
      selection,
      handle,
      executor: 'dsh',
      status: '等待反馈',
      running: false,
      runQueue: Promise.resolve(),
    }
    this.active.set(turn.companionSessionId, work)
    this.failedRestores.delete(turn.companionSessionId)
    this.saveLink(turn.companionSessionId, work, 'waiting')
    await this.setWorkStatus(work, '等待反馈')
    return work
  }

  private async runWorker(
    work: ActiveWorkSession,
    prompt: string,
    instruction: string,
    explicitlyRequestsCodex: boolean,
  ): Promise<string> {
    let workerPrompt = prompt
    if (work.codexThreadId !== undefined || explicitlyRequestsCodex) {
      if (work.codexThreadId === undefined) {
        work.codexThreadId = await this.getCodexClient().startThread(work.title)
      }
      work.executor = 'codex-app-server'
      await this.setWorkStatus(work, 'Codex 执行中')
      const codexResult = await this.getCodexClient().runTurn(work.codexThreadId, [
        'DSH_CODEX_DELEGATION_V1',
        '你是 Work DSH Session 按玩家明确要求选择的 Codex 执行器。',
        `任务：${work.title}`,
        `本轮要求：${instruction}`,
        '请执行本轮被授权的工作，并返回可公开给 Work Session 的进度或结果；不要冒充游戏陪伴角色。',
      ].join('\n'))
      workerPrompt = [
        prompt,
        '',
        'WORK_DELEGATION_RESULT_V1',
        '以下内容来自玩家明确指定的 Codex App Server 执行器。你仍是权威的 Work DSH Session：请结合自己的持续上下文，检查并向玩家汇报，不要把内部协议原样输出。',
        `Codex Thread：${work.codexThreadId}`,
        `Codex 公开结果：${codexResult.slice(0, 12_000)}`,
      ].join('\n')
    } else {
      work.executor = 'dsh'
    }
    const reply = await this.runWorkerSession(work, workerPrompt, `${work.title}\n${instruction}`, work.executor === 'dsh')
    return reply
  }

  private async runWorkerSession(
    work: ActiveWorkSession,
    workerPrompt: string,
    verificationInstruction?: string,
    verifyExecution = false,
  ): Promise<string> {
    const firstSeq = work.handle.agent.session.seq
    work.handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: workerPrompt }],
      source: { kind: 'plugin', plugin: 'dsh-work-orchestrator', form: 'instructions' },
    }))
    await work.handle.agent.whenIdle()
    let reply = assistantText(work.handle.agent.session.events, firstSeq)
    if (reply === '') throw new Error('Worker DSH Session returned no public text')
    if (!verifyExecution || verificationInstruction === undefined) return reply
    let evidence: WorkExecutionEvidence
    try {
      evidence = verifyWorkExecution(
        work.handle.agent.session.events,
        firstSeq,
        this.config.codex.workingDirectory,
        verificationInstruction,
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      work.handle.agent.followup(createUserMessage({
        content: [{
          type: 'text',
          text: [
            'DSH_WORK_VERIFICATION_RETRY_V1',
            `自动验收未通过：${reason}`,
            '请在同一工作 Session 内立即纠正一次：使用现有工作工具完成缺失操作，并只在真实成功后报告。',
            '生成成果必须保存到共享工作目录；要求打开时必须打开本次已验证成果；要求联网调研时必须实际调用联网搜索。',
          ].join('\n'),
        }],
        source: { kind: 'plugin', plugin: 'dsh-work-orchestrator', form: 'instructions' },
      }))
      await work.handle.agent.whenIdle()
      reply = assistantText(work.handle.agent.session.events, firstSeq)
      if (reply === '') throw new Error('Worker DSH Session returned no public text after verification retry')
      evidence = verifyWorkExecution(
        work.handle.agent.session.events,
        firstSeq,
        this.config.codex.workingDirectory,
        verificationInstruction,
      )
    }
    return evidence.artifactPaths.length === 0
      ? reply
      : `${reply}\n已验证成果路径：${evidence.artifactPaths.join('；')}`
  }

  private getCodexClient(): CodexWorkerClient {
    if (this.codexClient !== undefined) return this.codexClient
    mkdirSync(this.config.codex.workingDirectory, { recursive: true })
    this.codexClient = new CodexAppServerClient({
      executable: this.config.codex.executable,
      cwd: this.config.codex.workingDirectory,
      ...(this.config.codex.model === undefined ? {} : { model: this.config.codex.model }),
      ...(this.config.codex.reasoningEffort === undefined ? {} : { reasoningEffort: this.config.codex.reasoningEffort }),
    })
    return this.codexClient
  }

  private async setWorkStatus(work: ActiveWorkSession, status: string): Promise<void> {
    work.status = status
    const route = work.codexThreadId === undefined ? 'Work' : 'Work → Codex'
    this.ctx.sessionTitle.rename(work.handle.agent.session, `[${route} · ${status}] ${work.title}`)
    await this.ctx.sessions.flush(work.handle.agent.session)
  }

  private async reportToCompanion(
    turn: CompletedCompanionTurn,
    work: LinkedWorkReference | undefined,
    workerText: string,
    kind: WorkNotification['kind'],
  ): Promise<void> {
    const helper = delegateName(turn)
    const title = work?.title ?? 'NPC 帮办'
    const text = compactWorkNotification(title, workerText, kind, helper)
    await turn.notify?.({
      workSessionId: work?.sessionId ?? '',
      title,
      text,
      kind,
      source: turn.source,
      executor: work?.executor ?? 'dsh',
      status: work?.status ?? (kind === 'error' ? '失败' : kind === 'status' ? '状态' : '等待反馈'),
      ...(work?.codexThreadId === undefined ? {} : { codexThreadId: work.codexThreadId }),
    })
  }

  async flush(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks])
  }

  async close(): Promise<void> {
    this.closing = true
    await this.flush()
    await Promise.allSettled([...this.active.values()].map(work => work.handle.dispose()))
    await this.codexClient?.close()
    this.active.clear()
  }
}
