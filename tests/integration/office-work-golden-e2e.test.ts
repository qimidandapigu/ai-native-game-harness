import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  compactWorkNotification,
  verifyWorkExecution,
} from '../../plugins/dsh-work-orchestrator/src/index.js'

interface ToolCall {
  name: string
  arguments: Record<string, unknown>
}

function completedEvents(calls: ToolCall[]): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = []
  for (const [index, call] of calls.entries()) {
    const callId = `golden-${index}`
    events.push({
      seq: events.length,
      time: Date.now(),
      type: 'tool/call',
      data: { turn: 1, step: index, callId, name: call.name, arguments: JSON.stringify(call.arguments) },
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

describe('office Work golden acceptance', () => {
  it('accepts only real, non-empty artifacts of the requested type and exact opened target', () => {
    const root = mkdtempSync(join(tmpdir(), 'office-golden-'))
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const cases = [
      {
        name: '联网 HTML 汇报',
        instruction: '联网查最新资料，生成 HTML 汇报并打开',
        path: join(workspace, 'ai-games.html'),
        bytes: Buffer.from('<!doctype html><html><h1>AI 改变游戏</h1></html>'),
        producer: (path: string): ToolCall[] => [
          { name: 'web_search', arguments: { search_query: 'AI 对游戏行业的影响' } },
          { name: 'write', arguments: { file_path: path, content: '<!doctype html>' } },
        ],
      },
      {
        name: 'Markdown 文档',
        instruction: '生成 Markdown 文档并打开',
        path: join(workspace, 'brief.md'),
        bytes: Buffer.from('# 汇报提纲\n\n内容'),
        producer: (path: string): ToolCall[] => [
          { name: 'write', arguments: { file_path: path, content: '# 汇报提纲' } },
        ],
      },
      {
        name: 'PPT 成果',
        instruction: '生成 PPT 并打开',
        path: join(workspace, 'briefing.pptx'),
        bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]),
        producer: (path: string): ToolCall[] => [{
          name: 'pwsh',
          arguments: { command: `[IO.File]::WriteAllBytes('${path}', [byte[]](80,75,3,4))` },
        }],
      },
      {
        name: 'Excel 成果',
        instruction: '生成 Excel 表格并打开',
        path: join(workspace, 'metrics.xlsx'),
        bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]),
        producer: (path: string): ToolCall[] => [{
          name: 'pwsh',
          arguments: { command: `[IO.File]::WriteAllBytes('${path}', [byte[]](80,75,3,4))` },
        }],
      },
    ]
    try {
      for (const golden of cases) {
        writeFileSync(golden.path, golden.bytes)
        const calls = [
          ...golden.producer(golden.path),
          { name: 'pwsh', arguments: { command: `Start-Process -LiteralPath '${golden.path}'` } },
        ]
        const evidence = verifyWorkExecution(completedEvents(calls) as never, 0, workspace, golden.instruction)
        expect(evidence.artifactPaths, golden.name).toEqual([golden.path])
        expect(evidence.opened, golden.name).toBe(true)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the in-game completion update short and hides implementation terms', () => {
    const text = compactWorkNotification(
      'AI 游戏行业汇报',
      'DSH Worker Session 已经生成完整 HTML、PPT 和表格，以下是全部内容。第二句。第三句。',
      'update',
      '另一位 NPC',
    )
    expect(text.length).toBeLessThanOrEqual(60)
    expect(text).not.toMatch(/DSH|Worker|Session|后台线程|分类器/i)
    expect(text).toContain('有新进展')
  })
})
