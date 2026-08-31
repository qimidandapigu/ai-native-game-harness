import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { describe, expect, it } from 'vitest'
import {
  compactWorkNotification,
  assertRequiredWorkTools,
  WorkOrchestratorService,
  linkedWorkIntentShortcut,
  obviousExternalWorkRequest,
  parseWorkIntent,
  postTurnWorkIntentShortcut,
  requestsImmediateExecution,
  requiresArtifactOpen,
  requiresArtifactWrite,
  requiresWebResearch,
  requestsCodex,
  resolveConfig,
  verifyWorkExecution,
  type WorkNotification,
  type CodexWorkerClient,
} from '../src/index.js'

function assistantEvent(seq: number, text: string) {
  return {
    seq,
    time: Date.now(),
    type: 'assistant/message',
    data: { turn: seq, step: 0, message: { content: [{ type: 'text', text }] } },
  }
}

interface FakeToolCall {
  name: string
  arguments: Record<string, unknown>
  isError?: boolean
}

function successfulToolEvents(tools: FakeToolCall[]): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = []
  for (const [index, tool] of tools.entries()) {
    const callId = `evidence-${index}`
    events.push({
      seq: events.length,
      time: Date.now(),
      type: 'tool/call',
      data: { turn: 1, step: index, callId, name: tool.name, arguments: JSON.stringify(tool.arguments) },
    })
    events.push({
      seq: events.length,
      time: Date.now(),
      type: 'tool/result',
      data: {
        turn: 1,
        step: index,
        message: {
          content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'ok' }], isError: false }],
        },
      },
    })
  }
  return events
}

function fakeHandle(
  id: string,
  reply: (prompt: string) => string | { text: string; tools: FakeToolCall[] },
): AgentHandle {
  const events: Array<Record<string, unknown>> = []
  const session = {
    id,
    get seq() { return events.length },
    events,
    append(type: string, data: unknown) {
      const event = { seq: events.length, time: Date.now(), type, data }
      events.push(event)
      return event
    },
  }
  const agent = {
    id,
    status: 'idle',
    options: {},
    inbox: {},
    ctx: {},
    session,
    followup(message: { content: Array<{ type: string; text?: string }> }) {
      const prompt = message.content.map(block => block.text ?? '').join('')
      const response = reply(prompt)
      if (typeof response !== 'string') {
        for (const [index, tool] of response.tools.entries()) {
          const callId = `call-${events.length}-${index}`
          session.append('tool/call', {
            turn: events.length,
            step: index,
            callId,
            name: tool.name,
            arguments: JSON.stringify(tool.arguments),
          })
          session.append('tool/result', {
            turn: events.length,
            step: index,
            message: {
              content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'ok' }], isError: tool.isError }],
            },
            ...(tool.isError === true ? { error: { name: 'FakeError', code: 'FAKE_ERROR' } } : {}),
          })
        }
      }
      events.push(assistantEvent(events.length, typeof response === 'string' ? response : response.text))
    },
    whenIdle: async () => undefined,
    cancel: () => undefined,
    send: () => undefined,
    steer: () => undefined,
    inject: () => undefined,
    runMaintenance: async <T>(task: (signal: AbortSignal) => Promise<T>) => await task(new AbortController().signal),
  }
  return { agent, dispose: async () => undefined } as unknown as AgentHandle
}

function createContext(
  modelReplies: string[],
  agents: Record<string, unknown>,
): { ctx: Context; permissionSets: Array<{ sessionId: string; preset: string }>; release: () => Promise<void> } {
  const ctx = new Context()
  const permissionSets: Array<{ sessionId: string; preset: string }> = []
  const releaseLlm = ctx.provide('llm', {
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: modelReplies.shift() ?? '{"kind":"none"}' }
    },
  } as never)
  const releaseAgents = ctx.provide('agents', agents as never)
  const releaseSessions = ctx.provide('sessions', { flush: async () => undefined } as never)
  const releasePermissionPresets = ctx.provide('permissionPresets', {
    set: (session: { id: string }, preset: string) => { permissionSets.push({ sessionId: session.id, preset }) },
  } as never)
  const releaseSessionTitle = ctx.provide('sessionTitle', { rename: () => undefined } as never)
  return {
    ctx,
    permissionSets,
    release: async () => {
      await releaseSessionTitle()
      await releasePermissionPresets()
      await releaseSessions()
      await releaseAgents()
      await releaseLlm()
    },
  }
}

