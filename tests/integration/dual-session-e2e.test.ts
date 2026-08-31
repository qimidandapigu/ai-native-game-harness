import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { MockGameAdapter } from '@ai-native-game-harness/mock-game/adapter'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkOrchestratorService, type WorkNotification } from '../../plugins/dsh-work-orchestrator/src/index.js'
import { GameAgentSession } from '../../plugins/xiaotangyuan-game/src/runtime/agent/game-agent-session.js'

function assistantEvent(seq: number, text: string) {
  return {
    seq,
    time: Date.now(),
    type: 'assistant/message',
    data: { turn: seq, step: 0, message: { content: [{ type: 'text', text }] } },
  }
}

function workHandle(
  id: string,
  onPrompt: (prompt: string) => string | {
    text: string
    tools: Array<{ name: string; arguments: Record<string, unknown> }>
  },
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
      const response = onPrompt(prompt)
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
              content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'ok' }] }],
            },
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

async function drainDeferredWork(work: WorkOrchestratorService): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
  await work.flush()
}

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Mock Game dual Session E2E', () => {
  it('answers first, reuses one Work Session, applies feedback, and produces the final HTML', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agh-dual-session-'))
    temporaryDirectories.push(directory)
    const workspace = join(directory, 'workspace')
    mkdirSync(workspace, { recursive: true })
    const artifact = join(workspace, 'ai-changes-games.html')
    const notifications: WorkNotification[] = []
    const workPrompts: string[] = []
    const companionReplies: string[] = []
    const permissionSets: Array<{ sessionId: string; preset: string }> = []
    let createCalls = 0
    let artifactOpened = false

    const ctx = new Context()
    const releaseLlm = ctx.provide('llm', {
      stream: async function* () {
        yield {
          type: 'text-delta',
          index: 0,
          text: '{"kind":"start","title":"AI 如何改变游戏","instruction":"先整理汇报思路，不生成文件"}',
        }
      },
    } as never)
    const releaseAgents = ctx.provide('agents', {
      get: () => undefined,
      create: async (options: { sessionId: string }) => {
        createCalls += 1
        return workHandle(options.sessionId, prompt => {
          workPrompts.push(prompt)
          if (prompt.includes('真实进度')) {
            return 'Worker DSH Session 当前已完成三段式汇报思路，尚未生成最终 HTML。'
          }
          if (prompt.includes('第二部分不对')) return '已经把第二部分换成三个真实案例。'
          if (prompt.includes('生成这个 HTML 文件并打开')) {
            writeFileSync(artifact, [
              '<!doctype html>',
              '<html lang="zh-CN"><head><meta charset="utf-8"><title>AI 如何改变游戏</title></head>',
              '<body><h1>AI 如何改变游戏</h1><p>从内容生产、智能角色到玩家共创。</p></body></html>',
            ].join(''), 'utf8')
            artifactOpened = true
            return {
              text: `网页已经生成并打开：${artifact}`,
              tools: [
                { name: 'write', arguments: { file_path: artifact, content: '<!doctype html>' } },
                { name: 'pwsh', arguments: { command: `Start-Process -LiteralPath '${artifact}'` } },
              ],
            }
          }
          return '建议按内容生产、智能角色、玩家共创三部分组织汇报。'
        })
      },
    } as never)
    const releaseSessions = ctx.provide('sessions', { flush: async () => undefined } as never)
    const releasePermissions = ctx.provide('permissionPresets', {
      set: (session: { id: string }, preset: string) => permissionSets.push({ sessionId: session.id, preset }),
    } as never)
    const releaseTitles = ctx.provide('sessionTitle', { rename: () => undefined } as never)

    const work = new WorkOrchestratorService(ctx, {
      enabled: true,
      selection: { provider: 'mock', model: 'mock-worker', reasoningEffort: 'off' as never },
      directory,
      legacyDirectories: [],
      codex: { executable: 'codex', workingDirectory: workspace },
    })
    let scheduledTurns = 0
    const scheduleTurn = work.scheduleTurn.bind(work)
    work.scheduleTurn = turn => {
      scheduledTurns += 1
      scheduleTurn(turn)
    }
    const adapter = new MockGameAdapter()
    const hello = await adapter.hello()
    const observation = await adapter.observe()
    const companion = new GameAgentSession(
      ctx,
      { ...hello, saveId: observation.saveId },
      {} as never,
      undefined,
      undefined,
      work,
      undefined,
      'mock-game/demo-save',
      false,
      undefined,
      update => { notifications.push(update) },
    )

    const ask = async (text: string) => {
      const started = performance.now()
      const result = await companion.ask({
        text,
        context: { saveId: observation.saveId, observation: observation.state },
      }, 'voice')
      companionReplies.push(result.reply)
      expect(performance.now() - started).toBeLessThan(250)
      return result
    }

    try {
      const first = await ask('明天要汇报，帮我准备 AI 改变游戏的 HTML，先给思路，不要生成文件。')
      expect(first.reply).toBe('好的，我收到啦，先让我看看。')
      expect(createCalls).toBe(0)
      await drainDeferredWork(work)
      expect(scheduledTurns).toBe(1)
      expect(createCalls).toBe(1)
      const workSessionId = notifications.at(-1)?.workSessionId
      expect(workSessionId).toMatch(/^dsh-work-/)
      expect(workSessionId).not.toBe(first.sessionId)
      expect(artifactOpened).toBe(false)

      expect((await ask('这个 HTML 做到哪了？')).reply).toBe('好的，我帮你看看进度。')
      await drainDeferredWork(work)
      expect(createCalls).toBe(1)
      expect(notifications.at(-1)?.workSessionId).toBe(workSessionId)
      expect(notifications.at(-1)?.text).toContain('另一位 NPC')
      expect(notifications.at(-1)?.text).toContain('尚未生成最终 HTML')

      await ask('请修改刚才的 HTML 思路，第二部分不对，换成真实案例。')
      await drainDeferredWork(work)
      expect(createCalls).toBe(1)
      expect(notifications.at(-1)?.workSessionId).toBe(workSessionId)

      await ask('思路对了，请生成这个 HTML 文件并打开。')
      await drainDeferredWork(work)
      expect(createCalls).toBe(1)
      expect(notifications.at(-1)?.workSessionId).toBe(workSessionId)
      expect(artifactOpened).toBe(true)
      expect(readFileSync(artifact, 'utf8')).toContain('<h1>AI 如何改变游戏</h1>')
      expect(workPrompts.findIndex(prompt => prompt.includes('DSH_WORK_VERIFICATION_RETRY_V1'))).toBe(-1)
      expect(workPrompts).toHaveLength(4)
      expect(permissionSets).toEqual([{ sessionId: workSessionId, preset: 'danger-full-access' }])

      const playerFacing = [...companionReplies, ...notifications.map(item => item.text)].join('\n')
      expect(playerFacing).not.toMatch(/\b(?:DSH|Worker|Codex)\b|工作会话|后台线程|分类器/i)
    } finally {
      await companion.dispose()
      await work.close()
      await releaseTitles()
      await releasePermissions()
      await releaseSessions()
      await releaseAgents()
      await releaseLlm()
    }
  })
})
