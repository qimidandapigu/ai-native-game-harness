import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { MultimodalRouter } from '../src/runtime/multimodal/multimodal-router.js'

describe('multimodal game input degradation', () => {
  it('continues text-only when the native game-window capture service is unavailable', async () => {
    const selection = { provider: 'test-provider', model: 'vision-model' }
    const ctx = {
      agentDefaultModel: { currentSelection: () => selection },
      llm: {
        resolveModelInfo: vi.fn(async () => ({ inputModalities: ['text', 'image'] })),
        listProviders: vi.fn(() => []),
      },
      attachments: { saveImage: vi.fn() },
      logger: { warn: vi.fn() },
    } as unknown as Context
    const media = {
      captureProcessWindow: vi.fn(async () => {
        throw new Error('Media Host 尚未启动')
      }),
    }
    const router = new MultimodalRouter(
      ctx,
      { enabled: true, maxWidth: 1_280 },
      media as never,
    )

    const input = await router.prepareProcess(42, new AbortController().signal)

    expect(input.selection).toEqual(selection)
    expect(input.image).toBeUndefined()
    expect(ctx.attachments.saveImage).not.toHaveBeenCalled()
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      'xiaotangyuan-game: 游戏窗口截图不可用，继续使用结构化状态和文字输入',
    )
  })
})