function config(directory: string) {
  return {
    enabled: true,
    selection: { provider: 'zai', model: 'glm-5.2', reasoningEffort: 'off' as never },
    directory,
    legacyDirectories: [],
    codex: { executable: 'codex', workingDirectory: join(directory, 'workspace') },
  }
}

describe('DSH Work Orchestrator', () => {
  it('validates independent plugin configuration and parses bounded intents', () => {
    expect(resolveConfig({ provider: 'zai', model: 'glm-5.2' }).selection).toMatchObject({ provider: 'zai', model: 'glm-5.2' })
    expect(resolveConfig({ executor: 'codex-app-server' } as never)).not.toHaveProperty('executor')
    expect(() => resolveConfig({ provider: 'zai' })).toThrow('provider and model')
    expect(parseWorkIntent('{"kind":"start","title":"汇报","instruction":"生成一个 HTML"}')).toEqual({
      kind: 'start', title: '汇报', instruction: '生成一个 HTML',
    })
    expect(parseWorkIntent('not json')).toEqual({ kind: 'none' })
    expect(requestsCodex('帮我优化这个 HTML')).toBe(false)
    expect(requestsCodex('让 Codex 帮我优化这个 HTML')).toBe(true)
    expect(requestsCodex('交给codex做')).toBe(true)
    expect(linkedWorkIntentShortcut('HTML 做得怎么样了？', true)).toEqual({
      kind: 'inspect', instruction: 'HTML 做得怎么样了？',
    })
    expect(linkedWorkIntentShortcut('第四页不对，请修改一下', true)).toBeUndefined()
    expect(linkedWorkIntentShortcut('HTML 做得怎么样了？', false)).toBeUndefined()
    expect(obviousExternalWorkRequest('我想我明天要汇报，帮我写个 AI 改变游戏的网页。')).toBe(true)
    expect(obviousExternalWorkRequest('帮我创建一个 HTML 页面并打开')).toBe(true)
    expect(obviousExternalWorkRequest('帮我砍一下这棵树')).toBe(false)
    expect(postTurnWorkIntentShortcut('我想我明天要汇报，帮我写个 AI 改变游戏的网页。', true)).toEqual({
      kind: 'start',
      title: 'AI 改变游戏的网页',
      instruction: '我想我明天要汇报，帮我写个 AI 改变游戏的网页。',
    })
    expect(postTurnWorkIntentShortcut('帮我打开吧', true)).toEqual({ kind: 'continue', instruction: '帮我打开吧' })
    expect(postTurnWorkIntentShortcut('做吧', true)).toEqual({ kind: 'continue', instruction: '做吧' })
    expect(requestsImmediateExecution('帮我做一个网站并打开')).toBe(true)
    expect(requestsImmediateExecution('先给我讲讲网站思路，不要执行')).toBe(false)
    expect(requiresArtifactWrite('帮我做一个网站并打开')).toBe(true)
    expect(requiresArtifactOpen('帮我做一个网站并打开')).toBe(true)
    expect(requiresArtifactWrite('先讲讲网站思路')).toBe(false)
    expect(requiresArtifactWrite('请修改刚才的 HTML 思路，第二部分换成真实案例')).toBe(false)
    expect(requiresArtifactWrite('先给思路，不要生成 HTML 文件')).toBe(false)
    expect(requiresArtifactOpen('生成 HTML，但是先不要打开')).toBe(false)
    expect(requiresWebResearch('联网查资料，做成报告')).toBe(true)
    expect(requiresWebResearch('不要联网，只整理这份文档')).toBe(false)
    expect(() => assertRequiredWorkTools(['read', 'write', 'edit', 'glob', 'grep', 'pwsh'])).not.toThrow()
    expect(() => assertRequiredWorkTools(['game_story_advance'])).toThrow('missing read, write, edit, glob, grep, pwsh')
    expect(compactWorkNotification('AI 游戏行业汇报', '这是很长的完整方案。第二段。第三段。', 'update')).toBe(
      '“AI 游戏行业汇报”有新进展啦。要听我简单说说，还是打开工作页面看完整内容？',
    )
    expect(compactWorkNotification('行业汇报', '目前已完成**三段式汇报思路**，尚未生成最终 HTML。第三句不应出现。', 'status')).toBe(
      '目前已完成三段式汇报思路，尚未生成最终 HTML。第三句不应出现。',
    )
  })

  it('verifies real office artifacts, exact open targets, and requested research', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-office-evidence-'))
    const workspace = join(directory, 'workspace')
    mkdirSync(workspace)
    const html = join(workspace, 'research.html')
    const unrelated = join(workspace, 'unrelated.html')
    const pptx = join(workspace, 'briefing.pptx')
    writeFileSync(html, '<!doctype html><html><h1>AI 游戏行业</h1></html>')
    writeFileSync(unrelated, '<!doctype html><html><h1>other</h1></html>')
    writeFileSync(pptx, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))
    try {
      const webHtml = successfulToolEvents([
        { name: 'web_search', arguments: { search_query: 'AI 游戏行业最新资料' } },
        { name: 'write', arguments: { file_path: html, content: '<!doctype html>' } },
        { name: 'pwsh', arguments: { command: `Start-Process -LiteralPath '${html}'` } },
      ])
      expect(verifyWorkExecution(webHtml as never, 0, workspace, '联网查资料，生成 HTML 并打开')).toEqual({
        artifactPaths: [html],
        opened: true,
        researched: true,
      })

      const powershellWebHtml = successfulToolEvents([
        {
          name: 'pwsh',
          arguments: { command: "Invoke-WebRequest -Uri 'https://example.com' | Select-Object -ExpandProperty Content" },
        },
        { name: 'write', arguments: { file_path: html, content: '<!doctype html>' } },
        { name: 'pwsh', arguments: { command: `Start-Process -LiteralPath '${html}'` } },
      ])
      expect(verifyWorkExecution(powershellWebHtml as never, 0, workspace, '联网查资料，生成 HTML 并打开')).toEqual({
        artifactPaths: [html],
        opened: true,
        researched: true,
      })

      const webClientHtml = successfulToolEvents([
        {
          name: 'pwsh',
          arguments: {
            command: "$client = New-Object System.Net.WebClient; $result = $client.DownloadString('https://example.com')",
          },
        },
        { name: 'write', arguments: { file_path: html, content: '<!doctype html>' } },
        { name: 'pwsh', arguments: { command: `Start-Process -LiteralPath '${html}'` } },
      ])
      expect(verifyWorkExecution(webClientHtml as never, 0, workspace, '联网查资料，生成 HTML 并打开')).toMatchObject({
        artifactPaths: [html],
        opened: true,
        researched: true,
      })

      const binary = successfulToolEvents([
        {
          name: 'pwsh',
          arguments: { command: `[IO.File]::WriteAllBytes('${pptx}', [byte[]](80,75,3,4))` },
        },
        { name: 'pwsh', arguments: { command: `Start-Process -LiteralPath '${pptx}'` } },
      ])
      expect(verifyWorkExecution(binary as never, 0, workspace, '生成 PPT 并打开')).toMatchObject({
        artifactPaths: [pptx],
        opened: true,
      })

      const wrongOpen = successfulToolEvents([
        { name: 'write', arguments: { file_path: html, content: '<!doctype html>' } },
        { name: 'pwsh', arguments: { command: `Start-Process -LiteralPath '${unrelated}'` } },
      ])
      expect(() => verifyWorkExecution(wrongOpen as never, 0, workspace, '生成 HTML 并打开'))
        .toThrow('did not successfully open the verified artifact')

      const noResearch = successfulToolEvents([
        { name: 'pwsh', arguments: { command: "Get-Content -LiteralPath 'notes.txt'" } },
        { name: 'write', arguments: { file_path: html, content: '<!doctype html>' } },
      ])
      expect(() => verifyWorkExecution(noResearch as never, 0, workspace, '联网查资料并生成 HTML'))
        .toThrow('did not perform the requested web research')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('repairs one failed artifact verification inside the same Work Session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-work-repair-'))
    const artifact = join(directory, 'workspace', 'repaired.html')
    const notifications: WorkNotification[] = []
    let createCalls = 0
    let workerCalls = 0
    const runtime = createContext([], {
      get: () => undefined,
      create: async (options: { sessionId: string }) => {
        createCalls += 1
        return fakeHandle(options.sessionId, prompt => {
          workerCalls += 1
          if (!prompt.includes('DSH_WORK_VERIFICATION_RETRY_V1')) return '网页已经完成并打开。'
          writeFileSync(artifact, '<!doctype html><html><h1>修复成功</h1></html>')
          return {
            text: '已纠正并完成真实操作。',
            tools: [
              { name: 'write', arguments: { file_path: artifact, content: '<!doctype html>' } },
              { name: 'pwsh', arguments: { command: `Start-Process -LiteralPath '${artifact}'` } },
            ],
          }
        })
      },
    })
    const service = new WorkOrchestratorService(runtime.ctx, config(directory))
    try {
      service.scheduleTurn({
        companionSessionId: 'companion-repair',
        playerText: '帮我创建一个 HTML 页面并打开',
        companionReply: '好的，我先看看。',
        selection: { provider: 'zai', model: 'glm-5.2' },
        source: 'voice',
        notify: notification => { notifications.push(notification) },
      })
      await service.flush()
      expect(createCalls).toBe(1)
      expect(workerCalls).toBe(2)
      expect(readFileSync(artifact, 'utf8')).toContain('修复成功')
      expect(notifications).toHaveLength(1)
      expect(notifications[0]?.kind).toBe('update')
    } finally {
      await service.close()
      await runtime.release()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('answers first, then creates and reuses one native Worker DSH Session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-work-'))
    const modelReplies = [
      '{"kind":"start","title":"AI 游戏行业汇报","instruction":"生成明天汇报用的 HTML"}',
      '{"kind":"continue","instruction":"第二部分思路不对，重新整理"}',
      '{"kind":"start","title":"新产品介绍","instruction":"另外做一份产品介绍网页"}',
    ]
    let createCalls = 0
    const notifications: WorkNotification[] = []
    const source = fakeHandle('companion-session', () => { throw new Error('工作更新不应再次调用陪伴模型') })
    const workers: AgentHandle[] = []
    const runtime = createContext(modelReplies, {
      get: (id: string) => id === 'companion-session' ? source.agent : undefined,
      create: async (options: { sessionId: string }) => {
        createCalls += 1
        const worker = fakeHandle(options.sessionId, prompt => {
          expect(prompt).toContain('DSH_WORKER_SESSION_V1')
          if (prompt.includes('真实进度')) return '目前已完成**三段式汇报思路**，尚未生成最终 HTML。'
          if (prompt.includes('这是明确的执行请求')) {
            const artifact = join(directory, 'workspace', prompt.includes('产品介绍') ? 'product.html' : 'report.html')
            writeFileSync(artifact, '<!doctype html><title>report</title>')
            return {
              text: 'HTML 已生成。',
              tools: [{ name: 'write', arguments: { file_path: artifact, content: '<!doctype html>' } }],
            }
          }
          return prompt.includes('继续处理') ? '已按反馈重排第二部分。' : '建议先确认三段式汇报思路。'
        })
        workers.push(worker)
        return worker
      },
    })
    const service = new WorkOrchestratorService(runtime.ctx, config(directory))
    const base = {
      companionSessionId: 'companion-session',
      companionReply: '好，我先接下来。',
      selection: { provider: 'test', model: 'test-model' },
      source: 'voice',
      companion: { id: 'xiaotangyuan', name: '小汤圆', delegateName: '另一位 NPC' },
      notify: (notification: WorkNotification) => { notifications.push(notification) },
    }
    try {
      service.scheduleTurn({ ...base, playerText: '帮我生成明天汇报用的 HTML' })
      expect(createCalls).toBe(0)
      await service.flush()
      expect(createCalls).toBe(1)
      expect(workers[0]?.agent.id).toMatch(/^dsh-work-/)
      expect(workers[0]?.agent.id).not.toBe(source.agent.id)
      expect(service.contextForCompanion('companion-session')).toEqual({
        title: 'AI 游戏行业汇报',
        status: '等待反馈',
      })

      service.scheduleTurn({ ...base, playerText: '第二部分思路不对，请重新整理' })
      await service.flush()
      expect(createCalls).toBe(1)
      service.scheduleTurn({ ...base, playerText: 'HTML 做得怎么样了？' })
      await service.flush()
      expect(createCalls).toBe(1)
      expect(notifications).toHaveLength(3)
      expect(notifications.at(-1)?.text).toBe('目前已完成三段式汇报思路，尚未生成最终 HTML。')
      expect(notifications[0]?.text).toBe('“AI 游戏行业汇报”有新进展啦。要听我简单说说，还是打开工作页面看完整内容？')
      expect(notifications[1]?.text).toBe('“AI 游戏行业汇报”有新进展啦。要听我简单说说，还是打开工作页面看完整内容？')
      expect(notifications.every(item => !/工作会话|Worker|后台工作|Codex|DSH/.test(item.text))).toBe(true)

      service.scheduleTurn({ ...base, playerText: '另外做一份产品介绍网页' })
      await service.flush()
      expect(createCalls).toBe(1)
      expect(workers).toHaveLength(1)
      expect(service.contextForCompanion('companion-session')?.status).toBe('等待反馈')
      expect(runtime.permissionSets).toEqual([{
        sessionId: workers[0]?.agent.id,
        preset: 'danger-full-access',
      }])
    } finally {
      await service.close()
      await runtime.release()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('resumes the same Worker after restart without persisting task content', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-work-links-'))
    let workerSessionId = ''
    const source = fakeHandle('companion-session', () => '后台更新已经收到。')
    const firstRuntime = createContext(
      ['{"kind":"start","title":"行业汇报","instruction":"先给出汇报思路"}'],
      {
        get: () => source.agent,
        create: async (options: { sessionId: string }) => {
          workerSessionId = options.sessionId
          return fakeHandle(options.sessionId, () => '建议使用三段式汇报。')
        },
      },
    )
    const base = {
      companionSessionId: 'companion-session',
      companionReply: '好。',
      selection: { provider: 'game', model: 'vision' },
      source: 'voice',
    }
    try {
      const first = new WorkOrchestratorService(firstRuntime.ctx, config(directory))
      first.scheduleTurn({ ...base, playerText: '帮我准备一份行业汇报' })
      await first.flush()
      await first.close()
      await firstRuntime.release()

      expect(workerSessionId).toMatch(/^dsh-work-/)
      const stored = readFileSync(join(directory, 'work-session-links-v1.json'), 'utf8')
      expect(stored).toContain(workerSessionId)
      expect(stored).not.toContain('先给出汇报思路')

      let resumeCalls = 0
      let createCalls = 0
      const secondRuntime = createContext(
        ['{"kind":"continue","instruction":"把第二部分改短一点"}'],
        {
          get: () => source.agent,
          create: async () => { createCalls += 1; throw new Error('must resume') },
          resume: async (options: { resumeSessionId: string }) => {
            resumeCalls += 1
            expect(options.resumeSessionId).toBe(workerSessionId)
            return fakeHandle(options.resumeSessionId, prompt => {
              expect(prompt).toContain('把第二部分改短一点')
              return '第二部分已经缩短。'
            })
          },
        },
      )
      const second = new WorkOrchestratorService(secondRuntime.ctx, config(directory))
      second.scheduleTurn({ ...base, playerText: '刚才那个第二部分改短一点' })
      await second.flush()
      expect(resumeCalls).toBe(1)
      expect(createCalls).toBe(0)
      await second.close()
      await secondRuntime.release()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('delegates to one resumable Codex thread only after an explicit request and reports through the real Worker', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-work-codex-'))
    const calls: string[] = []
    const codex: CodexWorkerClient = {
      startThread: async title => { calls.push(`start:${title}`); return 'codex-thread-1' },
      resumeThread: async threadId => { calls.push(`resume:${threadId}`) },
      runTurn: async (threadId, prompt) => {
        calls.push(`turn:${threadId}:${prompt.includes('继续优化交互') ? 'continue' : 'start'}`)
        return prompt.includes('继续优化交互') ? 'Codex 已按反馈调整。' : 'Codex 已给出第一版思路。'
      },
      close: async () => { calls.push('close') },
    }
    let createCalls = 0
    let worker: AgentHandle | undefined
    const workerPrompts: string[] = []
    const runtime = createContext([
      '{"kind":"start","title":"优化网页","instruction":"优化这个 HTML"}',
      '{"kind":"continue","instruction":"继续优化交互"}',
    ], {
      get: () => undefined,
      create: async (options: { sessionId: string }) => {
        createCalls += 1
        worker = fakeHandle(options.sessionId, prompt => {
          workerPrompts.push(prompt)
          expect(prompt).toContain('WORK_DELEGATION_RESULT_V1')
          expect(prompt).toContain('Codex 公开结果')
          return prompt.includes('继续处理') ? 'Work Session 已检查并接受本轮调整。' : 'Work Session 已检查 Codex 第一版思路。'
        })
        return worker
      },
    })
    const service = new WorkOrchestratorService(runtime.ctx, config(directory), { codexClient: codex })
    const turn = {
      companionSessionId: 'companion-codex',
      companionReply: '我来安排。',
      selection: { provider: 'zai', model: 'glm-5.2' },
      source: 'voice',
    }
    try {
      service.scheduleTurn({ ...turn, playerText: '让 Codex 帮我优化这个 HTML' })
      await service.flush()
      service.scheduleTurn({ ...turn, playerText: '继续优化交互' })
      await service.flush()
      expect(createCalls).toBe(1)
      expect(calls).toEqual([
        'start:优化网页',
        'turn:codex-thread-1:start',
        'turn:codex-thread-1:continue',
      ])
      const stored = readFileSync(join(directory, 'work-session-links-v1.json'), 'utf8')
      expect(stored).toContain('"executor": "codex-app-server"')
      expect(stored).toContain('"codexThreadId": "codex-thread-1"')
      expect(workerPrompts).toHaveLength(2)
      expect(worker?.agent.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(2)
    } finally {
      await service.close()
      await runtime.release()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('migrates an existing XiaoTangYuan link index and accepts its Worker prefix', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-work-new-'))
    const legacy = mkdtempSync(join(tmpdir(), 'dsh-work-legacy-'))
    const selection = { provider: 'zai', model: 'glm-5.2' }
    writeFileSync(join(legacy, 'work-session-links-v1.json'), JSON.stringify({
      schemaVersion: 1,
      links: {
        companion: {
          companionSessionId: 'companion',
          workerSessionId: 'xiaotangyuan-work-existing',
          title: '旧任务',
          selection,
          status: 'waiting',
          executor: 'codex-app-server',
          codexThreadId: 'legacy-auto-codex-thread',
          updatedAt: Date.now(),
        },
      },
    }))
    const runtime = createContext([], {})
    try {
      const service = new WorkOrchestratorService(runtime.ctx, {
        enabled: false,
        directory,
        legacyDirectories: [legacy],
        selection,
        executor: 'dsh',
        codex: { executable: 'codex', workingDirectory: join(directory, 'workspace') },
      })
      const migrated = readFileSync(join(directory, 'work-session-links-v1.json'), 'utf8')
      expect(migrated).toContain('xiaotangyuan-work-existing')
      expect(migrated).toContain('"executor": "dsh"')
      expect(migrated).not.toContain('legacy-auto-codex-thread')
      await service.close()
    } finally {
      await runtime.release()
      rmSync(directory, { recursive: true, force: true })
      rmSync(legacy, { recursive: true, force: true })
    }
  })
})
